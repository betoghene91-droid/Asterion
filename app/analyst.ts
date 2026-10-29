/**
 * Analyst — the 0-100 score.
 *
 * The pass rule is a conjunction, and that is the whole design:
 *
 *     pass  =  total >= 70  AND  no component below its floor
 *
 * A plain weighted sum is trivially gamed by one extreme metric: a token with a
 * spectacular 1h pump but no unique buyers, no holders and no liquidity scores
 * 20/20 on momentum, clears 70 on momentum plus the two free-ish components, and
 * gets bought. The floors make each component carry a minimum of its own, so a
 * 70 has to be assembled from *seven* acceptable answers rather than one hero
 * number.
 *
 * The LLM boundary is structural, not conventional: this function takes numbers
 * and returns numbers. It has no access to `ask()` and its output is what gets
 * written to desk_scores. Thesis prose is generated separately in thesis.ts and
 * cannot return a score or a size, because its return type is a string.
 */

import type { AnalystComponent } from './types.js';
import { ANALYST, type HolderSnapshot, type MarketSnapshot, type SafetySnapshot } from './types.js';

export interface SubScore {
  raw: string;
  score: number;
  floor: number;
  weight: number;
  /** Weighted contribution: score / 100 * weight. */
  contribution: number;
}

export interface AnalysisInput {
  market: MarketSnapshot;
  holders: HolderSnapshot;
  safety: SafetySnapshot;
  /** True when the filter already passed; residual safety scores what is left. */
  filterPassed: boolean;
}

export interface Analysis {
  total: number;
  passed: boolean;
  subscores: Record<AnalystComponent, SubScore>;
  floorFailed: AnalystComponent[];
  why: string;
}

/** Clamp helper: every component returns 0..100 regardless of input. */
function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Momentum / acceleration, 0-100.
 *
 * Scored on two horizons on purpose: 1h alone rewards a single candle, while
 * 1h *and* 6h both positive means the move has lasted. A token falling over 6h
 * but up over 1h scores low here even though its 1h number is green.
 */
function momentumScore(m: MarketSnapshot): { score: number; raw: string } {
  const h1 = m.change1hPct ?? null;
  const h6 = m.change6hPct ?? null;
  if (h1 === null) return { score: 0, raw: '1h change unavailable' };

  // 1h leg: 0% -> 30, +25% -> 70, +60% -> 100. Above +80% starts losing points
  // because the late-entry gate should have caught it and vertical moves mean
  // revert is the base case.
  let s1: number;
  if (h1 <= 0) s1 = clamp100(30 + h1 * 1.2); // falling: 0% -> 30, -25% -> 0
  else if (h1 <= 60) s1 = 30 + (h1 / 60) * 70;
  else s1 = clamp100(100 - (h1 - 60) * 0.5);

  // 6h leg confirms or denies the 1h move. Absent data is neutral (50), not
  // bullish: refusing to guess is cheaper than a wrong pass.
  const s6 = h6 === null ? 50 : clamp100(50 + h6 * 1.0);

  const score = clamp100(s1 * 0.65 + s6 * 0.35);
  return {
    score,
    raw: `1h ${h1.toFixed(1)}% / 6h ${h6 === null ? 'n/a' : `${h6.toFixed(1)}%`}`,
  };
}

/** Unique-buyer growth: 0% -> 0, 50% -> 100. Negative growth scores 0. */
function uniqueBuyerScore(h: HolderSnapshot): { score: number; raw: string } {
  const g = h.uniqueBuyerGrowthPct;
  if (g === null) return { score: 0, raw: 'buyer growth unavailable' };
  return { score: clamp100((g / 50) * 100), raw: `${g.toFixed(1)}% growth` };
}

/**
 * Buy pressure: ratio AND size skew.
 *
 * Ratio alone is spoofable — 200 buys of $5 against 50 sells of $4 is a 4:1
 * ratio and net-negative flow. Skew alone is noisy. Together, "more buyers than
 * sellers and the average buy is larger than the average sell" is a real signal.
 */
function buyPressureScore(h: HolderSnapshot): { score: number; raw: string } {
  const bv = h.buyVolumeUsd;
  const sv = h.sellVolumeUsd;
  if (bv === null || sv === null) return { score: 0, raw: 'volume split unavailable' };

  const ratio = sv > 0 ? bv / sv : bv > 0 ? 3 : 1;
  // 1:1 -> 40, 2:1 -> 80, 3:1+ -> 100, below 1:1 falls off fast.
  const ratioScore = clamp100(ratio >= 1 ? 40 + (ratio - 1) * 40 : ratio * 40);

  const avgBuy = h.avgBuyUsd;
  const medianBuy = h.medianBuyUsd;
  // avg >> median means a few whales did the buying; that is concentration, not
  // demand. Ideally we want avg near median.
  let skewScore = 50;
  let skewNote = 'skew n/a';
  if (avgBuy !== null && medianBuy !== null && medianBuy > 0) {
    const skew = avgBuy / medianBuy;
    // 1.0 -> 70, 1.5 -> 55, 3+ -> 10. Single-buyer-driven flow is penalised.
    skewScore = clamp100(70 - (skew - 1) * 30);
    skewNote = `avg/med ${skew.toFixed(2)}`;
  }

  return {
    score: clamp100(ratioScore * 0.7 + skewScore * 0.3),
    raw: `buy/sell ${ratio.toFixed(2)}x, ${skewNote}`,
  };
}

/** Holder growth. Unknown is 0, not neutral: an unmeasurable holder base is a risk. */
function holderGrowthScore(h: HolderSnapshot): { score: number; raw: string } {
  const growth = h.uniqueBuyerGrowthPct;
  const holders = h.holders;
  if (holders === null) return { score: 0, raw: 'holder count unavailable' };
  // Absolute base matters: 400 holders is the bottom of Scout's band, 5000 is
  // a real community. Combine the base with growth when growth is known.
  const baseScore = clamp100(((holders - 300) / 2700) * 100);
  if (growth === null) return { score: baseScore * 0.6, raw: `${holders} holders, growth n/a` };
  return {
    score: clamp100(baseScore * 0.5 + clamp100((growth / 40) * 100) * 0.5),
    raw: `${holders} holders, +${growth.toFixed(1)}%`,
  };
}

/** Liquidity quality: how deep is the pool relative to the cap we are buying into. */
function liqQualityScore(m: MarketSnapshot): { score: number; raw: string } {
  if (m.mcapUsd <= 0) return { score: 0, raw: 'mcap unavailable' };
  const ratio = m.liqUsd / m.mcapUsd;
  // 3% is Scout's floor -> 40. 8% -> 80. 15%+ -> 100.
  const depth = ratio <= 0.03 ? clamp100((ratio / 0.03) * 40) : clamp100(40 + ((ratio - 0.03) / 0.12) * 60);
  const volTurnover = m.liqUsd > 0 ? m.vol1hUsd / m.liqUsd : 0;
  // A pool that turns over 0.2-2x its own liquidity per hour is healthy; 5x is
  // churn and 0.02x is a dead pool.
  const turnoverScore = volTurnover > 5 ? 40 : volTurnover < 0.05 ? 20 : clamp100(50 + volTurnover * 25);

  /*
   * Turnover may confirm depth but may never substitute for it. A $40k pool with
   * $1.4M of hourly churn is not "quality liquidity" — it is a pool that churns
   * because nobody can hold a position in it, and scoring it as healthy is how a
   * thin token clears this floor on the strength of the very churn that makes it
   * untradeable. So the combined score is capped by the depth score when depth is
   * below Scout's 3% minimum.
   */
  const combined = clamp100(depth * 0.7 + turnoverScore * 0.3);
  const score = ratio < 0.03 ? Math.min(combined, depth) : combined;
  return {
    score,
    raw: `liq/mcap ${(ratio * 100).toFixed(1)}%, turnover ${volTurnover.toFixed(2)}x${ratio < 0.03 ? ' (depth-capped)' : ''}`,
  };
}

/**
 * Curated smart-wallet presence.
 *
 * An ABSENT wallet list is now treated as a coverage gap by the filter, not as a
 * score. Scoring it 0 was the worst of both worlds: it silently sank the total
 * for a reason the operator could not see, and it would have let a token pass on
 * the other six components while the desk pretended it had checked smart money.
 * So this component only ever scores real data; when there is none, the filter
 * refuses to judge the token at all.
 */
function smartWalletScore(h: HolderSnapshot): { score: number; raw: string } {
  const p = h.smartWalletPct;
  if (p === null) return { score: 0, raw: 'no smart-wallet data (curated list not configured)' };
  // 8% of supply across curated wallets is exceptional; ~2.4% hits the floor.
  return { score: clamp100((p / 8) * 100), raw: `${p.toFixed(2)}% of supply in curated wallets` };
}

/**
 * Residual contract safety: what is left after the filter's binary kills.
 *
 * Filter is pass/fail; this scores the margin. Revoked authorities and a clean
 * program score high; an unknown fact that did not kill still costs points,
 * because "we did not check" is not the same as "it is clean".
 */
function residualSafetyScore(s: SafetySnapshot, filterPassed: boolean): { score: number; raw: string } {
  if (!filterPassed) return { score: 0, raw: 'filter did not pass' };
  let score = 100;
  const notes: string[] = [];
  if (s.mintAuthorityRevoked !== true) {
    score -= 25;
    notes.push('mint authority not confirmed revoked');
  }
  if (s.freezeAuthorityRevoked !== true) {
    score -= 25;
    notes.push('freeze authority not confirmed revoked');
  }
  if (s.metadataMutable === null) {
    score -= 10;
    notes.push('metadata mutability unknown');
  }
  if (s.programUpgradeable === null) {
    score -= 10;
    notes.push('upgradeability unknown');
  }
  if (s.transferFeeBps !== null && s.transferFeeBps > 0) {
    score -= Math.min(20, s.transferFeeBps / 25);
    notes.push(`transfer fee ${s.transferFeeBps}bps`);
  }
  if (s.extensions.length > 0) {
    score -= 5;
    notes.push(`${s.extensions.length} extension(s)`);
  }
  return { score: clamp100(score), raw: notes.length ? notes.join('; ') : 'clean' };
}

export function analyze(input: AnalysisInput): Analysis {
  const { market, holders, safety, filterPassed } = input;

  const computed: Record<AnalystComponent, { score: number; raw: string }> = {
    momentum: momentumScore(market),
    uniqueBuyers: uniqueBuyerScore(holders),
    buyPressure: buyPressureScore(holders),
    holderGrowth: holderGrowthScore(holders),
    liqQuality: liqQualityScore(market),
    smartWallets: smartWalletScore(holders),
    residualSafety: residualSafetyScore(safety, filterPassed),
  };

  const subscores = {} as Record<AnalystComponent, SubScore>;
  let total = 0;
  const floorFailed: AnalystComponent[] = [];

  for (const key of Object.keys(ANALYST.weights) as AnalystComponent[]) {
    const weight = ANALYST.weights[key];
    const floor = ANALYST.floors[key];
    const c = computed[key];
    const contribution = (c.score / 100) * weight;
    total += contribution;
    subscores[key] = { raw: c.raw, score: Number(c.score.toFixed(2)), floor, weight, contribution: Number(contribution.toFixed(2)) };
    if (c.score < floor) floorFailed.push(key);
  }

  const rounded = Number(total.toFixed(2));
  const passed = rounded >= ANALYST.passTotal && floorFailed.length === 0;

  // `why` is stored, not just messaged. The desk writes it to desk_scores.why,
  // so /thesis and the calibration report can explain a decision after the fact
  // without re-running the scoring code against a dossier we no longer have.
  const parts = (Object.keys(subscores) as AnalystComponent[]).map(
    (k) => `${k} ${subscores[k].score.toFixed(0)}/${ANALYST.floors[k]}min`,
  );
  const verdict = passed
    ? `PASS ${rounded}/100`
    : floorFailed.length
      ? `REFUSE ${rounded}/100 — below floor: ${floorFailed.join(', ')}`
      : `REFUSE ${rounded}/100 — below ${ANALYST.passTotal}`;

  return {
    total: rounded,
    passed,
    subscores,
    floorFailed,
    why: `${verdict}. ${parts.join(', ')}.`,
  };
}
