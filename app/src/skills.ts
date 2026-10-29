/**
 * Skills — expert hunting methodology as data, not as prompt text.
 *
 * A playbook answers "which class of bug do we test for?". A skill answers
 * "how does a senior auditor actually decide whether an instance of that class
 * is real?" — the discriminating questions, the false positives that eat a
 * reviewer's afternoon, the measured delta a PoC has to show, and the bar
 * between informational and reportable.
 *
 * Design constraints, in order of importance:
 *
 *  1. NEVER THROW AT IMPORT TIME. The Worker imports the whole graph on every
 *     cold start; a missing skills/ directory must degrade to an empty list and
 *     a reason, not a 500. All filesystem access is lazy and wrapped.
 *  2. NO STATIC `node:fs` IMPORT. This module is bundled for Cloudflare
 *     Workers, which have no filesystem. We reach the module dynamically via
 *     `process.getBuiltinModule`, so a Worker simply reports "no filesystem"
 *     and returns [] instead of failing to bundle.
 *  3. PURE OUTPUTS. Everything here is a pure function of (skills dir, args).
 *     No network, no writes, no clock, no randomness — so a test can pin the
 *     exact ordering and the caller can cache the result.
 *
 * A skill cannot upgrade a verdict. It shapes what the model looks FOR and
 * what it must MEASURE. The verification pipeline still owns truth.
 */

import { SKILLS_EMBED } from './skills-embed.js';

export type SkillCls = 'web2' | 'solidity' | 'infra';

/** The short form, safe to list in a UI or a Telegram message. */
export interface SkillMeta {
  id: string;
  version: number;
  name: string;
  cls: SkillCls;
  family: string;
  /** What the target must expose for this skill to be worth applying. */
  requires: string[];
  questionCount: number;
}

/** The full skill, including prose body and the machine-readable guards. */
export interface Skill extends SkillMeta {
  /** Ordered, most-discriminating first. */
  questions: string[];
  false_positives: string[];
  poc_must_show: string[];
  impact_bar: string;
  /** Raw SKILL.md, for a human or an LLM that wants the long form. */
  body: string;
}

export interface SkillLoadReport {
  root: string | null;
  ok: boolean;
  count: number;
  /** Human-readable single line: why ok is true/false. Never empty. */
  reason: string;
  /** Per-skill problems (bad JSON, missing key, id/dir mismatch). */
  issues: string[];
}

export interface SkillOptions {
  /** Override the skills directory. Tests use this to prove degradation. */
  root?: string;
}

export interface SelectOptions extends SkillOptions {
  /** Exact playbook id under consideration. Ranks first when it matches. */
  playbook?: string;
  /** Restrict to a class when no playbook is given. */
  cls?: SkillCls;
  /** Per-id corpus weight (from corpus.ts priorFor). Higher wins. */
  weights?: Record<string, number>;
  /** Convenience: the weight of `playbook` itself, if the caller has one number. */
  corpusWeight?: number;
  /** Hard cap on returned skills. */
  limit?: number;
}

/**
 * Hard cap on the rendered prompt block. The whole point of a compact block is
 * that it can be prepended to a hunter prompt without eating the context budget
 * that the actual code needs. 4000 chars ~ 1000 tokens.
 */
export const MAX_PROMPT_CHARS = 4000;

/** Keys every skill.json must carry. Kept explicit so validation is auditable. */
export const REQUIRED_SKILL_KEYS = [
  'id',
  'version',
  'name',
  'cls',
  'family',
  'requires',
  'questions',
  'false_positives',
  'poc_must_show',
  'impact_bar',
] as const;

// ─────────────────────────── filesystem shim ───────────────────────────

/**
 * The only slice of node:fs we need. Declared locally so we never pull in
 * @types/node (this package is Workers-typed) and never statically import a
 * built-in that the Worker runtime cannot provide.
 */
interface FsShim {
  readdirSync(path: string, opts: { withFileTypes: true }): Array<{
    name: string;
    isDirectory(): boolean;
  }>;
  readFileSync(path: string, encoding: 'utf8'): string;
}

function nodeFs(): FsShim | null {
  try {
    const proc = (globalThis as unknown as {
      process?: { getBuiltinModule?: (name: string) => unknown };
    }).process;
    const mod = proc?.getBuiltinModule?.('node:fs') as Partial<FsShim> | undefined;
    if (mod && typeof mod.readdirSync === 'function' && typeof mod.readFileSync === 'function') {
      return mod as FsShim;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Default root: `<repo>/skills`.
 *
 * `import.meta.url` is .../app/build/skills.js when compiled and .../app/src/
 * skills.ts when run directly, and both are exactly two levels under the repo
 * root, so one relative URL is correct in both cases.
 */
function defaultRoot(): string | null {
  try {
    // `import.meta.url` is not in the Workers/DOM lib typings, and is absent in
    // some bundlers, so it is read defensively rather than dereferenced.
    const meta = import.meta as unknown as { url?: string };
    if (typeof meta.url !== 'string') return null;
    const url = new URL('../../skills/', meta.url);
    if (url.protocol !== 'file:') return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// ─────────────────────────────── loading ───────────────────────────────

interface LoadResult {
  skills: Skill[];
  report: SkillLoadReport;
}

const cache = new Map<string, LoadResult>();

/** Drop the memoised directory read. Only needed when skills change on disk. */
export function resetSkillCache(): void {
  cache.clear();
}

function isStringArray(v: unknown, min: number): v is string[] {
  if (!Array.isArray(v) || v.length < min) return false;
  return v.every((x) => typeof x === 'string' && x.trim().length > 0);
}

function parseSkill(raw: unknown, dirName: string, body: string): { skill?: Skill; issue?: string } {
  if (typeof raw !== 'object' || raw === null) return { issue: `${dirName}: skill.json is not an object` };
  const o = raw as Record<string, unknown>;

  for (const k of REQUIRED_SKILL_KEYS) {
    if (!(k in o)) return { issue: `${dirName}: skill.json missing "${k}"` };
  }
  const id = o['id'];
  if (typeof id !== 'string' || !id.trim()) return { issue: `${dirName}: "id" must be a non-empty string` };
  if (id !== dirName) return { issue: `${dirName}: id "${id}" does not match directory name` };
  if (typeof o['version'] !== 'number' || !Number.isFinite(o['version'])) {
    return { issue: `${dirName}: "version" must be a number` };
  }
  const name = o['name'];
  const cls = o['cls'];
  const family = o['family'];
  const impact = o['impact_bar'];
  if (typeof name !== 'string' || !name.trim()) return { issue: `${dirName}: "name" must be a string` };
  if (cls !== 'web2' && cls !== 'solidity' && cls !== 'infra') {
    return { issue: `${dirName}: "cls" must be web2 | solidity | infra` };
  }
  if (typeof family !== 'string' || !family.trim()) return { issue: `${dirName}: "family" must be a string` };
  if (typeof impact !== 'string' || !impact.trim()) return { issue: `${dirName}: "impact_bar" must be a string` };
  if (!isStringArray(o['requires'], 1)) return { issue: `${dirName}: "requires" must be a non-empty string[]` };
  if (!isStringArray(o['questions'], 5)) return { issue: `${dirName}: "questions" must be >= 5 non-empty strings` };
  if (!isStringArray(o['false_positives'], 1)) {
    return { issue: `${dirName}: "false_positives" must be a non-empty string[]` };
  }
  if (!isStringArray(o['poc_must_show'], 1)) {
    return { issue: `${dirName}: "poc_must_show" must be a non-empty string[]` };
  }

  const questions = o['questions'] as string[];
  const skill: Skill = {
    id,
    version: o['version'] as number,
    name,
    cls,
    family,
    requires: o['requires'] as string[],
    questionCount: questions.length,
    questions,
    false_positives: o['false_positives'] as string[],
    poc_must_show: o['poc_must_show'] as string[],
    impact_bar: impact,
    body,
  };
  return { skill };
}

/**
 * Build a LoadResult from the embedded catalog. Runs the SAME validator as the
 * disk path, so embedded and on-disk skills cannot drift in strictness.
 */
function fromEmbedded(reason: string, issues: string[], key: string): LoadResult {
  const skills: Skill[] = [];
  for (const e of SKILLS_EMBED) {
    const dirName = String((e.meta as Record<string, unknown>)['id'] ?? 'embedded');
    const v = parseSkill(e.meta, dirName, e.body);
    if (v.skill) skills.push(v.skill);
    else if (v.issue) issues.push(v.issue);
  }
  skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const res: LoadResult = {
    skills,
    report: {
      root: '(embedded)',
      ok: skills.length > 0,
      count: skills.length,
      reason: reason + ' (' + skills.length + ' skill(s))',
      issues,
    },
  };
  cache.set(key, res);
  return res;
}

function load(opts?: SkillOptions): LoadResult {
  const root = opts?.root ?? defaultRoot();
  const key = root ?? '\u0000none';
  const hit = cache.get(key);
  if (hit) return hit;

  const issues: string[] = [];

  if (!root) {
    // No filesystem (Cloudflare Workers). Fall back to the build-time embedded
    // copy so a deployed Worker still hunts with methodology instead of blind.
    // Regenerate with: node scripts/build-skills-embed.mjs
    return fromEmbedded('no filesystem: serving build-time embedded skills', issues, key);
  }

  const fs = nodeFs();
  if (!fs) {
    return fromEmbedded('no filesystem module available: serving build-time embedded skills', issues, key);
  }

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    const reason = `skills directory unreadable: ${root} (${(err as Error).message})`;
    const miss: LoadResult = { skills: [], report: { root, ok: false, count: 0, reason, issues } };
    cache.set(key, miss);
    return miss;
  }

  const skills: Skill[] = [];
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.') && !n.startsWith('_'))
    .sort();

  for (const dir of dirs) {
    const jsonPath = joinPath(joinPath(root, dir), 'skill.json');
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      issues.push(`${dir}: skill.json unreadable or not JSON (${(err as Error).message})`);
      continue;
    }
    let body = '';
    try {
      body = fs.readFileSync(joinPath(joinPath(root, dir), 'SKILL.md'), 'utf8');
    } catch {
      issues.push(`${dir}: SKILL.md missing (skill.json still usable)`);
    }
    const parsed = parseSkill(raw, dir, body);
    if (parsed.issue) {
      issues.push(parsed.issue);
      continue;
    }
    if (parsed.skill) skills.push(parsed.skill);
  }

  skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const report: SkillLoadReport = {
    root,
    ok: skills.length > 0,
    count: skills.length,
    reason: skills.length
      ? `loaded ${skills.length} skill(s) from ${root}${issues.length ? ` (${issues.length} issue(s))` : ''}`
      : `no valid skills under ${root}${issues.length ? `: ${issues.join('; ')}` : ''}`,
    issues,
  };
  const result: LoadResult = { skills, report };
  cache.set(key, result);
  return result;
}

/** Why the loader ended up where it did. Safe to show an operator verbatim. */
export function skillLoadReport(opts?: SkillOptions): SkillLoadReport {
  const r = load(opts).report;
  return { ...r, issues: [...r.issues] };
}

// ──────────────────────────────── API ────────────────────────────────

/**
 * Every skill that parsed cleanly, sorted by id.
 *
 * Degrades to `[]` (never throws) when the directory is missing, unreadable,
 * or the runtime has no filesystem. Call `skillLoadReport()` for the reason.
 */
export function listSkills(opts?: SkillOptions): SkillMeta[] {
  return load(opts).skills.map((s) => ({
    id: s.id,
    version: s.version,
    name: s.name,
    cls: s.cls,
    family: s.family,
    requires: [...s.requires],
    questionCount: s.questionCount,
  }));
}

/** One skill, or null. Unknown ids and unreadable directories both yield null. */
export function getSkill(id: string, opts?: SkillOptions): Skill | null {
  const found = load(opts).skills.find((s) => s.id === id);
  return found ? { ...found, requires: [...found.requires], questions: [...found.questions] } : null;
}

/**
 * The skills worth applying to one lead, best first.
 *
 * Ordering policy, applied as a total order (so it is deterministic for any
 * input, which the tests pin):
 *
 *   1. EXACT MATCH FIRST. A skill whose id equals `playbook` always leads: the
 *      bot is about to hunt that class, so its own methodology outranks a
 *      neighbour's no matter what the corpus says.
 *   2. CORPUS WEIGHT, DESCENDING. Among the rest, the class with the better
 *      historical payoff goes first. The weight comes from
 *      `priorFor(digest, id).weight` — passed in as `weights`, or as the single
 *      `corpusWeight` when the caller only knows the playbook's own number.
 *      Missing weight is 0, never "unknown but optimistic".
 *   3. ID ASCENDING. Pure tie-break, so two runs on the same input agree.
 *
 * Candidate set: with `playbook`, the matching skill plus its same-class
 * siblings (adjacent classes sharpen each other — a rounding lead is worth
 * reading next to inflation). Without `playbook`, all skills of `cls`, or all
 * skills when neither is given.
 */
export function selectSkills(opts?: SelectOptions): Skill[] {
  const all = load(opts).skills;
  if (!all.length) return [];

  const playbook = opts?.playbook;
  const cls = opts?.cls;
  const weights = opts?.weights;
  const single = opts?.corpusWeight;

  const exact = playbook ? all.find((s) => s.id === playbook) : undefined;
  const clsOfInterest = exact ? exact.cls : cls;

  let pool = all;
  if (playbook) {
    pool = all.filter((s) => s.id === playbook || (clsOfInterest !== undefined && s.cls === clsOfInterest));
  } else if (cls) {
    pool = all.filter((s) => s.cls === cls);
  }

  const weightOf = (s: Skill): number => {
    const w = weights?.[s.id];
    if (typeof w === 'number' && Number.isFinite(w)) return w;
    if (single !== undefined && playbook !== undefined && s.id === playbook && Number.isFinite(single)) {
      return single;
    }
    return 0;
  };

  const ranked = pool
    .map((s) => ({ s, exact: playbook !== undefined && s.id === playbook ? 1 : 0, w: weightOf(s) }))
    .sort((a, b) => {
      if (a.exact !== b.exact) return b.exact - a.exact;
      if (a.w !== b.w) return b.w - a.w;
      return a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0;
    })
    .map((x) => x.s);

  const limit = opts?.limit;
  const capped = typeof limit === 'number' && limit >= 0 ? ranked.slice(0, limit) : ranked;

  return capped.map((s) => ({
    ...s,
    requires: [...s.requires],
    questions: [...s.questions],
    false_positives: [...s.false_positives],
    poc_must_show: [...s.poc_must_show],
  }));
}

/**
 * The discriminating questions for one skill, for surfacing to the operator
 * ("before I spend your money, here is what I will try to falsify").
 * Unknown id → [] (not a throw).
 */
export function questionsFor(id: string, opts?: SkillOptions): string[] {
  const s = getSkill(id, opts);
  return s ? s.questions : [];
}

/**
 * A compact block to prime a hunter prompt. Bounded by MAX_PROMPT_CHARS; if the
 * skill is longer the tail is cut and clearly marked, so a truncated skill can
 * never masquerade as a complete one. Unknown id → '' (caller decides).
 *
 * Deliberately metadata-only: questions, PoC obligations, impact bar, false
 * positives. The prose body is long-form context for a human, and shipping it
 * in every prompt would crowd out the code being reviewed.
 */
export function renderSkillForPrompt(id: string, opts?: SkillOptions): string {
  const s = getSkill(id, opts);
  if (!s) return '';

  const lines: string[] = [
    `SKILL ${s.id} v${s.version} — ${s.name}`,
    `class: ${s.cls} · family: ${s.family}`,
  ];
  if (s.requires.length) {
    lines.push('TARGET MUST EXPOSE:');
    for (const r of s.requires) lines.push(`  · ${r}`);
  }
  lines.push(`DISCRIMINATING QUESTIONS (${s.questions.length}, most specific first):`);
  s.questions.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
  if (s.poc_must_show.length) {
    lines.push('A MINIMAL PoC MUST SHOW:');
    for (const p of s.poc_must_show) lines.push(`  · ${p}`);
  }
  lines.push(`IMPACT BAR: ${s.impact_bar}`);
  if (s.false_positives.length) {
    lines.push('RULE THESE OUT BEFORE REPORTING:');
    for (const fp of s.false_positives) lines.push(`  · ${fp}`);
  }
  lines.push('A skill sharpens the search. It cannot prove the bug: the PoC decides.');

  const text = lines.join('\n');
  if (text.length <= MAX_PROMPT_CHARS) return text;

  const marker = '\n…[skill truncated at the prompt cap]';
  return text.slice(0, MAX_PROMPT_CHARS - marker.length) + marker;
}
