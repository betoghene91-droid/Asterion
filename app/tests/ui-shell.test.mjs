/**
 * The frontend's behaviour contracts.
 *
 * These are assertions about the SERVED BYTES, because that is the only thing the
 * Worker ships - there is no build step between app/ui and the browser. They exist
 * because each of them was a real defect in the first version of this console:
 *
 *   - it used almost none of the Telegram platform (no themeParams, no
 *     colorScheme, no viewport, no BackButton, no MainButton, no haptics, no
 *     showConfirm), so it looked like a web page wearing a Telegram costume;
 *   - its palette was hardcoded dark, so it fought the user's own theme;
 *   - it had exactly one arrangement, a chat stream, for work of six different
 *     kinds;
 *   - it wrote values with `innerHTML`.
 *
 * The browser verification (browser/evidence.json) proves the rendered result.
 * This file pins the source of that result, so a later edit cannot quietly
 * reintroduce the old shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { UI_ASSETS } from '../build/ui/embed.js';

const asset = (n) => (UI_ASSETS.find((a) => a.name === n) || {}).body || '';
const HTML = asset('index.html');
const CSS = asset('ui.css');
const JS = asset('ui.js');

// ── platform-native craft ──────────────────────────────────────────────────

test('the shell drives the Telegram platform, not just the initData string', () => {
  for (const call of [
    'ready',
    'expand',
    'disableVerticalSwipes',
    'setHeaderColor',
    'setBackgroundColor',
    'themeParams',
    'colorScheme',
    'viewportStableHeight',
    'viewportHeight',
    'BackButton',
    'MainButton',
    'HapticFeedback',
    'showConfirm',
  ]) {
    assert.ok(JS.includes(call), `the shell must use ${call}()`);
  }
});

test('every SDK call is feature-detected, so the same file runs in a plain browser', () => {
  // The one wrapper every call goes through.
  assert.match(JS, /function tg\(method, \.\.\.args\)/);
  assert.match(JS, /typeof TG\[method\] !== 'function'/);
  // No bare `Telegram.WebApp.` chain that would throw where the SDK is absent.
  assert.ok(!/Telegram\.WebApp\.\w+\(/.test(JS), 'SDK calls must go through the guarded wrapper');
});

test('platform failures are counted, so the verification can prove usage', () => {
  // The browser run asserts these are non-zero after real interaction.
  for (const field of ['ready', 'expanded', 'verticalSwipesDisabled', 'backButton', 'mainButton', 'haptics', 'confirms']) {
    assert.ok(JS.includes(field), `platform.${field} must be recorded`);
  }
});

// ── theme ──────────────────────────────────────────────────────────────────

test('colour is inherited from Telegram first and defaulted second', () => {
  // Telegram Web and the desktop clients publish these on the document.
  const uses = CSS.match(/var\(--tg-theme-[a-z-]+/g) || [];
  assert.ok(uses.length >= 8, `expected the surface tokens to read --tg-theme-*, found ${uses.length}`);
  for (const token of ['bg-color', 'text-color', 'hint-color', 'button-color', 'button-text-color', 'link-color']) {
    assert.ok(CSS.includes('--tg-theme-' + token), token);
  }
});

test('the stylesheet has a real light scheme, not only a dark one', () => {
  assert.match(CSS, /@media \(prefers-color-scheme: light\)/);
  assert.match(CSS, /\[data-scheme="light"\]/);
  // Severity has no Telegram token and a dark-tuned yellow is unreadable on
  // white, so it is re-tuned per scheme rather than left as-is.
  const lightBlock = CSS.slice(CSS.indexOf('[data-scheme="light"]'));
  assert.match(lightBlock.slice(0, 400), /--crit:/);
  assert.match(lightBlock.slice(0, 400), /--med:/);
});

test('the viewport comes from Telegram so the keyboard cannot break the layout', () => {
  assert.match(CSS, /--tg-viewport-stable-height/);
  assert.match(CSS, /env\(safe-area-inset-bottom\)/);
  assert.match(CSS, /env\(safe-area-inset-top\)/);
});

// ── arrangement ────────────────────────────────────────────────────────────

test('the tab bar is in the markup, so the first paint already has its geometry', () => {
  const tabs = [...HTML.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['hunt', 'queue', 'ask', 'library', 'ops']);
  assert.match(HTML, /role="tablist"/);
  assert.equal((HTML.match(/role="tab"/g) || []).length, 5);
});

test('drill-down exists: the router has a depth and a back affordance', () => {
  assert.match(JS, /function pathParts\(\)/);
  assert.match(JS, /S\.depth = rest\.length/);
  assert.match(JS, /function setBack\(visible\)/);
  assert.match(JS, /function goBack\(\)/);
  // In-page back as well, for hosts with no BackButton.
  assert.match(HTML, /id="back"/);
});

test('the six kinds of work each have their own view', () => {
  for (const fn of ['viewHunt', 'viewQueue', 'viewQueueDetail', 'viewAsk', 'viewLibrary', 'viewLibraryDetail', 'viewOps', 'viewOpsDetail']) {
    assert.ok(JS.includes('function ' + fn), fn);
  }
});

test('follow-up questions are answerable, and the queue survives a reload', () => {
  // The Telegram chat cannot answer these at all (no `ans` case in routeButton),
  // so this is the only working path and it must not be lost on reload.
  assert.match(JS, /asterion\.questions\.v1/);
  assert.match(JS, /localStorage/);
  assert.match(JS, /function resolveQuestion/);
  assert.match(JS, /function answerQuestion/);
});

// ── craft bar ──────────────────────────────────────────────────────────────

test('the console writes no API value as markup', () => {
  assert.equal(
    (JS.match(/\.innerHTML\s*=/g) || []).length,
    0,
    'the console must build DOM, never parse a string into it',
  );
  assert.ok(!/\bhtml\s*:/.test(JS), 'no element may be built from an html prop');
  assert.ok((JS.match(/\.textContent\s*=/g) || []).length >= 5, 'values go through textContent');
  assert.ok(JS.includes('createElement'), 'elements are created, not parsed');
});

test('long values are collapsed rather than dumped', () => {
  assert.match(JS, /function clampBlock/);
  assert.match(CSS, /\.clamp\[data-clamped="1"\]/);
});

test('empty states teach and offer one tap', () => {
  assert.match(JS, /function emptyState/);
  assert.match(CSS, /\.empty-state/);
});

test('the approve is optimistic with rollback, not a blocking spinner', () => {
  assert.match(JS, /ROLLBACK/);
  assert.match(JS, /b\.disabled = prev\[i\]/);
});

test('feedback is a toast, never an alert()', () => {
  assert.ok(!/\balert\s*\(/.test(JS), 'the console must not use a native alert');
  assert.ok(!/\bconfirm\s*\(/.test(JS), 'and not a native confirm either');
  assert.match(JS, /function toast\(/);
  assert.match(CSS, /\.toast/);
});

test('touch targets and focus rings meet the bar', () => {
  assert.match(CSS, /min-height: 44px/);
  assert.match(CSS, /min-height: 56px/);
  assert.match(CSS, /:focus-visible/);
});

test('motion is opt-out and the skeletons match the real layout', () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(JS, /function skeleton\(/);
  assert.match(CSS, /\.sk-card/);
});

test('the four tab tokens and the type/spacing scales are tokens, not magic numbers', () => {
  for (const t of ['--s1:', '--s2:', '--s3:', '--s4:', '--fs-xs:', '--fs-md:', '--fs-lg:', '--r:']) {
    assert.ok(CSS.includes(t), t);
  }
});

// ── wiring ─────────────────────────────────────────────────────────────────

test('the console talks to the routes this Worker serves, and no others', () => {
  const paths = [...JS.matchAll(/['"](\/api\/[A-Za-z0-9/_-]*)['"]/g)].map((m) => m[1]);
  assert.ok(paths.length > 0);
  for (const p of paths) assert.match(p, /^\/api\//);
  for (const p of ['/api/ui/session', '/api/ui/engage', '/api/ui/decide', '/api/ui/work']) {
    assert.ok(JS.includes(p), `the console must call ${p}`);
  }
  // catalog / targets / history arrive as Ops routes in the session payload, so a
  // new surface is a server-side change, not a client-side one.
  assert.match(JS, /S\.opsList/);
});

test('the telegram stand-in used by the harness is still injectable', () => {
  // The browser verification serves the real bytes with a stub host. That only
  // works if the fallback exists.
  assert.match(JS, /ASTERION_INIT_DATA/);
  assert.match(JS, /window\.Telegram|globalThis\.Telegram/);
});

test('the console reports its own state for verification', () => {
  assert.match(JS, /__ASTERION/);
  assert.match(JS, /unhandledrejection/);
  assert.match(JS, /addEventListener\('error'/);
  for (const field of ['ready', 'signedIn', 'errors', 'viewsVisited', 'fetches']) {
    assert.ok(JS.includes(field), field);
  }
});

test('the one irreversible action asks first', () => {
  // showConfirm is called from exactly the approve path, through confirmAction.
  assert.match(JS, /function confirmAction/);
  const decideBody = JS.slice(JS.indexOf('async function decide('));
  assert.match(decideBody.slice(0, 400), /await confirmAction\(/);
});
