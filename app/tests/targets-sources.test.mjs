/**
 * Source parsers — the offline test of the code path the Worker actually runs.
 *
 * NO NETWORK HERE, BY CONSTRUCTION. `sources.ts` takes a decoded body and returns
 * a `ParseResult`, so the whole parse can be driven from a literal fixture. That
 * is not a convenience: a parser that can only be exercised by spending a 9.4 MB
 * subrequest is a parser nobody tests.
 *
 * THE RECONCILIATION IDENTITY IS THE MAIN ASSERTION. Every record must land in
 * exactly one bucket:
 *
 *     records_seen === candidates + Σdrops + no_chain + malformed
 *
 * Without it, a feed shape change and an empty feed both look like an empty
 * candidate list, and "no targets" reads as "no targets exist".
 *
 * The fixtures below reproduce field shapes OBSERVED in the live feeds
 * (2026-10-29), including the awkward ones: bare addresses under a
 * `Multi-Chain` entry, a `solana:` prefix whose body is not a pubkey, and a Sui
 * id with its own `::` separators.
 *
 * Run with: node --test tests/targets-sources.test.mjs   (after `npm run build`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDefiLlama, parseTokenList } from '../build/targets/sources.js';
import { CHAINS } from '../build/chains.js';

// ── real addresses ──────────────────────────────────────────────────────────
const BASE_AERO = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee';
const ETH_LIDO = '0x5a98fcbea516cf06857215779fd812ca3bef1b32';
const SOL_SANCTUM = 'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu';
const SOL_KAMINO = 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS';
const BSC_PCS = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';

/** The identity every parse must satisfy. */
function assertBalanced(result, label) {
  const dropped = Object.values(result.dropped_by_chain_name).reduce((a, b) => a + b, 0);
  const accounted = result.candidates.length + dropped + result.dropped_no_chain + result.dropped_malformed;
  assert.equal(
    result.records_seen,
    accounted,
    `${label}: records_seen ${result.records_seen} != accounted ${accounted} ` +
      `(candidates ${result.candidates.length}, dropped-by-name ${dropped}, ` +
      `no_chain ${result.dropped_no_chain}, malformed ${result.dropped_malformed})`,
  );
}

// ── DeFiLlama ───────────────────────────────────────────────────────────────

test('a prefixed Base address resolves to chain 8453 and keeps its metadata', () => {
  const r = parseDefiLlama([
    {
      name: 'Aero Slipstream',
      chain: 'Base',
      address: `base:${BASE_AERO}`,
      category: 'Dexs',
      tvl: 121367106.4,
    },
  ]);
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.family, 'evm');
  assert.equal(c.chain_id, 8453);
  assert.equal(c.address, BASE_AERO);
  assert.equal(c.name, 'Aero Slipstream');
  assert.equal(c.kind, 'protocol');
  assert.equal(c.source, 'defillama');
  assert.equal(c.category, 'Dexs');
  assert.equal(c.tvl_usd, 121367106.4);
  assert.deepEqual(c.also_known_as, []);
  assertBalanced(r, 'single Base protocol');
});

test('a Solana address becomes an SVM candidate with chain_id null, not a number', () => {
  const r = parseDefiLlama([
    { name: 'Sanctum Validator LSTs', chain: 'Solana', address: `solana:${SOL_SANCTUM}`, tvl: 1.8e9 },
  ]);
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.family, 'svm');
  // The whole point: no invented chain id, and the family is unmissable.
  assert.equal(c.chain_id, null);
  assert.equal(c.cluster, 'mainnet-beta');
  assert.equal(c.address, SOL_SANCTUM);
  // The EVM validator must never have been applied to it.
  assert.equal(r.dropped_malformed, 0);
});

test('the ADDRESS PREFIX wins over a "Multi-Chain" entry, so those are not lost', () => {
  // Real shape: 1042 entries say Multi-Chain and 41 of them carry a base: address.
  // Reading `chain` first would throw those away.
  const r = parseDefiLlama([
    { name: 'Multi Chain With Base Addr', chain: 'Multi-Chain', address: `base:${BASE_AERO}` },
    { name: 'Multi Chain With Sol Addr', chain: 'Multi-Chain', address: `solana:${SOL_KAMINO}` },
  ]);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].chain_id, 8453);
  assert.equal(r.candidates[1].family, 'svm');
  assert.equal(r.dropped_no_chain, 0);
});

test('a BARE address under a Multi-Chain entry is dropped and counted, not guessed', () => {
  // 624 records have this shape (bare address + Multi-Chain/null). Guessing a
  // chain here is the exact bug `chains.ts` exists to prevent.
  const r = parseDefiLlama([
    { name: 'OKX', chain: 'Multi-Chain', address: ETH_LIDO },
    { name: 'No Chain Field', chain: null, address: BASE_AERO },
  ]);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped_no_chain, 2);
  assert.equal(r.records_seen, 2);
  assertBalanced(r, 'bare + multi-chain');
});

test('a bare address DOES resolve from the entry-level chain field', () => {
  const r = parseDefiLlama([{ name: 'Bare But Named', chain: 'Ethereum', address: ETH_LIDO }]);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].chain_id, 1);
});

test('a chain outside the registry is dropped and counted under the source spelling', () => {
  const r = parseDefiLlama([
    { name: 'PancakeSwap', chain: 'Binance', address: `bsc:${BSC_PCS}` },
    { name: 'Aave V3', chain: 'Ethereum', address: ETH_LIDO },
  ]);
  assert.equal(r.candidates.length, 1, 'only the Ethereum one survives');
  assert.equal(r.candidates[0].chain_id, 1);
  assert.equal(r.dropped_by_chain_name['bsc'], 1);
  assertBalanced(r, 'unregistered chain');
});

test('a solana-prefixed NON-pubkey body is malformed, not a Solana target', () => {
  // Real: DeFiLlama publishes `solana:token/EdAhkbj5nF9sRM7XN7ewuW8C9XEUMs8P7cnoQ57SYE96`
  // for Fabric. The label says Solana; the body is not a pubkey.
  const r = parseDefiLlama([
    {
      name: 'Fabric',
      chain: 'Multi-Chain',
      address: 'solana:token/EdAhkbj5nF9sRM7XN7ewuW8C9XEUMs8P7cnoQ57SYE96',
    },
  ]);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped_malformed, 1);
  assertBalanced(r, 'solana non-pubkey');
});

test('a base-prefixed address that is not 20-byte hex is malformed, not misfiled', () => {
  const r = parseDefiLlama([
    { name: 'Wrong Shape', chain: 'Base', address: 'base:0xdeadbeef' },
    { name: 'Solana Addr Under Base', chain: 'Base', address: `base:${SOL_SANCTUM}` },
  ]);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped_malformed, 2);
  assertBalanced(r, 'malformed bodies');
});

test('entries with no address at all are not counted as records', () => {
  // 4454 of 8874 entries have no address; they are not failures, just not
  // addressable targets. Counting them in records_seen would break the identity.
  const r = parseDefiLlama([
    { name: 'Binance CEX', chain: 'Multi-Chain', address: null },
    { name: 'No Address Key', chain: 'Ethereum' },
    { name: 'Empty String', chain: 'Ethereum', address: '   ' },
    { name: 'Real', chain: 'Base', address: `base:${BASE_AERO}` },
  ]);
  assert.equal(r.records_seen, 1);
  assert.equal(r.without_address, 3);
  assert.equal(r.candidates.length, 1);
  assertBalanced(r, 'without address');
});

test('a Sui id with its own colons is dropped by chain, not corrupted by splitting', () => {
  // `sui:0x2::sui::SUI` — the body has `::` separators. It must be reported as
  // an unregistered chain named `sui`, not mis-parsed into a chain called `sui`
  // with a truncated address.
  const r = parseDefiLlama([{ name: 'Sui Foundation', chain: 'Sui', address: 'sui:0x2::sui::SUI' }]);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped_by_chain_name['sui'], 1);
  assert.equal(r.dropped_malformed, 0);
  assertBalanced(r, 'sui id');
});

test('non-object and malformed input yields an empty, balanced result', () => {
  for (const bad of [null, undefined, 'string', 42, {}]) {
    const r = parseDefiLlama(bad);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.records_seen, 0);
    assertBalanced(r, `bad input ${String(bad)}`);
  }
});

test('the DeFiLlama parser never emits a chain_id outside CHAINS', () => {
  const r = parseDefiLlama([
    { name: 'a', chain: 'Base', address: `base:${BASE_AERO}` },
    { name: 'b', chain: 'Ethereum', address: `ethereum:${ETH_LIDO}` },
    { name: 'c', chain: 'Binance', address: `bsc:${BSC_PCS}` },
    { name: 'd', chain: 'Solana', address: `solana:${SOL_SANCTUM}` },
  ]);
  for (const c of r.candidates) {
    if (c.family === 'evm') {
      assert.ok(Object.hasOwn(CHAINS, c.chain_id), `${c.chain_id} must be in CHAINS`);
    } else {
      assert.equal(c.chain_id, null);
    }
  }
});

// ── token lists ─────────────────────────────────────────────────────────────

test('a Base token list yields chain 8453 token candidates', () => {
  const r = parseTokenList(
    {
      name: 'CoinGecko',
      tokens: [
        { chainId: 8453, address: '0x7f65323e468939073ef3b5287c73f13951b0ff5b', name: 'Blue', symbol: 'BLUE', decimals: 18 },
      ],
    },
    'coingecko-base',
  );
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.family, 'evm');
  assert.equal(c.chain_id, 8453);
  assert.equal(c.kind, 'token');
  assert.equal(c.name, 'Blue');
  assert.equal(c.source, 'coingecko-base');
  assertBalanced(r, 'base token');
});

test('a token list for an unregistered chain yields nothing and names the chainId', () => {
  const r = parseTokenList(
    { tokens: [{ chainId: 56, address: BSC_PCS, name: 'CAKE' }] },
    'coingecko-base',
  );
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped_by_chain_name['chainId:56'], 1);
  assertBalanced(r, 'unregistered chainId');
});

test('a token with no chainId is counted as no-chain rather than assumed', () => {
  const r = parseTokenList(
    { tokens: [{ address: BASE_AERO, name: 'No Chain' }, { chainId: null, address: BASE_AERO }] },
    'coingecko-base',
  );
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped_no_chain, 2);
  assertBalanced(r, 'no chainId');
});

test('a token address that is not EVM hex is malformed', () => {
  const r = parseTokenList(
    { tokens: [{ chainId: 8453, address: SOL_SANCTUM, name: 'Not Evm' }] },
    'coingecko-base',
  );
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped_malformed, 1);
});

test('a token with no name falls back to its symbol, then to a placeholder', () => {
  // A nameless token is still a real, forkable address — dropping it would lose
  // a target; inventing a name would put fiction into every report.
  const r = parseTokenList(
    { tokens: [{ chainId: 8453, address: BASE_AERO, symbol: 'AERO' }] },
    'coingecko-base',
  );
  assert.equal(r.candidates[0].name, 'AERO');

  const r2 = parseTokenList({ tokens: [{ chainId: 8453, address: BASE_AERO }] }, 'coingecko-base');
  assert.equal(r2.candidates[0].name, '(unnamed token)');
});

test('the token parser accepts a bare array as well as {tokens:[...]}', () => {
  // Both shapes exist in the wild for "a token list"; only one is documented.
  const bare = parseTokenList([{ chainId: 1, address: ETH_LIDO, name: 'Lido' }], 'coingecko-uniswap');
  assert.equal(bare.candidates.length, 1);
  assert.equal(bare.candidates[0].chain_id, 1);
});

test('the token parser does not emit tvl_usd or category for tokens', () => {
  // Both are protocol concepts; synthesising them would make a token look like
  // it had TVL data and skew any downstream ranking.
  const r = parseTokenList({ tokens: [{ chainId: 1, address: ETH_LIDO, name: 'Lido' }] }, 'coingecko-uniswap');
  assert.equal(r.candidates[0].tvl_usd, undefined);
  assert.equal(r.candidates[0].category, undefined);
});

test('malformed token-list bodies yield an empty, balanced result', () => {
  for (const bad of [null, undefined, 'str', 42, {}, { tokens: 'notarray' }]) {
    const r = parseTokenList(bad, 'coingecko-base');
    assert.deepEqual(r.candidates, []);
    assert.equal(r.records_seen, 0);
    assertBalanced(r, `bad token body ${String(bad)}`);
  }
});

test('a token entry with a non-string address is skipped, not coerced', () => {
  const r = parseTokenList(
    { tokens: [{ chainId: 8453, address: 12345 }, { chainId: 8453, address: null }, null, 'str'] },
    'coingecko-base',
  );
  assert.equal(r.candidates.length, 0);
  assert.equal(r.records_seen, 0);
  assert.equal(r.without_address, 2);
});
