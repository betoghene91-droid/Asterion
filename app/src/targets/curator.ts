/**
 * Risk Curator — a class, its shape, and an explicit refusal to dispatch.
 *
 * WHY THIS IS A CLASS AT ALL
 *
 * A curator (Steakhouse, Sentora, Gauntlet and their peers) allocates other
 * people's capital across vaults and strategies. The three named in the discovery
 * research hold multi-billion-dollar books. They are structurally
 * under-bountied relative to the value they custody, which makes them
 * *economically* interesting in exactly the way a TVL ranking is supposed to
 * find — and that is where the resemblance to a contract target ends.
 *
 * THE FAILURE MODE IS NOT THE USUAL ONE
 *
 * Every class in `playbooks.ts` bottoms out in the same question: can I make a
 * contract do something its author did not intend, and prove it with a
 * counterfactual? A curator's failure mode is different in kind:
 *
 *   · **Misallocation.** The measured harm is a depositor earning less than the
 *     disclosed mandate, or bearing risk the mandate said was excluded — a
 *     *portfolio* outcome over weeks, not a state transition in one transaction.
 *   · The "vulnerability" may be a parameter inside a policy, a cap that exists
 *     but is set wrong, an oracle the mandate says is not used, or a strategy
 *     that is legal in isolation and wrong in combination.
 *   · There is frequently **no attacker** and no victim transaction. The
 *     counterfactual prover — `proven` = reproduced ∧ causal ∧ measured — has
 *     nothing to flip, because the bug is "the allocation was worse than
 *     promised", which is a claim about a distribution.
 *
 * So the moat does not transfer. A curator finding needs a *performance and
 * mandate* proof, not a *state transition* proof, and this codebase has no
 * prover for that.
 *
 * WHY THERE IS NO PLAYBOOK, AND WHY THAT IS THE DELIVERABLE
 *
 * The tempting move is to ship a skeleton playbook so `PLAYBOOKS` has an entry
 * and the class "exists". That would be worse than shipping nothing: a playbook
 * is the bot's only route to an Authorize button, so a hollow one would let a
 * curator brief dispatch a Foundry job at a vault address, run for minutes and
 * return `inconclusive` — which is precisely the dead-dispatch failure the svm
 * packs caused, and it would look like a legitimate run.
 *
 * What real methodology needs, and what is missing today:
 *
 *   1. **Mandate ingestion.** The claim to test is "the book does what its
 *      disclosed policy says". That needs the policy (caps, eligible venues,
 *      oracle set, liquidity floor) as structured data per curator, sourced from
 *      their own disclosure page. Nothing in this repo ingests it.
 *   2. **A position timeline.** Misallocation is proven over time: an allocation
 *      that breached a cap for N days, a venue that was ineligible when entered.
 *      That needs per-block position reconstruction across venues — the trading
 *      desk's `desk_marks` is the closest analogue and it tracks a price, not a
 *      mandate.
 *   3. **A distribution-level counterfactual.** "Under the disclosed mandate the
 *      depositor would have earned X; the actual book earned Y" is a backtest, not
 *      a test. It needs a reproducible accounting model — an EVM fork cannot
 *      express it.
 *
 * Until those three exist there is no playbook, and the correct behaviour is to
 * refuse by name.
 */

import type { Cls } from '../playbooks.js';

/** The class name, spelled once so a refusal message cannot drift from it. */
export const RISK_CURATOR_CLASS = 'risk.curator' as const;

/**
 * The `Cls` a curator brief would carry.
 *
 * `'solidity'` is deliberately NOT reused. A curator's book is EVM contracts, but
 * classifying it `solidity` would make `dispatch.ts` derive Foundry inputs and
 * queue `prove.yml` against a vault — the exact silent no-op this module exists to
 * prevent. `'infra'` is wrong too: the target is not a host.
 *
 * NOTE FOR THE OWNER OF `playbooks.ts`: this constant must NOT be added to `Cls`
 * from here. Widening the union changes `intake.ts`'s `CLASS_WORDS`, which is a
 * parallel edit; until that lands, a curator brief arrives as `solidity` and is
 * caught by {@link refuseCuratorDispatch} before derivation. See
 * `docs/discovery-limits.md` for the one-line wire-in.
 */
export const RISK_CURATOR_PROPOSED_CLS = 'curator' as const;

/** Why a curator brief cannot be dispatched. Stable, quotable, testable. */
export const NO_PLAYBOOK_YET_REASON =
  'no playbook yet: Risk Curator has no prover in this tree. Its failure mode is ' +
  'misallocation against a disclosed mandate, which needs mandate ingestion, a ' +
  'position timeline and a distribution-level counterfactual. A Foundry fork test ' +
  'can express none of those, so dispatch would run for minutes and return ' +
  'inconclusive by construction. Dispatch refuses by name until that methodology exists.';

/** One methodology hook: what a real playbook for this class would have to do. */
export interface MethodologyHook {
  /** Short id. */
  id: string;
  /** What it produces that the prover needs. */
  yields: string;
  /**
   * True when the data this hook needs is already in the tree. Every hook here is
   * `false` today; writing `true` for any of them would be the invented-measurement
   * failure this repo has already reverted once.
   */
  available: boolean;
  /** What is missing, concretely. */
  missing: string;
}

/**
 * The shape of the class, as hooks rather than prose.
 *
 * These are the three steps a curator hunt would have to complete before a
 * `proven` verdict is even definable. They are listed so the next person starts
 * from the right problem instead of copying `sol.*` playbook structure.
 */
export const CURATOR_METHODOLOGY_HOOKS: readonly MethodologyHook[] = [
  {
    id: 'mandate.structured',
    yields: 'per-curator policy as data: deposit caps, eligible venues, oracle set, liquidity floor, fee schedule',
    available: false,
    missing:
      'no ingester for curator disclosure pages; `parseScope` reads bounty platforms, which do not carry curator mandates',
  },
  {
    id: 'positions.timeline',
    yields: 'per-block position reconstruction across venues, so a cap breach has a duration',
    available: false,
    missing:
      'no vault share-price / allocation history source; the desk tracks a token mid-price, not a mandate over time',
  },
  {
    id: 'counterfactual.distribution',
    yields: 'the return the disclosed mandate implies, versus the return the book produced, reproducibly',
    available: false,
    missing:
      '`judge.mjs` compares a state transition before/after; there is no accounting model to run twice',
  },
] as const;

/** A brief as the refusal needs to see it. Narrow on purpose. */
export interface CuratorBriefish {
  cls?: Cls | string;
  playbooks?: readonly string[];
  targets?: readonly string[];
  notes?: string;
}

/**
 * True when a brief is asking for a curator hunt.
 *
 * Matched on the class, on an explicit `risk.curator` playbook id, or on the word
 * in free text — because the intake compiler puts sloppy text into `notes` and a
 * curator brief will arrive that way long before `Cls` is widened.
 *
 * The free-text match is deliberately narrow (`curator`, `vault allocator`,
 * `allocation mandate`). A bare `vault` is NOT a match: `vault` is the single most
 * ambiguous word in DeFi and matching it would refuse legitimate `sol.*` briefs.
 */
export function isCuratorBrief(brief: CuratorBriefish): boolean {
  if (brief.cls === RISK_CURATOR_PROPOSED_CLS) return true;
  for (const pb of brief.playbooks ?? []) {
    if (pb === RISK_CURATOR_CLASS || pb.startsWith('risk.curator.')) return true;
  }
  const text = `${brief.notes ?? ''} ${(brief.targets ?? []).join(' ')}`.toLowerCase();
  return /\b(risk curator|curator|vault allocator|allocation mandate)\b/.test(text);
}

export interface CuratorRefusal {
  ok: false;
  code: 'no_playbook';
  /** Names the class and the reason. Never generic. */
  message: string;
  /** The hooks that are missing, so the refusal is actionable rather than a wall. */
  missing_hooks: string[];
}

/**
 * Refuse a curator brief BY NAME.
 *
 * Returns `null` when the brief is not a curator brief at all, so a caller can
 * write `if (refuseCuratorDispatch(brief)) return …` without a second predicate
 * that could drift from this one.
 */
export function refuseCuratorDispatch(brief: CuratorBriefish): CuratorRefusal | null {
  if (!isCuratorBrief(brief)) return null;
  return {
    ok: false,
    code: 'no_playbook',
    message: `refusing dispatch for class ${RISK_CURATOR_CLASS}: ${NO_PLAYBOOK_YET_REASON}`,
    missing_hooks: CURATOR_METHODOLOGY_HOOKS.filter((h) => !h.available).map((h) => h.id),
  };
}

/**
 * `false` while every hook is unavailable.
 *
 * A single boolean the dispatch path can read, so "the class exists" and "the
 * class can run" are never the same question. It is derived from the hooks rather
 * than hardcoded, so filling one hook does not leave a stale `false` behind — and
 * it is `every`, not `some`, because a curator proof needs all three.
 */
export function curatorClassIsDispatchable(): boolean {
  return CURATOR_METHODOLOGY_HOOKS.every((h) => h.available);
}
