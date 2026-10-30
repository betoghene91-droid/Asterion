/**
 * Dispatch — the seam between "the operator approved" and "compute runs".
 *
 * Before this module existed the chain was severed here: the Telegram `ok:`
 * callback flipped a row to `approved`, no compute was ever asked to run, and
 * the `/hook/proof` callback that finishes a hunt could never fire because no
 * hunt had been started. Everything downstream was built and unreachable.
 *
 * Three rules shape this file:
 *
 *   1. The gate runs first, on every approval. A brief that PolicyEngine will
 *      not allow never becomes a dispatch. `prove.yml` is a Foundry pipeline,
 *      so the action it authorises is a `simulate` against a repo target.
 *
 *   2. Derive, never guess. `repo`, `commit` and `contract` are read out of
 *      fields the Brief actually carries (`targets`, `notes`, `cls`). When one
 *      cannot be derived we say exactly which one and why. A fabricated commit
 *      SHA would produce a proof run against code nobody pinned, which is worse
 *      than no run at all.
 *
 *   3. Fail loud. Every refusal and every non-2xx from the GitHub API is
 *      surfaced with its status and body. A hunt is never described as running
 *      when no dispatch occurred, and a `hunts` row only exists once a dispatch
 *      is genuinely being attempted.
 */

import { PolicyEngine, roeFromBrief, type Decision } from './policy.js';
import { esc } from './telegram.js';
import type { Brief } from './intake.js';
import { chainSpec, describeChain, parseChainToken, DEFAULT_FORK_RPC_ENV } from './chains.js';
import {
  METHODOLOGY_INPUT,
  describeMethodology,
  methodologyForBrief,
} from './methodology-dispatch.js';

// ─── the workflow contract ───────────────────────────────────────────────────

/** Workflow file inside GITHUB_REPO. Must match .github/workflows/prove.yml. */
export const WORKFLOW_FILE = 'prove.yml';

/**
 * `prove.yml` runs Foundry: it clones the target, writes PoCs into `test/`,
 * runs `forge test` and judges the result. There is no proof path for a web2
 * or infra brief, so those are refused rather than dispatched into a job that
 * cannot possibly succeed.
 */
const PROVABLE_CLASS = 'solidity';

/**
 * Technique recorded on the gate decision. Distinct from any live-target
 * technique so a dispatch is auditable as its own class of action.
 */
export const PROOF_TECHNIQUE = 'ASTERION-PROVE';

/** Stage a hunt sits in from "dispatched" until the verdict callback lands. */
export const STAGE_DISPATCHED = 'prime';
export const STAGE_DISPATCH_FAILED = 'failed';

// ─── derivation ──────────────────────────────────────────────────────────────

export interface ProveInputs {
  repo: string;
  commit: string;
  contract: string;
  fork_block: string;
  /**
   * EVM chain the fork must be taken from, as `cast chain-id` would report it.
   *
   * Optional only because a repo-only brief has no chain to pin. prove.yml
   * resolves this to a `FORK_RPC_<id>` secret and asserts `cast chain-id` agrees
   * with it, so a wrong-chain fork is red rather than silently measured against
   * unrelated state.
   */
  chain_id?: string;
  /**
   * Deployed instance the PoC attaches to, as a 20-byte hex address.
   *
   * The generated PoC does `vm.createSelectFork(FORK_RPC)` and then
   * `${contract}(vm.envAddress("TARGET"))`, so this must be an ADDRESS. It is
   * deliberately NOT derived from `repo` (a git URL): feeding a URL to
   * envAddress makes every PoC die in setUp with "environment variable TARGET is
   * not a valid address", which the judge can only report as inconclusive.
   *
   * Optional because a repo-only brief can still test contract logic that the
   * PoC deploys itself; when absent the workflow leaves TARGET unset and the
   * attempt is expected to be inconclusive rather than silently wrong.
   */
  address?: string;
  hunt_id: string;
  /**
   * The methodology block that governed this hunt.
   *
   * Optional and omitted when empty, so "no pack applied" stays distinguishable
   * from "an empty pack applied". CARRIED, NOT CONSUMED: the executor is
   * deterministic, so this input records which pack the run was dispatched under
   * rather than steering generated PoC text. See methodology-dispatch.ts.
   *
   * Requires the matching input declaration in .github/workflows/prove.yml.
   * GitHub answers a workflow_dispatch carrying an undeclared input with 422.
   */
  methodology?: string;
}

export interface Derivation {
  ok: boolean;
  /** Present only when ok. */
  inputs: Omit<ProveInputs, 'hunt_id'> | null;
  /** prove.yml input names that could not be derived. Empty when ok. */
  missing: string[];
  /** One human sentence per problem, in the same order as `missing`. */
  why: string[];
  /** Inputs that WERE derived, for the operator's confirmation message. */
  partial: Record<string, string>;
}

const REPO_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/i;
const SHA = /\b[0-9a-f]{7,40}\b/i;

/** `https://github.com/acme/vault.git@<sha>` -> repo + optional commit. */
function splitRepoTarget(raw: string): { repo: string; commit: string | null } | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  // An explicit `@<sha>` / `#<sha>` suffix pins the commit and is not part of
  // the clone URL. `#` is a common form because git accepts both.
  let repo = trimmed;
  let commit: string | null = null;
  const at = repo.match(/^(.*?)[@#]([0-9a-f]{7,40})$/i);
  if (at?.[1] && at[2]) {
    repo = at[1];
    commit = at[2].toLowerCase();
  }

  let host: string;
  try {
    host = new URL(repo).hostname;
  } catch {
    return null;
  }
  const isGit = REPO_HOSTS.test(host) || /\.git$/i.test(repo);
  if (!isGit) return null;
  return { repo, commit };
}

/** Look up `key:value` or `key=value` tokens in the operator's raw text. */
function token(raw: string, keys: string[]): string | null {
  for (const k of keys) {
    const re = new RegExp(`\\b${k}\\s*[:=]\\s*([^\\s,;]+)`, 'i');
    const m = raw.match(re);
    if (m?.[1]) return m[1].replace(/[.,;]+$/, '');
  }
  return null;
}

/**
 * Read the three required prove.yml inputs out of an approved Brief.
 *
 * Sources, in precedence order, and nothing else:
 *   repo     — a git-URL-shaped entry in `brief.targets`, else `repo:` in `notes`
 *   commit   — `@<sha>`/`#<sha>` on that target, else `commit:` in `notes`,
 *              else the only bare 40-hex token in `notes`
 *   contract — `contract:` in `notes`
 *
 * `notes` is the operator's own text (intake keeps the first 2000 chars), so
 * these tokens are an explicit statement of intent rather than an inference.
 */
export function deriveProveInputs(brief: Brief): Derivation {
  const missing: string[] = [];
  const why: string[] = [];
  const partial: Record<string, string> = {};

  // A non-solidity brief has no proof path at all; say that before listing
  // inputs, or the operator will go hunting for a repo that would not help.
  if (brief.cls !== PROVABLE_CLASS) {
    return {
      ok: false,
      inputs: null,
      missing: ['cls'],
      why: [
        `this brief is class "${brief.cls}" but prove.yml only proves ${PROVABLE_CLASS} ` +
          `(it clones a repo and runs forge test); there is no proof path for ${brief.cls}`,
      ],
      partial,
    };
  }

  // repo (+ commit pinned on the target)
  let repo: string | null = null;
  let commit: string | null = null;
  for (const t of brief.targets ?? []) {
    const hit = splitRepoTarget(t);
    if (hit) {
      repo = hit.repo;
      commit = hit.commit;
      break;
    }
  }
  if (!repo) {
    const fromNotes = token(brief.notes ?? '', ['repo', 'repository', 'git']);
    const hit = fromNotes ? splitRepoTarget(fromNotes) : null;
    if (hit) {
      repo = hit.repo;
      commit = hit.commit;
    }
  }
  if (repo) partial.repo = repo;
  else {
    missing.push('repo');
    why.push(
      'no git URL in the brief: targets are ' +
        (brief.targets?.length ? brief.targets.map((t) => `"${t}"`).join(', ') : 'empty') +
        ', and a Host/URL/0x-address target does not name the source repository prove.yml must clone',
    );
  }

  // commit
  if (!commit) {
    const explicit = token(brief.notes ?? '', ['commit', 'sha', 'rev']);
    if (explicit && /^[0-9a-f]{7,40}$/i.test(explicit)) commit = explicit.toLowerCase();
    else {
      // Only accept a bare SHA when it is unambiguous.
      const all = [...(brief.notes ?? '').matchAll(new RegExp(SHA.source, 'gi'))].map((m) =>
        m[0].toLowerCase(),
      );
      const uniq = [...new Set(all)];
      if (uniq.length === 1) commit = uniq[0]!;
    }
  }
  if (commit) partial.commit = commit;
  else {
    missing.push('commit');
    why.push(
      'no commit SHA anywhere in the brief: prove.yml pins the checkout with ' +
        '`git checkout <commit>`, and the byte-identical reproduction that makes a verdict ' +
        'meaningful depends on knowing which tree was tested',
    );
  }

  // contract
  let contract = token(brief.notes ?? '', ['contract', 'contractname']);
  if (contract && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(contract)) contract = null;
  if (contract) partial.contract = contract;
  else {
    missing.push('contract');
    why.push(
      'no contract name in the brief: prove.yml imports the target as ../src/<contract>.sol, ' +
        'and a contract name is not recoverable from a repo URL, a host or a 0x address',
    );
  }

  const forkBlock = token(brief.notes ?? '', ['fork_block', 'forkblock', 'fork', 'block']) ?? '0';
  const fork_block = /^\d+$/.test(forkBlock) ? forkBlock : '0';

  // chain_id: carried whenever the brief pinned one. A brief that carries a bare
  // `0x…` target MUST name a chain, and `roeFromBrief` refuses it otherwise —
  // but that refusal happens in the gate, which runs before derivation. So this
  // lookup is for the ordinary case, and the gate is the guarantee.
  const pinnedChain =
    brief.chain_id != null && Number.isInteger(brief.chain_id)
      ? brief.chain_id
      : parseChainToken(brief.notes ?? '');
  if (pinnedChain != null) partial.chain_id = String(pinnedChain);

  // address: the deployed instance to attach the PoC to. Taken ONLY from an
  // explicit 0x target (or an explicit `address:` note token) — the same
  // explicit-intent rule this function already uses for repo and commit. We do
  // not guess an address out of prose, and we never substitute the repo URL for
  // it: a URL in envAddress fails setUp and can only ever be inconclusive.
  const ADDR = /^0x[a-fA-F0-9]{40}$/;
  let address: string | null = null;
  for (const t of brief.targets ?? []) {
    const cand = t.trim();
    if (ADDR.test(cand)) {
      address = cand.toLowerCase();
      break;
    }
  }
  if (!address) {
    const fromNotes = token(brief.notes ?? '', ['address', 'contract_address', 'instance']);
    if (fromNotes && ADDR.test(fromNotes)) address = fromNotes.toLowerCase();
  }
  if (address) partial.address = address;

  if (missing.length) return { ok: false, inputs: null, missing, why, partial };
  return {
    ok: true,
    inputs: {
      repo: repo!,
      commit: commit!,
      contract: contract!,
      fork_block,
      ...(pinnedChain != null ? { chain_id: String(pinnedChain) } : {}),
      ...(address ? { address } : {}),
    },
    missing: [],
    why: [],
    partial,
  };
}

// ─── the gate ────────────────────────────────────────────────────────────────

/**
 * Ask PolicyEngine whether this brief may spawn proof compute.
 *
 * This is the same engine every other adapter goes through — the dispatch path
 * does not get a private shortcut. `prove.yml` clones a repo and runs
 * `forge test` against a fork, which is exactly a `simulate` on a `repo`
 * target. A read-only brief's ceiling will refuse that, and the refusal is the
 * product working correctly rather than a bug to route around.
 */
export async function authorizeProof(
  brief: Brief,
  repo: string,
  now = Date.now() / 1000,
): Promise<Decision> {
  const roe = roeFromBrief(brief, now);
  const engine = new PolicyEngine(roe, () => now);
  return engine.authorize({
    technique: PROOF_TECHNIQUE,
    target: repo,
    target_kind: 'repo',
    mutability: 'simulate',
    adapter: 'foundry',
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
 * did this run on?" blindness this work exists to remove.
 */
function chainLine(chainId: string | undefined): string {
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
 * POST a workflow_dispatch. Never throws: a network failure and a 422 are both
 * reported, because "it did not run" must be distinguishable from "it ran".
 */
export async function dispatchProveWorkflow(
  args: {
    token: string;
    /** owner/name of the repo CONTAINING prove.yml (not the target repo). */
    githubRepo: string;
    ref: string;
    inputs: ProveInputs;
  },
  deps: { fetch: typeof fetch },
): Promise<DispatchResult> {
  const url = `https://api.github.com/repos/${args.githubRepo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

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
        body: JSON.stringify({
        ref: args.ref,
        inputs: {
          repo: args.inputs.repo,
          commit: args.inputs.commit,
          contract: args.inputs.contract,
          fork_block: args.inputs.fork_block,
          // Only sent when the brief pinned a chain. prove.yml declares this
          // input; a dispatch carrying an undeclared input is a 422, which is
          // why the workflow had to gain the declaration in the same change.
          ...(args.inputs.chain_id ? { chain_id: args.inputs.chain_id } : {}),
          // Only sent when known: an empty string would set TARGET="" and make
          // vm.envAddress revert rather than cleanly leave it unset.
          ...(args.inputs.address ? { address: args.inputs.address } : {}),
          hunt_id: args.inputs.hunt_id,
          // Only sent when a pack actually applied. An empty string would make
          // prove.yml write a zero-byte methodology.md and blur "none applied"
          // into "an empty one applied".
          ...(args.inputs.methodology ? { [METHODOLOGY_INPUT]: args.inputs.methodology } : {}),
        },
      }),
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
  | { dispatched: true; huntId: string; status: number }
  | { dispatched: false; reason: string; missing?: string[] };

/**
 * Approve (or deny) an engagement approval and, for an approved solidity brief
 * that passes the gate and has derivable provenance, actually start the hunt.
 *
 * Ordering that matters:
 *   gate -> derive -> env check -> INSERT hunts -> dispatch
 * The hunts row is written BEFORE the POST so the `/hook/proof` callback always
 * has a row to upsert into. It is NOT written before the gate or the env check
 * — a hunt row that no compute was ever asked to run would be a lie in the
 * database, which is exactly the class of bug this work is fixing.
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

  // 1. Gate. Only a brief the policy engine allows may reach compute.
  const repoHint =
    (brief.targets ?? []).map((t) => splitRepoTarget(t)?.repo).find(Boolean) ??
    token(brief.notes ?? '', ['repo', 'repository', 'git']) ??
    brief.program_id;

  let decision: Decision;
  try {
    decision = await authorizeProof(brief, repoHint, now());
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

  // 2. Derive. Never guess a value prove.yml will act on.
  const derivation = deriveProveInputs(brief);
  if (!derivation.ok || !derivation.inputs) {
    await deps.ledger('dispatch.blocked', {
      approval: approvalId,
      gate: 'allow',
      missing: derivation.missing,
      why: derivation.why,
    });
    const onlyClass = derivation.missing.length === 1 && derivation.missing[0] === 'cls';
    const headline = onlyClass
      ? `<b>no proof path for this class</b>  <code>${esc(brief.cls)}</code>`
      : `<b>cannot build prove.yml inputs</b>  missing: <code>${derivation.missing.join('</code>, <code>')}</code>`;
    await deps.notify(
      [
        `\u2713 approved <code>${esc(approvalId)}</code> \u2014 <b>NOT DISPATCHED</b>`,
        `gate      allow (${esc(decision.reason)})`,
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
      reason: onlyClass ? 'not_provable_class' : 'underivable_inputs',
      missing: derivation.missing,
    };
  }

  // 3. Environment. Name the exact missing variable, never a generic failure.
  const missingVars: string[] = [];  if (!deps.env.GITHUB_DISPATCH_TOKEN) missingVars.push('GITHUB_DISPATCH_TOKEN');
  if (!deps.env.GITHUB_REPO) missingVars.push('GITHUB_REPO');
  if (missingVars.length) {
    await deps.ledger('dispatch.blocked', { approval: approvalId, missing_env: missingVars });
    await deps.notify(
      [
        `\u2713 approved <code>${esc(approvalId)}</code> \u2014 <b>NOT DISPATCHED</b>`,
        `gate      allow (${esc(decision.reason)})`,
        `inputs    derivable (repo, commit, contract)`,
        '',
        `<b>missing configuration</b>  <code>${missingVars.join('</code>, <code>')}</code>`,
        '',
        'Set the missing Worker secret and tap Authorize again:',
        '  <code>wrangler secret put GITHUB_DISPATCH_TOKEN</code>',
        '  <code>GITHUB_REPO</code> = owner/name of the repo holding <code>prove.yml</code>',
        '',
        '<i>A fine-grained token with Actions:write on that repo is enough. Nothing was dispatched.</i>',
      ].join('\n'),
    );
    return { dispatched: false, reason: 'missing_env', missing: missingVars };
  }

  const inputs = derivation.inputs;
  const huntId = uuid();
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
  const inputsWithMethodology: ProveInputs = {
    ...inputs,
    hunt_id: huntId,
          ...(methodology.block ? { methodology: methodology.block } : {}),
  };

  // 4. The hunt row, before the POST: /hook/proof upserts on this id.
  await deps.db.run(
    `INSERT INTO hunts (id, program_id, repo, commit_sha, contract, fork_block, stage, leads_n, attempts_n, proven_n, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,0,0,?,?)
     ON CONFLICT(id) DO UPDATE SET
       repo=excluded.repo, commit_sha=excluded.commit_sha, contract=excluded.contract,
       fork_block=excluded.fork_block, stage=excluded.stage, updated_at=excluded.updated_at`,
    huntId,
    brief.program_id ?? null,
    inputs.repo,
    inputs.commit,
    inputs.contract,
    Number(inputs.fork_block) || 0,
    STAGE_DISPATCHED,
    ts,
    ts,
  );

  // 5. Dispatch, and tell the truth about what came back.
  const res = await dispatchProveWorkflow(
    {
      token: deps.env.GITHUB_DISPATCH_TOKEN!,
      githubRepo: deps.env.GITHUB_REPO!,
      ref,
      inputs: inputsWithMethodology,
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
      repo: inputs.repo,
      commit: inputs.commit,
      status: res.status,
      body: res.body,
      error: res.error,
    });
    await deps.notify(
      [
        `\u26A0 <b>DISPATCH FAILED</b>  <code>${esc(huntId)}</code>`,
        `gate      allow (${esc(decision.reason)})`,
        `workflow  <code>${esc(deps.env.GITHUB_REPO!)}/.github/workflows/${WORKFLOW_FILE}</code>`,
        '',
        `<b>${esc(detail)}</b>`,
        '',
        `hunt row marked <code>${STAGE_DISPATCH_FAILED}</code> \u2014 <b>no proof is running</b>.`,
      ].join('\n'),
    );
    return { dispatched: false, reason: 'dispatch_failed' };
  }

  await deps.ledger('dispatch.sent', {
    approval: approvalId,
    hunt: huntId,
    repo: inputs.repo,
    commit: inputs.commit,
    contract: inputs.contract,
    fork_block: inputs.fork_block,
    ref,
    gate: decision.reason,
    // Which pack governed the run, or why none did. Recorded separately from
    // the block itself so the ledger stays a readable audit rather than a
    // 4000-char dump repeated per hunt.
    methodology: describeMethodology(methodology),
    methodology_skill: methodology.skill_id,
    methodology_chars: methodology.block.length,
  });

  const shortRepo = inputs.repo.replace(/^https?:\/\//, '').replace(/\.git$/, '');
  await deps.notify(
    [
      `\u2713 approved <code>${esc(approvalId)}</code> \u2014 <b>DISPATCHED</b>`,
      `gate      allow (${esc(decision.reason)})`,
      `hunt      <code>${esc(huntId)}</code>   stage <code>${STAGE_DISPATCHED}</code>`,
      `repo      <code>${esc(shortRepo)}</code>`,
      `commit    <code>${esc(inputs.commit.slice(0, 12))}</code>`,
      `contract  <code>${esc(inputs.contract)}</code>   fork block ${esc(inputs.fork_block)}`,
      `chain     ${esc(chainLine(inputs.chain_id))}`,
      `method    ${esc(methodology.skill_id ? `${methodology.skill_id} (${methodology.block.length} chars)` : 'none — ' + methodology.reason)}`,
      '',
      `GitHub returned ${res.status}. Verdicts arrive at /hook/proof when the run finishes.`,
    ].join('\n'),
  );

  return { dispatched: true, huntId, status: res.status! };
}
