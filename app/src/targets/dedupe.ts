/**
 * Dedupe and merge — one record per (chain, address), provenance preserved.
 *
 * WHY THIS FILE EXISTS
 *
 * The same contract legitimately appears in more than one feed: a Base DEX is in
 * DeFiLlama as a protocol AND in the CoinGecko Base token list as its token. That
 * is not a duplicate to discard blindly — the protocol entry knows the TVL and
 * the category, the token entry knows the symbol. Collapsing to one record while
 * throwing the other away loses whichever fact the discarded record carried.
 *
 * So merging is field-wise and deterministic:
 *
 *   · the record with the LOWER `sourcePriority` wins the identity (`source`,
 *     `name`, `kind`, `category`, `tvl_usd`), because protocol metadata is
 *     richer than a token symbol;
 *   · the loser's id is appended to `also_in`, so "we saw this in two feeds" is
 *     recorded rather than silently erased;
 *   · `kind` follows the winner: a contract listed as a protocol stays a
 *     protocol even if a token list also knows it.
 *
 * Ordering is stable (input order, dedupe keeps first occurrence), so two runs
 * over the same input produce byte-identical output. A non-deterministic merge
 * would make every downstream diff and every test flaky.
 */

import { candidateKey } from './types.js';
import type { Candidate, Collection, DropReport, SourceId, SourceStat } from './types.js';
import type { ParseResult } from './sources.js';

/**
 * Which source wins when the same address appears twice.
 *
 * Lower wins. DeFiLlama is first because it is the only source that supplies
 * `category` and `tvl_usd`; the token lists are second because they carry only a
 * symbol and decimals. This is also the order of the fetch budget in
 * `collect.ts`, so the intended order is the executed order.
 */
export const SOURCE_PRIORITY: Record<SourceId, number> = {
  defillama: 0,
  'coingecko-base': 1,
  'coingecko-uniswap': 2,
};

/**
 * Collapse records that name the same address on the same chain.
 *
 * Returns the surviving candidates in first-seen order and the number of records
 * that were absorbed.
 */
export function dedupeCandidates(input: readonly Candidate[]): {
  candidates: Candidate[];
  duplicates: number;
} {
  const byKey = new Map<string, Candidate>();
  let duplicates = 0;

  for (const candidate of input) {
    const key = candidateKey(candidate);
    const existing = byKey.get(key);
    if (existing === undefined) {
      // Copy the provenance array so a caller mutating the survivor's `also_in`
      // cannot reach back into the source parse result.
      byKey.set(key, { ...candidate, also_in: [...candidate.also_in], also_known_as: [...candidate.also_known_as] });
      continue;
    }
    duplicates++;

    const incumbentPriority = SOURCE_PRIORITY[existing.source];
    const challengerPriority = SOURCE_PRIORITY[candidate.source];

    if (challengerPriority < incumbentPriority) {
      // The challenger is richer: it becomes the identity, and the incumbent is
      // demoted to provenance. Nothing the incumbent knew is dropped — its id
      // joins `also_in`, and its name joins `also_known_as` if it differs.
      const merged: Candidate = {
        ...candidate,
        also_in: [...candidate.also_in, existing.source, ...existing.also_in].filter(
          (s, i, all) => s !== candidate.source && all.indexOf(s) === i,
        ),
        also_known_as: [
          ...candidate.also_known_as,
          existing.name,
          ...existing.also_known_as,
        ].filter((n, i, all) => n !== candidate.name && all.indexOf(n) === i),
      };
      byKey.set(key, merged);
      continue;
    }

    // The incumbent stays. Record the challenger's id at most once.
    if (existing.source !== candidate.source && !existing.also_in.includes(candidate.source)) {
      existing.also_in.push(candidate.source);
    }
    for (const extra of candidate.also_in) {
      if (extra !== existing.source && !existing.also_in.includes(extra)) {
        existing.also_in.push(extra);
      }
    }
    // Same address, different name: keep the alias rather than overwrite the
    // incumbent's name with the challenger's.
    for (const name of [candidate.name, ...candidate.also_known_as]) {
      if (name !== existing.name && !existing.also_known_as.includes(name)) {
        existing.also_known_as.push(name);
      }
    }
  }

  return { candidates: [...byKey.values()], duplicates };
}

/**
 * Fold per-source parse results into one {@link Collection}.
 *
 * The `DropReport.records_seen` is the sum across sources, and each bucket is
 * summed the same way, so the reconciliation identity holds on the merged total
 * exactly as it does per source. `emitted` counts survivors AFTER dedupe while
 * `records_seen` counts input records — so the identity that must balance is
 *
 *     records_seen === emitted + duplicates + (all drop buckets)
 *
 * which the tests assert.
 */
export function mergeCollections(
  parses: readonly ParseResult[],
  stats: readonly SourceStat[],
): Collection {
  const all: Candidate[] = [];
  const drops: DropReport = {
    by_chain_name: {},
    no_chain: 0,
    malformed_address: 0,
    records_seen: 0,
    emitted: 0,
    duplicates: 0,
  };

  for (const parse of parses) {
    all.push(...parse.candidates);
    drops.records_seen += parse.records_seen;
    drops.no_chain += parse.dropped_no_chain;
    drops.malformed_address += parse.dropped_malformed;
    for (const [name, count] of Object.entries(parse.dropped_by_chain_name)) {
      drops.by_chain_name[name] = (drops.by_chain_name[name] ?? 0) + count;
    }
  }

  const { candidates, duplicates } = dedupeCandidates(all);
  drops.duplicates = duplicates;
  drops.emitted = candidates.length;

  return { candidates, drops, by_source: [...stats] };
}

/** Candidates per chain id, for the coverage note and for the dashboard. */
export function countByChain(candidates: readonly Candidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) {
    // `svm` is a key here because a Solana candidate has no chain id. Writing
    // `null` into a record keyed by number would stringify to "null", which
    // reads like a chain called null.
    const key = c.family === 'evm' ? String(c.chain_id) : 'svm';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * The drop list sorted by count, descending, for a human-readable note.
 *
 * Ties break alphabetically so the note is stable between runs.
 */
export function topDroppedChains(
  drops: DropReport,
  limit = 10,
): Array<{ name: string; count: number }> {
  return Object.entries(drops.by_chain_name)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
