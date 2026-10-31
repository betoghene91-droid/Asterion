#!/usr/bin/env python3
"""
Web2 ground truth from the GitHub Advisory Database: CWE → corpus `web.*` class.

WHY THE CORPUS CANNOT SUPPLY THIS
---------------------------------
The shipped digest is 181,357 rows of WEB3 audit findings. Fifteen `web.*`
classes sit on it at n = 2..136 of pure web3-shaped noise (`web.cors` n=2,
`web.sqli` n=3), and `web.graphql` is n=0. So a web2 prior derived from that
corpus is measuring "how often a Solidity audit mentioned a keyword", which is
not the quantity anyone wants. The fix is a source that is actually web2 and
actually CWE-tagged. GHSA is that source, it is public, and its licence
(CC-BY-4.0) permits redistribution of the derived counts.

WHAT THIS MODULE DOES
---------------------
    advisories --parse--> records --map CWE--> class --aggregate--> class counts

and nothing else. It writes no digest, touches no file, and makes no network
call unless the caller injects a fetcher.

THE MAPPING IS NOT REINVENTED HERE
----------------------------------
`ingest-more.py` already owns CWE_TO_CLASS / CWE_NO_CLASS and a
`class_from_cwe()` that returns None for anything it cannot map. Duplicating that
table would create two sources of truth that drift, and the drift would be
invisible: one file would silently start attributing rows the other refuses. So
this module imports it, and a test asserts the import is what actually runs.

DETERMINISM, AND WHY AN UNMAPPED CWE YIELDS *NO CLASS*
------------------------------------------------------
`class_from_cwe` picks the most common mapped class, ties broken by class name —
never by dict insertion order. That makes the answer a function of the input set
alone. And for a CWE nobody has decided about (CWE-94 code injection, CWE-78 OS
command injection) the answer is None, NOT the nearest keyword match. Mapping
CWE-94 onto `web.sqli` because both are "injection" would corrupt the `web.sqli`
prior with rows that are not SQL injection — the failure mode is silent and it
permanently inflates a class nobody can then un-inflate.

An unmapped record is therefore COUNTED AND NAMED (`skipped`), never guessed at
and never quietly dropped.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator

# Import the one true CWE table rather than re-declaring it. `ingest-more.py` is
# a script with a hyphen in its name, so it needs importlib rather than a plain
# import statement.
import importlib.util
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_ingest_more():
    name = "asterion_ingest_more"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _HERE / "ingest-more.py")
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError("cannot load ingest-more.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_IM = _load_ingest_more()

#: The single authority for CWE → class. Read-only by convention.
CWE_TO_CLASS: dict[str, str] = _IM.CWE_TO_CLASS
#: CWEs deliberately given no class, with the taxonomy reason recorded upstream.
CWE_NO_CLASS: tuple[str, ...] = tuple(_IM.CWE_NO_CLASS)
WEB_CLASSES: tuple[str, ...] = tuple(_IM.WEB_CLASSES)

#: Severity vocabulary shared with the digest, so counts are comparable.
SEV_WEIGHT: dict[str, float] = dict(_IM.SEV_WEIGHT)


def class_from_cwe(cwe_ids: Iterable[str]) -> str | None:
    """
    Deterministic CWE → class. Returns None when nothing maps.

    Delegates to ingest-more so there is exactly one tie-break rule in the tree.
    """
    return _IM.class_from_cwe(cwe_ids)


def explain_skip(cwe_ids: Iterable[str]) -> str:
    """`no_cwe` | `no_class_exists` | `unrecognised` — never a silent drop."""
    return _IM.explain_skip(cwe_ids)


def is_web_class(cls: str) -> bool:
    """Only web.* classes are this module's business; it must not touch sol.*."""
    return cls.startswith("web.") and cls in WEB_CLASSES


# ────────────────────────────────────────────────────────────── parsing ─────


@dataclass
class Advisory:
    """One advisory, reduced to what scoring needs. Nothing else is retained."""

    id: str
    cwe_ids: tuple[str, ...]
    severity: str
    summary: str
    cls: str | None
    skip: str
    published: str
    ecosystem: str = ""
    package: str = ""

    def to_row(self) -> dict:
        return {
            "id": self.id,
            "cls": self.cls,
            "cwe_ids": list(self.cwe_ids),
            "severity": self.severity,
            "summary": self.summary[:160],
            "skip": self.skip,
            "published": self.published,
            "ecosystem": self.ecosystem,
            "package": self.package,
        }


def _cwes(doc: dict) -> tuple[str, ...]:
    """
    Both real shapes, because they genuinely differ between sources:

      * the advisory-database repo files put them at database_specific.cwe_ids,
        a list of bare strings like "CWE-79";
      * the REST API puts them at cwes, a list of {cwe_id, name} objects.

    Getting this wrong is not a crash, it is a silently empty CWE list and
    therefore every record classified `no_cwe` — a whole source reported as
    unusable when the real fault is one attribute path. This actually happened
    while building the fixture, which is why the check is now explicit.
    """
    out: list[str] = []
    ds = (doc.get("database_specific") or {})
    for c in ds.get("cwe_ids") or []:
        out.append(str(c))
    for c in doc.get("cwes") or []:
        if isinstance(c, dict):
            if c.get("cwe_id"):
                out.append(str(c["cwe_id"]))
        elif c:
            out.append(str(c))
    # Stable, de-duplicated, order-preserving.
    seen: set[str] = set()
    uniq: list[str] = []
    for c in out:
        k = c.strip().upper()
        if k and k not in seen:
            seen.add(k)
            uniq.append(k)
    return tuple(uniq)


def _severity(doc: dict) -> str:
    """
    Severity, from either shape — and the two shapes are genuinely different:

      * REST API:     "severity": "high"                        (a label)
      * repo files:   "severity": [{"type":"CVSS_V3","score":"CVSS:3.1/..."},
                                   {"type":"CVSS_V4","score":"CVSS:4.0/..."}]
                                                               (CVSS vectors)

    Treating the repo shape as a label yields the string "unknown" for every
    record, which makes every class report severe: 0 and weight 0.0 while still
    reporting n > 0 — a source that looks mapped but carries no severity signal.
    This actually happened. So:

      1. a string label is normalised through the shared vocabulary;
      2. a CVSS vector list is reduced to a score and banded;
      3. anything else is "unknown", which the caller counts as a skip rather
         than silently averaging in as 0.0 severity.
    """
    raw = doc.get("severity")
    if isinstance(raw, str) and raw.strip():
        return _IM.norm_severity(raw)

    if isinstance(raw, list) and raw:
        best: float | None = None
        for item in raw:
            if not isinstance(item, dict):
                continue
            vec = str(item.get("score") or "")
            score = _cvss_score(vec)
            if score is not None and (best is None or score > best):
                best = score
        if best is not None:
            return _band(best)

    # Some records carry only a numeric cvss.score.
    num = (doc.get("cvss") or {}).get("score") if isinstance(doc.get("cvss"), dict) else None
    if isinstance(num, (int, float)):
        return _band(float(num))
    return "unknown"


def _cvss_score(vector: str) -> float | None:
    """
    Derive a 4.0 band from a CVSS v3.1/v4.0 vector WITHOUT a CVSS library.

    Deliberately a coarse band, not a computed base score: implementing the full
    formula by hand would be a large amount of unaudited arithmetic whose only
    job is to pick one of four buckets. The metrics below are the ones that move
    exploitability and impact, and a mis-band lands at most one severity step
    away. Where a vector is unfamiliar, None is returned and the caller reports
    the record as unknown rather than guessing a number.
    """
    if not vector.startswith("CVSS:"):
        return None
    parts = dict(
        p.split(":", 1) for p in vector.split("/")[1:] if ":" in p
    )
    av = parts.get("AV")
    ac = parts.get("AC")
    pr = parts.get("PR")
    ui = parts.get("UI")
    conf = parts.get("C") or parts.get("VC")
    integ = parts.get("I") or parts.get("VI")
    avail = parts.get("A") or parts.get("VA")
    if not (av and conf and integ and avail):
        return None

    # Impact: count fully-compromised pillars.
    high_pillars = sum(1 for v in (conf, integ, avail) if v == "H")
    low_pillars = sum(1 for v in (conf, integ, avail) if v == "L")
    if high_pillars >= 2:
        base = 8.0
    elif high_pillars == 1 or low_pillars >= 2:
        base = 6.0
    elif low_pillars == 1:
        base = 4.0
    else:
        base = 0.0
    if base == 0.0:
        return 0.0
    # Exploitability adjustments.
    if av == "N":
        base += 1.0
    if ac == "L":
        base += 0.5
    if pr == "N":
        base += 0.5
    if ui == "N":
        base += 0.5
    return min(base, 10.0)


def _band(score: float) -> str:
    """CVSS v3 qualitative bands, which the digest vocabulary already uses."""
    if score >= 9.0:
        return "critical"
    if score >= 7.0:
        return "high"
    if score >= 4.0:
        return "medium"
    if score > 0.0:
        return "low"
    return "info"


def parse_advisory(doc: dict) -> Advisory:
    """One advisory document → one Advisory. Pure; no I/O, no clock."""
    cwe_ids = _cwes(doc)
    cls = class_from_cwe(cwe_ids)
    if cls is not None and not is_web_class(cls):
        # A Solidity CWE (CWE-841 → sol.reentrancy) arriving from a web2 source.
        # Keeping it would let GHSA move a sol.* prior, which is not what this
        # ingest is for and would be entangled with the web3 corpus.
        skip = "sol_class_out_of_scope"
        cls = None
    else:
        skip = "" if cls else explain_skip(cwe_ids)

    affected = doc.get("affected") or []
    eco, pkg = "", ""
    if isinstance(affected, list) and affected:
        p = (affected[0] or {}).get("package") or {}
        eco, pkg = str(p.get("ecosystem") or ""), str(p.get("name") or "")

    return Advisory(
        id=str(doc.get("id") or doc.get("ghsa_id") or ""),
        cwe_ids=cwe_ids,
        severity=_severity(doc),
        summary=str(doc.get("summary") or ""),
        cls=cls,
        skip=skip,
        published=str(doc.get("published") or ""),
        ecosystem=eco,
        package=pkg,
    )


# ──────────────────────────────────────────────────────────── ingestion ─────


def iter_advisories(
    fetch: Callable[[str], Any],
    *,
    cwes: Iterable[str] | None = None,
    pages: int = 1,
    per_page: int = 100,
) -> Iterator[dict]:
    """
    Yield raw advisory documents from an INJECTED fetcher.

    `fetch(url) -> parsed JSON` is the only way documents get in. There is no
    urllib call in this module, so importing it cannot touch the network and a
    test cannot accidentally depend on GitHub being up or on a rate limit.

    The API's `cwes` filter is accepted here (as `cwes=`) but note it is
    optional: the tested path is a local fixture directory (see
    `iter_advisory_dir`), because the REST filter's behaviour for an unknown or
    absent CWE is not something this harness should rely on.
    """
    for page in range(1, pages + 1):
        url = f"https://api.github.com/advisories?per_page={per_page}&page={page}"
        if cwes:
            joined = ",".join(sorted(cwes))
            url += f"&cwes={joined}"
        batch = fetch(url)
        if not isinstance(batch, list) or not batch:
            return
        for doc in batch:
            if isinstance(doc, dict):
                yield doc
        if len(batch) < per_page:
            return


def iter_advisory_dir(path: Path) -> Iterator[dict]:
    """
    Read advisory-database files from a local checkout, deterministically
    ordered. This is the path the committed fixture was built from: it needs no
    network, no token, and no rate limit.
    """
    for f in sorted(Path(path).rglob("*.json")):
        try:
            doc = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(doc, dict) and doc.get("id"):
            yield doc


def ingest(docs: Iterable[dict]) -> dict:
    """
    Aggregate parsed advisories into per-class counts + an auditable skip ledger.

    Shape mirrors what `harness.py` needs and what `corpus_sources.rows_ingested`
    records: n / severe / critical / high / medium / weight, plus the reason
    counts so a low n can be explained rather than merely noticed.
    """
    classes: dict[str, dict] = {
        c: {"n": 0, "severe": 0, "critical": 0, "high": 0, "medium": 0, "_w": 0.0}
        for c in WEB_CLASSES
    }
    skipped: dict[str, int] = {}
    cwe_histogram: dict[str, int] = {}
    total = 0
    unmapped_examples: dict[str, list[str]] = {}

    for doc in docs:
        a = parse_advisory(doc)
        total += 1
        for c in a.cwe_ids:
            cwe_histogram[c] = cwe_histogram.get(c, 0) + 1
        if a.cls is None:
            skipped[a.skip] = skipped.get(a.skip, 0) + 1
            if a.skip == "unrecognised":
                for c in a.cwe_ids:
                    if c not in CWE_TO_CLASS and c not in CWE_NO_CLASS:
                        bucket = unmapped_examples.setdefault(c, [])
                        if len(bucket) < 3:
                            bucket.append(a.id)
            continue
        c = classes[a.cls]
        sev = a.severity if a.severity in SEV_WEIGHT else "unknown"
        w = SEV_WEIGHT[sev]
        c["n"] += 1
        c["_w"] += w
        if sev in ("critical", "high", "medium"):
            c["severe"] += 1
        if sev == "critical":
            c["critical"] += 1
        elif sev == "high":
            c["high"] += 1
        elif sev == "medium":
            c["medium"] += 1

    for c in classes.values():
        n = c["n"]
        # weight 0.0 and validatable False when n == 0 — the honest-zero rule,
        # applied here at the source so it cannot be violated downstream.
        c["weight"] = round(c.pop("_w") / n, 3) if n else 0.0
        c["validatable"] = n > 0

    return {
        "source": "ghsa",
        "advisories_seen": total,
        "advisories_mapped": total - sum(skipped.values()),
        "classes": classes,
        "skipped": dict(sorted(skipped.items())),
        "cwe_histogram": dict(sorted(cwe_histogram.items(), key=lambda kv: (-kv[1], kv[0]))),
        "unmapped_cwe_examples": dict(sorted(unmapped_examples.items())),
    }


def report(result: dict) -> str:
    """Human-readable summary. Returns text; never prints, never writes."""
    lines = [
        "# GHSA → web.* ingest",
        "",
        f"advisories seen: **{result['advisories_seen']:,}**  "
        f"mapped: **{result['advisories_mapped']:,}**",
        "",
        "| class | n | severe | weight | validatable |",
        "|---|---|---|---|---|",
    ]
    rows = sorted(result["classes"].items(), key=lambda kv: (-kv[1]["n"], kv[0]))
    for cls, s in rows:
        lines.append(
            f"| `{cls}` | {s['n']:,} | {s['severe']:,} | {s['weight']} | {s['validatable']} |"
        )
    if result["skipped"]:
        lines += ["", "## Skipped, by reason", ""]
        for reason, n in result["skipped"].items():
            lines.append(f"- `{reason}` — {n:,}")
    if result["unmapped_cwe_examples"]:
        lines += [
            "",
            "## CWEs with no mapping (candidates for the table, NOT guessed at here)",
            "",
        ]
        for cwe, ids in result["unmapped_cwe_examples"].items():
            lines.append(f"- `{cwe}` — e.g. {', '.join(ids)}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="CWE → web.* ground truth from GHSA")
    ap.add_argument("--dir", help="local advisory-database checkout to read")
    ap.add_argument("--out", help="write the JSON result here")
    args = ap.parse_args(argv)
    if not args.dir:
        ap.print_help()
        return 2
    result = ingest(iter_advisory_dir(Path(args.dir)))
    text = report(result)
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2) + "\n")
        sys.stderr.write(f"wrote {args.out}\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
