/**
 * The signed-out state: a real screen, not a 401 body.
 *
 * THE DEFECT. Opening `/ui#/hunt` in a plain browser rendered the auth gate's
 * own JSON body:
 *
 *   asterion
 *   HTTP 401: No Telegram session was presented. Open this from the button
 *   inside the bot chat.
 *
 * behind a live composer and live tab badges. Five separate things were wrong
 * and each has a test here:
 *
 *   1. the console had no state for "not signed in", so the RESPONSE became the
 *      view.            -> "the signed-out screen is a first-class state"
 *   2. the session was resolved ONCE at module load, so a cold load was
 *      permanent.        -> "a negative resolve is never cached"
 *   3. an empty header was always sent, which the server maps to `missing` -
 *      the same dead-end with a misleading cause.
 *                       -> "no payload means no header at all"
 *   4. the launch payload stayed in the address bar.
 *                       -> "the launch payload never survives in the URL"
 *   5. `no_bot_token` is a DEPLOYMENT fault, and offering Retry for it is a
 *      button that cannot work.
 *                       -> "'no_bot_token' offers no Retry"
 *
 * HOW IT IS TESTED. Same style as ui-launch.test.mjs: the functions are
 * EXTRACTED FROM THE EMBEDDED, SERVED bytes by brace matching and executed, so
 * what runs here is what the Worker sends. The render cases run against a 40-line
 * DOM stand-in, because "renders no Retry button" is a claim about a TREE, not
 * about a regexp. The chain cases drive the REAL Worker (build/index.js) against
 * real SQLite with a signature minted by node:crypto, which is a second
 * implementation of Telegram's derivation, so agreement is evidence.
 *
 * The negative controls are the important half: every case that must still be
 * refused is asserted refused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';
import { UI_ASSETS } from '../build/ui/embed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SCHEMA = readFileSync(join(APP, 'schema.sql'), 'utf8');

const asset = (n) => (UI_ASSETS.find((a) => a.name === n) || {}).body || '';
const HTML = asset('index.html');
const CSS = asset('ui.css');
const JS = asset('ui.js');

const TOKEN = '7000000000:HARNESS_BOT_TOKEN';
const OPERATOR = { id: 42, first_name: 'Jen', username: 'jen', language_code: 'en' };

// ── extraction, out of the SERVED bytes ─────────────────────────────────────

/** The body of a top-level function, by brace matching. Handles `async function`. */
function topLevelFunction(js, name) {
  let at = js.indexOf('\nfunction ' + name + '(');
  if (at === -1) at = js.indexOf('\nasync function ' + name + '(');
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

/** A top-level `const NAME = ...;` one-liner-to-multiline binding. */
function topLevelConst(js, name) {
  const at = js.indexOf('\nconst ' + name + ' = ');
  assert.ok(at !== -1, 'const ' + name + ' must still exist in the shipped ui.js');
  const semi = js.indexOf(';\n', at);
  assert.ok(semi !== -1, 'const ' + name + ' must be terminated');
  return js.slice(at + 1, semi + 1);
}

/** A top-level `const NAME = [ ... ];` array literal. */
function topLevelArray(js, name) {
  const at = js.indexOf('\nconst ' + name + ' = [');
  assert.ok(at !== -1, 'const ' + name + ' must still exist in the shipped ui.js');
  const end = js.indexOf('\n];', at);
  assert.ok(end !== -1, 'array ' + name + ' must be terminated');
  return js.slice(at + 1, end + 3);
}

// ── a DOM stand-in, small enough to audit ───────────────────────────────────
//
// Only what `h()` and the signed-out renderer touch. There is no layout, no CSS,
// no event dispatch: this proves the SHAPE of the tree and the strings in it,
// which is exactly what the defect was about.

function makeDom() {
  const mk = (tag) => ({
    tag,
    className: '',
    attrs: {},
    children: [],
    listeners: {},
    textContent: '',
    hidden: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
  });
  return {
    createElement: mk,
    createTextNode: (text) => ({ tag: '#text', className: '', attrs: {}, children: [], textContent: String(text) }),
  };
}

/** Every string a user would SEE, in document order. */
function visibleText(node) {
  if (!node) return [];
  if (node.tag === '#text') return [node.textContent];
  const own = node.textContent ? [node.textContent] : [];
  return own.concat(...node.children.map(visibleText));
}

/** Every element in the tree, depth first. */
function allNodes(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const c of node.children || []) allNodes(c, out);
  return out;
}

/**
 * The renderer, evaluated from the served bytes against the stand-in.
 *
 * `retrySession` is stubbed: this file is about what is RENDERED, and the retry
 * path itself is proved below by driving the resolver and the real Worker.
 */
function renderSignedOut({ reason, message, session } = {}) {
  const dom = makeDom();
  const preamble = [
    'const S = { reasonCode: null, reasonMessage: null, session: null, initDataRetried: false, initDataPresent: false };',
    'let DOM_READY = false;',
    'const retries = { n: 0 };',
    'async function retrySession() { retries.n++; return false; }',
    'function noteError() {}',
    'function toast() {}',
    'function HAPTIC() {}',
    'HAPTIC.ok = () => {}; HAPTIC.select = () => {};',
    'function renderRoute() {}',
    'function applyServerNav() {}',
    'function setLink() {}',
    'function updateBadges() {}',
    'const globalThis = { __ASTERION: S };',
    'const sessionStorage = undefined;',
    'const location = { hash: "", search: "", pathname: "/ui" };',
    'const history = undefined;',
    'const TG = null;',
  ].join('\n');

  const body = [
    topLevelConst(JS, 'SIGNED_OUT_REASONS'),
    topLevelFunction(JS, 'stripServerPrefixes'),
    topLevelFunction(JS, 'signedOutCopy'),
    topLevelFunction(JS, 'botUsername'),
    topLevelFunction(JS, 'reopenHref'),
    topLevelFunction(JS, 'h'),
    topLevelFunction(JS, 'retryButton'),
    topLevelFunction(JS, 'signedOutView'),
  ].join('\n');

  const factory = new Function(
    'document',
    preamble +
      '\n' + body +
      '\nS.reasonCode = __REASON__; S.reasonMessage = __MESSAGE__; S.session = __SESSION__;' +
      '\nreturn { tree: signedOutView(), copy: signedOutCopy(S.reasonCode, S.reasonMessage), S, retries };',
  );
  const setReason = (...args) => factory(...args);
  void setReason;
  // Arguments are passed positionally so no code is rebuilt per case.
  const fn = new Function(
    'document',
    '__REASON__',
    '__MESSAGE__',
    '__SESSION__',
    preamble +
      '\n' + body +
      '\nS.reasonCode = __REASON__; S.reasonMessage = __MESSAGE__; S.session = __SESSION__;' +
      '\nreturn { tree: signedOutView(), copy: signedOutCopy(S.reasonCode, S.reasonMessage), S, retries };',
  );
  return fn(dom, reason === undefined ? null : reason, message === undefined ? null : message, session || null);
}

/** The resolver, evaluated from the served bytes over a mutable fake location. */
function resolver({ hash = '', search = '', sdk = '', stored = '', seam = '', ready = false } = {}) {
  const state = { hash, search, sdk, stored, ready };

  const body = [
    topLevelFunction(JS, 'launchParamsFrom'),
    topLevelFunction(JS, 'launchInitData'),
    topLevelFunction(JS, 'rememberLaunchInitData'),
    topLevelFunction(JS, 'recallLaunchInitData'),
    topLevelFunction(JS, 'hashWithoutLaunchParams'),
    topLevelFunction(JS, 'forgetLaunchFragment'),
    topLevelFunction(JS, 'sdkInitData'),
    topLevelFunction(JS, 'readInitData'),
    topLevelFunction(JS, 'domReady'),
    topLevelFunction(JS, 'resolveInitDataNow'),
    topLevelFunction(JS, 'initDataHeader'),
  ].join('\n');

  // The page's module-level bindings, supplied exactly as the page has them. The
  // SDK is a getter so a case can change `Telegram.WebApp.initData` between two
  // calls - which is the whole point of the negative-cache test.
  const store = new Map();
  if (stored) store.set('asterion.launch.initData', stored);
  const historyCalls = [];

  const factory = new Function(
    '__store__',
    '__loc__',
    '__hist__',
    '__seam__',
    '__ready__',
    '__sdk__',
    `
    const S = { initDataRetried: false, initDataPresent: false };
    let DOM_READY = __ready__;
    const LAUNCH_STORE = 'asterion.launch.initData';
    const sessionStorage = __store__;
    const location = __loc__;
    const history = __hist__;
    const TG = { get initData() { return __sdk__(); } };
    const globalThis = { ASTERION_INIT_DATA: __seam__ };
    ${body}
    return {
      readInitData,
      resolveInitDataNow,
      initDataHeader,
      hashWithoutLaunchParams,
      forgetLaunchFragment,
      launchInitData,
      S,
      setDomReady(v) { DOM_READY = v; },
    };
    `,
  );

  const loc = {
    get hash() { return state.hash; },
    get search() { return state.search; },
    get pathname() { return '/ui'; },
  };
  const api = factory(
    {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, v); },
    },
    loc,
    { replaceState(_a, _b, url) { historyCalls.push(url); } },
    seam || undefined,
    ready,
    () => state.sdk,
  );
  return { ...api, state, store, historyCalls };
}

// ── fixtures ────────────────────────────────────────────────────────────────

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

function launchFragment(initData) {
  return (
    '#tgWebAppData=' +
    encodeURIComponent(initData) +
    '&tgWebAppVersion=7.10&tgWebAppPlatform=android&tgWebAppThemeParams=' +
    encodeURIComponent(JSON.stringify({ bg_color: '#0a0b0d' }))
  );
}

// ── 1. the transport ────────────────────────────────────────────────────────

test('no payload means NO header at all, because an empty header is the same dead-end', () => {
  const r = resolver({ hash: '', search: '' });
  const empty = r.initDataHeader('');
  assert.deepEqual(empty, {}, 'an empty payload must produce no header');
  assert.equal(Object.keys(empty).length, 0);
  // Whitespace is not a payload either.
  assert.deepEqual(r.initDataHeader('   '), {}, 'whitespace is not a session');
  assert.deepEqual(r.initDataHeader(null), {});
  assert.deepEqual(r.initDataHeader(undefined), {});
  // A real payload becomes exactly one header, unchanged.
  const h = r.initDataHeader(INIT_DATA);
  assert.deepEqual(h, { 'x-telegram-init-data': INIT_DATA });
  // And the transport must go through it rather than build the object inline.
  const api = topLevelFunction(JS, 'api');
  assert.match(api, /const session = resolveInitDataNow\(\)/, 'the header is resolved per request');
  assert.match(api, /initDataHeader\(session\)/, 'the header is built by the tested function');
  assert.ok(
    !/headers = \{ 'x-telegram-init-data':/.test(JS),
    'nothing may build the header from a module constant again',
  );
});

test('NEGATIVE CONTROL: an empty header and no header are BOTH refused by the real Worker', async () => {
  const { env } = makeEnv();
  const absent = await call('/api/ui/targets', { env });
  assert.equal(absent.status, 401, 'no header must be refused');
  assert.equal((await absent.json()).error, 'missing');

  const blank = await call('/api/ui/targets', { headers: { 'x-telegram-init-data': '' }, env });
  assert.equal(blank.status, 401, 'an EMPTY header must also be refused');
  assert.equal((await blank.json()).error, 'missing');

  const spaces = await call('/api/ui/targets', { headers: { 'x-telegram-init-data': '   ' }, env });
  assert.equal(spaces.status, 401);
  assert.equal((await spaces.json()).error, 'missing');
});

test('a negative resolve is NEVER cached: a payload that appears later is found', () => {
  // `ready: true` because the second look is only spent once the document has
  // reached DOMContentLoaded - which is what a real cold load looks like by the
  // time the first request is made.
  const r = resolver({ hash: '', search: '', ready: true });
  assert.equal(r.resolveInitDataNow(), '', 'nothing to present yet');
  assert.equal(r.S.initDataPresent, false);
  assert.equal(r.S.initDataRetried, true, 'the second look was spent, and it found nothing');

  // The host finishes initialising and the session shows up. The SECOND call must
  // see it - the old code had frozen the empty string at module load.
  r.state.hash = launchFragment(INIT_DATA);
  const second = r.resolveInitDataNow();
  assert.equal(second, INIT_DATA, 'a session that appears after the first read must be presented');
  assert.equal(r.S.initDataPresent, true);
  assert.equal(r.initDataHeader(second)['x-telegram-init-data'], INIT_DATA);

  // And a third call still sees it, and so does a fourth.
  assert.equal(r.resolveInitDataNow(), INIT_DATA);
  assert.equal(r.resolveInitDataNow(), INIT_DATA);
});

test('the second look is not spent before the document is ready', () => {
  // Not DOM-ready yet: the one re-read must still be available, because that is
  // the moment a host that initialises asynchronously has finished.
  const r = resolver({ hash: '', search: '', ready: false });
  assert.equal(r.resolveInitDataNow(), '');
  assert.equal(r.S.initDataRetried, false, 'an early read must not consume the second look');

  // Now the document is ready and the payload is there.
  r.setDomReady(true);
  r.state.hash = launchFragment(INIT_DATA);
  assert.equal(r.resolveInitDataNow(), INIT_DATA);
});

test('an SDK session is used when there is no fragment, and the fragment wins a disagreement', () => {
  const sdkOnly = resolver({ hash: '', search: '', sdk: INIT_DATA });
  assert.equal(sdkOnly.resolveInitDataNow(), INIT_DATA, 'the SDK is a source when the fragment is empty');

  const other = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 7 }) });
  assert.notEqual(other, INIT_DATA);
  const disagree = resolver({ hash: launchFragment(INIT_DATA), search: '', sdk: other });
  assert.equal(
    disagree.resolveInitDataNow(),
    INIT_DATA,
    'a startapp re-entry brings a FRESH fragment; the stale SDK copy must not win',
  );
});

test('the launch payload never survives in the URL', () => {
  const r = resolver({ hash: launchFragment(INIT_DATA), search: '' });
  assert.equal(r.resolveInitDataNow(), INIT_DATA);
  assert.equal(r.historyCalls.length, 1, 'the address bar is rewritten exactly once');
  const written = r.historyCalls[0];
  assert.ok(!written.includes('tgWebAppData'), 'the signed payload must not be left in the URL: ' + written);
  assert.ok(!written.includes(encodeURIComponent(INIT_DATA)), 'nor in encoded form');
  assert.ok(written.startsWith('/ui'), 'the path is preserved');

  // A fragment carrying BOTH a route and the parameters keeps the route.
  const mixed = resolver({
    hash: '#/queue/ap-1&tgWebAppData=' + encodeURIComponent(INIT_DATA) + '&tgWebAppVersion=7.10',
  });
  assert.equal(mixed.resolveInitDataNow(), INIT_DATA);
  assert.equal(mixed.historyCalls[0], '/ui#/queue/ap-1', 'the route survives, the credential does not');

  // An id that merely CONTAINS '=' is not a launch parameter and is not dropped.
  assert.equal(r.hashWithoutLaunchParams('#/queue/a=b'), '#/queue/a=b');
  // No launch parameters at all: nothing is rewritten.
  const clean = resolver({ hash: '#/hunt', search: '' });
  assert.equal(clean.hashWithoutLaunchParams('#/hunt'), '#/hunt');
});

// ── 2. the copy ─────────────────────────────────────────────────────────────

test('the renderer strips "HTTP 401:"/"HTTP 503:" and the "asterion" prefix', () => {
  const cases = [
    ['HTTP 401: No Telegram session was presented. Open this from the button inside the bot chat.',
      'No Telegram session was presented. Open this from the button inside the bot chat.'],
    ['asterion HTTP 401: No Telegram session was presented. Open this from the button inside the bot chat.',
      'No Telegram session was presented. Open this from the button inside the bot chat.'],
    ['asterion\nHTTP 503: This Worker has no TELEGRAM_BOT_TOKEN, so Mini App sign-in is disabled.',
      'This Worker has no TELEGRAM_BOT_TOKEN, so Mini App sign-in is disabled.'],
    ['asterion: HTTP 401: no initData presented', 'no initData presented'],
    ['HTTP 503: HTTP 401: doubly decorated', 'doubly decorated'],
  ];
  for (const [input, expected] of cases) {
    const r = renderSignedOut({ reason: 'missing', message: input });
    assert.equal(r.copy.detail, expected, input);
    // ...and the screen really shows the stripped form, not the raw one.
    const shown = visibleText(r.tree).join(' | ');
    assert.ok(!shown.includes('HTTP 401:'), 'the transport prefix must not reach the screen: ' + shown);
    assert.ok(!shown.includes('HTTP 503:'), 'the transport prefix must not reach the screen: ' + shown);
    assert.ok(!/^asterion\b/m.test(shown.replace(/^asterion \u00b7 .*$/m, '')), 'no bare page title as copy');
  }
});

test('the machine reason stays available, collapsed, for an operator', () => {
  const r = renderSignedOut({ reason: 'missing', message: 'HTTP 401: No Telegram session was presented.' });
  const details = allNodes(r.tree).find((n) => n.tag === 'details');
  assert.ok(details, 'the reason code must be a collapsed secondary detail');
  assert.equal(details.attrs.open, undefined, 'it must start collapsed');
  const summary = allNodes(details).find((n) => n.tag === 'summary');
  assert.equal(summary.textContent, 'Reason code');
  assert.match(visibleText(details).join(' '), /missing/);
});

test("'stale' produces DIFFERENT copy from 'missing'", () => {
  const missing = renderSignedOut({ reason: 'missing', message: 'No Telegram session was presented.' });
  const stale = renderSignedOut({ reason: 'stale', message: 'This Telegram session has expired.' });
  assert.notEqual(stale.copy.heading, missing.copy.heading);
  assert.notEqual(stale.copy.body, missing.copy.body);
  assert.notEqual(stale.copy.glyph, missing.copy.glyph);
  assert.equal(missing.copy.heading, 'Not signed in');
  assert.equal(stale.copy.heading, 'Session expired');
  // Both are recoverable, so both offer Retry - but they must not read alike.
  assert.equal(missing.copy.retry, true);
  assert.equal(stale.copy.retry, true);
  // The screen actually renders the difference.
  assert.notDeepEqual(visibleText(stale.tree), visibleText(missing.tree));
});

test('every denial reason has its own screen, and none of them is an error', () => {
  const seen = new Set();
  for (const reason of ['missing', 'stale', 'future', 'malformed', 'no_hash', 'bad_hash', 'no_auth_date']) {
    const r = renderSignedOut({ reason, message: 'x' });
    assert.equal(r.copy.tone, 'read', reason + ' must not be presented as an error');
    assert.ok(r.copy.heading.length > 3, reason + ' needs a heading');
    assert.ok(r.copy.body.length > 20, reason + ' needs an explanation');
    seen.add(r.copy.heading);
  }
  // An unknown reason falls back to the generic screen instead of throwing.
  const odd = renderSignedOut({ reason: 'not_a_reason', message: 'x' });
  assert.equal(odd.copy.code, 'missing', 'an unknown reason degrades to the most common state');
  assert.ok(seen.size >= 3, 'the situations are distinguishable, not one message in four costumes');
});

test("'no_bot_token' is a DEPLOYMENT fault: .alert.bad, no Retry, and it names the secret", () => {
  const r = renderSignedOut({
    reason: 'no_bot_token',
    message: 'HTTP 503: This Worker has no TELEGRAM_BOT_TOKEN, so Mini App sign-in is disabled.',
  });
  assert.equal(r.copy.tone, 'fault');
  assert.equal(r.copy.retry, false, 'Retry cannot succeed without the secret, so it must not be offered');

  const alert = allNodes(r.tree).find((n) => /(^| )alert( |$)/.test(n.className) && /(^| )bad( |$)/.test(n.className));
  assert.ok(alert, 'a deployment fault renders as .alert.bad');
  assert.match(alert.textContent, /TELEGRAM_BOT_TOKEN/, 'and it names the secret the operator must set');

  // The rendered tree contains NO retry affordance at all.
  const buttons = allNodes(r.tree).filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), [], 'no button may be rendered for a deployment fault');
  assert.ok(!visibleText(r.tree).join(' ').includes('Retry'), 'and no Retry WORD either');
});

test('the Retry that IS offered re-probes instead of reloading the page', () => {
  const r = renderSignedOut({ reason: 'missing', message: 'No Telegram session was presented.' });
  const retry = allNodes(r.tree).find((n) => n.tag === 'button' && n.textContent === 'Retry');
  assert.ok(retry, 'a recoverable state offers Retry');
  assert.equal(retry.attrs.type, 'button', 'a bare <button> inside no form must not default to submit');
  assert.ok(retry.listeners.click && retry.listeners.click.length === 1, 'it is wired');
  assert.equal(r.retries.n, 0);

  // The retry path must not be a reload.
  const retryFn = topLevelFunction(JS, 'retrySession');
  assert.ok(!/location\.reload/.test(JS), 'the console must never reload to re-authenticate');
  assert.match(retryFn, /await api\('\/api\/ui\/session'\)/, 'retry re-probes the session endpoint');
  assert.match(retryFn, /renderRoute\(\)/, 'and re-renders from the answer');
  assert.match(retryFn, /S\.initDataRetried = false/, 'and re-arms the second look at the launch parameters');
});

test('"Reopen in Telegram" is derived from runtime state, never hardcoded', () => {
  // With no discoverable username, NO dead button is rendered - instruction text
  // is the fallback, because a link to the wrong bot is worse than no link.
  const noBot = renderSignedOut({ reason: 'missing', message: 'x', session: { signedIn: false } });
  assert.equal(
    allNodes(noBot.tree).filter((n) => n.tag === 'a').length,
    0,
    'with no bot username there must be no link at all',
  );
  assert.match(visibleText(noBot.tree).join(' '), /button inside the bot chat/, 'the instruction replaces the button');

  // With a username from the session payload, the link is built from it.
  const withBot = renderSignedOut({
    reason: 'missing',
    message: 'x',
    session: { signedIn: false, bot: 'asterion_research_bot' },
  });
  const link = allNodes(withBot.tree).find((n) => n.tag === 'a');
  assert.ok(link, 'a discoverable bot must produce the primary action');
  assert.equal(link.attrs.href, 'https://t.me/asterion_research_bot?startapp');
  assert.equal(link.textContent, 'Reopen in Telegram');
  assert.match(link.className, /btn/, 'it is styled as the primary control');
  assert.equal(link.attrs.rel, 'noopener noreferrer');

  // It is the PRIMARY action: it comes before Retry.
  const order = allNodes(withBot.tree).map((n) => n.textContent).filter(Boolean);
  assert.ok(order.indexOf('Reopen in Telegram') < order.indexOf('Retry'), 'primary first, secondary second');

  // A username that is not a bot username is refused rather than trusted.
  for (const bad of ['jen', '@jen', 'not a bot', '', 'a'.repeat(40) + 'bot']) {
    const r = renderSignedOut({ reason: 'missing', message: 'x', session: { bot: bad } });
    assert.equal(allNodes(r.tree).filter((n) => n.tag === 'a').length, 0, JSON.stringify(bad));
  }
  // The real t.me URL shape is accepted and reduced to the bare handle.
  const url = renderSignedOut({ reason: 'missing', message: 'x', session: { bot: 'https://t.me/Some_Bot_2bot' } });
  assert.equal(allNodes(url.tree).find((n) => n.tag === 'a').attrs.href, 'https://t.me/Some_Bot_2bot?startapp');

  // And nothing in the shipped frontend hardcodes a bot name.
  assert.ok(
    !/t\.me\/[A-Za-z0-9_]+\?startapp/.test(JS),
    'the t.me link must be built from runtime state, not written into the file',
  );
});

// ── 3. the raw payload never reaches the screen ─────────────────────────────

test('the raw payload reaches no log, no markup and no rendered string', () => {
  // Not one console METHOD CALL in the whole console: initData is a bearer
  // credential and a log line is where it would end up. (The word "console"
  // appears in prose, which is why this matches a call and not the noun.)
  assert.equal(
    (JS.match(/\bconsole\s*\.\s*(?:log|warn|error|info|debug|trace|assert|dir|table)\s*\(/g) || []).length,
    0,
    'the console must not log anything',
  );

  // Every CODE line that mentions the key is resolution code: no template literal,
  // no markup assignment, no logging. Comment lines are exempt - explaining the
  // launch-parameter format is not handling it.
  const lines = JS.split('\n');
  const mentions = lines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('tgWebAppData'))
    .filter(([, l]) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
  assert.ok(mentions.length > 0, 'the resolution code must still exist');
  for (const [n, line] of mentions) {
    assert.ok(!line.includes('`'), `line ${n} puts the key in a template literal: ${line.trim()}`);
    assert.ok(!/console\s*\./.test(line), `line ${n} logs the key: ${line.trim()}`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(line), `line ${n} writes markup: ${line.trim()}`);
    assert.ok(!/textContent\s*=/.test(line), `line ${n} renders the key: ${line.trim()}`);
    assert.ok(!/toast\(/.test(line), `line ${n} toasts the key: ${line.trim()}`);
  }

  // The signed-out renderer never touches the payload at all: its copy comes from
  // the server's REASON and MESSAGE, so there is nothing to leak.
  for (const name of ['signedOutCopy', 'signedOutView', 'stripServerPrefixes']) {
    const body = topLevelFunction(JS, name);
    assert.ok(!/initData/i.test(body), name + ' must not handle the initData payload');
    assert.ok(!/tgWebApp/.test(body), name + ' must not handle the launch parameters');
  }

  // The screen for a signed-out session shows none of it, even when the session
  // object is fully populated with a payload-shaped field.
  const r = renderSignedOut({
    reason: 'missing',
    message: 'No Telegram session was presented.',
    session: { signedIn: false, initData: INIT_DATA, tgWebAppData: INIT_DATA },
  });
  const shown = visibleText(r.tree).join(' ');
  assert.ok(!shown.includes(INIT_DATA), 'the payload must not appear on screen');
  assert.ok(!shown.includes('tgWebAppData'), 'nor its key name');
  assert.ok(!/hash=[0-9a-f]{64}/.test(shown), 'nor the signature');
});

// ── 4. the console has no live-session chrome while signed out ───────────────

test('a signed-out console suppresses the composer, the badges and the thread', () => {
  const render = topLevelFunction(JS, 'renderRoute');
  // The gate decides, before any view is built, whether this route is gated.
  assert.match(render, /const gated = !S\.signedIn && tabNeedsAuth\(tab\)/);
  assert.match(render, /setBack\(rest\.length > 0 && !gated\)/);
  assert.match(render, /const composing = !gated &&/, 'the composer is suppressed when gated');
  assert.match(render, /composerEl\.hidden = !composing/);
  assert.match(render, /hideBadges\(\)/, 'badges are hidden when gated');
  assert.match(render, /const built = gated \? signedOutView\(\) : buildView\(tab, rest\)/,
    'the gated branch renders the signed-out screen INSTEAD OF the view, so a 401 body cannot become one');

  // No skeleton and no greeting is built while signed out: `viewHunt` is never
  // called for a gated route, and the greeting lives inside it.
  const hunt = topLevelFunction(JS, 'viewHunt');
  assert.ok(!/alert/.test(hunt), 'viewHunt must not render the signed-out notice any more');
  assert.match(hunt, /if \(!threadEl\)/, 'the thread is still built lazily, and only signed in');

  // The initial paint is honest too: the markup starts in the signed-out shape,
  // so the first frame cannot show a composer over a dead session.
  assert.match(HTML, /<body[^>]*data-signed-in="0"/);
  assert.match(HTML, /<body[^>]*data-compose="0"/);
  assert.match(CSS, /\.signed-out/);
  assert.match(CSS, /\.signed-out \.heading/);
});

test('the session endpoint reports which destinations need a session, and the client uses it', () => {
  const guard = topLevelFunction(JS, 'tabNeedsAuth');
  assert.match(guard, /S\.tabsList/, 'the client branches on the server nav model');
  assert.match(guard, /auth !== false/, 'only a destination the server marks open is open');
});

// ── 5. the whole chain, against the real Worker ─────────────────────────────

function makeEnv(extra = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const api = {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      const bound = (binds) => ({
        async first() { return stmt.get(...binds) ?? null; },
        async run() { return stmt.run(...binds); },
        async all() { return { results: stmt.all(...binds) }; },
        bind(...b) { return bound(b); },
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

test('the launch fragment still authenticates end to end', async () => {
  const { env } = makeEnv();
  const r = resolver({ hash: launchFragment(INIT_DATA), search: '' });
  const payload = r.resolveInitDataNow();
  assert.equal(payload, INIT_DATA);

  const res = await call('/api/ui/targets', { headers: r.initDataHeader(payload), env });
  assert.equal(res.status, 200, 'the fragment must still be enough to reach an authenticated route');
  assert.equal((await res.json()).ok, true);

  const session = await call('/api/ui/session', { headers: r.initDataHeader(payload), env });
  assert.equal(session.status, 200);
  const s = await session.json();
  assert.equal(s.signedIn, true);
  assert.equal(s.user.id, 42);
});

test('the session payload and the signed-out screen agree on the reason vocabulary', async () => {
  const { env } = makeEnv();
  // The client branches on `reason` from BOTH arms. Use the server's own strings.
  const signedOut = await call('/api/ui/session', { env });
  const s = await signedOut.json();
  assert.equal(signedOut.status, 200);
  assert.equal(s.signedIn, false);
  assert.equal(typeof s.reason, 'string');
  const copy = renderSignedOut({ reason: s.reason, message: s.message });
  assert.equal(copy.copy.code, s.reason, 'the client recognises every reason the server can send');
  assert.equal(copy.copy.heading, 'Not signed in');

  // A deployment fault is reported as such, with 503 and the same body shape.
  const { env: noToken } = makeEnv({ TELEGRAM_BOT_TOKEN: undefined });
  const fault = await call('/api/ui/work', { env: noToken });
  assert.equal(fault.status, 503);
  const f = await fault.json();
  assert.deepEqual(Object.keys(f).sort(), ['error', 'message', 'ok'], 'the body shape is stable');
  assert.equal(f.error, 'no_bot_token');
  const faultCopy = renderSignedOut({ reason: f.error, message: f.message });
  assert.equal(faultCopy.copy.tone, 'fault');
  assert.equal(faultCopy.copy.retry, false);
});

test('the 401 carries cache-control: no-store, so a denial is never replayed', async () => {
  const { env } = makeEnv();
  const res = await call('/api/ui/work', { env });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS header on a denial');
});

test('the bot username is published when configured, and omitted (never invented) when not', async () => {
  const { env } = makeEnv();
  const plain = await (await call('/api/ui/session', { env })).json();
  assert.equal(plain.bot, null, 'an unconfigured deployment must not guess a username');

  const { env: named } = makeEnv({ TELEGRAM_BOT_USERNAME: 'asterion_research_bot' });
  const withBot = await (await call('/api/ui/session', { env: named })).json();
  assert.equal(withBot.bot, 'asterion_research_bot');
  const link = renderSignedOut({ reason: withBot.reason, message: withBot.message, session: withBot });
  assert.equal(allNodes(link.tree).find((n) => n.tag === 'a').attrs.href,
    'https://t.me/asterion_research_bot?startapp');

  // A malformed value is dropped server-side: it must never become a link.
  const { env: junk } = makeEnv({ TELEGRAM_BOT_USERNAME: 'not a bot!!' });
  assert.equal((await (await call('/api/ui/session', { env: junk })).json()).bot, null);
});

test('NEGATIVE CONTROLS: every way of faking a session is still refused', async () => {
  const { env } = makeEnv();

  // A tampered payload.
  const tampered = INIT_DATA.replace('%22id%22%3A42', '%22id%22%3A43');
  assert.notEqual(tampered, INIT_DATA);
  const bad = await call('/api/ui/targets', { headers: { 'x-telegram-init-data': tampered }, env });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'bad_hash');

  // A payload signed for a different bot.
  const foreign = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) }, '999999:NOTOURS');
  const other = await call('/api/ui/targets', { headers: { 'x-telegram-init-data': foreign }, env });
  assert.equal(other.status, 401);
  assert.equal((await other.json()).error, 'bad_hash');

  // A payload with no signature at all.
  const unsigned = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(OPERATOR),
  }).toString();
  const noHash = await call('/api/ui/targets', { headers: { 'x-telegram-init-data': unsigned }, env });
  assert.equal(noHash.status, 401);
  assert.equal((await noHash.json()).error, 'no_hash');

  // A stale payload, and one from the future.
  const stale = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000) - 86_400 * 3),
    user: JSON.stringify(OPERATOR),
  });
  const staleRes = await call('/api/ui/targets', { headers: { 'x-telegram-init-data': stale }, env });
  assert.equal(staleRes.status, 401);
  assert.equal((await staleRes.json()).error, 'stale');

  const future = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000) + 86_400),
    user: JSON.stringify(OPERATOR),
  });
  const futureRes = await call('/api/ui/targets', { headers: { 'x-telegram-init-data': future }, env });
  assert.equal(futureRes.status, 401);
  assert.equal((await futureRes.json()).error, 'future');

  // The stripped hash is not a session either: after boot the URL carries the
  // route and nothing else, and re-requesting with what is LEFT must be refused.
  const r = resolver({ hash: launchFragment(INIT_DATA), search: '' });
  assert.equal(r.resolveInitDataNow(), INIT_DATA);
  const strippedHash = r.hashWithoutLaunchParams(launchFragment(INIT_DATA));
  assert.equal(strippedHash, '');
  const after = resolver({ hash: strippedHash, search: '' });
  assert.equal(after.resolveInitDataNow(), '', 'the stripped URL yields no session, which is correct');
  const stripped = await call('/api/ui/targets', { headers: after.initDataHeader(''), env });
  assert.equal(stripped.status, 401);
  assert.equal((await stripped.json()).error, 'missing');
});

test('the gate itself is unchanged: no bypass was added anywhere', () => {
  // The fix is entirely client-side presentation; the server gate must be the
  // same fail-closed gate, and the shared secret path must be untouched.
  const shell = readFileSync(join(APP, 'src', 'ui', 'shell.ts'), 'utf8');
  assert.match(shell, /validateInitData\(req\.headers\.get\(INIT_DATA_HEADER\), env\.TELEGRAM_BOT_TOKEN\)/);
  assert.equal((shell.match(/validateInitData\(/g) || []).length, 1, 'exactly one gate, called once');
  assert.ok(!/skipAuth|bypass|trustUnverified|allowAnonymous|DISABLE_AUTH/i.test(shell), 'no bypass may exist');
  assert.ok(!/headers\.get\(INIT_DATA_HEADER\)\s*\|\|/.test(shell), 'no default payload may be substituted');
  // A missing token stays a denial, not a pass.
  assert.match(shell, /status = verdict\.reason === 'no_bot_token' \? 503 : 401/);
});
