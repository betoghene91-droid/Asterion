# sol.erc4626 - vault accounting: share price, rounding, donation

One share-price formula drives almost every vault loss. Either the vault rounds
in its own favour on both sides of the trade, or it does not. There is very
little middle ground worth hunting.

ERC-4626 standardised the interface, not the maths. Two conforming vaults can
differ by an order of magnitude in how much a donation sequence costs them.

## When this is worth hunting

Worth the time when all of these hold:

- The vault is ERC-4626 or 4626-shaped, and it holds other people's funds.
- `totalAssets()` reads a live token balance (`balanceOf(address(this))`) rather
  than an internal ledger a direct transfer cannot move.
- There is no virtual offset, no dead shares, no minimum first deposit.
- A fresh address can be the first depositor, before any other position exists.

The canonical attack is three steps and costs one wei plus the donation:

1. Deposit 1 wei. The attacker now owns 1 share out of a 1-wei total.
2. Transfer a large amount directly to the vault address, skipping deposit().
   `totalAssets` rises, share price rises, the attacker's 1 share is now worth
   the whole donation.
3. The next depositor's shares round down. At sufficient inflation they round to
   zero: they pay, receive nothing, and the attacker redeems both.

A second shape is asymmetric rounding: `deposit` rounds shares down but
`withdraw` rounds assets up, so a repeated small deposit/withdraw cycle drains a
little each time. This needs many iterations, so check whether gas makes it
profitable before claiming it.

## How to confirm it is even reachable

Read `totalAssets()` first. If it is a stored variable updated only on
deposit/withdraw, a direct transfer cannot move it and the donation is inert.

Then check the entry price. If a minimum first deposit exceeds the griefing cost
the attacker must pay, the attack is unprofitable. If virtual shares are present,
compute the offset against the donation size: a well-sized offset needs a
donation larger than the victim's deposit, which caps the attacker's cost.

## Discriminating questions

The pack's `questions` array is the ordered set. The rounding-direction question
comes first, because a vault that rounds correctly in its own favour on both
sides has no inflation surface regardless of the donation vector.

## Common false positives

- Virtual shares or dead shares already neutralise the inflation attack, sized so
  the griefing cost exceeds the gain.
- `totalAssets()` uses an internal ledger a donation cannot touch.
- The asset cannot be transferred to the vault address (no transfer to self, or a
  token that reverts on self-transfer).
- A minimum initial deposit makes the griefing cost exceed the attacker's gain.
- Rounding that only trims dust, with no victim and no accumulation path.

## What a minimal PoC must demonstrate

- The attacker's asset delta across the full deposit/donate/redeem sequence,
  measured before and after on a fork.
- A control deposit with no donation, showing the honest share count for the same
  amount, so the donation is demonstrably the cause.
- The victim's realized loss printed, so the attacker's gain has a stated source.
- No privileged role used, and no capital left stranded in the vault afterwards.

## Impact bar

Reportable when an unprivileged sequence extracts value from other depositors,
with the amount quantified against a real subsequent deposit. Informational for
rounding that only trims dust with no victim, or for an inflation path whose
griefing cost exceeds the extractable amount.
