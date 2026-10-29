// Tests for the learning loop. Run with: node --test tests/learn.test.mjs
//
// These deliberately do NOT mock the database. They load the real schema.sql
// into node:sqlite, so a renamed column, a missing index target or a CHECK
// constraint that the code violates fails here rather than in production. A
// stub db that accepts any SQL proves the stub, not the system.
//
// Build first: this imports the compiled ../build/learn.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  recordOutcome,
  classStats,
  blendedWeight,
  blendDetail,
  learnedRanking,
  DEFAULT_PRIOR_STRENGTH,
  TIER,
  VERDICTS,
} from '../build/learn.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

/**
 * Wrap node:sqlite in the LearnDb shape. Positional `?` binding works the same
 * way as D1, which is the point: if the SQL is wrong for D1 it is wrong here.
 *
 * `bind()` must mutate shared state, not return a copy — the first version of
 * this helper returned `{...api, _values}` and every insert silently bound zero
 * parameters. That is itself a reason to test against a real database.
 */
function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const db = {
    raw,
    prepare(sql) {
      const stmt = raw.prepare(sql);
      let values = [];
      const api = {
        bind(...v) {
          values = v;
          return api;
        },
        async run() {
          const info = stmt.run(...values);
          return { success: true, meta: info };
        },
        async all() {
          return { results: stmt.all(...values) };
        },
        async first() {
          return stmt.get(...values) ?? null;
        },
      };
      return api;
    },
    close() {
      raw.close();
    },
  };
  return db;
}

const NOW = 1_800_000_000;
let clockTick = 0;
const at = () => NOW + clockTick++;

/** Record n outcomes of one verdict for a class. */
async function seed(db, cls, verdict, n, playbook = cls) {
  for (let i = 0; i < n; i++) {
    await recordOutcome(db, { playbook, verdict, cls, at: at() });
  }
}

// ─────────────────────────────────────────────── schema is real and valid ─────

test('schema.sql loads cleanly into a fresh database (twice, so it is idempotent)', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  // Re-running the migration must not throw: every statement is IF NOT EXISTS.
  raw.exec(SCHEMA);

  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of ['learning_outcomes', 'corpus_sources', 'corpus_digest', 'proofs', 'hunts']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }

  const cols = raw
    .prepare('PRAGMA table_info(learning_outcomes)')
    .all()
    .map((r) => r.name);
  assert.deepEqual(cols, [
    'id',
    'cls',
    'playbook',
    'verdict',
    'target_fingerprint',
    'measured_before',
    'measured_after',
    'created_at',
  ]);

  const srcCols = raw
    .prepare('PRAGMA table_info(corpus_sources)')
    .all()
    .map((r) => r.name);
  assert.deepEqual(srcCols, [
    'id',
    'source',
    'url',
    'licence',
    'rows_ingested',
    'digest_version',
    'ingested_at',
  ]);

  const idx = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r) => r.name);
  assert.ok(idx.includes('idx_learning_cls'), 'missing index on (cls)');
  assert.ok(idx.includes('idx_learning_playbook'), 'missing index on (playbook)');
  raw.close();
});

test('the verdict CHECK constraint rejects a verdict the prover cannot emit', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  assert.throws(
    () =>
      raw
        .prepare(
          'INSERT INTO learning_outcomes (id, cls, playbook, verdict, created_at) VALUES (?,?,?,?,?)',
        )
        .run('x', 'sol.dos', 'sol.dos', 'probably', NOW),
    /CHECK|constraint/i,
  );
  raw.close();
});

// ──────────────────────────────────────────────────────── recordOutcome ──────

test('recordOutcome persists a row and classStats reflects exactly that row', async () => {
  const db = makeDb();
  const row = await recordOutcome(db, {
    playbook: 'sol.oracle',
    verdict: 'proven',
    target_fingerprint: 'fp-abc',
    measured: { before: 100, after: 0 },
    at: NOW,
  });

  assert.equal(row.cls, 'sol.oracle', 'cls defaults to the playbook id');
  assert.equal(row.verdict, 'proven');
  assert.equal(row.target_fingerprint, 'fp-abc');
  assert.equal(row.measured_before, 100);
  assert.equal(row.measured_after, 0);
  assert.equal(row.created_at, NOW);

  const stored = db.raw.prepare('SELECT * FROM learning_outcomes').all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, row.id);
  assert.equal(stored[0].cls, 'sol.oracle');

  const stats = await classStats(db, 'sol.oracle');
  assert.equal(stats.length, 1);
  assert.equal(stats[0].attempted, 1);
  assert.equal(stats[0].proven, 1);
  assert.equal(stats[0].counted, 1);
  assert.equal(stats[0].observedWeight, TIER.proven);
  db.close();
});

test('recordOutcome keeps an explicit cls distinct from the playbook', async () => {
  const db = makeDb();
  await recordOutcome(db, { playbook: 'web.xss.reflected', cls: 'web.xss.reflected', verdict: 'disproved', at: NOW });
  // One playbook can cover several classes: the CLASS is what gets ranked, the
  // playbook is what gets run. They must be stored independently.
  await recordOutcome(db, { playbook: 'shared.web.authorization', cls: 'web.cors', verdict: 'proven', at: NOW + 1 });

  const cors = await classStats(db, 'web.cors');
  assert.equal(cors.length, 1);
  assert.equal(cors[0].proven, 1);

  const row = db.raw.prepare("SELECT cls, playbook FROM learning_outcomes WHERE cls = 'web.cors'").get();
  assert.equal(row.playbook, 'shared.web.authorization', 'the playbook is preserved as run');
  assert.equal(row.cls, 'web.cors', 'the class is preserved as ranked');

  // And there is no phantom class named after the playbook.
  assert.deepEqual(await classStats(db, 'shared.web.authorization'), []);
  db.close();
});

test('recordOutcome refuses a verdict outside the four the prover emits', async () => {
  const db = makeDb();
  for (const bad of ['', 'PROVEN', 'solved', 'true', null, undefined, 1]) {
    await assert.rejects(
      () => recordOutcome(db, { playbook: 'sol.dos', verdict: bad, at: NOW }),
      TypeError,
      `verdict ${String(bad)} must be refused`,
    );
  }
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM learning_outcomes').get().c, 0);
  db.close();
});

test('recordOutcome refuses an empty playbook and a non-numeric measurement', async () => {
  const db = makeDb();
  await assert.rejects(() => recordOutcome(db, { playbook: '', verdict: 'proven' }), TypeError);
  await assert.rejects(() => recordOutcome(db, { playbook: '   ', verdict: 'proven' }), TypeError);
  await assert.rejects(
    () => recordOutcome(db, { playbook: 'sol.dos', verdict: 'proven', measured: { before: NaN } }),
    TypeError,
  );
  await assert.rejects(
    () => recordOutcome(db, { playbook: 'sol.dos', verdict: 'proven', measured: { after: '5' } }),
    TypeError,
  );
  db.close();
});

test('classStats separates attempted from counted: inconclusive is an attempt, not signal', async () => {
  const db = makeDb();
  await seed(db, 'sol.reentrancy', 'proven', 2);
  await seed(db, 'sol.reentrancy', 'partial', 1);
  await seed(db, 'sol.reentrancy', 'disproved', 3);
  await seed(db, 'sol.reentrancy', 'inconclusive', 4);

  const [s] = await classStats(db, 'sol.reentrancy');
  assert.equal(s.attempted, 10);
  assert.equal(s.counted, 6, 'inconclusive rows are excluded from the mean');
  assert.equal(s.proven, 2);
  assert.equal(s.partial, 1);
  assert.equal(s.disproved, 3);
  assert.equal(s.inconclusive, 4);
  assert.equal(s.tierSum, 2 * TIER.proven + TIER.partial);
  assert.equal(s.observedWeight, (2 * 3 + 1) / 6);
  db.close();
});

test('classStats with no cls returns one row per class and nothing for unknown classes', async () => {
  const db = makeDb();
  await seed(db, 'sol.dos', 'proven', 1);
  await seed(db, 'web.ssrf', 'inconclusive', 1);

  const all = await classStats(db);
  assert.deepEqual(all.map((s) => s.cls), ['sol.dos', 'web.ssrf']);

  const none = await classStats(db, 'web.graphql');
  assert.deepEqual(none, [], 'no row is invented for a class that was never attempted');
  db.close();
});

// ─────────────────────────────────────────── zero evidence === prior exactly ──

test('blendedWeight with zero outcomes returns the digest weight bit-for-bit', () => {
  const weights = [0, 0.0, 0.535, 0.797, 0.933, 1.167, 1.255, 3];
  for (const w of weights) {
    // null, undefined and an all-zero stat object must all behave identically.
    assert.equal(blendedWeight('sol.dos', w, null), w, `null stat must return ${w} exactly`);
    assert.equal(blendedWeight('sol.dos', w, undefined), w, `undefined stat must return ${w} exactly`);
    assert.equal(
      blendedWeight('sol.dos', w, {
        cls: 'sol.dos',
        attempted: 0,
        proven: 0,
        partial: 0,
        disproved: 0,
        inconclusive: 0,
        counted: 0,
        tierSum: 0,
        observedWeight: null,
        lastAt: null,
      }),
      w,
      `empty stat must return ${w} exactly`,
    );
    // Strict identity, not approximate: a first deploy must provably change nothing.
    assert.ok(Object.is(blendedWeight('sol.dos', w, null), w));
  }
});

test('a class with only inconclusive outcomes still returns the digest weight exactly', async () => {
  const db = makeDb();
  await seed(db, 'web.graphql', 'inconclusive', 25);
  const [s] = await classStats(db, 'web.graphql');
  assert.equal(s.counted, 0);
  assert.equal(blendedWeight('web.graphql', 0.8, s), 0.8, '25 harness failures teach nothing');
  db.close();
});

test('blendedWeight also returns the digest weight exactly when the digest weight is 0', () => {
  // The 15 web.* classes today. Prior 0 + no proof must stay 0, not drift up.
  assert.equal(blendedWeight('web.idor', 0, null), 0);
  assert.ok(Object.is(blendedWeight('web.idor', 0, null), 0));
});

// ───────────────────────────────────────── moves toward evidence, shrinking ───

test('blendedWeight moves toward observed outcomes as evidence arrives', async () => {
  const db = makeDb();
  const prior = 0.5;
  const k = DEFAULT_PRIOR_STRENGTH;

  // Observed (3.0) is above the prior, so the estimate must rise monotonically
  // toward it, never overshoot, and land on the closed form (k·prior + n·3)/(k+n).
  let prev = prior;
  for (let n = 1; n <= 40; n++) {
    await seed(db, 'sol.reentrancy', 'proven', 1);
    const [s] = await classStats(db, 'sol.reentrancy');
    const w = blendedWeight('sol.reentrancy', prior, s);
    const expected = (k * prior + n * TIER.proven) / (k + n);
    assert.ok(Math.abs(w - expected) < 1e-12, `n=${n}: expected ${expected}, got ${w}`);
    assert.ok(w > prev - 1e-12, `n=${n}: weight must not fall while every outcome is proven`);
    assert.ok(w <= TIER.proven + 1e-12, `n=${n}: weight must not exceed the observed maximum`);
    prev = w;
  }
  assert.ok(prev > prior, 'after 40 proofs the estimate is above the prior');
  // 40 is real evidence but not yet decisive at k=12: it must be most of the
  // way there without pretending to be certain. Verified against Python.
  assert.ok(Math.abs(prev - 2.4231) < 1e-3, `expected ~2.4231 after 40 proofs, got ${prev}`);
  db.close();
});

test('shrinkage is monotonic: the prior share falls and the move grows as n grows', async () => {
  const db = makeDb();
  const prior = 0.6;

  const shares = [];
  const moves = [];
  let n = 0;
  for (const step of [1, 1, 2, 4, 8, 16, 32, 64]) {
    await seed(db, 'sol.oracle', 'proven', step);
    n += step;
    const [s] = await classStats(db, 'sol.oracle');
    const d = blendDetail('sol.oracle', prior, s, { priorStrength: DEFAULT_PRIOR_STRENGTH });
    shares.push(d.priorShare);
    moves.push(Math.abs(d.blended - prior));

    // The closed form must hold: priorShare = k/(k+n), observedShare = n/(k+n).
    assert.ok(Math.abs(d.priorShare - DEFAULT_PRIOR_STRENGTH / (DEFAULT_PRIOR_STRENGTH + n)) < 1e-12);
    assert.ok(Math.abs(d.priorShare + d.observedShare - 1) < 1e-12);
    assert.equal(d.counted, n);
  }

  for (let i = 1; i < shares.length; i++) {
    assert.ok(shares[i] < shares[i - 1], `prior share must fall: ${shares[i - 1]} -> ${shares[i]}`);
    assert.ok(moves[i] > moves[i - 1], `move from prior must grow: ${moves[i - 1]} -> ${moves[i]}`);
  }

  // And explicitly: a small sample moves LESS than a large one.
  const small = (await classStats(db, 'sol.oracle'));
  const smallBlend = blendDetail('sol.oracle', prior, small[0]).blended;

  const db2 = makeDb();
  await seed(db2, 'sol.oracle', 'proven', 3);
  const threeBlend = blendDetail('sol.oracle', prior, (await classStats(db2, 'sol.oracle'))[0]).blended;
  await seed(db2, 'sol.oracle', 'proven', 200);
  const manyBlend = blendDetail('sol.oracle', prior, (await classStats(db2, 'sol.oracle'))[0]).blended;

  assert.ok(
    Math.abs(threeBlend - prior) < Math.abs(manyBlend - prior),
    `n=3 must move less than n=203 (${threeBlend} vs ${manyBlend})`,
  );
  assert.ok(smallBlend > prior);
  db.close();
  db2.close();
});

test('blendedWeight can move a class DOWN when the bot keeps disproving it', async () => {
  const db = makeDb();
  await seed(db, 'sol.flashloan', 'disproved', 50);
  const [s] = await classStats(db, 'sol.flashloan');
  const w = blendedWeight('sol.flashloan', 1.167, s);
  assert.ok(w < 1.167, `50 disproofs must lower the class, got ${w}`);
  assert.ok(w > 0, 'but not to zero — the prior still has mass');
  db.close();
});

// ───────────────────────────────────────── only proven is positive evidence ───

test('a pile of disproved outcomes never raises a class', async () => {
  const db = makeDb();
  const prior = 0.797;
  for (const n of [1, 5, 50, 500]) {
    const db2 = makeDb();
    await seed(db2, 'sol.dos', 'disproved', n);
    const [s] = await classStats(db2, 'sol.dos');
    const w = blendedWeight('sol.dos', prior, s);
    assert.ok(w <= prior, `n=${n} disproofs must not raise the class (${w} > ${prior})`);
    db2.close();
  }
  db.close();
});

test('partial outcomes cannot raise a class above its prior (capped without a proof)', async () => {
  const db = makeDb();
  await seed(db, 'web.ssrf', 'partial', 40);

  const [s] = await classStats(db, 'web.ssrf');
  assert.equal(s.proven, 0);
  assert.equal(s.counted, 40);
  assert.ok(s.observedWeight > 0, 'partial does carry a little signal in the raw mean');

  const d = blendDetail('web.ssrf', 0.75, s);
  assert.equal(d.blended, 0.75, 'no proof ⇒ clamped back to the prior');
  assert.equal(d.cappedByNoProof, true, 'and the clamp must be visible, not silent');
  assert.equal(d.moved, false);
  db.close();
});

test('a single proven outcome is enough to unlock movement (but barely moves it)', async () => {
  const db = makeDb();
  await seed(db, 'web.sqli', 'proven', 1);
  const [s] = await classStats(db, 'web.sqli');
  const d = blendDetail('web.sqli', 0.0, s);
  assert.equal(d.cappedByNoProof, false);
  assert.ok(d.blended > 0, 'one real proof lifts a zero-prior class off the floor');
  assert.ok(d.blended < 0.5, `but one proof must not be worth much, got ${d.blended}`);
  db.close();
});

test('one proof cannot outvote a high prior, many proofs can', async () => {
  const db = makeDb();
  const prior = 0.5;
  await seed(db, 'sol.accesscontrol', 'proven', 1);
  const one = blendedWeight('sol.accesscontrol', prior, (await classStats(db, 'sol.accesscontrol'))[0]);
  await seed(db, 'sol.accesscontrol', 'proven', 100);
  const many = blendedWeight('sol.accesscontrol', prior, (await classStats(db, 'sol.accesscontrol'))[0]);
  assert.ok(one < 1.0, 'one proof is not evidence of a high-value class');
  assert.ok(many > 2.5, '101 proofs are');
  db.close();
});

test('the anti-inflation rule uses proofs, not attempts, as its trigger', async () => {
  // Same observed mean, different proof counts: only the one with a proof moves.
  const partialOnly = blendDetail('web.cors', 0.0, {
    cls: 'web.cors', attempted: 10, proven: 0, partial: 10, disproved: 0,
    inconclusive: 0, counted: 10, tierSum: 10, observedWeight: 1, lastAt: NOW,
  });
  const withOneProof = blendDetail('web.cors', 0.0, {
    cls: 'web.cors', attempted: 10, proven: 1, partial: 9, disproved: 0,
    inconclusive: 0, counted: 10, tierSum: 12, observedWeight: 1.2, lastAt: NOW,
  });
  assert.equal(partialOnly.blended, 0, 'pure partial cannot lift a zero prior');
  assert.ok(withOneProof.blended > 0, 'one proof in the same pile can');
});

// ──────────────────────────────────────────────────────── learnedRanking ─────

test('learnedRanking orders by blended weight and exposes evidence counts', async () => {
  const db = makeDb();
  await seed(db, 'sol.reentrancy', 'proven', 30);
  await seed(db, 'sol.dos', 'disproved', 30);
  await seed(db, 'sol.oracle', 'proven', 1);

  const digest = {
    classes: {
      'sol.reentrancy': { weight: 0.996 },
      'sol.dos': { weight: 0.797 },
      'sol.oracle': { weight: 0.925 },
      'sol.upgrade': { weight: 0.651 },
    },
  };

  const rows = await learnedRanking(db, digest);
  assert.equal(rows.length, 4, 'every digest class appears even with no outcomes');

  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].blendedWeight >= rows[i].blendedWeight,
      'rows must be sorted by blended weight descending',
    );
  }

  const reen = rows.find((r) => r.cls === 'sol.reentrancy');
  const dos = rows.find((r) => r.cls === 'sol.dos');
  const upgrade = rows.find((r) => r.cls === 'sol.upgrade');

  assert.equal(reen.counted, 30);
  assert.equal(reen.proven, 30);
  assert.equal(reen.confidence, 'high');
  assert.equal(dos.confidence, 'high');
  assert.ok(dos.blendedWeight < 0.797, 'disproofs pull dos below its prior');

  assert.equal(upgrade.counted, 0);
  assert.equal(upgrade.confidence, 'none');
  assert.equal(upgrade.blendedWeight, 0.651, 'untouched class keeps its exact prior');
  assert.match(upgrade.note, /prior only/);
  db.close();
});

test('learnedRanking marks low-evidence classes as low confidence', async () => {
  const db = makeDb();
  await seed(db, 'web.idor', 'proven', 1);
  await seed(db, 'web.ssrf', 'proven', 4);
  await seed(db, 'web.sqli', 'proven', 10);

  const rows = await learnedRanking(db, null);
  const by = Object.fromEntries(rows.map((r) => [r.cls, r]));

  assert.equal(by['web.idor'].confidence, 'low');
  assert.equal(by['web.ssrf'].confidence, 'low');
  assert.equal(by['web.sqli'].confidence, 'medium');
  assert.match(by['web.idor'].note, /directional at best/);

  // A partial-only class is flagged as capped, which is the honest label.
  await seed(db, 'web.upload', 'partial', 6);
  const rows2 = await learnedRanking(db, null);
  const upload = rows2.find((r) => r.cls === 'web.upload');
  assert.match(upload.note, /0 proofs — capped at prior/);
  assert.equal(upload.raised, false);
  db.close();
});

test('learnedRanking only flags `raised` when a proof actually moved the class up', async () => {
  const db = makeDb();
  await seed(db, 'sol.oracle', 'proven', 40);
  await seed(db, 'sol.rounding', 'disproved', 40);

  const rows = await learnedRanking(db, {
    classes: { 'sol.oracle': { weight: 0.925 }, 'sol.rounding': { weight: 0.8 } },
  });
  const by = Object.fromEntries(rows.map((r) => [r.cls, r]));

  assert.equal(by['sol.oracle'].raised, true, '40 proofs above the prior raise it');
  assert.equal(by['sol.rounding'].raised, false, 'disproofs never raise');
  db.close();
});

test('learnedRanking works without a digest and ranks on observed evidence alone', async () => {
  const db = makeDb();
  await seed(db, 'sol.dos', 'proven', 5);
  await seed(db, 'sol.oracle', 'disproved', 5);

  const rows = await learnedRanking(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cls, 'sol.dos', 'the proven class ranks first');
  assert.equal(rows[0].digestWeight, 0);
  db.close();
});

test('learnedRanking is empty, not crashing, on a fresh database', async () => {
  const db = makeDb();
  assert.deepEqual(await learnedRanking(db), []);
  assert.deepEqual(await learnedRanking(db, { classes: {} }), []);
  db.close();
});

// ─────────────────────────────────────────────────────── guards / contract ────

test('priorStrength must be positive, so the prior can never be discarded', () => {
  const stat = {
    cls: 'sol.dos', attempted: 1, proven: 1, partial: 0, disproved: 0,
    inconclusive: 0, counted: 1, tierSum: 3, observedWeight: 3, lastAt: NOW,
  };
  for (const bad of [0, -1, NaN, Infinity, '12']) {
    assert.throws(() => blendDetail('sol.dos', 1, stat, { priorStrength: bad }), RangeError);
  }
  // A larger priorStrength means a more conservative blend.
  const loose = blendDetail('sol.dos', 0.5, stat, { priorStrength: 2 }).blended;
  const tight = blendDetail('sol.dos', 0.5, stat, { priorStrength: 100 }).blended;
  assert.ok(loose > tight, 'a bigger prior strength holds the estimate nearer the prior');
});

test('TIER and VERDICTS agree: only proven is worth the top weight', () => {
  assert.deepEqual([...VERDICTS], ['proven', 'partial', 'disproved', 'inconclusive']);
  assert.equal(TIER.proven, 3);
  assert.ok(TIER.proven > TIER.partial, 'a proof outweighs a partial');
  assert.equal(TIER.disproved, 0);
  assert.equal(TIER.inconclusive, 0);
});

test('a non-finite digest weight is treated as an absent prior, not as NaN', () => {
  assert.equal(blendedWeight('sol.dos', NaN, null), 0);
  assert.equal(blendedWeight('sol.dos', Infinity, null), 0);
  const stat = {
    cls: 'sol.dos', attempted: 1, proven: 1, partial: 0, disproved: 0,
    inconclusive: 0, counted: 1, tierSum: 3, observedWeight: 3, lastAt: NOW,
  };
  assert.ok(Number.isFinite(blendedWeight('sol.dos', NaN, stat)));
});

test('corpus_sources records provenance and refuses a duplicate (source, version)', () => {
  const db = makeDb();
  const ins = db.raw.prepare(
    `INSERT INTO corpus_sources (id, source, url, licence, rows_ingested, digest_version, ingested_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run('s1', 'ghsa', 'https://github.com/github/advisory-database', 'CC-BY-4.0', 1200, '3', NOW);
  ins.run('s2', 'nvd', 'https://services.nvd.nist.gov', 'public-domain', 800, '3', NOW + 1);

  const rows = db.raw.prepare('SELECT * FROM corpus_sources ORDER BY source').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].licence, 'CC-BY-4.0');
  assert.equal(rows[0].rows_ingested, 1200);

  assert.throws(
    () => ins.run('s3', 'ghsa', 'x', 'CC-BY-4.0', 1, '3', NOW + 2),
    /UNIQUE|constraint/i,
    'one provenance row per (source, digest version)',
  );
  // A NEW digest version is allowed: history is kept, not clobbered.
  ins.run('s4', 'ghsa', 'x', 'CC-BY-4.0', 5, '4', NOW + 3);
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM corpus_sources').get().c, 3);
  db.close();
});

test('the learning store never writes outside recordOutcome', async () => {
  // Read-only callers must leave the table untouched. This guards the "no
  // writes outside recordOutcome" contract at the behavioural level.
  const db = makeDb();
  await seed(db, 'sol.dos', 'proven', 3);
  const before = db.raw.prepare('SELECT COUNT(*) c FROM learning_outcomes').get().c;

  await classStats(db);
  await classStats(db, 'sol.dos');
  blendedWeight('sol.dos', 0.8, (await classStats(db, 'sol.dos'))[0]);
  await learnedRanking(db, { classes: { 'sol.dos': { weight: 0.8 } } });

  const after = db.raw.prepare('SELECT COUNT(*) c FROM learning_outcomes').get().c;
  assert.equal(after, before);
  db.close();
});
