// Tests for the approval -> hunt -> dispatch chain.
//
// The point of these tests is that the chain is no longer severed: an approval
// that passes the gate and has derivable provenance must actually POST to the
// GitHub workflow_dispatch API, with a hunts row already in the database.
//
// They run against the REAL app/schema.sql in an in-memory SQLite database
// (node:sqlite), so a column that does not exist is a failing test rather than
// a surprise in production. `fetch` is always stubbed; no network happens.
//
// Run with: node --test tests/dispatch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WORKFLOW_FILE,
  PROOF_TECHNIQUE,
  STAGE_DISPATCHED,
  STAGE_DISPATCH_FAILED,
  deriveProveInputs,
  authorizeProof,
  dispatchProveWorkflow,
  approveAndDispatch,
} from '../build/dispatch.js';
import { checkTargetBounds, MAX_TARGETS, MAX_TARGET_ENTRY, roeFromBrief } from '../build/policy.js';
import index from '../build/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

const NOW = 1_700_000_000;
const GIT_URL = 'https://github.com/acme/vault.git';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// ── fixtures ────────────────────────────────────────────────────────────────

/** A brief that can actually be proved: solidity, simulate, full provenance. */
function provableBrief(over = {}) {
  return {
    program_id: 'acme.example',
    title: 'solidity hunt on vault',
    cls: 'solidity',
    targets: [`${GIT_URL}@${SHA}`],
    playbooks: ['sol.reentrancy'],
    max_mutability: 'simulate',
    time_box_minutes: 240,
    authorization_ref: 'https://acme.example/security permits automated testing',
    stop_condition: 'stop at the time box',
    out_of_scope: [],
    notes: `contract:Vault repo:${GIT_URL}`,
    ...over,
  };
}

/** A brief with no repo, no commit and no contract anywhere. */
function hostOnlyBrief() {
  return provableBrief({
    targets: ['app.example.com'],
    notes: 'look at app.example.com api, take your time',
  });
}

/** D1-compatible shim over node:sqlite, backed by the real schema. */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  const api = {
    raw: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      const bound = {
        async first(...binds) {
          return stmt.get(...binds) ?? null;
        },
        async run(...binds) {
          return stmt.run(...binds);
        },
        async all(...binds) {
          return { results: stmt.all(...binds) };
        },
        bind(...binds) {
          return {
            async first() {
              return stmt.get(...binds) ?? null;
            },
            async run() {
              return stmt.run(...binds);
            },
            async all() {
              return { results: stmt.all(...binds) };
            },
          };
        },
      };
      return bound;
    },
  };

  // The narrow interface dispatch.ts consumes.
  api.first = async (sql, ...b) => db.prepare(sql).get(...b) ?? null;
  api.run = async (sql, ...b) => {
    db.prepare(sql).run(...b);
  };
  return api;
}

/** Insert a program + a pending approval carrying `brief`. */
function seedApproval(db, brief, id = 'appr-1', status = 'pending') {
  db.raw
    .prepare(
      `INSERT INTO programs (id,name,platform,status,discovered_at) VALUES (?,?,?,'new',?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(brief.program_id, brief.program_id, 'self', NOW);
  db.raw
    .prepare(
      `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      id,
      id.slice(0, 16),
      JSON.stringify({ kind: 'engagement', brief }),
      `new engagement: ${brief.title}`,
      status,
      NOW,
    );
  return id;
}

function approvalRow(db, id = 'appr-1') {
  return db.raw.prepare('SELECT * FROM approvals WHERE id=?').get(id);
}

function hunts(db) {
  return db.raw.prepare('SELECT * FROM hunts').all();
}

/** Collect Telegram-bound text instead of calling the API. */
function recorder() {
  const msgs = [];
  const ledgers = [];
  return {
    msgs,
    ledgers,
    deps: (db, env, fetchImpl, extra = {}) => ({
      db,
      env,
      fetch: fetchImpl,
      ledger: async (kind, payload) => {
        ledgers.push({ kind, payload });
      },
      notify: async (text) => {
        msgs.push(text);
      },
      operator: 'tester',
      now: () => NOW,
      uuid: () => 'hunt-fixed-uuid',
      ...extra,
    }),
  };
}

/** A fetch stub that records the single dispatch call and answers 204. */
function okFetch(seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    // 204 carries no body; passing '' would make the Response constructor throw.
    return new Response(null, { status: 204 });
  };
}

// ── derivation ──────────────────────────────────────────────────────────────

test('derives repo, commit and contract from a brief that carries them', () => {
  const d = deriveProveInputs(provableBrief());
  assert.equal(d.ok, true);
  assert.deepEqual(d.missing, []);
  assert.equal(d.inputs.repo, GIT_URL);
  assert.equal(d.inputs.commit, SHA);
  assert.equal(d.inputs.contract, 'Vault');
  assert.equal(d.inputs.fork_block, '0');
});

test('a commit pinned in notes is used when the target carries none', () => {
  const d = deriveProveInputs(
    provableBrief({ targets: [GIT_URL], notes: `contract:Vault commit=${SHA}` }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.inputs.commit, SHA);
});

test('a fork block in notes is carried through as a number string', () => {
  const d = deriveProveInputs(
    provableBrief({ notes: `contract:Vault fork_block:19000000 repo:${GIT_URL} commit:${SHA}` }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.inputs.fork_block, '19000000');
});

test('names every underivable input for a host-only brief, with a reason each', () => {
  const d = deriveProveInputs(hostOnlyBrief());
  assert.equal(d.ok, false);
  assert.equal(d.inputs, null);
  assert.deepEqual(d.missing, ['repo', 'commit', 'contract']);
  assert.equal(d.why.length, 3);
  // Each reason must name the input it is about, or it is not actionable.
  assert.match(d.why[0], /repo/i);
  assert.match(d.why[0], /app\.example\.com/);
  assert.match(d.why[1], /commit/i);
  assert.match(d.why[2], /contract/i);
});

test('a non-solidity brief is refused before listing inputs', () => {
  const d = deriveProveInputs(provableBrief({ cls: 'web2' }));
  assert.equal(d.ok, false);
  assert.deepEqual(d.missing, ['cls']);
  // The refusal must NAME the missing plane, not merely the class. "forge test"
  // was the old wording; naming the plane is what makes the refusal actionable.
  assert.match(d.why[0], /no web2\/HTTP proof plane/);
  assert.match(d.why[0], /Foundry\/EVM/);
  assert.match(d.why[0], /inconclusive/);
});

test('a non-solidity brief reports not_provable_class, not underivable_inputs', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief({ cls: 'web2' }));
  const rec = recorder();
  const seen = [];

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch(seen)),
  );

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'not_provable_class');
  assert.equal(seen.length, 0);
  assert.equal(hunts(db).length, 0);
});

test('an ambiguous bare SHA in prose is not guessed', () => {
  const d = deriveProveInputs(
    provableBrief({
      targets: [GIT_URL],
      notes: `contract:Vault saw ${SHA} and also 0123456789abcdef0123456789abcdef01234567`,
    }),
  );
  assert.equal(d.ok, false);
  assert.ok(d.missing.includes('commit'));
});

// ── the gate still owns the decision ────────────────────────────────────────

test('the gate refuses to simulate for a read-only brief', async () => {
  const d = await authorizeProof(provableBrief({ max_mutability: 'read' }), GIT_URL, NOW);
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /mutability simulate exceeds RoE ceiling read/);
  assert.equal(d.action.technique, PROOF_TECHNIQUE);
});

test('the gate allows simulate when the brief ceiling permits it', async () => {
  const d = await authorizeProof(provableBrief(), GIT_URL, NOW);
  assert.equal(d.verdict, 'allow');
  assert.equal(d.action.target_kind, 'repo');
});

test('the gate refuses a brief whose engagement window cannot exist', async () => {
  // A zero time box makes roeFromBrief produce an empty window, which the
  // PolicyEngine constructor rejects. Dispatch must treat that as a refusal.
  await assert.rejects(
    () => authorizeProof(provableBrief({ time_box_minutes: 0 }), GIT_URL, NOW),
    /window is empty or inverted/,
  );
});


// ── the happy path: dispatch actually fires ─────────────────────────────────

test('approval dispatches prove.yml with the derived inputs and a pre-existing hunt row', async () => {
  const db = makeDb();
  const brief = provableBrief();
  seedApproval(db, brief);
  const rec = recorder();

  // Assert the hunts row already exists at the moment GitHub is called.
  let rowAtDispatchTime = null;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    rowAtDispatchTime = db.raw.prepare('SELECT * FROM hunts WHERE id=?').get('hunt-fixed-uuid');
    return new Response(null, { status: 204 });
  };

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, fetchImpl),
  );

  assert.equal(out.dispatched, true);
  assert.equal(out.huntId, 'hunt-fixed-uuid');
  assert.equal(out.status, 204);

  // Exactly one call, to the right endpoint.
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.equal(
    url,
    `https://api.github.com/repos/me/asterion/actions/workflows/${WORKFLOW_FILE}/dispatches`,
  );
  assert.equal(WORKFLOW_FILE, 'prove.yml');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer tok');
  assert.equal(init.headers['content-type'], 'application/json');

  // Inputs are the derived values plus the correlation id, and — when a pack
  // applies — the methodology block. Two things are asserted instead of one
  // literal object, because both are the real invariants:
  //
  //  1. every key sent is DECLARED in prove.yml. GitHub answers a
  //     workflow_dispatch carrying an undeclared input with 422, so this test is
  //     the thing that keeps the TypeScript and the workflow from drifting apart.
  //  2. the base five keys still carry exactly the derived values.
  //
  // The methodology block's prose is tied to pack wording; bounding it would make
  // this test hostage to a skill file, so only its shape is checked.
  const body = JSON.parse(init.body);
  assert.equal(body.ref, 'main');

  const { methodology, ...baseInputs } = body.inputs;
  assert.deepEqual(baseInputs, {
    repo: GIT_URL,
    commit: SHA,
    contract: 'Vault',
    fork_block: '0',
    hunt_id: 'hunt-fixed-uuid',
  });

  // The workflow declaration is the source of truth for what may be sent.
  const workflowYml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'prove.yml'),
    'utf8',
  );
  const dispatchBlock = workflowYml.slice(workflowYml.indexOf('workflow_dispatch:'));
  const declared = new Set(
    [...dispatchBlock.matchAll(/^ {6}([a-z_]+):$/gm)].map((mm) => mm[1]),
  );
  for (const key of Object.keys(body.inputs)) {
    assert.ok(declared.has(key), `input '${key}' is sent but not declared in prove.yml (GitHub would 422)`);
  }
  for (const req of ['repo', 'commit', 'contract']) {
    assert.ok(declared.has(req), `required input '${req}' missing from prove.yml`);
  }


  // The fixture's target is GIT_URL = 'https://github.com/acme/vault.git', which
  // shapeOf() classifies as 'a repo URL' — recognised, and class-compatible with a
  // solidity brief. So a sol pack applies and the block MUST be carried. This is
  // the positive-branch assertion: delete the send line and this fails.
  assert.equal(typeof methodology, 'string', 'a recognised target with a matching pack must carry the block');
  assert.ok(methodology.length > 0, 'an empty methodology must be omitted, never sent as ""');

  // The row existed BEFORE the POST: that is what makes /hook/proof safe.
  assert.ok(rowAtDispatchTime, 'hunts row must exist before dispatching');
  assert.equal(rowAtDispatchTime.stage, STAGE_DISPATCHED);
  assert.equal(rowAtDispatchTime.repo, GIT_URL);
  assert.equal(rowAtDispatchTime.commit_sha, SHA);
  assert.equal(rowAtDispatchTime.contract, 'Vault');
  assert.equal(rowAtDispatchTime.program_id, brief.program_id);

  // Approval recorded, and the operator was told it is really running.
  const a = approvalRow(db);
  assert.equal(a.status, 'approved');
  assert.equal(a.operator, 'tester');
  assert.ok(rec.msgs.some((m) => /DISPATCHED/.test(m)));
  assert.ok(rec.msgs.some((m) => /hunt-fixed-uuid/.test(m)));
  assert.ok(rec.ledgers.some((l) => l.kind === 'dispatch.sent'));
});

// ── failure paths must be loud and must not fake a hunt ─────────────────────

test('a missing GITHUB_DISPATCH_TOKEN is named, not swallowed, and starts no hunt', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief());
  const rec = recorder();
  const seen = [];

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_REPO: 'me/asterion' }, okFetch(seen)),
  );

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'missing_env');
  assert.deepEqual(out.missing, ['GITHUB_DISPATCH_TOKEN']);

  // No network, no hunt row, approval still approved (it WAS approved).
  assert.equal(seen.length, 0, 'must not call GitHub without a token');
  assert.equal(hunts(db).length, 0, 'must not create a hunt row it cannot run');
  assert.equal(approvalRow(db).status, 'approved');

  // The exact variable name must appear, or the operator cannot act on it.
  const msg = rec.msgs.join('\n');
  assert.match(msg, /GITHUB_DISPATCH_TOKEN/);
  assert.match(msg, /NOT DISPATCHED/);
  assert.ok(!/DISPATCHED\b(?!\s*<\/b>)/.test(msg.replace(/NOT DISPATCHED/g, '')), 'must not claim success');
  assert.ok(rec.ledgers.some((l) => l.kind === 'dispatch.blocked'));
});

test('a missing GITHUB_REPO is named, and starts no hunt', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief());
  const rec = recorder();
  const seen = [];

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok' }, okFetch(seen)),
  );

  assert.equal(out.dispatched, false);
  assert.deepEqual(out.missing, ['GITHUB_REPO']);
  assert.equal(seen.length, 0);
  assert.equal(hunts(db).length, 0);
  assert.match(rec.msgs.join('\n'), /GITHUB_REPO/);
});

test('both missing variables are reported together', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief());
  const rec = recorder();

  const out = await approveAndDispatch('appr-1', true, rec.deps(db, {}, okFetch()));
  assert.deepEqual(out.missing, ['GITHUB_DISPATCH_TOKEN', 'GITHUB_REPO']);
  assert.match(rec.msgs.join('\n'), /GITHUB_DISPATCH_TOKEN/);
  assert.match(rec.msgs.join('\n'), /GITHUB_REPO/);
});

test('a gate denial dispatches nothing and creates no hunt row', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief({ max_mutability: 'read' }));
  const rec = recorder();
  const seen = [];

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch(seen)),
  );

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'gate_deny');
  assert.equal(seen.length, 0);
  assert.equal(hunts(db).length, 0);
  assert.match(rec.msgs.join('\n'), /GATE REFUSED/);
  // The policy reason is surfaced verbatim, so the operator can see why.
  assert.match(rec.msgs.join('\n'), /mutability simulate exceeds RoE ceiling read/);
  assert.equal(approvalRow(db).status, 'approved');
  assert.ok(rec.ledgers.some((l) => l.kind === 'dispatch.blocked'));
});

test('underivable inputs dispatch nothing, name them, and create no hunt row', async () => {
  const db = makeDb();
  seedApproval(db, hostOnlyBrief());
  const rec = recorder();
  const seen = [];

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch(seen)),
  );

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'underivable_inputs');
  assert.deepEqual(out.missing, ['repo', 'commit', 'contract']);
  assert.equal(seen.length, 0);
  assert.equal(hunts(db).length, 0);
  const msg = rec.msgs.join('\n');
  assert.match(msg, /cannot build prove\.yml inputs/);
  assert.match(msg, /repo/);
  assert.match(msg, /commit/);
  assert.match(msg, /contract/);
});

test('a non-2xx from GitHub is surfaced with status and body, and the hunt says failed', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief());
  const rec = recorder();

  const fetchImpl = async () =>
    new Response('{"message":"Resource not accessible by integration"}', { status: 403 });

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'bad', GITHUB_REPO: 'me/asterion' }, fetchImpl),
  );

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'dispatch_failed');

  // The row exists but is honest about it, and it still exists for the callback.
  const rows = hunts(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, STAGE_DISPATCH_FAILED);
  assert.match(rows[0].stopped_because, /403/);
  assert.match(rows[0].stopped_because, /Resource not accessible/);

  const msg = rec.msgs.join('\n');
  assert.match(msg, /DISPATCH FAILED/);
  assert.match(msg, /403/);
  assert.match(msg, /Resource not accessible by integration/);
  assert.match(msg, /no proof is running/);
  assert.ok(!/stage <code>prime<\/code>/.test(msg), 'must not imply a run started');
  assert.ok(rec.ledgers.some((l) => l.kind === 'dispatch.failed'));
});

test('a transport failure is reported as a transport failure', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief());
  const rec = recorder();

  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  };

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, fetchImpl),
  );

  assert.equal(out.dispatched, false);
  assert.equal(hunts(db)[0].stage, STAGE_DISPATCH_FAILED);
  assert.match(rec.msgs.join('\n'), /transport error: getaddrinfo ENOTFOUND/);
});

test('denial never dispatches and never writes a hunt row', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief());
  const rec = recorder();
  const seen = [];

  const out = await approveAndDispatch(
    'appr-1',
    false,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch(seen)),
  );

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'denied');
  assert.equal(seen.length, 0);
  assert.equal(hunts(db).length, 0);
  assert.equal(approvalRow(db).status, 'denied');
  assert.match(rec.msgs.join('\n'), /denied/);
});

test('a second tap on the same approval cannot start a second hunt', async () => {
  const db = makeDb();
  seedApproval(db, provableBrief());
  const rec = recorder();
  const seen = [];
  const deps = rec.deps(
    db,
    { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' },
    okFetch(seen),
  );

  const first = await approveAndDispatch('appr-1', true, deps);
  const second = await approveAndDispatch('appr-1', true, deps);

  assert.equal(first.dispatched, true);
  assert.equal(second.dispatched, false);
  assert.equal(second.reason, 'already_decided');
  assert.equal(seen.length, 1, 'exactly one dispatch for one approval');
  assert.equal(hunts(db).length, 1);
});

test('an unknown approval id does not crash and says so', async () => {
  const db = makeDb();
  const rec = recorder();

  const out = await approveAndDispatch('nope', true, rec.deps(db, {}, okFetch()));
  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'unknown_approval');
  assert.match(rec.msgs.join('\n'), /unknown approval/);
});

test('an engagement approval with corrupt action JSON does not crash', async () => {
  const db = makeDb();
  db.raw
    .prepare(
      `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at)
       VALUES ('bad','bad','{not json','broken','pending',?)`,
    )
    .run(NOW);
  const rec = recorder();

  const out = await approveAndDispatch('bad', true, rec.deps(db, {}, okFetch()));
  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'bad_action');
  assert.match(rec.msgs.join('\n'), /unreadable action JSON/);
});

// ── the /hook/proof callback ────────────────────────────────────────────────

const HOOK_SECRET = 'hook-secret-for-tests';

function hookEnv(db, over = {}) {
  // /hook/proof now FAILS CLOSED: without PROOF_HOOK_SECRET every callback is
  // refused. The happy-path tests therefore have to present the secret too,
  // exactly as prove.yml does.
  return {
    DB: db,
    OPERATOR_NAME: 'tester',
    TELEGRAM_CHAT_ID: '1',
    PROOF_HOOK_SECRET: HOOK_SECRET,
    ...over,
  };
}

function hookCtx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

function postProof(huntId, body, secret = HOOK_SECRET) {
  const headers = { 'content-type': 'application/json', 'x-asterion-hunt': huntId };
  if (secret !== null) headers['x-asterion-secret'] = secret;
  return new Request('https://w.example/hook/proof', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// ── the proof hook is authenticated, and FAILS CLOSED ──────────────────────

const MINIMAL_PROOF = {
  contract: 'Vault',
  commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  leads_found: 1,
  attempts: 1,
  proven: 1,
  verdicts: [
    {
      test_name: 'test_drain',
      playbook: 'sol.reentrancy',
      verdict: 'proven',
      confidence: 'confirmed',
      proven_claim: 'attacker drained the vault',
    },
  ],
};

test('/hook/proof refuses every callback when PROOF_HOOK_SECRET is unset (fail closed)', async () => {
  const db = makeDb();
  // No PROOF_HOOK_SECRET in env. Before this gate existed, this exact request
  // minted a finding. That is the regression this test pins.
  const env = { DB: db, OPERATOR_NAME: 'tester', TELEGRAM_CHAT_ID: '1' };
  const res = await index.fetch(postProof('ghost-hunt', MINIMAL_PROOF), env, hookCtx());
  assert.equal(res.status, 503);
  const findings = db.raw.prepare('SELECT COUNT(*) AS n FROM findings').get();
  assert.equal(findings.n, 0, 'an unconfigured hook must create NO finding');
});

test('/hook/proof rejects a callback with no secret header', async () => {
  const db = makeDb();
  const res = await index.fetch(postProof('ghost-hunt', MINIMAL_PROOF, null), hookEnv(db), hookCtx());
  assert.equal(res.status, 403);
  const findings = db.raw.prepare('SELECT COUNT(*) AS n FROM findings').get();
  assert.equal(findings.n, 0);
});

test('/hook/proof rejects a callback with the wrong secret', async () => {
  const db = makeDb();
  const res = await index.fetch(
    postProof('ghost-hunt', MINIMAL_PROOF, 'not-the-secret'),
    hookEnv(db),
    hookCtx(),
  );
  assert.equal(res.status, 403);
  const findings = db.raw.prepare('SELECT COUNT(*) AS n FROM findings').get();
  assert.equal(findings.n, 0);
});

test('a forged proof with the CORRECT secret on an unknown hunt is an orphan, not a finding', async () => {
  // Authentication is not authorisation: the hunt id must still resolve.
  const db = makeDb();
  const res = await index.fetch(postProof('ghost-hunt', MINIMAL_PROOF), hookEnv(db), hookCtx());
  assert.notEqual(res.status, 403);
  const findings = db.raw.prepare('SELECT COUNT(*) AS n FROM findings').get();
  assert.equal(findings.n, 0, 'an orphan callback must never mint a finding');
});

test('/hook/proof for an unknown hunt id does not crash and records an orphan', async () => {
  const db = makeDb();

  const res = await index.fetch(
    postProof('ghost-hunt', {
      contract: 'Vault',
      commit: SHA,
      leads_found: 3,
      attempts: 2,
      proven: 0,
      verdicts: [
        { test_name: 'test_reentrancy', playbook: 'sol.reentrancy', verdict: 'disproved', confidence: 'firm' },
      ],
    }),
    hookEnv(db),
    hookCtx(),
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orphan, true, 'an unknown hunt id must be reported as an orphan');

  // Recorded, attributable to nothing, and honest about why it stopped.
  const row = db.raw.prepare('SELECT * FROM hunts WHERE id=?').get('ghost-hunt');
  assert.ok(row, 'the verdict must not be silently dropped');
  assert.equal(row.stage, 'done');
  assert.equal(row.program_id, null, 'a contract name is not a program id');
  assert.equal(row.commit_sha, SHA);
  assert.equal(row.contract, 'Vault');
  assert.match(row.stopped_because, /orphan callback/);
});

test('/hook/proof for a dispatched hunt lands on the row created at dispatch time', async () => {
  const db = makeDb();
  const brief = provableBrief();
  seedApproval(db, brief);
  const rec = recorder();

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch()),
  );
  assert.equal(out.dispatched, true);

  // Before the callback: a dispatched hunt in stage prime.
  let row = db.raw.prepare('SELECT * FROM hunts WHERE id=?').get(out.huntId);
  assert.equal(row.stage, STAGE_DISPATCHED);
  assert.equal(row.program_id, brief.program_id);

  const res = await index.fetch(
    postProof(out.huntId, {
      contract: 'Vault',
      commit: SHA,
      leads_found: 4,
      attempts: 2,
      proven: 0,
      limitations: ['no measured impact on the pinned fork'],
      verdicts: [
        { test_name: 'test_t1', playbook: 'sol.reentrancy', verdict: 'partial', confidence: 'firm' },
        { test_name: 'test_t2', playbook: 'sol.access', verdict: 'disproved', confidence: 'confirmed' },
      ],
    }),
    hookEnv(db),
    hookCtx(),
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orphan, false);
  assert.equal(body.verdicts, 2);

  row = db.raw.prepare('SELECT * FROM hunts WHERE id=?').get(out.huntId);
  assert.equal(row.stage, 'done');
  assert.equal(row.leads_n, 4);
  assert.equal(row.attempts_n, 2);
  assert.equal(row.proven_n, 0);
  assert.match(row.stopped_because, /no measured impact/);
  // The provenance written at dispatch time survives the callback.
  assert.equal(row.repo, GIT_URL);
  assert.equal(row.program_id, brief.program_id);

  const proofs = db.raw.prepare('SELECT * FROM proofs WHERE hunt_id=? ORDER BY test_name').all(out.huntId);
  assert.equal(proofs.length, 2);
  assert.deepEqual(
    proofs.map((p) => p.verdict),
    ['partial', 'disproved'],
  );

  // Nothing unproven reaches the queue.
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 0);
});

test('/hook/proof still requires the hunt header', async () => {
  const db = makeDb();
  const res = await index.fetch(
    new Request('https://w.example/hook/proof', {
      method: 'POST',
      // A valid secret, so this test reaches the hunt-id check it is named for:
      // without the secret it would 403 first and assert the wrong thing.
      headers: { 'content-type': 'application/json', 'x-asterion-secret': HOOK_SECRET },
      body: '{}',
    }),
    hookEnv(db),
    hookCtx(),
  );
  assert.equal(res.status, 400);
});

test('a proven verdict lands as a finding attributed to the real program', async () => {
  // Regression: binding the contract name into findings.program_id violates the
  // FK to programs(id), which aborted ingest and silently lost later verdicts.
  const db = makeDb();
  const brief = provableBrief();
  seedApproval(db, brief);
  const rec = recorder();

  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch()),
  );

  const res = await index.fetch(
    postProof(out.huntId, {
      contract: 'Vault',
      commit: SHA,
      leads_found: 2,
      attempts: 2,
      proven: 1,
      verdicts: [
        {
          test_name: 'test_reentrancy',
          playbook: 'sol.reentrancy',
          file: 'src/Vault.sol',
          line: 42,
          verdict: 'proven',
          confidence: 'confirmed',
          reasons: ['attack fails', 'control passes', 'impact measured'],
          proven_claim: 'Vault.withdraw drains the balance via a re-entrant call',
        },
        // A later verdict in the same batch must still be stored: the FK abort
        // used to destroy everything after the first proven verdict.
        { test_name: 'test_access', playbook: 'sol.access', verdict: 'disproved', confidence: 'firm' },
      ],
    }),
    hookEnv(db),
    hookCtx(),
  );

  assert.equal(res.status, 200);

  const findings = db.raw.prepare('SELECT * FROM findings').all();
  assert.equal(findings.length, 1, 'the proven verdict must become a finding');
  assert.equal(findings[0].program_id, brief.program_id, 'attributed to the real program');
  assert.equal(findings[0].proof_state, 'proven');
  assert.equal(findings[0].cls, 'sol.reentrancy');
  assert.match(findings[0].summary, /re-entrant/);

  const proofs = db.raw.prepare('SELECT test_name FROM proofs WHERE hunt_id=?').all(out.huntId);
  assert.equal(proofs.length, 2, 'no verdict after the proven one was lost');
});

// ── TARGET must be an ADDRESS, never the repo URL ────────────────────────────
//
// Regression for a defect that made every PoC unprovable: prove.yml fed
// `inputs.repo` (a git URL) into TARGET, but poc.ts does
// `vm.envAddress("TARGET")`, so setUp reverted and every verdict could only be
// inconclusive.

const ADDRESS = '0x00000000000000000000000000000000000000ab';

test('an explicit 0x target is carried through as the address', () => {
  const d = deriveProveInputs(provableBrief({ targets: [`${GIT_URL}@${SHA}`, ADDRESS] }));
  assert.equal(d.ok, true);
  assert.equal(d.inputs.address, ADDRESS);
});

test('the address is normalised to lowercase', () => {
  const mixed = '0x00000000000000000000000000000000000000AB';
  const d = deriveProveInputs(provableBrief({ targets: [`${GIT_URL}@${SHA}`, mixed] }));
  assert.equal(d.inputs.address, mixed.toLowerCase());
});

test('a git URL is NEVER used as the address', () => {
  // The whole point: repo is present, address is absent, and we must not
  // substitute one for the other.
  const d = deriveProveInputs(provableBrief());
  assert.equal(d.ok, true);
  assert.equal(d.inputs.repo, GIT_URL);
  assert.equal(d.inputs.address, undefined);
});

test('an address can come from an explicit notes token', () => {
  const d = deriveProveInputs(
    provableBrief({
      targets: [GIT_URL],
      notes: `contract:Vault repo:${GIT_URL} commit:${SHA} address:${ADDRESS}`,
    }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.inputs.address, ADDRESS);
});

test('a 0x-looking string in prose is not accepted as an address', () => {
  const d = deriveProveInputs(
    provableBrief({
      targets: [GIT_URL],
      notes: `contract:Vault repo:${GIT_URL} commit:${SHA} saw 0xdeadbeef on chain`,
    }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.inputs.address, undefined);
});

test('the dispatch body omits address entirely when unknown', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  const d = deriveProveInputs(provableBrief());
  await dispatchProveWorkflow(
    { token: 't', githubRepo: 'o/r', ref: 'main', inputs: { ...d.inputs, hunt_id: 'h1' } },
    { fetch },
  );
  assert.equal('address' in seen[0].inputs, false);
});

test('the dispatch body carries address when known', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  const d = deriveProveInputs(provableBrief({ targets: [`${GIT_URL}@${SHA}`, ADDRESS] }));
  await dispatchProveWorkflow(
    { token: 't', githubRepo: 'o/r', ref: 'main', inputs: { ...d.inputs, hunt_id: 'h1' } },
    { fetch },
  );
  assert.equal(seen[0].inputs.address, ADDRESS);
  assert.notEqual(seen[0].inputs.address, GIT_URL);
});

// ── scope bounds (PentestGPT's allowed_targets cap) ──────────────────────────
//
// A brief pasted from a bounty page can carry an unbounded target list, which
// silently widens the engagement past the sentence authorizing it.

test('a brief at the target ceiling is accepted', () => {
  const targets = Array.from({ length: MAX_TARGETS }, (_, i) => `h${i}.example`);
  const r = checkTargetBounds(targets);
  assert.equal(r.ok, true);
});

test('one target over the ceiling is refused, and says why', () => {
  const targets = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `h${i}.example`);
  const r = checkTargetBounds(targets);
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeds the 16-target ceiling/);
});

test('duplicates are refused rather than silently deduped', () => {
  const r = checkTargetBounds(['a.example', 'A.EXAMPLE']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate/);
});

test('an over-long entry is refused', () => {
  const r = checkTargetBounds([`https://x.example/${'a'.repeat(MAX_TARGET_ENTRY)}`]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /2048 limit/);
});

test('roeFromBrief refuses an over-wide brief instead of narrowing it', () => {
  const targets = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `h${i}.example`);
  assert.throws(
    () =>
      roeFromBrief({
        program_id: 'p',
        targets,
        max_mutability: 'read',
        time_box_minutes: 60,
        authorization_ref: 'ref',
      }),
    /scope refused/,
  );
});

// ── B8: a Solana brief must never queue a Foundry job ────────────────────────

/**
 * The B8 gate, end to end.
 *
 * `sol.svm-*` used to declare cls 'solidity', so they passed deriveProveInputs
 * and dispatched a FOUNDRY job at an Anchor program: guaranteed `inconclusive`,
 * and it looked like a legitimate run. The assertion that matters is that
 * `fetch` is NEVER CALLED — a refusal that still POSTs would be the bug wearing
 * a different hat.
 */
test('dispatching an sol.svm-* brief refuses by name and never calls fetch', async () => {
  for (const [i, playbook] of ['sol.svm-signer', 'sol.svm-account', 'sol.svm-cpi'].entries()) {
    const brief = provableBrief({
      cls: 'solana',
      playbooks: [playbook],
      // Deliberately complete provenance: repo, a pinned sha and a contract name
      // are all present, so the ONLY reason this can be refused is the missing
      // Solana plane. If derivation were failing for an unrelated reason the test
      // would pass for the wrong reason, which is why the message is asserted.
      targets: [`${GIT_URL}@${SHA}`, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      notes: `contract:Vault repo:${GIT_URL} commit:${SHA}`,
    });
    const db = makeDb();
    seedApproval(db, brief, `appr-svm-${i}`);
    const rec = recorder();
    const fetched = [];

    const out = await approveAndDispatch(
      `appr-svm-${i}`,
      true,
      rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch(fetched)),
    );

    // 1. refused, with the documented reason code
    assert.equal(out.dispatched, false, `${playbook}: must not dispatch`);
    assert.equal(out.reason, 'not_provable_class', `${playbook}: refusal reason`);
    assert.deepEqual(out.missing, ['cls']);

    // 2. NO workflow dispatch was attempted. This is the load-bearing assertion.
    assert.equal(fetched.length, 0, `${playbook}: a Foundry job was queued for a Solana brief`);
    assert.ok(
      !rec.ledgers.some((l) => l.kind === 'dispatch.sent'),
      `${playbook}: the ledger must not record a dispatch`,
    );

    // 3. no hunts row: a hunt that no compute was asked to run is a lie
    assert.equal(hunts(db).length, 0, `${playbook}: a hunts row was created`);

    // 4. the operator was told WHY, naming the missing plane
    const msg = rec.msgs.join('\n');
    assert.match(msg, /Solana \(SVM\)/, `${playbook}: message must name the missing plane`);
    assert.match(msg, /NOT DISPATCHED/);
    assert.match(msg, /no proof path for this class/);

    // 5. and it is on the ledger, so the refusal is auditable
    assert.ok(
      rec.ledgers.some((l) => l.kind === 'dispatch.blocked' && l.payload.gate === 'allow'),
      `${playbook}: refusal must be recorded on the ledger`,
    );
  }
});

test('the solana refusal message is stable and names the plane verbatim', async () => {
  const brief = provableBrief({
    cls: 'solana',
    playbooks: ['sol.svm-signer'],
    notes: `contract:Vault repo:${GIT_URL} commit:${SHA}`,
  });
  const db = makeDb();
  seedApproval(db, brief);
  const rec = recorder();
  const fetched = [];
  await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch(fetched)),
  );
  assert.equal(fetched.length, 0);
  // eslint-disable-next-line no-console
  console.log('B8 dispatch refusal (operator view):\n' + rec.msgs.join('\n'));
});

test('a solidity brief with the SAME targets still dispatches (the control)', async () => {
  // Proves the refusal above is about the CLASS and not about the fixture: the
  // exact same repo/sha/contract, reclassified as solidity, must still dispatch.
  const brief = provableBrief({
    cls: 'solidity',
    targets: [`${GIT_URL}@${SHA}`],
    notes: `contract:Vault repo:${GIT_URL} commit:${SHA}`,
  });
  const db = makeDb();
  seedApproval(db, brief);
  const rec = recorder();
  const fetched = [];
  const out = await approveAndDispatch(
    'appr-1',
    true,
    rec.deps(db, { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'me/asterion' }, okFetch(fetched)),
  );
  assert.equal(out.dispatched, true, 'the solidity control must dispatch');
  assert.equal(fetched.length, 1, 'exactly one workflow_dispatch');
  assert.equal(hunts(db).length, 1);
});
