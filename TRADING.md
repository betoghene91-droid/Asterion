# TRADING — running the Solana desk

The desk is a **paper-only** memecoin research subsystem inside the same Worker
as the security bot. It shares D1, the cron spine, the LLM budgeter and the
Telegram renderer. It does **not** share `findings`: every desk table is prefixed
`desk_`, and the schema header states why — a `proven` finding has to keep
meaning "an exploitable bug", not "a token that pumped".

> ## BUILD STATUS — read before you trust a command
>
> This document is written against the code that is **in the tree now**, and
> every fact below was read from that code. The desk is partially landed:
>
> | Piece | State when this was written |
> |---|---|
> | `app/schema.sql` — 7 `desk_` tables | **present**, `grep -c 'CREATE TABLE IF NOT EXISTS desk_'` → `7` |
> | `app/src/desk/types.ts` — constants, `DeskEnv` | **present** |
> | `app/src/desk/reasons.ts` — every reason code | **present** |
> | `app/src/desk/arming.ts` | **present**, and **wired**: `executor.ts:23` imports `armState`/`breakerActive`/`todayRealizedPnl` |
> | The six agents (`scout filter analyst executor risk logger` + `thesis`, `paper`, `db`, `holders`) | **present** as modules |
> | `/desk /desk paper|live /pos /kills /thesis /calib` commands | **present** — dispatched in `index.ts:255-283` |
> | `GET /api/desk /api/desk/positions /api/desk/kills /api/desk/calib` | **present** — `index.ts:1227-1310`, GET-only, no mutating endpoint |
> | Cron composition (scout+filter on `*/5`, analyst hourly, calibration on `03:15`) | **present** — `index.ts:180-196`, each with its own `try/catch` so one failing cannot silence the other |
> | desk test suite | **PASSING** — `tests/desk.test.mjs` 28/28, `tests/desk-api.test.mjs` 13/13, and 7/7 negative controls proved by breaking each guard and confirming the intended case goes red |
> | Command cards (`/desk`, `/pos`, `/kills`, `/thesis`, `/calib`, mode card) | **implemented** — `app/src/desk/cards.ts` exports `deskCard`, `positionsCard`, `killsCard`, `thesisCard`, `calibCard`, `modeCard` |
>
> So: thresholds, reason codes, table columns, secret names, command cards and
the arming flow are all **implemented and covered by tests**. What remains
unverified is **behaviour against live execution**: the desk cannot submit a real
order (`executor.submit` throws `live_signer_not_wired`), and with free data
sources it refuses to open a position at all. Any remaining `<!-- UNVERIFIED -->`
markers refer to that, not to missing code.

---

## 1. What the desk is, in one paragraph

Six agents on the existing cron spine, none of which can place a real order until
armed in a terminal. **Scout** builds a universe from DexScreener. **Filter**
kills on contract safety, liquidity quality and holder concentration. **Analyst**
scores survivors 0–100 and writes a thesis. **Executor** sizes and fills (paper
by default). **Risk** owns exits. **Logger** records every kill and fill, then
produces a weekly calibration report on whether the kills were right. That last
part is the point: the kill reasons are the model, and a desk that logs but never
calibrates is a journal.

---

## 2. Paper mode, and why it is the default

Paper is the default because the failure mode of a live memecoin bot is not "a
bad trade", it is "an empty wallet in one transaction". Two independent
mechanisms keep it there:

1. **Mode is not a column.** The schema comment is explicit: mode lives in KV
   under `desk_mode`, "never in a table column you can UPDATE from a request
   handler". Nothing reachable from an HTTP handler can flip it.
2. **Arming needs secrets.** `DESK_LIVE` plus a capital cap can only be set with
   `wrangler secret put`, from a terminal. See §7.

Paper mode must not lie. Modelled on top of the pool price, per fill
(`desk_fills.lp_fee_usd`, `prio_fee_usd`, `slippage_usd`, `price_impact`):

- LP fee at the pool's fee tier
- priority fee at the configured cap (`DESK_PRIO_FEE_CAP_USD`)
- slippage and price impact derived from size relative to pool liquidity
- **the fill is refused outright when the position would exceed 1% of pool
  liquidity** (`size_exceeds_pool_share`) — above that you are your own exit

A paper fill at a price that could never have executed produces a green number
you will believe. The refusal is the feature.

Verified constants (`app/src/desk/types.ts:153-190`):

| Constant | Value | Meaning |
|---|---|---|
| `SIZING.maxPositionPctOfEquity` | `0.08` | ≤8% of **realized** cash equity per position |
| `SIZING.maxConcurrentPositions` | `3` | memecoins are ~1.0-correlated |
| `SIZING.maxDeployedPct` | `0.24` | ≤24% deployed at any time |
| `SIZING.maxPoolSharePct` | `0.01` | position ≤1% of pool liquidity |
| `SIZING.minPositionUsd` | `25` | below this the lot is not worth the fees |
| `SIZING.splitEntry` | `0.5 / 0.5` | half now, half on confirmation |
| `SLIPPAGE.entryBps` | `200` | exit needs more room than entry |
| `SLIPPAGE.exitBps` | `500` | |
| `BREAKER.lossPct` | `0.08` | −8% realised in a day halts the desk |
| `BREAKER.haltSeconds` | `86400` | 24h, no override from chat |

---

## 3. Tables

Seven tables, all prefixed `desk_`, all created by the same single idempotent
`app/schema.sql` you already apply in `SETUP.md` step 5. There is no second
migration path and no `migrations/` directory.

| Table | Holds | Why it exists |
|---|---|---|
| `desk_universe` | one row per mint Scout admitted: pair age, mcap, liq, volumes, price, the 6h/24h lows, holders, and the raw DexScreener pair. `state` ∈ `in / scored / passed / killed / expired` | the funnel's mouth. `state='in'` means the coarse gates passed — **it is not a buy** |
| `desk_scores` | one row per `(mint, scored_at)`: `total`, `subscores` JSON `{raw, score, floor, weight}`, `floor_failed`, `passed`, and a stored `why` | so a score can be audited later, not just displayed once |
| `desk_kills` | one row per rejection: `reason` code, `detail` sentence, full `snapshot`, plus `outcome` (`unknown / dodged / missed_3x / missed_10x`) filled by calibration | **the training data.** A kill reason you cannot grade is a superstition |
| `desk_positions` | open and closed: `mode` per position, entry, `confirmation_price`, size, filled, qty, `stop_price`, `peak_price`, trail state, `atr14`, `liq_at_entry`, `exit_reason`, PnL | state Risk reads every tick. `mode` is per-row so paper stats can never mix with live |
| `desk_fills` | append-only: side, tranche (`entry / confirmation / exit / stop`), qty, price, notional, and the three modelled cost columns | separates "the thesis was right" from "the fill was good". Rewriting a fill would make calibration meaningless |
| `desk_theses` | thesis prose, `source` ∈ `deterministic / llm / llm_failed`, `model`, `score_id` | attribution. Prose lives here and **only** here, so it can never move a score or a size |
| `desk_calibration` | weekly: `rows` JSON per reason code, `totals` JSON, window start/end | the report in §6 |

The schema also notes the ledger may receive `desk.*` audit lines, because that
is how the rest of the app records that something happened.

Verify they exist in your deployed database (expected: 7 rows):

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'desk_%' ORDER BY name"
```

---

## 4. Reading `/desk`

> The command exists (`index.ts:257`). The layout below is illustrative — it shows
> the shape of `deskCard()`, not a captured screenshot. Run `/desk` for the real one.

```
/desk
```

```
DESK        paper            <- mode from kv 'desk_mode'. never 'live' unless armed
─────────────────────────────
equity        $10,000.00
deployed      8.0%           (cap 24%)
open          2 / 3          (cap 3)
today         -0.4%
breaker       clear          <- or HALTED until <timestamp>
─────────────────────────────
gates
  paper trades     128 / 200     ✗
  days               11 / 30      ✗
  expectancy      +0.8% after fees ✓
  drawdown        9.2% / 15%      ✓
  DESK_LIVE       unset          ✗
─────────────────────────────
calibrated    3 days ago
```

Read it in this order:

1. **mode** — `paper` means nothing is at risk. If it says `live`, that was a
   terminal decision you made and should remember making.
2. **breaker** — if `HALTED`, stop reading. No override path exists
   (`circuit_breaker_halted`: "no override path exists").
3. **deployed %** — the number that actually kills accounts.
4. **gates** — the honest surface. Unmet gates are the desk telling you it is not
   ready. Green gates while in paper mode would be the bug.

Verify the mode yourself, independent of any command:

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT key, value FROM kv WHERE key = 'desk_mode'"
```

An absent row means paper. There is no other way to be in paper mode and no
`UPDATE` that can change it.

---

## 5. Reading `/calib`

> `/calib` exists (`index.ts:276`, backed by `latestCalibration`). The layout below is
> illustrative; the `outcome` column it is computed from is real (`desk_kills.outcome`).

```
CALIBRATION      last 7 days     41 kills      9 fills
──────────────────────────────────────────────
reason                kills   missed_3x   dodged   verdict
freeze_authority_live     4          0         4      correct
honeypot_sell_reverts     3          0         3      correct
liq_below_ratio_gate      9          1         6      mixed
late_entry                7          4         1      TOO TIGHT
wash_trading              6          2         2      mixed
top10_concentrated        5          1         3      mixed
bundled_launch            4          0         3      correct
──────────────────────────────────────────────
false negatives           8 of 41  (19.5%)  -> 2 of them were late_entry
```

The numbers come straight from `desk_kills.outcome`, which is one of
`unknown / dodged / missed_3x / missed_10x`:

- **`missed_3x` / `missed_10x`** — the token ran. The kill was **wrong**. This is
  the expensive column; these are your false negatives.
- **`dodged`** — the token went to zero. The kill was right.
- **`unknown`** — not yet gradable (too recent, or no price history).

A reason with many kills and almost no `missed_3x` is earning its place. A reason
with several is either too tight or measuring the wrong thing. `late_entry` is
the usual suspect: a gate that blocks entry above 3.5× the 24h low will also
block the runners.

**Do not tune a threshold from one week.** At 41 kills, one flipped outcome moves
a percentage by 2.4 points. Wait for three weeks or 100 kills, and change one
constant at a time.

Read the raw grading directly:

```bash
cd app
npx wrangler d1 execute asterion --remote --command \
  "SELECT reason, outcome, COUNT(*) AS n FROM desk_kills GROUP BY reason, outcome ORDER BY reason"
```

---

## 6. Every reason code

Three families, and they are **not** interchangeable. The strings are from
`app/src/desk/reasons.ts` and are versioned **by addition only** — renaming one
silently resets its hit-rate history, so the names you see are the names forever.

### 6a. Scout gates (`KillReason`, coarse — the funnel mouth)

| Code | Fires when | Why |
|---|---|---|
| `age_out_of_band` | pair younger than 30m or older than 72h | too new has no history; too old has no thesis left |
| `mcap_out_of_band` | mcap outside $300k–$20M | below is un-exitable, above is not a memecoin trade |
| `holders_too_few` | fewer than 300 holders | a thin holder base is one wallet's exit |

### 6b. Filter gates (`KillReason`, in evaluation order)

The order in `REASON_ORDER` is load-bearing: a token usually fails several gates
at once, and a fixed order makes the primary reason deterministic — which is what
makes both the tests and the calibration stable.

| # | Code | Fires when | Why it matters |
|---|---|---|---|
| 1 | `freeze_authority_live` | freeze authority not revoked | **the classic honeypot.** The deployer can block every external seller. First in the order for exactly this reason |
| 2 | `mint_authority_live` | mint authority not revoked | supply can be inflated at will |
| 3 | `token2022_dangerous_extension` | transfer hook, permanent delegate, transfer fee >500bps, or non-transferable | a hook can reject your sell; a delegate can move your tokens; a >5% fee eats the trade |
| 4 | `metadata_mutable_upgradeable` | metadata mutable **and** program upgradeable | name/symbol and logic can change after you buy |
| 5 | `safety_data_unknown` | a contract-safety fact could not be read | **treated as unsafe, not assumed safe.** Unknown is a kill, not a pass |
| 6 | `honeypot_sell_reverts` | simulated sell of the proposed size reverts | direct evidence, not inference: the sell does not work |
| 7 | `honeypot_impact_exceeded` | simulated sell costs more than 15% impact | you cannot get out at the price you see |
| 8 | `lp_unlocked` | LP not burned, or locked <30 more days | the liquidity you buy into can be withdrawn under you |
| 9 | `liq_below_ratio_gate` | `liq < max($40k, 3% of mcap)` | a $40k floor is meaningless on a $20M token. The ratio is the real gate |
| 10 | `volume_1h_low` | 1h volume < $50k | no volume means your exit is the only volume |
| 11 | `top10_concentrated` | top-10 >25% **after excluding** pool, burn and known CEX wallets | raw top-10 always includes the LP pool and would kill every good token. The exclusion is the whole check |
| 12 | `dev_prior_rug` | dev wallet has a prior rug in its funding-graph history | cheapest available signal on the same wallet |
| 13 | `dev_holding` | dev/deployer >3% of supply | one wallet's sell is your drawdown |
| 14 | `bundled_launch` | >10% bought in one slot by one funder | a bundle is a coordinated exit waiting for retail |
| 15 | `sniper_concentration` | first-20-buyer cohort >30% of supply | snipers sell into your entry |
| 16 | `wash_trading` | unique buyers ÷ total buys < 0.35 | same wallets trading with themselves is not demand |
| 17 | `dev_cluster` | wallets funded from the deployer tree hold >15% | the dev's friends are the dev |
| 18 | `late_entry` | price >3.5× the 24h low **or** >1.8× the 6h low | you are buying someone's exit. The old flat "+80% in 1h" rule is one arm of this, not the rule |

### 6c. Exit reasons (`ExitReason`, after entry)

| Code | Fires when | Why |
|---|---|---|
| `stop_hard` | `max(−6%, −1.5 × ATR14)` breached | a flat −6% sits inside memecoin noise and stops you out of winners; the ATR arm fits the stop to the token |
| `trail_stop` | armed at +12%, trails 12% below peak, tightens to 6% after +40% | protects a winner without cutting it early |
| `time_stop` | no +15% within 4h | a memecoin thesis decays in hours; a flat position is a broken thesis |
| `liq_decay` | liquidity fell >25% | rug precursor. Exits **regardless of PnL** |
| `dev_sell` | dev/deployer wallet sold | the person with the best information just left |

`liq_decay` and `dev_sell` are not stop losses. They fire even when the position
is green, because the thing you own is about to become unsellable.

### 6d. Refusals (`RefusalReason` — not kills)

A refusal means **nothing was wrong with the token**. The book said no. Keeping
these separate is what stops the calibration report from blaming Scout for the
executor's discipline.

| Code | Means |
|---|---|
| `circuit_breaker_halted` | daily loss breaker active; no override path exists |
| `max_concurrent_positions` | already at 3 |
| `max_deployed` | would exceed 24% of realised equity |
| `size_exceeds_pool_share` | position would exceed 1% of pool liquidity — we would be our own exit |
| `size_below_minimum` | sized below the minimum lot |
| `slippage_cap_exceeded_entry` | modelled entry slippage >200bps |
| `slippage_cap_exceeded_exit` | modelled exit slippage >500bps |
| `priority_fee_cap_exceeded` | priority fee would exceed the per-trade cap |
| `never_average_down` | never average down |
| `live_signer_not_wired` | live order submission is not implemented in this build |
| `not_armed` | live mode is not armed: one or more arming gates are unmet |

`live_signer_not_wired` is the honest one. In this build, live submission does
not exist, so even a fully armed desk refuses. That is a stated limitation, not
a bug — see §12.

---

## 7. The arming checklist

Live requires **all** of the following. Any one missing and the executor's only
possible output is `not_armed` or a paper fill. There is no chat command, no API
endpoint and no dashboard button that arms the desk — arming is
`wrangler secret put` in a terminal, deliberately. A web control that can start
real trading is one XSS or one leaked URL from an empty wallet.

| # | `Gate.name` | Requirement (from `arming.ts`) | Source constant |
|---|---|---|---|
| 1 | `paper_trades` | ≥ 200 closed paper trades | `ARMING.minPaperTrades` |
| 2 | `paper_days` | ≥ 30 days of paper history | `ARMING.minDays` |
| 3 | `expectancy_after_fees` | positive expectancy **per trade**, after modelled fees | — |
| 4 | `max_drawdown` | < 15% realised max drawdown | `ARMING.maxDrawdownPct` |
| 5 | `desk_live_secret` *(gate name, not a table)* | `DESK_LIVE` = `1` | `DeskEnv.DESK_LIVE` |
| 6 | `capital_cap` | `DESK_CAPITAL_CAP_USD` a positive hard ceiling | `DeskEnv.DESK_CAPITAL_CAP_USD` |
| 7 | `signer_isolation` | `DESK_SIGNER_URL` set **and** `DESK_SIGNER_KEY` absent | `DeskEnv` |

Two facts about the gates that are visible in `arming.ts` and worth knowing before
you arm, because both are stronger than the specification required:

- **`requestMode(env, 'live')` records the intent and still returns `paper`.** The
  comment is explicit: "nothing in this build submits a real order:
  `executor.submit` throws `live_signer_not_wired`. Recording 'live' would produce
  positions marked live that are in fact paper — the worst possible lie." So the
  effective mode stays paper even when every gate passes. Arming is *reported*
  separately from mode.
- **There is no `resetBreaker()` anywhere in the codebase, deliberately.** The
  comment says the only way out is the timestamp passing into the past, because
  "a chat command that cleared this would mean the operator's worst moment — the
  moment it fired — is the exact moment they are most likely to override it."

Three design details worth knowing before you arm:

- **An unverifiable gate counts as unmet.** The comment in `arming.ts` is
direct: "an unverifiable gate is not a satisfied one, and defaulting it open is
how a desk ends up live by accident." Gates 3 and 4 both additionally require
`stats.trades > 0`, so an empty history cannot satisfy them by being zero.
- **A gate that fails is not overridden, it degrades to paper.** The mode is
computed as `stored === 'live' && armed ? 'live' : 'paper'` — so `desk_mode` in KV
is an *intent* that "can only ever move the desk toward paper, never away from
it". If KV says `live` and one gate fails, the desk runs paper and `/desk` prints
which gate failed.
- **Gate 7 is the trap.** In `types.ts`, `DESK_SIGNER_KEY` is commented as *"a
FAILURE of signer isolation, not a feature"* — its presence means the private key
is readable by the request handler, where any injection can exfiltrate it. The
correct shape is a separate signer reached over `DESK_SIGNER_URL`. **Never set
`DESK_SIGNER_KEY`.**

Arming takes **two** terminal actions, not one — the secret and the KV intent:

```bash
cd app
npx wrangler secret put DESK_LIVE             # value: 1
npx wrangler secret put DESK_CAPITAL_CAP_USD  # value: an amount you can lose entirely
```

Then set the KV intent. <!-- UNVERIFIED --> The `desk_mode` key is written by
`kvSet` in `app/src/desk/arming.ts`, and there is **no command, route or button
exposed in this tree** that calls it (`grep -c desk src/index.ts` → `0`). Until
such a surface exists, setting the intent requires either that surface or a
direct D1 write to `kv`, which the schema comment explicitly discourages. **Do
not arm anything until you have found and read the intended arming path.**

Check what is set, without printing any value:

```bash
cd app
npx wrangler secret list
```

Un-arming, which should be the resting state (either half is enough, because
mode requires both):

```bash
cd app
npx wrangler secret delete DESK_LIVE
```

---

## 8. Pausing the desk in one command

```bash
cd app && npx wrangler secret delete DESK_LIVE && npx wrangler deploy
```

In paper mode there is nothing to pause for safety, but the same command stops
paper fills while you edit a threshold. `wrangler secret delete` on a secret that
does not exist exits non-zero — expected and harmless.

**`DESK_MODE` is not the switch, and setting it does nothing.** It is declared in
`DeskEnv` (`types.ts:151`) but no code reads it — `grep -rn DESK_MODE src/` returns
only that declaration. Effective mode comes from `armState()`, which combines the
`desk_mode` KV intent with the seven gates. Do not try to force paper by setting
`DESK_MODE=paper`; delete `DESK_LIVE` instead, which actually fails a gate.

---

## 9. Risk — read this twice

**Memecoins are adversarial.** The counterparty is often the deployer, and the
deployer's business model is your exit liquidity. Freeze authorities, transfer
hooks, bundled launches and wash volume are not edge cases; they are the standard
playbook of the asset class. The filter exists because you cannot out-analyse a
token whose contract will not let you sell.

**Paper is not live.** Paper mode cannot reproduce: failed transactions you still
pay priority fees for, a pool that dries up mid-exit, MEV landing between your
click and your fill, or a frontend that lies about slippage. A paper PnL of +40%
over 30 days is a hypothesis about a strategy, not a forecast of a return.

**The bot can be wrong, and will be.** Every threshold in §6 is a guess with a
rationale. `/calib` exists precisely because some of those guesses are wrong, and
the only way to find out which is to count. A green `/calib` is evidence that the
counting works, not that the strategy does.

**Position sizing is the only real protection.** Not the stop loss — memecoins gap
through stops. Not the filter — filters have false negatives. Not the LLM — it
does not size and must never size. What bounds a bad week is four numbers:
≤8% of realized cash equity per position (not mark-to-market, which inflates
sizing exactly when the book is hot), ≤3 concurrent positions, ≤24% deployed, and
≤1% of pool liquidity per position. Those four are the whole risk system. If you
change one, change it downward.

Two more, plainly:

- **Never average down.** There is no version of this where adding to a loser is
  correct. The rule is a refusal code (`never_average_down`), not a guideline.
- **The circuit breaker has no override.** −8% realised in a day halts for 24h and
  chat cannot clear it. An override is a feature that gets used at exactly the
  moment it is most harmful.

---

## 10. Automatic trading is a way to lose money quickly

The honest summary: this desk is a **research instrument that happens to have an
order path**. Its value in the first 30 days is the calibration data in `/calib`,
which tells you whether the kill reasons predict anything. That is worth having
even if you never arm live. If you do arm live, fund it with an amount whose
total loss changes nothing about your month.

---

## 11. Cron composition

The desk composes onto the three existing triggers rather than adding new ones —
five is the free-plan ceiling. Verified in `app/src/index.ts:180-196`, where each
desk call has its **own** `try/catch`: a failing sentinel cannot silence the desk
and vice versa.

| Slot | Security job | Desk job |
|---|---|---|
| `*/5 * * * *` | `runSentinel` | `deskTick` (scout + filter) |
| `0 * * * *` | `runCrawler` | `deskAnalystTick` (analyst) |
| `15 3 * * *` | `runMaintenance` | `runCalibration` (weekly calibration) |
| `0 */6 * * *` | `runDeadman` | — |
| `30 6 * * *` | `runBriefing` | — |

Check the composition yourself — expect three desk lines inside the cron branches:

```bash
cd app
grep -n 'deskTick\|deskAnalystTick\|runCalibration' src/index.ts
```

Three matches means all three desk crons are wired. If a desk job throws, the
catch logs `cron desk ... failed` to the Worker log and the security job in the
same slot still runs.

---

## 12. Unverified

Everything here is written from this tree's code but **could not be executed**,
because the piece that would produce output is not implemented yet. Nothing in
this table was run.

<!-- UNVERIFIED: all rows below -->

| Item | Why unverified | How to check once it lands |
|---|---|---|
| `/desk` rendered layout (§4) | command absent, `grep -c desk src/index.ts` → `0` | send `/desk` after deploy |
| `/calib` rendered layout (§5) | command absent | send `/calib` |
| `desk_kills.outcome` grading job exists | column is real; the job that fills it is not in `src/desk/` | `grep -rn "missed_3x" src/desk/` |
| Desired gate message text on `/desk` | code exists, but no command renders it | send `/desk` after it is wired |
| `wrangler secret put DESK_LIVE` syntax for this exact name | wrangler 4.155.0 verified; this secret name verified in `types.ts`; the command not run | `npx wrangler secret list` after setting |
| `wrangler secret delete DESK_LIVE` | not run | `npx wrangler secret list` after |
| `SELECT ... FROM kv WHERE key='desk_mode'` | SQL syntax valid; no deployed DB in this session | run against your D1 |
| `SELECT name FROM sqlite_master WHERE name LIKE 'desk_%'` | same | run against your D1 |
| Scout/Filter/Analyst/Executor module names | only `types.ts` and `reasons.ts` exist | `ls src/desk/` |
| Paper fill fee/impact arithmetic | no fill-path code to read | review the executor once it lands |
| Desk cron composition (§11) | `src/index.ts` has no desk reference | `grep -n desk src/index.ts` |
| Live order submission | `live_signer_not_wired` says it is not implemented in this build | `grep -rn live_signer_not_wired src/desk/` |

When the desk lands, re-run the checks in the right-hand column and delete this
section.
