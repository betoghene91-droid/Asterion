/**
 * Dispatch — the seam between "the operator approved" and "compute runs".
 *
 * Before this module existed the chain was severed here: the Telegram `ok:`
 * callback flipped a row to `approved`, no compute was ever asked to run, and
 * the `/hook/proof` callback that finishes a hunt could never fire because no
 * hunt had been started. Everything downstream was built and unreachable.
 *
 * Four rules shape this file:
 *
 *   1. The gate runs first, on every approval. A brief that PolicyEngine will
 *      not allow never becomes a dispatch. The GATE is told which axis to check
 *      by the plane (see `planes.ts:scopeTargetFor`): a web2 brief's URL target
 *      is not a repo clone, and telling the engine otherwise let an unscoped
 *      host pass as "a repo target is a read-only clone".
 *
 *   2. The plane decides the workflow and the body. `WORKFLOW_FILE` used to be a
 *      single constant and `PROVABLE_CLASS` a single string, which is why three
 *      of the four planes in this tree were unreachable. Routing, the per-class
 *      input contract and the per-class refusals now live in `planes.ts`, and
 *      this file posts whatever body the plane built — no union, because GitHub
 *      answers an undeclared `workflow_dispatch` input with 422.
 *
 *   3. Derive, never guess. Every input each plane needs is read out of fields
 *      the Brief actually carries (`targets`, `notes`, `cls`). When one cannot
 *      be derived we say exactly which one and why. A fabricated commit SHA
 *      would produce a proof run against code nobody pinned, which is worse
 *      than no run at all.
 *
 *   4. Fail loud. Every refusal and every non-2xx from the GitHub API is
 *      surfaced with its status and body. A hunt is never described as running
 *      when no dispatch occurred, and a `hunts` row only exists once a dispatch
 *      is genuinely being attempted.
 */

import { PolicyEngine, roeFromBrief, type Decision } from './policy.js';
import { esc } from './telegram.js';
import type { Brief } from './intake.js';
import { DEFAULT_FORK_RPC_ENV, describeChain } from './chains.js';
import {
  METHODOLOGY_INPUT,
  describeMethodology,
  methodologyForBrief,
} from './methodology-dispatch.js';
import {
  PLANES,
  PROVABLE_CLASSES,
  deriveForBrief,
  noHarnessReason,
  noPlaneReason,
  planeNameFor,
  scopeTargetFor,
  workflowFileFor,
  type Derivation,
} from './planes.js';

// ─── the plane contract, re-exported so callers have one import ───────────────
//
// These used to be defined HERE as `WORKFLOW_FILE = 'prove.yml'` and
// `PROVABLE_CLASS = 'solidity'`. Both were the bug: a single constant cannot
// describe four planes, and a single class string reads as "there is one class
// in the world". The registry in `planes.ts` is the source of truth now, and
// these re-exports exist so every existing caller keeps one import site without
// keeping a second, divergent copy of the routing table.

export { PROVABLE_CLASSES, planeNameFor, noPlaneReason, noHarnessReason, workflowFileFor };

/**
 * Technique recorded on the gate decision. Distinct from any live-target
 * technique so a dispatch is auditable as its own class of action.
 */
export const PROOF_TECHNIQUE = 'ASTERION-PROVE';

/** Stage a hunt sits in from "dispatched" until the verdict callback lands. */
export const STAGE_DISPATCHED = 'prime';
export const STAGE_DISPATCH_FAILED = 'failed';

// ─── derivation ──────────────────────────────────────────────────────────────

/**
 * The EVM plane's body, kept as a named type for its callers (and its tests).
 *
 * This is ONE plane's contract, not the dispatch contract: prove-web and
 * prove-infra declare `target`/`domain` and no repo at all. `dispatchWorkflow`
 * therefore takes `Record<string, string>` and this type is only what
 * prove.yml's builder produces.
 */
export interface ProveInputs {
  repo: string;
  commit: string;
  contract: string;
  fork_block: string;
  /** EVM chain the fork must be taken from, as `cast chain-id` would report it. */
  chain_id?: string;
  /** Deployed instance the PoC attaches to, as a 20-byte hex address. */
  address?: string;
  hunt_id: string;
  /**
   * The methodology block that governed this hunt, carried for auditability.
   * Requires a matching input declaration in the workflow — every plane's
   * workflow declares it, and a test walks the YAML to prove that.
   */
  methodology?: string;
}

/**
 * Build the dispatch body for a brief, whatever its class.
 *
 * `huntId` is REQUIRED and may not be empty. `/hook/proof` upserts on it, and
 * ingest refuses a `proven` verdict that resolves to no `hunts` row — so a
 * dispatch without one is a run whose verdict is discarded. Making the argument
 * required is the smallest change that makes that unrepresentable.
 *
 * A class with no plane refuses with `missing: ['cls']` and the plane named;
 * a class WITH a plane but no harness for the named playbook refuses with
 * `missing: ['playbook']`. Different refusals, because they send the operator
 * to different places.
 */
export function deriveProveInputs(brief: Brief, huntId: string): Derivation {
  return deriveForBrief(brief, huntId);
}

// ─── the gate ─────────────────────────────────────────────────────────────────

/**
 * Ask PolicyEngine whether this brief may spawn proof compute.
 *
 * This is the same engine every other adapter goes through — the dispatch path
 * does not get a private shortcut. The plane supplies the target and the axis to
 * check it on, so a web2 URL is authorised as a URL and a domain as a domain.
 * A read-only brief's ceiling will refuse `simulate`, and the refusal is the
 * product working correctly rather than a bug to route around.
 */
export async function authorizeProof(
  brief: Brief,
  fallbackTarget: string,
  now = Date.now() / 1000,
): Promise<Decision> {
  const roe = roeFromBrief(brief, now);
  const engine = new PolicyEngine(roe, () => now);
  const scope = scopeTargetFor(brief, fallbackTarget);
  return engine.authorize({
    technique: PROOF_TECHNIQUE,
    target: scope.target,
    target_kind: scope.target_kind,
    mutability: 'simulate',
    adapter: scope.adapter,
    is_fork: true,
    // The chain the fork must be taken from, when the brief pinned one. Passed
    // through so the decision fingerprint covers it: two runs of the same repo
    // on different chains are different actions, and a fingerprint that ignored
    // the chain would let one approval cover both.
    chain_id: brief.chain_id ?? null,
  });
}

/**
 * One line describing the chain a run is pinned to, for the operator message.
 *
 * Never empty and never throws: a blank line there is exactly the "which chain
 * did this run on?" blindness this work exists to remove. A non-EVM plane has no
 * chain, and says so rather than printing a fork RPC it never used.
 */
function chainLine(cls: string, chainId: string | undefined): string {
  const plane = PLANES.get(cls as never);
  if (plane && plane.workflow !== 'prove.yml') return `not applicable (${plane.plane} plane)`;
  if (!chainId) return `unpinned - ${DEFAULT_FORK_RPC_ENV} (no chain_id in the brief)`;
  const id = Number(chainId);
  return Number.isInteger(id) ? describeChain(id) : `${chainId} (unparseable chain_id)`;
}

// ─── the GitHub call ─────────────────────────────────────────────────────────

export interface DispatchResult {
  ok: boolean;
  /** HTTP status, or null when the request never got a response. */
  status: number | null;
  /** Response body, bounded. Empty string for 204. */
  body: string;
  /** Set when the request itself failed (DNS, TLS, timeout). */
  error: string | null;
}

const DISPATCH_TIMEOUT_MS = 15_000;
const BODY_CAP = 1200;

/**
 * POST a workflow_dispatch to ONE plane's workflow.
 *
 * `workflow` is the plane's own file, and `inputs` is the body that plane's
 * builder produced. Nothing here filters or renames a key: GitHub answers a
 * dispatch carrying an input the workflow does not declare with 422, so a
 * dispatcher that "helpfully" added a repo to a web2 body would turn every web2
 * dispatch into a hard failure. The test that compares each builder's keys with
 * each workflow's declaration is the guard.
 *
 * Never throws: a network failure and a 422 are both reported, because "it did
 * not run" must be distinguishable from "it ran".
 */
export async function dispatchWorkflow(
  args: {
    token: string;
    /** owner/name of the repo CONTAINING the workflow (not the target repo). */
    githubRepo: string;
    ref: string;
    /** Workflow file inside that repo, e.g. 'prove-web.yml'. */
    workflow: string;
    inputs: Record<string, string>;
  },
  deps: { fetch: typeof fetch },
): Promise<DispatchResult> {
  const url = `https://api.github.com/repos/${args.githubRepo}/actions/workflows/${args.workflow}/dispatches`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'asterion-worker',
      },
      body: JSON.stringify({ ref: args.ref, inputs: args.inputs }),
      signal: ctl.signal,
    });

    // GitHub answers a successful workflow_dispatch with 204 and no body.
    const text = await res.text().catch(() => '');
    return {
      ok: res.status === 204 || (res.status >= 200 && res.status < 300),
      status: res.status,
      body: text.slice(0, BODY_CAP),
      error: null,
    };
  } catch (e) {
    return { ok: false, status: null, body: '', error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ─── orchestration ───────────────────────────────────────────────────────────

/** The two environment variables the dispatch needs, and nothing else. */
export interface DispatchEnv {
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_REF?: string;
}

/** Minimal D1 surface, so the whole flow is testable against real SQLite. */
export interface DispatchDb {
  first<T>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<void>;
}

export interface ApproveDeps {
  db: DispatchDb;
  env: DispatchEnv;
  fetch: typeof fetch;
  /** Ledger writer; injected so tests can assert on chained entries. */
  ledger: (kind: string, payload: unknown) => Promise<void>;
  notify: (text: string) => Promise<void>;
  operator: string;
  now?: () => number;
  uuid?: () => string;
}

export type ApproveOutcome =
  | { dispatched: true; huntId: string; status: number; workflow: string }
  | { dispatched: false; reason: string; missing?: string[]; workflow?: string };

/**
 * What the `hunts` row records for a plane that has no repo, commit or contract.
 *
 * The columns are the EVM plane's vocabulary. Rather than inventing a contract
 * for a web2 brief — which would put a false value in the table the queue and
 * the report writer read — a non-EVM plane records the thing it actually
 * tested, and leaves `contract` NULL. The full input body is on the ledger in
 * `dispatch.sent`, so nothing is lost, and nothing is mislabelled.
 */
function huntProvenance(inputs: Record<string, string>): {
  repo: string | null;
  commit: string | null;
  contract: string | null;
  forkBlock: number;
} {
  return {
    repo: inputs.repo ?? inputs.target ?? inputs.domain ?? null,
    commit: inputs.commit ?? null,
    contract: inputs.contract ?? null,
    forkBlock: Number(inputs.fork_block) || 0,
  };
}

/**
 * Approve (or deny) an engagement approval and, for an approved brief that
 * passes the gate and has derivable provenance, actually start the hunt.
 *
 * Ordering that matters:
 *   gate -> derive -> env check -> INSERT hunts -> dispatch
 * The hunts row is written BEFORE the POST so the `/hook/proof` callback always
 * has a row to upsert into. It is NOT written before the gate or the env check
 * — a hunt row that no compute was ever asked to run would be a lie in the
 * database, which is exactly the class of bug this work is fixing.
 *
 * The hunt id is minted BEFORE derivation, not after, because `hunt_id` is a
 * mandatory input on every plane: deriving without one would produce a body
 * that /hook/proof must discard. Minting a uuid writes nothing, so this
 * reordering keeps the "no row before the gate" guarantee intact.
 */
export async function approveAndDispatch(
  approvalId: string,
  approve: boolean,
  deps: ApproveDeps,
): Promise<ApproveOutcome> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const uuid = deps.uuid ?? (() => crypto.randomUUID());

  const row = await deps.db.first<{ id: string; action: string; reason: string; status: string }>(
    'SELECT id, action, reason, status FROM approvals WHERE id=?',
    approvalId,
  );
  if (!row) {
    await deps.notify(`unknown approval <code>${esc(approvalId)}</code>`);
    return { dispatched: false, reason: 'unknown_approval' };
  }

  // Idempotent: a second tap on a stale keyboard must not start a second hunt.
  if (row.status !== 'pending') {
    await deps.notify(
      `approval <code>${esc(approvalId)}</code> is already <b>${esc(row.status)}</b>; nothing sent`,
    );
    return { dispatched: false, reason: 'already_decided' };
  }

  const status = approve ? 'approved' : 'denied';
  await deps.db.run(
    'UPDATE approvals SET status=?, decided_at=?, operator=? WHERE id=?',
    status,
    now(),
    deps.operator,
    approvalId,
  );

  let parsed: { kind?: string; brief?: Brief };
  try {
    parsed = JSON.parse(row.action) as { kind?: string; brief?: Brief };
  } catch {
    await deps.notify(`approval <code>${esc(approvalId)}</code> has unreadable action JSON`);
    return { dispatched: false, reason: 'bad_action' };
  }
  await deps.ledger(`approval.${status}`, { id: approvalId, action: parsed });

  if (!approve) {
    await deps.notify(`\u2717 denied <code>${esc(approvalId)}</code>`);
    return { dispatched: false, reason: 'denied' };
  }

  const brief = parsed.brief;
  if (parsed.kind !== 'engagement' || !brief) {
    await deps.notify(
      `\u2713 approved <code>${esc(approvalId)}</code> \u2014 not an engagement brief, so nothing to dispatch`,
    );
    return { dispatched: false, reason: 'not_an_engagement' };
  }

  const plane = PLANES.get(brief.cls);

  // 1. Gate. Only a brief the policy engine allows may reach compute.
  //
  // The fallback target is used only when the plane could not name one (a
  // brief whose targets are all the wrong shape). It is a repo-shaped value for
  // a repo plane and the program id otherwise, so the engine is never handed an
  // empty string it would have to guess about.
  const fallback =
    brief.program_id && plane && plane.workflow !== 'prove.yml'
      ? brief.program_id
      : (brief.targets?.[0] ?? brief.program_id);

  let decision: Decision;
  try {
    decision = await authorizeProof(brief, fallback, now());
  } catch (e) {
    const msg = (e as Error).message;
    await deps.ledger('dispatch.blocked', { approval: approvalId, gate: 'threw', error: msg });
    await deps.notify(
      [
        `\u2717 <b>GATE REFUSED</b>  <code>${esc(approvalId)}</code>`,
        `policy engine rejected this brief: ${esc(msg)}`,
        '',
        '<i>Nothing was dispatched and no hunt row was created.</i>',
      ].join('\n'),
    );
    return { dispatched: false, reason: 'gate_threw' };
  }

  if (decision.verdict !== 'allow') {
    await deps.ledger('dispatch.blocked', {
      approval: approvalId,
      gate: decision.verdict,
      reason: decision.reason,
      fingerprint: decision.fingerprint,
    });
    await deps.notify(
      [
        `\u2717 <b>GATE REFUSED</b>  <code>${esc(approvalId)}</code>`,
        `verdict   <b>${esc(decision.verdict)}</b>`,
        `reason    ${esc(decision.reason)}`,
        '',
        '<i>Nothing was dispatched and no hunt row was created.</i>',
      ].join('\n'),
    );
    return { dispatched: false, reason: `gate_${decision.verdict}` };
  }

  // 2. Derive. Never guess a value a workflow will act on. The hunt id comes
  //    first because it is a mandatory input on every plane.
  const huntId = uuid();
  const derivation = deriveProveInputs(brief, huntId);
  if (!derivation.ok || !derivation.inputs || !derivation.workflow) {
    await deps.ledger('dispatch.blocked', {
      approval: approvalId,
      gate: 'allow',
      plane: derivation.plane,
      workflow: derivation.workflow,
      missing: derivation.missing,
      why: derivation.why,
    });

    // Three distinct headlines, because they mean three different things to
    // the operator: this class has no plane at all; this plane cannot run this
    // playbook yet; or a required input could not be read out of the brief.
    const onlyClass = derivation.missing.length === 1 && derivation.missing[0] === 'cls';
    const noHarness = derivation.missing.length === 1 && derivation.missing[0] === 'playbook';
    const headline = onlyClass
      ? `<b>no proof plane for this class</b>  <code>${esc(brief.cls)}</code>`
      : noHarness
        ? `<b>no harness for this playbook</b>  <code>${esc((brief.playbooks ?? []).join('</code>, <code>'))}</code>`
        : `<b>cannot build ${esc(derivation.workflow ?? 'workflow')} inputs</b>  missing: <code>${derivation.missing.join('</code>, <code>')}</code>`;

    await deps.notify(
      [
        `\u2713 approved <code>${esc(approvalId)}</code> \u2014 <b>NOT DISPATCHED</b>`,
        `gate      allow (${esc(decision.reason)})`,
        `plane     ${esc(derivation.plane)}`,
        '',
        headline,
        '',
        ...derivation.why.map((w) => `\u00b7 ${esc(w)}`),
        '',
        derivation.partial.repo ? `derived repo <code>${esc(derivation.partial.repo)}</code>` : '',
        '<i>No hunt row was created and no workflow was asked to run.</i>',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
    return {
      dispatched: false,
      reason: onlyClass
        ? 'not_provable_class'
        : noHarness
          ? 'no_harness_for_playbook'
          : 'underivable_inputs',
      missing: derivation.missing,
      workflow: derivation.workflow ?? undefined,
    };
  }

  // 3. Environment. Name the exact missing variable, never a generic failure.
  const missingVars: string[] = [];
  if (!deps.env.GITHUB_DISPATCH_TOKEN) missingVars.push('GITHUB_DISPATCH_TOKEN');
  if (!deps.env.GITHUB_REPO) missingVars.push('GITHUB_REPO');
  if (missingVars.length) {
    await deps.ledger('dispatch.blocked', { approval: approvalId, missing_env: missingVars });
    await deps.notify(
      [
        `\u2713 approved <code>${esc(approvalId)}</code> \u2014 <b>NOT DISPATCHED</b>`,
        `gate      allow (${esc(decision.reason)})`,
        `plane     ${esc(derivation.plane)}`,
        `inputs    derivable (${derivation.missing.length ? 'partial' : 'complete'})`,
        '',
        `<b>missing configuration</b>  <code>${missingVars.join('</code>, <code>')}</code>`,
        '',
        'Set the missing Worker secret and tap Authorize again:',
        '  <code>wrangler secret put GITHUB_DISPATCH_TOKEN</code>',
        `  <code>GITHUB_REPO</code> = owner/name of the repo holding <code>${esc(derivation.workflow)}</code>`,
        '',
        '<i>A fine-grained token with Actions:write on that repo is enough. Nothing was dispatched.</i>',
      ].join('\n'),
    );
    return { dispatched: false, reason: 'missing_env', missing: missingVars };
  }

  const inputs = derivation.inputs;
  const workflow = derivation.workflow;
  const ref = deps.env.GITHUB_REF ?? 'main';
  const ts = now();

  // 3b. Methodology. Resolved from the brief, gated on the brief's own targets.
  //
  // This runs AFTER the gate and AFTER derivation, so a refusal here can never
  // be the reason a hunt that policy allowed does not run: `methodologyForBrief`
  // is total and returns an empty block instead of throwing. It is recorded on
  // the ledger either way, so "the run had no methodology" and "the run had
  // $pack" are both auditable claims rather than an absence.
  const methodology = methodologyForBrief(brief);
  const body: Record<string, string> = {
    ...inputs,
    ...(methodology.block ? { [METHODOLOGY_INPUT]: methodology.block } : {}),
  };

  // 4. The hunt row, before the POST: /hook/proof upserts on this id.
  const prov = huntProvenance(inputs);
  await deps.db.run(
    `INSERT INTO hunts (id, program_id, repo, commit_sha, contract, fork_block, stage, leads_n, attempts_n, proven_n, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,0,0,?,?)
     ON CONFLICT(id) DO UPDATE SET
       repo=excluded.repo, commit_sha=excluded.commit_sha, contract=excluded.contract,
       fork_block=excluded.fork_block, stage=excluded.stage, updated_at=excluded.updated_at`,
    huntId,
    brief.program_id ?? null,
    prov.repo,
    prov.commit,
    prov.contract,
    prov.forkBlock,
    STAGE_DISPATCHED,
    ts,
    ts,
  );

  // 5. Dispatch, and tell the truth about what came back.
  const res = await dispatchWorkflow(
    {
      token: deps.env.GITHUB_DISPATCH_TOKEN!,
      githubRepo: deps.env.GITHUB_REPO!,
      ref,
      workflow,
      inputs: body,
    },
    { fetch: deps.fetch },
  );

  if (!res.ok) {
    const detail = res.error
      ? `transport error: ${res.error}`
      : `HTTP ${res.status}${res.body ? `: ${res.body}` : ''}`;
    // The row exists; it says failed. It must never say anything else.
    await deps.db.run(
      'UPDATE hunts SET stage=?, stopped_because=?, updated_at=? WHERE id=?',
      STAGE_DISPATCH_FAILED,
      `dispatch failed: ${detail}`,
      now(),
      huntId,
    );
    await deps.ledger('dispatch.failed', {
      approval: approvalId,
      hunt: huntId,
      plane: derivation.plane,
      workflow,
      status: res.status,
      body: res.body,
      error: res.error,
    });
    await deps.notify(
      [
        `\u26A0 <b>DISPATCH FAILED</b>  <code>${esc(huntId)}</code>`,
        `gate      allow (${esc(decision.reason)})`,
        `plane     ${esc(derivation.plane)}`,
        `workflow  <code>${esc(deps.env.GITHUB_REPO!)}/.github/workflows/${esc(workflow)}</code>`,
        '',
        `<b>${esc(detail)}</b>`,
        '',
        `hunt row marked <code>${STAGE_DISPATCH_FAILED}</code> \u2014 <b>no proof is running</b>.`,
      ].join('\n'),
    );
    return { dispatched: false, reason: 'dispatch_failed', workflow };
  }

  await deps.ledger('dispatch.sent', {
    approval: approvalId,
    hunt: huntId,
    plane: derivation.plane,
    workflow,
    // The whole body, verbatim. For a non-EVM plane this is the only record of
    // what was asked to run, because the hunts row's columns are the EVM
    // plane's vocabulary and are deliberately left NULL rather than filled with
    // a web2 target wearing a `contract` label.
    inputs: body,
    ref,
    gate: decision.reason,
    // Which pack governed the run, or why none did. Recorded separately from
    // the block itself so the ledger stays a readable audit rather than a
    // 4000-char dump repeated per hunt.
    methodology: describeMethodology(methodology),
    methodology_skill: methodology.skill_id,
    methodology_chars: methodology.block.length,
  });

  // Per-plane confirmation lines: a web2 run has no repo, commit or contract,
  // so printing those fields for it would print three blanks and teach the
  // operator that the message is noise.
  const detailLines =
    workflow === 'prove.yml'
      ? [
          `repo      <code>${esc((inputs.repo ?? '').replace(/^https?:\/\//, '').replace(/\.git$/, ''))}</code>`,
          `commit    <code>${esc((inputs.commit ?? '').slice(0, 12))}</code>`,
          `contract  <code>${esc(inputs.contract ?? '')}</code>   fork block ${esc(inputs.fork_block ?? '0')}`,
          `chain     ${esc(chainLine(brief.cls, inputs.chain_id))}`,
        ]
      : workflow === 'prove-solana.yml'
        ? [
            `program   <code>${esc(inputs.program ?? '')}</code>`,
            `program id <code>${esc(inputs.program_id ?? '')}</code>`,
            `ix        <code>${esc(inputs.instruction ?? '')}</code>`,
            `commit    <code>${esc((inputs.commit ?? '').slice(0, 12))}</code>`,
          ]
        : [
            `target    <code>${esc(inputs.target ?? inputs.domain ?? '')}</code>`,
            `playbook  <code>${esc(inputs.playbook ?? '')}</code>`,
            `chain     ${esc(chainLine(brief.cls, undefined))}`,
          ];

  await deps.notify(
    [
      `\u2713 approved <code>${esc(approvalId)}</code> \u2014 <b>DISPATCHED</b>`,
      `gate      allow (${esc(decision.reason)})`,
      `plane     ${esc(derivation.plane)}  <code>${esc(workflow)}</code>`,
      `hunt      <code>${esc(huntId)}</code>   stage <code>${STAGE_DISPATCHED}</code>`,
      ...detailLines,
      `method    ${esc(methodology.skill_id ? `${methodology.skill_id} (${methodology.block.length} chars)` : 'none \u2014 ' + methodology.reason)}`,
      '',
      `GitHub returned ${res.status}. Verdicts arrive at /hook/proof when the run finishes.`,
    ].join('\n'),
  );

  return { dispatched: true, huntId, status: res.status!, workflow };
}
