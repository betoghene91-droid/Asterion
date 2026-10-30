/**
 * The Mini App API, driven at the SHIPPED entrypoint (build/index.js) against a
 * real SQLite database loaded from schema.sql - the same harness desk-api and
 * dashboard-cors use, so what is exercised is the router branch index.ts
 * actually adds, not a helper called directly.
 *
 * The thing this file is really about is FAIL CLOSED. Every route under
 * /api/ui/ either proves a Telegram session or is refused, and there is no
 * combination of missing token, missing header, wrong signature or stale payload
 * that ends in data. `sign()` here uses node:crypto, a different implementation
 * from the WebCrypto path in src/ui/initdata.ts, which is pinned separately
 * against Python-generated vectors in ui-initdata.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SCHEMA = readFileSync(join(APP, 'schema.sql'), 'utf8');

const TOKEN = '123456:TESTTOKEN';
const OTHER_TOKEN = '999999:NOTOURS';
const AUTH_DATE = 1_700_000_000;

/** Sign a payload the way Telegram does, with a second implementation. */
function sign(pairs, token = TOKEN) {
  const dcs = Object.keys(pairs)
    .sort()
    .map((k) => `${k}=${pairs[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...pairs, hash }).toString();
}

const OPERATOR = { id: 42, first_name: 'Jen' };

function freshInitData(over = {}, token = TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  return sign({ auth_date: String(authDate), user: JSON.stringify(OPERATOR), ...over }, token);
}

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
  return { raw, env: { DB: api, OPERATOR_NAME: 'jen', TELEGRAM_BOT_TOKEN: TOKEN, ...extra } };
}

function call(path, { method = 'GET', headers = {}, body, env } = {}) {
  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...headers };
  }
  return index.fetch(new Request(`https://worker.example${path}`, init), env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  });
}

const withSession = (initData) => ({ 'x-telegram-init-data': initData });

// ── assets ─────────────────────────────────────────────────────────────────

test('GET /ui serves the shell with a CSP and no CORS header', async () => {
  const { env } = makeEnv();
  const res = await call('/ui', { env });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(res.headers.get('access-control-allow-origin'), null);

  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  // Deliberately absent: Telegram hosts a Mini App in a frame.
  assert.ok(!/frame-ancestors/.test(csp), 'frame-ancestors would break Telegram Desktop');
  assert.equal(res.headers.get('x-frame-options'), null);

  const html = await res.text();
  assert.match(html, /\/ui\/ui\.css/);
  assert.match(html, /\/ui\/ui\.js/);
});

test('the shell is served without any session, because it holds no data', async () => {
  const { env } = makeEnv({ TELEGRAM_BOT_TOKEN: undefined });
  const res = await call('/ui', { env });
  assert.equal(res.status, 200);
});

test('GET /ui/ui.css and /ui/ui.js serve the embedded assets with real types', async () => {
  const { env } = makeEnv();
  const css = await call('/ui/ui.css', { env });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  assert.match(await css.text(), /--accent/);

  const js = await call('/ui/ui.js', { env });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  const body = await js.text();
  assert.match(body, /__ASTERION/);
  // The shell must talk to the routes this Worker actually has.
  assert.match(body, /\/api\/ui\/engage/);
  assert.match(body, /\/api\/ui\/decide/);
});

test('HEAD on the shell is answered, and other methods are not', async () => {
  const { env } = makeEnv();
  assert.equal((await call('/ui', { method: 'HEAD', env })).status, 200);
  const post = await call('/ui', { method: 'POST', env });
  assert.equal(post.status, 405);
  assert.match(post.headers.get('allow') ?? '', /GET/);
});

test('an unknown asset name is a 404 and never reaches the filesystem', async () => {
  const { env } = makeEnv();
  for (const p of ['/ui/nope', '/ui/%2e%2e%2f%2e%2e%2fpkg.json', '/ui/ui.js.map', '/ui/']) {
    const res = await call(p, { env });
    assert.ok([200, 404].includes(res.status), `${p} -> ${res.status}`);
    if (p !== '/ui/') assert.equal(res.status, 404, p);
  }
});

// ── auth: fail closed ──────────────────────────────────────────────────────

test('/api/ui/work with no initData is 401 and carries no data', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/work', { env });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'missing');
  assert.equal(j.pending, undefined);
});

test('/api/ui/work with a signature from another bot is 401', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/work', {
    headers: withSession(freshInitData({}, OTHER_TOKEN)),
    env,
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad_hash');
});

test('/api/ui/work with a stale session is 401', async () => {
  const { env } = makeEnv();
  const old = freshInitData({}, TOKEN, Math.floor(Date.now() / 1000) - 86_400 * 3);
  const res = await call('/api/ui/work', { headers: withSession(old), env });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'stale');
});

test('a missing TELEGRAM_BOT_TOKEN is 503, so a deployment fault is not read as a client fault', async () => {
  const { env } = makeEnv({ TELEGRAM_BOT_TOKEN: undefined });
  const res = await call('/api/ui/work', { headers: withSession(freshInitData()), env });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'no_bot_token');
});

test('initData in the QUERY STRING is ignored: only the header is read', async () => {
  const { env } = makeEnv();
  const res = await call(`/api/ui/work?init_data=${encodeURIComponent(freshInitData())}`, { env });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'missing');
});

test('every mutating route is behind the same gate', async () => {
  const { env } = makeEnv();
  for (const [path, body] of [
    ['/api/ui/engage', { text: 'x' }],
    ['/api/ui/decide', { id: 'a', decision: 'approve' }],
  ]) {
    const res = await call(path, { method: 'POST', body, env });
    assert.equal(res.status, 401, path);
  }
});

test('a denial leaks neither the token nor the expected hash', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/work', { headers: withSession(freshInitData({}, OTHER_TOKEN)), env });
  const text = await res.text();
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(OTHER_TOKEN));
});

// ── session ────────────────────────────────────────────────────────────────

test('GET /api/ui/session answers without a session, and still sends the navigation model', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/session', { env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.signedIn, false);
  assert.equal(j.reason, 'missing');
  assert.ok(j.message.length > 10);
  // The navigation still arrives, because the read-only surfaces under Ops stay
  // reachable when the session is missing - a broken sign-in must degrade the
  // console to read-only, not to nothing.
  assert.deepEqual(
    j.tabs.map((t) => t.id),
    ['hunt', 'queue', 'ask', 'library', 'ops'],
    'five destinations, in thumb order',
  );
  assert.ok(Array.isArray(j.ops) && j.ops.length >= 12);
  assert.equal(j.counts, undefined, 'an unauthenticated session must not report counts');
});

test('GET /api/ui/session with a valid session returns the operator, the model and the badges', async () => {
  const { raw, env } = makeEnv();
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,automation,status,discovered_at) VALUES ('p1','p1','self','allowed','parsed',1)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO assets (id,program_id,kind,value,first_seen,last_seen)
       VALUES ('a1','p1','domain','x.example',1,1)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at)
       VALUES ('ap1','ap1','{}','waiting','pending',1), ('ap2','ap2','{}','waiting','pending',2)`,
    )
    .run();

  const res = await call('/api/ui/session', { headers: withSession(freshInitData()), env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.signedIn, true);
  assert.equal(j.operator, 'jen');
  assert.equal(j.user.id, 42);

  // Three of the five destinations need a session; the other two do not, and
  // saying so per-tab is what lets the shell grey the right things out.
  const byId = Object.fromEntries(j.tabs.map((t) => [t.id, t]));
  assert.equal(byId.hunt.auth, true);
  assert.equal(byId.queue.auth, true);
  assert.equal(byId.ask.auth, true);
  assert.equal(byId.library.auth, true);
  assert.equal(byId.ops.auth, false);
  assert.equal(byId.queue.badge, 'queue', 'the Queue tab carries the pending count');

  // Every Ops entry is a real route, and the ones backed by the EXISTING open
  // /api/* surface are marked as not needing a session.
  for (const o of j.ops) assert.match(o.route, /^\/api\//, o.id);
  const opsById = Object.fromEntries(j.ops.map((o) => [o.id, o]));
  assert.equal(opsById.status.auth, false);
  assert.equal(opsById.status.route, '/api/status');
  assert.equal(opsById.targets.auth, true);
  assert.equal(opsById.history.auth, true);
  for (const want of ['targets', 'history', 'findings', 'discovery', 'watchlist', 'ledger', 'eval', 'desk', 'positions', 'kills', 'calibration', 'status']) {
    assert.ok(opsById[want], `ops is missing ${want}`);
  }

  assert.deepEqual(j.counts, { pending: 2, proven: 0 });
});

// ── work ───────────────────────────────────────────────────────────────────

test('GET /api/ui/work returns the queue and the program counts', async () => {
  const { raw, env } = makeEnv();
  raw
    .prepare(
      `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at)
       VALUES ('ap1','ap1',?,'new engagement: web2 hunt','pending',?)`,
    )
    .run(
      JSON.stringify({
        kind: 'engagement',
        brief: { title: 'web2 hunt on app.example.com', cls: 'web2', targets: ['app.example.com'], playbooks: ['web.xss'] },
      }),
      1_700_000_000,
    );
  raw
    .prepare(
      `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at,decided_at)
       VALUES ('ap0','ap0','{ BROKEN JSON','old row','denied',?,?)`,
    )
    .run(1_699_000_000, 1_699_000_100);
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,automation,status,discovered_at)
       VALUES ('p1','p1','self','allowed','parsed',1), ('p2','p2','self','unknown','new',1)`,
    )
    .run();

  const res = await call('/api/ui/work', { headers: withSession(freshInitData()), env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.pending.length, 1);
  assert.equal(j.pending[0].id, 'ap1');
  assert.equal(j.pending[0].title, 'web2 hunt on app.example.com');
  assert.deepEqual(j.pending[0].targets, ['app.example.com']);
  assert.equal(j.counts.pending, 1);
  assert.equal(j.counts.denied, 1);
  assert.equal(j.programs.total, 2);
  assert.equal(j.programs.huntable, 1);
  assert.equal(j.programs.parsed, 1);

  // A row whose action JSON is unreadable is still SHOWN, with empty fields.
  assert.equal(j.decided.length, 1);
  assert.equal(j.decided[0].id, 'ap0');
  assert.equal(j.decided[0].title, null);
  assert.deepEqual(j.decided[0].targets, []);
});

test('POST /api/ui/work is 405 with the allowed method named', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/work', { method: 'POST', headers: withSession(freshInitData()), env });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

// ── engage ─────────────────────────────────────────────────────────────────

test('POST /api/ui/engage with no text is 400', async () => {
  const { env } = makeEnv();
  for (const body of [{}, { text: '   ' }, { text: 12 }]) {
    const res = await call('/api/ui/engage', {
      method: 'POST',
      body,
      headers: withSession(freshInitData()),
      env,
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, 'empty');
  }
});

test('POST /api/ui/engage rejects a body that is not an object', async () => {
  const { env } = makeEnv();
  for (const raw of ['[]', '"x"', 'not json']) {
    const res = await call('/api/ui/engage', {
      method: 'POST',
      body: raw,
      headers: withSession(freshInitData()),
      env,
    });
    assert.equal(res.status, 400, raw);
  }
});

test('POST /api/ui/engage refuses an oversized prompt with 413', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/engage', {
    method: 'POST',
    body: { text: 'a'.repeat(4001) },
    headers: withSession(freshInitData()),
    env,
  });
  assert.equal(res.status, 413);
});

test('a target with no recorded policy is refused by the existing authorisation gate', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/engage', {
    method: 'POST',
    body: { text: 'have a look at app.example.com' },
    headers: withSession(freshInitData()),
    env,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.kind, 'unauthorized');
  assert.equal(j.programId, 'app.example.com');
  assert.match(j.message, /NO AUTHORIZATION ON FILE/);
  assert.equal(j.approvalId, undefined, 'nothing may be queued without an authorisation anchor');
});

test('a target with an allowed policy produces a brief, an approval row and a ledger line', async () => {
  const { raw, env } = makeEnv();
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,policy_url,automation,status,discovered_at)
       VALUES ('app.example.com','app.example.com','self','https://app.example.com/security','allowed','parsed',1)`,
    )
    .run();

  const res = await call('/api/ui/engage', {
    method: 'POST',
    body: { text: 'look at app.example.com api, take your time' },
    headers: withSession(freshInitData()),
    env,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.kind, 'brief', JSON.stringify(j));
  assert.equal(j.programId, 'app.example.com');
  assert.ok(j.approvalId);
  assert.deepEqual(j.brief.targets, ['app.example.com']);
  assert.ok(j.brief.playbooks.length > 0);
  assert.match(j.rendered, /ENGAGEMENT/);
  assert.equal(typeof j.enrichment.enriched, 'boolean');

  const row = raw.prepare('SELECT action, status, requested_at FROM approvals WHERE id=?').get(j.approvalId);
  assert.equal(row.status, 'pending');
  const action = JSON.parse(row.action);
  assert.equal(action.kind, 'engagement');
  assert.deepEqual(action.brief, j.brief);

  const ledger = raw.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='intake.compiled'").get();
  assert.equal(ledger.n, 1, 'the compile outcome must be audited');

  // The program row the hunt hangs off was created by the mirror, not duplicated.
  const progs = raw.prepare("SELECT COUNT(*) AS n FROM programs WHERE id='app.example.com'").get();
  assert.equal(progs.n, 1);
});

test('an answered follow-up question is honoured, and answers beat the model', async () => {
  const { raw, env } = makeEnv();
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,policy_url,automation,status,discovered_at)
       VALUES ('app.example.com','app.example.com','self','https://app.example.com/security','allowed','parsed',1)`,
    )
    .run();

  const res = await call('/api/ui/engage', {
    method: 'POST',
    body: { text: 'look at app.example.com', answers: { class: 'web2', junk: 'ignored' } },
    headers: withSession(freshInitData()),
    env,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.kind, 'brief', JSON.stringify(j));
  assert.equal(j.brief.cls, 'web2');
  // Answers make the deterministic compile authoritative, exactly as intake-enrich documents.
  assert.equal(j.enrichment.enriched, false);
  assert.match(String(j.enrichment.skipped), /operator answers present/);
});

// ── decide ─────────────────────────────────────────────────────────────────

function seedApproval(raw, id = 'ap1', brief = { title: 't', cls: 'web2', targets: ['app.example.com'], playbooks: ['web.xss'] }) {
  raw
    .prepare(
      `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at)
       VALUES (?,?,?,'seeded','pending',?)`,
    )
    .run(id, id, JSON.stringify({ kind: 'engagement', brief }), 1_700_000_000);
}

test('POST /api/ui/decide denies through the real approval path and records an operator', async () => {
  const { raw, env } = makeEnv();
  seedApproval(raw);
  const res = await call('/api/ui/decide', {
    method: 'POST',
    body: { id: 'ap1', decision: 'deny' },
    headers: withSession(freshInitData()),
    env,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.outcome.dispatched, false);
  assert.equal(j.outcome.reason, 'denied');
  assert.ok(j.messages.length >= 1, 'the chat text must be handed back to the UI');

  const row = raw.prepare('SELECT status, decided_at IS NOT NULL AS has_date, operator FROM approvals WHERE id=?').get('ap1');
  assert.equal(row.status, 'denied');
  assert.equal(row.operator, 'jen');
  assert.equal(row.has_date, 1);
});

test('deciding twice is idempotent, exactly like a second button tap', async () => {
  const { raw, env } = makeEnv();
  seedApproval(raw);
  const first = await call('/api/ui/decide', {
    method: 'POST',
    body: { id: 'ap1', decision: 'approve' },
    headers: withSession(freshInitData()),
    env,
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).decision, 'approve');

  const second = await call('/api/ui/decide', {
    method: 'POST',
    body: { id: 'ap1', decision: 'approve' },
    headers: withSession(freshInitData()),
    env,
  });
  const j = await second.json();
  assert.equal(j.outcome.dispatched, false);
  assert.equal(j.outcome.reason, 'already_decided');
  assert.match(j.messages.join('\n'), /already/);

  const status = raw.prepare('SELECT status FROM approvals WHERE id=?').get('ap1').status;
  assert.equal(status, 'approved');
  // Exactly one hunt row could exist at most, and only from the first decision.
  const hunts = raw.prepare('SELECT COUNT(*) AS n FROM hunts').get();
  assert.ok(hunts.n <= 1, 'a second decision must not start a second hunt');
});

test('an unknown approval id reports unknown_approval rather than pretending success', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/decide', {
    method: 'POST',
    body: { id: 'nope', decision: 'approve' },
    headers: withSession(freshInitData()),
    env,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.outcome.reason, 'unknown_approval');
  assert.match(j.messages[0], /unknown approval/);
});

test('POST /api/ui/decide validates its inputs', async () => {
  const { env } = makeEnv();
  const h = { ...withSession(freshInitData()) };
  const missing = await call('/api/ui/decide', { method: 'POST', body: { decision: 'approve' }, headers: h, env });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'missing_id');

  const bad = await call('/api/ui/decide', { method: 'POST', body: { id: 'x', decision: 'maybe' }, headers: h, env });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_decision');
});

test('the decision messages are forwarded to the chat only when one is configured', async () => {
  const { raw, env } = makeEnv();
  seedApproval(raw);
  const res = await call('/api/ui/decide', {
    method: 'POST',
    body: { id: 'ap1', decision: 'deny' },
    headers: withSession(freshInitData()),
    env,
  });
  const j = await res.json();
  assert.equal(j.announced, false, 'no TELEGRAM_CHAT_ID is configured here');
  assert.ok(j.messages.length >= 1, 'and the text is still returned to the browser');
});

// ── routing ────────────────────────────────────────────────────────────────

test('an unknown /api/ui path is a 404 in the UI error shape, not a dashboard 404', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/nope', { headers: withSession(freshInitData()), env });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'unknown_endpoint');
});

// ── the whole surface, enumerated ─────────────────────────────────────────

/** Every GET route this module serves. Kept here so a new one cannot ship ungated. */
const UI_GET_ROUTES = ['/api/ui/session', '/api/ui/catalog', '/api/ui/targets', '/api/ui/work', '/api/ui/history'];

for (const path of UI_GET_ROUTES) {
  test(`${path} refuses an unauthenticated caller`, async () => {
    const { env } = makeEnv();
    const res = await call(path, { env });
    // Session is the deliberate exception: it answers so the shell can explain
    // why it is not signed in. It carries no data of its own.
    if (path === '/api/ui/session') {
      assert.equal(res.status, 200);
      assert.equal((await res.json()).signedIn, false);
      return;
    }
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).ok, false);
  });
}

for (const path of UI_GET_ROUTES) {
  test(`${path} rejects the wrong method with an Allow header`, async () => {
    const { env } = makeEnv();
    const res = await call(path, { method: 'POST', body: {}, headers: withSession(freshInitData()), env });
    assert.equal(res.status, 405, path);
    assert.equal(res.headers.get('allow'), 'GET', path);
  });
}

// ── catalog ──────────────────────────────────────────────────────────────

test('GET /api/ui/catalog enumerates every playbook and every pack, and joins the two', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/catalog', { headers: withSession(freshInitData()), env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);

  assert.ok(Array.isArray(j.entries) && j.entries.length > 0);
  assert.ok(Array.isArray(j.domains) && j.domains.length > 0);
  assert.equal(j.totals.entries, j.entries.length);
  assert.equal(typeof j.load.ok, 'boolean');
  assert.ok(['disk', 'embedded'].includes(j.load.source));

  // No id may appear twice, however it got in.
  const ids = j.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'catalog ids must be unique');

  // Every entry has a domain that is also listed, and a family.
  for (const e of j.entries) {
    assert.ok(j.domains.some((d) => d.id === e.domain), `${e.id} has unlisted domain ${e.domain}`);
    assert.ok(typeof e.family === 'string' && e.family.length > 0, e.id);
    // The union rule: an entry always has at least one facet.
    assert.ok(e.hasPlaybook || e.hasPack, `${e.id} has neither facet`);
  }

  // Ordering is stable: domains in DOMAIN_ORDER, then family, then id.
  const order = { sol: 0, mob: 1, web: 2, infra: 3, other: 4 };
  for (let i = 1; i < j.entries.length; i++) {
    const a = j.entries[i - 1];
    const b = j.entries[i];
    const cmp = order[a.domain] - order[b.domain] || a.family.localeCompare(b.family) || a.id.localeCompare(b.id);
    assert.ok(cmp <= 0, `${a.id} should sort before ${b.id}`);
  }

  // requires is capped, so one entry cannot bloat the payload.
  for (const e of j.entries) assert.ok(e.requires.length <= 8, e.id);
});

test('the catalog joins a playbook to its own pack rather than listing it twice', async () => {
  const { env } = makeEnv();
  const j = await (await call('/api/ui/catalog', { headers: withSession(freshInitData()), env })).json();
  // web.idor is both a playbook and a skill pack in this repo; the catalog must
  // present it once, with both facets, or the Library looks like two lists.
  const idor = j.entries.find((e) => e.id === 'web.idor');
  assert.ok(idor, 'web.idor must be in the catalog');
  assert.equal(idor.hasPlaybook, true);
  assert.equal(idor.hasPack, true);
  assert.equal(idor.domain, 'web');
  assert.ok(idor.probes > 0);
  assert.ok(idor.questions > 0);
  assert.equal(typeof idor.proof, 'string');
});

test('the catalog derives its domains instead of hardcoding them', async () => {
  const { env } = makeEnv();
  const j = await (await call('/api/ui/catalog', { headers: withSession(freshInitData()), env })).json();
  // At this commit the two domains present are sol and web. The assertion is not
  // "exactly these two" - a later change adding mob.* or infra.* packs must show
  // up here with no edit to catalog.ts. What is pinned is the DERIVATION: every
  // domain label is one of the four the operator thinks in, plus a catch-all.
  const allowed = new Set(['sol', 'mob', 'web', 'infra', 'other']);
  for (const d of j.domains) {
    assert.ok(allowed.has(d.id), `unexpected domain ${d.id}`);
    assert.equal(d.entries, j.entries.filter((e) => e.domain === d.id).length);
    assert.equal(d.playbooks + d.packs >= d.entries, true);
    assert.ok(d.families.length > 0);
  }
  // Pack-only and playbook-only entries are both representable.
  assert.ok(j.entries.some((e) => e.hasPlaybook));
});

// ── targets ──────────────────────────────────────────────────────────────

test('GET /api/ui/targets reports the inventory and the counts a hunt depends on', async () => {
  const { raw, env } = makeEnv();
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,policy_url,automation,reward,status,priority,discovered_at)
       VALUES ('allowed.example','allowed.example','self','https://allowed.example/policy','allowed','monetary','parsed',0.9,10),
              ('unknown.example','unknown.example','self',NULL,'unknown','unknown','new',0.5,11),
              ('banned.example','banned.example','self',NULL,'prohibited','none','parsed',0.1,12)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO assets (id,program_id,kind,value,first_seen,last_seen)
       VALUES ('a1','allowed.example','domain','allowed.example',1,1),
              ('a2','allowed.example','url','https://allowed.example/x',1,1)`,
    )
    .run();

  const res = await call('/api/ui/targets', { headers: withSession(freshInitData()), env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.counts.total, 3);
  assert.equal(j.counts.allowed, 1);
  assert.equal(j.counts.prohibited, 1);
  assert.equal(j.counts.unknown, 1);
  assert.equal(j.counts.parsed, 2);
  assert.equal(j.counts.with_policy, 1, 'only one target can anchor a hunt');
  assert.equal(j.assets, 2);
  assert.equal(j.targets.length, 3);
  // Ordered by priority descending, so the huntable target leads.
  assert.equal(j.targets[0].id, 'allowed.example');
  assert.equal(j.targets[0].assets, 2);
  // policy_text is not shipped: it is the whole rulebook, and the browser does
  // not need it.
  assert.equal(j.targets[0].policy_text, undefined);
});

// ── history ──────────────────────────────────────────────────────────────

test('GET /api/ui/history reports decisions, hunts and ledger kinds without duplicating a parser', async () => {
  const { raw, env } = makeEnv();
  // Foreign keys ARE enforced here, so the program a hunt hangs off has to exist.
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,automation,status,discovered_at) VALUES ('p1','p1','self','allowed','parsed',1)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at,decided_at,operator)
       VALUES ('d1','d1','{"kind":"engagement","brief":{"title":"t","targets":["x.example"]}}','r','approved',100,200,'jen')`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO hunts (id,program_id,stage,leads_n,attempts_n,proven_n,created_at,updated_at)
       VALUES ('h1','p1','done',4,2,1,150,160)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO ledger (seq,ts,kind,payload,prev_hash,hash)
       VALUES (1,100,'approval.approved','{}','GENESIS','h1'),
              (2,101,'dispatch.blocked','{}','h1','h2'),
              (3,102,'dispatch.blocked','{}','h2','h3')`,
    )
    .run();

  const res = await call('/api/ui/history', { headers: withSession(freshInitData()), env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.totals.decisions, 1);
  assert.equal(j.totals.approved, 1);
  assert.equal(j.totals.hunts, 1);
  assert.equal(j.totals.blocked, 2, 'a blocked dispatch is counted, never recorded as a hunt');
  assert.equal(j.ledger.count, 3);
  assert.deepEqual(j.ledger.kinds.slice(0, 1), [{ kind: 'dispatch.blocked', n: 2 }]);
  assert.equal(j.hunts[0].id, 'h1');
  assert.equal(j.decisions[0].id, 'd1');
  assert.deepEqual(j.decisions[0].targets, ['x.example']);
});

test('the pre-existing dashboard API is untouched: /api/status still answers unauthenticated', async () => {
  const { env } = makeEnv();
  const res = await call('/api/status', { env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok('worker' in j && 'programs' in j && 'pending' in j);
});
