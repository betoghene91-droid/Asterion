/**
 * The paper fill model.
 *
 * This file exists because a paper fill at an impossible price is worse than no
 * backtest: it teaches the operator that a strategy works when the only reason
 * it "worked" is that the simulation ignored the cost of trading. So the model
 * has three properties, and each one is a refusal to be optimistic:
 *
 *  1. **Impact is computed, not assumed.** Constant-product impact from the real
 *     pool: `impact = size / (liq_side + size)` for one side of the book. Using
 *     the pool's own depth is the only way the number tracks the token instead
 *     of the strategy.
 *  2. **Caps are enforced, not warned about.** If modelled slippage exceeds the
 *     entry/exit cap, or the size would exceed 1% of pool liquidity, the fill is
 *     REFUSED and no position is opened. A model that fills anyway and reports
 *     "slippage was high" is a model that lies.
 *  3. **Every cost line is recorded separately.** LP fee, priority fee and
 *     slippage land in different columns of desk_fills, so the calibration
 *     report can say which cost is eating the edge rather than lumping them into
 *     one "fees" number that hides the answer.
 *
 * What is NOT modelled here (see DESK.md too):
 *   - The bonding-curve portion of a pump.fun token's life.
 *   - Price between quotes. We fill at the quoted price plus impact.
 *
 * ## MEV and failed transactions ARE now modelled, as a named haircut
 *
 * Earlier versions listed sandwich cost and failed-transaction cost as
 * unmodelled, which made every paper number structurally optimistic for exactly
 * the thin tokens most worth sandwiching. They are now charged explicitly on
 * every leg, entry and exit, from `EXECUTION_HAIRCUT` (default 60bps MEV + 40bps
 * failed-transaction, 100bps total) with per-deploy overrides
 * `DESK_MEV_HAIRCUT_BPS` / `DESK_FAILED_TX_BPS`.
 *
 * Two properties keep this honest rather than decorative:
 *  - It is **separate from slippage**. Impact already models moving the pool;
 *    the haircut models someone else moving it around us, plus the expected cost
 *    of a transaction that does not land. Conflating them would let a large
 *    impact cap hide MEV.
 *  - It is **recorded per fill** (`mev_usd`, `failed_tx_usd`) so calibration can
 *    say which assumption is eating the edge, and `/calib` prints both numbers.
 *    A haircut nobody can see is indistinguishable from no haircut.
 */

import { EXECUTION_HAIRCUT, SLIPPAGE, type MarketSnapshot } from './types.js';

export interface FillRequest {
  side: 'buy' | 'sell';
  /** Notional in USD. For a sell this is the mark value we are trying to exit. */
  notionalUsd: number;
  /** Quoted mid price, USD per token. */
  priceUsd: number;
  /** Pool liquidity in USD (both sides summed, as DexScreener reports it). */
  liqUsd: number;
  /** Pool fee in bps, from the pair. */
  feeBps: number;
  /** Priority fee we are willing to pay, USD. Capped by env. */
  priorityFeeUsd: number;
  /** Hard ceiling on the priority fee for one trade. */
  priorityFeeCapUsd: number;
  /** MEV/sandwich haircut in bps. Defaults to the named constant. */
  mevBps?: number;
  /** Failed-transaction/retry haircut in bps. Defaults to the named constant. */
  failedTxBps?: number;
}

export interface FillResult {
  filled: boolean;
  /** Why not, as a stable code. Null when filled. */
  refusal:
    | 'size_exceeds_pool_share'
    | 'slippage_cap_exceeded_entry'
    | 'slippage_cap_exceeded_exit'
    | 'priority_fee_cap_exceeded'
    | null;
  detail: string;
  /** Execution price after impact and fees, USD per token. */
  priceUsd: number;
  qty: number;
  notionalUsd: number;
  lpFeeUsd: number;
  prioFeeUsd: number;
  slippageUsd: number;
  /** Fraction. Reported separately from the USD cost so bps can be compared to caps. */
  priceImpact: number;
  /** MEV/sandwich cost charged on this leg, USD. */
  mevUsd: number;
  /** Failed-transaction/retry cost charged on this leg, USD. */
  failedTxUsd: number;
  /** The haircut in bps that was actually applied, for the record. */
  haircutBps: number;
}

/**
 * One-sided constant-product impact.
 *
 * `liqUsd` from DexScreener is the value of both sides of the pool combined, so
 * the side we trade against is roughly half. `x` is therefore liqUsd/2 in USD
 * terms and impact is `size / (x + size)` — the same expression as the
 * constant-product formula to first order, in the units we actually have.
 *
 * This underestimates impact for a sell of a large share of supply (the price
 * moves as we sell, so the average fill is worse than the impact at the first
 * unit), which is one more reason the 1% pool-share cap is a hard refusal rather
 * than a soft warning: past that point this model stops being trustworthy.
 */
export function priceImpactOf(notionalUsd: number, liqUsd: number): number {
  const side = Math.max(liqUsd / 2, 1);
  return notionalUsd / (side + notionalUsd);
}

/**
 * Simulate one leg.
 *
 * Order of checks matters. Pool share first: it is a structural refusal that no
 * slippage tolerance can rescue. Then the fee cap. Then impact vs the side's cap.
 */
export function simulateFill(req: FillRequest): FillResult {
  const { side, notionalUsd, priceUsd, liqUsd, feeBps } = req;
  const reject = (refusal: FillResult['refusal'], detail: string): FillResult => ({
    filled: false,
    refusal,
    detail,
    priceUsd,
    qty: 0,
    notionalUsd: 0,
    lpFeeUsd: 0,
    prioFeeUsd: 0,
    slippageUsd: 0,
    priceImpact: 0,
    mevUsd: 0,
    failedTxUsd: 0,
    haircutBps: 0,
  });

  if (!(notionalUsd > 0) || !(priceUsd > 0) || !(liqUsd > 0)) {
    return reject('size_exceeds_pool_share', 'invalid fill inputs (non-positive size, price or liquidity)');
  }

  const mevBps = req.mevBps ?? EXECUTION_HAIRCUT.mevBps;
  const failedTxBps = req.failedTxBps ?? EXECUTION_HAIRCUT.failedTxBps;
  const haircutBps = mevBps + failedTxBps;

  // ── 1% pool share: absolute refusal ────────────────────────────────────
  const poolShare = notionalUsd / liqUsd;
  if (poolShare > 0.01) {
    return reject(
      'size_exceeds_pool_share',
      `size $${notionalUsd.toFixed(0)} is ${(poolShare * 100).toFixed(2)}% of $${liqUsd.toFixed(0)} pool > 1% — we would be our own exit`,
    );
  }

  // ── priority fee cap ───────────────────────────────────────────────────
  if (req.priorityFeeUsd > req.priorityFeeCapUsd) {
    return reject(
      'priority_fee_cap_exceeded',
      `priority fee $${req.priorityFeeUsd.toFixed(4)} > cap $${req.priorityFeeCapUsd.toFixed(4)}`,
    );
  }

  const impact = priceImpactOf(notionalUsd, liqUsd);
  const impactBps = impact * 10_000;
  const capBps = side === 'buy' ? SLIPPAGE.entryBps : SLIPPAGE.exitBps;
  if (impactBps > capBps) {
    return reject(
      side === 'buy' ? 'slippage_cap_exceeded_entry' : 'slippage_cap_exceeded_exit',
      `modelled ${side} impact ${impactBps.toFixed(0)}bps > ${capBps}bps cap`,
    );
  }

  // Execution price: we buy higher and sell lower by the impact.
  const execPrice = side === 'buy' ? priceUsd * (1 + impact) : priceUsd * (1 - impact);

  // LP fee is charged on the notional, on both sides.
  const lpFeeUsd = notionalUsd * (feeBps / 10_000);
  // Slippage cost in USD is impact x notional (the difference between the quoted
  // and executed notional at the quoted price).
  const slippageUsd = notionalUsd * impact;
  // The execution haircut: MEV and the expected cost of a transaction that does
  // not land. Charged on the notional of every leg, in the pessimistic direction
  // on both sides — a sandwich costs us whether we are buying or selling.
  const mevUsd = notionalUsd * (mevBps / 10_000);
  const failedTxUsd = notionalUsd * (failedTxBps / 10_000);

  /*
   * On a buy the $notional is cash out, so fees come out of the cash and the
   * position gets slightly less than `notionalUsd` of token value. On a sell the
   * notional is token value in, so fees reduce the cash received. Both are
   * modelled as reducing `qty`-equivalent value rather than being silently
   * dropped.
   */
  const netValue = Math.max(notionalUsd - lpFeeUsd - req.priorityFeeUsd - mevUsd - failedTxUsd, 0);
  const qty = netValue / execPrice;

  return {
    filled: true,
    refusal: null,
    detail:
      `${side} ${notionalUsd.toFixed(0)} at ${execPrice.toPrecision(6)} ` +
      `(impact ${impactBps.toFixed(0)}bps, lp fee ${lpFeeUsd.toFixed(2)}, ` +
      `prio ${req.priorityFeeUsd.toFixed(4)}, ` +
      `haircut ${haircutBps}bps = ${(mevUsd + failedTxUsd).toFixed(2)})`,
    priceUsd: execPrice,
    qty,
    notionalUsd,
    lpFeeUsd,
    prioFeeUsd: req.priorityFeeUsd,
    slippageUsd,
    priceImpact: impact,
    mevUsd,
    failedTxUsd,
    haircutBps,
  };
}

/** Convenience: the pool fee for a pair, defaulting to 30bps (Raydium AMM v4). */
export function feeBpsOf(m: Pick<MarketSnapshot, 'feeBps'>): number {
  return Number.isFinite(m.feeBps) && m.feeBps > 0 ? m.feeBps : 30;
}

/**
 * Resolve the haircut for one deploy from the environment.
 *
 * Kept here rather than inlined at every call site so there is exactly one
 * definition of "what the haircut is" per deployment, and so `/calib` can print
 * the same numbers the fill model charged.
 */
export function haircutFrom(env: { DESK_MEV_HAIRCUT_BPS?: string; DESK_FAILED_TX_BPS?: string; [key: string]: unknown }): {
  mevBps: number;
  failedTxBps: number;
  totalBps: number;
  source: 'constant' | 'env';
} {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const hasEnv = env.DESK_MEV_HAIRCUT_BPS !== undefined || env.DESK_FAILED_TX_BPS !== undefined;
  const mevBps = num(env.DESK_MEV_HAIRCUT_BPS, EXECUTION_HAIRCUT.mevBps);
  const failedTxBps = num(env.DESK_FAILED_TX_BPS, EXECUTION_HAIRCUT.failedTxBps);
  return {
    mevBps,
    failedTxBps,
    totalBps: mevBps + failedTxBps,
    source: hasEnv ? 'env' : 'constant',
  };
}
