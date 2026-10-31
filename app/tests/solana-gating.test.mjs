/**
 * B8 — Solana dispatch gating.
 *
 * THE BUG. `sol.svm-{signer,account,cpi}` declared `cls: 'solidity'` with NO
 * executor at all. Because they claimed the Foundry class they passed
 * deriveProveInputs and dispatched a FOUNDRY job at an Anchor program: a
 * guaranteed `inconclusive` that was indistinguishable from a legitimate run.
 * That is worse than a refusal, because a refusal is information.
 *
 * THE FIX, in two halves. B8 (Task 4) gave them their own class (`solana`), made
 * the provable set a SET so the refusal keeps firing for every class with no
 * plane, and made the refusal NAME the missing plane.
 *
 * Task 6 then BUILT the plane — `prove-solana.yml` runs on solana-bankrun — so
 * what this file pins is no longer "the whole class refuses". It is the sharper
 * property that made B8 a bug in the first place:
 *
 *   · the class is in the provable set, because a plane exists
 *   · `sol.svm-signer` has a harness; `sol.svm-account` and `sol.svm-cpi` do NOT,
 *     and refuse by name with `missing: ['playbook']` — a DIFFERENT refusal from
 *     "no plane", because it sends the operator somewhere different
 *   · every one of the three routes to `prove-solana.yml`, never `prove.yml`
 *
 * The end-to-end assertion that no Foundry job is queued (a fetch spy showing
 * the exact URL) lives in dispatch.test.mjs, where the real approval -> dispatch
 * chain runs against real SQLite.
 *
 * The end-to-end proof that no Foundry job is queued (fetch never called) lives
 * in dispatch.test.mjs, where the real approval -> dispatch chain runs against
 * real SQLite with a fetch spy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { synthesize, HARNESSED } from '../build/poc.js';
import { PLAYBOOKS, byId } from '../build/playbooks.js';
import {
  DISPATCHER_CLASSES,
  PLANES,
  PROVABLE_CLASSES,
  SOLANA_HARNESSES,
  dispatchablePlaybookIds,
  noHarnessReason,
  noPlaneReason,
  planeNameFor,
  workflowFileFor,
} from '../build/planes.js';
import { deriveProveInputs } from '../build/dispatch.js';
import { inferClass, compile } from '../build/intake.js';

/**
 * Every playbook id, in catalog order.
 *
 * `dispatchablePlaybookIds` takes the id list now instead of importing
 * `PLAYBOOKS` itself, because the dispatch sets moved to `planes.ts` and that
 * module deliberately does not import the catalog (the catalog is a big literal
 * and the registry must stay a pure data structure). Passing the list keeps the
 * derivation honest instead of hiding a second copy of it.
 */
const ALL_IDS = PLAYBOOKS.map((p) => p.id);
const dispatchable = () => dispatchablePlaybookIds(ALL_IDS);

const lead = (playbook) => ({ playbook, file: 'V.sol', line: 7, snippet: 'x', severity: 'high' });

// ── 2. B8: the Solana class is refused BY NAME, and nothing is queued ───────

test("the three svm packs are class 'solana', not 'solidity'", () => {
  for (const id of ['sol.svm-signer', 'sol.svm-account', 'sol.svm-cpi']) {
    assert.equal(byId(id).cls, 'solana', `${id} must declare cls 'solana'`);
  }
});

test('PROVABLE_CLASSES is a SET of the classes whose plane exists', () => {
  // A set, not a string: `const PROVABLE_CLASS = 'solidity'` read as "there is
  // one class in the world", which is exactly why three planes were unreachable.
  assert.ok(PROVABLE_CLASSES instanceof Set, 'PROVABLE_CLASSES must be a Set');

  // Every class with a plane in the registry is in it, and vice versa. Computed
  // from PLANES so a fifth plane cannot be added without this noticing.
  for (const cls of ['web2', 'solidity', 'infra', 'solana']) {
    assert.equal(PROVABLE_CLASSES.has(cls), true, `${cls} has a plane and must be provable`);
    assert.ok(workflowFileFor(cls), `${cls} must resolve a workflow file`);
  }

  // `mobile` is the class with no plane. It must be absent here, and its
  // refusal must be the by-name one.
  assert.equal(PROVABLE_CLASSES.has('mobile'), false, 'mobile has no plane');
  assert.equal(workflowFileFor('mobile'), null, 'mobile must not resolve a workflow');
  assert.match(noPlaneReason('mobile'), /no mobile \(APK\/IPA\) proof plane/);
});

test('the Solana plane exists and routes to its OWN workflow, never prove.yml', () => {
  const plane = PLANES.get('solana');
  assert.ok(plane, 'solana must have a plane entry');
  assert.equal(plane.workflow, 'prove-solana.yml');
  assert.equal(plane.cls, 'solana');
  // The harness set is the honest part: ONE class, not three. One class proven
  // end to end beats three that half-run, so the other two are absent on purpose
  // and refuse by name rather than dispatching a run that cannot conclude.
  assert.deepEqual([...plane.harnesses], ['sol.svm-signer']);
});

test('a sol.svm-signer brief with complete provenance derives a prove-solana body', () => {
  const brief = {
    program_id: 'p1',
    title: 't',
    cls: 'solana',
    targets: [
      'https://github.com/acme/anchor-program@abcdef1234567890abcdef1234567890abcdef12',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ],
    playbooks: ['sol.svm-signer'],
    max_mutability: 'simulate',
    time_box_minutes: 60,
    authorization_ref: 'programme permits testing',
    stop_condition: 'stop',
    out_of_scope: [],
    notes:
      'program:vault instruction:withdraw ' +
      'program_id:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  };
  const d = deriveProveInputs(brief, 'hunt-sol-1');
  assert.equal(d.ok, true, `must derive: ${d.why.join(' / ')}`);
  assert.equal(d.workflow, 'prove-solana.yml');
  assert.equal(d.plane, 'Solana (SVM)');
  assert.deepEqual(d.inputs, {
    repo: 'https://github.com/acme/anchor-program',
    commit: 'abcdef1234567890abcdef1234567890abcdef12',
    program: 'vault',
    program_id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    instruction: 'withdraw',
    playbook: 'sol.svm-signer',
    hunt_id: 'hunt-sol-1',
  });
});

test('the two unharnessed svm classes refuse by name — plane exists, harness does not', () => {
  for (const id of ['sol.svm-account', 'sol.svm-cpi']) {
    const brief = {
      program_id: 'p1',
      title: 't',
      cls: 'solana',
      targets: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      playbooks: [id],
      max_mutability: 'simulate',
      time_box_minutes: 60,
      authorization_ref: 'ref',
      stop_condition: 's',
      out_of_scope: [],
      notes: `repo:https://github.com/acme/prog commit:abcdef1234567890abcdef1234567890abcdef12 program:vault instruction:ix`,
    };
    const d = deriveProveInputs(brief, 'hunt-noh');
    assert.equal(d.ok, false, `${id}: must refuse`);
    assert.equal(d.inputs, null, `${id}: must not produce inputs`);
    assert.deepEqual(d.missing, ['playbook'], `${id}: the missing thing is the HARNESS`);
    assert.match(d.why[0], /Solana \(SVM\) plane exists/);
    assert.match(d.why[0], /sol\.svm-signer/);

    // The two refusals must be textually different: "no plane" would tell the
    // operator to wait for something that already shipped.
    assert.notEqual(d.why[0], noPlaneReason('solana'));
    assert.equal(d.why[0], noHarnessReason('solana', id));
  }
});

test('the plane-less refusal still fires for mobile, and only for mobile', () => {
  const expected = { mobile: 'mobile (APK/IPA)' };
  for (const [cls, plane] of Object.entries(expected)) {
    assert.equal(planeNameFor(cls), plane);
    const msg = noPlaneReason(cls);
    assert.ok(msg.includes(plane), `${cls}: message must name "${plane}"`);
    assert.match(msg, /proof plane/, `${cls}: message must say the PLANE is what is missing`);
    // And it must say what the consequence would have been, so the refusal is
    // not mistaken for a temporary glitch.
    assert.match(msg, /inconclusive/, `${cls}: message must state the consequence`);
  }
  // Every OTHER class now names a real workflow, so a "no plane" message about
  // them would be a lie.
  for (const cls of ['web2', 'solidity', 'infra', 'solana']) {
    assert.ok(workflowFileFor(cls), `${cls} has a plane`);
  }
});

test('a sol.svm-* brief is refused BEFORE any input is derived when it cannot run', () => {
  // The ordering is the guarantee: gate -> derive. For an unharnessed class,
  // derivation refuses before it asks for a single input, so there is no body
  // for dispatchWorkflow to send. The "no job is queued" half is asserted end to
  // end in dispatch.test.mjs against a fetch spy; this pins the shape that makes
  // it true.
  for (const id of ['sol.svm-account', 'sol.svm-cpi']) {
    const d = deriveProveInputs(
      {
        program_id: 'p',
        title: 't',
        cls: 'solana',
        targets: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        playbooks: [id],
        max_mutability: 'simulate',
        time_box_minutes: 60,
        authorization_ref: 'ref',
        stop_condition: 's',
        out_of_scope: [],
        notes: 'repo:https://github.com/acme/x commit:abcdef1 program:vault instruction:ix',
      },
      'hunt-x',
    );
    assert.equal(d.ok, false, `${id}: must refuse`);
    assert.equal(d.inputs, null, `${id}: must not produce inputs`);
    assert.deepEqual(d.partial, {}, `${id}: must not have derived anything either`);
  }
});

test('a compiled svm brief carries cls solana and routes at the Solana plane', () => {
  const out = compile('hunt solana anchor program signer checks on https://github.com/acme/prog', {
    program_id: 'p1',
    authorization_ref: 'ref',
    scope_hints: [],
  });
  assert.ok(out.brief, 'compile must produce a brief for a well-specified hunt');
  assert.equal(out.brief.cls, 'solana');
  const d = deriveProveInputs(out.brief, 'hunt-compiled');
  // Text alone cannot supply a commit, a crate name or an instruction name, so
  // this refuses — but it refuses INSIDE the Solana plane, naming the Solana
  // inputs, which is the routing proof. Nothing here mentions a Foundry field.
  assert.equal(d.ok, false);
  assert.equal(d.workflow, 'prove-solana.yml');
  assert.equal(d.plane, 'Solana (SVM)');
  assert.match(d.why.join(' '), /cargo-build-sbf|bankrun/);
});

// ── 3. the dispatcher's source of truth is coherent ─────────────────────────

test('DISPATCHER_CLASSES and PROVABLE_CLASSES agree, and both derive from PLANES', () => {
  // Two sets that must not drift: one says which classes may be dispatched, the
  // other says which classes a plane can prove. If they diverged, a class could
  // be dispatched into a plane that refuses it (or vice versa). Both are now
  // DERIVED from the registry, so this is a regression guard rather than a
  // second copy of the truth.
  assert.deepEqual(
    [...DISPATCHER_CLASSES].sort(),
    [...PROVABLE_CLASSES].sort(),
    'a class must be dispatchable exactly when a plane can prove it',
  );
  assert.deepEqual(
    [...DISPATCHER_CLASSES].sort(),
    [...PLANES.keys()].filter((c) => PLANES.get(c).harnesses.size > 0).map(String).sort(),
  );
});

test('every class a brief can take is either dispatchable or refused by name', () => {
  // The full taxonomy, so a class added to `Cls` without a plane fails here.
  const all = ['web2', 'solidity', 'infra', 'solana', 'mobile'];
  for (const cls of all) {
    const dispatchableCls = DISPATCHER_CLASSES.has(cls);
    const provable = PROVABLE_CLASSES.has(cls);
    assert.equal(dispatchableCls, provable, `${cls}: membership must match`);
    if (!dispatchableCls) {
      // The refusal must exist and be specific for this class, not a fallback.
      assert.match(noPlaneReason(cls), /proof plane/);
      assert.equal(workflowFileFor(cls), null, `${cls}: must not resolve a workflow`);
    }
  }
});

test('no playbook in a plane-less class is dispatchable', () => {
  // `mobile` is the only such class now, and the mob.* packs do load — so this
  // is a real assertion, not a vacuous one over an empty set.
  const mobileIds = PLAYBOOKS.filter((p) => p.cls === 'mobile').map((p) => p.id);
  assert.equal(DISPATCHER_CLASSES.has('mobile'), false);
  for (const p of PLAYBOOKS) {
    if (!DISPATCHER_CLASSES.has(p.cls)) {
      assert.ok(
        !dispatchable().includes(p.id),
        `${p.id} is ${p.cls} and must not be dispatchable`,
      );
    }
  }
  // Anything dispatchable must belong to a class that has a plane.
  for (const id of dispatchable()) {
    const cls = byId(id).cls;
    assert.ok(DISPATCHER_CLASSES.has(cls), `${id} is ${cls}, which has no plane`);
  }
  void mobileIds;
});

test('every harness a plane claims is a real playbook OF THAT plane class', () => {
  // A web.* id registered under the Solana set would make prove-solana.yml the
  // workflow that runs a web test — the same class of silent misroute as B8.
  for (const [cls, plane] of PLANES) {
    for (const id of plane.harnesses) {
      const pb = byId(id);
      assert.ok(pb, `${cls}: harness "${id}" is not a playbook at all`);
      assert.equal(pb.cls, cls, `${cls}: harness "${id}" belongs to class ${pb.cls}`);
    }
  }
  // And the Solana set is exactly the one class this task proved end to end.
  assert.deepEqual([...SOLANA_HARNESSES], ['sol.svm-signer']);
});
