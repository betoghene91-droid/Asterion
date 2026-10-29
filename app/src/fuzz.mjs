#!/usr/bin/env node
/**
 * fuzz.mjs — V3 stage: turn an echidna campaign into extra attempts.
 *
 * Designed to be a no-op when echidna is absent, so V2's static-synthesis path
 * is never at risk. It reads the plan `plan.mjs` already produced and APPENDS
 * attempts to it, in the same shape, so the existing "write PoCs" -> "run" ->
 * "judge" steps need no changes at all. There is one plan file and one proof
 * contract, not two.
 *
 * Usage (in CI, after plan.mjs):
 *   node build/v2/src/fuzz.mjs \
 *     --plan   plan.json \
 *     --fuzz   echidna.json \
 *     --target ./target \
 *     --contract Vault
 *
 * Exit codes:
 *   0  attempts appended, OR no seeds for an honest reason (never a failure)
 *   2  bad arguments
 *
 * Deliberately never exits non-zero because echidna found nothing: "the fuzzer
 * found no falsification" is a normal, informative outcome, not an error.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCampaign,
  seedsFromCampaign,
  synthesizeFromFuzz,
  echidnaHarness,
  echidnaConfig,
  propertyFor,
} from './fuzzseed.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ── mode 1: emit the harness + config for a playbook ───────────────────
//
// Separate from the seed-merge mode so the workflow can generate the Echidna
// inputs, run the fuzzer, then come back with its output.
const emitPlaybook = arg('emit-harness');

if (emitPlaybook) {
  const contract = arg('contract');
  const outDir = arg('out-dir');

  if (!contract || !outDir) {
    console.error('usage: fuzz.mjs --emit-harness <playbook> --contract <Name> --out-dir <dir>');
    process.exit(2);
  }

  const harness = echidnaHarness(emitPlaybook, contract);
  if (!harness) {
    // No honest property for this class. Say so; do not invent one.
    console.error(`no property defined for playbook ${emitPlaybook}; nothing emitted`);
    process.exit(3);
  }

  writeFileSync(join(outDir, 'AsterionFuzzHarness.sol'), harness);
  writeFileSync(join(outDir, 'echidna.yaml'), echidnaConfig());
  console.log(`emitted harness + config for ${emitPlaybook} (property: ${propertyFor(emitPlaybook).property})`);
  process.exit(0);
}

// ── mode 2: merge an echidna campaign into plan.json ───────────────────

const planPath = arg('plan', 'plan.json');
const fuzzPath = arg('fuzz', 'echidna.json');
const targetDir = arg('target', './target');
const contract = arg('contract');

if (!contract) {
  console.error('usage: fuzz.mjs --plan plan.json --fuzz echidna.json --target <dir> --contract <Name>');
  process.exit(2);
}

/**
 * Pull the target's function signatures from a forge build artifact.
 *
 * We need this because echidna's JSON arguments are untyped: without the ABI we
 * cannot tell whether "0x10000" is an address, a bytes value, or a uint. Better
 * to have no seed than a wrong one.
 */
function loadAbi(dir, name) {
  const out = join(dir, 'out');
  if (!existsSync(out)) return null;

  const wanted = `${name}.json`;
  const found = [];

  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (e === wanted) found.push(full);
    }
  };
  walk(out);

  for (const f of found) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      const abi = Array.isArray(j.abi) ? j.abi : null;
      if (!abi) continue;

      const map = {};
      for (const item of abi) {
        if (item.type !== 'function' || typeof item.name !== 'string') continue;
        const inputs = Array.isArray(item.inputs) ? item.inputs : [];
        // A name can be overloaded. Only record names with ONE signature;
        // an ambiguous name would make us replay the wrong function.
        const types = inputs.map((i) => i.type);
        if (map[item.name] && JSON.stringify(map[item.name]) !== JSON.stringify(types)) {
          delete map[item.name];
          map[item.name] = undefined;
        } else if (!(item.name in map)) {
          map[item.name] = types;
        }
      }
      // Drop the names we marked ambiguous.
      for (const k of Object.keys(map)) if (map[k] === undefined) delete map[k];
      return map;
    } catch {
      /* try the next artifact */
    }
  }
  return null;
}

function readPlan() {
  if (!existsSync(planPath)) {
    console.error(`no plan at ${planPath}; V3 stage skipped (V2 plan.mjs must run first)`);
    process.exit(0);
  }
  return JSON.parse(readFileSync(planPath, 'utf8'));
}

const plan = readPlan();
plan.attempts = Array.isArray(plan.attempts) ? plan.attempts : [];
plan.fuzz = plan.fuzz ?? { ran: false };

/** Record why V3 contributed nothing, so the bundle explains itself. */
function skip(reason, extra = {}) {
  plan.fuzz = { ran: true, seeds: 0, rejected: [{ reason }], ...extra };
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`v3: no seeds — ${reason}`);
  process.exit(0);
}

if (!existsSync(fuzzPath)) {
  skip('echidna produced no output file (fuzzer unavailable, failed, or skipped)');
}

const raw = readFileSync(fuzzPath, 'utf8');
const parsed = parseCampaign(raw);
if (!parsed.ok) {
  skip(parsed.reason);
}

const abi = loadAbi(targetDir, contract);
if (!abi) {
  skip(`no forge artifact for ${contract} under ${targetDir}/out; cannot type echidna arguments`);
}

const { seeds, rejected } = seedsFromCampaign(parsed.campaign, { abi });

if (seeds.length === 0) {
  skip(rejected[0]?.reason ?? 'no falsifying sequence', { rejected });
}

const forkBlock = Number(plan.fork_block ?? 0) || 1;
let appended = 0;
const fuzzRejected = [...rejected];

for (const seed of seeds) {
  const spec = synthesizeFromFuzz(seed, { contract, forkBlock, abi });
  if (!spec) {
    fuzzRejected.push({ reason: 'could not synthesise a replayable spec from the sequence' });
    continue;
  }

  // Never overwrite a V2 attempt: names are content-hashed, but check anyway.
  if (plan.attempts.some((a) => a.test_name === spec.test_name)) {
    fuzzRejected.push({ reason: `attempt ${spec.test_name} already exists` });
    continue;
  }

  plan.attempts.push({
    test_name: spec.test_name,
    control_name: spec.control_name,
    playbook: 'v3.fuzzseed',
    // The provenance is explicit: this attempt came from a fuzzer, not from a
    // source-shape heuristic. The judge treats both identically.
    source: 'echidna',
    file: '(echidna sequence)',
    line: 0,
    claim: spec.claim,
    requires: spec.requires,
    solidity: spec.solidity,
    fuzz: { status: seed.status, reason: seed.reason, steps: seed.transactions.length },
  });
  appended++;
}

plan.fuzz = {
  ran: true,
  seeds: appended,
  statuses: seeds.map((s) => s.status),
  rejected: fuzzRejected,
};

writeFileSync(planPath, JSON.stringify(plan, null, 2));
console.log(`v3: appended ${appended} echidna-seeded attempt(s) to ${planPath}`);
for (const r of fuzzRejected) console.log(`  rejected: ${r.reason}`);
