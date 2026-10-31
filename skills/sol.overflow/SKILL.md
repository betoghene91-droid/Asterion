# sol.overflow - arithmetic overflow, underflow, and unchecked casts

Solidity 0.8 made checked arithmetic the default, which moved most of this class
into one narrow place: `unchecked { }`. Everything outside that block is a
downcast. Truncation never reverts, so it is silent by construction.

## When this is worth hunting

Worth the time when any one of these is visible in the source:

- Pragma below 0.8.0, and arithmetic on a value field that SafeMath does not wrap.
  Half-migrated code is the common shape: SafeMath on the balance, raw `-` on the
  fee accumulator three lines down.
- A 0.8.0+ contract with `unchecked` around anything that reaches a balance,
  debt, share count, price, timestamp delta, or loop bound.
- A narrowing cast: `uint256 -> uint128/uint96/uint64/uint32/uint16/uint8`,
  `int256 -> int128`, or `uint -> int`. Every one of these is silent truncation.
- A rate or percentage computed as `(a * b) / c` where `a * b` can exceed
  uint256 for reachable inputs.

The high-yield shape, in practice, is a downcast of an oracle answer or a
user-supplied amount straight into storage. Chainlink answers are `int256`. A
protocol that casts to `uint96` without a bounds check has lost precision before
any attacker touches it, and the loss compounds on every read after that.

A second high-yield shape is `unchecked` used as a gas optimisation in a loop
that decrements a user-controlled counter. If the counter can be zero at entry,
`i--` wraps to `type(uint256).max` and the loop becomes effectively infinite: an
out-of-gas denial rather than a value theft.

## How to confirm it is even reachable

The wrapped or truncated value must be reachable from an unprivileged entry
point, and it must feed accounting the contract later honours. Two reads settle
it: the arithmetic site, and every consumer of the result. If the only consumer
is a `view` that a frontend prints, this is a display bug.

If the boundary value cannot be produced by any caller in the test window, the
primitive exists and the consequence does not. Say that, do not inflate it.

## Discriminating questions

The pack's `questions` array is the ordered set. The first one that separates the
real case from the lookalike is the one to answer first. In practice that is
almost always the pragma-and-SafeMath question, because a fully checked codebase
answers it in one line and ends the investigation.

## Common false positives

- The pragma is 0.8.0 or later and the block is not `unchecked`, so the compiler
  reverts. This kills most of the class on modern code.
- SafeMath wraps every arithmetic site that touches the variable, not just some.
- The cast is guarded by a prior bounds check the same value provably cannot
  violate, because the bound comes from the same source as the value.
- The wrapped value is only a display column, a log field, or a revert message.
- Reaching the boundary needs a supply or a balance the token cannot reach.

## What a minimal PoC must demonstrate

- A before/after balance delta on a fork that moves in the attacker's favour.
- A control run at a non-boundary value, showing the honest result.
- The exact operand pair that wraps or truncates, printed with both values.
- No privileged role used, and capital out no greater than capital in.

## Impact bar

Reportable when the wrap or truncation moves real value to an unprivileged
caller, with the amount quantified. Informational when the wrap is reachable only
by an already-privileged role, when it produces a denial rather than a theft with
no funds at risk, or when the value is a display field nothing reads.
