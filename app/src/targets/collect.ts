/**
 * Fetch — the only place in `targets/` that touches the network.
 *
 * WHY THE SEAM IS HERE AND NOT SOMEWHERE WIDER
 *
 * `sources.ts` is pure and takes a decoded body, so the tests never need a
 * network. This file owns the one impure step (get bytes, decode JSON) and takes
 * `fetch` as an injected dependency — the same shape `dispatch.ts` already uses
 * (`deps: { fetch: typeof fetch }`) — so a test can drive the whole pipeline
 * with fixture bodies and assert on the real code path rather than on a stub.
 *
 * THE BUDGET, STATED AS NUMBERS
 *
 * The Worker has a subrequest ceiling per invocation, so cost is a design input:
 *
 *   source                requests  body (observed, uncompressed)
 *   defillama                   1   ~9.4 MB
 *   coingecko-base              1   ~672 KB
 *   coingecko-uniswap           1   ~1.3 MB
 *
 * One request each: three subrequests total for a full refresh, which is
 * negligible against the ceiling. THE COST THAT MATTERS IS NOT SUBREQUESTS, IT IS
 * BYTES. DeFiLlama is 9.4 MB in a single response and has to be held in memory
 * and `JSON.parse`d in one go; on Workers that is the binding constraint long
 * before the subrequest count is. Hence {@link CollectionOptions.include}, which
 * lets a caller skip it.
 *
 * There is deliberately no retry loop. A feed that fails is reported as a failed
 * source and the rest of the collection still succeeds — one dead source must not
 * turn a refresh into zero targets.
 */

import { parseDefiLlama, parseTokenList } from './sources.js';
import { mergeCollections } from './dedupe.js';
import type { ParseResult } from './sources.js';
import type { Collection, SourceId, SourceStat } from './types.js';

export const SOURCE_URLS: Readonly<Record<SourceId, string>> = {
  defillama: 'https://api.llama.fi/protocols',
  'coingecko-base': 'https://tokens.coingecko.com/base/all.json',
  'coingecko-uniswap': 'https://tokens.coingecko.com/uniswap/all.json',
};

/**
 * Observed body sizes in bytes, measured on 2026-10-29 against the live feeds.
 *
 * Recorded rather than measured at runtime because the number is what a caller
 * needs to decide BEFORE spending the bytes.
 */
export const SOURCE_BYTES: Readonly<Record<SourceId, number>> = {
  defillama: 9435664,
  'coingecko-base': 672312,
  'coingecko-uniswap': 1348712,
};

/** Everything a full refresh costs, for a caller that wants one number. */
export function budgetFor(sources: readonly SourceId[]): { requests: number; bytes: number } {
  let requests = 0;
  let bytes = 0;
  for (const s of sources) {
    requests += 1;
    bytes += SOURCE_BYTES[s];
  }
  return { requests, bytes };
}

export interface Fetcher {
  (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface CollectionOptions {
  /** Which sources to read. Defaults to all three. */
  include?: readonly SourceId[];
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: Fetcher;
  /** Per-request timeout. A hung feed must not hold the invocation open. */
  timeout_ms?: number;
  /** Budget guard: skip DeFiLlama when its body would exceed this. */
  max_body_bytes?: number;
}

/** One source's outcome, so a partial refresh is visible rather than silent. */
export interface SourceOutcome {
  source: SourceId;
  ok: boolean;
  /** Failure detail when `ok` is false. Never a fabricated empty result. */
  error?: string;
  /** True when the source was skipped by the byte budget rather than failing. */
  skipped?: boolean;
}

export interface Collected {
  collection: Collection;
  outcomes: SourceOutcome[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

const PARSERS: Record<SourceId, (body: unknown) => ParseResult> = {
  defillama: parseDefiLlama,
  'coingecko-base': (body) => parseTokenList(body, 'coingecko-base'),
  'coingecko-uniswap': (body) => parseTokenList(body, 'coingecko-uniswap'),
};

/**
 * Read one source and parse it.
 *
 * A non-2xx status, a body that is not JSON, or a timeout are all reported as
 * `ok: false` WITH the detail. They are never reported as an empty result: an
 * empty inventory and a broken fetch look identical downstream, and confusing
 * the two is how "no targets found" gets mistaken for "no targets exist".
 */
export async function collectSource(
  source: SourceId,
  options: CollectionOptions = {},
): Promise<{ parse: ParseResult | null; outcome: SourceOutcome; stat: SourceStat }> {
  const url = SOURCE_URLS[source];
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as Fetcher);
  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const emptyStat: SourceStat = {
    source,
    url,
    records: 0,
    candidates: 0,
    requests: 1,
    bytes: SOURCE_BYTES[source],
  };

  if (typeof doFetch !== 'function') {
    return {
      parse: null,
      outcome: { source, ok: false, error: 'no fetch implementation available' },
      stat: emptyStat,
    };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await doFetch(url, {
      signal: ctl.signal,
      headers: {
        // Named agent + a read-only note: these are public inventories and the
        // operator of each feed should be able to tell who is reading.
        'user-agent': 'asterion/1.0 (+target inventory; read-only)',
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      return {
        parse: null,
        outcome: { source, ok: false, error: `HTTP ${res.status}` },
        stat: emptyStat,
      };
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        parse: null,
        outcome: { source, ok: false, error: 'response was not valid JSON' },
        stat: { ...emptyStat, bytes: text.length },
      };
    }
    const parse = PARSERS[source](body);
    return {
      parse,
      outcome: { source, ok: true },
      stat: {
        source,
        url,
        records: parse.records_seen,
        candidates: parse.candidates.length,
        requests: 1,
        bytes: text.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      parse: null,
      outcome: { source, ok: false, error: message },
      stat: emptyStat,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh every source and merge the result.
 *
 * Sources are fetched in sequence, not in parallel. That is a memory decision,
 * not an oversight: `Promise.all` over DeFiLlama plus two token lists holds ~11 MB
 * of response text plus three parsed object graphs at once, and the parsed form
 * of a 9.4 MB JSON array is several times the text. Sequential fetching lets each
 * parsed graph be reduced to a candidate list before the next body is read.
 *
 * `max_body_bytes` skips a source whose known body size exceeds it, and records
 * `skipped` in the outcome so the omission is visible. It is a guard, not a
 * policy: the default reads everything.
 */
export async function collectCandidates(
  options: CollectionOptions = {},
): Promise<Collected> {
  const include = options.include ?? (Object.keys(SOURCE_URLS) as SourceId[]);
  const maxBytes = options.max_body_bytes;
  const parses: ParseResult[] = [];
  const stats: SourceStat[] = [];
  const outcomes: SourceOutcome[] = [];

  for (const source of include) {
    if (maxBytes !== undefined && SOURCE_BYTES[source] > maxBytes) {
      outcomes.push({
        source,
        ok: false,
        skipped: true,
        error: `${SOURCE_BYTES[source]} bytes exceeds max_body_bytes ${maxBytes}`,
      });
      continue;
    }
    const { parse, outcome, stat } = await collectSource(source, options);
    outcomes.push(outcome);
    stats.push(stat);
    if (parse !== null) parses.push(parse);
  }

  return { collection: mergeCollections(parses, stats), outcomes };
}
