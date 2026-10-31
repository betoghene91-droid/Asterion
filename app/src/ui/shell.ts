/**
 * The Mini App HTTP surface. One entry point, called from a single new branch in
 * index.ts's fetch handler.
 *
 * Routes
 *   GET  /ui                 the shell (HTML)
 *   GET  /ui/ui.css          the shell's stylesheet
 *   GET  /ui/ui.js           the shell's script
 *   GET  /api/ui/session     who am I, and the navigation model      [initData]
 *   GET  /api/ui/catalog     playbooks + skill packs, by domain      [initData]
 *   GET  /api/ui/targets     the collected target inventory          [initData]
 *   GET  /api/ui/work        the approvals queue                     [initData]
 *   GET  /api/ui/history     past decisions, hunts and ledger kinds   [initData]
 *   POST /api/ui/engage      free text -> questions, or a brief       [initData]
 *   POST /api/ui/decide      approve / deny an approval               [initData]
 *
 * The shell itself is public: it is HTML whose only content is the navigation
 * model, which every caller is told anyway. Every piece of DATA is behind
 * initData auth.
 *
 * AUTH POSTURE
 *
 * Everything under /api/ui/ FAILS CLOSED on Telegram `initData`, verified with
 * the EXISTING `TELEGRAM_BOT_TOKEN`. No new secret, no BotFather step, no
 * Cloudflare variable. Unset token -> refuse. Missing initData -> refuse. Bad
 * signature -> refuse. Stale auth_date -> refuse.
 *
 * The existing /api/* routes are NOT touched and NOT reused for auth: this branch
 * is matched before `startsWith('/api/')` so `/api/ui/*` never reaches
 * `dashboardApi`, and the auth behaviour of every pre-existing route is
 * byte-identical (proved in `ui-parity.test.mjs` against a base-commit build).
 *
 * `initData` arrives in a REQUEST HEADER, never the query string: a query string
 * lands in access logs, `Referer` and browser history, and initData is a bearer
 * credential for the length of its freshness window.
 *
 * No CORS headers are emitted. The shell is served from this same Worker, so every
 * call it makes is same-origin; a missing ACAO means no other origin can read
 * these responses even if an endpoint URL leaks.
 *
 * NAVIGATION MODEL. The console is arranged by the KIND OF WORK, not by the
 * endpoint that happens to back it:
 *
 *   Hunt     compose a target; the compiler proposes the hunt
 *   Queue    the approvals that need a decision      (the highest-stakes surface)
 *   Ask      the follow-up questions the bot is waiting on
 *   Library  what this build can do, by domain
 *   Ops      everything the bot is watching, drilled into
 *
 * Ops is a tab rather than twelve, because a bottom bar has room for five
 * thumb-reachable destinations and a twelve-item bar is a menu with worse
 * ergonomics. The twelve read-only surfaces are all still there, one drill-down
 * deep, with the Telegram BackButton to come back.
 */

import { buildCatalog } from './catalog.js';
import { UI_ASSETS } from './embed.js';
import { describeFailure, validateInitData, type InitDataFail, type InitDataUser } from './initdata.js';
import type { UiEnv } from './env.js';
import { historyView, targetsView } from './ops.js';
import { compileEngagement, decideWork, listWork } from './work.js';

/** Header the shell presents the Telegram session in. */
export const INIT_DATA_HEADER = 'x-telegram-init-data';

export const UI_BASE_PATH = '/ui';
export const UI_CSS_PATH = '/ui/ui.css';
export const UI_JS_PATH = '/ui/ui.js';

/** Hard cap on a chat submission. intake.ts truncates notes at 2000 anyway. */
const MAX_TEXT_CHARS = 4_000;

/** A bottom-bar destination. */
export interface UiTab {
  id: string;
  label: string;
  glyph: string;
  auth: boolean;
  /** Which count, if any, belongs on this tab's badge. The shell fetches it. */
  badge: 'queue' | null;
}

/** A read-only surface listed inside Ops and opened by drill-down. */
export interface UiOpsView {
  id: string;
  label: string;
  glyph: string;
  /** An EXISTING, unmodified GET route. Never null here: the shell owns none. */
  route: string;
  auth: boolean;
  group: string;
}

/** The five destinations, in thumb order. */
export const UI_TABS: UiTab[] = [
  { id: 'hunt', label: 'Hunt', glyph: '\u25B6', auth: true, badge: null },
  { id: 'queue', label: 'Queue', glyph: '\u25A6', auth: true, badge: 'queue' },
  { id: 'ask', label: 'Ask', glyph: '\u270E', auth: true, badge: null },
  { id: 'library', label: 'Library', glyph: '\u2261', auth: true, badge: null },
  { id: 'ops', label: 'Ops', glyph: '\u2699', auth: false, badge: null },
];

/**
 * Everything under Ops, grouped. `auth: false` entries are the EXISTING open
 * /api/* routes and keep working even when the Telegram session is missing, so a
 * broken sign-in degrades the console to read-only instead of to nothing.
 */
export const UI_OPS: UiOpsView[] = [
  { id: 'targets', label: 'Targets', glyph: '\u25CE', route: '/api/ui/targets', auth: true, group: 'Inventory' },
  { id: 'discovery', label: 'Discovery', glyph: '\u2691', route: '/api/discovery', auth: false, group: 'Inventory' },
  { id: 'findings', label: 'Findings', glyph: '\u25C6', route: '/api/findings', auth: false, group: 'Evidence' },
  { id: 'history', label: 'History', glyph: '\u26D3', route: '/api/ui/history', auth: true, group: 'Evidence' },
  { id: 'ledger', label: 'Ledger', glyph: '\u26D3', route: '/api/ledger', auth: false, group: 'Evidence' },
  { id: 'watchlist', label: 'Watchlist', glyph: '\u2691', route: '/api/watchlist', auth: false, group: 'Evidence' },
  { id: 'desk', label: 'Desk', glyph: '\u26FD', route: '/api/desk', auth: false, group: 'Desk' },
  { id: 'positions', label: 'Positions', glyph: '\u25A4', route: '/api/desk/positions', auth: false, group: 'Desk' },
  { id: 'kills', label: 'Kills', glyph: '\u2715', route: '/api/desk/kills', auth: false, group: 'Desk' },
  { id: 'calibration', label: 'Calibration', glyph: '\u25CE', route: '/api/desk/calib', auth: false, group: 'Desk' },
  { id: 'status', label: 'Status', glyph: '\u2699', route: '/api/status', auth: false, group: 'System' },
  { id: 'eval', label: 'Eval', glyph: '\u25F1', route: '/api/eval', auth: false, group: 'System' },
];

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Asset lookup by EXACT filename. There is no path join anywhere in this
 * function, so `..%2f` and friends have nothing to traverse: an unknown name is
 * simply not found in the embedded list.
 */
function assetBody(name: string): { body: string; type: string } | null {
  const hit = UI_ASSETS.find((a) => a.name === name);
  return hit ? { body: hit.body, type: hit.contentType } : null;
}

function assetResponse(name: string): Response {
  const asset = assetBody(name);
  if (!asset) return new Response('asset not embedded', { status: 500 });
  return new Response(asset.body, {
    status: 200,
    headers: {
      'content-type': asset.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function serveShell(): Response {
  const html = assetBody('index.html');
  if (!html) return new Response('shell not embedded', { status: 500 });
  return new Response(html.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      /**
       * `frame-ancestors` and X-Frame-Options are deliberately ABSENT: Telegram
       * Desktop and web.telegram.org host a Mini App inside a frame, and either
       * directive would refuse to render there. Scripts stay same-origin except
       * telegram.org, which is where the host may inject its own SDK from.
       */
      'content-security-policy': [
        "default-src 'none'",
        "script-src 'self' https://telegram.org https://*.telegram.org",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  });
}

export type UiAuth =
  | { ok: true; user: InitDataUser | null; ageSeconds: number }
  | { ok: false; reason: InitDataFail; response: Response };

/**
 * The bot's public @username, or '' when the deployment does not publish one.
 *
 * Deliberately narrow: a username is only returned when it matches Telegram's
 * own shape for a bot (letters/digits/underscore, ending in "bot"), because it
 * is interpolated into a `t.me` link the console renders as an anchor. A
 * malformed value would become a broken or misleading link, and "no link" is a
 * supported state on the client.
 *
 * This is NOT an auth input and grants nothing. It exists so the signed-out
 * screen's one useful action can point at the real bot instead of being
 * hardcoded, which would be a link to nobody's bot.
 */
export function publicBotUsername(env: UiEnv): string {
  const raw = (env.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{2,30}[Bb][Oo][Tt]$/.test(raw) ? raw : '';
}

/**
 * The single auth gate. It returns EITHER the verified identity OR the exact
 * Response to send plus the machine-readable reason, so a caller cannot forget to
 * check it (the failure arm carries the response) and cannot accidentally leak a
 * coarse reason where a precise one is useful to its own operator.
 */
export async function requireUiAuth(env: UiEnv, req: Request): Promise<UiAuth> {
  const verdict = await validateInitData(req.headers.get(INIT_DATA_HEADER), env.TELEGRAM_BOT_TOKEN);

  if (!verdict.ok) {
    // 503 for "this Worker cannot authenticate anyone at all" (a deployment
    // fault) and 401 for "you did not prove who you are". Both fail closed; the
    // split only stops an operator hunting for a client-side fix to a missing
    // server secret.
    //
    // The body shape `{ ok:false, error:<machine reason>, message:<copy> }` is
    // IDENTICAL here and in the /api/ui/session arm, because the client branches
    // on `error` to decide which signed-out screen to render. `json()` already
    // sets cache-control: no-store on both, which is what stops a proxy or the
    // WebView cache from replaying a denial against a later, valid session.
    const status = verdict.reason === 'no_bot_token' ? 503 : 401;
    return {
      ok: false,
      reason: verdict.reason,
      response: json(
        { ok: false, error: verdict.reason, message: describeFailure(verdict.reason) },
        status,
      ),
    };
  }

  return { ok: true, user: verdict.user, ageSeconds: verdict.ageSeconds };
}

/**
 * The router. Always returns a Response: index.ts only calls it for paths it has
 * already matched, so there is no "not mine" arm to get wrong.
 */
export async function uiRoute(env: UiEnv, req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  // ── assets ───────────────────────────────────────────────────────────────
  if (path === UI_BASE_PATH || path === `${UI_BASE_PATH}/`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    return serveShell();
  }
  if (path === UI_CSS_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    return assetResponse('ui.css');
  }
  if (path === UI_JS_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    return assetResponse('ui.js');
  }

  // ── api ──────────────────────────────────────────────────────────────────
  if (!path.startsWith('/api/ui/')) return new Response('not found', { status: 404 });

  const auth = await requireUiAuth(env, req);

  if (path === '/api/ui/session') {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    // Session answers even when unauthenticated, so the shell can say WHY it is
    // not signed in instead of showing a bare 401 - and still render the
    // navigation, so the open /api/* surfaces under Ops remain reachable. It
    // carries no data of its own.
    //
    // `bot` is the PUBLIC username the signed-out screen uses to build its
    // "Reopen in Telegram" link. It is sent in BOTH arms: the signed-out arm is
    // precisely the one that needs it, and a public @username that any visitor
    // can read off t.me is not a disclosure. It is absent (never invented) when
    // the deployment does not configure it.
    const bot = publicBotUsername(env);
    if (!auth.ok) {
      return json({
        ok: false,
        signedIn: false,
        reason: auth.reason,
        message: describeFailure(auth.reason),
        bot: bot || null,
        tabs: UI_TABS,
        ops: UI_OPS,
      });
    }
    const counts = await queueCounts(env);
    return json({
      ok: true,
      signedIn: true,
      operator: env.OPERATOR_NAME ?? 'operator',
      user: auth.user,
      sessionAgeSeconds: auth.ageSeconds,
      bot: bot || null,
      tabs: UI_TABS,
      ops: UI_OPS,
      counts,
    });
  }

  if (!auth.ok) return auth.response;

  if (path === '/api/ui/catalog') {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    return json({ ok: true, ...buildCatalog(env) });
  }

  if (path === '/api/ui/targets') {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    return json({ ok: true, ...(await targetsView(env)) });
  }

  if (path === '/api/ui/work') {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    return json({ ok: true, ...(await listWork(env)) });
  }

  if (path === '/api/ui/history') {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    return json({ ok: true, ...(await historyView(env)) });
  }

  if (path === '/api/ui/engage') {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    const body = await readJson(req);
    if (!body.ok) return json({ ok: false, error: body.error }, 400);

    const text = typeof body.value['text'] === 'string' ? body.value['text'].trim() : '';
    if (!text) return json({ ok: false, error: 'empty', message: 'Nothing to compile.' }, 400);
    if (text.length > MAX_TEXT_CHARS) {
      return json(
        { ok: false, error: 'too_long', message: `Keep it under ${MAX_TEXT_CHARS} characters.` },
        413,
      );
    }

    try {
      const result = await compileEngagement(env, text, {}, readAnswers(body.value['answers']));
      return json({ ok: true, text, ...result });
    } catch (e) {
      console.error('ui engage failed', e);
      return json({ ok: false, error: 'compile_failed', message: (e as Error).message }, 500);
    }
  }

  if (path === '/api/ui/decide') {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    const body = await readJson(req);
    if (!body.ok) return json({ ok: false, error: body.error }, 400);

    const id = typeof body.value['id'] === 'string' ? body.value['id'] : '';
    const decision = body.value['decision'];
    if (!id) return json({ ok: false, error: 'missing_id' }, 400);
    if (decision !== 'approve' && decision !== 'deny') {
      return json(
        { ok: false, error: 'bad_decision', message: 'decision must be approve or deny' },
        400,
      );
    }

    try {
      const result = await decideWork(env, id, decision === 'approve', env.OPERATOR_NAME ?? 'operator');
      return json({ ok: true, decision, id, ...result });
    } catch (e) {
      console.error('ui decide failed', id, e);
      return json({ ok: false, error: 'decide_failed', message: (e as Error).message }, 500);
    }
  }

  return json({ ok: false, error: 'unknown_endpoint' }, 404);
}

/**
 * The badge counts the session hands the shell so the tab bar is correct on first
 * paint. Deliberately one cheap query each, and a failure is not fatal: a missing
 * badge must never stop the console from opening.
 */
async function queueCounts(env: UiEnv): Promise<{ pending: number; proven: number }> {
  const one = async <T>(sql: string) => {
    try {
      return (await env.DB.prepare(sql).first<T>()) ?? ({} as T);
    } catch {
      return {} as T;
    }
  };
  const pending = await one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status='pending'");
  const proven = await one<{ n: number }>("SELECT COUNT(*) AS n FROM findings WHERE proof_state='proven'");
  return { pending: pending.n ?? 0, proven: proven.n ?? 0 };
}

function methodNotAllowed(allow: string): Response {
  return new Response('method not allowed', { status: 405, headers: { allow } });
}

async function readJson(
  req: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, error: 'bad_json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'bad_json' };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

/**
 * Only the four keys intake.ts can act on survive. An unknown key is dropped
 * rather than forwarded, so the UI cannot widen the compiler's input surface.
 */
function readAnswers(raw: unknown): Partial<Record<string, string>> {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<Record<string, string>> = {};
  // 'chain' is here because work.ts asks for it ABOVE the authorization gate and
  // intake.ts:compile reads it as answers.chain. Leaving it out silently discarded
  // the operator's chain tap - the button rendered, the tap posted, and the server
  // ignored it, which re-created the dead end one layer deeper.
  for (const k of ['target', 'class', 'depth', 'confirm', 'chain'] as const) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 300);
  }
  return out;
}
