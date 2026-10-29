# Operating Asterion

How to actually use it. Not what it does — how to get value from it.

---

## The mental model

You are not running a scanner. You are running a **pipeline with one narrow
gate**, and the gate is the product.

```
discovery ──► ranking ──► leads ──► attempts ──► [PROOF] ──► queue
                        (corpus)   (PoCs)      only here      (proven only)
```

Most automated security tooling fails at the gate: it reports everything and
lets you triage. This refuses to report anything it cannot demonstrate. That
means **an empty queue is a healthy queue**, and a non-empty one is worth your
afternoon.

---

## Daily: 2 minutes

### Morning (one push, 06:30 UTC)

```
BRIEFING  2026-10-29
──────────────────────
new alerts      2
proven          0
huntable        97 programs
```

`proven 0` most days is correct. `new alerts 2` is what matters — something
moved on a contract you're watching.

### Midday: one action

Pick exactly one of these, not all four:

| If you have… | Do this | Time |
|---|---|---|
| 10 minutes, phone only | Tap **Playbooks** → one → **Hunt this** | 30 sec |
| 30 minutes, a laptop | Run `prove` workflow on a real repo | 10 min |
| A Sentinel alert | Read the governance forum first | 5 min |
| Nothing | **Do nothing.** That is the correct move. | 0 |

### Evening: zero actions

The crons handle discovery, sentinel, briefing, dead-man's switch. If you did
nothing today the system still moved forward.

---

## The three habits that make this work

### 1. Hunt the strongest ground truth first

Open **Eval**. Sort by `2024+`. The corpus says:

| class | recent severe | what it means |
|---|---|---|
| `sol.inflation` | 2,750 | share/accounting bugs still pay |
| `sol.accesscontrol` | 2,199 | missing authz is not solved |
| `sol.rounding` | 1,836 | truncation keeps producing findings |
| `sol.dos` | 1,604 | griefing still lands |
| `sol.oracle` | 1,105 | spot-price reads still ship |

Hunt top-down. Do not start at `sol.signature` (609) because it sounds
exciting. The corpus is 13,000 audits telling you where the money still is.

### 2. Never report a `partial`

A `partial` means: the bug reproduced, but causality was not established.
That is not a finding. It is a lead with a working repro — which is genuinely
valuable, just not to a program.

What you do with a `partial`:

```
1. open the artifact, find the failing assertion
2. find the control test — did it pass?
   no  -> the fixture is broken; fix the fixture
   yes -> the attack caused it; you need the impact measured
3. edit the PoC to measure before/after
4. re-run
```

When it flips to `proven`, the claim string is the report's title. It was
ever written by a model — it was produced by a judge reading a test result.

### 3. Let silence be silence

If the queue is empty for a week, resist the urge to loosen the gate. The
gate is the only reason your reports get read. One false positive costs more
than a week of silence.

---

## Choosing what to hunt

### On web3 (strongest path)

Pick a protocol with:

- deployed on Base (that is what Sentinel watches)
- verified source on the explorer
- an active or recent audit (they care about security)
- a bug bounty you can find, even a small one

Then rank by the corpus, scan, and prove.

```
Playbooks → sol.inflation → Hunt this
```

What that actually does:

```
1. reads 4,512 historical findings of this class
2. pulls the top precedents for that class as priming (up to 250/class)
3. scans the target for the shape (balance-based accounting)
4. synthesises an attack+control pair
5. runs both on a fork
6. judges
```

Step 3 is where a human must sometimes step in: the generated harness has
`CHANGE_ME` where the real function signature goes. One edit. Then it is a
real test.

### On web2 (weaker, still real)

The corpus cannot validate web2 classes — it is entirely web3. So web2 hunts
have **no historical prior**. That does not make them worthless; it makes them
unranked. You are hunting blind, which is what everyone else does too.

Use web2 when:

- you found a self-hosted program with `automation: allowed`
- it has an API (the `web.idor` / `web.authz.function` surface)
- nobody else is looking (87% of programs are off-platform)

---

## Telegram: what each button really does

| Button | Real behaviour |
|---|---|
| **Start a hunt** | Shows how to prompt. One line is enough. |
| **Playbooks** | 25 hunts. Tapping one skips prompting entirely. |
| **Watchlist** | Sentinel's current targets and last block |
| **Approvals** | Anything waiting on you. Silently expires after 24h. |
| **Queue** | Proven findings only. Empty is normal. |
| **Status** | Liveness, counts, LLM budget bar |
| **Discovery** | allowed / not_mentioned / prohibited / unknown |
| **Briefing** | Today's summary on demand |
| **Corpus** | Ranks playbooks by measured precedent, then shows the real historical findings (2,500 precedents, 250/class). Tap a playbook → `precedentScreen` |

### The commands

Verified against the command dispatch in `app/src/index.ts:189-222`:

```
/start                  menu
/menu                   same as /start
/status                 liveness + counts
/corpus                 playbook ranking by measured precedent
/hunt <anything>        compile sloppy text into a brief
/precedent <topic>      the real historical findings behind a class
/seed host1 host2       queue hosts for policy discovery
```

Anything that is not one of the above is treated as a sloppy hunt request and
compiled into a brief. That is why a stray `/help` produces a hunt rather than
help text — there is no `/help`.

The desk commands (verified in `app/src/index.ts:255-283`):

```
/desk                   paper/live mode, equity, open positions, gate status
/desk paper | live      record a mode request; live cannot arm (see TRADING.md)
/pos                    open positions with live PnL
/kills                  last 50 kill reasons
/calib                  latest weekly calibration report
/thesis <mint>          the stored thesis for one token
```

They are read-only. `/desk live` records the request and the desk stays in paper.

`/hunt` is the one to learn. Examples that all work:

```
/hunt app.example.com
/hunt look at the api on api.example.com, be thorough
/hunt 0x9f8a3c21d4e5f60718293a4b5c6d7e8f90a1b2c3 check the vault
/hunt just map example.com, touch nothing
```

Each returns a brief with **one** button: Authorize.

---

## Reading a verdict

Four outcomes, and they mean exactly this:

| Verdict | Means | Your move |
|---|---|---|
| `proven` | reproduced + causal + measured | write the report |
| `partial` | reproduced, not causal | fix the counterfactual, re-run |
| `disproved` | the test passed: no bug | nothing. This is a good result. |
| `inconclusive` | never ran (compile, RPC, missing RPC) | fix infra, re-run |

**`disproved` is not a failure.** It is the system correctly telling you the
code is fine. Every `disproved` is a bug you did not send to a program and a
reputation you did not spend.

---

## The workflow that earns money

This is the sequence, in order, with realistic timing.

### Week 1 — build the machine

```
setup → verify /health → /start in Telegram → let crons run 48h
```

Do not hunt yet. Let discovery fill the queue and Sentinel establish a
baseline. Check the ledger is `intact`.

### Week 2 — first real hunt

```
Discovery → find a program with automation: allowed
Playbooks → sol.inflation → Hunt this → Authorize
```

Expect: leads found, attempts generated, most `inconclusive` because of
`CHANGE_ME`. That is the tool teaching you the target's shape.

### Week 3 — first proof attempt

```
Actions → prove → repo, commit, contract, fork_block
```

Expect: 1–2 `partial`. Open the artifact. Fix the function signature. Re-run.

### Week 4–6 — first paying finding

A `proven` verdict lands in the queue. You write the report using:

- **title** = the claim string from the judge
- **repro** = the artefact link (a failing test someone else can run)
- **impact** = what the measured before/after shows
- **remediation** = the playbook's `proof` sentence inverted

Send it. Direct, to the program, not to a platform.

### Month 2–3 — compounding

- 3–5 programs with real relationships
- Sentinel has caught something, or clearly would have
- Your own detection signals are accumulating in `findings`
- You start charging for monitoring, not findings

The retainer is the actual prize. Findings are lumpy; monitoring is recurring.

---

## What NOT to do

| Don't | Why |
|---|---|
| Submit a `partial` | It is not proven. One of these gets you ignored. |
| Loosen the gate because the queue is empty | The gate is the asset |
| Hunt `prohibited` programs | One request and you are done |
| Use a public RPC for proofs | Archive state needed; you get `inconclusive` |
| Run `-jsl` on Katana or scan >10 hosts per Nuclei run | Rams the target, gets you banned |
| Submit to Immunefi/Code4rena with this | Their terms ban AI-generated reports |
| Trust a `proven` without reading the artefact | The judge is code; read the test |

---

## Weekly review (10 minutes, Sunday)

1. **Status** — is the worker `alive`? Is the LLM budget sane?
2. **Ledger** — `integrity intact`? If not, something tampered; investigate.
3. **Eval** — did the nightly run complete? Which class is weakest?
4. **Queue** — anything `proven` unreported? Report it.
5. **Discovery** — how many moved to `allowed`? Seed more hosts if flat.

Then one decision: **which class do I hunt next week?** Answer from the eval
table, not from intuition.

---

## When something looks wrong

### "The queue has been empty for two weeks"

Normal. Check `prove` artifacts: are you getting `partial`? If yes, the gate is
working and you need to fix fixtures, not the gate.

### "Sentinel hasn't fired"

Check `Status → sentinel`. If it says `never`, the cron is not running. If it
says `5 min ago` and no alerts, your watchlist is quiet — add contracts.

### "Every proof is inconclusive"

Ninety percent of the time: `FORK_RPC` is missing or not archive. Check the
workflow log for `createSelectFork` failure.

### "Discovery found nothing"

`security.txt` is still rare. Check `Discovery → unknown` count. If unknown is
high, those hosts simply have no policy file — that is data, not a bug. Seed
hosts you already know have bounties.

### "The bot stopped replying"

```bash
curl -s https://<worker>/health
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | python3 -m json.tool
```

Webhook `last_error_message` names the problem. Usually a missing Worker
secret after a redeploy.

---

## Automation surface: what runs by itself

Five cron triggers, the free-plan ceiling. Verified from `app/wrangler.toml:42-49`
and the dispatch in `app/src/index.ts:162-175`.

| Cron | UTC | Handler | Does | Heartbeat source |
|---|---|---|---|---|
| `*/5 * * * *` | every 5 min | `runSentinel` + `deskTick` | scans the watchlist; desk scout+filter | `kv:sentinel_last` |
| `0 * * * *` | hourly | `runCrawler` + `deskAnalystTick` | discovery tick; desk analyst scoring | — |
| `15 3 * * *` | 03:15 daily | `runMaintenance` + `runCalibration` | ledger verify, expire approvals; weekly desk calibration | — |
| `0 */6 * * *` | every 6 h | `runDeadman` | dead-man's switch: alerts if the sentinel has been silent >2h | — |
| `30 6 * * *` | 06:30 daily | `runBriefing` | the daily Telegram briefing | — |

Every one of these writes a heartbeat first (`heartbeat(env, 'cron')`,
`app/src/index.ts:166`). If a cron fails, the `.catch` at
`app/src/index.ts:173` logs `cron failed <cron> <error>` to the Worker log and
**does not** message you. That is deliberate — a failing cron that also spams
chat is worse than a silent one — but it means the log is where you look.

### What the heartbeats mean

Two tables, and they answer different questions.

`heartbeats(source TEXT PRIMARY KEY, ts, note)` — one row per source, upserted.
Current writers: `cron` (every trigger, before dispatch) and `crawler`/`sentinel`
from their own paths. Read it as *"when did this last even start"*.

`kv(key, value, ts)` — the running state. Two keys matter operationally:
`cron_last` (last cron tick of any kind) and `sentinel_last` (last sentinel scan).
`runDeadman` reads `sentinel_last` and fires if it is more than 2 hours stale.

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT source, datetime(ts,'unixepoch') AS last FROM heartbeats ORDER BY source"
```

Expected on a healthy box: `cron` within 5 minutes, `sentinel` within 5 minutes.

```bash
npx wrangler d1 execute asterion --remote --command \
  "SELECT key, datetime(ts,'unixepoch') AS last FROM kv WHERE key IN ('cron_last','sentinel_last')"
```

### When a cron goes silent

Work down this list; each step tells you which layer is broken.

1. **Is the Worker alive?**
   `curl -s https://asterion.<subdomain>.workers.dev/health` → `{"ok":true,...}`
   No response means the deploy is broken, not the cron.
2. **Does Cloudflare think the triggers exist?**
   `npx wrangler deployments list` then check the dashboard **Triggers** tab.
   A cron missing here means `wrangler.toml` was edited and never redeployed.
3. **Did the last tick run at all?**
   The `heartbeats` query above. A stale `cron` row means Cloudflare is not
   invoking — steps 1-2. A fresh `cron` row with a stale `sentinel_last` means
   the trigger fires and `runSentinel` throws; go to step 4.
4. **Read the error.** Dashboard → Workers & Pages → `asterion` → **Logs**
   (or `npx wrangler tail`). Look for `cron failed`, `sentinel`, `crawler`.
   The three causes in order of frequency: D1 write failure, RPC timeout, and a
   missing Worker secret after a redeploy.
5. **Is D1 writable?**
   ```bash
   npx wrangler d1 execute asterion --remote --command \
     "INSERT INTO heartbeats (source, ts) VALUES ('manual-probe', strftime('%s','now'))"
   ```
   A write error here is a D1 quota or permission problem, not a cron problem.

### Cost per run

The design target is $0/month, and the caps are what enforce it. Verified vars
from `app/wrangler.toml:53-62`:

| Var | Default | Enforced where |
|---|---|---|
| `DAILY_LLM_BUDGET` | `200000` tokens | `app/src/llm.ts:99-113` — checked before a call, incremented after |
| `DAILY_SUBREQUEST_BUDGET` | `40000` | `quota` table, bucket `subrequests` |
| `ALERT_FLOOR` | `medium` | `app/src/index.ts:717` — alerts below the floor are recorded but not pushed |

Costs that can actually appear:

- **Workers / D1 / R2 / Pages**: $0 while inside free tiers. The sentinel at
  288 runs/day and the crawler at 24/day are two orders of magnitude under the
  100k req/day ceiling.
- **GitHub Actions**: $0 on a public repo. `prove.yml` runs on a 300-minute
  ceiling.
- **RPC**: $0 on a free tier. Exceeding it makes proofs `inconclusive`; it does
  not produce a bill.
- **LLM**: $0 while `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY`
  point at free tiers. The token budget is the guard, and it is a *daily* reset,
  so a runaway loop costs one day of free quota, not money.

Read today's spend:

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT bucket, used, cap FROM quota WHERE day = date('now')"
```

If `used` / `cap` is above ~0.8 every day, the budget is doing the work of
stopping you — that is the signal to cut a cron frequency, not to raise the cap.

### Pausing the desk in one command

The desk is paper-only until armed, so there is nothing to pause for safety. To
stop paper fills while you change a threshold:

```bash
cd app && npx wrangler secret delete DESK_LIVE && npx wrangler deploy
```

> <!-- UNVERIFIED -->
> `DESK_LIVE` is not in this tree yet (`grep -rn DESK_LIVE app/src/` → no
> matches), so this command is written from the build spec and was not run.
> See `TRADING.md` §8 and §Unverified.

To pause the **security** bot's autonomous work, delete nothing — raise the alert
floor instead, which leaves discovery and the ledger intact:

```bash
cd app
npx wrangler secret put ALERT_FLOOR   # value: critical
```

---

## The one number to watch


Not findings. Not programs. **Days running.**

Most people who build this quit in week 5, right before the first proof. The
machine compounds only if it is still alive in week 12. That is why the
dead-man's switch exists, why silence is a feature, and why the daily routine
is two minutes instead of two hours.

Keep it running. Everything else follows.
