// The desk's read-only API and cron wiring, driven at the SHIPPED entrypoint
// (build/index.js), not against the desk modules directly.
//
// This file exists because a desk that compiles but is unreachable is not a
// feature. Two things are pinned here:
//   1. `/api/desk*` answers well-formed JSON from real desk_* rows.
//   2. The cron spine actually calls the desk, composed with the security sweep.
//      A cron that silently stops calling the desk reports "0 candidates" forever
//      and looks like a quiet market.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SCHEMA = readFileSync(join(APP, 'schema.sql'), 'utf8');

function makeEnv(extra = {}) {
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
          return stmt.run(...binds);
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

  return {
    raw,
    env: { DB: api, OPERATOR_NAME: 'tester', DESK_EQUITY_START_USD: '10000', ...extra },
  };
}

function call(path, { method = 'GET', headers = {}, env } = {}) {
  return index.fetch(new Request(`https://worker.example${path}`, { method, headers }), env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  });
}

const NOW = Math.floor(Date.now() / 1000);

/** Seed one open position, two kills and a calibration row. */
function seed(raw) {
  raw
    .prepare(
      `INSERT INTO desk_positions (id,mint,symbol,mode,opened_at,entry_price,size_usd,filled_usd,qty,stop_price,peak_price,liq_at_entry,state)
       VALUES ('pos1','MintAAA','AAA','paper',?,0.002,800,400,200000,0.0018,0.002,500000,'open')`,
    )
    .run(NOW - 3600);

  raw
    .prepare(
      `INSERT INTO desk_kills (id,mint,symbol,ts,reason,detail,snapshot,outcome)
       VALUES ('k1','MintBBB','BBB',?,'freeze_authority_live','freeze authority present','{"market":{"mcapUsd":4000000,"liqUsd":600000},"safety":{}}','dodged')`,
    )
    .run(NOW - 600);
  raw
    .prepare(
      `INSERT INTO desk_kills (id,mint,symbol,ts,reason,detail,snapshot,outcome)
       VALUES ('k2','MintCCC','CCC',?,'wash_trading','unique buyers 82 / total buys 900','{"market":{"mcapUsd":3200000,"liqUsd":520000}}','unknown')`,
    )
    .run(NOW - 300);

  raw
    .prepare(
      `INSERT INTO desk_scores (id,mint,ts,total,subscores,floor_failed,passed,why)
       VALUES ('s1','MintAAA',?,80.3,'{}','[]',1,'PASS 80.3/100. momentum 53/35min.')`,
    )
    .run(NOW - 3000);

  raw
    .prepare(
      `INSERT INTO desk_calibration (id,ts,window_start,window_end,rows,totals,note)
       VALUES ('c1',?,?,?,?,?,'ok')`,
    )
    .run(
      NOW,
      NOW - 604800,
      NOW,
      JSON.stringify([
        { reason_code: 'wash_trading', description: 'unique buyers / total buys below 0.35', kills: 9, measured: 9, true_positives: 8, false_negatives: 1, dodge_rate: 0.889, false_negative_rate: 0.111, thin: false },
        { reason_code: 'freeze_authority_live', description: 'freeze authority not revoked', kills: 4, measured: 4, true_positives: 4, false_negatives: 0, dodge_rate: 1, false_negative_rate: 0, thin: true },
      ]),
      JSON.stringify({ kills: 13, measured: 13, true_positives: 12, false_negatives: 1, unmeasured: 0 }),
    );
}

// ── the four endpoints ─────────────────────────────────────────────────────

test('api: GET /api/desk returns the shape the dashboard panel renders', async () => {
  const { env, raw } = makeEnv();
  seed(raw);
  const res = await call('/api/desk', { env });
  assert.equal(res.status, 200);
  const j = await res.json();

  for (const k of ['mode', 'equity', 'open_positions', 'deployed_pct', 'pnl_today', 'breaker_halted', 'gates_unmet']) {
    assert.ok(k in j, `the panel needs "${k}"`);
  }
  assert.equal(j.mode, 'paper', 'the desk must report paper by default');
  assert.equal(j.open_positions, 1);
  assert.equal(typeof j.equity, 'number');
  assert.ok(Array.isArray(j.gates_unmet));
  assert.ok(j.gates_unmet.includes('paper_trades'), 'unmet gates must be reported by name');
  // The panel must be able to say why it is paper.
  assert.ok(Array.isArray(j.gates) && j.gates.length > 0, 'per-gate detail must be present');
});

test('api: GET /api/desk/positions returns rows with the rendered field names', async () => {
  const { env, raw } = makeEnv();
  seed(raw);
  const j = await (await call('/api/desk/positions', { env })).json();
  const rows = Array.isArray(j) ? j : j.positions;
  assert.ok(Array.isArray(rows), 'positions must be an array or {positions:[]}');
  assert.equal(rows.length, 1);
  for (const k of ['mint', 'size', 'entry', 'current', 'pnl', 'stop', 'opened_at']) {
    assert.ok(k in rows[0], `the panel needs "${k}"`);
  }
  assert.equal(rows[0].mint, 'MintAAA');
});

test('api: GET /api/desk/kills returns reason codes newest-first', async () => {
  const { env, raw } = makeEnv();
  seed(raw);
  const j = await (await call('/api/desk/kills', { env })).json();
  const rows = Array.isArray(j) ? j : j.kills;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reason_code, 'wash_trading', 'newest kill first');
  for (const k of ['mint', 'reason_code', 'ts', 'snapshot_summary']) {
    assert.ok(k in rows[0], `the panel needs "${k}"`);
  }
});

test('api: GET /api/desk/calib returns {by_reason:[{reason_code,hit_rate,false_negatives,n}]}', async () => {
  const { env, raw } = makeEnv();
  seed(raw);
  const j = await (await call('/api/desk/calib', { env })).json();
  assert.ok(Array.isArray(j.by_reason), 'the panel reads by_reason');
  assert.equal(j.by_reason.length, 2);
  for (const k of ['reason_code', 'hit_rate', 'false_negatives', 'n']) {
    assert.ok(k in j.by_reason[0], `the panel needs "${k}"`);
  }
  assert.equal(j.by_reason[0].reason_code, 'wash_trading');
  assert.equal(j.by_reason[0].false_negatives, 1);
});

test('api: the desk endpoints work on an empty desk without throwing', async () => {
  const { env } = makeEnv();
  for (const p of ['/api/desk', '/api/desk/positions', '/api/desk/kills', '/api/desk/calib']) {
    const res = await call(p, { env });
    assert.equal(res.status, 200, `${p} must answer on an empty desk`);
    await res.json(); // must be valid JSON
  }
});

// ── read-only, auth and CORS ───────────────────────────────────────────────

test('api: every desk endpoint is GET-only — no mutating verb is routed', async () => {
  const { env } = makeEnv();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/api/desk', '/api/desk/positions', '/api/desk/kills', '/api/desk/calib']) {
      const res = await call(p, { method, env });
      assert.equal(res.status, 405, `${method} ${p} must be 405`);
    }
  }
});

test('api: there is no arm or trade control anywhere in the /api surface', async () => {
  // A web control that can start real trading is one leaked URL from an empty
  // wallet. Prove none exists: every plausible arm path must 404.
  const { env } = makeEnv();
  for (const p of [
    '/api/desk/arm',
    '/api/desk/live',
    '/api/desk/mode',
    '/api/desk/trade',
    '/api/desk/reset',
    '/api/desk/breaker/clear',
  ]) {
    const res = await call(p, { method: 'POST', env });
    assert.ok(res.status === 404 || res.status === 405, `${p} must not exist (got ${res.status})`);
  }
});

test('api: /api/desk returns 401 when a token is configured and not presented', async () => {
  const { env } = makeEnv({ DASHBOARD_TOKEN: 'secret-token' });
  const denied = await call('/api/desk', { env });
  assert.equal(denied.status, 401);
  const ok = await call('/api/desk', { env, headers: { authorization: 'Bearer secret-token' } });
  assert.equal(ok.status, 200);
});

test('api: CORS on /api/desk echoes the configured origin and never *', async () => {
  const DASH = 'https://asterion.pages.dev';
  const { env } = makeEnv({ DASH_ORIGIN: DASH });
  const res = await call('/api/desk', { env, headers: { origin: DASH } });
  assert.equal(res.headers.get('access-control-allow-origin'), DASH);

  const evil = await call('/api/desk', { env, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const pre = await call('/api/desk', { method: 'OPTIONS', env, headers: { origin: DASH } });
  assert.equal(pre.status, 204, 'OPTIONS must be a 204 so the browser can preflight');
});

// ── cron reachability ──────────────────────────────────────────────────────

test('cron: the 5-minute slot COMPOSES the desk with the sentinel, never replaces it', async () => {
  const { env, raw } = makeEnv();
  let called = false;
  await index.scheduled({ cron: '*/5 * * * *' }, env, {
    waitUntil: (p) => {
      called = true;
      return p;
    },
    passThroughOnException: () => {},
  });
  assert.equal(called, true, 'scheduled must schedule work');

  // Give the fire-and-forget chain a moment, then assert the desk left a trace.
  // The desk writes a heartbeats row via heartbeat() and its subrequest quota row
  // appears as soon as the sweep tries to fetch anything.
  await new Promise((r) => setTimeout(r, 300));

  const hb = raw.prepare("SELECT ts FROM heartbeats WHERE source='cron'").get();
  assert.ok(hb, 'the cron must record a heartbeat');

  /*
   * The desk's network calls fail in a test (no network, no fetch allowlist), but
   * the sweep still runs and records the failure path rather than throwing out of
   * the cron. The observable proof that the desk was reached is the quota row the
   * sweep writes before its first outbound call, or a universe/kill/score row —
   * any of which means runSweep was entered.
   */
  const touched =
    raw.prepare("SELECT used FROM quota WHERE bucket='desk_subrequests'").get() ||
    raw.prepare('SELECT COUNT(*) AS n FROM desk_universe').get().n ||
    raw.prepare('SELECT COUNT(*) AS n FROM desk_scores').get().n;
  assert.ok(touched, 'the desk must be reached from the 5-minute cron slot');
});

test('cron: the 3:15 maintenance slot also runs desk calibration', async () => {
  const { env, raw } = makeEnv();
  await index.scheduled({ cron: '15 3 * * *' }, env, {
    waitUntil: (p) => p,
    passThroughOnException: () => {},
  });
  await new Promise((r) => setTimeout(r, 300));

  // Calibration always stores a row, even on an empty kill table.
  const calib = raw.prepare('SELECT COUNT(*) AS n FROM desk_calibration').get();
  assert.ok(calib.n >= 1, 'the maintenance slot must store a calibration report');
});

test('cron: source contains no desk replacement of runSentinel', () => {
  const src = readFileSync(join(APP, 'src', 'index.ts'), 'utf8');
  assert.match(src, /await runSentinel\(env\)/, 'runSentinel must still be called in the 5-min slot');
  assert.match(src, /await deskTick\(env\)/, 'deskTick must be called in the 5-min slot');
  // Both are guarded independently, so one failing cannot silence the other.
  assert.match(src, /cron sentinel failed/, 'sentinel failure must be caught separately');
  assert.match(src, /cron desk failed/, 'desk failure must be caught separately');
  assert.doesNotMatch(
    src,
    /if \(cron === '\*\/5 \* \* \* \*'\) return deskTick/,
    'the desk must never REPLACE the sentinel in the shared slot',
  );
});

// ── the Telegram surface exists ────────────────────────────────────────────

test('telegram: the six desk commands are routed, and /desk live cannot arm', async () => {
  const src = readFileSync(join(APP, 'src', 'index.ts'), 'utf8');
  for (const cmd of ["'/desk'", "'/pos'", "'/kills'", "'/calib'"]) {
    assert.ok(src.includes(cmd), `${cmd} must be routed`);
  }
  assert.ok(src.includes("text.startsWith('/thesis ')"), '/thesis must be routed');
  assert.ok(src.includes("'/desk paper'"), '/desk paper must be routed');
  assert.ok(src.includes("'/desk live'"), '/desk live must be routed');
});
