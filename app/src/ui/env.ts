/**
 * The narrow environment the Mini App needs, declared here rather than imported
 * from `index.ts` on purpose.
 *
 * `index.ts` imports this directory, so importing `Env` back out of `index.ts`
 * would create a module cycle. Declaring the structural subset we actually use
 * keeps the dependency one-way and lets a test hand a bare object to `uiRoute`
 * without constructing the whole Worker env.
 *
 * This is a STRUCTURAL subset: index.ts's own `Env` satisfies it as-is, so the
 * router branch can pass its `env` straight through with no cast.
 *
 * There is deliberately NO index signature. An index signature would make this
 * type unassignable from an interface (TypeScript does not synthesise one), so
 * the one thing it buys is the one thing it breaks.
 */
export interface UiEnv {
  DB: D1Database;
  /** Required for Mini App auth. Absent means every /api/ui/* call is refused. */
  TELEGRAM_BOT_TOKEN?: string;
  /**
   * The bot's PUBLIC @username, without the leading '@'.
   *
   * Only used to build the `https://t.me/<bot>?startapp` link the signed-out
   * screen offers. It is not derivable from the bot token (Telegram returns the
   * username from `getMe`, which is a network call), it is not a secret, and it
   * grants nothing: the link only opens the chat, and the link's absence
   * degrades the screen to instructions rather than to a dead button.
   */
  TELEGRAM_BOT_USERNAME?: string;
  /** Where a UI-initiated decision is ALSO announced, when configured. */
  TELEGRAM_CHAT_ID?: string;
  OPERATOR_NAME?: string;
  /** Workers AI fallback, consumed by llm.ts through the intake path. */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  LLM_LOCAL_BASE?: string;
  LLM_LOCAL_MODEL?: string;
  DAILY_LLM_BUDGET?: string;
  /** Kill switch read by intake-enrich.ts. */
  ASTERION_LLM_INTAKE?: string;
  /** Handed to dispatch.ts unchanged, so a UI approval dispatches exactly like a tap. */
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_REF?: string;
}

/** The subset dispatch.ts needs, pulled off UiEnv explicitly rather than cast. */
export function dispatchEnv(env: UiEnv): {
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_REF?: string;
} {
  const out: { GITHUB_DISPATCH_TOKEN?: string; GITHUB_REPO?: string; GITHUB_REF?: string } = {};
  if (env.GITHUB_DISPATCH_TOKEN !== undefined) out.GITHUB_DISPATCH_TOKEN = env.GITHUB_DISPATCH_TOKEN;
  if (env.GITHUB_REPO !== undefined) out.GITHUB_REPO = env.GITHUB_REPO;
  if (env.GITHUB_REF !== undefined) out.GITHUB_REF = env.GITHUB_REF;
  return out;
}

/**
 * Adapt D1 to the two-method surface dispatch.ts declares.
 *
 * This is a deliberate MIRROR of the private `d1Db()` in index.ts (which cannot
 * be exported without editing a line outside the two additive edits this change
 * is allowed to make). It is four lines of pure delegation with no logic to
 * diverge, and `tests/ui-parity.test.mjs` drives the real Telegram approval path
 * and the UI approval path against the same database and diffs the result.
 */
export function d1Db(env: UiEnv): {
  first<T>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<void>;
} {
  return {
    async first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
      return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
    },
    async run(sql: string, ...binds: unknown[]): Promise<void> {
      await env.DB.prepare(sql).bind(...binds).run();
    },
  };
}
