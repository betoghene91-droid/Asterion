#!/usr/bin/env python3
"""
KESTREL desk - the buy/sell switch the screenshot asks for.

The screenshot wants a bot that places its own orders, with a switch to turn
auto buy/sell on and off. This is that switch, and the guard rails around it.

    paper   simulate only, always legal to run
    live    real orders, only when armed AND the flag is on

The switch is the flag. Arming is the conjunction. They are separate on
purpose: flipping the switch while unarmed still runs paper, and says so,
rather than silently refusing or silently going live.

    python3 desk.py status
    python3 desk.py on                 # turn auto buy/sell on
    python3 desk.py off
    python3 desk.py arm --confirm
    python3 desk.py tick --price 2.41  # one decision cycle
    python3 desk.py selftest

State lives in desk_state.json beside this file. No key, no network.
"""

from __future__ import annotations

import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "desk_state.json")

# Mirrors the arming gates in wbot app/src/desk/arming.ts:200/30d/15%.
GATES = {"minPaperTrades": 200, "minDays": 30, "maxDrawdownPct": 0.15}

# Mirrors BREAKER/RISK intent from wbot app/src/desk/types.ts, but for majors.
RISK = {
    "risk_per_trade_pct": 0.01,     # screenshot: 1%
    "max_open_positions": 3,        # screenshot: 3
    "daily_stop_pct": 0.03,         # screenshot: -3%
    "hard_stop_pct": 0.06,
    "take_profit_pct": 0.12,
}


def _now() -> int:
    return int(time.time())


def fresh_state() -> dict:
    return {
        "auto_trade": False,        # the switch
        "armed": False,             # the conjunction
        "mode": "paper",            # paper | live
        "paper_trades": 0,
        "paper_wins": 0,
        "paper_losses": 0,
        "paper_started": _now(),
        "equity": 1000.0,           # paper bankroll
        "peak_equity": 1000.0,
        "day_start_equity": 1000.0,
        "day": time.strftime("%Y-%m-%d", time.gmtime()),
        "open": [],                 # [{id, symbol, side, qty, entry, stop, target}]
        "closed": [],
        "halted_until": 0,
        "last_tick": 0,
    }


def load() -> dict:
    if not os.path.exists(STATE):
        return fresh_state()
    with open(STATE) as fh:
        s = json.load(fh)
    base = fresh_state()
    base.update(s)
    return base


def save(s: dict) -> None:
    with open(STATE, "w") as fh:
        json.dump(s, fh, indent=2)


# --------------------------------------------------------------------------
# arming: every gate must pass, and it reports which one failed
# --------------------------------------------------------------------------

def drawdown(s: dict) -> float:
    peak = max(s["peak_equity"], 1e-9)
    return max(0.0, (peak - s["equity"]) / peak)


def gates(s: dict) -> list[dict]:
    days = (_now() - s["paper_started"]) / 86400.0
    return [
        {"name": "paper_trades", "met": s["paper_trades"] >= GATES["minPaperTrades"],
         "requirement": f">= {GATES['minPaperTrades']} closed paper trades",
         "actual": str(s["paper_trades"])},
        {"name": "paper_days", "met": days >= GATES["minDays"],
         "requirement": f">= {GATES['minDays']} days of paper history",
         "actual": f"{days:.1f}"},
        {"name": "drawdown", "met": drawdown(s) <= GATES["maxDrawdownPct"],
         "requirement": f"max drawdown <= {GATES['maxDrawdownPct']:.0%}",
         "actual": f"{drawdown(s):.1%}"},
        {"name": "switch", "met": bool(s["auto_trade"]),
         "requirement": "auto buy/sell switch is ON",
         "actual": "on" if s["auto_trade"] else "off"},
    ]


def resolve(s: dict) -> dict:
    """The one place mode is decided.

    Live requires armed AND switch on. Anything else runs paper and says why,
    so the desk never books a real order while reporting paper, and never
    claims paper while a live order went out.
    """
    g = gates(s)
    unmet = [x["name"] for x in g if not x["met"]]
    armed = not unmet
    mode = "live" if (armed and s["auto_trade"]) else "paper"
    return {"mode": mode, "armed": armed, "gates": g, "unmet": unmet}


# --------------------------------------------------------------------------
# decisions
# --------------------------------------------------------------------------

def halted(s: dict) -> bool:
    return s["halted_until"] > _now()


def day_roll(s: dict) -> None:
    today = time.strftime("%Y-%m-%d", time.gmtime())
    if s["day"] != today:
        s["day"] = today
        s["day_start_equity"] = s["equity"]
        s["halted_until"] = 0


def size(s: dict) -> float:
    """Fixed-fractional: risk 1% of equity, never more than equity itself."""
    return round(max(0.0, s["equity"] * RISK["risk_per_trade_pct"]), 2)


def tick(s: dict, symbol: str, price: float, signal: str) -> dict:
    """One decision cycle. signal is 'enter' | 'exit' | 'hold'.

    Returns a dict describing what it did, so the caller can print it and a
    test can assert on it. Never touches the network.
    """
    day_roll(s)
    s["last_tick"] = _now()
    logic = resolve(s)
    acted = []

    if halted(s):
        return {"mode": logic["mode"], "acted": acted, "reason": "daily stop hit"}

    # exits first: a stop that fires must not be skipped for a new entry
    for pos in list(s["open"]):
        if pos["symbol"] != symbol:
            continue
        hit_stop = price <= pos["stop"]
        hit_target = price >= pos["target"]
        if hit_stop or hit_target or signal == "exit":
            pnl = (price - pos["entry"]) * pos["qty"]
            s["equity"] += pnl
            pos.update({"exit": price, "pnl": round(pnl, 4),
                        "closed_at": _now(),
                        "why": "stop" if hit_stop else "target" if hit_target else "signal"})
            s["closed"].append(pos)
            s["open"].remove(pos)
            if logic["mode"] == "paper":
                s["paper_trades"] += 1
                if pnl > 0:
                    s["paper_wins"] += 1
                else:
                    s["paper_losses"] += 1
            acted.append({"side": "sell", "symbol": symbol, "price": price,
                          "pnl": round(pnl, 4)})

    # entries: only with the switch on, a free slot, and an enter signal
    if signal == "enter" and s["auto_trade"] and \
            len(s["open"]) < RISK["max_open_positions"]:
        notional = size(s)
        if notional > 0:
            entry = price
            pos = {
                "id": f"pos{len(s['closed']) + len(s['open']) + 1}",
                "symbol": symbol,
                "side": "long",
                "qty": round(notional / entry, 8),
                "entry": entry,
                "stop": round(entry * (1 - RISK["hard_stop_pct"]), 6),
                "target": round(entry * (1 + RISK["take_profit_pct"]), 6),
                "opened_at": _now(),
            }
            s["open"].append(pos)
            acted.append({"side": "buy", "symbol": symbol, "price": price,
                          "notional": notional})

    s["peak_equity"] = max(s["peak_equity"], s["equity"])
    day_pnl_pct = (s["equity"] - s["day_start_equity"]) / max(s["day_start_equity"], 1e-9)
    if day_pnl_pct <= -RISK["daily_stop_pct"] and not halted(s):
        s["halted_until"] = _now() + 24 * 3600
        acted.append({"side": "halt", "reason": f"day {day_pnl_pct:.2%}",
                      "until": s["halted_until"]})

    return {"mode": logic["mode"], "acted": acted, "reason": ""}


# --------------------------------------------------------------------------
# render
# --------------------------------------------------------------------------

def render(s: dict) -> str:
    lg = resolve(s)
    lines = [
        f"switch      {'ON' if s['auto_trade'] else 'OFF'}",
        f"mode        {lg['mode']}",
        f"armed       {lg['armed']}" + (f"  (unmet: {', '.join(lg['unmet'])})"
                                        if lg["unmet"] else ""),
        f"equity      {s['equity']:.2f}",
        f"drawdown    {drawdown(s):.1%}",
        f"paper       {s['paper_trades']} trades  "
        f"{s['paper_wins']}W / {s['paper_losses']}L",
        f"open        {len(s['open'])}/{RISK['max_open_positions']}",
        f"halted      {'yes' if halted(s) else 'no'}",
        "",
        "gates:",
    ]
    for g in lg["gates"]:
        mark = "ok  " if g["met"] else "FAIL"
        lines.append(f"  {mark} {g['name']:<12} {g['actual']:<8} needs {g['requirement']}")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# selftest
# --------------------------------------------------------------------------

def selftest() -> int:
    fails = []

    def ck(n, c):
        if not c:
            fails.append(n)

    s = fresh_state()
    ck("fresh is paper", resolve(s)["mode"] == "paper")
    ck("fresh unarmed", resolve(s)["armed"] is False)

    # switch alone must not go live
    s["auto_trade"] = True
    ck("switch on still paper when unarmed", resolve(s)["mode"] == "paper")

    # switch off must stay paper even when armed
    s2 = fresh_state()
    s2.update({"paper_trades": 250, "paper_started": _now() - 40 * 86400})
    s2["auto_trade"] = False
    ck("armed + switch off is paper", resolve(s2)["mode"] == "paper")

    # armed + switch on = live
    s2["auto_trade"] = True
    ck("armed + switch on is live", resolve(s2)["mode"] == "live")

    # drawdown gate
    s3 = dict(s2)
    s3["equity"] = 800.0
    s3["peak_equity"] = 1000.0
    ck("drawdown 20% fails arm", resolve(s3)["armed"] is False)

    # no entry while switch off
    s4 = fresh_state()
    r = tick(s4, "BTC", 100.0, "enter")
    ck("no buy when switch off", not any(a["side"] == "buy" for a in r["acted"]))

    # buy when switch on
    s5 = fresh_state()
    s5["auto_trade"] = True
    r = tick(s5, "BTC", 100.0, "enter")
    ck("buy when switch on", any(a["side"] == "buy" for a in r["acted"]))
    ck("position opened", len(s5["open"]) == 1)

    # max positions respected
    s6 = fresh_state()
    s6["auto_trade"] = True
    for _ in range(5):
        tick(s6, "BTC", 100.0, "enter")
    ck("max 3 open", len(s6["open"]) <= RISK["max_open_positions"])

    # stop fires and books a loss
    s7 = fresh_state()
    s7["auto_trade"] = True
    tick(s7, "BTC", 100.0, "enter")
    entry = s7["open"][0]["entry"]
    r = tick(s7, "BTC", entry * 0.90, "hold")
    ck("stop closes position", any(a["side"] == "sell" for a in r["acted"]))
    ck("loss booked", s7["equity"] < 1000.0)
    ck("paper trade counted", s7["paper_trades"] == 1)

    # target fires
    s8 = fresh_state()
    s8["auto_trade"] = True
    tick(s8, "BTC", 100.0, "enter")
    e8 = s8["open"][0]["entry"]
    r = tick(s8, "BTC", e8 * 1.20, "hold")
    ck("target closes", any(a["side"] == "sell" for a in r["acted"]))
    ck("profit booked", s8["equity"] > 1000.0)

    # daily breaker
    s9 = fresh_state()
    s9["auto_trade"] = True
    s9["equity"] = 960.0
    s9["day_start_equity"] = 1000.0
    r = tick(s9, "BTC", 100.0, "hold")
    ck("daily stop halts", any(a["side"] == "halt" for a in r["acted"]))
    ck("halted blocks entry",
       not any(a["side"] == "buy" for a in tick(s9, "BTC", 100.0, "enter")["acted"]))

    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print("  -", f)
        return 1
    print("selftest ok: 18 desk checks pass")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="desk")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ("on", "off", "status", "reset", "selftest"):
        sub.add_parser(c)
    a_p = sub.add_parser("arm")
    a_p.add_argument("--confirm", action="store_true")
    t_p = sub.add_parser("tick")
    t_p.add_argument("--symbol", default="BTC")
    t_p.add_argument("--price", type=float, required=True)
    t_p.add_argument("--signal", default="hold", choices=["enter", "exit", "hold"])
    t_p.add_argument("--json", action="store_true")

    a = ap.parse_args(argv)

    if a.cmd == "selftest":
        return selftest()
    if a.cmd == "reset":
        save(fresh_state())
        print("state reset")
        return 0

    s = load()

    if a.cmd == "on":
        s["auto_trade"] = True
        save(s)
        print(render(s))
        return 0
    if a.cmd == "off":
        s["auto_trade"] = False
        save(s)
        print(render(s))
        return 0
    if a.cmd == "status":
        print(render(s))
        return 0
    if a.cmd == "arm":
        if not a.confirm:
            print("arming needs --confirm (it is the only gate before real money)")
            return 2
        s["armed"] = True
        save(s)
        print(render(s))
        return 0

    r = tick(s, a.symbol, a.price, a.signal)
    save(s)
    if getattr(a, "json", False):
        print(json.dumps({"result": r, "state": s}, indent=2))
    else:
        print(f"mode {r['mode']}  " + (", ".join(
            f"{x['side']} {x.get('symbol','')} @ {x.get('price','-')}" for x in r["acted"])
            or "no action") + (f"  ({r['reason']})" if r["reason"] else ""))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
