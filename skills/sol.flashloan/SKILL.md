# sol.flashloan — flashloan-amplified invariant break

Weight 1.167 over 706 findings — the smallest sample of the Solidity classes but
the second-highest weight per finding. The signal is real: when a flashloan is
what turns a small accounting error into a drain, the finding is usually severe
and the PoC is unambiguous.

Important framing: **flashloan is not a bug class.** It is an amplification
technique. This skill exists to decide whether some other defect (oracle,
rounding, invariant, access control) is amplifiable to a profitable,
zero-capital attack — and to reject the reports that just say "flashloan can be
used".

## When this is worth hunting

Worth the time when you already have a **primitive that is unprofitable at small
size but profitable at large size**, and the size can be borrowed:

- A rounding or fee error bounded by a constant per operation, where N
  operations scale with capital rather than with gas.
- An oracle or reserve reading that is only movable by an amount of capital that
  a flashloan supplies.
- A liquidation or auction path where being able to repay a huge debt instantly
  makes a marginal bonus profitable.
- An invariant that breaks only above a threshold (a cap, a tier, a
  utilization band) that borrowed size crosses.
- A reward/fee accrual that pays out in the same transaction it accrues in.
- A deposit-then-withdraw path where the protocol's own accounting gives a
  bonus that does not depend on holding time.
- Sandwichable/atomic arbitrage against the protocol's own pricing (which is a
  design decision unless the protocol's users lose).

Waste of time when:

- The primitive needs the attacker to **hold** the position across blocks (then
  a flashloan does not help — that is a capital cost, not a flashloan attack).
- Profit comes from a plain oracle spot-price move and the pool is deep enough
  that the required size exceeds every lender's liquidity on that chain.
- The protocol charges a fee on the borrowed-asset round-trip that exceeds the
  edge.
- The "flashloan attack" is really just arbitrage between two public pools, with
  no protocol loss.
- The lender's callback (`onFlashLoan`) cannot be re-entered into the target
  because the target has a per-block guard or a cooldown (a rebasing or
  epoch-based design).

## How to confirm it is even reachable

- **Name the lender.** A flashloan PoC needs an actual lender with liquidity on
  that chain at that block: Aave V3 pool, Balancer Vault, Uniswap V3
  `flash()`, Morpho, or a project-specific one. Confirm the asset and the
  available amount at the fork block.
- **Confirm the fee.** Aave V3 is 5 bps (governance-adjustable); Balancer is
  usually 0; Uniswap V3 uses the pool fee tier. Net profit must survive it.
- **Confirm the target accepts the borrowed asset** and that the capital can be
  routed into the vulnerable path in one transaction.
- **Confirm the vulnerable path is not guarded per-block** (`lastUpdate ==
  block.number` checks, `block.number` cooldowns, `nonReentrant` across the
  flashloan callback).
- **Confirm the profit stays in the attacker's hands after repayment** — a PoC
  must repay the loan inside the same transaction.
- **Check that the protocol's loss is real and not just a transfer from another
  arbitrageur.**

## Discriminating questions

1. What is the underlying primitive, and at what size does it become profitable —
   is the threshold below the lender's available liquidity?
2. Does the primitive require holding a position across blocks, or can the whole
   sequence complete inside the loan callback?
3. Which lender supplies the capital, and what is its fee — does the net profit
   survive it plus swap fees?
4. Is the vulnerable path protected by a per-block, per-epoch, or cooldown guard
   that a single-transaction attack cannot satisfy?
5. Does the protocol's accounting pay out based on a value the same transaction
   just changed (a live balance, a reserve, a share price)?
6. Is the profit taken from the protocol or from another user, or is it merely
   from a third-party pool (which is arbitrage, not a vulnerability)?
7. Can the attacker repay the loan and keep a positive balance in the same
   transaction — and does the PoC show the repayment, not just the borrow?
8. If the asset must be swapped mid-attack, does the swap itself move the price
   the protocol trusts (compounding) or does it neutralise it?

## Common false positives

- **"Flashloan can be used to…" with no profit number.** The single most common
  failure. A borrow-and-return with no net gain is a proof of nothing.
- **Profit that comes from a public AMM and not from the protocol.** That is an
  arbitrage opportunity; reportable only if the protocol's users lose.
- **A primitive that requires the position to persist.** Flashloans do not extend
  across blocks.
- **Fees exceed the edge**: 5 bps of a huge notional can be larger than a
  rounding bug's yield.
- **Liquidity not actually available** at the fork block for that asset; the PoC
  borrows an amount no pool holds.
- **The path reverts under the loan callback** because of a same-block guard the
  report did not read.
- **Self-funded "zero capital" claims** where the test seeds the attacker with
  the capital it claims was borrowed.
- **A liquidation-bonus observation** where the profit is exactly the intended
  bonus — that is the design working.

## What a minimal PoC must demonstrate

- The lender, the asset, the borrowed amount, and the **actual fee charged**, all
  printed.
- Capital in from the lender at the start of the transaction, and the repayment
  at the end, with the attacker balance delta after repayment — must be strictly
  positive.
- The vulnerable step, isolated: run the same sequence with **unborrowed,
  small capital** and show the delta is ≤ 0 (or below gas). This control is what
  turns "a flashloan was involved" into "a flashloan was necessary".
- The protocol's or victim's loss, measured in the same unit, so the profit has a
  source.
- The fee breakdown: loan fee + swap fees + gas, subtracted from gross.
- No privileged role and no pre-seeded balance for the attacker.

## Impact bar

**Reportable:** a zero-capital, single-transaction sequence that extracts value
from the protocol or its users and nets positive after all fees, with the
necessity of the loan demonstrated by a control run. Quantify gross, fees, net.

**Informational:** the sequence works only with the attacker's own capital, or
net profit is negative after fees, or the gain is third-party arbitrage with no
protocol loss.

**Not a finding:** "this protocol interacts with flashloan-capable pools".
