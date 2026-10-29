/**
 * Learning — the bot's only honest source of ground truth: its own verdicts.
 *
 * The shipped corpus digest is somebody else's opinion, frozen at build time.
 * It says "auditors found 8,719 access-control findings, mean severity weight
 * 0.93". That is a real prior, but it is 100% web3, it never updates, and it
 * cannot tell you whether THIS bot, on THIS kind of target, actually proves
 * anything. This module closes that loop.
 *
 * What it learns from: rows in `learning_outcomes`, written by `recordOutcome`
 * when a proof attempt finishes. Four verdicts exist and only one of them is
 * a real finding (see proof.ts):
 *
 *     proven       — a falsifying test passed. Real evidence. Tier weight 3.
 *     partial      — the property fired but the claim was not established.
 *                    Weak evidence. Tier weight 1.
 *     disproved    — the attempt ran and the claim was refuted. Tier weight 0.
 *     inconclusive — the harness failed; we learned nothing about the CLASS.
 *                    Excluded from the mean, still counted as an attempt.
 *
 * What it does NOT learn from: prose. There is no model call in this path and
 * no text ingestion. A policy document, a Twitter thread and an audit PDF are
 * all equally invisible here, by design — the bot cannot be "taught" by
 * assertion, only by executed outcomes. `partial` teaches almost nothing for
 * exactly the same reason: it says the harness ran, not that the bug is real.
 *
 * The formula (see blendedWeight) is a shrinkage estimator, documented there.
 * One consequence is deliberate and load-bearing: a class with **zero proven**
 * outcomes can never be blended above its digest weight. Attempts alone do not
 * earn a class more of the operator's time — only proofs do.
 *
 * Units: everything here is in the same units as corpus ClassStat.weight
 * (0..3, a severity weight), so blending two estimates is legitimate rather
 * than a category error. See LEARNING.md for why that matters.
 */

export const VERDICTS = ['proven', 'partial', 'disproved', 'inconclusive'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Verdict → severity-weight tier, in the digest's 0..3 units. */
export const TIER: Record<Verdict, number> = {
  proven: 3,
  partial: 1,
  disproved: 0,
  inconclusive: 0,
};

/**
 * How many real outcomes it takes before observed data outweighs the frozen
 * prior. At n = priorStrength the two get exactly 50% each; below that the
 * digest dominates, above it the bot's own record does.
 *
 * 12, not 2 and not 200. The digest's thousands of rows are audit findings on
 * other people's code; they say the class is real, not that this bot can
 * prove it. Two outcomes are noise. Twelve is the point where a consistent
 * run of proofs is more informative than a snapshot that cannot update — and
 * it is deliberately far below "dozens", so the loop visibly starts to move
 * before the sample is statistically comfortable. Treat every blended number
 * with counted < 20 as directional only.
 */
export const DEFAULT_PRIOR_STRENGTH = 12;

/** Sample-size bands used to label how much of a ranking row is real evidence. */
export const CONFIDENCE_BANDS = { low: 5, medium: 20 } as const;
export type Confidence = 'none' | 'low' | 'medium' | 'high';

// ────────────────────────────────────────────────────────── db interface ─────

/**
 * The slice of D1 this module needs. Declared structurally so the same code
 * runs against D1 in the Worker and against node:sqlite in tests — and so a
 * test can prove the SQL against the real schema instead of a mock of it.
 * `D1Database` satisfies this interface (asserted at compile time below).
 */
export interface LearnStatement {
  bind(...values: unknown[]): LearnStatement;
  run(): Promise<{ success?: boolean; meta?: unknown }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface LearnDb {
  prepare(sql: string): LearnStatement;
}

/**
 * Compile-time proof that the Worker's real binding is usable here without a
 * cast. Never executed; if D1's shape drifts this stops the build.
 */
export type D1SatisfiesLearnDb = D1Database extends LearnDb ? true : never;
const _d1Check: D1SatisfiesLearnDb = true;
void _d1Check;

// ─────────────────────────────────────────────────────────────── reading ─────

export interface OutcomeInput {
  /** Playbook that produced the verdict. Also the class id in this codebase. */
  playbook: string;
  verdict: Verdict;
  /**
   * Class id, when it differs from the playbook id (e.g. one playbook that
   * covers several classes). Defaults to the playbook id, because in this
   * repo playbook.id === corpus class id for all 25 classes.
   */
  cls?: string;
  /** Stable hash of the target, so repeats on one target can be de-duplicated. */
  target_fingerprint?: string | null;
  /** Optional measured effect, in whatever unit the operator reported. */
  measured?: { before?: number | null; after?: number | null } | null;
  /** Unix seconds. Defaults to now; injectable so tests are deterministic. */
  at?: number;
}

export interface RecordedOutcome {
  id: string;
  cls: string;
  playbook: string;
  verdict: Verdict;
  target_fingerprint: string | null;
  measured_before: number | null;
  measured_after: number | null;
  created_at: number;
}

export interface ClassStatLearned {
  cls: string;
  /** Every row for this class, including inconclusive. */
  attempted: number;
  proven: number;
  partial: number;
  disproved: number;
  inconclusive: number;
  /** attempted − inconclusive: the rows that carry any signal at all. */
  counted: number;
  /** Σ TIER[verdict] over the counted rows. */
  tierSum: number;
  /** tierSum / counted, or null when there is nothing counted. */
  observedWeight: number | null;
  lastAt: number | null;
}

interface StatRow {
  cls: string;
  attempted: number | null;
  proven: number | null;
  partial: number | null;
  disproved: number | null;
  inconclusive: number | null;
  counted: number | null;
  tier_sum: number | null;
  last_at: number | null;
}

const STAT_COLUMNS = `
  cls,
  COUNT(*)                                                                  AS attempted,
  SUM(CASE WHEN verdict = 'proven'       THEN 1 ELSE 0 END)                 AS proven,
  SUM(CASE WHEN verdict = 'partial'      THEN 1 ELSE 0 END)                 AS partial,
  SUM(CASE WHEN verdict = 'disproved'    THEN 1 ELSE 0 END)                 AS disproved,
  SUM(CASE WHEN verdict = 'inconclusive' THEN 1 ELSE 0 END)                 AS inconclusive,
  SUM(CASE WHEN verdict = 'inconclusive' THEN 0 ELSE 1 END)                 AS counted,
  SUM(CASE WHEN verdict = 'proven'       THEN ${TIER.proven}
           WHEN verdict = 'partial'      THEN ${TIER.partial}
           ELSE 0 END)                                                      AS tier_sum,
  MAX(created_at)                                                           AS last_at`;

// ───────────────────────────────────────────────────────── recordOutcome ─────

function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new TypeError(`${field} must be a string`);
  const t = v.trim();
  if (!t) throw new TypeError(`${field} must not be empty`);
  return t;
}

function numOrNull(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`${field} must be a finite number or null`);
  }
  return v;
}

/**
 * Persist one verdict. This is the ONLY function in this module that writes.
 *
 * Fails closed: an unknown verdict throws rather than being coerced into
 * something that would later look like evidence. A verdict string that does not
 * match the four the prover can emit is a bug upstream, and silently storing it
 * as `inconclusive` would hide that bug behind a plausible-looking row.
 */
export async function recordOutcome(db: LearnDb, input: OutcomeInput): Promise<RecordedOutcome> {
  const playbook = nonEmptyString(input?.playbook, 'playbook');
  if (!isVerdict(input?.verdict)) {
    throw new TypeError(`verdict must be one of ${VERDICTS.join('|')}, got ${String(input?.verdict)}`);
  }
  const cls = input.cls === undefined || input.cls === null
    ? playbook
    : nonEmptyString(input.cls, 'cls');

  const measuredBefore = numOrNull(input.measured?.before, 'measured.before');
  const measuredAfter = numOrNull(input.measured?.after, 'measured.after');
  const fingerprint = input.target_fingerprint == null
    ? null
    : nonEmptyString(input.target_fingerprint, 'target_fingerprint');
  const createdAt = input.at ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(createdAt) || createdAt < 0) {
    throw new TypeError('at must be a non-negative integer (unix seconds)');
  }

  const row: RecordedOutcome = {
    id: crypto.randomUUID(),
    cls,
    playbook,
    verdict: input.verdict,
    target_fingerprint: fingerprint,
    measured_before: measuredBefore,
    measured_after: measuredAfter,
    created_at: createdAt,
  };

  await db
    .prepare(
      `INSERT INTO learning_outcomes
         (id, cls, playbook, verdict, target_fingerprint, measured_before, measured_after, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      row.id,
      row.cls,
      row.playbook,
      row.verdict,
      row.target_fingerprint,
      row.measured_before,
      row.measured_after,
      row.created_at,
    )
    .run();

  return row;
}

// ────────────────────────────────────────────────────────────── classStats ─────

function toStat(r: StatRow): ClassStatLearned {
  const attempted = Number(r.attempted ?? 0);
  const counted = Number(r.counted ?? 0);
  const tierSum = Number(r.tier_sum ?? 0);
  return {
    cls: String(r.cls),
    attempted,
    proven: Number(r.proven ?? 0),
    partial: Number(r.partial ?? 0),
    disproved: Number(r.disproved ?? 0),
    inconclusive: Number(r.inconclusive ?? 0),
    counted,
    tierSum,
    observedWeight: counted > 0 ? tierSum / counted : null,
    lastAt: r.last_at === null || r.last_at === undefined ? null : Number(r.last_at),
  };
}

/**
 * Per-class outcome counts straight from the ledger of verdicts. No digest
 * involved: this is what the bot has actually measured, and nothing else.
 */
export async function classStats(db: LearnDb, cls?: string): Promise<ClassStatLearned[]> {
  if (cls !== undefined) {
    const one = nonEmptyString(cls, 'cls');
    const { results } = await db
      .prepare(`SELECT ${STAT_COLUMNS} FROM learning_outcomes WHERE cls = ? GROUP BY cls`)
      .bind(one)
      .all<StatRow>();
    return (results ?? []).map(toStat);
  }
  const { results } = await db
    .prepare(`SELECT ${STAT_COLUMNS} FROM learning_outcomes GROUP BY cls ORDER BY cls`)
    .all<StatRow>();
  return (results ?? []).map(toStat);
}

// ───────────────────────────────────────────────────────── blendedWeight ─────

export interface BlendOptions {
  /** Prior pseudo-count. Must be > 0. Defaults to DEFAULT_PRIOR_STRENGTH. */
  priorStrength?: number;
}

export interface BlendDetail {
  cls: string;
  /** The frozen prior, in 0..3 weight units. */
  digestWeight: number;
  /** What the bot's own outcomes say, in the same units. Null when counted = 0. */
  learnedWeight: number | null;
  /** The estimate to rank on. Exactly digestWeight when counted = 0. */
  blended: number;
  /** Fraction of the estimate that comes from the prior: ps / (ps + counted). */
  priorShare: number;
  /** Fraction that comes from real outcomes: counted / (ps + counted). */
  observedShare: number;
  counted: number;
  proven: number;
  /** True when the blend moved the class away from the prior at all. */
  moved: boolean;
  /**
   * Set when the class has attempts but no proofs, so the blend was clamped
   * back down to the prior. This is the anti-inflation rule, made visible.
   */
  cappedByNoProof: boolean;
}

function positivePriorStrength(opts?: BlendOptions): number {
  const ps = opts?.priorStrength ?? DEFAULT_PRIOR_STRENGTH;
  if (typeof ps !== 'number' || !Number.isFinite(ps) || ps <= 0) {
    throw new RangeError('priorStrength must be a finite number > 0');
  }
  return ps;
}

/**
 * Blend the frozen digest weight with the bot's observed outcomes.
 *
 * METHOD — a shrinkage (posterior-mean) estimator:
 *
 *   blended = (k · w_digest + Σ tier) / (k + n)          k = priorStrength
 *
 * Read it as a weighted average of two means in the same units: the prior mean
 * w_digest, worth k pseudo-observations, and the observed mean Σtier/n, worth
 * n real ones.
 *
 * Why this and not a plain average or a multiplier:
 *   · n = 0  → blended = w_digest exactly. No data, no drift. A plain average
 *              would divide by zero or fabricate a value; a multiplier would
 *              need a base rate nobody measured.
 *   · n → ∞  → blended → Σtier/n, the bot's own record. Evidence wins.
 *   · In between the estimate moves monotonically and *gradually*: the
 *              influence of the prior decays as k/(k+n), so 3 outcomes nudge
 *              and 300 outcomes overrule. That is exactly the behaviour you
 *              want from a system whose early sample is noise.
 *   · It is the closed-form posterior mean of a Normal prior on a mean with a
 *              known-variance approximation — i.e. the textbook way to fuse a
 *              prior with data, not a curve fitted to look plausible.
 *   · Same units on both sides is what makes the average legitimate. The
 *              digest weight is a mean severity weight; the tier sum is a mean
 *              severity weight of executed outcomes. Had we blended a success
 *              *rate* with a severity *weight* we would be averaging metres
 *              into seconds, and the number would be meaningless however
 *              tidy it looked.
 *
 * ANTI-INFLATION RULE — a class with zero `proven` outcomes is clamped to at
 * most w_digest. Attempts earn attention; only proofs earn rank. Without this,
 * a class with one `partial` and a zero prior (every `web.*` class today) would
 * jump from 0.0 to a positive weight on the strength of a harness that merely
 * ran, which is precisely the self-congratulatory drift this module exists to
 * avoid.
 *
 * Returns a plain number so callers can rank with it directly; `blendDetail`
 * returns the same arithmetic with the receipts.
 */
export function blendedWeight(
  cls: string,
  digestWeight: number,
  learnedStats: ClassStatLearned | null | undefined,
  opts?: BlendOptions,
): number {
  return blendDetail(cls, digestWeight, learnedStats, opts).blended;
}

/** The same computation as blendedWeight, with the provenance exposed. */
export function blendDetail(
  cls: string,
  digestWeight: number,
  learnedStats: ClassStatLearned | null | undefined,
  opts?: BlendOptions,
): BlendDetail {
  const ps = positivePriorStrength(opts);
  const prior = typeof digestWeight === 'number' && Number.isFinite(digestWeight) ? digestWeight : 0;

  const counted = Math.max(0, Math.trunc(learnedStats?.counted ?? 0));
  const proven = Math.max(0, Math.trunc(learnedStats?.proven ?? 0));

  // No data: return the prior bit-for-bit. Not "approximately", not
  // "within epsilon" — the same double, so callers can assert equality and so
  // a first deploy provably changes nothing.
  if (counted === 0) {
    return {
      cls,
      digestWeight: prior,
      learnedWeight: null,
      blended: prior,
      priorShare: 1,
      observedShare: 0,
      counted: 0,
      proven,
      moved: false,
      cappedByNoProof: false,
    };
  }

  const tierSum = Number(learnedStats?.tierSum ?? 0);
  const observed = tierSum / counted;
  const raw = (ps * prior + tierSum) / (ps + counted);

  const capped = proven === 0 && raw > prior;
  const blended = capped ? prior : raw;

  return {
    cls,
    digestWeight: prior,
    learnedWeight: observed,
    blended,
    priorShare: ps / (ps + counted),
    observedShare: counted / (ps + counted),
    counted,
    proven,
    // "Moved" means the estimate carries information from outcomes. A clamped
    // row did not move even though the clamp is itself an outcome-driven act.
    moved: !capped && blended !== prior,
    cappedByNoProof: capped,
  };
}

// ─────────────────────────────────────────────────────────── learnedRanking ─────

export interface DigestWeights {
  classes?: Record<string, { weight?: number } | undefined> | null;
}

export interface RankingRow {
  cls: string;
  /** Frozen digest weight, 0 when the class is absent from the digest. */
  digestWeight: number;
  learnedWeight: number | null;
  blendedWeight: number;
  priorShare: number;
  observedShare: number;
  attempted: number;
  counted: number;
  proven: number;
  /** Sample-size band. `none` means the row is pure prior. */
  confidence: Confidence;
  /** True only when a real proof moved this class above its digest weight. */
  raised: boolean;
  /** One-line explanation for an operator looking at the list. */
  note: string | null;
}

function band(counted: number): Confidence {
  if (counted <= 0) return 'none';
  if (counted < CONFIDENCE_BANDS.low) return 'low';
  if (counted < CONFIDENCE_BANDS.medium) return 'medium';
  return 'high';
}

/**
 * Classes ordered by blended weight, each carrying how much of that weight is
 * real evidence. This is the operator-facing view: it must be obvious at a
 * glance which rows are the bot's own record and which are inherited opinion.
 *
 * `digest` is optional so the literal `learnedRanking(db)` form still works; it
 * then ranks on observed weight alone and marks every row accordingly. Pass the
 * digest to get the blended estimate — that is the useful form.
 */
export async function learnedRanking(
  db: LearnDb,
  digest?: DigestWeights | null,
  opts?: BlendOptions,
): Promise<RankingRow[]> {
  const stats = await classStats(db);
  const byCls = new Map(stats.map((s) => [s.cls, s]));

  const digestClasses = digest?.classes ?? null;
  const clsNames = new Set<string>(byCls.keys());
  if (digestClasses) for (const k of Object.keys(digestClasses)) clsNames.add(k);

  const rows: RankingRow[] = [];
  for (const cls of clsNames) {
    const st = byCls.get(cls) ?? null;
    const digestWeight = Number(digestClasses?.[cls]?.weight ?? 0) || 0;
    const d = blendDetail(cls, digestWeight, st, opts);
    const counted = st?.counted ?? 0;
    const proven = st?.proven ?? 0;
    const confidence = band(counted);

    let note: string | null = null;
    if (counted === 0) note = 'prior only — never attempted';
    else if (d.cappedByNoProof) note = `${counted} attempt(s), 0 proofs — capped at prior`;
    else if (confidence === 'low') note = `${counted} outcome(s) — directional at best`;
    else if (confidence === 'medium') note = `${counted} outcomes — useful but not settled`;

    rows.push({
      cls,
      digestWeight,
      learnedWeight: d.learnedWeight,
      blendedWeight: d.blended,
      priorShare: d.priorShare,
      observedShare: d.observedShare,
      attempted: st?.attempted ?? 0,
      counted,
      proven,
      confidence,
      raised: proven > 0 && d.blended > digestWeight,
      note,
    });
  }

  // Highest blended weight first; ties broken by the class with more real
  // evidence, so a measured 0.9 outranks an inherited 0.9.
  rows.sort((a, b) => b.blendedWeight - a.blendedWeight || b.counted - a.counted || a.cls.localeCompare(b.cls));
  return rows;
}
