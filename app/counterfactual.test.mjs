// Counterfactual evidence tests — the path that makes `proven` reachable.
// Run with: node --test
//
// WHAT THESE PROVE, AND WHAT THEY DO NOT.
//
// Everything below exercises real code: `judge.mjs` reading real files off disk,
// `capture.mjs` running real child processes, `patch.ts` rewriting real source
// text, `poc.ts` emitting real Solidity. No fixture stands in for a function
// under test.
//
// What none of it can prove is that a Solidity campaign ran. `forge`, `solc` and
// `echidna` are all absent from this environment, so:
//   - the with-fix/`_nocond` runs are modelled by recorded exit files, and
//   - the generated Solidity is asserted structurally, never compiled.
// The CI workflow is what executes them for real. A structural assertion here
// says "the harness emits the measurement and the counterfactual the judge
// needs"; it says nothing about whether the target contract is vulnerable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { judge } from '../build/proof.js';
import { synthesize, HARNESSED } from '../build/poc.js';
import { synthesizeFromFuzz } from '../build/fuzzseed.js';
import { derivePatch } from '../build/patch.js';
import { adjudicatePlan, resolveCounterfactual, MECHANISMS } from '../build/judge.mjs';
import { parseImpact, parseExitFile, applyEdits, occurrences } from '../build/evidence.js';
import { runCapture, shQuote } from '../build/capture.mjs';

// ── fixtures ───────────────────────────────────────────────────────────

const dirs = [];
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'asterion-cf-'));
  dirs.push(d);
  return d;
}

/**
 * A results pair, mirroring the layout the workflow produces.
 *
 * `results/` holds run 1 (the attack). `counterfactual/` holds run 2. They are
 * separate because a with_fix run re-uses the attack's test NAME against a
 * patched tree: sharing one directory would let the second write overwrite the
 * first, making a reproduction look like a pass.
 *
 * The counterfactual file is keyed by the ATTEMPT name (the same key the attack
 * uses), not by the executed test name — that is what counterfactual.mjs writes,
 * because a counterfactual is produced once per attempt.
 */
function fixture({ attack, counterfactual = null } = {}) {
  const root = tmpDir();
  const resultsDir = join(root, 'results');
  const counterfactualDir = join(root, 'counterfactual');
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(counterfactualDir, { recursive: true });

  if (attack) record(resultsDir, attack.name, attack.exit, attack.out);
  if (counterfactual) {
    const key = counterfactual.key ?? attack?.name;
    if (counterfactual.reason) {
      writeFileSync(join(counterfactualDir, `${key}.reason`), counterfactual.reason);
    } else {
      record(counterfactualDir, key, counterfactual.exit, counterfactual.out ?? '');
    }
  }
  return { resultsDir, counterfactualDir };
}

/** Write one recorded run: `<name>.log` plus `<name>.exit`. */
function record(dir, name, exitCode, output) {
  writeFileSync(join(dir, `${name}.log`), output);
  writeFileSync(join(dir, `${name}.exit`), `EXIT=${exitCode}\n`);
}

const FAIL_OUT = [
  '[FAIL. Reason: REENTRANCY: extracted more than supplied]',
  '  IMPACT_BEFORE=100000000000000000000',
  '  IMPACT_AFTER=101000000000000000000',
  '  IMPACT_DESC=attacker-controlled ether before and after a reentrant withdrawal',
].join('\n');

const PASS_OUT = '[PASS] test_ok() (gas: 120000)';

/** One attempt whose counterfactual is the named second run. */
function attempt(overrides = {}) {
  return {
    test_name: 'test_reentrancy_1',
    playbook: 'sol.reentrancy',
    file: 'Vault.sol',
    line: 1,
    claim: { kind: 'value_transfer', description: 'attacker withdraws more than deposited' },
    counterfactual: { mechanism: 'with_fix', test_name: 'test_reentrancy_1' },
    ...overrides,
  };
}

// ── 1. the headline: a passing with_fix + valid impact IS provable ──────

test('a with_fix run that passes plus a measured impact yields proven', () => {
  const dirsnoCf = fixture({ attack: { name: 'test_reentrancy_1', exit: 1, out: FAIL_OUT } });
  const gated = adjudicatePlan({ contract: 'Vault', commit: 'c0ffee', attempts: [attempt()] }, dirsnoCf);
  // The patched run is absent, so this must NOT be proven.
  assert.equal(gated.verdicts[0].verdict, 'partial');
  assert.ok(gated.limitations.some((l) => /with_fix/.test(l)));

  // Same plan, same code path; the only difference is the evidence on disk.
  const withCf = fixture({
    attack: { name: 'test_reentrancy_1', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 0, out: PASS_OUT },
  });
  const s = adjudicatePlan({ contract: 'Vault', commit: 'c0ffee', attempts: [attempt()] }, withCf);

  assert.equal(s.verdicts[0].verdict, 'proven');
  assert.equal(s.verdicts[0].confidence, 'confirmed');
  assert.ok(s.verdicts[0].proven_claim.length > 10);
  assert.equal(s.proven, 1);
  assert.deepEqual(s.limitations, [], 'a fully evidenced attempt must not carry limitations');
});

test('proven carries the measured before/after into the verdict record', () => {
  const d = fixture({
    attack: { name: 't_a', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 0, out: PASS_OUT },
  });
  const s = adjudicatePlan(
    { contract: 'Vault', attempts: [attempt({ test_name: 't_a', counterfactual: { mechanism: 'with_fix', test_name: 't_a' } })] },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'proven');
  assert.deepEqual(s.verdicts[0].impact, {
    kind: 'value_transfer',
    before: '100000000000000000000',
    after: '101000000000000000000',
  });
  assert.deepEqual(s.verdicts[0].counterfactual, { mechanism: 'with_fix', test_name: 't_a' });
});

test('the attack run is not overwritten by the counterfactual of the same name', () => {
  // This is the reason for two directories. If they shared one, the second run
  // would clobber the first and the reproduction would silently vanish.
  const d = fixture({
    attack: { name: 'same_name', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 0, out: PASS_OUT },
  });
  assert.match(readFileSync(join(d.resultsDir, 'same_name.exit'), 'utf8'), /EXIT=1/);
  assert.match(readFileSync(join(d.counterfactualDir, 'same_name.exit'), 'utf8'), /EXIT=0/);
});

// ── 2. the counterfactual must actually pass ───────────────────────────

test('a with_fix run that still fails stays partial', () => {
  const d = fixture({
    attack: { name: 't_a', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 1, out: '[FAIL. Reason: REENTRANCY: still broken]' },
  });
  const s = adjudicatePlan(
    { contract: 'V', attempts: [attempt({ test_name: 't_a', counterfactual: { mechanism: 'with_fix', test_name: 't_a' } })] },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
  assert.equal(s.verdicts[0].proven_claim, null);
  assert.ok(s.verdicts[0].reasons.some((r) => /still fails with the fix/.test(r)));
});

test('no counterfactual at all is still partial (regression)', () => {
  const d = fixture({ attack: { name: 't_a', exit: 1, out: FAIL_OUT } });
  const s = adjudicatePlan(
    { contract: 'V', attempts: [attempt({ test_name: 't_a', counterfactual: undefined })] },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
  assert.equal(s.verdicts[0].counterfactual, null);
  assert.ok(s.limitations.some((l) => /did not plan a counterfactual/.test(l)));
});

test('a planned counterfactual that was never recorded is named per attempt', () => {
  const d = fixture({ attack: { name: 't_a', exit: 1, out: FAIL_OUT } });
  const s = adjudicatePlan(
    {
      contract: 'V',
      attempts: [
        attempt({ test_name: 't_a', counterfactual: { mechanism: 'without_precondition', test_name: 't_nocond' } }),
      ],
    },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
  assert.ok(
    s.limitations.some((l) => /t_a/.test(l) && /never recorded/.test(l)),
    'the limitation must name the attempt, not be a blanket statement',
  );
});

test("the counterfactual script's own reason is surfaced, not hidden", () => {
  const d = fixture({
    attack: { name: 't_a', exit: 1, out: FAIL_OUT },
    counterfactual: { reason: 'the derived patch does not apply: edit 0 matched 0 time(s)' },
  });
  const s = adjudicatePlan(
    { contract: 'V', attempts: [attempt({ test_name: 't_a', counterfactual: { mechanism: 'with_fix', test_name: 't_a' } })] },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
  assert.ok(
    s.limitations.some((l) => /patch does not apply/.test(l)),
    'the reason the counterfactual was not produced must reach the bundle',
  );
});

test('the limitations field never launders a fully evidenced attempt', () => {
  const d = fixture({
    attack: { name: 'a_good', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 0, out: PASS_OUT },
  });
  record(d.resultsDir, 'b_bare', 1, FAIL_OUT);

  const s = adjudicatePlan(
    {
      contract: 'V',
      attempts: [
        attempt({ test_name: 'a_good', counterfactual: { mechanism: 'with_fix', test_name: 'a_good' } }),
        attempt({ test_name: 'b_bare', playbook: 'sol.dos', claim: { kind: 'denial', description: 'y' }, counterfactual: undefined }),
      ],
    },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'proven');
  assert.equal(s.verdicts[1].verdict, 'partial');
  assert.ok(
    s.limitations.every((l) => l.includes('b_bare')),
    'only the attempt that lacked evidence may appear in limitations',
  );
});

// ── 3. the impact gate ─────────────────────────────────────────────────

test('impact before == after stays partial', () => {
  const out = ['[FAIL. Reason: x]', 'IMPACT_BEFORE=100', 'IMPACT_AFTER=100', 'IMPACT_DESC=no movement'].join('\n');
  const d = fixture({
    attack: { name: 't_a', exit: 1, out },
    counterfactual: { exit: 0, out: PASS_OUT },
  });
  const s = adjudicatePlan(
    { contract: 'V', attempts: [attempt({ test_name: 't_a', counterfactual: { mechanism: 'with_fix', test_name: 't_a' } })] },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
  assert.ok(s.verdicts[0].reasons.some((r) => /identical/.test(r)));
});

test('a missing impact stays partial even with perfect causality', () => {
  const d = fixture({
    attack: { name: 't_a', exit: 1, out: '[FAIL. Reason: x]' },
    counterfactual: { exit: 0, out: PASS_OUT },
  });
  const s = adjudicatePlan(
    { contract: 'V', attempts: [attempt({ test_name: 't_a', counterfactual: { mechanism: 'with_fix', test_name: 't_a' } })] },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
  assert.equal(s.verdicts[0].impact, null);
  assert.ok(s.limitations.some((l) => /not measured/.test(l)));
});

// ── 4. IMPACT_* parsing ────────────────────────────────────────────────

test('IMPACT_BEFORE/AFTER/DESC parse out of a mock forge trace', () => {
  const trace = [
    'Ran 1 test for test/Vault.t.sol:Vault_PoC',
    '[PASS] setUp() (gas: 12000)',
    '  attacker delta=-1000000000000000000',
    '  IMPACT_BEFORE=100000000000000000000',
    '  IMPACT_AFTER=99000000000000000000',
    '  IMPACT_DESC=attacker-controlled ether before and after a reentrant withdrawal (delta logged)',
    'Traces:',
    '  [1000] Vault_PoC.test_reentrancy_1()',
    '[FAIL. Reason: REENTRANCY: extracted more than supplied]',
  ].join('\n');

  assert.deepEqual(parseImpact(trace), {
    description: 'attacker-controlled ether before and after a reentrant withdrawal (delta logged)',
    measured: { before: '100000000000000000000', after: '99000000000000000000' },
  });
});

test('parseImpact refuses duplicate or partial markers rather than guessing', () => {
  assert.equal(parseImpact(''), null);
  assert.equal(parseImpact('no markers here'), null);
  // Missing DESC.
  assert.equal(parseImpact('IMPACT_BEFORE=1\nIMPACT_AFTER=2'), null);
  // Empty value.
  assert.equal(parseImpact('IMPACT_BEFORE=\nIMPACT_AFTER=2\nIMPACT_DESC=d'), null);
  // Duplicated BEFORE: two runs concatenated, ambiguous.
  assert.equal(parseImpact('IMPACT_BEFORE=1\nIMPACT_BEFORE=3\nIMPACT_AFTER=2\nIMPACT_DESC=d'), null);
});

test('a marker appearing inside an indented trace line is still read', () => {
  // forge prefixes console output with trace indentation; the parser must not
  // require the marker to be at column 0.
  const got = parseImpact('    IMPACT_BEFORE=5\n\tIMPACT_AFTER=7\n  IMPACT_DESC=moved');
  assert.deepEqual(got.measured, { before: '5', after: '7' });
});

// ── 5. exit-code capture is the TEST's, not tee's ──────────────────────

test('the tee trap is real: a pipeline exits 0 when its command fails', () => {
  // The control that documents the bug. If this ever prints 1, the assumption
  // behind runCapture no longer holds and the design needs revisiting — so it
  // is asserted, not assumed.
  const log = join(tmpDir(), 'trap.log');
  const r = spawnSync('sh', ['-c', `sh -c 'exit 1' 2>&1 | tee ${shQuote(log)}; echo $?`], {
    encoding: 'utf8',
  });
  assert.equal(r.stdout.trim(), '0', 'tee masks the failing status; that is the bug');
});

test('runCapture reports the TEST exit status, not the tee status', () => {
  const logPath = join(tmpDir(), 'nested', 'run.log');

  const fail = runCapture("sh -c 'echo boom; exit 1'", { logPath });
  assert.equal(fail.exit_code, 1, 'a failing command must not be recorded as 0');
  assert.match(fail.log, /boom/, 'the log must still be teed to disk');

  const pass = runCapture("sh -c 'echo fine; exit 0'", { logPath });
  assert.equal(pass.exit_code, 0);
  assert.match(pass.log, /fine/);
});

test('runCapture keeps a mid-pipeline failure visible through pipefail', () => {
  const logPath = join(tmpDir(), 'pipe.log');
  // A pipeline whose FIRST element fails: only pipefail surfaces this.
  const r = runCapture("sh -c 'exit 3' | cat", { logPath });
  assert.equal(r.exit_code, 3, 'pipefail must surface the left-hand failure');
});

test('parseExitFile reads only a well-formed uppercase EXIT=<n>', () => {
  assert.equal(parseExitFile('EXIT=0'), 0);
  assert.equal(parseExitFile('EXIT=137\n'), 137);
  assert.equal(parseExitFile(''), null);
  assert.equal(parseExitFile('exit=0'), null, 'lowercase must not match');
  assert.equal(parseExitFile('EXIT=abc'), null);
  assert.equal(parseExitFile(null), null);
  assert.equal(parseExitFile(undefined), null);
});

// ── 6. a run with no EXIT file is NOT a pass ───────────────────────────

test('a log with no EXIT file is unknown, never a pass', () => {
  const d = fixture();
  writeFileSync(join(d.resultsDir, 't.log'), '[PASS] looks fine but no exit was recorded');

  const s = adjudicatePlan(
    { contract: 'V', attempts: [attempt({ test_name: 't', counterfactual: undefined })] },
    d,
  );
  assert.notEqual(s.verdicts[0].verdict, 'disproved', 'unknown must not become "not present"');
  assert.notEqual(s.verdicts[0].verdict, 'proven');
  assert.ok(s.limitations.some((l) => /EXIT= file/.test(l)));
});

test('a test with no recorded run at all is inconclusive', () => {
  const d = fixture();
  const s = adjudicatePlan(
    { contract: 'V', attempts: [attempt({ test_name: 'never_ran', counterfactual: undefined })] },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'inconclusive');
  assert.equal(s.verdicts[0].exit_code, null);
  assert.ok(s.limitations.some((l) => /no attack run was recorded/.test(l)));
});

test('resolveCounterfactual rejects an unknown mechanism', () => {
  const d = fixture();
  const got = resolveCounterfactual({ counterfactual: { mechanism: 'vibes', test_name: 'x' } }, d);
  assert.match(got.missing, /unknown counterfactual mechanism/);
  assert.deepEqual([...MECHANISMS].sort(), ['with_fix', 'without_precondition']);
});

test('the counterfactual is located by ATTEMPT name, not the executed test name', () => {
  // counterfactual.mjs writes `counterfactual/<attempt>.exit` because a
  // counterfactual is produced once per attempt. For without_precondition the
  // EXECUTED test is `<attempt>_nocond`, so looking up by that name misses the
  // file entirely — which reported a genuinely causal plan as partial until an
  // end-to-end run caught it.
  const d = fixture({
    attack: { name: 'test_rounding_7', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 0, out: PASS_OUT }, // keyed by attack name
  });
  const a = attempt({
    test_name: 'test_rounding_7',
    counterfactual: { mechanism: 'without_precondition', test_name: 'test_rounding_7_nocond' },
  });

  const got = resolveCounterfactual(a, d);
  assert.equal(got.missing, undefined, `expected a run, got: ${got.missing}`);
  assert.equal(got.mechanism, 'without_precondition');
  assert.equal(got.run.exit_code, 0);

  // And the verdict follows: proven, because the nocond run really passed.
  const s = adjudicatePlan({ contract: 'V', attempts: [a] }, d);
  assert.equal(s.verdicts[0].verdict, 'proven');
});

test('a counterfactual recorded under the wrong key is not found', () => {
  // Guards the fix above from being "solved" by broadening the lookup to try
  // every plausible name: an attempt whose file is missing must stay partial.
  const d = fixture({
    attack: { name: 'test_rounding_7', exit: 1, out: FAIL_OUT },
    counterfactual: { key: 'test_rounding_7_nocond', exit: 0, out: PASS_OUT },
  });
  const s = adjudicatePlan(
    {
      contract: 'V',
      attempts: [
        attempt({
          test_name: 'test_rounding_7',
          counterfactual: { mechanism: 'without_precondition', test_name: 'test_rounding_7_nocond' },
        }),
      ],
    },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
});

// ── 7. the _nocond run is a real counterfactual, for every harness ─────

const lead = (playbook) => ({ playbook, file: 'Vault.sol', line: 7, snippet: 'x', severity: 'high' });

test('every harnessed class emits a _nocond test that keeps an assertion', () => {
  for (const pb of HARNESSED) {
    const spec = synthesize(lead(pb), { contract: 'Vault', forkBlock: 30000000 });
    assert.ok(spec, `${pb} should synthesize`);
    assert.equal(spec.nocond_name, `${spec.test_name}_nocond`, `${pb} nocond naming`);
    assert.ok(spec.solidity.includes(`function ${spec.nocond_name}() public`), `${pb} nocond body missing`);

    // The nocond body must contain its own assertion: a counterfactual that
    // merely re-runs setup proves nothing about the claim.
    const at = spec.solidity.indexOf(`function ${spec.nocond_name}() public`);
    const body = spec.solidity.slice(at);
    assert.match(body, /assert(Lt|Le|True|False|NotEq|Eq)\(/, `${pb} nocond has no assertion`);
    assert.match(body, /NOCOND:/, `${pb} nocond assertion is not labelled`);
  }
});

test('the nocond body differs from the control body', () => {
  // If they were identical the "counterfactual" would just be a second fixture
  // check and could not establish causality.
  for (const pb of HARNESSED) {
    const spec = synthesize(lead(pb), { contract: 'Vault', forkBlock: 1 });
    const ctlAt = spec.solidity.indexOf(`function ${spec.control_name}() public`);
    const nocAt = spec.solidity.indexOf(`function ${spec.nocond_name}() public`);
    assert.ok(ctlAt > -1 && nocAt > ctlAt, `${pb}: control then nocond`);

    const ctl = spec.solidity.slice(ctlAt, nocAt);
    const noc = spec.solidity.slice(nocAt);
    assert.notEqual(ctl.trim(), noc.trim(), `${pb}: nocond must not duplicate the control`);
  }
});

test('every harness reports whether it deploys its own contract', () => {
  // This flag decides whether a with_fix run is legitimate at all: a harness
  // attached to a deployed address cannot observe a source patch.
  for (const pb of HARNESSED) {
    const spec = synthesize(lead(pb), { contract: 'Vault', forkBlock: 1 });
    assert.equal(typeof spec.self_deployed, 'boolean', `${pb} must declare self_deployed`);
  }
  assert.equal(synthesize(lead('sol.upgrade'), { contract: 'V', forkBlock: 1 }).self_deployed, true);
  assert.equal(synthesize(lead('sol.reentrancy'), { contract: 'V', forkBlock: 1 }).self_deployed, false);
});

// ── 8. the measurement is emitted by the generated Solidity ────────────

test('every harness prints IMPACT_BEFORE/AFTER/DESC from _impact', () => {
  for (const pb of HARNESSED) {
    const spec = synthesize(lead(pb), { contract: 'Vault', forkBlock: 1 });
    assert.match(
      spec.solidity,
      /function _impact\(uint256 before_, uint256 after_, string memory desc\)/,
      `${pb}: _impact helper missing`,
    );
    assert.match(spec.solidity, /"IMPACT_BEFORE="/, `${pb}: BEFORE marker missing`);
    assert.match(spec.solidity, /"IMPACT_AFTER="/, `${pb}: AFTER marker missing`);
    assert.match(spec.solidity, /"IMPACT_DESC="/, `${pb}: DESC marker missing`);

    // The ATTACK test must actually call it, or a reproduction carries no numbers.
    const at = spec.solidity.indexOf(`function ${spec.test_name}() public`);
    const nextFn = spec.solidity.indexOf('function ', at + 1);
    const attackBody = spec.solidity.slice(at, nextFn > -1 ? nextFn : undefined);
    assert.match(attackBody, /_impact\(/, `${pb}: attack never measures`);
  }
});

test('the fuzz replay also emits the measurement markers', () => {
  const seed = {
    transactions: [
      { function: 'deposit', arguments: [], value: '1' },
      { function: 'withdraw', arguments: ['1'], value: '0' },
    ],
    reason: 'ReturnFalse',
    status: 'solved',
    caveats: [],
  };
  const spec = synthesizeFromFuzz(seed, {
    contract: 'Vault',
    forkBlock: 1,
    abi: { deposit: [], withdraw: ['uint256'] },
  });
  assert.match(spec.solidity, /"IMPACT_BEFORE="/);
  assert.match(spec.solidity, /"IMPACT_AFTER="/);
  assert.ok(spec.solidity.includes(`function ${spec.nocond_name}() public`));
  assert.equal(spec.self_deployed, false);

  // And the emitted markers must be the ones the parser accepts.
  const fakeTrace = '  IMPACT_BEFORE=10\n  IMPACT_AFTER=9\n  IMPACT_DESC=actor lost funds';
  assert.deepEqual(parseImpact(fakeTrace).measured, { before: '10', after: '9' });
});

test('generated deltas are signed so a loss cannot underflow into a panic', () => {
  // `uint256 after - uint256 before` reverts on the normal (non-buggy) case,
  // and that panic matches judge()'s real-assertion patterns. A harness that
  // manufactures its own failure is worse than no harness.
  const spec = synthesize(lead('sol.reentrancy'), { contract: 'Vault', forkBlock: 1 });
  assert.match(spec.solidity, /int256 delta = int256\(after_\) - int256\(before_\)/);
  assert.match(spec.solidity, /assertLt\(delta, int256\(1 ether\)/);
  assert.doesNotMatch(spec.solidity, /assertLt\(after_ - before_/);
});

test('the reentrancy attack counts value held by the attacker contract', () => {
  // A gain landing in the helper contract is still a gain; measuring only the
  // EOA would under-report a real exploit.
  const spec = synthesize(lead('sol.reentrancy'), { contract: 'Vault', forkBlock: 1 });
  assert.match(spec.solidity, /attacker\.balance \+ address\(r\)\.balance/);
});

// ── 9. patch derivation is derived from real source, and refuses ───────

const REENTRANT_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vault {
    mapping(address => uint256) public balances;
    address public owner;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] -= amount;
    }
}
`;

const lineOf = (src, rx) => src.split('\n').findIndex((l) => rx.test(l)) + 1;

test('a reentrancy patch moves the state write above the external call', () => {
  const got = derivePatch('sol.reentrancy', 'src/Vault.sol', REENTRANT_VAULT, lineOf(REENTRANT_VAULT, /\.call\{value:/));
  assert.equal(got.ok, true, got.ok ? '' : got.reason);

  const applied = applyEdits(REENTRANT_VAULT, got.patch.edits);
  assert.equal(applied.ok, true, applied.ok ? '' : applied.reason);

  const lines = applied.source.split('\n');
  const callAt = lines.findIndex((l) => /\.call\{value:/.test(l));
  const writeAt = lines.findIndex((l) => /balances\[msg\.sender\] -= amount/.test(l));
  assert.ok(writeAt > -1 && callAt > -1);
  assert.ok(writeAt < callAt, 'the state write must now precede the external call');
  // A swap changes no line count and no other line.
  assert.equal(applied.source.split('\n').length, REENTRANT_VAULT.split('\n').length);
  assert.equal(
    applied.source.split('\n').filter((l) => l.trim()).length,
    REENTRANT_VAULT.split('\n').filter((l) => l.trim()).length,
  );
});

test('the reentrancy patch refuses when the call has no following state write', () => {
  // Checks-effects already in place: there is nothing to swap, so claiming a
  // fix here would be inventing one.
  const safe = `contract V {
    mapping(address => uint256) public balances;
    function withdraw(uint256 amount) external {
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "x");
    }
}
`;
  const got = derivePatch('sol.reentrancy', 'src/V.sol', safe, lineOf(safe, /\.call\{value:/));
  assert.equal(got.ok, false);
  assert.match(got.reason, /no state write follows/);
});

test('a modifier patch is refused when the modifier does not exist in the file', () => {
  const noOnlyOwner = 'contract V {\n    function setOwner(address a) external {\n        owner = a;\n    }\n}\n';
  const got = derivePatch('sol.accesscontrol', 'src/V.sol', noOnlyOwner, 2);
  assert.equal(got.ok, false);
  assert.match(got.reason, /never mentions `onlyOwner`/);
});

test('a modifier patch is derived when the modifier is already declared', () => {
  const withMod = `contract V {
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    function setOwner(address a) external {
        owner = a;
    }
}
`;
  const got = derivePatch('sol.accesscontrol', 'src/V.sol', withMod, 5);
  assert.equal(got.ok, true, got.ok ? '' : got.reason);
  const applied = applyEdits(withMod, got.patch.edits);
  assert.equal(applied.ok, true);
  assert.match(applied.source, /function setOwner\(address a\) external onlyOwner \{/);
});

test('classes with no mechanically honest fix are refused, not guessed', () => {
  for (const pb of ['sol.oracle', 'sol.rounding', 'sol.inflation', 'sol.dos', 'sol.flashloan', 'web.idor']) {
    const got = derivePatch(pb, 'src/V.sol', REENTRANT_VAULT, 13);
    assert.equal(got.ok, false, `${pb} must refuse`);
    assert.match(got.reason, /no minimal/);
  }
});

test('an edit whose match count is wrong is refused wholesale', () => {
  // A half-applied patch would make the "with-fix" run a different program than
  // the rationale describes, so a count mismatch must not partially apply.
  const got = applyEdits('aXbXc', [{ find: 'X', replace: 'Y', expect: 1 }]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /matched 2 time\(s\), expected 1/);
});

test('a two-line swap applies in one pass, not sequentially', () => {
  // Sequential replacement would rewrite the first line, then match the text it
  // just inserted and rewrite it again. A swap is the exact case that exposes it.
  const got = applyEdits('A\nB\n', [
    { find: 'A\n', replace: 'B\n', expect: 1 },
    { find: 'B\n', replace: 'A\n', expect: 1 },
  ]);
  assert.equal(got.ok, true, got.ok ? '' : got.reason);
  assert.equal(got.source, 'B\nA\n');
});

test('occurrences counts literals, not regexes', () => {
  assert.equal(occurrences('a.b.c', '.'), 2);
  assert.equal(occurrences('a*b', '*'), 1);
  assert.equal(occurrences('abc', ''), 0);
});

// ── 10. plan-level wiring: proven is reachable end to end ──────────────

test('a plan whose nocond run passes and whose impact moved is provable', () => {
  const d = fixture({
    attack: { name: 'test_rounding_3', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 0, out: PASS_OUT },
  });
  const plan = {
    contract: 'Vault',
    commit: 'deadbeef',
    attempts: [
      attempt({
        test_name: 'test_rounding_3',
        playbook: 'sol.rounding',
        line: 3,
        claim: { kind: 'value_transfer', description: 'repeated ops extract value' },
        counterfactual: { mechanism: 'without_precondition', test_name: 'test_rounding_3_nocond' },
      }),
    ],
  };

  const s = adjudicatePlan(plan, d, { huntId: 'h-1' });
  assert.equal(s.attempts, 1);
  assert.equal(s.proven, 1);
  assert.equal(s.hunt_id, 'h-1');
  assert.equal(s.verdicts[0].verdict, 'proven');
  assert.ok(s.verdicts[0].proven_claim);
});

test('a plan where the nocond run also fails is partial', () => {
  const d = fixture({
    attack: { name: 'a', exit: 1, out: FAIL_OUT },
    counterfactual: { exit: 1, out: '[FAIL. Reason: NOCOND: still leaking]' },
  });
  const s = adjudicatePlan(
    {
      contract: 'V',
      attempts: [
        attempt({
          test_name: 'a',
          playbook: 'sol.rounding',
          counterfactual: { mechanism: 'without_precondition', test_name: 'a_n' },
        }),
      ],
    },
    d,
  );
  assert.equal(s.verdicts[0].verdict, 'partial');
});

test('an empty plan adjudicates to zeros rather than throwing', () => {
  const s = adjudicatePlan({ contract: 'V', attempts: [] }, fixture());
  assert.equal(s.attempts, 0);
  assert.equal(s.proven, 0);
  assert.deepEqual(s.verdicts, []);
  assert.deepEqual(s.limitations, []);
});

test('judge still refuses proven when causality holds but impact is empty', () => {
  // Belt-and-braces at the contract level: the impact gate is not something
  // adjudicatePlan can bypass.
  const r = judge({
    hypothesis_id: 'h',
    commit: 'c',
    test_name: 't',
    reproduced: { exit_code: 1, output: FAIL_OUT, failure_reason: null, duration_ms: 1 },
    with_fix: { exit_code: 0, output: PASS_OUT, failure_reason: null, duration_ms: 1 },
    impact: { kind: 'value_transfer', description: 'd', measured: { before: '', after: '' } },
  });
  assert.equal(r.verdict, 'partial');
});

// ── 11. the CLI writes verdicts (the workflow depends on this) ─────────
test('judge.mjs is importable without side effects', () => {
  // If the direct-invocation guard were broken, importing this module in the
  // test process would try to read plan.json and write verdicts.json.
  assert.equal(typeof adjudicatePlan, 'function');
  assert.equal(existsSync('verdicts.json'), false, 'import must not write output');
});

// ── 12. plan.mjs picks a mechanism that is actually observable ─────────

test('plan.mjs chooses with_fix only for a self-deploying harness with a derivable patch', () => {
  // Runs the real CLI against a scratch checkout. This is the plan-level
  // contract the workflow depends on: judge() cannot use a with_fix run from a
  // harness that attaches to a deployed address, so plan.mjs must not offer one.
  const root = tmpDir();
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, 'Proxy.sol'),
    `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Proxy {
    address public owner;
    bool private initialized;
    modifier initializer() { require(!initialized, "init"); initialized = true; _; }

    function initialize(address o) public {
        owner = o;
    }
}
`,
  );

  const planPath = join(root, 'plan.json');
  const r = spawnSync(
    process.execPath,
    ['build/plan.mjs', '--target', root, '--contract', 'Proxy', '--fork-block', '1', '--out', planPath],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const upgrade = plan.attempts.find((a) => a.playbook === 'sol.upgrade');
  assert.ok(upgrade, 'the unguarded initializer should be a lead');

  // The initializer harness deploys its own instance, so a source patch IS
  // observable -> with_fix, with a real single-line edit.
  assert.equal(upgrade.counterfactual.mechanism, 'with_fix');
  assert.equal(upgrade.counterfactual.patch.edits.length, 1);
  assert.match(upgrade.counterfactual.patch.edits[0].replace, /public initializer \{/);

  // The TARGET-attached classes must NOT offer with_fix, and must say why.
  for (const a of plan.attempts) {
    if (a.playbook === 'sol.upgrade') continue;
    assert.equal(a.counterfactual.mechanism, 'without_precondition', `${a.playbook} must not offer with_fix`);
    assert.ok(
      typeof a.counterfactual.why_not_with_fix === 'string' && a.counterfactual.why_not_with_fix.length > 20,
      `${a.playbook} must state why with_fix was refused`,
    );
  }
});
