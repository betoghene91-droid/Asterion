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
    let hist: { highUsd: number; lowUsd: number; lastUsd: number } | null = null;
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
    // We do not know the price at kill time from the history source, so use the
    // low as the base: this is the conservative choice for a *dodge* judgement
    // (a low base makes a 3x harder to claim, so we do not flatter the filter).
    const base = hist.lowUsd > 0 ? hist.lowUsd : 0;
    if (base <= 0) {
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
