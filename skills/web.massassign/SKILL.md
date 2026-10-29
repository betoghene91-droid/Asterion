# web.massassign — mass assignment

This class lives entirely in the gap between a request schema and the model it is
bound to. Adding `"role":"admin"` to a body is a probe; the finding is that the
field was **persisted**, is **read back**, and **changes an authorization outcome**.
A field silently dropped by a strict schema is the correct behaviour and not a bug.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on every create and update endpoint in a product with roles or billing.
High-yield shapes:

- **ORMs that bind bodies wholesale**: `Model(**body)`, `Object.assign(user, body)`,
  `@ModelAttribute`, Rails `params.require(:user).permit!`.
- **Nested association binding** — `"account": {"plan": "enterprise"}` — where the
  outer object is allowlisted and the nested one is not.
- **Registration and invite endpoints** where the field is set before the account has
  any authorization context to check against.
- **GraphQL input types** that expose a model field with no resolver-level restriction.

Waste of time when a strict schema (zod, pydantic with `extra=forbid`, a strong-params
allowlist) rejects or drops unknown keys, which the read-back proves quickly.

## How to confirm it is even reachable

- **Get the legitimate payload first.** The client's own request defines which fields are
  expected; anything beyond that list is your probe set.
- **Enumerate from the model, not from imagination.** A read of the subject's own view
  usually reveals the security-relevant fields: role, plan, verified, tenant.
- **Read back through a different request.** An echo in the update response proves
  nothing; a fresh `GET` proves persistence.
- **Establish the authorization consequence.** Without a before-and-after privileged
  request, a persisted field is an inconsistency rather than an escalation.
- **Try both representations.** JSON and form-encoded bodies frequently take different
  binding paths, and one is often unfiltered.

## Discriminating questions

1. Does the endpoint bind the request body directly to a model or ORM object, or to an explicit per-field allowlist?
2. Which fields on the underlying model are security-relevant: role, isAdmin, verified, tenantId, ownerId, balance, credits, plan, or status?
3. After sending a security-relevant field, does reading the subject back show the value persisted, or was it dropped?
4. If it persisted, does the change alter an authorization decision on a later request, or is the field only cosmetic?
5. Is there a nested object or association in the body that binds through to a related record, such as `account.plan` or `organization.role`?
6. Does the same body work on a registration or invitation endpoint, where the field would be set before any authorization context exists?
7. Is the field writable only on create and ignored on update, or the reverse, and does the framework's filtering differ between them?
8. Does a JSON-vs-form content-type change the binding path, so one representation is filtered and the other is not?

## Common false positives

- The field is accepted in the request but silently dropped, and the read-back shows the original value
- The field persists but is never consulted for any authorization decision, making it a cosmetic inconsistency
- The endpoint requires an admin session, so setting role is an authorized administrative action
- The read-back shows the field because the response echoes the request rather than because it was stored
- A framework-level allowlist filters the body before the handler, and the probe only proved the JSON parser accepts extra keys
- The field is persisted on the caller's own record where they are already permitted to change it

## What a minimal PoC must demonstrate

- the exact request body with the injected field quoted, and the field's absence from the legitimate client payload
- the read-back after a fresh request, proving the value was persisted rather than echoed
- the authorization consequence: a follow-up request that now succeeds or returns data it did not before
- a control request with the field omitted, showing the pre-change authorization outcome
- the field's location in the model or schema, tying the persisted value to the decision it affects

## Impact bar

**Reportable:** a field the client never sends is persisted and a follow-up request shows it changed an authorization or billing outcome.

**Informational:** a security-relevant field that persists but is never consulted, or a field writable only on the caller's own record within their existing permissions.

**Not a finding:** a field the schema drops, or a value that appears only because the response echoes the request body.
