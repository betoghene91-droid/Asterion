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
  decodeBase58,
} from '../solana.js';
import { append as ledgerAppend } from '../ledger.js';
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
export async function closeAccountTx(
  ownerKeypair: { seed: Uint8Array },
  tokenAccount: string,
  destination: string,
  program: string = SPL_TOKEN_PROGRAM,
): Promise<string | null> {
  const bh = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!bh?.value?.blockhash) return null;

  const ownerPub = await pubFromSeed(ownerKeypair.seed);

  // Account order and the header are BOTH load-bearing, and getting either
  // wrong produces a transaction that serialises cleanly and is then rejected on
  // chain. Two separate defects lived here:
  //
  //   1. The instruction named its program by ACCOUNT INDEX 2 while the account
  //      at index 2 was the recipient's pubkey. So the message pointed a token
  //      instruction at a WALLET. Mainnet simulation of that shape returns
  //      `InvalidProgramForExecution` — it never reaches the token program.
  //   2. The account list was written as index/flag PAIRS (`[ind, flags]`). The
  //      legacy message format wants a plain run of indexes; the pairs form
  //      desynchronised the decoder and the remaining bytes were read as
  //      instruction data.
  //
  // Solana requires keys grouped as: writable-signers, readonly-signers,
  // writable-non-signers, readonly-non-signers. The owner signs and pays, so it
  // must come first; the token program is the only readonly non-signer.
  //
  // Verified by mainnet `simulateTransaction`: this exact shape logs
  // `Program log: Instruction: CloseAccount`, i.e. it reaches the program.
  const keys = concat([
    b58publicKey(ownerPub), // 0 writable signer (fee payer)
    b58publicKey(tokenAccount), // 1 writable
    b58publicKey(destination), // 2 writable
    b58publicKey(program), // 3 readonly, non-signer
  ]);

  const message = concat([
    new Uint8Array([1, 0, 1]), // 1 signer, 0 readonly-signed, 1 readonly-unsigned
    shortvec(4),
    keys,
    b58publicKey(bh.value.blockhash),
    shortvec(1),
    concat([
      new Uint8Array([3]), // program id = keys[3] = the token program
      shortvec(3),
      new Uint8Array([1, 2, 0]), // token account, destination, owner (plain indexes)
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

// ────────────────────────────────────────────────────────── reclaim

/**
 * The operator's key, as a 32-byte seed.
 *
 * `SOLANA_OPERATOR_SECRET_KEY` holds the standard 64-byte base58 form
 * (`seed || pubkey`). Only the first 32 bytes are needed to sign: ed25519
 * derives the public key from the seed, and the trailing 32 bytes in that form
 * are a convenience copy of that public key. Taking the seed and re-deriving is
 * therefore strictly safer than trusting the stored second half, because a
 * mismatched pair would silently sign with a key that does not own the account.
 *
 * Returns null when the secret is absent (degrades to detect-only) — never a
 * fabricated zero-length key, which would sign garbage.
 */
export function operatorSeed(env: DeskEnv): Uint8Array | null {
  const raw = String(
    (env as unknown as { SOLANA_OPERATOR_SECRET_KEY?: string }).SOLANA_OPERATOR_SECRET_KEY ?? '',
  ).trim();
  if (!raw) return null;
  // Accept the base58 64-byte form AND the comma-separated byte array that
  // `solana-keygen` writes to a JSON keyfile, because both are what an operator
  // realistically pastes into `wrangler secret put`.
  let bytes: Uint8Array | null = null;
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw) as number[];
      if (Array.isArray(arr) && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        bytes = Uint8Array.from(arr);
      }
    } catch {
      return null;
    }
  } else {
    const d = decodeBase58(raw);
    bytes = d ? d.bytes : null;
  }
  if (!bytes || bytes.length < 32) return null;
  return bytes.slice(0, 32);
}

export interface ReclaimResult {
  /** Set when the operator key is absent: detect-only, nothing was sent. */
  skipped: boolean;
  attempted: number;
  closed: number;
  /** Lamports that actually came back, net of fees. */
  reclaimed: number;
  /** Per-account outcome, so a failure is attributable rather than a lump sum. */
  detail: string[];
}

/**
 * Actually close the operator's empty token accounts and take the rent.
 *
 * This is the step that makes the operator key worth holding. Before it existed,
 * `runDustBot` computed `reclaimable_lamports` — a number — and never sent a
 * transaction, so the key protected nothing: the bot reported recoverable rent
 * that no code path could recover.
 *
 * ## Why it can only ever touch the operator's own accounts
 *
 * `CloseAccount` must be signed by the account's owner (or its close authority).
 * Asterion holds exactly one key, so it can close exactly the accounts that key
 * owns. Every other wallet the scan reports is never touched — that is the
 * honest limit of a one-key bot, and it is why the scan stays useful for wallets
 * the operator cannot act on.
 *
 * ## Why the balance check is not optional
 *
 * `CloseAccount` does not transfer the tokens out; it destroys them. Closing an
 * account that still holds a balance burns real tokens. So this closes only
 * `amount === 0`, and it re-reads that from chain inside the tick rather than
 * trusting a cached `dust_scan` row.
 */
export async function reclaimOwnDust(
  env: DeskEnv,
  ownerAddress: string,
  destination: string,
  maxCloses = 3,
): Promise<ReclaimResult> {
  const out: ReclaimResult = { skipped: false, attempted: 0, closed: 0, reclaimed: 0, detail: [] };
  const seed = operatorSeed(env);
  if (!seed) {
    out.skipped = true;
    out.detail.push('SOLANA_OPERATOR_SECRET_KEY is not set: detect-only, nothing was closed');
    return out;
  }

  const accts = await closableFor(ownerAddress);
  const targets = accts.filter((a) => a.closable && a.amount === '0').slice(0, maxCloses);
  if (targets.length === 0) {
    out.detail.push(`no empty accounts to close for ${ownerAddress}`);
    return out;
  }

  for (const a of targets) {
    if (!(await spendSubrequest(env, 3))) {
      out.detail.push('subrequest budget exhausted mid-reclaim');
      break;
    }
    out.attempted += 1;
    let signed: string | null = null;
    try {
      signed = await closeAccountTx({ seed }, a.tokenAccount, destination, a.program);
    } catch (e) {
      out.detail.push(`${a.tokenAccount.slice(0, 8)}… sign failed: ${(e as Error).message}`);
      continue;
    }
    if (!signed) {
      out.detail.push(`${a.tokenAccount.slice(0, 8)}… could not build the transaction`);
      continue;
    }
    const sig = await rpc<string>('sendTransaction', [
      signed,
      { encoding: 'base64', skipPreflight: false },
    ]);
    if (!sig) {
      out.detail.push(`${a.tokenAccount.slice(0, 8)}… send was rejected (account unreadable)`);
      continue;
    }
    out.closed += 1;
    out.reclaimed += a.rentLamports - BASE_FEE;
    out.detail.push(`${a.tokenAccount.slice(0, 8)}… closed, tx ${sig.slice(0, 12)}…`);
    try {
      await ledgerAppend(env as never, 'dust.reclaim', {
        token_account: a.tokenAccount,
        signature: sig,
        lamports: a.rentLamports - BASE_FEE,
      });
    } catch {
      // The close already happened on chain. A ledger write failure must not
      // turn a successful reclaim into a failed tick.
    }
  }
  return out;
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
  /** True when no operator key is set, so nothing can be closed. Says so. */
  detect_only?: boolean;
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

  // Reclaim last, and only for the wallet Asterion can actually act on. The
  // operator's own key is the single account it can sign for, so everything
  // above is a report and only this step moves money. It runs even when the
  // scan found nothing, because a stale `dust_scan` row is exactly how a
  // closable account gets forgotten.
  if (isSolanaPubkey(SWEEP_DEST)) {
    const r = await reclaimOwnDust(env, SWEEP_DEST, SWEEP_DEST);
    stats.reclaimed_lamports += r.reclaimed;
    if (r.skipped) stats.detect_only = true;
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
