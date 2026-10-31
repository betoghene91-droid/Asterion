/**
 * Outbound request pacing — one rate, turned into a spacing rule.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT A CONSTANT
 *
 * `desk/types.ts` used to describe `FLOW_SAMPLE.rateLimitRps` as "Programme rate
 * limit from the RoE ... Enforced, not assumed". Both halves of that were wrong:
 * the value was a hardcoded 3 that had never been read from any RoE, and
 * `policy.ts` stamped `rate_limit_rps: 3` onto every engagement while nothing in
 * the codebase read the field back. So an engagement could declare a rate, the
 * brief could carry it, the RoE could store it — and the only thing that ever
 * spaced a request read a constant. A declaration nothing honours is worse than
 * no declaration, because the doc comment then tells the reader it is honoured.
 *
 * WHAT IS HONEST HERE
 *
 * A rate limit is a property of a TARGET, so it can only be honoured by code that
 * knows which target it is talking to. That is `rateLimitForBrief()`: given a
 * brief, it yields the pace that governs requests made on that engagement's
 * behalf. `pacerFor()` is the mechanism; this module deliberately does not decide
 * which call sites use it — that decision belongs to the caller, and faking it
 * from here would recreate exactly the bug this file exists to remove.
 *
 * The current, checked answer to "which outbound paths are engagement-scoped" is
 * in `src/desk/flow.ts` and `src/dispatch.ts`, both of which state it at the call
 * site. In short: almost none. Naming that plainly is part of the fix.
 */

import type { Brief } from './intake.js';

/**
 * The rate used when a brief declares none.
 *
 * 3 is not a new choice — it is the number `roeFromBrief` has always stamped and
 * the number `FLOW_SAMPLE.rateLimitRps` has always held. Keeping it as the
 * default means no existing caller, stored brief or test changes behaviour.
 */
export const RATE_LIMIT_RPS_DEFAULT = 3;

/**
 * The slowest rate this system will accept, in requests per second.
 *
 * 0.1 rps is one request every ten seconds. Slower than that, a single Worker
 * invocation cannot make even two paced requests before it has to return, so the
 * number stops being a rate the code can honour and becomes a rate it can only
 * pretend to. A value below it is CLAMPED UP to it — still far slower than the
 * default, so the clamp never makes anything faster than the operator asked for
 * in spirit.
 */
export const RATE_LIMIT_RPS_MIN = 0.1;

/**
 * The fastest rate this system will accept, in requests per second.
 *
 * WHY 20, AND WHY THE CLAMP GOES DOWN
 *
 * Three independent ceilings make anything above 20 meaningless here, and the
 * smallest one wins:
 *
 *  1. **The invocation's subrequest budget.** The Workers free plan allows 50
 *     subrequests per invocation (`desk/types.ts` discusses the same ceiling for
 *     the flow sample, and `discovery.ts` already spends 40 of them). At 20 rps
 *     those 50 requests are exhausted in 2.5 seconds. A declared rate of 200 is
 *     indistinguishable from 20 in every code path that could enforce it, because
 *     the loop is over long before the spacing matters.
 *  2. **Politeness to a public RPC.** 429-rate-limiting starts well below this on
 *     the free endpoints this Worker uses; a rate above 20 is not a politeness
 *     budget, it is "as fast as possible" written as a number.
 *  3. **Real programme limits.** Published limits the desk would ever meet are
 *     1–10 rps. A number above 20 is far more likely to be a typo or an injected
 *     value than a real declaration.
 *
 * The clamp direction is the load-bearing part. A nonsense-large rate must never
 * degrade to "unlimited", so it clamps DOWN to the fastest rate that can still be
 * honoured. Clamping up would be the original bug with extra steps.
 */
export const RATE_LIMIT_RPS_MAX = 20;

/** Where a pace came from, so a caller can say so instead of implying precision. */
export type RateSource = 'declared' | 'default' | 'clamped-up' | 'clamped-down';

export interface RateDecision {
  /** The rate to use, always finite and inside [MIN, MAX]. */
  rps: number;
  /** The number that was asked for, or null when none was. */
  requested: number | null;
  source: RateSource;
  /** One line an operator can read. Never claims enforcement it does not have. */
  why: string;
}

/**
 * Turn anything into a usable rate.
 *
 * CLAMP, NOT THROW, and that is a deliberate choice worth stating: refusing an
 * entire engagement because a rate was mistyped would make a bad number cost the
 * operator their whole hunt, whereas pacing it at the safest defensible rate
 * keeps the work correct and simply slower. What is NOT acceptable is the third
 * option — accepting the number and not honouring it — which is what the code did
 * before this function existed.
 *
 * The one thing a bad value must never do is become FASTER than the default,
 * because "I could not read your limit" is not permission.
 */
export function normalizeRateLimitRps(raw: unknown): RateDecision {
  if (raw === undefined || raw === null) {
    return {
      rps: RATE_LIMIT_RPS_DEFAULT,
      requested: null,
      source: 'default',
      why: `no rate declared, using the ${RATE_LIMIT_RPS_DEFAULT} rps default`,
    };
  }

  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;

  // Non-finite, unparseable, zero and negative all collapse to the same answer.
  // None of them describes a rate, and the one interpretation that must be
  // impossible is "unlimited": the old code's failure mode was a global constant
  // silently standing in for the declared value, and "0 means go as fast as you
  // like" would be that failure with a worse blast radius.
  if (!Number.isFinite(n) || n <= 0) {
    return {
      rps: RATE_LIMIT_RPS_DEFAULT,
      requested: Number.isFinite(n) ? n : null,
      source: 'default',
      why:
        `${JSON.stringify(raw)} is not a positive finite rate, so it is not read as ` +
        `permission to go faster; using the ${RATE_LIMIT_RPS_DEFAULT} rps default`,
    };
  }

  if (n < RATE_LIMIT_RPS_MIN) {
    return {
      rps: RATE_LIMIT_RPS_MIN,
      requested: n,
      source: 'clamped-up',
      why:
        `${n} rps is slower than one request every ${Math.round(1 / RATE_LIMIT_RPS_MIN)}s, ` +
        `which no single invocation can honour; clamped up to ${RATE_LIMIT_RPS_MIN} rps`,
    };
  }

  if (n > RATE_LIMIT_RPS_MAX) {
    return {
      rps: RATE_LIMIT_RPS_MAX,
      requested: n,
      source: 'clamped-down',
      why:
        `${n} rps cannot be honoured inside the free plan's 50-subrequest invocation and ` +
        `would be indistinguishable from unpaced traffic; clamped down to ${RATE_LIMIT_RPS_MAX} rps`,
    };
  }

  return {
    rps: n,
    requested: n,
    source: 'declared',
    why: `${n} rps declared by the engagement`,
  };
}

// ─────────────────────────────── the pacer ───────────────────────────────

export interface PacerDeps {
  /** Injected clock in ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected sleep. Tests pass a recorder instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The spacing rule for one rate.
 *
 * `awaitSlot()` is not a sleep-per-call: it enforces a minimum interval BETWEEN
 * the starts of consecutive calls, so a call that itself took longer than the
 * interval is not punished with an extra wait on top. That is the difference
 * between a rate limit and a `sleep()` in a loop, and it is why the flow provider
 * was already calling `rateLimited()` around individual RPCs rather than awaiting
 * a fixed delay before each iteration.
 */
export interface Pacer {
  /** The rate this pacer enforces. */
  readonly rps: number;
  /** Milliseconds between the starts of consecutive calls. */
  readonly minIntervalMs: number;
  /** Resolve when the next call may start. */
  awaitSlot(): Promise<void>;
  /** How many calls were actually delayed. Diagnostics, not a gate. */
  readonly delayed: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function pacerFor(rps: number, deps: PacerDeps = {}): Pacer {
  const decision = normalizeRateLimitRps(rps);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const minIntervalMs = Math.ceil(1000 / Math.max(RATE_LIMIT_RPS_MIN, decision.rps));

  let lastCallAt = 0;
  let delayed = 0;

  return {
    rps: decision.rps,
    minIntervalMs,
    get delayed() {
      return delayed;
    },
    async awaitSlot(): Promise<void> {
      const wait = lastCallAt + minIntervalMs - now();
      if (wait > 0) {
        delayed++;
        await sleep(wait);
      }
      lastCallAt = now();
    },
  };
}

/**
 * The pace that governs requests made on ONE engagement's behalf.
 *
 * This is the function the bug was about: it reads the brief's declared rate
 * where there is one and falls back to today's default where there is not. Code
 * that talks to an engagement's target should obtain its spacing here rather than
 * reaching for a module-level constant, because a constant cannot know whose
 * target it is hitting.
 *
 * Returns the decision too, so a caller can log or display WHERE the pace came
 * from instead of implying the operator's number was used when it was clamped.
 */
export function rateLimitForBrief(brief: Pick<Brief, 'rate_limit_rps'> | null | undefined): RateDecision {
  return normalizeRateLimitRps(brief?.rate_limit_rps);
}

/** A pacer for one engagement, plus the reason its rate is what it is. */
export function pacerForBrief(
  brief: Pick<Brief, 'rate_limit_rps'> | null | undefined,
  deps: PacerDeps = {},
): Pacer & { decision: RateDecision } {
  const decision = rateLimitForBrief(brief);
  const pacer = pacerFor(decision.rps, deps);
  return Object.assign(pacer, { decision });
}

/** One line for an operator or a log: the rate, and whether it was theirs. */
export function describeRate(d: RateDecision): string {
  return `${d.rps} rps (${d.source})`;
}
