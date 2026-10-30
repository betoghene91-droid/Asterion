/**
 * Chain-name resolution — source vocabulary mapped onto the one registry.
 *
 * WHY THIS FILE EXISTS
 *
 * Inventory feeds spell chains in their own words: DeFiLlama's `chain` field
 * says `Base`, its `address` prefix says `base`, a token list says `chainId:
 * 8453`. None of those is a chain id this bot can fork until it is resolved
 * through `CHAINS`. The whole point of a candidate is that its `chain_id` is a
 * key of that registry, so resolution is a lookup — never a heuristic, never a
 * "close enough".
 *
 * THE THREE THINGS THAT MUST NOT BE GUESSED
 *
 * 1. A NUMERIC ID IS ONLY A CHAIN IF THE REGISTRY HAS IT. A token list claiming
 *    `chainId: 56` is telling us about BNB Chain; we drop it and count it under
 *    `bsc`. We do not keep the 56 as an unvalidated "chain id" — `policy.ts`
 *    would then authorise a target on a chain nothing can fork.
 *
 * 2. `Multi-Chain` IS NOT A CHAIN. 1904 DeFiLlama entries say it, and 1042 of
 *    those carry an address. It is a claim about the protocol, not the address,
 *    so it resolves to nothing; those records fall back to the address PREFIX
 *    (which does name one chain) or get dropped. The same applies to a null
 *    chain (1537 entries).
 *
 * 3. BARE `sepolia` IS AMBIGUOUS AND STAYS UNRESOLVED. `Base Sepolia` (84532)
 *    and `Ethereum Sepolia` (11155111) are different chains with possibly
 *    colliding addresses. A source that says only `sepolia` has not told us
 *    which, so the qualifier is required. (No current source emits it — see the
 *    README — so this costs nothing and removes a whole class of misfiling.)
 */

import { CHAINS, chainSpec } from '../chains.js';
import type { AddressFamily } from './types.js';

/** Names that describe a protocol's deployment footprint, not an address. */
const NOT_A_CHAIN = new Set(['multi-chain', 'multichain', '']);

/**
 * Names that are genuinely ambiguous between two registry chains and therefore
 * must never resolve. Kept explicit so the intent survives a future alias.
 */
const AMBIGUOUS = new Set(['sepolia', 'testnet', 'mainnet', 'multi']);

/** Normalise a source's spelling: trim, collapse runs of whitespace, lowercase. */
export function normaliseChainName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return n === '' ? null : n;
}

/**
 * Registry name -> id, derived from `CHAINS` rather than restated.
 *
 * Deriving it means adding a chain to the registry automatically makes its name
 * resolvable here, and a renamed chain cannot leave a stale duplicate behind.
 */
function buildNameMap(): Map<string, number> {
  const m = new Map<string, number>();
  for (const spec of Object.values(CHAINS)) {
    const key = normaliseChainName(spec.name);
    if (key) m.set(key, spec.id);
  }
  return m;
}

const NAME_TO_ID = buildNameMap();

/**
 * Source-specific spellings of a registry chain.
 *
 * Each alias is here because a real feed uses it, and each is listed with the
 * reason. Deliberately NOT an alias for:
 *
 *   · `eth`  — DeFiLlama uses the `eth:` prefix on 5 entries and ONE of them
 *              (`Orbit Bridge`) does not list Ethereum in its `chains` array at
 *              all, so the prefix is not trustworthy field-for-field. Those 5
 *              are dropped and counted under `eth`; see the README.
 *   · `sol`  — never observed; mapping a guess would risk colliding with a
 *              Solana-family name we do not control.
 */
const ALIASES: ReadonlyArray<readonly [string, number]> = [
  ['base-sepolia', 84532], // hyphenated form of the registry name
  ['ethereum-sepolia', 11155111],
  ['eth-sepolia', 11155111], // seen in explorer URLs, guarded here for safety
  ['ethereum mainnet', 1], // token-list style spelling
  ['ethereum-mainnet', 1],
  ['base mainnet', 8453],
  ['base-mainnet', 8453],
];

for (const [alias, id] of ALIASES) {
  // An alias may only point at a chain the registry actually has; a typo here
  // would otherwise synthesize a chain id out of thin air.
  if (chainSpec(id)) NAME_TO_ID.set(alias, id);
}

/**
 * Source names that mean Solana. Solana is NOT in `CHAINS` and has no EVM chain
 * id, so it resolves to the SVM family instead of a number.
 */
const SVM_NAMES = new Set(['solana', 'solana mainnet', 'mainnet-beta']);

export type ChainResolution =
  | { kind: 'evm'; chain_id: number; name: string }
  | { kind: 'svm'; name: string }
  /** Named a chain that the registry does not carry — drop, and count by name. */
  | { kind: 'unregistered'; name: string }
  /** Described the protocol, not the address. Fall through to the next signal. */
  | { kind: 'not-a-chain' }
  /** Could not resolve without guessing. Counted, never emitted. */
  | { kind: 'ambiguous'; name: string }
  /** Nothing said a chain at all. */
  | { kind: 'absent' };

/**
 * Resolve one chain NAME (not a numeric id — see {@link resolveChainId}).
 *
 * The `absent` and `not-a-chain` outcomes are distinct on purpose: `absent`
 * means the source was silent, `not-a-chain` means it spoke without naming a
 * chain. Both are "look at the next signal", but they land in different
 * counters so a feed change is visible.
 */
export function resolveChainName(name: unknown): ChainResolution {
  const n = normaliseChainName(name);
  if (n === null) return { kind: 'absent' };
  if (NOT_A_CHAIN.has(n)) return { kind: 'not-a-chain' };
  if (AMBIGUOUS.has(n)) return { kind: 'ambiguous', name: n };
  if (SVM_NAMES.has(n)) return { kind: 'svm', name: 'Solana' };
  const id = NAME_TO_ID.get(n);
  if (id !== undefined) return { kind: 'evm', chain_id: id, name: CHAINS[id]?.name ?? n };
  return { kind: 'unregistered', name: n };
}

/**
 * Resolve a NUMERIC chain id against the registry.
 *
 * Used for token lists, which state `chainId` as a number. An id the registry
 * does not carry is `unregistered` — not a candidate with a stray id.
 */
export function resolveChainId(id: unknown): ChainResolution {
  if (typeof id !== 'number' || !Number.isInteger(id)) return { kind: 'absent' };
  const spec = chainSpec(id);
  if (!spec) return { kind: 'unregistered', name: `chainId:${id}` };
  return { kind: 'evm', chain_id: spec.id, name: spec.name };
}

/** The address family a resolved chain implies. */
export function familyFor(res: ChainResolution): AddressFamily | null {
  if (res.kind === 'evm') return 'evm';
  if (res.kind === 'svm') return 'svm';
  return null;
}

/**
 * Prefix spellings that name a chain. DeFiLlama's address prefixes are its own
 * vocabulary (`avax`, `era`, `bsc`), so only the ones that map onto a registry
 * chain are listed — everything else falls through to `unregistered` naturally.
 */
export function resolveAddressPrefix(prefix: unknown): ChainResolution {
  const n = normaliseChainName(prefix);
  if (n === null) return { kind: 'absent' };
  if (n === 'solana') return { kind: 'svm', name: 'Solana' };
  return resolveChainName(n);
}
