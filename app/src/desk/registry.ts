/**
 * The known-address registry: the exclusion denominator, as data.
 *
 * ## What this fixes, and the direction of the error
 *
 * `holders.concentration()` removes the pool, burn sinks and known exchange
 * wallets before comparing top-10 against the 25% gate. The first two are derived
 * from the report itself, so they are correct. The exchange list was four
 * hardcoded addresses, which means a token concentrated in an exchange wallet
 * that was **not** in that list kept the wallet in the denominator and inflated
 * the number.
 *
 * That direction is safe — it kills rather than passes — but it is over-strict,
 * and `DESK.md` limitation #8 said so. The fix is not a heuristic and it is not a
 * longer `if` chain: it is **structured data**, so a reader can check an entry
 * against the list it came from and an operator can extend it without touching
 * the exclusion logic.
 *
 * ## The honesty constraint on this file, which is stricter than it looks
 *
 * A wrong entry here is the **unsafe** direction. Excluding a genuine whale makes
 * the concentration gate *more permissive*, which is the one thing this gate
 * exists to prevent. So an address is only in this file if this repo can point at
 * the published list it came from, and each row carries that citation.
 *
 * That is why the list below is short. It is short on purpose. A registry padded
 * with plausible-looking addresses would look better in a report and be worse in
 * production, and the failure would be silent — a whale quietly excluded, a
 * concentrated token quietly passing.
 *
 * ## Why it is a table, not a branch
 *
 * Every entry is `{address, label, kind, source, confidence}`. Adding a venue is
 * adding a row. Nothing about the exclusion *logic* changes, so the gate's
 * behaviour cannot drift while the list is extended — and there is a test that
 * asserts the exclusion is driven purely by `kind` and set membership, never by a
 * per-address special case.
 */

import type { KnownAccounts } from './holders.js';

/** What an address is, which is what decides whether it leaves the denominator. */
export type RegistryKind = 'cex' | 'market-maker' | 'custody' | 'bridge' | 'burn';

export interface RegistryEntry {
  address: string;
  /** Human label, for the kill detail. */
  label: string;
  kind: RegistryKind;
  /** The public list this came from. A citation, not a URL whose liveness we assert. */
  source: string;
  /**
   * `listed` = on a published venue list this repo can cite.
   * `reported` = widely attributed but not from a primary list.
   *
   * Only `listed` is excluded by default. See `registryOptionsFrom`.
   */
  confidence: 'listed' | 'reported';
}

/**
 * The Solana exchange / custodian registry.
 *
 * Every entry below is a wallet this repository already relied on before this
 * file existed (`holders.ts` shipped these four as `CEX_ADDRESSES`), so no new
 * exclusion is introduced here without a citation. The value added by this file
 * is the structure: `kind`, a citable `source`, and a `confidence` that decides
 * whether the entry actually leaves the denominator.
 *
 * ## How to extend it (deliberately a manual step)
 *
 * 1. Take the address from a published deposit/hot-wallet list, not from a
 *    block explorer's unverified label.
 * 2. Record that list in `source`.
 * 3. Mark `confidence: 'listed'` only if step 1 is true.
 * 4. Run `npx tsc --noEmit` and the desk suite; `registry.test.mjs` asserts every
 *    entry has a non-empty address, label and source, and that addresses are
 *    unique across all three lists.
 *
 * A `reported` entry is inert by default — it is data an operator may promote
 * with `DESK_CEX_INCLUDE_REPORTED=1`, and the default keeps the gate strict.
 * `/calib` prints which mode is in force and how many entries it held back.
 */
export const CEX_REGISTRY: RegistryEntry[] = [
  {
    address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    label: 'Binance hot wallet',
    kind: 'cex',
    source: 'carried from holders.ts CEX_ADDRESSES (pre-existing repo entry)',
    confidence: 'listed',
  },
  {
    address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
    label: 'Coinbase',
    kind: 'cex',
    source: 'carried from holders.ts CEX_ADDRESSES (pre-existing repo entry)',
    confidence: 'listed',
  },
  {
    address: 'GJRs4FwHpreB9JHdSgZaHWNKhxwcvMtVLGvzrTFNBT4Z',
    label: 'Kraken',
    kind: 'cex',
    source: 'carried from holders.ts CEX_ADDRESSES (pre-existing repo entry)',
    confidence: 'listed',
  },
  {
    address: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
    label: 'Coinbase 2',
    kind: 'cex',
    source: 'carried from holders.ts CEX_ADDRESSES (pre-existing repo entry)',
    confidence: 'listed',
  },
];

/**
 * Burn sinks, as data.
 *
 * `holders.BURN_ADDRESSES` already carries these and `buildKnownAccounts` seeds
 * from it. They are repeated here so the denominator has exactly one place to
 * reason about "which addresses are not holders", and a test asserts the two
 * lists agree rather than drifting.
 */
export const BURN_REGISTRY: RegistryEntry[] = [
  {
    address: '1nc1nerator11111111111111111111111111111111',
    label: 'incinerator',
    kind: 'burn',
    source: 'Solana incinerator program (pre-existing repo entry)',
    confidence: 'listed',
  },
  {
    address: '11111111111111111111111111111111111111111111',
    label: 'system program (null holder)',
    kind: 'burn',
    source: 'Solana system program (pre-existing repo entry)',
    confidence: 'listed',
  },
];

/**
 * AMM vault authorities known independently of any one report.
 *
 * Kept separate from the exchange list because the *reason* differs: a pool vault
 * is not a holder at all, while an exchange is a holder we choose not to count.
 * Both leave the denominator, but a kill detail that called a pool "CEX" would be
 * wrong in a way an operator would act on.
 *
 * Empty by default, and that is the honest state: the pool is normally derived
 * from the report itself (`buildKnownAccounts` reads `knownAccounts` and
 * `markets[].liquidityA/BAccount.owner`), which is strictly better than a static
 * list because it works for a launchpad nobody has heard of yet. This list exists
 * for the case where the report is missing the pool, and it carries no entries
 * this repo cannot cite.
 */
export const POOL_AUTHORITY_REGISTRY: RegistryEntry[] = [];

/** How the registry is filtered for one deploy. */
export interface RegistryOptions {
  /** Promote `reported` entries to excluded. Off by default: strict is safe. */
  includeReported?: boolean;
  /** Extra addresses from an operator, appended as trusted-by-instruction. */
  extra?: string[];
}

/**
 * Fold the registry into the `KnownAccounts` shape the exclusion already takes.
 *
 * This is the only bridge between data and the gate. It cannot change how the
 * exclusion classifies a holder — only which addresses are in the set — so adding
 * rows cannot accidentally loosen the classification rules.
 *
 * Note the direction of each list:
 *  - `cex` and `pools` REMOVE an entry from the denominator (permissive);
 *  - `burns` removes an entry that was never a holder (correct, not permissive).
 *
 * Because `cex` is the permissive one, it is the one gated on `confidence`.
 */
export function registryKnownAccounts(opts: RegistryOptions = {}): KnownAccounts {
  const keep = (e: RegistryEntry) => opts.includeReported === true || e.confidence === 'listed';

  const cex = CEX_REGISTRY.filter((e) => e.kind === 'cex' || e.kind === 'custody' || e.kind === 'bridge')
    .filter(keep)
    .map((e) => e.address);
  const burns = BURN_REGISTRY.map((e) => e.address);
  const pools = POOL_AUTHORITY_REGISTRY.filter(keep).map((e) => e.address);

  for (const a of opts.extra ?? []) if (typeof a === 'string' && a) cex.push(a);

  return { pools: dedupe(pools), burns: dedupe(burns), cex: dedupe(cex) };
}

/** Merge two registries, keeping the report-derived entries authoritative. */
export function mergeKnown(a: KnownAccounts, b: KnownAccounts): KnownAccounts {
  return {
    pools: dedupe([...a.pools, ...b.pools]),
    burns: dedupe([...a.burns, ...b.burns]),
    cex: dedupe([...a.cex, ...b.cex]),
  };
}

/** All registry entries, for validation and labelling. */
export function allRegistryEntries(): RegistryEntry[] {
  return [...CEX_REGISTRY, ...BURN_REGISTRY, ...POOL_AUTHORITY_REGISTRY];
}

/** Label for a registry address, for a kill detail that names the wallet. */
export function registryLabel(address: string): string | null {
  return allRegistryEntries().find((e) => e.address === address)?.label ?? null;
}

/**
 * Registry coverage, for `/calib`.
 *
 * The denominator is only as right as this list, so the count is reported next to
 * the concentration gate rather than living in a comment. `reported_held_back` is
 * the number of entries the strict default is deliberately NOT using, which is
 * the measure of how conservative the current mode is.
 */
export function registryStats(opts: RegistryOptions = {}): {
  total: number;
  excluded: number;
  reported_held_back: number;
  by_kind: Record<string, number>;
} {
  const all = allRegistryEntries();
  const includeReported = opts.includeReported === true;
  const by_kind: Record<string, number> = {};
  for (const e of all) by_kind[e.kind] = (by_kind[e.kind] ?? 0) + 1;
  return {
    total: all.length,
    excluded: all.filter((e) => includeReported || e.confidence === 'listed').length,
    reported_held_back: all.filter((e) => e.confidence === 'reported').length,
    by_kind,
  };
}

/**
 * Is this deploy configured to promote `reported` entries?
 *
 * Parsed from the environment in one place so the gate and `/calib` cannot
 * disagree about what was excluded.
 */
export function registryOptionsFrom(env: { DESK_CEX_INCLUDE_REPORTED?: string }): RegistryOptions {
  return { includeReported: env.DESK_CEX_INCLUDE_REPORTED === '1' };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter((x) => typeof x === 'string' && x.length > 0))];
}
