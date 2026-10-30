/**
 * Address families and chain-name resolution for target candidates.
 *
 * The failures these tests prevent are both silent:
 *
 *   · running the EVM regex over a Solana address makes 248 real Solana
 *     protocols disappear into a "malformed" counter nobody reads;
 *   · resolving a chain by "close enough" puts a BSC address on chain 8453, and
 *     `policy.ts` then authorises a fork of the wrong chain — the exact class of
 *     bug `chains.ts` was written to remove.
 *
 * The pubkeys and hex addresses used below are REAL ones taken from live feeds
 * (DeFiLlama, CoinGecko Base list); a synthetic string would not exercise the
 * base58 decoder that makes the Solana check meaningful.
 *
 * Run with: node --test tests/targets-address.test.mjs   (after `npm run build`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addressFamily,
  isEvmAddress,
  isSvmAddress,
  splitChainPrefixedAddress,
} from '../build/targets/address.js';
import {
  familyFor,
  normaliseChainName,
  resolveAddressPrefix,
  resolveChainId,
  resolveChainName,
} from '../build/targets/chain-map.js';
import { CHAINS } from '../build/chains.js';

// ── real addresses from the live feeds ──────────────────────────────────────
const EVM_LOWER = '0x7f65323e468939073ef3b5287c73f13951b0ff5b'; // Blue, Base list
const EVM_CHECKSUM = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee'; // Aero Slipstream
const SVM_1 = 'CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu'; // Sanctum Validator LSTs
const SVM_2 = 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS'; // Kamino Lend
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// ── EVM grammar ─────────────────────────────────────────────────────────────

test('a 20-byte hex address is EVM in either casing', () => {
  assert.equal(isEvmAddress(EVM_LOWER), true);
  assert.equal(isEvmAddress(EVM_CHECKSUM), true);
  assert.equal(addressFamily(EVM_CHECKSUM), 'evm');
});

test('EVM rejects anything that is not exactly 0x + 40 hex digits', () => {
  // Each of these is a real near-miss shape from the feeds or a plausible typo.
  const bad = [
    EVM_LOWER.slice(0, -1), // 39 digits
    `${EVM_LOWER}0`, // 41 digits
    `0x${EVM_LOWER}`, // double prefix
    EVM_LOWER.toUpperCase().replace('0X', '0x').replace('0x', '0X'), // 0X prefix
    ` ${EVM_LOWER}`, // leading space
    `${EVM_LOWER}\n`, // trailing newline
    '0x',
    '',
    '0xZZZ',
  ];
  for (const s of bad) {
    assert.equal(isEvmAddress(s), false, `should reject ${JSON.stringify(s)}`);
  }
  for (const notString of [null, undefined, 42, {}, []]) {
    assert.equal(isEvmAddress(notString), false);
  }
});

// ── SVM grammar ─────────────────────────────────────────────────────────────

test('base58 pubkeys are SVM, and the all-ones System Program is one too', () => {
  assert.equal(isSvmAddress(SVM_1), true);
  assert.equal(isSvmAddress(SVM_2), true);
  // 32 zero bytes is a REAL program id, not a missing value: a "looks empty"
  // short-circuit would wrongly reject it.
  assert.equal(isSvmAddress(SYSTEM_PROGRAM), true);
  assert.equal(addressFamily(SVM_1), 'svm');
});

test('SVM rejects base58-LOOKING strings that do not decode to 32 bytes', () => {
  // The critical case: 44 chars of `l` is the right length and decodes to
  // nothing. A `length >= 32` check would accept it.
  assert.equal(isSvmAddress('l'.repeat(44)), false);
  // Base58 excludes 0, O, I and l — an EVM address must never pass.
  assert.equal(isSvmAddress(EVM_LOWER), false);
  assert.equal(isSvmAddress(EVM_LOWER.slice(2)), false);
  assert.equal(isSvmAddress(''), false);
  assert.equal(isSvmAddress('tooShort'), false);
  for (const notString of [null, undefined, 1, {}]) assert.equal(isSvmAddress(notString), false);
});

test('the two families are disjoint, so addressFamily has exactly one answer', () => {
  // A string that could pass both would make "which family" ambiguous, and the
  // validator order in address.ts would silently decide it.
  for (const s of [EVM_LOWER, EVM_CHECKSUM, SVM_1, SVM_2, SYSTEM_PROGRAM]) {
    const isEvm = isEvmAddress(s);
    const isSvm = isSvmAddress(s);
    assert.equal(isEvm && isSvm, false, `${s} must not be both families`);
    assert.equal(addressFamily(s), isEvm ? 'evm' : 'svm');
  }
  assert.equal(addressFamily('not-an-address'), null);
});

// ── DeFiLlama prefix splitting ──────────────────────────────────────────────

test('a chain-prefixed address splits on the FIRST colon only', () => {
  assert.deepEqual(splitChainPrefixedAddress(`base:${EVM_CHECKSUM}`), {
    prefix: 'base',
    body: EVM_CHECKSUM,
  });
  assert.deepEqual(splitChainPrefixedAddress(`solana:${SVM_1}`), {
    prefix: 'solana',
    body: SVM_1,
  });
});

test('a body containing its own colons keeps them (Sui/Aptos style ids)', () => {
  // Real: `sui:0x2::sui::SUI`. Only the prefix separator is a separator.
  const sui = splitChainPrefixedAddress('sui:0x2::sui::SUI');
  assert.equal(sui.prefix, 'sui');
  assert.equal(sui.body, '0x2::sui::SUI');
});

test('a BARE address reports prefix null, not a guessed chain', () => {
  // 1166 DeFiLlama addresses have no prefix at all; treating the absence as a
  // chain would be the whole bug this module exists to avoid.
  assert.deepEqual(splitChainPrefixedAddress(EVM_LOWER), { prefix: null, body: EVM_LOWER });
  assert.equal(splitChainPrefixedAddress('')?.prefix, undefined);
  assert.equal(splitChainPrefixedAddress('   '), null);
  assert.equal(splitChainPrefixedAddress(null), null);
  assert.equal(splitChainPrefixedAddress(undefined), null);
});

test('an empty prefix is treated as absent rather than as a chain named ""', () => {
  const r = splitChainPrefixedAddress(`:${EVM_LOWER}`);
  assert.equal(r?.prefix, null);
  assert.equal(r?.body, EVM_LOWER);
});

test('an empty body survives the split so the validator, not the splitter, rejects it', () => {
  // `base:` is a real shape for a protocol with no published address. The
  // splitter's job is to report the pieces; deciding it is invalid is
  // addressFamily's job.
  const r = splitChainPrefixedAddress('base:');
  assert.equal(r?.prefix, 'base');
  assert.equal(r?.body, '');
  assert.equal(addressFamily(r.body), null);
});

// ── chain-name resolution ───────────────────────────────────────────────────

test('registry names resolve to their own ids, derived from CHAINS', () => {
  for (const spec of Object.values(CHAINS)) {
    const r = resolveChainName(spec.name);
    assert.equal(r.kind, 'evm', `${spec.name} must resolve`);
    if (r.kind === 'evm') assert.equal(r.chain_id, spec.id);
  }
});

test('name resolution is case- and whitespace-insensitive', () => {
  for (const spelling of ['Base', 'base', 'BASE', '  Base  ', 'base ']) {
    const r = resolveChainName(spelling);
    assert.equal(r.kind, 'evm');
    if (r.kind === 'evm') assert.equal(r.chain_id, 8453);
  }
  assert.equal(normaliseChainName('  Base  Sepolia '), 'base sepolia');
  assert.equal(normaliseChainName('   '), null);
  assert.equal(normaliseChainName(null), null);
});

test('"Multi-Chain" is NOT a chain — it describes the protocol, not the address', () => {
  // 1904 DeFiLlama entries say this and 1042 of them carry an address. Turning
  // it into a chain id would file 1042 targets on a chain that does not exist.
  for (const s of ['Multi-Chain', 'multichain', 'MULTI-CHAIN', ' Multi-Chain ']) {
    assert.equal(resolveChainName(s).kind, 'not-a-chain', `${s} must not resolve`);
  }
});

test('a null or empty chain field is "absent", distinct from "not a chain"', () => {
  // 1537 entries have chain: null. The two outcomes land in different counters
  // so a feed change is visible, which is why they are not collapsed.
  assert.equal(resolveChainName(null).kind, 'absent');
  assert.equal(resolveChainName(undefined).kind, 'absent');
  assert.equal(resolveChainName('').kind, 'absent');
  assert.equal(resolveChainName('Multi-Chain').kind, 'not-a-chain');
});

test('chains outside the registry are reported by the name the source used', () => {
  // 240 distinct names are dropped. These are the top six by volume, and each
  // must come back verbatim so the operator can decide whether to register it.
  const cases = [
    ['bsc', 'bsc'],
    ['arbitrum', 'arbitrum'],
    ['avax', 'avax'],
    ['fantom', 'fantom'],
    ['polygon', 'polygon'],
    ['robinhood', 'robinhood'],
  ];
  for (const [input, expected] of cases) {
    const r = resolveChainName(input);
    assert.equal(r.kind, 'unregistered', `${input} is not in CHAINS`);
    if (r.kind === 'unregistered') assert.equal(r.name, expected);
  }
});

test('bare "sepolia" is ambiguous and refuses to resolve', () => {
  // Base Sepolia (84532) and Ethereum Sepolia (11155111) are different chains
  // that can hold colliding addresses. A bare "sepolia" has not said which.
  const r = resolveChainName('sepolia');
  assert.equal(r.kind, 'ambiguous');
  // ...but the qualified forms DO resolve, to different chains.
  const baseSep = resolveChainName('Base Sepolia');
  const ethSep = resolveChainName('Ethereum Sepolia');
  assert.equal(baseSep.kind, 'evm');
  assert.equal(ethSep.kind, 'evm');
  if (baseSep.kind === 'evm' && ethSep.kind === 'evm') {
    assert.equal(baseSep.chain_id, 84532);
    assert.equal(ethSep.chain_id, 11155111);
    assert.notEqual(baseSep.chain_id, ethSep.chain_id);
  }
});

test('a numeric chain id is only a chain when CHAINS carries it', () => {
  const base = resolveChainId(8453);
  assert.equal(base.kind, 'evm');
  if (base.kind === 'evm') assert.equal(base.chain_id, 8453);

  // 56 is BNB Chain: real, but not forkable here, so it is unregistered and
  // named as a chainId for the drop report.
  const bnb = resolveChainId(56);
  assert.equal(bnb.kind, 'unregistered');
  if (bnb.kind === 'unregistered') assert.equal(bnb.name, 'chainId:56');

  for (const bad of ['8453', null, undefined, 8453.5, NaN, Infinity]) {
    assert.equal(resolveChainId(bad).kind, 'absent', `${String(bad)} is not a chain id`);
  }
});

test('every chain id this module can emit is a key of CHAINS', () => {
  // The invariant the whole module rests on. Enumerated rather than assumed.
  const candidates = [1, 8453, 84532, 11155111, 31337];
  for (const id of candidates) {
    const r = resolveChainId(id);
    assert.equal(r.kind, 'evm');
    assert.ok(Object.hasOwn(CHAINS, id), `${id} must be in CHAINS`);
  }
  // A plausible-but-absent id must NOT resolve.
  for (const id of [0, 10, 42161, 137, 56, 43114, 999999]) {
    assert.equal(resolveChainId(id).kind, 'unregistered', `${id} must not resolve`);
  }
});

test('Solana resolves as a FAMILY, never as a chain id', () => {
  const byName = resolveChainName('Solana');
  assert.equal(byName.kind, 'svm');
  const byPrefix = resolveAddressPrefix('solana');
  assert.equal(byPrefix.kind, 'svm');
  // It is deliberately not in the numeric registry, so no id can be invented.
  for (const id of Object.values(CHAINS)) {
    assert.notEqual(id.name.toLowerCase(), 'solana');
  }
});

test('familyFor maps each resolution kind to a family or null', () => {
  assert.equal(familyFor({ kind: 'evm', chain_id: 1, name: 'Ethereum' }), 'evm');
  assert.equal(familyFor({ kind: 'svm', name: 'Solana' }), 'svm');
  assert.equal(familyFor({ kind: 'unregistered', name: 'bsc' }), null);
  assert.equal(familyFor({ kind: 'not-a-chain' }), null);
  assert.equal(familyFor({ kind: 'absent' }), null);
});
