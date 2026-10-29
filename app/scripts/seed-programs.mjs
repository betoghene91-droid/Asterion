#!/usr/bin/env node
/**
 * Seed the programs queue from public scope data.
 *
 * The seed ships gzipped (131 KB) because it carries 2,500 programs and 15,013
 * in-scope assets. It is a build artifact, not source.
 *
 * Critical invariant: every seeded program is written with
 * `automation = 'unknown'`. Platform scope says an asset is in scope for a
 * human researcher; it says nothing about automated tooling. Discovery must
 * still fetch and classify each program's own policy before anything runs.
 *
 * Usage:
 *   node v1/scripts/seed-programs.mjs             # SQL to stdout
 *   node v1/scripts/seed-programs.mjs --apply     # run via wrangler
 *   node v1/scripts/seed-programs.mjs --bounty    # only reward-paying programs
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [join(HERE, '..', 'src', 'program-seed.json.gz'), 'src/program-seed.json.gz'];

let raw = null;
for (const p of CANDIDATES) {
  try {
    raw = gunzipSync(readFileSync(p));
    break;
  } catch {
    /* next */
  }
}
if (!raw) {
  console.error('program-seed.json.gz not found. Run: python3 v1/eval/ingest-programs.py --in <dir>');
  process.exit(1);
}

const seed = JSON.parse(raw.toString('utf8'));
const onlyBounty = process.argv.includes('--bounty');
const now = Math.floor(Date.now() / 1000);

const esc = (s) => String(s).replace(/'/g, "''");
const lines = [];
let programs = 0;
let assets = 0;

for (const p of seed.items) {
  if (onlyBounty && p.reward !== 'monetary') continue;

  lines.push(
    `INSERT INTO programs (id,name,platform,homepage,automation,reward,status,discovered_at,next_check,meta) ` +
      `VALUES ('${esc(p.id)}','${esc(p.name)}','${esc(p.platform)}','${esc(p.homepage)}','unknown','${esc(p.reward)}','new',${now},${now},` +
      `'{"seeded":true,"assets":${p.assets.length}}') ` +
      `ON CONFLICT(id) DO NOTHING;`,
  );
  programs++;

  for (const a of p.assets) {
    const aid = `${p.id}:${a.value}`;
    lines.push(
      `INSERT INTO assets (id,program_id,kind,value,in_scope,first_seen,last_seen,meta) ` +
        `VALUES ('${esc(aid)}','${esc(p.id)}','${esc(a.kind)}','${esc(a.value)}',1,${now},${now},` +
        `'{"bounty":${a.bounty ? 1 : 0},"max_sev":"${esc(a.max_sev)}","type":"${esc(a.type)}"}') ` +
        `ON CONFLICT(program_id,kind,value) DO NOTHING;`,
    );
    assets++;
  }
}

const sql = lines.join('\n');
console.error(`seed: ${programs} programs, ${assets} assets${onlyBounty ? ' (bounty only)' : ''}`);

if (!process.argv.includes('--apply')) {
  process.stdout.write(sql);
  process.exit(0);
}

const file = join(tmpdir(), 'seed-programs.sql');
writeFileSync(file, sql);
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'asterion', '--remote', `--file=${file}`, '--yes'], {
    stdio: 'inherit',
  });
  console.error('seeded');
} finally {
  rmSync(file, { force: true });
}
