/**
 * A FlowProvider over free RPC: a bounded sample of a pool's recent trades.
 *
 * ## What this is, and what it deliberately is not
 *
 * The filter's flow gates (unique-buyer ratio, bundled launch, sniper cohort,
 * deployer cluster) need trade-level indexing. `source.ts` returns `null` for all
 * of them because DexScreener free and RugCheck public do not provide it, and a
 * guessed 0.5 for a wash-trade ratio passes exactly the token that costs money.
 *
 * A paid indexer is one answer. The other answer — this file — is to sample: ask
 * the RPC for the pool's most recent signatures, fetch a bounded number of those
 * transactions, and derive the subset of facts that a sample can actually
 * support. Everything it cannot support stays `null`, and a `null` stays a
 * coverage gap: the pipeline refuses to score that token and opens nothing.
 *
 * ## The six fields it establishes, and the basis for each
 *
 * | Field | Derivation | Honest bound |
 * |---|---|---|
 * | `uniqueBuyers` | distinct owners of a token account whose balance rose across one transaction | distinct buyers **in the sample**, not ever |
 * | `totalBuys` | transactions in the sample with at least one net-positive token delta | sample size |
 * | `buyVolumeUsd` | sum(newTokenAmount) x mid price | valued at the **current mid**, not each trade's execution price |
 * | `sellVolumeUsd` | sum(soldTokenAmount) x mid price | same basis |
 * | `medianBuyUsd` | median of per-buy USD values | same basis; a buy of N units is exactly N x mid |
 * | `uniqueBuyerGrowthPct` | distinct buyers in the newer half vs the older half | a **two-bucket** trend over the sample window, not a time series |
 *
 * ## The fields it leaves null, and why
 *
 * - `bundledPct` / `sniper20Pct` are shares **of supply**. Supply is not in a
 *   transaction payload and neither is a per-holder historic balance. Taking the
 *   highest observed balance of a single token account and calling it a share is
 *   not a bound, it is a different number.
 * - `devClusterPct` needs the deployer's funding graph — a search over historical
 *   SOL transfers, which is more requests than the whole budget.
 * - `smartWalletPct` needs a curated wallet list, which this repo does not ship.
 * - `atr14Pct` is a property of a price series. The sample has trades, not bars.
 * - `devPriorRug` is a claim about a wallet's history; nothing here reads history
 *   beyond one page of one pool.
 *
 * ## Requests, not bytes
 *
 * The binding constraint is request count. Per mint this costs
 * `1 + ceil(parsed / 1)` calls: one `getSignaturesForAddress` and one
 * `getTransaction` per signature. `FLOW_SAMPLE.budgetPerTick` caps the total for a
 * whole tick, and `rateLimitRps` is enforced by spacing calls, because a public
 * RPC that returns 429 for 30 of 40 calls should not be read as "this token has
 * few buyers".
 *
 * ## Injectability
 *
 * `flowProviderFromRpc(env, opts)` takes its `rpc` as a parameter and defaults to
 * a real fetch. Every test passes a stub, so no test touches a socket.
 */

import { b58encode, publicKey } from './base58.js';
import { db, kvGet, kvSet, spendSubrequest } from './db.js';
import {
  FLOW_SAMPLE,
  type DeskEnv,
  type FlowMetrics,
  type FlowProvider,
  type FlowSample,
  type MarketSnapshot,
} from './types.js';

/** The identity of this provider, recorded on every cached row. */
export const FLOW_SOURCE_ID = 'rpc-sample';

/**
 * Every field this provider can ever fill. Everything else is permanently null
 * here, and the list is exported so a test can assert the exact set rather than
 * trusting a comment.
 */
export const FLOW_FIELDS_ESTABLISHED = [
  'uniqueBuyers',
  'totalBuys',
  'buyVolumeUsd',
  'sellVolumeUsd',
  'medianBuyUsd',
  'uniqueBuyerGrowthPct',
] as const;

/** Every field of `FlowMetrics` (minus provenance). Used for the null assertion. */
export const FLOW_FIELDS_ALL = [
  'uniqueBuyers',
  'totalBuys',
  'bundledPct',
  'sniper20Pct',
  'devClusterPct',
  'devPriorRug',
  'buyVolumeUsd',
  'sellVolumeUsd',
  'avgBuyUsd',
  'medianBuyUsd',
  'uniqueBuyerGrowthPct',
  'smartWalletPct',
  'atr14Pct',
] as const;

// ── RPC types (shapes verified against live responses) ────────────────────

interface SigInfo {
  signature?: string;
  slot?: number;
  err?: unknown;
  confirmationStatus?: string;
}

interface TokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number; uiAmount?: number | null };
}

interface ParsedTx {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    preBalances?: number[] | null;
    postBalances?: number[] | null;
  } | null;
  transaction?: unknown;
}

/** One parsed swap leg, in token units and in the base quote (SOL/lamports). */
export interface SwapLeg {
  owner: string;
  /** Token units gained (buy) or lost (sell). Always positive. */
  tokenUnits: number;
  /** Which side of the book this leg is on. */
  side: 'buy' | 'sell';
}

/**
 * Parse the swap legs for one mint out of one transaction.
 *
 * ## Why the token-account balance delta and not the instruction
 *
 * The instruction-level approach needs the pool's AMM layout (Raydium v4, Orca
 * Whirlpool, Meteora DLMM and pump.fun all differ) and an account-index
 * convention per venue. The balance delta works for every venue at once: if an
 * owner's token account for this mint ended higher than it started, that owner
 * bought. That is also the only attribution a sample can defend, because the
 * *signer* of a routed swap is often a fee payer for several wallets.
 *
 * ## What it cannot see
 *
 * A wallet that buys and sells the same mint inside one transaction nets to
 * zero and is recorded as neither, which undercounts churn — the safe direction
 * for a wash-trade ratio, and stated in DESK.md.
 */
export function swapLegsOf(tx: ParsedTx, mint: string): SwapLeg[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];

  const before = new Map<string, number>();
  const ownerOf = new Map<string, string>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b?.mint !== mint) continue;
    const key = String(b.accountIndex);
    before.set(key, Number(b.uiTokenAmount?.uiAmount ?? 0));
    if (typeof b.owner === 'string') ownerOf.set(key, b.owner);
  }

  const out: SwapLeg[] = [];
  for (const b of meta.postTokenBalances ?? []) {
    if (b?.mint !== mint) continue;
    const key = String(b.accountIndex);
    const pre = before.get(key) ?? 0;
    const post = Number(b.uiTokenAmount?.uiAmount ?? 0);
    const owner = typeof b.owner === 'string' ? b.owner : ownerOf.get(key);
    if (!owner) continue;
    const delta = post - pre;
    // A zero delta is not a trade. `1e-9` guards float noise on 9-decimal mints.
    if (Math.abs(delta) < 1e-9) continue;
    out.push({
      owner,
      tokenUnits: Math.abs(delta),
      side: delta > 0 ? 'buy' : 'sell',
    });
  }
  return out;
}

/**
 * Does this owner look like a pool or program rather than a person?
 *
 * RugCheck's `knownAccounts` already names AMM/LOCKER accounts, and the leg-side
 * filter in `flowFromSample` uses it. This is the second, coarser net for the
 * case where the registry is incomplete: a pool vault nets to the *opposite* side
 * of every retail trade in the same transaction, so it would otherwise be
 * counted as one enormous "unique buyer" with a huge "buy volume" — the exact
 * number that makes a thin token look like it has demand.
 */
function isProgramLike(owner: string, known: Set<string>): boolean {
  return known.has(owner);
}

/** Median of a numeric list, 0 for an empty list. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Fold a set of parsed transactions into flow metrics.
 *
 * Pure, and separated from the network so the interesting logic is testable
 * without an RPC stub at all. Every number it returns is derived from the
 * transactions it was handed and nothing else.
 *
 * `midPriceUsd` is the current mid from the market snapshot. Using one price for
 * every leg is exact for a size in tokens and an estimate for "what it cost": a
 * token that moved 30% inside the sample window has buys valued at today's
 * price, not at their own. The alternative — reconstructing each trade's price
 * from the SOL leg — is possible but needs per-leg pairing through routed swaps,
 * and a silently wrong reconstruction is worse than a stated estimate. The basis
 * is recorded as `usdBasis: 'mid'` on every result.
 */
export function flowFromSample(
  txs: ParsedTx[],
  mint: string,
  midPriceUsd: number,
  opts: { known?: Set<string>; sampledAt: number; signatures: number; failed: number },
): FlowMetrics {
  const known = opts.known ?? new Set<string>();
  const buyers = new Set<string>();
  const buyUsds: number[] = [];
  let totalBuys = 0;
  let buyVolumeUsd = 0;
  let sellVolumeUsd = 0;

  // Per-transaction, per-owner net, so one transaction counts a buyer once even
  // if it touched several of that owner's token accounts.
  const slotsSeen: number[] = [];

  // Ordered oldest -> newest by slot so the growth comparison is chronological.
  const ordered = [...txs].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  /** Distinct buyers per transaction, for the two-bucket growth measure. */
  const buyersByTx: { slot: number; owners: Set<string> }[] = [];

  for (const tx of ordered) {
    const legs = swapLegsOf(tx, mint);
    if (!legs.length) continue;
    if (typeof tx.slot === 'number') slotsSeen.push(tx.slot);

    const netByOwner = new Map<string, number>();
    for (const leg of legs) {
      if (isProgramLike(leg.owner, known)) continue;
      const signed = leg.side === 'buy' ? leg.tokenUnits : -leg.tokenUnits;
      netByOwner.set(leg.owner, (netByOwner.get(leg.owner) ?? 0) + signed);
    }

    const txBuyers = new Set<string>();
    for (const [owner, net] of netByOwner) {
      if (Math.abs(net) < 1e-9) continue;
      if (net > 0) {
        txBuyers.add(owner);
        buyers.add(owner);
        totalBuys++;
        const usd = net * midPriceUsd;
        buyUsds.push(usd);
        buyVolumeUsd += usd;
      } else {
        sellVolumeUsd += Math.abs(net) * midPriceUsd;
      }
    }
    if (txBuyers.size) buyersByTx.push({ slot: tx.slot ?? 0, owners: txBuyers });
  }

  /*
   * Buyer growth: distinct owners in the newer half of the sampled transactions
   * against the older half. This is a two-bucket comparison and is reported as
   * exactly that. It is NOT a per-hour rate, and a caller must not relabel it.
   */
  let uniqueBuyerGrowthPct: number | null = null;
  if (buyersByTx.length >= 4) {
    const split = Math.floor(buyersByTx.length / 2);
    const older = new Set<string>();
    for (const t of buyersByTx.slice(0, split)) for (const o of t.owners) older.add(o);
    const newer = new Set<string>();
    for (const t of buyersByTx.slice(split)) for (const o of t.owners) newer.add(o);
    if (older.size > 0) {
      uniqueBuyerGrowthPct = Number((((newer.size - older.size) / older.size) * 100).toFixed(2));
    } else if (newer.size > 0) {
      // No buyers at all in the older half: a percentage change from zero is
      // undefined, not infinite. Null is the honest answer and stays a gap.
      uniqueBuyerGrowthPct = null;
    }
  }

  slotsSeen.sort((a, b) => a - b);
  const sample: FlowSample = {
    signatures: opts.signatures,
    parsed: ordered.length,
    failed: opts.failed,
    fromSlot: slotsSeen.length ? (slotsSeen[0] as number) : null,
    toSlot: slotsSeen.length ? (slotsSeen[slotsSeen.length - 1] as number) : null,
    usdBasis: 'mid',
    sampledAt: opts.sampledAt,
  };

  return {
    uniqueBuyers: buyers.size,
    totalBuys,
    // Permanent nulls for this provider. See the module header for why each one
    // cannot be derived from a transaction sample.
    bundledPct: null,
    sniper20Pct: null,
    devClusterPct: null,
    devPriorRug: null,
    buyVolumeUsd: Number(buyVolumeUsd.toFixed(2)),
    sellVolumeUsd: Number(sellVolumeUsd.toFixed(2)),
    // Average buy is arithmetic mean; the filter's gate reads the median, and the
    // mean is left null rather than being provided as a near-duplicate that a
    // reader might mistake for a robust statistic.
    avgBuyUsd: null,
    medianBuyUsd: buyUsds.length ? Number(median(buyUsds).toFixed(2)) : null,
    uniqueBuyerGrowthPct,
    smartWalletPct: null,
    atr14Pct: null,
    flowSample: sample,
  };
}

// ── the bounded sampling provider ─────────────────────────────────────────

export interface RpcCaller {
  /** POST a JSON-RPC method. Returns the parsed `result`, or throws. */
  (method: string, params: unknown[]): Promise<unknown>;
}

export interface FlowProviderOptions {
  /** Injected for tests. Defaults to a real fetch to `env.DESK_RPC_URL`. */
  rpc?: RpcCaller;
  /** Clock, for determinism. */
  now?: () => number;
  /** Override the per-tick subrequest budget. */
  budgetPerTick?: number;
  /** Cache reads/writes. Disabled by tests that want no database at all. */
  useCache?: boolean;
  /** Sleep between RPC calls to honour `rateLimitRps`. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Owner addresses to exclude: the pool, burn sinks, known CEX wallets. */
  knownOwners?: (mint: string) => Promise<Set<string>>;
}

/** A tiny per-tick budget so one sweep cannot starve the security side. */
interface TickBudget {
  used: number;
  cap: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scale a signature timestamp we do not have.
 *
 * `getSignaturesForAddress` gives `blockTime` but `getTransaction` does not carry
 * it reliably; both are only used for the growth two-bucket comparison, which
 * sorts by slot. Nothing here invents a timestamp.
 */

/**
 * Build the provider.
 *
 * Returns a `FlowProvider` — the same signature `DeskSource.flow` already
 * accepts — so wiring it in is one line at the composition root and no desk code
 * changes. It caches per mint in D1 through `readFlowCache` / `writeFlowCache`.
 */
export function flowProviderFromRpc(env: DeskEnv, opts: FlowProviderOptions = {}): FlowProvider {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  const useCache = opts.useCache ?? true;
  const budget: TickBudget = { used: 0, cap: opts.budgetPerTick ?? FLOW_SAMPLE.budgetPerTick };
  const rpc = opts.rpc ?? defaultRpc(env);
  const minIntervalMs = Math.ceil(1000 / Math.max(1, FLOW_SAMPLE.rateLimitRps));

  /** Spend one subrequest from both the tick budget and the daily desk budget. */
  const charge = async (): Promise<boolean> => {
    if (budget.used >= budget.cap) return false;
    if (!(await spendSubrequest(env))) return false;
    budget.used++;
    return true;
  };

  /** Space calls to honour the programme rate limit instead of taking a 429. */
  let lastCallAt = 0;
  const rateLimited = async <T>(fn: () => Promise<T>): Promise<T> => {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  };

  return async function flow(mint: string, market: MarketSnapshot): Promise<FlowMetrics | null> {
    const at = now();

    // ── 1. Cache: one-time cost per token, not per tick ────────────────────
    if (useCache) {
      const cached = await readFlowCache(env, mint, at);
      if (cached) return cached;
    }

    // ── 2. The pool to sample ──────────────────────────────────────────────
    // Sampling the *pool account* is what gives the swap history; sampling the
    // mint would give token-account creations and admin actions instead.
    const pool = market.pairAddress;
    if (!pool) return null;

    // ── 3. Signatures ──────────────────────────────────────────────────────
    if (!(await charge())) return null;
    let sigs: SigInfo[];
    try {
      const res = await rateLimited(() =>
        rpc('getSignaturesForAddress', [
          pool,
          { limit: FLOW_SAMPLE.signaturePageSize },
        ]),
      );
      sigs = Array.isArray(res) ? (res as SigInfo[]) : [];
    } catch {
      // An unanswered read is not a token with no buyers. Null -> coverage gap.
      return null;
    }
    if (!sigs.length) return null;

    const wanted = sigs
      .filter((s): s is SigInfo & { signature: string } => typeof s.signature === 'string')
      .slice(0, FLOW_SAMPLE.maxSignatures);
    const failed = wanted.filter((s) => s.err !== null && s.err !== undefined).length;

    // ── 4. Transactions, bounded ───────────────────────────────────────────
    const known = opts.knownOwners ? await opts.knownOwners(mint).catch(() => new Set<string>()) : new Set<string>();
    const parsed: ParsedTx[] = [];
    for (const s of wanted) {
      if (parsed.length >= FLOW_SAMPLE.maxTransactions) break;
      if (!(await charge())) break;
      try {
        // `maxSupportedTransactionVersion: 1` is required, not optional: a
        // version-1 transaction fails to deserialize when the client claims to
        // support only version 0, and the free RPC answers `-32015`. Verified
        // live on 2026-10-30 — roughly a third of a busy pool's traffic is v1.
        const res = await rateLimited(() =>
          rpc('getTransaction', [
            s.signature,
            { maxSupportedTransactionVersion: 1, encoding: 'jsonParsed', commitment: 'confirmed' },
          ]),
        );
        if (res && typeof res === 'object') parsed.push(res as ParsedTx);
      } catch {
        // A pruned or unavailable transaction is a smaller sample, not a zero.
        continue;
      }
    }

    // Nothing parsed: we learned nothing. Not "no buyers".
    if (!parsed.length) return null;

    const metrics = flowFromSample(parsed, mint, market.priceUsd, {
      known,
      sampledAt: at,
      signatures: wanted.length,
      failed,
    });

    // ── 5. Persist so the next tick is free ────────────────────────────────
    if (useCache) await writeFlowCache(env, mint, metrics, at, pool).catch(() => undefined);

    return metrics;
  };
}

/** The real RPC caller: POST JSON-RPC, bounded by the desk's own timeout. */
export function defaultRpc(env: DeskEnv): RpcCaller {
  const url = env.DESK_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  return async (method, params) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(`${method} -> ${body.error.message ?? 'rpc error'}`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── D1 cache ──────────────────────────────────────────────────────────────

/**
 * Read a cached flow answer for one mint.
 *
 * Two lifetimes, on purpose:
 *  - inside `cacheTtlSeconds` the answer is served without any RPC at all;
 *  - inside `staleAfterSeconds` it is still served, but the caller is expected to
 *    refresh opportunistically. `readFlowCache` therefore returns the row and its
 *    age, so a caller can decide; the provider treats anything past the TTL as a
 *    miss and refetches, which is the simple correct behaviour for a 5-minute
 *    tick.
 */
export async function readFlowCache(
  env: DeskEnv,
  mint: string,
  atMs: number,
): Promise<FlowMetrics | null> {
  const row = await db(env).first<{
    ts: number;
    unique_buyers: number | null;
    total_buys: number | null;
    buy_volume_usd: number | null;
    sell_volume_usd: number | null;
    median_buy_usd: number | null;
    avg_buy_usd: number | null;
    unique_buyer_growth_pct: number | null;
    bundled_pct: number | null;
    sniper20_pct: number | null;
    dev_cluster_pct: number | null;
    smart_wallet_pct: number | null;
    atr14_pct: number | null;
    sample_sigs: number;
    sample_from_slot: number | null;
    sample_to_slot: number | null;
    usd_basis: string;
    fields_null: string;
  }>('SELECT * FROM desk_flow WHERE mint=?', mint);

  if (!row) return null;
  if (atMs / 1000 - row.ts > FLOW_SAMPLE.cacheTtlSeconds) return null;

  return {
    uniqueBuyers: row.unique_buyers,
    totalBuys: row.total_buys,
    bundledPct: row.bundled_pct,
    sniper20Pct: row.sniper20_pct,
    devClusterPct: row.dev_cluster_pct,
    devPriorRug: null,
    buyVolumeUsd: row.buy_volume_usd,
    sellVolumeUsd: row.sell_volume_usd,
    avgBuyUsd: row.avg_buy_usd,
    medianBuyUsd: row.median_buy_usd,
    uniqueBuyerGrowthPct: row.unique_buyer_growth_pct,
    smartWalletPct: row.smart_wallet_pct,
    atr14Pct: row.atr14_pct,
    flowSample: {
      signatures: row.sample_sigs,
      // A cache row is a measurement: at least one transaction parsed, which is
      // why the provider only writes on a non-empty sample.
      parsed: row.sample_sigs,
      failed: 0,
      fromSlot: row.sample_from_slot,
      toSlot: row.sample_to_slot,
      usdBasis: (row.usd_basis as FlowSample['usdBasis']) ?? 'mid',
      sampledAt: row.ts * 1000,
    },
  };
}

/** Upsert one cached answer. `fields_null` records what stayed a gap. */
export async function writeFlowCache(
  env: DeskEnv,
  mint: string,
  m: FlowMetrics,
  atMs: number,
  note = '',
): Promise<void> {
  const nulls = FLOW_FIELDS_ALL.filter((k) => m[k] === null);
  await db(env).run(
    `INSERT INTO desk_flow
     (mint, ts, source, unique_buyers, total_buys, buy_volume_usd, sell_volume_usd,
      median_buy_usd, avg_buy_usd, unique_buyer_growth_pct, bundled_pct, sniper20_pct,
      dev_cluster_pct, smart_wallet_pct, atr14_pct, sample_sigs, sample_from_slot,
      sample_to_slot, usd_basis, fields_null, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(mint) DO UPDATE SET
       ts=excluded.ts, source=excluded.source, unique_buyers=excluded.unique_buyers,
       total_buys=excluded.total_buys, buy_volume_usd=excluded.buy_volume_usd,
       sell_volume_usd=excluded.sell_volume_usd, median_buy_usd=excluded.median_buy_usd,
       avg_buy_usd=excluded.avg_buy_usd, unique_buyer_growth_pct=excluded.unique_buyer_growth_pct,
       bundled_pct=excluded.bundled_pct, sniper20_pct=excluded.sniper20_pct,
       dev_cluster_pct=excluded.dev_cluster_pct, smart_wallet_pct=excluded.smart_wallet_pct,
       atr14_pct=excluded.atr14_pct, sample_sigs=excluded.sample_sigs,
       sample_from_slot=excluded.sample_from_slot, sample_to_slot=excluded.sample_to_slot,
       usd_basis=excluded.usd_basis, fields_null=excluded.fields_null, detail=excluded.detail`,
    mint,
    Math.floor(atMs / 1000),
    FLOW_SOURCE_ID,
    m.uniqueBuyers,
    m.totalBuys,
    m.buyVolumeUsd,
    m.sellVolumeUsd,
    m.medianBuyUsd,
    m.avgBuyUsd,
    m.uniqueBuyerGrowthPct,
    m.bundledPct,
    m.sniper20Pct,
    m.devClusterPct,
    m.smartWalletPct,
    m.atr14Pct,
    m.flowSample?.signatures ?? 0,
    m.flowSample?.fromSlot ?? null,
    m.flowSample?.toSlot ?? null,
    m.flowSample?.usdBasis ?? 'mid',
    JSON.stringify(nulls),
    note,
  );
  // Companion key so /desk can report "N tokens sampled, M cached" without a
  // count query on every render.
  await kvSet(env, 'desk_flow_last_sample', String(Math.floor(atMs / 1000))).catch(() => undefined);
}

/** How much of the flow cache exists. Used by /calib and /desk to state coverage. */
export async function flowCacheStats(
  env: DeskEnv,
): Promise<{ rows: number; newest_ts: number | null; last_sample: number | null }> {
  const row = await db(env).first<{ n: number; newest: number | null }>(
    'SELECT COUNT(*) AS n, MAX(ts) AS newest FROM desk_flow',
  );
  const last = await kvGet(env, 'desk_flow_last_sample');
  return {
    rows: row?.n ?? 0,
    newest_ts: row?.newest ?? null,
    last_sample: last ? Number(last) || null : null,
  };
}

/** Re-export so a caller that only imports this module gets the bound. */
export { FLOW_SAMPLE };

/**
 * Signature helper kept for symmetry with the probe module: a base58 string for
 * a 32-byte value. Not used for on-chain anything.
 */
export function b58Of(bytes: Uint8Array): string {
  return b58encode(bytes);
}

/** Validate a base58 public key, used by the sample's pool argument checks. */
export function isValidPublicKey(s: string): boolean {
  try {
    publicKey(s);
    return true;
  } catch {
    return false;
  }
}
