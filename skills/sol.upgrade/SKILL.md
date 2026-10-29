# sol.upgrade — unsafe upgrade / storage collision

Lowest-weight Solidity class in the corpus (0.651 over 3,664 findings) because
most upgrade findings are architectural notes. The ones that pay are
**uninitialized implementations** and **unguarded upgrade authority**, not
"storage layout could collide someday".

## When this is worth hunting

Worth the time when a proxy is in play and one of these is true:

- The **implementation contract** (not the proxy) has an `initialize()` or
  `reinitialize()` with no `_disableInitializers()` in its constructor, so anyone
  can call it directly at the implementation address and take ownership.
- `upgradeTo` / `upgradeToAndCall` / `setImplementation` is callable by a
  non-admin: no modifier, a `tx.origin` check, or a check on a slot the caller
  can write.
- The **storage layout changes** across versions in a way that shifts a variable
  into a slot an existing value occupies — a new base contract inserted in the
  middle of the inheritance chain, a variable reordered, a type narrowed
  (`uint256` → `uint128`) so a neighbour packs into the freed space.
- `__gap` arrays were *shrunk* or reused without compensating, in a contract that
  expects future upgrades.
- Initializer front-running: `initialize` is external and the deploy script does
  not run in the same transaction as the proxy deployment.
- An upgrade path with **no timelock** where the report can show user funds at
  risk within one block (this is a design critique unless the scope excludes
  admin actions — check the program's rules first).

Waste of time when:

- The implementation is a non-upgradeable contract that merely *contains* the
  word "initialize".
- `_disableInitializers()` is present in the implementation constructor.
- The proxy is a TransparentProxy where the admin cannot call implementation
  functions, and the admin is a timelocked governance contract (a centralisation
  note, not a bug).
- The layout diff shows a same-type append at the end of the storage (safe by
  design).
- The "collision" is between two unrelated contracts that never share storage.

## How to confirm it is even reachable

- **Find the actual proxy and its admin.** Read the deployment artifacts, not the
  source tree: which address is the proxy, which is the implementation, and what
  does the proxy's `admin()` return.
- **Call the implementation directly.** That is the whole test for the
  initializer bug: an EOA calling `initialize()` on the implementation address
  (not through the proxy) either succeeds or reverts with
  "Initializable: contract is already initialized".
- **Get the real storage layouts.** Use `forge inspect <Contract> storageLayout`
  on both versions and diff them slot by slot. A markdown diff of the Solidity is
  not a storage-layout diff.
- **Check the upgrade authority on-chain**: `owner()`, `admin()`, `getRoleAdmin`,
  and who holds it. Then check whether that is an EOA (risky), a multisig, or a
  timelock.
- **Confirm value at risk through the proxy** at the fork block.

## Discriminating questions

1. If the implementation was left initializable, what does an attacker who
   initializes it gain over the upgrade path specifically — control of the
   implementation's own storage, a claimed slot recycled by the next
   `upgradeTo`, or a layout the next version's initializer will not repair?
2. Is `upgradeTo`/`upgradeToAndCall` guarded by an authority the attacker cannot
   obtain, and is that authority a timelock/multisig rather than an EOA?
3. Do the two versions' `forge inspect ... storageLayout` outputs differ in a way
   that shifts an existing variable's slot, or only append at the end?
4. Was a `__gap` shrunk, reused, or a base contract inserted mid-inheritance —
   the three shapes that silently shift layout?
5. Does the initializer set every state variable the implementation reads, or
   does an uninitialized variable become an exploitable default (owner ==
   address(0), oracle == address(0), fee == 0)?
6. Can the proxy's `initialize` be front-run between proxy deployment and
   initialization in a separate transaction?
7. Are there selector clashes between the proxy's own functions and the
   implementation's, in a non-transparent proxy?
8. If the upgrade is timelocked, what is the delay, and does the scope treat
   admin-only actions as in-scope?

## Common false positives

- **A "storage collision" found by eyeballing Solidity inheritance** rather than
  comparing actual layouts. Inserting a base contract at the *end* of the
  inheritance list is safe; only mid-chain insertion shifts slots.
- **Appending new variables at the end.** Safe by design.
- **`_disableInitializers()` present.** The most common reason an "uninitialized
  implementation" report is wrong.
- **The implementation address has no code / is not deployed.**
- **Admin-can-upgrade treated as a vulnerability** when governance is a
  timelocked multisig and the program excludes trusted-admin risk.
- **An initializer that is `reinitializer(2)` and already consumed.**
- **Mocks and test proxies** in the repo.
- **A layout diff between versions that are not actually deployed in sequence.**

## What a minimal PoC must demonstrate

- For the initializer bug: a fork test where a **fresh EOA** calls
  `initialize()` on the implementation address successfully, then reads back
  `owner() == attacker`. The control is the same call through the proxy, which
  must revert.
- For the upgrade-authority bug: the unprivileged call to `upgradeTo` succeeding
  and `implementation()` (or the EIP-1967 slot) changing, plus the new
  implementation being a contract the attacker controls.
- For a storage collision: both `storageLayout` dumps side by side, the exact
  slot, the old variable, the new variable, and a test showing a value written
  before the upgrade is read as a different variable after it — with the concrete
  values.
- The value at risk through the proxy: total balance and who can withdraw it.

## Impact bar

**Reportable:** an unprivileged account can initialize or replace the
implementation and thereby control funds, or a layout change demonstrably
corrupts a live variable that governs withdrawals. Name the address and the
amount.

**Informational:** a layout change that shifts nothing live, an initializer on a
contract that is not behind a live proxy, or an upgrade authority held by a
timelocked governance contract.

**Not a finding:** "this contract uses a proxy and proxies can be upgraded".
