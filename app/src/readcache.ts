/**
 * Read-cost control for D1's free tier.
 *
 * ## The failure this exists to stop
 *
 * On 2026-10-31 this deployment burned its entire daily budget of 5,000,000
 * rows read in a little over four hours (measured: ~310,000 rows/hour between
 * 09:00 and 12:00 UTC, against ~17,000 in a normal hour), and then the Worker
 * started returning HTTP 500 `D1_ERROR` for *every* request, including the
 * Telegram Mini App's Hunt tab. The database was fine; the budget was gone.
 *
 * The cause was not a big table. It was small tables scanned repeatedly. At the
 * time of diagnosis `programs` held 7 rows and most other tables held 0, yet the
 * budget was still blown, because D1 bills **rows scanned**, not rows returned:
 *
 *   · `SELECT seq, ts, kind, payload, ... FROM ledger ORDER BY seq ASC`
 *     reads every ledger row *with its payload* on every call — and the
 *     `/api/ledger` route ran a FULL chain verification on every request.
 *   · `SELECT COUNT(*) FROM ledger` and `GROUP BY kind` scan the whole table.
 *   · `SELECT ... FROM approvals ORDER BY requested_at DESC LIMIT 50` could not
 *     use `idx_approvals_pending(status, requested_at)`, so it scanned all
 *     approvals and built a temp B-tree for the sort.
 *
 * Poll the first of those every 20 seconds and a ~1,600-row ledger becomes
 * ~290,000 rows read per hour on its own. That number matches the incident
 * almost exactly, which is how the cause was identified.
 *
 * ## What this module does
 *
 * `cached()` turns a repeated expensive read into one `kv` row read. The kv
 * table is keyed and indexed, so a cache hit costs **1 row** no matter how
 * expensive the thing it stands in for.
 *
 * ## The part that matters more than the speed
 *
 * `cached()` is STALE-WHILE-ERROR. If the producer throws — a rate limit, a
 * quota wall, a transient D1 fault — and a previous value exists, the stale
 * value is returned instead of the error. A dashboard showing numbers that are
 * a few minutes old is enormously better than a Worker that throws 500 on every
 * route, because the operator can still see what the system knows and can still
 * tell the difference between "quiet" and "broken".
 */

export interface CacheEnv {
  DB: D1Database;
}

interface CacheRow {
  /** Epoch milliseconds the value was produced. */
  at: number;
  value: unknown;
}

/** Namespace so cache rows are distinguishable from unrelated `kv` entries. */
const PREFIX = 'rc:';

/**
 * Read once per `ttlSeconds`, then serve from the `kv` table.
 *
 * @param key        cache identity; use a stable, namespaced string
 * @param ttlSeconds how long a value stays fresh. Longer is cheaper — pick the
 *                   longest staleness the surface can tolerate, not the shortest
 *                   that feels responsive.
 * @param producer    the expensive work, run only on a miss
 */
export async function cached<T>(
  env: CacheEnv,
  key: string,
  ttlSeconds: number,
  producer: () => Promise<T>,
): Promise<T> {
  const full = PREFIX + key;
  let prior: CacheRow | null = null;
  try {
    const row = await env.DB.prepare('SELECT value FROM kv WHERE key=?').bind(full).first<{ value: string }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as CacheRow;
      if (parsed && typeof parsed.at === 'number') prior = parsed;
    }
  } catch {
    // An unreadable cache is a cache miss, not an error: fall through and
    // produce the value. One extra row read, no behavioural change.
    prior = null;
  }

  const now = Date.now();
  if (prior && now - prior.at < ttlSeconds * 1000) return prior.value as T;

  try {
    const value = await producer();
    try {
      await env.DB.prepare(
        'INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
        .bind(full, JSON.stringify({ at: now, value } satisfies CacheRow))
        .run();
    } catch {
      // Failing to WRITE the cache must not fail the request; the caller still
      // gets a correct, freshly produced value.
    }
    return value;
  } catch (e) {
    // STALE-WHILE-ERROR: prefer old data to a broken route.
    if (prior) return prior.value as T;
    throw e;
  }
}

/**
 * Maintain a running count in `kv` so `COUNT(*)` never has to scan again.
 *
 * D1 bills the scan, and `COUNT(*)` is a full table scan by definition. For an
 * append-only log the count only ever moves by one, so it is cheaper to keep the
 * number than to recompute it. `seed` runs once (on a cold cache) and must
 * return the true count.
 */
export async function counter(
  env: CacheEnv,
  key: string,
  seed: () => Promise<number>,
  delta = 0,
): Promise<number> {
  const full = PREFIX + 'n:' + key;
  let current: number | null = null;
  try {
    const row = await env.DB.prepare('SELECT value FROM kv WHERE key=?').bind(full).first<{ value: string }>();
    if (row?.value) {
      const n = Number(row.value);
      if (Number.isFinite(n)) current = n;
    }
  } catch {
    current = null;
  }

  try {
    const next = current === null ? await seed() : current + delta;
    if (current === null || delta !== 0) {
      await env.DB.prepare(
        'INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
        .bind(full, String(next))
        .run();
    }
    return next;
  } catch {
    // If even the seed scan fails, report the last known value rather than 0:
    // "0" is a claim, and an unknown count is not zero.
    if (current !== null) return current;
    throw new Error('counter unavailable');
  }
}
