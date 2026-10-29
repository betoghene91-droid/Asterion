/**
 * Intake enrichment — the model, in the intake path, on a leash.
 *
 * WHY THIS FILE EXISTS
 *
 * `llm.ts` was built, tested and complete: a local-GPU-first provider router,
 * per-call token logging, and a daily budget. Nothing called it. `intake.ts`
 * compiled every brief with regexes alone, and `index.ts` kept the import alive
 * with `void ask;` so the unused-symbol check stayed quiet. The deterministic
 * parser is genuinely good, which is exactly why the dead router went unnoticed
 * for so long: the product worked.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 * It does not replace the parser. `compile()` in `intake.ts` remains the FLOOR.
 * The contract, in order:
 *
 *   1. Run the deterministic compile FIRST. It always produces the base result,
 *      and that result is what ships unless the model demonstrably improves it.
 *   2. Ask the model for a narrow JSON patch describing fields the parser may
 *      have missed or mis-set.
 *   3. Validate that patch structurally against the operator's own text. An
 *      invented host, address, class or playbook is DROPPED, not trusted.
 *   4. Re-run the deterministic compile with the surviving fields as `answers`,
 *      so every downstream invariant (playbook mutability filtering, question
 *      generation, title shape, out-of-scope carry-through) is still enforced by
 *      the code that has always enforced it.
 *   5. On any failure — no provider, exhausted budget, junk JSON, timeout, a
 *      patch that fails validation, or an enriched brief that is somehow
 *      worse-formed than the base — return the base result unchanged.
 *
 * The last clause is the important one. An enrichment step that can make a brief
 * worse is not an improvement; it is a new source of malformed engagements. So
 * the fallback here is not "best effort", it is byte-identical to the behaviour
 * that shipped before this file existed. The regression test asserts exactly
 * that, with deepEqual against a frozen baseline fixture.
 *
 * WHAT COUNTS AS VALIDATION, AND WHY IT IS NOT A PROMPT INSTRUCTION
 *
 * "Please only return targets from my text" is a request, not a control. The
 * control is `validatePatch()` below, which:
 *
 *   - extracts targets from the operator's raw text and from the model's
 *     proposed targets, and requires every proposed target to be PRESENT in the
 *     raw text (or to be a normalisation of a present one: trailing slash, case,
 *     default port, scheme). A target the operator never typed cannot enter.
 *   - rejects any class the text does not support. `inferClass()` re-derives the
 *     class from the operator's own words; a model-suggested class must match it
 *     or be dropped. This is deliberately strict: class decides which playbooks
 *     run and which proof path exists, so a hallucinated class is the most
 *     expensive thing a model can smuggle in.
 *   - rejects any playbook id that `PLAYBOOKS` does not contain, and any
 *     playbook whose class is not the resolved class.
 *
 * Everything rejected is recorded on `Enrichment.dropped` with a reason, so the
 * operator and the ledger can see what the model tried and what was refused.
 */

import { ask, LlmUnavailable, parseJson, approxTokens, type Env as LlmEnv, type Msg } from './llm.js';
import {
  compile,
  extractTargets,
  inferClass,
  type Brief,
  type Question,
} from './intake.js';
import { PLAYBOOKS, type Cls, type Mut } from './playbooks.js';

/** What `compile()` returns. Re-declared so this module never drifts from it. */
export type CompileResult = { brief: Brief } | { questions: Question[] };

export interface CompileCtx {
  program_id: string;
  authorization_ref: string;
  scope_hints: string[];
  out_of_scope?: string[];
}

/**
 * The subset of the model's answer we are willing to consider. Everything is
 * optional: a patch that only repairs `targets` is the common, useful case.
 */
interface RawPatch {
  targets?: unknown;
  cls?: unknown;
  depth?: unknown;
  title?: unknown;
}

export interface Enrichment {
  /** What actually ships. Identical to the deterministic result on any failure. */
  result: CompileResult;
  /** True only when a validated model patch changed the outcome. */
  enriched: boolean;
  /** Machine-readable reason the model contributed nothing. Never empty on a miss. */
  skipped: string | null;
  /** Fields the model proposed that validation refused, with why. */
  dropped: { field: string; value: string; why: string }[];
  /** Provider/model that answered, when one did. */
  provider: string | null;
  tokens: number;
  latencyMs: number;
}

export interface EnrichOpts {
  /**
   * Kill switch. Defaults to ON: the whole point of this patch is that the model
   * is actually used, not parked behind a flag nobody ever sets. An operator who
   * wants the old behaviour sets `ASTERION_LLM_INTAKE=off`.
   */
  enabled?: boolean;
  /** Injectable for tests; production passes `ask`. */
  askFn?: typeof ask;
  /** Injected clock, so the budget-exhausted test needs no sleeping. */
  now?: () => number;
  /** Bound on the model call. A hung provider must not hang intake. */
  timeoutMs?: number;
}

/** Env var that controls the feature. Read once, defaulting to enabled. */
export const INTAKE_FLAG = 'ASTERION_LLM_INTAKE';

export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * The flag is ON unless explicitly disabled. Accepts the forms an operator will
 * actually type in `wrangler.toml` / a Worker secret.
 */
export function intakeEnabled(env: { [INTAKE_FLAG]?: string } | undefined): boolean {
  const raw = env?.[INTAKE_FLAG];
  if (raw === undefined || raw === null || raw === '') return true;
  return !/^(0|false|off|no|disabled)$/i.test(String(raw).trim());
}

/**
 * The prompt. Deliberately narrow: it asks for field extraction and repair, and
 * states the two rules that validation will enforce anyway. The rules are stated
 * for the model's benefit (it improves the answer rate) but they are NOT the
 * control — `validatePatch()` is, and it does not read this string.
 */
function buildMessages(raw: string, base: Brief | null, questions: Question[] | null): Msg[] {
  const known = base
    ? [
        `targets already extracted: ${JSON.stringify(base.targets)}`,
        `class already inferred: ${base.cls}`,
        `mutability: ${base.max_mutability}`,
        `playbooks already selected: ${JSON.stringify(base.playbooks)}`,
      ].join('\n')
    : `the deterministic parser produced no brief; it is asking: ${JSON.stringify(
        (questions ?? []).map((q) => q.key),
      )}`;

  return [
    {
      role: 'system',
      content: [
        'You extract structured fields from a security-researcher request.',
        'Reply with ONE JSON object and nothing else. Allowed keys:',
        '  "targets": array of strings — hosts, URLs or 0x addresses the user explicitly named',
        '  "cls": one of "web2", "solidity", "infra"',
        '  "depth": one of "recon", "shallow", "deep", "active"',
        '  "title": a short label, max 80 chars',
        'Omit any key you are not confident about. Never invent a target, a class,',
        'a hostname or an address that does not appear in the user text.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'USER TEXT:',
        raw.slice(0, 4000),
        '',
        'CURRENT DETERMINISTIC RESULT:',
        known,
      ].join('\n'),
    },
  ];
}

/** Strip scheme, trailing slash, default port and case, for comparison only. */
function normaliseTarget(t: string): string {
  let s = t.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/:(80|443)$/, '');
  return s;
}

/**
 * Is `candidate` grounded in the operator's own text?
 *
 * Grounded means: the candidate, normalised, appears LITERALLY in the raw text
 * (also normalised). This is deliberately checked against the operator's text and
 * NOT against `extractTargets(raw)`.
 *
 * The reason is the whole point of having a model here. The deterministic
 * extractor has real gaps — measured, not assumed: it does not match a bare IPv4
 * address at all (`10.20.30.40` yields zero targets, because its domain pattern
 * requires an alphabetic TLD), and it truncates a hyphenated host with a port
 * (`db.internal-host:5432` yields `db.internal`). Recovering exactly those cases
 * is the highest-value repair this patch can offer.
 *
 * If grounding were defined as "must already be in extractTargets output", a
 * target the operator plainly typed would be rejected purely because the parser
 * missed it — the repair would be impossible by construction, and the model
 * would be reduced to agreeing with the regex. Anchoring to the raw text keeps
 * the security property (nothing the operator did not type can enter) while
 * leaving room to fix what the regex drops.
 */
function groundedInText(candidate: string, raw: string): boolean {
  const c = normaliseTarget(candidate);
  if (!c) return false;
  // A four-character candidate would match by accident inside ordinary prose.
  if (c.length < 4) return false;
  const haystack = normaliseTarget(raw).replace(/\s+/g, ' ');
  // Compare on a boundary-safe basis: the candidate must not be a substring of a
  // longer identifier (`acme.com` inside `evil-acme.com`), so require the
  // characters on either side to be non-hostname characters.
  const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9._-])${escaped}(?=$|[^a-z0-9._-])`, 'i');
  return re.test(haystack);
}

const CLASSES: Cls[] = ['web2', 'solidity', 'infra'];
const DEPTHS = ['recon', 'shallow', 'deep', 'active'];

/**
 * Does this string have the SHAPE of a target?
 *
 * Separate from grounding on purpose. Grounding answers "did the operator type
 * this?"; shape answers "is it addressable at all?". A model can satisfy the
 * first and fail the second (it proposes the word `please` because that token is
 * in the text), and both checks are cheap.
 */
export function hasTargetShape(t: string): boolean {
  const s = t.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return true;
  // A bare IPv4. Included because the deterministic extractor cannot produce
  // one: `extractTargets()` requires an alphabetic TLD, so `10.20.30.40` never
  // becomes a target. This is the main repair the model is here to make.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(s)) return true;
  // A hostname with an optional port and optional path. The TLD may be alphabetic
  // OR the label set may look like an internal name (`db.internal-host`), which
  // the regex extractor also mishandles.
  const hostPort = s.replace(/:\d{1,5}$/, '').replace(/\/.*$/, '');
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(hostPort);
}

export interface ValidatedPatch {
  answers: Partial<Record<'target' | 'class' | 'depth', string>>;
  dropped: { field: string; value: string; why: string }[];
}

/**
 * Turn a model reply into compile() `answers`, keeping only grounded fields.
 *
 * This is the security boundary of the whole patch. It is a pure function of
 * (reply, operator text) so it is directly testable with hostile inputs.
 */
export function validatePatch(reply: unknown, raw: string, baseCls: Cls): ValidatedPatch {
  const dropped: ValidatedPatch['dropped'] = [];
  const answers: ValidatedPatch['answers'] = {};
  if (typeof reply !== 'object' || reply === null) {
    return { answers, dropped: [{ field: '*', value: String(reply).slice(0, 60), why: 'reply was not a JSON object' }] };
  }

  const patch = reply as RawPatch;

  // ── targets ──────────────────────────────────────────────────────────────
  if (patch.targets !== undefined) {
    if (!Array.isArray(patch.targets)) {
      dropped.push({ field: 'targets', value: String(patch.targets).slice(0, 60), why: 'not an array' });
    } else {
      const kept: string[] = [];
      for (const t of patch.targets.slice(0, 12)) {
        if (typeof t !== 'string' || !t.trim()) {
          dropped.push({ field: 'targets', value: String(t).slice(0, 60), why: 'not a non-empty string' });
          continue;
        }
        // A target must be grounded in the operator's text, and must look like a
        // target at all. Both checks are needed: grounding alone would admit a
        // bare word the operator happened to type, and shape alone would admit an
        // invented host.
        if (!groundedInText(t, raw)) {
          dropped.push({ field: 'targets', value: t.slice(0, 80), why: 'not present in the operator text' });
          continue;
        }
        if (!hasTargetShape(t)) {
          dropped.push({ field: 'targets', value: t.slice(0, 80), why: 'does not have the shape of a host, URL or address' });
          continue;
        }
        if (!kept.includes(t)) kept.push(t);
      }
      // compose() accepts a single `answers.target`, so a multi-target repair is
      // expressed by preferring the first; the rest stay visible in `dropped` as
      // unused rather than being silently discarded.
      if (kept.length) {
        answers.target = kept[0]!;
        for (const extra of kept.slice(1)) {
          dropped.push({
            field: 'targets',
            value: extra.slice(0, 80),
            why: 'valid but compile() takes one target answer; kept the first',
          });
        }
      }
    }
  }

  // ── class ────────────────────────────────────────────────────────────────
  // Class decides the playbooks AND whether a proof path exists, so it is held
  // to the strictest rule: the model may only agree with the deterministic
  // classifier, never overrule it from thin air.
  if (patch.cls !== undefined) {
    const c = typeof patch.cls === 'string' ? patch.cls.trim().toLowerCase() : '';
    if (!CLASSES.includes(c as Cls)) {
      dropped.push({ field: 'cls', value: String(patch.cls).slice(0, 40), why: 'not one of web2/solidity/infra' });
    } else if (c !== baseCls) {
      dropped.push({
        field: 'cls',
        value: c,
        why: `disagrees with the deterministic classifier (${baseCls}); class decides the proof path, so the text wins`,
      });
    } else {
      answers.class = c;
    }
  }

  // ── depth ────────────────────────────────────────────────────────────────
  if (patch.depth !== undefined) {
    const d = typeof patch.depth === 'string' ? patch.depth.trim().toLowerCase() : '';
    if (!DEPTHS.includes(d)) {
      dropped.push({ field: 'depth', value: String(patch.depth).slice(0, 40), why: 'not one of recon/shallow/deep/active' });
    } else {
      answers.depth = d;
    }
  }

  // ── playbooks ────────────────────────────────────────────────────────────
  // Not accepted from the model at all. Playbook selection is `route()` +
  // `pickPlaybooks()`, which enforce the mutability ceiling; a model-named
  // playbook would bypass that ceiling. Recorded as dropped for transparency
  // when a model volunteers one under any key we might later add.
  const anyPatch = patch as Record<string, unknown>;
  if (anyPatch['playbooks'] !== undefined) {
    dropped.push({
      field: 'playbooks',
      value: JSON.stringify(anyPatch['playbooks']).slice(0, 80),
      why: 'playbook selection is not delegated to the model (mutability ceiling is enforced by pickPlaybooks)',
    });
  }

  return { answers, dropped };
}

/**
 * Is `candidate` at least as well-formed as `base`?
 *
 * This is the guard that makes "never worse" a checked property instead of a
 * hope. A brief must keep a target, a known class, a non-empty playbook list and
 * a legal mutability. Anything that loses one of those is discarded in favour of
 * the base result.
 */
export function atLeastAsGood(candidate: CompileResult, base: CompileResult): boolean {
  if (!('brief' in candidate)) return false;
  if (!('brief' in base)) {
    // Base was asking questions; a brief is strictly more progress, but only if
    // it is itself complete.
    return (
      candidate.brief.targets.length > 0 &&
      candidate.brief.playbooks.length > 0 &&
      CLASSES.includes(candidate.brief.cls)
    );
  }
  const a = candidate.brief;
  const b = base.brief;
  const muts: Mut[] = ['read', 'simulate', 'mutate', 'destructive'];
  return (
    a.targets.length > 0 &&
    CLASSES.includes(a.cls) &&
    a.playbooks.length > 0 &&
    muts.includes(a.max_mutability) &&
    a.targets.length >= b.targets.length &&
    a.playbooks.length >= b.playbooks.length &&
    // The time box must not silently shrink: a model that returns "recon" for a
    // deep request would cut the operator's budget by 6x.
    a.time_box_minutes >= b.time_box_minutes
  );
}

/** Reject a promise that takes too long, without leaking a timer. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LlmUnavailable(`intake enrichment timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Compile a brief, and let a model repair it when it can.
 *
 * The signature mirrors `compile()` plus an env and options, so the caller in
 * `index.ts` changes by one function name.
 */
export async function compileWithEnrichment(
  env: LlmEnv,
  raw: string,
  ctx: CompileCtx,
  answers: Partial<Record<string, string>> = {},
  opts: EnrichOpts = {},
): Promise<Enrichment> {
  const base = compile(raw, ctx, answers);

  const miss = (skipped: string, extra: Partial<Enrichment> = {}): Enrichment => ({
    result: base,
    enriched: false,
    skipped,
    dropped: [],
    provider: null,
    tokens: 0,
    latencyMs: 0,
    ...extra,
  });

  // An operator who already answered a follow-up question has given an explicit
  // instruction. Do not let a model talk over it.
  if (Object.keys(answers).length > 0) return miss('operator answers present; deterministic compile is authoritative');

  const enabled = opts.enabled ?? intakeEnabled(env as unknown as { [INTAKE_FLAG]?: string });
  if (!enabled) return miss(`disabled via ${INTAKE_FLAG}`);

  // NOTE ON COST: there is deliberately NO "this text looks good enough, skip the
  // model" pre-check here.
  //
  // An earlier draft had one, and it was wrong for the product, not just for the
  // tests. The deterministic brief can be complete-looking and still wrong —
  // measured: `check db.internal-host:5432` yields the brief target `db.internal`
  // (the extractor stops at the hyphen), which is a well-formed brief for the
  // wrong host. A "looks complete" gate would refuse the model exactly the case
  // worth repairing, and the operator would get a confident engagement against a
  // host that does not exist.
  //
  // Cost is bounded by other means, none of which can misfire on a good brief:
  //   · DAILY_LLM_BUDGET is enforced inside ask() and degrades to this same floor
  //   · one attempt only, never a retry loop
  //   · maxTokens 400, temperature 0
  //   · a reply that merely agrees with the parser is reported as not enriched,
  //     so "enriched" stays a real signal rather than noise

  const askFn = opts.askFn ?? ask;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const baseBrief = 'brief' in base ? base.brief : null;
  const baseQuestions = 'questions' in base ? base.questions : null;
  const baseCls: Cls = baseBrief ? baseBrief.cls : inferClass(extractTargets(raw), raw);

  let reply: unknown;
  let provider: string | null = null;
  let tokens = 0;
  let latencyMs = 0;

  try {
    const r = await withTimeout(
      askFn(env, buildMessages(raw, baseBrief, baseQuestions), {
        json: true,
        maxTokens: 400,
        temperature: 0,
      }),
      timeoutMs,
    );
    provider = r.provider;
    tokens = r.tokensIn + r.tokensOut;
    latencyMs = r.latencyMs;
    reply = parseJson<unknown>(r.text);
    if (reply === null) {
      // parseJson returns null for anything that is not JSON at all. A model
      // that answers in prose has contributed nothing; that is a miss, not an
      // error worth surfacing as one.
      return miss('model reply was not parseable JSON', { provider, tokens, latencyMs });
    }
  } catch (e) {
    const msg = e instanceof LlmUnavailable ? e.message : e instanceof Error ? e.message : String(e);
    // Budget exhaustion, no provider, timeout: all the same to the operator.
    // Not a retry loop — one attempt, then the floor stands.
    return miss(`model unavailable: ${msg.slice(0, 200)}`, { provider, tokens, latencyMs });
  }

  const { answers: patch, dropped } = validatePatch(reply, raw, baseCls);
  if (Object.keys(patch).length === 0) {
    return miss('no field in the model reply survived validation', { provider, tokens, latencyMs, dropped });
  }

  // Re-run the REAL compiler with the validated fields, so every invariant is
  // still enforced by intake.ts rather than by this module.
  let candidate: CompileResult;
  try {
    candidate = compile(raw, ctx, patch);
  } catch (e) {
    return miss(`enriched compile threw: ${(e as Error).message}`, { provider, tokens, latencyMs, dropped });
  }

  if (!atLeastAsGood(candidate, base)) {
    return miss('enriched brief was not at least as well-formed as the deterministic one', {
      provider,
      tokens,
      latencyMs,
      dropped,
    });
  }

  // A patch that changes nothing is a miss, not an enrichment. Saying otherwise
  // would make the `enriched` flag useless as an audit signal.
  if (JSON.stringify(candidate) === JSON.stringify(base)) {
    return miss('model agreed with the deterministic result; nothing changed', {
      provider,
      tokens,
      latencyMs,
      dropped,
    });
  }

  return { result: candidate, enriched: true, skipped: null, dropped, provider, tokens, latencyMs };
}

/**
 * Cheap heuristic: does this look like the sloppy prose a model is most useful
 * for?
 *
 * ADVISORY ONLY. Nothing in the compile path branches on this, and that is
 * deliberate — see the note in `compileWithEnrichment`. It is exported so an
 * operator or a future router can use it to prioritise a queue, and kept honest
 * by tests, but using it as a gate is what broke the `db.internal-host:5432`
 * repair case.
 */
export function looksSloppy(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 12) return false;
  const hasTarget = extractTargets(t).length > 0;
  // No target at all is the highest-value repair case.
  if (!hasTarget) return true;
  // Prose with a target but no recognisable intent word is the second.
  return !/\b(recon|check|hunt|test|audit|look|review|exploit|prove|scan|dig)\b/i.test(t);
}

/** One line for the ledger / operator: what the model did, or why it did not. */
export function describeEnrichment(e: Enrichment): string {
  if (e.enriched) {
    const bits = [`llm enriched intake via ${e.provider ?? 'unknown'}`, `${e.tokens} tokens`, `${e.latencyMs}ms`];
    if (e.dropped.length) bits.push(`${e.dropped.length} proposed field(s) rejected`);
    return bits.join(' · ');
  }
  return `deterministic brief (${e.skipped ?? 'no reason recorded'})`;
}

/** Playbook ids, exported so a caller can assert the model never widened them. */
export const PLAYBOOK_IDS = PLAYBOOKS.map((p) => p.id);

/** Rough cost of the enrichment prompt, so a caller can pre-check the budget. */
export function estimatedPromptTokens(raw: string): number {
  return approxTokens(raw.slice(0, 4000)) + 180;
}
