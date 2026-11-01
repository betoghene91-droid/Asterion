/**
 * Protocol-bug hunter tests.
 *
 * The claim under test is that every finding is READ, not guessed. So these
 * tests drive the decoders with hand-built account bytes where the expected
 * answer is derivable by hand, and then one live-parity case pins a real
 * mainnet authority so a refactor that shifts an offset fails loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  decodeUpgradeable,
  decodeMint,
  renderHunter,
  programDataAddress,
  BPF_LOADER_UPGRADEABLE,
} = await import('../build/desk/hunter.js');

// ────────────────────────────────────────────────────────── fixtures

function fakeKey(fill) {
  return new Uint8Array(32).fill(fill);
}

/** The 36-byte Program account: enum tag 2 + ProgramData address. */
function programAccount(programData) {
  const b = new Uint8Array(36);
  b[0] = 2; // enum tag: Program
  b.set(programData, 4);
  return b;
}

/** ProgramData: enum tag 3 + last-deploy slot + Option<upgrade authority>. */
function programDataAccount(slot, authority) {
  const b = new Uint8Array(authority ? 45 : 13);
  b[0] = 3; // enum tag: ProgramData
  let s = BigInt(slot);
  for (let i = 0; i < 8; i++) {
    b[4 + i] = Number(s & 0xffn);
    s >>= 8n;
  }
  b[12] = authority ? 1 : 0; // Option::Some / Option::None
  if (authority) b.set(authority, 13);
  return b;
}

/** An 82-byte SPL mint. */
function mintAccount(opts = {}) {
  const b = new Uint8Array(82);
  if (opts.mintAuthority) {
    b[0] = 1;
    b.set(opts.mintAuthority, 4);
  }
  let s = opts.supply ?? 0n;
  for (let i = 0; i < 8; i++) {
    b[36 + i] = Number(s & 0xffn);
    s >>= 8n;
  }
  b[44] = opts.decimals ?? 9;
  b[45] = 1; // is_initialized
  if (opts.freezeAuthority) {
    b[46] = 1;
    b.set(opts.freezeAuthority, 50);
  }
  return b;
}

const b58 = (bytes) => {
  const AL = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const x of bytes) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) {
    s = AL[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of bytes) {
    if (x === 0) s = '1' + s;
    else break;
  }
  return s;
};

// ────────────────────────────────────────────────────────── upgrade decode

test('programDataAddress finds the pointer without needing ProgramData', () => {
  // Regression: the tick used to pass empty ProgramData into the full decoder to
  // read this pointer. The decoder demanded 13 bytes of ProgramData, returned
  // null for the probe, and every program was silently skipped — a clean zero.
  const pd = fakeKey(7);
  assert.equal(programDataAddress(programAccount(pd)), b58(pd));
  assert.equal(programDataAddress(new Uint8Array(10)), null);
});

test('decodes a live upgrade authority from Program + ProgramData bytes', () => {
  const pd = fakeKey(7);
  const auth = fakeKey(9);
  const info = decodeUpgradeable('Prog111', programAccount(pd), programDataAccount(277_000_000, auth));
  assert.ok(info);
  assert.equal(info.upgradeable, true);
  assert.equal(info.slot, 277_000_000);
  assert.ok(info.authority, 'authority must be present');
  // The authority is the pubkey sitting at [13..45) of ProgramData.
  assert.equal(info.authority, b58(auth));
});

test('a revoked authority reads as immutable, not as missing evidence', () => {
  const info = decodeUpgradeable('Prog111', programAccount(fakeKey(7)), programDataAccount(1, null));
  assert.ok(info);
  assert.equal(info.upgradeable, false);
  assert.equal(info.authority, null);
});

test('a non-Program tag does not decode as an upgradeable program', () => {
  const prog = programAccount(fakeKey(7));
  prog[0] = 99;
  assert.equal(decodeUpgradeable('Prog111', prog, programDataAccount(1, fakeKey(9))), null);
});

test('a truncated ProgramData returns null instead of throwing', () => {
  // 12 bytes: past the tag, one short of the Option tag. A short account from a
  // flaky RPC must degrade to null, never kill the whole tick.
  assert.equal(decodeUpgradeable('Prog111', programAccount(fakeKey(7)), new Uint8Array(12)), null);
});

test('a truncated Program account returns null instead of throwing', () => {
  assert.equal(decodeUpgradeable('Prog111', new Uint8Array(10), programDataAccount(1, fakeKey(9))), null);
});

// ────────────────────────────────────────────────────────── mint decode

test('reads live mint and freeze authorities', () => {
  const m = decodeMint(
    mintAccount({ mintAuthority: fakeKey(3), freezeAuthority: fakeKey(4), supply: 1_000_000n, decimals: 6 }),
  );
  assert.ok(m);
  assert.ok(m.mintAuthority);
  assert.ok(m.freezeAuthority);
  assert.equal(m.supply, 1_000_000n);
  assert.equal(m.decimals, 6);
});

test('a renounced mint reports null, not a zeroed key', () => {
  const m = decodeMint(mintAccount({}));
  assert.ok(m);
  // null is "renounced"; the all-zero key would be a real address. Conflating
  // them would report a safely-renounced token as still mintable.
  assert.equal(m.mintAuthority, null);
  assert.equal(m.freezeAuthority, null);
});

test('a non-1 Option tag on the mint authority is treated as no authority', () => {
  const b = mintAccount({});
  b[0] = 2;
  const m = decodeMint(b);
  assert.ok(m);
  assert.equal(m.mintAuthority, null);
});

test('an account too short to be a mint is rejected outright', () => {
  assert.equal(decodeMint(new Uint8Array(50)), null);
});

// ────────────────────────────────────────────────────────── honesty

test('renderHunter says "nothing looked at" instead of a confident zero', () => {
  const stats = {
    programsChecked: 0,
    mintsChecked: 0,
    findings: 0,
    unreadable: 0,
    noInputs: true,
    ticks: 1,
    lastTickMs: 1,
  };
  const text = renderHunter(stats, []);
  assert.match(text, /NONE/);
  assert.match(text, /nothing looked at/i);
});

test('renderHunter flags unreadable accounts as NOT clean', () => {
  const stats = {
    programsChecked: 2,
    mintsChecked: 0,
    findings: 0,
    unreadable: 3,
    noInputs: false,
    ticks: 1,
    lastTickMs: 1,
  };
  const text = renderHunter(stats, []);
  assert.match(text, /unreadable 3/);
  assert.match(text, /NOT clean/);
});

test('renderHunter counts single-key authorities separately from info rows', () => {
  const findings = [
    {
      id: 'hunt_1',
      ts: 1,
      subject: 'Prog111',
      risk: 'upgrade_authority_plain_key',
      detail: 'upgrade authority is a plain single-key wallet',
      evidenceAccount: 'pd',
      severity: 'medium',
      firstSeen: 1,
    },
    {
      id: 'hunt_2',
      ts: 1,
      subject: 'Prog222',
      risk: 'upgradeable_program',
      detail: 'immutable',
      evidenceAccount: 'pd2',
      severity: 'info',
      firstSeen: 1,
    },
  ];
  const stats = {
    programsChecked: 2,
    mintsChecked: 0,
    findings: 2,
    unreadable: 0,
    noInputs: false,
    ticks: 1,
    lastTickMs: 1,
  };
  assert.match(renderHunter(stats, findings), /\(1 single-key upgrade authorities\)/);
});

// ────────────────────────────────────────────────────────── live parity

/**
 * The decoders are only worth something if they agree with mainnet. Raydium's
 * AMM authority was read from the live cluster while building the bot; pinning
 * it means an offset regression fails here instead of shipping a bot that calls
 * every authority 'unreadable' and therefore reports nothing, forever.
 */
test('decodes the real Raydium AMM upgrade authority from mainnet', async () => {
  const PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  const EXPECTED_AUTH = 'FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK';
  const EXPECTED_PD_PREFIX = 'A7ZG7ByD';

  const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  // The public endpoint rate-limits aggressively, and a throttled read is NOT a
  // decode failure. Retry before concluding anything, or this test becomes a
  // flaky gate that teaches people to ignore it.
  const getAccount = async (addr, tries = 5) => {
    for (let i = 0; i < tries; i++) {
      const res = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [addr, { encoding: 'base64' }],
        }),
      });
      const j = await res.json();
      if (!j.error) return j.result?.value ?? null;
      const msg = String(j.error.message ?? '');
      if (!/rate limit|too many/i.test(msg)) throw new Error(`rpc: ${msg}`);
      await new Promise((r) => setTimeout(r, 2000 + i * 2000));
    }
    throw new Error('rpc: still rate limited after retries');
  };

  const prog = await getAccount(PROGRAM);
  assert.ok(prog, 'RPC must return the Raydium AMM program account');
  assert.equal(prog.owner, BPF_LOADER_UPGRADEABLE);

  const pdAddr = programDataAddress(toBytes(prog.data[0]));
  assert.ok(pdAddr, 'program account must decode to a ProgramData pointer');
  assert.ok(pdAddr.startsWith(EXPECTED_PD_PREFIX));

  const pd = await getAccount(pdAddr);
  assert.ok(pd, 'RPC must return ProgramData');

  const info = decodeUpgradeable(PROGRAM, toBytes(prog.data[0]), toBytes(pd.data[0]));
  assert.ok(info);
  assert.equal(info.upgradeable, true);
  assert.equal(info.authority, EXPECTED_AUTH);
});
