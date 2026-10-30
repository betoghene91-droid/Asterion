/**
 * Asterion v1 — the Worker.
 *
 * Responsibilities, in order of load-bearing-ness:
 *   1. Telegram webhook: auth, buttons, free text -> compiled brief.
 *   2. Cron: sentinel sweep, discovery tick, briefing, dead-man's switch.
 *   3. Dispatch: only ever through PolicyEngine.authorize().
 *
 * It never holds a chain key. It never signs. It never spends money.
 */

import { crawlTick, seed } from './discovery.js';
import { approveAndDispatch, type DispatchDb } from './dispatch.js';
import { renderBrief, type Brief, type Question } from './intake.js';
import { append as ledgerAppend, verify as ledgerVerify } from './ledger.js';
import { LlmUnavailable, parseJson } from './llm.js';
import { compileWithEnrichment, describeEnrichment } from './intake-enrich.js';
import { byId, PLAYBOOKS, type Cls } from './playbooks.js';
import { getSkill } from './skills.js';
import { priorFor, renderPrecedent, retrieve, type CorpusDigest } from './corpus.js';
import { PolicyEngine, roeFromBrief, type Action, type Mut } from './policy.js';
import { sentinelTick } from './sentinel.js';
import { deskTick, runCalibration, deskAnalystTick } from './desk/pipeline.js';
import {
  calibCard,
  deskCard,
  killsCard,
  modeCard,
  positionsCard,
  thesisCard,
} from './desk/cards.js';
import { latestCalibration } from './desk/logger.js';
import { deskStatus } from './desk/pipeline.js';
import {
  answerCb,
  editText,
  esc,
  guard,
  homeScreen,
  KEYBOARDS,
  rule,
  send,
  setWebAppOrigin,
  SEV,
  statusScreen,
  type Btn,
  type Sev,
} from './telegram.js';
import { uiRoute } from './ui/shell.js';

export interface Env {
  DB: D1Database;
  BACKUPS?: R2Bucket;
  FLAGS?: KVNamespace;
  AI?: { run: (m: string, i: unknown) => Promise<unknown> };
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  RPC_URL?: string;
  CHAIN_ID?: string;
  ALERT_FLOOR?: string;
  DAILY_LLM_BUDGET?: string;
  DAILY_SUBREQUEST_BUDGET?: string;
  OPERATOR_NAME?: string;
  LLM_LOCAL_BASE?: string;
  LLM_LOCAL_MODEL?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPO?: string;
  /**
   * Comma-separated allowlist of dashboard origins for CORS on /api/*.
   * Example: 'https://asterion.pages.dev,http://localhost:8788'.
   * Absent means NO cross-origin access at all: same-origin page loads still
   * work, a Pages-hosted dashboard does not. Never '*' — these endpoints
   * expose findings and ledger history.
   */
  DASH_ORIGIN?: string;
  /** Bearer token for /api/*. Unset leaves the API open (see requireDashboardAuth). */
  DASHBOARD_TOKEN?: string;
  /**
   * Shared secret the prove runner presents on /hook/proof.
   * FAILS CLOSED: when unset, every proof callback is refused. /hook/proof is the
   * only path that can create a finding, so an open door here makes every
   * downstream check irrelevant.
   */
  PROOF_HOOK_SECRET?: string;
  /** Branch/tag of GITHUB_REPO holding prove.yml. Defaults to 'main'. */
  GITHUB_REF?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // -- Mini App (additive; see src/ui/) -------------------------------------
    // Three new statements. None of them alters a branch below.
    //
    // 1. Record the Worker's own public origin. A Telegram `web_app` button needs
    //    an absolute https URL and a Worker has no binding that reports its own
    //    hostname; the URL the request arrived on is the one value that is always
    //    correct. It has to be learned HERE, above the `/tg` handler, because that
    //    handler RETURNS - an origin recorded further down would never run for the
    //    webhook, which is the request that precedes the operator seeing the
    //    button. Nothing below this comments out or short-circuits: the /tg
    //    handler still runs exactly as it did.
    //
    // 2. The console. Matched before the `startsWith('/api/')` branch so
    //    `/api/ui/*` never reaches dashboardApi, which would answer it "unknown
    //    endpoint". The only requests whose behaviour changes here are requests
    //    that previously got exactly that 404.
    if (url.pathname === '/tg') {
      setWebAppOrigin(url.origin);
    }
    if (
      url.pathname === '/ui' ||
      url.pathname.startsWith('/ui/') ||
      url.pathname.startsWith('/api/ui/')
    ) {
      setWebAppOrigin(url.origin);
      return uiRoute(env, req, url);
    }

    if (url.pathname === '/health') {
      return json({ ok: true, ts: Date.now() });
    }

    if (url.pathname === '/tg') {
      if (req.method !== 'POST') return new Response('method', { status: 405 });
      // Telegram supports a secret header; reject anything else outright.
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const got = req.headers.get('x-telegram-bot-api-secret-token');
        if (got !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      }
      const update = (await req.json()) as TgUpdate;
      ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error('update failed', e)));
      return new Response('ok');
    }

    // Called by the `prove` workflow when a PoC batch finishes. This is the
    // only way a proof enters the system, and it lands as a verdict, not a
    // finding: the queue only ever reads `proven`.
    if (url.pathname === '/hook/proof' && req.method === 'POST') {
      // FAIL CLOSED. An unset secret refuses everything rather than opening the
      // one endpoint that can mint a finding. A hunt id is not a credential: it
      // is returned to the caller and pasted into Telegram notifications.
      if (!env.PROOF_HOOK_SECRET) {
        console.error('proof hook refused: PROOF_HOOK_SECRET is not configured');
        return json({ ok: false, error: 'proof hook not configured' }, 503);
      }
      const presented = req.headers.get('x-asterion-secret') ?? '';
      if (!timingSafeEqual(presented, env.PROOF_HOOK_SECRET)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      const huntId = req.headers.get('x-asterion-hunt') ?? '';
      if (!huntId) return new Response('missing hunt id', { status: 400 });
      const body = (await req.json()) as ProofReport;
      // Ingest inline so the response can tell the workflow what happened. An
      // unknown hunt id is recorded as an orphan, not swallowed: the callback
      // must never report success for a verdict that landed nowhere.
      try {
        const r = await ingestProofs(env, huntId, body);
        return json({ ok: true, hunt: huntId, orphan: r.orphan, verdicts: r.stored });
      } catch (e) {
        console.error('proof ingest', huntId, e);
        return json({ ok: false, hunt: huntId, error: (e as Error).message }, 500);
      }
    }

    if (url.pathname === '/hook/dispatch' && req.method === 'POST') {
      // Called by GitHub Actions when a run finishes. Never the reverse.
      const body = (await req.json()) as { kind: string; payload: unknown };
      await ledgerAppend(env, `actions.${body.kind}`, body.payload);
      return json({ ok: true });
    }

    // -- read-only dashboard API ── read-only dashboard API ─────────────────────────────────────────
    // These endpoints answer GET only and never mutate. The dashboard is
    // served separately from /dashboard/index.html.
    if (url.pathname.startsWith('/api/')) {
      // Preflight. Answered before auth on purpose: a 401 to an OPTIONS request
      // is not readable by the browser, so the real error the operator sees
      // becomes an opaque "CORS error" instead of "unauthorized".
      if (req.method === 'OPTIONS') {
        if (!corsAllowOrigin(env, req)) return new Response(null, { status: 403 });
        return withCors(env, req, new Response(null, { status: 204 }));
      }
      if (req.method === 'GET') {
        const denied = requireDashboardAuth(env, req);
        if (denied) return withCors(env, req, denied);
        return withCors(env, req, await dashboardApi(env, url.pathname));
      }
      return new Response('method not allowed', {
        status: 405,
        headers: { allow: 'GET, OPTIONS' },
      });
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    ctx.waitUntil(
      (async () => {
        await heartbeat(env, 'cron');
        if (cron === '*/5 * * * *') {
          // The desk is COMPOSED INTO this slot, never a replacement for it.
          // Sentinel is the security sweep; the desk is the paper trader. They
          // share a cron because Workers gives us one 5-minute timer, and each
          // gets its own try/catch so one failing cannot silence the other.
          await runSentinel(env).catch((e) => console.error('cron sentinel failed', e));
          await deskTick(env).catch((e) => console.error('cron desk failed', e));
          return;
        }
        if (cron === '0 * * * *') {
          await runCrawler(env).catch((e) => console.error('cron crawler failed', e));
          await deskAnalystTick(env).catch((e) => console.error('cron desk analyst failed', e));
          return;
        }
        if (cron === '15 3 * * *') {
          await runMaintenance(env).catch((e) => console.error('cron maintenance failed', e));
          await runCalibration(env).catch((e) => console.error('cron desk calibration failed', e));
          return;
        }
        if (cron === '0 */6 * * *') return runDeadman(env);
        if (cron === '30 6 * * *') return runBriefing(env);
      })().catch((e) => console.error('cron failed', cron, e)),
    );
  },
};

// ─────────────────────────────── telegram ───────────────────────────────

interface TgUpdate {
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

async function handleUpdate(env: Env, u: TgUpdate): Promise<void> {
  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = q.message?.chat.id;
    const msgId = q.message?.message_id;
    if (!chatId || !msgId) return;
    if (!(await guard(env, chatId))) return;
    await answerCb(env, q.id);
    await routeButton(env, chatId, msgId, q.data ?? 'm:main');
    return;
  }

  const msg = u.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  if (!(await guard(env, chatId))) return;

  const text = msg.text.trim();

  if (text === '/start' || text === '/menu') {
    await send(env, homeScreen(env.OPERATOR_NAME ?? 'operator'), KEYBOARDS.main(), chatId);
    return;
  }

  if (text === '/status') {
    await send(env, await buildStatus(env), KEYBOARDS.back(), chatId);
    return;
  }

  if (text.startsWith('/hunt ')) {
    await startHunt(env, chatId, text.slice(6));
    return;
  }

  if (text === '/corpus') {
    await send(env, await corpusScreen(env), corpusKeyboard(), chatId);
    return;
  }

  // ── desk ────────────────────────────────────────────────────────────
  // Read-only plus one mode *request*, which cannot arm anything: /desk live
  // reports the unmet gates and the desk stays in paper (see desk/arming.ts).
  if (text === '/desk' || text === '/desk paper' || text === '/desk live') {
    if (text === '/desk') {
      await send(env, await deskCard(env), KEYBOARDS.back(), chatId);
    } else {
      await send(env, await modeCard(env, text.endsWith('live') ? 'live' : 'paper'), KEYBOARDS.back(), chatId);
    }
    return;
  }

  if (text === '/pos') {
    await send(env, await positionsCard(env), KEYBOARDS.back(), chatId);
    return;
  }

  if (text === '/kills') {
    await send(env, await killsCard(env), KEYBOARDS.back(), chatId);
    return;
  }

  if (text === '/calib') {
    await send(env, await calibCard(env), KEYBOARDS.back(), chatId);
    return;
  }

  if (text.startsWith('/thesis ')) {
    await send(env, await thesisCard(env, text.slice(8).trim()), KEYBOARDS.back(), chatId);
    return;
  }

  if (text.startsWith('/precedent ')) {
    await send(env, await precedentScreen(env, text.slice(12).trim()), KEYBOARDS.back(), chatId);
    return;
  }

  if (text.startsWith('/seed ')) {
    const n = await seed(env, text.slice(6).split(/[\s,]+/));
    await send(env, `queued <b>${n}</b> hosts for discovery.`, KEYBOARDS.back(), chatId);
    return;
  }

  // Anything else is a sloppy hunt request. Compile it.
  await startHunt(env, chatId, text);
}

async function routeButton(env: Env, chatId: number, msgId: number, data: string): Promise<void> {
  const [ns, arg] = data.split(':');

  switch (ns) {
    case 'm':
      await editText(env, chatId, msgId, homeScreen(env.OPERATOR_NAME ?? 'operator'), KEYBOARDS.main());
      return;

    case 'st':
      await editText(env, chatId, msgId, await buildStatus(env), KEYBOARDS.back());
      return;

    case 'pb':
      await editText(env, chatId, msgId, playbookList(), playbookKeyboard());
      return;

    case 'pbx': {
      const p = byId(arg ?? '');
      if (!p) {
        // A retired or mistyped playbook must SAY so. Returning silently leaves a
        // stale button dead: answerCallbackQuery already cleared the spinner, so the
        // operator sees a tap do nothing and cannot tell a bug from a slow network.
        await editText(
          env,
          chatId,
          msgId,
          [
            '<b>UNKNOWN PLAYBOOK</b>',
            rule(),
            `<code>${esc(arg ?? '')}</code> is not in this build.`,
            '',
            'The button may be from an older message.',
          ].join('\n'),
          KEYBOARDS.back(),
        );
        return;
      }
      await editText(env, chatId, msgId, playbookCard(p), [
        [{ text: `\u25B6  Hunt this`, callback_data: `huntpb:${p.id}` }],
        [{ text: '\u2190  Playbooks', callback_data: 'pb:list' }],
      ]);
      return;
    }

    case 'huntpb': {
      const p = byId(arg ?? '');
      if (!p) return;
      await startHunt(env, chatId, p.name, { cls: p.cls, playbook: p.id });
      return;
    }

    case 'hunt':
      if (arg === 'new') {
        await editText(
          env,
          chatId,
          msgId,
          [
            '<b>NEW HUNT</b>',
            rule(),
            'Type anything. One URL is enough.',
            '',
            '<i>Example:</i>',
            '<code>look at app.example.com api, take your time</code>',
            '',
            'Or tap a playbook instead \u2014 it needs no prompt at all.',
          ].join('\n'),
          [[{ text: '\u2261  Browse playbooks', callback_data: 'pb:list' }], ...KEYBOARDS.back()],
        );
        return;
      }
      return;

    case 'q':
      await editText(env, chatId, msgId, await queueScreen(env), KEYBOARDS.back());
      return;

    case 'ap':
      await editText(env, chatId, msgId, await approvalsScreen(env), KEYBOARDS.back());
      return;

    case 'wl':
      await editText(env, chatId, msgId, await watchScreen(env), KEYBOARDS.back());
      return;

    case 'br':
      await editText(env, chatId, msgId, await buildBriefing(env), KEYBOARDS.back());
      return;

    case 'disc':
      await editText(env, chatId, msgId, await discoveryScreen(env), KEYBOARDS.back());
      return;

    case 'corp':
      await editText(env, chatId, msgId, await corpusScreen(env), corpusKeyboard(), );
      return;

    case 'pbd':
      await editText(env, chatId, msgId, await precedentScreen(env, arg ?? ''), [
        [{ text: '\u25B6  Hunt this', callback_data: `huntpb:${arg}` }],
        [{ text: '\u2190  Corpus', callback_data: 'corp:list' }],
      ]);
      return;

    case 'ok':
    case 'no': {
      // Approve/deny an approval, by id. Approval of an engagement brief is the
      // ONLY path into proof compute: it gates, records a hunt row, and then
      // dispatches prove.yml. See dispatch.ts for the ordering guarantees.
      const id = arg ?? '';
      if (!id) return;
      const outcome = await approveAndDispatch(id, ns === 'ok', {
        db: d1Db(env),
        env,
        fetch: (...a) => fetch(...a),
        ledger: async (kind, payload) => {
          await ledgerAppend(env, kind, payload);
        },
        notify: async (text) => {
          await send(env, text, KEYBOARDS.back(), chatId);
        },
        operator: env.OPERATOR_NAME ?? 'operator',
      });
      // The outcome message was already sent; replace the button card so the
      // stale keyboard cannot be tapped a second time.
      const label =
        ns !== 'ok'
          ? `\u2717 denied <code>${id}</code>`
          : outcome.dispatched
            ? `\u2713 approved \u2014 dispatched <code>${outcome.huntId}</code>`
            : `\u2713 approved \u2014 <b>not dispatched</b> (${esc(outcome.reason)})`;
      await editText(env, chatId, msgId, label, KEYBOARDS.back());
      return;
    }

    default:
      return;
  }
}

// ─────────────────────────────── hunt flow ───────────────────────────────

async function startHunt(
  env: Env,
  chatId: number,
  raw: string,
  hints: { cls?: Cls; playbook?: string } = {},
): Promise<void> {
  // A hunt needs a program row to hang off. Default to a self-scoped one.
  const programId = await ensureSelfProgram(env, raw);
  const authRef = await authorizationFor(env, programId);

  if (!authRef) {
    await send(
      env,
      [
        '<b>NO AUTHORIZATION ON FILE</b>',
        rule(),
        'I will not touch a target whose program policy is not recorded.',
        '',
        'Two ways forward:',
        '  1. <code>/seed example.com</code> then let discovery parse its policy',
        '  2. paste the exact policy sentence that authorizes testing',
      ].join('\n'),
      KEYBOARDS.back(),
      chatId,
    );
    return;
  }

  const compiled = await compileWithEnrichment(
    env,
    raw,
    { program_id: programId, authorization_ref: authRef, scope_hints: [] },
    hints.playbook || hints.cls ? { class: hints.cls } : {},
  );
  const result = compiled.result;

  // The model has now genuinely run. Record which way it went, so "briefs are
  // model-enriched" is an audited claim rather than a comment in a config file.
  // A failure to write the ledger must not lose the operator's brief, so this is
  // deliberately fire-and-forget on its own error.
  try {
    await ledgerAppend(env, 'intake.compiled', { outcome: describeEnrichment(compiled) });
  } catch {
    /* the brief still ships; the audit line is best-effort, like llm_log */
  }

  if ('questions' in result) {
    await send(env, renderQuestions(result.questions), questionKeyboard(result.questions), chatId);
    return;
  }

  const brief = hints.playbook
    ? { ...result.brief, playbooks: [hints.playbook] }
    : result.brief;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO approvals (id, fingerprint, action, reason, status, requested_at)
     VALUES (?,?,?,?, 'pending', ?)`,
  )
    .bind(
      id,
      id.slice(0, 16),
      JSON.stringify({ kind: 'engagement', brief }),
      `new engagement: ${brief.title}`,
      Math.floor(Date.now() / 1000),
    )
    .run();

  await send(env, renderBrief(brief), [
    [
      { text: '\u2713  Authorize', callback_data: `ok:${id}` },
      { text: '\u2717  Cancel', callback_data: `no:${id}` },
    ],
  ], chatId);
}

async function ensureSelfProgram(env: Env, raw: string): Promise<string> {
  const m = raw.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/i);
  const host = m?.[0]?.toLowerCase() ?? 'unscoped';
  await env.DB.prepare(
    `INSERT INTO programs (id,name,platform,homepage,status,discovered_at)
     VALUES (?,?,?,?,'new',?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(host, host, 'self', `https://${host}`, Math.floor(Date.now() / 1000))
    .run();
  return host;
}

async function authorizationFor(env: Env, programId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT automation, policy_url, policy_text FROM programs WHERE id=?',
  ).first<{ automation: string; policy_url: string | null; policy_text: string | null }>();
  if (!row) return null;
  if (row.automation === 'prohibited') return null;
  if (row.automation === 'allowed' && row.policy_url) {
    return `${row.policy_url} permits automated testing`;
  }
  // not_mentioned still needs an explicit anchor; use the policy URL if present.
  if (row.policy_url) return `${row.policy_url} (no prohibition on automated testing)`;
  return null;
}

function renderQuestions(qs: Question[]): string {
  return ['<b>THREE QUESTIONS</b>', rule(), ...qs.map((q, i) => `${i + 1}. ${esc(q.text)}`)].join('\n');
}

function questionKeyboard(qs: Question[]): Btn[][] {
  const first = qs[0];
  if (!first) return KEYBOARDS.back();
  const rows: Btn[][] = [];
  for (const o of first.options.slice(0, 6)) {
    rows.push([{ text: o.label, callback_data: `ans:${first.key}:${o.value}` }]);
  }
  rows.push([{ text: '\u2190  Cancel', callback_data: 'm:main' }]);
  return rows;
}

// ─────────────────────────────── screens ───────────────────────────────

async function buildStatus(env: Env): Promise<string> {
  const one = async <T>(sql: string, ...b: unknown[]) =>
    (await env.DB.prepare(sql).bind(...b).first<T>()) ?? ({} as T);

  const hb = await one<{ ts: number }>("SELECT ts FROM kv WHERE key='cron_last'");
  const programs = await one<{ n: number }>('SELECT COUNT(*) AS n FROM programs');
  const parsed = await one<{ n: number }>('SELECT COUNT(*) AS n FROM programs WHERE status=?', 'parsed');
  const watch = await one<{ n: number }>('SELECT COUNT(*) AS n FROM watchlist WHERE enabled=1');
  const queue = await one<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE status='candidate'");
  const pending = await one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status='pending'");
  const llm = await one<{ used: number }>(
    'SELECT used FROM quota WHERE day=? AND bucket=?',
    new Date().toISOString().slice(0, 10),
    'llm_tokens',
  );
  const sentinel = await one<{ ts: number }>("SELECT ts FROM kv WHERE key='sentinel_last'");

  return statusScreen({
    worker: hb.ts && Date.now() / 1000 - hb.ts < 7200 ? 'ok' : 'stale',
    crawled: parsed.n ?? 0,
    programs: programs.n ?? 0,
    watch: watch.n ?? 0,
    queue: queue.n ?? 0,
    pending: pending.n ?? 0,
    llmTokens: llm.used ?? 0,
    llmCap: Number(env.DAILY_LLM_BUDGET ?? '200000'),
    lastSentinel: sentinel.ts ?? null,
  });
}

function corpusKeyboard(): Btn[][] {
  return [
    ...PLAYBOOKS.filter((p) => p.cls !== 'web2')
      .slice(0, 8)
      .map((p) => [{ text: p.id, callback_data: `pbd:${p.id}` }]),
    [{ text: '\u2190  Menu', callback_data: 'm:main' }],
  ];
}

function playbookList(): string {
  const groups: Record<string, string[]> = {};
  for (const p of PLAYBOOKS) (groups[p.cls] ??= []).push(p.id);
  const lines = ['<b>PLAYBOOKS</b>  <i>tap one to hunt</i>', rule()];
  for (const [cls, ids] of Object.entries(groups)) {
    lines.push('', `<b>${cls.toUpperCase()}</b>  <i>${ids.length}</i>`);
    for (const id of ids) {
      const p = byId(id)!;
      lines.push(`  <code>${id}</code>`);
    }
  }
  return lines.join('\n');
}

function playbookKeyboard(): Btn[][] {
  const rows: Btn[][] = [];
  for (const p of PLAYBOOKS.slice(0, 20)) {
    rows.push([{ text: p.name.slice(0, 44), callback_data: `pbx:${p.id}` }]);
  }
  rows.push([{ text: '\u2190  Menu', callback_data: 'm:main' }]);
  return rows;
}

function playbookCard(p: ReturnType<typeof byId>): string {
  if (!p) return 'unknown playbook';
  return [
    `<b>${esc(p.name)}</b>`,
    rule(),
    `id          <code>${p.id}</code>`,
    `class       ${p.cls} / ${p.family}`,
    `mutability  ${p.mut}${p.needsApproval ? '  (approval per action)' : ''}`,
    '',
    '<b>requires</b>',
    ...p.requires.map((r) => `  \u00B7 ${esc(r)}`),
    '',
    '<b>proves</b>',
    `  <i>${esc(p.proof)}</i>`,
    ...skillLines(p.id),
  ].join('\n');
}

/**
 * The skill's discriminating questions, on the card the operator actually reads.
 *
 * `skills.ts` was fully implemented, tested and even embedded for a filesystem-less
 * Worker -- and then never called by anything. A pack nothing reads is a pack that
 * does not exist, no matter how green its tests are. This is the first production
 * reader, so it is also the seam that keeps the 25 packs honest.
 *
 * Deliberately capped at three: these are prompts for a human deciding whether an
 * instance is real, not a wall of text on a phone screen. A pack that is missing or
 * fails to parse adds nothing -- the card still renders, because a broken skill must
 * never take the playbook down with it.
 */
function skillLines(playbookId: string): string[] {
  try {
    const s = getSkill(playbookId);
    if (!s || !s.questions.length) return [];
    const top = s.questions.slice(0, 3);
    return ['', `<b>ask before you believe it</b>`, ...top.map((q) => `  ? ${esc(q)}`)];
  } catch {
    return [];
  }
}

async function queueScreen(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    "SELECT id, title, severity, target, proof FROM (SELECT f.id, f.title, f.severity, COALESCE(a.value,'') AS target, f.proof_state AS proof FROM findings f LEFT JOIN assets a ON a.id=f.asset_id) WHERE 1=1 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END LIMIT 10",
  ).all<{ id: string; title: string; severity: Sev; target: string; proof: string }>();

  if (!rows.results?.length) {
    return ['<b>QUEUE</b>', rule(), '<i>empty \u2014 nothing proven yet.</i>', '', 'Silence is correct here.'].join('\n');
  }
  const lines = ['<b>QUEUE</b>', rule()];
  for (const f of rows.results) {
    lines.push(`${SEV[f.severity]?.glyph ?? '\u25CB'} ${SEV[f.severity]?.label ?? 'INFO'}  ${esc(f.title)}`);
    lines.push(`   <code>${esc(f.target)}</code>  proof:${esc(f.proof)}`);
  }
  return lines.join('\n');
}

async function approvalsScreen(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    "SELECT id, reason, requested_at FROM approvals WHERE status='pending' ORDER BY requested_at LIMIT 8",
  ).all<{ id: string; reason: string; requested_at: number }>();
  if (!rows.results?.length) return ['<b>APPROVALS</b>', rule(), '<i>nothing waiting.</i>'].join('\n');
  const lines = ['<b>APPROVALS</b>', rule()];
  for (const a of rows.results) {
    const mins = Math.round((Date.now() / 1000 - a.requested_at) / 60);
    lines.push(`<code>${a.id.slice(0, 8)}</code>  ${esc(a.reason)}  <i>${mins}m</i>`);
  }
  return lines.join('\n');
}

async function watchScreen(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    'SELECT label, address, last_block, enabled FROM watchlist ORDER BY label LIMIT 10',
  ).all<{ label: string; address: string; last_block: number; enabled: number }>();
  if (!rows.results?.length) {
    return ['<b>WATCHLIST</b>', rule(), '<i>empty.</i>', '', 'Add one: <code>/watch 0xabc... label</code>'].join('\n');
  }
  const lines = ['<b>WATCHLIST</b>', rule()];
  for (const w of rows.results) {
    lines.push(`${w.enabled ? '\u25CF' : '\u25CB'} ${esc(w.label)}  <code>${w.address.slice(0, 10)}\u2026</code>  blk ${w.last_block}`);
  }
  return lines.join('\n');
}

async function discoveryScreen(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    'SELECT automation, COUNT(*) AS n FROM programs GROUP BY automation',
  ).all<{ automation: string; n: number }>();
  const totals = new Map((rows.results ?? []).map((r) => [r.automation, r.n]));
  const last = await env.DB.prepare("SELECT ts FROM kv WHERE key='crawler_last'").first<{ ts: number }>();
  return [
    '<b>DISCOVERY</b>',
    rule(),
    `allowed        ${totals.get('allowed') ?? 0}`,
    `not mentioned  ${totals.get('not_mentioned') ?? 0}`,
    `prohibited     ${totals.get('prohibited') ?? 0}   <i>(never touched)</i>`,
    `unknown        ${totals.get('unknown') ?? 0}`,
    rule(),
    `last sweep     ${last?.ts ? Math.round((Date.now() / 1000 - last.ts) / 60) + ' min ago' : 'never'}`,
  ].join('\n');
}

async function buildBriefing(env: Env): Promise<string> {
  const one = async <T>(sql: string, ...b: unknown[]) =>
    (await env.DB.prepare(sql).bind(...b).first<T>()) ?? ({} as T);
  const alerts = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM alerts WHERE created_at > ?',
    Math.floor(Date.now() / 1000) - 86400,
  );
  const proven = await one<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE proof_state='proven'");
  const dl = await one<{ n: number }>("SELECT COUNT(*) AS n FROM programs WHERE automation='allowed'");

  return [
    `<b>BRIEFING</b>  <i>${new Date().toISOString().slice(0, 10)}</i>`,
    rule(),
    `new alerts      ${alerts.n ?? 0}`,
    `proven          ${proven.n ?? 0}`,
    `huntable        ${dl.n ?? 0} programs`,
    rule(),
    '<i>Only proven, in-scope, above-floor items push separately.</i>',
  ].join('\n');
}

// ─────────────────────────────── cron jobs ───────────────────────────────

async function heartbeat(env: Env, source: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO heartbeats (source, ts) VALUES (?,?)
     ON CONFLICT(source) DO UPDATE SET ts=excluded.ts`,
  )
    .bind(source, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO kv (key,value,ts) VALUES ('cron_last',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts`,
  )
    .bind(String(now), now)
    .run();
}

async function runSentinel(env: Env): Promise<void> {
  const { watched, alerts } = await sentinelTick(env);
  if (alerts > 0) await flushAlerts(env);
  console.log('sentinel', { watched, alerts });
}

async function flushAlerts(env: Env): Promise<void> {
  const floor = env.ALERT_FLOOR ?? 'medium';
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const min = order[floor as keyof typeof order] ?? 2;

  const rows = await env.DB.prepare(
    'SELECT id, rule, severity, payload, created_at FROM alerts WHERE sent_at IS NULL ORDER BY created_at LIMIT 10',
  ).all<{ id: string; rule: string; severity: keyof typeof order; payload: string; created_at: number }>();

  for (const a of rows.results ?? []) {
    if ((order[a.severity] ?? 4) > min) continue;
    const p = JSON.parse(a.payload) as { label: string; address: string; tx: string; block: number; detail: string };
    await send(
      env,
      [
        `${SEV[a.severity as Sev]?.glyph ?? '\u25CB'} <b>${a.severity.toUpperCase()}</b>  ${esc(p.label)}`,
        rule(),
        `rule    <code>${a.rule}</code>`,
        `what    ${esc(p.detail)}`,
        `addr    <code>${p.address}</code>`,
        `tx      <code>${p.tx.slice(0, 18)}\u2026</code>`,
        `block   ${p.block}`,
      ].join('\n'),
    ).catch(() => undefined);
    await env.DB.prepare('UPDATE alerts SET sent_at=? WHERE id=?').bind(Date.now() / 1000, a.id).run();
  }
}

async function runCrawler(env: Env): Promise<void> {
  const { probed, found } = await crawlTick(env);
  console.log('crawler', { probed, found });
}

async function runMaintenance(env: Env): Promise<void> {
  const { ok, detail } = await ledgerVerify(env);
  if (!ok) {
    await send(env, `\u26A0 <b>LEDGER INTEGRITY</b>\n${esc(detail)}`).catch(() => undefined);
  }
  // Retire approvals older than a day; a stale approval is a stale decision.
  await env.DB.prepare(
    "UPDATE approvals SET status='expired' WHERE status='pending' AND requested_at < ?",
  )
    .bind(Math.floor(Date.now() / 1000) - 86400)
    .run();
}

async function runDeadman(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT ts FROM kv WHERE key='cron_last'").first<{ ts: number }>();
  const quietHours = row?.ts ? (Date.now() / 1000 - row.ts) / 3600 : 999;
  // This job itself just ran, so check the *other* heartbeat sources.
  const sentinel = await env.DB.prepare("SELECT ts FROM kv WHERE key='sentinel_last'").first<{ ts: number }>();
  const sentinelQuiet = sentinel?.ts ? (Date.now() / 1000 - sentinel.ts) / 3600 : 999;
  if (sentinelQuiet > 2) {
    await send(
      env,
      [
        '\u26A0 <b>DEAD-MAN\u2019S SWITCH</b>',
        rule(),
        `sentinel silent for ${sentinelQuiet.toFixed(1)}h`,
        '',
        'Nothing is being watched. Check the Worker, the RPC, or the cron.',
      ].join('\n'),
    ).catch(() => undefined);
  }
  void quietHours;
}

async function runBriefing(env: Env): Promise<void> {
  await send(env, await buildBriefing(env)).catch(() => undefined);
}




// ─────────────────────────── corpus access ───────────────────────────

/** In-isolate cache: the digest is 151 KB and never changes at runtime. */
let corpusCache: CorpusDigest | null = null;
let corpusLoadedAt = 0;

async function getCorpus(env: Env): Promise<CorpusDigest | null> {
  if (corpusCache && Date.now() - corpusLoadedAt < 3_600_000) return corpusCache;
  try {
    const row = await env.DB.prepare(
      'SELECT digest FROM corpus_digest ORDER BY loaded_at DESC LIMIT 1',
    ).first<{ digest: string }>();
    if (!row) return null;
    corpusCache = JSON.parse(row.digest) as CorpusDigest;
    corpusLoadedAt = Date.now();
    return corpusCache;
  } catch {
    return null;
  }
}

/**
 * Rank the playbooks for a target using corpus priors, and render them with
 * precedent. This is what makes a suggestion useful instead of a menu.
 */
async function corpusScreen(env: Env): Promise<string> {
  const digest = await getCorpus(env);
  if (!digest) {
    return [
      '<b>CORPUS</b>',
      rule(),
      '<i>not loaded.</i>',
      '',
      'Run: <code>node app/scripts/load-corpus.mjs --apply</code>',
    ].join('\n');
  }

  const ranked = PLAYBOOKS.filter((p) => p.cls !== 'web2')
    .map((p) => ({ p, prior: priorFor(digest, p.id), st: digest.classes[p.id] }))
    .filter((x) => x.prior.n > 0)
    .sort((a, b) => b.prior.weight - a.prior.weight);

  const lines = [
    `<b>CORPUS</b>  <i>${digest.source_rows.toLocaleString()} findings</i>`,
    rule(),
    '<b>where the money still is</b>',
    '',
  ];
  for (const r of ranked.slice(0, 8)) {
    const st = r.st;
    const bar10 = Math.min(10, Math.round((st!.recent / 3000) * 10));
    lines.push(
      `<code>${r.p.id.padEnd(20)}</code> ${'\u2588'.repeat(bar10)}${'\u2591'.repeat(10 - bar10)}`,
    );
    lines.push(`  ${st!.recent.toLocaleString()} recent severe  ·  w ${r.prior.weight.toFixed(2)}`);
  }
  lines.push('', '<i>Tap a playbook to see its precedent.</i>');
  return lines.join('\n');
}

/** Show the real historical findings for one playbook. */
async function precedentScreen(env: Env, playbookId: string): Promise<string> {
  const digest = await getCorpus(env);
  const p = byId(playbookId);
  if (!p) return 'unknown playbook';
  const st = digest?.classes[playbookId];
  const list = digest?.precedent[playbookId] ?? [];

  const lines = [
    `<b>${esc(p.name)}</b>`,
    `<code>${p.id}</code>  ${p.mut}`,
    rule(),
  ];
  if (st && st.validatable) {
    lines.push(
      `ground truth   ${st.severe.toLocaleString()} severe`,
      `recent (2024+) ${st.recent.toLocaleString()}`,
      `mean weight    ${st.weight.toFixed(2)}`,
      rule(),
    );
  } else {
    lines.push('<i>no ground truth in this corpus (web3-only)</i>', rule());
  }

  if (list.length) {
    lines.push('<b>what this looked like in the wild</b>', '');
    for (const it of list.slice(0, 5)) {
      lines.push(`· ${esc(it.signal.slice(0, 100))}`);
      lines.push(`  <i>${esc(it.project || 'unnamed')} · ${esc(it.firm)} · ${it.year ?? 'n/a'}</i>`);
    }
  }
  return lines.join('\n');
}

// ─────────────────────────── V2: proof ingest ───────────────────────────

interface ProofReport {
  hunt_id?: string;
  contract?: string;
  commit?: string;
  leads_found?: number;
  attempts?: number;
  proven?: number;
  partial?: number;
  disproved?: number;
  inconclusive?: number;
  limitations?: string[];
  verdicts?: {
    test_name: string;
    playbook: string;
    file?: string;
    line?: number;
    verdict: 'proven' | 'partial' | 'disproved' | 'inconclusive';
    confidence: 'confirmed' | 'firm' | 'tentative';
    reasons?: string[];
    proven_claim?: string | null;
    exit_code?: number;
  }[];
}

/**
 * Persist a verdict batch. Two invariants:
 *   1. Only `proven` may create a finding row. Everything else is recorded and
 *      forgotten — visible in history, invisible to the queue.
 *   2. Every verdict is chained into the ledger before it is stored, so the
 *      sequence of what was claimed and when is tamper-evident.
 */
async function ingestProofs(
  env: Env,
  huntId: string,
  r: ProofReport,
): Promise<{ orphan: boolean; stored: number }> {
  const now = Math.floor(Date.now() / 1000);

  // A hunt row is written at dispatch time (see dispatch.ts), so a missing row
  // here means a callback arrived for a hunt this Worker never started. Record
  // it rather than dropping it, but say so out loud.
  const known = await env.DB.prepare('SELECT id, program_id FROM hunts WHERE id=?').first<{
    id: string;
    program_id: string | null;
  }>(huntId);
  const orphan = !known;
  if (orphan) console.warn('proof callback for unknown hunt', huntId);

  await env.DB.prepare(
    `INSERT INTO hunts (id, program_id, repo, commit_sha, contract, fork_block, stage, leads_n, attempts_n, proven_n, stopped_because, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'done',?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       stage='done', commit_sha=excluded.commit_sha, contract=excluded.contract,
       repo=COALESCE(hunts.repo, excluded.repo),
       fork_block=COALESCE(hunts.fork_block, excluded.fork_block),
       leads_n=excluded.leads_n, attempts_n=excluded.attempts_n,
       proven_n=excluded.proven_n, stopped_because=excluded.stopped_because,
       updated_at=excluded.updated_at`,
  )
    .bind(
      huntId,
      // An orphan verdict has no program to attribute itself to; the contract
      // name is NOT a program id, and asserting that it is would corrupt the
      // relation the queue reads.
      null,
      null,
      r.commit ?? null,
      r.contract ?? null,
      0,
      r.leads_found ?? 0,
      r.attempts ?? 0,
      r.proven ?? 0,
      orphan
        ? 'orphan callback: no hunt row was ever created for this id'
        : r.proven
          ? null
          : (r.limitations?.[0] ?? 'no proven finding this run'),
      now,
      now,
    )
    .run();

  let proven = 0;

  for (const v of r.verdicts ?? []) {
    await env.DB.prepare(
      `INSERT INTO proofs (id, hunt_id, playbook, test_name, file, line, verdict, confidence, claim, reasons, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(hunt_id, test_name) DO UPDATE SET
         verdict=excluded.verdict, confidence=excluded.confidence,
         claim=excluded.claim, reasons=excluded.reasons`,
    )
      .bind(
        crypto.randomUUID(),
        huntId,
        v.playbook,
        v.test_name,
        v.file ?? null,
        v.line ?? null,
        v.verdict,
        v.confidence,
        v.proven_claim ?? null,
        JSON.stringify(v.reasons ?? []),
        now,
      )
      .run();

    await ledgerAppend(env, 'proof.verdict', {
      hunt: huntId,
      test: v.test_name,
      verdict: v.verdict,
      confidence: v.confidence,
    });

    if (v.verdict !== 'proven') continue;
    proven++;

    // A proven verdict is the ONLY path to a finding. Note what it needs:
    // a claim string from the judge, which is non-null only when all three
    // conditions held.
    if (!v.proven_claim) continue;

    // Authentication is not authorisation. A callback can carry a valid shared
    // secret and still name a hunt this Worker never started; before this guard
    // that path inserted a finding with program_id = null. The verdict row above
    // is kept (it is evidence the callback is a forgery), but an unattributed
    // claim must never enter the operator's queue.
    if (orphan || !known?.program_id) {
      console.warn('proof verdict refused: no hunt row / no program', huntId, v.test_name);
      await ledgerAppend(env, 'proof.refused_orphan', {
        hunt: huntId,
        test: v.test_name,
        reason: orphan ? 'unknown hunt' : 'hunt has no program_id',
      });
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO findings (id, program_id, title, cls, severity, confidence, proof_state, status, dedupe_key, summary, impact, repro, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'proven', 'candidate', ?,?,?,?,?,?)
       ON CONFLICT(program_id, dedupe_key) DO NOTHING`,
    )
      .bind(
        crypto.randomUUID(),
        // program_id must be the real program, taken from the hunt row. Binding
        // the contract name here (the previous behaviour) violates the FK to
        // programs(id) and aborted the whole ingest loop on the first proven
        // verdict, losing every later verdict in the batch.
        known?.program_id ?? null,
        v.proven_claim.slice(0, 150),
        v.playbook,
        v.confidence === 'confirmed' ? 'high' : 'medium',
        v.confidence,
        `${r.commit ?? ''}:${v.file ?? ''}:${v.line ?? 0}`,
        v.proven_claim,
        v.proven_claim,
        JSON.stringify(v.reasons ?? []),
        now,
        now,
      )
      .run();
  }

  if (proven > 0) {
    await send(
      env,
      [
        `◆ <b>PROVEN  ${proven}</b>`,
        `<code>${(r.contract ?? huntId).slice(0, 40)}</code>`,
        '',
        ...(r.verdicts ?? [])
          // Only claimable ones: an orphan verdict is recorded, never announced
          // as a finding the operator should act on.
          .filter((v) => v.verdict === 'proven' && v.proven_claim && !orphan && !!known?.program_id)
          .map((v) => `  ✓ ${v.playbook}  ${esc((v.proven_claim ?? '').slice(0, 90))}`),
      ].join('\n'),
    ).catch(() => undefined);
  }

  return { orphan, stored: (r.verdicts ?? []).length };
}

// ─────────────────────────── dashboard API ───────────────────────────

/**
 * Read-only. Optional bearer token so a public Worker URL is not a data leak.
 * If DASHBOARD_TOKEN is unset the API is open — acceptable only on a private
 * workers.dev name, and the dashboard says so.
 */
function requireDashboardAuth(env: Env, req: Request): Response | null {
  const want = env.DASHBOARD_TOKEN;
  if (!want) return null;
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (got !== want) return json({ error: 'unauthorized' }, 401);
  return null;
}

async function dashboardApi(env: Env, path: string): Promise<Response> {
  const one = async <T>(sql: string, ...b: unknown[]) =>
    (await env.DB.prepare(sql).bind(...b).first<T>()) ?? ({} as T);

  switch (path) {
    case '/api/status': {
      const cron = await one<{ ts: number }>("SELECT ts FROM kv WHERE key='cron_last'");
      const programs = await one<{ n: number }>('SELECT COUNT(*) AS n FROM programs');
      const parsed = await one<{ n: number }>("SELECT COUNT(*) AS n FROM programs WHERE status='parsed'");
      const huntable = await one<{ n: number }>("SELECT COUNT(*) AS n FROM programs WHERE automation='allowed'");
      const queue = await one<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE proof_state='proven'");
      const pending = await one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status='pending'");
      return json({
        worker: cron.ts && Date.now() / 1000 - cron.ts < 7200 ? 'ok' : 'stale',
        cron_last: cron.ts ?? null,
        programs: programs.n ?? 0,
        parsed: parsed.n ?? 0,
        huntable: huntable.n ?? 0,
        queue: queue.n ?? 0,
        pending: pending.n ?? 0,
      });
    }

    case '/api/findings': {
      const rows = await env.DB.prepare(
        `SELECT f.id, f.title, f.severity, f.proof_state, f.status, COALESCE(a.value,'') AS target
         FROM findings f LEFT JOIN assets a ON a.id = f.asset_id
         WHERE f.proof_state = 'proven'
         ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
         LIMIT 50`,
      ).all();
      return json(rows.results ?? []);
    }

    case '/api/discovery': {
      const groups = await env.DB.prepare(
        'SELECT automation, COUNT(*) AS n FROM programs GROUP BY automation',
      ).all<{ automation: string; n: number }>();
      const counts: Record<string, number> = {};
      for (const g of groups.results ?? []) counts[g.automation] = g.n;
      const recent = await env.DB.prepare(
        "SELECT id, automation, reward, status FROM programs WHERE status='parsed' ORDER BY last_checked DESC LIMIT 25",
      ).all();
      return json({
        allowed: counts['allowed'] ?? 0,
        not_mentioned: counts['not_mentioned'] ?? 0,
        prohibited: counts['prohibited'] ?? 0,
        unknown: counts['unknown'] ?? 0,
        recent: recent.results ?? [],
      });
    }

    case '/api/watchlist': {
      const entries = await env.DB.prepare(
        'SELECT label, address, last_block, rules FROM watchlist ORDER BY label LIMIT 40',
      ).all<{ rules: string }>();
      const alerts = await env.DB.prepare(
        'SELECT rule, severity, payload, created_at FROM alerts ORDER BY created_at DESC LIMIT 25',
      ).all<{ rule: string; severity: string; payload: string }>();
      return json({
        entries: (entries.results ?? []).map((e) => ({ ...e, rules: safeParse<string[]>(e.rules, []) })),
        alerts: (alerts.results ?? []).map((a) => {
          const p = safeParse<{ detail?: string; block?: number }>(a.payload, {});
          return { rule: a.rule, severity: a.severity, detail: p.detail ?? '', block: p.block ?? 0 };
        }),
      });
    }

    case '/api/eval': {
      const row = await env.DB.prepare("SELECT value FROM kv WHERE key='eval_scoreboard'").first<{ value: string }>();
      return json(row?.value ? safeParse(row.value, {}) : {});
    }

    case '/api/ledger': {
      const { ok, detail } = await ledgerVerify(env);
      const count = await one<{ n: number }>('SELECT COUNT(*) AS n FROM ledger');
      const recent = await env.DB.prepare(
        'SELECT seq, kind, hash, ts FROM ledger ORDER BY seq DESC LIMIT 25',
      ).all();
      return json({ ok, detail, count: count.n ?? 0, recent: recent.results ?? [] });
    }

    // ── desk: read-only, desk_* tables only, GET only ──────────────────
    // There is intentionally no mutating desk endpoint and no arm control.
    // Live arming is `wrangler secret put` + the gates in desk/arming.ts,
    // because a web control that can start real trading is one leaked URL
    // away from an empty wallet.
    case '/api/desk': {
      const s = await deskStatus(env);
      return json({
        mode: s.mode,
        armed: s.armed,
        equity: s.equity,
        open_positions: s.open_positions,
        deployed_pct: s.deployed_pct,
        pnl_today: s.pnl_today,
        breaker_halted: s.breaker_halted,
        breaker_until: s.breaker_until,
        gates_unmet: s.gates_unmet,
        gates: s.gates,
        coverage_gaps: s.coverage_gaps,
        kills_today: s.kills_today,
        subrequests: s.subrequests,
      });
    }

    case '/api/desk/positions': {
      // No live quote on the API path: a dashboard read must not spend the
      // subrequest budget or fail when an exchange is down. The mark is the
      // last stored price, and `stale` says so.
      const rows = await env.DB.prepare(
        `SELECT mint, symbol, filled_usd, entry_price, confirmation_price, qty, stop_price, opened_at
         FROM desk_positions WHERE state='open' ORDER BY opened_at DESC LIMIT 50`,
      ).all<{
        mint: string;
        symbol: string | null;
        filled_usd: number;
        entry_price: number;
        confirmation_price: number | null;
        qty: number;
        stop_price: number;
        opened_at: number;
      }>();
      const positions = (rows.results ?? []).map((r) => {
        const entry =
          r.confirmation_price !== null ? (r.entry_price + r.confirmation_price) / 2 : r.entry_price;
        return {
          mint: r.mint,
          symbol: r.symbol ?? r.mint.slice(0, 6),
          size: r.filled_usd,
          entry,
          current: entry,
          pnl: 0,
          pnl_pct: 0,
          stop: r.stop_price,
          opened_at: r.opened_at,
        };
      });
      return json({ positions, stale: true });
    }

    case '/api/desk/kills': {
      const rows = await env.DB.prepare(
        'SELECT mint, symbol, reason, detail, ts, outcome FROM desk_kills ORDER BY ts DESC LIMIT 50',
      ).all<{ mint: string; symbol: string | null; reason: string; detail: string; ts: number; outcome: string }>();
      return json(
        (rows.results ?? []).map((r) => ({
          mint: r.mint,
          symbol: r.symbol ?? r.mint.slice(0, 6),
          reason_code: r.reason,
          detail: r.detail,
          ts: r.ts,
          outcome: r.outcome,
          snapshot_summary: r.detail.slice(0, 120),
        })),
      );
    }

    case '/api/desk/calib': {
      const { report, stored } = await latestCalibration(env);
      return json({
        stored,
        window_start: report.window_start,
        window_end: report.window_end,
        totals: report.totals,
        note: report.note,
        by_reason: report.rows.map((r) => ({
          reason_code: r.reason_code,
          description: r.description,
          kills: r.kills,
          n: r.measured,
          hit_rate: r.dodge_rate,
          false_negatives: r.false_negatives,
          thin: r.thin,
        })),
      });
    }

    default:
      return json({ error: 'unknown endpoint' }, 404);
  }
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ─────────────────────────────── helpers ───────────────────────────────

/** Parse DASH_ORIGIN into a set of exact origins. Empty/absent -> no origins. */
/**
 * Constant-time string compare, so a secret check cannot be timed byte by byte.
 * Length is compared first (which leaks length only, not content).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function dashOrigins(env: Env): string[] {
  return (env.DASH_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*');
}

/**
 * The `Access-Control-Allow-Origin` value for this request, or null.
 *
 * Echoing a single configured origin (never `*`) is deliberate: a wildcard would
 * let any page read the findings list and ledger once the URL leaks, and it also
 * forbids credentialed requests. An origin not on the list gets no header, which
 * the browser treats as a blocked response.
 */
function corsAllowOrigin(env: Env, req: Request): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  return dashOrigins(env).includes(origin) ? origin : null;
}

/** Wrap an /api response with the CORS headers this request is allowed. */
function withCors(env: Env, req: Request, res: Response): Response {
  const allow = corsAllowOrigin(env, req);
  if (!allow) return res;
  const out = new Response(res.body, res);
  out.headers.set('access-control-allow-origin', allow);
  out.headers.set('vary', 'origin');
  out.headers.set('access-control-allow-headers', 'authorization, content-type');
  out.headers.set('access-control-allow-methods', 'GET, OPTIONS');
  out.headers.set('access-control-max-age', '600');
  return out;
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Adapt D1 to the narrow interface dispatch.ts needs, so the approval -> hunt ->
 * dispatch flow can be tested against a real SQLite database instead of a mock.
 */
function d1Db(env: Env): DispatchDb {
  return {
    async first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
      return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
    },
    async run(sql: string, ...binds: unknown[]): Promise<void> {
      await env.DB.prepare(sql).bind(...binds).run();
    },
  };
}

void LlmUnavailable;
void parseJson;
void PolicyEngine;
void roeFromBrief;
void (null as unknown as Action);
void (null as unknown as Mut);
void (null as unknown as Brief);
