# sol.delegatecall — arbitrary delegatecall / unchecked target

Lowest corpus weight of all (0.535 over 3,832 findings). The reason is honest:
`delegatecall` appears constantly in safe, deliberate code, and most reports are
"delegatecall is dangerous". The exploitable subset is narrow — a target the
attacker can choose, or a target chosen from data the attacker can poison.

## When this is worth hunting

Worth the time when **the target of the `delegatecall` is attacker-influenced**:

- A `delegatecall` whose target comes from **calldata** (`bytes target`,
  `address impl`, an `Operation` struct signed by someone else) and where the
  caller can supply it.
- A multicall/executor (`execute`, `batch`, `forward`, `_call`) that takes a list
  of targets and delegates — a "trusted" forwarder whose only check is that
  `msg.sender` is a module, where any module can be tricked or where the module
  set is attacker-reachable.
- A library pattern using `delegatecall` to a **user-supplied** implementation
  (the "diamond" / "facet" / "plugin" arch) where cuts are not authority-checked.
- A proxy whose implementation slot is set by a function with a check on the
  wrong subject, or where the implementation can be set to a contract with a
  function that self-destructs / writes `owner`.
- `delegatecall` inside a loop over an attacker-growable array of targets.
- `delegatecall` where the **returndata is ignored** and the call is checked only
  for low-level success — an unchecked revert hides a failed privileged action.

Waste of time when:

- The target is an immutable/constant address, or a `library` linked at compile
  time (`using Lib for T` with internal functions — no delegatecall at all in
  most cases).
- The target is a storage slot only an admin can write, with a timelock.
- It is a proxy with a standard, audited pattern (ERC1967 + `_authorizeUpgrade`
  with a real authority) and the report is about the pattern itself.
- The delegatecall target is derived from `address(this)` or a fixed
  factory-deployed registry.
- The contract holds nothing and grants nothing (a router with no storage).

## How to confirm it is even reachable

- **Trace the target variable to its source.** Attacker-supplied calldata is the
  finding; `onlyOwner`-set storage is not. Walk the assignment chain; do not stop
  at the local variable.
- **Enumerate who can call the function that performs the delegatecall.** A
  `delegatecall` behind `onlyRole(EXECUTOR)` where EXECUTOR is a fixed module is
  a trust question; the same with `EXECUTOR` grantable by anyone is a finding.
- **Determine what storage the delegatecall can write.** Because
  `delegatecall` runs in *your* storage context, the impact is exactly the set of
  slots the called code writes. Find whether any of them are `owner`,
  `implementation`, `paused`, a balance ledger, or a token allowance.
- **Check for the self-destruct / storage-wipe variant** — an
  attacker-chosen target whose code writes slot 0 (commonly the owner) is the
  classic one-transaction takeover.
- **Confirm the contract holds value or authority** at the fork block.

## Discriminating questions

1. Does the `delegatecall` target come from calldata, an attacker-writable
   storage slot, or a constant/admin-only slot? Trace it to the source.
2. Who can reach the function performing the delegatecall, and can that authority
   be granted or transferred by an unprivileged account?
3. Which storage slots does the called code write in the caller's context, and is
   any of them `owner`, `implementation`, `paused`, a balance, or an allowance?
4. Is the `delegatecall` inside a loop over an attacker-growable list of targets?
5. Are the call's success and the returndata both checked, or only the low-level
   boolean, hiding a failed privileged write?
6. Does the target receive the caller's `msg.sender` and `msg.value` unchanged,
   letting attacker code act with the caller's authority and balance?
7. Is the called code required to be a whitelisted implementation, and is that
   whitelist modifiable by the same actor who supplies the target?
8. For a proxy variant: is `_authorizeUpgrade` implemented, and does it check an
   authority rather than a slot the caller can write?

## Common false positives

- **Library `delegatecall`s emitted by the compiler** for external library
  functions where the linked address is fixed at deploy time.
- **A proxy with a correct, audited `_authorizeUpgrade`.** The pattern is not a
  bug; the missing check would be.
- **Admin-controlled implementation, timelocked**, reported as arbitrary
  delegatecall.
- **An internal helper named `_delegate`** that never actually uses the opcode
  (it calls a fixed address).
- **A target read from a factory registry the attacker cannot write.**
- **The contract has no privileged storage to overwrite** — an executor with no
  `owner` slot and no balance.
- **A delegatecall to a contract the attacker must deploy and whitelist first**,
  when whitelisting is admin-only.
- **Reports that ignore context**: the same opcode in a `staticcall`-only path or
  behind a `view` cannot mutate storage.

## What a minimal PoC must demonstrate

- An attacker contract whose function writes the victim's `owner` slot (or the
  target slot) to the attacker address.
- The unprivileged call that supplies that contract as the delegatecall target,
  and the transaction succeeding.
- The post-state read from the **caller's** storage: `owner() == attacker`, or
  the implementation slot now pointing at the attacker contract.
- For the token-allowance variant: the allowance delta an attacker gained.
- A control run where the target is restricted (whitelisted / admin-set) and the
  same attacker contract is rejected — proving the check, not the opcode, is the
  difference.

## Impact bar

**Reportable:** an unprivileged caller controls the delegatecall target and can
write privileged storage, become owner, replace the implementation, or move
funds. Takeover of the contract is the sentence.

**Informational:** the target is admin-controlled with a timelock, or the
delegatecall can only write non-privileged storage, or only the caller's own
position is affected.

**Not a finding:** "this contract contains `delegatecall`".
