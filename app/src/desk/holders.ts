/**
 * Holder concentration, with the exclusion that makes the gate usable.
 *
 * Raw top-10 is a broken metric on a token that trades against a single pool.
 * Verified against a live pair (2026-10-29): on the pump.fun AMM pair for
 * `DPb1vNz5...pump`, the single largest holder at **11.93%** was not a wallet at
 * all — it was the AMM's own base-token vault, whose `owner` field is the pool
 * account `GfYJTeV46...`. On a token with a deeper pool that one entry alone
 * exceeds the 25% threshold, so a raw top-10 gate kills healthy young tokens
 * while looking strict.
 *
 * Two things follow, and both are implemented here:
 *
 *  1. **Match on `owner`, not just `address`.** A top-holders list is a list of
 *     *token accounts*; the thing that holds them is `owner`. The pool's token
 *     account address appears in no known-account list, so matching the address
 *     only silently fails to exclude the pool. That is the exact bug that makes
 *     the exclusion look implemented while doing nothing.
 *  2. **Derive the exclusion set from the source, not a hardcoded guess.** The
 *     known-account registry comes with the report (AMM / LOCKER / CREATOR /
 *     BURN / CEX types), plus the pair's market accounts. Hardcoding addresses
 *     would rot; deriving them is why this holds for a new launchpad.
 *
 * Failure mode, stated rather than hidden: the registry is incomplete, so a CEX
 * that is not in it stays in the denominator and inflates the number. That
 * direction is safe (it kills rather than passes) but it does mean this gate can
 * be over-strict on a token concentrated in an unlisted exchange wallet.
 */

/** Accounts that are structurally not "a holder" for concentration purposes. */
export interface KnownAccounts {
  /** LP pool / AMM vault accounts (owner authority of the pool's token accounts). */
  pools: string[];
  /** Incinerator / burn addresses. */
  burns: string[];
  /** Exchange and custody wallets. Incomplete by nature. */
  cex: string[];
}

/** The well-known Solana burn sinks. */
export const BURN_ADDRESSES = [
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111111111111111',
];

/**
 * A short, deliberately conservative CEX list. Wrong entries here are not
 * dangerous (excluding a real whale makes the gate *more* permissive), so only
 * venues we are confident about are listed. Everything else stays in the
 * denominator, which is the safe direction.
 */
export const CEX_ADDRESSES = [
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Binance hot wallet
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', // Coinbase
  'GJRs4FwHpreB9JHdSgZaHWNKhxwcvMtVLGvzrTFNBT4Z', // Kraken
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', // Coinbase 2
];

/**
 * One row of a top-holders list, as the report gives it.
 *
 * `owner` is the wallet or program that controls the token account. It is
 * optional only because some sources omit it; when absent, matching falls back
 * to the address, which is weaker but not wrong.
 */
export interface HolderEntry {
  /** Token account address. */
  address: string;
  /** Owner authority. This is what identifies the pool. */
  owner?: string;
  /** Share of supply, 0..100. */
  pct: number;
}

export interface ConcentrationResult {
  /** Naive top-10, as a scanner reports it. Kept for the audit trail. */
  rawTop10Pct: number;
  /** Top-10 after exclusions. This is the number the gate reads. */
  excludedTop10Pct: number;
  /** Which accounts were removed and why. Printed in the kill detail. */
  excluded: { address: string; pct: number; kind: 'pool' | 'burn' | 'cex' }[];
}

function classify(
  h: HolderEntry,
  known: KnownAccounts,
  burns: string[],
  cex: string[],
): 'pool' | 'burn' | 'cex' | null {
  // Check both identities. The pool's *token account* is in nobody's list; its
  // *owner* is the AMM account that is.
  const identities = [h.address, h.owner].filter((x): x is string => typeof x === 'string' && x.length > 0);
  for (const id of identities) {
    if (known.pools.includes(id)) return 'pool';
    if (known.burns.includes(id) || burns.includes(id)) return 'burn';
    if (known.cex.includes(id) || cex.includes(id)) return 'cex';
  }
  return null;
}

/**
 * Compute top-10 share both ways.
 *
 * `holders` must be sorted descending by pct. Ties are broken by address so the
 * result is deterministic — a fixture that produced 24.9% one run and 25.1% the
 * next would be a flaky test guarding the most important number in the filter.
 */
export function concentration(
  holders: HolderEntry[],
  known: KnownAccounts,
  extra: { burns?: string[]; cex?: string[] } = {},
): ConcentrationResult {
  const sorted = [...holders].sort((a, b) =>
    b.pct === a.pct ? a.address.localeCompare(b.address) : b.pct - a.pct,
  );

  const rawTop10Pct = sorted.slice(0, 10).reduce((s, h) => s + h.pct, 0);

  const burns = [...BURN_ADDRESSES, ...(extra.burns ?? [])];
  const cex = [...CEX_ADDRESSES, ...(extra.cex ?? [])];

  const excluded: ConcentrationResult['excluded'] = [];
  const kept: HolderEntry[] = [];
  for (const h of sorted) {
    const kind = classify(h, known, burns, cex);
    if (kind) excluded.push({ address: h.address, pct: h.pct, kind });
    else kept.push(h);
  }

  const excludedTop10Pct = kept.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  return { rawTop10Pct, excludedTop10Pct, excluded };
}

/**
 * Derive the exclusion set from a report payload.
 *
 * Accepts the shape RugCheck returns (verified live on 2026-10-29):
 *   - `knownAccounts`: { address: { name, type } }, type in AMM/LOCKER/CREATOR/BURN/CEX
 *   - `markets[]`: { pubkey, liquidityAAccount.owner, liquidityBAccount.owner }
 *
 * Only AMM/LOCKER accounts are treated as pools. CREATOR is deliberately NOT
 * excluded — the dev's own bag must count against the concentration and the dev
 * gate, otherwise the exclusion becomes a way to hide insider supply.
 */
export function buildKnownAccounts(report: {
  knownAccounts?: Record<string, { name?: string; type?: string }> | null;
  markets?: { pubkey?: string; liquidityAAccount?: { owner?: string } | null; liquidityBAccount?: { owner?: string } | null }[] | null;
}): KnownAccounts {
  const pools = new Set<string>();
  const burns = new Set<string>(BURN_ADDRESSES);
  const cex = new Set<string>(CEX_ADDRESSES);

  for (const [addr, meta] of Object.entries(report.knownAccounts ?? {})) {
    const t = (meta?.type ?? '').toUpperCase();
    if (t === 'AMM' || t === 'LOCKER' || t === 'POOL') pools.add(addr);
    else if (t === 'BURN' || t === 'INCINERATOR') burns.add(addr);
    else if (t === 'CEX' || t === 'EXCHANGE') cex.add(addr);
    // CREATOR intentionally ignored: see doc comment.
  }

  for (const m of report.markets ?? []) {
    for (const acc of [m?.liquidityAAccount, m?.liquidityBAccount]) {
      const owner = acc?.owner;
      if (typeof owner === 'string' && owner.length > 0) pools.add(owner);
    }
    if (typeof m?.pubkey === 'string' && m.pubkey.length > 0) pools.add(m.pubkey);
  }

  return { pools: [...pools], burns: [...burns], cex: [...cex] };
}
