/**
 * The dead-man's switch — which jobs it watches, how long each may be quiet,
 * and what it says when one of them stops.
 *
 * WHY THIS FILE EXISTS
 *
 * `runDeadman()` used to read `kv['cron_last']` into a local called `quietHours`,
 * compute the elapsed hours, and then throw the number away with `void
 * quietHours;`. The only source it actually alerted on was `kv['sentinel_last']`,
 * which meant four of the five cron slots could die in silence: kill the
 * crawler, the briefing, the maintenance sweep or the desk analyst and the
 * switch would keep saying nothing, because the sentinel — which shares the
 * `*\/5` slot and therefore almost never dies — was still beating.
 *
 * Two things were wrong, and they are separable:
 *
 *   1. **Nothing was attributed.** Every cron invocation wrote ONE row,
 *      `heartbeats(source='cron')`. Five jobs wrote the same key, so the newest
 *      writer masked the other four, and even a working check could not have
 *      named the job that stopped.
 *   2. **The check had one special case instead of a rule.** A hardcoded "alert
 *      if the sentinel is quiet for more than 2h" is not a cadence-derived
 *      window: the same 2h applied to a `*\/5` job (24 missed runs) and to a
 *      daily one (one slightly late run) would be wrong in both directions.
 *
 * So this module is data plus one pure decision, and `index.ts` is the wiring:
 * each scheduled job records its OWN `heartbeats` row after its work succeeds,
 * and the switch checks every registered job against a window derived from that
 * job's own period.
 *
 * THE WINDOW RULE
 *
 *   window = period x QUIET_PERIODS + QUIET_GRACE_SECONDS
 *
 * `QUIET_PERIODS = 2` because a single missed tick is not evidence of death:
 * Workers cron triggers are best-effort and can be delivered late, a deploy can
 * land mid-slot, and a transient D1 error is not a dead daemon. Two consecutive
 * misses is the smallest number that is evidence rather than noise, and it
 * gives the property the assignment asks for in the other direction too — a
 * `*\/5` job is checked against 12 minutes while a daily one gets 48 hours, so
 * the fast job is checked "far more tightly" by exactly the ratio of their
 * cadences.
 *
 * `QUIET_GRACE_SECONDS = 120` absorbs delivery jitter without letting a job
 * drift a whole extra period before anyone notices.
 *
 * WHAT THIS CANNOT DO, STATED HERE RATHER THAN DISCOVERED IN AN INCIDENT
 *
 *   · Detection latency is bounded by the DEAD-MAN JOB'S OWN period, not by the
 *     window: the check only runs every 6h, so a job that dies just after a
 *     check is named at the next one, at most ~6h later. A tighter window cannot
 *     improve that; a more frequent dead-man cron could, and the free plan gives
 *     us five triggers, all spoken for.
 *   · The switch cannot report its own death — nothing runs to report it. It
 *     checks itself only to notice that IT was stalled, which is why its window
 *     is two of its own periods rather than one.
 *   · A job that runs and THROWS is silent from here. Silence is the correct
 *     signal (the work did not happen), and the thrown error is in the Worker
 *     log under the `cron <job> failed` line the dispatcher already prints.
 */

import { esc, rule } from './telegram.js';

/** Every job the switch is responsible for. */
export type JobName =
  | 'sentinel'
  | 'desk_tick'
  | 'crawler'
  | 'desk_analyst'
  | 'maintenance'
  | 'desk_calibration'
  | 'briefing'
  | 'deadman';

/**
 * One scheduled unit of work.
 *
 * `periodSeconds` is the cadence, and it is the ONLY input to the quiet window:
 * nothing here is a hand-tuned threshold, because a hand-tuned threshold is what
 * the old `sentinelQuiet > 2` was.
 *
 * Two jobs can share a `cron` and still be separate entries. That is deliberate:
 * `index.ts` composes the desk into the security slots and catches each half
 * separately, so one half failing must be attributable on its own. A single row
 * per slot would hide exactly the failure the assignment calls out ("if the
 * crawler, briefing, maintenance or desk analyst dies while sentinel keeps
 * firing, nothing warns anyone").
 */
export interface ScheduledJob {
  readonly name: JobName;
  readonly cron: string;
  readonly periodSeconds: number;
}

/** How many consecutive misses count as evidence rather than noise. */
export const QUIET_PERIODS = 2;

/** Slack on top of `QUIET_PERIODS x period`, for best-effort trigger delivery. */
export const QUIET_GRACE_SECONDS = 120;

/** The five `[triggers] crons` in wrangler.toml, and the work each one runs. */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  { name: 'sentinel', cron: '*/5 * * * *', periodSeconds: 300 },
  { name: 'desk_tick', cron: '*/5 * * * *', periodSeconds: 300 },
  { name: 'crawler', cron: '0 * * * *', periodSeconds: 3600 },
  { name: 'desk_analyst', cron: '0 * * * *', periodSeconds: 3600 },
  { name: 'maintenance', cron: '15 3 * * *', periodSeconds: 86400 },
  { name: 'desk_calibration', cron: '15 3 * * *', periodSeconds: 86400 },
  { name: 'briefing', cron: '30 6 * * *', periodSeconds: 86400 },
  { name: 'deadman', cron: '0 */6 * * *', periodSeconds: 21600 },
];

export const JOB_NAMES: readonly JobName[] = SCHEDULED_JOBS.map((j) => j.name);

export function jobByName(name: string): ScheduledJob | undefined {
  return SCHEDULED_JOBS.find((j) => j.name === name);
}

/** How long a job with this cadence may be quiet before it is called silent. */
export function quietWindowSeconds(periodSeconds: number): number {
  return periodSeconds * QUIET_PERIODS + QUIET_GRACE_SECONDS;
}

/**
 * `ok`       — it beat inside its window.
 * `silent`   — it has a row and is past the window, OR it has never had a row and
 *              this deployment has been observed for longer than its window. Both
 *              are "the work is not happening"; they differ only in the wording
 *              of the alert.
 * `cold_start` — it has no row yet and the deployment is younger than its window.
 *              This is the case the old code could not express: a missing row on
 *              a fresh database is not a dead job, it is a job whose first slot
 *              has not arrived. Making it a distinct state is what stops the
 *              switch paging on the first run after every deploy, and it still
 *              self-clears — once the observation is older than the window, a job
 *              that has STILL never run becomes `silent`.
 */
export type JobState = 'ok' | 'silent' | 'cold_start';

export interface JobHealth {
  name: JobName;
  /** Newest successful heartbeat, unix seconds, or null when there is none. */
  last_ts: number | null;
  /** Seconds since that heartbeat; null when there is none. */
  quiet_seconds: number | null;
  window_seconds: number;
  state: JobState;
}

export interface AssessInput {
  /** Unix seconds. */
  now: number;
  /** Newest successful heartbeat per source, as read from `heartbeats`. */
  lastTs: Record<string, number | null>;
  /**
   * Earliest `heartbeats` timestamp in the whole table — this deployment's first
   * observed cron activity, used as the age of the observation. Null when the
   * table is empty, which can only happen before anything has ever run.
   */
  observedSince: number | null;
}

/**
 * Decide every job's state. Pure: no clock, no database, no formatting.
 *
 * The cold-start rule is expressed as a comparison against the JOB's window and
 * not against a fixed "first few hours", because the correct answer differs per
 * cadence: 12 minutes after a deploy a missing sentinel row is suspicious,
 * whereas a missing daily briefing row is completely normal for the next 48
 * hours.
 */
export function assessJobs(input: AssessInput): JobHealth[] {
  const { now, lastTs, observedSince } = input;
  return SCHEDULED_JOBS.map((job) => {
    const windowSeconds = quietWindowSeconds(job.periodSeconds);
    const raw = lastTs[job.name];
    const last = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

    if (last === null) {
      // No row. Cold start until this deployment has been watched for at least
      // one full window — at which point two of the job's slots have definitely
      // passed and "never ran" means the cron is not firing at all.
      const observedFor = observedSince === null ? 0 : now - observedSince;
      const cold = !(observedFor >= windowSeconds);
      return {
        name: job.name,
        last_ts: null,
        quiet_seconds: null,
        window_seconds: windowSeconds,
        state: cold ? 'cold_start' : 'silent',
      };
    }

    const quiet = Math.max(0, now - last);
    return {
      name: job.name,
      last_ts: last,
      quiet_seconds: quiet,
      window_seconds: windowSeconds,
      state: quiet > windowSeconds ? 'silent' : 'ok',
    };
  });
}

/** Human duration, in the units the rest of the cron code prints. */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/**
 * The fewer-than-all case, so one dead job does not produce eight lines.
 * Everything past the first two is counted, not listed.
 */
function joinNames(names: string[], cap = 2): string {
  if (names.length <= cap) return names.map((n) => `<b>${esc(n)}</b>`).join(', ');
  const shown = names.slice(0, cap).map((n) => `<b>${esc(n)}</b>`).join(', ');
  return `${shown} +${names.length - cap} more`;
}

/**
 * The alert, or null when every job is healthy.
 *
 * The two lines the assignment asks for are the first two: **last ok** is the
 * newest job that did beat, which is how an operator knows how far the system
 * got before it stopped, and **first gone** is the job that has been quiet
 * longest, which is the first thing that actually broke. A job that never ran
 * sorts ahead of every silent one, because "never started" precedes "stopped".
 */
export function renderDeadmanAlert(health: JobHealth[]): string | null {
  const silent = health.filter((h) => h.state === 'silent');
  if (silent.length === 0) return null;

  // Oldest first. A null last_ts (never ran) is older than any timestamp.
  const byAge = [...silent].sort((a, b) => {
    if (a.last_ts === null && b.last_ts === null) return 0;
    if (a.last_ts === null) return -1;
    if (b.last_ts === null) return 1;
    return a.last_ts - b.last_ts;
  });
  const first = byAge[0]!;

  const beating = health.filter(
    (h): h is JobHealth & { last_ts: number } => h.last_ts !== null && h.state === 'ok',
  );
  const newest = beating.reduce<JobHealth & { last_ts: number } | null>(
    (best, h) => (best === null || h.last_ts > best.last_ts ? h : best),
    null,
  );

  const firstLine =
    first.last_ts === null
      ? `never ran (window ${humanDuration(first.window_seconds)})`
      : `silent ${humanDuration(first.quiet_seconds ?? 0)} (window ${humanDuration(first.window_seconds)})`;

  const lastLine = newest
    ? `<b>${esc(newest.name)}</b> ${humanDuration(newest.quiet_seconds ?? 0)} ago`
    : 'nothing has beaten at all';

  const also = byAge.slice(1).map((h) =>
    h.last_ts === null
      ? `<b>${esc(h.name)}</b> never ran`
      : `<b>${esc(h.name)}</b> ${humanDuration(h.quiet_seconds ?? 0)}`,
  );

  return [
    '\u26A0 <b>DEAD-MAN\u2019S SWITCH</b>',
    rule(),
    `last ok      ${lastLine}`,
    `first gone   <b>${esc(first.name)}</b> ${firstLine}`,
    ...(also.length ? [`also gone    ${joinNames(byAge.slice(1).map((h) => h.name))}`] : []),
    '',
    'Nothing is being watched. Check the Worker, the RPC, or the cron.',
  ].join('\n');
}
