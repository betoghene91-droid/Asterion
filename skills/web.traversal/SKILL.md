# web.traversal — path traversal and arbitrary file read

The proof here is a file whose contents we could not have obtained otherwise, returned
by the target. A 200 and a body of any kind is not proof; the response must contain
content that is recognisably from outside the served directory, and the control must
show the same request with a legitimate path behaving normally.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any endpoint that names a file: downloads, document viewers, template
and language selectors, log viewers, export jobs, and image or font loaders. High-yield
shapes:

- **`?file=`, `?template=`, `?lang=`, `?doc=`** passed into `path.join` or string
  concatenation without a resolve-and-contain check.
- **Static handlers with a rewrite rule** that decodes the path after the confinement
  check.
- **Archive and backup endpoints** that stream a path from a request field.
- **Framework debug routes** (file browsers, log tailers) left enabled outside dev.

Waste of time when the parameter is matched against an enum, or when the resolved path is
compared against a canonical base directory after `realpath`.

## How to confirm it is even reachable

- **Establish the legitimate case.** Fetch a real file by its normal name first; without
  that baseline a traversal response cannot be interpreted.
- **Determine the encoding depth.** Try plain, single-encoded, double-encoded, and
  overlong forms, and note which layer decodes. A proxy and an application may each
  decode once.
- **Choose a distinctive target.** A container's `/etc/passwd` is fine; a mounted secret
  or the app's own config is stronger because it proves reach into the deployment.
- **Separate read from existence.** An error that reveals whether a path exists is an
  oracle, not a read, and should be reported as such or not at all.
- **Check whether the parameter is writable.** The same bug on an upload or delete path
  is far more serious and is often reachable with the identical payload.

## Discriminating questions

1. Which parameter becomes part of a filesystem path, and is it concatenated, joined with a base directory, or used directly?
2. Is the traversal sequence filtered once, recursively, or after decoding, so that a double-encoded or overlong form survives to the filesystem call?
3. Does the response return the file contents, or a distinguishable error that reveals existence and length without the bytes?
4. Is the base directory enforced by resolving the final path and comparing a prefix, or only by stripping `../` from the input string?
5. Does an absolute path in the parameter override the base directory, because the join is a plain string concatenation?
6. Is the same parameter used for a write, delete, or include, which would escalate a read into modification or code execution?
7. Does a normalisation layer decode the parameter twice, or does a proxy decode once before the application decodes again?
8. Would the file be returned from a container path the operator controls, such as a mounted secret or a config map?

## Common false positives

- The endpoint returns 200 with an empty or default body for every traversal attempt, because it falls back rather than resolving the path
- The traversal is blocked but a generic error page is returned, which is a rejection and not a read
- The file content appears in the response because it was cached from the tester's own earlier legitimate request
- The parameter is resolved against an allowlist of names before any path is built
- The returned content is a file inside the intended directory reachable by a legitimate name anyway
- A path-looking value is accepted but normalised by the framework's static handler, which confines it to its root

## What a minimal PoC must demonstrate

- the exact request with the traversal payload quoted verbatim, including any encoding layers
- the response body showing content that provably comes from outside the intended directory
- a control request for a legitimate file on the same endpoint returning its normal content
- for an absolute-path claim, the payload form that overrode the base directory, shown separately from the relative form
- for a write or include claim, the resulting state change or execution, not just a successful response

## Impact bar

**Reportable:** content from outside the intended directory is returned, proven by its content, with a legitimate-path control on the same endpoint.

**Informational:** a file-existence oracle, or a traversal that reaches a file already reachable by a legitimate path.

**Not a finding:** a 200 with a default body, a blocked request, or cached content from an earlier request.
