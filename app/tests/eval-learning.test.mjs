// Tests for the eval harness, the CWE→web.* mapper, and the precision path.
//
// These are the gates that keep this change honest. Three of them exist because
// a previous agent DID the wrong thing and the file was reverted each time:
//
//   · invented a weight (e.g. 1.9) for a class with no measurements
//   · let `validatable` drift away from `n > 0`
//   · reported a detection rate for a tool that never ran
//
// Each of those is pinned below as a property over EVERY class, not a spot
// check, so a future edit that reintroduces one fails here.
//
// The Python halves run through `python3` because the harness and the mapper ARE
// Python; re-implementing their arithmetic in JS would test the re-implementation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  blendDetail,
  blendWithPrecision,
  blendedWeight,
  precisionFromRows,
  precisionFromScoring,
  DEFAULT_PRIOR_STRENGTH,
  DEFAULT_PRECISION_STRENGTH,
} from '../build/learn.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const EVAL = join(APP, 'eval');
const FIXTURES = join(EVAL, 'fixtures');
const DIGEST = join(APP, 'src', 'corpus-digest.json');

const digest = JSON.parse(readFileSync(DIGEST, 'utf8'));

/** Is python3 usable? If not, a Python gate is SKIPPED and says so. */
const python = (() => {
  const r = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
  return r.status === 0;
})();

/** Run a python3 snippet with `eval/` on sys.path. Returns parsed JSON or throws. */
function py(code, { timeout = 60_000 } = {}) {
  const script = `import sys, json\nsys.path.insert(0, ${JSON.stringify(EVAL)})\n${code}`;
  const r = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    cwd: APP,
    timeout,
  });
  if (r.status !== 0) {
    throw new Error(`python3 failed (${r.status}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function pyJson(code, opts) {
  return JSON.parse(py(code, opts));
}

// ───────────────────────────────────────── 1. honest-zero, EVERY class ─────

test('validatable == (n > 0) holds for every class in the shipped digest', () => {
  // Asserted independently of digest-union.test.mjs, which also checks this.
  // Duplicating a load-bearing invariant is deliberate: that file is immutable
  // from this task's scope, so if it is ever edited this guard still stands.
  const classes = Object.entries(digest.classes);
  assert.ok(classes.length >= 25, `expected at least 25 classes, got ${classes.length}`);

  const violations = [];
  for (const [cls, s] of classes) {
    if (s.validatable !== s.n > 0) {
      violations.push(`${cls}: n=${s.n} but validatable=${s.validatable}`);
    }
    if (s.n === 0 && s.weight !== 0) {
      violations.push(`${cls}: n=0 but weight=${s.weight} (unmeasured classes must be 0.0)`);
    }
    if (!Number.isFinite(s.weight) || s.weight < 0 || s.weight > 3) {
      violations.push(`${cls}: weight ${s.weight} outside 0..3`);
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('every web.* class with n=0 is unaverageable and stays at weight 0.0', () => {
  // The specific failure mode: a class at n=0 acquiring a plausible-looking
  // weight. Pinned per class so the message names the offender.
  const zero = Object.entries(digest.classes).filter(([, s]) => s.n === 0);
  for (const [cls, s] of zero) {
    assert.equal(s.validatable, false, `${cls} must not be validatable`);
    assert.equal(s.weight, 0, `${cls} must carry weight 0, not ${s.weight}`);
  }
  // web.graphql is the named case from the brief: it must still be empty.
  assert.equal(digest.classes['web.graphql'].n, 0);
});

// ─────────────────────────────── 2. anti-fabrication: unmeasured gains 0.0 ──

test('a class with NO measurement gains exactly 0.0 through the precision path', () => {
  // THE ANTI-FABRICATION CONTROL. This is the test that would have caught the
  // invented 1.9 weight: precision evidence that does not exist must not move
  // the estimate by any amount, for any digest weight, any payout history.
  const priors = [0, 0.0, 0.535, 0.797, 0.933, 1.167, 1.255, 2.415, 3];
  const histories = [
    null,
    undefined,
    { cls: 'x', attempted: 0, proven: 0, partial: 0, disproved: 0, inconclusive: 0, counted: 0, tierSum: 0, observedWeight: null, lastAt: null },
    { cls: 'x', attempted: 5, proven: 3, partial: 1, disproved: 1, inconclusive: 0, counted: 5, tierSum: 10, observedWeight: 2, lastAt: 1 },
    { cls: 'x', attempted: 40, proven: 0, partial: 40, disproved: 0, inconclusive: 0, counted: 40, tierSum: 40, observedWeight: 1, lastAt: 1 },
  ];
  // Every shape of "no measurement".
  const unmeasured = [
    null,
    undefined,
    { cls: 'x', precision: null, n: 0, provenance: 'fixture:none' },
    { cls: 'x', precision: 0.95, n: 0, provenance: 'fixture:claimed-but-n0' },
    { cls: 'x', precision: null, n: 999, provenance: 'fixture:null-precision' },
  ];

  for (const prior of priors) {
    for (const hist of histories) {
      const payout = blendedWeight('x', prior, hist ?? null);
      for (const p of unmeasured) {
        const d = blendWithPrecision('x', prior, hist ?? null, p ?? null);
        assert.equal(
          d.blended,
          payout,
          `prior=${prior} p=${JSON.stringify(p)}: unmeasured must not change the estimate ` +
            `(got ${d.blended}, payout-only ${payout})`,
        );
        assert.equal(d.reducedByPrecision, false, 'nothing was reduced, so nothing was measured');
        assert.equal(d.precisionN, 0, 'an unmeasured class must report precisionN 0');
        // Strict identity, not approximate: a first deploy must change nothing.
        assert.ok(Object.is(d.blended, payout), 'must be the identical double, not merely close');
      }
    }
  }
});

test('a zero-prior class with no measurement stays at zero, not "small but nonzero"', () => {
  // The 15 web.* classes today. A precision of 0.999 from nowhere must not lift
  // a 0.0 prior off the floor.
  const d = blendWithPrecision('web.graphql', 0, null, { cls: 'web.graphql', precision: 0.999, n: 0, provenance: 'x' });
  assert.equal(d.blended, 0);
  assert.ok(Object.is(d.blended, 0), 'must be +0, not a denormal');
});

// ───────────── 3. precision can only reduce; monotone; never manufactures ──

test('precision can only ever reduce the estimate, never manufacture it', () => {
  const stat = {
    cls: 'sol.reentrancy', attempted: 20, proven: 8, partial: 6, disproved: 6,
    inconclusive: 0, counted: 20, tierSum: 30, observedWeight: 1.5, lastAt: 1,
  };
  const payout = blendedWeight('sol.reentrancy', 0.996, stat);

  for (const precision of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 1]) {
    for (const n of [1, 2, 5, 12, 50, 500, 10_000]) {
      const d = blendWithPrecision('sol.reentrancy', 0.996, stat, {
        cls: 'sol.reentrancy', precision, n, provenance: 'test',
      });
      assert.ok(
        d.blended <= payout + 1e-12,
        `precision=${precision} n=${n}: blended ${d.blended} must not exceed payout-only ${payout}`,
      );
      assert.ok(d.blended >= 0, 'blended must not go negative');
      assert.equal(d.payoutOnly, payout, 'payoutOnly must be exactly the payout-only estimate');
    }
  }
});

test('a precision of exactly 1.0 changes nothing, and 0.5 with large n halves it', () => {
  const stat = {
    cls: 'sol.dos', attempted: 30, proven: 10, partial: 10, disproved: 10,
    inconclusive: 0, counted: 30, tierSum: 40, observedWeight: 4 / 3, lastAt: 1,
  };
  const payout = blendedWeight('sol.dos', 0.799, stat);

  const perfect = blendWithPrecision('sol.dos', 0.799, stat, { cls: 'sol.dos', precision: 1, n: 5000, provenance: 't' });
  assert.ok(Math.abs(perfect.blended - payout) < 1e-9, `perfect precision must be neutral, got ${perfect.blended} vs ${payout}`);
  assert.equal(perfect.reducedByPrecision, false);

  const half = blendWithPrecision('sol.dos', 0.799, stat, { cls: 'sol.dos', precision: 0.5, n: 500_000, provenance: 't' });
  assert.ok(Math.abs(half.blended - payout * 0.5) < 1e-4, `expected ~${payout * 0.5}, got ${half.blended}`);

  // A caller passing >1 must still not be able to inflate.
  const cheat = blendWithPrecision('sol.dos', 0.799, stat, { cls: 'sol.dos', precision: 5, n: 10_000, provenance: 't' });
  assert.ok(cheat.blended <= payout + 1e-12, `precision >1 must be clamped, got ${cheat.blended} > ${payout}`);
});

test('more evidence of a noisy detector reduces the estimate monotonically', () => {
  const stat = {
    cls: 'sol.accesscontrol', attempted: 10, proven: 5, partial: 5, disproved: 0,
    inconclusive: 0, counted: 10, tierSum: 20, observedWeight: 2, lastAt: 1,
  };
  let prev = Infinity;
  for (const n of [1, 2, 4, 8, 16, 64, 256, 1024]) {
    const d = blendWithPrecision('sol.accesscontrol', 0.933, stat, {
      cls: 'sol.accesscontrol', precision: 0.2, n, provenance: 't',
    });
    assert.ok(d.blended < prev, `n=${n}: a noisy detector with more evidence must reduce further (${d.blended} !< ${prev})`);
    prev = d.blended;
  }
});

test('precisionStrength must be positive, and a bigger k holds nearer the payout estimate', () => {
  const stat = {
    cls: 'sol.upgrade', attempted: 10, proven: 5, partial: 0, disproved: 5,
    inconclusive: 0, counted: 10, tierSum: 15, observedWeight: 1.5, lastAt: 1,
  };
  for (const bad of [0, -1, NaN, Infinity, '12']) {
    assert.throws(
      () => blendWithPrecision('sol.upgrade', 0.651, stat, { cls: 'sol.upgrade', precision: 0.5, n: 4, provenance: 't' }, { precisionStrength: bad }),
      RangeError,
    );
  }
  const p = { cls: 'sol.upgrade', precision: 0.5, n: 4, provenance: 't' };
  const loose = blendWithPrecision('sol.upgrade', 0.651, stat, p, { precisionStrength: 1 }).blended;
  const tight = blendWithPrecision('sol.upgrade', 0.651, stat, p, { precisionStrength: 1000 }).blended;
  const payout = blendedWeight('sol.upgrade', 0.651, stat);
  assert.ok(Math.abs(tight - payout) < Math.abs(loose - payout), 'a larger k must stay nearer the payout-only estimate');
});

test('the documented shrinkage constants are what the code uses', () => {
  assert.equal(DEFAULT_PRIOR_STRENGTH, 12, 'payout shrinkage k is 12');
  assert.equal(DEFAULT_PRECISION_STRENGTH, 12, 'precision shrinkage k is 12');
});

// ────────────────────────── 4. precisionFromRows / precisionFromScoring ─────

test('precisionFromRows pools tp/fp, and a class that never fired is null not 0', () => {
  const m = precisionFromRows(
    [
      { cls: 'sol.reentrancy', tp: 1, fp: 4, tool: 'aderyn' },
      { cls: 'sol.reentrancy', tp: 1, fp: 1, tool: 'slither' },
      { cls: 'sol.rounding', tp: 3, fp: 0, tool: 'aderyn' },
      { cls: 'sol.oracle', tp: 0, fp: 0 },
    ],
    'fixture:test',
  );
  assert.equal(m.get('sol.reentrancy').precision, 2 / 7);
  assert.equal(m.get('sol.reentrancy').n, 7);
  assert.equal(m.get('sol.rounding').precision, 1);
  // Zero denominator is "never measured", NOT "0% precise".
  assert.equal(m.get('sol.oracle').precision, null);
  assert.equal(m.get('sol.oracle').n, 0);
  assert.equal(m.get('nope'), undefined);
});

test('precisionFromScoring reads only per_class blocks and tolerates absence', () => {
  assert.deepEqual([...precisionFromScoring(null, 'x').keys()], []);
  assert.deepEqual([...precisionFromScoring({}, 'x').keys()], []);
  assert.deepEqual([...precisionFromScoring({ tools: { slither: {} } }, 'x').keys()], []);
  const m = precisionFromScoring(
    { per_class: [{ cls: 'sol.dos', tp: 1, fp: 1, fn: 0, tools: ['detect.py'] }] },
    'fixture:scoring',
  );
  assert.equal(m.get('sol.dos').precision, 0.5);
  assert.equal(m.get('sol.dos').provenance, 'fixture:scoring');
});

test('precisionFromRows drops negative or non-finite counts instead of trusting them', () => {
  const m = precisionFromRows(
    [
      { cls: 'sol.dos', tp: -1, fp: 2 },
      { cls: 'sol.dos', tp: NaN, fp: 2 },
      { cls: 'sol.dos', tp: 2, fp: Infinity },
      { cls: '', tp: 1, fp: 1 },
    ],
    'x',
  );
  assert.equal(m.size, 0, 'no row survived, so nothing was measured');
});

// ───────────────── 5. CWE → web.* is deterministic; unmapped yields none ────

test('the CWE → web.* mapping is deterministic and an unmapped CWE yields NO class', { skip: !python && 'python3 unavailable' }, () => {
  const out = pyJson(`
import web2_ground_truth as w
cases = []
# Same input set, many orderings: the answer must not depend on order.
import itertools
ids = ["CWE-89","CWE-862","CWE-918"]
seen = set()
for perm in itertools.permutations(ids):
    seen.add(w.class_from_cwe(list(perm)))
cases.append({"multi_order_results": sorted(seen)})
# Determinism across repeated calls with the same input.
calls = {w.class_from_cwe(["CWE-79"]) for _ in range(50)}
cases.append({"repeat_results": sorted(calls)})
# Individual mappings.
for cwe in ["CWE-639","CWE-89","CWE-918","CWE-79","CWE-22","CWE-434","CWE-942","CWE-1321","CWE-601","CWE-362"]:
    cases.append({cwe: w.class_from_cwe([cwe])})
# Deliberately unmapped: must be None, NOT a nearest-keyword guess.
for cwe in ["CWE-94","CWE-78","CWE-77","CWE-200","CWE-9999","CWE-1333"]:
    cases.append({"unmapped_"+cwe: w.class_from_cwe([cwe])})
# No CWEs at all.
cases.append({"empty": w.class_from_cwe([])})
print(json.dumps(cases))
`);
  const multi = out.find((c) => c.multi_order_results);
  assert.equal(multi.multi_order_results.length, 1, 'permutation of the same CWEs must give ONE answer');

  const repeat = out.find((c) => c.repeat_results);
  assert.deepEqual(repeat.repeat_results, ['web.xss.reflected'], 'repeated calls must agree');

  const byCwe = Object.assign({}, ...out.filter((c) => !c.multi_order_results && !c.repeat_results));
  assert.equal(byCwe['CWE-639'], 'web.idor');
  assert.equal(byCwe['CWE-89'], 'web.sqli');
  assert.equal(byCwe['CWE-918'], 'web.ssrf');
  assert.equal(byCwe['CWE-79'], 'web.xss.reflected');
  assert.equal(byCwe['CWE-22'], 'web.traversal');
  assert.equal(byCwe['CWE-434'], 'web.upload');
  assert.equal(byCwe['CWE-942'], 'web.cors');
  assert.equal(byCwe['CWE-1321'], 'web.massassign');
  assert.equal(byCwe['CWE-601'], 'web.oauth');

  // THE POINT: an undecided CWE gets no class rather than a guess.
  for (const cwe of ['CWE-94', 'CWE-78', 'CWE-77', 'CWE-200', 'CWE-9999', 'CWE-1333']) {
    assert.equal(byCwe[`unmapped_${cwe}`], null, `${cwe} must map to no class, not to a guess`);
  }
  assert.equal(byCwe.empty, null, 'no CWEs means no class');

  // And every mapped class must be a web.* class this repo actually ranks.
  for (const v of Object.values(byCwe)) {
    if (v) assert.match(v, /^web\./, `mapped to a non-web class: ${v}`);
  }
});

test('the mapper imports ingest-more for its CWE table rather than duplicating it', { skip: !python && 'python3 unavailable' }, () => {
  // Two copies of CWE_TO_CLASS would drift, and the drift would be invisible:
  // one file would start attributing rows the other refuses.
  //
  // Identity (`is`) is the wrong assertion here — it fails on module-loading
  // mechanics (the test process may import ingest-more under a second name
  // without any duplication existing). What actually matters: same CONTENTS,
  // nothing extra on either side, and no second literal table in the source.
  const out = pyJson(`
import web2_ground_truth as w
import importlib.util, sys
spec = importlib.util.spec_from_file_location("im_check", "eval/ingest-more.py")
im = importlib.util.module_from_spec(spec); sys.modules["im_check"] = im; spec.loader.exec_module(im)
print(json.dumps({
  "equal_contents": dict(w.CWE_TO_CLASS) == dict(im.CWE_TO_CLASS),
  "len_w": len(w.CWE_TO_CLASS), "len_im": len(im.CWE_TO_CLASS),
  "only_in_w": sorted(set(w.CWE_TO_CLASS) - set(im.CWE_TO_CLASS)),
  "only_in_im": sorted(set(im.CWE_TO_CLASS) - set(w.CWE_TO_CLASS)),
  "value_diff": sorted(k for k in w.CWE_TO_CLASS
                       if k in im.CWE_TO_CLASS and w.CWE_TO_CLASS[k] != im.CWE_TO_CLASS[k]),
  "no_class_same": set(w.CWE_NO_CLASS) == set(im.CWE_NO_CLASS),
  "delegates": all(w.class_from_cwe([c]) == im.class_from_cwe([c]) for c in list(im.CWE_TO_CLASS)[:20]),
}))
`);
  assert.deepEqual(out.only_in_w, [], 'web2_ground_truth must not add CWEs ingest-more does not have');
  assert.deepEqual(out.only_in_im, [], 'web2_ground_truth must not omit CWEs ingest-more has');
  assert.deepEqual(out.value_diff, [], 'the two tables must map identical CWEs identically');
  assert.equal(out.equal_contents, true);
  assert.equal(out.no_class_same, true, 'the deliberately-unmapped set must be shared too');
  assert.equal(out.delegates, true, 'class_from_cwe must delegate, not reimplement the tie-break');

  // And structurally: no second literal CWE table in the mapper's source.
  const src = readFileSync(join(EVAL, 'web2_ground_truth.py'), 'utf8');
  const literals = src.match(/"CWE-\d+"\s*:\s*"web\./g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `web2_ground_truth.py must not declare its own CWE table (found ${literals.length} literals)`,
  );
});

// ─────────────── 6. the committed web2 fixture parses and stays honest ──────

test('the GHSA fixture yields real per-class counts and keeps web.graphql at 0', { skip: !python && 'python3 unavailable' }, () => {
  const out = pyJson(`
import json, web2_ground_truth as w
payload = json.load(open("eval/fixtures/ghsa-advisories.json"))
res = w.ingest(iter(payload["advisories"]))
# Strip the per-class dict to what the assertions need.
print(json.dumps({
  "seen": res["advisories_seen"],
  "mapped": res["advisories_mapped"],
  "skipped": res["skipped"],
  "classes": res["classes"],
}))
`);
  assert.ok(out.seen >= 50, `fixture should hold a real sample, got ${out.seen}`);
  assert.ok(out.mapped > 0, 'the fixture must actually map advisories, not classify them all as no_cwe');

  for (const [cls, s] of Object.entries(out.classes)) {
    assert.match(cls, /^web\./, `only web.* classes belong here, got ${cls}`);
    // The honest-zero rule, at the source.
    assert.equal(s.validatable, s.n > 0, `${cls}: validatable must be exactly n>0`);
    if (s.n === 0) assert.equal(s.weight, 0, `${cls}: unmeasured must be 0.0`);
    assert.ok(s.n >= 0 && s.severe <= s.n, `${cls}: severe ${s.severe} exceeds n ${s.n}`);
  }
  // web.graphql has no CWE in the table and must not acquire one.
  assert.equal(out.classes['web.graphql'].n, 0);
  assert.equal(out.classes['web.graphql'].validatable, false);
  assert.equal(out.classes['web.graphql'].weight, 0);

  // Skips are named, never silent.
  const skippedTotal = Object.values(out.skipped).reduce((a, b) => a + b, 0);
  assert.equal(out.seen - out.mapped, skippedTotal, 'every unmapped advisory must be accounted for by a named reason');
});

test('the ghsa fixture keeps its original nesting (the bug that broke it once)', () => {
  const fx = JSON.parse(readFileSync(join(FIXTURES, 'ghsa-advisories.json'), 'utf8'));
  assert.ok(Array.isArray(fx.advisories) && fx.advisories.length > 0);
  assert.equal(fx.licence, 'CC-BY-4.0');
  for (const a of fx.advisories) {
    assert.equal(typeof a.id, 'string');
    // Flattening cwe_ids to the record root silently reclassifies every record
    // as no_cwe. The fixture must carry the shape the mapper reads.
    assert.ok(a.database_specific, `${a.id}: database_specific must be preserved`);
    assert.ok(Array.isArray(a.database_specific.cwe_ids), `${a.id}: cwe_ids must stay under database_specific`);
  }
});

// ───────────────────── 7. the live capture artifact is trustworthy ─────────

test('the committed detector capture records tool versions, commits and failures', () => {
  const cap = JSON.parse(readFileSync(join(FIXTURES, 'live-detector-runs.json'), 'utf8'));
  assert.ok(cap.captured_at, 'capture must be timestamped');
  assert.ok(cap.toolchain, 'capture must record what was installed');
  assert.ok(Array.isArray(cap.projects) && cap.projects.length >= 3);

  for (const p of cap.projects) {
    assert.match(p.commit, /^[0-9a-f]{40}$/, `${p.id}: commit must be a full sha`);
    assert.ok(p.repo.includes('/'), `${p.id}: repo must be resolvable`);
    assert.ok(p.ground_truth && Object.keys(p.ground_truth).length > 0, `${p.id}: ground truth required`);
    for (const [cls, n] of Object.entries(p.ground_truth)) {
      assert.match(cls, /^sol\./, `${p.id}: only sol.* ground truth belongs in this capture`);
      assert.ok(Number.isInteger(n) && n > 0, `${p.id}/${cls}: ground truth count must be a positive int`);
    }
    assert.ok(p.runs.length >= 1, `${p.id}: at least one detector must be attempted`);
    for (const r of p.runs) {
      // A run either ran (and may have hits) or did not run (and MUST explain).
      if (!r.available) {
        assert.ok(
          typeof r.error === 'string' && r.error.length > 10,
          `${p.id}/${r.tool}: an unavailable tool must carry a real reason, got ${JSON.stringify(r.error)}`,
        );
        assert.deepEqual(r.hits, [], `${p.id}/${r.tool}: an unavailable tool must claim no hits`);
      }
      assert.equal(typeof r.duration_s, 'number');
    }
  }
});

test('a tool that did not run is excluded from every ratio, never scored as 0', { skip: !python && 'python3 unavailable' }, () => {
  // The poodl project has 2 of 3 tools unavailable. Its tp/fp/fn must not enter
  // the pool — otherwise "never ran" becomes "found nothing".
  const out = pyJson(`
import json, scoring
cap = json.load(open("eval/fixtures/live-detector-runs.json"))
res = scoring.score_capture(cap)
print(json.dumps({
  "tools": {k: {"tp": v["tp"], "fp": v["fp"], "fn": v["fn"],
                "measured": v["projects_measured"], "unavailable": v["projects_unavailable"],
                "unavail": v["unavailability"]} for k, v in res["tools"].items()},
  "n_projects": res["n_projects"],
  "per_class": res["per_class"],
}))
`);
  const slither = out.tools.slither;
  assert.equal(slither.unavailable, 1, 'slither could not compile exactly one project');
  assert.equal(slither.measured, 2, 'and must be pooled over the two it did compile');
  assert.ok(Object.keys(slither.unavail).length === 1);

  // The exclusion, proven by construction: recompute the pooled totals by hand
  // from only measured projects, and require an exact match.
  const cap = JSON.parse(readFileSync(join(FIXTURES, 'live-detector-runs.json'), 'utf8'));
  const vocab = out.per_class.map((r) => r.cls);
  for (const [tool, body] of Object.entries(out.tools)) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of cap.projects) {
      const run = p.runs.find((r) => r.tool === tool);
      if (!run || !run.available) continue; // <-- the exclusion
      const hits = new Set(run.hits);
      for (const cls of vocab) {
        const hit = hits.has(cls);
        const present = (p.ground_truth[cls] ?? 0) > 0;
        if (hit && present) tp++;
        else if (hit && !present) fp++;
        else if (present) fn++;
      }
    }
    assert.equal(body.tp, tp, `${tool}: tp must equal the hand-computed measured-only total`);
    assert.equal(body.fp, fp, `${tool}: fp must equal the hand-computed measured-only total`);
    assert.equal(body.fn, fn, `${tool}: fn must equal the hand-computed measured-only total`);
  }
});

test('per_class precision is null when a class never fired, and pools tp/fp by hand', { skip: !python && 'python3 unavailable' }, () => {
  const out = pyJson(`
import json, scoring
cap = json.load(open("eval/fixtures/live-detector-runs.json"))
print(json.dumps(scoring.score_capture(cap)["per_class"]))
`);
  const byCls = Object.fromEntries(out.map((r) => [r.cls, r]));

  // web.* must never appear: this capture is Solidity ground truth.
  assert.deepEqual(out.filter((r) => r.cls.startsWith('web.')), []);

  // sol.oracle: 3 expert findings across projects, no tool ever fired on it.
  const oracle = byCls['sol.oracle'];
  assert.equal(oracle.tp, 0);
  assert.equal(oracle.fp, 0);
  assert.equal(oracle.precision, null, 'a class nothing fired on is UNMEASURED, not 0% precise');
  assert.equal(oracle.measured, false);

  // For every measured row, precision must be exactly tp/(tp+fp).
  for (const r of out) {
    if (r.precision === null) {
      assert.equal(r.tp + r.fp, 0, `${r.cls}: null precision requires a zero denominator`);
      assert.equal(r.measured, false);
    } else {
      assert.ok(Math.abs(r.precision - r.tp / (r.tp + r.fp)) < 1e-4, `${r.cls}: precision must be tp/(tp+fp)`);
      assert.equal(r.measured, true);
    }
  }
});

// ───────────────── 8. harness runs, and never fakes a live measurement ──────

test('the harness scores the fixture and labels the provenance as fixture:', { skip: !python && 'python3 unavailable' }, () => {
  const out = pyJson(
    `
import json, subprocess, sys, os
env = dict(os.environ); env.pop("CORPUS", None)
# Point DATA at a non-existent corpus so this test does not need 100 MB.
env["CORPUS"] = "/nonexistent/findings.jsonl.gz"
p = subprocess.run([sys.executable, "eval/harness.py"], capture_output=True, text=True, env=env, timeout=300)
print(json.dumps({"rc": p.returncode, "stdout": p.stdout[:4000], "stderr": p.stderr[:1000]}))
`,
    { timeout: 320_000 },
  );
  assert.equal(out.rc, 0, `harness exited ${out.rc}: ${out.stderr}`);
  // The provenance label must be present and must say fixture, not live.
  assert.match(out.stdout, /provenance: `fixture:/, 'fixture mode must be labelled');
  assert.match(out.stdout, /Class-level, not instance-level/, 'the class-level caveat must survive into the report');
});

// ───────────────────────── 9. scope: no schema, no workflow changes ────────

test('this change adds no D1 table and no workflow: eval/ + learn.ts only', () => {
  // A guard against the tempting shortcut of "just add a table for precision".
  // The required migration, if one is ever needed, must be a documented
  // follow-up — not an edit here.
  const schema = readFileSync(join(APP, 'schema.sql'), 'utf8');
  for (const t of ['precision', 'detector_eval', 'eval_precision', 'class_precision']) {
    assert.equal(
      schema.includes(`CREATE TABLE IF NOT EXISTS ${t}`),
      false,
      `schema.sql must not gain a ${t} table in this task`,
    );
  }

  // The eval tree must be self-contained Python that imports nothing exotic.
  const files = readdirSync(EVAL).filter((f) => f.endsWith('.py'));
  assert.ok(files.length >= 4, `expected the eval modules to be present, got ${files}`);
  for (const f of files) {
    const text = readFileSync(join(EVAL, f), 'utf8');
    for (const banned of ['import requests', 'import pandas', 'import numpy', 'import yaml']) {
      assert.equal(text.includes(banned), false, `${f} must stay stdlib-only (found ${banned})`);
    }
  }
});

test('every python module in eval/ compiles and is importable', { skip: !python && 'python3 unavailable' }, () => {
  const files = readdirSync(EVAL).filter((f) => f.endsWith('.py')).sort();
  assert.ok(files.length > 0);
  for (const f of files) {
    const r = spawnSync('python3', ['-m', 'py_compile', join(EVAL, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f} does not compile:\n${r.stderr}`);
  }
});
