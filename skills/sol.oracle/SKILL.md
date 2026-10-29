# sol.oracle — spot-price / oracle manipulation

The question this skill answers is not "is there a price" but "can one
transaction move the number this contract trusts, and does it profit from doing
so?" Most oracle reports fail on the second half.

## When this is worth hunting

Worth the time when a *price-consuming* code path reads from a source that is
**mutable within a transaction**:

- `getReserves()` / `balanceOf(pair)` / `token0.balanceOf(pair)` used directly
  as a price. The reserve ratio is a function of whatever the caller just
  swapped; it is not an oracle.
- `IUniswapV2Pair.getReserves()` without a TWAP wrapper, or a "TWAP" whose
  window is one block.
- A single-source Chainlink/Pyth read with **no staleness check, no
  `answeredInRound` check, no min/max bound**, on an asset with thin liquidity.
- A `latestRoundData()` whose return tuple destructuring is wrong (the classic
  `updatedAt` / `answeredInRound` swap), or where the price is used even when
  `answer <= 0`.
- LP-token pricing from `2 * sqrt(k) / totalSupply` (the "fair LP" formula)
  where fees have accrued or where the pool can be donated into.
- Collateral valuation that reads a spot DEX price at liquidation time — the
  attacker can push the price, liquidate, and unwind.
- AMM invariant math (`x*y=k`) used to value a position, combined with a
  flashloan.

Waste of time when:

- The price comes from a properly configured TWAP (30 min+ window) with a
  liquidity floor and the consumer checks staleness.
- The consumer only *displays* the price, or the worst case is a revert.
- The pool is deep enough that moving the price 1% costs more than the position
  is worth — and you can show that with numbers, not vibes.
- The manipulation is bounded by a `maxSlippage`/`maxPriceAge`/circuit breaker
  that the attacker cannot touch.
- The function is `view` and no state-changing path consumes it.

## How to confirm it is even reachable

- **Find the consumer, not the source.** A manipulable price is only a bug if
  something borrows against it, mints against it, liquidates with it, or pays
  out on it. Name that consumer.
- **Check the pool depth at the fork block.** If moving the price to the
  profitable point requires more capital than a flashloan can supply on that
  chain, there is no exploit — there is a theoretical note.
- **Check whether an attacker can actually swap on that pool**: is it the only
  venue, is there a fee, is the token transferable, is there a
  transfer-hook/blacklist.
- **Confirm the value at risk** at the fork block: total borrowable against the
  manipulated collateral, or the payout size of the consumer.
- **Confirm atomicity.** Manipulation must be exploitable in one transaction (or
  a bundle) — otherwise it is a market-timing strategy, not a vulnerability.

## Discriminating questions

1. Is the price read from a reserve/balance that any swap changes in the same
   block, or from a time-weighted accumulator that a single block cannot move?
2. What exactly consumes this price — borrow, mint, liquidate, settle, payout —
   and what is the maximum value that consumer exposes?
3. If the price is a TWAP, what is the window, and can the attacker sustain a
   deviated price across the whole window for less than the profit?
4. Does the consumer check staleness (`updatedAt`), round completeness
   (`answeredInRound`), positivity, and a sanity bound on the answer?
5. How much capital is needed to move the pool to the profitable price, and how
   does that compare with the profit plus fees? Is a flashloan sufficient?
6. Is the manipulated reading used for *collateral valuation of the attacker's
   own position*, which is the highest-leverage shape, or only for an unrelated
   read?
7. Can the attacker do the whole thing atomically: borrow, swap, act, unwind,
   repay?
8. Is there a second, independent price source that the consumer also checks
   (a two-oracle requirement), which would cap the manipulation?

## Common false positives

- **"Uses `getReserves()`" is not a finding.** Thousands of contracts read
  reserves safely because they only use them for a slippage bound, or because
  the pool is their own and the attacker gains nothing.
- **A TWAP that is genuinely long** and unfunded by the attacker.
- **Manipulation costs more than the profit.** Show the cost/profit numbers or
  drop it.
- **The consumer is admin-only or path-unreachable.**
- **The "price" is used for an event/log or a UI view.**
- **Stale-price findings with no exploitable consequence** (the protocol would
  revert or pause instead of mispricing).
- **A Chainlink feed with a proper heartbeat** where the "staleness" claim used
  the wrong heartbeat value.
- **Assuming infinite pool depth.** Always measure on the fork.

## What a minimal PoC must demonstrate

- On a fork at a pinned block: total value the attacker extracts in one
  transaction, in a stated unit (ETH or the borrowed token).
- The price before and after the manipulation, and the **cost** of the swap
  (fees + slippage) in the same unit.
- Net profit = extraction − manipulation cost − flashloan fee, and it must be
  strictly positive.
- The consumer call that turns the moved price into value, with the exact
  argument that depended on the price.
- A control run without the price move, showing the same call yields the
  unprofitable/zero result.
- Capital in at the start vs capital out at the end (a flashloan PoC must show
  the loan repaid).

## Impact bar

**Reportable:** a single-transaction, self-funded (or flashloan-funded) sequence
that extracts value from the protocol or a third party because the price it
trusted was moved. Include the net-profit number.

**Informational:** the price is manipulable but no consumer turns it into value,
or the manipulation costs more than it yields, or the only affected path is
admin-gated.

**Not a finding:** "the protocol reads spot reserves", by itself.
