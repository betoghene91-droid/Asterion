// Interlock tests for the live-write relay. No network: every RPC and signer is
// a fake, so a passing test means the ladder refused/allowed on its own logic.
//
//   node --test tests/send.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SendRelay,
  sendTransaction,
  redact,
  toHexQty,
  normData,
  attemptFingerprint,
  DEFAULT_ALLOWED_CHAINS,
  MAINNET_CHAINS,
  PRIVATE_KEY_ENV,
  MAX_DATA_BYTES,
} from '../build/send.js';
import { roeFromBrief, grantIsUsable, PolicyEngine } from '../build/policy.js';

const NOW = 1_800_000_000; // fixed clock for every test
const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;

const OPERATOR_ADDR = '0x1111111111111111111111111111111111111111';
const TO_ADDR = '0x2222222222222222222222222222222222222222';
const FAKE_KEY = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// ── fixtures ────────────────────────────────────────────────────────────────

function grant(over = {}) {
  return {
    approved: true,
    operator: 'jennifer',
    chain_id: BASE_SEPOLIA,
    max_value_wei: 10_000_000_000_000_000n, // 0.01 ETH
    expires_at: NOW + 600,
    ...over,
  };
}

function tx(over = {}) {
  return {
    to: TO_ADDR,
    data: '0x',
    value: 0n,
    ...over,
  };
}

/** Records every call so tests can assert what did NOT happen. */
function fakeRpc(over = {}) {
  const calls = {
    estimateGas: 0,
    call: 0,
    getNonce: 0,
    sendRawTransaction: 0,
    getReceipt: 0,
    sentRaw: [],
    signedTx: [],
  };
  const rpc = {
    calls,
    async estimateGas() {
      calls.estimateGas += 1;
      return 21_000n;
    },
    async call() {
      calls.call += 1;
      return '0x';
    },
    async getNonce() {
      calls.getNonce += 1;
      return 7;
    },
    async gasPrice() {
      return 1_000_000_000n;
    },
    async sendRawTransaction(raw) {
      calls.sendRawTransaction += 1;
      calls.sentRaw.push(raw);
      return '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
    },
    async getReceipt() {
      calls.getReceipt += 1;
      return { status: 1, gasUsed: 21_000n, blockNumber: 12345 };
    },
    ...over,
  };
  return rpc;
}

function fakeSigner(over = {}) {
  const seen = [];
  const signer = {
    seen,
    address: OPERATOR_ADDR,
    async signTransaction(t) {
      seen.push(t);
      return '0xf86c808504a817c800825208';
    },
    ...over,
  };
  return signer;
}

function proven() {
  return { verdict: 'proven' };
}

/** Convenience: a request that would broadcast if the ladder lets it. */
function broadcastReq(over = {}) {
  return {
    verdict: proven(),
    tx: tx(),
    grant: grant(),
    signer: fakeSigner(),
    rpc: fakeRpc(),
    dry_run: false,
    now: NOW,
    ...over,
  };
}

// ── 1. grant / authorization ────────────────────────────────────────────────

test('refused when no grant', async () => {
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const res = await new SendRelay().send({
    verdict: proven(),
    tx: tx(),
    // grant deliberately omitted
    signer,
    rpc,
    dry_run: false,
    now: NOW,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_grant');
  assert.equal(res.broadcast, false);
  // nothing touched the wire or the signer
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.equal(signer.seen.length, 0);
});

test('refused when grant is null', async () => {
  const res = await new SendRelay().send(broadcastReq({ grant: null }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_grant');
});

test('refused when grant lacks approved:true', async () => {
  const res = await new SendRelay().send(broadcastReq({ grant: grant({ approved: false }) }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_not_approved');
  assert.equal(res.broadcast, false);
});

test('refused when approved is truthy but not literally true', async () => {
  // A JSON round-trip that produced the string "true" must not pass.
  const res = await new SendRelay().send(broadcastReq({ grant: grant({ approved: 'true' }) }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_not_approved');
});

test('refused when operator is empty', async () => {
  const res = await new SendRelay().send(broadcastReq({ grant: grant({ operator: '   ' }) }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_invalid');
  assert.match(res.reason, /operator/);
});

test('refused when max_value_wei is a number, not a bigint', async () => {
  // Wei values exceed Number.MAX_SAFE_INTEGER; a number here means someone did
  // float math on money, so we refuse rather than coerce.
  const res = await new SendRelay().send(
    broadcastReq({ grant: grant({ max_value_wei: 10_000_000_000_000_000 }) }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_invalid');
  assert.match(res.reason, /bigint/);
});

// ── 2. verdict gating ───────────────────────────────────────────────────────

for (const v of ['partial', 'inconclusive', 'disproved', 'proven ']) {
  test(`refused when verdict is '${v}'`, async () => {
    const rpc = fakeRpc();
    const signer = fakeSigner();
    const res = await new SendRelay().send(
      broadcastReq({ verdict: { verdict: v }, rpc, signer }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'verdict_not_proven');
    assert.equal(rpc.calls.sendRawTransaction, 0);
    assert.equal(signer.seen.length, 0);
  });
}

test('refused when verdict object is missing', async () => {
  const res = await new SendRelay().send(broadcastReq({ verdict: undefined }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'verdict_not_proven');
});

// ── 3. dry run is the default ───────────────────────────────────────────────

test('proven + dry_run omitted => simulation only, never broadcasts', async () => {
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const relay = new SendRelay();
  const res = await relay.send({
    verdict: proven(),
    tx: tx({ data: '0xabcdef', value: 0n }),
    grant: grant(),
    signer,
    rpc,
    // dry_run deliberately omitted
    now: NOW,
  });

  assert.equal(res.ok, true);
  assert.equal(res.broadcast, false);
  assert.equal(res.code, 'dry_run_ok');
  assert.equal(res.tx_hash, null);
  assert.equal(res.status, null);

  // everything except the broadcast happened
  assert.equal(rpc.calls.getNonce, 1);
  assert.equal(rpc.calls.estimateGas, 1);
  assert.equal(rpc.calls.call, 1);
  assert.equal(res.gas_estimate, '0x5208');

  // and the wire was never touched
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.equal(signer.seen.length, 0, 'dry run must not ask the signer to sign');

  // a dry run must not poison the sent-set
  assert.equal(res.attempt_key.length, 32);
  assert.equal(relay.hasSent(res.attempt_key), false);
});

test('dry_run:true is also a dry run', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(broadcastReq({ dry_run: true, rpc }));
  assert.equal(res.ok, true);
  assert.equal(res.broadcast, false);
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('dry_run:false is the only way to broadcast', async () => {
  for (const notFalse of [undefined, true, 0, '', 'false', null]) {
    const rpc = fakeRpc();
    const res = await new SendRelay().send(broadcastReq({ dry_run: notFalse, rpc }));
    assert.equal(res.broadcast, false, `dry_run=${JSON.stringify(notFalse)} must not broadcast`);
    assert.equal(rpc.calls.sendRawTransaction, 0);
  }
});

// ── 4. chain allowlist + mainnet double switch ──────────────────────────────

test('testnet is allowed on the default allowlist', async () => {
  assert.ok(DEFAULT_ALLOWED_CHAINS.includes(BASE_SEPOLIA));
  const res = await new SendRelay().send(broadcastReq());
  assert.equal(res.ok, true);
  assert.equal(res.broadcast, true);
  assert.equal(res.chain_id, BASE_SEPOLIA);
});

test('an unknown chain is refused outright', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(
    broadcastReq({ grant: grant({ chain_id: 999999 }), tx: tx({ chain_id: 999999 }), rpc }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'chain_not_allowed');
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('tx.chain_id disagreeing with the grant is refused', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(
    broadcastReq({ tx: tx({ chain_id: BASE_MAINNET }), rpc }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_chain_mismatch');
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('mainnet rejected when NEITHER flag is set', async () => {
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const res = await new SendRelay().send(
    broadcastReq({
      grant: grant({ chain_id: BASE_MAINNET }),
      tx: tx({ chain_id: BASE_MAINNET }),
      rpc,
      signer,
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'mainnet_needs_double_confirm');
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.equal(signer.seen.length, 0);
});

test('mainnet rejected with grant.allow_mainnet only', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(
    broadcastReq({
      grant: grant({ chain_id: BASE_MAINNET, allow_mainnet: true }),
      tx: tx({ chain_id: BASE_MAINNET }),
      rpc,
      // confirm_mainnet omitted
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'mainnet_needs_double_confirm');
  assert.match(res.reason, /allow_mainnet=true, confirm_mainnet=false/);
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('mainnet rejected with confirm_mainnet only', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(
    broadcastReq({
      grant: grant({ chain_id: BASE_MAINNET }), // no allow_mainnet
      tx: tx({ chain_id: BASE_MAINNET }),
      rpc,
      confirm_mainnet: true,
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'mainnet_needs_double_confirm');
  assert.match(res.reason, /allow_mainnet=false, confirm_mainnet=true/);
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('mainnet accepted with BOTH flags (and the signer is actually asked)', async () => {
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const res = await new SendRelay().send(
    broadcastReq({
      grant: grant({ chain_id: BASE_MAINNET, allow_mainnet: true }),
      tx: tx({ chain_id: BASE_MAINNET }),
      rpc,
      signer,
      confirm_mainnet: true,
    }),
  );

  assert.equal(res.ok, true);
  assert.equal(res.broadcast, true);
  assert.equal(res.chain_id, BASE_MAINNET);

  assert.equal(signer.seen.length, 1, 'signer must be asked to sign');
  // the signer received the mainnet chain id, not the testnet one
  assert.equal(signer.seen[0].chainId, '0x' + BASE_MAINNET.toString(16));
  assert.equal(signer.seen[0].to, TO_ADDR);
  assert.equal(rpc.calls.sendRawTransaction, 1);
  assert.ok(MAINNET_CHAINS.includes(BASE_MAINNET));
});

// ── 5. value cap ────────────────────────────────────────────────────────────

test('rejected when tx.value exceeds the cap', async () => {
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const res = await new SendRelay().send(
    broadcastReq({
      tx: tx({ value: 10_000_000_000_000_001n }), // one wei over
      rpc,
      signer,
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'value_over_cap');
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.equal(signer.seen.length, 0);
});

test('accepted exactly at the cap (boundary is inclusive)', async () => {
  const res = await new SendRelay().send(
    broadcastReq({ tx: tx({ value: 10_000_000_000_000_000n }) }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.broadcast, true);
});

test('rejected for a negative value', async () => {
  const res = await new SendRelay().send(broadcastReq({ tx: tx({ value: -1n }) }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'value_negative');
});

// ── 6. expiry ───────────────────────────────────────────────────────────────

test('rejected after expiry', async () => {
  const res = await new SendRelay().send(broadcastReq({ now: NOW + 601 }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_expired');
  assert.equal(res.broadcast, false);
});

test('accepted exactly at expires_at', async () => {
  const res = await new SendRelay().send(broadcastReq({ now: NOW + 600 }));
  assert.equal(res.ok, true);
});

// ── 7. key handling ─────────────────────────────────────────────────────────

test('private key never appears in a result object or an error message', async () => {
  // Path A: a signer that throws and echoes the key in its message.
  const leakySigner = {
    address: OPERATOR_ADDR,
    async signTransaction() {
      throw new Error(`boom while signing with key ${FAKE_KEY}`);
    },
  };
  const resA = await new SendRelay().send(
    broadcastReq({ signer: leakySigner, env: { [PRIVATE_KEY_ENV]: FAKE_KEY } }),
  );
  assert.equal(resA.ok, false);
  const blobA = JSON.stringify(resA);
  assert.ok(!blobA.includes(FAKE_KEY), 'key leaked into refusal result');
  assert.ok(!blobA.includes(FAKE_KEY.slice(2)), 'key body leaked into refusal result');
  assert.match(resA.reason, /\[REDACTED\]/);

  // Path B: an RPC that echoes the raw signed tx (which may embed the key's
  // signature) — we never return raw signed bytes, and we still scrub.
  const resB = await new SendRelay().send(
    broadcastReq({ env: { [PRIVATE_KEY_ENV]: FAKE_KEY } }),
  );
  assert.equal(resB.ok, true);
  const blobB = JSON.stringify(resB);
  assert.ok(!blobB.includes(FAKE_KEY));
  assert.ok(!blobB.includes(FAKE_KEY.slice(2)));
  // the receipt is bounded: no raw signed transaction field at all
  assert.equal(resB.raw, undefined);
  assert.equal(resB.raw_signed, undefined);
  assert.equal(resB.signed_tx, undefined);
  // No field may carry key material or raw signed bytes. (`attempt_key` is a
  // 32-hex fingerprint, so it is checked as a shape, not excluded by name.)
  assert.deepEqual(
    Object.keys(resB).filter((k) => /raw|signed|privkey|private|secret/i.test(k)),
    [],
    'no field name may suggest raw signed bytes or key material',
  );
  assert.match(resB.attempt_key, /^[0-9a-f]{32}$/);
});

test('redact() scrubs both the 0x form and the bare body', () => {
  const text = `key=${FAKE_KEY} bare=${FAKE_KEY.slice(2)}`;
  const out = redact(text, [FAKE_KEY]);
  assert.ok(!out.includes(FAKE_KEY));
  assert.ok(!out.includes(FAKE_KEY.slice(2)));
  assert.match(out, /\[REDACTED\]/);
});

test('no signer + no env key => typed refusal naming the env var', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(
    broadcastReq({ signer: null, rpc, env: {} }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_private_key');
  assert.match(res.reason, new RegExp(PRIVATE_KEY_ENV));
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('env key present but no signer => refuses, does not pretend to sign', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(
    broadcastReq({ signer: null, rpc, env: { [PRIVATE_KEY_ENV]: FAKE_KEY } }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_signer');
  assert.match(res.reason, /Inject/);
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.ok(!JSON.stringify(res).includes(FAKE_KEY));
});

test('no env reference at all does not crash', async () => {
  const res = await new SendRelay().send(broadcastReq({ signer: null, env: undefined }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_private_key');
});

test('signer returning non-hex is refused and does not hit the wire', async () => {
  const rpc = fakeRpc();
  const badSigner = {
    address: OPERATOR_ADDR,
    async signTransaction() {
      return 'not-hex';
    },
  };
  const res = await new SendRelay().send(broadcastReq({ signer: badSigner, rpc }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_signer');
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('no rpc => typed refusal', async () => {
  const res = await new SendRelay().send(broadcastReq({ rpc: null }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_rpc');
});

// ── 8. idempotency ──────────────────────────────────────────────────────────

test('double-send of the same fingerprint is prevented', async () => {
  const rpc = fakeRpc();
  const signer = fakeSigner();
  const relay = new SendRelay();

  const first = await relay.send(broadcastReq({ rpc, signer }));
  assert.equal(first.ok, true);
  assert.equal(first.broadcast, true);

  const second = await relay.send(broadcastReq({ rpc, signer }));
  assert.equal(second.ok, false);
  assert.equal(second.code, 'duplicate_send');
  assert.equal(second.broadcast, false);

  // exactly one submission reached the chain
  assert.equal(rpc.calls.sendRawTransaction, 1);
  assert.equal(signer.seen.length, 1);
  assert.ok(relay.hasSent(first.attempt_key));
});

test('a retry after a failed broadcast is also blocked', async () => {
  // Once a signed payload may have reached the network, retrying is unsafe.
  const failingRpc = fakeRpc({
    async sendRawTransaction() {
      throw new Error('connection reset mid-send');
    },
  });
  const relay = new SendRelay();
  const first = await relay.send(broadcastReq({ rpc: failingRpc }));
  assert.equal(first.ok, false);
  assert.equal(first.code, 'rpc_error');

  const rpc = fakeRpc();
  const second = await relay.send(broadcastReq({ rpc }));
  assert.equal(second.code, 'duplicate_send');
  assert.equal(rpc.calls.sendRawTransaction, 0);
});

test('concurrent identical sends: only one reaches the wire', async () => {
  const rpc = fakeRpc();
  const relay = new SendRelay();
  const results = await Promise.all([
    relay.send(broadcastReq({ rpc })),
    relay.send(broadcastReq({ rpc })),
  ]);
  assert.equal(rpc.calls.sendRawTransaction, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.code === 'duplicate_send').length, 1);
});

test('different value => different attempt key => both allowed', async () => {
  const rpc = fakeRpc();
  const relay = new SendRelay();
  const a = await relay.send(broadcastReq({ rpc, tx: tx({ value: 1n }) }));
  const b = await relay.send(broadcastReq({ rpc, tx: tx({ value: 2n }) }));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.attempt_key, b.attempt_key);
  assert.equal(rpc.calls.sendRawTransaction, 2);
});

test('attemptFingerprint is stable and order-insensitive on address case', async () => {
  const base = { chainId: BASE_SEPOLIA, from: OPERATOR_ADDR, to: TO_ADDR, data: '0x', value: 0n, operator: 'jennifer' };
  const a = await attemptFingerprint(base);
  const b = await attemptFingerprint({ ...base, to: TO_ADDR.toUpperCase().replace('0X', '0x') });
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

// ── 9. simulation failure blocks the send ───────────────────────────────────

test('a reverting eth_call blocks the broadcast', async () => {
  const rpc = fakeRpc({
    async call() {
      throw new Error('execution reverted: NotOwner');
    },
  });
  const signer = fakeSigner();
  const res = await new SendRelay().send(broadcastReq({ rpc, signer }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'simulation_reverted');
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.equal(signer.seen.length, 0);
});

test('malformed calldata is refused before any RPC call', async () => {
  const rpc = fakeRpc();
  const res = await new SendRelay().send(broadcastReq({ tx: tx({ data: 'zzz' }), rpc }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_invalid');
  assert.equal(rpc.calls.getNonce, 0);
});

test('oversized calldata is refused', async () => {
  const big = '0x' + 'ab'.repeat(MAX_DATA_BYTES + 1);
  const res = await new SendRelay().send(broadcastReq({ tx: tx({ data: big }) }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'data_too_large');
});

// ── 9b. the second interlock pass is real, not decorative ───────────────────

test('grant revoked mid-flight is caught by the pre-wire pass', async () => {
  // The ladder runs twice: at entry and immediately before signing. Here the
  // grant is revoked by the time gas estimation returns, so the second pass
  // must stop the send even though the first pass had already allowed it.
  const g = grant();
  const rpc = fakeRpc({
    async estimateGas() {
      rpc.calls.estimateGas += 1;
      g.approved = false; // revoke between the two passes
      return 21_000n;
    },
  });
  const signer = fakeSigner();
  const res = await new SendRelay().send(broadcastReq({ grant: g, rpc, signer }));

  assert.equal(res.ok, false);
  assert.equal(res.code, 'grant_not_approved');
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.equal(signer.seen.length, 0, 'pre-wire pass must run before signing');
});

test('expiry reached mid-flight is caught by the pre-wire pass', async () => {
  let now = NOW;
  const rpc = fakeRpc({
    async estimateGas() {
      rpc.calls.estimateGas += 1;
      now = NOW + 10_000; // clock rolls past expires_at during the build
      return 21_000n;
    },
  });
  const signer = fakeSigner();
  // `now` is read fresh by each pass, so the second sees the expired clock.
  const res = new SendRelay();
  const out = await res.send({
    verdict: proven(),
    tx: tx(),
    grant: grant(),
    signer,
    rpc,
    dry_run: false,
    get now() {
      return now;
    },
  });

  assert.equal(out.ok, false);
  assert.equal(out.code, 'grant_expired');
  assert.equal(rpc.calls.sendRawTransaction, 0);
  assert.equal(signer.seen.length, 0);
});

// ── 10. roeFromBrief regression + grant wiring ──────────────────────────────

function brief(over = {}) {
  return {
    program_id: 'p1',
    targets: ['0x2222222222222222222222222222222222222222'],
    max_mutability: 'mutate',
    time_box_minutes: 60,
    authorization_ref: 'program permits testing',
    ...over,
  };
}

test('roeFromBrief: no grant => allow_live_chain_writes stays false (regression)', () => {
  const roe = roeFromBrief(brief(), NOW);
  assert.equal(roe.allow_live_chain_writes, false);
});

test('roeFromBrief: explicit null grant => false (regression)', () => {
  const roe = roeFromBrief(brief(), NOW, null);
  assert.equal(roe.allow_live_chain_writes, false);
});

test('roeFromBrief: with a valid grant => true', () => {
  const roe = roeFromBrief(brief(), NOW, grant());
  assert.equal(roe.allow_live_chain_writes, true);
});

test('roeFromBrief: unapproved grant => false', () => {
  const roe = roeFromBrief(brief(), NOW, grant({ approved: false }));
  assert.equal(roe.allow_live_chain_writes, false);
});

test('roeFromBrief: expired grant => false', () => {
  const roe = roeFromBrief(brief(), NOW + 10_000, grant());
  assert.equal(roe.allow_live_chain_writes, false);
});

test('grantIsUsable rejects malformed grants', () => {
  assert.equal(grantIsUsable(null, NOW), false);
  assert.equal(grantIsUsable(undefined, NOW), false);
  assert.equal(grantIsUsable(grant({ operator: '' }), NOW), false);
  assert.equal(grantIsUsable(grant({ chain_id: 1.5 }), NOW), false);
  assert.equal(grantIsUsable(grant({ max_value_wei: 'abc' }), NOW), false);
  assert.equal(grantIsUsable(grant({ max_value_wei: -1n }), NOW), false);
  assert.equal(grantIsUsable(grant({ expires_at: NaN }), NOW), false);
  assert.equal(grantIsUsable(grant(), NOW), true);
  // number/string wei are accepted at the policy layer (BigInt()-coercible)
  assert.equal(grantIsUsable(grant({ max_value_wei: 1000 }), NOW), true);
});

// ── 11. the policy denial branch still denies without a grant ───────────────

test('PolicyEngine still denies a live chain write when no grant was granted', async () => {
  const addr = TO_ADDR;
  const roe = {
    engagement_id: 'e1',
    authorization_ref: 'ref',
    window_start: NOW - 60,
    window_end: NOW + 3600,
    cidrs: [],
    domains: [],
    urls: [],
    chain_addresses: { [BASE_MAINNET]: [addr.toLowerCase()] },
    excluded: [],
    denied_techniques: [],
    max_mutability: 'mutate',
    approval_techniques: [],
    allow_live_chain_writes: false,
    rate_limit_rps: 3,
  };
  const engine = new PolicyEngine(roe, () => NOW);
  const d = await engine.authorize({
    technique: 'T',
    target: addr,
    target_kind: 'chain_address',
    mutability: 'mutate',
    adapter: 'a',
    chain_id: BASE_MAINNET,
    is_fork: false,
  });
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /live chain writes disabled/);
});

test('PolicyEngine allows the same write once the grant flips the flag (approval still required)', async () => {
  const addr = TO_ADDR;
  const roe = {
    engagement_id: 'e1',
    authorization_ref: 'ref',
    window_start: NOW - 60,
    window_end: NOW + 3600,
    cidrs: [],
    domains: [],
    urls: [],
    chain_addresses: { [BASE_MAINNET]: [addr.toLowerCase()] },
    excluded: [],
    denied_techniques: [],
    max_mutability: 'mutate',
    approval_techniques: [],
    allow_live_chain_writes: true,
    rate_limit_rps: 3,
  };
  const engine = new PolicyEngine(roe, () => NOW);
  const d = await engine.authorize({
    technique: 'T',
    target: addr,
    target_kind: 'chain_address',
    mutability: 'mutate',
    adapter: 'a',
    chain_id: BASE_MAINNET,
    is_fork: false,
  });
  // The live-write axis no longer denies, but mutation still needs a human.
  assert.equal(d.verdict, 'needs_approval');
});

// ── 12. helpers + top-level export ──────────────────────────────────────────

test('toHexQty / normData', () => {
  assert.equal(toHexQty(0n), '0x0');
  assert.equal(toHexQty(21_000n), '0x5208');
  assert.equal(normData(undefined), '0x');
  assert.equal(normData(''), '0x');
  assert.equal(normData('0xAB'), '0xab');
  assert.equal(normData('zz'), null);
});

test('sendTransaction is exported and refuses without a grant (never throws)', async () => {
  const res = await sendTransaction({ verdict: proven(), tx: tx(), now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_grant');
});
