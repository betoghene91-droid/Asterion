// THE DESK DATA LAYER — task 7.
//
// Three things are pinned here, and each one is a gate from the assignment
// rather than general coverage:
//
//   1. Every flow field the bounded RPC provider cannot establish is `null`, and
//      a null flow field still produces a coverage gap / kill instead of an entry.
//      A guessed number is a lie that passes wash trades, so "null stays null" is
//      the property that matters most in this file.
//   2. The honeypot probe returns a REAL simulated result object with the
//      signature recorded, and a sell-revert maps to a honeypot signal.
//   3. The MEV / failed-transaction haircut is applied with the named constant and
//      is labelled in /calib output.
//
// The RPC is stubbed in every test. No test here touches a socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FLOW_FIELDS_ALL,
  FLOW_FIELDS_ESTABLISHED,
  FLOW_SAMPLE,
  flowFromSample,
  swapLegsOf,
  median,
  readFlowCache,
  writeFlowCache,
} from '../build/desk/flow.js';
import {
  base64,
  buildTransferChecked,
  describeRevert,
  probeHoneypot,
  probeTargetFrom,
  sha256Sync,
} from '../build/desk/honeypot.js';
import { b58decode, b58encode, shortvec } from '../build/desk/base58.js';
import { snapshotMarks, measureFromMarks, recordMarks, markStats, MARKS } from '../build/desk/marks.js';
import { simulateFill, haircutFrom } from '../build/desk/paper.js';
import { buildCalibration } from '../build/desk/logger.js';
import { calibCard } from '../build/desk/cards.js';
import { evaluate } from '../build/desk/filter.js';
import { runSweep } from '../build/desk/pipeline.js';
import { registryKnownAccounts, registryStats, allRegistryEntries } from '../build/desk/registry.js';
import { EXECUTION_HAIRCUT } from '../build/desk/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');
const load = (n) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'desk', `${n}.json`), 'utf8'));

const GOOD = load('good');
const NOW = 1793300000000;

/** D1-compatible shim over node:sqlite, backed by the real schema. */
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
  return { raw, env: { DB: api, DESK_EQUITY_START_USD: '10000', ...extra } };
}

// ── flow: the honest-null property ───────────────────────────────────────

/**
 * One transaction in the verified `jsonParsed` shape: two token-account balance
 * rows for the same mint, one owner gaining and one losing.
 */
function swapTx(slot, buyer, seller, units, mint = 'MINTx') {
  return {
    slot,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint, owner: buyer, uiTokenAmount: { uiAmount: 0 } },
        { accountIndex: 2, mint, owner: seller, uiTokenAmount: { uiAmount: units } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint, owner: buyer, uiTokenAmount: { uiAmount: units } },
        { accountIndex: 2, mint, owner: seller, uiTokenAmount: { uiAmount: 0 } },
      ],
    },
  };
}

test('desk-data: the provider returns null for EVERY field a trade sample cannot establish', () => {
  const txs = [
    swapTx(100, 'buyerA', 'pool', 1000),
    swapTx(101, 'buyerB', 'pool', 2000),
    swapTx(102, 'buyerC', 'pool', 3000),
    swapTx(103, 'buyerD', 'pool', 4000),
  ];
  const m = flowFromSample(txs, 'MINTx', 0.001, { sampledAt: NOW, signatures: 4, failed: 0 });

  // The six it CAN establish are numbers.
  for (const f of FLOW_FIELDS_ESTABLISHED) {
    assert.notEqual(m[f], null, `${f} must be established from a sample`);
  }

  // Everything else is null, and the set of nulls is exactly the complement.
  const nulls = FLOW_FIELDS_ALL.filter((f) => m[f] === null);
  const expected = FLOW_FIELDS_ALL.filter(
    (f) => !FLOW_FIELDS_ESTABLISHED.includes(f),
  );
  assert.deepEqual(
    new Set(nulls),
    new Set(expected),
    'the null set must be exactly the fields the sample cannot establish',
  );

  // Named explicitly, because these are the ones a lazy implementation guesses.
  for (const f of ['bundledPct', 'sniper20Pct', 'devClusterPct', 'devPriorRug', 'smartWalletPct', 'atr14Pct']) {
    assert.equal(m[f], null, `${f} must stay null — a guessed value passes a wash trade`);
  }

  // And the provenance of the numbers it did produce is recorded.
  assert.equal(m.flowSample.parsed, 4);
  assert.equal(m.flowSample.usdBasis, 'mid');
  assert.equal(m.flowSample.fromSlot, 100);
  assert.equal(m.flowSample.toSlot, 103);
});

test('desk-data: a pool vault is excluded from both legs of the flow', () => {
  /*
   * A pool is the counterparty to every retail trade, so it nets to the OPPOSITE
   * side: on retail buys it sells, and on retail sells it buys. That pollutes two
   * different numbers, and neither is obvious in isolation:
   *
   *  - when retail SELLS, the pool nets positive, so it counts as a unique buyer
   *    with enormous buy volume - the shape that makes a thin token look like it has
   *    organic demand;
   *  - when retail BUYS, the pool appears as sell volume, inflating the sell side of
   *    the buy/sell ratio the analyst scores on.
   *
   * Both directions are asserted, because excluding one and not the other would
   * look implemented while leaving the other lie in place.
   */
  const known = new Set(['POOL_OWNER']);

  // Direction 1: retail buys, pool sells -> pool must not add phantom sell volume.
  const retailBuys = [swapTx(1, 'buyerA', 'POOL_OWNER', 1000), swapTx(2, 'buyerB', 'POOL_OWNER', 2000)];
  const pollutingSells = flowFromSample(retailBuys, 'MINTx', 0.001, { sampledAt: NOW, signatures: 2, failed: 0 });
  const cleanSells = flowFromSample(retailBuys, 'MINTx', 0.001, {
    sampledAt: NOW,
    signatures: 2,
    failed: 0,
    known,
  });
  assert.ok(pollutingSells.sellVolumeUsd > 0, 'unfiltered: the pool leg reads as sell volume');
  assert.equal(cleanSells.sellVolumeUsd, 0, 'excluding the pool must remove that phantom sell volume');
  assert.equal(cleanSells.buyVolumeUsd, pollutingSells.buyVolumeUsd, 'buy volume is unaffected here');

  // Direction 2: retail sells, pool buys -> pool must not become a unique buyer.
  const retailSells = [swapTx(3, 'POOL_OWNER', 'sellerA', 1000), swapTx(4, 'POOL_OWNER', 'sellerB', 2000)];
  const poolAsBuyer = flowFromSample(retailSells, 'MINTx', 0.001, { sampledAt: NOW, signatures: 2, failed: 0 });
  const cleanBuys = flowFromSample(retailSells, 'MINTx', 0.001, {
    sampledAt: NOW,
    signatures: 2,
    failed: 0,
    known,
  });
  assert.equal(poolAsBuyer.uniqueBuyers, 1, 'unfiltered: the pool counts as the only buyer');
  assert.equal(poolAsBuyer.buyVolumeUsd, 3, 'unfiltered: and its volume reads as demand');
  assert.equal(cleanBuys.uniqueBuyers, 0, 'excluding the pool leaves no genuine buyer');
  assert.equal(cleanBuys.buyVolumeUsd, 0, 'and no phantom demand');
  assert.equal(cleanBuys.medianBuyUsd, null, 'no genuine buys means unknown, not zero');
});

test('desk-data: a failed transaction contributes no swap legs', () => {
  const failed = swapTx(9, 'buyerA', 'pool', 1000);
  failed.meta.err = { InstructionError: [0, { Custom: 6001 }] };
  assert.deepEqual(swapLegsOf(failed, 'MINTx'), [], 'a reverted tx moved no tokens');

  // A buy and a sell inside one transaction nets to zero: neither is recorded.
  const roundTrip = {
    slot: 10,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: 'MINTx', owner: 'churn', uiTokenAmount: { uiAmount: 5 } }],
      postTokenBalances: [{ accountIndex: 1, mint: 'MINTx', owner: 'churn', uiTokenAmount: { uiAmount: 5 } }],
    },
  };
  assert.deepEqual(swapLegsOf(roundTrip, 'MINTx'), []);
});

test('desk-data: an empty sample is null, not a zero', () => {
  // Nothing parsed means we learned nothing. Returning zeros would make the
  // wash-trade ratio 0/0 and read as a clean token.
  const m = flowFromSample([], 'MINTx', 0.001, { sampledAt: NOW, signatures: 0, failed: 0 });
  assert.equal(m.medianBuyUsd, null, 'no buys means no median, not 0');
  assert.equal(m.uniqueBuyerGrowthPct, null, 'growth from zero buyers is undefined');
});

test('desk-data: median is the price value the gate reads, not the mean', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
  // One whale must not move the median the way it moves the mean.
  const buys = [10, 10, 10, 10, 10_000];
  assert.equal(median(buys), 10);
  assert.notEqual(buys.reduce((a, b) => a + b, 0) / buys.length, median(buys));
});

test('desk-data: a null flow field yields a coverage gap, never an entry', async () => {
  const e = makeEnv({ DESK_PRIO_FEE_USD: '0.0005' });
  const d = structuredClone(GOOD);
  // Strip exactly the fields the RPC provider cannot establish.
  for (const f of ['bundledPct', 'sniper20Pct', 'devClusterPct']) d.holders[f] = null;

  const r = evaluate(d, { sizeUsd: 400, known: d.knownAccounts, holders: d.holderList });
  assert.deepEqual(r.kills, [], 'a missing flow fact is not a kill');
  assert.equal(r.passed, false, 'and it is not a pass either');
  for (const name of ['bundled launch share', 'sniper cohort', 'deployer funding cluster']) {
    assert.ok(r.unknowns.includes(name), `the gap must be named: ${name}`);
  }

  // End to end: the pipeline records the gap and opens nothing.
  const src = {
    candidates: async () => [d.market],
    dossier: async () => d,
    async flow() {
      // What the real provider returns for these three fields.
      return { ...d.holders, bundledPct: null, sniper20Pct: null, devClusterPct: null };
    },
    async quote() {
      return { mint: d.market.mint, priceUsd: d.market.priceUsd, liqUsd: d.market.liqUsd, ts: NOW };
    },
  };
  const sweep = await runSweep(e.env, src, NOW);
  assert.equal(sweep.opened, 0, 'a null flow field must not lead to a position');
  assert.equal(sweep.coverage_gaps + sweep.killed, 1, 'the token is accounted for exactly once');

  const pos = e.raw.prepare('SELECT COUNT(*) AS n FROM desk_positions').get();
  assert.equal(pos.n, 0, 'no position row may exist');
});

test('desk-data: the flow cache is per mint and expires on its own TTL', async () => {
  const e = makeEnv();
  const m = flowFromSample([swapTx(1, 'a', 'pool', 10), swapTx(2, 'b', 'pool', 20)], 'MINTx', 0.5, {
    sampledAt: NOW,
    signatures: 2,
    failed: 0,
  });

  assert.equal(await readFlowCache(e.env, 'MINTx', NOW), null, 'nothing cached yet');

  await writeFlowCache(e.env, 'MINTx', m, NOW, 'pool');
  const hit = await readFlowCache(e.env, 'MINTx', NOW + 1000);
  assert.ok(hit, 'a fresh row must be served from cache');
  assert.equal(hit.uniqueBuyers, m.uniqueBuyers);
  assert.equal(hit.bundledPct, null, 'a cached null must come back null, not 0');

  // Inside the TTL it is free; past it the provider refetches.
  const inside = await readFlowCache(e.env, 'MINTx', NOW + (FLOW_SAMPLE.cacheTtlSeconds - 60) * 1000);
  assert.ok(inside, 'still inside the TTL');
  const past = await readFlowCache(e.env, 'MINTx', NOW + (FLOW_SAMPLE.cacheTtlSeconds + 60) * 1000);
  assert.equal(past, null, 'past the TTL it must be a miss so the provider refreshes');

  // The cached row records which fields stayed gaps.
  const row = e.raw.prepare('SELECT fields_null, source FROM desk_flow WHERE mint=?').get('MINTx');
  const nulls = JSON.parse(row.fields_null);
  assert.ok(nulls.includes('bundledPct'), 'fields_null must record the gap explicitly');
  assert.equal(row.source, 'rpc-sample');
});

test('desk-data: the sample bound is a named constant and is small on purpose', () => {
  // The bound is the honest part of the answer: a 40-transaction sample of a pool
  // with thousands is a sample, and the numbers derived from it say so.
  assert.equal(typeof FLOW_SAMPLE.maxSignatures, 'number');
  assert.ok(FLOW_SAMPLE.maxSignatures > 0 && FLOW_SAMPLE.maxSignatures <= 100);
  assert.ok(FLOW_SAMPLE.maxTransactions <= FLOW_SAMPLE.maxSignatures);
  assert.ok(FLOW_SAMPLE.budgetPerTick <= FLOW_SAMPLE.maxTransactions);
  assert.equal(FLOW_SAMPLE.rateLimitRps, 3, 'the RoE carries rate_limit_rps: 3');
});

// ── the honeypot probe ───────────────────────────────────────────────────

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const ACCT_A = '6G4XDSge4txj5tBkA5gZqefXXE3BRxqA37Yb1pmrHv6N';
const OWNER_A = 'EXJHiMkj6NRFDfhWBMKccHNwdSpCT7tdvQeRf87yHm6T';
const ACCT_B = '26ddLrqXDext6caX1gRxARePN4kzajyGiAUz9JmzmTGQ';
const OWNER_B = '61aq585V8cR2sZBeawJFt2NPqmN7zDi1sws4KLs5xHXV';

const HOLDERS = [
  { address: ACCT_A, owner: OWNER_A, pct: 24.7 },
  { address: ACCT_B, owner: OWNER_B, pct: 24.5 },
];

const MARKET = {
  mint: MINT,
  symbol: 'JUP',
  priceUsd: 0.256,
  liqUsd: 400_000,
  mcapUsd: 900_000,
  pairAddress: 'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz',
  dexId: 'orca',
  pairCreatedAtMs: NOW - 86400_000,
  vol1hUsd: 100_000,
  vol24hUsd: 1_000_000,
  price6hLowUsd: 0.2,
  price24hLowUsd: 0.2,
  feeBps: 30,
};

/** A stub RPC that records what it was asked and returns a canned value. */
function stubRpc(value) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (typeof value === 'function') return value(method, params);
    return value;
  };
  return { rpc, calls };
}

test('desk-data: base58, shortvec and the wire layout are exact', () => {
  // Round-trip, including leading-zero handling.
  for (const k of [MINT, ACCT_A, OWNER_A, '11111111111111111111111111111111']) {
    assert.equal(b58encode(b58decode(k)), k, `${k} must round-trip`);
  }
  assert.equal(b58decode(MINT).length, 32, 'a public key is 32 bytes');
  assert.deepEqual([...shortvec(0)], [0]);
  assert.deepEqual([...shortvec(5)], [5]);
  // 128 needs two bytes: high bit set on the first.
  assert.deepEqual([...shortvec(128)], [0x80, 0x01]);

  // The message must carry the blockhash and the account-count shortvec; omitting
  // either is a deserialize failure, verified against live RPC.
  const target = probeTargetFrom(HOLDERS, 6, MINT);
  const built = buildTransferChecked(target, 1n);
  assert.equal(built.bytes[0], 1, 'one signature slot');
  const msg = built.bytes.subarray(1 + 64);
  assert.equal(msg[0], 1, 'header: 1 required signer');
  assert.equal(msg[3], 5, 'shortvec account count = 5');
  // 3 header + 1 count + 5*32 keys + 32 blockhash, then instructions.
  const ixAt = 3 + 1 + 5 * 32 + 32;
  assert.equal(msg[ixAt], 1, 'one instruction');
  assert.equal(msg.length, ixAt + 1 + 1 + 1 + 4 + 1 + 10, 'exact message length');
  assert.equal(built.data[0], 12, 'TransferChecked tag');
  assert.equal(built.signature.length > 0, true, 'the signature field is populated');
});

test('desk-data: sha256 and base64 match known vectors', () => {
  // Known-answer test: these are fixed values, so a broken implementation fails
  // here rather than silently producing a payload hash that means nothing.
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  assert.equal(hex(sha256Sync(new TextEncoder().encode(''))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256Sync(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(base64(new TextEncoder().encode('abc')), 'YWJj');
});

test('desk-data: the probe returns a REAL simulated result with the signature recorded', async () => {
  const { rpc, calls } = stubRpc({ err: null, logs: ['Program Tokenkeg... success'], unitsConsumed: 105 });

  const res = await probeHoneypot(makeEnv().env, MINT, MARKET, {
    rpc,
    sizeUsd: 400,
    holders: HOLDERS,
    decimals: 6,
  });

  assert.ok(res, 'a probe with two usable accounts must return a result');
  assert.equal(res.ok, true, 'err:null means the transfer path is open');
  assert.equal(res.simulated, true, 'this came from simulateTransaction');
  assert.equal(res.modelled, false, 'the revert half is no longer modelled');

  // The assignment's requirement: the signature of each simulation is recorded.
  assert.equal(Array.isArray(res.simulations), true);
  assert.equal(res.simulations.length, 1);
  const rec = res.simulations[0];
  assert.equal(typeof rec.signature, 'string');
  assert.ok(rec.signature.length >= 80, `expected a base58 signature, got ${rec.signature}`);
  assert.match(rec.payloadSha256, /^[0-9a-f]{64}$/, 'the payload digest is a sha256 hex');
  assert.equal(rec.err, null);
  assert.equal(rec.unitsConsumed, 105);
  assert.equal(rec.leg, 'exit');

  // And it really was a simulateTransaction, unsigned and free.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'simulateTransaction');
  const [, opts] = calls[0].params;
  assert.equal(opts.sigVerify, false, 'nothing is signed');
  assert.equal(opts.replaceRecentBlockhash, true);
  assert.equal(opts.encoding, 'base64');

  // The impact half is still pool depth, and is labelled as such.
  assert.ok(res.priceImpactPct > 0);
});

test('desk-data: a reverting sell maps to a honeypot signal, with the reason', async () => {
  // The exact error a frozen account produces: TokenError 17 = AccountFrozen.
  const { rpc } = stubRpc({
    err: { InstructionError: [0, { Custom: 17 }] },
    logs: ['Program log: Error: Account is frozen', 'Program ... failed: custom program error: 0x11'],
    unitsConsumed: 180,
  });

  const res = await probeHoneypot(makeEnv().env, MINT, MARKET, {
    rpc,
    sizeUsd: 400,
    holders: HOLDERS,
    decimals: 6,
  });

  assert.ok(res);
  assert.equal(res.ok, false, 'a revert must not report ok');
  assert.equal(res.simulated, true);
  assert.equal(res.revertLeg, 'exit');
  assert.match(res.revertReason, /AccountFrozen/, 'the reason must name the token error');
  assert.match(res.revertReason, /17/);

  // And the filter turns that into the honeypot kill, not a coverage gap.
  const d = structuredClone(GOOD);
  d.sell = res;
  const r = evaluate(d, { sizeUsd: 400, known: d.knownAccounts, holders: d.holderList });
  assert.equal(r.primary, 'honeypot_sell_reverts');
});

test('desk-data: an owner mismatch is described, not swallowed', async () => {
  // Verified live: this is exactly what a wrong authority returns.
  const { rpc } = stubRpc({
    err: { InstructionError: [0, { Custom: 4 }] },
    logs: ['Program log: Error: owner does not match'],
    unitsConsumed: 227,
  });
  const res = await probeHoneypot(makeEnv().env, MINT, MARKET, {
    rpc,
    sizeUsd: 400,
    holders: HOLDERS,
    decimals: 6,
  });
  assert.equal(res.ok, false);
  assert.match(res.revertReason, /OwnerMismatch/);
});

test('desk-data: describeRevert never invents a reason', () => {
  assert.equal(describeRevert(null, []), 'simulation reverted (no reason in logs)');
  assert.match(describeRevert({ InstructionError: [0, { Custom: 999 }] }, []), /Custom: 999/);
  // A string instruction error passes through.
  assert.equal(describeRevert({ InstructionError: [1, 'NotEnoughAccountKeys'] }, []), 'NotEnoughAccountKeys');
});

test('desk-data: a probe that cannot be built is null, never a fabricated pass', async () => {
  // Only one usable token account: no transfer can be constructed. Returning
  // ok:true here would claim "not a honeypot" from no evidence at all.
  const { rpc, calls } = stubRpc({ err: null, logs: [], unitsConsumed: 1 });
  const res = await probeHoneypot(makeEnv().env, MINT, MARKET, {
    rpc,
    sizeUsd: 400,
    holders: [{ address: ACCT_A, owner: OWNER_A, pct: 10 }],
    decimals: 6,
  });
  assert.equal(res, null);
  assert.equal(calls.length, 0, 'no RPC call should be made for an unbuildable probe');

  // And an RPC failure is null too, not a pass.
  const failing = async () => {
    throw new Error('rpc down');
  };
  const res2 = await probeHoneypot(makeEnv().env, MINT, MARKET, {
    rpc: failing,
    sizeUsd: 400,
    holders: HOLDERS,
    decimals: 6,
  });
  assert.equal(res2, null);
});

// ── the execution haircut ────────────────────────────────────────────────

test('desk-data: the MEV haircut is charged with the named constant', () => {
  const notional = 10_000;
  const base = {
    side: 'buy',
    notionalUsd: notional,
    priceUsd: 0.001,
    liqUsd: 100_000_000, // deep, so impact is negligible and the haircut is isolated
    feeBps: 0,
    priorityFeeUsd: 0,
    priorityFeeCapUsd: 1,
  };

  const withHaircut = simulateFill(base);
  const without = simulateFill({ ...base, mevBps: 0, failedTxBps: 0 });

  // The named constant is what was applied.
  assert.equal(withHaircut.haircutBps, EXECUTION_HAIRCUT.mevBps + EXECUTION_HAIRCUT.failedTxBps);
  assert.equal(withHaircut.haircutBps, EXECUTION_HAIRCUT.totalBps);
  assert.equal(withHaircut.mevUsd, notional * (EXECUTION_HAIRCUT.mevBps / 10_000));
  assert.equal(withHaircut.failedTxUsd, notional * (EXECUTION_HAIRCUT.failedTxBps / 10_000));

  // And it makes the fill strictly worse than the no-haircut control.
  assert.ok(withHaircut.qty < without.qty, 'the haircut must reduce tokens received');
  assert.equal(without.mevUsd, 0, 'the control charges nothing');

  // Both legs pay it: a sandwich costs us buying and selling.
  const sell = simulateFill({ ...base, side: 'sell' });
  assert.equal(sell.mevUsd, withHaircut.mevUsd);
  assert.ok(sell.haircutBps > 0);
});

test('desk-data: the haircut is configurable and reports its source', () => {
  const constant = haircutFrom({});
  assert.equal(constant.mevBps, EXECUTION_HAIRCUT.mevBps);
  assert.equal(constant.source, 'constant');

  const env = haircutFrom({ DESK_MEV_HAIRCUT_BPS: '25', DESK_FAILED_TX_BPS: '15' });
  assert.equal(env.mevBps, 25);
  assert.equal(env.totalBps, 40);
  assert.equal(env.source, 'env');

  // A nonsense override falls back to the constant rather than to zero: a typo
  // must not silently remove the haircut.
  const bad = haircutFrom({ DESK_MEV_HAIRCUT_BPS: 'not-a-number' });
  assert.equal(bad.mevBps, EXECUTION_HAIRCUT.mevBps);
});

test('desk-data: /calib labels the haircut with its constant and what it charged', async () => {
  const e = makeEnv();
  // One recorded fill cost so "charged so far" is a real number.
  e.raw
    .prepare(
      `INSERT INTO desk_fill_costs (id,position_id,mint,ts,side,notional_usd,mev_bps,failed_tx_bps,mev_usd,failed_tx_usd,haircut_total_usd)
       VALUES ('c1','p1','MINTx',?, 'buy', 1000, 60, 40, 6, 4, 10)`,
    )
    .run(Math.floor(NOW / 1000));

  const report = await buildCalibration(e.env, NOW);
  assert.ok(report.haircut, 'the report must carry the haircut block');
  assert.equal(report.haircut.mev_bps, EXECUTION_HAIRCUT.mevBps);
  assert.equal(report.haircut.failed_tx_bps, EXECUTION_HAIRCUT.failedTxBps);
  assert.equal(report.haircut.total_bps, EXECUTION_HAIRCUT.totalBps);
  assert.equal(report.haircut.charged_usd, 10);
  assert.equal(report.haircut.fills, 1);

  // The rendered card an operator actually reads names it.
  const card = await calibCard(e.env, NOW);
  assert.match(card, /Execution haircut/, '/calib must label the haircut');
  assert.match(card, new RegExp(`${EXECUTION_HAIRCUT.mevBps}bps`), 'the MEV constant must be printed');
  assert.match(card, new RegExp(`${EXECUTION_HAIRCUT.failedTxBps}bps`), 'the failed-tx constant must be printed');
  assert.match(card, /EXECUTION_HAIRCUT constant/, 'and where the number came from');
  assert.match(card, /\$10\.00/, 'and what it has actually charged');
});

test('desk-data: the haircut reduces paper PnL, so the record is not optimistic', async () => {
  const { openPosition } = await import('../build/desk/executor.js');
  const run = async (extra) => {
    const e = makeEnv({ DESK_PRIO_FEE_USD: '0', DESK_PRIO_FEE_CAP_USD: '0', ...extra });
    const r = await openPosition(e.env, {
      mint: 'MINTdeep',
      symbol: 'DEEP',
      quote: { mint: 'MINTdeep', priceUsd: 1, liqUsd: 100_000_000, ts: NOW },
      priceHistory: { atr14Pct: null },
      now: NOW,
    });
    assert.equal(r.opened, true);
    return { qty: r.fill.qty, costs: e.raw.prepare('SELECT * FROM desk_fill_costs').all() };
  };

  const charged = await run({});
  const free = await run({ DESK_MEV_HAIRCUT_BPS: '0', DESK_FAILED_TX_BPS: '0' });

  assert.ok(charged.qty < free.qty, 'a paper fill must receive fewer tokens when the haircut applies');
  assert.equal(charged.costs.length, 1, 'the charge must be recorded, not just applied');
  assert.ok(charged.costs[0].haircut_total_usd > 0);
  assert.equal(free.costs[0].haircut_total_usd, 0, 'the zero-haircut control records zero');
});

// ── forward price marks ──────────────────────────────────────────────────

test('desk-data: snapshotMarks refuses a missing price instead of writing a zero', () => {
  // A zero price would make the series claim a -100% move that never happened.
  const marks = snapshotMarks(
    [
      { mint: 'A', priceUsd: 1.5, liqUsd: 1000, mcapUsd: 5000 },
      { mint: 'B', priceUsd: 0, liqUsd: 1000, mcapUsd: 5000 },
      { mint: 'C', priceUsd: Number.NaN, liqUsd: 1, mcapUsd: 1 },
      { mint: 'A', priceUsd: 1.6, liqUsd: 1000, mcapUsd: 5000 }, // duplicate
    ],
    NOW,
  );
  assert.deepEqual(marks.map((m) => m.mint), ['A'], 'only the positive, first-seen price is marked');
  assert.equal(marks[0].priceUsd, 1.5);
  assert.equal(marks[0].source, 'dexscreener');
});

test('desk-data: measureFromMarks needs a real window before it claims an outcome', () => {
  const hours = 3600;
  const base = Math.floor(NOW / 1000);

  // Too few marks.
  assert.equal(measureFromMarks([{ mint: 'A', ts: base - 10 * hours, priceUsd: 1 }], base, NOW), null);

  // Two marks seconds apart: the "high" and "low" are the same tick.
  const thin = [
    { mint: 'A', ts: base - 40 * hours, priceUsd: 1 },
    { mint: 'A', ts: base - 40 * hours + 30, priceUsd: 1.1 },
  ];
  assert.equal(measureFromMarks(thin, base - 50 * hours, NOW), null, 'a 30s window is not a series');

  // A real series: the FORWARD window must itself span minWindowSeconds, so the
  // marks are spread over 8h after the kill rather than clustered inside 2h.
  const since = base - 30 * hours;
  const dense = [
    { mint: 'A', ts: since - 60, priceUsd: 1.0 },
    { mint: 'A', ts: since + 7 * hours, priceUsd: 2.0 },
    { mint: 'A', ts: since + 11 * hours, priceUsd: 3.2 },
    { mint: 'A', ts: since + 15 * hours, priceUsd: 2.8 },
  ];
  const m = measureFromMarks(dense, since, NOW);
  assert.ok(m, 'a dense-enough series must produce a measurement');
  assert.equal(m.baseUsd, 1.0, 'the base is the last mark BEFORE the kill');
  assert.equal(m.baseFrom, 'before');
  assert.equal(m.highUsd, 3.2);
  /*
   * `lowUsd` is the low of the FORWARD window, which is 2.0 here - not the
   * pre-kill 1.0. That distinction is the whole reason `baseUsd` exists, and
   * `markHistory` had the bug of using this forward low as the base.
   */
  assert.equal(m.lowUsd, 2.0, 'the forward low excludes the pre-kill mark');
  assert.equal(m.lastUsd, 2.8);
  assert.ok(m.highUsd / m.baseUsd >= 3, 'measured from the true base this is a 3.2x run');

  /*
   * Too soon after the kill to judge: MARKS.minDistanceSeconds is measured from
   * the supplied timestamp to NOW, so a kill 5h ago is refused while a kill 25h ago
   * is judged. (A window starting 25h ago has a full 8h of forward marks, which is
   * why that case must NOT be null - an earlier draft of this test asserted the
   * opposite and was simply testing the wrong boundary.)
   */
  assert.equal(
    measureFromMarks(dense, base - 5 * hours, NOW),
    null,
    'a kill 5h ago is inside minDistanceSeconds and must not be judged yet',
  );
  assert.ok(
    measureFromMarks(dense, base - 25 * hours, NOW),
    'a kill 25h ago has both the distance and the window, so it is judged',
  );
});

test('desk-data: an outcome is measured from the true base, not the forward low', async () => {
  /*
   * Regression test for a real bug found while writing this suite.
   *
   * `logger.measureOutcomes` used to derive the base as `hist.lowUsd`. For a
   * `desk_marks` series that is the low of the FORWARD window, so a token that ran
   * from 1.0 to 3.2 was scored as 3.2/2.0 = 1.6x and filed as a DODGE instead of a
   * false negative. Every kill reason would have looked better than it was, which is
   * the exact failure the calibration report exists to prevent.
   *
   * This drives the real logger against the real marks table so the whole path is
   * covered, not just the pure function.
   */
  const e = makeEnv();
  const { recordKill, measureOutcomes } = await import('../build/desk/logger.js');
  const { withMarkHistory } = await import('../build/desk/marks.js');
  const base = Math.floor(NOW / 1000);
  const since = base - 30 * 3600;

  // A kill recorded 30h ago.
  await recordKill(e.env, {
    mint: 'MINTrun',
    symbol: 'RUN',
    reason: 'top10_concentrated',
    detail: 'test',
    snapshot: {},
    now: since * 1000,
  });

  // A series that ran 3.2x from 1.0, with the forward low at 2.0.
  await recordMarks(e.env, [
    { mint: 'MINTrun', ts: since - 60, priceUsd: 1.0, liqUsd: 1, mcapUsd: 1, source: 'dexscreener' },
    { mint: 'MINTrun', ts: since + 7 * 3600, priceUsd: 2.0, liqUsd: 1, mcapUsd: 1, source: 'dexscreener' },
    { mint: 'MINTrun', ts: since + 11 * 3600, priceUsd: 3.2, liqUsd: 1, mcapUsd: 1, source: 'dexscreener' },
    { mint: 'MINTrun', ts: since + 15 * 3600, priceUsd: 2.8, liqUsd: 1, mcapUsd: 1, source: 'dexscreener' },
  ]);

  const source = withMarkHistory(e.env, { candidates: async () => [], dossier: async () => ({}), quote: async () => ({}) });
  const res = await measureOutcomes(e.env, source, NOW);
  assert.equal(res.measured, 1, 'the kill must be measured from our own marks');

  const row = e.raw.prepare("SELECT outcome FROM desk_kills WHERE mint='MINTrun'").get();
  assert.equal(row.outcome, 'missed_3x', 'a 3.2x run is a false negative, not a dodge');
});

test('desk-data: marks are stored, counted and dense-mint is reported honestly', async () => {
  const e = makeEnv();
  const base = Math.floor(NOW / 1000);
  await recordMarks(e.env, [
    { mint: 'A', ts: base - 10 * 3600, priceUsd: 1, liqUsd: 1, mcapUsd: 1, source: 'dexscreener' },
    { mint: 'A', ts: base - 2 * 3600, priceUsd: 1.2, liqUsd: 1, mcapUsd: 1, source: 'dexscreener' },
    { mint: 'B', ts: base - 60, priceUsd: 5, liqUsd: 1, mcapUsd: 1, source: 'dexscreener' },
  ]);

  const stats = await markStats(e.env);
  assert.equal(stats.marks, 3);
  assert.equal(stats.mints, 2);
  assert.equal(stats.dense_mints, 1, 'only A has both enough marks and a long enough span');
  assert.ok(stats.span_hours > 0);
  assert.equal(MARKS.minMarks, 2);
  assert.equal(MARKS.minWindowSeconds, 6 * 3600);
});

// ── D1 rows_written: the marks write cadence ─────────────────────────
//
// The account hit 76% of the 100,000/day D1 free tier by 08:15 and was told D1
// would start returning ERRORS. `snapshotUniverseMarks` was the cause: up to 200
// mark rows per `*/5` cron tick, 288 ticks a day, 57,600 rows/day on its own.
// A mark row per mint per five minutes is not evidence any consumer can use -
// `measureFromMarks` needs `minMarks` samples across a 6h window.

test('desk-data: the marks snapshot honours a write cadence instead of writing every tick', async () => {
  const e = makeEnv();
  const base = Math.floor(NOW / 1000);
  const { snapshotUniverseMarks } = await import('../build/desk/marks.js');

  // A source that reports the same two mints every time it is asked.
  const source = {
    candidates: async () => [],
    dossier: async () => ({}),
    quote: async () => ({}),
  };
  // `withMarkHistory` decorates the source with a universe read; simpler to seed
  // desk_universe directly, which is what snapshotUniverseMarks reads.
  // desk_universe is what snapshotUniverseMarks reads. Only the NOT NULL columns
  // that have no default are supplied.
  e.raw.prepare(
    `INSERT INTO desk_universe (mint,symbol,state,pair_created_at,first_seen,last_seen,price_usd,liq_usd,mcap_usd)
     VALUES ('M1','ONE','passed',?,?,?,1,1,1), ('M2','TWO','passed',?,?,?,1,1,1)`,
  ).run(base, base, base, base, base, base);

  const first = await snapshotUniverseMarks(e.env, NOW, 200, 3600);
  assert.equal(first.written, 2, 'the first tick writes both mints');

  // Five minutes later: same mints, well inside the one-hour gap. Nothing written.
  const second = await snapshotUniverseMarks(e.env, NOW + 5 * 60 * 1000, 200, 3600);
  assert.equal(second.written, 0, 'a five-minute-old mark must not be rewritten');
  assert.equal(second.considered, 0);

  // An hour and a minute later: the gap has elapsed, so both are sampled again.
  const third = await snapshotUniverseMarks(e.env, NOW + 61 * 60 * 1000, 200, 3600);
  assert.equal(third.written, 2, 'an elapsed gap must still produce a sample');

  // The series stayed usable: two marks per mint across a one-hour span.
  const stats = await markStats(e.env);
  assert.equal(stats.mints, 2);
  assert.equal(stats.marks, 4);

  // And the default (no cadence) still writes every call - existing behaviour.
  const fourth = await snapshotUniverseMarks(e.env, NOW + 62 * 60 * 1000);
  assert.equal(fourth.written, 2, 'minGapSeconds=0 keeps the old per-call behaviour');
});

// ── the registry ─────────────────────────────────────────────────────────

test('desk-data: every registry entry is cited, and only listed entries are excluded', () => {
  // A wrong entry is the UNSAFE direction: excluding a real whale makes the
  // concentration gate more permissive. So every row must be traceable.
  for (const entry of allRegistryEntries()) {
    assert.ok(entry.address && entry.address.length > 0, `${entry.label} needs an address`);
    assert.ok(entry.label && entry.label.length > 0, `${entry.address} needs a label`);
    assert.ok(entry.source && entry.source.length > 0, `${entry.address} needs a cited source`);
    assert.ok(['listed', 'reported'].includes(entry.confidence), 'confidence must be one of the two');
    assert.ok(['cex', 'market-maker', 'custody', 'bridge', 'burn'].includes(entry.kind));
  }

  // No duplicate addresses across the lists.
  const addrs = allRegistryEntries().map((e) => e.address);
  assert.equal(new Set(addrs).size, addrs.length, 'no address may appear twice');

  const strict = registryStats({ includeReported: false });
  const loose = registryStats({ includeReported: true });
  assert.ok(loose.excluded >= strict.excluded, 'promoting reported entries can only add exclusions');
  /*
   * `reported_held_back` is allowed to be ZERO, and today it is: every entry this
   * repo can cite is `listed`. Asserting it is non-zero would create pressure to
   * invent a `reported` entry just to satisfy a test, which is the opposite of the
   * property this file protects. What is asserted instead is that the counter is
   * CONSISTENT with the data, and that promotion moves it by exactly one each.
   */
  const reportedCount = allRegistryEntries().filter((e) => e.confidence === 'reported').length;
  assert.equal(strict.reported_held_back, reportedCount);
  assert.equal(loose.excluded - strict.excluded, reportedCount, 'each reported entry is one extra exclusion');

  // The four pre-existing repo addresses are preserved, so this refactor does not
  // silently stop excluding something it used to exclude.
  const known = registryKnownAccounts();
  for (const a of [
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
    'GJRs4FwHpreB9JHdSgZaHWNKhxwcvMtVLGvzrTFNBT4Z',
    'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
  ]) {
    assert.ok(known.cex.includes(a), `${a} must still be excluded`);
  }
});

// ── the standing invariants (must not change) ────────────────────────────

test('desk-data: paper stays the default, submitLive still throws, breaker has no override', async () => {
  const { submitLive } = await import('../build/desk/executor.js');
  const arming = await import('../build/desk/arming.js');

  await assert.rejects(() => submitLive(makeEnv().env), /live_signer_not_wired/);

  // No reset/unhalt export may ever appear.
  for (const banned of ['resetBreaker', 'clearBreaker', 'unhalt', 'armLive', 'setLive']) {
    assert.equal(typeof arming[banned], 'undefined', `${banned} must not exist`);
  }
});

test('desk-data: the four risk numbers are unchanged by this work', async () => {
  const { SIZING, BREAKER, FILTER } = await import('../build/desk/types.js');
  assert.equal(SIZING.maxPositionPctOfEquity, 0.08);
  assert.equal(SIZING.maxConcurrentPositions, 3);
  assert.equal(SIZING.maxDeployedPct, 0.24);
  assert.equal(SIZING.maxPoolSharePct, 0.01);
  assert.equal(BREAKER.lossPct, 0.08);
  assert.equal(BREAKER.haltSeconds, 24 * 3600);
  assert.equal(FILTER.maxHoneypotImpactPct, 15);

  // The refusal code stays a code, not a guideline.
  const reasons = await import('../build/desk/reasons.js');
  assert.match(reasons.REFUSAL_TEXT.never_average_down, /never average down/);
});

test('desk-data: no desk module gained a signing path', () => {
  const files = [
    'base58.ts', 'flow.ts', 'honeypot.ts', 'marks.ts', 'registry.ts',
    'source.ts', 'paper.ts', 'pipeline.ts', 'executor.ts', 'logger.ts', 'cards.ts',
  ];
  for (const f of files) {
    const src = readFileSync(join(HERE, '..', 'src', 'desk', f), 'utf8');
    assert.ok(
      !/sendTransaction|signTransaction|Keypair\.fromSecretKey|bs58\.decode/.test(src),
      `${f} must not contain transaction signing`,
    );
    /*
     * `simulateTransaction` is allowed and is the whole point of honeypot.ts;
     * broadcasting is not. Match actual CALLS rather than the word in a doc comment,
     * because a prose mention of "broadcast" is exactly how a real signing path
     * would hide from a naive grep.
     */
    assert.ok(
      !/sendRawTransaction\s*\(|sendTransaction\s*\(|\bsignTransaction\s*\(/.test(src),
      `${f} must not broadcast or sign`,
    );
  }
});
