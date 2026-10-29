#!/usr/bin/env python3
"""
Distil the 102 MB audit corpus into a compact precedent digest.

Why this exists: the Worker has a 500 MB D1 database, a 10 ms CPU budget and a
50-subrequest ceiling. It cannot hold or search 180,907 rows at runtime. It CAN
hold ~1 MB of distilled precedent and search that in microseconds.

Output: corpus-digest.json, which is (a) committed, so the bot ships knowing
what 13,000 audits concluded, and (b) loadable into D1 as a single blob.

Source: https://github.com/DicksonWu654/web3-audit-corpus (releases/latest).
The upstream derived metadata and annotations are CC BY 4.0 (Dickson Wu); the
attribution and an explicit statement of changes are embedded in the digest
itself so loading it cannot silently drop the obligation.

Usage: python3 eval/distill.py [--in path] [--out path]
"""

from __future__ import annotations

import gzip
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Mirrors PLAYBOOK_MAP in harness.py, plus the intake playbook ids.
PLAYBOOK_MAP: dict[str, tuple[str, tuple[str, ...]]] = {
    "sol.reentrancy":    ("reentrancy", ("reentrancy.callback", "reentrancy.guard_composition", "reentrancy.readonly")),
    "sol.accesscontrol": ("access_control", (
        "access_control.missing_authorization", "access_control.role_lifecycle",
        "access_control.capability_scope", "access_control.account_identity",
    )),
    "sol.oracle":        ("oracle_price", (
        "oracle_price.manipulable_price", "oracle_price.stale_invalid_price",
        "oracle_price.conversion", "oracle_price.availability",
    )),
    "sol.rounding":      ("arithmetic", (
        "arithmetic.rounding_dust", "arithmetic.precision_scaling",
        "arithmetic.overflow_underflow", "arithmetic.unsafe_cast",
    )),
    "sol.inflation":     ("logic_accounting", ("logic_accounting.balance_shares",)),
    "sol.upgrade":       ("upgradeability", (
        "upgradeability.initialization", "upgradeability.proxy_upgrade", "upgradeability.storage_layout",
    )),
    "sol.signature":     ("signature_replay", (
        "signature_replay.verification", "signature_replay.replay_domain", "signature_replay.payload_binding",
    )),
    "sol.delegatecall":  ("input_validation", ("input_validation.address_parameter",)),
    "sol.flashloan":     ("oracle_price", ("oracle_price.manipulable_price",)),
    "sol.dos":           ("dos", (
        "dos.funds_liveness", "dos.unbounded_work", "dos.revert_griefing", "dos.resource_limits",
    )),
    # Web2 classes are absent from a web3 corpus. Validatable flags them false.
    "web.idor":           ("", ()),
    "web.authz.function": ("", ()),
    "web.ssrf":           ("", ()),
    "web.sqli":           ("", ()),
    "web.xss.reflected":  ("", ()),
    "web.cors":           ("", ()),
    "web.jwt":            ("", ()),
    "web.race":           ("", ()),
    "web.upload":         ("", ()),
    "web.traversal":      ("", ()),
    "web.graphql":        ("", ()),
    "web.massassign":     ("", ()),
    "web.reset":          ("", ()),
    "web.oauth":          ("", ()),
    "web.takeover":       ("", ()),
}

SEV_WEIGHT = {"critical": 3.0, "high": 2.0, "medium": 1.0, "low": 0.4, "info": 0.1, "gas": 0.0, "unknown": 0.0}

# Measured, not guessed. The deduped + title-passing candidate pools hold
# 15,101 entries across the 10 web3 classes (sol.accesscontrol alone has 3,415),
# so a cap of 40 was discarding ~97% of the available ground truth.
#
# Sizing was driven by the runtime, not by the 2 MB ceiling alone. Measured with
# the Worker's own compiled corpus.js (bench_runtime.mjs / eval_quality.mjs):
#
#   cap   bytes   entries  parse ms  retrieve ms  leaf-purity@5  firms  projects
#    40   155 KB     400      0.19        0.055          0.600     155       342
#   150   551 KB   1,500      0.68        0.252          0.567     337     1,287
#   250   913 KB   2,500      0.90        0.427          0.667     404     2,080
#   300  1,093 KB   3,000      1.19        0.516          0.667     420     2,449
#   400  1,447 KB   3,977      1.48        0.702          0.717     448     3,179
#
# Leaf purity (does top-5 retrieval land on the expected vuln_leaf) saturates at
# 250: 300 adds 500 entries and 180 KB for no measurable purity gain, and 400
# would spend 71% of the hard 2 MB cap for a marginal 0.667 -> 0.717. 250 is the
# knee of the curve. Lower it if the digest must shrink; raise it only with
# fresh measurements.
#
# The digest is a strict superset. Entries are ranked before truncation, so the
# first 40 of every class are byte-identical to the old 40/class digest: the
# Telegram precedentScreen still renders the same top 5, and only retrieve()
# gains reach into the deeper pool.
MAX_PRECEDENT_PER_CLASS = 250

# Hard limit is 2 MB per single D1 value. Keep a wide reserve under it, because
# the Worker JSON.parse's this blob whole on every cold isolate, so bytes also
# cost CPU on a 10 ms budget.
MAX_DIGEST_BYTES = 1_200_000
MAX_SCAN = 400_000

# Titles that are body-text debris from PDF extraction, not findings.
DEBRIS = re.compile(
    r"^(line \d+|section\b|appendix\b|table\b|figure\b|page\d)", re.I)
SIGNAL_WORDS = re.compile(
    r"\b(can|allows?|lets?|permits?|missing|unchecked|unsafe|incorrect|wrong|bypass|drain|steal|"
    r"lock|freeze|manipulat|overflow|underflow|reentran|replay|unbounded|front.?run|grief|"
    r"spoof|forge|arbitrar|miscalculat|misaccount|double.?count|inflate|deflate|sandwich|"
    r"unauthori[sz]ed|unprotected|unvalidated|trust|stale|precision|truncat)",
    re.I,
)


def lexical_title(t: str) -> bool:
    t = t.strip()
    if not (18 <= len(t) <= 170):
        return False
    if DEBRIS.match(t):
        return False
    if t.endswith(":"):
        return False
    if len(re.findall(r"[a-z]", t)) < 10:
        return False
    return bool(SIGNAL_WORDS.search(t))


def to_signal(title: str, leaf: str) -> str:
    s = re.sub(r"\s+", " ", title).strip()
    s = re.sub(r"^[\d.\-)\s]+", "", s)
    s = re.sub(r"^(finding|issue|bug|vulnerability)\s*[:#-]?\s*", "", s, flags=re.I)
    cut = re.search(r"\.\s|;\s", s)
    if cut and cut.start() > 40:
        s = s[: cut.start()]
    family = leaf.split(".")[-1].replace("_", " ")
    if len(s) <= 8:
        s = f"review {family} handling"
    return f"{s[:150]}  [{family}]"


def main() -> int:
    argv = sys.argv[1:]
    src = Path(argv[argv.index("--in") + 1]) if "--in" in argv else Path(".corpus/findings.jsonl.gz")
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else Path("src/corpus-digest.json")

    if not src.exists():
        print(f"corpus not found at {src}", file=sys.stderr)
        return 1

    stats: dict[str, Counter] = defaultdict(Counter)
    precedent: dict[str, list[dict]] = defaultdict(list)
    years: Counter = Counter()
    firms: Counter = Counter()
    rows = 0
    usable = 0

    # First pass: count everything. Second concept: keep the best precedent.
    candidates: dict[str, list[tuple[float, dict]]] = defaultdict(list)

    with gzip.open(src, "rt", encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh):
            if i > MAX_SCAN:
                break
            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows += 1

            sev = str(j.get("severity") or "unknown").lower()
            w = SEV_WEIGHT.get(sev, 0.0)
            yr_raw = str(j.get("audit_year") or "")
            yr = int(yr_raw) if yr_raw.isdigit() else None
            if yr:
                years[yr] += 1
            firm = str(j.get("firm") or "")
            if firm:
                firms[firm] += 1

            group = str(j.get("vuln_group") or "")
            leaf = str(j.get("vuln_leaf") or "")
            title = str(j.get("title") or "").strip()

            for pb, (g, leaves) in PLAYBOOK_MAP.items():
                if not g or group != g:
                    continue
                if leaves and not leaf.startswith(leaves):
                    continue

                c = stats[pb]
                c["n"] += 1
                c["wsum"] += w
                if sev in ("critical", "high", "medium"):
                    c["severe"] += 1
                if sev == "critical":
                    c["critical"] += 1
                elif sev == "high":
                    c["high"] += 1
                elif sev == "medium":
                    c["medium"] += 1
                if yr and yr >= 2024:
                    c["recent"] += 1

                if not lexical_title(title):
                    continue

                usable += 1
                # Prefer severe, recent, and titled findings; dedupe by title.
                rank = w * 2 + (1.5 if yr and yr >= 2024 else 0) + (0.5 if firm else 0)
                candidates[pb].append(
                    (
                        rank,
                        {
                            "id": str(j.get("finding_uid") or f"r{i}"),
                            "project": str(j.get("project") or "")[:70],
                            "firm": firm[:50],
                            "year": yr,
                            "severity": sev,
                            "leaf": leaf,
                            "title": title[:170],
                            "signal": to_signal(title, leaf),
                        },
                    )
                )

    classes: dict[str, dict] = {}
    for pb, (g, _) in PLAYBOOK_MAP.items():
        c = stats.get(pb)
        if not g:
            classes[pb] = {
                "n": 0, "severe": 0, "critical": 0, "high": 0, "medium": 0,
                "recent": 0, "weight": 0.0, "validatable": False,
            }
            continue
        if not c or c["n"] == 0:
            classes[pb] = {
                "n": 0, "severe": 0, "critical": 0, "high": 0, "medium": 0,
                "recent": 0, "weight": 0.0, "validatable": True,
            }
            continue
        classes[pb] = {
            "n": c["n"],
            "severe": c["severe"],
            "critical": c["critical"],
            "high": c["high"],
            "medium": c["medium"],
            "recent": c["recent"],
            "weight": round(c["wsum"] / c["n"], 3),
            "validatable": True,
        }

    # Keep top precedent per class, deduped by normalised title.
    kept: dict[str, list[dict]] = {}
    for pb, cands in candidates.items():
        cands.sort(key=lambda x: -x[0])
        seen_titles: set[str] = set()
        picked: list[dict] = []
        for _rank, item in cands:
            key = re.sub(r"[^a-z0-9]+", "", item["title"].lower())[:80]
            if key in seen_titles:
                continue
            seen_titles.add(key)
            picked.append(item)
            if len(picked) >= MAX_PRECEDENT_PER_CLASS:
                break
        kept[pb] = picked

    # A lexicon per class: words that recur in accepted titles. Cheap priors
    # for the hunter's prompt and for keyword routing of hunks.
    lexicon: dict[str, list[str]] = {}
    for pb, items in kept.items():
        words: Counter = Counter()
        for it in items:
            for tok in re.findall(r"[a-z]{4,}", it["title"].lower()):
                if tok in {"that", "this", "with", "from", "have", "which", "when", "their", "there", "into", "also"}:
                    continue
                words[tok] += 1
        lexicon[pb] = [w for w, n in words.most_common(18) if n >= 2]

    digest = {
        # Digests with different precedent depth are not interchangeable.
        "version": "2",
        "source_rows": rows,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        # CC BY 4.0 on the upstream derived metadata + annotations requires
        # attribution AND a statement of changes. Both live here, in the data
        # itself, so loading the digest cannot silently drop the obligation.
        "attribution": {
            "source": "Web3 Audit Corpus, Dickson Wu",
            "url": "https://github.com/DicksonWu654/web3-audit-corpus",
            "data_licence": "CC BY 4.0",
            "data_licence_url": "https://creativecommons.org/licenses/by/4.0/",
            "finding_text": "Quoted finding titles remain the copyright of the publishers identified by firm; the CC BY grant covers only the corpus's derived metadata and annotations.",
            "changes": (
                "Subset only: filtered to finding rows whose vuln_group/vuln_leaf map to a bot playbook, "
                "then to titles passing a lexical debris filter. Reduced to one entry per normalized title, "
                "ranked by severity weight and recency, capped per class. Fields project/firm/year/severity/leaf/"
                "title retained; 'signal' is derived by truncating the upstream title. Aggregate class counts "
                "(n/severe/critical/high/medium/recent/weight) are computed here. Full text is not redistributed."
            ),
        },
        "precedent_per_class_cap": MAX_PRECEDENT_PER_CLASS,
        "classes": classes,
        "precedent": kept,
        "lexicon": lexicon,
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(digest, separators=(",", ":")))

    print(f"rows read        {rows:,}")
    print(f"usable precedent {usable:,}")
    print(f"digest written   {out}  ({out.stat().st_size / 1024:.0f} KB)")
    print()
    print(f"{'playbook':22} {'n':>7} {'severe':>7} {'2024+':>7} {'w':>5}  precedent")
    for pb in sorted(classes, key=lambda k: -classes[k]["recent"]):
        c = classes[pb]
        if not c["validatable"]:
            continue
        print(f"{pb:22} {c['n']:>7,} {c['severe']:>7,} {c['recent']:>7,} {c['weight']:>5.2f}  {len(kept.get(pb, []))}")
    unm = [k for k, v in classes.items() if not v["validatable"]]
    print(f"\nunmeasurable with this corpus: {len(unm)} web2 playbooks")

    # Sanity: the digest must fit one D1 value (hard cap 2 MB). The Worker
    # JSON.parse's this as one blob inside a 10 ms CPU budget, so stop well
    # short: MAX_DIGEST_BYTES keeps >800 KB of headroom below the hard cap.
    size = out.stat().st_size
    kb = size / 1024
    if size > MAX_DIGEST_BYTES:
        print(
            f"\nWARNING: digest is {kb:.0f} KB, over the {MAX_DIGEST_BYTES / 1024:.0f} KB budget "
            f"(D1 caps a single value at 2 MB and the Worker parses this blob whole); "
            f"reduce MAX_PRECEDENT_PER_CLASS in distill.py",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
