/**
 * Risk — exits.
 *
 * This is the only module that closes a position, and the ordering in
 * `assess()` is a safety ordering, not a preference:
 *
 *   1. **liquidity decay** and **dev sell** are *immediate* kills. They are
 *      checked before the PnL comparison because they are rug precursors: when
 *      liquidity is being pulled, waiting for the stop to be hit means waiting
 *      for the price to gap through it. "Exit immediately regardless of PnL"
 *      only means something if it is evaluated before PnL.
 *   2. **hard stop** — max(-6%, -1.5x ATR14). The ATR leg is why the flat -6%
 *      is a floor and not the rule: on a token with 6% ATR a -6% stop is one
 *      candle of noise and it exits every winner before it can run.
 *   3. **trailing stop** — arms at +12%, trails 12% below peak, tightens to 6%
 *      after +40%.
 *   4. **time stop** — no +15% within 4h. A memecoin thesis decays fast; capital
 *      parked in a flat token is capital not in the next one, and the *reason*
 *      it is flat is usually that the thesis was wrong.
 *
 * Never average down is enforced structurally in executor.openPosition (one
 * open position per mint), not by a flag a caller could pass wrong.
 */

import { BREAKER, RISK, type Quote } from './types.js';
import type { ExitReason } from './reasons.js';

export interface OpenPositionState {
  id: string;
  mint: string;
  entryPrice: number;
  confirmationPrice: number | null;
  sizeUsd: number;
  filledUsd: number;
  qty: number;
  stopPrice: number;
  peakPrice: number;
  trailArmed: boolean;
  trailPct: number;
  atr14: number;
  liqAtEntry: number;
  openedAt: number;
}

export interface ExitDecision {
  exit: boolean;
  reason: ExitReason | null;
  detail: string;
  /** Price to fill at, from the quote. Null when not exiting. */
  priceUsd: number | null;
  /** Trailing fields to persist when the position keeps running. */
  peakPrice: number;
  trailArmed: boolean;
  trailPct: number;
  pnlPct: number;
}

/** The hard stop as a price. max(-6%, -1.5x ATR14) means the *lower* of the two. */
export function hardStopPrice(entryPrice: number, atr14Pct: number): number {
  const atrFrac = atr14Pct > 0 ? (atr14Pct / 100) * RISK.atrStopMultiple : 0;
  const stopFrac = Math.max(RISK.hardStopPct, atrFrac); // deeper stop wins
  return entryPrice * (1 - stopFrac);
}

/**
 * Trailing stop parameters for the current peak gain.
 *
 * The tighten step is keyed off peak gain, not current gain, so a position that
 * touched +40% keeps the tight trail even after it pulls back. Using current
 * gain would loosen the trail exactly on the way down, which is backwards.
 */
export function trailParams(peakGainPct: number): { armed: boolean; trailPct: number } {
  if (peakGainPct >= RISK.tightenAfterPct) return { armed: true, trailPct: RISK.trailTightPct };
  if (peakGainPct >= RISK.trailArmPct) return { armed: true, trailPct: RISK.trailPct };
  return { armed: false, trailPct: RISK.trailPct };
}

/**
 * Decide whether to exit, and update the trailing state either way.
 *
 * Pure: it never writes. The caller persists, which keeps this testable without
 * a database and keeps the exit decision reproducible for the same inputs.
 */
export function assess(pos: OpenPositionState, q: Quote, nowMs: number): ExitDecision {
  const price = q.priceUsd;
  // Average entry across both tranches when the confirmation half filled.
  const entry =
    pos.confirmationPrice !== null && pos.qty > 0
      ? (pos.entryPrice + pos.confirmationPrice) / 2
      : pos.entryPrice;

  const pnlPct = entry > 0 ? (price - entry) / entry : 0;
  const peak = Math.max(pos.peakPrice, price);
  const peakGainPct = entry > 0 ? (peak - entry) / entry : 0;
  const trail = trailParams(peakGainPct);

  const keep = (reason: ExitReason | null, detail: string): ExitDecision => ({
    exit: reason !== null,
    reason,
    detail,
    priceUsd: reason !== null ? price : null,
    peakPrice: peak,
    trailArmed: trail.armed,
    trailPct: trail.trailPct,
    pnlPct,
  });

  // ── 1. immediate kills, before any PnL comparison ──────────────────────
  if (pos.liqAtEntry > 0 && q.liqUsd < pos.liqAtEntry * (1 - RISK.liqDecayPct)) {
    return keep(
      'liq_decay',
      `liquidity ${q.liqUsd.toFixed(0)} fell ${(((pos.liqAtEntry - q.liqUsd) / pos.liqAtEntry) * 100).toFixed(1)}% from ${pos.liqAtEntry.toFixed(0)} at entry — rug precursor, exiting regardless of PnL`,
    );
  }

  if (q.devSold === true) {
    return keep('dev_sell', 'deployer wallet sold — exiting immediately');
  }

  // ── 2. hard stop ───────────────────────────────────────────────────────
  const stop = pos.stopPrice > 0 ? pos.stopPrice : hardStopPrice(entry, pos.atr14);
  if (price <= stop) {
    return keep(
      'stop_hard',
      `price ${price.toPrecision(6)} <= stop ${stop.toPrecision(6)} (max of -6% and -1.5x ATR14 ${pos.atr14.toFixed(2)}%)`,
    );
  }

  // ── 3. trailing stop ───────────────────────────────────────────────────
  if (trail.armed) {
    const trailPrice = peak * (1 - trail.trailPct);
    if (price <= trailPrice) {
      return keep(
        'trail_stop',
        `peak ${peak.toPrecision(6)} (${(peakGainPct * 100).toFixed(1)}% gain), price ${price.toPrecision(6)} fell through ${(trail.trailPct * 100).toFixed(0)}% trail`,
      );
    }
  }

  // ── 4. time stop ───────────────────────────────────────────────────────
  const ageSeconds = (nowMs - pos.openedAt) / 1000;
  if (ageSeconds >= RISK.timeStopSeconds && peakGainPct < RISK.timeStopTargetPct) {
    return keep(
      'time_stop',
      `${(ageSeconds / 3600).toFixed(1)}h elapsed, best gain ${(peakGainPct * 100).toFixed(1)}% < 15% — thesis decayed`,
    );
  }

  // Not exiting, but the trailing state may have advanced.
  return keep(null, `holding: ${(pnlPct * 100).toFixed(2)}% vs entry, peak gain ${(peakGainPct * 100).toFixed(1)}%`);
}

/**
 * Whether a daily loss figure trips the circuit breaker.
 *
 * The denominator is equity **at the start of the day**, not current equity.
 * This matters and is easy to get wrong: dividing today's loss by the
 * post-loss book makes a 7.9% loss read as 8.6% (because the book shrank), so
 * the breaker fires early and the operator cannot reproduce the arithmetic from
 * their own statement. Measuring against the opening book makes "-8%" mean what
 * it says.
 */
export function breakerTripped(equityNowUsd: number, todayPnlUsd: number): boolean {
  if (todayPnlUsd >= 0) return false;
  const opening = equityNowUsd - todayPnlUsd;
  if (!(opening > 0)) return false;
  return -todayPnlUsd / opening >= BREAKER.lossPct;
}

/** Realized PnL for one closed position, in USD and as a fraction of size. */
export function realizedPnl(args: {
  entryUsd: number;
  exitUsd: number;
  qty: number;
  /** Total modelled cost (lp fee + prio fee), already in USD. */
  feeUsd: number;
}): { pnlUsd: number; pnlPct: number } {
  const gross = args.exitUsd - args.entryUsd;
  const pnlUsd = gross - args.feeUsd;
  const pnlPct = args.entryUsd > 0 ? pnlUsd / args.entryUsd : 0;
  return { pnlUsd: Number(pnlUsd.toFixed(4)), pnlPct: Number(pnlPct.toFixed(6)) };
}
