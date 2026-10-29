# sol.accesscontrol — missing or wrong access control on a privileged function

This is the highest-volume Solidity class in the corpus (8,719 findings, 4,043
of them high or critical) and also the one with the highest false-positive rate,
because "no modifier" and "no access control" are different statements.

## When this is worth hunting

Worth the time when a function **changes state or moves value** and its
authority check is absent, wrong, or bypassable:

- An external/public function that writes a privileged slot (`owner`,
  `implementation`, `oracle`, `feeRecipient`, `paused`, a role mapping, a
  price/rate constant) with no modifier and no in-body check.
- A check that tests the **wrong subject**: `require(msg.sender == owner)`
  where the parameter is the victim; `onlyRole(MINTER)` on a function that also
  lets the caller choose who receives the mint.
- A one-time initializer (`initialize`, `init`, `setUp`) callable after
  deployment — including on the implementation contract behind a proxy, where
  the classic `_disableInitializers` guard is missing.
- `tx.origin` used for authorization. Any `tx.origin` auth is a phishing pivot,
  so it is a finding even when the immediate path looks benign.
- Role assignment that is self-service: `grantRole` guarded by "caller has *a*
  role" instead of the admin role, or a `setAdmin(address)` with no check.
- Ownership transfer without a two-step accept, combined with a wrong-owner
  check. A one-step `transferOwnership` to a typo'd address is a risk note; an
  unguarded `transferOwnership` is a finding.
- Upgradeability admin separation: the proxy admin can call `upgradeTo` **and**
  also holds a role in the implementation, collapsing the trust split.

High-yield shapes: freshly forked/copied protocols with a renamed `onlyOwner`
that is never applied, custom `AccessControl` reimplementations, `context`
patterns (ERC2771 forwarders) where `_msgSender()` is not used consistently, and
multi-implementation contracts where one variant lost the modifier in a merge.

Waste of time when:

- The contract is genuinely self-contained and the "privileged" function only
  affects the caller's own record.
- The function is `internal`/`private` with a single caller that does check.
- The role is held by an immutable, timelocked governance contract **and** the
  finding is "admin can do X" — admin-can-rug is a design choice, not a bug,
  unless the scope says otherwise.
- A modifier exists under a project-specific name (`auth`, `restricted`,
  `onlyGovernance`, `requiresAuth`) and you did not read it.

## How to confirm it is even reachable

- **Enumerate every externally reachable function and diff its guard.** Write it
  down as a table: function → visibility → modifiers → in-body checks. Missing
  rows are where the bug lives.
- **Resolve inherited modifiers.** `onlyOwner` may be defined three bases up and
  may itself be a no-op, or may compare against a storage slot the attacker can
  write.
- **Check the caller identity primitive.** `msg.sender` under an ERC2771
  forwarder is the forwarder, not the user; `_msgSender()` is the user. Mixed
  use is a real bypass and looks like correct code at a glance.
- **Ask what the function can do once called.** An unguarded `setFee` capped at
  ±1 bps is not a finding. An unguarded `setFee` to 100% is. Reachability alone
  is not impact.
- **Check the proxy.** If the target is a proxy, the implementation's
  `initialize` is often reachable directly at the implementation address, and
  that is enough to be a finding even though the proxy path is guarded.

## Discriminating questions

1. Is there any modifier or in-body check on this exact function, and if there
   is one, does it compare the caller against the right subject?
2. Is the check inherited, and does the inherited implementation actually read a
   slot the attacker cannot write?
3. Under a meta-transaction forwarder (ERC2771/2770), does the function use
   `_msgSender()` consistently, or does any authorization path use raw
   `msg.sender`?
4. Once called by an attacker, what is the maximum damage: full drain, fee to a
   bound, one-time flag, or nothing observable?
5. Does the function let the caller choose the *beneficiary* (mint to, withdraw
   to, upgrade to) in addition to triggering the action?
6. Which account can actually reach the implementation's `initialize`/`reinitialize` — is it an `onlyOwner`/`initializer` modifier, an unguarded function, or a self-service call any role can make?
7. Is authorization done with `tx.origin` anywhere in the call path?
8. Is the role-granting function guarded by the *admin* role, or by any role —
   and can a low-privilege role grant itself the powerful one?

## Common false positives

- **A guard exists with a non-obvious name.** Read the modifier body; do not
  judge by `onlyOwner`-shape.
- **`internal` functions with one guarded caller.** The public entry point
  carries the gate.
- **The role holder is a timelocked governance contract** and the finding is
  really "governance is powerful". That is centralisation, not access control
  breakage.
- **An unguarded setter bounded to a harmless range** (fee ±1 bp, a pause that
  anyone can unpause into the safe state).
- **Test/mock/script contracts** in the repo that are never deployed. Confirm the
  deployed artifact before reporting.
- **`onlyOwner` on a function whose only effect is on the owner's own funds.**
- **"Anyone can call `renounceOwnership`"** — that bricks admin functions but
  usually harms nobody who holds value; it is a griefing note, not a drain.
- **Constructor-only initialization mistaken for a callable initializer.**

## What a minimal PoC must demonstrate

- A fork test (or a local deployment of the exact compiled artifact) where a
  **freshly generated EOA with no roles** calls the function successfully.
- The observable privileged effect, read back from state: owner changed,
  implementation slot changed, fee is now 100%, minted balance is non-zero for
  the attacker, pause is on.
- A **control call** with a properly privileged account showing the same effect,
  proving the difference is authorization and not a broken test.
- For a drain variant, the attacker's balance delta and the protocol's loss,
  measured in token units.
- For a proxy-initializer variant, the exact implementation address called and
  the storage slot written.

## Impact bar

**Reportable:** an unprivileged account can move or destroy funds, replace the
implementation, mint supply, change the price the protocol trusts, or lock
users out of their own funds — with the amount or the slot named.

**Informational:** a guard is missing on a function whose effect is bounded and
harmless, a griefing-only renounce, or a centralisation observation about a
legitimate admin.

**Not a finding:** "no modifier" on an `internal` helper, or on a function whose
worst outcome is a revert for the caller.
