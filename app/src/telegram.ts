/**
 * Telegram interface — the cockpit.
 *
 * Two rules shape every screen:
 *   1. The operator never has to compose a prompt. Buttons first, text second.
 *   2. Silence is a feature. Only proven, in-scope, above-floor findings push.
 *
 * Visual language: monospace cards, unicode bars, severity glyphs. It reads like
 * a terminal because you will be looking at it at 2am on a phone.
 */

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  OPERATOR_NAME?: string;
  ALERT_FLOOR?: string;
}

export type Btn = {
  text: string;
  /**
   * Omitted ONLY by the Mini App button below. Telegram's InlineKeyboardButton
   * requires exactly one action field, and `callback_data` combined with
   * `web_app` makes the button silently inert - it renders and does nothing when
   * tapped. Every existing button still sets this, so the widening is invisible
   * to them; `send()` and `editText()` pass the object straight through to
   * `reply_markup.inline_keyboard`, and `JSON.stringify` drops an undefined value.
   */
  callback_data?: string;
  /**
   * Opens the Mini App in Telegram with a signed `initData` payload. Needs an
   * absolute https URL, which a Worker cannot know on its own - see
   * `setWebAppOrigin` below.
   */
  web_app?: { url: string };
};

export const SEV = {
  critical: { glyph: '\u25C6', label: 'CRIT' },
  high: { glyph: '\u25B2', label: 'HIGH' },
  medium: { glyph: '\u25A0', label: 'MED' },
  low: { glyph: '\u25BC', label: 'LOW' },
  info: { glyph: '\u25CB', label: 'INFO' },
} as const;

export type Sev = keyof typeof SEV;

/** 10-cell unicode bar. Reads at a glance on a small screen. */
export function bar(frac: number, cells = 10): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * cells);
  return '\u2588'.repeat(full) + '\u2591'.repeat(cells - full);
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sevLine(sev: Sev, title: string): string {
  const { glyph, label } = SEV[sev];
  return `${glyph} <b>${label}</b>  ${esc(title)}`;
}

export function rule(n = 22): string {
  return `<code>${'\u2500'.repeat(n)}</code>`;
}

/**
 * The Mini App's public origin, recorded from the incoming request URL.
 *
 * A `web_app` button needs an absolute https URL and a Worker has no binding that
 * tells it its own hostname. The one place that is always available is the
 * request the webhook arrived on, so `index.ts` records `url.origin` when a
 * request comes in for the Worker's own paths - see the additive branch in its
 * fetch handler. Nothing else reads this and nothing else writes it.
 *
 * It is a module-level value because `KEYBOARDS.main()` takes no arguments today
 * and this change may not alter its signature or any existing call site.
 */
let webAppOrigin: string | null = null;

/**
 * Record the origin the Mini App is reachable at. Only a bare https origin is
 * accepted: a value with a path, a scheme we will not serve, or anything that
 * does not look like one host is dropped, because an unusable URL here would
 * produce a button Telegram refuses and take the WHOLE keyboard down with it.
 */
export function setWebAppOrigin(origin: string): void {
  const candidate = origin.replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(candidate)) webAppOrigin = candidate;
}

/** The Mini App URL, or null when the origin has not been observed yet. */
export function webAppUrl(): string | null {
  return webAppOrigin ? `${webAppOrigin}/ui` : null;
}

export const KEYBOARDS = {
  main: (): Btn[][] => [
    [
      { text: '\u25B6  Start a hunt', callback_data: 'hunt:new' },
      { text: '\u2261  Playbooks', callback_data: 'pb:list' },
    ],
    [
      { text: '\u2691  Watchlist', callback_data: 'wl:list' },
      { text: '\u2691  Approvals', callback_data: 'ap:list' },
    ],
    [
      { text: '\u25A6  Queue', callback_data: 'q:list' },
      { text: '\u2699  Status', callback_data: 'st:show' },
    ],
    [{ text: '\u2691  Discovery', callback_data: 'disc:list' }, { text: '\u2691  Briefing', callback_data: 'br:daily' }],
    [{ text: '\u25A6  Corpus', callback_data: 'corp:list' }],
    // One new entry, one row. The Mini App is additive: before the Worker has
    // seen a request it cannot build an absolute URL, and a web_app button with
    // an empty url is rejected by Telegram - which would break this entire
    // keyboard, not just the new button. So the row is OMITTED until then, and
    // the array is byte-identical to the pre-Mini-App keyboard on that path.
    ...(webAppUrl() ? ([[{ text: '\u25A6  Console', web_app: { url: webAppUrl() as string } }]] as Btn[][]) : []),
  ],
  back: (): Btn[][] => [[{ text: '\u2190  Menu', callback_data: 'm:main' }]],
};

export async function tg(env: Env, method: string, body: Record<string, unknown>): Promise<unknown> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok?: boolean; description?: string };
  if (!res.ok || !j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
  return j;
}

export async function send(
  env: Env,
  text: string,
  keyboard?: Btn[][],
  chatId?: number | string,
): Promise<void> {
  const chat = chatId ?? env.TELEGRAM_CHAT_ID;
  if (!chat) throw new Error('no chat id');
  await tg(env, 'sendMessage', {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function answerCb(env: Env, id: string, text?: string): Promise<void> {
  await tg(env, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
}

export async function editText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: Btn[][],
): Promise<void> {
  await tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

/** Authorising a chat: first sender becomes the operator, everyone else ignored. */
export async function authorizeChat(env: Env, chatId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key='operator_chat' ").first<{
    value: string;
  }>();
  if (!row) {
    await env.DB.prepare("INSERT INTO kv (key,value) VALUES ('operator_chat',?)")
      .bind(String(chatId))
      .run();
    return true;
  }
  return row.value === String(chatId);
}

export async function guard(env: Env, chatId: number): Promise<boolean> {
  if (env.TELEGRAM_CHAT_ID && String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return false;
  return authorizeChat(env, chatId);
}

// ── screens ───────────────────────────────────────────────────────────────

export function homeScreen(name: string): string {
  return [
    `<b>ASTERION</b>  <i>v1</i>`,
    rule(),
    `operator   <b>${esc(name)}</b>`,
    `mode       read-only until you approve`,
    rule(),
    `<i>Tap a button. You never have to write a prompt.</i>`,
  ].join('\n');
}

export function statusScreen(s: {
  worker: string;
  crawled: number;
  programs: number;
  watch: number;
  queue: number;
  pending: number;
  llmTokens: number;
  llmCap: number;
  lastSentinel: number | null;
}): string {
  const ago = s.lastSentinel ? Math.round((Date.now() / 1000 - s.lastSentinel) / 60) : null;
  return [
    `<b>STATUS</b>`,
    rule(),
    `worker       ${s.worker === 'ok' ? '\u25CF alive' : '\u25CB stale'}`,
    `sentinel     ${ago === null ? 'never' : ago + ' min ago'}`,
    `programs     ${s.programs}  <i>(${s.crawled} parsed)</i>`,
    `watchlist    ${s.watch}`,
    `queue        ${s.queue} findings`,
    `approvals    ${s.pending} waiting`,
    rule(),
    `llm budget   ${bar(s.llmTokens / Math.max(1, s.llmCap))} ${s.llmTokens}/${s.llmCap}`,
  ].join('\n');
}

export function findingCard(f: {
  id: string;
  sev: Sev;
  title: string;
  target: string;
  proof: string;
  confidence: string;
}): string {
  return [
    sevLine(f.sev, f.title),
    rule(),
    `target   <code>${esc(f.target)}</code>`,
    `proof    <b>${esc(f.proof)}</b>`,
    `conf     ${esc(f.confidence)}`,
    `id       <code>${f.id}</code>`,
  ].join('\n');
}
