/**
 * Live-write relay — the ONLY module in Asterion that can broadcast a
 * transaction to a chain.
 *
 * Threat model this file is built against: the bot is LLM-driven, so "the model
 * decided to send" must never be sufficient. Every interlock below is checked
 * twice — once as a cheap pre-flight refusal, and again immediately before
 * `sendRawTransaction` — because a relay that validates only at the entry point
 * is one refactor away from validating nothing.
 *
 * Interlocks (each independently enforced):
 *   1. explicit `LiveWriteGrant` with `approved: true`   (no grant => refuse)
 *   2. caller verdict must be exactly 'proven'
 *   3. chain allowlist; mainnet needs BOTH `grant.allow_mainnet` and the
 *      call-site `confirm_mainnet` flag (two independent switches)
 *   4. dry-run by default: broadcast only when `dry_run: false` is passed
 *   5. `tx.value <= grant.max_value_wei`
 *   6. `now <= grant.expires_at`
 *   7. key material only from an injected `Signer` or the `PRIVATE_KEY` env
 *      reference; never logged, stored, returned, or echoed in an error
 *   8. bounded receipt (hash/status/gas/block); never the raw signed payload
 *   9. in-memory sent-set so a retry cannot double-send
 *
 * Design note — there is no ethers/viem in this package, and adding one to a
 * Cloudflare Worker bundle for a single call site is not justified. Signing is
 * therefore an injected interface. `Signer` is the boundary: supply
 * `{ address, signTransaction }` from whatever does secp256k1 (ethers, viem,
 * @noble/curves, or an out-of-process signer holding the key). When no signer is
 * injected, the relay refuses with `no_signer` instead of pretending to sign.
 *
 * BOUNDARY: this module deliberately contains no key-to-signer construction.
 * `env.PRIVATE_KEY` is only *detected* (so the refusal can name it); the value
 * is read, compared-for-presence, and discarded. It is never placed on a
 * result object or passed to a logger.
 */

// ── constants ────────────────────────────────────────────────────────────────

/** Chains the relay will broadcast on without mainnet confirmation. */
export const DEFAULT_ALLOWED_CHAINS: readonly number[] = [
  84532, // Base Sepolia
  11155111, // Ethereum Sepolia
  31337, // local anvil/hardhat
];

/** Chains treated as mainnet: need allow_mainnet + confirm_mainnet together. */
export const MAINNET_CHAINS: readonly number[] = [
  1, // Ethereum
  8453, // Base
];

/** Env var name that may hold key material. Never logged. */
export const PRIVATE_KEY_ENV = 'PRIVATE_KEY';

/** Sanity ceiling on calldata so a runaway prompt cannot ship a fat payload. */
export const MAX_DATA_BYTES = 24_576;

const WEI_CEILING_MESSAGE =
  'value cap exceeded: tx.value is larger than grant.max_value_wei';

// ── types ────────────────────────────────────────────────────────────────────

/**
 * The operator's explicit permission to write to a live chain. There is no
 * implicit grant and no default grant: absent this object, writes are refused.
 */
export interface LiveWriteGrant {
  approved: true;
  operator: string;
  chain_id: number;
  max_value_wei: bigint;
  /** unix seconds */
  expires_at: number;
  /** required in addition to confirm_mainnet for mainnet chains */
  allow_mainnet?: boolean;
}

/** Minimal verdict shape; the relay only reads `.verdict`. */
export interface VerdictLike {
  verdict: string;
}

export interface RawTx {
  to: string;
  data?: string;
  value: bigint;
  /** optional; defaults to grant.chain_id, and must agree with it if present */
  chain_id?: number;
}

/** The transaction handed to a Signer. Fee fields are optional by design. */
export interface SignableTx {
  from: string;
  to: string;
  data: string;
  value: string;
  chainId: string;
  nonce: string;
  gas: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

/**
 * Injected signing boundary. Implementations hold the key; this module never
 * does. `signTransaction` must return the raw signed hex string.
 */
export interface Signer {
  address: string;
  signTransaction(tx: SignableTx): Promise<string>;
}

export interface CallTx {
  from: string;
  to: string;
  data: string;
  value: string;
}

export interface ReceiptLike {
  status: number;
  gasUsed: bigint;
  blockNumber: number;
}

/** Injected read/write RPC. Tests supply a fake; production supplies a fetch shim. */
export interface ChainRpc {
  estimateGas(tx: CallTx): Promise<bigint>;
  /** eth_call. Returns the call's return data; throws on revert. */
  call(tx: CallTx): Promise<string>;
  getNonce(address: string): Promise<number>;
  /** optional; when present, EIP-1559 fee fields are populated */
  gasPrice?(): Promise<bigint>;
  sendRawTransaction(rawSignedHex: string): Promise<string>;
  getReceipt(hash: string): Promise<ReceiptLike | null>;
}

export type SendRefusalCode =
  | 'no_grant'
  | 'grant_not_approved'
  | 'grant_invalid'
  | 'verdict_not_proven'
  | 'grant_expired'
  | 'chain_not_allowed'
  | 'mainnet_needs_double_confirm'
  | 'grant_chain_mismatch'
  | 'value_over_cap'
  | 'value_negative'
  | 'data_too_large'
  | 'no_rpc'
  | 'no_signer'
  | 'no_private_key'
  | 'duplicate_send'
  | 'simulation_reverted'
  | 'rpc_error';

export interface SendRequest {
  /** the policy/gate verdict for this action */
  verdict: VerdictLike;
  tx: RawTx;
  grant?: LiveWriteGrant | null;
  signer?: Signer | null;
  rpc?: ChainRpc | null;
  /** env reference bag; only PRIVATE_KEY presence is ever inspected */
  env?: Record<string, string | undefined>;
  /** must be exactly `false` to broadcast; anything else is a dry run */
  dry_run?: boolean;
  /** second, call-site-only mainnet switch */
  confirm_mainnet?: boolean;
  /** injectable clock (unix seconds) */
  now?: number;
}

export interface SendOk {
  ok: true;
  broadcast: boolean;
  code: 'dry_run_ok' | 'broadcast_ok';
  reason: string;
  chain_id: number;
  from: string;
  operator: string;
  attempt_key: string;
  gas_estimate: string;
  simulated: string;
  tx_hash: string | null;
  status: number | null;
  gas_used: string | null;
  block: number | null;
}

export interface SendRefused {
  ok: false;
  broadcast: false;
  code: SendRefusalCode;
  reason: string;
  attempt_key: string | null;
}

export type SendResult = SendOk | SendRefused;

// ── hex / redaction helpers ──────────────────────────────────────────────────

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

/** Quantity encoding: no leading zeros, `0x0` for zero. */
export function toHexQty(v: bigint): string {
  if (v < 0n) throw new Error('negative quantity');
  return '0x' + v.toString(16);
}

export function normData(d: string | undefined): string | null {
  if (d === undefined || d === '') return '0x';
  return HEX_DATA.test(d) ? d.toLowerCase() : null;
}

/**
 * Strip any secret material from text that is about to leave the relay.
 * Belt-and-braces: nothing should put a key in a message, but a thrown error
 * from a third-party signer might, so every message is scrubbed here.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    if (out.includes(s)) out = out.split(s).join('[REDACTED]');
    const bare = s.startsWith('0x') ? s.slice(2) : s;
    if (bare.length >= 16 && out.includes(bare)) out = out.split(bare).join('[REDACTED]');
  }
  return out;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

function isMainnet(chainId: number): boolean {
  return MAINNET_CHAINS.includes(chainId);
}

/**
 * Stable identity of a *logical* send. Deliberately excludes the RPC nonce so a
 * retry of the same intent maps to the same key even after the first one mined.
 */
export async function attemptFingerprint(input: {
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: bigint;
  operator: string;
}): Promise<string> {
  const blob = JSON.stringify({
    c: input.chainId,
    f: input.from.toLowerCase(),
    t: input.to.toLowerCase(),
    d: input.data.toLowerCase(),
    v: input.value.toString(),
    o: input.operator,
  });
  const enc = new TextEncoder().encode(blob);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ── the relay ────────────────────────────────────────────────────────────────

interface Resolved {
  chainId: number;
  from: string;
  data: string;
  value: bigint;
  operator: string;
  grant: LiveWriteGrant;
  broadcast: boolean;
}

/**
 * One relay instance owns one sent-set. Create per Worker isolate (or per test).
 * The set is intentionally never persisted: losing it on restart re-opens a
 * duplicate window, so callers that need durability must also key on-chain
 * (nonce) — but within a live isolate a retry is blocked.
 */
export class SendRelay {
  private readonly sent = new Set<string>();
  private readonly inFlight = new Set<string>();

  /** test/debug visibility; does not expose any key material */
  hasSent(attemptKey: string): boolean {
    return this.sent.has(attemptKey);
  }

  async send(req: SendRequest): Promise<SendResult> {
    // Secrets are collected here only so they can be scrubbed from output.
    // Nothing below stores them in a field on `this`.
    const envKey = typeof req.env?.[PRIVATE_KEY_ENV] === 'string' ? req.env[PRIVATE_KEY_ENV] : undefined;
    const secrets: string[] = [];
    if (envKey) secrets.push(envKey);

    const fail = (code: SendRefusalCode, reason: string, attemptKey: string | null = null): SendRefused => ({
      ok: false,
      broadcast: false,
      code,
      reason: redact(reason, secrets),
      attempt_key: attemptKey,
    });

    // ── pre-flight interlock pass ───────────────────────────────────────────
    const pre = this.interlocks(req, secrets);
    if (!pre.ok) return pre;
    const r = pre.resolved;

    const { signer, rpc } = req;
    if (!rpc) {
      return fail('no_rpc', 'no ChainRpc configured; refusing to build a transaction with no node to check it against');
    }

    // ── build ───────────────────────────────────────────────────────────────
    let nonce: number;
    let gas: bigint;
    let gasPrice: bigint | null = null;
    let simulated: string;
    // A dry run needs no key at all: nothing is signed, so there is nothing to
    // leak. This is the safe default and the reason dry_run defaults to true.
    // Without a signer the simulation is not identity-bound, which we surface
    // in the reason rather than hide.
    const from = signer?.address ?? '0x0000000000000000000000000000000000000000';

    if (!HEX_ADDR.test(from)) {
      return fail('no_signer', 'signer.address is not a 0x-prefixed 20-byte address');
    }

    const callTx: CallTx = {
      from,
      to: req.tx.to.toLowerCase(),
      data: r.data,
      value: toHexQty(r.value),
    };

    try {
      nonce = await rpc.getNonce(from);
    } catch (e) {
      return fail('rpc_error', `getNonce failed: ${messageOf(e)}`);
    }
    if (!Number.isInteger(nonce) || nonce < 0) {
      return fail('rpc_error', 'getNonce returned a non-integer nonce');
    }

    try {
      gas = await rpc.estimateGas(callTx);
    } catch (e) {
      return fail('rpc_error', `estimateGas failed: ${messageOf(e)}`);
    }

    try {
      simulated = await rpc.call(callTx);
    } catch (e) {
      return fail('simulation_reverted', `eth_call reverted: ${messageOf(e)}`);
    }

    if (rpc.gasPrice) {
      try {
        gasPrice = await rpc.gasPrice();
      } catch {
        gasPrice = null;
      }
    }

    const attemptKey = await attemptFingerprint({
      chainId: r.chainId,
      from,
      to: callTx.to,
      data: r.data,
      value: r.value,
      operator: r.operator,
    });

    const signable: SignableTx = {
      from,
      to: callTx.to,
      data: r.data,
      value: toHexQty(r.value),
      chainId: toHexQty(BigInt(r.chainId)),
      nonce: toHexQty(BigInt(nonce)),
      gas: toHexQty(gas),
    };
    if (gasPrice !== null) {
      // 2x headroom on the base fee, 1 gwei-ish tip floor is the signer's call;
      // we only supply the ceiling inputs.
      signable.maxFeePerGas = toHexQty(gasPrice * 2n);
      signable.maxPriorityFeePerGas = toHexQty(gasPrice);
      signable.gasPrice = toHexQty(gasPrice);
    }

    // ── dry run stops here ──────────────────────────────────────────────────
    if (!r.broadcast) {
      return {
        ok: true,
        broadcast: false,
        code: 'dry_run_ok',
        reason: 'dry run: built, gas-estimated and simulated; nothing was signed or broadcast',
        chain_id: r.chainId,
        from,
        operator: r.operator,
        attempt_key: attemptKey,
        gas_estimate: toHexQty(gas),
        simulated,
        tx_hash: null,
        status: null,
        gas_used: null,
        block: null,
      };
    }

    // ── signing ─────────────────────────────────────────────────────────────
    if (!signer) {
      // A broadcast was requested but no signing boundary was injected. If the
      // env var is present we say so precisely; either way nothing is signed.
      return envKey
        ? fail(
            'no_signer',
            `a ${PRIVATE_KEY_ENV} is present but no Signer is injected; this build ships no ` +
              'secp256k1 signer, so the key cannot be used in-process. Inject ' +
              '{ address, signTransaction } to broadcast.',
            attemptKey,
          )
        : fail(
            'no_private_key',
            `broadcast requires a signer; neither an injected Signer nor ${PRIVATE_KEY_ENV} is available`,
            attemptKey,
          );
    }

    // ── second, independent interlock pass, immediately before the wire ─────
    const preBroadcast = this.interlocks(req, secrets, { requireBroadcast: true });
    if (!preBroadcast.ok) return preBroadcast;

    // ── idempotency claim ───────────────────────────────────────────────────
    if (this.sent.has(attemptKey) || this.inFlight.has(attemptKey)) {
      return fail(
        'duplicate_send',
        'this exact transaction has already been submitted by this relay; refusing to double-send',
        attemptKey,
      );
    }
    this.inFlight.add(attemptKey);

    let rawSigned: string;
    try {
      rawSigned = await signer.signTransaction(signable);
    } catch (e) {
      // keep the claim: a signer that threw may still have emitted something.
      this.inFlight.delete(attemptKey);
      this.sent.add(attemptKey);
      return fail('rpc_error', `signer refused: ${messageOf(e)}`, attemptKey);
    }
    if (typeof rawSigned !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rawSigned)) {
      this.inFlight.delete(attemptKey);
      this.sent.add(attemptKey);
      return fail('no_signer', 'signer returned a non-hex signed transaction', attemptKey);
    }

    let txHash: string;
    try {
      txHash = await rpc.sendRawTransaction(rawSigned);
    } catch (e) {
      this.inFlight.delete(attemptKey);
      this.sent.add(attemptKey);
      return fail('rpc_error', `sendRawTransaction failed: ${messageOf(e)}`, attemptKey);
    }
    this.inFlight.delete(attemptKey);
    this.sent.add(attemptKey);

    // ── bounded receipt ─────────────────────────────────────────────────────
    let receipt: ReceiptLike | null = null;
    try {
      receipt = await rpc.getReceipt(txHash);
    } catch {
      receipt = null; // submitted but not yet observable; hash is still returned
    }

    // Note: `rawSigned` goes out of scope here and is never attached to a result.
    return {
      ok: true,
      broadcast: true,
      code: 'broadcast_ok',
      reason: receipt
        ? 'broadcast and mined'
        : 'broadcast; receipt not yet available',
      chain_id: r.chainId,
      from,
      operator: r.operator,
      attempt_key: attemptKey,
      gas_estimate: toHexQty(gas),
      simulated,
      tx_hash: txHash,
      status: receipt ? receipt.status : null,
      gas_used: receipt ? receipt.gasUsed.toString() : null,
      block: receipt ? receipt.blockNumber : null,
    };
  }

  /**
   * The interlock ladder. Pure w.r.t. the request; returns either a refusal or
   * the resolved send. Called twice per broadcast (entry + pre-wire) so no
   * single check is load-bearing on its own.
   */
  private interlocks(
    req: SendRequest,
    secrets: readonly string[],
    opts: { requireBroadcast?: boolean } = {},
  ): { ok: true; resolved: Resolved } | SendRefused {
    const fail = (code: SendRefusalCode, reason: string): SendRefused => ({
      ok: false,
      broadcast: false,
      code,
      reason: redact(reason, secrets),
      attempt_key: null,
    });

    // (1a) grant present
    const grant = req.grant;
    if (!grant || typeof grant !== 'object') {
      return fail(
        'no_grant',
        'no LiveWriteGrant supplied; live chain writes require an explicit operator grant',
      );
    }
    // (1b) grant is an actual approval
    if (grant.approved !== true) {
      return fail('grant_not_approved', 'grant.approved is not true; treating the grant as absent');
    }
    if (typeof grant.operator !== 'string' || grant.operator.trim() === '') {
      return fail('grant_invalid', 'grant.operator is empty; an anonymous grant is not an approval');
    }
    if (!Number.isInteger(grant.chain_id)) {
      return fail('grant_invalid', 'grant.chain_id is not an integer');
    }
    if (typeof grant.max_value_wei !== 'bigint') {
      return fail('grant_invalid', 'grant.max_value_wei must be a bigint (wei), not a number or string');
    }

    // (2) only proven verdicts are eligible
    const verdict = req.verdict?.verdict;
    if (verdict !== 'proven') {
      return fail(
        'verdict_not_proven',
        `verdict is '${String(verdict)}'; only 'proven' findings may write to a live chain`,
      );
    }

    // (6) expiry
    const now = req.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(now)) return fail('grant_invalid', 'clock is not a finite number');
    if (now > grant.expires_at) {
      return fail(
        'grant_expired',
        `grant expired at ${grant.expires_at} (now ${Math.floor(now)}); ask the operator for a fresh grant`,
      );
    }

    // tx shape + chain agreement
    const tx = req.tx;
    if (!tx || typeof tx.to !== 'string' || !HEX_ADDR.test(tx.to)) {
      return fail('grant_invalid', 'tx.to is not a 0x-prefixed 20-byte address');
    }
    const data = normData(tx.data);
    if (data === null) return fail('grant_invalid', 'tx.data is not 0x-prefixed hex');
    if ((data.length - 2) / 2 > MAX_DATA_BYTES) {
      return fail('data_too_large', `tx.data exceeds ${MAX_DATA_BYTES} bytes`);
    }
    if (typeof tx.value !== 'bigint') {
      return fail('grant_invalid', 'tx.value must be a bigint (wei)');
    }
    if (tx.value < 0n) return fail('value_negative', 'tx.value is negative');

    const chainId = tx.chain_id ?? grant.chain_id;
    if (!Number.isInteger(chainId)) return fail('grant_invalid', 'tx.chain_id is not an integer');
    if (chainId !== grant.chain_id) {
      return fail(
        'grant_chain_mismatch',
        `tx.chain_id ${chainId} does not match grant.chain_id ${grant.chain_id}`,
      );
    }

    // (3) chain allowlist, then the mainnet double switch
    const allowed = DEFAULT_ALLOWED_CHAINS.includes(chainId) || isMainnet(chainId);
    if (!allowed) {
      return fail(
        'chain_not_allowed',
        `chain ${chainId} is not on the relay allowlist (${DEFAULT_ALLOWED_CHAINS.join(', ')} plus mainnet with confirmation)`,
      );
    }
    if (isMainnet(chainId)) {
      // Both switches, not either.
      const grantSide = grant.allow_mainnet === true;
      const callSite = req.confirm_mainnet === true;
      if (!grantSide || !callSite) {
        return fail(
          'mainnet_needs_double_confirm',
          `chain ${chainId} is mainnet: requires grant.allow_mainnet AND confirm_mainnet ` +
            `(got allow_mainnet=${grantSide}, confirm_mainnet=${callSite})`,
        );
      }
    }

    // (5) value cap
    if (tx.value > grant.max_value_wei) {
      return fail('value_over_cap', `${WEI_CEILING_MESSAGE} (${tx.value} > ${grant.max_value_wei})`);
    }

    // (4) dry-run default. `requireBroadcast` makes the second pass assert the
    // same thing from the other direction.
    const broadcast = req.dry_run === false;
    if (opts.requireBroadcast && !broadcast) {
      return fail('no_grant', 'broadcast path reached with dry_run not explicitly false');
    }

    return {
      ok: true,
      resolved: {
        chainId,
        from: '',
        data,
        value: tx.value,
        operator: grant.operator,
        grant,
        broadcast,
      },
    };
  }
}

/** Module-level relay for the Worker isolate. */
export const defaultRelay = new SendRelay();

/**
 * The function the Telegram layer should call once a grant exists.
 *
 *   sendTransaction({
 *     verdict:            { verdict: 'proven' },
 *     tx:                 { to: '0x…', data: '0x…', value: 0n },
 *     grant:              { approved: true, operator: 'jennifer', chain_id: 84532,
 *                           max_value_wei: 10_000_000_000_000_000n, expires_at: 1_800_000_000n },
 *     signer:             { address: '0x…', signTransaction: async (tx) => rawHex },
 *     rpc:                chainRpcFromFetch(env),   // caller-supplied
 *     env,
 *     dry_run:            true,        // omit OR true => simulate only
 *     confirm_mainnet:    false,       // must be true, with allow_mainnet, for 8453/1
 *   })
 *
 * Returns SendResult; it never throws for a refusal.
 */
export async function sendTransaction(req: SendRequest): Promise<SendResult> {
  return defaultRelay.send(req);
}
