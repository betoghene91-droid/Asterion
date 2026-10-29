#!/usr/bin/env python3
"""
Normalise third-party analyzer output into Asterion leads.

Why this exists rather than "just run Slither":

  * Slither (AGPL-3.0), Aderyn (GPL-3.0), Solhint (MIT) and our own detector all
    describe findings differently. A single normal form is what lets the
    proof stage treat them identically.
  * Running a copyleft analyzer as an external process over a JSON file is
    aggregation, not derivation. That matters if you ever redistribute this.
    Bash out to the binary, read its JSON, never link its code.
  * Their output is a LEAD, exactly like ours. Nothing here becomes a finding.

Every adapter fails soft and reports what it could not parse, so a broken tool
never silently looks like a clean codebase.

Usage:
  python3 scripts/normalize.py --slither s.json --aderyn a.json --solhint h.json \
                               --detect d.json --out leads.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Map a third-party detector id to one of our playbooks.
# Only mappings we are confident about; anything else becomes 'unmapped' and is
# kept in the output so a human can see what the tool said.
SLITHER_MAP = {
    "reentrancy-eth": "sol.reentrancy",
    "reentrancy-no-eth": "sol.reentrancy",
    "reentrancy-benign": "sol.reentrancy",
    "reentrancy-events": "sol.reentrancy",
    "reentrancy-unlimited-gas": "sol.reentrancy",
    "uninitialized-state": "sol.upgrade",
    "uninitialized-storage": "sol.upgrade",
    "delegatecall-loop": "sol.delegatecall",
    "controlled-delegatecall": "sol.delegatecall",
    "arbitrary-send-eth": "sol.delegatecall",
    "arbitrary-send-erc20": "sol.delegatecall",
    "missing-zero-check": "sol.accesscontrol",
    "tx-origin": "sol.accesscontrol",
    "unprotected-upgrade": "sol.upgrade",
    "suicidal": "sol.accesscontrol",
    "divide-before-multiply": "sol.rounding",
    "incorrect-equality": "sol.rounding",
    "unchecked-transfer": "sol.rounding",
    "oracle-price-manipulation": "sol.oracle",
    "chainlink-price-feed": "sol.oracle",
    "calls-loop": "sol.dos",
    "costly-loop": "sol.dos",
    "locked-ether": "sol.dos",
    "ecrecover": "sol.signature",
    "signature-malleability": "sol.signature",
}

ADERYN_MAP = {
    "reentrancy-state-change": "sol.reentrancy",
    "reentrancy-balance": "sol.reentrancy",
    "state-variable-changed-after-external-call": "sol.reentrancy",
    "delegate-call-in-loop": "sol.delegatecall",
    "unprotected-initializer": "sol.upgrade",
    "uninitialized-state-variable": "sol.upgrade",
    "missing-access-control": "sol.accesscontrol",
    "centralization-risk": "sol.accesscontrol",
    "divide-before-multiply": "sol.rounding",
    "unsafe-erc20-operation": "sol.rounding",
    "weak-randomness": "sol.oracle",
    "spot-price-used-as-oracle": "sol.oracle",
    "costly-operations-in-loop": "sol.dos",
    "ecrecover-not-checked": "sol.signature",
}


# nuclei template id -> our playbook. Only templates whose class we are
# confident about; the rest stay 'unmapped' and are shown to a human.
NUCLEI_MAP = {
    "cors-misconfig": "web.cors",
    "cors-wildcard": "web.cors",
    "reflected-xss": "web.xss.reflected",
    "xss-fuzz": "web.xss.reflected",
    "sqli-error-based": "web.sqli",
    "sqli-blind": "web.sqli",
    "idor": "web.idor",
    "jwt-none-alg": "web.jwt",
    "jwt-weak-key": "web.jwt",
    "ssrf": "web.ssrf",
    "ssrf-blind": "web.ssrf",
    "open-redirect": "web.ssrf",
    "lfi": "web.traversal",
    "path-traversal": "web.traversal",
    "graphql-introspection": "web.graphql",
    "oauth-misconfig": "web.oauth",
    "takeover-detect": "web.takeover",
    "subdomain-takeover": "web.takeover",
    "race-condition": "web.race",
    "unrestricted-file-upload": "web.upload",
    "mass-assignment": "web.massassign",
    "default-login": "web.authz.function",
    "broken-access-control": "web.authz.function",
}


def load(path: str | None) -> Any:
    if not path:
        return None
    try:
        return json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  unreadable {path}: {exc}", file=sys.stderr)
        return None


def from_slither(data: Any) -> list[dict]:
    out = []
    dets = (data or {}).get("results", {}).get("detectors", []) or []
    for d in dets:
        check = str(d.get("check") or "")
        playbook = SLITHER_MAP.get(check, "unmapped")
        elems = d.get("elements") or []
        loc = elems[0].get("source_mapping", {}) if elems else {}
        out.append(
            {
                "source": "slither",
                "playbook": playbook,
                "check": check,
                "severity": str(d.get("impact") or "").lower(),
                "confidence": str(d.get("confidence") or "").lower(),
                "file": loc.get("filename_relative") or loc.get("filename_short") or "",
                "line": (loc.get("lines") or [0])[0],
                "snippet": str(d.get("description") or "")[:200],
            }
        )
    return out


def from_aderyn(data: Any) -> list[dict]:
    out = []
    if not isinstance(data, dict):
        return out
    # Aderyn groups by severity bucket.
    for bucket in ("high_issues", "low_issues", "detectors"):
        group = data.get(bucket)
        if not group:
            continue
        items = group.get("issues", group) if isinstance(group, dict) else group
        if not isinstance(items, list):
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            det = str(it.get("detector_name") or it.get("title") or it.get("check") or "")
            key = det.lower().replace(" ", "-")
            playbook = ADERYN_MAP.get(key, ADERYN_MAP.get(det, "unmapped"))
            insts = it.get("instances") or []
            first = insts[0] if insts else {}
            out.append(
                {
                    "source": "aderyn",
                    "playbook": playbook,
                    "check": det,
                    "severity": "high" if bucket == "high_issues" else "low",
                    "confidence": "medium",
                    "file": str(first.get("contract_path") or ""),
                    "line": int(first.get("line_no") or 0),
                    "snippet": str(it.get("description") or det)[:200],
                }
            )
    return out


def from_solhint(data: Any) -> list[dict]:
    out = []
    if not isinstance(data, list):
        return out
    for it in data:
        if not isinstance(it, dict):
            continue
        sev = str(it.get("severity") or "").lower()
        # Solhint is a linter: only errors are worth a lead at all.
        if sev != "error":
            continue
        out.append(
            {
                "source": "solhint",
                "playbook": "unmapped",
                "check": str(it.get("ruleId") or ""),
                "severity": "low",
                "confidence": "low",
                "file": str((it.get("filePath") or "").split("/")[-1]),
                "line": int(it.get("line") or 0),
                "snippet": str(it.get("message") or "")[:200],
            }
        )
    return out



def from_nuclei(data: Any) -> list[dict]:
    """nuclei JSONL/JSON output -> leads.

    nuclei is the one adapter that already knows real severity, CWE and CVSS
    (info.classification) and that can carry the actual HTTP exchange
    (request/response are only populated when nuclei ran with -include-rr).
    We keep both: classification feeds triage, and the request/response pair is
    the only first-hand evidence this pipeline ever gets for a web2 lead.

    Accepts a list, a single object, or JSONL-as-text already parsed per line.
    """
    if isinstance(data, str):
        rows = []
        for line in data.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    elif isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = [data]
    else:
        return []

    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        info = r.get("info") or {}
        tid = str(r.get("template-id") or r.get("templateID") or "")
        playbook = NUCLEI_MAP.get(tid, "unmapped")
        cls = info.get("classification") or {}

        cwe = cls.get("cwe-id") or []
        if isinstance(cwe, str):
            cwe = [cwe]
        cve = cls.get("cve-id") or []
        if isinstance(cve, str):
            cve = [cve]

        # -include-rr gives the raw exchange; without it these are absent and
        # the lead is a claim with no first-hand evidence.
        req = r.get("request") or ""
        resp = r.get("response") or ""

        out.append(
            {
                "source": "nuclei",
                "playbook": playbook,
                "check": tid,
                "severity": str(info.get("severity") or "unknown").lower(),
                "confidence": "high" if (req and resp) else "medium",
                "file": str(r.get("matched-at") or r.get("host") or ""),
                "line": 0,
                "snippet": str(info.get("name") or "")[:200],
                # classification, kept verbatim so triage does not re-guess it
                "cvss_score": cls.get("cvss-score"),
                "cvss_metrics": cls.get("cvss-metrics"),
                "cwe_ids": [str(c) for c in cwe],
                "cve_ids": [str(c) for c in cve],
                "epss_score": cls.get("epss-score"),
                "cpe": cls.get("cpe"),
                # first-hand evidence, truncated hard
                "has_evidence": bool(req and resp),
                "request": str(req)[:4000],
                "response": str(resp)[:4000],
                "matcher_name": str(r.get("matcher-name") or ""),
                "extracted": r.get("extracted-results") or [],
                "template_url": str(info.get("reference") or ""),
            }
        )
    return out


def from_detect(data: Any) -> list[dict]:
    out = []
    for it in (data or {}).get("items", []) or []:
        out.append(
            {
                "source": "asterion-detect",
                "playbook": str(it.get("playbook") or "unmapped"),
                "check": str(it.get("playbook") or ""),
                "severity": str(it.get("severity") or "medium"),
                "confidence": "medium",
                "file": str(it.get("file") or ""),
                "line": int(it.get("line") or 0),
                "snippet": str(it.get("snippet") or "")[:200],
            }
        )
    return out


def dedupe(leads: list[dict]) -> list[dict]:
    """Collapse to one lead per (playbook, file).

    Deliberate: the proof stage generates one harness per class per file, so
    twenty Slither hits in one contract would produce twenty identical tests.
    The first is kept and the count is recorded, so we do not lose the signal
    that the file is hot.
    """
    by_key: dict[tuple[str, str], dict] = {}
    for lead in leads:
        key = (lead["playbook"], lead["file"])
        cur = by_key.get(key)
        if cur is None:
            lead["corroborated_by"] = [lead["source"]]
            by_key[key] = lead
        else:
            if lead["source"] not in cur["corroborated_by"]:
                cur["corroborated_by"].append(lead["source"])
            cur["hits"] = cur.get("hits", 1) + 1
    return sorted(by_key.values(), key=lambda x: (x["playbook"], x["file"], x["line"]))


def main() -> int:
    argv = sys.argv[1:]

    def opt(name: str) -> str | None:
        return argv[argv.index(name) + 1] if name in argv else None

    sources = {
        "slither": from_slither,
        "aderyn": from_aderyn,
        "solhint": from_solhint,
        "detect": from_detect,
        "nuclei": from_nuclei,
    }

    all_leads: list[dict] = []
    seen_tools: list[str] = []
    for name, fn in sources.items():
        data = load(opt(f"--{name}"))
        if data is None:
            continue
        got = fn(data)
        seen_tools.append(f"{name}:{len(got)}")
        all_leads.extend(got)

    merged = dedupe(all_leads)
    mapped = [l for l in merged if l["playbook"] != "unmapped"]
    unmapped = [l for l in merged if l["playbook"] == "unmapped"]

    payload = {
        "tools": seen_tools,
        "leads": len(merged),
        "mapped": len(mapped),
        "unmapped": len(unmapped),
        "note": "all entries are leads; none is a finding until a proof test reproduces it",
        "items": merged,
    }

    out = opt("--out")
    if out:
        Path(out).write_text(json.dumps(payload, indent=2))

    print(f"tools {', '.join(seen_tools) if seen_tools else 'none'}")
    print(f"leads {len(merged)} ({len(mapped)} mapped to a playbook, {len(unmapped)} unmapped)")

    # Corroboration is the signal worth surfacing: two independent tools
    # agreeing on the same class in the same file is far more likely real.
    strong = [l for l in merged if len(l.get("corroborated_by", [])) > 1]
    if strong:
        print(f"corroborated by 2+ tools: {len(strong)}")
        for s in strong[:10]:
            print(f"  {s['playbook']:20} {s['file']}  <- {', '.join(s['corroborated_by'])}")

    if unmapped:
        print("unmapped (needs a mapping entry):")
        for u in unmapped[:8]:
            print(f"  {u['source']:16} {u['check']}")

    return 0


def _selftest() -> int:
    """Exercise every adapter on synthetic input shaped like the real tools.

    No external binary needed, so CI can prove the adapters work even when
    Slither/Aderyn are not installed.
    """
    slither = {
        "results": {
            "detectors": [
                {
                    "check": "reentrancy-eth",
                    "impact": "High",
                    "confidence": "Medium",
                    "description": "Reentrancy in Vault.withdraw()",
                    "elements": [{"source_mapping": {"filename_relative": "src/Vault.sol", "lines": [31]}}],
                },
                {
                    "check": "something-unmapped",
                    "impact": "Low",
                    "confidence": "High",
                    "description": "x",
                    "elements": [{"source_mapping": {"filename_relative": "src/Other.sol", "lines": [5]}}],
                },
            ]
        }
    }
    aderyn = {
        "high_issues": {
            "issues": [
                {
                    "detector_name": "unprotected-initializer",
                    "description": "initialize is public",
                    "instances": [{"contract_path": "src/Vault.sol", "line_no": 13}],
                }
            ]
        }
    }
    detect = {
        "items": [
            {"playbook": "sol.reentrancy", "severity": "high", "file": "src/Vault.sol", "line": 31, "snippet": "call{value:}"}
        ]
    }

    leads = from_slither(slither) + from_aderyn(aderyn) + from_detect(detect)
    merged = dedupe(leads)

    m = {(l["playbook"], l["file"]): l for l in merged}
    ok = True

    def check(cond: bool, label: str) -> None:
        nonlocal ok
        print(("  ok   " if cond else "  FAIL ") + label)
        ok = ok and cond

    check(len(merged) == 3, f"three distinct leads (got {len(merged)})")
    check(("sol.reentrancy", "src/Vault.sol") in m, "slither reentrancy mapped")
    check(("sol.upgrade", "src/Vault.sol") in m, "aderyn initializer mapped")
    check(("unmapped", "src/Other.sol") in m, "unknown detector preserved, not dropped")
    key = ("sol.reentrancy", "src/Vault.sol")
    check(len(m[key]["corroborated_by"]) == 2, "slither+detect corroboration recorded")
    check(m[key].get("hits", 1) == 2, "hit count incremented")

    # ── nuclei ────────────────────────────────────────────────────────────────
    # The classification block and the HTTP exchange are the two things nuclei
    # knows that no other adapter does. Losing either silently would make the
    # web2 path evidence-free, so both are asserted here.
    nuclei_rows = [
        {
            "template-id": "cors-misconfig",
            "info": {
                "name": "CORS Misconfiguration",
                "severity": "high",
                "classification": {
                    "cwe-id": ["cwe-942"],
                    "cvss-score": 6.1,
                    "cvss-metrics": "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N",
                    "epss-score": 0.0021,
                },
            },
            "matched-at": "https://app.example.com/api/user",
            "matcher-name": "arbitrary-origin",
            "request": "GET /api/user HTTP/1.1\r\nOrigin: https://evil.com",
            "response": "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: https://evil.com",
        },
        {"template-id": "totally-unknown", "info": {"name": "x", "severity": "info"}, "host": "h"},
        # already-parsed JSONL split into lines
        {"template-id": "idor", "info": {"severity": "medium"}, "matched-at": "https://a/b"},
    ]
    nuc = from_nuclei(nuclei_rows)
    check(len(nuc) == 3, f"nuclei: all rows kept (got {len(nuc)})")
    check(nuc[0]["playbook"] == "web.cors", "nuclei: cors template mapped to a web2 playbook")
    check(nuc[1]["playbook"] == "unmapped", "nuclei: unknown template preserved, not dropped")
    check(nuc[2]["playbook"] == "web.idor", "nuclei: idor template mapped")
    check(nuc[0]["cwe_ids"] == ["cwe-942"], "nuclei: cwe-id preserved")
    check(nuc[0]["cvss_score"] == 6.1, "nuclei: cvss score preserved")
    check(nuc[0]["epss_score"] == 0.0021, "nuclei: epss preserved")
    check(nuc[0]["has_evidence"] is True, "nuclei: -include-rr exchange detected as evidence")
    check("evil.com" in nuc[0]["request"], "nuclei: request body kept")
    check(nuc[0]["confidence"] == "high", "nuclei: evidence raises confidence")
    check(nuc[1]["has_evidence"] is False, "nuclei: no exchange => no evidence flag")
    check(nuc[1]["confidence"] == "medium", "nuclei: no exchange stays medium")

    # JSONL as a raw string must parse line-by-line, since that is how nuclei
    # writes files when it is not given -json-export.
    jsonl = '{"template-id":"ssrf","info":{"severity":"high"}}\n{"template-id":"jwt-none-alg","info":{"severity":"high"}}'
    parsed = from_nuclei(jsonl)
    check(len(parsed) == 2, f"nuclei: JSONL string parsed per line (got {len(parsed)})")
    check(parsed[0]["playbook"] == "web.ssrf", "nuclei: JSONL first row mapped")
    check(parsed[1]["playbook"] == "web.jwt", "nuclei: JSONL second row mapped")

    return 0 if ok else 1


if __name__ == "__main__" and "--selftest" in sys.argv:
    sys.exit(_selftest())


if __name__ == "__main__":
    sys.exit(main())
