/**
 * Dust / rent tests.
 *
 * The claim under test is narrow but the failure mode is expensive: closing a
 * token account that still holds tokens DESTROYS them, because `CloseAccount`
 * returns the SOL but not the tokens. So "closable" must be balance-zero AND
 * worth-more-than-the-fee, never one alone.
 *
 * The rent constant is checked against the real value because a wrong one turns
 * an "is this worth it" gate into a silent skip of every profitable account.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { TOKEN_ACCOUNT_RENT, renderDust } = await import('../build/desk/dust.js');
const { SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM, SYSTEM_PROGRAM } = await import('../build/solana.js');

test('rent constant matches the on-chain rent-exempt minimum', () => {
  // 165-byte SPL token account. Confirmed by reading a real account's lamports.
  assert.equal(TOKEN_ACCOUNT_RENT, 2_039_280);
  // Sanity: the deposit must be larger than the fee, or closing loses money.
  assert.ok(TOKEN_ACCOUNT_RENT > 5000);
});

test('program ids are the real ones', () => {
  assert.equal(SPL_TOKEN_PROGRAM, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  assert.equal(SPL_TOKEN_2022_PROGRAM, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.equal(SYSTEM_PROGRAM, '11111111111111111111111111111111');
});

test('render is honest about accounts that still hold tokens', () => {
  const out = renderDust({
    wallets_scanned: 3,
    accounts_seen: 7,
    closable: 2,
    clamped_tokens: 5,
    reclaimable_lamports: 4_068_560,
    reclaimed_lamports: 0,
    ticks: 1,
  });
  // 4,068,560 lamports is 0.00406856 SOL (2 accounts' rent minus one fee each).
  // Rendered at 9 decimals on purpose: at 6, two lamports of real rent vanish.
  const expectSol = (4_068_560 / 1e9).toFixed(9);
  assert.ok(out.includes(`${expectSol} SOL recoverable`), `expected ${expectSol} in:\n${out}`);
  // It must say HOW MANY are still holding tokens, not imply everything is closable.
  assert.match(out, /5 accounts still hold tokens/);
});
