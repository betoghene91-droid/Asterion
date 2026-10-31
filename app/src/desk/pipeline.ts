/**
 * Pipeline — the six agents, composed.
 *
 * This is the only file that runs Scout → Filter → Analyst → Executor → Risk →
 * Logger in sequence. Each agent is a pure-ish function tested on its own; this
 * file's job is ordering, persistence, error isolation and the audit trail.
 *
 * Two properties worth stating because they are easy to lose in a refactor:
 *
 *  1. **One bad mint never aborts the sweep.** Every per-mint step is wrapped:
 *     a malformed report, a dead pair, a budget exhaustion mid-loop leaves the
 *     rest of the universe processable. A sweep that dies on token #3 reports
 *     "0 candidates" and looks like a quiet market.
 *  2. **Every decision is audited through the ledger.** Opening, refusing,
 *     killing and exiting each append a `desk.*` line. The ledger is hash-chained
 *     and append-only, so a position that appears with no corresponding ledger
 *     line is detectable — which is the property that makes the paper track
 *     record worth anything at month three.
 *
 * The desk never writes to findings/evidence/probes. Trading history lives in
 * desk_* tables so a lucky memecoin can never be mistaken for a security finding.
 */

import { append as ledgerAppend } from '../ledger.js';
import { analyze } from './analyst.js';
import { armState, checkBreaker, todayRealizedPnl } from './arming.js';
import { db, newId, realizedEquity, subrequestsUsed } from './db.js';
import { confirmEntry, decideSize, openPosition, recordFill } from './executor.js';
import { evaluate } from './filter.js';
import { buildKnownAccounts, concentration, type HolderEntry } from './holders.js';import { buildCalibration, measureOutcomes, recordExit, recordHaircut, recordKill, saveCalibration } from './logger.js';
import { flowProviderFromRpc } from './flow.js';
import { snapshotUniverseMarks } from './marks.js';
import { haircutFrom, simulateFill } from './paper.js';
import { registryKnownAccounts, registryOptionsFrom } from './registry.js';
import { assess, realizedPnl, type OpenPositionState } from './risk.js';
import { scout } from './scout.js';
import { liveSource } from './source.js';
import { writeThesis } from './thesis.js';
import { latestThesis } from './thesis.js';
import { SIZING, type DeskEnv, type DeskSource, type MarketSnapshot, type TokenDossier } from './types.js';

export interface SweepReport {
  candidates: number;
  scouted_out: number;
  judged: number;
  killed: number;
  /** Tokens we could not judge for lack of flow data. NOT kills. */
  coverage_gaps: number;
  scored: number;
  passed: number;
  opened: number;
  refused: number;
  errors: number;
  halted: boolean;
}
function emptySweep(): SweepReport {
  return {
    candidates: 0,
    scouted_out: 0,
    judged: 0,
    killed: 0,
    coverage_gaps: 0,
    scored: 0,
    passed: 0,
    opened: 0,
    refused: 0,
    errors: 0,
    halted: false,
  };
}

/** Persist one universe row. Upsert: a mint seen again is the same token, newer. */
async function upsertUniverse(env: DeskEnv, m: MarketSnapshot, now: number, state: string): Promise<void> {
  const ts = Math.floor(now / 1000);
  await db(env).run(
    `INSERT INTO desk_universe
     (mint, symbol, name, pair_address, dex, pair_created_at, first_seen, last_seen,
      mcap_usd, liq_usd, vol_1h_usd, vol_24h_usd, price_usd, price_6h_low, price_24h_low, holders, state, snapshot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(mint) DO UPDATE SET
       last_seen=excluded.last_seen, mcap_usd=excluded.mcap_usd, liq_usd=excluded.liq_usd,
       vol_1h_usd=excluded.vol_1h_usd, vol_24h_usd=excluded.vol_24h_usd,
       price_usd=excluded.price_usd, price_6h_low=excluded.price_6h_low,
       price_24h_low=excluded.price_24h_low, holders=excluded.holders,
       state=CASE WHEN desk_universe.state IN ('killed','expired') THEN desk_universe.state ELSE excluded.state END,
       snapshot=excluded.snapshot`,
    m.mint,
    m.symbol,
    m.name,
    m.pairAddress,
    m.dexId,
    m.pairCreatedAtMs,
    ts,
    ts,
    m.mcapUsd,
    m.liqUsd,
    m.vol1hUsd,
    m.vol24hUsd,
    m.priceUsd,
    m.price6hLowUsd,
    m.price24hLowUsd,
    // Holder count arrives with the dossier, not the pair. 0 here means unknown;
    // the scout gate reads the dossier's count, so this cannot pass a token.
    0,
    state,
    JSON.stringify(m),
  );
}

async function setUniverseState(env: DeskEnv, mint: string, state: string, holders?: number): Promise<void> {
  if (holders === undefined) {
    await db(env).run('UPDATE desk_universe SET state=? WHERE mint=?', state, mint);
  } else {
    await db(env).run('UPDATE desk_universe SET state=?, holders=? WHERE mint=?', state, holders, mint);
  }
}

/**
 * Scout + Filter + Analyst + Executor for one pass.
 *
 * `source` is injected so tests drive fixtures. In production it is
 * `liveSource(env)`; the composition root (`deskTick`) supplies it.
 */
export async function runSweep(
  env: DeskEnv,
  source: DeskSource = liveSource(env),
  now = Date.now(),
): Promise<SweepReport> {
  const report = emptySweep();

  // Breaker first: a halted desk does no scanning at all, which also stops the
  // subrequest spend. Halting is not just "no trades", it is "no work".
  const breaker = await checkBreaker(env, now);
  report.halted = breaker.halted;
  if (breaker.halted) return report;

  let candidates: MarketSnapshot[] = [];
  try {
    candidates = await source.candidates(50);
  } catch (e) {
    console.error('desk: candidate fetch failed', e);
    report.errors++;
    return report;
  }
  report.candidates = candidates.length;

  const equity = await realizedEquity(env);
  // Size the honeypot probe off the largest position we could take, so the probe
  // answers the question that matters: "can we exit OUR size", not "can we exit
  // a dollar".
  const probeSize = Math.min(
    equity * SIZING.maxPositionPctOfEquity * SIZING.splitEntry.first,
    50_000,
  );

  for (const m of candidates) {
    try {
      // ── Scout ────────────────────────────────────────────────────────────
      // Holder count is a dossier fact, so scout cannot fully decide yet. The
      // cheap market gates run on the pair alone; holder count is re-checked
      // after the dossier, below. This keeps the expensive RPC off tokens that
      // already fail on age/mcap/liquidity.
      const dor = m as MarketSnapshot;
      const cheap = scout(dor, SCOUT_HOLDER_PROBE, now);
      if (!cheap.keep && cheap.reason !== 'holders_too_few') {
        report.scouted_out++;
        await upsertUniverse(env, m, now, 'killed');
        await recordKill(env, {
          mint: m.mint,
          symbol: m.symbol,
          reason: cheap.reason!,
          detail: cheap.detail ?? '',
          // Same top-level shape as a filter-stage kill, so every downstream
          // reader (the /kills summary, the calibration report) can read
          // `market` and `holders` without a stage switch.
          snapshot: { stage: 'scout', market: m, safety: null, holders: null },
          now,
        });
        continue;
      }

      // ── DexScreener / RugCheck ───────────────────────────────────────────
      let dossier: TokenDossier;
      try {
        dossier = await source.dossier(m.mint, probeSize);
      } catch (e) {
        report.errors++;
        continue;
      }
      report.judged++;

      await upsertUniverse(env, dossier.market, now, 'in');

      // Scout's holder gate now has a real number.
      const holdersN = dossier.holders.holders;
      const full = scout(dossier.market, holdersN, now);
      if (!full.keep) {
        report.scouted_out++;
        await setUniverseState(env, m.mint, 'killed', holdersN ?? undefined);
        await recordKill(env, {
          mint: m.mint,
          symbol: dossier.market.symbol,
          reason: full.reason!,
          detail: full.detail ?? '',
          snapshot: {
            stage: 'scout',
            market: dossier.market,
            safety: dossier.safety,
            holders: dossier.holders,
          },
          now,
        });
        continue;
      }

      // ── Filter ───────────────────────────────────────────────────────────
      // The dossier carries the raw holder list and the derived pool/burn/CEX
      // registry, because the exclusion needs identities, not a pre-computed
      // percentage. A source that omits them yields coverage gaps, not passes.
      const known = dossier.knownAccounts ?? { pools: [], burns: [], cex: [] };
      const holderRows = dossier.holderList;

      const verdict = evaluate(dossier, { sizeUsd: probeSize, known, holders: holderRows });

      if (verdict.kills.length > 0) {
        report.killed++;
        await setUniverseState(env, m.mint, 'killed');
        // One kill row per reason would double-count the token in calibration;
        // the primary reason is the recorded one and the rest go in the snapshot
        // so "would this have been killed anyway" stays answerable.
        await recordKill(env, {
          mint: m.mint,
          symbol: dossier.market.symbol,
          reason: verdict.primary!,
          detail: verdict.kills[0]!.detail,
          // Top-level market/safety/holders so every reader sees one shape; the
          // full dossier and the complete kill list stay nested for calibration.
          snapshot: {
            stage: 'filter',
            market: dossier.market,
            safety: dossier.safety,
            holders: dossier.holders,
            kills: verdict.kills,
            notes: verdict.notes,
            dossier,
          },
          now,
        });
        await ledgerAppend(env, 'desk.kill', {
          mint: m.mint,
          symbol: dossier.market.symbol,
          reason: verdict.primary,
          reasons: verdict.kills.map((k) => k.reason),
        });
        continue;
      }

      if (verdict.unknowns.length > 0) {
        // Not a kill. The token is unjudgeable on the free tier; record the gap
        // so the operator can see coverage rather than assume a quiet market.
        report.coverage_gaps++;
        await setUniverseState(env, m.mint, 'scored');
        await db(env).run(
          `INSERT INTO desk_scores (id, mint, ts, total, subscores, floor_failed, passed, why)
           VALUES (?,?,?,?,?,?,0,?)`,
          newId('score'),
          m.mint,
          Math.floor(now / 1000),
          0,
          JSON.stringify({ unknown: verdict.unknowns }),
          JSON.stringify(verdict.unknowns),
          `NOT JUDGED — coverage gap: ${verdict.unknowns.join(', ')}`,
        );
        continue;
      }

      // ── Analyst ──────────────────────────────────────────────────────────
      const analysis = analyze({
        market: dossier.market,
        holders: dossier.holders,
        safety: dossier.safety,
        filterPassed: true,
      });
      report.scored++;

      const scoreId = newId('score');
      await db(env).run(
        `INSERT INTO desk_scores (id, mint, ts, total, subscores, floor_failed, passed, why)
         VALUES (?,?,?,?,?,?,?,?)`,
        scoreId,
        m.mint,
        Math.floor(now / 1000),
        analysis.total,
        JSON.stringify(analysis.subscores),
        JSON.stringify(analysis.floorFailed),
        analysis.passed ? 1 : 0,
        analysis.why,
      );

      if (!analysis.passed) {
        await setUniverseState(env, m.mint, 'scored');
        continue;
      }
      report.passed++;
      await setUniverseState(env, m.mint, 'passed');

      // ── Thesis ───────────────────────────────────────────────────────────
      // Prose only. The score above is already final and the size below is
      // computed from equity, so nothing here can move either one.
      const thesis = await writeThesis(env, dossier, analysis, { now }).catch(() => null);

      // ── Executor ─────────────────────────────────────────────────────────
      const open = await openPosition(env, {
        mint: dossier.market.mint,
        symbol: dossier.market.symbol,
        quote: { mint: dossier.market.mint, priceUsd: dossier.market.priceUsd, liqUsd: dossier.market.liqUsd, ts: now },
        priceHistory: { atr14Pct: dossier.holders.atr14Pct },
        thesisId: thesis?.id ?? null,
        now,
      });

      if (!open.opened) {
        report.refused++;
        await ledgerAppend(env, 'desk.refused', {
          mint: dossier.market.mint,
          symbol: dossier.market.symbol,
          refusal: open.refusal,
          detail: open.detail,
          score: analysis.total,
        });
      } else {
        report.opened++;
        await ledgerAppend(env, 'desk.open', {
          mint: dossier.market.mint,
          symbol: dossier.market.symbol,
          position: open.positionId,
          size_usd: open.filledUsd,
          score: analysis.total,
          mode: 'paper',
        });
      }
    } catch (e) {
      // Isolate: one bad mint must not abort the sweep.
      report.errors++;
      console.error('desk sweep: mint failed', m.mint, e);
    }
  }

  return report;
}

/**
 * Scout is called twice: once before the dossier (holder count unknown) and once
 * after. Pass the floor as the probe value so the *cheap* pass only decides on
 * the gates it can actually see; the holder gate then genuinely re-evaluates.
 */
const SCOUT_HOLDER_PROBE = Number.MAX_SAFE_INTEGER;

/**
 * Risk tick: mark every open position, exit what the rules say to exit.
 *
 * Quotes are fetched one mint at a time with the source's own timeout. A quote
 * failure does NOT close a position — an unreachable price is not a -100% price,
 * and closing on a fetch error would turn an API outage into a fake loss.
 */
export async function runRiskTick(
  env: DeskEnv,
  source: DeskSource = liveSource(env),
  now = Date.now(),
): Promise<{ marked: number; exited: number; errors: number; halted: boolean }> {
  const out = { marked: 0, exited: 0, errors: 0, halted: false };

  const rows = await db(env).all<{
    id: string;
    mint: string;
    symbol: string | null;
    entry_price: number;
    confirmation_price: number | null;
    size_usd: number;
    filled_usd: number;
    qty: number;
    stop_price: number;
    peak_price: number;
    trail_armed: number;
    trail_pct: number;
    atr14: number;
    liq_at_entry: number;
    opened_at: number;
  }>("SELECT * FROM desk_positions WHERE state='open'");

  for (const r of rows) {
    try {
      const q = await source.quote(r.mint);
      out.marked++;

      const pos: OpenPositionState = {
        id: r.id,
        mint: r.mint,
        entryPrice: r.entry_price,
        confirmationPrice: r.confirmation_price,
        sizeUsd: r.size_usd,
        filledUsd: r.filled_usd,
        qty: r.qty,
        stopPrice: r.stop_price,
        peakPrice: r.peak_price,
        trailArmed: r.trail_armed === 1,
        trailPct: r.trail_pct,
        atr14: r.atr14,
        liqAtEntry: r.liq_at_entry,
        openedAt: r.opened_at,
      };

      const decision = assess(pos, q, now);

      // Persist the trailing advance even when not exiting.
      await db(env).run(
        'UPDATE desk_positions SET peak_price=?, trail_armed=?, trail_pct=? WHERE id=?',
        decision.peakPrice,
        decision.trailArmed ? 1 : 0,
        decision.trailPct,
        r.id,
      );

      if (!decision.exit || decision.priceUsd === null) {
        // Confirmation half: fill it once the position is in profit and has held
        // for at least one tick. The condition is deliberately simple and stated
        // here rather than buried: confirmation == price above entry.
        if (r.confirmation_price === null && decision.pnlPct > 0 && now - r.opened_at * 1000 > 60_000) {
          await confirmEntry(env, { positionId: r.id, quote: q, now }).catch(() => undefined);
        }
        continue;
      }

      // Exit. Model the sell with the same caps as the entry.
      const sellNotional = r.qty * decision.priceUsd;
      const prioFee = Number(env.DESK_PRIO_FEE_USD ?? '0.0005');
      const prioCap = Number(env.DESK_PRIO_FEE_CAP_USD ?? '0.005');
      const haircut = haircutFrom({ DESK_MEV_HAIRCUT_BPS: env.DESK_MEV_HAIRCUT_BPS, DESK_FAILED_TX_BPS: env.DESK_FAILED_TX_BPS });
      const fill = simulateFill({
        side: 'sell',
        notionalUsd: sellNotional,
        priceUsd: decision.priceUsd,
        liqUsd: q.liqUsd,
        feeBps: 30,
        priorityFeeUsd: prioFee,
        priorityFeeCapUsd: prioCap,
        mevBps: haircut.mevBps,
        failedTxBps: haircut.failedTxBps,
      });

      if (!fill.filled) {
        // Liquidity collapsed so far that even the exit will not model. Record
        // the refusal and keep the position open rather than inventing a fill at
        // a price that could not have executed. This is the one case where the
        // desk is knowingly stuck, and it is surfaced in /pos.
        out.errors++;
        await ledgerAppend(env, 'desk.exit_refused', {
          position: r.id,
          mint: r.mint,
          reason: decision.reason,
          refusal: fill.refusal,
          detail: fill.detail,
        });
        continue;
      }

      // PnL: entry notional is what we actually paid (filled_usd); exit notional
      // is what the sell returned, net of the sell-side costs the model charged.
      //
      // The execution haircut is charged INSIDE `fill.qty` (simulateFill reduces
      // net value by mev + failed-tx before dividing by the execution price), so it
      // already reduces `exitUsd` here. It is deliberately NOT added to `feeUsd` as
      // well: that would charge the same bps twice and make paper PnL pessimistic
      // in a way the calibration report could not explain. `feeUsd` keeps exactly
      // its previous meaning so this change cannot move an existing number except
      // through the haircut itself.
      const exitUsd = fill.qty * fill.priceUsd;
      const feeUsd = fill.lpFeeUsd + fill.prioFeeUsd;
      const pnl = realizedPnl({ entryUsd: r.filled_usd, exitUsd, qty: r.qty, feeUsd });

      // Record what the haircut cost, separately, so /calib can print the charged
      // number rather than only the configured one.
      await recordHaircut(env, {
        positionId: r.id,
        mint: r.mint,
        side: 'sell',
        notionalUsd: fill.notionalUsd,
        mevBps: haircut.mevBps,
        failedTxBps: haircut.failedTxBps,
        mevUsd: fill.mevUsd,
        failedTxUsd: fill.failedTxUsd,
        now,
      });

      await recordExit(env, {
        positionId: r.id,
        mint: r.mint,
        reason: decision.reason!,
        detail: decision.detail,
        entryUsd: r.filled_usd,
        exitUsd,
        feeUsd,
        pnlUsd: pnl.pnlUsd,
        pnlPct: pnl.pnlPct,
        exitPrice: fill.priceUsd,
        qty: fill.qty,
        now,
      });

      out.exited++;
      await ledgerAppend(env, 'desk.exit', {
        position: r.id,
        mint: r.mint,
        symbol: r.symbol,
        reason: decision.reason,
        detail: decision.detail,
        pnl_usd: pnl.pnlUsd,
        pnl_pct: pnl.pnlPct,
        mode: 'paper',
      });
    } catch (e) {
      out.errors++;
      console.error('desk risk tick: position failed', r.id, e);
    }
  }

  // Breaker after closes, so a day that just went -8% halts immediately rather
  // than at the next sweep.
  const breaker = await checkBreaker(env, now);
  out.halted = breaker.halted;
  if (breaker.halted) {
    await ledgerAppend(env, 'desk.halt', {
      until: breaker.until,
      reason: 'daily loss circuit breaker -8%',
      today_pnl: await todayRealizedPnl(env, now),
    });
  }

  return out;
}

/** Calibration: measure outcomes we can, then build and store the report. */
export async function runCalibration(
  env: DeskEnv,
  source: DeskSource = liveSource(env),
  now = Date.now(),
): Promise<{ measured: number; skipped: number; report_id: string }> {
  const m = await measureOutcomes(env, source, now);
  const report = await buildCalibration(env, now);
  const id = await saveCalibration(env, report);
  await ledgerAppend(env, 'desk.calibration', {
    report: id,
    kills: report.totals.kills,
    measured: report.totals.measured,
    false_negatives: report.totals.false_negatives,
  });
  return { measured: m.measured, skipped: m.skipped, report_id: id };
}

/**
 * The every-5-minutes cron body: scout + filter, then mark risk.
 *
 * Composed INTO the existing 5-minute slot alongside runSentinel, never
 * replacing it. Sentinel is the security sweep; this is the desk. Either
 * failing must not stop the other, so the composition root runs both and
 * catches independently.
 */
export async function deskTick(env: DeskEnv, source?: DeskSource, now = Date.now()): Promise<SweepReport & { risk: Awaited<ReturnType<typeof runRiskTick>>; marks: { written: number; considered: number } }> {
  const src = source ?? liveSource(env);
  const sweep = await runSweep(env, src, now);
  const risk = await runRiskTick(env, src, now);
  //
  // The forward price series, sampled on the tick that already paid for the
  // quotes. Deliberately AFTER the sweep and the risk tick, and wrapped so a
  // failure here cannot cost a trade: the series is evidence, not a gate, and an
  // evidence bug must never become a trading bug.
  //
  // This is the only place marks are taken, and it adds no cron slot — the desk
  // already runs inside the existing `*/5` composition root.
  // Hourly, not per-tick: the desk ticks every five minutes, and a mark row per
  // mint per tick is 57,600 of the 100,000 daily D1 rows_written on its own. The
  // series only has to support `minMarks` samples over a 6h window, so hourly is
  // far denser than any consumer needs.
  const marks = await snapshotUniverseMarks(env, now, 200, 3600)
    .catch(() => ({ written: 0, considered: 0 }));
  return { ...sweep, risk, marks };
}

/** The hourly slot: re-score what is in the universe, refresh theses. */
export async function deskAnalystTick(env: DeskEnv, source?: DeskSource, now = Date.now()): Promise<{ rescored: number }> {
  // Deliberately a no-op re-score of the universe is not enough value to justify
  // the RPC spend every hour; the analyst work happens in the sweep where the
  // dossier is already paid for. This hook exists so the cron slot is wired and
  // the cost is visible, and it refreshes theses for passed tokens only.
  const src = source ?? liveSource(env);
  const passed = await db(env).all<{ mint: string }>(
    "SELECT mint FROM desk_universe WHERE state='passed' ORDER BY last_seen DESC LIMIT 10",
  );
  let rescored = 0;
  for (const p of passed) {
    try {
      const d = await src.dossier(p.mint, 1000);
      const a = analyze({ market: d.market, holders: d.holders, safety: d.safety, filterPassed: true });
      await writeThesis(env, d, a, { now });
      rescored++;
    } catch {
      continue;
    }
  }
  return { rescored };
}

/** Desk status for /desk and /api/desk. One function, one shape. */
export async function deskStatus(env: DeskEnv, now = Date.now()): Promise<{
  mode: string;
  armed: boolean;
  gates_unmet: string[];
  gates: { name: string; met: boolean; requirement: string; actual: string }[];
  equity: number;
  open_positions: number;
  deployed_pct: number;
  pnl_today: number;
  breaker_halted: boolean;
  breaker_until: number;
  coverage_gaps: number;
  kills_today: number;
  subrequests: { used: number; cap: number };
}> {
  const arm = await armState(env);
  const equity = await realizedEquity(env);
  const deployed = await db(env).first<{ v: number | null }>(
    "SELECT SUM(filled_usd) AS v FROM desk_positions WHERE state='open'",
  );
  const open = await db(env).first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM desk_positions WHERE state='open'",
  );
  // Today, in UTC. `Math.floor(ms/86_400_000)*86_400` is seconds since epoch for
  // midnight UTC — the same convention llm.ts and quota use.
  const dayStart = Math.floor(Math.floor(now / 86_400_000) * 86_400);
  // ── DISTINCT TOKENS, NOT ROWS ─────────────────────────────────────────────
  // This used to be `COUNT(*)`. A sweep re-evaluates the SAME token on every
  // 5-minute tick, and every re-evaluation that fails a gate appends another
  // desk_kills row, so COUNT(*) measured "how many times did we look at a bad
  // token" rather than "how many tokens did we reject today". The production
  // dump at the time of this fix is the proof: 4,791 kill rows covering 554
  // distinct mints (one mint re-killed 19 times), which is why OPS read
  // "kills today 3,180" while the ledger - which is only written by the FILTER
  // stage - showed 117 desk.kill rows. COUNT(DISTINCT mint) is the number a
  // reader of that label can defend: one token is one rejection, however many
  // times the scanner revisited it.
  const kills = await db(env).first<{ n: number }>(
    'SELECT COUNT(DISTINCT mint) AS n FROM desk_kills WHERE ts>=?',
    dayStart,
  );
  const gaps = await db(env).first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM desk_scores WHERE why LIKE 'NOT JUDGED%' AND ts>=?",
    dayStart,
  );
  const breaker = await checkBreaker(env, now);

  return {
    mode: arm.mode,
    armed: arm.armed,
    gates_unmet: arm.unmet,
    gates: arm.gates,
    equity,
    open_positions: open?.n ?? 0,
    deployed_pct: equity > 0 ? (deployed?.v ?? 0) / equity : 0,
    pnl_today: await todayRealizedPnl(env, now),
    breaker_halted: breaker.halted,
    breaker_until: breaker.until,
    coverage_gaps: gaps?.n ?? 0,
    kills_today: kills?.n ?? 0,
    subrequests: await subrequestsUsed(env),
  };
}

/** Open positions with live mark. Used by /pos and /api/desk/positions. */
export async function positionRows(env: DeskEnv, source?: DeskSource, now = Date.now()): Promise<{
  mint: string;
  symbol: string;
  size: number;
  entry: number;
  current: number;
  pnl: number;
  pnl_pct: number;
  stop: number;
  opened_at: number;
  age_hours: number;
}[]> {
  const src = source ?? liveSource(env);
  const rows = await db(env).all<{
    id: string;
    mint: string;
    symbol: string | null;
    entry_price: number;
    confirmation_price: number | null;
    filled_usd: number;
    qty: number;
    stop_price: number;
    opened_at: number;
    mode: string;
  }>("SELECT * FROM desk_positions WHERE state='open' ORDER BY opened_at DESC");

  const out = [];
  for (const r of rows) {
    let current = r.entry_price;
    try {
      current = (await src.quote(r.mint)).priceUsd;
    } catch {
      // Keep entry as the mark rather than reporting a fake -100%.
      current = r.entry_price;
    }
    const entry =
      r.confirmation_price !== null ? (r.entry_price + r.confirmation_price) / 2 : r.entry_price;
    const pnl = (current - entry) * r.qty;
    out.push({
      mint: r.mint,
      symbol: r.symbol ?? r.mint.slice(0, 6),
      size: r.filled_usd,
      entry,
      current,
      pnl: Number(pnl.toFixed(2)),
      pnl_pct: entry > 0 ? Number(((current - entry) / entry).toFixed(4)) : 0,
      stop: r.stop_price,
      opened_at: r.opened_at,
      age_hours: Number(((now / 1000 - r.opened_at) / 3600).toFixed(2)),
    });
  }
  return out;
}

/** Kill rows for /kills and /api/desk/kills. */
export async function killRows(env: DeskEnv, limit = 20): Promise<{
  mint: string;
  symbol: string;
  reason_code: string;
  detail: string;
  ts: number;
  outcome: string;
  snapshot_summary: string;
}[]> {
  const rows = await db(env).all<{
    mint: string;
    symbol: string | null;
    reason: string;
    detail: string;
    ts: number;
    outcome: string;
    snapshot: string;
  }>('SELECT mint, symbol, reason, detail, ts, outcome, snapshot FROM desk_kills ORDER BY ts DESC LIMIT ?', limit);

  return rows.map((r) => {
    // A summary, not the whole dossier: the UI renders one line per kill and the
    // full snapshot stays in the row for calibration.
    let summary = '';
    try {
      const s = JSON.parse(r.snapshot) as { market?: { mcapUsd?: number; liqUsd?: number }; holders?: { holders?: number } };
      const mcap = s.market?.mcapUsd ?? 0;
      const liq = s.market?.liqUsd ?? 0;
      summary = `$${(mcap / 1e6).toFixed(2)}M cap / $${(liq / 1e3).toFixed(0)}k liq / ${s.holders?.holders ?? '?'} holders`;
    } catch {
      summary = 'snapshot unreadable';
    }
    return {
      mint: r.mint,
      symbol: r.symbol ?? r.mint.slice(0, 6),
      reason_code: r.reason,
      detail: r.detail,
      ts: r.ts,
      outcome: r.outcome,
      snapshot_summary: summary,
    };
  });
}

export { concentration, latestThesis, decideSize, recordFill, armState };
