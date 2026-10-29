# web.sqli — SQL injection

The failure that wastes the most time here is mistaking a changed page for a
changed query. A payload that returns a different error, a shorter body, or a
500 has told you the input reached *something* — a WAF, a router, a validator —
and nothing about the database. This skill is about the differentials that only
a real query can produce, and about the controls that make them credible.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any parameter that filters, sorts, or selects: search boxes, report
builders, admin tables, export endpoints, and anything with a `sort=` or `order=`
argument. High-yield shapes:

- **ORDER BY and column-name arguments**, where bound parameters cannot be used and
  developers therefore concatenate.
- **Multi-value filters** (`ids[]=`, `status in (...)`) where an array is joined into
  an `IN` clause by string building.
- **Report and analytics endpoints** that accept date ranges, grouping, or field
  names — often the least-reviewed code in the product.
- **Legacy ORM escape hatches**: `where("x = '" + v + "'")`, `sequelize.literal`,
  `knex.raw`, `RawSQL`, `@Query` with string interpolation.

Waste of time on a value that is a parsed integer or UUID before it reaches the query,
and on endpoints where every special character provably fails identically.

## How to confirm it is even reachable

- **Establish a baseline distribution first.** Capture the response several times
  before injecting: length, hash, status, and latency. Without it every later
  difference is unfalsifiable.
- **Send special characters alone.** A quote, a double quote, a backslash, and a
  paren, each by itself. If a lone quote changes the response, the input is reaching
  a parser; if nothing does, the value is probably coerced first.
- **Determine the context.** String, numeric, identifier, and ORDER BY contexts need
  different payloads; a string payload inside an ORDER BY proves nothing.
- **Check for a rewriting layer.** Try the same logical payload with different
  encodings and comment styles; uniform blocking across all of them is a filter, not
  a query.
- **Find the read-back path.** Stored input that is later used in a query is often
  the real injectable point even when the write path is fully parameterised.

## Discriminating questions

1. Which parameter reaches a query unsafely, and is it concatenated into SQL text or bound as a parameter in a prepared statement?
2. Does a boolean pair such as a true and a false condition produce a consistent, repeatable difference in body, length, or status, independent of caching?
3. Does a time-delay payload produce a delay that scales with the requested seconds, rather than a flat timeout that any slow query would also cause?
4. Is the injection inside a quoted string, a numeric position, an identifier such as a column or table name, or an ORDER BY clause where bound parameters are illegal?
5. Can the same differential be reproduced on a second, structurally similar parameter or endpoint, or is it unique to one request shape?
6. Does the response distinguish a syntax error from an empty result set, letting the payload confirm it is being parsed as SQL rather than compared as a string?
7. Is the value stored and later used in a second query, such that the injection fires on a read path the original request never touched?
8. Does a WAF or normaliser rewrite the payload, so that a negative result reflects the filter rather than the query construction?

## Common false positives

- A 500 or a database error page caused by malformed input the application rejected before any query ran
- A body-length change from input reflection in the HTML, where the payload's own characters alter the page size
- A delay that reproduces identically with a syntactically invalid payload, indicating load or a fixed timeout rather than a sleep
- A single observed timing sample with no repeat and no baseline distribution to compare against
- A WAF block page that looks like a query error but appears only for the payload and never for benign special characters
- Ranking or filter changes that a non-SQL path also honours because the endpoint implements them in application code

## What a minimal PoC must demonstrate

- the baseline response and the true-condition response and the false-condition response, all three, with lengths or hashes
- for a time claim, repeated measurements of baseline and payload latency with the delay scaling with the requested interval
- a neutralised control where the injection characters are escaped or the parameter is removed, showing the differential disappears
- the parameter and exact request that carried the payload, replayable without the tester's commentary
- evidence that the difference is query-derived, such as a syntax error naming a SQL dialect or a delay that only a sleep produces

## Impact bar

**Reportable:** a boolean or time differential that reproduces, scales with the payload, survives a re-request, and vanishes under a neutralised control. Extraction beyond that point needs its own authorisation.

**Informational:** a single changed response with no reproducible pair, an error page only, or a delay that a syntactically invalid payload also produces.

**Not a finding:** a WAF block, a validation message, or a reflection-driven length change.
