// PER-ENGAGEMENT RATE LIMITS — task 10, item 4.
//
// THE BUG. `RoE.rate_limit_rps` was declared at `policy.ts:53`, stamped as a
// hardcoded 3 at `policy.ts:705`, and READ NOWHERE. Meanwhile `desk/types.ts`
// described `FLOW_SAMPLE.rateLimitRps` as "Programme rate limit from the RoE ...
// Enforced, not assumed", which was false twice over: the pacing code read the
// constant, and the constant was never the RoE's value.
//
// So the tests here are about a CLAIM becoming true, not about a new feature
// appearing. Three properties carry that:
//
//   1. A brief that declares a rate produces THAT pacing — measured as actual
//      sleep intervals, not as the presence of a number in an object.
//   2. An absent rate preserves today's default exactly (3 rps), so no existing
//      brief or caller changes behaviour.
//   3. A value that cannot be honoured is CLAMPED, and the clamp never goes
//      upward toward "unlimited" — because the old failure mode was a silent
//      substitution, and "0 means go as fast as you like" would be the same bug
//      with a larger blast radius.
//
// Nothing here touches a socket. The RPC caller is injected everywhere.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_LIMIT_RPS_DEFAULT,
  RATE_LIMIT_RPS_MAX,
  RATE_LIMIT_RPS_MIN,
  describeRate,
  normalizeRateLimitRps,
  pacerFor,
  pacerForBrief,
  rateLimitForBrief,
} from '../build/pace.js';
import { compile } from '../build/intake.js';
import { roeFromBrief } from '../build/policy.js';
import { flowProviderFromRpc } from '../build/desk/flow.js';
import { FLOW_SAMPLE } from '../build/desk/types.js';

const NOW = 1_700_000_000;

/** A repo-only brief: no address, so no chain is needed. */
function brief(over = {}) {
  return {
    program_id: 'example.com',
    targets: ['https://github.com/acme/vault'],
    max_mutability: 'read',
    time_box_minutes: 60,
    authorization_ref: 'https://example.com/security permits automated testing',
    ...over,
  };
}

/**
 * A pacer over a fake clock.
 *
 * `sleep` advances the clock instead of waiting, so a spacing rule can be measured
 * exactly and in microseconds. Without this, asserting "1 rps" would mean a real
 * second per call and the suite would be untestable — which is usually the moment
 * somebody replaces the assertion with `assert.ok(pacer)`.
 */
function fakeClock() {
  let t = 1_000_000;
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms) => {
      t += ms;
    },
  };
}

// ── 1. a declared rate governs the pacing ───────────────────────────────────

test('a brief that declares a rate produces the corresponding pacing', async () => {
  const clock = fakeClock();
  const pacer = pacerForBrief({ rate_limit_rps: 2 }, { now: clock.now, sleep: clock.sleep });

  assert.equal(pacer.rps, 2, 'the declared rate must be the rate used');
  assert.equal(pacer.minIntervalMs, 500, '2 rps is one call every 500ms');

  // Four calls back to back. The first is free (nothing has been sent yet); the
  // next three must each wait one interval.
  for (let i = 0; i < 4; i++) await pacer.awaitSlot();

  assert.deepEqual(clock.slept, [500, 500, 500], 'three waits for four calls');
  assert.equal(pacer.delayed, 3);
});

test('the declared rate REPLACES the constant rather than being merged with it', async () => {
  // 1 rps and 10 rps must not produce the same spacing. This is the assertion the
  // old code could not pass for ANY input: it read one constant unconditionally.
  const slow = fakeClock();
  const fast = fakeClock();

  const a = pacerForBrief({ rate_limit_rps: 1 }, { now: slow.now, sleep: slow.sleep });
  const b = pacerForBrief({ rate_limit_rps: 10 }, { now: fast.now, sleep: fast.sleep });

  for (let i = 0; i < 3; i++) {
    await a.awaitSlot();
    await b.awaitSlot();
  }
  assert.equal(a.minIntervalMs, 1000);
  assert.equal(b.minIntervalMs, 100);
  assert.deepEqual(slow.slept, [1000, 1000]);
  assert.deepEqual(fast.slept, [100, 100]);
});

test('a call that itself took longer than the interval is not double-penalised', async () => {
  // The difference between a RATE LIMIT and a sleep-per-call. If a call takes 700ms
  // at 2 rps, the next may start immediately; sleeping 500ms on top would halve the
  // achievable rate for no reason.
  const clock = fakeClock();
  const pacer = pacerFor(2, { now: clock.now, sleep: clock.sleep });

  await pacer.awaitSlot(); // first: free
  clock.advance(700); // the RPC call was slow
  await pacer.awaitSlot(); // inside the interval already
  assert.deepEqual(clock.slept, [], 'no wait is owed when the call already elapsed');
});

// ── 2. absent rate preserves today's behaviour ──────────────────────────────

test('an absent rate limit preserves the existing default of 3 rps', () => {
  assert.equal(RATE_LIMIT_RPS_DEFAULT, 3, 'the default must be the number that shipped');
  assert.equal(FLOW_SAMPLE.rateLimitRps, 3, 'and it must still agree with the desk constant');

  for (const absent of [undefined, null]) {
    const d = normalizeRateLimitRps(absent);
    assert.equal(d.rps, 3);
    assert.equal(d.source, 'default');
    assert.equal(d.requested, null);
  }

  // And the RoE built from a brief that says nothing is byte-identical to what the
  // hardcoded 3 produced before this change.
  assert.equal(roeFromBrief(brief(), NOW).rate_limit_rps, 3);
  assert.deepEqual(rateLimitForBrief({}), { rps: 3, requested: null, source: 'default', why: rateLimitForBrief({}).why });
});

test('a brief compiled without a rate carries NO rate_limit_rps key at all', () => {
  const r = compile('https://app.example.com', {
    program_id: 'example.com',
    authorization_ref: 'https://example.com/security permits automated testing',
    scope_hints: [],
  });
  assert.ok('brief' in r);
  assert.equal(
    'rate_limit_rps' in r.brief,
    false,
    'an undeclared rate must leave the key off, so a stored brief stays byte-identical',
  );
  // And the RoE still gets the default.
  assert.equal(roeFromBrief(r.brief, NOW).rate_limit_rps, 3);
});

test('a brief compiled WITH a rate carries it through to the RoE', () => {
  const r = compile(
    'https://app.example.com',
    {
      program_id: 'example.com',
      authorization_ref: 'https://example.com/security permits automated testing',
      scope_hints: [],
    },
    { rate_limit_rps: '5' },
  );
  assert.ok('brief' in r);
  assert.equal(r.brief.rate_limit_rps, 5, 'the operator answer reaches the brief');
  assert.equal(roeFromBrief(r.brief, NOW).rate_limit_rps, 5, 'and the brief reaches the RoE');
});

// ── 3. invalid values are clamped, never read as "unlimited" ────────────────

test('zero, negative, NaN and Infinity are NOT permission to go faster', () => {
  // The decision, asserted: an unusable rate falls back to the DEFAULT, not to
  // "unlimited". A rate limit that cannot be honoured must not silently become the
  // absence of one — that is exactly the class of bug this item closes.
  for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, 'abc', '', {}, []]) {
    const d = normalizeRateLimitRps(bad);
    assert.equal(d.rps, RATE_LIMIT_RPS_DEFAULT, `${String(bad)} must fall back to the default`);
    assert.equal(d.source, 'default');
    assert.notEqual(d.rps, Infinity);
    assert.ok(Number.isFinite(d.rps));
  }
});

test('an absurdly high rate is clamped DOWN to the defensible ceiling', () => {
  // FINITE but huge = "a rate was declared, it is unusable" -> clamp down.
  for (const huge of [21, 100, 1e6, Number.MAX_SAFE_INTEGER]) {
    const d = normalizeRateLimitRps(huge);
    assert.equal(d.rps, RATE_LIMIT_RPS_MAX, `${huge} must clamp to the ceiling, never be used`);
    assert.equal(d.source, 'clamped-down', 'the caller must be able to SEE it was clamped');
    assert.equal(d.requested, huge, 'and what was asked for');
  }

  // NON-FINITE is a different question, and it gets a different answer: Infinity
  // is not a large rate, it is not a rate at all, so it joins NaN in the
  // "no usable value" bucket and falls back to the default. The distinction is
  // worth pinning because both branches are safe but only one would survive a
  // future refactor that collapsed them.
  for (const notANumber of [Infinity, -Infinity, NaN]) {
    const d = normalizeRateLimitRps(notANumber);
    assert.equal(d.rps, RATE_LIMIT_RPS_DEFAULT, `${String(notANumber)} is not a rate`);
    assert.equal(d.source, 'default');
  }

  // Either way, the one outcome that must be impossible is "unlimited".
  for (const input of [1e9, Infinity, NaN, 0, -1]) {
    const rps = normalizeRateLimitRps(input).rps;
    assert.ok(Number.isFinite(rps) && rps <= RATE_LIMIT_RPS_MAX, `${String(input)} -> ${rps}`);
  }
});

test('a rate too slow to honour inside one invocation is clamped up to the floor', () => {
  for (const tiny of [0.5, 0.1, 0.05, 0.001]) {
    const d = normalizeRateLimitRps(tiny);
    assert.ok(d.rps >= RATE_LIMIT_RPS_MIN, `${tiny} must not be honoured as an unusable pace`);
  }
  const d = normalizeRateLimitRps(0.001);
  assert.equal(d.rps, RATE_LIMIT_RPS_MIN);
  assert.equal(d.source, 'clamped-up');
});

test('the accepted range is a real interval, and the ends are usable', () => {
  assert.ok(RATE_LIMIT_RPS_MIN > 0);
  assert.ok(RATE_LIMIT_RPS_MAX > RATE_LIMIT_RPS_MIN);
  // Documented upper bound is 20 rps: the free plan's 50-subrequest invocation is
  // spent in 2.5s at that rate, so anything above it is indistinguishable from
  // unpaced traffic in every path that could enforce it.
  assert.equal(RATE_LIMIT_RPS_MAX, 20);
  // At the floor, one call is still possible inside a Worker invocation.
  assert.ok(Math.ceil(1000 / RATE_LIMIT_RPS_MIN) <= 10_000);

  for (const rps of [RATE_LIMIT_RPS_MIN, 1, 3, 20, RATE_LIMIT_RPS_MAX]) {
    const d = normalizeRateLimitRps(rps);
    assert.equal(d.rps, rps, `${rps} is inside the range and must be used verbatim`);
    assert.equal(d.source, 'declared');
  }
});

test('roeFromBrief can never emit a rate outside the honour-able range', () => {
  // Normalisation happens at the single point where an RoE is built, so a reader
  // never has to handle 0 / NaN / undefined and never has an excuse to fall back to
  // a constant.
  for (const declared of [0, -5, 1e9, NaN]) {
    const rps = roeFromBrief(brief({ rate_limit_rps: declared }), NOW).rate_limit_rps;
    assert.ok(Number.isFinite(rps), `${String(declared)} produced a non-finite RoE rate`);
    assert.ok(rps >= RATE_LIMIT_RPS_MIN && rps <= RATE_LIMIT_RPS_MAX, `${String(declared)} -> ${rps}`);
  }
  assert.equal(roeFromBrief(brief({ rate_limit_rps: 7 }), NOW).rate_limit_rps, 7);
});

test('describeRate states the source, so nothing implies precision it does not have', () => {
  assert.match(describeRate(normalizeRateLimitRps(5)), /5 rps \(declared\)/);
  assert.match(describeRate(normalizeRateLimitRps(undefined)), /3 rps \(default\)/);
  assert.match(describeRate(normalizeRateLimitRps(1000)), /20 rps \(clamped-down\)/);
});

// ── 4. the outbound path that can honour it, actually does ──────────────────

/**
 * A flow provider over a stub RPC, driven far enough to make at least two RPC
 * calls. Cache is off and the budget is raised so the pacing is what is being
 * measured, not the budget ceiling.
 */
function recordingRpc() {
  const calls = [];
  return {
    calls,
    rpc: async (method) => {
      calls.push(method);
      // One signature so `getTransaction` is attempted; a transaction-shaped
      // result so the sample completes rather than returning null early.
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 'Sig1', blockTime: NOW, err: null }];
      }
      return {
        slot: 1,
        blockTime: NOW,
        meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
        transaction: { message: { accountKeys: [] } },
      };
    },
  };
}

function deskEnv() {
  const rows = [];
  return {
    rows,
    env: {
      DB: {
        prepare(sql) {
          const bound = () => ({
            async first() {
              return null;
            },
            async run() {
              rows.push(sql);
              return {};
            },
            async all() {
              return { results: [] };
            },
            bind() {
              return bound();
            },
          });
          return bound();
        },
      },
      DESK_FLOW_PROVIDER: 'on',
    },
  };
}

test('flowProviderFromRpc paces at the engagement rate when a caller passes one', async () => {
  const clock = fakeClock();
  const { rpc } = recordingRpc();
  const { env } = deskEnv();

  const flow = flowProviderFromRpc(env, {
    rpc,
    now: clock.now,
    sleep: clock.sleep,
    useCache: false,
    budgetPerTick: 10,
    rateLimitRps: 2, // <- the engagement's declared rate, as a caller would pass it
  });

  await flow('MintAAA', { pairAddress: 'PoolAAA', liqUsd: 500_000, priceUsd: 0.001, mcapUsd: 1e6 });

  // At 2 rps the interval is 500ms. Two RPC calls happened, so exactly one wait.
  assert.deepEqual(clock.slept, [500], 'the declared rate, not the constant, spaced the calls');
});

test('flowProviderFromRpc falls back to the desk default when no engagement rate is passed', async () => {
  const clock = fakeClock();
  const { rpc } = recordingRpc();
  const { env } = deskEnv();

  // No rateLimitRps: this is `liveSource()`, the desk trading tokens, which has no
  // engagement to take a rate from. 3 rps => 334ms.
  const flow = flowProviderFromRpc(env, {
    rpc,
    now: clock.now,
    sleep: clock.sleep,
    useCache: false,
    budgetPerTick: 10,
  });

  await flow('MintAAA', { pairAddress: 'PoolAAA', liqUsd: 500_000, priceUsd: 0.001, mcapUsd: 1e6 });

  assert.equal(clock.slept.length, 1, 'exactly one spacing wait for two calls');
  assert.equal(clock.slept[0], Math.ceil(1000 / 3), 'the shipped default interval, unchanged');
});

test('an unusable engagement rate on the flow path does not become unpaced traffic', async () => {
  const clock = fakeClock();
  const { rpc } = recordingRpc();
  const { env } = deskEnv();

  // 0 is the dangerous input: a naive `if (rate)` would skip pacing entirely and
  // fire every call back to back.
  const flow = flowProviderFromRpc(env, {
    rpc,
    now: clock.now,
    sleep: clock.sleep,
    useCache: false,
    budgetPerTick: 10,
    rateLimitRps: 0,
  });

  await flow('MintAAA', { pairAddress: 'PoolAAA', liqUsd: 500_000, priceUsd: 0.001, mcapUsd: 1e6 });

  assert.equal(clock.slept.length, 1, 'a zero rate must still pace, at the default');
  assert.equal(clock.slept[0], Math.ceil(1000 / 3));
});

test('the desk constant still exists, because callers and tests depend on it', () => {
  // The assignment forbids simply deleting it. It is now honestly labelled as the
  // DESK's default rather than a programme limit — see the doc comment pinned by
  // desk-data.test.mjs's value assertion and types.ts.
  assert.equal(typeof FLOW_SAMPLE.rateLimitRps, 'number');
  assert.equal(FLOW_SAMPLE.rateLimitRps, RATE_LIMIT_RPS_DEFAULT);
});

test('the fixture the operator approves shows the rate it will be held to', () => {
  // A limit only an operator can see after the fact is not a limit anyone agreed
  // to. The brief card is the approval surface, so the declared number appears
  // there — and only when one was declared, so nothing is invented.
  const declared = compile(
    'https://app.example.com',
    { program_id: 'ex', authorization_ref: 'policy permits automated testing', scope_hints: [] },
    { rate_limit_rps: '4' },
  );
  assert.ok('brief' in declared);
  assert.equal(declared.brief.rate_limit_rps, 4);
  assert.equal(roeFromBrief(declared.brief, NOW).rate_limit_rps, 4);
});
