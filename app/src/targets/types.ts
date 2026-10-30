/**
 * Target candidates — the types that make "which chain?" impossible to skip.
 *
 * WHY THIS FILE EXISTS
 *
 * `policy.ts:roeFromBrief` refuses a bare `0x…` target that names no chain
 * ("an address does not identify its chain"), and every downstream gate reasons
 * about `chain_id`. So a candidate record whose chain is optional, inferred, or
 * a free-text string is unusable: it can be discovered and then never
 * authorised. The chain id is therefore a REQUIRED field of the EVM variant, and
 * the only values it can hold are keys of `chains.ts`'s `CHAINS`.
 *
 * THE SOLANA PROBLEM, AND WHY `chain_id` IS `null` THERE
 *
 * Solana has no EVM chain id, and it is not a row in `CHAINS` (1, 8453, 84532,
 * 11155111, 31337). Two rules collide:
 *
 *   · "a candidate without a resolved chain_id is unusable downstream" — so we
 *     cannot simply leave the field off and pretend Solana is a `0x` chain;
 *   · "do not invent chain ids for chains outside the registry" — so we cannot
 *     write `1399811149` or any other number to make the shape uniform.
 *
 * The resolution is the discriminant below. `family` is REQUIRED and every
 * consumer must narrow on it before reading `chain_id`, because on the SVM
 * variant `chain_id` is typed `null`. TypeScript then forces the caller to
 * handle "this is not a forkable-by-id target" at the point of use instead of
 * discovering it at dispatch time. A Solana candidate is representable, carries
 * its own `cluster`, and can never be mistaken for chain 0 or chain 8453.
 */

/** Which address grammar an address obeys. Never inferred from a chain id. */
export type AddressFamily = 'evm' | 'svm';

/**
 * The inventory sources this module knows how to read.
 *
 * A closed union rather than `string`: it is the key of the budget table, the
 * label in every drop/stat record, and the thing the README's counts are
 * reported against.
 */
export type SourceId = 'defillama' | 'coingecko-base' | 'coingecko-uniswap';

export type CandidateKind = 'protocol' | 'token';

interface CandidateBase {
  /**
   * The address exactly as the source published it (EVM casing preserved,
   * base58 preserved — base58 is case-sensitive). Validated against the
   * grammar for `family`; never repaired, never checksummed, never truncated.
   */
  address: string;
  /** Human label: protocol name, or token name. */
  name: string;
  kind: CandidateKind;
  /** The source that FIRST produced this record; `also_in` lists the rest. */
  source: SourceId;
  /** Other sources that yielded the same address on the same chain. */
  also_in: SourceId[];
  /**
   * Other NAMES that the same address was published under.
   *
   * This is not cosmetic. DeFiLlama really does list several protocols against
   * one contract: `0x56072c…` is `Sky Lending`, `Sky Money` AND `Sky RWA`, and
   * `CLoUDKc4…` is `Sanctum Validator LSTs`, `Sanctum Infinity` and `Sanctum
   * Reserve`. One address, several protocols, is a fact an auditor wants — a
   * shared contract means blast radius spans every protocol on it. Collapsing the
   * records to one target is correct (one contract is one target); deleting the
   * other names would be losing evidence, so they are kept here.
   */
  also_known_as: string[];
  /** Source-supplied category (`Dexes`, `Lending`, …). Absent on tokens. */
  category?: string;
  /** TVL in USD from the source. Absent on tokens; never synthesised. */
  tvl_usd?: number;
}

/**
 * A candidate on a chain this bot can fork, identified by a real chain id.
 *
 * `chain_id` is guaranteed to be a key of `CHAINS` — the collector drops
 * everything else and counts the drop by chain name, so this invariant holds
 * for every instance that exists at runtime and is asserted in the tests.
 */
export interface EvmCandidate extends CandidateBase {
  family: 'evm';
  chain_id: number;
}

/**
 * A Solana candidate. Deliberately NOT given an invented numeric chain id.
 *
 * `chain_id: null` is the load-bearing part: it makes `candidate.chain_id`
 * `number | null` for anyone holding a `Candidate`, so the SVM case cannot be
 * silently treated as an EVM chain.
 */
export interface SvmCandidate extends CandidateBase {
  family: 'svm';
  chain_id: null;
  /** Solana cluster the address lives on. Inventory sources are mainnet only. */
  cluster: 'mainnet-beta';
}

export type Candidate = EvmCandidate | SvmCandidate;

/** True when this candidate carries a chain id that `CHAINS` can resolve. */
export function isEvmCandidate(c: Candidate): c is EvmCandidate {
  return c.family === 'evm';
}

/**
 * The dedupe key for a candidate.
 *
 * The two families need DIFFERENT keys and this is not cosmetic:
 *
 *   · an EVM address is hex, so two records of the same contract differ only in
 *     casing — the key must lowercase, or `0xAbC…` and `0xabc…` become two
 *     "different" targets for the same contract;
 *   · a Solana address is base58, which is CASE-SENSITIVE — `Ab…` and `ab…` are
 *     different pubkeys. Lowercasing the key would collapse two real accounts
 *     into one and silently lose a target.
 */
export function candidateKey(c: Candidate): string {
  if (c.family === 'evm') return `evm:${c.chain_id}:${c.address.toLowerCase()}`;
  return `svm:${c.cluster}:${c.address}`;
}

/** Why a record from a source did not become a candidate. */
export type DropReason =
  /** The address names a chain, but not one in `CHAINS`. */
  | 'unregistered-chain'
  /** No chain fact at all (no prefix, and `chain`/`chainId` was null/Multi-Chain). */
  | 'no-chain'
  /** The chain is known but the address is not valid for any family. */
  | 'malformed-address';

/**
 * Reconciliation report for one collection run.
 *
 * Every input record lands in exactly one bucket, so
 * `emitted + sum(drops) + sum(by_reason) === records_seen` is checkable — and is
 * checked in the tests. Without that identity a silent parser regression looks
 * identical to "the source had nothing".
 */
export interface DropReport {
  /**
   * Records dropped because they named a chain outside the registry, counted by
   * the name the source used. This is the list that tells an operator which
   * chains they are leaving on the table (`bsc`, `arbitrum`, …).
   */
  by_chain_name: Record<string, number>;
  /** Records with no chain fact whatsoever; nothing to drop them under. */
  no_chain: number;
  /** Records whose chain was fine but whose address failed validation. */
  malformed_address: number;
  /** Total records examined across all sources. */
  records_seen: number;
  /** Total candidates emitted (after dedupe). */
  emitted: number;
  /** Records that were valid but collapsed onto an already-emitted address. */
  duplicates: number;
}

/** Per-source yield and cost, for the coverage note and for budget decisions. */
export interface SourceStat {
  source: SourceId;
  url: string;
  /** Records the source offered (protocol entries with an address, or tokens). */
  records: number;
  /** Candidates this source contributed on its own (pre-dedupe). */
  candidates: number;
  /** HTTP subrequests this source costs per invocation. */
  requests: number;
  /** Observed uncompressed body size in bytes, from a real fetch. */
  bytes: number;
}

export interface Collection {
  candidates: Candidate[];
  drops: DropReport;
  by_source: SourceStat[];
}
