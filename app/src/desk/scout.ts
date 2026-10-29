/**
 * Scout — the universe.
 *
 * Coarse gates only. Scout's job is to throw away the obviously-wrong and hand
 * the rest to Filter, which is where the expensive per-token RPC reads happen.
 *
 * The one design decision worth stating: liquidity is gated as a RATIO, not an
 * absolute floor. A $40k floor is a real filter on a $300k token and means
 * nothing on a $20M one — 0.2% of mcap in the pool means the first meaningful
 * sell moves the price and the position can never exit. So the gate is
 * `liq >= max($40k, 3% of mcap)`.
 */

import type { KillReason } from './reasons.js';
import { usd } from './reasons.js';
import { SCOUT, type MarketSnapshot } from './types.js';

export interface ScoutDecision {
  keep: boolean;
  reason?: KillReason;
  detail?: string;
}

/** Required pool liquidity for a given market cap. */
export function requiredLiquidity(mcapUsd: number): number {
  return Math.max(SCOUT.minLiqUsd, mcapUsd * SCOUT.minLiqRatioOfMcap);
}

export function liquidityOk(mcapUsd: number, liqUsd: number): boolean {
  return liqUsd >= requiredLiquidity(mcapUsd);
}

/**
 * Age of the pair in seconds. Uses the pair's own creation time, not our first
 * sighting: a token first seen by us an hour ago may be three days old, and the
 * "30m-72h" band is about the token's life, not our coverage of it.
 */
export function pairAgeSeconds(m: MarketSnapshot, nowMs: number): number {
  return (nowMs - m.pairCreatedAtMs) / 1000;
}

export function scout(m: MarketSnapshot, holders: number | null, nowMs: number): ScoutDecision {
  const age = pairAgeSeconds(m, nowMs);
  if (!(age >= SCOUT.minAgeSeconds)) {
    return { keep: false, reason: 'age_out_of_band', detail: `pair age ${Math.round(age / 60)}m < 30m` };
  }
  if (age > SCOUT.maxAgeSeconds) {
    return {
      keep: false,
      reason: 'age_out_of_band',
      detail: `pair age ${(age / 3600).toFixed(1)}h > 72h`,
    };
  }
  if (m.mcapUsd < SCOUT.minMcapUsd || m.mcapUsd > SCOUT.maxMcapUsd) {
    return {
      keep: false,
      reason: 'mcap_out_of_band',
      detail: `mcap ${usd(m.mcapUsd)} outside $300k-$20M`,
    };
  }
  // Unknown holder count is not "enough holders".
  if (holders === null || holders < SCOUT.minHolders) {
    return {
      keep: false,
      reason: 'holders_too_few',
      detail: holders === null ? 'holder count unavailable' : `${holders} holders < 300`,
    };
  }
  if (!liquidityOk(m.mcapUsd, m.liqUsd)) {
    return {
      keep: false,
      reason: 'liq_below_ratio_gate',
      detail: `liq ${usd(m.liqUsd)} < required ${usd(requiredLiquidity(m.mcapUsd))} (max of $40k, 3% of mcap)`,
    };
  }
  return { keep: true };
}
