# web.takeover — subdomain takeover

A DNS name still points at a third-party service that no longer recognises it.
Two things have to be true, and they are tested in that order: the pointer must
dangle, and the service must let *us* claim the name. A CNAME to an unclaimed
bucket sounds like a finding until the bucket name turns out to be globally
unique and already reserved by the provider.

This pack is `cls: infra` / `family: dns` because the playbook it maps to
declares that, even though its digest class id is `web.takeover`.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any large domain estate, where old marketing pages, status sites,
docs, and campaign hostnames are pointed at SaaS providers and then forgotten.
High-yield shapes:

- **Object-storage-backed static sites** (S3, GCS, Azure Blob) where the bucket name
  is derivable from the hostname and the bucket was deleted.
- **PaaS and CDN custom domains** (Heroku, Netlify, Vercel, Fastly, CloudFront) whose
  app or distribution was removed but whose DNS record remained.
- **Marketing and campaign subdomains** created for a launch and abandoned.
- **NS delegations** to a provider whose zone was released — the strongest version,
  because it yields the whole subtree, not one page.

Waste of time on a name that resolves nowhere, or where the provider has disabled
unclaimed-name serving for the whole platform.

## How to confirm it is even reachable

- **Resolve the full chain first.** A CNAME to a third-party host is the precondition;
  without one there is nothing to claim.
- **Identify the provider's unclaimed signature.** Each service has a distinctive one:
  a NoSuchBucket XML body, a Heroku 'no such app' page, a GitHub Pages 404. A generic
  404 is not a signature.
- **Check claimability before claiming.** Read the provider's namespace model. A bucket
  name is global and claimable; a distribution id is not reconstructible from a CNAME.
- **Check what trusts the name.** Cookie scope on the parent domain, an existing TLS
  certificate, and inbound links are what turn a dangling record into impact.
- **Prefer the safe proof.** Serving a static marker file beats provisioning anything
  billable or accepting terms in the target's name, and is trivially reversible.

## Discriminating questions

1. What does the DNS chain actually resolve to — a CNAME to a third-party hostname, or an A record to a provider IP the provider would also serve for an unclaimed name?
2. Does the third-party service respond with its unclaimed-name signature, such as a no-such-bucket error, a 404 from the CDN edge, or a provider-specific takeover page?
3. Is the resource name in the CNAME target uniquely claimable by us, or does the provider namespace it under an account or a tenant that the name alone cannot reconstruct?
4. Is the record an NS or MX delegation rather than a CNAME, which would let us serve arbitrary content or receive mail rather than only hosting a page?
5. Has the third-party service retired the feature or changed its claim semantics, so that the dangling record is no longer claimable at all?
6. Does the parent domain sit inside the target's cookie scope, so content on the subdomain receives cookies scoped to a common parent?
7. Is the DNS record still actively used by a live integration, meaning the service expectation exists but is temporarily misconfigured rather than abandoned?
8. Would claiming the name require creating a billable resource or accepting terms in the target's name, which changes what we are permitted to do?

## Common false positives

- The CNAME target returns a provider error page but the name is not claimable because it is namespaced under an account we cannot reconstruct
- The record points at a provider that has since disabled unclaimed-name serving, so the dangling pointer is inert
- The subdomain is referenced only by that record with no certificates, cookies, or links, so nothing trusts it
- The provider returns a generic 404 that is identical for every hostname, not a service-specific unclaimed signature
- An NXDOMAIN on the CNAME target, which means the third-party name itself is gone rather than available to claim
- A wildcard DNS record answering for a name that has no explicit record, which looks like a dangling pointer but is a routing default

## What a minimal PoC must demonstrate

- the full DNS resolution chain, with the CNAME target and the resolver output quoted
- the provider response for the unclaimed name, with the takeover-specific signature identified
- for a claim, content we control served on the target's own hostname, fetched by its real name rather than by an IP
- evidence of what trusts that name: the cookie scope, a certificate issued for it, or a link from the main application
- a control fetch of the same hostname before the claim, showing the provider's unclaimed response instead of our content

## Impact bar

**Reportable:** content we control is served on the target's hostname, or an NS/MX delegation in the target's domain is claimable, demonstrated by fetching the real hostname.

**Informational:** a dangling CNAME whose target is not claimable under the provider's namespace model, or a dangling record that nothing (cookies, certificates, links) trusts.

**Not a finding:** a generic provider 404, an NXDOMAIN CNAME target, or a wildcard record.
