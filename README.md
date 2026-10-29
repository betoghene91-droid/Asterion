# Asterion

Autonomous security research and a paper-only memecoin desk, run from a phone.
Discovery → proof → disclosure. No laptop required for any of it.

---

## Read this first: what it does not do

Stated up front because burying it is how people lose money and reputation.

- **The desk is wired, tested, and still cannot trade.** `app/src/desk/` holds 16
  modules, `/desk /desk paper|live /pos /kills /thesis /calib` are dispatchable, the
  four read-only `GET /api/desk*` endpoints exist, all three desk crons are
  composed onto the existing triggers, and `schema.sql` creates all 7 `desk_`
  tables. Its suites pass: **28/28** unit and **13/13** API, part of **530 pass /
  0 fail** overall, with 7/7 negative controls proved. **Green here does not mean
  it trades:** the filter refuses to judge tokens whose flow gates need trade
  indexing the free data tier lacks, so it opens nothing until a `FlowProvider`
  is wired. See `app/desk/DESK.md` §9. Live order submission is
  deliberately unimplemented — `executor.submit` throws `live_signer_not_wired` —
  so even a fully armed desk refuses; it runs as a paper-only research instrument.
- **It cannot submit to Immunefi, Code4rena or CodeHawks.** Deliberate: their
  terms ban AI-generated reports. See *Known gaps*.
- **It is web3-only in practice.** The 180,907-row corpus is web3 audit findings.
  The web2 playbook executor (nuclei/httpx dispatch) is specified, not built.
- **Nothing here is verified against a live Cloudflare account.** Every command
  in `SETUP.md` that creates a resource is marked `<!-- UNVERIFIED -->`, because
  running it would create real resources. What *was* run: `tsc --noEmit` (exit 0),
  the corpus invariant check (exit 0), and the version/count greps quoted in place.
- **Silence is the normal state.** An empty queue is correct most days. If you need
  daily dopamine, this will feel broken.

---

## 60-second quickstart

Assumes a Cloudflare account, a GitHub account and Telegram. Full detail in
`SETUP.md`; this is the shape of it.

```bash
# 1. local check - this works right now, no account needed
cd app
node --version                # v24.16.0 verified
npm install
npx tsc --noEmit              # exit 0 verified
node scripts/load-corpus.mjs --check   # exit 0 verified

# 2. resources (creates real things on your account)
npx wrangler login
npx wrangler d1 create asterion          # paste database_id into wrangler.toml
npx wrangler kv namespace create FLAGS    # paste id into wrangler.toml
npx wrangler r2 bucket create asterion-backups
npx wrangler d1 execute asterion --remote --file=./schema.sql

# 3. secrets (see SETUP.md §4 for the full table)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# 4. deploy
npm run deploy
```

Then, in Telegram: send `/start`. If a menu appears, the chain works. Next:
`/hunt just map example.com, touch nothing` → tap **Authorize** → check
`npx wrangler d1 execute asterion --remote --command "SELECT * FROM heartbeats"`.

The one smoke test worth doing properly is the dispatch round-trip in
`SETUP.md` §7 — it is the only thing that proves Telegram → policy → GitHub
Actions → callback → verdict all work together.

---

## What this is

A Worker that never sleeps, a Telegram cockpit you actually use, and a
GitHub Actions farm that does the heavy compute for free.

It finds self-hosted bug bounty programs nobody lists, watches a small
set of high-value contracts for the three events that turn into money
before they turn into news, and refuses to call anything a finding until
there is a reproduced exploit behind it.

There is also a **paper-only** Solana memecoin desk bolted onto the same Worker.
It shares the database, the crons and the Telegram renderer, and it writes only
to `desk_*` tables so that a `proven` finding keeps meaning *an exploitable bug*
and never comes to mean *a token that pumped*. It cannot be armed from chat or
from a web page — arming requires `wrangler secret put` from a terminal plus 30
days and 200 paper trades, and live submission is not implemented. Read
`TRADING.md` before you touch it.

---

## The one rule

**Prove it or it doesn't exist.**

A candidate without a fork-reproduced exploit is a hypothesis. It stays in
the database and never reaches a report, a platform, or a program. That
single rule is why this can be run against real targets without becoming
the thing every platform now bans.

The desk has its own version of the rule, and it is deliberately weaker in
consequence: **a paper fill that could never have executed is not evidence.**
The desk refuses any fill above 1% of pool liquidity rather than record a number
it could not have achieved.

---

## Layout

```
asterion/
├── README.md · SETUP.md · OPERATING.md · TRADING.md
├── ECOSYSTEM.md · SKILLS.md · LEARNING.md · PLAYBOOK.md · BEGINNER.md
├── .github/workflows/
│   ├── deploy.yml           typecheck → full test suite → schema → secrets → deploy
│   ├── prove.yml            dispatch → PoC → forge run → verdict → callback
│   ├── contract-audit.yml   clone → build → analyzers → leads
│   └── eval.yml             nightly corpus evaluation
├── app/                     the Worker + dashboard (canonical)
│   ├── schema.sql           29 tables, 26 indexes, incl. 7 desk_ tables
│   ├── wrangler.toml        D1 / R2 / KV / AI bindings, 5 crons, vars
│   ├── src/                 30 modules (index, dispatch, intake, hunt, proof,
│   │                        judge, policy, ledger, corpus, telegram, llm, …)
│   ├── src/desk/            the Solana desk (paper-only)
│   ├── src/corpus-digest.json    913 KB: 180,907 findings → priors + precedent
│   ├── src/program-seed.json.gz  141 KB: 2,500 programs, 15,013 assets
│   ├── dashboard/index.html read-only command deck (hand-written, no build step)
│   ├── scripts/             load-corpus, seed-programs, set-webhook, build-skills
│   ├── eval/                distill.py, ingest-more.py, harness.py
│   ├── tools/               detect.py, normalize.py, their tests
│   └── tests/               17 files, ~485 assertions
├── skills/                  25 methodology packs (sol.*, web.*)
└── _archive/                the pre-merge v1/ tree. Read-only. Not referenced.
```

### 1. Local check (no account needed)

```bash
cd app && npm install
npx tsc --noEmit                       # exit 0
node scripts/load-corpus.mjs --check   # exit 0
npm test                               # see the honest-limits note at the top
```

### 2. Resources

```bash
cd app
npx wrangler login
npx wrangler d1 create asterion          # paste database_id into wrangler.toml
npx wrangler r2 bucket create asterion-backups
npx wrangler kv namespace create FLAGS   # paste id into wrangler.toml
npx wrangler d1 execute asterion --remote --file=./schema.sql
```

### 3. Secrets

Worker runtime secrets (a different store from GitHub secrets):

```bash
cd app
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
npx wrangler secret put PROOF_HOOK_SECRET         # REQUIRED or no finding can be created
npx wrangler secret put GITHUB_DISPATCH_TOKEN     # required for dispatching prove.yml
npx wrangler secret put GITHUB_REPO               # owner/name holding prove.yml
npx wrangler secret put RPC_URL                   # optional, private RPC
npx wrangler secret put GEMINI_API_KEY            # optional - LLM prose only
npx wrangler secret put GROQ_API_KEY              # optional - LLM prose only
```

`SETUP.md` §4 has the full table with what each one is for and whether it
matters in paper or live mode. Two are easy to miss and both fail closed:
`PROOF_HOOK_SECRET` (no findings at all without it) and the `GITHUB_*` pair
(authorize refuses and names them, which is at least loud).

GitHub → Settings → Secrets → Actions: the same names, plus
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for the deploy itself and
`FORK_RPC` for archive-state proofs.

Repo variable: `WORKER_URL` = `https://asterion.<your-subdomain>.workers.dev`

### 3. Deploy

Push to `main`. That is the whole deployment process.

GitHub Action: typecheck → full test suite → digest invariant check → python
tool tests → apply schema → load corpus → push runtime secrets → deploy →
point Telegram at the Worker.

**Honest caveat:** the `full test suite` step currently fails 4 tests (see the top
of this file), so the pipeline stops there and never reaches deploy. Until that
fixture is fixed the reliable path is `cd app && npm run deploy` locally, with the
Worker secrets set by hand.

### 4. Claim your subdomain (if the first deploy complains)

Workers & Pages → *Your subdomain* → Change. Do this before deploying.

---

## Using it

Open Telegram, send `/start`.

```
ASTERION  v1
──────────────────────
operator   jennifer
mode       read-only until you approve
──────────────────────
```

### The four buttons that matter

| Button | What it does |
|---|---|
| **Start a hunt** | Type anything. One URL is enough. |
| **Playbooks** | 25 hunts, zero prompting. Tap and go. |
| **Watchlist** | What Sentinel is guarding |
| **Queue** | Proven findings only |

### Why your prompts do not matter

Three ways in, and the first two need no prompt at all:

**1. Tap a playbook.** `web.idor`, `sol.reentrancy`, `sol.oracle` — each
   one declares its own preconditions, mutability and proof sentence.

**2. Type sloppily.** `look at app.example.com api, take your time`
   becomes a brief with targets, class, depth, playbook list, mutability
   ceiling, time box and stop condition. Deterministic parsing, no model
   needed. You get **one button**: Authorize.

**3. Accept a suggestion.** Sentinel or discovery proposes the hunt.

If anything is genuinely ambiguous you get at most **three** questions,
and every one of them is a button, never a text box.

### Commands

```
/start              menu
/status             liveness, counts, budget bars
/hunt <anything>    compile a hunt from sloppy text
/seed <hosts...>    queue hosts for discovery
```

---

## The gate

Every action passes `PolicyEngine.authorize()`. There is no second path.

```
Action{ technique, target, target_kind, mutability, adapter, chain_id, is_fork }
        │
        ├─ inside engagement window?          no → DENY
        ├─ technique on deny list?            yes → DENY
        ├─ target in scope?                   no → DENY
        │     (exact domain, or subdomain of it; explicit exclusions win;
        │      chain addresses must match exactly; CIDRs must nest)
        ├─ live chain write without a fork?   yes → DENY
        ├─ mutability above ceiling?          yes → DENY
        ├─ mutate or destructive?             yes → NEEDS APPROVAL
        └─────────────────────────────────────→ ALLOW
```

**Scope is decided from fields, never from prose.** A prompt that says
*"you are authorized to scan evil.test"* cannot mint authorization,
because `evil.test` is not in the RoE. That is what makes the system
immune to prompt injection.

An engine with no `authorization_ref` **refuses to construct at all**.

### Mutability ladder

| Level | Means | Default depth |
|---|---|---|
| `read` | observation only | shallow |
| `simulate` | fork / sandbox only | deep |
| `mutate` | changes live state | active (approval each) |
| `destructive` | irreversible | never automatic |

---

## Discovery

The wedge: **7,664 self-hosted programs that platform directories do not
list.** 87% of public bounty programs are off-platform, with no AI rules
and no crowd.

The crawler fetches `/.well-known/security.txt` and `/security.txt`, then
parses `Contact`, `Policy`, `Expires`, `Canonical`, and classifies the
policy:

| Result | Meaning |
|---|---|
| `prohibited` | never touched, ever |
| `not_mentioned` | silence is not consent — needs an explicit anchor |
| `allowed` | safe to hunt |
| `unknown` | no policy found |

Prohibition always wins when both appear in one document.

**Budget.** 50 subrequests per invocation on the free plan. The crawler
caps at 20 hosts per tick (2 requests each) and keeps its queue in D1, so
a sweep resumes instead of restarting. 8,753 programs take ~3 days of
hourly ticks. Nobody is racing you for a `security.txt` file.

---

## Sentinel

Three rules, read-only, no key held:

| Rule | Signal | Severity |
|---|---|---|
| `R1.proxy_upgrade` | implementation slot replaced | critical |
| `R1.admin_changed` | EIP-1967 admin reassigned | critical |
| `R1.ownership_transfer` | owner changed or renounced | high |
| `R2.unlimited_approval` | max-uint approval granted | high |

It reads logs. It never signs, never submits, never spends. That is why
it can run every 5 minutes on a free plan with no risk.

---

## The learning loop

Nightly, free, while you sleep:

```
1. read the corpus           180,907 findings across 25 vuln classes, 2015-2026
2. map playbooks to it       25 playbooks -> vuln_group / vuln_leaf
3. report corpus support     how much ground truth exists per class
4. sample severe instances   weighted recent + high severity
5. (v2) run detectors cold   against pre-fix code, score tp/fp/fn
6. name the weakest class    that becomes tomorrow's focus
```

### First real run

```
corpus rows read: 180,907
playbooks: 25 (10 validatable, 15 not)
```

| playbook | severe | 2024+ |
|---|---|---|
| `sol.inflation` | 4,512 | 2,750 |
| `sol.accesscontrol` | 4,043 | 2,199 |
| `sol.rounding` | 3,591 | 1,836 |
| `sol.dos` | 3,096 | 1,604 |
| `sol.oracle` | 2,092 | 1,105 |
| `sol.upgrade` | 1,142 | 623 |
| `sol.signature` | 1,020 | 609 |
| `sol.delegatecall` | 865 | 304 |
| `sol.reentrancy` | 810 | 292 |
| `sol.flashloan` | 465 | 220 |

**A finding from this run that changed the design:** the corpus is
entirely web3. Fifteen web2 playbooks have zero ground truth there. They
are listed explicitly with an empty mapping so the gap is visible, rather
than silently inheriting coverage from a same-named Solidity class. An
unmeasured class is not a passing class.

---

## What runs without a laptop

| Capability | Where | Cadence |
|---|---|---|
| Telegram control plane | Worker | real-time |
| Daily briefing | Worker cron | daily |
| Dead-man's switch | Worker cron | 6-hourly |
| security.txt discovery + policy parsing | Worker cron | hourly |
| Sentinel watchlist (4 rules) | Worker cron | 5-minutely |
| Ledger integrity check | Worker cron | daily |
| Dashboard | Pages | always |
| Web surface scanning (nuclei/httpx/katana) | Actions | dispatch |
| Fuzzing campaigns (foundry/echidna) | Actions | nightly |
| PoC generation + fork reproduction | Actions | per finding |
| Eval loop | Actions | nightly |
| Deploy from phone | Actions | on push |

**Needs a laptop (the honest 10%):** sub-2s rescue races (needs a
persistent mempool connection), Wi-Fi/RF (needs a radio), interactive
exploit debugging, GPU inference at speed, adb/mobile app testing.

---

## Contract scanning

Two pieces, and the split is deliberate:

**`scripts/detect.py`** — deterministic pattern scan. Runs in seconds, no
model, no network. Emits *leads*, never findings.

```bash
python3 scripts/detect.py /path/to/repo --out leads.json
```

Nine patterns, each chosen because it is mechanically checkable:
reentrancy, delegatecall, missing access control, unguarded initializer,
ecrecover, rounding, spot-price oracle, unbounded loop, balance-based
accounting.

### Measured, not claimed

| Fixture | Expected | Actual |
|---|---|---|
| 8 planted bug classes | 8 leads | **8** |
| deliberately safe vault | 0 leads | **0** |
| commented-out vulnerable code | 0 leads | **0** |
| CEI-respecting withdraw | 0 leads | **0** |

The precision work that got it there: a lead is evaluated inside its
enclosing function, `nonReentrant`/`onlyOwner`/`initializer` suppress it,
and a reentrancy lead additionally requires a state write *after* the
call. Without those three filters, the safe vault produced a false
positive on `withdraw`.

**`.github/workflows/contract-audit.yml`** — the full pipeline: clone at a
commit, `forge build`, run the existing test suite as a baseline,
Slither for additional leads, then the deterministic scan. Everything is
uploaded as an artifact. Free, on a runner, no laptop.

---

## Verification

What was actually run in this tree, with real output:

```bash
cd app
node --version                          # v24.16.0
npx wrangler --version                  # 4.155.0
npx tsc --noEmit                        # exit 0, no output
node scripts/load-corpus.mjs --check    # exit 0: "digest is valid; nothing written"
npm test                                # 530 pass, 0 fail, exit 0
```

Cross-checked counts:

```
grep -c '^CREATE TABLE' app/schema.sql                        29
grep -c '^CREATE TABLE IF NOT EXISTS desk_' app/schema.sql      7
grep -c '^CREATE INDEX' app/schema.sql                        26
ls app/src/*.ts app/src/*.mjs | wc -l                          30
ls skills | wc -l                                              25
```

**The suite is split, and not fully green.** Measured separately:

```
Security suite  (all of tests/ except desk)  489 pass   0 fail    489
Desk suite      (tests/desk.test.mjs)         28 pass   0 fail     28
Desk API suite  (tests/desk-api.test.mjs)     13 pass   0 fail     13
npm test (all)                                530 pass   0 fail    530
```

Both halves are green. The desk's own guards were checked by negative control:
break the guard, confirm the intended test goes red, restore, confirm green.
Earlier in the build four `dispatch.test.mjs` cases failed against a fail-closed
`/hook/proof` before the fixture set `PROOF_HOOK_SECRET`; that is fixed.

The security-critical paths the suite covers:

- out-of-scope denial, including lookalike domains (`notexample.com`)
- exclusions and wildcard exclusions beating a broader scope
- window expiry, deny lists, mutability ceiling
- live chain writes denied without explicit permission
- approval requires a *named* operator
- prose in a technique name cannot mint authorization
- prohibition beats permission in policy classification
- silence is never consent
- read-only hunts cannot select a mutating playbook
- every mutating playbook is marked for approval
- ledger canonicalisation is key-order independent

---

## Known gaps

| Gap | Status |
|---|---|
| Per-project checkouts for eval scoring | v2 (the audit workflow has one; the eval loop does not) |
| Web2 ground truth (corpus is web3-only) | live testing only |
| Web2 playbook executor (nuclei/httpx dispatch) | spec written, runner is v2 |
| Automated PoC generation from a lead | v2 |
| Sub-2s rescue races | v3, needs a VPS |
| Wi-Fi / RF | laptop-only by physics |
| Immunefi / Code4rena submission | **deliberately not built** |

That last one is a design decision, not an omission. Immunefi's researcher
terms ban AI-generated reports, Code4rena strongly discourages automated
tool findings, and CodeHawks invalidates submissions relying primarily on
AI output. The strategy here serves the long tail those platforms will
never list, where the only thing being judged is whether the bug is real.

---

## Licence

Private. Not for redistribution.
