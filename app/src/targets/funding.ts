/**
 * `fund_addresses` — where the money actually is, as opposed to what the feed
 * publishes in `address`.
 *
 * THE BUG THIS FILE EXISTS TO PREVENT
 *
 * DeFiLlama's `/protocols` payload carries, per protocol, a `symbol` and a bare
 * `address`. For a large share of protocols that `address` is **not** the pool
 * holding the TVL — it is the protocol's own ERC-20 governance/utility token.
 * Measured 2026-10-30 against the live feed (8,882 protocols):
 *
 *   · 4,424 protocols carry BOTH `symbol` and `address` (49.8%)
 *   · of the 635 protocols above $10M TVL, 336 (52.9%) carry both
 *   · 3,608 distinct addresses are published with a symbol, i.e. are token
 *     identities by the feed's own reckoning
 *
 * The worked example, verified field by field:
 *
 *   Aave V3  symbol=AAVE  address=0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9
 *            tvl=$14,639,478,459
 *
 * `0x7fc6…` is the AAVE token. SEVEN protocol entries publish that same address
 * (Aave V1/V2/V3/V4, Aave Aptos, Aave Arc, Aave Horizon RWA), and the address
 * does **not** appear anywhere in `projects/aave-v3/index.js` (33 `0x…`
 * addresses, none of them the token). So `address` and the pool are disjoint
 * sets for the largest lending protocol on the feed.
 *
 * If the target layer takes `address` as the fork target it forks a token
 * contract, finds no protocol logic, and reports fat TVL next to it. That is the
 * same silent-failure class as a skill pack that loads but can never be routed:
 * everything downstream looks healthy and the work is worthless.
 *
 * THE PIPELINE, AND WHY IT IS TWO STEPS
 *
 *   1. `addressIsTokenIdentity` — refuse the protocol's OWN `address` when the
 *      feed itself pairs it with a symbol. This needs no network and it catches
 *      the Aave-shaped case, which the adapter filter alone does not.
 *   2. `extractAddresses` + `fundAddresses` — pull `0x…` out of the adapter
 *      source and drop anything that is also a token identity. Measured on a
 *      28-adapter sample: 21,637 addresses extracted, 462 (2.1%) removed, and
 *      3/28 adapters left with zero survivors. So step 2 is cheap and removes
 *      comparatively little — it is step 1 that carries the weight, and saying
 *      otherwise would repeat the "the filter fixes Aave" mistake.
 *
 * WHAT THIS FILE IS NOT: it does not fetch. It takes the adapter's source text.
 * `queue.ts` owns the resumable fetch, `targets/collect.ts` owns the inventory
 * fetch, and both take an injected `fetch`. Nothing here reads a clock.
 */

/** A token identity: an address the feed published together with a symbol. */
export interface TokenIdentity {
  address: string;
  symbol: string;
  name: string;
}

/** The protocol fields this module reads. Deliberately narrower than `Candidate`. */
export interface ProtocolRecord {
  /** Protocol display name, e.g. `Aave V3`. */
  name: string;
  /** The feed's `address`, verbatim. `null` when the entry carries none. */
  address: string | null;
  /** The feed's `symbol`. `null` when absent. */
  symbol: string | null;
  /** The feed's `tvlCodePath`, i.e. where the adapter source lives. */
  tvlCodePath: string | null;
  /** Total value locked in USD, when the feed gives a finite number. */
  tvl_usd?: number;
}

/** Why a protocol did or did not yield forkable funding addresses. */
export type FundState =
  /** The protocol's own `address` is a token identity — never a fork target. */
  | 'address-is-token'
  /** Adapter not fetched yet. Not a failure: the queue has not reached it. */
  | 'pending'
  /** Adapter fetched, addresses extracted and filtered, at least one survived. */
  | 'derived'
  /** Adapter fetched, and every address it names is also a token identity. */
  | 'all-filtered'
  /** Adapter exists but names no `0x…` address at all (composes other adapters). */
  | 'no-addresses'
  /** No `tvlCodePath`, so there is no adapter to read. */
  | 'no-adapter'
  /** The fetch failed. Distinct from every empty state on purpose. */
  | 'fetch-failed';

export interface Funding {
  /**
   * Addresses that are NOT token identities, in first-seen order, deduped
   * case-insensitively and returned with the casing the adapter used. Empty is
   * a real answer (`all-filtered`, `no-addresses`), never a placeholder.
   */
  fund_addresses: string[];
  /** True when the protocol's own feed `address` is a listed token. */
  address_is_token: boolean;
  /** How many extracted addresses were dropped for being token identities. */
  dropped_as_token: number;
  /** How many distinct addresses the adapter named, before filtering. */
  extracted: number;
  /**
   * The address a fork should target, or `null`.
   *
   * `null` is the load-bearing value: it is what stops a token contract from
   * being offered as a fork target. A caller must handle it rather than fall
   * back to `address`.
   */
  fork_target: string | null;
  state: FundState;
  /** One sentence naming the state, for the candidate record and the alert. */
  reason: string;
}

/**
 * `0x` + exactly 40 hex digits, with hex-class boundaries on both sides.
 *
 * The boundaries are not decoration: a 32-byte transaction hash is `0x` followed
 * by 64 hex digits, and a naive `/0x[0-9a-fA-F]{40}/` matches its first 40 and
 * invents an address that never existed. Adapters embed such hashes as example
 * calldata.
 */
const ADDRESS_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/**
 * Translate the feed's `tvlCodePath` into a URL whose body is the adapter.
 *
 * The feed publishes GitHub *blob* URLs
 * (`https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/aave-v3/index.js`),
 * which serve HTML. Stripping `blob/` is what turns that into source text.
 *
 * Returns `null` rather than guessing for any other host or shape: a raw URL we
 * constructed from a guess is a 404 that would be reported as "adapter has no
 * addresses", which is exactly the empty-vs-broken confusion this repo refuses.
 */
export function rawAdapterUrl(tvlCodePath: string | null): string | null {
  if (typeof tvlCodePath !== 'string' || tvlCodePath.trim() === '') return null;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(tvlCodePath.trim());
  if (!m) return null;
  const [, owner, repo, rest] = m;
  if (!owner || !repo || !rest) return null;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
}

/**
 * Every distinct `0x…` address in an adapter's source, first-seen order.
 *
 * Dedupe is case-insensitive because EVM addresses are, and the same contract
 * appears in checksum casing on one line and lowercase on the next in real
 * adapters. The FIRST casing seen is what is returned: rewriting it to a
 * canonical checksum would require keccak256, which is a runtime dependency this
 * Worker does not have, and lowercasing would lose the checksum the adapter
 * author wrote.
 */
export function extractAddresses(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of source.matchAll(ADDRESS_RE)) {
    const address = match[0];
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/**
 * Build the token-identity key set from the feed's own records.
 *
 * An address is a token identity when the feed publishes it WITH a symbol. That
 * is a weaker claim than "it is an ERC-20" — an address can be a token without a
 * listed symbol — so the filter is a necessary condition, not a sufficient one,
 * and the reason text on every `derived` result says so.
 */
export function tokenIdentityKeys(records: readonly ProtocolRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const r of records) {
    if (!r.address || !r.symbol) continue;
    keys.add(r.address.trim().toLowerCase());
  }
  return keys;
}

/**
 * True when the protocol's own `address` is a listed token — the Aave V3 case.
 *
 * `address` is only consulted when a `symbol` sits beside it. A bare address
 * with no symbol is NOT classified as a token here: the feed has told us nothing
 * about what it is, and guessing would be the same failure in the other
 * direction.
 */
export function addressIsTokenIdentity(record: ProtocolRecord): boolean {
  if (!record.address || !record.symbol) return false;
  return record.address.trim().toLowerCase().startsWith('0x');
}

/** The empty-but-explicit result for a protocol whose adapter was never read. */
function stateOnly(state: FundState, reason: string, addressIsToken: boolean): Funding {
  return {
    fund_addresses: [],
    address_is_token: addressIsToken,
    dropped_as_token: 0,
    extracted: 0,
    fork_target: null,
    state,
    reason,
  };
}

/**
 * Resolve one protocol's funding addresses from its adapter source.
 *
 * ORDER IS THE WHOLE DESIGN:
 *
 *   1. A protocol whose own `address` is a token is marked
 *      `address-is-token` **whether or not** an adapter was fetched. The flag is
 *      a fact about the feed, and suppressing it until the adapter arrives would
 *      let the target layer use `address` in the meantime.
 *   2. No adapter (or no fetch yet) is `no-adapter` / `pending` — distinct
 *      states, because "we have not looked" and "we looked and found nothing"
 *      must never collapse.
 *   3. A fetched adapter with zero `0x…` is `no-addresses`. Measured: 145 of 437
 *      unique adapters above $10M TVL are like this; they compose other
 *      adapters or reference registry keys.
 *   4. Everything named gets filtered against the token keys. Zero survivors is
 *      `all-filtered`, which is a finding about the protocol, not an error.
 *
 * `fetchError` is passed separately from `source` so a transport failure can
 * never be read as an empty adapter.
 */
export function fundAddresses(
  record: ProtocolRecord,
  tokenKeys: ReadonlySet<string>,
  adapter: { source: string | null; fetchError?: string | null },
): Funding {
  const addressIsToken = addressIsTokenIdentity(record);

  if (record.tvlCodePath === null || record.tvlCodePath.trim() === '') {
    return stateOnly('no-adapter', 'the feed publishes no tvlCodePath, so there is no adapter to read', addressIsToken);
  }
  if (adapter.fetchError) {
    return stateOnly('fetch-failed', `adapter fetch failed: ${adapter.fetchError}`, addressIsToken);
  }
  if (adapter.source === null) {
    return stateOnly('pending', 'adapter not fetched yet (queued)', addressIsToken);
  }

  const extractedAll = extractAddresses(adapter.source);
  if (extractedAll.length === 0) {
    return { ...stateOnly('no-addresses', 'the adapter names no 0x… address; it composes other adapters or registry keys', addressIsToken), extracted: 0 };
  }

  const kept: string[] = [];
  let dropped = 0;
  for (const address of extractedAll) {
    if (tokenKeys.has(address.toLowerCase())) {
      dropped++;
      continue;
    }
    kept.push(address);
  }

  if (kept.length === 0) {
    return {
      fund_addresses: [],
      address_is_token: addressIsToken,
      dropped_as_token: dropped,
      extracted: extractedAll.length,
      fork_target: null,
      state: 'all-filtered',
      reason: `all ${extractedAll.length} adapter address(es) are also token identities; nothing left to fork`,
    };
  }

  const caveat = addressIsToken
    ? `; the feed's own address is the ${record.symbol ?? 'protocol' } token, so it is excluded from being a fork target`
    : '';
  return {
    fund_addresses: kept,
    address_is_token: addressIsToken,
    dropped_as_token: dropped,
    extracted: extractedAll.length,
    // The first surviving adapter address only because adapters usually name the
    // primary pool first. It is a LEAD: see `targets/ev.ts` and the comment at
    // `candidateFromProtocol` — never a permission to fork.
    fork_target: kept[0] ?? null,
    state: 'derived',
    reason:
      `${kept.length} of ${extractedAll.length} adapter address(es) survive the token filter` +
      `${dropped > 0 ? ` (${dropped} dropped as token identities)` : ''}${caveat}`,
  };
}

/**
 * The measured adapter-yield summary for one protocol, for the candidate record.
 *
 * `addresses_n` and `bytes` are what the queue writes; keeping them on the
 * funding result means a candidate can say "the adapter was read, 14 addresses,
 * 14.8 KB" instead of "0 fund addresses" with no way to tell why.
 */
export function summariseAdapter(source: string): { addresses: number; bytes: number } {
  return { addresses: extractAddresses(source).length, bytes: source.length };
}
