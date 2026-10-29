# What we took from the ecosystem, and what we refused

Research date 2026-10-28. Stars, licences and push dates read from the GitHub
REST API that day. Scope claims verified by reading source, not READMEs.

This file exists because "we use the best open source" is a claim, and claims
need receipts. Every adoption below names the file, the licence and the reason.

---

## The five things we actually adopted

| # | Taken from | Licence | What it is | Where it landed |
|---|---|---|---|---|
| 1 | **PentestGPT** `_canonical_url_target` | MIT | URL canonicaliser that closes userinfo, double-encoding, traversal and scheme-downgrade bypasses | `app/src/policy.ts` → `canonicalUrl`, `urlContained`, `hostCovered` |
| 2 | **PentestGPT** immutable bounded allowlist | MIT | ≤N targets, unique, length-capped, fixed at run creation | Our RoE model already did this; tightened matching |
| 3 | **PentestAgent** dispatch-time gate shape | MIT | Refuse at tool dispatch, not in the prompt | `PolicyEngine` denial path (refuses at dispatch). `hostsInCommand` is written and unit-tested but **not called by the gate** — `TargetKind` has no `command` member, so no shell payload ever reaches it |
| 4 | **bounty-targets-data** scope schema | MIT | `in_scope[].asset_type` / `eligible_for_bounty` / `max_severity` | `app/eval/ingest-programs.py` |
| 5 | **Strix** required-field report gate | Apache-2.0 | A report cannot be emitted with blank evidence | `v2/src/proof.ts` → three hard conditions |

---

## 1. The URL canonicaliser — the one that mattered

**Before:** our gate matched URLs with `raw.startsWith(allowed)`.

That is bypassable four ways, all verified:

| Bypass | What happens |
|---|---|
| `https://example.com@evil.test/` | naive prefix sees `example.com`, browser resolves to `evil.test` |
| `https://example.com/%2e%2e%2fadmin` | decodes to `/../admin` |
| `https://example.com/%252e%252e%252f` | double-encoded, survives one decode |
| `http://example.com/api` | scheme downgrade under a prefix check |

**After:** `canonicalUrl` returns `null` for anything it cannot parse with
certainty, and `urlContained` requires **exact origin** (scheme + host + port)
**and** path-segment prefix. Fifteen tests pin it:

```
rejects userinfo confusion          rejects encoded traversal (single + double)
rejects any fragment                rejects gopher:// file:// dict://
rejects whitespace edges            rejects backslashes
scheme downgrade != same origin     port change != same origin
/api does not contain /admin        /api/v1 does not contain /api/v2
example.com does not cover notexample.com
```

**The one thing PentestGPT does not solve, and we did:** its allowlist constrains
the *declared task target*. A shell command is not a declared target. So we added
`hostsInCommand`, which extracts every host a command string would touch and
returns `null` — meaning refuse — when it cannot be resolved statically:

```
nmap 10.0.0.5                  -> ['10.0.0.5']
nmap $(cat targets.txt)        -> null   (refuse)
nmap `cat t.txt`               -> null   (refuse)
nmap 10.0.0.5 | tee out        -> null   (refuse)
curl a.com && curl evil.test   -> null   (refuse)
```

That gap was found in *every* agent surveyed. **We wrote the primitive and it is
unit-tested, but it is not yet wired into the gate** — `TargetKind` has no
`command` member, so no shell string currently reaches `hostsInCommand`. Calling
it is the prerequisite for letting the bot run CLI adapters at all. Until then
the gate is safe *because it never accepts a shell command*, not because it
parses one.

---

## 2. What we deliberately refused

Refusals matter more than adoptions, because each one is a liability avoided.

| Project | Stars | Licence | Why refused |
|---|---|---|---|
| `aliasrobotics/cai` | 9,843 | **MIT + research-only** | The MIT applies only to vendored `openai-agents-python`. Everything Alias authored says *"Commercial, professional, or production use of these components is strictly prohibited."* Also **archived**. Its "guardrails" are prompt-injection regexes, not authorization. |
| `usestrix/strix` | 72,565 | Apache-2.0 | **No scope enforcement at all.** `--target` accepts anything. `--scope-mode` limits a code review to a PR diff, which sounds similar and is unrelated. We took its report gate and nothing else. |
| `H-mmer/pentest-agents` | 1,043 | **NONE** | No licence = all rights reserved. Cannot legally use. |
| `chainreactors/cyber-harness` | 351 | AGPL-3.0 | Fine internally; a hosted build inherits source-disclosure. |
| `ItsIgnacioPortal/Hacker-Scoper` | 79 | AGPL-3.0 | Same. |
| `GH05TCREW/pentestagent` | 3,220 | MIT | Gate is real but **verified bypassable**: a `command` string returns no targets, so the gate passes it. Also fails closed on *in-scope* URLs, which makes operators disable it. We took the hook shape, replaced the matcher. |
| `westonbrown/Cyber-AutoAgent` | 550 | MIT | Stale 11 months. "81% XBOW" is author-reported on LinkedIn, never reproduced. |
| `KHenryAegis/VulnBot` | 203 | MIT | Paper artifact, thin. |

**The most important refusal is Strix**, because it is the most popular and the
most cited. 72,565 stars with zero authorization control is exactly the trap:
popularity is not safety.

---

## 3. Tools we invoke but never vendor

These run as external binaries over JSON. Aggregation, not derivation — the
distinction that keeps copyleft licences from reaching our code.

| Tool | Licence | Contract | Role |
|---|---|---|---|
| **Slither** | AGPL-3.0 | `--json out.json` | broad detector coverage |
| **Aderyn** | GPL-3.0 | `--output out.json` | Rust, fast, different detector set |
| **Solhint** | MIT | `-f json` | lint; errors only |
| **Foundry** | Apache-2.0 | `forge test --json` | **the proof engine** |
| **Echidna** | AGPL-3.0 | CLI | property fuzzing (v3) |

`scripts/normalize.py` merges all of them into one lead set and records
**corroboration** — when two independent tools flag the same class in the same
file, that is the strongest signal available before a proof. Self-tested in CI:

```
ok  three distinct leads
ok  slither reentrancy mapped
ok  aderyn initializer mapped
ok  unknown detector preserved, not dropped
ok  slither+detect corroboration recorded
ok  hit count incremented
```

Note the fourth line. An unmapped detector is **kept and labelled**, not dropped.
Silently discarding a tool's finding because we had no mapping for it would be
the same class of error as reporting a false positive.

---

## 4. Considered and rejected on merit, not licence

### `paradigmxyz/evmbench` (Apache-2.0, 467★)

A real benchmark harness for finding and exploiting smart-contract bugs, backed
by OpenAI's `frontier-evals`. Tempting. Rejected because it needs PostgreSQL,
RabbitMQ, Docker and a Kubernetes-or-Docker worker backend to answer a question
we can answer with `forge test` and an exit code. Its **output contract** is
good though, and that we did borrow: a report is `{"vulnerabilities": [...]}`
with file navigation, which is exactly the shape our `verdicts.json` uses.

### `sw33tLie/bbscope` (Apache-2.0, 1,450★)

Advertises Immunefi support. Verified: `pkg/platforms/immunefi/immunefi.go` is
**22 lines** and contains only a category map. No fetch logic. Immunefi support
is nominal. Since Immunefi is the single most relevant platform for a web3
researcher, this was the most disappointing finding in the survey.

### `root4loot/rescope` (MIT, 331★)

Cleanest per-platform structure of the scope fetchers, but no Immunefi and last
pushed 2025-03. We used `bounty-targets-data` instead, which is data not code
and therefore has no integration surface to maintain.

### Dual-agent debate / LLM-as-judge

Rejected outright. Two models sharing context converge; the failure mode is
correlated error and it is unauditable. The research was blunt about this and
it matches our design: **the gate must be a data-model property, not a
reasoning property.** A report row must physically be unable to reference a
non-existent proof. That is what `proof.ts` enforces.

---

## 5. What nobody has, so we built it

The survey's most useful output was a list of absences. Four of these are now
ours:

| Absence | Status here |
|---|---|
| A scope gate that survives a raw shell command | **partially**: `hostsInCommand` returns `null` → refuse, and is unit-tested, but nothing in the gate calls it yet. The gate currently authorises structured `Action` targets (`host`/`domain`/`cidr`/`url`/`chain_address`/`repo`), not shell strings |
| Policy *prose* → executable constraints | `classifyAutomation` in `discovery.ts` (prohibited / not_mentioned / allowed) |
| The verifier as an independent authority | `proof.ts` judge; the agent cannot mint `proven` |
| Dedup within a programme | `UNIQUE(program_id, dedupe_key)` on findings — **per programme only**. Cross-programme dedup against the 180k corpus is NOT built: the digest powers retrieval and priors, not dedup |
| Immunefi scope ingestion | still open — no tool has it |
| Scope-*narrowing* alerts (a host left scope) | still open — this is the real legal risk in continuous hunting |

Those last two are honest gaps, not oversights.

---

## 6. The dependency ledger

Everything the deployed Worker depends on, and its licence:

| Dependency | Licence | Commercial redistribution |
|---|---|---|
| Cloudflare Workers runtime | proprietary, free tier | yes |
| `wrangler` | MIT/Apache-2.0 | yes |
| `typescript` | Apache-2.0 | yes |
| `@cloudflare/workers-types` | Apache-2.0 | yes |
| **Our code** | proprietary | ours |

That is the whole list. The Worker has **no runtime npm dependencies** — every
import is either a Web API or our own file. Nothing copyleft is linked, and
nothing copyleft is vendored. The AGPL/GPL tools exist only in CI, as separate
processes exchanging JSON.

If you ever sell this, that table is the answer to the first legal question.

---

## 7. Confidence

| Claim | Basis |
|---|---|
| PentestAgent bypasses exist | **executed** the library, four probes |
| PentestGPT canonicaliser is correct | read `plan.py:91-146`, ported it, 15 tests |
| Strix has no scope enforcement | grepped `strix/**/*.py`; only CVSS `S:` and PR-diff scope |
| CAI licence is research-only | read `LICENSE` verbatim |
| bbscope Immunefi is a stub | read the 22-line file |
| bounty-targets-data schema | parsed 449 programmes, 43,107 assets |
| Star/licence/push dates | GitHub REST API, 2026-10-28 |

Not verified: any benchmark percentage from any project. XBOW's own 2024
benchmarks now carry an editor's note that they are *"outdated and should no
longer be used to measure offensive performance."* Treat every headline number
in this space as marketing until you re-run it.

---

## 8. The AGPL constraint — the biggest architectural fact in this survey

Slither is **AGPL-3.0**. So is Echidna, Medusa, Halmos, Slitherin and GPTScan.
This is not a footnote; it decides how you may ever ship this.

AGPL's network clause: if you offer the tool *as a network service*, you must
offer the corresponding source of the whole combined work. Slither is the most
valuable static analyzer available and it is the one with the sharpest licence.
Trail of Bits sells commercial exceptions (`opensource@trailofbits.com`).

### What we do about it

```
┌─────────────────────────────┐      ┌──────────────────────────┐
│  Asterion (proprietary)     │      │  slither (AGPL)          │
│  Worker + V2 proof engine   │─────▶│  separate process        │
│                             │ JSON │  separate container      │
└─────────────────────────────┘      └──────────────────────────┘
         aggregation                     independent program
```

The boundary is deliberate and is enforced in three ways:

1. **Separate process.** `slither` is invoked by subprocess in CI. We pipe JSON.
   No `import slither`, no linked library, no vendored source.
2. **No vendoring.** `.gitignore` excludes tool outputs. Nothing AGPL is in the
   repository.
3. **No network exposure of the tool.** The Worker never runs Slither. Only a
   GitHub Actions runner does, and the artifact is JSON.

If you ever host this for others, you have three legitimate options and no
fourth: replace Slither with a permissive analyzer, keep it behind the process
boundary as a separate program, or buy the commercial licence. Do not guess —
this is the one thing in the project that genuinely needs a lawyer if the
product commercialises.

### Licence map, complete

| Category | Tools | Ship? |
|---|---|---|
| **Permissive** | Foundry (Apache-2.0), Solhint (MIT), Mythril (MIT), Wake (**ISC**), evmbench (Apache-2.0), krait (MIT), pashov/skills (MIT) | embed freely |
| **Weak copyleft** | Aderyn (GPL-3.0), Certora (GPL-3.0) | separate process |
| **Strong copyleft** | Slither, Echidna, Medusa, Halmos, GPTScan (all AGPL-3.0) | separate process only |
| **Non-commercial** | `Decurity/semgrep-smart-contracts` (**CC BY-NC-SA**), `semgrep/semgrep-rules` (non-OSI) | **do not ship** |
| **No licence** | `Archethect/sc-auditor`, `PropertyGPT`, `ASSERT-KTH/Proof-of-Patch` | read, never copy |
| **Supply-chain risk** | `jw3b-dev/AI-Smart-Contract-Auditor` — PyPI-only, **GitHub repo 404**, `contact@example.com`, 31 downloads/mo | **do not install** |

That last row matters. An "AI auditor" that ships only an sdist with no
source repo, a placeholder contact, and 31 downloads is not a tool, it is an
attack surface. It is exactly the shape of a supply-chain compromise.

---

## 9. Verified CLI contracts

Read from source or `--help`, not from blog posts. Getting these wrong is why
CI pipelines silently produce zero findings:

| Tool | Correct invocation | Gotcha |
|---|---|---|
| Slither | `--json-types detectors --json f.json --sarif f.sarif --fail-on none` | `--fail-on none` or the step fails on findings |
| Aderyn | `-o report.json --src src/` | **format is chosen by file extension** — the filename must end `.json` |
| Solhint | `-f json` | `-f sarif` also works |
| Foundry | `forge test --json-file out.json` | exit code is the oracle |
| Echidna | `--format json` → `tests[].transactions[]` | the tx sequence is a replayable PoC seed |

I had Aderyn's flag wrong at first (`--output`). The research read
`aderyn/src/main.rs` and corrected it. That is the difference between a
guessed integration and a working one.

---

## 10. The gap nobody fills

Searched, and confirmed by reading the repos:

| Attempt | Why it does not help |
|---|---|
| **PoCo** (KTH/ASSERT, TOSEM 2026) | implementation *withheld, available on request* |
| **SmartPoC** (Tsinghua 2026) | paper only, no repo found |
| **PoCGen** (2025) | Zenodo artifact, narrow, static-pattern-driven |
| **sc-auditor** `generate_poc` | works, but **no licence** = cannot legally use |
| **pashov `fizz`** | generates Echidna/Medusa property suites — different goal (fuzzing, not targeted exploit proof) |

So: **`finding → Foundry test → run → did-it-actually-exploit` has no open,
licensed implementation anywhere.** The primitives exist (`forge test --json`,
Echidna's `transactions[]`). The composition does not.

That composition is `v2/`. It is the only genuinely novel code in this project,
and it is why the project is not a wrapper around anything.
