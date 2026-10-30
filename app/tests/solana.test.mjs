// Tests for the Solana address/cluster/program vocabulary (app/src/solana.ts).
//
// The validator tests exist because the failure they prevent is silent. Before
// this module, a base58 pubkey typed into a brief matched none of the three
// `/^0x[0-9a-fA-F]{40}$/` checks and fell through to `policy.ts`'s `else`
// branch, which files unknown targets as DOMAIN NAMES. The engagement then
// looks scoped and nothing can ever be cloned. A naive `length === 32` check
// would repeat the same class of mistake one level down: it accepts 44
// characters of `l`, which decodes to nothing.
//
// Run with: node --test tests/solana.test.mjs   (after `npm run build`)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_ERRORS,
  ASSOCIATED_TOKEN_PROGRAM,
  DEFAULT_SOLANA_CLUSTER,
  SOLANA_CLUSTERS,
  SOLANA_CLUSTER_NAMES,
  SPL_TOKEN_2022_PROGRAM,
  SPL_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  WELL_KNOWN_PROGRAMS,
  clusterSpec,
  decodeBase58,
  describeCluster,
  encodeBase58,
  explainProgramError,
  isCustomProgramError,
  isSolanaMainnet,
  isSolanaPubkey,
  parseSolanaToken,
  planValidatorClones,
} from '../build/solana.js';

// ─── real 32-byte pubkeys, taken from mainnet ──────────────────────────────
//
// These are not invented strings: each is a program id whose existence and
// executability was confirmed against https://api.mainnet-beta.solana.com on
// 2026-10-29 via getAccountInfo (see the comment on SPL_TOKEN_PROGRAM).

const REAL_PUBKEYS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  '11111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];

// ─── base58 / pubkey validation ────────────────────────────────────────────

test('a real 32-byte pubkey passes', () => {
  for (const k of REAL_PUBKEYS) {
    assert.equal(isSolanaPubkey(k), true, `${k} should be a valid pubkey`);
  }
});

test('the System Program id — 32 zero bytes, all ones — is valid, not "empty"', () => {
  // The tempting bug: treat a string of '1's as a missing value. It is a real
  // program, and a validator that rejected it would refuse to prove any
  // transaction that touches it.
  assert.equal(isSolanaPubkey(SYSTEM_PROGRAM), true);
  const decoded = decodeBase58(SYSTEM_PROGRAM);
  assert.ok(decoded);
  assert.equal(decoded.bytes.length, 32);
  assert.ok(decoded.bytes.every((b) => b === 0), 'System Program must decode to 32 zero bytes');
});

test('a 31-byte pubkey fails', () => {
  // Take a real key and drop one character: decodes to fewer than 32 bytes.
  const k = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5D';
  const decoded = decodeBase58(k);
  assert.ok(decoded, 'the truncated string is still valid base58');
  assert.notEqual(decoded.bytes.length, 32, 'fixture must decode to something other than 32 bytes');
  assert.equal(isSolanaPubkey(k), false);
});

test('a 33-byte pubkey fails', () => {
  // 33 zero bytes encodes to 33 '1' characters, which is NOT a pubkey.
  const k = '1'.repeat(33);
  const decoded = decodeBase58(k);
  assert.ok(decoded);
  assert.equal(decoded.bytes.length, 33);
  assert.equal(isSolanaPubkey(k), false);
});

test('any string containing 0, O, I or l fails', () => {
  const base = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  for (const bad of ['0', 'O', 'I', 'l']) {
    // Replace a character in the middle so the length stays plausible; a
    // length check alone would still accept it.
    const mutated = base.slice(0, 20) + bad + base.slice(21);
    assert.equal(mutated.length, base.length, 'the mutation must preserve length');
    assert.equal(decodeBase58(mutated), null, `${bad} must be rejected by the decoder`);
    assert.equal(isSolanaPubkey(mutated), false, `a pubkey containing ${bad} must fail`);
  }
});

test('a 44-character string of "l" fails — length is not a decode', () => {
  // This is the exact case a `length === 32 || length === 44` check would let
  // through. It is the reason isSolanaPubkey decodes instead of measuring.
  const k = 'l'.repeat(44);
  assert.equal(k.length, 44);
  assert.equal(isSolanaPubkey(k), false);
});

test('a 0x EVM address fails', () => {
  assert.equal(
    isSolanaPubkey('0x0000000000000000000000000000000000000000'),
    false,
    'a 20-byte EVM address is not a Solana pubkey',
  );
  // And a 40-hex string without the prefix (the '0' is still out of alphabet).
  assert.equal(isSolanaPubkey('0000000000000000000000000000000000000000'), false);
});

test('the empty string fails, and so does a non-string', () => {
  assert.equal(isSolanaPubkey(''), false);
  assert.equal(isSolanaPubkey(null), false);
  assert.equal(isSolanaPubkey(undefined), false);
  assert.equal(isSolanaPubkey(12345), false);
});

test('base58 round-trips through encode/decode', () => {
  for (const k of REAL_PUBKEYS) {
    const d = decodeBase58(k);
    assert.ok(d, `${k} must decode`);
    assert.equal(encodeBase58(d.bytes), k, `${k} must round-trip`);
  }
  // Explicit leading-zero handling: zero bytes must come back as '1'.
  const zeros = new Uint8Array([0, 0, 0, 1, 2, 3]);
  assert.equal(encodeBase58(zeros), '111' + encodeBase58(new Uint8Array([1, 2, 3])));
  const back = decodeBase58(encodeBase58(zeros));
  assert.ok(back);
  assert.deepEqual([...back.bytes], [...zeros]);
});

// ─── genesis hashes ────────────────────────────────────────────────────────

test('the three genesis hashes are distinct and 32-byte base58', () => {
  const hashes = SOLANA_CLUSTER_NAMES.map((n) => SOLANA_CLUSTERS[n].genesis_hash);
  assert.equal(hashes.length, 3);
  assert.equal(new Set(hashes).size, 3, 'genesis hashes must be distinct — a duplicate would make two clusters indistinguishable');

  for (const h of hashes) {
    // SPEC says "length-64 hex"; the real value is base58 over 32 bytes, so the
    // honest assertion is: same length as the live values (44 chars), a valid
    // 32-byte pubkey encoding, and NOT hex (hex is the EVM idiom and asserting
    // it would be asserting a falsehood about the format).
    assert.equal(typeof h, 'string');
    assert.ok(isSolanaPubkey(h), `${h} must decode to 32 bytes`);
    assert.equal(h.length, 44, `${h} must be 44 base58 characters`);
    assert.match(h, /^[1-9A-HJ-NP-Za-km-z]{44}$/, `${h} must be base58 (no 0/O/I/l)`);
  }
});

test('genesis hashes match the values verified live from each cluster RPC', () => {
  // Literals below are the responses from getGenesisHash on 2026-10-29. They
  // are repeated here deliberately: the workflow hardcodes the same three
  // strings in bash (it cannot import TypeScript), and this test is what makes
  // a divergence between the two copies fail loudly instead of forking the
  // wrong cluster.
  assert.equal(SOLANA_CLUSTERS['mainnet-beta'].genesis_hash, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  assert.equal(SOLANA_CLUSTERS.devnet.genesis_hash, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  assert.equal(SOLANA_CLUSTERS.testnet.genesis_hash, '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY');
});

// ─── clusters ──────────────────────────────────────────────────────────────

test('every cluster declares an rpc env name, a default endpoint and mainnet flag', () => {
  for (const n of SOLANA_CLUSTER_NAMES) {
    const c = SOLANA_CLUSTERS[n];
    assert.equal(c.name, n);
    assert.match(c.rpc_env, /^SOLANA_RPC_/, `${n}: rpc_env must name a secret`);
    assert.match(c.default_rpc, /^https:\/\/api\.[a-z.-]+\.solana\.com$/, `${n}: default_rpc must be an official endpoint`);
    assert.equal(typeof c.mainnet, 'boolean');
    assert.equal(typeof c.label, 'string');
    assert.ok(c.label.length > 5);
  }
});

test('only mainnet-beta is mainnet', () => {
  assert.equal(SOLANA_CLUSTERS['mainnet-beta'].mainnet, true);
  assert.equal(SOLANA_CLUSTERS.devnet.mainnet, false);
  assert.equal(SOLANA_CLUSTERS.testnet.mainnet, false);
  assert.equal(isSolanaMainnet('mainnet-beta'), true);
  assert.equal(isSolanaMainnet('mainnet'), true, 'the shorthand must resolve to mainnet-beta');
  assert.equal(isSolanaMainnet('devnet'), false);
  assert.equal(isSolanaMainnet(null), false);
});

test('rpc env names are distinct so a cluster cannot borrow another secret', () => {
  const envs = SOLANA_CLUSTER_NAMES.map((n) => SOLANA_CLUSTERS[n].rpc_env);
  assert.equal(new Set(envs).size, envs.length);
});

// ─── parseSolanaToken ──────────────────────────────────────────────────────

test('parseSolanaToken reads an explicit cluster pin', () => {
  assert.equal(parseSolanaToken('cluster:devnet'), 'devnet');
  assert.equal(parseSolanaToken('cluster=mainnet-beta'), 'mainnet-beta');
  assert.equal(parseSolanaToken('cluster:MAINNET'), 'mainnet-beta');
  assert.equal(parseSolanaToken('cluster=MAINNET_BETA'), 'mainnet-beta', 'underscore spelling must normalise');
  assert.equal(parseSolanaToken('solana:testnet'), 'testnet');
  assert.equal(parseSolanaToken('notes say cluster_name=devnet ok'), 'devnet');
});

test('parseSolanaToken refuses to read a cluster out of prose or a compound word', () => {
  assert.equal(parseSolanaToken(''), null);
  assert.equal(parseSolanaToken(null), null);
  assert.equal(parseSolanaToken('deployed on devnet yesterday'), null, 'a bare mention is not a pin');
  assert.equal(parseSolanaToken('crosschain:devnet'), null, 'a compound word must not match');
  assert.equal(parseSolanaToken('cluster:mainnet-gamma'), null, 'an unknown cluster must not resolve');
  assert.equal(parseSolanaToken('cluster:'), null);
});

test('cluster descriptions are never empty and always name the rpc source', () => {
  for (const n of SOLANA_CLUSTER_NAMES) {
    const d = describeCluster(n);
    assert.ok(d.includes(n), `${n}: description must name the cluster`);
    assert.ok(d.includes(SOLANA_CLUSTERS[n].rpc_env), `${n}: description must name the rpc env`);
    assert.ok(/mainnet|testnet/.test(d));
  }
  // Absent and unknown must be DISTINGUISHABLE, not both blank.
  const absent = describeCluster(null);
  assert.ok(absent.includes(DEFAULT_SOLANA_CLUSTER), 'absent must name the default it will use');
  const unknown = describeCluster('solana-future');
  assert.ok(unknown.includes('solana-future'));
  assert.ok(/unknown/i.test(unknown), 'an unknown cluster must be refused, not defaulted');
});

// ─── program ids ───────────────────────────────────────────────────────────

test('the three required program ids are valid base58 32-byte pubkeys', () => {
  for (const [name, id] of [
    ['SPL_TOKEN_PROGRAM', SPL_TOKEN_PROGRAM],
    ['SYSTEM_PROGRAM', SYSTEM_PROGRAM],
    ['ASSOCIATED_TOKEN_PROGRAM', ASSOCIATED_TOKEN_PROGRAM],
    ['SPL_TOKEN_2022_PROGRAM', SPL_TOKEN_2022_PROGRAM],
  ]) {
    assert.equal(isSolanaPubkey(id), true, `${name}=${id} must be a real pubkey`);
    assert.ok(WELL_KNOWN_PROGRAMS[id], `${name} must have a human label`);
  }
});

test('the program ids are distinct — a copy-paste slip would be silent otherwise', () => {
  const ids = [SPL_TOKEN_PROGRAM, SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM];
  assert.equal(new Set(ids).size, ids.length);
});

// ─── anchor error table ────────────────────────────────────────────────────

test('ANCHOR_ERRORS carries the codes that decide what a failed PoC means', () => {
  // The four that matter most: signer present, seeds enforced, ownership
  // wrong, account uninitialised (a fixture bug, never a finding).
  assert.equal(ANCHOR_ERRORS.ConstraintSigner.code, 2002);
  assert.equal(ANCHOR_ERRORS.AccountNotSigner.code, 3010);
  assert.equal(ANCHOR_ERRORS.ConstraintSeeds.code, 2006);
  assert.equal(ANCHOR_ERRORS.AccountNotInitialized.code, 3012);
  assert.equal(ANCHOR_ERRORS.AccountOwnedByWrongProgram.code, 3007);
  assert.equal(ANCHOR_ERRORS.AccountDiscriminatorMismatch.code, 3002);
  assert.equal(ANCHOR_ERRORS.InvalidProgramId.code, 3008);
  assert.equal(ANCHOR_ERRORS.RequireViolated.code, 2500);
  assert.equal(ANCHOR_ERRORS.InstructionFallbackNotFound.code, 101);
});

test('every ANCHOR_ERRORS entry explains the code and says what it implies', () => {
  for (const [name, e] of Object.entries(ANCHOR_ERRORS)) {
    assert.equal(typeof e.code, 'number', `${name}: code must be a number`);
    assert.ok(Number.isInteger(e.code) && e.code > 0, `${name}: code must be a positive integer`);
    assert.ok(e.code < 6000, `${name}: built-in codes are below the 6000 user offset`);
    assert.ok(e.meaning.length > 20, `${name}: meaning is too thin to help an operator`);
    assert.ok(e.implication.length > 20, `${name}: implication is too thin — it is what stops "test failed" being reported as a finding`);
  }
});

test('no two error names share a code', () => {
  const codes = Object.values(ANCHOR_ERRORS).map((e) => e.code);
  assert.equal(new Set(codes).size, codes.length, 'a duplicate code would make explainProgramError ambiguous');
});

test('explainProgramError names a built-in code and refuses to invent a custom one', () => {
  const builtIn = explainProgramError(3010);
  assert.match(builtIn, /AccountNotSigner/);
  assert.match(builtIn, /3010/);

  // 6000+ is program-defined. Guessing a meaning there is the easiest way to
  // turn "the guard fired" into a fabricated finding, so it must say so.
  const custom = explainProgramError(6001);
  assert.match(custom, /6000/);
  assert.match(custom, /custom program error 6001/);
  assert.match(custom, /do not assume/i);

  assert.equal(isCustomProgramError(6000), true);
  assert.equal(isCustomProgramError(5999), false);
  assert.equal(isCustomProgramError(-1), false);
});

// ─── validator clone planning ──────────────────────────────────────────────

test('planValidatorClones clones the program and says why', () => {
  const p = planValidatorClones(SPL_TOKEN_PROGRAM, 'mainnet-beta');
  assert.deepEqual(p.pubkeys, [SPL_TOKEN_PROGRAM]);
  assert.equal(p.needs_clone, true);
  assert.match(p.note, /no write to mainnet-beta/);
});

test('planValidatorClones refuses a non-pubkey program id', () => {
  const p = planValidatorClones('0x000000000000000000000000000000000000dead', 'mainnet-beta');
  assert.deepEqual(p.pubkeys, []);
  assert.equal(p.needs_clone, false);
  assert.match(p.note, /not a base58 32-byte pubkey/);
});

test('clusterSpec resolves shorthand and rejects unknown names', () => {
  assert.equal(clusterSpec('devnet')?.name, 'devnet');
  assert.equal(clusterSpec('MAINNET')?.name, 'mainnet-beta');
  assert.equal(clusterSpec('mainnet_beta')?.name, 'mainnet-beta');
  assert.equal(clusterSpec('polygon'), null);
  assert.equal(clusterSpec(''), null);
  assert.equal(clusterSpec(null), null);
});
