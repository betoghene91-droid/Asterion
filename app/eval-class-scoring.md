# Eval: what these numbers are, and are not

`eval/harness.py` used to print `detection: measured 0` and explain that
per-project checkouts were "a v2 capability". That was honest and useless: it
made the absence of recall data look like a placeholder rather than a
measurement nobody had run. This document records what the harness now measures,
how, and — more importantly — the claims it deliberately refuses.

## Two provenances, never averaged

Every detection number is labelled:

| label | meaning |
|---|---|
| `live: <project>@<commit>, …` | the tools were run on those checkouts *now* |
| `fixture: eval/fixtures/live-detector-runs.json` | a committed capture of a real run on a recorded date |

`--live` produces the first, the default produces the second. They are reported
separately and never combined. A reader who cannot tell a fresh measurement from
a stale one cannot tell whether a number still means anything.

The fixture is not hand-written to look plausible: `eval/capture_live.py` runs
`tools/detect.py`, Slither and Aderyn against each pinned commit and records the
tool versions, the full 40-character commit, the commit date, the timestamp, and
— for any tool that failed — the exact error. Re-running `--live` on a machine
with the same toolchain reproduces the fixture's numbers exactly; that equality
is itself the check that the fixture is a real capture.

## The unit of measurement is a CLASS, not an instance

For each (project, tool) pair:

```
hit           the tool fired on class C somewhere in that checkout
ground truth  the audit of that engagement reported >= 1 severe finding of class C
tp = hit ∧ gt>0    fp = hit ∧ gt=0    fn = ¬hit ∧ gt>0    tn = ¬hit ∧ gt=0
```

The claim this supports:

> Across these N projects, tool T flagged K classes; J of them were classes the
> auditors also reported, so class-level precision is J/K.

### Why instance-level tp/fp/fn is NOT claimed

It would be a stronger and more useful claim, and the corpus cannot support it.
To score "the tool found *the* audited bug at line N" you need each finding
pinned to a file and line in a pinned commit. The corpus does not carry that:
`title` is free prose and `body_text` mentions filenames inconsistently. A finding
row is tied to a *report*, not a revision.

An earlier draft of this harness was tempted to match on file names appearing in
`body_text`. That would have let a tool collect a true positive for merely firing
anywhere in a file the auditors also mentioned — a much weaker claim wearing the
label of a strong one. It is not done here.

There is also a structural reason: `tools/detect.py` emits at most one lead per
`(class, file)` and says so in its own docstring ("leads, never findings"). It
cannot produce instance-level output to score even if the ground truth existed.

## "Did not run" is not "found nothing"

This is the property the harness is most careful about, and it is pinned by a
test. A tool that is missing, or that fails to compile the target, is recorded as
`available: false` with the error, and **excluded from every pooled ratio**. It
contributes neither a 0 (which would look like perfect silence) nor a 1.

The `poodl-2023` project exists in the fixture set specifically to exercise this:
its Hardhat project has no committed build artifacts, so Slither and Aderyn both
fail on it while `tools/detect.py` succeeds. If unavailability were scored as
zero, that one project would drag those tools' recall down by a third for a
reason that has nothing to do with their detection quality.

A related detail worth keeping: `_first_error()` exists because the naive
`stderr.splitlines()[-1]` records the *caret marker* from a solc error
(`|    ^^^^^^^^^`) rather than the error itself. The audit trail must say
something an operator can act on.

## Which toolchain was actually available

The captured run used, and recorded:

| tool | version | note |
|---|---|---|
| `tools/detect.py` | in-repo | pure stdlib, always available |
| Slither | 0.11.6 | needs `solc` **and** the project's build system (`forge`/`hardhat`) |
| Aderyn | 0.6.8 | needs a compiling project |
| `solc` | 0.8.20 via solc-select | one project additionally needs `via_ir = true` or solc fails with "Stack too deep" |

Two practical traps that are recorded in `projects.json` rather than left to be
rediscovered:

- Slither shells out to the build system. A Slither that is on `PATH` but cannot
  see `forge` fails with `Cannot execute 'forge'` — which looks exactly like a
  detector producing nothing. `detectors.py` therefore rebuilds `PATH` from the
  known tool directories rather than inheriting whatever the caller had.
- `exit10-protocol` will not compile without `optimizer`/`via_ir`; with neither,
  solc reports "Stack too deep" and every detector reports *unavailable*.

## The class vocabulary is fixed and closed

Scoring ranges over exactly the ten `sol.*` classes this repo ranks. A detector's
rule with no unambiguous class maps to **nothing** rather than to the nearest
plausible class. `unused-return`, `missing-zero-check` and `incorrect-equality`
are real Slither checks with no class in this taxonomy; bending them onto
`sol.inflation` because they vaguely concern values would corrupt that prior
permanently. `UNMAPPED_WITH_REASON` in `detectors.py` records each of those
decisions so a reader can distinguish "chose not to count" from "forgot to".

## Web2 ground truth

The shipped digest is 100% web3, so its `web.*` classes carry web3-shaped noise
(`web.cors` n=2, `web.sqli` n=3) and `web.graphql` is n=0. `eval/web2_ground_truth.py`
maps GitHub Advisory Database CWE tags onto the `web.*` classes instead.

It does **not** own the CWE table: it imports `CWE_TO_CLASS` and
`class_from_cwe()` from `eval/ingest-more.py`, so there is one tie-break rule in
the tree. Two tables would drift and the drift would be invisible — one file
would begin attributing rows the other refuses.

An unmapped CWE yields **no class**, not a guess. `CWE-94` (code injection) is
deliberately not mapped to `web.sqli` even though both are "injection"; doing so
would permanently inflate a class nobody could then un-inflate.

The committed fixture is a 67-advisory sample, not the full database. It proves
the mapper works and gives `web.*` a real (small) ground truth. It does not
replace a full ingest, and `web.graphql` is still n=0 afterwards.

Two shape traps found while building it, both now covered by tests:

1. The advisory-database repo files nest the CWEs at
   `database_specific.cwe_ids`; the REST API puts them at `cwes`. Flattening them
   to the record root classifies every record as `no_cwe` — 67 advisories, 0
   mapped, and nothing crashes.
2. `severity` is a **string label** in the REST API but a **list of CVSS vectors**
   in the repo files. Treating the list as a label yields `"unknown"` for every
   record, so every class reports `n > 0` with `severe: 0` and `weight: 0.0` —
   a source that looks mapped while carrying no severity signal.

## How precision feeds `learn.ts`

`blendWithPrecision()` combines payout frequency with measured precision using
`DEFAULT_PRECISION_STRENGTH = 12`:

```
blended = payoutOnly · (k·1 + n·precision) / (k + n)
```

The rule it exists to enforce: **precision can only ever reduce confidence, never
manufacture it.**

- `n = 0` (nothing measured) → multiplier is exactly `1.0` → the estimate is the
  payout-only estimate *bit for bit*. A class nobody measured gains exactly 0.0.
- `precision = 1.0` → multiplier is exactly `1.0` → no change. A perfect detector
  earns no bonus, because precision is evidence that leads are worth reading, not
  evidence that the class pays more.
- `precision < 1` → the estimate falls, monotonically in `n`.

This matters because three previous agents invented weights (e.g. 1.9) for
unmeasured classes. An invented weight *means* "measured" and is therefore a lie;
`0.0` means "unmeasured" and is true. `validatable == (n > 0)` still holds for
every class, and both the honest-zero rule and the unmeasured-gains-nothing rule
are asserted over every class in `tests/eval-learning.test.mjs`.

## Reproducing

```bash
cd app

# score the committed capture (no network, no toolchain, no corpus)
npx tsc --noEmit && npm run build --silent && node --test tests/eval-learning.test.mjs

# report from the fixture
python3 eval/harness.py

# re-run the detectors for real on pinned checkouts
python3 eval/harness.py --live --root /path/to/checkouts

# refresh the fixture after a toolchain change
python3 eval/capture_live.py --root /path/to/checkouts \
    --out eval/fixtures/live-detector-runs.json
```

`eval/projects.json` is the manifest: repo, commit, audit date, auditor, and the
severe finding count per class for that engagement. Every commit in it was
verified to be the last commit before the audit date, and for `exit10` and
`poodl` it is additionally the exact tree the audit report links to.

## What could not be measured

- **Instance-level detection.** No file:line ground truth in this corpus.
- **Sample size.** 3 projects, ~10 classes each. `n_projects` is printed beside
  every ratio for exactly this reason; a precision of 0.444 off 9 observations is
  directional at best.
- **The two web2-dependent classes for which no CWE exists.** `web.graphql` has
  no CWE in the GitHub database mapping; it remains n=0 and unmeasured rather
  than being given a plausible number.
- **Recall for any tool on a project it could not compile** — recorded as
  unavailable, not as a miss.
- **A full GHSA ingest.** Only a 67-advisory sample is committed.
