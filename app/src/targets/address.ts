/**
 * Address grammars — two families, two validators, no shared regex.
 *
 * WHY THIS FILE EXISTS
 *
 * `solana.ts` already records the failure this prevents one level up: a base58
 * pubkey matches none of the `/^0x[0-9a-fA-F]{40}$/` checks, falls through to
 * `policy.ts`'s `else` branch, and gets filed as a DOMAIN NAME. The mirror-image
 * failure is just as easy here: run the EVM regex over 4420 DeFiLlama addresses
 * and every Solana address silently disappears into a "malformed" counter that
 * nobody reads.
 *
 * So validation is per-family and the family is decided by the address itself,
 * not by the chain label beside it. A source that labels an address `solana:`
 * but hands us `token/EdAh…` (which DeFiLlama really does, for Fabric) is a
 * malformed record — not a Solana target with a funny-looking address.
 *
 * The Solana check reuses `isSolanaPubkey` from `../solana.js` rather than
 * restating it: that function decodes base58 for real, because a 44-character
 * run of `l` has the right LENGTH and decodes to nothing. A length check here
 * would reintroduce exactly that bug.
 */

import { isSolanaPubkey } from '../solana.js';
import type { AddressFamily } from './types.js';

/** `0x` + exactly 40 hex digits. Anchored both ends; no whitespace tolerance. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** True when `s` is a well-formed 20-byte EVM address. */
export function isEvmAddress(s: unknown): s is string {
  return typeof s === 'string' && EVM_ADDRESS.test(s);
}

/**
 * True when `s` is a base58 string decoding to exactly 32 bytes.
 *
 * Delegates to the registry's decoder so there is one definition of "a pubkey"
 * in this codebase.
 */
export function isSvmAddress(s: unknown): s is string {
  return typeof s === 'string' && isSolanaPubkey(s);
}

/**
 * The family of a bare address, or `null` when it is neither.
 *
 * EVM is tested first only because it is the cheaper regex; the two grammars are
 * disjoint (a 42-char `0x…` string is not base58, since `0` is not in the base58
 * alphabet), so the order cannot change the answer.
 */
export function addressFamily(s: unknown): AddressFamily | null {
  if (isEvmAddress(s)) return 'evm';
  if (isSvmAddress(s)) return 'svm';
  return null;
}

/**
 * Split a DeFiLlama `address` field into its chain prefix and body.
 *
 * The field is `"<chain>:<address>"` for most entries (`base:0x3f5b…`,
 * `solana:CLoUDKc4…`) but is a BARE address for 1166 of them, and some bodies
 * legitimately contain `:` themselves (`sui:0x…::sui::SUI`,
 * `eos:OGX-eos-organixtoken`). So only the FIRST separator is a prefix and the
 * remainder is the address, unsplit.
 *
 * `prefix: null` means "this source did not say which chain" — the caller must
 * fall back to the entry-level chain field or drop the record. It does not mean
 * "unknown chain".
 */
export function splitChainPrefixedAddress(raw: unknown): {
  prefix: string | null;
  body: string;
} | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const sep = trimmed.indexOf(':');
  if (sep < 0) return { prefix: null, body: trimmed };
  const prefix = trimmed.slice(0, sep).trim();
  const body = trimmed.slice(sep + 1).trim();
  // `:0xabc…` with an empty prefix tells us nothing; treat it as unprefixed
  // rather than as a chain named "".
  if (prefix === '') return { prefix: null, body };
  return { prefix, body };
}
