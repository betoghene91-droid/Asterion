#!/usr/bin/env node
/**
 * counterfactual.mjs — produce the second run that makes `proven` reachable.
 *
 * `judge()` demands a run per attempt whose result is INTERPRETABLE: the effect
 * must disappear for a stated reason. This script produces exactly one such run
 * per attempt, using the mechanism plan.mjs chose:
 *
 *   with_fix
 *     Apply the derived patch to the target source, re-run the SAME attack
 *     test, then restore the file. The test must PASS on the patched tree.
 *     Only planned when `spec.self_deployed` is true — a harness that attaches
 *     to a deployed address executes fork bytecode, so a source patch would not
 *     change what it runs and the "fix" would be an illusion.
 *
 *   without_precondition
 *     Run the generated `<test>_nocond` test as-is. It keeps the attack's own
 *     assertion and removes only the enabling condition. It must PASS.
 *
 * Both paths write `counterfactual/<test>.{log,exit}` through capture.mjs, so
 * the exit code recorded is the TEST's, never tee's.
 *
 * Two safety properties, both deliberate:
 *
 * 1. The target checkout is restored in a `finally`. A with-fix run mutates a
 *    real file; leaving it patched would corrupt every later attempt and make
 *    the whole bundle describe a program that never existed.
 * 2. A patch that does not apply EXACTLY as specified is never partially
 *    written. `applyEdits` refuses on any mismatch, and this script then
 *    records the refusal instead of running a half-patched tree.
 *
 * Exit codes:
 *   0  a counterfactual run was recorded (its PASS/FAIL is in the .exit file)
 *   0  no counterfactual could be produced — recorded as a reason, never fatal,
 *      because `partial` is a legitimate verdict and a missing counterfactual
 *      must not fail the workflow
 *   2  bad arguments
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './capture.mjs';
import { applyEdits, safeTargetFile } from './evidence.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const planPath = arg('plan');
const testName = arg('test');
const targetDir = arg('target');
const outDir = arg('out');

if (!planPath || !testName || !targetDir || !outDir) {
  console.error(
    'usage: counterfactual.mjs --plan plan.json --test <test_name> --target <dir> --out <dir>',
  );
  process.exit(2);
}

/**
 * Record that no counterfactual could be produced.
 *
 * Written to `<out>/<test>.reason` rather than faked into a `.exit` file: an
 * exit code that was never produced by a test must not exist anywhere on disk,
 * or some later reader will conclude a test ran.
 */
function recordMissing(reason) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${testName}.reason`), `${reason}\n`);
  console.log(`counterfactual ${testName}: none — ${reason}`);
  process.exit(0);
}

let plan;
try {
  plan = JSON.parse(readFileSync(planPath, 'utf8'));
} catch (e) {
  recordMissing(`the plan could not be read (${e instanceof Error ? e.message : String(e)})`);
}

const attempt = (plan.attempts ?? []).find((a) => a.test_name === testName);
if (!attempt) {
  recordMissing(`no attempt named ${testName} in the plan`);
}

const cf = attempt.counterfactual;
if (!cf || typeof cf !== 'object') {
  recordMissing('the plan did not choose a counterfactual mechanism for this attempt');
}

mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, `${testName}.log`);
const exitPath = join(outDir, `${testName}.exit`);

/** Run one forge test through capture.mjs's own runner, in the target tree. */
function runTest(name) {
  const cmd = `forge test --match-test '^${name}$' -vvv`;
  return runCapture(cmd, { cwd: targetDir, logPath, env: process.env });
}

if (cf.mechanism === 'without_precondition') {
  const nocond = typeof cf.test_name === 'string' ? cf.test_name : '';
  if (!nocond) recordMissing('the plan chose without_precondition but named no test to run');

  const src = join(targetDir, 'test', `${testName}.t.sol`);
  if (!existsSync(src)) recordMissing(`the generated test file ${src} is missing`);
  if (!readFileSync(src, 'utf8').includes(`function ${nocond}() public`)) {
    recordMissing(`the generated test file has no function ${nocond}()`);
  }

  const r = runTest(nocond);
  writeFileSync(exitPath, `EXIT=${r.exit_code}\n`);
  console.log(`counterfactual ${testName}: without_precondition ${nocond} -> EXIT=${r.exit_code}`);
  process.exit(0);
}

if (cf.mechanism !== 'with_fix') {
  recordMissing(`unknown counterfactual mechanism (${cf.mechanism})`);
}

// ── with_fix ───────────────────────────────────────────────────────────

const patch = cf.patch;
if (!patch || typeof patch !== 'object') {
  recordMissing('the plan chose with_fix but carries no derived patch');
}

const rel = safeTargetFile(patch.file);
if (!rel) recordMissing(`the patch names an unusable path (${patch.file})`);

const filePath = join(targetDir, rel);
if (!existsSync(filePath)) recordMissing(`the patch target ${rel} does not exist in the checkout`);

const original = readFileSync(filePath, 'utf8');
const edited = applyEdits(original, patch.edits ?? []);
if (!edited.ok) {
  // Refuse rather than write a partial patch: a half-applied fix would make the
  // "with-fix" run a different program than the rationale claims.
  recordMissing(`the derived patch does not apply: ${edited.reason}`);
}

// Keep a byte-exact copy so restore is guaranteed even if the test panics.
const backup = `${filePath}.asterion-orig`;
copyFileSync(filePath, backup);

let r;
try {
  writeFileSync(filePath, edited.source);
  r = runTest(testName);
} finally {
  // Always restore. A patched tree left behind would corrupt every later
  // attempt in this workflow run.
  try {
    copyFileSync(backup, filePath);
  } finally {
    rmSync(backup, { force: true });
  }
}

writeFileSync(exitPath, `EXIT=${r.exit_code}\n`);
console.log(
  `counterfactual ${testName}: with_fix (${rel}, ${edited.applied.length} edit(s)) -> EXIT=${r.exit_code}`,
);
console.log(`  rationale: ${patch.rationale ?? '(none given)'}`);
process.exit(0);
