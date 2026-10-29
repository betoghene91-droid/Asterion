/**
 * Mode and arming.
 *
 * The single most important property of this file: **paper is the default and
 * live is a conjunction.** There is no single flag, environment variable or
 * message that switches the desk to live. `resolveMode()` returns 'live' only
 * when every gate below passes, and when it does not, it says exactly which
 * gates were unmet so the operator is never guessing.
 *
 * Live can never be armed from Telegram, from an HTTP request, or from a row in
 * a table — all three are reachable by anyone who gets the bot token or the
 * Worker URL. Arming requires `wrangler secret put`, i.e. account access.
 */

import { db, kvGet, kvSet, realizedEquity } from './db.js';
import { breakerTripped } from './risk.js';
import { ARMING, type DeskEnv, type DeskMode } from './types.js';

export const MODE_KEY = 'desk_mode';
export const BREAKER_KEY = 'desk_breaker_until';

export interface PaperStats {
  trades: number;
  days: number;
  expectancyUsd: number;
  /** Max peak-to-trough on the realized equity curve, as a fraction. */
  maxDrawdownPct: number;
  wins: number;
  losses: number;
}

export interface Gate {
  name: string;
  met: boolean;
  /** What the gate needs, in words, so /desk can print it without a lookup. */
  requirement: string;
  actual: string;
}

export interface ArmState {
  mode: DeskMode;
  /** True only when every gate is met. */
  armed: boolean;
  gates: Gate[];
  unmet: string[];
}

/**
 * Paper statistics from closed positions. Deterministic — no sampling, no
 * shrink — because these numbers decide whether real money moves.
 */
export async function paperStats(env: DeskEnv): Promise<PaperStats> {
  const rows = await db(env).all<{ pnl_usd: number | null; opened_at: number; closed_at: number | null }>(
    `SELECT pnl_usd, opened_at, closed_at FROM desk_positions
     WHERE mode='paper' AND state='closed' ORDER BY closed_at ASC`,
  );
  const start = Number(env.DESK_EQUITY_START_USD ?? '10000');

  let equity = start;
  let peak = start;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let sum = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;

  for (const r of rows) {
    const pnl = r.pnl_usd ?? 0;
    sum += pnl;
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
    if (r.opened_at < earliest) earliest = r.opened_at;
    if (r.closed_at && r.closed_at > latest) latest = r.closed_at;
  }

  const days =
    rows.length && Number.isFinite(earliest) && latest > earliest
      ? (latest - earliest) / 86400
      : 0;

  return {
    trades: rows.length,
    days,
    expectancyUsd: rows.length ? sum / rows.length : 0,
    maxDrawdownPct: maxDd,
    wins,
    losses,
  };
}

/**
 * Every arming gate, evaluated in one place.
 *
 * A gate that cannot be *checked* counts as unmet. That is the whole point: an
 * unverifiable gate is not a satisfied one, and defaulting it open is how a
 * safety system becomes decoration.
 */
export async function armState(env: DeskEnv): Promise<ArmState> {
  const stats = await paperStats(env);

  /*
   * `DESK_SIGNER_KEY` in the Worker environment is a *failure*, not a feature:
   * it means the private key is readable by the request handler. The gate
   * passes only when a signer endpoint is configured AND no raw key is present,
   * so a copied deployment with a pasted key fails closed.
   */
  const signerIsolated = Boolean(env.DESK_SIGNER_URL) && !env.DESK_SIGNER_KEY;

  const capUsd = Number(env.DESK_CAPITAL_CAP_USD ?? '0');

  const gates: Gate[] = [
    {
      name: 'paper_trades',
      met: stats.trades >= ARMING.minPaperTrades,
      requirement: `>= ${ARMING.minPaperTrades} closed paper trades`,
      actual: `${stats.trades}`,
    },
    {
      name: 'paper_days',
      met: stats.days >= ARMING.minDays,
      requirement: `>= ${ARMING.minDays} days of paper history`,
      actual: `${stats.days.toFixed(1)}d`,
    },
    {
      name: 'expectancy_after_fees',
      met: stats.trades > 0 && stats.expectancyUsd > 0,
      requirement: 'positive expectancy per trade, after modelled fees',
      actual: stats.trades ? `${stats.expectancyUsd >= 0 ? '+' : ''}${stats.expectancyUsd.toFixed(2)} USD/trade` : 'no trades',
    },
    {
      name: 'max_drawdown',
      met: stats.trades > 0 && stats.maxDrawdownPct < ARMING.maxDrawdownPct,
      requirement: `< ${(ARMING.maxDrawdownPct * 100).toFixed(0)}% realized max drawdown`,
      actual: stats.trades ? `${(stats.maxDrawdownPct * 100).toFixed(1)}%` : 'no trades',
    },
    {
      name: 'desk_live_secret',
      met: env.DESK_LIVE === '1',
      requirement: 'DESK_LIVE=1 set via `wrangler secret put`',
      actual: env.DESK_LIVE === '1' ? 'set' : 'unset',
    },
    {
      name: 'capital_cap',
      met: Number.isFinite(capUsd) && capUsd > 0,
      requirement: 'DESK_CAPITAL_CAP_USD set to a positive hard ceiling',
      actual: capUsd > 0 ? `$${capUsd}` : 'unset',
    },
    {
      name: 'signer_isolation',
      met: signerIsolated,
      requirement:
        'DESK_SIGNER_URL set and DESK_SIGNER_KEY absent (key must never be in the Worker env)',
      actual: signerIsolated
        ? 'isolated'
        : env.DESK_SIGNER_KEY
          ? 'DESK_SIGNER_KEY present in Worker env — key is exposed to handlers'
          : 'no signer configured',
    },
  ];

  const unmet = gates.filter((g) => !g.met).map((g) => g.name);
  const armed = unmet.length === 0;

  // Mode is the arming result. `desk_mode` in kv is an *intent* record that can
  // only ever move the desk toward paper, never away from it: if it says 'live'
  // but a gate fails, the desk runs paper and says why.
  const stored = await kvGet(env, MODE_KEY);
  const mode: DeskMode = stored === 'live' && armed ? 'live' : 'paper';

  return { mode, armed, gates, unmet };
}

/**
 * Record the operator's mode intent. Returns the state actually in force.
 *
 * Requesting 'live' is refused at this layer even when armed, because nothing
 * in this build submits a real order: `executor.submit` throws
 * live_signer_not_wired. Recording 'live' would produce positions marked live
 * that are in fact paper — the worst possible lie. So intent is recorded and
 * the effective mode stays paper; arming is reported separately.
 */
export async function requestMode(env: DeskEnv, want: DeskMode): Promise<ArmState> {
  const state = await armState(env);
  if (want === 'live') {
    // Record the request for auditability, but keep paper in force.
    await kvSet(env, MODE_KEY, 'live');
    const after = await armState(env);
    return { ...after, mode: 'paper' };
  }
  await kvSet(env, MODE_KEY, 'paper');
  return { ...state, mode: 'paper' };
}

/** Circuit breaker: set on a breach, cleared ONLY by time passing. */
export async function breakerUntil(env: DeskEnv): Promise<number> {
  const raw = await kvGet(env, BREAKER_KEY);
  return raw ? Number(raw) || 0 : 0;
}

export async function breakerActive(env: DeskEnv, now = Date.now()): Promise<boolean> {
  return (await breakerUntil(env)) > now;
}

/**
 * Trip the breaker for 24h from `now`.
 *
 * There is intentionally no `resetBreaker()` anywhere in the codebase. The only
 * way out is `until` passing into the past. A chat command that cleared this
 * would mean the operator's worst moment — the moment it fired — is the exact
 * moment they are most likely to override it.
 */
export async function tripBreaker(env: DeskEnv, now = Date.now()): Promise<number> {
  const until = now + 24 * 3600 * 1000;
  await kvSet(env, BREAKER_KEY, String(until));
  return until;
}

/** Realized PnL for the current UTC day, in USD. Integer cents are not modelled. */
export async function todayRealizedPnl(env: DeskEnv, now = Date.now()): Promise<number> {
  const dayStartMs = Math.floor(now / 86_400_000) * 86_400_000;
  const row = await db(env).first<{ v: number | null }>(
    'SELECT SUM(pnl_usd) AS v FROM desk_positions WHERE state=? AND closed_at >= ?',
    'closed',
    Math.floor(dayStartMs / 1000),
  );
  return row?.v ?? 0;
}

/**
 * Check the daily loss breaker. Called after every close, and by the executor
 * before every open — so a halted desk cannot open even if a close slipped past.
 *
 * The threshold arithmetic lives in risk.breakerTripped so there is exactly one
 * definition of "-8%%" in the codebase.
 */
export async function checkBreaker(env: DeskEnv, now = Date.now()): Promise<{ halted: boolean; until: number }> {
  const until = await breakerUntil(env);
  if (until > now) return { halted: true, until };
  const equity = await realizedEquity(env);
  const pnl = await todayRealizedPnl(env, now);
  if (breakerTripped(equity, pnl)) {
    const t = await tripBreaker(env, now);
    return { halted: true, until: t };
  }
  return { halted: false, until: 0 };
}
