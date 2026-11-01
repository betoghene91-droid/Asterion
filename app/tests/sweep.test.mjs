/**
 * Sweep bot tests.
 *
 * The two claims worth testing are the ones that silently break:
 *
 *   1. DERIVATION. If sha256(passphrase) -> address is subtly wrong, every lookup
 *      returns "empty" forever and the bot looks healthy while doing nothing. The
 *      vector is checked against addresses this project already confirmed exist
 *      ON CHAIN, so the test is corroborated by something outside this code.
 *
 *   2. THE OWNER RULE. Lamports live in any account, and only the System Program
 *      lets a keypair debit its own. So `isSpendable` must reject a funded,
 *      program-owned account — that exact mistake once reported $27.80 of a
 *      program's rent as money.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { deriveAddress, isSpendable, candidateAt, candidateSpace, SWEEP_DEST, BASE_FEE } =
  await import('../build/desk/sweep.js');
const { isSolanaPubkey } = await import('../build/solana.js');
const { SYSTEM_PROGRAM } = await import('../build/solana.js');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const REGISTER_PROGRAM = 'FWs57YWEkULEPu7a3VSUoFQMyatrqoNrDu1CeBwiejQe';

test('derivation reproduces addresses confirmed on chain', async () => {
  // These three are real accounts on Solana mainnet, found during this work.
  // If the derivation drifts, this fails instead of silently finding nothing.
  const vectors = [
    ['test', '7zJEPT7K2jno6BZid1V5EsrnG9kGdk1YAYMBAdDiRzYP'],
    ['admin', 'FyYA2nnz9XfzAN3kcbHT3MVw31VGoxffz6m9REJRSKve'],
    ['bruce', 'DhXPtw3MNDFXCuXnHizpczRvSELtsTJtaSSVgq2JRUSE'],
  ];
  for (const [pw, want] of vectors) {
    assert.equal(await deriveAddress(pw), want, `sha256(${pw}) must derive ${want}`);
  }
});

test('every derived address is a valid 32-byte base58 pubkey', async () => {
  for (let i = 0; i < 40; i++) {
    const a = await deriveAddress(candidateAt(i));
    assert.ok(isSolanaPubkey(a), `${candidateAt(i)} -> ${a} is not a valid pubkey`);
    assert.ok(a.length >= 32 && a.length <= 44);
  }
});

test('candidate stream is deterministic and covers its space', () => {
  assert.equal(candidateAt(0), candidateAt(0));
  assert.notEqual(candidateAt(0), candidateAt(1));
  const space = candidateSpace();
  assert.ok(space > 1000, 'space should be large enough to be worth walking');
  // The cursor wraps, so index space and space must agree modulo.
  assert.equal(candidateAt(space), candidateAt(0));
});

test('the owner rule: a funded program account is NOT spendable', () => {
  // Regression test for the bug that produced a wrong $27.80. All three of these
  // have lamports but cannot be debited by the key that owns the address.
  const programOwned = { lamports: 192_328_300, owner: REGISTER_PROGRAM, space: 460 };
  assert.equal(isSpendable(programOwned), false);

  const tokenAccount = { lamports: 2_039_280, owner: TOKEN_PROGRAM, space: 165 };
  assert.equal(isSpendable(tokenAccount), false);

  // A nonce is system-owned but its lamports belong to its authority, so space
  // must be 0 as well. This is the case a "system-owned == ours" check misses.
  const nonce = { lamports: 1_382_387, owner: SYSTEM_PROGRAM, space: 80 };
  assert.equal(isSpendable(nonce), false);

  // A plain wallet, which IS ours to spend.
  const wallet = { lamports: 50_000_000, owner: SYSTEM_PROGRAM, space: 0 };
  assert.equal(isSpendable(wallet), true);

  // Too small to be worth the fee: must not count, or the sweep moves dust at a loss.
  const dust = { lamports: BASE_FEE, owner: SYSTEM_PROGRAM, space: 0 };
  assert.equal(isSpendable(dust), false);

  assert.equal(isSpendable(null), false);
});

test('destination is a valid pubkey and is the operator wallet', () => {
  assert.ok(isSolanaPubkey(SWEEP_DEST));
  assert.equal(SWEEP_DEST, 'GHqQ8eYLc3Q4nL2gwncJyimz7UM5tpcoqpeH7PyNEx6p');
});
