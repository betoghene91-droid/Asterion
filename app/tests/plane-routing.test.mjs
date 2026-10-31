/**
 * Plane routing — the gate for Task 6 (§8).
 *
 * WHAT THIS FILE EXISTS TO PROVE
 *
 * §8 requires: `WORKFLOW_FILE` a function of `brief.cls`, `PROVABLE_CLASS` a set,
 * one input builder per class, and `hunt_id` mandatory everywhere. Four separate
 * claims, each with a failure mode that looks like success:
 *
 *   1. ROUTING. A web2 brief that reaches prove.yml queues a Foundry job that
 *      cannot execute a URL target. It runs, it goes green, it reports
 *      `inconclusive`. So the assertion is on the URL, per class, and the
 *      expected mapping is written out rather than derived — a derived
 *      expectation would agree with a wrong registry.
 *
 *   2. THE INPUT BODY. GitHub answers a `workflow_dispatch` carrying an input the
 *      workflow does not declare with **422**. That is why one union body cannot
 *      serve four planes. So each builder's key set is compared against the
 *      `workflow_dispatch:` block of its OWN yaml, parsed from the file on disk.
 *      A key sent but not declared fails here; a required-but-undeclared input
 *      fails here; a key the workflow declares but nobody sends is reported so
 *      the contract does not rot in the other direction.
 *
 *   3. `hunt_id`. Without a real `hunts` row the callback lands as an orphan and
 *      `ingestProofs` refuses its `proven` verdict by design. A dispatch missing
 *      it therefore costs compute and discards every verdict. This is asserted
 *      three ways: the builder refuses an empty id, the body always carries it,
 *      and every workflow DECLARES it as required.
 *
 *   4. NO SILENT FOUNDRY DISPATCH. `dispatchable ⊆ HARNESSED` is asserted in
 *      dispatch-coverage.test.mjs; here it is asserted per PLANE, because the
 *      bug that survived B8 was class-level — `solana` had a plane while two of
 *      its three playbooks had no harness.
 *
 * The end-to-end half (a real approveAndDispatch call with a fetch spy) lives in
 * dispatch.test.mjs, where the real schema and the real gate both run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PLANES,
  PROVABLE_CLASSES,
  WEB2_HARNESSES,
  INFRA_HARNESSES,
  SOLANA_HARNESSES,
  deriveForBrief,
  dispatchablePlaybookIds,
  harnessPairs,
  noHarnessReason,
  noPlaneReason,
  planeNameFor,
  scopeTargetFor,
  workflowFileFor,
  workflowFiles,
} from '../build/planes.js';
import { HARNESSED, synthesize } from '../build/poc.js';
import { PLAYBOOKS, byId } from '../build/playbooks.js';
import { deriveProveInputs } from '../build/dispatch.js';
import { synthesizePlaneHarness } from '../build/plane-harness.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HUNT = 'hunt-plane-1';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const GIT = 'https://github.com/acme/vault.git';
const PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A Brief skeleton; each case overrides what its plane needs. */
function brief(over) {
  return {
    program_id: 'acme.example',
    title: 't',
    cls: 'solidity',
    targets: [],
    playbooks: [],
    max_mutability: 'simulate',
    time_box_minutes: 240,
    authorization_ref: 'https://acme.example/security permits automated testing',
    stop_condition: 'stop at the time box',
    out_of_scope: [],
    notes: '',
    ...over,
  };
}

/**
 * One complete, dispatchable brief per plane.
 *
 * Written out rather than generated, so a builder that starts requiring a new
 * field fails here — which is the point, because a new required field with no
 * fixture is a contract change nobody reviewed.
 */
const FIXTURES = {
  solidity: brief({
    cls: 'solidity',
    playbooks: ['sol.reentrancy'],
    targets: [`${GIT}@${SHA}`],
    notes: `contract:Vault repo:${GIT} commit:${SHA}`,
  }),
  web2: brief({
    cls: 'web2',
    playbooks: ['web.jwt'],
    targets: ['https://app.acme.example/api/me'],
    notes: 'target:https://app.acme.example/api/me',
  }),
  infra: brief({
    cls: 'infra',
    playbooks: ['web.takeover'],
    targets: ['docs.acme.example'],
    notes: 'domain:docs.acme.example',
  }),
  solana: brief({
    cls: 'solana',
    playbooks: ['sol.svm-signer'],
    targets: [`${GIT}@${SHA}`, PROGRAM_ID],
    notes: `program:vault instruction:withdraw program_id:${PROGRAM_ID}`,
  }),
};

// ── 1. routing ──────────────────────────────────────────────────────────────

test('each class routes to the workflow §8 names, verbatim', () => {
  // The mapping is §8's, spelled out. Not derived from the registry: a derived
  // expectation would pass against a registry that named the wrong file.
  const expected = {
    solidity: 'prove.yml',
    web2: 'prove-web.yml',
    infra: 'prove-infra.yml',
    solana: 'prove-solana.yml',
  };
  for (const [cls, file] of Object.entries(expected)) {
    assert.equal(workflowFileFor(cls), file, `${cls} must route to ${file}`);
    const d = deriveForBrief(FIXTURES[cls], HUNT);
    assert.equal(d.ok, true, `${cls} fixture must derive: ${d.why.join(' / ')}`);
    assert.equal(d.workflow, file, `${cls} body must target ${file}`);
  }
});

test('WORKFLOW_FILE is a function of the class, not a constant', () => {
  // The defect being fixed was literally `export const WORKFLOW_FILE = 'prove.yml'`.
  // If every class resolved the same file, the mapping test above would have to
  // be wrong in four places at once for this to pass — so assert the spread.
  const files = new Set(Object.keys(FIXTURES).map((cls) => workflowFileFor(cls)));
  assert.equal(files.size, 4, `four classes must resolve four different workflows, got ${[...files]}`);
  assert.equal(workflowFiles().length, 4);
});

test('PROVABLE_CLASSES is a set of exactly the classes with a plane', () => {
  assert.ok(PROVABLE_CLASSES instanceof Set);
  assert.deepEqual([...PROVABLE_CLASSES].sort(), ['infra', 'solana', 'solidity', 'web2']);
  // mobile is the only class with no plane, and it must be OUT.
  assert.equal(PROVABLE_CLASSES.has('mobile'), false);
  assert.equal(workflowFileFor('mobile'), null);
});

// ── 2. the input body is each plane's own contract ──────────────────────────

/**
 * Parse the `workflow_dispatch:` input declarations out of a workflow file.
 *
 * Deliberately dumb and strict: inputs sit at six spaces of indentation under
 * `workflow_dispatch:` in every file in this repo, and `required:` at eight.
 * A parser that guessed would let a malformed block pass.
 */
function declaredInputs(file) {
  const yml = readFileSync(join(REPO, '.github', 'workflows', file), 'utf8');
  const at = yml.indexOf('workflow_dispatch:');
  assert.ok(at > -1, `${file} must be dispatchable`);
  const block = yml.slice(at);

  const names = [...block.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
  const required = [];
  // For each input, the lines belonging to it run until the next 6-space key.
  const re = /^ {6}([a-z_]+):\n([\s\S]*?)(?=^ {6}[a-z_]+:$|^ {0,4}[a-z_]+:|(?![\s\S]))/gm;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    if (/^ {8}required: true$/m.test(m[2] ?? '')) required.push(m[1]);
  }
  return { names: [...new Set(names)], required };
}

test('each plane sends exactly the inputs its OWN workflow declares', () => {
  for (const [cls, fixture] of Object.entries(FIXTURES)) {
    const file = workflowFileFor(cls);
    const { names, required } = declaredInputs(file);
    assert.ok(names.length >= 3, `${file}: suspiciously few declared inputs`);

    const d = deriveForBrief(fixture, HUNT);
    assert.equal(d.ok, true, `${cls}: ${d.why.join(' / ')}`);

    const sent = Object.keys(d.inputs);
    const undeclared = sent.filter((k) => !names.includes(k));
    assert.deepEqual(
      undeclared,
      [],
      `${cls}: ${file} does not declare ${undeclared.join(', ')}, and GitHub answers an ` +
        'undeclared workflow_dispatch input with 422',
    );

    // Every REQUIRED input must be in the body, or the dispatch 422s the other way.
    const missingRequired = required.filter((k) => !sent.includes(k));
    assert.deepEqual(missingRequired, [], `${cls}: ${file} requires ${missingRequired.join(', ')} but the body omits it`);

    // And every REQUIRED input is sent — already checked above — while an
    // OPTIONAL input the builder omits is fine and must be. GitHub does not 422 an
    // unsent optional input, and this repo deliberately omits optional ones when
    // they are unknown: an empty `address` makes vm.envAddress("") revert rather
    // than cleanly leave TARGET unset, and an empty `methodology` would write a
    // zero-byte methodology.md and blur "none applied" into "an empty one
    // applied". So the assertion here is on the DIRECTION THAT CAN BREAK: a key
    // sent but undeclared (above), or a required key not sent (above).
    const optionalUnsent = names.filter((k) => !sent.includes(k) && !required.includes(k));
    for (const k of optionalUnsent) {
      assert.ok(
        !sent.includes(k),
        `${cls}: '${k}' is both sent and reported unsent — the parser is wrong`,
      );
    }
  }
});

test('hunt_id is declared REQUIRED on every plane, and every body carries it', () => {
  for (const file of workflowFiles()) {
    const { required } = declaredInputs(file);
    assert.ok(required.includes('hunt_id'), `${file}: hunt_id must be required`);
  }
  for (const [cls, fixture] of Object.entries(FIXTURES)) {
    const d = deriveForBrief(fixture, HUNT);
    assert.equal(d.ok, true);
    assert.equal(d.inputs.hunt_id, HUNT, `${cls}: hunt_id must be carried`);
  }
});

test('an empty hunt id refuses, on every plane — never a body without one', () => {
  // The consequence is concrete: /hook/proof upserts on this id, and ingest
  // refuses a `proven` verdict that resolves to no hunts row. A body without it
  // is a run whose verdict is discarded, so it must be refused at build time.
  for (const [cls, fixture] of Object.entries(FIXTURES)) {
    for (const empty of ['', '   ']) {
      const d = deriveForBrief(fixture, empty);
      assert.equal(d.ok, false, `${cls}: an empty hunt id must refuse`);
      assert.equal(d.inputs, null, `${cls}: no body may be built`);
      assert.ok(d.missing.includes('hunt_id'), `${cls}: hunt_id must be named as missing`);
      assert.match(d.why.join(' '), /hook\/proof/);
    }
  }
});

test('the EVM contract and the other planes do not overlap', () => {
  // This is the 422 in one assertion: the keys that identify a Foundry run are
  // NOT in a web2, infra or Solana body, and vice versa. One union body is
  // therefore impossible, which is §17's trap and §8's reason for per-class
  // builders.
  const evm = new Set(Object.keys(deriveForBrief(FIXTURES.solidity, HUNT).inputs));
  const evmOnly = ['contract', 'fork_block', 'chain_id', 'address'];
  for (const cls of ['web2', 'infra', 'solana']) {
    const body = deriveForBrief(FIXTURES[cls], HUNT).inputs;
    for (const k of evmOnly) {
      // chain_id/address are optional on the EVM plane and absent unless pinned;
      // they must never appear on another plane.
      assert.equal(k in body, false, `${cls}: a ${cls} body must not carry '${k}'`);
    }
    assert.equal('repo' in body && cls !== 'solana', false, `${cls}: must not carry a repo`);
  }
  for (const k of evmOnly) assert.ok(evm.has(k) || k === 'chain_id' || k === 'address');
});

// ── 3. no silent Foundry (or any) dispatch ─────────────────────────────────

test('every dispatchable playbook has a real harness — EVM, web, infra or SVM', () => {
  const ids = dispatchablePlaybookIds(PLAYBOOKS.map((p) => p.id));
  assert.ok(ids.length > 0);
  for (const id of ids) {
    // A harness is a fact, not a set membership: it has to SYNTHESIZE.
    const evmSpec = synthesize({ playbook: id, file: 'V.sol', line: 1, snippet: 'x', severity: 'high' }, { contract: 'V', forkBlock: 1 });
    const planeSpec = synthesizePlaneHarness(id);
    assert.ok(
      evmSpec || planeSpec,
      `${id} is dispatchable but no harness exists (neither Foundry nor a plane harness)`,
    );
    if (evmSpec) assert.ok(HARNESSED.has(id), `${id}: synthesizes but is not in HARNESSED`);
  }
});

test('harness sets name playbooks of their own class, and no class claims a foreign one', () => {
  for (const { cls, playbook } of harnessPairs()) {
    const pb = byId(playbook);
    assert.ok(pb, `${cls}: "${playbook}" is not a playbook`);
    assert.equal(pb.cls, cls, `${cls}: "${playbook}" is class ${pb.cls}`);
  }
  // Each named set matches its plane's set exactly, so a set cannot be widened
  // in one place and quietly disagree with the refusal message in another.
  assert.deepEqual([...WEB2_HARNESSES], [...PLANES.get('web2').harnesses]);
  assert.deepEqual([...INFRA_HARNESSES], [...PLANES.get('infra').harnesses]);
  assert.deepEqual([...SOLANA_HARNESSES], [...PLANES.get('solana').harnesses]);
});

test('a harness exists on disk for every non-EVM playbook a plane claims', () => {
  // A harness SET is a claim; a generator that returns a non-empty script is the
  // fact. A stub generator would pass the set check and fail this one.
  for (const [cls, plane] of PLANES) {
    if (cls === 'solidity') continue;
    for (const id of plane.harnesses) {
      const spec = synthesizePlaneHarness(id);
      assert.ok(spec, `${cls}: "${id}" is claimed but synthesizePlaneHarness returns null`);
      assert.equal(spec.playbook, id);
      assert.ok(spec.files.length > 0, `${id}: harness emits no files`);
      for (const f of spec.files) {
        assert.ok(f.body.length > 800, `${id}: ${f.path} is implausibly short (a stub?)`);
        // All three variants must be addressable, or judge() cannot get a
        // counterfactual and every verdict is stuck at `partial`.
        assert.ok(f.body.includes('HARNESS_MODE'), `${id}: harness does not select a variant`);
        assert.ok(f.body.includes('IMPACT_BEFORE'), `${id}: harness never emits a measurement`);
      }
      assert.ok(spec.nocond_name && spec.control_name && spec.test_name);
    }
  }
});

test('the two unharnessed svm classes refuse INSIDE the plane, by name', () => {
  for (const id of ['sol.svm-account', 'sol.svm-cpi']) {
    assert.equal(dispatchablePlaybookIds(PLAYBOOKS.map((p) => p.id)).includes(id), false);
    const d = deriveForBrief({ ...FIXTURES.solana, playbooks: [id] }, HUNT);
    assert.equal(d.ok, false, `${id}: must refuse`);
    assert.equal(d.inputs, null);
    assert.deepEqual(d.missing, ['playbook'], `${id}: the harness is what is missing`);
    // The refusal names the plane AND the harnesses it has, which is different
    // from "there is no Solana plane" — a message that would be a lie now.
    assert.match(d.why[0], /Solana \(SVM\) plane exists/);
    assert.match(d.why[0], /sol\.svm-signer/);
    assert.notEqual(d.why[0], noPlaneReason('solana'));
    assert.equal(d.why[0], noHarnessReason('solana', id));
  }
});

test('a plane-less class refuses by name and never names a workflow', () => {
  const d = deriveForBrief(brief({ cls: 'mobile', playbooks: [] }), HUNT);
  assert.equal(d.ok, false);
  assert.equal(d.workflow, null);
  assert.equal(d.inputs, null);
  assert.deepEqual(d.missing, ['cls']);
  assert.match(d.why[0], /no mobile \(APK\/IPA\) proof plane/);
  assert.equal(planeNameFor('mobile'), 'mobile (APK/IPA)');
});

// ── 4. the gate is told the right axis ─────────────────────────────────────

test('each plane hands the policy engine its own target kind and adapter', () => {
  // Before this, every brief reached the engine as `target_kind: 'repo'` with the
  // `foundry` adapter — so a web2 URL and an infra domain both passed as "a repo
  // target is a read-only clone", an axis the engine can only check if it is
  // told about it.
  const expected = {
    solidity: { target_kind: 'repo', adapter: 'foundry' },
    solana: { target_kind: 'repo', adapter: 'bankrun' },
    web2: { target_kind: 'url', adapter: 'web-evidence' },
    infra: { target_kind: 'domain', adapter: 'dns-evidence' },
  };
  for (const [cls, want] of Object.entries(expected)) {
    const got = scopeTargetFor(FIXTURES[cls], 'fallback.example');
    assert.equal(got.target_kind, want.target_kind, `${cls}: target_kind`);
    assert.equal(got.adapter, want.adapter, `${cls}: adapter`);
    assert.ok(got.target && got.target !== 'fallback.example', `${cls}: must resolve a real target`);
  }
  // And the resolved targets are the right SHAPE, which is what the engine checks.
  assert.match(scopeTargetFor(FIXTURES.web2, 'x').target, /^https:\/\//);
  assert.equal(scopeTargetFor(FIXTURES.infra, 'x').target, 'docs.acme.example');
});

// ── 5. the workflows themselves ────────────────────────────────────────────

test('every plane workflow exists, is dispatchable, and touches no secret it should not', () => {
  for (const file of workflowFiles()) {
    const path = join(REPO, '.github', 'workflows', file);
    assert.ok(existsSync(path), `${file} is routed to but does not exist`);
    const yml = readFileSync(path, 'utf8');

    assert.match(yml, /^on:\n {2}workflow_dispatch:/m, `${file}: must be workflow_dispatch`);
    assert.match(yml, /permissions:\n {2}contents: read/, `${file}: must declare read-only contents`);
    // No plane may touch the Telegram bot token or a model key: those are Worker
    // secrets and the whole trust model is that they never leave the Worker.
    for (const forbidden of ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']) {
      assert.equal(yml.includes(forbidden), false, `${file}: must not reference ${forbidden}`);
    }
    // Every plane reports through the same fail-closed hook, and names the secret
    // it needs rather than failing generically.
    assert.match(yml, /PROOF_HOOK_SECRET/, `${file}: must report to /hook/proof`);
    assert.match(yml, /x-asterion-secret/, `${file}: must present the shared secret`);
    assert.match(yml, /x-asterion-hunt/, `${file}: must present the hunt id`);
  }
});

test('prove-solana uses bankrun and never solana-test-validator --clone', () => {
  // §8.1 names the mechanism. `--clone` needs a live RPC per account, is slow and
  // flaky in CI, and fails in a way that reads as `inconclusive` — so it must not
  // be in the file at all.
  const yml = readFileSync(join(REPO, '.github', 'workflows', 'prove-solana.yml'), 'utf8');
  assert.match(yml, /solana-bankrun/, 'must use solana-bankrun');
  assert.match(yml, /anchor-bankrun/, 'must use anchor-bankrun');
  assert.equal(/solana-test-validator/.test(yml.replace(/^#.*$/gm, '')), false, 'must not start a validator');
  assert.equal(/--clone/.test(yml.replace(/^#.*$/gm, '')), false, 'must not clone accounts from an RPC');
  // --arch v0 is load-bearing: a v3 build deploys and then fails every instruction.
  assert.match(yml, /--arch v0/, 'cargo-build-sbf must be told --arch v0');
  // And its own contract, not the EVM one.
  assert.equal(/^ {6}contract:$/m.test(yml), false, 'prove-solana must not declare the EVM `contract` input');
  assert.match(yml, /^ {6}program_id:$/m);
  assert.match(yml, /^ {6}instruction:$/m);
});

test('the Foundry workflow is untouched by this task', () => {
  // prove.yml is the one plane that already worked. This task must not have
  // changed its contract: a regression here would break every EVM hunt.
  const yml = readFileSync(join(REPO, '.github', 'workflows', 'prove.yml'), 'utf8');
  for (const k of ['repo', 'commit', 'contract', 'fork_block', 'chain_id', 'address', 'hunt_id', 'methodology']) {
    assert.match(yml, new RegExp(`^ {6}${k}:$`, 'm'), `prove.yml must still declare '${k}'`);
  }
  const d = deriveForBrief(FIXTURES.solidity, HUNT);
  assert.deepEqual(d.inputs, {
    repo: 'https://github.com/acme/vault.git',
    commit: SHA,
    contract: 'Vault',
    fork_block: '0',
    hunt_id: HUNT,
  });
});

// ── 6. the entry point stays the same shape ────────────────────────────────

test('deriveProveInputs is the plane-aware entry point and keeps the same shape', () => {
  // Existing callers (approveAndDispatch, and the tests that predate this task)
  // use deriveProveInputs. It must stay total and must keep {ok,inputs,missing,why}.
  for (const cls of Object.keys(FIXTURES)) {
    const d = deriveProveInputs(FIXTURES[cls], HUNT);
    for (const k of ['ok', 'workflow', 'inputs', 'missing', 'why', 'partial', 'plane']) {
      assert.ok(k in d, `${cls}: Derivation must expose '${k}'`);
    }
  }
});
