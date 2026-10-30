/**
 * B7 + B8 — dispatch coverage, and the Solana refusal.
 *
 * TWO DEAD-DISPATCH BUGS, ONE ROOT CAUSE
 *
 * B7. `HARNESSED` listed 7 classes while 10 sol.* EVM classes were dispatchable.
 *     `sol.signature`, `sol.delegatecall` and `sol.flashloan` passed
 *     deriveProveInputs, queued a Foundry job, ran for minutes, and could never
 *     produce a finding because `synthesize()` returned null for them: the plan
 *     came back with zero attempts and the run was structurally incapable of
 *     reporting anything. It looked like a legitimate run.
 *
 * B8. `sol.svm-{signer,account,cpi}` declared `cls: 'solidity'` with no executor
 *     at all (`svm-harness.ts` does not exist). They passed deriveProveInputs and
 *     dispatched a FOUNDRY job at an Anchor program — guaranteed `inconclusive`,
 *     indistinguishable from a real attempt.
 *
 * THE INVARIANT THIS FILE EXISTS FOR
 *
 *     dispatchable ⊆ HARNESSED
 *
 * computed from the SAME source of truth the dispatcher uses
 * (`DISPATCHER_CLASSES` in playbooks.ts), never from a hand-written list. If a
 * future class is made dispatchable without a harness, this fails here instead
 * of burning twenty minutes of CI on a run that cannot conclude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { synthesize, HARNESSED, UNPLAYBOOKED_HARNESSES, hasHarness } from '../build/poc.js';
import {
  PLAYBOOKS,
  DISPATCHER_CLASSES,
  dispatchablePlaybookIds,
  byId,
} from '../build/playbooks.js';
import { PROVABLE_CLASSES, noPlaneReason } from '../build/dispatch.js';

const lead = (playbook) => ({ playbook, file: 'V.sol', line: 7, snippet: 'x', severity: 'high' });

// ── 1. the headline invariant ───────────────────────────────────────────────

test('dispatchable ⊆ HARNESSED, computed from the dispatcher source of truth', () => {
  const dispatchable = dispatchablePlaybookIds();
  assert.ok(dispatchable.length > 0, 'the dispatcher must be able to dispatch something');

  const orphans = dispatchable.filter((id) => !HARNESSED.has(id));
  assert.deepEqual(
    orphans,
    [],
    'these classes are dispatchable but have no harness, so a run can never produce a ' +
      'finding: ' + orphans.join(', '),
  );
});

test('every dispatchable class actually synthesizes a spec (not just appears in the set)', () => {
  // Membership in a Set is a claim; synthesize() returning a spec is the fact.
  // A stub harness registered in HARNESSED would pass the test above and fail
  // this one, which is exactly the "do not add a class whose harness is a stub"
  // constraint.
  for (const id of dispatchablePlaybookIds()) {
    const spec = synthesize(lead(id), { contract: 'Vault', forkBlock: 30_000_000, chainId: 8453 });
    assert.ok(spec, `${id} is dispatchable but synthesize() returns null`);
    assert.ok(spec.solidity.length > 500, `${id}: harness body is implausibly short (a stub?)`);
    assert.ok(spec.solidity.includes(`function ${spec.test_name}() public`), `${id}: no attack test`);
    assert.ok(spec.solidity.includes(`function ${spec.control_name}() public`), `${id}: no control`);
    assert.ok(spec.solidity.includes(`function ${spec.nocond_name}() public`), `${id}: no nocond`);
    // The precondition-removed run must differ from the control, or it is just a
    // second fixture check and cannot establish causality.
    const ctlAt = spec.solidity.indexOf(`function ${spec.control_name}() public`);
    const nocAt = spec.solidity.indexOf(`function ${spec.nocond_name}() public`);
    assert.ok(ctlAt > -1 && nocAt > ctlAt, `${id}: control then nocond`);
    assert.notEqual(
      spec.solidity.slice(ctlAt, nocAt).trim(),
      spec.solidity.slice(nocAt).trim(),
      `${id}: nocond must not duplicate the control`,
    );
  }
});

test('every HARNESSED member is a real playbook AND synthesizes', () => {
  // Two claims at once, and both matter:
  //   · it must be a playbook, or `rank()` would report a harness for a class the
  //     operator cannot select;
  //   · it must synthesize, or the harness is a stale claim and the class
  //     dead-dispatches again.
  for (const id of HARNESSED) {
    assert.ok(byId(id), `${id} is in HARNESSED but is not a playbook id at all`);
    assert.ok(synthesize(lead(id), { contract: 'V', forkBlock: 1 }), `${id} in HARNESSED but not synthesizable`);
  }
});

test('the 3 dispatchable classes that motivated B7 are harnessed and dispatchable', () => {
  // These three were the actual dead-dispatch bug: they had PLAYBOOKS rows and
  // were dispatchable, but synthesize() returned null, so a run queued a job that
  // could never express a finding.
  for (const id of ['sol.signature', 'sol.delegatecall', 'sol.flashloan']) {
    assert.ok(hasHarness(id), `${id} must be harnessed (B7)`);
    assert.ok(byId(id), `${id} must be a playbook`);
    assert.ok(DISPATCHER_CLASSES.has(byId(id).cls), `${id} must still be dispatchable`);
    assert.ok(dispatchablePlaybookIds().includes(id), `${id} must appear in the dispatchable set`);
  }
  assert.equal(HARNESSED.size, 10, 'HARNESSED is 10 sol.* classes; pinned so drift is visible');
  assert.equal(PLAYBOOKS.filter((p) => p.cls === 'solidity').length, 10, 'and matches the playbook set');
});

test('sol.overflow and sol.mev have real harnesses but are NOT claimed as classes', () => {
  // Both were specified as part of B7 and both are implemented in full (attack +
  // control + nocond, measured delta). But neither has a PLAYBOOKS row and neither
  // has a class in corpus-digest.json, and a capability is added to this project by
  // adding a playbook. So the harness exists and is registered as such, while
  // HARNESSED — which `rank()` and the coverage invariant read — stays honest and
  // does not claim a class the operator cannot select.
  for (const id of ['sol.overflow', 'sol.mev']) {
    assert.ok(UNPLAYBOOKED_HARNESSES.has(id), `${id} must be registered as an implemented harness`);
    assert.equal(byId(id), undefined, `${id} must genuinely have no playbook`);
    assert.equal(hasHarness(id), false, `${id} must not be claimed as a harnessed CLASS`);
    assert.equal(dispatchablePlaybookIds().includes(id), false, `${id} cannot be dispatchable`);

    // The harness itself is real, not a stub.
    const spec = synthesize(lead(id), { contract: 'Vault', forkBlock: 30_000_000, chainId: 8453 });
    assert.ok(spec, `${id}: harness must synthesize`);
    assert.ok(spec.solidity.length > 500, `${id}: harness body implausibly short (a stub?)`);
    assert.ok(spec.solidity.includes(`function ${spec.test_name}() public`));
    assert.ok(spec.solidity.includes(`function ${spec.control_name}() public`));
    assert.ok(spec.solidity.includes(`function ${spec.nocond_name}() public`));
  }
});

test('every sol.* EVM playbook is harnessed, so no EVM class can dead-dispatch', () => {
  // Stronger than the subset relation: the point of B7 is that a sol.* class
  // with no harness is a class the bot will queue and then fail to express.
  const solEVM = PLAYBOOKS.filter((p) => p.cls === 'solidity').map((p) => p.id);
  const missing = solEVM.filter((id) => !HARNESSED.has(id));
  assert.deepEqual(missing, [], `solidity classes with no harness: ${missing.join(', ')}`);
});

// ── 3. the dispatcher's source of truth is coherent ────────────────────────

test('DISPATCHER_CLASSES and PROVABLE_CLASSES agree', () => {
  // Two sets that must not drift: one says which classes may be dispatched, the
  // other says which classes the workflow can prove. If they diverged, a class
  // could be dispatched into a plane that refuses it (or vice versa).
  assert.deepEqual(
    [...DISPATCHER_CLASSES].sort(),
    [...PROVABLE_CLASSES].sort(),
    'a class must be dispatchable exactly when a plane can prove it',
  );
});

test('every class a brief can take is either dispatchable or refused by name', () => {
  const all = ['web2', 'solidity', 'infra', 'solana'];
  for (const cls of all) {
    const dispatchable = DISPATCHER_CLASSES.has(cls);
    const provable = PROVABLE_CLASSES.has(cls);
    assert.equal(dispatchable, provable, `${cls}: membership must match`);
    if (!dispatchable) {
      // The refusal must exist and be specific for this class, not a fallback.
      assert.match(noPlaneReason(cls), /proof plane/);
    }
  }
});

test('no playbook is both plane-less and claimed by the dispatcher', () => {
  for (const p of PLAYBOOKS) {
    if (!DISPATCHER_CLASSES.has(p.cls)) {
      assert.ok(
        !dispatchablePlaybookIds().includes(p.id),
        `${p.id} is ${p.cls} and must not be dispatchable`,
      );
    }
  }
});
