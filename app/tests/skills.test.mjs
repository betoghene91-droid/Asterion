// Tests for the skills system: the packs on disk, the loader, and the ordering.
//
// Two kinds of test here, deliberately:
//   1. SHAPE  — every skill.json validates and the id set equals the playbook
//      set, so a skill can never drift from a playbook the bot can actually run.
//   2. CONTENT GUARD — the questions are the product value. A skill with five
//      "is it vulnerable?" strings would pass a shape test and be worthless, so
//      these tests check for distinctness, length, and filler markers.
//
// Run with: node --test tests/skills.test.mjs  (after `npm run build`)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  listSkills,
  getSkill,
  selectSkills,
  questionsFor,
  renderSkillForPrompt,
  skillLoadReport,
  resetSkillCache,
  MAX_PROMPT_CHARS,
  REQUIRED_SKILL_KEYS,
} from '../build/skills.js';
import { PLAYBOOKS } from '../build/playbooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(HERE, '..', '..', 'skills');

/** The sol.* playbooks this task requires a skill for. */
const EXPECTED_SOL = [
  'sol.accesscontrol',
  'sol.delegatecall',
  'sol.dos',
  'sol.flashloan',
  'sol.inflation',
  'sol.oracle',
  'sol.reentrancy',
  'sol.rounding',
  'sol.signature',
  'sol.svm-account',
  'sol.svm-cpi',
  'sol.svm-signer',
  'sol.upgrade',
];

/**
 * The web2 / infra packs added to close the coverage gap against the digest.
 *
 * Every one of these has n=0 in corpus-digest.json — the 180,907-row corpus is
 * entirely web3 audit findings. They are first-principles packs, and each one
 * says so in its own SKILL.md rather than implying corpus grounding.
 *
 * `web.takeover` is here despite its name: the playbook declares
 * cls: 'infra' / family: 'dns', so its pack does too.
 */
const EXPECTED_WEB = [
  'web.authz.function',
  'web.cors',
  'web.graphql',
  'web.idor',
  'web.jwt',
  'web.massassign',
  'web.oauth',
  'web.race',
  'web.reset',
  'web.sqli',
  'web.ssrf',
  'web.takeover',
  'web.traversal',
  'web.upload',
  'web.xss.reflected',
];

/** Every pack that must exist: 10 solidity + 15 web/infra. */
const EXPECTED_ALL = [...EXPECTED_SOL, ...EXPECTED_WEB].sort();

const FILLER = [
  'todo',
  'tbd',
  'fixme',
  'lorem',
  'ipsum',
  'example skill',
  'placeholder',
  'xxx',
  'coming soon',
  'insert here',
];

function dirs() {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function rawSkill(dir) {
  return JSON.parse(readFileSync(join(SKILLS_ROOT, dir, 'skill.json'), 'utf8'));
}

function words(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

// ─────────────────────────── on-disk shape ───────────────────────────

test('skills directory exists and has one directory per expected sol playbook', () => {
  assert.ok(existsSync(SKILLS_ROOT), `missing skills dir at ${SKILLS_ROOT}`);
  const present = dirs();
  for (const id of EXPECTED_SOL) {
    assert.ok(present.includes(id), `missing skill directory for ${id}`);
  }
});

test('every skill directory has both SKILL.md and skill.json', () => {
  for (const dir of dirs()) {
    assert.ok(existsSync(join(SKILLS_ROOT, dir, 'SKILL.md')), `${dir}: missing SKILL.md`);
    assert.ok(existsSync(join(SKILLS_ROOT, dir, 'skill.json')), `${dir}: missing skill.json`);
  }
});

test('every skill.json parses and carries every required key', () => {
  for (const dir of dirs()) {
    const s = rawSkill(dir);
    for (const k of REQUIRED_SKILL_KEYS) {
      assert.ok(k in s, `${dir}: missing required key "${k}"`);
    }
    assert.equal(typeof s.id, 'string');
    assert.equal(s.id, dir, `${dir}: id does not match directory`);
    assert.equal(typeof s.version, 'number');
    assert.equal(typeof s.name, 'string');
    // The allowlist gains 'solana' because the three sol.svm-* packs are Solana
    // methodology. That is a statement about the PACK, not about a proof plane:
    // dispatch.ts still refuses them by name because svm-harness.ts does not
    // exist. Declaring them 'solidity' is what made that refusal impossible.
    assert.ok(
      ['web2', 'solidity', 'infra', 'solana'].includes(s.cls),
      `${dir}: bad cls ${JSON.stringify(s.cls)}`,
    );
    assert.equal(typeof s.family, 'string');
    assert.ok(Array.isArray(s.requires) && s.requires.length >= 1, `${dir}: requires`);
    assert.ok(Array.isArray(s.questions), `${dir}: questions must be an array`);
    assert.ok(Array.isArray(s.false_positives), `${dir}: false_positives`);
    assert.ok(Array.isArray(s.poc_must_show), `${dir}: poc_must_show`);
    assert.equal(typeof s.impact_bar, 'string');
    assert.ok(s.impact_bar.length > 30, `${dir}: impact_bar too thin`);
  }
});

test('skill ids are exactly the sol.* playbook ids in playbooks.ts, per class', () => {
  // This used to compare "every sol.* skill dir" against "every solidity
  // playbook", which held only because the three sol.svm-* packs wrongly
  // declared cls: 'solidity'. They are Solana programs with no EVM plane, so
  // they now declare 'solana' — and the comparison becomes per-class, which is
  // STRICTER: a pack that declares the wrong class fails here instead of
  // blending in.
  for (const cls of ['solidity', 'solana']) {
    const playbookIds = PLAYBOOKS.filter((p) => p.cls === cls)
      .map((p) => p.id)
      .sort();
    const skillIds = dirs()
      .filter((d) => d.startsWith('sol.'))
      .filter((d) => rawSkill(d).cls === cls)
      .sort();
    assert.deepEqual(skillIds, playbookIds, `${cls}: skill set must equal its playbook set`);
  }

  // And nothing sol.*-shaped may declare a class outside the two.
  const all = dirs().filter((d) => d.startsWith('sol.'));
  for (const d of all) {
    assert.ok(
      ['solidity', 'solana'].includes(rawSkill(d).cls),
      `${d}: sol.* pack declared unexpected cls ${rawSkill(d).cls}`,
    );
  }
  assert.deepEqual(all.sort(), [...EXPECTED_SOL].sort());
  assert.equal(all.length, 13, 'the sol.* pack set is 13 ids and must not drift');
});

test('every non-solidity digest class with a playbook now has a pack', () => {
  // The gap this closes: the digest defines the classes the bot knows about, and
  // a class with no pack is a class the bot hunts with no methodology at all.
  const present = new Set(dirs());
  for (const id of EXPECTED_WEB) {
    assert.ok(present.has(id), `missing pack for ${id}`);
  }
  // And the pack set must not drift from the declared expectation.
  assert.deepEqual([...present].sort(), EXPECTED_ALL);
});

test('every pack maps to a class id that the corpus digest actually defines', () => {
  const digest = JSON.parse(readFileSync(join(HERE, '..', 'src', 'corpus-digest.json'), 'utf8'));
  for (const id of dirs()) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(digest.classes, id),
      `${id} is not a class in corpus-digest.json`,
    );
  }
});

test('web2 packs default their cls from the playbook, not from the digest name', () => {
  // web.takeover is cls:'infra' in playbooks.ts despite its web.* id. A pack that
  // guessed 'web2' from the prefix would pass a softer test and break selection.
  for (const id of EXPECTED_WEB) {
    const p = PLAYBOOKS.find((x) => x.id === id);
    const s = rawSkill(id);
    assert.equal(s.cls, p.cls, `${id}: cls must match its playbook`);
    assert.equal(s.family, p.family, `${id}: family must match its playbook`);
  }
});

test('every web pack states plainly that it has no corpus precedent', () => {
  // The honest-reporting guard. These classes are n=0, so a pack that sounded
  // corpus-grounded would be fabricating authority it does not have.
  for (const id of EXPECTED_WEB) {
    const md = readFileSync(join(SKILLS_ROOT, id, 'SKILL.md'), 'utf8');
    assert.match(md, /n=0/, `${id}: SKILL.md must state the n=0 corpus count`);
    assert.match(
      md,
      /first-principles/i,
      `${id}: SKILL.md must say the questions are first-principles reasoning`,
    );
  }
});

test('no skill exists for a playbook id that does not exist', () => {
  const known = new Set(PLAYBOOKS.map((p) => p.id));
  for (const dir of dirs()) {
    assert.ok(known.has(dir), `skill "${dir}" has no matching playbook — dead skill`);
  }
});

test('each sol skill declares family and cls consistent with its playbook', () => {
  for (const dir of dirs()) {
    const p = PLAYBOOKS.find((x) => x.id === dir);
    const s = rawSkill(dir);
    assert.equal(s.cls, p.cls, `${dir}: cls mismatch`);
    assert.equal(s.family, p.family, `${dir}: family mismatch`);
  }
});

// ────────────────────────── content quality guard ──────────────────────────

test('no skill file contains filler markers', () => {
  for (const dir of dirs()) {
    for (const name of ['SKILL.md', 'skill.json']) {
      const text = readFileSync(join(SKILLS_ROOT, dir, name), 'utf8').toLowerCase();
      for (const marker of FILLER) {
        assert.ok(!text.includes(marker), `${dir}/${name}: filler marker "${marker}"`);
      }
    }
  }
});

test('SKILL.md files carry the six required sections', () => {
  const sections = [
    'when this is worth hunting',
    'how to confirm it is even reachable',
    'discriminating questions',
    'common false positives',
    'what a minimal poc must demonstrate',
    'impact bar',
  ];
  for (const dir of dirs()) {
    const text = readFileSync(join(SKILLS_ROOT, dir, 'SKILL.md'), 'utf8').toLowerCase();
    for (const s of sections) {
      assert.ok(text.includes(s), `${dir}/SKILL.md: missing section "${s}"`);
    }
  }
});

test('SKILL.md is substantial, not a stub', () => {
  for (const dir of dirs()) {
    const text = readFileSync(join(SKILLS_ROOT, dir, 'SKILL.md'), 'utf8');
    assert.ok(text.length >= 3000, `${dir}: SKILL.md is ${text.length} chars, too thin`);
    assert.ok(text.split('\n').length >= 60, `${dir}: fewer than 60 lines`);
  }
});

test('each skill has >= 6 distinct, substantive questions', () => {
  for (const dir of dirs()) {
    const qs = rawSkill(dir).questions;
    assert.ok(qs.length >= 6, `${dir}: only ${qs.length} questions`);
    const seen = new Set();
    for (const q of qs) {
      assert.ok(typeof q === 'string' && q.trim().length > 0, `${dir}: empty question`);
      assert.ok(q.length >= 60, `${dir}: question too short to discriminate: "${q}"`);
      assert.ok(q.trim().endsWith('?'), `${dir}: question does not end with "?": "${q}"`);
      const key = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      assert.ok(!seen.has(key), `${dir}: duplicate question: "${q}"`);
      seen.add(key);
    }
  }
});

test('questions are class-specific: whole-pack token overlap stays low', () => {
  // A generic question set ("is user input validated?") would appear in every
  // skill. Compare question-token overlap between skills: distinct classes must
  // not be near-verbatim copies of one another.
  const byId = new Map(dirs().map((d) => [d, rawSkill(d).questions]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = new Set(byId.get(ids[i]).flatMap(words));
      const b = new Set(byId.get(ids[j]).flatMap(words));
      const inter = [...a].filter((w) => b.has(w)).length;
      const union = new Set([...a, ...b]).size;
      const jaccard = inter / union;
      assert.ok(
        jaccard < 0.45,
        `${ids[i]} and ${ids[j]} question sets are too similar (jaccard ${jaccard.toFixed(2)})`,
      );
    }
  }
});

test('no single question is duplicated across two packs (max pairwise jaccard)', () => {
  // The test above flattens every question of a pack into one token set, which
  // DILUTES a single copied question among ~100 tokens. Measured: it reported
  // 0.196 between sol.accesscontrol and sol.upgrade while a genuine near-verbatim
  // pair sat at 0.533 per-question. One duplicated question is a real defect —
  // it doubles prompt cost and reads as boilerplate — so compare question to
  // question and take the max. Observed worst genuine pair after differentiation
  // is 0.296, so 0.45 separates "same class, sharpened differently" from "copied".
  const PAIR_MAX = 0.45;
  const byId = new Map(dirs().map((d) => [d, rawSkill(d).questions]));
  const ids = [...byId.keys()];
  let worst = { v: 0 };

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const qa of byId.get(ids[i])) {
        for (const qb of byId.get(ids[j])) {
          const a = new Set(words(qa));
          const b = new Set(words(qb));
          const inter = [...a].filter((w) => b.has(w)).length;
          const union = new Set([...a, ...b]).size;
          const v = union ? inter / union : 0;
          if (v > worst.v) worst = { v, a: ids[i], b: ids[j], qa, qb };
          assert.ok(
            v < PAIR_MAX,
            `${ids[i]} and ${ids[j]} share a near-duplicate question (jaccard ${v.toFixed(3)}):\n  A: ${qa}\n  B: ${qb}`,
          );
        }
      }
    }
  }
  // Guard the guard: if tokenisation silently broke, every score would be 0 and
  // the assertion above would pass vacuously. A real catalog must show SOME
  // overlap between adjacent classes.
  assert.ok(worst.v > 0.1, `tokenisation looks broken: worst pair scored ${worst.v.toFixed(3)}`);
});

test('each skill has >= 4 distinct false positives and >= 3 poc obligations', () => {
  for (const dir of dirs()) {
    const s = rawSkill(dir);
    assert.ok(s.false_positives.length >= 4, `${dir}: only ${s.false_positives.length} false positives`);
    assert.ok(s.poc_must_show.length >= 3, `${dir}: only ${s.poc_must_show.length} poc obligations`);
    for (const arr of [s.false_positives, s.poc_must_show]) {
      const seen = new Set();
      for (const x of arr) {
        assert.ok(typeof x === 'string' && x.trim().length >= 15, `${dir}: entry too thin: "${x}"`);
        const key = x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        assert.ok(!seen.has(key), `${dir}: duplicate entry: "${x}"`);
        seen.add(key);
      }
    }
  }
});

// ──────────────────────────── loader behaviour ────────────────────────────

test('listSkills returns every on-disk skill with usable metadata', () => {
  const list = listSkills();
  assert.equal(list.length, dirs().length);
  assert.deepEqual(list.map((s) => s.id), dirs());
  for (const m of list) {
    assert.ok(m.questionCount >= 6, `${m.id}: questionCount ${m.questionCount}`);
    assert.ok(m.requires.length >= 1);
    assert.ok(m.name.length > 10);
  }
});

test('skillLoadReport reports ok with the resolved root', () => {
  const r = skillLoadReport();
  assert.equal(r.ok, true);
  assert.equal(r.count, dirs().length);
  assert.ok(r.reason.includes('loaded'));
  assert.ok(r.issues.length === 0, `unexpected load issues: ${r.issues.join('; ')}`);
});

test('getSkill returns null for an unknown id and does not throw', () => {
  assert.equal(getSkill('sol.does.not.exist'), null);
  assert.equal(getSkill(''), null);
  assert.equal(getSkill('__proto__'), null);
});

test('getSkill returns the full record, with the md body attached', () => {
  const s = getSkill('sol.reentrancy');
  assert.ok(s);
  assert.equal(s.id, 'sol.reentrancy');
  assert.ok(s.questions.length >= 6);
  assert.ok(s.body.length > 3000, 'SKILL.md body should be attached');
  assert.ok(s.impact_bar.length > 30);
});

test('getSkill returns a copy: mutating it does not corrupt the cache', () => {
  const a = getSkill('sol.oracle');
  a.questions.push('injected?');
  const b = getSkill('sol.oracle');
  assert.ok(!b.questions.includes('injected?'));
});

// ──────────────────────────── degradation ────────────────────────────

test('listSkills degrades to [] for a nonexistent directory instead of throwing', () => {
  const root = '/nonexistent/asterion/skills';
  assert.deepEqual(listSkills({ root }), []);
  const r = skillLoadReport({ root });
  assert.equal(r.ok, false);
  assert.equal(r.count, 0);
  assert.match(r.reason, /unreadable|no valid skills/);
});

test('getSkill and questionsFor return null / [] on a nonexistent directory', () => {
  const root = '/nonexistent/asterion/skills';
  assert.equal(getSkill('sol.reentrancy', { root }), null);
  assert.deepEqual(questionsFor('sol.reentrancy', { root }), []);
  assert.equal(renderSkillForPrompt('sol.reentrancy', { root }), '');
  assert.deepEqual(selectSkills({ root, playbook: 'sol.reentrancy' }), []);
});

test('an empty directory degrades to [] rather than throwing', () => {
  const root = join(HERE, 'fixtures-empty-skills');
  assert.deepEqual(listSkills({ root }), []);
  assert.equal(skillLoadReport({ root }).ok, false);
});

test('a corrupt skill.json is reported as an issue, not a crash', () => {
  const root = join(HERE, 'fixtures-bad-skills');
  const list = listSkills({ root });
  // The bad pack must be dropped; the good one must survive.
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'sol.reentrancy');
  const r = skillLoadReport({ root });
  assert.ok(r.issues.some((i) => i.includes('sol.broken')), `issues: ${r.issues.join('; ')}`);
});

test('resetSkillCache clears memoisation without breaking the API', () => {
  const before = listSkills().length;
  resetSkillCache();
  assert.equal(listSkills().length, before);
});

// ──────────────────────────── selection order ────────────────────────────

test('selectSkills without arguments returns every skill, id-ascending', () => {
  const got = selectSkills().map((s) => s.id);
  assert.deepEqual(got, dirs());
});

test('selectSkills puts the exact playbook first, then corpus weight descending', () => {
  // Weights below are the real digest values for the demo, deliberately
  // shuffled so a bug in the ordering cannot pass by accident.
  const weights = {
    'sol.reentrancy': 0.996,
    'sol.accesscontrol': 0.933,
    'sol.oracle': 0.925,
    'sol.rounding': 0.8,
    'sol.inflation': 1.255,
    'sol.upgrade': 0.651,
    'sol.signature': 0.848,
    'sol.delegatecall': 0.535,
    'sol.flashloan': 1.167,
    'sol.dos': 0.797,
  };
  const got = selectSkills({ playbook: 'sol.upgrade', weights }).map((s) => s.id);
  assert.equal(got[0], 'sol.upgrade', 'exact playbook must lead despite the lowest weight');
  const rest = got.slice(1);
  const w = (id) => weights[id] ?? 0;
  for (let i = 1; i < rest.length; i++) {
    assert.ok(
      w(rest[i - 1]) >= w(rest[i]),
      `weight order broken at ${rest[i - 1]} (${w(rest[i - 1])}) then ${rest[i]} (${w(rest[i])})`,
    );
    // A tie is legitimate and is NOT free ordering. sol.svm-signer,
    // sol.svm-account and sol.svm-cpi are n=0 classes with weight 0.0 in
    // corpus-digest.json — unmeasured, not unprofitable — so with no weight
    // supplied they tie with each other and with any other unweighted pack
    // (web.graphql is the pre-existing one). The documented rule is then id
    // ascending. A strict `>` here would force a fabricated nonzero weight onto
    // an unmeasured class to make the test pass, which is exactly the v4 bug.
    // Pin the tie-break instead, so the order stays total and deterministic.
    if (w(rest[i - 1]) === w(rest[i])) {
      assert.ok(
        rest[i - 1] < rest[i],
        `equal weights ${w(rest[i - 1])} must tie-break on id ascending, got ${rest[i - 1]} then ${rest[i]}`,
      );
    }
  }
});

test('selectSkills is deterministic across repeated calls', () => {
  const weights = { 'sol.inflation': 1.25, 'sol.dos': 0.8, 'sol.oracle': 0.9 };
  const a = selectSkills({ playbook: 'sol.rounding', weights }).map((s) => s.id);
  const b = selectSkills({ playbook: 'sol.rounding', weights }).map((s) => s.id);
  resetSkillCache();
  const c = selectSkills({ playbook: 'sol.rounding', weights }).map((s) => s.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test('selectSkills tie-breaks on id ascending when weights are equal or absent', () => {
  const got = selectSkills({ playbook: 'sol.dos' }).map((s) => s.id);
  assert.equal(got[0], 'sol.dos');
  const rest = got.slice(1);
  assert.deepEqual(rest, [...rest].sort(), 'ties must fall back to id ascending');
});

test('selectSkills honours corpusWeight for the exact playbook only', () => {
  // corpusWeight ranks the playbook itself; siblings all tie at 0 and sort by id.
  const got = selectSkills({ playbook: 'sol.signature', corpusWeight: 0.848 }).map((s) => s.id);
  assert.equal(got[0], 'sol.signature');
  assert.deepEqual(got.slice(1), [...got.slice(1)].sort());
});

test('selectSkills filter by cls returns only that class', () => {
  // Counted per class rather than against EXPECTED_SOL: the 13 sol.* packs are
  // now split 10 solidity + 3 solana, so "every sol.* pack is solidity" is no
  // longer true and asserting it would force the svm packs back into a class
  // whose plane cannot run them.
  const solIds = EXPECTED_SOL;
  const solidityIds = solIds.filter((id) => rawSkill(id).cls === 'solidity');
  const solanaIds = solIds.filter((id) => rawSkill(id).cls === 'solana');
  assert.equal(solidityIds.length + solanaIds.length, solIds.length, 'every sol.* pack has a class');
  assert.equal(solanaIds.length, 3, 'the three svm packs are the solana class');

  const got = selectSkills({ cls: 'solidity' });
  assert.deepEqual(got.map((s) => s.id).sort(), [...solidityIds].sort());
  assert.ok(got.every((s) => s.cls === 'solidity'));

  // And the solana filter returns exactly the three svm packs, nothing else.
  const svm = selectSkills({ cls: 'solana' });
  assert.deepEqual(svm.map((s) => s.id).sort(), [...solanaIds].sort());
  assert.ok(svm.every((s) => s.cls === 'solana'));

  // web2 is a real class now: 14 web.* packs belong to it, and web.takeover does not.
  const web = selectSkills({ cls: 'web2' });
  assert.equal(web.length, EXPECTED_WEB.length - 1);
  assert.ok(web.every((s) => s.cls === 'web2'), 'cls filter must not leak another class');
  assert.ok(!web.some((s) => s.id === 'web.takeover'), 'web.takeover is infra, not web2');

  const infra = selectSkills({ cls: 'infra' });
  assert.deepEqual(infra.map((s) => s.id), ['web.takeover']);
});

test('selectSkills returns no body prose inside the discriminating fields', () => {
  // The selector builds a prompt from questions/requires. A markdown body or a
  // wrapped prose line leaking into those arrays would silently bloat every
  // prompt and read as a malformed question, so pin it.
  for (const s of selectSkills()) {
    for (const q of s.questions) {
      assert.ok(!q.includes('\n'), `${s.id}: question contains a newline`);
      assert.ok(!q.includes('##'), `${s.id}: question contains markdown heading text`);
      assert.ok(q.length <= 400, `${s.id}: question is prose-length (${q.length})`);
    }
    for (const r of s.requires) {
      assert.ok(!r.includes('\n'), `${s.id}: requires contains a newline`);
      assert.ok(!r.includes('##'), `${s.id}: requires contains markdown heading text`);
    }
  }
});

test('selectSkills resolves the exact pack for every new web playbook id', () => {
  for (const id of EXPECTED_WEB) {
    const got = selectSkills({ playbook: id });
    assert.ok(got.length > 0, `${id}: selection returned nothing`);
    assert.equal(got[0].id, id, `${id}: exact playbook must rank first`);
  }
});

test('selectSkills limit caps the result without reordering', () => {
  const full = selectSkills({ playbook: 'sol.oracle' }).map((s) => s.id);
  const capped = selectSkills({ playbook: 'sol.oracle', limit: 3 }).map((s) => s.id);
  assert.equal(capped.length, 3);
  assert.deepEqual(capped, full.slice(0, 3));
  assert.deepEqual(selectSkills({ playbook: 'sol.oracle', limit: 0 }), []);
});

test('selectSkills returns [] for an unknown playbook rather than throwing', () => {
  assert.deepEqual(selectSkills({ playbook: 'sol.nope' }), []);
});

// ──────────────────────────── surfaces ────────────────────────────

test('questionsFor returns >= 5 non-empty questions for every sol skill', () => {
  for (const id of EXPECTED_SOL) {
    const qs = questionsFor(id);
    assert.ok(qs.length >= 5, `${id}: only ${qs.length} questions`);
    assert.ok(qs.every((q) => typeof q === 'string' && q.trim().length > 0));
  }
  assert.deepEqual(questionsFor('nope'), []);
});

test('renderSkillForPrompt stays under the stated cap for every skill', () => {
  for (const id of dirs()) {
    const out = renderSkillForPrompt(id);
    assert.ok(out.length > 200, `${id}: prompt block suspiciously small`);
    assert.ok(out.length <= MAX_PROMPT_CHARS, `${id}: ${out.length} > cap ${MAX_PROMPT_CHARS}`);
  }
});

test('renderSkillForPrompt carries the load-bearing parts, and says it cannot prove', () => {
  const out = renderSkillForPrompt('sol.inflation');
  assert.match(out, /SKILL sol\.inflation v1/);
  assert.match(out, /DISCRIMINATING QUESTIONS/);
  assert.match(out, /IMPACT BAR/);
  assert.match(out, /cannot prove/);
  // every question must survive into the prompt
  for (const q of questionsFor('sol.inflation')) assert.ok(out.includes(q), `missing: ${q}`);
});

test('renderSkillForPrompt truncation keeps the cap and marks the cut', () => {
  // Exercised against a real over-long fixture (40 long questions), so this
  // asserts the guard works rather than asserting nothing happened.
  const root = join(HERE, 'fixtures-long-skills');
  const out = renderSkillForPrompt('sol.reentrancy', { root });
  assert.ok(out.includes('truncated at the prompt cap'), 'expected the fixture to be truncated');
  assert.equal(out.length, MAX_PROMPT_CHARS, 'truncated output must be exactly the cap');
  assert.ok(out.endsWith('truncated at the prompt cap]'));
  // The truncation must not silently drop the impact bar the model needs.
  assert.match(out, /SKILL sol\.reentrancy v1/);

  // And no real skill should be hitting the cap today.
  for (const id of dirs()) {
    const real = renderSkillForPrompt(id);
    assert.ok(
      !real.includes('truncated at the prompt cap'),
      `${id} is over the prompt cap — tighten it or raise MAX_PROMPT_CHARS`,
    );
  }
  assert.equal(renderSkillForPrompt('nope'), '');
});

test('a single hunter prompt stays inside the prompt budget', () => {
  // The cost that actually matters is ONE call's rendered block, not the sum of
  // the whole catalog — nobody prepends 25 packs to one prompt. Summing them
  // measured the catalog instead of the feature, so it drifted into a false
  // alarm as coverage grew. Pin the real invariant instead.
  for (const cls of ['solidity', 'web2', 'infra']) {
    for (const pb of PLAYBOOKS.filter((p) => p.cls === cls).map((p) => p.id)) {
      const rendered = selectSkills({ playbook: pb, limit: 1 })
        .reduce((n, s) => n + renderSkillForPrompt(s.id).length, 0);
      assert.ok(
        rendered <= MAX_PROMPT_CHARS,
        `${pb}: a one-pack prompt is ${rendered} chars, over the ${MAX_PROMPT_CHARS} cap`,
      );
    }
  }
});

test('the default multi-pack selection stays within a sane prompt budget', () => {
  // playbook + same-class siblings is the real default shape. With 14 web2
  // packs an uncapped selection is ~43k chars, which is why callers must pass a
  // limit; this pins the number the caller has to respect.
  const MAX_SELECTION_CHARS = 10_000;
  for (const pb of PLAYBOOKS.map((p) => p.id)) {
    const rendered = selectSkills({ playbook: pb, limit: 3 })
      .reduce((n, s) => n + renderSkillForPrompt(s.id).length, 0);
    assert.ok(
      rendered <= MAX_SELECTION_CHARS,
      `${pb}: a 3-pack selection is ${rendered} chars, over ${MAX_SELECTION_CHARS}`,
    );
  }
});

test('the full catalog is reportable, and its size is documented not assumed', () => {
  // Not a budget assertion: the whole catalog is a legitimate thing to measure
  // (it is what the embed ships) and an illegitimate thing to prepend to a
  // prompt. Bound it so a runaway pack is still caught.
  const total = dirs().reduce((n, id) => n + renderSkillForPrompt(id).length, 0);
  assert.ok(total < 90_000, `all prompt blocks total ${total} chars`);
});
