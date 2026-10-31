# sol.signature.ecdsa - ECDSA specifics: zero-address recovery, malleability, domain

`sol.signature` covers the class. This pack covers the three places ECDSA itself
goes wrong even when the protocol believes it has checked the signature properly.

The reason this deserves its own pack is that every one of these defects survives
a careful-looking review. The code reads the signature, recovers an address, and
compares it. It looks correct. It is not, because of what `ecrecover` does with a
malformed input, or what the digest omits.

## When this is worth hunting

- `ecrecover` result not compared against `address(0)`. A malformed signature
  (`v=0`, `r=0`, `s=0`) recovers to the zero address. If a zero signer is
  accepted, or if the owner list can ever be empty, the check passes for anyone
  who sends garbage. This returns true on a signature nobody signed.
- `s` not constrained to the lower half of the curve order. ECDSA has two valid
  `s` values per signature, so one signature exists in two byte-forms. If a
  protocol tracks used signatures by their bytes, the second form is a free
  replay.
- A digest with no domain separator: no `chainId`, no verifying contract address.
  The same signature then verifies on a second contract that shares the code, or
  on a forked chain that shares the address.
- `abi.encodePacked` over two dynamic types. Packed encoding of two strings or
  two byte arrays is ambiguous, so two different pairs can produce one digest.
- A signed struct hash that omits a field the executor later reads, so the signer
  never agreed to the value that is actually used.

## How to confirm it is even reachable

Read the recovery site and the digest assembly, in that order. Then ask what the
recovered address is compared against: an immutable, a storage owner, or nothing.
"Nothing" is the shortest path to a finding in this class.

Then ask whether the same signature can be submitted twice. If a nonce is
consumed and stored, most replay collapses, and the remaining question is only
the digest's domain.

## Discriminating questions

The pack's `questions` array is the ordered set. The zero-address question comes
first, because it is a one-line check that is missing in a surprising amount of
production code, and its absence is decisive.

## Common false positives

- OpenZeppelin `ECDSA.recover` is used, which rejects high-`s` and returns zero
  but is then checked, or reverts on a zero result.
- A full EIP-712 domain separator with `chainId` and the verifying contract is in
  the digest, and a nonce is consumed exactly once.
- The signature is already single-use by an on-chain record keyed on its hash.
- Malleability is real but the used-signature set is keyed on the digest rather
  than the signature bytes, so both forms collapse to one entry.

## What a minimal PoC must demonstrate

- The same signature accepted twice, or on two contracts, with both results
  printed and the second one shown to be a replay rather than a fresh signature.
- A control where the nonce is consumed, so the second submission must revert.
- The recover-to-zero case printed, showing the zero address and what the check
  compared it against, when that is the defect.
- No privileged role used, and the signature bytes produced by the attacker.

## Impact bar

Reportable when a signature can be replayed or forged to move value, with the
amount quantified and the second execution demonstrated. Informational for
malleability where replay is already blocked by a nonce, for a missing domain
separator on a contract that is deployed only once and never forked, or for an
unchecked zero address that no code path can actually reach.
