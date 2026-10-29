// PHASE 5, defects 1 and 2 — pinned at the SHIPPED entrypoint.
//
// The dashboard is served from Pages and the API from a Worker: different origins.
// index.ts shipped with zero `Access-Control-Allow-Origin` and zero OPTIONS
// handling, so every fetch in the deck was browser-blocked while the API answered
// perfectly. These tests drive index.fetch directly, so a regression here fails
// here rather than in a browser console the operator never opens.

import test from 'node:test';
import assert from 'node:assert/strict';

import index from '../build/index.js';

const DASH = 'https://asterion.pages.dev';
const EVIL = 'https://evil.example';

/** A D1 stand-in: every query returns no rows, which is all /api/status needs. */
function fakeEnv(extra = {}) {
  const stmt = {
    bind: () => stmt,
    first: async () => null,
    run: async () => ({ success: true }),
    all: async () => ({ results: [] }),
  };
  return {
    OPERATOR_NAME: 'jennifer',
    DB: { prepare: () => stmt },
    ...extra,
  };
}

function call(path, { method = 'GET', headers = {}, env = fakeEnv() } = {}) {
  return index.fetch(new Request(`https://worker.example${path}`, { method, headers }), env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  });
}

// ── defect 1: CORS ─────────────────────────────────────────────────────────

test('GET /api/status sends no ACAO header when DASH_ORIGIN is unset', async () => {
  const res = await call('/api/status', { headers: { origin: DASH } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('GET /api/status echoes the configured dashboard origin', async () => {
  const res = await call('/api/status', {
    headers: { origin: DASH },
    env: fakeEnv({ DASH_ORIGIN: DASH }),
  });
  assert.equal(res.headers.get('access-control-allow-origin'), DASH);
  assert.equal(res.headers.get('vary'), 'origin');
});

test('a disallowed origin gets NO ACAO header, even when others are configured', async () => {
  const res = await call('/api/status', {
    headers: { origin: EVIL },
    env: fakeEnv({ DASH_ORIGIN: DASH }),
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('DASH_ORIGIN="*" is refused, never honoured', async () => {
  // A wildcard would let any page read findings and ledger once the URL leaks.
  const res = await call('/api/status', {
    headers: { origin: EVIL },
    env: fakeEnv({ DASH_ORIGIN: '*' }),
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('DASH_ORIGIN accepts a comma-separated list, exact-match only', async () => {
  const env = fakeEnv({ DASH_ORIGIN: `http://localhost:8788, ${DASH}` });
  const ok = await call('/api/status', { headers: { origin: DASH }, env });
  assert.equal(ok.headers.get('access-control-allow-origin'), DASH);
  // A prefix of a listed origin must not match.
  const near = await call('/api/status', { headers: { origin: `${DASH}.evil.example` }, env });
  assert.equal(near.headers.get('access-control-allow-origin'), null);
});

test('OPTIONS /api/status returns 204 with the allow headers for a listed origin', async () => {
  const res = await call('/api/status', {
    method: 'OPTIONS',
    headers: { origin: DASH },
    env: fakeEnv({ DASH_ORIGIN: DASH }),
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), DASH);
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /GET/);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/i);
});

test('OPTIONS from an unlisted origin is refused, not 204', async () => {
  const res = await call('/api/status', {
    method: 'OPTIONS',
    headers: { origin: EVIL },
    env: fakeEnv({ DASH_ORIGIN: DASH }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('a non-GET, non-OPTIONS /api request is 405 and never reaches the queries', async () => {
  const res = await call('/api/status', { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, OPTIONS');
});

// ── defect 2: the auth story ───────────────────────────────────────────────

test('/api/status without a token is 401 once DASHBOARD_TOKEN is set', async () => {
  const res = await call('/api/status', { env: fakeEnv({ DASHBOARD_TOKEN: 'secret-token' }) });
  assert.equal(res.status, 401);
});

test('/api/status with the wrong token is 401', async () => {
  const res = await call('/api/status', {
    headers: { authorization: 'Bearer wrong' },
    env: fakeEnv({ DASHBOARD_TOKEN: 'secret-token' }),
  });
  assert.equal(res.status, 401);
});

test('/api/status with the right token is 200, and still carries CORS', async () => {
  const res = await call('/api/status', {
    headers: { origin: DASH, authorization: 'Bearer secret-token' },
    env: fakeEnv({ DASHBOARD_TOKEN: 'secret-token', DASH_ORIGIN: DASH }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), DASH);
});

test('a 401 still carries CORS, so the browser can READ the error', async () => {
  // Without this the operator sees an opaque "CORS error" instead of "unauthorized".
  const res = await call('/api/status', {
    headers: { origin: DASH },
    env: fakeEnv({ DASHBOARD_TOKEN: 'secret-token', DASH_ORIGIN: DASH }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('access-control-allow-origin'), DASH);
});
