/**
 * The resumable adapter queue, and the subrequest budget that makes it necessary.
 *
 * WHY 438 FETCHES CANNOT HAPPEN IN ONE TICK
 *
 * Measured 2026-10-30 against the live feed: 635 protocols carry `tvl > $10M`
 * and a `tvlCodePath`, and those name **438 distinct adapters** (adapters are
 * shared — `registries/sumTokens.js` alone serves 75 protocols). Reading them all
 * costs 438 subrequests. A Worker invocation has a subrequest ceiling (50 on the
 * free plan, which is the plan this project targets), so a full refresh is
 * **9 ticks minimum** and cannot be one cron run.
 *
 * The binding constraint is the REQUEST COUNT and not the bytes, which is the
 * opposite of `targets/collect.ts` (one request, 9.4 MB). Measured adapter sizes:
 * total 3,674,148 B, median 2,036 B, p90 9,675 B, max 1,498,048 B. So batching by
 * byte budget would be wrong here: six 1.5 MB adapters are 6 requests, and 438
 * requests is what breaks.
 *
 * WHY DEDUPE BY CODE PATH IS THE WHOLE OPTIMISATION
 *
 * Fetching per protocol would be 117,878,241 B across 635 requests; fetching per
 * unique adapter is 3,674,148 B across 438. That is 32× fewer bytes and 1.45×
 * fewer requests. The queue is therefore keyed on the code path, and a protocol
 * shares an already-fetched adapter with its siblings.
 *
 * WHAT IS STORED, AND WHY "0 ADDRESSES" IS A RESULT
 *
 * 145 of the 437 adapters fetched successfully name ZERO `0x…` address: they
 * compose other adapters or reference registry keys. So a fetched adapter with no
 * addresses is `empty`, not `failed`, and it stays out of the retry loop. Without
 * that distinction an empty adapter and a 404 are the same row and every tick
 * re-fetches it forever.
 *
 * NOTHING HERE IS A CLOCK. `now` is a parameter, so a test can drive the retry
 * schedule without sleeping.
 */

import type { Funding, ProtocolRecord, TokenIdentity } from './funding.js';
import { fundAddresses, rawAdapterUrl, tokenIdentityKeys } from './funding.js';

/** The narrow D1 surface this module needs, so a test can stand in for it. */
export interface QueueDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
    first<T = unknown>(): Promise<T | null>;
    run(): Promise<unknown>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
}

export interface QueueRow {
  id: string;
  name: string;
  tvl_code_path: string;
  raw_url: string;
  symbol: string | null;
  address: string | null;
  tvl_usd: number | null;
  state: string;
  attempts: number;
  bytes: number;
  addresses_n: number;
  dropped_as_token: number;
  fund_addresses: string;
  fork_target: string | null;
  last_error: string | null;
  next_attempt: number;
  fetched_at: number | null;
}

/** States a queue row can be in. `empty` and `failed` are different facts. */
export type QueueState = 'queued' | 'fetched' | 'empty' | 'failed' | 'no-adapter';

/**
 * Turn a protocol record into a queue row.
 *
 * A protocol with no `tvlCodePath` is written as `no-adapter` immediately: there
 * is nothing to fetch, and inserting it as `queued` would leave a row that every
 * tick considers due and can never satisfy.
 */
export function rowForProtocol(p: ProtocolRecord, now: number): Omit<QueueRow, 'attempts' | 'bytes' | 'addresses_n' | 'dropped_as_token' | 'fund_addresses' | 'fork_target' | 'last_error' | 'fetched_at'> & {
  attempts: number;
  bytes: number;
  addresses_n: number;
  dropped_as_token: number;
  fund_addresses: string;
  fork_target: string | null;
  last_error: string | null;
  fetched_at: number | null;
} {
  const rawUrl = rawAdapterUrl(p.tvlCodePath);
  return {
    id: slugFor(p.name),
    name: p.name,
    tvl_code_path: p.tvlCodePath ?? '',
    raw_url: rawUrl ?? '',
    symbol: p.symbol,
    address: p.address,
    tvl_usd: p.tvl_usd ?? null,
    state: p.tvlCodePath === null ? 'no-adapter' : rawUrl === null ? 'failed' : 'queued',
    attempts: 0,
    bytes: 0,
    addresses_n: 0,
    dropped_as_token: 0,
    fund_addresses: '[]',
    fork_target: null,
    // A codePath we cannot translate to a raw URL is a parser gap, not a network
    // failure — the error text says which so it is not mistaken for a 404.
    last_error: p.tvlCodePath !== null && rawUrl === null ? 'tvlCodePath is not a github blob URL' : null,
    next_attempt: now,
    fetched_at: null,
  };
}

/**
 * A stable, readable id for a protocol.
 *
 * DeFiLlama publishes `slug`, but `ProtocolRecord` does not carry it and the
 * name is what every operator message shows. Names are not unique across chains
 * (`Aave V3` appears once, but `Stargate` appears per chain), so the chain id, or
 * `svm`, is folded in — the same address on two chains is two targets, so the
 * same name on two chains must be two rows.
 */
export function slugFor(name: string, chainKey: string = 'multi'): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'unnamed'}@${chainKey}`;
}

/**
 * Enqueue a batch of protocol records.
 *
 * `ON CONFLICT DO NOTHING` is load-bearing: a protocol already fetched stays
 * fetched. Re-running the enqueue every tick must not reset `attempts` (which
 * would make the retry schedule infinite) or `state`.
 */
export async function enqueueProtocols(
  db: QueueDb,
  records: readonly (ProtocolRecord & { chainKey?: string })[],
  now: number,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const p of records) {
    const row = rowForProtocol(p, now);
    const id = slugFor(p.name, p.chainKey ?? 'multi');
    const res = (await db
      .prepare(
        `INSERT INTO fund_queue
           (id,name,tvl_code_path,raw_url,symbol,address,tvl_usd,state,attempts,bytes,
            addresses_n,dropped_as_token,fund_addresses,fork_target,last_error,next_attempt,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,0,0,0,0,'[]',NULL,?,?,NULL)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        id,
        row.name,
        row.tvl_code_path,
        row.raw_url,
        row.symbol,
        row.address,
        row.tvl_usd,
        row.state,
        row.last_error,
        row.next_attempt,
      )
      .run()) as { meta?: { changes?: number } } | undefined;
    const changes = res?.meta?.changes;
    if (changes === 0) skipped++;
    else inserted++;
  }
  return { inserted, skipped };
}

/**
 * Pick the rows due now, highest TVL first.
 *
 * TVL orders the queue because a batch that only reaches the top of it should
 * reach the largest protocols first — but this is a scheduling choice and not a
 * ranking, so it does not contradict `ev.ts`. A 1.5 MB adapter is not skipped for
 * being large: bytes are not the constraint, requests are.
 */
export async function dueRows(db: QueueDb, now: number, limit: number): Promise<QueueRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id,name,tvl_code_path,raw_url,symbol,address,tvl_usd,state,attempts,bytes,
              addresses_n,dropped_as_token,fund_addresses,fork_target,last_error,next_attempt,fetched_at
         FROM fund_queue
        WHERE state IN ('queued','failed')
          AND next_attempt <= ?
        ORDER BY COALESCE(tvl_usd,0) DESC, id ASC
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<QueueRow>();
  return results ?? [];
}

/** Fetch one adapter's source. Never throws: a failure is a value. */
export interface AdapterFetcher {
  (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

const FETCH_TIMEOUT_MS = 12_000;

async function fetchAdapter(
  doFetch: AdapterFetcher,
  url: string,
): Promise<{ source: string | null; error: string | null; bytes: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      // Named agent + a read-only note. These are public adapter sources and the
      // operator of the repository should be able to tell who is reading.
      headers: { 'user-agent': 'asterion/1.0 (+target discovery; read-only)', accept: 'text/plain' },
      signal: ctl.signal,
    });
    if (!res.ok) return { source: null, error: `HTTP ${res.status}`, bytes: 0 };
    const body = await res.text();
    return { source: body, error: null, bytes: body.length };
  } catch (err) {
    return { source: null, error: err instanceof Error ? err.message : String(err), bytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process up to `max_fetches` queued adapters and write the result back.
 *
 * Every outcome is terminal except a transport failure, which retries with a
 * doubling backoff capped at a day and gives up permanently after
 * {@link MAX_ATTEMPTS}. A permanently failed row keeps its `last_error` so the
 * operator sees why instead of a silent hole.
 */
export const MAX_ATTEMPTS = 4;

export async function drainQueue(
  db: QueueDb,
  options: {
    now: number;
    max_fetches: number;
    fetch?: AdapterFetcher;
    /** Every token identity address the feed publishes, lowercased. */
    tokenKeys: ReadonlySet<string>;
  },
): Promise<{
  attempted: number;
  derived: number;
  empty: number;
  failed: number;
  addresses: number;
  bytes: number;
  funding: Array<{ id: string; funding: Funding }>;
}> {
  const out = {
    attempted: 0,
    derived: 0,
    empty: 0,
    failed: 0,
    addresses: 0,
    bytes: 0,
    funding: [] as Array<{ id: string; funding: Funding }>,
  };
  if (options.max_fetches <= 0) return out;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as AdapterFetcher);
  if (typeof doFetch !== 'function') return out;

  const rows = await dueRows(db, options.now, options.max_fetches);
  for (const row of rows) {
    out.attempted++;
    const got = await fetchAdapter(doFetch, row.raw_url);
    out.bytes += got.bytes;

    const record: ProtocolRecord = {
      name: row.name,
      address: row.address,
      symbol: row.symbol,
      tvlCodePath: row.tvl_code_path,
      ...(row.tvl_usd !== null ? { tvl_usd: row.tvl_usd } : {}),
    };
    const funding = fundAddresses(record, options.tokenKeys, {
      source: got.source,
      fetchError: got.error,
    });
    out.funding.push({ id: row.id, funding });
    out.addresses += funding.extracted;

    if (funding.state === 'fetch-failed') {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      out.failed++;
      await db
        .prepare(
          `UPDATE fund_queue
              SET attempts=?, state=?, last_error=?, next_attempt=?
            WHERE id=?`,
        )
        .bind(
          attempts,
          // Exhausted rows leave the 'failed' state so `dueRows` stops selecting
          // them; the error text is kept, so the hole is visible rather than open.
          exhausted ? 'no-adapter' : 'failed',
          got.error ?? 'unknown fetch failure',
          exhausted ? options.now + 86400 : options.now + Math.min(86400, 300 * 2 ** attempts),
          row.id,
        )
        .run();
      continue;
    }

    if (funding.state === 'derived') out.derived++;
    if (funding.state === 'no-addresses' || funding.state === 'all-filtered') out.empty++;

    await db
      .prepare(
        `UPDATE fund_queue
            SET state='fetched', bytes=?, addresses_n=?, dropped_as_token=?,
                fund_addresses=?, fork_target=?, last_error=NULL, fetched_at=?
          WHERE id=?`,
      )
      .bind(
        got.bytes,
        funding.extracted,
        funding.dropped_as_token,
        JSON.stringify(funding.fund_addresses),
        funding.fork_target,
        options.now,
        row.id,
      )
      .run();
  }
  return out;
}

/**
 * Every protocol's adapter, already fetched, keyed by queue id.
 *
 * The candidate layer joins on this so a re-rank never re-fetches. `state` is
 * carried through so a candidate can distinguish "adapter says nothing" from
 * "adapter not read yet" without a second query.
 */
export async function fundingByProtocol(
  db: QueueDb,
  ids: readonly string[],
): Promise<Map<string, { fund_addresses: string[]; fork_target: string | null; state: string; bytes: number }>> {
  const out = new Map<string, { fund_addresses: string[]; fork_target: string | null; state: string; bytes: number }>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT id, fund_addresses, fork_target, state, bytes FROM fund_queue WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; fund_addresses: string; fork_target: string | null; state: string; bytes: number }>();
  for (const row of results ?? []) {
    out.set(row.id, {
      fund_addresses: parseAddressJson(row.fund_addresses),
      fork_target: row.fork_target,
      state: row.state,
      bytes: row.bytes,
    });
  }
  return out;
}

/** Parse the stored JSON array, tolerating a row written by an older version. */
export function parseAddressJson(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// the tick budget
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The free-plan subrequest ceiling, and the numbers this tick is allowed to spend.
 *
 * It is a plain constant because it is a property of the platform, not a tuning
 * knob. `assertBudget` below refuses a plan that exceeds it, so a future edit
 * that quietly doubles the crawl fails a test instead of failing production.
 */
export const SUBREQUEST_CEILING = 50;

export interface TickPlan {
  /** Programmes whose security.txt will be probed. */
  programmes: number;
  /**
   * Hosts per programme. `apex + www` is 2, and each host costs
   * {@link SECURITY_TXT_PATHS} requests — so a programme is 2 or 4 requests
   * depending on whether www is reached. See {@link securityTxtCost}.
   */
  hosts_per_programme: number;
  /** security.txt requests this tick may spend. */
  security_txt: number;
  /** Policy-document requests (one per programme whose security.txt was found). */
  policy: number;
  /** Adapter fetches for the fund queue. */
  fund: number;
  /** Total planned requests. Must be ≤ {@link SUBREQUEST_CEILING}. */
  total: number;
}

/** Exactly two RFC 9116 paths, and the count is exported because a test pins it. */
export const SECURITY_TXT_PATHS = ['/.well-known/security.txt', '/security.txt'] as const;

/**
 * Worst-case requests for one programme: every host probed at every path.
 *
 * The www host is only reached when the apex yielded nothing, so the real cost is
 * usually 2. The plan uses the worst case so the ceiling holds even when every
 * apex is empty — a budget validated on the best case is not a budget.
 */
export function securityTxtCost(hostsPerProgramme: number): number {
  return hostsPerProgramme * SECURITY_TXT_PATHS.length;
}

/**
 * Plan one tick.
 *
 * The fund queue gets whatever is left after the security.txt crawl and its policy
 * fetches, and never a negative amount. `programmes` is derived from the ceiling
 * rather than fixed, so raising `fund` automatically narrows the crawl instead of
 * blowing the cap.
 */
export function planTick(options: { programmes?: number; fund?: number; hosts_per_programme?: number } = {}): TickPlan {
  const hostsPerProgramme = Math.max(1, options.hosts_per_programme ?? 2);
  const perProgramme = securityTxtCost(hostsPerProgramme);
  const wantFund = Math.max(0, options.fund ?? 6);
  const wantProgrammes = Math.max(0, options.programmes ?? 20);

  // Each programme can also spend one policy request when its security.txt exists.
  const worstPerProgramme = perProgramme + 1;
  const maxProgrammesForCeiling = Math.floor((SUBREQUEST_CEILING - wantFund) / worstPerProgramme);
  const programmes = Math.max(0, Math.min(wantProgrammes, maxProgrammesForCeiling));
  const security_txt = programmes * perProgramme;
  const policy = programmes;
  const fund = Math.min(wantFund, SUBREQUEST_CEILING - security_txt - policy);
  return {
    programmes,
    hosts_per_programme: hostsPerProgramme,
    security_txt,
    policy,
    fund: Math.max(0, fund),
    total: security_txt + policy + Math.max(0, fund),
  };
}

/** Throws when a plan would exceed the platform ceiling. Used by a test. */
export function assertBudget(plan: TickPlan): TickPlan {
  if (plan.total > SUBREQUEST_CEILING) {
    throw new Error(`tick plan spends ${plan.total} subrequests, ceiling is ${SUBREQUEST_CEILING}`);
  }
  return plan;
}

/** The token-key set from the same protocol list the queue was built from. */
export function tokenKeysFrom(records: readonly ProtocolRecord[]): Set<string> {
  return tokenIdentityKeys(records);
}

/** Re-exported so a caller can type its token set without importing funding.js. */
export type { TokenIdentity };
