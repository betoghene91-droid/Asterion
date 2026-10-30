/**
 * CVSS 3.1 base vector, DERIVED from the measured delta.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 *
 * A model must never choose the score. No LLM, no heuristic "this feels like a
 * 7.5", no free-text severity guess appears anywhere in this module, and none
 * may be added. The reason is not philosophical: a report is the artefact a
 * human submits under their own name to a bounty platform, and a severity that
 * was guessed is indistinguishable in the submitted document from one that was
 * measured. When the programme disputes it, there is nothing to point at. A
 * number that came out of a lookup table keyed on attested facts can be
 * re-derived by the triager in ten seconds; a number a model produced cannot be
 * re-derived by anyone, including us.
 *
 * So every metric below is a pure function of four inputs, and every input is
 * either recorded in the proof bundle or read out of the ledger:
 *
 *   mutability     the engagement's RoE ceiling for this action (policy.ts Mut)
 *   impact kind    `impact.kind` from the PoC harness, via proof.ts ImpactClaim
 *   reachability   the `kind` of the affected asset row in the ledger `assets`
 *   preconditions  `requires[]`, the preconditions the harness itself declares
 *
 * ── Two honesty rules that make the output safe to submit ───────────────────
 *
 * 1. UNATTESTED ⇒ LEAST SEVERE. When no precondition attests an axis, this
 *    module takes the value that scores *lower* and marks the axis unattested.
 *    Callers must surface those axes (see `basis`), because a derived score
 *    that quietly used a favourable default is the same lie as a guessed one.
 *    Concretely: no user-interaction signal ⇒ UI:R, not UI:N; no
 *    trust-boundary signal ⇒ S:U, not S:C. The published score is therefore a
 *    FLOOR. Understating is recoverable by the human reading the report;
 *    overstating is not.
 *
 * 2. UNKNOWN IMPACT KIND ⇒ REFUSE, do not default. `impact.kind === 'other'`
 *    means the plan carried no claim kind, so C/I/A would be invented. This
 *    returns an error instead of 0.0, because 0.0 reads as "harmless" and that
 *    is a different statement from "not scored".
 *
 * Nothing here touches the network and nothing here is async: two calls with the
 * same inputs are byte-identical, which is what makes the report reproducible
 * and the golden test meaningful.
 *
 * Reference: FIRST CVSS v3.1 specification, section 7.1 (base equations) and
 * section 7.4 (the Roundup function), both implemented literally below and
 * pinned against published reference vectors in tests/cvss.test.mjs.
 */

export const CVSS_VERSION = '3.1';

/**
 * Mutability ceiling. Deliberately a structural copy of `Mut` in policy.ts —
 * NOT an import. cvss.ts must stay usable from a plain `node build/cvss.js`
 * with no D1/Workers types in the graph, and a duplicated four-value union is
 * cheaper to keep in sync (a test asserts the two lists match) than a runtime
 * import edge that would drag the policy engine into every report script.
 */
export type Mutability = 'read' | 'simulate' | 'mutate' | 'destructive';

/**
 * Impact kinds this module can score. A subset of `ImpactKind` in proof.ts:
 * `'other'` is excluded on purpose, so the type system refuses to score a
 * bundle whose impact kind was never recorded (see rule 2 above).
 */
export type ScorableImpact =
  | 'value_transfer'
  | 'unauthorized_access'
  | 'state_corruption'
  | 'denial';

/** Attack surface reach, derived from the ledger asset kind. */
export type Reachability = 'network' | 'adjacent' | 'local' | 'physical';

/** The four derivation inputs. Every one of them is recorded, never inferred. */
export interface DerivationInputs {
  mutability: Mutability;
  impact: ScorableImpact;
  reachability: Reachability;
  /** `requires[]` from the PoC spec, verbatim. Classified, never rewritten. */
  preconditions: readonly string[];
}

export interface CvssParts {
  AV: 'N' | 'A' | 'L' | 'P';
  AC: 'L' | 'H';
  PR: 'N' | 'L' | 'H';
  UI: 'N' | 'R';
  S: 'U' | 'C';
  C: 'H' | 'L' | 'N';
  I: 'H' | 'L' | 'N';
  A: 'H' | 'L' | 'N';
}

/**
 * How one metric was chosen, so a report can say which parts are attested and
 * which fell back to the least-severe value.
 */
export interface MetricBasis {
  /** The metric value as it appears in the vector. */
  value: string;
  /** Which input produced it, in words a triager can follow. */
  from: string;
  /** False when no recorded fact selected this value and a safe default did. */
  attested: boolean;
}

export type CvssBasis = Record<keyof CvssParts, MetricBasis>;

export interface CvssDerivation {
  ok: true;
  /** Full CVSS 3.1 base vector, e.g. `CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:N`. */
  vector: string;
  /** Base score, one decimal place. */
  score: number;
  /** `score` formatted the way every platform expects to read it. */
  score_text: string;
  parts: CvssParts;
  basis: CvssBasis;
  /** Metric keys whose value is a least-severe default rather than an attestation. */
  unattested: (keyof CvssParts)[];
  /** The classification of `preconditions` this derivation actually used. */
  precondition_classes: PreconditionClasses;
}

export interface CvssError {
  ok: false;
  reason: string;
  missing: string[];
}

export type CvssResult = CvssDerivation | CvssError;

// ── 1. Precondition classification ──────────────────────────────────────────

export interface PreconditionClasses {
  /** Lab setup (RPC, harness, source). Present in every run; never raises AC. */
  environment: string[];
  /** A shape the *target* must have. These are attacker-relevant conditions. */
  target_condition: string[];
  /** The attacker must already hold a position. Raises PR. */
  privilege: string[];
  /** A third party must act. Sets UI:R — and is itself an attestation of it. */
  victim: string[];
  /** The effect crosses a security boundary. The only path to S:C. */
  boundary: string[];
  /** The sequence runs with no human in it. The only path to UI:N. */
  automation: string[];
}

/**
 * Keyword rules, in order. Order matters: "no re-entry" style negations live in
 * `automation`, and a string that matches more than one class is counted in
 * every class it matches — a precondition can legitimately both require a
 * privileged position and be automated.
 *
 * Matching is case-insensitive substring on purpose. These are short declarative
 * phrases authored by poc.ts, not prose; a regex that tries to be clever about
 * grammar would be a source of silent misses, and a miss here only ever moves a
 * metric toward the least severe value (rule 1), so the blast radius of an
 * unmatched phrase is bounded in the safe direction.
 */
const PRECONDITION_RULES: { cls: keyof PreconditionClasses; tokens: string[] }[] = [
  {
    cls: 'automation',
    tokens: [
      'no user interaction',
      'no human',
      'single transaction',
      'attacker-only',
      'scripted',
      'automated',
      'no third party',
    ],
  },
  {
    cls: 'victim',
    tokens: ['victim', 'user clicks', 'clicks', 'browser', 'email', 'link', 'renders', 'opens'],
  },
  {
    cls: 'boundary',
    tokens: ['crosses', 'other users', 'other tenant', 'escapes', 'another account', 'privilege boundary'],
  },
  {
    cls: 'privilege',
    tokens: ['owner', 'admin', 'privileged', 'authenticated session', 'operator key', 'signer key'],
  },
  {
    cls: 'environment',
    tokens: [
      'fork_rpc',
      'target',
      'foundry',
      'forge',
      'contract source',
      'deployable implementation',
      'repository',
      'commit',
      'rpc',
    ],
  },
];

/**
 * Sort `preconditions` into the classes the derivation reads.
 *
 * A phrase that matches no rule is a `target_condition`: it is a declared
 * requirement of the attack whose nature we could not classify, and treating an
 * unclassified requirement as a target condition is the conservative choice
 * (it raises AC, i.e. lowers the score).
 */
export function classifyPreconditions(preconditions: readonly string[]): PreconditionClasses {
  const out: PreconditionClasses = {
    environment: [],
    target_condition: [],
    privilege: [],
    victim: [],
    boundary: [],
    automation: [],
  };

  for (const raw of Array.isArray(preconditions) ? preconditions : []) {
    const phrase = typeof raw === 'string' ? raw : '';
    if (!phrase.trim()) continue;
    const lower = phrase.toLowerCase();
    let hit = false;
    for (const rule of PRECONDITION_RULES) {
      if (rule.tokens.some((t) => lower.includes(t))) {
        out[rule.cls].push(phrase);
        hit = true;
      }
    }
    if (!hit) out.target_condition.push(phrase);
  }

  return out;
}

// ── 2. The lookups: derivation input → metric ───────────────────────────────
//
// These four tables ARE the mapping the assignment asks for. Every row is a
// statement about what the recorded fact means, in one place, so a reviewer can
// audit the whole severity model without reading control flow.

/** Reachability comes from `assets.kind` — the ledger row, not the prose. */
export const REACHABILITY_TO_AV: Record<Reachability, CvssParts['AV']> = {
  network: 'N',
  adjacent: 'A',
  local: 'L',
  physical: 'P',
};

/**
 * `assets.kind` → reachability. The ledger's own vocabulary (schema.sql assets
 * table: domain|host|url|api|cidr|chain_address|repo|apk|ipa).
 *
 * A deployed contract address is internet-reachable by definition — anyone can
 * send it a transaction — which is why `chain_address` maps to `network` and not
 * to `local` just because we reproduced it on a fork. The fork is where we
 * MEASURED it; it is not where it lives. That distinction is also stated in the
 * report's unverified list, because a fork reproduction is not a production one.
 */
export const ASSET_KIND_TO_REACHABILITY: Record<string, Reachability> = {
  domain: 'network',
  host: 'network',
  url: 'network',
  api: 'network',
  chain_address: 'network',
  cidr: 'adjacent',
  repo: 'local',
  apk: 'local',
  ipa: 'local',
};

/**
 * Mutability → Privileges Required, used only when no precondition attests a
 * privilege position.
 *
 * `read` and `simulate` are PR:N because neither requires the attacker to hold
 * anything: a read probe is unauthenticated by construction, and a fork
 * simulation is executed by an unprivileged test EOA. A `mutate` action needs a
 * foothold (PR:L) and a `destructive` one needs a high-privilege one (PR:H) —
 * that is what the RoE mutability ladder means, and policy.ts already refuses
 * anything above the ceiling.
 */
export const MUTABILITY_TO_PR: Record<Mutability, CvssParts['PR']> = {
  read: 'N',
  simulate: 'N',
  mutate: 'L',
  destructive: 'H',
};

/** Privilege signal rank, so the strongest attested signal wins. */
const PRIVILEGE_RANK: Record<CvssParts['PR'], number> = { N: 0, L: 1, H: 2 };

/**
 * Impact kind → Confidentiality / Integrity / Availability.
 *
 * Each row states the primary harm of the class as proof.ts records it:
 *   value_transfer       funds moved out of the attacker's control → I:H
 *   unauthorized_access  data reached that should not have been → C:H
 *   state_corruption     state written wrongly → I:H with a secondary A:L
 *   denial               availability only → A:H
 * Nothing else is claimed: a value transfer does not assert a confidentiality
 * breach, so C:N, and the report must not imply otherwise.
 */
export const IMPACT_TO_CIA: Record<ScorableImpact, { C: CvssParts['C']; I: CvssParts['I']; A: CvssParts['A'] }> = {
  value_transfer: { C: 'N', I: 'H', A: 'N' },
  unauthorized_access: { C: 'H', I: 'L', A: 'N' },
  state_corruption: { C: 'N', I: 'H', A: 'L' },
  denial: { C: 'N', I: 'N', A: 'H' },
};

/** Attack Complexity from the count of unclassified target requirements. */
export function complexityFor(targetConditions: number): CvssParts['AC'] {
  // Zero declared target conditions ⇒ nothing beyond the environment has to be
  // true ⇒ AC:L. One or more ⇒ the attacker must arrange a condition the target
  // does not always satisfy ⇒ AC:H. Deliberately not a curve: a count of
  // declared requirements is the only thing the harness attests, and inventing
  // gradations above it would be modelling, not measuring.
  return targetConditions === 0 ? 'L' : 'H';
}

// ── 3. CVSS 3.1 base score arithmetic (spec §7.1, §7.4) ─────────────────────

const AV_W: Record<CvssParts['AV'], number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC_W: Record<CvssParts['AC'], number> = { L: 0.77, H: 0.44 };
const PR_W_UNCHANGED: Record<CvssParts['PR'], number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_W_CHANGED: Record<CvssParts['PR'], number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI_W: Record<CvssParts['UI'], number> = { N: 0.85, R: 0.62 };
const CIA_W: Record<'H' | 'L' | 'N', number> = { H: 0.56, L: 0.22, N: 0 };

/**
 * The spec's Roundup, implemented with integer arithmetic exactly as §7.4
 * specifies. A naive `Math.ceil(x * 10) / 10` disagrees with the spec on values
 * that are already exact at one decimal place and on float-representation
 * neighbours of them, which is why every published score would be off by 0.1
 * somewhere.
 */
export function roundUp(input: number): number {
  const intInput = Math.round(input * 100000);
  if (intInput % 10000 === 0) return intInput / 100000;
  return (Math.floor(intInput / 10000) + 1) / 10;
}

/** Render a base score: always one decimal, as platforms expect. */
export function formatScore(score: number): string {
  return score.toFixed(1);
}

/** `CVSS:3.1/AV:N/AC:L/...` from its parts, in the canonical metric order. */
export function vectorFor(parts: CvssParts): string {
  return (
    `CVSS:${CVSS_VERSION}` +
    `/AV:${parts.AV}/AC:${parts.AC}/PR:${parts.PR}/UI:${parts.UI}` +
    `/S:${parts.S}/C:${parts.C}/I:${parts.I}/A:${parts.A}`
  );
}

/**
 * Base score from parts. Pure arithmetic; no I/O, no clock, no randomness — so
 * two calls with the same parts cannot differ.
 */
export function baseScore(parts: CvssParts): number {
  const iss = 1 - (1 - CIA_W[parts.C]) * (1 - CIA_W[parts.I]) * (1 - CIA_W[parts.A]);
  const changed = parts.S === 'C';

  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  // Spec §7.1: impact <= 0 scores 0.0 and exploitability is not evaluated. This
  // is the "no CIA impact" row, and it is the reason an unscorable bundle must
  // be refused rather than mapped here (see rule 2 in the header).
  if (impact <= 0) return 0;

  const prW = changed ? PR_W_CHANGED[parts.PR] : PR_W_UNCHANGED[parts.PR];
  const exploitability = 8.22 * AV_W[parts.AV] * AC_W[parts.AC] * prW * UI_W[parts.UI];

  const raw = changed
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);

  return roundUp(raw);
}

/**
 * Score a vector string. Exists so the derivation can be checked against the
 * published reference vectors in the test suite, and so a human reviewing a
 * report can confirm the number without trusting `deriveCvss`.
 *
 * Returns null for anything malformed or for a non-3.1 vector: an unparsable
 * vector is not a 0.0 score, it is not a score at all.
 */
export function scoreOfVector(vector: string): number | null {
  const parts = parseVector(vector);
  return parts ? baseScore(parts) : null;
}

/** Parse and validate a base vector. Unknown or missing metrics yield null. */
export function parseVector(vector: string): CvssParts | null {
  if (typeof vector !== 'string') return null;
  const segments = vector.split('/');
  if (segments[0] !== `CVSS:${CVSS_VERSION}`) return null;

  const got: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const i = seg.indexOf(':');
    if (i < 1) return null;
    got[seg.slice(0, i)] = seg.slice(i + 1);
  }

  const base = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];
  // Exactly the eight base metrics. Temporal/environmental groups are not
  // implemented, and silently ignoring them would let a caller believe a
  // modified score had been computed.
  if (Object.keys(got).length !== base.length) return null;
  for (const k of base) if (!got[k]) return null;

  const one = <T extends string>(v: string, allowed: readonly T[]): T | null =>
    (allowed as readonly string[]).includes(v) ? (v as T) : null;

  const AV = one(got.AV ?? '', ['N', 'A', 'L', 'P'] as const);
  const AC = one(got.AC ?? '', ['L', 'H'] as const);
  const PR = one(got.PR ?? '', ['N', 'L', 'H'] as const);
  const UI = one(got.UI ?? '', ['N', 'R'] as const);
  const S = one(got.S ?? '', ['U', 'C'] as const);
  const C = one(got.C ?? '', ['H', 'L', 'N'] as const);
  const I = one(got.I ?? '', ['H', 'L', 'N'] as const);
  const A = one(got.A ?? '', ['H', 'L', 'N'] as const);

  if (!AV || !AC || !PR || !UI || !S || !C || !I || !A) return null;
  return { AV, AC, PR, UI, S, C, I, A };
}

// ── 4. The derivation ───────────────────────────────────────────────────────

/** True when `impact` is one of the kinds this module is willing to score. */
export function isScorableImpact(kind: unknown): kind is ScorableImpact {
  return (
    kind === 'value_transfer' ||
    kind === 'unauthorized_access' ||
    kind === 'state_corruption' ||
    kind === 'denial'
  );
}

/**
 * Derive the full base vector + score from the four recorded inputs.
 *
 * Deterministic by construction: every branch reads only its arguments, and the
 * returned `basis` explains each metric in the same words every time. Two calls
 * with equal inputs produce byte-identical `vector`, `score` and `score_text` —
 * tests/cvss.test.mjs asserts this rather than assuming it.
 */
export function deriveCvss(inputs: DerivationInputs): CvssResult {
  const missing: string[] = [];

  if (!inputs || typeof inputs !== 'object') {
    return { ok: false, reason: 'no derivation inputs were supplied', missing: ['inputs'] };
  }
  if (!isScorableImpact(inputs.impact)) {
    // Rule 2: refuse rather than default C/I/A. A 0.0 here would read as
    // "no impact", which is a claim we are not entitled to make.
    return {
      ok: false,
      reason:
        `impact kind ${JSON.stringify(inputs.impact)} is not one of ` +
        `value_transfer|unauthorized_access|state_corruption|denial, so C/I/A ` +
        `cannot be derived without inventing them`,
      missing: ['impact'],
    };
  }
  if (!(inputs.mutability in MUTABILITY_TO_PR)) {
    return {
      ok: false,
      reason: `mutability ${JSON.stringify(inputs.mutability)} is not a RoE mutability`,
      missing: ['mutability'],
    };
  }
  if (!(inputs.reachability in REACHABILITY_TO_AV)) {
    return {
      ok: false,
      reason: `reachability ${JSON.stringify(inputs.reachability)} is not network|adjacent|local|physical`,
      missing: ['reachability'],
    };
  }

  const cls = classifyPreconditions(inputs.preconditions ?? []);
  const cia = IMPACT_TO_CIA[inputs.impact];

  // AV — from the ledger asset kind.
  const AV = REACHABILITY_TO_AV[inputs.reachability];

  // AC — from the count of declared target conditions.
  const AC = complexityFor(cls.target_condition.length);

  // PR — an attested privilege requirement beats the mutability ladder, because
  // the harness is stating something about the attacker, not about the action.
  const fromLadder = MUTABILITY_TO_PR[inputs.mutability];
  const fromSignal = cls.privilege.length
    ? maxPrivilege(cls.privilege.map(privilegeRankOf))
    : null;
  const PR = fromSignal ?? fromLadder;

  // UI — attested only by a victim-interaction OR an automation precondition.
  // Absent either, the least severe value (R) is used and flagged.
  const uiAttested = cls.victim.length > 0 || cls.automation.length > 0;
  const UI: CvssParts['UI'] = cls.victim.length ? 'R' : cls.automation.length ? 'N' : 'R';

  // S — attested only by a declared boundary crossing; S:C raises the score, so
  // it is never assumed.
  const sAttested = cls.boundary.length > 0;
  const S: CvssParts['S'] = cls.boundary.length ? 'C' : 'U';

  const parts: CvssParts = { AV, AC, PR, UI, S, C: cia.C, I: cia.I, A: cia.A };

  const basis: CvssBasis = {
    AV: {
      value: AV,
      from: `ledger asset kind → reachability "${inputs.reachability}"`,
      attested: true,
    },
    AC: {
      value: AC,
      from:
        cls.target_condition.length === 0
          ? 'no declared target condition in requires[]'
          : `${cls.target_condition.length} declared target condition(s) in requires[]`,
      attested: true,
    },
    PR: {
      value: PR,
      from: fromSignal
        ? `requires[] declares a privilege position: "${cls.privilege[0]}"`
        : `RoE mutability "${inputs.mutability}" ladder (no privilege requirement declared)`,
      attested: true,
    },
    UI: {
      value: UI,
      from: cls.victim.length
        ? `requires[] declares a third party acting: "${cls.victim[0]}"`
        : cls.automation.length
          ? `requires[] declares an automated sequence: "${cls.automation[0]}"`
          : 'no user-interaction or automation precondition declared — least severe value used',
      attested: uiAttested,
    },
    S: {
      value: S,
      from: cls.boundary.length
        ? `requires[] declares a boundary crossing: "${cls.boundary[0]}"`
        : 'no trust-boundary precondition declared — least severe value used',
      attested: sAttested,
    },
    C: { value: cia.C, from: `impact kind "${inputs.impact}"`, attested: true },
    I: { value: cia.I, from: `impact kind "${inputs.impact}"`, attested: true },
    A: { value: cia.A, from: `impact kind "${inputs.impact}"`, attested: true },
  };

  const unattested = (Object.keys(basis) as (keyof CvssParts)[]).filter((k) => !basis[k].attested);
  const score = baseScore(parts);

  if (!Number.isFinite(score) || score < 0 || score > 10) {
    return {
      ok: false,
      reason: `derived score ${String(score)} is outside 0.0–10.0, which means the arithmetic is wrong`,
      missing: ['score'],
    };
  }

  return {
    ok: true,
    vector: vectorFor(parts),
    score,
    score_text: formatScore(score),
    parts,
    basis,
    unattested,
    precondition_classes: cls,
  };
}

/** Rank a privilege-attesting phrase. "admin"/"owner" outranks a mere session. */
function privilegeRankOf(phrase: string): CvssParts['PR'] {
  const lower = phrase.toLowerCase();
  if (/admin|owner|root|governance|signer key|operator key/.test(lower)) return 'H';
  return 'L';
}

/** The strongest privilege signal wins: a declared owner requirement is PR:H. */
function maxPrivilege(values: CvssParts['PR'][]): CvssParts['PR'] {
  let best: CvssParts['PR'] = 'N';
  for (const v of values) if (PRIVILEGE_RANK[v] > PRIVILEGE_RANK[best]) best = v;
  return best;
}

/**
 * Reachability for one ledger asset. Returns null for a kind the ledger
 * vocabulary does not contain, so the caller can refuse instead of guessing
 * `network` — the most severe value.
 */
export function reachabilityOfAssetKind(kind: string): Reachability | null {
  if (typeof kind !== 'string') return null;
  const hit = ASSET_KIND_TO_REACHABILITY[kind.toLowerCase()];
  return hit ?? null;
}

/**
 * The single reachability covering a set of affected assets: the widest one
 * present, because one report describes every asset it names. Returns null when
 * any asset kind is unknown — a partial answer here would silently narrow the
 * blast radius the report describes.
 */
export function reachabilityOfAssets(kinds: readonly string[]): Reachability | null {
  const RANK: Record<Reachability, number> = { network: 3, adjacent: 2, local: 1, physical: 0 };
  let best: Reachability | null = null;
  for (const kind of kinds) {
    const r = reachabilityOfAssetKind(kind);
    if (!r) return null;
    if (best === null || RANK[r] > RANK[best]) best = r;
  }
  return best;
}
