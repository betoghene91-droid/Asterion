# web.oauth — OAuth redirect_uri bypass

Every variant of this class is the same question asked about a different parser: does
the authorization server's notion of "the same redirect_uri" match the browser's notion
of "the same origin as the registered one". The finding is a code or token arriving at a
host we control. A redirect_uri that merely looks odd but still resolves to the
registered host is not a finding.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any login flow with `client_id` and `redirect_uri`, which includes most
SSO front doors, "Sign in with" buttons, and third-party app marketplaces. High-yield
shapes:

- **Prefix and path-prefix matching**, satisfied by appending `@attacker.tld` in the
  userinfo position or by a `..` path segment.
- **Suffix allowlists** defeated by a registered-looking domain we own.
- **Multiple registered URIs** where the mobile scheme or staging host is the weak one.
- **No PKCE on a public client**, where an intercepted code is immediately redeemable.
- **Implicit grant** returning a token in the fragment, readable by any script on the
  landing page.

Waste of time when the server matches redirect_uri by exact string against a short
allowlist and enforces PKCE with S256.

## How to confirm it is even reachable

- **Learn the registered URI first.** Start a normal flow and read where it goes; error
  messages on a bad redirect_uri often name the expected value.
- **Classify the comparison.** Exact match means look for a second registered URI; prefix
  and suffix matching mean look for a string that satisfies it while resolving elsewhere.
- **Distinguish parser mismatch from open redirect.** A bypass works when the
  authorization server validates the string but the browser resolves it to our host.
- **Check PKCE before claiming impact.** It decides whether a stolen code is worth
  anything, and that changes the severity substantially.
- **Confirm the code reaches us, not just that a 302 happened.** The redirect Location must
  carry the code to our listener.

## Discriminating questions

1. Does the authorization server compare redirect_uri by exact string, or by prefix, suffix, path-prefix, or regex match?
2. Can a path be appended to the registered URI, such as `..%2f` or `/callback/../../attacker`, so the browser still lands on the registered host but the path serves our content?
3. Can a subdomain or a sibling domain satisfy a suffix check, as `example.com.attacker.tld` or `attacker-example.com` would?
4. Is a second, looser redirect_uri registered for the client — a mobile scheme, a localhost URL, or a partner host — that accepts a code without the same checks?
5. Does the server enforce PKCE, and if so can the code be redeemed without our verifier, which decides whether interception is useful?
6. Is the state parameter validated on the callback, or can a login CSRF let us bind the victim's flow to our own account?
7. Does the flow use the implicit grant, returning a token in the fragment where any script on the landing page can read it?
8. Is the code bound to a client secret or a client id we do not have, making interception alone insufficient?

## Common false positives

- The redirect_uri is rejected with an explicit invalid_request error, which is the allowlist working
- A path can be appended but the browser is still on the registered origin, so our server never receives the code
- The code arrives at our host but PKCE is enforced and we have no verifier, so it cannot be redeemed
- The code is single-use and already consumed by the legitimate client before our request
- The looser redirect_uri we found belongs to a different client id that cannot access the target's scopes
- The redirect 302s to our URL but strips the code, or replaces it with an error

## What a minimal PoC must demonstrate

- the authorization request with the crafted redirect_uri quoted verbatim, including any encoding
- the redirect response showing the browser sent to our host with a code or token in it
- the code value received on our listener, and the token exchange that succeeds, or a statement PKCE blocked it
- a control request with the legitimate redirect_uri, showing the flow completing normally on the real host
- the scopes granted, tying the intercepted code to the user data it unlocks

## Impact bar

**Reportable:** an authorization code or token reaches a host we control and is redeemed with the victim's scopes, or reaches us with PKCE as the only remaining barrier (stated as such).

**Informational:** a bypass that delivers a code we cannot redeem because PKCE is enforced, or a looser registered URI belonging to a client without the target's scopes.

**Not a finding:** an invalid_request rejection, or a redirect that stays on the registered origin.
