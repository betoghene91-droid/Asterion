// Tests for the chain registry.
//
// The registry is what stops the fork chain from being a guess. Before it
// existed, `policy.ts` filed every 0x address under chain 8453 ("Base; overridden
// per engagement when known" — nothing overrode it) and `prove.yml` forked one
// `secrets.FORK_RPC` in four steps. These tests pin the two properties that make
// the fix real: ids map to their own secret NAME, and a chain is never inferred
// from a number that is not a chain token.
//
// Run with: node --test tests/chains.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAINS,
  DEFAULT_FORK_RPC_ENV,
  chainSpec,
  rpcEnvFor,
  isMainnet,
  describeChain,
  parseChainToken,
} from '../build/chains.js';

// ── the registry ────────────────────────────────────────────────────────────

test('every chain entry has an id matching its key and a non-empty rpc_env', () => {
  const rows = Object.entries(CHAINS);
  assert.ok(rows.length >= 5, 'the five supported chains must be present');
  for (const [key, spec] of rows) {
    assert.equal(String(spec.id), key, `entry ${key} carries id ${spec.id}; key must match`);
    assert.equal(typeof spec.rpc_env, 'string');
    assert.ok(spec.rpc_env.length > 0, `chain ${key} has an empty rpc_env`);
    assert.ok(spec.name.length > 0, `chain ${key} has an empty name`);
    assert.ok(spec.native.length > 0, `chain ${key} has an empty native symbol`);
  }
});

test('every rpc_env name is unique, so one chain cannot read another chain secret', () => {
  const names = Object.values(CHAINS).map((c) => c.rpc_env);
  assert.equal(new Set(names).size, names.length);
});

test('every rpc_env name is derived from the id it belongs to', () => {
  // The workflow resolves the secret by literal name in a case statement, so a
  // name that does not say which chain it holds is unreviewable by eye.
  for (const spec of Object.values(CHAINS)) {
    assert.equal(spec.rpc_env, `FORK_RPC_${spec.id}`);
  }
});

test('the five required chains are registered with the required metadata', () => {
  assert.deepEqual(chainSpec(1), {
    id: 1,
    name: 'Ethereum',
    rpc_env: 'FORK_RPC_1',
    explorer: 'etherscan.io',
    native: 'ETH',
    mainnet: true,
  });
  assert.equal(chainSpec(8453)?.name, 'Base');
  assert.equal(chainSpec(8453)?.rpc_env, 'FORK_RPC_8453');
  assert.equal(chainSpec(8453)?.explorer, 'basescan.org');
  assert.equal(chainSpec(8453)?.mainnet, true);
  assert.equal(chainSpec(84532)?.name, 'Base Sepolia');
  assert.equal(chainSpec(84532)?.rpc_env, 'FORK_RPC_84532');
  assert.equal(chainSpec(84532)?.explorer, 'sepolia.basescan.org');
  assert.equal(chainSpec(84532)?.mainnet, false);
  assert.equal(chainSpec(11155111)?.name, 'Ethereum Sepolia');
  assert.equal(chainSpec(11155111)?.rpc_env, 'FORK_RPC_11155111');
  assert.equal(chainSpec(11155111)?.explorer, 'sepolia.etherscan.io');
  assert.equal(chainSpec(11155111)?.mainnet, false);
  assert.equal(chainSpec(31337)?.name, 'Anvil');
  assert.equal(chainSpec(31337)?.rpc_env, 'FORK_RPC_31337');
  assert.equal(chainSpec(31337)?.explorer, '');
  assert.equal(chainSpec(31337)?.mainnet, false);
  for (const spec of Object.values(CHAINS)) assert.equal(spec.native, 'ETH');
});

test('chainSpec returns null for an unknown id and does not throw', () => {
  assert.equal(chainSpec(999999), null);
  assert.equal(chainSpec(Number.NaN), null);
});

// ── rpcEnvFor: per-chain name, else the named fallback ──────────────────────

test('rpcEnvFor returns the per-chain secret name for a known id', () => {
  assert.equal(rpcEnvFor(1), 'FORK_RPC_1');
  assert.equal(rpcEnvFor(8453), 'FORK_RPC_8453');
  assert.equal(rpcEnvFor(84532), 'FORK_RPC_84532');
  assert.equal(rpcEnvFor(11155111), 'FORK_RPC_11155111');
  assert.equal(rpcEnvFor(31337), 'FORK_RPC_31337');
});

test('rpcEnvFor falls back to FORK_RPC for null, undefined and unknown ids', () => {
  assert.equal(DEFAULT_FORK_RPC_ENV, 'FORK_RPC');
  assert.equal(rpcEnvFor(null), 'FORK_RPC');
  assert.equal(rpcEnvFor(undefined), 'FORK_RPC');
  // An unrecognised chain must NOT throw: it is a reason to fall back and say
  // so, not to crash a dispatch that is otherwise sound.
  assert.equal(rpcEnvFor(999999), 'FORK_RPC');
  assert.equal(rpcEnvFor(0), 'FORK_RPC');
});

// ── parseChainToken: explicit only ──────────────────────────────────────────

test('parseChainToken accepts chain:, chain_id: and chain=', () => {
  assert.equal(parseChainToken('chain:1'), 1);
  assert.equal(parseChainToken('chain_id:8453'), 8453);
  assert.equal(parseChainToken('chain=84532'), 84532);
  assert.equal(parseChainToken('chain_id=11155111'), 11155111);
  // In context, surrounded by other tokens.
  assert.equal(parseChainToken('contract:Vault chain:8453 fork_block:19000000'), 8453);
  assert.equal(parseChainToken('have a look, chain:1 please'), 1);
});

test('parseChainToken returns null when no chain token is present', () => {
  assert.equal(parseChainToken(''), null);
  assert.equal(parseChainToken('contract:Vault repo:https://github.com/a/b.git'), null);
  assert.equal(parseChainToken('look at this for me'), null);
});

test('parseChainToken does NOT read the number inside fork_block:19000000', () => {
  // The whole point of requiring the word "chain": a block number is not a chain
  // id. Reading 19000000 here would send prove.yml looking for FORK_RPC_19000000.
  assert.equal(parseChainToken('fork_block:19000000'), null);
  assert.equal(parseChainToken('contract:Vault fork_block:19000000'), null);
  assert.equal(parseChainToken('fork_block=19000000'), null);
});

test('parseChainToken is not fooled by a bare number or a longer word', () => {
  // A bare id is not a pin: precedence must stay "explicit token, else nothing".
  assert.equal(parseChainToken('8453'), null);
  assert.equal(parseChainToken('chain 8453'), null);
  // "crosschain:5" / "off-chain:5" are different words, not chain pins.
  assert.equal(parseChainToken('crosschain:5'), null);
  assert.equal(parseChainToken('off-chain:5'), null);
  // A partial numeric token is not an id.
  assert.equal(parseChainToken('chain:8453abc'), null);
  assert.equal(parseChainToken('chain:84.5'), null);
});

test('parseChainToken rejects id 0 and absurd ids instead of filing a chain nothing can fork', () => {
  assert.equal(parseChainToken('chain:0'), null);
  assert.equal(parseChainToken('chain:99999999999999'), null);
});

// ── describeChain: never empty ──────────────────────────────────────────────

test('describeChain never returns an empty string', () => {
  const cases = [1, 8453, 84532, 11155111, 31337, null, undefined, 0, 999999, Number.NaN];
  for (const c of cases) {
    const out = describeChain(c);
    assert.equal(typeof out, 'string');
    assert.ok(out.trim().length > 0, `describeChain(${String(c)}) returned an empty line`);
  }
});

test('describeChain renders mainnet and testnet distinctly, and names the fallback', () => {
  assert.equal(describeChain(1), '1 Ethereum (mainnet)');
  assert.equal(describeChain(8453), '8453 Base (mainnet)');
  assert.equal(describeChain(84532), '84532 Base Sepolia (testnet)');
  assert.equal(describeChain(null), 'unknown chain, using FORK_RPC');
  assert.match(describeChain(999999), /unknown chain 999999/);
});

// ── isMainnet: exactly 1 and 8453 ───────────────────────────────────────────

// `mainnet: true` is what makes the tx relay demand BOTH grant.allow_mainnet AND
// confirm_mainnet (send.ts). It is a SAFETY flag, not a network label: a chain
// carrying real user funds must be on it. Ticko 84256 is Mainnet (Beta) and the
// bounty page states it uses real funds, so it belongs here - the invariant is
// "real funds implies double confirm", and only the id list was ever a snapshot.
test('isMainnet covers every chain that carries real funds', () => {
  const mainnet = Object.values(CHAINS)
    .filter((c) => c.mainnet)
    .map((c) => c.id)
    .sort((a, b) => a - b);
  assert.deepEqual(mainnet, [1, 8453, 84256]);
  assert.equal(isMainnet(84256), true, 'Ticko Mainnet (Beta) holds real funds');
  assert.equal(isMainnet(1), true);
  assert.equal(isMainnet(8453), true);
  assert.equal(isMainnet(84532), false);
  assert.equal(isMainnet(11155111), false);
  assert.equal(isMainnet(31337), false);
  assert.equal(isMainnet(null), false);
  assert.equal(isMainnet(undefined), false);
  assert.equal(isMainnet(999999), false);
});
