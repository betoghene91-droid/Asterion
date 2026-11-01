/**
 * entropy — the derivation families the sweep was blind to.
 *
 * ## The hole
 *
 * `sweep.ts` derives an address one way: sha256(passphrase) as the ed25519 seed.
 * That is the BITCOIN brainwallet convention. Every Solana wallet made from a
 * 12-word phrase uses a different one — BIP39 (PBKDF2-HMAC-SHA512, 2048 rounds)
 * into SLIP-0010 hardened derivation — and winds up at an address sha256 can
 * never reach. A phrase sweep that only tries sha256 is not slow coverage of the
 * mnemonic population, it is ZERO coverage of it, forever.
 *
 * ## What this adds
 *
 * A second axis. The same plaintext is now worth several addresses:
 *   raw      sha256(p)                      the old stream, unchanged
 *   bip39    mnemonic -> PBKDF2 -> SLIP10   every wallet seeded by a phrase
 * and the bip39 axis carries an derivation INDEX, because one mnemonic is not one
 * address. Phantom, Solflare and the Solana CLI all derive at m/44'/501'/i'/0',
 * so index 0..15 is 16 real wallets per phrase, not padding.
 *
 * ## Why it is not a bigger version of the same miss
 *
 * The old stream was word x suffix x case: 4,686 phrases, re-walked every 9
 * hours, so a miss was re-paid forever. This stream is a product that grows
 * without a fixed end, and the cursor only moves forward. Nothing is re-checked.
 *
 * ## The honest limit
 *
 * BIP39 is 128 bits of entropy when a wallet generates it properly. This cannot
 * guess a real one. It only reaches phrases a human TYPED or PASTED: library test
 * vectors, repeated-word phrases, and the short phrases people post in tutorials
 * and screenshots. Those are the mnemonics that end up funded on mainnet, and
 * nothing in the old sweep could see them.
 */

import { b58encode, publicKey as b58publicKey } from './base58.js';
import { isSolanaPubkey } from '../solana.js';

// ──────────────────────────────────────────────────── primitive byte helpers

const enc = new TextEncoder();

function hexToBytes(h: string): Uint8Array {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
}

function b64urlToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + (b.length % 4 ? '='.repeat(4 - (b.length % 4)) : ''));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer));
}

async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', k, data as unknown as ArrayBuffer),
  );
}

/** ed25519 public key from a 32-byte seed. WebCrypto has no raw export. */
export async function pubFromSeed(seed: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    cat([hexToBytes('302e020100300506032b657004220420'), seed]) as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', key)) as { x?: string };
  return b58encode(b64urlToBytes(jwk.x ?? ''));
}

function cat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const o = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    o.set(p, at);
    at += p.length;
  }
  return o;
}

// ──────────────────────────────────────────────────────── BIP39 + SLIP-0010

/**
 * BIP39: mnemonic -> 64-byte seed.
 *
 * The salt is "mnemonic" + passphrase (empty here, which is what every wallet
 * does unless the user set a 25th word). 2048 rounds, HMAC-SHA512 — the round
 * count and the hash are both load-bearing, and getting either wrong produces a
 * valid-looking wrong key.
 */
export async function mnemonicToSeed(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  const m = mnemonic.normalize('NFKD');
  const salt = enc.encode(('mnemonic' + passphrase).normalize('NFKD'));
  const base = await crypto.subtle.importKey('raw', enc.encode(m), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: 2048, hash: 'SHA-512' },
    base,
    512,
  );
  return new Uint8Array(bits);
}

export interface Slip10Node {
  key: Uint8Array;
  chain: Uint8Array;
}

/**
 * SLIP-0010 ed25519 master node.
 *
 * `"ed25519 seed"` is the literal HMAC key from the spec. It is not a variable
 * and it is not derived from anything.
 */
export async function slip10Master(seed: Uint8Array): Promise<Slip10Node> {
  const I = await hmacSha512(enc.encode('ed25519 seed'), seed);
  return { key: I.slice(0, 32), chain: I.slice(32) };
}

/**
 * One hardened child. ed25519 supports ONLY hardened derivation, so the index
 * carries the high bit always: data = 0x00 || key || ser32(index | 0x80000000).
 */
export async function slip10Child(parent: Slip10Node, index: number): Promise<Slip10Node> {
  const data = new Uint8Array(37);
  data[0] = 0;
  data.set(parent.key, 1);
  const idx = (index | 0x80000000) >>> 0;
  data[33] = (idx >>> 24) & 0xff;
  data[34] = (idx >>> 16) & 0xff;
  data[35] = (idx >>> 8) & 0xff;
  data[36] = idx & 0xff;
  const I = await hmacSha512(parent.chain, data);
  return { key: I.slice(0, 32), chain: I.slice(32) };
}

/** m/44'/501'/{account}'/0' — the path every Solana wallet family uses. */
export async function solanaPath(seed: Uint8Array, account: number): Promise<Uint8Array> {
  let n = await slip10Master(seed);
  for (const i of [44, 501, account, 0]) n = await slip10Child(n, i);
  return n.key;
}

/**
 * Mnemonic -> Solana address at a derivation index.
 *
 * This is the function the sweep never had. `account` is the only reason one
 * phrase is worth more than one address.
 */
export async function bip39Address(mnemonic: string, account = 0): Promise<string | null> {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) return null;
  const seed = await mnemonicToSeed(mnemonic);
  const key = await solanaPath(seed, account);
  return pubFromSeed(key);
}

// ──────────────────────────────────────────────────────────── the raw family

/** The original stream's derivation, kept address-for-address identical. */
export async function rawAddress(passphrase: string): Promise<string> {
  const seed = await sha256(enc.encode(passphrase));
  return pubFromSeed(seed);
}

// ─────────────────────────────────────────────────────────────── the corpus

/**
 * Mnemonics a human actually typed.
 *
 * Every BIP39 library ships test vectors, and they are all the SAME phrases,
 * and people paste them into mainnet wallets to "test". They are funded often
 * enough to be worth checking, and no sha256 sweep can ever reach them.
 */
export const MNEMONIC_CORPUS: readonly string[] = [
  // The canonical test vector, in all three published forms.
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  // Repeated-word phrases: what a human creates when they think a mnemonic is a
  // password they get to choose.
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo',
  'test test test test test test test test test test test test',
  'hello hello hello hello hello hello hello hello hello hello hello hello',
  'seed seed seed seed seed seed seed seed seed seed seed seed',
  'solana solana solana solana solana solana solana solana solana solana solana solana',
  'money money money money money money money money money money money money',
  'art art art art art art art art art art art art',
];

/** How many derived accounts one mnemonic contributes. Wallets default to 0. */
export const ACCOUNTS_PER_MNEMONIC = 16;

// ────────────────────────────────────────────────────────────── the stream

export interface Candidate {
  /** What this index means, for the hit report. */
  label: string;
  kind: 'raw' | 'bip39';
  address: string;
}

/**
 * One index in the stream, with its derivation family.
 *
 * `space` is computed so the cursor never has to know it: the stream is ordered
 * raw-phrases first, then mnemonic x account, and both dimensions are finite
 * but the product is not re-walked. A miss is paid once.
 */
export async function candidateFor(
  index: number,
  raw: (i: number) => string,
  rawSpace: number,
): Promise<Candidate | null> {
  if (index < rawSpace) {
    const p = raw(index);
    const address = await rawAddress(p);
    return { label: p, kind: 'raw', address };
  }
  const rel = index - rawSpace;
  const mi = Math.floor(rel / ACCOUNTS_PER_MNEMONIC);
  const ai = rel % ACCOUNTS_PER_MNEMONIC;
  const phrase = MNEMONIC_CORPUS[mi];
  if (!phrase) return null;
  const address = await bip39Address(phrase, ai);
  if (!address || !isSolanaPubkey(address)) return null;
  return {
    label: `${phrase.split(' ').slice(0, 3).join(' ')}…/m/44'/501'/${ai}'`,
    kind: 'bip39',
    address,
  };
}

/** Total indices this stream will ever produce. */
export function streamSpace(rawSpace: number): number {
  return rawSpace + MNEMONIC_CORPUS.length * ACCOUNTS_PER_MNEMONIC;
}

/**
 * The signing seed for one index, alongside its address.
 *
 * This exists because `sweepOne` used to re-derive the key with sha256 from the
 * passphrase. For a BIP39 hit that is the WRONG key: the address came from
 * PBKDF2+SLIP10, so signing with sha256 produces a transaction that fails on
 * chain while the balance sits there. Returning both together makes the pair
 * impossible to desynchronise.
 */
export async function candidateSeedFor(
  index: number,
  raw: (i: number) => string,
  rawSpace: number,
): Promise<{ label: string; kind: 'raw' | 'bip39'; address: string; seed: Uint8Array } | null> {
  if (index < rawSpace) {
    const p = raw(index);
    const seed = await sha256(enc.encode(p));
    return { label: p, kind: 'raw', address: await pubFromSeed(seed), seed };
  }
  const rel = index - rawSpace;
  const mi = Math.floor(rel / ACCOUNTS_PER_MNEMONIC);
  const ai = rel % ACCOUNTS_PER_MNEMONIC;
  const phrase = MNEMONIC_CORPUS[mi];
  if (!phrase) return null;
  const mseed = await mnemonicToSeed(phrase);
  const seed = await solanaPath(mseed, ai);
  const address = await pubFromSeed(seed);
  if (!isSolanaPubkey(address)) return null;
  return {
    label: `${phrase.split(' ').slice(0, 3).join(' ')}…/m/44'/501'/${ai}'`,
    kind: 'bip39',
    address,
    seed,
  };
}

export { b58publicKey };
