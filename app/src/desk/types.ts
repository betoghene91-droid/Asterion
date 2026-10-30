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

/**
 * One `simulateTransaction` call the honeypot probe made.
 *
 * `signature` is the signature field of the transaction we submitted, base58.
 * It is NOT an on-chain signature and this transaction never landed: the call is
 * made with `sigVerify: false` and a fresh blockhash supplied by the RPC, so the
 * field carries a deterministic value derived from the probe payload purely so
 * the exact simulation can be identified and reproduced. `payloadSha256` is the
 * digest of the exact base64 body sent, which is the reproducible identity.
 */
export interface ProbeRecord {
  /** Which leg this was. See honeypot.ts — 'entry' is an inbound transfer test. */
  leg: 'entry' | 'exit';
  /** Base58 of the transaction's signature field. Not an on-chain signature. */
  signature: string;
  /** Hex sha256 of the base64 payload exactly as submitted. */
  payloadSha256: string;
  /** `result.value.err` from the simulation. Null means the transfer succeeds. */
  err: unknown;
  unitsConsumed: number | null;
  /** Last few program log lines, which is where the reason usually is. */
  logsTail: string[];
}

/** Result of simulating the sell we would need to make. The honeypot probe. */
export interface SellSimulation {
  ok: boolean;
  priceImpactPct: number;
  revertReason?: string;
  /**
   * True when the *revert* half of this answer came from pool arithmetic rather
   * than a real `simulateTransaction`. A modelled probe detects impact but
   * cannot detect a revert (a sell that fails on-chain for a reason unrelated to
   * depth). Recorded so the filter's guarantee is stated precisely.
   */
  modelled?: boolean;
  /** True only when at least one real `simulateTransaction` produced this. */
  simulated?: boolean;
  /** The simulations behind the verdict, with their signatures. */
  simulations?: ProbeRecord[];
  /** Which leg reverted, when one did. */
  revertLeg?: 'entry' | 'exit';
}

/**
 * Where a flow number came from, so a reader can bound it.
 *
 * Every sample-derived metric in `FlowMetrics` is measured over this window and
 * nothing else. Recording the window is what stops "unique buyers 41" from
 * being read as "unique buyers 41 ever": it is 41 distinct buyers among the
 * transactions we actually fetched, which is a sample of the pool's recent
 * history and not a census.
 */
export interface FlowSample {
  /** Signatures the RPC returned for the page we asked for. */
  signatures: number;
  /** Transactions that parsed into at least one swap leg. */
  parsed: number;
  /** Transactions the chain rejected (`meta.err` non-null). Not swaps. */
  failed: number;
  /** Slot range covered by the parsed sample, oldest -> newest. */
  fromSlot: number | null;
  toSlot: number | null;
  /**
   * How token amounts were converted to USD. `mid` means every leg was valued at
   * the single current mid price in the snapshot, NOT at its own execution
   * price. That is exact for a size in tokens and an estimate for "what it cost".
   */
  usdBasis: 'mid';
  /** ms since epoch when the sample was taken. */
  sampledAt: number;
}

/**
 * Trade-tape metrics. The free tier cannot supply these, so they arrive through
 * an optional provider and stay `null` when no provider is configured.
 *
 * This separation is the honest core of the filter: a token we could not judge
 * is not a token we judged bad. With no provider the desk records a coverage gap
 * and opens nothing — the safe direction, and stated in DESK.md rather than
 * papered over with a guessed ratio that would pass a wash-traded launch.
 *
 * A provider is expected to fill only the subset it can actually establish —
 * see `flow.ts`, which fills six of these from a bounded RPC sample and returns
 * null for the rest. A field is null because the fact is not available, never
 * because it was inconvenient.
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
  /** Provenance for the sample-derived fields. Null when nothing was sampled. */
  flowSample?: FlowSample | null;
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
   *
   * `baseUsd` is optional and is the price the multiples must be measured FROM.
   * Without it, a caller falls back to `lowUsd`, which is the forward-window low
   * and is therefore <= the pre-decision price — that fallback systematically
   * UNDER-reports a run and so flatters the filter. A source that knows the real
   * base (the `desk_marks` series does) must supply it.
   */
  since?(mint: string, ts: number): Promise<{ highUsd: number; lowUsd: number; lastUsd: number; baseUsd?: number } | null>;
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
  /** Execution haircut overrides, in bps. Defaults are `EXECUTION_HAIRCUT`. */
  DESK_MEV_HAIRCUT_BPS?: string;
  DESK_FAILED_TX_BPS?: string;
  /** `off` disables the RPC flow sample; every flow field stays a coverage gap. */
  DESK_FLOW_PROVIDER?: string;
  /** `off` restores the modelled honeypot probe instead of `simulateTransaction`. */
  DESK_HONEYPOT_SIM?: string;
  /** `1` promotes `reported` registry entries into the exclusion denominator. */
  DESK_CEX_INCLUDE_REPORTED?: string;
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

/**
 * Paper mode's execution haircut: MEV and failed-transaction cost.
 *
 * Without this, paper PnL is structurally optimistic in exactly the tokens most
 * worth sandwiching, and an optimistic paper record is what would eventually
 * authorise a live order. Both halves are named and separate so the calibration
 * report can say which one is assumed rather than lumping them into one number.
 *
 * Override per deploy with `DESK_MEV_HAIRCUT_BPS` / `DESK_FAILED_TX_BPS`; the
 * constants below are the defaults that must hold when nothing is configured.
 * Applied to the notional of every simulated leg, entry and exit.
 */
export const EXECUTION_HAIRCUT = {
  /** Adversarial price impact on our own order (sandwich / backrun). */
  mevBps: 60,
  /** Expected cost of a transaction that fails and has to be retried. */
  failedTxBps: 40,
  /** Convenience total so no caller has to add them up wrongly. */
  totalBps: 100,
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

/**
 * The bound on a flow sample. Named, exported, and quoted in DESK.md.
 *
 * ## Why 40 and not "as many as possible"
 *
 * Three hard ceilings apply, and the smallest wins:
 *
 *  1. **The RPC's own page size.** `getSignaturesForAddress` caps at 1000, but a
 *     busy pool has thousands of transactions, so 1000 is not "the whole tape" —
 *     it is a page. Sampling 40 is a *bounded* lie-free answer; sampling 1000 is
 *     a bigger bill for the same kind of answer.
 *  2. **The per-invocation subrequest budget.** The free plan allows 50
 *     subrequests per invocation and `discovery.ts` already spends 40 of them
 *     (`MAX_CANDIDATES = 20` x 2). The desk runs in the *same* invocation as the
 *     security sweep, so a flow provider that fetches 40 transactions would
 *     starve the sweep. `flow.ts` therefore charges every call through
 *     `spendSubrequest`, and the effective per-tick cap is
 *     `FLOW_SAMPLE.budgetPerTick`.
 *  3. **The programme's rate limit.** The RoE carries `rate_limit_rps: 3`, and
 *     `flow.ts` spaces its requests to honour it rather than firing 40 calls at
 *     once and taking a 429 (which on a public RPC looks like a dead token).
 *
 * ## The honest consequence
 *
 * A 40-transaction sample of a pool with 20 000 transactions is a *sample*. It
 * can say "of the last 40 swaps, 9 were distinct buyers" — which is enough for
 * the wash-trade ratio gate — but it cannot say "this token has 9 buyers". That
 * is why `FlowMetrics.flowSample` records the window and why DESK.md states the
 * bound next to every number derived from it.
 */
export const FLOW_SAMPLE = {
  /** Signatures requested per mint. The primary bound. */
  maxSignatures: 40,
  /** Transactions actually parsed per mint (getTransaction is the expensive call). */
  maxTransactions: 20,
  /** Signatures per RPC page request; the RPC max is 1000. */
  signaturePageSize: 40,
  /** Subrequests the flow provider may spend in ONE tick, across all mints. */
  budgetPerTick: 12,
  /** Programme rate limit from the RoE (requests per second). Enforced, not assumed. */
  rateLimitRps: 3,
  /** Cache lifetime. One-time cost per token, not per tick. */
  cacheTtlSeconds: 60 * 60 * 6,
  /** A cached answer older than this is refetched even inside the TTL budget. */
  staleAfterSeconds: 60 * 60 * 24,
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
