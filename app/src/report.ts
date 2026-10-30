/**
 * Report writer — turn one recorded `proven` bundle into markdown a human can
 * submit without rewriting it.
 *
 * ── Why the `claims NOT verified` section is mandatory ──────────────────────
 *
 * Because an unattested finding is not merely weaker, it is ineligible. At
 * least one major bug-bounty programme's published terms state that a finding
 * which has not been human-verified is ineligible, and that the submission fee
 * is not refunded when it is rejected on those grounds; this project's own
 * programme-shortlist research (recorded 2026-10) found eight programmes where
 * unattended output is ineligible on some axis. The failure mode therefore is
 * not "the report scores badly" — it is "the submitter pays to be told no".
 *
 * So this module cannot emit a report without that section, and the section is
 * never allowed to be vacuously empty: every claim the bundle does not attest
 * becomes a line in it, and when nothing is outstanding the report says
 * exactly which artefacts it checked and why no residual claim remains. A
 * silently-empty disclaimer would be worse than no disclaimer, because it would
 * read as a clean bill of health that nobody verified.
 *
 * ── The other two invariants ───────────────────────────────────────────────
 *
 * AFFECTED ASSETS COME FROM THE LEDGER. `assets.value` rows only. Prose that
 * happens to contain an address or a hostname never contributes an affected
 * asset; it is *compared* against the ledger and, on a mismatch, raised as an
 * unverified claim. The reason is that prose is where a stale copy lives: a
 * brief written before the programme moved the contract, a claim description
 * naming the address we forked, a note pasted from the ticket. The ledger is
 * the only place that was validated against the programme's scope.
 *
 * NO INVENTED NUMBERS. This module writes the artefact a human puts their name
 * on. When a value is absent it becomes a line in `claims NOT verified`, never a
 * plausible-looking default. Severity is never chosen here at all — it comes
 * from `cvss.ts`, which derives it from recorded facts and refuses when it
 * cannot (see that file's header).
 *
 * The module is pure: no network, no clock, no filesystem, no randomness. Same
 * input, byte-identical output — which is what makes the golden-file test able
 * to pin the shape, and what lets a triager re-derive every number.
 */

import {
  deriveCvss,
  classifyPreconditions,
  formatScore,
  reachabilityOfAssets,
  isScorableImpact,
  type CvssResult,
  type DerivationInputs,
} from './cvss.js';

// ── Input shapes: copies of what the pipeline already produces ──────────────
//
// These mirror `app/src/judge.mjs` (verdicts.json), `app/src/plan.mjs`
// (plan.json) and the D1 tables in `app/schema.sql`. They are structural
// copies rather than imports because judge.mjs and plan.mjs are Node CLI
// entrypoints, not modules the Worker or a build step can import without
// dragging `node:fs` into the graph. A test pins each shape against the real
// producer's output so a drift is caught rather than silently tolerated.

/** One entry of `verdicts.json → verdicts[]`. See judge.mjs `adjudicatePlan`. */
export interface BundleVerdict {
  test_name: string;
  playbook: string;
  file?: string | null;
  line?: number | null;
  claim?: { kind?: string; description?: string } | null;
  verdict: 'proven' | 'partial' | 'disproved' | 'inconclusive';
  confidence: 'confirmed' | 'firm' | 'tentative';
  reasons?: string[];
  proven_claim?: string | null;
  exit_code?: number | null;
  counterfactual?: { mechanism: string; test_name: string } | null;
  /** Present only when the harness printed a usable IMPACT_* triple. */
  impact?: { kind: string; before: string; after: string } | null;
}

/** `verdicts.json` as written by judge.mjs. */
export interface ProofSummary {
  hunt_id?: string;
  contract?: string | null;
  commit?: string | null;
  corpus_rows?: number | null;
  corpus_error?: string | null;
  leads_found?: number;
  attempts?: number;
  proven?: number;
  partial?: number;
  disproved?: number;
  inconclusive?: number;
  unprovable?: number;
  verdicts?: BundleVerdict[];
  /** Per-attempt statements of what the run could not establish. Never a blanket excuse. */
  limitations?: string[];
}

/** One entry of `plan.json → attempts[]`. See plan.mjs. */
export interface PlanAttempt {
  test_name: string;
  control_name?: string;
  nocond_name?: string;
  playbook: string;
  file?: string | null;
  line?: number | null;
  claim?: { kind?: string; description?: string } | null;
  /** The preconditions the synthesizer declared, verbatim. */
  requires?: string[];
  /** The generated Solidity, verbatim. This is what the report reproduces. */
  solidity?: string;
  counterfactual?: {
    mechanism: string;
    test_name: string;
    patch?: { file: string; rationale: string; edits?: { find: string; replace: string }[] };
    why_not_with_fix?: string;
  } | null;
}

/** `plan.json` as written by plan.mjs. */
export interface ProofPlan {
  contract?: string | null;
  commit?: string | null;
  fork_block?: number | null;
  attempts?: PlanAttempt[];
}

// ── Ledger shapes: the `assets`, `engagements`, `approvals`, `proofs` tables ──

/** A row of `assets` (schema.sql). `value` is the exact string; never re-derived. */
export interface LedgerAsset {
  id: string;
  kind: string;
  value: string;
  in_scope: boolean | number;
  chain_id?: number | null;
}

/** A row of `engagements` (schema.sql). */
export interface LedgerEngagement {
  id: string;
  program_id: string;
  title: string;
  /** The exact policy sentence relied on. */
  authorization_ref: string;
  window_start: number;
  window_end: number;
  max_mutability: 'read' | 'simulate' | 'mutate' | 'destructive';
  status?: string;
}

/** A row of `approvals` (schema.sql). */
export interface LedgerApproval {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  reason?: string | null;
  requested_at?: number | null;
  decided_at?: number | null;
  operator?: string | null;
}

/** A row of `proofs` (schema.sql) — what the queue reads. */
export interface LedgerProof {
  test_name: string;
  playbook: string;
  verdict: 'proven' | 'partial' | 'disproved' | 'inconclusive';
  confidence: 'confirmed' | 'firm' | 'tentative';
  claim?: string | null;
}

/** Everything the writer is allowed to read. Note: no `notes`, no `brief`. */
export interface ReportInput {
  engagement: LedgerEngagement;
  /** Every candidate asset row for the engagement. Filtered to in-scope here. */
  assets: readonly LedgerAsset[];
  approvals?: readonly LedgerApproval[];
  /** `proofs` rows for this hunt, if the caller has them. Used for a cross-check. */
  ledger_proofs?: readonly LedgerProof[];
  bundle: ProofSummary;
  /** `plan.json`. Optional, because the artifact bundle is the caller's choice. */
  plan?: ProofPlan | null;
  /** Overrides the derived title. Left unset in normal use. */
  title?: string;
  /** Overrides the derived remediation. Left unset in normal use. */
  remediation?: string;
  /** Unix seconds. Omitted ⇒ the report states that no generation time was recorded. */
  generated_at?: number;
  /** Where a remediation hook may be reached, if the programme supplies one. */
  disclosure_url?: string;
}

/** The CVSS record stored beside the measured delta. See header of cvss.ts. */
export interface CvssRecord {
  /** `null` when the derivation refused; `refusal` then says why. */
  vector: string | null;
  score: number | null;
  score_text: string | null;
  /** Metric-by-metric provenance, so a triager can re-derive the number. */
  basis: Record<string, { value: string; from: string; attested: boolean }>;
  unattested: string[];
  refusal: string | null;
}

/** Everything the writer produces, so a caller can store the record as well. */
export interface ReportRecord {
  engagement_id: string;
  program_id: string;
  hunt_id: string | null;
  test_name: string;
  playbook: string;
  commit: string | null;
  /** The one-line impact, as claimed. */
  impact: string | null;
  /** The measured delta, exactly as the harness printed it. */
  measured: { before: string; after: string } | null;
  /** `before -> after`, the form the assignment requires. */
  delta: string | null;
  /** EXACT asset values, from the ledger only. */
  affected_assets: { id: string; kind: string; value: string; chain_id: number | null }[];
  /** Sorted, de-duplicated. Never empty: see the header. */
  claims_not_verified: string[];
  cvss: CvssRecord;
  /** True only when a human could send this as-is. */
  submittable: boolean;
}

export interface ReportOutput {
  ok: true;
  markdown: string;
  record: ReportRecord;
}

export interface ReportError {
  ok: false;
  reason: string;
  /** Field names the caller must supply before a report can exist. */
  missing: string[];
  /**
   * Present when the refusal is about the proof rather than about missing
   * inputs, so a caller can record *why* nothing was written.
   */
  verdict?: string;
}

export type ReportResult = ReportOutput | ReportError;

// ── Small pure helpers ──────────────────────────────────────────────────────

/** Collapse any whitespace run to one space. Used for one-line fields only. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Backtick-safe code span: the fence grows until it is longer than any run inside. */
function code(text: string): string {
  const longest = longestRun(text, '`');
  const fence = '`'.repeat(Math.max(1, longest + 1));
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Longest run of `ch` in `text`. */
function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    if (c === ch) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * A fenced block whose fence is longer than any backtick run in the body, so
 * verbatim content can never terminate its own fence.
 */
function fenced(body: string, lang: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  const tail = body.endsWith('\n') ? '' : '\n';
  return `${fence}${lang}\n${body}${tail}${fence}`;
}

/** Unix seconds → `YYYY-MM-DDTHH:MM:SSZ`. Deterministic; no locale, no TZ. */
export function isoUtc(seconds: number): string {
  const ms = Math.trunc(seconds) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'invalid-timestamp';
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Integer-string subtraction in BigInt; null when either side is not an integer. */
export function integerDelta(before: string, after: string): string | null {
  const ok = /^-?\d+$/;
  if (!ok.test(before.trim()) || !ok.test(after.trim())) return null;
  try {
    const d = BigInt(after.trim()) - BigInt(before.trim());
    return d < 0n ? `-${(-d).toString()}` : d.toString();
  } catch {
    return null;
  }
}

/** Syntax-highlighting hint for a generated test, from its language. */
function fenceLang(source: string): string {
  // The generator emits `// SPDX-License-Identifier:` above the pragma, so the
  // pragma is never on line 1. Matching anywhere in the first few hundred bytes
  // is enough and cannot misfire on the small set of languages poc.ts emits.
  const head = source.slice(0, 400);
  if (/pragma\s+solidity/.test(head)) return 'solidity';
  if (/pragma\s+rust/.test(head) || /use\s+anchor_lang/.test(head)) return 'rust';
  return 'text';
}

/** Every 0x-address-shaped token in a string, lowercased and de-duplicated. */
export function addressesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)) out.add((m[0] ?? '').toLowerCase());
  return [...out].sort();
}

/** Every hostname-shaped token in a string, lowercased and de-duplicated. */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi)) {
    out.add((m[0] ?? '').toLowerCase());
  }
  return [...out].sort();
}

function inScope(a: LedgerAsset): boolean {
  return a.in_scope === true || a.in_scope === 1;
}

// ── The primary function ───────────────────────────────────────────────────

/**
 * Build the report for one `proven` verdict.
 *
 * Refusal is a first-class outcome, not an exception: a bundle with no
 * `proven` verdict, a bundle whose proven verdict has no measured delta, or an
 * engagement with no in-scope ledger asset all return `{ ok: false }` with a
 * reason. The proof contract in `proof.ts` says only `proven` may be reported;
 * this function is the last place that can violate it, so it does not.
 */
export function buildReport(input: ReportInput): ReportResult {
  if (!input || !input.bundle) {
    return { ok: false, reason: 'no proof bundle was supplied', missing: ['bundle'] };
  }
  if (!input.engagement) {
    return { ok: false, reason: 'no engagement was supplied', missing: ['engagement'] };
  }

  const verdicts = Array.isArray(input.bundle.verdicts) ? input.bundle.verdicts : [];
  const proven = verdicts.filter((v) => v && v.verdict === 'proven');

  // Only a `proven` verdict may be written up. This is the same rule the proof
  // contract enforces upstream; enforcing it again here means a report cannot
  // exist for a partial finding even if a caller passes the wrong file.
  if (proven.length === 0) {
    return {
      ok: false,
      reason:
        'the bundle records no proven verdict; proof.ts allows only `proven` to be ' +
        'reported, so there is nothing a human may submit',
      missing: [],
      verdict: 'none_proven',
    };
  }

  const primary = proven[0] as BundleVerdict;

  // The proof engine's own rule: a proven verdict carries a claim (non-null only
  // when reproduced + causal + measured all held) and a measured delta.
  const impactText = typeof primary.proven_claim === 'string' ? oneLine(primary.proven_claim) : '';
  if (!impactText) {
    return {
      ok: false,
      reason: `verdict ${primary.test_name} is marked proven but carries no claim string`,
      missing: ['bundle.verdicts[].proven_claim'],
      verdict: 'proven_without_claim',
    };
  }
  const measured = primary.impact ? { before: primary.impact.before, after: primary.impact.after } : null;
  if (!measured || !measured.before.trim() || !measured.after.trim()) {
    // judge() cannot produce this combination, so reaching it means the file was
    // edited by hand. Refusing is the only honest response.
    return {
      ok: false,
      reason: `verdict ${primary.test_name} is marked proven but records no measured before/after`,
      missing: ['bundle.verdicts[].impact'],
      verdict: 'proven_without_measurement',
    };
  }

  // ── Affected assets: the ledger, and only the ledger ──────────────────────
  const ledger = Array.isArray(input.assets) ? input.assets : [];
  const scoped = ledger.filter((a) => a && inScope(a) && typeof a.value === 'string' && a.value.trim());
  if (scoped.length === 0) {
    return {
      ok: false,
      reason:
        `the ledger holds no in-scope asset for engagement ${input.engagement.id}; an ` +
        'affected-asset list cannot be taken from prose, so no submittable report exists',
      missing: ['assets'],
      verdict: 'no_ledger_asset',
    };
  }

  const plan = input.plan ?? null;
  const planAttempt = findPlanAttempt(plan, primary.test_name);
  const commit = typeof input.bundle.commit === 'string' && input.bundle.commit ? input.bundle.commit : null;
  const contract =
    (typeof input.bundle.contract === 'string' && input.bundle.contract) ||
    (plan && typeof plan.contract === 'string' && plan.contract) ||
    null;

  const claims: string[] = [];
  const addClaim = (s: string) => {
    const t = oneLine(s);
    if (t && !claims.includes(t)) claims.push(t);
  };

  // ── Claims derived from what the bundle does NOT attest ───────────────────

  // 1. Counterfactual. `proven` requires one, so its absence would mean the file
  //    disagrees with the judge. Name the mechanism when it is present, because
  //    with_fix and without_precondition are different strengths of evidence.
  const cf = primary.counterfactual ?? planAttempt?.counterfactual ?? null;
  if (!cf) {
    addClaim(
      'The verdict records no counterfactual run. judge() requires one for `proven`, so ' +
        'the causality condition cannot be re-checked from this bundle.',
    );
  } else if (cf.mechanism === 'without_precondition') {
    addClaim(
      `Causality was established by removing a precondition (${cf.test_name}), not by applying a ` +
        'fix. That shows the precondition was necessary; it does not show that any code change ' +
        'removes the defect.',
    );
  }

  // 2. The fixture control. judge.mjs never reads `controls/`, so a proven
  //    verdict can exist whose paired control was never executed or never
  //    passed. That is a real, currently-unattested claim and must be stated.
  const controlRan = controlWasRecorded(planAttempt);
  if (!controlRan) {
    addClaim(
      'The paired control test was not recorded as passing in this bundle. The proof engine does ' +
        'not require it for `proven`, so the fixture\'s own soundness is unverified here.',
    );
  }

  // 3. Placeholder harness. `poc.ts` writes CHANGE_ME where the real function
  //    signature belongs; a proven run whose harness still contains it exercised
  //    something other than the named entrypoint.
  const source = typeof planAttempt?.solidity === 'string' ? planAttempt.solidity : '';
  if (!source) {
    addClaim(
      'The generated test source is not present in this bundle, so the reproduction cannot be ' +
        'reproduced verbatim and the exact code that ran is unverified.',
    );
  } else if (source.includes('CHANGE_ME')) {
    addClaim(
      'The generated harness still contains a CHANGE_ME placeholder, so the function signature the ' +
        'test actually calls was not confirmed against the target source.',
    );
  }

  // 4. Fork versus production. The engine reproduces on a pinned fork; that is a
  //    measurement, not a statement about the live deployment.
  const forkBlock =
    plan && typeof plan.fork_block === 'number' && Number.isFinite(plan.fork_block)
      ? plan.fork_block
      : null;
  addClaim(
    forkBlock && forkBlock > 0
      ? `The effect was measured on a local fork pinned at block ${forkBlock}, not against the ` +
          'live deployment. Whether the deployed bytecode is the same and the state still holds ' +
          'was not verified.'
      : 'The effect was measured on a local fork. Whether the deployed contract is byte-identical ' +
          'and whether the state still holds were not verified.',
  );

  // 5. Commit pinning. Without it, "which tree was tested" is unanswerable.
  if (!commit) {
    addClaim(
      'No commit SHA is recorded for the tested tree, so the reproduction is not pinned to a ' +
        'revision the maintainer can check out.',
    );
  }

  // 6. Prose that names an asset the ledger does not contain. This is the guard
  //    that keeps a stale address out of the document: the affected-asset list is
  //    ledger-only, and any disagreement becomes a visible warning here.
  const proseAddresses = addressesIn(`${impactText} ${primary.claim?.description ?? ''} ${primary.test_name}`);
  const proseHosts = hostsIn(impactText);
  const ledgerValues = new Set(scoped.map((a) => a.value.trim().toLowerCase()));
  for (const addr of proseAddresses) {
    if (!ledgerValues.has(addr)) {
      addClaim(
        `The claim text names ${addr}, which is not an in-scope asset in the engagement ledger. The ` +
          'affected-asset list above deliberately excludes it.',
      );
    }
  }
  for (const host of proseHosts) {
    if (!ledgerValues.has(host)) {
      addClaim(
        `The claim text names ${host}, which is not an in-scope asset in the engagement ledger. The ` +
          'affected-asset list above deliberately excludes it.',
      );
    }
  }

  // 7. Additional proven verdicts in the same bundle are not described here.
  if (proven.length > 1) {
    const others = proven.slice(1).map((v) => v.test_name).join(', ');
    addClaim(
      `This bundle contains ${proven.length} proven verdicts; only ${primary.test_name} is described. ` +
        `Not covered here: ${others}.`,
    );
  }

  // 8. Ledger disagreement. If the caller supplied `proofs` rows and this verdict
  //    is not among them, the audit trail and the report disagree.
  if (Array.isArray(input.ledger_proofs) && input.ledger_proofs.length > 0) {
    const row = input.ledger_proofs.find((p) => p && p.test_name === primary.test_name);
    if (!row) {
      addClaim(
        `The ledger holds no proofs row for ${primary.test_name}, so this verdict exists only in the ` +
          'CI artifact and is not yet part of the engagement audit trail.',
      );
    } else if (row.verdict !== 'proven') {
      addClaim(`The ledger records ${primary.test_name} as "${row.verdict}", not "proven".`);
    }
  }

  // 9. Authorization. A submission without a named permission is a legal risk,
  //    not a formatting detail.
  if (!input.engagement.authorization_ref || !input.engagement.authorization_ref.trim()) {
    addClaim(
      'The engagement records no authorization reference, so there is no policy sentence on file ' +
        'permitting this test.',
    );
  }
  for (const a of input.approvals ?? []) {
    if (!a) continue;
    if (a.status !== 'approved') {
      addClaim(`Approval ${a.id} is "${a.status}", so that action was never authorized.`);
    }
  }

  // 10. CVSS. A refused derivation is a claim the report cannot make.
  const reachability = reachabilityOfAssets(scoped.map((a) => a.kind));
  const impactKind = primary.impact?.kind ?? primary.claim?.kind ?? '';
  const derivation = buildCvssRecord({
    mutability: input.engagement.max_mutability,
    impact: impactKind,
    reachability,
    preconditions: Array.isArray(planAttempt?.requires) ? (planAttempt.requires as string[]) : [],
  });
  if (!derivation.vector) {
    addClaim(
      `No CVSS base vector was derived: ${derivation.refusal ?? 'the derivation refused'}. ` +
        'Severity is therefore unstated rather than estimated.',
    );
  }
  for (const key of derivation.unattested) {
    const b = derivation.basis[key];
    addClaim(`CVSS ${key} is not attested by the recorded facts: ${b ? b.from : 'no basis recorded'}.`);
  }

  // 11. Carry the judge's own per-attempt limitations through, verbatim. They are
  //     already honest statements about this specific run; dropping them would
  //     lose information the proof engine went to the trouble of recording.
  for (const l of input.bundle.limitations ?? []) {
    if (typeof l === 'string' && l.trim()) {
      addClaim(`Recorded by the proof engine: ${l}`);
    }
  }

  // ── Remediation ───────────────────────────────────────────────────────────
  // Read the patch off the plan attempt, not off `cf`: the verdicts.json copy of
  // the counterfactual records only {mechanism, test_name}, while plan.json
  // carries the derived edits. Taking it from the union would need a cast and
  // would sometimes silently be the shallow form.
  const patch = planAttempt?.counterfactual?.patch;
  // A with_fix mechanism with no patch in the bundle is a gap between the two
  // artefacts, not a reason to stay silent: the counterfactual says a fix existed
  // and this bundle cannot show it.
  if (cf?.mechanism === 'with_fix' && !(patch && typeof patch.file === 'string')) {
    addClaim(
      'The counterfactual mechanism is with_fix, but no patch is recorded in this bundle, so the ' +
        'change that made the reproduction pass cannot be shown.',
    );
  }
  const remediation =
    (input.remediation && input.remediation.trim()
      ? input.remediation.trim()
      : remediationFrom({ patch, mechanism: cf?.mechanism ?? null, attempt: planAttempt })) ?? '';

  const title =
    (input.title && input.title.trim()) ||
    (contract ? `${contract}: ${impactText}` : impactText);

  const delta = `${measured.before} -> ${measured.after}`;
  const numeric = integerDelta(measured.before, measured.after);

  const notVerified = finaliseClaims(claims);

  const record: ReportRecord = {
    engagement_id: input.engagement.id,
    program_id: input.engagement.program_id,
    hunt_id: typeof input.bundle.hunt_id === 'string' && input.bundle.hunt_id ? input.bundle.hunt_id : null,
    test_name: primary.test_name,
    playbook: primary.playbook,
    commit,
    impact: impactText,
    measured,
    delta,
    affected_assets: scoped.map((a) => ({
      id: a.id,
      kind: a.kind,
      value: a.value.trim(),
      chain_id: typeof a.chain_id === 'number' ? a.chain_id : null,
    })),
    claims_not_verified: notVerified,
    cvss: derivation,
    submittable: !notVerified.some((c) => isBlocking(c)),
  };

  const markdown = render({
    input,
    primary,
    title,
    impactText,
    scoped,
    contract,
    commit,
    plan,
    planAttempt,
    source,
    measured,
    delta,
    numeric,
    remediation,
    notVerified,
    derivation,
    forkBlock,
    provenCount: proven.length,
  });

  return { ok: true, markdown, record };
}

/** Find the plan attempt that produced `testName`, ignoring malformed entries. */
function findPlanAttempt(plan: ProofPlan | null, testName: string): PlanAttempt | null {
  if (!plan || !Array.isArray(plan.attempts)) return null;
  for (const a of plan.attempts) if (a && a.test_name === testName) return a;
  return null;
}

/**
 * Whether the bundle shows the paired control actually passing.
 *
 * Deliberately conservative: the recorded `verdicts.json` does not carry the
 * control at all, so this returns false unless the plan names one AND the
 * caller-supplied summary proves its exit code was 0. There is no exit code in
 * the summary today, so in practice this is false and the report says so. That
 * is the honest answer; the alternative is to assume the control passed.
 */
function controlWasRecorded(attempt: PlanAttempt | null): boolean {
  if (!attempt) return false;
  if (typeof attempt.control_name !== 'string' || !attempt.control_name) return false;
  // A control name alone proves the control was GENERATED, not that it ran and
  // passed. Since the judge never reads controls/, this stays false.
  return false;
}

/**
 * Deterministic remediation text.
 *
 * The strongest form is the patch that was measured to remove the defect: if a
 * `with_fix` counterfactual passed, that edit is not advice, it is the result of
 * an experiment. Otherwise the removed precondition names the condition to
 * guard, and failing both, the caller must supply one (which leaves the
 * `not verified` list to say the remediation is unproven).
 */
function remediationFrom(args: {
  patch: { file: string; rationale: string; edits?: { find: string; replace: string }[] } | undefined;
  mechanism: string | null;
  attempt: PlanAttempt | null;
}): string | null {
  const { patch, mechanism, attempt } = args;

  if (patch && typeof patch === 'object' && typeof patch.file === 'string') {
    const lines: string[] = [];
    lines.push(
      `Apply the minimal change below, which was applied to \`${patch.file}\` and observed to make the ` +
        'reproduction pass:',
    );
    if (patch.rationale) lines.push('', patch.rationale);
    const edits = Array.isArray(patch.edits) ? patch.edits : [];
    if (edits.length > 0) {
      lines.push('');
      for (const e of edits) {
        if (!e || typeof e.find !== 'string') continue;
        lines.push('Replace:', '', fenced(e.find, ''), '', 'with:', '', fenced(String(e.replace ?? ''), ''));
      }
    }
    return lines.join('\n');
  }

  if (mechanism === 'with_fix') {
    // The caller said the fix was applied and measured, but the patch is not in
    // this bundle. Do not fall through to "no remediation": say which artefact
    // is missing, so the submitter knows what to attach.
    return [
      'The bundle records a `with_fix` counterfactual but does not carry the patch that was applied, ' +
        'so the exact code change is not stated here. Attach the patched diff from the run or re-generate ' +
        'the bundle with `plan.json` included.',
    ].join('\n');
  }

  if (mechanism === 'without_precondition' && attempt && Array.isArray(attempt.requires)) {
    // Environment requirements (FORK_RPC, TARGET, forge) are the lab, not the
    // defect. Listing them as "the condition to guard" would tell the maintainer
    // to fix the harness. Only the target-side conditions are actionable, so
    // they are separated out by the same classifier the CVSS derivation uses.
    const cls = classifyPreconditions(attempt.requires as string[]);
    const actionable = [...cls.target_condition, ...cls.privilege, ...cls.victim, ...cls.boundary];
    const lab = cls.environment;

    if (actionable.length > 0) {
      const lines = [
        'The reproduction was shown to depend on the following target-side condition(s), so the fix ' +
          'must remove or guard the enabling condition rather than the symptom:',
        '',
        ...actionable.map((r) => `- ${oneLine(r)}`),
      ];
      if (lab.length > 0) {
        lines.push(
          '',
          `Lab requirements recorded by the harness (${lab.map((r) => oneLine(r)).join(', ')}) are ` +
            'how the test runs, not a property of the target, and are not part of the fix.',
        );
      }
      lines.push(
        '',
        'No patch was derived for this class, so the exact code change is not established by this ' +
          'measurement and must be described by the maintainer.',
      );
      return lines.join('\n');
    }
  }

  return null;
}

/**
 * Claims that make a report NOT submittable, as opposed to merely disclosed.
 *
 * These are the cases where submitting would misrepresent scope or proof rather
 * than under-describe it: an out-of-scope asset in the ledger, a missing
 * authorization reference, or a ledger row that disagrees with the verdict.
 * Everything else is disclosure — sendable, with a caveat the triager can read.
 */
function isBlocking(claim: string): boolean {
  return (
    /no authorization reference/i.test(claim) ||
    /not "proven"/i.test(claim) ||
    /never authorized/i.test(claim)
  );
}

/**
 * Guarantee the section is never silently empty.
 *
 * When every check above passed, the report states which artefacts it examined
 * and why nothing remains — a sentence a submitter can stand behind, because it
 * names what was checked instead of asserting "all good".
 */
function finaliseClaims(claims: string[]): string[] {
  const deduped: string[] = [];
  for (const c of claims) {
    const t = oneLine(c);
    if (t && !deduped.includes(t)) deduped.push(t);
  }
  if (deduped.length > 0) return deduped;
  return [
    'No residual unverified claim was found. This statement is limited to the checks this writer ' +
      'performs: the verdict is `proven` with a non-empty measured delta; a counterfactual run is ' +
      'recorded; the generated test is present verbatim and contains no CHANGE_ME placeholder; a ' +
      'commit SHA is recorded; every affected asset resolves to an in-scope ledger row; no prose ' +
      'in the claim names an address or host outside that list; and the CVSS derivation has no ' +
      'unattested metric. It does not attest to anything outside those checks.',
  ];
}

/** Build the stored CVSS record, including the refusal text when it refuses. */
function buildCvssRecord(inputs: {
  mutability: 'read' | 'simulate' | 'mutate' | 'destructive';
  impact: string;
  reachability: ReturnType<typeof reachabilityOfAssets>;
  preconditions: string[];
}): CvssRecord {
  const empty: CvssRecord = {
    vector: null,
    score: null,
    score_text: null,
    basis: {},
    unattested: [],
    refusal: null,
  };

  if (!isScorableImpact(inputs.impact)) {
    return {
      ...empty,
      refusal:
        `impact kind ${JSON.stringify(inputs.impact)} is not one of ` +
        'value_transfer|unauthorized_access|state_corruption|denial, so C/I/A would have to be invented',
    };
  }
  if (!inputs.reachability) {
    return {
      ...empty,
      refusal:
        'at least one affected asset has a kind outside the ledger vocabulary ' +
        '(domain|host|url|api|cidr|chain_address|repo|apk|ipa), so reachability is unknown',
    };
  }

  const derivation = deriveCvss({
    mutability: inputs.mutability,
    impact: inputs.impact,
    reachability: inputs.reachability,
    preconditions: inputs.preconditions,
  } as DerivationInputs);

  if (!derivation.ok) {
    return { ...empty, refusal: derivation.reason };
  }

  const basis: CvssRecord['basis'] = {};
  for (const k of Object.keys(derivation.basis) as (keyof typeof derivation.basis)[]) {
    const b = derivation.basis[k];
    basis[k] = { value: b.value, from: b.from, attested: b.attested };
  }

  return {
    vector: derivation.vector,
    score: derivation.score,
    score_text: derivation.score_text,
    basis,
    unattested: [...derivation.unattested],
    refusal: null,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

interface RenderArgs {
  input: ReportInput;
  primary: BundleVerdict;
  title: string;
  impactText: string;
  scoped: LedgerAsset[];
  contract: string | null;
  commit: string | null;
  plan: ProofPlan | null;
  planAttempt: PlanAttempt | null;
  source: string;
  measured: { before: string; after: string };
  delta: string;
  numeric: string | null;
  remediation: string;
  notVerified: string[];
  derivation: CvssRecord;
  forkBlock: number | null;
  provenCount: number;
}

function render(a: RenderArgs): string {
  const out: string[] = [];

  // Title. `#` level 1 because a bounty report is its own document.
  out.push(`# ${a.title}`, '');

  out.push(`## Impact`, '');
  out.push(a.impactText, '');

  // A compact provenance block, so a triager knows what they are reading before
  // the detail. Everything in it is a recorded value or explicitly absent.
  out.push('| Field | Value |', '| --- | --- |');
  out.push(`| Engagement | ${code(a.input.engagement.id)} |`);
  out.push(`| Programme | ${code(a.input.engagement.program_id)} |`);
  out.push(`| Hunt | ${a.input.bundle.hunt_id ? code(String(a.input.bundle.hunt_id)) : '_not recorded_'} |`);
  out.push(`| Playbook | ${code(a.primary.playbook)} |`);
  out.push(`| Test | ${code(a.primary.test_name)} |`);
  out.push(`| Commit | ${a.commit ? code(a.commit) : '_not recorded_'} |`);
  out.push(`| Contract | ${a.contract ? code(a.contract) : '_not recorded_'} |`);
  out.push(
    `| Fork block | ${a.forkBlock && a.forkBlock > 0 ? code(String(a.forkBlock)) : '_not recorded_'} |`,
  );
  const cvssCell = a.derivation.vector
    ? `${code(a.derivation.vector)} (${a.derivation.score_text})`
    : '_not derived — see the CVSS section_';
  out.push(`| CVSS 3.1 base | ${cvssCell} |`);
  out.push(
    `| Authorized under | ${a.input.engagement.authorization_ref ? code(a.input.engagement.authorization_ref) : '_not on file_'} |`,
  );
  out.push(
    `| Engagement window | ${isoUtc(a.input.engagement.window_start)} → ${isoUtc(a.input.engagement.window_end)} |`,
  );
  out.push(
    `| Report generated | ${
      typeof a.input.generated_at === 'number'
        ? isoUtc(a.input.generated_at)
        : '_no generation time recorded (deterministic output)_'
    } |`,
  );
  out.push('');

  // Affected assets — ledger rows only. This is the section a triager checks
  // against their own scope document, so nothing here may come from prose.
  out.push('## Affected assets', '');
  out.push(
    'Taken from the engagement ledger (`assets` rows with `in_scope = 1`). Values are reproduced ' +
      'exactly as recorded; nothing in this list is read from narrative text.',
    '',
  );
  out.push('| Asset ID | Kind | Value | Chain |', '| --- | --- | --- | --- |');
  for (const asset of a.scoped) {
    const chain = typeof asset.chain_id === 'number' ? String(asset.chain_id) : '—';
    out.push(`| ${code(asset.id)} | ${code(asset.kind)} | ${code(asset.value.trim())} | ${chain} |`);
  }
  out.push('');

  // Preconditions — the harness's own declaration, verbatim.
  const requires = Array.isArray(a.planAttempt?.requires)
    ? (a.planAttempt?.requires ?? []).filter((r): r is string => typeof r === 'string' && !!r.trim())
    : [];
  out.push('## Preconditions', '');
  if (requires.length > 0) {
    out.push('Declared by the generated harness, verbatim:', '');
    for (const r of requires) out.push(`- ${oneLine(r)}`);
  } else {
    out.push(
      'The harness declared no preconditions in this bundle, so the conditions under which the ' +
        'effect occurs are not enumerated here.',
    );
  }
  out.push('');

  // Reproduction — the generated test, verbatim.
  out.push('## Reproduction', '');
  if (a.source) {
    const where = a.planAttempt?.file
      ? ` The lead that produced it is \`${a.planAttempt.file}${a.planAttempt.line ? `:${a.planAttempt.line}` : ''}\`.`
      : '';
    out.push(
      `The test below is the exact source the proof engine generated and executed. It is reproduced ` +
        `verbatim; only the surrounding fence was added.${where}`,
      '',
    );
    out.push(fenced(a.source, fenceLang(a.source)), '');
    out.push('Run it against a fork of the pinned commit:', '');
    out.push(
      fenced(
        `forge test --match-test '^${a.primary.test_name}$' -vvv`,
        'bash',
      ),
      '',
    );
    out.push(
      'The harness attaches to the deployed instance through the `TARGET` environment variable, so ' +
        '`TARGET` must be set to the affected address above and `FORK_RPC` to an archive RPC for ' +
        'the pinned block.',
      '',
    );
    if (a.planAttempt?.control_name) {
      out.push(
        `The paired control is \`${a.planAttempt.control_name}\`: same fixture with the attack step ` +
          'removed, and it must pass on its own.',
        '',
      );
    }
  } else {
    out.push(
      'The generated test source is not included in this bundle, so it cannot be reproduced here ' +
        'verbatim. See `claims NOT verified` below.',
      '',
    );
  }

  // Measured delta.
  out.push('## Measured delta', '');
  out.push('Measured by the harness itself, printed as `IMPACT_BEFORE` / `IMPACT_AFTER` on the run:', '');
  out.push(fenced(a.delta, 'text'), '');
  out.push('| | Value |', '| --- | --- |');
  out.push(`| Before | ${code(a.measured.before)} |`);
  out.push(`| After | ${code(a.measured.after)} |`);
  if (a.numeric !== null) {
    out.push(`| Change | ${code(a.numeric)} |`);
    out.push('');
    out.push(
      'The change is the arithmetic difference of the two recorded values, in the unit the harness ' +
        'printed. It is computed, not re-measured.',
      '',
    );
  } else {
    out.push('');
    out.push(
      'Both values are recorded as printed. They are not plain integers, so no arithmetic difference ' +
        'is stated — the two values above are the evidence.',
      '',
    );
  }

  // CVSS.
  out.push('## Severity (CVSS 3.1)', '');
  if (a.derivation.vector) {
    out.push(`${code(a.derivation.vector)} — base score **${a.derivation.score_text}**`, '');
    out.push(
      'The vector is derived deterministically from recorded facts: the engagement\'s mutability ' +
        'ceiling, the impact kind the harness measured, the reachability implied by the ledger asset ' +
        'kind, and the preconditions the harness declared. No model chose it, and re-running the ' +
        'derivation on the same inputs yields the same vector.',
      '',
    );
    out.push('| Metric | Value | Derived from | Attested |', '| --- | --- | --- | --- |');
    for (const k of ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']) {
      const b = a.derivation.basis[k];
      if (!b) continue;
      out.push(`| ${k} | ${code(b.value)} | ${oneLine(b.from)} | ${b.attested ? 'yes' : '**no**'} |`);
    }
    out.push('');
    if (a.derivation.unattested.length > 0) {
      out.push(
        `Metrics marked **no** took the less severe value because nothing recorded attested them: ` +
          `${a.derivation.unattested.map((m) => code(m)).join(', ')}. The published score is ` +
          'therefore a floor, and is repeated in `claims NOT verified`.',
        '',
      );
    }
  } else {
    out.push(
      `No CVSS base vector is stated. ${a.derivation.refusal ?? 'The derivation refused.'} Severity ` +
        'is left unstated rather than estimated.',
      '',
    );
  }

  // Remediation.
  out.push('## Remediation', '');
  if (a.remediation) {
    out.push(a.remediation, '');
  } else {
    out.push(
      'No remediation is stated. The bundle records no applied fix and no precondition the ' +
        'reproduction was shown to depend on, so any recommendation here would be advice rather ' +
        'than a measured result. See `claims NOT verified`.',
      '',
    );
  }

  // The mandatory section.
  out.push('## claims NOT verified', '');
  out.push(
    'Every item below is a claim this report does **not** make, or a claim for which the evidence ' +
      'in the bundle is incomplete. They are listed so a triager can judge the work rather than ' +
      'discover a gap later: unattested findings are ineligible on some programmes, so an ' +
      'overstated report does not merely lose points — it can forfeit the submission.',
    '',
  );
  for (const c of a.notVerified) out.push(`- ${c}`);
  out.push('');

  // Provenance footer, so the document carries its own audit pointers.
  out.push('---', '');
  out.push('### Provenance', '');
  out.push(
    `Generated by \`app/src/report.ts\` from the recorded \`proven\` bundle for hunt ` +
      `${a.input.bundle.hunt_id ? code(String(a.input.bundle.hunt_id)) : '_unknown_'} ` +
      `(playbook ${code(a.primary.playbook)}, verdict ${code(a.primary.verdict)}, confidence ` +
      `${code(a.primary.confidence)}).`,
    '',
  );
  const reasons = Array.isArray(a.primary.reasons) ? a.primary.reasons : [];
  if (reasons.length > 0) {
    out.push('The proof engine recorded these reasons for the verdict:', '');
    for (const r of reasons) if (typeof r === 'string' && r.trim()) out.push(`- ${oneLine(r)}`);
    out.push('');
  }
  const counts = a.input.bundle;
  out.push(
    `Run totals: attempts ${counts.attempts ?? 'n/a'}, proven ${counts.proven ?? 'n/a'}, partial ` +
      `${counts.partial ?? 'n/a'}, disproved ${counts.disproved ?? 'n/a'}, inconclusive ` +
      `${counts.inconclusive ?? 'n/a'}.`,
    '',
  );
  if (a.input.disclosure_url) out.push(`Disclosure contact: ${a.input.disclosure_url}`, '');
  out.push(
    `The CVSS base score above can be re-derived from the table in this report with the FIRST ` +
      `CVSS 3.1 base equations; nothing in this document depends on the writer's judgement.`,
    '',
  );

  return out.join('\n');
}

/** Re-export so a caller can format a score without importing cvss.ts directly. */
export { formatScore };
