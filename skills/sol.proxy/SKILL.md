# sol.proxy - proxy and storage-collision defects

Upgradeability is where a contract's storage layout becomes an attack surface.
`sol.upgrade` covers the upgrade path itself. This pack covers the architecture
around it: the slots, the initializers, and the layouts that decide what an
upgrade actually means.

A proxy works because `delegatecall` runs the implementation's code against the
proxy's storage. That single sentence is the whole bug class: any disagreement
about slot numbers between the two contracts is a memory-safety bug in Solidity.

## When this is worth hunting

- A custom proxy using a slot that is not the EIP-1967 constant
  (`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` for the
  implementation, `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`
  for the admin). A hand-rolled slot near slot 0 can collide with the
  implementation's own first variable.
- An implementation contract left uninitialized. Anyone can call `initialize()`
  on the logic contract directly and become its owner. The proxy is unaffected,
  but if the implementation has any self-contained value or is used by a
  beacon, that ownership matters.
- A diamond (EIP-2535) whose facets use free-form storage instead of diamond
  storage. Facets sharing slot 0 collide with each other.
- An inheritance order that puts a proxy's admin variable over an implementation
  variable at the same slot.
- A beacon whose owner is an EOA with no timelock, so the beacon can be repointed
  in one transaction.

## How to confirm it is even reachable

Read the implementation slot and the admin slot from storage directly, do not
trust the contract's own getter. A getter can return a value from a different
slot than the one `delegatecall` reads, and that gap is itself the bug.

Then check whether the implementation address accepts a direct call. An
uninitialized implementation usually does.

If the proxy is behind a timelock with a real delay and a multisig, the collision
still exists but the exploitation window is governance-gated. Say which.

## Discriminating questions

The pack's `questions` array is the ordered set. The slot question comes first:
if the canonical EIP-1967 slot is used, a layout collision is not possible and
the investigation narrows to initializers.

## Common false positives

- OpenZeppelin's upgrades plugin validated the layout, and the artifact proves it.
- The implementation is immutable post-deploy and cannot be initialized again.
- The custom slot is a keccak-derived constant, far outside any layout range.
- The beacon is owned by a timelock with a real delay and a multisig threshold.
- The collision exists but no code path reads or writes the colliding variable,
  which makes it a latent defect rather than an exploitable one.

## What a minimal PoC must demonstrate

- The two storage reads that collide, printed with their actual slot numbers.
- The resulting corrupted value an attacker can set, or read from another
  account, demonstrated on a fork.
- A control read showing the value before corruption, same block.
- The role used, named explicitly, when a role is needed at all.

## Impact bar

Reportable when a collision or an unguarded implementation initializer lets an
unprivileged caller change privileged state, or read or write another account's
storage, with the effect demonstrated. Informational when the pattern is merely
unusual, when the colliding variable is unread, or when exploitation needs a
role the attacker already holds.
