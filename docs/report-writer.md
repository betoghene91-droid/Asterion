# Making a `proven` verdict submittable

Status: implemented on `task5/report`, based on `main` = `d97a55d1e676`.

Before this change a `proven` verdict produced a CI artifact and nothing else.
`verdicts.json` landed in the `proof-bundle` artifact, `/hook/proof` turned it
into a `proofs` row and possibly a `findings` row, and then it stopped. Nobody
outside the repository could act on it, because the only thing a bounty platform
accepts is a document.

Three new modules fix that, plus one free item:

| File | What it is | Deps |
| --- | --- | --- |
| `app/src/report.ts` | recorded `proven` bundle → submittable markdown | none |
| `app/src/cvss.ts` | CVSS 3.1 base vector derived from the measured delta | none |
| `app/src/ledger-export.ts` | one engagement's audit trail as canonical JSON | none |
| `app/src/scope-monitor.ts` | pure snapshot / diff / pause-decision | none |

`dependencies` in `app/package.json` remains empty. Nothing here imports a
package, calls the network, reads a clock, or consults a model.

---

## 1. The report writer

```js
import { buildReport } from './build/report.js';

const r = buildReport({
  engagement,          // engagements row
  assets,              // assets rows for that programme
  approvals,           // approvals rows
  ledger_proofs,       // proofs rows for this hunt
  bundle,              // verdicts.json
  plan,                // plan.json, for the verbatim test + requires[]
  generated_at,        // optional; omit for byte-reproducible output
});

if (!r.ok) {
  // r.reason, r.missing, r.verdict
}
r.markdown;   // the document
r.record;     // the same facts as data, including r.record.cvss
```

`buildReport` is pure. Two calls with equal input produce byte-identical
markdown, which is what lets the golden test pin the shape and what lets a
triager re-derive every number in the document.

### Sections

Title, one-line impact, a provenance table, affected assets, preconditions,
reproduction, measured delta, severity, remediation, and **claims NOT verified**.

### Why `claims NOT verified` is mandatory

At least one major programme's published terms make a finding that has not been
human-verified ineligible, and state that the submission fee is not refunded
when a report is rejected on those grounds; this project's own
programme-shortlist research recorded eight programmes where unattended output
is ineligible on some axis. The failure mode is therefore not "the report scores
badly", it is "the submitter pays to be told no".

The writer therefore cannot emit a report without the section, and the section
is never allowed to be vacuously empty. Ten distinct checks feed it:

1. counterfactual absent → `proven` disagrees with its own record
2. counterfactual is `without_precondition` → causality is precondition-only,
   not a demonstrated fix
3. `with_fix` recorded but no patch in the bundle → the applied change cannot be shown
4. the paired control was not recorded as passing (the judge never reads `controls/`)
5. the generated test is absent, or still contains a `CHANGE_ME` placeholder
6. the effect was measured on a fork, not against the live deployment
7. no commit SHA is recorded
8. prose in the claim names an address or host that is not an in-scope ledger asset
9. the ledger `proofs` row disagrees with the verdict, or is missing
10. the engagement records no authorization reference, or an approval is not `approved`
11. every CVSS metric that fell back to a least-severe default
12. every `limitations[]` entry the judge itself recorded

When all of those pass, the section states which checks it performed and that it
attests to nothing outside them. That sentence names its own scope rather than
asserting "all good".

### Affected assets come from the ledger, never from prose

`assets.value` for rows with `in_scope = 1`, reproduced exactly. Prose is
*compared against* the ledger: any address or host in the claim text that is not
an in-scope ledger row becomes a line in `claims NOT verified` naming the
exclusion. The reason is that prose is where a stale copy lives — a brief
written before the programme moved the contract, a note pasted from a ticket, a
claim description naming the address we forked. The ledger is the only place
validated against the programme's scope document.

`tests/report.test.mjs` proves the direction: the fixture's claim text names
`0xdeadbeef…`, and the test asserts the ledger address is what appears in the
affected-asset table while the decoy appears only as a refusal.

### Refusal is a first-class outcome

| Situation | `verdict` |
| --- | --- |
| no `proven` verdict in the bundle | `none_proven` |
| proven but no `proven_claim` | `proven_without_claim` |
| proven but no measured before/after | `proven_without_measurement` |
| no in-scope ledger asset | `no_ledger_asset` |

None of these reach `proof.ts`'s rule that only `proven` may be reported, so the
writer re-enforces it rather than trusting its caller.

---

## 2. CVSS from the measured delta

The constraint, written as a comment in `cvss.ts` and repeated here: **a model
must never choose the score.** The reason is not stylistic. A severity that was
guessed is indistinguishable in the submitted document from one that was
measured, and when the programme disputes it there is nothing to point at. A
number derived from recorded facts can be re-derived by the triager in ten
seconds; a number a model produced cannot be re-derived by anyone.

### Inputs → metrics

| Metric | Derived from | Table |
| --- | --- | --- |
| `AV` | `assets.kind` of the affected ledger rows | `ASSET_KIND_TO_REACHABILITY` → `REACHABILITY_TO_AV` |
| `AC` | count of declared target conditions in `requires[]` | `complexityFor` |
| `PR` | a declared privilege requirement, else the RoE mutability ladder | `MUTABILITY_TO_PR` |
| `UI` | a declared victim-interaction or automation precondition | inline |
| `S` | a declared trust-boundary precondition | inline |
| `C/I/A` | `impact.kind` measured by the harness | `IMPACT_TO_CIA` |

`assets.kind` → reachability maps `chain_address` to `network`, not `local`:
anyone can send a deployed contract a transaction. The fork is where we
*measured* it, not where it lives — and that gap is stated in the report's
unverified list, because a fork reproduction is not a production one.

### Two honesty rules

**Unattested ⇒ least severe.** Nothing recorded attests `UI` or `S` in a typical
bundle, so the derivation takes `UI:R` and `S:U` — the values that score
*lower* — and marks the metric `attested: false` in `basis`, lists it in
`unattested`, and the report repeats it in `claims NOT verified`. The published
score is therefore a **floor**. Understating is recoverable by the human reading
the report; overstating is not.

**Unknown impact kind ⇒ refuse, do not default.** `impact.kind === 'other'`
means the plan carried no claim kind, so `C/I/A` would have to be invented. That
returns an error with a reason, not `0.0`, because `0.0` reads as "harmless" and
that is a different statement from "not scored".

### Arithmetic

`baseScore` implements FIRST CVSS 3.1 §7.1 literally, including §7.4's integer
Roundup — a naive `Math.ceil(x * 10) / 10` disagrees with the spec on values
already exact at one decimal place. Pinned against 18 published reference
vectors in `tests/cvss.test.mjs`. `scoreOfVector` is exported so a human can
confirm a report's number without trusting `deriveCvss`.

### The fixture

```
CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:N  →  5.3
```

`simulate` mutability → `PR:N`; one declared target condition → `AC:H`;
`chain_address` → `AV:N`; `value_transfer` → `C:N/I:H/A:N`; no UI or boundary
signal → `UI:R`, `S:U`, both flagged unattested.

---

## 3. Ledger export

`exportEngagement(input, sha256Hex)` returns one engagement — engagement row,
hunts, approvals, proofs, findings, and the ledger entries attributed to it — as
canonical JSON.

### Determinism

`ledger.ts` already canonicalises with sorted keys so the same logical entry
always hashes the same. The export follows the same rule through the same
`stableStringify`, recursively. Consequences, all deliberate:

- **Object keys are sorted at every level.** Two callers assembling the same
  engagement in different key order produce the same bytes.
- **Arrays keep their order.** An action sequence is ordered data; sorting it
  would destroy meaning. Only the `ledger` array is re-ordered, by `seq`, because
  a chain is only meaningful in sequence.
- **`exported_at` is opt-in.** A `Date.now()` default would make every export of
  the same engagement differ, which defeats digest comparison. The document
  records the timestamp when the caller supplies one and omits the key when it
  does not.

The test asserts byte-equality of two exports, that reordered input keys produce
identical output, and that the sha256 of both is the same.

### Integrity is computed, not assumed

`verifyChain` re-hashes the chain with the same formula `ledger.ts` writes. A
broken chain still exports — hiding it would defeat the purpose — but
`integrity.ok` is `false` and the reason is named (`hash mismatch at seq N`,
`sequence gap`, `broken link`). The document also reports the head hash and
`verify_hint`, which states the exact recomputation so a third party can check
it without this code.

`ledgerForEngagement` decides belonging from the payload rather than a column,
because `ledger` has no `engagement_id` — an entry cannot be re-parented without
breaking the chain. An unparsable payload is still attributed by raw substring,
which can only ever include *more* entries; excluding one could hide an action.

---

## 4. Scope-change monitor (the free item)

`ECOSYSTEM.md` §5 names scope-*narrowing* alerts as the real legal risk of
continuous hunting, and records that nothing in the tree covered it. Naming the
gap was honest; it is now partly closed.

`app/src/scope-monitor.ts` provides `diffScope` and `decidePause` as pure
functions, plus `snapshotForStorage` / `snapshotFromStorage`.

### Why the asymmetry is load-bearing

A false pause costs one engagement and a re-read of the policy. A false continue
costs an out-of-scope test against a system nobody gave permission to test. So
`continue` requires ALL of: two comparable snapshots, no asset the engagement
depends on having disappeared, and a current snapshot. Every other state pauses
with the reason named.

The freshness check exists for a specific failure: a cron that silently stops
produces a snapshot that never updates, and a monitor that only diffs two
snapshots would compare the stale one to itself forever and report "unchanged" —
the most dangerous possible answer, because it looks like a confirmed clean bill
of health.

Two subtleties the tests pin:

- **`host → url` is a kind change, not a disappearance.** The asset is still
  named, so pausing would be a false positive; calling it unchanged would hide a
  real scope edit. It is its own outcome, and the decision says the engagement's
  recorded kind is now stale.
- **A document edit with an unchanged asset set is surfaced.** The parsed assets
  are identical but the raw digest moved, which means a prose-only restriction
  may have been added. Continue, but tell a human to read it.

### What is NOT done, and why

**The cron wiring is absent.** This tree has five cron slots at the free-plan
ceiling — zero headroom — and `.github/workflows/**` belongs to another
workstream in this change set. So the decision function, its storage round-trip
and its tests are here; the call site is not.

Follow-up, in order:

1. **Persist snapshots.** Add `scope_snapshots(program_id, fetched_at, sha256, doc TEXT, PRIMARY KEY(program_id, fetched_at))` to `schema.sql`. `snapshotForStorage` already emits the text to store.
2. **Fetch and parse.** `discovery.ts` already classifies automation from policy text and `eval/ingest-programs.py` already reads the `bounty-targets-data` scope schema. The gap is a parser per platform into `ScopedAsset[]`; Immunefi/Cantina/Sherlock/HackenPay each publish machine-readable scope.
3. **Spend a cron slot** on `decidePause` per open engagement, or fold it into the existing 06:30 briefing cron, which already reads `engagements` and already sends Telegram. Folding it in costs no new slot and is the cheaper route.
4. **Write the pause.** `UPDATE engagements SET status='paused'` plus a `ledger` entry of kind `scope.paused` carrying `lost_assets` and `reasons`, so the pause itself is auditable.

Until step 3 exists, this module is dead code in the runtime sense — which is
strictly better than a monitor that half-works, because a monitor whose snapshot
is stale reports a clean result.

---

## 5. Tests

```bash
cd app
npx tsc --noEmit                  # exit 0
npm run build --silent            # explicit: `npm test` is build && test, so a
                                  # tsc failure would silently skip the suite
node --test tests/*.mjs           # 885/885
python3 -c "import json;d=json.load(open('package.json'));print(d.get('dependencies'))"
                                  # None
```

119 new tests over the 766 baseline:

| File | Tests | What it pins |
| --- | --- | --- |
| `tests/fixtures/report/expected-report.md` | — | the golden document, 228 lines |
| `tests/report.test.mjs` | 40 | shape, ledger-over-prose, `claims NOT verified`, refusals |
| `tests/cvss.test.mjs` | 25 | spec arithmetic, determinism, least-severe defaults, refusals |
| `tests/ledger-export.test.mjs` | 26 | determinism, real chain verification, refusal |
| `tests/scope-monitor.test.mjs` | 28 | diff semantics, every pause path |

40 + 25 + 26 + 28 = 119, and 766 + 119 = 885, which is the suite total below.

### The golden fixture is engine output, not a hand-written assertion

`tests/fixtures/report/` holds:

- `runs/results/test_reentrancy_118.{log,exit}` and
  `runs/counterfactual/test_reentrancy_118.{log,exit}` — recorded forge runs
  (a failing attack with real `IMPACT_*` markers, a passing `_nocond`)
- `plan.json` — produced by the real `synthesize()` in `poc.ts`, so the
  reproduction in the golden file is genuine generator output
- `verdicts.json` — produced by running the real `judge.mjs` over those runs

That is why the fixture verdict is `proven`: the judge reached it from recorded
evidence. `report.test.mjs` re-derives the verdict with `judge()` directly and
requires agreement, so the golden file cannot drift into describing a verdict
that never happened.

---

## 6. What this does not do

- **No merge, no PR, no workflow dispatch.** The branch is pushed and stops there.
- **No route or import from the Worker.** `report.ts`, `cvss.ts`,
  `ledger-export.ts` and `scope-monitor.ts` are pure modules with no `index.ts`
  edge, so nothing in the deployed Worker changed. Verified: `grep -c report
  app/src/index.ts` is unchanged.
- **No schema change.** The CVSS record is returned on `ReportRecord.cvss` for
  the caller to store. Adding a column is a `schema.sql` edit, and `schema.sql`
  is contended by two other workstreams in this change set.
- **No severity judgement.** The report states a derived base score and a floor.
  Whether that score is *right* for a programme is a human decision, and the
  document gives them every input to make it.
