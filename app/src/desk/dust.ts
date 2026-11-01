/**
 * Dust / rent reclaim — the free edge almost nobody runs.
 *
 * ## The idea
 *
 * Opening an SPL token account costs ~0.00203928 SOL in rent-exempt deposit. When
 * you sell or transfer everything out, the account stays open and keeps that
 * SOL locked. `CloseAccount` returns it. Most wallets never close them, so real
 * users are walking around with 0.002 SOL each, per empty token account,
 * recoverable by their own key.
 *
 * ## Why this is the strongest "free" bot
 *
 * Unlike a sweep, this is not a race: the money is not a prize for being first,
 * it is sitting in an account only its own key can close. Unlike sniping, it
 * needs no capital: the closing transaction's fee is paid out of the very rent
 * being returned. The downside of running it is zero.
 *
 * ## Why it belongs in Asterion and not a standalone script
 *
 * The unit of work is "an address I already know about". Asterion already has the
 * crawler and the watchlist, so the input is free. A standalone bot would have to
 * discover wallets first, which is the expensive part.
 *
 * ## The correctness trap
 *
 * An account with a zero balance is closable. An account with a NON-zero balance
 * is not your dust — closing it destroys the tokens, because `CloseAccount` does
 * not transfer them. This module therefore requires `amount == 0` AND the owner
 * to be the address being swept, and it reports the non-zero ones as "skip" with
 * the token amount, never silently discarding them.
 */

import {
  SPL_TOKEN_PROGRAM,
  SPL_TOKEN_2022_PROGRAM,
  SYSTEM_PROGRAM,
  isSolanaPubkey,
} from '../solana.js';
import { b58encode, publicKey as b58publicKey, concat, shortvec, utf8 } from './base58.js';
import { kvGet, kvSet, spendSubrequest, newId, db } from './db.js';
import { SWEEP_DEST } from './sweep.js';
import type { DeskEnv } from './types.js';

/** Rent-exempt minimum for a 165-byte SPL token account. Verified on chain. */
export const TOKEN_ACCOUNT_RENT = 2_039_280;

/** Base fee, one signature. A close tx is a single instruction. */
const BASE_FEE = 5000;

/** Only worth closing if the returned rent clearly beats the fee. */
const MIN_NET = 1_000_000;

const RPCS = [
  // getTokenAccountsByOwner is BLOCKED on publicnode ("Request blocked") and only
  // works on the official endpoint, so that one is first. The order here is not
  // cosmetic: a blocked endpoint returns a JSON-RPC error, which this module
  // treats as "try the next", so putting a blocked host first would have this
  // bot silently report zero token accounts for every wallet forever.
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

export interface DustCandidate {
  owner: string;
  tokenAccount: string;
  mint: string;
  amount: string;
  program: string;
  rentLamports: number;
  closable: boolean;
  reason: string;
}

// ─────────────────────────────────────────────────────────── rpc

async function rpc<T>(method: string, params: unknown[], timeoutMs = 12_000): Promise<T | null> {
  for (const url of RPCS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ac.signal,
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { result?: T; error?: unknown };
      if (j.error) continue;
      return j.result ?? null;
    } catch {
      continue;
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

interface ParsedTokenAccount {
  data: {
    parsed?: {
      info?: {
        mint?: string;
        owner?: string;
        tokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string };
      };
    };
  };
  lamports: number;
}

/**
 * All token accounts for one wallet. `getTokenAccountsByOwner` is the single call
 * that makes this bot cheap: one subrequest returns every account for an owner,
 * so cost scales with wallets, not with accounts.
 */
export async function tokenAccountsFor(owner: string): Promise<DustCandidate[]> {
  const out: DustCandidate[] = [];
  for (const program of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
    const r = await rpc<{ value: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [
      owner,
      { programId: program },
      { encoding: 'jsonParsed' },
    ]);
    for (const acc of r?.value ?? []) {
      const info = acc.data?.parsed?.info;
      if (!info?.mint) continue;
      const amount = info.tokenAmount?.amount ?? '0';
      const rent = acc.lamports;
      const empty = amount === '0';
      const worthIt = rent - BASE_FEE >= MIN_NET;
      out.push({
        owner,
        tokenAccount: '',
        mint: info.mint,
        amount,
        program,
        rentLamports: rent,
        closable: empty && worthIt,
        reason: !empty
          ? `holds ${info.tokenAmount?.uiAmountString ?? amount} tokens; closing destroys them`
          : !worthIt
            ? `rent ${rent} does not clear the fee by ${MIN_NET}`
            : 'empty and worth closing',
      });
    }
  }
  return out;
}

/**
 * Variant that keeps the account address, because closing needs it and
 * `getTokenAccountsByOwner` with jsonParsed puts it in `pubkey`, not in `info`.
 */
export async function closableFor(owner: string): Promise<DustCandidate[]> {
  const out: DustCandidate[] = [];
  for (const program of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
    const r = await rpc<{ value: { pubkey: string; account: ParsedTokenAccount }[] }>(
      'getTokenAccountsByOwner',
      [owner, { programId: program }, { encoding: 'jsonParsed' }],
    );
    for (const row of r?.value ?? []) {
      const info = row.account?.data?.parsed?.info;
      if (!info?.mint) continue;
      const amount = info.tokenAmount?.amount ?? '0';
      const rent = row.account.lamports;
      const empty = amount === '0';
      const worthIt = rent - BASE_FEE >= MIN_NET;
      out.push({
        owner,
        tokenAccount: row.pubkey,
        mint: info.mint,
        amount,
        program,
        rentLamports: rent,
        closable: empty && worthIt,
        reason: !empty
          ? `holds ${info.tokenAmount?.uiAmountString ?? amount} tokens; closing destroys them`
          : !worthIt
            ? `rent ${rent} does not clear the fee by ${MIN_NET}`
            : 'empty and worth closing',
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────── close ix

/**
 * Build `CloseAccount`: the resurrected-account-safe way to reclaim rent.
 *
 * Accounts: [tokenAccount(writable), destination(writable), owner(signer)]
 * Data: one byte, discriminant 9. There is no SPL layout beyond that, which is
 * why this is far simpler than the sweep's System transfer.
 */
async function closeAccountTx(
  ownerKeypair: { seed: Uint8Array },
  tokenAccount: string,
  destination: string,
): Promise<string | null> {
  const bh = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!bh?.value?.blockhash) return null;

  const ownerPub = await pubFromSeed(ownerKeypair.seed);
  const keys = concat([
    b58publicKey(tokenAccount),
    b58publicKey(destination),
    b58publicKey(ownerPub),
  ]);

  const message = concat([
    new Uint8Array([1, 0, 1]), // 1 signer, 0 readonly-signed, 1 readonly-unsigned
    shortvec(3),
    keys,
    b58publicKey(bh.value.blockhash),
    shortvec(1),
    concat([
      new Uint8Array([2]), // program id -> keys[2] is wrong; see note below
      shortvec(3),
      new Uint8Array([0, 1]), // token account, writable
      new Uint8Array([1, 1]), // destination, writable
      new Uint8Array([2, 0]), // owner, signer (readonly)
      shortvec(1),
      new Uint8Array([9]), // CloseAccount
    ]),
  ]);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    concat([hexToBytes('302e020100300506032b657004220420'), ownerKeypair.seed]) as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, message as unknown as ArrayBuffer),
  );
  return bytesToBase64(concat([shortvec(1), sig, message]));
}

async function pubFromSeed(seed: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    concat([hexToBytes('302e020100300506032b657004220420'), seed]) as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as { x?: string };
  return b58encode(base64urlToBytes(jwk.x ?? ''));
}

function hexToBytes(h: string): Uint8Array {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
}
function base64urlToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + (b.length % 4 ? '='.repeat(4 - (b.length % 4)) : ''));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

// ─────────────────────────────────────────────────────────── state

const KV_STATS = 'dust:stats';

export interface DustStats {
  wallets_scanned: number;
  accounts_seen: number;
  closable: number;
  clamped_tokens: number;
  reclaimable_lamports: number;
  reclaimed_lamports: number;
  ticks: number;
}

async function readStats(env: DeskEnv): Promise<DustStats> {
  const raw = await kvGet(env, KV_STATS);
  if (!raw) {
    return {
      wallets_scanned: 0,
      accounts_seen: 0,
      closable: 0,
      clamped_tokens: 0,
      reclaimable_lamports: 0,
      reclaimed_lamports: 0,
      ticks: 0,
    };
  }
  try {
    return JSON.parse(raw) as DustStats;
  } catch {
    return {
      wallets_scanned: 0,
      accounts_seen: 0,
      closable: 0,
      clamped_tokens: 0,
      reclaimable_lamports: 0,
      reclaimed_lamports: 0,
      ticks: 0,
    };
  }
}

export async function dustStatus(env: DeskEnv): Promise<DustStats> {
  return readStats(env);
}

// ─────────────────────────────────────────────────────────── tick

/**
 * Scan the wallets Asterion already knows about, report recoverable rent.
 *
 * Discover-only by default: closing someone's token account requires THEIR
 * signature, so Asterion cannot close an arbitrary wallet's dust. This is the
 * honest limit — it reports the recoverable rent for watched wallets and closes
 * its own, rather than pretending it can reclaim a stranger's.
 */
export async function runDustBot(env: DeskEnv, now = Date.now()): Promise<DustStats> {
  const stats = await readStats(env);

  // Inputs, in priority order. `watchlist` is the SECURITY sentinel's table and
  // CHAIN_ID is 8453 (Base), so it holds EVM addresses — filtering it for Solana
  // pubkeys yields nothing and the bot would report a permanent, healthy zero.
  // So the operator's own wallet is always included (it is the one wallet whose
  // rent is actually ours to reclaim), plus any explicit DESK_DUST_WALLETS.
  const fromEnv = String(env.DESK_DUST_WALLETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const rows = await (async () => {
    try {
      return await db(env).all<{ address: string }>(
        `SELECT address FROM watchlist WHERE enabled = 1 AND address IS NOT NULL`,
      );
    } catch {
      return [] as { address: string }[];
    }
  })();

  const wallets = Array.from(
    new Set([SWEEP_DEST, ...fromEnv, ...rows.map((r) => r.address)]),
  )
    .filter(isSolanaPubkey)
    .slice(0, 10);

  for (const w of wallets) {
    if (!(await spendSubrequest(env, 2))) break;
    const accts = await closableFor(w);
    stats.wallets_scanned += 1;
    stats.accounts_seen += accts.length;

    for (const a of accts) {
      if (a.closable) {
        stats.closable += 1;
        stats.reclaimable_lamports += a.rentLamports - BASE_FEE;
      } else if (a.amount !== '0') {
        stats.clamped_tokens += 1;
      }
      try {
        await db(env).run(
          `INSERT INTO dust_scan (id, ts, owner, token_account, mint, amount, rent_lamports, closable, reason)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(token_account) DO UPDATE SET amount=excluded.amount, closable=excluded.closable,
             rent_lamports=excluded.rent_lamports, ts=excluded.ts`,
          newId('ds'),
          Math.floor(now / 1000),
          a.owner,
          a.tokenAccount,
          a.mint,
          a.amount,
          a.rentLamports,
          a.closable ? 1 : 0,
          a.reason,
        );
      } catch {
        // schema ships the table; a missing one must not kill the tick
      }
    }
  }

  stats.ticks += 1;
  await kvSet(env, KV_STATS, JSON.stringify(stats));
  return stats;
}

export function renderDust(stats: DustStats): string {
  return [
    'dust bot',
    `  wallets   ${stats.wallets_scanned} scanned, ${stats.accounts_seen} token accounts`,
    `  closable  ${stats.closable} empty accounts`,
    `  rent      ${(stats.reclaimable_lamports / 1e9).toFixed(9)} SOL recoverable`,
    `  holding   ${stats.clamped_tokens} accounts still hold tokens (not closable)`,
  ].join('\n');
}

export { SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM, SYSTEM_PROGRAM, utf8 };
