# web.race — race condition in a state transition

This class needs a semantic that is supposed to hold exactly once, and a window in
which two requests can both read the pre-state. A burst that merely produces errors
proves nothing; a burst that produces N effects where the design permits one is the
whole finding, and it needs the pre-state and post-state measured, not inferred.

**Corpus note, stated plainly:** `v1/src/corpus-digest.json` records n=0
findings for this class, with severe=0 and weight 0.0. There is **no**
precedent for it in the 180,907-row corpus, which is entirely web3 audit
findings. Every question below is first-principles reasoning about how the
class fails, not a distilled statistic. Do not read a weight of 0.0 as
"low priority" and do not read it as "rare": it means unmeasured.

## When this is worth hunting

Worth the time on any operation with a once-only semantic: coupon redemption, referral
credit, withdrawal, seat booking, vote or like, invite acceptance, and free-tier quota.
High-yield shapes:

- **Read-then-write balance updates** with no row lock or conditional update
  (`UPDATE ... SET bal = 5` rather than `bal = bal - 5 WHERE bal >= 5`).
- **Token redemption** that looks up a row, then deletes it, in two statements.
- **Multi-step signup bonuses** where the credit is granted before the state that
  prevents a second grant is committed.
- **Queue and worker handoffs** where two consumers pick up the same job.

Waste of time where the invariant is a unique index or a conditional update, because the
database serialises those regardless of how many requests arrive.

## How to confirm it is even reachable

- **Confirm the endpoint works singly first.** If one request already produces two
  effects, this is a missing-check bug and the concurrency is irrelevant.
- **Find the atomic boundary in the code or the schema.** A unique index or a
  conditional update closes the window; a read followed by a separate write opens it.
- **Align the burst.** Sending requests at the same instant matters — use a single
  synchronised send, and repeat several times, because the window may be microseconds.
- **Measure the resource, not the responses.** Count the credits, the seats, or the
  redemptions in the account afterwards.
- **Watch for a compensating job** that reverses duplicates; if it does, the finding is
  a transient over-issue and its impact claim has to say so.

## Discriminating questions

1. Which operation is supposed to succeed exactly once, or at most N times, and where is that limit enforced — a pre-read then a write, a unique constraint, or an atomic update?
2. Can two requests read the same pre-state before either writes, so both pass a check that should admit only one?
3. Is the limit enforced by a database constraint inside the transaction, which serialises the requests, or by application logic that reads and then writes?
4. What is the exact window: the latency between a balance read and a debit, between a token lookup and a delete, or between a status check and a transition?
5. Does a single request correctly produce one effect, establishing that the endpoint works before concurrency is introduced?
6. Does the burst produce N effects, or N-1 errors that indicate the limit actually held under load?
7. Does a rate limit or a per-account lock reduce the burst to one success, and if so can it be evaded across sessions or connections?
8. Is the affected resource money, a coupon, a vote, an invitation, or a seat, and does the multiplied effect convert to a measurable gain?

## Common false positives

- A burst where all but one request fails with a conflict or lock error, which is the semantic holding
- Concurrent requests that all succeed but each applies to a different resource, so no limit was violated
- A duplicated side effect that the system reconciles asynchronously, leaving the final state correct
- Sequential requests that also produce multiple effects, which is a missing-check bug rather than a race
- Load-induced 5xx responses mistaken for a successful parallel execution
- A limit that is per-session and by design not global, so multiplying sessions is not a bypass

## What a minimal PoC must demonstrate

- the single-request control proving one request yields exactly one effect
- the concurrent burst with a stated count and timing, and the observed number of successful effects
- the pre-state and post-state of the affected quantity, measured in the account or resource itself
- the server-side evidence that the limit was exceeded, such as a balance above the permitted maximum
- a repeat run showing the outcome is reproducible rather than a one-off timing coincidence

## Impact bar

**Reportable:** the affected resource measurably exceeds its permitted quantity after a concurrent burst, with a single-request control and a reproducible run.

**Informational:** a widened window that produces errors but no extra effect, or a transient duplicate that a reconciliation job reliably reverses.

**Not a finding:** a burst of 5xx responses, or multiple effects a sequential second request also produces.
