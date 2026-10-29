/**
 * Ledger — hash-chained, append-only. D1 port of asterion/ledger.py.
 *
 * Every authorized action, its evidence digest and its outcome land here.
 * The chain makes retroactive edits detectable, which is what makes the
 * export defensible to a client, a platform mediator, or a court.
 */

export interface Env {
  DB: D1Database;
}

export interface LedgerEntry {
  seq: number;
  ts: number;
  kind: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export const GENESIS = '0'.repeat(64);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonical(seq: number, ts: number, kind: string, payload: unknown): string {
  // Stable key order; the Python reference uses sort_keys=True with no spaces.
  return JSON.stringify({ seq, ts, kind, payload }, Object.keys({ seq, ts, kind, payload }).sort()) as string;
}

export async function append(env: Env, kind: string, payload: unknown): Promise<LedgerEntry> {
  const row = await env.DB.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1').first<{
    seq: number;
    hash: string;
  }>();
  const seq = row ? row.seq + 1 : 1;
  const prev = row ? row.hash : GENESIS;
  const ts = Math.floor(Date.now() / 1000);
  const body = stableStringify({ seq, ts, kind, payload });
  const hash = await sha256Hex(prev + body);

  await env.DB.prepare(
    'INSERT INTO ledger (seq, ts, kind, payload, prev_hash, hash) VALUES (?,?,?,?,?,?)',
  )
    .bind(seq, ts, kind, stableStringify(payload), prev, hash)
    .run();

  return { seq, ts, kind, payload, prev_hash: prev, hash };
}

/** Deterministic JSON with sorted keys, matching the Python canonical form. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export async function verify(env: Env): Promise<{ ok: boolean; detail: string }> {
  const rows = await env.DB.prepare(
    'SELECT seq, ts, kind, payload, prev_hash, hash FROM ledger ORDER BY seq ASC',
  ).all<LedgerEntry & { payload: string }>();

  let prev = GENESIS;
  let expected = 1;
  for (const e of rows.results ?? []) {
    if (e.seq !== expected) return { ok: false, detail: `sequence gap at ${expected}, found ${e.seq}` };
    if (e.prev_hash !== prev) return { ok: false, detail: `broken link at seq ${e.seq}` };
    const body = stableStringify({ seq: e.seq, ts: e.ts, kind: e.kind, payload: JSON.parse(e.payload) });
    if ((await sha256Hex(prev + body)) !== e.hash) {
      return { ok: false, detail: `hash mismatch at seq ${e.seq}` };
    }
    prev = e.hash;
    expected++;
  }
  return { ok: true, detail: `intact (${expected - 1} entries)` };
}

export async function head(env: Env): Promise<string> {
  const row = await env.DB.prepare('SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1').first<{
    hash: string;
  }>();
  return row?.hash ?? GENESIS;
}

void canonical;
