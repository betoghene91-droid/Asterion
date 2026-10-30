/**
 * The hunt loop, closed - driven at the SHIPPED entrypoint.
 *
 * Every claim here is exercised through `build/index.js`: the `/tg` webhook for
 * the typed prompt and for the `ans:` / `ok:` callback_query, and `/api/ui/decide`
 * over HTTP for the decision. Nothing calls `startHunt`, `routeButton`,
 * `authorizationFor` or `approveAndDispatch` directly, because the three defects
 * this file closes (B1, B2, B3) are all ABOUT the wiring: a test of the internal
 * function would have passed against every one of them.
 *
 * THE ONE STUB: outbound HTTP to api.telegram.org. A test must not talk to
 * Telegram, so `globalThis.fetch` is replaced for the duration of each request and
 * every call is recorded - that is how the assertions read the card and the
 * keyboard the operator would actually see. Nothing under test is stubbed: the
 * real router, the real compiler, the real policy gate, the real
 * `approveAndDispatch`, over a real `node:sqlite` database loaded from
 * `app/schema.sql`.
 *
 * THE THREE DEFECTS
 *
 *   B1  `authorizationFor()` built `... WHERE id=?` and never bound `programId`,
 *       so the anchor could not resolve for ANY program and the free-text path
 *       was 100% dead. Fixed by binding it. Pinned here by a fixture with TWO
 *       programs where only one carries a `policy_url`: the two requests must
 *       reach OPPOSITE outcomes, which is a property the broken query cannot have.
 *       (A "returns non-null" assertion would pass against the broken code as soon
 *       as the fixture had one program, so it is not used anywhere in this file.)
 *
 *   B2  `routeButton()` had no `ans` case, so the follow-up answer buttons did
 *       nothing. Fixed additively. Pinned here by posting the real `callback_query`
 *       Telegram sends when that button is tapped.
 *
 *   B3  The question branch was doubly gated, so the "at most three button
 *       questions" UX was unreachable from Telegram. The rule this branch adopts
 *       is stated verbatim at the B3 test below.
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
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

const TOKEN = '123456:TESTTOKEN';
const CHAT = 999;
const ORIGIN = 'https://asterion.test.workers.dev';

/** An allowed program WITH a policy anchor. */
const ALPHA = 'alpha.example.com';
const ALPHA_POLICY = 'https://alpha.example.com/security';
/** A program with the SAME shape but no policy anchor. */
const BETA = 'beta.example.com';

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

/** Two programs, same provenance, ONE anchor between them. */
function seedTwoPrograms(raw) {
  const ins = raw.prepare(
    `INSERT INTO programs (id,name,platform,policy_url,policy_text,automation,status,discovered_at)
     VALUES (?,?, 'self', ?, ?, 'allowed', 'parsed', 1)`,
  );
  ins.run(ALPHA, ALPHA, ALPHA_POLICY, 'Automated testing is permitted.');
  ins.run(BETA, BETA, null, null);
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
 * Drive one request through the shipped entrypoint.
 *
 * The ONLY stub is the network call to Telegram: every outbound fetch is captured
 * with its parsed JSON body so an assertion can read the text and the inline
 * keyboard. `ctx.waitUntil` is captured and awaited, so the update is finished
 * before the assertions run rather than racing them.
 */
async function drive(env, path, { method = 'POST', body, headers = {} } = {}) {
  const outbound = [];
  const errors = [];
  const realFetch = globalThis.fetch;
  const realError = console.error;
  globalThis.fetch = async (url, init) => {
    outbound.push({
      url: String(url),
      method: (init && init.method) || 'GET',
      body: init && init.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  // Only errors from the code under test count. Node prints process-level
  // warnings to stderr -- notably `ExperimentalWarning: SQLite is an
  // experimental feature` on node 22, which CI runs and node 24 (local) does
  // not emit -- and a warning about the runtime is not the handler failing.
  // Capturing that as an error made these assertions environment-dependent:
  // green locally, red in CI, for a reason unrelated to the code under test.
  // Filter at the source so every assertion below still tests what it claims.
  console.error = (...a) => {
    const line = a.map((x) => (x && x.message) || String(x)).join(' ');
    if (/ExperimentalWarning|DeprecationWarning|TraceWarning/.test(line)) return;
    errors.push(line);
  };

  const pending = [];
  try {
    const init = { method, headers };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json', ...headers };
      init.body = JSON.stringify(body);
    }
    const res = await index.fetch(new Request(`${ORIGIN}${path}`, init), env, {
      waitUntil: (p) => pending.push(p),
      passThroughOnException: () => {},
    });
    await Promise.allSettled(pending);
    return { res, outbound, errors };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
}

/** A `/tg` text message, exactly as Telegram posts it. */
const tgText = (env, text) =>
  drive(env, '/tg', { body: { message: { chat: { id: CHAT }, text } } });

/** A `/tg` inline-button tap, exactly as Telegram posts it. */
const tgButton = (env, data, messageId = 7) =>
  drive(env, '/tg', {
    body: { callback_query: { id: 'cbq', data, message: { chat: { id: CHAT }, message_id: messageId } } },
  });

/** Just the Telegram method calls, in order. */
const calls = (outbound) =>
  outbound.map((o) => ({ method: o.url.split('/').pop(), body: o.body }));

const textOf = (c) => String((c.body && c.body.text) || '');
const buttonsOf = (c) => {
  const kb = c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard;
  return Array.isArray(kb) ? kb.flat() : [];
};

// ── the loop, happy path ───────────────────────────────────────────────────

test('/hunt <sloppy text> resolves the anchor and renders an Authorize card', async () => {
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  const { res, outbound, errors } = await tgText(
    env,
    `/hunt look at ${ALPHA} api, take your time`,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(errors, [], 'the update must not throw');

  const sent = calls(outbound).filter((c) => c.method === 'sendMessage');
  assert.equal(sent.length, 1, 'one card, not a card plus a refusal');
  const card = sent[0];

  assert.match(textOf(card), /ENGAGEMENT/);
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(textOf(card)), 'an authorised target must not be refused');
  // The anchor is ALPHA's own policy sentence, formatted exactly as
  // `authorizationFor` composes it - proof the resolved row was ALPHA's.
  assert.match(textOf(card), new RegExp(`${ALPHA_POLICY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} permits automated testing`));
  assert.match(textOf(card), new RegExp(`<code>${ALPHA}</code>`));

  const buttons = buttonsOf(card);
  const authorize = buttons.find((b) => /^ok:/.test(String(b.callback_data)));
  const cancel = buttons.find((b) => /^no:/.test(String(b.callback_data)));
  assert.ok(authorize, 'the brief must render an Authorize button');
  assert.ok(cancel, 'the brief must render a Cancel button');
  // Same approval id on both, so the pair cannot be split across rows.
  assert.equal(authorize.callback_data.slice(3), cancel.callback_data.slice(3));

  // A `pending` approval row, and NO hunt row yet: nothing has been approved.
  const approvals = raw.prepare('SELECT id,status FROM approvals').all();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, 'pending');
  assert.equal(approvals[0].id, authorize.callback_data.slice(3));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0);
});

// ── B1: the bind is per-program, proved by disagreement ──────────────────────

test('B1: the anchor is looked up BY PROGRAM ID - two programs reach opposite outcomes', async () => {
  // THE POINT OF THIS TEST. The old query was `SELECT ... FROM programs WHERE id=?`
  // with the placeholder never bound. It cannot answer differently for two rows: it
  // either raises (node:sqlite) or matches nothing (a driver that tolerates it). So
  // two identical requests that differ ONLY in which program they name must produce
  // DIFFERENT results once the parameter is bound, and identical refusal once it is
  // not. Asserting "non-null" would not distinguish the two; asserting the two
  // DIVERGE does.
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  const withAnchor = await tgText(env, `have a look at ${ALPHA}, deep`);
  const withoutAnchor = await tgText(env, `have a look at ${BETA}, deep`);

  const alphaCard = textOf(calls(withAnchor.outbound).find((c) => c.method === 'sendMessage') ?? {});
  const betaCard = textOf(calls(withoutAnchor.outbound).find((c) => c.method === 'sendMessage') ?? {});

  // ALPHA: authorised, so a brief. BETA: same class, same automation, no anchor,
  // so refused. The two texts must not be the same outcome.
  assert.match(alphaCard, /ENGAGEMENT/);
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(alphaCard));
  assert.match(betaCard, /NO AUTHORIZATION ON FILE/);
  assert.ok(!/ENGAGEMENT/.test(betaCard));
  assert.notEqual(alphaCard, betaCard, 'a single unbound query cannot produce two different answers');

  // And exactly one engagement was queued: the authorised one.
  const queued = raw.prepare('SELECT action FROM approvals').all();
  assert.equal(queued.length, 1);
  assert.equal(JSON.parse(queued[0].action).brief.program_id, ALPHA);

  // `approvals` is what a dispatch can ever act on, so BETA's brief - which the
  // compiler did produce - must have left nothing behind to dispatch.
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals WHERE action LIKE ?').get(`%${BETA}%`).n, 0);
});

test('B1: a program whose automation is prohibited is still refused, bound or not', async () => {
  // The bind fixes the plumbing; it must not have turned the gate into a pass.
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);
  raw
    .prepare("UPDATE programs SET automation='prohibited' WHERE id=?")
    .run(ALPHA);

  const { outbound } = await tgText(env, `look at ${ALPHA} api`);
  const card = textOf(calls(outbound).find((c) => c.method === 'sendMessage') ?? {});
  assert.match(card, /NO AUTHORIZATION ON FILE/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});

// ── the decision, over HTTP ─────────────────────────────────────────────────

test('decide without a Telegram session is 401 and decides nothing', async () => {
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  const { outbound } = await tgText(env, `look at ${ALPHA} api`);
  const authorize = buttonsOf(calls(outbound).find((c) => c.method === 'sendMessage')).find((b) =>
    /^ok:/.test(String(b.callback_data)),
  );
  const id = authorize.callback_data.slice(3);

  // No `x-telegram-init-data` at all: the shipped gate must refuse, and the
  // approval must stay pending rather than being decided by an anonymous caller.
  const anon = await drive(env, '/api/ui/decide', { body: { id, decision: 'approve' } });
  assert.equal(anon.res.status, 401, 'an unauthenticated decide must fail closed');
  const body = await anon.res.json();
  assert.equal(body.ok, false);
  assert.match(String(body.message), /No Telegram session was presented/);
  assert.equal(anon.outbound.length, 0, 'a refused decide must not reach Telegram');

  const row = raw.prepare('SELECT status,decided_at FROM approvals WHERE id=?').get(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.decided_at, null);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0);
});

test('a denied decide creates no hunt row, and a second decide says already_decided', async () => {
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  const { outbound } = await tgText(env, `look at ${ALPHA} api`);
  const id = buttonsOf(calls(outbound).find((c) => c.method === 'sendMessage'))
    .find((b) => /^no:/.test(String(b.callback_data)))
    .callback_data.slice(3);

  const auth = { 'x-telegram-init-data': session() };

  const first = await drive(env, '/api/ui/decide', { body: { id, decision: 'deny' }, headers: auth });
  assert.equal(first.res.status, 200);
  const denied = await first.res.json();
  assert.equal(denied.ok, true);
  assert.equal(denied.outcome.dispatched, false);
  assert.equal(denied.outcome.reason, 'denied', 'a denial is not a dispatch attempt');
  assert.equal(raw.prepare('SELECT status FROM approvals WHERE id=?').get(id).status, 'denied');
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n,
    0,
    'no hunt row may exist for an engagement that was denied',
  );

  const second = await drive(env, '/api/ui/decide', { body: { id, decision: 'deny' }, headers: auth });
  assert.equal(second.res.status, 200);
  const again = await second.res.json();
  assert.equal(again.outcome.reason, 'already_decided', 'a second tap must be idempotent');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0);
});

test('the Authorize button at the entrypoint runs the same gate and refuses without GitHub config', async () => {
  // The chat's `ok:` branch and the console's `/api/ui/decide` are the same
  // `approveAndDispatch`. With no GITHUB_DISPATCH_TOKEN it may not dispatch, and
  // the ordering guarantee says a refused dispatch leaves no hunt row.
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  const { outbound } = await tgText(env, `look at ${ALPHA} api`);
  const id = buttonsOf(calls(outbound).find((c) => c.method === 'sendMessage'))
    .find((b) => /^ok:/.test(String(b.callback_data)))
    .callback_data.slice(3);

  const { outbound: tapped } = await tgButton(env, `ok:${id}`, 7);
  const sequence = calls(tapped);
  assert.equal(sequence[0].method, 'answerCallbackQuery', 'the spinner is cleared first');

  // This brief's ceiling is `read` and dispatching proof compute is a `simulate`,
  // so the real PolicyEngine refuses it - the intended product behaviour, and the
  // reason no GitHub credential is even reached. Either way the operator is told
  // plainly, and the promise that nothing changed state is kept.
  const refusal = sequence.find((c) => c.method === 'sendMessage');
  assert.ok(refusal, 'the operator must be told the outcome of their tap');
  assert.match(textOf(refusal), /GATE REFUSED/);
  assert.match(textOf(refusal), /mutability simulate exceeds RoE ceiling read/);
  assert.match(textOf(refusal), /Nothing was dispatched and no hunt row was created/);

  assert.equal(raw.prepare('SELECT status FROM approvals WHERE id=?').get(id).status, 'approved');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0, 'a refused dispatch leaves no hunt');
  assert.ok(
    raw.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='dispatch.blocked'").get().n > 0,
    'the refusal is ledgered as blocked rather than silently dropped',
  );
});

// ── B2 + B3: the question loop ──────────────────────────────────────────────

/**
 * B3, the design rule this branch adopts - stated once, verbatim, because it is
 * the whole of the decision:
 *
 *   THE COMPILER MAY RUN WITH authorization_ref = null AND MAY RETURN QUESTIONS;
 *   IT MAY NOT WRITE AN approvals ROW AND MAY NOT DISPATCH WITHOUT AN ANCHOR.
 *   authorizationFor() RETURNING null MUST STILL BLOCK DISPATCH.
 *
 * In code: `huntFrom()` calls `authorizationFor()` first but does NOT return early
 * on null. It compiles, so the operator can be asked which target they meant, and
 * it writes the `approvals` row - the only thing a dispatch can act on - ONLY when
 * `authRef` is non-null. A brief that compiled without an anchor ends in the same
 * `NO AUTHORIZATION ON FILE` card as before, now reached after the compiler rather
 * than instead of it. `PolicyEngine`'s own `authorization_ref` guard is untouched.
 */

test('B3: a target-less brief reaches the compiler and is asked a question', async () => {
  const { raw, env } = makeEnv();
  // A hint to offer: an authorised program the operator might have meant. The hint
  // is a suggestion, not a grant - choosing it still has to resolve its own anchor.
  seedTwoPrograms(raw);

  const { outbound, errors } = await tgText(env, 'help me find something interesting today');
  assert.deepEqual(errors, []);

  const question = calls(outbound).find((c) => c.method === 'sendMessage');
  assert.ok(question, 'the compiler must be allowed to ask');
  assert.match(textOf(question), /THREE QUESTIONS/);
  assert.match(textOf(question), /Which host or address/);
  assert.ok(!/NO AUTHORIZATION ON FILE/.test(textOf(question)), 'the refusal must not pre-empt the question');

  // A question with no tappable option is a dead end; the hint is offered.
  const options = buttonsOf(question).filter((b) => /^ans:/.test(String(b.callback_data)));
  assert.ok(options.length >= 1, 'the question must be answerable by tapping');
  assert.ok(
    options.some((b) => b.callback_data === `ans:target:${ALPHA}`),
    'the offer is drawn from programs this Worker knows have an anchor',
  );

  // Nothing has a consequence yet: no approvals row, no hunt row.
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0, 'a question is not an engagement');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0);
  // The draft is remembered, or the answer button has nothing to resume.
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM intake_sessions').get().n, 1);
});

test('B2: tapping the answer button resumes the hunt and reaches the Authorize card', async () => {
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  await tgText(env, 'help me find something interesting today');
  // The exact callback_query Telegram posts for `questionKeyboard()`'s button.
  const { outbound, errors } = await tgButton(env, `ans:target:${ALPHA}`, 7);
  assert.deepEqual(errors, [], 'an unanswered `ans:` case used to fall through the switch silently');

  const seq = calls(outbound);
  assert.equal(seq[0].method, 'answerCallbackQuery');

  const card = seq.find((c) => c.method === 'editMessageText');
  assert.ok(card, 'the question card must be replaced in place, not left tappable');
  assert.match(textOf(card), /ENGAGEMENT/);
  assert.match(textOf(card), new RegExp(`${ALPHA_POLICY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} permits automated testing`));
  assert.ok(
    buttonsOf(card).some((b) => /^ok:/.test(String(b.callback_data))),
    'the answered hunt must continue to a brief with an Authorize button',
  );

  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM intake_sessions').get().n, 0, 'the draft is finished');
});

test('B3 NEGATIVE: a target-less brief still cannot dispatch after it is answered', async () => {
  // The negative the design rule has to prove. Answering the question supplies a
  // TARGET but not an ANCHOR: `unrecorded.example.net` has no program policy, so
  // the compiler produces a brief and the anchor refusal still fires. Neither an
  // approvals row nor a hunt row may exist afterwards.
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  await tgText(env, 'help me find something interesting today');
  const { outbound } = await tgButton(env, 'ans:target:unrecorded.example.net', 7);

  const card = calls(outbound).find((c) => c.method === 'editMessageText');
  assert.ok(card);
  assert.match(textOf(card), /NO AUTHORIZATION ON FILE/, 'the anchor refusal must remain reachable');
  assert.ok(!/ENGAGEMENT/.test(textOf(card)), 'no engagement card may be produced without an anchor');
  assert.equal(
    buttonsOf(card).filter((b) => /^(ok|no):/.test(String(b.callback_data))).length,
    0,
    'no Authorize button may exist without an anchor',
  );

  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hunts').get().n, 0);

  // And there is nothing left to tap twice: the draft is consumed.
  const again = await tgButton(env, 'ans:target:unrecorded.example.net', 8);
  assert.match(textOf(calls(again.outbound).find((c) => c.method === 'editMessageText')), /EXPIRED/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});

test('B2: an answer with no live draft says so instead of resuming a stale hunt', async () => {
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);

  const { outbound } = await tgButton(env, `ans:target:${ALPHA}`, 9);
  const card = calls(outbound).find((c) => c.method === 'editMessageText');
  assert.match(textOf(card), /EXPIRED/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
});

test('B2: an option value containing colons survives the callback split', async () => {
  // `ans:<key>:<value>` with an https:// option: the value is everything after the
  // SECOND separator. Splitting on every colon would truncate it to `https`.
  const { raw, env } = makeEnv();
  seedTwoPrograms(raw);
  const URL_TARGET = `https://api.${ALPHA}/v2`;
  // The answered target's own host becomes the program id (`ensureSelfProgram`
  // takes the first host in the text), so for this path to reach a brief the
  // answered host needs its own anchor. That is the fail-closed rule working: an
  // asset belonging to another program does not lend its authorisation to this one.
  raw
    .prepare(
      `INSERT INTO programs (id,name,platform,policy_url,policy_text,automation,status,discovered_at)
       VALUES (?,?, 'self', ?, 'ok', 'allowed', 'parsed', 1)`,
    )
    .run(`api.${ALPHA}`, `api.${ALPHA}`, `https://api.${ALPHA}/security`);
  raw
    .prepare(
      `INSERT INTO assets (id,program_id,kind,value,in_scope,first_seen,last_seen)
       VALUES ('asset-1',?, 'url', ?, 1, 1, 1)`,
    )
    .run(ALPHA, URL_TARGET);

  await tgText(env, 'help me find something interesting today');
  const { outbound } = await tgButton(env, `ans:target:${URL_TARGET}`, 7);
  const card = calls(outbound).find((c) => c.method === 'editMessageText');

  // A brief whose target is the WHOLE url - truncated to `https` it would be a
  // different, useless engagement, and the assertion below would fail.
  assert.match(textOf(card), /ENGAGEMENT/);
  assert.ok(textOf(card).includes(URL_TARGET), 'the whole URL must reach the brief');
  const queued = JSON.parse(raw.prepare('SELECT action FROM approvals').get().action);
  assert.deepEqual(queued.brief.targets, [URL_TARGET]);
});

// ── the gate the design rule must not have weakened ─────────────────────────

test('the anchor is required by the engine, not only by this handler', async () => {
  // `authorizationFor` returning null blocks dispatch twice over: this handler
  // writes no approvals row, and `PolicyEngine` refuses a brief whose
  // authorization_ref is empty. This asserts the SECOND guard directly, so a later
  // refactor of `huntFrom` cannot make the first one load-bearing on its own.
  const { authorizeProof } = await import('../build/dispatch.js');
  const brief = {
    program_id: BETA,
    title: 'x',
    cls: 'solidity',
    targets: ['https://github.com/acme/vault'],
    playbooks: ['sol.reentrancy'],
    max_mutability: 'simulate',
    time_box_minutes: 60,
    authorization_ref: '',
    stop_condition: 'stop',
    out_of_scope: [],
    notes: '',
  };
  await assert.rejects(
    () => authorizeProof(brief, 'acme/vault'),
    /authorization_ref/,
    'an empty anchor must throw, not return a permissive verdict',
  );
});
