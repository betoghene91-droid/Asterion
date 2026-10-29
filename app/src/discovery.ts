/**
 * Discovery crawler — finds the long tail nobody lists.
 *
 * Targets the 7,664 self-hosted programs that platform directories do not
 * carry. For each candidate host it fetches:
 *   /.well-known/security.txt   (RFC 9116)
 *   /security.txt
 * and parses Contact, Policy, Expires, Canonical.
 *
 * Hard budget: 50 subrequests per invocation on the free plan. We spend at
 * most 2 per candidate and cap candidates per tick, so one tick never blows
 * the ceiling. State lives in D1 so a half-finished sweep resumes.
 */

export interface Env {
  DB: D1Database;
}

export interface Discovered {
  host: string;
  contact: string[];
  policy_url: string | null;
  canonical: string | null;
  expires: string | null;
}

const SECURITY_TXT_PATHS = ['/.well-known/security.txt', '/security.txt'];
const MAX_CANDIDATES = 20; // 20 * 2 = 40 subrequests, plus DB writes
const TIMEOUT_MS = 8000;

export function parseSecurityTxt(text: string): Omit<Discovered, 'host'> {
  const contact: string[] = [];
  let policy_url: string | null = null;
  let canonical: string | null = null;
  let expires: string | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'contact') contact.push(val);
    else if (key === 'policy') policy_url = val;
    else if (key === 'canonical') canonical = val;
    else if (key === 'expires') expires = val;
  }
  return { contact, policy_url, canonical, expires };
}

async function getText(url: string): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'user-agent': 'asterion/1.0 (+security.txt discovery; read-only)' },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/plain|text\/|application\/octet-stream/i.test(ct)) return null;
    const body = await res.text();
    return body.slice(0, 20000);
  } catch {
    return null;
  }
}

/** Probe one host for a security.txt. Two requests max. */
export async function probeHost(host: string): Promise<Discovered | null> {
  for (const p of SECURITY_TXT_PATHS) {
    const body = await getText(`https://${host}${p}`);
    if (!body || !/contact\s*:/i.test(body)) continue;
    return { host, ...parseSecurityTxt(body) };
  }
  return null;
}

/**
 * Classify a policy's stance on automated testing.
 *
 * Conservative by construction: we only return 'allowed' when the text
 * affirmatively permits automated scanning. Anything ambiguous becomes
 * 'not_mentioned', and anything restrictive becomes 'prohibited'.
 * Getting this wrong is how a researcher gets banned, so the default is
 * always the safer of the two readings.
 */
export function classifyAutomation(policyText: string): 'allowed' | 'not_mentioned' | 'prohibited' {
  const t = policyText.toLowerCase();

  const prohibited = [
    'no automated',
    'do not permit automated',
    'do not allow automated',
    'does not permit automated',
    'must not use automated',
    'automated scanning is prohibited',
    'automated testing is prohibited',
    'automated scanning is not',
    'do not use automated',
    'automated tools are not permitted',
    'no scanners',
    'scanner traffic',
    'no automated testing',
    'prohibited: automated',
    'not permitted to use automated',
    'without prior written consent for automated',
  ];
  if (prohibited.some((p) => t.includes(p))) return 'prohibited';

  const allowed = [
    'automated scanning is permitted',
    'automated testing is permitted',
    'automated tools are permitted',
    'automated tools are allowed',
    'may use automated',
    'you may run automated',
    'automated scanning is allowed',
    'scanners are welcome',
  ];
  if (allowed.some((p) => t.includes(p))) return 'allowed';

  return 'not_mentioned';
}

export function classifyReward(policyText: string): 'monetary' | 'swag' | 'recognition' | 'none' | 'unknown' {
  const t = policyText.toLowerCase();
  if (/bounty|reward|payout|compensation|\$[0-9]/.test(t)) return 'monetary';
  if (/swag|t-?shirt|sticker/.test(t)) return 'swag';
  if (/hall of fame|acknowledg|recognition|credits/.test(t)) return 'recognition';
  if (/no (monetary )?reward|unpaid|voluntary/.test(t)) return 'none';
  return 'unknown';
}

/**
 * One crawler tick. Reads the front of the work queue, probes, writes back.
 * Never throws on a single host failure: a dead host is data, not an error.
 */
export async function crawlTick(env: Env): Promise<{ probed: number; found: number }> {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    `SELECT id, name, homepage, policy_text FROM programs
     WHERE status IN ('new','crawled')
       AND (next_check IS NULL OR next_check <= ?)
     ORDER BY priority DESC, COALESCE(next_check, 0) ASC
     LIMIT ?`,
  )
    .bind(now, MAX_CANDIDATES)
    .all<{ id: string; name: string; homepage: string | null; policy_text: string | null }>();

  let probed = 0;
  let found = 0;

  for (const row of due.results ?? []) {
    const host = row.homepage?.replace(/^https?:\/\//, '').split('/')[0];
    if (!host) {
      await env.DB.prepare('UPDATE programs SET status=?, next_check=? WHERE id=?')
        .bind('dead', now + 30 * 86400, row.id)
        .run();
      continue;
    }

    probed++;
    const st = await probeHost(host);
    if (!st) {
      await env.DB.prepare('UPDATE programs SET last_checked=?, next_check=? WHERE id=?')
        .bind(now, now + 14 * 86400, row.id)
        .run();
      continue;
    }

    found++;
    const policyBody = st.policy_url ? await getText(st.policy_url) : null;
    const automation = policyBody ? classifyAutomation(policyBody) : 'unknown';
    const reward = policyBody ? classifyReward(policyBody) : 'unknown';

    await env.DB.prepare(
      `UPDATE programs SET
         policy_url=?, policy_text=?, automation=?, reward=?,
         status='parsed', last_checked=?, next_check=?, meta=?
       WHERE id=?`,
    )
      .bind(
        st.policy_url,
        policyBody ?? null,
        automation,
        reward,
        now,
        now + 7 * 86400,
        JSON.stringify({ contact: st.contact, canonical: st.canonical, expires: st.expires }),
        row.id,
      )
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO kv (key,value,ts) VALUES ('crawler_last',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts`,
  )
    .bind(String(now), now)
    .run();

  return { probed, found };
}

/**
 * Seed the queue. In production this is fed by the public directory export;
 * here it accepts a plain list so the operator can paste 5 hosts from a phone.
 */
export async function seed(env: Env, hosts: string[]): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const h of hosts) {
    const host = h.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    await env.DB.prepare(
      `INSERT INTO programs (id,name,platform,homepage,status,discovered_at,next_check)
       VALUES (?,?,?,?,'new',?,?)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(host, host, 'self', `https://${host}`, now, now)
      .run();
    n++;
  }
  return n;
}
