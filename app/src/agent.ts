/**
 * The conversational layer — the operator types a sentence, the bot does the work.
 *
 * WHY THIS FILE EXISTS
 *
 * Every surface in this Worker is a fixed command or a fixed button. `/desk` is
 * `deskCard`, `/status` is `buildStatus`, `m:main` is `homeScreen`. That is fine
 * for the questions we thought of and useless for the ones we did not: "how are
 * the bots doing" has no command, "is the hunter stuck" has no button, and "what
 * did we close today" has no card at all. So this module adds ONE thing on top of
 * the existing surfaces: a model that chooses which of the EXISTING readers to
 * call, and then says what the readings say.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 *   · Not a second LLM client. `src/llm.ts` already routes local -> Venice ->
 *     gemini -> groq -> openrouter -> Workers AI and already logs every call to
 *     `llm_log` and spends against `quota`. Reimplementing that would mean a
 *     second place where "Venice is tried first" can be silently false, so this
 *     file calls `ask()` and nothing else.
 *   · Not a second query layer. Every tool below calls a function that was
 *     already exported for `/api/desk/*` and the Telegram cards —
 *     `assessJobs`/`renderDeadmanAlert` from `deadman.ts`, `hunterStatus`/
 *     `hunterFindings`/`renderHunter`, `token2022Status`/`token2022Findings`/
 *     `renderToken2022`, `dustStatus`/`renderDust`, `sweepStatus`, `deskCard`,
 *     and `ledger.ts`. Where a raw `SELECT` does appear (heartbeats, ledger) it is
 *     because the module that owns the table exports the DECISION and not a
 *     reader — `deadman.ts` is deliberately pure and its heartbeat read lives
 *     inline in `index.ts`, and `ledger.ts` exposes `append`/`verify`/`head` but
 *     no list. Both cases are commented at the call site.
 *   · Not an actor. Every tool is read-only except `token2022_scan`, which is the
 *     one thing the operator explicitly asks for ("scan these mints") and which
 *     costs only subrequests. Nothing here can open a position, close an account
 *     or send a transaction, so a misheard sentence cannot spend money.
 *
 * THE PROTOCOL, AND WHY IT IS TEXT RATHER THAN NATIVE TOOL CALLING
 *
 * `ask()` returns `text`, not OpenAI `tool_calls`, and it is the one function that
 * knows about every provider. Rather than widen `llm.ts` (out of scope for this
 * change) the model is asked for exactly one JSON object per turn:
 *
 *     {"tool": "hunter", "args": {}}        -> call a tool, get the reading back
 *     {"answer": "the hunter has not beaten"}  -> finished, here is the reply
 *
 * `parseJson()` from `llm.ts` already tolerates fences and chatter, so this works
 * identically on Venice, Gemini, Groq, OpenRouter and Workers AI. The cost is one
 * extra round-trip per tool; the benefit is that provider routing stays in one
 * place.
 *
 * THE HONESTY RULE, WHICH IS THE POINT OF THE WHOLE FILE
 *
 * Three invariants, each of which has been a real bug elsewhere in this codebase:
 *
 *   1. **A number in the reply came from a tool.** `ungroundedNumbers()` checks
 *      every numeral in the model's prose against the concatenated tool output
 *      (and against the operator's own words, so echoing "top 5" is allowed). A
 *      reply that fails the check is NOT shipped: the deterministic readings are
 *      shipped instead, with a line saying why. A model that invents "3 stuck
 *      jobs" is exactly as dangerous as a bot that reports a clean zero.
 *   2. **A failed tool is not a zero.** When a tool throws, the model is told
 *      "TOOL FAILED ... this reading is UNKNOWN, not zero", so the reply can say
 *      "I could not read the hunter" instead of "the hunter found nothing".
 *   3. **No model means no prose, not no answer.** If `ask()` raises
 *      `LlmUnavailable` (budget spent, no keys) the operator still gets every
 *      reading, labelled as raw readings with the question unanswered.
 */

import {
  ask as llmAsk,
  LlmUnavailable,
  parseJson,
  type AskOpts,
  type AskResult,
  type Env as LlmEnv,
  type Msg,
} from './llm.js';
import {
  assessJobs,
  humanDuration,
  renderDeadmanAlert,
  SCHEDULED_JOBS,
  type JobHealth,
} from './deadman.js';
import { hunterFindings, hunterStatus, renderHunter } from './desk/hunter.js';
import {
  renderToken2022,
  runToken2022Bot,
  token2022Findings,
  token2022Status,
} from './desk/token2022.js';
import { dustStatus, renderDust } from './desk/dust.js';
import { sweepStatus, SWEEP_DEST } from './desk/sweep.js';
import { deskCard } from './desk/cards.js';
import { head as ledgerHead, verify as ledgerVerify } from './ledger.js';
import type { DeskEnv } from './desk/types.js';

/**
 * Everything this layer touches.
 *
 * `LlmEnv` supplies the provider routing and `DeskEnv` the desk readers; the two
 * overlap only on `DB` and `DAILY_LLM_BUDGET`, which have identical types, so the
 * intersection is legal and a caller can pass the Worker's own `Env` unchanged.
 */
export interface AgentEnv extends LlmEnv, DeskEnv {
  OPERATOR_NAME?: string;
  TELEGRAM_CHAT_ID?: string;
}

/** Hard stop on tool rounds. A model that loops must not loop on the operator's dime. */
export const MAX_ITERATIONS = 6;

/**
 * Telegram rejects a message over 4096 characters, and the 4096 counts UTF-16
 * code units including the HTML tags `send()` sends with `parse_mode`. 3800
 * leaves room for the tags and for the truncation notice.
 */
export const MAX_REPLY_CHARS = 3800;

/** One tool's output is fed back to the model; this bounds a pathological render. */
export const MAX_TOOL_CHARS = 2600;

/** How many mints one `token2022_scan` may ask for. One subrequest per mint. */
export const MAX_SCAN_MINTS = 10;

/** Provider call shape, injectable so a test can stub the model without a socket. */
export type AskFn = (env: LlmEnv, msgs: Msg[], opts: AskOpts) => Promise<AskResult>;

// ─────────────────────────────────────────────────────────────────────────────
// the tool registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One callable reading.
 *
 * `args` is written for the model, not for TypeScript: it is the exact JSON
 * object the tool will accept, so the prompt can be generated from this list and
 * cannot drift from the handlers.
 */
export interface AgentToolSpec {
  readonly name: string;
  readonly summary: string;
  readonly args: string;
  /** True when the tool does work rather than only reading. Shown to the model. */
  readonly mutating: boolean;
}

export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  {
    name: 'jobs',
    summary:
      'Dead-man health: which scheduled jobs (sentinel, crawler, sweep_bot, dust_bot, hunter_bot, token2022_bot, briefing, …) are beating inside their own cadence window and which are silent.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'hunter',
    summary:
      'Protocol hunter: last reading — programs/mints checked, findings, and anything the RPC could not answer for. Reports "nothing looked at" when there were no inputs.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'token2022',
    summary:
      'Token-2022 extension scanner: last reading — mints read, extensions decoded, high/medium findings, inert hooks, unreadable and skipped mints.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'token2022_scan',
    summary:
      'Scan specific Token-2022 mints NOW (one RPC read per mint, spends subrequests). Use only when the operator names mints to scan.',
    args: '{"mints": ["<base58 mint>", "…"]}',
    mutating: true,
  },
  {
    name: 'dust',
    summary:
      'Dust/rent bot: wallets scanned, token accounts seen, closable empty accounts, rent recoverable, accounts still holding tokens.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'sweep',
    summary:
      'Sweep bot: candidates checked, spendable accounts ever found, SOL swept, cursor position, destination address.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'desk',
    summary:
      'Paper desk: mode, realized equity, deployed %, open positions, today PnL, breaker state, kills today, coverage gaps, arming gates.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'ledger',
    summary:
      'Hash-chained ledger: per-kind counts and the newest entries in a time window (desk.exit is a close, dust.reclaim is a rent reclaim).',
    args: '{"hours": 24, "limit": 10, "kinds": ["desk.exit"], "verify": false}',
    mutating: false,
  },
];

const TOOL_NAMES = AGENT_TOOLS.map((t) => t.name).join(', ');

/**
 * The system prompt, generated from the registry so a new tool cannot be
 * documented in one place and missing from the other.
 *
 * It is written as constraints rather than personality on purpose: the failure
 * mode being defended against is a fluent sentence with a made-up number in it.
 */
export function agentSystemPrompt(): string {
  const tools = AGENT_TOOLS.map(
    (t) => `  · ${t.name}(${t.args})${t.mutating ? '  [does work]' : ''}\n      ${t.summary}`,
  ).join('\n');

  return [
    'You are Asterion, the operator console for a Solana trading-and-security bot fleet.',
    'The operator writes in plain language. Answer them, using the tools to get real numbers.',
    '',
    'TOOLS',
    tools,
    '',
    'REPLY PROTOCOL — exactly one JSON object, no prose around it, no code fence:',
    '  to call a tool:   {"tool": "<name>", "args": {…}}',
    '  to answer:        {"answer": "<what you tell the operator>"}',
    '',
    'RULES, in order of importance:',
    '  1. Every number you write must have come from a tool result in this conversation.',
    '     If you have not read it, call the tool. Never estimate, never round a guess,',
    '     never carry a number over from an earlier unrelated question.',
    '  2. A tool that failed tells you NOTHING. Say "could not read X", never "X is zero".',
    '  3. Zero is a real answer only when a tool returned zero AND it also said what it',
    '     looked at. "Nothing looked at" is not "nothing wrong" — say which one it was.',
    '  4. If the tools cannot answer the question, say so in one sentence and stop.',
    '  5. Read-only unless asked. Call token2022_scan only when the operator names mints.',
    '  6. Be terse. The operator is on a phone: short lines, no filler, no restating the',
    '     question. Plain text or minimal HTML (<b>, <code>); no markdown tables.',
    '',
    `Available tools: ${TOOL_NAMES}.`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// argument coercion
//
// The model sends JSON it chose, so every argument is validated here. A wrong
// type is a TOOL FAILURE ("bad argument mints: expected an array"), which the
// model can see and correct, rather than an exception that kills the turn.
// ─────────────────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;

function argString(args: Args, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`argument "${key}" must be a string`);
  const t = v.trim();
  return t === '' ? null : t;
}

function argNumber(args: Args, key: string, min: number, max: number): number | null {
  const v = args[key];
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`argument "${key}" must be a number`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function argBoolean(args: Args, key: string): boolean {
  const v = args[key];
  if (v === undefined || v === null) return false;
  // Models emit the string form often enough that accepting it is not laxness.
  return v === true || v === 'true' || v === 1 || v === '1';
}

function argStringList(args: Args, key: string): string[] | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  const raw = typeof v === 'string' ? v.split(/[\s,]+/) : v;
  if (!Array.isArray(raw)) throw new Error(`argument "${key}" must be an array of strings`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`argument "${key}" must be an array of strings`);
    const t = item.trim();
    if (t) out.push(t);
  }
  return out.length ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// reading helpers the owning modules do not export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Newest successful heartbeat per source, plus the age of the observation.
 *
 * `deadman.ts` is pure by design — `assessJobs()` takes `lastTs`/`observedSince`
 * as input and never touches D1 — and the one place that builds those inputs is
 * inline in `index.ts:runDeadman`. That read is not exported, so it is repeated
 * here with the SAME semantics (max per source; oldest row as `observedSince`)
 * because the alternative is feeding `assessJobs` different inputs than the real
 * switch does, which would let the bot and the alert disagree about the same
 * facts. `[NEEDS_DEDUPE]` for whoever wires this: extracting that read from
 * `index.ts` into `deadman.ts` would remove the copy.
 */
async function readHeartbeats(
  env: AgentEnv,
): Promise<{ lastTs: Record<string, number | null>; observedSince: number | null }> {
  const rows = await env.DB.prepare('SELECT source, ts FROM heartbeats').all<{
    source: string;
    ts: number;
  }>();
  const lastTs: Record<string, number | null> = {};
  let observedSince: number | null = null;
  for (const r of rows.results ?? []) {
    if (typeof r.source !== 'string' || typeof r.ts !== 'number' || !Number.isFinite(r.ts)) continue;
    const prev = lastTs[r.source];
    lastTs[r.source] = prev === null || prev === undefined ? r.ts : Math.max(prev, r.ts);
    if (observedSince === null || r.ts < observedSince) observedSince = r.ts;
  }
  return { lastTs, observedSince };
}

/** Seconds between a stored millisecond timestamp and now; null when never ran. */
function ageSeconds(nowMs: number, thenMs: number): number | null {
  if (!Number.isFinite(thenMs) || thenMs <= 0) return null;
  return Math.max(0, Math.round((nowMs - thenMs) / 1000));
}

function agoText(nowMs: number, thenMs: number): string {
  const age = ageSeconds(nowMs, thenMs);
  if (age === null) return 'never';
  return `${humanDuration(age)} ago`;
}

function iso(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function clip(s: string, max = MAX_TOOL_CHARS): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n  … [clipped ${t.length - max} chars]`;
}

/** A compact one-line view of a ledger payload, for the entry list. */
function payloadBrief(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  // `unknown`, spelled out: after the null check TypeScript narrows `payload` to
  // `{}` and would then reject the parsed value coming back.
  let v: unknown = payload;
  if (typeof payload === 'string') {
    try {
      v = JSON.parse(payload) as unknown;
    } catch {
      return payload.slice(0, 120);
    }
  }
  if (v === null || typeof v !== 'object') return String(v).slice(0, 120);
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    const val = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    parts.push(`${k}=${val.length > 42 ? val.slice(0, 42) + '…' : val}`);
    if (parts.length >= 6) break;
  }
  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// the tools
//
// Each handler returns the text the model will see. They are written to be
// readable by a model AND checkable by a human, which is why every line names
// what it counted.
// ─────────────────────────────────────────────────────────────────────────────

interface ToolCtx {
  /** Milliseconds. Passed in so a test can freeze the clock. */
  now: number;
}

async function toolJobs(env: AgentEnv, _args: Args, ctx: ToolCtx): Promise<string> {
  const { lastTs, observedSince } = await readHeartbeats(env);
  const health = assessJobs({ now: Math.floor(ctx.now / 1000), lastTs, observedSince });

  // The alert is the operator-facing artifact and it already gets the wording
  // right (last ok / first gone / also gone), so it is reused verbatim when it
  // fires rather than re-phrased here.
  const alert = renderDeadmanAlert(health);
  if (alert) {
    const silent = health.filter((h) => h.state === 'silent').map((h) => h.name);
    return clip(`${alert}\n\nsilent: ${silent.join(', ')}`);
  }

  const cold = health.filter((h) => h.state === 'cold_start');
  const lines = [
    `jobs: none silent (${health.length} watched, ${cold.length} cold start)`,
    '',
  ];
  for (const h of health) {
    lines.push(`  ${h.name.padEnd(16)} ${jobStateText(h, ctx.now)}`);
  }
  if (cold.length > 0) {
    lines.push('');
    lines.push(
      'cold start = no heartbeat yet and this deployment is younger than that job’s window;',
    );
    lines.push('that is "has not run yet", NOT "is dead" and NOT "is healthy".');
  }
  return clip(lines.join('\n'));
}

function jobStateText(h: JobHealth, nowMs: number): string {
  const window = `window ${humanDuration(h.window_seconds)}`;
  if (h.state === 'cold_start') return `cold_start      never ran         ${window}`;
  if (h.last_ts === null) return `silent          never ran         ${window}`;
  const seen = agoText(nowMs, h.last_ts * 1000);
  return `${h.state.padEnd(15)} ${seen.padEnd(17)} ${window}`;
}

async function toolHunter(env: AgentEnv, _args: Args, ctx: ToolCtx): Promise<string> {
  const stats = await hunterStatus(env);
  const findings = await hunterFindings(env);
  // `renderHunter` is the same text `/api/desk/hunter/run` returns, so the bot
  // and the dashboard cannot tell the operator different stories. The one thing
  // it does not print is WHEN, and "is it stuck" is mostly a when question — the
  // age comes from `stats.lastTickMs` and nowhere else.
  return clip(`${renderHunter(stats, findings)}\n  last tick  ${agoText(ctx.now, stats.lastTickMs)}`);
}

async function toolToken2022(env: AgentEnv, _args: Args, ctx: ToolCtx): Promise<string> {
  const stats = await token2022Status(env);
  const findings = await token2022Findings(env);
  return clip(
    `${renderToken2022(stats, findings)}\n  last tick  ${agoText(ctx.now, stats.lastTickMs)}`,
  );
}

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function toolToken2022Scan(env: AgentEnv, args: Args, ctx: ToolCtx): Promise<string> {
  const wanted = argStringList(args, 'mints');
  if (!wanted) throw new Error('argument "mints" is required: an array of base58 mint addresses');
  if (wanted.length > MAX_SCAN_MINTS) {
    throw new Error(`too many mints (${wanted.length}); at most ${MAX_SCAN_MINTS} per scan`);
  }
  const bad = wanted.filter((m) => !BASE58_PUBKEY.test(m));
  if (bad.length) throw new Error(`not base58 mint addresses: ${bad.join(', ')}`);

  // `runToken2022Bot` builds its input list as (desk universe) UNION
  // (DESK_TOKEN2022_MINTS) — that union is deliberate there ("a mint the scout
  // killed still has holders who can be frozen"). So the requested mints are
  // passed through that existing seed rather than through a new code path, and
  // the render states how many mints were read so the union is visible.
  //
  // Spreading `env` is safe: a Workers `env` is a plain object of bindings, and
  // this is the one-shot object handed to this call, never the live binding.
  const seeded: AgentEnv = { ...env, DESK_TOKEN2022_MINTS: wanted.join(',') };
  const stats = await runToken2022Bot(seeded, ctx.now);
  const findings = await token2022Findings(seeded);
  return clip(
    [
      `requested ${wanted.length} mint(s): ${wanted.join(', ')}`,
      'note: the scan also re-reads the desk universe, so mints read can exceed the request',
      '',
      renderToken2022(stats, findings),
    ].join('\n'),
  );
}

async function toolDust(env: AgentEnv, _args: Args, _ctx: ToolCtx): Promise<string> {
  const stats = await dustStatus(env);
  const lines = [renderDust(stats), `  ticks     ${stats.ticks}`];
  if (stats.reclaimed_lamports > 0) {
    lines.push(`  reclaimed ${(stats.reclaimed_lamports / 1e9).toFixed(9)} SOL actually closed`);
  }
  if (stats.detect_only) {
    // The field exists precisely to stop a silent no-op reading as a clean zero.
    lines.push('  detect_only YES — no operator key, so nothing was closed this tick');
  }
  return clip(lines.join('\n'));
}

/**
 * `sweepStatus()` — and NOT `renderSweep()`.
 *
 * `renderSweep(report, stats)` renders a PER-TICK report, and the only place a
 * report exists is inside the tick that produced it; nothing persists it (the
 * stats and the cursor are persisted, the report is not). Calling it from here
 * with an empty report would print "funded 0 this tick", which is a claim about a
 * tick that this call did not observe. So the status is rendered from the fields
 * `sweepStatus` actually returns, and every line names its field.
 */
async function toolSweep(env: AgentEnv, _args: Args, ctx: ToolCtx): Promise<string> {
  const s = await sweepStatus(env);
  const pct = s.space > 0 ? ((s.offset / s.space) * 100).toFixed(6) : '0';
  return clip(
    [
      'sweep bot',
      `  checked   ${s.checked.toLocaleString('en-US')} candidates lifetime`,
      `  hits      ${s.hits} spendable ever`,
      `  swept     ${(s.swept_lamports / 1e9).toFixed(9)} SOL`,
      `  cursor    ${s.offset.toLocaleString('en-US')} of ${s.space.toLocaleString('en-US')} (${pct}%)`,
      `  ticks     ${s.ticks}, last ${agoText(ctx.now, s.last_tick_ms)}`,
      `  dest      ${SWEEP_DEST}`,
    ].join('\n'),
  );
}

async function toolDesk(env: AgentEnv, _args: Args, ctx: ToolCtx): Promise<string> {
  // The card, not `deskStatus` directly: the card already explains each number
  // (equity is realized cash, a coverage gap means "not judged", the arming gates
  // are the reason live is impossible). Re-formatting it here would lose that.
  return clip(await deskCard(env, ctx.now));
}

async function toolLedger(env: AgentEnv, args: Args, ctx: ToolCtx): Promise<string> {
  const hours = argNumber(args, 'hours', 1, 24 * 30) ?? 24;
  const limit = argNumber(args, 'limit', 1, 25) ?? 10;
  const kinds = argStringList(args, 'kinds');
  const since = Math.floor((ctx.now - hours * 3_600_000) / 1000);

  const inKinds = kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
  const binds: unknown[] = kinds ? [since, ...kinds] : [since];

  // One grouped count, so "3 closes" is a count over the whole window rather than
  // over the rows the limit happened to return.
  const counts = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM ledger WHERE ts>=?${inKinds} GROUP BY kind ORDER BY n DESC`,
  )
    .bind(...binds)
    .all<{ kind: string; n: number }>();

  const rows = await env.DB.prepare(
    `SELECT seq, ts, kind, payload FROM ledger WHERE ts>=?${inKinds} ORDER BY seq DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<{ seq: number; ts: number; kind: string; payload: string }>();

  const head = await ledgerHead(env);
  const out: string[] = [
    `ledger: window last ${hours}h${kinds ? ` (kinds ${kinds.join(', ')})` : ''}`,
    `  head      ${head.slice(0, 16)}…`,
  ];

  const list = rows.results ?? [];
  if (list.length === 0) {
    // An honest zero: it says the query ran and over what window.
    out.push('  entries   NONE in this window');
  } else {
    const grouped = (counts.results ?? [])
      .map((c) => `${c.kind} ${c.n}`)
      .join(', ');
    out.push(`  counts    ${grouped || 'none'}`);
    out.push(`  newest    ${Math.min(limit, list.length)} of them:`);
    for (const r of list) {
      const brief = payloadBrief(r.payload);
      out.push(`    #${r.seq} ${iso(r.ts)} ${r.kind}${brief ? ` — ${brief}` : ''}`);
    }
  }

  if (argBoolean(args, 'verify')) {
    // Recomputes the whole chain. Cheap enough for a deliberate question, too
    // expensive to do on every turn, which is why it is behind a flag.
    const v = await ledgerVerify(env);
    out.push(`  chain     ${v.ok ? 'intact' : 'BROKEN'} — ${v.detail}`);
  }
  return clip(out.join('\n'));
}

type ToolHandler = (env: AgentEnv, args: Args, ctx: ToolCtx) => Promise<string>;

const HANDLERS: Record<string, ToolHandler> = {
  jobs: toolJobs,
  hunter: toolHunter,
  token2022: toolToken2022,
  token2022_scan: toolToken2022Scan,
  dust: toolDust,
  sweep: toolSweep,
  desk: toolDesk,
  ledger: toolLedger,
};

/**
 * Run one tool with a hard boundary.
 *
 * Never throws: a tool that fails is data the model needs ("I could not read it"),
 * and a single failed reading must not lose the rest of the turn.
 */
async function runTool(
  env: AgentEnv,
  name: string,
  args: Args,
  ctx: ToolCtx,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const handler = HANDLERS[name];
  if (!handler) return { ok: false, error: `unknown tool "${name}"; valid tools: ${TOOL_NAMES}` };
  try {
    const text = await handler(env, args, ctx);
    if (!text.trim()) return { ok: false, error: `tool "${name}" returned nothing` };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// number grounding
// ─────────────────────────────────────────────────────────────────────────────

const NUMERAL = /-?\d[\d,]*(?:\.\d+)?/g;

/**
 * Every numeral in a string, normalised.
 *
 * Two normalisations, both earned from a real false positive:
 *   · thousands separators — `6,117,840` and `6117840` are the same number, and a
 *     model copying the tool's own figure without the commas is not inventing it;
 *   · trailing zeros in a FRACTION — `renderDust` prints
 *     `(lamports/1e9).toFixed(9)`, i.e. `0.006117840`, and a model that says
 *     `0.00611784 SOL` has quoted the reading correctly. Comparing the strings
 *     literally refused that honest sentence, so decimals are compared by value.
 *     Integers are NOT re-parsed through Number(): that would turn an 18-digit
 *     lamport count into an exponent form and lose the digits that make it
 *     checkable.
 */
export function numeralsIn(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(NUMERAL)) {
    const raw = m[0].replace(/,/g, '').replace(/\.$/, '');
    if (raw === '' || raw === '-') continue;
    if (raw.includes('.')) {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        out.add(String(n));
        continue;
      }
    }
    out.add(raw);
  }
  return out;
}

/**
 * The numerals in `answer` that no tool produced.
 *
 * `allowed` is the concatenated tool output, plus the operator's own words — a
 * model that echoes "the top 5" has not invented 5, it has re-used the question.
 * Everything else must be traceable to a reading. Deliberately strict: a false
 * trip costs one ugly-but-true reply (the raw readings), while a missed trip
 * costs a confident sentence built on a number nobody measured.
 */
export function ungroundedNumbers(answer: string, allowed: string): string[] {
  const pool = numeralsIn(allowed);
  return [...numeralsIn(answer)].filter((n) => !pool.has(n));
}

// ─────────────────────────────────────────────────────────────────────────────
// the deterministic digest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the operator sees when the model cannot be trusted or reached: the actual
 * readings, in the order a person reads them, with the question explicitly NOT
 * answered. Never "something went wrong" — always the numbers.
 *
 * `token2022_scan` is excluded on purpose: the digest must be free of side
 * effects, and a degraded reply should not start spending subrequests.
 */
const DIGEST_TOOLS = ['jobs', 'hunter', 'token2022', 'dust', 'sweep', 'desk', 'ledger'] as const;

async function deterministicDigest(env: AgentEnv, ctx: ToolCtx): Promise<string[]> {
  const out: string[] = [];
  for (const name of DIGEST_TOOLS) {
    const r = await runTool(env, name, {}, ctx);
    out.push(r.ok ? r.text : `${name}: UNREADABLE — ${r.error}`);
  }
  return out;
}

function truncateForTelegram(s: string): string {
  if (s.length <= MAX_REPLY_CHARS) return s;
  const note = '\n… [truncated]';
  return s.slice(0, MAX_REPLY_CHARS - note.length) + note;
}

/**
 * The tags Telegram's HTML parse mode accepts from us. Deliberately the short
 * list this bot actually emits — `telegram.ts` (`rule`, `esc`, the cards) only
 * ever produces `<b>`, `<i>`, `<code>`.
 */
const ALLOWED_TAG = /^<\/?(b|i|code)>/;

/**
 * Escape the `<` in a MODEL's prose without touching the tags it was told it may
 * use.
 *
 * This exists because of the transport, not the model. `send()` posts with
 * `parse_mode: 'HTML'`, and Telegram does not degrade on a malformed entity — it
 * rejects the entire message with 400 "can't parse entities" and the operator gets
 * silence. A model writing `p99 < 500ms` or `a<b` would therefore swallow its own
 * reply, and the most likely cause (a bare `<`, not a wrong tag) is exactly the
 * case a blanket `esc()` would fix at the cost of printing `<b>` literally.
 *
 * The deterministic blocks are NOT passed through this: they come from the
 * existing renderers and cards, which already escape what they interpolate.
 */
export function safeModelHtml(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '<') {
      out += ch;
      continue;
    }
    if (ALLOWED_TAG.test(s.slice(i))) {
      out += ch;
    } else {
      out += '&lt;';
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// the loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the reply was produced. Not decoration: the parent can log these, and the
 * operator can tell "the model answered" from "the model was unavailable and you
 * are reading the raw status".
 */
export type AgentDegradation =
  | 'none'
  | 'llm_unavailable'
  | 'iteration_cap'
  | 'unparseable'
  | 'no_grounding'
  | 'all_tools_failed';

export interface AgentToolTrace {
  name: string;
  ok: boolean;
  /** True when the result came from this turn's cache rather than a fresh read. */
  cached: boolean;
  chars: number;
  error: string | null;
}

export interface AgentReply {
  /** What to send to Telegram. Never empty, never longer than MAX_REPLY_CHARS. */
  text: string;
  /** True only when a model answered from real readings with no degradation. */
  ok: boolean;
  provider: string | null;
  model: string | null;
  /** Model round-trips used (tool calls + the final answer turn). */
  iterations: number;
  toolCalls: AgentToolTrace[];
  degraded: AgentDegradation;
  /** The verbatim tool output, for a caller that wants to show or store it. */
  blocks: string[];
  /** The transcript so far, for the parent to persist as chat history. */
  history: Msg[];
}

export interface AgentOptions {
  /** Replace the model call. Hermetic tests pass a stub; production omits it. */
  ask?: AskFn;
  /** Clock override, milliseconds. */
  now?: number;
  /** Override the round limit (tests use 2 to reach the cap fast). */
  maxIterations?: number;
  /** Prior turns for continuity. Trimmed to the last MAX_HISTORY messages. */
  history?: readonly Msg[];
}

/** Older turns are dropped rather than paid for on every message. */
const MAX_HISTORY = 8;

function trimHistory(history: readonly Msg[] | undefined): Msg[] {
  if (!history || history.length === 0) return [];
  // Keep the tail, and never start on an assistant turn whose tool result was cut
  // off — a dangling tool call confuses every provider.
  const tail = history.slice(-MAX_HISTORY);
  const firstUser = tail.findIndex((m) => m.role === 'user');
  return firstUser > 0 ? tail.slice(firstUser) : tail;
}

/** One stable key for the per-turn tool cache, so identical calls are not re-read. */
function cacheKey(name: string, args: Args): string {
  const keys = Object.keys(args).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = args[k];
  return `${name}:${JSON.stringify(ordered)}`;
}

interface ModelToolCall {
  tool?: unknown;
  args?: unknown;
  answer?: unknown;
  done?: unknown;
}

/**
 * One operator sentence -> one reply.
 *
 * The loop is: ask the model, if it names a tool run it and hand back the reading,
 * repeat until it answers or the round limit is reached. Every exit path produces
 * text; there is no path that returns nothing.
 */
export async function runAgent(
  env: AgentEnv,
  question: string,
  opts: AgentOptions = {},
): Promise<AgentReply> {
  const askFn: AskFn = opts.ask ?? llmAsk;
  const ctx: ToolCtx = { now: opts.now ?? Date.now() };
  const maxIterations = Math.max(1, opts.maxIterations ?? MAX_ITERATIONS);

  const trimmedQuestion = question.trim();
  const baseHistory = trimHistory(opts.history);
  const msgs: Msg[] = [
    { role: 'system', content: agentSystemPrompt() },
    ...baseHistory,
    { role: 'user', content: trimmedQuestion },
  ];

  const traces: AgentToolTrace[] = [];
  const blocks: string[] = [];
  const cache = new Map<string, string>();
  let provider: string | null = null;
  let model: string | null = null;
  let iterations = 0;
  let parseFails = 0;

  /** Every degraded exit funnels through here, so the wording cannot drift. */
  const degrade = async (
    kind: AgentDegradation,
    why: string,
  ): Promise<AgentReply> => {
    const digest = await deterministicDigest(env, ctx);
    const failed = traces.filter((t) => !t.ok);
    const header = [
      kind === 'llm_unavailable'
        ? '⚠ no model available — raw readings below, your question was NOT answered'
        : kind === 'no_grounding'
          ? '⚠ the model’s wording carried numbers no tool produced, so it is not shown'
          : kind === 'unparseable'
            ? '⚠ the model did not return a usable instruction — raw readings below'
            : kind === 'all_tools_failed'
              ? '⚠ every reading I tried failed — raw readings below'
              : `⚠ stopped after ${iterations} rounds without an answer — raw readings below`,
    ];
    if (failed.length > 0) {
      header.push(
        `tool failures: ${failed.map((t) => `${t.name} (${t.error ?? 'unknown'})`).join('; ')}`,
      );
    }
    header.push(`(${why})`);
    return {
      text: truncateForTelegram([header.join('\n'), '', ...digest].join('\n\n')),
      ok: false,
      provider,
      model,
      iterations,
      toolCalls: traces,
      degraded: kind,
      blocks: digest,
      history: [...msgs.slice(1), { role: 'assistant', content: digest.join('\n\n') }],
    };
  };

  for (let round = 0; round < maxIterations; round++) {
    iterations++;

    let result: AskResult;
    try {
      result = await askFn(env, msgs, { maxTokens: 600, temperature: 0.1, json: true });
    } catch (e) {
      // LlmUnavailable is the ordinary "no key / budget spent" case; anything else
      // is a provider error. Both mean the same thing to the operator — no prose —
      // so both degrade, and the message keeps the cause visible.
      const why = e instanceof LlmUnavailable ? e.message : `model call failed: ${String(e)}`;
      return degrade('llm_unavailable', why);
    }
    provider = result.provider;
    model = result.model;

    const parsed = parseJson<ModelToolCall>(result.text);
    if (!parsed || typeof parsed !== 'object') {
      parseFails++;
      if (parseFails >= 2) {
        return degrade('unparseable', `last reply was not JSON: ${result.text.slice(0, 160)}`);
      }
      msgs.push({ role: 'assistant', content: result.text });
      msgs.push({
        role: 'user',
        content:
          'That was not a JSON object. Reply with exactly one of: ' +
          '{"tool":"<name>","args":{…}} or {"answer":"<text>"}',
      });
      continue;
    }

    const toolName = typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';

    // ── a tool call ──────────────────────────────────────────────────────────
    if (toolName) {
      const args: Args =
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? (parsed.args as Args)
          : {};
      const key = cacheKey(toolName, args);
      const hit = cache.get(key);

      msgs.push({ role: 'assistant', content: result.text });

      if (hit !== undefined) {
        traces.push({ name: toolName, ok: true, cached: true, chars: hit.length, error: null });
        msgs.push({
          role: 'user',
          content: `TOOL RESULT (${toolName}) [already read this turn]:\n${hit}`,
        });
        continue;
      }

      const res = await runTool(env, toolName, args, ctx);
      if (res.ok) {
        cache.set(key, res.text);
        blocks.push(res.text);
        traces.push({ name: toolName, ok: true, cached: false, chars: res.text.length, error: null });
        msgs.push({ role: 'user', content: `TOOL RESULT (${toolName}):\n${res.text}` });
      } else {
        traces.push({ name: toolName, ok: false, cached: false, chars: 0, error: res.error });
        // The wording matters: a model told only "error" will happily answer "0".
        msgs.push({
          role: 'user',
          content:
            `TOOL FAILED (${toolName}): ${res.error}\n` +
            'That reading is UNKNOWN, not zero. Say you could not read it, or try another tool.',
        });
      }
      continue;
    }

    // ── an answer ────────────────────────────────────────────────────────────
    if (answer) {
      const allowed = [...blocks, trimmedQuestion].join('\n');
      const ungrounded = ungroundedNumbers(answer, allowed);
      if (ungrounded.length > 0) {
        // Do not print the offending numerals: the reply must contain only numbers
        // a tool produced, and these are precisely the ones that did not.
        return degrade(
          'no_grounding',
          `${ungrounded.length} numeral(s) in the model reply appear in no tool output`,
        );
      }
      const history: Msg[] = [...msgs.slice(1), { role: 'assistant', content: answer }];
      return {
        // The model's sentence is the only unescaped text in a reply, so it is the
        // only part that needs the parse-mode guard; see `safeModelHtml`.
        text: truncateForTelegram(safeModelHtml(answer)),
        ok: true,
        provider,
        model,
        iterations,
        toolCalls: traces,
        degraded: 'none',
        blocks,
        history,
      };
    }

    // Neither a tool nor an answer: give it one chance to correct, then stop.
    parseFails++;
    if (parseFails >= 2) {
      return degrade('unparseable', `reply had neither "tool" nor "answer": ${result.text.slice(0, 160)}`);
    }
    msgs.push({ role: 'assistant', content: result.text });
    msgs.push({
      role: 'user',
      content: 'Reply with either {"tool":"<name>","args":{…}} or {"answer":"<text>"}. Nothing else.',
    });
  }

  const allFailed = traces.length > 0 && traces.every((t) => !t.ok);
  return degrade(
    allFailed ? 'all_tools_failed' : 'iteration_cap',
    allFailed
      ? 'no tool returned a reading'
      : `round limit of ${maxIterations} reached before the model answered`,
  );
}

/**
 * The scheduled-job list, exported for the parent's help text.
 *
 * Not used by the loop (the prompt lists tools, not jobs) but it is the fact a
 * wiring change is most likely to want, and re-deriving it from `deadman.ts`
 * elsewhere is how two lists end up disagreeing.
 */
export const WATCHED_JOBS: readonly string[] = SCHEDULED_JOBS.map((j) => j.name);
