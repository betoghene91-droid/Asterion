/**
 * The two desk screens, rendered.
 *
 * The API tests next door prove the SQL and the payload shape. This one proves
 * the other half: that the shipped ui.js, given that payload, actually paints —
 * and that a very specific historical failure does not come back. The old
 * Watchlist panel read a table nothing wrote to and rendered an empty list; a
 * payload-shape test would have passed, because the payload was correctly empty.
 *
 * No DOM library is installed, so this runs ui.js against a ~70-line shim that
 * implements only what the renderers touch: createElement, textContent,
 * appendChild, setAttribute, classList-free className, and querySelector on the
 * handful of ids the boot path looks up. That is enough to execute the real
 * renderer functions, because they are written with createElement and
 * textContent only — the file's own header states there is not a single
 * innerHTML assignment in it, which is exactly what makes this harness honest.
 *
 * Deliberately NOT tested here: network, Telegram SDK, haptics, routing. Those
 * are covered by ui-launch and ui-api. This file is about pixels becoming text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = readFileSync(join(HERE, '..', 'ui', 'ui.js'), 'utf8');

// ── the shim ────────────────────────────────────────────────────────────────

class ShimNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
    this.parentNode = null;
    this.hidden = false;
    this.disabled = false;
    this.style = { cssText: '' };
    this.dataset = {};
  }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(child) {
    if (child === null || child === undefined) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    return child;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get className() { return this.attrs.class ?? ''; }
  set className(v) { this.attrs.class = String(v); }
  // A flat text dump is all the assertions need, and it catches the thing that
  // matters: whether a value reached the screen or vanished into a null.
  flat() {
    return [this.textContent, ...this.children.map((c) => c.flat())].join(' ');
  }
}

function makeDocument() {
  const byId = new Map();
  function el(tag) { return new ShimNode(tag); }
  // Exactly the ids ui.js resolves at load. Taken from the const block in
  // ui.js (`viewEl`, `tabsEl`, `linkEl`, `linkTextEl`, `titleEl`, ...), not
  // guessed: 'title' here is a guess that was wrong, the real one is 'bar-title'.
  const ids = [
    'view', 'tabs', 'link', 'link-text', 'bar-title', 'back', 'composer', 'say',
    'send', 'toasts', 'sheet', 'mainbutton', 'hint', 'sheet-title', 'sheet-body',
    'sheet-ok', 'sheet-cancel',
  ];
  for (const id of ids) {
    const n = el('div');
    n.id = id;
    byId.set(id, n);
  }
  return {
    readyState: 'complete',
    title: '',
    body: el('body'),
    documentElement: el('html'),
    createElement: el,
    createTextNode: (t) => { const n = new ShimNode('#text'); n._text = String(t); return n; },
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) => (sel && sel.startsWith('#') ? byId.get(sel.slice(1)) ?? null : null),
    querySelectorAll: () => [],
    addEventListener() {},
    visibilityState: 'visible',
    execCommand() { return true; },
  };
}

/** Run ui.js in a fresh sandbox and return the globals it created. */
function loadUi() {
  const document = makeDocument();
  const storage = new Map();
  const pending = [];
  const sandbox = {
    document,
    location: { hash: '', search: '', pathname: '/ui', href: 'https://x/ui' },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    localStorage: {
      getItem: (k) => (storage.has('L:' + k) ? storage.get('L:' + k) : null),
      setItem: (k, v) => storage.set('L:' + k, String(v)),
      removeItem: (k) => storage.delete('L:' + k),
    },
    setTimeout: (fn) => { pending.push(fn); return pending.length; },
    clearTimeout() {},
    setInterval: () => 0,
    fetch: async () => { throw new Error('no network in this harness'); },
    AbortController,
    URLSearchParams,
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};

  // `Node` is passed in because ui.js does `x instanceof Node` in a few guards.
  // Without it those guards run against node:test's own Node and the shim's
  // elements fail the check, which is a harness bug, not a renderer bug.
  const fn = new Function('globalThis', 'window', 'document', 'location', 'history',
    'navigator', 'sessionStorage', 'localStorage', 'setTimeout', 'clearTimeout',
    'setInterval', 'fetch', 'AbortController', 'URLSearchParams', 'console', 'Node',
    `${UI}\n;return { viewFns: (typeof RENDERERS !== 'undefined' ? RENDERERS : null),
      spark: (typeof sparkline !== 'undefined' ? sparkline : null),
      S: (typeof S !== 'undefined' ? S : null) };`);

  const api = fn(sandbox, sandbox, document, sandbox.location, sandbox.history,
    sandbox.navigator, sandbox.sessionStorage, sandbox.localStorage, sandbox.setTimeout,
    sandbox.clearTimeout, sandbox.setInterval, sandbox.fetch, AbortController,
    URLSearchParams, console, ShimNode);
  return { ...api, document, pending };
}

/**
 * Let boot()'s promises settle, then run any timers it queued. The file's boot
 * path is asynchronous and the renderer table is available synchronously, so a
 * test that asserts and returns immediately leaves a rejected promise behind —
 * which node:test attributes to whichever test happens to be running. Draining
 * it here is the difference between a real failure and a harness artifact.
 */
async function settle(ui) {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
  for (const fn of ui.pending.splice(0)) {
    try { fn(); } catch { /* boot timers are not under test */ }
  }
  await new Promise((r) => setImmediate(r));
}

// ── tests ───────────────────────────────────────────────────────────────────

test('ui.js evaluates against the shim and exposes the renderer table', async () => {
  const ui = loadUi();
  await settle(ui);
  const { viewFns } = ui;
  assert.ok(viewFns, 'RENDERERS must exist');
  assert.equal(typeof viewFns.trade, 'function', 'the Trade renderer must be registered');
  assert.equal(typeof viewFns['targets-hunt'], 'function', 'the Hunt-targets renderer must be registered');
});

test('the Trade renderer paints equity, net, stats, curve and both ledgers', async () => {
  const ui = loadUi();
  await settle(ui);
  const { viewFns } = ui;
  const payload = {
    mode: 'paper',
    armed: false,
    equity: 1020.5,
    stale: true,
    gates_unmet: ['paper_trades', 'paper_days'],
    stats: { trades: 3, wins: 2, losses: 1, win_rate: 0.6667, profit_factor: 3, net: 20 },
    open: [{ symbol: 'DDD', size: 50, entry: 2, stop: 1.7, peak: 2, trailing: true, opened_at: 1700000000 }],
    closed: [{ symbol: 'AAA', pnl: 20, pnl_pct: 0.2, exit_reason: 'trail', closed_at: 1700000100 }],
    curve: [{ at: 1, equity: 20 }, { at: 2, equity: 30 }, { at: 3, equity: 20 }],
  };
  const out = viewFns.trade(payload);
  const text = out.flat();

  assert.match(text, /\$1,020\.5/, 'equity is printed as money');
  assert.match(text, /\$20/, 'net is printed');
  assert.match(text, /66\.7%/, 'win rate is a percentage, not a raw fraction');
  assert.match(text, /3/, 'profit factor appears');
  assert.match(text, /DDD/, 'the open position symbol reaches the screen');
  assert.match(text, /trailing/, 'a trailed stop is labelled as such');
  assert.match(text, /AAA/, 'the closed trade symbol reaches the screen');
  assert.match(text, /paper/, 'mode is shown while unarmed');
  assert.match(text, /paper_trades/, 'the unmet gate is named, not just counted');

  // The curve is bars, not text: three points must become three drawn columns.
  const bars = [];
  (function walk(n) {
    if (n.className && /spark-bar/.test(n.className)) bars.push(n);
    for (const c of n.children) walk(c);
  })(out);
  assert.equal(bars.length, 3, 'one bar per closed trade');
  assert.ok(bars.every((b) => /height:\s*[\d.]+%/.test(b.attrs.style ?? '')), 'each bar has a height');
});

test('the Trade renderer says why an empty desk is empty instead of showing zeros alone', async () => {
  const ui = loadUi();
  await settle(ui);
  const { viewFns } = ui;
  const out = viewFns.trade({
    mode: 'paper', armed: false, equity: 1000, stale: true, gates_unmet: [],
    stats: { trades: 0, wins: 0, losses: 0, win_rate: null, profit_factor: null, net: 0 },
    open: [], closed: [], curve: [],
  });
  const text = out.flat();
  assert.match(text, /No closed trades yet/, 'the empty curve explains itself');
  assert.match(text, /Flat\. Nothing at risk/, 'the empty book says so in words');
  assert.match(text, /No exits yet/, 'the empty ledger says so in words');
});

test('the Hunt-targets renderer paints the tally, the score and the reason', async () => {
  const ui = loadUi();
  await settle(ui);
  const { viewFns } = ui;
  const payload = {
    total: 2,
    tally: { passed: 1, scored: 0, in: 0, killed: 1, expired: 0 },
    targets: [
      { symbol: 'GOOD', mint: 'm1', dex: 'raydium', mcap: 500000, liquidity: 60000,
        volume_24h: 200000, holders: 900, price: 0.01, age_seconds: 7200,
        seen: 1700000200, state: 'passed', score: null, score_passed: null, why: '' },
      { symbol: 'BAD', mint: 'm2', dex: 'orca', mcap: 900000, liquidity: 5000,
        volume_24h: 1000, holders: 12, price: 0.02, age_seconds: 7200,
        seen: 1700000200, state: 'killed', score: 41, score_passed: false,
        why: 'liquidity below the mcap-relative floor' },
    ],
  };
  const out = viewFns['targets-hunt'](payload);
  const text = out.flat();

  assert.match(text, /GOOD/, 'the passed token is listed');
  assert.match(text, /BAD/, 'the killed token is listed');
  assert.match(text, /41\/100/, 'the score is shown as a score, not a bare number');
  assert.match(text, /liquidity below the mcap-relative floor/, 'the why line reaches the screen');
  assert.match(text, /\$60,000/, 'liquidity is formatted as money');
  assert.match(text, /holders/, 'the holder count is labelled');
  assert.match(text, /passed, tradeable now/, 'groups are named in pipeline order');
  assert.match(text, /killed/, 'the killed group exists');
});

test('the Hunt-targets renderer explains an empty universe rather than showing a blank page', async () => {
  const ui = loadUi();
  await settle(ui);
  const { viewFns } = ui;
  const out = viewFns['targets-hunt']({
    total: 0, tally: { passed: 0, scored: 0, in: 0, killed: 0, expired: 0 }, targets: [],
  });
  const text = out.flat();
  assert.match(text, /universe is empty/, 'an empty universe says so');
  assert.match(text, /5-minute cron/, 'and explains the tick, which is the actual cause');
});

test('a null score does not print as a number, and does not throw', async () => {
  const ui = loadUi();
  await settle(ui);
  const { viewFns } = ui;
  const out = viewFns['targets-hunt']({
    total: 1, tally: { passed: 1, scored: 0, in: 0, killed: 0, expired: 0 },
    targets: [{ symbol: 'X', mint: 'm', dex: '', mcap: 0, liquidity: 0, volume_24h: 0,
      holders: 0, price: 0, age_seconds: 0, seen: 0, state: 'passed',
      score: null, score_passed: null, why: '' }],
  });
  const text = out.flat();
  assert.match(text, /X/);
  assert.doesNotMatch(text, /NaN|undefined|null/, 'a missing score must never render as NaN or undefined');
});
