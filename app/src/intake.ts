/**
 * Intake — the compiler that turns a bad prompt into a real engagement.
 *
 * This is the answer to "my prompting for bug bounty is poor". The operator
 * never has to write a good prompt. There are three ways in:
 *
 *   1. Tap a playbook.        -> zero prompting.
 *   2. Type anything.         -> compiled into a Brief, at most 3 questions.
 *   3. Accept a suggestion.   -> the bot proposes the hunt, you say yes.
 *
 * The LLM is only used to extract fields. Every field has a deterministic
 * default and a deterministic validator, so a total LLM failure still
 * produces a usable engagement instead of a blank screen.
 */

import { PLAYBOOKS, route, type Cls, type Mut, type Playbook } from './playbooks.js';
import { parseChainToken } from './chains.js';

export interface Brief {
  program_id: string;
  title: string;
  cls: Cls;
  targets: string[];
  playbooks: string[];
  max_mutability: Mut;
  time_box_minutes: number;
  authorization_ref: string;
  stop_condition: string;
  out_of_scope: string[];
  notes: string;
  /**
   * EVM chain the brief's `0x…` targets live on.
   *
   * REQUIRED whenever a target is a bare address, enforced by
   * `policy.ts:chainForBrief` — an address does not identify its chain, and
   * filing every address under one guessed chain authorized engagements on a
   * chain nobody chose. Optional in the type only so web2 and repo briefs, which
   * have no chain, do not have to invent one.
   */
  chain_id?: number;
}

export interface Question {
  key: 'target' | 'class' | 'depth' | 'confirm';
  text: string;
  options: { label: string; value: string }[];
}

const CLASS_WORDS: Record<Cls, string[]> = {
  web2: ['web', 'api', 'url', 'http', 'site', 'app', 'endpoint', 'graphql', 'login', 'site'],
  solidity: ['contract', 'solidity', 'vault', 'token', 'defi', 'protocol', 'evm', '0x'],
  infra: ['dns', 'subdomain', 'takeover', 'tls', 'port', 'host', 'infra'],
};

const DEPTHS: Record<string, { minutes: number; mut: Mut; label: string }> = {
  recon: { minutes: 60, mut: 'read', label: 'Recon only — map it, touch nothing' },
  shallow: { minutes: 150, mut: 'read', label: 'Read-only — hunt for real but change nothing' },
  deep: { minutes: 360, mut: 'simulate', label: 'Deep — simulate proofs on a fork/sandbox' },
  active: { minutes: 240, mut: 'mutate', label: 'Active — may change state (approval per action)' },
};

/** Deterministic target extraction. No model, no hallucination. */
export function extractTargets(raw: string): string[] {
  const out = new Set<string>();
  const urlRe = /https?:\/\/[^\s<>"')]+/gi;
  const domRe = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
  const addrRe = /\b0x[a-fA-F0-9]{40}\b/g;
  for (const m of raw.match(urlRe) ?? []) out.add(m.replace(/[.,;]$/, ''));
  for (const m of raw.match(addrRe) ?? []) out.add(m);
  for (const m of raw.match(domRe) ?? []) {
    // drop obvious non-targets
    if (!/\.(png|jpg|jpeg|gif|svg|css|js|woff2?|ico|pdf)$/i.test(m)) out.add(m.toLowerCase());
  }
  return [...out].slice(0, 12);
}

export function inferClass(targets: string[], raw: string): Cls {
  const h = (raw + ' ' + targets.join(' ')).toLowerCase();
  let best: Cls = 'web2';
  let bestScore = 0;
  for (const [cls, words] of Object.entries(CLASS_WORDS) as [Cls, string[]][]) {
    const score = words.filter((w) => h.includes(w)).length;
    if (score > bestScore) {
      best = cls;
      bestScore = score;
    }
  }
  if (targets.some((t) => t.startsWith('0x'))) best = 'solidity';
  return best;
}

export function inferDepth(raw: string): string {
  const h = raw.toLowerCase();
  if (/recon|reconnaissance|map|enumerat|just look/.test(h)) return 'recon';
  if (/exploit|poc|prove|drain|steal/.test(h)) return 'deep';
  if (/deep|thorough|full|everything/.test(h)) return 'deep';
  return 'shallow';
}

/**
 * Compile sloppy text into either a Brief or a short list of questions.
 * Rule: never ask more than 3 questions, and only for facts that change
 * what runs. Everything else gets a sane default the operator can override.
 */
export function compile(
  raw: string,
  ctx: { program_id: string; authorization_ref: string; scope_hints: string[]; out_of_scope?: string[] },
  answers: Partial<Record<string, string>> = {},
): { brief: Brief } | { questions: Question[] } {
  const targets = answers.target ? [answers.target] : extractTargets(raw);
  const cls = (answers.class as Cls) ?? inferClass(targets, raw);
  const depthKey = answers.depth ?? inferDepth(raw);
  const depth = DEPTHS[depthKey] ?? DEPTHS.shallow!;

  const confidentClass =
    targets.some((x) => x.startsWith('0x')) ||
    targets.some((x) => /^https?:\/\//i.test(x)) ||
    targets.some((x) => /^[a-z0-9-]+(\.[a-z0-9-]+){1,}$/i.test(x));

  const questions: Question[] = [];

  if (targets.length === 0) {
    questions.push({
      key: 'target',
      text: 'Which host or address? (paste one URL, domain, or 0x address)',
      options: ctx.scope_hints.slice(0, 4).map((t) => ({ label: t, value: t })),
    });
  }
  // Class is only asked when the target shape does not settle it. A URL is
  // web2, an address is solidity; asking the operator anyway is exactly the
  // kind of friction that makes a hunting tool go unused.
  if (!answers.class && targets.length > 0 && !confidentClass) {
    questions.push({
      key: 'class',
      text: 'What kind of target is it?',
      options: [
        { label: 'Web app / API', value: 'web2' },
        { label: 'Smart contract', value: 'solidity' },
        { label: 'DNS / infrastructure', value: 'infra' },
      ],
    });
  }

  // Depth defaults to read-only. We only ask when the operator's intent is
  // genuinely unclear AND they have not approved anything yet — never as a
  // blocking gate, because the default is the safe choice.
  if (questions.length > 0) return { questions: questions.slice(0, 3) };

  const candidates = route(cls, raw + ' ' + targets.join(' '));
  const chosen = pickPlaybooks(candidates, depth.mut);

  // Carry an explicit chain pin through intake. `chain:8453` in the operator's
  // text is an explicit statement of intent, the same class of evidence as
  // `contract:` or `commit:`, so it is read here rather than left to be
  // re-discovered later. It is NOT guessed: if the text names no chain, the
  // brief carries none, and `roeFromBrief` will refuse an address-shaped brief
  // that has no chain rather than filing it under one.
  const chain_id =
    (answers.chain ? parseChainToken(`chain:${answers.chain}`) : null) ??
    parseChainToken(raw) ??
    undefined;

  return {
    brief: {
      program_id: ctx.program_id,
      title: `${cls} hunt on ${targets[0]}`,
      cls,
      targets,
      playbooks: chosen.map((p) => p.id),
      max_mutability: depth.mut,
      time_box_minutes: depth.minutes,
      authorization_ref: ctx.authorization_ref,
      stop_condition:
        'Stop when the time box expires, when a proven finding is reported, ' +
        'or when every selected playbook has been attempted once. Report a null result; do not extend.',
      out_of_scope: ctx.out_of_scope ?? [],
      notes: raw.slice(0, 2000),
      ...(chain_id !== undefined ? { chain_id } : {}),
    },
  };
}

/** Only keep playbooks whose mutability fits the chosen depth. */
export function pickPlaybooks(list: Playbook[], maxMut: Mut): Playbook[] {
  const order = { read: 0, simulate: 1, mutate: 2, destructive: 3 } as const;
  const limit = order[maxMut];
  return list.filter((p) => order[p.mut] <= limit).slice(0, 8);
}

/** Render the brief as the exact text the operator approves before anything runs. */
export function renderBrief(b: Brief): string {
  const lines = [
    `<b>ENGAGEMENT</b>  <code>${b.title}</code>`,
    '',
    `<b>targets</b>     ${b.targets.map((t) => `<code>${t}</code>`).join(', ')}`,
    `<b>class</b>       ${b.cls}`,
    `<b>mutability</b>  ${b.max_mutability}`,
    `<b>time box</b>    ${b.time_box_minutes} min`,
    `<b>authorized by</b> ${b.authorization_ref}`,
    '',
    '<b>playbooks</b>',
    ...b.playbooks.map((id) => `  · <code>${id}</code>`),
    '',
    `<i>${b.stop_condition}</i>`,
  ];
  if (b.out_of_scope.length) {
    lines.push('', `<b>never touch</b> ${b.out_of_scope.join(', ')}`);
  }
  return lines.join('\n');
}

export const ALL_PLAYBOOK_IDS = PLAYBOOKS.map((p) => p.id);
