/**
 * Skills must load from DISK and from the EMBEDDED bundle with no filesystem.
 *
 * The failure this pins is the one that shipped before: hundreds of green tests
 * and zero skills reaching a Worker prompt, because the Worker has no filesystem
 * and nothing embedded the packs. skills.ts degrades gracefully when the fs is
 * absent (it must not throw), but degrading to NOTHING is still nothing — hence
 * skills-embed.ts and this file.
 *
 * The fs-less case is simulated the way skills.ts actually probes: it calls
 * `process.getBuiltinModule('node:fs')`. Clearing that property is what makes
 * the import reach the embed, and it is checked here rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SKILLS_ROOT = join(APP, '..', 'skills');
const NO_ROOT = join(APP, 'tests', 'fixtures', 'no-such-skills-dir');

const { listSkills, getSkill, questionsFor, selectSkills, MAX_PROMPT_CHARS, renderSkillForPrompt } =
  await import('../build/skills.js');

/**
 * Import a fresh module instance with node:fs unavailable, so the ONLY possible
 * source of skills is SKILLS_EMBED. The cache-busting query forces a new
 * evaluation instead of reusing the disk-backed one already in memory.
 */
async function loadFsLess(tag) {
  const saved = process.getBuiltinModule;
  process.getBuiltinModule = undefined;
  try {
    return await import(`../build/skills.js?fsless=${tag}`);
  } finally {
    process.getBuiltinModule = saved;
  }
}

/** Directory names of the packs that actually ship on disk. */
function packsOnDisk() {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

test('all 25 packs exist on disk and every one is loadable', () => {
  const packs = packsOnDisk();
  assert.equal(packs.length, 25, `expected 25 packs on disk, found ${packs.length}`);

  const loaded = listSkills({ root: SKILLS_ROOT });
  assert.equal(loaded.length, 25, `expected 25 loadable packs, got ${loaded.length}`);
  assert.deepEqual(
    loaded.map((s) => s.id).sort(),
    packs,
    'every directory must yield a pack, and no pack may appear that is not on disk',
  );

  for (const id of packs) {
    const s = getSkill(id, { root: SKILLS_ROOT });
    assert.ok(s, `${id}: getSkill returned null from disk`);
    assert.equal(s.id, id);
    assert.ok(s.questionCount >= 5, `${id}: needs >= 5 questions`);
    assert.ok(s.false_positives.length > 0, `${id}: needs false positives`);
    assert.ok(s.poc_must_show.length > 0, `${id}: needs poc_must_show`);
    assert.ok(s.impact_bar && s.impact_bar.length > 10, `${id}: needs an impact bar`);
  }
});

test('the probe really is what disables the filesystem path', () => {
  // Guard against this file silently testing nothing: with the probe intact a
  // bogus root must yield NOTHING from disk. If that ever returns 25, the
  // "fs-less" test below would be passing on a warm disk cache, not the embed.
  assert.deepEqual(listSkills({ root: NO_ROOT }), [], 'a bogus root must not fall back to the embed');
  assert.equal(getSkill('web.cors', { root: NO_ROOT }), null);
});

test('the same 25 packs load with NO filesystem, from the embedded bundle', async () => {
  const embedded = await loadFsLess('bundle');
  const packs = packsOnDisk();

  // No root and no filesystem: SKILLS_EMBED is the only reachable source.
  const fromEmbed = embedded.listSkills();
  assert.equal(fromEmbed.length, 25, `expected 25 embedded packs, got ${fromEmbed.length}`);
  assert.deepEqual(fromEmbed.map((s) => s.id).sort(), packs, 'embedded catalog must match disk exactly');

  for (const id of packs) {
    const disk = getSkill(id, { root: SKILLS_ROOT });
    const emb = embedded.getSkill(id);
    assert.ok(emb, `${id}: not available from the embed`);
    assert.equal(emb.name, disk.name, `${id}: name differs between disk and embed`);
    assert.equal(emb.cls, disk.cls, `${id}: cls differs`);
    assert.equal(emb.family, disk.family, `${id}: family differs`);
    assert.equal(emb.questionCount, disk.questionCount, `${id}: question count differs`);
    assert.deepEqual(emb.questions, disk.questions, `${id}: questions differ`);
    assert.deepEqual(emb.false_positives, disk.false_positives, `${id}: false_positives differ`);
    assert.deepEqual(emb.poc_must_show, disk.poc_must_show, `${id}: poc_must_show differs`);
    assert.equal(emb.impact_bar, disk.impact_bar, `${id}: impact_bar differs`);
  }
});

test('questionsFor and the rendered prompt agree between disk and embed', async () => {
  const embedded = await loadFsLess('render');
  for (const id of packsOnDisk()) {
    assert.deepEqual(
      embedded.questionsFor(id),
      questionsFor(id, { root: SKILLS_ROOT }),
      `${id}: questionsFor disagrees between embed and disk`,
    );
    assert.equal(
      embedded.renderSkillForPrompt(embedded.getSkill(id)),
      renderSkillForPrompt(getSkill(id, { root: SKILLS_ROOT })),
      `${id}: rendered prompt differs between embed and disk`,
    );
  }
});

test('the embedded bundle carries SKILL.md body text, not just metadata', () => {
  // A metadata-only embed would still render the /skills card while the hunter
  // prompt got no methodology — the exact half-fix this guards against.
  const src = readFileSync(join(APP, 'src', 'skills-embed.ts'), 'utf8');
  const bodies = (src.match(/body:/g) ?? []).length;
  assert.ok(bodies >= 25, `skills-embed.ts must carry >= 25 bodies, found ${bodies}`);

  const md = readFileSync(join(SKILLS_ROOT, 'sol.reentrancy', 'SKILL.md'), 'utf8');
  const firstLine = md.trim().split('\n')[0].replace(/^#\s*/, '');
  assert.ok(
    src.includes(firstLine.slice(0, 40)),
    `a real SKILL.md body line must appear verbatim in the embed; looked for ${JSON.stringify(firstLine.slice(0, 40))}`,
  );
});

test('an unknown pack id degrades to null / [] rather than throwing', () => {
  assert.equal(getSkill('web.nonexistent', { root: SKILLS_ROOT }), null);
  assert.deepEqual(questionsFor('web.nonexistent', { root: SKILLS_ROOT }), []);
  assert.deepEqual(listSkills({ root: NO_ROOT }), []);
});

test('selectSkills still ranks the exact playbook first with v5 corpus weights', () => {
  const digest = JSON.parse(readFileSync(join(APP, 'src', 'corpus-digest.json'), 'utf8'));
  const weights = Object.fromEntries(Object.entries(digest.classes).map(([id, c]) => [id, c.weight]));
  const picked = selectSkills({ playbook: 'sol.reentrancy', weights, limit: 1 });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, 'sol.reentrancy');
});

test('rendered prompts stay inside the documented budget', () => {
  for (const id of packsOnDisk()) {
    const out = renderSkillForPrompt(getSkill(id, { root: SKILLS_ROOT }));
    assert.ok(
      out.length <= MAX_PROMPT_CHARS,
      `${id}: rendered ${out.length} chars exceeds MAX_PROMPT_CHARS ${MAX_PROMPT_CHARS}`,
    );
  }
});
