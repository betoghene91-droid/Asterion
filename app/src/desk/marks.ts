/**
 * Forward price marks: our own price history, taken one tick at a time.
 *
 * ## Why this table exists at all
 *
 * `/calib`'s whole value is the question a journal never asks — of the tokens we
 * killed, which ones ran, and which ones died. Answering it needs the price
 * *after* the kill. `DeskSource.since` was the hook for that and nothing
 * implemented it, so every reason printed "unmeasured" on live data.
 *
 * A paid history API is one answer. This is the free, unimpeachable one: record
 * the mid price of everything in the universe, every tick, and after a few days
 * you own a forward series that nobody can dispute because you observed it
 * yourself. It is slower than a backtest and it cannot flatter the filter, which
 * is the point.
 *
 * ## The gap this closes without pretending
 *
 * A mark series still cannot price the moment between two ticks, and it says
 * nothing about a token that was killed before we ever saw it. `measureFromMarks`
 * therefore returns `null` rather than an outcome when the window is too thin,
 * and the calibration report keeps printing "unmeasured" per reason until it
 * genuinely has the numbers. The difference after this module is that the number
 * becomes *available* rather than *impossible*.
 */

import { db, newId } from './db.js';
import type { DeskEnv, DeskSource, MarketSnapshot } from './types.js';

/**
 * How dense a series has to be before an outcome is claimed.
 *
 * Two marks a few seconds apart around one price is not a price history. These
 * are the minimums below which measurement returns null: at least 2 marks, a
 * window of at least `minWindowSeconds`, and the newest mark at least
 * `minDistanceSeconds` after the kill so the token has had a chance to move.
 */
export const MARKS = {
  /** A token needs this many marks before `measureFromMarks` will judge it. */
  minMarks: 2,
  /** Below this window the "high" and "low" are the same tick. */
  minWindowSeconds: 6 * 3600,
  /** Do not judge a kill until this long after it, matching logger.ts. */
  minDistanceSeconds: 6 * 3600,
  /** A mark older than this is not used as the base price. */
  maxBaseAgeSeconds: 2 * 3600,
  /** Never keep a mint's series forever; the sweep would grow without bound. */
  retentionDays: 14,
} as const;

/** One mark row, as stored. */
export interface Mark {
  mint: string;
  ts: number;
  priceUsd: number;
  liqUsd: number | null;
  mcapUsd: number | null;
  source: 'dexscreener' | 'rpc' | 'fixture';
}

/**
 * The pure snapshot function: decide what to mark and build the rows.
 *
 * Separated from the write so the decision is testable without a database, and so
 * the "did this tick produce anything" question has one answer. A mark is
 * recorded only for a market with a positive, finite price — a zero price is a
 * missing quote, and writing it would make the series claim a -100% move that
 * never happened.
 */
export function snapshotMarks(
  markets: Pick<MarketSnapshot, 'mint' | 'priceUsd' | 'liqUsd' | 'mcapUsd'>[],
  nowMs: number,
  source: Mark['source'] = 'dexscreener',
): Mark[] {
  const ts = Math.floor(nowMs / 1000);
  const seen = new Set<string>();
  const out: Mark[] = [];
  for (const m of markets) {
    if (!m || typeof m.mint !== 'string' || !m.mint) continue;
    if (seen.has(m.mint)) continue;
    if (!Number.isFinite(m.priceUsd) || m.priceUsd <= 0) continue;
    seen.add(m.mint);
    out.push({
      mint: m.mint,
      ts,
      priceUsd: m.priceUsd,
      liqUsd: Number.isFinite(m.liqUsd) ? m.liqUsd : null,
      mcapUsd: Number.isFinite(m.mcapUsd) ? m.mcapUsd : null,
      source,
    });
  }
  return out;
}

/** Persist marks. Idempotent per (mint, second, source) via a generated id. */
export async function recordMarks(env: DeskEnv, marks: Mark[]): Promise<number> {
  let n = 0;
  for (const m of marks) {
    try {
      await db(env).run(
        `INSERT INTO desk_marks (id, mint, ts, price_usd, liq_usd, mcap_usd, source, note)
         VALUES (?,?,?,?,?,?,?,'')`,
        newId('mark'),
        m.mint,
        m.ts,
        m.priceUsd,
        m.liqUsd,
        m.mcapUsd,
        m.source,
      );
      n++;
    } catch {
      // One bad row must not lose the rest of the tick's series.
      continue;
    }
  }
  return n;
}

/**
 * Snapshot every mint in the universe.
 *
 * This is the function the desk pipeline calls each tick. It reads the universe
 * from `desk_universe` (which the sweep already maintains) rather than fetching
 * prices again: the sweep has just paid for those quotes, and re-fetching them
 * would double the request count for a series that is meant to be cheap.
 *
 * `price_usd` on `desk_universe` is refreshed by every sweep, so this is a
 * genuine forward series at tick resolution, not a re-read of one snapshot.
 */
export async function snapshotUniverseMarks(
  env: DeskEnv,
  now = Date.now(),
  limit = 200,
): Promise<{ written: number; considered: number }> {
  const rows = await db(env).all<{
    mint: string;
    price_usd: number;
    liq_usd: number;
    mcap_usd: number;
  }>(
    `SELECT mint, price_usd, liq_usd, mcap_usd FROM desk_universe
     ORDER BY last_seen DESC LIMIT ?`,
    limit,
  );
  const markets = rows.map((r) => ({
    mint: r.mint,
    priceUsd: r.price_usd,
    liqUsd: r.liq_usd,
    mcapUsd: r.mcap_usd,
  }));
  const marks = snapshotMarks(markets, now, 'dexscreener');
  const written = await recordMarks(env, marks);
  return { written, considered: rows.length };
}

/** Drop marks past the retention window. Called from the maintenance slot. */
export async function pruneMarks(env: DeskEnv, now = Date.now()): Promise<number> {
  const cutoff = Math.floor(now / 1000) - MARKS.retentionDays * 86_400;
  const before = await db(env).first<{ n: number }>('SELECT COUNT(*) AS n FROM desk_marks');
  await db(env).run('DELETE FROM desk_marks WHERE ts < ?', cutoff);
  const after = await db(env).first<{ n: number }>('SELECT COUNT(*) AS n FROM desk_marks');
  return (before?.n ?? 0) - (after?.n ?? 0);
}

/** The series for one mint, oldest first. */
export async function marksFor(env: DeskEnv, mint: string, limit = 500): Promise<Mark[]> {
  const rows = await db(env).all<{
    mint: string;
    ts: number;
    price_usd: number;
    liq_usd: number | null;
    mcap_usd: number | null;
    source: string;
  }>(
    'SELECT mint, ts, price_usd, liq_usd, mcap_usd, source FROM desk_marks WHERE mint=? ORDER BY ts ASC LIMIT ?',
    mint,
    limit,
  );
  return rows.map((r) => ({
    mint: r.mint,
    ts: r.ts,
    priceUsd: r.price_usd,
    liqUsd: r.liq_usd,
    mcapUsd: r.mcap_usd,
    source: r.source as Mark['source'],
  }));
}

/**
 * Measure what happened to a mint after `sinceTs`, from our own marks.
 *
 * This is the `DeskSource.since` implementation. The contract is the one
 * `logger.measureOutcomes` already expects: `{highUsd, lowUsd, lastUsd}`, or
 * `null` when the series cannot support a claim.
 *
 * ## The base price, and why the low is not used
 *
 * `logger.ts` used `hist.lowUsd` as the base because that made a 3× claim
 * *harder*, which is the conservative direction for a dodge judgement. With a
 * real series we can do better and be honest about it: the base is the **last
 * mark at or before the kill**. If no mark exists before the kill, we fall back
 * to the earliest mark after it and say so — never to the series low, because
 * using the low as the denominator inflates every multiple and would turn a
 * flat token into a false negative.
 */
export function measureFromMarks(
  marks: Mark[],
  sinceTs: number,
  nowMs: number,
): { highUsd: number; lowUsd: number; lastUsd: number; baseUsd: number; baseFrom: 'before' | 'after' } | null {
  if (marks.length < MARKS.minMarks) return null;

  const nowS = Math.floor(nowMs / 1000);
  if (nowS - sinceTs < MARKS.minDistanceSeconds) return null;

  const sorted = [...marks].sort((a, b) => a.ts - b.ts);
  const forward = sorted.filter((m) => m.ts >= sinceTs);
  if (!forward.length) return null;

  const window = (forward[forward.length - 1] as Mark).ts - (forward[0] as Mark).ts;
  if (window < MARKS.minWindowSeconds) return null;

  // Base: the newest mark at or before the kill, if it is fresh enough.
  const before = sorted.filter((m) => m.ts <= sinceTs);
  const newestBefore = before.length ? (before[before.length - 1] as Mark) : null;
  const freshBefore =
    newestBefore && sinceTs - newestBefore.ts <= MARKS.maxBaseAgeSeconds ? newestBefore : null;

  const base = freshBefore ?? (forward[0] as Mark);
  if (!(base.priceUsd > 0)) return null;

  const prices = forward.map((m) => m.priceUsd).filter((p) => p > 0);
  if (!prices.length) return null;

  return {
    highUsd: Math.max(...prices),
    lowUsd: Math.min(...prices),
    lastUsd: prices[prices.length - 1] as number,
    baseUsd: base.priceUsd,
    baseFrom: freshBefore ? 'before' : 'after',
  };
}

/**
 * A `DeskSource.since` implementation backed by `desk_marks`.
 *
 * Wrapped so the pipeline can hand the calibration pass a source whose history
 * comes from our own series while everything else still comes from the live
 * source. That keeps `measureOutcomes` unchanged: it asks `source.since`, and now
 * an answer exists.
 */
export function markHistory(env: DeskEnv, now: () => number = () => Date.now()) {
  return async function since(
    mint: string,
    sinceTs: number,
  ): Promise<{ highUsd: number; lowUsd: number; lastUsd: number; baseUsd?: number } | null> {
    const marks = await marksFor(env, mint);
    const m = measureFromMarks(marks, sinceTs, now());
    if (!m) return null;
    /*
     * `baseUsd` is returned alongside the contract's three fields, and it matters.
     *
     * The old consumer derived the base as `hist.lowUsd`, which is the low of the
     * FORWARD window and therefore always <= the pre-decision price. On a token that
     * ran 3.2x, that reported 1.6x and filed a genuine false negative as a dodge.
     * Handing over the observed pre-kill price is the whole reason this series is
     * worth building, so the number travels with the measurement instead of being
     * re-derived downstream.
     */
    return { highUsd: m.highUsd, lowUsd: m.lowUsd, lastUsd: m.lastUsd, baseUsd: m.baseUsd };
  };
}

/** Wrap an existing source so its `since` comes from our marks. */
export function withMarkHistory(env: DeskEnv, source: DeskSource): DeskSource {
  return { ...source, since: markHistory(env) };
}

/**
 * Coverage: how many mints and marks the series holds, and over what span.
 *
 * `/calib` prints this next to "unmeasured" so an operator can see whether the
 * series is too young or the pipeline is not running. Without it, "unmeasured"
 * is indistinguishable from "broken".
 */
export async function markStats(
  env: DeskEnv,
): Promise<{
  marks: number;
  mints: number;
  oldest_ts: number | null;
  newest_ts: number | null;
  span_hours: number;
  dense_mints: number;
}> {
  const row = await db(env).first<{
    n: number;
    mints: number;
    oldest: number | null;
    newest: number | null;
  }>('SELECT COUNT(*) AS n, COUNT(DISTINCT mint) AS mints, MIN(ts) AS oldest, MAX(ts) AS newest FROM desk_marks');

  // "Dense" = a series that `measureFromMarks` could actually judge.
  const dense = await db(env).first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT mint, COUNT(*) AS c, MAX(ts) - MIN(ts) AS span
       FROM desk_marks GROUP BY mint
       HAVING c >= ? AND span >= ?
     )`,
    MARKS.minMarks,
    MARKS.minWindowSeconds,
  );

  const oldest = row?.oldest ?? null;
  const newest = row?.newest ?? null;
  return {
    marks: row?.n ?? 0,
    mints: row?.mints ?? 0,
    oldest_ts: oldest,
    newest_ts: newest,
    span_hours: oldest !== null && newest !== null ? Number(((newest - oldest) / 3600).toFixed(1)) : 0,
    dense_mints: dense?.n ?? 0,
  };
}

/**
 * Marks per mint, most dense first. Used by /calib and the calibration tests.
 */
export async function markDensity(
  env: DeskEnv,
  limit = 20,
): Promise<{ mint: string; marks: number; first_ts: number; last_ts: number }[]> {
  const rows = await db(env).all<{ mint: string; n: number; first: number; last: number }>(
    `SELECT mint, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last
     FROM desk_marks GROUP BY mint ORDER BY n DESC LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({ mint: r.mint, marks: r.n, first_ts: r.first, last_ts: r.last }));
}
