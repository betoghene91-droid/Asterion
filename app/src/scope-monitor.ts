/**
 * Scope-change monitor — the pure half. Snapshot, diff, and the pause decision.
 *
 * ── The legal risk this exists for ─────────────────────────────────────────
 *
 * Continuous hunting assumes a programme's scope is stable. It is not. A
 * programme narrows scope, retires a host, or moves a contract, and every
 * engagement still running against that asset is now unauthorized — not
 * "slightly out of policy", but testing a system nobody gave permission to
 * test. `ECOSYSTEM.md` §5 names this as the real legal risk of continuous
 * hunting and records that nothing in the tree covered it.
 *
 * ── Why this is only the pure half ─────────────────────────────────────────
 *
 * Catching a change requires re-reading the programme's scope document on a
 * schedule, and this tree has FIVE cron slots at the free-plan ceiling: zero
 * headroom, and `.github/workflows/**` is not this workstream's to edit. So the
 * decision function is built and tested here, and the wiring is left explicit
 * rather than half-done. See `docs/report-writer.md` for the exact follow-up.
 *
 * Splitting it this way is not a compromise on correctness: everything that
 * decides WHETHER to pause an engagement is in this file and is exercised by
 * `tests/scope-monitor.test.mjs` against real snapshots. What is absent is the
 * call site, and its absence cannot produce a wrong decision — it produces no
 * decision, which is the state the system is already in.
 *
 * ── The asymmetry that shapes every choice below ───────────────────────────
 *
 * A false pause costs one engagement and a re-read of the policy. A false
 * continue costs an out-of-scope test. So: when a diff cannot be interpreted,
 * when a snapshot is stale, when a programme's fetch failed — the decision is
 * PAUSE, and the reason says what could not be established. There is exactly
 * one "do nothing" outcome and it requires a clean, current, interpretable
 * comparison.
 */

/** One asset as the programme's scope document states it. */
export interface ScopedAsset {
  /** Same vocabulary as `assets.kind` in schema.sql. */
  kind: string;
  /** The exact string the programme published. Never normalised for matching. */
  value: string;
}

/**
 * A snapshot of one programme's scope at one moment.
 *
 * `sha256` is the digest of the scope document the assets were parsed from, so
 * two snapshots can be compared without re-parsing, and a change in the digest
 * with no change in the asset set is itself informative (the document was
 * edited, possibly in prose the parser ignores).
 */
export interface ScopeSnapshot {
  program_id: string;
  /** Unix seconds when the document was fetched. */
  fetched_at: number;
  /** Hex digest of the raw document. */
  sha256: string;
  assets: ScopedAsset[];
  /**
   * True when the fetch succeeded and the document was parsed. A snapshot exists
   * only for a successful read, so this is normally true; it is recorded so a
   * caller that persists a failure placeholder cannot pass one to `diff`.
   */
  parsed: boolean;
  /** Set when the parse was partial, e.g. "3 rows had an unknown asset_type". */
  parse_warnings?: string[];
}

export type ChangeKind = 'appeared' | 'disappeared' | 'kind_changed' | 'unchanged';

export interface ScopeChange {
  kind: ChangeKind;
  asset: ScopedAsset;
  /** For kind_changed: what it was. */
  was?: ScopedAsset;
}

export interface ScopeDiff {
  program_id: string;
  /** Assets in the new snapshot that were absent from the old one. */
  appeared: ScopeChange[];
  /** Assets in the old snapshot that are absent from the new one. THIS is the risk. */
  disappeared: ScopeChange[];
  /** Same value, different kind (e.g. host → url). Treated as a change, not a no-op. */
  kind_changed: ScopeChange[];
  /** True when the asset set is identical. */
  identical: boolean;
  /** True when the raw document digest differs even if the assets do not. */
  document_changed: boolean;
  /** Why the comparison could not be made, when it could not. */
  incomparable: string | null;
}

export type PauseVerdict = 'continue' | 'pause';

export interface PauseDecision {
  verdict: PauseVerdict;
  /** Human-readable reasons, in the order they were established. Never empty. */
  reasons: string[];
  /** Assets whose disappearance forces the pause, empty when continuing. */
  lost_assets: ScopedAsset[];
  /** Engagements to pause. Empty when continuing. */
  pause_engagements: string[];
}

/** An engagement as this module needs to see it. */
export interface MonitoredEngagement {
  id: string;
  program_id: string;
  status: string;
  /** The exact asset values this engagement was authorized to test. */
  assets: string[];
}

/** Key for an asset. Kind is part of the identity because a host→url change matters. */
function assetKey(a: ScopedAsset): string {
  return `${a.kind}\u0000${a.value}`;
}

/** Value-only key, used to detect a kind change for the same value. */
function valueKey(a: ScopedAsset): string {
  return a.value;
}

/**
 * Compare two snapshots of the same programme's scope.
 *
 * Ordering of the output is stable (sorted by kind then value) so a diff can be
 * logged, hashed, or compared between runs. `incomparable` is set — rather than
 * throwing — when the snapshots cannot be meaningfully compared, because the
 * caller must be able to record WHY it paused.
 */
export function diffScope(previous: ScopeSnapshot, current: ScopeSnapshot): ScopeDiff {
  const empty = (why: string): ScopeDiff => ({
    program_id: current?.program_id ?? previous?.program_id ?? '',
    appeared: [],
    disappeared: [],
    kind_changed: [],
    identical: false,
    document_changed: false,
    incomparable: why,
  });

  if (!previous || !current) return empty('one of the two snapshots is missing');
  if (!previous.program_id || !current.program_id) return empty('a snapshot has no program_id');
  if (previous.program_id !== current.program_id) {
    return empty(
      `the snapshots are for different programmes (${previous.program_id} vs ${current.program_id})`,
    );
  }
  if (!previous.parsed || !current.parsed) {
    return empty('a snapshot was not successfully parsed, so its asset set is not known');
  }

  const before = new Map(previous.assets.map((a) => [assetKey(a), a]));
  const after = new Map(current.assets.map((a) => [assetKey(a), a]));

  // Value → kinds, so a value present under two kinds is handled correctly.
  const beforeByValue = new Map<string, ScopedAsset[]>();
  for (const a of previous.assets) {
    const k = valueKey(a);
    const list = beforeByValue.get(k) ?? [];
    list.push(a);
    beforeByValue.set(k, list);
  }
  const afterByValue = new Map<string, ScopedAsset[]>();
  for (const a of current.assets) {
    const k = valueKey(a);
    const list = afterByValue.get(k) ?? [];
    list.push(a);
    afterByValue.set(k, list);
  }

  const appeared: ScopeChange[] = [];
  const disappeared: ScopeChange[] = [];
  const kindChanged: ScopeChange[] = [];

  for (const [key, asset] of after) {
    if (!before.has(key)) appeared.push({ kind: 'appeared', asset });
  }

  for (const [key, asset] of before) {
    if (after.has(key)) continue;
    // Absent under this kind. If the value survives under a different kind, that
    // is a kind change rather than a disappearance: the asset is still in scope,
    // described differently. Recording it as "disappeared" would pause a healthy
    // engagement; recording it as unchanged would hide a real scope edit.
    const stillThere = afterByValue.get(valueKey(asset)) ?? [];
    if (stillThere.length > 0) {
      kindChanged.push({ kind: 'kind_changed', asset: stillThere[0] as ScopedAsset, was: asset });
      continue;
    }
    disappeared.push({ kind: 'disappeared', asset });
  }

  // A value that appears under a NEW kind while also remaining under its old
  // kind is a genuine addition, not a kind change: the loop above only reports
  // kind changes for values that vanished from their original kind.
  const sortChanges = (list: ScopeChange[]) =>
    list.sort((a, b) => (a.asset.kind + a.asset.value).localeCompare(b.asset.kind + b.asset.value));
  sortChanges(appeared);
  sortChanges(disappeared);
  sortChanges(kindChanged);

  const identical = appeared.length === 0 && disappeared.length === 0 && kindChanged.length === 0;

  return {
    program_id: current.program_id,
    appeared,
    disappeared,
    kind_changed: kindChanged,
    identical,
    document_changed: previous.sha256 !== current.sha256,
    incomparable: null,
  };
}

/**
 * Decide whether an engagement may continue.
 *
 * `continue` requires ALL of: two comparable snapshots, no asset the engagement
 * depends on having disappeared, and the current snapshot not being stale. Any
 * other state pauses, with the reason named.
 *
 * The staleness check exists because of a specific failure: a cron that silently
 * stops running produces a snapshot that never updates, and a monitor that only
 * diffs two snapshots would compare the stale one to itself forever and report
 * "unchanged" — the most dangerous possible answer, since it looks like a
 * confirmed clean bill of health.
 */
export function decidePause(args: {
  engagement: MonitoredEngagement;
  previous: ScopeSnapshot;
  current: ScopeSnapshot;
  /** Unix seconds. Required: a decision about staleness with no clock is meaningless. */
  now: number;
  /** How old a snapshot may be before it can no longer support a `continue`. */
  max_snapshot_age_seconds?: number;
}): PauseDecision {
  const { engagement, previous, current, now } = args;
  const maxAge = args.max_snapshot_age_seconds ?? 7 * 24 * 60 * 60;
  const reasons: string[] = [];

  const bail = (why: string): PauseDecision => ({
    verdict: 'pause',
    reasons: [why],
    lost_assets: [],
    pause_engagements: [engagement.id],
  });

  if (!engagement || !engagement.id) return bail('the engagement has no id, so nothing can be paused');
  if (!Number.isFinite(now)) return bail('no clock was supplied, so snapshot freshness is unknown');
  if (engagement.program_id !== current?.program_id) {
    return bail(
      `the engagement belongs to programme ${engagement.program_id} but the snapshot is for ` +
        `${current?.program_id ?? '(none)'}, so this comparison says nothing about it`,
    );
  }
  if (engagement.status !== 'open') {
    // Not an error: a paused or closed engagement has nothing to pause. Stated
    // as a reason so the caller does not read `continue` as an endorsement.
    return {
      verdict: 'continue',
      reasons: [`the engagement is ${engagement.status}, so no pause action is required`],
      lost_assets: [],
      pause_engagements: [],
    };
  }

  const diff = diffScope(previous, current);
  if (diff.incomparable) {
    reasons.push(`the scope could not be compared: ${diff.incomparable}`);
    reasons.push('an uninterpretable comparison is treated as a scope loss, not as a clean result');
    return { verdict: 'pause', reasons, lost_assets: [], pause_engagements: [engagement.id] };
  }

  // Freshness. A snapshot older than the window cannot support "continue".
  const age = now - current.fetched_at;
  if (!Number.isFinite(current.fetched_at) || age > maxAge) {
    reasons.push(
      `the newest scope snapshot is ${Math.floor(age / 3600)}h old (limit ` +
        `${Math.floor(maxAge / 3600)}h), so a clean comparison would be against stale data`,
    );
    return { verdict: 'pause', reasons, lost_assets: [], pause_engagements: [engagement.id] };
  }
  if (age < 0) {
    reasons.push(
      `the newest scope snapshot is dated ${-age}s in the future, which means the clock or the ` +
        'snapshot is wrong; freshness cannot be established',
    );
    return { verdict: 'pause', reasons, lost_assets: [], pause_engagements: [engagement.id] };
  }

  // The load-bearing check: did any asset this engagement depends on leave scope?
  const gone = new Set(diff.disappeared.map((c) => c.asset.value));
  const lost = engagement.assets
    .filter((v) => gone.has(v))
    .map((v) => diff.disappeared.find((c) => c.asset.value === v)?.asset ?? { kind: 'unknown', value: v });

  if (lost.length > 0) {
    reasons.push(
      `${lost.length} asset(s) this engagement depends on left the programme's scope: ` +
        lost.map((a) => `${a.kind} ${a.value}`).join(', '),
    );
    if (diff.kind_changed.length > 0) {
      reasons.push(
        `${diff.kind_changed.length} asset(s) changed kind and were checked by value, not assumed lost`,
      );
    }
    return { verdict: 'pause', reasons, lost_assets: lost, pause_engagements: [engagement.id] };
  }

  reasons.push(
    diff.identical
      ? 'the asset set is unchanged and the snapshot is current'
      : 'no asset this engagement depends on disappeared; the scope changed elsewhere',
  );
  if (diff.document_changed && diff.identical) {
    reasons.push(
      'the scope document itself changed while the parsed asset set did not, so a prose-only ' +
        'scope restriction is possible and should be read by a human',
    );
  }
  if (diff.kind_changed.length > 0) {
    reasons.push(
      `${diff.kind_changed.length} asset(s) changed kind (for example host → url); the engagement ` +
        'continues but its recorded asset kind is now stale',
    );
  }

  return { verdict: 'continue', reasons, lost_assets: [], pause_engagements: [] };
}

/** The minimal snapshot a caller can persist, so a diff survives a process restart. */
export function snapshotForStorage(s: ScopeSnapshot): string {
  // Sorted so a stored snapshot is canonical and two stores can be compared.
  const assets = [...s.assets]
    .map((a) => ({ kind: a.kind, value: a.value }))
    .sort((a, b) => (a.kind + a.value).localeCompare(b.kind + b.value));
  const doc = {
    program_id: s.program_id,
    fetched_at: s.fetched_at,
    sha256: s.sha256,
    parsed: s.parsed,
    assets,
    ...(s.parse_warnings?.length ? { parse_warnings: s.parse_warnings } : {}),
  };
  return JSON.stringify(doc);
}

/**
 * Parse a stored snapshot back. Returns null rather than a half-populated object:
 * a snapshot that cannot be trusted must not become the `previous` side of a
 * comparison, because that silently converts "unknown" into "unchanged".
 */
export function snapshotFromStorage(text: string): ScopeSnapshot | null {
  if (typeof text !== 'string' || !text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.program_id !== 'string' || !o.program_id) return null;
  if (typeof o.fetched_at !== 'number' || !Number.isFinite(o.fetched_at)) return null;
  if (typeof o.sha256 !== 'string') return null;
  if (!Array.isArray(o.assets)) return null;

  const assets: ScopedAsset[] = [];
  for (const entry of o.assets) {
    if (!entry || typeof entry !== 'object') return null;
    const a = entry as Record<string, unknown>;
    if (typeof a.kind !== 'string' || !a.kind) return null;
    if (typeof a.value !== 'string' || !a.value) return null;
    assets.push({ kind: a.kind, value: a.value });
  }

  return {
    program_id: o.program_id,
    fetched_at: o.fetched_at,
    sha256: o.sha256,
    parsed: o.parsed === true,
    assets,
    ...(Array.isArray(o.parse_warnings)
      ? { parse_warnings: o.parse_warnings.filter((w): w is string => typeof w === 'string') }
      : {}),
  };
}
