/**
 * Ranking by EXPECTED VALUE, not by TVL.
 *
 * WHY TVL IS THE WRONG AXIS
 *
 * TVL is a fact about how much money a protocol holds. It is not a fact about
 * whether hunting it pays:
 *
 *   · a protocol with $14 B TVL and no disclosure programme pays nothing;
 *   · a protocol whose terms bar scanners pays nothing and costs a ban;
 *   · a protocol whose terms make unattended output ineligible pays nothing
 *     unless a human verifies, which is a different (and slower) pipeline;
 *   · a class the corpus has no precedent for is a class we have no evidence we
 *     can find, which is the "honest zero" rule in the corpus digest;
 *   · none of those facts is in the TVL number.
 *
 * So the ranking term is
 *
 *     EV = payout_cap × automation_allowed × coverage_gap × Σ(class_weight)
 *          ÷ expected_time_to_proof
 *
 * and every factor is either measured here or explicitly a placeholder. THE
 * PLACEHOLDER IS NAMED AS ONE — see {@link TIME_TO_PROOF_PLACEHOLDER} — because
 * a placeholder presented as a measurement is the exact failure that got invented
 * weights reverted in a previous run.
 *
 * WHAT IS *NOT* MEASURED AND WHY EACH ABSENCE IS SAFE
 *
 *   · `payout_cap_usd` is `null` on Cantina and Sherlock, whose APIs publish a
 *     prize POOL and not a per-finding cap. A `null` cap contributes 0 to EV, so
 *     those programmes sink. That is the conservative direction: a programme
 *     with an unmeasured ceiling ranks below one with a measured ceiling of the
 *     same plausible size, and an operator can see `payout_cap_measured: false`
 *     rather than being told a number.
 *   · `coverage_gap` reuses `has_programme`. A protocol with a programme is
 *     already being worked by the platform's other hunters, so its *marginal*
 *     value to a solo researcher is lower — that is the definition of the gap.
 *   · `Σ(class_weight)` comes from the shipped corpus digest, which carries an
 *     `n: 0, weight: 0.0, validatable: false` honest zero for unmeasured classes.
 *     An unmeasured class therefore contributes 0 instead of an invented 1.9.
 *
 * THE WARNING THAT MUST TRAVEL WITH EVERY RANKED ROW
 *
 * A ranked list is a LEAD LIST. Discovery is not authorization: a candidate at
 * the top of this list has no more permission to be probed than one at the
 * bottom. `RANKING_IS_NOT_AUTHORIZATION` is exported so the consumer can print
 * it beside the list instead of paraphrasing it.
 */

import type { AutomationVerdict } from './scope.js';

/** Printed beside every ranked list. Never paraphrased. */
export const RANKING_IS_NOT_AUTHORIZATION =
  'Ranked expected value is a LEAD, not a permission. Discovery is not authorization: ' +
  'nothing here may be probed until roeFromBrief() holds an authorization_ref from the ' +
  "target's own policy, and a protocol with no programme requires the target's own " +
  'disclosure terms to permit testing explicitly.';

/**
 * `expected_time_to_proof`, in HOURS, as a single placeholder constant.
 *
 * THIS IS NOT A MEASUREMENT. It is one number standing in for a distribution this
 * run did not collect. It is a constant across all candidates, so it cannot
 * change the ORDER of the ranking — only the scale of every score by the same
 * factor — which is what makes it safe to ship before Task 5 produces real
 * time-to-proof data. When it becomes measurable (per class, from the `proofs`
 * table's `started_at → finished_at` on `proven` rows), it must become a per-class
 * input, and this constant must be deleted rather than tuned.
 */
export const TIME_TO_PROOF_PLACEHOLDER_HOURS = 8;
export const TIME_TO_PROOF_IS_PLACEHOLDER = true;

/**
 * One economic candidate: what discovery knows about a protocol or programme,
 * joined with what the corpus knows about the classes worth hunting there.
 */
export interface EvCandidate {
  /** Stable key: the candidate's own id (protocol slug or programme id). */
  id: string;
  /** Display name, for the alert and the UI. */
  name: string;
  /**
   * Published maximum single payout in USD, or `null` when unmeasured.
   * `null` scores 0 and sets `payout_cap_measured: false`.
   */
  payout_cap_usd: number | null;
  /** The programme's automation verdict. `automation_allowed` is boolean-ish. */
  automation: Pick<AutomationVerdict, 'automation_allowed' | 'cls' | 'reason'>;
  /**
   * TRUE when no programme matches this target — the measured uncovered set.
   * This is a first-class field, not a derived join, so an alert and the UI can
   * rank and filter on it without re-running a one-off script.
   */
  has_programme: boolean;
  /** Per-class corpus weights for the classes a hunt here could find. */
  class_weights: Record<string, number>;
  /** TVL, kept for display ONLY. It is not a ranking input. */
  tvl_usd: number | null;
  /** True when at least one fund address survived the token filter. */
  has_fork_target: boolean;
}

export interface EvScore {
  id: string;
  name: string;
  /** The score itself. 0 means "this pays nothing as far as we can measure". */
  ev: number;
  /** Each factor, so the number is auditable instead of a black box. */
  factors: {
    payout_cap_usd: number;
    automation_allowed: 0 | 1;
    coverage_gap: number;
    class_weight_sum: number;
    expected_time_to_proof_hours: number;
  };
  /** False when the cap was `null` — the row still ranks, at 0. */
  payout_cap_measured: boolean;
  /** True while `expected_time_to_proof_hours` is the placeholder. */
  time_to_proof_is_placeholder: boolean;
  /** One line an operator can read to see WHY this scored what it scored. */
  why: string;
  /** A zero is not a small number, it is a refusal. Named so it cannot be ranked up. */
  zero_reason: EvZeroReason | null;
  /** Passed through so the consumer cannot lose them. */
  has_programme: boolean;
  automation_allowed: boolean;
  tvl_usd: number | null;
  has_fork_target: boolean;
}

export type EvZeroReason =
  | 'automation_prohibited'
  | 'automation_unknown'
  | 'no_payout_cap_measured'
  | 'no_measured_class_weight'
  | 'no_fork_target';

/**
 * The coverage gap term.
 *
 * A target with NO programme is the gap: nobody on a platform is being paid to
 * look at it. A target WITH a programme is crowded, and its marginal value is
 * lower. These two numbers are a ratio choice, not a measurement — the gap is
 * `1` and the crowded case is `0.25`, i.e. "four crowded programmes are worth one
 * uncovered protocol of the same economics". Stated as a constant with its
 * reasoning rather than buried as a magic number in the formula.
 */
export const COVERAGE_GAP_UNCOVERED = 1;
export const COVERAGE_GAP_COVERED = 0.25;

/**
 * Score one candidate.
 *
 * ORDER OF REFUSALS matters for the message, not for the number: every refusal
 * produces `ev: 0`, so a programme that forbids automation can never outrank one
 * that permits it, however large its TVL or payout cap.
 */
export function scoreCandidate(c: EvCandidate): EvScore {
  const payout = c.payout_cap_usd !== null && Number.isFinite(c.payout_cap_usd) && c.payout_cap_usd > 0 ? c.payout_cap_usd : 0;
  const payoutMeasured = c.payout_cap_usd !== null && Number.isFinite(c.payout_cap_usd) && c.payout_cap_usd > 0;
  const automation = c.automation.automation_allowed ? 1 : 0;
  const gap = c.has_programme ? COVERAGE_GAP_COVERED : COVERAGE_GAP_UNCOVERED;

  let weightSum = 0;
  let weightedClasses = 0;
  for (const w of Object.values(c.class_weights)) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) continue;
    weightSum += w;
    weightedClasses++;
  }

  const factors = {
    payout_cap_usd: payout,
    automation_allowed: automation as 0 | 1,
    coverage_gap: gap,
    class_weight_sum: weightSum,
    expected_time_to_proof_hours: TIME_TO_PROOF_PLACEHOLDER_HOURS,
  };

  const raw = (payout * automation * gap * weightSum) / TIME_TO_PROOF_PLACEHOLDER_HOURS;

  // Zero reasons, most-specific first: a programme that forbids automation is a
  // fact about permission, and reporting it as "no payout cap" would send an
  // operator to hunt for a number that does not matter.
  let zero: EvZeroReason | null = null;
  if (!c.automation.automation_allowed) {
    zero = c.automation.cls === 'prohibited' ? 'automation_prohibited' : 'automation_unknown';
  } else if (!payoutMeasured) {
    zero = 'no_payout_cap_measured';
  } else if (weightedClasses === 0) {
    zero = 'no_measured_class_weight';
  } else if (!c.has_fork_target) {
    zero = 'no_fork_target';
  }

  const ev = zero === null && Number.isFinite(raw) ? raw : 0;

  return {
    id: c.id,
    name: c.name,
    ev,
    factors,
    payout_cap_measured: payoutMeasured,
    time_to_proof_is_placeholder: TIME_TO_PROOF_IS_PLACEHOLDER,
    why: whyText(c, factors, zero, weightedClasses),
    zero_reason: zero,
    has_programme: c.has_programme,
    automation_allowed: c.automation.automation_allowed,
    tvl_usd: c.tvl_usd,
    has_fork_target: c.has_fork_target,
  };
}

function whyText(
  c: EvCandidate,
  f: EvScore['factors'],
  zero: EvZeroReason | null,
  weightedClasses: number,
): string {
  if (zero === 'automation_prohibited') {
    return `scores 0: the programme's terms prohibit automated testing (${c.automation.reason})`;
  }
  if (zero === 'automation_unknown') {
    return `scores 0: no affirmative permission on file (${c.automation.reason}); silence is not consent`;
  }
  if (zero === 'no_payout_cap_measured') {
    return 'scores 0: no published per-finding payout cap, so the ceiling is unmeasured rather than zero';
  }
  if (zero === 'no_measured_class_weight') {
    return 'scores 0: no class with a non-zero corpus weight — the corpus has no precedent for anything huntable here';
  }
  if (zero === 'no_fork_target') {
    return 'scores 0: no surviving fund address to fork (every adapter address is a token identity)';
  }
  const dollars = f.payout_cap_usd.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return (
    `$${dollars} cap × ${f.coverage_gap === COVERAGE_GAP_UNCOVERED ? 'uncovered (no programme)' : 'covered (programme exists)'} ` +
    `× Σweight ${f.class_weight_sum.toFixed(3)} over ${weightedClasses} class(es) ÷ ${f.expected_time_to_proof_hours}h (placeholder)`
  );
}

/**
 * Rank candidates, highest EV first.
 *
 * TIE ORDER IS PINNED, not whatever the sort happened to do: equal EV breaks on
 * `id` ascending, so two runs over the same input produce the same list and a
 * diff means something changed. A non-deterministic rank makes every downstream
 * alert fire twice or not at all.
 *
 * Zero-scored candidates are KEPT in the output by default. Dropping them would
 * hide `has_programme: false` rows and every automation refusal from the UI; the
 * caller can filter with {@link rankedForDispatch}.
 */
export function rankByExpectedValue(
  candidates: readonly EvCandidate[],
  options: { includeZero?: boolean } = {},
): EvScore[] {
  const includeZero = options.includeZero ?? true;
  const scored = candidates.map(scoreCandidate);
  const kept = includeZero ? scored : scored.filter((s) => s.ev > 0);
  return kept.sort((a, b) => b.ev - a.ev || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The subset a dispatch path may consider: positive EV AND automation allowed.
 *
 * Kept as its own function because "ranked" and "dispatchable" are different
 * questions, and a caller that conflates them would dispatch to a programme that
 * forbids automation the moment a zero slipped through a filter.
 */
export function rankedForDispatch(scores: readonly EvScore[]): EvScore[] {
  return scores.filter((s) => s.ev > 0 && s.automation_allowed);
}

/**
 * Sum of the corpus's per-class weights for the classes named on a playbook set.
 *
 * `weights` is the digest's `classes[*].weight`. A class absent from the digest
 * contributes nothing — the honest-zero rule, applied rather than restated.
 */
export function classWeightSum(
  playbookIds: readonly string[],
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of playbookIds) {
    const w = weights[id];
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) out[id] = w;
  }
  return out;
}
