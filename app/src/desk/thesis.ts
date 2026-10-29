/**
 * Thesis prose — the ONLY place an LLM touches the desk.
 *
 * The boundary that matters is structural, not a convention:
 *
 *   - `writeThesis()` returns `string`. It cannot return a score or a size,
 *     because its return type does not have one. Even a fully compromised model
 *     response cannot move `desk_scores.total` or `desk_positions.size_usd`.
 *   - The prose is written to `desk_theses` with the `source` column saying
 *     whether a model wrote it. A failed model call still produces a thesis —
 *     the deterministic one — so the desk never has a position with no "why".
 *   - The model is given numbers that are already decided. It is asked to
 *     explain, not to judge. That keeps the explanation auditable: if the prose
 *     disagrees with the score, the score wins and the disagreement is visible.
 *
 * Where the LLM genuinely helps: turning seven sub-scores and a kill history
 * into a paragraph a human can check. Where it must never be trusted: sizing,
 * safety gates, and whether a token passes. Those are arithmetic and hard
 * comparisons, and a model that gets them wrong once has cost real money.
 */

import { ask, approxTokens, spendTokens, LlmUnavailable } from '../llm.js';
import { db, newId } from './db.js';
import type { Analysis } from './analyst.js';
import type { DeskEnv, TokenDossier } from './types.js';

export interface ThesisResult {
  id: string;
  body: string;
  source: 'deterministic' | 'llm' | 'llm_failed';
  model: string | null;
}

/**
 * The deterministic thesis: always available, never wrong about the numbers.
 *
 * This is the baseline. It is what gets stored if the model is unavailable, over
 * budget, slow, or returns something that does not mention the score.
 */
export function deterministicThesis(
  d: TokenDossier,
  a: Analysis,
): string {
  const m = d.market;
  const top = Object.entries(a.subscores)
    .sort((x, y) => y[1].contribution - x[1].contribution)
    .slice(0, 2)
    .map(([k, v]) => `${k} ${v.score.toFixed(0)}/${v.weight}`)
    .join(', ');
  const weak = Object.entries(a.subscores)
    .sort((x, y) => x[1].score - y[1].score)
    .slice(0, 1)
    .map(([k, v]) => `${k} ${v.score.toFixed(0)}`)
    .join('');

  return [
    `${m.symbol || m.mint.slice(0, 8)} scores ${a.total}/100 — ${a.passed ? 'passes' : 'refused'}.`,
    `Strongest: ${top}. Weakest: ${weak}.`,
    `Market: ${m.dexId} pair, $${(m.mcapUsd / 1e6).toFixed(2)}M cap, $${(m.liqUsd / 1e3).toFixed(0)}k liq, $${(m.vol1hUsd / 1e3).toFixed(0)}k 1h volume.`,
    `Holders ${d.holders.holders ?? 'unknown'}, top-10 ex-pool ${d.holders.top10ExcludedPct?.toFixed(1) ?? 'unknown'}%.`,
  ].join(' ');
}

const SYSTEM_PROMPT = `You write one short paragraph explaining why a Solana memecoin trading desk scored a token the way it did.

Rules you must follow:
- You are EXPLAINING a decision that is already made. Do not propose a different score, a different size, or a different decision.
- Use only the numbers given. Never invent a metric, a price, or a fact.
- Be concrete: name the two strongest components and the weakest one.
- Maximum 110 words. No preamble, no markdown, no headings.
- If the desk refused the token, say plainly which component failed its floor.`;

/**
 * Ask the model for prose. Returns the deterministic thesis on any failure.
 *
 * Every failure mode is caught and recorded: no provider configured, budget
 * spent, HTTP error, timeout, or a response that is empty or absurdly long.
 * "llm_failed" in desk_theses is not an error the operator has to act on — it is
 * a record that the prose is the deterministic one.
 */
export async function writeThesis(
  env: DeskEnv,
  d: TokenDossier,
  a: Analysis,
  opts: { now?: number; signal?: AbortSignal } = {},
): Promise<ThesisResult> {
  const now = opts.now ?? Date.now();
  const fallback = deterministicThesis(d, a);

  const payload = {
    symbol: d.market.symbol,
    score: a.total,
    passed: a.passed,
    floor_failed: a.floorFailed,
    subscores: Object.fromEntries(
      Object.entries(a.subscores).map(([k, v]) => [k, { score: v.score, floor: v.floor, weight: v.weight, note: v.raw }]),
    ),
    market: {
      mcap_usd: Math.round(d.market.mcapUsd),
      liq_usd: Math.round(d.market.liqUsd),
      vol_1h_usd: Math.round(d.market.vol1hUsd),
      change_1h_pct: d.market.change1hPct,
      change_6h_pct: d.market.change6hPct,
    },
    holders: {
      count: d.holders.holders,
      top10_ex_pool_pct: d.holders.top10ExcludedPct,
      unique_buyer_growth_pct: d.holders.uniqueBuyerGrowthPct,
      smart_wallet_pct: d.holders.smartWalletPct,
    },
    safety: {
      mint_authority_revoked: d.safety.mintAuthorityRevoked,
      freeze_authority_revoked: d.safety.freezeAuthorityRevoked,
      token_program: d.safety.tokenProgram,
      extensions: d.safety.extensions,
    },
  };

  const userPrompt = `Token: ${JSON.stringify(payload, null, 0)}\n\nExplain this score in one paragraph.`;

  let body = fallback;
  let source: ThesisResult['source'] = 'deterministic';
  let model: string | null = null;

  // Rough pre-check so an over-budget day does not even attempt the call.
  const estimated = approxTokens(SYSTEM_PROMPT) + approxTokens(userPrompt) + 400;

  try {
    const r = await ask(
      env as never,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 320, temperature: 0.2 },
    );

    const text = (r.text ?? '').trim();
    // Reject empty or runaway output rather than storing it. A 5,000-character
    // "thesis" is a model failure, not a thesis.
    if (text.length >= 40 && text.length <= 1400) {
      body = text;
      source = 'llm';
      model = r.model ?? null;
      await spendTokens(env as never, (r.tokensIn ?? 0) + (r.tokensOut ?? 0) || estimated).catch(() => undefined);
    } else {
      source = 'llm_failed';
      model = r.model ?? null;
    }
  } catch (e) {
    // LlmUnavailable is the expected path on a fresh deploy with no keys.
    source = e instanceof LlmUnavailable ? 'deterministic' : 'llm_failed';
  }

  const id = newId('thesis');
  await db(env).run(
    'INSERT INTO desk_theses (id, mint, ts, source, body, model) VALUES (?,?,?,?,?,?)',
    id,
    d.market.mint,
    Math.floor(now / 1000),
    source,
    body,
    model,
  );

  return { id, body, source, model };
}

/** Newest thesis for a mint, for /thesis <mint>. */
export async function latestThesis(
  env: DeskEnv,
  mint: string,
): Promise<{ body: string; source: string; ts: number; model: string | null } | null> {
  const row = await db(env).first<{ body: string; source: string; ts: number; model: string | null }>(
    'SELECT body, source, ts, model FROM desk_theses WHERE mint=? ORDER BY ts DESC LIMIT 1',
    mint,
  );
  return row ?? null;
}
