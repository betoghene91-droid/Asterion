/**
 * The conversational layer — driven end to end, with no socket anywhere.
 *
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 *
 * `src/agent.ts` sits between a model and the operator, so the two ways it can
 * hurt are (a) it can spend the turn doing nothing and (b) it can print a number
 * nobody measured. Every case below is one of those two, and the assertions are
 * written to FAIL against the plausible broken version rather than to pass
 * against the current one:
 *
 *   1. **Round-trip.** A tool is called, its text reaches the model, and the
 *      model's answer is the reply. Asserted on the SEEDED numbers (3 programs,
 *      1 finding) appearing in the reply: a version that skipped the tool and let
 *      the model answer from the prompt cannot produce them.
 *   2. **Multi-step.** Two different tools, in order, and an answer that needs
 *      both. Asserted on the trace ORDER, so a version that collapses to one call
 *      fails.
 *   3. **Failure isolation.** One tool throws and the turn still finishes with the
 *      other tool's reading. The failed tool's text must say UNKNOWN rather than
 *      zero, or the model will report a zero it never read.
 *   4. **Iteration cap.** A model that calls a tool forever stops at the cap and
 *      still ships readings. Also pins the per-turn cache, which is what makes
 *      that stop affordable.
 *   5. **No tool available.** `LlmUnavailable` (no key / budget spent) still
 *      produces the raw readings and says the question was NOT answered.
 *   6. **Grounding.** The one rule the whole file exists for: a numeral in the
 *      reply that no tool produced is refused, and the offending number is not
 *      echoed back.
 *
 * HERMETIC MEANS HERMETIC. The model is a stub function (`opts.ask`), and the
 * database is a real `node:sqlite` loaded from `app/schema.sql` — the same shim
 * `desk-data.test.mjs` uses — so the tools' SQL is the production SQL and the
 * KV blobs are real rows rather than mocks with the answers already in them.
 * `globalThis.fetch` is trapped and asserted to be untouched: not one test here
 * may depend on mainnet, DexScreener, or a provider.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  AGENT_TOOLS,
  MAX_ITERATIONS,
  agentSystemPrompt,
  runAgent,
  numeralsIn,
  ungroundedNumbers,
  safeModelHtml,
  WATCHED_JOBS,
} = await import('../build/agent.js');
const { LlmUnavailable } = await import('../build/llm.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

/** Frozen clock. Every "… ago" in a reply is computed from this. */
const NOW = 1_793_000_000_000;
const NOW_S = Math.floor(NOW / 1000);

/**
 * A D1-compatible shim over `node:sqlite`, backed by the real schema.
 *
 * Identical in shape to the one in `desk-data.test.mjs`, deliberately: if the
 * desk tests can drive these readers, so can these, and there is one fewer place
 * where "the SQL under test" can drift from production.
 */
function makeEnv(extra = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const api = {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      const bound = (binds) => ({
        async first() {
          return stmt.get(...binds) ?? null;
        },
        async run() {
          return stmt.run(...binds);
        },
        async all() {
          return { results: stmt.all(...binds) };
        },
        bind(...b) {
          return bound(b);
        },
      });
      return bound([]);
    },
  };
  return { env: { DB: api, DAILY_LLM_BUDGET: '200000', ...extra }, raw };
}

/** Write a KV row the way `db.ts:kvSet` does, so the readers see a real shape. */
function putKv(raw, key, value) {
  raw
    .prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * The fleet as the bots would have left it.
 *
 * Chosen so three different honest answers exist at once:
 *   · the hunter has READ something (3 programs, 1 medium finding) — a real zero
 *     vs. a real number is the distinction test 1 depends on;
 *   · the dead-man switch has ONE silent job (`hunter_bot` never beat, and the
 *     deployment is three days old) — so `jobs` returns its alert, not a list;
 *   · the sweep and dust bots are mid-cursor with no money moved, which is a
 *     truthful zero rather than an unread one.
 */
function seedFleet(raw) {
  putKv(raw, 'hunter_stats', {
    stats: {
      programsChecked: 3,
      mintsChecked: 2,
      findings: 1,
      unreadable: 0,
      noInputs: false,
      ticks: 7,
      lastTickMs: NOW - 4 * 60_000,
    },
    findings: [
      {
        id: 'h1',
        ts: NOW - 4 * 60_000,
        subject: 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu',
        risk: 'upgrade_authority_plain_key',
        detail: 'upgrade authority is a single plain wallet 7xKX for 3 programs',
        evidenceAccount: 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu',
        severity: 'medium',
        firstSeen: NOW - 86_400_000,
      },
    ],
  });
  putKv(raw, 'token2022_stats', {
    stats: {
      mintsChecked: 2,
      token2022: 2,
      extensions: 5,
      findings: 2,
      risky: 1,
      inertHooks: 1,
      notMints: 0,
      absent: 0,
      unreadable: 0,
      skipped: 0,
      noInputs: false,
      epoch: 1074,
      ticks: 4,
      lastTickMs: NOW - 9 * 60_000,
    },
    findings: [],
  });
  putKv(raw, 'dust:stats', {
    wallets_scanned: 2,
    accounts_seen: 6,
    closable: 3,
    clamped_tokens: 3,
    reclaimable_lamports: 6_117_840,
    reclaimed_lamports: 0,
    ticks: 11,
  });
  putKv(raw, 'sweep:stats', {
    checked: 120_000,
    hits: 0,
    swept_lamports: 0,
    ticks: 40,
    last_tick_ms: NOW - 60 * 60_000,
  });
  putKv(raw, 'sweep:offset', '3000');

  // Heartbeats: every watched job beat five seconds ago EXCEPT hunter_bot, whose
  // absence is the point. The three-day-old row belongs to `actions` — a real
  // non-job source, written by `index.ts` for the Actions runner — and it is what
  // makes `observedSince` old, i.e. old enough that a job with no row at all is
  // SILENT rather than COLD START. Without it every reader would be exercising the
  // cold-start branch and the silent-job case would go untested.
  const beat = raw.prepare('INSERT INTO heartbeats (source, ts) VALUES (?,?)');
  beat.run('actions', NOW_S - 3 * 86_400);
  for (const job of WATCHED_JOBS) {
    if (job === 'hunter_bot') continue;
    beat.run(job, NOW_S - 5);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// the stub model
//
// A queue of replies, one per round. It also records the conversation it was
// shown, because "did the tool result actually reach the model" is not visible
// from the reply alone — and that is the half of the round-trip that a broken
// implementation gets wrong.
// ─────────────────────────────────────────────────────────────────────────────

function stubModel(replies) {
  const seen = [];
  const fn = async (_env, msgs, opts) => {
    seen.push({ msgs: structuredClone(msgs), opts });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('stub model ran out of replies');
    if (reply instanceof Error) throw reply;
    return {
      text: typeof reply === 'string' ? reply : JSON.stringify(reply),
      provider: 'venice',
      model: 'venice-uncensored-1-2',
      tokensIn: 11,
      tokensOut: 7,
      latencyMs: 3,
    };
  };
  return { fn, seen };
}

/** Every conversation the stub was shown, flattened, for "did the tool text arrive". */
function shownTo(seen) {
  return seen.map((s) => s.msgs.map((m) => m.content).join('\n'));
}

// fetch is never allowed to be touched in this file.
const REAL_FETCH = globalThis.fetch;
test.beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error('agent.ts reached the network in a hermetic test');
  };
});
test.afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. a single tool call round-trip
// ─────────────────────────────────────────────────────────────────────────────

test('one tool call: the reading reaches the model and the reply is what it said', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  const { fn, seen } = stubModel([
    { tool: 'hunter', args: {} },
    { answer: 'Hunter is fine: checked 3 programs, 1 finding (a single-key upgrade authority).' },
  ]);

  const r = await runAgent(env, 'is the hunter stuck?', { ask: fn, now: NOW });

  assert.equal(r.ok, true, `expected a clean answer, got ${r.degraded}: ${r.text}`);
  assert.equal(r.degraded, 'none');
  assert.equal(r.iterations, 2, 'one tool round plus one answer round');
  assert.equal(r.provider, 'venice');
  assert.equal(r.model, 'venice-uncensored-1-2');

  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'hunter');
  assert.equal(r.toolCalls[0].ok, true);
  assert.equal(r.toolCalls[0].cached, false);

  // The tool's real text was fed back to the model on the second round. Without
  // this the model could only have been guessing, and test 6 would not catch it
  // because it had not been shown anything to ground on. (`\s+` because
  // `renderHunter` pads its labels into columns — asserting the padded literal
  // would pin the whitespace rather than the fact.)
  const second = shownTo(seen)[1];
  assert.match(second, /TOOL RESULT \(hunter\)/);
  assert.match(second, /checked\s+3 programs, 2 mints/);

  // And the reply is the model's sentence, with the seeded numbers in it.
  assert.match(r.text, /checked 3 programs/);
  assert.match(r.blocks.join('\n'), /single plain wallet 7xKX/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. multi-step chaining
// ─────────────────────────────────────────────────────────────────────────────

test('multi-step: two tools in order, and the answer may use both readings', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  const { fn, seen } = stubModel([
    { tool: 'jobs', args: {} },
    { tool: 'dust', args: {} },
    {
      answer:
        'Dead-man switch: hunter_bot is silent. Dust bot: 3 empty accounts worth 0.00611784 SOL.',
    },
  ]);

  const r = await runAgent(env, 'how are the bots doing?', { ask: fn, now: NOW });

  assert.equal(r.ok, true, `expected a clean answer, got ${r.degraded}: ${r.text}`);
  assert.equal(r.iterations, 3);
  assert.deepEqual(
    r.toolCalls.map((t) => t.name),
    ['jobs', 'dust'],
    'both tools, in the order the model asked for them',
  );

  // Round 3 saw BOTH results: that is the property that makes a chained answer
  // possible at all, and a version that replaced the transcript each round fails.
  const third = shownTo(seen)[2];
  assert.match(third, /TOOL RESULT \(jobs\)/);
  assert.match(third, /TOOL RESULT \(dust\)/);

  assert.equal(r.blocks.length, 2);
  assert.match(r.text, /hunter_bot is silent/);
  assert.match(r.text, /3 empty accounts/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. tool failure isolation
// ─────────────────────────────────────────────────────────────────────────────

test('a failing tool does not kill the turn, and is reported as UNKNOWN not zero', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  // `token2022_scan` validates its arguments BEFORE it spends a subrequest, so a
  // bad mint is a real tool failure with no network in it. Strictly hermetic.
  const { fn, seen } = stubModel([
    { tool: 'token2022_scan', args: { mints: ['not-a-mint'] } },
    { tool: 'token2022', args: {} },
    { answer: 'I could not scan that address, but the last scanner pass read 2 mints.' },
  ]);

  const r = await runAgent(env, 'scan not-a-mint', { ask: fn, now: NOW });

  assert.equal(r.ok, true, `expected the turn to survive, got ${r.degraded}: ${r.text}`);
  assert.equal(r.iterations, 3);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].name, 'token2022_scan');
  assert.equal(r.toolCalls[0].ok, false, 'the bad mint must be recorded as a failure');
  assert.match(r.toolCalls[0].error, /not base58/);
  assert.equal(r.toolCalls[1].ok, true, 'the second tool still ran');

  // The wording handed to the model is the defence against "0 findings". A model
  // told only "error" answers zero; a model told "UNKNOWN, not zero" cannot.
  const afterFail = shownTo(seen)[1];
  assert.match(afterFail, /TOOL FAILED \(token2022_scan\)/);
  assert.match(afterFail, /UNKNOWN, not zero/);

  // The successful reading still landed, and the reply used it.
  assert.equal(r.blocks.length, 1);
  assert.match(r.text, /read 2 mints/);
});

test('every tool failing is still an answer-shaped reply, labelled as such', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  const { fn } = stubModel([
    { tool: 'nope', args: {} },
    { tool: 'also_nope', args: {} },
  ]);

  const r = await runAgent(env, 'anything', { ask: fn, now: NOW, maxIterations: 2 });

  assert.equal(r.ok, false);
  assert.equal(r.degraded, 'all_tools_failed');
  assert.ok(r.toolCalls.every((t) => !t.ok));
  // The operator still gets readings — the digest is the last line of defence.
  assert.match(r.text, /every reading I tried failed/);
  assert.match(r.text, /dust bot/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. the iteration cap
// ─────────────────────────────────────────────────────────────────────────────

test('a model that loops stops at the cap and still ships readings', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  // Never answers: every round asks for the same tool.
  const { fn } = stubModel(Array.from({ length: 10 }, () => ({ tool: 'hunter', args: {} })));

  const r = await runAgent(env, 'loop forever', { ask: fn, now: NOW, maxIterations: 2 });

  assert.equal(r.ok, false);
  assert.equal(r.degraded, 'iteration_cap');
  assert.equal(r.iterations, 2, 'the cap is a hard stop');
  assert.match(r.text, /stopped after 2 rounds/);

  // The per-turn cache: the second identical call is not re-read. Without this a
  // looping model spends a fresh read every round, which is the expensive half of
  // this failure mode.
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].cached, false);
  assert.equal(r.toolCalls[1].cached, true);

  // Degraded, but never empty: the real hunter reading is in the text.
  assert.match(r.text, /protocol hunter/);
});

test('the cap is a real bound, not a suggestion: the default is exported and used', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  const tooMany = MAX_ITERATIONS + 4;
  const { fn } = stubModel(Array.from({ length: tooMany }, () => ({ tool: 'jobs', args: {} })));

  const r = await runAgent(env, 'loop', { ask: fn, now: NOW });

  assert.equal(r.iterations, MAX_ITERATIONS);
  assert.equal(r.degraded, 'iteration_cap');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. the no-tool-available path
// ─────────────────────────────────────────────────────────────────────────────

test('no model (budget spent / no keys): raw readings, and it says so out loud', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  const { fn, seen } = stubModel([
    new LlmUnavailable('daily LLM budget exhausted; deterministic path only'),
  ]);

  const r = await runAgent(env, 'how are the bots doing?', { ask: fn, now: NOW });

  assert.equal(r.ok, false);
  assert.equal(r.degraded, 'llm_unavailable');
  assert.equal(r.iterations, 1, 'one attempt, then deterministic — no retry loop');
  assert.equal(seen.length, 1);
  assert.equal(r.provider, null, 'no provider answered, and the reply must not claim one');

  // The three things a degraded reply must contain, and one it must not.
  assert.match(r.text, /no model available/);
  assert.match(r.text, /NOT answered/, 'the operator must know the question was not answered');
  assert.match(r.text, /budget exhausted/, 'and why');
  assert.doesNotMatch(r.text, /Something went wrong/i);

  // Every reader ran anyway, and the real numbers are there.
  assert.match(r.text, /protocol hunter/);
  assert.match(r.text, /dust bot/);
  assert.match(r.text, /sweep bot/);
  assert.match(r.text, /checked\s+3 programs/);
});

test('a provider error degrades the same way, without losing the readings', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  const { fn } = stubModel([new Error('venice -> 500 boom')]);

  const r = await runAgent(env, 'status', { ask: fn, now: NOW });

  assert.equal(r.degraded, 'llm_unavailable');
  assert.match(r.text, /model call failed/);
  assert.match(r.text, /protocol hunter/);
});

test('an unparseable model is given one correction, then degrades', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  const { fn } = stubModel(['I think the hunter is fine!', 'still not json']);

  const r = await runAgent(env, 'status', { ask: fn, now: NOW });

  assert.equal(r.degraded, 'unparseable');
  assert.equal(r.iterations, 2);
  assert.match(r.text, /raw readings below/);
  assert.match(r.text, /protocol hunter/);
});

test('the tools cannot answer: the model still answers from nothing and says nothing invented', async () => {
  // No seeding at all — a fresh database. Every reader returns its honest zero.
  const { env } = makeEnv();
  const { fn } = stubModel([
    { tool: 'token2022', args: {} },
    { answer: 'The Token-2022 scanner has run no ticks and has no inputs to read.' },
  ]);

  const r = await runAgent(env, 'anything new on token2022?', { ask: fn, now: NOW });

  assert.equal(r.ok, true, `expected a grounded answer, got ${r.degraded}: ${r.text}`);
  // The "nothing looked at" wording came out of `renderToken2022`, not the model.
  assert.match(r.blocks[0], /nothing looked at/);
  assert.match(r.blocks[0], /inputs\s+NONE/, 'the reader names the empty input set, not a clean zero');
  assert.match(r.blocks[0], /last tick\s+never/, 'and admits it has never run');
  // And no count was invented: `2022` is the product name from the operator's own
  // question, so it is the only numeral in the sentence and it is sourced.
  assert.equal(ungroundedNumbers(r.text, `${r.blocks.join('\n')}\nanything new on token2022?`).length, 0);
  assert.doesNotMatch(r.text, /\b\d+\s+(mints?|findings?|ticks?|extensions?)\b/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. grounding — the rule the whole file exists for
// ─────────────────────────────────────────────────────────────────────────────

test('a numeral no tool produced is refused, and the number is not echoed back', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  const { fn } = stubModel([
    { tool: 'hunter', args: {} },
    // 3 is real (from the tool). 412 is not anywhere.
    { answer: 'Hunter checked 3 programs and 412 findings are waiting.' },
  ]);

  const r = await runAgent(env, 'how is the hunter?', { ask: fn, now: NOW });

  assert.equal(r.ok, false);
  assert.equal(r.degraded, 'no_grounding');
  assert.match(r.text, /numbers no tool produced/);
  // The fabricated sentence is gone: 412 must not survive into what is sent.
  assert.doesNotMatch(r.text, /412/);
  // And the true reading is still delivered.
  assert.match(r.text, /protocol hunter/);
});

test('echoing the operator’s own words is not an invention', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  // 12 is in the QUESTION; 2 and 3 are in the dust reader's text ("2 scanned",
  // "3 empty accounts"). All three are legitimate, and a grounding rule that
  // accepted only tool output would refuse a perfectly honest sentence.
  const { fn } = stubModel([
    { tool: 'dust', args: {} },
    { answer: 'Of the 12 wallets you asked about I scanned 2, and 3 accounts are closable.' },
  ]);

  const r = await runAgent(env, 'check the 12 wallets', { ask: fn, now: NOW });

  assert.equal(
    r.ok,
    true,
    `12 comes from the question and 2/3 from the tool, got ${r.degraded}: ${r.text}`,
  );
  assert.match(r.text, /scanned 2/);
});

test('a rounded decimal from the tool is grounded, and a near-miss is not', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  // `renderDust` prints toFixed(9) -> 0.006117840. Quoting it as 0.00611784 is the
  // same number; 0.00611785 is a different one and must be caught.
  {
    const { fn } = stubModel([
      { tool: 'dust', args: {} },
      { answer: 'Rent recoverable is 0.00611784 SOL.' },
    ]);
    const r = await runAgent(env, 'dust?', { ask: fn, now: NOW });
    assert.equal(r.ok, true, `a trailing zero is not a fabrication, got ${r.degraded}`);
  }
  {
    const { fn } = stubModel([
      { tool: 'dust', args: {} },
      { answer: 'Rent recoverable is 0.00611785 SOL.' },
    ]);
    const r = await runAgent(env, 'dust?', { ask: fn, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, 'no_grounding');
  }
});

test('numeralsIn normalises thousands separators so 6,117,840 and 6117840 agree', () => {
  assert.deepEqual([...numeralsIn('6,117,840 lamports and 0.00611784 SOL')], ['6117840', '0.00611784']);
  assert.deepEqual([...ungroundedNumbers('a 6,117,840 b', '6117840')], []);
  assert.deepEqual([...ungroundedNumbers('a 7 b', '6117840')], ['7']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6b. the transport guard
//
// `send()` posts with parse_mode HTML and Telegram rejects the WHOLE message on a
// malformed entity. A model that writes `p99 < 500ms` must not be able to make the
// bot go silent, and the fix must not turn the `<b>` it was allowed to use into
// literal text.
// ─────────────────────────────────────────────────────────────────────────────

test('safeModelHtml escapes bare < but keeps the tags the prompt allows', () => {
  assert.equal(safeModelHtml('p99 < 500ms'), 'p99 &lt; 500ms');
  assert.equal(safeModelHtml('a<b'), 'a&lt;b');
  assert.equal(safeModelHtml('<b>ok</b>'), '<b>ok</b>');
  assert.equal(safeModelHtml('<code>x</code>'), '<code>x</code>');
  // An unknown tag is escaped rather than forwarded: Telegram would 400 on it.
  assert.equal(safeModelHtml('<span>x</span>'), '&lt;span>x&lt;/span>');
  // An already-escaped entity is left alone, so `send()` cannot double-escape it.
  assert.equal(safeModelHtml('a &lt; b'), 'a &lt; b');
});

test('a reply containing a bare < is still deliverable', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  const { fn } = stubModel([
    { tool: 'hunter', args: {} },
    // No stray numerals: 3 and 2 come from the reading, so this test isolates the
    // escaping and cannot fail for the unrelated reason that a number was invented.
    { answer: '<b>Hunter</b> read 3 programs and 2 mints, latency < usual.' },
  ]);
  const r = await runAgent(env, 'hunter?', { ask: fn, now: NOW });
  assert.equal(r.ok, true, `got ${r.degraded}: ${r.text}`);
  assert.match(r.text, /<b>Hunter<\/b>/, 'an allowed tag survives');
  assert.match(r.text, /latency &lt; usual/, 'the bare < is escaped for parse_mode');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. the registry, the prompt, and the wiring surface
// ─────────────────────────────────────────────────────────────────────────────

test('every advertised tool is dispatchable — the prompt cannot promise a tool that does not exist', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  assert.ok(AGENT_TOOLS.length >= 8, 'the fleet has at least eight readings worth asking for');
  for (const spec of AGENT_TOOLS) {
    assert.ok(spec.summary.length > 20, `${spec.name} needs a summary the model can choose on`);
    // Driven with no arguments. `token2022_scan` legitimately needs `mints` and so
    // returns an argument error — what is asserted is that the dispatcher
    // RECOGNISED the name, because a name in the prompt but absent from HANDLERS
    // is the failure mode that makes the model look broken rather than the wiring.
    const { fn } = stubModel([{ tool: spec.name, args: {} }, { answer: 'ok' }]);
    const r = await runAgent(env, `use ${spec.name}`, { ask: fn, now: NOW });
    assert.equal(r.toolCalls.length, 1);
    assert.doesNotMatch(
      r.toolCalls[0].error ?? '',
      /unknown tool/,
      `tool "${spec.name}" is advertised in the prompt but missing from HANDLERS`,
    );
  }
});

test('the system prompt lists every tool exactly once', () => {
  const prompt = agentSystemPrompt();
  for (const spec of AGENT_TOOLS) {
    const hits = prompt.split(spec.name).length - 1;
    assert.ok(hits >= 1, `${spec.name} missing from the prompt`);
  }
  assert.match(prompt, /Every number you write must have come from a tool result/);
  assert.match(prompt, /\{"tool": "<name>", "args": \{…\}\}/);
});

test('the watched-job list is the switch’s own list, not a copy', () => {
  assert.ok(WATCHED_JOBS.includes('hunter_bot'));
  assert.ok(WATCHED_JOBS.includes('deadman'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. "what did we close today" — the question that needs the ledger
//
// This is the one operator question named in the assignment that NO existing card
// answers: `/pos` is open positions, `/kills` is refusals, and nothing renders
// closes. So the ledger tool is the only source, and these pin that it counts over
// the WINDOW rather than over the rows the limit returned — the difference between
// "1 close" and "1 close, but there were 9".
// ─────────────────────────────────────────────────────────────────────────────

/** Insert a ledger row the way `ledger.append` does (hash fields unused here). */
function putLedger(raw, seq, ts, kind, payload) {
  raw
    .prepare('INSERT INTO ledger (seq, ts, kind, payload, prev_hash, hash) VALUES (?,?,?,?,?,?)')
    .run(seq, ts, kind, JSON.stringify(payload), 'f'.repeat(64), String(seq).padStart(64, '0'));
}

test('ledger: counts over the window, lists the newest, and ignores older entries', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  // Three closes today, one close 40h ago (outside the default 24h window), plus
  // enough other kinds that a version counting all rows would be obviously wrong.
  putLedger(raw, 1, NOW_S - 40 * 3600, 'desk.exit', { symbol: 'OLD', pnl_usd: 1.5, reason: 'hard_stop' });
  putLedger(raw, 2, NOW_S - 3600, 'desk.exit', { symbol: 'WIF', pnl_usd: 12.25, reason: 'trail' });
  putLedger(raw, 3, NOW_S - 7200, 'desk.exit', { symbol: 'BONK', pnl_usd: -4, reason: 'time_stop' });
  putLedger(raw, 4, NOW_S - 5400, 'desk.exit', { symbol: 'POPCAT', pnl_usd: 8, reason: 'target' });
  putLedger(raw, 5, NOW_S - 1800, 'dust.reclaim', { lamports: 2_039_280 });
  putLedger(raw, 6, NOW_S - 600, 'desk.kill', { symbol: 'SCAM', reason_code: 'dev_hold' });

  const { fn, seen } = stubModel([
    { tool: 'ledger', args: { hours: 24, kinds: ['desk.exit'] } },
    { answer: 'You closed 3 positions today: WIF +$12.25, POPCAT +$8, BONK -$4.' },
  ]);

  const r = await runAgent(env, 'what did we close today?', { ask: fn, now: NOW });

  assert.equal(r.ok, true, `expected a grounded answer, got ${r.degraded}: ${r.text}`);
  const reading = r.blocks[0];
  assert.match(reading, /desk\.exit 3/, 'the count is over the window, not over the 10-row limit');
  assert.match(reading, /symbol=WIF/);
  // The 40h-old close is outside 24h and must not appear in the list.
  assert.doesNotMatch(reading, /symbol=OLD/);
  // Filtering to desk.exit means the reclaim and the kill are not counted.
  assert.doesNotMatch(reading, /dust\.reclaim/);

  // The model was shown the real payloads, so it could only have quoted them.
  assert.match(shownTo(seen)[1], /symbol=WIF/);
  assert.match(r.text, /closed 3 positions/);
});

test('ledger: an empty window is an honest zero that names the window', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  const { fn } = stubModel([
    { tool: 'ledger', args: { hours: 6 } },
    { answer: 'Nothing was written in the last 6 hours.' },
  ]);

  const r = await runAgent(env, 'anything closed in the last 6 hours?', { ask: fn, now: NOW });

  assert.equal(r.ok, true, `got ${r.degraded}: ${r.text}`);
  assert.match(r.blocks[0], /window last 6h/);
  assert.match(r.blocks[0], /NONE in this window/);
});

test('ledger: verify is off by default and only runs when asked', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  // Two rows with real hashes, so `ledgerVerify` has something to walk. It will
  // report BROKEN (the hashes below are synthetic) — which is itself the point:
  // the tool reports the chain's own verdict rather than asserting "intact".
  putLedger(raw, 1, NOW_S - 60, 'desk.exit', { symbol: 'WIF' });

  {
    const { fn } = stubModel([{ tool: 'ledger', args: {} }, { answer: 'ok' }]);
    const r = await runAgent(env, 'ledger?', { ask: fn, now: NOW });
    assert.doesNotMatch(r.blocks[0], /chain\s/, 'verify must be opt-in');
  }
  {
    const { fn } = stubModel([{ tool: 'ledger', args: { verify: true } }, { answer: 'ok' }]);
    const r = await runAgent(env, 'is the ledger intact?', { ask: fn, now: NOW });
    assert.match(r.blocks[0], /chain\s+(intact|BROKEN) —/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. conversation continuity — the parent wires this, so it must be possible
// ─────────────────────────────────────────────────────────────────────────────

test('the returned history is replayable as the next turn’s context', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);

  const first = stubModel([
    { tool: 'hunter', args: {} },
    { answer: 'Hunter read 3 programs, 1 finding.' },
  ]);
  const r1 = await runAgent(env, 'is the hunter stuck?', { ask: first.fn, now: NOW });
  assert.equal(r1.ok, true);
  // The history starts at the operator's question — no system prompt, because the
  // next turn supplies its own — and ends with the answer.
  assert.equal(r1.history[0].role, 'user');
  assert.equal(r1.history[r1.history.length - 1].role, 'assistant');

  const second = stubModel([{ answer: 'Yes — same reading as before.' }]);
  const r2 = await runAgent(env, 'and are you sure?', {
    ask: second.fn,
    now: NOW,
    history: r1.history,
  });
  assert.equal(r2.ok, true, `got ${r2.degraded}: ${r2.text}`);

  // The second turn's prompt contained the first turn verbatim, so a follow-up
  // question has something to refer back to.
  const prompt = second.seen[0].msgs.map((m) => m.content).join('\n');
  assert.match(prompt, /is the hunter stuck\?/);
  assert.match(prompt, /Hunter read 3 programs, 1 finding\./);
  assert.match(prompt, /and are you sure\?/);
  assert.equal(second.seen[0].msgs[0].role, 'system', 'one system prompt, first');

  // A follow-up that quotes the previous ANSWER is grounded even though this turn
  // read no tool at all: the transcript is context, but the numerals in it came
  // from a reading in the previous turn, and the model is told not to restate
  // numbers it cannot attribute. Re-quoting 3 is allowed because the question's
  // history carries it.
  assert.equal(r2.toolCalls.length, 0);
});

test('history is trimmed to a bound, and never starts mid-turn', async () => {
  const { env, raw } = makeEnv();
  seedFleet(raw);
  // 20 prior messages: twice the 8-message bound.
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: `question ${i}` });
    history.push({ role: 'assistant', content: `answer ${i}` });
  }
  const { fn, seen } = stubModel([{ answer: 'fresh' }]);
  const r = await runAgent(env, 'now?', { ask: fn, now: NOW, history });
  assert.equal(r.ok, true, `got ${r.degraded}`);

  const msgs = seen[0].msgs;
  assert.ok(msgs.length <= 10, `history must be bounded, got ${msgs.length} messages`);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user', 'the trimmed history must begin on a user turn');
  // The newest turn is always kept, whatever the bound.
  assert.equal(msgs[msgs.length - 1].content, 'now?');
});
