# sol.inflation — first-depositor / donation share inflation

Highest corpus weight of any Solidity class (1.255 over 6,602 findings, 4,512
high or critical). The reason is structural: share-price vaults are everywhere,
and the attack costs almost nothing when the vault is empty.

## When this is worth hunting

Worth the time when the vault prices shares as `assets * totalSupply /
totalAssets`-style **and** total supply or total assets can be moved without
minting shares in the same proportion:

- A brand-new or low-liquidity ERC4626-style vault where `totalSupply == 0` or
  is tiny, so the first depositor sets the initial ratio.
- `totalAssets()` derived from `token.balanceOf(address(this))` — then a direct
  `transfer` into the vault (a donation) raises the price of existing shares
  without minting any.
- A `deposit(assets)` that computes `shares = assets * totalSupply / totalAssets`
  with plain floor division and no virtual offset / dead shares.
- An empty-vault `initialize`/first-deposit path with no `MINIMUM_LIQUIDITY`
  burn.
- Vaults where the strategy can be triggered to report a sudden asset increase
  (harvest, airdrop of the underlying, a rebase) with supply unchanged.
- Any lending market that prices collateral shares the same way (cToken-style
  exchange rate set on the first mint).

Waste of time when:

- `totalAssets()` is an internal accounting variable that only changes on
  deposit/withdraw (a donation does not move it).
- OpenZeppelin's ERC4626 with the decimals offset/virtual shares mitigation is in
  place — check the version and whether `_decimalsOffset()` is non-zero.
- Dead shares were burned at initialization (`MINIMUM_LIQUIDITY` sent to
  `address(0)`).
- `require(shares > 0)` plus a non-trivial minimum deposit.
- The vault already holds a large balance, so the donation needed to move the
  price by a profitable amount exceeds the profit.

## How to confirm it is even reachable

- **Is `totalAssets` a live balance read?** Grep the implementation:
  `balanceOf(address(this))` is the exploitable shape; a stored `totalAssets`
  variable that only deposit/withdraw touch is not.
- **Can an outsider deposit at all?** A whitelisted vault with KYC-gated
  depositors reduces this to an insider/rounding note. Check `deposit` guards.
- **Is the vault empty or nearly empty at the fork block?** Look at
  `totalSupply()` and the underlying balance. An empty vault with a live
  `deposit` is the whole game.
- **Can the attacker be the first depositor?** First-mover advantage matters:
  if the vault is already seeded by the deployer with dead shares, the attack
  window is closed.
- **Does the victim path exist?** The exploit needs a subsequent depositor (or a
  `mint` caller) whose shares are rounded to zero. Without a victim in the same
  window, the attacker only harms themselves.

## Discriminating questions

1. Is `totalAssets()` computed from a live `balanceOf(address(this))` (donation-
   sensitive) or from an internal counter only deposit/withdraw move?
2. Is the vault's `totalSupply` zero or economically tiny at the block where the
   attacker can first deposit?
3. Is there a virtual-share offset, dead-share burn, or `MINIMUM_LIQUIDITY` that
   already prices the first share above dust?
4. Does the deposit path floor-divide such that a later depositor can receive
   exactly zero shares, and does anything `require(shares > 0)` prevent it?
5. Who is the victim, and can the attacker choose the moment a victim deposits
   (a public mempool front-run) or does the attack need a specific victim action?
6. What is the attacker's cost (first deposit + donation + gas) versus the
   victim's loss, and is the net positive at realistic gas prices?
7. Can the attacker recover the donated amount by redeeming their own shares
   afterwards, or is the donation a sunk cost that must be smaller than the
   theft?
8. If the underlying is fee-on-transfer or rebasing, does the donation bypass the
   accounting entirely (a direct transfer that `totalAssets` sees but the
   bookkeeping does not)?

## Common false positives

- **`totalAssets` is a stored variable.** Donations do not affect it, so the
  classic attack does not apply. This is the single most common mistake.
- **OpenZeppelin's recent ERC4626** with a decimals offset — the first-share
  price is already inflated by the virtual offset.
- **Dead shares burned at deploy.**
- **The vault already holds a large balance**, so the donation required dwarfs
  the theft. Show the numbers.
- **`require(shares > 0)`** in `deposit`, which converts the theft into a revert
  (griefing at most).
- **A deposit cap or whitelist** that stops the attacker depositing at all.
- **A share price that is 1:1 by construction** (a non-yield-bearing wrapper).
- **A victim who does not exist** — no second depositor in the window means the
  primitive has no victim.

## What a minimal PoC must demonstrate

- Vault state before: `totalSupply`, `totalAssets`, and the underlying balance.
- Attacker step 1: deposit the minimum (1 wei), receiving the reported shares.
- Attacker step 2: donate X directly to the vault, and the new implied share
  price — state the multiplier.
- Victim step: deposit Y and receive **zero** (or dust) shares, with the exact
  numbers printed.
- Attacker step 3: redeem, and show the attacker's net profit after recovering
  the donation and paying gas; show the victim's loss.
- A control run on a vault with dead shares or a decimals offset, where the same
  sequence yields no profit — this is what proves the mitigation is what is
  missing.

## Impact bar

**Reportable:** an attacker with no special role causes a measurable loss to a
subsequent depositor, or captures value they did not supply, with the sequence
atomic and gas-profitable. Quantify victim loss and attacker net profit.

**Informational:** the inflation primitive exists but the vault is seeded, the
victim set is empty, or the donation cost exceeds the attainable theft.

**Not a finding:** "share price can be moved by donations" when `totalAssets` is
an internal counter, or when mitigations are present and were not checked.
