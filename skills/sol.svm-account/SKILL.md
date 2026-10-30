# sol.svm-account — an unvalidated account substituted for a program-owned PDA

Solana's account list is caller-supplied. A program that reads state out of an
account it is *supposed* to own, without checking the owner, will happily
deserialize whatever bytes the caller passes — including an account the caller
created a moment earlier and fully controls. That is the whole class.

The reason it needs its own pack: on EVM a contract's storage cannot be swapped
out, so "read the wrong storage" is not a thing. On Solana every account is an
argument, and every argument is adversarial until proven otherwise. Anchor's
`Account<'info, T>` gives you the check for free; `UncheckedAccount` and
`AccountInfo` give you nothing.

## When this is worth hunting

Worth the time when all three are visible:

1. An instruction reads or writes state held in a program-derived account.
2. The Accounts struct declares that account as `UncheckedAccount<'info>`,
   `AccountInfo<'info>`, or a raw `&AccountInfo` in the handler.
3. Value or authority follows from what is read out of those bytes — a payout
   goes to an address stored there, a balance is debited, or a mint authority
   is taken from it.

High-yield shapes:

- Vault and reserve accounts where the payout destination is a field *inside*
  the account data rather than an account in the list.
- Instructions that accept a list of accounts (`remaining_accounts`) and trust
  them positionally.
- `seeds` constraints that pin only a constant prefix, leaving a user-chosen
  suffix unconstrained, so two different users' accounts both satisfy them.
- A `close` path that moves lamports to an account read from data.
- Programs migrated from a version without `Account<T>`, where the old
  `AccountInfo` struct survived the upgrade.

Waste of time when:

- The slot is `Account<'info, T>`. Anchor checks the owner and the 8-byte
  discriminator before the handler runs; a substitute fails at
  `AccountOwnedByWrongProgram` (3007) or `AccountDiscriminatorMismatch` (3002).
- The handler re-derives the PDA with `find_program_address` and compares. That
  is equivalent to a seeds constraint, just written out.
- The substituted account is accepted but only a field the attacker cannot
  influence is read. No write, no move, no impact.

## How to confirm it is even reachable

Before writing any Rust:

- **Which account's ownership actually matters?** Name the one whose bytes drive
  the effect. A program may own ten accounts on the path and only one matters.
- **Can the attacker create a plausible substitute?** If the handler checks the
  data length, the substitute needs that length. If it checks a discriminator
  byte, the attacker can write it. Owner is the check that cannot be forged
  cheaply, so its absence is the signal.
- **Where does value leave?** A substitution with no payout is a correctness
  note, not a finding.
- **Is the genuine PDA known?** You need it for the control run; without it you
  cannot show the difference between "the substitute got paid" and "the program
  paid the right account twice".
- **Can the program be cloned or redeployed?** On mainnet, clone the program
  and let it run against real state; on devnet, deploy your own instance and
  seed it with values you control.

## Discriminating questions

1. Does the Accounts struct use `Account<'info, T>`, which checks owner and
   discriminator, or `UncheckedAccount` / `AccountInfo`?
2. If seeds are declared, does the seed list cover every field that
   distinguishes one user's account from another's, or only a constant prefix?
3. Can the caller pass an account owned by the system program or a token program
   where the handler assumes its own layout and deserializes the bytes anyway?
4. Does the handler re-derive the PDA and compare, or trust the address it was
   handed?
5. Where does value leave on this path, and is the recipient read from the
   account list or from a field the program itself wrote?
6. Is the account writable and caller-owned at substitution time, so a success
   changes bytes the attacker controls?
7. Does closing or reallocating happen before the ownership check, leaving a
   window where a foreign account is already trusted?

## Common false positives

- **`Account<'info, T>` already did the work.** Owner and discriminator are both
  checked. A substitute of the wrong type never reaches the handler.
- **The PDA is re-derived and compared.** Not declarative, still a real check.
- **The account is accepted but nothing moves.** Report only if you can name the
  write and its consequence.
- **The account is a well-known program account.** An attacker cannot create it,
  so substitution is not available.
- **`AccountNotInitialized` (3012) in the attack run.** That is your fixture
  skipping an initialize step, not the target failing to validate anything. It
  is the single most common way this class produces a false positive.
- **The harness created the substitute with the wrong length.** A layout
  mismatch looks like a validation failure and is not one.

## What a minimal PoC must demonstrate

An Anchor integration test pair on one validator, reporting numbers:

- The caller-owned substitute's **lamport balance before and after**, read from
  the same validator, showing value the program meant for its own PDA.
- The **owner of the substitute** printed before and after, so a reader can tell
  a system-owned account that gained value from one that was rejected outright.
- A control passing the genuine program-owned PDA, showing it does not pay the
  substitute — that is what attributes the gain to the substitution rather than
  to the instruction being generous.
- The substituted account's address and the genuine PDA's address, both printed,
  so the report can state exactly which account stood in for which.

## Impact bar

**Reportable:** a substitute account the caller controls receives lamports or
token balances the program intended for its own PDA, quantified in lamports or
token units, with both account addresses named.

**Informational:** the substitute is accepted but nothing of value moves; the
read is observable only to the caller; or the guard exists and the harness
passed the wrong account.

**Not a finding:** Anchor's `Account<T>` wrapper is in place and only the test
fixture was wrong.
