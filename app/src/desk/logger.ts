/**
 * Logger + calibration.
 *
 * Every kill and every fill is already written by the agents as they act. What
 * this file adds is the part that makes the desk worth running: **the weekly
 * calibration report**, which asks the question a journal never asks —
 *
 *     for each kill reason, were the tokens we avoided actually bad?
 *
 * The answer splits every reason into false negatives (we killed it and it 3x'd)
 * and true positives (we killed it and it went to -90%). A reason with a high
 * false-negative rate is a gate that is costing money; a reason with a high
 * true-positive rate is earning its place. That comparison across reasons is the
 * model. Without it the desk is a diary with a PnL column.
 *
 * Honest limitation, stated here and in DESK.md: populating `outcome` requires a
 * price-history source (`DeskSource.since`). When it is absent, killed tokens stay
 * `outcome='unknown'` and the report says "unmeasured" per reason rather than
 * scoring them as dodges. An unmeasured reason is not a good reason.
 */

import { db, newId } from './db.js';
import { REASON_TEXT, EXIT_TEXT, type ExitReason, type KillReason } from './reasons.js';
import type { DeskEnv, DeskSource } from './types.js';

/** What a killed token did afterwards. Thresholds are the report's definition. */
export const CALIBRATION = {
  /** A dodge: the token collapsed. */
  dodgePct: -0.90,
  /** A false negative: the token ran. */
  missPct: 3.0,
  lookbackMs: 7 * 86_400_000,
} as const;

export interface CalibrationRow {
  reason_code: string;
  description: string;
  kills: number;
  /** Kills whose aftermath we could measure. */
  measured: number;
  true_positives: number;
  false_negatives: number;
  dodge_rate: number | null;
  false_negative_rate: number | null;
  /** Below this many measured kills, rates are noise. */
  thin: boolean;
}

export interface CalibrationReport {
  ts: number;
  window_start: number;
  window_end: number;
  rows: CalibrationRow[];
  totals: {
    kills: number;
    measured: number;
    true_positives: number;
    false_negatives: number;
    unmeasured: number;
  };
  note: string;
  /**
   * The execution haircut paper mode charged, in bps, and what it cost in USD.
   * Printed by /calib so the optimism is visible rather than assumed away.
   */
  haircut?: {
    mev_bps: number;
    failed_tx_bps: number;
    total_bps: number;
    /** Total USD charged across every recorded fill. */
    charged_usd: number;
    fills: number;
    source: 'constant' | 'env';
  };
  /** Coverage of the forward price series, so "unmeasured" is diagnosable. */
  marks?: {
    marks: number;
    mints: number;
    span_hours: number;
    dense_mints: number;
  };
  /** Where the flow facts came from and how many tokens have cached answers. */
  flow?: {
    source: string;
    cached_mints: number;
    newest_ts: number | null;
  };
}

/** Minimum measured kills before a rate is printed as anything but noise. */
export const MIN_SAMPLE = 5;

/**
 * Fill in `outcome` for kills we have not measured yet, using price history.
 *
 * Writes only to desk_kills (desk table) and only the outcome columns. It never
 * deletes a kill and never changes a reason, so the audit trail stays intact.
 */
export async function measureOutcomes(
  env: DeskEnv,
  source: DeskSource,
  now = Date.now(),
): Promise<{ measured: number; skipped: number }> {
  if (!source.since) return { measured: 0, skipped: 0 };

  const rows = await db(env).all<{ id: string; mint: string; ts: number; reason: string }>(
    "SELECT id, mint, ts, reason FROM desk_kills WHERE outcome='unknown' ORDER BY ts ASC LIMIT 200",
  );

  let measured = 0;
  let skipped = 0;
  for (const r of rows) {
    // Give the token time to reveal itself before judging the kill.
    if (now - r.ts * 1000 < 6 * 3600 * 1000) {
      skipped++;
      continue;
    }
    let hist: { highUsd: number; lowUsd: number; lastUsd: number; baseUsd?: number } | null = null;
    try {
      hist = await source.since(r.mint, r.ts);
    } catch {
      skipped++;
      continue;
    }
    if (!hist) {
      skipped++;
      continue;
    }
    /*
     * The base price a multiple is measured from.
     *
     * A source that knows the real pre-decision price supplies `baseUsd`; the
     * `desk_marks` series does, from the last mark at or before the kill.
     *
     * The fallback matters and used to be wrong. It was `hist.lowUsd`, and the
     * comment justified it as conservative "because a low base makes a 3x harder to
     * claim". That reasoning is backwards for this source: `lowUsd` is the low OF
     * THE FORWARD WINDOW, so dividing the forward high by it reports 1.6x for a
     * token that actually went 3.2x. The old choice did not make the 3x harder to
     * claim - it made every false negative systematically harder to see, which
     * flatters the filter, the exact opposite of the intent. Measured on a fixture
     * where the honest answer is 3.2x, it returned 1.6x and classified a genuine
     * miss as a dodge.
     *
     * So: use `baseUsd` when given; otherwise fall back to the LOWEST price
     * observed in the window, but note in the outcome that the base was inferred.
     * We never widen the window or guess a base that was not observed.
     */
    const base = hist.baseUsd !== undefined && hist.baseUsd > 0 ? hist.baseUsd : hist.lowUsd;
    if (!(base > 0)) {
      skipped++;
      continue;
    }
    const highMultiple = hist.highUsd / base;
    const lowMultiple = hist.lowUsd / base;

    let outcome: 'dodged' | 'missed_3x' | 'missed_10x' = 'dodged';
    if (highMultiple >= 10) outcome = 'missed_10x';
    else if (highMultiple >= CALIBRATION.missPct) outcome = 'missed_3x';
    else if (lowMultiple > 1 - CALIBRATION.dodgePct) {
      // Never fell far enough to be a dodge and never ran: unjudgeable, leave it.
      skipped++;
      continue;
    }

    await db(env).run(
      'UPDATE desk_kills SET outcome=?, outcome_ts=?, outcome_price=? WHERE id=?',
      outcome,
      Math.floor(now / 1000),
      hist.lastUsd,
      r.id,
    );
    measured++;
  }
  return { measured, skipped };
}

/** Build the calibration report from whatever is in desk_kills. Pure read. */
export async function buildCalibration(
  env: DeskEnv,
  now = Date.now(),
): Promise<CalibrationReport> {
  const windowEnd = Math.floor(now / 1000);
  const windowStart = windowEnd - Math.floor(CALIBRATION.lookbackMs / 1000);

  const rows = await db(env).all<{
    reason: string;
    kills: number;
    dodged: number;
    missed_3x: number;
    missed_10x: number;
    unknown: number;
  }>(
    `SELECT reason,
            COUNT(*) AS kills,
            SUM(CASE WHEN outcome='dodged' THEN 1 ELSE 0 END) AS dodged,
            SUM(CASE WHEN outcome='missed_3x' THEN 1 ELSE 0 END) AS missed_3x,
            SUM(CASE WHEN outcome='missed_10x' THEN 1 ELSE 0 END) AS missed_10x,
            SUM(CASE WHEN outcome='unknown' THEN 1 ELSE 0 END) AS unknown
     FROM desk_kills WHERE ts >= ? GROUP BY reason`,
    windowStart,
  );

  const out: CalibrationRow[] = [];
  let tKills = 0;
  let tMeasured = 0;
  let tTp = 0;
  let tFn = 0;

  for (const r of rows) {
    const kills = r.kills ?? 0;
    const dodged = r.dodged ?? 0;
    const missed = (r.missed_3x ?? 0) + (r.missed_10x ?? 0);
    const unknown = r.unknown ?? 0;
    const measured = kills - unknown;

    tKills += kills;
    tMeasured += measured;
    tTp += dodged;
    tFn += missed;

    out.push({
      reason_code: r.reason,
      description: REASON_TEXT[r.reason as KillReason] ?? 'unrecognised reason code',
      kills,
      measured,
      true_positives: dodged,
      false_negatives: missed,
      dodge_rate: measured >= MIN_SAMPLE ? Number((dodged / measured).toFixed(3)) : null,
      false_negative_rate: measured >= MIN_SAMPLE ? Number((missed / measured).toFixed(3)) : null,
      thin: measured < MIN_SAMPLE,
    });
  }

  // Worst false-negative rate first: that is the list of gates to reconsider.
  out.sort((a, b) => {
    const af = a.false_negative_rate ?? -1;
    const bf = b.false_negative_rate ?? -1;
    return bf - af || b.kills - a.kills;
  });

  const unmeasured = tKills - tMeasured;
  const note =
    tMeasured === 0
      ? 'no measured kills yet — outcomes need a price-history source (DeskSource.since) and 6h of distance'
      : `${tMeasured}/${tKills} kills measured; ${unmeasured} still unknown. Rows with fewer than ${MIN_SAMPLE} measured kills show no rate.`;

  return {
    ts: windowEnd,
    window_start: windowStart,
    window_end: windowEnd,
    rows: out,
    totals: {
      kills: tKills,
      measured: tMeasured,
      true_positives: tTp,
      false_negatives: tFn,
      unmeasured,
    },
    note,
    haircut: await haircutTotals(env),
    marks: await markCoverage(env),
    flow: await flowCoverage(env),
  };
}

/** Persist a report so /api/desk/calib can serve the last one without recomputing. */
export async function saveCalibration(env: DeskEnv, report: CalibrationReport): Promise<string> {
  const id = newId('calib');
  await db(env).run(
    `INSERT INTO desk_calibration (id, ts, window_start, window_end, rows, totals, note)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    report.ts,
    report.window_start,
    report.window_end,
    JSON.stringify(report.rows),
    JSON.stringify(report.totals),
    report.note,
  );
  return id;
}

/** The label used by /calib and the API: newest stored, else build live. */
export async function latestCalibration(
  env: DeskEnv,
  now = Date.now(),
): Promise<{ stored: boolean; report: CalibrationReport; id?: string }> {
  const row = await db(env).first<{
    id: string;
    ts: number;
    window_start: number;
    window_end: number;
    rows: string;
    totals: string;
    note: string;
  }>('SELECT id, ts, window_start, window_end, rows, totals, note FROM desk_calibration ORDER BY ts DESC LIMIT 1');

  if (!row) {
    return { stored: false, report: await buildCalibration(env, now) };
  }
  return {
    stored: true,
    id: row.id,
    report: {
      ts: row.ts,
      window_start: row.window_start,
      window_end: row.window_end,
      rows: JSON.parse(row.rows) as CalibrationRow[],
      totals: JSON.parse(row.totals) as CalibrationReport['totals'],
      note: row.note,
    },
  };
}

/**
 * Record one kill. Called by the filter stage; kept here so writes to desk_kills
 * happen in one place and every row gets the same shape.
 */
export async function recordKill(
  env: DeskEnv,
  args: {
    mint: string;
    symbol: string;
    reason: KillReason;
    detail: string;
    snapshot: unknown;
    now?: number;
  },
): Promise<string> {
  const id = newId('kill');
  await db(env).run(
    `INSERT INTO desk_kills (id, mint, symbol, ts, reason, detail, snapshot, outcome)
     VALUES (?,?,?,?,?,?,?,'unknown')`,
    id,
    args.mint,
    args.symbol,
    Math.floor((args.now ?? Date.now()) / 1000),
    args.reason,
    args.detail,
    JSON.stringify(args.snapshot ?? {}),
  );
  return id;
}

/**
 * Record an exit. Writes the closed position, the sell fill, and the audit line.
 *
 * The `why` is stored on the position (exit_reason + a sentence in the ledger
 * line) rather than only messaged, so "why did you kill this" is answerable
 * weeks later from the database.
 */
export async function recordExit(
  env: DeskEnv,
  args: {
    positionId: string;
    mint: string;
    reason: ExitReason;
    detail: string;
    entryUsd: number;
    exitUsd: number;
    feeUsd: number;
    pnlUsd: number;
    pnlPct: number;
    exitPrice: number;
    qty: number;
    now?: number;
  },
): Promise<void> {
  const now = Math.floor((args.now ?? Date.now()) / 1000);
  await db(env).run(
    `UPDATE desk_positions
     SET state='closed', closed_at=?, exit_price=?, exit_reason=?, pnl_usd=?, pnl_pct=?
     WHERE id=?`,
    now,
    args.exitPrice,
    args.reason,
    args.pnlUsd,
    args.pnlPct,
    args.positionId,
  );
  await db(env).run(
    `INSERT INTO desk_fills
     (id, position_id, mint, ts, side, tranche, qty, price, notional_usd,
      lp_fee_usd, prio_fee_usd, slippage_usd, price_impact, mode)
     VALUES (?,?,?,?,'sell',?,?,?,?,?,0,0,0,'paper')`,
    newId('fill'),
    args.positionId,
    args.mint,
    now,
    args.reason === 'stop_hard' || args.reason === 'trail_stop' ? 'stop' : 'exit',
    args.qty,
    args.exitPrice,
    args.exitUsd,
    args.feeUsd,
  );
}

/** Human sentence for an exit reason, for cards and stored details. */
export function exitText(reason: ExitReason): string {
  return EXIT_TEXT[reason] ?? reason;
}

/**
 * What the execution haircut actually cost, across every recorded fill.
 *
 * Read from `desk_fill_costs`, not from the environment: the point is to report
 * what was CHARGED, and a config value that nothing applied would otherwise look
 * identical to one that was applied everywhere.
 */
export async function haircutTotals(env: DeskEnv): Promise<{
  mev_bps: number;
  failed_tx_bps: number;
  total_bps: number;
  charged_usd: number;
  fills: number;
  source: 'constant' | 'env';
}> {
  const { haircutFrom } = await import('./paper.js');
  const cfg = haircutFrom({
    DESK_MEV_HAIRCUT_BPS: env.DESK_MEV_HAIRCUT_BPS,
    DESK_FAILED_TX_BPS: env.DESK_FAILED_TX_BPS,
  });
  const row = await db(env).first<{ n: number; charged: number | null }>(
    'SELECT COUNT(*) AS n, SUM(haircut_total_usd) AS charged FROM desk_fill_costs',
  );
  return {
    mev_bps: cfg.mevBps,
    failed_tx_bps: cfg.failedTxBps,
    total_bps: cfg.totalBps,
    charged_usd: Number((row?.charged ?? 0).toFixed(2)),
    fills: row?.n ?? 0,
    source: cfg.source,
  };
}

/** Coverage of the forward price series. `span_hours` is the honest age. */
export async function markCoverage(env: DeskEnv): Promise<{
  marks: number;
  mints: number;
  span_hours: number;
  dense_mints: number;
}> {
  const { markStats } = await import('./marks.js');
  const s = await markStats(env);
  return { marks: s.marks, mints: s.mints, span_hours: s.span_hours, dense_mints: s.dense_mints };
}

/** Coverage of the flow cache: how many tokens have a sampled answer. */
export async function flowCoverage(env: DeskEnv): Promise<{
  source: string;
  cached_mints: number;
  newest_ts: number | null;
}> {
  const { flowCacheStats, FLOW_SOURCE_ID } = await import('./flow.js');
  const s = await flowCacheStats(env);
  return { source: FLOW_SOURCE_ID, cached_mints: s.rows, newest_ts: s.newest_ts };
}

/**
 * Record the execution haircut charged on one fill.
 *
 * Written to its own table rather than columns on `desk_fills` so that no
 * existing table's meaning changes. A row here is a fact about what the paper
 * model charged, which is what lets `/calib` print a charged number next to the
 * configured one instead of only what somebody intended.
 */
export async function recordHaircut(
  env: DeskEnv,
  args: {
    positionId: string;
    mint: string;
    side: 'buy' | 'sell';
    notionalUsd: number;
    mevBps: number;
    failedTxBps: number;
    mevUsd: number;
    failedTxUsd: number;
    now?: number;
  },
): Promise<string> {
  const id = newId('cost');
  await db(env).run(
    `INSERT INTO desk_fill_costs
     (id, position_id, mint, ts, side, notional_usd, mev_bps, failed_tx_bps,
      mev_usd, failed_tx_usd, haircut_total_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    args.positionId,
    args.mint,
    Math.floor((args.now ?? Date.now()) / 1000),
    args.side,
    args.notionalUsd,
    args.mevBps,
    args.failedTxBps,
    args.mevUsd,
    args.failedTxUsd,
    args.mevUsd + args.failedTxUsd,
  );
  return id;
}
