#!/usr/bin/env node
/**
 * Load the distilled corpus digest into D1.
 *
 * The digest is ~1 MB of JSON, well under D1's 2 MB per-value cap. We store it
 * as a single row rather than 400-odd rows because the Worker only ever needs to
 * (a) read priors for a class and (b) retrieve precedent for a lead. Both are
 * cheap json.parse operations on one blob, and neither costs thousands of rows of the
 * 5M/day read budget.
 *
 * HISTORY, NOT CLOBBER
 * --------------------
 * `corpus_digest` is keyed on `version`, and merges (v1/eval/ingest-more.py)
 * bump that version. So loading a merged digest ADDS a row and leaves the
 * previous digest queryable — which is what you want when a merge turns out to
 * have over-weighted a class and you need to diff, or roll back by pointing the
 * Worker at the older version.
 *
 * The Worker reads:
 *     SELECT digest FROM corpus_digest ORDER BY loaded_at DESC LIMIT 1
 * so "newest loaded row wins" is the contract. That contract has one sharp
 * edge this script now handles explicitly: `unixepoch()` has ONE-SECOND
 * resolution, so two digests loaded inside the same second tie on `loaded_at`
 * and the ORDER BY is then ambiguous — SQLite may return either. Loading a new
 * digest immediately after an old one in the same CI step is exactly how that
 * happens. We therefore force the new row's `loaded_at` to be strictly greater
 * than every existing row's, using unixepoch() only as a floor.
 *
 * A re-load of the SAME version is a genuine correction (e.g. the merge was
 * re-run after fixing a mapping), so that one DOES replace, and says so on
 * stderr rather than silently overwriting history.
 *
 * Usage:
 *   node v1/scripts/load-corpus.mjs                    # writes SQL to stdout
 *   node v1/scripts/load-corpus.mjs --apply            # runs wrangler for you
 *   node v1/scripts/load-corpus.mjs --in path.json     # explicit digest
 *   node v1/scripts/load-corpus.mjs --check            # verify invariants, write nothing
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolved from THIS FILE, not from cwd, so `--check` works from any directory.
const CANDIDATES = [
  join(HERE, '..', 'src', 'corpus-digest.json'),
  'src/corpus-digest.json',
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const explicit = arg('--in');
const checkOnly = process.argv.includes('--check');

let digest = null;
let source = null;
const paths = explicit ? [explicit] : CANDIDATES;
for (const p of paths) {
  try {
    digest = JSON.parse(readFileSync(p, 'utf8'));
    source = p;
    break;
  } catch {
    /* next */
  }
}

if (!digest) {
  console.error(
    explicit
      ? `could not read a digest at ${explicit}`
      : 'corpus-digest.json not found. Run: python3 v1/eval/distill.py',
  );
  process.exit(1);
}

// ── validate the shape the Worker relies on before writing anything ─────────
const problems = [];
if (typeof digest.version !== 'string' || !digest.version) problems.push('version must be a non-empty string');
if (!Number.isInteger(digest.source_rows)) problems.push('source_rows must be an integer');
if (!digest.classes || typeof digest.classes !== 'object') problems.push('classes must be an object');
if (!digest.precedent || typeof digest.precedent !== 'object') problems.push('precedent must be an object');

// A digest whose classes disagree with source_rows is a merge bug, and loading
// it would poison every prior the Worker computes. Refuse rather than warn.
if (digest.classes) {
  for (const [id, c] of Object.entries(digest.classes)) {
    for (const f of ['n', 'severe', 'critical', 'high', 'medium', 'recent']) {
      if (typeof c[f] !== 'number' || !Number.isFinite(c[f])) problems.push(`${id}.${f} is not a number`);
      else if (c[f] < 0) problems.push(`${id}.${f} is negative`);
    }
    if (typeof c.weight !== 'number' || !Number.isFinite(c.weight)) problems.push(`${id}.weight is not a number`);
    else if (c.weight < 0 || c.weight > 3) problems.push(`${id}.weight is outside 0..3`);
    if (c.severe > c.n) problems.push(`${id}.severe (${c.severe}) exceeds n (${c.n})`);
    if (c.critical + c.high + c.medium > c.severe) {
      problems.push(`${id}: critical+high+medium exceeds severe`);
    }
  }
}

const classTotal = digest.classes
  ? Object.values(digest.classes).reduce((a, c) => a + (c.n || 0), 0)
  : 0;

if (problems.length) {
  console.error('digest failed validation — nothing written:');
  for (const p of problems.slice(0, 20)) console.error(`  · ${p}`);
  if (problems.length > 20) console.error(`  · … and ${problems.length - 20} more`);
  process.exit(1);
}

const json = JSON.stringify(digest);
const kb = (json.length / 1024).toFixed(0);
console.error(`digest ${source}  ${kb} KB  version ${digest.version}  ${digest.source_rows} source rows`);

if (json.length > 1_900_000) {
  console.error('digest exceeds D1 value cap; reduce MAX_PRECEDENT_PER_CLASS in distill.py');
  process.exit(1);
}

if (classTotal !== digest.source_rows) {
  // Not fatal: the upstream corpus contains rows whose vuln_group maps to no
  // playbook, so per-class totals are legitimately below source_rows. Say it
  // out loud so nobody "fixes" it by inventing rows.
  console.error(
    `note: per-class n totals ${classTotal}, digest reports ${digest.source_rows} source rows ` +
      `(${digest.source_rows - classTotal} rows belong to no playbook class)`,
  );
}

const merged = (digest.attribution?.merged_from ?? []);
if (merged.length) {
  console.error(`this digest is a merge of ${merged.length} source(s):`);
  for (const m of merged) {
    console.error(
      `  · ${m.source}  ${m.added_source_rows} rows  v${m.previous_version}->  ` +
        `licence ${m.source_licence || 'unstated'}`,
    );
  }
  const unstated = merged.filter((m) => !m.source_licence);
  if (unstated.length) {
    console.error('WARNING: a merged source has no recorded licence; attribution may be incomplete');
  }
}

if (checkOnly) {
  console.error('--check: digest is valid; nothing written');
  process.exit(0);
}

// Single-quote escaping for SQLite: double every quote.
const esc = (s) => String(s).replace(/'/g, "''");

// loaded_at is forced strictly ahead of every existing row so that the Worker's
// ORDER BY loaded_at DESC LIMIT 1 cannot tie (see the header comment). A re-load
// of the same version is a correction, so it replaces in place and keeps its
// original loaded_at — replacing history for a version that has not changed
// silently would defeat the point of keeping history.
const sql =
  `INSERT INTO corpus_digest (version, source_rows, digest, loaded_at)\n` +
  `VALUES ('${esc(digest.version)}', ${digest.source_rows}, '${esc(json)}',\n` +
  `        MAX(unixepoch(), COALESCE((SELECT MAX(loaded_at) FROM corpus_digest), 0) + 1))\n` +
  `ON CONFLICT(version) DO UPDATE SET\n` +
  `  source_rows = excluded.source_rows,\n` +
  `  digest      = excluded.digest;\n`;

if (!process.argv.includes('--apply')) {
  process.stdout.write(sql);
  process.exit(0);
}

const file = join(tmpdir(), 'corpus-load.sql');
writeFileSync(file, sql);
try {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'asterion', '--remote', `--file=${file}`, '--yes'],
    { stdio: 'inherit' },
  );
  void out;
  console.error(`corpus loaded: version ${digest.version}`);
  console.error(
    'the Worker caches the digest for 1 hour per isolate; a fresh version ' +
      'takes effect as isolates recycle',
  );
} finally {
  rmSync(file, { force: true });
}
