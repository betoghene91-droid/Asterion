#!/usr/bin/env python3
"""
Build app/src/corpus-digest.json at version 5 — a real UNION of v2, v3, v4.

Three places where UNIFY-PLAN.md's literal formula contradicts the existing
schema. Each is resolved in favour of the constraint the plan itself calls
mandatory (zero loss of precedent rows / no behaviour change), and each is
covered by an explicit assertion below so the deviation cannot drift silently.

  A. Plan: `source_rows = sum(classes[*].n)`.
     Reality: every existing digest declares source_rows ABOVE sum(classes.n)
     by exactly 134,680 — rows whose vuln_group maps to no playbook. That is
     documented in scripts/load-corpus.mjs ("per-class totals are legitimately
     below source_rows. Say it out loud so nobody 'fixes' it by inventing
     rows"). Applying the plan's formula would rewrite the operator-facing
     corpus size from 181,357 to 46,677 — a silent 134,680-row regression of
     exactly the kind this task exists to prevent.
     Resolution: source_rows = max over inputs (monotone, loses nothing).

  B. Plan: cap 250 per class AND every input id must survive.
     Reality: sol.delegatecall unions to 261, sol.dos to 252. Unsatisfiable.
     Resolution: cap = max(250, largest union) = 261. The cap exists to keep
     the digest inside one D1 value (2 MB hard cap; distill.py keeps headroom
     under 1.9 MB). At 261 the digest is ~1.09 MB, so the cap's purpose is
     untouched and zero loss becomes achievable.

  C. Plan: attribution byte-identical from v2.
     Reality: v2's six CC BY fields are already reproduced byte-for-byte in
     v3/v4, which additionally carry `merged_from` recording the GHSA and NVD
     merges and their licences.
     Resolution: keep the six v2 fields byte-identical AND keep merged_from
     (extended with this union). Dropping it would erase recorded attribution
     for two upstream sources — a licence regression.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

TASK = Path(__file__).resolve().parents[4]
REPO = TASK / "asterion"
APP = REPO / "app"

# The three input digests now live in the archive (v1) and in the workstream that
# produced the GHSA/NVD merges (v3, v4). v2's pre-merge copy is preferred there
# because _archive/v1 is the tree that shipped it; the fallback keeps this
# runnable from a checkout where v1 was archived somewhere else.
INPUTS = {
    "2": REPO / "_archive" / "v1" / "src" / "corpus-digest.json",
    "3": TASK / "workstreams" / "654e4435-6d71-45c8-8def-ec271afcbd0c" / "digest-merged.json",
    "4": TASK / "workstreams" / "654e4435-6d71-45c8-8def-ec271afcbd0c" / "digest-merged2.json",
}

# Same weights corpus.ts uses for ranking; kept local so the builder has no TS dep.
SEV_WEIGHT = {"critical": 3.0, "high": 2.0, "medium": 1.0, "low": 0.4, "info": 0.1, "gas": 0.0, "unknown": 0.0}
STAT_FIELDS = ("n", "severe", "critical", "high", "medium", "recent")
MIN_CAP = 250


def load() -> dict[str, dict]:
    out = {}
    for v, p in INPUTS.items():
        if not p.exists():
            raise SystemExit(
                f"input digest v{v} not found at {p}.\n"
                "This builder needs all three pre-merge digests: v2 in _archive/v1, "
                "v3 and v4 in the workstream that produced the GHSA/NVD merges. "
                "Point INPUTS at wherever they live in your checkout."
            )
        out[v] = json.loads(p.read_text(encoding="utf-8"))
        assert out[v]["version"] == v, f"{p} declares version {out[v]['version']}, expected {v}"
    return out


def build(src: dict[str, dict]) -> dict:
    versions = ["2", "3", "4"]
    all_classes = sorted({c for v in versions for c in src[v]["classes"]})
    assert len(all_classes) == 25, f"expected 25 classes, saw {len(all_classes)}"

    # ── precedent: UNION keyed by id, per class. Nothing is dropped.
    precedent: dict[str, list[dict]] = {}
    widest = 0
    for cls in all_classes:
        by_id: dict[str, dict] = {}
        for v in versions:
            for row in src[v]["precedent"].get(cls, []):
                by_id.setdefault(row["id"], row)  # first writer wins; content is identical across inputs (asserted below)
        rows = list(by_id.values())
        rows.sort(key=lambda r: (-SEV_WEIGHT.get(str(r.get("severity", "unknown")).lower(), 0.0),
                                 -(r.get("year") or 0),
                                 r["id"]))
        widest = max(widest, len(rows))
        if rows:
            precedent[cls] = rows

    cap = max(MIN_CAP, widest)

    # Apply the cap. With cap = widest this is a no-op, which is the point.
    dropped: list[str] = []
    for cls, rows in precedent.items():
        if len(rows) > cap:
            dropped.extend(f"{cls}:{r['id']}" for r in rows[cap:])
            precedent[cls] = rows[:cap]
    assert not dropped, f"cap {cap} would drop {len(dropped)} rows: {dropped[:5]}"

    # ── classes: MAX per field across inputs (sources were only ever added).
    classes: dict[str, dict] = {}
    for cls in all_classes:
        stat: dict = {}
        for f in STAT_FIELDS:
            stat[f] = max(int(src[v]["classes"].get(cls, {}).get(f, 0)) for v in versions)
        stat["weight"] = max(float(src[v]["classes"].get(cls, {}).get("weight", 0.0)) for v in versions)
        stat["validatable"] = stat["n"] > 0
        # The validator in load-corpus.mjs refuses a digest that breaks these.
        assert stat["severe"] <= stat["n"], f"{cls}: severe {stat['severe']} > n {stat['n']}"
        assert stat["critical"] + stat["high"] + stat["medium"] <= stat["severe"], f"{cls}: c+h+m > severe"
        classes[cls] = stat

    # ── lexicon: union of keys, longer vector wins.
    lexicon: dict[str, list[str]] = {}
    for cls in all_classes:
        cands = [src[v]["lexicon"].get(cls) for v in versions if src[v]["lexicon"].get(cls)]
        if cands:
            lexicon[cls] = max(cands, key=len)

    # ── attribution: six v2 fields byte-identical, merged_from preserved.
    attribution = dict(src["4"]["attribution"])
    for k, val in src["2"]["attribution"].items():
        attribution[k] = val
    merged_from = list(attribution.get("merged_from", []))
    merged_from.append({
        "previous_version": "4",
        "previous_source_rows": int(src["4"]["source_rows"]),
        "added_source_rows": 0,
        "source": "union of v2 + v3 + v4",
        "source_url": "",
        "source_licence": "see attribution.data_licence",
        "source_licence_note": "No new upstream data. This version re-unions three already-attributed digests so that precedent rows present in v2 and v3 but dropped by v4 are restored.",
        "per_source_rows": {"v2": int(src["2"]["source_rows"]), "v3": int(src["3"]["source_rows"]), "v4": int(src["4"]["source_rows"])},
        "merged_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "changes": (
            "Union of the three digests, keyed by precedent id. Every row present in v2, v3 or v4 is "
            "retained and re-sorted by severity weight desc, year desc, id asc. Per-class counts take the "
            "MAX of each field rather than a sum, because the inputs overlap. source_rows is the maximum "
            "declared by any input (it exceeds the per-class total because rows whose vuln_group maps to no "
            "playbook are counted upstream but belong to no class). Precedent cap raised to the widest class "
            "so that no row present in any input is dropped."
        ),
    })
    attribution["merged_from"] = merged_from

    digest = {
        "version": "5",
        "source_rows": max(int(src[v]["source_rows"]) for v in versions),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "attribution": attribution,
        "precedent_per_class_cap": cap,
        "classes": classes,
        "precedent": precedent,
        "lexicon": lexicon,
    }
    return digest


def main() -> int:
    src = load()

    # Same (class,id) must carry identical content in every input that has it,
    # otherwise "union by id" would silently pick one version's text.
    for cls in {c for v in src for c in src[v]["precedent"]}:
        seen: dict[str, str] = {}
        for v in src:
            for row in src[v]["precedent"].get(cls, []):
                blob = json.dumps(row, sort_keys=True)
                if row["id"] in seen:
                    assert seen[row["id"]] == blob, f"{cls}/{row['id']} differs across inputs"
                seen[row["id"]] = blob

    digest = build(src)

    # ── zero-loss proof INSIDE the builder (the committed test asserts it again)
    for v in ("2", "3", "4"):
        for cls, rows in src[v]["precedent"].items():
            got = {r["id"] for r in digest["precedent"].get(cls, [])}
            missing = [r["id"] for r in rows if r["id"] not in got]
            assert not missing, f"version {v} {cls}: {len(missing)} rows lost, e.g. {missing[:3]}"

    # ── web.graphql must stay empty: no fabricated rows.
    assert digest["classes"]["web.graphql"]["n"] == 0, "web.graphql must stay 0"
    assert not digest["precedent"].get("web.graphql"), "web.graphql must have no precedent rows"

    out = APP / "src" / "corpus-digest.json"
    out.write_text(json.dumps(digest), encoding="utf-8")
    nbytes = out.stat().st_size

    # ── snapshot the three inputs as immutable fixtures for the committed test.
    fx = APP / "tests" / "fixtures" / "digest-inputs"
    fx.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for v, p in INPUTS.items():
        raw = p.read_bytes()
        (fx / f"v{v}.json.gz").write_bytes(gzip.compress(raw, 9, mtime=0))
        manifest[v] = {
            "file": f"v{v}.json.gz",
            "source_path": str(p.relative_to(TASK)),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "source_rows": src[v]["source_rows"],
            "precedent_ids": sum(len(r) for r in src[v]["precedent"].values()),
        }
    (fx / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    total_rows = sum(len(r) for r in digest["precedent"].values())
    print(f"wrote {out}")
    print(f"  version           5")
    print(f"  source_rows       {digest['source_rows']:,}")
    print(f"  classes           {len(digest['classes'])}")
    print(f"  precedent rows    {total_rows}")
    print(f"  cap               {digest['precedent_per_class_cap']}")
    print(f"  bytes             {nbytes:,}  ({nbytes/1024/1024:.2f} MB, D1 hard cap 2 MB)")
    print(f"  fixtures          {fx}")
    for v, m in manifest.items():
        print(f"    v{v}: {m['precedent_ids']} rows, sha256 {m['sha256'][:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
