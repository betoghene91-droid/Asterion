# web.reset — password reset token poisoning

A reset flow builds a URL from a host the request can influence, and mails it to a
victim. The token travels inside that URL. The finding is precise: the link the victim
receives points at a host we control, and that host sees a valid token. A reflected
Host header with no effect on the email is not this bug.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any product with password reset, email verification, invitation, or
magic-link flows — the same link-building code serves all four. High-yield shapes:

- **Frameworks that default the URL host to the request Host** (Rails
  `*_url` helpers without `default_url_options`).
- **Reverse proxies that pass X-Forwarded-Host through** without stripping or validating
  it, behind an app that trusts it unconditionally.
- **Multi-tenant apps** that build the link from a tenant subdomain derived from the
  request.
- **Passwordless magic links**, where the token in the URL is the entire authentication
  credential.

Waste of time when the email body is generated from a hardcoded base URL and the header
is used only for display or logging.

## How to confirm it is even reachable

- **Read the actual email.** The only trustworthy evidence is the delivered message, not
  the API response and not the header echo. Use a mailbox we control.
- **Confirm the victim account exists and would receive mail**, then decide whether the
  test should proceed against a throwaway account instead.
- **Test each header separately.** Host, X-Forwarded-Host, X-Forwarded-Server, and
  Forwarded may be handled differently by proxy and app.
- **Check the CSRF story.** A reset trigger that needs a token and a same-site cookie may
  not be forceable, which limits the impact claim even when poisoning works.
- **Check token binding.** A token tied to the requesting IP or session cannot be redeemed
  from the attacker host, which downgrades the finding.

## Discriminating questions

1. Does the reset email build its link from the request's Host header, X-Forwarded-Host, a Referer value, or a configured base that is only sometimes used?
2. Does the injected host actually appear in the link the victim receives, or is the link built from a server-side constant regardless of the header?
3. Does the token appear in the path or query of the poisoned link, so an attacker host would receive it and could then use it?
4. Does the reset flow validate the Host header against a configured allowlist on the request that triggers the email, or only on other routes?
5. Is the poisoned request a POST the attacker can force cross-site, or does it need a same-origin form with an anti-CSRF token?
6. Does the app accept a forwarded-host value only from a trusted proxy list, or from any client that sets the header?
7. Does the token remain valid after the attacker's host receives it, or is it bound to the requesting IP or session in a way that blocks reuse?
8. Is there a second poisoning vector, such as a language or template parameter that rewrites the link's domain?

## Common false positives

- The Host header is reflected in the response body but the outgoing email uses a configured base URL
- The link is poisoned but the token is bound to the victim's IP or session, so the attacker host cannot use it
- The reset request requires an anti-CSRF token and same-site cookies, so the poisoned request cannot be forced cross-site
- The email link uses a relative path that the victim's client resolves against the legitimate host
- The token in the poisoned link is single-use and already consumed by the legitimate delivery
- A forwarded-host header is ignored because the app only trusts it from a proxy address the attacker cannot spoof

## What a minimal PoC must demonstrate

- the exact reset request with the poisoned host header quoted, against the victim's identifier
- the email as actually delivered, showing the link and the attacker host in it
- the token extracted from that link, and evidence it is a live reset token for the victim's account
- a control reset request without the header, showing the link points at the legitimate host
- for full impact, proof the token is usable — or an explicit statement that using it was not attempted

## Impact bar

**Reportable:** the delivered reset email contains a link on an attacker-controlled host carrying a live token, shown from the actual message with a legitimate-host control.

**Informational:** a host header reflected into a response but absent from the delivered email, or a poisoned link whose token is bound to the victim's address or session.

**Not a finding:** a reflected Host header with no effect on the email, or a link the victim's client resolves against the legitimate origin.
