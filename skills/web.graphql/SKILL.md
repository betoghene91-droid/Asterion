# web.graphql — GraphQL authorization gap

GraphQL makes this class common for a structural reason: authorization is
usually attached to the top-level query the UI happens to use, while the
object graph underneath is traversed by the client. One resolver on `user(id:)`
guarded, and the same object reachable through `team.members[].email` unguarded,
is the whole bug. Introspection only maps the surface — it never proves a gap.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any API with a `/graphql` endpoint, which is most modern SPAs and
mobile back-ends. High-yield shapes:

- **Guarded query, unguarded relationship**: `me { teams { members { email } } }` where
  only `me` was checked.
- **Mutations reachable by id** that trust a client-supplied identifier instead of the
  caller's context.
- **Field-level attributes** like `role`, `internalNotes`, `stripeId`, `apiKey` present on
  a type the caller can otherwise read legitimately.
- **Deprecated or legacy fields** left in the schema after the UI moved on, with the
  authorization written for the new path only.

Waste of time when authorization is enforced by a type-level policy applied to every
field of a type, or when every resolver re-reads ownership from the caller's context.

## How to confirm it is even reachable

- **Get the schema first.** Introspection if enabled; otherwise pull the query strings
  out of the client bundle, which is often richer than what introspection reveals because
  it shows what the app actually does.
- **Map which resolver holds the check.** In most frameworks it is the top-level field.
  Everything reachable *below* that field inherits no check at all.
- **Walk the graph from an object you legitimately own.** The foreign object you want is
  usually one hop from something you are allowed to see.
- **Try the mutation, not just the query.** Write paths often reuse a resolver's input
  type without the read path's scoping.
- **Watch the error shapes.** A distinct 'not found' versus 'forbidden' tells you whether
  the resolver scopes by tenant or checks a role.

## Discriminating questions

1. Is introspection enabled, and does the schema reveal types, fields, and mutations the UI never calls?
2. Which resolver enforces authorization: the top-level query, the type-level field resolver, or a framework directive applied per field?
3. Can a low-privilege caller reach another tenant's object by traversing a relationship from an object they legitimately own, such as team, members, or organization?
4. Does a nested field return a sensitive attribute (email, token, internal note, role) that the parent query's authorization was never written to cover?
5. Can a mutation be invoked directly with an identifier the caller does not own, bypassing the read-path check the UI relies on?
6. Does a field accept an argument such as a tenant, account, or user id that overrides the caller's own context rather than being scoped by it?
7. Can batching or aliasing in one document reach many objects in a single request, defeating a per-request rate or scope check?
8. Does a query allow unbounded depth or breadth through recursive relationships, making a costly nested traversal available to any caller?

## Common false positives

- Introspection is enabled, which is a schema disclosure observation and not an authorization gap on its own
- The nested field is authorized by a type-level resolver applied to every field of that type, which the test did not read
- The traversed relationship returns only the caller's own memberships by construction, so no foreign object is reachable
- A field named like a secret returns a masked or redacted value for non-owners
- The endpoint returns a not-authorized error for the nested path even though the parent query succeeds
- Batching produces many responses that are individually authorized, with no aggregate exposure

## What a minimal PoC must demonstrate

- the exact GraphQL document issued, with the aliases and arguments quoted
- the response showing another tenant's or role's data, with the principal that sent it named
- a control request for the same document from the owning principal, showing the same data, isolating authorization from schema shape
- the top-level query's authorization behaving correctly, so the gap is specifically in the nested path or the mutation
- for a mutation claim, the persisted change read back from the owner's session afterwards

## Impact bar

**Reportable:** a nested field or mutation returns or modifies another principal's data, demonstrated with the owning principal's control response.

**Informational:** introspection enabled on a production endpoint, or a schema disclosure with no field reachable beyond the caller's own scope.

**Not a finding:** enabled introspection alone, or a nested path that returns a not-authorized error.
