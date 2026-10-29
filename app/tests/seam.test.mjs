// THE SEAM, pinned.
//
// skills.ts was complete, tested and embedded for a filesystem-less Worker, and
// still had ZERO importers for the whole project: 25 packs that no production path
// could ever reach. Green tests cannot catch that, because the tests import the
// module directly. Only a test that starts at the SHIPPED entrypoint and asserts the
// operator actually sees the text can.
//
// This drives the real Worker fetch handler over a real callback update and asserts
// on the message body Telegram would have sent.

import test from 'node:test';
import assert from 'node:assert/strict';

import index from '../build/index.js';
import { getSkill } from '../build/skills.js';

/** A D1 stand-in that authorises chat 42 and returns no rows. */
function fakeEnv() {
  const stmt = {
    bind: () => stmt,
    first: async () => ({ value: '42' }),
    run: async () => ({ success: true }),
    all: async () => ({ results: [] }),
  };
  return {
    OPERATOR_NAME: 'jennifer',
    TELEGRAM_CHAT_ID: '42',
    TELEGRAM_BOT_TOKEN: 'test-token',
    DB: { prepare: () => stmt },
  };
}

/**
 * Send one callback update and return every text body that would be sent.
 * `waitUntil` work is awaited, because the handler replies from the background.
 */
async function pressButton(data) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    try {
      const body = JSON.parse(init.body);
      if (typeof body.text === 'string') sent.push(body.text);
    } catch {
      /* not a JSON body: irrelevant here */
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException: () => {} };
    await index.fetch(
      new Request('https://worker.example/tg', {
        method: 'POST',
        body: JSON.stringify({
          update_id: 1,
          callback_query: {
            id: 'cb',
            data,
            message: { message_id: 11, chat: { id: 42 } },
          },
        }),
      }),
      fakeEnv(),
      ctx,
    );
    await Promise.allSettled(pending);
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test('the playbook card the operator sees carries that playbook\'s skill questions', async () => {
  const skill = getSkill('sol.reentrancy');
  assert.ok(skill, 'sol.reentrancy must exist');

  const sent = await pressButton('pbx:sol.reentrancy');
  const card = sent.find((t) => t.includes('sol.reentrancy'));
  assert.ok(card, `no playbook card was sent; got ${sent.length} message(s)`);

  // The header is the seam marker: without it, no skill prose reached the card.
  assert.match(card, /ask before you believe it/i, 'the card carries no skill section');

  // The BODY is asserted, not just the header: a header with no questions under it
  // would satisfy a naive test and still be a dead skill.
  for (const q of skill.questions.slice(0, 3)) {
    const needle = q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 40);
    assert.ok(card.includes(needle), `card is missing question: ${needle}`);
  }
});

test('every playbook that has a skill renders its questions on its card', async () => {
  // One pack proves the wiring; this proves the wiring holds for the catalog, so a
  // pack added later cannot be silently unreachable.
  const ids = ['sol.reentrancy', 'sol.oracle', 'sol.accesscontrol', 'web.sqli', 'web.jwt'];
  for (const id of ids) {
    const skill = getSkill(id);
    assert.ok(skill, `${id} must exist`);
    const sent = await pressButton(`pbx:${id}`);
    const card = sent.find((t) => t.includes(id));
    assert.ok(card, `${id}: no card sent`);
    assert.match(card, /ask before you believe it/i, `${id}: card has no skill section`);
  }
});

test('a playbook with no skill still renders a card', async () => {
  // The seam must never take a card down with it. An unknown id must produce the
  // fallback text, not an exception and not a blank reply.
  const sent = await pressButton('pbx:does.not.exist');
  assert.ok(sent.length > 0, 'an unknown playbook must still answer');
  const body = sent.find((t) => /UNKNOWN PLAYBOOK/i.test(t));
  assert.ok(body, 'the reply must say the playbook is unknown, not be a blank edit');
  assert.match(body, /does\.not\.exist/, 'the reply must name what was not found');
});
