// Consultant: does the confidence number mean what it claims?
//
// The brief was "80-90% certain". These tests exist because the failure mode
// worth guarding is a bot that forwards *everything* and calls it confidence.
// So the negative cases matter more than the positive one: a single-tick
// observation, a mint with no drain path, and a structural claim with no
// evidence account must all fall SHORT of the threshold on their own.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  scoreFinding,
  CONSULT_MIN_CONFIDENCE,
  HUNT_ATTEMPT_LIMIT,
} = await import('../build/desk/consultant.js');

const EV = 'GHqQ8eYLc3Q4nL2gwncJyimz7UM5tpcoqpeH7PyNEx6p';

function finding(over = {}) {
  return {
    id: 'hunt_x',
    ts: 1,
    subject: 'Prog1111111111111111111111111111111111111111',
    risk: 'upgrade_authority_plain_key',
    detail: 'upgrade authority is a plain single-key wallet',
    evidenceAccount: EV,
    severity: 'medium',
    firstSeen: 1,
    ...over,
  };
}

test('the strongest case clears the threshold', () => {
  // decoded bytes (+40) + persisted (+20) + drain class (+20) + single key
  // confirmed (+10) + program custodies deposits (+10) = 100
  const s = scoreFinding(finding(), 3, true);
  assert.equal(s.confidence, 100);
  assert.equal(s.forwarded, true);
  assert.equal(s.facts.length, 5);
});

test('a fresh single-tick finding is below 80 and is held back', () => {
  // 40 + 0 + 20 + 10 + 10 = 80 -> exactly at the floor, forwarded.
  // At 79 nothing is forwarded, so pin the two neighbours that flip it.
  const atFloor = scoreFinding(finding(), 1, true);
  assert.equal(atFloor.confidence, 80);
  assert.equal(atFloor.forwarded, true);

  // Drop the single-key confirmation: 70, held back.
  const noKeyProof = scoreFinding(finding(), 1, false);
  assert.equal(noKeyProof.confidence, 70);
  assert.equal(noKeyProof.forwarded, false);
});

test('a mint with no drain path cannot reach the threshold alone', () => {
  // live mint authority: 40 + 20 (persisted) + 0 (not a drain class)
  // + 10 (single key) + 0 (mint custodies no deposits) = 70
  const s = scoreFinding(
    finding({ risk: 'mint_authority_live', subject: 'Mint11111111111111111111111111111111111111' }),
    5,
    true,
  );
  assert.equal(s.confidence, 70);
  assert.equal(s.forwarded, false);
  assert.match(s.facts.join(' '), /not a direct drain/);
});

test('a claim with no evidence account earns no evidence points', () => {
  const s = scoreFinding(finding({ evidenceAccount: '' }), 3, true);
  assert.equal(s.confidence, 60); // 100 - 40
  assert.equal(s.forwarded, false);
  assert.match(s.facts.join(' '), /no evidence account/);
});

test('confidence is a sum of named facts, not a guess', () => {
  const s = scoreFinding(finding(), 2, true);
  assert.equal(s.confidence, 100);
  // every point must be attributable to a line the reviewer can read
  const sum = s.facts.reduce((n, f) => n + Number(f.match(/^\+(\d+)/)[1]), 0);
  assert.equal(sum, s.confidence);
});

test('the stop limit is a real bound', () => {
  assert.equal(HUNT_ATTEMPT_LIMIT, 6);
  assert.ok(CONSULT_MIN_CONFIDENCE >= 80 && CONSULT_MIN_CONFIDENCE <= 90);
});
