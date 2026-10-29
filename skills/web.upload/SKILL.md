# web.upload — unrestricted file upload

The finding is not "the upload accepted a .php file". It is "the uploaded file is
served back from the application's own origin as content a browser will execute, or a
server will interpret". Accepting the extension and then serving the bytes as
`application/octet-stream` with `Content-Disposition: attachment` is a hardened upload,
not a vulnerability.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on avatar, attachment, import, theme, and document surfaces — especially
anywhere an admin later opens the uploaded file. High-yield shapes:

- **SVG avatars** served inline from the app origin: a stored-XSS primitive against
  whoever views the profile, including staff in an admin panel.
- **HTML-ish exports** (`.html`, `.htm`, `.xhtml`) served without `Content-Disposition`.
- **Upload directories inside a document root** with an execute handler left enabled.
- **Archive extraction** (zip, tar) with traversal in entry names writing outside the
  target directory.

Waste of time when files go to object storage on a cookieless domain, or when the server
re-encodes and renames every upload deterministically.

## How to confirm it is even reachable

- **Fetch the file back before claiming anything.** The download response headers decide
  the class: same origin plus a renderable type is the finding; a separate origin or an
  attachment disposition is not.
- **Check which origin serves it.** An S3 or CDN host with no cookies on the app domain
  neutralises stored XSS against authenticated users.
- **Test the server, not the form.** Bypass any client-side check and submit directly;
  only the server's decision matters.
- **Look for a viewer.** An upload nobody opens is a storage-cost issue; the impact comes
  from a staff member or another tenant rendering it.
- **Check the filename handling.** Traversal in the stored name can turn an upload into an
  arbitrary write, which is a much stronger finding than a served SVG.

## Discriminating questions

1. Does the server validate the file by extension, by declared Content-Type, by magic bytes, or by re-encoding the content?
2. Is the stored file served from the application's own origin, or from a separate storage host or CDN domain with no shared cookies?
3. What Content-Type and Content-Disposition does the download path return, and will a browser render HTML or SVG inline?
4. Can the server-side path that stores the file execute it — an Apache or nginx handler, a CGI directory, or a framework that loads templates from the upload directory?
5. Does the filename survive to the stored path, allowing traversal or a null byte to place the file outside the intended directory?
6. Is the file reachable without authentication, and can it be fetched by another user, making stored XSS against staff the realistic impact?
7. Does the validation happen on the client, in a way a direct request bypasses entirely?
8. After re-upload of the same name, does the old content persist behind a cache, letting a previously reviewed file be swapped?

## Common false positives

- The file is stored on a separate origin from the application, so script in it runs in an origin with no session
- The download response serves the bytes as an attachment with a non-renderable Content-Type
- The server re-encodes images, stripping any embedded markup and metadata
- The dangerous extension was accepted but the file is stored with a random name and no execute handler
- The upload requires a privileged role, making the write an authorized action rather than an escalation
- Only the extension in a client-side check was bypassed, while the server rejected the same file on direct submission

## What a minimal PoC must demonstrate

- the upload request with the filename, declared type, and actual bytes described
- the fetch of the stored file, with the response Content-Type, Content-Disposition, and origin quoted
- for a stored-script claim, a browser rendering the fetched file and executing a marker in the app origin
- for a server-execution claim, the evidence the server interpreted the file rather than returning it
- a control upload of a benign file of the same type, showing the difference is the payload and not the endpoint

## Impact bar

**Reportable:** an uploaded file is served from the app origin as content a browser executes, or is interpreted by the server, demonstrated by fetching it back with the headers and a browser execution or server interpretation.

**Informational:** acceptance of a dangerous extension that is stored inert on a separate origin, or an upload reachable only by a privileged role.

**Not a finding:** a client-side extension check bypassed while the server rejects the file.
