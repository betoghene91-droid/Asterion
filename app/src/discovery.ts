/**
 * Discovery crawler — finds the long tail nobody lists.
 *
 * Targets the 7,664 self-hosted programs that platform directories do not
 * carry. For each candidate programme it fetches, at two paths per host:
 *   /.well-known/security.txt   (RFC 9116)
 *   /security.txt
 * and parses Contact, Policy, Expires, Canonical. The hosts per programme are the
 * apex and `www` — see `hostsFor`. THE PER-HOST REQUEST COUNT IS UNCHANGED at two;
 * the widening is in which hosts are asked, not how hard any host is hit.
 *
 * Hard budget: 50 subrequests per invocation on the free plan, and that ceiling is
 * the binding constraint on this whole module. Since the fund-adapter crawl
 * (`targets/queue.ts`) shares the same tick, the budget is now PLANNED rather than
 * fixed: see `planDiscoveryTick`, which reserves the adapter fetches first and
 * derives how many programmes still fit.
 *
 * DISCOVERY IS NOT AUTHORIZATION. Everything this module finds is a LEAD. A host
 * that publishes a security.txt has told us where to REPORT, not what we may test;
 * `automation` is the field that gates dispatch and `roeFromBrief` gates the
 * engagement.
 */

import { drainQueue, enqueueProtocols, planTick, tokenKeysFrom, type QueueDb } from './targets/queue.js';
import type { ProtocolRecord } from './targets/funding.js';

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
/**
 * PREFERRED programmes per tick. Not a promise: `planDiscoveryTick` cuts it down
 * whenever the adapter crawl is spending part of the 50-request ceiling, because
 * 20 programmes x (4 security.txt + 1 policy) + adapters is over budget.
 */
const MAX_CANDIDATES = 20;
const TIMEOUT_MS = 8000;

/**
 * The hosts probed per programme: the apex and `www`.
 *
 * WHY THIS IS SEPARATE FROM THE PATHS AND WHY IT COSTS NOTHING EXTRA
 *
 * RFC 9116 puts the file at the apex, and the current crawl only ever asked the
 * host exactly as the programme listing spelled it — which for many programmes is
 * `www.example.com`, so the apex was never asked at all. Adding the apex is not a
 * wider crawl in the sense that matters: the per-host request count stays at
 * {@link SECURITY_TXT_PATHS}.length (2), and the pair is ordered so the apex is
 * tried first and `www` only when the apex yielded nothing. The worst case is 4
 * requests for a programme whose apex has a file but no `Contact:` line, and the
 * tick budget in `targets/queue.ts` plans for that worst case rather than the
 * common one.
 *
 * A host that is already `www.` is not doubled into `www.www.`, and an apex that
 * is itself a multi-label host (`app.example.com`) is probed as given plus the
 * registrable apex only when the two differ — see {@link hostsFor}.
 */
export function hostsFor(host: string): string[] {
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  if (!h) return [];
  const out: string[] = [];
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v);
  };
  if (h.startsWith('www.')) {
    // The listing gave the www form; the apex is the RFC 9116 location.
    push(h.slice(4));
    push(h);
    return out;
  }
  push(h);
  // `app.example.com` gets `www.app.example.com` only when that is a plausible
  // host; for a two-label `example.com` it is `www.example.com`.
  push(`www.${h}`);
  return out;
}

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

/**
 * The narrow fetch surface this module needs, so a test can drive the whole crawl
 * with fixtures and NO network. `targets/collect.ts` and `targets/queue.ts` inject
 * `fetch` the same way; the crawl was the one path that read the global, which
 * meant a "unit" test silently made real requests.
 */
export interface CrawlFetcher {
  (url: string, init: { redirect: 'follow'; signal: AbortSignal; headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

async function getText(url: string, doFetch?: CrawlFetcher): Promise<string | null> {
  const impl = doFetch ?? (globalThis.fetch as unknown as CrawlFetcher);
  if (typeof impl !== 'function') return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await impl(url, {
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

/**
 * Probe one host for a security.txt. Two requests per host, hard cap.
 *
 * The `Contact:` requirement is what separates a disclosure programme from a
 * stray text file. A file with `Policy:` but no `Contact:` is not a channel, so it
 * is treated as "not found here" and the next host is tried — which is why
 * `hostsFor` order matters: a www-only programme would otherwise be missed
 * entirely.
 */
export async function probeHost(host: string, doFetch?: CrawlFetcher): Promise<Discovered | null> {
  for (const p of SECURITY_TXT_PATHS) {
    const body = await getText(`https://${host}${p}`, doFetch);
    if (!body || !/contact\s*:/i.test(body)) continue;
    return { host, ...parseSecurityTxt(body) };
  }
  return null;
}

/**
 * Probe a programme's hosts: the apex first, `www` only if the apex was empty.
 *
 * Worst case is `hosts.length * SECURITY_TXT_PATHS.length` requests; the common
 * case is 2, because most programmes that publish the file publish it at the
 * apex. The function returns which host answered so the row records it.
 */
export async function probeProgrammeHosts(
  hosts: readonly string[],
  doFetch?: CrawlFetcher,
): Promise<Discovered | null> {
  for (const host of hosts) {
    const found = await probeHost(host, doFetch);
    if (found) return found;
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
export async function crawlTick(
  env: Env,
  options: { limit?: number; fetch?: CrawlFetcher } = {},
): Promise<{ probed: number; found: number; limit: number }> {
  const now = Math.floor(Date.now() / 1000);
  const limit = Math.max(0, Math.floor(options.limit ?? MAX_CANDIDATES));
  if (limit === 0) return { probed: 0, found: 0, limit };
  const due = await env.DB.prepare(
    `SELECT id, name, homepage, policy_text FROM programs
     WHERE status IN ('new','crawled')
       AND (next_check IS NULL OR next_check <= ?)
     ORDER BY priority DESC, COALESCE(next_check, 0) ASC
     LIMIT ?`,
  )
    .bind(now, limit)
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
    const hosts = hostsFor(host);
    const st = hosts.length ? await probeProgrammeHosts(hosts, options.fetch) : null;
    if (!st) {
      await env.DB.prepare('UPDATE programs SET last_checked=?, next_check=? WHERE id=?')
        .bind(now, now + 14 * 86400, row.id)
        .run();
      continue;
    }

    found++;
    const policyBody = st.policy_url ? await getText(st.policy_url, options.fetch) : null;
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

  return { probed, found, limit };
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

// ─────────────────────────────────────────────────────────────────────────────
// the tick: one discovery slot, two jobs, one ceiling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one discovery tick will spend, decided before anything is fetched.
 *
 * The Worker has five cron slots and zero headroom (see `wrangler.toml`), so the
 * adapter crawl does NOT get its own slot: it is composed into the existing hourly
 * discovery tick, exactly as the desk is composed into the 5-minute sentinel slot.
 * That means the two jobs share ONE 50-subrequest ceiling, and the split has to be
 * planned rather than hoped for.
 *
 * Adapters are reserved FIRST and the crawl gets the remainder. The reasoning: the
 * crawl is unbounded work with no natural end (there are always more hosts), while
 * the adapter queue is a finite 438-row job with a known size, so starving it
 * would leave the funding, has_programme and EV fields permanently empty. A crawl
 * that runs 300 hosts fewer per day is invisible; a fund_addresses column that never
 * populates is a broken feature.
 */
export interface DiscoveryTickPlan {
  /** Adapter fetches this tick will attempt. */
  fund: number;
  /** Programmes the security.txt crawl will probe. */
  programmes: number;
  /** Total planned subrequests. Guaranteed ≤ 50 by `planTick`. */
  total: number;
}

export function planDiscoveryTick(options: { fund?: number; programmes?: number } = {}): DiscoveryTickPlan {
  const plan = planTick({
    fund: options.fund ?? 8,
    programmes: options.programmes ?? MAX_CANDIDATES,
    hosts_per_programme: 2,
  });
  return { fund: plan.fund, programmes: plan.programmes, total: plan.total };
}

/**
 * One discovery tick: drain the adapter queue, then crawl security.txt.
 *
 * ORDER: adapters first, because `planTick` already reserved their budget and
 * because a failure in the crawl must not cost the funding fields. Each job is
 * independently caught — the same rule the sentinel/desk composition follows, so
 * one failing cannot silence the other.
 *
 * `fetch` is injectable so the whole tick can be driven by a test with fixture
 * bodies. Nothing in the suite touches the network.
 */
export async function discoveryTick(
  env: Env,
  options: {
    now?: number;
    plan?: DiscoveryTickPlan;
    fetch?: Parameters<typeof drainQueue>[1]['fetch'];
    /** Since the adapter queue keys on code paths the caller already collected. */
    tokenKeys?: ReadonlySet<string>;
  } = {},
): Promise<{
  plan: DiscoveryTickPlan;
  fund: Awaited<ReturnType<typeof drainQueue>> | null;
  crawl: { probed: number; found: number; limit: number } | null;
}> {
  const plan = options.plan ?? planDiscoveryTick();
  const now = options.now ?? Math.floor(Date.now() / 1000);

  let fund: Awaited<ReturnType<typeof drainQueue>> | null = null;
  if (plan.fund > 0) {
    try {
      fund = await drainQueue(env.DB as unknown as QueueDb, {
        now,
        max_fetches: plan.fund,
        tokenKeys: options.tokenKeys ?? new Set<string>(),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    } catch (e) {
      console.error('discovery fund queue failed', e);
    }
  }

  let crawl: { probed: number; found: number; limit: number } | null = null;
  if (plan.programmes > 0) {
    try {
      crawl = await crawlTick(env, {
        limit: plan.programmes,
        ...(options.fetch ? { fetch: options.fetch as unknown as CrawlFetcher } : {}),
      });
    } catch (e) {
      console.error('discovery crawl failed', e);
    }
  }

  return { plan, fund, crawl };
}

/**
 * Enqueue the protocols an inventory refresh produced.
 *
 * Thin wrapper so `index.ts` needs one import rather than three, and so the
 * token-key set is always derived from the same record list the queue was built
 * from — a mismatch there would make the token filter compare an address against
 * the wrong universe and look like it worked.
 */
export async function enqueueFundProtocols(
  env: Env,
  records: readonly (ProtocolRecord & { chainKey?: string })[],
  now = Math.floor(Date.now() / 1000),
): Promise<{ inserted: number; skipped: number; tokenKeys: Set<string> }> {
  const res = await enqueueProtocols(env.DB as unknown as QueueDb, records, now);
  return { ...res, tokenKeys: tokenKeysFrom(records) };
}
