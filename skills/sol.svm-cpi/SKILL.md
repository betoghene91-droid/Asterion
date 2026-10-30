# sol.svm-cpi — arbitrary CPI where the caller chooses the target program

Solana programs do not call each other by address the way contracts do. They
*invoke* another program whose id is an account in the list. If the program
under test takes that id from its caller instead of pinning it, the caller has
chosen which code runs inside the program's own authority — a confused deputy.

This class has no EVM equivalent, which is exactly why it needs a pack. The
nearest EVM cousin is `delegatecall` to a caller-supplied address, but the
mechanics differ enough that the EVM pack's questions do not find it: here the
give-away is a `Pubkey` account passed alongside the accounts the CPI will
consume, and a handler that forwards both.

## When this is worth hunting

Worth the time when all three are visible:

1. The program performs a CPI — a token transfer, a system transfer, a call into
   another protocol.
2. The target program id is read from an account the caller supplies, rather
   than a constant, a `Program<'info, T>`, or a stored value.
3. The CPI's accounts include one that holds value or authority the program
   controls, so the caller's choice of program changes where value goes.

High-yield shapes:

- `remaining_accounts` forwarded wholesale into `invoke`, so both the program id
  and the account list come from the caller.
- A handler that builds a `system_instruction::transfer` using an account passed
  as `recipient` where the program is the signing authority.
- Bridge and adapter programs whose whole purpose is to call arbitrary targets,
  where the caller-supplied id is documented as a feature.
- Programs that accept a `program_id` argument in the instruction data for a
  "route" or "strategy" and then `invoke` it with the PDA's signature.
- A CPI where the account metas are `AccountMeta::new(account.key, false)`
  built from `to_account_info()` on caller input.

Waste of time when:

- The target is a hardcoded constant, or typed as `Program<'info, Token>`. Anchor
  deserializes that and rejects a substitute before the handler runs.
- The handler compares the passed id against the expected one, however it does
  it. `InvalidProgramId` (3008) at runtime is the guard working.
- The accounts the CPI touches are derived by the program from seeds, so only
  the instruction data is caller-supplied.
- The redirectable program cannot touch any account of value. A redirect that
  achieves nothing is not an impact.

## How to confirm it is even reachable

Before writing any Rust:

- **Which program is it supposed to call?** If the answer is "any", the
  question becomes "can any of them reach value", and that is a much wider set
  to reason about.
- **Does the program sign for the CPI?** A CPI signed by the caller's own key
  transfers its own authority and proves nothing. You need the *program's* PDA
  as signer, via `invoke_signed`.
- **Which account can the CPI be aimed at?** Name the victim account and its
  balance at the moment of the proof. "The program could be tricked" is a
  hypothesis; "this account lost these lamports" is the finding.
- **Can you clone the state?** On mainnet the victim's balance must exist on the
  cloned ledger, so the clone has to include the victim account as well as the
  program.
- **What does the successful case look like on the cluster?** Confirm the
  transaction actually confirms, not merely that it fails with the error you
  predicted — those are different outcomes and only one is a finding.

## Discriminating questions

1. Is the CPI program id a literal or a constant, or is it read from an account
   the caller passes in `remaining_accounts` or the Accounts struct?
2. Does the handler check the passed program id with `require_keys_eq!` before
   invoking it?
3. Are the accounts forwarded to the CPI derived by the program, or copied from
   the caller's list with `to_account_info()` on whatever was supplied?
4. When `Program<'info, T>` is used, does `T` pin the expected program, which
   makes a substituted program fail at deserialization?
5. Does the CPI's signing authority come from a PDA the program signs for, so the
   caller can redirect the destination without holding the key?
6. Is the victim account validated as belonging to the program's own state, or
   can any account with a balance be passed and debited?
7. After a caller-directed CPI, which account's lamports changed, and is the
   change attributable to the CPI rather than to the transaction fee?

## Common false positives

- **The program is a constant or `Program<'info, Token>`.** Anchor's type check
  already rejects a substitute.
- **The id is compared before the invoke.** `InvalidProgramId` (3008) is a real
  guard, and its presence means the claim is disproved rather than untested.
- **The accounts are derived from seeds.** Only the instruction data is
  attacker-controlled, which is a different (and usually safe) position.
- **The CPI is redirectable but nothing of value is reachable.** No victim, no
  finding; say so plainly instead of reporting the primitive.
- **The CPI is signed by the caller's own keypair.** The attacker redirected a
  transfer of their own funds.
- **The transaction fails.** A rejected CPI is not evidence of a confused
  deputy. Check the error code: `InvalidProgramId` and
  `AccountNotSigner`-family codes mean the guard fired.
- **Fee noise mistaken for impact.** Lamport deltas of a few thousand are the
  transaction fee, not value extraction. Measure the victim, not the payer.

## What a minimal PoC must demonstrate

An Anchor integration test pair on one validator, reporting numbers:

- The victim account's **lamport balance before and after**, showing a decrease
  caused by the caller-directed CPI.
- The **program id the CPI was actually pointed at**, printed as evidence, so a
  reader can see it was caller-chosen and not the expected one.
- A control passing the expected CPI program, showing the victim does not move —
  that is what attributes the loss to caller control of the target rather than
  to the instruction being generally unsafe.
- The signing authority used for the CPI (the program's PDA, and which seeds),
  so the report can state why the program was able to move the victim's funds at
  all.

## Impact bar

**Reportable:** a caller-chosen CPI target causes a victim account the program
holds authority over to lose lamports or tokens, quantified, with the target
program id and the signing PDA named.

**Informational:** the CPI is redirectable but no account of value is reachable;
the redirect only changes which program observes the call; or the handler
already pins the program and only the harness substituted it.

**Not a finding:** the redirect is signed by the caller's own key, or the guard
fired with `InvalidProgramId` and the claim was only that the parameter exists.
