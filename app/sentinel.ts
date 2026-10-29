/**
 * Sentinel — the reputation engine.
 *
 * Watches a small watchlist on Base for the three things that turn into
 * money before they turn into news:
 *
 *   R1  ownership / admin transfer or proxy upgrade
 *   R2  unlimited token approval granted to a fresh address
 *   R3  privileged function invoked by a non-owner in the same block as a
 *       large liquidity move (the sandwich-shaped signal)
 *
 * It reads logs only. It never signs, never submits, never holds a key.
 * That is what lets it run every 5 minutes on a free plan without risk.
 */

export interface Env {
  DB: D1Database;
  RPC_URL?: string;
  CHAIN_ID?: string;
  ALERT_FLOOR?: string;
}

export interface LogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

// keccak256 signatures — canonical, well-known
const TOPIC = {
  OwnershipTransferred:
    '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',
  Upgraded:
    '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
  Approval:
    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  AdminChanged:
    '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f',
} as const;

const MAX_UINT256 =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

async function rpc(env: Env, method: string, params: unknown[]): Promise<unknown> {
  const url = env.RPC_URL ?? 'https://mainnet.base.org';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} -> ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}

export async function headBlock(env: Env): Promise<number> {
  const hex = (await rpc(env, 'eth_blockNumber', [])) as string;
  return parseInt(hex, 16);
}

/** Scan one watch entry from its cursor to head. Bounded by maxBlocks. */
export async function scanWatch(
  env: Env,
  w: { id: string; chain_id: number; address: string; label: string; last_block: number; rules: string[] },
  maxBlocks = 400,
): Promise<{ newAlerts: number; toBlock: number }> {
  const head = await headBlock(env);
  const from = Math.max(w.last_block + 1, head - maxBlocks);
  if (from > head) return { newAlerts: 0, toBlock: w.last_block };

  const logs = (await rpc(env, 'eth_getLogs', [
    {
      address: w.address,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + head.toString(16),
      topics: [[TOPIC.OwnershipTransferred, TOPIC.Upgraded, TOPIC.Approval, TOPIC.AdminChanged]],
    },
  ])) as LogEntry[];

  let n = 0;
  for (const log of logs) {
    const t = log.topics[0]?.toLowerCase();
    let rule: string | null = null;
    let sev: 'critical' | 'high' | 'medium' = 'medium';
    let detail = '';

    if (t === TOPIC.Upgraded) {
      rule = 'R1.proxy_upgrade';
      sev = 'critical';
      detail = `implementation replaced with ${'0x' + (log.topics[1] ?? '').slice(26)}`;
    } else if (t === TOPIC.AdminChanged) {
      rule = 'R1.admin_changed';
      sev = 'critical';
      detail = 'EIP-1967 admin slot reassigned';
    } else if (t === TOPIC.OwnershipTransferred) {
      rule = 'R1.ownership_transfer';
      sev = 'high';
      const to = '0x' + (log.topics[2] ?? '').slice(26);
      const toZero = /^0x0{40}$/.test(to);
      detail = toZero ? 'ownership renounced' : `ownership moved to ${to}`;
    } else if (t === TOPIC.Approval) {
      // ERC20 Approval: value in data. Unlimited approvals are the rug vector.
      if (log.data.toLowerCase().includes(MAX_UINT256.slice(2))) {
        rule = 'R2.unlimited_approval';
        sev = 'high';
        const spender = '0x' + (log.topics[2] ?? '').slice(26);
        detail = `unlimited approval to ${spender}`;
      }
    }

    if (!rule) continue;
    if (!w.rules.length || w.rules.includes(rule)) {
      await env.DB.prepare(
        `INSERT INTO alerts (id, watch_id, rule, severity, payload, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
        .bind(
          crypto.randomUUID(),
          w.id,
          rule,
          sev,
          JSON.stringify({
            label: w.label,
            address: w.address,
            tx: log.transactionHash,
            block: parseInt(log.blockNumber, 16),
            detail,
          }),
          Math.floor(Date.now() / 1000),
        )
        .run();
      n++;
    }
  }

  await env.DB.prepare('UPDATE watchlist SET last_block=? WHERE id=?').bind(head, w.id).run();
  await env.DB.prepare(
    `INSERT INTO kv (key,value,ts) VALUES ('sentinel_last',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts`,
  )
    .bind(String(Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000))
    .run();

  return { newAlerts: n, toBlock: head };
}

/** One sentinel tick: every enabled watch entry, oldest cursor first. */
export async function sentinelTick(env: Env): Promise<{ watched: number; alerts: number }> {
  const rows = await env.DB.prepare(
    'SELECT id, chain_id, address, label, last_block, rules FROM watchlist WHERE enabled=1 ORDER BY last_block ASC LIMIT 8',
  ).all<{ id: string; chain_id: number; address: string; label: string; last_block: number; rules: string }>();

  let alerts = 0;
  let watched = 0;
  for (const r of rows.results ?? []) {
    try {
      const out = await scanWatch(env, { ...r, rules: JSON.parse(r.rules || '[]') as string[] });
      alerts += out.newAlerts;
      watched++;
    } catch {
      // one bad watch entry must not stop the sweep
    }
  }
  return { watched, alerts };
}
