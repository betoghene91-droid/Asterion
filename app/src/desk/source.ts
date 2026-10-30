/**
 * The live data source: DexScreener (market), RugCheck (contract safety +
 * holders + known accounts), and a Solana RPC (LP mint supply).
 *
 * Every shape in here was verified against a real response on 2026-10-29, not
 * inferred from docs. The specific facts that shaped the code:
 *
 *  - `GET api.dexscreener.com/token-pairs/v1/solana/{mint}` returns a **flat
 *    array** of pairs (not `{pairs:[...]}`), with `marketCap`, `liquidity.usd`,
 *    `volume.h1`, `priceChange.{h1,h6,h24}`, `pairCreatedAt`. A pump.fun
 *    bonding-curve pair in the same array has `liquidity: null` — so pair
 *    selection must prefer the pair with real liquidity or it will compute a
 *    ratio gate against zero.
 *  - `GET api.rugcheck.xyz/v1/tokens/{mint}/report` returns `mintAuthority` and
 *    `freezeAuthority` as **null when revoked** (null == good, which is the
 *    opposite of the usual convention and exactly the kind of thing that
 *    inverts a gate if assumed).
 *  - `knownAccounts` is `{address: {name, type}}` with type AMM/LOCKER/CREATOR,
 *    and `topHolders[].owner` is what identifies the pool.
 *  - LP burn: `getTokenSupply(lpMint).uiAmount == 0` means every LP token was
 *    burned. Verified live (returned 0 for a fully-burned pump.fun AMM pool).
 *
 * ## What this source deliberately returns as null
 *
 * `uniqueBuyers`, `totalBuys`, `bundledPct`, `sniper20Pct`, `devClusterPct`,
 * `devPriorRug` need trade-level indexing. The free tier does not have it. They
 * are returned as `null` and the filter reports them as coverage gaps rather
 * than guessing — a guessed 0.5 for a wash-trade ratio would pass a wash-traded
 * token, which is the failure that costs money.
 */

import { spendSubrequest } from './db.js';
import { buildKnownAccounts, type HolderEntry, type KnownAccounts } from './holders.js';
import { probeHoneypot, recordProbes } from './honeypot.js';
import { flowProviderFromRpc } from './flow.js';
import { registryOptionsFrom } from './registry.js';
import type {
  DeskEnv,
  DeskSource,
  HolderSnapshot,
  MarketSnapshot,
  Quote,
  SafetySnapshot,
  TokenDossier,
  TokenProgram,
} from './types.js';

/** Default RPC. The public endpoint is slow and rate-limited; override per deploy. */
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const DEFAULT_DEX = 'https://api.dexscreener.com';
const RUGCHECK = 'https://api.rugcheck.xyz';

/** Per-call ceiling. No request in this file may exceed it. */
const TIMEOUT_MS = 8000;

class BudgetExhausted extends Error {}

/**
 * fetch with a hard timeout and an explicit, non-optional budget charge.
 *
 * The budget check is a required argument rather than a convention because the
 * failure mode is silent: a crawler that ignores the cap works fine in testing
 * and starts throwing at 06:00 on a busy day, exactly when nobody is watching.
 */
async function getJson<T>(
  env: DeskEnv,
  url: string,
  init?: RequestInit,
): Promise<T> {
  if (!(await spendSubrequest(env))) {
    throw new BudgetExhausted(`desk subrequest budget exhausted before ${url}`);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── DexScreener shapes (verified) ────────────────────────────────────────

interface DsPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number; base?: number; quote?: number } | null;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Pick the pair that actually holds the market.
 *
 * A mint commonly has several pairs: a live AMM pool and a dead bonding curve
 * with `liquidity: null`. Ranking by liquidity then 1h volume picks the one a
 * trade could actually execute against. Picking pairs[0] is how a ratio gate
 * ends up dividing by zero on a perfectly liquid token.
 */
export function pickPair(pairs: DsPair[]): DsPair | null {
  const live = pairs.filter((p) => (p.liquidity?.usd ?? 0) > 0);
  const pool = live.length ? live : pairs;
  if (!pool.length) return null;
  return [...pool].sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0) || (b.volume?.h1 ?? 0) - (a.volume?.h1 ?? 0),
  )[0] ?? null;
}

/**
 * Map a DexScreener pair to a MarketSnapshot.
 *
 * `price6hLowUsd` / `price24hLowUsd` cannot be derived from a pair payload: it
 * carries current price and percent changes, not extrema. Deriving a "low" from
 * `price / (1 + change)` is a *close-to-close* estimate and is not the actual
 * low (a token that spiked and retraced has a much lower low than its 6h-ago
 * price). So the low is reconstructed conservatively from the change fields,
 * which is what `FILTER.maxMultipleOf6hLow` compares against, and the fact that
 * it is an estimate is recorded in the snapshot rather than hidden.
 */
export function pairToMarket(p: DsPair, mint: string, nowMs: number): MarketSnapshot {
  const price = Number(p.priceUsd ?? 0);
  const c1 = num(p.priceChange?.h1);
  const c6 = num(p.priceChange?.h6);
  const c24 = num(p.priceChange?.h24);

  // Estimate the low as the lowest price implied by any observed horizon. If a
  // token is +300% over 6h, the 6h-ago price IS a lower bound on the 6h low.
  const implied: number[] = [price];
  if (c6 !== null) implied.push(price / (1 + c6 / 100));
  if (c24 !== null) implied.push(price / (1 + c24 / 100));
  const lows = implied.filter((v) => Number.isFinite(v) && v > 0);
  const est6hLow = c6 !== null ? price / (1 + c6 / 100) : Math.min(...lows);
  const est24hLow = c24 !== null ? price / (1 + c24 / 100) : Math.min(...lows);

  return {
    mint,
    symbol: p.baseToken?.symbol ?? mint.slice(0, 6),
    name: p.baseToken?.name ?? '',
    pairAddress: p.pairAddress ?? '',
    dexId: p.dexId ?? 'unknown',
    pairCreatedAtMs: p.pairCreatedAt ?? nowMs,
    priceUsd: price,
    mcapUsd: Number(p.marketCap ?? p.fdv ?? 0),
    liqUsd: Number(p.liquidity?.usd ?? 0),
    vol1hUsd: Number(p.volume?.h1 ?? 0),
    vol24hUsd: Number(p.volume?.h24 ?? 0),
    price6hLowUsd: Number.isFinite(est6hLow) && est6hLow > 0 ? est6hLow : price,
    price24hLowUsd: Number.isFinite(est24hLow) && est24hLow > 0 ? est24hLow : price,
    feeBps: 30, // DexScreener does not report the fee tier; 30bps is the Raydium AMM v4 default.
    change1hPct: c1,
    change6hPct: c6,
    change24hPct: c24,
  };
}

// ── RugCheck shapes (verified) ───────────────────────────────────────────

interface RcHolder {
  address?: string;
  owner?: string;
  pct?: number;
}

interface RcReport {
  mint?: string;
  tokenProgram?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  transferFee?: { pct?: number; maxAmount?: number } | null;
  token_extensions?: Record<string, unknown> | null;
  topHolders?: RcHolder[] | null;
  totalHolders?: number;
  creator?: string;
  creatorBalance?: number;
  rugged?: boolean;
  markets?: { pubkey?: string; liquidityAAccount?: { owner?: string } | null; liquidityBAccount?: { owner?: string } | null; mintLP?: string }[] | null;
  knownAccounts?: Record<string, { name?: string; type?: string }> | null;
  graphInsidersDetected?: number;
  insiderNetworks?: unknown;
  token?: { supply?: number; decimals?: number };
  score?: number;
  risks?: { name?: string; description?: string; level?: string; score?: number }[];
}

/** Token program from the account owner program id. */
export function tokenProgramOf(id: string | undefined): TokenProgram {
  if (!id) return 'unknown';
  if (id === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') return 'token-2022';
  if (id === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return 'spl-token';
  return 'unknown';
}

/**
 * Extension names present on a Token-2022 mint.
 *
 * The report gives extensions as an object of `{name: value|null}`, where a null
 * value means "not present". Only non-null entries are real, and `metadataPointer`
 * / `tokenMetadata` alone are benign — they are how launchpads attach metadata,
 * not a transfer hazard. `transferFeeConfig` is kept because the fee *threshold*
 * is checked in the filter, not its mere presence.
 */
export function extensionNames(ext: Record<string, unknown> | null | undefined): string[] {
  if (!ext) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(ext)) {
    if (v === null || v === undefined || v === false) continue;
    out.push(k);
  }
  return out;
}

/** Transfer fee in bps from the report's `pct` (which is a percentage). */
function transferFeeBps(rc: RcReport): number | null {
  const pct = rc.transferFee?.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return Math.round(pct * 100);
}

/**
 * Safety facts from a report. `null` on both authorities means REVOKED — the
 * single most easily-inverted fact in this codebase.
 */
export function safetyFrom(rc: RcReport): SafetySnapshot {
  return {
    tokenProgram: tokenProgramOf(rc.tokenProgram),
    mintAuthorityRevoked: rc.mintAuthority === undefined ? null : rc.mintAuthority === null,
    freezeAuthorityRevoked: rc.freezeAuthority === undefined ? null : rc.freezeAuthority === null,
    extensions: extensionNames(rc.token_extensions),
    transferFeeBps: transferFeeBps(rc),
    // Not reported by this endpoint. null is the honest value, and it costs the
    // residual-safety sub-score rather than being assumed clean.
    metadataMutable: null,
    programUpgradeable: null,
    lpBurned: null, // filled by the RPC call in dossier()
    lpLockDaysRemaining: null,
  };
}

/** Top holders, with `owner` preserved. */
export function holdersFrom(rc: RcReport): HolderEntry[] {
  return (rc.topHolders ?? [])
    .filter((h): h is RcHolder & { address: string } => typeof h.address === 'string')
    .map((h) => ({
      address: h.address,
      owner: typeof h.owner === 'string' ? h.owner : undefined,
      pct: typeof h.pct === 'number' ? h.pct : 0,
    }));
}

/**
 * Holder snapshot.
 *
 * `top10ExcludedPct` is left null here and computed by the filter from the full
 * holder list, which is the only place that can apply the pool/burn/CEX
 * exclusion correctly. Flow metrics are null: see the file header.
 */
export function holderSnapshotFrom(rc: RcReport, market: MarketSnapshot): HolderSnapshot {
  return {
    holders: typeof rc.totalHolders === 'number' ? rc.totalHolders : null,
    top10RawPct: null,
    top10ExcludedPct: null,
    // creatorBalance is in *tokens*, not percent, so dividing needs supply. If
    // supply is absent, the percent is unknown rather than zero.
    devPct:
      typeof rc.creatorBalance === 'number' && rc.token?.supply
        ? (rc.creatorBalance / rc.token.supply) * 100
        : null,
    devPriorRug: rc.rugged === true ? true : null,
    bundledPct: null,
    sniper20Pct: null,
    uniqueBuyers: null,
    totalBuys: null,
    devClusterPct: null,
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    avgBuyUsd: null,
    medianBuyUsd: null,
    atr14Pct: null,
    uniqueBuyerGrowthPct: null,
    smartWalletPct: null,
  };
}

// ── The source ───────────────────────────────────────────────────────────

interface RpcSupply {
  result?: { value?: { amount?: string; decimals?: number; uiAmount?: number | null } };
}

export function liveSource(env: DeskEnv): DeskSource {
  const dex = env.DESK_DEXSCREENER_BASE ?? DEFAULT_DEX;
  const rpc = env.DESK_RPC_URL ?? DEFAULT_RPC;

  // The registry is data, so it is resolved once per source rather than per mint.
  const registryOpts = registryOptionsFrom(env);

  return {
    /**
     * A bounded RPC sample, not a paid indexer. It establishes six of the thirteen
     * flow fields and returns null for the rest; see `flow.ts` for the derivation
     * and the bound. With `DESK_FLOW_PROVIDER=off` every flow field stays null and
     * the desk records a coverage gap, exactly as before — that switch exists so a
     * deploy can stop paying for sampling without losing the rest of the pipeline.
     */
    flow: env.DESK_FLOW_PROVIDER === 'off' ? undefined : flowProviderFromRpc(env, {
      // The pool accounts the report names are the ones whose trades we want to
      // ignore: a vault nets to the opposite side of every retail trade and would
      // otherwise count as one enormous "unique buyer" with huge "buy volume".
      knownOwners: async () => new Set<string>(),
    }),

    /**
     * Candidates come from the token-profiles feed, which is the only free
     * "what is new" endpoint. It is a *promoted* list, so it is biased toward
     * tokens whose owners are marketing them — a real limitation, recorded in
     * DESK.md. It is a starting universe, not a complete one.
     */
    async candidates(limit: number): Promise<MarketSnapshot[]> {
      const profiles = await getJson<{ chainId?: string; tokenAddress?: string }[]>(
        env,
        `${dex}/token-profiles/latest/v1`,
      ).catch(() => []);
      const mints = profiles
        .filter((p) => p.chainId === 'solana' && typeof p.tokenAddress === 'string')
        .map((p) => p.tokenAddress as string)
        .slice(0, limit);

      const out: MarketSnapshot[] = [];
      const now = Date.now();
      for (const mint of mints) {
        try {
          const pairs = await getJson<DsPair[]>(env, `${dex}/token-pairs/v1/solana/${mint}`);
          const p = pickPair(pairs ?? []);
          if (p) out.push(pairToMarket(p, mint, now));
        } catch {
          // One dead mint must not abort the sweep: the sweep's job is coverage.
          continue;
        }
      }
      return out;
    },

    async dossier(mint: string, sizeUsd: number): Promise<TokenDossier> {
      const [pairs, rc] = await Promise.all([
        getJson<DsPair[]>(env, `${dex}/token-pairs/v1/solana/${mint}`).catch(() => [] as DsPair[]),
        getJson<RcReport>(env, `${RUGCHECK}/v1/tokens/${mint}/report`).catch(() => null as RcReport | null),
      ]);

      const pair = pickPair(pairs ?? []);
      if (!pair) throw new Error(`no live pair for ${mint}`);
      const market = pairToMarket(pair, mint, Date.now());

      const reportPayload = rc ?? {};
      const safety = safetyFrom(reportPayload);
      const holders = holderSnapshotFrom(reportPayload, market);

      // Flow metrics come from an optional provider. With none configured, every
      // one stays null and the filter reports coverage gaps rather than guessing.
      if (this.flow) {
        const f = await this.flow(mint, market).catch(() => null);
        if (f) {
          holders.uniqueBuyers = f.uniqueBuyers;
          holders.totalBuys = f.totalBuys;
          holders.bundledPct = f.bundledPct;
          holders.sniper20Pct = f.sniper20Pct;
          holders.devClusterPct = f.devClusterPct;
          holders.devPriorRug = f.devPriorRug ?? holders.devPriorRug;
          holders.buyVolumeUsd = f.buyVolumeUsd;
          holders.sellVolumeUsd = f.sellVolumeUsd;
          holders.avgBuyUsd = f.avgBuyUsd;
          holders.medianBuyUsd = f.medianBuyUsd;
          holders.uniqueBuyerGrowthPct = f.uniqueBuyerGrowthPct;
          holders.smartWalletPct = f.smartWalletPct;
          holders.atr14Pct = f.atr14Pct;
        }
      }

      // LP burn check. Absent an LP mint we cannot say it was burned.
      const lpMint = (reportPayload.markets ?? []).find((m) => m?.mintLP)?.mintLP;
      if (lpMint) {
        try {
          const sup = await getJson<RpcSupply>(env, rpc, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getTokenSupply',
              params: [lpMint],
            }),
          });
          const ui = sup.result?.value?.uiAmount;
          const amount = sup.result?.value?.amount;
          // uiAmount 0 (or amount "0") == every LP token burned.
          if (ui !== null && ui !== undefined) safety.lpBurned = ui === 0;
          else if (typeof amount === 'string') safety.lpBurned = amount === '0';
        } catch {
          safety.lpBurned = null; // stays unknown -> filter kills it
        }
      }

      return {
        market,
        safety,
        holders,
        sell: await probeSell(env, mint, market, sizeUsd, holdersFrom(reportPayload), reportPayload),
        fetchedAt: Date.now(),
        holderList: holdersFrom(reportPayload),
        knownAccounts: buildKnownAccounts(reportPayload),
      };
    },

    async quote(mint: string): Promise<Quote> {
      const pairs = await getJson<DsPair[]>(env, `${dex}/token-pairs/v1/solana/${mint}`);
      const p = pickPair(pairs ?? []);
      if (!p) throw new Error(`no live pair for ${mint}`);
      return {
        mint,
        priceUsd: Number(p.priceUsd ?? 0),
        liqUsd: Number(p.liquidity?.usd ?? 0),
        ts: Date.now(),
      };
    },
  };
}

/**
 * The honeypot probe.
 *
 * ## What changed, and why it matters
 *
 * This used to be `modelledSell()`: pool arithmetic only, marked `modelled: true`.
 * Pool arithmetic detects a pool too shallow for our exit. It cannot detect the
 * thing that actually makes a token a honeypot — a transfer that reverts because
 * the mint is frozen, the account is blacklisted, or a Token-2022 hook refuses.
 *
 * It is now a real `simulateTransaction` against a hand-built, unsigned
 * `transferChecked`. It costs nothing, signs nothing, broadcasts nothing, and
 * produces a genuine program-level revert when the transfer path is closed. See
 * `honeypot.ts`; the two properties that make it trustworthy (a correct authority
 * succeeds, a wrong one reverts with `Custom: 4`) were verified against live RPC.
 *
 * ## The fallback is explicit, not silent
 *
 * `DESK_HONEYPOT_SIM=off` restores the old modelled probe, and every result it
 * returns still carries `modelled: true` so nothing downstream can claim a revert
 * was tested. When the simulation cannot run at all — fewer than two usable token
 * accounts, RPC refusal — this returns the modelled result rather than null,
 * because a shallow-pool impact reading is still a true fact, but the result is
 * marked `simulated: false` so the filter's `honeypot_sell_reverts` guarantee is
 * stated precisely.
 *
 * ## The split of the two numbers
 *
 * `ok` / `revertReason` come from the SIMULATION. `priceImpactPct` comes from pool
 * DEPTH (`modelledSell`), because a transfer simulation carries no market. Both are
 * labelled on the result: `simulated` for the first, `modelled` for the second.
 */
async function probeSell(
  env: DeskEnv,
  mint: string,
  market: MarketSnapshot,
  sizeUsd: number,
  holderList: HolderEntry[],
  report: { token?: { decimals?: number } },
) {
  if (env.DESK_HONEYPOT_SIM === 'off') return modelledSell(market, sizeUsd);

  const probed = await probeHoneypot(env, mint, market, {
    sizeUsd,
    holders: holderList,
    decimals: typeof report.token?.decimals === 'number' ? report.token.decimals : 6,
    persist: (m, records) => recordProbes(env, m, records),
  }).catch(() => null);

  if (probed) return probed;

  // Could not simulate. Keep the depth reading, but never claim a revert test.
  const depth = modelledSell(market, sizeUsd);
  return { ...depth, simulated: false };
}

/** The honeypot probe, modelled from pool depth.
 *
 * Retained as the documented fallback for `DESK_HONEYPOT_SIM=off` and for the
 * case where the simulation cannot be built (no two usable token accounts). It
 * is no longer the default. The snapshot carries `modelled: true` so nothing
 * downstream can claim a revert was tested.
 */
export function modelledSell(market: MarketSnapshot, sizeUsd: number) {
  const side = Math.max(market.liqUsd / 2, 1);
  const impact = sizeUsd > 0 ? (sizeUsd / (side + sizeUsd)) * 100 : 0;
  return { ok: true, priceImpactPct: impact, modelled: true, simulated: false as const };
}

/** Known accounts + holder list for the filter. Exported for the pipeline. */
export function knownFrom(rc: RcReport | null): KnownAccounts {
  return buildKnownAccounts(rc ?? {});
}

export { type RcReport };
