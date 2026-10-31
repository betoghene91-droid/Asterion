/**
 * The authorization ingress, driven at the SHIPPED entrypoint.
 *
 * Every claim here goes through `build/index.js` — the `/tg` webhook — or through
 * the exported functions in `build/authorize.js` that the webhook itself calls.
 * Nothing re-implements a classifier or a gate, which is the whole point of the
 * change: there is now one of each.
 *
 * WHAT EACH BLOCK PROVES
 *
 *   identity   a repo gets its OWN program row, two repos on the same forge do
 *              not share one, and a genuine hostname still resolves to itself.
 *   /policy    a fetched document is classified by the SAME `classifyAutomation`
 *              the crawler uses, recorded, and reaches an Authorize card; an
 *              unreachable URL, a cross-site URL, an http URL and a prohibiting
 *              document all refuse and write NOTHING (or write the prohibition).
 *   /own       a repo can be self-asserted; a host, an address and a CIDR cannot,
 *              each refused by name; a prohibition cannot be overwritten.
 *   the gate   is NOT weaker. `prohibited` is terminal, a bare `0x…` with no
 *              `chain_id` is still refused, and a `self:` anchor on a host does
 *              not resolve.
 *   the copy   both surfaces say the same thing, and every command the refusal
 *              names is actually dispatched by the router.
 *
 * THE ONE STUB: outbound HTTP. `globalThis.fetch` is replaced for the duration of
 * each test so nothing talks to the network, and the replacement records every
 * call — that is how the Telegram assertions read the card the operator sees. The
 * database is real (`node:sqlite` over `app/schema.sql`), the router is real, and
 * the classifier is real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';
import {
  authorizationFor,
  authorizationRefusal,
  authorizeWithPolicy,
  gateMode,
  isGateMode,
  isRepoProgramId,
  policySourceAllowed,
  resolveTargetRef,
  selfAssertRepo,
  SELF_SCHEME,
  ANCHOR_COMMANDS,
} from '../build/authorize.js';
import { classifyAutomation } from '../build/discovery.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

const TOKEN = '123456:TESTTOKEN';
const CHAT = 999;
const ORIGIN = 'https://asterion.test.workers.dev';

// ── harness ─────────────────────────────────────────────────────────────────

function makeEnv(extra = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const api = {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      const bound = (binds) => ({
        async first() {
          return stmt.get(...binds) ?? null;
        },
        async run() {
          return stmt.run(...binds);
        },
        async all() {
          return { results: stmt.all(...binds) };
        },
        bind(...b) {
          return bound(b);
        },
      });
      return bound([]);
    },
  };
  return {
    raw,
    env: {
      DB: api,
      OPERATOR_NAME: 'jen',
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: String(CHAT),
      ...extra,
    },
  };
}

/**
 * A fake `fetch` that serves policy documents from a table and 404s everything else.
 * It also absorbs the api.telegram.org calls the webhook makes, recording each
 * request BODY so the Telegram assertions can read the card the operator sees.
 */
function stubFetch(docs = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u, method: (init && init.method) || 'GET', body });

    if (u.startsWith('https://api.telegram.org/')) {
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const doc = docs[u];
    if (doc === undefined) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    if (doc === null) throw new Error('ENOTFOUND: could not resolve host');
    if (typeof doc === 'object' && doc.contentType) {
      return new Response(doc.body, {
        status: 200,
        headers: { 'content-type': doc.contentType },
      });
    }
    return new Response(String(doc), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  };
  return { impl, calls };
}

/** Run one Telegram text message through the real webhook, with a stub fetch. */
async function tgText(env, text, docs = {}) {
  const { impl, calls } = stubFetch(docs);
  const realFetch = globalThis.fetch;
  const errors = [];
  const realError = console.error;
  globalThis.fetch = impl;
  console.error = (...a) => errors.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  const pending = [];
  try {
    const res = await index.fetch(
      new Request(`${ORIGIN}/tg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: { chat: { id: CHAT }, text } }),
      }),
      env,
      { waitUntil: (p) => pending.push(p), passThroughOnException: () => {} },
    );
    assert.equal(res.status, 200);
    await Promise.allSettled(pending);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  return { calls, errors };
}

/**
 * The text of the LAST message the webhook emitted, from the recorded call body.
 *
 * Reads `calls`, which `stubFetch` filled — the bodies live there rather than in a
 * side table, because a module-level map keyed on a re-created object literal was a
 * bug in the first version of this file: it never matched, so every assertion read
 * an empty string and the tests failed for a reason unrelated to the code.
 */
/** Run one Telegram CALLBACK through the real webhook (`ans:` / `ok:` buttons). */
async function tgBody(env, body, docs = {}) {
  const { impl, calls } = stubFetch(docs);
  const realFetch = globalThis.fetch;
  const errors = [];
  const realError = console.error;
  globalThis.fetch = impl;
  console.error = (...a) => errors.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  const pending = [];
  try {
    const res = await index.fetch(
      new Request(`${ORIGIN}/tg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      { waitUntil: (p) => pending.push(p), passThroughOnException: () => {} },
    );
    assert.equal(res.status, 200);
    await Promise.allSettled(pending);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  return { calls, errors };
}

/**
 * Drive the whole CA flow: send the address, then tap the chain button Telegram
 * would render. This is the operator's reported dead end, exercised end to end
 * through the shipped webhook rather than by calling the gate directly.
 */
async function tgButtonChain(env, address, chainId) {
  const first = await tgText(env, `hunt ${address}`);
  assert.match(lastBody(first.calls), /Which chain is that contract on\?/, 'the chain must be ASKED');
  return tgBody(env, {
    callback_query: {
      id: 'cb',
      data: `ans:chain:${chainId}`,
      message: { chat: { id: CHAT }, message_id: 12 },
    },
  });
}

function lastBody(calls) {
  const sent = calls.filter(
    (c) => c.url.includes('/sendMessage') || c.url.includes('/editMessageText'),
  );
  assert.ok(sent.length, 'the webhook must have answered');
  return String(sent[sent.length - 1].body?.text ?? '');
}

// ── identity: the collapse, and its fix ──────────────────────────────────────

test('a repo reference gets its OWN program id, and two repos on one forge do not share a row', async () => {
  const { raw, env } = makeEnv();

  const a = resolveTargetRef('https://github.com/acme/vault');
  const b = resolveTargetRef('https://github.com/acme/other');
  assert.equal(a.kind, 'repo');
  assert.equal(a.program, 'github.com:acme/vault');
  assert.equal(b.program, 'github.com:acme/other');
  assert.notEqual(a.program, b.program, 'two repos must not collapse onto one row');

  // The old bug, pinned: the id was literally 'github.com' for every repo.
  assert.notEqual(a.program, 'github.com', 'the collapse must not recur');

  // ...and the same is true through the shipped webhook, which is where it
  // actually mattered: distributing authorisation to every repo on the forge.
  await tgText(env, '/own acme/vault');
  await tgText(env, '/own acme/other');
  const ids = raw
    .prepare("SELECT id FROM programs WHERE id LIKE 'github.com:%' ORDER BY id")
    .all()
    .map((r) => r.id);
  assert.deepEqual(ids, ['github.com:acme/other', 'github.com:acme/vault']);
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM programs WHERE id='github.com'").get().n,
    0,
    'no row may be keyed on the bare forge host',
  );
});

test('a genuine hostname still resolves to itself, exactly as before', () => {
  // The historical regex is unchanged, so every host the old code resolved still
  // resolves the same way. This is the "do not change behaviour for genuine
  // hosts" half of the requirement.
  for (const [input, expected] of [
    ['look at app.example.com api', 'app.example.com'],
    ['APP.Example.COM', 'app.example.com'],
    ['https://app.example.com/path?q=1', 'app.example.com'],
    ['beta.example.com', 'beta.example.com'],
    ['scan sub.a.b.example.co.uk now', 'sub.a.b.example.co.uk'],
  ]) {
    const ref = resolveTargetRef(input);
    assert.equal(ref.kind, 'host', `${input} must be a host`);
    assert.equal(ref.program, expected, `${input} must resolve to ${expected}`);
  }
});

test('a scheme-less forge path is a repo; a bare slug is per-repo only when declared as one', () => {
  assert.equal(resolveTargetRef('github.com/acme/vault').program, 'github.com:acme/vault');
  assert.equal(resolveTargetRef('github.com/acme/vault').kind, 'repo');
  assert.equal(resolveTargetRef('gitlab.com/acme/vault').program, 'gitlab.com:acme/vault');

  // `github.com` ALONE is a host, not a repo: there is no owner/name to key on.
  assert.equal(resolveTargetRef('github.com').kind, 'host');

  // A bare slug is ambiguous in free text (`api/v2` is a version string), so it
  // is only read as a repo when the caller says the whole token is a target.
  assert.equal(resolveTargetRef('acme/vault').kind, 'none');
  assert.equal(resolveTargetRef('acme/vault', true).program, 'github.com:acme/vault');

  // A dotted first segment is a host path, never a repo.
  assert.notEqual(resolveTargetRef('app.example.com/api', true).kind, 'repo');
});

test('isRepoProgramId distinguishes a repo id from a host id', () => {
  assert.equal(isRepoProgramId('github.com:acme/vault'), true);
  assert.equal(isRepoProgramId('app.example.com'), false);
  assert.equal(isRepoProgramId('unscoped'), false);
});

// ── /policy: success ────────────────────────────────────────────────────────

const PERMIT_DOC = `
# Security policy
We are happy to receive reports.
Automated scanning is permitted on the staging hosts.
Bounties are paid.
`;

test('/policy fetches, classifies and records the anchor — and the target becomes huntable', async () => {
  const { raw, env } = makeEnv();
  const url = 'https://app.example.com/security';

  // The SAME classifier the crawler uses must produce the same verdict.
  assert.equal(classifyAutomation(PERMIT_DOC), 'allowed');

  const out = await authorizeWithPolicy(env, 'app.example.com', url, {
    fetch: stubFetch({ [url]: PERMIT_DOC }).impl,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.automation, 'allowed');
  assert.ok(out.bytes > 0);
  assert.match(out.sha, /^[0-9a-f]{64}$/, 'policy_sha must be the real document hash');
  assert.match(out.anchor, /permits automated testing/);

  const row = raw.prepare('SELECT * FROM programs WHERE id=?').get('app.example.com');
  assert.equal(row.policy_url, url);
  assert.equal(row.automation, 'allowed');
  assert.equal(row.status, 'parsed');
  assert.equal(row.policy_sha, out.sha);
  assert.match(row.policy_text, /Automated scanning is permitted/);

  // And that row now satisfies the gate.
  assert.match(await authorizationFor(env, 'app.example.com'), /permits automated testing/);
});

test('the "/policy …" command reaches an Authorize card through the real webhook', async () => {
  const { raw, env } = makeEnv();
  const url = 'https://app.example.com/security';
  const docs = { [url]: PERMIT_DOC };

  // 1. the command records the anchor and says what it parsed
  const first = await tgText(env, `/policy app.example.com ${url}`, docs);
  assert.deepEqual(first.errors, []);
  const recorded = lastBody(first.calls);
  assert.match(recorded, /POLICY RECORDED/);
  assert.match(recorded, /allowed/);
  assert.match(recorded, /sha256/);

  // 2. a hunt for the same host now produces the engagement card, not a refusal
  const second = await tgText(env, 'look at app.example.com api please', docs);
  const card = lastBody(second.calls);
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(card), `must not be refused: ${card}`);
  assert.match(card, /ENGAGEMENT/);
  assert.match(card, /app\.example\.com\/security permits automated testing/);

  const buttons = JSON.stringify(second.calls) + recorded;
  assert.ok(/ok:/.test(buttons) || /Authorize/.test(card), 'an Authorize affordance must exist');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 1);
});

// ── /policy: every refusal, and nothing written ─────────────────────────────

test('/policy refuses a prohibiting document, RECORDS the prohibition, and never authorizes', async () => {
  const { raw, env } = makeEnv();
  const url = 'https://locked.example.com/security';
  const doc = 'Automated testing is prohibited. Do not use automated tools.';

  assert.equal(classifyAutomation(doc), 'prohibited');
  const out = await authorizeWithPolicy(env, 'locked.example.com', url, {
    fetch: stubFetch({ [url]: doc }).impl,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'prohibited');

  // The prohibition is recorded — that IS the finding — and the gate refuses.
  const row = raw.prepare('SELECT automation, policy_url FROM programs WHERE id=?').get('locked.example.com');
  assert.equal(row.automation, 'prohibited');
  assert.equal(row.policy_url, url);
  assert.equal(await authorizationFor(env, 'locked.example.com'), null);

  // Through the webhook: the card says so, and no approval exists.
  const { calls, errors } = await tgText(env, `/policy locked.example.com ${url}`, { [url]: doc });
  assert.deepEqual(errors, []);
  assert.match(lastBody(calls), /PROHIBITED — NOT AUTHORIZED/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});

test('/policy writes NOTHING when the URL is unreachable, empty, non-text, http or cross-site', async () => {
  const cases = [
    {
      name: 'a 404',
      target: 'gone.example.com',
      url: 'https://gone.example.com/security',
      docs: {},
      reason: 'unreachable',
    },
    {
      name: 'a DNS failure',
      target: 'dead.example.com',
      url: 'https://dead.example.com/security',
      docs: { 'https://dead.example.com/security': null },
      reason: 'unreachable',
    },
    {
      name: 'an empty body',
      target: 'empty.example.com',
      url: 'https://empty.example.com/security',
      docs: { 'https://empty.example.com/security': '' },
      reason: 'unusable',
    },
    {
      name: 'a non-text content type',
      target: 'bin.example.com',
      url: 'https://bin.example.com/security',
      docs: { 'https://bin.example.com/security': { contentType: 'application/pdf', body: '%PDF' } },
      reason: 'unusable',
    },
    {
      name: 'an http URL',
      target: 'plain.example.com',
      url: 'http://plain.example.com/security',
      docs: {},
      reason: 'not_https',
    },
    {
      name: 'a cross-site document',
      target: 'victim.example.com',
      url: 'https://attacker.example.net/whatever.txt',
      docs: { 'https://attacker.example.net/whatever.txt': PERMIT_DOC },
      reason: 'cross_site',
    },
    {
      name: 'a malformed URL',
      target: 'bad.example.com',
      url: 'not-a-url',
      docs: {},
      reason: 'bad_url',
    },
  ];

  for (const c of cases) {
    const { raw, env } = makeEnv();
    const out = await authorizeWithPolicy(env, c.target, c.url, {
      fetch: stubFetch(c.docs).impl,
    });
    assert.equal(out.ok, false, `${c.name} must refuse`);
    assert.equal(out.reason, c.reason, `${c.name} must give reason ${c.reason}`);

    // THE KEY ASSERTION: a failed ingress leaves no half-authorized row. Either
    // the row does not exist, or it exists with no policy_url and no permissive
    // automation — never a row the gate would accept.
    const row = raw.prepare('SELECT automation, policy_url FROM programs WHERE id=?').get(c.target);
    if (row) {
      assert.equal(row.policy_url, null, `${c.name} must not write a policy_url`);
      assert.notEqual(row.automation, 'allowed', `${c.name} must not write 'allowed'`);
    }
    assert.equal(await authorizationFor(env, c.target), null, `${c.name} must leave the target refused`);
  }
});

test('a self-assertion cannot be laundered through /policy’s cross-site check', () => {
  // The check that stops "point at any file". A document must come from the
  // target's own site or a programme platform.
  assert.equal(policySourceAllowed('example.com', 'example.com'), true);
  assert.equal(policySourceAllowed('app.example.com', 'example.com'), true, 'the apex may speak for a subdomain');
  assert.equal(policySourceAllowed('example.com', 'app.example.com'), true, 'and vice versa');
  assert.equal(policySourceAllowed('example.com', 'hackerone.com'), true, 'a platform may speak for a programme');

  // The suffix test is label-aware: evilexample.com is NOT example.com.
  assert.equal(policySourceAllowed('example.com', 'evilexample.com'), false);
  assert.equal(policySourceAllowed('example.com', 'example.com.evil.net'), false);
  assert.equal(policySourceAllowed('example.com', 'attacker.net'), false);
});

test('/policy refuses an address target BY NAME (an address is not a programme)', async () => {
  const { env } = makeEnv();
  const out = await authorizeWithPolicy(env, '0x' + 'a'.repeat(40), 'https://example.com/security', {
    fetch: stubFetch({ 'https://example.com/security': PERMIT_DOC }).impl,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'bad_target');
  assert.match(out.detail, /chain_id/, 'it must name the field the operator has to add');
});

// ── /own: the self-assertion, and its fences ────────────────────────────────

test('/own records an auditable self-assertion for a REPO and nothing else', async () => {
  const { raw, env } = makeEnv();
  const out = await selfAssertRepo(env, 'acme/vault', 'jen', 1700000000);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.program, 'github.com:acme/vault');
  assert.match(out.selfRef, /^self:/);

  const row = raw.prepare('SELECT * FROM programs WHERE id=?').get('github.com:acme/vault');
  // Distinguishable, non-forgeable-looking value: a scheme no fetch can produce.
  assert.ok(row.policy_url.startsWith(SELF_SCHEME));
  assert.match(row.policy_url, /operator=jen/);
  assert.match(row.policy_url, /asserted_at=1700000000/);
  // It does NOT claim permission no document gave.
  assert.equal(row.automation, 'not_mentioned', 'no policy mentions automation, so it is not "allowed"');
  // Auditable in `meta` too.
  const meta = JSON.parse(row.meta);
  assert.equal(meta.self_assertion.by, 'jen');
  assert.equal(meta.self_assertion.at, 1700000000);
  assert.equal(meta.self_assertion.repo, 'acme/vault');

  // The gate resolves it, and its text carries the distinction into the brief.
  const anchor = await authorizationFor(env, 'github.com:acme/vault');
  assert.match(anchor, /^self:/);
  assert.match(anchor, /no prohibition on automated testing/);
});

test('/own REFUSES a host, an address and a CIDR by name', async () => {
  const cases = [
    { target: 'example.com', reason: 'not_a_repo', word: /host/i },
    { target: '0x' + 'b'.repeat(40), reason: 'address', word: /address/i },
    { target: '10.0.0.0/8', reason: 'not_a_repo', word: /third-party|host|refused/i },
  ];
  for (const c of cases) {
    const { raw, env } = makeEnv();
    const out = await selfAssertRepo(env, c.target, 'jen');
    assert.equal(out.ok, false, `${c.target} must be refused`);
    assert.equal(out.reason, c.reason, `${c.target} must give reason ${c.reason}`);
    assert.match(out.detail, c.word);
    assert.equal(out.selfRef, null, 'nothing may be recorded');
    assert.equal(
      raw.prepare("SELECT COUNT(*) AS n FROM programs WHERE policy_url LIKE 'self:%'").get().n,
      0,
    );
  }
});

test('/own cannot overwrite automation=prohibited, nor replace a fetched policy', async () => {
  // (a) prohibition wins
  {
    const { raw, env } = makeEnv();
    await selfAssertRepo(env, 'acme/locked', 'jen');
    raw.prepare("UPDATE programs SET automation='prohibited' WHERE id=?")
      .run('github.com:acme/locked');
    const out = await selfAssertRepo(env, 'acme/locked', 'jen');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'prohibited');
    const row = raw.prepare('SELECT automation FROM programs WHERE id=?').get('github.com:acme/locked');
    assert.equal(row.automation, 'prohibited', 'the prohibition must survive');
    assert.equal(await authorizationFor(env, 'github.com:acme/locked'), null);
  }

  // (b) a fetched document is stronger than an assertion
  {
    const { raw, env } = makeEnv();
    const url = 'https://github.com/acme/fetched/security';
    await authorizeWithPolicy(env, 'acme/fetched', url, {
      fetch: stubFetch({ [url]: PERMIT_DOC }).impl,
    });
    const before = raw.prepare('SELECT policy_url FROM programs WHERE id=?').get('github.com:acme/fetched');
    const out = await selfAssertRepo(env, 'acme/fetched', 'jen');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'already_fetched');
    const after = raw.prepare('SELECT policy_url FROM programs WHERE id=?').get('github.com:acme/fetched');
    assert.equal(after.policy_url, before.policy_url, 'the document must not be replaced by a claim');
  }
});

test('the "/own …" command reaches an Authorize card for a repo, and the brief carries the self: anchor', async () => {
  const { raw, env } = makeEnv();

  const first = await tgText(env, '/own acme/vault');
  assert.deepEqual(first.errors, []);
  const recorded = lastBody(first.calls);
  assert.match(recorded, /SELF-ASSERTED REPO AUDIT/);
  assert.match(recorded, /self:operator=jen/);

  // The hunt compiles to a card, and the anchor shown IS the self-assertion —
  // so the report can never present it as a fetched policy.
  const second = await tgText(env, 'audit https://github.com/acme/vault carefully');
  const card = lastBody(second.calls);
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(card), `a self-asserted repo must not be refused: ${card}`);
  assert.match(card, /ENGAGEMENT/);
  assert.match(card, /self:operator=jen/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 1);
});

test('/own refuses a host through the webhook too, and says why', async () => {
  const { raw, env } = makeEnv();
  const { calls, errors } = await tgText(env, '/own example.com');
  assert.deepEqual(errors, []);
  const card = lastBody(calls);
  assert.match(card, /REFUSED — NOT A REPOSITORY/);
  assert.match(card, /third-party system/);
  assert.match(card, /\/policy/, 'it must point at the route that DOES work for a host');
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM programs WHERE policy_url LIKE 'self:%'").get().n,
    0,
  );
});

// ── the gate is not weaker ──────────────────────────────────────────────────

test('GATE: a self: anchor on a HOST never resolves, even if someone hand-writes the row', async () => {
  // /own refuses hosts, so this row cannot be created through any command. The
  // gate refuses it anyway — belt to that brace, because a hand-edited or
  // restored-from-backup row must not become an authorization for a live host.
  const { raw, env } = makeEnv();
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,policy_url,automation,status,discovered_at)
       VALUES ('live.example.com','live.example.com','self','self:operator=jen;asserted_at=1','not_mentioned','parsed',1)`,
    )
    .run();
  assert.equal(await authorizationFor(env, 'live.example.com'), null);
});

test('GATE: prohibited is terminal in every path, including a re-fetch', async () => {
  const { raw, env } = makeEnv();
  const url = 'https://p.example.com/security';
  await authorizeWithPolicy(env, 'p.example.com', url, {
    fetch: stubFetch({ [url]: 'Automated testing is prohibited.' }).impl,
  });
  assert.equal(await authorizationFor(env, 'p.example.com'), null);

  // A second document that merely FAILS TO MENTION automation must not lift it.
  const url2 = 'https://p.example.com/security2';
  const out = await authorizeWithPolicy(env, 'p.example.com', url2, {
    fetch: stubFetch({ [url2]: 'We like reports. Contact security@p.example.com.' }).impl,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unusable');
  assert.equal(
    raw.prepare('SELECT automation FROM programs WHERE id=?').get('p.example.com').automation,
    'prohibited',
    'silence must not repeal a prohibition',
  );
  assert.equal(await authorizationFor(env, 'p.example.com'), null);
});

test('GATE: only an affirmative permission may lift an earlier prohibition', async () => {
  const { raw, env } = makeEnv();
  const denied = 'https://q.example.com/security';
  await authorizeWithPolicy(env, 'q.example.com', denied, {
    fetch: stubFetch({ [denied]: 'Automated testing is prohibited.' }).impl,
  });
  assert.equal(await authorizationFor(env, 'q.example.com'), null);

  // The programme changes its mind and publishes an affirmative permission.
  const allowed = 'https://q.example.com/security-v2';
  const out = await authorizeWithPolicy(env, 'q.example.com', allowed, {
    fetch: stubFetch({ [allowed]: 'Automated scanning is permitted on all assets.' }).impl,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(
    raw.prepare('SELECT automation FROM programs WHERE id=?').get('q.example.com').automation,
    'allowed',
  );
});

test('GATE: a bare 0x… address is ASKED for its chain, and until it answers not even the gate is reached', async () => {
  const { raw, env } = makeEnv();
  const ca = '0x' + 'c'.repeat(40);

  // `/policy` will not authorize an address — an address has no policy page.
  const p = await authorizeWithPolicy(env, ca, 'https://example.com/security', {
    fetch: stubFetch({ 'https://example.com/security': PERMIT_DOC }).impl,
  });
  assert.equal(p.reason, 'bad_target');
  assert.match(p.detail, /chain_id/, 'it must name the field the operator has to add');

  // `/own` will not either — it is not a repository.
  const o = await selfAssertRepo(env, ca, 'jen');
  assert.equal(o.reason, 'address');

  // THE HUNT PATH ASKS. This is the fix for the dead end: an address with no chain
  // gets a one-tap chain question, NOT a refusal. `policy.ts:chainForBrief` still
  // refuses an address brief with no chain_id, so nothing is scoped by asking.
  const first = await tgText(env, `hunt ${ca}`);
  assert.deepEqual(first.errors, []);
  const question = lastBody(first.calls);
  assert.match(question, /THREE QUESTIONS/);
  assert.match(question, /Which chain is that contract on\?/);
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(question), 'asking must not look like a refusal');

  // One button per forkable chain, and each carries the chain id as its value.
  const buttons = first.calls
    .filter((c) => c.url.includes('/sendMessage'))
    .flatMap((c) => c.body?.reply_markup?.inline_keyboard ?? [])
    .flat()
    .filter((b) => /^ans:chain:/.test(String(b.callback_data)));
  assert.ok(buttons.length >= 4, `expected a button per chain, got ${JSON.stringify(buttons)}`);
  const values = buttons.map((b) => String(b.callback_data).replace('ans:chain:', ''));
  assert.ok(values.includes('1'), 'Ethereum must be offered');
  assert.ok(values.includes('8453'), 'Base must be offered');

  // No identity was invented while the chain is unknown: nothing is filed under a
  // guessed chain, and the shared `unscoped` row is all that exists.
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM programs WHERE id LIKE 'chain:%'").get().n,
    0,
    'no chain identity may be invented without a chain',
  );
});

// ── the gate setting: the operator's own switch ────────────────────────────

test('the gate setting defaults to own_scope, and a fresh database needs no row', async () => {
  const { raw, env } = makeEnv();
  assert.equal(await gateMode(env), 'own_scope', 'the default must not be strict');
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key='policy_gate'").get().n,
    0,
    'the default needs no row: a fresh or restored database must simply work',
  );
  // An unreadable stored value falls back to the default rather than throwing or
  // silently becoming the most permissive mode.
  raw.prepare("INSERT INTO kv (key,value,ts) VALUES ('policy_gate','nonsense',1)").run();
  assert.equal(await gateMode(env), 'own_scope');
  for (const bad of ['', 'STRICT', 'off', 'yes']) {
    assert.equal(isGateMode(bad), false, `${JSON.stringify(bad)} must not be a mode`);
  }
  for (const good of ['strict', 'own_scope', 'open']) assert.equal(isGateMode(good), true);
});

test('own_scope lets a CHAIN ADDRESS through after the chain tap, with no policy fetch', async () => {
  const { raw, env } = makeEnv();
  const ca = '0x' + 'd'.repeat(40);

  // Send the CA, tap Base (8453) on the chain question, and let the real webhook
  // drive the rest. This is the operator's reported dead end, end to end.
  const first = await tgText(env, `hunt ${ca}`);
  assert.match(lastBody(first.calls), /Which chain is that contract on\?/);

  const second = await tgBody(env, {
    callback_query: {
      id: 'cb1',
      data: 'ans:chain:8453',
      message: { chat: { id: CHAT }, message_id: 11 },
    },
  });
  const card = lastBody(second.calls);

  // THE ASSERTION THAT MATTERS: an Authorize card, not a refusal.
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(card), `the CA hunt must not dead-end: ${card}`);
  assert.ok(
    /operator-declared scope \(gate=own_scope/.test(card),
    `the card must carry the provenance line: ${card}`,
  );
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 1, 'it must be queueable');
});

test('the same address on two chains is TWO engagements with distinct ids and verdicts', async () => {
  const { raw, env } = makeEnv();
  const ca = '0x' + 'e'.repeat(40);

  // Base: operator-declared, so it is huntable.
  await tgButtonChain(env, ca, 8453);
  // Ethereum: same 20 bytes, different chain.
  await tgButtonChain(env, ca, 1);

  const ids = raw
    .prepare("SELECT id FROM programs WHERE id LIKE 'chain:%' ORDER BY id")
    .all()
    .map((r) => r.id);
  assert.deepEqual(ids, [`chain:1:${ca}`, `chain:8453:${ca}`], 'one row per chain, never shared');

  // And a prohibition on ONE of them must not touch the other.
  raw.prepare("UPDATE programs SET automation='prohibited', policy_url='https://x/1' WHERE id=?")
    .run(`chain:1:${ca}`);
  assert.equal(await authorizationFor(env, `chain:1:${ca}`), null, 'Ethereum is prohibited');
  assert.notEqual(
    await authorizationFor(env, `chain:8453:${ca}`),
    null,
    'Base must keep its own verdict — the chains are not one engagement',
  );
});

test('open mode dispatches a HOST with a provenance anchor and a ledger line', async () => {
  const { raw, env } = makeEnv();

  // Switch to open through the real command.
  const set = await tgText(env, '/gate open');
  assert.deepEqual(set.errors, []);
  assert.match(lastBody(set.calls), /GATE CHANGED/);
  assert.equal(await gateMode(env), 'open');

  // Switching is recorded, so the audit trail survives the waiver.
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='policy.gate_changed'").get().n,
    1,
    'the mode change must be ledgered',
  );

  // A host now dispatches without a fetched policy — and the anchor is NOT null.
  const hunt = await tgText(env, 'look at unrecorded.example.net api');
  const card = lastBody(hunt.calls);
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(card), `open mode must not refuse a host: ${card}`);
  assert.match(card, /operator-declared scope \(gate=open/, 'the anchor must name the mode and time');
});

test('prohibited is terminal in ALL THREE modes', async () => {
  for (const mode of ['strict', 'own_scope', 'open']) {
    const { raw, env } = makeEnv();
    raw
      .prepare(
        `INSERT INTO programs (id,name,platform,policy_url,automation,status,discovered_at)
         VALUES ('locked.example.com','locked.example.com','self','https://locked.example.com/p','prohibited','parsed',1)`,
      )
      .run();
    raw.prepare("INSERT INTO kv (key,value,ts) VALUES ('policy_gate',?,1)").run(mode);

    assert.equal(
      await authorizationFor(env, 'locked.example.com'),
      null,
      `prohibited must be terminal in ${mode}`,
    );

    const { calls } = await tgText(env, 'look at locked.example.com api');
    assert.match(lastBody(calls), /NO AUTHORIZATION ON FILE/, `${mode} must still refuse`);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
  }
});

test('own_scope does NOT relax the host gate', async () => {
  // The one place a third party is affected is the one place the anchor stays
  // required, and `own_scope` is the default. This is the fence that stops the
  // CA fix from becoming a general "any host is fine" bypass.
  const { raw, env } = makeEnv();
  assert.equal(await gateMode(env), 'own_scope');
  const { calls } = await tgText(env, 'look at unrecorded.example.net api');
  assert.match(lastBody(calls), /NO AUTHORIZATION ON FILE/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});

test('/gate rejects an unknown mode and names the valid ones', async () => {
  const { env } = makeEnv();
  const { calls, errors } = await tgText(env, '/gate sideways');
  assert.deepEqual(errors, []);
  const card = lastBody(calls);
  assert.match(card, /UNKNOWN MODE/);
  for (const m of ['strict', 'own_scope', 'open']) assert.ok(card.includes(m), `${m} must be listed`);
  assert.equal(await gateMode(env), 'own_scope', 'a typo must not change the setting');
});


test('the refusal names ONLY commands the router dispatches, and each one really runs', async () => {
  // Every command the refusal offers must be handled. If a future edit names a
  // command that does not exist, this fails — which is exactly the bug the old
  // copy ("paste the exact policy sentence") represented.
  const offered = ANCHOR_COMMANDS.map((c) => c.cmd);
  assert.deepEqual(offered, ['/policy', '/seed', '/own']);

  for (const cmd of offered) {
    const { env } = makeEnv();
    // Send the bare command: a dispatched command answers with its own usage card.
    // A command that does NOT exist falls through to the compiler, which answers
    // with "THREE QUESTIONS" — that is the discriminator this asserts on.
    const { calls, errors } = await tgText(env, cmd);
    assert.deepEqual(errors, [], `${cmd} must not throw`);
    const text = lastBody(calls);
    assert.ok(
      !/THREE QUESTIONS/.test(text),
      `${cmd} must be dispatched, not compiled as free text (got: ${text.slice(0, 200)})`,
    );
  }
});

test('both surfaces render the SAME refusal, and it no longer promises a nonexistent ingress', () => {
  const html = authorizationRefusal({ program: 'unrecorded.example.net' }, 'html');
  const text = authorizationRefusal({ program: 'unrecorded.example.net' }, 'text');

  // Same information once the markup is stripped — the only difference is tags.
  const stripped = html
    .replace(/<\/?b>/g, '')
    .replace(/<\/?code>/g, '')
    .split('\n')
    .filter((l) => !/^─+$/.test(l.trim()))
    .join('\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  // The text arm has no rule line at all; drop the one the html arm adds.
  assert.equal(stripped.replace(/\n$/, ''), text.replace(/\n$/, ''), 'the two must carry identical words');

  assert.match(text, /NO AUTHORIZATION ON FILE/);
  assert.match(text, /Record an anchor with one of these:/);
  for (const c of ANCHOR_COMMANDS) assert.ok(text.includes(c.cmd), `${c.cmd} must be offered`);

  // The two lies are gone: no promise of a paste-policy ingress, no "unscoped".
  assert.ok(!/paste the exact policy/i.test(text), 'the nonexistent ingress must not be offered');
  assert.ok(!/unscoped/.test(text), 'the identity tell must not reach the operator');
});

test('the address refusal names the ONE next action and never says unscoped', () => {
  const t = authorizationRefusal({ program: 'unscoped', kind: 'address', address: '0xabc' }, 'text');
  assert.match(t, /still needs its chain/i);
  assert.match(t, /same 20 bytes exist on every EVM chain/i);
  // It must name the field, and give the inline form the operator can copy.
  assert.match(t, /chain:8453/);
  // And it must NOT claim the address is unauthorised for lack of a policy: the
  // problem here is the missing chain, which is a one-tap fix.
  assert.ok(!/policy is not recorded/i.test(t), 'an address is a chain problem, not a policy problem');
  assert.ok(!/unscoped/.test(t), 'the internal placeholder id must never be shown');
});
