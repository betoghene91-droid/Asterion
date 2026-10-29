# web.idor — broken object-level authorization

The whole class reduces to one comparison: the same object identifier, fetched by
two principals who should not share it, returning the same body. Everything else —
sequential ids, UUIDs, a helpful `userId` field — is a guess about likelihood, not
a finding. The negative control is what separates a real authorization gap from an
endpoint that simply returns 200 with an empty payload for anything it cannot see.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any endpoint whose path or body carries an object reference: `/api/v1/
invoices/{id}`, `?account_id=`, `{"project": 42}`. High-yield shapes:

- **Multi-tenant SaaS resources** where a single missed `WHERE tenant_id = ?` exposes
  every customer.
- **Child resources authorized via the parent** — a permitted project id granting
  access to another team's attachments.
- **Bulk and export endpoints** that take a list of ids and check authorization on the
  first one, or on none.
- **GraphQL node lookups and REST aliases** that resolve by global id, bypassing the
  scoped resolver the UI uses.

Waste of time when the reference is a verified signed token and the response is a
redirect to a stored URL the server does not read on the caller's behalf.

## How to confirm it is even reachable

- **Prove the two principals are genuinely separate.** Two accounts in one tenant share
  authorization by design; a "leak" between them is not a finding. Check the tenant
  claim in both tokens.
- **Capture the identifier from A's own session**, not from documentation, so the test
  cannot be dismissed as a stale or invented id.
- **Establish the negative control early.** If a nonexistent id also returns 200 with a
  body, the endpoint is defaulting and every later result is meaningless.
- **Check read and write separately.** Many systems authorize `GET` and forget `PATCH`,
  `DELETE`, or the `POST /share` variant.
- **Check the enumeration story.** An id that is not guessable still leaks if a listing,
  a CSV export, or an email link hands it to the wrong principal.

## Discriminating questions

1. Which identifier in the request selects the object, and is ownership checked against the caller's tenant or assumed from the identifier being hard to guess?
2. When principal B requests A's identifier, does the response contain A's object body, or a 200 with an empty or default object?
3. Does a nonexistent identifier return 404 while a foreign identifier returns 200, proving the endpoint resolves objects before it authorizes them?
4. Is the authorization decision made from a session claim, a token scope, or a client-supplied tenant field such as a header or query parameter?
5. Does the same gap exist on the write paths for that object — update, delete, share, export — or only on read?
6. Is the identifier exposed in a listing, a URL, an email, an export, or a predictable sequence that lets B learn A's identifiers without guessing?
7. Are nested or child resources authorized through the parent, so that a permitted parent id grants access to a child belonging to another owner?
8. Does the endpoint behave differently for a foreign identifier belonging to a deleted or soft-deleted owner, bypassing the ownership join entirely?

## Common false positives

- Principal B receives 200 with an empty object or a default record, which is a scoping bug in appearance only and leaks nothing
- Both test principals belong to the same tenant, so the access is authorized and the test proved nothing
- The identifier is a signed or encrypted token that the server verifies, so a modified value fails before any lookup
- The endpoint returns 403 for the foreign identifier, which is the control working correctly rather than a bypass
- The object is genuinely public by design, such as a published document or a shared link the owner created
- The apparent leak is cached content from the tester's own earlier request in the same session

## What a minimal PoC must demonstrate

- the identifier captured from principal A's own authenticated session, shown with A's request
- principal B's request for that identifier and the response body proving it is A's object, with both tenants named
- a negative control where B requests a nonexistent identifier and receives 404, proving ids are resolved rather than defaulted
- a same-principal control where A requests the same identifier and receives the same body, isolating authorization from routing
- for a write claim, the state change observed afterwards in A's view of the object

## Impact bar

**Reportable:** principal B receives or modifies principal A's object, demonstrated with both sessions, a same-principal control, and a nonexistent-id control.

**Informational:** an endpoint that returns 200 with an empty or default object for foreign identifiers, or a leak limited to non-sensitive metadata that the object's owner already publishes.

**Not a finding:** access between principals inside one tenant, or to an object that is public by design.
