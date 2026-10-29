import type { Brief } from './intake.js';
import {
  MAX_PROMPT_CHARS,
  renderSkillForPrompt,
  selectSkills,
  type SkillCls,
} from './skills.js';

export interface MethodologyPick {
  block: string;
  skill_id: string | null;
  reason: string;
  truncated: boolean;
}

function skillClsFor(cls: string): SkillCls | null {
  if (cls === 'web2' || cls === 'web') return 'web2';
  if (cls === 'solidity' || cls === 'defi' || cls === 'sol') return 'solidity';
  if (cls === 'infra') return 'infra';
  return null;
}

/**
 * Pick the single highest-value pack for a brief.
 *
 * Precedence: a playbook named on the brief that HAS a pack wins; otherwise the
 * class's first pack, labelled as a class-level default; otherwise nothing.
 *
 * `limit: 1` is load-bearing: the uncapped web2 selection is ~42.7k chars across
 * 14 siblings, which would eat the context the actual code needs.
 */
export function deriveMethodology(brief: Brief): MethodologyPick {
  try {
    const cls = skillClsFor(brief.cls);

    for (const pb of brief.playbooks ?? []) {
      const hits = selectSkills({ playbook: pb, limit: 1 });
      const exact = hits.find((s) => s.id === pb);
      if (exact) return render(exact.id, `playbook:${pb}`);
    }

    if (cls) {
      const hits = selectSkills({ cls, limit: 1 });
      const first = hits[0];
      if (first) return render(first.id, `class-default:${cls}`);
      return { block: '', skill_id: null, reason: `no-pack-for-class:${cls}`, truncated: false };
    }

    return { block: '', skill_id: null, reason: `unmapped-class:${brief.cls}`, truncated: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { block: '', skill_id: null, reason: `skill-error:${msg.slice(0, 120)}`, truncated: false };
  }
}

function render(id: string, reason: string): MethodologyPick {
  const rendered = renderSkillForPrompt(id);
  if (!rendered) return { block: '', skill_id: null, reason: `render-empty:${id}`, truncated: false };
  return {
    block: rendered,
    skill_id: id,
    reason,
    truncated: rendered.length > MAX_PROMPT_CHARS,
  };
}

/**
 * Wrap the block with a provenance header so a hunter (and a reviewer) can see
 * WHICH methodology was applied and whether it was an exact match or a
 * class-level default. An unlabeled block is indistinguishable from
 * improvisation.
 */
export function methodologyEnvelope(pick: MethodologyPick): string {
  if (!pick.block) return '';
  const basis = pick.reason.startsWith('playbook:') ? 'matched' : 'class default';
  const cut = pick.truncated ? ' \u00b7 truncated to cap' : '';
  return [`<!-- asterion methodology: ${pick.skill_id} (${basis})${cut} -->`, pick.block].join('\n');
}
