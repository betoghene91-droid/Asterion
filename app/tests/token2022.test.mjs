/**
 * Token-2022 extension scanner tests.
 *
 * The claim under test is that every reported capability was READ from the
 * mint's own bytes. So the bulk of these tests drive the decoder with hand-built
 * accounts where the expected answer is derivable by hand — a permanent delegate
 * at a known offset, a frozen default state, a transfer hook with a real program
 * — and then live-parity cases pin real mainnet mints so that a refactor which
 * shifts one offset fails loudly instead of shipping a bot that reports every
 * mint as extension-free, forever.
 *
 * Three properties get their own tests because they are the honesty invariants,
 * and each one is a thing that has actually gone wrong in this codebase before:
 *
 *   1. An all-zero pubkey decodes to `null`, never to `11111111111111111111111111111111`.
 *   2. A truncated payload is NOT reported as if the field were read and were None.
 *   3. A transfer hook with a None program is INERT, not a live honeypot switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  decodeToken2022,
  classifyToken2022,
  selectTransferFeeRates,
  renderToken2022,
  extensionName,
  BASE_ACCOUNT_LENGTH,
  MINT_SIZE,
  ACCOUNT_TYPE_OFFSET,
  TLV_START,
} = await import('../build/desk/token2022.js');

// ────────────────────────────────────────────────────────── fixtures

const AL = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58, so an expectation can name the exact key the fixture planted. */
function b58(bytes) {
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
}

/** A pubkey with every byte the same, so it is obvious in a diff. */
const key = (fill) => new Uint8Array(32).fill(fill);
const ZERO_KEY = new Uint8Array(32);

function u16(v) {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}
function u32(v) {
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) b[i] = (v >>> (8 * i)) & 0xff;
  return b;
}
function u64(v) {
  const b = new Uint8Array(8);
  let n = BigInt(v);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}
function i16(v) {
  return u16(v < 0 ? v + 0x10000 : v);
}

function cat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One TLV entry: u16 LE type, u16 LE length, payload. */
function tlv(type, payload) {
  return cat([u16(type), u16(payload.length), payload]);
}

/**
 * A mint account.
 *
 * The base is always the 82-byte SPL mint, zero-padded out to 165 so the
 * extension region starts at a fixed absolute offset — that padding IS the
 * layout, not a convenience: `BASE_ACCOUNT_LENGTH = Account::LEN = 165`.
 */
function mintBytes(opts = {}) {
  const base = new Uint8Array(opts.baseLength ?? BASE_ACCOUNT_LENGTH);
  if (opts.mintAuthority) {
    base[0] = 1;
    base.set(opts.mintAuthority, 4);
  }
  base.set(u64(opts.supply ?? 0n), 36);
  base[44] = opts.decimals ?? 9;
  base[45] = opts.initialized === false ? 0 : 1;
  if (opts.freezeAuthority) {
    base[46] = 1;
    base.set(opts.freezeAuthority, 50);
  }
  if (opts.accountType === null) return base; // 82..165 bytes, no discriminant

  const typeByte = new Uint8Array([opts.accountType ?? 1]);
  return cat([base, typeByte, ...(opts.extensions ?? [])]);
}

/** TransferFeeConfig payload, 108 bytes, with both schedules explicit. */
function transferFeePayload(o) {
  return cat([
    o.configAuthority ?? ZERO_KEY,
    o.withdrawAuthority ?? ZERO_KEY,
    u64(o.withheldAmount ?? 0n),
    u64(o.olderEpoch ?? 0),
    u64(o.olderMaxFee ?? 0n),
    u16(o.olderBps ?? 0),
    u64(o.newerEpoch ?? 0),
    u64(o.newerMaxFee ?? 0n),
    u16(o.newerBps ?? 0),
  ]);
}

/** TokenMetadata payload, Borsh: two keys then length-prefixed strings. */
function tokenMetadataPayload(o) {
  const str = (s) => {
    const bytes = new TextEncoder().encode(s);
    return cat([u32(bytes.length), bytes]);
  };
  const pairs = o.additional ?? [];
  return cat([
    o.updateAuthority ?? ZERO_KEY,
    o.mint ?? ZERO_KEY,
    str(o.name ?? ''),
    str(o.symbol ?? ''),
    str(o.uri ?? ''),
    u32(pairs.length),
    ...pairs.flatMap(([k, v]) => [str(k), str(v)]),
  ]);
}

// ────────────────────────────────────────────────────────── layout constants

test('the layout constants are the ones the source defines', () => {
  // 165 = Account::LEN = BASE_ACCOUNT_LENGTH; 166 = tlv_start_index;
  // the AccountType byte is 82 + 83 = 165, i.e. the last byte of the base.
  assert.equal(MINT_SIZE, 82);
  assert.equal(BASE_ACCOUNT_LENGTH, 165);
  assert.equal(ACCOUNT_TYPE_OFFSET, 165);
  assert.equal(TLV_START, 166);
  assert.equal(TLV_START, BASE_ACCOUNT_LENGTH + 1);
});

test('the extension ordinals are the repr(u16) values, and unknowns stay visible', () => {
  assert.equal(extensionName(1), 'TransferFeeConfig');
  assert.equal(extensionName(3), 'MintCloseAuthority');
  assert.equal(extensionName(6), 'DefaultAccountState');
  assert.equal(extensionName(9), 'NonTransferable');
  assert.equal(extensionName(12), 'PermanentDelegate');
  assert.equal(extensionName(14), 'TransferHook');
  assert.equal(extensionName(18), 'MetadataPointer');
  assert.equal(extensionName(19), 'TokenMetadata');
  // An ordinal whose layout is not decoded here is still a real extension on a
  // real mint (Pren1F carries 25 and 26). It must not vanish.
  assert.equal(extensionName(25), 'Unknown');
  assert.equal(extensionName(26), 'Unknown');
});

// ────────────────────────────────────────────────────────── required fixtures

test('decodes a permanent delegate planted at [0..32) of its payload', () => {
  const delegate = key(0x11);
  const bytes = mintBytes({ extensions: [tlv(12, delegate)] });
  const info = decodeToken2022(bytes);

  assert.ok(info, 'must decode');
  assert.equal(info.isToken2022Mint, true);
  assert.equal(info.accountType, 1);
  assert.equal(info.extensions.length, 1);
  assert.equal(info.extensions[0].name, 'PermanentDelegate');
  assert.equal(info.extensions[0].dataLength, 32);
  assert.equal(info.extensions[0].truncated, false);
  assert.equal(info.extensions[0].delegate, b58(delegate));

  // The finding says what the delegate can DO, at high severity: it needs no
  // signature from the holder and never expires.
  const findings = classifyToken2022('Mint111', info, 1000);
  const fd = findings.find((f) => f.risk === 'permanent_delegate');
  assert.ok(fd);
  assert.equal(fd.severity, 'high');
  assert.match(fd.detail, /ANY holder/);
  assert.equal(fd.evidenceAccount, 'Mint111');
});

test('an all-zero delegate decodes to null, never to a zeroed address', () => {
  // MaybeNull::NONE == [0u8; 32]. The zero key base58-encodes to a REAL address
  // (the System Program), so printing it would invent a live delegate.
  const info = decodeToken2022(mintBytes({ extensions: [tlv(12, ZERO_KEY)] }));
  assert.ok(info);
  assert.equal(info.extensions[0].delegate, null);
  assert.notEqual(info.extensions[0].delegate, '11111111111111111111111111111111');

  const f = classifyToken2022('Mint111', info, 1000).find((x) => x.risk === 'permanent_delegate');
  assert.ok(f);
  // Inert is info, not high — the extension is there but cannot take anything.
  assert.equal(f.severity, 'info');
});

test('a default-FROZEN mint is high severity; a default-initialized one is not', () => {
  const frozen = decodeToken2022(mintBytes({ extensions: [tlv(6, new Uint8Array([2]))] }));
  assert.ok(frozen);
  assert.equal(frozen.extensions[0].name, 'DefaultAccountState');
  assert.equal(frozen.extensions[0].accountState, 'frozen');
  const fFrozen = classifyToken2022('Mint222', frozen, 1000).find((f) => f.risk === 'default_frozen');
  assert.ok(fFrozen);
  assert.equal(fFrozen.severity, 'high');
  assert.match(fFrozen.detail, /FROZEN/);

  const normal = decodeToken2022(mintBytes({ extensions: [tlv(6, new Uint8Array([1]))] }));
  assert.ok(normal);
  assert.equal(normal.extensions[0].accountState, 'initialized');
  const fNormal = classifyToken2022('Mint222', normal, 1000).find((f) => f.risk === 'default_frozen');
  assert.ok(fNormal);
  assert.equal(fNormal.severity, 'info');
});

test('a transfer hook with a real program is a live capability', () => {
  const authority = key(0x22);
  const program = key(0x33);
  const info = decodeToken2022(mintBytes({ extensions: [tlv(14, cat([authority, program]))] }));
  assert.ok(info);
  const ext = info.extensions[0];
  assert.equal(ext.name, 'TransferHook');
  assert.equal(ext.hookAuthority, b58(authority));
  assert.equal(ext.programId, b58(program));

  const f = classifyToken2022('Mint333', info, 1000).find((x) => x.risk === 'transfer_hook');
  assert.ok(f);
  assert.equal(f.severity, 'medium');
  assert.match(f.detail, new RegExp(b58(program)));
});

test('a transfer hook whose program_id is None is INERT, not a live hook', () => {
  // This is the PYUSD case, and the whole point of the MaybeNull rule: the hook
  // is registered, an authority exists, and yet no program runs on transfer.
  const info = decodeToken2022(
    mintBytes({ extensions: [tlv(14, cat([key(0x22), ZERO_KEY]))] }),
  );
  assert.ok(info);
  const ext = info.extensions[0];
  assert.equal(ext.hookAuthority, b58(key(0x22)));
  assert.equal(ext.programId, null);

  const f = classifyToken2022('Mint444', info, 1000).find((x) => x.risk === 'transfer_hook');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.match(f.detail, /INERT/);
});

test('a truncated TLV region is recorded, not silently treated as the end', () => {
  // A type-12 header promising 32 bytes with only 10 present. The walk cannot
  // know where the NEXT entry starts, so it reports and stops.
  const bytes = mintBytes({ extensions: [cat([u16(12), u16(32), new Uint8Array(10)])] });
  const info = decodeToken2022(bytes);
  assert.ok(info);
  assert.equal(info.extensions.length, 0);
  assert.equal(info.malformed.length, 1);
  assert.match(info.malformed[0], /declares 32 bytes/);
  assert.match(info.malformed[0], /only 10 remain/);
  // A short region must not produce a finding that claims the delegate is None.
  assert.deepEqual(classifyToken2022('Mint555', info, 1000), []);
});

test('a trailing remainder too short for a TLV header is reported', () => {
  const bytes = mintBytes({ extensions: [new Uint8Array([0x0c, 0x00])] });
  const info = decodeToken2022(bytes);
  assert.ok(info);
  assert.equal(info.extensions.length, 0);
  assert.match(info.malformed[0], /cannot hold a TLV header/);
});

test('a BOGUS extension length that would overrun the buffer does not throw', () => {
  // 0xFFFF bytes promised: the old failure mode here is a RangeError that kills
  // the whole tick — which reads, from the outside, exactly like a clean scan.
  const bytes = mintBytes({ extensions: [cat([u16(12), u16(0xffff), key(0x11)])] });
  const info = decodeToken2022(bytes);
  assert.ok(info);
  assert.equal(info.extensions.length, 0);
  assert.equal(info.malformed.length, 1);
  assert.match(info.malformed[0], /65535 bytes/);
});

test('a plain Token-2022 mint with NO extensions decodes as an empty extension list', () => {
  const info = decodeToken2022(mintBytes({ mintAuthority: key(0x44), supply: 1234n, decimals: 6 }));
  assert.ok(info);
  assert.equal(info.isToken2022Mint, true);
  assert.equal(info.ambiguous, false);
  assert.deepEqual(info.extensions, []);
  assert.deepEqual(info.malformed, []);
  assert.equal(info.tlvEnd, TLV_START);
  // The base mint fields still decode: a mint with no extensions is still a mint.
  assert.equal(info.base.mintAuthority, b58(key(0x44)));
  assert.equal(info.base.supply, 1234n);
  assert.equal(info.base.decimals, 6);
  // And it produces no findings at all — no extensions, nothing to report.
  assert.deepEqual(classifyToken2022('Mint666', info, 1000), []);
});

// ────────────────────────────────────────────────────────── type 0 terminator

test('a type-0 entry terminates the list and the padding after it is ignored', () => {
  const before = tlv(12, key(0x11));
  const bytes = mintBytes({
    // terminator header, then zero padding as a real account would have
    extensions: [before, cat([u16(0), u16(0)]), new Uint8Array(20)],
  });
  const info = decodeToken2022(bytes);
  assert.ok(info);
  assert.equal(info.extensions.length, 1, 'only the entry before the terminator');
  assert.deepEqual(info.malformed, []);
  assert.equal(info.tlvEnd, TLV_START + before.length);
});

// ────────────────────────────────────────────────────────── defensive input

test('an account too short to be a mint is rejected', () => {
  assert.equal(decodeToken2022(new Uint8Array(50)), null);
  assert.equal(decodeToken2022(new Uint8Array(0)), null);
});

test('a token ACCOUNT (AccountType 2) is not decoded as a mint', () => {
  assert.equal(decodeToken2022(mintBytes({ accountType: 2 })), null);
});

test('an 82-to-165 byte account is flagged ambiguous: bytes alone cannot tell', () => {
  // Both token programs use the same 82-byte mint struct, and this length has no
  // AccountType byte, so the OWNER PROGRAM is the only discriminator. Saying so
  // is the honest answer; guessing either way would be wrong half the time.
  const info = decodeToken2022(mintBytes({ baseLength: MINT_SIZE }));
  assert.ok(info);
  assert.equal(info.ambiguous, true);
  assert.equal(info.accountType, null);
  assert.equal(info.isToken2022Mint, false);
  assert.deepEqual(info.extensions, []);
});

test('a 165-byte account has no room for the discriminant and is ambiguous', () => {
  const info = decodeToken2022(mintBytes({ baseLength: BASE_ACCOUNT_LENGTH, accountType: null }));
  assert.ok(info);
  assert.equal(info.ambiguous, true);
  assert.equal(info.accountType, null);
});

test('a truncated TokenMetadata string does not allocate past the payload', () => {
  // A declared 4 GiB name inside a 174-byte payload: must degrade to a partial
  // decode, not to a huge allocation or a throw.
  const payload = cat([key(0x55), ZERO_KEY, u32(0xffffffff), new Uint8Array(8)]);
  const info = decodeToken2022(mintBytes({ extensions: [tlv(19, payload)] }));
  assert.ok(info);
  const md = info.extensions[0].metadata;
  assert.ok(md);
  assert.equal(md.complete, false);
  assert.equal(md.name, '');
  assert.equal(md.updateAuthority, b58(key(0x55)));
});

// ────────────────────────────────────────────────────────── fee selection

test('fee selection is epoch-based: newer applies only from its epoch', () => {
  const older = { epoch: 1048, maximumFee: 0n, basisPoints: 500 };
  const newer = { epoch: 1050, maximumFee: 0n, basisPoints: 100 };

  // Before the new schedule starts, the OLD rate is the live one — reporting 100
  // here would understate the fee a buyer actually pays.
  const before = selectTransferFeeRates(older, newer, 1049);
  assert.ok(before);
  assert.equal(before.basis, 'older');
  assert.equal(before.rates.basisPoints, 500);

  const at = selectTransferFeeRates(older, newer, 1050);
  assert.ok(at);
  assert.equal(at.basis, 'newer');
  assert.equal(at.rates.basisPoints, 100);

  // No epoch: the worst case, explicitly labelled, never silently the newer one.
  const unknown = selectTransferFeeRates(older, newer, null);
  assert.ok(unknown);
  assert.equal(unknown.basis, 'worst-case');
  assert.equal(unknown.rates.basisPoints, 500);
});

test('a nonzero transfer fee is found at the offsets the source declares', () => {
  // A wrong offset would read zero and look like "no fee", so the fixture carries
  // distinct nonzero values at 88 and 106 and nothing else nonzero in between.
  const payload = transferFeePayload({
    configAuthority: key(0x66),
    olderEpoch: 1048,
    olderBps: 500,
    newerEpoch: 1050,
    newerBps: 100,
  });
  assert.equal(payload.length, 108, 'TransferFeeConfig is exactly 108 bytes');

  const info = decodeToken2022(mintBytes({ extensions: [tlv(1, payload)] }));
  assert.ok(info);
  const fee = info.extensions[0].transferFee;
  assert.ok(fee);
  assert.equal(fee.configAuthority, b58(key(0x66)));
  assert.equal(fee.older.basisPoints, 500);
  assert.equal(fee.older.epoch, 1048);
  assert.equal(fee.newer.basisPoints, 100);
  assert.equal(fee.newer.epoch, 1050);

  // Severity tracks the LIVE schedule, not the worst one: at epoch 1050 the newer
  // 100 bps is in force (low), and at 1049 the older 500 bps is (medium).
  // 500 bps is the same threshold `FILTER.maxTransferFeeBps` kills at, so the two
  // agree instead of contradicting each other.
  const live = classifyToken2022('Mint777', info, 1000, 1050).find((f) => f.risk === 'transfer_fee');
  assert.ok(live);
  assert.equal(live.severity, 'low');
  assert.match(live.detail, /100 bps on the newer schedule/);

  const stale = classifyToken2022('Mint777', info, 1000, 1049).find((f) => f.risk === 'transfer_fee');
  assert.ok(stale);
  assert.equal(stale.severity, 'medium');
  assert.match(stale.detail, /500 bps on the older schedule/);
  // No epoch: worst case, and the detail must say so rather than imply it is live.
  const worst = classifyToken2022('Mint777', info, 1000, null).find((f) => f.risk === 'transfer_fee');
  assert.ok(worst);
  assert.equal(worst.severity, 'medium');
  assert.match(worst.detail, /worst-case schedule/);
});

// ────────────────────────────────────────────────────────── honesty renderer

test('renderToken2022 says "nothing looked at" instead of a confident zero', () => {
  const text = renderToken2022(
    {
      mintsChecked: 0,
      token2022: 0,
      extensions: 0,
      findings: 0,
      risky: 0,
      inertHooks: 0,
      notMints: 0,
      absent: 0,
      unreadable: 0,
      skipped: 0,
      noInputs: true,
      epoch: null,
      ticks: 1,
      lastTickMs: 1,
    },
    [],
  );
  assert.match(text, /NONE/);
  assert.match(text, /nothing looked at/i);
  assert.doesNotMatch(text, /0 findings/);
});

test('renderToken2022 flags unreadable mints as NOT clean', () => {
  const text = renderToken2022(
    {
      mintsChecked: 2,
      token2022: 2,
      extensions: 5,
      findings: 1,
      risky: 1,
      inertHooks: 0,
      notMints: 0,
      absent: 0,
      unreadable: 3,
      skipped: 0,
      noInputs: false,
      epoch: 605,
      ticks: 1,
      lastTickMs: 1,
    },
    [],
  );
  assert.match(text, /unreadable 3/);
  assert.match(text, /NOT clean/);
});

test('renderToken2022 reports an unknown fee epoch as a worst case, not as the live rate', () => {
  const stats = {
    mintsChecked: 1,
    token2022: 1,
    extensions: 1,
    findings: 0,
    risky: 0,
    inertHooks: 0,
    notMints: 0,
    absent: 0,
    unreadable: 0,
    skipped: 0,
    noInputs: false,
    epoch: null,
    ticks: 1,
    lastTickMs: 1,
  };
  assert.match(renderToken2022(stats, []), /worst case/);
  assert.match(renderToken2022({ ...stats, epoch: 605 }, []), /fee epoch {2}605/);
});

test('renderToken2022 names SKIPPED inputs as unread, separately from unreadable', () => {
  // A budget stop is a third fact: the RPC was fine, we simply never asked. The
  // tick must not present that as a clean result OR as an RPC failure.
  const text = renderToken2022(
    {
      mintsChecked: 0,
      token2022: 0,
      extensions: 0,
      findings: 0,
      risky: 0,
      inertHooks: 0,
      notMints: 0,
      absent: 0,
      unreadable: 0,
      skipped: 4,
      noInputs: false,
      epoch: 605,
      ticks: 1,
      lastTickMs: 1,
    },
    [],
  );
  assert.match(text, /skipped {4}4/);
  assert.match(text, /budget ran out/);
  assert.doesNotMatch(text, /unreadable/);
});

test('renderToken2022 distinguishes "absent" from "unreadable"', () => {
  // An address with no account is a knowable fact; an RPC that never answered is
  // an absence of knowledge. Printing one as the other is the bug this file is
  // built to avoid, in both directions.
  const withAbsent = renderToken2022(
    {
      mintsChecked: 0,
      token2022: 0,
      extensions: 0,
      findings: 0,
      risky: 0,
      inertHooks: 0,
      notMints: 0,
      absent: 2,
      unreadable: 0,
      skipped: 0,
      noInputs: false,
      epoch: 605,
      ticks: 1,
      lastTickMs: 1,
    },
    [],
  );
  assert.match(withAbsent, /absent {5}2/);
  assert.doesNotMatch(withAbsent, /NOT clean/);
  assert.match(withAbsent, /nothing there to judge/);
});

test('informational extensions are not promoted to risk', () => {
  // Metadata, an interest rate (a UI multiplier only) and a CpiGuard (a
  // protection) are all reported, and all info. Overstating them is how a report
  // stops being read.
  const info = decodeToken2022(
    mintBytes({
      extensions: [
        tlv(10, cat([key(0x77), u64(1_700_000_000), i16(500), u64(1_700_000_100), i16(250)])),
        tlv(11, new Uint8Array([1])),
        tlv(19, tokenMetadataPayload({ name: 'Test', symbol: 'TST', uri: 'https://x/y.json' })),
      ],
    }),
  );
  assert.ok(info);
  const findings = classifyToken2022('Mint888', info, 1000);
  assert.ok(findings.length >= 3);
  for (const f of findings) assert.equal(f.severity, 'info', `${f.risk} must not be a risk`);

  const ib = findings.find((f) => f.risk === 'interest_bearing');
  assert.ok(ib);
  assert.match(ib.detail, /250 bps/);
  const md = findings.find((f) => f.risk === 'metadata' && /Test/.test(f.detail));
  assert.ok(md);
  assert.match(md.detail, /TST/);
});

// ────────────────────────────────────────────────────────── live parity

/**
 * Read a real account from mainnet, retrying through rate limits.
 *
 * A throttled read is NOT a decode failure, so a 429 must not be allowed to turn
 * this into a flaky gate — a test people learn to ignore is worse than no test.
 */
async function liveAccount(addr, tries = 10) {
  // TWO endpoints, because one is not enough. The whole suite runs the live
  // tests of several files at once, and the official endpoint throttles by
  // connection, not just by key: under that combined load `getAccountInfo` starts
  // returning "Connection rate limits exceeded" even though nothing is wrong
  // with the decode. publicnode serves getAccountInfo fine (it is only
  // getTokenAccountsByOwner/getProgramAccounts it blocks), so failing over to it
  // is the difference between a gate that means something and a gate people
  // learn to re-run until green.
  const RPC = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
  let lastMsg = '';
  for (let i = 0; i < tries; i++) {
    const url = RPC[i % RPC.length];
    try {
      const res = await fetch(url, {
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
      if (!j.error) {
        const v = j.result?.value;
        if (!v) throw new Error(`account not found: ${addr}`);
        return { owner: v.owner, bytes: Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0)) };
      }
      lastMsg = String(j.error.message ?? '');
      if (!/rate limit|too many|429/i.test(lastMsg)) throw new Error(`rpc: ${lastMsg}`);
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      if (!/rate limit|too many|429|fetch failed|network/i.test(lastMsg)) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000 + i * 2000));
  }
  throw new Error(`rpc: still throttled after ${tries} tries (${lastMsg})`);
}

const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * PYUSD — 866 bytes, eight extensions, and the account that pins almost every
 * decision in this module at once:
 *
 *   · the extension ORDER and every declared TLV length (32, 32, 108, 65, 129,
 *     64, 64, 174), which is what proves the payload sizes;
 *   · a permanent delegate and a close authority that are the SAME key;
 *   · a zero-bps fee whose epochs still decode (605), proving the schedule
 *     offsets are right even when the value is uninteresting;
 *   · a TransferHook with a live authority and an ALL-ZERO program_id — i.e.
 *     INERT — which is the single most important decode in the file;
 *   · a MetadataPointer that points at the mint itself;
 *   · Borsh TokenMetadata, which is the only variable-length payload here.
 */
test('decodes the real PYUSD mint from mainnet: order, authorities, and the inert hook', async () => {
  const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
  const EXPECTED_KEY = '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk';

  const acc = await liveAccount(PYUSD);
  assert.equal(acc.owner, TOKEN_2022_PROGRAM);
  assert.equal(acc.bytes.length, 866, 'PYUSD is 866 bytes');

  const info = decodeToken2022(acc.bytes);
  assert.ok(info, 'PYUSD must decode as a Token-2022 mint');
  assert.equal(info.accountType, 1);
  assert.equal(info.isToken2022Mint, true);
  assert.deepEqual(info.malformed, [], 'every TLV length must be internally consistent');

  // The exact order on chain. A decoder that walked the TLV list wrongly would
  // still produce eight extensions, but not these eight in this order.
  assert.deepEqual(
    info.extensions.map((e) => e.type),
    [3, 12, 1, 4, 16, 14, 18, 19],
  );
  assert.deepEqual(
    info.extensions.map((e) => e.dataLength),
    [32, 32, 108, 65, 129, 64, 64, 174],
  );

  const close = info.extensions.find((e) => e.name === 'MintCloseAuthority');
  const delegate = info.extensions.find((e) => e.name === 'PermanentDelegate');
  assert.ok(close && delegate);
  assert.equal(close.closeAuthority, EXPECTED_KEY);
  assert.equal(delegate.delegate, EXPECTED_KEY);

  const fee = info.extensions.find((e) => e.name === 'TransferFeeConfig');
  assert.ok(fee?.transferFee);
  // Zero bps, but the EPOCHS are real and nonzero — so this still proves the
  // schedule offsets rather than passing on a payload of all zeroes.
  assert.equal(fee.transferFee.older.basisPoints, 0);
  assert.equal(fee.transferFee.newer.basisPoints, 0);
  assert.equal(fee.transferFee.older.epoch, 605);
  assert.equal(fee.transferFee.newer.epoch, 605);

  const hook = info.extensions.find((e) => e.name === 'TransferHook');
  assert.ok(hook);
  assert.equal(hook.hookAuthority, EXPECTED_KEY);
  // THE ASSERTION THIS MODULE EXISTS FOR: the program_id is all-zero => None.
  assert.equal(hook.programId, null, 'PYUSD transfer hook is INERT');

  const pointer = info.extensions.find((e) => e.name === 'MetadataPointer');
  assert.ok(pointer);
  assert.equal(pointer.metadataAddress, PYUSD, 'PYUSD points its metadata at itself');

  const md = info.extensions.find((e) => e.name === 'TokenMetadata')?.metadata;
  assert.ok(md);
  assert.equal(md.name, 'PayPal USD');
  assert.equal(md.symbol, 'PYUSD');
  assert.equal(
    md.uri,
    'https://token-metadata.paxos.com/pyusd_metadata/prod/solana/pyusd_metadata.json',
  );
  assert.equal(md.complete, true);
  assert.deepEqual(md.additionalMetadata, []);

  // Classified: PYUSD must NOT be reported with a live transfer hook. It does
  // have a live permanent delegate, which is a real (and known) capability.
  const findings = classifyToken2022(PYUSD, info, 1000, 605);
  const hookFinding = findings.find((f) => f.risk === 'transfer_hook');
  assert.ok(hookFinding);
  assert.equal(hookFinding.severity, 'info');
  assert.match(hookFinding.detail, /INERT/);

  const del = findings.find((f) => f.risk === 'permanent_delegate');
  assert.ok(del);
  assert.equal(del.severity, 'high');
});

/**
 * Two more real mints, because a ZERO fee cannot prove an offset: reading 0 at a
 * wrong offset still reads 0. These carry nonzero values on purpose.
 */
test('decodes NONZERO transfer fees from mainnet at both schedule offsets', async () => {
  // 300 bps on BOTH schedules at @88 and @106.
  const BOTH_300 = 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR';
  // 500 bps older @epoch 1048 vs 100 bps newer @epoch 1050 — the epoch case.
  const SCHEDULED = 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw';

  const a = await liveAccount(BOTH_300);
  const ai = decodeToken2022(a.bytes);
  assert.ok(ai);
  const af = ai.extensions.find((e) => e.name === 'TransferFeeConfig')?.transferFee;
  assert.ok(af);
  assert.equal(af.older.basisPoints, 300);
  assert.equal(af.newer.basisPoints, 300);
  // Its config authority is None, which is the other MaybeNull case in one view:
  // a live withdrawer with no config authority.
  assert.equal(af.configAuthority, null);

  await new Promise((r) => setTimeout(r, 800));

  const b = await liveAccount(SCHEDULED);
  const bi = decodeToken2022(b.bytes);
  assert.ok(bi);
  const bf = bi.extensions.find((e) => e.name === 'TransferFeeConfig')?.transferFee;
  assert.ok(bf);
  assert.equal(bf.older.basisPoints, 500);
  assert.equal(bf.older.epoch, 1048);
  assert.equal(bf.newer.basisPoints, 100);
  assert.equal(bf.newer.epoch, 1050);

  // Selection at the chain's own epochs: before 1050 the old 500 bps applies,
  // from 1050 the new 100 bps does. Getting this backwards would understate the
  // fee a buyer actually pays today.
  const before = selectTransferFeeRates(bf.older, bf.newer, 1049);
  assert.equal(before?.rates.basisPoints, 500);
  const after = selectTransferFeeRates(bf.older, bf.newer, 1050);
  assert.equal(after?.rates.basisPoints, 100);

  // And an extension ordinal this module does not decode is still COUNTED, not
  // dropped: this mint carries types 25 and 26.
  const unknowns = bi.extensions.filter((e) => e.name === 'Unknown');
  assert.ok(unknowns.length >= 1, 'unverified ordinals must still be reported by number');
  const described = classifyToken2022(SCHEDULED, bi, 1000, 1050).filter((f) =>
    /unverified extension type/.test(f.detail),
  );
  assert.equal(described.length, unknowns.length);
});
