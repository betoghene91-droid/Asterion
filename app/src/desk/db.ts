/**
 * D1 access for the desk.
 *
 * Thin on purpose. Every desk query goes through here so that "which tables can
 * trading touch" is one grep: only `desk_*`, plus `kv` for mode/breaker state
 * and `quota` for the outbound-call budget. Nothing here can reach findings,
 * evidence, probes or approvals.
 */

import type { DeskEnv } from './types.js';

export interface Db {
  first<T>(sql: string, ...binds: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  run(sql: string, ...binds: unknown[]): Promise<void>;
}

export function db(env: DeskEnv): Db {
  return {
    async first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
      return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
    },
    async all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
      const r = await env.DB.prepare(sql).bind(...binds).all<T>();
      return r.results ?? [];
    },
    async run(sql: string, ...binds: unknown[]): Promise<void> {
      await env.DB.prepare(sql).bind(...binds).run();
    },
  };
}

/** Monotonic-ish id: time prefix keeps rows sortable, suffix avoids collisions. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = crypto.getRandomValues(new Uint8Array(6));
  const s = [...r].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${t}_${s}`;
}

export async function kvGet(env: DeskEnv, key: string): Promise<string | null> {
  const row = await db(env).first<{ value: string }>('SELECT value FROM kv WHERE key=?', key);
  return row?.value ?? null;
}

export async function kvSet(env: DeskEnv, key: string, value: string): Promise<void> {
  await db(env).run(
    'INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    value,
  );
}

/**
 * The D1 free-tier daily rows_written ceiling, and where we stop before it.
 *
 * Cloudflare meters this per UTC day and, past the cap, does not throttle: every
 * write fails outright. A desk that ignores that does not fail cleanly - it writes
 * a partial universe, then reads it back as if it were complete. Halting at 90%
 * leaves headroom for the interactive paths (a /hunt approval, a sentinel alert)
 * that share the same database and are worth more than another sweep.
 */
export const WRITE_BUDGET = {
  /** The published free-tier cap. */
  dailyRows: 100_000,
  /** Stop the sweep here, so interactive work still has room. */
  stopAtFraction: 0.9,
} as const;

/**
 * Has this UTC day's D1 write budget run out?
 *
 * Cloudflare exposes the consumed count only in an out-of-band email, so this is
 * necessarily our own accounting: every desk writer funnels through this module's
 * `db()`, and `spendRows` is called by the sweep as it writes. Absent any recorded
 * spend we assume zero - i.e. we never halt a desk that has not been measured,
 * because a false halt stops trading on no evidence at all.
 */
export async function writeBudgetExhausted(env: DeskEnv, now = Date.now()): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const raw = await kvGet(env, `rows_written:${day}`);
  if (raw === null) return false;
  const used = Number(raw);
  if (!Number.isFinite(used)) return false;
  return used >= WRITE_BUDGET.dailyRows * WRITE_BUDGET.stopAtFraction;
}

/** Record rows written this UTC day. Called by the writers, not by readers. */
export async function spendRows(env: DeskEnv, n: number, now = Date.now()): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return;
  const day = new Date(now).toISOString().slice(0, 10);
  const raw = await kvGet(env, `rows_written:${day}`);
  const used = Number(raw ?? 0);
  const next = (Number.isFinite(used) ? used : 0) + n;
  await kvSet(env, `rows_written:${day}`, String(next));
}

/**
 * Outbound-call budget. Every desk network call goes through `spendSubrequest`
 * first: Cloudflare caps subrequests per invocation and a runaway crawler is a
 * failure mode that looks like a feature until the Worker starts throwing.
 */
export async function spendSubrequest(env: DeskEnv, n = 1): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.DESK_DAILY_SUBREQUEST_CAP ?? '4000');
  const row = await db(env).first<{ used: number }>(
    "SELECT used FROM quota WHERE day=? AND bucket='desk_subrequests'",
    day,
  );
  if ((row?.used ?? 0) + n > cap) return false;
  await db(env).run(
    `INSERT INTO quota (day, bucket, used, cap) VALUES (?,?,?,?)
     ON CONFLICT(day, bucket) DO UPDATE SET used = used + excluded.used, cap = excluded.cap`,
    day,
    'desk_subrequests',
    n,
    cap,
  );
  return true;
}

export async function subrequestsUsed(env: DeskEnv): Promise<{ used: number; cap: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.DESK_DAILY_SUBREQUEST_CAP ?? '4000');
  const row = await db(env).first<{ used: number }>(
    "SELECT used FROM quota WHERE day=? AND bucket='desk_subrequests'",
    day,
  );
  return { used: row?.used ?? 0, cap };
}

/**
 * Realized cash equity: the starting bankroll plus realized PnL only.
 *
 * Deliberately NOT mark-to-market. Marking to market inflates position size
 * exactly when the book is hot, which is the moment the next position is most
 * expensive and the drawdown most likely — 8% of an inflated number is a
 * bigger real bet than 8% of the cash actually yours.
 */
export async function realizedEquity(env: DeskEnv): Promise<number> {
  const start = Number(env.DESK_EQUITY_START_USD ?? '10000');
  const row = await db(env).first<{ pnl: number | null }>(
    "SELECT SUM(pnl_usd) AS pnl FROM desk_positions WHERE mode='paper' AND state='closed'",
  );
  const liveRow = await db(env).first<{ pnl: number | null }>(
    "SELECT SUM(pnl_usd) AS pnl FROM desk_positions WHERE mode='live' AND state='closed'",
  );
  return start + (row?.pnl ?? 0) + (liveRow?.pnl ?? 0);
}

export async function deployedUsd(env: DeskEnv): Promise<number> {
  const row = await db(env).first<{ v: number | null }>(
    "SELECT SUM(filled_usd) AS v FROM desk_positions WHERE state='open'",
  );
  return row?.v ?? 0;
}
