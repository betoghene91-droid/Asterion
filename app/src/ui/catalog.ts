/**
 * The catalog: what this build can actually do.
 *
 * The Mini App's Library view is backed entirely by this module, and it is built
 * by ENUMERATION, never from a hardcoded list. That matters more than it looks:
 *
 *   - `web.idor` is both a playbook (how to route and prove it) and a skill pack
 *     (the methodology and the questions to ask first). They are joined here, so
 *     the UI can show one capability with two facets instead of two lists that
 *     look like duplicates.
 *   - The catalog is whatever `PLAYBOOKS` and `listSkills()` return AT BUILD TIME.
 *     Nothing here names a class, a family or a pack id. A pack added to
 *     `skills/` in a later change appears in the console with no edit to this
 *     file, and a pack that fails to parse simply is not listed.
 *
 * `listSkills()` is the same accessor the hunter prompt uses, so the Library
 * cannot disagree with what the bot would actually run.
 *
 * Note on `domain`: the four families the operator thinks in are `sol`, `mob`,
 * `web` and `infra`, which are SKILL ID PREFIXES (`sol.reentrancy`,
 * `web.ssrf`). They are NOT the `cls` field, which only has three values
 * (web2 | solidity | infra) and has no mobile member. So packs are grouped by id
 * prefix, and playbooks are mapped from `cls` with the id prefix as the fallback.
 */

import { PLAYBOOKS } from '../playbooks.js';
import { listSkills, skillLoadReport } from '../skills.js';
import type { UiEnv } from './env.js';

export type Domain = 'sol' | 'svm' | 'mob' | 'web' | 'infra' | 'other';

/**
 * `svm` is separate from `sol` on purpose, and this was a real defect until it
 * was split: `sol.svm-account`, `sol.svm-cpi` and `sol.svm-signer` are Solana
 * programmes whose id prefix is `sol.`, so a prefix-only grouping filed them
 * under a heading that reads "Solidity". The class is the correct key here, not
 * the prefix, because the prefix lies about the chain.
 */
export const DOMAIN_LABEL: Record<Domain, string> = {
  sol: 'Solidity',
  svm: 'Solana',
  mob: 'Mobile',
  web: 'Web / API',
  infra: 'Infrastructure',
  other: 'Other',
};

/** Display order. A domain nobody has a capability in is simply absent. */
export const DOMAIN_ORDER: Domain[] = ['sol', 'svm', 'mob', 'web', 'infra', 'other'];

function asDomain(head: string): Domain {
  return head === 'sol' || head === 'mob' || head === 'web' || head === 'infra' ? head : 'other';
}

/**
 * A pack's domain is its class first, its id prefix second.
 *
 * Class first is the fix: a `sol.*` pack that declares `cls: 'solana'` is a
 * Solana programme and belongs under Solana regardless of its prefix.
 */
export function domainOfPackId(id: string, cls?: string): Domain {
  if (cls === 'solana') return 'svm';
  if (cls === 'solidity') return 'sol';
  const head = id.split('.')[0];
  return head ? asDomain(head) : 'other';
}

/** A playbook's domain comes from its class, which is the routing key. */
export function domainOfPlaybook(cls: string, id: string): Domain {
  if (cls === 'solidity') return 'sol';
  if (cls === 'solana') return 'svm';
  if (cls === 'web2') return 'web';
  if (cls === 'infra') return 'infra';
  return domainOfPackId(id, cls);
}

/**
 * One capability. `hasPlaybook` means the runner can route and prove it;
 * `hasPack` means there is methodology and a question set behind it. An entry
 * with neither cannot exist - entries are built from the union of the two lists.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  domain: Domain;
  cls: string;
  /** The narrower grouping inside a domain: access-control, injection, ... */
  family: string;
  hasPlaybook: boolean;
  hasPack: boolean;
  /** Playbook facet. Null when this id has no playbook. */
  mut: string | null;
  probes: number;
  needsApproval: boolean;
  proof: string | null;
  /** Pack facet. Zero when this id has no pack. */
  questions: number;
  packVersion: number | null;
  /** Union of both, deduped, capped so one entry cannot bloat the payload. */
  requires: string[];
}

export interface CatalogDomain {
  id: Domain;
  label: string;
  entries: number;
  playbooks: number;
  packs: number;
  families: string[];
}

export interface Catalog {
  entries: CatalogEntry[];
  domains: CatalogDomain[];
  totals: { entries: number; playbooks: number; packs: number; domains: number };
  /** Whether the packs were actually loadable, and why not when they were not. */
  load: { ok: boolean; count: number; reason: string; source: 'disk' | 'embedded' };
}

const MAX_REQUIRES = 8;

/**
 * Build the catalog. Pure read of two in-process lists: no D1, no network, no
 * model. `env` is accepted so the signature matches the other view builders and
 * so a future filter (say, hiding packs the operator cannot run) has somewhere to
 * live without changing callers.
 */
export function buildCatalog(_env?: UiEnv): Catalog {
  const packs = listSkills();
  const report = skillLoadReport();

  const packById = new Map(packs.map((p) => [p.id, p]));

  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();

  for (const pb of PLAYBOOKS) {
    const pack = packById.get(pb.id);
    seen.add(pb.id);
    entries.push({
      id: pb.id,
      name: pb.name,
      domain: domainOfPlaybook(pb.cls, pb.id),
      cls: pb.cls,
      family: pb.family,
      hasPlaybook: true,
      hasPack: Boolean(pack),
      mut: pb.mut,
      probes: pb.probes.length,
      needsApproval: pb.needsApproval === true,
      proof: pb.proof,
      questions: pack ? pack.questionCount : 0,
      packVersion: pack ? pack.version : null,
      requires: dedupe([...pb.requires, ...(pack ? pack.requires : [])]).slice(0, MAX_REQUIRES),
    });
  }

  // A pack with no playbook is still a real capability - it is methodology the
  // operator can read and answer questions from. Listing it is the point of
  // enumerating rather than joining on the playbook list.
  for (const pack of packs) {
    if (seen.has(pack.id)) continue;
    entries.push({
      id: pack.id,
      name: pack.name,
      domain: domainOfPackId(pack.id, pack.cls),
      cls: pack.cls,
      family: pack.family,
      hasPlaybook: false,
      hasPack: true,
      mut: null,
      probes: 0,
      needsApproval: false,
      proof: null,
      questions: pack.questionCount,
      packVersion: pack.version,
      requires: dedupe(pack.requires).slice(0, MAX_REQUIRES),
    });
  }

  const order: Record<string, number> = {};
  DOMAIN_ORDER.forEach((d, i) => {
    order[d] = i;
  });
  entries.sort(
    (a, b) =>
      (order[a.domain] ?? 9) - (order[b.domain] ?? 9) ||
      a.family.localeCompare(b.family) ||
      a.id.localeCompare(b.id),
  );

  const domains: CatalogDomain[] = [];
  for (const d of DOMAIN_ORDER) {
    const mine = entries.filter((e) => e.domain === d);
    if (mine.length === 0) continue;
    domains.push({
      id: d,
      label: DOMAIN_LABEL[d],
      entries: mine.length,
      playbooks: mine.filter((e) => e.hasPlaybook).length,
      packs: mine.filter((e) => e.hasPack).length,
      families: dedupe(mine.map((e) => e.family)).sort(),
    });
  }

  return {
    entries,
    domains,
    totals: {
      entries: entries.length,
      playbooks: entries.filter((e) => e.hasPlaybook).length,
      packs: entries.filter((e) => e.hasPack).length,
      domains: domains.length,
    },
    load: {
      ok: report.ok,
      count: report.count,
      reason: report.reason,
      // The Worker has no filesystem, so the deployed console reads the
      // generated embed; a test process reads the directory. Both are reported
      // so "the Library is empty" is never a mystery.
      source: report.root ? 'disk' : 'embedded',
    },
  };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter((s) => typeof s === 'string' && s.length > 0))];
}
