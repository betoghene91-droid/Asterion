# LEARNING.md — what Asterion learns, and what it does not

Two separate mechanisms widen what the bot knows. They are easy to confuse, so
this file keeps them apart:

| | corpus expansion | the learning loop |
|---|---|---|
| file | `app/eval/ingest-more.py` | `app/src/learn.ts` |
| input | published advisories and incident reports | the bot's own proof verdicts |
| changes | the **prior** (what the world looks like) | the **weight** (what this bot can actually prove) |
| updates | when someone runs the ingester | on every finished attempt |
| source of truth | somebody else's labelling | an executed test |

Neither one lets the bot "learn from prose". Nothing here calls a model.

---

## 1. The learning loop

### What it learns from

`recordOutcome()` writes one row to `learning_outcomes` per finished proof
attempt. The verdict comes from `v2/src/proof.ts`, which can emit exactly four
values, and they are **not** equally informative:

| verdict | meaning | tier | counts as positive evidence? |
|---|---|---|---|
| `proven` | a falsifying test passed; the claim is established | 3.0 | **yes** |
| `partial` | the property fired but the claim was not established | 1.0 | no |
| `disproved` | the attempt ran and refuted the claim | 0.0 | no |
| `inconclusive` | the harness failed — we learned nothing about the class | — | no, and excluded from the mean entirely |

Only `proven` is a real finding. Everything else is a *negative* signal or no
signal. `inconclusive` is excluded on purpose: a broken harness says something
about the runner, not about whether this class pays.

### What it does NOT learn

- **Prose.** A policy document, a tweet, an audit PDF and a blog post are all
  invisible to this path. The bot cannot be taught by assertion.
- **`partial` outcomes, much.** A `partial` means the harness ran and something
  fired, not that the bug is real. It carries tier 1.0 so it contributes a
  little signal, but the anti-inflation rule below stops it from ever *raising*
  a class on its own.
- **From other bots' results.** Rows are per-deployment. Two Workers with
  separate D1 databases learn separately.
- **Anything about a target in general.** It learns per *class*, not per
  program. A class that keeps proving on one client's codebase raises the class
  globally; that is a coarse instrument, and it is the honest granularity for
  the amount of data available.

### The shrinkage formula

```
blended = (k · w_digest + Σ tier) / (k + n)
```

where `k` = `DEFAULT_PRIOR_STRENGTH` (12), `w_digest` is the frozen corpus
weight for the class, `n` = the number of *counted* outcomes (attempts minus
`inconclusive`), and `Σ tier` sums the tiers of those outcomes.

This is a weighted average of two means **in the same units** — both sides are
severity weights on a 0..3 scale. That is what makes the average legitimate. Had
the digest weight been a severity and the observed figure a success *rate*, the
formula would be averaging metres into seconds.

Properties, each covered by a test in `app/tests/learn.test.mjs`:

- **`n = 0` → `blended` equals `w_digest` bit for bit.** Not approximately. A
  first deploy therefore provably changes no ranking. (`Object.is` is asserted,
  not `===`, so a `-0`/`0` or `NaN` drift would fail.)
- **`n → ∞` → `blended` → `Σtier/n`.** The bot's own record eventually wins.
- **Monotone shrinkage.** The prior's share is `k/(k+n)`, which falls as `n`
  grows, so 3 outcomes nudge and 300 overrule. Tests assert that the prior share
  strictly decreases and that the distance moved from the prior strictly
  increases across `n = 1, 3, 12, 40, 100, 228, 1000`.
- **A large sample moves more than a small one.** Asserted directly (`n=3` moves
  less than `n=203`).

The form is the closed-form posterior mean of a Normal prior on a mean with a
known-variance approximation. It was chosen because it degrades correctly at
zero data, not because it fits a curve.

### The anti-inflation rule

> A class with **zero `proven`** outcomes is clamped to at most its digest
> weight.

Attempts earn attention; only proofs earn rank. Without this rule, all 15 `web.*`
classes — which start at prior `0.0` — would jump to a positive weight the moment
a harness merely *ran*. That is the self-congratulatory drift the whole module
exists to prevent. When the clamp fires, `blendDetail()` reports
`cappedByNoProof: true` and `learnedRanking()` prints `0 proofs — capped at
prior`, so the clamp is visible rather than silent.

### Reading `learnedRanking()`

Each row exposes `digestWeight`, `learnedWeight`, `blendedWeight`, `priorShare`,
`observedShare`, `attempted`, `counted`, `proven`, `confidence`, `raised` and a
one-line `note`. `confidence` is a sample-size band, not a probability:

| band | `counted` |
|---|---|
| `none` | 0 — pure prior, never attempted |
| `low` | 1–4 |
| `medium` | 5–19 |
| `high` | 20+ |

**Learned weights are directional until `counted` reaches roughly 20, and should
not be trusted for scheduling decisions until a class has dozens of real
proofs.** With `k = 12`, twelve outcomes put the blend at a 50/50 split with the
prior — that is the point where the bot's own record starts to matter, not the
point where it is right. Treat `raised: true` on a `low` row as a hint to look,
not a reason to reallocate a week.

### Exported signatures

Not wired into the Telegram UI; these are the callables:

```ts
recordOutcome(db: LearnDb, input: OutcomeInput): Promise<RecordedOutcome>
classStats(db: LearnDb, cls?: string): Promise<ClassStatLearned[]>
blendedWeight(cls: string, digestWeight: number,
              learnedStats: ClassStatLearned | null | undefined,
              opts?: { priorStrength?: number }): number
learnedRanking(db: LearnDb, digest?: DigestWeights | null,
               opts?: { priorStrength?: number }): Promise<RankingRow[]>
blendDetail(...): BlendDetail   // blendedWeight with the receipts
```

`LearnDb` is a structural interface (`prepare(sql) → bind/run/all/first`).
`D1Database` satisfies it, and a compile-time assertion in `learn.ts` fails the
build if that ever stops being true. Tests satisfy it with `node:sqlite` against
the **real** `schema.sql`, so a renamed column breaks a test rather than
production.

Only `recordOutcome` writes. Everything else is read-only, and a test asserts
the row count is unchanged after every read path runs.

---

## 2. Corpus expansion

### Why it exists

`app/src/corpus-digest.json` was 180,907 rows of **web3 audit findings**. All 15
`web.*` classes sat at `n: 0`, so a web2 hunt started with literally zero
precedent, and nothing published after the digest was built could ever enter it.

### Verified sources

Every source below was fetched and its schema read before a parser was written
(2026-10-29). Licences were read from the source's own metadata, not assumed.

| `--source` | what it is | licence | status |
|---|---|---|---|
| `ghsa` | GitHub Advisory Database, one JSON per advisory with `database_specific.cwe_ids` | **CC-BY-4.0** (verified via licence API) | parsed, live-tested |
| `nvd` | NVD CVE API 2.0 JSON, `cweId`-filtered | public domain (US Gov work) | parsed, live-tested |
| `cvelist` | CVEProject/cvelistV5 per-CVE JSON 5.x, `cna.problemTypes[].cweId` | CVE Program Terms of Use | parsed |
| `defihacklabs` | SunWeb3Sec/DeFiHackLabs README incidents (`### YYYYMMDD Project - ...` + `### Lost:`) | **Apache-2.0** (verified via licence API) | parsed, live-tested |
| `jsonl` | generic `{class, severity, title, description}` | operator-supplied | parsed |
| `solodit`, `code4rena`, `immunefi` | **need an export you provide** | operator-supplied | refused with instructions |

`solodit`, `code4rena` and `immunefi` are deliberately **not** scraped. Their
bulk exports need credentials or a paid plan, and their schemas are not published
in a stable form. The script will not invent a parser for a schema it cannot see:
it exits non-zero and prints the exact row shape to export. A fabricated parser
is worse than no parser, because it produces rows nobody can trace.

### How classes are derived

CWEs are mapped to classes through one explicit table, `CWE_TO_CLASS`. That table
*is* the mechanism that gets `web.*` off zero, so every entry names a CWE whose
definition actually matches the class. Free-text sources fall back to
`TEXT_CLASS_RULES` (regex on the title).

Two distinct refusals, deliberately not merged:

- `CWE_NO_CLASS` — the 25-class taxonomy has no home for it (CWE-787 memory
  corruption, CWE-94 code injection, CWE-200 info disclosure…). Expected.
- **unrecognised** — the CWE is in neither table. This is a real gap in the
  mapping and the run reports it by count so it can be fixed.

Mapping CWE-94 → `web.sqli` because both are "injection" would corrupt the class
prior. Losing the row is the cheaper mistake, and the script says so.

**Known honest gap:** `web.graphql` is still at `n: 0`. Real GraphQL CVEs carry
their *underlying* CWE (CWE-863, CWE-89, CWE-918 — verified: the 375
`keywordSearch=graphql` CVEs are labelled that way), so mapping them into
`web.graphql` would double-count rows already belonging to `web.authz.function`.
There is no clean public source for the introspection/field-authz class. Left at
zero on purpose; see the follow-up list.

### Merge semantics

```
blended = (w_base · n_base + w_add · n_add) / (n_base + n_add)
```

A **union**, never a replace:

- per-class counts are summed,
- weight is the row-weighted mean (800 existing rows are not dragged around by 1
  new one — asserted),
- precedent pools are unioned and re-capped, base entries winning on duplicate
  titles,
- `version` bumps,
- `attribution.merged_from` records the previous version, the source URL, the
  licence, the per-source row counts and a statement of changes (this statement
  is the CC BY attribution obligation, so it is a real sentence, not an ornament).

Every class's `n` is asserted non-decreasing, and `source_rows` is asserted
non-decreasing, inside `merge_digests`. A merge that loses a row raises rather
than writing a quietly smaller digest.

### Adding a new source

1. Fetch a sample and read its actual schema. Do not guess.
2. Confirm the licence from the source's own metadata. **No licence means no
   reuse** — add it to `CWE_NO_CLASS`-style refusal, not to the accept path.
3. Add a `parse_*` function returning `(rows, meta)`, and register it in
   `PARSERS` and `LICENCES`.
4. Extend `CWE_TO_CLASS` (or `CWE_NO_CLASS`) for the CWEs it uses.
5. Add selftest cases to `--selftest` covering: row count in, class mapping, the
   severity it produces, and one record that must be *skipped* with the right
   reason.
6. Run `--selftest`, then a real `--merge` against the shipped digest and diff
   the per-class `n` values before committing.

### End-to-end, measured

```
python3 app/eval/ingest-more.py --source ghsa --input ./ghsa-mirror --out /tmp/ghsa-add.json
python3 app/eval/ingest-more.py --merge app/src/corpus-digest.json --add /tmp/ghsa-add.json --out /tmp/merged.json
node app/scripts/load-corpus.mjs --in /tmp/merged.json --check   # validates, writes nothing
node app/scripts/load-corpus.mjs --in /tmp/merged.json --apply
```

Real run: 400 fetched advisories → 258 rows in 12 `web.*` classes → merged
180,907 → 181,165 (v2→v3). Adding NVD slices for the empty classes:
181,357 rows, 14/15 `web.*` non-zero.

---

## 3. Loading, and why history is kept

`corpus_digest` is keyed on `version`, and a merge bumps that version, so
loading a merged digest **adds a row** and the previous digest stays queryable.
The Worker reads `ORDER BY loaded_at DESC LIMIT 1`, so newest-loaded wins.

`load-corpus.mjs` also validates before it writes: every class must have
finite non-negative counts with `severe ≤ n` and `critical+high+medium ≤ severe`,
and `weight` must be within 0..3. A digest that fails is refused, because
loading it would poison every prior the Worker computes.

**The tie bug this fixed.** `unixepoch()` has one-second resolution, so two
digests loaded in the same CI step tie on `loaded_at` and the Worker's
`ORDER BY` becomes ambiguous. Reproduced (`evidence/loader-tie-control.mjs`):
loading v2, v3, v4 in one second made the Worker read **v2** — a stale digest,
silently. The loader now forces each new row's `loaded_at` strictly above the
existing maximum, keeping `unixepoch()` only as a floor. Re-loading the *same*
version is treated as a correction: it updates in place, keeps its `loaded_at`,
and says so on stderr.

---

## 4. Honest limitations

- Learned weights are **directional only** below ~20 counted outcomes per class.
  `k = 12` is a judgement call, not a measurement; revisit it once any class has
  100+ proofs.
- The learning store knows nothing about *targets*. It cannot learn "this client's
  codebase has no oracle bugs" — only "this class does or does not pay in general".
- `web.graphql` still has no precedent (see above).
- `web.reset` (39) and `web.takeover` (22) have thin rows. Their weights (2.26,
  1.97) come from a small, severe-only sample and should not be trusted as
  strongly as `sol.accesscontrol`'s 8,719-row prior.
- The `ghsa` sample above is 400 of ~30k advisories; a full ingest needs a
  mirror, not a fetch loop.
- No part of this is wired into the Telegram UI yet.
