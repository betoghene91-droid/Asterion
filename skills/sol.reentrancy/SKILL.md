# sol.reentrancy — reentrancy on a state-changing external call

Reentrancy is the class where the most money has been lost and the most noise
has been reported. Both facts matter: this skill exists to find the real ones
fast and to kill the lookalikes before they cost an afternoon.

## When this is worth hunting

Worth the time when **all three** of these are visible in the source:

1. A function that performs an external call (`call`, `transfer`, `send`,
   `safeTransfer`, `safeTransferFrom`, `safeTransferFrom` on ERC1155, a hook
   invocation, a `try/catch` around an arbitrary target, or a call into a
   user-supplied `ITarget`).
2. The call happens **before** the accounting write that the same function (or
   a sibling function) later depends on — or the accounting reads a live balance
   that the call can change.
3. There is something to take: a balance, a share ledger, a debt record, a
   reward accumulator, or a permission flag.

High-yield code shapes:

- **Vaults and aggregators** that hold user funds and call out to strategies,
  routers, or "harvest" targets.
- **ERC777 / ERC1155 / ERC721 `safeTransferFrom`** receivers: the token
  standard itself hands control back to the recipient before your bookkeeping
  settles.
- **Batch or multicall entry points**: the loop calls out per item, then writes
  totals once at the end.
- **Read-only reentrancy surfaces**: a `view` that computes a price or a share
  value from live balances, consumed by a *second* protocol in the same
  transaction. The victim is not this contract, it is whoever trusts the view.
- **Hook architectures** (Uniswap V4 hooks, ERC4626 overrides, ERC3156
  callbacks) where the hook runs mid-state-transition by design.

Waste of time when:

- Every state-touching function carries one shared `nonReentrant` mutex and the
  mutex is not bypassable through a second entry point.
- The external call is to a fixed, immutable, audited contract with no callback
  (a hardcoded WETH, a hardcoded Chainlink aggregator, a `staticcall` to a
  known oracle).
- The only "reentry" possible is the attacker re-entering to spend **their own**
  already-credited balance.
- The function is `view`/`pure` and nothing else in the system reads its
  intermediate state.
- Solidity ≥0.8 with no assembly: arithmetic is checked, so the classic
  "underflow on second withdrawal" variant needs an `unchecked` block to exist.

## How to confirm it is even reachable

Before writing a single line of Solidity:

- **Who can call the entry point?** If it is `onlyRole(...)`, the reentrancy is
  a privileged-trust issue, not an external attack. Check every modifier on the
  path, including inherited ones.
- **Is the attacker the caller, or the callee?** Reentrancy needs the attacker
  on one side of the call. If both the caller and the callee are fixed protocol
  contracts, there is no hook to exploit.
- **Does the called address come from calldata, storage the attacker wrote, or
  a constant?** A `target` read from a user-supplied parameter is the strongest
  signal in the whole class.
- **Is value actually at risk** at the fork block? A vault holding 0 wei is not
  a finding; check the balance on the fork, not in the abstract.
- **Is the transaction atomic with the profit?** If profit only materialises
  across two blocks, it is not reentrancy any more — it is a different class
  with different preconditions.

## Discriminating questions

1. Does the external call execute **before** the storage write that the same
   path later reads — or is the write strictly before the call (CEI holds)?
2. Is the called address attacker-controlled (calldata, attacker-written
   storage, a token the attacker deploys) or a fixed immutable/constant?
3. Which state does the callback actually reach: the same function (classic), a
   sibling function sharing the same accounting (cross-function), or only a
   `view` a third party trusts (read-only)?
4. When the re-entrant call returns, does the outer frame read a value that the
   inner frame changed — or does it use a value cached before the call?
5. Does the accounting derive from `address(this).balance` /
   `token.balanceOf(address(this))`, or from an internal ledger that a reentry
   cannot move?
6. Is there one mutex covering **every** function that touches the shared
   state, or only the obvious `withdraw`? List the other functions that read
   the same slot.
7. Are shares minted before the deposit transfer settles, or burned after the
   withdrawal transfer is attempted?
8. If a token hook is involved (777 `tokensToSend`, 1155 `onERC1155Received`,
   721 `onERC721Received`), is the hook invoked while the sender's balance is
   still un-debited?

## Common false positives

Be honest about these; they are the majority of what a reentrancy grep returns.

- **The mutex is present but named unusually** (`lock`, `entered`, a
  `ReentrancyGuard` base, a `locked` bool). Read the modifier body before
  reporting.
- **The call is after the write** and the diff only looked at line order inside
  a helper.
- **Reentry only harms the attacker.** Draining your own credited balance is
  not a bug; sending it twice is.
- **The contract holds nothing.** A reentrancy in a freshly deployed, empty
  contract with no deposits at the fork block has no impact today.
- **`transfer()` / `send()` with 2300 gas.** The stipend prevents a meaningful
  callback in almost all cases; `call{value:}` with forwarded gas does not.
- **The reentry reverts and the whole tx reverts.** That is griefing or a
  self-DoS, not value extraction.
- **A `staticcall` into an attacker contract.** It cannot mutate your storage;
  only the return value matters, which is an oracle/validation question.
- **Cross-function claims where the two functions do not share a slot.** Prove
  the shared write, do not assume "both are in the vault".

## What a minimal PoC must demonstrate

A fork test with two runs — the attack and a control — reporting **numbers**:

- Attacker's balance before and after, in the same transaction (or the same
  block if atomicity requires a bundle), and the **delta**.
- The same delta measured against a control where the re-entry is disabled
  (e.g. attacker contract does not re-enter): the difference is what the bug
  actually bought, and it must be positive.
- The protocol's or a victim's balance before and after, showing a
  corresponding loss — a "profit" that comes from nowhere is a measurement bug.
- The exact call sequence in the trace: outer entry → external call → inner
  entry → return → outer continues with stale state.
- Confirmation that capital in was not greater than capital out (no
  self-funded "profit"), and that no privileged role was used.

## Impact bar

**Reportable:** the reentry lets an unprivileged account take value it did not
deposit, or permanently locks/freezes funds that a legitimate user could
withdraw. Quantify it: "attacker deposits 1 wei, withdraws X" is the sentence.

**Informational:** gas-only griefing, self-DoS, reentry that requires an
already-privileged role, or a stale read that no consumer trusts.

**Not a finding:** reentry into a function whose only effect is on the caller's
own accounting, with no cross-user or protocol loss.
