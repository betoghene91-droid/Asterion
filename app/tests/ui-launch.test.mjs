/**
 * Telegram's LAUNCH PARAMETERS: the session AND the route.
 *
 * This is the defect the operator hit on a real phone after the console
 * shipped. Telegram opens a Mini App by appending its launch parameters to the
 * FRAGMENT:
 *
 *   https://host/ui#tgWebAppData=<urlencoded initData>&tgWebAppVersion=7.10
 *                &tgWebAppPlatform=android&tgWebAppThemeParams=<urlencoded json>
 *
 * The shipped shell loads no SDK on purpose (the CSP allows only same-origin
 * script), so `Telegram.WebApp.initData` does NOT exist in the real client. The
 * bootstrap read the session only from the SDK and treated the whole fragment as
 * a route, so the phone showed BOTH failures at once:
 *
 *   "Unknown view: tgWebAppData=query_id%3D..."
 *   "HTTP 401: No Telegram session was presented. ..."
 *
 * There are two independent claims, so there are two halves here.
 *
 * 1. PARSING. The pure launch-parameter functions are EXTRACTED FROM THE
 *    EMBEDDED BODY of app/ui/ui.js and executed, so what runs below is the byte
 *    range the Worker serves. They are driven with the encoded fragment shape
 *    seen on the device, the empty one, the malformed one, one that carries a
 *    real route as well, and the query-string form some clients use.
 *
 * 2. THE WHOLE CHAIN. The string those functions return is handed to the REAL
 *    Worker (build/index.js) against real SQLite, exactly as the browser puts it
 *    in `x-telegram-init-data`. The signature is minted with node:crypto - a
 *    second implementation of Telegram's derivation from the WebCrypto one under
 *    test - so agreement is evidence, not tautology. A fixture minted by the
 *    module would have agreed with a broken module.
 *
 * The negative controls matter as much as the positives: the same request with
 * the launch parameters stripped, tampered with, or malformed must still be
 * refused. A fix that made the console accept anything would pass the first half
 * and fail here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';
import { UI_ASSETS } from '../build/ui/embed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SCHEMA = readFileSync(join(APP, 'schema.sql'), 'utf8');

const TOKEN = '7000000000:HARNESS_BOT_TOKEN';
const OPERATOR = { id: 42, first_name: 'Jen', username: 'jen', language_code: 'en' };

// ── the shipped parser, run for real ────────────────────────────────────────

const asset = (n) => (UI_ASSETS.find((a) => a.name === n) || {}).body || '';
const JS = asset('ui.js');

/**
 * The body of a top-level function, by brace matching, out of the SERVED bytes.
 * These three functions are deliberately brace-free inside their strings and
 * comments so the extraction is exact rather than approximate.
 */
function topLevelFunction(js, name) {
  const marker = '\nfunction ' + name + '(';
  const at = js.indexOf(marker);
  assert.ok(at !== -1, name + ' must still be a top-level function in the shipped ui.js');
  const open = js.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') {
      depth--;
      if (depth === 0) return js.slice(at + 1, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

const PARSER_SRC = [
  topLevelFunction(JS, 'launchParamsFrom'),
  topLevelFunction(JS, 'launchInitData'),
  topLevelFunction(JS, 'routePartsFrom'),
].join('\n');

/** The shipped parser, evaluated against a fake location. */
function shipped(hash = '', search = '') {
  const location = { hash, search };
  const body = PARSER_SRC + '\nreturn { launchParamsFrom, launchInitData, routePartsFrom };';
  return new Function('location', body)(location);
}

// ── the fragments Telegram actually sends ───────────────────────────────────

/** Sign a payload the way Telegram does, with a second implementation. */
function signInitData(pairs, token = TOKEN) {
  const dcs = Object.keys(pairs).sort().map((k) => `${k}=${pairs[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...pairs, hash }).toString();
}

const INIT_DATA = signInitData({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'AAHdF6IQAAAAAN0Xoha',
  user: JSON.stringify(OPERATOR),
});

const THEME_PARAMS = JSON.stringify({ bg_color: '#0a0b0d', text_color: '#e6e9ef' });

/** The exact fragment shape from the device screenshot, parameters and all. */
function launchFragment(initData) {
  return (
    '#tgWebAppData=' +
    encodeURIComponent(initData) +
    '&tgWebAppVersion=7.10&tgWebAppPlatform=android&tgWebAppThemeParams=' +
    encodeURIComponent(THEME_PARAMS)
  );
}

// ── 1. parsing ──────────────────────────────────────────────────────────────

test('the encoded launch fragment yields the initData the SDK would expose', () => {
  const p = shipped(launchFragment(INIT_DATA), '');
  assert.equal(p.launchInitData(), INIT_DATA, 'one percent-decode, exactly');
  assert.notEqual(INIT_DATA, encodeURIComponent(INIT_DATA), 'the fixture must really be encoded');
  // Telegram's own parameters must survive alongside it.
  const all = p.launchParamsFrom(launchFragment(INIT_DATA), '');
  assert.equal(all.get('tgWebAppVersion'), '7.10');
  assert.equal(all.get('tgWebAppPlatform'), 'android');
  assert.equal(all.get('tgWebAppThemeParams'), THEME_PARAMS);
});

test('the launch fragment is NOT a route: it resolves to the default view', () => {
  const p = shipped(launchFragment(INIT_DATA), '');
  assert.deepEqual(p.routePartsFrom(launchFragment(INIT_DATA)), []);
  // The defect, pinned: the old router split the raw fragment on `/`.
  assert.notDeepEqual(launchFragment(INIT_DATA).split('/').filter(Boolean), []);
});

test('a missing fragment is no session and no route', () => {
  for (const hash of ['', '#', '#/', undefined, null]) {
    const p = shipped(hash, '');
    assert.equal(p.launchInitData(), '', String(hash));
    assert.deepEqual(p.routePartsFrom(hash), [], String(hash));
  }
});

test('a malformed fragment is inert: no exception, and no session invented', () => {
  const cases = [
    '#tgWebAppData=%',                 // a bare escape
    '#tgWebAppData=%E0%A4%A',          // a truncated multi-byte escape
    '#tgWebAppData',                   // the name with no value at all
    '#tgWebAppData=&tgWebAppVersion=7.10',
    '#=',
    '#&&&',
    '#tgWebAppData=%zz&tgWebAppVersion=7.10',
  ];
  for (const hash of cases) {
    const p = shipped(hash, '');
    assert.equal(typeof p.launchInitData(), 'string', hash);
    assert.ok(!Array.isArray(undefined), hash);
    assert.ok(Array.isArray(p.routePartsFrom(hash)), hash);
  }
  // A name with no `=` is not a parameter, so it is still routed...
  assert.deepEqual(shipped('#tgWebAppData', '').routePartsFrom('#tgWebAppData'), ['tgWebAppData']);
  // ...and an empty value is an empty session, never a fabricated one.
  assert.equal(shipped('#tgWebAppData=&tgWebAppVersion=7.10', '').launchInitData(), '');
  assert.equal(shipped('#tgWebAppData=%zz&tgWebAppVersion=7.10', '').launchInitData(), '%zz');
});

test('a fragment carrying BOTH a route and the launch parameters keeps the route', () => {
  const mixed = '#/queue/ap-seeded&tgWebAppData=' + encodeURIComponent(INIT_DATA) + '&tgWebAppVersion=7.10';
  const p = shipped(mixed, '');
  assert.deepEqual(p.routePartsFrom(mixed), ['queue', 'ap-seeded']);
  assert.equal(p.launchInitData(), INIT_DATA);
});

test('every real route still parses, and an unknown one still reaches the alert', () => {
  const cases = [
    ['', []],
    ['#/', []],
    ['#/hunt', ['hunt']],
    ['#hunt', ['hunt']],
    ['#/queue', ['queue']],
    ['#/queue/ap-seeded', ['queue', 'ap-seeded']],
    ['#/ask', ['ask']],
    ['#/library', ['library']],
    ['#/library/web.xss.reflected', ['library', 'web.xss.reflected']],
    ['#/ops/status', ['ops', 'status']],
    // Genuinely unknown: it must survive parsing so buildView can render
    // "Unknown view: nope" rather than being swallowed.
    ['#/nope', ['nope']],
    // An id outside Telegram's namespace is never mistaken for a parameter.
    ['#/queue/a=b', ['queue', 'a=b']],
  ];
  for (const [hash, expected] of cases) {
    assert.deepEqual(shipped(hash, '').routePartsFrom(hash), expected, hash);
  }
});

test('the query string is read when the fragment carries nothing', () => {
  const search = '?tgWebAppData=' + encodeURIComponent(INIT_DATA) + '&tgWebAppPlatform=android';
  const p = shipped('', search);
  assert.equal(p.launchInitData(), INIT_DATA);
  assert.equal(p.launchParamsFrom('', search).get('tgWebAppPlatform'), 'android');
});

test('the fragment wins over the query string when both are present', () => {
  const other = signInitData({ auth_date: '1700000000', user: JSON.stringify({ id: 7 }) });
  assert.notEqual(other, INIT_DATA, 'the two fixtures must differ');
  const p = shipped(launchFragment(INIT_DATA), '?tgWebAppData=' + encodeURIComponent(other));
  assert.equal(p.launchInitData(), INIT_DATA);
});

test('only the tgWebApp namespace is harvested, so a stray query param is ignored', () => {
  const p = shipped('', '?utm_source=telegram&tgWebAppVersion=7.10');
  assert.equal(p.launchInitData(), '');
  assert.equal(p.launchParamsFrom('', '?utm_source=telegram&tgWebAppVersion=7.10').has('utm_source'), false);
});

// ── the pins that keep a later edit from undoing it ─────────────────────────

test('the router delegates to the launch-aware parser, not to a raw split', () => {
  assert.match(JS, /function pathParts\(\)[\s\S]{0,80}routePartsFrom\(location\.hash\)/);
  assert.ok(
    !/\(location\.hash \|\| ''\)/.test(JS),
    'nothing may go back to treating the raw fragment as a route string',
  );
});

test('the session is read from the launch parameters FIRST, the SDK second', () => {
  const body = topLevelFunction(JS, 'readInitData');
  const atLaunch = body.indexOf('launchInitData()');
  const atSdk = body.indexOf('TG.initData');
  assert.ok(atLaunch !== -1, 'readInitData must consult the launch parameters');
  assert.ok(atSdk !== -1, 'readInitData must still honour the SDK when a host provides it');
  assert.ok(atLaunch < atSdk, 'the fragment must be preferred over the SDK');
  // And it must survive a reload, which is why the launched value is remembered.
  assert.match(body, /rememberLaunchInitData\(fromLaunch\)/);
  assert.match(body, /recallLaunchInitData\(\)/);
});

test('no new external script is loaded to get the session', () => {
  const html = asset('index.html');
  assert.ok(!/telegram-web-app\.js/.test(html), 'the SDK must not be fetched from a CDN');
  assert.ok(!/telegram-web-app\.js/.test(JS), 'the shell must not pull the SDK in either');
});

// ── 2. the whole chain, against the real Worker ─────────────────────────────

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

function call(path, { method = 'GET', headers = {}, env } = {}) {
  return index.fetch(new Request(`https://worker.example${path}`, { method, headers }), env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  });
}

/** Exactly what the page does: fragment -> parser -> request header. */
function presentFrom(hash, env, path = '/api/ui/targets', search = '') {
  const initData = shipped(hash, search).launchInitData();
  return call(path, { headers: { 'x-telegram-init-data': initData }, env });
}

test('the fragment alone authenticates: an authenticated route answers 200', async () => {
  const { env } = makeEnv();
  const res = await presentFrom(launchFragment(INIT_DATA), env);
  assert.equal(res.status, 200, 'the launch fragment must be enough to reach an authenticated route');
  const j = await res.json();
  assert.equal(j.ok, true);

  const session = await presentFrom(launchFragment(INIT_DATA), env, '/api/ui/session');
  assert.equal(session.status, 200);
  const s = await session.json();
  assert.equal(s.signedIn, true);
  assert.equal(s.user.id, 42);
  assert.equal(s.operator, 'jen');
});

test('NEGATIVE CONTROL: the same page with the launch parameters stripped is refused', async () => {
  const { env } = makeEnv();
  // Nothing at all, which is where a browser lands after boot has replaced the
  // launch fragment with the route and the tab is fresh.
  const res = await presentFrom('', env);
  assert.equal(res.status, 401, 'stripping the parameters must NOT leave an open route');
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'missing');
  assert.equal(j.message, 'No Telegram session was presented. Open this from the button inside the bot chat.');
  assert.equal(j.pending, undefined);

  // The shell still renders: session answers without a session, with a reason.
  const session = await presentFrom('', env, '/api/ui/session');
  assert.equal(session.status, 200);
  const s = await session.json();
  assert.equal(s.signedIn, false);
  assert.equal(s.reason, 'missing');
  assert.ok(Array.isArray(s.tabs) && s.tabs.length === 5, 'the navigation model still arrives');
});

test('NEGATIVE CONTROL: a tampered fragment is refused, so authentication still bites', async () => {
  const { env } = makeEnv();
  const tampered = INIT_DATA.replace('%22id%22%3A42', '%22id%22%3A43');
  assert.notEqual(tampered, INIT_DATA, 'the fixture must actually have changed');
  const res = await presentFrom(launchFragment(tampered), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad_hash');
});

test('NEGATIVE CONTROL: a fragment signed for another bot is refused', async () => {
  const { env } = makeEnv();
  const foreign = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(OPERATOR),
  }, '999999:NOTOURS');
  const res = await presentFrom(launchFragment(foreign), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad_hash');
});

test('a malformed fragment reaches the Worker and is refused gracefully, not fatally', async () => {
  const { env } = makeEnv();
  for (const hash of ['#tgWebAppData=%zz&tgWebAppVersion=7.10', '#tgWebAppData=&tgWebAppVersion=7.10', '#tgWebAppData']) {
    const res = await presentFrom(hash, env);
    assert.equal(res.status, 401, hash);
    const j = await res.json();
    assert.equal(j.ok, false, hash);
    assert.equal(typeof j.message, 'string', hash);
  }
});

test('a Worker with no bot token says so, rather than accepting the fragment', async () => {
  const { env } = makeEnv({ TELEGRAM_BOT_TOKEN: undefined });
  const res = await presentFrom(launchFragment(INIT_DATA), env);
  assert.equal(res.status, 503, 'a deployment fault is not a session');
});

test('the query-string form works end to end too', async () => {
  const { env } = makeEnv();
  const res = await presentFrom('', env, '/api/ui/targets', '?tgWebAppData=' + encodeURIComponent(INIT_DATA));
  assert.equal(res.status, 200);
});
