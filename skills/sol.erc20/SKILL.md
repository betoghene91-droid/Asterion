# sol.erc20 - non-standard ERC-20 behaviour

Every protocol that says "we integrate USDC" is one token away from this class.
The bug is always the same sentence: the protocol assumes `received == sent`.

The ERC-20 standard is a suggestion. Tokens in production take fees on transfer,
rebase every block, return nothing from `transfer`, call hooks mid-transfer, and
blocklist addresses. A protocol written against one token's behaviour breaks on
the next one it integrates.

## When this is worth hunting

- Any integration where the token is not a protocol-controlled immutable. If the
  token address is set by an admin, by governance, or by the user, the semantics
  are not guaranteed.
- `transfer` / `transferFrom` return value unchecked, or a raw `transfer` call
  rather than `safeTransfer`. USDT returns nothing, so the check reverts on a
  correct token and passes on a lying one.
- Accounting from the requested amount instead of the measured balance delta.
  This is the single most common form.
- ERC777 / ERC1363 hooks, which hand control back to the recipient mid-transfer.
  That is a reentrancy surface the protocol may not have considered.
- Blocklist-capable tokens, where a transfer can revert and strand funds in a
  contract with no other exit.
- Rebasing tokens, where a stored balance drifts from the real one over time.

The high-yield shape is a lending market or vault that credits `amount` on
deposit for a fee-on-transfer token. The first withdrawer takes more than they
put in. The last one cannot withdraw at all, because the pool is short by the
sum of every fee taken. That is a real insolvency with a real victim.

## How to confirm it is even reachable

Two reads: what the token actually does on transfer, and what the protocol credits.
If the protocol measures `balanceOf` before and after and credits the delta, it is
correct for every token on this list and the class is closed for that pool.

If the token is upgradeable or admin-configurable, the semantics can change under
a live protocol. That is worth noting, because a correct integration today is not
a correct integration after the next token upgrade.

## Discriminating questions

The pack's `questions` array is the ordered set. The credited-vs-measured
question comes first: it is one read at the deposit site and it decides the class.

## Common false positives

- The protocol measures the balance delta, which is correct for all of these at
  once, and closes the class for that pool.
- The token is a known-standard immutable with no fee, no hook, no blocklist, and
  no rebase. Then there is nothing to exploit.
- `safeTransfer` is used everywhere, so a missing return cannot silently pass.
- The rebase is positive-only and the protocol reads only its own ledger, so the
  drift never affects a withdrawal amount.
- The token is fee-on-transfer but the fee rounds to zero at the sizes the
  protocol actually handles.

## What a minimal PoC must demonstrate

- A deposit where the credited amount and the received amount are both printed
  and demonstrably differ.
- The resulting position or share count that is now wrong because of it.
- A control run with a standard token at the same amount, same code path.
- The eventual loss or insolvency path, quantified, with the last withdrawer's
  shortfall named as the victim.

## Impact bar

Reportable when the mismatch creates a withdrawable amount exceeding what was
deposited, or strands funds with no exit, quantified per token. Informational for
a token the protocol does not actually integrate, or a fee that rounds to zero at
every reachable size.
