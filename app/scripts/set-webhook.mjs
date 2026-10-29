#!/usr/bin/env node
/**
 * Point Telegram at the Worker. Idempotent: safe to run on every deploy.
 *
 * Usage: TELEGRAM_BOT_TOKEN=... WORKER_URL=https://x.workers.dev node scripts/set-webhook.mjs
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
const workerUrl = process.env.WORKER_URL?.replace(/\/$/, '');
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token) {
  console.error('missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
if (!workerUrl) {
  console.error('missing WORKER_URL (set it as a repo variable, e.g. https://asterion.you.workers.dev)');
  process.exit(1);
}

const webhook = `${workerUrl}/tg`;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: webhook,
    ...(secret ? { secret_token: secret } : {}),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  }),
});

const body = await res.json();
if (!res.ok || !body.ok) {
  console.error('setWebhook failed:', JSON.stringify(body));
  process.exit(1);
}

const info = await (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)).json();
console.log('webhook set ->', webhook);
console.log('pending:', info.result?.pending_update_count ?? 0);
if (info.result?.last_error_message) {
  console.warn('last delivery error:', info.result.last_error_message);
}
