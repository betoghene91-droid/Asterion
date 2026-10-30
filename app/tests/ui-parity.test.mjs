/**
 * The parity proof: the Mini App must not be a SECOND implementation of the bot.
 *
 * Four claims are tested here, each by driving real code paths against real SQLite
 * and diffing what came out.
 *
 * 1. THE KEYBOARD IS UNCHANGED UNTIL IT CAN BE EXTENDED SAFELY. Before any
 *    request has been seen, `KEYBOARDS.main()` must return byte-for-byte the array
 *    the pre-Mini-App build returned. Telegram rejects a `web_app` button whose
 *    url is empty, which would break the ENTIRE keyboard rather than just the new
 *    row, so the row is omitted until an origin has been observed. After a real
 *    request exactly one row is appended and no existing row changes.
 *
 * 2. THE SUGGESTION IS THE SAME SUGGESTION. `intake.ts` documents three ways in,
 *    the third being "accept a suggestion - the bot proposes the hunt", and that
 *    proposal is produced by `compileWithEnrichment`. This file takes the brief
 *    the Mini App returns over HTTP and asserts it is deep-equal to a DIRECT call
 *    to `compileWithEnrichment` with the documented arguments, and that the card
 *    is the same `renderBrief()` output. If the UI ever grew its own compiler,
 *    that fails.
 *
 * 3. A PRE-EXISTING DEFECT IS PINNED, NOT FIXED. `authorizationFor` in index.ts
 *    builds `... WHERE id=?` and never binds `programId`, so no authorisation
 *    anchor can ever be resolved and the shipped free-text hunt path cannot reach
 *    the compiler at all. This change may not edit that function, so the defect is
 *    pinned here and reported. The test below documents the exact consequence
 *    rather than asserting a message text that depends on the SQLite driver.
 *
 * 4. APPROVAL RUNS THE SAME DISPATCH. `approveAndDispatch` is imported by both
 *    paths; the UI decision is checked against its ordering guarantees.
 *
 * NOTE ON ORDER: the origin is module-level state, and claims 1 run first because
 * they are about the state BEFORE any request. node:test runs top-level tests in a
 * file sequentially.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';
import { KEYBOARDS, setWebAppOrigin, webAppUrl } from '../build/telegram.js';
import { compileWithEnrichment } from '../build/intake-enrich.js';
import { renderBrief } from '../build/intake.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

const TOKEN = '123456:TESTTOKEN';
const CHAT = 999;
const RAW = 'look at app.example.com api, take your time';
const POLICY_URL = 'https://app.example.com/security';

const ORIGIN_A = 'https://asterion.test.workers.dev';
const ORIGIN_B = 'https://another-account.workers.dev';

/**
 * The exact array `KEYBOARDS.main()` returned at the base commit, transcribed
 * from telegram.ts before this change. This is the regression bar: any new work
 * that alters an existing row fails here.
 */
const BASELINE_MAIN = [
  [
    { text: '\u25B6  Start a hunt', callback_data: 'hunt:new' },
    { text: '\u2261  Playbooks', callback_data: 'pb:list' },
  ],
  [
    { text: '\u2691  Watchlist', callback_data: 'wl:list' },
    { text: '\u2691  Approvals', callback_data: 'ap:list' },
  ],
  [
    { text: '\u25A6  Queue', callback_data: 'q:list' },
    { text: '\u2699  Status', callback_data: 'st:show' },
  ],
  [
    { text: '\u2691  Discovery', callback_data: 'disc:list' },
    { text: '\u2691  Briefing', callback_data: 'br:daily' },
  ],
  [{ text: '\u25A6  Corpus', callback_data: 'corp:list' }],
];

test('before any request, the main keyboard is byte-identical to the base commit', () => {
  assert.deepEqual(KEYBOARDS.main(), BASELINE_MAIN);
  assert.equal(KEYBOARDS.main().length, 5, 'no extra row may appear before an origin is known');
  assert.equal(webAppUrl(), null, 'no origin can be known before the first request');
});

// ── harness ────────────────────────────────────────────────────────────────

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
  return { raw, env: { DB: api, OPERATOR_NAME: 'jen', ...extra } };
}

const chatEnv = () => ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: String(CHAT) });

/** An allowed program with a recorded policy, so the gate lets a hunt through. */
function seedProgram(raw) {
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,policy_url,policy_text,automation,status,discovered_at)
       VALUES ('app.example.com','app.example.com','self',?,'Automated testing is permitted.','allowed','parsed',1)`,
    )
    .run(POLICY_URL);
}

function sign(pairs, token = TOKEN) {
  const dcs = Object.keys(pairs)
    .sort()
    .map((k) => `${k}=${pairs[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...pairs, hash }).toString();
}

const session = () =>
  sign({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42, first_name: 'Jen' }),
  });

/**
 * Drive the Telegram webhook. `ctx.waitUntil` is captured so the test can await
 * the update instead of racing it, and outbound Telegram API calls are stubbed
 * because a test must not talk to api.telegram.org.
 */
async function postTelegram(env, body, origin = ORIGIN_A) {
  const sent = [];
  const errors = [];
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  console.error = (...a) => errors.push(a.map((x) => (x && x.message) || String(x)).join(' '));

  const pending = [];
  try {
    const res = await index.fetch(
      new Request(`${origin}/tg`, {
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
  return { sent, errors };
}

async function postUi(env, path, body, origin = ORIGIN_A) {
  return index.fetch(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': session() },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
}

// ── claim 1: the keyboard grows by exactly one row ─────────────────────────

test('after a request, one web_app row is appended and no existing row changes', async () => {
  const { env } = makeEnv(chatEnv());
  await postTelegram(env, { message: { chat: { id: CHAT }, text: '/status' } }, ORIGIN_A);

  const kb = KEYBOARDS.main();
  assert.equal(kb.length, BASELINE_MAIN.length + 1, 'exactly one row may be added');
  assert.deepEqual(kb.slice(0, BASELINE_MAIN.length), BASELINE_MAIN, 'no existing row may change');

  const last = kb[kb.length - 1];
  assert.equal(last.length, 1, 'one button');
  assert.equal(last[0].callback_data, undefined, 'callback_data would make the button inert');
  assert.deepEqual(last[0].web_app, { url: `${ORIGIN_A}/ui` });

  // What Telegram receives must serialise without an undefined key, or the button
  // object would differ from what the API expects.
  const wire = JSON.parse(JSON.stringify(last[0]));
  assert.deepEqual(Object.keys(wire).sort(), ['text', 'web_app']);
});

test('the origin follows the request, so the row is correct on every deployment', async () => {
  const { env } = makeEnv(chatEnv());
  await postUi(env, '/api/ui/session', undefined, ORIGIN_B);
  assert.equal(webAppUrl(), `${ORIGIN_B}/ui`);
  const kb = KEYBOARDS.main();
  assert.deepEqual(kb[kb.length - 1][0].web_app, { url: `${ORIGIN_B}/ui` });
  assert.deepEqual(kb.slice(0, BASELINE_MAIN.length), BASELINE_MAIN);
});

test('the webhook itself teaches the origin, before the operator can tap anything', async () => {
  const { env } = makeEnv(chatEnv());
  await postTelegram(env, { message: { chat: { id: CHAT }, text: '/start' } }, ORIGIN_A);
  assert.equal(webAppUrl(), `${ORIGIN_A}/ui`);
});

test('the origin setter refuses anything that is not a bare https origin', () => {
  setWebAppOrigin(ORIGIN_A);
  assert.equal(webAppUrl(), `${ORIGIN_A}/ui`);

  for (const bad of [
    'http://asterion.test.workers.dev', // not https
    'https://asterion.test.workers.dev/ui', // a path, not an origin
    'https://asterion.test.workers.dev?x=1', // a query
    '',
    'not-a-url',
    'javascript:alert(1)',
  ]) {
    setWebAppOrigin(bad);
    assert.equal(webAppUrl(), `${ORIGIN_A}/ui`, `${bad} must not be accepted`);
  }

  // A trailing slash is normalised away rather than rejected.
  setWebAppOrigin(`${ORIGIN_A}/`);
  assert.equal(webAppUrl(), `${ORIGIN_A}/ui`);
});

// ── claim 2: the same compiler, reached by the UI ──────────────────────────

test('the Mini App returns exactly what compileWithEnrichment produces for the same input', async () => {
  const { raw, env } = makeEnv(chatEnv());
  seedProgram(raw);

  const ui = await (await postUi(env, '/api/ui/engage', { text: RAW })).json();
  assert.equal(ui.kind, 'brief', JSON.stringify(ui));
  assert.equal(ui.programId, 'app.example.com');

  // The same call `startHunt` makes, with the same context object it builds.
  const direct = await compileWithEnrichment(
    env,
    RAW,
    {
      program_id: 'app.example.com',
      authorization_ref: `${POLICY_URL} permits automated testing`,
      scope_hints: [],
    },
    {},
  );
  assert.ok('brief' in direct.result, 'the engine must still produce a brief here');
  assert.equal(
    JSON.stringify(ui.brief),
    JSON.stringify(direct.result.brief),
    'the UI must ship the engine\'s brief unchanged, not its own',
  );
  assert.equal(ui.rendered, renderBrief(direct.result.brief));
  assert.equal(ui.enrichment.enriched, direct.enriched);

  // The row it queued carries that same brief.
  const row = raw.prepare('SELECT action, status FROM approvals WHERE id=?').get(ui.approvalId);
  assert.equal(row.status, 'pending');
  assert.deepEqual(JSON.parse(row.action).brief, ui.brief);
});

test('answers make the deterministic compile authoritative, as intake-enrich documents', async () => {
  const { raw, env } = makeEnv(chatEnv());
  seedProgram(raw);
  const ui = await (
    await postUi(env, '/api/ui/engage', { text: RAW, answers: { class: 'infra' } })
  ).json();
  assert.equal(ui.kind, 'brief', JSON.stringify(ui));
  assert.equal(ui.brief.cls, 'infra', 'the operator answer must win');
  assert.equal(ui.enrichment.enriched, false);
  assert.match(String(ui.enrichment.skipped), /operator answers present/);
});

test('the UI refuses a target with no policy anchor, in the same words as the chat', async () => {
  const { raw, env } = makeEnv(chatEnv());
  const text = 'have a look at unrecorded.example.net';

  const { sent } = await postTelegram(env, { message: { chat: { id: CHAT }, text } });
  const refusal = sent.find((s) => s.url.includes('/sendMessage'));
  assert.ok(refusal, 'the webhook must have answered a target with no policy row');
  assert.match(refusal.body.text, /NO AUTHORIZATION ON FILE/);

  const ui = await (await postUi(env, '/api/ui/engage', { text })).json();
  assert.equal(ui.kind, 'unauthorized');
  assert.match(ui.message, /NO AUTHORIZATION ON FILE/);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,
    0,
    'nothing may be queued without an authorisation anchor',
  );
});

// ── claim 3: the pre-existing defect, pinned ───────────────────────────────

test('[EXISTING DEFECT, PINNED] the shipped free-text hunt path can never reach the compiler', async () => {
  // The program IS allowed and DOES carry a policy_url, so `authorizationFor`
  // ought to return an anchor. It cannot: index.ts builds `... WHERE id=?` and
  // never binds `programId`, so the anchor is never produced. Nothing in this
  // change is permitted to edit that function - this test exists so the defect is
  // recorded in executable form and its fix is visible when someone applies it.
  const { raw, env } = makeEnv(chatEnv());
  seedProgram(raw);

  const { sent, errors } = await postTelegram(env, { message: { chat: { id: CHAT }, text: RAW } });

  // The consequence that holds whichever way the driver treats an unbound
  // placeholder: no engagement is ever created from the chat path, for a target
  // that is fully authorised.
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,
    0,
    'the webhook cannot queue an engagement for an authorised target',
  );

  const card = sent.find((s) => s.url.includes('/sendMessage'));
  if (card) {
    assert.match(card.body.text, /NO AUTHORIZATION ON FILE/);
    assert.ok(!/ENGAGEMENT/.test(card.body.text), 'a brief must never be produced here');
  } else {
    // node:sqlite raises on the unbound parameter instead of returning no rows, so
    // the update dies before any message is sent. Cloudflare D1 has its own
    // binding error. Either way the operator gets nothing.
    assert.ok(errors.length > 0, 'if nothing was sent, the update must have failed loudly');
  }
});

test('the UI reaches the compiler for the target the webhook cannot', async () => {
  // Same seeds, same text, same authorisation - only the entry point differs.
  // This is the whole point of the UI: a working path to the existing engine.
  const { raw, env } = makeEnv(chatEnv());
  seedProgram(raw);
  const ui = await (await postUi(env, '/api/ui/engage', { text: RAW })).json();
  assert.equal(ui.kind, 'brief', JSON.stringify(ui));
  assert.ok(ui.approvalId);
  assert.match(ui.rendered, /ENGAGEMENT/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 1);
});

// ── claim 4: approval is the same approval ─────────────────────────────────

test('the Mini App decision runs the same approveAndDispatch the ok: button runs', async () => {
  const ui = makeEnv({ TELEGRAM_BOT_TOKEN: TOKEN });
  seedProgram(ui.raw);

  const engaged = await (await postUi(ui.env, '/api/ui/engage', { text: RAW })).json();
  assert.equal(engaged.kind, 'brief');

  const res = await postUi(ui.env, '/api/ui/decide', {
    id: engaged.approvalId,
    decision: 'approve',
  });
  assert.equal(res.status, 200);
  const decided = await res.json();

  const row = ui.raw
    .prepare('SELECT status, decided_at, operator FROM approvals WHERE id=?')
    .get(engaged.approvalId);
  assert.equal(row.status, 'approved');
  assert.equal(row.operator, 'jen');
  assert.ok(row.decided_at > 0);

  // dispatch.ts's own ordering guarantee: the approval is ledgered before the gate.
  const kinds = ui.raw
    .prepare("SELECT kind FROM ledger WHERE kind LIKE 'approval.%' ORDER BY seq")
    .all()
    .map((r) => r.kind);
  assert.deepEqual(kinds, ['approval.approved']);

  assert.equal(decided.outcome.dispatched, false, 'with no GITHUB_* configured the outcome is a refusal');
  const blocked = ui.raw.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='dispatch.blocked'").get().n;
  assert.ok(blocked > 0, 'a refused dispatch must be recorded as blocked, never as a hunt');
  assert.equal(ui.raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0);
  assert.ok(decided.messages.length >= 1, 'the operator-facing text comes back to the UI');

  // Idempotent, exactly like a second tap on a stale keyboard.
  const again = await (
    await postUi(ui.env, '/api/ui/decide', { id: engaged.approvalId, decision: 'approve' })
  ).json();
  assert.equal(again.outcome.reason, 'already_decided');
  assert.equal(ui.raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0);
});
