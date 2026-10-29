# sol.rounding — accounting / rounding / precision loss

8,175 corpus findings — the largest accounting class. Most are informational
dust; a minority compound into real theft. This skill is about telling those
two apart, which is almost entirely a question of **who can trigger the
operation repeatedly and in which direction the error runs**.

## When this is worth hunting

Worth the time when math truncates in a direction that **favours the actor who
controls the inputs**, and that actor can repeat the operation:

- `mulDiv` / `a * b / c` in a share or debt conversion, where the result is
  rounded down for the protocol and the caller keeps the remainder.
- Share/asset conversion done twice with two different roundings (`previewRedeem`
  rounds down, but the actual `redeem` path rounds in the caller's favour).
- Fee-on-transfer or rebasing tokens mixed with a `balanceOf` accounting that
  assumes the amount sent equals the amount received.
- Interest accrual (`borrowIndex`, `rate * dt`) where the truncation is per
  block or per second and the borrower can force many tiny accruals.
- Liquidation bonus math where a dust-sized liquidation is profitable.
- `uint128`/`uint64` casts of scaled values, or division before multiplication
  (the classic `(a / b) * c` losing precision before it matters).
- Decimal mismatches: 6-decimal and 18-decimal tokens in one formula without
  scaling, or a `1e18` constant applied to a 6-decimal asset.

Waste of time when:

- The error is bounded by 1 wei per operation **and** the operation costs more
  gas than 1 wei is worth, with no way to amortise.
- Rounding always favours the protocol (round-down for the withdrawer,
  round-up for the debtor) in every path.
- The token is fixed to 18 decimals with no rebase and no fee-on-transfer.
- The value is a `view` output only.

## How to confirm it is even reachable

- **Find the rounding call site and the direction.** `Math.Rounding.Down` for a
  withdrawer means the withdrawer loses dust; `Down` for a depositor's shares
  means the depositor loses dust. Which side of the trade is the attacker on?
- **Give the attacker control of the magnitude.** Dust attacks need the
  attacker to set the small number: deposit amount, repay amount, liquidation
  amount, tick size. A rounding bug where only the protocol sets the amount is
  usually not exploitable.
- **Count the repetitions available.** A 1-wei leak per call is worth nothing;
  10,000 calls per block across a rebasing loop is worth something. Check
  whether a batch/multicall path amortises gas.
- **Check whether the pool has a minimum size** (`MIN_DEPOSIT`, dead shares,
  `require(shares > 0)`). A `require(shares > 0)` kills the classic
  zero-share attack.
- **Confirm value at risk** — the total assets in the accounting domain, not the
  token supply of the whole chain.

## Discriminating questions

1. Which direction does the truncation run, and is the party that keeps the
   remainder the attacker or the protocol, in **every** path that reaches it?
2. Can the attacker choose the small magnitude (deposit/repay/liquidate
   amount), or is it fixed by the protocol?
3. How many times can the operation be repeated per unit of gas, and is there a
   batch entry point that amortises the cost of each leak?
4. Is there a `require(shares > 0)` / minimum-deposit / dead-share guard that
   prevents the zero-value outcome?
5. Are `preview*` and the executing function using the *same* rounding direction,
   or does the preview lie in the attacker's favour?
6. Does the formula divide before it multiplies anywhere, and can the lost
   precision be made large relative to the output?
7. Are all token decimals accounted for, and is any token fee-on-transfer or
   rebasing, which makes `amount == received` false?
8. Does the accumulator (interest index, reward-per-share) use a precision
   multiplier large enough that per-block truncation cannot be forced repeatedly
   by the borrower?

## Common false positives

- **Dust that costs more to harvest than it is worth**, with no batch path.
- **Rounding that favours the protocol** in the direction that matters.
- **A `require(shares > 0)`** already present, which blocks the zero-share case.
- **"Loses 1 wei"** with no repetition and no amplification — this is a code
  cleanliness note at best.
- **Precision loss in a `view`** that no state-changing function trusts.
- **Imaginary division-before-multiplication** where the operands make the loss
  provably zero (e.g. `a` is always a multiple of `b`).
- **Rebasing-token concerns on a token the protocol hardcodes as non-rebasing**,
  where the token contract cannot rebase.
- **Fee-on-transfer claims** where the token is a standard fixed-supply ERC20.

## What a minimal PoC must demonstrate

- A fork or unit test with the **exact rounding site** exercised, printing the
  intermediate values (numerator, denominator, truncated result).
- The attacker's net position over **N repetitions**, with N stated and gas cost
  subtracted, so the number is a real profit and not a per-op rounding artefact.
- The counterparty's (protocol or another user's) loss over the same N.
- A control run with the rounding direction flipped, showing the leak disappears
  — this proves the direction is the cause.
- For the fee-on-transfer variant: the token's actual received amount versus
  the amount recorded, with the discrepancy.

## Impact bar

**Reportable:** a repeatable, gas-profitable extraction from other users or the
protocol, or a permanent accounting drift that makes some operation fail
(insolvency, an un-withdrawable position). Quantify total profit after gas.

**Informational:** a genuine rounding asymmetry with no profitable repetition,
or a loss bounded to dust per user with no amplification.

**Not a finding:** "uses integer division" or "truncates" with no direction
analysis and no measured consequence.
