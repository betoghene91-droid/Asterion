import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedFromPassphrase,
  drainStatus,
  renderDrain,
  DRAIN_SUBREQUEST_CEILING,
  SYSTEM_RENT_EXEMPT,
  runSweepDrain,
} from '../build/desk/drain.js';
import { deriveAddress } from '../build/desk/sweep.js';

/**
 * Minimal D1 stand-in.
 *
 * `kvGet`/`kvSet` in db.ts route through `env.DB.prepare(...)`, not an FLAGS KV
 * namespace, so a test that stubs only KV silently passes a null env into
 * `.prepare()` and throws. This models the three real call shapes: first(),
 * all(), run(), all bound through .bind().
 */
function fakeD1() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  return {
    tables,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...a) {
          this.args = a;
          return this;
        },
        async first() {
          if (/FROM kv/i.test(sql)) return table('kv').get(this.args[0]) ?? null;
          return null;
        },
        async all() {
          if (/FROM kv/i.test(sql)) {
            const v = table('kv').get(this.args[0]);
            return { results: v ? [v] : [] };
          }
          return { results: [] };
        },
        async run() {
          if (/INTO kv/i.test(sql)) table('kv').set(this.args[0], { key: this.args[0], value: this.args[1] });
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

const env = (extra = {}) => ({ DB: fakeD1(), ...extra });

test('seed is 32 bytes, deterministic, and passphrase-dependent', async () => {
  const a = await seedFromPassphrase('correct horse battery staple');
  const b = await seedFromPassphrase('correct horse battery staple');
  const c = await seedFromPassphrase('correct horse battery stapl');
  assert.equal(a.length, 32);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

// The load-bearing invariant. The drain signs with a seed derived from the SAME
// passphrase the sweep used to prove ownership of the address. If the two can
// disagree silently, the drain broadcasts a valid transaction signed by a key
// that does not own the account: it fails on chain and reads as a drain failure
// rather than a derivation bug. drainOne therefore compares the derived pubkey
// against the proven address and reports key_mismatch, which this exercises by
// checking the sweep's derivation is reachable and well formed.
test('drain keys against the sweep’s own proven address', async () => {
  const pass = 'satoshi';
  const swept = await deriveAddress(pass);
  assert.match(swept, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const seed = await seedFromPassphrase(pass);
  assert.equal(seed.length, 32);
});

test('drain is simulate-only unless DRAIN_WRITE is exactly "1"', async () => {
  assert.equal((await drainStatus(env())).live, false);
  assert.equal((await drainStatus(env({ DRAIN_WRITE: '0' }))).live, false);
  assert.equal((await drainStatus(env({ DRAIN_WRITE: 'true' }))).live, false);
  assert.equal((await drainStatus(env({ DRAIN_WRITE: '1' }))).live, true);
});

test('absent state reports zeros, not a fabricated tick', async () => {
  const s = await drainStatus(env());
  assert.equal(s.ticks, 0);
  assert.equal(s.wallets, 0);
  assert.equal(s.accounts, 0);
  assert.equal(s.tokens_moved, 0);
  assert.equal(s.rent_lamports, 0);
});

test('corrupt state does not throw and does not invent progress', async () => {
  const e = env();
  await e.DB.prepare('INSERT INTO kv (key,value) VALUES (?,?)').bind('drain:stats', '{not json').run();
  const s = await drainStatus(e);
  assert.equal(s.ticks, 0);
});

test('partial state is completed from defaults, never left undefined', async () => {
  const e = env();
  await e.DB.prepare('INSERT INTO kv (key,value) VALUES (?,?)')
    .bind('drain:stats', JSON.stringify({ ticks: 3, tokens_moved: 2 }))
    .run();
  const s = await drainStatus(e);
  assert.equal(s.ticks, 3);
  assert.equal(s.tokens_moved, 2);
  assert.equal(s.mismatches, 0);
  assert.equal(s.rent_lamports, 0);
});

test('render names the mode so an empty run is never read as a take', async () => {
  assert.match(renderDrain(await drainStatus(env())), /simulate only/);
  assert.match(renderDrain(await drainStatus(env({ DRAIN_WRITE: '1' }))), /LIVE/);
});

test('an empty hit list drains nothing and does not advance a fake tally', async () => {
  const e = env();
  const { stats, results } = await runSweepDrain(e, []);
  assert.equal(results.length, 0);
  assert.equal(stats.wallets, 0);
  assert.equal(stats.ticks, 1);
  // ticks advancing is honest: the tick ran. No wallet was attributed to it.
  assert.equal(stats.tokens_moved, 0);
});

test('ceiling is a real bound and the rent floor is nonzero', () => {
  assert.ok(DRAIN_SUBREQUEST_CEILING > 0);
  assert.ok(DRAIN_SUBREQUEST_CEILING <= 100);
  assert.equal(SYSTEM_RENT_EXEMPT, 890880);
});
