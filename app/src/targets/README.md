# `app/src/targets/` — public inventory → chain-tagged candidates

**Library module only.** Nothing here writes to D1, calls Telegram, or is wired
into a route or a cron trigger. It answers one question — *what contracts exist on
the chains this bot can fork, and which chain is each one on?* — and returns data.
Wiring it in is a separate, reviewable change.

Measurements below were taken **2026-10-29** by running the shipped parser
(`build/targets/sources.js`) over raw responses captured from the live feeds. The
harness is `workstreams/a8cb712c-…/measure.mjs` and its full output is
`targets-coverage.json`; nothing in this note is estimated.

---

## The invariant

```ts
type Candidate = EvmCandidate | SvmCandidate;

interface EvmCandidate { family: 'evm'; chain_id: number;  address: string; … }
interface SvmCandidate { family: 'svm'; chain_id: null;    address: string;
                         cluster: 'mainnet-beta'; … }
```

`chain_id` on an EVM candidate is **always** a key of `CHAINS` (1, 8453, 84532,
11155111, 31337), resolved through that registry. Anything naming a chain outside
it is dropped and counted by name — never emitted with a stray id.

This matters because `policy.ts:roeFromBrief` **refuses** a bare `0x…` target that
names no chain ("an address does not identify its chain"), and every downstream
gate reasons about `chain_id`. A candidate whose chain is missing or guessed is
not a weak target, it is an unusable one.

### Why Solana's `chain_id` is `null` and not a number

Solana has no EVM chain id and is **not** a row in `CHAINS`. Two rules collide:
a candidate without a resolved chain id is unusable, and inventing a chain id is
forbidden. Resolving it:

* the discriminant `family` is **required** and every consumer must narrow on it;
* on the SVM variant `chain_id` is typed `null`, so `candidate.chain_id` is
  `number | null` for anyone holding a `Candidate` and TypeScript forces the call
  site to handle "not forkable by id";
* the cluster is carried explicitly as `'mainnet-beta'`.

A Solana candidate is representable and can never be mistaken for chain 0 or 8453.

---

## Yield per chain

3 sources, **13 429 records examined → 9 451 unique candidates**.

| Chain | id | Candidates | From DeFiLlama | From token lists |
|---|---|---:|---:|---:|
| Ethereum | `1` | **6 255** | 479 | 6 071 (uniswap list) |
| Base | `8453` | **3 015** | 216 | 2 938 (base list) |
| Solana (`family: 'svm'`) | *null* | **181** | 248 → 181 after dedupe | — |
| Anvil | `31337` | **0** | — | — |
| Base Sepolia | `84532` | **0** | — | — |
| Ethereum Sepolia | `11155111` | **0** | — | — |
| **Total** | | **9 451** | 943 | 9 009 |

EVM 9 270 · SVM 181.

Per source, before dedupe:

| Source | URL | Records | Candidates | Dropped: no chain | Dropped: malformed |
|---|---|---:|---:|---:|---:|
| defillama | `api.llama.fi/protocols` | 4 420 | 943 | 624 | 3 |
| coingecko-base | `tokens.coingecko.com/base/all.json` | 2 938 | 2 938 | 0 | 0 |
| coingecko-uniswap | `tokens.coingecko.com/uniswap/all.json` | 6 071 | 6 071 | 0 | 0 |

DeFiLlama's *without address* count is 4 454 — entries like `Binance CEX` that are
a brand, not a contract. They are excluded from `records_seen` rather than counted
as drops, because they were never addressable targets.

### Reconciliation

Every record lands in exactly one bucket, and the identity is verified end-to-end:

```
records_seen === emitted + duplicates + Σ(dropped by chain name) + no_chain + malformed
13 429       === 9 451   + 501        + 2 850                    + 624      + 3      ✓
```

It holds per source too (4 420 / 2 938 / 6 071 each balance exactly). Without this
check a feed shape change and an empty feed both present as an empty candidate
list — "no targets" reading as "no targets exist".

Duplicates, 501 total: **172 within-feed** (DeFiLlama 170, each token list 1) and
**329 cross-feed** (94 Base, 235 Ethereum). 329 candidates are corroborated by two
independent feeds; each carries the other's id in `also_in`.

---

## Drops by chain name

**2 850 records dropped across 240 distinct chain names**, every one a chain this
bot cannot fork. Nothing is dropped for being boring; it is dropped for naming a
chain with no `FORK_RPC_<id>` secret.

| # | Name as the source spelled it | Dropped |
|---|---|---:|
| 1 | `bsc` | 511 |
| 2 | `arbitrum` | 249 |
| 3 | `avax` | 180 |
| 4 | `fantom` | 174 |
| 5 | `polygon` | 140 |
| 6 | `robinhood` | 126 |
| 7 | `cronos` | 79 |
| 8 | `sui` | 58 |
| 9 | `hyperliquid` | 48 |
| 10 | `pulse` | 43 |

Also notable: `era` 42, `blast` 34, `optimism` 31, `linea` 17, `scroll` 17,
`moonbeam` 16, `binance` 13 (bare addresses whose entry field said `Binance`
where the prefix would have said `bsc`), `celo` 13, `eth` 5, `gnosis` 1.

The top-6 alone is 1 380 dropped targets. **Adding one chain to `CHAINS` — plus its
`FORK_RPC_<id>` case in `prove.yml` — is the single highest-yield change available
to this module.** That is a recommendation, not something implemented here: it
touches a shared registry.

### Names deliberately *not* aliased

| Name | Why it is dropped rather than mapped |
|---|---|
| `eth` (5) | Distinct from `ethereum:`. One of the five (`Orbit Bridge`) does not list Ethereum in its own `chains` array, so the prefix is not trustworthy field-for-field. Mapping it to chain 1 would be a guess on 5 records. |
| `binance` (13) | BNB Chain. Not `bsc` the prefix, and not a registry chain either way. |
| bare `sepolia` | Ambiguous between 84532 and 11155111, which are different chains that can hold colliding addresses. The qualified forms (`Base Sepolia`, `Ethereum Sepolia`) *do* resolve. No current source emits the bare form, so refusing it costs nothing and removes a class of misfiling. |

---

## Two hard constraints, and how each is actually handled

### 1. Address families differ

| Family | Grammar | Validator |
|---|---|---|
| `evm` | `/^0x[0-9a-fA-F]{40}$/` | `isEvmAddress` |
| `svm` | base58, 32 bytes, 32–44 chars, no `0x` | `isSvmAddress` → reuses `solana.ts`'s `isSolanaPubkey` |

The SVM check **delegates to the existing base58 decoder** rather than restating
it. That decoder exists because a 44-character run of `l` has the right *length*
and decodes to nothing; a length check here would reintroduce exactly that bug
one level down. The two grammars are provably disjoint (`0` is not in the base58
alphabet) and a test asserts no string passes both.

The family is decided by the address, **not** by the chain label beside it. Real
consequence: DeFiLlama publishes `solana:token/EdAh…` for *Fabric* — a Solana
label over a non-pubkey body. That record is counted `malformed`, not emitted as
a Solana target.

Dedupe keys are family-specific on purpose:

```
evm:8453:0x3f5bf3ed…    ← lowercased; one contract must not become two targets
svm:mainnet-beta:CLoUDKc4…  ← case PRESERVED; base58 is case-sensitive, so
                              lowercasing would merge two distinct accounts
```

### 2. Testnet has no source — this is a finding

`emptyTestnetResult()` returns an **empty** candidate list, the chain ids it
covers (`[31337, 84532, 11155111]`, derived from `CHAINS.mainnet === false`), and
a reason. Observed, not assumed:

* `api.llama.fi/protocols` — 8 874 entries, 414 distinct `chain` values, 520
  distinct names across every `chains` array — contains **zero** Sepolia or
  testnet-L2 deployments. The only testnet-adjacent name anywhere in it is
  `Goerli`, which is not in `CHAINS` and is retired. The dataset is built on TVL;
  a staging protocol with no TVL is not in it.
* `tokens.coingecko.com/base-sepolia/all.json` → **HTTP 403**. So do
  `sepolia/all.json` and `ethereum-sepolia/all.json`.

**No testnet list is fabricated.** The tempting shortcut — relabelling mainnet
addresses as `chain_id: 84532` — is the worst option available: a testnet address
is unrelated to its mainnet counterpart (a CREATE address depends on deployer and
nonce, and predeploy sets differ), so the candidate would fork, resolve to no
code, and produce a proof that tests nothing. An empty list is honest; a fabricated
one is a silent false negative that looks like coverage.

**A testnet target must come from the operator.** They know their deployment;
nothing public indexes it.

---

## Delivery cost

| Source | Subrequests | Body (observed) |
|---|---:|---:|
| defillama | 1 | **9 435 664 B (~9.4 MB)** |
| coingecko-base | 1 | 672 312 B |
| coingecko-uniswap | 1 | 1 348 712 B |
| **Full refresh** | **3** | **~11.4 MB** |

**Subrequests are not the constraint; bytes are.** Three requests is nothing
against the Worker ceiling. The binding cost is that DeFiLlama is a single 9.4 MB
response which must be held in memory and `JSON.parse`d whole — and its parsed
object graph is several times the text size. Consequences, all implemented:

* `SOURCE_BYTES` records the measured size so a caller can decide *before* spending
  it; `budgetFor(sources)` returns `{requests, bytes}` for a plan.
* `max_body_bytes` skips a source whose known size exceeds it and reports
  `skipped: true` **with the reason** — an omission that is visible, not silent.
* Sources are fetched **sequentially**, not with `Promise.all`. Three parallel
  responses would hold ~11.4 MB of text plus three parsed graphs at once;
  sequential fetching reduces each graph to a candidate list before the next body
  is read. This is a memory decision, and the test asserts the order.
* A dropped DeFiLlama still leaves ~9 000 candidates: one dead feed must not turn
  a refresh into zero targets.
* **Not** re-fetched per request. Whatever calls this is responsible for caching
  the result in D1; the module deliberately does not cache.

---

## Offline testing

`collect.ts` takes `fetch` as an injected dependency (the same shape
`dispatch.ts` already uses: `deps: { fetch: typeof fetch }`). `sources.ts` is pure
and takes a decoded body. So the entire pipeline — URL selection, HTTP error
handling, non-JSON handling, byte budget, ordering, merge — is exercised by the
tests **with no network at all**. A parser that can only be exercised by spending
a 9.4 MB subrequest is a parser nobody tests.

| File | Tests | Covers |
|---|---:|---|
| `tests/targets-address.test.mjs` | 20 | EVM/SVM grammars, disjointness, prefix splitting, chain-name→id incl. `Multi-Chain`/null, unregistered names, bare `sepolia`, numeric ids |
| `tests/targets-sources.test.mjs` | 21 | Both parsers, prefix-beats-`chain` ordering, bare-address drop, malformed bodies, Sui `::` ids, balance identity |
| `tests/targets-collect.test.mjs` | 28 | Dedupe keys and merge, multi-protocol-one-contract aliases, testnet-empty, injected-fetch pipeline, budget |

Run: `npm run build && node --test tests/targets-*.test.mjs`

---

## Findings that shaped the implementation

1. **The address prefix is a stronger chain signal than the entry's `chain`
   field.** 1 042 entries say `chain: 'Multi-Chain'` yet carry a prefixed address
   (41 Base, 19 Solana). Reading `chain` first would have discarded those. The
   parser therefore resolves **prefix first**, and falls back to the entry field
   only for the 1 166 bare addresses.

2. **1 166 DeFiLlama addresses have no prefix at all.** 624 of those also have
   `chain: 'Multi-Chain'` or `null`, so nothing identifies their chain. They are
   dropped and counted. Guessing here would recreate the exact bug `chains.ts`
   exists to remove.

3. **`Multi-Chain` is not a chain, and there is no single-element `chains` array
   to rescue those 624.** Checked: of the 624, *zero* have a `chains` array with
   exactly one entry, so there is no correct way to resolve them from the data
   present. They stay dropped.

4. **One contract can host several protocols.** `0x56072c…` is `Sky Lending`,
   `Sky Money` *and* `Sky RWA`; `CLoUDKc4…` is three Sanctum products. Collapsing
   them to one target is right (one contract is one target); deleting the other
   names would destroy blast-radius evidence. They are kept in `also_known_as`.
   This was found by inspecting real duplicate groups, not designed up front.

5. **Duplicate hex casing is real in the feeds.** The same Base contract appears
   checksummed in one source and lowercase in another, so EVM keys must lowercase
   or 501 duplicates becomes 0 detected and ~501 phantom targets.

---

## Deliberately not done (recommendations, not implementations)

| # | Recommendation | Why it is not done here |
|---|---|---|
| 1 | Add one of `bsc` (511) / `arbitrum` (249) / `avax` (180) to `CHAINS` + `prove.yml` | Highest-yield change available (1 380 targets in the top 6), but `chains.ts` is a shared registry and `prove.yml` must gain a literal `FORK_RPC_<id>` case. Owner decision. |
| 2 | Wire `collectCandidates` into a cron trigger and persist to `programs` | The assignment is explicit: library only. Also needs a schema decision — `programs.id` is a host slug today, so chain-address targets do not fit it yet. |
| 3 | Cache the 9.4 MB DeFiLlama body between invocations | Needs a D1 table or KV namespace; out of scope for a pure module. |
| 4 | Add a reputational/risk filter (audits, `rugged`) | DeFiLlama carries `audits` and `rugged` fields the parser currently ignores. Tempting, but a filter invented here would silently hide targets without the operator agreeing to it. |
| 5 | Map the `eth:` prefix (5 records) to chain 1 | One of the five is inconsistent; guessing on 5 records is not worth the risk of a wrong chain id. |

## Files

```
app/src/targets/index.ts       public surface
app/src/targets/types.ts       Candidate union, dedupe key, drop report
app/src/targets/address.ts     EVM/SVM grammars, prefix splitting
app/src/targets/chain-map.ts   source vocabulary → chain id via CHAINS
app/src/targets/sources.ts     pure parsers (no I/O)
app/src/targets/dedupe.ts      field-wise merge across sources
app/src/targets/testnet.ts     the empty testnet result and its reason
app/src/targets/collect.ts     the only network access, injected fetch
app/tests/targets-address.test.mjs
app/tests/targets-sources.test.mjs
app/tests/targets-collect.test.mjs
```
