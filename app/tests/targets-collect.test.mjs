/**
 * Dedupe, merged collection, the testnet finding, and the collect pipeline.
 *
 * The dedupe tests exist because the obvious implementation is wrong in two
 * opposite ways at once:
 *
 *   · lowercasing the key for BOTH families collapses two DIFFERENT Solana
 *     pubkeys into one target, because base58 is case-sensitive;
 *   · NOT lowercasing for EVM makes one Base contract into two targets, because
 *     the same address is published in checksum casing by one feed and lowercase
 *     by another.
 *
 * And it is wrong in a third way that only shows up on real data: DeFiLlama lists
 * SEVERAL protocols against ONE contract (Sky Lending / Sky Money / Sky RWA all
 * share 0x56072c…). One contract is one target, but the other names are evidence
 * about blast radius, so they are kept in `also_known_as` rather than deleted.
 *
 * THE COLLECT TEST USES AN INJECTED FETCH. `collect.ts` takes `fetch` as a
 * dependency, so the pipeline — URL selection, error handling, byte budget,
 * sequential ordering, merge — is exercised end to end with zero network.
 *
 * Run with: node --test tests/targets-collect.test.mjs   (after `npm run build`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_PRIORITY,
  countByChain,
  dedupeCandidates,
  mergeCollections,
  topDroppedChains,
} from '../build/targets/dedupe.js';
import { candidateKey, isEvmCandidate } from '../build/targets/types.js';
import {
  TESTNET_EMPTY_REASON,
  emptyTestnetResult,
  isRegisteredTestnet,
  testnetCandidates,
} from '../build/targets/testnet.js';
import {
  SOURCE_BYTES,
  SOURCE_URLS,
  budgetFor,
  collectCandidates,
} from '../build/targets/collect.js';
import { parseDefiLlama, parseTokenList } from '../build/targets/sources.js';
import { CHAINS } from '../build/chains.js';

const BASE = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee';
const BASE_LOWER = BASE.toLowerCase();
const ETH = '0x5a98fcbea516cf06857215779fd812ca3bef1b32';
const SVM_UPPER = 'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu';
// A real pubkey that differs from SVM_UPPER only by letter CASE would be ideal;
// base58 keys that differ only in case are rare in practice, so this asserts the
// property directly rather than relying on a coincidence in real data.
const SVM_OTHER = 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS';

/** Build an EVM candidate with the fields dedupe actually reads. */
function evm(chain_id, address, name, source = 'defillama', extra = {}) {
  return {
    family: 'evm',
    chain_id,
    address,
    name,
    kind: 'protocol',
    source,
    also_in: [],
    also_known_as: [],
    ...extra,
  };
}

function svm(address, name, source = 'defillama', extra = {}) {
  return {
    family: 'svm',
    chain_id: null,
    cluster: 'mainnet-beta',
    address,
    name,
    kind: 'protocol',
    source,
    also_in: [],
    also_known_as: [],
    ...extra,
  };
}

// ── dedupe keys ─────────────────────────────────────────────────────────────

test('EVM keys are case-insensitive so one contract is never two targets', () => {
  const a = evm(8453, BASE, 'Aero');
  const b = evm(8453, BASE_LOWER, 'Aero lowercase');
  assert.equal(candidateKey(a), candidateKey(b));

  const { candidates, duplicates } = dedupeCandidates([a, b]);
  assert.equal(duplicates, 1);
  assert.equal(candidates.length, 1);
});

test('SVM keys are CASE-SENSITIVE so two pubkeys never collapse into one', () => {
  // Lowercasing a Solana key would merge distinct accounts — a lost target, and
  // the kind of loss no counter would report.
  const key = candidateKey(svm(SVM_UPPER, 'Sanctum'));
  assert.ok(key.includes(SVM_UPPER), 'the key must preserve base58 casing');
  assert.equal(key, `svm:mainnet-beta:${SVM_UPPER}`);

  const a = svm(SVM_UPPER, 'A');
  const b = svm(SVM_OTHER, 'B');
  const { candidates, duplicates } = dedupeCandidates([a, b]);
  assert.equal(duplicates, 0, 'different pubkeys are different targets');
  assert.equal(candidates.length, 2);
});

test('the same address on DIFFERENT chains is not a duplicate', () => {
  const a = evm(1, ETH, 'On Ethereum');
  const b = evm(8453, ETH, 'Same Hex On Base');
  const { candidates, duplicates } = dedupeCandidates([a, b]);
  assert.equal(duplicates, 0);
  assert.equal(candidates.length, 2);
});

test('an EVM key and an SVM key can never collide', () => {
  const k1 = candidateKey(evm(8453, BASE, 'x'));
  const k2 = candidateKey(svm(SVM_UPPER, 'y'));
  assert.notEqual(k1, k2);
  assert.ok(k1.startsWith('evm:'));
  assert.ok(k2.startsWith('svm:'));
});

// ── dedupe merge semantics ──────────────────────────────────────────────────

test('the higher-priority source wins identity and the loser becomes provenance', () => {
  const fromToken = evm(8453, BASE, 'Blue Token', 'coingecko-base', { kind: 'token' });
  const fromLlama = evm(8453, BASE, 'Aero Slipstream', 'defillama', { category: 'Dexs', tvl_usd: 5 });

  // Order must not matter: the merge is decided by priority, not by arrival.
  for (const input of [
    [fromToken, fromLlama],
    [fromLlama, fromToken],
  ]) {
    const { candidates } = dedupeCandidates(input);
    assert.equal(candidates.length, 1);
    const c = candidates[0];
    assert.equal(c.source, 'defillama', 'protocol metadata is richer than a token symbol');
    assert.equal(c.name, 'Aero Slipstream');
    assert.equal(c.kind, 'protocol');
    assert.equal(c.category, 'Dexs');
    assert.equal(c.tvl_usd, 5);
    assert.deepEqual(c.also_in, ['coingecko-base']);
    assert.deepEqual(c.also_known_as, ['Blue Token']);
  }
});

test('a lower-priority challenger does not overwrite the incumbent', () => {
  const llama = evm(8453, BASE, 'Aero Slipstream', 'defillama', { category: 'Dexs' });
  const token = evm(8453, BASE, 'AERO', 'coingecko-base', { kind: 'token' });
  const { candidates } = dedupeCandidates([llama, token]);
  const c = candidates[0];
  assert.equal(c.name, 'Aero Slipstream');
  assert.equal(c.category, 'Dexs');
  assert.deepEqual(c.also_in, ['coingecko-base']);
  assert.deepEqual(c.also_known_as, ['AERO']);
});

test('SEVERAL protocols on ONE contract keep every name in also_known_as', () => {
  // This is the real Sky shape: one 0x, three protocols. One target, but the
  // aliases are blast-radius evidence and must not be deleted.
  const sky = [
    evm(1, ETH, 'Sky Lending', 'defillama', { category: 'CDP', tvl_usd: 5390391875 }),
    evm(1, ETH, 'Sky Money', 'defillama', { category: 'Risk Curators' }),
    evm(1, ETH, 'Sky RWA', 'defillama', { category: 'RWA' }),
  ];
  const { candidates, duplicates } = dedupeCandidates(sky);
  assert.equal(duplicates, 2);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.name, 'Sky Lending', 'the first record wins identity');
  assert.deepEqual(c.also_known_as, ['Sky Money', 'Sky RWA']);
});

test('also_in is deduplicated and never lists the winning source', () => {
  const a = evm(8453, BASE, 'A', 'defillama');
  const b = evm(8453, BASE, 'B', 'coingecko-base');
  const c = evm(8453, BASE, 'C', 'coingecko-base');
  const { candidates } = dedupeCandidates([a, b, c]);
  const winner = candidates[0];
  assert.ok(!winner.also_in.includes('defillama'), 'the winner must not list itself');
  assert.deepEqual(winner.also_in, ['coingecko-base']);
});

test('no name is ever recorded as its own alias', () => {
  const a = evm(8453, BASE, 'Same Name', 'defillama');
  const b = evm(8453, BASE, 'Same Name', 'coingecko-base');
  const { candidates } = dedupeCandidates([a, b]);
  assert.deepEqual(candidates[0].also_known_as, []);
});

test('dedupe preserves first-seen order and does not mutate its input', () => {
  const input = [
    evm(1, ETH, 'first'),
    evm(8453, BASE, 'second'),
    evm(1, ETH, 'first again', 'coingecko-uniswap'),
  ];
  const snapshot = JSON.stringify(input);
  const { candidates } = dedupeCandidates(input);
  assert.deepEqual(
    candidates.map((c) => c.chain_id),
    [1, 8453],
  );
  assert.equal(JSON.stringify(input), snapshot, 'input must not be mutated');
  // And the survivor's provenance array is a copy, not the caller's array.
  assert.notEqual(candidates[0].also_known_as, input[2].also_known_as);
});

test('SOURCE_PRIORITY puts every source in it and is a total order', () => {
  const keys = Object.keys(SOURCE_PRIORITY).sort();
  assert.deepEqual(keys, Object.keys(SOURCE_URLS).sort());
  const values = Object.values(SOURCE_PRIORITY);
  assert.equal(new Set(values).size, values.length, 'priorities must be distinct');
});

// ── merged collection ───────────────────────────────────────────────────────

test('mergeCollections reconciles input records to output candidates exactly', () => {
  const llama = parseDefiLlama([
    { name: 'Aero', chain: 'Base', address: `base:${BASE}` },
    { name: 'Pancake', chain: 'Binance', address: 'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' },
    { name: 'Bare', chain: 'Multi-Chain', address: ETH },
    { name: 'Bad', chain: 'Base', address: 'base:0xnope' },
  ]);
  const base = parseTokenList(
    { tokens: [{ chainId: 8453, address: BASE, name: 'AERO' }] },
    'coingecko-base',
  );

  const collection = mergeCollections([llama, base], []);
  const d = collection.drops;
  const byName = Object.values(d.by_chain_name).reduce((a, b) => a + b, 0);

  assert.equal(d.records_seen, 5);
  assert.equal(d.emitted, 1);
  assert.equal(d.duplicates, 1);
  assert.equal(d.no_chain, 1);
  assert.equal(d.malformed_address, 1);
  assert.equal(byName, 1);
  assert.equal(
    d.records_seen,
    d.emitted + d.duplicates + byName + d.no_chain + d.malformed_address,
    'every record must be accounted for exactly once',
  );
  assert.equal(collection.candidates[0].chain_id, 8453);
  assert.deepEqual(collection.candidates[0].also_in, ['coingecko-base']);
});

test('drop counts from several sources are summed by chain name', () => {
  const a = parseDefiLlama([
    { name: 'x', chain: 'Binance', address: 'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' },
    { name: 'y', chain: 'Binance', address: 'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' },
  ]);
  const b = parseDefiLlama([
    { name: 'z', chain: 'Binance', address: 'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' },
  ]);
  const collection = mergeCollections([a, b], []);
  assert.equal(collection.drops.by_chain_name['bsc'], 3);
});

test('countByChain uses "svm" for Solana rather than a null-ish key', () => {
  const counts = countByChain([evm(8453, BASE, 'a'), svm(SVM_UPPER, 'b'), evm(8453, BASE_LOWER, 'c')]);
  assert.equal(counts['8453'], 2);
  assert.equal(counts['svm'], 1);
  assert.equal(counts['null'], undefined);
});

test('topDroppedChains sorts by count and breaks ties alphabetically', () => {
  const drops = {
    by_chain_name: { zeta: 1, alpha: 1, big: 5 },
    no_chain: 0,
    malformed_address: 0,
    records_seen: 7,
    emitted: 0,
    duplicates: 0,
  };
  const top = topDroppedChains(drops, 3);
  assert.deepEqual(top, [
    { name: 'big', count: 5 },
    { name: 'alpha', count: 1 },
    { name: 'zeta', count: 1 },
  ]);
});

// ── the testnet finding ─────────────────────────────────────────────────────

test('the testnet result is EMPTY and carries a reason', () => {
  const r = emptyTestnetResult();
  assert.deepEqual(r.candidates, []);
  assert.equal(r.candidates.length, 0);
  assert.ok(r.reason.length > 0, 'an empty result must explain itself');
  assert.equal(r.reason, TESTNET_EMPTY_REASON);
  // The reason must name the observed facts, not a vague apology.
  assert.match(r.reason, /DeFiLlama/);
  assert.match(r.reason, /403/);
});

test('the testnet result names every non-mainnet chain in the registry', () => {
  const r = emptyTestnetResult();
  const expected = Object.values(CHAINS)
    .filter((c) => !c.mainnet)
    .map((c) => c.id)
    .sort((a, b) => a - b);
  assert.deepEqual(r.chain_ids, expected);
  // Explicitly: the two forkable testnets plus anvil.
  assert.deepEqual(r.chain_ids, [31337, 84532, 11155111]);
  for (const id of r.chain_ids) {
    assert.ok(Object.hasOwn(CHAINS, id), `${id} must be a real registry chain`);
  }
});

test('no MAINNET chain is reported as a testnet', () => {
  for (const spec of Object.values(CHAINS)) {
    assert.equal(isRegisteredTestnet(spec.id), !spec.mainnet, `chain ${spec.id}`);
  }
  assert.equal(isRegisteredTestnet(1), false);
  assert.equal(isRegisteredTestnet(8453), false);
});

test('isRegisteredTestnet rejects chains the registry does not carry', () => {
  // An unregistered chain is not a testnet — it is unknown, and saying "testnet"
  // would be a different (wrong) claim.
  for (const id of [0, 56, 42161, 999999]) {
    assert.equal(isRegisteredTestnet(id), false);
  }
});

test('testnetCandidates is empty and cannot be populated by extrapolation', () => {
  assert.deepEqual(testnetCandidates(), []);
});

// ── the collect pipeline, with an injected fetch ────────────────────────────

/** A fetch stub that serves prepared bodies by URL and records what it was asked. */
function stubFetch(bodies) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    if (typeof body === 'object' && body.__status) {
      return { ok: false, status: body.__status, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

test('collectCandidates drives the whole pipeline with no network', async () => {
  const fetchStub = stubFetch({
    [SOURCE_URLS.defillama]: [
      { name: 'Aero', chain: 'Base', address: `base:${BASE}`, category: 'Dexs', tvl: 100 },
      { name: 'Sanctum', chain: 'Solana', address: `solana:${SVM_UPPER}` },
      { name: 'Pancake', chain: 'Binance', address: 'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' },
    ],
    [SOURCE_URLS['coingecko-base']]: {
      tokens: [{ chainId: 8453, address: BASE, name: 'AERO' }],
    },
    [SOURCE_URLS['coingecko-uniswap']]: {
      tokens: [{ chainId: 1, address: ETH, name: 'Lido' }],
    },
  });

  const { collection, outcomes } = await collectCandidates({ fetch: fetchStub });

  assert.equal(fetchStub.calls.length, 3, 'exactly one subrequest per source');
  assert.ok(outcomes.every((o) => o.ok), 'all three sources should succeed');

  const chains = countByChain(collection.candidates);
  assert.equal(chains['8453'], 1, 'the Base protocol and its token entry are one target');
  assert.equal(chains['1'], 1);
  assert.equal(chains['svm'], 1);
  assert.equal(collection.candidates.length, 3);

  // The Base token was absorbed into the protocol record, not lost.
  const baseCandidate = collection.candidates.find((c) => c.chain_id === 8453);
  assert.equal(baseCandidate.kind, 'protocol');
  assert.deepEqual(baseCandidate.also_in, ['coingecko-base']);
  assert.equal(collection.drops.by_chain_name['bsc'], 1);
});

test('a failed source is reported, and the others still produce targets', async () => {
  // One dead feed must not turn a refresh into zero targets.
  const fetchStub = stubFetch({
    [SOURCE_URLS.defillama]: { __status: 503 },
    [SOURCE_URLS['coingecko-base']]: { tokens: [{ chainId: 8453, address: BASE, name: 'AERO' }] },
    [SOURCE_URLS['coingecko-uniswap']]: { tokens: [] },
  });
  const { collection, outcomes } = await collectCandidates({ fetch: fetchStub });

  const llamaOutcome = outcomes.find((o) => o.source === 'defillama');
  assert.equal(llamaOutcome.ok, false);
  assert.match(llamaOutcome.error, /503/);
  assert.equal(collection.candidates.length, 1, 'the Base token still came through');
});

test('an empty inventory and a broken fetch are NOT reported the same way', async () => {
  // This is the distinction that keeps "no targets" from meaning "no targets
  // exist". A 200 with zero tokens is ok:true and zero candidates; a 500 is
  // ok:false with an error.
  const ok = stubFetch({ [SOURCE_URLS['coingecko-uniswap']]: { tokens: [] } });
  const good = await collectCandidates({ fetch: ok, include: ['coingecko-uniswap'] });
  assert.equal(good.outcomes[0].ok, true);
  assert.equal(good.collection.candidates.length, 0);

  const bad = stubFetch({ [SOURCE_URLS['coingecko-uniswap']]: { __status: 500 } });
  const broken = await collectCandidates({ fetch: bad, include: ['coingecko-uniswap'] });
  assert.equal(broken.outcomes[0].ok, false);
  assert.ok(broken.outcomes[0].error);
});

test('a non-JSON body is a failure, not an empty result', async () => {
  const fetchStub = async () => ({ ok: true, status: 200, text: async () => '<html>not json' });
  const { outcomes } = await collectCandidates({ fetch: fetchStub, include: ['defillama'] });
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].error, /JSON/i);
});

test('the byte budget skips a source and says so, instead of failing silently', async () => {
  const fetchStub = stubFetch({
    [SOURCE_URLS['coingecko-base']]: { tokens: [] },
    [SOURCE_URLS['coingecko-uniswap']]: { tokens: [] },
  });
  const { outcomes } = await collectCandidates({ fetch: fetchStub, max_body_bytes: 2_000_000 });

  const skipped = outcomes.find((o) => o.source === 'defillama');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.ok, false);
  assert.match(skipped.error, /max_body_bytes/);
  // DeFiLlama must not have been fetched at all.
  assert.ok(!fetchStub.calls.includes(SOURCE_URLS.defillama));
});

test('budgetFor reports one request per source and the observed byte cost', () => {
  const all = budgetFor(Object.keys(SOURCE_URLS));
  assert.equal(all.requests, 3);
  assert.equal(all.bytes, SOURCE_BYTES.defillama + SOURCE_BYTES['coingecko-base'] + SOURCE_BYTES['coingecko-uniswap']);

  // The budget fact worth stating: one source dominates it.
  assert.ok(
    SOURCE_BYTES.defillama > 8_000_000,
    'DeFiLlama is a ~9.4 MB single response; the binding cost is bytes, not subrequests',
  );
  assert.ok(SOURCE_BYTES.defillama > SOURCE_BYTES['coingecko-base'] * 10);
  assert.equal(budgetFor(['defillama']).requests, 1);
});

test('a missing fetch implementation fails cleanly rather than throwing', async () => {
  const saved = globalThis.fetch;
  try {
    // Force the "no fetch available" branch deterministically.
    Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });
    const { outcomes, collection } = await collectCandidates({ include: ['defillama'] });
    assert.equal(outcomes[0].ok, false);
    assert.equal(collection.candidates.length, 0);
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: saved, configurable: true });
  }
});

// ── the cross-module invariant ──────────────────────────────────────────────

test('every emitted candidate satisfies the type invariant a caller relies on', () => {
  const llama = parseDefiLlama([
    { name: 'a', chain: 'Base', address: `base:${BASE}` },
    { name: 'b', chain: 'Ethereum', address: `ethereum:${ETH}` },
    { name: 'c', chain: 'Solana', address: `solana:${SVM_UPPER}` },
    { name: 'd', chain: 'Binance', address: 'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' },
  ]);
  for (const c of llama.candidates) {
    if (isEvmCandidate(c)) {
      assert.equal(typeof c.chain_id, 'number');
      assert.ok(Number.isInteger(c.chain_id));
      assert.ok(Object.hasOwn(CHAINS, c.chain_id), `chain ${c.chain_id} must be registered`);
      assert.equal(c.family, 'evm');
    } else {
      assert.equal(c.family, 'svm');
      assert.equal(c.chain_id, null, 'an SVM candidate must not carry an invented chain id');
      assert.equal(c.cluster, 'mainnet-beta');
    }
  }
});
