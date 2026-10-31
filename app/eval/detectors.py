#!/usr/bin/env python3
"""
Detector adapters — turn three tools with three output shapes into one shape.

WHY THIS FILE EXISTS, AND WHAT IT REFUSES TO DO
-----------------------------------------------
`harness.py` used to report `detection = 0 measured` and explain that per-project
checkouts were "a v2 capability". That was honest but useless: it made "we have
no recall data" look like a placeholder waiting for an engineer rather than a
measurement nobody had run.

So this file runs what is actually on the machine:

  tools/detect.py   always present (it ships in this repo; pure stdlib)
  slither           only if importable/executable; needs solc AND a build system
  aderyn            only if the binary is found

and it converts each one's verdict into a set of *class hits* — the corpus class
ids this repo already ranks (`sol.reentrancy`, `sol.rounding`, ...).

Three deliberate refusals:

  1. NO GUESSING. A detector's rule that has no unambiguous class gets NO mapping
     and therefore contributes no hit. `unused-return` is a real Slither check
     but there is no `sol.*` class for "ignored return value", so it maps to
     nothing rather than being bent onto the nearest plausible class. Mapping by
     keyword resemblance is how a class prior gets corrupted.

  2. NO SILENT ZERO. A tool that is missing, or that fails to compile the target,
     is recorded as UNAVAILABLE with the exact reason. It is never recorded as
     "found nothing". Those are different facts and conflating them is the bug
     this whole file exists to avoid: a scanner that never ran has 0% recall and
     100% precision-looking silence.

  3. NO INSTANCE CLAIM. A hit means "this detector fired on this class in this
     checkout". It does NOT mean the detector found the specific audited bug.
     `tools/detect.py` emits at most one lead per (class, file) and its own
     docstring says "leads, never findings", so instance-level attribution is not
     available and is not invented here. See harness.py's limitations.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
DETECT_PY = APP / "tools" / "detect.py"

# ─────────────────────────────────────────────────────── rule → class maps ─────

# Slither check name → corpus class id.
#
# Every entry is a rule whose own definition matches the class definition. Read
# the left column as "the detector's claim" and the right as "the corpus class
# that claim is about". Where that sentence is not obviously true, the entry is
# absent on purpose and the reason is written down.
SLITHER_TO_CLASS: dict[str, str] = {
    # Reentrancy: five Slither severities of one bug class. The class is the bug,
    # not the impact tier, so all five collapse onto sol.reentrancy.
    "reentrancy-eth": "sol.reentrancy",
    "reentrancy-no-eth": "sol.reentrancy",
    "reentrancy-benign": "sol.reentrancy",
    "reentrancy-events": "sol.reentrancy",
    "reentrancy-unlimited-gas": "sol.reentrancy",
    "reentrancy-balance": "sol.reentrancy",
    # Attacker-influenced delegatecall destination == what sol.delegatecall ranks.
    "controlled-delegatecall": "sol.delegatecall",
    "delegatecall-loop": "sol.delegatecall",
    # A proxy anyone can re-initialise is the upgradeability class.
    "unprotected-upgrade": "sol.upgrade",
    # Arithmetic ordering / truncation.
    "divide-before-multiply": "sol.rounding",
    # "Arbitrary from/recipient" is missing-or-wrong authorization.
    "arbitrary-send-erc20": "sol.accesscontrol",
    "arbitrary-send-erc20-permit": "sol.accesscontrol",
    "arbitrary-send-eth": "sol.accesscontrol",
    # Authorization decided by tx.origin.
    "tx-origin": "sol.accesscontrol",
    # EIP-2612 domain-separator collision is a signature-replay/doman-binding bug.
    "domain-separator-collision": "sol.signature",
}

# Aderyn detector name → corpus class id. Same discipline.
ADERYN_TO_CLASS: dict[str, str] = {
    "reentrancy-state-change": "sol.reentrancy",
    "delegate-call-unchecked-address": "sol.delegatecall",
    "unprotected-initializer": "sol.upgrade",
    "division-before-multiplication": "sol.rounding",
    "unsafe-casting": "sol.rounding",
    "arbitrary-transfer-from": "sol.accesscontrol",
    "tx-origin-used-for-auth": "sol.accesscontrol",
    "constant-function-changes-state": "sol.accesscontrol",
    "ecrecover": "sol.signature",
}

# Rules that exist and are intentionally NOT mapped, with the reason. Kept as
# data so an operator reading a low precision number can tell "we chose not to
# count this" from "we forgot".
UNMAPPED_WITH_REASON: dict[str, str] = {
    "unused-return": "no corpus class for an ignored return value",
    "incorrect-equality": "strict-equality advice; not a class in this taxonomy",
    "missing-zero-check": "input hygiene; no class, and mapping it to accesscontrol would inflate that prior",
    "uninitialized-local": "local variable hygiene; no class",
    "write-after-write": "dead-store advice; no class",
    "timestamp": "timestamp dependence is contextual; no class",
    "events-maths": "event emission; no class",
    "naming-convention": "style",
    "solc-version": "compiler pinning; style",
    "assembly": "informational",
    "low-level-calls": "informational; a low-level call is not itself a bug",
    "missing-inheritance": "structure",
    "costly-loop": "gas",
    "calls-loop": "gas; sol.dos is revert-griefing/unbounded work, not gas cost",
    "msg-value-loop": "gas",
    "unsafe-erc20-operation": "token integration hygiene; no class",
    "unchecked-return": "token integration hygiene; no class",
    "eth-send-unchecked-address": "zero-address check; no class",
    "selfdestruct": "no class",
    "weak-randomness": "no class",
    "centralization-risk": "trust assumption, not a bug class",
    "push-zero-opcode": "optimisation",
    "unspecific-solidity-pragma": "style",
    "literal-instead-of-constant": "style",
    "inconsistent-type-names": "style",
}

# tools/detect.py already labels every lead with a corpus class id in its
# `playbook` field, so it needs no translation table — only the guarantee that
# the label is one of the classes this repo ranks. Anything else is a bug in
# detect.py and must surface, not be silently dropped.
SOL_CLASSES = frozenset(
    {
        "sol.reentrancy",
        "sol.accesscontrol",
        "sol.oracle",
        "sol.rounding",
        "sol.inflation",
        "sol.upgrade",
        "sol.signature",
        "sol.delegatecall",
        "sol.flashloan",
        "sol.dos",
    }
)


# ──────────────────────────────────────────────────────────────── results ─────


@dataclass
class ToolRun:
    """One detector's outcome on one checkout. `error` means IT DID NOT RUN."""

    tool: str
    version: str = ""
    # Raw rule → instance count, exactly as the tool reported it. Kept whole so
    # the class mapping can be re-derived without re-running the tool.
    checks: dict[str, int] = field(default_factory=dict)
    # Class ids this tool fired on. Derived from `checks` via the map above.
    hits: set[str] = field(default_factory=set)
    # Class ids the tool fired on that have no mapping — must stay empty.
    unmapped_hits: set[str] = field(default_factory=set)
    available: bool = True
    error: str = ""
    duration_s: float = 0.0

    def to_json(self) -> dict:
        return {
            "tool": self.tool,
            "version": self.version,
            "available": self.available,
            "error": self.error,
            "duration_s": round(self.duration_s, 2),
            "checks": dict(sorted(self.checks.items())),
            "hits": sorted(self.hits),
            "unmapped_hits": sorted(self.unmapped_hits),
        }

    @classmethod
    def from_json(cls, d: dict) -> "ToolRun":
        return cls(
            tool=str(d.get("tool") or ""),
            version=str(d.get("version") or ""),
            checks={str(k): int(v) for k, v in (d.get("checks") or {}).items()},
            hits=set(d.get("hits") or []),
            unmapped_hits=set(d.get("unmapped_hits") or []),
            available=bool(d.get("available", True)),
            error=str(d.get("error") or ""),
            duration_s=float(d.get("duration_s") or 0.0),
        )


# Directories a tool may live in even when the caller's PATH is minimal. Slither
# shells out to the project's build system (`forge`, `hardhat`, `solc`), so a
# slither that is on PATH but cannot see `forge` fails with "Cannot execute
# `forge`" — a real harness bug that looks exactly like a detector finding
# nothing. Inheriting a rebuilt PATH is the difference between the two.
TOOL_DIRS = (
    Path.home() / ".foundry" / "bin",
    Path("/tmp/slithervenv/bin"),
    Path("/tmp/aderyn-x86_64-unknown-linux-gnu"),
    Path("/usr/local/bin"),
)


def _env() -> dict[str, str]:
    env = dict(os.environ)
    parts = [str(d) for d in TOOL_DIRS if d.is_dir()]
    existing = env.get("PATH", "")
    if existing:
        parts.append(existing)
    env["PATH"] = os.pathsep.join(parts)
    return env


def _clean(msg: str) -> str:
    """Strip ANSI colour so an error string is readable in a report or a test."""
    import re as _re

    return _re.sub(r"\x1b\[[0-9;]*m", "", msg).strip()


def _first_error(text: str) -> str:
    """
    Pick the informative line out of a tool's noisy failure output.

    `tail[-1]` is usually the worst choice: solc/aderyn print the error and then
    a caret snippet whose LAST line is `^^^` under a column marker. Recording
    that as "the reason" produces an audit trail that says
    `aderyn did not run: |    ^^^^^^^^^` — true, useless, and impossible to act
    on. So prefer an explicit error line, then any line naming a file:line, and
    only then the last line.
    """
    lines = [_clean(l) for l in (text or "").splitlines()]
    lines = [l for l in lines if l]
    for l in lines:
        low = l.lower()
        if "error" in low and len(l) > 20:
            return l[:300]
    for l in lines:
        if ".sol:" in l:
            return l[:300]
    return lines[-1][:300] if lines else ""


def _run(cmd: list[str], cwd: Path, timeout: int) -> tuple[int, str, str]:
    try:
        p = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_env(),
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except FileNotFoundError:
        return 127, "", f"not found: {cmd[0]}"
    except OSError as exc:  # pragma: no cover - environment specific
        return 126, "", f"{type(exc).__name__}: {exc}"


# ───────────────────────────────────────────────────────────── tools ─────


def run_detect_py(root: Path, timeout: int = 300) -> ToolRun:
    """This repo's own scanner. Always available; pure stdlib."""
    if not DETECT_PY.is_file():
        return ToolRun("detect.py", available=False, error=f"missing {DETECT_PY}")
    out = root / ".eval-detect.json"
    rc, stdout, stderr = _run(
        [sys.executable, str(DETECT_PY), str(root), "--out", str(out)], cwd=root, timeout=timeout
    )
    run = ToolRun("detect.py", version="repo tools/detect.py")
    if rc != 0:
        run.available = False
        tail = (stderr or stdout).strip().splitlines()
        run.error = _first_error(stderr or stdout) or f"exit {rc}"
        return run
    try:
        payload = json.loads(out.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        run.available = False
        run.error = f"unreadable output: {type(exc).__name__}"
        return run
    finally:
        out.unlink(missing_ok=True)

    counts: dict[str, int] = {}
    for item in payload.get("items") or []:
        pb = str(item.get("playbook") or "")
        if pb not in SOL_CLASSES:
            run.unmapped_hits.add(pb or "<empty>")
            continue
        counts[pb] = counts.get(pb, 0) + 1
    run.checks = counts
    run.hits = set(counts)
    return run


def _binary(name: str) -> str | None:
    """Locate a tool, checking the venv the harness may have been installed into."""
    found = shutil.which(name)
    if found:
        return found
    for cand in (Path.home() / ".foundry" / "bin" / name, Path("/tmp/slithervenv/bin") / name):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return None


def find_slither() -> str | None:
    return _binary("slither")


def find_aderyn() -> str | None:
    for cand in (
        Path("/tmp/aderyn"),
        Path("/tmp/aderyn-x86_64-unknown-linux-gnu/aderyn"),
        Path(APP / "eval" / "bin" / "aderyn"),
    ):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return _binary("aderyn")


def run_slither(root: Path, timeout: int = 900) -> ToolRun:
    """
    Slither needs solc AND the project's own build system (forge/hardhat).

    A missing compiler is the common failure on a fresh runner, so the version is
    probed first and reported. `--filter-paths` is used to keep findings in the
    project's own code rather than its vendored `lib/`.
    """
    exe = find_slither()
    if not exe:
        return ToolRun("slither", available=False, error="slither not installed")
    rc, ver, _ = _run([exe, "--version"], cwd=root, timeout=60)
    run = ToolRun("slither", version=ver.strip().splitlines()[0] if ver.strip() else "unknown")
    if rc != 0:
        run.available = False
        run.error = "slither --version failed"
        return run

    out = root / ".eval-slither.json"
    rc, stdout, stderr = _run(
        [exe, ".", "--json", str(out), "--filter-paths", "test|script|lib|node_modules"],
        cwd=root,
        timeout=timeout,
    )
    blob: dict = {}
    if out.is_file():
        try:
            blob = json.loads(out.read_text())
        except json.JSONDecodeError:
            blob = {}
        finally:
            out.unlink(missing_ok=True)

    detectors = ((blob.get("results") or {}).get("detectors")) or []
    if not blob.get("success") or not detectors and rc != 0:
        # Distinguish "ran and found nothing" from "did not run". Slither writes
        # success:true with an empty detector list when it compiled and found
        # nothing, so an empty list alone is NOT a failure.
        if not blob.get("success"):
            run.available = False
            tail = (stderr or stdout).strip().splitlines()
            run.error = _first_error(stderr or stdout) or f"exit {rc}"
            return run

    counts: dict[str, int] = {}
    unmapped: set[str] = set()
    for d in detectors:
        check = str(d.get("check") or "")
        n = len(d.get("elements") or []) or 1
        counts[check] = counts.get(check, 0) + n
        cls = SLITHER_TO_CLASS.get(check)
        if cls:
            run.hits.add(cls)
        elif check and check not in UNMAPPED_WITH_REASON:
            unmapped.add(check)
    run.checks = counts
    run.unmapped_hits |= unmapped
    return run


def run_aderyn(root: Path, timeout: int = 600) -> ToolRun:
    """
    Aderyn reports two buckets: `high_issues` and `low_issues`, each a list of
    {detector_name, instances}. High-severity rules are what a class prior should
    hear about; the low bucket is style/gas and is recorded but not scored.
    """
    exe = find_aderyn()
    if not exe:
        return ToolRun("aderyn", available=False, error="aderyn not installed")
    rc, ver, _ = _run([exe, "--version"], cwd=root, timeout=60)
    run = ToolRun("aderyn", version=ver.strip().splitlines()[0] if ver.strip() else "unknown")
    out = root / ".eval-aderyn.json"
    rc, stdout, stderr = _run([exe, ".", "--output", str(out)], cwd=root, timeout=timeout)
    if not out.is_file():
        run.available = False
        tail = (stderr or stdout).strip().splitlines()
        # Aderyn exits non-zero on a compile error and prints the solc error;
        # that is an unavailable run, never a clean one.
        run.error = _first_error(stderr or stdout) or f"exit {rc}"
        return run
    try:
        blob = json.loads(out.read_text())
    except json.JSONDecodeError:
        run.available = False
        run.error = "unreadable aderyn report"
        return run
    finally:
        out.unlink(missing_ok=True)

    counts: dict[str, int] = {}
    unmapped: set[str] = set()
    for bucket in ("high_issues", "low_issues"):
        for issue in (blob.get(bucket) or {}).get("issues") or []:
            name = str(issue.get("detector_name") or "")
            n = len(issue.get("instances") or []) or 1
            counts[name] = counts.get(name, 0) + n
            if bucket != "high_issues":
                continue
            cls = ADERYN_TO_CLASS.get(name)
            if cls:
                run.hits.add(cls)
            elif name and name not in UNMAPPED_WITH_REASON:
                unmapped.add(name)
    run.checks = counts
    run.unmapped_hits |= unmapped
    return run


def availability() -> dict[str, dict]:
    """What is actually installed, so a report can name what it could not run."""
    out: dict[str, dict] = {
        "detect.py": {"available": DETECT_PY.is_file(), "path": str(DETECT_PY)},
    }
    for name, finder in (("slither", find_slither), ("aderyn", find_aderyn)):
        exe = finder()
        out[name] = {"available": bool(exe), "path": exe or ""}
        if exe:
            rc, ver, _ = _run([exe, "--version"], cwd=APP, timeout=60)
            out[name]["version"] = (ver.strip().splitlines() or [""])[0] if rc == 0 else ""
    return out


def run_all(root: Path, *, slither: bool = True, aderyn: bool = True) -> list[ToolRun]:
    runs = [run_detect_py(root)]
    if slither:
        runs.append(run_slither(root))
    if aderyn:
        runs.append(run_aderyn(root))
    return runs


if __name__ == "__main__":  # tiny probe: python3 eval/detectors.py <dir>
    target = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    print(json.dumps(availability(), indent=2))
    for r in run_all(target):
        print(json.dumps(r.to_json(), indent=2))
