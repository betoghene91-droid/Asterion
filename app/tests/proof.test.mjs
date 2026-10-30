// V2 proof-contract tests. Run with: node --test
//
// A bug here means the bot reports something that is not real. That is the one
// failure this project cannot survive, so these tests are exhaustive about the
// ways a proof can be fake.

import test from 'node:test';
import assert from 'node:assert/strict';

import { judge, looksLikeInfraFailure, sawRealAssertion, renderVerdict } from '../build/proof.js';
import { rank, planAttempts, adjudicate, briefLead } from '../build/hunt.js';
import { synthesize, HARNESSED } from '../build/poc.js';

const run = (exit_code, output, extra = {}) => ({
  exit_code,
  output,
  failure_reason: null,
  duration_ms: 1200,
  ...extra,
});

const FAIL = run(1, '[FAIL. Reason: REENTRANCY: attacker extracted more than supplied]');
const PASS = run(0, '[PASS] test_reentrancy_5() (gas: 120000)');
const COMPILE = run(1, 'Error: Compiler run failed: expected `;` but got `}`');
const RPC = run(1, 'Error: could not connect to RPC: connection refused');

const impact = (before, after) => ({
  kind: 'value_transfer',
  description: 'attacker withdrew more than deposited',
  measured: { before, after },
});

// ── condition 1: did it run at all ──────────────────────────────────────

test('a passing test means the bug is NOT there', () => {
  const r = judge({ hypothesis_id: 'h', commit: 'c', test_name: 't', reproduced: PASS });
  assert.equal(r.verdict, 'disproved');
  assert.equal(r.claim, null);
});

test('a compile failure is inconclusive, never a finding', () => {
  const r = judge({ hypothesis_id: 'h', commit: 'c', test_name: 't', reproduced: COMPILE });
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.reasons[0], /build|environment/);
});

test('an RPC failure is inconclusive, never a finding', () => {
  const r = judge({ hypothesis_id: 'h', commit: 'c', test_name: 't', reproduced: RPC });
  assert.equal(r.verdict, 'inconclusive');
});

test('a non-zero exit with no assertion is inconclusive', () => {
  const r = judge({ hypothesis_id: 'h', commit: 'c', test_name: 't', reproduced: run(1, 'Killed') });
  assert.equal(r.verdict, 'inconclusive');
});

test('infra failure detection is specific', () => {
  assert.equal(looksLikeInfraFailure('Error: Compiler run failed'), true);
  assert.equal(looksLikeInfraFailure('no test match for filter'), true);
  assert.equal(looksLikeInfraFailure('[FAIL. Reason: assertion failed]'), false);
});

test('real assertion detection is specific', () => {
  assert.equal(sawRealAssertion('[FAIL. Reason: x]'), true);
  assert.equal(sawRealAssertion('EvmError: Revert'), true);
  assert.equal(sawRealAssertion('Compiling 40 files'), false);
});

// ── condition 2: causality ─────────────────────────────────────────────

test('reproduced but no counterfactual is only partial', () => {
  const r = judge({ hypothesis_id: 'h', commit: 'c', test_name: 't', reproduced: FAIL, impact: impact('1', '2') });
  assert.equal(r.verdict, 'partial');
  assert.equal(r.claim, null);
  assert.ok(r.reasons.some((x) => /counterfactual/.test(x)));
});

test('a with-fix run that still fails disproves the causal claim', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL, with_fix: FAIL, impact: impact('1', '2'),
  });
  assert.equal(r.verdict, 'partial');
  assert.equal(r.claim, null);
});

test('a with-fix compile failure cannot confirm causality', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL, with_fix: COMPILE, impact: impact('1', '2'),
  });
  assert.equal(r.verdict, 'partial');
});

test('removing the precondition that makes the test pass confirms mechanism', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL, without_precondition: PASS, impact: impact('100', '0'),
  });
  assert.equal(r.verdict, 'proven');
});

// ── condition 3: impact ────────────────────────────────────────────────

test('causal but unmeasured impact stays partial', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't', reproduced: FAIL, with_fix: PASS,
  });
  assert.equal(r.verdict, 'partial');
  assert.match(r.reasons.at(-1), /no impact/i);
});

test('identical before/after is no effect', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL, with_fix: PASS, impact: impact('100', '100'),
  });
  assert.equal(r.verdict, 'partial');
});

test('empty measured values are rejected', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL, with_fix: PASS, impact: impact('', '5'),
  });
  assert.equal(r.verdict, 'partial');
});

test('all three conditions met is proven with a claim', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL, with_fix: PASS, impact: impact('1 ether', '3 ether'),
  });
  assert.equal(r.verdict, 'proven');
  assert.equal(r.confidence, 'confirmed');
  assert.ok(r.claim && r.claim.length > 10);
});

test('verdict rendering marks each state distinctly', () => {
  assert.match(renderVerdict({ verdict: 'proven', confidence: 'confirmed', reasons: ['x'], claim: 'c' }), /\u2713/);
  assert.match(renderVerdict({ verdict: 'disproved', confidence: 'tentative', reasons: ['x'], claim: null }), /\u2717/);
});

// ── ranking ────────────────────────────────────────────────────────────

const digest = {
  version: '1',
  source_rows: 100,
  generated_at: 't',
  lexicon: {},
  classes: {
    'sol.inflation': { n: 4512, severe: 4512, critical: 900, high: 2000, medium: 1600, recent: 2750, weight: 1.25, validatable: true },
    'sol.reentrancy': { n: 810, severe: 810, critical: 400, high: 300, medium: 110, recent: 292, weight: 1.0, validatable: true },
    'sol.signature': { n: 1020, severe: 1020, critical: 300, high: 400, medium: 320, recent: 609, weight: 0.85, validatable: true },
    'web.idor': { n: 0, severe: 0, critical: 0, high: 0, medium: 0, recent: 0, weight: 0, validatable: false },
  },
  precedent: {
    'sol.inflation': [
      { id: '1', project: 'Watt', firm: 'Ackee', year: 2025, severity: 'critical', leaf: 'logic_accounting.balance_shares', title: 'Unstake allows full withdrawal while keeping position', signal: 'Unstake allows full withdrawal while keeping position  [balance shares]' },
    ],
    'sol.reentrancy': [],
    'sol.signature': [],
    'web.idor': [],
  },
};

test('ranking puts harnessed playbooks first', () => {
  const r = rank(['web.idor', 'sol.inflation', 'sol.reentrancy'], digest);
  assert.ok(r.every((x) => x.harnessed || x.id === 'web.idor'));
  assert.equal(r.at(-1).id, 'web.idor');
});

test('a playbook with no corpus support is marked unknown', () => {
  const r = rank(['web.idor'], digest);
  assert.equal(r[0].verdict, 'unknown');
  assert.match(r[0].reason, /no ground truth/);
});

test('ranking is order-stable for equal prior', () => {
  const a = rank(['sol.reentrancy', 'sol.signature'], digest).map((x) => x.id);
  const b = rank(['sol.reentrancy', 'sol.signature'], digest).map((x) => x.id);
  assert.deepEqual(a, b);
});

test('no digest means everything is unknown, not errored', () => {
  const r = rank(['sol.inflation'], null);
  assert.equal(r[0].verdict, 'unknown');
});

// ── PoC synthesis ──────────────────────────────────────────────────────

const lead = (playbook) => ({ playbook, file: 'Vault.sol', line: 42, snippet: 'x', severity: 'high' });

test('every harnessed class produces a compilable-looking test', () => {
  for (const pb of HARNESSED) {
    const spec = synthesize(lead(pb), { contract: 'Vault', forkBlock: 30000000 });
    assert.ok(spec, `${pb} should synthesize`);
    assert.match(spec.solidity, /pragma solidity/);
    assert.match(spec.solidity, /function test_/);
    assert.match(spec.solidity, /createSelectFork/);
    assert.ok(spec.claim.description.length > 10);
    assert.ok(spec.requires.length >= 2);
    // Every spec must ship a paired control: without it, causality is unprovable.
    assert.ok(spec.control_name.endsWith('_control'), `${pb} has no control test`);
    assert.ok(spec.solidity.includes(`function ${spec.control_name}() public`), `${pb} control body missing`);
  }
});

test('an unharnessed class returns null rather than a guess', () => {
  // sol.signature USED to be the example here: it was dispatchable, ran for
  // minutes, and could never produce a finding because it had no harness. It
  // now has one (see HARNESSED). The assertion's intent is unchanged - a class
  // with no harness must synthesise nothing rather than guess - so the example
  // moves to classes that still have no harness.
  assert.equal(synthesize(lead('web.idor'), { contract: 'V', forkBlock: 1 }), null);
  assert.equal(synthesize(lead('sol.svm-signer'), { contract: 'V', forkBlock: 1 }), null);
  // And the class that used to be the example is now genuinely harnessed.
  assert.ok(synthesize(lead('sol.signature'), { contract: 'V', forkBlock: 1 }));
});

test('generated tests assert a measured effect, never the vulnerability', () => {
  const spec = synthesize(lead('sol.reentrancy'), { contract: 'Vault', forkBlock: 1 });
  // assertions must compare numbers or outcomes, not claim "vulnerable"
  assert.match(spec.solidity, /assert(Lt|Le|True|False|NotEq|Eq)\(/);
  assert.doesNotMatch(spec.solidity, /assertTrue\(true/);
});

test('planAttempts skips unprovable leads and reports them', () => {
  // Same intent: a lead whose class has no harness is SKIPPED and REPORTED, never
  // silently dropped. sol.signature is harnessed now, so an svm class - which has
  // no EVM plane and no harness - takes its place as the unprovable example.
  const leads = [lead('sol.reentrancy'), lead('sol.svm-signer'), lead('sol.oracle')];
  const { attempts, unprovable } = planAttempts(leads, { contract: 'Vault', forkBlock: 1 });
  assert.equal(attempts.length, 2);
  assert.equal(unprovable.length, 1);
  assert.equal(unprovable[0].playbook, 'sol.svm-signer');
});

test('planAttempts dedupes per class and file', () => {
  const leads = [lead('sol.reentrancy'), lead('sol.reentrancy'), lead('sol.reentrancy')];
  const { attempts } = planAttempts(leads, { contract: 'Vault', forkBlock: 1 });
  assert.equal(attempts.length, 1);
});

// ── adjudication: silence is a valid outcome ───────────────────────────

const huntBase = () => ({
  hunt_id: 'h1', program_id: 'ex', targets: ['x'], stage: 'attempt',
  ranked: [], leads: [lead('sol.reentrancy')],
  pocs: [{ lead: lead('sol.reentrancy'), spec: synthesize(lead('sol.reentrancy'), { contract: 'V', forkBlock: 1 }) }],
  results: [], stopped_because: null,
});

test('a missing proof bundle is inconclusive, never proven', () => {
  const h = adjudicate(huntBase(), []);
  assert.equal(h.results[0].result.verdict, 'inconclusive');
  assert.ok(h.stopped_because);
});

test('a null result records why, it does not claim success', () => {
  const h = huntBase();
  const name = h.pocs[0].spec.test_name;
  const out = adjudicate(h, [{ hypothesis_id: name, commit: 'c', test_name: name, reproduced: PASS }]);
  assert.equal(out.results[0].result.verdict, 'disproved');
  assert.ok(out.stopped_because && /disproved|inconclusive/.test(out.stopped_because));
});

test('briefLead attaches real precedent, not a generic hint', () => {
  const b = briefLead(lead('sol.inflation'), digest, 'unstake withdraw shares');
  assert.match(b, /PRECEDENT/);
  assert.match(b, /Watt/);
});

test('briefLead works with no corpus at all', () => {
  const b = briefLead(lead('sol.reentrancy'), null, 'call');
  assert.match(b, /PLAYBOOK/);
  assert.doesNotMatch(b, /PRECEDENT/);
});

// ── the control pair is what makes causality provable ──────────────────

test('attack fails + control passes + measured impact = proven', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL,
    without_precondition: PASS, // the control passing is the counterfactual
    impact: impact('100 ether', '97 ether'),
  });
  assert.equal(r.verdict, 'proven');
  assert.ok(r.claim);
});

test('attack fails but control ALSO fails is only partial', () => {
  const r = judge({
    hypothesis_id: 'h', commit: 'c', test_name: 't',
    reproduced: FAIL,
    without_precondition: FAIL, // fixture broken: the attack proves nothing
    impact: impact('100', '0'),
  });
  assert.equal(r.verdict, 'partial');
  assert.equal(r.claim, null);
  assert.ok(r.reasons.some((x) => /mechanism|precondition/.test(x)));
});
