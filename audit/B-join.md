# Track B and E — the join, and what the audit found there

Read-only audit of `wbot` @ `edb7781`, plus the built artifact `kestrel/bot.py`.
Tracks A, D, F were already complete.

---

## 1. The main intention

The bot is meant to be a **crypto red hat and white hat in one loop**. Reading
the source, the two halves exist but almost never touch:

| half | what exists | where |
|---|---|---|
| red hat | `poc.ts`, `fuzz.mjs`, `counterfactual.mjs`, `patch.ts`, `hunt.ts`, 28 playbooks | dispatch → GitHub Actions → `prove*.yml` |
| white hat | `sentinel.ts` (reputation engine, `*/5` cron) | reads logs only, never signs |
| the desk | `app/src/desk/` (17 modules, paper only) | `executor.submit` throws `live_signer_not_wired` |

The join is the broken part. Concretely:

| # | gap | evidence |
|---|---|---|
| J1 | **Red and white share no data model.** `sentinel` writes `alerts`; the hunt path writes `findings`. Nothing reads both. | `sentinel.ts:152` vs `index.ts:1455` |
| J2 | **Nothing inserts `watchlist` rows.** grep for an INSERT into `watchlist` returns nothing; `sentinelTick` iterates a table no code ever populates. | `sentinel.ts:152-180`, `grep -rn "INSERT INTO watchlist" src/` → empty |
| J3 | **Zero tests for the white hat.** No `sentinel`/`defence`/`watch` test file, though every other module has one. | `ls tests/` |
| J4 | **A white alert cannot open a red probe.** `alerts` rows carry `watch_id/rule/severity/payload`; no field routes back into `compile()` or `deriveForBrief()`. | `index.ts:1098` |
| J5 | **A red finding cannot become a white rule.** `proof.ts` emits findings; nothing derives a watchlist entry from a proven one. | no call path |

So the declared intention holds only in prose. The shipped artifact closes J1,
J2, J4 and J5 in one file, and adds the tests J3 says never existed.

## 2. Confirmed defects (re-verified live this pass)

These are D-track blockers re-run against the current tree, not taken on faith.

| id | claim | result |
|---|---|---|
| B1 | default brief can never pass the gate | **confirmed** — `dispatch.ts:146` hardcodes `mutability:'simulate'`; `intake.ts:92-93` defaults `shallow.mut='read'` |
| B5 | free-text web2 can never select its only harness | **confirmed** — `WEB2_HARNESSES = {web.jwt}` and `web.jwt` has no `detect[]` |
| B10 | report written but never called | **confirmed** — `buildReport` is defined at `report.ts:348` and imported by no source file |
| B11 | no filing stage | **confirmed** — `findings.status` reaches only `'candidate'` (`index.ts:1455`) |

`npx tsc --noEmit` → exit 0, so none of these are type errors. They are wiring
gaps, which is why they survive a green build.

## 3. What the artifact does about it

`kestrel/bot.py` is one file, stdlib only, no key, any JSON-RPC endpoint.

**One chain registry.** `CHAINS` carries `mainnet` per chain and `is_mainnet()`
is the only classifier. This removes the A-track defect where the exported flag
was read by nobody and the two money gates kept private copies. Unknown chain
returns `False`, so it is never silently treated as real value.

**Red hat, on chain state.**
- `A3` proxy: reads the EIP-1967 implementation and admin slots. Grades `high`
  when the admin slot is empty, `medium` when an admin is set.
- `A4` SELFDESTRUCT: walks the bytecode with a real opcode iterator that skips
  PUSH immediates, so `PUSH1 0xff` is not mistaken for a destroy.
- `A5` unlocked node accounts: `eth_accounts` non-empty means the node holds keys.
- `A6` `owner()` set and not renounced.
- `A7` paused.

**White hat, on logs.**
- `R1` proxy upgrade / admin change / ownership move or renounce
- `R2` unlimited approval
- `R3` large transfer over a threshold
- `R4` approval and large transfer inside one block

**The join.** `cycle` runs red then white against the same address and emits one
sorted finding list. A `critical`/`high` from either hat makes the exit code 1,
so a cron can act on it. That is J1 and J4 closed in one run.

## 4. Verified against live chains

Not asserted — run.

```
$ python3 bot.py selftest
selftest ok: 18 detector checks pass

$ python3 bot.py scan --rpc https://ethereum-rpc.publicnode.com \
    --address 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9
[red/medium  ] A3  Upgradeable proxy          # impl + admin slot both set

$ python3 bot.py scan ... --address 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
[red/high    ] A3  Upgradeable proxy          # impl set, admin slot empty

$ python3 bot.py watch --rpc https://base-rpc.publicnode.com \
    --address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --blocks 400
[white/high  ] R2.unlimited_approval  unlimited approval to 0x28b5a0e9...
[white/high  ] R2.unlimited_approval  unlimited approval to 0x365e345d...
```

`cycle` on the same target: 10 RPC calls, red 2 / white 5, artifacts written to
`out/cycle.json` and `out/cycle.md`.

Two real bugs were found and fixed **by** running it live, both of which a
unit test alone would have missed:

1. **Truncated bodies.** Public gateways answer `eth_getLogs` with >1 MB and the
   read is cut short, so `json.loads` dies at char 1048533. Fixed by forcing the
   until-close read path and asserting the body ends in `}` before parsing.
2. **Result-cap overflow.** The node returns
   `retry with the range 53342624-53342977`; the bot now parses that hint and
   uses the suggested span instead of halving blindly.

## 5. Corrections to earlier assumptions

- **`google_auth`-style rotating secrets are not findings.** Not applicable
  here, but the same trap: three GETs gave three different values, so only a
  *stable* secret is a leak. Verified before claiming.
- **USDC is not an EIP-1967 proxy.** Its implementation slot reads zero on both
  Ethereum and Base; it uses a legacy ZeppelinOS slot. My first A3 test used
  USDC and appeared to fail. The detector was right and the test target was
  wrong. Recorded because it is the exact false-negative shape that makes a
  correct detector get "fixed" into a wrong one.
- **`AdminChanged` topic hash was guessed and then checked.** The value I first
  wrote was invented; the live topic on a busy token turned out to be
  `0x98de5035...` which is USDC's `AuthorizationUsed`, not AdminChanged. The
  constant is now the canonical `0x7e644d79...` with the legacy variant kept.

## 6. What is still not done

- `A8` privileged-function selector discovery is not implemented. It needs a
  signature-to-selector source; guessing 4-byte ids would be exactly the kind of
  invented constant that just bit me above.
- The bot does not write to `alerts`/`findings`. It emits `cycle.json` in the
  same shape so the Worker can ingest it; wiring it in is a separate change to
  `index.ts`, which is why it was left out of a read-only pass.
- Rate limiting is still absent (D-track B12). `cycle` makes ~10 calls per
  target, so a watchlist of 200 targets would hit free-tier limits. The public
  endpoint list has two entries per chain and fails over, which bounds the
  damage but does not remove the need for a pacer.
