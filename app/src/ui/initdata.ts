/**
 * Telegram Mini App `initData` validation, server-side.
 *
 * A Mini App opened from an inline `web_app` button receives a signed query
 * string on `Telegram.WebApp.initData`. The signature is an HMAC over the data
 * with a key DERIVED FROM THE BOT TOKEN, which is the whole reason no new secret
 * and no BotFather step is needed:
 *
 *   secret    = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   expected  = HMAC_SHA256(key=secret,      msg=data_check_string)
 *
 * and `data_check_string` is every field except `hash`, sorted by key, joined
 * with a newline as `key=value`.
 *
 * Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * FAIL CLOSED. Every branch that is not "the signature verified and the payload
 * is fresh" returns a denial. An unset bot token is a denial, not a bypass: this
 * is the same posture `/hook/proof` already takes with PROOF_HOOK_SECRET, and for
 * the same reason - the caller of this module can create engagement rows.
 *
 * The hash compare is length-checked then XOR-accumulated, mirroring
 * `timingSafeEqual` in index.ts, so a wrong signature cannot be recovered byte by
 * byte from response timing.
 */

export type InitDataFail =
  | 'no_bot_token'
  | 'missing'
  | 'malformed'
  | 'no_hash'
  | 'bad_hash'
  | 'no_auth_date'
  | 'stale'
  | 'future';

export interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export type InitDataVerdict =
  | {
      ok: true;
      authDate: number;
      ageSeconds: number;
      user: InitDataUser | null;
      queryId: string | null;
    }
  | { ok: false; reason: InitDataFail; detail: string };

/** 24h, matching the freshness rule Telegram documents. */
export const DEFAULT_MAX_AGE_SECONDS = 86_400;

/** Clock skew tolerated on `auth_date` before a payload counts as "from the future". */
export const DEFAULT_FUTURE_SKEW_SECONDS = 300;

export interface InitDataPolicy {
  maxAgeSeconds?: number;
  futureSkewSeconds?: number;
  /** Injected clock (unix seconds) so the freshness tests need no sleeping. */
  now?: () => number;
}

const encoder = new TextEncoder();

/**
 * HMAC-SHA256. The key is RAW BYTES, not a string: the two-step derivation below
 * passes the first HMAC's 32 output bytes straight into the second as its key,
 * and encoding them as hex first would produce a different MAC entirely.
 *
 * WebCrypto rather than a bundled library: it is native in the Workers runtime and
 * in Node >= 18, so tests exercise the identical implementation the Worker runs
 * instead of a stand-in that could disagree with it.
 */
async function hmacSha256(keyBytes: Uint8Array, msg: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(msg));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Length-checked, branch-free compare. Same shape as index.ts's timingSafeEqual. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The exact string Telegram signs: every field except `hash`, sorted by key.
 * Values are the URL-DECODED ones, which is what URLSearchParams already gives
 * us - decoding twice would break any value containing a literal `%`.
 */
export function dataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [k, v] of params) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  return pairs.sort().join('\n');
}

/**
 * Compute the expected `hash` for a payload. Exported so tests can forge one.
 *
 * Two-step key derivation, exactly as Telegram documents it: the first HMAC's 32
 * raw output bytes become the KEY of the second. It is pinned against
 * Python-generated vectors in `tests/ui-initdata.test.mjs` rather than asserted
 * here - which is how a hex-encoded key (a different MAC) was caught rather than
 * shipped.
 */
export async function expectedHash(initData: string, botToken: string): Promise<string> {
  const secretKey = await hmacSha256(encoder.encode('WebAppData'), botToken);
  return toHex(await hmacSha256(secretKey, dataCheckString(new URLSearchParams(initData))));
}

/**
 * Validate an initData string. Never throws: a malformed string is a denial with
 * a reason, because an exception escaping into the request handler is a 500 and a
 * 500 is not a security decision.
 */
export async function validateInitData(
  initData: string | null | undefined,
  botToken: string | null | undefined,
  policy: InitDataPolicy = {},
): Promise<InitDataVerdict> {
  if (!botToken) {
    return { ok: false, reason: 'no_bot_token', detail: 'TELEGRAM_BOT_TOKEN is not configured' };
  }
  const raw = (initData ?? '').trim();
  if (!raw) {
    return { ok: false, reason: 'missing', detail: 'no initData presented' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { ok: false, reason: 'malformed', detail: 'initData is not a query string' };
  }

  const got = params.get('hash');
  if (!got || !/^[0-9a-f]{64}$/i.test(got)) {
    return { ok: false, reason: 'no_hash', detail: 'initData carries no usable hash' };
  }
  // Nothing but `hash` means the loop below would sign the empty string, which
  // every caller could produce. Refuse rather than validate a vacuous payload.
  if (dataCheckString(params).length === 0) {
    return { ok: false, reason: 'malformed', detail: 'initData carries no signed fields' };
  }

  let want: string;
  try {
    want = await expectedHash(raw, botToken);
  } catch (e) {
    return {
      ok: false,
      reason: 'malformed',
      detail: `signature could not be computed: ${(e as Error).message}`,
    };
  }
  if (!timingSafeEqualHex(got.toLowerCase(), want)) {
    return { ok: false, reason: 'bad_hash', detail: 'signature does not match' };
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) {
    return { ok: false, reason: 'no_auth_date', detail: 'initData carries no auth_date' };
  }
  const authDate = Number(authDateRaw);
  const now = Math.floor((policy.now ? policy.now() : Date.now()) / 1000);
  const age = now - authDate;
  const maxAge = policy.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const skew = policy.futureSkewSeconds ?? DEFAULT_FUTURE_SKEW_SECONDS;

  if (age > maxAge) {
    return {
      ok: false,
      reason: 'stale',
      detail: `initData is ${age}s old; the limit is ${maxAge}s`,
    };
  }
  if (age < -skew) {
    return { ok: false, reason: 'future', detail: `auth_date is ${-age}s in the future` };
  }

  return {
    ok: true,
    authDate,
    ageSeconds: age,
    user: parseUser(params.get('user')),
    queryId: params.get('query_id') ?? null,
  };
}

function parseUser(raw: string | null): InitDataUser | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as unknown;
    if (typeof u !== 'object' || u === null) return null;
    const rec = u as Record<string, unknown>;
    if (typeof rec['id'] !== 'number') return null;
    const out: InitDataUser = { id: rec['id'] };
    for (const k of ['first_name', 'last_name', 'username', 'language_code'] as const) {
      const v = rec[k];
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * An operator-facing one-liner for a denial. Deliberately coarse: it names the
 * CLASS of failure so the operator can act, and no more, so the endpoint is not
 * an oracle for a probing caller.
 */
export function describeFailure(reason: InitDataFail): string {
  switch (reason) {
    case 'no_bot_token':
      return 'This Worker has no TELEGRAM_BOT_TOKEN, so Mini App sign-in is disabled. The bot still works in chat.';
    case 'missing':
      return 'No Telegram session was presented. Open this from the button inside the bot chat.';
    case 'stale':
      return 'This Telegram session has expired. Reopen the console from the bot chat.';
    case 'future':
      return 'This Telegram session is not yet valid. Check the clock on the device.';
    default:
      return 'This Telegram session could not be verified. Reopen the console from the bot chat.';
  }
}
