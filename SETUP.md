# Setup — complete, in order, nothing to look up

Every command and every value lives here. If a step references a secret, the
value is either given or the exact page that generates it is named.

Total time: about 35 minutes, most of it waiting for GitHub to run the first
deploy.

---

## 0. What you need before starting

| Thing | Where to get it | Cost |
|---|---|---|
| Cloudflare account | dash.cloudflare.com | free |
| GitHub account | github.com | free |
| Telegram account | mobile app | free |
| A bot token | talk to `@BotFather` in Telegram | free |
| A Base RPC URL | `https://mainnet.base.org` works, or Alchemy free tier | free |
| Optional: Groq key | console.groq.com | free tier |
| Optional: Gemini key | aistudio.google.com | free tier |

You do not need a domain. You do not need a credit card.

---

## 1. Create the Telegram bot (2 min)

1. Open Telegram, search `@BotFather`
2. Send `/newbot`
3. Name: `Asterion` — username must end in `bot`, e.g. `asterion_hunt_bot`
4. BotFather replies with a token:

```
7123456789:AAH3xK9mP2qR7sT4uV6wX8yZ1aB3cD5eF7g
```

**Save this. It is the `TELEGRAM_BOT_TOKEN`.**

5. Send `/setprivacy` → select your bot → `Disable`. This lets the bot read
group messages later if you want a team chat.

### Get your chat ID

1. Send any message to your new bot
2. Open this URL in a browser, replacing the token:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

3. Find `"chat":{"id":123456789,...}` — that number is your **`TELEGRAM_CHAT_ID`**.

If the response is `{"ok":true,"result":[]}`, send another message and reload.

---

## 2. Create the GitHub repo (2 min)

```bash
git init asterion && cd asterion
git remote add origin https://github.com/<you>/asterion.git
```

Copy the project in (the folder containing `app/` and `.github/`), then:

```bash
git add -A && git commit -m "asterion v1+v2" && git push -u origin main
```

**Make the repo public** if you want unlimited free Actions minutes. Private
repos get 2,000 min/month, which is still enough for this — but fuzzing runs
eat that fast. Settings → General → Change visibility.

---

## 3. Create the Cloudflare API token (5 min)

Go to `dash.cloudflare.com/profile/api-tokens` → **Create Token** → scroll down
→ **Create Custom Token**. Use the **six** permissions below. Do not use the
"Edit Cloudflare Workers" template: it has no D1 and no Pages.

| Scope | Permission | Access |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Cloudflare Pages | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Account Settings | Read |
| Account | Workers Tail | Read |

- **Account Resources:** Include → your account only
- **Zone Resources:** leave as-is (grants nothing, you have no zone permissions)
- **TTL:** 6 months
- **Client IP filtering:** leave blank (GitHub runner IPs rotate)

Click through to the summary. Verify it lists exactly six permissions and one
account. Create, then **copy the token once** — it is never shown again.

### Get your Account ID

Dashboard → press `Ctrl/Cmd + K` → type `Copy account ID` → enter. It is 32
lowercase hex characters:

```
b9e510810e1e12fcd40826d266a1fb12
```

Not 40 characters (that would be the token), not uppercase.

---

## 4. Add GitHub secrets and the repo variable (5 min)

Repo → **Settings → Secrets and variables → Actions**.

### Secrets (13 → add the ones you have)

Two stores, and they are not the same store. **GitHub secrets** feed the workflow;
**Worker secrets** are what the running code reads. A secret in only one place
fails in a way that looks like a code bug. The deploy workflow already copies the
GitHub ones into the Worker (§6), so adding them here is usually enough.

| Name | What it is for | Value | Required |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | lets the workflow deploy the Worker and apply schema | from step 3 | **yes** |
| `CLOUDFLARE_ACCOUNT_ID` | which account to deploy into | from step 3 | **yes** |
| `TELEGRAM_BOT_TOKEN` | authenticates every Bot API call the Worker makes | from step 1 | **yes** |
| `TELEGRAM_CHAT_ID` | the one chat allowed to talk to the bot (`guard()` refuses others) | from step 1 | **yes** |
| `TELEGRAM_WEBHOOK_SECRET` | lets `/tg` reject any POST that is not from Telegram | invent: `openssl rand -hex 24` | recommended |
| `PROOF_HOOK_SECRET` | authenticates the `prove.yml` → `/hook/proof` callback. **Fail-closed:** unset means the endpoint returns 503 and *no finding can ever be created* | invent: `openssl rand -hex 32` | **yes for findings** |
| `RPC_URL` | the chain RPC for sentinel log scans | `https://mainnet.base.org` | recommended |
| `FORK_RPC` | archive RPC for `forge test --fork-url`; must serve historical state | Alchemy/Infura free tier | for V2 proofs |
| `GEMINI_API_KEY` | first-choice LLM provider | aistudio.google.com | optional |
| `GROQ_API_KEY` | second-choice LLM provider | console.groq.com | optional |
| `OPENROUTER_API_KEY` | third-choice LLM provider | openrouter.ai | optional |
| `CF_EVAL_TOKEN` | not read by any code in this tree | leave empty | optional |

**The three LLM keys are genuinely optional.** `llm.ts` falls through the
providers it has and degrades to no-LLM paths when none are set; nothing in the
trust chain depends on a model being available. If you set none, you lose prose
quality and keep every deterministic gate.

### Worker secrets for the desk

The desk reads its own env slice (`DeskEnv` in `app/src/desk/types.ts`), kept
separate so desk code cannot read chain keys. **In paper mode you need none of
these.** They matter only when you consider arming (§12.3), and setting them in
the wrong order does nothing — `arming.ts` requires *all* gates at once.

| Name | What it is for | Paper | Live |
|---|---|---|---|
| `DESK_LIVE` | the arming switch. Must be exactly `1` | unset | **required** = `1` |
| `DESK_CAPITAL_CAP_USD` | hard ceiling on capital; arming gate 6 requires a positive number | unset | **required** |
| `DESK_SIGNER_URL` | HTTP endpoint of the isolated signer | unset | **required** |
| `DESK_SIGNER_KEY` | **never set this.** Its presence means the private key is readable by the request handler, which `arming.ts` treats as a *failed* gate | unset | **must stay unset** |
| `DESK_EQUITY_START_USD` | starting paper equity (default `10000`) | optional | optional |
| `DESK_PRIO_FEE_USD` | priority fee per transaction, in USD | optional | optional |
| `DESK_PRIO_FEE_CAP_USD` | per-trade priority-fee cap | optional | recommended |
| `DESK_RPC_URL` | Solana RPC for pool/holder reads | optional | recommended |
| `DESK_DEXSCREENER_BASE` | override the DexScreener base URL | optional | optional |
| `DESK_DAILY_SUBREQUEST_CAP` | desk's own subrequest budget | optional | optional |
| `DESK_MODE` | **does nothing.** Declared in `DeskEnv` but never read — mode comes from `armState()`, which reads the `desk_mode` KV key plus the seven arming gates. Setting this variable has no effect | ignored | ignored |

Set a desk optional var like any other Worker secret:

```bash
cd app
npx wrangler secret put DESK_EQUITY_START_USD   # e.g. 10000
```

**Do not set `DESK_LIVE` during setup.** Setup leaves the desk in paper mode, which
is the only mode in which its numbers are free to be wrong. §12.3 has the arming
checklist, and it takes at least 30 days of paper history to satisfy.

`FORK_RPC` needs archive access. `mainnet.base.org` will not serve historical
state for `forge test --fork-url`. Alchemy's free tier does. If you skip it,
V2 proof runs fail and will report `inconclusive` — which is the correct,
honest outcome, not a silent success.

### The two secrets the deploy workflow does NOT push

`GITHUB_DISPATCH_TOKEN` and `GITHUB_REPO` are read by `app/src/dispatch.ts:565-566`
and are **not** in the `push runtime secrets` step of `deploy.yml`. If you only add
them as GitHub secrets, nothing copies them into the Worker, `Authorize` refuses,
and no proof ever runs. Verified:

```
$ grep -n 'GITHUB_DISPATCH\|GITHUB_REPO' .github/workflows/deploy.yml
(no output — they are not pushed)
$ grep -n 'GITHUB_DISPATCH_TOKEN\|GITHUB_REPO' app/src/dispatch.ts
565:  if (!deps.env.GITHUB_DISPATCH_TOKEN) missingVars.push('GITHUB_DISPATCH_TOKEN');
566:  if (!deps.env.GITHUB_REPO) missingVars.push('GITHUB_REPO');
```

Set them as **Worker** secrets by hand, once, after the first deploy:

```bash
cd app
npx wrangler secret put GITHUB_DISPATCH_TOKEN   # fine-grained PAT, Actions: write on the repo
npx wrangler secret put GITHUB_REPO             # owner/name, e.g. morluto/asterion
# optional: npx wrangler secret put GITHUB_REF   # branch/tag holding prove.yml, defaults to main
```

**Check it worked:**

```bash
cd app
npx wrangler secret list
# GITHUB_DISPATCH_TOKEN and GITHUB_REPO must both appear
```

The good news is the failure is loud, not silent. `dispatch.ts:567-584` refuses
with a Telegram message naming the exact missing variables and sends nothing —
there is no path where an approval is swallowed and you wait forever. See the
smoke test in §7.

### Variable (1)

| Name | Value | Where |
|---|---|---|
| `WORKER_URL` | `https://asterion.<your-subdomain>.workers.dev` | GitHub **variable** |
| `DASH_ORIGIN` | `https://asterion.pages.dev` | `app/wrangler.toml` `[vars]` — see §8c |

Add `WORKER_URL` **after** step 6, once you know your subdomain. Push an empty
commit to re-run the workflow, or re-run it from the Actions tab.

---

## 5. Create the Cloudflare resources (3 min)

On your phone or laptop, with `wrangler` installed (`npm i -g wrangler`):

```bash
cd app
npm install
npx wrangler login          # opens a browser, authorises

npx wrangler d1 create asterion
```

It prints:

```toml
[[d1_databases]]
binding = "DB"
database_name = "asterion"
database_id = "a1b2c3d4-5e6f-7890-abcd-ef1234567890"
```

**Copy that `database_id` into `app/wrangler.toml`,** replacing
`00000000-0000-0000-0000-000000000000`.

```bash
npx wrangler kv namespace create FLAGS
```

Prints an `id`. **Paste it into `app/wrangler.toml`,** replacing
`00000000000000000000000000000000`.

```bash
npx wrangler r2 bucket create asterion-backups
npx wrangler d1 execute asterion --remote --file=./schema.sql
```

Expect the output to end in `Executed 63 queries` (29 `CREATE TABLE` +
26 `CREATE INDEX` + the rest of the idempotent file). Verified counts in this
tree:

```
$ grep -c '^CREATE TABLE' app/schema.sql
29
$ grep -c '^CREATE TABLE IF NOT EXISTS desk_' app/schema.sql
7
$ grep -c '^CREATE INDEX' app/schema.sql
26
```

**Check it worked** — this must print 29:

```bash
npx wrangler d1 execute asterion --remote --command \
  "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
```

The 7 `desk_` tables are created by this same command; there is no second
migration step. If you want to confirm them specifically, see §5a.

### 5a. Confirm the desk tables (30 sec)

The Solana desk stores its state in seven tables, all prefixed `desk_`, all in
the file you just applied. Its working data never touches `findings` — the
schema header explains why: a `proven` finding has to keep meaning "an
exploitable bug", not "a token that pumped".

| Table | Holds |
|---|---|
| `desk_universe` | every mint Scout admitted, with the metrics that admitted it |
| `desk_scores` | Analyst's 0–100 score, every sub-score, and the stored `why` |
| `desk_kills` | every rejection: reason code + full snapshot + a calibration `outcome` |
| `desk_positions` | open/closed positions, `mode` per row, stop, peak, trail state |
| `desk_fills` | append-only fills incl. the split entry legs and modelled fees |
| `desk_theses` | thesis prose and whether an LLM wrote it |
| `desk_calibration` | weekly per-reason-code hit rate and false negatives |

**Check it worked** — this must print exactly 7 rows:

```bash
npx wrangler d1 execute asterion --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'desk_%' ORDER BY name"
```

Expected:

```
desk_calibration
desk_fills
desk_kills
desk_positions
desk_scores
desk_theses
desk_universe
```

Proofs and desk state are deliberately separate claims in separate tables.
Nothing in `SETUP.md` arms the desk; it starts in paper mode and stays there
until §12.3 is worked through.

### Claim your subdomain — do this before the first deploy

Dashboard → **Workers & Pages** → right sidebar → **Your subdomain** → **Change**
→ pick e.g. `asterion-jennifer` → Save.

Without this the first deploy fails with:
`Your account has no workers.dev subdomain yet`.

---

## 6. Push, and let CI do the rest (2 min + build time)

```bash
git add -A && git commit -m "wire resources" && git push
```

The `deploy` workflow runs, in this order, and **stops on the first failure**:

```
install → typecheck → 40 gate tests → apply schema
        → push Worker secrets → deploy Worker → set Telegram webhook
```

There is no path where a broken policy engine reaches production: the gate
tests must pass before the deploy step is even scheduled.

Watch it at **Actions → deploy**. Green means done.

---

## 7. Verify (2 min)

### The bot answers

Send `/start` to your bot in Telegram. You should get:

```
ASTERION  v1
──────────────────────
operator   jennifer
mode       read-only until you approve
──────────────────────
```

If nothing arrives, run this with your token:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | python3 -m json.tool
```

- `"url": ""` → the webhook was never set; re-run the deploy workflow
- `"last_error_message": "Wrong response from the webhook: 500"` → a Worker
  secret is missing; check `npx wrangler secret list`
- `"pending_update_count": 40` → the Worker is not reachable; check
  `https://<your-worker>.workers.dev/health`

### The Worker is alive

```bash
curl -s https://asterion.<subdomain>.workers.dev/health
# {"ok":true,"ts":1793230109308}
```

### The database is real

```bash
npx wrangler d1 execute asterion --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Should list 29 tables, including `hunts`, `proofs`, `corpus_digest` and the
seven `desk_*` tables.

### The corpus is loaded

```bash
npx wrangler d1 execute asterion --remote --command "SELECT version, source_rows FROM corpus_digest"
```

If that is empty, load it with the helper. It reads the version and row count
straight out of the digest, so it cannot drift when the digest is rebuilt:

```bash
cd app
node scripts/load-corpus.mjs --apply
```

The `--check` mode validates the digest invariants and writes nothing — it is
what CI runs, and the verified output in this tree is:

```
$ node scripts/load-corpus.mjs --check
note: per-class n totals 46677, digest reports 181357 source rows (134680 rows belong to no playbook class)
this digest is a merge of 3 source(s):
  · ghsa  258 rows  v2->  licence CC-BY-4.0
  · nvd  192 rows  v3->  licence public-domain (US Government work)
  · union of v2 + v3 + v4  0 rows  v4->  licence see attribution.data_licence
--check: digest is valid; nothing written
(exit 0)
```

### The crons are registered

There are five triggers (`app/wrangler.toml:42-49`) and five is the free-plan
ceiling. If a sixth is ever added the deploy fails, so this is worth confirming
once rather than debugging later.

```bash
cd app
npx wrangler deployments list
```

Then Dashboard → Workers & Pages → `asterion` → **Triggers**. You should see all five:

| Cron | Handler | What it does |
|---|---|---|
| `*/5 * * * *` | `runSentinel` | scans the watchlist, pushes alerts above `ALERT_FLOOR` |
| `0 * * * *` | `runCrawler` | one discovery tick (≤20 programs) |
| `15 3 * * *` | `runMaintenance` | ledger verify, expire stale approvals |
| `0 */6 * * *` | `runDeadman` | alerts if the sentinel has been silent >2h |
| `30 6 * * *` | `runBriefing` | the daily Telegram briefing |

**Check it worked** — after 10 minutes the heartbeat table must show a fresh
`cron` row:

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT source, datetime(ts,'unixepoch') AS last FROM heartbeats ORDER BY source"
```

Expected: a `cron` row within the last 5 minutes. A missing row means the trigger
is registered but the Worker is throwing before dispatch — check
`npx wrangler tail` for `cron failed`.

### The dispatch round-trips (the smoke test that matters)

This is the one test that proves the whole chain works: Telegram → policy gate →
GitHub Actions → `prove.yml` → callback → a verdict row. Everything else can be
green while this is broken.

**Step 1 — does the Worker think it is configured?** In Telegram, send a hunt and
approve it:

```
/hunt just map example.com, touch nothing
```

Tap **Authorize**. One of three things happens:

| What you see | Meaning |
|---|---|
| `missing configuration GITHUB_DISPATCH_TOKEN, GITHUB_REPO` | the two Worker secrets from §4 are not set — fix, then approve again |
| a refusal from policy naming a reason | the gate is working; pick a target whose policy allows it |
| `dispatched` + a run link | good — go to step 2 |

**Step 2 — did GitHub actually receive it?**

```bash
gh run list --workflow=prove.yml --limit 3
```

Expected: a `prove` run, `queued` or `in_progress`, triggered by `workflow_dispatch`.
No run means the token lacks **Actions: write** on the repo.

**Step 3 — did the verdict come back?** The callback is fail-closed on
`PROOF_HOOK_SECRET`, so this is also the test that the secret matches on both
sides:

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT id, kind, datetime(ts,'unixepoch') AS at FROM ledger WHERE kind LIKE 'proof%' ORDER BY ts DESC LIMIT 5"
```

Expected: a `proof.*` line within a few minutes of the run finishing. If the run
succeeded but no ledger line appeared, the callback was refused — see §10
Prerequisites for the exact two failure messages.

**A `partial` or `inconclusive` verdict here is a pass.** The smoke test is
proving the *plumbing*, not the bug. What would be a fail is silence.

---

## 8. Deploy the dashboard (5 min)

> **Paths changed.** Earlier revisions of this file said `v1/dashboard`. `v1/` no
> longer exists — it was archived into `_archive/` and removed during the merge.
> The dashboard lives at `app/dashboard/`. Every command below was run from the
> `app/` directory in this tree.

### 8a. Deploy it

```bash
cd app/dashboard
npx wrangler pages deploy . --project-name=asterion
```

First run asks you to create the project: accept. It prints a URL like
`https://asterion.pages.dev`.

### 8b. Point it at the Worker

Edit `app/dashboard/index.html`, find this near the top of the script block:

```js
const API = window.ASTERION_API || '';
```

Set it to your Worker URL:

```js
const API = window.ASTERION_API || 'https://asterion.<subdomain>.workers.dev';
```

### 8c. Allow that origin through CORS — required, or the deck renders empty

Pages and the Worker are **different origins**, so the browser blocks every
`fetch` unless the Worker allows your Pages origin. Set it as a var:

Set it in `app/wrangler.toml` under `[vars]`, then redeploy the Worker:

```toml
DASH_ORIGIN = "https://asterion.pages.dev"
```

Multiple origins are comma-separated. `*` is refused by the code — a wildcard
would let any page read your findings and ledger once the URL leaks. If the deck
is blank, open the browser console: a CORS message means `DASH_ORIGIN` does not
exactly match the page origin (scheme and port count).

### 8d. The auth decision — read this, don't skip it

`/api/*` is bearer-gated by `DASHBOARD_TOKEN`, but **no static page can hold a
bearer token secretly** — anyone who loads the HTML can read it. So there are
only two honest options:

**Option A (recommended).** Keep `/api/*` token-gated for machine clients, and put
the dashboard itself behind **Cloudflare Access** (Zero Trust free tier, up to 50
users) so a human must authenticate before the page loads at all. Static HTML
then holds no secret, and the token never appears in a URL.

**Option B.** Leave `DASHBOARD_TOKEN` unset and accept that `/api/*` is readable
by anyone who has the Worker hostname. Only sane on an unguessable `workers.dev`
name, and only if you are willing to treat findings and ledger history as public.

What is **not** offered: a token in the page, a token in `?token=`. A URL token
lands in browser history, referrer headers and any proxy log, which is a leak with
extra steps.

If you choose A:

```bash
npx wrangler secret put DASHBOARD_TOKEN     # long random string, for scripts only
```

Then create an Access application over the Pages hostname in the Cloudflare
Zero Trust dashboard. The Worker keeps returning 401 to anything that does not
present the bearer, so an unauthenticated request never reaches the data.

---


## 9. Load the corpus and the program seed (2 min)

The corpus load now runs automatically on every deploy (it is the
`load the distilled corpus digest into D1` step in `deploy.yml`), so a fresh
deploy is no longer blind. The command below is for re-loading by hand after a
corpus rebuild; running it again is safe because the digest is versioned.

These are what make the bot know 180,907 findings and 2,500 programs instead of
starting from nothing.

```bash
cd v1

# 913 KB digest: 180,907 findings distilled to priors + 2,500 curated precedents (250/class × 10 classes)
node scripts/load-corpus.mjs --apply

# 2,500 programs, 15,013 in-scope assets, all marked automation=unknown
node scripts/seed-programs.mjs --apply
```

Verify:

```bash
npx wrangler d1 execute asterion --remote --command \
  "SELECT version, source_rows FROM corpus_digest"
# 2 | 180907    <- version 2 = 250 precedents/class; version 1 was 40/class

npx wrangler d1 execute asterion --remote --command \
  "SELECT COUNT(*) FROM programs"
# 2500

npx wrangler d1 execute asterion --remote --command \
  "SELECT automation, COUNT(*) FROM programs GROUP BY automation"
# unknown | 2500   <- correct. Nothing is auto-authorized.
```

**Why everything is `unknown`:** platform scope (HackerOne/Bugcrowd/Intigriti)
says an asset is in scope for a *human researcher*. It says nothing about
automated tools. Each program still needs its own policy fetched and classified
before a single request goes out. That is a deliberate gate, not an unfinished
step.

To make programs huntable, let discovery run (it does so hourly) or seed
specific hosts whose policies you already know:

```
/seed app.example.com
```

---

## 10. Run your first proof (the part that produces findings)

This is where a lead becomes provable or honest-fails.

### Prerequisites

**`PROOF_HOOK_SECRET` must be set on BOTH sides, or no finding can ever be created.**
`/hook/proof` is the only path that mints a finding, and it **fails closed**: with the
secret unset the Worker answers `503` and refuses every callback.

| where | what | how |
|---|---|---|
| GitHub repo secret | the runner sends `x-asterion-secret` | Settings → Secrets → Actions |
| Worker secret | the handler checks it | `echo "$VALUE" | npx wrangler secret put PROOF_HOOK_SECRET` |

`deploy.yml` mirrors the GitHub secret into the Worker automatically, so setting it in
GitHub and re-running deploy is enough. Check both sides agree:

```bash
npx wrangler secret list          # PROOF_HOOK_SECRET must appear
```

Symptom of a mismatch, in the Actions log: `PROOF_HOOK_SECRET not set; the Worker would
refuse this callback (fail-closed)`. Symptom in the Worker: a `503` on `/hook/proof` with
`proof hook refused: PROOF_HOOK_SECRET is not configured` in `wrangler tail`.

`FORK_RPC` must be an **archive** RPC. `https://mainnet.base.org` will not serve
historical state, and every proof will correctly report `inconclusive`.

Alchemy free tier works:

```
https://base-mainnet.g.alchemy.com/v2/<key>
```

### Run it

Actions → **prove** → Run workflow:

| Field | Example | Notes |
|---|---|---|
| `repo` | `https://github.com/org/protocol` | public clone |
| `commit` | `a1b2c3d...` | full SHA, not a branch |
| `contract` | `Vault` | must match `src/Vault.sol` |
| `fork_block` | `41287001` | a block where the protocol is live |
| `address` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | **the deployed contract**, not the repo. Leave blank only if the PoC deploys the contract itself |
| `hunt_id` | `hunt-001` | any string, for correlation |
| `fuzz_playbook` | `sol.reentrancy` | optional; enables fuzzer-guided seeding (V3) |

> **`address` is not optional in practice.** The generated PoC does
> `vm.envAddress("TARGET")`, so `TARGET` must be a 20-byte address. This used to
> be filled with `repo` (a git URL), which made `setUp` revert and every verdict
> come back `inconclusive`. If you see that verdict with
> "TARGET is not a valid address" in the log, this field is blank.

The run does, in order:

```
1. clone at the pinned commit
2. forge build
3. scan for leads (9 deterministic patterns)
4. rank by corpus prior — strongest ground truth first
5. synthesise attack + control test pairs
6. run every pair on the fork
7. judge each pair
8. POST verdicts to the Worker -> Telegram + database
```

### Reading the result

Artifacts → `proof-bundle` → `verdicts.json`:

```json
{
  "attempts": 6,
  "proven": 0,
  "partial": 1,
  "disproved": 4,
  "inconclusive": 1,
  "limitations": ["with-fix counterfactual not generated by this workflow"]
}
```

**First-run expectation: zero `proven`.** Every generated harness has a
`CHANGE_ME` where the real function signature belongs, because the tool refuses
to guess an assertion. A `partial` means the bug reproduced but the attack was
not isolated. Open the failing test, replace `CHANGE_ME` with the real function,
re-run. That single edit is the human-in-the-loop.

### What each verdict means

| Verdict | Meaning | Action |
|---|---|---|
| `proven` | reproduced + causal + measured | write the report |
| `partial` | reproduced, not isolated | fix the placeholder, re-run |
| `disproved` | test passed: no bug | nothing — this is a good result |
| `inconclusive` | never ran (build/RPC) | fix infra, re-run |

---

## 11. Daily operation (the 2-minute routine)

### Morning

Open Telegram. You get one push at 06:30 UTC:

```
BRIEFING  2026-10-29
──────────────────────
new alerts      2
proven          0
huntable        97 programs
──────────────────────
```

Tap **Queue** → if empty, that is correct and healthy. Tap **Discovery** → how
many programs are huntable vs prohibited.

### When you want to hunt

Tap **Playbooks** → pick one → **Hunt this** → **Authorize**. Three taps.

Or type one line: `look at app.example.com api`. You get a brief back with one
button.

### When Sentinel fires

```
◆ CRITICAL   Vault (proxy)
──────────────────────
rule    R1.proxy_upgrade
what    implementation replaced with 0x8f21…
addr    0x9f8a…3c21
block   41286997
```

That is a real signal, minutes old. Your options: check the protocol's
governance forum, or tap a playbook to test the new implementation.

### Weekly

- `/status` — liveness, budget bars
- Check the ledger tab: `integrity intact`
- Look at the eval tab: which class has the most ground truth? Hunt that one.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Authentication error [code: 10000]` | token wrong or expired | recreate token, update secret |
| `Could not route to /accounts/<id>/…` `[code: 7003]` | account ID is wrong | re-copy via `Ctrl+K` |
| `D1_ERROR: not authorized` | token missing **D1: Edit** | add permission |
| `no workers.dev subdomain` | never claimed | step 5 |
| Deploy green, bot silent | Worker secret missing | `wrangler secret list` |
| Bot replies to nothing | webhook URL wrong | `getWebhookInfo`, re-run deploy |
| Cron never fires | >5 triggers or not deployed | check dashboard Triggers tab |
| `prove` fails at forge build | target needs submodules | add `--recurse-submodules` to clone |
| All verdicts `inconclusive` | `FORK_RPC` missing or not archive | use Alchemy free tier |
| Dashboard 401 | `DASHBOARD_TOKEN` set | append `?token=` |
| Dashboard blank | `API` constant not set | step 8 |

---

## The five things that actually break

1. **Account ID vs token.** 32 hex vs 40 mixed-case. Check the length.
2. **Worker secrets vs GitHub secrets.** Two stores. The Telegram token must be
   in both, for different reasons.
3. **`workers.dev` subdomain** claimed before first deploy, not after.
4. **`FORK_RPC` must be archive.** Free public RPCs cannot serve historical
   state, so every proof run silently degrades to `inconclusive`.
5. **`CHANGE_ME` placeholders.** The generated harnesses need one edit each to
   name the real function. Until then they cannot prove anything, by design.

---

## Cost after setup

| Item | Monthly |
|---|---|
| Workers | $0 (100k req/day) |
| D1 | $0 (5M reads, 100k writes/day) |
| R2 | $0 (10 GB) |
| Pages | $0 |
| Actions (public repo) | $0 |
| RPC (Alchemy free) | $0 |
| **Total** | **$0** |

The only thing that would cost money is exceeding the free tiers, and the
Worker self-throttles before that happens (`DAILY_SUBREQUEST_BUDGET`,
`DAILY_LLM_BUDGET`).

---

## 12. The desk: paper mode, and the arming checklist

You do **not** need this section to finish setup. It is here so that when the
desk starts producing paper trades you know what the numbers mean and what
stands between them and real money. Full detail is in `TRADING.md`.

### 12.1 What it starts as

The desk starts in **paper mode**, and there is no setting in this file that
changes that. Two independent facts keep it there:

1. **Mode is not a column.** It lives in KV under `desk_mode`, which the schema
   comment says is "never in a table column you can UPDATE from a request
   handler". The only writer is `requestMode()`, reachable from `/desk paper` and
   `/desk live` in Telegram; it writes intent only and always reports `paper`.
2. **Arming needs secrets.** `DESK_LIVE` and `DESK_CAPITAL_CAP_USD` exist only
   via `wrangler secret put`, from a terminal.

Even if KV said `live`, `arming.ts` computes mode as
`stored === 'live' && armed ? 'live' : 'paper'` — a failing gate degrades to
paper. Intent can only ever move the desk *toward* paper.

**Check it worked** — no row, or `paper`, means paper mode:

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT key, value FROM kv WHERE key = 'desk_mode'"
```

### 12.2 What paper mode models, and where it refuses

A paper fill is not the pool price. Per fill (`desk_fills`), the desk records
`lp_fee_usd`, `prio_fee_usd`, `slippage_usd` and `price_impact`, so the modelled
cost is visible rather than baked invisibly into a PnL number. And it **refuses
the fill outright** when the position would exceed 1% of pool liquidity
(`size_exceeds_pool_share`) — above that you are your own exit, and a paper price
that could never have executed is worse than no backtest.

### 12.3 The arming checklist — do not shortcut this

`arming.ts` evaluates seven gates in one place. Every one must pass; an
unverifiable gate counts as **unmet**, because "defaulting it open is how a desk
ends up live by accident".

| `Gate.name` | Requirement | Why |
|---|---|---|
| `paper_trades` | ≥ 200 closed paper trades | 30 days of *activity*, not 30 days of being deployed |
| `paper_days` | ≥ 30 days of paper history | the strategy must see a regime, not a week |
| `expectancy_after_fees` | positive per-trade expectancy after modelled fees | almost every memecoin strategy is positive before fees and negative after |
| `max_drawdown` | < 15% realised | above this the sizing is wrong, not the picks |
| `desk_live_secret` *(gate name, not a table)* | `DESK_LIVE` = `1` | the deliberate terminal step |
| `capital_cap` | `DESK_CAPITAL_CAP_USD` a positive number | the amount you can lose entirely |
| `signer_isolation` | `DESK_SIGNER_URL` set **and** `DESK_SIGNER_KEY` absent | a key in the Worker env is readable by the request handler |

Setting the secrets (§4 covers the names):

```bash
cd app
npx wrangler secret put DESK_LIVE             # value: 1
npx wrangler secret put DESK_CAPITAL_CAP_USD  # value: an amount you can lose entirely
npx wrangler secret put DESK_SIGNER_URL       # your isolated signer endpoint
```

<!-- UNVERIFIED -->
> The three commands above were not run, and two things stand between you and a
> live desk regardless:
>
> - **`/desk live` exists and records intent, but cannot arm.** It calls
>   `requestMode()`, which writes the `desk_mode` KV key and then **returns `paper`
>   anyway** (`arming.ts:186-196`). So the command is an audit record, not a switch.
> - **The effective mode is computed, not stored.** `armState()` requires all seven
>   gates, and `executor.submit` throws `live_signer_not_wired` regardless — live
>   order submission is not implemented in this build. There is no path from chat,
>   HTTP or the dashboard that produces a real order.
> - **`live_signer_not_wired`.** `desk/reasons.ts` carries this refusal code
>   explicitly: "live order submission is not implemented in this build". Even a
>   fully armed desk refuses to submit. That is the honest state, and it is why
>   this section is documentation rather than an instruction.

**Verify no partial arming happened:**

```bash
cd app
npx wrangler secret list
# DESK_LIVE and DESK_CAPITAL_CAP_USD must NOT appear until you mean it
```

If you set `DESK_LIVE` by accident, unset it. Either half being absent is enough
to keep the desk in paper, because a gate that fails degrades the mode:

```bash
cd app
npx wrangler secret delete DESK_LIVE
```

---

## 13. Rotating a secret

Rotation is not "change the value in GitHub and redeploy". Three of these
credentials are checked by *two* independent stores that must agree, and two of
them **fail closed** — so the order below is the difference between a rotation and
an outage. Every coupling named here was read out of the tree, and the `grep`
that proves it is quoted inline.

### The one rule that explains all the failures

A secret lives in one of three places, and they do not sync automatically:

| Store | Who reads it | How it gets there |
|---|---|---|
| **GitHub secrets** | the workflow (`prove.yml`, `deploy.yml`, `eval.yml`) | you, in Settings → Secrets |
| **Worker secrets** | the running Worker | `deploy.yml` *pushes a subset*, the rest are manual |
| **Third-party side** | Telegram, Alchemy, Google | you, at the provider |

`deploy.yml:119-131` pushes exactly eight: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `PROOF_HOOK_SECRET`,
`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `RPC_URL`. Anything not on
that list is **Worker-only and must be set by hand** (§4). Rotating a Worker-only
secret in GitHub does nothing at all.

### Rotate in this order

#### 1. `PROOF_HOOK_SECRET` — highest consequence, do it first

This one authenticates the callback that carries every finding from `prove.yml`
back to the Worker. Both ends read it, and both refuse on a mismatch:

```
$ grep -n 'PROOF_HOOK_SECRET' app/src/index.ts .github/workflows/prove.yml
app/src/index.ts:148:      if (!env.PROOF_HOOK_SECRET) {          # fail-closed: 503
app/src/index.ts:153:      if (!timingSafeEqual(presented, env.PROOF_HOOK_SECRET)) {
prove.yml:476:   if [ -z "${{ secrets.PROOF_HOOK_SECRET }}" ]; then
prove.yml:483:   -H "x-asterion-secret: ${{ secrets.PROOF_HOOK_SECRET }}" \\
```

If the two values disagree, **no finding can ever be created** — the run completes,
the callback is refused, and the result is silently lost. This is the one rotation
that can cost you evidence rather than uptime.

1. `openssl rand -hex 32`
2. Set the **GitHub** secret `PROOF_HOOK_SECRET`. `deploy.yml:127` pushes it to
the Worker on the next run, so a redeploy updates both at once.
3. Re-run **Actions → deploy**. Confirm the push step did not skip it
   (the step is `if [ -n "$PROOF_HOOK_SECRET" ]`, so an empty value is silently
   skipped — check, do not assume).
4. Verify agreement without printing either value:
   ```bash
   cd app && npx wrangler secret list | grep PROOF_HOOK_SECRET
   ```
5. Prove it end-to-end with a real proof run (§10). A `403` or a logged
   `proof hook refused` means the two stores disagree.

**There is no zero-downtime rotation here.** The Worker accepts exactly one value,
so between the Worker push and the next `prove.yml` run, in-flight runs fail their
callback. Rotate when no proof is running.

#### 2. `TELEGRAM_BOT_TOKEN` — invalidates the old token instantly

BotFather's *Revoke current token* kills the old token the moment you confirm, so
the Worker starts answering `401` on every `send()` until it has the new one.

The token is used in **two** places, and the second is easy to forget:

```
$ grep -n 'TELEGRAM_BOT_TOKEN' .github/workflows/deploy.yml
122:  echo "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
154:  TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}   # app/scripts/set-webhook.mjs
```

1. BotFather → `/mybots` → your bot → **API Token** → *Revoke current token*.
2. Update the **GitHub** secret `TELEGRAM_BOT_TOKEN`.
3. Re-run **Actions → deploy**. This both pushes the Worker secret *and* re-runs
   `app/scripts/set-webhook.mjs`, which re-registers the webhook with the new
   token — so you do not need a separate `setWebhook` call.
4. Verify:
   ```bash
   curl -s "https://api.telegram.org/bot<NEW_TOKEN>/getWebhookInfo" | jq '{url,last_error_message}'
   ```
   A non-empty `last_error_message` means the Worker still holds the old token.

#### 3. `TELEGRAM_WEBHOOK_SECRET` — the silent-403 trap

This is the one people get wrong, because the failure looks like "Telegram is
down" rather than "you rotated a secret". Telegram stamps
every update with the `secret_token` registered at `setWebhook`; the Worker
compares it and **rejects on mismatch**:

```
$ grep -n 'TELEGRAM_WEBHOOK_SECRET' app/src/index.ts app/scripts/set-webhook.mjs
app/src/index.ts:132:      if (env.TELEGRAM_WEBHOOK_SECRET) {
app/src/index.ts:134:        if (got !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
app/scripts/set-webhook.mjs:  ...(secret ? { secret_token: secret } : {})
```

Rotating only one side means **every message to the bot returns 403** and the bot
governs nothing. Both sides are updated by one deploy run
(`deploy.yml:124` pushes the secret, `deploy.yml:150-155` re-registers the
webhook), which is why re-running the deploy workflow is the correct procedure
rather than editing either side by hand.

1. `openssl rand -hex 24`
2. Update the **GitHub** secret `TELEGRAM_WEBHOOK_SECRET`.
3. Re-run **Actions → deploy** (updates Worker *and* Telegram in one job).
4. Verify: send the bot any message. A `403` in `wrangler tail` means the Telegram
   side still holds the old value — re-run the deploy, do not hand-patch.

**Leaving this secret unset disables the check entirely** (`index.ts:132`), so an
empty value is not "rotated", it is "off". `set-webhook.mjs` then omits
`secret_token` and any internet host can POST to `/tg`.

#### 4. `GITHUB_DISPATCH_TOKEN` — Worker-only, manual, and forgettable

Not in the `push runtime secrets` step. Verified:

```
$ grep -n 'GITHUB_DISPATCH_TOKEN' .github/workflows/deploy.yml
(no output — it is not pushed)
$ grep -n 'GITHUB_DISPATCH_TOKEN' app/src/dispatch.ts
644:  if (!deps.env.GITHUB_DISPATCH_TOKEN) missingVars.push('GITHUB_DISPATCH_TOKEN');
```

```bash
cd app
npx wrangler secret put GITHUB_DISPATCH_TOKEN   # fine-grained PAT, Actions: write
npx wrangler secret list | grep GITHUB_DISPATCH_TOKEN
```

Failure is loud and named: an approval is answered with the exact missing variable
rather than being swallowed (`dispatch.ts:646-659`). Still — rotating the PAT and
not updating the Worker means **nothing is ever dispatched**, and the approval
queue fills with decisions that silently cannot run.

#### 5. `CLOUDFLARE_API_TOKEN` — GitHub only

Used solely by the workflow to deploy. Rotate in the Cloudflare dashboard, update
the GitHub secret, re-run deploy. Check the token still carries **Workers Scripts:
Edit** and **D1: Edit** for the right account, or the deploy fails at
`wrangler deploy` rather than at auth.

#### 6. Provider keys — cheap, and safe to leave absent

`RPC_URL` (`sentinel.ts:48`, pushed by `deploy.yml:131`), `FORK_RPC` (used by
`fuzzseed.ts` and generated PoCs), and the three LLM keys
(`GEMINI_API_KEY`/`GROQ_API_KEY`/`OPENROUTER_API_KEY`) are all rotated at the
provider, then set as GitHub secrets and picked up by the next deploy.

All five are **degradable on purpose**: no LLM key still runs every deterministic
gate (`llm.ts` falls through and degrades), and a dead `FORK_RPC` reports
`inconclusive` rather than a false success. Rotating them cannot break the trust
chain — it can only cost prose quality or V2 proof runs.

### Do NOT rotate these

| Name | Why |
|---|---|
| `DESK_SIGNER_KEY` | **Its presence is a failed arming gate.** `arming.ts` treats a private key readable by the request handler as a reason to refuse to arm. Setting it is not a rotation, it is a regression (§12). |
| `DESK_LIVE` | Not a credential. It is the arming switch, and it should stay unset until §12.3 is satisfied. |
| `DESK_MODE` | Declared in `DeskEnv` and read by nothing — mode comes from `armState()`. Rotating it changes nothing. |
| `CF_EVAL_TOKEN` | `eval.yml` passes it, but no code in this tree reads it. Leave it empty. |

### After any rotation: prove it, do not assume it

A rotation is complete when the *behaviour* is observed, not when the secret is
saved. The four checks that actually catch a desync:

```bash
# 1. both stores exist (does not print values)
cd app && npx wrangler secret list

# 2. the Worker is alive at all
curl -s https://<worker>/health

# 3. the webhook is registered and error-free
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq '{url,last_error_message,pending_update_count}'

# 4. the bot actually answers (not just 200s)
#    send it a message; a 403 in `npx wrangler tail` is the webhook-secret desync
```

Then run one real proof (§10). That is the only test that exercises
`PROOF_HOOK_SECRET` in both directions, and it is the failure that costs findings
rather than uptime.

### What this section does not cover

The `deploy.yml` push steps are guarded by `if [ -n "$X" ]`. An **empty** GitHub
secret is therefore skipped silently and the Worker keeps the previous value —
which looks exactly like a successful rotation. Always confirm with
`wrangler secret list` after rotating, and treat an empty value as a configuration
error rather than a no-op.

**Unverified, like the rest of this file.** The coupling described above is read
from the tree and each `file:line` was checked, but no rotation was actually
performed: every `wrangler secret put`/`delete` and every `setWebhook` here would
write a real credential or re-point a live bot. Per the table at the end of this
document, those commands are marked unverified by nature. The *order* and the
*failure modes* are the load-bearing part and do not depend on having executed
them.

---

## 14. Backups, and the 60-day question

The database is the one thing here that cannot be rebuilt from the repo. The
code can be re-cloned; the ledger, findings, evidence and intake rows cannot.

### 14.1 What protects it, in two layers

| Layer | Window | Cost | Where it lives |
|---|---|---|---|
| D1 Time Travel (already on) | **7 days** on the Free plan, 30 on Workers Paid | free | Cloudflare |
| `d1-backup.yml` (this repo) | until you delete it | free (see 14.3) | git, i.e. GitHub |

Time Travel needs no setup and no cron: Cloudflare keeps its own history. The
limit worth knowing is that on the **Free plan it is 7 days, not 30** -- 30 days
is the Workers Paid number, and it is easy to plan around the wrong one.

That is the whole argument for the second layer. Seven days is not a backup,
it is an undo buffer: a corruption you notice in week three is already gone.

### 14.2 What `d1-backup.yml` does

Daily at 05:43 UTC it exports D1, checks the dump, **restores it into a
throwaway local database**, verifies the ledger hash chain, and only then
commits `backups/asterion.sql` to `main`.

The restore is the part that matters. A dump is a file; a backup is a dump that
has been loaded back and verified. This is not theoretical here: the first real
run exported a perfectly valid 6,987,101-byte dump that **could not be
restored** (`statement too long: SQLITE_TOOBIG`, caused by the ~300 KB
`corpus_digest` row). The export step was green and the file looked fine.

`corpus_digest` is therefore schema-only in the dump. Its *contents* never
travel because they are already in git as `app/src/corpus-digest.json`, which
the deploy step loads. Every other table is exported with data.

**To restore.** Take the newest dump and load it:

```sh
git show $(git log -1 --format=%H -- backups/asterion.sql):backups/asterion.sql > /tmp/asterion.sql
npx wrangler d1 execute asterion --remote --file=/tmp/asterion.sql --yes
```

Then rebuild the corpus digest by re-running the deploy (the "apply schema" and
digest steps) so `corpus_digest` is repopulated from the repo.

### 14.3 The 60-day rule, answered

You asked what you have to do before 60 days so nothing gets deleted. Three
separate limits get confused here, so all three:

**1. GitHub disables scheduled workflows after 60 days of inactivity -- but
only on a PUBLIC repo.**

GitHub's own wording: *"In a public repository, scheduled workflows are
automatically disabled when no repository activity has occurred in 60 days."*

This repository is **private**, so **this rule does not apply to you today.**
Nothing is deleted at 60 days, and no action is required.

**2. If you ever make the repo public, the daily backup commit is what keeps
it alive.** Every run writes a commit, so the repo is never idle for 60 days.
The only gap: the commit is skipped when the database has not changed. So the
workflow carries a guard that **fails the job after 9 days without a backup
commit** -- long before GitHub's 60-day threshold, while the job can still tell
you. If that guard ever fires, the schedule is what you fix, not the guard.

**3. The 90-day retention on Actions artifacts is separate and is not your
backup.** `eval.yml` uploads to an artifact that GitHub deletes after 90 days.
Nothing depends on it: the backup is a commit on `main`, which has no expiry.

**So: nothing to do before 60 days.** The one habit worth having is noticing
whether the daily backup commit is still appearing, because a silently dead
schedule looks exactly like a working one. The 9-day guard exists to make that
difference loud.

### 14.4 Why not R2

R2 is the obvious home for a dump, and it is not used here for one reason: R2
has to be enabled on the account, and enabling it requires a payment method.
D1's own free tier does not, which is why the backup lives in git instead. If
you later enable R2, the same workflow can write there -- but do not let a
missing card block having a backup at all, which is what a git commit solves.

---

## What is UNVERIFIED in this file, and why

Setup happens on your Cloudflare account, so commands that need a live account
could not be executed here. Everything below is written from the tree's own
files (versions, variable names, table names, route names) but its *effect* was
not observed. Each is marked `<!-- UNVERIFIED -->` at the point of use.

| Item | Why unverified |
|---|---|
| `npx wrangler d1 create` / `kv namespace create` / `r2 bucket create` | creates real resources on your account |
| `npx wrangler d1 execute --file=./schema.sql` against a real D1 | no deployed database in this session; the file itself was verified to contain 29 `CREATE TABLE` + 26 `CREATE INDEX`, 7 of them `desk_` |
| Every `wrangler secret put` | would write a real secret |
| `wrangler d1 execute --remote --command "..."` verification queries | SQL was written against the real schema, but never executed against a remote D1 |
| Dashboard / Triggers tab clicks | UI steps, not commands |
| `gh run list --workflow=prove.yml` | needs an authenticated repo with workflow history |
| `npx wrangler pages deploy` | publishes a site |
| Cloudflare Access / Zero Trust setup | dashboard steps |
| The dispatch round-trip smoke test (§7) | needs a deployed Worker, a live Telegram bot and a real GitHub repo |
| `DESK_*` secret commands (§12.3) | would write real secrets, and `live_signer_not_wired` means live submission is not implemented |
| `SELECT ... FROM kv WHERE key='desk_mode'` | as above; also nothing in this tree writes that key |

Verified **by execution** in this tree, with real output pasted in this file:
`node --version` → `v24.16.0`; `npx wrangler --version` → `4.155.0`;
`npx tsc --noEmit` → exit 0; `node scripts/load-corpus.mjs --check` → exit 0;
the table/index counts; and the `grep` evidence for the two unpushed dispatch
secrets and the desk wiring.

One thing is verified and worth repeating, because it changes what you can trust:

```
Security suite (tests/*.mjs except desk)  489 pass   0 fail    489
Desk suite     (tests/desk.test.mjs)       28 pass   0 fail     28
Desk API suite (tests/desk-api.test.mjs)   13 pass   0 fail     13
npm test (all together)                   530 pass   0 fail    530   exit 0
```

**`npm test` exits 0, so the `deploy.yml` gate passes.** Both halves are green.
The desk's seven negative controls were proved by breaking each guard in turn
and confirming exactly the intended case goes red, then restoring it (green,
sha256-verified).

Green tests are not the same as a validated desk. As of this writing the filter
deliberately **refuses to judge** tokens whose flow gates it cannot compute from
free data, so the desk opens no positions and the 200-trade arming gate cannot
be reached. See `app/desk/DESK.md` §1 and §9. Earlier in
this build the security suite also failed four `dispatch.test.mjs` cases; that was a
fixture missing `PROOF_HOOK_SECRET` and has been fixed without weakening the gate.

