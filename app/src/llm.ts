/**
 * LLM router — one interface, many free providers, deterministic fallback.
 *
 * Order matters and is deliberate:
 *   1. local (your own GPU via the Sybil registry: tabbyapi / vLLM / Ollama)
 *   2. Venice (uncensored; the operator's own voice, not a filtered one)
 *   3. hosted free tiers (Gemini -> Groq -> OpenRouter -> Workers AI)
 *   4. give up loudly (never silently invent a finding)
 *
 * Every call is logged with prompt hash, tokens and latency so the eval loop
 * and the quota budgeter have real numbers to work with.
 */

export interface Env {
  DB: D1Database;
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  /**
   * Venice AI. OpenAI-compatible, and the only provider here that offers
   * genuinely uncensored models, so it is tried FIRST when present.
   */
  VENICE_API_KEY?: string;
  /** Override the Venice model. Default `venice-uncensored-1-2`. */
  VENICE_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  /**
   * Workers AI model. Comma-separated for a fallback chain, cheapest first.
   * Default is GLM 5.3 Flash - it is the strongest free model on the binding and
   * needs no API key at all.
   */
  AI_MODEL?: string;
  LLM_LOCAL_BASE?: string;
  LLM_LOCAL_MODEL?: string;
  DAILY_LLM_BUDGET?: string;
}

export interface Msg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AskOpts {
  maxTokens?: number;
  temperature?: number;
  /** Prefer the local model even if a hosted key exists. */
  localFirst?: boolean;
  /** Ask for strict JSON; most providers honour this. */
  json?: boolean;
}

export interface AskResult {
  text: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export class LlmUnavailable extends Error {}

const PROVIDERS = ['local', 'venice', 'gemini', 'groq', 'openrouter', 'workers-ai'] as const;

/**
 * The no-key fallback chain, strongest first. Both of the models the operator
 * asked for by name are on the binding: GLM 5.3 Flash and DeepSeek V4.1 Flash.
 * Order is quality-first because a weaker model that answers badly is worse here
 * than a slower one that reads the tools correctly.
 */
const DEFAULT_AI_MODELS = [
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/qwen/qwen3.8-27b',
  '@cf/meta/llama-3.1-8b-instruct-fast',
].join(',');

export async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function log(
  env: Env,
  provider: string,
  model: string,
  promptSha: string,
  r: Partial<AskResult>,
  ok: boolean,
  error?: string,
) {
  try {
    await env.DB.prepare(
      `INSERT INTO llm_log (id, ts, provider, model, prompt_sha, tokens_in, tokens_out, latency_ms, ok, error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        crypto.randomUUID(),
        Math.floor(Date.now() / 1000),
        provider,
        model,
        promptSha,
        r.tokensIn ?? 0,
        r.tokensOut ?? 0,
        r.latencyMs ?? 0,
        ok ? 1 : 0,
        error ?? null,
      )
      .run();
  } catch {
    // logging must never break the caller
  }
}

/** Rough token estimate; good enough for budgeting, costs nothing. */
export function approxTokens(s: string): number {
  return Math.ceil(s.length / 3.6);
}

/**
 * Budget check. Returns false when today's token allowance is spent, so the
 * caller degrades to deterministic-only instead of burning a paid overage.
 */
export async function budgetLeft(env: Env): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.DAILY_LLM_BUDGET ?? '200000');
  const row = await env.DB.prepare('SELECT used FROM quota WHERE day=? AND bucket=?')
    .bind(day, 'llm_tokens')
    .first<{ used: number }>();
  return (row?.used ?? 0) < cap;
}

export async function spendTokens(env: Env, n: number): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.DAILY_LLM_BUDGET ?? '200000');
  await env.DB.prepare(
    `INSERT INTO quota (day, bucket, used, cap) VALUES (?,?,?,?)
     ON CONFLICT(day, bucket) DO UPDATE SET used = used + excluded.used`,
  )
    .bind(day, 'llm_tokens', n, cap)
    .run();
}

async function callOpenAICompatible(
  base: string,
  key: string | undefined,
  model: string,
  msgs: Msg[],
  opts: AskOpts,
): Promise<AskResult> {
  const t0 = Date.now();
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: msgs,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 900,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`${base} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: j.choices?.[0]?.message?.content ?? '',
    provider: base.includes('googleapis')
      ? 'gemini'
      : base.includes('groq')
        ? 'groq'
        : base.includes('venice')
          ? 'venice'
          : 'openrouter',
    model,
    tokensIn: j.usage?.prompt_tokens ?? 0,
    tokensOut: j.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
  };
}

/**
 * Ask a model. Never throws for lack of a provider: the caller gets a clear
 * LlmUnavailable and must degrade to deterministic logic.
 */
export async function ask(env: Env, msgs: Msg[], opts: AskOpts = {}): Promise<AskResult> {
  const promptSha = await sha(msgs.map((m) => m.content).join('\u0000'));
  const errors: string[] = [];

  // The budget check is a courtesy, not a gate. It reads D1, and D1's free tier
  // has a DAILY ROW READ LIMIT that a busy desk can exceed - when it does, this
  // read throws, and before this guard existed that throw took the whole model
  // path down with it. A deployment that cannot read its own spending counter
  // must still be able to answer: the counter bounds cost, not correctness.
  let withinBudget = true;
  try {
    withinBudget = await budgetLeft(env);
  } catch (e) {
    errors.push(`budget check unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!withinBudget) {
    throw new LlmUnavailable('daily LLM budget exhausted; deterministic path only');
  }

  const attempts: (() => Promise<AskResult>)[] = [];

  if (env.LLM_LOCAL_BASE && env.LLM_LOCAL_MODEL) {
    attempts.push(async () => {
      const r = await callOpenAICompatible(env.LLM_LOCAL_BASE!, undefined, env.LLM_LOCAL_MODEL!, msgs, opts);
      return { ...r, provider: 'local' };
    });
  }
  // Venice first: it is the one provider that serves uncensored models, so it
  // gets the operator's prompt before anything else can answer it. The model is
  // overridable because "uncensored" and "smartest available" are different
  // trade-offs and the operator should be able to pick without a code change.
  if (env.VENICE_API_KEY) {
    attempts.push(() =>
      callOpenAICompatible(
        'https://api.venice.ai/api/v1',
        env.VENICE_API_KEY,
        env.VENICE_MODEL || 'venice-uncensored-1-2',
        msgs,
        opts,
      ),
    );
  }
  if (env.GEMINI_API_KEY) {
    attempts.push(() =>
      callOpenAICompatible(
        'https://generativelanguage.googleapis.com/v1beta/openai',
        env.GEMINI_API_KEY,
        env.GEMINI_MODEL || 'gemini-3.5-flash',
        msgs,
        opts,
      ),
    );
  }
  if (env.GROQ_API_KEY) {
    attempts.push(() =>
      callOpenAICompatible(
        'https://api.groq.com/openai/v1',
        env.GROQ_API_KEY,
        // Groq stopped serving llama-3.3-70b-versatile to free/dev tier on
        // 2026-08-16; gpt-oss-120b is their documented free replacement.
        env.GROQ_MODEL || 'openai/gpt-oss-120b',
        msgs,
        opts,
      ),
    );
  }
  if (env.OPENROUTER_API_KEY) {
    attempts.push(() =>
      callOpenAICompatible(
        'https://openrouter.ai/api/v1',
        env.OPENROUTER_API_KEY,
        // The :free llama slug was withdrawn; openrouter/free routes to a
        // model that is free RIGHT NOW instead of one that was free last year.
        env.OPENROUTER_MODEL || 'openrouter/free',
        msgs,
        opts,
      ),
    );
  }

  for (const attempt of attempts) {
    try {
      const r = await attempt();
      if (!r.text.trim()) throw new Error('empty completion');
      // Bookkeeping is best-effort for the same reason: a spend write that
      // fails must not discard an answer that already arrived.
      await log(env, r.provider, r.model, promptSha, r, true).catch(() => {});
      await spendTokens(env, r.tokensIn + r.tokensOut).catch(() => {});
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${msg}`);
      await log(env, 'unknown', 'unknown', promptSha, {}, false, msg).catch(() => {});
    }
  }

  // Workers AI LAST but *chained*: it is the only provider that needs no API
  // key, so it is the backstop that decides whether this deployment can think
  // at all. It used to be ONE hardcoded model - `@cf/meta/llama-3.1-8b-instruct`
  // - which Cloudflare deprecated on 2026-05-30, and that single stale id is
  // what made a fully-configured deployment answer "no model available". Each
  // model is tried in turn now, so one retired id costs a round trip instead of
  // the whole feature.
  //
  // GLM 5.3 Flash leads: free on the binding, 41.8 AA index, 1M context.
  const aiModels = (env.AI_MODEL || DEFAULT_AI_MODELS)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  if (env.AI) {
    for (const model of aiModels) {
      try {
        const t0 = Date.now();
        const out = (await env.AI.run(model, {
          messages: msgs,
          max_tokens: opts.maxTokens ?? 900,
        })) as { response?: string };
        const text = out.response ?? '';
        if (!text.trim()) throw new Error('empty completion');
        const tokensIn = msgs.reduce((n, m) => n + approxTokens(m.content), 0);
        const r: AskResult = {
          text,
          provider: 'workers-ai',
          model,
          tokensIn,
          tokensOut: approxTokens(text),
          latencyMs: Date.now() - t0,
        };
        await log(env, r.provider, r.model, promptSha, r, true).catch(() => {});
        await spendTokens(env, r.tokensIn + r.tokensOut).catch(() => {});
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`workers-ai ${model}: ${msg}`);
        await log(env, 'workers-ai', model, promptSha, {}, false, msg).catch(() => {});
      }
    }
  }

  throw new LlmUnavailable(`no model available: ${errors.join(' | ') || 'no providers configured'}`);
}

/** Parse JSON out of a model reply that may be fenced or chatty. */
export function parseJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const slice = candidate.slice(start);
  for (let end = slice.length; end > 0; end--) {
    try {
      return JSON.parse(slice.slice(0, end)) as T;
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

export const PROVIDER_ORDER = PROVIDERS;
