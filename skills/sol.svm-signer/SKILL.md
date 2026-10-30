# sol.svm-signer — an account accepted without the signer or authority it requires

On Solana the question is almost never "is this input validated". It is "which
account is this, and does the program know that". A missing signer check means
an account that merely *signed its own transaction* is treated as though it
were the account the program recorded when it was initialised. Those are
different facts, and the gap between them is this class.

The reason this class needs its own pack rather than borrowing the EVM
access-control one: on EVM, `msg.sender` is unambiguous and the bug is a
missing comparison. On Solana the caller supplies the account list, so
"the signer is wrong" and "the account is not the one you meant" look identical
in the handler and are fixed in different places.

## When this is worth hunting

Worth the time when all three of these are visible:

1. An instruction whose Accounts struct takes an authority, owner, or admin
   account.
2. That account is **not** declared as `Signer<'info>`, or is declared as
   `Signer` but never compared against the authority stored in state.
3. Something of value or consequence depends on that comparison: a state field
   gets rewritten, value moves, a mint is granted, or an account is closed.

High-yield shapes:

- `UncheckedAccount<'info>` or `AccountInfo<'info>` in the authority slot, with
  the real check pushed into the handler body where it is easy to omit.
- A state account with an `authority: Pubkey` field that is read for display but
  never compared during a mutating instruction.
- `Option<Signer<'info>>` authority parameters, where `None` skips the whole
  comparison.
- Admin instructions added later that reuse a struct written before the
  authority field existed.
- `has_one` declared on one account but not on the sibling account that also
  carries an authority.

Waste of time when:

- The struct says `has_one = authority` on the state account. Anchor expands
  that into a key comparison that runs before the handler; a wrong signer gets
  `ConstraintHasOne` (2001) and never reaches your code.
- The path is reachable only via `invoke_signed` with seeds the caller cannot
  influence.
- The authority is compared with `require_keys_eq!`. It is a check, just not a
  declarative one.

## How to confirm it is even reachable

Before writing any Rust:

- **Who can build the instruction?** A permissionless instruction is the
  interesting one. If the program gates the path behind another program's CPI,
  you need that program's cooperation and the class changes.
- **Does the wrong signer need to be a specific key, or just any key it
  controls?** "Any keypair" is a finding; "a key the program already trusts" is
  not.
- **Is there an account whose bytes record the authority?** If nothing records
  it, there is nothing to observe and nothing to prove. Look for the field
  before believing the bug.
- **Can you read the state back on the same validator?** Solana has no
  `eth_call` against historical state; you read the account after the
  transaction confirms, so the validator must still be running.
- **Is the program deployed on a cluster you can clone?** If it is only on
  mainnet, the proof runs against cloned bytecode, which is fine — but it means
  `self_deployed` is false and only the precondition-removed counterfactual is
  honest.

## Discriminating questions

1. Does the instruction declare the authority as `Signer<'info>`, or as
   `UncheckedAccount` with the check done by hand?
2. When the handler validates it, does it compare the key against the authority
   stored in an account, or only assert that it signed?
3. Can an account that signs its own transaction satisfy the check without
   being the account recorded at initialisation?
4. Is the constraint expressed as `has_one = authority`, which Anchor enforces
   before any handler code runs?
5. Does any instruction accept an optional authority where `None` skips the
   comparison entirely?
6. If a PDA signs via `invoke_signed`, does the seed list contain a field the
   caller chooses, letting an attacker derive a signing PDA?
7. After the suspect instruction succeeds, which account's bytes hold the new
   authority, and can that be read back without a second transaction?

## Common false positives

- **`Signer` plus `has_one`.** Both are enforced by Anchor's generated code.
  Read the struct, not just the handler.
- **The check is a `require_keys_eq!` in the body.** Real, if late. Report only
  if you can show the comparison uses the wrong subject.
- **A PDA-only path.** If the caller cannot produce the signature, there is no
  attacker.
- **The authority is read and nothing is written.** Observation is not
  authorisation. No write, no impact.
- **A `#[cfg(feature = "testing")]` instruction.** It is not in the deployed
  bytecode, so it cannot be called on the cluster you are proving against.
- **The harness passed the wrong account.** `AccountNotSigner` (3010) or
  `ConstraintSigner` (2002) in the *attack* run means the guard fired. That is
  a disproved claim, not a failed test.

## What a minimal PoC must demonstrate

An Anchor integration test pair on a local validator, reporting numbers:

- A keypair the program has never seen, signing a real transaction the cluster
  accepts, after which the recorded authority field equals the attacker key.
- The authority index measured before **and** after, with the fixture asserting
  it started equal to the victim's key. Without the baseline the second reading
  proves nothing.
- A control run with the instruction removed, showing the field does not drift
  on its own.
- The error code from the correctly-guarded path, named. "It failed" hides
  whether the guard worked or the harness was wrong; `3010` and `2002` say
  which.

## Impact bar

**Reportable:** an account holding no role makes the program record it as
authority, or moves value the recorded authority controls, with the instruction
and the resulting account bytes shown.

**Informational:** the wrong signer can only read state; the check exists and
the harness passed the wrong account; or the effect is a one-way flag with no
value behind it.

**Not a finding:** `has_one` or `require_keys_eq!` is present and the claim is
only that the check is not declarative.
