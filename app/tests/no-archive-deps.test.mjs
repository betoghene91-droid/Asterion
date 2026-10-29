/**
 * No-dependency-on-the-archive gate.
 *
 * v1/ and v2/ are MOVED to _archive/ by this refactor. Nothing that ships may
 * depend on them, directly or transitively. The cheapest insurance against that
 * is this file.
 *
 * The trap it exists for is real and it is quiet. In the two-tree layout,
 * `v2/src/hunt.ts` imported `'../../v1/src/corpus.js'`. Flattened into app/src/
 * the naive rewrite of that one specifier is easy to miss, and if it is missed
 * the module can still RESOLVE — because the archived tree is a sibling of app/
 * — so app/ silently depends on _archive/ and the tests stay green. Nothing
 * fails until someone deletes the archive.
 *
 * Scope note: this gate checks IMPORT SPECIFIERS and FILESYSTEM PATH LITERALS,
 * not every occurrence of the substring "v1/". A blanket substring ban would
 * flag `playbooks.ts`'s detect pattern `'/v1/'`, which is an API version path
 * used to recognise endpoints — deleting it would change bot behaviour, which
 * this refactor must not do. Tested against both cases below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SRC = join(APP, 'src');

/** Every shipping source file: app/src (ts + mjs) and app/scripts + app/eval. */
function shippingFiles() {
  const out = [];
  for (const dir of [SRC, join(APP, 'scripts'), join(APP, 'eval')]) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      if (!['.ts', '.mjs', '.js', '.py'].includes(extname(name))) continue;
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so a comment that MENTIONS a historic path is not a failure. */
function stripComments(text, ext) {
  if (ext === '.py') {
    return text.replace(/#[^\n]*/g, '');
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const BANNED = /(^|[\s'"`(=,])(?:\.\.?\/)*(?:_archive|v1|v2)\//;

/**
 * Every call shape that turns a string literal into a filesystem path.
 *
 * A path is not always the FIRST argument (`join(dir, 'v2/x.js')` puts it
 * second), so this captures the whole argument list and the check extracts
 * every string literal inside it. Nested parens are handled by scanning to the
 * matching close rather than a naive `[^)]*`.
 */
const FS_CALL_START = /(?:readFileSync|readdirSync|existsSync|statSync|createReadStream|writeFileSync|open|Path|join|resolve)\s*\(/g;

/** Return every string literal appearing inside a filesystem-call argument list. */
function pathLiterals(text) {
  const out = [];
  for (const m of text.matchAll(FS_CALL_START)) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    const args = text.slice(start, i - 1);
    for (const lit of args.matchAll(/['"]([^'"]+)['"]/g)) out.push(lit[1]);
  }
  return out;
}

test('no shipping file imports from the archived v1/ or v2/ trees', () => {
  const offenders = [];
  for (const file of shippingFiles()) {
    const ext = extname(file);
    const text = stripComments(readFileSync(file, 'utf8'), ext);

    // Only inspect specifiers: `from '...'`, `import('...')`, `require('...')`,
    // and Python `import x` / `from x import`.
    const specifiers = [];
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) specifiers.push(m[1]);
    for (const m of text.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) specifiers.push(m[1]);
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) specifiers.push(m[1]);

    for (const spec of specifiers) {
      if (BANNED.test(spec) || /_archive/.test(spec)) {
        offenders.push(`${relative(APP, file)}: import specifier ${JSON.stringify(spec)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `shipping code imports the archived trees:\n${offenders.join('\n')}`);
});

test('no shipping file resolves a filesystem path into v1/, v2/ or _archive/', () => {
  // Filesystem path literals are the other way to reach the archive without an
  // import — e.g. readFileSync('v1/src/corpus-digest.json'). Catch those.
  const offenders = [];

  for (const file of shippingFiles()) {
    const ext = extname(file);
    const text = stripComments(readFileSync(file, 'utf8'), ext);

    for (const lit of pathLiterals(text)) {
      // A path literal must look like a path, not a URL or a SQL fragment.
      if (!lit.includes('/')) continue;
      if (/^(https?:|\/\/)/.test(lit)) continue;
      if (BANNED.test(lit) || /_archive/.test(lit)) {
        offenders.push(`${relative(APP, file)}: filesystem path ${JSON.stringify(lit)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `shipping code reads from the archived trees:\n${offenders.join('\n')}`);
});

test('the gate actually rejects archive references, and tolerates API-path patterns', () => {
  // A gate nobody has seen fail is not a gate. Both directions are pinned here,
  // and both use the SAME extractors as the two tests above so the self-check
  // cannot drift from what the gate really inspects.
  const extract = (line) => {
    const specs = [...line.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return [...specs, ...pathLiterals(line)];
  };

  const bad = [
    "import { x } from '../../v1/src/corpus.js';",
    "import { y } from './v2/src/hunt.js';",
    "import z from '../_archive/v1/src/send.js';",
    "const d = readFileSync('v1/src/corpus-digest.json', 'utf8');",
    "const p = join(dir, 'v2/src/proof.js');",
    "const q = resolve('_archive/v1/src/index.js');",
  ];
  for (const line of bad) {
    const found = extract(line);
    const hit = found.some((s) => BANNED.test(s) || /_archive/.test(s));
    assert.ok(hit, `the gate would MISS this offence: ${line} (extracted ${JSON.stringify(found)})`);
  }

  const good = [
    "detect: ['/api/', '/v1/', 'id=', 'account', 'tenant', 'org'],",
    "const u = 'https://example.com/api/v1/thing';",
    "import { judge } from './proof.js';",
    "const d = readFileSync('src/corpus-digest.json', 'utf8');",
    "const p = join(HERE, '..', 'src', 'corpus-digest.json');",
  ];
  for (const line of good) {
    const flagged = extract(line).filter((s) => BANNED.test(s) || /_archive/.test(s));
    assert.deepEqual(
      flagged,
      [],
      `the gate would wrongly flag legitimate content: ${line} -> ${JSON.stringify(flagged)}`,
    );
  }
});
