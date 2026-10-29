#!/usr/bin/env node
/**
 * Negative controls for the desk.
 *
 * Each control breaks exactly one rule, runs the suite, and asserts that the
 * suite goes RED for the *reason we expect* — not merely that something failed.
 * A control that fails for an unrelated reason proves nothing, so every control
 * greps for the specific test name that must break.
 *
 * Everything is restored in a finally block, and the restore is verified against
 * the pre-control sha256 so a half-applied patch cannot leave the tree broken.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Did `name` FAIL in this run?
 *
 * Not just "does the output contain the name" — the name appears in the passing
 * list too, so a substring check would report success for a control that broke
 * nothing. This looks for the name in the `✖` block or the `failing tests`
 * section, and separately asserts the test is not in the `✔` list.
 */
function namedTestFailed(out, name) {
  const lines = out.split('\n');
  const isFailLine = lines.some((l) => l.includes(name) && (l.startsWith('\u2716') || l.startsWith('not ok') || l.includes('AssertionError')));
  const inFailSection = out.includes('failing tests:') && out.slice(out.indexOf('failing tests:')).includes(name);
  const passLine = lines.some((l) => l.includes(name) && l.startsWith('\u2714'));
  return { failed: (isFailLine || inFailSection) && !passLine, passLine, isFailLine, inFailSection };
}

function runSuite() {
  try {
    return execSync('node --test tests/desk.test.mjs', { cwd: APP, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function counts(out) {
  const p = out.match(/^# pass (\d+)$/m) ?? out.match(/^\u2139 pass (\d+)$/m);
  const f = out.match(/^# fail (\d+)$/m) ?? out.match(/^\u2139 fail (\d+)$/m);
  return { pass: p ? Number(p[1]) : null, fail: f ? Number(f[1]) : null };
}

const controls = [
  {
    name: 'freeze authority check broken — the honeypot fixture must now pass',
    file: 'src/desk/filter.ts',
    // The mandated control: make the freeze gate unreachable.
    find: `  if (s.freezeAuthorityRevoked !== true) {\n    push(\n      'freeze_authority_live',`,
    replace: `  if (false && s.freezeAuthorityRevoked !== true) {\n    push(\n      'freeze_authority_live',`,
    mustFail: 'desk: a honeypot token is rejected on the freeze-authority gate',
  },
  {
    name: 'holder exclusion removed — the good token must be killed on raw top-10',
    file: 'src/desk/holders.ts',
    find: `    const kind = classify(h, known, burns, cex);`,
    replace: `    const kind = null as 'pool' | 'burn' | 'cex' | null; void classify; void known; void burns; void cex;`,
    mustFail: 'desk: raw top-10 would kill the good token, the pool/burn/CEX exclusion saves it',
  },
  {
    name: '1% pool-share refusal removed — an impossible paper fill must be allowed',
    file: 'src/desk/paper.ts',
    find: `  if (poolShare > 0.01) {`,
    replace: `  if (false && poolShare > 0.01) {`,
    mustFail: 'desk: a paper fill is refused when the size exceeds 1% of pool liquidity',
  },
  {
    name: 'circuit breaker disabled — a -9% day must stop halting',
    file: 'src/desk/arming.ts',
    find: `  if (breakerTripped(equity, pnl)) {`,
    replace: `  if (false && breakerTripped(equity, pnl)) { void breakerTripped;`,
    mustFail: 'desk: the daily loss breaker halts the desk and no code path can un-halt it',
  },
  {
    name: 'floor enforcement removed — a one-metric token must now pass',
    file: 'src/desk/analyst.ts',
    find: `  const passed = rounded >= ANALYST.passTotal && floorFailed.length === 0;`,
    replace: `  const passed = rounded >= ANALYST.passTotal;`,
    mustFail: 'desk: a 70 assembled from one hero metric still fails, via the floors',
  },
  {
    name: 'liquidity ratio gate weakened to a flat floor — a $40k pool on a $20M token must pass',
    file: 'src/desk/scout.ts',
    find: `  return Math.max(SCOUT.minLiqUsd, mcapUsd * SCOUT.minLiqRatioOfMcap);`,
    replace: `  return SCOUT.minLiqUsd; void mcapUsd;`,
    mustFail: 'desk: liquidity is gated as a ratio, so a $40k pool fails a $20M token',
  },
  {
    name: 'pre-PnL exit ordering broken — liq decay must stop pre-empting the mark',
    file: 'src/desk/risk.ts',
    find: `  if (pos.liqAtEntry > 0 && q.liqUsd < pos.liqAtEntry * (1 - RISK.liqDecayPct)) {`,
    replace: `  if (false && pos.liqAtEntry > 0 && q.liqUsd < pos.liqAtEntry * (1 - RISK.liqDecayPct)) {`,
    mustFail: 'desk: risk exits on liquidity decay before it looks at PnL',
  },
];

console.log('=== DESK NEGATIVE CONTROLS ===\n');

// Baseline first, so "green" is measured rather than assumed.
const base = counts(runSuite());
console.log(`baseline: pass=${base.pass} fail=${base.fail}`);
if (base.fail !== 0) {
  console.error('baseline is not green — refusing to run controls');
  process.exit(1);
}
console.log('');

let proved = 0;
let broken = 0;

for (const c of controls) {
  const path = join(APP, c.file);
  const before = sha(path);
  const original = readFileSync(path, 'utf8');

  if (!original.includes(c.find)) {
    console.log(`!! SKIP ${c.name}\n   anchor not found in ${c.file} — the control is stale\n`);
    broken++;
    continue;
  }

  try {
    writeFileSync(path, original.replace(c.find, c.replace));
    execSync('npm run build --silent', { cwd: APP, stdio: 'pipe' });
    const out = runSuite();
    const r = counts(out);
    const det = namedTestFailed(out, c.mustFail);
    const ok = r.fail > 0 && det.failed;
    if (ok) proved++;
    else broken++;
    console.log(`${ok ? 'RED as expected' : 'CONTROL FAILED'}: ${c.name}`);
    console.log(`   pass=${r.pass} fail=${r.fail} target_test_failed=${det.failed}`);
    if (!ok) {
      const failing = out.split('\n').filter((l) => l.startsWith('\u2716') || l.startsWith('not ok')).slice(0, 5);
      console.log(`   detail: passLine=${det.passLine} failLine=${det.isFailLine} inFailSection=${det.inFailSection}`);
      console.log(`   failing tests seen: ${failing.join(' | ') || '(none parsed)'}`);
    }
    console.log('');
  } finally {
    writeFileSync(path, original);
    if (sha(path) !== before) {
      console.error(`!! restore mismatch for ${c.file}`);
      process.exit(1);
    }
  }
}

// Restore + rebuild, then prove green again.
execSync('npm run build --silent', { cwd: APP, stdio: 'pipe' });
const after = counts(runSuite());
console.log(`restored: pass=${after.pass} fail=${after.fail}`);
console.log('');
console.log(`controls proved: ${proved}/${controls.length}${broken ? ` (${broken} broken)` : ''}`);
process.exit(after.fail === 0 && broken === 0 ? 0 : 1);
