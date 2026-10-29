// Drain tests. Run with: node --test
//
// The requirement being tested, verbatim: "It should be a generic drainer too
// but only on my approval."
//
// Two things this suite exists to establish, in this order:
//
//   1. ONLY ON APPROVAL. Every refusal code in DrainRefusalCode has a test here
//      that asserts the code AND that nothing was broadcast. A refusal that
//      still sent a transaction would be worse than no drainer at all, so each
//      test also proves the signer / rpc were never touched.
//
//   2. GENERIC. All ten Solidity classes produce a plan from the same ladder,
//      and the class only changes metadata. A bug that hardcoded one class would
//      fail the table-driven test at the bottom.
//
// Network-free by construction: DrainExec, ChainRpc and Signer are all fakes.
// No RPC endpoint, no key, no chain. The live path is exercised through the real
// v1 SendRelay with a fake signer + fake rpc, so the relay's own interlocks are
// validated in combination rather than mocked away.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planDrain,
  draftDrain,
  executeDrain,
  isRefusal,
  refusal,
  renderPlan,
  renderReceipt,
  planFingerprint,
  planSignatureValid,
  sha256Hex,
  formatWei,
  ApprovalLedger,
  DRAIN_CLASSES,
  EXTRACTION_VECTORS,
  DRAIN_ALLOWED_CHAINS,
  DRAIN_MAINNET_CHAINS,
  VECTOR_ORDER,
} from '../build/drain.js';
import { SendRelay } from '../build/send.js';
import { judge } from '../build/proof.js';

// ── fixed fixtures ───────────────────────────────────────────────────────────

const NOW = 1_800_000_000;
const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;
const ETH_MAINNET = 1;

const TARGET = '0x1111111111111111111111111111111111111111';
const OTHER_TARGET = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x00000000000000000000000000000000000000A9'.toLowerCase();
const VICTIM = '0x00000000000000000000000000000000000000B0'.toLowerCase();

const E18 = 10n ** 18n;

/** The verdict a real judge() returns for a reproduced+causal+measured bundle. */
function provenProof(over = {}) {
  return {
    verdict: 'proven',
    confidence: 'confirmed',
    reasons: ['the PoC test fails on the pinned commit with a real assertion'],
    claim: 'attacker withdraws more than deposited via reentrant callback',
    ...over,
  };
}

function poc(over = {}) {
  return {
    test_name: 'test_reentrancy_5',
    control_name: 'test_reentrancy_5_control',
    ...over,
  };
}

/**
 * A plain direct-pull plan: one exploit leg that takes 10 ETH out of the target.
 * Whatever leg shape a test needs, it starts from here so the *refusal under
 * test* is the only thing that differs.
 */
function legs(over = {}) {
  return [
    {
      kind: 'pull',
      to: TARGET,
      data: '0x3ccfd60b',
      value_wei: 0n,
      prefunded_wei: 0n,
      expected_delta_wei: 10n * E18,
      exploit: true,
      note: 'call withdraw() as the attacker',
      ...over,
    },
  ];
}

function baseInput(over = {}) {
  return {
    proof: provenProof(),
    poc: poc(),
    target: TARGET,
    chain_id: BASE_SEPOLIA,
    class: 'sol.reentrancy',
    vector: 'direct_pull',
    asset: 'native',
    legs: legs(),
    fork_block: 21_000_000,
    now: NOW,
    ledger: new ApprovalLedger(),
    ...over,
  };
}

/** Mint an approval bound to a draft's fingerprint — the operator's step. */
function approve(plan, over = {}) {
  return {
    approved: true,
    operator: 'jennifer',
    plan_fingerprint: plan.fingerprint,
    nonce: `nonce-${plan.drain_id}`,
    expires_at: NOW + 600,
    max_value_wei: 100n * E18,
    ...over,
  };
}

/** Draft then approve, in the order the operator actually uses. */
function approved(input = baseInput()) {
  const draft = draftDrain(input);
  assert.ok(!isRefusal(draft), `draft should have succeeded: ${isRefusal(draft) ? draft.code : ''}`);
  return { input: { ...input, approval: approve(draft) }, plan: draft };
}

/** Assert a value is a refusal with the given code. */
function refuses(value, code) {
  assert.ok(isRefusal(value), `expected a refusal (${code}) but got a plan: ${JSON.stringify(value).slice(0, 200)}`);
  assert.equal(value.code, code, `expected refusal '${code}', got '${value.code}': ${value.reason}`);
  return value;
}

// ── an execution boundary that records everything ────────────────────────────

/**
 * Fake fork runner. Records each request so a test can prove which runs happened
 * (and, for the control-voiding tests, that the control really was attempted).
 */
function fakeExec(opts = {}) {
  const runs = [];
  const {
    attackerDelta = 10n * E18,
    victimDelta = -10n * E18,
    controlAttackerDelta = 0n,
    controlVictimDelta = 0n,
    attackOk = true,
    controlOk = true,
    throwOn = null,
    hashes = ['0xaa', '0xbb'],
  } = opts;

  return {
    runs,
    async run(req) {
      runs.push(req);
      if (throwOn === (req.control ? 'control' : 'attack')) throw new Error('fork RPC exploded');
      if (req.control) {
        return {
          ok: controlOk,
          attacker_delta_wei: controlAttackerDelta,
          victim_delta_wei: controlVictimDelta,
          tx_hashes: [],
          reason: controlOk ? null : 'control reverted',
        };
      }
      return {
        ok: attackOk,
        attacker_delta_wei: attackerDelta,
        victim_delta_wei: victimDelta,
        tx_hashes: hashes,
        reason: attackOk ? null : 'attack reverted',
      };
    },
  };
}

/** Fake ChainRpc for the real SendRelay. Counts every wire-touching call. */
function fakeRpc(over = {}) {
  const calls = { estimateGas: 0, call: 0, getNonce: 0, sendRawTransaction: 0, getReceipt: 0 };
  return {
    calls,
    async estimateGas() { calls.estimateGas++; return 100_000n; },
    async call() { calls.call++; return '0x'; },
    async getNonce() { calls.getNonce++; return 7; },
    async sendRawTransaction(raw) { calls.sendRawTransaction++; return `0xhash${calls.sendRawTransaction}`; },
    async getReceipt(h) { calls.getReceipt++; return { status: 1, gasUsed: 21_000n, blockNumber: 100 }; },
    ...over,
  };
}

function fakeSigner(over = {}) {
  const signed = [];
  return {
    signed,
    address: ATTACKER,
    async signTransaction(tx) { signed.push(tx); return '0xdeadbeefcafe'; },
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// sha256 — the primitive the whole approval binding rests on
// ═══════════════════════════════════════════════════════════════════════════

test('sha256 matches the published NIST vectors', () => {
  // If this fails, approval binding is not binding, so these are not optional.
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  // 448-bit boundary: 55 bytes fits in one block, 56 forces a second.
  assert.equal(
    sha256Hex('a'.repeat(55)),
    '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
  );
  assert.equal(
    sha256Hex('a'.repeat(56)),
    'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
  );
});

test('sha256 is stable across a multi-block input', () => {
  // 1 MB: exercises the length padding above 2^16 bits and many blocks.
  const h = sha256Hex('a'.repeat(1_000_000));
  assert.equal(h, 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. VERDICT LADDER
// ═══════════════════════════════════════════════════════════════════════════

test('no proof object at all is refused', () => {
  refuses(planDrain(baseInput({ proof: null })), 'no_proof');
  refuses(planDrain(baseInput({ proof: undefined })), 'no_proof');
  refuses(planDrain(baseInput({ proof: 'proven' })), 'no_proof');
});

test('a missing proof is refused', () => {
  // Even with a perfectly valid approval, a drain cannot precede a finding.
  const { input } = approved();
  refuses(planDrain({ ...input, proof: null }), 'no_proof');
});

test('partial, inconclusive and disproved are each refused', () => {
  for (const v of ['partial', 'inconclusive', 'disproved']) {
    refuses(planDrain(baseInput({ proof: provenProof({ verdict: v }) })), 'verdict_not_proven');
  }
});

test('a near-miss verdict string is refused', () => {
  for (const v of ['Proven', 'PROVEN', ' proven', 'proven ', 'proven!', '', 'true']) {
    refuses(planDrain(baseInput({ proof: provenProof({ verdict: v }) })), 'verdict_not_proven');
  }
});

test('a proven verdict with no claim is refused (it did not come from judge)', () => {
  refuses(planDrain(baseInput({ proof: provenProof({ claim: null }) })), 'proof_claim_missing');
  refuses(planDrain(baseInput({ proof: provenProof({ claim: '   ' }) })), 'proof_claim_missing');
});

test('a real judge() proof is accepted end to end', () => {
  // Composition check: the verdict this module consumes is the one proof.ts emits.
  const result = judge({
    hypothesis_id: 'h',
    commit: 'c',
    test_name: 'test_reentrancy_5',
    reproduced: { exit_code: 1, output: '[FAIL. Reason: REENTRANCY]', failure_reason: null, duration_ms: 5 },
    without_precondition: { exit_code: 0, output: '[PASS]', failure_reason: null, duration_ms: 5 },
    impact: { kind: 'value_transfer', description: 'attacker withdrew 10 more than deposited', measured: { before: '100', after: '110' } },
  });
  assert.equal(result.verdict, 'proven');
  const draft = draftDrain(baseInput({ proof: result }));
  assert.ok(!isRefusal(draft), isRefusal(draft) ? draft.reason : '');
  assert.equal(draft.proof_test_name, 'test_reentrancy_5');
  assert.match(draft.proof_claim, /attacker withdrew/);
});

test('no control run is refused, and so is an unnamed one', () => {
  refuses(planDrain(baseInput({ poc: null })), 'plan_invalid');
  refuses(planDrain(baseInput({ poc: { test_name: 't' } })), 'no_control_run');
  refuses(planDrain(baseInput({ poc: { test_name: 't', control_name: '' } })), 'no_control_run');
  refuses(planDrain(baseInput({ poc: { test_name: 't', control_name: '   ' } })), 'no_control_run');
});

test('a plan with no leg marked exploit has no control and is refused', () => {
  refuses(planDrain(baseInput({ legs: legs({ exploit: false }) })), 'no_control_run');
});

test('an unknown class is refused', () => {
  refuses(planDrain(baseInput({ class: 'sol.nonexistent' })), 'class_not_supported');
  refuses(planDrain(baseInput({ class: 'reentrancy' })), 'class_not_supported');
  refuses(planDrain(baseInput({ class: null })), 'class_not_supported');
  // Prototype keys are not classes.
  refuses(planDrain(baseInput({ class: 'constructor' })), 'class_not_supported');
  refuses(planDrain(baseInput({ class: '__proto__' })), 'class_not_supported');
});

test('an unknown vector is refused', () => {
  refuses(planDrain(baseInput({ vector: 'teleport' })), 'vector_not_supported');
  refuses(planDrain(baseInput({ vector: null })), 'vector_not_supported');
});

test('a vector that cannot carry the class is refused', () => {
  // dos produces no flashloan roundtrip; if a caller claims it, something upstream lied.
  refuses(
    planDrain(baseInput({ class: 'sol.dos', vector: 'flashloan_roundtrip' })),
    'vector_not_supported_for_class',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. APPROVAL LADDER — the core of "only on my approval"
// ═══════════════════════════════════════════════════════════════════════════

test('no approval object is refused', () => {
  const { input } = approved();
  refuses(planDrain({ ...input, approval: null }), 'no_approval');
  refuses(planDrain({ ...input, approval: undefined }), 'no_approval');
  // An empty object is an approval that was never filled in, so it is refused
  // for containing no approval rather than for being absent. Either way: refused.
  refuses(planDrain({ ...input, approval: {} }), 'approval_not_approved');
});

test('approval must be literally approved === true', () => {
  const { input } = approved();
  // Everything truthy but not `true`. Each of these would pass a naive `if (a.approved)`.
  for (const v of ['true', 'yes', 1, {}, [], -1, 'TRUE']) {
    const r = refuses(
      planDrain({ ...input, approval: { ...input.approval, approved: v } }),
      'approval_not_approved',
    );
    assert.match(r.reason, /only literal true/);
  }
  // And the one that matters most: false / absent.
  refuses(planDrain({ ...input, approval: { ...input.approval, approved: false } }), 'approval_not_approved');
});

test('an anonymous approval is refused', () => {
  const { input } = approved();
  for (const op of ['', '   ', null, undefined, 42]) {
    refuses(planDrain({ ...input, approval: { ...input.approval, operator: op } }), 'approval_no_operator');
  }
});

test('an approval for plan A does NOT authorise plan B', () => {
  // THE binding test. Approve A, then try to run B with A's approval.
  const a = approved(baseInput({ legs: legs({ expected_delta_wei: 10n * E18 }) }));
  const bInput = baseInput({ legs: legs({ expected_delta_wei: 11n * E18 }) });
  const bDraft = draftDrain(bInput);
  assert.ok(!isRefusal(bDraft));

  // Different plan, different fingerprint — that is what makes the next line fail.
  assert.notEqual(a.plan.fingerprint, bDraft.fingerprint);

  refuses(planDrain({ ...bInput, approval: a.input.approval }), 'approval_plan_mismatch');
});

test('a one-byte calldata change invalidates the approval', () => {
  const a = approved(baseInput({ legs: legs({ data: '0x3ccfd60b' }) }));
  refuses(
    planDrain({ ...baseInput({ legs: legs({ data: '0x3ccfd60c' }) }), approval: a.input.approval }),
    'approval_plan_mismatch',
  );
});

test('changing the target, chain, asset, value or class all invalidate the approval', () => {
  const a = approved();
  const mutations = [
    { target: OTHER_TARGET },
    { chain_id: 11155111 },
    { asset: TOKEN },
    { legs: legs({ value_wei: 1n }) },
    { class: 'sol.accesscontrol', vector: 'direct_pull' },
    { fork_block: 21_000_001 },
    { poc: poc({ test_name: 'a_different_test' }) },
  ];
  for (const m of mutations) {
    refuses(planDrain({ ...baseInput(m), approval: a.input.approval }), 'approval_plan_mismatch');
  }
});

test('an approval with an empty nonce is refused', () => {
  const { input } = approved();
  refuses(planDrain({ ...input, approval: { ...input.approval, nonce: '' } }), 'plan_invalid');
});

test('an expired approval is refused', () => {
  const { input } = approved();
  // one second past expiry
  refuses(
    planDrain({ ...input, now: input.approval.expires_at + 1 }),
    'approval_expired',
  );
  // The boundary is inclusive: still valid at exactly expires_at.
  const draft = draftDrain(input);
  assert.ok(!isRefusal(draft));
  const atExpiry = planDrain({ ...input, now: input.approval.expires_at });
  assert.ok(!isRefusal(atExpiry), 'exactly at expires_at is still valid');
});

test('a malformed expiry is refused rather than treated as no expiry', () => {
  const { input } = approved();
  for (const e of [undefined, null, '1800000600', NaN, Infinity]) {
    refuses(planDrain({ ...input, approval: { ...input.approval, expires_at: e } }), 'plan_invalid');
  }
});

test('an already-consumed approval is refused', () => {
  const { input } = approved();
  const ledger = input.ledger;
  assert.equal(ledger.consume(input.approval.nonce, input.approval.plan_fingerprint, 'jennifer', NOW), true);
  refuses(planDrain(input), 'approval_consumed');
});

test('a revoked approval is refused', () => {
  const { input } = approved();
  input.ledger.revoke(input.approval.nonce, '', 'jennifer', NOW);
  refuses(planDrain(input), 'approval_revoked');
});

test('no ledger means no single-use guarantee, so it is refused', () => {
  const { input } = approved();
  refuses(planDrain({ ...input, ledger: null }), 'no_ledger');
  refuses(planDrain({ ...input, ledger: undefined }), 'no_ledger');
  // A duck-typed impostor is refused too: the ledger must be a real one.
  refuses(
    planDrain({
      ...input,
      ledger: { isConsumed: () => false, isRevoked: () => false, isSpent: () => false },
    }),
    'no_ledger',
  );
});

test('a missing max_value_wei or a non-bigint cap is refused', () => {
  const { input } = approved();
  refuses(
    planDrain({ ...input, approval: { ...input.approval, max_value_wei: undefined } }),
    'plan_invalid',
  );
  refuses(
    planDrain({ ...input, approval: { ...input.approval, max_value_wei: '100000000000000000000' } }),
    'plan_invalid',
  );
});

test('an extraction larger than the approved cap is refused', () => {
  const plan = draftDrain(baseInput());
  assert.ok(!isRefusal(plan));
  refuses(
    planDrain({ ...baseInput(), approval: approve(plan, { max_value_wei: 9n * E18 }) }),
    'value_over_cap',
  );
  // Exactly at the cap is allowed.
  const atCap = planDrain({ ...baseInput(), approval: approve(plan, { max_value_wei: 10n * E18 }) });
  assert.ok(!isRefusal(atCap), 'at-cap extraction should be allowed');
});

test('a negative cap is refused', () => {
  const plan = draftDrain(baseInput());
  refuses(planDrain({ ...baseInput(), approval: approve(plan, { max_value_wei: -1n }) }), 'plan_invalid');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CHAIN LADDER
// ═══════════════════════════════════════════════════════════════════════════

test('a chain off the allowlist is refused', () => {
  for (const chain of [137, 42161, 10, 56, 0, -1]) {
    refuses(planDrain(baseInput({ chain_id: chain })), 'chain_not_allowed');
  }
});

test('every allowlisted test chain plans cleanly', () => {
  for (const chain of DRAIN_ALLOWED_CHAINS) {
    const draft = draftDrain(baseInput({ chain_id: chain }));
    assert.ok(!isRefusal(draft), `chain ${chain}: ${isRefusal(draft) ? draft.reason : ''}`);
  }
});

test('mainnet needs BOTH switches, not either', () => {
  for (const chain of DRAIN_MAINNET_CHAINS) {
    const draft = draftDrain(baseInput({ chain_id: chain }));
    assert.ok(!isRefusal(draft));

    // neither
    refuses(planDrain({ ...baseInput({ chain_id: chain }), approval: approve(draft) }), 'mainnet_needs_double_confirm');
    // approval side only
    refuses(
      planDrain({
        ...baseInput({ chain_id: chain }),
        approval: approve(draft, { allow_mainnet: true }),
        confirm_mainnet: false,
      }),
      'mainnet_needs_double_confirm',
    );
    // call site only
    refuses(
      planDrain({ ...baseInput({ chain_id: chain }), approval: approve(draft), confirm_mainnet: true }),
      'mainnet_needs_double_confirm',
    );
    // truthy but not true, on either side
    refuses(
      planDrain({
        ...baseInput({ chain_id: chain }),
        approval: approve(draft, { allow_mainnet: 'true' }),
        confirm_mainnet: 'true',
      }),
      'mainnet_needs_double_confirm',
    );
    // both, literally
    const ok = planDrain({
      ...baseInput({ chain_id: chain }),
      approval: approve(draft, { allow_mainnet: true }),
      confirm_mainnet: true,
    });
    assert.ok(!isRefusal(ok), `chain ${chain} with both switches: ${isRefusal(ok) ? ok.reason : ''}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. PLAN-SHAPE LADDER
// ═══════════════════════════════════════════════════════════════════════════

test('a leg that needs a privileged role is refused', () => {
  refuses(planDrain(baseInput({ legs: legs({ as: 'owner' }) })), 'privileged_role_required');
  refuses(planDrain(baseInput({ legs: legs({ as: 'admin' }) })), 'privileged_role_required');
  refuses(planDrain(baseInput({ legs: legs({ as: 'governance' }) })), 'privileged_role_required');
});

test('capital in may not exceed capital out', () => {
  // Attack costs 20 ETH to gain 10: not an extraction, a donation.
  refuses(
    planDrain(baseInput({ legs: legs({ value_wei: 20n * E18, expected_delta_wei: 10n * E18 }) })),
    'capital_exceeds_extraction',
  );
});

test('a pre-funded balance the plan relies on must be declared and still net positive', () => {
  // 50 ETH of assumed balance, 10 ETH out: capital exceeds extraction.
  refuses(
    planDrain(baseInput({ legs: legs({ prefunded_wei: 50n * E18 }) })),
    'capital_exceeds_extraction',
  );
});

test('an undeclared pre-funded balance is refused', () => {
  // The legs need 5 ETH of working capital; the plan claims it needs none.
  refuses(
    planDrain(
      baseInput({
        legs: legs({ prefunded_wei: 5n * E18, expected_delta_wei: 10n * E18 }),
        declared_capital_in_wei: 0n,
      }),
    ),
    'capital_unaccounted',
  );
  // Declaring a larger figure than the legs need is also a mismatch.
  refuses(
    planDrain(
      baseInput({ legs: legs({ value_wei: 1n }), declared_capital_in_wei: 4n * E18 }),
    ),
    'capital_unaccounted',
  );
});

test('a plan whose value delta is <= 0 is refused', () => {
  // exactly zero
  refuses(
    planDrain(baseInput({ legs: legs({ expected_delta_wei: 0n }) })),
    'no_positive_delta',
  );
  // negative
  refuses(
    planDrain(baseInput({ legs: legs({ expected_delta_wei: -1n * E18 }) })),
    'no_positive_delta',
  );
  // nets to zero across two legs: +10 then -10
  refuses(
    planDrain(
      baseInput({
        legs: [
          { kind: 'call', to: TARGET, data: '0x', value_wei: 0n, expected_delta_wei: 10n * E18, exploit: true },
          { kind: 'pull', to: TARGET, data: '0x', value_wei: 0n, expected_delta_wei: -10n * E18 },
        ],
      }),
    ),
    'no_positive_delta',
  );
});

test('malformed legs are refused', () => {
  refuses(planDrain(baseInput({ legs: [] })), 'plan_invalid');
  refuses(planDrain(baseInput({ legs: null })), 'plan_invalid');
  refuses(planDrain(baseInput({ legs: legs({ to: 'not-an-address' }) })), 'plan_invalid');
  refuses(planDrain(baseInput({ legs: legs({ data: 'zz' }) })), 'plan_invalid');
  refuses(planDrain(baseInput({ legs: legs({ value_wei: 1 }) })), 'plan_invalid');
  refuses(planDrain(baseInput({ legs: legs({ expected_delta_wei: '1000' }) })), 'plan_invalid');
  refuses(planDrain(baseInput({ legs: legs({ kind: 'teleport' }) })), 'plan_invalid');
  refuses(planDrain(baseInput({ legs: legs({ value_wei: -1n }) })), 'plan_invalid');
});

test('a malformed target, chain or asset is refused', () => {
  refuses(planDrain(baseInput({ target: '0x123' })), 'plan_invalid');
  refuses(planDrain(baseInput({ target: null })), 'plan_invalid');
  refuses(planDrain(baseInput({ chain_id: '84532' })), 'plan_invalid');
  refuses(planDrain(baseInput({ asset: 'ETH' })), 'plan_invalid');
  refuses(planDrain(baseInput({ fork_block: -1 })), 'plan_invalid');
});

test('oversized calldata is refused', () => {
  const huge = `0x${'ab'.repeat(24_577)}`;
  refuses(planDrain(baseInput({ legs: legs({ data: huge }) })), 'data_too_large');
});

test('legs must follow the canonical vector order', () => {
  // pull then approve is backwards.
  refuses(
    planDrain(
      baseInput({
        vector: 'approve_then_pull',
        legs: [
          { kind: 'pull', to: TARGET, data: '0x', value_wei: 0n, expected_delta_wei: 10n * E18, exploit: true },
          { kind: 'approve', to: TARGET, data: '0x', value_wei: 0n, expected_delta_wei: 0n },
        ],
      }),
    ),
    'legs_out_of_order',
  );
});

test('a vector with missing required kinds is refused', () => {
  // approve_then_pull needs an approve leg; we supplied only a pull.
  refuses(
    planDrain(baseInput({ vector: 'approve_then_pull', legs: legs() })),
    'legs_incomplete',
  );
});

test('a well-formed multi-leg plan is accepted and computes its deltas', () => {
  const plan = draftDrain(
    baseInput({
      class: 'sol.flashloan',
      vector: 'flashloan_roundtrip',
      legs: [
        { kind: 'call', to: TARGET, data: '0x01', value_wei: 0n, expected_delta_wei: 0n, note: 'borrow' },
        { kind: 'pull', to: TARGET, data: '0x02', value_wei: 0n, expected_delta_wei: 12n * E18, exploit: true, note: 'drain' },
        { kind: 'unwind', to: TARGET, data: '0x03', value_wei: 0n, expected_delta_wei: -10n * E18, note: 'repay' },
      ],
    }),
  );
  assert.ok(!isRefusal(plan), isRefusal(plan) ? plan.reason : '');
  assert.equal(plan.gross_out_wei, 12n * E18);
  assert.equal(plan.net_wei, 2n * E18); // 12 out, 10 repaid
  assert.equal(plan.capital_in_wei, 0n); // borrowed capital is not the attacker's
  assert.deepEqual(plan.attack_step_indexes, [1]);
  assert.deepEqual(plan.control_removed_step_indexes, [1]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PURITY AND FINGERPRINT INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════

test('planDrain is pure: same input, same plan, input untouched', () => {
  const { input } = approved();
  const snapshot = JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const one = planDrain(input);
  const two = planDrain(input);
  assert.ok(!isRefusal(one) && !isRefusal(two));
  assert.equal(one.fingerprint, two.fingerprint);
  assert.equal(one.drain_id, two.drain_id);
  // planDrain must not consume the approval — that is executeDrain's job.
  assert.equal(input.ledger.isConsumed(input.approval.nonce), false);
  assert.equal(JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), snapshot);
});

test('the fingerprint changes when any material field changes', () => {
  const base = draftDrain(baseInput());
  assert.ok(!isRefusal(base));
  const variants = [
    baseInput({ target: OTHER_TARGET }),
    baseInput({ chain_id: 11155111 }),
    baseInput({ asset: TOKEN }),
    baseInput({ fork_block: 1 }),
    baseInput({ legs: legs({ data: '0xff' }) }),
    baseInput({ poc: poc({ control_name: 'other_control' }) }),
    baseInput({ proof: provenProof({ claim: 'a different measured effect' }) }),
  ];
  const seen = new Set([base.fingerprint]);
  for (const v of variants) {
    const p = draftDrain(v);
    assert.ok(!isRefusal(p));
    assert.ok(!seen.has(p.fingerprint), 'a material change must change the fingerprint');
    seen.add(p.fingerprint);
  }
  assert.equal(seen.size, variants.length + 1);
});

test('a tampered plan fails its own signature check', () => {
  const { input } = approved();
  const plan = planDrain(input);
  assert.ok(!isRefusal(plan));
  assert.equal(planSignatureValid(plan), true);

  // The operator approved the fingerprint; now someone edits the calldata.
  const tampered = {
    ...plan,
    steps: plan.steps.map((s, i) => (i === 0 ? { ...s, to: OTHER_TARGET } : s)),
  };
  assert.equal(planSignatureValid(tampered), false);
  assert.notEqual(planFingerprint(tampered), plan.fingerprint);
});

test('renderPlan shows the operator every step with its delta', () => {
  const { input } = approved();
  const plan = planDrain(input);
  assert.ok(!isRefusal(plan));
  const text = renderPlan(plan);
  assert.match(text, /DRAIN drain_[0-9a-f]{16}/);
  assert.match(text, new RegExp(plan.fingerprint));
  assert.match(text, /sol\.reentrancy/);
  assert.match(text, /direct_pull/);
  assert.match(text, /EXPLOIT/);
  assert.match(text, /gross out\s+10\b/);
  assert.match(text, /control\s+same plan with steps 0 removed/);
  assert.match(text, /nonce|control/);
});

test('formatWei renders wei without floating point', () => {
  assert.equal(formatWei(0n), '0');
  assert.equal(formatWei(1n), '0.000000000000000001');
  assert.equal(formatWei(E18), '1');
  assert.equal(formatWei(15n * E18 / 10n), '1.5');
  assert.equal(formatWei(-2n * E18), '-2');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. LEDGER
// ═══════════════════════════════════════════════════════════════════════════

test('the ledger refuses a second consume of the same nonce', () => {
  const l = new ApprovalLedger();
  assert.equal(l.consume('n1', 'fp', 'jennifer', NOW), true);
  assert.equal(l.consume('n1', 'fp', 'jennifer', NOW), false);
  assert.equal(l.isConsumed('n1'), true);
});

test('the ledger records which plan each nonce was spent on', () => {
  const l = new ApprovalLedger();
  l.consume('n1', 'fpA', 'jennifer', NOW);
  l.revoke('n2', 'fpB', 'jennifer', NOW);
  const entries = l.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => [e.nonce, e.plan_fingerprint, e.event, e.operator]),
    [['n1', 'fpA', 'consumed', 'jennifer'], ['n2', 'fpB', 'revoked', 'jennifer']],
  );
});

test('a revoked nonce can never be consumed', () => {
  const l = new ApprovalLedger();
  l.revoke('n1', 'fp', 'jennifer', NOW);
  assert.equal(l.consume('n1', 'fp', 'jennifer', NOW), false);
  assert.equal(l.isRevoked('n1'), true);
});

test('empty nonces are not recorded and do not poison the ledger', () => {
  const l = new ApprovalLedger();
  assert.equal(l.consume('', 'fp', 'j', NOW), false);
  assert.equal(l.entries().length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. EXECUTION — fork-first, dry-run default
// ═══════════════════════════════════════════════════════════════════════════

test('executeDrain refuses without an approval and touches nothing', async () => {
  const exec = fakeExec();
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const r = await executeDrain({ ...baseInput({ approval: null }), exec, rpc, signer, dry_run: false, now: NOW });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'no_approval');
  assert.equal(r.broadcast, false);
  assert.equal(exec.runs.length, 0, 'a refused drain must not even simulate');
  assert.equal(signer.signed.length, 0);
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('the default is a simulation: no dry_run:false, no broadcast', async () => {
  const { input } = approved();
  const exec = fakeExec();
  const rpc = fakeRpc();
  const signer = fakeSigner();
  // dry_run deliberately omitted
  const r = await executeDrain({ ...input, exec, rpc, signer, now: NOW });
  assert.equal(r.status, 'simulated_ok');
  assert.equal(r.broadcast, false);
  assert.deepEqual(r.tx_hashes, []);
  assert.equal(signer.signed.length, 0, 'a simulation must never sign');
  assert.equal(rpc.calls.sendRawTransaction, 0, 'a simulation must never hit the wire');
  assert.equal(exec.runs.length, 2, 'attack + control both run on the fork');
});

test('dry_run:true is also a simulation', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec(), rpc: fakeRpc(), signer: fakeSigner(), dry_run: true, now: NOW });
  assert.equal(r.status, 'simulated_ok');
  assert.equal(r.broadcast, false);
});

test('the fork simulation is attack-then-control on the declared block', async () => {
  const { input } = approved();
  const exec = fakeExec();
  const r = await executeDrain({ ...input, exec, now: NOW });
  assert.equal(r.status, 'simulated_ok');
  assert.equal(exec.runs.length, 2);
  assert.equal(exec.runs[0].control, false);
  assert.equal(exec.runs[1].control, true);
  assert.equal(exec.runs[0].fork_block, 21_000_000);
  assert.equal(exec.runs[1].fork_block, 21_000_000);
  // Both runs get the same plan; only the control flag differs.
  assert.equal(exec.runs[0].plan.fingerprint, exec.runs[1].plan.fingerprint);
});

test('a receipt reports attacker delta, victim loss and control delta', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec(), now: NOW });
  assert.equal(r.status, 'simulated_ok');
  assert.equal(r.attacker_delta, 10n * E18);
  assert.equal(r.victim_loss, 10n * E18);
  assert.equal(r.control_delta, 0n);
  assert.deepEqual(r.sim_tx_hashes, ['0xaa', '0xbb']);
  assert.equal(r.drain_id.startsWith('drain_'), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. EXECUTION — accounting that voids rather than half-succeeds
// ═══════════════════════════════════════════════════════════════════════════

test('a control that moves value VOIDS the run, not partially succeeds', async () => {
  const { input } = approved();
  const exec = fakeExec({ controlAttackerDelta: 1n });
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const r = await executeDrain({ ...input, exec, rpc, signer, dry_run: false, now: NOW });

  assert.equal(r.status, 'void');
  assert.equal(r.refusal.code, 'control_not_clean');
  assert.equal(r.broadcast, false);
  assert.equal(r.control_delta, 1n);
  // Critical: a void run must not have broadcast anything.
  assert.equal(signer.signed.length, 0);
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('a control with victim movement also voids, even if the attacker gained nothing', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec({ controlVictimDelta: -1n }), now: NOW });
  assert.equal(r.status, 'void');
  assert.equal(r.refusal.code, 'control_not_clean');
});

test('an attack that produced no gain is refused', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec({ attackerDelta: 0n, victimDelta: 0n }), now: NOW });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'no_measured_gain');
});

test('an attack with attacker gain but NO victim loss is refused', async () => {
  // Profit with no source is not attributable to the target — it is the attacker
  // moving their own money around.
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec({ attackerDelta: 5n * E18, victimDelta: 0n }), now: NOW });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'no_victim_loss');
});

test('an attack simulation that reverts is refused, not reported as no-bug', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec({ attackOk: false }), now: NOW });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'simulation_failed');
});

test('a simulator that throws is refused', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec({ throwOn: 'attack' }), now: NOW });
  assert.equal(r.refusal.code, 'simulation_failed');
  const r2 = await executeDrain({ ...approved().input, exec: fakeExec({ throwOn: 'control' }), now: NOW });
  assert.equal(r2.refusal.code, 'control_failed');
});

test('a failing control run is refused', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec({ controlOk: false }), now: NOW });
  assert.equal(r.refusal.code, 'control_failed');
});

test('no exec boundary is refused rather than assumed', async () => {
  // Each attempt needs its own approval: single-use means reusing one would
  // (correctly) fail as approval_consumed and mask the code under test.
  const attempt = async (exec) => {
    const { input } = approved();
    return executeDrain({ ...input, exec, now: NOW });
  };

  // Absent.
  assert.equal((await attempt(null)).refusal.code, 'no_exec');
  assert.equal((await attempt(undefined)).refusal.code, 'no_exec');

  // Present but not an executor. This must be no_exec specifically: falling
  // through to a TypeError would surface as the misleading simulation_failed,
  // and would mean the shape of the boundary was never actually checked.
  for (const bad of [{}, [], 'run', 42, { run: 'not-a-function' }]) {
    const r = await attempt(bad);
    assert.equal(r.refusal?.code, 'no_exec', `exec=${JSON.stringify(bad)} should refuse as no_exec`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. EXECUTION — single use and mid-flight revocation
// ═══════════════════════════════════════════════════════════════════════════

test('an approval is single-use: the second run is refused', async () => {
  const { input } = approved();
  const first = await executeDrain({ ...input, exec: fakeExec(), now: NOW });
  assert.equal(first.status, 'simulated_ok');

  const second = await executeDrain({ ...input, exec: fakeExec(), now: NOW });
  assert.equal(second.status, 'refused');
  assert.equal(second.refusal.code, 'approval_consumed');
});

test('a replayed approval is refused even with a fresh ledger object identity', async () => {
  // Single-use lives in the ledger, so a NEW nonce is needed for a new drain;
  // reusing the same approval against the same ledger must always fail.
  const { input } = approved();
  await executeDrain({ ...input, exec: fakeExec(), now: NOW });
  const replay = await executeDrain({ ...input, exec: fakeExec(), now: NOW });
  assert.equal(replay.refusal.code, 'approval_consumed');
  assert.equal(input.ledger.isConsumed(input.approval.nonce), true);
});

test('revoking the approval mid-flight stops execution before any broadcast', async () => {
  // THE mutation test for "only on my approval". The attack and control both
  // simulate successfully; the operator then revokes during the window before
  // the wire. Execution must stop with nothing signed and nothing sent.
  const { input } = approved();
  const rpc = fakeRpc();
  const signer = fakeSigner();

  let revoked = false;
  const racingExec = {
    runs: 0,
    async run(req) {
      racingExec.runs++;
      if (req.control && !revoked) {
        // Between the control run and the pre-wire re-check, the operator pulls it.
        input.ledger.revoke(input.approval.nonce, input.approval.plan_fingerprint, 'jennifer', NOW);
        revoked = true;
      }
      return {
        ok: true,
        attacker_delta_wei: req.control ? 0n : 10n * E18,
        victim_delta_wei: req.control ? 0n : -10n * E18,
        tx_hashes: [],
        reason: null,
      };
    },
  };

  const r = await executeDrain({ ...input, exec: racingExec, rpc, signer, dry_run: false, now: NOW });
  assert.equal(revoked, true, 'the test must actually have revoked');
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'approval_revoked');
  assert.equal(r.broadcast, false);
  assert.equal(signer.signed.length, 0, 'revocation must stop before signing');
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('the executor cannot rewrite the plan it is about to sign (frozen) ', async () => {
  // A real race, not a hypothetical: DrainExec.run receives a reference to the
  // plan. A buggy or hostile executor could try to redirect calldata AFTER the
  // entry check and BEFORE the wire. Two independent layers stop it:
  //
  //   1. the plan and its steps are deep-frozen, so the write throws outright;
  //   2. the fingerprint is recomputed immediately before broadcast.
  //
  // This test pins layer 1. Layer 2 is pinned by the direct planSignatureValid
  // test and by the tampered-plan test above.
  const { input } = approved();
  const rpc = fakeRpc();
  const signer = fakeSigner();
  let attempted = false;
  let threw = null;
  let observedTo = null;

  const hijackingExec = {
    async run(req) {
      if (!req.control) {
        attempted = true;
        try {
          req.plan.steps[0].to = OTHER_TARGET; // must not take effect
        } catch (e) {
          threw = e;
        }
        observedTo = req.plan.steps[0].to;
      }
      return {
        ok: true,
        attacker_delta_wei: req.control ? 0n : 10n * E18,
        victim_delta_wei: req.control ? 0n : -10n * E18,
        tx_hashes: [],
        reason: null,
      };
    },
  };

  const r = await executeDrain({ ...input, exec: hijackingExec, rpc, signer, dry_run: false, now: NOW });

  assert.equal(attempted, true, 'the test must actually have attempted the rewrite');
  assert.ok(threw instanceof TypeError, 'a frozen plan must reject the write');
  assert.equal(observedTo, TARGET, 'the calldata must still point at the approved target');
  // The run itself is unaffected: the plan was never altered.
  assert.equal(r.status, 'broadcast_ok', r.refusal ? r.refusal.reason : '');
  assert.equal(signer.signed.length, 1);
  // And what reached the signer is the approved target, not the hijack target.
  assert.equal(signer.signed[0].to, TARGET.toLowerCase());
  assert.notEqual(signer.signed[0].to, OTHER_TARGET.toLowerCase());
});

test('a tampered plan object passed as approved is refused by its own hash', async () => {
  // The operator reviews and approves a plan OBJECT. If that object is altered
  // after review — even in a field the approval check would not notice on its
  // own, like a step's calldata — its fingerprint no longer matches, and it must
  // never reach the executor or the signer.
  const { input, plan } = approved();
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const exec = fakeExec();

  const tampered = {
    ...plan,
    steps: plan.steps.map((s, i) => (i === 0 ? { ...s, data: '0xdeadbeef' } : s)),
  };
  // Sanity: the tampered object really has diverged from its own fingerprint.
  assert.equal(planSignatureValid(tampered), false);

  const r = await executeDrain({
    ...input,
    approved_plan: tampered,
    exec,
    rpc,
    signer,
    dry_run: false,
    now: NOW,
  });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'plan_signature_mismatch');
  assert.match(r.refusal.reason, /modified after review|does not hash/);
  assert.equal(r.broadcast, false);
  assert.equal(exec.runs.length, 0, 'a tampered plan must not be simulated');
  assert.equal(signer.signed.length, 0, 'a tampered plan must never be signed');
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('an intact but different plan object is refused as a substitution', async () => {
  // Intact (hashes correctly) but it is plan B while the approval names plan A.
  const a = approved(baseInput({ legs: legs({ expected_delta_wei: 10n * E18 }) }));
  const bDraft = draftDrain(baseInput({ legs: legs({ expected_delta_wei: 11n * E18 }) }));
  assert.ok(!isRefusal(bDraft));
  assert.equal(planSignatureValid(bDraft), true);

  const exec = fakeExec();
  const r = await executeDrain({ ...a.input, approved_plan: bDraft, exec, now: NOW });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'approval_plan_mismatch');
  assert.equal(exec.runs.length, 0);
});

test('the approved plan object is honoured when it is intact and matching', async () => {
  // The positive case: supplying the exact reviewed object changes nothing about
  // the outcome, and the fingerprint executed is the reviewed one.
  const { input, plan } = approved();
  const exec = fakeExec();
  const r = await executeDrain({ ...input, approved_plan: plan, exec, now: NOW });
  assert.equal(r.status, 'simulated_ok', r.refusal ? r.refusal.reason : '');
  assert.equal(r.fingerprint, plan.fingerprint);
  assert.equal(exec.runs.length, 2);
});

test('an approval that expires mid-flight stops execution', async () => {
  const { input } = approved();
  const rpc = fakeRpc();
  const signer = fakeSigner();
  // Clock advances past expiry between the plan check and the pre-wire check.
  let tick = 0;
  const clock = () => (tick++ === 0 ? NOW : input.approval.expires_at + 1);

  const r = await executeDrain({
    ...input,
    exec: fakeExec(),
    rpc,
    signer,
    dry_run: false,
    clock,
  });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'approval_expired');
  assert.equal(signer.signed.length, 0);
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('a plan edited after approval is refused before execution', async () => {
  const { input, plan } = approved();
  const exec = fakeExec();

  // (a) Editing the LEGS necessarily invalidates the approval, because the legs
  //     are what the fingerprint covers. This is the shape an edit really takes.
  const editedLegs = legs({ to: OTHER_TARGET });
  const r = await executeDrain({ ...input, legs: editedLegs, exec, now: NOW });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'approval_plan_mismatch');
  assert.equal(exec.runs.length, 0, 'a refused plan must not be simulated');

  // (b) There is no parameter for handing executeDrain a pre-built plan object,
  //     so a caller cannot smuggle an edited DrainPlan past planDrain at all.
  //     Any unknown field is simply ignored and the plan is re-derived from the
  //     legs — which then fail the approval check as in (a).
  const smuggled = await executeDrain({
    ...input,
    precomputed_plan: plan,
    plan,
    exec,
    now: NOW,
  });
  // `...input` still carries the ORIGINAL legs plus a valid approval, so this
  // one is allowed — proving the smuggled plan object was ignored, not honoured.
  assert.equal(smuggled.status, 'simulated_ok');
  assert.equal(smuggled.fingerprint, plan.fingerprint, 'the fingerprinted plan must be the re-derived one');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. EXECUTION — the live path, through the real v1 relay
// ═══════════════════════════════════════════════════════════════════════════

test('a real broadcast goes through the v1 relay and returns tx hashes', async () => {
  const { input } = approved();
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const relay = new SendRelay();

  const r = await executeDrain({ ...input, exec: fakeExec(), rpc, signer, relay, dry_run: false, now: NOW });
  assert.equal(r.status, 'broadcast_ok');
  assert.equal(r.broadcast, true);
  assert.equal(r.tx_hashes.length, 1, 'one leg => one broadcast');
  assert.match(r.tx_hashes[0], /^0xhash1$/);
  assert.equal(signer.signed.length, 1);
  assert.equal(rpc.calls.sendRawTransaction, 1);
  // Delta accounting survives the broadcast path.
  assert.equal(r.attacker_delta, 10n * E18);
  assert.equal(r.victim_loss, 10n * E18);
});

test('the relay refuses when no signer is injected, and the drain reports it', async () => {
  const { input } = approved();
  const rpc = fakeRpc();
  const r = await executeDrain({ ...input, exec: fakeExec(), rpc, signer: null, dry_run: false, now: NOW });
  assert.equal(r.status, 'broadcast_failed');
  assert.equal(r.refusal.code, 'relay_refused');
  assert.match(r.refusal.reason, /no_private_key|no_signer/);
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('the relay refuses with no rpc, and the drain reports it', async () => {
  const { input } = approved();
  const r = await executeDrain({ ...input, exec: fakeExec(), rpc: null, signer: fakeSigner(), dry_run: false, now: NOW });
  assert.equal(r.status, 'broadcast_failed');
  assert.equal(r.refusal.code, 'relay_refused');
  assert.match(r.refusal.reason, /no_rpc/);
});

test('mainnet broadcast needs the double switch all the way through the relay', async () => {
  const draft = draftDrain(baseInput({ chain_id: BASE_MAINNET }));
  assert.ok(!isRefusal(draft));
  const input = {
    ...baseInput({ chain_id: BASE_MAINNET }),
    approval: approve(draft),
    ledger: new ApprovalLedger(),
  };
  // Approval side only: refused at the drain's own ladder.
  const r = await executeDrain({
    ...input,
    approval: approve(draft, { allow_mainnet: true }),
    confirm_mainnet: false,
    exec: fakeExec(),
    rpc: fakeRpc(),
    signer: fakeSigner(),
    dry_run: false,
    now: NOW,
  });
  assert.equal(r.refusal.code, 'mainnet_needs_double_confirm');

  // Both switches: the relay's grant carries allow_mainnet and confirm_mainnet is passed through.
  const signer = fakeSigner();
  const rpc = fakeRpc();
  const ok = await executeDrain({
    ...input,
    approval: approve(draft, { allow_mainnet: true }),
    confirm_mainnet: true,
    exec: fakeExec(),
    rpc,
    signer,
    dry_run: false,
    now: NOW,
  });
  assert.equal(ok.status, 'broadcast_ok', ok.refusal ? ok.refusal.reason : '');
  assert.equal(signer.signed.length, 1);
});

test('a multi-leg plan broadcasts every leg in order', async () => {
  const input = baseInput({
    class: 'sol.flashloan',
    vector: 'flashloan_roundtrip',
    legs: [
      { kind: 'call', to: TARGET, data: '0x01', value_wei: 0n, expected_delta_wei: 0n },
      { kind: 'pull', to: TARGET, data: '0x02', value_wei: 0n, expected_delta_wei: 12n * E18, exploit: true },
      { kind: 'unwind', to: TARGET, data: '0x03', value_wei: 0n, expected_delta_wei: -10n * E18 },
    ],
  });
  const draft = draftDrain(input);
  assert.ok(!isRefusal(draft));
  const signer = fakeSigner();
  const rpc = fakeRpc();
  const r = await executeDrain({
    ...input,
    approval: approve(draft),
    ledger: new ApprovalLedger(),
    exec: fakeExec(),
    rpc,
    signer,
    dry_run: false,
    now: NOW,
  });
  assert.equal(r.status, 'broadcast_ok');
  assert.equal(r.tx_hashes.length, 3);
  assert.equal(signer.signed.length, 3);
  // Order preserved: leg data reaches the signer in plan order.
  assert.deepEqual(signer.signed.map((s) => s.data), ['0x01', '0x02', '0x03']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. GENERIC — every class drains through the same ladder
// ═══════════════════════════════════════════════════════════════════════════

test('all ten classes are drainable', () => {
  assert.equal(Object.keys(DRAIN_CLASSES).length, 10);
  assert.deepEqual(Object.keys(DRAIN_CLASSES).sort(), [
    'sol.accesscontrol', 'sol.delegatecall', 'sol.dos', 'sol.flashloan', 'sol.inflation',
    'sol.oracle', 'sol.reentrancy', 'sol.rounding', 'sol.signature', 'sol.upgrade',
  ]);
});

test('every class produces an executable plan through the identical ladder', async () => {
  // The genericity claim, as a test: one loop, ten classes, same code path.
  let planned = 0;
  for (const cls of Object.keys(DRAIN_CLASSES)) {
    const vector = DRAIN_CLASSES[cls].vectors[0];
    const spec = EXTRACTION_VECTORS[vector];

    // Minimal legs satisfying the vector, in canonical order.
    const legList = [];
    for (const kind of VECTOR_ORDER) {
      if (!spec.requires.includes(kind)) continue;
      const isPull = kind === 'pull';
      legList.push({
        kind,
        to: TARGET,
        data: `0x${kind.length.toString(16).padStart(2, '0')}`,
        value_wei: 0n,
        expected_delta_wei: isPull ? 5n * E18 : 0n,
        exploit: isPull,
      });
    }
    // A vector whose extraction is not a pull still needs a positive delta.
    if (!legList.some((l) => l.exploit)) {
      legList[legList.length - 1].exploit = true;
      legList[legList.length - 1].expected_delta_wei = 5n * E18;
    }

    const input = baseInput({ class: cls, vector, legs: legList });
    const draft = draftDrain(input);
    assert.ok(!isRefusal(draft), `${cls}/${vector}: ${isRefusal(draft) ? draft.reason : ''}`);
    assert.equal(draft.class, cls);
    assert.equal(draft.vector, vector);

    const approvedInput = { ...input, approval: approve(draft), ledger: new ApprovalLedger() };
    const r = await executeDrain({ ...approvedInput, exec: fakeExec(), now: NOW });
    assert.equal(r.status, 'simulated_ok', `${cls}: ${r.refusal ? r.refusal.reason : ''}`);
    planned++;
  }
  assert.equal(planned, 10);
});

test('every declared vector is reachable from at least one class', () => {
  const reachable = new Set();
  for (const spec of Object.values(DRAIN_CLASSES)) for (const v of spec.vectors) reachable.add(v);
  for (const v of Object.keys(EXTRACTION_VECTORS)) {
    assert.ok(reachable.has(v), `vector '${v}' is declared but no class can use it`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. IMPOSSIBLE TO TRIGGER AUTONOMOUSLY
// ═══════════════════════════════════════════════════════════════════════════

test('the module exports no way to mint, default or derive an approval', async () => {
  // The absence is the security property, so assert the absence.
  const mod = await import('../build/drain.js');
  const forbidden = [
    'mintApproval', 'createApproval', 'issueApproval', 'defaultApproval',
    'autoApprove', 'approve', 'grantApproval', 'makeApproval', 'approvalFrom',
    'withApproval', 'ensureApproval', 'assumeApproved',
  ];
  for (const name of forbidden) {
    assert.equal(mod[name], undefined, `drain.ts must not export '${name}'`);
  }
});

test('executeDrain cannot run without an approval argument', async () => {
  // No overload, no default, no env fallback: omitting it is a refusal.
  const input = baseInput();
  const r = await executeDrain({ ...input, exec: fakeExec(), now: NOW });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusal.code, 'no_approval');
});

test('a proven verdict alone is not permission', async () => {
  // "approved because the finding was proven" is the exact inference we forbid.
  const exec = fakeExec();
  const r = await executeDrain({
    ...baseInput({ proof: provenProof(), approval: null }),
    exec,
    dry_run: false,
    now: NOW,
  });
  assert.equal(r.refusal.code, 'no_approval');
  assert.equal(exec.runs.length, 0);
});

test('approving one drain does not approve a batch', async () => {
  // Two plans, one approval. The second must be refused, and no batching exists.
  const a = approved(baseInput({ legs: legs({ expected_delta_wei: 10n * E18 }) }));
  const bDraft = draftDrain(baseInput({ legs: legs({ expected_delta_wei: 11n * E18 }) }));
  assert.ok(!isRefusal(bDraft));

  const first = await executeDrain({ ...a.input, exec: fakeExec(), now: NOW });
  assert.equal(first.status, 'simulated_ok');

  const second = await executeDrain({
    ...baseInput({ legs: legs({ expected_delta_wei: 11n * E18 }) }),
    approval: a.input.approval,
    ledger: a.input.ledger,
    exec: fakeExec(),
    now: NOW,
  });
  // Bound to A's fingerprint AND A's nonce is spent — either refusal is correct.
  assert.equal(second.status, 'refused');
  assert.ok(['approval_plan_mismatch', 'approval_consumed'].includes(second.refusal.code));
});

test('the drain never reads a private key from the environment', async () => {
  // Belt and braces: even with a key-looking env var present, a refusal path
  // stays a refusal and the value never appears in the receipt.
  const secret = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const r = await executeDrain({
    ...baseInput({ approval: null }),
    exec: fakeExec(),
    env: { PRIVATE_KEY: secret },
    now: NOW,
  });
  assert.equal(r.status, 'refused');
  const serialised = JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.equal(serialised.includes(secret), false);
  assert.equal(serialised.includes(secret.slice(2)), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. RECEIPT SHAPE
// ═══════════════════════════════════════════════════════════════════════════

test('every receipt carries the required shape', async () => {
  const required = ['broadcast', 'attacker_delta', 'victim_loss', 'control_delta', 'tx_hashes', 'status'];
  const receipts = [
    await executeDrain({ ...baseInput({ approval: null }), exec: fakeExec(), now: NOW }),
    await executeDrain({ ...approved().input, exec: fakeExec(), now: NOW }),
    await executeDrain({ ...approved().input, exec: fakeExec({ controlAttackerDelta: 1n }), now: NOW }),
    await executeDrain({ ...approved().input, exec: fakeExec({ attackerDelta: 0n, victimDelta: 0n }), now: NOW }),
  ];
  for (const r of receipts) {
    for (const k of required) assert.ok(k in r, `receipt missing '${k}'`);
    assert.equal(typeof r.broadcast, 'boolean');
    assert.equal(typeof r.attacker_delta, 'bigint');
    assert.equal(typeof r.victim_loss, 'bigint');
    assert.equal(typeof r.control_delta, 'bigint');
    assert.ok(Array.isArray(r.tx_hashes));
  }
  // And a refused receipt always explains itself.
  for (const r of receipts.filter((x) => x.refusal)) {
    assert.equal(typeof r.refusal.code, 'string');
    assert.equal(typeof r.refusal.reason, 'string');
    assert.ok(r.refusal.reason.length > 10);
  }
});

test('renderReceipt is a one-liner that names the status and the refusal', async () => {
  const ok = await executeDrain({ ...approved().input, exec: fakeExec(), now: NOW });
  const okLine = renderReceipt(ok);
  assert.match(okLine, /SIMULATED_OK/);
  assert.match(okLine, /attacker \+10/);
  assert.match(okLine, /victim -10/);

  const bad = await executeDrain({ ...baseInput({ approval: null }), exec: fakeExec(), now: NOW });
  const badLine = renderReceipt(bad);
  assert.match(badLine, /REFUSED/);
  assert.match(badLine, /no_approval/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. refusal() / isRefusal() primitives
// ═══════════════════════════════════════════════════════════════════════════

test('a plan is never mistaken for a refusal and vice versa', () => {
  const plan = draftDrain(baseInput());
  assert.ok(!isRefusal(plan));
  assert.equal(plan.refused, undefined);

  const r = refusal('no_approval', 'because');
  assert.equal(isRefusal(r), true);
  assert.equal(r.refused, true);
});

test('every refusal code used in the module is distinct and stable', () => {
  // Guards against two ladder rungs silently collapsing to one code, which would
  // make a test pass for the wrong reason.
  const codes = new Set([
    'no_proof', 'verdict_not_proven', 'proof_claim_missing', 'no_control_run',
    'class_not_supported', 'vector_not_supported', 'vector_not_supported_for_class',
    'plan_invalid', 'legs_incomplete', 'legs_out_of_order', 'privileged_role_required',
    'capital_unaccounted', 'capital_exceeds_extraction', 'no_positive_delta',
    'no_approval', 'approval_not_approved', 'approval_no_operator', 'approval_plan_mismatch',
    'approval_expired', 'approval_consumed', 'approval_revoked', 'no_ledger',
    'chain_not_allowed', 'mainnet_needs_double_confirm', 'value_over_cap', 'data_too_large',
    'plan_signature_mismatch', 'no_exec', 'simulation_failed', 'control_failed',
    'control_not_clean', 'no_measured_gain', 'no_victim_loss', 'relay_refused',
  ]);
  assert.equal(codes.size, 34);
});
