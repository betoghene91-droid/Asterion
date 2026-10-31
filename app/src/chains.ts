/**
 * Chains — the registry that stops the fork chain from being guessed.
 *
 * WHY THIS FILE EXISTS
 *
 * Before this module, the chain was not a fact anywhere in the codebase. Two
 * places invented one, and both invented the same one:
 *
 *   · `policy.ts:roeFromBrief` filed EVERY `0x…` target under chain 8453 with
 *     the comment "Base; overridden per engagement when known". Nothing ever
 *     overrode it, so authorising an Ethereum mainnet contract authorised it as
 *     a Base address. Every downstream gate reasons about `chain_id`, so the
 *     whole engagement was scoped to the wrong chain.
 *
 *   · `.github/workflows/prove.yml` forked from a single `secrets.FORK_RPC` in
 *     four separate steps. If that one secret pointed at mainnet, a Base
 *     Sepolia run silently forked mainnet: a PoC written against a testnet
 *     address reverted in setUp, or — worse — "proved" a delta against
 *     unrelated mainnet state.
 *
 * The fix is a table, not a heuristic: the chains this bot can actually fork
 * are enumerated here, each with the NAME OF THE SECRET that holds its RPC. The
 * Worker derives a `chain_id`, `prove.yml` resolves that id to a secret name and
 * then asserts `cast chain-id` agrees. An address is never evidence of a chain.
 *
 * NO I/O, NO NETWORK, NO SECRETS. This module only maps ids to metadata and
 * reads an explicit `chain:…` token out of operator text. It never reads an
 * environment variable and never calls an RPC, so it is safe to import
 * anywhere — Worker, test, or CLI — and it cannot leak a credential.
 */

export interface ChainSpec {
  /** EVM chain id, exactly as `cast chain-id` reports it. */
  id: number;
  /** Operator-facing name: `Ethereum`, `Base`, … */
  name: string;
  /**
   * NAME of the Worker/Actions secret holding an RPC for this chain. The value
   * is never stored here; `prove.yml` resolves the name to the secret.
   */
  rpc_env: string;
  /** Block explorer host, without scheme. Empty when there is none (anvil). */
  explorer: string;
  /** Native gas token symbol. */
  native: string;
  /**
   * True only for chains where a proof touches real value. Used for display and
   * for anything that wants to distinguish "a real chain" from a test chain;
   * it is NOT the authorization gate (that is `policy.ts`, which requires the
   * address to be listed under the exact chain id in the RoE).
   */
  mainnet: boolean;
}

/**
 * Every chain this bot may fork, keyed by id.
 *
 * Adding a chain means adding BOTH a row here AND a `FORK_RPC_<id>` case in
 * `.github/workflows/prove.yml`, because GitHub Actions cannot index `secrets`
 * dynamically: the workflow must name each secret literally. A chain that is in
 * this table but not in the workflow fails loudly at dispatch time rather than
 * forking something else.
 */
export const CHAINS: Record<number, ChainSpec> = {
  1: {
    id: 1,
    name: 'Ethereum',
    rpc_env: 'FORK_RPC_1',
    explorer: 'etherscan.io',
    native: 'ETH',
    mainnet: true,
  },
  8453: {
    id: 8453,
    name: 'Base',
    rpc_env: 'FORK_RPC_8453',
    explorer: 'basescan.org',
    native: 'ETH',
    mainnet: true,
  },
  84532: {
    id: 84532,
    name: 'Base Sepolia',
    rpc_env: 'FORK_RPC_84532',
    explorer: 'sepolia.basescan.org',
    native: 'ETH',
    mainnet: false,
  },
  11155111: {
    id: 11155111,
    name: 'Ethereum Sepolia',
    rpc_env: 'FORK_RPC_11155111',
    explorer: 'sepolia.etherscan.io',
    native: 'ETH',
    mainnet: false,
  },
  31337: {
    id: 31337,
    name: 'Anvil',
    rpc_env: 'FORK_RPC_31337',
    explorer: '',
    native: 'ETH',
    mainnet: false,
  },
};

/**
 * The single-secret name used when no chain is pinned.
 *
 * This is the legacy behaviour, kept deliberately: a repo-only brief (source
 * audit, no deployed address) has no chain to pin, and prove.yml can still run
 * it against whatever `FORK_RPC` holds. Keeping the name in one place means
 * "unpinned" is a value the code can name rather than a missing branch.
 */
export const DEFAULT_FORK_RPC_ENV = 'FORK_RPC';

/** The spec for a chain id, or null when this registry does not know it. */
export function chainSpec(id: number): ChainSpec | null {
  if (!Number.isInteger(id)) return null;
  return CHAINS[id] ?? null;
}

/**
 * Name of the secret holding this chain's RPC.
 *
 * An unknown or absent chain returns {@link DEFAULT_FORK_RPC_ENV} and does NOT
 * throw: an unrecognised chain is a reason to fall back and say so, not to crash
 * a dispatch that is otherwise sound. The workflow is where an unknown chain
 * becomes a hard failure, because that is where a fork is actually taken.
 */
export function rpcEnvFor(id: number | null | undefined): string {
  if (id == null) return DEFAULT_FORK_RPC_ENV;
  return chainSpec(id)?.rpc_env ?? DEFAULT_FORK_RPC_ENV;
}

/** True only for a chain this registry marks as mainnet (1 and 8453). */
export function isMainnet(id: number | null | undefined): boolean {
  if (id == null) return false;
  return chainSpec(id)?.mainnet === true;
}

/**
 * One line for the operator: `1 Ethereum (mainnet)`.
 *
 * Never empty and never throws — it is rendered into a Telegram message, and a
 * blank line there is exactly the "which chain did this run on?" blindness this
 * work exists to remove.
 */
export function describeChain(id: number | null | undefined): string {
  if (id == null || !Number.isInteger(id)) {
    return `unknown chain, using ${DEFAULT_FORK_RPC_ENV}`;
  }
  const spec = chainSpec(id);
  if (!spec) return `unknown chain ${id}, using ${DEFAULT_FORK_RPC_ENV}`;
  return `${spec.id} ${spec.name} (${spec.mainnet ? 'mainnet' : 'testnet'})`;
}

/**
 * The chains a fork can actually be taken on, in registry order, minus Anvil.
 *
 * Anvil is excluded because it can only be resolved inside the prove workflow
 * (`FORK_RPC_31337`), and a network has no `localhost` node to fork from. So this
 * is the list a chain question may offer: every chain that could produce a real
 * PoC. Used by `intake.ts` to build the one-tap chain answer.
 */
export function forkableChains(): ChainSpec[] {
  return Object.values(CHAINS)
    .filter((c) => c.explorer !== '')
    .sort((a, b) => a.id - b.id);
}

/**
 * An explicit chain token in free text: `chain:1`, `chain_id:8453`, `chain=1`.
 *
 * Two constraints, both load-bearing:
 *
 *   · the id must be introduced by the word `chain`/`chain_id` and a separator.
 *     A bare number anywhere is NOT a chain: `fork_block:19000000` is a block
 *     number, and reading it as a chain id would fork a chain that does not
 *     exist. The leading boundary also rejects `crosschain:5`.
 *   · the digits must be a whole token (`8453abc` and `12.5` are not ids).
 *
 * Returns null when absent or unparseable, so the caller can distinguish "the
 * operator pinned a chain" from "nobody said".
 */
export function parseChainToken(notes: string): number | null {
  if (typeof notes !== 'string' || notes.trim() === '') return null;
  // `[^A-Za-z0-9_-]` before the word: "crosschain:5" and "off-chain:5" are not
  // chain pins. `(?:_id)?` accepts the chain_id spelling.
  const re = /(?:^|[^A-Za-z0-9_-])chain(?:_id)?\s*[:=]\s*(\d{1,10})(?![0-9A-Za-z_.])/i;
  const m = re.exec(notes);
  const digits = m?.[1];
  if (!digits) return null;
  const id = Number(digits);
  // 0 and absurd ids are not chains; treat them as absent rather than filing an
  // address under a chain nothing can fork.
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}
