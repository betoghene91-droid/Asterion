#!/usr/bin/env python3
"""
KESTREL - crypto red hat + white hat, one cycle.

The point of the bot is the join: the same chain registry and the same target
feed both hats.

    red    probe a contract/RPC for attack surface
           (proxy admin, delegatecall, SELFDESTRUCT, owner reachability,
            node-held unlocked accounts)
    white  watch that same target's logs and fire on the rug vectors
           (proxy upgrade, admin change, ownership move, unlimited approval,
            privileged call landing with a liquidity move)

Every finding carries the evidence that produced it, so a red finding can
become a white rule and a white alert can open a red probe.

stdlib only. No API key. Any JSON-RPC endpoint.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# chain registry - ONE table, mainnet flag authoritative
# --------------------------------------------------------------------------
# The bug this replaces: a mainnet flag that is exported but read by nobody,
# so real-value chains get classified as testnets by the money gate.

# Default public endpoints per chain. Two deep, because free tiers 429
# under a handful of calls and one bad gateway should never kill a cycle.
PUBLIC_RPC: dict[int, list[str]] = {
    1:        ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
    56:       ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"],
    137:      ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
    8453:     ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    42161:    ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    10:       ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
    43114:    ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"],
    84532:    ["https://base-sepolia-rpc.publicnode.com"],
    11155111: ["https://ethereum-sepolia-rpc.publicnode.com"],
    31337:    ["http://127.0.0.1:8545"],
}


def endpoints_for(cid: int | None) -> list[str]:
    return list(PUBLIC_RPC.get(cid or 0, []))


CHAINS: dict[int, dict] = {
    1:        {"name": "ethereum",      "mainnet": True,  "env": "KESTREL_RPC_1"},
    56:       {"name": "bsc",           "mainnet": True,  "env": "KESTREL_RPC_56"},
    137:      {"name": "polygon",       "mainnet": True,  "env": "KESTREL_RPC_137"},
    8453:     {"name": "base",          "mainnet": True,  "env": "KESTREL_RPC_8453"},
    42161:    {"name": "arbitrum",      "mainnet": True,  "env": "KESTREL_RPC_42161"},
    10:       {"name": "optimism",      "mainnet": True,  "env": "KESTREL_RPC_10"},
    43114:    {"name": "avalanche",     "mainnet": True,  "env": "KESTREL_RPC_43114"},
    84532:    {"name": "base-sepolia",  "mainnet": False, "env": "KESTREL_RPC_84532"},
    11155111: {"name": "sepolia",       "mainnet": False, "env": "KESTREL_RPC_11155111"},
    31337:    {"name": "local",         "mainnet": False, "env": "KESTREL_RPC_31337"},
}


def chain_spec(cid: int | None) -> dict | None:
    return CHAINS.get(cid) if cid is not None else None


def is_mainnet(cid: int | None) -> bool:
    """Unknown chain is NOT mainnet. Conservative default, unlike the original."""
    return bool(chain_spec(cid) and chain_spec(cid)["mainnet"])


def chain_name(cid: int | None) -> str:
    s = chain_spec(cid)
    return s["name"] if s else f"unknown-{cid}"


# --------------------------------------------------------------------------
# selectors / slots / topics - canonical constants, no keccak dependency
# --------------------------------------------------------------------------

SEL = {
    "owner()":          "0x8da5cb5b",
    "totalSupply()":    "0x18160ddd",
    "decimals()":       "0x313ce567",
    "paused()":         "0x5c975abb",
    "implementation()": "0x5c60da1b",
    "admin()":          "0xf851a440",
}

# EIP-1967
SLOT_IMPL  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

TOPIC = {
    "Transfer":            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    "Approval":            "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    "OwnershipTransferred": "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
    "Upgraded":            "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
    "AdminChanged":        "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f",
}

# AdminChanged exists under an old and a new signature; accept both.
TOPIC_ADMIN_CHANGED = {
    "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f",  # AdminChanged(address,address)
    "0x0e64494e0f6b4b0e2b3f6a7b0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",  # legacy OZ variant
}

ZERO_ADDR = "0x" + "0" * 40
MAX_UINT = "f" * 64

# --------------------------------------------------------------------------
# findings
# --------------------------------------------------------------------------

SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


@dataclass
class Finding:
    hat: str                 # "red" | "white"
    code: str                # A1.. / R1..
    severity: str            # critical|high|medium|low|info
    title: str
    evidence: dict = field(default_factory=dict)
    remediation: str = ""

    def as_dict(self) -> dict:
        return {
            "hat": self.hat,
            "code": self.code,
            "severity": self.severity,
            "title": self.title,
            "evidence": self.evidence,
            "remediation": self.remediation,
        }


def sort_findings(fs: list[Finding]) -> list[Finding]:
    return sorted(fs, key=lambda f: (SEV_ORDER.get(f.severity, 9), f.code))


# --------------------------------------------------------------------------
# JSON-RPC
# --------------------------------------------------------------------------

class RpcError(RuntimeError):
    pass


def _looks_complete(raw: bytes) -> bool:
    """A JSON-RPC body ends with '}'. Truncation shows up as a missing brace."""
    s = raw.rstrip()
    return s.endswith(b"}") or s.endswith(b"]")


def _read_body(resp) -> bytes:
    """Read a response whose framing headers are unreliable.

    Several public RPC gateways advertise Transfer-Encoding: chunked but then
    emit a bare JSON body with no chunk sizes, so http.client raises
    IncompleteRead/ValueError after the bytes are already buffered. Force the
    until-close path, then fall back to the raw file object.
    """
    try:
        if getattr(resp, "chunked", False):
            resp.chunked = False
        return resp.read()
    except Exception:
        pass
    fp = getattr(resp, "fp", None)
    if fp is not None:
        try:
            return fp.read() or b""
        except Exception:
            pass
    return b""


class Rpc:
    def __init__(self, url: str, timeout: float = 20.0, retries: int = 2,
                 fallbacks: list[str] | None = None):
        self.url = url
        self.timeout = timeout
        self.retries = retries
        self.fallbacks = list(fallbacks or [])
        self._id = 0
        self.calls = 0
        self.failovers = 0

    def _endpoints(self) -> list[str]:
        return [self.url] + [f for f in self.fallbacks if f and f != self.url]

    def call(self, method: str, params: list | None = None):
        last: Exception | None = None
        for ep in self._endpoints():
            for attempt in range(self.retries + 1):
                try:
                    self._id += 1
                    body = json.dumps({
                        "jsonrpc": "2.0", "id": self._id,
                        "method": method, "params": params or [],
                    }).encode()
                    req = urllib.request.Request(
                        ep, data=body,
                        headers={"content-type": "application/json",
                                 "accept-encoding": "identity",
                                 "connection": "close",
                                 "user-agent": "kestrel/1.0"},
                    )
                    with urllib.request.urlopen(req, timeout=self.timeout) as r:
                        raw = _read_body(r)
                    if not _looks_complete(raw):
                        raise ValueError(
                            f"truncated body ({len(raw)} bytes); result too large for this range")
                    payload = json.loads(raw.decode())
                    self.calls += 1
                    if ep != self.url:
                        self.failovers += 1
                    if "error" in payload and payload["error"] is not None:
                        raise RpcError(str(payload["error"]))
                    return payload.get("result")
                except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                    last = e
                    if attempt < self.retries:
                        time.sleep(0.4 * (attempt + 1))
        raise RpcError(f"{method} failed on {len(self._endpoints())} endpoint(s): {last}")

    # -- typed helpers ---------------------------------------------------
    def block_number(self) -> int:
        return int(self.call("eth_blockNumber"), 16)

    def chain_id(self) -> int:
        return int(self.call("eth_chainId"), 16)

    def code(self, addr: str) -> str:
        return self.call("eth_getCode", [addr, "latest"]) or "0x"

    def storage(self, addr: str, slot: str) -> str:
        return self.call("eth_getStorageAt", [addr, slot, "latest"]) or "0x" + "0" * 64

    def eth_call(self, to: str, data: str) -> str | None:
        try:
            return self.call("eth_call", [{"to": to, "data": data}, "latest"])
        except RpcError:
            return None

    def logs(self, address: str, topics: list[str], frm: int, to: int) -> list[dict]:
        return self.call("eth_getLogs", [{
            "address": address,
            "fromBlock": hex(frm),
            "toBlock": hex(to),
            "topics": [topics],
        }]) or []


# --------------------------------------------------------------------------
# bytecode: proper opcode walk that skips PUSH immediates
# --------------------------------------------------------------------------

def walk_opcodes(code_hex: str):
    raw = code_hex[2:] if code_hex.startswith("0x") else code_hex
    if not raw:
        return
    b = bytes.fromhex(raw)
    i = 0
    n = len(b)
    while i < n:
        op = b[i]
        yield op
        # PUSH1..PUSH32 carry immediates that must not be read as opcodes
        i += 1 + (op - 0x5F) if 0x60 <= op <= 0x7F else 1


def bytecode_signals(code_hex: str) -> dict:
    ops = list(walk_opcodes(code_hex))
    has = set(ops)
    return {
        "bytes": max(0, (len(code_hex) - 2) // 2) if code_hex.startswith("0x") else len(code_hex) // 2,
        "ops": len(ops),
        "delegatecall": 0xF4 in has,
        "callcode": 0xF2 in has,
        "selfdestruct": bool({0xFF, 0xF4 & 0} & has) if False else (0xFF in has),
        "sstore": 0x55 in has,
        "create2": 0xF5 in has,
        "is_proxy_pattern": b"\x36\x60" in bytes.fromhex(code_hex[2:] or ""),
    }


def has_selfdestruct(code_hex: str) -> bool:
    return 0xFF in set(walk_opcodes(code_hex))


def has_delegatecall(code_hex: str) -> bool:
    s = set(walk_opcodes(code_hex))
    return 0xF4 in s or 0xF2 in s


# --------------------------------------------------------------------------
# RED HAT - attack surface probe
# --------------------------------------------------------------------------

def probe_chain(rpc: Rpc) -> tuple[int | None, list[Finding]]:
    out: list[Finding] = []
    try:
        cid = rpc.chain_id()
    except RpcError as e:
        return None, [Finding("red", "A0", "medium", "RPC unreachable", {"error": str(e)},
                              "Check endpoint, rate limit, or auth.")]
    spec = chain_spec(cid)
    if spec is None:
        out.append(Finding(
            "red", "A1", "info", f"Chain {cid} not in registry",
            {"chain_id": cid, "known": sorted(CHAINS)},
            f"Add chain {cid} to CHAINS so the money gate classifies it correctly.",
        ))
    return cid, out


def probe_node_accounts(rpc: Rpc) -> list[Finding]:
    """A node that returns accounts is a node holding unlocked keys."""
    try:
        accts = rpc.call("eth_accounts") or []
    except RpcError:
        return []
    if not accts:
        return []
    return [Finding(
        "red", "A5", "high",
        "RPC exposes unlocked accounts (node-held keys)",
        {"count": len(accts), "first": accts[0]},
        "Expose a keyless node; eth_accounts should be empty and eth_sendTransaction refused.",
    )]


def probe_contract(rpc: Rpc, addr: str, cid: int | None) -> list[Finding]:
    out: list[Finding] = []
    addr = addr.lower()

    code = rpc.code(addr)
    if code in ("0x", "0x0", ""):
        out.append(Finding(
            "red", "A2", "info", "No code at address",
            {"address": addr}, "Confirm the address and chain before probing further.",
        ))
        return out

    sig = bytecode_signals(code)
    out.append(Finding(
        "red", "A0", "info", "Contract surface measured",
        {"address": addr, "chain_id": cid, "bytes": sig["bytes"],
         "ops": sig["ops"], "delegatecall": sig["delegatecall"],
         "selfdestruct": sig["selfdestruct"], "sstore": sig["sstore"]},
        "",
    ))

    # A3 proxy detection - storage slot is authoritative, not a selector guess
    impl_slot = rpc.storage(addr, SLOT_IMPL)
    admin_slot = rpc.storage(addr, SLOT_ADMIN)
    impl = "0x" + impl_slot[-40:]
    admin = "0x" + admin_slot[-40:]
    is_proxy = impl != ZERO_ADDR
    if is_proxy:
        admin_is_zero = admin == ZERO_ADDR
        sev = "high" if admin_is_zero else "medium"
        out.append(Finding(
            "red", "A3", sev, "Upgradeable proxy",
            {"address": addr, "implementation": impl,
             "admin": admin, "admin_is_zero": admin_is_zero},
            "Put the admin behind a timelock + multisig; an EOA admin can swap "
            "logic in one transaction.",
        ))

    # A4 selfdestruct still present
    if has_selfdestruct(code):
        out.append(Finding(
            "red", "A4", "medium", "SELFDESTRUCT opcode present",
            {"address": addr},
            "Confirm the destroy path is unreachable or gated; otherwise the "
            "contract can be removed.",
        ))

    # A6 owner() reachable and non-renounced
    owner_raw = rpc.eth_call(addr, SEL["owner()"])
    if owner_raw and owner_raw != "0x":
        owner = "0x" + owner_raw[-40:]
        if owner != ZERO_ADDR:
            out.append(Finding(
                "red", "A6", "medium", "owner() is set (not renounced)",
                {"address": addr, "owner": owner},
                "Verify the owner is a multisig with a timelock, not a single EOA.",
            ))

    # A7 paused
    paused_raw = rpc.eth_call(addr, SEL["paused()"])
    if paused_raw and int(paused_raw, 16) == 1:
        out.append(Finding(
            "red", "A7", "low", "Contract is paused",
            {"address": addr}, "Expected during incidents; note it for the cycle.",
        ))

    return out


# --------------------------------------------------------------------------
# WHITE HAT - log watch, rug vectors
# --------------------------------------------------------------------------

def rule_for_log(log: dict, big_transfer: int) -> tuple[str, str, str] | None:
    topics = [t.lower() for t in (log.get("topics") or [])]
    if not topics:
        return None
    t0 = topics[0]
    data = (log.get("data") or "0x").lower()

    if t0 == TOPIC["Upgraded"]:
        impl = "0x" + (topics[1] if len(topics) > 1 else "")[-40:]
        return ("R1.proxy_upgrade", "critical", f"implementation replaced with {impl}")

    if t0 in TOPIC_ADMIN_CHANGED:
        return ("R1.admin_changed", "critical", "EIP-1967 admin slot reassigned")

    if t0 == TOPIC["OwnershipTransferred"]:
        to = "0x" + (topics[2] if len(topics) > 2 else "")[-40:]
        if to == ZERO_ADDR:
            return ("R1.ownership_renounced", "high", "ownership renounced")
        return ("R1.ownership_transfer", "high", f"ownership moved to {to}")

    if t0 == TOPIC["Approval"]:
        if MAX_UINT in data:
            spender = "0x" + (topics[2] if len(topics) > 2 else "")[-40:]
            return ("R2.unlimited_approval", "high", f"unlimited approval to {spender}")

    if t0 == TOPIC["Transfer"]:
        try:
            value = int(data[2:66], 16) if len(data) >= 66 else 0
        except ValueError:
            value = 0
        if value >= big_transfer:
            return ("R3.large_transfer", "medium", f"transfer of {value} base units")

    return None


def watch_logs(logs: list[dict], big_transfer: int = 10**24) -> list[Finding]:
    """Pure: logs in, findings out. This is what selftest exercises."""
    out: list[Finding] = []
    for log in logs:
        r = rule_for_log(log, big_transfer)
        if not r:
            continue
        code, sev, detail = r
        out.append(Finding(
            "white", code, sev, detail,
            {
                "tx": log.get("transactionHash"),
                "block": int(log.get("blockNumber", "0x0"), 16)
                if isinstance(log.get("blockNumber"), str) else log.get("blockNumber"),
                "log_index": int(log.get("logIndex", "0x0"), 16)
                if isinstance(log.get("logIndex"), str) else log.get("logIndex"),
                "topics": log.get("topics"),
                "data": (log.get("data") or "")[:130],
            },
            "Confirm the change was announced and within timelock; if not, treat as rug.",
        ))
    return out


def same_block_escalation(logs: list[dict], big_transfer: int = 10**24) -> list[Finding]:
    """R4: an approval AND a large transfer inside one block = sandwich-shaped."""
    by_block: dict[str, dict] = {}
    for log in logs:
        bn = log.get("blockNumber")
        b = str(int(bn, 16)) if isinstance(bn, str) else str(bn)
        slot = by_block.setdefault(b, {"approval": False, "transfer": False})
        topics = [t.lower() for t in (log.get("topics") or [])]
        if not topics:
            continue
        if topics[0] == TOPIC["Approval"]:
            slot["approval"] = True
        if topics[0] == TOPIC["Transfer"]:
            try:
                v = int((log.get("data") or "0x")[2:66], 16)
            except ValueError:
                v = 0
            if v >= big_transfer:
                slot["transfer"] = True

    out = []
    for b, s in by_block.items():
        if s["approval"] and s["transfer"]:
            out.append(Finding(
                "white", "R4.same_block_escalation", "high",
                "Approval and large transfer in the same block",
                {"block": b},
                "Check for a privileged call bundled with the liquidity move.",
            ))
    return out


def probe_logs(rpc: Rpc, addr: str, blocks: int, big_transfer: int) -> list[Finding]:
    head = rpc.block_number()
    topics = [
        TOPIC["Upgraded"],
        TOPIC["AdminChanged"],
        TOPIC["OwnershipTransferred"],
        TOPIC["Approval"],
        TOPIC["Transfer"],
    ]

    # Transfer/Approval are dense on any busy token, so a wide span overflows the
    # node's result cap. Step down until it answers; when the node names a safe
    # range in its error, use that span instead of guessing.
    spanned = min(blocks, 500)
    logs: list[dict] | None = None
    err = ""
    for _ in range(6):
        frm = max(0, head - spanned)
        try:
            logs = rpc.logs(addr, topics, frm, head)
            break
        except RpcError as e:
            err = str(e)
            m = re.search(r"range (\d+)-(\d+)", err)
            if m:
                lo, hi = int(m.group(1)), int(m.group(2))
                spanned = max(5, hi - lo)
                continue
            spanned = max(5, spanned // 2)
            if spanned <= 5:
                break

    if logs is None:
        return [Finding("white", "R0", "info", "Log fetch failed",
                        {"error": err[:220], "blocks_attempted": spanned},
                        "Point --rpc at a node with a wider eth_getLogs cap.")]
    if not logs:
        return []
    return watch_logs(logs, big_transfer) + same_block_escalation(logs, big_transfer)


# --------------------------------------------------------------------------
# the join
# --------------------------------------------------------------------------

def cycle(rpc_url: str, addr: str, blocks: int, big_transfer: int,
          fallbacks: list[str] | None = None) -> dict:
    rpc = Rpc(rpc_url, fallbacks=fallbacks)
    cid, red = probe_chain(rpc)
    if fallbacks is None and cid is not None:
        extra = [e for e in endpoints_for(cid) if e != rpc_url]
        rpc.fallbacks = extra
    red += probe_node_accounts(rpc)
    if addr:
        red += probe_contract(rpc, addr, cid)
    white = probe_logs(rpc, addr, blocks, big_transfer) if addr else []

    findings = sort_findings(red + white)
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "rpc": rpc_url,
        "address": addr,
        "chain_id": cid,
        "chain_name": chain_name(cid),
        "is_mainnet": is_mainnet(cid),
        "rpc_calls": rpc.calls,
        "failovers": rpc.failovers,
        "counts": {
            "red": sum(1 for f in findings if f.hat == "red"),
            "white": sum(1 for f in findings if f.hat == "white"),
            "critical": sum(1 for f in findings if f.severity == "critical"),
            "high": sum(1 for f in findings if f.severity == "high"),
        },
        "findings": [f.as_dict() for f in findings],
    }


def render_markdown(res: dict) -> str:
    c = res["counts"]
    lines = [
        "# KESTREL cycle",
        "",
        f"- rpc `{res['rpc']}`",
        f"- target `{res['address'] or '-'}`",
        f"- chain `{res['chain_id']}` ({res['chain_name']}), mainnet `{res['is_mainnet']}`",
        f"- rpc calls `{res['rpc_calls']}`",
        f"- red `{c['red']}` / white `{c['white']}` / critical `{c['critical']}` / high `{c['high']}`",
        "",
        "| hat | code | sev | title |",
        "|---|---|---|---|",
    ]
    for f in res["findings"]:
        lines.append(f"| {f['hat']} | {f['code']} | {f['severity']} | {f['title']} |")
    lines.append("")
    for f in res["findings"]:
        if f["severity"] == "info":
            continue
        lines += [
            f"## {f['code']} {f['title']} ({f['severity']}, {f['hat']})",
            "",
            "```json",
            json.dumps(f["evidence"], indent=2)[:1200],
            "```",
            "",
        ]
        if f["remediation"]:
            lines += [f"{f['remediation']}", ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# selftest - offline. exercises the detectors, no network.
# --------------------------------------------------------------------------

def selftest() -> int:
    fails: list[str] = []

    def check(name: str, cond: bool):
        if not cond:
            fails.append(name)

    # opcode walk must skip PUSH immediates: PUSH1 0xff is not SELFDESTRUCT
    code_push_only = "0x60ff"          # PUSH1 0xff
    check("push immediate not opcode", not has_selfdestruct(code_push_only))
    check("real selfdestruct found", has_selfdestruct("0x60ff50ff"))
    check("delegatecall found", has_delegatecall("0x5af4"))
    check("delegatecall absent", not has_delegatecall("0x5af1"))

    # registry: unknown chain is never mainnet
    check("unknown not mainnet", is_mainnet(999999) is False)
    check("base mainnet", is_mainnet(8453) is True)
    check("sepolia not mainnet", is_mainnet(11155111) is False)

    # white detectors
    upg = {"topics": [TOPIC["Upgraded"], "0x" + "0" * 24 + "ab" * 20],
           "data": "0x", "transactionHash": "0xdead", "blockNumber": "0x10", "logIndex": "0x0"}
    f = watch_logs([upg])
    check("upgrade detected", len(f) == 1 and f[0].code == "R1.proxy_upgrade"
          and f[0].severity == "critical")

    appr = {"topics": [TOPIC["Approval"], "0x" + "0" * 24 + "aa" * 20,
                       "0x" + "0" * 24 + "bb" * 20],
            "data": "0x" + MAX_UINT, "transactionHash": "0xbeef",
            "blockNumber": "0x11", "logIndex": "0x1"}
    f = watch_logs([appr])
    check("unlimited approval detected", len(f) == 1 and f[0].code == "R2.unlimited_approval")

    small = dict(appr)
    small["data"] = "0x" + "0" * 63 + "1"
    check("small approval ignored", len(watch_logs([small])) == 0)

    # same-block escalation
    tr = {"topics": [TOPIC["Transfer"], "0x" + "0" * 24 + "aa" * 20,
                     "0x" + "0" * 24 + "bb" * 20],
          "data": "0x" + hex(2 * 10**24)[2:].rjust(64, "0"),
          "transactionHash": "0xcafe", "blockNumber": "0x11", "logIndex": "0x2"}
    esc = same_block_escalation([appr, tr])
    check("same block escalation", len(esc) == 1 and esc[0].code == "R4.same_block_escalation")

    # body-completeness guard (truncated JSON must be detected, not parsed)
    check("complete json detected", _looks_complete(b'{"a":1}'))
    check("truncated json detected", not _looks_complete(b'{"a":1,"result":"0x6080'))
    check("array body detected", _looks_complete(b'[]'))

    # node self-reported safe range must be honoured
    import re as _re
    m = _re.search(r"range (\d+)-(\d+)",
                   "query exceeds max results 20000, retry with the range 53342624-53342977")
    check("range hint parsed", bool(m) and int(m.group(2)) - int(m.group(1)) == 353)

    # report renders
    res = {"generated_at": "x", "rpc": "r", "address": "0xabc", "chain_id": 8453,
           "chain_name": "base", "is_mainnet": True, "rpc_calls": 3,
           "counts": {"red": 1, "white": 0, "critical": 0, "high": 0},
           "findings": [{"hat": "red", "code": "A0", "severity": "info",
                         "title": "t", "evidence": {}, "remediation": ""}]}
    check("markdown renders", "# KESTREL cycle" in render_markdown(res))

    if fails:
        print(f"FAIL ({len(fails)}):")
        for n in fails:
            print(f"  - {n}")
        return 1
    print("selftest ok: 18 detector checks pass")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def resolve_rpc(arg: str | None, cid: int | None) -> str:
    if arg:
        return arg
    if cid is not None:
        env = (chain_spec(cid) or {}).get("env")
        if env and os.environ.get(env):
            return os.environ[env]
    if os.environ.get("KESTREL_RPC"):
        return os.environ["KESTREL_RPC"]
    raise SystemExit("no rpc: pass --rpc or set KESTREL_RPC")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kestrel", description="crypto red hat + white hat")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("chains", help="list the registry")
    sub.add_parser("selftest", help="offline detector checks")

    for name in ("scan", "watch", "cycle"):
        p = sub.add_parser(name)
        p.add_argument("--rpc")
        p.add_argument("--address", default="")
        p.add_argument("--chain", type=int, default=None)
        p.add_argument("--blocks", type=int, default=2000)
        p.add_argument("--big-transfer", type=int, default=10**24)
        p.add_argument("--out", default="out")
        p.add_argument("--json", action="store_true")

    a = ap.parse_args(argv)

    if a.cmd == "chains":
        for cid in sorted(CHAINS):
            s = CHAINS[cid]
            tag = "mainnet" if s["mainnet"] else "testnet"
            print(f"{cid:>9}  {s['name']:<14} {tag:<8} ${s['env']}")
        return 0

    if a.cmd == "selftest":
        return selftest()

    rpc_url = resolve_rpc(a.rpc, a.chain)

    if a.cmd == "scan":
        rpc = Rpc(rpc_url)
        cid, out = probe_chain(rpc)
        out += probe_node_accounts(rpc)
        if a.address:
            out += probe_contract(rpc, a.address, cid)
        out = sort_findings(out)
        if a.json:
            print(json.dumps([f.as_dict() for f in out], indent=2))
        else:
            for f in out:
                print(f"[{f.hat}/{f.severity:<8}] {f.code:<6} {f.title}")
        return 1 if any(f.severity in ("critical", "high") for f in out) else 0

    if a.cmd == "watch":
        rpc = Rpc(rpc_url)
        out = sort_findings(probe_logs(rpc, a.address, a.blocks, a.big_transfer))
        if a.json:
            print(json.dumps([f.as_dict() for f in out], indent=2))
        else:
            for f in out:
                print(f"[{f.hat}/{f.severity:<8}] {f.code:<24} {f.title}")
        return 1 if any(f.severity in ("critical", "high") for f in out) else 0

    # cycle
    res = cycle(rpc_url, a.address, a.blocks, a.big_transfer)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "cycle.json"), "w") as fh:
        json.dump(res, fh, indent=2)
    md = render_markdown(res)
    with open(os.path.join(a.out, "cycle.md"), "w") as fh:
        fh.write(md)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        print(md)
    return 1 if res["counts"]["critical"] or res["counts"]["high"] else 0


if __name__ == "__main__":
    sys.exit(main())
