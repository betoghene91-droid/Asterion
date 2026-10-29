/**
 * The desk's vocabulary.
 *
 * Every number that reaches a decision arrives in one of these structures, and
 * every structure deliberately uses `null` for "not known" rather than a
 * default like 0. A missing freeze-authority reading and a reading of "not
 * revoked" are opposite facts, and collapsing them is how a honeypot gets
 * bought. `filter.ts` treats every null as a kill (fail closed).
 */

export type DeskMode = 'paper' | 'live';

import type { HolderEntry, KnownAccounts } from './holders.js';

export type TokenProgram = 'spl-token' | 'token-2022' | 'unknown';

/** Market facts, as DexScreener reports them. No derived fields here. */
export interface MarketSnapshot {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  /** ms since epoch, from the pair. Scout's age gate reads this. */
  pairCreatedAtMs: number;
  priceUsd: number;
  mcapUsd: number;
  liqUsd: number;
  vol1hUsd: number;
  vol24hUsd: number;
  price6hLowUsd: number;
  price24hLowUsd: number;
  /** Pool LP fee in basis points. Feeds the paper fill model. */
  feeBps: number;
  change1hPct?: number | null;
  change6hPct?: number | null;
  change24hPct?: number | null;
}

/**
 * Contract facts. These come from an RPC read, not from a scanner's opinion.
 * Anything we could not read is null and therefore a kill.
 */
export interface SafetySnapshot {
  tokenProgram: TokenProgram;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  /** Token-2022 extension names present on the mint, verbatim. */
  extensions: string[];
  transferFeeBps: number | null;
  metadataMutable: boolean | null;
  programUpgradeable: boolean | null;
  lpBurned: boolean | null;
  lpLockDaysRemaining: number | null;
}

/** Distribution + flow facts. The exclusions live in holders.ts, not here. */
export interface HolderSnapshot {
  holders: number | null;
  /** Naive top-10 as a scanner reports it: includes the pool. Kills good tokens. */
  top10RawPct: number | null;
  /** Top-10 after removing pool, burn and known CEX wallets. This is the gate. */
  top10ExcludedPct: number | null;
  devPct: number | null;
  devPriorRug: boolean | null;
  /** Same-slot / same-funder buys as a share of supply. */
  bundledPct: number | null;
  /** First-20-buyer cohort as a share of supply. */
  sniper20Pct: number | null;
  uniqueBuyers: number | null;
  totalBuys: number | null;
  /** Wallets funded from the deployer's tree, net of the dev wallet itself. */
  devClusterPct: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  avgBuyUsd: number | null;
  medianBuyUsd: number | null;
  /** 14-period ATR as a fraction of price. Drives the stop, not a flat -6%. */
  atr14Pct: number | null;
  /** Growth of distinct buyers over the scoring window, in percent. */
  uniqueBuyerGrowthPct: number | null;
  /** Share of recent buy volume from the curated wallet list, in percent. */
  smartWalletPct: number | null;
}

/** Result of simulating the sell we would need to make. The honeypot probe. */
export interface SellSimulation {
  ok: boolean;
  priceImpactPct: number;
  revertReason?: string;
  /**
   * True when this came from pool arithmetic rather than a real
   * `simulateTransaction`. A modelled probe detects impact but cannot detect a
   * revert (a sell instruction that fails on-chain for a reason unrelated to
   * depth). Recorded so the filter's guarantee is stated precisely.
   */
  modelled?: boolean;
}

/**
 * Trade-tape metrics. The free tier cannot supply these, so they arrive through
 * an optional provider and stay `null` when no provider is configured.
 *
 * This separation is the honest core of the filter: a token we could not judge
 * is not a token we judged bad. With no provider the desk records a coverage gap
 * and opens nothing — the safe direction, and stated in DESK.md rather than
 * papered over with a guessed ratio that would pass a wash-traded launch.
 */
export interface FlowMetrics {
  uniqueBuyers: number | null;
  totalBuys: number | null;
  /** Same-slot / same-funder buys as a share of supply. */
  bundledPct: number | null;
  /** First-20-buyer cohort as a share of supply. */
  sniper20Pct: number | null;
  /** Wallets funded from the deployer tree, net of the dev wallet. */
  devClusterPct: number | null;
  /** Deployer has a prior rug in its funding-graph history. */
  devPriorRug: boolean | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  avgBuyUsd: number | null;
  medianBuyUsd: number | null;
  /** Distinct-buyer growth over the scoring window, percent. */
  uniqueBuyerGrowthPct: number | null;
  /** Share of recent buy volume from a curated wallet list, percent. */
  smartWalletPct: number | null;
  /** 14-period ATR as a fraction of price. */
  atr14Pct: number | null;
}

export type FlowProvider = (mint: string, market: MarketSnapshot) => Promise<FlowMetrics | null>;

/** Everything one mint has to offer, fetched together so the gates see one view. */
export interface TokenDossier {
  market: MarketSnapshot;
  safety: SafetySnapshot;
  holders: HolderSnapshot;
  sell: SellSimulation | null;
  fetchedAt: number;
  /**
   * The raw top-holders list, with `owner` preserved. The filter needs this
   * rather than a pre-computed percentage, because the pool/burn/CEX exclusion
   * can only be applied with the identities intact.
   */
  holderList?: HolderEntry[];
  /** Pool / burn / CEX registry derived from the same report as holderList. */
  knownAccounts?: KnownAccounts;
}

/** What the risk agent needs on each tick to mark a position. */
export interface Quote {
  mint: string;
  priceUsd: number;
  liqUsd: number;
  /** True when the dev/deployer wallet sold during this window. */
  devSold?: boolean;
  ts: number;
}

/**
 * Data access. The production implementation talks to DexScreener and an RPC
 * endpoint; the tests pass a fixture implementation so no test touches a
 * socket. That injection point is the only reason the round-trip test is
 * deterministic.
 */
export interface DeskSource {
  /** Coarse universe, newest first. Scout applies the real gates. */
  candidates(limit: number): Promise<MarketSnapshot[]>;
  /** Full dossier for one mint. `sizeUsd` sizes the honeypot sell simulation. */
  dossier(mint: string, sizeUsd: number): Promise<TokenDossier>;
  /** Current price + liquidity for an open position. */
  quote(mint: string): Promise<Quote>;
  /**
   * Trade-tape metrics. Optional: with no card provider, every flow metric is
   * null and the pipeline records a coverage gap instead of guessing.
   */
  flow?: FlowProvider;
  /**
   * Price history used by calibration: did a killed token 3x or go to -90%
   * after we passed? Absent source means calibration reports "unmeasured"
   * rather than inventing outcomes.
   */
  since?(mint: string, ts: number): Promise<{ highUsd: number; lowUsd: number; lastUsd: number } | null>;
}

/** Env slice the desk needs. Kept separate so desk code cannot read chain keys. */
export interface DeskEnv {
  DB: D1Database;
  DESK_MODE?: string;
  DESK_LIVE?: string;
  DESK_CAPITAL_CAP_USD?: string;
  DESK_SIGNER_URL?: string;
  /** Presence of this is a FAILURE of signer isolation, not a feature. */
  DESK_SIGNER_KEY?: string;
  DESK_EQUITY_START_USD?: string;
  DESK_PRIO_FEE_USD?: string;
  DESK_PRIO_FEE_CAP_USD?: string;
  DESK_DAILY_SUBREQUEST_CAP?: string;
  DESK_DEXSCREENER_BASE?: string;
  DESK_RPC_URL?: string;
  DAILY_LLM_BUDGET?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
  OPERATOR_NAME?: string;
}

/** Money constants. Exported so tests and DESK.md quote the same numbers. */
export const SIZING = {
  maxPositionPctOfEquity: 0.08,
  maxConcurrentPositions: 3,
  maxDeployedPct: 0.24,
  maxPoolSharePct: 0.01,
  minPositionUsd: 25,
  splitEntry: { first: 0.5, confirmation: 0.5 },
} as const;

export const SLIPPAGE = {
  entryBps: 200,
  exitBps: 500,
} as const;

export const BREAKER = {
  /** Daily realized loss that halts the desk. */
  lossPct: 0.08,
  haltSeconds: 24 * 3600,
} as const;

export const RISK = {
  hardStopPct: 0.06,
  atrStopMultiple: 1.5,
  trailArmPct: 0.12,
  trailPct: 0.12,
  tightenAfterPct: 0.40,
  trailTightPct: 0.06,
  timeStopSeconds: 4 * 3600,
  timeStopTargetPct: 0.15,
  liqDecayPct: 0.25,
} as const;

export const SCOUT = {
  minAgeSeconds: 30 * 60,
  maxAgeSeconds: 72 * 3600,
  minMcapUsd: 300_000,
  maxMcapUsd: 20_000_000,
  minLiqUsd: 40_000,
  /** liq must be at least this share of mcap: a $40k floor is nothing on $20M. */
  minLiqRatioOfMcap: 0.03,
  minHolders: 300,
} as const;

export const FILTER = {
  maxTop10ExcludedPct: 25,
  maxDevPct: 3,
  maxBundledPct: 10,
  maxSniper20Pct: 30,
  minUniqueBuyerRatio: 0.35,
  maxDevClusterPct: 15,
  maxTransferFeeBps: 500,
  minLpLockDays: 30,
  minVol1hUsd: 50_000,
  maxHoneypotImpactPct: 15,
  /** Late entry: price above 3.5x the 24h low or 1.8x the 6h low is a chase. */
  maxMultipleOf24hLow: 3.5,
  maxMultipleOf6hLow: 1.8,
} as const;

export const ANALYST = {
  passTotal: 70,
  /** Weights sum to 100. A 70 built from one hero metric must still fail. */
  weights: {
    momentum: 20,
    uniqueBuyers: 15,
    buyPressure: 15,
    holderGrowth: 10,
    liqQuality: 15,
    smartWallets: 15,
    residualSafety: 10,
  },
  /**
   * Minimum sub-score per component, on the same 0-100 scale as the sub-score
   * itself.
   *
   * These are deliberately around a third to a half of the scale rather than
   * "just above zero". A floor of 6 catches only a component that is already
   * dead, which is not a floor — it is decoration. At these levels a token has to
   * bring seven acceptable answers, so a 70 assembled from one maxed-out metric
   * is refused by construction.
   *
   * `liqQuality: 40` is not arbitrary: it is exactly the score a pool at 3% of
   * market cap earns, i.e. Scout's own liquidity minimum. The analyst floor and
   * the scout gate therefore agree instead of contradicting each other.
   */
  floors: {
    momentum: 35,
    uniqueBuyers: 30,
    buyPressure: 35,
    holderGrowth: 30,
    liqQuality: 40,
    smartWallets: 30,
    residualSafety: 50,
  },
} as const;

export type AnalystComponent = keyof typeof ANALYST.weights;

export const ARMING = {
  minPaperTrades: 200,
  minDays: 30,
  maxDrawdownPct: 0.15,
} as const;

/** Venues whose extensions are dangerous when present on a Token-2022 mint. */
export const DANGEROUS_TOKEN2022_EXTENSIONS = [
  'transferhook',
  'transfer_hook',
  'permanentdelegate',
  'permanent_delegate',
  'nontransferable',
  'non_transferable',
  'transferfeeconfig',
  'transfer_fee_config',
] as const;
