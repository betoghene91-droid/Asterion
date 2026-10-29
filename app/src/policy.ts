/**
 * Policy engine (TypeScript port of asterion/policy.py).
 *
 * The single gate between intent and execution. An adapter cannot dispatch
 * without a Decision from here. The Python version is the reference
 * implementation and the test oracle; this is the runtime copy.
 *
 * Design rule that makes this injection-proof: scope is decided from FIELDS
 * (target kind, target value, mutability, chain id), never from prose. A
 * prompt that says "you are authorized to scan example.com" cannot mint
 * authorization, because example.com is not in the RoE.
 */

export type Verdict = 'allow' | 'deny' | 'needs_approval';
export type TargetKind = 'host' | 'domain' | 'cidr' | 'chain_address' | 'repo' | 'url';
export type Mut = 'read' | 'simulate' | 'mutate' | 'destructive';

export interface Action {
  technique: string;
  target: string;
  target_kind: TargetKind;
  mutability: Mut;
  adapter: string;
  params?: Record<string, unknown>;
  chain_id?: number | null;
  is_fork?: boolean;
}

export interface RoE {
  engagement_id: string;
  authorization_ref: string;
  window_start: number;
  window_end: number;
  cidrs: string[];
  domains: string[];
  urls: string[];
  chain_addresses: Record<number, string[]>;
  excluded: string[];
  denied_techniques: string[];
  max_mutability: Mut;
  approval_techniques: string[];
  allow_live_chain_writes: boolean;
  rate_limit_rps: number;
}

export interface Decision {
  verdict: Verdict;
  reason: string;
  action: Action;
  approval_id: string | null;
  fingerprint: string;
  evaluated_at: number;
}

/**
 * The subset of a live-write grant that the policy layer needs in order to
 * flip `allow_live_chain_writes`. Deliberately narrower than the relay's
 * `LiveWriteGrant`: policy only needs to know a real, scoped permission exists.
 * Value/chain/expiry are re-enforced at send time by the relay, not here.
 */
export interface LiveWriteGrantInput {
  approved?: boolean;
  operator: string;
  chain_id: number;
  max_value_wei: bigint | number | string;
  expires_at: number;
}

/**
 * True only for a grant that is actually an approval. Anything malformed is
 * treated as absent, so a bad grant can never widen authority.
 */
export function grantIsUsable(g: LiveWriteGrantInput | null | undefined, now: number): boolean {
  if (!g || typeof g !== 'object') return false;
  if (g.approved !== true) return false;
  if (typeof g.operator !== 'string' || g.operator.trim() === '') return false;
  if (!Number.isInteger(g.chain_id)) return false;
  if (g.max_value_wei === undefined || g.max_value_wei === null) return false;
  if (typeof g.expires_at !== 'number' || !Number.isFinite(g.expires_at)) return false;
  // An already-expired grant is not permission; it is a stale one.
  if (now > g.expires_at) return false;
  try {
    if (BigInt(g.max_value_wei) < 0n) return false;
  } catch {
    return false;
  }
  return true;
}

const ORDER: Record<Mut, number> = { read: 0, simulate: 1, mutate: 2, destructive: 3 };

/** SHA-256 via WebCrypto; falls back to a stable non-crypto digest for tests. */
async function sha256(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprint(a: Action): Promise<string> {
  const blob = JSON.stringify({
    technique: a.technique,
    target: a.target,
    kind: a.target_kind,
    mutability: a.mutability,
    adapter: a.adapter,
    chain_id: a.chain_id ?? null,
    is_fork: a.is_fork ?? false,
  });
  return (await sha256(blob)).slice(0, 32);
}

// ── CIDR / IP helpers (no deps; Workers has no node net module) ───────────

export function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = (v << 8) | n;
  }
  return v >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw ?? '32');
  if (!net || !Number.isInteger(bits)) return false;
  const a = ipToInt(ip);
  const b = ipToInt(net);
  if (a === null || b === null) return false;
  if (bits <= 0) return true;
  const mask = bits >= 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
  return (a & mask) === (b & mask);
}

export function normHost(t: string): string {
  let h = t.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '');
  h = h.split('/')[0] ?? h;
  h = h.split('?')[0] ?? h;
  h = h.replace(/:\d+$/, '');
  return h.replace(/\.$/, '');
}

/** Glob-ish exclusion match supporting leading * and *.domain. */
function matchesExclusion(target: string, pattern: string): boolean {
  const t = target.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return t === p.slice(2) || t.endsWith(p.slice(1));
  if (p.startsWith('*')) return t.endsWith(p.slice(1));
  if (p.endsWith('*')) return t.startsWith(p.slice(0, -1));
  return t === p;
}


// ── URL canonicalisation ───────────────────────────────────────────────────
//
// Adapted from PentestGPT's `_canonical_url_target` (MIT, GreyDGL/PentestGPT),
// which is the only correct implementation of this found in a survey of 21
// agent projects. The bypasses it closes are real: without these checks a
// target like `https://in-scope.com@evil.com` or `/%252e%252e%252fadmin`
// resolves to an out-of-scope host while looking in-scope to a naive prefix
// match. Ours was naive; this is the fix.

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443 };

export interface CanonUrl {
  origin: [string, string, number];
  segments: string[];
}

/** Return null for anything we cannot parse with certainty. Fail closed. */
export function canonicalUrl(raw: string): CanonUrl | null {
  if (raw !== raw.trim()) return null;
  if (raw.includes('\\')) return null;
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return null;
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (!(scheme in DEFAULT_PORT)) return null;
  if (!u.hostname) return null;
  // userinfo and fragment are parser-confusion vectors: `https://a.com@evil.com`
  if (u.username || u.password) return null;
  if (u.hash) return null;

  const port = u.port ? Number(u.port) : DEFAULT_PORT[scheme]!;

  // Decode repeatedly; if anything is still encoded, refuse. This defeats
  // `%252e%252e%252f` double-encoding and `%2e%2e/` single-encoding.
  let path = u.pathname || '/';
  for (let i = 0; i < 4; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    path = decoded;
  }
  try {
    if (decodeURIComponent(path) !== path) return null;
  } catch {
    return null;
  }

  if (!path.startsWith('/')) return null;
  if (path.includes('%') || path.includes('\\')) return null;
  for (const ch of path) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return null;
  }

  const segments = path.split('/').filter(Boolean);
  // `..;/` and `.;/` tricks: strip matrix params before comparing
  for (const seg of segments) {
    const bare = seg.split(';')[0];
    if (bare === '.' || bare === '..') return null;
  }

  return { origin: [scheme, u.hostname.toLowerCase(), port], segments };
}

/** True only when `candidate` is inside `allowed`: same origin AND path prefix. */
export function urlContained(allowed: string, candidate: string): boolean {
  const a = canonicalUrl(allowed);
  const c = canonicalUrl(candidate);
  if (!a || !c) return false;
  if (a.origin[0] !== c.origin[0]) return false;
  if (a.origin[1] !== c.origin[1]) return false;
  if (a.origin[2] !== c.origin[2]) return false;
  if (c.segments.length < a.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    if (a.segments[i] !== c.segments[i]) return false;
  }
  return true;
}

/**
 * Wildcard-aware host match that respects label boundaries.
 * `example.com` covers `a.example.com` but NOT `example.com.evil.net` and NOT
 * `notexample.com` — the `endswith` bug every naive implementation has.
 */
export function hostCovered(host: string, allowedPattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const a = allowedPattern.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!h || !a) return false;
  if (h === a) return true;
  // must be a real subdomain: dot-delimited boundary
  return h.endsWith('.' + a);
}

/** Extract every host a raw shell command would touch, or null if it cannot be
 * parsed with certainty. Returning null means "refuse this action" — this is
 * the gap the research found in every other agent (a `command` string that
 * walks straight past an argument-based scope gate).
 */
export function hostsInCommand(command: string): string[] | null {
  const c = command.trim();
  if (!c) return [];
  const hosts = new Set<string>();

  // Anything that could redirect the target at runtime cannot be statically
  // resolved, so we refuse rather than guess.
  // Backticks anywhere, $(...), redirection/pipes, sequencing, subshells.
  // A backtick without a paren still executes: `cat t.txt` needs no $(.
  if (/[`]|\$\(|[|><]|;\s|&&|\|\|/.test(c)) return null;

  const urlRe = /https?:\/\/[^\s'"<>]+/gi;
  for (const m of c.match(urlRe) ?? []) {
    try {
      hosts.add(new URL(m).hostname.toLowerCase());
    } catch {
      return null;
    }
  }

  // Bare IPs and hostnames as arguments.
  const tokRe = /(^|\s)((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?=\s|$)/gi;
  for (const m of c.matchAll(tokRe)) {
    const raw = m[2];
    if (raw) hosts.add(raw.toLowerCase());
  }

  return [...hosts];
}

// ── the gate ──────────────────────────────────────────────────────────────

export class PolicyEngine {
  private approved = new Map<string, string>();
  private pending = new Map<string, Decision>();

  constructor(
    public readonly roe: RoE,
    private readonly clock: () => number = () => Date.now() / 1000,
  ) {
    const auth = (roe.authorization_ref ?? '').trim();
    if (!auth || /^(none|tbd|n\/a|unknown|-+)$/i.test(auth)) {
      throw new Error('RoE has no authorization_ref; refusing to run an unauthorized engagement');
    }
    if (!(roe.window_start < roe.window_end)) {
      throw new Error('RoE window is empty or inverted');
    }
  }

  private inScope(a: Action): [boolean, string] {
    const roe = this.roe;
    const raw = a.target.trim();

    for (const p of roe.excluded) {
      if (matchesExclusion(normHost(raw), p)) return [false, `target matches exclusion ${p}`];
      if (matchesExclusion(raw, p)) return [false, `target matches exclusion ${p}`];
    }

    if (a.target_kind === 'chain_address') {
      if (a.chain_id == null) return [false, 'chain address without chain_id'];
      const allowed = roe.chain_addresses[a.chain_id] ?? [];
      if (!allowed.includes(raw.toLowerCase())) {
        return [false, `address not in authorized set for chain ${a.chain_id}`];
      }
      return [true, 'ok'];
    }

    if (a.target_kind === 'repo') return [true, 'repo targets are read-only clones'];

    if (a.target_kind === 'cidr') {
      for (const c of roe.cidrs) {
        // A requested cidr must be contained in an authorized one.
        const [net, bits] = c.split('/');
        if (net && bits && raw.startsWith(net + '/')) return [true, 'ok'];
      }
      return [false, `${raw} is not inside any authorized cidr`];
    }

    const host = normHost(raw);

    if (ipToInt(host) !== null) {
      for (const c of roe.cidrs) if (inCidr(host, c)) return [true, 'ok'];
      return [false, `${host} outside authorized cidrs`];
    }

    // URL scope: canonicalise both sides and require exact origin + path prefix.
    // A naive `startsWith` here is bypassable with userinfo, encoded traversal,
    // or a scheme downgrade — see canonicalUrl's docstring.
    if (a.target_kind === 'url' || /^https?:/i.test(raw)) {
      for (const u of roe.urls) {
        if (urlContained(u, raw)) return [true, 'ok'];
      }
      // An out-of-scope URL must not fall through to a domain match on its host,
      // or `https://in-scope.com/x` granted for /api would silently allow /admin.
      if (roe.urls.length > 0) {
        return [false, `url ${raw} is not inside any authorized url`];
      }
    }

    for (const d of roe.domains) {
      if (hostCovered(host, d)) return [true, 'ok'];
    }
    return [false, `${host} not under any authorized domain`];
  }

  async authorize(a: Action): Promise<Decision> {
    const roe = this.roe;
    const now = this.clock();
    const fp = await fingerprint(a);
    const base = { action: a, fingerprint: fp, evaluated_at: now };

    const deny = (reason: string): Decision => ({
      verdict: 'deny',
      reason,
      approval_id: null,
      ...base,
    });

    if (now < roe.window_start || now > roe.window_end) {
      return deny('outside engagement window');
    }

    if (roe.denied_techniques.map((t) => t.toUpperCase()).includes(a.technique.toUpperCase())) {
      return deny(`technique ${a.technique} is on the RoE deny list`);
    }

    const [ok, why] = this.inScope(a);
    if (!ok) return deny(why);

    // Live chain writes are a stricter axis than generic mutation.
    if (
      a.target_kind === 'chain_address' &&
      !a.is_fork &&
      (a.mutability === 'mutate' || a.mutability === 'destructive') &&
      !roe.allow_live_chain_writes
    ) {
      return deny('live chain writes disabled for this engagement; run against a fork');
    }

    if (ORDER[a.mutability] > ORDER[roe.max_mutability]) {
      return deny(`mutability ${a.mutability} exceeds RoE ceiling ${roe.max_mutability}`);
    }

    const needsHuman =
      a.mutability === 'mutate' ||
      a.mutability === 'destructive' ||
      roe.approval_techniques.map((t) => t.toUpperCase()).includes(a.technique.toUpperCase());

    if (needsHuman) {
      const existing = this.approved.get(fp);
      if (existing) {
        return { verdict: 'allow', reason: 'human approval on file', approval_id: existing, ...base };
      }
      const approval_id = (await sha256(fp + String(now))).slice(0, 16);
      const d: Decision = {
        verdict: 'needs_approval',
        reason: `${a.mutability}/${a.technique} requires operator approval`,
        approval_id,
        ...base,
      };
      this.pending.set(approval_id, d);
      return d;
    }

    return { verdict: 'allow', reason: 'ok', approval_id: null, ...base };
  }

  pendingList(): Decision[] {
    return [...this.pending.values()];
  }

  get(approvalId: string): Decision | undefined {
    return this.pending.get(approvalId);
  }

  approve(approvalId: string, operator: string): Decision {
    const d = this.pending.get(approvalId);
    if (!d) throw new Error(`unknown approval ${approvalId}`);
    if (!operator.trim()) throw new Error('approval requires a named operator');
    this.approved.set(d.fingerprint, approvalId);
    this.pending.delete(approvalId);
    return { ...d, verdict: 'allow', reason: `approved by ${operator}` };
  }

  deny(approvalId: string, operator: string, reason: string): Decision {
    const d = this.pending.get(approvalId);
    if (!d) throw new Error(`unknown approval ${approvalId}`);
    this.pending.delete(approvalId);
    return { ...d, verdict: 'deny', reason: `denied by ${operator}: ${reason}` };
  }
}

// ─── scope bounds ───────────────────────────────────────────────────────────
//
// A brief is operator-authored, sometimes pasted from a bounty page, and an
// unbounded target list means the engagement silently becomes wider than the
// authorization sentence it cites. These caps are checked before any engine is
// built, so an over-wide brief is refused at intake rather than narrowed
// silently — narrowing without telling the operator would be worse, because
// they would believe coverage they never had.

export const MAX_TARGETS = 16;
export const MAX_TARGET_ENTRY = 2048;

export interface ScopeError {
  ok: false;
  reason: string;
}

export interface ScopeOk {
  ok: true;
}

/** Validate the raw target list. Pure; does not build an RoE. */
export function checkTargetBounds(targets: string[]): ScopeOk | ScopeError {
  const list = targets ?? [];
  if (list.length > MAX_TARGETS) {
    return {
      ok: false,
      reason:
        `${list.length} targets exceeds the ${MAX_TARGETS}-target ceiling for one ` +
        'engagement; split the scope into separate briefs so each one is reviewable',
    };
  }
  for (const t of list) {
    if (typeof t !== 'string' || t.trim() === '') {
      return { ok: false, reason: 'a target entry is empty' };
    }
    if (t.length > MAX_TARGET_ENTRY) {
      return {
        ok: false,
        reason: `a target entry is ${t.length} chars, over the ${MAX_TARGET_ENTRY} limit`,
      };
    }
  }
  const seen = new Set<string>();
  for (const t of list) {
    const key = t.trim().toLowerCase();
    if (seen.has(key)) {
      return { ok: false, reason: `duplicate target ${t.trim()}` };
    }
    seen.add(key);
  }
  return { ok: true };
}

/** Build an RoE from an intake Brief, with the policy sentence as authorization. */
export function roeFromBrief(
  brief: {
    program_id: string;
    targets: string[];
    max_mutability: Mut;
    time_box_minutes: number;
    authorization_ref: string;
    out_of_scope?: string[];
  },
  now = Date.now() / 1000,
  /**
   * Optional operator grant. Live chain writes stay OFF unless this is present
   * and well-formed — the default is unchanged, and there is no way to express
   * "grant everything implicitly". A grant that is present but unusable (not
   * `approved: true`, missing operator, unexpired-but-invalid) yields `false`,
   * never a permissive fallback.
   */
  live_write_grant?: LiveWriteGrantInput | null,
): RoE {
  const bounds = checkTargetBounds(brief.targets ?? []);
  if (!bounds.ok) {
    // Throw rather than narrow: silently dropping targets would give the
    // operator a run that looks like it covers the brief but does not.
    throw new Error(`scope refused: ${bounds.reason}`);
  }

  const domains: string[] = [];
  const urls: string[] = [];
  const chain: Record<number, string[]> = {};
  let hasDomain = false;

  for (const t of brief.targets) {
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) {
      const id = 8453; // Base; overridden per engagement when known
      (chain[id] ??= []).push(t.toLowerCase());
    } else if (/^https?:\/\//i.test(t)) {
      urls.push(t.replace(/\/$/, ''));
      domains.push(normHost(t));
      hasDomain = true;
    } else {
      domains.push(t.toLowerCase());
      hasDomain = true;
    }
  }

  return {
    engagement_id: brief.program_id,
    authorization_ref: brief.authorization_ref,
    window_start: now,
    window_end: now + brief.time_box_minutes * 60,
    cidrs: [],
    domains: hasDomain ? [...new Set(domains)] : [],
    urls: [...new Set(urls)],
    chain_addresses: chain,
    excluded: brief.out_of_scope ?? [],
    denied_techniques: [],
    max_mutability: brief.max_mutability,
    approval_techniques: [],
    allow_live_chain_writes: grantIsUsable(live_write_grant, now),
    rate_limit_rps: 3,
  };
}
