/**
 * The Mini App's work layer: the ONE place it reaches existing bot machinery.
 *
 * Everything here is either
 *   (a) an unchanged call into an exported function of the existing system
 *       (`compileWithEnrichment`, `renderBrief`, `approveAndDispatch`,
 *       `ledgerAppend`), or
 *   (b) a four-line mirror of a private helper in index.ts.
 *
 * Nothing in this file re-implements the suggestion engine. The "the bot proposes
 * the hunt, you say yes" behaviour - the third of the three ways into intake.ts -
 * is produced by calling the SAME `compileWithEnrichment` the Telegram webhook
 * calls, with the same context and the same answers rule. `ui-parity.test.mjs`
 * drives the real `/tg` path and this path against one database and diffs the
 * resulting briefs byte for byte, so the claim is tested rather than asserted.
 *
 * The two mirrors (`ensureProgram`, `authorizationFor`) exist because index.ts's
 * `ensureSelfProgram` / `authorizationFor` are module-private, and this change is
 * not allowed to add an export to index.ts. Both are pure D1 reads/writes with no
 * branching logic worth diverging, and the parity test covers them too: it asserts
 * both paths create the same `programs` row and the same `approvals` row.
 */

import { approveAndDispatch, type ApproveOutcome } from '../dispatch.js';
import { renderBrief, type Brief, type Question } from '../intake.js';
import { compileWithEnrichment, describeEnrichment } from '../intake-enrich.js';
import { append as ledgerAppend } from '../ledger.js';
import type { Cls } from '../playbooks.js';
import { send } from '../telegram.js';
import { d1Db, dispatchEnv, type UiEnv } from './env.js';

/** Optional steering, matching the `hints` parameter `startHunt` accepts. */
export interface EngagementHints {
  cls?: Cls;
  playbook?: string;
}

/** The compact enrichment record the UI shows, so "the model ran" is auditable. */
export interface EnrichmentSummary {
  enriched: boolean;
  skipped: string | null;
  provider: string | null;
  tokens: number;
  latencyMs: number;
}

export type EngagementResult =
  | {
      kind: 'unauthorized';
      programId: string;
      /** Exactly the text the Telegram path shows in this situation. */
      message: string;
    }
  | {
      kind: 'questions';
      programId: string;
      authorizationRef: string;
      questions: Question[];
    }
  | {
      kind: 'brief';
      programId: string;
      authorizationRef: string;
      brief: Brief;
      approvalId: string;
      /** `renderBrief()` output, unchanged - the same card Telegram would show. */
      rendered: string;
      enrichment: EnrichmentSummary;
    };

/**
 * MIRROR of index.ts `ensureSelfProgram`. Resolve the program row a hunt hangs
 * off, creating a self-scoped one on first use.
 *
 * The only difference is the argument: the caller may pass the operator's
 * answered target appended to the raw text, so a target supplied as a follow-up
 * answer still resolves. It cannot change behaviour for any input the Telegram
 * path resolves, because the regex takes the FIRST host in the string and the
 * raw text is still first.
 */
export async function ensureProgram(env: UiEnv, raw: string): Promise<string> {
  const m = raw.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/i);
  const host = m?.[0]?.toLowerCase() ?? 'unscoped';
  await env.DB.prepare(
    `INSERT INTO programs (id,name,platform,homepage,status,discovered_at)
     VALUES (?,?,?,?,'new',?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(host, host, 'self', `https://${host}`, Math.floor(Date.now() / 1000))
    .run();
  return host;
}

/**
 * MIRROR of index.ts `authorizationFor`, WITH ITS DEFECT FIXED.
 *
 * The pre-existing helper in index.ts builds `... WHERE id=?` and never calls
 * `.bind(programId)` - the parameter is declared and unused. The consequence is
 * that no authorization anchor can ever be resolved: depending on the driver the
 * query either raises a binding error or matches nothing, and either way the
 * function returns null, so `startHunt` answers "NO AUTHORIZATION ON FILE" for
 * every target. It is pinned as an observed defect in `ui-parity.test.mjs`, and
 * it is NOT fixed here because index.ts may only receive the router branch this
 * change is permitted to add.
 *
 * This copy binds the parameter, because a Mini App whose every submission ends
 * in a refusal would be a second, useless implementation of the same dead end.
 * The divergence is therefore deliberate, documented, and asserted: the parity
 * test drives both entry points against identical seeds and shows the UI reaches
 * the compiler while the shipped webhook cannot.
 */
export async function authorizationFor(env: UiEnv, programId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT automation, policy_url, policy_text FROM programs WHERE id=?',
  )
    .bind(programId)
    .first<{ automation: string; policy_url: string | null; policy_text: string | null }>();
  if (!row) return null;
  if (row.automation === 'prohibited') return null;
  if (row.automation === 'allowed' && row.policy_url) {
    return `${row.policy_url} permits automated testing`;
  }
  // not_mentioned still needs an explicit anchor; use the policy URL if present.
  if (row.policy_url) return `${row.policy_url} (no prohibition on automated testing)`;
  return null;
}

/**
 * Compile free text into an engagement. This is the UI's chat path and it is the
 * existing intake+llm path - same function, same context object, same rule that
 * operator answers make the deterministic compile authoritative.
 */
export async function compileEngagement(
  env: UiEnv,
  raw: string,
  hints: EngagementHints = {},
  answers: Partial<Record<string, string>> = {},
): Promise<EngagementResult> {
  const programId = await ensureProgram(
    env,
    answers['target'] ? `${raw} ${answers['target']}` : raw,
  );
  const authRef = await authorizationFor(env, programId);

  if (!authRef) {
    return {
      kind: 'unauthorized',
      programId,
      message:
        'NO AUTHORIZATION ON FILE - this Worker will not touch a target whose ' +
        'program policy is not recorded. Two ways forward: seed the host so ' +
        'discovery can parse its policy, or record the exact policy sentence ' +
        'that authorizes testing.',
    };
  }

  const compiled = await compileWithEnrichment(
    env,
    raw,
    { program_id: programId, authorization_ref: authRef, scope_hints: [] },
    hints.playbook || hints.cls ? { class: hints.cls } : answers,
  );
  const result = compiled.result;

  // Same audit line the Telegram path writes, and equally non-fatal: a ledger
  // write failure must not lose the operator's brief.
  try {
    await ledgerAppend(env, 'intake.compiled', { outcome: describeEnrichment(compiled) });
  } catch {
    /* the brief still ships; the audit line is best-effort, like llm_log */
  }

  if ('questions' in result) {
    return { kind: 'questions', programId, authorizationRef: authRef, questions: result.questions };
  }

  const brief = hints.playbook
    ? { ...result.brief, playbooks: [hints.playbook] }
    : result.brief;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO approvals (id, fingerprint, action, reason, status, requested_at)
     VALUES (?,?,?,?, 'pending', ?)`,
  )
    .bind(
      id,
      id.slice(0, 16),
      JSON.stringify({ kind: 'engagement', brief }),
      `new engagement: ${brief.title}`,
      Math.floor(Date.now() / 1000),
    )
    .run();

  return {
    kind: 'brief',
    programId,
    authorizationRef: authRef,
    brief,
    approvalId: id,
    rendered: renderBrief(brief),
    enrichment: {
      enriched: compiled.enriched,
      skipped: compiled.skipped,
      provider: compiled.provider,
      tokens: compiled.tokens,
      latencyMs: compiled.latencyMs,
    },
  };
}

/** One row of the work queue, as the shell renders it. */
export interface WorkItem {
  id: string;
  status: string;
  reason: string;
  requested_at: number;
  decided_at: number | null;
  operator: string | null;
  kind: string;
  title: string | null;
  cls: string | null;
  targets: string[];
  playbooks: string[];
  mutability: string | null;
  time_box_minutes: number | null;
}

export interface WorkView {
  pending: WorkItem[];
  decided: WorkItem[];
  counts: { pending: number; approved: number; denied: number; expired: number };
  programs: { total: number; huntable: number; parsed: number };
}

/**
 * The work queue: real `approvals` rows, most recent first.
 *
 * A malformed `action` blob must not blank the screen - the row is still shown,
 * with its parsed fields empty, because "there is an approval here I cannot read"
 * is information the operator needs, not a reason to render nothing.
 */
export async function listWork(env: UiEnv, limit = 50): Promise<WorkView> {
  const rows = await env.DB.prepare(
    `SELECT id, action, reason, status, requested_at, decided_at, operator
     FROM approvals ORDER BY requested_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      action: string;
      reason: string;
      status: string;
      requested_at: number;
      decided_at: number | null;
      operator: string | null;
    }>();

  const items: WorkItem[] = (rows.results ?? []).map((r) => {
    let parsed: { kind?: unknown; brief?: Partial<Brief> } = {};
    try {
      parsed = JSON.parse(r.action) as { kind?: unknown; brief?: Partial<Brief> };
    } catch {
      parsed = {};
    }
    const b = parsed.brief ?? {};
    return {
      id: r.id,
      status: r.status,
      reason: r.reason,
      requested_at: r.requested_at,
      decided_at: r.decided_at,
      operator: r.operator,
      kind: typeof parsed.kind === 'string' ? parsed.kind : 'unknown',
      title: typeof b.title === 'string' ? b.title : null,
      cls: typeof b.cls === 'string' ? b.cls : null,
      targets: Array.isArray(b.targets) ? b.targets.filter((t) => typeof t === 'string') : [],
      playbooks: Array.isArray(b.playbooks) ? b.playbooks.filter((p) => typeof p === 'string') : [],
      mutability: typeof b.max_mutability === 'string' ? b.max_mutability : null,
      time_box_minutes: typeof b.time_box_minutes === 'number' ? b.time_box_minutes : null,
    };
  });

  const counts = { pending: 0, approved: 0, denied: 0, expired: 0 };
  for (const it of items) {
    if (it.status === 'pending') counts.pending++;
    else if (it.status === 'approved') counts.approved++;
    else if (it.status === 'denied') counts.denied++;
    else if (it.status === 'expired') counts.expired++;
  }

  const one = async <T>(sql: string) =>
    (await env.DB.prepare(sql).first<T>()) ?? ({} as T);
  const total = await one<{ n: number }>('SELECT COUNT(*) AS n FROM programs');
  const huntable = await one<{ n: number }>('SELECT COUNT(*) AS n FROM programs WHERE automation=\'allowed\'');
  const parsed = await one<{ n: number }>("SELECT COUNT(*) AS n FROM programs WHERE status='parsed'");

  return {
    pending: items.filter((i) => i.status === 'pending'),
    decided: items.filter((i) => i.status !== 'pending'),
    counts,
    programs: { total: total.n ?? 0, huntable: huntable.n ?? 0, parsed: parsed.n ?? 0 },
  };
}

export interface DecisionResult {
  outcome: ApproveOutcome;
  /** Every message the Telegram path would have pushed, verbatim, in order. */
  messages: string[];
  /** True when those messages were also delivered to the configured chat. */
  announced: boolean;
}

/**
 * Approve or deny an engagement - through the SAME `approveAndDispatch` the
 * Telegram `ok:` / `no:` buttons use, so the gate ordering (gate -> derive -> env
 * check -> hunts row -> dispatch) is not re-implemented and cannot drift.
 *
 * `notify` is intercepted rather than replaced: the texts are returned to the
 * browser so the Mini App shows exactly what the chat would have said, AND are
 * best-effort forwarded to Telegram when a chat is configured. A delivery failure
 * never fails the decision - the decision is already committed by then.
 */
export async function decideWork(
  env: UiEnv,
  approvalId: string,
  approve: boolean,
  operator: string,
): Promise<DecisionResult> {
  const messages: string[] = [];
  const outcome = await approveAndDispatch(approvalId, approve, {
    db: d1Db(env),
    env: dispatchEnv(env),
    fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
    ledger: async (kind, payload) => {
      await ledgerAppend(env, kind, payload);
    },
    notify: async (text) => {
      messages.push(text);
    },
    operator,
  });

  let announced = false;
  if (env.TELEGRAM_CHAT_ID && messages.length) {
    try {
      await send(env, messages.join('\n\n'), undefined, env.TELEGRAM_CHAT_ID);
      announced = true;
    } catch {
      /* the chat is a courtesy copy; the UI already has the text */
    }
  }

  return { outcome, messages, announced };
}
