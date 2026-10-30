/**
 * Source parsers — pure functions from a decoded JSON body to candidates.
 *
 * WHY THIS FILE EXISTS
 *
 * The Worker has a subrequest ceiling, and the feeds are large (DeFiLlama is
 * 9.4 MB in one response). Spending a subrequest is therefore a decision, and a
 * decision made by a function that also touches the network cannot be tested.
 * So the split is rigid:
 *
 *   fetch (collect.ts, 1 subrequest per source)  ->  parse (this file, pure)
 *
 * Nothing here reads a clock, a global, `fetch`, or `Math.random`. Given the
 * same JSON it produces the same candidates, which is what lets the tests in
 * `tests/targets*.test.mjs` run with no network at all.
 *
 * EVERY RECORD LANDS IN EXACTLY ONE BUCKET. `records_seen` counts the records
 * that were considered, and each of them either becomes a candidate or is
 * counted in a drop bucket. The identity
 *
 *     records_seen === candidates.length + sum(drops)
 *
 * is asserted in the tests. Without it, "the feed changed shape" and "the feed
 * had nothing for us" both show up as an empty list, which is the failure mode
 * that makes an empty inventory look like a clean one.
 */

import { addressFamily, isEvmAddress, splitChainPrefixedAddress } from './address.js';
import { resolveAddressPrefix, resolveChainId } from './chain-map.js';
import type { Candidate, SourceId } from './types.js';

/** Per-source parse output, before cross-source dedupe. */
export interface ParseResult {
  source: SourceId;
  candidates: Candidate[];
  /** Records considered: entries carrying a usable-looking address field. */
  records_seen: number;
  /** Records that carried NO address field at all (nothing to resolve). */
  without_address: number;
  /** Dropped because the chain they named is not in the registry, by that name. */
  dropped_by_chain_name: Record<string, number>;
  /** Dropped because nothing named a chain. */
  dropped_no_chain: number;
  /** Dropped because the address failed its family's grammar. */
  dropped_malformed: number;
}

function emptyResult(source: SourceId): ParseResult {
  return {
    source,
    candidates: [],
    records_seen: 0,
    without_address: 0,
    dropped_by_chain_name: {},
    dropped_no_chain: 0,
    dropped_malformed: 0,
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** The `.tokens` array of a token list, tolerating both documented shapes. */
function tokenArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const tokens = (body as { tokens?: unknown }).tokens;
    if (Array.isArray(tokens)) return tokens;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse `https://api.llama.fi/protocols`.
 *
 * CHAIN RESOLUTION ORDER, and why it is this order:
 *
 *   1. THE ADDRESS PREFIX. `base:0x…` names the chain of that address. This is
 *      the strongest signal because it is attached to the address itself.
 *   2. THE ENTRY-LEVEL `chain` FIELD. Used only when the address is bare.
 *
 * The entry-level field is deliberately second, not first: 1042 entries whose
 * `chain` reads `Multi-Chain` still carry a prefixed address, and `Multi-Chain`
 * is a statement about the protocol's footprint, not about the address. Putting
 * it first would throw away 41 Base and 19 Solana addresses that the prefix
 * resolves perfectly.
 *
 * A BARE ADDRESS UNDER A `Multi-Chain`/null ENTRY IS DROPPED, not guessed. 624
 * such records exist; the codebase's own rule is that an address does not
 * identify its chain, so inventing one here would recreate exactly the bug
 * `chains.ts` was written to remove.
 */
export function parseDefiLlama(body: unknown): ParseResult {
  const out = emptyResult('defillama');
  if (!Array.isArray(body)) return out;

  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const addressField = str(entry['address']);
    if (addressField === null) {
      out.without_address++;
      continue;
    }

    const split = splitChainPrefixedAddress(addressField);
    if (split === null) {
      out.without_address++;
      continue;
    }
    out.records_seen++;

    // 1. the prefix on the address, when the source gave one
    let resolution = split.prefix !== null
      ? resolveAddressPrefix(split.prefix)
      : { kind: 'absent' as const };

    // 2. only then the entry-level chain field
    if (resolution.kind === 'absent' || resolution.kind === 'not-a-chain') {
      resolution = resolveAddressPrefix(entry['chain']);
    }

    if (resolution.kind === 'absent' || resolution.kind === 'not-a-chain') {
      out.dropped_no_chain++;
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      // Ambiguity is not the same as unknown: the source named a chain we
      // refuse to guess between, so it is counted under that name.
      bump(out.dropped_by_chain_name, resolution.name);
      continue;
    }
    if (resolution.kind === 'unregistered') {
      // Report the source's own spelling (`bsc`, `avax`, `era`) rather than
      // translating it: the operator needs to see what the feed said to decide
      // whether that chain is worth adding to the registry.
      bump(out.dropped_by_chain_name, resolution.name);
      continue;
    }

    const name = str(entry['name']) ?? '(unnamed protocol)';
    const category = str(entry['category']) ?? undefined;
    const tvl = finiteNumber(entry['tvl']);

    if (resolution.kind === 'svm') {
      if (addressFamily(split.body) !== 'svm') {
        // e.g. DeFiLlama's `solana:token/EdAh…` (Fabric): a prefixed label with
        // a body that is not a pubkey. Malformed, not a Solana target.
        out.dropped_malformed++;
        continue;
      }
      const c: Candidate = {
        family: 'svm',
        chain_id: null,
        cluster: 'mainnet-beta',
        address: split.body,
        name,
        kind: 'protocol',
        source: 'defillama',
        also_in: [],
      also_known_as: [],
      };
      if (category !== undefined) c.category = category;
      if (tvl !== undefined) c.tvl_usd = tvl;
      out.candidates.push(c);
      continue;
    }

    if (!isEvmAddress(split.body)) {
      out.dropped_malformed++;
      continue;
    }
    const c: Candidate = {
      family: 'evm',
      chain_id: resolution.chain_id,
      address: split.body,
      name,
      kind: 'protocol',
      source: 'defillama',
      also_in: [],
      also_known_as: [],
    };
    if (category !== undefined) c.category = category;
    if (tvl !== undefined) c.tvl_usd = tvl;
    out.candidates.push(c);
  }

  return out;
}

/**
 * Parse a CoinGecko-format token list
 * (`https://tokens.coingecko.com/<list>/all.json`).
 *
 * `chainId` is a number here and is validated against `CHAINS` through
 * `resolveChainId`, so a list for a chain we cannot fork yields zero candidates
 * and a `chainId:<n>` drop rather than a target on a chain with no RPC.
 *
 * NAME FALLBACK: `name` is used when present, `symbol` otherwise. Both absent
 * means the token is still a real address, so it is emitted as `(unnamed token)`
 * rather than dropped — a nameless target is still forkable, whereas inventing a
 * name would put fiction into every downstream report.
 */
export function parseTokenList(body: unknown, source: SourceId): ParseResult {
  const out = emptyResult(source);
  const tokens = tokenArray(body);
  if (tokens === null) return out;

  for (const raw of tokens) {
    if (!raw || typeof raw !== 'object') continue;
    const token = raw as Record<string, unknown>;
    const addressField = str(token['address']);
    if (addressField === null) {
      out.without_address++;
      continue;
    }
    out.records_seen++;

    const resolution = resolveChainId(token['chainId']);
    if (resolution.kind === 'absent' || resolution.kind === 'not-a-chain') {
      out.dropped_no_chain++;
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      bump(out.dropped_by_chain_name, resolution.name);
      continue;
    }
    if (resolution.kind === 'unregistered') {
      bump(out.dropped_by_chain_name, resolution.name);
      continue;
    }
    if (resolution.kind === 'svm') {
      // No token list in scope is a Solana list; if one appears, its addresses
      // would need the SVM path, which this function does not claim to parse.
      out.dropped_no_chain++;
      continue;
    }

    if (!isEvmAddress(addressField)) {
      out.dropped_malformed++;
      continue;
    }

    const c: Candidate = {
      family: 'evm',
      chain_id: resolution.chain_id,
      address: addressField,
      name: str(token['name']) ?? str(token['symbol']) ?? '(unnamed token)',
      kind: 'token',
      source,
      also_in: [],
      also_known_as: [],
    };
    out.candidates.push(c);
  }

  return out;
}
