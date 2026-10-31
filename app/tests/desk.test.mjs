// THE DESK — the seven required cases, driven against the REAL schema in
// in-memory SQLite, in the same style as tests/dispatch.test.mjs.
//
// Fixtures live in tests/fixtures/desk/*.json and are recorded-shape dossiers
// (DexScreener market block + RugCheck safety/holders block). No test in this
// file touches the network: the source is injected.
//
// The point of these tests is not coverage. It is that each one fails if a
// specific rule is reverted, so the rules are load-bearing rather than
// decorative.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate } from '../build/desk/filter.js';
import { analyze } from '../build/desk/analyst.js';
import { scout } from '../build/desk/scout.js';
import { concentration } from '../build/desk/holders.js';
import { simulateFill } from '../build/desk/paper.js';
import { armState, tripBreaker, breakerActive, requestMode } from '../build/desk/arming.js';
import { decideSize, openPosition, submitLive } from '../build/desk/executor.js';
import { assess } from '../build/desk/risk.js';
import { runSweep, runRiskTick, deskStatus } from '../build/desk/pipeline.js';
import { db } from '../build/desk/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

const load = (n) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'desk', `${n}.json`), 'utf8'));

const HONEYPOT = load('honeypot');
const GOOD = load('good');
const WASH = load('wash');

/** Fixed clock: every fixture is authored against this epoch. */
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

  return {
    raw,
    env: {
      DB: api,
      DESK_EQUITY_START_USD: '10000',
      ...extra,
    },
  };
}

/** A source that serves the three fixtures and nothing else. */
function fixtureSource(quotes = {}) {
  const bySymbol = { HPOT: HONEYPOT, GOOD, WASH };
  const byMint = {};
  for (const d of Object.values(bySymbol)) byMint[d.market.mint] = d;
  return {
    byMint,
    async candidates() {
      return Object.values(byMint).map((d) => d.market);
    },
    async dossier(mint) {
      const d = byMint[mint];
      if (!d) throw new Error('no fixture ' + mint);
      return d;
    },
    // The fixtures carry flow metrics recorded with the dossier, so the source
    // hands them over. In production these come from an optional FlowProvider
    // and are null without one — which is why the coverage-gap test below drives
    // the filter directly with them stripped out.
    async flow(mint) {
      const d = byMint[mint];
      if (!d) return null;
      const h = d.holders;
      return {
        uniqueBuyers: h.uniqueBuyers,
        totalBuys: h.totalBuys,
        bundledPct: h.bundledPct,
        sniper20Pct: h.sniper20Pct,
        devClusterPct: h.devClusterPct,
        devPriorRug: h.devPriorRug,
        buyVolumeUsd: h.buyVolumeUsd,
        sellVolumeUsd: h.sellVolumeUsd,
        avgBuyUsd: h.avgBuyUsd,
        medianBuyUsd: h.medianBuyUsd,
        uniqueBuyerGrowthPct: h.uniqueBuyerGrowthPct,
        smartWalletPct: h.smartWalletPct,
        atr14Pct: h.atr14Pct,
      };
    },
    async quote(mint) {
      // A quote the test did not override means "no new information": the
      // position is marked at its own entry.
      if (quotes[mint]) return { mint, ts: NOW, liqUsd: byMint[mint].market.liqUsd, ...quotes[mint] };
      const d = byMint[mint];
      return { mint, priceUsd: d.market.priceUsd, liqUsd: d.market.liqUsd, ts: NOW };
    },
  };
}

const noFeeEnv = (extra = {}) => makeEnv({ DESK_PRIO_FEE_USD: '0.0005', ...extra });

// ── CASE 1: honeypot rejected ───────────────────────────────────────────────

test('desk: a honeypot token is rejected on the freeze-authority gate', () => {
  const r = evaluate(HONEYPOT, { sizeUsd: 400, known: HONEYPOT.knownAccounts, holders: HONEYPOT.holderList });
  assert.equal(r.passed, false, 'a live freeze authority must never pass');
  assert.equal(r.primary, 'freeze_authority_live', `expected freeze_authority_live, got ${r.primary}`);
  // The rest of the token is deliberately healthy, so nothing else should be
  // firing: if another gate fires, this test would pass for the wrong reason.
  assert.deepEqual(
    r.kills.map((k) => k.reason),
    ['freeze_authority_live'],
    'the honeypot fixture must fail ONLY on freeze authority',
  );
});

test('desk: unknown freeze authority is a kill, not a pass', () => {
  const d = structuredClone(HONEYPOT);
  d.safety.freezeAuthorityRevoked = null;
  const r = evaluate(d, { sizeUsd: 400, known: d.knownAccounts, holders: d.holderList });
  assert.equal(r.passed, false);
  assert.equal(r.primary, 'freeze_authority_live');
  assert.match(r.kills[0].detail, /unreadable/);
});

// ── CASE 2: the exclusion is load-bearing ───────────────────────────────────

test('desk: raw top-10 would kill the good token, the pool/burn/CEX exclusion saves it', () => {
  // First: prove the fixture is hostile to the naive metric.
  const naive = concentration(GOOD.holderList, { pools: [], burns: [], cex: [] });
  assert.ok(
    naive.rawTop10Pct > 25,
    `fixture must exceed the 25% gate on raw top-10, got ${naive.rawTop10Pct}`,
  );

  // Second: prove the exclusion is what changes the answer.
  const real = concentration(GOOD.holderList, GOOD.knownAccounts);
  assert.ok(
    real.excludedTop10Pct <= 25,
    `excluded top-10 must clear the gate, got ${real.excludedTop10Pct}`,
  );
  assert.equal(real.excluded.length, 3, 'pool + burn + CEX must all be removed');
  assert.deepEqual(
    real.excluded.map((e) => e.kind).sort(),
    ['burn', 'cex', 'pool'],
  );

  // Third: the filter must pass it, and not on any other gate.
  const r = evaluate(GOOD, { sizeUsd: 400, known: GOOD.knownAccounts, holders: GOOD.holderList });
  assert.deepEqual(r.kills, [], `expected no kills, got ${JSON.stringify(r.kills.map((k) => k.reason))}`);
  assert.deepEqual(r.unknowns, [], 'fixture supplies every flow metric, so no coverage gap');
  assert.equal(r.passed, true);
});

test('desk: the pool is matched by token-account owner, not by address', () => {
  // The live report puts the AMM vault at ~11.9% as the largest holder, and its
  // *address* appears in no known-account list — only its `owner` does.
  const list = [
    { address: 'unknownTokenAccount', owner: 'THE_POOL_OWNER', pct: 20 },
    { address: 'a', pct: 3 },
    { address: 'b', pct: 3 },
  ];
  const r = concentration(list, { pools: ['THE_POOL_OWNER'], burns: [], cex: [] });
  assert.equal(r.rawTop10Pct, 26);
  assert.equal(r.excludedTop10Pct, 6, 'owner match must remove the 20% pool entry');
  assert.equal(r.excluded[0].kind, 'pool');
});

// ── CASE 3: wash trading rejected ───────────────────────────────────────────

test('desk: a wash-traded token is rejected', () => {
  const r = evaluate(WASH, { sizeUsd: 400, known: WASH.knownAccounts, holders: WASH.holderList });
  assert.equal(r.passed, false);
  assert.equal(r.primary, 'wash_trading', `expected wash_trading, got ${r.primary}`);
  assert.match(r.kills[0].detail, /0\.09/, 'detail must show the actual 82/900 = 0.09 ratio');
});

// ── CASE 4: sizing refuses past 1% of pool ──────────────────────────────────

test('desk: a paper fill is refused when the size exceeds 1% of pool liquidity', () => {
  // $5,000 into a $200,000 pool is 2.5%.
  const r = simulateFill({
    side: 'buy',
    notionalUsd: 5_000,
    priceUsd: 0.001,
    liqUsd: 200_000,
    feeBps: 25,
    priorityFeeUsd: 0.0005,
    priorityFeeCapUsd: 0.005,
  });
  assert.equal(r.filled, false);
  assert.equal(r.refusal, 'size_exceeds_pool_share');
  assert.equal(r.qty, 0, 'a refused fill must produce no quantity');
});

test('desk: decideSize is capped by 1% of pool even when equity allows more', async () => {
  const { env } = noFeeEnv();
  // $10k equity -> 8% = $800 position ceiling. A $30k pool caps at $300.
  const d = await decideSize(env, { liqUsd: 30_000, now: NOW });
  assert.equal(d.ok, true);
  assert.equal(d.sizeUsd, 300, 'pool share (1% of $30k) must bind, not the 8% equity rule');
  assert.match(d.detail, /pool share/);
});

test('desk: modelled fees make a fill worse than the quoted price', () => {
  const r = simulateFill({
    side: 'buy',
    notionalUsd: 100,
    priceUsd: 0.001,
    liqUsd: 400_000,
    feeBps: 25,
    priorityFeeUsd: 0.0005,
    priorityFeeCapUsd: 0.005,
  });
  assert.equal(r.filled, true);
  assert.ok(r.priceUsd > 0.001, 'a buy must execute above the quote');
  assert.ok(r.lpFeeUsd > 0, 'LP fee must be charged');
  assert.ok(r.qty * r.priceUsd < 100, 'fees must reduce the token value received');
});

// ── CASE 5: circuit breaker cannot be un-halted ─────────────────────────────

test('desk: the daily loss breaker halts the desk and no code path can un-halt it', async () => {
  const e = makeEnv({ DESK_EQUITY_START_USD: '10000' });
  await db(e.env).run(
    `INSERT INTO desk_positions (id,mint,symbol,mode,opened_at,closed_at,entry_price,size_usd,filled_usd,qty,stop_price,peak_price,liq_at_entry,state,pnl_usd,pnl_pct,exit_reason,exit_price)
     VALUES ('p1','M','M','paper',?,?,1,900,900,900,0.9,1,100000,'closed',-900,-0.09,'stop_hard',0.91)`,
    Math.floor(NOW / 1000) - 100,
    Math.floor(NOW / 1000),
  );

  // checkBreaker trips on read.
  const { checkBreaker } = await import('../build/desk/arming.js');
  const b = await checkBreaker(e.env, NOW);
  assert.equal(b.halted, true, 'a -9% day must trip the breaker');
  assert.ok(b.until > NOW);

  // A halted desk opens nothing, and does no scanning either.
  const sweep = await runSweep(e.env, fixtureSource(), NOW);
  assert.equal(sweep.halted, true);
  assert.equal(sweep.opened, 0);
  assert.equal(sweep.candidates, 0, 'a halted desk must not even spend subrequests');

  // Requesting paper does NOT clear it.
  await requestMode(e.env, 'paper');
  assert.equal(await breakerActive(e.env, NOW + 1000), true, 'mode change must not clear the halt');

  // There is no exported reset. Assert the module surface, so adding one is a
  // deliberate act that breaks this test rather than a quiet convenience.
  const arming = await import('../build/desk/arming.js');
  const resetters = Object.keys(arming).filter((k) => /reset|clear|unhalt|override/i.test(k));
  assert.deepEqual(resetters, [], `no breaker-reset export may exist, found: ${resetters.join(', ')}`);

  // Time is the only exit.
  assert.equal(await breakerActive(e.env, b.until + 1), false, 'the halt must expire on its own');
});

test('desk: a -7.9% day does not trip the breaker', async () => {
  const e = makeEnv({ DESK_EQUITY_START_USD: '10000' });
  await db(e.env).run(
    `INSERT INTO desk_positions (id,mint,symbol,mode,opened_at,closed_at,entry_price,size_usd,filled_usd,qty,stop_price,peak_price,liq_at_entry,state,pnl_usd,pnl_pct,exit_reason,exit_price)
     VALUES ('p1','M','M','paper',?,?,1,900,900,900,0.9,1,100000,'closed',-790,-0.087,'stop_hard',0.91)`,
    Math.floor(NOW / 1000) - 100,
    Math.floor(NOW / 1000),
  );
  const { checkBreaker } = await import('../build/desk/arming.js');
  const b = await checkBreaker(e.env, NOW);
  assert.equal(b.halted, false, '-7.9% is under the -8% threshold');
});

// ── CASE 6: live arming refuses, naming every unmet gate ────────────────────

test('desk: live arming refuses with gates unmet and names each one', async () => {
  const { env } = noFeeEnv();
  const s = await armState(env);

  assert.equal(s.mode, 'paper', 'the desk must default to paper');
  assert.equal(s.armed, false);

  // Every gate must be present by name, and with a real requirement string.
  const names = s.gates.map((g) => g.name);
  for (const required of [
    'paper_trades',
    'paper_days',
    'expectancy_after_fees',
    'max_drawdown',
    'desk_live_secret',
    'capital_cap',
    'signer_isolation',
  ]) {
    assert.ok(names.includes(required), `gate ${required} must be reported`);
  }
  // On a fresh deploy every gate is unmet, and each says what it needs.
  assert.deepEqual([...s.unmet].sort(), [...names].sort(), 'all gates unmet on a fresh DB');
  for (const g of s.gates) {
    assert.ok(g.requirement.length > 10, `gate ${g.name} must state its requirement`);
    assert.ok(g.actual.length > 0, `gate ${g.name} must report its actual state`);
  }

  // A pasted private key is a FAILURE of isolation, not a configuration.
  const leaked = noFeeEnv({ DESK_SIGNER_KEY: '5xPRIVATEKEY', DESK_SIGNER_URL: 'https://signer' });
  const s2 = await armState(leaked.env);
  const iso = s2.gates.find((g) => g.name === 'signer_isolation');
  assert.equal(iso.met, false, 'DESK_SIGNER_KEY present must FAIL isolation even with a signer URL');
  assert.match(iso.actual, /DESK_SIGNER_KEY present/);
});

test('desk: no amount of arming lets this build submit a real order', async () => {
  const { env } = noFeeEnv();
  await assert.rejects(() => submitLive(env), /live_signer_not_wired/);
});

// ── CASE 7: the full paper round-trip ───────────────────────────────────────

test('desk: full paper round-trip — scout, filter, score, fill, stop', async () => {
  const e = makeEnv({ DESK_PRIO_FEE_USD: '0.0005' });
  const src = fixtureSource();

  // ── scout + filter + score + fill ──────────────────────────────────────
  const sweep = await runSweep(e.env, src, NOW);
  assert.equal(sweep.candidates, 3, 'all three fixtures enter the scan');
  assert.equal(sweep.killed, 2, 'honeypot and wash token are killed');
  assert.equal(sweep.judged, 3);
  assert.equal(sweep.opened, 1, 'exactly the good token opens a position');

  // The kills are recorded with reason codes and a full snapshot.
  const kills = e.raw.prepare('SELECT mint, reason, snapshot FROM desk_kills ORDER BY reason').all();
  assert.equal(kills.length, 2);
  const reasons = kills.map((k) => k.reason).sort();
  assert.deepEqual(reasons, ['freeze_authority_live', 'wash_trading']);
  for (const k of kills) {
    const snap = JSON.parse(k.snapshot);
    assert.ok(snap.market, 'every kill stores the market snapshot');
    assert.ok(snap.safety, 'every kill stores the safety snapshot');
  }

  // The score row carries the stored why.
  const score = e.raw.prepare('SELECT total, passed, why FROM desk_scores WHERE mint=?').get(GOOD.market.mint);
  assert.ok(score, 'the good token must have a score row');
  assert.equal(score.passed, 1);
  assert.ok(score.total >= 70, `score must clear 70, got ${score.total}`);
  assert.match(score.why, /PASS/, 'the why must be stored, not only messaged');

  // A position and the first (50%) fill exist.
  const pos = e.raw.prepare("SELECT * FROM desk_positions WHERE state='open'").get();
  assert.ok(pos, 'a paper position must be open');
  assert.equal(pos.mode, 'paper', 'the position must be stamped paper');
  assert.equal(pos.mint, GOOD.market.mint);
  const fills = e.raw.prepare('SELECT * FROM desk_fills WHERE position_id=?').all(pos.id);
  assert.equal(fills.length, 1, 'only the first tranche fills at open');
  assert.equal(fills[0].tranche, 'entry');
  assert.equal(fills[0].mode, 'paper');
  assert.ok(Math.abs(fills[0].notional_usd - pos.size_usd * 0.5) < 0.01, 'first tranche must be 50%');
  assert.ok(fills[0].lp_fee_usd > 0, 'paper fills must charge the LP fee');
  // The stop is max(-6%, -1.5 x ATR14); ATR14 is 7.5% so the ATR leg binds at 11.25%.
  assert.ok(pos.stop_price < pos.entry_price, 'stop must sit below entry');
  const stopFrac = (pos.entry_price - pos.stop_price) / pos.entry_price;
  assert.ok(Math.abs(stopFrac - 0.1125) < 0.01, `ATR stop must be ~11.25%, got ${(stopFrac * 100).toFixed(2)}%`);

  // ── stop fires ─────────────────────────────────────────────────────────
  const crash = { [GOOD.market.mint]: { priceUsd: GOOD.market.priceUsd * 0.8 } };
  const risk = await runRiskTick(e.env, fixtureSource(crash), NOW + 60_000);
  assert.equal(risk.exited, 1, 'the stop must close the position');

  const closed = e.raw.prepare('SELECT * FROM desk_positions WHERE id=?').get(pos.id);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'stop_hard');
  assert.ok(closed.pnl_usd < 0, 'a stop exit must book a loss');
  assert.ok(closed.pnl_pct < 0 && closed.pnl_pct > -0.5, `loss must be bounded, got ${closed.pnl_pct}`);

  // The exit fill is recorded, and the sell pays the fee.
  const sells = e.raw.prepare("SELECT * FROM desk_fills WHERE position_id=? AND side='sell'").all(pos.id);
  assert.equal(sells.length, 1);
  assert.ok(sells[0].lp_fee_usd > 0);

  // The ledger received the audit lines (append-only, hash-chained).
  const kinds = e.raw.prepare("SELECT kind FROM ledger WHERE kind LIKE 'desk.%' ORDER BY seq").all().map((r) => r.kind);
  assert.ok(kinds.includes('desk.kill'), 'kills must be audited');
  assert.ok(kinds.includes('desk.open'), 'opens must be audited');
  assert.ok(kinds.includes('desk.exit'), 'exits must be audited');

  // And the security tables were not polluted by trading data.
  for (const t of ['findings', 'evidence', 'probes']) {
    const n = e.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
    assert.equal(n.n, 0, `${t} must never receive trading data`);
  }
});

test('desk: the round trip is deterministic — the same fixtures give the same score', async () => {
  const run = async () => {
    const e = makeEnv({ DESK_PRIO_FEE_USD: '0.0005' });
    await runSweep(e.env, fixtureSource(), NOW);
    return e.raw.prepare('SELECT total, why FROM desk_scores ORDER BY mint').all();
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a, b, 'identical fixtures must produce identical scores');
});

// ── supporting cases: the gates that are easy to get subtly wrong ───────────

test('desk: liquidity is gated as a ratio, so a $40k pool fails a $20M token', () => {
  const m = {
    mint: 'm',
    symbol: 'X',
    name: '',
    pairAddress: '',
    dexId: 'raydium',
    pairCreatedAtMs: NOW - 6 * 3600 * 1000,
    priceUsd: 1,
    mcapUsd: 20_000_000,
    liqUsd: 40_000, // exactly the absolute floor, but 0.2% of mcap
    vol1hUsd: 100_000,
    vol24hUsd: 1e6,
    price6hLowUsd: 1,
    price24hLowUsd: 1,
    feeBps: 25,
  };
  const r = scout(m, 2000, NOW);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'liq_below_ratio_gate');
  // The same pool on a $1M token is 4% of mcap and passes.
  assert.equal(scout({ ...m, mcapUsd: 1_000_000 }, 2000, NOW).keep, true);
});

test('desk: a 70 assembled from one hero metric still fails, via the floors', () => {
  // The scenario the floors exist for: momentum is maxed out, everything else is
  // mediocre-but-not-zero, and the TOTAL clears 70. Without floors this passes.
  // With floors it must be refused.
  const d = structuredClone(GOOD);
  d.market.change1hPct = 55;
  d.market.change6hPct = 90;
  d.market.liqUsd = 40_000; // 0.8% of a $5M cap -> depth badly caps liqQuality
  d.market.vol1hUsd = 1_400_000; // no thin-pool waiver; churn is not depth
  d.holders.holders = 300; // bottom of Scout's band -> holderGrowth scores 0
  const a = analyze({ market: d.market, holders: d.holders, safety: d.safety, filterPassed: true });

  // The point: the total is good enough on its own.
  assert.ok(
    a.total >= 70,
    `this test only means something if the total clears 70 on its own, got ${a.total}`,
  );
  assert.equal(a.passed, false, 'floors must refuse a token whose total clears 70');
  assert.ok(a.floorFailed.length > 0, 'at least one component must be under its floor');
  assert.ok(a.floorFailed.includes('liqQuality'), `liqQuality must be under its floor, failed: ${a.floorFailed}`);
  assert.ok(a.subscores.momentum.score >= 70, `momentum should be high, got ${a.subscores.momentum.score}`);
});

test('desk: late entry kills a chase by multiple-of-low, not a flat percentage', () => {
  const d = structuredClone(GOOD);
  d.market.priceUsd = d.market.price24hLowUsd * 4.0; // 4x the 24h low
  d.market.price6hLowUsd = d.market.price24hLowUsd;
  const r = evaluate(d, { sizeUsd: 400, known: d.knownAccounts, holders: d.holderList });
  assert.equal(r.primary, 'late_entry');
});

test('desk: Token-2022 permanent delegate is a kill; a 4% transfer fee is not', () => {
  const withDelegate = structuredClone(GOOD);
  withDelegate.safety.extensions = ['permanentDelegate'];
  assert.equal(
    evaluate(withDelegate, { sizeUsd: 400, known: GOOD.knownAccounts, holders: GOOD.holderList }).primary,
    'token2022_dangerous_extension',
  );

  const withFee = structuredClone(GOOD);
  withFee.safety.transferFeeBps = 400; // 4%, under the 5% ceiling
  assert.deepEqual(
    evaluate(withFee, { sizeUsd: 400, known: GOOD.knownAccounts, holders: GOOD.holderList }).kills,
    [],
    'a 4% transfer fee is a cost, not a honeypot',
  );

  const overFee = structuredClone(GOOD);
  overFee.safety.transferFeeBps = 600;
  assert.equal(
    evaluate(overFee, { sizeUsd: 400, known: GOOD.knownAccounts, holders: GOOD.holderList }).primary,
    'token2022_dangerous_extension',
  );
});

test('desk: a reverting sell simulation is a honeypot kill', () => {
  const d = structuredClone(GOOD);
  d.sell = { ok: false, priceImpactPct: 0, revertReason: 'transfer disabled', modelled: true };
  const r = evaluate(d, { sizeUsd: 400, known: d.knownAccounts, holders: d.holderList });
  assert.equal(r.primary, 'honeypot_sell_reverts');
});

test('desk: risk exits on liquidity decay before it looks at PnL', () => {
  const pos = {
    id: 'p',
    mint: 'm',
    entryPrice: 1,
    confirmationPrice: null,
    sizeUsd: 500,
    filledUsd: 250,
    qty: 250,
    stopPrice: 0.9,
    peakPrice: 1.05,
    trailArmed: false,
    trailPct: 0.12,
    atr14: 5,
    liqAtEntry: 100_000,
    openedAt: Math.floor(NOW / 1000),
  };
  // Profitable, but liquidity is down 30%: must still exit.
  const d = assess(pos, { mint: 'm', priceUsd: 1.1, liqUsd: 70_000, ts: NOW }, NOW);
  assert.equal(d.exit, true);
  assert.equal(d.reason, 'liq_decay', 'liq decay must win over a profitable mark');
});

test('desk: risk exits on a dev sell regardless of PnL', () => {
  const pos = {
    id: 'p',
    mint: 'm',
    entryPrice: 1,
    confirmationPrice: null,
    sizeUsd: 500,
    filledUsd: 250,
    qty: 250,
    stopPrice: 0.9,
    peakPrice: 1.4,
    trailArmed: true,
    trailPct: 0.12,
    atr14: 5,
    liqAtEntry: 100_000,
    openedAt: Math.floor(NOW / 1000),
  };
  const d = assess(pos, { mint: 'm', priceUsd: 1.3, liqUsd: 99_000, devSold: true, ts: NOW }, NOW);
  assert.equal(d.reason, 'dev_sell');
});

test('desk: time stop fires when nothing happened inside 4h', () => {
  const pos = {
    id: 'p',
    mint: 'm',
    entryPrice: 1,
    confirmationPrice: null,
    sizeUsd: 500,
    filledUsd: 250,
    qty: 250,
    stopPrice: 0.9,
    peakPrice: 1.02,
    trailArmed: false,
    trailPct: 0.12,
    atr14: 5,
    liqAtEntry: 100_000,
    openedAt: Math.floor(NOW / 1000) - 5 * 3600,
  };
  const d = assess(pos, { mint: 'm', priceUsd: 1.01, liqUsd: 100_000, ts: NOW }, NOW);
  assert.equal(d.reason, 'time_stop');
});

test('desk: trailing stop arms at +12% and tightens to 6% after +40%', () => {
  const mk = (peak) => ({
    id: 'p',
    mint: 'm',
    entryPrice: 1,
    confirmationPrice: null,
    sizeUsd: 500,
    filledUsd: 500,
    qty: 500,
    stopPrice: 0.9,
    peakPrice: peak,
    trailArmed: false,
    trailPct: 0.12,
    atr14: 5,
    liqAtEntry: 100_000,
    openedAt: Math.floor(NOW / 1000),
  });
  // +5% peak: trail not armed.
  assert.equal(assess(mk(1.05), { mint: 'm', priceUsd: 1.05, liqUsd: 1e5, ts: NOW }, NOW).trailArmed, false);
  // +20% peak: armed at 12%.
  const armed = assess(mk(1.2), { mint: 'm', priceUsd: 1.2, liqUsd: 1e5, ts: NOW }, NOW);
  assert.equal(armed.trailArmed, true);
  assert.equal(armed.trailPct, 0.12);
  // +50% peak: tightened to 6%.
  const tight = assess(mk(1.5), { mint: 'm', priceUsd: 1.5, liqUsd: 1e5, ts: NOW }, NOW);
  assert.equal(tight.trailPct, 0.06);
});

test('desk: never average down — a second open on the same mint is refused', async () => {
  const e = makeEnv({ DESK_PRIO_FEE_USD: '0.0005' });
  const quote = { mint: GOOD.market.mint, priceUsd: GOOD.market.priceUsd, liqUsd: GOOD.market.liqUsd, ts: NOW };
  const first = await openPosition(e.env, {
    mint: GOOD.market.mint,
    symbol: 'GOOD',
    quote,
    priceHistory: { atr14Pct: 7.5 },
    now: NOW,
  });
  assert.equal(first.opened, true);
  const second = await openPosition(e.env, {
    mint: GOOD.market.mint,
    symbol: 'GOOD',
    quote,
    priceHistory: { atr14Pct: 7.5 },
    now: NOW,
  });
  assert.equal(second.opened, false);
  assert.equal(second.refusal, 'never_average_down');
});

test('desk: concurrent-position cap refuses the fourth position', async () => {
  const e = makeEnv({ DESK_PRIO_FEE_USD: '0.0005' });
  for (let i = 0; i < 3; i++) {
    const r = await openPosition(e.env, {
      mint: `mint${i}`,
      symbol: `M${i}`,
      quote: { mint: `mint${i}`, priceUsd: 1, liqUsd: 10_000_000, ts: NOW },
      priceHistory: { atr14Pct: 5 },
      now: NOW,
    });
    assert.equal(r.opened, true, `position ${i} should open`);
  }
  const fourth = await openPosition(e.env, {
    mint: 'mint4',
    symbol: 'M4',
    quote: { mint: 'mint4', priceUsd: 1, liqUsd: 10_000_000, ts: NOW },
    priceHistory: { atr14Pct: 5 },
    now: NOW,
  });
  assert.equal(fourth.opened, false);
  assert.equal(fourth.refusal, 'max_concurrent_positions');
});

test('desk: a coverage gap is not a kill and does not open a position', async () => {
  const e = makeEnv({ DESK_PRIO_FEE_USD: '0.0005' });
  const d = structuredClone(GOOD);
  // The free tier cannot supply these; the desk must say so rather than guess.
  d.holders.uniqueBuyers = null;
  d.holders.bundledPct = null;
  d.holders.sniper20Pct = null;
  d.holders.devClusterPct = null;

  const r = evaluate(d, { sizeUsd: 400, known: d.knownAccounts, holders: d.holderList });
  assert.equal(r.kills.length, 0, 'missing flow data is not a kill');
  assert.ok(r.unknowns.length >= 4, 'each missing flow metric must be named');
  assert.equal(r.passed, false, 'an unjudgeable token must not pass');

  const src = { ...fixtureSource(), candidates: async () => [d.market], dossier: async () => d };  const sweep = await runSweep(e.env, src, NOW);
  assert.equal(sweep.coverage_gaps, 1);
  assert.equal(sweep.killed, 0, 'a coverage gap must never be counted as a kill');
  assert.equal(sweep.opened, 0);

  const row = e.raw.prepare('SELECT why FROM desk_scores WHERE mint=?').get(d.market.mint);
  assert.match(row.why, /NOT JUDGED/);
  // And it must not appear in the calibration population.
  const kills = e.raw.prepare('SELECT COUNT(*) AS n FROM desk_kills').get();
  assert.equal(kills.n, 0);
});

// --- kills_today counts TOKENS, not scan passes -----------------------------
//
// Regression, from the production dump: `kills_today` was COUNT(*), and a sweep
// re-evaluates the same token on every 5-minute tick, appending a fresh
// desk_kills row each time the token still fails a gate. The dump held 4,791
// kill rows over 554 distinct mints (one mint re-killed 19 times), so OPS
// showed "kills today 3,180" while the ledger - written only by the filter stage
// - showed 117 rows. The number was an order of magnitude wrong, in exactly the
// direction a re-scan inflates it.
//
// This seeds three rows for one mint plus one row for a second mint on the same
// day, so COUNT(*) = 4 and COUNT(DISTINCT mint) = 2. Before the fix the first
// assertion reads 4.

test('desk: kills_today counts distinct tokens, not repeated scan passes', async () => {
  const e = makeEnv();
  const TODAY = 1793300000; // seconds, inside the fixed NOW's UTC day
  const insert = e.raw.prepare(
    `INSERT INTO desk_kills (id, mint, symbol, ts, reason, detail, snapshot, outcome)
     VALUES (?,?,?,?,?,?,?,'unknown')`,
  );
  // One token, seen and rejected on three consecutive ticks.
  for (const n of [0, 1, 2]) {
    insert.run(`kill_rep_${n}`, 'MINT_REPEATED', 'REP', TODAY + n * 300, 'mcap_out_of_band', 'too small', '{}');
  }
  // A second token, rejected once.
  insert.run('kill_once', 'MINT_ONCE', 'ONCE', TODAY + 600, 'age_out_of_band', 'too new', '{}');

  const s = await deskStatus(e.env, NOW);
  assert.equal(s.kills_today, 2, 'one rejected token is one kill, however often it was re-scanned');
  assert.notEqual(s.kills_today, 4, 'COUNT(*) is the bug this pins');

  // The honest value is still bounded by the rows that exist today.
  const rows = e.raw.prepare('SELECT COUNT(*) AS n FROM desk_kills WHERE ts>=?').get(TODAY).n;
  assert.equal(rows, 4);
  assert.ok(s.kills_today <= rows);
});

test('desk: kills_today ignores kills from an earlier UTC day', async () => {
  const e = makeEnv();
  const YESTERDAY = 1793300000 - 86400;
  e.raw
    .prepare(
      `INSERT INTO desk_kills (id, mint, symbol, ts, reason, detail, snapshot, outcome)
       VALUES (?,?,?,?,?,?,?,'unknown')`,
    )
    .run('kill_old', 'MINT_OLD', 'OLD', YESTERDAY, 'mcap_out_of_band', 'too small', '{}');

  const s = await deskStatus(e.env, NOW);
  assert.equal(s.kills_today, 0, 'the window is the current UTC day');
});

test('desk: deskStatus reports mode paper and the unmet gates for the API', async () => {
  const e = makeEnv({ DESK_PRIO_FEE_USD: '0.0005' });
  const s = await deskStatus(e.env, NOW);
  assert.equal(s.mode, 'paper');
  assert.equal(s.armed, false);
  assert.ok(s.gates_unmet.length > 0);
  assert.equal(s.equity, 10000);
  assert.equal(s.open_positions, 0);
  assert.equal(s.breaker_halted, false);
});

test('desk: no desk module imports a chain key or submits a transaction', () => {
  // Structural guard: the desk must never grow a signing path by accident.
  const files = [
    'arming.ts',
    'analyst.ts',
    'cards.ts',
    'db.ts',
    'executor.ts',
    'filter.ts',
    'holders.ts',
    'logger.ts',
    'paper.ts',
    'pipeline.ts',
    'reasons.ts',
    'risk.ts',
    'scout.ts',
    'source.ts',
    'thesis.ts',
    'types.ts',
  ];
  for (const f of files) {
    const src = readFileSync(join(HERE, '..', 'src', 'desk', f), 'utf8');
    assert.ok(
      !/sendTransaction|signTransaction|Keypair\.fromSecretKey|bs58\.decode/.test(src),
      `${f} must not contain transaction signing`,
    );
  }
});
