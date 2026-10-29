# web.cors — CORS misconfiguration with credentials

CORS is a browser-enforced policy, so the only version of this that matters is
the one a browser will honour. An `Access-Control-Allow-Origin` that reflects our
`Origin` is interesting; the same header accompanied by
`Access-Control-Allow-Credentials: true` and no `Vary: Origin` is a finding. A
reflect-without-credentials endpoint is a deliberate public API and reporting it
costs credibility.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time wherever an API is consumed by a separate front-end origin: SPAs on a
different host, mobile webviews, partner integrations, and any `/api/` host that sets
cookies. High-yield shapes:

- **Reflect-anything middleware** added to make a staging front-end work and never
  narrowed in production.
- **Suffix and prefix allowlists** (`endsWith('example.com')`) satisfied by
  `example.com.attacker.tld` or `nottherexample.com`.
- **`Origin: null` accepted with credentials**, reachable from a sandboxed iframe.
- **Credentialed endpoints missing `Vary: Origin`**, where a CDN caches one origin's
  ACAO and replays it to another.

Waste of time on a fully public, unauthenticated JSON API that returns the same body
to everyone — the wildcard there is intentional and harmless.

## How to confirm it is even reachable

- **Send a controlled Origin and read the headers.** `https://attacker.example` first,
  then `null`, then a lookalike of the real domain.
- **Check ACAC on the same response.** Reflection alone is noise; reflection with
  `Access-Control-Allow-Credentials: true` is the finding.
- **Confirm the preflight passes.** A credentialed `GET` with a custom header triggers
  OPTIONS; if that is rejected, the read cannot happen.
- **Confirm the session travels as a cookie.** An `Authorization: Bearer` design
  immunises the endpoint, because attacker script cannot set that header cross-origin.
- **Check SameSite.** `SameSite=Lax` or `Strict` blocks the cross-site attach for most
  requests; `None` without `Secure` is the exploitable combination.

## Discriminating questions

1. Does the response reflect an arbitrary attacker-supplied Origin into Access-Control-Allow-Origin, or return a fixed value, or omit the header entirely?
2. Is Access-Control-Allow-Credentials true on that same response, which is what turns reflection into a cross-origin credentialed read?
3. Is the reflected origin matched against an allowlist by exact string comparison, or by a prefix, suffix, or regex a lookalike domain can satisfy?
4. Does the endpoint also answer a preflight with the requested method and headers allowed, or does the credentialed read fail at OPTIONS?
5. Is Origin: null accepted with credentials, which a sandboxed iframe or a data URL can supply without any attacker domain?
6. Does the response carry Vary: Origin, or will a shared cache serve one origin's ACAO header to a different origin?
7. Is the session credential a cookie with SameSite=None, so the browser will attach it on a cross-site fetch from the attacker page?
8. Does the data returned differ per user, or is it identical for every caller and therefore already public?

## Common false positives

- ACAO reflects the origin but Access-Control-Allow-Credentials is absent or false, so the browser blocks credentialed reads
- The endpoint requires an Authorization header, which an attacker page cannot set cross-origin without its own token
- The allowlist compares the parsed origin host exactly, and every lookalike attempt fails the comparison
- The data returned is identical for anonymous and authenticated callers, so a cross-origin read reveals nothing
- The wildcard ACAO is returned with credentials false, which is the standards-compliant public-API configuration
- The preflight rejects the attacker origin's method or headers, so the actual request is never sent

## What a minimal PoC must demonstrate

- the full response headers for a request carrying our controlled Origin, with ACAO and ACAC both quoted
- the same endpoint with a benign Origin, showing the header either absent or restricted to the legitimate origin
- for impact, a browser page on our origin that reads the response body cross-origin and displays authenticated data
- the cookie attributes of the session being read, showing the browser would attach it cross-site
- confirmation the endpoint is not returning identical public data to an unauthenticated caller

## Impact bar

**Reportable:** reflected origin plus credentials plus a demonstrated cross-origin read of authenticated, user-specific data in a real browser.

**Informational:** reflection without credentials, wildcard with credentials false, or a credentialed read of data that is identical for every caller.

**Not a finding:** a public API returning the same JSON to everyone, or a header that only appears when no cookies are involved.
