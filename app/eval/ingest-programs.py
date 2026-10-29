#!/usr/bin/env python3
"""
Ingest public program-scope data into a compact seed for discovery.

Why this matters: the bot's whole wedge is programs nobody lists, but it still
needs a starting corpus. Public aggregators publish machine-readable scope for
the big platforms, and that data is exactly the structured form our `programs`
table wants: handle, url, bounty flag, and per-asset eligibility.

What this does NOT do: assume platform policies permit automation. Every
program ingested here is marked `automation = 'unknown'` and must still be
resolved by fetching its own policy. Platform data tells you the asset is in
scope for *humans*; it says nothing about tools.

Input:  a directory containing hackerone_data.json / bugcrowd_data.json /
        intigriti_data.json / yeswehack_data.json, or domains.txt
Output: program-seed.json compiled into a D1 seed script

Usage: python3 eval/ingest-programs.py --in <dir> --out program-seed.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

MAX_ASSETS_PER_PROGRAM = 40
MAX_PROGRAMS = 2500


def load(dirpath: Path, name: str) -> Any:
    p = dirpath / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        print(f"  {name}: unparseable, skipping", file=sys.stderr)
        return None


def norm_host(a: str) -> str | None:
    a = a.strip().lower()
    if a.startswith("*."):
        a = a[2:]
    a = a.replace("https://", "").replace("http://", "")
    a = a.split("/")[0].split("?")[0]
    a = a.split(":")[0]
    if not a or "." not in a:
        return None
    if any(c in a for c in " *@"):
        return None
    if len(a) > 200:
        return None
    return a


def from_hackerone(data: list[dict]) -> list[dict]:
    out = []
    for prog in data:
        handle = prog.get("handle")
        if not handle:
            continue
        assets = []
        for t in (prog.get("targets") or {}).get("in_scope") or []:
            if not t.get("eligible_for_submission", True):
                continue
            h = norm_host(str(t.get("asset_identifier") or ""))
            if not h:
                continue
            assets.append(
                {
                    "value": h,
                    "kind": "domain",
                    "bounty": bool(t.get("eligible_for_bounty")),
                    "max_sev": t.get("max_severity") or "",
                    "type": t.get("asset_type") or "",
                }
            )
            if len(assets) >= MAX_ASSETS_PER_PROGRAM:
                break
        if not assets:
            continue
        out.append(
            {
                "id": f"h1:{handle}",
                "name": prog.get("name") or handle,
                "platform": "hackerone",
                "homepage": prog.get("url") or f"https://hackerone.com/{handle}",
                "reward": "monetary" if prog.get("offers_bounties") else (
                    "swag" if prog.get("offers_swag") else "recognition"
                ),
                "assets": assets,
            }
        )
    return out


def from_bugcrowd(data: Any) -> list[dict]:
    out = []
    items = data if isinstance(data, list) else (data.get("programs") or [])
    for prog in items:
        if not isinstance(prog, dict):
            continue
        name = prog.get("name") or prog.get("handle")
        if not name:
            continue
        assets = []
        for t in (prog.get("targets") or {}).get("in_scope") or []:
            h = norm_host(str(t.get("target") or t.get("asset_identifier") or ""))
            if not h:
                continue
            assets.append(
                {
                    "value": h,
                    "kind": "domain",
                    "bounty": bool(t.get("reward") or t.get("eligible_for_bounty")),
                    "max_sev": "",
                    "type": t.get("type") or "",
                }
            )
            if len(assets) >= MAX_ASSETS_PER_PROGRAM:
                break
        if not assets:
            continue
        out.append(
            {
                "id": "bc:" + str(prog.get("handle") or name).lower().replace(" ", "-"),
                "name": name,
                "platform": "bugcrowd",
                "homepage": prog.get("url") or "",
                "reward": "monetary" if prog.get("offers_bounties", True) else "recognition",
                "assets": assets,
            }
        )
    return out


def from_intigriti(data: Any) -> list[dict]:
    out = []
    items = data if isinstance(data, list) else (data.get("programs") or [])
    for prog in items:
        if not isinstance(prog, dict):
            continue
        handle = prog.get("handle") or prog.get("id")
        if not handle:
            continue
        assets = []
        for t in (prog.get("targets") or {}).get("in_scope") or []:
            h = norm_host(str(t.get("endpoint") or t.get("asset_identifier") or ""))
            if not h:
                continue
            assets.append(
                {
                    "value": h,
                    "kind": "domain",
                    "bounty": bool(t.get("eligible_for_bounty")),
                    "max_sev": str(t.get("max_severity") or ""),
                    "type": t.get("type") or "",
                }
            )
            if len(assets) >= MAX_ASSETS_PER_PROGRAM:
                break
        if not assets:
            continue
        out.append(
            {
                "id": f"it:{handle}",
                "name": prog.get("name") or str(handle),
                "platform": "intigriti",
                "homepage": prog.get("url") or "",
                "reward": "monetary" if prog.get("max_bounty", {}).get("value") else "recognition",
                "assets": assets,
            }
        )
    return out


def from_domains(dirpath: Path) -> list[dict]:
    p = dirpath / "domains.txt"
    if not p.exists():
        return []
    seen: dict[str, dict] = {}
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        h = norm_host(line)
        if not h:
            continue
        # Group by registrable-ish root so we do not create 38k rows.
        parts = h.split(".")
        root = ".".join(parts[-2:]) if len(parts) >= 2 else h
        if root not in seen:
            seen[root] = {
                "id": f"agg:{root}",
                "name": root,
                "platform": "aggregator",
                "homepage": f"https://{root}",
                "reward": "unknown",
                "assets": [],
            }
        if len(seen[root]["assets"]) < 5:
            seen[root]["assets"].append(
                {"value": h, "kind": "domain", "bounty": False, "max_sev": "", "type": "AGGREGATED"}
            )
    return list(seen.values())


def main() -> int:
    argv = sys.argv[1:]
    src = Path(argv[argv.index("--in") + 1]) if "--in" in argv else Path("eval/data/programs")
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else Path("src/program-seed.json")

    if not src.is_dir():
        print(f"not a directory: {src}", file=sys.stderr)
        return 1

    programs: list[dict] = []

    h1 = load(src, "hackerone_data.json")
    if isinstance(h1, list):
        got = from_hackerone(h1)
        print(f"hackerone      {len(got)} programs", file=sys.stderr)
        programs.extend(got)

    bc = load(src, "bugcrowd_data.json")
    if bc is not None:
        got = from_bugcrowd(bc)
        print(f"bugcrowd       {len(got)} programs", file=sys.stderr)
        programs.extend(got)

    it = load(src, "intigriti_data.json")
    if it is not None:
        got = from_intigriti(it)
        print(f"intigriti      {len(got)} programs", file=sys.stderr)
        programs.extend(got)

    # The aggregator list is the long tail: hosts with no platform page at all.
    agg = from_domains(src)
    if agg:
        print(f"aggregated     {len(agg)} roots from domains.txt", file=sys.stderr)
        programs.extend(agg)

    if not programs:
        print("nothing ingested; check the input directory", file=sys.stderr)
        return 1

    # Dedupe by id, then rank: bounty-paying and asset-rich first.
    by_id: dict[str, dict] = {}
    for p in programs:
        cur = by_id.get(p["id"])
        if cur is None or len(p["assets"]) > len(cur["assets"]):
            by_id[p["id"]] = p

    ranked = sorted(
        by_id.values(),
        key=lambda p: (-int(p["reward"] == "monetary"), -len(p["assets"])),
    )[:MAX_PROGRAMS]

    total_assets = sum(len(p["assets"]) for p in ranked)
    bounty_programs = sum(1 for p in ranked if p["reward"] == "monetary")

    payload = {
        "generated": "ingest-programs.py",
        "programs": len(ranked),
        "assets": total_assets,
        "bounty_programs": bounty_programs,
        "note": (
            "automation is intentionally unset for every program; platform scope "
            "permits humans, not tools. run discovery to resolve each policy."
        ),
        "items": ranked,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":")))

    kb = out.stat().st_size / 1024
    print(file=sys.stderr)
    print(f"programs   {len(ranked):,}", file=sys.stderr)
    print(f"assets     {total_assets:,}", file=sys.stderr)
    print(f"with bounty {bounty_programs:,}", file=sys.stderr)
    print(f"written    {out}  ({kb:.0f} KB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
