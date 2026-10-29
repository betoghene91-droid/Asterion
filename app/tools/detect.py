#!/usr/bin/env python3
"""Deterministic solidity pattern scan.

The governing rule: this script produces LEADS, never findings. A lead becomes
a finding only when a forge test reproduces it. Every pattern here is chosen
because it is (a) mechanically checkable and (b) low false-positive on real
code. Anything requiring judgement is deliberately excluded.

Two filters do most of the precision work:
  * a lead is evaluated in the context of its enclosing function, not just
    the matching line
  * a well-guarded function emits nothing, even if the shape matches

Usage: python3 detect.py <repo-dir> [--out results.json]
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

SKIP_DIRS = {
    "test", "tests", "script", "scripts", "lib", "node_modules",
    ".git", "out", "cache", "docs",
}

FUNC_RE = re.compile(r"\s*(function\s+\w+|constructor\s*\(|receive\s*\(|fallback\s*\()")
STATE_WRITE_RE = re.compile(r"\w+\s*(\[[^\]]*\])?\s*(=|-=|\+=)\s")


@dataclass
class Lead:
    playbook: str
    severity: str
    file: str
    line: int
    snippet: str
    why: str


@dataclass(frozen=True)
class Pattern:
    playbook: str
    severity: str
    regex: re.Pattern[str]
    why: str
    mutex: tuple[str, ...] = ()
    needs_state_write_after: bool = False


PATTERNS: list[Pattern] = [
    Pattern(
        "sol.reentrancy", "high",
        re.compile(r"\.call\{value:[^}]*\}\("),
        "external value transfer before the following state update; verify checks-effects-interactions",
        mutex=("nonReentrant", "ReentrancyGuard"),
        needs_state_write_after=True,
    ),
    Pattern(
        "sol.delegatecall", "high",
        re.compile(r"delegatecall\s*\("),
        "delegatecall target must not be attacker-influenced; confirm immutable or access-controlled",
    ),
    Pattern(
        "sol.accesscontrol", "high",
        re.compile(
            r"function\s+\w+\s*\([^)]*\)\s*(external|public)"
            r"(?![^;{]*\b(onlyOwner|onlyRole|onlyAdmin|requiresAuth|auth|initializer|nonReentrant))[^;{]*\{"
        ),
        "state-changing external function without an authority check; confirm intent",
    ),
    Pattern(
        "sol.upgrade", "critical",
        re.compile(r"function\s+initialize\s*\([^)]*\)\s*(public|external)(?![^;{]*initializer)"),
        "unguarded initializer lets anyone take ownership of the implementation",
    ),
    Pattern(
        "sol.signature", "high",
        re.compile(r"ecrecover\s*\("),
        "ecrecover alone does not prevent replay; confirm nonce and chain-bound domain separator",
    ),
    Pattern(
        "sol.rounding", "medium",
        re.compile(r"(shares|assets|amount|balance)\w*\s*/\s*(total\w*|supply|price)"),
        "integer division truncates; confirm rounding favours the protocol",
    ),
    Pattern(
        "sol.oracle", "high",
        re.compile(r"(getReserves|balanceOf\s*\(\s*\w*[Pp]air)"),
        "spot reserves are manipulable within one transaction; confirm TWAP or external oracle",
    ),
    Pattern(
        "sol.dos", "medium",
        re.compile(r"for\s*\([^;]*;\s*\w+\s*<\s*\w+(\[\w+\]|\.length)"),
        "unbounded loop over user-growable state can exceed the block gas limit",
    ),
    Pattern(
        "sol.flashloan", "high",
        re.compile(r"token\.balanceOf\s*\(\s*address\s*\(this\)\s*\)"),
        "accounting off the contract's own balance is inflatable by donation or flashloan",
    ),
]


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def enclosing_function(lines: list[str], idx: int) -> str:
    """Source of the function body containing line idx, or '' if not found."""
    start = idx
    while start >= 0 and not FUNC_RE.match(lines[start]):
        start -= 1
    if start < 0:
        return ""

    depth = 0
    opened = False
    body: list[str] = []
    for j in range(start, len(lines)):
        line = lines[j]
        body.append(line)
        if "{" in line:
            opened = True
        depth += line.count("{") - line.count("}")
        if opened and depth <= 0:
            break
    return "\n".join(body)


def is_guarded(body: str, mutex: tuple[str, ...]) -> bool:
    if not mutex:
        return False
    head = body.split("{", 1)[0]
    return any(m in head for m in mutex)


def scan_file(path: Path, root: Path) -> list[Lead]:
    text = strip_comments(path.read_text(encoding="utf-8", errors="replace"))
    lines = text.splitlines()
    rel = str(path.relative_to(root))
    leads: list[Lead] = []

    for pat in PATTERNS:
        for i, line in enumerate(lines):
            if not pat.regex.search(line):
                continue
            if "function" in line and ("view" in line or "pure" in line):
                continue

            body = enclosing_function(lines, i)
            if not body:
                continue

            if is_guarded(body, pat.mutex):
                continue

            if pat.needs_state_write_after:
                after = "\n".join(lines[i: i + 12])
                if not STATE_WRITE_RE.search(after):
                    continue

            if pat.playbook == "sol.accesscontrol" and re.search(
                r"\b(constructor|interface|library)\b", body
            ):
                continue

            leads.append(
                Lead(
                    playbook=pat.playbook,
                    severity=pat.severity,
                    file=rel,
                    line=i + 1,
                    snippet=line.strip()[:160],
                    why=pat.why,
                )
            )
    return leads


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: detect.py <repo-dir> [--out file]", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else None

    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2

    leads: list[Lead] = []
    files = 0
    for p in root.rglob("*.sol"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        files += 1
        leads.extend(scan_file(p, root))

    # One lead per (playbook, file): a hot file should not flood the queue.
    seen: set[tuple[str, str]] = set()
    deduped: list[Lead] = []
    for lead in sorted(leads, key=lambda x: (x.playbook, x.file, x.line)):
        key = (lead.playbook, lead.file)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(lead)

    payload = {
        "files_scanned": files,
        "leads": len(deduped),
        "raw_matches": len(leads),
        "note": "leads only; a lead is not a finding until a forge test reproduces it",
        "items": [asdict(x) for x in deduped],
    }

    if out:
        out.write_text(json.dumps(payload, indent=2))

    print(f"scanned {files} .sol files -> {len(deduped)} leads ({len(leads)} raw matches)")
    counts: dict[str, int] = {}
    for lead in deduped:
        counts[lead.playbook] = counts.get(lead.playbook, 0) + 1
    for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k:20} {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
