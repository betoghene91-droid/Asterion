# Discovery limits — what is measured, what is assumed, what is unverified

Every number in this note was measured on **2026-10-30** against the live feeds
unless it appears in §7, which lists what this run could **not** measure and which
values were taken from the discovery research instead. Nothing here is estimated.

Raw inputs and the scripts that produced these numbers live in the workstream
evidence directory (`evidence/measurements.md`, `llama-protocols.json`,
`adapter-inventory.json`, `adapter-probe.json`, `aave-v3-adapter.js`,
`uniswap.json`, `base.json`).

---

## 1. `address` is frequently a token, not the pool

DeFiLlama `/protocols`, HTTP 200, 9,445,864 bytes:

| Fact | Value |
|---|---|
| protocols in the payload | **8,882** |
| carrying both `symbol` and `address` | **4,424** (49.8%) |
| protocols with `tvl > $10M` | **635** |
| of those, carrying both `symbol` and `address` | **336** (52.9%) |
| distinct addresses published *with* a symbol (token identities) | **3,608** |

Aave V3, field for field:

```
name=Aave V3   symbol=AAVE   tvl=$14,639,478,459   category=Lending
address=0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9
tvlCodePath=.../projects/aave-v3/index.js
```

`0x7fc6…` is the **AAVE token**. Verified:

* **seven** protocol entries publish that same address — `Aave V3`, `Aave V4`,
  `Aave Horizon RWA`, `Aave V2`, `Aave V1`, `Aave Aptos`, `Aave Arc`;
* the address does **not** appear anywhere in `projects/aave-v3/index.js`, which
  names 33 `0x…` addresses, none of them the token.

So the feed's `address` and the adapter's addresses are **disjoint sets** for the
largest lending protocol on the feed. Forking `address` forks a governance token,
finds no protocol logic, and reports fat TVL beside it.

**Consequence in code.** `targets/funding.ts` refuses the protocol's own `address`
as a fork target whenever the feed pairs it with a symbol
(`addressIsTokenIdentity`), *before* any adapter is read. `fork_target` is `null`
in that case, and `null` — not a fallback to `address` — is what a consumer must
branch on. This is pinned by the Aave-V3-shaped fixture in
`tests/targets-funding.test.mjs`.

**Honest note on the two percentages.** The brief's figure is 761/1,166 (65%) of
protocols whose `address` is a token; my slice measures 4,424/8,882 (49.8%) over
all protocols and **336/635 (52.9%)** above $10M TVL. These are different
slices of a moving feed. Both are order-of-magnitude. The direction is what
matters and it is confirmed.

---

## 2. Adapter cost — request count, not bytes, is the binding limit

| Fact | Value |
|---|---|
| protocols with `tvlCodePath` | **7,340 of 8,882** |
| protocols with `tvl > $10M` **and** `tvlCodePath` | **635** |
| **distinct adapters** covering those 635 | **438** |
| fetched successfully | **437 / 438** |

Adapters are heavily shared, which is the whole optimisation:

| adapter | protocols served |
|---|---|
| `registries/sumTokens.js` | 75 |
| `.registries/cex/index.js` | 41 |
| `registries/curators.js` | 22 |
| `registries/solanaStakePool.js` | 18 |
| `registries/bitcoin.js` | 11 |
| `registries/uniswapV3.js` | 11 |

Sizes across the 437 fetched adapters:

| metric | bytes |
|---|---|
| total | **3,674,148** |
| mean | **8,408** |
| median | **2,036** |
| p90 | **9,675** |
| **max** | **1,498,048** (`registries/sumTokens.js`) |

Per-protocol naive fetching would cost **117,878,241 B** and 635 requests; deduping
by code path costs **3,674,148 B** and **438** requests — 32× fewer bytes, 1.45×
fewer requests.

**The brief's "~3 KB per protocol" is right for the median and wrong for the tail.**
One adapter is 1.5 MB and names 6,718 addresses. So batching by a byte budget would
be the wrong design here: six 1.5 MB adapters are six requests. `targets/queue.ts`
budgets by **request count** (`SUBREQUEST_CEILING = 50`), which is the platform
constraint, and it plans the split with `planTick`.

**`~1,200 fetches for >$10M TVL` in the brief is 635 protocols; the fetch count is
438** because of the sharing above. Both numbers are useful — 635 is the work item
count, 438 is the request count.

---

## 3. How much the token filter actually removes

28-adapter random sample (seed 7, `adapter-probe.json`):

* **21,637** addresses extracted
* **462** also token identities — **2.1%**
* **3 / 28** protocols left with **zero** surviving addresses

So the adapter-side filter is cheap and removes little. **It is not what fixes
Aave.** What fixes Aave is §1: refusing the feed's own `address` when it is a
token. Saying "the filter fixes it" would be the wrong lesson from the
measurement.

Adapter yield, across all 437 unique adapters: **16,011** `0x…` addresses, median
**5** per non-empty adapter, and **145 of 437** adapters name **zero** addresses —
they compose other adapters or reference registry keys. Those 145 are recorded as
`state='fetched'` with `addresses_n = 0`, never as a failure, so the retry loop
does not re-fetch them forever.

---

## 4. Ranking: expected value, and the one placeholder in it

```
EV = payout_cap × automation_allowed × coverage_gap × Σ(class_weight)
     ÷ expected_time_to_proof
```

| term | source | status |
|---|---|---|
| `payout_cap` | programme's published per-finding cap | measured when published; `null` on Cantina and Sherlock, which publish a prize **pool** and not a cap |
| `automation_allowed` | `targets/scope.ts` classifier | boolean; `false` for every value except an affirmative, uncontradicted permission |
| `coverage_gap` | `has_programme` | `1` uncovered / `0.25` covered — a stated ratio choice, not a measurement |
| `Σ(class_weight)` | shipped corpus digest `classes[*].weight` | measured, with `n: 0, weight: 0.0, validatable: false` as the honest zero for unmeasured classes |
| `expected_time_to_proof` | **`TIME_TO_PROOF_PLACEHOLDER_HOURS = 8`** | **PLACEHOLDER — NOT MEASURED** |

**The placeholder is safe only because it is a constant.** It divides every score
by the same number, so it cannot change the order of the ranking — only the scale.
A test asserts `TIME_TO_PROOF_IS_PLACEHOLDER === true` so that when real
time-to-proof data exists, deleting the constant fails a test rather than silently
pretending the number was measured. It becomes measurable from the `proofs` table
(`started_at → finished_at` on `proven` rows); it is not measurable today.

`coverage_gap`'s two constants (`1` and `0.25`) are similarly a **ratio choice, not
a measurement**: "four crowded programmes are worth one uncovered protocol of the
same economics". They are exported named constants with that sentence attached.

---

## 5. The automation gate

Four facts are encoded, per the discovery research:

1. some programmes ship `prohibitedActivites: null` — present and empty;
2. some bar scanners outright;
3. some make **unattended output ineligible** without barring the tool (one states
   an unverified finding does not meet eligibility and the fee is not refunded);
4. some permit tools only with prior written consent, which we do not hold.

The rule: **prohibition beats permission, and silence is not consent.**
`classifyProhibitedActivities` returns `allowed` only on an affirmative permission
sentence that no prohibition sentence in the same text contradicts.

Reason codes are distinct because the operator action differs:

| `cls` | `reason` | operator action |
|---|---|---|
| `prohibited` | `scanners-barred` | do not run tools at all |
| `prohibited` | `unattended-ineligible` | tools may run; unattended output may not be submitted |
| `prohibited` | `consent-required` | obtain and record written consent |
| `unknown` | `field-null` | the programme's machine-readable answer was empty — ask them |
| `unknown` | `field-absent` | no field published — ask them |
| `not_mentioned` | `terms-silent` | terms exist and never mention tools — silence, not consent |
| `not_mentioned` | `contradicted` | the text negates a prohibition, which is not a grant |
| `allowed` | `affirmative` | the only value that permits dispatch |

`refuseDispatch` gates on this and **names the programme and quotes the sentence**
the verdict rests on. A refusal that says only "denied" is indistinguishable from a
bug.

---

## 6. The security.txt widening (2 requests per host, unchanged)

Hosts per programme are now the apex **and** `www`, and the apex is asked first.
The per-host request count is unchanged at two
(`/.well-known/security.txt`, `/security.txt`) and is asserted by a test.

The budget is now **planned** rather than fixed, because the adapter crawl shares
the same hourly tick (cron slots are at the free-plan ceiling of five with zero
headroom, so no new slot was added). `planTick` reserves adapter fetches first and
derives how many programmes still fit, using the **worst case** of
`hosts × paths + 1 policy fetch` per programme — a budget validated on the best
case is not a budget. `assertBudget` throws on any over-spend.

---

## 7. NOT MEASURED — read this before trusting any count

These are the numbers this run could **not** verify. They are quoted from the
discovery research, and every one of them should be treated as
**order-of-magnitude**:

* **~151 code-huntable protocols / $50.8 B TVL with no programme match.** The join
  was verified at 9/10 on a sample. `has_programme` is implemented as a first-class
  field, but **this run produced no count of its own** — the field is real, the
  number is not re-derived here.
* **8,753 current `security.txt` crawl size** — not re-counted.
* **87% of public programmes off-platform** — not re-measured.
* **5 × `prohibitedActivites: null`, 5 × scanners barred, 8 × unattended
  ineligible** — **no live payload carrying this field could be fetched**, so the
  classifier is tested over synthetic text samples written to the shape of real
  prohibited-activities prose. They are **not quoted from real programmes**, and
  the test file says so. Any count of *how many* programmes fall in each bucket is
  therefore unmeasured by this run.
* **Steakhouse $2.69 B / Sentora $2.64 B / Gauntlet $1.62 B** curator TVL — not
  re-measured. The Risk Curator class definition is methodology only.

### Platform scope endpoints — measured reachability from this network

| platform | endpoint tried | result |
|---|---|---|
| Cantina | `cantina.xyz/api/v0/competitions?limit=3` | **200**, 771,327 B, 145 competitions |
| Sherlock | `audits.sherlock.xyz/api/contests?limit=2` | **200**, 7,609 B |
| Immunefi | `/public-api/projects/`, `/api/v1/projects/`, `/api/projects`, `/graphql` | 404 / 308 redirect loop |
| HackenProof | `/api/v2/programs`, `/api/v1/programs`, `/api/programs` | 404 |

**Cantina and Sherlock parsers are written against payloads that were actually
fetched.** The **Immunefi and HackenProof parsers are UNVERIFIED** — written
against the documented shape, tolerant on purpose (array or
`{projects|data|items|results: []}`), and explicitly marked as such in the source.
A strict parser against an unverified shape would report "0 programmes", which
reads exactly like "the platform lists nothing".

---

## 8. Risk Curator — a class with no prover, refused by name

The class is defined in `targets/curator.ts`. It has **no playbook**, deliberately.

A curator's failure mode is **misallocation against a disclosed mandate** — a
portfolio outcome over weeks, not a state transition in one transaction. The
counterfactual prover (`proven` = reproduced ∧ causal ∧ measured) has nothing to
flip, because the claim is about a distribution. Three methodology hooks are
declared and **all three are unavailable today**:

| hook | yields | missing |
|---|---|---|
| `mandate.structured` | per-curator policy as data | no ingester for curator disclosure pages |
| `positions.timeline` | per-block positions across venues | no vault share-price / allocation history source |
| `counterfactual.distribution` | mandate-implied vs actual return | `judge.mjs` compares a state transition, not an accounting model |

Shipping a hollow playbook would be **worse than nothing**: a playbook is the only
route to an Authorize button, so a stub would let a curator brief dispatch a
Foundry job at a vault address, run for minutes, and return `inconclusive` —
the exact dead-dispatch failure the svm packs caused, while looking legitimate.

So `refuseCuratorDispatch()` refuses **by name** and lists the missing hooks.
`curatorClassIsDispatchable()` is derived from the hooks (`every`, not `some`), so
filling one does not leave a stale `false` behind.

---

## 9. Known wire-ins this change does NOT make

Both are one-line changes in files owned by other work in this batch, so editing
them here would collide. Neither is a silent gap: each is refused at runtime by
code in this module.

1. **`dispatch.ts` → `refuseDispatch`.** Call it before `authorizeProof()`. Until
   then, the automation gate exists and is tested but is not on the dispatch path.
   `automation_allowed` is stored on the candidate and enforced by
   `rankedForDispatch`, so an automation-prohibited programme cannot be ranked as
   a dispatch candidate in the meantime.
2. **`index.ts` → `discoveryTick`.** The existing hourly cron calls `crawlTick`.
   `discoveryTick` composes the adapter drain with it under one planned budget.
   Until then the queue is populated by `enqueueFundProtocols` and drained only
   when something calls `discoveryTick`, so `fund_addresses` stays `pending`.
   **No cron slot was added** — `wrangler.toml` is out of scope and the five slots
   have zero headroom.

A third, smaller one: `RISK_CURATOR_PROPOSED_CLS = 'curator'` must not be added to
`Cls` from this module — widening the union changes `intake.ts`'s `CLASS_WORDS`,
which is a parallel edit. Until then a curator brief arrives as `solidity` and is
caught by `refuseCuratorDispatch` before derivation.
