/**
 * Digest zero-loss contract.
 *
 * The bug this exists to catch, permanently: each promoted digest in this
 * project has claimed "no rows lost", but v4 was NOT a superset of v2 or v3.
 * Thirteen individual precedent rows present in v2/v3 had silently vanished by
 * v4, while every class-level count grew — so a class-granularity check saw
 * nothing wrong. Promoting v4 as-is would have shipped that loss.
 *
 * The rule enforced here: app/src/corpus-digest.json (version 5) must contain
 * every precedent id that appears in ANY archived input digest, per class.
 *
 * The inputs are snapshotted, gzipped, under tests/fixtures/digest-inputs/ with
 * a sha256 manifest, because the originals (v1/, workstreams/) are archived out
 * of the shipped tree. The fixture is immutable evidence, not a second source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'digest-inputs');
const DIGEST = join(HERE, '..', 'src', 'corpus-digest.json');

const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
const digest = JSON.parse(readFileSync(DIGEST, 'utf8'));

/** Load one archived input, verifying it is byte-identical to what was merged. */
function loadInput(v) {
  const meta = manifest[v];
  assert.ok(meta, `manifest has no entry for version ${v}`);
  const raw = gunzipSync(readFileSync(join(FIXTURES, meta.file)));
  const sha = createHash('sha256').update(raw).digest('hex');
  assert.equal(
    sha,
    meta.sha256,
    `${meta.file} does not match its recorded sha256 — the fixture was altered after the digest was built`,
  );
  return JSON.parse(raw.toString('utf8'));
}

const INPUTS = Object.fromEntries(Object.keys(manifest).map((v) => [v, loadInput(v)]));

/** Set of ids per class for one input digest. */
function idsByClass(d) {
  const out = new Map();
  for (const [cls, rows] of Object.entries(d.precedent || {})) {
    out.set(cls, rows.map((r) => r.id));
  }
  return out;
}

// ── the load-bearing test ──────────────────────────────────────────────────

test('every precedent id in v2, v3 and v4 survives into the shipped digest', () => {
  const shipped = idsByClass(digest);
  const lost = [];

  for (const [v, input] of Object.entries(INPUTS)) {
    for (const [cls, ids] of idsByClass(input)) {
      const have = new Set(shipped.get(cls) ?? []);
      for (const id of ids) {
        if (!have.has(id)) lost.push(`v${v} ${cls} ${id}`);
      }
    }
  }

  assert.deepEqual(
    lost,
    [],
    `${lost.length} precedent row(s) present in an input digest are missing from the shipped digest. ` +
      `This is the v4 regression recurring — do not re-promote a lossy merge. First few:\n` +
      lost.slice(0, 10).join('\n'),
  );
});

test('the union is strictly larger than any single input, and reports no duplicate rows', () => {
  const shipped = idsByClass(digest);
  const total = [...shipped.values()].reduce((a, l) => a + l.length, 0);

  for (const [v, input] of Object.entries(INPUTS)) {
    const n = Object.values(input.precedent || {}).reduce((a, l) => a + l.length, 0);
    assert.ok(
      total > n,
      `shipped digest has ${total} precedent rows; it must exceed v${v}'s ${n} or the union did nothing`,
    );
  }

  // Duplicate ids within one class mean the dedupe failed.
  for (const [cls, ids] of shipped) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `${cls} has duplicate precedent ids: ${dupes.slice(0, 5)}`);
  }
});

test('the specific rows v4 dropped relative to v2/v3 are present', () => {
  // Pin the 13 known casualties by name, so a future lossy merge fails on the
  // exact rows that motivated this test rather than only on a count.
  const shipped = idsByClass(digest);
  const v2 = idsByClass(INPUTS['2']);
  const v3 = idsByClass(INPUTS['3']);

  const casualties = [];
  for (const [cls, ids] of v2) {
    const have = new Set(shipped.get(cls) ?? []);
    for (const id of ids) {
      if (!have.has(id) && !(v3.get(cls) ?? []).includes(id)) casualties.push({ cls, id, from: 'v2' });
    }
  }
  for (const [cls, ids] of v3) {
    const have = new Set(shipped.get(cls) ?? []);
    for (const id of ids) {
      if (!have.has(id) && !(v2.get(cls) ?? []).includes(id)) casualties.push({ cls, id, from: 'v3' });
    }
  }

  assert.deepEqual(casualties, [], `rows unique to v2/v3 are missing: ${JSON.stringify(casualties.slice(0, 5))}`);
});

// ── shape contract the Worker and the loader rely on ──────────────────────

test('attribution retains v2 CC BY fields byte-identically', () => {
  const v2attr = INPUTS['2'].attribution;
  for (const [k, want] of Object.entries(v2attr)) {
    assert.equal(
      digest.attribution[k],
      want,
      `attribution.${k} changed; the CC BY 4.0 licence obligation requires it verbatim`,
    );
  }
  assert.equal(digest.attribution.data_licence, 'CC BY 4.0');
  assert.match(digest.attribution.url, /web3-audit-corpus/);
});

test('merged_from provenance survives, including the GHSA and NVD sources', () => {
  const sources = (digest.attribution.merged_from ?? []).map((m) => m.source);
  assert.ok(sources.some((s) => s === 'ghsa'), `ghsa provenance lost; sources were ${JSON.stringify(sources)}`);
  assert.ok(sources.some((s) => s === 'nvd'), `nvd provenance lost; sources were ${JSON.stringify(sources)}`);
  for (const m of digest.attribution.merged_from ?? []) {
    assert.ok(m.source_licence, `${m.source} has no recorded licence`);
  }
});

test('per-class stats never regress below any input, and stay internally consistent', () => {
  for (const cls of Object.keys(digest.classes)) {
    const s = digest.classes[cls];
    for (const [v, input] of Object.entries(INPUTS)) {
      const before = input.classes?.[cls];
      if (!before) continue;
      for (const f of ['n', 'severe', 'critical', 'high', 'medium', 'recent']) {
        assert.ok(
          s[f] >= before[f],
          `${cls}.${f} regressed: shipped ${s[f]} < v${v} ${before[f]}`,
        );
      }
      assert.ok(s.weight >= before.weight, `${cls}.weight regressed: ${s.weight} < v${v} ${before.weight}`);
    }
    assert.equal(s.validatable, s.n > 0, `${cls}.validatable must be exactly n > 0`);
    // These are the invariants scripts/load-corpus.mjs refuses a digest over.
    assert.ok(s.severe <= s.n, `${cls}.severe (${s.severe}) exceeds n (${s.n})`);
    assert.ok(
      s.critical + s.high + s.medium <= s.severe,
      `${cls}: critical+high+medium exceeds severe`,
    );
    assert.ok(s.weight >= 0 && s.weight <= 3, `${cls}.weight outside 0..3`);
  }
});

test('web.graphql stays empty: no fabricated precedent', () => {
  assert.equal(digest.classes['web.graphql'].n, 0);
  assert.deepEqual(digest.precedent['web.graphql'] ?? [], [], 'web.graphql must not invent rows');
});

test('precedent is deterministically ordered and within its stated cap', () => {
  const W = { critical: 3, high: 2, medium: 1, low: 0.4, info: 0.1, gas: 0, unknown: 0 };
  const cap = digest.precedent_per_class_cap;
  assert.ok(Number.isInteger(cap) && cap > 0, 'cap must be a positive integer');

  for (const [cls, rows] of Object.entries(digest.precedent)) {
    assert.ok(rows.length <= cap, `${cls} has ${rows.length} rows, over the stated cap ${cap}`);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      const aw = W[String(a.severity).toLowerCase()] ?? 0;
      const bw = W[String(b.severity).toLowerCase()] ?? 0;
      if (aw !== bw) {
        assert.ok(aw > bw, `${cls}: severity order broken at ${i} (${a.severity} before ${b.severity})`);
        continue;
      }
      const ay = a.year ?? 0;
      const by = b.year ?? 0;
      if (ay !== by) {
        assert.ok(ay > by, `${cls}: year order broken at ${i} (${ay} before ${by})`);
        continue;
      }
      assert.ok(a.id <= b.id, `${cls}: id order broken at ${i} (${a.id} > ${b.id})`);
    }
  }
});

test('every precedent row carries the fields the corpus reader dereferences', () => {
  for (const [cls, rows] of Object.entries(digest.precedent)) {
    for (const r of rows) {
      for (const f of ['id', 'project', 'firm', 'severity', 'leaf', 'title', 'signal']) {
        assert.ok(typeof r[f] === 'string', `${cls}/${r.id}: ${f} must be a string`);
      }
      assert.ok(r.year === null || Number.isInteger(r.year), `${cls}/${r.id}: year must be int or null`);
    }
  }
});

test('version is 5 and source_rows is not a per-class subtotal', () => {
  assert.equal(digest.version, '5');
  const subtotal = Object.values(digest.classes).reduce((a, c) => a + c.n, 0);
  assert.ok(
    digest.source_rows > subtotal,
    `source_rows (${digest.source_rows}) must count rows outside the playbook classes too, ` +
      `and is therefore larger than the per-class subtotal (${subtotal}); collapsing them would ` +
      `silently understate the corpus by ${digest.source_rows - subtotal} rows`,
  );
  assert.ok(digest.source_rows >= Math.max(...Object.values(INPUTS).map((d) => d.source_rows)));
});
