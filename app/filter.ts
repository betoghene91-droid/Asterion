/**
 * Filter — the kills.
 *
 * ## Why this file separates "kill" from "cannot judge"
 *
 * Every gate needs a fact. Two very different things can be true when a fact is
 * missing, and collapsing them would break the desk in one of two ways:
 *
 *  - **Safety facts** (freeze authority, mint authority, token extensions, LP
 *    lock, the sell simulation) are cheap and always available from a free
 *    contract report. Failing to read one is itself a signal, so unknown here is
 *    a **KILL** (`safety_data_unknown`). This is the fail-closed half.
 *  - **Flow facts** (unique buyers / total buys, same-slot bundles, first-20
 *    sniper cohort, deployer funding-graph cluster) need trade-level indexing
 *    that the free sources do not provide. Treating those as kills would make
 *    the desk kill 100% of the universe and look strict while actually being
 *    broken; treating them as passes would let wash-traded launches through. So
 *    they are reported as `unknowns`, and the pipeline refuses to score the
 *    token — it is not a kill, it is a **coverage gap**, and it is counted
 *    separately and shown in `/desk`.
 *
 * That distinction is the honest one: a token we could not judge is not a token
 * we judged bad, and the calibration report must never count a coverage gap as a
 * dodge.
 *
 * ## Determinism
 * A token usually fails several gates. `REASON_ORDER` fixes the walking order so
 * the recorded primary reason is reproducible, which is what makes the weekly
 * calibration comparable across weeks.
 */

import { concentration, type HolderEntry, type KnownAccounts } from './holders.js';
import type { KillFinding, KillReason } from './reasons.js';
import { pct, usd } from './reasons.js';
import { DANGEROUS_TOKEN2022_EXTENSIONS, FILTER, type TokenDossier } from './types.js';

export interface FilterResult {
  /** True only when nothing was killed AND nothing was unreadable. */
  passed: boolean;
  kills: KillFinding[];
  /** Facts we could not read. Non-empty means "not judged", not "bad". */
  unknowns: string[];
  /** Primary reason = first kill in REASON_ORDER. Null when nothing was killed. */
  primary: KillReason | null;
  /** Diagnostics that are not gates but are worth recording. */
  notes: string[];
}

/**
 * Does this Token-2022 mint carry an extension that can hurt a holder?
 *
 * Transfer fee is handled separately because the rule is a threshold (>5%), not
 * mere presence: a 30bps transfer fee is a real cost but not a honeypot.
 */
export function dangerousExtension(extensions: string[]): string | null {
  for (const raw of extensions) {
    const e = raw.toLowerCase().replace(/[\s_-]/g, '');
    if (!e) continue;
    if (e === 'transferfeeconfig' || e === 'transferfee') continue; // threshold-checked
    if (DANGEROUS_TOKEN2022_EXTENSIONS.some((d) => d.replace(/[_-]/g, '') === e)) return raw;
  }
  return null;
}

/**
 * The gate walk.
 *
 * `sizeUsd` is the size we would actually try to buy. It matters: the honeypot
 * simulation is a simulation *of our exit*, so "is this a honeypot" is only
 * answerable relative to a position size. Passing 0 would make the probe
 * meaningless, so it is required.
 */
export function evaluate(
  d: TokenDossier,
  opts: { sizeUsd: number; known: KnownAccounts; holders?: HolderEntry[] },
): FilterResult {
  const kills: KillFinding[] = [];
  const unknowns: string[] = [];
  const notes: string[] = [];
  const s = d.safety;
  const h = d.holders;
  const m = d.market;

  const push = (reason: KillReason, detail: string) => kills.push({ reason, detail });

  // ── 1. freeze authority — SAFETY, fail closed ──────────────────────────
  // First on purpose. A live freeze authority lets the deployer block every
  // external seller while keeping its own transfers open: the token quotes
  // fine, looks liquid, and nobody can leave. That is the honeypot.
  if (s.freezeAuthorityRevoked !== true) {
    push(
      'freeze_authority_live',
      s.freezeAuthorityRevoked === false
        ? 'freeze authority present — deployer can freeze any holder at will'
        : 'freeze authority state unreadable; treated as live',
    );
  }

  // ── 2. mint authority — SAFETY, fail closed ────────────────────────────
  if (s.mintAuthorityRevoked !== true) {
    push(
      'mint_authority_live',
      s.mintAuthorityRevoked === false
        ? 'mint authority present — supply can be inflated at will'
        : 'mint authority state unreadable; treated as live',
    );
  }

  // ── 3. Token-2022 extensions — SAFETY ─────────────────────────────────
  const bad = dangerousExtension(s.extensions);
  if (bad) {
    push('token2022_dangerous_extension', `Token-2022 extension present: ${bad}`);
  } else if (s.transferFeeBps !== null && s.transferFeeBps > FILTER.maxTransferFeeBps) {
    push(
      'token2022_dangerous_extension',
      `transfer fee ${s.transferFeeBps}bps above the ${FILTER.maxTransferFeeBps}bps ceiling`,
    );
  }

  // ── 4. mutable metadata AND upgradeable program — SAFETY ──────────────
  // Only the conjunction is fatal. Mutable metadata alone is common and fixable;
  // an upgradeable program alone is normal on launchpads. Both together means
  // ticker, name and transfer logic can all change after purchase.
  if (s.metadataMutable === true && s.programUpgradeable === true) {
    push('metadata_mutable_upgradeable', 'metadata mutable AND program upgradeable');
  }

  // ── 5. honeypot sell simulation — SAFETY, fail closed ─────────────────
  if (!d.sell) {
    push('safety_data_unknown', 'sell simulation did not run; cannot rule out a honeypot');
  } else if (!d.sell.ok) {
    push(
      'honeypot_sell_reverts',
      `simulated exit of ${usd(opts.sizeUsd)} reverts${d.sell.revertReason ? `: ${d.sell.revertReason}` : ''}`,
    );
  } else if (d.sell.priceImpactPct > FILTER.maxHoneypotImpactPct) {
    push(
      'honeypot_impact_exceeded',
      `simulated exit of ${usd(opts.sizeUsd)} costs ${pct(d.sell.priceImpactPct)} impact > ${FILTER.maxHoneypotImpactPct}%`,
    );
  }

  // ── 6. LP burned or locked >= 30 days — SAFETY, fail closed ────────────
  const burned = s.lpBurned === true;
  const lockedEnough =
    s.lpLockDaysRemaining !== null && s.lpLockDaysRemaining >= FILTER.minLpLockDays;
  if (!burned && !lockedEnough) {
    if (s.lpBurned === null && s.lpLockDaysRemaining === null) {
      push('lp_unlocked', 'LP burn/lock state unreadable; treated as unlocked');
    } else {
      push(
        'lp_unlocked',
        `LP not burned; lock remaining ${s.lpLockDaysRemaining === null ? 'unknown' : `${s.lpLockDaysRemaining.toFixed(0)}d`} < ${FILTER.minLpLockDays}d`,
      );
    }
  }

  // ── 7. liquidity ratio — MARKET, always readable ──────────────────────
  const required = Math.max(40_000, m.mcapUsd * 0.03);
  if (m.liqUsd < required) {
    push('liq_below_ratio_gate', `liq ${usd(m.liqUsd)} < required ${usd(required)}`);
  }

  // ── 8. 1h volume — MARKET ─────────────────────────────────────────────
  if (m.vol1hUsd < FILTER.minVol1hUsd) {
    push('volume_1h_low', `1h volume ${usd(m.vol1hUsd)} < ${usd(FILTER.minVol1hUsd)}`);
  }

  // ── 9. holder concentration, with exclusions — MARKET ─────────────────
  // The exclusion is load-bearing: on the live pair checked on 2026-10-29 the
  // single largest "holder" at 11.93% was the AMM's own vault.
  if (opts.holders && opts.holders.length > 0) {
    const c = concentration(opts.holders, opts.known);
    notes.push(
      `top10 raw ${pct(c.rawTop10Pct, 1)} -> ex-pool ${pct(c.excludedTop10Pct, 1)}` +
        (c.excluded.length
          ? ` (removed ${c.excluded.map((e) => `${e.kind} ${pct(e.pct, 1)}`).join(', ')})`
          : ''),
    );
    if (c.excludedTop10Pct > FILTER.maxTop10ExcludedPct) {
      push(
        'top10_concentrated',
        `top-10 excluding pool/burn/CEX = ${pct(c.excludedTop10Pct, 1)} > ${FILTER.maxTop10ExcludedPct}% (raw was ${pct(c.rawTop10Pct, 1)})`,
      );
    }
  } else if (h.top10ExcludedPct === null) {
    unknowns.push('holder distribution');
  } else if (h.top10ExcludedPct > FILTER.maxTop10ExcludedPct) {
    push(
      'top10_concentrated',
      `top-10 excluding pool/burn/CEX = ${pct(h.top10ExcludedPct, 1)} (raw ${pct(h.top10RawPct ?? 0, 1)})`,
    );
  }

  // ── 10. dev wallet — MARKET (creator balance) / FLOW (prior rug) ───────
  if (h.devPriorRug === true) {
    push('dev_prior_rug', 'dev wallet has a prior rug in its funding-graph history');
  }
  if (h.devPct !== null && h.devPct > FILTER.maxDevPct) {
    push('dev_holding', `dev holds ${pct(h.devPct, 2)} > ${FILTER.maxDevPct}%`);
  } else if (h.devPct === null) {
    unknowns.push('dev holding');
  }

  // ── 11. bundled launch — FLOW ─────────────────────────────────────────
  if (h.bundledPct !== null && h.bundledPct > FILTER.maxBundledPct) {
    push(
      'bundled_launch',
      `bundled (same-slot/same-funder) ${pct(h.bundledPct, 1)} > ${FILTER.maxBundledPct}%`,
    );
  } else if (h.bundledPct === null) {
    unknowns.push('bundled launch share');
  }

  // ── 12. sniper cohort — FLOW ──────────────────────────────────────────
  if (h.sniper20Pct !== null && h.sniper20Pct > FILTER.maxSniper20Pct) {
    push(
      'sniper_concentration',
      `first-20-buyer cohort ${pct(h.sniper20Pct, 1)} > ${FILTER.maxSniper20Pct}%`,
    );
  } else if (h.sniper20Pct === null) {
    unknowns.push('sniper cohort');
  }

  // ── 13. wash trading — FLOW ───────────────────────────────────────────
  if (h.uniqueBuyers !== null && h.totalBuys !== null && h.totalBuys > 0) {
    const ratio = h.uniqueBuyers / h.totalBuys;
    if (ratio < FILTER.minUniqueBuyerRatio) {
      push(
        'wash_trading',
        `unique buyers ${h.uniqueBuyers} / total buys ${h.totalBuys} = ${ratio.toFixed(2)} < ${FILTER.minUniqueBuyerRatio}`,
      );
    }
  } else {
    unknowns.push('unique-buyer ratio');
  }

  // ── 14. dev cluster via funding graph — FLOW ──────────────────────────
  if (h.devClusterPct !== null && h.devClusterPct > FILTER.maxDevClusterPct) {
    push(
      'dev_cluster',
      `deployer-funded wallets hold ${pct(h.devClusterPct, 1)} > ${FILTER.maxDevClusterPct}%`,
    );
  } else if (h.devClusterPct === null) {
    unknowns.push('deployer funding cluster');
  }

  // ── 15. buy pressure — FLOW ────────────────────────────────
  // Required by the analyst's buyPressure component (buy/sell ratio AND size
  // skew). Without it the component cannot be scored at all, so its absence is a
  // coverage gap rather than a zero.
  if (h.buyVolumeUsd === null || h.sellVolumeUsd === null) {
    unknowns.push('buy/sell volume split');
  }

  // ── 16. smart-wallet presence — FLOW + curated list ──────────
  // Not a kill gate, but load-bearing for the score's 15-point component. An
  // unconfigured list used to score 0 and silently sink the total; reporting it
  // as missing is the honest version.
  if (h.smartWalletPct === null) {
    unknowns.push('curated smart-wallet presence');
  }

  // ── 17. ATR14 — FLOW-derived ─────────────────────────────────
  // A missing ATR does not block entry (the stop falls back to the flat -6%),
  // but it is recorded so /thesis can say the stop was not volatility-scaled.
  if (h.atr14Pct === null) {
    notes.push('ATR14 unavailable — hard stop falls back to the flat -6% floor');
  }

  // ── 15. late entry — MARKET ───────────────────────────────────────────
  // Replaces the flat "+80% in 1h". That rule was one arm of this: a token up
  // 80% is usually also above 1.8x its 6h low. Expressing the gate as multiples
  // of recent lows measures the same chase while not killing a token that rose
  // on a genuinely higher low.
  if (m.price24hLowUsd > 0 && m.priceUsd > m.price24hLowUsd * FILTER.maxMultipleOf24hLow) {
    push(
      'late_entry',
      `price ${(m.priceUsd / m.price24hLowUsd).toFixed(2)}x the 24h low > ${FILTER.maxMultipleOf24hLow}x`,
    );
  } else if (m.price6hLowUsd > 0 && m.priceUsd > m.price6hLowUsd * FILTER.maxMultipleOf6hLow) {
    push(
      'late_entry',
      `price ${(m.priceUsd / m.price6hLowUsd).toFixed(2)}x the 6h low > ${FILTER.maxMultipleOf6hLow}x`,
    );
  }

  const ordered = orderKills(kills);
  return {
    // A kill is decisive. An unknown is not a pass: the pipeline refuses to
    // score, so `passed` requires both to be empty.
    passed: ordered.length === 0 && unknowns.length === 0,
    kills: ordered,
    unknowns,
    primary: ordered[0]?.reason ?? null,
    notes,
  };
}

/** Sort by REASON_ORDER position; keeps multi-kill detail deterministic. */
export function orderKills(kills: KillFinding[]): KillFinding[] {
  const order: KillReason[] = [
    'freeze_authority_live',
    'mint_authority_live',
    'token2022_dangerous_extension',
    'metadata_mutable_upgradeable',
    'safety_data_unknown',
    'honeypot_sell_reverts',
    'honeypot_impact_exceeded',
    'lp_unlocked',
    'liq_below_ratio_gate',
    'volume_1h_low',
    'top10_concentrated',
    'dev_prior_rug',
    'dev_holding',
    'bundled_launch',
    'sniper_concentration',
    'wash_trading',
    'dev_cluster',
    'late_entry',
  ];
  return [...kills].sort((a, b) => {
    const ia = order.indexOf(a.reason);
    const ib = order.indexOf(b.reason);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}
