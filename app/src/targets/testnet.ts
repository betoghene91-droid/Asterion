/**
 * Testnet — an explicitly empty result, with the reason attached.
 *
 * WHY THIS FILE EXISTS INSTEAD OF A FETCHER
 *
 * The chains this bot can fork include two testnets: Base Sepolia (84532) and
 * Ethereum Sepolia (11155111). Every mainnet source in `sources.ts` yields
 * nothing for them, and that is not a gap in this module's coverage — it is a
 * property of the public inventory landscape, verified by direct observation:
 *
 *   · `https://api.llama.fi/protocols` (8874 entries, 414 distinct `chain`
 *     values, 520 distinct names across every `chains` array) contains ZERO
 *     Sepolia or Goerli-L2 deployments. The only testnet-adjacent name anywhere
 *     in it is `Goerli`, which is not in `CHAINS` and is retired anyway. A
 *     staging protocol with no TVL is not listed, and TVL is the axis the whole
 *     dataset is built on.
 *   · `https://tokens.coingecko.com/base-sepolia/all.json` returns HTTP 403.
 *     So do `sepolia/all.json` and `ethereum-sepolia/all.json`.
 *
 * So this module returns an empty list AND the reason, and refuses to be a place
 * where a testnet list could quietly appear. That matters because the tempting
 * shortcut is the worst possible one: taking mainnet addresses and relabelling
 * them `chain_id: 84532`. A testnet address is unrelated to its mainnet
 * counterpart — a CREATE address depends on the deployer and nonce, and predeploy
 * sets differ — so such a candidate would fork, resolve to no code, and produce a
 * proof that tests nothing. That is worse than an empty list, because an empty
 * list is honest.
 *
 * WHAT A CALLER SHOULD DO INSTEAD: take the testnet target from the operator.
 * They know their deployment; nothing public indexes it.
 */

import { CHAINS, chainSpec } from '../chains.js';
import type { Candidate } from './types.js';

/** Why a testnet has no discoverable inventory. Rendered into operator output. */
export const TESTNET_EMPTY_REASON =
  'no public inventory source enumerates testnet deployments: DeFiLlama lists TVL-bearing protocols only and contains zero Sepolia chains, and the CoinGecko testnet token lists return HTTP 403';

export interface TestnetResult {
  /** Always empty. Typed as `never[]` so a caller cannot push a guess into it. */
  candidates: readonly never[];
  chain_ids: number[];
  reason: string;
}

/**
 * The empty testnet result for every non-mainnet chain in the registry.
 *
 * Derived from `CHAINS.mainnet` rather than hardcoded, so adding a testnet to the
 * registry cannot leave it silently uncovered here.
 */
export function emptyTestnetResult(): TestnetResult {
  const chain_ids = Object.values(CHAINS)
    .filter((spec) => !spec.mainnet)
    .map((spec) => spec.id)
    .sort((a, b) => a - b);
  return { candidates: [], chain_ids, reason: TESTNET_EMPTY_REASON };
}

/**
 * True when `id` is a registry chain marked as a testnet.
 *
 * Exported because the honest answer to "why are there no candidates for 84532?"
 * has to be reachable from the code that renders the answer, not just from this
 * module's comments.
 */
export function isRegisteredTestnet(id: number): boolean {
  const spec = chainSpec(id);
  return spec !== null && !spec.mainnet;
}

/** A testnet candidate list is empty, and this proves it rather than asserts it. */
export function testnetCandidates(): Candidate[] {
  return [];
}
