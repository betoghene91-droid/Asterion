#!/usr/bin/env node
/**
 * tsc emits .js for our TypeScript but does NOT copy the .mjs CLI entry points:
 * they are plain JavaScript outside the compilation graph, so after a clean
 * build the tree would contain no runnable CLI at all.
 *
 * In the unified app there is exactly ONE source root (src/) and ONE build root
 * (build/), so this is a flat copy:
 *
 *   src/plan.mjs   ->  build/plan.mjs    imports ./hunt.js      -> build/hunt.js      OK
 *   src/judge.mjs  ->  build/judge.mjs   imports ./proof.js     -> build/proof.js     OK
 *   src/capture.mjs->  build/capture.mjs imports ./evidence.js  -> build/evidence.js  OK
 *
 * That is the whole reason the two-tree v1/v2 layout needed a path shim, and
 * why every .mjs import in this tree is a plain sibling specifier.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const srcDir = join(app, 'src');
const buildDir = join(app, 'build');

mkdirSync(buildDir, { recursive: true });

let copied = 0;
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith('.mjs')) continue;
  const from = join(srcDir, name);
  if (!statSync(from).isFile()) continue;
  copyFileSync(from, join(buildDir, name));
  copied++;
}

console.log(`copied ${copied} CLI script(s) src/ -> build/`);
