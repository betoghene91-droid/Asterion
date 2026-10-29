# web.jwt — JWT handling weakness

Almost every JWT finding is really a statement about the *verifier*, not the token.
A token we can edit proves nothing until a protected endpoint accepts it and returns
data belonging to the identity we forged. The interesting question is which claim the
server actually trusts and where the signature check sits relative to the authorization
decision.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any application carrying a three-part dot-separated token: SPAs,
mobile APIs, SSO front doors, and internal service meshes. High-yield shapes:

- **Hand-rolled verification** that decodes with a library's `decode` rather than
  `verify`, then trusts the payload.
- **Algorithm taken from the header** in a service that also exposes an RSA public key,
  enabling key confusion.
- **Role and tenant claims trusted directly** with no database reconciliation.
- **Multi-issuer setups** where one weak issuer's key validates tokens for another.
- **`kid` used as a path or URL**, turning verification into a file read or an SSRF.

Waste of time when the token is opaque, when verification is one vetted library call
with a pinned algorithm, or when every authorization decision re-reads from the database.

## How to confirm it is even reachable

- **Decode without trusting.** Read header and payload first. The `alg`, `kid`, and
  claim set tell you which attack applies before you send anything.
- **Find the acceptance point.** A forged token matters only where a protected endpoint
  consumes it; note every path that reads the token, including websocket handshakes and
  file-download links.
- **Test alg:none and key confusion separately**, and watch for a distinct error message
  — a specific rejection is itself evidence the algorithm is pinned.
- **Try the offline wordlist only with a captured token**, and only if the algorithm is
  HMAC; an RSA token cannot be dictionary-attacked this way.
- **Check revocation.** A valid token for a demoted user is a real finding and needs no
  forgery at all.

## Discriminating questions

1. Does the server verify the signature at all, and does it pin the expected algorithm rather than accepting the alg header's value?
2. Is alg:none accepted, or is the algorithm taken from the header in a way that lets an RSA public key be used as an HMAC secret?
3. Is the HMAC secret a guessable value that an offline dictionary attack against the captured token would recover?
4. Which claims drive authorization: sub, a role claim, a tenant claim, or a database lookup keyed by sub, and can any of them be changed without invalidating the signature?
5. Does the verifier check exp, nbf, and iss, or does it decode the payload and trust the claims without validating the standard fields?
6. Is the token accepted from a cookie, a header, or a query parameter, and does a second acceptance path skip the verification the first one performs?
7. Does a key-identifier header let the client select the verification key or inject a URL the server fetches?
8. After a password change or a role removal, is the old token still accepted, so a revoked identity keeps its claims until expiry?

## Common false positives

- The token is decoded but every protected endpoint re-reads the user's role from the database rather than from the claim
- alg:none is rejected with an explicit algorithm-mismatch error, proving the algorithm is pinned server-side
- The signature verifies and the token is merely long-lived, which is a session-lifetime policy question rather than a bypass
- The endpoint returns the same generic response for a forged token as for an absent one, indicating the request was rejected
- The secret recovered offline belongs to a test or staging issuer whose tokens production does not accept
- The forged token was only accepted by a client-side route guard, with the API rejecting the same request

## What a minimal PoC must demonstrate

- the original token and the exact modification made to it, with the field and value named
- a protected endpoint accepting the modified token and returning data for the identity we asserted
- a control request with the same modified token against a correctly verifying endpoint, showing rejection
- for a secret claim, the recovered key value and the recomputed signature that the server accepted
- the decoded claims of the accepted token, showing which claim produced the elevated access

## Impact bar

**Reportable:** a forged, confused, or replayed token is accepted by a protected endpoint and returns another identity's data or a privilege the issuer never granted.

**Informational:** a decodable token with no signature verification but no protected endpoint that trusts the claims, or a long-lived token with correct verification.

**Not a finding:** a client-side route guard honouring a forged token while the API rejects it.
