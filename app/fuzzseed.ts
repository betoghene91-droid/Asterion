/**
 * V3 — fuzzer-guided proof.
 *
 * V2 synthesises a PoC from the *shape* of the source: it sees `.call{value:`
 * and writes a reentrancy harness. That is a hypothesis with no evidence about
 * behaviour. V3 adds a different seed source: take a property fuzzer's
 * falsifying call sequence — real transactions that really broke a real
 * property — and replay it as a Foundry test.
 *
 * The important part is what this module refuses to do. A fuzzer seed is a
 * HYPOTHESIS. It is not a verdict. `judge()` is still the only thing that may
 * say `proven`, and it still demands reproduced + causal + measured. Nothing
 * here writes to the proof contract; it only produces `PocSpec`s that the
 * existing pipeline dispatches exactly like a static one.
 *
 * ── The schema this consumes ─────────────────────────────────────────────
 *
 * Taken from Echidna's JSON encoder, not invented:
 *   lib/Echidna/Output/JSON.hs, crytic/echidna @ 7242229787d5b0 (v2.3.3)
 *   https://github.com/crytic/echidna/blob/master/lib/Echidna/Output/JSON.hs
 *
 *   Campaign = {success, error, tests[], seed, coverage}
 *   Test     = {contract, name, status, error, reason, events, type, transactions}
 *   Tx       = {contract, function, arguments, gas, gasprice, value}
 *   status   = "fuzzing"|"shrinking"|"solved"|"passed"|"verified"|"error"
 *
 * Three consequences of that encoder are load-bearing here, and all three are
 * limitations rather than features:
 *
 * 1. `Test.name` is the literal string "name" and `Test.contract` is "" —
 *    both hardcoded placeholders in the encoder (`mapTest`, with a TODO
 *    pointing at crytic/echidna#415). The JSON therefore CANNOT tell you which
 *    property failed. We only accept a seed from a campaign that reports
 *    exactly one falsifying test, so attribution comes from the fact that we
 *    generated the harness and it holds one property.
 *
 * 2. `Transaction` carries NO sender and NO delay. Echidna picks from several
 *    sender addresses by default ({0x10000, 0x20000, deployer}) and can advance
 *    time between calls. Neither survives into the JSON. We replay every call
 *    from one address and record that limitation on the spec, because a
 *    multi-sender exploit may simply not reproduce.
 *
 * 3. `arguments` are UNTYPED. Integers, addresses and bools arrive as
 *    `ppAbiValue` strings; `bytes` arrive 0x-hex; arrays and tuples become JSON
 *    arrays. An unpadded address (`0x10000`) and a `bytes` value look alike.
 *    We render unambiguous values (decimal integers, booleans) directly and
 *    REFUSE hex and arrays without an ABI type hint, rather than guess.
 */

import type { ImpactKind, PocSpec } from './poc.js';

// ── the wire shape, as the encoder actually emits it ────────────────────

export interface EchidnaTx {
  contract?: string;
  function?: string;
  arguments?: unknown[] | null;
  gas?: string;
  gasprice?: string;
  value?: string;
}

export interface EchidnaTest {
  contract?: string;
  name?: string;
  status?: string;
  error?: string | null;
  reason?: unknown;
  events?: unknown;
  type?: string;
  transactions?: EchidnaTx[] | null;
}

export interface EchidnaCampaign {
  success?: boolean;
  error?: string | null;
  tests?: EchidnaTest[];
  seed?: number;
  coverage?: unknown;
}

/**
 * Statuses that mean the property was FALSIFIED.
 *
 * From Echidna's own bookkeeping: `isSuccessful = all (isOpen || isPassed ||
 * isVerified)`, so `Solved` and `Large` (reported as "shrinking") are failures.
 * `error` is ALSO a failure there — but it means the execution environment
 * broke (out of gas, dead path, SMT timeout), which is not evidence about the
 * target. We deliberately exclude it: it must never become a seed.
 */
const FALSIFYING = new Set(['solved', 'shrinking']);

/** Why a campaign produced no seeds. Always populated on an empty result. */
export interface Rejection {
  reason: string;
  /** The offending function name, when the problem is per-transaction. */
  function?: string;
}

export interface FuzzSeed {
  /** The falsifying sequence, in the order Echidna executed it. */
  transactions: EchidnaTx[];
  /** Why Echidna said this failed, verbatim (`ReturnFalse`, `ErrorRevert`, ...). */
  reason: string;
  status: string;
  /** Honest notes about what replay cannot reproduce. */
  caveats: string[];
}

// ── parsing: never throw on bad input ──────────────────────────────────

export type ParsedCampaign =
  | { ok: true; campaign: EchidnaCampaign }
  | { ok: false; reason: string };

/**
 * Parse Echidna's stdout. A malformed or absent campaign is a normal outcome —
 * the fuzzer may have crashed, printed a warning, or been killed — and must
 * yield "no seeds", never an exception and never a fabricated seed.
 */
export function parseCampaign(raw: string): ParsedCampaign {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'empty echidna output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'output is not valid JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'output is not a JSON object' };
  }

  const c = parsed as EchidnaCampaign;

  // `tests` must be an array when present. A campaign whose tests are not a
  // list is not a campaign we can read.
  if (c.tests !== undefined && c.tests !== null && !Array.isArray(c.tests)) {
    return { ok: false, reason: 'campaign.tests is not an array' };
  }

  return { ok: true, campaign: c };
}

// ── argument rendering: typed or refused, never guessed ────────────────

/** A Solidity ABI type string, e.g. "uint256", "address", "bytes32". */
export type AbiType = string;

const INT_RE = /^(u?int)(\d*)$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const DEC_RE = /^-?\d+$/;
const BYTES_RE = /^bytes(\d*)$/;

/** Solidity's default integer size when the type omits it. */
function intWidth(t: string): string {
  const m = INT_RE.exec(t);
  if (!m) return '';
  return m[2] === '' || m[2] === undefined ? '256' : m[2];
}

/**
 * Render one Echidna argument as a Solidity expression.
 *
 * Returns null when the value cannot be rendered without guessing. Callers must
 * treat null as "this sequence cannot be faithfully replayed", not as "skip the
 * argument" — silently dropping an argument would produce a test that calls a
 * different overload than the fuzzer did.
 */
export function renderArg(value: unknown, hint?: AbiType): string | null {
  if (hint) {
    const t = hint.trim();

    if (INT_RE.test(t)) {
      // AbiUInt/AbiInt render via ppAbiValue as a bare decimal, which may
      // exceed 2^53 — keep it a string if it arrived as one.
      if (typeof value === 'number' && Number.isInteger(value)) {
        return `${value}`;
      }
      if (typeof value === 'string' && DEC_RE.test(value)) return value;
      return null;
    }

    if (t === 'address') {
      if (typeof value !== 'string' || !HEX_RE.test(value)) return null;
      const body = value.slice(2).toLowerCase();
      // ppAbiValue emits UNPADDED hex (`0x10000`), so left-pad to 20 bytes.
      if (!body || body.length > 40) return null;
      return `address(0x${body.padStart(40, '0')})`;
    }

    if (t === 'bool') {
      if (value === true || value === 'true') return 'true';
      if (value === false || value === 'false') return 'false';
      return null;
    }

    if (BYTES_RE.test(t)) {
      if (typeof value !== 'string' || !HEX_RE.test(value)) return null;
      const hex = value.slice(2).toLowerCase();
      if (hex.length % 2 !== 0) return null;
      return `hex"${hex}"`;
    }

    if (t === 'string') {
      if (typeof value !== 'string') return null;
      // A string that arrived as 0x-hex is the encoder's non-UTF8 fallback.
      if (HEX_RE.test(value)) return null;
      return `"${escapeSolidityString(value)}"`;
    }

    // Arrays, tuples, fixed-point, function types: not handled yet.
    return null;
  }

  // Without a hint, render only genuinely unambiguous values.
  //
  // ppAbiValue renders AbiUInt/AbiInt as decimal and AbiBool as true/false;
  // everything else is NOT a bare decimal. So a bare decimal can only be an
  // integer, and is safe to emit as an integer literal.
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isInteger(value)) return `${value}`;
  if (typeof value === 'string' && DEC_RE.test(value)) return value;

  // Hex is the ambiguous case: `0x10000` is a valid address AND valid bytes.
  // A quoted Haskell string is an AbiString rendered with `show`. Both need a
  // type; refuse rather than pick one.
  return null;
}

function escapeSolidityString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Function names Echidna emits that are not a plain named call. */
const NON_CALLABLE = new Set(['<CREATE>', '*wait*']);

export interface RenderOpts {
  /** ABI type hints per function name, e.g. { deposit: [], withdraw: ['uint256'] }. */
  abi?: Record<string, AbiType[]>;
}

export type CallRendering =
  | { ok: true; /** Revert-tolerant, value-carrying Solidity statement. */ solidity: string }
  | { ok: false; reason: string };

/**
 * Build the 4-byte-selector signature string, e.g. `withdraw(uint256)`.
 *
 * A zero-argument call needs no hints at all, which is the common case for
 * state-changing entrypoints, so this keeps working without an ABI.
 */
export function signatureOf(fn: string, hints: AbiType[] | undefined): string | null {
  if (hints === undefined || hints.length === 0) return `${fn}()`;
  for (const h of hints) {
    const t = h.trim();
    if (!(INT_RE.test(t) || t === 'address' || t === 'bool' || t === 'string' || BYTES_RE.test(t))) {
      return null; // a type we cannot name in a signature
    }
  }
  return `${fn}(${hints.map((h) => (INT_RE.test(h.trim()) ? `${INT_RE.exec(h.trim())![1]}${intWidth(h.trim())}` : h.trim())).join(',')})`;
}

/**
 * Render one Echidna transaction as a revert-tolerant Solidity statement
 * against `Target`.
 *
 * Revert-tolerant on purpose: Echidna keeps executing a sequence after a
 * reverting call, so a replay that aborted on the first revert would run a
 * different sequence than the one that broke the property. We therefore use a
 * low-level `.call` and ignore the success flag, exactly as the fuzzer did.
 *
 * This mirrors `foundryTx` in Echidna's own `lib/Echidna/Output/Foundry.hs`,
 * with one deliberate difference: a missing ABI type stops us instead of
 * emitting a call with silently empty arguments.
 */
export function renderCall(tx: EchidnaTx, opts: RenderOpts = {}): CallRendering {
  const fn = typeof tx.function === 'string' ? tx.function : '';

  if (!fn) {
    return { ok: false, reason: 'transaction has no function name' };
  }
  if (NON_CALLABLE.has(fn)) {
    // A contract creation or a time/block delay inside the sequence. Replaying
    // without it would execute a different sequence than the one that failed.
    return { ok: false, reason: `sequence contains a non-callable step (${fn})` };
  }

  const rawArgs = tx.arguments === null || tx.arguments === undefined ? [] : tx.arguments;
  if (!Array.isArray(rawArgs)) {
    return { ok: false, reason: `arguments for ${fn} are not an array` };
  }

  const value = typeof tx.value === 'string' ? tx.value.trim() : '';
  if (value !== '' && !DEC_RE.test(value)) {
    return { ok: false, reason: `value for ${fn} is not a decimal integer (${value})` };
  }
  const valueExpr = value !== '' && value !== '0' ? value : '0';

  // Raw calldata: SolCalldata renders as a 0x-prefixed blob and no name. It is
  // already exact, so replay it directly.
  if (HEX_RE.test(fn)) {
    const hex = fn.slice(2).toLowerCase();
    if (hex.length % 2 !== 0) {
      return { ok: false, reason: 'raw calldata is not whole bytes' };
    }
    return {
      ok: true,
      solidity: `_raw(hex"${hex}", ${valueExpr});`,
    };
  }

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fn)) {
    return { ok: false, reason: `function name is not a Solidity identifier (${fn})` };
  }

  const hints = opts.abi?.[fn];
  if (rawArgs.length > 0 && !hints) {
    return {
      ok: false,
      reason: `${fn} takes ${rawArgs.length} argument(s) but no ABI type is known`,
    };
  }
  if (hints && hints.length !== rawArgs.length) {
    return {
      ok: false,
      reason: `${fn} ABI declares ${hints.length} argument(s) but the sequence has ${rawArgs.length}`,
    };
  }

  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const rendered = renderArg(rawArgs[i], hints?.[i]);
    if (rendered === null) {
      return { ok: false, reason: `cannot render argument ${i} of ${fn} without a type` };
    }
    args.push(rendered);
  }

  const sig = signatureOf(fn, hints);
  if (sig === null) {
    return { ok: false, reason: `cannot express an ABI signature for ${fn}` };
  }

  const argList = args.length ? `, ${args.join(', ')}` : '';
  return {
    ok: true,
    solidity: `_raw(abi.encodeWithSignature("${sig}"${argList}), ${valueExpr});`,
  };
}

// ── campaign → seeds ───────────────────────────────────────────────────

export interface ExtractOpts {
  abi?: Record<string, AbiType[]>;
  /** Safety cap; a shrunk sequence is normally far shorter. */
  maxSteps?: number;
}

export interface ExtractResult {
  seeds: FuzzSeed[];
  rejected: Rejection[];
}

/**
 * Turn a parsed campaign into replayable seeds.
 *
 * Degrades to `{seeds: [], rejected: [...]}` for every input that does not
 * carry a real falsification: no tests, all passed, an error status, a
 * broken environment. An empty result is a correct answer, and the reason is
 * always recorded so the operator can see why.
 */
export function seedsFromCampaign(c: EchidnaCampaign, opts: ExtractOpts = {}): ExtractResult {
  const maxSteps = opts.maxSteps ?? 64;
  const seeds: FuzzSeed[] = [];
  const rejected: Rejection[] = [];

  const tests = Array.isArray(c.tests) ? c.tests : [];
  if (tests.length === 0) {
    rejected.push({ reason: 'campaign reported no tests' });
    return { seeds, rejected };
  }

  const falsifying = tests.filter(
    (t) => typeof t.status === 'string' && FALSIFYING.has(t.status),
  );

  if (falsifying.length === 0) {
    rejected.push({ reason: 'no test was falsified; nothing to seed from' });
    return { seeds, rejected };
  }

  // Test.name is the hardcoded string "name" and Test.contract is "", so with
  // more than one falsifying test we cannot say which sequence belongs to which
  // property. Refuse rather than attach a sequence to the wrong claim.
  if (falsifying.length > 1) {
    rejected.push({
      reason:
        `${falsifying.length} tests were falsified, but echidna's JSON reports name="name" ` +
        'for every test, so the sequences cannot be attributed to one property',
    });
    return { seeds, rejected };
  }

  const test = falsifying[0];
  if (!test) {
    rejected.push({ reason: 'falsifying test vanished during selection' });
    return { seeds, rejected };
  }

  const status = typeof test.status === 'string' ? test.status : '';
  const rawTxs = Array.isArray(test.transactions) ? test.transactions : [];

  if (rawTxs.length === 0) {
    rejected.push({
      reason:
        `a ${status} test carried no transactions: the property failed without any call, ` +
        'which is a harness problem, not an exploitable sequence',
    });
    return { seeds, rejected };
  }

  if (rawTxs.length > maxSteps) {
    rejected.push({ reason: `sequence has ${rawTxs.length} steps, over the ${maxSteps} cap` });
    return { seeds, rejected };
  }

  // Every step must be replayable. A partially replayable sequence is a
  // DIFFERENT sequence, so one bad step rejects the whole seed.
  for (const tx of rawTxs) {
    const r = renderCall(tx, { abi: opts.abi });
    if (!r.ok) {
      rejected.push({ reason: r.reason, function: tx.function });
      return { seeds, rejected };
    }
  }

  const reason =
    typeof test.reason === 'string'
      ? test.reason
      : test.reason === null || test.reason === undefined
        ? ''
        : JSON.stringify(test.reason);

  const caveats: string[] = [
    'echidna json carries no sender: every step is replayed from one address, ' +
      'so a sequence that relied on multiple senders may not reproduce',
    'echidna json carries no time/block delay: block.timestamp and block.number are not restored',
  ];

  seeds.push({ transactions: rawTxs, reason, status, caveats });
  return { seeds, rejected };
}

// ── seed → PocSpec (the SAME contract V2 emits) ────────────────────────

export interface FuzzSynthOpts {
  contract: string;
  forkBlock: number;
  /** ABI type hints, keyed by function name. */
  abi?: Record<string, AbiType[]>;
  /**
   * What the replay measures. Defaults to a no-profit property, which is the
   * only class where "the attacker must not end up richer" is a complete
   * statement of the bug.
   */
  claimKind?: ImpactKind;
  /** Extra caveats, merged with the seed's own. */
  caveats?: string[];
}

/**
 * Build the attack/control pair for a fuzz seed.
 *
 * attack  replays the exact sequence, then measures the actor's ether balance.
 *         Echidna falsified "actor must not profit"; if the replay reproduces
 *         it, the measured delta is positive and the assertion fails.
 *
 * control replays the sequence with the FINAL step removed, and asserts the
 *         same bound. That is the counterfactual: it isolates the last call as
 *         the cause. For a one-step sequence the control is the empty
 *         sequence, which checks the property is not false from the start.
 *
 * Both tests MEASURE and ASSERT A NUMBER. Neither may claim a vulnerability;
 * `judge()` decides that, and it also requires a with-fix or
 * without-precondition run that this file does not supply.
 */
export function synthesizeFromFuzz(seed: FuzzSeed, opts: FuzzSynthOpts): PocSpec | null {
  const { contract, forkBlock } = opts;

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(contract)) return null;
  if (seed.transactions.length === 0) return null;

  const steps: string[] = [];
  for (const tx of seed.transactions) {
    const r = renderCall(tx, { abi: opts.abi });
    if (!r.ok) return null; // never emit a partial replay
    steps.push(`        ${r.solidity}`);
  }

  // The control drops the final step: that is what makes the attack
  // interpretable. With one step the control has no calls, which still checks
  // the property does not fail before any interaction.
  const tail = steps.length > 1 ? steps.slice(0, -1) : [];

  const id = Math.abs(hashSeq(seed.transactions.map((t) => String(t.function ?? ''))));
  const t = `test_fuzz_seed_${id % 100000}`;

  const caveats = [...(seed.caveats ?? []), ...(opts.caveats ?? [])];
  const caveatLines = caveats.map((c) => `///   - ${c}`).join('\n');

  const controlBody = tail.length
    ? tail.join('\n')
    : '        // no calls: the empty sequence is the control';

  const sol = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {${contract}} from "../src/${contract}.sol";

/// PoC seeded by an echidna falsifying sequence
/// (${seed.transactions.length} step(s), echidna status: ${seed.status}).
/// echidna reported: ${seed.reason || '(no reason given)'}
///
/// This is a REPLAY of a fuzzer finding, NOT a proof. judge() decides.
/// Replay limits, which are properties of echidna's JSON schema:
${caveatLines}
contract ${contract}_FuzzPoC is Test {
    ${contract} Target;

    /// echidna's default property sender. The JSON does not record real senders.
    address constant ACTOR = address(0x10000);

    function setUp() public {
        vm.createSelectFork(vm.envString("FORK_RPC"), ${forkBlock});
        Target = ${contract}(vm.envAddress("TARGET"));
        vm.deal(ACTOR, 1 ether);
    }

    /// Machine-readable measurement, parsed by judge.mjs out of the failing run.
    function _impact(uint256 before_, uint256 after_, string memory desc) internal {
        console2.log(string.concat("IMPACT_BEFORE=", vm.toString(before_)));
        console2.log(string.concat("IMPACT_AFTER=", vm.toString(after_)));
        console2.log(string.concat("IMPACT_DESC=", desc));
    }

    /// Low-level, revert-tolerant: echidna continues a sequence past a revert,
    /// so a replay that aborted on the first one would run a different sequence.
    /// The caller is responsible for pranking ACTOR.
    function _raw(bytes memory data, uint256 value) internal {
        (bool ok, ) = address(Target).call{value: value}(data);
        console2.log("step ok", ok);
    }

    function ${t}() public {
        uint256 before_ = ACTOR.balance;

        vm.startPrank(ACTOR);
${steps.join('\n')}
        vm.stopPrank();

        uint256 after_ = ACTOR.balance;
        console2.log("ACTOR before", before_);
        console2.log("ACTOR after", after_);
        _impact(before_, after_, "actor ether before and after the replayed echidna sequence");

        // echidna said this sequence falsifies "actor must not profit".
        assertLe(after_, before_, "FUZZ SEED: replayed sequence left the attacker in profit");
    }

    function ${t}_control() public {
        uint256 before_ = ACTOR.balance;

        vm.startPrank(ACTOR);
${controlBody}
        vm.stopPrank();

        uint256 after_ = ACTOR.balance;
        console2.log("CONTROL before", before_);
        console2.log("CONTROL after", after_);

        // Without the final step the property must still hold; if it does not,
        // this sequence was not the trigger and the seed proves nothing.
        assertLe(after_, before_, "CONTROL: profit already occurred before the final step");
    }

    /// Precondition removed: the sequence without its last step, asserting the
    /// ATTACK's own bound. If this passes, the final step is the cause.
    function ${t}_nocond() public {
        uint256 before_ = ACTOR.balance;

        vm.startPrank(ACTOR);
${controlBody}
        vm.stopPrank();

        uint256 after_ = ACTOR.balance;
        _impact(before_, after_, "actor ether across the sequence with its final step removed");
        assertLe(after_, before_, "NOCOND: the actor profits without the final step, so it was not the cause");
    }
}
`;

  return {
    test_name: t,
    control_name: `${t}_control`,
    nocond_name: `${t}_nocond`,
    // The replay attaches to the deployed contract, so no source patch can
    // change what it executes: only the precondition-removed run is valid.
    self_deployed: false,
    solidity: sol,
    claim: {
      kind: opts.claimKind ?? 'value_transfer',
      description: `echidna falsified a no-profit property with a ${seed.transactions.length}-step sequence; replay must reproduce it`,
    },
    requires: [
      'FORK_RPC',
      'TARGET',
      'a target where the actor holds ether before the sequence',
      // Stated up front so a failure to reproduce is read correctly.
      ...caveats,
    ],
  };
}

/** Stable, order-sensitive hash so the same sequence gets the same test name. */
function hashSeq(parts: string[]): number {
  let h = 2166136261;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x2c; // separator, so ["ab","c"] != ["a","bc"]
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

// ── harness generation: what echidna actually fuzzes ───────────────────

/**
 * A property Echidna can falsify without knowing the target's internals.
 *
 * The point of V3 is that WE state the property (a small, auditable claim) and
 * the FUZZER finds the sequence. That is the difference from V2, where we had
 * to guess the whole attack.
 */
export interface PropertyTemplate {
  playbook: string;
  /** Function name exposed on the harness; echidna's default property prefix. */
  property: string;
  /** Solidity body, evaluated inside the harness scope. */
  body: string;
  description: string;
}

/**
 * Only classes where "the actor must not end up richer" is a complete,
 * statable property.
 *
 * Other classes are absent deliberately. A property for, say, access control or
 * an oracle would need the target's internal accounting to express; inventing
 * one would reintroduce exactly the static guesswork V3 is meant to replace.
 */
export const PROPERTIES: PropertyTemplate[] = [
  {
    playbook: 'sol.reentrancy',
    property: 'echidna_no_profit',
    body: 'return address(ACTOR).balance <= START_BALANCE;',
    description: 'no call sequence lets the actor end with more ether than it started with',
  },
  {
    playbook: 'sol.rounding',
    property: 'echidna_no_profit',
    body: 'return address(ACTOR).balance <= START_BALANCE;',
    description: 'no call sequence lets the actor end with more ether than it started with',
  },
  {
    playbook: 'sol.inflation',
    property: 'echidna_no_profit',
    body: 'return address(ACTOR).balance <= START_BALANCE;',
    description: 'no call sequence lets the actor end with more ether than it started with',
  },
];

export function propertyFor(playbook: string): PropertyTemplate | null {
  return PROPERTIES.find((p) => p.playbook === playbook) ?? null;
}

/**
 * Emit the Echidna harness for a playbook.
 *
 * Returns null when no honest property exists for that class — the same
 * "saying so is the correct answer" contract `synthesize()` uses.
 *
 * Shape notes, because they are easy to get wrong and each one is load-bearing:
 *
 * - `echidna_` prefix: Echidna only evaluates functions matching its `prefix`
 *   setting (default "echidna_"). A property named otherwise is never called.
 * - allContracts: the property lives here, but the interesting calls are on
 *   `Target`. Echidna must fuzz both, which is what `allContracts: true` means
 *   in the config this pairs with. Without it, Echidna fuzzes only this
 *   harness and finds nothing — a silent false negative.
 * - `new ${contract}()`: the harness deploys its own copy, so the target MUST
 *   have a no-argument constructor. We do not guess constructor arguments.
 * - Balance-proportional rather than absolute: Echidna's default `balanceAddr`
 *   is 0xffffffff wei, so a value-carrying call can fail for lack of funds
 *   before the property is ever reached. Comparing to the starting balance is
 *   still the correct claim; the config emitter below raises the balance.
 */
export function echidnaHarness(playbook: string, contract: string): string | null {
  const p = propertyFor(playbook);
  if (!p) return null;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(contract)) return null;

  return `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {${contract}} from "../src/${contract}.sol";

/// Echidna harness generated by Asterion for ${contract}.
///
/// Exactly ONE property, deliberately: echidna's JSON output hardcodes
/// name="name" for every test, so a campaign with several properties cannot be
/// attributed to the sequence that broke it. One property per harness keeps the
/// seed honest.
///
/// Property: ${p.description}
///
/// Requires a no-argument constructor on ${contract}, and must be run with
/// allContracts: true (see echidnaConfig) or echidna will fuzz only this
/// harness and never reach the target.
contract AsterionFuzzHarness {
    ${contract} public Target;

    /// echidna's default property sender.
    address constant ACTOR = address(0x10000);

    uint256 public immutable START_BALANCE;

    constructor() {
        Target = new ${contract}();
        START_BALANCE = address(ACTOR).balance;
    }

    function ${p.property}() public view returns (bool) {
        ${p.body}
    }
}
`;
}

/**
 * The YAML config the harness must run under.
 *
 * Emitted rather than assumed so the sender set and starting balance are
 * explicit in the proof bundle: the JSON schema drops senders, and the default
 * balance is far too small for value-carrying sequences.
 */
export function echidnaConfig(cfg: {
  testLimit?: number;
  seqLen?: number;
  timeout?: number;
} = {}): string {
  const testLimit = cfg.testLimit ?? 50000;
  const seqLen = cfg.seqLen ?? 10;
  const timeout = cfg.timeout ?? 300;

  return `# Echidna config generated by Asterion (V3).
# allContracts so the property harness AND the target both get fuzzed.
allContracts: true
testMode: property
prefix: echidna_

# One property per harness, so a falsifying sequence is attributable:
# echidna's JSON reports name="name" for every test.
testLimit: ${testLimit}
seqLen: ${seqLen}
timeout: ${timeout}

# Explicit senders. echidna's JSON does not record the sender of a transaction,
# so the replay assumes the first one; pinning the set keeps that assumption
# stable instead of depending on a default.
sender: ["0x10000", "0x20000"]
balanceAddr: 100000000000000000000
balanceContract: 100000000000000000000

# Shrinking is what turns a long random sequence into a minimal replayable one.
shrinkLimit: 5000
`;
}
