# Trading: what the screenshot asks, what the code has, and the exact fix

Read-only on `wbot`. The runnable switch is `kestrel/desk.py`.

---

## 1. The screenshot's spec vs the shipped desk

The screenshot describes a BTC/ETH/SOL desk on a centralised exchange:
1% risk per trade, max 3 open positions, daily stop at -3%, real orders.

The shipped desk is a different instrument:

| | screenshot | `wbot/app/src/desk/` |
|---|---|---|
| venue | CEX (Binance candles, funding) | Solana DEX (on-chain mints) |
| asset | BTC, ETH, SOL majors | fresh memecoins, 30 min to 72 h old |
| position size | 1% risk | `RISK.hardStopPct 0.06`, ATR-scaled |
| max open | 3 | not expressed as a count |
| daily stop | -3% | `BREAKER.lossPct 0.08` |
| orders | real | `submitLive` throws |

So the screenshot is not a bug report against the desk. It is a second
instrument. `desk.py` implements the screenshot's numbers directly.

## 2. Why auto buy/sell does not run today

Three independent reasons, in the order they bite:

| # | cause | file |
|---|---|---|
| T1 | `submitLive()` throws `live_signer_not_wired` | `executor.ts:438` |
| T2 | live requires 4 gates: 200 trades, 30 days, 15% drawdown, **and** `wrangler secret` arming | `arming.ts:409`, `:167-175` |
| T3 | the filter refuses tokens whose flow gates are unknown, so nothing is ever opened | `DESK.md` §9, `filter.ts:18` |

T3 is the real blocker. T1 and T2 are deliberate. A desk that never opens a
position cannot reach 200 paper trades, so T2 can never be satisfied. That is a
deadlock, not a safety feature: the arming gate is waiting on a number the
filter prevents from existing.

## 3. The switch

`kestrel/desk.py` separates the two ideas the screenshot conflates.

- **switch** (`auto_trade`): does it place orders by itself. Royan flips it.
- **armed**: is it allowed to use real money. A conjunction of gates.

They are independent so that flipping the switch can never quietly move money:

```
switch ON  + unarmed  -> paper, and it says which gates are unmet
switch OFF + armed    -> paper, even though arming passed
switch ON  + armed    -> live
```

Verified: 18 selftest checks, including all three of those rows, plus
`switch off means no buy`, `max 3 open`, `stop books a loss`, `target books a
profit`, `daily -3% halts and blocks new entries`.

## 4. Live trade, end to end

```
$ python3 desk.py reset && python3 desk.py on
switch      ON
mode        paper
armed       False  (unmet: paper_trades, paper_days)

$ python3 desk.py tick --symbol BTC --price 100 --signal enter
mode paper  buy BTC @ 100.0
   qty 0.1   entry 100.0   stop 94.0   target 112.0   # $10 = 1% of $1000

$ python3 desk.py tick --symbol BTC --price 112 --signal hold
mode paper  sell BTC @ 112.0
equity 1001.2  paper 1  W 1
```

Sizing is fixed-fractional on equity, stops are hard percentages, and the
breaker is checked every tick.

## 5. What still needs a key to go live

`desk.py` is the decision layer: it sizes, enters, exits, stops, and halts. It
deliberately does not talk to an exchange. The three things needed to make it
place a real order:

1. a venue adapter (one function: `submit(side, symbol, qty) -> fill`)
2. key handling, withdrawals disabled, env only
3. a fill reconciler, so a partial fill does not desync `open[]`

Nothing else in the file changes. `tick()` already returns the exact order
intent, so the adapter is a sink, not a rewrite.

## 6. Honest gap in the screenshot's plan

The screenshot wants "3 years of Binance candles with real fees and funding,
scored 18/25". That is a backtest harness, not a bot, and it is genuinely
missing. `desk.py` has no backtester. A strategy can be run through `tick()`
against a price series in a loop, which is enough for a smoke test but not
enough to claim a profit factor. Do not quote a win rate from it.
