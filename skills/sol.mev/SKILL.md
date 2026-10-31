# sol.mev - MEV-extractable ordering: sandwich, backrun, JIT liquidity

MEV is not a defect in the contract. It is a property of how the contract's
transactions are ordered against a public mempool. Judge it as a revenue stream a
generalised attacker can farm at the protocol's expense, not as a user mistake.

The distinction matters, because a user who sets 50% slippage has not found a
protocol bug. A protocol whose own rebalance has no slippage bound has.

## When this is worth hunting

- Swaps where `minAmountOut` / `maxAmountIn` is derived from a stale quote, or is
  set to zero, or is set from a value the transaction itself can move.
- Protocol-internal rebalances, harvests, or oracle pushes callable in the same
  block as the price they depend on.
- Liquidation paths where the price move and the liquidation can be bundled into
  one bundle by a searcher who is not the liquidator.
- JIT liquidity: a concentrated position added immediately before a known large
  swap and removed immediately after, capturing the fee with no inventory risk.
- Deadline arguments that are the block timestamp or a far-future constant, which
  removes the only other defence against a delayed inclusion.

## How to confirm it is even reachable

Two measurements decide it: the pool depth, and the size of the trade whose
ordering can be exploited. A sandwich needs the price impact to be large enough
that front-running costs less than the extracted difference, after the pool fee
and gas are paid.

If the transaction path is private (Flashbots Protect, MEV-Share, a private RPC,
a sequencer with no public mempool), the ordering cannot be observed or raced.
That is a real answer: not a finding, and worth stating.

If the protocol consumes a TWAP whose window exceeds one block, a single-block
move cannot shift the price it acts on, and the ordering attack has nothing to
buy.

## Discriminating questions

The pack's `questions` array is the ordered set. The slippage question comes
first: it is one read, and a tight bound ends the investigation immediately.

## Common false positives

- Slippage tight enough that the sandwich is unprofitable after fees at observed
  depth. Most well-configured pools land here.
- The swap is routed through a private mempool and cannot be front-run at all.
- Pool depth means the price impact required costs more than the extractable
  amount, which is the normal case on major pairs.
- The protocol consumes a TWAP the single-block move cannot shift.
- The only cost bearer is the swapping user's own slippage setting, which is a
  user choice, not a protocol exposure.

## What a minimal PoC must demonstrate

- Front-run, victim, and back-run simulated in one block, with the attacker delta
  measured before and after.
- Gas and pool fee deducted, so the figure is net rather than gross.
- A control run of the victim swap alone in the same block, for comparison.
- The victim's loss stated alongside the attacker's gain, because that is where
  the value came from and it is what makes the number attributable.

## Impact bar

Reportable as a protocol-level MEV exposure when a generalised attacker profits
net of fees at observed depth, and the protocol's own transaction is what is
being raced. Informational when the exposure is small enough that gas dominates,
or when the only affected party is a user who chose a wide slippage setting.
