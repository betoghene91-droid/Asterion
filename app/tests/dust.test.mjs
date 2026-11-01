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

// ────────────────────────────────────────────────── the reclaim path

/**
 * These pin the bug that made the operator key worthless.
 *
 * `closeAccountTx` was correct at the byte level and still unsendable: it named
 * the token program by ACCOUNT INDEX 2 while the account at index 2 was the
 * owner's pubkey, so the serialised message pointed the instruction at a wallet
 * instead of a program. Proven on mainnet by simulation:
 *
 *   old shape  -> err: "InvalidProgramForExecution"   (never reaches the token program)
 *   fixed shape -> logs: "Instruction: CloseAccount"  (reaches it, then correctly
 *                  refuses a non-empty account with Custom:11)
 *
 * A unit test cannot see that the runtime rejected it, so the test asserts the
 * structural property that caused it: the program id is the LAST account, the
 * instruction header names that index, and the account list is a plain index
 * run rather than index/flag pairs.
 */
const { closeAccountTx, operatorSeed } = await import('../build/desk/dust.js');

/** Decode a signed legacy transaction built by closeAccountTx into its parts. */
function parseTx(b64) {
  const bin = Buffer.from(b64, 'base64');
  let p = 0;
  const readShortvec = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = bin[p++];
      n |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return n;
  };
  const sigCount = readShortvec();
  p += sigCount * 64;
  const header = { need: bin[p], roSigned: bin[p + 1], roUnsigned: bin[p + 2] };
  p += 3;
  const keyCount = readShortvec();
  const keys = [];
  for (let i = 0; i < keyCount; i++) {
    keys.push(bin.subarray(p, p + 32));
    p += 32;
  }
  p += 32; // blockhash
  const ixCount = readShortvec();
  const ixs = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = bin[p++];
    const acctCount = readShortvec();
    const accounts = [...bin.subarray(p, p + acctCount)];
    p += acctCount;
    const dataLen = readShortvec();
    const data = bin.subarray(p, p + dataLen);
    p += dataLen;
    ixs.push({ programIdIndex, accounts, data: [...data] });
  }
  return { header, keys, ixs };
}

// A deterministic 32-byte seed. Not a real key; nothing is broadcast here.
const SEED = new Uint8Array(32).fill(7);
const OP = 'GHqQ8eYLc3Q4nL2gwncJyimz7UM5tpcoqpeH7PyNEx6p';
const TA = '6Qyogyktd2qeQtUjsBKo12bd44wC3NYQrFXVvMdJNeDa';

test('closeAccountTx names the token program by index, and that index IS the program', async () => {
  const b64 = await closeAccountTx({ seed: SEED }, TA, OP, SPL_TOKEN_2022_PROGRAM);
  assert.ok(b64, 'must build a transaction');
  const tx = parseTx(b64);
  const ix = tx.ixs[0];

  // The instruction must point at the token program, not at a wallet.
  const programBytes = tx.keys[ix.programIdIndex];
  assert.ok(programBytes, 'programIdIndex must be inside the key list');
  const AL = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const x of programBytes) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) {
    s = AL[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of programBytes) {
    if (x === 0) s = '1' + s;
    else break;
  }
  assert.equal(s, SPL_TOKEN_2022_PROGRAM);

  // CloseAccount: three accounts, discriminant 9, nothing else.
  assert.deepEqual(ix.accounts, [1, 2, 0], 'accounts must be token, destination, owner');
  assert.deepEqual(ix.data, [9]);
  // The owner is the only signer and the fee payer.
  assert.equal(tx.header.need, 1);
});

test('closeAccountTx closes against the SPL Token program when asked', async () => {
  const b64 = await closeAccountTx({ seed: SEED }, TA, OP, SPL_TOKEN_PROGRAM);
  const tx = parseTx(b64);
  const programBytes = tx.keys[tx.ixs[0].programIdIndex];
  const AL = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const x of programBytes) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) {
    s = AL[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of programBytes) {
    if (x === 0) s = '1' + s;
    else break;
  }
  // Legacy token accounts must be closed by the LEGACY program; using the
  // 2022 program on a Tokenkeg account fails owner check on chain.
  assert.equal(s, SPL_TOKEN_PROGRAM);
});

test('operatorSeed reads the base58 64-byte form and keeps only the seed', () => {
  // 64 bytes = seed || pubkey, in base58, exactly as a keypair file stores it.
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = (i * 7 + 3) & 0xff;
  const AL = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const x of bytes) n = n * 256n + BigInt(x);
  let enc = '';
  while (n > 0n) {
    enc = AL[Number(n % 58n)] + enc;
    n /= 58n;
  }
  for (const x of bytes) {
    if (x === 0) enc = '1' + enc;
    else break;
  }
  const seed = operatorSeed({ SOLANA_OPERATOR_SECRET_KEY: enc });
  assert.ok(seed);
  assert.equal(seed.length, 32, 'only the seed is used to sign');
  assert.deepEqual([...seed], [...bytes.subarray(0, 32)]);
});

test('operatorSeed accepts the JSON keyfile byte-array form too', () => {
  const arr = Array.from({ length: 64 }, (_, i) => i & 0xff);
  const seed = operatorSeed({ SOLANA_OPERATOR_SECRET_KEY: JSON.stringify(arr) });
  assert.ok(seed);
  assert.deepEqual([...seed], arr.slice(0, 32));
});

test('a missing or unusable operator key returns null, never a zero key', () => {
  // null means "detect-only". A zeroed 32-byte key would SIGN, and would sign
  // with a key that owns nothing — the silent-failure shape this bot is done
  // being. So absence must be null, not a placeholder.
  assert.equal(operatorSeed({}), null);
  assert.equal(operatorSeed({ SOLANA_OPERATOR_SECRET_KEY: '' }), null);
  assert.equal(operatorSeed({ SOLANA_OPERATOR_SECRET_KEY: 'not-base58-!!!' }), null);
  assert.equal(operatorSeed({ SOLANA_OPERATOR_SECRET_KEY: '[1,2,3]' }), null);
});
