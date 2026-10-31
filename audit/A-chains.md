# A — Chain coupling: every reason this bot cannot hunt an arbitrary chain

**Audit of** `/workspace/tasks/9e376083-d2a7-4d74-b1ed-5c40e20734af/wbot` @ `edb7781`
**Method** read-only. No file edited, no commit, no network git, `.git/config` never read.
All paths relative to `wbot/`. `app/src/*.ts` is the source of truth; `app/build/*.js` is `tsc` output and is not cited except where only it exists.

---

## 0. Summary (5 lines)

1. **Chain support is not one table — it is 4 literal mirrors plus 2 undiscovered duplicate allowlists.** 79 chain-coupled locations across 24 files; the authoritative registry `app/src/chains.ts:64` is mirrored by hand into `.github/workflows/prove.yml:94-124`, and *contradicted* by independent mainnet lists in `app/src/send.ts:47` and `app/src/drain.ts:201`.
2. **Adding one EVM chain is 6 mandatory edits + 1 secret across 4 files. Of the 9 failure sites, 5 are LOUD and 3 are dangerously SILENT — including the one that touches money.** `chains.ts:137 isMainnet` is exported, unit-tested, and imported by *nobody*; the two gates that actually matter keep their own private copies. A new real-value chain is therefore classified as a testnet by those gates.
3. **"Any chain" is not a config problem, it is three architecture problems:** one chain per engagement is hard-baked at `policy.ts:615-703`, nothing knows an L2 depends on L1, and there is no archive-RPC requirement anywhere — so the common outcome on an arbitrary chain is a `setUp` revert, not a proof.
4. **Non-EVM does not generalise.** The plane abstraction fits Solana by accident (`prove-solana.yml` uses in-process **bankrun** — *no fork, no RPC, no real state*, lines 6-16). Exactly one harness works there (`planes.ts:606`), and it works *because* a signer check needs no state. Seven of the eight remaining families need both a toolchain and a state-cloning primitive that does not exist in this codebase.
5. **The binding constraint is not the chain table — it is that a harness is per-class *and* per-family.** Adding chain #6 buys you a fork you cannot write a check against. The highest-yield change is chains + the money-gate fix *together*; doing chains alone is a fund-safety regression.

---

## 1. Chain-coupled surface (79 locations)

Legend — **Behaviour on an unknown chain:**
`LOUD` = explicit refusal naming the problem · `SILENT` = degrades without error · `DEAD` = value is stored/exported but nothing reads it · `OK` = designed to absorb an unknown chain correctly.

### 1.1 Registry — `app/src/chains.ts` (7)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C1 | `chains.ts:64` `CHAINS` | Exactly 5 rows: 1, 8453, 84532, 11155111, 31337. Header at `:56-63` states adding a chain needs a row **and** a `prove.yml` case. | `chainSpec()` → null. `OK` (absent = absent) |
| C2 | `chains.ts:115` `DEFAULT_FORK_RPC_ENV='FORK_RPC'` | Legacy single-secret name for "no chain pinned". | `SILENT` — this is the fallback that makes an unpinned run possible |
| C3 | `chains.ts:118` `chainSpec()` | `CHAINS[id] ?? null`. | `OK` |
| C4 | `chains.ts:131` `rpcEnvFor()` | `chainSpec(id)?.rpc_env ?? DEFAULT_FORK_RPC_ENV` — an unknown chain silently yields the **legacy** secret name. Doc at `:124-130` says this is deliberate. | `SILENT` by design. Safe only because `prove.yml:126` re-refuses. |
| C5 | `chains.ts:137` `isMainnet()` | `chainSpec(id)?.mainnet === true`. | **`DEAD`** — see C36/C39. Imported only by `tests/chains.test.mjs:20`. |
| C6 | `chains.ts:149` `describeChain()` | Never-throwing one-liner for Telegram. | `OK` — prints `unknown chain <id>, using FORK_RPC` |
| C7 | `chains.ts:172` `parseChainToken()` | `chain:1` / `chain_id:8453` / `chain=1`. Requires the literal word `chain` + separator, whole-token digits. | `OK` — returns null |

> **C5 is the single most important line in this audit.** The registry's own notion of "is this chain real value" is not consulted by the two gates that decide whether money moves.

### 1.2 Authorization — `app/src/policy.ts` (10)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C8 | `policy.ts:615` `chainForBrief()` | The gate. Refuses a bare `0x…` target with no `chain_id`; refuses a `chain_id` not in `CHAINS` (`:639-646`). | `LOUD` — `chain_id 42161 is not a chain this bot can fork … known chain_id values are 1, 8453, 84532, 11155111, 31337` |
| C9 | `policy.ts:587` `forkableChainList()` | Builds that refusal list **from `CHAINS`** — correctly derived. | `OK` |
| C10 | `policy.ts:629` | Prose inside the malformed-id refusal hardcodes `(1, 8453, 84532, 11155111)`. | `SILENT` cosmetic — will under-report once a chain is added |
| C11 | `policy.ts:703` | `(chainAddresses[chain.chain_id] ??= []).push(t)` — **every** address in the brief is filed under the **single** resolved chain. | Blocks multi-chain (§3a) |
| C12 | `policy.ts:346-350` | `authorize()`: `roe.chain_addresses[a.chain_id]` then exact membership. Chain-correct. | `OK` |
| C13 | `policy.ts:417-424` | `allow_live_chain_writes` required for `chain_address` + mutate. | Chain-agnostic boolean — see C15 |
| C14 | `policy.ts:119-128` `fingerprint()` | Includes `chain_id`, so one approval cannot cover the same address on two chains. Good design. | `OK` |
| C15 | `policy.ts:482-101` `grantIsUsable()` | Validates `grant.chain_id` is an **integer** — never compares it to the RoE's chain. | `SILENT` — an RoE pinned to chain 1 accepts a grant for 84532 and sets `allow_live_chain_writes:true`. Contained only because `send.ts:586` re-checks `tx.chain_id !== grant.chain_id`. INFERRED latent risk for any future executor that trusts the flag. |
| C16 | `policy.ts:83` | `Action.chain_id: number` — **singular** per action. | Blocks multi-chain (§3a) |
| C17 | `policy.ts:48` | `RoE.chain_addresses: Record<number, string[]>` — the *shape* supports many chains; only C11/C16 prevent it. | Latent capability |

### 1.3 Plane gate — `app/src/planes.ts` (6)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C18 | `planes.ts:615` `PLANES` | Keyed by **`Cls`, not by chain**. 4 planes: `solidity→prove.yml`, `web2→prove-web.yml`, `infra→prove-infra.yml`, `solana→prove-solana.yml`. | Chain is invisible here — a plane is chosen by *class*, and every EVM chain shares `prove.yml` |
| C19 | `planes.ts:210` `buildSolidity()` | Emits `repo/commit/contract/fork_block/chain_id/address`. Chain-agnostic. | `OK` |
| C20 | `planes.ts:263-267` | `pinnedChain = brief.chain_id ?? parseChainToken(notes)`; carried as `String(pinnedChain)`. | `OK` |
| C21 | `planes.ts:594,597,606` | Harness sets: web2 `{web.jwt}` **only**, infra `{web.takeover}` **only**, solana `{sol.svm-signer}` **only**. EVM set inlined at `:621-632` (10). | Not chain-related, but it is the reason a new chain is low-yield (§5) |
| C22 | `planes.ts:707` `noPlaneReason()` | Refusal for a class with no plane. | `LOUD` |
| C23 | `planes.ts:725` `noHarnessReason()` | `the <plane> plane exists but has no harness for "<pb>"`. | `LOUD` |

### 1.4 Intake / class inference — `app/src/intake.ts` (4)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C24 | `intake.ts:83-87` `CLASS_WORDS` | `solidity: ['contract','solidity','vault','token','defi','protocol','evm','0x']`. No word for any other EVM chain, and none for Sui/Aptos/Cosmos/NEAR/Starknet/Bitcoin/TON. | `SILENT` — a Cosmos brief containing "contract" classifies as `solidity` |
| C25 | `intake.ts:130-131` | Shape shortcut: `0x…`→`solidity`, base58→`solana`. | `OK` for EVM, inert for other families |
| C26 | `intake.ts:203-206` | `chain_id` from `chain:` token only; never guessed. | `OK` |
| C27 | `intake.ts:262-280` `renderBrief()` | The **Authorize card**. Renders targets, class, mutability, time box, authorized-by, playbooks, stop condition. **No chain.** | **`SILENT` — the human authorizes an address without being told which chain.** See §5 fix 3. |

### 1.5 Dispatch — `app/src/dispatch.ts` (6)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C28 | `dispatch.ts:88-94` | `ProveInputs.chain_id?: string`. | `OK` |
| C29 | `dispatch.ts:153` | `chain_id: brief.chain_id ?? null` into the derivation. | `OK` |
| C30 | `dispatch.ts:164-169` `chainLine()` | Operator message; `not applicable (<plane> plane)` for non-EVM. | `OK` |
| C31 | `dispatch.ts:519-534` | `INSERT INTO hunts (id, program_id, repo, commit_sha, contract, fork_block, …)` — **no `chain_id` column**. | **`SILENT`** — a hunt row cannot answer "which chain". See C55. |
| C32 | `dispatch.ts:607-624` | Message formatting branches on `workflow === 'prove.yml'` / `'prove-solana.yml'` — workflow name used as a proxy for chain family. | `SILENT` — a 5th workflow falls to the generic branch |
| C33 | `dispatch.ts:39` | Imports only `DEFAULT_FORK_RPC_ENV, describeChain` from chains — **not** `isMainnet`, `rpcEnvFor`, `chainSpec`. | Confirms C5 is unused |

### 1.6 The money gates — duplicated allowlists (8) ← **the dangerous section**

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C34 | `send.ts:40-44` `DEFAULT_ALLOWED_CHAINS` | `[84532, 11155111, 31337]` — hand-written. | not derived from `CHAINS` |
| C35 | `send.ts:47-50` `MAINNET_CHAINS` | `[1, 8453]` — hand-written. | not derived from `CHAINS` |
| C36 | `send.ts:244-246` `isMainnet()` | Local `MAINNET_CHAINS.includes()`. Shadows `chains.ts:137`. | **`SILENT`** |
| C37 | `send.ts:594-602` | `allowed = DEFAULT_ALLOWED_CHAINS.includes(cid) \|\| isMainnet(cid)`; then the mainnet double-switch. | `LOUD`-ish: `chain_not_allowed`. **But the natural fix — appending the new id to `DEFAULT_ALLOWED_CHAINS` — silently disables the double-switch for a real-value chain.** |
| C38 | `drain.ts:198` `DRAIN_ALLOWED_CHAINS` | `[84532, 11155111, 31337]` — third hand-written copy. | not derived |
| C39 | `drain.ts:201` `DRAIN_MAINNET_CHAINS` | `[1, 8453]` — third hand-written copy. | **`SILENT`** |
| C40 | `drain.ts:538-540` `isMainnetChain()` | Local `.includes()`. Third shadow of `chains.ts:137`. | **`SILENT`** |
| C41 | `drain.ts:720-733` + `:821-827` | Mainnet double-switch; then `chain_not_allowed` if on neither list. | Same footgun as C37 |

> **Findings C34-C41 in one sentence:** there are **three** independent definitions of "mainnet chain" (`chains.ts:137`, `send.ts:47`, `drain.ts:201`) and **three** of "allowed chain". The one guarded by tests-and-intent (`chains.ts`) is read by nobody; the two that gate real value are hand-maintained and untested against the registry. `grep` for `isMainnet` proves it: `chains.ts:137` has exactly one consumer, `tests/chains.test.mjs:20`.

### 1.7 Proof generation — EVM (5) — *this part is genuinely chain-agnostic*

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C42 | `poc.ts:109` | `vm.createSelectFork(vm.envString("FORK_RPC"), <block>)` — no chain literal. | `OK` — works on any EVM chain Foundry can reach |
| C43 | `poc.ts:86-124` | Header emits `uint256 constant EXPECTED_CHAIN_ID` + `require(block.chainid == …)` inside `setUp`. | `OK` — strengthens with any chain |
| C44 | `plan.mjs:52-53` | `--chain-id` → `chainId` or null. | `OK` |
| C45 | `plan.mjs:239-240` | `fork_block`, `chain_id` into `plan.json`. | `OK` |
| C46 | `fuzzseed.ts:544` | Second `createSelectFork`. | `OK` |

### 1.8 Proof generation — SVM (5)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C47 | `solana.ts:193` `SOLANA_CLUSTERS` | 3 rows: `mainnet-beta`, `devnet`, `testnet` — **named string keys, not numeric ids**. Precedent that a second family needs a different key space. | `LOUD` via `clusterSpec` null |
| C48 | `solana.ts:221-227` | `SOLANA_CLUSTER_NAMES`, `DEFAULT_SOLANA_CLUSTER='devnet'`. | `OK` |
| C49 | `solana.ts:284` `parseSolanaToken()` | `cluster:` / `cluster_name:` / `solana:`. | `OK` |
| C50 | `planes.ts:462` `buildSolana()` | Requires `repo/commit/program/program_id/instruction`; refuses "a program id alone is not something this plane can build" (`:485`). | `LOUD` |
| C51 | `prove-solana.yml` inputs (lines 3-28) | `repo, commit, program, program_id, instruction, playbook, hunt_id`. **No cluster, no RPC, no chain_id input at all.** | **`SILENT`** — the cluster is never asserted; bankrun is state-free so nothing can be asserted |

### 1.9 Inventory / candidate layer (9)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C52 | `targets/chain-map.ts:58-67` `buildNameMap()` | Derives name→id **from `CHAINS`**. Correct design. | `OK` — adding a row makes its name resolvable |
| C53 | `targets/chain-map.ts:82-90` `ALIASES` | 7 hand-written aliases (`base-sepolia`, `eth-sepolia`, …). | **`SILENT`** — see §2 silent-failure #2: if a new row's `name` is not the exact string the feed emits, every record for that chain is dropped with **no error** |
| C54 | `targets/chain-map.ts:102` `SVM_NAMES` | `solana`, `mainnet-beta`. | `OK` |
| C55 | `targets/chain-map.ts:124-146` | `resolveChainName` / `resolveChainId` → `{evm\|svm\|unregistered\|not-a-chain\|ambiguous\|absent}`. | `OK` — unknown becomes `unregistered`, counted by name |
| C56 | `targets/types.ts:32` | `AddressFamily = 'evm' \| 'svm'` — **closed union**. | Every new family edits this |
| C57 | `targets/types.ts:85,97,100` | Discriminated union; `svm` carries `chain_id: null` + `cluster: 'mainnet-beta'`. | `OK`, good precedent for "no invented ids" |
| C58 | `targets/types.ts:122` | `candidateKey` → `evm:<chain>:<addr>` / `svm:<cluster>:<addr>`. | Chain-correct |
| C59 | `targets/sources.ts:102,204` | `parseDefiLlama` / `parseTokenList`; drop counters `dropped_by_chain_name`, `dropped_no_chain`. | `OK` — honest accounting |
| C60 | `targets/testnet.ts:52-63` | `emptyTestnetResult()` derives testnets from `CHAINS.mainnet`. | `OK` — *the* model to copy for C34/C35/C38/C39 |

### 1.10 Persistence — `app/schema.sql` (5)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C61 | `schema.sql:52` | `candidates.chain_id INTEGER` — "NULL only for family='svm'; never invented". | `OK` |
| C62 | `schema.sql:78` | `idx_cand_chain ON candidates(chain_id, address)`. | `OK` |
| C63 | `schema.sql:152` | `assets.chain_id INTEGER`. | `OK` |
| C64 | `schema.sql:314` | `watchlist.chain_id INTEGER NOT NULL` + `UNIQUE(chain_id,address)`. | `OK` |
| C65 | `schema.sql:363` (hunts block) | `hunts` columns: `repo, commit_sha, contract, fork_block, stage, …`. **No `chain_id`.** Verified: `grep -c chain_id` over the `hunts` DDL returns **0**. | **`SILENT`** — see C31 |

### 1.11 Workflows (7)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C66 | `prove.yml:39-44` | `chain_id` input; description enumerates `1, 8453, 84532, 11155111 or 31337`. | `LOUD` downstream |
| C67 | `prove.yml:91-99` | 6 literal secret bindings: `RPC_1, RPC_8453, RPC_84532, RPC_11155111, RPC_31337, RPC_LEGACY`. Comment `:80-90` explains GitHub Actions cannot index `secrets` dynamically. | Must be edited per chain |
| C68 | `prove.yml:119-130` | `case "$CHAIN_ID"` with 5 literal arms; `*)` → `::error::chain_id '…' is not a chain this workflow can fork` **and** `exit 1`. | **`LOUD`** ✅ |
| C69 | `prove.yml:133-138` | Empty secret → `::error::$SECRET is not set … Add the Actions secret $SECRET`. | **`LOUD`** ✅ names the secret |
| C70 | `prove.yml:177-204` | `cast chain-id --rpc-url "$FORK_RPC"`; mismatch → `WRONG CHAIN` + `exit 1`. Refuses to fork. | **`LOUD`** ✅ excellent |
| C71 | `prove.yml:186-190` | If `RESOLVED_CHAIN_ID` empty → `::warning::… skipping the chain assertion… must not be read as a reproduction` + `exit 0`. | **`SILENT`** — a warning does not stop the verdict being recorded |
| C72 | `prove.yml:354,392,433,460` | 4 steps consume `env.FORK_RPC` (pinned by test at `tests/chain-pinning.test.mjs:424`). | `OK` |

`prove-web.yml` / `prove-infra.yml`: **zero** chain references (verified by grep) — correct, they have no chain.
`prove-solana.yml`: **zero** `chain_id`/`cluster` reference (see C51).
`contract-audit.yml`: only `foundry-toolchain` — no chain coupling.

### 1.12 Config, UI, report (7)

| # | Location | What it does today | Unknown chain |
|---|---|---|---|
| C73 | `wrangler.toml:45` | `CHAIN_ID = "8453"` — a **static var**, one chain, for the whole Worker. | `SILENT` — the sentinel is permanently Base |
| C74 | `sentinel.ts:19` | `CHAIN_ID?: string` declared in Env. **Never read** (grep: only decl). | `DEAD` |
| C75 | `sentinel.ts:48` | `env.RPC_URL ?? 'https://mainnet.base.org'` — hardcoded Base mainnet default. | `SILENT` |
| C76 | `ui/ui.js:2050-2054` | `briefCard` renders targets/class/mutability/time-box/authorized-by. **No chain.** Mirrors C27. | **`SILENT`** |
| C77 | `report.ts:135,218,628,935-938` | Renders a `| Chain |` column from `asset.chain_id`; `—` when null. | `OK` |
| C78 | `cvss.ts:267` | `chain_address → 'network'` attack vector. | `OK` |
| C79 | `targets/index.ts:12` | Doc enumerates `(1, 8453, 84532, 11155111, 31337)`. | cosmetic |

**Total: 79 locations, 24 files** (`chains.ts, policy.ts, planes.ts, intake.ts, dispatch.ts, send.ts, drain.ts, poc.ts, plan.mjs, fuzzseed.ts, solana.ts, playbookss.ts, schema.sql, wrangler.toml, targets/{chain-map,types,sources,testnet,index}.ts, ui/ui.js, report.ts, cvss.ts, prove.yml, prove-solana.yml`).
Plus **28 of 48 test files** reference chain and would need review.

### 1.13 Files that are correctly chain-free (worth stating for contrast)

`prove-web.yml`, `prove-infra.yml`, `contract-audit.yml`, `judge.mjs`, `learn.ts`, `corpus.ts`, `scope-monitor.ts`, `methodology-dispatch.ts`, `proof.ts`, `hunt.ts` (only an opts field). **`proof.ts` has zero chain references** — the verdict layer is chain-blind, which is why C31/C65 matter.

---

## 2. Exact procedure: add one EVM chain

Two worked examples. **Arbitrum One = 42161** (real value, mainstream). **Ticko = 84256** (testnet, niche).

### 2.1 Mandatory change set (6 edits + 1 secret, 4 files)

| Step | File:line | Arbitrum (42161) | Ticko (84256) | Failure if omitted |
|---|---|---|---|---|
| **1** | `app/src/chains.ts:64-107` | add row `42161: { id:42161, name:'Arbitrum', rpc_env:'FORK_RPC_42161', explorer:'arbiscan.io', native:'ETH', mainnet:true }` | `84256: { id:84256, name:'Ticko', rpc_env:'FORK_RPC_84256', explorer:'', native:'ETH', mainnet:false }` | **LOUD** — `policy.ts:639` refuses `chain_id … is not a chain this bot can fork` |
| **2** | `.github/workflows/prove.yml:94-98` | add `RPC_42161: ${{ secrets.FORK_RPC_42161 }}` | add `RPC_84256: ${{ secrets.FORK_RPC_84256 }}` | **LOUD** — arm reads `${RPC_42161:-}` → empty → C69 `::error::$SECRET is not set`. *(Test `chain-pinning.test.mjs:402-407` also fails: "must bind FORK_RPC_<id> to a local variable")* |
| **3** | `.github/workflows/prove.yml:120-124` | add `42161) RPC="${RPC_42161:-}" ; SECRET=FORK_RPC_42161 ;;` | `84256) …` | **LOUD** — `*)` arm → `exit 1`. *(Test `:408` requires a literal `<id>)` arm)* |
| **4** | GitHub Actions **secret** `FORK_RPC_42161` | an **archive** RPC (see §3b) | any testnet RPC | **LOUD** — C69 |
| **5** | `app/src/send.ts:40-52` | **decide**: `42161` must go in `MAINNET_CHAINS` (C35), **not** `DEFAULT_ALLOWED_CHAINS` (C34) | `84256` → `DEFAULT_ALLOWED_CHAINS` | **`SILENT` / dangerous** — see below |
| **6** | `app/src/drain.ts:198-201` | `42161` → `DRAIN_MAINNET_CHAINS` (C39), **not** `DRAIN_ALLOWED_CHAINS` (C38) | `84256` → `DRAIN_ALLOWED_CHAINS` | **`SILENT` / dangerous** — see below |

### 2.2 Conditional (breaks silently if skipped)

| Step | File:line | Why | Failure |
|---|---|---|---|
| **7** | `app/src/targets/chain-map.ts:82-90` | `NAME_TO_ID` is derived from `spec.name` (`:58-67`), so `spec.name` **must equal the feed's spelling**. DeFiLlama emits `arbitrum`, not `Arbitrum One`. | **`SILENT`** — 249 Arbitrum records silently become `unregistered` and are dropped, counted only in a counter nobody reads. This is the difference between "the bot now hunts Arbitrum" and "the bot still finds zero Arbitrum targets". |
| **8** | `app/src/targets/chain-map.ts:43` `AMBIGUOUS` | if the new name collides with a generic word | `SILENT` |
| **9** | `app/tests/chains.test.mjs:77` | `for (const spec of Object.values(CHAINS)) assert.equal(spec.native, 'ETH')` | **LOUD** — this test *fails* for BSC (`BNB`) or Polygon (`POL`). Blocks the cheap fix; must be relaxed to a per-chain expectation. |

### 2.3 Auto-derived / auto-guarded (no change needed) ✅

- `targets/testnet.ts:52` — testnet list re-derives from `CHAINS.mainnet`.
- `targets/chain-map.ts:58` — name map re-derives.
- `policy.ts:587` `forkableChainList` — refusal text re-derives.
- `tests/chain-pinning.test.mjs:399-408` — **walks `CHAINS`** and asserts each id has a literal `secrets.FORK_RPC_<id>`, an `RPC_<id>:` binding, an `<id>)` case arm, **and** `SECRET=FORK_RPC_<id>` (`:439-444`). **This is the single best guard in the codebase** — it makes steps 2-3 loud at `npm test` time rather than at dispatch time.

### 2.4 Count and loud/silent verdict

> **Per chain: 6 mandatory edit-sites across 4 files + 1 live secret. 2 conditional sites.**

| Class | Count | Which |
|---|---|---|
| **LOUD** (refuses, names the problem) | 5 | steps 1, 2, 3, 4, 9 |
| **SILENT — benign-ish** (wasted run, no wrong claim) | 1 | C71 unpinned-run warning |
| **SILENT — dangerous** | **3** | **step 5, step 6, step 7** |

### 2.5 The silent failures, stated explicitly

**S-1 (money).** Adding `42161` to `chains.ts` with `mainnet:true` does **not** make `send.ts`/`drain.ts` treat it as mainnet. Their lists are independent (`send.ts:47`, `drain.ts:201`). Result: `42161` is on neither `DEFAULT_ALLOWED_CHAINS` nor `MAINNET_CHAINS` → `chain_not_allowed` refusal (`send.ts:597`, `drain.ts:823`).
That is *safe* but wrong-looking. **The trap is the fix**: the obviously-named list is `DEFAULT_ALLOWED_CHAINS` ("chains the relay will broadcast on without mainnet confirmation", `send.ts:39`). Appending `42161` there — the minimal edit to make the error go away — **permanently disables the `allow_mainnet` + `confirm_mainnet` double switch for a chain where a mistake costs real money**, and nothing in the test suite would notice (`tests/send.test.mjs:267,365` only assert membership *includes*, never that a real-value chain is *absent*). Same shape at `drain.ts:198` / `tests/drain.test.mjs:490-497`.
**Root cause:** `chains.ts:137 isMainnet` exists, is documented as "True only for chains where a proof touches real value", and is imported by zero production modules. The registry is not the source of truth for the one fact that decides whether money moves.

**S-2 (inventory).** `chain-map.ts:58` derives names from `CHAINS`, so a row named `'Arbitrum One'` resolves only that exact spelling; feeds emit `arbitrum`. 249 targets vanish with no error, no warning, and no test (`chain-map` has no test asserting feed vocabulary against `CHAINS`). The failure is invisible precisely because `sources.ts` *correctly* reports it as `dropped_by_chain_name` — an honest counter that nothing alerts on.

**S-3 (provenance).** `hunts` has no `chain_id` (`schema.sql:363` block; `dispatch.ts:519`). After a run you cannot query which chain it forked. `report.ts:935` can render a chain from the *asset*, not from the hunt. Combined with C71 (unpinned runs continue on a warning), two runs on different chains are indistinguishable rows at the same `fork_block`.

**S-4 (fork_block).** `planes.ts:256` takes `fork_block` from operator notes, default `'0'`; `plan.mjs:232` substitutes `1`. Nothing validates that the block exists on the pinned chain. A block height taken from an Ethereum PoC applied to an Arbitrum run forks far-future-or-absent Arbitrum state. `poc.ts:109` passes it straight to `createSelectFork`. Outcome: `setUp` revert (loud) or a delta against unrelated state (**silent**) — exactly the class `chains.ts:15-19` says it was written to eliminate, still open on the *other* axis.

**S-5 (native/explorer are dead).** `chains.ts:43 explorer` and `:45 native` are populated and never read (`grep '\\.explorer'` → zero consumers outside chains.ts). So the registry *implies* generality it does not have: a new chain "looks" fully described, but no explorer link is ever generated and `drain.ts:833 asset:'native'` treats every native balance as 18-decimal wei (INFERRED: wrong for a chain whose native token is not 18dp).

---

## 3. What "any chain" would actually require

### (a) One engagement spanning multiple chains — **blocked structurally, 2 lines**

The storage shape already allows it: `RoE.chain_addresses: Record<number, string[]>` (`policy.ts:48`).
What prevents it:
- `chainForBrief` (`policy.ts:615`) returns **one** `chain_id`; `BriefChain` is `{chain_id: number|null}` (`policy.ts:582`).
- `roeFromBrief:696-703` files **every** `0x…` target under that single id.
- `Action.chain_id` (`policy.ts:83`) is singular, and `fingerprint` (`policy.ts:119`) hashes one chain — so approval identity is per-chain, which is *correct* but means N chains = N approvals.

**Required:** `chainForBrief` → per-target resolution `{target, chain_id}[]`; `RoEBriefInput.chain_id` → `Record<addr,chain_id>` or a `chain:` token per target line; `ProveInputs.chain_id` (`dispatch.ts:94`) → one dispatch per chain (Foundry forks one RPC per process); `hunts` gains `chain_id` so the fan-out is reconstructable.
**Effort: MEDIUM.** The gates (`policy.ts:346`) already index by chain correctly, and `candidateKey` (`types.ts:122`) is already chain-qualified — the *inventory* layer is multi-chain-ready; only authorization and dispatch are singular.

### (b) A chain whose RPC you do not control — **the practical blocker**

Today: `prove.yml:194` runs `cast chain-id` and `:199` refuses a mismatch. That is identity, not *capability*.
Unaddressed: **archive availability**. `vm.createSelectFork(url, fork_block)` (`poc.ts:109`) needs historical state at that block. Infra RPCs on small/new chains are almost universally **pruned**. There is no check for archive depth, no eth_getProof/`debug_` probe, no documented archive requirement, and no timeout/retry/rate-limit handling (`prove.yml` has no retry around the RPC). A pruned RPC yields a `setUp` revert — which the judge reads as an inconclusive/failing PoC, i.e. **infrastructure failure indistinguishable from "the bug is not there"** — the exact failure mode `prove-solana.yml:6-16` rejected `--clone` for.
**Required:** an `archive: true` capability probe in `prove.yml` before forking; a documented minimum (or an explicit "fork_block must be recent" policy); preferably a chain-agnostic `eth_getCode`/`eth_getStorageAt` pre-flight at the pinned block, failing with a *distinct* verdict rather than a revert.
**Effort: SMALL config, HIGH value.** This is the single highest-leverage unglamorous fix.

### (c) An L2 whose state depends on L1 — **no awareness exists at all**

`grep -i 'l1|l2|blob|arbitrum|optimism|zksync|era'` over `app/src` returns **only** false positives (`JSON.stringify` blobs, GitHub `blob/` URLs, the literal `era` in a drop table). There is no concept of a rollup, a sequencer, an L1 message, or a settled-vs-unsafe head.
Consequence: `vm.createSelectFork` on the L2 RPC gives you L2 state only. Anything that reads L1 — bridge finalisation, L1→L2 message inclusion, blob/data-availability assumptions, L1-priced gas — is unprovable and, worse, *appears* provable because the fork succeeds. Arbitrum's ArbOS precompiles are partially emulated by Foundry; zkSync needs a different toolchain entirely (`foundry-zksync` docs: `zks_getBaseTokenL1Address` is used to detect a zkSync endpoint, `--zksync`/`zkVm` switches context — standard `forge` is not equivalent).
**Required:** an `l1_rpc` second fork (`vm.createFork` on two URLs) plus per-family precompile/deploy knowledge. **Effort: LARGE.** INFERRED: for most L2 bounty work the L2-only fork is sufficient, so this is a *known limitation to document*, not a blocker.

### (d) A chain with no Foundry support — **the harness generator is void**

`poc.ts` is 868 lines producing 10 Solidity harnesses; `plan.mjs` scans Solidity leads; `prove.yml` installs `foundry-toolchain` and runs `forge test` (`:377,410`). None of that has an analogue.
What does transfer: the *shape* — `prove-solana.yml` proves a second family is possible. What it cost: `solana.ts` 453 lines, `plane-harness.ts` 483, `plane-run.mjs` 248, `plane-patch.ts` 172, `prove-solana.yml` 9.7 KB, plus a new `Cls` value and a `PLANES` row.
**Effort: LARGE per family.** See §4.

---

## 4. Non-EVM family gap

The abstraction that must be satisfied is a 4-tuple (`planes.ts:87-102`): **(workflow file, input builder, harness set, `Cls`)**. `Cls` is a **closed** union at `playbooks.ts:21`: `'web2' | 'solidity' | 'infra' | 'solana' | 'mobile'`. Every new family edits that union, `PLANES`, and `AddressFamily` (`targets/types.ts:32`).

The load-bearing question is **state cloning**, and Solana shows why: `prove-solana.yml:6-16` explicitly rejects `solana-test-validator --clone` (needs a live RPC per account → rate limits → `inconclusive` indistinguishable from "no bug") in favour of in-process **bankrun**: "no validator, no RPC, no accounts to clone". That is why it works, and also why only `sol.svm-signer` (`planes.ts:606`) has a harness — a signer check needs **no state**. The plane proves code it just deployed from source; it cannot prove against mainnet state.

| Family | Toolchain | State cloning / fork | Account model | Does `plane→workflow→harness→inputs` fit? |
|---|---|---|---|---|
| **Solana (SVM)** ✅ built | `rustup` + `cargo-build-sbf --arch v0` (`prove-solana.yml:100-147`); pin is load-bearing (`:22-31`) | `solana-bankrun@0.4.0` + `anchor-bankrun`, in-process, **no fork** (`:123-133`) | accounts + PDAs; `owner`/`executable`; named clusters | **Fits, with a caveat.** Same shape. But it is a *deploy-and-drive* plane, not a fork plane — it cannot reach real mainnet state. 1 of 3 sol harnesses implemented. |
| **Sui** | `sui move build`/`test`; Move | No fork. `sui start --with-faucet` localnet + object snapshots; object versioning. Would need explicit object-graph fixtures. | object-centric (owned/shared/immutable), no `msg.sender`; `TxContext` | **Fits shape** (new `Cls: 'sui'`, new workflow, new harness set). Effort ≈ Solana. No numeric chain id — needs the `solana.ts` `cluster`-style key space. |
| **Aptos** | `aptos move compile/test`; Move | localnet; same object/resource model; no mainnet fork | resource accounts, `signer` | **Fits shape.** Similar cost to Sui. |
| **Cosmos-SDK** | Go modules; `simapp` / `gaiad testnet` | `simapp` in-process is bankrun-like ✅ | **`chain_id` is a STRING** (`cosmoshub-4`) | **Shape changes.** `chain_id: number` is threaded through `policy.ts:83`, `schema.sql:52,152,314`, `ProveInputs.chain_id` (`dispatch.ts:94`) as a **number**. A string chain-id breaks the type at every layer. `AddressFamily` needs a 3rd arm + bech32 HRP handling. **Largest type-level cost of any family.** |
| **NEAR** | `cargo` → WASM; `near-workspaces-rs` sandbox in-process ✅ | in-process sandbox, **closest analogue to bankrun** | named accounts (`alice.near`), not addresses | **Fits shape**; lowest-friction *next* family after Solana, because the executor is in-process with no fork. Rust, so `plane-patch` logic is reusable. |
| **Starknet** | Cairo; `snforge` (Foundry-like) + `starknet-devnet` | **`snforge` supports forking** — closest to the EVM model of any non-EVM family | contract accounts (account abstraction native) | **Fits shape AND fits the fork model** — the best-value second real plane if a forking proof is the goal. Needs `scarb` toolchain. |
| **Bitcoin** | `bitcoind -regtest` | regtest; UTXO set; no arbitrary state clone | UTXO, scripts (no EVM-like contract state) | **Does not fit.** None of the 10 EVM playbook semantics (`sol.reentrancy`, …) or the 3 SVM ones map. Needs a *new* playbook class before any plane is meaningful. |
| **TON** | FunC/Tolk; `ton-contract-executor` / sandbox | in-process executor ✅ | actor/message-passing; addresses are `workchain:hash` | **Fits shape**, async message model changes harness structure (each step is a message, not a call). Medium-large. |

**Verdict:** the plane abstraction *does* generalise — it is a clean 4-tuple and Solana proves a second family is reachable. What does **not** generalise is (i) `chain_id: number` (Cosmos), (ii) `AddressFamily` (`types.ts:32`), and (iii) the assumption that a proof is a **fork** of existing state. Three families (Cosmos, Bitcoin, and multi-chain L2) need genuine model changes, not new rows.

**The honest summary:** each non-EVM family is a Solana-sized project (~1,400 lines across 5 new files + a workflow). The current codebase has delivered **one**, with **one** working harness.

---

## 5. Ranked fix list

Ordered by *real bounty-hunting impact per unit of effort*. "Small config" = ≤1 day. "Architecture" = weeks.

| # | Fix | Impact | Effort | Class |
|---|---|---|---|---|
| **1** | **Unify mainnet classification: make `send.ts`/`drain.ts` import `chains.ts:137 isMainnet`; delete `send.ts:47`, `drain.ts:201`, `send.ts:244`, `drain.ts:538`; add a test asserting *no real-value chain* is on an "allowed without confirm" list.** | **Prevents a fund-safety regression.** Must land *before* #2 or #2 is a live-money footgun. | **Small config** (~2h) | **Do first** |
| **2** | Add the top dropped EVM chains — `bsc` 511, `arbitrum` 249, `avax` 180, `polygon` 140 (repo's own count, `targets/README.md:103-118`; **1,380 targets in the top 6**). 6 edit-sites each (§2.1), and `chain-map.ts:82` names must match feed spelling. | **Highest raw yield available.** Unlocks 1,380 inventory targets, all 10 EVM harnesses immediately. | **Small config** (~1–2d incl. secrets) | Config |
| **3** | **Show the chain on the Authorize card** — `intake.ts:262-280` `renderBrief` + `ui/ui.js:2050-2054` `briefCard`. One line each: `<b>chain</b> ${describeChain(b.chain_id)}`. | **High integrity value at near-zero cost.** Today the operator approves an address without being told the chain — the precise blindness `chains.ts:1-30` exists to remove. `describeChain` (`chains.ts:149`) already never throws. | **Small config** (~1h) | Config |
| **4** | **Archive-RPC pre-flight in `prove.yml`** before the fork: probe `eth_getCode`/`eth_getStorageAt` at `fork_block` and fail with a distinct verdict. Document the archive requirement; add a retry/timeout around the RPC. | **Converts the most common arbitrary-chain outcome ("revert in setUp" ≈ inconclusive) into an actionable error.** Needed for every chain outside the big-4 infra providers. | **Small config** (~1d) | Config |
| **5** | Add `hunts.chain_id` (`schema.sql:363` block + `dispatch.ts:519` INSERT); backfill from brief JSON; stop relying on `fork_block` alone for provenance. | Makes runs auditable per chain; required for any multi-chain work (#7) and for #4's diagnostics. | **Small config** (~2h) | Config |
| **6** | Kill the remaining silent hole at `prove.yml:186-190`: an unpinned run currently continues on a `::warning`. Gate the verdict — either refuse, or tag the run `unpinned` in `hunts.stage`/`stopped_because`. | Closes the last "delta against an unknown chain got recorded" path. | **Small config** (~2h) | Config |
| **7** | Validate `fork_block` against the pinned chain (plausibility vs. current head; refuse a block ahead of head). | Closes C71-adjacent drift (S-4). Cheap once #4 exists. | **Small config** (~half day) | Config |
| **8** | Derive `chain-map.ts:82 ALIASES` / assert feed vocabulary against `CHAINS` in a test; relax `chains.test.mjs:77` (`native === 'ETH'`) to a per-chain table. | Removes silent-drop failure S-2 and unblocks non-ETH chains (BSC/Polygon) that #2 targets. | **Small config** (~half day) | Config |
| **9** | **Per-target chain in the RoE** — `chainForBrief` returns `{target, chain_id}[]`; `Action.chain_id` optional; one dispatch per chain; `RoE.chain_addresses` already supports it (`policy.ts:48`). | Enables **multi-chain engagements (§3a)** — the actual "hunt this protocol everywhere" use case. Gates already index correctly. | **Architecture** (~1–2w) | Architecture |
| **10** | **Second non-EVM plane.** Prefer **Starknet** (`snforge` can fork → reuses the EVM execution model) or **NEAR** (`near-workspaces` in-process → reuses the bankrun model). Requires new `Cls` (`playbooks.ts:21`), `PLANES` row, `AddressFamily` arm, workflow, harness set, ≥1 harness. | Genuine new family coverage. | **Architecture** (~2–4w per family) | Architecture |
| **11** | L2/L1 dual-fork awareness (`vm.createFork` on two RPCs; per-family precompile knowledge). | Only pays off for cross-domain bugs; L2-only forks cover most L2 work today. | **Architecture** (~2–3w) | Architecture |
| **12** | Cosmos-SDK support — requires `chain_id: number → string` refactor across `policy.ts:83`, `schema.sql:52,152,314`, `dispatch.ts:94`. | Broad ecosystem, but the type change is invasive and touches every gate. | **Architecture** (~3w+, high risk) | Architecture |

### 5.1 The two things to say plainly

- **Fixes 1–8 are all "small config" totalling roughly one week, and they unlock ~1,380 targets plus the money-gate correctness.** The repo already knows this: `targets/README.md:120-122` says adding one chain + its `FORK_RPC_<id>` case "is the single highest-yield change available to this module", and `:271` records it as "Owner decision" — not done. This audit's addition is that doing it *without* fix #1 introduces a real-money regression.
- **Adding chain #6 does not add a 6th hunting capability — it adds a fork with the same 10 EVM harnesses.** The harness set is per-class, not per-chain (`planes.ts:594-632`). The marginal value of a new EVM chain is *inventory breadth* (more targets), not *class depth* (new bug types). Anyone expecting "hunt like any other AI tool on any chain" from chain rows alone will be disappointed; §4 is where that expectation actually lives, at ~2-4 weeks per family.

---

## 6. Scope, method and gaps

**Observed (verified by reading the cited lines):** all 79 locations; the `CHAINS`↔`prove.yml` mirror and the *absence* of any mirror test for `send.ts`/`drain.ts`; the `hunts` schema lacking `chain_id`; `isMainnet` having exactly one consumer (a test); `prove.yaml:186-190`'s warn-and-continue; `prove-solana.yml` having no cluster/chain input; zero L1/L2 awareness in `app/src`.

**INFERRED (stated as such in-line):** the archive-RPC failure mode for arbitrary chains (§3b) — no run was performed; L2/L1 unprovability (§3c); 18-decimal native assumption (S-5); the `send.ts:594` footgun's real-world exploitation (the code path is read, not executed); effort estimates (engineering judgement, not measured).

**Not done / gaps:** no test suite was executed (`npm test` would be a mutation-free but expensive run and was out of the audit-only ask — note it *is* run in CI at `.github/workflows/deploy.yml:46` and `land.yml:377`); no RPC was contacted; `app/build/*.js` treated as derived, not audited separately; `app/eval/*` (Python, 180,907-row corpus) not examined for chain coupling; the sibling trees (`repo/`, `w1..w9`, `verify*/`) were ignored per assignment.

**Reproduction commands** (read-only, for the next run):

```bash
cd .../wbot
grep -rn "8453\|84532\|11155111\|31337" app/src/ --include=*.ts | grep -v node_modules   # hardcoded ids
grep -rn "isMainnet" app/src/ app/tests/                                                 # proves C5 is dead
grep -n "FORK_RPC\|case \|chain_id" .github/workflows/prove.yml                          # the 4th mirror
awk '/CREATE TABLE IF NOT EXISTS hunts/,/\);/' app/schema.sql | grep -c chain_id          # 0
grep -rn -i "l1\|l2\|blob\|zksync" app/src/ --include=*.ts | grep -v node_modules         # no L2 model
```
