# web.ssrf — server-side request forgery

SSRF is easy to claim and hard to prove, because the interesting question is
never "did a request leave the box" — it is "did the *server* fetch an
attacker-chosen destination, and did the attacker learn anything from it".
A DNS hit on a collector proves egress exists. It does not prove the fetcher
returned a body, reached an internal-only service, or touched cloud metadata.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time whenever a server takes a URL, host, webhook, avatar, import source,
feed, or "fetch this for me" argument. High-yield shapes:

- **Import and preview features**: "import from URL", link unfurlers, PDF and
  screenshot renderers, RSS and sitemap ingesters, OAuth avatar fetchers.
- **Webhook and callback configuration**: the app proves your endpoint by calling
  it, which is a fetch primitive with an attacker-chosen target by design.
- **Proxy and image-resize endpoints** that take a remote source and return bytes.
- **Multi-tenant document conversion** where a worker fetches a URL supplied by one
  tenant and stores the result where another tenant can read it.

Waste of time when the destination is a constant, when the host is assembled from
an enum of known providers, or when the fetch happens in the browser.

## How to confirm it is even reachable

- **Confirm the fetch is server-side.** A request that carries the tester's own IP,
  a browser `User-Agent`, or `Sec-Fetch-*` headers is client-side and out of class.
- **Confirm the value is attacker-influenced at all.** A URL built from a fixed base
  plus an ID is only interesting if the base or a redirect from it is steerable.
- **Find the egress the worker actually uses.** A front proxy with an allowlist says
  nothing about an async worker that joins the queue behind it.
- **Enumerate internal reachability before claiming impact.** The finding lives or
  dies on whether something internal answers: metadata, a Redis or Elasticsearch
  port, an admin panel on localhost, a sibling service on a private DNS name.
- **Check the metadata story end to end.** Reaching 169.254.169.254 is not impact
  unless a token or credential is in the response for that instance's IMDS version.

## Discriminating questions

1. Which parameter reaches an HTTP client or resolver server-side, and is the value used whole, or only as a host, or only as a path appended to a fixed base?
2. Does the fetcher follow redirects, and if so is the allowlist applied to the first URL only or re-checked on every hop of the chain?
3. Is the destination validated by parsing and then re-serialising the URL, or by substring or prefix matching on the raw string that a userinfo or fragment can defeat?
4. Can the request reach 169.254.169.254, localhost, or an RFC1918 address, and is that blocked inside the fetcher or only by a front proxy that the worker bypasses?
5. Does the response body, status code, or measurable timing return to the attacker, making this full-read SSRF rather than blind egress?
6. Is the value validated at submission time and fetched later by an asynchronous worker, leaving a DNS-rebinding window between the check and the use?
7. Does the underlying client accept non-HTTP schemes such as gopher, file, or dict, turning a fetch into a protocol-level request against an internal daemon?
8. Does the fetching process hold cloud instance credentials, a metadata token, or a service-account key in its environment or filesystem?

## Common false positives

- A callback arrives on the collector but no response content ever returns and no internal service answers, which is blind egress at most
- The destination is checked against an exact list of literal hosts after parsing, not a prefix, suffix, or regex match on the raw string
- Only DNS resolution leaves the network and the request to our host is never actually issued by the target
- The URL is fetched by the visiting browser rather than the server, so the request carries the tester's address and is not SSRF at all
- The proxy rejects every scheme except https and resolves the host to a pinned first-party address
- The internal address that responded belongs to our own test harness or a shared egress proxy, not to the target's network

## What a minimal PoC must demonstrate

- the exact request that triggered the fetch, with the injected value quoted verbatim and the parameter named
- a hit on a listener we control that arrived from the target's server egress rather than from our own browser
- for a read claim, the internal response body proving content we could not obtain by calling that address ourselves
- a control run with the parameter set to a benign public URL that produces no internal content and no callback
- evidence that the responding address is internal to the target, distinct from our own infrastructure and its addresses

## Impact bar

**Reportable:** the server fetches an attacker-chosen destination and the attacker gets back content, or reaches an internal-only service or cloud metadata endpoint. Say which internal destination answered and quote what came back.

**Informational:** blind egress where a callback confirms the fetch but nothing is returned and no internal service is reachable, or a fetch that only reaches already-public hosts the attacker could call directly.

**Not a finding:** a browser-side fetch of our URL, a DNS-only interaction with no request, or a destination that is a hardcoded constant.
