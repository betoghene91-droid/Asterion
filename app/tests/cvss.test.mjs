// CVSS derivation tests.
//
// Three things are being proved here, and they are different claims:
//
//   1. THE ARITHMETIC IS THE SPEC. `baseScore` is pinned against published
//      reference vectors, so a "correct-looking" score cannot drift.
//   2. THE DERIVATION IS DETERMINISTIC. The same four inputs produce
//      byte-identical output, twice, including the basis text — because the
//      report embeds that text and a golden file cannot pin a moving string.
//   3. THE DERIVATION IS SAFE OR IT REFUSES. Unattested axes take the less
//      severe value and say so; an unscorable impact kind refuses instead of
//      producing a 0.0 that would read as "harmless".
//
// What this file cannot prove: that any particular programme agrees with the
// mapping. CVSS base scores are a shared vocabulary, not a severity judgement,
// and the mapping from OUR recorded facts to its metrics is a design decision
// documented in cvss.ts. Nothing here measures a target.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baseScore,
  classifyPreconditions,
  deriveCvss,
  formatScore,
  isScorableImpact,
  parseVector,
  reachabilityOfAssetKind,
  reachabilityOfAssets,
  roundUp,
  scoreOfVector,
  vectorFor,
  ASSET_KIND_TO_REACHABILITY,
  CVSS_VERSION,
  IMPACT_TO_CIA,
  MUTABILITY_TO_PR,
  REACHABILITY_TO_AV,
} from '../build/cvss.js';

// ── 1. the arithmetic is the spec ──────────────────────────────────────────

/**
 * Published CVSS 3.1 base vectors and their scores. Drawn from the FIRST
 * specification's own examples and widely-published reference values; each is a
 * vector a reader can check against any public calculator.
 */
const REFERENCE = [
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
  ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 8.8],
  ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 7.8],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10.0],
  ['CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H', 8.1],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N', 6.5],
  ['CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:N', 5.3],
  ['CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:H', 4.0],
  ['CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:L/A:L', 3.5],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', 7.5],
  ['CVSS:3.1/AV:A/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 8.8],
  ['CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H', 7.2],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H', 8.6],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', 5.3],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H', 8.8],
  ['CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 8.4],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0.0],
];

test('the base score matches every published reference vector', () => {
  const wrong = [];
  for (const [vector, want] of REFERENCE) {
    const got = scoreOfVector(vector);
    if (got !== want) wrong.push(`${vector}: want ${want}, got ${got}`);
  }
  assert.deepEqual(wrong, [], `score arithmetic disagrees with the spec:\n${wrong.join('\n')}`);
});

test('Roundup follows §7.4 rather than naive ceil-to-one-decimal', () => {
  // §7.4: multiply by 100000, round to nearest int; if divisible by 10000 the
  // value is already exact, otherwise floor to the next lower 10000 and add 1.
  assert.equal(roundUp(4.0), 4.0);
  assert.equal(roundUp(4.02), 4.1);
  // The spec's integer form takes the exact branch here, so 9.800000001 stays
  // 9.8. A float-based ceil would return 9.9.
  assert.equal(roundUp(9.800000001), 9.8);
  // Just above an exact tenth rounds up.
  assert.equal(roundUp(4.00001), 4.1);
  assert.equal(roundUp(0), 0);
  assert.equal(roundUp(10), 10);
  // A score that lands exactly on a tenth must NOT be bumped. 6.1 is exact here.
  assert.equal(roundUp(6.1), 6.1);
});

test('a zero-impact vector scores 0.0 rather than evaluating exploitability', () => {
  // Spec §7.1: when ISS is 0 the base score is 0 regardless of AV/AC/PR/UI.
  assert.equal(
    scoreOfVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N'),
    0,
  );
  // And Scope:Changed must not resurrect it through the 7.52 term.
  assert.equal(
    scoreOfVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:N'),
    0,
  );
});

test('a malformed or non-3.1 vector is null, never 0.0', () => {
  const bad = [
    '',
    'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H', // missing A
    'CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', // bad AV
    'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P', // temporal metric present
  ];
  for (const v of bad) {
    assert.equal(parseVector(v), null, `should not parse: ${v}`);
    assert.equal(scoreOfVector(v), null, `should not score: ${v}`);
  }
});

test('vectorFor and parseVector round-trip every part', () => {
  const parts = { AV: 'N', AC: 'H', PR: 'L', UI: 'R', S: 'C', C: 'L', I: 'H', A: 'N' };
  const v = vectorFor(parts);
  assert.equal(v, 'CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:C/C:L/I:H/A:N');
  assert.deepEqual(parseVector(v), parts);
  assert.equal(scoreOfVector(v), baseScore(parts));
});

test('scores are formatted to one decimal place, always', () => {
  assert.equal(formatScore(10), '10.0');
  assert.equal(formatScore(0), '0.0');
  assert.equal(formatScore(5.3), '5.3');
});

// ── 2. the lookups ─────────────────────────────────────────────────────────

test('every ledger asset kind maps to a reachability, and unknown kinds do not', () => {
  // The vocabulary is schema.sql's assets.kind comment.
  const vocabulary = ['domain', 'host', 'url', 'api', 'cidr', 'chain_address', 'repo', 'apk', 'ipa'];
  for (const kind of vocabulary) {
    assert.ok(reachabilityOfAssetKind(kind), `${kind} must map to a reachability`);
  }
  assert.equal(reachabilityOfAssetKind('quantum_thing'), null);
  assert.equal(reachabilityOfAssetKind(''), null);
  assert.deepEqual(Object.keys(ASSET_KIND_TO_REACHABILITY).sort(), [...vocabulary].sort());
});

test('reachabilityOfAssets takes the widest kind and refuses an unknown one', () => {
  assert.equal(reachabilityOfAssets(['repo']), 'local');
  assert.equal(reachabilityOfAssets(['repo', 'host']), 'network');
  assert.equal(reachabilityOfAssets(['cidr', 'repo']), 'adjacent');
  // One unknown kind makes the whole answer unknown: a partial answer would
  // narrow the blast radius the report describes.
  assert.equal(reachabilityOfAssets(['host', 'unknown']), null);
  assert.equal(reachabilityOfAssets([]), null);
});

test('the lookups cover exactly the domains they claim to', () => {
  assert.deepEqual(Object.keys(REACHABILITY_TO_AV).sort(), ['adjacent', 'local', 'network', 'physical']);
  assert.deepEqual(Object.keys(MUTABILITY_TO_PR).sort(), ['destructive', 'mutate', 'read', 'simulate']);
  assert.deepEqual(Object.keys(IMPACT_TO_CIA).sort(), [
    'denial',
    'state_corruption',
    'unauthorized_access',
    'value_transfer',
  ]);
  assert.equal(CVSS_VERSION, '3.1');
});

test('the mutability ladder never lowers the privilege bar as mutability rises', () => {
  const rank = { N: 0, L: 1, H: 2 };
  const ladder = ['read', 'simulate', 'mutate', 'destructive'];
  let prev = -1;
  for (const m of ladder) {
    const r = rank[MUTABILITY_TO_PR[m]];
    assert.ok(r >= prev, `${m} must not require less privilege than the step below it`);
    prev = r;
  }
});

// ── 3. precondition classification ─────────────────────────────────────────

test('lab requirements are environment, not attack conditions', () => {
  const cls = classifyPreconditions(['FORK_RPC', 'TARGET', 'foundry']);
  assert.deepEqual(cls.environment, ['FORK_RPC', 'TARGET', 'foundry']);
  assert.deepEqual(cls.target_condition, []);
});

test('an unclassifiable requirement is conservatively a target condition', () => {
  const cls = classifyPreconditions(['a value-transferring function in Vault']);
  assert.deepEqual(cls.target_condition, ['a value-transferring function in Vault']);
  // Not knowing what it is must never make the attack look easier.
  assert.deepEqual(cls.environment, []);
});

test('victim, boundary and privilege phrases are recognised', () => {
  const cls = classifyPreconditions([
    'the victim clicks the reset link',
    'the effect crosses into another tenant',
    'the caller already holds the owner key',
  ]);
  assert.equal(cls.victim.length, 1);
  assert.equal(cls.boundary.length, 1);
  assert.equal(cls.privilege.length, 1);
});

test('a non-array or non-string precondition is ignored, not crashed on', () => {
  assert.deepEqual(classifyPreconditions([]).target_condition, []);
  assert.deepEqual(classifyPreconditions(/** @type {any} */ (null)).target_condition, []);
  const cls = classifyPreconditions(/** @type {any} */ ([null, 42, '   ', 'FORK_RPC']));
  assert.deepEqual(cls.environment, ['FORK_RPC']);
});

// ── 4. the derivation ──────────────────────────────────────────────────────

const FIXTURE_INPUTS = {
  mutability: 'simulate',
  impact: 'value_transfer',
  reachability: 'network',
  preconditions: ['FORK_RPC', 'TARGET', 'a value-transferring function in Vault'],
};

test('the same inputs derive byte-identical output twice', () => {
  // The assignment asks for this explicitly, and it is the property the whole
  // module exists for: a report number that changes between runs is not
  // evidence. JSON.stringify with sorted keys so key order cannot mask a
  // difference and so a deep-equal is a byte-equality.
  const a = deriveCvss(FIXTURE_INPUTS);
  const b = deriveCvss(FIXTURE_INPUTS);
  assert.ok(a.ok && b.ok);
  const canon = (x) => JSON.stringify(x, Object.keys(x).sort());
  assert.equal(canon(a), canon(b));
  assert.equal(a.vector, b.vector);
  assert.equal(a.score, b.score);
  assert.equal(a.score_text, b.score_text);
  // And the basis TEXT is part of the contract, because the report embeds it.
  assert.deepEqual(a.basis, b.basis);
  assert.deepEqual(a.unattested, b.unattested);
});

test('the fixture vector is pinned', () => {
  const d = deriveCvss(FIXTURE_INPUTS);
  assert.ok(d.ok);
  assert.equal(d.vector, 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:N');
  assert.equal(d.score_text, '5.3');
  // The vector must agree with the arithmetic, not with a hardcoded number.
  assert.equal(scoreOfVector(d.vector), d.score);
});

test('unattested axes take the less severe value and are named', () => {
  const d = deriveCvss(FIXTURE_INPUTS);
  assert.ok(d.ok);
  assert.deepEqual([...d.unattested].sort(), ['S', 'UI']);
  assert.equal(d.parts.UI, 'R', 'no user-interaction signal must not yield UI:N');
  assert.equal(d.parts.S, 'U', 'no boundary signal must not yield S:C');
  assert.equal(d.basis.UI.attested, false);
  assert.equal(d.basis.S.attested, false);
  // Every other metric IS attested by something recorded.
  for (const k of ['AV', 'AC', 'PR', 'C', 'I', 'A']) {
    assert.equal(d.basis[k].attested, true, `${k} should be attested`);
  }
});

test('a declared boundary crossing is the only route to S:C, and it raises the score', () => {
  const base = deriveCvss({ ...FIXTURE_INPUTS });
  const changed = deriveCvss({
    ...FIXTURE_INPUTS,
    preconditions: [...FIXTURE_INPUTS.preconditions, 'the effect crosses into another tenant'],
  });
  assert.ok(base.ok && changed.ok);
  assert.equal(changed.parts.S, 'C');
  assert.equal(changed.basis.S.attested, true);
  assert.ok(changed.score > base.score, 'S:C must not score lower than S:U with identical CIA');
  assert.ok(!changed.unattested.includes('S'));
});

test('an automation precondition is the only route to UI:N, and it does not lower the score', () => {
  const scripted = deriveCvss({
    ...FIXTURE_INPUTS,
    preconditions: [...FIXTURE_INPUTS.preconditions, 'no user interaction: single transaction'],
  });
  assert.ok(scripted.ok);
  assert.equal(scripted.parts.UI, 'N');
  assert.equal(scripted.basis.UI.attested, true);
  assert.ok(!scripted.unattested.includes('UI'));
});

test('a declared privilege requirement overrides the mutability ladder', () => {
  // A `read` engagement whose harness says the attacker holds the owner key is
  // PR:H, not PR:N — the harness knows something the ladder does not.
  const d = deriveCvss({
    mutability: 'read',
    impact: 'unauthorized_access',
    reachability: 'network',
    preconditions: ['TARGET', 'the caller already holds the owner key'],
  });
  assert.ok(d.ok);
  assert.equal(d.parts.PR, 'H');
  assert.match(d.basis.PR.from, /privilege position/);

  // Without that signal the ladder decides, and `read` is PR:N.
  const plain = deriveCvss({
    mutability: 'read',
    impact: 'unauthorized_access',
    reachability: 'network',
    preconditions: ['TARGET'],
  });
  assert.ok(plain.ok);
  assert.equal(plain.parts.PR, 'N');
});

test('impact kind selects C/I/A and claims nothing beyond the recorded kind', () => {
  const cases = [
    ['value_transfer', { C: 'N', I: 'H', A: 'N' }],
    ['unauthorized_access', { C: 'H', I: 'L', A: 'N' }],
    ['state_corruption', { C: 'N', I: 'H', A: 'L' }],
    ['denial', { C: 'N', I: 'N', A: 'H' }],
  ];
  for (const [kind, cia] of cases) {
    const d = deriveCvss({ ...FIXTURE_INPUTS, impact: kind });
    assert.ok(d.ok, `${kind} must be scorable`);
    assert.equal(d.parts.C, cia.C);
    assert.equal(d.parts.I, cia.I);
    assert.equal(d.parts.A, cia.A);
  }
  // A value transfer must not silently assert a confidentiality breach.
  const vt = deriveCvss({ ...FIXTURE_INPUTS, impact: 'value_transfer' });
  assert.ok(vt.ok);
  assert.equal(vt.parts.C, 'N');
});

test('an unscorable impact kind REFUSES instead of scoring 0.0', () => {
  // This is the load-bearing refusal: proof.ts carries `other` when the plan
  // named no claim kind. Scoring it would require inventing C/I/A, and 0.0 would
  // read as "harmless" — a claim nobody measured.
  for (const kind of ['other', '', 'value-transfer', null, undefined, 7]) {
    const d = deriveCvss({ ...FIXTURE_INPUTS, impact: /** @type {any} */ (kind) });
    assert.equal(d.ok, false, `${String(kind)} must refuse`);
    if (!d.ok) {
      assert.deepEqual(d.missing, ['impact']);
      assert.match(d.reason, /without inventing/);
    }
  }
  // And `isScorableImpact` agrees, so a caller can branch without duplicating it.
  assert.equal(isScorableImpact('other'), false);
  assert.equal(isScorableImpact('value_transfer'), true);
});

test('a bad mutability or reachability refuses by name', () => {
  const bad = deriveCvss({ ...FIXTURE_INPUTS, mutability: /** @type {any} */ ('nuke') });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.missing, ['mutability']);

  const badR = deriveCvss({ ...FIXTURE_INPUTS, reachability: /** @type {any} */ ('mars') });
  assert.equal(badR.ok, false);
  if (!badR.ok) assert.deepEqual(badR.missing, ['reachability']);

  const none = deriveCvss(/** @type {any} */ (null));
  assert.equal(none.ok, false);
  if (!none.ok) assert.deepEqual(none.missing, ['inputs']);
});

test('a more severe reachability never yields a lower score', () => {
  const order = ['physical', 'local', 'adjacent', 'network'];
  let prev = -1;
  for (const r of order) {
    const d = deriveCvss({ ...FIXTURE_INPUTS, reachability: r });
    assert.ok(d.ok);
    assert.ok(d.score >= prev, `${r} scored ${d.score}, below a less severe value`);
    prev = d.score;
  }
});

test('every metric in the basis explains itself in one sentence', () => {
  const d = deriveCvss(FIXTURE_INPUTS);
  assert.ok(d.ok);
  for (const k of ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']) {
    const b = d.basis[k];
    assert.ok(b, `${k} has no basis`);
    assert.ok(b.from.length > 10, `${k} basis is not explanatory: ${b.from}`);
    assert.equal(typeof b.attested, 'boolean');
    assert.equal(b.value, d.parts[k]);
  }
});
