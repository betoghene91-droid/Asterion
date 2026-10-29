/**
 * Methodology dispatch — getting the 25 expert packs out of the card and into
 * the work.
 *
 * WHY THIS FILE EXISTS
 *
 * `skills.ts` (25 packs), `skills-embed.ts` (the Worker-safe copy) and
 * `methodology.ts` (`deriveMethodology` + `methodologyEnvelope`, total and
 * capped at one pack) were all complete and all green. The only production
 * consumer was `index.ts:skillLines()`, which renders three questions onto a
 * Telegram playbook card. So the operator could READ the methodology, at the
 * moment they were browsing playbooks, and then the hunt ran without it.
 *
 * Meanwhile the corpus priors DO reach compute: `plan.mjs` imports `rank()`
 * from `hunt.ts`, which calls `priorFor()`. That asymmetry is the whole bug:
 * precedent influences which playbook is attempted first, and methodology
 * influences nothing.
 *
 * WHAT "REACHES THE WORK" MEANS HERE — AND WHAT IT DOES NOT
 *
 * This needs stating plainly, because it is easy to overclaim:
 *
 *   · The proof engine is DETERMINISTIC. `plan.mjs` scans Solidity with regex
 *     and `poc.ts` emits Solidity from templates. There is no model in compute,
 *     so there is no free-text hunter prompt for a skill block to steer.
 *   · Therefore methodology cannot change the byte content of a generated PoC.
 *     Claiming otherwise would be a lie about this codebase.
 *
 * What methodology CAN do, and what this module implements, is travel with the
 * dispatch instead of dying in the UI:
 *
 *   1. It is attached to the `prove.yml` dispatch as its own declared input, so
 *      the pack that was supposed to govern the hunt is recorded on the run, on
 *      the runner's disk, and in the ledger — auditable after the fact, which is
 *      what "the hunt was informed by X" has to mean when the executor is
 *      deterministic. `dispatch.ts` passes it; `methodologyForBrief()` builds it.
 *
 * NOT CLAIMED: that `briefLead()` in hunt.ts consumes it. `briefLead` is the one
 * function in the codebase that genuinely builds a prose "hunter briefing" with
 * precedent attached, and it would be the natural second consumer — but it has
 * ZERO production importers today (only tests/proof.test.mjs imports it). Wiring
 * methodology into `briefLead` therefore would not make methodology reach a hunt;
 * it would add a second beautifully-tested dead end, which is the exact failure
 * mode this whole workstream exists to fix. It is left untouched, and the gap is
 * recorded in PATCHES.md as the honest next step rather than papered over.
 *
 * The honest summary for PATCHES.md: this is the wiring that makes methodology
 * an input to the hunt rather than decoration on a card. It does not, and cannot
 * without an executor rewrite, alter synthesized PoC text.
 *
 * SELECTION IS GATED, NOT JUST RESOLVED
 *
 * `deriveMethodology()` picks a pack for `brief.cls`. That is the right pick for
 * a brief whose targets can actually be addressed by that class. It is noise —
 * and a false audit trail — for a brief whose class came from a playbook hint
 * while every target is something that class cannot touch. A Solidity pack
 * attached to a web engagement is worse than no pack: it records that the wrong
 * methodology governed the run.
 *
 * So `methodologyForBrief()` adds one gate on top of `deriveMethodology()`: at
 * least one target must be ADDRESSABLE by the pack's class. `supportsClass()`
 * below is that predicate, and it is deliberately explicit rather than a second
 * general classifier — see the note on the repo-URL case, which is the one that
 * makes the naive "classify each target URL" approach wrong.
 */

import type { Brief } from './intake.js';
import { extractTargets } from './intake.js';
import type { Cls } from './playbooks.js';
import { deriveMethodology, methodologyEnvelope, type MethodologyPick } from './methodology.js';
import { MAX_PROMPT_CHARS, selectSkills, type SkillCls } from './skills.js';

/**
 * Name of the `prove.yml` input that carries the block.
 *
 * This string is a CONTRACT with `.github/workflows/prove.yml`. GitHub rejects a
 * workflow_dispatch containing any input the workflow does not declare, with
 * HTTP 422 — so shipping the TypeScript without the workflow change turns every
 * dispatch into a hard failure. Both halves must land together; PATCHES.md names
 * this as a joint integration step for exactly that reason.
 */
export const METHODOLOGY_INPUT = 'methodology';

/**
 * Hard ceiling on what may be sent to the workflow.
 *
 * `renderSkillForPrompt()` already caps at MAX_PROMPT_CHARS (4000). This second
 * cap exists because the value travels through a JSON API request body; keeping
 * it at the same number means the two layers cannot disagree about what "the
 * cap" is.
 */
export const MAX_METHODOLOGY_INPUT = MAX_PROMPT_CHARS;

export interface MethodologyForDispatch {
  /** Ready to send. Empty string means "send nothing at all". */
  block: string;
  skill_id: string | null;
  /** Why this block, why it was capped, or why there is none. Never empty. */
  reason: string;
  /** Targets that justified the pick. Empty when nothing was injected. */
  matched_targets: string[];
}

const KNOWN_CLASSES: Cls[] = ['web2', 'solidity', 'infra'];

/** A deployed contract instance. Only Solidity packs can act on one. */
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** A source repository URL — the audit artifact for a code-level hunt. */
const REPO_URL = /^https?:\/\/[^\s]*?(github\.com|gitlab\.com|bitbucket\.org)\//i;

/** A bare http(s) endpoint. */
const HTTP_URL = /^https?:\/\//i;

/** A bare hostname, optionally with a port or a trailing path. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The one case that defeats per-target classification, and why this predicate
 * is written by hand instead of reusing `inferClass()`:
 *
 * A Solidity engagement's most common target is a git URL
 * (`https://github.com/acme/vault`). `inferClass(['https://github.com/acme/vault'],
 * same)` scores `http` for web2 and `vault` for solidity — a tie broken by
 * declaration order in favour of web2. So a naive "classify each target and
 * require a match" gate would refuse the Solidity pack for the single most
 * ordinary Solidity brief in the product.
 *
 * The repo URL is genuinely ambiguous: it is a source tree, and a source tree can
 * be audited as a contract or as a web app. So it supports BOTH, and the brief's
 * own `cls` decides between them. What the gate is for is the case that is NOT
 * ambiguous: a web endpoint (or a 0x address) cannot be acted on by the other
 * class's packs at all.
 *
 *   solidity — an address, a repo to audit, or an explicit contract/evm signal
 *   web2     — an http endpoint, a repo to audit, or a bare host
 *   infra    — a bare host, or an http endpoint that is NOT a source repo
 *
 * The infra exclusion matters and was caught by a test rather than by review: a
 * repo URL is technically an http URL, but no DNS/subdomain/takeover/TLS pack has
 * anything to do with a GitHub repository. Accepting it made an infra brief over
 * a repo look like it had a target, which would attach infra methodology to work
 * that never touches DNS. Mirrors the obvious shape semantics rather than the URI
 * scheme.
 */
export function supportsClass(target: string, cls: Cls): boolean {
  const t = target.trim();
  if (!t) return false;

  const isAddress = ADDRESS.test(t);
  const isRepo = REPO_URL.test(t);
  const isHttp = HTTP_URL.test(t);
  // A hostname is only a hostname if it is not already covered by a URL form.
  const hostOnly = !isHttp && HOSTNAME.test(t.replace(/:\d+$/, '').replace(/\/.*$/, ''));
  const lower = t.toLowerCase();

  switch (cls) {
    case 'solidity':
      // An address needs a fork; a repo needs a checkout; a bare host is not a
      // contract hunt. An explicit contract signal in the target is accepted
      // because operators do paste `0x…`-adjacent descriptions.
      return (
        isAddress ||
        isRepo ||
        /\b(solidity|contract|\.sol\b|defi|evm|mainnet)/i.test(lower)
      );
    case 'web2':
      return isHttp || hostOnly;
    case 'infra':
      // A host name, or an http endpoint that is not a source repository and not
      // an address. Infra packs act on the NAME (DNS, TLS, takeover), so a repo
      // is out of scope for them.
      return hostOnly || (isHttp && !isRepo && !isAddress);
    default:
      return false;
  }
}

/** Map a skill's class onto the brief taxonomy. */
function briefClassOf(skillCls: SkillCls): Cls {
  return skillCls;
}

/**
 * Which targets justify a pack of class `cls`? Empty array means "none do".
 * Exported so the refusal is directly testable, not just inferred from a block.
 */
export function targetsSupporting(targets: string[], cls: Cls): string[] {
  return (targets ?? []).filter((t) => typeof t === 'string' && supportsClass(t, cls));
}

export interface InclusionCheck {
  ok: boolean;
  /**
   * Machine-readable code. Stable, so a test or a ledger query can assert on the
   * exact refusal rather than on prose that may be reworded later.
   */
  code:
    | 'ok'
    | 'unmapped-class'
    | 'no-targets'
    | 'no-pack'
    | 'no-target-of-class'
    | 'class-mismatch'
    | 'skill-not-resolvable'
    | 'envelope-empty'
    | 'has-target-of-class';
  detail: string;
  matched_targets: string[];
}

/**
 * The gate, isolated from rendering so its rule can be tested on its own.
 *
 * `packCls` is passed in rather than read from the skill so the check stays a
 * pure function of (brief, pack class) and cannot silently depend on cache state.
 */
export function checkInclusion(brief: Brief, packCls: SkillCls): InclusionCheck {
  const cls = brief?.cls;
  if (!cls || !KNOWN_CLASSES.includes(cls)) {
    return {
      ok: false,
      code: 'unmapped-class',
      detail: `class "${cls ?? 'missing'}" is not one of ${KNOWN_CLASSES.join('/')}`,
      matched_targets: [],
    };
  }

  const targets = Array.isArray(brief.targets) ? brief.targets.filter((t) => typeof t === 'string') : [];
  if (!targets.length) {
    // Nothing has been named, so "which methodology applies" has no answer. A
    // pack here would be a class-level guess presented as a match.
    return {
      ok: false,
      code: 'no-targets',
      detail: 'the brief names no target, so no methodology can be said to apply',
      matched_targets: [],
    };
  }

  if (packCls !== cls) {
    // Only reachable if a playbook id drags in a cross-class pack. Report it
    // instead of attaching a pack from the wrong discipline.
    return {
      ok: false,
      code: 'class-mismatch',
      detail: `pack class ${packCls} does not match brief class ${cls}`,
      matched_targets: [],
    };
  }

  const matched = targetsSupporting(targets, cls);
  if (!matched.length) {
    const shapes = [...new Set(targets.map((t) => shapeOf(t)))];
    return {
      ok: false,
      code: 'no-target-of-class',
      detail:
        `no ${cls} target in the brief; the ${targets.length} target(s) look like ` +
        `${shapes.join(', ')}, so a ${cls} pack would be noise`,
      matched_targets: [],
    };
  }

  return {
    ok: true,
    code: 'has-target-of-class',
    detail: `${matched.length}/${targets.length} target(s) support ${cls}`,
    matched_targets: matched,
  };
}

/** A short, non-secret description of a target's shape, for refusal messages. */
export function shapeOf(target: string): string {
  const t = target.trim();
  if (ADDRESS.test(t)) return 'a 0x address';
  if (REPO_URL.test(t)) return 'a repo URL';
  if (HTTP_URL.test(t)) return 'a web URL';
  if (HOSTNAME.test(t.replace(/:\d+$/, ''))) return 'a hostname';
  return 'unrecognised';
}

/**
 * Resolve the methodology for a brief, and refuse it when the brief has no
 * target the pack's class could act on.
 *
 * Returns an empty block (never throws) for every refusal, because this runs on
 * the dispatch path: a methodology problem must never stop a hunt that policy
 * already allowed.
 */
export function methodologyForBrief(brief: Brief): MethodologyForDispatch {
  const none = (reason: string, matched: string[] = []): MethodologyForDispatch => ({
    block: '',
    skill_id: null,
    reason,
    matched_targets: matched,
  });

  try {
    if (!brief || !KNOWN_CLASSES.includes(brief.cls)) {
      return none(`unmapped-class:${brief?.cls ?? 'missing'}`);
    }

    const pick: MethodologyPick = deriveMethodology(brief);
    if (!pick.block || !pick.skill_id) return none(pick.reason);

    // Resolve the pack once; `deriveMethodology` only ever returns ids it found,
    // so a miss here means the catalog changed under us.
    const skill = selectSkills({ playbook: pick.skill_id, limit: 1 }).find((s) => s.id === pick.skill_id);
    if (!skill) return none(`skill-not-resolvable:${pick.skill_id}`);

    const gate = checkInclusion(brief, briefClassOf(skill.cls));
    if (!gate.ok) {
      if (gate.code === 'no-target-of-class') {
        // The headline case this gate exists for.
        return none(`no-target-of-class: ${gate.detail}`);
      }
      return none(`${gate.code}: ${gate.detail}`);
    }

    const envelope = methodologyEnvelope(pick);
    if (!envelope) return none(`envelope-empty:${pick.skill_id}`, gate.matched_targets);

    const block =
      envelope.length <= MAX_METHODOLOGY_INPUT
        ? envelope
        : `${envelope.slice(0, MAX_METHODOLOGY_INPUT - 40)}\n…[methodology capped at ${MAX_METHODOLOGY_INPUT} chars for dispatch]`;

    return {
      block,
      skill_id: pick.skill_id,
      reason: `${pick.reason} · ${gate.detail}`,
      matched_targets: gate.matched_targets,
    };
  } catch (err) {
    // Total by construction: the dispatch path must not fail over a skill pack.
    const msg = err instanceof Error ? err.message : String(err);
    return none(`methodology-error:${msg.slice(0, 120)}`);
  }
}

/**
 * The per-lead briefing addition: the pack for this class, gated on the targets
 * the lead's hunt actually has.
 *
 * Exported for tests and for a future caller, but deliberately NOT wired into
 * `briefLead()` — see the note at the top of this file. It exists so that when
 * `briefLead` does get a producer, the gated block is already the only safe way
 * to obtain one.
 */
export function methodologyBlockForTargets(cls: Cls, targets: string[]): string {
  const pseudo = {
    program_id: '',
    title: '',
    cls,
    targets,
    playbooks: [],
    max_mutability: 'read',
    time_box_minutes: 0,
    authorization_ref: '',
    stop_condition: '',
    out_of_scope: [],
    notes: '',
  } as unknown as Brief;
  return methodologyForBrief(pseudo).block;
}

/**
 * Attach the block to a dispatch input map.
 *
 * Absent, not empty, when there is nothing to send. `prove.yml` treats an empty
 * string as "no methodology" and would write a zero-byte file; omitting the key
 * keeps "there was none" distinguishable from "there was an empty one".
 */
export function withMethodology<T extends Record<string, unknown>>(
  inputs: T,
  brief: Brief,
): { inputs: T & { [METHODOLOGY_INPUT]?: string }; pick: MethodologyForDispatch } {
  const pick = methodologyForBrief(brief);
  if (!pick.block) return { inputs: { ...inputs }, pick };
  return { inputs: { ...inputs, [METHODOLOGY_INPUT]: pick.block }, pick };
}

/**
 * One line for the ledger: which pack governed this hunt, or why none did.
 * Records the skill id so a later reviewer never has to guess.
 */
export function describeMethodology(pick: MethodologyForDispatch): string {
  if (pick.skill_id && pick.block) {
    return `methodology ${pick.skill_id} attached (${pick.block.length} chars; ${pick.reason})`;
  }
  return `no methodology attached (${pick.reason})`;
}

/** Re-exported so a test can assert the ceilings have not drifted apart. */
export { MAX_PROMPT_CHARS };

/** Extract targets from prose, for callers that hold raw text instead of a Brief. */
export { extractTargets };
