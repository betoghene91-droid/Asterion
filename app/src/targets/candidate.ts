/**
 * The candidate record — one row per lead, with the two facts that were missing.
 *
 * WHY THIS FILE EXISTS
 *
 * Discovery already produced targets and programmes. What it could not say was:
 *
 *   1. **`has_programme`** — is there a bounty programme that matches this
 *      target? The measured uncovered set is ~151 code-huntable protocols with no
 *      programme match (order-of-magnitude: the join was verified at 9/10 on a
 *      sample, so treat the count as a direction and not a census). That number
 *      lived in a one-off script, which meant the alert path and the UI could not
 *      rank or filter on it at all. It is a field here.
 *
 *   2. **`fund_addresses`** — where the money is, as opposed to the `address` the
 *      feed publishes. See `funding.ts`: for roughly half the feed that `address`
 *      is the protocol's own token, so a fork of it forks a token contract.
 *      `fork_target` is `null` whenever no address survives, and `null` is what
 *      stops a token being offered as a fork target.
 *
 * THE COMMENT THIS FILE MUST CARRY AT THE POINT OF RANKING
 *
 * Discovery is not authorization. A candidate on this list has been *found*, not
 * *permitted*. `RANKING_IS_NOT_AUTHORIZATION` is re-exported from `ev.ts` and
 * printed beside every ranked list; the same sentence belongs in the comment
 * where `rankByExpectedValue` is called, so it travels with the code.
 *
 * WHAT THIS FILE DOES NOT DO: it does not probe anything, and it does not decide
 * permission. It composes what discovery measured into a record another layer can
 * rank and gate.
 */

import type { Candidate } from './types.js';
import type { Funding } from './funding.js';
import type { AutomationVerdict } from './scope.js';
import { scoreCandidate, type EvScore, type EvCandidate } from './ev.js';

/**
 * One discovery candidate, as it lands in D1.
 *
 * A CANDIDATE, NOT A PERMISSION. Three independent gates must all allow before
 * anything is probed: `has_programme` is only informational, `automation_allowed`
 * gates dispatch, and `roeFromBrief` gates the actual engagement. This record
 * carries the first two and cannot satisfy the third.
 */
export interface CandidateRecord {
  /** Stable key: `evm:<chain>:<addr-lower>` or `svm:<cluster>:<addr>`, from `candidateKey`. */
  id: string;
  family: 'evm' | 'svm';
  /** Chain id, or `null` on Solana. Never an invented id. */
  chain_id: number | null;
  address: string;
  name: string;
  /** `protocol` or `token`, as the source published it. */
  kind: string;
  category: string | null;
  tvl_usd: number | null;
  /**
   * TRUE when a programme exists that matches this target.
   *
   * First-class because both the alert path and the UI rank on it, and because
   * "no programme" is the interesting case: it is the uncovered set, where the
   * only lawful route is the target's own disclosure terms.
   */
  has_programme: boolean;
  /** The matched programme's id, or `null`. */
  programme_id: string | null;
  /**
   * The matched programme's published per-finding payout cap, or `null`.
   *
   * `null` means UNMEASURED, not zero. Cantina and Sherlock publish a prize pool
   * and not a cap, so their programmes land here as `null` and score 0 — the
   * conservative direction, and visible to an operator via
   * `payout_cap_measured`. Never defaulted to a number.
   */
  payout_cap_usd: number | null;
  /**
   * The programme's automation verdict, or `null` when there is no programme.
   *
   * `null` is NOT `allowed`. A target with no programme has no affirmative
   * permission from any platform, so `automation_allowed` is false and
   * `automation_reason` says `no-programme`.
   */
  automation: AutomationVerdict | null;
  automation_allowed: boolean;
  automation_reason: string;
  /**
   * Addresses that are not token identities. EMPTY IS A REAL ANSWER and must be
   * rendered as "no fund address" — never as a fallback to `address`.
   */
  fund_addresses: string[];
  /**
   * The address a fork may target, or `null`. `null` is the guard that keeps a
   * token contract from being forked; a consumer must branch on it, not default
   * to `address`.
   */
  fork_target: string | null;
  /** Why funding resolved the way it did; `derived`, `all-filtered`, etc. */
  fund_state: string;
  /** True when the feed's own `address` is a listed token (the Aave V3 case). */
  address_is_token: boolean;
  /** Class weights the corpus measured for the classes huntable here. */
  class_weights: Record<string, number>;
  /** `unixepoch()` when the row was written. */
  updated_at: number;
}

/** A programme match as the candidate layer needs it. */
export interface ProgrammeMatch {
  id: string;
  payout_cap_usd: number | null;
  automation: AutomationVerdict;
}

/**
 * Compose one candidate record.
 *
 * `funding` may be `null` when the adapter queue has not reached this protocol;
 * the record then says `pending` and `fork_target: null` rather than falling back
 * to `address`. That fallback is the exact bug this file exists to prevent, so it
 * is absent from the code rather than guarded by a branch a refactor could drop.
 */
export function candidateRecord(
  candidate: Candidate,
  options: {
    tvl_usd?: number | null;
    category?: string | null;
    funding: Funding | null;
    programme: ProgrammeMatch | null;
    class_weights: Record<string, number>;
    now: number;
  },
): CandidateRecord {
  const funding = options.funding;
  const programme = options.programme;

  const automationAllowed = programme !== null && programme.automation.automation_allowed;
  const automationReason = programme !== null ? programme.automation.reason : 'no-programme';

  return {
    id: candidateKeyOf(candidate),
    family: candidate.family,
    chain_id: candidate.family === 'evm' ? candidate.chain_id : null,
    address: candidate.address,
    name: candidate.name,
    kind: candidate.kind,
    category: options.category ?? candidate.category ?? null,
    tvl_usd: options.tvl_usd ?? candidate.tvl_usd ?? null,
    has_programme: programme !== null,
    programme_id: programme?.id ?? null,
    payout_cap_usd: programme?.payout_cap_usd ?? null,
    automation: programme?.automation ?? null,
    automation_allowed: automationAllowed,
    automation_reason: automationReason,
    fund_addresses: funding?.fund_addresses ?? [],
    fork_target: funding?.fork_target ?? null,
    fund_state: funding?.state ?? 'pending',
    address_is_token: funding?.address_is_token ?? false,
    class_weights: options.class_weights,
    updated_at: options.now,
  };
}

/** The dedupe key, restated here so this module does not import the whole union. */
function candidateKeyOf(c: Candidate): string {
  if (c.family === 'evm') return `evm:${c.chain_id}:${c.address.toLowerCase()}`;
  return `svm:${c.cluster}:${c.address}`;
}

/**
 * Project a stored candidate into the EV scorer's input.
 *
 * THE JOIN IS DELIBERATE AND ORDERED: the scorer never sees `address`, so it
 * cannot accidentally rank a token contract. It sees `has_fork_target` and
 * nothing else about funding.
 */
export function evInputFrom(record: CandidateRecord): EvCandidate {
  return {
    id: record.id,
    name: record.name,
    // Passed straight through: a cap only exists when a programme published one,
    // and `null` is what makes the scorer report `no_payout_cap_measured`.
    payout_cap_usd: record.payout_cap_usd,
    automation: record.automation ?? {
      automation_allowed: false,
      cls: 'unknown',
      reason: 'no-text',
    },
    has_programme: record.has_programme,
    class_weights: record.class_weights,
    tvl_usd: record.tvl_usd,
    has_fork_target: record.fork_target !== null,
  };
}

/** Score one stored record without re-deriving anything. */
export function scoreRecord(record: CandidateRecord): EvScore {
  return scoreCandidate(evInputFrom(record));
}

/** True when this record may be *considered* for dispatch. Not permission. */
export function dispatchable(record: CandidateRecord): boolean {
  return record.fork_target !== null && record.automation_allowed;
}
