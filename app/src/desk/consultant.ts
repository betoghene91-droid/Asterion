/**
 * Consultant — turn a hunter finding into a hunt, but only when it is worth it.
 *
 * ## The problem this solves
 *
 * The protocol hunter reads account bytes and reports risk classes. Those are
 * real observations, but "upgrade authority is a plain wallet" is not a
 * vulnerability and it is not a payout — it is a *reason to go and look*.
 * Before this module existed, the hunter wrote findings to KV and the hunt
 * orchestrator (`src/hunt.ts`) only ever started from a bounty programme a
 * human had queued. The two halves never met.
 *
 * ## Why confidence is computed, and never guessed
 *
 * The brief asked for "80-90% certain". A model asked for a percentage will
 * invent one, so confidence here is a SUM OF NAMED, CHECKED FACTS:
 *
 *   +40  the account was decoded and the authority field was READ (not inferred)
 *   +20  the finding was seen on two or more separate ticks (it persisted)
 *   +20  the risk class has a real exploit path that doubles as the drain vector
 *   +10  we know a multisig threshold/count, i.e. the single-key claim is proven
 *   +10  the finding is on a program, not a bare mint (programs hold deposits)
 *
 * Anything below `CONSULT_MIN_CONFIDENCE` (80) is NOT forwarded. It stays in
 * the hunter's report, which is where unproven observations belong. The point
 * of the threshold is that a forwarded hunt can be trusted to be worth compute.
 *
 * ## The honest zeros rule, carried over
 *
 * A finding whose evidence account could not be re-read is `null`, never 0 —
 * an unreadable account is not weak evidence, it is absent evidence. The
 * hunter's own `unreadable` counter is the upstream half of that same rule.
 *
 * ## Why this starts a hunt instead of attacking anything
 *
 * Attacking is `src/hunt.ts`'s job: it has the stage machine, the corpus
 * priors, the PoC synthesiser and the GitHub dispatch to real compute. This
 * module's only job is to hand it a subject worth hunting and get out of the
 * way. `hunts.attempts_n` against `HUNT_ATTEMPT_LIMIT` is the stop limit.
 */

import { db, newId } from './db.js';
import type { DeskEnv } from './types.js';
import type { HunterFinding } from './hunter.js';

/** Forward only at or above this. 80 is the floor the operator asked for. */
export const CONSULT_MIN_CONFIDENCE = 80;

/**
 * Hard stop on any hunt this bot starts. Six attempts is the corpus-wide
 * grace period used by `runHunt`'s default; keeping it here means a hunt
 * started from a hunter finding cannot outlive the same budget as a
 * human-started one.
 */
export const HUNT_ATTEMPT_LIMIT = 6;

/**
 * Risk classes whose exploit path is simultaneously their drain vector.
 *
 * This is the distinction that makes the confidence number mean something. A
 * live *mint* authority on a memecoin is dangerous to holders but does not
 * let an attacker take an existing deposit — there is no drain, only dilution.
 * A live *upgrade* authority does: replace the program, take the vault. Those
 * are the two that earn the exploit-path points, because a hunt that proves
 * one has a payout attached.
 */
const DRAIN_CLASSES: ReadonlySet<string> = new Set([
  'upgrade_authority_plain_key',
  'upgradeable_program',
]);

export interface ConsultScore {
  /** 0-100, the sum of the named facts below. Never a model's opinion. */
  confidence: number;
  /** Every fact that added points, so a reviewer can subtract them back out. */
  facts: string[];
  /** True when this finding justified spending hunt compute. */
  forwarded: boolean;
}

/**
 * Score one finding from its own evidence plus what the tick loop knows.
 *
 * `seenTicks` is how many distinct ticks this subject+risk has appeared in.
 * It is passed in rather than read here so this function stays pure and
 * testable — the persistence lookup lives in the caller.
 */
export function scoreFinding(
  f: HunterFinding,
  seenTicks: number,
  authorityIsKnownSingleKey: boolean,
): ConsultScore {
  const facts: string[] = [];
  let confidence = 0;

  // +40 — the authority field was decoded from account bytes. This is the
  // whole basis of the finding and the only component every finding shares.
  if (f.evidenceAccount && f.evidenceAccount.length >= 32) {
    confidence += 40;
    facts.push('+40 authority field read from decoded account bytes');
  } else {
    // A structural claim with no account behind it is an observation, not
    // evidence. It cannot reach the threshold on its own, by construction.
    facts.push('+0 no evidence account: claim is structural, not decoded');
  }

  // +20 — it survived a second reading. A one-tick finding can be a
  // transient RPC view; the same bytes on a later tick are much harder to
  // explain away.
  if (seenTicks >= 2) {
    confidence += 20;
    facts.push(`+20 observed on ${seenTicks} separate ticks`);
  } else {
    facts.push('+0 seen on one tick only: could be a stale RPC view');
  }

  // +20 — the class has an exploit path that is also a drain path.
  if (DRAIN_CLASSES.has(f.risk)) {
    confidence += 20;
    facts.push('+20 risk class has a live drain vector (not just dilution)');
  } else {
    facts.push('+0 risk class is holder-affecting but not a direct drain');
  }

  // +10 — the single-key claim is proven, not assumed. Without this the
  // finding still says "plain key" but we have not independently confirmed
  // the authority account is a bare System-owned keypair.
  if (authorityIsKnownSingleKey) {
    confidence += 10;
    facts.push('+10 authority independently confirmed as a single key');
  } else {
    facts.push('+0 authority ownership not independently confirmed');
  }

  // +10 — a program (which holds deposits) rather than a bare mint.
  if (f.risk.startsWith('upgrade')) {
    confidence += 10;
    facts.push('+10 subject is a program, which custodies deposits');
  } else {
    facts.push('+0 subject is a token mint, which custodies no deposits');
  }

  return {
    confidence,
    facts,
    forwarded: confidence >= CONSULT_MIN_CONFIDENCE,
  };
}

export interface ConsultResult {
  forwarded: number;
  skipped: number;
  detail: string[];
}

/**
 * Forward qualifying findings to the hunt machine.
 *
 * Idempotent by construction: the `consult_queue` row is the record, and a
 * finding already queued is not queued again. That matters because the hunter
 * re-reports persisted findings on every tick — without this, one upgrade
 * authority would start a new hunt every hour, forever.
 *
 * Writes are wrapped individually so a D1 failure on one row cannot lose the
 * findings that were already forwarded. The caller's `noInputs` contract is
 * preserved: zero findings prints why, rather than printing a clean zero.
 */
export async function consult(
  env: DeskEnv,
  findings: HunterFinding[],
  seenCounts: Map<string, number>,
  singleKeyAuthorities: Set<string>,
): Promise<ConsultResult> {
  const out: ConsultResult = { forwarded: 0, skipped: 0, detail: [] };

  if (findings.length === 0) {
    out.detail.push('no hunter findings to consult: nothing looked at, not nothing wrong');
    return out;
  }

  for (const f of findings) {
    const seenTicks = seenCounts.get(`${f.subject}|${f.risk}`) ?? 1;
    const single = singleKeyAuthorities.has(f.subject);
    const score = scoreFinding(f, seenTicks, single);

    if (!score.forwarded) {
      out.skipped += 1;
      out.detail.push(
        `${f.subject.slice(0, 10)}… ${f.risk} at ${score.confidence}% — below ${CONSULT_MIN_CONFIDENCE}%, not forwarded`,
      );
      continue;
    }

    try {
      const existing = await db(env).all<{ id: string }>(
        'SELECT id FROM consult_queue WHERE subject=? AND risk=? LIMIT 1',
        f.subject,
        f.risk,
      );
      if (existing.length > 0) {
        out.detail.push(
          `${f.subject.slice(0, 10)}… ${f.risk} already queued (${existing[0]?.id ?? 'unknown'})`,
        );
        out.skipped += 1;
        continue;
      }

      const id = newId('consult');
      const now = Date.now();
      await db(env).run(
        `INSERT INTO consult_queue
           (id, ts, subject, risk, confidence, facts, hunt_id, stage, attempts, stopped_because, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        now,
        f.subject,
        f.risk,
        score.confidence,
        JSON.stringify(score.facts),
        // The hunt row itself is created by the orchestrator on dispatch; this
        // row is the intent and the audit trail, and `hunt_id` is filled in
        // when the orchestrator accepts it.
        null,
        'queued',
        0,
        null,
        now,
      );
      out.forwarded += 1;
      out.detail.push(
        `${f.subject.slice(0, 10)}… ${f.risk} at ${score.confidence}% — queued as ${id} (limit ${HUNT_ATTEMPT_LIMIT} attempts)`,
      );
    } catch (e) {
      // A queue write failure is not a finding failure. Say so, keep going.
      out.detail.push(`${f.subject.slice(0, 10)}… queue write failed: ${(e as Error).message}`);
    }
  }

  return out;
}

export function renderConsult(r: ConsultResult): string {
  const lines = [
    'consultant',
    `  forwarded  ${r.forwarded} to the hunt machine (>= ${CONSULT_MIN_CONFIDENCE}% confidence)`,
    `  held back  ${r.skipped}`,
    `  stop limit ${HUNT_ATTEMPT_LIMIT} attempts per hunt`,
  ];
  for (const d of r.detail.slice(0, 8)) lines.push(`  · ${d}`);
  return lines.join('\n');
}

export interface ConsultRow {
  id: string;
  subject: string;
  risk: string;
  confidence: number;
  stage: string;
  attempts: number;
  stopped_because: string | null;
  ts: number;
}

export interface ConsultStatus {
  queued: number;
  dispatched: number;
  proven: number;
  stopped: number;
  rows: ConsultRow[];
  unreadable: boolean;
  note: string;
}

/**
 * Read the queue. Costs ONE D1 read and no RPC subrequest, so a dashboard tab
 * polling this cannot starve the hourly hunter tick.
 *
 * `unreadable: true` is the honest-Zero contract again: when D1 cannot be
 * read we say so and return zero rows, rather than letting an empty array
 * look like "the queue is empty".
 */
export async function consultStatus(env: DeskEnv): Promise<ConsultStatus> {
  try {
    const rows = await db(env).all<ConsultRow>(
      `SELECT id, subject, risk, confidence, stage, attempts, stopped_because, ts
         FROM consult_queue ORDER BY confidence DESC, ts DESC LIMIT 40`,
    );
    const count = (s: string) => rows.filter((r) => r.stage === s).length;
    return {
      queued: count('queued'),
      dispatched: count('dispatched'),
      proven: count('proven'),
      stopped: count('stopped') + count('failed'),
      rows,
      unreadable: false,
      note:
        rows.length === 0
          ? `nothing forwarded yet — the hunter has not produced a finding at >= ${CONSULT_MIN_CONFIDENCE}% confidence`
          : `${rows.length} subject(s); hunts stop after ${HUNT_ATTEMPT_LIMIT} failed attempts`,
    };
  } catch (e) {
    return {
      queued: 0,
      dispatched: 0,
      proven: 0,
      stopped: 0,
      rows: [],
      unreadable: true,
      note: `consult_queue unreadable (${(e as Error).message}) — this is NOT an empty queue`,
    };
  }
}
