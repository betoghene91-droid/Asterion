/**
 * Hunt — V2 orchestrator.
 *
 * V1 could plan a hunt. V2 actually runs one, and the difference is that every
 * step is now evidence-producing:
 *
 *   rank      corpus priors decide which playbooks are worth the time
 *   lead      deterministic scan finds the code shapes that matter
 *   prime     precedent tells the hunter what this class looks like in the wild
 *   attempt   a PoC harness is synthesised and dispatched to real compute
 *   judge     only a reproduced + causal + measured result becomes a finding
 *
 * The whole loop is bounded and resumable: a hunt is a row, not a process.
 */

import { priorFor, renderPrecedent, retrieve, type CorpusDigest } from './corpus.js';
import { judge, renderVerdict, type ProofBundle, type ProofResult } from './proof.js';
import { HARNESSED, synthesize, type Lead, type PocSpec } from './poc.js';
import { byId, type Playbook } from './playbooks.js';

export type Stage = 'rank' | 'lead' | 'prime' | 'attempt' | 'judge' | 'done';

export interface HuntState {
  hunt_id: string;
  program_id: string;
  targets: string[];
  stage: Stage;
  ranked: RankedPlaybook[];
  leads: Lead[];
  pocs: { lead: Lead; spec: PocSpec }[];
  results: { lead: Lead; result: ProofResult }[];
  /** Why a hunt stopped without a finding. Always populated on a null result. */
  stopped_because: string | null;
}

export interface RankedPlaybook {
  id: string;
  name: string;
  /** Expected value from the corpus, 0 if unknown. */
  prior: number;
  severe: number;
  verdict: 'hunt' | 'deprioritise' | 'unknown';
  harnessed: boolean;
  reason: string;
}

/**
 * Order the playbooks by what the corpus says actually pays.
 *
 * This is the single most valuable thing V2 adds: it stops the bot spending an
 * evening on a class that has never produced a bounty. A class with a real
 * prior and a working harness goes first. A class with no harness goes last
 * even if its prior is high, because nothing can prove it.
 */
export function rank(
  playbookIds: string[],
  digest: CorpusDigest | null,
): RankedPlaybook[] {
  const out: RankedPlaybook[] = [];

  for (const id of playbookIds) {
    const pb: Playbook | undefined = byId(id);
    if (!pb) continue;
    const p = priorFor(digest, id);
    const harnessed = HARNESSED.has(id);

    let reason: string;
    if (!p.n) {
      reason = 'no ground truth in corpus; cannot be validated historically';
    } else if (!harnessed) {
      reason = `${p.n} precedents but no PoC harness yet`;
    } else if (p.verdict === 'hunt') {
      reason = `${p.n} precedents, mean severity weight ${p.weight.toFixed(2)}`;
    } else {
      reason = `${p.n} precedents; thinner ground truth`;
    }

    out.push({
      id,
      name: pb.name,
      prior: p.weight,
      severe: p.n,
      verdict: p.verdict,
      harnessed,
      reason,
    });
  }

  // Sort: harnessed first, then prior, then precedent count.
  out.sort((a, b) => {
    if (a.harnessed !== b.harnessed) return a.harnessed ? -1 : 1;
    if (b.prior !== a.prior) return b.prior - a.prior;
    return b.severe - a.severe;
  });
  return out;
}

/**
 * Turn scan leads into PoC attempts.
 *
 * A lead whose class has no harness is recorded and skipped rather than
 * silently dropped: the operator needs to see that the bot found something it
 * could not yet prove. That gap is the roadmap.
 */
export function planAttempts(
  leads: Lead[],
  opts: { contract: string; forkBlock: number },
  limit = 6,
): { attempts: { lead: Lead; spec: PocSpec }[]; unprovable: Lead[] } {
  const attempts: { lead: Lead; spec: PocSpec }[] = [];
  const unprovable: Lead[] = [];
  const seen = new Set<string>();

  for (const lead of leads) {
    // One attempt per class per contract: the harness is generic per class.
    const key = `${lead.playbook}:${lead.file}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const spec = synthesize(lead, opts);
    if (!spec) {
      unprovable.push(lead);
      continue;
    }
    attempts.push({ lead, spec });
    if (attempts.length >= limit) break;
  }

  return { attempts, unprovable };
}

/** Build the hunter's briefing for one lead, with precedent attached. */
export function briefLead(
  lead: Lead,
  digest: CorpusDigest | null,
  code: string,
): string {
  const precedent = retrieve(digest, lead.playbook, `${code} ${lead.snippet}`, 5);
  const pb = byId(lead.playbook);

  return [
    `PLAYBOOK   ${lead.playbook}  ${pb ? pb.name : ''}`,
    `LOCATION   ${lead.file}:${lead.line}`,
    `SHAPE      ${lead.snippet}`,
    '',
    'WHAT WOULD MAKE THIS REAL:',
    `  ${pb?.proof ?? 'a reproduced effect'}`,
    '',
    renderPrecedent(precedent),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Apply a batch of proof bundles to a hunt and decide the outcome.
 *
 * Note what this does NOT do: it never upgrades a partial to proven, and it
 * never reports a null result as a success. Silence is a valid outcome.
 */
export function adjudicate(hunt: HuntState, bundles: ProofBundle[]): HuntState {
  const byId_ = new Map(bundles.map((b) => [b.hypothesis_id, b]));
  const results: { lead: Lead; result: ProofResult }[] = [];

  for (const { lead, spec } of hunt.pocs) {
    const bundle = byId_.get(spec.test_name);
    if (!bundle) {
      results.push({
        lead,
        result: {
          verdict: 'inconclusive',
          confidence: 'tentative',
          reasons: ['no proof bundle returned; the attempt did not run'],
          claim: null,
        },
      });
      continue;
    }
    results.push({ lead, result: judge(bundle) });
  }

  const proven = results.filter((r) => r.result.verdict === 'proven');
  const partial = results.filter((r) => r.result.verdict === 'partial');

  let stopped: string | null = null;
  if (!proven.length) {
    stopped =
      partial.length > 0
        ? `${partial.length} lead(s) reproduced but could not be shown causal; no finding claimed`
        : 'every attempt was inconclusive or disproved; nothing to report';
  }

  return { ...hunt, stage: 'done', results, stopped_because: stopped };
}

/** Telegram-shaped summary of a finished hunt. */
export function renderHunt(h: HuntState): string {
  const proven = h.results.filter((r) => r.result.verdict === 'proven');
  const lines = [
    `<b>HUNT</b> <code>${h.program_id}</code>`,
    `stage ${h.stage}   leads ${h.leads.length}   attempts ${h.pocs.length}`,
  ];

  if (proven.length) {
    lines.push('', `<b>PROVEN  ${proven.length}</b>`);
    for (const p of proven) {
      lines.push(`  \u2713 ${p.lead.playbook}  ${p.result.claim ?? ''}`);
    }
  }

  const other = h.results.filter((r) => r.result.verdict !== 'proven');
  if (other.length) {
    lines.push('', '<b>NOT PROVEN</b>');
    for (const o of other.slice(0, 6)) {
      lines.push(`  ${renderVerdict(o.result)}`);
    }
  }

  if (h.stopped_because) {
    lines.push('', `<i>${h.stopped_because}</i>`);
  }
  return lines.join('\n');
}
