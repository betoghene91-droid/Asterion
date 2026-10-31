// THE DEAD-MAN'S SWITCH — task 10, item 3.
//
// The bug this file is written against is not "a threshold was wrong". It is that
// `runDeadman()` computed `quietHours` from `kv['cron_last']` and then ended the
// function with `void quietHours;`, so the number was DISCARDED. The only source
// that could raise an alert was `kv['sentinel_last']` against a hardcoded 2 hours.
//
// That shape of bug passes almost any test you would think to write first:
//   · "does the dead-man job run?"                        yes, it always did
//   · "does a silent sentinel alert?"                     yes, that path worked
//   · "is the alert text well formed?"                    yes
// So nothing here asserts those. Every test below drives `index.scheduled()` — the
// SHIPPED entrypoint — and asserts on the Telegram message the operator would
// actually receive, or on the fact that they receive none. The crucial negative is
// a job that is NOT the sentinel, because that is the case the old code could not
// detect at all.
//
// The other half is attribution: an alert that says "something is quiet" is only
// marginally better than silence. So the message must NAME the first job that
// stopped and the last job that did not.
//
// COLD START is tested as its own property rather than as a special case of
// silence, because conflating the two is the obvious way to "fix" the bug and
// thereby page the operator on the first run of every deploy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import index from '../build/index.js';
import {
  JOB_NAMES,
  QUIET_GRACE_SECONDS,
  QUIET_PERIODS,
  SCHEDULED_JOBS,
  assessJobs,
  quietWindowSeconds,
  renderDeadmanAlert,
} from '../build/deadman.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SCHEMA = readFileSync(join(APP, 'schema.sql'), 'utf8');

const DEADMAN_CRON = '0 */6 * * *';
const NOW_S = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

// ── harness ─────────────────────────────────────────────────────────────────

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
    env: {
      DB: api,
      TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN',
      TELEGRAM_CHAT_ID: '999',
      OPERATOR_NAME: 'tester',
      ...extra,
    },
  };
}

/** Write one job's heartbeat row, exactly as `jobHeartbeat` does. */
function beat(raw, source, ts) {
  raw
    .prepare(
      `INSERT INTO heartbeats (source, ts) VALUES (?,?)
       ON CONFLICT(source) DO UPDATE SET ts=excluded.ts`,
    )
    .run(source, ts);
}

/**
 * Run the dead-man cron through the shipped entrypoint and capture every outbound
 * HTTP call. Telegram is the only thing stubbed: the router, the cron dispatcher,
 * the D1 access and the alert formatting are all real.
 */
async function runDeadmanCron(env) {
  const outbound = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    outbound.push({
      url: String(url),
      body: init && init.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const pending = [];
  try {
    await index.scheduled({ cron: DEADMAN_CRON }, env, {
      waitUntil: (p) => pending.push(p),
      passThroughOnException: () => {},
    });
    await Promise.allSettled(pending);
    // The dispatcher hands the job to waitUntil; give the microtask chain a turn
    // so a beacon written after the alert is visible to the assertions.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    globalThis.fetch = realFetch;
  }
  return outbound;
}

/** The dead-man alerts only — there is no other sender on this cron. */
const alerts = (outbound) =>
  outbound
    .filter((o) => o.url.includes('/sendMessage'))
    .map((o) => String((o.body && o.body.text) || ''));

// ── the windows are DERIVED from cadence, not hand-tuned ────────────────────

test('every job the switch watches has a cadence, and the window follows it', () => {
  // The bug was a hand-tuned `> 2` hours aimed at one key. A window that is a
  // function of the period cannot be tuned per key, so this pins the relationship
  // rather than any particular number.
  for (const job of SCHEDULED_JOBS) {
    assert.equal(
      quietWindowSeconds(job.periodSeconds),
      job.periodSeconds * QUIET_PERIODS + QUIET_GRACE_SECONDS,
      `${job.name}: window must be derived from its own period`,
    );
  }

  // A */5 job is checked far more tightly than a daily one — the ratio of their
  // cadences, not a constant. This is the property the assignment asks for.
  const fast = SCHEDULED_JOBS.find((j) => j.name === 'sentinel');
  const daily = SCHEDULED_JOBS.find((j) => j.name === 'briefing');
  assert.ok(
    quietWindowSeconds(daily.periodSeconds) > quietWindowSeconds(fast.periodSeconds) * 100,
    'a daily job must tolerate far more quiet than a 5-minute job',
  );
});

test('the five cron expressions in wrangler.toml are covered, and so is each job in a shared slot', () => {
  const wrangler = readFileSync(join(APP, 'wrangler.toml'), 'utf8');
  const declared = [...wrangler.matchAll(/^\s*"(\*\/5 \* \* \* \*|0 \* \* \* \*|15 3 \* \* \*|0 \*\/6 \* \* \*|30 6 \* \* \*)"\s*,?\s*(?:#.*)?$/gm)].map(
    (m) => m[1],
  );
  assert.equal(declared.length, 5, 'wrangler.toml declares exactly five cron triggers');

  const covered = new Set(SCHEDULED_JOBS.map((j) => j.cron));
  for (const c of declared) assert.ok(covered.has(c), `no watched job runs on ${c}`);

  // Two jobs share the 5-minute slot and two share the hourly one. Each half gets
  // its OWN row, because one half failing must be attributable on its own — that
  // is the whole point of per-job heartbeats.
  const perCron = {};
  for (const j of SCHEDULED_JOBS) perCron[j.cron] = (perCron[j.cron] ?? 0) + 1;
  assert.equal(perCron['*/5 * * * *'], 2, 'sentinel and the desk tick are separate jobs');
  assert.equal(perCron['0 * * * *'], 2, 'crawler and the desk analyst are separate jobs');
  assert.equal(perCron['15 3 * * *'], 2, 'maintenance and desk calibration are separate jobs');
});

// ── THE BUG: a non-sentinel job going silent must alert ─────────────────────

test('a job that has gone silent past its window produces an alert NAMING it', async () => {
  const { raw, env } = makeEnv();
  const now = NOW_S();

  // Everything is healthy EXCEPT the crawler, which stopped 5 hours ago. The
  // sentinel — the only source the old code checked — is beating normally, so the
  // old implementation sent nothing here. That is the defect, restated as a test.
  for (const name of JOB_NAMES) {
    if (name === 'crawler') continue;
    if (name === 'deadman') continue;
    beat(raw, name, now - 60);
  }
  beat(raw, 'crawler', now - 5 * HOUR);

  const sent = await runDeadmanCron(env);
  const bodies = alerts(sent);
  assert.equal(bodies.length, 1, 'exactly one dead-man alert');
  const text = bodies[0];

  assert.match(text, /DEAD-MAN/, 'the operator must see it is the switch talking');
  assert.match(text, /first gone/i, 'the alert must name the first job that stopped');
  assert.match(text, /crawler/, 'and that job must be the crawler, not "cron"');
  assert.match(text, /last ok/i, 'the alert must say what was still working');

  // Attribution: the sentinel was healthy, so it must NOT be presented as gone.
  const firstGoneLine = text.split('\n').find((l) => /first gone/i.test(l)) ?? '';
  assert.doesNotMatch(firstGoneLine, /sentinel/, 'a beating job must not be named as gone');
});

test("the dead-man alert names the LAST job that succeeded, not just the first that failed", async () => {
  const { raw, env } = makeEnv();
  const now = NOW_S();

  // sentinel beat 10m ago, desk_tick 20m ago, crawler 5h ago (dead).
  beat(raw, 'sentinel', now - 600);
  beat(raw, 'desk_tick', now - 1200);
  beat(raw, 'crawler', now - 5 * HOUR);
  beat(raw, 'desk_analyst', now - 300);
  beat(raw, 'maintenance', now - HOUR);
  beat(raw, 'desk_calibration', now - HOUR);
  beat(raw, 'briefing', now - HOUR);

  const bodies = alerts(await runDeadmanCron(env));
  assert.equal(bodies.length, 1);
  const text = bodies[0];

  const lastLine = text.split('\n').find((l) => /last ok/i.test(l)) ?? '';
  // desk_analyst beat 300s ago, which is the newest of the healthy jobs.
  assert.match(lastLine, /desk_analyst/, 'the newest successful job must be named');
  assert.match(lastLine, /5m|4m|300s/i, 'and how long ago it beat');
});

test('nothing is alerted when every job is inside its own window', async () => {
  const { raw, env } = makeEnv();
  const now = NOW_S();
  // Each job beat recently enough for ITS cadence: the daily ones an hour ago is
  // fine (window 48h), the 5-minute ones a minute ago is fine (window 12m).
  for (const job of SCHEDULED_JOBS) {
    const age = job.periodSeconds > 3600 ? 3600 : 60;
    beat(raw, job.name, now - age);
  }
  const sent = await runDeadmanCron(env);
  assert.equal(alerts(sent).length, 0, 'a healthy system must be silent');
});

// ── COLD START: no row on a fresh database is not a dead job ────────────────

test('a fresh database produces NO alert, because no job has had its first slot yet', async () => {
  const { env } = makeEnv();
  const sent = await runDeadmanCron(env);
  assert.equal(
    alerts(sent).length,
    0,
    'a missing heartbeat row on a cold database must not page the operator',
  );

  // And the switch still recorded its OWN beat, which is what stops the next run
  // from re-deriving the same cold start forever.
  const { raw } = makeEnv();
  const env2 = makeEnv();
  await runDeadmanCron(env2.env);
  const own = env2.raw.prepare("SELECT ts FROM heartbeats WHERE source='deadman'").get();
  assert.ok(own, 'the dead-man job must beat like every other job');
  void raw;
});

test('cold start self-clears: a job that has still never run AFTER its window is silent', () => {
  const now = 1_800_000_000;
  // The observation began 3 days ago (some job beat then) and `briefing` has never
  // produced a row. 3 days > its 48h window, so "never ran" is now a real fault.
  const decades = now - 3 * 86400;
  const health = assessJobs({
    now,
    lastTs: { sentinel: now - 60, crawler: decades },
    observedSince: decades,
  });
  const briefing = health.find((h) => h.name === 'briefing');
  assert.equal(briefing.state, 'silent', 'a job that never ran in an old deployment is not cold');

  // But within the window it is still cold — the same input, a newer observation.
  const fresh = assessJobs({
    now,
    lastTs: {},
    observedSince: now - 600,
  });
  const briefingFresh = fresh.find((h) => h.name === 'briefing');
  assert.equal(briefingFresh.state, 'cold_start', '10 minutes in, a daily job has not missed anything');
});

test('cold start is per-cadence: 13 minutes in, a 5-minute job is already silent but a daily one is not', () => {
  const now = 1_800_000_000;
  const health = assessJobs({ now, lastTs: {}, observedSince: now - 13 * 60 });
  const sentinel = health.find((h) => h.name === 'sentinel');
  const briefing = health.find((h) => h.name === 'briefing');
  // sentinel window = 300*2 + 120 = 720s = 12m; 13m > 12m, so "never ran" is a fault.
  assert.equal(sentinel.state, 'silent');
  // briefing window = 48h + 2m; 13m is nowhere near it.
  assert.equal(briefing.state, 'cold_start');
});

// ── the dead-man job must not report ITSELF dead every run ──────────────────

test('the dead-man job does not self-alert on its own normal 6-hourly cadence', async () => {
  const { raw, env } = makeEnv();
  const now = NOW_S();
  for (const job of SCHEDULED_JOBS) {
    if (job.name === 'deadman') continue;
    const age = job.periodSeconds > 3600 ? 3600 : 60;
    beat(raw, job.name, now - age);
  }
  // It last ran a normal 6 hours ago. Its own window is 13h, so that is healthy.
  beat(raw, 'deadman', now - 6 * HOUR);

  const sent = await runDeadmanCron(env);
  assert.equal(alerts(sent).length, 0, 'a normal 6-hourly run must not alert about itself');
});

test('the dead-man job DOES report itself when it was actually stalled — check runs before its own beat', async () => {
  const { raw, env } = makeEnv();
  const now = NOW_S();
  for (const job of SCHEDULED_JOBS) {
    if (job.name === 'deadman') continue;
    const age = job.periodSeconds > 3600 ? 3600 : 60;
    beat(raw, job.name, now - age);
  }
  // 20h since the last switch run: two of its own periods have passed. Nothing
  // else is late, so the only thing that can be named is the switch itself.
  beat(raw, 'deadman', now - 20 * HOUR);

  const bodies = alerts(await runDeadmanCron(env));
  assert.equal(bodies.length, 1, 'a genuinely stalled switch must say so');
  assert.match(bodies[0], /deadman/, 'and name itself');

  // ORDERING IS THE PROPERTY, not a detail: the row must have been REFRESHED by
  // this run (a beat written before the check would make self-detection
  // impossible, since its own row would always be one second old).
  const after = raw.prepare("SELECT ts FROM heartbeats WHERE source='deadman'").get();
  assert.ok(after.ts >= now - 5, 'this run recorded its own beat');
});

test('a stalled switch alerts ONCE, not on every subsequent run', async () => {
  const { raw, env } = makeEnv();
  const now = NOW_S();
  for (const job of SCHEDULED_JOBS) {
    if (job.name === 'deadman') continue;
    const age = job.periodSeconds > 3600 ? 3600 : 60;
    beat(raw, job.name, now - age);
  }
  beat(raw, 'deadman', now - 20 * HOUR);

  assert.equal(alerts(await runDeadmanCron(env)).length, 1, 'first run after the stall alerts');
  // The beat it wrote cleared the condition. A second run immediately after is
  // inside the window, so it must be silent — that is what makes this a switch
  // and not a repeating alarm.
  assert.equal(alerts(await runDeadmanCron(env)).length, 0, 'the next run must not repeat it');
});

// ── the operator-visible status views must keep working ─────────────────────

test('the Ops status view and /api/status keep reading cron_last after the heartbeat change', async () => {
  const { raw, env } = makeEnv();
  // Run any slot; the aggregate row is what those views read.
  const pending = [];
  await index.scheduled({ cron: '30 6 * * *' }, env, {
    waitUntil: (p) => pending.push(p),
    passThroughOnException: () => {},
  });
  await Promise.allSettled(pending);
  await new Promise((r) => setTimeout(r, 100));

  const cronLast = raw.prepare("SELECT ts FROM kv WHERE key='cron_last'").get();
  assert.ok(cronLast, "kv['cron_last'] must still be written for the status views");
  assert.ok(cronLast.ts > 0);

  const res = await index.fetch(
    new Request('https://worker.example/api/status', { method: 'GET' }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  );
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.worker, 'ok', 'a just-ran cron must read back as alive');
  assert.ok(j.cron_last, '/api/status must still expose cron_last');
});

test('a heartbeat write failure is not fatal to the job that succeeded', () => {
  // The property lives in `ranJob`: work finishes, the beat is attempted behind
  // its OWN boundary, and a beat that throws must not turn a successful sweep into
  // a thrown cron. Pinned on the source because exporting the private helper to
  // prove a two-line invariant would widen the module surface for the test's sake.
  const src = readFileSync(join(APP, 'src', 'index.ts'), 'utf8');
  const body = src.match(/async function ranJob[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(body, 'ranJob must exist');
  assert.match(body, /await run\(\)/, 'the work runs first');
  assert.match(
    body,
    /try \{\s*\n\s*await jobHeartbeat\(env, job\);\s*\n\s*\} catch \(e\) \{/,
    'the beat must have its own try/catch, so a beat failure cannot be read as job failure',
  );
  assert.match(body, /console\.error\(failureLog, e\)/, 'a failed job is logged, not thrown');
  // And the aggregate row still has the same treatment on the dead-man path.
  const deadman = src.match(/async function runDeadman[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(
    deadman,
    /finally \{[\s\S]*?try \{\s*\n\s*await jobHeartbeat\(env, 'deadman'\);\s*\n\s*\} catch/,
    'a synchronous throw from the D1 handle must not escape the finally',
  );
});

test('a dead-man switch that cannot read the database still does not throw out of the cron', async () => {
  // D1 is the only store, so a case where the aggregate heartbeat at the top of
  // the dispatcher already fails proves nothing about the switch. This shim lets
  // the preamble succeed and fails only the SELECT the switch depends on — i.e.
  // exactly the fault `runDeadman`'s own try/catch exists for.
  const { raw } = makeEnv();
  const api = {
    prepare(sql) {
      if (/SELECT source, ts FROM heartbeats/.test(sql)) {
        throw new Error('D1 exploded reading heartbeats');
      }
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
  const env = { DB: api, TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '999' };

  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  try {
    // Must RESOLVE, not reject: a dead-man failure that propagates cancels the
    // next slot, which would make the watchdog the outage.
    await index.scheduled({ cron: DEADMAN_CRON }, env, {
      waitUntil: (p) => p,
      passThroughOnException: () => {},
    });
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    console.error = realError;
  }
  assert.ok(
    errors.some((e) => /cron deadman failed/.test(e)),
    'the failure must be reported on the log line an operator greps for',
  );
});

// ── the formatter, in isolation ────────────────────────────────────────────

test('renderDeadmanAlert names a never-run job as "never ran", not as a duration', () => {
  const now = 1_800_000_000;
  const text = renderDeadmanAlert([
    { name: 'sentinel', last_ts: now - 60, quiet_seconds: 60, window_seconds: 720, state: 'ok' },
    { name: 'briefing', last_ts: null, quiet_seconds: null, window_seconds: 173_000, state: 'silent' },
  ]);
  assert.ok(text, 'a silent job must produce a message');
  assert.match(text, /never ran/);
  assert.doesNotMatch(text, /silent 0s/);
});

test('renderDeadmanAlert collapses a crowd of silent jobs instead of listing them all', () => {
  const now = 1_800_000_000;
  const health = SCHEDULED_JOBS.map((j, i) => ({
    name: j.name,
    last_ts: now - (i + 1) * 100_000,
    quiet_seconds: (i + 1) * 100_000,
    window_seconds: 60,
    state: 'silent',
  }));
  const text = renderDeadmanAlert(health);
  assert.ok(text);
  assert.match(text, /\+\d+ more/, 'eight silent jobs must not produce eight lines');
  // The least sensible output on a phone screen is a wall of names.
  assert.ok(text.split('\n').length <= 8, 'the alert stays phone-sized');
});
