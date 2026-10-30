/**
 * Scope documents → `automation_allowed`, and the dispatch refusal it produces.
 *
 * THE FOUR FACTS, each with a test that fails if the classifier drifts:
 *
 *   1. `prohibitedActivites: null` — the field is PRESENT and EMPTY. That is not
 *      permission and it is not prohibition: it is `unknown`, and unknown does not
 *      dispatch. This is the test most likely to rot, because the tempting
 *      "optimisation" is to treat an empty field as "nothing prohibited here".
 *   2. Some programmes bar scanners outright.
 *   3. Some make UNATTENDED output ineligible without barring the tool — the run
 *      is fine, the report cannot be submitted. Different refusal, different
 *      operator action, so a different reason code.
 *   4. Some permit tools only with prior written consent, which we do not hold.
 *
 * And the rule that overrides all four: prohibition beats permission, and silence
 * is not consent.
 *
 * THE TEXT SAMPLES ARE SYNTHETIC. They are written to the shape of real
 * prohibited-activities prose, but no live payload carrying this field could be
 * fetched from this network (see `docs/discovery-limits.md`), so they are NOT
 * quoted from a real programme. A test that claimed otherwise would be inventing
 * provenance.
 *
 * Run with: node --test tests/targets-scope.test.mjs   (after `npm run build`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProhibitedActivities,
  parseCantina,
  parseHackenProof,
  parseImmunefi,
  parseScope,
  parseSherlock,
  readProhibitedField,
  refuseDispatch,
  reposFromText,
} from '../build/targets/scope.js';

// ── 1. the null field ───────────────────────────────────────────────────────

test('a null prohibited-activities field does NOT become allowed', () => {
  const v = classifyProhibitedActivities(null);
  assert.equal(v.automation_allowed, false);
  assert.equal(v.cls, 'unknown');
  assert.equal(v.reason, 'field-null');

  // The same through the field reader, which is where "present and null" is
  // distinguished from "absent".
  const field = readProhibitedField({ prohibitedActivites: null });
  assert.deepEqual(field, { present: true, value: null });
});

test('an ABSENT field does not become allowed either', () => {
  const field = readProhibitedField({ name: 'no terms here' });
  assert.deepEqual(field, { present: false, value: null });
  const v = classifyProhibitedActivities(undefined);
  assert.equal(v.automation_allowed, false);
  assert.equal(v.cls, 'unknown');
  assert.equal(v.reason, 'field-absent');
});

test('an empty string is no text, not permission', () => {
  const v = classifyProhibitedActivities('   \n\t ');
  assert.equal(v.automation_allowed, false);
  assert.equal(v.cls, 'unknown');
});

test('the misspelled prohibitedActivites spelling is accepted, because it is the live one', () => {
  const field = readProhibitedField({ prohibitedActivites: 'Automated scanning is prohibited.' });
  assert.equal(field.present, true);
  assert.match(field.value, /prohibited/);
});

test('both spellings are read, and the correct one wins when both are present', () => {
  assert.equal(readProhibitedField({ prohibitedActivities: 'x' }).value, 'x');
  assert.equal(readProhibitedField({ prohibited_activities: 'y' }).value, 'y');
  // An array of bullet points is joined into paragraphs, not dropped.
  const joined = readProhibitedField({ prohibitedActivities: ['No scanners.', 'No DoS.'] });
  assert.match(joined.value, /No scanners\.\nNo DoS\./);
  // An empty array is present-and-empty, i.e. null, not allowed.
  assert.equal(readProhibitedField({ prohibitedActivities: [] }).value, null);
});

// ── 2. scanners barred ──────────────────────────────────────────────────────

test('a programme whose terms bar scanners is prohibited, with the sentence quoted', () => {
  const v = classifyProhibitedActivities(
    'We welcome reports. Automated scanning is prohibited on all production hosts.',
  );
  assert.equal(v.automation_allowed, false);
  assert.equal(v.cls, 'prohibited');
  assert.equal(v.reason, 'scanners-barred');
  assert.match(v.evidence, /Automated scanning is prohibited/);
});

test('a range of real formulations all land on scanners-barred', () => {
  const samples = [
    'Please do not use automated tools against our infrastructure.',
    'No automated testing without a human in the loop.',
    'We do not permit automated scanning.',
    'Use of automated tools is prohibited.',
    'Scanners are not permitted on any asset.',
  ];
  for (const s of samples) {
    const v = classifyProhibitedActivities(s);
    assert.equal(v.cls, 'prohibited', `not prohibited: ${s}`);
    assert.equal(v.reason, 'scanners-barred', `wrong reason for: ${s}`);
  }
});

// ── 3. unattended output ineligible ─────────────────────────────────────────

test('a programme that makes unattended output ineligible refuses with its own reason', () => {
  // The paraphrase of a real term: a finding submitted without human
  // verification does not meet eligibility, and the submission fee is not
  // refunded. Not a ban on tools — a ban on the product of an unattended run.
  const v = classifyProhibitedActivities(
    'Rewards are paid on verified findings only. Any submission made without human verification does not meet eligibility and the submission fee is not refunded.',
  );
  assert.equal(v.automation_allowed, false);
  assert.equal(v.cls, 'prohibited');
  assert.equal(v.reason, 'unattended-ineligible');
  assert.match(v.evidence, /without human verification/);
});

test('unattended-ineligible is a DIFFERENT refusal from scanners-barred', () => {
  const unattended = classifyProhibitedActivities('A report generated by automated tooling must be verified by a human before submission.');
  const barred = classifyProhibitedActivities('No automated scanning.');
  assert.equal(unattended.reason, 'unattended-ineligible');
  assert.equal(barred.reason, 'scanners-barred');
  assert.notEqual(unattended.reason, barred.reason, 'the operator action differs, so the code must too');
});

// ── 4. consent required ─────────────────────────────────────────────────────

test('prior-written-consent terms are prohibited while no consent is on file', () => {
  const v = classifyProhibitedActivities(
    'You may test manually. Automated testing is only permitted with our prior written consent.',
  );
  assert.equal(v.automation_allowed, false);
  assert.equal(v.cls, 'prohibited');
  assert.equal(v.reason, 'consent-required');
});

// ── the overriding rule ────────────────────────────────────────────────────

test('prohibition beats permission in the same document', () => {
  const v = classifyProhibitedActivities(
    'Automated scanning is permitted across our public bug bounty scope. However, no automated testing of the admin panel is allowed under any circumstances.',
  );
  assert.equal(v.automation_allowed, false, 'a permission sentence must not outvote a prohibition sentence');
  assert.equal(v.cls, 'prohibited');
});

test('an affirmative permission is the only path to allowed', () => {
  const v = classifyProhibitedActivities('Automated scanning is permitted within the scope listed below.');
  assert.equal(v.automation_allowed, true);
  assert.equal(v.cls, 'allowed');
  assert.equal(v.reason, 'affirmative');
});

test('silence is not consent', () => {
  const v = classifyProhibitedActivities('Please report vulnerabilities to security@example.com. We aim to respond within 3 days.');
  assert.equal(v.automation_allowed, false);
  assert.equal(v.cls, 'not_mentioned');
});

test('"not prohibited" is the absence of a ban, not a grant', () => {
  // This is a live trap: the crawler's substring list contains
  // `automated scanning is not`, which matches this sentence and would classify
  // an unpoliced programme as prohibited. Here it must not become `allowed`
  // either — it says nothing about consent.
  const v = classifyProhibitedActivities('Automated scanning is not prohibited by this policy, though we prefer you ask first.');
  assert.equal(v.automation_allowed, false);
  assert.notEqual(v.cls, 'allowed');
});

// ── refuseDispatch ─────────────────────────────────────────────────────────

const prog = (automation) => ({ id: 'immunefi:acme', name: 'Acme', automation });

test('a programme whose terms bar scanners REFUSES dispatch and names the programme', () => {
  const automation = classifyProhibitedActivities('Automated scanning is prohibited.');
  const r = refuseDispatch(prog(automation));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'automation_prohibited');
  assert.match(r.message, /Acme/, 'the refusal must name the programme');
  assert.match(r.message, /immunefi:acme/, 'and its id');
  assert.match(r.message, /bar automated scanners/);
  assert.match(r.message, /Automated scanning is prohibited/, 'and quote the sentence it rests on');
});

test('a null-field programme refuses with the UNKNOWN code, not the prohibited one', () => {
  const r = refuseDispatch(prog(classifyProhibitedActivities(null)));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'automation_unknown');
  assert.match(r.message, /null prohibited-activities field/);
  assert.match(r.message, /silence is not consent/);
});

test('an unattended-ineligible programme refuses with a distinct message', () => {
  const automation = classifyProhibitedActivities('A finding submitted without human verification does not meet eligibility.');
  const r = refuseDispatch(prog(automation));
  assert.equal(r.ok, false);
  assert.match(r.message, /submitted without human verification ineligible/);
});

test('only an automation-allowed programme passes the gate', () => {
  const r = refuseDispatch(prog(classifyProhibitedActivities('Automated testing is permitted within scope.')));
  assert.deepEqual(r, { ok: true });
});

// ── platform parsers ───────────────────────────────────────────────────────

test('Cantina: a real-shaped competition parses, terms fall back to instructions, cap stays unmeasured', () => {
  // Shape taken from the live payload (HTTP 200, 771,327 B, 145 competitions).
  const body = [
    {
      id: 'e275368c-547d-4d91-a418-053ad31082a8',
      name: 'Revert v4lend Competition',
      url: 'https://cantina.xyz/competitions/e275368c-547d-4d91-a418-053ad31082a8',
      company: { id: 'x', name: 'Revert Finance', handle: 'revert-finance' },
      timeframe: { start: '2026-10-06T18:30:00Z', end: '2026-11-03T18:30:00Z' },
      status: 'live',
      currencyCode: 'USDC',
      totalRewardPot: '50000',
      instructions: 'See https://github.com/revert-finance/v4lend for the in-scope codebase.',
      kycRequired: true,
      allowedSeverities: ['high', 'medium'],
      kind: 'public_contest',
    },
  ];
  const p = parseCantina(body);
  assert.equal(p.records_seen, 1);
  assert.equal(p.malformed, 0);
  const g = p.programmes[0];
  assert.equal(g.id, 'cantina:revert-finance');
  assert.equal(g.kind, 'contest');
  // THE HONEST NULL: `totalRewardPot` is a pool, not a per-finding cap.
  assert.equal(g.payout_cap_usd, null);
  // No prohibited-activities field at this path, so the terms prose is scanned
  // and silence is not consent. `terms-silent` because there WAS text to read
  // that simply never mentions tools — a different fact from `field-absent`.
  assert.equal(g.automation.automation_allowed, false);
  assert.equal(g.automation.reason, 'terms-silent');
  assert.deepEqual(g.assets.map((a) => a.value), ['revert-finance/v4lend']);
  assert.equal(g.assets[0].kind, 'repo');
});

test('Cantina: an empty array and a malformed body are different facts', () => {
  assert.equal(parseCantina([]).malformed, 0);
  assert.equal(parseCantina([]).programmes.length, 0);
  assert.equal(parseCantina({ not: 'an array' }).malformed, 1);
});

test('Sherlock: the envelope-shaped payload parses and keeps pool != cap', () => {
  // Shape taken from the live payload (HTTP 200, 7,609 B for limit=2).
  const body = {
    page: 1,
    next_page: 2,
    items: [
      {
        id: 1140,
        title: 'Ethereum Fusaka Upgrade',
        prize_pool: 1984400,
        rewards: 2000000,
        judging_prize_pool: 0,
        token: 'USDC',
        status: 'FINISHED',
        private: false,
        type_label: 'Public Bug Bounty',
        short_description: 'The Ethereum Foundation is a non-profit. Code at https://github.com/ethereum/go-ethereum',
      },
    ],
    total: 1,
    has_next: false,
  };
  const p = parseSherlock(body);
  assert.equal(p.records_seen, 1);
  const g = p.programmes[0];
  assert.equal(g.id, 'sherlock:1140');
  assert.equal(g.kind, 'bounty');
  assert.equal(g.payout_cap_usd, null, 'rewards is the pool, not a per-finding cap');
  assert.equal(g.automation.automation_allowed, false);
  assert.deepEqual(g.assets.map((a) => a.value), ['ethereum/go-ethereum']);
});

test('Sherlock: a bare array is accepted, since the envelope is not guaranteed', () => {
  const p = parseSherlock([{ id: 7, title: 'Contest', type_label: 'Audit Contest' }]);
  assert.equal(p.programmes.length, 1);
  assert.equal(p.programmes[0].kind, 'contest');
});

test('Immunefi: a max-bounty field IS a per-finding cap, and a prohibited field gates it', () => {
  const body = {
    projects: [
      {
        id: 'acme',
        project: 'Acme Protocol',
        maxBounty: 250000,
        prohibitedActivites: null,
        assets: [
          { url: 'https://github.com/acme/core', type: 'github', chainId: null },
          { address: '0x1111111111111111111111111111111111111111', type: 'smart_contract', chainId: 1, eligibleForBounty: true },
          { type: 'smart_contract' },
        ],
      },
    ],
  };
  const p = parseImmunefi(body);
  const g = p.programmes[0];
  assert.equal(g.payout_cap_usd, 250000);
  assert.equal(g.automation.automation_allowed, false);
  assert.equal(g.automation.reason, 'field-null');
  assert.equal(g.assets.length, 2, 'the asset with no value is dropped, not invented');
  assert.equal(p.dropped_no_assets, 1);
  const contract = g.assets.find((a) => a.kind === 'chain_address');
  assert.equal(contract.chain_id, 1);
  // The chain id came from the platform's own field, not from the 0x shape.
  const repo = g.assets.find((a) => a.kind === 'repo');
  assert.equal(repo.chain_id, null);
});

test('Immunefi: an asset with no declared chain keeps chain_id null', () => {
  const p = parseImmunefi({
    projects: [{ id: 'x', project: 'X', assets: [{ address: '0x2222222222222222222222222222222222222222', type: 'smart_contract' }] }],
  });
  assert.equal(p.programmes[0].assets[0].chain_id, null, 'an address does not identify its chain');
});

test('Immunefi: a paused asset is recorded out of scope', () => {
  const p = parseImmunefi({
    projects: [{ id: 'x', project: 'X', assets: [{ url: 'https://x.example', type: 'website', isPaused: true }] }],
  });
  assert.equal(p.programmes[0].assets[0].in_scope, false);
});

test('HackenProof: string and object scope entries both normalise, and unverified shape is tolerated', () => {
  const p = parseHackenProof({
    programs: [
      {
        handle: 'acme',
        name: 'Acme',
        maxBounty: '10000',
        rules: 'Automated scanning is prohibited on all assets.',
        scope: ['api.acme.example', { target: '0x3333333333333333333333333333333333333333', type: 'smart_contract', chainId: 8453 }, { nope: 1 }],
      },
    ],
  });
  const g = p.programmes[0];
  assert.equal(g.payout_cap_usd, 10000);
  assert.equal(g.automation.reason, 'scanners-barred');
  assert.equal(g.assets.length, 2);
  assert.equal(p.dropped_no_assets, 1);
  assert.equal(g.assets[1].chain_id, 8453);
});

test('parseScope dispatches to the right platform and never returns allowed on a bad body', () => {
  for (const platform of ['immunefi', 'cantina', 'sherlock', 'hackenproof']) {
    const p = parseScope(platform, { unexpected: true });
    assert.equal(p.platform, platform);
    assert.equal(p.programmes.length, 0);
    assert.ok(p.malformed >= 1, `${platform} should report a shape it did not understand`);
  }
});

test('reposFromText dedupes and bounds', () => {
  const repos = reposFromText('https://github.com/a/b and github.com/A/B and github.com/c/d.git');
  assert.deepEqual(repos, ['a/b', 'c/d']);
  assert.deepEqual(reposFromText(null), []);
});
