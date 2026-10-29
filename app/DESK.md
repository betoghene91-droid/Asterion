# DESK — the Solana paper-trading subsystem

Implementation notes for `src/desk/`. This records **what is enforced in code**,
**what paper mode actually models**, and **what is missing**. Where something is
unverified, it says so.

Written against the tree as built. All numbers below are the constants in
`src/desk/types.ts`; if they ever disagree with this file, the code is right and
this file is stale.

---

## 1. The one thing to know before reading anything else

**With the shipped free data sources, the desk will never open a position.**

That is not a bug and it is not a placeholder. The filter's flow gates
(unique-buyer ratio, bundled launch, sniper cohort, deployer cluster) need
trade-level indexing that DexScreener's free tier and RugCheck's public report do
not provide. The desk refuses to *invent* those numbers, so it records a
**coverage gap** and opens nothing.

Consequences, stated plainly:

- If you deploy this as-is, `/desk` will show `coverage_gaps` rising and
  `open_positions` at 0 forever.
- The live-arming gate "≥200 paper trades" is therefore **unreachable** until a
  `FlowProvider` is wired (see §8). That is intentional: the gate exists to
  demand evidence, and there is no evidence yet.
- The alternative — scoring a missing wash-trade ratio as a healthy 0.5 — would
  let a wash-traded launch through and make the paper record worse than useless.
  Failing closed was chosen deliberately.

One live sweep against the real APIs on 2026-10-29, for sanity:

```
--- desk_subrequests quota: [{"day":"2026-10-29","bucket":"desk_subrequests","used":24,"cap":4000}]
--- heartbeats: [{"source":"cron","ts":1793258716,"note":null}]
--- desk_universe rows: 22
--- desk_scores rows: 0
--- desk_kills rows: 22
reason breakdown: mcap_out_of_band 20, age_out_of_band 2
sample: SELLICON | mcap_out_of_band | mcap $102.5k outside $300k-$20M
```

Those 22 kills are correct: the token-profiles feed is mostly sub-$300k launches,
so Scout throws them out before any RPC is spent. The plumbing is proven
end-to-end against live data; the *flow* gates are what block entry.

---

## 2. Agents, in pipeline order

`pipeline.ts` composes all six. Each is testable alone.

### Scout (`scout.ts`)

| Gate | Rule |
|---|---|
| age | 30 min ≤ pair age ≤ 72 h, from the pair's own `pairCreatedAt`, not our first sighting |
| market cap | $300k ≤ mcap ≤ $20M |
| holders | ≥ 300 |
| **liquidity** | `liq ≥ max($40k, 3% of mcap)` |

The liquidity gate is a **ratio**, deliberately. A flat $40k floor is a real
filter on a $300k token and meaningless on a $20M one: 0.2% of mcap in the pool
means the first meaningful sell moves the price and the position can never exit.
Test: `desk: liquidity is gated as a ratio, so a $40k pool fails a $20M token`.

### Filter (`filter.ts`) — kills

Evaluated in a **fixed order** (`REASON_ORDER`) so the recorded primary reason is
identical on every run. That determinism is what makes the weekly calibration
comparable across weeks.

| # | Reason code | Rule |
|---|---|---|
| 1 | `freeze_authority_live` | freeze authority not revoked → **kill** |
| 2 | `mint_authority_live` | mint authority not revoked → kill |
| 3 | `token2022_dangerous_extension` | transfer hook, permanent delegate, non-transferable, or transfer fee > 5% |
| 4 | `metadata_mutable_upgradeable` | metadata mutable **AND** program upgradeable |
| 5 | `honeypot_sell_reverts` / `honeypot_impact_exceeded` | simulated exit of the proposed size reverts, or costs > 15% impact |
| 6 | `lp_unlocked` | LP not burned, or locked < 30 more days |
| 7 | `liq_below_ratio_gate` | below the ratio gate above |
| 8 | `volume_1h_low` | 1h volume < $50k |
| 9 | `top10_concentrated` | top-10 > 25% **after** excluding pool, burn, known CEX |
| 10 | `dev_prior_rug` / `dev_holding` | deployer has a rug in its history, or holds > 3% |
| 11 | `bundled_launch` | same-slot / same-funder buys > 10% of supply |
| 12 | `sniper_concentration` | first-20-buyer cohort > 30% of supply |
| 13 | `wash_trading` | unique buyers ÷ total buys < 0.35 |
| 14 | `dev_cluster` | deployer-funded wallets > 15% |
| 15 | `late_entry` | price > 3.5× the 24h low **or** > 1.8× the 6h low |

**Freeze authority is first on purpose.** A live freeze authority lets the
deployer block every external seller while keeping its own transfers open: the
token quotes fine, looks liquid, and nobody can leave. That is the honeypot, and
it is a different and more dangerous thing than a live mint authority.

**The `late_entry` gate replaces a flat "+80% in 1h" rule.** A token up 80% is
usually also above 1.8× its 6h low, so the old rule was one arm of this. Expressed
as multiples of recent lows it measures the same chase while not killing a token
that rose on a genuinely higher low.

#### Kill vs coverage gap

Two kinds of "we do not know", handled deliberately differently:

- **Safety facts** — authorities, extensions, LP lock, sell simulation. These are
  cheap and always available from a free contract report, so failing to read one
  is itself a signal: **unknown is a kill** (`safety_data_unknown`).
- **Flow facts** — unique buyers, bundles, sniper cohort, deployer cluster. These
  need trade indexing the free tier lacks. Unknown here is **not** a kill; it is a
  coverage gap. The token is not judged and no position opens.

A token we could not judge is not a token we judged bad, and the calibration
report must never count a coverage gap as a dodge.

### Analyst (`analyst.ts`) — 0–100

Weights: momentum/acceleration 20, unique-buyer growth 15, buy/sell ratio **and**
buy-size skew 15, holder growth 10, liq/mcap quality 15, curated smart-wallet
presence 15, residual contract safety 10. Sum 100.

**Pass rule is a conjunction:** `total ≥ 70` **AND** no component below its
floor. Floors (on the same 0–100 scale): momentum 35, uniqueBuyers 30,
buyPressure 35, holderGrowth 30, liqQuality 40, smartWallets 30, residualSafety 50.

Why floors: a plain weighted sum is gamed by one extreme metric. A token with a
spectacular 1h pump and nothing else can clear 70 on momentum plus two free
components and get bought. The floors force seven acceptable answers. There is a
test (`desk: a 70 assembled from one hero metric still fails`) that asserts the
total **clears 70 on its own** and is still refused — without the floors it would
pass.

`liqQuality: 40` is not arbitrary: it is exactly the score a pool at 3% of market
cap earns, i.e. Scout's own liquidity minimum, so the two layers agree instead of
contradicting each other. Liquidity quality is also **depth-capped**: turnover may
confirm depth but may never substitute for it, or a $40k pool with $1.4M of hourly
churn scores as "quality liquidity" on the strength of the churn that makes it
untradeable.

**The LLM boundary is structural, not conventional.** `writeThesis()` in
`thesis.ts` returns `string`. It has no return type that can carry a score or a
size, so even a fully compromised model response cannot move
`desk_scores.total` or `desk_positions.size_usd`. A failed, empty or over-long
model response falls back to the deterministic thesis and is recorded as
`llm_failed` — the desk never has a position with no recorded "why".

### Executor (`executor.ts`)

| Ceiling | Value | Binding |
|---|---|---|
| position size | ≤ 8% of **realized cash** equity | not mark-to-market |
| concurrent positions | ≤ 3 | memecoins are ~1.0 correlated |
| deployed | ≤ 24% of realized equity | |
| pool share | position ≤ 1% of pool liquidity | hard refusal |
| entry | split 50% now, 50% on confirmation | |
| slippage | entry ≤ 200 bps, exit ≤ 500 bps | |
| priority fee | per-trade cap | |

Realized cash, not mark-to-market, on purpose: marking to market inflates
position size exactly when the book is hot, which is the moment the next position
is most expensive and a drawdown most likely.

Every ceiling is a **refusal with a named code**, never a silent clamp. Clamping
would shrink a position to fit the limit and report success, so the operator never
learns the book was full.

Sizing takes the **minimum** of the three caps and names which one bound.

### Risk (`risk.ts`)

Order in `assess()` is a safety ordering:

1. `liq_decay` — liquidity down > 25% from entry → exit **immediately, regardless
   of PnL**. Checked before PnL because it is a rug precursor; waiting for the stop
   means waiting for the price to gap through it.
2. `dev_sell` — deployer sold → exit immediately, regardless of PnL.
3. `stop_hard` — `max(−6%, −1.5 × ATR14)` as a price. The ATR leg is why −6% is a
   floor and not the rule: on a 6%-ATR token a flat −6% stop sits inside the noise
   and exits winners early.
4. `trail_stop` — arms at +12%, trails 12% below peak, tightens to 6% after +40%.
   Keyed off **peak** gain, so a position that touched +40% keeps the tight trail
   after pulling back; keying off current gain would loosen the trail on the way
   down.
5. `time_stop` — no +15% within 4 h → exit. Thesis decay.

Never average down is enforced structurally: `openPosition` refuses a second open
position on a mint already held (`never_average_down`), not by a flag a caller
could pass wrong.

### Logger + calibration (`logger.ts`)

Every kill and fill carries a reason code and a snapshot. The weekly report in
`desk_calibration` answers the question a journal never asks — per reason code,
how many kills later 3×'d (false negatives) and how many went to −90% (true
positives). Rows with fewer than `MIN_SAMPLE` (5) measured kills print no rate.

**Kill reasons are the model.** A desk that logs but never calibrates is a diary.

---

## 3. Paper mode: what is modelled, and what is not

Modelled, from real pool state:

- **Price impact** — one-sided constant-product from the pool's own depth:
  `impact = size / (liq/2 + size)`. Uses the token's liquidity, so the number
  tracks the token rather than the strategy.
- **LP fee** — charged on the notional, both sides.
- **Priority fee** — the configured per-trade fee, capped.
- **Execution price** — buys fill **above** the quote, sells **below**.
- **Every cost line stored separately** (`lp_fee_usd`, `prio_fee_usd`,
  `slippage_usd`, `price_impact`), so calibration can say which cost is eating the
  edge instead of lumping them into one "fees" number that hides the answer.

**Refusals, not warnings:** if the size is > 1% of pool liquidity, or modelled
slippage exceeds the entry/exit cap, or the priority fee exceeds its cap, the fill
is refused and no position opens. A paper fill at a price that could never have
executed is worse than no backtest.

### NOT modelled — read this before trusting any paper number

- **MEV / sandwich cost on our own order.** Paper mode assumes no one trades
  against us. A real order in a thin pool can be sandwiched, so paper results are
  **optimistic** for exactly the tokens most worth sandwiching.
- **Failed transactions and retries.** Paper fills either fill or refuse; on-chain
  a swap can fail on slippage or blockhash expiry, and the retry costs fees.
- **Intra-quote price movement.** We fill at the quoted price plus impact, not at
  a stream of ticks.
- **The bonding-curve phase** of a pump.fun token: the model treats every pair as
  a constant-product AMM.
- **Borrow/rent, account close, priority-fee auctions.** Not represented.
- **Jito bundles / landing probability.** Not represented at all.

---

## 4. Live arming

Mode is `paper` unless **every** gate below passes. `armState()` returns the full
list with each gate's requirement and actual value, and `/desk` prints them.

| Gate | Requirement |
|---|---|
| `paper_trades` | ≥ 200 closed paper trades |
| `paper_days` | ≥ 30 days of paper history |
| `expectancy_after_fees` | positive USD expectancy per trade, after modelled fees |
| `max_drawdown` | < 15% realized max drawdown |
| `desk_live_secret` | `DESK_LIVE=1`, set via `wrangler secret put` |
| `capital_cap` | `DESK_CAPITAL_CAP_USD` > 0 |
| `signer_isolation` | `DESK_SIGNER_URL` set **and** `DESK_SIGNER_KEY` absent |

Notes that matter:

- **`DESK_SIGNER_KEY` present is a FAILURE, not a feature.** It means the private
  key is readable by the request handler. The gate fails closed even when a signer
  URL is also set, so a copied deployment with a pasted key cannot arm.
- **No single flag arms anything.** There is no path from Telegram, from HTTP, or
  from a table row to live. Arming needs account access (`wrangler secret put`).
- **`/desk live` records the request and keeps paper in force.** It reports the
  unmet gates. It cannot arm.
- **Even with every gate met, this build cannot trade live.** `executor.submitLive()`
  throws `live_signer_not_wired`. Nothing in this tree builds, signs or broadcasts
  a transaction. That is deliberate: live submission needs a dedicated signer
  service, and wiring one is a separate piece of work with its own review.
- A test asserts no file under `src/desk/` contains `sendTransaction`,
  `signTransaction`, `Keypair.fromSecretKey` or `bs58.decode`.

### Circuit breaker

−8% realized loss in a UTC day → **halt for 24 h**. There is **no reset function
anywhere**: `grep -i "reset\|clear\|unhalt" src/desk/arming.ts` is empty, and a
test asserts no such export exists. The only exit is `until` passing into the
past. A chat command that cleared it would fire at the exact moment the operator
is most likely to override it.

The threshold is measured against **equity at the start of the day**, not current
equity. Dividing by the post-loss book makes a 7.9% loss read as 8.6% (the book
shrank), so the breaker fires early and the operator cannot reproduce the
arithmetic from their own statement. Tested both ways (−9% halts, −7.9% does not).

While halted the desk does **no scanning at all**, which also stops the subrequest
spend: halting means "no work", not just "no trades".

---

## 5. Data access

Every outbound call goes through `getJson()` in `source.ts`, which:

- charges the **subrequest budget** first (`quota` bucket `desk_subrequests`,
  default cap 4000/day) and throws `BudgetExhausted` rather than proceeding;
- enforces a hard **8 s timeout** via `AbortController`.

Verified shapes (2026-10-29), because several of these invert a gate if assumed:

| Source | Fact | Observed |
|---|---|---|
| `api.dexscreener.com/token-pairs/v1/solana/{mint}` | returns a **flat array**, not `{pairs:[]}`; a pump.fun bonding curve in the same array has `liquidity: null` | pair selection must prefer the pair with real liquidity or the ratio gate divides by zero |
| `api.rugcheck.xyz/v1/tokens/{mint}/report` | `mintAuthority` / `freezeAuthority` are **null when revoked** | null == good, the opposite of the usual convention |
| same | `knownAccounts: {address: {name, type}}`, types `AMM`/`LOCKER`/`CREATOR` | the exclusion set is **derived**, not hardcoded |
| same | `topHolders[].owner` is what identifies the pool | a live pair's largest holder at **11.93%** was the AMM vault, and its *address* appears in no known-account list |
| RPC `getTokenSupply(lpMint)` | `uiAmount == 0` means all LP burned | on a fully-burned pump.fun AMM pool |

Two facts are **not** available and are returned as `null` rather than guessed:

- **`metadataMutable` / `programUpgradeable`** — neither free endpoint reports
  them. They are `null`, which costs the residual-safety sub-score 10 points each
  instead of being assumed clean. The `metadata_mutable_upgradeable` kill can
  therefore never fire on live data; it fires only on a dossier that supplies them.
- **`price6hLowUsd` / `price24hLowUsd`** — a pair payload carries current price
  and percent changes, not extrema. The low is **reconstructed** from the change
  fields, which is a close-to-close estimate, not the true low. A token that
  spiked and retraced has a much lower true low than its 6h-ago price, so
  `late_entry` is **less strict** than the real rule on such tokens. This is the
  weakest number in the pipeline.

### Honeypot probe is modelled, not simulated

`source.ts` computes the sell impact from pool depth and marks the result
`modelled: true`. It detects a pool too shallow for our exit. It does **not**
detect a sell that reverts on-chain for a non-depth reason — a frozen account, a
disabled transfer, a blacklist — because that needs `simulateTransaction` with a
built sell instruction and a funded key. The `honeypot_sell_reverts` path is
implemented and tested, but with the live source it can only fire if a future
provider supplies a real simulation result. Do not read "no honeypot kill" as
"not a honeypot".

---

## 6. Schema

Seven tables, all prefixed `desk_`, appended to `schema.sql` in the existing
idempotent style (`CREATE TABLE IF NOT EXISTS`, re-running is safe):

`desk_universe` · `desk_scores` · `desk_kills` · `desk_positions` · `desk_fills`
· `desk_theses` · `desk_calibration`

Trading data never enters `findings`, `evidence`, `probes` or `approvals` — a
test asserts all three stay at zero rows after a full round-trip. The ledger
receives `desk.*` audit lines only (`desk.kill`, `desk.open`, `desk.refused`,
`desk.exit`, `desk.exit_refused`, `desk.halt`, `desk.calibration`), which is how
the rest of the app records that something happened; because the ledger is
hash-chained, a position with no corresponding ledger line is detectable.

Mode lives in `kv` (`desk_mode`) and can only ever move the desk **toward** paper:
if it says `live` but a gate fails, the desk runs paper and says why.

---

## 7. Cron and surfaces

| Slot | What runs |
|---|---|
| `*/5 * * * *` | `runSentinel` (unchanged) **then** `deskTick` — scout+filter, then risk. Composed, never a replacement; each has its own try/catch so one failing cannot silence the other. |
| `0 * * * *` | `runCrawler` then `deskAnalystTick` (refreshes theses for passed tokens) |
| `15 3 * * *` | `runMaintenance` then `runCalibration` (measure outcomes, build + store the report) |

Telegram: `/desk` · `/desk paper|live` · `/pos` · `/kills` · `/thesis <mint>` ·
`/calib`.

Read-only API, GET only, inside the existing `dashboardApi` switch so it inherits
`withCors` and `requireDashboardAuth`: `/api/desk`, `/api/desk/positions`,
`/api/desk/kills`, `/api/desk/calib`.

**There is no mutating desk endpoint and no arm control.** A test enumerates
plausible paths (`/api/desk/arm`, `/live`, `/mode`, `/trade`, `/reset`,
`/breaker/clear`) and asserts they 404/405. A web control that can start real
trading is one XSS or one leaked URL away from an empty wallet; the correct
design is that no such control exists.

`/api/desk/positions` deliberately returns `stale: true` and marks each position
at its entry price rather than quoting live: a dashboard read must not spend the
subrequest budget or fail when an exchange is down. Live PnL is on `/pos` in
Telegram, which fetches per position with its own timeout.

---

## 8. Tests and controls

`tests/desk.test.mjs` — 28 tests, all green. The seven required cases:

1. honeypot rejected on freeze authority (and asserts it fails **only** on that)
2. good token that raw top-10 would kill is **saved by the pool/burn/CEX
   exclusion** — asserts the fixture exceeds 25% raw, that the exclusion brings it
   under, and that all three entries (pool, burn, CEX) are removed
3. wash-traded token rejected, with the actual 0.09 ratio in the detail
4. sizing refuses when the position would exceed 1% of pool liquidity (both the
   fill model and `decideSize`)
5. circuit breaker halts, `requestMode('paper')` cannot clear it, the module
   exposes no reset, and the halt expires on its own
6. live arming refuses with gates unmet, **every gate reported by name** with its
   requirement and actual value
7. full paper round-trip: scout → filter → score → fill → stop, on fixtures,
   deterministic (a second identical run must produce identical scores)

Plus: coverage gap ≠ kill, never-average-down, concurrent-position cap, trailing
stop arming/tightening, time stop, liq-decay-before-PnL ordering, dev-sell exit,
Token-2022 delegate vs a 4% transfer fee, reverting sell simulation, and a
structural guard that no desk file contains transaction signing.

Fixtures are `tests/fixtures/desk/{honeypot,good,wash}.json` — dossiers in
recorded shape (DexScreener market block + RugCheck safety/holders block). No test
touches the network; the source is injected.

`tests/desk-api.test.mjs` — 13 tests at the **shipped entrypoint**
(`build/index.js`), including cron reachability and the absence of any arm path.

### Negative controls

`scripts/desk-negative-controls.mjs` breaks each rule, rebuilds, runs the suite,
and asserts the suite goes red **for the expected test specifically** (checking the
`✖`/failing-tests section, not just that the name appears somewhere — it also
appears in the passing list). Each restore is verified against the pre-control
sha256.

```
baseline: pass=28 fail=0

RED as expected: freeze authority check broken — the honeypot fixture must now pass
   pass=25 fail=3
RED as expected: holder exclusion removed — the good token must be killed on raw top-10
   pass=22 fail=6
RED as expected: 1% pool-share refusal removed — an impossible paper fill must be allowed
   pass=27 fail=1
RED as expected: circuit breaker disabled — a -9% day must stop halting
   pass=27 fail=1
RED as expected: floor enforcement removed — a one-metric token must now pass
   pass=27 fail=1
RED as expected: liquidity ratio gate weakened to a flat floor — a $40k pool on a $20M token must pass
   pass=27 fail=1
RED as expected: pre-PnL exit ordering broken — liq decay must stop pre-empting the mark
   pass=27 fail=1

restored: pass=28 fail=0
controls proved: 7/7
```

The freeze-authority control is the mandated one and it fails the honeypot test
first, as it should.

---

## 9. Adding a flow provider

This is the one change that turns the desk from "structurally complete" into
"actually trades". Implement `FlowProvider` (`types.ts`) and pass it as
`flow` on the source:

```ts
const source: DeskSource = {
  ...liveSource(env),
  flow: async (mint, market) => {
    // Return real numbers, or null for any you do not have.
    // null is a coverage gap; a guessed number is a lie that passes wash trades.
    return { uniqueBuyers, totalBuys, bundledPct, sniper20Pct, devClusterPct,
             devPriorRug, buyVolumeUsd, sellVolumeUsd, avgBuyUsd, medianBuyUsd,
             uniqueBuyerGrowthPct, smartWalletPct, atr14Pct };
  },
};
```

Partial providers are fine and are the honest way to start: supply
`buyVolumeUsd`/`sellVolumeUsd`/`uniqueBuyerGrowthPct` and the analyst still cannot
score `uniqueBuyers`, so those tokens remain coverage gaps. The desk will not open
a position on a partially-known token.

---

## 10. Limitations, complete list

Stated so nothing here is discovered later the hard way:

1. **No trades happen without a flow provider.** §1. The single biggest caveat.
2. **Honeypot probe is modelled, not simulated.** Cannot detect a revert.
3. **`price6hLow`/`price24hLow` are reconstructed estimates**, making
   `late_entry` weaker than the stated rule on tokens that spiked and retraced.
4. **`metadataMutable`/`programUpgradeable` are always null on live data**, so
   `metadata_mutable_upgradeable` cannot fire from the real source.
5. **The candidate universe is biased.** `token-profiles/latest` is a *promoted*
   feed, so it over-represents tokens whose owners are marketing them. It is a
   starting universe, not a complete scan of new pairs.
6. **MEV/sandwich cost is not modelled**, so paper results are optimistic.
7. **Failed transactions and retries are not modelled.**
8. **The known-address registry is incomplete.** An unlisted CEX wallet stays in
   the concentration denominator and inflates it. That direction is safe (it kills
   rather than passes) but it can be over-strict.
9. **`desk_universe.holders` is written as 0 at scout time** and only filled
   after the dossier arrives; the scout gate reads the dossier's count, so this
   cannot pass a token, but a direct SQL reader should not trust that column
   before `state='in'`.
10. **Live order submission does not exist.** `submitLive()` throws. Enabling it
    requires a dedicated signer service — out of scope for this build and
    deliberately not stubbed.
11. **Calibration outcomes need a price-history source** (`DeskSource.since`).
    Without one, kills stay `outcome='unknown'` and the report prints
    "unmeasured" per reason rather than flattering the filter.
12. **The `0 * * * *` analyst tick is a thesis refresher**, not a full re-score.
    Re-scoring the universe hourly was not worth the RPC spend when the sweep
    already pays for the dossier.
13. **Single-asset composability is untested.** The model assumes positions are
    independent; three correlated memecoin positions at 8% each is a 24% bet on
    one factor, which the 24% deployed cap bounds but does not diversify.
14. **No backtest over historical pairs.** All evidence is forward paper trading,
    which is why the 200-trade gate will take months even once a provider exists.
