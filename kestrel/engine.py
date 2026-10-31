#!/usr/bin/env python3
"""
KESTREL engine - rules-driven red / white / grey hat, API and smart contract.

Royan writes rules.json. This file only evaluates it. Adding a rule needs no
code change, which is the whole point: the bot should behave like a red hatter
who knows what to look for, not like a switch statement that must be rebuilt.

    python3 engine.py rules                       # validate the rule file
    python3 engine.py api  --url U [--token T]    # API audit
    python3 engine.py chain --rpc R --address A   # contract audit
    python3 engine.py hunt  --brief brief.json    # both, plus logs

stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
RULES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rules.json")


# --------------------------------------------------------------------------
# rule loading and validation
# --------------------------------------------------------------------------

class RuleError(ValueError):
    pass


def load_rules(path: str = RULES_PATH) -> list[dict]:
    with open(path) as fh:
        doc = json.load(fh)
    rules = doc.get("rules")
    if not isinstance(rules, list) or not rules:
        raise RuleError("rules.json has no rules[] array")

    seen: set[str] = set()
    for i, r in enumerate(rules):
        for key in ("id", "hat", "title", "severity", "kind", "when"):
            if key not in r:
                raise RuleError(f"rule[{i}] missing '{key}'")
        if r["id"] in seen:
            raise RuleError(f"duplicate rule id '{r['id']}'")
        seen.add(r["id"])
        if r["hat"] not in ("red", "white", "grey"):
            raise RuleError(f"{r['id']}: hat must be red|white|grey")
        if r["severity"] not in SEV_ORDER:
            raise RuleError(f"{r['id']}: bad severity '{r['severity']}'")
        if r["kind"] not in ("api", "evm", "log", "any"):
            raise RuleError(f"{r['id']}: bad kind '{r['kind']}'")
    return rules


# --------------------------------------------------------------------------
# rule evaluation
# --------------------------------------------------------------------------

_OPS = {"eq", "neq", "in", "nin", "contains", "icontains", "regex", "exists",
        "missing", "gt", "gte", "lt", "lte"}


def _get(ctx: dict, path: str):
    """Resolve 'obs.path' / 'obs.a.b' against {obs: {...}}."""
    node = ctx
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return None
    return node


def matches(clause: dict, ctx: dict) -> bool:
    """Evaluate one clause tree.

    Two accepted shapes, because both read naturally in a hand-edited file:

        {"eq": {"path": "obs.status", "value": 200}}     # explicit
        {"eq": "obs.status", "value": 200}               # flat shorthand

    Plus combinators: {"any_of": [...]} and {"all_of": [...]}.
    """
    if "any_of" in clause:
        return any(matches(c, ctx) for c in clause["any_of"])
    if "all_of" in clause:
        return all(matches(c, ctx) for c in clause["all_of"])

    flat_value = clause.get("value")

    for op, spec in clause.items():
        if op in ("value", "any_of", "all_of"):
            continue
        if op not in _OPS:
            raise RuleError(f"unknown operator '{op}'")

        # normalise the two shapes into (path, want)
        if isinstance(spec, dict) and "path" in spec:
            path = spec["path"]
            want = spec.get("value")
        elif isinstance(spec, str):
            path = spec
            want = flat_value
        else:
            raise RuleError(f"operator '{op}' needs a path string or {{path, value}}")

        got = _get(ctx, path)

        if op == "exists":
            if not got:
                return False
            continue
        if op == "missing":
            if got:
                return False
            continue
        if got is None:
            return False
        if op == "eq":
            if not (got == want):
                return False
        elif op == "neq":
            if got == want:
                return False
        elif op == "in":
            if got not in (want or []):
                return False
        elif op == "nin":
            if got in (want or []):
                return False
        elif op == "contains":
            if str(want) not in str(got):
                return False
        elif op == "icontains":
            if str(want).lower() not in str(got).lower():
                return False
        elif op == "regex":
            try:
                if not re.search(str(want), str(got)):
                    return False
            except re.error as e:
                raise RuleError(f"bad regex '{want}': {e}")
        elif op in ("gt", "gte", "lt", "lte"):
            try:
                a, b = float(got), float(want)
            except (TypeError, ValueError):
                return False
            if op == "gt" and not a > b:
                return False
            if op == "gte" and not a >= b:
                return False
            if op == "lt" and not a < b:
                return False
            if op == "lte" and not a <= b:
                return False
    return True


@dataclass
class Finding:
    hat: str
    code: str
    severity: str
    title: str
    evidence: dict = field(default_factory=dict)
    remediation: str = ""

    def as_dict(self) -> dict:
        return {"hat": self.hat, "code": self.code, "severity": self.severity,
                "title": self.title, "evidence": self.evidence,
                "remediation": self.remediation}


def apply_rules(rules: list[dict], obs: dict, kinds: tuple[str, ...]) -> list[Finding]:
    """Run every rule whose kind is in `kinds` against one observation set."""
    out: list[Finding] = []
    ctx = {"obs": obs}
    for r in rules:
        if r["kind"] not in kinds and r["kind"] != "any":
            continue
        try:
            if not matches(r["when"], ctx):
                continue
        except RuleError:
            raise
        ev = {k: obs.get(k) for k in r.get("evidence", []) if k in obs}
        out.append(Finding(r["hat"], r["id"], r["severity"], r["title"],
                           ev, r.get("remediation", "")))
    return out


def sort_findings(fs: list[Finding]) -> list[Finding]:
    return sorted(fs, key=lambda f: (SEV_ORDER.get(f.severity, 9), f.code))


# Rules that describe a host-wide property must not repeat once per path.
HOST_LEVEL = {"API-CORS-02", "API-SERVER-01"}


def collapse(fs: list[Finding], host: str = "") -> list[Finding]:
    """One row per (rule, host) for host-wide rules; keep the first occurrence.

    Without this, a wildcard-CORS rule fires on every probed path and the report
    reads like 25 findings when there is one fact.
    """
    out: list[Finding] = []
    seen: set[tuple] = set()
    for f in fs:
        if f.code in HOST_LEVEL:
            key = (f.code, host)
            if key in seen:
                continue
            seen.add(key)
        out.append(f)
    return out


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _http(method: str, url: str, headers: dict | None = None,
          body: bytes | None = None, timeout: float = 20.0) -> dict:
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or {})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read()
            return {"status": r.status, "headers": dict(r.headers),
                    "body": raw.decode("utf-8", "replace"), "url": url,
                    "error": None}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "headers": dict(e.headers or {}),
                "body": (e.read() or b"").decode("utf-8", "replace"),
                "url": url, "error": None}
    except Exception as e:
        return {"status": 0, "headers": {}, "body": "", "url": url,
                "error": str(e)[:160]}


def _hdr(h: dict, name: str) -> str:
    for k, v in h.items():
        if k.lower() == name.lower():
            return v
    return ""


# --------------------------------------------------------------------------
# API audit
# --------------------------------------------------------------------------

PROBE_PATHS = [
    "/", "/api", "/api/v1", "/health", "/version", "/status",
    "/api/openapi.json", "/openapi.json", "/swagger.json", "/api-docs",
    "/docs", "/api/docs", "/robots.txt", "/sitemap.xml",
    "/.well-known/security.txt", "/api/v1/users", "/api/v1/user",
    "/api/v1/accounts", "/api/v1/me", "/api/admin", "/admin",
    "/internal", "/debug", "/api/v1/config", "/api/config",
]


def audit_api(base: str, token: str | None, rules: list[dict],
              paths: list[str] | None = None) -> dict:
    base = base.rstrip("/")
    if not base.startswith("http"):
        base = "https://" + base
    host = urllib.parse.urlparse(base).hostname or base

    auth_headers = {"accept": "application/json,text/html;q=0.9,*/*;q=0.8",
                    "user-agent": "kestrel-audit/1.0"}
    if token:
        auth_headers["authorization"] = f"Bearer {token}"

    findings: list[Finding] = []
    results = []

    for p in (paths or PROBE_PATHS):
        url = base + p
        unauth = _http("GET", url, {"accept": auth_headers["accept"],
                                    "user-agent": auth_headers["user-agent"]})
        authed = _http("GET", url, auth_headers) if token else unauth

        acao = _hdr(unauth["headers"], "access-control-allow-origin")
        acac = _hdr(unauth["headers"], "access-control-allow-credentials")
        origin_sent = ""
        acao_is_echo = False
        if not acao:
            # probe with a controlled foreign origin
            origin_sent = "https://kestrel-probe.example"
            cors = _http("GET", url, {"origin": origin_sent, **auth_headers})
            acao = _hdr(cors["headers"], "access-control-allow-origin")
            acac = _hdr(cors["headers"], "access-control-allow-credentials") or acac
            acao_is_echo = acao == origin_sent

        obs = {
            "host": host,
            "path": p,
            "url": url,
            "unauth_status": unauth["status"],
            "authed_status": authed["status"],
            "unauth_len": len(unauth["body"]),
            "authed_len": len(authed["body"]),
            "content_type": _hdr(unauth["headers"], "content-type"),
            "server": _hdr(unauth["headers"], "server"),
            "powered_by": _hdr(unauth["headers"], "x-powered-by"),
            "acao": acao,
            "acac": acac,
            "acao_is_echo": acao_is_echo,
            "origin_sent": origin_sent,
            "body": unauth["body"][:4000],
        }
        # secret-shaped strings, value redacted in evidence
        m = re.search(r"(?i)(api[_-]?key|secret|token|passwd|password)\s*[\":=]\s*[\"']"
                      r"([A-Za-z0-9_\-]{16,})", obs["body"])
        obs["body_match_redacted"] = f"{m.group(1)}=<{len(m.group(2))} chars>" if m else ""

        fs = apply_rules(rules, obs, ("api",))
        findings.extend(fs)
        results.append({
            "path": p, "unauth": unauth["status"], "authed": authed["status"],
            "len": obs["unauth_len"], "ct": obs["content_type"][:40],
            "rule_hits": [f.code for f in fs],
            "error": unauth["error"],
        })
        time.sleep(0.12)  # be a polite client

    findings = collapse(sort_findings(findings), host)
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": "api",
        "target": base,
        "host": host,
        "paths_probed": len(results),
        "counts": _counts(findings),
        "findings": [f.as_dict() for f in findings],
        "probes": results,
    }


def _counts(fs: list[Finding]) -> dict:
    c = {"red": 0, "white": 0, "grey": 0, "critical": 0, "high": 0}
    for f in fs:
        c[f.hat] = c.get(f.hat, 0) + 1
        if f.severity in c:
            c[f.severity] += 1
    return c


# --------------------------------------------------------------------------
# chain audit (EVM) - reuses bot.py primitives
# --------------------------------------------------------------------------

def audit_chain(rpc_url: str, address: str, rules: list[dict],
                blocks: int = 400, big_transfer: int = 10 ** 24) -> dict:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from bot import (Rpc, RpcError, SLOT_IMPL, SLOT_ADMIN, SEL, ZERO_ADDR,
                     walk_opcodes, chain_name, is_mainnet, probe_logs)

    rpc = Rpc(rpc_url)
    findings: list[Finding] = []
    obs: dict = {"address": address, "rpc": rpc_url}

    try:
        cid = rpc.chain_id()
    except RpcError as e:
        return {"kind": "chain", "target": address, "error": str(e),
                "findings": [], "counts": _counts([])}

    obs["chain_id"] = cid
    obs["chain_name"] = chain_name(cid)
    obs["is_mainnet"] = is_mainnet(cid)

    try:
        accts = rpc.call("eth_accounts") or []
    except RpcError:
        accts = []
    obs["node_account_count"] = len(accts)
    obs["first_account"] = accts[0] if accts else ""

    if address:
        code = rpc.code(address)
        if code in ("0x", "0x0", ""):
            obs["no_code"] = True
            findings.extend(apply_rules(rules, obs, ("evm",)))
            return {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "kind": "chain", "target": address, "chain_id": cid,
                    "findings": [f.as_dict() for f in sort_findings(findings)],
                    "counts": _counts(findings)}

        ops = set(walk_opcodes(code))
        obs["selfdestruct"] = 0xFF in ops
        obs["delegatecall"] = 0xF4 in ops or 0xF2 in ops
        obs["code_bytes"] = (len(code) - 2) // 2

        impl_raw = rpc.storage(address, SLOT_IMPL)
        admin_raw = rpc.storage(address, SLOT_ADMIN)
        impl = "0x" + impl_raw[-40:]
        admin = "0x" + admin_raw[-40:]
        obs["implementation"] = impl if impl != ZERO_ADDR else ""
        obs["admin"] = admin if admin != ZERO_ADDR else ""
        obs["admin_is_zero"] = admin == ZERO_ADDR

        owner_raw = rpc.eth_call(address, SEL["owner()"])
        owner = ""
        if owner_raw and owner_raw != "0x":
            owner = "0x" + owner_raw[-40:]
        obs["owner"] = owner if owner != ZERO_ADDR else ""
        if obs["owner"]:
            oc = rpc.code(obs["owner"])
            obs["owner_is_contract"] = oc not in ("0x", "0x0", "")

    findings.extend(apply_rules(rules, obs, ("evm",)))

    # white hat: logs, mapped to log-kind rules
    if address:
        for lf in probe_logs(rpc, address, blocks, big_transfer):
            lobs = {"rule": lf.code, "tx": lf.evidence.get("tx"),
                    "block": lf.evidence.get("block"),
                    "detail": lf.title, "address": address}
            hit = apply_rules(rules, lobs, ("log",))
            findings.extend(hit if hit else [lf])

    findings = collapse(sort_findings(findings), address)
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": "chain", "target": address, "chain_id": obs.get("chain_id"),
        "chain_name": obs.get("chain_name"), "is_mainnet": obs.get("is_mainnet"),
        "observation": obs,
        "counts": _counts(findings),
        "findings": [f.as_dict() for f in findings],
    }


# --------------------------------------------------------------------------
# hunt = brief-driven, both surfaces
# --------------------------------------------------------------------------

def hunt(brief: dict, rules: list[dict]) -> dict:
    out = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "kind": "hunt",
           "name": brief.get("name", "hunt"), "targets": [], "counts": {}}
    allf: list[Finding] = []

    for api in brief.get("api", []):
        r = audit_api(api["url"], api.get("token"), rules,
                      api.get("paths"))
        out["targets"].append({"kind": "api", "target": api["url"],
                               "counts": r["counts"], "findings": r["findings"]})
        allf.extend(Finding(**{k: f[k] for k in
                               ("hat", "code", "severity", "title",
                                "evidence", "remediation")})
                    for f in r["findings"])

    for c in brief.get("chain", []):
        r = audit_chain(c["rpc"], c.get("address", ""), rules,
                        c.get("blocks", 400))
        out["targets"].append({"kind": "chain", "target": c.get("address") or c["rpc"],
                               "counts": r["counts"], "findings": r["findings"]})
        allf.extend(Finding(**{k: f[k] for k in
                               ("hat", "code", "severity", "title",
                                "evidence", "remediation")})
                    for f in r["findings"])

    out["counts"] = _counts(allf)
    return out


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------

def render_md(res: dict) -> str:
    c = res.get("counts", {})
    lines = [f"# KESTREL {res.get('kind', 'hunt')} - {res.get('target') or res.get('name')}", ""]
    lines.append(f"- red {c.get('red', 0)} / white {c.get('white', 0)} / "
                 f"grey {c.get('grey', 0)} / critical {c.get('critical', 0)} / "
                 f"high {c.get('high', 0)}")
    lines.append("")
    fs = res.get("findings") or []
    if "targets" in res:
        fs = [f for t in res.get("targets", []) for f in t.get("findings", [])]
    if not fs:
        lines.append("no rule matched.")
        return "\n".join(lines) + "\n"
    lines += ["| hat | rule | sev | title |", "|---|---|---|---|"]
    for f in fs:
        lines.append(f"| {f['hat']} | {f['code']} | {f['severity']} | {f['title']} |")
    lines.append("")
    for f in fs:
        if f["severity"] == "info":
            continue
        lines += [f"## {f['code']} {f['title']}", "", "```json",
                  json.dumps(f["evidence"], indent=2)[:900], "```", ""]
        if f.get("remediation"):
            lines += [f["remediation"], ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# selftest
# --------------------------------------------------------------------------

def selftest() -> int:
    fails = []

    def ck(n, c):
        if not c:
            fails.append(n)

    rules = load_rules()
    ck("rules load", len(rules) > 0)
    ck("rule ids unique", len({r["id"] for r in rules}) == len(rules))

    obs = {"path": "/admin/users", "unauth_status": 200, "authed_status": 200,
           "unauth_len": 120, "host": "api.x.com", "body": "", "server": ""}
    fs = apply_rules(rules, obs, ("api",))
    ck("admin path rule fires", any(f.code == "API-AUTHZ-01" for f in fs))

    obs2 = dict(obs, path="/public", unauth_status=200, authed_status=200)
    fs2 = apply_rules(rules, obs2, ("api",))
    ck("admin rule silent on /public", not any(f.code == "API-AUTHZ-01" for f in fs2))

    obs3 = {"path": "/x", "unauth_status": 401, "authed_status": 200,
            "unauth_len": 0, "host": "api.x", "body": "", "server": ""}
    ck("auth2 silent when unauth is 401",
       not any(f.code == "API-AUTHZ-02" for f in apply_rules(rules, obs3, ("api",))))

    cors = {"path": "/a", "host": "api.x", "acao": "https://evil.test",
            "acac": "true", "acao_is_echo": True, "origin_sent": "https://evil.test",
            "unauth_status": 200, "authed_status": 200, "unauth_len": 10,
            "body": "", "server": "", "content_type": ""}
    ck("cors echo rule fires",
       any(f.code == "API-CORS-01" for f in apply_rules(rules, cors, ("api",))))

    evm = {"address": "0xabc", "implementation": "0xdef", "admin_is_zero": True,
           "selfdestruct": False, "node_account_count": 0, "owner": "",
           "owner_is_contract": False}
    ck("proxy empty admin fires",
       any(f.code == "EVM-PROXY-01" for f in apply_rules(rules, evm, ("evm",))))

    evm2 = dict(evm, admin_is_zero=False)
    ck("proxy with admin silent",
       not any(f.code == "EVM-PROXY-01" for f in apply_rules(rules, evm2, ("evm",))))

    eoa = dict(evm, owner="0x" + "1" * 40, owner_is_contract=False, admin_is_zero=False,
               implementation="")
    ck("eoa owner fires",
       any(f.code == "EVM-OWNER-01" for f in apply_rules(rules, eoa, ("evm",))))

    contract_owner = dict(eoa, owner_is_contract=True)
    ck("contract owner silent",
       not any(f.code == "EVM-OWNER-01" for f in apply_rules(rules, contract_owner, ("evm",))))

    ck("log rule maps proxy upgrade",
       any(f.code == "LOG-RUG-01" for f in
           apply_rules(rules, {"rule": "R1.proxy_upgrade"}, ("log",))))

    ck("unknown op raises",
       _raises(lambda: matches({"nope": {"path": "obs.x"}}, {"obs": {}})))

    ck("regex rule works", matches({"regex": {"path": "obs.p", "value": "^/a"}},
                                   {"obs": {"p": "/abc"}}))
    ck("gt rule works", matches({"gt": {"path": "obs.n", "value": 5}},
                                {"obs": {"n": 6}}))
    ck("missing path fails closed",
       not matches({"eq": {"path": "obs.absent", "value": 1}}, {"obs": {}}))

    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print("  -", f)
        return 1
    print(f"selftest ok: {len(rules)} rules, 15 engine checks pass")
    return 0


def _raises(fn) -> bool:
    try:
        fn()
        return False
    except RuleError:
        return True


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="engine")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("selftest")
    sub.add_parser("rules")

    p = sub.add_parser("api")
    p.add_argument("--url", required=True)
    p.add_argument("--token", default=None)
    p.add_argument("--paths", default=None, help="comma separated")
    p.add_argument("--out", default="out")
    p.add_argument("--json", action="store_true")

    c = sub.add_parser("chain")
    c.add_argument("--rpc", required=True)
    c.add_argument("--address", default="")
    c.add_argument("--blocks", type=int, default=400)
    c.add_argument("--out", default="out")
    c.add_argument("--json", action="store_true")

    h = sub.add_parser("hunt")
    h.add_argument("--brief", required=True)
    h.add_argument("--out", default="out")
    h.add_argument("--json", action="store_true")

    a = ap.parse_args(argv)

    if a.cmd == "selftest":
        return selftest()

    if a.cmd == "rules":
        rules = load_rules()
        for r in rules:
            print(f"{r['hat']:5} {r['severity']:<8} {r['id']:<16} {r['title']}")
        print(f"\n{len(rules)} rules")
        return 0

    if a.cmd == "api":
        rules = load_rules()
        paths = [x.strip() for x in a.paths.split(",")] if a.paths else None
        res = audit_api(a.url, a.token, rules, paths)
        return _emit(res, a)

    if a.cmd == "chain":
        rules = load_rules()
        res = audit_chain(a.rpc, a.address, rules, a.blocks)
        return _emit(res, a)

    rules = load_rules()
    with open(a.brief) as fh:
        brief = json.load(fh)
    res = hunt(brief, rules)
    return _emit(res, a)


def _emit(res: dict, a) -> int:
    out = getattr(a, "out", "out")
    os.makedirs(out, exist_ok=True)
    tag = res.get("kind", "hunt")
    with open(os.path.join(out, f"{tag}.json"), "w") as fh:
        json.dump(res, fh, indent=2)
    md = render_md(res)
    with open(os.path.join(out, f"{tag}.md"), "w") as fh:
        fh.write(md)
    if getattr(a, "json", False):
        print(json.dumps(res, indent=2))
    else:
        print(md)
    c = res.get("counts", {})
    return 1 if c.get("critical") or c.get("high") else 0


if __name__ == "__main__":
    sys.exit(main())
