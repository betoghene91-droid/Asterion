/**
 * Ranking by expected value, not by TVL.
 *
 * THE GATE THIS FILE EXISTS FOR: an automation-allowed candidate must outrank a
 * HIGHER-TVL automation-prohibited one. That single test is the whole thesis —
 * if it fails, the ranking is still a TVL ranking with extra columns.
 *
 * The other tests pin the parts that are easy to get wrong in the honest
 * direction: an unmeasured payout cap is 0 and says so, an unmeasured class weight
 * is 0 rather than an invented number, a zero is a refusal with a name rather than
 * a small number, and a tie breaks deterministically so two runs over the same
 * input produce the same list.
 *
 * THE PLACEHOLDER IS ASSERTED AS A PLACEHOLDER. `TIME_TO_PROOF_IS_PLACEHOLDER` is
 * checked here so that when Task 5 produces real time-to-proof data, deleting the
 * constant fails a test instead of silently pretending the number was measured.
 *
 * Run with: node --test tests/targets-ev.test.mjs   (after `npm run build`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COVERAGE_GAP_COVERED,
  COVERAGE_GAP_UNCOVERED,
  RANKING_IS_NOT_AUTHORIZATION,
  TIME_TO_PROOF_IS_PLACEHOLDER,
  TIME_TO_PROOF_PLACEHOLDER_HOURS,
  classWeightSum,
  rankByExpectedValue,
  rankedForDispatch,
  scoreCandidate,
} from '../build/targets/ev.js';
import { candidateRecord, dispatchable, evInputFrom, scoreRecord } from '../build/targets/candidate.js';
import {
  CURATOR_METHODOLOGY_HOOKS,
  NO_PLAYBOOK_YET_REASON,
  RISK_CURATOR_CLASS,
  curatorClassIsDispatchable,
  isCuratorBrief,
  refuseCuratorDispatch,
} from '../build/targets/curator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');

const allowed = { automation_allowed: true, cls: 'allowed', reason: 'affirmative' };
const prohibited = { automation_allowed: false, cls: 'prohibited', reason: 'scanners-barred' };
const unknown = { automation_allowed: false, cls: 'unknown', reason: 'field-null' };

/** A minimally complete candidate. Override what the test is about. */
function cand(over = {}) {
  return {
    id: 'x',
    name: 'X',
    payout_cap_usd: 100_000,
    automation: allowed,
    has_programme: true,
    class_weights: { 'sol.reentrancy': 1.0 },
    tvl_usd: 1_000_000_000,
    has_fork_target: true,
    ...over,
  };
}

// ── THE GATE ────────────────────────────────────────────────────────────────

test('EV ranking puts an automation-allowed candidate above a higher-TVL automation-prohibited one', () => {
  const small_allowed = cand({
    id: 'evm:1:0xaaa',
    name: 'Allowed $200M TVL',
    payout_cap_usd: 50_000,
    tvl_usd: 200_000_000,
    automation: allowed,
  });
  const huge_prohibited = cand({
    id: 'evm:1:0xbbb',
    name: 'Prohibited $14.6B TVL',
    payout_cap_usd: 2_000_000,
    tvl_usd: 14_639_478_459,
    automation: prohibited,
  });

  const ranked = rankByExpectedValue([huge_prohibited, small_allowed]);

  assert.equal(ranked[0].id, 'evm:1:0xaaa', 'the automation-allowed candidate must be first');
  assert.ok(ranked[0].ev > 0);
  assert.equal(ranked[1].ev, 0, 'the prohibited one scores zero, not "less"');
  assert.equal(ranked[1].zero_reason, 'automation_prohibited');
  // The ranking is not TVL: the loser is 73x larger by TVL.
  assert.ok(ranked[1].tvl_usd > ranked[0].tvl_usd * 50);
});

test('a prohibited programme of ANY size scores exactly zero', () => {
  for (const cap of [1, 1_000, 1_000_000, 100_000_000]) {
    const s = scoreCandidate(cand({ payout_cap_usd: cap, automation: prohibited }));
    assert.equal(s.ev, 0, `cap ${cap} should still be zero`);
  }
});

test('an unknown-permission programme also scores zero, with its own reason', () => {
  const s = scoreCandidate(cand({ automation: unknown }));
  assert.equal(s.ev, 0);
  assert.equal(s.zero_reason, 'automation_unknown');
  assert.match(s.why, /silence is not consent/);
});

// ── the formula, term by term ──────────────────────────────────────────────

test('the formula is cap x allowed x gap x weights / hours, to the digit', () => {
  const c = cand({
    payout_cap_usd: 100_000,
    has_programme: false,
    class_weights: { a: 2.0, b: 0.5 },
  });
  const s = scoreCandidate(c);
  const expected = (100_000 * 1 * COVERAGE_GAP_UNCOVERED * 2.5) / TIME_TO_PROOF_PLACEHOLDER_HOURS;
  assert.equal(s.ev, expected);
  assert.equal(s.factors.coverage_gap, COVERAGE_GAP_UNCOVERED);
  assert.equal(s.factors.class_weight_sum, 2.5);
  assert.equal(s.factors.automation_allowed, 1);
});

test('the automation term itself is 0 for a prohibited programme, not just the zero gate', () => {
  // Two independent guards make a prohibited programme score 0: the
  // `automation_allowed` FACTOR in the formula, and the `zero_reason` gate.
  // Asserting the factor explicitly is what stops a refactor from dropping one
  // of them and leaving the other to hide it — a mutation test proved this
  // assertion was missing.
  for (const prog of [prohibited, unknown]) {
    const s = scoreCandidate(cand({ automation: prog }));
    assert.equal(s.factors.automation_allowed, 0, 'the formula term must be 0, not 1');
    assert.equal(s.factors.payout_cap_usd, 100_000, 'the cap is still carried for display');
    assert.equal(s.ev, 0);
  }
  assert.equal(scoreCandidate(cand({ automation: allowed })).factors.automation_allowed, 1);
});

test('a covered programme is worth a quarter of an uncovered one', () => {
  const uncovered = scoreCandidate(cand({ has_programme: false }));
  const covered = scoreCandidate(cand({ has_programme: true }));
  assert.equal(covered.ev / uncovered.ev, COVERAGE_GAP_COVERED / COVERAGE_GAP_UNCOVERED);
});

test('zero and negative class weights contribute nothing (the honest-zero rule)', () => {
  const s = scoreCandidate(
    cand({
      class_weights: {
        'sol.svm-signer': 0, // n=0 in the digest: unmeasured
        'web.graphql': 0, // n=0 in the digest: unmeasured
        'sol.reentrancy': 1.0,
      },
    }),
  );
  assert.equal(s.factors.class_weight_sum, 1.0, 'the two honest zeros must not be counted');
  assert.match(s.why, /1 class\(es\)/);
});

test('a candidate with no measured class weight scores zero and says why', () => {
  const s = scoreCandidate(cand({ class_weights: { 'sol.svm-cpi': 0 } }));
  assert.equal(s.ev, 0);
  assert.equal(s.zero_reason, 'no_measured_class_weight');
});

test('an unmeasured payout cap scores zero and is flagged, not assumed', () => {
  const s = scoreCandidate(cand({ payout_cap_usd: null }));
  assert.equal(s.ev, 0);
  assert.equal(s.zero_reason, 'no_payout_cap_measured');
  assert.equal(s.payout_cap_measured, false);
  assert.match(s.why, /unmeasured rather than zero/);

  // A cap of 0 is also unmeasured for ranking purposes — but it must not be
  // reported as a measured zero either.
  assert.equal(scoreCandidate(cand({ payout_cap_usd: 0 })).payout_cap_measured, false);
});

test('a candidate with no surviving fund address scores zero rather than being ranked on a token', () => {
  const s = scoreCandidate(cand({ has_fork_target: false }));
  assert.equal(s.ev, 0);
  assert.equal(s.zero_reason, 'no_fork_target');
  assert.match(s.why, /token identity/);
});

test('the time-to-proof term is carried, and it never changes the ORDER', () => {
  // It is a constant across candidates, so scaling it scales every score equally.
  assert.equal(scoreCandidate(cand({})).factors.expected_time_to_proof_hours, TIME_TO_PROOF_PLACEHOLDER_HOURS);
  const a = scoreCandidate(cand({ id: 'a', payout_cap_usd: 100_000 }));
  const b = scoreCandidate(cand({ id: 'b', payout_cap_usd: 200_000 }));
  assert.ok(b.ev > a.ev);
  assert.equal(b.ev / a.ev, 2);
});

test('the placeholder is labelled a placeholder, in the code and in the output', () => {
  assert.equal(TIME_TO_PROOF_IS_PLACEHOLDER, true);
  assert.equal(scoreCandidate(cand({})).time_to_proof_is_placeholder, true);
  // And the source says so in words, so the flag cannot outlive its own comment.
  const src = readFileSync(join(APP, 'src/targets/ev.ts'), 'utf8');
  assert.match(src, /THIS IS NOT A MEASUREMENT/);
  assert.match(src, /expected_time_to_proof/);
});

// ── ordering and determinism ────────────────────────────────────────────────

test('ties break on id, so two runs produce the same list', () => {
  const a = cand({ id: 'evm:1:0xbbb' });
  const b = cand({ id: 'evm:1:0xaaa' });
  const one = rankByExpectedValue([a, b]).map((s) => s.id);
  const two = rankByExpectedValue([b, a]).map((s) => s.id);
  assert.deepEqual(one, two);
  assert.deepEqual(one, ['evm:1:0xaaa', 'evm:1:0xbbb']);
});

test('zero-scored rows are kept by default so the UI can show them', () => {
  const ranked = rankByExpectedValue([
    cand({ id: 'good' }),
    cand({ id: 'bad', automation: prohibited }),
  ]);
  assert.equal(ranked.length, 2);
  assert.ok(ranked.some((r) => r.id === 'bad' && r.ev === 0));
});

test('includeZero:false drops only the zeros, never a positive row', () => {
  const ranked = rankByExpectedValue(
    [cand({ id: 'good' }), cand({ id: 'bad', automation: prohibited }), cand({ id: 'tiny', payout_cap_usd: 1 })],
    { includeZero: false },
  );
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((r) => r.ev > 0));
});

test('rankedForDispatch is a stricter set than ranked', () => {
  const ranked = rankByExpectedValue([
    cand({ id: 'good' }),
    cand({ id: 'bad', automation: prohibited }),
  ]);
  const dispatchableIds = rankedForDispatch(ranked).map((r) => r.id);
  assert.deepEqual(dispatchableIds, ['good']);
});

// ── the warning ────────────────────────────────────────────────────────────

test('the ranking-is-not-authorization warning is exported and says the operative facts', () => {
  assert.match(RANKING_IS_NOT_AUTHORIZATION, /LEAD, not a permission/);
  assert.match(RANKING_IS_NOT_AUTHORIZATION, /Discovery is not authorization/);
  assert.match(RANKING_IS_NOT_AUTHORIZATION, /roeFromBrief/);
});

// ── candidate records ──────────────────────────────────────────────────────

const svmCandidate = {
  family: 'svm',
  chain_id: null,
  cluster: 'mainnet-beta',
  address: 'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu',
  name: 'Sanctum Infinity',
  kind: 'protocol',
  source: 'defillama',
  also_in: [],
  also_known_as: [],
};

const evmCandidate = {
  family: 'evm',
  chain_id: 1,
  address: '0x7fC66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
  name: 'Aave V3',
  kind: 'protocol',
  source: 'defillama',
  also_in: [],
  also_known_as: [],
  category: 'Lending',
  tvl_usd: 14_639_478_459,
};

test('has_programme is a first-class field on the candidate record, false and visible', () => {
  const rec = candidateRecord(evmCandidate, {
    funding: null,
    programme: null,
    class_weights: { 'sol.reentrancy': 1.0 },
    now: 1_760_000_000,
  });
  assert.equal(rec.has_programme, false, 'the uncovered case must be an explicit false, not absent');
  assert.equal(rec.programme_id, null);
  assert.equal(rec.automation_allowed, false);
  assert.equal(rec.automation_reason, 'no-programme');
  assert.equal(rec.payout_cap_usd, null);
  assert.ok(Object.prototype.hasOwnProperty.call(rec, 'has_programme'), 'the key must exist even when false');
});

test('the uncovered record scores on the gap term but is not dispatchable', () => {
  const rec = candidateRecord(evmCandidate, {
    funding: {
      fund_addresses: ['0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'],
      address_is_token: true,
      dropped_as_token: 0,
      extracted: 4,
      fork_target: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
      state: 'derived',
      reason: 'ok',
    },
    programme: null,
    class_weights: { 'sol.reentrancy': 1.0 },
    now: 1_760_000_000,
  });
  assert.equal(rec.has_programme, false);
  assert.equal(evInputFrom(rec).has_programme, false, 'the gap must survive the projection');
  // No programme means no affirmative permission, so dispatch is refused even
  // though the target is forkable.
  assert.equal(dispatchable(rec), false);
});

test('a stored record projects into the scorer without ever exposing `address`', () => {
  const rec = candidateRecord(evmCandidate, {
    funding: null,
    programme: { id: 'immunefi:aave', payout_cap_usd: 1_000_000, automation: allowed },
    class_weights: { 'sol.reentrancy': 1.0 },
    now: 1_760_000_000,
  });
  const input = evInputFrom(rec);
  assert.equal(input.has_fork_target, false, 'no adapter read yet, so no fork target');
  assert.equal(input.payout_cap_usd, 1_000_000);
  assert.ok(!('address' in input), 'the scorer must not see the raw address at all');
  assert.equal(scoreRecord(rec).zero_reason, 'no_fork_target');
});

test('an svm candidate keeps chain_id null through the record', () => {
  const rec = candidateRecord(svmCandidate, {
    funding: null,
    programme: null,
    class_weights: {},
    now: 1_760_000_000,
  });
  assert.equal(rec.family, 'svm');
  assert.equal(rec.chain_id, null);
  assert.equal(rec.id, `svm:mainnet-beta:${svmCandidate.address}`);
});

test('classWeightSum drops absent and zero classes rather than defaulting them', () => {
  const got = classWeightSum(['a', 'b', 'c', 'd'], { a: 1.5, b: 0, c: 2 });
  assert.deepEqual(got, { a: 1.5, c: 2 });
});

// ── Risk Curator ───────────────────────────────────────────────────────────

test('a curator brief REFUSES dispatch by name', () => {
  const r = refuseCuratorDispatch({ cls: 'solidity', notes: 'audit this risk curator vault allocator' });
  assert.ok(r);
  assert.equal(r.code, 'no_playbook');
  assert.match(r.message, new RegExp(RISK_CURATOR_CLASS.replace('.', '\\.')));
  assert.match(r.message, /no playbook yet/);
  assert.match(r.message, /misallocation against a disclosed mandate/);
  // The refusal names what is missing, so it is actionable rather than a wall.
  assert.deepEqual(r.missing_hooks, ['mandate.structured', 'positions.timeline', 'counterfactual.distribution']);
});

test('the curator refusal is triggered by class, by playbook id, and by free text', () => {
  assert.ok(refuseCuratorDispatch({ cls: 'curator' }));
  assert.ok(refuseCuratorDispatch({ playbooks: ['risk.curator'] }));
  assert.ok(refuseCuratorDispatch({ playbooks: ['risk.curator.mandate-drift'] }));
  assert.ok(refuseCuratorDispatch({ notes: 'look at this RISK CURATOR' }));
  // NOT triggered by the most ambiguous word in DeFi.
  assert.equal(isCuratorBrief({ notes: 'check the vault reentrancy' }), false);
  assert.equal(refuseCuratorDispatch({ cls: 'solidity', notes: 'a vault reentrancy bug' }), null);
});

test('a curator brief is neither dispatchable nor silently routed as solidity', () => {
  assert.equal(curatorClassIsDispatchable(), false);
  for (const hook of CURATOR_METHODOLOGY_HOOKS) {
    assert.equal(hook.available, false, `${hook.id} claims data we do not have`);
    assert.ok(hook.missing.length > 30, `${hook.id} must say what is missing`);
  }
  assert.match(NO_PLAYBOOK_YET_REASON, /Dispatch refuses by name/);
});

test('a non-curator brief passes the curator refusal untouched', () => {
  assert.equal(refuseCuratorDispatch({ cls: 'solidity', notes: 'reentrancy in the withdraw path' }), null);
  assert.equal(refuseCuratorDispatch({}), null);
});
