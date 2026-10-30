// Scope-change monitor tests.
//
// This module decides whether an engagement may keep running after a programme
// edits its scope. The asymmetry is the whole design: a false pause costs an
// engagement, a false continue costs an out-of-scope test against a system
// nobody gave permission to test. So the tests are mostly about the paths that
// must NOT return `continue`:
//
//   - an uninterpretable diff                  → pause
//   - a stale snapshot                         → pause
//   - a future-dated snapshot                  → pause
//   - a snapshot for a different programme     → pause
//   - an asset the engagement depends on leaving scope → pause
//
// What this file does NOT prove: that the snapshots correspond to a real
// programme's live scope document. Fetching and parsing that document is the
// wiring this module deliberately does not do (no cron headroom, and
// `.github/workflows/**` is out of scope for this workstream).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decidePause,
  diffScope,
  snapshotForStorage,
  snapshotFromStorage,
} from '../build/scope-monitor.js';

const NOW = 1_793_000_000;
const FRESH = NOW - 3600;

/** A snapshot for one programme with the given assets. */
function snap(assets, over = {}) {
  return {
    program_id: 'acme-vault',
    fetched_at: FRESH,
    sha256: 'a'.repeat(64),
    parsed: true,
    assets,
    ...over,
  };
}

const A = { kind: 'host', value: 'app.acme.example' };
const B = { kind: 'chain_address', value: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
const C = { kind: 'url', value: 'https://app.acme.example/api' };

/** An open engagement authorized to test the given asset values. */
function eng(assets, over = {}) {
  return { id: 'eng_1', program_id: 'acme-vault', status: 'open', assets, ...over };
}

// ── 1. diff ────────────────────────────────────────────────────────────────

test('an identical asset set is reported identical', () => {
  const d = diffScope(snap([A, B]), snap([A, B]));
  assert.equal(d.identical, true);
  assert.deepEqual(d.appeared, []);
  assert.deepEqual(d.disappeared, []);
  assert.deepEqual(d.kind_changed, []);
  assert.equal(d.incomparable, null);
  // Same document digest, so nothing changed at all.
  assert.equal(d.document_changed, false);
});

test('a disappeared asset is reported, and is the one that matters', () => {
  const d = diffScope(snap([A, B]), snap([A]));
  assert.equal(d.identical, false);
  assert.deepEqual(d.disappeared.map((c) => c.asset.value), [B.value]);
  assert.deepEqual(d.appeared, []);
  assert.equal(d.disappeared[0].kind, 'disappeared');
});

test('an appeared asset is reported and does not affect a continue', () => {
  const d = diffScope(snap([A]), snap([A, C]));
  assert.deepEqual(d.appeared.map((c) => c.asset.value), [C.value]);
  assert.deepEqual(d.disappeared, []);
});

test('the same value under a different kind is a kind change, not a disappearance', () => {
  // host → url is a real scope edit but the asset is still named. Reporting it
  // as "disappeared" would pause a healthy engagement; reporting it as unchanged
  // would hide the edit. It is its own outcome.
  const d = diffScope(snap([A]), snap([{ kind: 'url', value: A.value }]));
  assert.deepEqual(d.disappeared, []);
  assert.equal(d.kind_changed.length, 1);
  assert.equal(d.kind_changed[0].was.kind, 'host');
  assert.equal(d.kind_changed[0].asset.kind, 'url');
  assert.equal(d.identical, false);
});

test('a value present under two kinds survives losing one of them', () => {
  const d = diffScope(
    snap([A, { kind: 'url', value: A.value }]),
    snap([{ kind: 'url', value: A.value }]),
  );
  // The host copy is gone, but the value is still in scope as a url, so this is
  // a kind change. Treating it as a loss would be a false pause.
  assert.deepEqual(d.disappeared, []);
  assert.equal(d.kind_changed.length, 1);
});

test('diff output is deterministically ordered', () => {
  const one = diffScope(snap([]), snap([C, A, B]));
  const two = diffScope(snap([]), snap([B, C, A]));
  assert.deepEqual(
    one.appeared.map((c) => c.asset.value),
    two.appeared.map((c) => c.asset.value),
  );
});

test('a document edit with an unchanged asset set is flagged separately', () => {
  const d = diffScope(snap([A], { sha256: 'a'.repeat(64) }), snap([A], { sha256: 'b'.repeat(64) }));
  assert.equal(d.identical, true);
  assert.equal(d.document_changed, true);
});

test('an incomparable diff names the reason instead of guessing', () => {
  const cases = [
    [snap([A], { program_id: '' }), snap([A]), /no program_id/],
    [snap([A]), snap([A], { program_id: 'other' }), /different programmes/],
    [snap([A], { parsed: false }), snap([A]), /not successfully parsed/],
    [null, snap([A]), /missing/],
  ];
  for (const [prev, cur, rx] of cases) {
    const d = diffScope(prev, cur);
    assert.equal(d.incomparable !== null, true, `should be incomparable: ${rx}`);
    assert.match(d.incomparable, rx);
    // And nothing is claimed about the assets.
    assert.deepEqual(d.disappeared, []);
  }
});

// ── 2. the pause decision ──────────────────────────────────────────────────

test('a clean, current, unchanged comparison continues', () => {
  const d = decidePause({ engagement: eng([A.value]), previous: snap([A, B]), current: snap([A, B]), now: NOW });
  assert.equal(d.verdict, 'continue');
  assert.deepEqual(d.pause_engagements, []);
  assert.deepEqual(d.lost_assets, []);
  assert.ok(d.reasons.length > 0, 'a decision always states its reason');
});

test('an asset the engagement depends on leaving scope PAUSES', () => {
  const d = decidePause({ engagement: eng([B.value]), previous: snap([A, B]), current: snap([A]), now: NOW });
  assert.equal(d.verdict, 'pause');
  assert.deepEqual(d.pause_engagements, ['eng_1']);
  assert.deepEqual(d.lost_assets.map((a) => a.value), [B.value]);
  assert.match(d.reasons[0], /left the programme's scope/);
});

test('an asset leaving scope that this engagement does not use does NOT pause it', () => {
  // B disappeared, but this engagement only tests A.
  const d = decidePause({ engagement: eng([A.value]), previous: snap([A, B]), current: snap([A]), now: NOW });
  assert.equal(d.verdict, 'continue');
  assert.match(d.reasons.join(' '), /no asset this engagement depends on disappeared/);
});

test('an engagement depending on several assets pauses if ANY disappears', () => {
  const d = decidePause({ engagement: eng([A.value, B.value]), previous: snap([A, B, C]), current: snap([A, C]), now: NOW });
  assert.equal(d.verdict, 'pause');
  assert.deepEqual(d.lost_assets.map((a) => a.value), [B.value]);
});

test('an uninterpretable diff PAUSES with lost_assets empty', () => {
  const d = decidePause({
    engagement: eng([A.value]),
    previous: snap([A], { parsed: false }),
    current: snap([A]),
    now: NOW,
  });
  assert.equal(d.verdict, 'pause');
  assert.deepEqual(d.lost_assets, []);
  assert.match(d.reasons.join(' '), /could not be compared/);
  assert.match(d.reasons.join(' '), /treated as a scope loss, not as a clean result/);
});

test('a stale snapshot PAUSES, because comparing stale data looks like a clean result', () => {
  // The specific failure: a cron that stopped produces a snapshot that never
  // updates. Diffing it against itself reports "identical" forever.
  const old = NOW - 30 * 24 * 60 * 60;
  const d = decidePause({
    engagement: eng([A.value]),
    previous: snap([A], { fetched_at: old }),
    current: snap([A], { fetched_at: old }),
    now: NOW,
  });
  assert.equal(d.verdict, 'pause');
  assert.match(d.reasons.join(' '), /old \(limit/);
});

test('the freshness window is configurable', () => {
  const twoHoursAgo = NOW - 7200;
  const base = {
    engagement: eng([A.value]),
    previous: snap([A], { fetched_at: twoHoursAgo }),
    current: snap([A], { fetched_at: twoHoursAgo }),
    now: NOW,
  };
  assert.equal(decidePause({ ...base, max_snapshot_age_seconds: 3600 }).verdict, 'pause');
  assert.equal(decidePause({ ...base, max_snapshot_age_seconds: 86400 }).verdict, 'continue');
});

test('a future-dated snapshot PAUSES rather than being trusted', () => {
  const d = decidePause({
    engagement: eng([A.value]),
    previous: snap([A], { fetched_at: NOW + 600 }),
    current: snap([A], { fetched_at: NOW + 600 }),
    now: NOW,
  });
  assert.equal(d.verdict, 'pause');
  assert.match(d.reasons.join(' '), /in the future/);
});

test('a snapshot for a different programme PAUSES, it does not silently continue', () => {
  const d = decidePause({
    engagement: eng([A.value]),
    previous: snap([A]),
    current: snap([A], { program_id: 'someone-else' }),
    now: NOW,
  });
  assert.equal(d.verdict, 'pause');
  assert.match(d.reasons.join(' '), /says nothing about it/);
});

test('no clock PAUSES, because freshness cannot be established', () => {
  const d = decidePause({
    engagement: eng([A.value]),
    previous: snap([A]),
    current: snap([A]),
    now: Number.NaN,
  });
  assert.equal(d.verdict, 'pause');
  assert.match(d.reasons.join(' '), /no clock/);
});

test('an engagement that is already paused or closed continues with no action', () => {
  for (const status of ['paused', 'closed', 'abandoned', 'draft']) {
    const d = decidePause({
      engagement: eng([A.value], { status }),
      previous: snap([A, B]),
      current: snap([A]),
      now: NOW,
    });
    assert.equal(d.verdict, 'continue', `${status} has nothing to pause`);
    assert.deepEqual(d.pause_engagements, []);
    // But the reason must not read as an endorsement of the scope.
    assert.match(d.reasons[0], /no pause action is required/);
  }
});

test('an engagement with no id PAUSES rather than reporting an unpauseable verdict', () => {
  const d = decidePause({
    engagement: { id: '', program_id: 'acme-vault', status: 'open', assets: [A.value] },
    previous: snap([A]),
    current: snap([A]),
    now: NOW,
  });
  assert.equal(d.verdict, 'pause');
  assert.match(d.reasons.join(' '), /no id/);
});

test('a kind change alone does NOT pause but is stated', () => {
  const d = decidePause({
    engagement: eng([A.value]),
    previous: snap([A]),
    current: snap([{ kind: 'url', value: A.value }]),
    now: NOW,
  });
  assert.equal(d.verdict, 'continue');
  assert.match(d.reasons.join(' '), /changed kind/);
});

test('a prose-only document edit on an unchanged asset set is surfaced for a human', () => {
  const d = decidePause({
    engagement: eng([A.value]),
    previous: snap([A], { sha256: 'a'.repeat(64) }),
    current: snap([A], { sha256: 'b'.repeat(64) }),
    now: NOW,
  });
  assert.equal(d.verdict, 'continue');
  assert.match(d.reasons.join(' '), /prose-only scope restriction is possible/);
});

test('every decision carries at least one reason', () => {
  const scenarios = [
    { engagement: eng([A.value]), previous: snap([A, B]), current: snap([A, B]) },
    { engagement: eng([B.value]), previous: snap([A, B]), current: snap([A]) },
    { engagement: eng([A.value]), previous: snap([A], { parsed: false }), current: snap([A]) },
    { engagement: eng([A.value], { status: 'paused' }), previous: snap([A]), current: snap([A]) },
  ];
  for (const s of scenarios) {
    const d = decidePause({ ...s, now: NOW });
    assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0);
    for (const r of d.reasons) assert.ok(typeof r === 'string' && r.length > 5);
  }
});

test('the decision is deterministic for the same inputs', () => {
  const args = () => ({
    engagement: eng([B.value]),
    previous: snap([A, B]),
    current: snap([A]),
    now: NOW,
  });
  assert.deepEqual(decidePause(args()), decidePause(args()));
});

// ── 3. storage round-trip ──────────────────────────────────────────────────

test('a snapshot survives a storage round-trip', () => {
  const s = snap([B, A], { parse_warnings: ['1 row had an unknown asset_type'] });
  const back = snapshotFromStorage(snapshotForStorage(s));
  assert.ok(back);
  assert.equal(back.program_id, s.program_id);
  assert.equal(back.fetched_at, s.fetched_at);
  assert.equal(back.sha256, s.sha256);
  assert.equal(back.parsed, true);
  // The stored form sorts by `kind` then `value`, so chain_address precedes host.
  assert.deepEqual(back.assets, [B, A]);
  assert.deepEqual(back.parse_warnings, s.parse_warnings);
});

test('the stored form is canonical, so two stores compare equal', () => {
  const one = snapshotForStorage(snap([B, A]));
  const two = snapshotForStorage(snap([A, B]));
  assert.equal(one, two);
});

test('a truncated or malformed stored snapshot is null, never a half-object', () => {
  // A half-populated `previous` snapshot would silently turn "unknown" into
  // "unchanged" on the next diff, which is the exact failure this must avoid.
  const bad = [
    '',
    'not json',
    '{}',
    '{"program_id":"p"}',
    '{"program_id":"p","fetched_at":"soon","sha256":"x","assets":[]}',
    '{"program_id":"p","fetched_at":1,"sha256":"x","assets":"nope"}',
    '{"program_id":"p","fetched_at":1,"sha256":"x","assets":[{"kind":"","value":"v"}]}',
    '{"program_id":"p","fetched_at":1,"sha256":"x","assets":[{"kind":"host"}]}',
  ];
  for (const text of bad) {
    assert.equal(snapshotFromStorage(text), null, `should not parse: ${text}`);
  }
});

test('a stored snapshot with parsed:false cannot be used to continue', () => {
  const stored = snapshotForStorage(snap([A], { parsed: false }));
  const back = snapshotFromStorage(stored);
  assert.ok(back);
  assert.equal(back.parsed, false);
  const d = decidePause({ engagement: eng([A.value]), previous: back, current: snap([A]), now: NOW });
  assert.equal(d.verdict, 'pause');
});
