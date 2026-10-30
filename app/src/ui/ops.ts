/**
 * The observability views: the target inventory and the history.
 *
 * Both are plain reads of tables that already exist, and both are deliberately
 * narrow. There is no write path in this file at all - an operator looking at
 * what the bot has collected must not be one mistyped request away from changing
 * it, which is the same reason `/api/desk*` has no mutating endpoint.
 *
 * Everything is bounded and every column is named. `SELECT *` against `programs`
 * would ship `policy_text` (the full text of a program's rules) into the browser
 * for no benefit, so the shapes here are explicit.
 */

import { listWork, type WorkItem } from './work.js';
import type { UiEnv } from './env.js';

/** One collected target. `programs.id` IS the host, by the repo's own convention. */
export interface TargetRow {
  id: string;
  name: string;
  platform: string;
  homepage: string | null;
  policy_url: string | null;
  /** allowed | not_mentioned | prohibited | unknown - the field every dispatch reads. */
  automation: string;
  reward: string;
  status: string;
  priority: number;
  responsiveness: number | null;
  safe_harbour: number;
  assets: number;
  discovered_at: number;
  last_checked: number | null;
}

export interface TargetsView {
  targets: TargetRow[];
  counts: {
    total: number;
    allowed: number;
    not_mentioned: number;
    prohibited: number;
    unknown: number;
    parsed: number;
    /** Targets with a policy URL on file: these are the ones a hunt can anchor on. */
    with_policy: number;
  };
  assets: number;
}

const MAX_TARGETS = 200;

export async function targetsView(env: UiEnv, limit = MAX_TARGETS): Promise<TargetsView> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.platform, p.homepage, p.policy_url, p.automation, p.reward,
            p.status, p.priority, p.responsiveness, p.safe_harbour,
            p.discovered_at, p.last_checked,
            (SELECT COUNT(*) FROM assets a WHERE a.program_id = p.id) AS assets
     FROM programs p
     ORDER BY p.priority DESC, p.id
     LIMIT ?`,
  )
    .bind(limit)
    .all<TargetRow>();

  const one = async <T>(sql: string) => (await env.DB.prepare(sql).first<T>()) ?? ({} as T);

  const total = await one<{ n: number }>('SELECT COUNT(*) AS n FROM programs');
  const allowed = await one<{ n: number }>("SELECT COUNT(*) AS n FROM programs WHERE automation='allowed'");
  const notMentioned = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM programs WHERE automation='not_mentioned'",
  );
  const prohibited = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM programs WHERE automation='prohibited'",
  );
  const unknown = await one<{ n: number }>("SELECT COUNT(*) AS n FROM programs WHERE automation='unknown'");
  const parsed = await one<{ n: number }>("SELECT COUNT(*) AS n FROM programs WHERE status='parsed'");
  const withPolicy = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM programs WHERE policy_url IS NOT NULL',
  );
  const assets = await one<{ n: number }>('SELECT COUNT(*) AS n FROM assets');

  return {
    targets: rows.results ?? [],
    counts: {
      total: total.n ?? 0,
      allowed: allowed.n ?? 0,
      not_mentioned: notMentioned.n ?? 0,
      prohibited: prohibited.n ?? 0,
      unknown: unknown.n ?? 0,
      parsed: parsed.n ?? 0,
      with_policy: withPolicy.n ?? 0,
    },
    assets: assets.n ?? 0,
  };
}

export interface HuntRow {
  id: string;
  program_id: string | null;
  repo: string | null;
  commit_sha: string | null;
  stage: string;
  leads_n: number;
  attempts_n: number;
  proven_n: number;
  stopped_because: string | null;
  created_at: number;
  updated_at: number;
}

export interface HistoryView {
  /** Reuses the work queue's own row shape, so the two views cannot disagree. */
  decisions: WorkItem[];
  hunts: HuntRow[];
  ledger: { ok: boolean; count: number; kinds: { kind: string; n: number }[] };
  totals: {
    decisions: number;
    approved: number;
    denied: number;
    hunts: number;
    proven: number;
    /** Ledger rows of kind 'dispatch.blocked': refusals that never became a hunt. */
    blocked: number;
  };
}

const MAX_HUNTS = 60;

export async function historyView(env: UiEnv, limit = MAX_HUNTS): Promise<HistoryView> {
  // The decided half of the approvals queue, from the same reader the Work view
  // uses. One query path, one parser, no chance of the two views disagreeing.
  const work = await listWork(env, 200);

  const hunts = await env.DB.prepare(
    `SELECT id, program_id, repo, commit_sha, stage, leads_n, attempts_n, proven_n,
            stopped_because, created_at, updated_at
     FROM hunts
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<HuntRow>();

  const one = async <T>(sql: string) => (await env.DB.prepare(sql).first<T>()) ?? ({} as T);

  const ledgerCount = await one<{ n: number }>('SELECT COUNT(*) AS n FROM ledger');
  const kinds = await env.DB.prepare(
    'SELECT kind, COUNT(*) AS n FROM ledger GROUP BY kind ORDER BY n DESC LIMIT 24',
  ).all<{ kind: string; n: number }>();
  const huntsTotal = await one<{ n: number }>('SELECT COUNT(*) AS n FROM hunts');
  const proven = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM findings WHERE proof_state='proven'",
  );
  const blocked = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM ledger WHERE kind='dispatch.blocked'",
  );

  return {
    decisions: work.decided,
    hunts: hunts.results ?? [],
    ledger: { ok: true, count: ledgerCount.n ?? 0, kinds: kinds.results ?? [] },
    totals: {
      decisions: work.decided.length,
      approved: work.counts.approved,
      denied: work.counts.denied,
      hunts: huntsTotal.n ?? 0,
      proven: proven.n ?? 0,
      blocked: blocked.n ?? 0,
    },
  };
}
