# KESTREL

Rules-driven red / white / grey hat, plus the trading switch.

Royan edits `rules.json`. The engine never changes. That is the whole design:
adding a rule is a JSON edit, not a code change.

```
python3 engine.py selftest                    # 15 engine checks, no network
python3 engine.py rules                       # list every rule
python3 engine.py api   --url U [--token T]   # API audit
python3 engine.py chain --rpc R --address A   # contract audit
python3 engine.py hunt  --brief brief.json    # both surfaces, one report

python3 bot.py selftest                       # 18 chain checks
python3 bot.py cycle   --rpc R --address A    # red + white, one list

python3 desk.py status                        # the switch
python3 desk.py on | off
python3 desk.py tick --symbol BTC --price 100 --signal enter
```

stdlib only. No API key. Any JSON-RPC endpoint.

## Three hats

- red   looking for what can be attacked
- white watching for it happening now
- grey  observations that are real but not actionable alone

A grey finding is not noise. It is a fact that needs a proof before it becomes
a vulnerability. `API-CORS-02` is wildcard CORS: fine for public data, a finding
only once shown to cross a credential boundary.

## Editing rules

Every rule has the same shape. `when` is a tree of clauses; every clause in a
`when` must match, and `any_of` / `all_of` nest.

```json
{
  "id": "MY-RULE-01",
  "hat": "red",
  "kind": "api",
  "title": "what it says in the report",
  "severity": "high",
  "when": {
    "all_of": [
      { "eq": "obs.unauth_status", "value": 200 },
      { "regex": "obs.path", "value": "(?i)/admin" }
    ]
  },
  "remediation": "what to do",
  "evidence": ["path", "unauth_status"]
}
```

Matchers: `eq neq in nin contains icontains regex exists missing gt gte lt lte`.

Observation keys available by `kind`:

| kind | keys |
|---|---|
| api | host path url unauth_status authed_status unauth_len authed_len content_type server powered_by acao acac acao_is_echo origin_sent body body_match_redacted |
| evm | address chain_id chain_name is_mainnet implementation admin admin_is_zero owner owner_is_contract selfdestruct delegatecall code_bytes node_account_count first_account |
| log | rule tx block detail address |

`python3 engine.py selftest` runs every rule against a fixture, so a typo in a
regex or a bad operator fails before a hunt does.

## Any project

A brief is the whole contract:

```json
{
  "name": "acme",
  "api":   [ { "url": "https://api.acme.com", "token": "OPTIONAL", "paths": ["/","/admin"] } ],
  "chain": [ { "rpc": "https://ethereum-rpc.publicnode.com", "address": "0x...", "blocks": 400 } ]
}
```

`hunt` walks both lists, applies every matching rule, and writes
`out/hunt.json` and `out/hunt.md`. Exit code 1 on critical or high, so a cron
can branch on it.

## Trading switch

The screenshot conflates two things. They are separate on purpose.

- switch: does it place orders by itself
- armed: is it allowed to use real money

| switch | armed | mode |
|---|---|---|
| on | yes | live |
| on | no | paper, and it names the unmet gates |
| off | yes | paper |

Flipping the switch can never quietly move money, and arming can never go live
while the switch is off.

Mirrors the screenshot: 1% risk per trade, max 3 open, daily stop -3%.

## Verified live

```
api.github.com                          -> grey 1  (wildcard CORS on an API host)
ethereum 0x8787...A4E2 (Aave Pool)      -> red 1 high (proxy, empty admin slot)
ethereum 0x7Fc6...dAE9 (proxy w/ admin) -> white 2 (unlimited approvals)
base     0x8335...2913 (USDC)           -> white 5 (unlimited approvals)
desk.py  buy 100 -> sell 112            -> +1.2 equity, 1 paper trade, 1W
```

## Honest limits

- API audit is unauthenticated plus one optional bearer token. It does not log
  in, does not replay sessions, and does not fuzz parameters.
- No IDOR/BOLA prober yet. That needs two identities and per-endpoint object
  ids, which a generic path list cannot supply.
- `eth_getLogs` span is capped by the node; the bot parses the node's own
  `retry with the range a-b` hint rather than inventing one.
- No privileged-function selector discovery. A guessed 4-byte id is worse than
  no finding.
- `desk.py` decides, it does not submit. A venue adapter is a sink function,
  not a rewrite, but it does not exist yet.
- No backtester. Do not quote a profit factor from `desk.py`.
