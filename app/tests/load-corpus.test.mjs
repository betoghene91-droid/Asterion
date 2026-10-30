/**
 * B4 — the corpus digest load, proved equivalent AND proved bounded.
 *
 * TWO CLAIMS, BOTH MEASURED HERE
 *
 * 1. EQUIVALENCE. The digest used to be written as ONE SQL string literal of
 *    ~1.07 MB. D1 documents a per-statement ceiling of ~100 KB, so that
 *    statement was ~10.7x over, the import failed, and `deploy.yml` swallowed
 *    the failure with `continue-on-error: true`. `getCorpus()` then returned
 *    null, so every prior in production was 0.0 with `validatable: false` — the
 *    premium feature was off while every surface looked healthy.
 *
 *    Chunking it is only correct if the stored bytes are unchanged, so this
 *    test loads BOTH forms into two separate real SQLite databases (node:sqlite,
 *    the same engine family D1 runs) using the real shipped digest and asserts
 *    the resulting `corpus_digest` rows are identical — same value, same byte
 *    length, same source_rows, and one row in each.
 *
 *    It is a real load, not a string comparison: the chunked path executes 1
 *    seed + N appends and the single path executes 1 insert, and the assertion
 *    is on what SQLite stored afterwards.
 *
 * 2. BOUNDEDNESS. Every emitted statement must be under the ceiling. This is
 *    asserted against the SHIPPED digest at the SHIPPED budget, so a future
 *    change to the digest size or the chunk budget cannot quietly reintroduce
 *    the original bug — it fails here instead of failing in production where
 *    nothing reports it.
 *
 * WHAT THIS DOES NOT PROVE: that a D1 *remote* import of a 17-statement file
 * behaves like local SQLite. That is what the `deploy.yml` gate is for — the
 * `continue-on-error: true` is gone, so a failed corpus load now fails the
 * deploy, and the step still verifies the row after loading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CHUNK_BYTES,
  MAX_VALUE_BYTES,
  buildStatements,
  chunkJson,
  renderSql,
  seedStatement,
  singleStatement,
  validateDigest,
} from '../scripts/load-corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIGEST_PATH = join(HERE, '..', 'src', 'corpus-digest.json');
const digest = JSON.parse(readFileSync(DIGEST_PATH, 'utf8'));
const json = JSON.stringify(digest);

/** The exact DDL from app/schema.sql, so a column rename would fail here too. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS corpus_digest (
  version      TEXT PRIMARY KEY,
  source_rows  INTEGER NOT NULL,
  digest       TEXT NOT NULL,
  loaded_at    INTEGER NOT NULL
);
`;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

/** Run a list of statements in order, exactly as `--apply` would. */
function run(db, statements) {
  for (const s of statements) db.exec(s);
}

function rows(db) {
  return db.prepare('SELECT version, source_rows, digest, loaded_at FROM corpus_digest').all();
}

const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// ── 1. equivalence: the chunked load stores exactly what the single one did ──

test('chunked load stores a byte-identical row to the pre-chunking single statement', () => {
  const single = freshDb();
  run(single, [singleStatement(digest)]);
  const singleRows = rows(single);

  const chunked = freshDb();
  const { statements } = buildStatements(digest);
  run(chunked, statements);
  const chunkedRows = rows(chunked);

  assert.equal(singleRows.length, 1, 'single-statement form must write exactly one row');
  assert.equal(chunkedRows.length, 1, 'chunked form must write exactly one row');

  const a = singleRows[0];
  const b = chunkedRows[0];

  assert.equal(b.version, a.version);
  assert.equal(b.source_rows, a.source_rows);
  assert.equal(
    byteLen(b.digest),
    byteLen(a.digest),
    `stored digest lengths differ: chunked ${byteLen(b.digest)} vs single ${byteLen(a.digest)}`,
  );
  assert.equal(b.digest, a.digest, 'stored digest is not byte-for-byte identical');
  // And both equal the serialised source, so neither path normalised anything.
  assert.equal(b.digest, json);
  assert.equal(a.digest, json);
  single.close();
  chunked.close();
});

test('the chunked load is exactly 1 seed + N appends, and no statement repeats the seed', () => {
  const { statements, chunks } = buildStatements(digest);
  assert.equal(chunks.length, statements.length - 1, 'every statement after the first is one chunk');
  assert.match(statements[0], /^INSERT INTO corpus_digest/);
  assert.equal(
    statements.filter((s) => s.startsWith('INSERT INTO corpus_digest')).length,
    1,
    'only the seed may INSERT; a second INSERT would reset the accumulated value',
  );
  for (const s of statements.slice(1)) {
    assert.match(s, /^UPDATE corpus_digest SET digest = digest \|\| '/, 'append statements must append');
    assert.ok(s.trimEnd().endsWith(';'), 'each statement must be terminated');
  }
  // Order is the assembly order. Reversing it must change the result, which
  // proves the test above is actually sensitive to ordering.
  const reversed = [statements[0], ...statements.slice(1).reverse()];
  const db = freshDb();
  run(db, reversed);
  assert.notEqual(rows(db)[0].digest, json, 'reversed order must NOT reconstruct the digest');
  db.close();
});

// ── 2. boundedness: every statement is under D1's per-statement ceiling ──────

test('the shipped digest emits only statements well under the ~100 KB ceiling', () => {
  const { statements } = buildStatements(digest);
  const sizes = statements.map(byteLen);
  const largest = Math.max(...sizes);
  const singleLen = byteLen(singleStatement(digest));

  // The defect being fixed, restated as a measurement so it cannot regress
  // silently: the old form is many times over the ceiling.
  assert.ok(singleLen > 1_000_000, `expected the single statement to be ~1 MB, got ${singleLen}`);
  assert.ok(singleLen > CHUNK_BYTES * 10, 'the pre-chunking statement must be far over the budget');

  // The fix: nothing near it.
  assert.ok(
    largest <= CHUNK_BYTES + 256,
    `largest statement ${largest} B exceeds ${CHUNK_BYTES} + 256 B scaffolding`,
  );
  // And with real headroom against the documented ceiling.
  assert.ok(largest < 100_000, `largest statement ${largest} B is not under a 100 KB ceiling`);
  assert.ok(
    largest <= 100_000 * 0.7,
    `largest statement ${largest} B has less than 30% headroom under 100 KB`,
  );

  // eslint-disable-next-line no-console
  console.log(
    `measured: ${statements.length} statements, largest ${largest} B ` +
      `(single-statement form was ${singleLen} B)`,
  );
});

test('chunkJson never splits an escaped quote pair and never overruns the budget', () => {
  // Small budgets are where a split escape would show up; 4096 and the shipped
  // budget are the realistic shapes. Budget 7 over the full 1 MB digest would
  // mean ~150k SQLite round-trips, so the tiny-budget case uses a small sample
  // and the full digest is only chunked at realistic sizes.
  const sample = json.slice(0, 4000);
  const cases = [
    { text: sample, budget: 7 },
    { text: sample, budget: 64 },
    { text: json, budget: 4096 },
    { text: json, budget: CHUNK_BYTES },
  ];
  for (const { text, budget } of cases) {
    const chunks = chunkJson(text, budget);
    assert.equal(chunks.join(''), text, `reassembly failed at budget ${budget}`);
    for (const c of chunks) {
      const escaped = c.replace(/'/g, "''");
      assert.ok(byteLen(escaped) <= budget, `chunk over budget ${budget}`);
      // Every chunk must be independently well-formed as a literal: after
      // escaping, the quote count is even, so no statement can be cut mid-escape.
      assert.equal(
        (escaped.match(/'/g) ?? []).length % 2,
        0,
        `escaped chunk has an odd quote count at budget ${budget} — an escape was split`,
      );
    }
  }

  // And the escaped chunks must actually round-trip through SQLite, not merely
  // look balanced. Checked on the real digest at the real budget.
  const db = freshDb();
  db.exec(`INSERT INTO corpus_digest (version, source_rows, digest, loaded_at) VALUES ('v', 0, '', 0)`);
  for (const c of chunkJson(json, CHUNK_BYTES)) {
    const escaped = c.replace(/'/g, "''");
    db.exec(`UPDATE corpus_digest SET digest = digest || '${escaped}' WHERE version = 'v'`);
  }
  assert.equal(db.prepare("SELECT digest FROM corpus_digest WHERE version='v'").get().digest, json);
  db.close();
});

test('a digest with apostrophes survives chunking (the escaping case)', () => {
  // 268 real apostrophes are in the shipped digest; this pins the behaviour for
  // a synthetic one so the assertion does not depend on corpus content.
  const small = {
    version: '9',
    source_rows: 1,
    classes: { 'x.y': { n: 1, severe: 1, critical: 0, high: 1, medium: 0, recent: 1, weight: 1, validatable: true } },
    precedent: { 'x.y': [{ id: "it's", title: "don't split 'this'" }] },
  };
  const single = freshDb();
  run(single, [singleStatement(small)]);
  const chunked = freshDb();
  run(chunked, buildStatements(small).statements);
  assert.equal(rows(chunked)[0].digest, rows(single)[0].digest);
  assert.ok(rows(chunked)[0].digest.includes("don't split 'this'"), 'apostrophes must survive verbatim');
  single.close();
  chunked.close();
});

// ── 3. the tie the Worker silently reads through ────────────────────────────

test('a new row is strictly above every existing loaded_at, even in the same second', () => {
  const db = freshDb();
  // Simulate a previous load and a second load in the same `unixepoch()` tick.
  db.exec(
    `INSERT INTO corpus_digest (version, source_rows, digest, loaded_at)
     VALUES ('4', 10, '{}', unixepoch())`,
  );
  const older = rows(db)[0].loaded_at;

  run(db, buildStatements(digest).statements);
  const all = db.prepare('SELECT version, loaded_at FROM corpus_digest ORDER BY loaded_at DESC').all();
  assert.equal(all.length, 2, 'history must be kept: a new version ADDS a row');
  assert.equal(all[0].version, digest.version, 'the newest row must be the one just loaded');
  assert.ok(
    all[0].loaded_at > older,
    `loaded_at must be strictly greater than ${older} or ORDER BY loaded_at DESC ties and ` +
      `the Worker may read the stale digest: got ${all[0].loaded_at}`,
  );

  // A third load in the same second must still advance.
  run(db, buildStatements(digest).statements);
  assert.equal(rows(db).length, 2, 'same-version re-load replaces in place, keeping history');
  const again = db.prepare("SELECT loaded_at FROM corpus_digest WHERE version=?").get(digest.version);
  assert.equal(again.loaded_at, all[0].loaded_at, 'a same-version correction keeps its original loaded_at');
  db.close();
});

test('seedStatement is the only place the loaded_at floor is evaluated', () => {
  const seed = seedStatement(digest);
  assert.match(seed, /MAX\(unixepoch\(\), COALESCE\(\(SELECT MAX\(loaded_at\) FROM corpus_digest\), 0\) \+ 1\)/);
  assert.match(seed, /digest {6}= ''/, 'the seed must start from an EMPTY digest');
  for (const s of buildStatements(digest).statements.slice(1)) {
    assert.ok(!/unixepoch\(\)/.test(s), 'appends must not re-evaluate the clock mid-load');
    assert.ok(!/loaded_at/.test(s), 'appends must not touch loaded_at');
  }
});

// ── 4. the invariant check keeps working (--check) ──────────────────────────

test('validateDigest accepts the shipped digest', () => {
  assert.deepEqual(validateDigest(digest), []);
});

test('validateDigest still refuses a contradictory digest', () => {
  const bad = {
    version: '5',
    source_rows: 5,
    classes: { 'a.b': { n: 1, severe: 3, critical: 3, high: 1, medium: 1, recent: 0, weight: 9 } },
    precedent: {},
  };
  const problems = validateDigest(bad).join('\n');
  assert.match(problems, /severe \(3\) exceeds n \(1\)/);
  assert.match(problems, /critical\+high\+medium exceeds severe/);
  assert.match(problems, /weight is outside 0\.\.3/);
});

test('validateDigest enforces validatable == (n > 0), the invariant the Worker relies on', () => {
  const base = () => ({
    version: '5',
    source_rows: 2,
    classes: {},
    precedent: {},
  });
  const good = base();
  good.classes['c.zero'] = { n: 0, severe: 0, critical: 0, high: 0, medium: 0, recent: 0, weight: 0, validatable: false };
  good.classes['c.one'] = { n: 2, severe: 1, critical: 0, high: 1, medium: 0, recent: 1, weight: 1, validatable: true };
  assert.deepEqual(validateDigest(good), []);

  const lying = base();
  lying.classes['c.zero'] = { n: 0, severe: 0, critical: 0, high: 0, medium: 0, recent: 0, weight: 0, validatable: true };
  assert.match(validateDigest(lying).join('\n'), /c\.zero\.validatable must be exactly \(n > 0\)/);
});

test('renderSql is the same text --apply writes, and it ends with a newline', () => {
  const sql = renderSql(digest);
  assert.equal(sql, buildStatements(digest).statements.join('\n') + '\n');
  assert.equal(sql.split('\n').filter((l) => l.startsWith('INSERT INTO corpus_digest')).length, 1);
});

test('the value cap check is still meaningful for the shipped digest', () => {
  assert.ok(byteLen(json) < MAX_VALUE_BYTES, 'digest must stay under the D1 per-value cap');
});
