#!/usr/bin/env python3
"""
Capture live detector runs into a committed fixture. Run once, by hand, on a
machine that has the tools; the result is what `harness.py` scores by default.

WHY A CAPTURE STEP AT ALL
-------------------------
Two competing requirements, and this file is where they meet:

  * The numbers must come from a method that ACTUALLY RAN. A fixture someone
    hand-wrote to make the recall figure look plausible is worse than no fixture.
  * The test suite must never need the network, a checkout, ~100 MB of corpus, or
    a toolchain. A gate that only passes on a laptop with slither, forge, solc and
    aderyn installed is not a gate.

So: run everything here, once, and commit the OUTPUT. The committed file is
evidence of a real run (it carries tool versions, the exact commit of each
target, timestamps, and any tool that failed and why). `harness.py` then scores
that evidence deterministically.

The distinction the reports preserve: a number derived from this file is labelled
`fixture:<path>`, and a number produced by re-running the tools now is labelled
`live:<tool> @ <commit>`. They are never averaged together.

Usage:
    python3 eval/capture_live.py --root /tmp --out eval/fixtures/live-detector-runs.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
sys.path.insert(0, str(HERE))

import detectors  # noqa: E402


def git(root: Path, *args: str) -> str:
    p = subprocess.run(
        ["git", *args], cwd=str(root), capture_output=True, text=True, timeout=120
    )
    return (p.stdout or "").strip()


def capture_project(root: Path, manifest: dict) -> dict:
    """Run every available detector against one checkout and record it verbatim."""
    commit = git(root, "rev-parse", "HEAD")
    if commit != manifest["commit"]:
        # Refuse rather than mislabel: a run against the wrong tree is a lie
        # about which code was measured, and nothing downstream could detect it.
        raise SystemExit(
            f"{root}: HEAD is {commit[:12]} but manifest pins {manifest['commit'][:12]}"
        )
    runs = detectors.run_all(root)
    return {
        "id": manifest["id"],
        "repo": manifest["repo"],
        "commit": commit,
        "commit_date": git(root, "show", "-s", "--format=%cI", "HEAD"),
        "checked_out_at": root.as_posix(),
        "ground_truth": manifest["ground_truth"],
        "runs": [r.to_json() for r in runs],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="directory holding the pinned checkouts")
    ap.add_argument("--projects", default=str(HERE / "projects.json"))
    ap.add_argument("--out", default=str(HERE / "fixtures" / "live-detector-runs.json"))
    args = ap.parse_args()

    manifest = json.loads(Path(args.projects).read_text())
    rootdir = Path(args.root)
    out = Path(args.out)

    captured = []
    for entry in manifest["projects"]:
        checkout = rootdir / entry["checkout"]
        if not (checkout / ".git").exists():
            print(f"SKIP {entry['id']}: no checkout at {checkout}", file=sys.stderr)
            continue
        print(f"capturing {entry['id']} from {checkout} ...", file=sys.stderr)
        captured.append(capture_project(checkout, entry))

    payload = {
        "captured_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "captured_by": "eval/capture_live.py",
        "toolchain": detectors.availability(),
        "note": (
            "Produced by actually running each detector against each pinned commit. "
            "A tool with available=false DID NOT RUN on that project; its empty "
            "check list must never be read as 'found nothing'. Scores derived from "
            "this file must be labelled fixture:<this path>."
        ),
        "projects": captured,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(captured)} projects)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
