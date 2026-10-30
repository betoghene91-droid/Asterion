/**
 * Ledger export — one engagement, with its audit trail, as JSON a report can
 * travel with.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A report that arrives without its provenance is a claim. The whole design of
 * this system is that a claim can be checked: the ledger is hash-chained and
 * append-only, so "who authorized what, and when" is answerable after the fact.
 * But that answer lives in D1, behind a Worker, reachable only by an operator.
 * A triager, a client's lawyer, or a mediator cannot read it. So the export
 * packages exactly one engagement — its actions, its approvals, its proofs, its
 * verdicts — into a single self-describing document.
 *
 * ── Deterministic key order, and why it is load-bearing ────────────────────
 *
 * `ledger.ts` canonicalises entries with sorted keys so that the same logical
 * entry always hashes to the same value. An export that serialised the same
 * facts in a different order each time would break the one property that makes
 * the export worth anything: two people holding the same engagement can compare
 * digests. So this module sorts object keys recursively (via `stableStringify`
 * imported from ledger.ts, the same function the chain uses) and never emits a
 * value whose ordering depends on map iteration, clock, or randomness.
 *
 * Consequences that are deliberate, not accidental:
 *
 *   - Arrays keep the order they were given. An action SEQUENCE is ordered data;
 *     sorting it would destroy meaning. Only object keys are canonicalised.
 *   - `exported_at` is opt-in. A default of `Date.now()` would make every export
 *     of the same engagement differ, which defeats digest comparison. The caller
 *     passes a timestamp when it wants one recorded, and the document says
 *     plainly when it did not.
 *   - Verification is reported, never assumed. If the chain is broken, the
 *     export still happens — hiding a broken chain would defeat the purpose —
 *     but `integrity.ok` is false and the reason is included.
 */

import { stableStringify, GENESIS } from './ledger.js';

// ── Input shapes: the D1 rows this export is built from ─────────────────────

/** A row of `ledger` (schema.sql). `payload` is TEXT holding canonical JSON. */
export interface LedgerRow {
  seq: number;
  ts: number;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

/** A row of `approvals` (schema.sql). */
export interface ApprovalRow {
  id: string;
  fingerprint: string;
  /** TEXT holding JSON: `{ kind, brief }` for engagement approvals. */
  action: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  requested_at: number;
  decided_at: number | null;
  operator: string | null;
}

/** A row of `proofs` (schema.sql). */
export interface ProofRow {
  id: string;
  hunt_id: string;
  playbook: string;
  test_name: string;
  file: string | null;
  line: number | null;
  verdict: 'proven' | 'partial' | 'disproved' | 'inconclusive';
  confidence: 'confirmed' | 'firm' | 'tentative';
  claim: string | null;
  /** TEXT holding a JSON array of reason strings. */
  reasons: string;
  artifact: string | null;
  created_at: number;
}

/** A row of `hunts` (schema.sql) — the plan/verdict container. */
export interface HuntRow {
  id: string;
  program_id: string | null;
  engagement_id: string | null;
  repo: string | null;
  commit_sha: string | null;
  contract: string | null;
  fork_block: number | null;
  stage: string;
  leads_n: number;
  attempts_n: number;
  proven_n: number;
  stopped_because: string | null;
  created_at: number;
  updated_at: number;
}

/** A row of `engagements` (schema.sql). */
export interface EngagementRow {
  id: string;
  program_id: string;
  title: string;
  /** TEXT holding the brief JSON produced by the intake wizard. */
  brief: string;
  authorization_ref: string;
  window_start: number;
  window_end: number;
  time_box_minutes: number;
  max_mutability: string;
  status: string;
  created_at: number;
  closed_at: number | null;
  spend_cents: number;
}

/** A row of `findings` (schema.sql), limited to this engagement. */
export interface FindingRow {
  id: string;
  engagement_id: string | null;
  program_id: string | null;
  asset_id: string | null;
  title: string;
  cls: string;
  severity: string;
  confidence: string;
  proof_state: string;
  status: string;
  dedupe_key: string;
  summary: string | null;
  impact: string | null;
  remediation: string | null;
  /** TEXT holding a JSON array of reproduction steps. */
  repro: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Everything the exporter reads.
 *
 * All of it is opt-in by the caller EXCEPT `engagement` and `ledger` — an export
 * with no engagement has no subject, and one with no ledger has no trail. Empty
 * arrays are meaningful and are preserved: "this engagement has no approvals" is
 * a fact, and it is different from "the caller did not look".
 */
export interface ExportInput {
  engagement: EngagementRow;
  /** Already filtered to this engagement by the caller (see `ledgerForHunt`). */
  ledger: readonly LedgerRow[];
  hunts?: readonly HuntRow[];
  approvals?: readonly ApprovalRow[];
  proofs?: readonly ProofRow[];
  findings?: readonly FindingRow[];
  /**
   * Unix seconds, recorded in the document. Omit for a byte-reproducible export
   * of the same engagement.
   */
  exported_at?: number;
  /** Free-text note about why this export was produced, e.g. "submitted with report". */
  purpose?: string;
  /** Overrides the reported chain-verification result. Tests use this. */
  integrity?: { ok: boolean; detail: string };
}

export interface ExportCounts {
  ledger: number;
  hunts: number;
  approvals: number;
  proofs: number;
  findings: number;
  /** Counts by verdict, so a reader can see the shape without scanning rows. */
  proofs_by_verdict: Record<string, number>;
  approvals_by_status: Record<string, number>;
}

export interface EngagementExport {
  /** Format identifier + version. A consumer must refuse an unknown version. */
  format: 'asterion.engagement-export';
  version: 2;
  engagement: {
    id: string;
    program_id: string;
    title: string;
    authorization_ref: string;
    window_start: number;
    window_end: number;
    time_box_minutes: number;
    max_mutability: string;
    status: string;
    created_at: number;
    closed_at: number | null;
    spend_cents: number;
    /** Parsed brief, or the raw string when it is not valid JSON. */
    brief: unknown;
    brief_error?: string;
  };
  /** Chain verification as observed, plus the head hash a verifier can compare. */
  integrity: {
    ok: boolean;
    detail: string;
    genesis: string;
    head_hash: string | null;
    entries: number;
  };
  hunts: HuntRow[];
  approvals: (Omit<ApprovalRow, 'action'> & { action: unknown; action_error?: string })[];
  proofs: (Omit<ProofRow, 'reasons'> & { reasons: unknown; reasons_error?: string })[];
  findings: (Omit<FindingRow, 'repro'> & { repro: unknown; repro_error?: string })[];
  /** The chain itself, in sequence order. Keys canonical, payload parsed. */
  ledger: { seq: number; ts: number; kind: string; payload: unknown; prev_hash: string; hash: string }[];
  counts: ExportCounts;
  /** Absent when the caller recorded no export time, rather than defaulted. */
  exported_at?: number;
  purpose?: string;
  /** The exact call a verifier can make. Stated so the document is actionable. */
  verify_hint: string;
}

export interface ExportError {
  ok: false;
  reason: string;
  missing: string[];
}

export type ExportResult = { ok: true; document: EngagementExport; json: string } | ExportError;

// ── Parsing helpers ─────────────────────────────────────────────────────────

/**
 * Parse a JSON text column, reporting the failure instead of throwing.
 *
 * `null` in the DB is a legitimate empty value and becomes `null`. A malformed
 * string is NOT silently turned into `null` — that would erase the difference
 * between "no brief" and "an unreadable brief", and this document exists to
 * preserve exactly that kind of difference.
 */
export function parseJsonColumn(text: string | null | undefined): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text === null || text === undefined || text === '') return { ok: true, value: null };
  if (typeof text !== 'string') return { ok: false, error: `column is ${typeof text}, not text` };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Verify a chain in memory, without D1.
 *
 * Mirrors `verify()` in ledger.ts, but async-free except for the digest: it
 * takes a hash function so this module stays testable without WebCrypto and so
 * the export can be produced wherever the rows already are.
 *
 * The digest is required, not optional: an "integrity: ok" that was never
 * computed is worse than no integrity field at all.
 */
export function verifyChain(
  rows: readonly LedgerRow[],
  sha256Hex: (s: string) => Promise<string>,
): Promise<{ ok: boolean; detail: string }> {
  return (async () => {
    let prev = GENESIS;
    let expected = 1;
    for (const row of rows) {
      if (!row) return { ok: false, detail: `malformed row at position ${expected}` };
      if (row.seq !== expected) {
        return { ok: false, detail: `sequence gap: expected ${expected}, found ${row.seq}` };
      }
      if (row.prev_hash !== prev) return { ok: false, detail: `broken link at seq ${row.seq}` };
      const parsed = parseJsonColumn(row.payload);
      if (!parsed.ok) return { ok: false, detail: `unreadable payload at seq ${row.seq}: ${parsed.error}` };
      const body = stableStringify({ seq: row.seq, ts: row.ts, kind: row.kind, payload: parsed.value });
      if ((await sha256Hex(prev + body)) !== row.hash) {
        return { ok: false, detail: `hash mismatch at seq ${row.seq}` };
      }
      prev = row.hash;
      expected += 1;
    }
    return { ok: true, detail: `intact (${expected - 1} entries)` };
  })();
}

// ── The exporter ────────────────────────────────────────────────────────────

/**
 * Build the export.
 *
 * Order of `ledger` output is by `seq` ascending, always — the chain is only
 * meaningful in sequence, so this is the one ordering the exporter imposes on
 * the caller's data.
 */
export async function exportEngagement(
  input: ExportInput,
  sha256Hex: (s: string) => Promise<string>,
): Promise<ExportResult> {
  const missing: string[] = [];
  if (!input || !input.engagement) missing.push('engagement');
  if (!input || !Array.isArray(input.ledger)) missing.push('ledger');
  if (missing.length > 0) {
    return { ok: false, reason: `cannot export without ${missing.join(' and ')}`, missing };
  }
  if (typeof sha256Hex !== 'function') {
    return { ok: false, reason: 'a sha256 implementation is required to state chain integrity', missing: ['sha256Hex'] };
  }

  const engagement = input.engagement;
  const engMissing: string[] = [];
  if (!engagement.id) engMissing.push('engagement.id');
  if (!engagement.program_id) engMissing.push('engagement.program_id');
  if (engMissing.length > 0) {
    return { ok: false, reason: 'the engagement row is incomplete', missing: engMissing };
  }

  const ledgerRows = [...input.ledger].sort((a, b) => a.seq - b.seq);

  // Parse, preserving a parse failure as a visible error beside the field.
  const brief = parseJsonColumn(engagement.brief);

  const integrity = input.integrity ?? (await verifyChain(ledgerRows, sha256Hex));

  const ledger = ledgerRows.map((row) => {
    const parsed = parseJsonColumn(row.payload);
    return {
      seq: row.seq,
      ts: row.ts,
      kind: row.kind,
      // An unparsable payload still appears, as its raw text, so the entry is
      // never silently dropped from the trail.
      payload: parsed.ok ? parsed.value : { unparsed: row.payload },
      prev_hash: row.prev_hash,
      hash: row.hash,
    };
  });

  const approvals = (input.approvals ?? []).map((a) => {
    const parsed = parseJsonColumn(a.action);
    const base = { ...a } as Record<string, unknown>;
    delete base.action;
    return parsed.ok
      ? ({ ...(base as unknown as Omit<ApprovalRow, 'action'>), action: parsed.value } as never)
      : ({ ...(base as unknown as Omit<ApprovalRow, 'action'>), action: null, action_error: parsed.error } as never);
  });

  const proofs = (input.proofs ?? []).map((p) => {
    const parsed = parseJsonColumn(p.reasons);
    const base = { ...p } as Record<string, unknown>;
    delete base.reasons;
    return parsed.ok
      ? ({ ...(base as unknown as Omit<ProofRow, 'reasons'>), reasons: parsed.value } as never)
      : ({ ...(base as unknown as Omit<ProofRow, 'reasons'>), reasons: null, reasons_error: parsed.error } as never);
  });

  const findings = (input.findings ?? []).map((f) => {
    const parsed = parseJsonColumn(f.repro);
    const base = { ...f } as Record<string, unknown>;
    delete base.repro;
    return parsed.ok
      ? ({ ...(base as unknown as Omit<FindingRow, 'repro'>), repro: parsed.value } as never)
      : ({ ...(base as unknown as Omit<FindingRow, 'repro'>), repro: null, repro_error: parsed.error } as never);
  });

  const counts = countOf({
    ledger: ledger.length,
    hunts: (input.hunts ?? []).length,
    approvals: approvals.length,
    proofs: proofs.length,
    findings: findings.length,
    proofs_by_verdict: tally((input.proofs ?? []).map((p) => p.verdict)),
    approvals_by_status: tally((input.approvals ?? []).map((a) => a.status)),
  });

  const document: EngagementExport = {
    format: 'asterion.engagement-export',
    version: 2,
    engagement: {
      id: engagement.id,
      program_id: engagement.program_id,
      title: engagement.title,
      authorization_ref: engagement.authorization_ref,
      window_start: engagement.window_start,
      window_end: engagement.window_end,
      time_box_minutes: engagement.time_box_minutes,
      max_mutability: engagement.max_mutability,
      status: engagement.status,
      created_at: engagement.created_at,
      closed_at: engagement.closed_at ?? null,
      spend_cents: engagement.spend_cents,
      brief: brief.ok ? brief.value : null,
      ...(brief.ok ? {} : { brief_error: brief.error }),
    },
    integrity: {
      ok: integrity.ok,
      detail: integrity.detail,
      genesis: GENESIS,
      head_hash: ledgerRows.length ? (ledgerRows[ledgerRows.length - 1]?.hash ?? null) : null,
      entries: ledgerRows.length,
    },
    hunts: [...(input.hunts ?? [])],
    approvals: approvals as EngagementExport['approvals'],
    proofs: proofs as EngagementExport['proofs'],
    findings: findings as EngagementExport['findings'],
    ledger,
    counts,
    ...(typeof input.exported_at === 'number' ? { exported_at: input.exported_at } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    verify_hint:
      'Re-hash each ledger entry as sha256(prev_hash + stableStringify({seq,ts,kind,payload})) ' +
      'with keys sorted and no spaces, starting from prev_hash = "0"*64, and compare each result ' +
      'to that entry\'s hash. Any mismatch means the trail was edited after the fact.',
  };

  // Canonical JSON: sorted keys at every level, no indentation drift, and a
  // trailing newline so `diff` and `sha256sum` behave. Two exports of the same
  // engagement with the same `exported_at` are byte-identical.
  const json = stableStringify(document) + '\n';

  return { ok: true, document, json };
}

/**
 * A pretty form for humans, with keys canonicalised.
 *
 * Indented output cannot be compared byte-for-byte against a differently
 * produced export the way the canonical single-line form can, which is why the
 * canonical form is what `exportEngagement` returns and this is a separate,
 * explicitly-named function.
 */
export function prettyJson(doc: EngagementExport): string {
  // Re-serialise through the canonical form so key order is stable even here.
  return JSON.stringify(JSON.parse(stableStringify(doc)), null, 2) + '\n';
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    if (typeof v !== 'string') continue;
    out[v] = (out[v] ?? 0) + 1;
  }
  // Sorted keys so the count block is canonical too.
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k] as number;
  return sorted;
}

function countOf(c: ExportCounts): ExportCounts {
  return {
    ledger: c.ledger,
    hunts: c.hunts,
    approvals: c.approvals,
    proofs: c.proofs,
    findings: c.findings,
    proofs_by_verdict: c.proofs_by_verdict,
    approvals_by_status: c.approvals_by_status,
  };
}

/**
 * Select the ledger entries that belong to one engagement.
 *
 * The `ledger` table has no `engagement_id` column — it is a flat hash chain,
 * and that is deliberate: an entry cannot be re-parented without breaking the
 * chain. So belonging is a property of the PAYLOAD, and this function is the one
 * place that decides it, so the rule is auditable rather than repeated in every
 * caller.
 *
 * An entry belongs when, anywhere in its payload (at any depth), some string
 * equals `engagementId`, or some hunt id listed in `huntIds` appears. Depth is
 * bounded to keep a pathological payload from being walked forever.
 */
export function ledgerForEngagement(
  rows: readonly LedgerRow[],
  engagementId: string,
  huntIds: readonly string[] = [],
): LedgerRow[] {
  if (!engagementId) return [];
  const wanted = new Set<string>([engagementId, ...huntIds.filter((h) => typeof h === 'string' && h)]);
  return rows.filter((row) => payloadMentions(row.payload, wanted, 6));
}

function payloadMentions(payload: string, wanted: Set<string>, depth: number): boolean {
  if (depth < 0) return false;
  const parsed = parseJsonColumn(payload);
  if (!parsed.ok) {
    // An unparsable payload can still be attributed by raw substring, which is
    // conservative: it can only ever include MORE entries in the trail.
    for (const w of wanted) if (payload.includes(w)) return true;
    return false;
  }
  return valueMentions(parsed.value, wanted, depth);
}

function valueMentions(value: unknown, wanted: Set<string>, depth: number): boolean {
  if (depth < 0) return false;
  if (typeof value === 'string') return wanted.has(value);
  if (Array.isArray(value)) return value.some((v) => valueMentions(v, wanted, depth - 1));
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (valueMentions(v, wanted, depth - 1)) return true;
    }
  }
  return false;
}
