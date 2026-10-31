# F — Landscape: how autonomous security tools are built, and what Asterion structurally cannot do

**Read-only comparison. No bot code was modified and no target was tested.** Subject: `wbot` @ `edb7781`.

---

## Summary (5 lines)

1. Asterion's ceiling is not its proof standard — its proof standard is **stronger than every tool surveyed here** (reproduced + causal-via-re-run + measured impact); the ceiling is that the *action* it can take is **code keyed to a playbook id**, so a bug class with no hand-written harness cannot be attempted at all (28 playbooks defined, **13 dispatchable**, `web2` has exactly **one** harness).
2. Strix / PentAGI / CAI / XBOW's solver agent all remove that ceiling the same way: the next action is **data produced at runtime by a model** (a shell command, a Python script, an HTTP request) instead of a branch in a switch — which is why they can hit a novel class, an arbitrary chain, and an authenticated multi-role flow without a code change.
3. The price is measurable and the most mature player did **not** pay it: XBOW keeps a **non-AI, per-CWE deterministic validator** and *labels* the agent-validated classes "some false positives are possible / public preview"; AutoPenBench measured **21% fully-autonomous vs 64% assisted**, and CAI was **0.59× human speed** on multi-stage machines.
4. So the trade is not "agent beats harness" — it is **breadth bought with verification**, and the fix is not to replace the judge. It is to put an **executor that takes a spec** underneath the *existing* judge, so an LLM can propose any class while `proven` still requires the same three gates.
5. The load-bearing prerequisite nobody has built yet is small and already half-written: `hostsInCommand` exists and is unit-tested but **nothing calls it**, because `TargetKind` has no `command` member — so no shell string can reach the gate. Until that is wired, an open-ended executor is un-gateable and must not ship.

---

## Part 1 — The subject, read from source

Established by reading `README.md`, `PLAYBOOK.md`, `ECOSYSTEM.md`, `app/build/planes.js`, `playbooks.js`, `plane-run.mjs`, `plane-harness.js`, `proof.js`, `judge.mjs`, `hunt.js`, `methodology-dispatch.js`, `chains.js`, `.github/workflows/prove-web.yml`.

**Execution.** A Cloudflare Worker that dispatches GitHub Actions jobs; it does not scan (`README.md`: "a GitHub worker that never sleeps … a GitHub Actions farm that does the heavy compute"). Confirmed: `dispatch.js` needs `GITHUB_DISPATCH_TOKEN` + `GITHUB_REPO`.

**The gate.** `deriveForBrief` in `planes.js:654` resolves **plane → harness → inputs**, in that order, and returns a *named* refusal at each step:

- no plane → `noPlaneReason(cls)` (`planes.js:603`)
- plane, but the playbook is not in the plane's harness set → `noHarnessReason(cls, playbook)` (`planes.js:618`)
- plane + harness, missing inputs → the builder's `missing[]` / `why[]`

**Coverage, measured not assumed.** Running `dispatchablePlaybookIds` against `PLAYBOOKS`:

```
total playbooks: 28
dispatchable:    13   web.jwt, web.takeover, sol.reentrancy, sol.accesscontrol,
                      sol.oracle, sol.rounding, sol.inflation, sol.upgrade,
                      sol.svm-signer, sol.signature, sol.delegatecall,
                      sol.flashloan, sol.dos
by class:        {web2: 14, infra: 1, solidity: 10, solana: 3}
harness sets:    solidity 10 | web2 1 | infra 1 | solana 1
```

So **14 web2 playbooks exist and 1 runs.** `WEB2_HARNESSES = new Set(['web.jwt'])` (`planes.js:500`).

**The proof contract.** `judge()` in `proof.js` requires three independent conditions:

1. **reproduced** — non-zero exit *and* a real assertion in the output (not an infra failure; `INFRA_FAILURE` vs `REAL_ASSERTION` regex sets)
2. **causal** — the same test passes once the fix is applied (`with_fix`) or once the enabling precondition is removed (`without_precondition`); absent a counterfactual the verdict is capped at `partial`
3. **impactful** — `IMPACT_BEFORE` / `IMPACT_AFTER` / `IMPACT_DESC` markers, non-empty and different

`judge.mjs` header: *"Deliberately dumb … No model touches this path."*

**The harness convention.** `plane-harness.js` emits three variants per playbook — `attack` (asserts the *safe* property, so it FAILS when the bug is present), `control` (fixture sanity, must always pass), `nocond` (attack minus the enabling precondition). `plane-run.mjs` runs all three into `results/`, `controls/`, `counterfactual/`, and `exit 3` records a *refused precondition* as a `.reason` file, never as a failing test.

**Where the LLM actually is.** Two places, neither in the proof path:

- `intake-enrich.js` — repairs a *brief* (maxTokens 400, temperature 0, one attempt, no retry loop)
- `desk/thesis.ts` — paper-trading commentary

`llm.js` provider chain: local → gemini → groq → openrouter → workers-ai, gated by `DAILY_LLM_BUDGET` (default 200 000 tokens/day).

**There is no agent loop.** Grepping for `tool_calls`, `function_call`, `maxSteps`, `tools:` across `build/` and `src/` finds only `fuzzseed.ts maxSteps` (a cap on fuzzed *transaction sequences*). The executor is a generator function per playbook; `synthesizePlaneHarness` returns `null` and the run exits 2 for anything unregistered.

**Why this is a ceiling and not a bug.** `hunt.js:rank()` says it plainly: *"A class with no harness goes last even if its prior is high, because nothing can prove it."* And `methodology-dispatch.js` is explicit that methodology reaches the dispatch as a declared input but *"cannot change the byte content of a generated PoC"* — the PoC is regex + templates. The design is coherent and honestly documented. It is simply narrow by construction.

**Corroborating weakness:** `PLAYBOOK.md` notes every `web.*` class has `n = 0` in the 180 907-row corpus — the corpus is 100% web3. So for the 14 web2 playbooks the prior mechanism contributes nothing; only 1 of them is even runnable.

---

## Part 2 — The landscape, from primary sources

### XBOW (closed source; public docs)

**Execution.** Not a single agent loop. A persistent **coordinator** decides what to test, then spawns short-lived attack agents: *"Autonomous agents are short-lived attack workers with fresh context and one objective. They are retired after each mission to avoid bias"* ([xbow.com/platform](https://xbow.com/platform)). The solver itself is a classic loop — *"Each iteration consists of the solver deciding on an action: a command in a terminal, writing a Python script, running one of our pentesting tools. We vet the action and execute it, show the solver its result"* — cut off at **80 iterations**, after which a fresh agent is started because *"it becomes more efficient to start a new solver agent unburdened by the misunderstandings … accumulated over time"* ([alloy-agents](https://xbow.com/blog/alloy-agents)).

**Deciding what to test.** Coordinator + heuristic effort allocation; steerable via "guidance cards" (attack surface, priorities, attack strategy, validation, safety) ([docs](https://docs.xbow.com/console/guidance/guiding-tests-expert/)).

**Novel bug class.** Two-layer answer, and this is the important part. A new class is *attempted* like any other (the solver writes the request). But it is only *reported as validated* if a validator exists. From the classification table ([docs](https://docs.xbow.com/console/reference/vulnerability-classification/)):

- `Deterministic` — "XBOW confirms findings for this class with a **non-AI exploit validator**. All findings are verified as true vulnerabilities, so the class reports no false positives." (SQLi, XSS, SSRF, XXE, path traversal, cmd injection, deserialization, open redirect, upload, missing auth…)
- `AI agent` — "XBOW uses agents rather than a deterministic validator to confirm findings for this class, so **some false positives are possible**" (CWE-639 IDOR, CWE-863 incorrect authorization — both **Public preview**, plus user enumeration, default creds, public CVE)
- `Not applicable` — informational, never exploited (CSRF, session fixation, clickjacking, forced browsing…)

**How it proves.** Three distinct mechanisms, explicitly separated ([impact demonstration](https://docs.xbow.com/console/reference/impact-demonstration/)): **validators** (non-AI, per-CWE, run on every applicable finding), **canary tokens** (customer-planted GUID; only the SHA-256 is given to the coordinator — *"This separation between the stored configuration and the information passed to the pentest is essential to providing genuine validation"*, [docs](https://docs.xbow.com/console/how-to/validate-with-canaries/)), and **impact demonstration** (Off / Moderate / Deep escalation, where Deep chains across weakness classes).

**Verification status of claims.** The architecture and validator taxonomy are documented product behaviour — treat as *verified as described*. The 85%-vs-principal-pentester / 28-minutes-vs-40-hours benchmark is a **vendor benchmark on vendor-commissioned challenges** ([xbow-vs-humans](https://xbow.com/blog/xbow-vs-humans), 2024-08-05) — **marketing**. `ECOSYSTEM.md` independently notes XBOW's own 2024 benchmarks carry an editor's note calling them *"outdated and should no longer be used."* Likewise "200 Zero-Days, Zero False Positives" is a **webinar title**, not a measurement.

### PentAGI (MIT, self-hosted)

**Execution.** Go backend + PostgreSQL/pgvector + async task queue; agents run commands inside **isolated Docker sandbox containers** with 20+ pre-installed tools (nmap, Metasploit, sqlmap) ([README](https://github.com/vxcontrol/pentagi)). A two-node worker setup is recommended for production, and the README is unusually honest that mounting the host Docker socket *"grants an autonomous agent the host Docker API: it can start a privileged container, mount `/`, and compromise the entire node."*

**Deciding what to test.** A multi-agent hierarchy — orchestrator, researcher, developer, executor, plus adviser / reflector / planner / enricher / memorist. Planning is *optional* (`AGENT_PLANNING_STEP_ENABLED`, default false) and generates 3–7 steps.

**Novel bug class.** No registry, no gate — any class is attemptable because the agent emits tool calls. The real limit is the **tool-call budget**: `MAX_GENERAL_AGENT_TOOL_CALLS` = 100, `MAX_LIMITED_AGENT_TOOL_CALLS` = 20, with a Reflector invoked when the model fails to call a tool 3× in a row.

**How it proves.** It does not, in the sense Asterion means. The README's own capability-boundary section says it produces "a report" with "exploitation guides"; there is no validator, no counterfactual, no causal requirement. Validation is whatever the agent asserts plus the human reading the flow. **The "2× improvement in result quality" figure is self-reported testing with one local model (Qwen3.5-27B-FP8) — marketing-adjacent, not independently reproduced.**

### Strix (Apache-2.0)

**Execution.** A Kali-based Docker sandbox with a **persistent bash terminal**, a Playwright Chrome browser whose traffic is routed through a Caido proxy, a Python exploit runtime, and an HTTP proxy for intercept/replay ([tools/overview](https://docs.strix.ai/tools/overview), [terminal](https://docs.strix.ai/tools/terminal), [browser](https://docs.strix.ai/tools/browser)). Multi-agent graph; up to 5 markdown "skills" injected into a spawned agent's system prompt ([skills](https://docs.strix.ai/advanced/skills)).

**Deciding what to test.** `--scan-mode quick|standard|deep` (deep is default, 1–4 h), plus `--instruction` free text; an OpenAPI/Postman spec authorises the declared base URLs *"so the agent reads the contract and tests the full declared surface instead of discovering endpoints by crawling"* ([CLI](https://docs.strix.ai/usage/cli)).

**Novel bug class.** Fully open-ended — it is a shell.

**How it proves.** Here the docs and the marketing diverge. The README claims *"Real exploit validation — working PoCs, not false positives like legacy vulnerability scanners."* The CLI docs describe `--max-budget` (USD, checked after each model response) and `--max-turns` (default **500 per agent**), an exit code `2` on findings, and `--fail-on` severity. **No deterministic validator, no counterfactual, no causal check is described anywhere in the documentation.** "PoC exists" is a weaker standard than "the test stops failing when the cause is removed." Treat "no false positives" as **marketing**.

**Scope.** `--scope-mode` is `auto|diff|full` — that is **PR-diff scope for code review**, not authorization scope. `ECOSYSTEM.md` independently grepped `strix/**/*.py` and found the same. `--target` accepts anything.

### CAI / Cybersecurity AI (MIT + research-only carve-out)

**Execution.** Python framework; agents implement ReAct — one reasoning step, zero-to-n tool calls per *interaction*, turns composed of interactions ([README](https://github.com/aliasrobotics/cai), [arXiv 2504.06017](https://arxiv.org/abs/2504.06017)). Tools are `generic_linux_command`, `execute_code`, `web_search`, `sshtunnel`, plus MCP (Burp, Ghidra).

**Deciding what to test.** Agentic *patterns* — swarm, hierarchical, chain-of-thought, auction, recursive. `CAI_MAX_TURNS`, `CAI_PRICE_LIMIT`.

**Novel bug class.** Open-ended; the shell is the interface.

**How it proves.** It does not. Guardrails are prompt-injection and dangerous-command filters — a *safety* control, not a *correctness* control. The paper's own bug-bounty tables show real limitations: several findings "Duplicated", one "Rejected", one "Out of scope" — i.e. submitted-but-not-validated output, exactly the failure mode Asterion's judge exists to prevent.

**Measured, and this is the strongest counter-evidence in this whole document:**
- HTB *challenges* (single-task): 346× faster than human first-blood.
- HTB *machines* (multi-stage): **0.59× — slower than humans**, outperforming on 1 of 11.
- The authors' own conclusion: *"fully-autonomous cybersecurity systems remain premature … effective security operations still require human teleoperation."*

**Licence caveat already recorded in `ECOSYSTEM.md`:** the MIT applies to the vendored `openai-agents-python`; Alias-authored components are research-only, and the repo is archived.

### AutoPenBench (benchmark, not a tool)

33 tasks of increasing difficulty; the standardised comparison Asterion lacks ([arXiv 2410.03225](https://arxiv.org/abs/2410.03225)):

| Architecture | Success rate |
|---|---|
| Fully autonomous agent | **21%** (27% of simple tasks; 1 real-world task) |
| Semi-autonomous, human-assisted | **64%** |

This is the honest yardstick for the "open-ended agent" claim, and it is peer-reviewable rather than vendor-authored.

### Nuclei (the closest thing to Asterion's model, and why it wins anyway)

Nuclei is also a **template engine** — YAML with a protocol block (`http`, `dns`, `tcp`, `ssl`, `code`, `headless`), matchers, extractors, and a DSL for cross-protocol template context ([structure](https://docs.projectdiscovery.io/templates/structure), [multi-protocol](https://docs.projectdiscovery.io/templates/protocols/multi-protocol), [network](https://docs.projectdiscovery.io/templates/protocols/network)).

It has the *same* structural ceiling as Asterion — no template, no test — and yet it does not feel narrow, for three reasons that map directly onto Asterion's gaps:

1. **The unit of extension is data, not code.** A new class is a YAML file, not a generator function plus a registry entry plus a coverage test.
2. **The corpus is enormous and community-maintained** ("several thousand ready-to-use community-contributed templates", [FAQ](https://docs.projectdiscovery.io/templates/faq)) — "you write the template once and use it forever."
3. **One template can span protocols synchronously**, which is how it does subdomain takeover (DNS CNAME + HTTP body in one `dsl` matcher) — i.e. it can express a *chain*.

What Nuclei gives up is exactly what Asterion has: no counterfactual, no causal proof, no `proven`. It is a **detector**, not a prover — and that is why it is a companion tool rather than a competitor.

### Burp / DAST agent integrations (the shipped hybrid)

PortSwigger ships an **MCP server** for both Burp Suite and Burp DAST. Desktop extension exposes: send HTTP/1.1 and HTTP/2 requests *"with security controls"*, proxy history incl. WebSocket, Collaborator payload generation for OOB, Repeater/Intruder, and — the key line — **"Configurable target approval system for HTTP requests and history access"** ([BApp store](https://portswigger.net/bappstore/9952290f04ed4f628e624d0aa9dccebc)).

DAST side: *"The MCP server runs inside your existing Burp Suite DAST web server and is enabled by default … Your assistant can only use the same actions you have permission to perform in the Burp Suite DAST interface"* ([docs](https://portswigger.net/burp/documentation/dast/user-guide/using-ai/mcp-server), updated 2026-10-29).

This is the pattern in production: **the agent is free-form, the capability surface is a fixed tool list, and authorization is enforced at the tool boundary, not in the prompt.** It is also precisely what `ECOSYSTEM.md` concluded independently — *"the gate must be a data-model property, not a reasoning property."*

---

## Part 3 — The comparison

### 3.1 What they can do that Asterion structurally cannot

Concretely, by mechanism — not by feature name:

| Capability | Their mechanism | Asterion's mechanism | Why it is structural |
|---|---|---|---|
| Attempt a bug class nobody wrote code for | Model emits a shell command / Python script; the runtime executes any string | `synthesizePlaneHarness(playbook)` returns a fixed template or `null` → exit 2 | The action is **code indexed by playbook id**; there is no path from "an idea" to "an execution" |
| Hunt on a chain nobody registered | RPC URL is a runtime env/CLI argument | `chains.js` row **and** a literal `FORK_RPC_<id>` case in `prove.yml` | Chain identity is **compile-time config in two places**, because Actions cannot index `secrets` dynamically |
| Chain two findings into a bigger one | Coordinator retains a model of the target; Deep impact demo "chains weaknesses, including into other vulnerability classes" | `plan.json` is one attempt with one `test_name`; judge adjudicates that attempt | The unit of work is a **single fixed attempt**; there is no "then, based on what I saw, do X" |
| Test authenticated multi-role flows | Strix `--instruction "credentials: user:pass"`; XBOW structured auth (user/pass, magic link, MFA/TOTP, bearer) | One env var, `secrets.WEB2_SESSION_TOKEN`; `METHOD: GET` hardcoded | The credential model is **a single string**, not a per-engagement session object |
| Mutate state (POST/PUT) | By design | `prove-web.yml` pins `METHOD: GET` | Method is a **literal in the workflow file**, even though the brief already carries `mut: read \| simulate \| mutate` |
| Try a payload the author didn't think of | Agent sees a 403 and writes an encoder | `web.jwt` harness ships a fixed `forgeries()` list | Payloads are **baked into the generator** |
| Explore an unknown surface | Katana/ffuf/Arjun via shell, agent decides depth | `discovery.js` fetches exactly **2 paths per host** (`/.well-known/security.txt`, `/security.txt`), 50-subrequest budget | Discovery is **a fixed crawler with a spec**, not an activity |

One more, less obvious: **the corpus cannot help the web plane.** `PLAYBOOK.md` records that every `web.*` class has `n = 0` in the 180 907-row digest, and `rank()` labels those `"no ground truth in corpus; cannot be validated historically"`. So the one mechanism that could compensate for narrow coverage — priors — is inert exactly where coverage is thinnest.

### 3.2 Architectural vs additive

**Architectural** (needs a redesign of a seam, not a new file):

- **The harness ceiling.** `plane-run.mjs` hardcodes `playbook → spec`; `plane-harness.js` is a switch of generators. Removing the ceiling means inverting this: an **executor takes a spec**, and something else produces specs. That is a new seam between "decide" and "execute."
- **The one-shot attempt model.** `plan.json` → runs → `verdicts.json` is a straight line. Exploration and chaining need a loop with retained state, and `judge()` currently has no notion of "attempt 2 used what attempt 1 learned."
- **The refusal taxonomy is class-shaped.** `noHarnessReason` assumes the answer to "can this class run?" is a set membership. Under an open executor the honest answer becomes "yes, with a novel spec, and here is the counterfactual plan" — a different object.

**Additive** (bolt on without moving a seam):

- HTTP method / mutability. `mut` already exists per playbook; `TargetKind` already distinguishes kinds; the workflow literal is the only blocker.
- Per-engagement credentials. `scopeTargetFor` already carries an adapter; add a credential object to the brief and pass it as env.
- Chain registry consolidation. The two-place problem is a smell, not a design constraint — one source generating both.
- Budget and loop caps. `DAILY_LLM_BUDGET` and `quota` already exist and already degrade gracefully.
- **Wiring `hostsInCommand`.** Written, unit-tested, called by nothing, because `TargetKind` (`policy.ts:26`) is `'host' | 'domain' | 'cidr' | 'chain_address' | 'repo' | 'url'`. Adding `'command'` and calling it at the gate is a contained change — and it is the **precondition for every open-ended executor.**

### 3.3 The real trade-offs of the open-ended agent approach

Not better. Different, and worse on three axes that matter to Asterion specifically.

**False positive rate.** This is not a matter of taste; it is measured.

- AutoPenBench: **21% autonomous vs 64% assisted** — a 3× gap from adding a human, on 33 standardised tasks.
- XBOW, the most mature commercial implementation, **kept the deterministic validator** and quarantined agent-only validation to classes explicitly labelled *"some false positives are possible"* and shipped as *public preview*. If the best-resourced team in this space could have dropped per-CWE validators and didn't, that is evidence about the technique, not about their engineering.
- CAI's own bug-bounty tables contain entries triaged **Duplicated**, **Rejected**, **Out of scope** — the exact output Asterion's `judge()` is built to never emit.

The mechanism is simple and unavoidable: an agent's "I proved it" is a *token sequence*. Asterion's is an *exit code plus a second run against a patched tree*. No amount of prompting closes that gap, because the failure mode is the model believing its own summary.

**Reproducibility.** Agent runs are not byte-reproducible. Temperature, model version, tool ordering, and HTTP timing all vary. Every surveyed tool degrades to **transcript replay** — XBOW keeps "a full trace log for the test"; Strix writes `strix_runs/`; PentAGI stores every command in Postgres. A transcript answers "what did it do?" but not "does this still reproduce on this commit?" — which is the question a triager asks and the only question `judge()` will accept. Note the asymmetry: Asterion's `with_fix` re-run (`plane-run.mjs:165`, patch → `cargo-build-sbf` → same attack → restore) is a **re-execution**, not a re-reading. Nothing in the landscape does this.

**Cost.** Concretely:

- Asterion: GitHub Actions minutes (free tier) + a 200 000-token/day ceiling; the proof path itself is $0 in tokens because it is regex and templates.
- Strix: `--max-turns` default **500 per agent**, `--max-budget` in USD (checked after each response, sub-agents stop at 90%), deep mode 1–4 h. A 110k-context turn repeated 500× is three orders of magnitude more expensive than one `forge test`.
- PentAGI: monitoring/planning is self-documented as **2–3× token and time cost**.
- CAI paper: $109 total vs $17 218 human for 54 CTFs — cheap per challenge, but capped at **100 interactions**.

And a fourth axis that is usually omitted: **latency and reliability under failure.** CAI at 0.59× human on multi-stage machines means the agent approach is *slower than a human* precisely where Asterion's strong targets live (multi-step protocol logic).

**What Asterion gets right and must not lose.** The causal requirement is the single most defensible property in this whole comparison. Every other tool's "validated" means *a validator said so* (XBOW) or *the agent said so* (Strix, PentAGI, CAI). Only Asterion requires the falsifying test to **stop failing when the cause is removed**. That is why its reports survive triage, and it is exactly what a naive "just let an LLM drive" rewrite would throw away.

### 3.4 The hybrid pattern that keeps the rigor and removes the ceiling

Five layers. Every one maps to something that already exists in the tree or has a shipped precedent.

**L1 — Agent as proposer, never prover.**
The model's only output is a constrained **attempt spec**: `{target, class, actions[], falsifying_assertion, expected_impact {what, before, after}}`. It cannot emit a verdict, a severity, or a "proven". It sees only the skill pack, the corpus priors, and read-only recon. This is `intake-enrich.js`'s existing posture (temperature 0, one attempt, 400 tokens, JSON-only) scaled up from *repairing a brief* to *proposing an attempt*.

**L2 — A spec-taking executor (the missing piece).**
Replace `synthesizePlaneHarness(playbook)` with `synthesize(spec)` dispatching to a small set of **generic** executors rather than one per class:

- `http-replay` — method, headers, body, auth from a session object; already 80% present in `web.jwt`'s harness
- `shell` — inside the Actions runner, gated (see L5)
- `forge` — unchanged
- `bankrun` — unchanged

Strix and PentAGI both prove the executor set is small and stable (terminal + browser + python + proxy). The variance lives in the *spec*, which is data. This is also Nuclei's lesson: **make the unit of extension data.**

**L3 — The judge is untouched.**
`proof.js` stays exactly as it is. A novel class proposed by an agent still earns `proven` only via reproduced + causal + impact. This is the whole point: the agent buys **breadth of attempts**, not **leniency of verdicts**. A brand-new class simply cannot reach `proven` until its spec produces a real assertion and a measurable delta.

**L4 — Counterfactual must be declarable per spec, and absence is honest.**
For a novel class there is no `deriveSolanaPatch`-style fix derivation, so the spec falls back to `without_precondition` — which `judge()` already supports and `plane-run.mjs` already does for every non-Solana plane. The verdict is then `partial`, not `proven`. **That is correct behaviour and should be documented as such**: the hybrid raises the number of classes that can be *attempted* immediately, and the number that can be *proven* only as fast as counterfactual mechanisms are added. XBOW's two-tier Validated/Informational split is the same admission, made explicit to customers.

**L5 — Scope is enforced at the tool boundary, not in the prompt.**
This is the layer that makes L2 safe, and it is the one that is *missing today*. Precedents: Burp MCP's "configurable target approval system"; `ECOSYSTEM.md`'s own conclusion that "the gate must be a data-model property, not a reasoning property."

Concretely, this is where `hostsInCommand` finally gets called. It already refuses what it cannot resolve statically — `nmap $(cat targets.txt)` → `null` → refuse — which is the correct default for an arbitrary shell string. Two changes: add `'command'` to `TargetKind`, and call `hostsInCommand` in `PolicyEngine` before any shell adapter dispatches. `ECOSYSTEM.md` already names this as *"the prerequisite for letting the bot run CLI adapters at all."*

**L6 — Caps as first-class, reusing what exists.**
`DAILY_LLM_BUDGET` for tokens, `pace.js` for rate, plus a per-attempt tool-call ceiling borrowed from PentAGI's `MAX_GENERAL_AGENT_TOOL_CALLS` (100) and a per-run deadline. Strix's graduated 70/85/95% wrap-up warnings are a good, cheap UX pattern worth copying because they convert a hard stop into a graceful report.

**Why this is not just "add an LLM".** The distinguishing property: in this design the model can *never* increase the number of `proven` findings faster than the counterfactual machinery grows. It can only increase the number of *attempts* and *hypotheses*, which is precisely the axis where Asterion is currently blind.

---

## Gap table

| # | Gap | Architectural or additive | Leverage | Effort |
|---|---|---|---|---|
| 1 | **Harness ceiling** — 28 playbooks, 13 runnable; class must have hand-written code | **Architectural** (invert `playbook → template` into `spec → executor`) | **Highest.** This is the whole question. Nothing else expands what the bot can attempt. | High — 2–3 wks; touches `plane-run.mjs`, `plane-harness.js`, `planes.js`, `prove-web.yml` |
| 2 | **`hostsInCommand` unwired, `TargetKind` has no `command`** | **Additive** (contained, ~1 file + tests) | **Highest per unit effort.** Hard blocker for any shell executor; without it an open-ended bot is un-gateable. Already written and unit-tested. | Low — 1–2 days |
| 3 | **HTTP method pinned to GET; `mut` ignored** | **Additive** | High. Unlocks every `mutate`/`simulate` playbook already defined (race, upload, massassign) and every write-based bug class. | Low — <1 day |
| 4 | **Single credential, no multi-role session** | **Additive** (credential object on the brief + env) | High for web2. IDOR/authz — the classes with the most real-world payouts — are untestable without two sessions. | Medium — 3–5 days incl. secret-handling review |
| 5 | **Chain registry in two places** (`chains.js` + literal `FORK_RPC_<id>`) | **Additive** (one source generates both) | Medium-high. Directly answers "hunt on a different chain" — today it is a two-file ritual. | Low — 2 days |
| 6 | **Corpus is 100% web3 → priors inert for all 14 web2 classes** | **Additive** (ingest web2 findings; the schema already exists) | Medium. `rank()` currently gives web classes zero guidance, so playbook choice is arbitrary where coverage is worst. | Medium — corpus sourcing is the real cost |
| 7 | **One-shot attempt; no chaining or retained state** | **Architectural** (loop + `judge()` must understand attempt N+1) | Medium now, high later. XBOW's Deep mode shows chain-to-impact is where severity lives. | High — 2–3 wks |
| 8 | **Discovery is a fixed 2-path crawler** | **Additive** (already has a 50-subrequest planner) | Medium. Upload does no harm; leaves attack surface unmapped. | Low — 3 days |
| 9 | **Methodology reaches dispatch but cannot influence the PoC** | **Additive**, and unblocked only by #1 | Medium. 25 skill packs currently audit-trail rather than steer. | Low once #1 exists |
| 10 | **No benchmark; "does it work" is anecdote** | **Additive** (AutoPenBench-shaped harness over existing verdicts) | Medium-high **for trust**. You cannot tell if #1–#4 help without it. | Medium — 1 wk |

**Ordering implied by the table:** #2 → #3 → #1 → #4 → #10. #2 is a one-day precondition; #3 is a one-day win that unlocks three already-written playbooks; #1 is the real project and should not start until #2 lands, or the new executor ships un-gateable; #10 should land early enough to measure #1 rather than after it.

---

## Confidence

| Claim | Basis | Confidence |
|---|---|---|
| 28 playbooks / 13 dispatchable / web2 = 1 harness | executed `dispatchablePlaybookIds` against the built modules at `edb7781` | **verified** |
| `judge()` requires reproduced + causal + impact | read `proof.js` in full | **verified** |
| No LLM in the proof path; no agent loop anywhere | read `judge.mjs`, `plane-run.mjs`, `llm.js`; grepped `build/` + `src/` for tool-call primitives | **verified** |
| Metholodogy cannot alter PoC bytes | the module's own header, `methodology-dispatch.js` | **verified (self-documented)** |
| `TargetKind` has no `command`; `hostsInCommand` unwired | `policy.ts:26` + `ECOSYSTEM.md` §1 and §5 | **verified** |
| XBOW keeps non-AI validators per CWE and labels agent-validated classes as FP-prone | the published classification table, read in full | **verified as documented** |
| XBOW 85%/28min benchmark | vendor benchmark, vendor-commissioned challenges, 2024; XBOW's own editor's note calls the 2024 set outdated | **marketing — do not rely on** |
| Strix "PoCs, not false positives" | README claim; docs describe no validator, no counterfactual | **marketing — do not rely on** |
| PentAGI "2× result quality" | self-reported, single local model | **marketing-adjacent** |
| AutoPenBench 21% vs 64% | academic, 33 tasks, standardised milestones | **verified (independent)** |
| CAI 0.59× human on HTB machines | the authors' own table, i.e. against their interest | **verified (independent, self-critical)** |
| Nuclei has no counterfactual / no causal proof | template DSL is matcher-based; no re-run-after-fix construct exists in the docs | **inferred from docs, high confidence** |
| Burp MCP enforces scope at the tool boundary | PortSwigger docs: "configurable target approval system" | **verified as documented** |

## Limitations

- XBOW is closed source: its *architecture* is verified only as documented. Its internal validator implementations, agent orchestration code, and true FP rates were not observable.
- No tool was installed or run. Every performance figure is quoted, not reproduced. Cost and latency comparisons are derived from documented caps (`--max-turns 500`, `MAX_GENERAL_AGENT_TOOL_CALLS 100`, `DAILY_LLM_BUDGET 200000`) and are order-of-magnitude, not measured.
- Effort estimates in the gap table are engineering judgement, not measured.
- The survey omits commercial DAST agent products (Snyk, Invicti, Acunetix AI) and the OpenAI/Anthropic cyber-eval programmes; both were out of scope for the four named comparators.

## Suggested follow-up

1. **Before any build:** confirm #2 in a scratch branch — add `'command'` to `TargetKind`, call `hostsInCommand` from the gate, and prove it refuses `nmap $(cat t.txt)` while allowing `nmap 10.0.0.5`. That single test is the go/no-go for the whole hybrid.
2. Fetch `Hack-with-Github/Awesome-Hacking` → `Web3-Security` and `PayloadsAllTheThings` sub-lists as **skill-corpus seeds** for gap #6 (web2 priors), not as a structural fix.
3. Decide #4's credential model against the existing `PolicyEngine` secret story *before* #1, because a spec-taking executor that cannot authenticate is only useful for unauthenticated classes.
