// Evidence generator: prints the EXACT operator-facing Telegram text for every
// dispatch outcome, against the real schema. This is not a test; it is the
// artefact that shows what the operator actually reads.
//
// Usage: node tests/evidence-messages.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { approveAndDispatch } from '../build/dispatch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');
const NOW = 1_700_000_000;
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const GIT_URL = 'https://github.com/acme/vault.git';

const SOLID = {
  program_id: 'acme.example',
  title: 'solidity hunt on vault',
  cls: 'solidity',
  targets: [`${GIT_URL}@${SHA}`],
  playbooks: ['sol.reentrancy'],
  max_mutability: 'simulate',
  time_box_minutes: 240,
  authorization_ref: 'https://acme.example/security permits automated testing',
  stop_condition: 'stop at the time box',
  out_of_scope: [],
  notes: 'contract:Vault',
};

function fresh(brief) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO programs (id,name,platform,status,discovered_at) VALUES (?,?,'self','new',?)`,
  ).run(brief.program_id, brief.program_id, NOW);
  db.prepare(
    `INSERT INTO approvals (id,fingerprint,action,reason,status,requested_at) VALUES (?,?,?,?,?,?)`,
  ).run('appr-1', 'appr-1', JSON.stringify({ kind: 'engagement', brief }), 'new engagement', 'pending', NOW);
  const api = {
    first: async (sql, ...b) => db.prepare(sql).get(...b) ?? null,
    run: async (sql, ...b) => {
      db.prepare(sql).run(...b);
    },
    db,
  };
  return api;
}

async function run(label, brief, env, fetchImpl) {
  const api = fresh(brief);
  const msgs = [];
  const out = await approveAndDispatch('appr-1', true, {
    db: api,
    env,
    fetch: fetchImpl,
    ledger: async () => {},
    notify: async (t) => msgs.push(t),
    operator: 'operator',
    now: () => NOW,
    uuid: () => 'hunt-0f3a91c2',
  });
  const hunts = api.db.prepare('SELECT id, stage, stopped_because FROM hunts').all();
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);
  console.log(`outcome: ${JSON.stringify(out)}`);
  console.log(`hunts rows: ${hunts.length ? JSON.stringify(hunts) : 'NONE'}`);
  console.log('--- operator reads ---');
  for (const m of msgs) console.log(m.replace(/<\/?b>|<\/?code>|<i>|<\/i>/g, ''));
}

const ok = async () => new Response(null, { status: 204 });
const forbidden = async () =>
  new Response('{"message":"Resource not accessible by integration"}', { status: 403 });

await run('1. HAPPY PATH — dispatched', SOLID, { GITHUB_DISPATCH_TOKEN: 'set', GITHUB_REPO: 'me/asterion' }, ok);
await run('2. MISSING TOKEN — honest, no hunt', SOLID, { GITHUB_REPO: 'me/asterion' }, ok);
await run('3. BOTH ENV VARS MISSING', SOLID, {}, ok);
await run('4. GATE REFUSES (read-only brief)', { ...SOLID, max_mutability: 'read' }, { GITHUB_DISPATCH_TOKEN: 'set', GITHUB_REPO: 'me/asterion' }, ok);
await run('5. UNDERIVABLE INPUTS (host-only brief)', { ...SOLID, cls: 'solidity', targets: ['app.example.com'], notes: 'look at the api' }, { GITHUB_DISPATCH_TOKEN: 'set', GITHUB_REPO: 'me/asterion' }, ok);
await run('6. NON-SOLIDITY BRIEF', { ...SOLID, cls: 'web2' }, { GITHUB_DISPATCH_TOKEN: 'set', GITHUB_REPO: 'me/asterion' }, ok);
await run('7. GITHUB RETURNS 403', SOLID, { GITHUB_DISPATCH_TOKEN: 'set', GITHUB_REPO: 'me/asterion' }, forbidden);
await run('8. TRANSPORT FAILURE', SOLID, { GITHUB_DISPATCH_TOKEN: 'set', GITHUB_REPO: 'me/asterion' }, async () => {
  throw new Error('getaddrinfo ENOTFOUND api.github.com');
});
