/**
 * Corpus-path regression: "0 corpus rows" must never be indistinguishable from
 * "I could not find the corpus".
 *
 * Why this file exists. In the old two-tree layout `plan.mjs` looked for the
 * digest at cwd-relative paths ('v1/src/corpus-digest.json',
 * '../v1/src/corpus-digest.json'). When those missed it returned null and the
 * plan emitted no corpus, so `judge.mjs` wrote `corpus_rows: 0` into
 * verdicts.json. That 0 is a legitimate value for a corpus with no rows, so the
 * path bug was invisible — it read as data, not as an error.
 *
 * The flatten into one tree is exactly the change most likely to re-break this,
 * so these assertions are pinned: resolution must be module-relative (not cwd),
 * and absence must be explicit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const BUILD = join(APP, 'build');
const DIGEST = join(APP, 'src', 'corpus-digest.json');

const SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract V {
    mapping(address => uint) public bal;
    function init(address o) public { bal[o] = 1; }
    function w() external { payable(msg.sender).call{value: 1}(""); }
}
`;

/** A scratch target checkout with one contract that trips the scanner. */
function targetDir() {
  const root = mkdtempSync(join(tmpdir(), 'corpus-tgt-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'V.sol'), SOL);
  return root;
}

/** Run plan.mjs from a build copy, optionally with the digest present. */
function runPlan({ withDigest, cwd }) {
  const tree = mkdtempSync(join(tmpdir(), 'corpus-tree-'));
  cpSync(BUILD, tree, { recursive: true });
  if (withDigest) cpSync(DIGEST, join(tree, 'corpus-digest.json'));

  const tgt = targetDir();
  const out = join(tree, 'plan.json');
  const r = spawnSync(
    process.execPath,
    [join(tree, 'plan.mjs'), '--target', tgt, '--contract', 'V', '--out', out],
    { encoding: 'utf8', cwd },
  );
  const plan = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  return { r, plan, tree };
}

test('plan.mjs finds the digest from an unrelated working directory', () => {
  // cwd is deliberately NOT the app dir: this is the regression. The old code
  // resolved relative to cwd and would miss here.
  const elsewhere = mkdtempSync(join(tmpdir(), 'corpus-cwd-'));
  const { r, plan, tree } = runPlan({ withDigest: true, cwd: elsewhere });

  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(plan, 'plan.json was not written');
  assert.equal(plan.corpus.rows, 181357, 'corpus rows must be the real source_rows');
  assert.equal(plan.corpus.version, '5', 'must load the promoted v5 digest');
  assert.equal(plan.corpus.error, undefined, 'no corpus_error when the digest loaded');
  assert.ok(
    plan.corpus.path.startsWith(tree),
    `digest must resolve inside the build tree, not the archived ones; got ${plan.corpus.path}`,
  );
  rmSync(tree, { recursive: true, force: true });
});

test('a missing digest is recorded as an error, never as zero rows', () => {
  const { r, plan, tree } = runPlan({ withDigest: false, cwd: APP });

  assert.equal(r.status, 0, 'a missing corpus must not crash the plan step');
  assert.ok(plan, 'plan.json was not written');
  assert.equal(plan.corpus.rows, null, 'rows must be null, not 0, when the corpus is absent');
  assert.ok(
    typeof plan.corpus.error === 'string' && plan.corpus.error.length > 20,
    'an absent corpus must carry an explicit error string',
  );
  assert.match(r.stderr, /WARNING: corpus-digest\.json not found/, 'absence must be loud on stderr');
  rmSync(tree, { recursive: true, force: true });
});

test('corpus_rows: 0 and a missing corpus are different values in the verdicts', async () => {
  const { adjudicatePlan } = await import('../build/judge.mjs');

  const empty = adjudicatePlan(
    { contract: 'V', commit: 'c', attempts: [], corpus: { rows: 0 } },
    { resultsDir: mkdtempSync(join(tmpdir(), 'res-')), counterfactualDir: null },
  );
  assert.equal(empty.corpus_rows, 0, 'a real zero-row corpus stays 0');
  assert.equal(empty.corpus_error, null, 'a real zero-row corpus is not an error');

  const missing = adjudicatePlan(
    { contract: 'V', commit: 'c', attempts: [], corpus: { rows: null, error: 'not found' } },
    { resultsDir: mkdtempSync(join(tmpdir(), 'res-')), counterfactualDir: null },
  );
  assert.equal(missing.corpus_rows, null, 'a missing corpus must not be reported as 0');
  assert.equal(missing.corpus_error, 'not found', 'the reason must survive into the verdicts');
});
