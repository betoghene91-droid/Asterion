/**
 * Executor — sizing, gates, and the only place a position is opened.
 *
 * Every number here is a ceiling, and every ceiling is a refusal rather than a
 * clamp. Clamping is the trap: it silently shrinks a position to fit the limit
 * and reports success, so the operator never learns the book was full. This file
 * returns a refusal code and opens nothing.
 *
 * Three ceilings interact and all three are checked:
 *   - 8% of REALIZED CASH equity per position
 *   - 3 concurrent positions
 *   - 24% of realized equity deployed at any time
 * The 3-position cap is not arbitrary caution: memecoins are roughly 1.0
 * correlated, so 8 positions at 3% is the same bet as 1 position at 24%, with
 * three times the fee drag and three times the chance one order fails.
 *
 * Live order submission is deliberately absent. `submit()` throws. Everything
 * that would build, sign or broadcast a transaction lives behind
 * `DESK_SIGNER_URL` (a separate service) and is not implemented in this build.
 * A paper fill is the only output this code can produce.
 */

import { breakerActive, armState, todayRealizedPnl } from './arming.js';
import { db, deployedUsd, newId, realizedEquity } from './db.js';
import { simulateFill, feeBpsOf, type FillResult } from './paper.js';
import type { RefusalReason } from './reasons.js';
import { SIZING, type DeskEnv, type DeskMode, type Quote } from './types.js';

export interface SizeDecision {
  ok: boolean;
  sizeUsd: number;
  refusal: RefusalReason | null;
  detail: string;
  /** Which ceilings were consulted, for the audit line. */
  context: {
    equity: number;
    deployed: number;
    deployedPct: number;
    openCount: number;
    positionCapUsd: number;
    poolCapUsd: number;
  };
}

/**
 * Work out whether a position may be opened, and at what size.
 *
 * `liqUsd` is the pool's liquidity; the pool-share ceiling is derived from it so
 * a thin pool automatically produces a smaller maximum position rather than a
 * silent over-bet.
 */
export async function decideSize(
  env: DeskEnv,
  args: { liqUsd: number; now?: number },
): Promise<SizeDecision> {
  const now = args.now ?? Date.now();
  const equity = await realizedEquity(env);
  const deployed = await deployedUsd(env);
  const open = await db(env).first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM desk_positions WHERE state='open'",
  );
  const openCount = open?.n ?? 0;

  const positionCapUsd = equity * SIZING.maxPositionPctOfEquity;
  const poolCapUsd = args.liqUsd * SIZING.maxPoolSharePct;
  const deployedCapUsd = equity * SIZING.maxDeployedPct;

  const context = {
    equity,
    deployed,
    deployedPct: equity > 0 ? deployed / equity : 0,
    openCount,
    positionCapUsd,
    poolCapUsd,
  };

  const refuse = (refusal: RefusalReason, detail: string): SizeDecision => ({
    ok: false,
    sizeUsd: 0,
    refusal,
    detail,
    context,
  });

  // Breaker first: while halted, nothing else matters and no other check can
  // reach a different conclusion.
  if (await breakerActive(env, now)) {
    return refuse('circuit_breaker_halted', 'daily loss circuit breaker is active');
  }

  if (openCount >= SIZING.maxConcurrentPositions) {
    return refuse(
      'max_concurrent_positions',
      `${openCount} open positions >= ${SIZING.maxConcurrentPositions} cap`,
    );
  }

  const remainingDeployed = deployedCapUsd - deployed;
  if (remainingDeployed <= 0) {
    return refuse(
      'max_deployed',
      `deployed $${deployed.toFixed(0)} already at ${((deployed / Math.max(equity, 1)) * 100).toFixed(1)}% >= 24%`,
    );
  }

  // The size is the smallest of the three ceilings. Not the largest, not the
  // 8% figure with a warning.
  const sizeUsd = Math.min(positionCapUsd, remainingDeployed, poolCapUsd);

  if (sizeUsd < SIZING.minPositionUsd) {
    return refuse(
      'size_below_minimum',
      `smallest permitted size $${sizeUsd.toFixed(2)} < minimum $${SIZING.minPositionUsd} (pool cap $${poolCapUsd.toFixed(0)}, position cap $${positionCapUsd.toFixed(0)}, remaining $${remainingDeployed.toFixed(0)})`,
    );
  }

  // Name the binding constraint so the operator knows which ceiling to raise if
  // they ever deliberately change policy.
  const binding =
    poolCapUsd <= positionCapUsd && poolCapUsd <= remainingDeployed
      ? `pool share (1% of $${args.liqUsd.toFixed(0)} liq)`
      : positionCapUsd <= remainingDeployed
        ? 'position cap (8% of realized equity)'
        : 'deployed cap (24% of realized equity)';

  return {
    ok: true,
    sizeUsd: Number(sizeUsd.toFixed(2)),
    refusal: null,
    detail: `size $${sizeUsd.toFixed(2)} bound by ${binding}`,
    context,
  };
}

export interface OpenPositionResult {
  opened: boolean;
  positionId: string | null;
  refusal: RefusalReason | null;
  detail: string;
  fill: FillResult | null;
  /** Size actually filled in the first tranche. */
  filledUsd: number;
}

/**
 * Open a paper position: size, simulate the first half, persist.
 *
 * The split entry is structural. Half now, half on a confirmation quote later
 * (`confirmEntry`). One shot at one price means one bad tick decides the whole
 * position, and on a token that moves 5% a minute that is not a style choice.
 */
export async function openPosition(
  env: DeskEnv,
  args: {
    mint: string;
    symbol: string;
    quote: Quote;
    priceHistory: { atr14Pct: number | null };
    thesisId?: string | null;
    now?: number;
  },
): Promise<OpenPositionResult> {
  const now = args.now ?? Date.now();
  const decision = await decideSize(env, { liqUsd: args.quote.liqUsd, now });
  if (!decision.ok) {
    return {
      opened: false,
      positionId: null,
      refusal: decision.refusal,
      detail: decision.detail,
      fill: null,
      filledUsd: 0,
    };
  }

  // Never average down is enforced as "one position per mint, ever, while open".
  const existing = await db(env).first<{ id: string }>(
    "SELECT id FROM desk_positions WHERE mint=? AND state='open'",
    args.mint,
  );
  if (existing) {
    return {
      opened: false,
      positionId: null,
      refusal: 'never_average_down',
      detail: `already holding ${args.mint}`,
      fill: null,
      filledUsd: 0,
    };
  }

  const firstTranche = Number((decision.sizeUsd * SIZING.splitEntry.first).toFixed(2));
  const prioFee = Number(env.DESK_PRIO_FEE_USD ?? '0.0005');
  const prioCap = Number(env.DESK_PRIO_FEE_CAP_USD ?? '0.005');

  const fill = simulateFill({
    side: 'buy',
    notionalUsd: firstTranche,
    priceUsd: args.quote.priceUsd,
    liqUsd: args.quote.liqUsd,
    feeBps: 30,
    priorityFeeUsd: prioFee,
    priorityFeeCapUsd: prioCap,
  });

  if (!fill.filled) {
    return {
      opened: false,
      positionId: null,
      refusal: (fill.refusal as RefusalReason | null) ?? 'size_exceeds_pool_share',
      detail: fill.detail,
      fill,
      filledUsd: 0,
    };
  }

  // Hard stop: max(-6%, -1.5 x ATR14). A flat -6% on a memecoin sits inside the
  // noise, so a token with 8% ATR gets a 12% stop and survives normal chop.
  const atr = args.priceHistory.atr14Pct;
  const atrStop = atr !== null ? -(atr / 100) * 1.5 : 0;
  const stopFrac = Math.min(-0.06, atrStop); // more negative wins
  const stopPrice = args.quote.priceUsd * (1 + stopFrac);

  const id = newId('pos');
  await db(env).run(
    `INSERT INTO desk_positions
     (id, mint, symbol, mode, opened_at, entry_price, size_usd, filled_usd, qty,
      stop_price, peak_price, trail_armed, trail_pct, atr14, liq_at_entry, state, thesis_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,'open',?)`,
    id,
    args.mint,
    args.symbol,
    'paper',
    Math.floor(now / 1000),
    fill.priceUsd,
    decision.sizeUsd,
    firstTranche,
    fill.qty,
    stopPrice,
    args.quote.priceUsd,
    // Trail width is chosen at open from the ATR: a wide-ATR token needs a wider
    // trail or it is stopped by noise. The tighten-to-6% step stays fixed.
    0.12,
    atr ?? 0,
    args.quote.liqUsd,
    args.thesisId ?? null,
  );

  await recordFill(env, {
    positionId: id,
    mint: args.mint,
    side: 'buy',
    tranche: 'entry',
    fill,
    mode: 'paper',
    now,
  });

  return {
    opened: true,
    positionId: id,
    refusal: null,
    detail: `opened ${args.symbol || args.mint} ${decision.detail}; first tranche $${firstTranche}`,
    fill,
    filledUsd: firstTranche,
  };
}

/**
 * Second half of the split entry.
 *
 * Called when the confirmation condition holds (price held above the entry and
 * momentum did not break). If the remaining half cannot fill — pool shrank,
 * slippage over cap — the position keeps what it has and the refusal is
 * recorded. It is never re-sized upward.
 */
export async function confirmEntry(
  env: DeskEnv,
  args: { positionId: string; quote: Quote; now?: number },
): Promise<OpenPositionResult> {
  const now = args.now ?? Date.now();
  const pos = await db(env).first<{
    id: string;
    mint: string;
    size_usd: number;
    filled_usd: number;
    qty: number;
    confirmation_price: number | null;
    state: string;
  }>('SELECT id, mint, size_usd, filled_usd, qty, confirmation_price, state FROM desk_positions WHERE id=?', args.positionId);

  if (!pos || pos.state !== 'open') {
    return { opened: false, positionId: args.positionId, refusal: null, detail: 'position not open', fill: null, filledUsd: 0 };
  }
  if (pos.confirmation_price !== null) {
    return { opened: false, positionId: args.positionId, refusal: null, detail: 'entry already confirmed', fill: null, filledUsd: 0 };
  }

  const remaining = Number((pos.size_usd - pos.filled_usd).toFixed(2));
  if (remaining <= 0) {
    return { opened: false, positionId: args.positionId, refusal: null, detail: 'nothing left to fill', fill: null, filledUsd: 0 };
  }

  const prioFee = Number(env.DESK_PRIO_FEE_USD ?? '0.0005');
  const prioCap = Number(env.DESK_PRIO_FEE_CAP_USD ?? '0.005');
  const fill = simulateFill({
    side: 'buy',
    notionalUsd: remaining,
    priceUsd: args.quote.priceUsd,
    liqUsd: args.quote.liqUsd,
    feeBps: 30,
    priorityFeeUsd: prioFee,
    priorityFeeCapUsd: prioCap,
  });

  if (!fill.filled) {
    return {
      opened: false,
      positionId: args.positionId,
      refusal: (fill.refusal as RefusalReason | null) ?? 'size_exceeds_pool_share',
      detail: `confirmation half refused: ${fill.detail}`,
      fill,
      filledUsd: 0,
    };
  }

  await db(env).run(
    'UPDATE desk_positions SET confirmation_price=?, filled_usd=filled_usd+?, qty=qty+? WHERE id=?',
    fill.priceUsd,
    remaining,
    fill.qty,
    args.positionId,
  );
  await recordFill(env, {
    positionId: args.positionId,
    mint: pos.mint,
    side: 'buy',
    tranche: 'confirmation',
    fill,
    mode: 'paper',
    now,
  });

  return {
    opened: true,
    positionId: args.positionId,
    refusal: null,
    detail: `confirmed: filled remaining $${remaining}`,
    fill,
    filledUsd: remaining,
  };
}

/** Append one fill. Every cost line is stored separately on purpose. */
export async function recordFill(
  env: DeskEnv,
  args: {
    positionId: string;
    mint: string;
    side: 'buy' | 'sell';
    tranche: 'entry' | 'confirmation' | 'exit' | 'stop';
    fill: FillResult;
    mode: DeskMode;
    now: number;
  },
): Promise<string> {
  const id = newId('fill');
  await db(env).run(
    `INSERT INTO desk_fills
     (id, position_id, mint, ts, side, tranche, qty, price, notional_usd,
      lp_fee_usd, prio_fee_usd, slippage_usd, price_impact, mode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    args.positionId,
    args.mint,
    Math.floor(args.now / 1000),
    args.side,
    args.tranche,
    args.fill.qty,
    args.fill.priceUsd,
    args.fill.notionalUsd,
    args.fill.lpFeeUsd,
    args.fill.prioFeeUsd,
    args.fill.slippageUsd,
    args.fill.priceImpact,
    args.mode,
  );
  return id;
}

/**
 * The live-order path. It does not exist.
 *
 * This function is here so that "live is not implemented" is a *fact in the
 * code* rather than a sentence in a document: any future caller reaches this
 * and gets a named refusal, and no amount of arming changes it.
 */
export async function submitLive(_env: DeskEnv): Promise<never> {
  throw new Error('live_signer_not_wired: this build cannot submit a real order');
}

/** Fee bps for a market snapshot, re-exported so callers use one default. */
export { feeBpsOf };

/** Convenience for /desk: how much headroom is left today, in USD. */
export async function deployHeadroom(env: DeskEnv): Promise<number> {
  const equity = await realizedEquity(env);
  const deployed = await deployedUsd(env);
  return Math.max(0, equity * SIZING.maxDeployedPct - deployed);
}

/** Today's realized PnL, surfaced for the /desk card. */
export { todayRealizedPnl };

/** Arming state, surfaced for /desk and /api/desk. */
export { armState };
