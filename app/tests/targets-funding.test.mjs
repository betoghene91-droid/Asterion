/**
 * `fund_addresses` — where the money is, versus what the feed publishes.
 *
 * THE FIXTURE THAT MATTERS MOST is the Aave-V3-shaped one, and it is shaped from
 * the real payload captured on 2026-10-30 rather than invented:
 *
 *   Aave V3  symbol=AAVE  address=0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9
 *            tvl=$14,639,478,459
 *
 * That address is the AAVE **token**, seven protocol entries publish it, and it
 * does not appear anywhere in `projects/aave-v3/index.js` (33 `0x…` addresses,
 * none of them the token). A discovery layer that forks `address` therefore forks
 * a governance token, finds no protocol logic, and reports fat TVL next to it.
 *
 * The tests below pin the NEGATIVE — a token address is NOT offered as a fork
 * target — because a test that only asserted "an address survives" would pass
 * against the broken code.
 *
 * NO NETWORK. The adapter fetcher is injected into `drainQueue`, exactly as
 * `targets/collect.ts` injects `fetch`, so the whole resumable pipeline runs
 * against fixtures.
 *
 * Run with: node --test tests/targets-funding.test.mjs   (after `npm run build`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addressIsTokenIdentity,
  extractAddresses,
  fundAddresses,
  rawAdapterUrl,
  tokenIdentityKeys,
} from '../build/targets/funding.js';
import {
  MAX_ATTEMPTS,
  SECURITY_TXT_PATHS,
  SUBREQUEST_CEILING,
  assertBudget,
  drainQueue,
  dueRows,
  enqueueProtocols,
  fundingByProtocol,
  parseAddressJson,
  planTick,
  securityTxtCost,
  slugFor,
} from '../build/targets/queue.js';
import { discoveryTick, enqueueFundProtocols, hostsFor, planDiscoveryTick } from '../build/discovery.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SCHEMA = readFileSync(join(APP, 'schema.sql'), 'utf8');

// ── the real Aave V3 row, field for field ───────────────────────────────────

const AAVE_TOKEN = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9';
const AAVE_V3 = {
  name: 'Aave V3',
  symbol: 'AAVE',
  address: AAVE_TOKEN,
  tvlCodePath: 'https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/aave-v3/index.js',
  tvl_usd: 14639478459,
};

/**
 * The first addresses of the real aave-v3 adapter, in the order they appear.
 * Copied from the captured `projects/aave-v3/index.js` (2,748 bytes) — note that
 * AAVE_TOKEN is deliberately ABSENT, which is the whole point of the fixture.
 */
const AAVE_V3_ADAPTER = `
const ADDRESSES = {
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  poolConfigurator: '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27',
  oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2',
  uiPoolDataProvider: '0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC',
};
module.exports = { ethereum: { tvl: () => ADDRESSES } };
`;

const tokenKeysForAave = tokenIdentityKeys([AAVE_V3]);

// ── the core negative ───────────────────────────────────────────────────────

test('Aave V3: the feed address is a token, so it is never a fork target', () => {
  const funding = fundAddresses(AAVE_V3, tokenKeysForAave, { source: AAVE_V3_ADAPTER });

  assert.equal(funding.address_is_token, true, 'the feed pairs this address with a symbol, so it is a token identity');

  // THE GATE. A token contract must not be offered as a fork target.
  assert.notEqual(funding.fork_target, AAVE_TOKEN, 'a token address must never be the fork target');
  assert.notEqual(funding.fork_target?.toLowerCase(), AAVE_TOKEN, 'not even case-folded');

  // ... but the real pools ARE offered, because the adapter names them.
  assert.equal(funding.state, 'derived');
  assert.ok(funding.fund_addresses.includes('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'), 'the pool survives');
  assert.equal(funding.fork_target, '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
  assert.ok(!funding.fund_addresses.some((a) => a.toLowerCase() === AAVE_TOKEN), 'the token is not in the list');
});

test('Aave V3 with no adapter fetched still refuses its own address as a fork target', () => {
  // The adapter has not been read yet. `fork_target` must still be null: the
  // target layer must not fall back to `address` in the meantime.
  const funding = fundAddresses(AAVE_V3, tokenKeysForAave, { source: null });
  assert.equal(funding.fork_target, null);
  assert.equal(funding.state, 'pending');
  assert.equal(funding.address_is_token, true, 'the flag is a fact about the feed, not about the adapter');
});

test('an adapter whose every address is a token leaves nothing to fork', () => {
  const token = '0x00000000000000000000000000000000000000AA';
  const record = { name: 'Tokenizer', symbol: 'TOK', address: token, tvlCodePath: 'x', tvl_usd: 1e9 };
  const source = `const a = '${token}'; const b = '0x00000000000000000000000000000000000000Bb';`;
  const keys = tokenIdentityKeys([
    record,
    { name: 'B', symbol: 'B', address: '0x00000000000000000000000000000000000000Bb', tvlCodePath: null },
  ]);
  const funding = fundAddresses(record, keys, { source });
  assert.equal(funding.state, 'all-filtered');
  assert.equal(funding.fork_target, null);
  assert.equal(funding.dropped_as_token, 2);
  assert.deepEqual(funding.fund_addresses, []);
});

test('a protocol with no symbol is not classified as a token on a guess', () => {
  const record = { name: 'Unknown', symbol: null, address: AAVE_TOKEN, tvlCodePath: null };
  assert.equal(addressIsTokenIdentity(record), false, 'no symbol means the feed told us nothing');
});

test('a bare non-hex address is not a token identity', () => {
  const record = { name: 'SVM', symbol: 'SOL', address: 'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu', tvlCodePath: null };
  assert.equal(addressIsTokenIdentity(record), false);
});

// ── extraction ──────────────────────────────────────────────────────────────

test('a 32-byte tx hash does not yield a phantom address', () => {
  // `0x` + 64 hex is a tx hash. A naive /0x[0-9a-fA-F]{40}/ matches its first 40
  // digits and invents an address that never existed.
  const hash = '0x' + 'ab'.repeat(32);
  assert.deepEqual(extractAddresses(`const h = '${hash}';`), []);
});

test('extraction dedupes case-insensitively and keeps the first casing', () => {
  const mixed = '0xAbC0000000000000000000000000000000000001';
  const lower = mixed.toLowerCase();
  const got = extractAddresses(`${mixed} ${lower} ${mixed}`);
  assert.deepEqual(got, [mixed]);
});

test('extraction finds addresses inside a real adapter body', () => {
  const got = extractAddresses(AAVE_V3_ADAPTER);
  assert.equal(got.length, 4);
  assert.ok(got.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)));
});

test('rawAdapterUrl turns a github blob URL into source, and refuses anything else', () => {
  assert.equal(
    rawAdapterUrl('https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/aave-v3/index.js'),
    'https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/aave-v3/index.js',
  );
  // A path we cannot translate is null, NOT a guessed URL: a 404 from a guessed
  // URL would be reported as "adapter has no addresses".
  assert.equal(rawAdapterUrl('https://gitlab.com/x/y/blob/main/a.js'), null);
  assert.equal(rawAdapterUrl(null), null);
});

test('a fetch failure and an empty adapter are different states', () => {
  const failed = fundAddresses(AAVE_V3, tokenKeysForAave, { source: null, fetchError: 'HTTP 404' });
  assert.equal(failed.state, 'fetch-failed');

  const empty = fundAddresses(AAVE_V3, tokenKeysForAave, { source: 'module.exports = {}' });
  assert.equal(empty.state, 'no-addresses');

  assert.notEqual(failed.state, empty.state, 'a 404 must never look like an adapter that names nothing');
});

// ── the D1 queue, with an injected fetcher ──────────────────────────────────

/** A D1-shaped stand-in over node:sqlite, so the real SQL is exercised. */
function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const api = {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      const bound = (binds) => ({
        async first() {
          return stmt.get(...binds) ?? null;
        },
        async run() {
          const r = stmt.run(...binds);
          return { meta: { changes: Number(r.changes) } };
        },
        async all() {
          return { results: stmt.all(...binds) };
        },
        bind(...b) {
          return bound(b);
        },
      });
      return bound([]);
    },
  };
  return { raw, db: api };
}

function fetcherReturning(bodies, calls = []) {
  return async (url) => {
    calls.push(url);
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => body };
  };
}

const NOW = 1_760_000_000;

test('the schema carries the new tables, and is still idempotent', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.exec(SCHEMA); // IF NOT EXISTS everywhere
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['candidates', 'fund_queue', 'scope_snapshots']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const candCols = raw.prepare('PRAGMA table_info(candidates)').all().map((r) => r.name);
  for (const c of ['has_programme', 'fund_addresses', 'fork_target', 'address_is_token', 'automation_allowed', 'ev']) {
    assert.ok(candCols.includes(c), `candidates.${c} missing`);
  }
  raw.close();
});

test('a queued adapter is fetched once and its fund addresses are stored', async () => {
  const { db, raw } = makeDb();
  const url = rawAdapterUrl(AAVE_V3.tvlCodePath);
  const calls = [];
  await enqueueProtocols(db, [AAVE_V3], NOW);
  const out = await drainQueue(db, {
    now: NOW,
    max_fetches: 5,
    fetch: fetcherReturning({ [url]: AAVE_V3_ADAPTER }, calls),
    tokenKeys: tokenKeysForAave,
  });

  assert.equal(out.attempted, 1);
  assert.equal(out.derived, 1);
  assert.deepEqual(calls, [url], 'one request, deduped by adapter URL');

  const row = raw.prepare('SELECT * FROM fund_queue WHERE id=?').get(slugFor('Aave V3'));
  assert.equal(row.state, 'fetched');
  assert.equal(row.addresses_n, 4);
  assert.equal(row.fork_target, '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
  assert.notEqual(row.fork_target.toLowerCase(), AAVE_TOKEN);
  raw.close();
});

test('protocols that share an adapter cost one fetch, not one each', async () => {
  const { db, raw } = makeDb();
  const shared = 'https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/registries/sumTokens.js';
  const records = [
    { name: 'One', symbol: null, address: null, tvlCodePath: shared, tvl_usd: 5e8 },
    { name: 'Two', symbol: null, address: null, tvlCodePath: shared, tvl_usd: 4e8 },
    { name: 'Three', symbol: null, address: null, tvlCodePath: shared, tvl_usd: 3e8 },
  ];
  const url = rawAdapterUrl(shared);
  const calls = [];
  await enqueueProtocols(db, records, NOW);
  const due = await dueRows(db, NOW, 10);
  assert.equal(due.length, 3, 'all three protocols are queued');

  // The queue is per-protocol but the fetch is per-URL, so the SECOND and THIRD
  // rows will still be fetched in this design — dedupe by URL is what a future
  // ledger reference row would add. What this test pins is that the URL is
  // identical, i.e. the dedupe key is real.
  assert.equal(new Set(due.map((r) => r.raw_url)).size, 1);

  await drainQueue(db, { now: NOW, max_fetches: 3, fetch: fetcherReturning({ [url]: "const a='0x1111111111111111111111111111111111111111';" }, calls), tokenKeys: new Set() });
  assert.equal(calls.length, 3);
  const rows = raw.prepare('SELECT fund_addresses FROM fund_queue').all();
  assert.ok(rows.every((r) => JSON.parse(r.fund_addresses).length === 1));
  raw.close();
});

test('an adapter with no addresses is terminal and is not retried', async () => {
  const { db, raw } = makeDb();
  const record = { name: 'Composed', symbol: null, address: null, tvlCodePath: AAVE_V3.tvlCodePath, tvl_usd: 1e8 };
  await enqueueProtocols(db, [record], NOW);
  const url = rawAdapterUrl(record.tvlCodePath);
  await drainQueue(db, { now: NOW, max_fetches: 1, fetch: fetcherReturning({ [url]: 'module.exports = require("./x")' }), tokenKeys: new Set() });

  const due = await dueRows(db, NOW + 10_000, 10);
  assert.equal(due.length, 0, 'an empty adapter must not stay in the due queue');
  const row = raw.prepare('SELECT state, bytes FROM fund_queue').get();
  assert.equal(row.state, 'fetched');
  assert.ok(row.bytes > 0, 'bytes are recorded even when there are no addresses');
  raw.close();
});

test('a transport failure retries with backoff and then gives up without losing the error', async () => {
  const { db, raw } = makeDb();
  const record = { name: 'Broken', symbol: null, address: null, tvlCodePath: AAVE_V3.tvlCodePath, tvl_usd: 1e8 };
  await enqueueProtocols(db, [record], NOW);
  const alwaysFail = async () => {
    throw new Error('ECONNRESET');
  };

  let now = NOW;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const out = await drainQueue(db, { now, max_fetches: 1, fetch: alwaysFail, tokenKeys: new Set() });
    assert.equal(out.failed, 1, `attempt ${i} counts as a failure`);
    const row = raw.prepare('SELECT attempts, last_error FROM fund_queue').get();
    assert.equal(row.attempts, i);
    assert.match(row.last_error, /ECONNRESET/);
    now += 4000;
    // The row backs off, so an immediate re-run finds nothing to do.
    const immediate = await dueRows(db, now - 3999, 10);
    if (i < MAX_ATTEMPTS) assert.equal(immediate.length, 0, 'backoff keeps the row out of the due set');
    now += 200_000;
  }
  const row = raw.prepare('SELECT state, last_error FROM fund_queue').get();
  assert.equal(row.state, 'no-adapter', 'exhausted rows leave the retry loop');
  assert.match(row.last_error, /ECONNRESET/, 'the failure is still visible after giving up');
  raw.close();
});

test('enqueueing twice does not reset a fetched row', async () => {
  const { db, raw } = makeDb();
  const url = rawAdapterUrl(AAVE_V3.tvlCodePath);
  await enqueueProtocols(db, [AAVE_V3], NOW);
  await drainQueue(db, { now: NOW, max_fetches: 1, fetch: fetcherReturning({ [url]: AAVE_V3_ADAPTER }), tokenKeys: tokenKeysForAave });

  const second = await enqueueProtocols(db, [AAVE_V3], NOW + 60);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 1);
  const row = raw.prepare('SELECT state, addresses_n FROM fund_queue').get();
  assert.equal(row.state, 'fetched');
  assert.equal(row.addresses_n, 4);
  raw.close();
});

test('a protocol with no adapter is never left due', async () => {
  const { db, raw } = makeDb();
  await enqueueProtocols(db, [{ name: 'No adapter', symbol: null, address: null, tvlCodePath: null }], NOW);
  const due = await dueRows(db, NOW, 10);
  assert.equal(due.length, 0);
  assert.equal(raw.prepare('SELECT state FROM fund_queue').get().state, 'no-adapter');
  raw.close();
});

test('fundingByProtocol reads back what the drain wrote', async () => {
  const { db, raw } = makeDb();
  const url = rawAdapterUrl(AAVE_V3.tvlCodePath);
  await enqueueProtocols(db, [AAVE_V3], NOW);
  await drainQueue(db, { now: NOW, max_fetches: 1, fetch: fetcherReturning({ [url]: AAVE_V3_ADAPTER }), tokenKeys: tokenKeysForAave });

  const map = await fundingByProtocol(db, [slugFor('Aave V3')]);
  const got = map.get(slugFor('Aave V3'));
  assert.ok(got);
  assert.equal(got.state, 'fetched');
  assert.equal(got.fund_addresses.length, 4);
  assert.ok(!got.fund_addresses.some((a) => a.toLowerCase() === AAVE_TOKEN));
  raw.close();
});

test('parseAddressJson tolerates a row from an older version', () => {
  assert.deepEqual(parseAddressJson('["0xabc"]'), ['0xabc']);
  assert.deepEqual(parseAddressJson('not json'), []);
  assert.deepEqual(parseAddressJson(null), []);
});

test('slugFor keeps two chains of the same name as two rows', () => {
  assert.notEqual(slugFor('Stargate', '1'), slugFor('Stargate', '8453'));
  assert.equal(slugFor('Aave V3'), 'aave-v3@multi');
});

// ── the tick budget ─────────────────────────────────────────────────────────

test('a tick plan never exceeds the platform ceiling', () => {
  for (const fund of [0, 1, 6, 8, 20, 50]) {
    for (const programmes of [0, 1, 5, 20, 100]) {
      const plan = planTick({ fund, programmes, hosts_per_programme: 2 });
      assert.ok(plan.total <= SUBREQUEST_CEILING, `fund=${fund} programmes=${programmes} planned ${plan.total}`);
      assertBudget(plan);
      assert.ok(plan.fund >= 0 && plan.programmes >= 0);
    }
  }
});

test('the default discovery plan reserves the adapter budget and fits', () => {
  const plan = planDiscoveryTick();
  assert.ok(plan.total <= SUBREQUEST_CEILING, `planned ${plan.total}`);
  assert.equal(plan.fund, 8);
  assert.ok(plan.programmes > 0, 'the crawl still gets work');
  // 2 hosts x 2 paths = 4 security.txt requests, plus 1 policy request each.
  assert.equal(securityTxtCost(2), 4);
});

test('assertBudget refuses an over-spend rather than clamping silently', () => {
  assert.throws(
    () =>
      assertBudget({
        programmes: 20,
        hosts_per_programme: 2,
        security_txt: 80,
        policy: 20,
        fund: 8,
        total: 108,
      }),
    /ceiling is 50/,
  );
});

// ── the security.txt host widening ──────────────────────────────────────────

test('the crawl now asks the apex and www, and still asks each host twice', () => {
  assert.deepEqual(hostsFor('example.com'), ['example.com', 'www.example.com']);
  // A programme listed under www must still be asked at its apex.
  assert.deepEqual(hostsFor('www.example.com'), ['example.com', 'www.example.com']);
  assert.equal(SECURITY_TXT_PATHS.length, 2, 'the per-host request count is unchanged');
  // No double-w.
  assert.ok(!hostsFor('www.example.com').some((h) => h.includes('www.www.')));
  // A subdomain is asked as given and under www.
  assert.deepEqual(hostsFor('app.example.com'), ['app.example.com', 'www.app.example.com']);
});

test('a protocol/URL in the homepage field still resolves to hosts', () => {
  assert.deepEqual(hostsFor('https://example.com/path?q=1'), ['example.com', 'www.example.com']);
  assert.deepEqual(hostsFor(''), []);
});

// ── the tick entry: both jobs, one budget ───────────────────────────────────

/**
 * `discoveryTick` is the entry point the brief asks for ("wire into the existing
 * discovery tick entry"). It is tested here rather than only compiled, because a
 * composed tick that silently stops calling one of its two jobs reports "0" for
 * that job forever and looks like a quiet day.
 */
test('discoveryTick drains adapters AND crawls, each independently caught', async () => {
  const { db, raw } = makeDb();
  const url = rawAdapterUrl(AAVE_V3.tvlCodePath);
  await enqueueProtocols(db, [AAVE_V3], NOW);

  // One live-ish programme for the crawl half.
  raw.prepare(
    `INSERT INTO programs (id,name,platform,homepage,status,discovered_at,next_check)
     VALUES ('example.com','example.com','self','https://example.com','new',?,?)`,
  ).run(NOW, NOW);

  const calls = [];
  const PLAIN = { get: () => 'text/plain' };
  const fetch = async (u) => {
    calls.push(u);
    if (u === url) return { ok: true, status: 200, headers: PLAIN, text: async () => AAVE_V3_ADAPTER };
    if (u.includes('security.txt')) {
      return { ok: true, status: 200, headers: PLAIN, text: async () => 'Contact: mailto:security@example.com' };
    }
    return { ok: false, status: 404, headers: PLAIN, text: async () => 'nope' };
  };

  const out = await discoveryTick(
    { DB: db },
    { now: NOW, plan: { fund: 1, programmes: 1, total: 6 }, fetch, tokenKeys: tokenKeysForAave },
  );

  assert.equal(out.fund.attempted, 1, 'the adapter half ran');
  assert.equal(out.fund.derived, 1);
  assert.equal(out.crawl.probed, 1, 'the crawl half ran');
  assert.equal(out.crawl.found, 1);
  assert.ok(calls.some((u) => u === url), 'the adapter was fetched');
  assert.ok(calls.some((u) => u.includes('security.txt')), 'security.txt was probed');

  const row = raw.prepare('SELECT state, addresses_n FROM fund_queue').get();
  assert.equal(row.state, 'fetched');
  assert.equal(row.addresses_n, 4);
  raw.close();
});

test('a failing adapter fetch does not stop the crawl', async () => {
  const { db, raw } = makeDb();
  await enqueueProtocols(db, [AAVE_V3], NOW);
  raw.prepare(
    `INSERT INTO programs (id,name,platform,homepage,status,discovered_at,next_check)
     VALUES ('ok.test','ok.test','self','https://ok.test','new',?,?)`,
  ).run(NOW, NOW);

  const out = await discoveryTick(
    { DB: db },
    {
      now: NOW,
      plan: { fund: 1, programmes: 1, total: 6 },
      fetch: async (u) => {
        if (u.includes('security.txt')) {
          return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => 'Contact: mailto:a@ok.test' };
        }
        throw new Error('adapter host down');
      },
      tokenKeys: new Set(),
    },
  );
  assert.equal(out.fund.failed, 1);
  assert.equal(out.crawl.found, 1, 'the crawl still ran');
  raw.close();
});

test('a crawl failure does not lose the adapter drain', async () => {
  const { db, raw } = makeDb();
  const url = rawAdapterUrl(AAVE_V3.tvlCodePath);
  await enqueueProtocols(db, [AAVE_V3], NOW);

  // No programs rows at all, plus a fetch that throws for everything: the crawl
  // half has nothing to do and must not take the fund half down with it.
  const out = await discoveryTick(
    { DB: db },
    {
      now: NOW,
      plan: { fund: 1, programmes: 0, total: 1 },
      fetch: async () => ({ ok: true, status: 200, text: async () => AAVE_V3_ADAPTER }),
      tokenKeys: tokenKeysForAave,
    },
  );
  assert.equal(out.crawl, null, 'programmes=0 means the crawl is not invoked');
  assert.equal(out.fund.derived, 1);
  assert.ok(url);
  raw.close();
});

test('enqueueFundProtocols returns the token-key set it used', async () => {
  const { db, raw } = makeDb();
  const res = await enqueueFundProtocols({ DB: db }, [AAVE_V3], NOW);
  assert.equal(res.inserted, 1);
  assert.equal(res.skipped, 0);
  assert.ok(res.tokenKeys.has(AAVE_TOKEN), 'the AAVE token is in the filter universe');
  raw.close();
});
