import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');
const TOKEN = '123456:TESTTOKEN';

function sign(pairs, token = TOKEN) {
  const dcs = Object.keys(pairs).sort().map((k) => `${k}=${pairs[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...pairs, hash }).toString();
}

function initData() {
  return sign({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42, first_name: 'Jen' }),
  });
}

function makeEnv(extra = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const api = {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      const bound = (binds) => ({
        async first() { return stmt.get(...binds) ?? null; },
        async run() { return stmt.run(...binds); },
        async all() { return { results: stmt.all(...binds) }; },
        bind(...b) { return bound(b); },
      });
      return bound([]);
    },
  };
  return { raw, env: { DB: api, OPERATOR_NAME: 'jen', TELEGRAM_BOT_TOKEN: TOKEN, ...extra } };
}

function engage(env, body) {
  return index.fetch(
    new Request('https://worker.example/api/ui/engage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': initData() },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
}

const CA = '0x2FAdd42A9E5193Aa7d535806e4d4d8B879013dD2';

// REGRESSION: the Mini App contract dead end.
//
// The operator pasted a Base contract into Hunt and got no authorization card that
// offered '/policy | /seed | /own' and 'program: unscoped'. Three separate faults
// produced it, and each one alone re-created the dead end:
//   1. ensureProgram() never received a chainId, so an address could not resolve
//      to chain:<id>:<address> at all (Telegram always passed one);
//   2. refusalFor() resolved the collapsed PROGRAM ID ('unscoped') instead of the
//      operator's text, so the address-specific card was never selected;
//   3. readAnswers() dropped 'chain', so even a correct chain tap was discarded.

test('a bare contract asks for its chain instead of refusing', async () => {
  const { env } = makeEnv();
  const res = await engage(env, { text: CA });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.kind, 'questions', 'a contract must be a question, not a refusal');
  assert.equal(body.questions.length, 1);
  assert.equal(body.questions[0].key, 'chain');
  assert.ok(body.questions[0].options.length >= 2, 'the operator needs chains to choose from');
  assert.equal(body.message, undefined, 'no refusal is shown before the chain is known');
});

test('the chain answer resolves the contract to a chain-scoped program id', async () => {
  const { env } = makeEnv();
  const res = await engage(env, { text: CA, answers: { chain: '8453' } });
  const body = await res.json();
  assert.equal(body.ok, true);
  // The identity fix: the id must carry the chain, never a bare address and never
  // 'unscoped'. This is the difference between two engagements and one.
  assert.equal(body.programId, 'chain:8453:0x2fadd42a9e5193aa7d535806e4d4d8b879013dd2');
  assert.notEqual(body.kind, 'questions', 'the chain is known, so nothing is asked again');
});

test('two chains on the same bytes are two different programs', async () => {
  const { env } = makeEnv();
  const a = await (await engage(env, { text: CA, answers: { chain: '8453' } })).json();
  const b = await (await engage(env, { text: CA, answers: { chain: '1' } })).json();
  assert.notEqual(a.programId, b.programId);
  assert.match(a.programId, /^chain:8453:/);
  assert.match(b.programId, /^chain:1:/);
});

// NEGATIVE CONTROL: a host is a third party's live service and still needs an
// anchor. Hoisting the chain question above the gate must not have loosened it.
test('a host still has no anchor-free path, and gets no chain question', async () => {
  const { env } = makeEnv();
  const body = await (await engage(env, { text: 'example.com' })).json();
  assert.notEqual(body.kind, 'questions');
  assert.equal(body.kind, 'unauthorized');
  assert.match(body.message, /NO AUTHORIZATION ON FILE/);
});
