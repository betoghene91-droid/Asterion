/**
 * Base58 and the Solana shortvec, because the desk has zero runtime
 * dependencies and a `simulateTransaction` probe needs both.
 *
 * ## Why this exists instead of a package
 *
 * The honeypot probe builds a real SPL `transferChecked` instruction and asks
 * the RPC to simulate it. That means producing the exact wire bytes of a
 * transaction message. The two things needed are base58 (public keys travel as
 * base58) and shortvec (the compact "number of items" encoding Solana uses for
 * arrays).
 *
 * Both were verified against live RPC traffic rather than from memory, and the
 * gotchas are recorded here because each one silently corrupts a payload:
 *
 *  - A base58 string can decode to 33 bytes. `b58decode` pads for leading '1'
 *    characters and returns whatever length the value needs, so callers must
 *    check. `publicKey` is the checked variant and is what the probe uses.
 *  - A message that omits its 32-byte recent blockhash fails to deserialize with
 *    `Attempting to read 32 bytes`. That error is a length complaint from
 *    `solana_transaction::versioned::VersionedTransaction`, not a semantic one.
 *  - The account-key section starts with a shortvec count, which is one byte
 *    below 128. Omitting it shifts every subsequent byte and produces
 *    `Attempting to read 1024 bytes`.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Reverse lookup, built once. */
const INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i] as string] = i;
  return m;
})();

/**
 * Decode base58 to bytes.
 *
 * Throws on a character outside the alphabet rather than returning a partial
 * buffer: a key that does not round-trip must never reach a simulation, because
 * the failure would look like a token problem instead of a bug here.
 */
export function b58decode(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length === 0) throw new Error('b58decode: empty input');
  let n = 0n;
  for (const ch of s) {
    const v = INDEX[ch];
    if (v === undefined) throw new Error(`b58decode: bad character ${JSON.stringify(ch)}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Every leading '1' is a leading zero byte.
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

/** Decode base58 and require exactly `size` bytes (32 for a public key). */
export function publicKey(s: string, size = 32): Uint8Array {
  const raw = b58decode(s);
  if (raw.length !== size) {
    throw new Error(`publicKey: ${s} decoded to ${raw.length} bytes, expected ${size}`);
  }
  return raw;
}

/** Encode bytes as base58. */
export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    s = (ALPHABET[r] as string) + s;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + s;
}

/**
 * The Solana "shortvec": a length encoded in 7-bit groups, low bits first, with
 * the high bit set on every byte but the last.
 *
 * All the message bodies here are far below 128 items, so the common path is one
 * byte. Implemented properly anyway: an instruction count of 128 is not
 * impossible for a swap route, and a wrong length prefix is a silent
 * deserialize failure.
 */
export function shortvec(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`shortvec: bad length ${n}`);
  const out: number[] = [];
  let v = n;
  for (;;) {
    let byte = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(byte);
      break;
    }
    byte |= 0x80;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

/** Concatenate byte arrays. */
export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Hex, for a request digest. */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** UTF-8 bytes, for hashing a request body exactly as sent. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
