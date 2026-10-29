// Probe: does the */5 cron actually ENTER the desk sweep?
// Not a test — a one-off instrument to confirm the cron-reachability test is not
// passing on an incidental truthy value. Prints exactly what the desk wrote.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const index = (await import('../build/index.js')).default;
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

const api = {
  prepare(sql) {
    const st = raw.prepare(sql);
    const b = (bb) => ({
      first: async () => st.get(...bb) ?? null,
      run: async () => st.run(...bb),
      all: async () => ({ results: st.all(...bb) }),
      bind: (...x) => b(x),
    });
    return b([]);
  },
};
const env = { DB: api, DESK_EQUITY_START_USD: '10000', DESK_TICK_PROBE: '1' };

await index.scheduled({ cron: '*/5 * * * *' }, env, {
  waitUntil: (p) => p,
  passThroughOnException: () => {},
});
await new Promise((r) => setTimeout(r, 1500));

console.log('--- desk_subrequests quota:', JSON.stringify(raw.prepare("SELECT * FROM quota WHERE bucket='desk_subrequests'").all()));
console.log('--- heartbeats:', JSON.stringify(raw.prepare('SELECT * FROM heartbeats').all()));
console.log('--- desk_universe rows:', raw.prepare('SELECT COUNT(*) AS n FROM desk_universe').get().n);
console.log('--- desk_scores rows:', raw.prepare('SELECT COUNT(*) AS n FROM desk_scores').get().n);
console.log('--- desk_kills rows:', raw.prepare('SELECT COUNT(*) AS n FROM desk_kills').get().n);
console.log('--- ledger desk kinds:', JSON.stringify(raw.prepare("SELECT kind FROM ledger WHERE kind LIKE 'desk.%'").all()));
