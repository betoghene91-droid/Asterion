/**
 * The proof contract — what counts as a finding.
 *
 * This module is the whole reason the platform is defensible. A lead is not a
 * finding. A hypothesis is not a finding. A test that fails is not a finding.
 * Only a test that fails AND demonstrates the specific claimed effect counts.
 *
 * Three independent conditions, all required:
 *   1. REPRODUCED  the test fails on the pinned commit with a real assertion
 *   2. CAUSAL      it stops failing when the fix is applied (or the effect
 *                  disappears when the precondition is removed)
 *   3. IMPACTFUL   the observable delta matches the claim: value moved,
 *                  access gained, state corrupted — measured, not asserted
 *
 * Condition 2 is the one everybody skips. Without it you have a broken test,
 * not a vulnerability. It is why this produces reports that survive triage.
 */

export type Verdict = 'proven' | 'partial' | 'disproved' | 'inconclusive';

export interface PopRun {
  /** exit code of `forge test --match-test <name>` */
  exit_code: number;
  /** full stdout/stderr, capped */
  output: string;
  /** the assertion message forge printed, if any */
  failure_reason: string | null;
  /** gas used, so we know the test actually executed */
  gas?: number | null;
  /** how long it ran */
  duration_ms: number;
}

export interface ImpactClaim {
  kind: 'value_transfer' | 'unauthorized_access' | 'state_corruption' | 'denial' | 'other';
  /** What the attacker gains, in the test's own units. */
  description: string;
  /** Measured before/after numbers proving the claim. */
  measured: { before: string; after: string };
}

export interface ProofBundle {
  hypothesis_id: string;
  commit: string;
  test_name: string;
  /** Did the PoC test fail (i.e. the bug reproduced)? */
  reproduced: PopRun;
  /** Same test with the fix applied; must PASS for causality. */
  with_fix?: PopRun;
  /** Same test with the precondition removed; must PASS for causality. */
  without_precondition?: PopRun;
  /** The measured effect, provided by the PoC harness itself. */
  impact?: ImpactClaim;
}

export interface ProofResult {
  verdict: Verdict;
  confidence: 'confirmed' | 'firm' | 'tentative';
  reasons: string[];
  /** Only populated for proven. This is what a report may claim. */
  claim: string | null;
}

/** Patterns that mean the test broke for an unrelated reason. */
const INFRA_FAILURE = [
  /compiler run failed/i,
  /failed to compile/i,
  /error\[\d+\]/i,
  /no test match/i,
  /test not found/i,
  /could not compile/i,
  /stack too deep/i,
  /out of memory/i,
  /rpc error/i,
  /connection refused/i,
  /timeout/i,
  /missing artifact/i,
  /environment variable not found/i,
];

/** Patterns that mean the test executed and an assertion genuinely failed. */
const REAL_ASSERTION = [
  /\[FAIL[.:]\s*/i,
  /assertion failed/i,
  /panic: assertion/i,
  /EvmError: Revert/i,
  /revert: /i,
  /Error: call reverted/i,
];

export function looksLikeInfraFailure(output: string): boolean {
  return INFRA_FAILURE.some((rx) => rx.test(output));
}

export function sawRealAssertion(output: string): boolean {
  return REAL_ASSERTION.some((rx) => rx.test(output));
}

/**
 * Decide whether a bundle is a finding.
 *
 * Deliberately strict. A false 'proven' costs credibility that took months to
 * build; a false 'inconclusive' costs one evening. The asymmetry is the design.
 */
export function judge(b: ProofBundle): ProofResult {
  const reasons: string[] = [];

  // ── 1. did it even run ────────────────────────────────────────────────
  if (b.reproduced.exit_code === 0) {
    return {
      verdict: 'disproved',
      confidence: 'tentative',
      reasons: ['the PoC test passed on the target commit: the claimed bug is not present'],
      claim: null,
    };
  }

  if (looksLikeInfraFailure(b.reproduced.output)) {
    return {
      verdict: 'inconclusive',
      confidence: 'tentative',
      reasons: [
        'the test failed to build or could not reach its environment; this says nothing about the target',
      ],
      claim: null,
    };
  }

  if (!sawRealAssertion(b.reproduced.output)) {
    return {
      verdict: 'inconclusive',
      confidence: 'tentative',
      reasons: ['non-zero exit with no assertion failure; cannot attribute the failure to the claimed effect'],
      claim: null,
    };
  }
  reasons.push('the PoC test fails on the pinned commit with a real assertion');

  // ── 2. causality ──────────────────────────────────────────────────────
  const hasFix = b.with_fix !== undefined;
  const hasPrecond = b.without_precondition !== undefined;

  if (hasFix) {
    if (b.with_fix!.exit_code === 0) {
      reasons.push('the same test passes once the fix is applied, so the defect is causal not incidental');
    } else if (looksLikeInfraFailure(b.with_fix!.output)) {
      reasons.push('the with-fix run could not be evaluated; causality unconfirmed');
      return { verdict: 'partial', confidence: 'tentative', reasons, claim: null };
    } else {
      reasons.push('the test still fails with the fix applied, so the claimed cause is not the cause');
      return { verdict: 'partial', confidence: 'tentative', reasons, claim: null };
    }
  } else if (hasPrecond) {
    if (b.without_precondition!.exit_code === 0) {
      reasons.push('removing the precondition makes the test pass, confirming the mechanism');
    } else {
      reasons.push('the precondition-removed run still fails; the mechanism is not established');
      return { verdict: 'partial', confidence: 'tentative', reasons, claim: null };
    }
  } else {
    // No counterfactual at all: this can never be more than partial.
    return {
      verdict: 'partial',
      confidence: 'tentative',
      reasons: [...reasons, 'no counterfactual run was supplied, so causality is unproven'],
      claim: null,
    };
  }

  // ── 3. impact ─────────────────────────────────────────────────────────
  if (!b.impact) {
    return {
      verdict: 'partial',
      confidence: 'firm',
      reasons: [...reasons, 'the bug reproduces and is causal, but no impact was measured'],
      claim: null,
    };
  }

  const measured = b.impact.measured;
  if (!measured.before.trim() || !measured.after.trim()) {
    return {
      verdict: 'partial',
      confidence: 'firm',
      reasons: [...reasons, 'impact claim has empty before/after values'],
      claim: null,
    };
  }
  if (measured.before === measured.after) {
    return {
      verdict: 'partial',
      confidence: 'firm',
      reasons: [...reasons, 'before and after are identical: no measurable effect'],
      claim: null,
    };
  }
  reasons.push(`measured effect: ${measured.before} -> ${measured.after}`);

  return {
    verdict: 'proven',
    confidence: 'confirmed',
    reasons,
    claim: b.impact.description.trim(),
  };
}

/** Human-readable one-liner for Telegram. */
export function renderVerdict(r: ProofResult): string {
  const mark = { proven: '\u2713', partial: '~', disproved: '\u2717', inconclusive: '?' }[r.verdict];
  return `${mark} ${r.verdict.toUpperCase()}  ${r.reasons[0] ?? ''}`;
}
