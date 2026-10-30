#!/usr/bin/env node
/**
 * Load the distilled corpus digest into D1.
 *
 * The digest is ~1 MB of JSON, well under D1's 2 MB per-value cap. We store it
 * as a single row rather than 400-odd rows because the Worker only ever needs to
 * (a) read priors for a class and (b) retrieve precedent for a lead. Both are
 * cheap json.parse operations on one blob, and neither costs thousands of rows
 * of the 5M/day read budget.
 *
 * ONE ROW, MANY STATEMENTS (the 1 MB statement that never ran)
 * -----------------------------------------------------------
 * "One row" used to be implemented as "one SQL statement", by pasting the whole
 * escaped digest into a single string literal. That statement is ~1.07 MB.
 * D1 documents a per-statement ceiling of ~100 KB, so it was ~10.7x over, the
 * import failed, and `deploy.yml` had `continue-on-error: true` on this step —
 * which swallowed the failure. The visible consequence was not an error
 * anywhere: `getCorpus()` simply returned null, `priorFor()` returned zero, and
 * every prior in production was 0.0 with `validatable: false`. The premium
 * feature was off while every surface looked healthy.
 *
 * So the row is now assembled from bounded statements:
 *
 *   1   INSERT the row with an EMPTY digest, and with `loaded_at` forced past
 *       every existing row (see the tie note below).
 *   2..n UPDATE ... SET digest = digest || '<chunk>'      (n-1 statements)
 *
 * Each chunk is a complete, valid string literal of at most CHUNK_BYTES
 * escaped bytes, so no statement approaches the cap, and appending in
 * statement order makes the assembly independent of `group_concat` row-order
 * semantics (which SQLite does not guarantee across versions). 65,536 is chosen
 * because it is a power of two that leaves ~34% of headroom under the 100 KB
 * ceiling for the statement's own scaffolding and for any future D1 tightening.
 *
 * The append form is byte-exact: `||` on TEXT concatenates without normalising
 * anything, so the stored value is the same string the single-statement form
 * produced. `tests/load-corpus.test.mjs` proves that by loading both forms into
 * two real SQLite databases and comparing the stored value and the row count —
 * and by checking the chunk boundary never splits an escaped `''` pair.
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
 * and the ORDER BY is then ambiguous — SQLite may return either, and the Worker
 * caches whatever it read for an hour. Loading a new digest immediately after an
 * old one in the same CI step is exactly how that happens. We therefore force
 * the new row's `loaded_at` to be strictly greater than every existing row's,
 * using unixepoch() only as a floor. That floor is evaluated in the SEED
 * statement, before any chunk is appended, so the whole load shares one value.
 *
 * A re-load of the SAME version is a genuine correction (e.g. the merge was
 * re-run after fixing a mapping), so that one DOES replace in place and keep its
 * original `loaded_at`, and says so on stderr rather than silently overwriting
 * history.
 *
 * Usage:
 *   node scripts/load-corpus.mjs                    # writes SQL to stdout
 *   node scripts/load-corpus.mjs --apply            # runs wrangler for you
 *   node scripts/load-corpus.mjs --in path.json     # explicit digest
 *   node scripts/load-corpus.mjs --check            # verify invariants, write nothing
 *   node scripts/load-corpus.mjs --single           # the pre-chunking single-statement form
 *                                                   # (kept only for the equivalence test)
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolved from THIS FILE, not from cwd, so `--check` works from any directory.
const CANDIDATES = [join(HERE, '..', 'src', 'corpus-digest.json'), 'src/corpus-digest.json'];

/**
 * Maximum escaped-literal bytes per statement.
 *
 * D1's documented per-statement ceiling is ~100 KB. 65,536 keeps the largest
 * statement (a chunk plus the ~66 bytes of `UPDATE ... || ''` scaffolding) at
 * ~64 KB, i.e. ~34% under the ceiling.
 */
export const CHUNK_BYTES = 65_536;

/** D1's per-value ceiling, with headroom. Unchanged from the pre-chunking check. */
export const MAX_VALUE_BYTES = 1_900_000;

const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// Single-quote escaping for SQLite: double every quote. This is the ONLY
// escaping SQLite string literals need, and it is what makes the stored value
// byte-identical to the JSON we serialised.
const esc = (s) => String(s).replace(/'/g, "''");

/**
 * Validate the shape the Worker relies on. Returns a list of problems; an empty
 * list means the digest may be loaded.
 *
 * Pure and exported so the tests exercise the same code path the loader does
 * rather than a copy of it.
 */
export function validateDigest(digest) {
  const problems = [];
  if (!digest || typeof digest !== 'object') return ['digest is not an object'];
  if (typeof digest.version !== 'string' || !digest.version) {
    problems.push('version must be a non-empty string');
  }
  if (!Number.isInteger(digest.source_rows)) problems.push('source_rows must be an integer');
  if (!digest.classes || typeof digest.classes !== 'object') problems.push('classes must be an object');
  if (!digest.precedent || typeof digest.precedent !== 'object') problems.push('precedent must be an object');

  // A digest whose classes disagree with source_rows is a merge bug, and loading
  // it would poison every prior the Worker computes. Refuse rather than warn.
  if (digest.classes && typeof digest.classes === 'object') {
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
      // The invariant the Worker's own `validatable` flag is defined by:
      // a class with no rows can never be validated, and one with rows can.
      if ('validatable' in c && c.validatable !== c.n > 0) {
        problems.push(`${id}.validatable must be exactly (n > 0)`);
      }
    }
  }
  if (Number.isInteger(digest.source_rows) && digest.source_rows < 0) {
    problems.push('source_rows is negative');
  }
  return problems;
}

/**
 * Split `json` into chunks whose ESCAPED form is at most `budget` bytes each.
 *
 * The split happens on RAW characters, never inside an escape: chunking the
 * escaped text directly could cut an `''` pair in half and produce two literals
 * that are individually well-formed but jointly wrong (and one orphaned quote
 * would break the statement outright). Accumulating in escaped bytes and
 * cutting between raw characters makes every chunk a complete literal.
 */
export function chunkJson(json, budget = CHUNK_BYTES) {
  const chunks = [];
  let current = '';
  let bytes = 0;
  for (const ch of json) {
    const cost = ch === "'" ? 2 : byteLen(ch);
    if (bytes + cost > budget && current.length > 0) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The seed statement: create/replace the row with an EMPTY digest and a
 * `loaded_at` strictly greater than every existing row's.
 *
 * Split out because the tie-avoidance lives here and the tests assert it
 * directly. `ON CONFLICT` keeps the original `loaded_at` on a same-version
 * re-load (a correction, not a new generation) exactly as the pre-chunking
 * script did; only `source_rows` and `digest` are replaced.
 */
export function seedStatement(digest) {
  return (
    `INSERT INTO corpus_digest (version, source_rows, digest, loaded_at)\n` +
    `VALUES ('${esc(digest.version)}', ${digest.source_rows}, '',\n` +
    `        MAX(unixepoch(), COALESCE((SELECT MAX(loaded_at) FROM corpus_digest), 0) + 1))\n` +
    `ON CONFLICT(version) DO UPDATE SET\n` +
    `  source_rows = excluded.source_rows,\n` +
    `  digest      = '';`
  );
}

/** One append statement. Order is the assembly order; never reorder these. */
export function appendStatement(version, chunk) {
  return `UPDATE corpus_digest SET digest = digest || '${esc(chunk)}' WHERE version = '${esc(version)}';`;
}

/**
 * The full, bounded statement list, in execution order.
 *
 * Exported so the equivalence test can run exactly what `--apply` writes.
 */
export function buildStatements(digest, budget = CHUNK_BYTES) {
  const json = JSON.stringify(digest);
  const chunks = chunkJson(json, budget);
  const out = [seedStatement(digest)];
  for (const c of chunks) out.push(appendStatement(digest.version, c));
  return { statements: out, chunks, json };
}

/**
 * The pre-chunking form: one INSERT whose `digest` literal is the whole JSON.
 *
 * Nothing in the pipeline uses this any more — it is ~10.7x over D1's
 * per-statement ceiling. It is kept, exported, and exercised ONLY by
 * `tests/load-corpus.test.mjs`, which loads it and the chunked form into two
 * separate SQLite databases and asserts the resulting rows are byte-identical.
 * That is the whole proof that chunking did not change the data.
 */
export function singleStatement(digest) {
  const json = JSON.stringify(digest);
  return (
    `INSERT INTO corpus_digest (version, source_rows, digest, loaded_at)\n` +
    `VALUES ('${esc(digest.version)}', ${digest.source_rows}, '${esc(json)}',\n` +
    `        MAX(unixepoch(), COALESCE((SELECT MAX(loaded_at) FROM corpus_digest), 0) + 1))\n` +
    `ON CONFLICT(version) DO UPDATE SET\n` +
    `  source_rows = excluded.source_rows,\n` +
    `  digest      = excluded.digest;`
  );
}

/** Joined SQL text for stdout / `--file`. Order matters; do not sort. */
export function renderSql(digest, budget = CHUNK_BYTES) {
  return buildStatements(digest, budget).statements.join('\n') + '\n';
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function main() {
  const explicit = arg('--in');
  const checkOnly = process.argv.includes('--check');
  const single = process.argv.includes('--single');

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

  // ── validate the shape the Worker relies on before writing anything ───────
  const problems = validateDigest(digest);

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

  if (byteLen(json) > MAX_VALUE_BYTES) {
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

  const merged = digest.attribution?.merged_from ?? [];
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

  if (single) {
    process.stdout.write(singleStatement(digest) + '\n');
    process.exit(0);
  }

  const { statements, chunks } = buildStatements(digest);
  const sizes = statements.map(byteLen);
  const largest = Math.max(...sizes);
  console.error(
    `chunked load: ${statements.length} statements (1 seed + ${chunks.length} chunk(s)), ` +
      `largest ${largest} bytes escaped-literal, cap ${CHUNK_BYTES}/statement ` +
      `(${(100 - (largest / 100_000) * 100).toFixed(1)}% under a 100 KB ceiling)`,
  );
  // Never emit a statement over the ceiling: this is checked, not assumed, so a
  // future budget change cannot silently reintroduce the original bug.
  if (largest > CHUNK_BYTES + 256) {
    console.error(
      `refusing to emit: largest statement is ${largest} bytes, over the ` +
        `${CHUNK_BYTES}-byte budget plus 256 bytes of scaffolding`,
    );
    process.exit(1);
  }

  const sql = statements.join('\n') + '\n';

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
}

// Only run the CLI when invoked directly, so the equivalence test can import
// the builders without executing a load.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
