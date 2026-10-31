# sol.erc4337 - account abstraction: userOp validation and paymasters

Account abstraction moves the authentication decision out of the protocol and
into user code. `validateUserOp` is a contract someone wrote by hand, and it is
the only thing standing between a signed intent and execution.

That is the whole attack surface. The EntryPoint is well audited; the accounts
and paymasters built on it are not.

## When this is worth hunting

- A smart account whose `validateUserOp` hashes the userOp itself instead of
  calling `entryPoint.getUserOpHash(userOp, userOpHash)`. The canonical hash binds
  `chainId` and the `entryPoint` address. A hand-rolled hash that omits either is
  replayable across chains or across EntryPoints.
- A local nonce counter instead of the EntryPoint's. A local counter can be
  reset by re-delegation or raced by two userOps in one bundle.
- A paymaster that validates for any sender, or validates the sender but does not
  bound the `callData` it is willing to pay for. That is an open tab.
- No prefund or gas-limit check, so a malicious account can inflate the gas
  limit and drain the paymaster's deposit through `postOp`.
- The same signed userOp replayable against a second EntryPoint deployment, or
  against a forked chain that shares the account's address.

## How to confirm it is even reachable

Read the account's `validateUserOp` and check three things in order: the hash
source, the nonce source, and whether the signature is checked against the
account's own owner. If all three are canonical, the account is not the bug and
the investigation moves to the paymaster.

For a paymaster, the question is narrower: what bounds the gas it will pay, and
who is allowed to make it pay. A paymaster with no allow-list is a public good
with a balance, and the balance is the finding.

## Discriminating questions

The pack's `questions` array is the ordered set. The hash question comes first:
a canonical `getUserOpHash` closes cross-chain replay in one read.

## Common false positives

- The account extends an audited base and the canonical hash is used unchanged.
- The paymaster validates sender strictly and bounds both gas and callData.
- Replay is blocked by a chainId inside a full EIP-712 domain separator.
- The nonce comes from the EntryPoint and is incremented there, not locally.
- The griefing cost to the attacker exceeds the drain available, because gas
  spent to inflate gas is gas the attacker also pays.

## What a minimal PoC must demonstrate

- Two executions of the same signed userOp both succeeding, either on the same
  chain or against two EntryPoints.
- A control where the nonce is consumed and the replay must revert, proving the
  nonce is what stops it in the honest case.
- The paymaster balance delta printed, showing who actually paid and how much.
- No privileged role used, and the replay produced from bytes the attacker holds.

## Impact bar

Reportable when replay or unbounded paymaster use costs the paymaster or the
account real value, with the amount quantified. Informational when validation is
merely non-canonical but no value moves, or when the griefing cost exceeds the
extractable balance.
