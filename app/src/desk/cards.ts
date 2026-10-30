/**
 * The Telegram surface for the desk.
 *
 * Six commands, and deliberately nothing more. In particular there is no
 * "arm live" button and no callback that can change mode: live arming is
 * `wrangler secret put` in a terminal plus the gates in arming.ts. A button that
 * starts real trading is one leaked bot token away from an empty wallet.
 *
 * Every card states the mode and, in paper, why it is paper. An operator who
 * cannot see which gates are unmet will not know what to do about them.
 */

import { esc } from '../telegram.js';
import { db, realizedEquity } from './db.js';
import { latestCalibration, type CalibrationReport, type CalibrationRow } from './logger.js';
import { killRows, positionRows, deskStatus } from './pipeline.js';
import { latestThesis } from './thesis.js';
import { EXIT_TEXT, REFUSAL_TEXT, REASON_TEXT, pct, usd, type ExitReason, type RefusalReason, type KillReason } from './reasons.js';
import type { DeskEnv, DeskSource } from './types.js';

function line(label: string, value: string): string {
  return `<b>${esc(label)}</b>  ${esc(value)}`;
}

/** `/desk` — mode, equity, arming gates. */
export async function deskCard(env: DeskEnv, now = Date.now()): Promise<string> {
  const s = await deskStatus(env, now);
  const out: string[] = [];

  out.push(`<b>DESK</b>  ${s.mode === 'live' ? 'LIVE' : 'PAPER'}`);
  out.push(
    s.mode === 'paper'
      ? `<i>paper only — ${s.gates_unmet.length} arming gate(s) unmet, no real orders are possible in this build</i>`
      : '<i>live mode armed</i>',
  );
  out.push('');

  out.push(line('equity', `${usd(s.equity)} (realized cash)`));
  out.push(line('deployed', `${pct(s.deployed_pct * 100, 1)} of equity`));
  out.push(line('open', `${s.open_positions} / 3 positions`));
  out.push(line('today', `${s.pnl_today >= 0 ? '+' : ''}${usd(s.pnl_today)}`));

  if (s.breaker_halted) {
    const until = new Date(s.breaker_until).toISOString().replace('T', ' ').slice(0, 16);
    out.push('');
    out.push(`<b>HALTED</b> by the daily loss circuit breaker until ${esc(until)} UTC.`);
    out.push('<i>No override exists in this bot. The halt expires on its own.</i>');
  }

  out.push('');
  out.push(`<b>Kills today</b> ${s.kills_today} &nbsp; <b>Coverage gaps</b> ${s.coverage_gaps}`);
  out.push(`<i>a coverage gap means the free data tier could not supply a flow metric; the token was not judged, not rejected</i>`);

  out.push('');
  out.push('<b>Arming gates</b>');
  for (const g of s.gates) {
    out.push(`${g.met ? '\u2713' : '\u2717'} ${esc(g.name)}: ${esc(g.actual)} <i>(needs ${esc(g.requirement)})</i>`);
  }

  if (s.gates_unmet.length > 0) {
    out.push('');
    out.push('<i>Live requires all of the above. None of them can be met from chat.</i>');
  }
  return out.join('\n');
}

/** `/pos` — open positions with live mark. */
export async function positionsCard(env: DeskEnv, source?: DeskSource): Promise<string> {
  const rows = await positionRows(env, source);
  if (rows.length === 0) return '<b>No open positions.</b>\n<i>The desk opens nothing until a token passes every gate.</i>';

  const out = ['<b>OPEN POSITIONS</b>', ''];
  for (const p of rows) {
    out.push(
      `<b>${esc(p.symbol)}</b>  ${p.pnl_pct >= 0 ? '+' : ''}${(p.pnl_pct * 100).toFixed(1)}%  (${p.pnl >= 0 ? '+' : ''}${usd(p.pnl)})`,
    );
    out.push(
      `  size ${usd(p.size)} · entry $${p.entry.toPrecision(6)} · now $${p.current.toPrecision(6)}`,
    );
    out.push(`  stop $${p.stop.toPrecision(6)} · age ${p.age_hours.toFixed(1)}h · <code>${esc(p.mint)}</code>`);
  }
  return out.join('\n');
}

/** `/kills` — last 20 kills with reason codes. */
export async function killsCard(env: DeskEnv, limit = 20): Promise<string> {
  const rows = await killRows(env, limit);
  if (rows.length === 0) return '<b>No kills recorded yet.</b>';

  const out = [`<b>LAST ${rows.length} KILLS</b>`, ''];
  for (const k of rows) {
    const when = new Date(k.ts * 1000).toISOString().slice(5, 16).replace('T', ' ');
    out.push(`<b>${esc(k.reason_code)}</b> · ${esc(k.symbol)} · ${esc(when)}`);
    out.push(`  ${esc(k.detail.slice(0, 160))}`);
  }
  out.push('');
  out.push('<i>reason codes and what each means: /calib for hit rates, TRADING.md for the definitions</i>');
  return out.join('\n');
}

/** `/thesis <mint>` — the stored why, plus the score breakdown. */
export async function thesisCard(env: DeskEnv, mint: string): Promise<string> {
  const t = await latestThesis(env, mint);
  if (!t) return `<b>No thesis stored for</b> <code>${esc(mint)}</code>\n<i>A token only gets a thesis after it passes every filter gate.</i>`;

  const score = await db(env).first<{ total: number; passed: number; why: string }>(
    'SELECT total, passed, why FROM desk_scores WHERE mint=? ORDER BY ts DESC LIMIT 1',
    mint,
  );

  const out = [`<b>THESIS</b> <code>${esc(mint)}</code>`, ''];
  if (score) {
    out.push(line('score', `${score.total.toFixed(0)}/100 (${score.passed ? 'passed' : 'refused'})`));
    out.push('');
    out.push(`<i>${esc(score.why)}</i>`);
    out.push('');
  }
  out.push(esc(t.body));
  out.push('');
  out.push(`<i>source: ${esc(t.source)}${t.model ? ` (${esc(t.model)})` : ''} · ${esc(new Date(t.ts * 1000).toISOString().slice(0, 16).replace('T', ' '))} UTC</i>`);
  return out.join('\n');
}

/**
 * `/calib` — the weekly calibration report.
 *
 * This is the card that makes the desk a model rather than a journal: it says,
 * per kill reason, whether avoiding those tokens was right.
 */
export async function calibCard(env: DeskEnv, now = Date.now()): Promise<string> {
  const { stored, report } = await latestCalibration(env, now);
  const out = ['<b>CALIBRATION</b>', ''];

  const from = new Date(report.window_start * 1000).toISOString().slice(0, 10);
  const to = new Date(report.window_end * 1000).toISOString().slice(0, 10);
  out.push(`<i>window ${esc(from)} to ${esc(to)}${stored ? '' : ' (live, not yet stored)'}</i>`);
  out.push('');

  /*
   * The execution haircut, printed FIRST and always - before the kill rates and
   * before any "unmeasured" note.
   *
   * Paper PnL that ignores MEV and failed transactions is structurally optimistic,
   * and an optimistic paper record is exactly what would eventually justify a live
   * order. So the assumption is labelled with its named constant, its configured
   * value, and what it has actually cost so far. When it has charged nothing, an
   * operator can see the model is still running on assumptions rather than trades.
   */
  if (report.haircut) {
    const h = report.haircut;
    out.push('<b>Execution haircut</b> (paper model)');
    out.push(
      `  MEV <code>${h.mev_bps}bps</code> + failed-tx <code>${h.failed_tx_bps}bps</code> = ` +
        `<code>${h.total_bps}bps</code> per leg <i>(${h.source === 'env' ? 'env override' : 'EXECUTION_HAIRCUT constant'})</i>`,
    );
    out.push(`  charged so far: <b>$${h.charged_usd.toFixed(2)}</b> across ${h.fills} recorded fill(s)`);
    out.push('');
  }

  if (report.rows.length === 0) {
    out.push('No kills in the window, so there is nothing to calibrate.');
    out.push('');
    out.push(`<i>${esc(report.note)}</i>`);
    out.push(...coverageLines(report));
    return out.join('\n');
  }

  out.push(`<b>Kills</b> ${report.totals.kills} \u00b7 <b>measured</b> ${report.totals.measured}`);
  out.push(`<b>True positives</b> (went to -90%) ${report.totals.true_positives}`);
  out.push(`<b>False negatives</b> (later 3x'd) ${report.totals.false_negatives}`);
  out.push('');

  for (const r of report.rows) {
    out.push(formatCalibRow(r));
  }
  out.push('');
  out.push(`<i>${esc(report.note)}</i>`);
  out.push(...coverageLines(report));
  return out.join('\n');
}

/**
 * Why a rate is or is not measured, in the card.
 *
 * "unmeasured" on its own is indistinguishable from "broken". These lines say
 * whether the forward price series is too young and whether the flow provider has
 * cached anything - the difference between a desk that needs time and a desk that
 * needs a fix.
 */
function coverageLines(report: CalibrationReport): string[] {
  const out: string[] = [];
  if (report.marks) {
    const m = report.marks;
    out.push('');
    out.push(
      `<b>Price series</b> ${m.marks} marks over ${m.mints} mints \u00b7 span ${m.span_hours}h \u00b7 ` +
        `${m.dense_mints} dense enough to judge`,
    );
    if (m.dense_mints === 0) {
      out.push('<i>no series is dense enough yet - outcomes stay unmeasured until one is</i>');
    }
  }
  if (report.flow) {
    out.push(
      `<b>Flow sample</b> ${esc(report.flow.source)} \u00b7 ${report.flow.cached_mints} mint(s) cached` +
        (report.flow.newest_ts
          ? ` \u00b7 newest ${esc(new Date(report.flow.newest_ts * 1000).toISOString().slice(0, 16).replace('T', ' '))}Z`
          : ''),
    );
  }
  return out;
}

function formatCalibRow(r: CalibrationRow): string {
  if (r.thin) {
    return `<b>${esc(r.reason_code)}</b> · ${r.kills} kills · <i>too few measured to rate</i>`;
  }
  const fn = r.false_negative_rate === null ? 'n/a' : pct(r.false_negative_rate * 100, 0);
  const tp = r.dodge_rate === null ? 'n/a' : pct(r.dodge_rate * 100, 0);
  return `<b>${esc(r.reason_code)}</b> · ${r.kills} kills · dodged ${tp} · <b>missed</b> ${fn}`;
}

/** `/desk paper|live` — the mode request, and the refusal. */
export async function modeCard(env: DeskEnv, want: 'paper' | 'live'): Promise<string> {
  const { requestMode } = await import('./arming.js');
  const state = await requestMode(env, want);
  const out: string[] = [];

  if (want === 'paper') {
    out.push('<b>Desk mode: PAPER.</b>');
    out.push('Recorded. Every fill from here is simulated against real pool state.');
    return out.join('\n');
  }

  if (state.armed) {
    out.push('<b>All arming gates are met.</b>');
    out.push('');
    out.push(
      '<i>But this build still cannot place a real order: live submission is not implemented ' +
        '(executor.submitLive throws live_signer_not_wired). The desk remains in paper.</i>',
    );
    return out.join('\n');
  }

  out.push('<b>Live refused.</b> The desk stays in paper.');
  out.push('');
  out.push('<b>Unmet gates</b>');
  for (const g of state.gates.filter((x) => !x.met)) {
    out.push(`\u2717 ${esc(g.name)}: ${esc(g.actual)} <i>(needs ${esc(g.requirement)})</i>`);
  }
  out.push('');
  out.push('<i>None of these can be satisfied from chat. They are read from secrets and from the paper track record.</i>');
  return out.join('\n');
}

/** Human text for a reason code, used by cards and tests. */
export function reasonText(code: string): string {
  return (REASON_TEXT as Record<string, string>)[code] ?? (EXIT_TEXT as Record<string, string>)[code] ?? (REFUSAL_TEXT as Record<string, string>)[code] ?? 'unknown reason code';
}

export type { KillReason, ExitReason, RefusalReason };

/** Equity helper re-exported so index.ts has one desk entry surface. */
export { realizedEquity };
