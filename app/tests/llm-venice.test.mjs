/**
 * Venice provider wiring.
 *
 * The operator asked for an uncensored model. That is a routing property, not a
 * prompt property: it only holds if the uncensored provider is actually
 * consulted before the filtered ones, and if the model name is overridable
 * without a code change. These tests pin both, and they mock `fetch` so they
 * prove routing rather than making a live call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { ask, PROVIDER_ORDER } = await import('../build/llm.js');

// Tests run in ONE process, so a stubbed fetch leaks into every other test file
// unless it is put back. Restoring the real one after each test is the whole
// reason this hook exists: a leaked mock silently breaks unrelated suites.
const REAL_FETCH = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Minimal fake D1 that satisfies budgetLeft/spendTokens/log. */
function fakeEnv(extra = {}) {
  const state = { used: 0 };
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('FROM quota')) return { used: state.used };
                return null;
              },
              async run() {
                if (sql.includes('llm_tokens')) state.used += Number(args[2] ?? 0);
                return { success: true };
              },
            };
          },
        };
      },
    },
    DAILY_LLM_BUDGET: '200000',
    ...extra,
  };
  return { env, state };
}

const ok = (text) => ({
  ok: true,
  async json() {
    return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  },
});

test('venice is consulted before every filtered provider', () => {
  const order = [...PROVIDER_ORDER];
  const vi = order.indexOf('venice');
  assert.ok(vi > -1, 'venice must be a known provider');
  // Uncensored first: it must outrank gemini/groq/openrouter.
  assert.ok(vi < order.indexOf('gemini'), 'venice must be tried before gemini');
  assert.ok(vi < order.indexOf('groq'), 'venice must be tried before groq');
  assert.ok(vi < order.indexOf('openrouter'), 'venice must be tried before openrouter');
});

test('a venice key short-circuits: no other provider is called', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return ok('answer from venice');
  };
  const { env } = fakeEnv({ VENICE_API_KEY: 'k', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
  const r = await ask(env, [{ role: 'user', content: 'hi' }]);
  assert.equal(r.text, 'answer from venice');
  assert.equal(r.provider, 'venice');
  assert.equal(calls.length, 1, 'only one provider should be contacted');
  assert.match(calls[0], /api\.venice\.ai/);
});

test('the default model is the uncensored one, and it is overridable', async () => {
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return ok('x');
  };
  {
    const { env } = fakeEnv({ VENICE_API_KEY: 'k' });
    await ask(env, [{ role: 'user', content: 'hi' }]);
    assert.equal(body.model, 'venice-uncensored-1-2');
  }
  {
    // The operator can point at a different model without a redeploy of code.
    const { env } = fakeEnv({ VENICE_API_KEY: 'k', VENICE_MODEL: 'qwen3-235b-a22b-instruct-2507' });
    await ask(env, [{ role: 'user', content: 'hi' }]);
    assert.equal(body.model, 'qwen3-235b-a22b-instruct-2507');
  }
});

test('a failing venice falls through instead of failing the turn', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('venice')) return { ok: false, status: 500, async text() { return 'boom'; } };
    return ok('answer from gemini');
  };
  const { env } = fakeEnv({ VENICE_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  const r = await ask(env, [{ role: 'user', content: 'hi' }]);
  // One provider being down must never make the operator's turn fail.
  assert.equal(r.text, 'answer from gemini');
  assert.equal(r.provider, 'gemini');
  assert.ok(seen.some((u) => u.includes('venice')), 'venice must be attempted first');
});
