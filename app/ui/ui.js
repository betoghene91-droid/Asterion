/**
 * Asterion console - the Mini App shell.
 *
 * One file, no framework, no build step: the Worker serves it byte for byte and
 * the CSP allows nothing off-origin except telegram.org.
 *
 * FOUR THINGS THIS FILE IS CAREFUL ABOUT
 *
 * 1. NOTHING from the API is ever parsed as markup. There is not a single
 *    `innerHTML` assignment in this file: every value goes through
 *    `textContent`, and elements are built with `document.createElement`. Findings
 *    titles, program names and kill details are attacker-adjacent strings out of a
 *    database, and the Worker must not be the place they become markup.
 *
 * 2. IT DRIVES THE ACTUAL TELEGRAM PLATFORM. ready/expand/disableVerticalSwipes,
 *    themeParams + colorScheme, viewportStableHeight, BackButton for drill-down,
 *    MainButton for each view's primary action, HapticFeedback on selection and
 *    outcome, and showConfirm in front of the irreversible approve. Every SDK call
 *    is feature-detected and wrapped, so the same file runs unchanged in a plain
 *    browser - which is how it is verified.
 *
 * 3. EVERY UNCAUGHT ERROR IS RECORDED on `window.__ASTERION.errors` as well as
 *    surfaced. That is what lets the browser verification assert "zero uncaught
 *    errors" from INSIDE the page instead of by eyeballing a console capture.
 *
 * 4. IT DOES NOT REIMPLEMENT THE BOT. Hunt posts free text to the same compiler
 *    the Telegram webhook calls; Queue's approve/deny calls the same
 *    `approveAndDispatch`; Library reads the same playbook and skill lists the
 *    hunter prompt is built from.
 *
 * ARRANGEMENT. Views are organised by the KIND OF WORK, not by the endpoint that
 * happens to back it: Hunt, Queue, Ask, Library, Ops from a thumb-reachable tab
 * bar, with drill-down and Back inside each.
 */

// ── platform ────────────────────────────────────────────────────────────────

const TG = (() => {
  try {
    return (globalThis.Telegram && globalThis.Telegram.WebApp) || null;
  } catch {
    return null;
  }
})();

/** Every SDK call in this file goes through here: an old host must not break it. */
function tg(method, ...args) {
  try {
    if (!TG || typeof TG[method] !== 'function') return undefined;
    return TG[method](...args);
  } catch {
    return undefined;
  }
}

// -- launch parameters -------------------------------------------------------
//
// Telegram opens a Mini App by appending its launch parameters to the FRAGMENT:
//
//   https://host/ui#tgWebAppData=<urlencoded initData>&tgWebAppVersion=7.10
//                &tgWebAppPlatform=android&tgWebAppThemeParams=<urlencoded json>
//
// Some clients have used the query string instead, so both are read. The shell
// deliberately loads no SDK - the shipped CSP allows only same-origin script -
// so in the real Telegram client `Telegram.WebApp` does not exist at all and
// this fragment is the ONLY thing that can present a session. Two separate
// things depend on reading it correctly:
//
//   * the ROUTER must not resolve `tgWebAppData=...` as a view name, which is
//     what rendered "Unknown view: tgWebAppData=..." on the operator's phone;
//   * the TRANSPORT must present the initData the Worker already validates in
//     the `x-telegram-init-data` header, so the server needs no change.

/** The launch parameters: fragment first, query string second, SDK namespace only. */
function launchParamsFrom(hash, search) {
  const out = new URLSearchParams();
  for (const raw of [String(hash || '').replace(/^#/, ''), String(search || '').replace(/^\?/, '')]) {
    if (!raw) continue;
    let params;
    try {
      params = new URLSearchParams(raw);
    } catch {
      continue;
    }
    for (const pair of params) {
      if (pair[0].startsWith('tgWebApp') && !out.has(pair[0])) out.append(pair[0], pair[1]);
    }
  }
  return out;
}

/** The initData Telegram signed, in the exact form the SDK would expose it. */
function launchInitData() {
  return launchParamsFrom(location.hash, location.search).get('tgWebAppData') || '';
}

/**
 * The ROUTE part of the fragment, which the launch parameters share.
 *
 * `#tgWebAppData=...&tgWebAppVersion=...` carries no route at all and resolves
 * to the default view. A fragment that carries BOTH - a route plus the launch
 * parameters, which is what a `startapp` re-entry looks like - keeps the route
 * and drops the parameters. A segment that is not in Telegram's `tgWebApp`
 * namespace is never treated as a parameter, so an id that happens to contain
 * `=` still routes, and a genuinely unknown route still reaches the alert.
 */
function routePartsFrom(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').trim();
  if (!raw) return [];
  const parts = [];
  for (const segment of raw.split('&')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    let key = segment;
    if (eq !== -1) {
      key = segment.slice(0, eq);
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        // A malformed escape is simply not a launch parameter name.
      }
    }
    if (eq !== -1 && key.startsWith('tgWebApp')) continue;
    for (const piece of segment.split('/')) if (piece) parts.push(piece);
  }
  return parts;
}

/**
 * The launch initData is remembered for THIS TAB while the app runs. Boot
 * replaces the launch fragment with the route so the raw launch string does not
 * sit in the URL, which means a reload inside the Mini App would otherwise
 * reload a URL with no session in it. sessionStorage, not localStorage: the
 * grant belongs to this WebView session and must not outlive it - and the
 * Worker still verifies signature and age on every single request.
 */
const LAUNCH_STORE = 'asterion.launch.initData';

function rememberLaunchInitData(value) {
  try {
    sessionStorage.setItem(LAUNCH_STORE, value);
  } catch {
    // No storage available (private mode): the fragment itself still works.
  }
}

function recallLaunchInitData() {
  try {
    const v = sessionStorage.getItem(LAUNCH_STORE);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * The fragment with Telegram's launch parameters REMOVED and any route kept.
 *
 *   #/queue/ap-1&tgWebAppData=...&tgWebAppVersion=7.10  ->  #/queue/ap-1
 *   #tgWebAppData=...&tgWebAppVersion=7.10              ->  (nothing)
 *
 * initData is a signed credential, so it must not sit in the address bar where a
 * screenshot, a shared link or a browser history entry can carry it. Only the
 * `tgWebApp` namespace is dropped: an id that happens to contain `=` survives,
 * because it is not a launch parameter.
 */
function hashWithoutLaunchParams(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return '';
  const keep = [];
  for (const segment of raw.split('&')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    let key = segment;
    if (eq !== -1) {
      key = segment.slice(0, eq);
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        // A malformed escape is not a launch parameter name either way.
      }
    }
    if (eq !== -1 && key.startsWith('tgWebApp')) continue;
    keep.push(segment);
  }
  return keep.length ? '#' + keep.join('&') : '';
}

/**
 * Take the launch parameters out of the address bar once they have been read.
 *
 * Wrapped in one try/catch on purpose: some WebViews expose no `history` at all,
 * and `replaceState` can be refused in a sandboxed frame. A payload left in the
 * URL is a smaller problem than a console that will not boot, so this never
 * throws and never reports.
 */
function forgetLaunchFragment() {
  try {
    const current = String(location.hash);
    const next = hashWithoutLaunchParams(current);
    if (next === current) return;
    const path = String(location.pathname || '') + String(location.search || '') + next;
    if (typeof history === 'object' && history && typeof history.replaceState === 'function') {
      history.replaceState(null, '', path);
    }
  } catch {
    // No history, or the host refused the write: nothing else to do here.
  }
}

/** The SDK's own copy of the session, when a host provides one. Never assumed. */
function sdkInitData() {
  try {
    return TG && typeof TG.initData === 'string' && TG.initData ? TG.initData : '';
  } catch {
    // A host shim that throws on property access must not take the page down.
    return '';
  }
}

/**
 * Resolve the Telegram session from EVERY source this page can have, or ''.
 *
 * The sources, and why the order is what it is:
 *
 *   1. `Telegram.WebApp.initData`, when a host provides one and it is non-empty.
 *   2. `#tgWebAppData=` in the fragment - the launch parameters Telegram actually
 *      appends, and the ONLY source the shipped shell has, because the CSP loads
 *      no SDK at all.
 *   3. `?tgWebAppData=` in the query string, which some clients have used.
 *   4. This tab's own earlier read, which is what survives boot replacing the
 *      launch fragment with the route.
 *   5. `globalThis.ASTERION_INIT_DATA`, the seam the browser harness injects.
 *
 * (a) and (b) are NOT independent in a real client: the SDK derives its initData
 * from the very fragment in the URL. So the SDK value is taken when it agrees
 * with the launch parameters, and the launch parameters win when the two
 * DISAGREE - a `startapp` re-entry into an already-open WebView navigates with a
 * fresh fragment while the SDK still holds the older session, and honouring the
 * stale one would present an expired credential over a valid one. Where the SDK
 * is absent, empty, or was never loaded (the shipped shell), the fragment is
 * what makes the real client work at all.
 */
function readInitData() {
  const launch = launchInitData();
  const sdk = sdkInitData();
  if (sdk && (!launch || sdk === launch)) return sdk;
  if (launch) return launch;
  const remembered = recallLaunchInitData();
  if (remembered) return remembered;
  try {
    if (typeof globalThis.ASTERION_INIT_DATA === 'string' && globalThis.ASTERION_INIT_DATA) {
      return globalThis.ASTERION_INIT_DATA;
    }
  } catch {
    // A frozen or throwing global: no seam, no session.
  }
  return '';
}

/** True once the document has reached DOMContentLoaded (or is already past it). */
function domReady() {
  if (DOM_READY) return true;
  try {
    return typeof document !== 'undefined' && document.readyState !== 'loading';
  } catch {
    return false;
  }
}

/**
 * The session, resolved AT REQUEST TIME. Never frozen, never cached.
 *
 * The module used to evaluate this once at load: `const INIT_DATA = readInitData()`.
 * That made a cold load permanent - if the first read ran before the host had put
 * the payload anywhere this page can see, the page then sent an empty header for
 * the rest of its life and the server answered `missing` forever. Two things fix
 * that: every request re-reads, and a first read that comes up empty gets ONE
 * second look once DOMContentLoaded has fired, which is when a host that
 * initialises its SDK asynchronously has finished doing so.
 */
function resolveInitDataNow() {
  let value = readInitData();
  if (!value && !S.initDataRetried && domReady()) {
    S.initDataRetried = true;
    value = readInitData();
  }
  if (value) {
    rememberLaunchInitData(value);
    forgetLaunchFragment();
  }
  S.initDataPresent = Boolean(value);
  return value;
}

/**
 * The auth header, or NOTHING AT ALL.
 *
 * An empty `x-telegram-init-data` header is not a safer request than no header:
 * the server maps both to `missing`, so sending one only makes the console look
 * like it tried while the cause it reports stays the same. The header is
 * therefore built from the payload and omitted when there is none.
 */
function initDataHeader(payload) {
  const value = typeof payload === 'string' ? payload.trim() : '';
  return value ? { 'x-telegram-init-data': value } : {};
}

const HAPTIC = {
  select() { haptic('light'); },
  tap() { haptic('medium'); },
  ok() { haptic('success'); },
  err() { haptic('error'); },
};

/**
 * The SDK nests the haptics under `HapticFeedback`; older hosts expose impact
 * kinds only. A host with neither is silent, which is correct - a missing
 * vibration must never be an error. Every call is counted so the browser
 * verification can prove the haptics are actually being driven.
 */
function haptic(kind) {
  S.platform.haptics++;
  try {
    const fb = TG && TG.HapticFeedback;
    if (!fb) return undefined;
    if (kind === 'success' || kind === 'error') {
      if (typeof fb.notificationOccurred === 'function') return fb.notificationOccurred(kind);
      if (typeof fb.impactOccurred === 'function') return fb.impactOccurred('medium');
      return undefined;
    }
    if (typeof fb.impactOccurred === 'function') return fb.impactOccurred(kind);
  } catch { /* ignore */ }
  return undefined;
}

/** Everything the page asserts about itself. Read by the browser verification. */
const S = {
  version: '2',
  ready: false,
  signedIn: false,
  /** The machine reason the gate denied with, e.g. 'missing' | 'stale'. */
  reasonCode: null,
  /** The server's body copy for that reason, unformatted. */
  reasonMessage: null,
  /** The whole session payload, so the signed-out screen can read runtime state. */
  session: null,
  /** The server's own nav model: which destinations need a session. */
  tabsList: [],
  operator: null,
  scheme: 'dark',
  theme: null,
  tab: null,
  path: null,
  depth: 0,
  fetches: 0,
  decisions: 0,
  chatTurns: 0,
  /** True when the LAST request could present a payload at all. */
  initDataPresent: false,
  /** One-shot: whether the post-DOMContentLoaded second look has happened. */
  initDataRetried: false,
  errors: [],
  viewsVisited: [],
  platform: {
    sdk: Boolean(TG),
    ready: false,
    expanded: false,
    verticalSwipesDisabled: false,
    backButton: false,
    mainButton: null,
    haptics: 0,
    confirms: 0,
  },
};
globalThis.__ASTERION = S;

/**
 * Whether the document has finished parsing. Set from the real event so a host
 * that loads the script before the body is complete still gets its second look
 * at exactly the right moment - not on a timer, and not on a guess.
 */
let DOM_READY = false;
try {
  document.addEventListener('DOMContentLoaded', () => { DOM_READY = true; });
} catch {
  // No document at all (a non-browser harness): `domReady` falls back to readyState.
}

function noteError(kind, detail) {
  S.errors.push({ kind, detail: String(detail).slice(0, 400), at: Date.now() });
}

globalThis.addEventListener('error', (e) => noteError('error', e && e.message));
globalThis.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  noteError('rejection', (r && r.message) || r);
});

// ── DOM helpers (no innerHTML anywhere) ─────────────────────────────────────

function h(tag, props, kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'style') node.setAttribute('style', String(v));
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'disabled') { if (v) node.setAttribute('disabled', ''); }
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids || []) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

/** Telegram messages arrive with <b>/<code>; the console shows them as text. */
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '');

function clampBlock(bodyText, lines = 4) {
  const body = h('div', { class: 'clamp-body', text: bodyText });
  const wrap = h('div', { class: 'clamp', 'data-clamped': '1' }, [body]);
  const toggle = h('button', { class: 'clamp-toggle', type: 'button', text: 'Show more' });
  toggle.addEventListener('click', () => {
    const on = wrap.getAttribute('data-clamped') === '1';
    wrap.setAttribute('data-clamped', on ? '0' : '1');
    toggle.textContent = on ? 'Show less' : 'Show more';
  });
  if (String(bodyText).split('\n').length > lines) wrap.appendChild(toggle);
  return wrap;
}

async function copyText(text, label) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    HAPTIC.ok();
    toast(label || 'Copied', 'ok');
  } catch {
    HAPTIC.err();
    toast('Could not copy', 'bad');
  }
}

// ── formatting ──────────────────────────────────────────────────────────────

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : String(n));
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(n));

function ago(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !unixSeconds) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function stamp(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !unixSeconds) return '';
  try { return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16); } catch { return ''; }
}

function scalar(key, v) {
  if (v === null || v === undefined) return '\u2014';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    if (/usd|equity|price|pnl|size|stop/i.test(key)) return money(v);
    if (/(^|_)pct$|_rate$/.test(key)) return (v * 100).toFixed(1) + '%';
    return num(v);
  }
  if (typeof v === 'string' && /^\d{10}$/.test(v)) return ago(Number(v));
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const sevClass = (s) => {
  const k = String(s || 'unknown').toLowerCase();
  return 'sev sev-' + (['critical', 'high', 'medium', 'low', 'info'].includes(k) ? k : 'unknown');
};
const tag = (text, kind) => h('span', { class: 'tag' + (kind ? ' ' + kind : ''), text });

function kv(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v === null || v === undefined) continue;
    dl.appendChild(h('dt', { text: k }));
    dl.appendChild(h('dd', {}, [v instanceof Node ? v : document.createTextNode(String(v))]));
  }
  return h('div', { class: 'card' }, [dl]);
}

const header = (label, at) =>
  h('div', { class: 'h' }, [
    h('span', { text: label }),
    at ? h('span', { class: 'age', text: 'updated ' + ago(Math.floor(at / 1000)) }) : null,
  ]);

const emptyLine = (text) => h('div', { class: 'empty', text });

function emptyState(glyph, text, actionLabel, onAction) {
  const kids = [h('div', { class: 'g', text: glyph, 'aria-hidden': 'true' }), h('div', { class: 't', text })];
  if (actionLabel && onAction) kids.push(h('button', { class: 'btn go', type: 'button', text: actionLabel, onclick: onAction }));
  return h('div', { class: 'empty-state' }, kids);
}

const jsonBlock = (v) => h('pre', { class: 'json', text: JSON.stringify(v, null, 2) });

function row(title, sub, right, onClick) {
  const body = h('div', { class: 'grow' }, [
    h('div', { class: 't', text: title }),
    sub ? h('div', { class: 'sub', text: sub }) : null,
  ]);
  // Body first, trailing affordance last: the conventional list row. A severity
  // chip therefore sits at the END of its row, which is where a status belongs.
  const el = h('div', { class: 'row' + (onClick ? ' tap' : '') }, [body, right || null]);
  if (onClick) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
  }
  return el;
}

function skeleton(kind) {
  if (kind === 'list') {
    const wrap = h('div', {});
    for (let i = 0; i < 4; i++) {
      const c = h('div', { class: 'sk-card' });
      c.appendChild(h('div', { class: 'sk sk-line w70' }));
      c.appendChild(h('div', { class: 'sk sk-line w40' }));
      wrap.appendChild(c);
    }
    return wrap;
  }
  const c = h('div', { class: 'sk-card' });
  for (const w of ['w40', 'w70', 'w70', 'w40']) c.appendChild(h('div', { class: 'sk sk-line ' + w }));
  return c;
}

// ── transport ───────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function api(path, opts) {
  const o = opts || {};
  S.fetches++;
  setLink('busy');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 20000);
  try {
    // Resolved HERE, per request, and never from a module-level constant: a
    // session that appears after load must be able to turn the console on, and a
    // session that was missing at load must not be remembered as missing forever.
    const session = resolveInitDataNow();
    const headers = initDataHeader(session);
    if (o.body) headers['content-type'] = 'application/json';
    const res = await fetch(path, {
      method: o.method || 'GET',
      headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!res.ok) {
      throw new ApiError(
        (payload && (payload.message || payload.error)) || 'HTTP ' + res.status + ' on ' + path,
        res.status,
        payload,
      );
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

// ── chrome ──────────────────────────────────────────────────────────────────

const viewEl = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const linkEl = document.getElementById('link');
const linkTextEl = document.getElementById('link-text');
const titleEl = document.getElementById('bar-title');
const backEl = document.getElementById('back');
const composerEl = document.getElementById('composer');
const sayEl = document.getElementById('say');
const sendEl = document.getElementById('send');
const toastsEl = document.getElementById('toasts');
const sheetEl = document.getElementById('sheet');

function setLink(state, label) {
  linkEl.setAttribute('data-state', state);
  if (label) linkTextEl.textContent = label;
  else if (state === 'live') linkTextEl.textContent = S.operator ? S.operator : 'live';
  else if (state === 'busy') linkTextEl.textContent = 'working';
  else if (state === 'error') linkTextEl.textContent = 'error';
  else linkTextEl.textContent = S.signedIn ? 'live' : 'read-only';
}

function toast(text, kind) {
  const el = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text });
  toastsEl.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2800);
}

/**
 * Telegram's own confirm dialog when it exists, our sheet otherwise. Callback
 * based because that is the shape `showConfirm` has; wrapped in a promise so the
 * approve path reads the same either way.
 */
function confirmAction(title, message) {
  S.platform.confirms++;
  return new Promise((resolve) => {
    if (TG && typeof TG.showConfirm === 'function') {
      try {
        let settled = false;
        TG.showConfirm(message, (ok) => { settled = true; resolve(Boolean(ok)); });
        // A host that never calls back (some shims) must not hang the approve.
        setTimeout(() => { if (!settled) sheetConfirm(title, message, resolve, true); }, 400);
        return;
      } catch { /* fall through to our own sheet */ }
    }
    sheetConfirm(title, message, resolve, false);
  });
}

function sheetConfirm(title, message, resolve, alreadyCounted) {
  if (!alreadyCounted) S.platform.confirms++;
  const titleNode = document.getElementById('sheet-title');
  const bodyNode = document.getElementById('sheet-body');
  const yes = document.getElementById('sheet-yes');
  const no = document.getElementById('sheet-no');
  titleNode.textContent = title;
  bodyNode.textContent = stripTags(message);
  sheetEl.hidden = false;
  no.focus();

  const done = (value) => {
    sheetEl.hidden = true;
    yes.removeEventListener('click', onYes);
    no.removeEventListener('click', onNo);
    document.removeEventListener('keydown', onKey);
    resolve(value);
  };
  const onYes = () => done(true);
  const onNo = () => done(false);
  const onKey = (e) => { if (e.key === 'Escape') done(false); };
  yes.addEventListener('click', onYes);
  no.addEventListener('click', onNo);
  document.addEventListener('keydown', onKey);
}

/** Per-view primary action. `null` hides it, which is correct when there is none. */
function setMainButton(label, onClick) {
  S.platform.mainButton = label || null;
  try {
    const mb = TG && TG.MainButton;
    if (!mb) return;
    if (typeof mb.setText === 'function' && label) mb.setText(label);
    if (typeof mb.show === 'function' && typeof mb.hide === 'function') {
      if (label && onClick) mb.show(); else mb.hide();
    }
    if (typeof mb.onClick === 'function') {
      if (mb.__asterionBound) { try { mb.offClick(mb.__asterionBound); } catch { /* ignore */ } }
      if (label && onClick) {
        mb.__asterionBound = onClick;
        mb.onClick(onClick);
      }
    }
    if (typeof mb.enable === 'function' && typeof mb.disable === 'function') {
      if (label && onClick) mb.enable(); else mb.disable();
    }
    if (typeof mb.setParams === 'function') {
      mb.setParams({ text: label || '', is_visible: Boolean(label && onClick) });
    }
  } catch { /* an old host: the DOM controls still work */ }
}

let backVisible = false;
function setBack(visible) {
  backVisible = visible;
  backEl.hidden = !visible;
  S.platform.backButton = visible;
  try {
    const bb = TG && TG.BackButton;
    if (bb && typeof bb.show === 'function' && typeof bb.hide === 'function') {
      if (visible) bb.show(); else bb.hide();
    }
  } catch { /* ignore */ }
}

function goBack() {
  const parts = pathParts();
  if (parts.length > 1) go('/' + parts[0], { replace: true });
  else if (parts.length === 1 && parts[0] !== 'hunt') go('/hunt', { replace: true });
}

function applyTheme() {
  const doc = document.documentElement;
  let scheme = 'dark';
  let params = null;
  try {
    params = TG && TG.themeParams ? TG.themeParams : null;
    if (TG && typeof TG.colorScheme === 'string') scheme = TG.colorScheme;
  } catch { /* ignore */ }

  if (!TG && !params) {
    // Outside Telegram: follow the OS so a plain browser run still looks right.
    try {
      scheme = globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch { /* ignore */ }
  }

  S.scheme = scheme;
  S.theme = params || null;
  doc.setAttribute('data-scheme', scheme);

  const map = {
    bg_color: '--bg',
    secondary_bg_color: '--card',
    section_bg_color: '--card-2',
    section_separator_color: '--line',
    text_color: '--ink',
    subtitle_text_color: '--dim',
    hint_color: '--faint',
    button_color: '--accent',
    button_text_color: '--accent-ink',
    link_color: '--link',
    destructive_text_color: '--danger',
  };
  if (params) {
    for (const key of Object.keys(map)) {
      const value = params[key];
      if (typeof value === 'string' && value) doc.style.setProperty(map[key], value);
    }
  }

  let header = null;
  try {
    header = (params && params.bg_color) || null;
  } catch { /* ignore */ }
  tg('setHeaderColor', header || 'bg_color');
  tg('setBackgroundColor', (params && params.secondary_bg_color) || 'bg_color');
}

function applyViewport() {
  try {
    const height = TG ? TG.viewportStableHeight || TG.viewportHeight : 0;
    if (typeof height === 'number' && height > 0) {
      document.documentElement.style.setProperty('--tg-viewport-stable-height', height + 'px');
    }
  } catch { /* ignore */ }
}

function initPlatform() {
  if (!TG) {
    setLink('idle');
    return;
  }
  tg('ready');
  S.platform.ready = true;
  tg('expand');
  S.platform.expanded = true;
  tg('disableVerticalSwipes');
  S.platform.verticalSwipesDisabled = true;
  tg('onEvent', 'viewportChanged', applyViewport);
  applyViewport();
  try {
    const bb = TG.BackButton;
    if (bb && typeof bb.onClick === 'function') bb.onClick(goBack);
  } catch { /* ignore */ }
}

// ── navigation ──────────────────────────────────────────────────────────────

function pathParts() {
  return routePartsFrom(location.hash);
}

function go(path, opts) {
  const next = '#' + (path.startsWith('/') ? path : '/' + path);
  const o = opts || {};
  if (location.hash === next) {
    renderRoute();
    return;
  }
  if (o.replace) {
    try {
      history.replaceState(null, '', next);
      renderRoute();
      return;
    } catch { /* fall through */ }
  }
  location.hash = next;
}

const TAB_LABELS = { hunt: 'Hunt', queue: 'Queue', ask: 'Ask', library: 'Library', ops: 'Ops' };

function selectTab(tab) {
  for (const b of tabsEl.querySelectorAll('.tab')) {
    b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab));
  }
}

const cache = new Map(); // route -> { at, value }

function renderRoute() {
  const parts = pathParts();
  const tab = parts[0] || 'hunt';
  const rest = parts.slice(1);
  S.tab = tab;
  S.path = '/' + parts.join('/');
  S.depth = rest.length;
  if (S.viewsVisited[S.viewsVisited.length - 1] !== S.path) S.viewsVisited.push(S.path);

  /**
   * A destination that needs a session, without one, renders the signed-out
   * screen instead of its own view. That is the whole fix: the Hunt tab used to
   * render a skeleton, fire an authenticated request, and put the resulting 401
   * BODY on screen. There is nothing to fetch signed out, so nothing is fetched
   * and no skeleton is painted - a skeleton implies data is coming.
   */
  const gated = !S.signedIn && tabNeedsAuth(tab);

  selectTab(tab);
  setBack(rest.length > 0 && !gated);
  titleEl.textContent = TAB_LABELS[tab] || 'Asterion';
  const composing = !gated && ((tab === 'hunt' && rest.length === 0) || (tab === 'ask' && rest.length === 0));
  composerEl.hidden = !composing;
  document.body.setAttribute('data-compose', composing ? '1' : '0');
  document.body.setAttribute('data-signed-in', S.signedIn ? '1' : '0');
  // The MainButton is cleared for EVERY render and then set by the view that has
  // a primary action. Clearing only on some paths left the Queue's "Authorize"
  // showing on Ask, which is a button that does nothing where it is.
  setMainButton(null, null);

  if (gated) {
    // No badge is painted and the main action stays empty: a signed-out console
    // must not show chrome that implies a live session.
    hideBadges();
  } else {
    updateBadges();
  }

  if (composing && tab === 'hunt') {
    setMainButton('Propose', submitComposer);
  }

  const built = gated ? signedOutView() : buildView(tab, rest);
  clear(viewEl);
  viewEl.appendChild(built);
  try { viewEl.focus({ preventScroll: true }); } catch { /* ignore */ }
  try { document.title = 'Asterion \u00b7 ' + (TAB_LABELS[tab] || tab); } catch { /* ignore */ }
}

function buildView(tab, rest) {
  try {
    if (tab === 'hunt') return viewHunt();
    if (tab === 'queue') return rest.length ? viewQueueDetail(rest[0]) : viewQueue();
    if (tab === 'ask') return viewAsk();
    if (tab === 'library') return rest.length ? viewLibraryDetail(rest.join('/')) : viewLibrary();
    if (tab === 'ops') return rest.length ? viewOpsDetail(rest[0]) : viewOps();
  } catch (e) {
    noteError('view', tab + ': ' + ((e && e.message) || e));
    return h('div', { class: 'alert bad', text: 'Could not open ' + tab + ': ' + ((e && e.message) || e) });
  }
  return h('div', { class: 'alert bad', text: 'Unknown view: ' + tab });
}

/**
 * Stale-while-revalidate for the read-only surfaces: paint what we already have,
 * then refresh underneath. Returns a container the caller can put in the view.
 */
function swr(path, render, opts) {
  const o = opts || {};
  const host = h('div', {});
  const cached = cache.get(path);
  const paint = (value, at) => {
    clear(host);
    if (o.header !== false) host.appendChild(header(o.label || '', at));
    host.appendChild(render(value));
  };
  if (cached) paint(cached.value, cached.at);
  else host.appendChild(skeleton(o.skeleton || 'card'));

  api(path)
    .then((value) => {
      cache.set(path, { at: Date.now(), value });
      setLink('live');
      paint(value, Date.now());
      if (o.after) o.after(value);
    })
    .catch((e) => {
      setLink('error');
      clear(host);
      host.appendChild(header(o.label || ''));
      host.appendChild(h('div', { class: 'alert bad', text: messageOf(e) }));
      if (!o.noHint) host.appendChild(emptyLine('This view only displays the endpoint; nothing here changed it.'));
    });
  return host;
}

const messageOf = (e) =>
  (e && e.status ? 'HTTP ' + e.status + ': ' : '') + ((e && e.message) || 'request failed');

// ── the signed-out state ────────────────────────────────────────────────────
//
// WHAT WENT WRONG. `/api/ui/*` answers a request with no verified Telegram
// session in `{ ok:false, error, message }` and status 401 (503 when the Worker
// has no bot token at all). That is the correct server behaviour - the gate
// fails closed - but the console used to have no state for it: the response was
// rendered as a view, so the operator saw the raw body, "asterion" and
// "HTTP 401: No Telegram session was presented." on the Hunt tab.
//
// A missing session is NOT an error in the console. It is a normal state with
// two possible causes - the user is not in Telegram, or the Worker is not
// configured - and each has a different remedy, so each gets its own screen.
// The raw body is never shown: the server's message is body COPY, with the
// transport prefix stripped, and the machine reason is kept as a secondary
// detail an operator can copy into a bug report.

/** Machine reasons initdata.ts can deny with, in the order the gate can reach them. */
const SIGNED_OUT_REASONS = [
  'no_bot_token',
  'missing',
  'malformed',
  'no_hash',
  'bad_hash',
  'no_auth_date',
  'stale',
  'future',
];

/**
 * Strip the transport decoration off a server message.
 *
 * The body the operator saw carried three things that are not copy: a leading
 * "asterion" (the page title, pasted into the string by whatever rendered it),
 * an "HTTP 401:"/"HTTP 503:" transport prefix, and possibly both in either
 * order. The message itself is the only part a human should read, so the rest
 * is removed - repeatedly, because the two can nest.
 */
function stripServerPrefixes(text) {
  let s = String(text === null || text === undefined ? '' : text).trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^(?:asterion\b\s*[:.\u2014-]?\s*|HTTP\s*\d{3}\s*:\s*)/i, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * The copy for a signed-out reason. PURE, so a test can drive every reason
 * without a DOM.
 *
 * `tone` is 'fault' only for a deployment fault - something the OPERATOR must
 * fix and the visitor cannot. `retry` is false exactly where retrying cannot
 * possibly help, because a Retry that always fails is worse than no button.
 */
function signedOutCopy(reason, message) {
  const code = SIGNED_OUT_REASONS.indexOf(reason) === -1 ? 'missing' : reason;
  const said = stripServerPrefixes(message);
  if (code === 'no_bot_token') {
    return {
      code,
      tone: 'fault',
      glyph: '\u2699',
      heading: 'Console not configured',
      body: 'This Worker has no TELEGRAM_BOT_TOKEN, so it cannot verify anyone. '
        + 'The bot keeps working in chat. An operator has to set the secret and redeploy.',
      detail: said || 'TELEGRAM_BOT_TOKEN is not set on this Worker.',
      action: 'Set TELEGRAM_BOT_TOKEN on the Worker, then redeploy.',
      retry: false,
    };
  }
  if (code === 'stale') {
    return {
      code,
      tone: 'read',
      glyph: '\u23F3',
      heading: 'Session expired',
      body: 'Your Telegram session is older than the 24-hour window the gate accepts. '
        + 'Nothing is lost - reopen the console and it will sign you in again.',
      detail: said || 'The session is past its freshness window.',
      action: null,
      retry: true,
    };
  }
  if (code === 'future') {
    return {
      code,
      tone: 'read',
      glyph: '\u23F1',
      heading: 'Session not yet valid',
      body: 'The signed timestamp is ahead of this server\u2019s clock, which is either a '
        + 'device clock that is wrong or a server clock that is. Check the device first.',
      detail: said || 'The session timestamp is in the future.',
      action: null,
      retry: true,
    };
  }
  if (code === 'missing') {
    return {
      code,
      tone: 'read',
      glyph: '\u25CB',
      heading: 'Not signed in',
      body: 'The console needs the Telegram session that only the client can present. '
        + 'A plain browser tab cannot produce one, and neither can a cold load before '
        + 'Telegram has handed the launch parameters over.',
      detail: said || 'No Telegram session was presented.',
      action: null,
      retry: true,
    };
  }
  return {
    code,
    tone: 'read',
    glyph: '\u26A0',
    heading: 'Session not accepted',
    body: 'Telegram sent something, but the signature or the payload did not survive '
      + 'verification. Reopening from the bot chat issues a fresh one.',
    detail: said || 'The session could not be verified.',
    action: null,
    retry: true,
  };
}

/**
 * The bot's PUBLIC username, from whatever the runtime actually exposes.
 *
 * Deliberately not hardcoded and deliberately strict: a `t.me/<name>?startapp`
 * link to a username that is not this bot is a dead button that looks alive, and
 * a link to somebody else's bot is worse. Every candidate is reduced to a bare
 * handle and must match Telegram's bot-username shape, which always ends in
 * "bot". Nothing found means no link - the screen then explains where to find
 * the console instead of pretending to offer a shortcut.
 */
function botUsername(session) {
  const candidates = [];
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) candidates.push(v.trim());
  };
  if (session) {
    add(session.bot);
    add(session.botUsername);
    add(session.bot_username);
  }
  try {
    add(globalThis.ASTERION_BOT);
  } catch { /* a locked-down global is simply no hint */ }
  for (const c of candidates) {
    const handle = c
      .replace(/^https?:\/\/t\.me\//i, '')
      .replace(/^@/, '')
      .split(/[/?#]/)[0];
    if (/^[A-Za-z][A-Za-z0-9_]{2,30}[Bb][Oo][Tt]$/.test(handle)) return handle;
  }
  return '';
}

/** Where "Reopen in Telegram" points, or '' when no bot is discoverable. */
function reopenHref(session) {
  const name = botUsername(session);
  return name ? 'https://t.me/' + name + '?startapp' : '';
}

/** True when a tab's data is behind the gate, per the server's own nav model. */
function tabNeedsAuth(tab) {
  const list = S.tabsList || [];
  for (const t of list) if (t && t.id === tab) return t.auth !== false;
  // No model yet: only Ops is documented as session-free.
  return tab !== 'ops';
}

/**
 * The screen itself. Non-error by construction: an empty state, not an alert -
 * except for `no_bot_token`, which IS a fault and says so in red to the one
 * person who can fix it.
 */
function signedOutView() {
  const copy = signedOutCopy(S.reasonCode, S.reasonMessage);
  const wrap = h('div', { class: 'signed-out', id: 'signed-out', 'data-code': copy.code });

  // A deployment fault is the ONE variant that is an error, because it is one:
  // the visitor cannot fix it and the operator must. Everything else is a state.
  if (copy.tone === 'fault') {
    wrap.appendChild(h('div', { class: 'alert bad', text: copy.body }));
    wrap.appendChild(h('div', { class: 'note', text: copy.action }));
    wrap.appendChild(h('details', { class: 'code' }, [
      h('summary', { text: 'Reason code' }),
      h('div', { class: 'code-body', text: copy.code + ' \u00b7 ' + copy.detail }),
    ]));
    return wrap;
  }

  const box = h('div', { class: 'empty-state' }, [
    h('div', { class: 'g', text: copy.glyph, 'aria-hidden': 'true' }),
    h('div', { class: 'heading', role: 'heading', 'aria-level': '2', text: copy.heading }),
    h('div', { class: 't', text: copy.body }),
  ]);

  const href = reopenHref(S.session);
  if (href) {
    const actions = h('div', { class: 'actions centre' });
    actions.appendChild(h('a', { class: 'btn go', href, rel: 'noopener noreferrer', text: 'Reopen in Telegram' }));
    if (copy.retry) actions.appendChild(retryButton());
    box.appendChild(actions);
  } else {
    // No discoverable bot username: say where the session comes from instead of
    // rendering a link to a bot that may not be this one.
    box.appendChild(h('div', { class: 'note', text: 'Open the console from the button inside the bot chat - that is the only place a session comes from.' }));
    if (copy.retry) box.appendChild(h('div', { class: 'actions centre' }, [retryButton()]));
  }

  wrap.appendChild(box);
  wrap.appendChild(h('details', { class: 'code' }, [
    h('summary', { text: 'Reason code' }),
    h('div', { class: 'code-body', text: copy.code + ' \u00b7 ' + copy.detail }),
  ]));
  return wrap;
}

/** "Retry" re-probes without a reload. Never rendered where it cannot succeed. */
function retryButton() {
  const retry = h('button', { class: 'btn quiet', type: 'button', text: 'Retry' });
  retry.addEventListener('click', () => {
    retry.disabled = true;
    retry.textContent = 'Retrying\u2026';
    void retrySession();
  });
  return retry;
}

/**
 * Take the session payload and put the console in a state that matches it.
 * Split out of boot so that Retry re-probes through the SAME path boot uses and
 * cannot drift into a second, more forgiving reading of the endpoint.
 */
function applySession(session) {
  S.session = session || null;
  S.signedIn = Boolean(session && session.signedIn);
  S.reasonCode = (session && session.reason) || (S.signedIn ? null : 'missing');
  S.reasonMessage = (session && session.message) || null;
  S.operator = (session && session.operator) || null;
  S.tabsList = (session && session.tabs) || [];
  if (session) applyServerNav(session);
  setLink(S.signedIn ? 'live' : 'off');
  updateBadges((session && session.counts) || null);
}

/**
 * Re-resolve the launch parameters and ask the server again, WITHOUT a reload.
 *
 * A reload is the wrong tool: it discards the tab, and on a cold load it is
 * exactly what produced the empty session in the first place. Retry clears the
 * one-shot flag so the second look at DOMContentLoaded is available again, then
 * re-renders from whatever the server now says.
 */
async function retrySession() {
  S.initDataRetried = false;
  let session = null;
  try {
    session = await api('/api/ui/session');
  } catch (e) {
    noteError('session', messageOf(e));
    toast('Could not reach the console. ' + messageOf(e), 'bad');
    S.initDataPresent = false;
  }
  applySession(session);
  renderRoute();
  if (S.signedIn) {
    HAPTIC.ok();
    toast('Signed in', 'ok');
  } else {
    HAPTIC.select();
  }
  return S.signedIn;
}

// ── Hunt ────────────────────────────────────────────────────────────────────

let threadEl = null;
let lastBrief = null;

function viewHunt() {
  // Signed out, Hunt has nothing to show: `renderRoute` paints the signed-out
  // screen instead of calling this at all. The thread is not built until there is
  // a session, so a signed-out console has no thread skeleton behind it either.
  const wrap = h('div', {});
  if (!threadEl) {
    threadEl = h('div', { class: 'thread', id: 'thread' });
    greet();
  }
  wrap.appendChild(threadEl);
  requestAnimationFrame(() => { viewEl.scrollTop = viewEl.scrollHeight; });
  return wrap;
}

function greet() {
  const kids = [
    h('div', { class: 'who', text: 'asterion' }),
    h('div', { text: 'Give it a target. It compiles the hunt and queues it for your decision.' }),
    h('ol', { class: 'steps' }, [
      h('li', { text: 'Type anything - a URL, a domain, a 0x address.' }),
      h('li', { text: 'Answer at most three questions if it needs them (they land in Ask).' }),
      h('li', { text: 'Authorize in Queue. Nothing runs before that.' }),
    ]),
  ];
  const ex = h('button', { class: 'btn quiet', type: 'button', text: 'Example', onclick: () => {
    sayEl.value = 'look at app.example.com api, take your time';
    sayEl.focus();
    growComposer();
  } });
  kids.push(h('div', { class: 'actions' }, [ex]));
  threadEl.appendChild(h('div', { class: 'turn' }, [h('div', { class: 'bubble' }, kids)]));
}

function pushTurn(kind, node) {
  const turn = h('div', { class: 'turn' + (kind === 'me' ? ' me' : '') }, [node]);
  threadEl.appendChild(turn);
  requestAnimationFrame(() => { viewEl.scrollTop = viewEl.scrollHeight; });
  return turn;
}

const bubble = (kids, cls) => h('div', { class: 'bubble' + (cls ? ' ' + cls : '') }, [h('div', { class: 'who', text: 'asterion' })].concat(kids));

function pushThinking() {
  return pushTurn('bot', bubble([h('div', { class: 'think' }, [h('i'), h('i'), h('i')])]));
}

function growComposer() {
  sayEl.style.height = 'auto';
  sayEl.style.height = Math.min(112, sayEl.scrollHeight) + 'px';
}

function submitComposer() {
  const text = sayEl.value;
  if (!text.trim()) return;
  sayEl.value = '';
  growComposer();
  void say(text);
}

async function say(text, answers) {
  const t = String(text || '').trim();
  if (!t) return;
  if (S.tab !== 'hunt') {
    go('/hunt');
    await new Promise((r) => setTimeout(r, 0));
  }
  pushTurn('me', h('div', { class: 'bubble' }, [h('div', { text: t })]));
  const thinking = pushThinking();
  setLink('busy');
  try {
    const r = await api('/api/ui/engage', { method: 'POST', body: { text: t, answers: answers || undefined } });
    S.chatTurns++;
    thinking.remove();
    setLink('live');
    handleEngage(r, t);
  } catch (e) {
    thinking.remove();
    setLink('error');
    pushTurn('bot', bubble([h('div', { text: messageOf(e) })], 'bad'));
  }
  cache.delete('/api/ui/work');
}

/** Render whatever the compiler said. Shared by Hunt and Ask. */
function handleEngage(r, originalText) {
  if (!r || !r.ok) {
    pushTurn('bot', bubble([h('div', { text: (r && (r.message || r.error)) || 'No answer.' })], 'bad'));
    return null;
  }
  if (r.kind === 'unauthorized') {
    pushTurn('bot', bubble([
      h('div', { text: r.message }),
      h('div', { class: 'sub', text: 'program: ' + (r.programId || 'unknown') }),
    ]));
    return null;
  }
  if (r.kind === 'questions') {
    const rec = rememberQuestions(r, originalText);
    pushTurn('bot', bubble(questionNodes(r.questions, r, originalText, rec)));
    toast('Saved to Ask', 'ok');
    return rec;
  }
  if (r.kind === 'brief') {
    lastBrief = r;
    pushTurn('bot', bubble([briefCard(r, { inChat: true })]));
    setMainButton(null, null);
    return r;
  }
  pushTurn('bot', bubble([jsonBlock(r)]));
  return null;
}

function questionNodes(questions, r, originalText, rec) {
  const kids = [
    h('div', { text: questions.length === 1 ? 'One thing before this runs:' : 'Before this runs:' }),
  ];
  for (const q of questions) kids.push(h('div', { text: '\u00b7 ' + q.text }));
  const actions = h('div', { class: 'actions' });
  const first = questions[0];
  if (first && first.options && first.options.length) {
    for (const opt of first.options.slice(0, 6)) {
      const answer = {};
      answer[first.key] = opt.value;
      const b = h('button', { class: 'btn', type: 'button', text: opt.label });
      b.addEventListener('click', () => {
        HAPTIC.select();
        for (const other of actions.querySelectorAll('button')) other.disabled = true;
        resolveQuestion(rec, r, originalText, answer);
      });
      actions.appendChild(b);
    }
    kids.push(actions);
  }
  kids.push(h('div', { class: 'sub', text: 'Saved to Ask - or just type the answer.' }));
  return kids;
}

function resolveQuestion(rec, r, originalText, answer) {
  forgetQuestion(rec && rec.id);
  say(originalText, answer);
}

// ── Ask: the follow-ups the bot is waiting on ───────────────────────────────
//
// WHY THIS VIEW EXISTS AT ALL. In the Telegram chat, a follow-up question renders
// as buttons carrying `ans:<key>:<value>` - and `routeButton` in index.ts has no
// `ans` case, so tapping one does nothing at all. The conversation simply stops
// there. Answering here is therefore not a second way to do something the bot
// already does; it is the only working way to answer a follow-up.
//
// The queue is kept in localStorage, because the server has no record of a
// pending question: `compile()` returns them, `startHunt` renders them, and
// nothing persists them. localStorage (not a new table) keeps the console from
// inventing a state machine on a shared table that another workstream may own.

const ASK_KEY = 'asterion.questions.v1';

function readQuestions() {
  try {
    const raw = globalThis.localStorage.getItem(ASK_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((q) => q && q.id && Array.isArray(q.questions)) : [];
  } catch { return []; }
}

function writeQuestions(list) {
  try { globalThis.localStorage.setItem(ASK_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* private mode */ }
}

function rememberQuestions(r, originalText) {
  const rec = {
    id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: Math.floor(Date.now() / 1000),
    text: originalText,
    programId: r.programId || null,
    authorizationRef: r.authorizationRef || null,
    questions: r.questions || [],
  };
  const list = readQuestions();
  list.unshift(rec);
  writeQuestions(list);
  updateBadges();
  return rec;
}

function forgetQuestion(id) {
  if (!id) return;
  writeQuestions(readQuestions().filter((q) => q.id !== id));
  updateBadges();
}

function viewAsk() {
  const wrap = h('div', {});
  const list = readQuestions();
  wrap.appendChild(header('waiting on an answer (' + list.length + ')'));
  if (!list.length) {
    wrap.appendChild(
      emptyState(
        '\u270E',
        'No open questions. The compiler only asks when it cannot settle the target or the class from what you typed.',
        'Start a hunt',
        () => go('/hunt'),
      ),
    );
    return wrap;
  }
  for (const rec of list) wrap.appendChild(askCard(rec));
  wrap.appendChild(
    h('div', { class: 'note', text: 'In the Telegram chat these follow-ups are dead: the buttons carry an ans: payload the bot has no handler for. Answering here is the only path that completes one.' }),
  );
  return wrap;
}

function askCard(rec) {
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-title', text: rec.questions[0] ? rec.questions[0].text : 'Question' }));
  card.appendChild(h('div', { class: 'card-sub', text: 'asked ' + ago(rec.at) + (rec.programId ? ' \u00b7 ' + rec.programId : '') }));
  if (rec.text) card.appendChild(h('div', { class: 'note', text: 'you said: ' + rec.text }));

  const q = rec.questions[0];
  const actions = h('div', { class: 'actions' });
  if (q && q.options && q.options.length) {
    for (const opt of q.options.slice(0, 6)) {
      const answer = {};
      answer[q.key] = opt.value;
      const b = h('button', { class: 'btn', type: 'button', text: opt.label });
      b.addEventListener('click', () => {
        HAPTIC.select();
        for (const other of actions.querySelectorAll('button')) other.disabled = true;
        answerQuestion(rec, answer, actions);
      });
      actions.appendChild(b);
    }
  } else {
    // No prepared options: answering means typing, so send them to Hunt with the
    // original text already in the composer rather than leaving a dead card.
    const t = h('button', { class: 'btn go', type: 'button', text: 'Answer in Hunt' });
    t.addEventListener('click', () => {
      HAPTIC.select();
      go('/hunt');
      sayEl.value = rec.text || '';
      sayEl.focus();
      growComposer();
    });
    actions.appendChild(t);
  }
  const drop = h('button', { class: 'btn quiet', type: 'button', text: 'Dismiss' });
  drop.addEventListener('click', () => {
    HAPTIC.select();
    forgetQuestion(rec.id);
    go('/ask', { replace: true });
    renderRoute();
  });
  actions.appendChild(drop);
  card.appendChild(actions);
  return card;
}

async function answerQuestion(rec, answer, actionsEl) {
  setLink('busy');
  try {
    const r = await api('/api/ui/engage', { method: 'POST', body: { text: rec.text, answers: answer } });
    S.chatTurns++;
    setLink('live');
    HAPTIC.ok();
    forgetQuestion(rec.id);
    const card = actionsEl.closest('.card');
    clear(card);
    const inner = handleEngageInline(r, rec.text);
    card.appendChild(inner);
    toast(r && r.kind === 'brief' ? 'Brief queued' : 'Answered', 'ok');
  } catch (e) {
    setLink('error');
    HAPTIC.err();
    for (const b of actionsEl.querySelectorAll('button')) b.disabled = false;
    toast(messageOf(e), 'bad');
  }
  cache.delete('/api/ui/work');
  updateBadges();
}

/** The same rendering rules as the chat, but without touching the Hunt thread. */
function handleEngageInline(r, originalText) {
  if (!r || !r.ok) return h('div', { class: 'alert bad', text: (r && (r.message || r.error)) || 'No answer.' });
  if (r.kind === 'unauthorized') {
    return h('div', {}, [
      h('div', { class: 'alert', text: r.message }),
      h('div', { class: 'card-sub', text: 'program: ' + (r.programId || 'unknown') }),
    ]);
  }
  if (r.kind === 'questions') return h('div', {}, questionNodes(r.questions, r, originalText, rememberQuestions(r, originalText)));
  if (r.kind === 'brief') return briefCard(r, {});
  return jsonBlock(r);
}

// ── Queue: the approvals ────────────────────────────────────────────────────

function viewQueue() {
  const wrap = h('div', {});
  const host = h('div', {});
  wrap.appendChild(host);
  const paint = (v, at) => {
    clear(host);
    host.appendChild(header('waiting on you (' + (v.pending || []).length + ')', at));
    if (!v.pending || !v.pending.length) {
      host.appendChild(emptyState('\u25A6', 'Nothing is waiting. The queue is quiet.', 'Start a hunt', () => go('/hunt')));
    }
    for (const item of v.pending || []) host.appendChild(queueCard(item));
    host.appendChild(header('recent decisions'));
    if (!v.decided || !v.decided.length) host.appendChild(emptyLine('No decisions yet.'));
    else {
      const card = h('div', { class: 'card' });
      for (const it of v.decided.slice(0, 12)) {
        card.appendChild(
          row(
            it.title || it.reason,
            (it.targets && it.targets.length ? it.targets.join(', ') : 'no target') + ' \u00b7 ' + (it.status || '') + ' \u00b7 ' + stamp(it.decided_at || it.requested_at),
            h('span', { class: sevClass(it.status === 'approved' ? 'info' : 'unknown'), text: it.status }),
          ),
        );
      }
      host.appendChild(card);
    }
    updateBadges(v.counts);
  };
  const cached = cache.get('/api/ui/work');
  if (cached) paint(cached.value, cached.at);
  else host.appendChild(skeleton('list'));
  api('/api/ui/work')
    .then((v) => { cache.set('/api/ui/work', { at: Date.now(), value: v }); setLink('live'); paint(v, Date.now()); })
    .catch((e) => {
      setLink('error');
      clear(host);
      host.appendChild(h('div', { class: 'alert bad', text: messageOf(e) }));
    });
  return wrap;
}

function queueCard(item) {
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-title', text: item.title || item.reason }));
  card.appendChild(h('div', { class: 'card-sub', text: (item.targets || []).join(', ') || 'no target recorded' }));
  const dl = h('dl', { class: 'kv' });
  for (const [k, val] of [['class', item.cls], ['mutability', item.mutability], ['time box', item.time_box_minutes ? item.time_box_minutes + ' min' : null], ['requested', ago(item.requested_at)]]) {
    if (val === null || val === undefined) continue;
    dl.appendChild(h('dt', { text: k }));
    dl.appendChild(h('dd', { text: String(val) }));
  }
  card.appendChild(h('div', {}, [dl]));
  if (item.playbooks && item.playbooks.length) {
    const tags = h('div', {});
    for (const p of item.playbooks) tags.appendChild(tag(p));
    card.appendChild(tags);
  }
  const actions = h('div', { class: 'actions' });
  actions.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Open', onclick: () => { HAPTIC.select(); go('/queue/' + item.id); } }));
  card.appendChild(actions);
  return card;
}

function viewQueueDetail(id) {
  const wrap = h('div', {});
  const host = h('div', {});
  wrap.appendChild(host);

  const paint = (item, at) => {
    clear(host);
    host.appendChild(header('approval', at));
    const card = h('div', { class: 'card' });
    card.appendChild(h('div', { class: 'card-title', text: item.title || item.reason }));
    card.appendChild(h('div', { class: 'card-sub', text: item.id }));
    const dl = h('dl', { class: 'kv' });
    for (const [k, val] of [['targets', (item.targets || []).join(', ')], ['class', item.cls], ['mutability', item.mutability], ['time box', item.time_box_minutes ? item.time_box_minutes + ' min' : null], ['requested', ago(item.requested_at)], ['status', item.status]]) {
      if (val === null || val === undefined || val === '') continue;
      dl.appendChild(h('dt', { text: k }));
      dl.appendChild(h('dd', { text: String(val) }));
    }
    card.appendChild(h('div', {}, [dl]));
    if (item.playbooks && item.playbooks.length) {
      const tags = h('div', {});
      for (const p of item.playbooks) tags.appendChild(tag(p));
      card.appendChild(tags);
    }
    host.appendChild(card);

    const state = h('div', { class: 'card-sub', 'data-state': item.status });
    const actions = h('div', { class: 'actions' });
    if (item.status === 'pending') {
      const yes = h('button', { class: 'btn go', type: 'button', text: '\u2713  Authorize' });
      const no = h('button', { class: 'btn no', type: 'button', text: '\u2717  Deny' });
      yes.addEventListener('click', () => decide(item.id, true, actions, state));
      no.addEventListener('click', () => decide(item.id, false, actions, state));
      actions.appendChild(yes);
      actions.appendChild(no);
      setMainButton('Authorize', () => decide(item.id, true, actions, state));
    } else {
      actions.appendChild(tag(item.status, item.status === 'approved' ? 'ok' : item.status === 'denied' ? 'bad' : 'warn'));
      setMainButton(null, null);
    }
    host.appendChild(actions);
    host.appendChild(state);
  };

  const cached = cache.get('/api/ui/work');
  const fromCache = cached && cached.value ? (cached.value.pending || []).concat(cached.value.decided || []).find((x) => x.id === id) : null;
  if (fromCache) paint(fromCache, cached.at);
  else host.appendChild(skeleton('card'));

  api('/api/ui/work')
    .then((v) => {
      cache.set('/api/ui/work', { at: Date.now(), value: v });
      setLink('live');
      const all = (v.pending || []).concat(v.decided || []);
      const item = all.find((x) => x.id === id);
      if (!item) {
        clear(host);
        host.appendChild(header('approval'));
        host.appendChild(h('div', { class: 'alert bad', text: 'No approval with that id. It may have been expired by maintenance.' }));
        setMainButton(null, null);
        return;
      }
      paint(item, Date.now());
      updateBadges(v.counts);
    })
    .catch((e) => {
      setLink('error');
      clear(host);
      host.appendChild(h('div', { class: 'alert bad', text: messageOf(e) }));
    });
  return wrap;
}

// ── Library ─────────────────────────────────────────────────────────────────

let libraryFilter = { q: '', domain: null };

function viewLibrary() {
  const wrap = h('div', {});
  const host = h('div', {});
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search capabilities\u2026', 'aria-label': 'Search the catalog', value: libraryFilter.q });
  wrap.appendChild(search);
  wrap.appendChild(host);

  let all = null;

  const paint = () => {
    clear(host);
    if (!all) { host.appendChild(skeleton('list')); return; }
    const q = libraryFilter.q.trim().toLowerCase();
    const filtered = all.entries.filter((e) => {
      if (libraryFilter.domain && e.domain !== libraryFilter.domain) return false;
      if (!q) return true;
      return (e.id + ' ' + e.name + ' ' + e.family + ' ' + e.domain).toLowerCase().includes(q);
    });

    if (!all.load.ok) {
      host.appendChild(h('div', { class: 'alert', text: 'Skill packs did not load: ' + all.load.reason }));
    }
    const dom = h('div', { class: 'chips' }, [
      h('button', { class: 'chip', type: 'button', text: 'All ' + all.entries.length, 'aria-pressed': String(!libraryFilter.domain), onclick: () => { libraryFilter.domain = null; HAPTIC.select(); paint(); } }),
    ]);
    for (const d of all.domains) {
      dom.appendChild(h('button', {
        class: 'chip', type: 'button', text: d.label + ' ' + d.entries, 'aria-pressed': String(libraryFilter.domain === d.id),
        onclick: () => { libraryFilter.domain = libraryFilter.domain === d.id ? null : d.id; HAPTIC.select(); paint(); },
      }));
    }
    host.appendChild(dom);

    host.appendChild(header(filtered.length + ' of ' + all.entries.length + ' \u00b7 packs from ' + all.load.source));
    if (!filtered.length) {
      host.appendChild(emptyState('\u2261', 'Nothing matches "' + libraryFilter.q + '".', 'Clear search', () => { libraryFilter.q = ''; search.value = ''; paint(); }));
      return;
    }
    let currentDomain = null;
    let card = null;
    for (const e of filtered) {
      if (e.domain !== currentDomain) {
        currentDomain = e.domain;
        const label = (all.domains.find((d) => d.id === e.domain) || {}).label || e.domain;
        host.appendChild(header(label));
        card = h('div', { class: 'card' });
        host.appendChild(card);
      }
      const right = h('span', { class: 'grow', style: 'flex:0 0 auto' }, [
        e.hasPlaybook ? tag(e.mut || 'route') : null,
        e.hasPack ? tag(e.questions + 'q') : null,
      ]);
      const el = row(e.id, e.family + ' \u00b7 ' + (e.hasPlaybook && e.hasPack ? e.probes + ' probe(s) + method' : e.hasPlaybook ? e.probes + ' probe(s)' : 'methodology only'), right, () => {
        HAPTIC.select();
        go('/library/' + e.id);
      });
      if (card) card.appendChild(el);
    }
  };

  if (cache.has('/api/ui/catalog')) {
    all = cache.get('/api/ui/catalog').value;
    paint();
  } else {
    paint();
    api('/api/ui/catalog')
      .then((v) => { all = v; cache.set('/api/ui/catalog', { at: Date.now(), value: v }); setLink('live'); paint(); })
      .catch((e) => { setLink('error'); clear(host); host.appendChild(h('div', { class: 'alert bad', text: messageOf(e) })); });
  }

  search.addEventListener('input', () => { libraryFilter.q = search.value; paint(); });
  return wrap;
}

function viewLibraryDetail(id) {
  const wrap = h('div', {});
  const host = h('div', {});
  wrap.appendChild(host);
  const cached = cache.get('/api/ui/catalog');
  const entry = cached ? cached.value.entries.find((e) => e.id === id) : null;
  if (entry) host.appendChild(libraryEntryCard(entry, cached.value));
  else host.appendChild(skeleton('card'));
  if (!cached) {
    api('/api/ui/catalog')
      .then((v) => {
        cache.set('/api/ui/catalog', { at: Date.now(), value: v });
        clear(host);
        const found = v.entries.find((e) => e.id === id);
        host.appendChild(found ? libraryEntryCard(found, v) : h('div', { class: 'alert bad', text: 'No capability with id ' + id + ' in this build.' }));
      })
      .catch((e) => { setLink('error'); clear(host); host.appendChild(h('div', { class: 'alert bad', text: messageOf(e) })); });
  }
  return wrap;
}

function libraryEntryCard(e, catalog) {
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', { class: 'card-title', text: e.name }));
  card.appendChild(h('div', { class: 'card-sub', text: e.id + ' \u00b7 ' + e.family }));
  const dl = h('dl', { class: 'kv' });
  const label = (catalog.domains.find((d) => d.id === e.domain) || {}).label || e.domain;
  for (const [k, v] of [
    ['domain', label],
    ['class', e.cls],
    ['routing', e.hasPlaybook ? 'playbook' : 'no playbook in this build'],
    ['mutability', e.mut],
    ['probes', e.hasPlaybook ? String(e.probes) : null],
    ['needs approval', e.hasPlaybook ? (e.needsApproval ? 'yes' : 'no') : null],
    ['method pack', e.hasPack ? 'v' + (e.packVersion || '?') + ' \u00b7 ' + e.questions + ' question(s)' : 'none'],
  ]) {
    if (v === null || v === undefined) continue;
    dl.appendChild(h('dt', { text: k }));
    dl.appendChild(h('dd', { text: String(v) }));
  }
  card.appendChild(h('div', {}, [dl]));

  if (e.proof) {
    card.appendChild(header('what a proof has to show'));
    card.appendChild(h('div', { class: 'note', text: e.proof }));
  }
  if (e.requires && e.requires.length) {
    card.appendChild(header('preconditions'));
    const ul = h('ul', { class: 'steps' });
    for (const r of e.requires) ul.appendChild(h('li', { text: r }));
    card.appendChild(ul);
  }

  const actions = h('div', { class: 'actions' });
  actions.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Copy id', onclick: () => copyText(e.id, 'Copied ' + e.id) }));
  actions.appendChild(h('button', { class: 'btn go', type: 'button', text: 'Hunt this', onclick: () => { HAPTIC.select(); go('/hunt'); sayEl.value = e.id; sayEl.focus(); growComposer(); } }));
  card.appendChild(actions);
  card.appendChild(h('div', { class: 'note', text: 'Hunting this class means giving the compiler a target for it; the id goes in the text and the router picks it up.' }));
  return card;
}

// ── Ops ─────────────────────────────────────────────────────────────────────

function opsRouteFor(id) {
  const list = (S.opsList && S.opsList.length ? S.opsList : null) || [];
  const found = list.find((o) => o.id === id);
  return found ? found.route : null;
}

function viewOps() {
  const wrap = h('div', {});
  const list = S.opsList && S.opsList.length ? S.opsList : [];
  if (!list.length) {
    wrap.appendChild(h('div', { class: 'alert', text: 'The navigation model did not load, so the surfaces cannot be listed. Reopen the console.' }));
    return wrap;
  }
  const groups = [];
  for (const o of list) {
    let g = groups.find((x) => x.id === o.group);
    if (!g) { g = { id: o.group, items: [] }; groups.push(g); }
    g.items.push(o);
  }
  for (const g of groups) {
    wrap.appendChild(header(g.id));
    const card = h('div', { class: 'card' });
    for (const o of g.items) {
      card.appendChild(row(o.label, o.auth ? 'needs your Telegram session' : 'read-only, no session needed', h('span', { text: o.glyph, 'aria-hidden': 'true' }), () => {
        HAPTIC.select();
        go('/ops/' + o.id);
      }));
    }
    wrap.appendChild(card);
  }
  return wrap;
}

function viewOpsDetail(id) {
  const route = opsRouteFor(id);
  if (!route) {
    return h('div', { class: 'alert bad', text: 'No surface named ' + id + ' in this build.' });
  }
  const label = ((S.opsList || []).find((o) => o.id === id) || {}).label || id;
  return swr(route, RENDERERS[id] || ((v) => h('div', { class: 'card' }, [jsonBlock(v)])), { label });
}

const RENDERERS = {
  status(v) {
    const out = h('div', {});
    out.appendChild(kv([
      ['worker', h('b', { text: v.worker === 'ok' ? '\u25CF alive' : '\u25CB stale' })],
      ['cron', v.cron_last ? ago(v.cron_last) : 'never'],
      ['programs', num(v.programs) + '  (' + num(v.parsed) + ' parsed)'],
      ['huntable', num(v.huntable)],
      ['queue', num(v.queue) + ' proven'],
      ['approvals', num(v.pending) + ' waiting'],
    ]));
    if (v.pending > 0) out.appendChild(h('div', { class: 'alert', text: num(v.pending) + ' approval(s) are waiting in Queue.' }));
    return out;
  },
  targets(v) {
    const out = h('div', {});
    const c = v.counts || {};
    out.appendChild(kv([
      ['targets', num(c.total)],
      ['huntable', h('b', { text: num(c.allowed) })],
      ['with policy', num(c.with_policy)],
      ['parsed', num(c.parsed)],
      ['not mentioned', num(c.not_mentioned)],
      ['prohibited', h('b', { class: 'tag bad', text: num(c.prohibited) })],
      ['unknown', num(c.unknown)],
      ['assets', num(v.assets)],
    ]));
    const list = v.targets || [];
    if (!list.length) { out.appendChild(emptyState('\u25CE', 'No targets collected yet.', 'Seed one from the chat', () => go('/hunt'))); return out; }
    out.appendChild(header(list.length + ' shown'));
    const card = h('div', { class: 'card' });
    for (const t of list) {
      const kind = t.automation === 'allowed' ? 'ok' : t.automation === 'prohibited' ? 'bad' : 'warn';
      card.appendChild(row(
        t.id,
        [t.reward, t.status, t.assets ? t.assets + ' asset(s)' : null, t.policy_url ? 'policy on file' : 'no policy'].filter(Boolean).join(' \u00b7 '),
        tag(t.automation, kind),
      ));
    }
    out.appendChild(card);
    out.appendChild(h('div', { class: 'note', text: 'A hunt needs a recorded policy anchor. "with policy" is the count that can actually be dispatched.' }));
    return out;
  },
  history(v) {
    const out = h('div', {});
    const t = v.totals || {};
    out.appendChild(kv([
      ['decisions', num(t.decisions)],
      ['approved', num(t.approved)],
      ['denied', num(t.denied)],
      ['hunts', num(t.hunts)],
      ['proven', num(t.proven)],
      ['blocked', num(t.blocked)],
      ['ledger rows', num(v.ledger && v.ledger.count)],
    ]));
    out.appendChild(header('decisions'));
    const dec = v.decisions || [];
    if (!dec.length) out.appendChild(emptyLine('No decisions yet.'));
    else {
      const card = h('div', { class: 'card' });
      for (const d of dec.slice(0, 20)) {
        card.appendChild(row(d.title || d.reason, (d.targets || []).join(', ') + ' \u00b7 ' + stamp(d.decided_at || d.requested_at), tag(d.status, d.status === 'approved' ? 'ok' : d.status === 'denied' ? 'bad' : 'warn')));
      }
      out.appendChild(card);
    }
    out.appendChild(header('hunts'));
    const hunts = v.hunts || [];
    if (!hunts.length) out.appendChild(emptyLine('No hunt rows. A refused dispatch leaves none, by design.'));
    else {
      const card = h('div', { class: 'card' });
      for (const x of hunts) card.appendChild(row((x.program_id || x.repo || x.id) + ' \u00b7 ' + x.stage, 'leads ' + x.leads_n + ' \u00b7 attempts ' + x.attempts_n + ' \u00b7 proven ' + x.proven_n + (x.stopped_because ? ' \u00b7 ' + x.stopped_because : ''), tag(ago(x.created_at))));
      out.appendChild(card);
    }
    if (v.ledger && v.ledger.kinds && v.ledger.kinds.length) {
      out.appendChild(header('ledger kinds'));
      const card = h('div', { class: 'card' });
      for (const k of v.ledger.kinds) card.appendChild(row(k.kind, num(k.n) + ' row(s)', null));
      out.appendChild(card);
    }
    return out;
  },
  findings(v) {
    if (!Array.isArray(v) || !v.length) return emptyState('\u25C6', 'No proven findings yet. Silence is the design.', 'See the queue', () => go('/queue'));
    const card = h('div', { class: 'card' });
    for (const f of v) card.appendChild(row(f.title || '(untitled)', [f.target, f.proof_state, f.status].filter(Boolean).join(' \u00b7 '), h('span', { class: sevClass(f.severity), text: String(f.severity || '').toUpperCase() })));
    return card;
  },
  discovery(v) {
    const out = h('div', {});
    out.appendChild(kv([['allowed', num(v.allowed)], ['not mentioned', num(v.not_mentioned)], ['prohibited', num(v.prohibited)], ['unknown', num(v.unknown)]]));
    out.appendChild(header('recently parsed'));
    const recent = v.recent || [];
    if (!recent.length) out.appendChild(emptyLine('Nothing parsed yet.'));
    else {
      const card = h('div', { class: 'card' });
      for (const p of recent) card.appendChild(row(p.id, [p.reward, p.status, p.automation].filter(Boolean).join(' \u00b7 '), tag(p.automation || 'unknown', p.automation === 'allowed' ? 'ok' : p.automation === 'prohibited' ? 'bad' : 'warn')));
      out.appendChild(card);
    }
    return out;
  },
  watchlist(v) {
    const out = h('div', {});
    const entries = v.entries || [];
    out.appendChild(header('watched (' + entries.length + ')'));
    if (!entries.length) out.appendChild(emptyLine('Nothing on the watchlist.'));
    else {
      const card = h('div', { class: 'card' });
      for (const e of entries) card.appendChild(row(e.label || e.address, String(e.address || '').slice(0, 20) + ' \u00b7 ' + (e.rules || []).length + ' rule(s)', e.last_block ? tag('blk ' + e.last_block) : null));
      out.appendChild(card);
    }
    out.appendChild(header('alerts'));
    const alerts = v.alerts || [];
    if (!alerts.length) out.appendChild(emptyLine('No alerts.'));
    else {
      const card = h('div', { class: 'card' });
      for (const a of alerts) card.appendChild(row(a.rule, (a.detail || '') + (a.block ? ' \u00b7 block ' + a.block : ''), h('span', { class: sevClass(a.severity), text: String(a.severity || '').toUpperCase() })));
      out.appendChild(card);
    }
    return out;
  },
  ledger(v) {
    const out = h('div', {});
    out.appendChild(kv([
      ['chain', v.ok ? h('b', { class: 'tag ok', text: 'verified' }) : h('b', { class: 'tag bad', text: 'FAILED' })],
      ['entries', num(v.count)],
      ['detail', v.detail || '\u2014'],
    ]));
    const recent = v.recent || [];
    if (recent.length) {
      out.appendChild(header('last entries'));
      const card = h('div', { class: 'card' });
      for (const r of recent) card.appendChild(row(r.kind, '#' + r.seq + ' \u00b7 ' + ago(r.ts), tag(String(r.hash || '').slice(0, 8))));
      out.appendChild(card);
    }
    return out;
  },
  eval(v) {
    const keys = Object.keys(v || {});
    if (!keys.length) return emptyLine('No scoreboard stored yet.');
    const out = h('div', {});
    const scalars = keys.filter((k) => typeof v[k] !== 'object');
    if (scalars.length) out.appendChild(kv(scalars.slice(0, 14).map((k) => [k, scalar(k, v[k])])));
    for (const k of keys.filter((x) => typeof v[x] === 'object').slice(0, 4)) {
      out.appendChild(header(k));
      out.appendChild(h('div', { class: 'card' }, [jsonBlock(v[k])]));
    }
    return out;
  },
  desk(v) {
    const out = h('div', {});
    out.appendChild(kv([
      ['mode', h('b', { text: v.mode || '\u2014' })],
      ['armed', v.armed ? h('b', { class: 'tag warn', text: 'ARMED' }) : h('span', { class: 'tag', text: 'paper' })],
      ['equity', money(v.equity)],
      ['open', num(v.open_positions)],
      ['deployed', typeof v.deployed_pct === 'number' ? (v.deployed_pct * 100).toFixed(1) + '%' : '\u2014'],
      ['pnl today', money(v.pnl_today)],
      ['kills today', num(v.kills_today)],
      ['subrequests', num(v.subrequests)],
    ]));
    if (v.breaker_halted) out.appendChild(h('div', { class: 'alert bad', text: 'Circuit breaker halted until ' + stamp(v.breaker_until) }));
    const gates = v.gates || [];
    out.appendChild(header('arming gates (' + (v.gates_unmet || []).length + ' unmet)'));
    const card = h('div', { class: 'card' });
    if (!gates.length) card.appendChild(emptyLine('No gate data.'));
    for (const g of gates) {
      const ok = g && (g.met === true || g.ok === true);
      card.appendChild(row((g && (g.name || g.id || g.gate)) || String(g), (g && (g.detail || g.reason || g.why)) || '', tag(ok ? 'met' : 'unmet', ok ? 'ok' : 'warn')));
    }
    out.appendChild(card);
    if (v.coverage_gaps && v.coverage_gaps.length) {
      out.appendChild(header('coverage gaps'));
      out.appendChild(h('div', { class: 'card' }, [jsonBlock(v.coverage_gaps)]));
    }
    return out;
  },
  positions(v) {
    const list = (v && v.positions) || [];
    const out = h('div', {});
    if (v && v.stale) out.appendChild(h('div', { class: 'alert', text: 'Marks are the last stored price, not live quotes.' }));
    out.appendChild(header(list.length + ' open'));
    if (!list.length) { out.appendChild(emptyLine('No open positions.')); return out; }
    const card = h('div', { class: 'card' });
    for (const p of list) card.appendChild(row(p.symbol || p.mint, 'size ' + money(p.size) + ' \u00b7 entry ' + p.entry + ' \u00b7 stop ' + p.stop, tag(ago(p.opened_at))));
    out.appendChild(card);
    return out;
  },
  kills(v) {
    const list = Array.isArray(v) ? v : [];
    const out = h('div', {});
    out.appendChild(header(list.length + ' kills'));
    if (!list.length) { out.appendChild(emptyLine('No kills recorded.')); return out; }
    const card = h('div', { class: 'card' });
    for (const k of list) card.appendChild(row((k.symbol || k.mint) + '  \u00b7  ' + k.reason_code, (k.detail || '') + (k.outcome ? '  \u00b7 outcome ' + k.outcome : ''), tag(ago(k.ts))));
    out.appendChild(card);
    return out;
  },
  calibration(v) {
    const out = h('div', {});
    out.appendChild(kv([['window', stamp(v.window_start) + ' \u2192 ' + stamp(v.window_end)], ['stored', v.stored ? 'yes' : 'no']]));
    if (v.totals) out.appendChild(kv(Object.keys(v.totals).map((k) => [k, scalar(k, v.totals[k])])));
    out.appendChild(header('by reason'));
    const rows = v.by_reason || [];
    if (!rows.length) { out.appendChild(emptyLine('No calibration rows.')); return out; }
    const card = h('div', { class: 'card' });
    for (const r of rows) card.appendChild(row(r.reason_code, r.description || 'kills ' + r.kills + ' \u00b7 n ' + r.n + ' \u00b7 hit ' + r.hit_rate + ' \u00b7 fn ' + r.false_negatives, r.thin ? tag('thin', 'warn') : tag('ok', 'ok')));
    out.appendChild(card);
    if (v.note) out.appendChild(h('div', { class: 'note', text: v.note }));
    return out;
  },
};

// ── the brief card (Hunt + Queue detail share it) ───────────────────────────

function briefCard(r, opts) {
  const o = opts || {};
  const b = r.brief || {};
  const card = h('div', {});
  card.appendChild(h('div', { class: 'card-title', text: b.title || 'engagement' }));

  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of [
    ['targets', (b.targets || []).join(', ')],
    ['class', b.cls],
    ['mutability', b.max_mutability],
    ['time box', b.time_box_minutes ? b.time_box_minutes + ' min' : null],
    ['authorized by', r.authorizationRef],
  ]) {
    if (v === null || v === undefined || v === '') continue;
    dl.appendChild(h('dt', { text: k }));
    dl.appendChild(h('dd', { text: String(v) }));
  }
  card.appendChild(h('div', { class: 'card' }, [dl]));

  if (b.playbooks && b.playbooks.length) {
    card.appendChild(header('playbooks (' + b.playbooks.length + ')'));
    const tags = h('div', { class: 'card' });
    for (const p of b.playbooks) tags.appendChild(tag(p));
    card.appendChild(tags);
  }
  if (b.stop_condition) {
    card.appendChild(header('stop condition'));
    const n = h('div', { class: 'note', text: b.stop_condition });
    card.appendChild(o.collapseStop === false ? n : clampBlock(b.stop_condition, 3));
  }
  if (b.notes) {
    card.appendChild(header('what you said'));
    card.appendChild(clampBlock(b.notes, 3));
  }
  if (r.enrichment) {
    card.appendChild(h('div', { class: 'card-sub', text: 'intake: ' + (r.enrichment.enriched ? 'model-enriched' : 'deterministic') + (r.enrichment.provider ? ' via ' + r.enrichment.provider : '') + ' \u00b7 ' + (r.enrichment.tokens || 0) + ' tokens \u00b7 ' + (r.enrichment.latencyMs || 0) + 'ms' }));
  }

  const actions = h('div', { class: 'actions' });
  actions.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Copy brief', onclick: () => copyText(JSON.stringify(b, null, 2), 'Brief copied') }));
  if (r.approvalId) {
    const yes = h('button', { class: 'btn go', type: 'button', text: '\u2713  Authorize' });
    const no = h('button', { class: 'btn no', type: 'button', text: '\u2717  Cancel' });
    const state = h('div', { class: 'card-sub' });
    yes.addEventListener('click', () => decide(r.approvalId, true, actions, state));
    no.addEventListener('click', () => decide(r.approvalId, false, actions, state));
    actions.appendChild(yes);
    actions.appendChild(no);
    if (o.inChat) card.appendChild(state);
  } else if (r.approvalId === undefined && o.inChat) {
    actions.appendChild(h('button', { class: 'btn go', type: 'button', text: 'Open Queue', onclick: () => go('/queue') }));
  }
  card.appendChild(actions);
  return card;
}

// ── decide (shared by Queue detail and the brief card) ─────────────────────

/**
 * OPTIMISTIC, WITH ROLLBACK. The buttons and the MainButton go to a deciding
 * state immediately; on failure the previous state is restored and the operator
 * is told. The approve is also the ONE irreversible action in the console, so it
 * asks first - through Telegram's own confirm dialog when there is one.
 */
async function decide(id, approve, actionsEl, stateEl) {
  const ok = await confirmAction(
    approve ? 'Authorize this hunt?' : 'Deny this approval?',
    approve
      ? 'This releases the engagement to the gate. It is recorded in the ledger and cannot be un-sent.'
      : 'This denies the approval. It is recorded in the ledger.',
  );
  if (!ok) { HAPTIC.select(); return; }

  const buttons = Array.from(actionsEl ? actionsEl.querySelectorAll('button') : []);
  const prev = buttons.map((b) => b.disabled);
  for (const b of buttons) b.disabled = true;
  if (stateEl) { stateEl.textContent = 'deciding\u2026'; stateEl.setAttribute('data-state', 'deciding'); }
  setMainButton(null, null);
  setLink('busy');

  try {
    const r = await api('/api/ui/decide', { method: 'POST', body: { id, decision: approve ? 'approve' : 'deny' } });
    S.decisions++;
    setLink('live');
    HAPTIC.ok();
    const outcome = (r && r.outcome) || {};
    const label = approve
      ? (outcome.dispatched ? 'approved \u00b7 dispatched' : 'approved \u00b7 NOT dispatched')
      : 'denied';
    if (stateEl) {
      stateEl.textContent = label + (outcome.reason ? ' (' + outcome.reason + ')' : '');
      stateEl.setAttribute('data-state', approve ? 'approved' : 'denied');
    }
    if (actionsEl) {
      clear(actionsEl);
      actionsEl.appendChild(tag(label, approve && outcome.dispatched ? 'ok' : approve ? 'warn' : 'bad'));
      if (outcome.reason) actionsEl.appendChild(tag(outcome.reason));
    }
    for (const m of (r && r.messages) || []) {
      const line = stripTags(m);
      if (line.trim()) toast(line, approve ? 'ok' : null);
    }
    toast(label, approve ? 'ok' : null);
    cache.delete('/api/ui/work');
    updateBadges();
    if (S.tab === 'queue') setTimeout(() => renderRoute(), 500);
  } catch (e) {
    setLink('error');
    HAPTIC.err();
    // ROLLBACK: put the buttons back exactly as they were.
    buttons.forEach((b, i) => { b.disabled = prev[i]; });
    if (stateEl) { stateEl.textContent = ''; stateEl.setAttribute('data-state', 'error'); }
    toast(messageOf(e), 'bad');
  }
}

function hideBadges() {
  for (const el of tabsEl.querySelectorAll('[data-badge]')) el.hidden = true;
}

function updateBadges(counts) {
  // Signed out there are no counts to show, and a stale badge from an earlier
  // session would imply work is waiting.
  if (!S.signedIn) { hideBadges(); return; }
  const pending = counts && typeof counts.pending === 'number' ? counts.pending : null;
  if (pending !== null) S.pending = pending;
  const open = readQuestions().length;
  const badge = (tab, n) => {
    const el = tabsEl.querySelector('.tab[data-tab="' + tab + '"] [data-badge]');
    if (!el) return;
    if (n > 0) { el.textContent = n > 99 ? '99+' : String(n); el.hidden = false; }
    else { el.hidden = true; }
  };
  badge('queue', typeof S.pending === 'number' ? S.pending : 0);
  badge('ask', open);
}

// ── composer wiring ─────────────────────────────────────────────────────────

composerEl.addEventListener('submit', (e) => {
  e.preventDefault();
  HAPTIC.tap();
  submitComposer();
});

sayEl.addEventListener('input', growComposer);

sayEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composerEl.dispatchEvent(new Event('submit', { cancelable: true }));
  }
});

backEl.addEventListener('click', () => { HAPTIC.select(); goBack(); });

tabsEl.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.tab') : null;
  if (!btn) return;
  HAPTIC.select();
  go('/' + btn.getAttribute('data-tab'));
});

globalThis.addEventListener('hashchange', renderRoute);

// ── boot ────────────────────────────────────────────────────────────────────

function applyServerNav(session) {
  // The server owns the navigation model. HTML carries the five destinations so
  // the first paint has the final geometry; this reconciles the labels and adds
  // anything the server has that the markup does not.
  const tabs = (session && session.tabs) || [];
  for (const t of tabs) {
    let btn = tabsEl.querySelector('.tab[data-tab="' + t.id + '"]');
    if (!btn) {
      btn = h('button', { class: 'tab', type: 'button', role: 'tab', 'data-tab': t.id, 'aria-selected': 'false' }, [
        h('span', { class: 'tg', 'aria-hidden': 'true', text: t.glyph }),
        h('span', { class: 'tl', text: t.label }),
        h('span', { class: 'badge', 'data-badge': '', hidden: true }),
      ]);
      tabsEl.appendChild(btn);
    } else {
      const gl = btn.querySelector('.tg');
      const lb = btn.querySelector('.tl');
      if (gl && t.glyph) gl.textContent = t.glyph;
      if (lb && t.label) lb.textContent = t.label;
    }
  }
  tabsEl.style.gridTemplateColumns = 'repeat(' + Math.max(1, tabsEl.children.length) + ', 1fr)';
  S.opsList = (session && session.ops) || [];
}

async function boot() {
  initPlatform();
  applyTheme();

  // Read the launch parameters BEFORE the first request, so the fragment is
  // stripped and remembered even when the request itself fails.
  forgetLaunchFragment();

  let session = null;
  try {
    session = await api('/api/ui/session');
  } catch (e) {
    noteError('session', messageOf(e));
  }

  applySession(session);

  const parts = pathParts();
  if (!parts.length) go('/hunt', { replace: true });
  else renderRoute();

  // Keep the two surfaces that change on their own honest, and only while the
  // tab is actually visible and the operator is looking at them.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!S.signedIn) return;
    const parts2 = pathParts();
    const tab = parts2[0];
    if (tab === 'queue') { cache.delete('/api/ui/work'); renderRoute(); }
    if (tab === 'ops' && parts2[1] === 'status') { cache.delete(opsRouteFor('status')); renderRoute(); }
  }, 20000);

  S.ready = true;
}

boot().catch((e) => {
  noteError('boot', (e && e.message) || e);
  setLink('error');
  clear(viewEl);
  viewEl.appendChild(h('div', { class: 'alert bad', text: 'The console failed to start: ' + ((e && e.message) || e) }));
});
