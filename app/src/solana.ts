/**
 * Solana (SVM) address, cluster and program vocabulary.
 *
 * WHY THIS MODULE IS SEPARATE FROM `chains.ts`
 *
 * Every address check in this codebase before this file was EVM-only:
 *
 *   policy.ts:548   /^0x[0-9a-fA-F]{40}$/
 *   drain.ts:527    /^0x[0-9a-fA-F]{40}$/
 *   send.ts:204     /^0x[0-9a-fA-F]{40}$/
 *
 * A Solana pubkey is base58 over 32 bytes and matches none of them, so before
 * this module a Solana program id typed into a brief fell through the `else`
 * branch in `policy.ts:roeFromBrief` and was filed as a DOMAIN NAME. That is
 * worse than a refusal: the engagement then looks scoped, and the proof plane
 * clones nothing.
 *
 * The EVM registry in `chains.ts` is keyed by a numeric chain id that
 * `cast chain-id` reports and that `prove.yml` resolves to `FORK_RPC_<id>`.
 * Solana has no chain id. Its analogue is the GENESIS HASH, a 32-byte base58
 * string, and its clusters are named rather than numbered. Naming them
 * `SOLANA_CLUSTERS` in a sibling module keeps that difference visible in the
 * type system instead of hiding a base58 string in a `Record<number, …>`.
 *
 * NO I/O, NO NETWORK, NO SECRETS. This file maps names to metadata and decodes
 * base58. It never reads an environment variable and never calls an RPC, so it
 * is importable from the Worker, a CLI, or a test alike, and it cannot leak a
 * credential.
 */

// ─── base58 ────────────────────────────────────────────────────────────────

/**
 * Bitcoin base58, which is what Solana uses.
 *
 * The alphabet deliberately omits `0`, `O`, `I` and `l`: they are the four
 * glyphs that are unreadable in a proportional font, which is why a pubkey
 * copied out of a chat window and a pubkey that is valid base58 are different
 * claims. `isSolanaPubkey` rejects all four by decoding, not by a length check.
 */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** char code -> value, or -1 for "not in the alphabet". */
const B58_MAP: Int16Array = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B58_ALPHABET.length; i++) {
    m[B58_ALPHABET.charCodeAt(i)] = i;
  }
  return m;
})();

export interface Base58Decode {
  bytes: Uint8Array;
  /** Leading '1' characters, each of which encodes exactly one zero byte. */
  leadingZeros: number;
}

/**
 * Decode base58 to bytes. Returns null for any character outside the alphabet.
 *
 * This is a real decode, not a length guess. The distinction matters: a 44-char
 * string of `l` characters is the right LENGTH for a 32-byte pubkey and decodes
 * to nothing at all. A `length === 32..44` check would accept it, and the bot
 * would then dispatch a proof run against an address no cluster has ever seen.
 */
export function decodeBase58(s: string): Base58Decode | null {
  if (typeof s !== 'string' || s.length === 0) return null;

  // Accumulate little-endian base-256 digits. O(n^2) but n <= 44 for a pubkey,
  // and a signature (64 bytes) is still trivial.
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const val = code < 128 ? (B58_MAP[code] ?? -1) : -1;
    if (val < 0) return null;
    let carry = val;
    for (let j = 0; j < out.length; j++) {
      carry += (out[j] as number) * 58;
      out[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      out.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  while (leadingZeros < s.length && s.charCodeAt(leadingZeros) === 49 /* '1' */) leadingZeros++;

  const bytes = new Uint8Array(leadingZeros + out.length);
  for (let i = 0; i < out.length; i++) {
    bytes[leadingZeros + i] = out[out.length - 1 - i] as number;
  }
  return { bytes, leadingZeros };
}

/**
 * Encode bytes to base58. Present because the validator-config helpers below
 * round-trip a program id, and a one-way decoder makes that untestable.
 */
export function encodeBase58(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error('encodeBase58 requires a Uint8Array');
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Little-endian base-256 -> base-58 digits.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += B58_ALPHABET[digits[i] as number] as string;
  }
  return out;
}

/**
 * True only for a string that decodes to exactly 32 bytes of base58.
 *
 * Rejected on purpose, each with a test in `tests/solana.test.ts`:
 *   - `0x…` EVM addresses (the `0` is not in the alphabet, so they fail here and
 *     the caller can then ask the EVM validator instead of guessing)
 *   - 31-byte and 33-byte decodings
 *   - any string containing `0`, `O`, `I` or `l`
 *   - the empty string
 */
export function isSolanaPubkey(s: string): boolean {
  if (typeof s !== 'string') return false;
  // 32 zero bytes, all-'1', is the System Program id and IS a valid pubkey, so
  // there is no "looks empty" short-circuit below this length.
  if (s.length === 0) return false;
  // A 32-byte value in base58 is at most 44 characters and, with leading zeros,
  // at least 32. Outside that window no decode is needed to answer.
  if (s.length < 32 || s.length > 44) return false;
  const decoded = decodeBase58(s);
  return decoded !== null && decoded.bytes.length === 32;
}

/** `{ slot-address: … }`-style compat helper: true when ANY of the candidates is a pubkey. */
export function anySolanaPubkey(values: readonly string[]): boolean {
  return values.some((v) => isSolanaPubkey(v));
}

// ─── clusters ──────────────────────────────────────────────────────────────

export type SolanaClusterName = 'mainnet-beta' | 'devnet' | 'testnet';

export interface SolanaClusterSpec {
  /** The canonical cluster name, exactly as `solana` and GitHub inputs spell it. */
  name: SolanaClusterName;
  /** Operator-facing name for a Telegram line. */
  label: string;
  /**
   * NAME of the secret holding an RPC for this cluster. The value is never
   * stored here; `prove-solana.yml` resolves the name to the secret.
   */
  rpc_env: string;
  /** Public endpoint, used when no secret is configured. Slow and rate-limited. */
  default_rpc: string;
  /** True only for the cluster where a proof touches real value. */
  mainnet: boolean;
  /**
   * GENESIS HASH — Solana's analogue of a chain id. Verified live on
   * 2026-10-29 by calling `getGenesisHash` on each cluster's public RPC:
   *
   *   curl -s -X POST https://api.mainnet-beta.solana.com \
   *     -H 'content-type: application/json' \
   *     -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'
   *   -> 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
   *
   * Devnet and testnet were queried the same way and returned the values below.
   * These are asserted distinct, length-64-hex-shaped base58, and equal to the
   * same constants `prove-solana.yml` hardcodes in bash, in
   * `tests/solana.test.ts`. The workflow cannot import TypeScript, so the same
   * three strings exist in two places ON PURPOSE — a single-value check that
   * both agree is what the test does.
   */
  genesis_hash: string;
}

export const SOLANA_CLUSTERS: Record<SolanaClusterName, SolanaClusterSpec> = {
  'mainnet-beta': {
    name: 'mainnet-beta',
    label: 'Solana Mainnet Beta',
    rpc_env: 'SOLANA_RPC_MAINNET',
    default_rpc: 'https://api.mainnet-beta.solana.com',
    mainnet: true,
    genesis_hash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  },
  devnet: {
    name: 'devnet',
    label: 'Solana Devnet',
    rpc_env: 'SOLANA_RPC_DEVNET',
    default_rpc: 'https://api.devnet.solana.com',
    mainnet: false,
    genesis_hash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  },
  testnet: {
    name: 'testnet',
    label: 'Solana Testnet',
    rpc_env: 'SOLANA_RPC_TESTNET',
    default_rpc: 'https://api.testnet.solana.com',
    mainnet: false,
    genesis_hash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  },
};

/** The cluster names this bot will dispatch against, in preference order. */
export const SOLANA_CLUSTER_NAMES: readonly SolanaClusterName[] = [
  'mainnet-beta',
  'devnet',
  'testnet',
];

export const DEFAULT_SOLANA_CLUSTER: SolanaClusterName = 'devnet';

/** Normalise operator spellings: `mainnet`, `MAINNET-BETA`, `devnet` … */
function normaliseClusterName(s: string): SolanaClusterName | null {
  const t = s.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (t === 'mainnet' || t === 'mainnet-beta' || t === 'solana-mainnet' || t === 'mainnetbeta') {
    return 'mainnet-beta';
  }
  if (t === 'devnet') return 'devnet';
  if (t === 'testnet') return 'testnet';
  return null;
}

/** The spec for a cluster name, or null when this module does not know it. */
export function clusterSpec(name: string | null | undefined): SolanaClusterSpec | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = normaliseClusterName(name);
  return n ? (SOLANA_CLUSTERS[n] ?? null) : null;
}

/**
 * One line for the operator: `mainnet-beta Solana Mainnet Beta (mainnet, rpc
 * SOLANA_RPC_MAINNET)`.
 *
 * Mirrors `describeChain` in `chains.ts`: never empty, never throws, and always
 * says where the RPC comes from. A blank line in a Telegram message is exactly
 * the "which cluster did this run on?" blindness this file exists to remove —
 * and on Solana that mistake is easier to make than on EVM, because devnet and
 * mainnet-beta program ids are often the same key.
 */
export function describeCluster(cluster: string | null | undefined): string {
  const spec = clusterSpec(cluster);
  if (!spec) {
    const shown = typeof cluster === 'string' ? cluster.trim() : '';
    if (!shown) {
      return `no cluster pinned, defaulting to ${DEFAULT_SOLANA_CLUSTER} (rpc ${
        SOLANA_CLUSTERS[DEFAULT_SOLANA_CLUSTER].rpc_env
      })`;
    }
    return `unknown cluster ${shown}, refusing to guess (known: ${SOLANA_CLUSTER_NAMES.join(', ')})`;
  }
  return `${spec.name} ${spec.label} (${spec.mainnet ? 'mainnet' : 'testnet'}, rpc ${spec.rpc_env})`;
}

/**
 * An explicit cluster token in free text: `cluster:devnet`,
 * `cluster=mainnet-beta`, `solana:testnet`.
 *
 * The same two constraints `parseChainToken` documents apply, for the same
 * reason: the cluster must be INTRODUCED by a word and a separator, so
 * `crosschain:devnet` and a bare mention of "devnet" in prose are not pins.
 *
 * Returns null when absent, so the caller can tell "the operator pinned a
 * cluster" from "nobody said" — the distinction `dispatch.ts` relies on.
 */
export function parseSolanaToken(notes: string | null | undefined): SolanaClusterName | null {
  if (typeof notes !== 'string' || notes.trim() === '') return null;
  const re = /(?:^|[^A-Za-z0-9_-])(?:cluster|cluster_name|solana)(?:_cluster)?\s*[:=]\s*([A-Za-z0-9_-]{3,16})/i;
  const m = re.exec(notes);
  const raw = m?.[1];
  if (!raw) return null;
  return normaliseClusterName(raw);
}

/**
 * True when this cluster is on the allowlist that needs no double-switch.
 *
 * Deliberately the inverse of the EVM shape: there, `DRAIN_ALLOWED_CHAINS`
 * lists testnet ids and mainnet needs `allow_mainnet` AND `confirm_mainnet`.
 * Solana's proof track never writes to any cluster, so this function exists for
 * DISPLAY and for refusing a drain request, not as the authorization gate — the
 * gate is `policy.ts`. See SOLANA-INTEGRATION.md §policy.ts.
 */
export function isSolanaMainnet(cluster: string | null | undefined): boolean {
  return clusterSpec(cluster)?.mainnet === true;
}

// ─── program ids ───────────────────────────────────────────────────────────

/**
 * Real, deployed program ids. Each was verified on 2026-10-29 against mainnet
 * itself rather than a doc page, because a doc page can be stale and a program
 * id in a generated PoC is either the cluster's or a typo:
 *
 *   curl -s -X POST https://api.mainnet-beta.solana.com \
 *     -H 'content-type: application/json' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
 *          "params":["<ID>",{"encoding":"base64","dataSlice":{"offset":0,"length":0}}]}'
 *
 *   TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA  executable=true owner=BPFLoaderUpgradeab1e111…
 *   11111111111111111111111111111111             executable=true owner=NativeLoader111111111111…
 *   ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL executable=true owner=BPFLoader2111111111111111…
 *   TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb executable=true owner=BPFLoaderUpgradeab1e111…  (Token-2022)
 *
 * `executable=true` is the part that matters: an account that merely exists at
 * an id is not a program, and `--clone` of a non-executable account produces a
 * validator where every CPI fails for a reason that looks like the bug.
 */
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Token-2022 (token extensions). Same instruction surface, different id. */
export const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** All ones in base58: 32 zero bytes. Not a "missing" value — a real program. */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Program ids a PoC may legitimately need to clone, with a human label. */
export const WELL_KNOWN_PROGRAMS: Record<string, string> = {
  [SPL_TOKEN_PROGRAM]: 'SPL Token',
  [SPL_TOKEN_2022_PROGRAM]: 'SPL Token-2022',
  [SYSTEM_PROGRAM]: 'System Program',
  [ASSOCIATED_TOKEN_PROGRAM]: 'Associated Token Account Program',
};

// ─── anchor / program error codes ──────────────────────────────────────────

export interface ProgramErrorMeaning {
  /** The numeric code as it appears in a log or an `InstructionError` tuple. */
  code: number;
  /** What it means to an operator, not to a compiler. */
  meaning: string;
  /**
   * The question this code answers about the PoC. This is the field that stops
   * a failed run being reported as a finding.
   */
  implication: string;
}

/**
 * Anchor's built-in error codes, and what each means when a PoC fails.
 *
 * WHY THIS TABLE IS LOAD-BEARING
 *
 * On EVM a failed PoC usually reverts with no reason and the judge falls back to
 * "the test failed". On Solana a failed PoC almost always fails with a NUMBER,
 * and the number distinguishes three completely different situations:
 *
 *   2002 ConstraintSigner / 3010 AccountNotSigner
 *        The signer check is PRESENT and working. The claimed missing-signer bug
 *        does not exist. Report disproved, not "test failed".
 *   3012 AccountNotInitialized
 *        The harness passed a PDA that was never created. That is a FIXTURE bug:
 *        the test proved nothing about the target.
 *   6000+ (custom)
 *        The program rejected the call on its own terms. Usually a real guard —
 *        but the program's own error enum has to be read to say which, and the
 *        PoC must map it rather than guess.
 *
 * Numbers verified against `lang/src/error.rs` in anchor v0.30.1
 * (https://raw.githubusercontent.com/coral-xyz/anchor/v0.30.1/lang/src/error.rs):
 * `ERROR_CODE_OFFSET = 6000` for user errors, and the constraint/account
 * ranges start at 2000 / 3000 respectively. The codes below were read out of
 * that enum, not remembered.
 */
export const ANCHOR_ERRORS: Record<string, ProgramErrorMeaning> = {
  InstructionMissing: {
    code: 100,
    meaning: 'the instruction data did not carry the 8-byte discriminator Anchor expects',
    implication:
      'the harness built the instruction wrong; this says nothing about the program under test',
  },
  InstructionFallbackNotFound: {
    code: 101,
    meaning: 'no instruction with that discriminator exists in the program',
    implication:
      'the PoC names an instruction the deployed program does not have — check the IDL before reporting anything',
  },
  InstructionDidNotDeserialize: {
    code: 102,
    meaning: 'the program could not deserialize the instruction arguments',
    implication: 'argument encoding mismatch in the harness, not a target defect',
  },
  ConstraintSeeds: {
    code: 2006,
    meaning: 'a #[account(seeds = …)] check failed: the passed account is not the PDA the program derives',
    implication:
      'the seed derivation is enforced. A claimed "unvalidated PDA" finding dies here unless the harness derived the seeds the same way an attacker would',
  },
  ConstraintSigner: {
    code: 2002,
    meaning: 'a #[account(signer)] constraint failed: the account did not sign',
    implication:
      'the signer check is present. A missing-signer claim is DISPROVED, not inconclusive',
  },
  ConstraintMut: {
    code: 2000,
    meaning: 'a #[account(mut)] constraint failed: the account was passed read-only',
    implication: 'the harness must mark the account writable; a failure here is a fixture bug',
  },
  ConstraintHasOne: {
    code: 2001,
    meaning: 'a #[account(has_one = …)] check failed: the linked field does not match',
    implication:
      'the authority link is enforced, so a "wrong authority accepted" claim is disproved unless the harness passed the attacker as that exact field',
  },
  ConstraintAssociated: {
    code: 2009,
    meaning: 'the passed token account is not the associated token account for the expected wallet and mint',
    implication: 'ATA derivation is enforced; substitution claims fail at this code, which is a real guard',
  },
  ConstraintTokenMint: {
    code: 2014,
    meaning: 'a token account for the wrong mint was passed',
    implication: 'mint binding is enforced — a confused-deputy claim needs a different account pair',
  },
  RequireViolated: {
    code: 2500,
    meaning: 'a require!(…) in the program body returned false',
    implication:
      'the program has an explicit guard on this path. Read the require to see what it checks before calling the input unvalidated',
  },
  AccountDiscriminatorMismatch: {
    code: 3002,
    meaning: 'the account data did not carry the discriminator for the type the program expected',
    implication:
      'the harness passed an account of the wrong type. A fixture bug that is easy to mistake for account-validation failure',
  },
  AccountOwnedByWrongProgram: {
    code: 3007,
    meaning: 'the account is owned by a different program than the one expected',
    implication:
      'ownership IS checked on this path. A "foreign account accepted" claim is disproved here',
  },
  InvalidProgramId: {
    code: 3008,
    meaning: 'the program id passed for a CPI does not match the expected program',
    implication:
      'this is the code a correctly-guarded arbitrary-CPI path returns (see sol.svm-cpi). Its presence is the fix working, not the bug',
  },
  AccountNotSigner: {
    code: 3010,
    meaning: 'an account that must sign did not sign',
    implication:
      'the signer requirement is enforced. For sol.svm-signer this code in the ATTACK run means disproved',
  },
  AccountNotInitialized: {
    code: 3012,
    meaning: 'the account exists but has not been initialized (no discriminator / zeroed owner state)',
    implication:
      'almost always a FIXTURE bug: the harness skipped the initialize step. Never report this as a target finding',
  },
  DeclaredProgramIdMismatch: {
    code: 4100,
    meaning: 'the program was deployed at an address other than the one declared in declare_id!',
    implication:
      'a build/deploy mismatch in the harness. Fix the program id before drawing any conclusion',
  },
};

/** True for a 6000-series code, i.e. one the program itself defines. */
export function isCustomProgramError(code: number): boolean {
  return Number.isInteger(code) && code >= 6000;
}

/**
 * Explain a numeric error code the way an operator needs it explained.
 *
 * A 6000-series code is reported as custom WITHOUT inventing a meaning: the
 * program's own `#[error_code]` enum is the only authority for those, and a
 * lookup table that guessed would be the single easiest way to turn "the guard
 * fired" into a fabricated finding.
 */
export function explainProgramError(code: number): string {
  if (!Number.isInteger(code) || code < 0) return `not a program error code: ${String(code)}`;
  for (const [name, e] of Object.entries(ANCHOR_ERRORS)) {
    if (e.code === code) return `${name} (${code}): ${e.meaning} — ${e.implication}`;
  }
  if (isCustomProgramError(code)) {
    return (
      `custom program error ${code}: defined by the program's own #[error_code] enum ` +
      `(offset 6000). Read that enum — do not assume it means the bug reproduced`
    );
  }
  return `unknown Anchor error ${code}: not in the 100/1000/2000/3000/4100/6000 ranges this table covers`;
}

// ─── validator cloning ─────────────────────────────────────────────────────

export interface ClonePlan {
  /** `--clone <pubkey>` arguments, de-duplicated, program id first. */
  pubkeys: string[];
  /** True when a clone is required for this cluster before a test may run. */
  needs_clone: boolean;
  /** One sentence for the operator explaining what will be cloned and why. */
  note: string;
}

/**
 * Which accounts a validator must clone to prove against this program.
 *
 * A mainnet-beta program CANNOT be deployed to a local validator from source:
 * the source is not the deployed bytecode (usually), and writing to mainnet is
 * out of the question. So the proof track clones the program account and its
 * programdata account, which is the only way to execute the real bytecode
 * without a write. That is also the reason `self_deployed` is `false` for
 * `sol.svm-signer`: the harness attaches to cloned bytecode.
 *
 * The programdata address is derived by the workflow (`solana program show
 * --outfile`), not guessed here, because the derivation needs the program's
 * loader state.
 */
export function planValidatorClones(programId: string, cluster: string | null | undefined): ClonePlan {
  const spec = clusterSpec(cluster);
  if (!isSolanaPubkey(programId)) {
    return {
      pubkeys: [],
      needs_clone: false,
      note: `${programId || '(no program id)'} is not a base58 32-byte pubkey, so nothing can be cloned`,
    };
  }
  if (!spec) {
    return {
      pubkeys: [programId],
      needs_clone: true,
      note: `unknown cluster, cloning ${programId} without a cluster assertion — the run will be refused`,
    };
  }
  return {
    pubkeys: [programId],
    needs_clone: true,
    note:
      `clone ${programId} from ${spec.name} into a local validator so the real bytecode runs ` +
      `with no write to ${spec.name}`,
  };
}
