// Ledger export tests.
//
// The export is the document that makes a report checkable: it carries the
// hash-chained trail so a triager can confirm what was authorized before what
// was measured. Two properties matter and nothing else does:
//
//   1. DETERMINISM. Two exports of the same engagement must be byte-identical,
//      or a digest comparison between two holders of the file is meaningless.
//      The chain itself already canonicalises keys; the export follows.
//   2. HONESTY ABOUT INTEGRITY. A broken chain still exports — hiding it would
//      defeat the purpose — but `integrity.ok` is false and the reason is named.
//      An "integrity: ok" that was never computed would be worse than no field.
//
// The chain built here is real: entries are hashed with the same
// `stableStringify` and the same formula ledger.ts uses, so `verifyChain` is
// exercised against genuine input rather than a fixture that assumes its own
// answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  exportEngagement,
  ledgerForEngagement,
  parseJsonColumn,
  prettyJson,
  verifyChain,
} from '../build/ledger-export.js';
import { stableStringify, GENESIS } from '../build/ledger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'report');
const fx = JSON.parse(readFileSync(join(FIX, 'ledger.json'), 'utf8'));

/** The sha256 the chain uses. Node's crypto here; WebCrypto in the Worker. */
const sha256Hex = async (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Build a genuine hash-chained ledger.
 *
 * Mirrors `append()` in ledger.ts: hash = sha256(prev + stableStringify({seq,ts,kind,payload})).
 * If this formula drifts from ledger.ts, `verifyChain` fails — which is the
 * point: the export verifies the same thing the runtime writes.
 */
async function buildChain(entries) {
  const rows = [];
  let prev = GENESIS;
  let seq = 1;
  for (const e of entries) {
    const ts = e.ts ?? 1793000000 + seq;
    const body = stableStringify({ seq, ts, kind: e.kind, payload: e.payload });
    const hash = await sha256Hex(prev + body);
    rows.push({ seq, ts, kind: e.kind, payload: stableStringify(e.payload), prev_hash: prev, hash });
    prev = hash;
    seq += 1;
  }
  return rows;
}

const ENG = fx.engagement;
const ENTRIES = [
  { kind: 'intake.compiled', payload: { engagement: ENG.id, outcome: 'compiled' } },
  { kind: 'approval.approved', payload: { id: 'appr_5d1c', engagement: ENG.id } },
  { kind: 'dispatch.sent', payload: { hunt: 'hunt_7c41e0b9', engagement: ENG.id, repo: 'https://github.com/acme/vault' } },
  { kind: 'proof.verdict', payload: { hunt: 'hunt_7c41e0b9', test: 'test_reentrancy_118', verdict: 'proven' } },
  { kind: 'actions.deploy', payload: { unrelated: true } },
];

async function baseInput(over = {}) {
  const ledger = await buildChain(ENTRIES);
  return {
    engagement: ENG,
    ledger,
    hunts: [
      {
        id: 'hunt_7c41e0b9',
        program_id: 'acme-vault',
        engagement_id: ENG.id,
        repo: 'https://github.com/acme/vault',
        commit_sha: '9f2c1ab4d6e8570c3b1e9a4d5f60718293a4b5c6',
        contract: 'Vault',
        fork_block: 18765432,
        stage: 'done',
        leads_n: 1,
        attempts_n: 1,
        proven_n: 1,
        stopped_because: null,
        created_at: 1793001000,
        updated_at: 1793003000,
      },
    ],
    approvals: fx.approvals,
    proofs: fx.proofs,
    findings: [],
    ...over,
  };
}

// ── 1. the document ────────────────────────────────────────────────────────

test('the export carries the engagement, its counts, and a named format', async () => {
  const r = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(r.ok, true);
  const d = r.document;
  assert.equal(d.format, 'asterion.engagement-export');
  assert.equal(d.version, 2);
  assert.equal(d.engagement.id, ENG.id);
  assert.equal(d.engagement.program_id, 'acme-vault');
  assert.equal(d.engagement.authorization_ref, ENG.authorization_ref);
  assert.equal(d.counts.ledger, 5);
  assert.equal(d.counts.hunts, 1);
  assert.equal(d.counts.approvals, 1);
  assert.equal(d.counts.proofs, 1);
  assert.deepEqual(d.counts.proofs_by_verdict, { proven: 1 });
  assert.deepEqual(d.counts.approvals_by_status, { approved: 1 });
});

test('the brief is parsed, not passed through as an opaque string', async () => {
  const r = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(r.ok, true);
  const brief = r.document.engagement.brief;
  assert.equal(typeof brief, 'object');
  assert.equal(brief.program_id, 'acme-vault');
  assert.equal(brief.max_mutability, 'simulate');
});

test('an unreadable brief is reported, not silently nulled', async () => {
  const r = await exportEngagement(
    await baseInput({ engagement: { ...ENG, brief: '{not json' } }),
    sha256Hex,
  );
  assert.equal(r.ok, true);
  assert.equal(r.document.engagement.brief, null);
  assert.ok(r.document.engagement.brief_error, 'the parse failure must be visible');
});

test('JSON columns in approvals and proofs are parsed', async () => {
  const r = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(r.ok, true);
  assert.deepEqual(r.document.approvals[0].action, {
    kind: 'engagement',
    brief: { program_id: 'acme-vault', cls: 'solidity' },
  });
  assert.deepEqual(r.document.proofs[0].reasons, [
    'the PoC test fails on the pinned commit with a real assertion',
    'removing the precondition makes the test pass, confirming the mechanism',
  ]);
});

test('an unreadable reasons column is reported beside the field', async () => {
  const proofs = [{ ...fx.proofs[0], reasons: ']]]' }];
  const r = await exportEngagement(await baseInput({ proofs }), sha256Hex);
  assert.equal(r.ok, true);
  assert.equal(r.document.proofs[0].reasons, null);
  assert.ok(r.document.proofs[0].reasons_error);
});

// ── 2. determinism ─────────────────────────────────────────────────────────

test('two exports of the same engagement are byte-identical', async () => {
  const a = await exportEngagement(await baseInput(), sha256Hex);
  const b = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.json, b.json);
  // And the digest matches, which is the property a third party actually uses.
  assert.equal(await sha256Hex(a.json), await sha256Hex(b.json));
});

test('key order in the input does not change the output', async () => {
  // Two callers assembling the same engagement from different code paths will
  // build the object literal in different orders. The export must not notice.
  const ledger = await buildChain(ENTRIES);
  const reordered = Object.fromEntries(Object.entries(ENG).reverse());
  const a = await exportEngagement({ engagement: ENG, ledger }, sha256Hex);
  const b = await exportEngagement({ engagement: reordered, ledger }, sha256Hex);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.json, b.json);
});

test('keys are sorted at every level, not only the top', async () => {
  const r = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(r.ok, true);
  // The canonical form is single-line with sorted keys and no spaces.
  assert.ok(!r.json.includes('\n  '), 'canonical form must not be indented');
  assert.ok(r.json.includes('"counts":{'), 'nested objects must be compact and sorted');
  // A verifier recomputing the digest needs exactly this text.
  assert.equal(r.json, stableStringify(r.document) + '\n');
});

test('omitting exported_at keeps the export reproducible; supplying it is recorded', async () => {
  const a = await exportEngagement(await baseInput(), sha256Hex);
  const b = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(a.ok && b.ok, true);
  assert.equal('exported_at' in a.document, false, 'no clock is consulted by default');
  assert.equal(a.json, b.json);

  const stamped = await exportEngagement(await baseInput({ exported_at: 1793100000 }), sha256Hex);
  assert.equal(stamped.ok, true);
  assert.equal(stamped.document.exported_at, 1793100000);
  assert.notEqual(stamped.json, a.json, 'a stamped export must differ from an unstamped one');
});

test('ledger entries are ordered by seq regardless of input order', async () => {
  const input = await baseInput();
  const shuffled = [...input.ledger].reverse();
  const r = await exportEngagement({ ...input, ledger: shuffled }, sha256Hex);
  assert.equal(r.ok, true);
  assert.deepEqual(r.document.ledger.map((e) => e.seq), [1, 2, 3, 4, 5]);
});

test('array order is preserved where order is data', async () => {
  // The chain is ordered by seq, but the payload of an entry is ordered data.
  const ledger = await buildChain([
    { kind: 'dispatch.sent', payload: { steps: ['third', 'first', 'second'] } },
  ]);
  const r = await exportEngagement({ engagement: ENG, ledger }, sha256Hex);
  assert.equal(r.ok, true);
  assert.deepEqual(r.document.ledger[0].payload, { steps: ['third', 'first', 'second'] });
});

test('prettyJson is a second form of the same document, not a different one', async () => {
  const r = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(r.ok, true);
  const pretty = prettyJson(r.document);
  assert.deepEqual(JSON.parse(pretty), JSON.parse(r.json));
  assert.ok(pretty.includes('\n  '), 'the pretty form is indented');
});

// ── 3. integrity is computed, not assumed ─────────────────────────────────

test('an intact chain verifies, and the head hash is reported', async () => {
  const input = await baseInput();
  const r = await exportEngagement(input, sha256Hex);
  assert.equal(r.ok, true);
  assert.equal(r.document.integrity.ok, true);
  assert.equal(r.document.integrity.entries, 5);
  assert.equal(r.document.integrity.genesis, GENESIS);
  assert.equal(r.document.integrity.head_hash, input.ledger[4].hash);
  assert.match(r.document.integrity.detail, /intact \(5 entries\)/);
});

test('a tampered payload fails verification, and the export still happens', async () => {
  const input = await baseInput();
  input.ledger[2].payload = stableStringify({ hunt: 'hunt_7c41e0b9', engagement: ENG.id, repo: 'https://github.com/evil/repo' });
  const r = await exportEngagement(input, sha256Hex);
  assert.equal(r.ok, true, 'a broken chain must still export: hiding it defeats the purpose');
  assert.equal(r.document.integrity.ok, false);
  assert.match(r.document.integrity.detail, /hash mismatch at seq 3/);
});

test('a removed entry fails verification as a sequence gap', async () => {
  const input = await baseInput();
  input.ledger.splice(2, 1);
  const r = await exportEngagement(input, sha256Hex);
  assert.equal(r.ok, true);
  assert.equal(r.document.integrity.ok, false);
  assert.match(r.document.integrity.detail, /sequence gap: expected 3, found 4/);
});

test('a relinked entry fails as a broken link', async () => {
  const input = await baseInput();
  input.ledger[3].prev_hash = 'f'.repeat(64);
  const r = await exportEngagement(input, sha256Hex);
  assert.equal(r.ok, true);
  assert.equal(r.document.integrity.ok, false);
  assert.match(r.document.integrity.detail, /broken link at seq 4/);
});

test('verifyChain is exported and works standalone', async () => {
  const ledger = await buildChain(ENTRIES);
  assert.deepEqual(await verifyChain(ledger, sha256Hex), { ok: true, detail: 'intact (5 entries)' });
  assert.deepEqual(await verifyChain([], sha256Hex), { ok: true, detail: 'intact (0 entries)' });
});

test('the export states how a verifier should recompute the chain', async () => {
  const r = await exportEngagement(await baseInput(), sha256Hex);
  assert.equal(r.ok, true);
  assert.match(r.document.verify_hint, /sha256\(prev_hash \+ stableStringify/);
  assert.match(r.document.verify_hint, /keys sorted and no spaces/);
});

// ── 4. refusal ─────────────────────────────────────────────────────────────

test('no engagement or no ledger is refused by name', async () => {
  const a = await exportEngagement(/** @type {any} */ ({ ledger: [] }), sha256Hex);
  assert.equal(a.ok, false);
  if (!a.ok) assert.deepEqual(a.missing, ['engagement']);

  const b = await exportEngagement(/** @type {any} */ ({ engagement: ENG }), sha256Hex);
  assert.equal(b.ok, false);
  if (!b.ok) assert.deepEqual(b.missing, ['ledger']);
});

test('an incomplete engagement row is refused', async () => {
  const r = await exportEngagement(
    await baseInput({ engagement: { ...ENG, id: '', program_id: '' } }),
    sha256Hex,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing, ['engagement.id', 'engagement.program_id']);
});

test('a missing hash function is refused rather than reporting unverified integrity', async () => {
  const r = await exportEngagement(await baseInput(), /** @type {any} */ (null));
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing, ['sha256Hex']);
});

test('an empty ledger is a legitimate export, not a refusal', async () => {
  const r = await exportEngagement({ engagement: ENG, ledger: [] }, sha256Hex);
  assert.equal(r.ok, true);
  assert.equal(r.document.integrity.ok, true);
  assert.equal(r.document.integrity.head_hash, null);
  assert.equal(r.document.counts.ledger, 0);
});

// ── 5. engagement selection ───────────────────────────────────────────────

test('ledgerForEngagement selects by payload value, at any depth', async () => {
  const ledger = await buildChain(ENTRIES);
  const mine = ledgerForEngagement(ledger, ENG.id, ['hunt_7c41e0b9']);
  // Entry 1,2,3,4 mention the engagement or the hunt; entry 5 does not.
  assert.deepEqual(mine.map((r) => r.seq), [1, 2, 3, 4]);
});

test('selection is conservative with an unparsable payload', async () => {
  // A payload we cannot parse can still be attributed by substring, which can
  // only ever include MORE entries in the trail. Excluding it could hide an
  // action, which is the worse failure.
  const ledger = [
    { seq: 1, ts: 1, kind: 'x', payload: `{"broken": "${ENG.id}"`, prev_hash: GENESIS, hash: 'h' },
    { seq: 2, ts: 2, kind: 'y', payload: '{"other":true}', prev_hash: 'h', hash: 'h2' },
  ];
  assert.deepEqual(ledgerForEngagement(ledger, ENG.id).map((r) => r.seq), [1]);
});

test('selection with no engagement id returns nothing rather than everything', () => {
  const ledger = [{ seq: 1, ts: 1, kind: 'x', payload: '{}', prev_hash: GENESIS, hash: 'h' }];
  assert.deepEqual(ledgerForEngagement(ledger, ''), []);
});

// ── 6. parseJsonColumn ─────────────────────────────────────────────────────

test('parseJsonColumn distinguishes absent from malformed', () => {
  assert.deepEqual(parseJsonColumn(null), { ok: true, value: null });
  assert.deepEqual(parseJsonColumn(''), { ok: true, value: null });
  assert.deepEqual(parseJsonColumn('{"a":1}'), { ok: true, value: { a: 1 } });
  const bad = parseJsonColumn('{');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.error.length > 0);
});
