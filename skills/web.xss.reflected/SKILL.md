# web.xss.reflected — reflected cross-site scripting

Reflection is the easy half and it is the half that gets reported wrongly. The
only claim worth making is that a browser executed our script with the target's
origin, which needs a DOM observation — a 200 whose body contains our string
proves that the string is echoed, not that it is code in a live context.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any parameter reflected into an HTML document a user loads: search
terms, error messages, return URLs, language and theme pickers, name and filename
echoes, and 404 pages that repeat the path. High-yield shapes:

- **Error and validation pages** that echo the offending value back for convenience.
- **`return`, `next`, `redirect`, and `lang` parameters** echoed into a link or a
  hidden input, where attribute-context breakout is usually forgotten.
- **Server-rendered templates** with an unescaped-output construct: `|safe`, `{!!`,`
  `{{{`, `<%-` used on request data.
- **JSON endpoints reflected into a client renderer** with an innerHTML-style sink.

Waste of time when the response is `application/json` and every consumer uses a
text-assigning sink, or when the only reflection is inside a header nothing renders.

## How to confirm it is even reachable

- **Read the sink context before choosing a payload.** An attribute context needs a
  quote to break out; an HTML text context needs a tag; a script context needs a
  string-literal break. A payload that ignores context fails for the wrong reason.
- **Probe the encoder, not the payload.** Send each dangerous character alone and see
  which are encoded. That tells you the context and the filter in one step.
- **Check whether decoding happens after encoding.** Double-encode and see if the
  server decodes once before writing it out.
- **Read the CSP header.** If it is enforcing and forbids inline script, an inline
  payload cannot be the demonstrated impact.
- **Confirm the request is forceable cross-site.** A GET with no anti-CSRF token is;
  a POST with a token and a same-site cookie usually is not.

## Discriminating questions

1. Which parameter is echoed into the response, and in what exact context does it land: HTML text, a quoted attribute, an unquoted attribute, a URL, or inside a script block?
2. Are the dangerous characters for that context encoded, and which ones survive — angle brackets, quotes, ampersand, backslash, or the closing sequence for the surrounding block?
3. Is the value decoded somewhere between the request and the sink, making a double-encoded payload land as live markup?
4. Does a Content-Security-Policy apply to the response, and does it forbid inline script and eval, or only report violations?
5. Is the reflection reachable on a GET request a victim can be made to issue, or does it require a method, header, or interaction the attacker cannot force?
6. Does a client-side sink such as innerHTML, document.write, or a framework escape hatch handle the value after the server echoes it?
7. Is the response type HTML, or is it JSON or text that only becomes executable once a browser sniffs or a client inserts it?
8. Would HttpOnly and a strict cookie policy limit what a successful execution actually yields, and is the session cookie flagged that way?

## Common false positives

- The payload is reflected but angle brackets arrive encoded, so it renders as visible text and never becomes an element
- The reflection sits in a JSON response consumed by a client that assigns it with textContent or an equivalent safe sink
- A CSP without unsafe-inline blocks the executed payload, so the reflection exists but the script does not run
- The reflection only occurs on a POST the attacker cannot deliver cross-site without a same-origin form and a matching token
- The value is reflected inside a script block as a properly quoted and escaped string literal, so breaking out requires a sequence that is escaped
- Execution was observed only after the tester manually pasted the payload into the console or edited the DOM by hand

## What a minimal PoC must demonstrate

- a headless browser load of the exact crafted URL and a DOM or console observation proving our script ran in the target origin
- the unique marker value injected, visible in the execution evidence rather than only in the raw response body
- a control load with the marker replaced by benign text, showing no execution and a normally rendered page
- the response context quoted exactly, so a reader can see why that character sequence was executable
- the document origin at execution time, confirming it is the target and not a data, blob, or sandboxed origin

## Impact bar

**Reportable:** a headless browser executes our script in the target's origin from a URL a victim can be induced to open, demonstrated with DOM evidence and a benign control.

**Informational:** an encoded reflection that renders as visible text, a reflection in a JSON body with no executing sink, or a payload blocked by an enforcing CSP.

**Not a finding:** a reflection with no execution, or execution only after manual DOM editing.
