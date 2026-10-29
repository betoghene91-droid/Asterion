#!/usr/bin/env node
/**
 * judge.mjs — turn recorded runs into verdicts.
 *
 * Deliberately dumb: it parses exit codes, assertion text and the IMPACT_*
 * lines the PoC prints, then applies the same `judge()` the unit tests pin. No
 * model touches this path. If the judge is wrong, a test catches it; if a model
 * were here, nothing would.
 *
 * What changed, and why it matters:
 *
 * `judge()` returns `proven` only for reproduced + CAUSAL + measured. This file
 * used to supply only `reproduced`, so causality was structurally unreachable
 * and every attempt could at best be `partial`. It now reads the second run the
 * plan asked for and the measurement the attack printed.
 *
 * ── Why the counterfactual lives in its own directory ───────────────────
 *
 * A with_fix run re-executes the SAME test name against a patched tree. If its
 * log and exit file shared `results/` with the attack, the second write would
 * overwrite the first and the attack's reproduction would vanish — the run
 * would look like it passed. So `results/` holds run 1 (the attack) and
 * `counterfactual/` holds run 2, keyed by the same name. Keeping them apart is
 * what makes "same test, different tree" representable on a filesystem.
 *
 * Three refusals are load-bearing and each has a test:
 *
 *   - a run with no `EXIT=` file is treated as NOT RUN, never as a pass.
 *   - a counterfactual that was planned but never recorded is reported as a
 *     per-attempt limitation, not silently ignored.
 *   - impact markers that are missing, empty or duplicated yield no impact, so
 *     the result stays `partial`.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { judge } from './proof.js';
import { parseImpact } from './evidence.js';
import { readRun } from './capture.mjs';

/** Mechanisms the plan may ask for, in the order they are preferred. */
export const MECHANISMS = ['with_fix', 'without_precondition'];

/**
 * Resolve the counterfactual the plan asked for.
 *
 * Returns `{ mechanism, run }` when the recorded run exists, or `{ missing }`
 * with a human-readable reason. The caller must leave the bundle field ABSENT in
 * the missing case: an absent counterfactual is exactly what makes the verdict
 * `partial`, and inventing an empty run object would change judge()'s reason
 * text from "no counterfactual supplied" to something less honest.
 *
 * ── Why the lookup key is the ATTEMPT name, not cf.test_name ─────────────
 *
 * `cf.test_name` records WHICH TEST was executed (for without_precondition it
 * is `<attempt>_nocond`; for with_fix it is the attempt itself). The files on
 * disk are keyed by the ATTEMPT, because a counterfactual is produced once per
 * attempt: two attempts must never write the same log, and one attempt's
 * counterfactual must be findable without reconstructing its naming convention.
 *
 * Looking up by `cf.test_name` was wrong and an end-to-end run caught it: the
 * nocond file is written as `counterfactual/<attempt>.exit`, so the lookup
 * missed it and a genuinely causal plan was reported `partial`.
 */
export function resolveCounterfactual(attempt, dirs) {
  const cf = attempt?.counterfactual;
  if (!cf || typeof cf !== 'object') {
    return { missing: 'the plan did not plan a counterfactual for this attempt' };
  }
  if (!MECHANISMS.includes(cf.mechanism)) {
    return { missing: `the plan asked for an unknown counterfactual mechanism (${cf.mechanism})` };
  }
  if (typeof cf.test_name !== 'string' || !cf.test_name) {
    return { missing: `the plan named no test for its ${cf.mechanism} run` };
  }
  if (typeof attempt.test_name !== 'string' || !attempt.test_name) {
    return { missing: 'the attempt has no test name, so its counterfactual cannot be located' };
  }

  const run = readRun(dirs.counterfactualDir, attempt.test_name);
  if (!run) {
    // Distinguish "the script said why" from "nothing was attempted": the
    // reason file is written by counterfactual.mjs when it declines.
    const reason = readReason(dirs.counterfactualDir, attempt.test_name);
    const detail = reason ? ` (${reason})` : '';
    return {
      missing: `the planned ${cf.mechanism} run ${cf.test_name} was never recorded${detail}`,
    };
  }
  if (run.exit_code === null) {
    return {
      missing: `the ${cf.mechanism} run ${cf.test_name} has no EXIT= file, so its result is unknown`,
    };
  }
  return { mechanism: cf.mechanism, run };
}

/** Read the `<test>.reason` note counterfactual.mjs writes when it declines. */
function readReason(counterfactualDir, testName) {
  if (!counterfactualDir || !testName) return '';
  try {
    return readFileSync(`${counterfactualDir}/${testName}.reason`, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Build the ProofBundle for one attempt, without guessing anything. */
export function bundleFor(attempt, dirs, commit = '') {
  const notes = [];
  const reproduced = readRun(dirs.resultsDir, attempt.test_name);

  if (!reproduced) {
    return {
      bundle: null,
      notes: [`attempt ${attempt.test_name}: no attack run was recorded, so nothing about the target was tested`],
    };
  }
  if (reproduced.exit_code === null) {
    notes.push(
      `attempt ${attempt.test_name}: the attack run has no EXIT= file, so its exit code is unknown`,
    );
  }

  const bundle = {
    hypothesis_id: attempt.test_name,
    commit,
    test_name: attempt.test_name,
    // exit_code null never equals 0 and never matches an assertion, so judge()
    // degrades to inconclusive rather than reading this as a pass.
    reproduced: { ...reproduced, exit_code: reproduced.exit_code ?? -1 },
  };

  const cf = resolveCounterfactual(attempt, dirs);
  if (cf.missing) {
    notes.push(`attempt ${attempt.test_name}: no counterfactual — ${cf.missing}`);
  } else {
    bundle[cf.mechanism] = cf.run;
  }

  const measured = parseImpact(reproduced.output);
  if (measured) {
    const kind = attempt.claim && typeof attempt.claim.kind === 'string' ? attempt.claim.kind : 'other';
    bundle.impact = { kind, description: measured.description, measured: measured.measured };
  } else {
    notes.push(
      `attempt ${attempt.test_name}: the attack printed no usable IMPACT_BEFORE/AFTER/DESC, so its effect was not measured`,
    );
  }

  return { bundle, notes };
}

/**
 * Adjudicate a whole plan. Pure: no file writes, so a test can call it directly
 * against a fixture directory.
 *
 * `dirs` accepts either `{ resultsDir, counterfactualDir }` or a bare string
 * (treated as the results dir, with the counterfactual dir beside it as
 * `<resultsDir>/../counterfactual`), which keeps the common CLI call short and
 * the test call explicit.
 */
export function adjudicatePlan(plan, dirs, opts = {}) {
  const resolved = typeof dirs === 'string'
    ? { resultsDir: dirs, counterfactualDir: opts.counterfactualDir ?? null }
    : { resultsDir: dirs.resultsDir, counterfactualDir: dirs.counterfactualDir ?? null };

  const huntId = opts.huntId ?? '';
  const verdicts = [];
  const notes = [];

  for (const attempt of plan.attempts ?? []) {
    const { bundle, notes: n } = bundleFor(attempt, resolved, plan.commit ?? '');
    notes.push(...n);

    const result = bundle
      ? judge(bundle)
      : {
          verdict: 'inconclusive',
          confidence: 'tentative',
          reasons: ['no attack run was recorded for this attempt'],
          claim: null,
        };

    const cf = attempt?.counterfactual;
    verdicts.push({
      test_name: attempt.test_name,
      playbook: attempt.playbook,
      file: attempt.file,
      line: attempt.line,
      claim: attempt.claim,
      verdict: result.verdict,
      confidence: result.confidence,
      reasons: result.reasons,
      proven_claim: result.claim,
      exit_code: bundle ? bundle.reproduced.exit_code : null,
      // Which second run this attempt's causality rests on, if any.
      counterfactual: cf ? { mechanism: cf.mechanism, test_name: cf.test_name } : null,
      impact: bundle?.impact
        ? {
            kind: bundle.impact.kind,
            before: bundle.impact.measured.before,
            after: bundle.impact.measured.after,
          }
        : null,
    });
  }

  return {
    hunt_id: huntId,
    contract: plan.contract,
    commit: plan.commit,
    corpus_rows: plan.corpus?.rows ?? null,
    /**
     * Present only when the corpus could NOT be loaded. Without this a missing
     * digest and a genuinely empty corpus both surfaced as `corpus_rows: 0`,
     * which is the single most misleading state this pipeline can report.
     */
    corpus_error: plan.corpus?.error ?? null,
    leads_found: plan.leads_found ?? 0,
    attempts: verdicts.length,
    proven: verdicts.filter((v) => v.verdict === 'proven').length,
    partial: verdicts.filter((v) => v.verdict === 'partial').length,
    disproved: verdicts.filter((v) => v.verdict === 'disproved').length,
    inconclusive: verdicts.filter((v) => v.verdict === 'inconclusive').length,
    unprovable: (plan.unprovable ?? []).length,
    verdicts,
    /**
     * Honest, per-attempt statement of what this run could not establish.
     * Never a global excuse: an attempt that WAS given a counterfactual and a
     * measurement must not be covered by a blanket "not generated yet".
     */
    limitations: notes,
  };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const planPath = arg('plan', 'plan.json');
  const resultsDir = arg('results', 'results');
  const counterfactualDir = arg('counterfactual', 'counterfactual');
  const outPath = arg('out', 'verdicts.json');

  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const summary = adjudicatePlan(
    plan,
    { resultsDir, counterfactualDir },
    { huntId: process.env.HUNT_ID ?? '' },
  );

  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(
    `attempts ${summary.attempts}  proven ${summary.proven}  partial ${summary.partial}  ` +
      `disproved ${summary.disproved}  inconclusive ${summary.inconclusive}`,
  );
  for (const v of summary.verdicts) {
    const cf = v.counterfactual ? ` [${v.counterfactual.mechanism}]` : ' [no counterfactual]';
    console.log(`  ${v.verdict.padEnd(13)} ${v.playbook} ${v.test_name}${cf}`);
  }
  for (const l of summary.limitations) console.log(`  limitation: ${l}`);
}

/** Only run when executed, not when imported by a test. */
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    // realpath, not a string compare: the workflow invokes a relative path,
    // which would never equal the absolute module URL. Getting this wrong makes
    // the CLI silently exit 0 without writing verdicts.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
