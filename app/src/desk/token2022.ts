/**
 * Token-2022 extension scanner — read a mint's extension bytes and report the
 * powers those extensions hand to someone.
 *
 * ## Why extensions are the interesting part of a Token-2022 mint
 *
 * A legacy SPL mint has exactly two levers: a mint authority that can print and
 * a freeze authority that can lock an account. Token-2022 keeps both and adds a
 * list of *extensions*, each one a small struct appended to the mint account.
 * Several of them are strictly more powerful than the levers the desk already
 * gates on:
 *
 *   · **PermanentDelegate** — one key may move or burn ANY holder's tokens,
 *     forever, with no signature from the holder and no expiry.
 *   · **DefaultAccountState(frozen)** — every newly created token account starts
 *     frozen, so a buyer receives tokens it cannot move until the freeze
 *     authority chooses to thaw it.
 *   · **TransferHook** — every transfer must call a program of the issuer's
 *     choosing, which may reject any transfer, including a sell.
 *   · **NonTransferable** — transfers fail outright; a DEX exit is impossible.
 *   · **TransferFeeConfig** — a tax on every transfer, which a round trip pays
 *     twice.
 *
 * `filter.ts` already knows about a few of these names (see
 * `DANGEROUS_TOKEN2022_EXTENSIONS` in `types.ts`), but until now nothing in the
 * desk could *read* them: the scanner's `extensions` field was whatever a
 * third-party API claimed. This module replaces the claim with the bytes.
 *
 * ## The layout, and why the offsets are exactly these
 *
 * Source of truth: `spl-token-2022` `interface/src/extension/mod.rs`.
 *
 *   · The base mint is the SPL mint struct: 82 bytes (`Mint::SIZE_OF`).
 *   · `BASE_ACCOUNT_LENGTH = Account::LEN = 165`. When a mint carries any
 *     extension, the 82-byte mint is zero-padded out to 165 so the TLV region
 *     starts on a fixed offset regardless of how many extensions follow.
 *   · `account_type_index = 165 - Mint::SIZE_OF = 165 - 82 = 83` *within the
 *     post-mint slice*, i.e. 82 + 83 = **absolute offset 165**. That byte is the
 *     `AccountType` discriminant and must be 1 (`Mint`) for a mint; 2 is a token
 *     account, 0 is uninitialized.
 *   · `tlv_start_index = 166`. Everything from there is the extension list.
 *
 * A TLV entry is `u16 LE type, u16 LE length, length bytes of payload`. A type of
 * 0 (`Uninitialized`) terminates the list; the remaining bytes are zero padding.
 * `ExtensionType` is a plain `#[repr(u16)]` ordinal enum, so the type number is
 * the only identifier stored on chain — no names, no tags.
 *
 * ## The offsets and payloads here were verified twice, not assumed
 *
 * Every payload layout below was checked against the struct definitions in the
 * same crate AND against live mainnet accounts whose answers are independently
 * knowable:
 *
 *   · `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` (PYUSD, 866 bytes) —
 *     eight extensions in the order MintCloseAuthority(32), PermanentDelegate(32),
 *     TransferFeeConfig(108), ConfidentialTransferMint(65),
 *     ConfidentialTransferFeeConfig(129), TransferHook(64), MetadataPointer(64),
 *     TokenMetadata(174). Every declared TLV length matches the struct size, and
 *     the TokenMetadata name/symbol decode to "PayPal USD"/"PYUSD".
 *   · `HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR` — nonzero fee on BOTH
 *     schedules (300 bps), which is what pins the bps offsets at 88 and 106. A
 *     zero value at a wrong offset would still read as zero, so only a nonzero
 *     account can prove an offset.
 *   · `Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw` — older 500 bps @epoch 1048
 *     vs newer 100 bps @epoch 1050, which proves both that the schedules are
 *     18 bytes apart and that selection is epoch-based.
 *
 * ## NULL IS NOT ZERO — the one decode rule that changes a verdict
 *
 * Token-2022's struct fields use `MaybeNull<Address>`, and
 * `MaybeNull::NONE == [0u8; 32]` (`solana-nullable`:
 * `const NONE = Address::new_from_array([0u8; 32])`). So an all-zero 32-byte
 * field means *absent*, and this module decodes it to JS `null` — never to the
 * base58 string `11111111111111111111111111111111`, which is a real address (the
 * System Program's) and would be read as a live authority by anything downstream.
 *
 * Note that this is a DIFFERENT convention from the base mint's own
 * `COption<Pubkey>` fields, which spend a 4-byte option tag before the key
 * (`decodeMint` in `hunter.ts` reads those). Two conventions in one account is
 * exactly the kind of detail that gets a field silently mis-read, so each decoder
 * below states which one it is using.
 *
 * The payoff is concrete: PYUSD's TransferHook carries a live authority and an
 * ALL-ZERO program_id. Under `MaybeNull` that hook is `None`, i.e. INERT —
 * transfers call no program at all. A decoder that printed the zero key as an
 * address, or that reported "has transfer hook" without checking the program,
 * would flag PayPal's stablecoin with a honeypot capability it does not have.
 *
 * ## What this bot is allowed to claim
 *
 * Nothing here is a vulnerability report. An extension is a *capability*; the
 * capability is a fact read from bytes, and whether it is abuse is a judgement
 * this module keeps separate (see `classifyToken2022`, where the risk class is
 * the extension and the severity says whether it is currently dangerous).
 *
 * Three honesty invariants are inherited from `hunter.ts` deliberately, because
 * they are the reason its output is worth reading at all:
 *
 *   1. **An account we could not read is NOT clean.** `unreadable` is tracked
 *      and rendered. A rate-limited RPC must never be reported as a safe mint.
 *   2. **No inputs renders "nothing looked at"**, never "0 findings".
 *   3. **All-zero pubkey => null**, per the rule above.
 *
 * The decoder itself is pure and total: no network, no env, and it never throws.
 * One short or malformed account degrades to `null`/a partial decode, because a
 * decode that kills the tick is indistinguishable from a clean scan.
 */

import { SPL_TOKEN_2022_PROGRAM, encodeBase58, isSolanaPubkey } from '../solana.js';
import { decodeMint, type MintInfo } from './hunter.js';
import { db, kvGet, kvSet, newId, spendSubrequest } from './db.js';
import type { DeskEnv } from './types.js';

// ─────────────────────────────────────────────────────────────── constants

/** `Account::LEN` / `BASE_ACCOUNT_LENGTH`: the padded base account size. */
export const BASE_ACCOUNT_LENGTH = 165;
/** `Mint::SIZE_OF`: the SPL mint struct, which Token-2022 reuses verbatim. */
export const MINT_SIZE = 82;
/**
 * Absolute offset of the `AccountType` byte: 82 + (165 - 82) = 165.
 * Present only when the account is at least 166 bytes long.
 */
export const ACCOUNT_TYPE_OFFSET = 165;
/** `tlv_start_index`: the first byte of the extension TLV region. */
export const TLV_START = 166;

/** `AccountType::Mint`. 0 = Uninitialized, 2 = Account. */
export const ACCOUNT_TYPE_MINT = 1;
/** `AccountType::Account` — a token account, not a mint. */
export const ACCOUNT_TYPE_TOKEN = 2;

// ─────────────────────────────────────────────────────────────── extension ids

/**
 * The declared `#[repr(u16)]` ordinals we are willing to name.
 *
 * Deliberately NOT exhaustive. Types that exist in the crate but whose layouts
 * were not verified here are left out rather than guessed at, and every ordinal
 * that is absent from this map decodes as `'Unknown'` with the raw number
 * preserved. On a live account that is not hypothetical: the Pren1F fixture
 * carries types 25 (56 bytes) and 26 (33 bytes), which are reported by ordinal
 * and length only, and counted — not dropped. Dropping them would make the
 * extension count on the renderer a lie.
 */
export const EXTENSION_NAMES: Record<number, ExtensionName> = {
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  6: 'DefaultAccountState',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  14: 'TransferHook',
  16: 'ConfidentialTransferFeeConfig',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
};

export type ExtensionName =
  | 'TransferFeeConfig'
  | 'TransferFeeAmount'
  | 'MintCloseAuthority'
  | 'ConfidentialTransferMint'
  | 'DefaultAccountState'
  | 'MemoTransfer'
  | 'NonTransferable'
  | 'InterestBearingConfig'
  | 'CpiGuard'
  | 'PermanentDelegate'
  | 'TransferHook'
  | 'ConfidentialTransferFeeConfig'
  | 'MetadataPointer'
  | 'TokenMetadata'
  | 'Unknown';

/** Map an ordinal to a name, keeping unknown ordinals visible as `'Unknown'`. */
export function extensionName(type: number): ExtensionName {
  return EXTENSION_NAMES[type] ?? 'Unknown';
}

// ─────────────────────────────────────────────────────────────── byte helpers

/**
 * Read one byte, or `null` past the end.
 *
 * `tsconfig` runs with `noUncheckedIndexedAccess`, so every indexed read is
 * `number | undefined`; these helpers turn that into an explicit "not there"
 * instead of a silent 0. Where a 0 is the right stand-in (inside a field that has
 * already been length-checked) the `uNNle` helpers below use `?? 0`.
 */
function u8(b: Uint8Array, off: number): number | null {
  const v = b[off];
  return v === undefined ? null : v;
}

/** True when `n` bytes at `off` are inside the buffer. */
function has(b: Uint8Array, off: number, n: number): boolean {
  return off >= 0 && n >= 0 && off + n <= b.length;
}

function u16le(b: Uint8Array, off: number): number {
  return (b[off] ?? 0) | ((b[off + 1] ?? 0) << 8);
}

function u32le(b: Uint8Array, off: number): number {
  return (
    ((b[off] ?? 0) | ((b[off + 1] ?? 0) << 8) | ((b[off + 2] ?? 0) << 16) | ((b[off + 3] ?? 0) << 24)) >>> 0
  );
}

function u64le(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i] ?? 0);
  return v;
}

function i16le(b: Uint8Array, off: number): number {
  const raw = u16le(b, off);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

function i64le(b: Uint8Array, off: number): bigint {
  const raw = u64le(b, off);
  return raw >= 1n << 63n ? raw - (1n << 64n) : raw;
}

/** True when all 32 bytes at `off` are zero. False when they are not all there. */
function isZeroKey(b: Uint8Array, off: number): boolean {
  if (!has(b, off, 32)) return false;
  for (let i = 0; i < 32; i++) if ((b[off + i] ?? 0) !== 0) return false;
  return true;
}

/** A plain 32-byte address, or `null` when the bytes are not present. */
function pubkey(b: Uint8Array, off: number): string | null {
  if (!has(b, off, 32)) return null;
  return encodeBase58(b.subarray(off, off + 32));
}

/**
 * A `MaybeNull<Address>` field: all-zero bytes mean `None`, so they decode to
 * `null`. See the header — this is Token-2022's convention for extension fields,
 * and it is NOT the base mint's 4-byte `COption` tag.
 */
function nullablePubkey(b: Uint8Array, off: number): string | null {
  if (!has(b, off, 32)) return null;
  if (isZeroKey(b, off)) return null;
  return encodeBase58(b.subarray(off, off + 32));
}

const TD = new TextDecoder();

// ─────────────────────────────────────────────────────────────── decoded types

export type AccountState = 'uninitialized' | 'initialized' | 'frozen' | 'unknown';

/**
 * One fee schedule. `TransferFeeConfig` stores TWO of these so a fee change can
 * be scheduled at a future epoch without changing the account layout.
 */
export interface TransferFeeRates {
  /** Epoch this schedule takes effect at. Exact for every real mainnet epoch. */
  epoch: number;
  /**
   * u64, kept as `bigint` on purpose: live values reach 1e18, which is past
   * `Number.MAX_SAFE_INTEGER`, so a `number` here would silently round a cap.
   */
  maximumFee: bigint;
  basisPoints: number;
}

export interface TransferFeeConfigInfo {
  /** `transfer_fee_config_authority` — may change the fee. */
  configAuthority: string | null;
  /** `withdraw_withheld_authority` — may collect the withheld fees. */
  withdrawWithheldAuthority: string | null;
  /** u64 already withheld and not yet withdrawn. */
  withheldAmount: bigint | null;
  /** The schedule in force before `newer.epoch`. */
  older: TransferFeeRates | null;
  /** The schedule in force from `newer.epoch` onwards. */
  newer: TransferFeeRates | null;
}

export interface InterestBearingInfo {
  rateAuthority: string | null;
  /** Unix seconds the interest started accruing from. i64. */
  initializationTimestamp: number;
  /** i16 basis points, averaged over past updates. */
  preUpdateAverageRateBps: number;
  /** Unix seconds of the last rate change. i64. */
  lastUpdateTimestamp: number;
  /** i16 basis points of the current display rate (10_000 = 100%). */
  currentRateBps: number;
}

/**
 * `TokenMetadata` is Borsh, not a fixed struct: two 32-byte keys followed by
 * length-prefixed UTF-8 strings and a vector of string pairs. Its TLV length
 * therefore varies per mint (174 bytes on PYUSD, 166 on another fixture), which
 * is why it cannot be decoded by offset arithmetic alone.
 */
export interface TokenMetadataInfo {
  updateAuthority: string | null;
  mint: string | null;
  name: string;
  symbol: string;
  uri: string;
  additionalMetadata: { key: string; value: string }[];
  /** False when the payload ended before every declared string was read. */
  complete: boolean;
}

/**
 * One decoded extension.
 *
 * Payload fields are named for the identity they carry rather than sharing one
 * generic `authority`, because these extensions mean different things by it — a
 * transfer-hook authority governs the hook program, a metadata-pointer authority
 * governs the pointer, a close authority can close the mint. Collapsing them
 * would make a finding read "authority X" with no way to tell what X may do.
 */
export interface Token2022Extension {
  /** Raw TLV ordinal. Preserved even when `name` is `'Unknown'`. */
  type: number;
  name: ExtensionName;
  /** Declared payload length from the TLV header. */
  dataLength: number;
  /** True when the payload is shorter than this extension's struct requires. */
  truncated: boolean;
  /** `MintCloseAuthority.close_authority`. */
  closeAuthority?: string | null;
  /** `PermanentDelegate.delegate`. */
  delegate?: string | null;
  /** `TransferHook.authority` — governs the hook, not the transfers. */
  hookAuthority?: string | null;
  /** `TransferHook.program_id`. `null` means None: the hook is INERT. */
  programId?: string | null;
  /** `MetadataPointer.authority`. */
  pointerAuthority?: string | null;
  /** `MetadataPointer.metadata_address`. */
  metadataAddress?: string | null;
  /** `DefaultAccountState.state`, as a name. */
  accountState?: AccountState;
  /** `DefaultAccountState.state`, as the raw byte (0/1/2). */
  stateByte?: number;
  transferFee?: TransferFeeConfigInfo;
  /** `TransferFeeAmount.withheld_amount` — a token-account extension. */
  withheldAmount?: bigint | null;
  interestBearing?: InterestBearingInfo;
  memoRequired?: boolean;
  cpiGuardEnabled?: boolean;
  metadata?: TokenMetadataInfo;
}

export interface Token2022Info {
  /** True only when the account's own `AccountType` byte proves it is a mint. */
  isToken2022Mint: boolean;
  /** Raw `AccountType` byte, or `null` when the account has no room for it. */
  accountType: number | null;
  /**
   * True when the bytes alone cannot distinguish Token-2022 from legacy SPL: an
   * account of exactly the 82-byte mint size with no `AccountType` byte. For
   * those the OWNER PROGRAM is the only discriminator, and this pure decoder does
   * not know it — `runToken2022Bot` resolves it from the RPC's `owner` field.
   */
  ambiguous: boolean;
  /** `Mint.is_initialized`. */
  initialized: boolean;
  /** The shared SPL mint fields (mint/freeze authority, supply, decimals). */
  base: MintInfo;
  extensions: Token2022Extension[];
  /**
   * TLV entries we could not read, each with the reason. Never silently dropped:
   * a truncated region and an empty region are different facts.
   */
  malformed: string[];
  /** Absolute offset where TLV parsing stopped (the terminator or the end). */
  tlvEnd: number;
}

// ─────────────────────────────────────────────────────────────── extension decoders

/**
 * `TransferFeeConfig`, 108 bytes:
 *   [0..32)   transfer_fee_config_authority
 *   [32..64)  withdraw_withheld_authority
 *   [64..72)  withheld_amount (u64)
 *   [72..90)  older_transfer_fee  { epoch u64 @72, maximum_fee u64 @80, bps u16 @88 }
 *   [90..108) newer_transfer_fee  { epoch u64 @90, maximum_fee u64 @98, bps u16 @106 }
 *
 * 32 + 32 + 8 + (8 + 8 + 2) + (8 + 8 + 2) = 108, which is the TLV length observed
 * on chain on all three fixtures. The bps offsets 88 and 106 are pinned by
 * `HcRLc9…` (300/300) and `Pren1F…` (500/100), not just by the struct.
 *
 * Fields decode independently so a short payload yields the authorities and
 * whatever schedule is complete, rather than nothing.
 */
function decodeTransferFee(p: Uint8Array): TransferFeeConfigInfo {
  const rates = (off: number): TransferFeeRates | null =>
    has(p, off, 18)
      ? {
          epoch: Number(u64le(p, off)),
          maximumFee: u64le(p, off + 8),
          basisPoints: u16le(p, off + 16),
        }
      : null;
  return {
    configAuthority: nullablePubkey(p, 0),
    withdrawWithheldAuthority: nullablePubkey(p, 32),
    withheldAmount: has(p, 64, 8) ? u64le(p, 64) : null,
    older: rates(72),
    newer: rates(90),
  };
}

/**
 * `InterestBearingConfig`, 52 bytes:
 *   [0..32)  rate_authority
 *   [32..40) initialization_timestamp (i64)
 *   [40..42) pre_update_average_rate (i16)
 *   [42..50) last_update_timestamp (i64)
 *   [50..52) current_rate (i16)
 *
 * The timestamps are i64 and are only ever rendered, so they are narrowed to
 * `number`: unix seconds are ~1.8e9 today, far inside 2^53. They are still read
 * through `i64le` so a negative (pre-epoch) value decodes as negative rather than
 * as 1.8e19.
 */
function decodeInterestBearing(p: Uint8Array): InterestBearingInfo {
  return {
    rateAuthority: nullablePubkey(p, 0),
    initializationTimestamp: Number(i64le(p, 32)),
    preUpdateAverageRateBps: has(p, 40, 2) ? i16le(p, 40) : 0,
    lastUpdateTimestamp: Number(i64le(p, 42)),
    currentRateBps: has(p, 50, 2) ? i16le(p, 50) : 0,
  };
}

/**
 * `TokenMetadata` — Borsh:
 *   [0..32)   update_authority
 *   [32..64)  mint
 *   String    name        (u32 LE length, then that many UTF-8 bytes)
 *   String    symbol
 *   String    uri
 *   Vec<(String, String)> additional_metadata (u32 LE count, then pairs)
 *
 * Every length is attacker-controlled in the sense that it is whatever the mint
 * holds, so each one is bounds-checked against the remaining payload before it is
 * used to slice — a declared 4 GiB string in a 174-byte payload must produce a
 * partial decode, not an allocation. The pair count is capped as well, so a
 * bogus count cannot spin the loop.
 */
function decodeTokenMetadata(p: Uint8Array): TokenMetadataInfo {
  let off = 64;
  let complete = p.length >= 64;

  const readStr = (): string | null => {
    if (!has(p, off, 4)) return null;
    const n = u32le(p, off);
    off += 4;
    if (!has(p, off, n)) return null;
    const s = TD.decode(p.subarray(off, off + n));
    off += n;
    return s;
  };

  const name = readStr();
  const symbol = name === null ? null : readStr();
  const uri = symbol === null ? null : readStr();
  if (name === null || symbol === null || uri === null) complete = false;

  const additionalMetadata: { key: string; value: string }[] = [];
  if (complete && has(p, off, 4)) {
    const count = u32le(p, off);
    off += 4;
    // A real Vec is 0 or a handful of pairs (PYUSD has 0). 64 is a generous cap
    // that still bounds the loop against a crafted count.
    const want = Math.min(count, 64);
    for (let i = 0; i < want; i++) {
      const k = readStr();
      const v = k === null ? null : readStr();
      if (k === null || v === null) {
        complete = false;
        break;
      }
      additionalMetadata.push({ key: k, value: v });
    }
    if (complete && count > want) complete = false;
  } else if (complete) {
    complete = false;
  }

  return {
    updateAuthority: nullablePubkey(p, 0),
    mint: nullablePubkey(p, 32),
    name: name ?? '',
    symbol: symbol ?? '',
    uri: uri ?? '',
    additionalMetadata,
    complete,
  };
}

/**
 * Decode one TLV payload into its typed form.
 *
 * `truncated` is set from the payload length versus the struct's required size,
 * so a caller can tell "this field was not there" from "this field was zero".
 * The default arm intentionally returns no payload fields: for a type whose
 * layout is not verified here, the honest answer is the ordinal and the length.
 */
function decodeExtension(type: number, p: Uint8Array): Token2022Extension {
  const base = { type, name: extensionName(type), dataLength: p.length, truncated: false };

  switch (type) {
    case 1: // TransferFeeConfig — 108 bytes
      return { ...base, truncated: p.length < 108, transferFee: decodeTransferFee(p) };
    case 2: // TransferFeeAmount — withheld_amount u64
      return {
        ...base,
        truncated: p.length < 8,
        withheldAmount: has(p, 0, 8) ? u64le(p, 0) : null,
      };
    case 3: // MintCloseAuthority — close_authority
      return { ...base, truncated: p.length < 32, closeAuthority: nullablePubkey(p, 0) };
    case 6: {
      // DefaultAccountState — one byte: 0 uninitialized, 1 initialized, 2 frozen.
      const raw = u8(p, 0);
      const accountState: AccountState =
        raw === 0 ? 'uninitialized' : raw === 1 ? 'initialized' : raw === 2 ? 'frozen' : 'unknown';
      return { ...base, truncated: raw === null, accountState, stateByte: raw ?? -1 };
    }
    case 8: {
      // MemoTransfer — require_incoming_transfer_memos: bool
      const raw = u8(p, 0);
      return { ...base, truncated: raw === null, memoRequired: raw === 1 };
    }
    case 9: // NonTransferable — no payload at all
      return { ...base, truncated: false };
    case 10: // InterestBearingConfig — 52 bytes
      return { ...base, truncated: p.length < 52, interestBearing: decodeInterestBearing(p) };
    case 11: {
      // CpiGuard — lock_cpi: bool
      const raw = u8(p, 0);
      return { ...base, truncated: raw === null, cpiGuardEnabled: raw === 1 };
    }
    case 12: // PermanentDelegate — delegate
      return { ...base, truncated: p.length < 32, delegate: nullablePubkey(p, 0) };
    case 14: // TransferHook — authority, program_id
      return {
        ...base,
        truncated: p.length < 64,
        hookAuthority: nullablePubkey(p, 0),
        programId: nullablePubkey(p, 32),
      };
    case 16: // ConfidentialTransferFeeConfig — 129 bytes
      // Presence and length only: the payload is ElGamal keys and a split
      // schedule, and nothing the desk gates on comes from inside it.
      return { ...base, truncated: p.length < 129 };
    case 18: // MetadataPointer — authority, metadata_address
      return {
        ...base,
        truncated: p.length < 64,
        pointerAuthority: nullablePubkey(p, 0),
        metadataAddress: nullablePubkey(p, 32),
      };
    case 19: // TokenMetadata — variable-length Borsh
      return {
        ...base,
        truncated: p.length < 64,
        metadata: decodeTokenMetadata(p),
      };
    case 4: // ConfidentialTransferMint — 65 bytes, presence only
      return { ...base, truncated: p.length < 65 };
    default:
      return base;
  }
}

// ─────────────────────────────────────────────────────────────── tlv walk

/**
 * Walk the TLV region.
 *
 * Stops at the `Uninitialized` (type 0) terminator, at the end of the buffer, or
 * at the first entry that overruns it. An entry that overruns is recorded in
 * `malformed` and the walk ends, because a declared length is the only thing that
 * locates the NEXT entry: once one is wrong, every later offset is a guess, and
 * guessing would be worse than saying so.
 *
 * A trailing remainder too short to hold a 4-byte header is also recorded, since
 * that is either truncation or padding and the two should not look the same.
 */
function parseTlv(
  bytes: Uint8Array,
  start: number,
): { extensions: Token2022Extension[]; malformed: string[]; end: number } {
  const extensions: Token2022Extension[] = [];
  const malformed: string[] = [];
  let off = start;
  let end = start;

  while (off < bytes.length) {
    if (!has(bytes, off, 4)) {
      malformed.push(
        `trailing ${bytes.length - off} byte(s) at offset ${off} cannot hold a TLV header`,
      );
      end = off;
      break;
    }
    const type = u16le(bytes, off);
    const len = u16le(bytes, off + 2);
    if (type === 0) {
      // Uninitialized terminates the list; everything after is zero padding.
      end = off;
      break;
    }
    const dataStart = off + 4;
    if (!has(bytes, dataStart, len)) {
      malformed.push(
        `extension type ${type} declares ${len} bytes at offset ${dataStart} but only ${bytes.length - dataStart} remain`,
      );
      end = off;
      break;
    }
    extensions.push(decodeExtension(type, bytes.subarray(dataStart, dataStart + len)));
    off = dataStart + len;
    end = off;
  }

  return { extensions, malformed, end };
}

// ─────────────────────────────────────────────────────────────── entry point

/**
 * Decode a mint account's bytes. Pure, no network, never throws.
 *
 * Returns `null` when the account cannot be a mint at all:
 *   · shorter than the 82-byte SPL mint struct;
 *   · long enough to carry an `AccountType` byte that is not `Mint` (a token
 *     account decodes to `null` here — this scanner only judges mints).
 *
 * An 82-byte account has no `AccountType` byte, so it cannot be told apart from a
 * legacy SPL mint by bytes alone; that case returns `ambiguous: true` and no
 * extensions, and the caller supplies the owner program.
 */
export function decodeToken2022(bytes: Uint8Array): Token2022Info | null {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length < MINT_SIZE) return null;

  const base = decodeMint(bytes);
  if (!base) return null;
  const initialized = (bytes[45] ?? 0) !== 0;

  const accountType = u8(bytes, ACCOUNT_TYPE_OFFSET);

  if (accountType === null) {
    // No room for the discriminant: 82..165 bytes. No TLV region either.
    return {
      isToken2022Mint: false,
      ambiguous: true,
      accountType: null,
      initialized,
      base,
      extensions: [],
      malformed: [],
      tlvEnd: MINT_SIZE,
    };
  }

  if (accountType !== ACCOUNT_TYPE_MINT) return null;

  const { extensions, malformed, end } = parseTlv(bytes, TLV_START);
  return {
    isToken2022Mint: true,
    ambiguous: false,
    accountType,
    initialized,
    base,
    extensions,
    malformed,
    tlvEnd: end,
  };
}

// ─────────────────────────────────────────────────────────────── fee selection

export interface TransferFeeSelection {
  rates: TransferFeeRates;
  /**
   * Which schedule the number came from. `'worst-case'` means no epoch was
   * available, so the higher of the two is reported as an explicitly labelled
   * upper bound rather than as the answer.
   */
  basis: 'older' | 'newer' | 'worst-case';
}

/**
 * Pick the fee schedule that applies at `epoch`.
 *
 * Mirrors `TransferFeeConfig::get_epoch_fee`: the newer schedule applies from
 * `newer.epoch` onwards, the older one before that. With no epoch the answer is
 * the worst case, labelled — because reporting the older (possibly 5x higher)
 * schedule as "the" fee would be a different kind of wrong.
 */
export function selectTransferFeeRates(
  older: TransferFeeRates | null,
  newer: TransferFeeRates | null,
  epoch: number | null,
): TransferFeeSelection | null {
  if (!older && !newer) return null;
  if (!newer) return { rates: older as TransferFeeRates, basis: 'older' };
  if (!older) return { rates: newer, basis: 'newer' };
  if (epoch === null || !Number.isFinite(epoch)) {
    return newer.basisPoints >= older.basisPoints
      ? { rates: newer, basis: 'worst-case' }
      : { rates: older, basis: 'worst-case' };
  }
  return epoch >= newer.epoch ? { rates: newer, basis: 'newer' } : { rates: older, basis: 'older' };
}

// ─────────────────────────────────────────────────────────────── findings

export type Token2022Risk =
  | 'permanent_delegate'
  | 'default_frozen'
  | 'transfer_hook'
  | 'non_transferable'
  | 'transfer_fee'
  | 'mint_close_authority'
  // Informational classes. Reported because their absence would be a blind spot,
  // not because they are risks: see the detail strings.
  | 'close'
  | 'interest_bearing'
  | 'memo_transfer'
  | 'cpi_guard'
  | 'metadata';

export type Severity = 'high' | 'medium' | 'low' | 'info';

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export interface Token2022Finding {
  id: string;
  ts: number;
  /** The mint the finding is about. It is also the account that proves it. */
  subject: string;
  risk: Token2022Risk;
  /** Evidence, always naming the address it was read from. */
  detail: string;
  evidenceAccount: string;
  severity: Severity;
  firstSeen: number;
}

/**
 * Turn one decoded mint into findings.
 *
 * The risk class is the EXTENSION; the severity says whether that extension is
 * currently dangerous. That split is what keeps this honest: `PendingDelegate`
 * with a None delegate, `DefaultAccountState(initialized)` and a transfer hook
 * with no program are all the same extension as their dangerous siblings but
 * cannot do anything, and they are reported as `info` rather than promoted.
 *
 * `epoch` is optional and only affects `TransferFeeConfig`. When it is null the
 * fee is reported as the worst case and says so.
 */
export function classifyToken2022(
  subject: string,
  info: Token2022Info,
  now = Date.now(),
  epoch: number | null = null,
): Token2022Finding[] {
  const out: Token2022Finding[] = [];
  const add = (risk: Token2022Risk, severity: Severity, detail: string): void => {
    out.push({
      id: newId('t22'),
      ts: now,
      subject,
      risk,
      detail,
      evidenceAccount: subject,
      severity,
      firstSeen: now,
    });
  };

  for (const ext of info.extensions) {
    switch (ext.name) {
      case 'PermanentDelegate': {
        if (ext.truncated) {
          // A short payload is NOT the same fact as an all-zero one: we do not
          // know whether this delegate is None, so we do not claim it.
          add(
            'permanent_delegate',
            'info',
            `PermanentDelegate payload is ${ext.dataLength} bytes (needs 32): delegate UNREAD, so the extension is not judged`,
          );
        } else if (ext.delegate) {
          add(
            'permanent_delegate',
            'high',
            `permanent delegate ${ext.delegate} may transfer or burn ANY holder's tokens with no signature and no expiry`,
          );
        } else {
          add(
            'permanent_delegate',
            'info',
            'PermanentDelegate present but its delegate is all-zero (None): the extension is inert',
          );
        }
        break;
      }
      case 'DefaultAccountState': {
        if (ext.accountState === 'frozen') {
          add(
            'default_frozen',
            'high',
            'new token accounts start FROZEN: a buyer receives tokens it cannot move until the freeze authority thaws the account',
          );
        } else if (ext.accountState === 'initialized') {
          add('default_frozen', 'info', 'default account state is initialized (normal)');
        } else {
          add(
            'default_frozen',
            'info',
            `default account state byte ${ext.stateByte} is not a known value (0/1/2), so it is not judged`,
          );
        }
        break;
      }
      case 'TransferHook': {
        if (ext.truncated) {
          add(
            'transfer_hook',
            'info',
            `TransferHook payload is ${ext.dataLength} bytes (needs 64): program_id UNREAD, so the hook is not judged either way`,
          );
        } else if (ext.programId) {
          add(
            'transfer_hook',
            'medium',
            `every transfer executes hook program ${ext.programId}, which may reject any transfer including a sell`,
          );
        } else {
          // The PYUSD case. program_id is MaybeNull::NONE, so no program runs and
          // the extension cannot affect a transfer. Calling this a live hook
          // would invent a honeypot capability.
          add(
            'transfer_hook',
            'info',
            'TransferHook present but its program_id is all-zero (None): the hook is INERT and no program runs on transfer',
          );
        }
        break;
      }
      case 'NonTransferable': {
        add(
          'non_transferable',
          'medium',
          'NonTransferable: holders cannot transfer these tokens at all, so a DEX exit is impossible (only mint and burn move supply)',
        );
        break;
      }
      case 'TransferFeeConfig': {
        const fee = ext.transferFee;
        if (!fee) break;
        const sel = selectTransferFeeRates(fee.older, fee.newer, epoch);
        if (!sel) {
          add('transfer_fee', 'info', 'TransferFeeConfig present but neither fee schedule could be read');
          break;
        }
        const bps = sel.rates.basisPoints;
        const severity: Severity = bps >= 500 ? 'medium' : bps > 0 ? 'low' : 'info';
        const differ =
          fee.older && fee.newer && fee.older.basisPoints !== fee.newer.basisPoints
            ? ` (older ${fee.older.basisPoints} bps from epoch ${fee.older.epoch}, newer ${fee.newer.basisPoints} bps from epoch ${fee.newer.epoch})`
            : '';
        add(
          'transfer_fee',
          severity,
          `transfer fee ${bps} bps on the ${sel.basis} schedule${differ}: every transfer is taxed, so a round trip pays it twice`,
        );
        break;
      }
      case 'MintCloseAuthority': {
        if (ext.truncated) {
          add(
            'mint_close_authority',
            'info',
            `MintCloseAuthority payload is ${ext.dataLength} bytes (needs 32): close authority UNREAD, not judged`,
          );
        } else if (ext.closeAuthority) {
          add(
            'mint_close_authority',
            'low',
            `close authority ${ext.closeAuthority} may close the mint account once supply reaches zero, taking the rent and ending the address`,
          );
        } else {
          add('close', 'info', 'MintCloseAuthority present but renounced (all-zero): the mint can never be closed');
        }
        break;
      }
      case 'InterestBearingConfig': {
        const ib = ext.interestBearing;
        add(
          'interest_bearing',
          'info',
          ib
            ? `interest-bearing display rate ${ib.currentRateBps} bps (a UI multiplier only: balances and transfers do not change)`
            : 'interest-bearing config present (payload too short to read the rate)',
        );
        break;
      }
      case 'MemoTransfer': {
        if (ext.memoRequired) {
          add(
            'memo_transfer',
            'info',
            'incoming transfers must carry a memo: a sender that omits one cannot deliver',
          );
        }
        break;
      }
      case 'CpiGuard': {
        if (ext.cpiGuardEnabled) {
          add(
            'cpi_guard',
            'info',
            'CPI guard is ON: blocks program-driven transfers out of the owner account (a protection, not a risk)',
          );
        }
        break;
      }
      case 'MetadataPointer': {
        add(
          'metadata',
          'info',
          `metadata pointer -> ${ext.metadataAddress ?? 'None'} (pointer authority ${ext.pointerAuthority ?? 'None'})`,
        );
        break;
      }
      case 'TokenMetadata': {
        const md = ext.metadata;
        if (!md) break;
        add(
          'metadata',
          'info',
          `metadata "${md.name}" (${md.symbol})${md.complete ? '' : ' [truncated]'}${
            md.updateAuthority
              ? `, update authority ${md.updateAuthority} can rewrite it`
              : ', update authority renounced'
          }`,
        );
        break;
      }
      case 'TransferFeeAmount':
      case 'ConfidentialTransferMint':
      case 'ConfidentialTransferFeeConfig':
        // Present and counted, but nothing the desk gates on lives in them.
        break;
      default: {
        // An ordinal we do not decode. Saying so beats omitting it: the count on
        // the renderer must match what is actually on the account.
        add(
          'metadata',
          'info',
          `unverified extension type ${ext.type} (${ext.dataLength} bytes): layout not decoded here, reported by ordinal only`,
        );
        break;
      }
    }
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.risk.localeCompare(b.risk));
}

// ─────────────────────────────────────────────────────────────── rpc

/**
 * Endpoint order is not cosmetic. `getProgramAccounts` and
 * `getTokenAccountsByOwner` are blocked on publicnode, and a JSON-RPC error makes
 * this loop try the next host — so a blocked host in first position would report
 * every mint unreadable.
 */
const RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];

interface AccountInfo {
  lamports: number;
  owner: string;
  executable: boolean;
  dataBase64: string;
}

async function rpcOnce<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    // A rate-limit error is not "no such account". Treating it as one is how an
    // unread mint becomes a clean one.
    if (j.error) return null;
    return j.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function rpc<T>(method: string, params: unknown[], timeoutMs = 12_000): Promise<T | null> {
  for (const url of RPCS) {
    const r = await rpcOnce<T>(url, method, params, timeoutMs);
    if (r !== null) return r;
  }
  return null;
}

/** Read one account, base64. */
async function getAccount(address: string): Promise<AccountInfo | null> {
  const r = await rpc<{
    value: { lamports: number; owner: string; executable: boolean; data: [string, string] } | null;
  }>('getAccountInfo', [address, { encoding: 'base64' }]);
  const v = r?.value;
  if (!v) return null;
  return { lamports: v.lamports, owner: v.owner, executable: v.executable, dataBase64: v.data?.[0] ?? '' };
}

/**
 * The outcome of one account read, as three DISTINCT facts.
 *
 * This distinction is the whole honesty invariant, and collapsing it is how a
 * bot reports a clean zero:
 *
 *   · `account` — the bytes were read. They can be judged.
 *   · `absent`  — the RPC answered and there is no account at that address. That
 *     is a real, knowable fact (a nonexistent mint has no extensions), but it is
 *     NOT a judgement about a mint.
 *   · `failed`  — the RPC never answered (error, rate limit, timeout). We know
 *     NOTHING. This is the one that must never be reported as clean.
 *
 * `getAccountInfo` returns `value: null` for `absent` and throws/errors for
 * `failed`, which is exactly the pairing a JSON-RPC error handler erases if it
 * treats both as "null".
 */
type AccountRead =
  | { kind: 'account'; acc: AccountInfo }
  | { kind: 'absent' }
  | { kind: 'failed' };

async function readAccount(address: string): Promise<AccountRead> {
  // `rpc()` returns null when EVERY endpoint errored — but `result.value: null`
  // is a successful answer saying "no such account". Re-asking once through the
  // same helper cannot tell them apart, so read the raw envelope here.
  for (const url of RPCS) {
    const r = await rpcOnce<{
      value: { lamports: number; owner: string; executable: boolean; data: [string, string] } | null;
    }>(url, 'getAccountInfo', [address, { encoding: 'base64' }], 12_000);
    if (r === null) continue; // this endpoint errored: try the next
    const v = r.value;
    if (!v) return { kind: 'absent' };
    return {
      kind: 'account',
      acc: { lamports: v.lamports, owner: v.owner, executable: v.executable, dataBase64: v.data?.[0] ?? '' },
    };
  }
  return { kind: 'failed' };
}

/**
 * The cluster epoch, read once per tick so `TransferFeeConfig` can be resolved
 * exactly instead of reported as a worst case. One subrequest for the whole tick.
 */
async function getEpoch(): Promise<number | null> {
  const r = await rpc<{ epoch: number }>('getEpochInfo', []);
  const e = r?.epoch;
  return typeof e === 'number' && Number.isFinite(e) ? e : null;
}

function toBytes(b64: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─────────────────────────────────────────────────────────────── state

export interface Token2022Stats {
  /** Accounts read successfully AND decoded as a mint shape. */
  mintsChecked: number;
  /** Of those, how many the owner program or the AccountType byte proves are Token-2022. */
  token2022: number;
  /** Total extensions decoded across those mints (including ones we do not name). */
  extensions: number;
  findings: number;
  /** Findings at high or medium — the ones worth a human read. */
  risky: number;
  /** Transfer hooks with a None program_id: present, inert, not counted as risk. */
  inertHooks: number;
  /** Accounts read successfully that are not mint-shaped (e.g. a token account). */
  notMints: number;
  /**
   * Addresses the RPC answered for that hold NO account. A knowable fact, and
   * distinct from `unreadable`: there is nothing there to judge.
   */
  absent: number;
  /** Accounts the RPC did not answer for at all. These are NOT clean. */
  unreadable: number;
  /** Inputs dropped because the subrequest budget ran out before they were read. */
  skipped: number;
  /** True when no inputs existed at all — a zero here means "nothing looked at". */
  noInputs: boolean;
  /** Cluster epoch used to resolve fee schedules; null when the RPC would not say. */
  epoch: number | null;
  ticks: number;
  lastTickMs: number;
}

const KV_STATS = 'token2022_stats';

interface Persisted {
  stats: Token2022Stats;
  findings: Token2022Finding[];
}

function emptyStats(): Token2022Stats {
  return {
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
    ticks: 0,
    lastTickMs: 0,
  };
}

async function readPersisted(env: DeskEnv): Promise<Persisted> {
  const empty: Persisted = { stats: emptyStats(), findings: [] };
  try {
    const raw = await kvGet(env, KV_STATS);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Persisted;
    if (!p?.stats || !Array.isArray(p.findings)) return empty;
    // Merge over the defaults so a state written by an older build (missing the
    // fields added since) still renders instead of printing `undefined`.
    return { stats: { ...emptyStats(), ...p.stats }, findings: p.findings };
  } catch {
    return empty;
  }
}

export async function token2022Status(env: DeskEnv): Promise<Token2022Stats> {
  return (await readPersisted(env)).stats;
}

export async function token2022Findings(env: DeskEnv): Promise<Token2022Finding[]> {
  return (await readPersisted(env)).findings;
}

// ─────────────────────────────────────────────────────────────── inputs

/**
 * The mints to inspect: everything the desk universe has seen, UNION an explicit
 * env seed.
 *
 * No `state` filter on purpose. An extension is a permanent property of the mint
 * account, and a token the scout killed still has holders who can be frozen — so
 * excluding 'killed'/'expired' would throw away exactly the mints where a
 * permanent delegate still matters. Newest first, because the recent ones are the
 * ones the desk is actually looking at.
 *
 * The seed exists so the bot is testable and useful before `desk_universe` has a
 * single Solana row.
 */
export async function token2022Inputs(env: DeskEnv, limit = 25): Promise<string[]> {
  const out: string[] = [];
  try {
    const rows = await db(env).all<{ mint: string | null }>(
      `SELECT mint FROM desk_universe WHERE mint IS NOT NULL ORDER BY last_seen DESC LIMIT ?`,
      limit,
    );
    for (const r of rows) {
      const mint = (r.mint ?? '').trim();
      if (mint && isSolanaPubkey(mint) && !out.includes(mint)) out.push(mint);
    }
  } catch {
    // Fall through to the env seed: a missing table must not empty the input set.
  }

  // `DeskEnv` in types.ts does not declare this yet. Read it through a cast rather
  // than widening the shared type here; the parent should add the field.
  const seed = (env as unknown as { DESK_TOKEN2022_MINTS?: string }).DESK_TOKEN2022_MINTS;
  for (const mint of String(seed ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (isSolanaPubkey(mint) && !out.includes(mint)) out.push(mint);
  }

  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────── tick

/**
 * One read-only pass over the candidate mints.
 *
 * Costs one subrequest per mint plus one for the epoch, and stops cleanly when
 * the daily budget runs out rather than starving the crawler. It reads; it cannot
 * mint, freeze, delegate or transfer. That is the point — the extensions are
 * visible to anyone who reads the account, so the edge is in reading them
 * correctly and reporting them without overstatement.
 */
export async function runToken2022Bot(env: DeskEnv, now = Date.now()): Promise<Token2022Stats> {
  const prev = await readPersisted(env);
  const mints = await token2022Inputs(env);

  const findings: Token2022Finding[] = [];
  let mintsChecked = 0;
  let token2022 = 0;
  let extCount = 0;
  let inertHooks = 0;
  let notMints = 0;
  let absent = 0;
  let unreadable = 0;
  let skipped = 0;
  let epoch: number | null = null;

  // One subrequest for the epoch, and only when there is something to check.
  if (mints.length > 0 && (await spendSubrequest(env, 1))) {
    epoch = await getEpoch();
  }

  for (const mint of mints) {
    if (!(await spendSubrequest(env, 1))) {
      // Budget exhausted: everything left is UNREAD, not clean.
      skipped++;
      continue;
    }
    const read = await readAccount(mint);
    if (read.kind === 'failed') {
      // RPC error, rate limit or timeout: we know nothing about this mint.
      unreadable++;
      continue;
    }
    if (read.kind === 'absent') {
      // The RPC answered: no account exists here. Knowable, but not a judgement.
      absent++;
      continue;
    }
    const acc = read.acc;

    const info = decodeToken2022(toBytes(acc.dataBase64));
    if (!info) {
      notMints++;
      continue;
    }
    mintsChecked++;

    // The owner program resolves the one thing bytes alone cannot: an 82-byte
    // account is a valid mint under BOTH token programs.
    const isToken2022Account = acc.owner === SPL_TOKEN_2022_PROGRAM || info.isToken2022Mint;
    if (!isToken2022Account) continue;
    token2022++;
    extCount += info.extensions.length;

    for (const f of classifyToken2022(mint, info, now, epoch)) {
      if (f.risk === 'transfer_hook' && f.severity === 'info') inertHooks++;
      findings.push(f);
    }
  }

  // Preserve firstSeen (and the id) across ticks so the log shows when a risk
  // appeared rather than when it was last re-read — same merge as hunter.ts.
  const known = new Map(prev.findings.map((f) => [`${f.subject}:${f.risk}`, f]));
  for (const f of findings) {
    const k = `${f.subject}:${f.risk}`;
    const old = known.get(k);
    if (old) {
      f.firstSeen = old.firstSeen;
      f.id = old.id;
    }
    known.set(k, f);
  }

  const merged = Array.from(known.values()).sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.ts - a.ts,
  );

  const stats: Token2022Stats = {
    mintsChecked,
    token2022,
    extensions: extCount,
    findings: known.size,
    risky: merged.filter((f) => f.severity === 'high' || f.severity === 'medium').length,
    inertHooks,
    notMints,
    absent,
    unreadable,
    skipped,
    noInputs: mints.length === 0,
    epoch,
    ticks: prev.stats.ticks + 1,
    lastTickMs: now,
  };

  await kvSet(env, KV_STATS, JSON.stringify({ stats, findings: merged.slice(0, 200) }));
  return stats;
}

// ─────────────────────────────────────────────────────────────── render

export function renderToken2022(stats: Token2022Stats, findings: Token2022Finding[]): string {
  if (stats.noInputs) {
    return [
      'token-2022 scanner',
      '  inputs     NONE — desk_universe has no mint and DESK_TOKEN2022_MINTS is empty',
      '  note       this is "nothing looked at", not "nothing wrong". Seed',
      '             DESK_TOKEN2022_MINTS or let the desk universe fill first.',
    ].join('\n');
  }

  const risky = findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
  const lines = [
    'token-2022 scanner',
    `  checked    ${stats.mintsChecked} mints read, ${stats.token2022} token-2022, ${stats.extensions} extensions`,
    `  findings   ${stats.findings} (${risky.length} high/medium)`,
  ];

  if (stats.inertHooks > 0) {
    lines.push(`  inert      ${stats.inertHooks} transfer hook(s) with no program — present but cannot block a transfer`);
  }
  if (stats.notMints > 0) {
    lines.push(`  not-mint   ${stats.notMints} accounts read but not mint-shaped, so not judged`);
  }
  lines.push(
    stats.epoch === null
      ? '  fee epoch  UNKNOWN — fee schedules are reported as their worst case, not as the live rate'
      : `  fee epoch  ${stats.epoch} — fee schedules resolved to the epoch the chain is in`,
  );
  if (stats.absent > 0) {
    lines.push(`  absent     ${stats.absent} address(es) hold no account — nothing there to judge`);
  }
  if (stats.unreadable > 0) {
    lines.push(`  unreadable ${stats.unreadable} — RPC did not answer, so these are NOT clean`);
  }
  if (stats.skipped > 0) {
    // Said out loud rather than left implicit: an input we did not get to is not
    // an input that came back clean.
    lines.push(`  skipped    ${stats.skipped} — subrequest budget ran out before these were read`);
  }
  if (
    stats.mintsChecked === 0 &&
    stats.unreadable === 0 &&
    stats.skipped === 0 &&
    stats.absent === 0 &&
    stats.notMints === 0
  ) {
    // The RPC answered for every input, none was a mint, and nothing was even
    // classified. Stated rather than left as an unexplained "0 findings".
    lines.push('  note       no input produced a mint to judge — this is not a clean result');
  }
  for (const f of risky.slice(0, 5)) {
    lines.push(`  · ${f.subject.slice(0, 12)}… ${f.risk} (${f.severity}): ${f.detail}`);
  }
  return lines.join('\n');
}

export { SPL_TOKEN_2022_PROGRAM, encodeBase58 };
