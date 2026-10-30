/**
 * B8 — Solana dispatch gating.
 *
 * THE BUG. `sol.svm-{signer,account,cpi}` declared `cls: 'solidity'` with NO
 * executor at all (`svm-harness.ts` does not exist). Because they claimed the
 * Foundry class they passed deriveProveInputs and dispatched a FOUNDRY job at an
 * Anchor program: a guaranteed `inconclusive` that was indistinguishable from a
 * legitimate run. That is worse than a refusal, because a refusal is information.
 *
 * THE FIX, and it is deliberately the NARROW one: give them their own class
 * (`solana`), make the provable set a SET so the refusal keeps firing for every
 * class with no plane, and make the refusal NAME the missing plane. The Solana
 * harness is a later phase's work; pretending otherwise would be the same bug
 * again with a different label.
 *
 * The end-to-end proof that no Foundry job is queued (fetch never called) lives
 * in dispatch.test.mjs, where the real approval -> dispatch chain runs against
 * real SQLite with a fetch spy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { synthesize, HARNESSED } from '../build/poc.js';
import { PLAYBOOKS, DISPATCHER_CLASSES, dispatchablePlaybookIds, byId } from '../build/playbooks.js';
import { PROVABLE_CLASSES, deriveProveInputs, noPlaneReason, planeNameFor } from '../build/dispatch.js';
import { inferClass, compile } from '../build/intake.js';

const lead = (playbook) => ({ playbook, file: 'V.sol', line: 7, snippet: 'x', severity: 'high' });

// ── 2. B8: the Solana class is refused BY NAME, and nothing is queued ───────

test("the three svm packs are class 'solana', not 'solidity'", () => {
  for (const id of ['sol.svm-signer', 'sol.svm-account', 'sol.svm-cpi']) {
    assert.equal(byId(id).cls, 'solana', `${id} must declare cls 'solana'`);
  }
});

test('a solana class is NOT in the provable set', () => {
  assert.equal(PROVABLE_CLASSES.has('solana'), false);
  assert.equal(PROVABLE_CLASSES.has('solidity'), true);
  // A set, not a string: the refusal has to keep working for every class that
  // has no plane, including ones added later.
  assert.ok(PROVABLE_CLASSES instanceof Set, 'PROVABLE_CLASSES must be a Set');
  for (const cls of ['web2', 'infra', 'mobile']) {
    assert.equal(PROVABLE_CLASSES.has(cls), false, `${cls} has no plane and must not be provable`);
  }
});

test('dispatching an sol.svm-* brief REFUSES, naming the missing Solana plane', () => {
  const brief = {
    program_id: 'p1',
    title: 't',
    cls: 'solana',
    targets: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
    playbooks: ['sol.svm-signer'],
    max_mutability: 'simulate',
    time_box_minutes: 60,
    authorization_ref: 'programme permits testing',
    stop_condition: 'stop',
    out_of_scope: [],
    notes: 'repo:https://github.com/acme/anchor-program commit:0xdeadbeef contract:Vault',
  };
  const d = deriveProveInputs(brief);
  assert.equal(d.ok, false);
  assert.equal(d.inputs, null, 'a refused brief must yield NO inputs, or a caller could dispatch them');
  assert.deepEqual(d.missing, ['cls']);
  assert.match(d.why[0], /Solana \(SVM\)/, 'the refusal must name the missing plane');
  assert.match(d.why[0], /no .* proof plane/);
  // eslint-disable-next-line no-console
  console.log('B8 refusal message:\n  ' + d.why[0]);
});

test('the refusal names the plane for every plane-less class, never a bare class name', () => {
  const expected = {
    solana: 'Solana (SVM)',
    web2: 'web2/HTTP',
    infra: 'infrastructure/DNS',
    mobile: 'mobile (APK/IPA)',
  };
  for (const [cls, plane] of Object.entries(expected)) {
    assert.equal(planeNameFor(cls), plane);
    const msg = noPlaneReason(cls);
    assert.ok(msg.includes(plane), `${cls}: message must name "${plane}"`);
    assert.match(msg, /proof plane/, `${cls}: message must say the PLANE is what is missing`);
    // And it must say what the consequence would have been, so the refusal is
    // not mistaken for a temporary glitch.
    assert.match(msg, /inconclusive/, `${cls}: message must state the consequence`);
  }
});

test('an sol.svm-* brief is refused BEFORE any input is derived, so no job can be built', () => {
  // The ordering is the guarantee: gate -> derive. Derivation refuses first, so
  // there is no {repo, commit, contract} triple for dispatchProveWorkflow to
  // send. The "no Foundry job is queued" half is asserted end to end in
  // dispatch.test.mjs against a fetch spy; this pins the shape that makes it true.
  for (const id of ['sol.svm-signer', 'sol.svm-account', 'sol.svm-cpi']) {
    const d = deriveProveInputs({
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
      notes: 'repo:https://github.com/acme/x commit:0xdeadbeef contract:Vault',
    });
    assert.equal(d.ok, false, `${id}: must refuse`);
    assert.equal(d.inputs, null, `${id}: must not produce inputs`);
    assert.deepEqual(d.partial, {}, `${id}: must not have derived anything either`);
  }
});

test('solana is inferable from text, so the svm packs are reachable rather than dead', () => {
  // The packs load and their methodology is real. Refusing them at dispatch is
  // correct; making them unreachable from text would be a different bug.
  assert.equal(inferClass([], 'hunt the anchor program for missing signer checks'), 'solana');
  // The SPL Token program id. Structure beats the word "token": a 32-44 char
  // base58 pubkey is a Solana account no matter which English words it contains.
  assert.equal(inferClass(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], ''), 'solana');
  assert.equal(inferClass(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], 'defi vault token contract'), 'solana');
  // An EVM address still wins its own class.
  assert.equal(inferClass(['0x' + 'ab'.repeat(20)], ''), 'solidity');
  // And a web2 URL is untouched.
  assert.equal(inferClass(['https://app.example.com/x'], ''), 'web2');
});

test('a compiled svm brief carries cls solana and still refuses dispatch', () => {
  const out = compile('hunt solana anchor program signer checks on https://github.com/acme/prog', {
    program_id: 'p1',
    authorization_ref: 'ref',
    scope_hints: [],
  });
  assert.ok(out.brief, 'compile must produce a brief for a well-specified hunt');
  assert.equal(out.brief.cls, 'solana');
  const d = deriveProveInputs(out.brief);
  assert.equal(d.ok, false);
  assert.match(d.why[0], /Solana \(SVM\)/);
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
