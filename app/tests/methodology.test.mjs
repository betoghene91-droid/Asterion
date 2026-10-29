import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMethodology, methodologyEnvelope } from '../build/methodology.js';
import { MAX_PROMPT_CHARS, listSkills } from '../build/skills.js';

const base = {
  program_id: 'p',
  title: 't',
  cls: 'solidity',
  targets: ['https://github.com/acme/vault'],
  playbooks: [],
  max_mutability: 'read',
  time_box_minutes: 30,
  authorization_ref: 'a',
  stop_condition: 's',
  out_of_scope: [],
  notes: '',
};

// The defect this module exists to fix: a fully-tested skills subsystem that
// production never called. These tests assert the SEAM, not the packs.

test('THE SEAM: a brief actually yields a non-empty methodology block', () => {
  const pick = deriveMethodology(base);
  assert.ok(pick.block.length > 0, 'production path produced no methodology at all');
  assert.ok(pick.skill_id, 'no skill id recorded');
});

test('an exact playbook match wins over the class default', () => {
  const pick = deriveMethodology({ ...base, playbooks: ['sol.reentrancy'] });
  assert.equal(pick.skill_id, 'sol.reentrancy');
  assert.match(pick.reason, /^playbook:/);
});

test('a playbook with no pack falls back to a labelled class default', () => {
  const pick = deriveMethodology({ ...base, playbooks: ['sol.not-a-real-pack'] });
  assert.equal(pick.reason.startsWith('class-default:'), true);
  assert.equal(pick.skill_id, 'sol.accesscontrol');
});

test('web2 briefs get a web2 pack, not a solidity one', () => {
  const pick = deriveMethodology({ ...base, cls: 'web2' });
  assert.equal(pick.skill_id?.startsWith('web.'), true);
});

test('the block is bounded by the single-prompt cap', () => {
  for (const s of listSkills()) {
    const pick = deriveMethodology({ ...base, playbooks: [s.id] });
    assert.ok(
      pick.block.length <= MAX_PROMPT_CHARS + 200,
      `${s.id} block ${pick.block.length} exceeds cap ${MAX_PROMPT_CHARS}`,
    );
  }
});

test('an unmapped class degrades to empty with a reason, never a throw', () => {
  const pick = deriveMethodology({ ...base, cls: 'bogus-class' });
  assert.equal(pick.block, '');
  assert.equal(pick.skill_id, null);
  assert.match(pick.reason, /unmapped-class/);
});

test('the envelope labels which methodology was used', () => {
  const matched = methodologyEnvelope(deriveMethodology({ ...base, playbooks: ['sol.dos'] }));
  assert.match(matched, /asterion methodology: sol\.dos \(matched\)/);
  const def = methodologyEnvelope(deriveMethodology(base));
  assert.match(def, /\(class default\)/);
});

test('an empty pick yields no envelope, so the caller can omit the block', () => {
  assert.equal(methodologyEnvelope(deriveMethodology({ ...base, cls: 'bogus' })), '');
});

// Negative control: if the module were cut out of the production path again,
// this would be the only test that still passed — so assert a real dispatch
// surface, not just the helper.
test('NEGATIVE CONTROL: every sol playbook in the catalog resolves to a block', () => {
  const sol = listSkills().filter((s) => s.cls === 'solidity').map((s) => s.id);
  assert.ok(sol.length >= 10, `expected >=10 solidity packs, got ${sol.length}`);
  for (const id of sol) {
    const pick = deriveMethodology({ ...base, playbooks: [id] });
    assert.ok(pick.block.length > 0, `${id} produced no block`);
  }
});
