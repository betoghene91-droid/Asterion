#!/usr/bin/env python3
"""
Eval harness — turns "the bot is learning" into a number.

Measured against the real corpus schema (verified, not assumed):
  findings.jsonl.gz -> 180,907 rows.
  Useful fields: vuln_group, vuln_leaf, severity, project, firm,
                 audit_year, title, body_text, original_url.

It reports two different things, kept strictly apart:

  1. CORPUS SUPPORT — how many expert-labelled severe findings exist for a
     bug class, so we know whether that class can be validated at all.
     Ground-truth availability, nothing more.

  2. DETECTION — did a detector find a known finding cold from pre-fix
     code. This needs a repo checkout per project; v1 does not wire that,
     so it is reported as 0 measured with the reason stated.

One finding that shaped this file: the corpus is entirely web3. Fifteen
web2 playbooks therefore have NO ground truth here. They are listed with an
empty group so the gap is explicit instead of silently borrowing coverage
from a same-named Solidity class.
"""

from __future__ import annotations

import gzip
import json
import os
import random
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

OUT = Path("eval/out")
DATA = Path(os.environ.get("CORPUS", "../.corpus/findings.jsonl.gz"))
SEED = 1337
MAX_SCAN = 250_000
SEVERE = {"critical", "high", "medium"}

# playbook id -> (vuln_group, matching vuln_leaf prefixes)
# An empty group means: this corpus holds no ground truth for that playbook.
PLAYBOOK_MAP: dict[str, tuple[str, tuple[str, ...]]] = {
    # solidity — representable in this corpus
    "sol.reentrancy":    ("reentrancy", ("reentrancy.callback", "reentrancy.guard_composition", "reentrancy.readonly")),
    "sol.accesscontrol": ("access_control", (
        "access_control.missing_authorization",
        "access_control.role_lifecycle",
        "access_control.capability_scope",
        "access_control.account_identity",
    )),
    "sol.oracle":        ("oracle_price", (
        "oracle_price.manipulable_price",
        "oracle_price.stale_invalid_price",
        "oracle_price.conversion",
        "oracle_price.availability",
    )),
    "sol.rounding":      ("arithmetic", (
        "arithmetic.rounding_dust",
        "arithmetic.precision_scaling",
        "arithmetic.overflow_underflow",
        "arithmetic.unsafe_cast",
    )),
    "sol.inflation":     ("logic_accounting", ("logic_accounting.balance_shares",)),
    "sol.upgrade":       ("upgradeability", (
        "upgradeability.initialization",
        "upgradeability.proxy_upgrade",
        "upgradeability.storage_layout",
    )),
    "sol.signature":     ("signature_replay", (
        "signature_replay.verification",
        "signature_replay.replay_domain",
        "signature_replay.payload_binding",
    )),
    "sol.delegatecall":  ("input_validation", ("input_validation.address_parameter",)),
    "sol.flashloan":     ("oracle_price", ("oracle_price.manipulable_price",)),
    "sol.dos":           ("dos", (
        "dos.funds_liveness",
        "dos.unbounded_work",
        "dos.revert_griefing",
        "dos.resource_limits",
    )),

    # web2 — no ground truth in a web3-only corpus
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

WEB2_PLAYBOOKS = {k for k, (g, _) in PLAYBOOK_MAP.items() if g == ""}


@dataclass
class Row:
    uid: str
    project: str
    firm: str
    year: int | None
    severity: str
    group: str
    leaf: str
    title: str
    measured: bool = False
    detected: bool = False
    reason: str = ""


def load() -> list[Row]:
    if not DATA.exists():
        return []
    rows: list[Row] = []
    with gzip.open(DATA, "rt", encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh):
            if i > MAX_SCAN:
                break
            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                continue
            yr = j.get("audit_year")
            rows.append(
                Row(
                    uid=str(j.get("finding_uid") or j.get("finding_id") or f"r{i}"),
                    project=str(j.get("project") or ""),
                    firm=str(j.get("firm") or ""),
                    year=int(yr) if str(yr).isdigit() else None,
                    severity=str(j.get("severity") or "unknown").lower(),
                    group=str(j.get("vuln_group") or "unclassified"),
                    leaf=str(j.get("vuln_leaf") or "unclassified"),
                    title=str(j.get("title") or "")[:200],
                )
            )
    return rows


def matches(r: Row, group: str, leaves: tuple[str, ...]) -> bool:
    """An empty group can never match: it means 'not in this corpus'."""
    if not group:
        return False
    if r.group != group:
        return False
    if not leaves:
        return True
    return r.leaf.startswith(leaves)


def corpus_support(rows: list[Row]) -> dict:
    out: dict[str, dict] = {}
    for pb, (group, leaves) in PLAYBOOK_MAP.items():
        if not group:
            out[pb] = {"group": None, "all": 0, "severe": 0, "recent_severe": 0,
                       "sample_projects": [], "validatable": False}
            continue
        hit = [r for r in rows if matches(r, group, leaves)]
        severe = [r for r in hit if r.severity in SEVERE]
        recent = [r for r in severe if r.year and r.year >= 2024]
        out[pb] = {
            "group": group,
            "all": len(hit),
            "severe": len(severe),
            "recent_severe": len(recent),
            "sample_projects": sorted(
                {
                    r.project
                    for r in severe
                    if r.project
                    and 2 <= len(r.project) <= 40
                    and not r.project.startswith(("(", "$", ".", '"', "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"))
                    and "http" not in r.project
                    and "\n" not in r.project
                }
            )[:3],
            "validatable": True,
        }
    return out


def detection_sample(rows: list[Row], n: int) -> list[Row]:
    targeted = [
        r for r in rows
        if r.severity in SEVERE and any(matches(r, g, l) for g, l in PLAYBOOK_MAP.values())
    ]
    if not targeted:
        return []

    random.seed(SEED)
    weighted: list[Row] = []
    for r in targeted:
        w = 1
        if r.year and r.year >= 2024:
            w += 2
        if r.severity in {"critical", "high"}:
            w += 1
        weighted.extend([r] * w)
    random.shuffle(weighted)

    seen: set[str] = set()
    out: list[Row] = []
    for r in weighted:
        if r.uid in seen:
            continue
        seen.add(r.uid)
        r.measured = False
        r.detected = False
        r.reason = "no per-project checkout wired yet; class measurable, instance not"
        out.append(r)
        if len(out) >= n:
            break
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    n = int(os.environ.get("SAMPLE_SIZE", "60"))

    rows = load()
    support = corpus_support(rows)
    sample = detection_sample(rows, n)

    sol = {k: v for k, v in support.items() if k not in WEB2_PLAYBOOKS}
    weak = sorted(sol.items(), key=lambda kv: kv[1]["recent_severe"])[:5]
    strong = sorted(sol.items(), key=lambda kv: -kv[1]["recent_severe"])[:5]
    unsupported = sorted(k for k, v in sol.items() if v["severe"] == 0)

    scoreboard = {
        "corpus_rows": len(rows),
        "playbooks_total": len(PLAYBOOK_MAP),
        "playbooks_validatable": len(sol),
        "playbooks_unmeasurable_here": sorted(WEB2_PLAYBOOKS),
        "unsupported_solidity_playbooks": unsupported,
        "support": support,
        "detection": {
            "sampled": len(sample),
            "measured": 0,
            "note": "v1 ships discovery + monitoring; per-project checkouts are v2",
        },
    }
    (OUT / "scoreboard.json").write_text(json.dumps(scoreboard, indent=2))
    (OUT / "sample.json").write_text(json.dumps([asdict(r) for r in sample], indent=2))

    lines = [
        "# Eval scoreboard",
        "",
        f"corpus rows read: **{len(rows):,}**",
        f"playbooks: **{len(PLAYBOOK_MAP)}** "
        f"({len(sol)} validatable against this corpus, {len(WEB2_PLAYBOOKS)} not)",
        "",
        "## Corpus support — Solidity playbooks",
        "",
        "| playbook | severe | 2024+ |",
        "|---|---|---|",
    ]
    for pb, s in sorted(sol.items(), key=lambda kv: -kv[1]["recent_severe"]):
        lines.append(f"| `{pb}` | {s['severe']:,} | {s['recent_severe']:,} |")

    lines += [
        "",
        "## Strongest ground truth",
        "",
        *[f"- `{k}` — {v['recent_severe']:,} recent severe" for k, v in strong],
        "",
        "## Weakest ground truth",
        "",
        *[f"- `{k}` — {v['recent_severe']:,} recent severe" for k, v in weak],
        "",
        "## Not measurable with this corpus",
        "",
        f"The corpus is web3-only. {len(WEB2_PLAYBOOKS)} web2 playbooks have zero",
        "ground truth here, so they are validated by live testing instead:",
        "",
        *[f"- `{p}`" for p in sorted(WEB2_PLAYBOOKS)],
    ]
    if unsupported:
        lines += ["", "### Solidity classes with no severe support", "",
                  *[f"- `{p}`" for p in unsupported]]

    lines += [
        "",
        "## Detection",
        "",
        f"sampled **{len(sample)}** severe findings our playbooks target.",
        "measured **0** — per-project checkouts are a v2 capability.",
        "",
        "> Unmeasured is not undetected. This run makes no recall claim.",
    ]

    (OUT / "scoreboard.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
