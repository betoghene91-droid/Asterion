#!/usr/bin/env node
/**
 * plan.mjs — turn scan leads into a PoC plan.
 *
 * Runs in CI, not in the Worker: it needs the corpus digest and the target's
 * source tree, neither of which the Worker can hold.
 *
 * Usage:
 *   node build/plan.mjs --target ./target --contract Vault --fork-block 30000000 --out plan.json
 *
 * ── What this decides beyond the harness ────────────────────────────────
 *
 * `judge()` cannot return `proven` without a counterfactual, and a
 * counterfactual is not free: it has to be a real second run whose result is
 * interpretable. So for every attempt this file picks ONE mechanism and records
 * the choice in the plan:
 *
 *   with_fix             a minimal source patch is derived from the file the
 *                        scanner flagged, and the same test is re-run against
 *                        the patched tree. It must pass.
 *
 *   without_precondition the generated `_nocond` test keeps the failing
 *                        assertion and removes only the enabling condition.
 *                        It must pass.
 *
 * The choice is not stylistic. A with-fix run is only evidence when the test
 * actually EXECUTES the patched code. Harnesses that attach to a deployed
 * address (`vm.envAddress("TARGET")`) run against the live bytecode on the
 * fork, so patching the source and re-running the same test would prove
 * nothing — that is why `self_deployed` gates the mechanism. When both are
 * unavailable the attempt still runs and is honestly judged `partial`.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planAttempts, rank } from './hunt.js';
import { PLAYBOOKS } from './playbooks.js';
import { derivePatch } from './patch.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = arg('target');
const contract = arg('contract');
const forkBlock = Number(arg('fork-block', '0'));
const out = arg('out', 'plan.json');

if (!target || !contract) {
  console.error('usage: plan.mjs --target <dir> --contract <name> [--fork-block N] [--out file]');
  process.exit(2);
}

/**
 * Load the distilled corpus that ships beside this module.
 *
 * The paths are resolved from THIS FILE, not from process.cwd(). The previous
 * implementation used cwd-relative strings ('v1/src/corpus-digest.json') which
 * only worked when the CLIs sat at the root of the old two-tree layout. Launched
 * from anywhere else they missed, returned null, and the run silently recorded
 * `corpus_rows: 0` in verdicts.json — a legitimate-looking zero that was really
 * "I could not find the corpus".
 *
 * Two independent guarantees now:
 *   1. resolution is location-independent (module-relative, src/ or build/)
 *   2. a missing digest is LOUD: stderr warning + `corpus_error` in the plan,
 *      so a reader can never mistake absence for an empty corpus.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

function loadDigest() {
  // works both for src/plan.mjs (built output beside src/corpus-digest.json)
  // and build/plan.mjs (copied there by scripts/copy-mjs.mjs).
  const candidates = [
    join(HERE, 'corpus-digest.json'),
    join(HERE, '..', 'src', 'corpus-digest.json'),
  ];
  for (const p of candidates) {
    try {
      return { digest: JSON.parse(readFileSync(p, 'utf8')), path: p };
    } catch {
      /* try next */
    }
  }
  console.error(
    'WARNING: corpus-digest.json not found beside plan.mjs or in ../src/. ' +
      'This run has NO corpus precedent; recorded as corpus_error, not as an empty corpus. ' +
      'Looked in: ' + candidates.join(', '),
  );
  return null;
}

/** Collect .sol files, skipping tests and vendored code. */
function solFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'lib', 'out', 'cache', 'test', 'tests', 'script', '.git'].includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) solFiles(full, acc);
    else if (name.endsWith('.sol')) acc.push(full);
  }
  return acc;
}

/**
 * Minimal in-process lead scan. This mirrors scripts/detect.py so the plan step
 * has no Python dependency; the Python version remains the reference and is
 * what the tests pin.
 */
const PATTERNS = [
  ['sol.reentrancy', /\.call\{value:[^}]*\}\(/, ['nonReentrant', 'ReentrancyGuard'], true],
  ['sol.delegatecall', /delegatecall\s*\(/, [], false],
  ['sol.upgrade', /function\s+initialize\s*\([^)]*\)\s*(public|external)(?![^;{]*initializer)/, [], false],
  ['sol.signature', /ecrecover\s*\(/, [], false],
  ['sol.oracle', /(getReserves|balanceOf\s*\(\s*\w*[Pp]air)/, [], false],
  ['sol.dos', /for\s*\([^;]*;\s*\w+\s*<\s*\w+(\[\w+\]|\.length)/, [], false],
  ['sol.rounding', /(shares|assets|amount|balance)\w*\s*\/\s*(total\w*|supply|price)/, [], false],
  ['sol.flashloan', /token\.balanceOf\s*\(\s*address\s*\(this\)\s*\)/, [], false],
  [
    'sol.accesscontrol',
    /function\s+\w+\s*\([^)]*\)\s*(external|public)(?![^;{]*\b(onlyOwner|onlyRole|onlyAdmin|requiresAuth|auth|initializer|nonReentrant))[^;{]*\{/,
    [],
    false,
  ],
];

function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function scan(dir) {
  const leads = [];
  for (const file of solFiles(dir)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const lines = src.split('\n');
    for (const [playbook, rx, suppress, needsWriteAfter] of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (!rx.test(lines[i])) continue;
        if (/function/.test(lines[i]) && /(view|pure)/.test(lines[i])) continue;

        // find enclosing function to check modifiers
        let start = i;
        while (start >= 0 && !/\s*(function\s+\w+|constructor\s*\(|receive\s*\(|fallback\s*\()/.test(lines[start])) start--;
        if (start < 0) continue;
        let depth = 0, opened = false, body = [];
        for (let j = start; j < lines.length; j++) {
          body.push(lines[j]);
          if (lines[j].includes('{')) opened = true;
          depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
          if (opened && depth <= 0) break;
        }
        const head = body.join('\n').split('{')[0];
        if (suppress.some((m) => head.includes(m))) continue;
        if (needsWriteAfter) {
          const after = lines.slice(i, i + 12).join('\n');
          if (!/\w+\s*(\[[^\]]*\])?\s*(=|-=|\+=)\s/.test(after)) continue;
        }
        if (playbook === 'sol.accesscontrol' && /\b(constructor|interface|library)\b/.test(body.join('\n'))) continue;

        leads.push({
          playbook,
          file: relative(dir, file),
          line: i + 1,
          snippet: lines[i].trim().slice(0, 160),
          severity: 'high',
        });
        break; // one lead per class per file
      }
    }
  }
  return leads;
}

/**
 * Choose the counterfactual for one attempt, and derive its patch if that is
 * the mechanism chosen.
 *
 * Order of preference is with_fix, because a passing patched run says more than
 * a passing precondition-removed run: it names the change that removes the
 * defect. It is only allowed when the harness executes its own deployment AND a
 * patch genuinely applies, so the two refusals below are the common case, not
 * an error path.
 */
function counterfactualFor(spec, lead) {
  const fallback = {
    mechanism: 'without_precondition',
    test_name: spec.nocond_name,
  };

  if (!spec.self_deployed) {
    return {
      ...fallback,
      why_not_with_fix:
        'the harness attaches to the deployed contract via vm.envAddress("TARGET"), so it executes ' +
        'fork bytecode: a source patch would not be observable by this test',
    };
  }

  let source;
  try {
    source = readFileSync(join(target, lead.file), 'utf8');
  } catch {
    return { ...fallback, why_not_with_fix: `the lead file ${lead.file} could not be re-read for patching` };
  }

  const derived = derivePatch(lead.playbook, lead.file, source, lead.line);
  if (!derived.ok) {
    return { ...fallback, why_not_with_fix: derived.reason };
  }

  return {
    mechanism: 'with_fix',
    // The patched run re-runs the ATTACK test: it must stop failing.
    test_name: spec.test_name,
    patch: { file: derived.patch.file, rationale: derived.patch.rationale, edits: derived.patch.edits },
  };
}

const loaded = loadDigest();
const digest = loaded?.digest ?? null;
const leads = scan(target);
const ranked = rank(PLAYBOOKS.map((p) => p.id), digest);
const { attempts, unprovable } = planAttempts(leads, { contract, forkBlock: forkBlock || 1 }, 8);

const plan = {
  contract,
  commit: process.env.TARGET_SHA ?? '',
  fork_block: forkBlock,
  leads_found: leads.length,
  attempts: attempts.map(({ lead, spec }) => {
    return {
      test_name: spec.test_name,
      // Emitted so the workflow can run the fixture-soundness check and the
      // judge can tell the two secondary runs apart.
      control_name: spec.control_name,
      nocond_name: spec.nocond_name,
      playbook: lead.playbook,
      file: lead.file,
      line: lead.line,
      claim: spec.claim,
      requires: spec.requires,
      solidity: spec.solidity,
      counterfactual: counterfactualFor(spec, lead),
    };
  }),
  unprovable: unprovable.map((l) => ({ playbook: l.playbook, file: l.file, line: l.line })),
  ranked_top: ranked.slice(0, 8).map((r) => ({ id: r.id, prior: r.prior, reason: r.reason })),
  // `rows` is the corpus size when the digest was found. `error` is present
  // ONLY when it was not — so judge.mjs can record corpus_rows: null rather
  // than a 0 that looks like a legitimate empty corpus.
  corpus: digest
    ? { rows: digest.source_rows, version: digest.version, path: loaded.path }
    : { rows: null, error: 'corpus-digest.json was not found; no precedent was available' },
};

writeFileSync(out, JSON.stringify(plan, null, 2));
console.log(`leads ${leads.length} -> attempts ${attempts.length}, unprovable ${unprovable.length}`);
for (const a of plan.attempts) {
  const cf = a.counterfactual;
  const detail = cf.mechanism === 'with_fix' ? 'patch derived' : cf.why_not_with_fix;
  console.log(`  attempt ${a.playbook} (${a.file}:${a.line}) -> ${a.test_name}  cf=${cf.mechanism} (${detail})`);
}
for (const u of plan.unprovable) console.log(`  no harness: ${u.playbook} (${u.file}:${u.line})`);
