/**
 * The embedded Mini App must MATCH THE SOURCES and must be safe to serve.
 *
 * This file is about integrity only: the generated module is byte-equal to what
 * the generator produces from app/ui, and no asset name can traverse. The
 * frontend's own behaviour contracts live in ui-shell.test.mjs.
 *
 * The failure this pins is drift: edit app/ui/ui.js, forget to regenerate, and
 * the deployed Worker serves the OLD console while every local check passes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UI_ASSETS } from '../build/ui/embed.js';
import { UI_FILES, readSources, renderEmbed } from '../scripts/build-ui-embed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const UI_DIR = join(APP, 'ui');

const byName = (n) => UI_ASSETS.find((a) => a.name === n);

test('the three shell assets are embedded, with real MIME types', () => {
  assert.deepEqual(
    UI_ASSETS.map((a) => a.name),
    ['index.html', 'ui.css', 'ui.js'],
    'asset names are also the served filenames, so their order and spelling matter',
  );
  assert.match(byName('index.html').contentType, /text\/html/);
  assert.match(byName('ui.css').contentType, /text\/css/);
  assert.match(byName('ui.js').contentType, /javascript/);
  for (const a of UI_ASSETS) {
    assert.ok(a.bytes > 0, a.name);
    assert.equal(a.bytes, Buffer.byteLength(a.body, 'utf8'), `${a.name} byte count is wrong`);
  }
});

test('every embedded body is byte-identical to its source file', () => {
  for (const f of UI_FILES) {
    const disk = readFileSync(join(UI_DIR, f.file), 'utf8');
    const embedded = byName(f.name);
    assert.ok(embedded, `${f.name} is not embedded`);
    assert.equal(
      embedded.body,
      disk,
      `${f.name} in src/ui/embed.ts does not match app/ui/${f.file} - run: node scripts/build-ui-embed.mjs`,
    );
  }
});

test('regeneration is deterministic: the committed embed is exactly what the generator produces', () => {
  const regenerated = renderEmbed(readSources());
  const committed = readFileSync(join(APP, 'src', 'ui', 'embed.ts'), 'utf8');
  assert.equal(
    regenerated,
    committed,
    'src/ui/embed.ts is out of date - run: node scripts/build-ui-embed.mjs',
  );
});

test('regeneration twice in a row is identical, so it cannot churn on every run', () => {
  assert.equal(renderEmbed(readSources()), renderEmbed(readSources()));
});

test('no asset name can traverse: names are bare filenames, never paths', () => {
  for (const a of UI_ASSETS) {
    assert.ok(!a.name.includes('/'), a.name);
    assert.ok(!a.name.includes('\\'), a.name);
    assert.ok(!a.name.includes('..'), a.name);
    assert.match(a.name, /^[A-Za-z0-9._-]+$/);
  }
});

test('the shell loads its own same-origin assets and nothing off-origin', () => {
  const html = byName('index.html').body;
  assert.match(html, /<link rel="stylesheet" href="\/ui\/ui\.css" \/>/);
  assert.match(html, /<script src="\/ui\/ui\.js" type="module"><\/script>/);
  // No CDN, no remote font, no inline handler (the CSP forbids all three).
  assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), 'no absolute URLs belong in the shell');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers: the CSP would block them');
});

test('the CSP the Worker sends still permits exactly this shell', () => {
  const html = byName('index.html').body;
  // Anything the page would need from off-origin would fail the shipped policy.
  for (const url of html.match(/[a-z]+:\/\/[^"')\s]+/g) || []) {
    assert.ok(url.startsWith('/') || url.startsWith('https://telegram.org'), url);
  }
  assert.ok(!/<style[\s>]/i.test(html), 'no inline <style>: style-src allows self, and this keeps it honest');
});
