# sol.dos — denial of service via unbounded loop or revert-on-push

6,837 corpus findings but the second-lowest weight of the Solidity classes
(0.797) and the lowest severe ratio of the big families. That is the honest
signal: most DoS reports are "this loop could theoretically grow" and get paid at
low severity or not at all. This skill is mostly a **filter**.

## When this is worth hunting

Worth the time when a user-controlled collection is iterated **and** an
unprivileged account can make the iteration unbounded or make it revert:

- A loop over an array that an external function **pushes to** (holders,
  whitelist, pending list, watchers, reward recipients, `_allTokens`), called
  from a function other users depend on (`distribute`, `harvest`, `snapshot`,
  `liquidate`, `claim`).
- A push-payment loop: `for (...) payable(recipients[i]).transfer(...)` where one
  reverting or gas-greedy recipient blocks everyone.
- A loop over an array where the attacker can add entries at low cost and can
  never be removed (no `remove`, or removal requires the attacker's signature).
- An `onlyOwner`-less `addRecipient`/`register`/`setApprover` that grows a list
  the protocol later iterates with no cap.
- Recursive or chained external calls (`for` over delegates, a linked list walk)
  where a single attacker entry can point at a contract that consumes all gas.
- `token.transfer` inside a loop over holders where one blacklisted holder
  reverts the whole distribution.

Waste of time when:

- The array is `onlyOwner`-growable and bounded by a `require(length <= N)`.
- The push is permissioned and removal is available.
- The loop is a `view` — a reverting view costs nobody funds.
- Gas is cheap relative to the value the function moves, and the array has a
  hard cap well below the block gas limit.
- There is a paginated variant (`processBatch(start, end)`) the protocol actually
  uses.
- The "DoS" is a temporary revert the admin can fix by calling a setter — that is
  an operational note, not a vulnerability, unless the admin action itself is
  blocked.

## How to confirm it is even reachable

- **Who can push, and at what cost?** A `register()` open to anyone with no fee
  is the exploitable shape; a `register()` behind `onlyOwner` is not.
- **Can the entry be removed?** Read the removal path. If only the entry's owner
  can remove it, an attacker never removes it — that is the attack.
- **What breaks when the loop reverts?** Name the function that becomes
  uncallable and who depended on it: withdrawals, liquidations, reward claims,
  or an oracle update that other contracts read.
- **Is the caller paying the gas?** If the attacker must pay to call the doomed
  function, they are griefing themselves. DoS matters when a *victim's*
  transaction is what reverts.
- **Can the affected function be bypassed?** A `withdraw` that also exists as
  `withdrawSingle(index)` is not blocked.
- **Estimate the block gas limit at the fork block** and the gas per iteration.
  Numbers, not adjectives.

## Discriminating questions

1. Can an unprivileged account grow the array the loop iterates, and is there a
   cap (`require(length <= N)`) or a fee that makes unbounded growth expensive?
2. Once added, can the entry be removed by anyone other than the attacker, or
   does the attacker hold it hostage forever?
3. Which victim function becomes uncallable when the loop reverts, and does that
   block withdrawals, liquidations, or claims that users depend on?
4. Is there a paginated or single-item alternative path that bypasses the loop
   entirely?
5. In a push-payment loop, can one recipient revert (a contract that reverts in
   `receive`, a blacklisted address, a gas-hungry `receive`) and block all
   others?
6. What is the gas cost per iteration, and how many entries push the total past
   the block gas limit — is that count reachable at a sane cost?
7. Does the loop write storage per iteration (SSTORE), which multiplies the gas
   per entry by roughly 20,000 and makes the attack far cheaper to mount?
8. Is the reverting condition permanent, or can the admin/protocol clear it —
   and if they can, is the clear itself blocked by the same loop?

## Common false positives

- **An attacker-paid revert.** The attacker calls a function that reverts for
  them; nobody is harmed.
- **The array is owner-growable and capped.**
- **A `view` loop.** Convenience only.
- **A temporary griefing state the protocol can clear** with one admin
  transaction, when the report claims "permanent DoS".
- **Theoretically unbounded but economically impossible**: pushing 50,000 entries
  costs more than the protocol holds.
- **`for` over a fixed-size constant array** or over `block.timestamp`-derived
  bounded ranges.
- **Claims that ignore the gas refund / calldata cost**, making the estimated
  attack price off by orders of magnitude.
- **A loop over an array that only the protocol's own trusted contracts push to.**

## What a minimal PoC must demonstrate

- The growth step: the attacker's calls that add N entries, with the **actual
  gas cost** of those calls in the test output.
- The victim call reverting — with the revert reason being out-of-gas, and the
  gas measurement showing it exceeded the block gas limit (or the function's own
  gas budget).
- A control run with N−k entries where the victim call succeeds, proving the
  threshold.
- For push-payment: one recipient contract that reverts in `receive`, and the
  resulting whole-distribution revert, with other recipients' balances unchanged.
- The state of the protocol while blocked: which balances are stuck and for
  whom.

## Impact bar

**Reportable:** value or function is permanently blocked for users who did
nothing wrong, and the block cannot be lifted by a normal admin action. Locks
funds, blocks liquidations (which can cause bad debt), or freezes claims.

**Low / informational:** temporary griefing, an attacker-funded state that the
protocol can clear, a `view` DoS, or a theoretical growth nobody can afford.

**Not a finding:** "this loop is unbounded" with no reachable growth path and no
named victim function.
