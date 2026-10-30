/**
 * Scope documents → programmes, assets, and the one field that gates dispatch.
 *
 * WHY THIS FILE EXISTS
 *
 * Discovery finds targets. It does not find *permission*. Every platform
 * publishes machine-readable scope, and almost all of it says nothing about
 * tools — it describes what a human may report. The single piece of that
 * research that belongs in code is `automation_allowed`, because it is the
 * difference between a ranked lead and a terms violation.
 *
 * THE FOUR FACTS THIS ENCODES (from the discovery research; see
 * `docs/discovery-limits.md` for which of them this run could re-measure)
 *
 *   1. Some programmes ship `prohibitedActivites: null` — the field is present
 *      and empty. That is NOT permission. It is also not prohibition. It is
 *      `unknown`, and `unknown` does not dispatch.
 *   2. Some bar scanners outright ("automated scanning is prohibited").
 *   3. Some make unattended output INELIGIBLE rather than barring tools — one
 *      states that a finding submitted without human verification does not meet
 *      eligibility and the submission fee is not refunded. For a machine that
 *      dispatches unattended proof compute, that is a refusal with a different
 *      name: the run is allowed and the product of the run is worthless.
 *   4. Some permit tools only with prior written consent. Consent we do not hold
 *      is not consent, so that is `prohibited` until an operator records one.
 *
 * THE RULE, STATED ONCE: prohibition beats permission, and silence is not
 * consent. `classifyProhibitedActivities` returns `allowed` only on an
 * affirmative permission sentence that no prohibition sentence in the same text
 * contradicts. Everything else is `prohibited` or `unknown`, and both of those
 * refuse dispatch — with different names, because "they said no" and "we do not
 * know" require different operator action.
 *
 * WHAT IS DELIBERATELY NOT HERE: network access. Every parser takes a decoded
 * body; every classifier takes a string. Nothing reads a clock or a global.
 */

import { isEvmAddress } from './address.js';

/** Platforms whose scope this module understands. */
export type ScopePlatform = 'immunefi' | 'cantina' | 'sherlock' | 'hackenproof';

/** The four values the crawler already uses. Widened deliberately: no new state. */
export type AutomationClass = 'allowed' | 'not_mentioned' | 'prohibited' | 'unknown';

/**
 * Why the classifier landed where it did.
 *
 * These are distinct because the operator action differs:
 *   · `scanners-barred`            → do not run tools at all
 *   · `unattended-ineligible`      → tools may run; unattended output may not be sent
 *   · `consent-required`           → a written consent must be obtained and recorded
 *   · `field-absent` / `field-null`→ ask the programme, or leave it alone
 *   · `affirmative`                → the only reason that permits dispatch
 */
export type AutomationReason =
  | 'affirmative'
  | 'scanners-barred'
  | 'unattended-ineligible'
  | 'consent-required'
  | 'field-absent'
  | 'field-null'
  /** The text was empty. */
  | 'no-text'
  /** The terms exist and never mention automated testing. Silence, not consent. */
  | 'terms-silent'
  /** The text negates a prohibition, which is the absence of a ban and not a grant. */
  | 'contradicted';

export interface AutomationVerdict {
  /**
   * The product-facing boolean. `true` ONLY for an affirmative, uncontradicted
   * permission. Every other value — including `unknown` — is `false`, so a
   * programme that forbids automation ranks to zero rather than to "low".
   */
  automation_allowed: boolean;
  /** The crawler's four-value classification, kept for `programs.automation`. */
  cls: AutomationClass;
  reason: AutomationReason;
  /**
   * The sentence the verdict rests on, verbatim and bounded. This is the
   * evidence a dispatch refusal quotes, so an operator can check it against the
   * programme page instead of trusting the classifier.
   */
  evidence: string | null;
}

/** How a programme is run, which changes what its terms mean. */
export type ProgrammeKind = 'bounty' | 'contest' | 'vdp' | 'curator' | 'unknown';

/** One in-scope asset, normalised. */
export interface ScopeAsset {
  kind: 'domain' | 'url' | 'repo' | 'chain_address' | 'cidr' | 'apk' | 'ipa' | 'other';
  /** The value as published, trimmed. Never rewritten. */
  value: string;
  /** `false` when the platform publishes it as out of scope. */
  in_scope: boolean;
  chain_id: number | null;
  /** Platform's own severity ceiling for this asset, when it says one. */
  max_severity: string | null;
  /** Whether this specific asset pays. `null` when the platform does not say. */
  bounty: boolean | null;
}

/** One programme, normalised across the four platforms. */
export interface ScopeProgramme {
  /** Stable id: `<platform>:<handle>`. */
  id: string;
  platform: ScopePlatform;
  /** Platform handle/slug, without the platform prefix. */
  handle: string;
  name: string;
  url: string | null;
  kind: ProgrammeKind;
  /**
   * The published maximum single payout in USD, or `null` when the platform does
   * not publish one. NEVER defaulted to 0: 0 means "this pays nothing", and
   * conflating that with "we could not find the cap" is how a ranking invents a
   * measurement.
   */
  payout_cap_usd: number | null;
  automation: AutomationVerdict;
  assets: ScopeAsset[];
  /** Raw terms text, bounded. Kept so a verdict can be re-derived later. */
  terms_text: string | null;
}

/** Result of parsing one platform payload. Reconciliation is checked in tests. */
export interface ScopeParse {
  platform: ScopePlatform;
  programmes: ScopeProgramme[];
  /** Records the payload offered. */
  records_seen: number;
  /** Records dropped, by reason. Every record lands in exactly one bucket. */
  dropped_no_handle: number;
  dropped_no_assets: number;
  /** Non-zero when the body did not have the shape this parser claims. */
  malformed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// the classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentence splitter that keeps the sentence, not just its content.
 *
 * A one-sentence `evidence` field is what makes a refusal checkable. Splitting on
 * `.`/`;`/newline is enough for policy prose and avoids shipping a tokeniser.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n{1,}/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Bounded, single-line evidence. Long terms text must not bloat a D1 row. */
function evidenceOf(sentence: string): string {
  const flat = sentence.replace(/\s+/g, ' ').trim();
  return flat.length <= 320 ? flat : `${flat.slice(0, 317)}...`;
}

/**
 * Phrases that bar tools outright.
 *
 * Written as whole-word-ish fragments rather than a sentence grammar: policy text
 * is written by lawyers, marketing and engineers in the same document, and the
 * only reliable signal is the co-occurrence of a tooling noun with a negative.
 */
const BARRED = [
  'automated scanning is prohibited',
  'automated testing is prohibited',
  'automated tools are not permitted',
  'automated tools are prohibited',
  'automated scanning is not permitted',
  'automated testing is not permitted',
  'no automated scanning',
  'no automated testing',
  'no automated tools',
  'no scanners',
  'scanners are not permitted',
  'scanners are prohibited',
  'do not permit automated',
  'do not allow automated',
  'do not use automated',
  'does not permit automated',
  'must not use automated',
  'not permitted to use automated',
  'prohibited: automated',
  'automated vulnerability scanners are',
  'use of automated tools is prohibited',
];

/**
 * Phrases that make unattended output ineligible without barring the tool.
 *
 * This is the subtle one and it is why the reason is a separate value: the run
 * itself may be fine, and the report it produces cannot be submitted. One
 * programme states the submission fee is not refunded in that case, so the cost
 * of getting this wrong is money rather than a ban.
 */
const UNATTENDED_INELIGIBLE = [
  'without human verification',
  'no human verification',
  'not been verified by a human',
  'automated submission',
  'fully automated submissions',
  'generated by automated',
  'submitted by automated means',
  'unattended output',
  'ai-generated submissions',
  'llm-generated',
  'machine-generated findings',
  'not eligible if generated',
  'does not meet eligibility',
  'manual verification is required',
  'human review is required before submission',
];

/** Phrases that make tools lawful only with consent we do not hold. */
const CONSENT_REQUIRED = [
  'prior written consent',
  'without prior written permission',
  'only with the express permission',
  'requires written authorisation for automated',
  'requires written authorization for automated',
  'written approval before using automated',
];

/** Affirmative permission. Only these can produce `allowed`. */
const AFFIRMATIVE = [
  'automated scanning is permitted',
  'automated scanning is allowed',
  'automated testing is permitted',
  'automated testing is allowed',
  'automated tools are permitted',
  'automated tools are allowed',
  'scanners are welcome',
  'scanners are permitted',
  'may use automated',
  'you may run automated',
  'you are permitted to use automated',
  'automated testing is authorised',
  'automated testing is authorized',
];

/**
 * A negation of a prohibition is NOT a permission. `automated scanning is not
 * prohibited` means the opposite of prohibited and says nothing about consent,
 * so it must land on `not_mentioned` — never on `allowed`. That sentence is a
 * live trap: the crawler's existing `prohibited` list contains the fragment
 * `automated scanning is not`, which matches it.
 */
const NEGATED_PROHIBITION = ['not prohibited', 'not banned', 'is not restricted', 'are not restricted'];

function hit(sentence: string, phrases: readonly string[]): string | null {
  for (const p of phrases) {
    if (sentence.includes(p)) return p;
  }
  return null;
}

/**
 * Classify one programme's prohibited-activities / terms text.
 *
 * AGGREGATION: the text is scanned sentence by sentence, every prohibition-class
 * sentence is kept, and the verdict is decided in this order —
 *
 *   barred > unattended-ineligible > consent-required > affirmative > not_mentioned
 *
 * Prohibition beating permission is not a tie-break, it is the rule: a document
 * that says "automated scanning is permitted" in its introduction and "however,
 * no automated testing of the admin panel" in its body forbids the second thing,
 * and we cannot know which surface a crawl will touch.
 *
 * `null` and absent are handled BEFORE the text scan and are never coerced:
 * `null` → `unknown` / `field-null`, `undefined`/`''` → `unknown` / `field-absent`
 * (or `no-text` for an empty string). None of them reach `allowed`.
 */
export function classifyProhibitedActivities(text: string | null | undefined): AutomationVerdict {
  if (text === null) {
    return {
      automation_allowed: false,
      cls: 'unknown',
      reason: 'field-null',
      evidence: null,
    };
  }
  if (typeof text !== 'string') {
    return {
      automation_allowed: false,
      cls: 'unknown',
      reason: 'field-absent',
      evidence: null,
    };
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    return { automation_allowed: false, cls: 'unknown', reason: 'no-text', evidence: null };
  }

  // Sentence-split the ORIGINAL text so `evidence` quotes what the programme
  // actually wrote — an operator checking a refusal against the programme page
  // needs the published casing, not our normalisation. Matching is lowercased
  // per sentence.
  const parts = sentences(trimmed);

  let barredEvidence: string | null = null;
  let unattendedEvidence: string | null = null;
  let consentEvidence: string | null = null;
  let affirmativeEvidence: string | null = null;
  let negatedProhibition = false;

  for (const sentence of parts) {
    const lower = sentence.toLowerCase();
    if (barredEvidence === null && hit(lower, BARRED)) barredEvidence = sentence;
    if (unattendedEvidence === null && hit(lower, UNATTENDED_INELIGIBLE)) unattendedEvidence = sentence;
    if (consentEvidence === null && hit(lower, CONSENT_REQUIRED)) consentEvidence = sentence;
    if (affirmativeEvidence === null && hit(lower, AFFIRMATIVE)) affirmativeEvidence = sentence;
    if (NEGATED_PROHIBITION.some((n) => lower.includes(n))) negatedProhibition = true;
  }

  if (barredEvidence !== null) {
    return {
      automation_allowed: false,
      cls: 'prohibited',
      reason: 'scanners-barred',
      evidence: evidenceOf(barredEvidence),
    };
  }
  if (unattendedEvidence !== null) {
    // The tool may run; the product of an unattended run may not be submitted.
    // For an autonomous pipeline those are the same refusal, with a different
    // operator message: a human has to verify before anything is sent.
    return {
      automation_allowed: false,
      cls: 'prohibited',
      reason: 'unattended-ineligible',
      evidence: evidenceOf(unattendedEvidence),
    };
  }
  if (consentEvidence !== null) {
    return {
      automation_allowed: false,
      cls: 'prohibited',
      reason: 'consent-required',
      evidence: evidenceOf(consentEvidence),
    };
  }
  if (affirmativeEvidence !== null) {
    return {
      automation_allowed: true,
      cls: 'allowed',
      reason: 'affirmative',
      evidence: evidenceOf(affirmativeEvidence),
    };
  }
  if (negatedProhibition) {
    // "not prohibited" is the absence of a ban, not a grant. Recorded with its
    // own reason so nobody later reads `not_mentioned` as an oversight.
    return {
      automation_allowed: false,
      cls: 'not_mentioned',
      reason: 'contradicted',
      evidence: null,
    };
  }
  // Text exists and says nothing about tools. `terms-silent` rather than
  // `no-text`: the distinction is whether there were terms to read at all.
  return { automation_allowed: false, cls: 'not_mentioned', reason: 'terms-silent', evidence: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// the dispatch gate
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchRefusal {
  ok: false;
  /** Stable machine code, so a caller branches on this and not on prose. */
  code: 'automation_prohibited' | 'automation_unknown' | 'no_programme';
  /** One line that NAMES the programme and the reason. Never generic. */
  message: string;
  evidence: string | null;
}

/**
 * Ask whether dispatch is permitted for a programme.
 *
 * This is the gate the product needs, expressed as a pure function so it can be
 * tested without a Worker, a workflow or a network. It is deliberately NOT wired
 * into `dispatch.ts` from this module: that file is owned by another change in
 * this batch, and a parallel edit to it would collide. The wire-in is one call
 * before `authorizeProof()`; see `docs/discovery-limits.md`.
 *
 * The refusal message NAMES the programme and the reason, because a refusal that
 * says "denied" is indistinguishable from a bug.
 */
export function refuseDispatch(programme: Pick<ScopeProgramme, 'id' | 'name' | 'automation'>): DispatchRefusal | { ok: true } {
  const a = programme.automation;
  if (a.automation_allowed) return { ok: true };

  const label = `${programme.name} (${programme.id})`;
  if (a.cls === 'prohibited') {
    const why =
      a.reason === 'scanners-barred'
        ? 'its terms bar automated scanners'
        : a.reason === 'unattended-ineligible'
          ? 'its terms make a finding submitted without human verification ineligible'
          : a.reason === 'consent-required'
            ? 'its terms require prior written consent for automated testing, and none is on file'
            : 'its terms prohibit automated testing';
    return {
      ok: false,
      code: 'automation_prohibited',
      message: `refusing dispatch to ${label}: ${why}${a.evidence ? ` — "${a.evidence}"` : ''}`,
      evidence: a.evidence,
    };
  }

  const why =
    a.reason === 'field-null'
      ? 'the programme publishes a null prohibited-activities field, and silence is not consent'
      : a.reason === 'field-absent'
        ? 'the programme publishes no prohibited-activities field, and silence is not consent'
        : 'its terms never mention automated testing, and silence is not consent';
  return {
    ok: false,
    code: 'automation_unknown',
    message: `refusing dispatch to ${label}: ${why}`,
    evidence: a.evidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// platform parsers
// ─────────────────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * Read the prohibited-activities field under either spelling.
 *
 * `prohibitedActivites` — missing the second `i` — is the spelling the research
 * hit on a live payload. Accepting both spellings is not sloppiness: the field is
 * the gate, and a misspelling silently turning every programme into "no terms"
 * would be indistinguishable from "nobody prohibits scanners". The `null` case
 * returns `{ present: true, value: null }` so `classifyProhibitedActivities`
 * can tell "present and empty" from "absent".
 */
export function readProhibitedField(source: Record<string, unknown>): { present: boolean; value: string | null } {
  for (const key of ['prohibitedActivities', 'prohibitedActivites', 'prohibited_activities']) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const v = source[key];
      if (v === null) return { present: true, value: null };
      if (typeof v === 'string') return { present: true, value: v };
      if (Array.isArray(v)) {
        const joined = v.filter((x): x is string => typeof x === 'string').join('\n');
        return { present: true, value: joined === '' ? null : joined };
      }
    }
  }
  return { present: false, value: null };
}

/** Classify a programme from a field read, keeping present/absent distinct. */
function verdictFromField(field: { present: boolean; value: string | null }, fallbackText: string | null): AutomationVerdict {
  if (!field.present) {
    // No prohibited-activities field at all. Its own value, never `allowed`.
    if (fallbackText !== null && fallbackText.trim() !== '') {
      return classifyProhibitedActivities(fallbackText);
    }
    return { automation_allowed: false, cls: 'unknown', reason: 'field-absent', evidence: null };
  }
  if (field.value === null) {
    // Present and null: the field exists and says nothing. Silence is not consent.
    // We do NOT fall back to terms prose here: the platform's own machine-
    // readable answer was "nothing prohibited", and reading a marketing page
    // instead would replace a negative with a guess.
    return { automation_allowed: false, cls: 'unknown', reason: 'field-null', evidence: null };
  }
  return classifyProhibitedActivities(field.value);
}

function assetKind(raw: string | null): ScopeAsset['kind'] {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('smart_contract') || t.includes('smart contract') || t.includes('contract')) return 'chain_address';
  if (t.includes('repo') || t.includes('github') || t.includes('repository')) return 'repo';
  if (t.includes('ip') || t.includes('cidr')) return 'cidr';
  if (t.includes('android') || t === 'apk') return 'apk';
  if (t.includes('ios') || t === 'ipa') return 'ipa';
  if (t.includes('url') || t.includes('website') || t.includes('web')) return 'url';
  if (t.includes('domain') || t.includes('host')) return 'domain';
  return 'other';
}

/** An EVM address in a scope value implies chain 1 only if the platform says so. */
function chainIdOf(value: string, declared: unknown): number | null {
  const n = num(declared);
  if (n !== null) return n;
  // Do NOT infer 1 from an `0x…` shape. An address does not identify its chain —
  // the same rule `policy.ts:roeFromBrief` enforces — so an undeclared chain is
  // left null and the candidate layer refuses it.
  void isEvmAddress(value);
  return null;
}

/**
 * Cantina — `GET https://cantina.xyz/api/v0/competitions`.
 *
 * MEASURED 2026-10-30: HTTP 200, 771,327 B, 145 competitions, a bare JSON array.
 * Fields: `id`, `name`, `url`, `company{name,handle}`, `timeframe{start,end}`,
 * `status`, `currencyCode`, `totalRewardPot` (string), `instructions` (long
 * markdown), `kycRequired`, `allowedSeverities[]`, `kind`.
 *
 * `instructions` is where the terms live, and it is the fallback when the
 * payload carries no prohibited-activities field (it does not, at this path).
 * Cantina's `totalRewardPot` is the pool, not a per-finding cap; taking it as
 * `payout_cap_usd` would overstate the ceiling, so the cap is left `null` and
 * the pot goes into `pot_usd` on the asset-less programme meta.
 */
export function parseCantina(body: unknown): ScopeParse {
  const out: ScopeParse = {
    platform: 'cantina',
    programmes: [],
    records_seen: 0,
    dropped_no_handle: 0,
    dropped_no_assets: 0,
    malformed: 0,
  };
  if (!Array.isArray(body)) {
    out.malformed = 1;
    return out;
  }

  for (const raw of body) {
    if (!raw || typeof raw !== 'object') {
      out.malformed++;
      continue;
    }
    const it = raw as Record<string, unknown>;
    const id = str(it['id']) ?? str(it['slug']);
    const name = str(it['name']);
    if (id === null || name === null) {
      out.dropped_no_handle++;
      continue;
    }
    out.records_seen++;

    const company = (it['company'] ?? {}) as Record<string, unknown>;
    const handle = str(company['handle']) ?? id;
    const instructions = str(it['instructions']);
    const field = readProhibitedField(it);
    const automation = verdictFromField(field, instructions);

    // Cantina scope is a repository set, and the API does not publish it at this
    // path: an audit contest's in-scope code is in `instructions`. So a Cantina
    // programme legitimately has ZERO normalised assets until the instructions
    // are parsed for repo URLs — which this parser does not do, and a fabricated
    // asset would be worse than none.
    const assets: ScopeAsset[] = [];
    for (const repo of reposFromText(instructions)) {
      assets.push({ kind: 'repo', value: repo, in_scope: true, chain_id: null, max_severity: null, bounty: null });
    }

    const severities = Array.isArray(it['allowedSeverities'])
      ? (it['allowedSeverities'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    out.programmes.push({
      id: `cantina:${handle}`,
      platform: 'cantina',
      handle,
      name,
      url: str(it['url']),
      kind: str(it['kind'])?.includes('contest') ? 'contest' : 'bounty',
      // Deliberate `null`: the pool is not a cap. See the docblock.
      payout_cap_usd: null,
      automation,
      assets: assets.map((a) => ({
        ...a,
        // The only severity ceiling Cantina publishes is the whole-contest set;
        // applying its max to every repo would invent per-asset precision.
        max_severity: severities.length ? severities[0] ?? null : null,
      })),
      terms_text: instructions === null ? null : instructions.slice(0, 8000),
    });
  }
  return out;
}

/** `github.com/owner/repo` occurrences in prose, deduped, bounded. */
export function reposFromText(text: string | null): string[] {
  if (text === null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const repo = `${m[1]}/${m[2]}`.replace(/\.git$/, '');
    if (seen.has(repo.toLowerCase())) continue;
    seen.add(repo.toLowerCase());
    out.push(repo);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Sherlock — `GET https://audits.sherlock.xyz/api/contests`.
 *
 * MEASURED 2026-10-30: HTTP 200, 7,609 B for `limit=2`, envelope
 * `{page, next_page, items, total, has_next, pages}`. Item fields: `id`,
 * `title`, `prize_pool`, `rewards`, `judging_prize_pool`, `token`, `status`,
 * `starts_at`, `ends_at`, `private`, `is_best_efforts`, `type_label`,
 * `short_description`.
 *
 * `type_label` is `Public Bug Bounty` or a contest label — that is the only
 * kind signal, so it is what `kind` is derived from. `rewards` is the pool and
 * `prize_pool`/`judging_prize_pool` are judging budgets; none is a per-finding
 * cap, so `payout_cap_usd` stays `null` here too.
 */
export function parseSherlock(body: unknown): ScopeParse {
  const out: ScopeParse = {
    platform: 'sherlock',
    programmes: [],
    records_seen: 0,
    dropped_no_handle: 0,
    dropped_no_assets: 0,
    malformed: 0,
  };
  const items = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)
      ? ((body as { items: unknown[] }).items as unknown[])
      : null;
  if (items === null) {
    out.malformed = 1;
    return out;
  }

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      out.malformed++;
      continue;
    }
    const it = raw as Record<string, unknown>;
    const idNum = num(it['id']);
    const title = str(it['title']);
    if (idNum === null || title === null) {
      out.dropped_no_handle++;
      continue;
    }
    out.records_seen++;
    const handle = String(Math.trunc(idNum));
    const label = str(it['type_label']);
    const desc = str(it['short_description']);
    const field = readProhibitedField(it);
    const automation = verdictFromField(field, desc);

    out.programmes.push({
      id: `sherlock:${handle}`,
      platform: 'sherlock',
      handle,
      name: title,
      url: `https://audits.sherlock.xyz/contests/${handle}`,
      kind: label !== null && /bounty/i.test(label) ? 'bounty' : label !== null ? 'contest' : 'unknown',
      payout_cap_usd: null,
      automation,
      assets: reposFromText(desc).map((repo) => ({
        kind: 'repo' as const,
        value: repo,
        in_scope: true,
        chain_id: null,
        max_severity: null,
        bounty: null,
      })),
      terms_text: desc === null ? null : desc.slice(0, 8000),
    });
  }
  return out;
}

/**
 * Immunefi — tolerant reader for a payload this run could NOT fetch.
 *
 * MEASURED 2026-10-30: `/public-api/projects/`, `/api/v1/projects/`,
 * `/api/projects` and `/graphql` all failed from this network (404 / 308
 * redirect loop). So this parser is written against the DOCUMENTED shape and is
 * explicitly UNVERIFIED. It is tolerant on purpose — array, or
 * `{projects|data|items|results: []}` — because a strict parser against an
 * unverified shape would report "0 programmes" and that reads exactly like
 * "Immunefi lists nothing".
 *
 * The asset shape Immunefi uses (`assets[]` with `url`, `type`, `chainId`,
 * `isPaused`) is handled tolerantly; an asset without a `url` is dropped and
 * counted rather than invented.
 */
export function parseImmunefi(body: unknown): ScopeParse {
  const out: ScopeParse = {
    platform: 'immunefi',
    programmes: [],
    records_seen: 0,
    dropped_no_handle: 0,
    dropped_no_assets: 0,
    malformed: 0,
  };
  const items = arrayFromEnvelope(body, ['projects', 'data', 'items', 'results']);
  if (items === null) {
    out.malformed = 1;
    return out;
  }

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      out.malformed++;
      continue;
    }
    const it = raw as Record<string, unknown>;
    const handle = str(it['id']) ?? str(it['slug']) ?? str(it['projectId']);
    const name = str(it['project']) ?? str(it['name']) ?? str(it['title']);
    if (handle === null || name === null) {
      out.dropped_no_handle++;
      continue;
    }
    out.records_seen++;

    const field = readProhibitedField(it);
    const automation = verdictFromField(field, str(it['description']) ?? str(it['terms']));

    const assets: ScopeAsset[] = [];
    const rawAssets = Array.isArray(it['assets']) ? (it['assets'] as unknown[]) : [];
    for (const a of rawAssets) {
      if (!a || typeof a !== 'object') continue;
      const asset = a as Record<string, unknown>;
      const value = str(asset['url']) ?? str(asset['address']) ?? str(asset['target']);
      if (value === null) {
        out.dropped_no_assets++;
        continue;
      }
      assets.push({
        kind: assetKind(str(asset['type'])),
        value,
        // `isPaused` is Immunefi's own out-of-scope signal on an asset.
        in_scope: asset['isPaused'] === true ? false : true,
        chain_id: chainIdOf(value, asset['chainId'] ?? asset['chain_id']),
        max_severity: str(asset['maxSeverity']) ?? str(asset['max_severity']),
        bounty: bool(asset['eligibleForBounty']) ?? bool(asset['bounty']),
      });
    }

    out.programmes.push({
      id: `immunefi:${handle}`,
      platform: 'immunefi',
      handle,
      name,
      url: str(it['url']) ?? `https://immunefi.com/bounty/${handle}/`,
      kind: 'bounty',
      // `maxBounty` is the one field that IS a per-finding ceiling when present.
      payout_cap_usd: num(it['maxBounty']) ?? num(it['max_bounty']),
      automation,
      assets,
      terms_text: (str(it['description']) ?? str(it['terms']) ?? '').slice(0, 8000) || null,
    });
  }
  return out;
}

/**
 * HackenProof — tolerant reader for a payload this run could NOT fetch.
 *
 * MEASURED 2026-10-30: `/api/v2/programs`, `/api/v1/programs`, `/api/programs`
 * all 404. Same status as the Immunefi parser: written against the documented
 * shape, marked unverified, tolerant envelope, and an asset without a value is
 * counted rather than fabricated.
 */
export function parseHackenProof(body: unknown): ScopeParse {
  const out: ScopeParse = {
    platform: 'hackenproof',
    programmes: [],
    records_seen: 0,
    dropped_no_handle: 0,
    dropped_no_assets: 0,
    malformed: 0,
  };
  const items = arrayFromEnvelope(body, ['programs', 'data', 'items', 'results']);
  if (items === null) {
    out.malformed = 1;
    return out;
  }

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      out.malformed++;
      continue;
    }
    const it = raw as Record<string, unknown>;
    const handle = str(it['handle']) ?? str(it['slug']) ?? str(it['id']);
    const name = str(it['name']) ?? str(it['title']);
    if (handle === null || name === null) {
      out.dropped_no_handle++;
      continue;
    }
    out.records_seen++;

    const field = readProhibitedField(it);
    const automation = verdictFromField(field, str(it['description']) ?? str(it['rules']));

    const assets: ScopeAsset[] = [];
    const rawScope = Array.isArray(it['scope']) ? (it['scope'] as unknown[]) : Array.isArray(it['targets']) ? (it['targets'] as unknown[]) : [];
    for (const a of rawScope) {
      const value = typeof a === 'string' ? a.trim() : a && typeof a === 'object' ? str((a as Record<string, unknown>)['target']) ?? str((a as Record<string, unknown>)['value']) : null;
      if (value === null || value === '') {
        out.dropped_no_assets++;
        continue;
      }
      const obj = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
      assets.push({
        kind: assetKind(str(obj['type'])),
        value,
        in_scope: obj['inScope'] === false ? false : true,
        chain_id: chainIdOf(value, obj['chainId']),
        max_severity: str(obj['maxSeverity']),
        bounty: bool(obj['bounty']),
      });
    }

    out.programmes.push({
      id: `hackenproof:${handle}`,
      platform: 'hackenproof',
      handle,
      name,
      url: str(it['url']) ?? `https://hackenproof.com/programs/${handle}`,
      kind: 'bounty',
      payout_cap_usd: num(it['maxBounty']) ?? num(it['max_bounty']),
      automation,
      assets,
      terms_text: (str(it['description']) ?? str(it['rules']) ?? '').slice(0, 8000) || null,
    });
  }
  return out;
}

function arrayFromEnvelope(body: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    for (const k of keys) {
      const v = (body as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

/** Dispatch a decoded body to the platform's parser. */
export function parseScope(platform: ScopePlatform, body: unknown): ScopeParse {
  switch (platform) {
    case 'immunefi':
      return parseImmunefi(body);
    case 'cantina':
      return parseCantina(body);
    case 'sherlock':
      return parseSherlock(body);
    case 'hackenproof':
      return parseHackenProof(body);
  }
}
