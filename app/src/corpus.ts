/**
 * Corpus — the bot's memory of 180,907 expert-labelled findings.
 *
 * This is what makes the bot rare rather than another wrapper around a model.
 * Nobody else's agent knows what 13,000 audits concluded, how the finding was
 * phrased, which class it belonged to, and whether it was fixed.
 *
 * Three jobs, in order of value:
 *   1. RETRIEVAL  — given a lead (file, snippet, pattern), find the historical
 *                   findings that look like it. Precedent beats guessing.
 *   2. PRIORS     — how often does this class actually pay, and at what
 *                   severity? Reject whole hunts before spending time.
 *   3. PHRASING   — the report shape that got accepted, per class and firm.
 *
 * Everything here is derived from the corpus at build time and shipped as a
 * compact artifact. The D1 table only ever holds the distilled digest, never
 * the 102MB source: the Worker has a 500MB database and a 10ms CPU budget.
 */

export interface CorpusDigest {
  version: string;
  source_rows: number;
  generated_at: string;
  /** Per class: how much ground truth exists and how it distributes. */
  classes: Record<string, ClassStat>;
  /** Per playbook: the precedent bundle the hunter reads before it starts. */
  precedent: Record<string, Precedent[]>;
  /** Phrases that appear in accepted reports far more than in rejected ones. */
  lexicon: Record<string, string[]>;
}

export interface ClassStat {
  n: number;
  severe: number;
  critical: number;
  high: number;
  medium: number;
  recent: number;
  /** Median severity weight, 0..3. Used to rank hunts before spending time. */
  weight: number;
  /** True when the corpus can actually validate this class. */
  validatable: boolean;
}

export interface Precedent {
  /** Corpus finding uid, so any claim can be traced back to a real audit. */
  id: string;
  project: string;
  firm: string;
  year: number | null;
  severity: string;
  leaf: string;
  title: string;
  /** The extracted lesson: what to look for, in one line. */
  signal: string;
}

const SEV_WEIGHT: Record<string, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0.4,
  info: 0.1,
  gas: 0,
  unknown: 0,
};

export function weigh(severity: string): number {
  return SEV_WEIGHT[severity.toLowerCase()] ?? 0;
}

/**
 * Choose which findings are worth keeping as precedent.
 *
 * A finding earns a slot only if it is (a) severe, (b) recent enough to still
 * reflect real code, and (c) has a title that reads like a fact rather than a
 * page fragment. That last filter matters: this corpus was extracted from PDFs
 * and plenty of "titles" are body-text debris.
 */
export function isUsablePrecedent(f: {
  severity: string;
  year: number | null;
  title: string;
  leaf: string;
}): boolean {
  if (weigh(f.severity) < 1) return false; // medium or above
  if (!f.year || f.year < 2019) return false;
  const t = f.title.trim();
  if (t.length < 18 || t.length > 170) return false;
  if (/^(line \d+|section|appendix|table|figure|page \d)/i.test(t)) return false;
  if (t.endsWith(':')) return false;
  if ((t.match(/[a-z]/g) ?? []).length < 10) return false;
  // A real title names a thing and a consequence.
  return /\b(can|allows?|lets?|permits?|missing|unchecked|unsafe|incorrect|wrong|bypass|drain|steal|lock|freeze|manipulat|overflow|underflow|reentran|replay|unbounded|front.?run|grief|spoof|forge|arbitrar)/i.test(
    t,
  );
}

/**
 * Derive a one-line "what to look for" from a historical finding.
 *
 * Deliberately mechanical: we keep the reviewer's own words, trimmed to the
 * clause that states the defect. No model call, so it is free, fast, and
 * cannot hallucinate a bug that was never reported.
 */
export function toSignal(title: string, leaf: string): string {
  let s = title.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\d.\-)\s]+/, '');
  s = s.replace(/^(finding|issue|bug|vulnerability)\s*[:#-]?\s*/i, '');
  const cut = s.search(/\.\s|;\s/);
  if (cut > 40) s = s.slice(0, cut);
  const family = leaf.split('.').slice(-1)[0]?.replace(/_/g, ' ') ?? '';
  return (s.length > 8 ? s : `review ${family} handling`) + `  [${family}]`;
}

/**
 * Score a lead against the corpus before a single request is sent.
 *
 * Returns the expected value of hunting this class. This is the function that
 * stops the bot spending an evening on a class that has never paid a bounty.
 */
export function priorFor(
  digest: CorpusDigest | null,
  playbookId: string,
): { n: number; weight: number; verdict: 'hunt' | 'deprioritise' | 'unknown' } {
  const cls = digest?.classes[playbookId];
  if (!cls || !cls.validatable) return { n: 0, weight: 0, verdict: 'unknown' };
  // Calibrated against the real corpus distribution, not guessed.
  // Observed means by weight: inflation 1.25, reentrancy 1.00, accesscontrol
  // 0.93, oracle 0.93, signature 0.85, rounding 0.80, dos 0.80, upgrade 0.65.
  // So the hunt bar is 0.75, not 1.4: a bar nothing clears is not a filter,
  // it is a bug that makes every suggestion look worthless.
  const weightOk = cls.weight >= 0.75;
  if (cls.severe >= 500 && weightOk) return { n: cls.severe, weight: cls.weight, verdict: 'hunt' };
  if (cls.severe >= 100) return { n: cls.severe, weight: cls.weight, verdict: 'deprioritise' };
  return { n: cls.severe, weight: cls.weight, verdict: 'deprioritise' };
}

/**
 * Token-overlap retrieval over the precedent bundle.
 *
 * A real embedding store is not affordable inside a Worker invocation, and
 * does not need to be: the precedent titles are short, domain-specific, and
 * share vocabulary with the code being examined. BM25-lite over 10-40
 * candidates per class is enough to surface the right precedent, and it is
 * deterministic and free.
 */
export function retrieve(
  digest: CorpusDigest | null,
  playbookId: string,
  haystack: string,
  k = 5,
): Precedent[] {
  const pool = digest?.precedent[playbookId];
  if (!pool?.length) return [];

  const tokens = tokenise(haystack);
  if (!tokens.size) return pool.slice(0, k);

  const scored = pool.map((p) => {
    const doc = tokenise(`${p.title} ${p.signal} ${p.leaf}`);
    let hit = 0;
    for (const t of tokens) if (doc.has(t)) hit++;
    // normalise so long precedent does not win by length
    const score = hit / Math.sqrt(doc.size || 1);
    return { p, score: score + weigh(p.severity) * 0.05 };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.p);
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'be', 'for', 'on', 'with', 'that', 'this',
  'it', 'as', 'at', 'by', 'from', 'can', 'may', 'will', 'not', 'no', 'if', 'then', 'than', 'so', 'such',
]);

export function tokenise(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || raw.length > 30) continue;
    if (STOP.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Render the precedent block that goes into a hunter's prompt.
 * Kept terse: the point is to prime the search, not to write an essay.
 */
export function renderPrecedent(list: Precedent[]): string {
  if (!list.length) return '';
  const lines = ['PRECEDENT (real findings of this class):'];
  for (const p of list) {
    lines.push(`  · ${p.signal} — ${p.project || 'unnamed'} (${p.firm}, ${p.year ?? 'n/a'}, ${p.severity})`);
  }
  return lines.join('\n');
}
