/**
 * `targets/` — public inventory to chain-tagged candidate targets.
 *
 * LIBRARY MODULE ONLY. Nothing here writes to D1, calls Telegram, or is wired
 * into a route or a cron trigger. It answers one question — "what contracts exist
 * on the chains this bot can fork, and which chain is each one on?" — and returns
 * data. Wiring it in is a separate, reviewable change.
 *
 * THE INVARIANT
 *
 * `Candidate` is a discriminated union on `family`. An EVM candidate carries a
 * `chain_id` that is a key of `CHAINS` (1, 8453, 84532, 11155111, 31337) and was
 * resolved through that registry; a Solana candidate carries `chain_id: null` and
 * a `cluster`, because Solana has no EVM chain id and inventing one would let
 * `policy.ts` authorise a target on a chain that cannot be forked. See
 * `types.ts` for why the field is typed rather than omitted.
 *
 * WHY THE CHAIN IS THE WHOLE POINT: `policy.ts:roeFromBrief` rejects a bare `0x…`
 * target that names no chain ("an address does not identify its chain"). A
 * candidate whose chain is missing or guessed is therefore not a weak target, it
 * is an unusable one.
 *
 * LAYOUT
 *
 *   types.ts      the union, the dedupe key, the drop report
 *   address.ts    EVM and SVM grammars, prefix splitting
 *   chain-map.ts  source vocabulary -> chain id, via `CHAINS`
 *   sources.ts    pure parsers, one per source (no I/O)
 *   dedupe.ts     field-wise merge across sources
 *   testnet.ts    the deliberately empty testnet result and its reason
 *   collect.ts    the only inventory network access, with injected `fetch`
 *   funding.ts    adapter source -> fund_addresses, with the token filter
 *   queue.ts      the D1-backed resumable adapter crawl and the tick budget
 *   scope.ts      platform scope docs -> programmes, assets, automation_allowed
 *   ev.ts         expected-value ranking (never TVL ranking)
 *   candidate.ts  the stored candidate record: has_programme + fund_addresses
 *   curator.ts    Risk Curator: a class with no prover, refused by name
 *
 * See `README.md` for measured per-chain yields, drop counts, and the testnet
 * finding. See `docs/discovery-limits.md` for what is measured versus assumed.
 */

export type {
  AddressFamily,
  Candidate,
  CandidateKind,
  Collection,
  DropReason,
  DropReport,
  EvmCandidate,
  SourceId,
  SourceStat,
  SvmCandidate,
} from './types.js';
export { candidateKey, isEvmCandidate } from './types.js';

export {
  addressFamily,
  isEvmAddress,
  isSvmAddress,
  splitChainPrefixedAddress,
} from './address.js';

export {
  familyFor,
  normaliseChainName,
  resolveAddressPrefix,
  resolveChainId,
  resolveChainName,
} from './chain-map.js';
export type { ChainResolution } from './chain-map.js';

export { parseDefiLlama, parseTokenList } from './sources.js';
export type { ParseResult } from './sources.js';

export {
  SOURCE_PRIORITY,
  countByChain,
  dedupeCandidates,
  mergeCollections,
  topDroppedChains,
} from './dedupe.js';

export {
  TESTNET_EMPTY_REASON,
  emptyTestnetResult,
  isRegisteredTestnet,
  testnetCandidates,
} from './testnet.js';
export type { TestnetResult } from './testnet.js';

export {
  SOURCE_BYTES,
  SOURCE_URLS,
  budgetFor,
  collectCandidates,
  collectSource,
} from './collect.js';
export type { Collected, CollectionOptions, Fetcher, SourceOutcome } from './collect.js';

// ── funding: where the money is, not what the feed published ────────────────
export {
  addressIsTokenIdentity,
  extractAddresses,
  fundAddresses,
  rawAdapterUrl,
  summariseAdapter,
  tokenIdentityKeys,
} from './funding.js';
export type { FundState, Funding, ProtocolRecord, TokenIdentity } from './funding.js';

// ── the resumable adapter crawl, and the subrequest budget ──────────────────
export {
  MAX_ATTEMPTS,
  SECURITY_TXT_PATHS,
  SUBREQUEST_CEILING,
  assertBudget,
  drainQueue,
  dueRows,
  enqueueProtocols,
  fundingByProtocol,
  parseAddressJson,
  planTick,
  securityTxtCost,
  slugFor,
  tokenKeysFrom,
} from './queue.js';
export type { AdapterFetcher, QueueDb, QueueRow, QueueState, TickPlan } from './queue.js';

// ── scope documents: the automation gate ────────────────────────────────────
export {
  classifyProhibitedActivities,
  parseCantina,
  parseHackenProof,
  parseImmunefi,
  parseScope,
  parseSherlock,
  readProhibitedField,
  refuseDispatch,
  reposFromText,
} from './scope.js';
export type {
  AutomationClass,
  AutomationReason,
  AutomationVerdict,
  DispatchRefusal,
  ProgrammeKind,
  ScopeAsset,
  ScopeParse,
  ScopePlatform,
  ScopeProgramme,
} from './scope.js';

// ── expected-value ranking. DISCOVERY IS NOT AUTHORIZATION. ─────────────────
export {
  COVERAGE_GAP_COVERED,
  COVERAGE_GAP_UNCOVERED,
  RANKING_IS_NOT_AUTHORIZATION,
  TIME_TO_PROOF_IS_PLACEHOLDER,
  TIME_TO_PROOF_PLACEHOLDER_HOURS,
  classWeightSum,
  rankByExpectedValue,
  rankedForDispatch,
  scoreCandidate,
} from './ev.js';
export type { EvCandidate, EvScore, EvZeroReason } from './ev.js';

// ── the stored candidate record ────────────────────────────────────────────
export { candidateRecord, dispatchable, evInputFrom, scoreRecord } from './candidate.js';
export type { CandidateRecord, ProgrammeMatch } from './candidate.js';

// ── Risk Curator: defined, and refused by name until it has a prover ───────
export {
  CURATOR_METHODOLOGY_HOOKS,
  NO_PLAYBOOK_YET_REASON,
  RISK_CURATOR_CLASS,
  RISK_CURATOR_PROPOSED_CLS,
  curatorClassIsDispatchable,
  isCuratorBrief,
  refuseCuratorDispatch,
} from './curator.js';
export type { CuratorBriefish, CuratorRefusal, MethodologyHook } from './curator.js';
