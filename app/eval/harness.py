#!/usr/bin/env python3
"""
Eval harness — turns "the bot is learning" into a number, and says where each
number came from.

WHAT CHANGED AND WHY
--------------------
v1 of this file reported:

    "detection": {"sampled": 60, "measured": 0,
                  "note": "v1 ships discovery + monitoring; per-project checkouts are v2"}

That was honest and it was useless. "0 measured" reads like a placeholder waiting
for an engineer, so nobody acted on it, and the class priors in learn.ts stayed
fed only by the digest. The truth was worse than a placeholder: nothing was
computing tp/fp/fn at all.

This version does compute them, at CLASS granularity, and labels every number:

    live: <tool> @ <commit>   produced by running the tool on that checkout NOW
    fixture: <path>           produced by scoring a committed capture of a real run

Those two are never averaged. `live` is what the machine can do today; `fixture`
is what was reproducible on the day the capture was taken. A reader who cannot
tell them apart cannot tell a fresh measurement from a stale one.

TWO THINGS THIS STILL DOES NOT CLAIM
------------------------------------
1. It does not claim instance-level detection ("the tool found THE audited bug at
   line N"). The corpus pins findings to a report, not to a file+line in a pinned
   commit, so that claim is unsupportable here. See eval-class-scoring.md.
2. It does not claim a general precision for any tool. The sample is 3 projects.
   `n_projects` is printed next to every ratio so the numbers cannot be quoted
   without their sample size.

WHAT IT REPORTS
---------------
  1. CORPUS SUPPORT — how many expert-labelled severe findings exist per class.
     Ground-truth availability, nothing more.
  2. CLASS DETECTION — per class per tool tp/fp/fn, plus pooled precision.
  3. WEB2 GROUND TRUTH — GHSA CWE → web.* counts, when a fixture is present.
     The web3 corpus cannot supply this (see web2_ground_truth.py).

Usage:
    python3 eval/harness.py                     # score the committed fixture
    python3 eval/harness.py --live --root /tmp   # re-run the tools on checkouts
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import random
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
sys.path.insert(0, str(HERE))

import scoring  # noqa: E402
import web2_ground_truth  # noqa: E402

OUT = APP / "eval" / "out"
FIXTURE = HERE / "fixtures" / "live-detector-runs.json"
GHSA_FIXTURE = HERE / "fixtures" / "ghsa-advisories.json"
PROJECTS = HERE / "projects.json"
DATA = Path(os.environ.get("CORPUS", str(APP.parent / ".corpus" / "findings.jsonl.gz")))
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
        r.reason = "sampled for instance-level scoring, which this harness does not claim"
        out.append(r)
        if len(out) >= n:
            break
    return out


# ──────────────────────────────────────────────────── detection scoring ─────


def score_fixture() -> tuple[dict, str]:
    """Score the committed capture. Provenance: fixture:<path>."""
    if not FIXTURE.is_file():
        return {"error": f"missing fixture {FIXTURE}", "per_class": []}, f"fixture:{FIXTURE}"
    capture = json.loads(FIXTURE.read_text())
    result = scoring.score_capture(capture)
    result["captured_at"] = capture.get("captured_at", "")
    return result, f"fixture:{FIXTURE.relative_to(APP)}"


def score_live(root: Path) -> tuple[dict, str]:
    """Re-run every available detector on the pinned checkouts. Provenance: live."""
    import capture_live

    manifest = json.loads(PROJECTS.read_text())
    captured = []
    for entry in manifest["projects"]:
        checkout = root / entry["checkout"]
        if not (checkout / ".git").exists():
            print(f"WARNING: no checkout at {checkout} — {entry['id']} not measured", file=sys.stderr)
            continue
        try:
            captured.append(capture_live.capture_project(checkout, entry))
        except SystemExit as exc:
            print(f"WARNING: {exc}", file=sys.stderr)
    if not captured:
        return {"error": "no checkouts available for a live run", "per_class": []}, "live:none"
    result = scoring.score_capture({"projects": captured})
    commits = ", ".join(f"{p['id']}@{p['commit'][:12]}" for p in captured)
    return result, f"live:{commits}"


# ──────────────────────────────────────────────────────── web2 ground truth ─────


def score_web2() -> dict:
    if not GHSA_FIXTURE.is_file():
        return {"available": False, "reason": f"missing fixture {GHSA_FIXTURE}"}
    payload = json.loads(GHSA_FIXTURE.read_text())
    result = web2_ground_truth.ingest(iter(payload.get("advisories") or []))
    result["available"] = True
    result["provenance"] = f"fixture:{GHSA_FIXTURE.relative_to(APP)}"
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="re-run the detectors instead of scoring the fixture")
    ap.add_argument("--root", default=".", help="directory holding the pinned checkouts (for --live)")
    args = ap.parse_args(argv)

    OUT.mkdir(parents=True, exist_ok=True)
    n = int(os.environ.get("SAMPLE_SIZE", "60"))

    rows = load()
    support = corpus_support(rows)
    sample = detection_sample(rows, n)

    if args.live:
        det, provenance = score_live(Path(args.root).resolve())
    else:
        det, provenance = score_fixture()
    web2 = score_web2()

    sol = {k: v for k, v in support.items() if k not in WEB2_PLAYBOOKS}
    weak = sorted(sol.items(), key=lambda kv: kv[1]["recent_severe"])[:5]
    strong = sorted(sol.items(), key=lambda kv: -kv[1]["recent_severe"])[:5]
    unsupported = sorted(k for k, v in sol.items() if v["severe"] == 0)

    measured_tools = [t for t in det.get("tools", {}).values() if t.get("projects_measured", 0) > 0]
    per_class = det.get("per_class", [])

    scoreboard = {
        "corpus_rows": len(rows),
        "corpus_present": DATA.is_file(),
        "playbooks_total": len(PLAYBOOK_MAP),
        "playbooks_validatable": len(sol),
        "playbooks_unmeasurable_here": sorted(WEB2_PLAYBOOKS),
        "unsupported_solidity_playbooks": unsupported,
        "support": support,
        "detection": {
            "provenance": provenance,
            "mode": "live" if args.live else "fixture",
            "n_projects": det.get("n_projects", 0),
            "tools_measured": len(measured_tools),
            "per_class": per_class,
            "tools": det.get("tools", {}),
            "error": det.get("error", ""),
            "note": (
                "CLASS-level tp/fp/fn, not instance-level. A hit means the tool fired "
                "on that class somewhere in the checkout; it does NOT mean it found the "
                "specific audited bug. Sample is small — read n_projects."
            ),
        },
        "web2_ground_truth": web2,
        "sampled": len(sample),
    }
    (OUT / "scoreboard.json").write_text(json.dumps(scoreboard, indent=2))
    (OUT / "sample.json").write_text(json.dumps([asdict(r) for r in sample], indent=2))

    lines = [
        "# Eval scoreboard",
        "",
        f"corpus rows read: **{len(rows):,}**"
        + ("" if DATA.is_file() else "  _(corpus ABSENT — support columns are not measurements)_"),
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
        "## Detection — per class",
        "",
        f"**provenance: `{provenance}`**  ·  projects: **{det.get('n_projects', 0)}**  ·  "
        f"tools measured: **{len(measured_tools)}**",
        "",
        "| class | tp | fp | fn | precision | measured | tools |",
        "|---|---|---|---|---|---|---|",
    ]
    for row in per_class:
        prec = row.get("precision")
        lines.append(
            f"| `{row['cls']}` | {row['tp']} | {row['fp']} | {row['fn']} | "
            f"{'—' if prec is None else prec} | {row['measured']} | "
            f"{','.join(row.get('tools') or []) or '—'} |"
        )

    # Unavailable runs are named explicitly. A tool that did not compile a project
    # is not a tool with 0% recall, and the difference must survive into the report.
    unavail = []
    for tool, body in (det.get("tools") or {}).items():
        for proj, why in (body.get("unavailability") or {}).items():
            unavail.append(f"- `{tool}` on `{proj}` — **did not run**: {why[:160]}")
    if unavail:
        lines += ["", "### Detectors that DID NOT RUN (excluded from every ratio)", ""] + unavail

    lines += [
        "",
        "## Tool totals",
        "",
        "| tool | precision | recall | projects measured | unavailable |",
        "|---|---|---|---|---|",
    ]
    for tool, body in (det.get("tools") or {}).items():
        p, r = body.get("precision"), body.get("recall")
        lines.append(
            f"| `{tool}` | {'—' if p is None else p} | {'—' if r is None else r} | "
            f"{body.get('projects_measured', 0)} | {body.get('projects_unavailable', 0)} |"
        )

    lines += [
        "",
        "> Class-level, not instance-level. A hit is a firing somewhere in the "
        "checkout, not a located instance of the audited bug. Read `n_projects` "
        "before quoting a ratio.",
        "",
        "## Web2 ground truth (GHSA → web.*)",
        "",
    ]
    if web2.get("available"):
        lines += [
            f"provenance: `{web2['provenance']}`  ·  advisories seen: "
            f"**{web2['advisories_seen']}**  ·  mapped: **{web2['advisories_mapped']}**",
            "",
            "| class | n | severe | weight | validatable |",
            "|---|---|---|---|---|",
        ]
        for cls, s in sorted(web2["classes"].items(), key=lambda kv: (-kv[1]["n"], kv[0])):
            lines.append(
                f"| `{cls}` | {s['n']} | {s['severe']} | {s['weight']} | {s['validatable']} |"
            )
        if web2.get("skipped"):
            lines += ["", "Skipped: " + ", ".join(f"`{k}` {v}" for k, v in web2["skipped"].items())]
        lines += [
            "",
            "> This is a 67-advisory SAMPLE, not the full database. It proves the "
            "mapper works and gives `web.*` a real (small) ground truth. It does "
            "not replace a full ingest, and a class still at n=0 stays unmeasured.",
        ]
    else:
        lines.append(f"not available: {web2.get('reason', 'unknown')}")

    lines += [
        "",
        "## Not measurable with this corpus",
        "",
        f"The corpus is web3-only. {len(WEB2_PLAYBOOKS)} web2 playbooks have zero",
        "ground truth here; their section above is the separate GHSA path:",
        "",
        *[f"- `{p}`" for p in sorted(WEB2_PLAYBOOKS)],
    ]
    if unsupported:
        lines += ["", "### Solidity classes with no severe support", "",
                  *[f"- `{p}`" for p in unsupported]]

    lines += [
        "",
        "## Strongest / weakest ground truth",
        "",
        *[f"- strongest: `{k}` — {v['recent_severe']:,} recent severe" for k, v in strong],
        *[f"- weakest: `{k}` — {v['recent_severe']:,} recent severe" for k, v in weak],
        "",
        "> Unmeasured is not undetected. A class with no measurement makes no recall claim.",
    ]

    (OUT / "scoreboard.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
