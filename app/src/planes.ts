/**
 * The plane registry — one workflow, one input contract, one harness set per class.
 *
 * WHY THIS FILE EXISTS
 *
 * `dispatch.ts` used to be hard-wired to one plane:
 *
 *     export const WORKFLOW_FILE = 'prove.yml';
 *     export const PROVABLE_CLASS = 'solidity';
 *
 * Three of the four planes in this tree therefore existed as files and were
 * unreachable. Every brief — web2, infra, Solana — either refused as "no proof
 * path" (the honest half) or, before B8, silently queued a FOUNDRY job at a
 * target no Foundry run can execute.
 *
 * THE RULE THIS FILE IMPLEMENTS
 *
 *   A plane is a (workflow file, input builder, harness set) triple. Nothing
 *   else. A class with no triple refuses BY NAME. A class with a triple but no
 *   harness for the chosen playbook refuses by name too, and those are
 *   DIFFERENT refusals — "there is no web plane" and "the web plane cannot run
 *   web.graphql yet" send the operator to different places.
 *
 * WHY THE BUILDERS RETURN THE WIRE BODY, NOT A TYPED UNION
 *
 * GitHub answers a `workflow_dispatch` carrying an input the workflow does not
 * declare with **422**. The four contracts genuinely diverge:
 *
 *   solidity  repo / commit / contract / fork_block / chain_id / address
 *   web2      target / playbook / evidence
 *   infra     domain / playbook / evidence
 *   solana    repo / commit / program / program_id / instruction / playbook
 *
 * A single union body therefore cannot work: whichever plane receives it gets
 * 422 for the keys that belong to another plane. Each builder returns exactly
 * the `inputs` object its own workflow declares, and the dispatcher posts it
 * verbatim. The test that walks each workflow's `workflow_dispatch:` block and
 * compares it with the body the builder produces is what keeps the TypeScript
 * and the YAML from drifting apart.
 *
 * `hunt_id` IS MANDATORY ON EVERY PLANE
 *
 * `/hook/proof` upserts on the hunt id. Without a real `hunts` row the callback
 * lands as an orphan, and ingest refuses an orphan's `proven` verdict by design
 * (see `ingestProofs`). So a dispatch with no hunt id is a run whose verdict is
 * discarded — worse than a refusal, because it costs compute and looks like
 * work. The builders therefore take `huntId` as a required argument and refuse
 * an empty one; there is no code path that can omit it.
 */

import type { Brief } from './intake.js';
import type { Cls } from './playbooks.js';
import { parseChainToken } from './chains.js';
import { isSolanaPubkey } from './solana.js';
// ─── the shared refusal shape ─────────────────────────────────────────────────

/**
 * The result of trying to build one dispatch body.
 *
 * Deliberately identical across planes so the refusal UX is unchanged: the
 * operator sees `missing: [...]` plus one sentence of `why` per entry, whatever
 * the class. `plane` is carried so a message can name what was looked for.
 */
export interface Derivation {
  ok: boolean;
  /** Workflow file inside GITHUB_REPO. Null only when the class has no plane. */
  workflow: string | null;
  /** The EXACT `workflow_dispatch.inputs` object. Null when ok is false. */
  inputs: Record<string, string> | null;
  /** Input names that could not be derived, in the plane's own vocabulary. */
  missing: string[];
  /** One human sentence per problem, in the same order as `missing`. */
  why: string[];
  /** Inputs that WERE derived, for the operator's confirmation message. */
  partial: Record<string, string>;
  /** Human name of the plane, e.g. 'web2/HTTP'. */
  plane: string;
}

/** The one target a plane's gate authorises, plus how policy must read it. */
export interface ScopeTarget {
  target: string;
  target_kind: 'repo' | 'url' | 'domain' | 'host' | 'chain_address';
  adapter: string;
}

export interface Plane {
  cls: Cls;
  /** Workflow file inside GITHUB_REPO, verbatim. */
  workflow: string;
  /** Human name, used by every refusal that names a missing plane. */
  plane: string;
  /**
   * Playbook ids this plane has a REAL executor for.
   *
   * Not the same thing as "the class has a plane": the Solana plane exists and
   * runs `sol.svm-signer`; `sol.svm-account` and `sol.svm-cpi` are in the same
   * class and have no harness yet. They must refuse by name rather than queue a
   * run that cannot conclude — see `noHarnessReason`.
   */
  harnesses: ReadonlySet<string>;
  /** Build the exact dispatch body, or say precisely what is missing. */
  build: (brief: Brief, huntId: string) => Derivation;
}

// ─── small derivation helpers, shared by every builder ────────────────────────

const REPO_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/i;
const SHA = /\b[0-9a-f]{7,40}\b/i;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const URL_SHAPE = /^https?:\/\//i;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** `https://github.com/acme/vault.git@<sha>` -> repo + optional commit. */
export function splitRepoTarget(raw: string): { repo: string; commit: string | null } | null {
  const trimmed = raw.trim();
  if (!URL_SHAPE.test(trimmed)) return null;

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
export function token(raw: string, keys: string[]): string | null {
  for (const k of keys) {
    const re = new RegExp(`\\b${k}\\s*[:=]\\s*([^\\s,;]+)`, 'i');
    const m = raw.match(re);
    if (m?.[1]) return m[1].replace(/[.,;]+$/, '');
  }
  return null;
}

/** True for a bare hostname that is not already a URL or a repo URL. */
export function isBareHost(raw: string): boolean {
  const t = raw.trim();
  if (!t || URL_SHAPE.test(t)) return false;
  return HOSTNAME.test(t);
}

/**
 * A brief's git target, or null.
 *
 * Precedence: a git-URL-shaped entry in `targets`, else `repo:` in `notes`.
 * `notes` is the operator's own text, so this is an explicit statement of
 * intent rather than an inference.
 */
function repoOf(brief: Brief): { repo: string; commit: string | null } | null {
  for (const t of brief.targets ?? []) {
    const hit = splitRepoTarget(t);
    if (hit) return hit;
  }
  const fromNotes = token(brief.notes ?? '', ['repo', 'repository', 'git']);
  return fromNotes ? splitRepoTarget(fromNotes) : null;
}

/**
 * A commit SHA, from the target pin, an explicit token, or the only bare SHA.
 *
 * The "only bare SHA" arm refuses an ambiguous note rather than guessing: a
 * fabricated commit would pin the run to a tree nobody chose.
 */
function commitOf(brief: Brief, pinned: string | null): string | null {
  if (pinned) return pinned;
  const explicit = token(brief.notes ?? '', ['commit', 'sha', 'rev']);
  if (explicit && /^[0-9a-f]{7,40}$/i.test(explicit)) return explicit.toLowerCase();
  const all = [...(brief.notes ?? '').matchAll(new RegExp(SHA.source, 'gi'))].map((m) =>
    m[0].toLowerCase(),
  );
  const uniq = [...new Set(all)];
  return uniq.length === 1 ? uniq[0]! : null;
}

/** True when the class actually got a hunt id. Mandatory on every plane. */
function huntIdOrEmpty(huntId: string): string {
  return typeof huntId === 'string' ? huntId.trim() : '';
}

/**
 * The refusal for a missing hunt id, shared by every builder.
 *
 * Reached only through a caller bug (the orchestration mints the id before it
 * derives), and it is still a refusal rather than a warning: a dispatch without
 * a hunt id is a run whose verdict /hook/proof will discard.
 */
const HUNT_ID_WHY =
  'no hunt id: /hook/proof upserts on the hunt id, and ingest REFUSES a proven verdict ' +
  'that resolves to no hunts row, so this run could only ever produce a discarded verdict';

// ─── the planes ──────────────────────────────────────────────────────────────

/** `solidity` — the Foundry/EVM plane. Unchanged contract, new shape. */
function buildSolidity(brief: Brief, huntId: string): Derivation {
  const missing: string[] = [];
  const why: string[] = [];
  const partial: Record<string, string> = {};
  const workflow = 'prove.yml';

  const id = huntIdOrEmpty(huntId);
  if (!id) {
    missing.push('hunt_id');
    why.push(HUNT_ID_WHY);
  }

  const git = repoOf(brief);
  const repo = git?.repo ?? null;
  if (repo) partial.repo = repo;
  else {
    missing.push('repo');
    why.push(
      'no git URL in the brief: targets are ' +
        (brief.targets?.length ? brief.targets.map((t) => `"${t}"`).join(', ') : 'empty') +
        ', and a Host/URL/0x-address target does not name the source repository prove.yml must clone',
    );
  }

  const commit = commitOf(brief, git?.commit ?? null);
  if (commit) partial.commit = commit;
  else {
    missing.push('commit');
    why.push(
      'no commit SHA anywhere in the brief: prove.yml pins the checkout with ' +
        '`git checkout <commit>`, and the byte-identical reproduction that makes a verdict ' +
        'meaningful depends on knowing which tree was tested',
    );
  }

  let contract = token(brief.notes ?? '', ['contract', 'contractname']);
  if (contract && !IDENT.test(contract)) contract = null;
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
  // explicit 0x target (or an explicit `address:` note token) — never from a
  // repo URL, because a URL in envAddress fails setUp and can only ever be
  // inconclusive.
  let address: string | null = null;
  for (const t of brief.targets ?? []) {
    const cand = t.trim();
    if (ADDRESS.test(cand)) {
      address = cand.toLowerCase();
      break;
    }
  }
  if (!address) {
    const fromNotes = token(brief.notes ?? '', ['address', 'contract_address', 'instance']);
    if (fromNotes && ADDRESS.test(fromNotes)) address = fromNotes.toLowerCase();
  }
  if (address) partial.address = address;

  if (missing.length) {
    return { ok: false, workflow, inputs: null, missing, why, partial, plane: 'Foundry/EVM' };
  }
  return {
    ok: true,
    workflow,
    inputs: {
      repo: repo!,
      commit: commit!,
      contract: contract!,
      fork_block,
      ...(pinnedChain != null ? { chain_id: String(pinnedChain) } : {}),
      ...(address ? { address } : {}),
      hunt_id: id,
    },
    missing: [],
    why: [],
    partial,
    plane: 'Foundry/EVM',
  };
}

/** `web2` — the HTTP plane. Contract: target / playbook / evidence. */
function buildWeb2(brief: Brief, huntId: string): Derivation {
  const missing: string[] = [];
  const why: string[] = [];
  const partial: Record<string, string> = {};
  const workflow = 'prove-web.yml';

  const id = huntIdOrEmpty(huntId);
  if (!id) {
    missing.push('hunt_id');
    why.push(HUNT_ID_WHY);
  }

  // target: an explicit http(s) URL that is NOT a source repository, else a
  // `target:`/`url:` note token. A repo URL is deliberately excluded: prove-web
  // issues HTTP requests, and a git URL is a checkout, not an endpoint.
  let target: string | null = null;
  for (const t of brief.targets ?? []) {
    const cand = t.trim();
    if (URL_SHAPE.test(cand) && !splitRepoTarget(cand)) {
      target = cand;
      break;
    }
  }
  if (!target) {
    const fromNotes = token(brief.notes ?? '', ['target', 'url', 'endpoint', 'host']);
    if (fromNotes) target = fromNotes;
  }
  if (target) partial.target = target;
  else {
    missing.push('target');
    why.push(
      'no HTTP endpoint in the brief: targets are ' +
        (brief.targets?.length ? brief.targets.map((t) => `"${t}"`).join(', ') : 'empty') +
        ', and prove-web.yml issues requests at an absolute http(s) URL; a git URL is a ' +
        'checkout and a bare hostname has no scheme to request',
    );
  }

  const playbook = harnessedPlaybook(brief, 'web2');
  if (playbook) partial.playbook = playbook;
  else {
    missing.push('playbook');
    why.push(
      'no web2 playbook this plane can execute: the brief names ' +
        (brief.playbooks?.length ? brief.playbooks.join(', ') : 'none') +
        `, and prove-web.yml has a harness for ${[...WEB2_HARNESSES].join(', ')}`,
    );
  }

  const evidence = token(brief.notes ?? '', ['evidence', 'capture']);
  if (evidence) partial.evidence = evidence;

  if (missing.length) {
    return { ok: false, workflow, inputs: null, missing, why, partial, plane: 'web2/HTTP' };
  }
  return {
    ok: true,
    workflow,
    inputs: {
      target: target!,
      playbook: playbook!,
      ...(evidence ? { evidence } : {}),
      hunt_id: id,
    },
    missing: [],
    why: [],
    partial,
    plane: 'web2/HTTP',
  };
}

/** `infra` — the DNS plane. Contract: domain / playbook / evidence. */
function buildInfra(brief: Brief, huntId: string): Derivation {
  const missing: string[] = [];
  const why: string[] = [];
  const partial: Record<string, string> = {};
  const workflow = 'prove-infra.yml';

  const id = huntIdOrEmpty(huntId);
  if (!id) {
    missing.push('hunt_id');
    why.push(HUNT_ID_WHY);
  }

  // domain: a bare hostname target, else `domain:`/`host:` in notes. A URL is
  // accepted too, reduced to its host: an infra hunt acts on the NAME (DNS, TLS,
  // takeover), and the path is not part of the name.
  let domain: string | null = null;
  for (const t of brief.targets ?? []) {
    const cand = t.trim();
    if (isBareHost(cand)) {
      domain = cand.toLowerCase();
      break;
    }
    if (URL_SHAPE.test(cand) && !splitRepoTarget(cand)) {
      try {
        domain = new URL(cand).hostname.toLowerCase();
        break;
      } catch {
        // not a parseable URL: keep looking
      }
    }
  }
  if (!domain) {
    const fromNotes = token(brief.notes ?? '', ['domain', 'host', 'subdomain']);
    if (fromNotes) domain = fromNotes.toLowerCase();
  }
  if (domain) partial.domain = domain;
  else {
    missing.push('domain');
    why.push(
      'no domain in the brief: targets are ' +
        (brief.targets?.length ? brief.targets.map((t) => `"${t}"`).join(', ') : 'empty') +
        ', and prove-infra.yml audits a DNS NAME (records, delegations, takeover-shaped ' +
        'dangling pointers); an address or a repo does not name one',
    );
  }

  const playbook = harnessedPlaybook(brief, 'infra');
  if (playbook) partial.playbook = playbook;
  else {
    missing.push('playbook');
    why.push(
      'no infra playbook this plane can execute: the brief names ' +
        (brief.playbooks?.length ? brief.playbooks.join(', ') : 'none') +
        `, and prove-infra.yml has a harness for ${[...INFRA_HARNESSES].join(', ')}`,
    );
  }

  const evidence = token(brief.notes ?? '', ['evidence', 'capture', 'zone']);
  if (evidence) partial.evidence = evidence;

  if (missing.length) {
    return { ok: false, workflow, inputs: null, missing, why, partial, plane: 'infrastructure/DNS' };
  }
  return {
    ok: true,
    workflow,
    inputs: {
      domain: domain!,
      playbook: playbook!,
      ...(evidence ? { evidence } : {}),
      hunt_id: id,
    },
    missing: [],
    why: [],
    partial,
    plane: 'infrastructure/DNS',
  };
}

/** `solana` — the SVM plane. Contract: repo / commit / program / program_id / instruction. */
function buildSolana(brief: Brief, huntId: string): Derivation {
  const missing: string[] = [];
  const why: string[] = [];
  const partial: Record<string, string> = {};
  const workflow = 'prove-solana.yml';

  const id = huntIdOrEmpty(huntId);
  if (!id) {
    missing.push('hunt_id');
    why.push(HUNT_ID_WHY);
  }

  // repo + commit: the .rs source the harness builds with cargo-build-sbf and
  // that the counterfactual patches. Same rule as the EVM plane: an operator
  // statement, never an inference, and never an ambiguous SHA.
  const git = repoOf(brief);
  const repo = git?.repo ?? null;
  if (repo) partial.repo = repo;
  else {
    missing.push('repo');
    why.push(
      'no git URL in the brief: prove-solana.yml clones the Anchor/native program, builds it ' +
        'with cargo-build-sbf and deploys the .so to a bankrun validator, so the SOURCE ' +
        'repository is required — a program id alone is not something this plane can build',
    );
  }

  const commit = commitOf(brief, git?.commit ?? null);
  if (commit) partial.commit = commit;
  else {
    missing.push('commit');
    why.push(
      'no commit SHA anywhere in the brief: the harness checks out a pinned tree, and the ' +
        'counterfactual adds a check to that exact source and rebuilds — against an unpinned ' +
        'tree the before/after would describe two different programs',
    );
  }

  // program: the crate/package name under programs/, which is what
  // cargo-build-sbf builds and what names the .so the harness deploys.
  let program = token(brief.notes ?? '', ['program', 'crate', 'package', 'program_name']);
  if (program && !IDENT.test(program)) program = null;
  if (program) partial.program = program;
  else {
    missing.push('program');
    why.push(
      'no program (crate) name in the brief: cargo-build-sbf builds target/deploy/<program>.so ' +
        'from programs/<program>, and that name is not recoverable from a program id',
    );
  }

  // program_id: a base58 pubkey target, else a `program_id:` token. This is the
  // on-chain address the harness deploys the built .so AT, so the instruction
  // the playbook names is addressed to the same program the brief is about.
  let programId: string | null = null;
  for (const t of brief.targets ?? []) {
    const cand = t.trim();
    if (isSolanaPubkey(cand)) {
      programId = cand;
      break;
    }
  }
  if (!programId) {
    const fromNotes = token(brief.notes ?? '', ['program_id', 'programid', 'program-id']);
    if (fromNotes && isSolanaPubkey(fromNotes)) programId = fromNotes;
  }
  if (programId) partial.program_id = programId;
  else {
    missing.push('program_id');
    why.push(
      'no Solana program id in the brief: targets are ' +
        (brief.targets?.length ? brief.targets.map((t) => `"${t}"`).join(', ') : 'empty') +
        ', and a base58 program address is what the harness deploys the built program at and ' +
        'what the instruction is addressed to',
    );
  }

  // instruction: the entrypoint name the playbook exercises.
  let instruction = token(brief.notes ?? '', ['instruction', 'ix', 'entrypoint']);
  if (instruction && !IDENT.test(instruction)) instruction = null;
  if (instruction) partial.instruction = instruction;
  else {
    missing.push('instruction');
    why.push(
      'no instruction name in the brief: the Solana plane has no ABI-less fallback — instruction ' +
        'data must be built explicitly — so it needs the entrypoint it should invoke ' +
        '(e.g. `instruction:withdraw`)',
    );
  }

  const playbook = harnessedPlaybook(brief, 'solana');
  if (playbook) partial.playbook = playbook;
  else {
    missing.push('playbook');
    why.push(
      'no solana playbook this plane can execute: the brief names ' +
        (brief.playbooks?.length ? brief.playbooks.join(', ') : 'none') +
        `, and prove-solana.yml has a harness for ${[...SOLANA_HARNESSES].join(', ')}`,
    );
  }

  if (missing.length) {
    return { ok: false, workflow, inputs: null, missing, why, partial, plane: 'Solana (SVM)' };
  }
  return {
    ok: true,
    workflow,
    inputs: {
      repo: repo!,
      commit: commit!,
      program: program!,
      program_id: programId!,
      instruction: instruction!,
      playbook: playbook!,
      hunt_id: id,
    },
    missing: [],
    why: [],
    partial,
    plane: 'Solana (SVM)',
  };
}

// ─── harness sets: what each plane can ACTUALLY execute ──────────────────────

/**
 * web2 playbooks prove-web.yml has a harness for.
 *
 * Every entry here must be implemented in `web-run.mjs`; the coverage test
 * walks this set and asserts each one synthesizes a non-empty attack AND a
 * control, so a set membership is never the only claim.
 */
export const WEB2_HARNESSES: ReadonlySet<string> = new Set(['web.jwt']);

/** infra playbooks prove-infra.yml has a harness for. */
export const INFRA_HARNESSES: ReadonlySet<string> = new Set(['web.takeover']);

/**
 * Solana playbooks prove-solana.yml has a harness for.
 *
 * ONE entry on purpose. `sol.svm-account` and `sol.svm-cpi` are in the same
 * class and are NOT here: one class proven end to end beats three that half-run,
 * and a dispatchable class with no harness costs minutes and can never succeed.
 */
export const SOLANA_HARNESSES: ReadonlySet<string> = new Set(['sol.svm-signer']);

/**
 * The registry.
 *
 * Insertion order is display order. A class absent from this map has no plane
 * and refuses by name — that is the only refusal `mobile` gets, and it is a
 * refusal rather than a silent Foundry dispatch.
 */
export const PLANES: ReadonlyMap<Cls, Plane> = new Map<Cls, Plane>([
  [
    'solidity',
    {
      cls: 'solidity',
      workflow: 'prove.yml',
      plane: 'Foundry/EVM',
      // The EVM harness set is the source of truth in poc.ts:HARNESSED; it is
      // mirrored here only as the plane's claim, and a test asserts the two
      // agree rather than trusting this literal.
      harnesses: new Set([
        'sol.reentrancy',
        'sol.accesscontrol',
        'sol.upgrade',
        'sol.oracle',
        'sol.rounding',
        'sol.inflation',
        'sol.dos',
        'sol.signature',
        'sol.delegatecall',
        'sol.flashloan',
      ]),
      build: buildSolidity,
    },
  ],
  [
    'web2',
    {
      cls: 'web2',
      workflow: 'prove-web.yml',
      plane: 'web2/HTTP',
      harnesses: WEB2_HARNESSES,
      build: buildWeb2,
    },
  ],
  [
    'infra',
    {
      cls: 'infra',
      workflow: 'prove-infra.yml',
      plane: 'infrastructure/DNS',
      harnesses: INFRA_HARNESSES,
      build: buildInfra,
    },
  ],
  [
    'solana',
    {
      cls: 'solana',
      workflow: 'prove-solana.yml',
      plane: 'Solana (SVM)',
      harnesses: SOLANA_HARNESSES,
      build: buildSolana,
    },
  ],
]);

/** Classes that have a plane. A SET, so the refusal keeps firing for the rest. */
export const PROVABLE_CLASSES: ReadonlySet<string> = new Set<string>(
  [...PLANES.keys()] as string[],
);

/** The plane a class would need, for a refusal that names what is MISSING. */
export function planeNameFor(cls: string): string {
  switch (cls) {
    case 'solana':
      return 'Solana (SVM)';
    case 'web2':
      return 'web2/HTTP';
    case 'infra':
      return 'infrastructure/DNS';
    case 'mobile':
      return 'mobile (APK/IPA)';
    default:
      return `a ${cls}`;
  }
}

/** Workflow file for a class, or null when the class has no plane. */
export function workflowFileFor(cls: string): string | null {
  return PLANES.get(cls as Cls)?.workflow ?? null;
}

/** Every workflow file a plane can dispatch. Used by the coverage assertion. */
export function workflowFiles(): string[] {
  return [...new Set([...PLANES.values()].map((p) => p.workflow))];
}

/**
 * Why a class cannot be dispatched at all, in one sentence naming the plane that
 * does not exist.
 */
export function noPlaneReason(cls: string): string {
  const have = [...PLANES.values()].map((p) => `${p.cls}→${p.workflow}`).join(', ');
  return (
    `this brief is class "${cls}" but there is no ${planeNameFor(cls)} proof plane yet, so there ` +
    `is no workflow that could execute it. The planes that exist are ${have}. Dispatching it ` +
    'anyway would queue a job in a plane that cannot execute this class, which can only ever ' +
    'come back inconclusive.'
  );
}

/**
 * Why a class WITH a plane still cannot be dispatched for this playbook.
 *
 * Deliberately different wording from `noPlaneReason`: "there is no Solana
 * plane" and "the Solana plane has no `sol.svm-account` harness yet" are
 * different facts, and conflating them would make the operator wait for the
 * wrong thing.
 */
export function noHarnessReason(cls: string, playbook: string): string {
  const plane = PLANES.get(cls as Cls);
  if (!plane) return noPlaneReason(cls);
  const have = [...plane.harnesses];
  return (
    `the ${plane.plane} plane exists but has no harness for "${playbook}", so a run of it could ` +
    `never produce a finding: the plan would come back with zero attempts and the judge could ` +
    `only report inconclusive. Harnesses that DO run in this plane: ${have.join(', ')}.`
  );
}

/** A harnessed playbook named by the brief for this class, or null. */
function harnessedPlaybook(brief: Brief, cls: Cls): string | null {
  const plane = PLANES.get(cls);
  if (!plane) return null;
  for (const id of brief.playbooks ?? []) {
    if (plane.harnesses.has(id)) return id;
  }
  return null;
}

/**
 * Resolve the plane, then build its body.
 *
 * ORDER, AND WHY IT IS THIS ORDER
 *
 *   plane → harness → inputs
 *
 * The plane is resolved FIRST because a class with no plane has no adapter, so
 * there is nothing the policy gate could authorise — asking it would mean
 * inventing an adapter name. The harness check comes second for the same
 * reason. The GATE still runs before any dispatch in `approveAndDispatch`, so
 * this ordering changes no security property; it only changes which refusal an
 * operator reads.
 *
 * `huntId` is required and may not be empty: see HUNT_ID_WHY.
 */
export function deriveForBrief(brief: Brief, huntId: string): Derivation {
  const plane = PLANES.get(brief.cls);
  if (!plane) {
    return {
      ok: false,
      workflow: null,
      inputs: null,
      missing: ['cls'],
      why: [noPlaneReason(brief.cls)],
      partial: {},
      plane: planeNameFor(brief.cls),
    };
  }

  // A playbook the plane cannot execute refuses by name, before the builder
  // asks for a single input: listing "missing: repo, commit" for a class with
  // no harness would send the operator looking for a repo that would not help.
  const named = (brief.playbooks ?? []).filter((id) => plane.harnesses.has(id));
  const noneNamed = (brief.playbooks ?? []).length === 0;
  const foreign = (brief.playbooks ?? []).filter((id) => !plane.harnesses.has(id));
  if (!named.length && !noneNamed && foreign.length) {
    const why = foreign.map((id) => noHarnessReason(brief.cls, id));
    return {
      ok: false,
      workflow: plane.workflow,
      inputs: null,
      missing: ['playbook'],
      why,
      partial: {},
      plane: plane.plane,
    };
  }

  return plane.build(brief, huntId);
}

/**
 * The gate's scope target for a brief, per plane.
 *
 * This is why the plane registry exists on the policy side too: `authorizeProof`
 * used to hand every brief to the engine as `target_kind: 'repo'` with the
 * `foundry` adapter, which made a web2 brief's URL target and an infra brief's
 * domain target both pass as "a repo target is a read-only clone". The engine
 * can only check the axis it is told about, so the plane has to tell it.
 */
export function scopeTargetFor(brief: Brief, fallback: string): ScopeTarget {
  switch (brief.cls) {
    case 'solana': {
      const git = repoOf(brief);
      return {
        target: git?.repo ?? fallback,
        target_kind: 'repo',
        adapter: 'bankrun',
      };
    }
    case 'web2': {
      let t = '';
      for (const cand of brief.targets ?? []) {
        if (URL_SHAPE.test(cand.trim()) && !splitRepoTarget(cand)) {
          t = cand.trim();
          break;
        }
      }
      return { target: t || fallback, target_kind: 'url', adapter: 'web-evidence' };
    }
    case 'infra': {
      let t = '';
      for (const cand of brief.targets ?? []) {
        const v = cand.trim();
        if (isBareHost(v)) {
          t = v.toLowerCase();
          break;
        }
        if (URL_SHAPE.test(v) && !splitRepoTarget(v)) {
          try {
            t = new URL(v).hostname.toLowerCase();
            break;
          } catch {
            /* not parseable */
          }
        }
      }
      return { target: t || fallback, target_kind: 'domain', adapter: 'dns-evidence' };
    }
    default: {
      // solidity: the repo the PoC clones. Resolved here rather than taken from
      // the caller's hint so the engine always checks the same value the builder
      // will send; the hint is the fallback for a brief with no repo at all,
      // where the engine still has an axis to check rather than an empty string.
      const git = repoOf(brief);
      return { target: git?.repo ?? fallback, target_kind: 'repo', adapter: 'foundry' };
    }
  }
}

// ─── derived dispatch sets ───────────────────────────────────────────────────
//
// These live HERE, not in playbooks.ts, because both facts they depend on — "a
// plane exists" and "that plane can execute this playbook" — are properties of
// the registry above. A second hand-written list is exactly how `HARNESSED` and
// the old `DISPATCHER_CLASSES` drifted apart in B7.

/**
 * The classes whose plane has at least one real harness.
 *
 * `mobile` is absent by construction: it has no plane. `solana` IS present,
 * which is the deliberate outcome of building the plane — but it does NOT mean
 * every `sol.*` SVM playbook is dispatchable. See `dispatchablePlaybookIds`.
 */
export const DISPATCHER_CLASSES: ReadonlySet<string> = new Set<string>(
  [...PLANES.values()].filter((p) => p.harnesses.size > 0).map((p) => p.cls as string),
);

/**
 * Every playbook id some plane may actually queue work for.
 *
 * Per-PLAYBOOK, not per-class. `solana` having a plane does not make
 * `sol.svm-account` dispatchable: its harness does not exist, so a run of it
 * would come back with zero attempts and could only ever be `inconclusive`.
 */
export function dispatchablePlaybookIds(allIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of allIds) {
    for (const plane of PLANES.values()) {
      if (plane.harnesses.has(id)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/**
 * Every (class, playbook) pair a plane claims, flattened.
 *
 * The coverage test consumes this so a harness registered under the WRONG plane
 * — a `web.*` id in the Solana set, say — fails there instead of quietly making
 * the wrong workflow the one that runs.
 */
export function harnessPairs(): { cls: string; playbook: string }[] {
  const out: { cls: string; playbook: string }[] = [];
  for (const plane of PLANES.values()) {
    for (const id of plane.harnesses) out.push({ cls: plane.cls as string, playbook: id });
  }
  return out;
}
