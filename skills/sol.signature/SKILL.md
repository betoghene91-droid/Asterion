# sol.signature — signature replay / missing nonce or chainid

Weight 0.848 over 2,281 findings. The class is mechanically checkable, which is
good news: a missing domain separator or nonce is either there or it is not, and
the PoC is short. Most reports fail because the signature path turns out to be
unreachable or already replay-guarded by a hash the grep missed.

## When this is worth hunting

Worth the time when a contract **acts on an off-chain signature**:

- `permit` / `ERC20Permit` / `ERC721Permit` implementations that do not include
  `block.chainid` in the digest, or that omit the owner's nonce from it, or that
  never increment the nonce after use.
- `ecrecover` with a hand-rolled `keccak256(abi.encodePacked(...))` digest —
  `abi.encodePacked` on multiple dynamic types is itself a collision surface.
- Meta-transaction forwarders (`execute(MetaTx)`) validating
  `hash = keccak256(abi.encode(..., nonce))` where nonce is a **global** counter
  or omitted, so one signature authorizes many transactions.
- Signature-authorized withdrawal / claim / closePosition functions where the
  relayer chooses when to submit.
- Cross-chain replay: the same contract deployed at the same address on two
  chains (a deterministic deployer / CREATE2 factory) with a digest that does not
  include chainid.
- `ecrecover` returning `address(0)` on malformed input, combined with a check
  written as `require(recovered != owner)` (inverted) or with no check at all.
- Malleable signatures accepted without enforcing `s <= secp256k1n/2` and `v ∈
  {27,28}` — this only matters when the digest is used as an id (a claimed
  signature hash), not for plain replay which needs a missing nonce.

Waste of time when:

- OpenZeppelin's `EIP712` + `Nonces` + `ECDSA` is used and the nonce is consumed
  (`_useNonce`) in the same call. Read the inherited implementation before
  claiming a gap.
- The signature is validated off-chain only and the contract merely stores an
  already-authorized result.
- The nonce is per-owner and incremented inside the same function.
- `chainid` is present and the deployment addresses differ per chain.
- The function is `onlyRelayer` and the relayer is the trusted backend — replay
  then harms nobody, because the trust is off-chain.

## How to confirm it is even reachable

- **Get the exact digest.** Print it in a test: `digest = keccak256(...)`. If it
  contains chainid, the owner, and a per-owner nonce that is incremented before
  the external effect, there is nothing here.
- **Find who can call the consuming function.** Anyone (good — replay is
  reachable by the attacker) or a trusted relayer only (usually not a finding).
- **Check the nonce lifetime.** Does the nonce increment happen before or after
  the value transfer? If after, a reentrant path might reuse it, which is a
  different finding but worth noting.
- **Confirm the replay has an effect the second time.** Some contracts accept the
  second call and do nothing (an idempotency check by state, not by nonce) — that
  is not replay.
- **For cross-chain: find the sibling deployment.** Same code at the same address
  on another chain, with a live balance there. No sibling, no cross-chain
  replay.

## Discriminating questions

1. Does the signed digest include `block.chainid` (via a domain separator) and
   the contract address, or only the payload?
2. Is there a per-owner nonce included in the digest **and** incremented before
   any external effect?
3. Can an arbitrary account submit the signature-carrying transaction, or is
   submission restricted to a trusted relayer?
4. Does a second submission of the same signature produce a second state change
   or value movement, or is it rejected by state rather than by nonce?
5. Is `ecrecover`'s result checked against a zero-address return (a malformed
   signature returning `address(0)` is the classic bypass)?
6. Does the digest use `abi.encodePacked` with two or more dynamic types, which a
   collision can satisfy?
7. Is the nonce scoped per-owner, per-key, or global — and can a global counter
   be consumed by an attacker to invalidate a victim's pending signature?
8. Is the same contract deployed at the same address on another chain with a
   non-empty balance, and is chainid absent from the digest?

## Common false positives

- **OZ `ERC20Permit` inherited** — the domain separator and nonces are there;
  the grep just did not follow inheritance.
- **An off-chain-signature design where the relayer is trusted**, so replay gains
  nothing an operator could not do anyway.
- **A nonce that the code does increment**, in a modifier or a base contract.
- **Signature hashes used as ids** where malleability is irrelevant because the
  id is stored and compared, not re-derived.
- **`chainid` present but the reviewer looked at a helper, not the domain
  separator.**
- **"Cross-chain replay" with no sibling deployment** at the same address.
- **`ecrecover` returning zero** where the code does check
  `require(recovered == expectedSigner)`, which already excludes `address(0)`
  unless `expectedSigner` is zero too.
- **A signature that can only be used once because the payload includes a
  monotonic on-chain value** the caller cannot reuse.

## What a minimal PoC must demonstrate

- The exact digest bytes (or the `abi.encode` preimage) printed from the test.
- The attacker's first submission: signature accepted, effect observed (balance,
  allowance, position closed).
- The attacker's **second submission of the identical signature**: accepted
  again, with the second effect measured — this is the whole proof.
- A control run where the nonce is incremented (or chainid is added), and the
  second submission reverts.
- For cross-chain: the sibling chain/state proof that the same signature is valid
  at the other deployment, and what it moves there.
- For `ecrecover` zero: the malformed signature yielding `address(0)` and the
  authorization check passing.

## Impact bar

**Reportable:** one signature produces two or more state changes, or a signature
intended for chain A acts on chain B, with value or authority moving. Quantify
what the replay duplicates.

**Informational:** replay is possible but has no economic effect (the second call
is a no-op by state), or the path is relayer-only and the relayer is trusted.

**Not a finding:** "uses ecrecover" without a missing nonce, missing chainid, or
unchecked zero address.
