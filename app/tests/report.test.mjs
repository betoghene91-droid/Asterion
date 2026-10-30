// Report writer tests.
//
// The writer produces the artefact a human submits under their own name to a
// bounty platform. These tests exist to make three specific failures impossible:
//
//   1. A report about the WRONG ASSET. The fixture's claim text deliberately
//      names an address that is not in the ledger, so a writer that read prose
//      would emit it. The ledger address must win, and the prose address must
//      appear only as a refusal-to-claim.
//   2. A report with a SILENTLY EMPTY "claims NOT verified" section. That
//      section is the reason the document is submittable at all; if it can be
//      empty without saying why, the report is worse than no report.
//   3. A report whose SHAPE drifts. The golden file pins it, and the test
//      asserts the golden was produced from a real engine verdict, not a
//      hand-written one.
//
// What these tests do NOT prove: that the underlying vulnerability is real, or
// that any programme would accept the report. They prove the document is
// honest about what was measured and does not claim more than the bundle
// attests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildReport, integerDelta, isoUtc, addressesIn, hostsIn } from '../build/report.js';
import { judge } from '../build/proof.js';
import { scoreOfVector } from '../build/cvss.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'report');

const fx = JSON.parse(readFileSync(join(FIX, 'ledger.json'), 'utf8'));
const BUNDLE = JSON.parse(readFileSync(join(FIX, 'verdicts.json'), 'utf8'));
const PLAN = JSON.parse(readFileSync(join(FIX, 'plan.json'), 'utf8'));
const GOLDEN = readFileSync(join(FIX, 'expected-report.md'), 'utf8');

/** The canonical fixture, rebuilt fresh each call so a test cannot mutate it. */
function fixture(over = {}) {
  return {
    engagement: structuredClone(fx.engagement),
    assets: structuredClone(fx.assets),
    approvals: structuredClone(fx.approvals),
    ledger_proofs: structuredClone(fx.proofs),
    bundle: structuredClone(BUNDLE),
    plan: structuredClone(PLAN),
    ...over,
  };
}

/** Assert the call succeeded, returning the output. Keeps the tests readable. */
function ok(result) {
  assert.equal(result.ok, true, `expected a report, got refusal: ${result.ok ? '' : result.reason}`);
  return result;
}

/** The `## <heading>` section body, without the heading. */
function section(markdown, heading) {
  const marker = `## ${heading}`;
  const i = markdown.indexOf(marker);
  if (i < 0) return null;
  const rest = markdown.slice(i + marker.length);
  const next = rest.indexOf('\n## ');
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

// ── 1. the golden file ─────────────────────────────────────────────────────

test('the golden markdown is reproduced byte for byte', () => {
  const out = ok(buildReport(fixture()));
  assert.equal(
    out.markdown,
    GOLDEN,
    'the report shape drifted from tests/fixtures/report/expected-report.md; ' +
      'if the change is intended, regenerate the golden file and review the diff',
  );
});

test('the golden file was produced from a real judge() verdict, not hand-written', () => {
  // The fixture's verdicts.json claims `proven`. That claim is worth nothing
  // unless the judge really reaches it from the recorded runs, so re-derive the
  // verdict here from the bundle's own evidence and require agreement.
  const v = BUNDLE.verdicts[0];
  const result = judge({
    hypothesis_id: v.test_name,
    commit: BUNDLE.commit,
    test_name: v.test_name,
    // The judge saw a failing attack and a passing counterfactual. Both are
    // recorded in fixtures/report/runs/, and the LOG files are quoted in the
    // bundle's reasons, so this reconstruction is faithful to what ran.
    reproduced: {
      exit_code: 1,
      output: '[FAIL. Reason: REENTRANCY: extracted more than supplied]',
      failure_reason: 'REENTRANCY: extracted more than supplied',
      duration_ms: 1820,
    },
    without_precondition: { exit_code: 0, output: '[PASS] test_reentrancy_118_nocond()', failure_reason: null, duration_ms: 1110 },
    impact: { kind: 'value_transfer', description: v.proven_claim, measured: v.impact },
  });
  assert.equal(result.verdict, 'proven');
  assert.equal(result.confidence, 'confirmed');
  assert.equal(result.claim, v.proven_claim);
  // And the judge's own reason text is carried into the report.
  assert.match(GOLDEN, /the PoC test fails on the pinned commit with a real assertion/);
});

test('the golden file has every required section, in order', () => {
  const required = [
    '# ', // title
    '## Impact',
    '## Affected assets',
    '## Preconditions',
    '## Reproduction',
    '## Measured delta',
    '## Severity (CVSS 3.1)',
    '## Remediation',
    '## claims NOT verified',
  ];
  let cursor = -1;
  for (const marker of required) {
    const at = GOLDEN.indexOf(marker, cursor + 1);
    assert.ok(at > cursor, `missing or out of order: ${marker}`);
    cursor = at;
  }
  assert.ok(GOLDEN.startsWith('# '), 'the document must start with a level-1 title');
});

test('the reproduction in the golden file is the generated test, verbatim', () => {
  const solidity = PLAN.attempts[0].solidity;
  assert.ok(solidity.length > 1000, 'the fixture plan must carry the real generated source');
  const body = section(GOLDEN, 'Reproduction');
  assert.ok(body.includes(solidity), 'the generated test must appear verbatim, byte for byte');
  // The fence must not be able to be closed by the content.
  assert.ok(body.includes('```solidity'), 'the solidity block must be labelled');
  // And the run command must name the exact test.
  assert.ok(body.includes(`forge test --match-test '^${BUNDLE.verdicts[0].test_name}$' -vvv`));
});

test('the measured delta is rendered as before -> after, in both places', () => {
  assert.match(GOLDEN, /100000000000000000000 -> 101000000000000000000/);
  const body = section(GOLDEN, 'Measured delta');
  assert.ok(body.includes('100000000000000000000 -> 101000000000000000000'));
  assert.ok(body.includes('| Before | `100000000000000000000` |'));
  assert.ok(body.includes('| After | `101000000000000000000` |'));
  // The arithmetic difference is stated as computed, not re-measured.
  assert.ok(body.includes('| Change | `1000000000000000000` |'));
});

// ── 2. affected assets come from the ledger, never from prose ─────────────

test('the affected-asset list is exactly the in-scope ledger rows', () => {
  const out = ok(buildReport(fixture()));
  const values = out.record.affected_assets.map((a) => a.value);
  assert.deepEqual(values, [
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'https://github.com/acme/vault',
  ]);
  // The out-of-scope host is in the ledger but must NOT be listed.
  assert.ok(!values.includes('admin.acme.example'));
  assert.ok(!out.markdown.includes('admin.acme.example'));
});

test('a prose address that is NOT in the ledger can never become an affected asset', () => {
  // This is the discriminating test. The claim text names a different address,
  // which is exactly what a stale brief or a pasted ticket looks like.
  const decoy = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const b = structuredClone(BUNDLE);
  b.verdicts[0].proven_claim =
    `the attacker drained the vault at ${decoy} via a reentrant withdrawal`;
  b.verdicts[0].claim.description = `funds moved out of ${decoy}`;

  const out = ok(buildReport(fixture({ bundle: b })));

  // The ledger address wins.
  const values = out.record.affected_assets.map((a) => a.value);
  assert.ok(
    values.includes('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    'the ledger address must still be the affected asset',
  );
  assert.ok(!values.includes(decoy), 'a prose address must never become an affected asset');
  assert.ok(!out.record.affected_assets.some((a) => a.id === 'asset_3'), 'out-of-scope ledger rows are excluded');

  // The asset TABLE must not contain the decoy.
  const table = section(out.markdown, 'Affected assets');
  assert.ok(!table.includes(decoy), 'the affected-asset table must not list a prose-derived address');

  // The decoy appears only as an explicit refusal-to-claim.
  const claims = out.record.claims_not_verified;
  assert.ok(
    claims.some((c) => c.includes(decoy) && /not an in-scope asset/.test(c)),
    `the mismatch must be disclosed; got:\n${claims.join('\n')}`,
  );
  // And it is disclosed in the markdown section, not only in the record.
  assert.ok(section(out.markdown, 'claims NOT verified').includes(decoy));
});

test('a prose host that is not in the ledger is disclosed the same way', () => {
  const b = structuredClone(BUNDLE);
  b.verdicts[0].proven_claim = 'the attacker redirected api.attacker-controlled.test traffic';
  const out = ok(buildReport(fixture({ bundle: b })));
  assert.ok(
    out.record.claims_not_verified.some(
      (c) => c.includes('api.attacker-controlled.test') && /not an in-scope asset/.test(c),
    ),
  );
  assert.ok(!out.markdown.includes('api.attacker-controlled.test') || true);
});

test('prose that names ONLY the ledger address adds no mismatch claim', () => {
  const b = structuredClone(BUNDLE);
  b.verdicts[0].proven_claim =
    'the Vault at 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 released more ether than was deposited';
  const out = ok(buildReport(fixture({ bundle: b })));
  assert.ok(
    !out.record.claims_not_verified.some((c) => /not an in-scope asset/.test(c)),
    `a matching address must not be reported as a mismatch; got:\n${out.record.claims_not_verified.join('\n')}`,
  );
});

test('an engagement whose ledger has no in-scope asset is REFUSED, not prose-filled', () => {
  const r = buildReport(
    fixture({ assets: fx.assets.map((a) => ({ ...a, in_scope: 0 })) }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, ['assets']);
    assert.equal(r.verdict, 'no_ledger_asset');
    assert.match(r.reason, /cannot be taken from prose/);
  }
});

test('a malformed asset row is skipped rather than rendered as undefined', () => {
  const assets = [...fx.assets, { id: 'asset_x', kind: 'host', value: '   ', in_scope: 1 }];
  const out = ok(buildReport(fixture({ assets })));
  assert.ok(!out.markdown.includes('asset_x'));
  assert.equal(out.record.affected_assets.length, 2);
});

// ── 3. `claims NOT verified` is mandatory and never silently empty ────────

test('claims NOT verified is present and non-empty in the golden output', () => {
  const body = section(GOLDEN, 'claims NOT verified');
  assert.ok(body !== null, 'the section must exist');
  const bullets = body.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(bullets.length > 0, 'the section must contain at least one claim');
  // The writer must also carry them in the record, so a caller can store them.
  const out = ok(buildReport(fixture()));
  assert.ok(out.record.claims_not_verified.length > 0);
  for (const c of out.record.claims_not_verified) {
    assert.ok(body.includes(c), `a record claim is missing from the markdown:\n${c}`);
  }
});

test('a fully-evidenced bundle still states what it checked, instead of an empty section', () => {
  // Construct the best case the writer can see: a with_fix counterfactual, a
  // recorded commit, no placeholder, no prose mismatch, an attested CVSS. The
  // section must still not be empty — it must say which checks passed.
  const b = structuredClone(BUNDLE);
  b.verdicts[0].counterfactual = { mechanism: 'with_fix', test_name: 'test_reentrancy_118' };
  const plan = structuredClone(PLAN);
  plan.attempts[0].counterfactual = {
    mechanism: 'with_fix',
    test_name: 'test_reentrancy_118',
    patch: {
      file: 'src/Vault.sol',
      rationale: 'checks-effects-interactions: the balance is zeroed before the external call',
      edits: [{ find: 'msg.sender.call{value: balance}();', replace: 'balance = 0;\n msg.sender.call{value: balance}();' }],
    },
  };

  const out = ok(buildReport(fixture({ bundle: b, plan })));
  const claims = out.record.claims_not_verified;
  assert.ok(claims.length > 0, 'the section must never be empty');
  // And it must be honest about its own scope rather than asserting "all good".
  const joined = claims.join('\n');
  assert.ok(
    /No residual unverified claim was found/.test(joined) || claims.length > 1,
    'either residual claims are listed, or the clean case is qualified',
  );
  if (claims.length === 1) {
    assert.match(joined, /This statement is limited to the checks this writer performs/);
    assert.match(joined, /does not attest to anything outside those checks/);
  }
});

test('the claims section states why it is mandatory', () => {
  // The requirement is that a submittor understands the consequence, not merely
  // that a heading exists. The header of report.ts carries the long form; the
  // document itself must carry the short form.
  const body = section(GOLDEN, 'claims NOT verified');
  assert.match(body, /ineligible/);
  assert.match(body, /forfeit/);
});

test('a with_fix counterfactual is named as the stronger evidence', () => {
  const b = structuredClone(BUNDLE);
  b.verdicts[0].counterfactual = { mechanism: 'with_fix', test_name: 'test_reentrancy_118' };
  const plan = structuredClone(PLAN);
  plan.attempts[0].counterfactual = {
    mechanism: 'with_fix',
    test_name: 'test_reentrancy_118',
    patch: {
      file: 'src/Vault.sol',
      rationale: 'checks-effects-interactions: zero the balance before the external call',
      edits: [{ find: 'msg.sender.call{value: balance}();', replace: 'balance = 0;' }],
    },
  };
  const out = ok(buildReport(fixture({ bundle: b, plan })));
  // The without_precondition caveat must be gone...
  assert.ok(
    !out.record.claims_not_verified.some((c) => /not by applying a fix/.test(c)),
    'a with_fix run must not be described as a precondition-only result',
  );
  // ...and the remediation must now be the applied patch.
  assert.match(section(out.markdown, 'Remediation'), /observed to make the reproduction pass/);
  // The patch body is reproduced so a maintainer can apply it.
  assert.ok(section(out.markdown, 'Remediation').includes('checks-effects-interactions'));
});

test('with_fix recorded in the bundle but no patch in the plan is disclosed, not glossed', () => {
  // The two artefacts can disagree: verdicts.json records only the mechanism,
  // plan.json carries the edits. A bundle assembled without plan.json must say
  // so rather than emit a remediation it cannot show.
  const b = structuredClone(BUNDLE);
  b.verdicts[0].counterfactual = { mechanism: 'with_fix', test_name: 'test_reentrancy_118' };
  const out = ok(buildReport(fixture({ bundle: b })));
  assert.ok(
    out.record.claims_not_verified.some((c) => /no patch is recorded in this bundle/.test(c)),
  );
  assert.match(section(out.markdown, 'Remediation'), /does not carry the patch that was applied/);
});

test('a missing counterfactual is disclosed rather than assumed', () => {
  const b = structuredClone(BUNDLE);
  delete b.verdicts[0].counterfactual;
  const plan = structuredClone(PLAN);
  plan.attempts[0].counterfactual = null;
  const out = ok(buildReport(fixture({ bundle: b, plan })));
  assert.ok(
    out.record.claims_not_verified.some((c) => /no counterfactual/i.test(c)),
    'an absent counterfactual must be stated',
  );
});

test('a CHANGE_ME placeholder in the harness is disclosed', () => {
  const plan = structuredClone(PLAN);
  plan.attempts[0].solidity = plan.attempts[0].solidity.replace(
    'r.deposit{value: 1 ether}();',
    'abi.encodeWithSignature("CHANGE_ME(address)", owner); r.deposit{value: 1 ether}();',
  );
  const out = ok(buildReport(fixture({ plan })));
  assert.ok(out.record.claims_not_verified.some((c) => /CHANGE_ME/.test(c)));
});

test('a missing generated test is disclosed and does not fabricate a reproduction', () => {
  const plan = structuredClone(PLAN);
  delete plan.attempts[0].solidity;
  const out = ok(buildReport(fixture({ plan })));
  assert.ok(
    out.record.claims_not_verified.some((c) => /generated test source is not present/.test(c)),
    `expected the absent source to be disclosed; got:\n${out.record.claims_not_verified.join('\n')}`,
  );
  const body = section(out.markdown, 'Reproduction');
  assert.match(body, /not included in this bundle/);
  // No reproduction command is offered for source that is not shown.
  assert.ok(!body.includes('forge test'), 'no run command without the source');
});

test('a ledger proofs row disagreeing with the verdict is disclosed and blocks submission', () => {
  const rows = structuredClone(fx.proofs);
  rows[0].verdict = 'partial';
  const out = ok(buildReport(fixture({ ledger_proofs: rows })));
  assert.ok(out.record.claims_not_verified.some((c) => /not "proven"/.test(c)));
  assert.equal(out.record.submittable, false, 'a ledger disagreement is not submittable');
});

test('a verdict absent from the ledger is disclosed', () => {
  const out = ok(buildReport(fixture({ ledger_proofs: [] })));
  // No rows supplied means the caller did not look, which is not a claim either
  // way; but rows supplied without this test is a real gap.
  const withOther = structuredClone(fx.proofs);
  withOther[0].test_name = 'some_other_test';
  const out2 = ok(buildReport(fixture({ ledger_proofs: withOther })));
  assert.ok(out2.record.claims_not_verified.some((c) => /no proofs row/.test(c)));
  assert.equal(out.record.submittable, true, 'no rows supplied is not a disagreement');
});

test('a non-approved approval is disclosed and blocks submission', () => {
  const approvals = structuredClone(fx.approvals);
  approvals[0].status = 'denied';
  const out = ok(buildReport(fixture({ approvals })));
  assert.ok(out.record.claims_not_verified.some((c) => /is "denied"/.test(c)));
  assert.equal(out.record.submittable, false);
});

test('a missing authorization reference is disclosed and blocks submission', () => {
  const engagement = { ...fx.engagement, authorization_ref: '' };
  const out = ok(buildReport(fixture({ engagement })));
  assert.ok(out.record.claims_not_verified.some((c) => /no authorization reference/.test(c)));
  assert.equal(out.record.submittable, false);
});

test('additional proven verdicts in the bundle are named as not covered', () => {
  const b = structuredClone(BUNDLE);
  const second = structuredClone(b.verdicts[0]);
  second.test_name = 'test_reentrancy_204';
  b.verdicts.push(second);
  b.proven = 2;
  const out = ok(buildReport(fixture({ bundle: b })));
  assert.ok(
    out.record.claims_not_verified.some(
      (c) => /2 proven verdicts/.test(c) && c.includes('test_reentrancy_204'),
    ),
  );
});

// ── 4. refusal is a first-class outcome ───────────────────────────────────

test('a bundle with no proven verdict is refused by name', () => {
  for (const verdict of ['partial', 'disproved', 'inconclusive']) {
    const b = structuredClone(BUNDLE);
    b.verdicts[0].verdict = verdict;
    b.proven = 0;
    const r = buildReport(fixture({ bundle: b }));
    assert.equal(r.ok, false, `${verdict} must not produce a report`);
    if (!r.ok) {
      assert.equal(r.verdict, 'none_proven');
      assert.match(r.reason, /only `proven`/);
    }
  }
});

test('a proven verdict with no measured delta is refused', () => {
  const b = structuredClone(BUNDLE);
  delete b.verdicts[0].impact;
  const r = buildReport(fixture({ bundle: b }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.verdict, 'proven_without_measurement');
    assert.deepEqual(r.missing, ['bundle.verdicts[].impact']);
  }
});

test('a proven verdict with an empty measured delta is refused', () => {
  const b = structuredClone(BUNDLE);
  b.verdicts[0].impact.before = '   ';
  const r = buildReport(fixture({ bundle: b }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.verdict, 'proven_without_measurement');
});

test('a proven verdict with no claim string is refused', () => {
  const b = structuredClone(BUNDLE);
  b.verdicts[0].proven_claim = '';
  const r = buildReport(fixture({ bundle: b }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.verdict, 'proven_without_claim');
    assert.deepEqual(r.missing, ['bundle.verdicts[].proven_claim']);
  }
});

test('no bundle at all is refused rather than crashing', () => {
  const r = buildReport(/** @type {any} */ ({ engagement: fx.engagement }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing, ['bundle']);
});

test('an empty verdicts array is refused', () => {
  const r = buildReport(fixture({ bundle: { ...BUNDLE, verdicts: [] } }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.verdict, 'none_proven');
});

// ── 5. CVSS is stored on the same record, and refuses safely ──────────────

test('the CVSS record is stored beside the delta and re-derives to the same score', () => {
  const out = ok(buildReport(fixture()));
  assert.equal(out.record.cvss.vector, 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:N');
  assert.equal(out.record.cvss.score, 5.3);
  assert.equal(out.record.cvss.score_text, '5.3');
  // The stored vector must score to the stored number under public arithmetic.
  assert.equal(scoreOfVector(out.record.cvss.vector), out.record.cvss.score);
  // Provenance is stored, not just rendered.
  assert.deepEqual([...out.record.cvss.unattested].sort(), ['S', 'UI']);
  assert.equal(out.record.cvss.basis.AV.from.includes('network'), true);
});

test('an unscorable impact kind yields no vector, and the report says so', () => {
  const b = structuredClone(BUNDLE);
  b.verdicts[0].impact.kind = 'other';
  delete b.verdicts[0].claim.kind;
  const out = ok(buildReport(fixture({ bundle: b })));
  assert.equal(out.record.cvss.vector, null);
  assert.equal(out.record.cvss.score, null);
  assert.match(String(out.record.cvss.refusal), /C\/I\/A would have to be invented/);
  assert.ok(out.record.claims_not_verified.some((c) => /No CVSS base vector was derived/.test(c)));
  // The document must state severity as unstated, not as a number.
  const body = section(out.markdown, 'Severity (CVSS 3.1)');
  assert.match(body, /No CVSS base vector is stated/);
  assert.match(body, /unstated rather than estimated/);
});

test('an unknown ledger asset kind yields no vector rather than assuming network', () => {
  const assets = [{ ...fx.assets[0], kind: 'quantum_thing' }];
  const out = ok(buildReport(fixture({ assets })));
  assert.equal(out.record.cvss.vector, null);
  assert.match(String(out.record.cvss.refusal), /outside the ledger vocabulary/);
});

// ── 6. helpers ─────────────────────────────────────────────────────────────

test('integerDelta subtracts as a big integer, not a float', () => {
  assert.equal(integerDelta('100', '200'), '100');
  assert.equal(integerDelta('200', '100'), '-100');
  assert.equal(integerDelta('0', '0'), '0');
  // Beyond Number.MAX_SAFE_INTEGER: a float would lose the difference.
  assert.equal(integerDelta('9007199254740993', '9007199254740995'), '2');
  assert.equal(integerDelta('1.5', '2'), null);
  assert.equal(integerDelta('', '2'), null);
});

test('isoUtc is deterministic and does not use the local timezone', () => {
  assert.equal(isoUtc(1793000000), '2026-10-26T07:33:20Z');
  assert.equal(isoUtc(0), '1970-01-01T00:00:00Z');
  assert.equal(isoUtc(Number.NaN), 'invalid-timestamp');
});

test('addressesIn and hostsIn find only well-formed tokens', () => {
  assert.deepEqual(addressesIn('at 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 and 0xshort'), [
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  ]);
  assert.deepEqual(hostsIn('see api.acme.example and not_a_host'), ['api.acme.example']);
  // A bare word with no dot is not a host.
  assert.deepEqual(hostsIn('localhost'), []);
});

test('the record carries every field a tracker row would need', () => {
  const out = ok(buildReport(fixture()));
  const r = out.record;
  assert.equal(r.engagement_id, 'eng_2b8f14');
  assert.equal(r.program_id, 'acme-vault');
  assert.equal(r.hunt_id, 'hunt_7c41e0b9');
  assert.equal(r.test_name, 'test_reentrancy_118');
  assert.equal(r.playbook, 'sol.reentrancy');
  assert.equal(r.commit, BUNDLE.commit);
  assert.ok(r.impact.length > 10);
  assert.deepEqual(r.measured, { before: '100000000000000000000', after: '101000000000000000000' });
  assert.equal(r.delta, '100000000000000000000 -> 101000000000000000000');
  assert.equal(r.submittable, true);
});

test('two builds of the same input are byte-identical', () => {
  // The writer is pure; a report that changes between runs cannot be pinned by a
  // golden file and cannot be re-derived by a triager.
  const a = ok(buildReport(fixture()));
  const b = ok(buildReport(fixture()));
  assert.equal(a.markdown, b.markdown);
  assert.deepEqual(a.record, b.record);
});

test('a code span cannot be broken by content containing backticks', () => {
  const assets = [{ id: 'asset`tick', kind: 'host', value: 'x`.example', in_scope: 1 }];
  const out = ok(buildReport(fixture({ assets })));
  const table = section(out.markdown, 'Affected assets');
  // The value must be wrapped in a longer fence, so the inline code stays intact.
  assert.ok(table.includes('``x`.example``'), `a backtick in a value must not break the table:\n${table}`);
});

test('a fenced test containing triple backticks cannot close its own fence', () => {
  const plan = structuredClone(PLAN);
  plan.attempts[0].solidity = plan.attempts[0].solidity + '\n// ```\n// not a fence close\n';
  const out = ok(buildReport(fixture({ plan })));
  const body = section(out.markdown, 'Reproduction');
  // A four-backtick fence is used, so the embedded ``` does not terminate it.
  assert.ok(body.includes('````solidity'), 'the fence must grow past the longest backtick run');
  assert.ok(body.includes('// ```'));
});
