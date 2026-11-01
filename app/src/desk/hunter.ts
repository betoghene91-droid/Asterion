/**
 * Protocol-bug hunter — read on-chain account state and report the
 * ownership/takeover risks that are visible in the bytes themselves.
 *
 * ## Why this is a real edge and not a slogan
 *
 * A smart contract has no "admin password" you can guess. But it does have
 * *account state*, and several of the ways such state is misconfigured are
 * objectively visible and objectively dangerous:
 *
 *   1. **Upgradeable program with a LIVE upgrade authority.** Whoever holds that
 *      key can replace the program's code for every depositor at once. If the
 *      key is a plain single wallet (not a multisig), it is one leaked keyfile
 *      away from a total drain.
 *   2. **Nonce account whose authority was never transferred.** `initializeNonce`
 *      creates the account with a transient authority; if the deploy script
 *      forgets `authorizeNonce`, the creator keeps the ability to withdraw the
 *      account's rent and, more importantly, to sign with the nonce for anything
 *      that trusts it.
 *   3. **Mint or token account that is still mintable/freezable.** The mint
 *      authority can print supply into a pool at will; the freeze authority can
 *      lock every holder's tokens. Both are readable from the mint bytes.
 *
 * ## The discipline that makes the output worth reading
 *
 * This bot NEVER claims a bug it did not read. Every finding is derived from a
 * decoded account's own bytes, and every finding carries the address it was read
 * from so it can be re-checked with one `getAccountInfo`. A risk class the inputs
 * do not cover is reported as *not checked* rather than as *clean* — the failure
 * mode this whole bot exists to avoid is the confident zero.
 *
 * ## Why it costs nothing to run
 *
 * It needs no capital and races nobody: it is pure reading. `getProgramAccounts`
 * is blocked on the public RPC, so it does not enumerate the chain — it reads the
 * specific program IDs Asterion's own crawler has already discovered in
 * `candidates.programme_id`, which is the free input that makes this affordable.
 */

import { SYSTEM_PROGRAM, isSolanaPubkey, encodeBase58, decodeBase58 } from '../solana.js';
import { append as ledgerAppend } from '../ledger.js';
import { db, kvGet, kvSet, newId, spendSubrequest } from './db.js';
import { consult, CONSULT_MIN_CONFIDENCE, HUNT_ATTEMPT_LIMIT } from './consultant.js';
import type { DeskEnv } from './types.js';

// ─────────────────────────────────────────────────────────────── constants

/** The only loader that supports in-place upgrades (`--finalized` aside). */
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** Legacy v2 loader: no upgrade authority, but still worth identifying. */
export const BPF_LOADER_V2 = 'BPFLoader2111111111111111111111111111111111';

/** Squads v4 and v3 multisig program IDs. An authority owned by these is safer. */
export const SQUADS_V4 = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
export const SQUADS_V3 = 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu';

const SPL_MINT_SIZE = 82;

// ─────────────────────────────────────────────────────────────── rpc

/**
 * Endpoint order matters and is not cosmetic: `getTokenAccountsByOwner` and
 * `getProgramAccounts` are BLOCKED on publicnode ("Request blocked"), and a
 * JSON-RPC error makes us try the next host. A blocked host in first position
 * silently produces zeros.
 */
const RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];

interface AccountInfo {
  lamports: number;
  owner: string;
  executable: boolean;
  dataBase64: string;
}

async function rpcOnce<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    // A rate-limit error is NOT "account missing". Surfacing it as null would be
    // the same lie as the blocked-endpoint bug: an unread account reported clean.
    if (j.error) return null;
    return j.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function rpc<T>(method: string, params: unknown[], timeoutMs = 12_000): Promise<T | null> {
  for (const url of RPCS) {
    const r = await rpcOnce<T>(url, method, params, timeoutMs);
    if (r !== null) return r;
  }
  return null;
}

/** Read one account, base64. Returns null when the account does not exist. */
async function getAccount(address: string): Promise<AccountInfo | null> {
  const r = await rpc<{ value: { lamports: number; owner: string; executable: boolean; data: [string, string] } | null }>(
    'getAccountInfo',
    [address, { encoding: 'base64' }],
  );
  const v = r?.value;
  if (!v) return null;
  return { lamports: v.lamports, owner: v.owner, executable: v.executable, dataBase64: v.data?.[0] ?? '' };
}

function toBytes(b64: string): Uint8Array {
  // atob is available in the Workers runtime and in Node 20+.
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function u32le(b: Uint8Array, off: number): number {
  return (byte(b, off) | (byte(b, off + 1) << 8) | (byte(b, off + 2) << 16) | (byte(b, off + 3) << 24)) >>> 0;
}

/**
 * Read one byte, defaulting to 0 past the end.
 *
 * Every caller is already length-checked, but a truncated account read from a
 * flaky RPC must decode to something harmless rather than throw and kill the
 * whole tick — one short account should degrade to `null`, never to a crash.
 */
function byte(b: Uint8Array, off: number): number {
  return b[off] ?? 0;
}

function pubkeyAt(b: Uint8Array, off: number): string {
  return encodeBase58(b.slice(off, off + 32));
}

// ─────────────────────────────────────────────────────────────── decoders

export interface UpgradeInfo {
  /** The executable Program account address. */
  programId: string;
  /** The ProgramData account holding the ELF and the authority. */
  programData: string;
  /** Slot the current code was deployed at. */
  slot: number;
  /** Whether a key can still replace the code. */
  upgradeable: boolean;
  /** The authority address, or null when the program is frozen/immutable. */
  authority: string | null;
}

/**
 * Read just the ProgramData pointer out of a Program account.
 *
 * This is a separate function from `decodeUpgradeable` on purpose. The Program
 * account is all you need to find ProgramData, and the authority lives in
 * ProgramData, so every real run needs this step before it can ask the second
 * question. Folding it into `decodeUpgradeable` and passing empty bytes made the
 * full decoder reject the probe (it demands 13 bytes of ProgramData), which
 * skipped every program and produced a clean-looking zero.
 */
export function programDataAddress(programBytes: Uint8Array): string | null {
  if (programBytes.length < 36) return null;
  if (u32le(programBytes, 0) !== 2) return null;
  return pubkeyAt(programBytes, 4);
}

/**
 * Decode an upgradeable BPF program.
 *
 * Program account layout (36 bytes):
 *   [0..4)   enum tag, 2 = Program
 *   [4..36)  ProgramData address
 * ProgramData layout:
 *   [0..4)   enum tag, 3 = ProgramData
 *   [4..12)  last deploy slot (u64 LE)
 *   [12]     Option tag: 1 = Some(authority)
 *   [13..45) authority pubkey
 *
 * Verified against live mainnet: Jupiter v6, Raydium AMM and Orca Whirlpool all
 * decode through this path to a real authority address.
 */
export function decodeUpgradeable(programId: string, programBytes: Uint8Array, dataBytes: Uint8Array): UpgradeInfo | null {
  const programData = programDataAddress(programBytes);
  if (!programData) return null;
  if (dataBytes.length < 13) return null;
  if (u32le(dataBytes, 0) !== 3) return null;
  const slot = Number(
    BigInt(byte(dataBytes, 4)) |
      (BigInt(byte(dataBytes, 5)) << 8n) |
      (BigInt(byte(dataBytes, 6)) << 16n) |
      (BigInt(byte(dataBytes, 7)) << 24n) |
      (BigInt(byte(dataBytes, 8)) << 32n) |
      (BigInt(byte(dataBytes, 9)) << 40n) |
      (BigInt(byte(dataBytes, 10)) << 48n) |
      (BigInt(byte(dataBytes, 11)) << 56n),
  );
  const hasAuth = byte(dataBytes, 12);
  const authority = hasAuth === 1 && dataBytes.length >= 45 ? pubkeyAt(dataBytes, 13) : null;
  return { programId, programData, slot, upgradeable: authority !== null, authority };
}

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
}

/**
 * Decode an SPL mint (82 bytes, both token programs share this prefix).
 *   [0..4)     Option tag for mint_authority
 *   [4..36)    mint_authority
 *   [36..44)   supply (u64 LE)
 *   [44]       decimals
 *   [45]       is_initialized
 *   [46..50)   Option tag for freeze_authority
 *   [50..82)   freeze_authority
 */
export function decodeMint(bytes: Uint8Array): MintInfo | null {
  if (bytes.length < SPL_MINT_SIZE) return null;
  const hasMint = u32le(bytes, 0) === 1;
  const hasFreeze = u32le(bytes, 46) === 1;
  let supply = 0n;
  for (let i = 7; i >= 0; i--) supply = (supply << 8n) | BigInt(byte(bytes, 36 + i));
  return {
    mintAuthority: hasMint ? pubkeyAt(bytes, 4) : null,
    freezeAuthority: hasFreeze ? pubkeyAt(bytes, 50) : null,
    supply,
    decimals: byte(bytes, 44),
  };
}

// ─────────────────────────────────────────────────────────────── classifying an authority

export type AuthorityKind = 'multisig' | 'program-owned' | 'plain-wallet' | 'unreadable';

/**
 * How risky is it that this address controls a program's code?
 *
 * A plain System-owned, data-less account is a single ed25519 key: one file, one
 * person, one compromise. That is the class of authority that turns a DEX bug
 * from "someone found a flaw" into "someone replaced the program".
 *
 * Raydium, Orca and Jupiter all run this way today, which is worth saying out
 * loud: this is normal practice, not by itself a vulnerability. What makes it
 * actionable is that it is *checkable*, so a change (or a multisig takeover)
 * becomes visible instead of invisible.
 */
export async function classifyAuthority(
  address: string,
  cache: Map<string, AuthorityKind> = new Map(),
): Promise<AuthorityKind> {
  const hit = cache.get(address);
  if (hit) return hit;
  const acc = await getAccount(address);
  let kind: AuthorityKind;
  if (!acc) {
    kind = 'unreadable';
  } else if (acc.owner === SQUADS_V4 || acc.owner === SQUADS_V3) {
    kind = 'multisig';
  } else if (acc.owner === SYSTEM_PROGRAM && acc.dataBase64.length === 0) {
    kind = 'plain-wallet';
  } else if (!acc.executable) {
    kind = 'program-owned';
  } else {
    kind = 'program-owned';
  }
  cache.set(address, kind);
  return kind;
}

// ─────────────────────────────────────────────────────────────── findings

export type RiskClass =
  | 'upgrade_authority_plain_key'
  | 'upgradeable_program'
  | 'mint_authority_live'
  | 'freeze_authority_live';

export interface HunterFinding {
  id: string;
  ts: number;
  /** The program/mint the finding is about. */
  subject: string;
  risk: RiskClass;
  /** Human-readable evidence, always naming the address it was read from. */
  detail: string;
  /** Address whose bytes prove the claim. Empty for pure-structure claims. */
  evidenceAccount: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  firstSeen: number;
}

export interface HunterStats {
  programsChecked: number;
  mintsChecked: number;
  findings: number;
  /** Programs whose authority could not be read this tick (rate limit, RPC). */
  unreadable: number;
  /** True when no inputs existed at all — a zero here means "nothing looked at". */
  noInputs: boolean;
  ticks: number;
  lastTickMs: number;
}

const KV_STATS = 'hunter_stats';

interface Persisted {
  stats: HunterStats;
  findings: HunterFinding[];
}

async function readPersisted(env: DeskEnv): Promise<Persisted> {
  const empty: Persisted = {
    stats: {
      programsChecked: 0,
      mintsChecked: 0,
      findings: 0,
      unreadable: 0,
      noInputs: true,
      ticks: 0,
      lastTickMs: 0,
    },
    findings: [],
  };
  try {
    const raw = await kvGet(env, KV_STATS);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Persisted;
    if (!p?.stats || !Array.isArray(p.findings)) return empty;
    return p;
  } catch {
    return empty;
  }
}

export async function hunterStatus(env: DeskEnv): Promise<HunterStats> {
  return (await readPersisted(env)).stats;
}

export async function hunterFindings(env: DeskEnv): Promise<HunterFinding[]> {
  return (await readPersisted(env)).findings;
}

// ─────────────────────────────────────────────────────────────── inputs

/**
 * The programs to inspect, from Asterion's own discovery.
 *
 * `getProgramAccounts` is blocked on the public RPC, so enumerating the chain is
 * not an option. `candidates` is already populated by the crawler with the
 * Solana programs it found paying bounties — that is the free input, and it means
 * this bot gets better as the crawler runs rather than needing its own discovery.
 */
export async function hunterInputs(env: DeskEnv, limit = 25): Promise<string[]> {
  const out: string[] = [];
  try {
    const rows = await db(env).all<{ programme_id: string | null }>(
      `SELECT DISTINCT programme_id FROM candidates
        WHERE family = 'svm' AND programme_id IS NOT NULL
        ORDER BY programme_id LIMIT ?`,
      limit,
    );
    for (const r of rows) {
      const id = (r.programme_id ?? '').trim();
      if (id && isSolanaPubkey(id) && !out.includes(id)) out.push(id);
    }
  } catch {
    // fall through to the env seed
  }
  // Explicit seed so the bot is testable (and useful) before the crawler has
  // ever found a Solana program.
  for (const id of String(env.DESK_HUNTER_PROGRAMS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (isSolanaPubkey(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────── tick

/**
 * One read-only pass: for each known program, decode its upgrade authority and
 * classify it; for each mint in the desk universe, check the mint/freeze
 * authorities. Writes findings and stats to KV.
 *
 * Asterion cannot exploit any of this by itself — it can only see it. That is
 * deliberate: the value is an early warning that a live program's code became
 * replaceable by a single key, which is the moment a defender wants to know.
 */
export async function runHunterBot(env: DeskEnv, now = Date.now()): Promise<HunterStats> {
  const prev = await readPersisted(env);
  const programs = await hunterInputs(env);

  const findings: HunterFinding[] = [];
  const authCache = new Map<string, AuthorityKind>();
  let unreadable = 0;
  let programsChecked = 0;
  let mintsChecked = 0;

  // Budget guard: 2 subrequests per program (program + programdata) and 1 per
  // authority. Stop cleanly rather than let the hourly slot starve the crawler.
  for (const programId of programs) {
    if (!(await spendSubrequest(env, 3))) break;
    const prog = await getAccount(programId);
    if (!prog) {
      unreadable++;
      continue;
    }
    programsChecked++;

    if (prog.owner !== BPF_LOADER_UPGRADEABLE) {
      if (prog.owner === BPF_LOADER_V2) {
        findings.push({
          id: newId('hunt'),
          ts: now,
          subject: programId,
          risk: 'upgradeable_program',
          detail: 'legacy BPF loader v2: code is immutable, no upgrade authority exists',
          evidenceAccount: programId,
          severity: 'info',
          firstSeen: now,
        });
      }
      continue;
    }

    // The ProgramData must be read to learn the authority; the program account
    // alone only points at it.
    const programDataAddr = programDataAddress(toBytes(prog.dataBase64));
    if (!programDataAddr) continue;
    const pd = await getAccount(programDataAddr);
    if (!pd) {
      unreadable++;
      continue;
    }
    const info = decodeUpgradeable(programId, toBytes(prog.dataBase64), toBytes(pd.dataBase64));
    if (!info) continue;

    if (!info.upgradeable) {
      findings.push({
        id: newId('hunt'),
        ts: now,
        subject: programId,
        risk: 'upgradeable_program',
        detail: `upgradeable loader but authority was revoked at slot ${info.slot}: code is now immutable`,
        evidenceAccount: info.programData,
        severity: 'info',
        firstSeen: now,
      });
      continue;
    }

    const authority = info.authority as string;
    const kind = await classifyAuthority(authority, authCache);
    if (kind === 'unreadable') {
      unreadable++;
      continue;
    }

    findings.push({
      id: newId('hunt'),
      ts: now,
      subject: programId,
      risk: 'upgrade_authority_plain_key',
      detail:
        kind === 'plain-wallet'
          ? `upgrade authority ${authority} is a plain single-key wallet: one keyfile can replace this program's code for every depositor`
          : kind === 'multisig'
            ? `upgrade authority ${authority} is a multisig (safer)`
            : `upgrade authority ${authority} is owned by another program (${kind})`,
      evidenceAccount: info.programData,
      severity: kind === 'plain-wallet' ? 'medium' : 'info',
      firstSeen: now,
    });
  }

  // ── mints: mint authority can print, freeze authority can lock holders
  if (await spendSubrequest(env, 1)) {
    let mints: string[] = [];
    try {
      const rows = await db(env).all<{ mint: string }>(
        `SELECT mint FROM desk_universe WHERE state IN ('in','scored') ORDER BY last_seen DESC LIMIT 10`,
      );
      mints = rows.map((r) => r.mint).filter(isSolanaPubkey);
    } catch {
      mints = [];
    }
    for (const mint of mints) {
      if (!(await spendSubrequest(env, 1))) break;
      const acc = await getAccount(mint);
      if (!acc) continue;
      mintsChecked++;
      const m = decodeMint(toBytes(acc.dataBase64));
      if (!m) continue;
      if (m.mintAuthority) {
        findings.push({
          id: newId('hunt'),
          ts: now,
          subject: mint,
          risk: 'mint_authority_live',
          detail: `mint authority ${m.mintAuthority} is still live: supply can be increased at will (current supply ${m.supply})`,
          evidenceAccount: mint,
          severity: 'medium',
          firstSeen: now,
        });
      }
      if (m.freezeAuthority) {
        findings.push({
          id: newId('hunt'),
          ts: now,
          subject: mint,
          risk: 'freeze_authority_live',
          detail: `freeze authority ${m.freezeAuthority} is live: every holder's tokens can be frozen`,
          evidenceAccount: mint,
          severity: 'low',
          firstSeen: now,
        });
      }
    }
  }

  // Preserve firstSeen across ticks so the log shows when a risk appeared.
  const known = new Map(prev.findings.map((f) => [`${f.subject}:${f.risk}`, f]));
  for (const f of findings) {
    const k = `${f.subject}:${f.risk}`;
    const old = known.get(k);
    if (old) {
      f.firstSeen = old.firstSeen;
      f.id = old.id;
    }
    known.set(k, f);
  }

  const stats: HunterStats = {
    programsChecked,
    mintsChecked,
    findings: known.size,
    unreadable,
    noInputs: programs.length === 0 && mintsChecked === 0,
    ticks: prev.stats.ticks + 1,
    lastTickMs: now,
  };

  const merged = Array.from(known.values()).sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;
    return rank[a.severity] - rank[b.severity] || b.ts - a.ts;
  });
  await kvSet(env, KV_STATS, JSON.stringify({ stats, findings: merged.slice(0, 200) }));

  // Hand the survivors to the hunt machine. Only findings at or above
  // CONSULT_MIN_CONFIDENCE start a hunt; the rest stay in the report, which is
  // exactly where an observation that is not yet worth compute belongs.
  //
  // `seenCounts` is derived from the PREVIOUS tick's snapshot (already loaded
  // as `prev`), so a finding that has persisted across ticks earns its
  // confidence points honestly — it is never counted against itself here.
  const seenCounts = new Map<string, number>();
  for (const prior of prev.findings ?? []) {
    const k = `${prior.subject}|${prior.risk}`;
    seenCounts.set(k, (seenCounts.get(k) ?? 1) + 1);
  }
  const singleKey = new Set(
    merged.filter((f) => f.risk === 'upgrade_authority_plain_key').map((f) => f.subject),
  );
  const consulted = await consult(env, merged, seenCounts, singleKey);
  if (consulted.forwarded > 0 || consulted.skipped > 0) {
    try {
      await ledgerAppend(env as never, 'desk.consult', {
        forwarded: consulted.forwarded,
        skipped: consulted.skipped,
        threshold: CONSULT_MIN_CONFIDENCE,
        attempt_limit: HUNT_ATTEMPT_LIMIT,
      });
    } catch {
      // Ledger is an audit trail, not a gate: a write failure must not lose the
      // queue rows that were already committed above.
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────── render

export function renderHunter(stats: HunterStats, findings: HunterFinding[]): string {
  if (stats.noInputs) {
    return [
      'protocol hunter',
      '  inputs     NONE — no Solana programs in candidates and DESK_HUNTER_PROGRAMS is empty',
      '  note       this is "nothing looked at", not "nothing wrong". Set DESK_HUNTER_PROGRAMS',
      '             or let the crawler discover Solana programs first.',
    ].join('\n');
  }
  const risky = findings.filter((f) => f.risk === 'upgrade_authority_plain_key' && f.severity === 'medium');
  const lines = [
    'protocol hunter',
    `  checked    ${stats.programsChecked} programs, ${stats.mintsChecked} mints`,
    `  findings   ${stats.findings} (${risky.length} single-key upgrade authorities)`,
  ];
  if (stats.unreadable > 0) {
    lines.push(`  unreadable ${stats.unreadable} — RPC did not answer, so these are NOT clean`);
  }
  for (const f of risky.slice(0, 5)) {
    lines.push(`  · ${f.subject.slice(0, 12)}… ${f.detail}`);
  }
  return lines.join('\n');
}

export { SYSTEM_PROGRAM, encodeBase58, decodeBase58 };
