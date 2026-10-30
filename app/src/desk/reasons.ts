/**
 * Stable reason codes.
 *
 * These strings are the primary key of the calibration report, so they are
 * versioned by addition only: renaming one silently resets its hit-rate
 * history. Every kill, every exit and every refusal carries one.
 *
 * The ordering in REASON_ORDER is load-bearing. A token usually fails several
 * gates at once; evaluating in a fixed order makes the primary reason
 * deterministic, which is what makes the tests and the calibration stable.
 */

import type { MarketSnapshot, TokenDossier } from './types.js';

export type KillReason =
  // scout (coarse) gates
  | 'age_out_of_band'
  | 'mcap_out_of_band'
  | 'holders_too_few'
  // filter gates, in evaluation order
  | 'freeze_authority_live'
  | 'mint_authority_live'
  | 'token2022_dangerous_extension'
  | 'metadata_mutable_upgradeable'
  | 'safety_data_unknown'
  | 'honeypot_sell_reverts'
  | 'honeypot_impact_exceeded'
  | 'lp_unlocked'
  | 'liq_below_ratio_gate'
  | 'volume_1h_low'
  | 'top10_concentrated'
  | 'dev_prior_rug'
  | 'dev_holding'
  | 'bundled_launch'
  | 'sniper_concentration'
  | 'wash_trading'
  | 'dev_cluster'
  | 'late_entry';

export type ExitReason =
  | 'stop_hard'
  | 'trail_stop'
  | 'time_stop'
  | 'liq_decay'
  | 'dev_sell'
  /**
   * The position returned a multiple of its entry inside the window. This is the
   * ONLY honest way a false negative gets recorded without a backtest: until the
   * desk sampled its own forward marks, a killed token's aftermath was
   * unmeasurable and every reason printed "unmeasured".
   */
  | 'take_profit';

/** Executor refusals are not kills: nothing was wrong with the token. */
export type RefusalReason =
  | 'circuit_breaker_halted'
  | 'max_concurrent_positions'
  | 'max_deployed'
  | 'size_exceeds_pool_share'
  | 'size_below_minimum'
  | 'slippage_cap_exceeded_entry'
  | 'slippage_cap_exceeded_exit'
  | 'priority_fee_cap_exceeded'
  | 'never_average_down'
  | 'live_signer_not_wired'
  | 'not_armed';

/**
 * The order `filter.evaluate()` walks. Freeze authority comes first because it
 * is the classic honeypot vector: a live freeze authority means the deployer can
 * prevent every holder but itself from selling, and no amount of momentum
 * compensates for that.
 */
export const REASON_ORDER: KillReason[] = [
  'freeze_authority_live',
  'mint_authority_live',
  'token2022_dangerous_extension',
  'metadata_mutable_upgradeable',
  'safety_data_unknown',
  'honeypot_sell_reverts',
  'honeypot_impact_exceeded',
  'lp_unlocked',
  'liq_below_ratio_gate',
  'volume_1h_low',
  'top10_concentrated',
  'dev_prior_rug',
  'dev_holding',
  'bundled_launch',
  'sniper_concentration',
  'wash_trading',
  'dev_cluster',
  'late_entry',
];

/** Why each code exists, in one line, for /kills and TRADING.md. */
export const REASON_TEXT: Record<KillReason, string> = {
  age_out_of_band: 'pair is younger than 30m or older than 72h',
  mcap_out_of_band: 'market cap outside $300k-$20M',
  holders_too_few: 'fewer than 300 holders',
  freeze_authority_live:
    'freeze authority not revoked — deployer can block every external seller (honeypot vector)',
  mint_authority_live: 'mint authority not revoked — supply can be inflated at will',
  token2022_dangerous_extension:
    'Token-2022 extension present that can tax, block or hijack transfers',
  metadata_mutable_upgradeable:
    'metadata mutable and program upgradeable — name/symbol and logic can change after purchase',
  safety_data_unknown:
    'a contract-safety fact could not be read; treated as unsafe rather than assumed safe',
  honeypot_sell_reverts: 'simulated sell of the proposed size reverts',
  honeypot_impact_exceeded: 'simulated sell of the proposed size costs more than 15% price impact',
  lp_unlocked: 'LP not burned, or locked for less than 30 more days',
  liq_below_ratio_gate: 'liquidity below max($40k, 3% of market cap)',
  volume_1h_low: '1h volume below $50k — no exit liquidity',
  top10_concentrated:
    'top-10 holders above 25% after excluding pool, burn and known CEX wallets',
  dev_prior_rug: 'dev wallet has a prior rug in its funding-graph history',
  dev_holding: 'dev/deployer holds more than 3% of supply',
  bundled_launch: 'more than 10% of supply bought in one slot by one funder',
  sniper_concentration: 'first-20-buyer cohort holds more than 30% of supply',
  wash_trading: 'unique buyers / total buys below 0.35 — volume is not real demand',
  dev_cluster: 'wallets funded from the deployer tree hold more than 15%',
  late_entry: 'price above 3.5x the 24h low or 1.8x the 6h low — entry is a chase',
};

export const EXIT_TEXT: Record<ExitReason, string> = {
  stop_hard: 'hard stop hit: max(-6%, -1.5x ATR14)',
  trail_stop: 'trailing stop hit',
  time_stop: 'no +15% within 4h — memecoin thesis decayed',
  liq_decay: 'pool liquidity fell more than 25% — rug precursor',
  dev_sell: 'dev/deployer wallet sold',
  take_profit: 'position returned a multiple of entry inside the window',
};

export const REFUSAL_TEXT: Record<RefusalReason, string> = {
  circuit_breaker_halted: 'daily loss circuit breaker is active; no override path exists',
  max_concurrent_positions: 'already at 3 concurrent positions',
  max_deployed: 'would exceed 24% of realized equity deployed',
  size_exceeds_pool_share: 'position would exceed 1% of pool liquidity — we would be our own exit',
  size_below_minimum: 'sized position is below the minimum lot',
  slippage_cap_exceeded_entry: 'modelled entry slippage exceeds 200bps',
  slippage_cap_exceeded_exit: 'modelled exit slippage exceeds 500bps',
  priority_fee_cap_exceeded: 'priority fee would exceed the per-trade cap',
  never_average_down: 'never average down',
  live_signer_not_wired: 'live order submission is not implemented in this build',
  not_armed: 'live mode is not armed: one or more arming gates are unmet',
};

/** One kill finding: the code plus the sentence a human reads. */
export interface KillFinding {
  reason: KillReason;
  detail: string;
}

/** Convenience for `detail` strings: keeps numbers formatted the same way. */
export function pct(n: number, digits = 2): string {
  return `${n.toFixed(digits)}%`;
}

export function usd(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/** Shape handed to the snapshot column. Full input, not a summary. */
export function snapshotOf(d: TokenDossier): Record<string, unknown> {
  return {
    market: d.market,
    safety: d.safety,
    holders: d.holders,
    sell: d.sell,
    fetchedAt: d.fetchedAt,
  };
}

export function marketLine(m: MarketSnapshot): string {
  return `${m.symbol || m.mint.slice(0, 6)} ${usd(m.mcapUsd)} mcap / ${usd(m.liqUsd)} liq`;
}
