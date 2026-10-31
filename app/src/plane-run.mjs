#!/usr/bin/env node
/**
 * plane-run.mjs — execute one non-EVM harness and record evidence in the shape
 * `judge()` already understands.
 *
 * WHY ONE RUNNER INSTEAD OF THREE
 *
 * The EVM plane has `plan.mjs`, `capture.mjs`, `counterfactual.mjs` and
 * `judge.mjs` because Foundry needs a plan (which test to synthesise), a capture
 * (whose exit status survives a tee), a patch step and a judge. The non-EVM
 * planes need exactly the same four THINGS but not four scripts: there is one
 * generator, one runner and one counterfactual mechanism per plane, so splitting
 * them would produce three near-identical files whose differences nobody could
 * see. What must NOT be shared is the judge — and it is not: this script only
 * records, and `judge.mjs` decides.
 *
 * WHAT THIS WRITES, AND WHY IN THESE DIRECTORIES
 *
 *   results/<test>.{log,exit}          run 1 — the attack
 *   controls/<test>_control.{log,exit} the fixture check
 *   counterfactual/<test>.{log,exit}   run 2 — causality
 *
 * Those are the same paths `prove.yml` produces, deliberately: `judge.mjs` reads
 * `results/` and `counterfactual/` and nothing about it changes for a non-EVM
 * plane. That is what makes a Solana or web verdict comparable to a Foundry one
 * rather than a parallel scoring system with its own definition of proof.
 *
 * EXIT CODES
 *
 *   0  the run completed and evidence was recorded (its PASS/FAIL is in .exit)
 *   2  bad arguments, or a harness this plan does not implement
 *   3  a precondition for the run was absent (a missing binary, a missing .so);
 *      recorded as a reason, NOT as a failing test, so it cannot look like
 *      `reproduced`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapture, shQuote } from './capture.mjs';
import { synthesizePlaneHarness } from './plane-harness.js';
import { applyEdits, safeTargetFile } from './evidence.js';
import { deriveSolanaPatch } from './plane-patch.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const playbook = arg('playbook');
const workDir = arg('work-dir') || process.cwd();
const targetDir = arg('target') || '';
const outRoot = arg('out') || workDir;

if (!playbook) {
  console.error(
    'usage: plane-run.mjs --playbook <id> [--target <dir>] [--work-dir <dir>] [--out <dir>]',
  );
  process.exit(2);
}

const spec = synthesizePlaneHarness(playbook);
if (!spec) {
  console.error(
    `${playbook}: no non-EVM harness. This runner implements: web.jwt, web.takeover, sol.svm-signer.`,
  );
  process.exit(2);
}

const resultsDir = join(outRoot, 'results');
const controlsDir = join(outRoot, 'controls');
const counterfactualDir = join(outRoot, 'counterfactual');
for (const d of [resultsDir, controlsDir, counterfactualDir]) mkdirSync(d, { recursive: true });

/** Write the harness files beside the work dir, never into the target checkout. */
for (const f of spec.files) {
  const dest = join(workDir, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.body);
  console.log(`wrote ${dest} (${f.body.length} bytes)`);
}

const scriptPath = join(workDir, spec.files[0].path);

/**
 * Record a refused precondition.
 *
 * A `.reason` file, not a `.exit`: an exit code that no test produced must not
 * exist on disk, or a later reader concludes a test ran. `judge.mjs` reads this
 * file and reports the run as never-recorded, which is the truthful outcome.
 */
function refuse(where, reason) {
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, `${spec.test_name}.reason`), `${reason}\n`);
  console.error(`${spec.test_name}: cannot run — ${reason}`);
  process.exit(3);
}

/** Run the harness in one mode, with its exit status captured honestly. */
function runMode(mode, logPath, extraEnv = {}) {
  const cmd = `node ${shQuote(scriptPath)}`;
  return runCapture(cmd, {
    cwd: workDir,
    logPath,
    env: { ...process.env, HARNESS_MODE: mode, ...extraEnv },
  });
}

// ── run 1: the attack ────────────────────────────────────────────────────────
const attackLog = join(resultsDir, `${spec.test_name}.log`);
const attack = runMode('attack', attackLog);
writeFileSync(join(resultsDir, `${spec.test_name}.exit`), `EXIT=${attack.exit_code}\n`);
console.log(`attack ${spec.test_name} -> EXIT=${attack.exit_code}`);

// ── run 2a: the fixture control ──────────────────────────────────────────────
const controlLog = join(controlsDir, `${spec.test_name}_control.log`);
const control = runMode('control', controlLog);
writeFileSync(
  join(controlsDir, `${spec.test_name}_control.exit`),
  `EXIT=${control.exit_code}\n`,
);
console.log(`control ${spec.test_name}_control -> EXIT=${control.exit_code}`);

// ── run 2b: the counterfactual ───────────────────────────────────────────────
//
// Two mechanisms, chosen by what the plane can actually re-execute:
//
//   without_precondition  the same harness, its enabling condition removed.
//                         Available everywhere, and it is what the Solana plane
//                         uses for the plain script (see plane-patch.js).
//
//   with_fix              the derived source patch applied and the SAME attack
//                         re-run. Only for solana, because it is the only
//                         non-EVM plane whose source this repo can rebuild
//                         (cargo-build-sbf). A web plane cannot rebuild a remote
//                         service, so claiming with_fix there would be a fiction.
if (playbook === 'sol.svm-signer' && targetDir) {
  const reason = runSolanaWithFix();
  if (reason) {
    writeFileSync(join(counterfactualDir, `${spec.test_name}.reason`), `${reason}\n`);
    console.log(`counterfactual ${spec.test_name}: none — ${reason}`);
  }
} else {
  const cfLog = join(counterfactualDir, `${spec.test_name}.log`);
  const cf = runMode('nocond', cfLog);
  writeFileSync(join(counterfactualDir, `${spec.test_name}.exit`), `EXIT=${cf.exit_code}\n`);
  console.log(`counterfactual ${spec.test_name}: without_precondition -> EXIT=${cf.exit_code}`);
}

/**
 * with_fix for the Solana plane: add the missing check to the .rs source,
 * rebuild with cargo-build-sbf, re-run the SAME attack, restore.
 *
 * This is the §8.1 counterfactual: "reuse the existing patch.ts derivation on the
 * .rs source (remove the is_signer check, or the owner re-derivation), rebuild,
 * re-run the same attack test." The derivation lives in plane-patch.ts and is
 * unit-tested, because a patch that half-applies would describe a program that
 * never existed.
 *
 * Returns a reason string when no with_fix run could be produced, or null when
 * one was recorded.
 */
function runSolanaWithFix() {
  const relSource = process.env.SVM_SOURCE || '';
  if (!relSource) {
    return 'SVM_SOURCE (the .rs path inside the checkout) was not provided, so no with_fix run is derivable';
  }
  const rel = safeTargetFile(relSource);
  if (!rel) return `SVM_SOURCE names an unusable path (${relSource})`;
  const filePath = join(targetDir, rel);
  if (!existsSync(filePath)) return `the source ${rel} does not exist in the checkout`;

  const original = readFileSync(filePath, 'utf8');
  const derived = deriveSolanaPatch(playbook, rel, original);
  if (!derived.ok) return derived.reason;

  const edited = applyEdits(original, derived.patch.edits);
  if (!edited.ok) return `the derived patch does not apply: ${edited.reason}`;

  const backup = `${filePath}.asterion-orig`;
  copyFileSync(filePath, backup);
  const cfLog = join(counterfactualDir, `${spec.test_name}.log`);
  let res;
  try {
    writeFileSync(filePath, edited.source);
    // Rebuild FIRST: a with_fix run that executed the old .so would report a
    // passing attack on a tree that was never compiled, which is worse than no
    // counterfactual at all.
    const build = runCapture(
      `cargo-build-sbf --arch v0 --sbf-out-dir ${shQuote(join(targetDir, 'target', 'deploy'))}`,
      { cwd: join(targetDir, 'programs', process.env.SVM_PROGRAM || ''), logPath: cfLog },
    );
    if (build.exit_code !== 0) {
      writeFileSync(join(counterfactualDir, `${spec.test_name}.exit`), `EXIT=${build.exit_code}\n`);
      return null;
    }
    res = runMode('attack', cfLog);
  } finally {
    // Always restore: a patched checkout left behind would corrupt every later
    // attempt in the same workflow run.
    try {
      copyFileSync(backup, filePath);
    } finally {
      rmSync(backup, { force: true });
    }
  }
  writeFileSync(join(counterfactualDir, `${spec.test_name}.exit`), `EXIT=${res.exit_code}\n`);
  console.log(`counterfactual ${spec.test_name}: with_fix (${rel}) -> EXIT=${res.exit_code}`);
  console.log(`  rationale: ${derived.patch.rationale}`);
  return null;
}

// ── the plan, so judge.mjs has something to adjudicate ───────────────────────
//
// `judge.mjs` consumes a plan and looks up runs by `test_name`, so this is the
// contract between the two. It records the mechanisms that were ATTEMPTED; a
// mechanism that could not be produced leaves only a `.reason` file, and
// judge.mjs reports that attempt as missing a counterfactual rather than
// silently upgrading it.
const plan = {
  plane: playbook.startsWith('sol.') ? 'solana' : playbook === 'web.takeover' ? 'infra' : 'web2',
  playbook,
  contract: null,
  commit: process.env.TARGET_SHA || '',
  leads_found: 1,
  unprovable: [],
  attempts: [
    {
      test_name: spec.test_name,
      playbook,
      file: spec.files[0].path,
      line: null,
      claim: spec.claim,
      requires: spec.requires,
      control_name: spec.control_name,
      nocond_name: spec.nocond_name,
      counterfactual:
        playbook === 'sol.svm-signer' && targetDir
          ? { mechanism: 'with_fix', test_name: spec.test_name }
          : { mechanism: 'without_precondition', test_name: spec.nocond_name },
    },
  ],
};
writeFileSync(join(outRoot, 'plan.json'), JSON.stringify(plan, null, 2));
console.log(`plan written to ${join(outRoot, 'plan.json')}`);
process.exit(0);
