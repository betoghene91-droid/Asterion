# D — Autonomy Audit of the Asterion Bot

**Target:** `/workspace/tasks/9e376083-d2a7-4d74-b1ed-5c40e20734af/wbot` @ `edb7781`
**Scope:** `app/build/*.js`, `app/build/ui/`, `.github/workflows/prove*.yml`, `OPERATING.md` / `PLAYBOOK.md` / `README.md`
**Mode:** AUDIT ONLY — read-only. No code changed, no gate bypassed, no hunt run. The only execution performed was two in-process Node calls against pure functions (`compile`, `deriveForBrief`, `roeFromBrief`) to confirm behaviour the source implies; no network, no dispatch, no target.
**Date:** 2026-10-31

---

## 5-line summary

1. **The lifecycle is real and fully instrumented end to end — except the last two stages.** Intake → gate → derive → dispatch → workflow → judge → evidence all exist; **report writing is never called** (`report.js:141` is imported only by a test) and **there is no filing stage at all** — a proven finding stops at `findings.status='candidate'` (`index.js:1277`).
2. **Scope is NOT enforced at execution time.** No `prove*.yml` workflow and neither harness runner contains a single scope check; `prove.yml:166` will `git clone` any URL it is handed and `plane-harness.js:120` will `fetch()` any URL it is handed. Scope is decided once, in the Worker, at `dispatch.js:243 → policy.js:356`.
3. **Worse than that: the Worker-side scope check is largely a tautology.** `roeFromBrief` builds `domains`/`urls` from `brief.targets` itself (`policy.js:550-576`), then `inScope` checks those targets against those same lists (`policy.js:333`). `excluded` is always empty (`intake.js:172` ← `ctx.out_of_scope` never set), and `denied_techniques`/`approval_techniques` are hardcoded `[]` (`policy.js:579,581`). A fresh brief cannot fail the scope test it is given.
4. **It cannot run unattended, and the first blocker is a plain bug, not a gate:** dispatch hardcodes `mutability: 'simulate'` (`dispatch.js:91`) while intake's default depth is `read` (`intake.js:46-51`, `shallow` row `:48`, default arm `:100`), so **every default brief is denied by the policy gate** — verified by execution, not inferred. A second bug blocks web2 entirely from free text: `web.jwt` is the only web2 harness but has no `detect[]` entries, so text routing can never select it.
5. **The human approval is the only intentional gate.** Of the **13 ranked blockers (B1–B13), none is a safety control** — 5 are outright defects and 8 are missing automation. The single item that should stay human is the Authorize tap (H6), and it is currently masking B2/B3.

---

## Lifecycle diagram

```
 OPERATOR INTENT
      │
      ▼
[1] TRANSPORT + AUTH ──────── /tg webhook (index.js:61)  |  Mini App /api/ui/* (ui/shell.js:205)
      │                       guard(): TELEGRAM_CHAT_ID + first-sender-locks-operator (telegram.js:136)
      ▼
[2] INTAKE / COMPILE ─────── compile() (intake.js:109) → compileWithEnrichment() (intake-enrich.js:341)
      │                       ARTIFACT: { questions: Question[] }  OR  { brief: Brief }
      │                       class: inferClass (intake.js:78) · depth: inferDepth (intake.js:95)
      │                       playbooks: route() → pickPlaybooks() (intake.js:144, :200)
      ▼
[3] QUESTION LOOP ─────────── max 2 question kinds (target, class); ≤3 shown (intake.js:117-143)
      │                       draft parked in intake_sessions (index.js:655) → resumed by ans: (index.js:307)
      │                       ARTIFACT: Brief
      ▼
[4] AUTHORIZATION ANCHOR ──── authorizationFor() (authorize.js:219) — reads programs.automation + policy_url
      │                       null ⇒ refusal card, NO approvals row, dead end (index.js:613-624)
      │                       ARTIFACT: authorization_ref string
      ▼
[5] APPROVALS ROW ─────────── INSERT INTO approvals ... status='pending' (index.js:632 | ui/work.js:98)
      │                       ARTIFACT: approvals row { id, action: JSON{kind:'engagement',brief} }
      ▼
[6] HUMAN APPROVAL ◄═════════ ✓ MANDATORY. Telegram ok:/no: (index.js:376) | UI /api/ui/decide (ui/shell.js:308)
      │                       both land in approveAndDispatch (dispatch.js:198)
      ▼
[7] POLICY GATE ────────────── authorizeProof (dispatch.js:83) → PolicyEngine.authorize (policy.js:337)
      │                       window · technique deny-list · inScope · mutability ceiling · live-write
      │                       ARTIFACT: decision{verdict,reason,fingerprint} → ledger dispatch.blocked|allow
      ▼
[8] PLAN DERIVATION ────────── deriveForBrief (planes.js:654): plane → harness → inputs
      │                       ARTIFACT: { workflow, inputs{} } — per-plane input contract
      ▼
[9] ENV CHECK ──────────────── GITHUB_DISPATCH_TOKEN + GITHUB_REPO (dispatch.js:321-325)
      ▼
[10] HUNT ROW ──────────────── INSERT INTO hunts stage='prime' (dispatch.js:362) — before the POST
      ▼
[11] DISPATCH ──────────────── POST /actions/workflows/{wf}/dispatches (dispatch.js:132)
      │                       ARTIFACT: workflow_dispatch inputs (json body)
      ▼
[12] WORKFLOW EXECUTION ────── .github/workflows/prove.yml | prove-web.yml | prove-infra.yml | prove-solana.yml
      │                       ⚠ NO SCOPE CHECK HERE — inputs are trusted
      │                       ARTIFACT: out/plan.json, results/, controls/, counterfactual/, verdicts.json
      ▼
[13] RESULT INGESTION ──────── POST /hook/proof (index.js:77, PROOF_HOOK_SECRET fail-closed)
      │                       ingestProofs (index.js:1211) → hunts stage='done', proofs rows
      │                       ARTIFACT: proofs rows + ledger proof.verdict
      ▼
[14] JUDGING ───────────────── adjudicatePlan (judge.mjs:163) → judge() (proof.js:55)
      │                       proven ⟺ reproduced + CAUSAL + measured
      │                       ARTIFACT: verdicts.json { verdict, confidence, proven_claim, reasons }
      ▼
[15] FINDING PROMOTION ─────── INSERT INTO findings proof_state='proven' status='candidate' (index.js:1276)
      ▼
[16] EVIDENCE ──────────────── evidence bundle uploaded per-workflow (upload-artifact, 90d retention)
      ▼
[17] REPORTING ──── ✗ DEAD ── buildReport() (report.js:141) — NO production call site
      ▼
[18] FILING ─────── ✗ ABSENT  no triage/submit/file module exists
```

### Stage boundary table

| # | Stage | Boundary (file:line) | Artifact passed |
|---|-------|---------------------|-----------------|
| 1 | Transport + auth | `index.js:61` (`/tg`), `ui/shell.js:205` (`uiRoute`), `telegram.js:136` (`guard`) | Telegram update / initData header |
| 2 | Intake / compile | `intake.js:109`, `intake-enrich.js:341` | `Question[]` **or** `Brief` |
| 3 | Question loop | `intake.js:142-143`, `index.js:655` (draft), `index.js:307-335` (`ans:`) | `Brief` |
| 4 | Auth anchor | `authorize.js:219-247` (`authorizationFor`) | `authorization_ref` string |
| 5 | Approvals row | `index.js:632`, `ui/work.js:98` | `approvals` row `status='pending'` |
| 6 | **Human approval** | `index.js:376` (`ok:`/`no:`), `ui/shell.js:308` → `ui/work.js:187` | operator decision + `operator` name |
| 7 | Policy gate | `dispatch.js:83` → `policy.js:337` (`authorize`), `policy.js:283` (`inScope`) | `decision{verdict,reason,fingerprint}` |
| 8 | Plan derivation | `dispatch.js:275` → `planes.js:654` (`deriveForBrief`) | `{ workflow, inputs }` |
| 9 | Env check | `dispatch.js:321-325` | — |
| 10 | Hunt row | `dispatch.js:362` | `hunts` row `stage='prime'` |
| 11 | Dispatch | `dispatch.js:132` (`dispatchWorkflow`), called `:368` | `workflow_dispatch` JSON body |
| 12 | **Workflow execution** | `prove.yml` / `prove-web.yml` / `prove-infra.yml` / `prove-solana.yml` | `plan.json`, `results/`, `controls/`, `counterfactual/`, `verdicts.json` |
| 13 | Result ingestion | `index.js:77` (`/hook/proof`) → `index.js:1211` (`ingestProofs`) | `proofs` rows, `hunts.stage='done'` |
| 14 | Judging | `judge.mjs:163` (`adjudicatePlan`) → `proof.js:55` (`judge`) | verdict records |
| 15 | Finding promotion | `index.js:1276-1277` | `findings` row `status='candidate'` |
| 16 | Evidence | per-workflow `upload-artifact`; `evidence.js` helpers | bundle (90-day retention) |
| 17 | Reporting | `report.js:141` — **no caller** | — |
| 18 | Filing | **does not exist** | — |

---

## 2. Human touchpoints

Legend — **GATE** = safety-critical, should stay human · **FRICTION** = clerical, should be automated.

| # | Touchpoint | file:line | Mandatory? | What it asks | Auto-answerable? | Verdict |
|---|-----------|-----------|-----------|--------------|------------------|---------|
| H1 | Telegram sender authorisation | `telegram.js:120-135` | Yes, but **one-time** | First sender to the bot becomes `operator_chat` in `kv`; everyone else silently ignored | N/A — set once at deploy | **GATE** (already amortised) |
| H2 | Free-text brief | `index.js:191`, `ui/shell.js:290-306` | Yes to start | Anything; one line is enough | Yes — from `assets` table or discovery queue | **FRICTION** |
| H3 | Question: `target` | `intake.js:118-124` | Only when 0 targets extracted | "Which host or address?" with 4 options from `scope_hints` | **Yes** — `scope_hints` already queries `assets WHERE in_scope=1` (`index.js:718`) | **FRICTION** (should default to top in-scope asset) |
| H4 | Question: `class` | `intake.js:127-139` | Only when target shape is ambiguous | web2 / solidity / infra | Yes — but `confidentClass` already resolves every URL/0x/host, so this fires almost never | **FRICTION** |
| H5 | (absent) Question: `depth` | `intake.js:136` comment only | **Never asked** | — | Defaults to `shallow`=`read` | **FRICTION→BUG** (see B1) |
| H6 | Tap ✓ Authorize | `index.js:376-400` or `ui/shell.js:308` | **Yes — hard** | Renders brief; releases engagement to the gate | Deliberately not | **GATE — KEEP** |
| H7 | Edit `CHANGE_ME` in generated PoC | `poc.js` (14 occurrences), documented `OPERATING.md:130-132` | Yes for EVM `sol.accesscontrol` etc. | Real function signature where `CHANGE_ME` sits | Not today — needs target ABI | **FRICTION in principle**, but currently a correctness prerequisite → keep human until ABI-derived |
| H8 | Read the finding / write it up | `report.js` (unwired) | Yes | Entire report authoring | `buildReport` exists and is tested but never called | **FRICTION** |
| H9 | Submit to programme | — | Yes | Everything | No code exists | **FRICTION** (outward-facing; arguably keep human for accountability) |

**Notes.**
- H3/H4 are the only questions the compiler can emit; both are answerable from data the Worker already holds. `questionKeyboard` renders options for the **first** question only (`index.js:770-779`), so a two-question brief costs two round trips.
- H6 is the *only* place where a human decision changes a safety outcome. Everything with a consequence is anchored on it: `dispatch.js:227` refuses a non-engagement, `:256` refuses a denied gate, `:276` refuses underivable inputs, `:322` refuses missing env — but none of those are human *input*, they are machine refusals.
- `OPERATING.md:155` claims approvals "silently expire after 24h" — true: `index.js:1040` flips `pending`→`expired` at −86400s in `runMaintenance` (cron `15 3 * * *`, `index.js:160`). An abandoned approval dies by itself; nothing escalates.

---

## 3. Scope and authorization enforcement — **the key question**

### 3.1 Verdict

> **No. Scope is not enforced at execution time.**
> The single enforcement point is `dispatch.js:243` (`authorizeProof`) → `policy.js:356` (`this.inScope(a)`), which runs **in the Worker, before the `workflow_dispatch` POST**. The workflows and harnesses contain **zero** scope logic.

### 3.2 The negative evidence (tested, not assumed)

Grep for scope primitives across every prove workflow:

```
$ grep -rn "scope|allowlist|in_scope|policy" .github/workflows/*.yml
.github/workflows/deploy.yml:42:   # ... comment about the policy engine
.github/workflows/eval.yml:43:     # ... comment referencing deploy.yml scoping
```
→ **No match in `prove.yml`, `prove-web.yml`, `prove-infra.yml`, `prove-solana.yml`.** The two hits are comments in unrelated workflows.

Same grep across the runner and harness:

```
$ grep -n "scope|allow|policy|hostCovered|authorize" app/build/plane-run.mjs app/build/plane-harness.js app/build/plane-patch.js
app/build/plane-harness.js:182:  kind: 'unauthorized_access',   # <- a verdict label, not a check
```

### 3.3 What the workflows validate instead — syntax, never scope

| Workflow | Check | file:line | What it proves |
|----------|-------|-----------|----------------|
| `prove-web.yml` | "is it an absolute http(s) URL" | `:68-81` | **shape only** — `https://anything.test` passes |
| `prove-infra.yml` | "is it a bare hostname" | `:61-76` | **shape only** — `evil.test` passes |
| `prove.yml` | `git clone` then `git checkout` | `:166-168` | **existence only** — any git URL is cloned and built |
| `prove.yml` | `cast chain-id` vs pinned id | `:183-208` | **chain identity only** — not scope |
| `prove-solana.yml` | repo/commit presence | — | shape only |

And the harnesses act on whatever they are given:

- `plane-harness.js:120-126`: `fetch(TARGET, …)` — arbitrary URL.
- `plane-harness.js:165`: `fetch(TARGET, {method: METHOD, redirect:'manual'})`.
- `plane-harness.js:245`: `fetch('https://' + name + '/')` for the takeover probe — arbitrary name.
- `prove.yml:166`: `git clone --quiet "${{ inputs.repo }}" target`.

`redirect: 'manual'` (`plane-harness.js:124`, cited in `prove-web.yml:27-28` as a scope defence) prevents a redirect *chain* from walking off-host. It does **not** constrain the *initial* target. It is a real mitigation against one specific pivot, not a scope gate.

### 3.4 If an out-of-scope target reached the workflow, what would stop it?

**Nothing.** Concretely:

1. GitHub `workflow_dispatch` accepts `inputs` from anyone holding `Actions:write` on `GITHUB_REPO`. The Worker gate is not in that path. `dispatch.js:132-148` is a plain authenticated POST; the workflow has no way to know whether the Worker authorised it, because the Worker sends no signed scope assertion in the body (`dispatch.js:356-359` = plane inputs + optional methodology block).
2. The body carries no RoE, no scope set, no `authorization_ref`. `prove.yml`'s input list (`:25-84`) is `repo, commit, contract, fork_block, chain_id, hunt_id, address, fuzz_playbook, methodology` — **there is no scope field to check**.
3. `prove-web.yml`'s docstring claims "a web2 proof issues requests at an endpoint the engagement already authorizes" (`:25-26`). That is an assertion about the caller, not a control in the file.

### 3.5 The deeper problem: the Worker-side gate cannot fail on a fresh brief

`PolicyEngine.authorize` (`policy.js:337`) applies five checks. Their real strength:

| Check | file:line | Effective? |
|-------|-----------|-----------|
| Time window | `:350` | ✅ real (`window_start = now`, `window_end = now + time_box`) |
| Technique deny-list | `:353` | ❌ `denied_techniques` is hardcoded `[]` (`policy.js:579`) — can never deny |
| `inScope` | `:356` → `:283` | ⚠️ **see below** |
| Mutability ceiling | `:366` | ✅ real and decisive (this is what blocks the default brief) |
| Live chain writes | `:360` | ✅ real (needs `LiveWriteGrant`) |

`inScope` breaks down per axis:

- `chain_address`: compares against `roe.chain_addresses[chain_id]` — but that map is **built from the brief's own targets** (`policy.js:557`), so the comparison is a tautology (`PolicyEngine.inScope` `:291-299`).
- `repo`: **`return [true, 'repo targets are read-only clones']`** (`policy.js:301-302`) — unconditional allow.
- `cidr`/IP: iterates `roe.cidrs`, which is **hardcoded `[]`** (`policy.js:574`) — so every IP is denied (fail-closed, but also unusable).
- `url`: iterates `roe.urls`, again built from `brief.targets` (`policy.js:558-565`) — tautology.
- `domain`: iterates `roe.domains`, again from `brief.targets` (`policy.js:566-570`) — tautology.
- `excluded`: `brief.out_of_scope ?? []`, and `intake.js:172` reads `ctx.out_of_scope ?? []`, and **neither call site ever sets `ctx.out_of_scope`** (`index.js:587-591` and `ui/work.js:81` pass only `program_id`, `authorization_ref`, `scope_hints`). So `excluded` is **always empty** — the "never touch" list rendered at `intake.js:221-222` can never be populated.

**Consequence:** for a fresh free-text brief, `inScope` compares the operator's target list against the operator's target list. It would deny only if the two disagree, which they cannot. The engine is structurally sound (the code is careful, well-commented, and `canonicalUrl`/`urlContained` exist precisely to stop substring bypasses) — but **it has no independent notion of the authorised scope to check against.**

### 3.6 The scope data exists but is not wired to the gate

- `targets/scope.js` parses real programme scope into `assets` rows with `in_scope` (`:450, :555, :624, :695`).
- `targets/scope.js:275` defines `refuseDispatch(programme)` — the "silence is not consent" gate.
- **Its own comment says it is not wired:** *"It is deliberately NOT wired into `dispatch.ts` from this module… The wire-in is one call before `authorizeProof()`"* (`targets/scope.js:268-271`). Grep confirms: `refuseDispatch` is only re-exported (`targets/index.js:54`), never called.
- `assets` reaches the dispatch path **only as question suggestions**, `LIMIT 4`, for the refusal card's anchor options (`index.js:718-730`).

**INFERRED:** this is the single highest-value fix in the whole track. It converts `inScope` from a tautology into a real check, and it is a one-call insertion at the location the author already documented.

### 3.7 What *is* enforced, and honestly so

- An unanchored brief cannot reach compute: no `authRef` ⇒ no `approvals` row ⇒ no `ok:` callback target (`index.js:613-624`).
- `automation === 'prohibited'` **is** blocked at intake: `authorize.js:226-227` returns `null`, which suppresses the approvals row. This is a real gate, applied early.
- `POST /hook/proof` fails closed when `PROOF_HOOK_SECRET` is unset, and refuses on mismatch (`index.js:81-90`).
- An orphan verdict (valid secret, unknown `hunt_id`) is recorded but **never promoted to a finding** (`index.js:1267-1275`) — good defence against a forged callback.
- `proof.js`/`report.js` will not emit anything without `proven`, and `report.js` refuses without a measured delta or an in-scope ledger asset (`report.js:141-152`).

---

## 4. Question loop

**Round trips.** `compile()` returns questions only if `targets.length === 0` **or** the class is genuinely ambiguous (`intake.js:117-143`). Then:

- **Typical brief (a URL or host in the text): 0 questions.** `confidentClass` is true for any `0x…`, any `http(s)://`, any dotted hostname (`intake.js:112-115`). Verified: `look at https://app.example.com/api/login` compiles directly to a brief, no questions.
- **Sparser brief ("hunt example"): 1 question** (target).
- **Worst case: 2 questions** — that is the entire vocabulary. `intake.js` only ever pushes `target` and `class`; there is no code path emitting a third distinct kind despite the `slice(0, 3)` and the "THREE QUESTIONS" header (`index.js:768`).
- Because `questionKeyboard` renders options for `qs[0]` only (`index.js:771-777`), each question is its own round trip: **text → q1 → q2 → Authorize card → tap = 4 human actions worst case, 2 typical.**

**Partial answers.** Yes — answers accumulate in the draft and re-enter the same function: `huntFrom(env, chatId, draft.raw, draft.hints, { ...draft.answers, [key]: value }, msgId)` (`index.js:334`). One important side-effect: once any answer exists, the model is skipped entirely — `compileWithEnrichment` returns the deterministic floor with `skipped='operator answers present; deterministic compile is authoritative'` (`intake-enrich.js:352-354`). Partial answers therefore *reduce* brief quality, not just interaction count.

**Never answered.** The draft persists in `intake_sessions` keyed only by `chat_id` with `state='asking'` (`index.js:660-663`). `readDraft` (`index.js:671-697`) applies **no age check and no TTL** — a stale draft is honoured indefinitely until a new hunt overwrites it. If the operator answers weeks later via the old keyboard, `ans:` resumes the *stored* raw text (`index.js:307-335`). Note the careful sibling: `ok:`/`no:` approvals *do* expire (`index.js:1040`), so the approval path is time-bounded but the question path is not. **INFERRED risk:** a materially stale brief could be resumed and then approved, with a fresh `window_start = now` (`policy.js:572`) — the time box is measured from dispatch, not from intent.

---

## 5. Autonomy verdict

**No — this cannot run a full hunt with zero interaction.** Two independent reasons:

**(a) Structurally impossible: there is no unattended entry point.**
- Only two `INSERT INTO approvals` sites exist (`index.js:632`, `ui/work.js:98`), both inside operator-initiated handlers.
- `approveAndDispatch` has exactly two callers: `index.js:384` (a Telegram button) and `ui/work.js:189` (a UI POST).
- Cron (`index.js:136-171`) runs `runSentinel`, `deskTick`, `runCrawler`, `deskAnalystTick`, `runMaintenance`, `runCalibration`, `runBriefing` — **none of them compile a brief, insert an approval, or dispatch.** Discovery (`discovery.js`) writes `programs`/`assets`; the sentinel (`sentinel.js`) writes watchlist alerts. Neither reaches the dispatch path.

**(b) Even with a synthetic caller, the default path dies at the gate.** Verified by execution:

```
plain  | depth_mut= read     | gate= deny  | reason= mutability simulate exceeds RoE ceiling read
deep   | depth_mut= simulate | gate= allow | reason= ok
```
`dispatch.js:91` hardcodes `mutability: 'simulate'`; `intake.js:48` (`shallow`) and `:100` (default arm) give `mut:'read'`. **A brief compiled with no depth keyword can never dispatch.** The operator must type "exploit", "prove", "drain", "steal", "deep", "thorough", "full", or "everything" (`intake.js:95-101`) — or tap a playbook whose `mut` is `read` (e.g. `web.jwt` at `playbooks.js:105`), which then hits the *same* ceiling. This is a defect, not a safety gate: the gate is doing its job correctly against a ceiling that was set too low by a default.

### Blocked by deliberate safety gate (KEEP)
- **Human approval of each engagement** (`index.js:376`, `ui/shell.js:308`). This is the load-bearing control. It is also currently *carrying* the weight of the missing execution-time scope enforcement — which is exactly why §3 must be fixed before this gate is loosened in any way.

### Blocked by missing automation or defect (FIX)
Everything else in §6.

---

## 6. Ranked autonomy blockers

Ranked by (impact on unattended operation) ÷ (effort). Effort: **S** ≤ half day, **M** ≤ 2 days, **L** > 2 days.

| # | Blocker | Evidence | Effect | Fix | Effort | Class |
|---|---------|----------|--------|-----|--------|-------|
| **B1** | **Default depth can never pass the gate.** `dispatch.js:91` hardcodes `mutability:'simulate'`; `intake.js:48`/`:100` default to `read` | verified by execution: `deny — mutability simulate exceeds RoE ceiling read` | **Every no-keyword brief is denied.** This is the #1 reason "it doesn't work" | Derive the requested mutability from `brief.max_mutability` (it is already on the brief at `intake.js:167`) instead of hardcoding; keep the engine's ceiling check as the guard | **S** | **AUTOMATE / FIX** |
| **B2** | **No scope enforcement at execution time** | no scope refs in any `prove*.yml`; `prove.yml:166` clones any repo; `plane-harness.js:120` fetches any URL; body carries no scope field | An `Actions:write` holder, or a bug in derivation, reaches any target | Add a signed scope assertion to the dispatch body; have each workflow verify it before acting (add a `scope` field to the input contract). **Reuse, don't rewrite:** `urlContained` (`policy.js:198`) and `hostCovered` (`policy.js:222`) are pure, already hardened against userinfo/encoded-traversal, and importable from `app/build/policy.js` by the runner — so the workflow-side check can be the *same* logic the Worker used, not a divergent second implementation | **M** | **AUTOMATE / FIX** (prerequisite to any loosening of B-keep) |
| **B3** | **The Worker gate is a tautology for fresh briefs** | `policy.js:550-576` builds `domains`/`urls` from `brief.targets`; `policy.js:333` checks targets against them; `repo` ⇒ unconditional `true` `:301` | Gate cannot fail on the thing it claims to check | Wire `refuseDispatch` + `assets.in_scope` into `roeFromBrief` so `domains`/`urls` come from the *programme*, not the brief. The author already documented the insertion point (`targets/scope.js:268-271`) | **M** | **AUTOMATE / FIX** |
| **B4** | **`excluded` / `denied_techniques` / `approval_techniques` are always empty** | `policy.js:578-581`; `intake.js:172`; neither caller of `compile` sets `ctx.out_of_scope` (`index.js:587-591`, `ui/work.js:81`) | "never touch" list is unpopulatable; technique deny-list dead | Populate from `assets.in_scope=0` and programme terms during intake | **S** | **AUTOMATE / FIX** |
| **B5** | **Free-text web2 can never select the only web2 harness** | `WEB2_HARNESSES = {web.jwt}` (`planes.js:500`); `web.jwt` has **no `detect[]`** (`playbooks.js:101-113`); `route()` (`playbooks.js:462`) selects only on `detect`; then `pickPlaybooks` slices to 8 (`intake.js:200-203`) | verified: `route('web2','https://…/api/login')` → `["web.idor"]`; `derive` → `missing:["playbook"]`. Web2 free-text is **0% dispatchable** | Give every harnessed playbook `detect[]` terms, and have `pickPlaybooks` guarantee at least one harnessed id | **S** | **AUTOMATE / FIX** |
| **B6** | **Bare host ≠ valid web2 target** | `extractTargets` yields `app.example.com` (`intake.js:53-73`); `buildWeb2` requires absolute `http(s)://` (`planes.js:250-270`); verified `missing:["target"]` | "hunt app.example.com" (the most natural phrasing) cannot dispatch on web2 | Synthesise `https://<host>` when class is web2 and only a bare host was given (shape is already known) | **S** | **AUTOMATE / FIX** |
| **B7** | **No unattended entry point at all** | only 2 approvals-INSERT sites + 2 `approveAndDispatch` callers, all human-driven; no cron reaches dispatch (`index.js:136-171`) | Zero-interaction is structurally impossible regardless of B1-B6 | Add a scheduled driver: pull next in-scope asset with `automation='allowed'`, compile, gate, dispatch — gated on B2+B3 landing first | **L** | **AUTOMATE** (after B2/B3) |
| **B8** | **Harness coverage 13/28** | `dispatchablePlaybookIds` → 13 of 28; web2 1/12, infra 1/12, solana 1/3 | Most classes refuse by name (`noHarnessReason` `planes.js:618`) | Build harnesses: `web.authz.function`, `web.idor`, `web.ssrf`, `web.cors` first (highest prior, read-only) | **L** | **AUTOMATE** |
| **B9** | **EVM PoCs need a human edit** | 14 × `CHANGE_ME` in `poc.js` (`:210, :222, :233, :399, :452, :461-462, :477, :496-497, :536, :557, :570`); documented `OPERATING.md:130-132` | Every `sol.accesscontrol`-family run is built on a placeholder signature | Derive signatures from the target ABI (available after the clone in `prove.yml:166`) and substitute before the build | **M** | **AUTOMATE** |
| **B10** | **`report.js` is never called** | `buildReport` (`report.js:141`) imported only by `tests/report.test.mjs:28` | A proven finding never becomes a written report — full manual authoring each time | Call it from `ingestProofs` on `proven`, store markdown beside the finding | **S** | **AUTOMATE** |
| **B11** | **No filing stage exists** | no triage/submit/file module; `findings.status` only ever `'candidate'` (`index.js:1277`) | The chain stops one step short of delivery | Define a `findings.status` lifecycle + a submission adapter per programme | **L** | **AUTOMATE** (or keep human for accountability — see H9) |
| **B12** | **`rate_limit_rps` is declared but not honoured** | `policy.js:587` stores it; `pace.js:172-180` provides `pacerForBrief`; **no call site outside `pace.js`** (`desk/flow.js:326` uses a different, desk-local pacer) | An engagement can declare a rate no outbound path respects — the exact bug `pace.js:1-24` says it exists to remove | Wire `pacerForBrief` into the web2/infra harness runners | **M** | **AUTOMATE / FIX** |
| **B13** | **`WEB2_SESSION_TOKEN` is global, not per-engagement** | `prove-web.yml:104` reads one repo secret; comment at `:99-100` claims "the engagement's own session token" | Concurrent unattended web2 authz runs share one fixed identity | Pass a per-hunt credential reference through the dispatch body (secret indirection) | **M** | **AUTOMATE** |

### Split

**Totals: 13 ranked blockers (B1–B13), of which 0 are safety gates; plus exactly 1 human gate (H6) that should stay.**

**KEEP-AS-GATE (1 item, and it is not one of the 13 rows):** human approval of each engagement — **H6** (`index.js:376` / `ui/shell.js:308`). *Note:* it is currently absorbing responsibility for B2 and B3. Fix those **before** considering any auto-approval, or the gate becomes the only thing standing between the bot and an unauthorised target — and it is a person tapping a button on a brief whose scope check is a tautology.

**SHOULD-AUTOMATE / FIX (13 of 13 rows):** B1–B13 in full — no blocker in the table is a deliberate safety control. Five are outright defects rather than missing features (B1 the mutability mismatch, B3 the tautological scope check, B4 the dead deny-lists, B5 the unselectable harness, B6 the bare-host shape rejection); the rest are missing automation. Beyond the table, these touchpoints should also be automated: **H2** (free-text brief), **H3/H4** (questions answerable from `assets`), **H8** (report authoring), **H7** (only once signatures are derived from the target ABI — B9).

**Sequencing constraint:** B2 and B3 must land *before* B7 (unattended driver). An unattended driver on top of an unenforced, tautological scope check is strictly worse than a human tap on the same defect.

**Corroboration from a sibling track (F-landscape, completed independently):** it found that `hostsInCommand` (`policy.js:237`) — the parser that extracts every host a shell command would touch and returns `null` to force refusal — is unit-tested but has **no call site**, because `TargetKind` has no `command` member. That is the same defect class as B2/B3 on a different axis: the gate primitives exist and are sound, and nothing invokes them. Any executor that can run arbitrary commands must wire `hostsInCommand` *before* it ships, for the same reason B2 must precede B7.

---

## Appendix — the user's original question: hunting different chains

**"If I hunt different projects on different chains, it won't work?"** Correct — and for a specific, mechanical reason (this is the *chain* axis, distinct from scope).

Adding a chain today requires **four coordinated edits**:

1. `chains.js:40-78` — a `CHAINS` row (`id`, `name`, `rpc_env`, `explorer`, `native`, `mainnet`).
2. `policy.js:505` — automatic: `chainForBrief` refuses any id absent from the registry with *"is not a chain this bot can fork"*.
3. **`prove.yml:119-128`** — a literal `case "$CHAIN_ID"` arm. This is the blocker: GitHub Actions cannot index secrets dynamically, so each chain is a hand-written `RPC_<id>: ${{ secrets.FORK_RPC_<id> }}` pair (`prove.yml:92-99`) plus a case arm.
4. A new `FORK_RPC_<id>` Actions secret.

Current registry (`chains.js`): **5 chains** — `1` Ethereum, `8453` Base, `84532` Base Sepolia, `11155111` Ethereum Sepolia, `31337` Anvil.

Chain-less briefs fall back to a single `FORK_RPC` secret and are explicitly labelled unpinned (`chains.js:90`, `prove.yml:104-114`), with the warning that a delta there "must not be read as a reproduction" — and `:184-190` skips the chain assertion entirely, so an unpinned run is unverifiable by construction.

**Better shape (one edit per chain, not four):** hold a single `FORK_RPCS` secret as a JSON map `{"1":"…","8453":"…"}` and resolve it in one step; or keep one `FORK_RPC` and rely on the `cast chain-id` assertion at `prove.yml:183-208` — which already exists and already refuses a wrong-chain fork — to catch misconfiguration. Non-EVM chains need a plane, not an RPC: `PLANES` (`planes.js:518-570`) has no entry for anything but the four registered classes, so a new chain family is a new plane, not a new chain row.

---

## Coverage gaps and limitations

- **Read-only audit.** No hunt was dispatched; no live target touched. Two Node invocations against pure functions (`compile`, `deriveForBrief`, `roeFromBrief`, `PolicyEngine.authorize`) confirmed B1/B5/B6 — these are *source-derived plus execution-confirmed*, not live-target observations.
- **`GITHUB_REPO` / deployed Worker state not inspected.** Whether `GITHUB_DISPATCH_TOKEN`/`GITHUB_REPO` are set on the live Worker is unknown; `dispatch.js:321-325` would report it. The repo's `.git/config` holds a live credential and was deliberately not read (per assignment).
- **`prove-solana.yml` and `prove-infra.yml` were not read in full** — line-level checks for `prove.yml`/`prove-web.yml` plus a repo-wide grep establish the negative for all four; a full read would strengthen it but would not change the conclusion.
- **`desk/` (trading) is out of scope** and untouched; `desk/flow.js` was only consulted to confirm `pacerFor` has no engagement-side caller.
- **INFERRED items** are marked inline: §3.6 (wiring value), §4 (stale-draft resumption risk), §3.5 (tautology framing — the *mechanism* is observed, the *exploitability* is inferred).
- **`total 28 playbooks / 13 dispatchable`** is computed at runtime from `dispatchablePlaybookIds(PLAYBOOKS)` — observed, not inferred.
