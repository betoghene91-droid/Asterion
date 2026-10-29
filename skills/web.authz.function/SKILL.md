# web.authz.function — missing function-level authorization

Object-level authorization asks whether *this* caller may see *this* object.
Function-level asks a blunter question: may this caller invoke this endpoint at all.
The gap usually exists because the check lives in a UI router, a menu component, or a
middleware chain that one route was registered outside of.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any product with roles: staff panels, billing controls, user
management, feature toggles, audit logs, impersonation, and export tools. High-yield
shapes:

- **SPA admin bundles** where the route guard is a client-side check and the API is
  unguarded because "the UI never calls it".
- **Version skew**: `/api/v1/admin` guarded, `/api/v2/admin` registered on a router that
  bypasses the middleware.
- **Action-in-body endpoints** that switch on an `action` or `op` field inside an
  otherwise ordinary update route.
- **Support and impersonation features** that grant a superset of permissions through a
  header or a flag rather than a role.

Waste of time when every route in the framework is wrapped by one permission decorator
and the decorator is bound to the role server-side.

## How to confirm it is even reachable

- **Enumerate before testing.** The endpoints that matter are usually absent from the
  low-privilege UI: pull them from the privileged bundle, a JS chunk, an OpenAPI
  document, or the route table.
- **Hold role constant and vary only the caller.** A comparison that also changes the
  payload, the version, or the method proves nothing about authorization.
- **Separate 401 from 403.** Anonymous failing while low-privilege succeeds is the
  signature of a missing function-level check; both failing is a working gate.
- **Look for the unguarded sibling.** The collection route, the per-item route, the
  count and search routes, and every alternate method are separate registrations.
- **Check where the role comes from.** A permission read from a client-set field is a
  different, stronger finding than a missing check.

## Discriminating questions

1. Which privileged endpoints exist, and is the role check enforced in the handler, in shared middleware on that route group, or only in the client that hides the menu item?
2. When called with a low-privilege session, does the endpoint return 200 with privileged data, or 401 and 403 that indicate a real gate?
3. Does the anonymous call fail with 401 while the low-privilege call succeeds, isolating authorization from authentication?
4. Is the role or permission read from a token claim, a session record, or a request field the caller can set?
5. Does a method or path variant reach the same handler without the guard, such as PATCH instead of PUT, or a trailing slash, or a different API version prefix?
6. Are administrative operations exposed as separate actions on an otherwise authorized endpoint, selected by a body field rather than a distinct route?
7. Does a lower role reach a superset of another role's permissions through a role hierarchy, an impersonation feature, or a support-mode header?
8. Is the guard applied to the collection route but omitted on the per-item route, or the reverse?

## Common false positives

- The endpoint returns 403 for the low-privilege session, which is the authorization working rather than failing
- The low-privilege session was actually issued an admin-equivalent role by the test setup, so the comparison was never unprivileged
- The data returned is public information that the same low-privilege user can already see in the normal UI
- The anonymous request returned 200 but with a login page body, which is a redirect or SPA shell rather than protected data
- The endpoint is a stub or feature-flagged off for everyone, so its reachability does not depend on the caller's role
- The privileged action succeeded but was recorded and reverted, or applied only to the caller's own records

## What a minimal PoC must demonstrate

- the privileged endpoint and the exact request issued with the low-privilege session's credential
- the response body showing data or an effect that the UI and role model deny to that session
- the anonymous call to the same endpoint returning 401 or 403, isolating authorization from authentication
- the same request with a genuinely privileged session, so the delta is the role and nothing else
- for a state-changing claim, the resulting privileged state observed from the privileged session afterwards

## Impact bar

**Reportable:** a low-privilege session invokes a privileged function or reads data the role model denies, with anonymous and privileged baselines isolating the role as the only variable.

**Informational:** a privileged endpoint reachable by a session whose role turns out to be equivalent, or one returning only data the same user already sees in the ordinary UI.

**Not a finding:** a 403, a login redirect, or a client-side hidden menu with a server-side gate behind it.
