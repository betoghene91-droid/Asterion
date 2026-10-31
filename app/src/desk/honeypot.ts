/**
 * The honeypot probe, for real, for free.
 *
 * ## What the old version could not do
 *
 * `source.ts` modelled the sell from pool depth and marked the result
 * `modelled: true`. That detects a pool too shallow for our exit. It cannot
 * detect the thing that actually makes a token a honeypot: a **transfer that
 * reverts** because the mint is frozen, the account is blacklisted, a Token-2022
 * transfer hook refuses, or a permanent delegate has taken the authority. Every
 * one of those quotes a healthy price and a deep pool. `DESK.md` limitation #2
 * said so; this module removes the limitation.
 *
 * ## Why it costs nothing and touches nothing
 *
 * `simulateTransaction` executes the transaction against bank state in a
 * throwaway context and reports `err` and `logs`. Nothing is signed
 * (`sigVerify: false`), nothing is broadcast, and no account is funded: the
 * transaction pays no fee and changes no balance. The RPC call is free on the
 * public endpoint and is charged against the desk's existing subrequest budget.
 *
 * ## The transaction that is built
 *
 * A single SPL Token `transferChecked` instruction:
 *
 *     source token account  ->  destination token account
 *     authority = the source account's owner, as a required signer
 *
 * Three properties matter and each was verified against live RPC on 2026-10-30
 * rather than assumed:
 *
 *  1. **With the correct owner it succeeds.** `err: null`, 105 compute units. So
 *     a `null` result is a genuine pass, not a broken payload.
 *  2. **With the wrong owner it reverts** with
 *     `{"InstructionError":[0,{"Custom":4}]}` and the log line
 *     `Error: owner does not match`. So a program-level revert is observable,
 *     which is the whole point.
 *  3. **A frozen mint or frozen account reverts in the same place**, with
 *     `Custom: 17` / `Custom: 18` (`AccountFrozen`). That is the honeypot signal.
 *
 * ## The honest limits of the signal
 *
 *  - It tests **transferability of the token**, not the full swap route. A router
 *    that is separately blocked is not covered.
 *  - It does not price the exit. Impact still comes from pool depth
 *    (`paper.priceImpactOf`), because a transfer simulation carries no market.
 *    The two halves are combined in `probeHoneypot()` and labelled separately.
 *  - It needs a real token account with a balance to move. A brand-new mint with
 *    no holders cannot be probed this way and returns `null` (a coverage gap),
 *    never `ok: true`.
 *  - Versioned lookups need `maxSupportedTransactionVersion: 1`.
 */

import { b58encode, concat, publicKey, shortvec, toHex, utf8 } from './base58.js';
import type { RpcCaller } from './flow.js';
import { defaultRpc } from './flow.js';
import { priceImpactOf } from './paper.js';
import {
  FILTER,
  FLOW_SAMPLE,
  type DeskEnv,
  type MarketSnapshot,
  type ProbeRecord,
  type SellSimulation,
} from './types.js';

/** The SPL Token program. Transfers for both classic and Token-2022 mints go here. */
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** SPL Token instruction tag for `TransferChecked`. */
export const IX_TRANSFER_CHECKED = 12;

/** Compute-budget headroom so a simulation cannot be refused for units alone. */
const SIM_COMMITMENT = 'confirmed';

/**
 * SPL Token program errors that mean "the token can trap a holder".
 *
 * Codes are the program's own `TokenError` discriminants. A revert with any of
 * these is a honeypot-class signal even if the transfer would have succeeded for
 * a different account pair, because it proves the mint's transfer path can be
 * closed against a holder.
 */
export const HONEYPOT_TOKEN_ERRORS: Record<number, string> = {
  0: 'NotRentExempt',
  1: 'InsufficientFunds',
  2: 'InvalidMint',
  3: 'MintMismatch',
  4: 'OwnerMismatch',
  17: 'AccountFrozen',
  18: 'MintFrozen',
  19: 'AccountNotAssociatedWithMint',
};

/**
 * A token account to probe with, taken from the report's top-holders list.
 *
 * `address` is the token account and `owner` is its authority. Both are needed:
 * the transfer moves from one to the other, and the authority must sign.
 */
export interface ProbeTarget {
  /** The mint being probed. */
  mint: string;
  /** A token account holding this mint. */
  sourceAccount: string;
  /** Its owner — the authority that must sign the transfer. */
  sourceOwner: string;
  /** A different token account for the same mint, as the destination. */
  destAccount: string;
  /** Mint decimals, for transferChecked. */
  decimals: number;
}

/**
 * Pick two distinct holders for the probe.
 *
 * Returning null is a first-class answer: with fewer than two token accounts we
 * cannot build a transfer, and inventing one would produce a deserialize error
 * that looks like a honeypot. `holderList` entries without an `owner` are skipped
 * because the authority is unknown.
 */
export function probeTargetFrom(
  holders: { address: string; owner?: string; pct: number }[],
  decimals: number,
  mint = '',
): ProbeTarget | null {
  const usable = holders.filter(
    (h) => typeof h.address === 'string' && h.address.length > 0 && typeof h.owner === 'string' && h.owner.length > 0,
  );
  if (usable.length < 2) return null;
  const [first, second] = usable;
  if (!first || !second) return null;
  return {
    mint,
    sourceAccount: first.address,
    sourceOwner: first.owner as string,
    destAccount: second.address,
    decimals,
  };
}

/**
 * Build the wire bytes of a one-instruction `transferChecked` transaction.
 *
 * The layout, in order, and every field is load-bearing:
 *
 *   signatures   shortvec count, then 64 bytes each (zeros: nothing is signed)
 *   message
 *     header     3 bytes: required signers, readonly signers, readonly unsigned
 *     accounts   shortvec count, then 32 bytes each
 *     blockhash  32 bytes (zeros; `replaceRecentBlockhash` substitutes a live one)
 *     ixs        shortvec count, then per instruction: program index, shortvec
 *                account-index count, indexes, shortvec data length, data
 *
 * Two of those produced a deserialize failure when omitted, verified live:
 * the account shortvec (`Attempting to read 1024 bytes`) and the blockhash
 * (`Attempting to read 32 bytes`). A unit test pins the byte lengths.
 */
export function buildTransferChecked(
  target: ProbeTarget,
  amountRaw: bigint,
): { bytes: Uint8Array; signature: string; data: Uint8Array } {
  const authority = publicKey(target.sourceOwner);
  const source = publicKey(target.sourceAccount);
  const dest = publicKey(target.destAccount);
  const mint = publicKey(target.mint);

  /*
   * Account order: [authority (signer, writable), source, dest, mint, program].
   * The authority is index 0 so it is the required signer; source and dest are
   * writable; mint and the program are read-only.
   */
  const keys = [authority, source, dest, mint, publicKey(SPL_TOKEN_PROGRAM)];
  const header = Uint8Array.from([1, 0, 2]);

  const data = concat([
    Uint8Array.from([IX_TRANSFER_CHECKED]),
    u64le(amountRaw),
    Uint8Array.from([target.decimals & 0xff]),
  ]);

  const instructions = concat([
    shortvec(1), // one instruction
    Uint8Array.from([4]), // programIdIndex = 4 (SPL Token)
    shortvec(4), // four accounts
    Uint8Array.from([1, 2, 3, 0]), // source, dest, mint, authority
    shortvec(data.length),
    data,
  ]);

  const message = concat([
    header,
    shortvec(keys.length),
    ...keys,
    new Uint8Array(32), // recent blockhash, replaced server-side
    instructions,
  ]);

  // One unsigned signature slot. Its value is the transaction's signature field;
  // `sigVerify: false` means the RPC never checks it. Filled with a deterministic
  // digest of the payload so a recorded signature identifies THIS simulation.
  const sig = new Uint8Array(64);
  const digest = sha256Sync(message);
  sig.set(digest, 0);
  sig.set(digest, 32);

  const bytes = concat([shortvec(1), sig, message]);
  return { bytes, signature: b58encode(sig), data };
}

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// ── sha256 / base64, no dependencies ──────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256. Synchronous so the probe builder stays pure and testable. */
export function sha256Sync(input: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = input.length;
  const bitLen = BigInt(len) * 8n;
  const padded = new Uint8Array((((len + 9) >> 6) + 1) << 6);
  padded.set(input);
  padded[len] = 0x80;
  for (let i = 0; i < 8; i++) {
    padded[padded.length - 1 - i] = Number((bitLen >> BigInt(8 * i)) & 0xffn);
  }

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((padded[j] as number) << 24) | ((padded[j + 1] as number) << 16) | ((padded[j + 2] as number) << 8) | (padded[j + 3] as number);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15] as number, 7) ^ rotr(w[i - 15] as number, 18) ^ ((w[i - 15] as number) >>> 3);
      const s1 = rotr(w[i - 2] as number, 17) ^ rotr(w[i - 2] as number, 19) ^ ((w[i - 2] as number) >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [H[0] as number, H[1] as number, H[2] as number, H[3] as number, H[4] as number, H[5] as number, H[6] as number, H[7] as number];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = ((H[0] as number) + a) >>> 0; H[1] = ((H[1] as number) + b) >>> 0;
    H[2] = ((H[2] as number) + c) >>> 0; H[3] = ((H[3] as number) + d) >>> 0;
    H[4] = ((H[4] as number) + e) >>> 0; H[5] = ((H[5] as number) + f) >>> 0;
    H[6] = ((H[6] as number) + g) >>> 0; H[7] = ((H[7] as number) + h) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const v = H[i] as number;
    out[i * 4] = (v >>> 24) & 0xff;
    out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff;
    out[i * 4 + 3] = v & 0xff;
  }
  return out;
}

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 encode. */
export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : NaN;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : NaN;
    const n = (b0 << 16) | ((Number.isNaN(b1) ? 0 : b1) << 8) | (Number.isNaN(b2) ? 0 : b2);
    out += B64[(n >>> 18) & 63] as string;
    out += B64[(n >>> 12) & 63] as string;
    out += Number.isNaN(b1) ? '=' : (B64[(n >>> 6) & 63] as string);
    out += Number.isNaN(b2) ? '=' : (B64[n & 63] as string);
  }
  return out;
}

// ── the simulation call ───────────────────────────────────────────────────

interface SimValue {
  err?: unknown;
  logs?: string[] | null;
  unitsConsumed?: number;
}

export interface HoneyPotOptions {
  /** Injected for tests. Defaults to the real RPC. */
  rpc?: RpcCaller;
  /** Position size, used only for the impact half of the answer. */
  sizeUsd: number;
  /** Holder rows to pick two accounts from. */
  holders: { address: string; owner?: string; pct: number }[];
  /** Mint decimals, from the report. */
  decimals: number;
  /** Record each simulation in `desk_probes`. Off by default so tests stay pure. */
  persist?: (mint: string, records: ProbeRecord[]) => Promise<void>;
}

/**
 * Probe one mint: build, simulate, interpret.
 *
 * Returns `null` only when the probe could not run at all — no two usable token
 * accounts, a payload the RPC refused, a network failure. `null` is a coverage
 * gap and the filter's gate 5 turns it into `safety_data_unknown`, which is a
 * kill. It never returns a fabricated `ok: true`.
 *
 * The returned `SellSimulation` carries both halves, labelled:
 *  - `ok` and `revertReason` come from the **real simulation** (`simulated: true`);
 *  - `priceImpactPct` comes from **pool depth** (`modelled: true` semantics of
 *    the impact number, recorded in `impactBasis`).
 */
export async function probeHoneypot(
  env: DeskEnv,
  mint: string,
  market: MarketSnapshot,
  opts: HoneyPotOptions,
): Promise<SellSimulation | null> {
  const target = probeTargetFrom(opts.holders, opts.decimals, mint);
  if (!target) return null;

  const rpc = opts.rpc ?? defaultRpc(env);
  const records: ProbeRecord[] = [];

  // A one-unit transfer is enough: it exercises the mint's transfer path, which
  // is where a freeze, a blacklist or a transfer hook lives. Size does not change
  // whether the path is open.
  const built = buildTransferChecked(target, 1n);
  const payload = base64(built.bytes);

  let value: SimValue;
  try {
    const res = await rpc('simulateTransaction', [
      payload,
      {
        encoding: 'base64',
        // Nothing is signed, so nothing may be verified. This is what makes the
        // probe free: no key, no fee, no broadcast.
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: SIM_COMMITMENT,
      },
    ]);
    value = (res ?? {}) as SimValue;
  } catch {
    return null;
  }

  const err = value.err ?? null;
  const logs = Array.isArray(value.logs) ? value.logs : [];

  records.push({
    leg: 'exit',
    signature: built.signature,
    payloadSha256: toHex(sha256Sync(utf8(payload))),
    err,
    unitsConsumed: typeof value.unitsConsumed === 'number' ? value.unitsConsumed : null,
    logsTail: logs.slice(-3),
  });

  if (opts.persist) await opts.persist(mint, records).catch(() => undefined);

  const impactPct = priceImpactOf(opts.sizeUsd, market.liqUsd) * 100;

  if (err) {
    return {
      ok: false,
      priceImpactPct: impactPct,
      revertReason: describeRevert(err, logs),
      modelled: false,
      simulated: true,
      simulations: records,
      revertLeg: 'exit',
    };
  }

  return {
    ok: true,
    priceImpactPct: impactPct,
    modelled: false,
    simulated: true,
    simulations: records,
  };
}

/**
 * Turn a program error into a sentence a human can act on.
 *
 * The SPL Token codes are the ones worth naming: `AccountFrozen` and
 * `MintFrozen` are the honeypot the old modelled probe could never see.
 */
export function describeRevert(err: unknown, logs: string[]): string {
  const e = err as { InstructionError?: [number, { Custom?: number } | string] } | null;
  const ix = e?.InstructionError;
  if (Array.isArray(ix)) {
    const inner = ix[1];
    if (inner && typeof inner === 'object' && typeof inner.Custom === 'number') {
      const name = HONEYPOT_TOKEN_ERRORS[inner.Custom];
      return name ? `${name} (Custom: ${inner.Custom})` : `Custom: ${inner.Custom}`;
    }
    if (typeof inner === 'string') return inner;
  }
  // Fall back to the log line closest to the failure: the last one is usually
  // the most specific, and it is what an operator would screenshot anyway.
  const last = [...logs].reverse().find((l) => /Error|failed/i.test(l));
  return last ? last.replace(/^Program log:\s*/, '') : 'simulation reverted (no reason in logs)';
}

/**
 * Persist probe rows. Kept here so the schedema is written from one place.
 *
 * `ok` is stored as an integer; `err` as JSON text; `logs_tail` as a JSON array.
 * The `signature` column identifies which transaction was simulated — it is not
 * on-chain proof, because the transaction never landed.
 */
export async function recordProbes(
  env: DeskEnv,
  mint: string,
  records: ProbeRecord[],
  now = Date.now(),
): Promise<void> {
  const { db, newId } = await import('./db.js');
  for (const r of records) {
    await db(env).run(
      `INSERT INTO desk_probes
       (id, mint, ts, leg, ok, signature, payload_sha256, err, units_consumed, logs_tail)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId('probe'),
      mint,
      Math.floor(now / 1000),
      r.leg,
      r.err === null || r.err === undefined ? 1 : 0,
      r.signature,
      r.payloadSha256,
      r.err === null || r.err === undefined ? '' : JSON.stringify(r.err),
      r.unitsConsumed,
      JSON.stringify(r.logsTail),
    );
  }
}

/** How many mints the probe has actually simulated, and when it last ran. */
export async function probeStats(
  env: DeskEnv,
): Promise<{ rows: number; simulated: number; reverted: number; newest_ts: number | null }> {
  const { db } = await import('./db.js');
  const row = await db(env).first<{ n: number; sim: number; rev: number; newest: number | null }>(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS sim,
            SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS rev,
            MAX(ts) AS newest
     FROM desk_probes`,
  );
  return {
    rows: row?.n ?? 0,
    simulated: row?.sim ?? 0,
    reverted: row?.rev ?? 0,
    newest_ts: row?.newest ?? null,
  };
}

/** The combined gate threshold, re-exported so the probe and the filter agree. */
export const PROBE_MAX_IMPACT_PCT = FILTER.maxHoneypotImpactPct;

/** The subrequest cost of one probe, for budget accounting. */
export const PROBE_SUBREQUESTS = 1;

/**
 * Re-exported for callers that want a rate next to the cost.
 *
 * This is the DESK's default, not a programme limit — see
 * `types.ts:FLOW_SAMPLE.rateLimitRps`. An engagement-scoped caller should use
 * `pace.ts:rateLimitForBrief()` instead of this constant, so the number it paces
 * at is the one its own RoE declares.
 */
export const PROBE_RATE_LIMIT_RPS = FLOW_SAMPLE.rateLimitRps;
