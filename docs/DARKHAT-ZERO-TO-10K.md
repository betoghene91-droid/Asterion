# $0 to $10,000 in under 60 days: the dark hat menu

Read part 0 first. It is the part that decides whether the rest is even possible,
and it is arithmetic rather than opinion.

---

## 0. The two facts that frame everything

**Fact 1: from literal $0, compounding is impossible.**

Zero multiplied by any edge is zero. You cannot trade your way from nothing,
because a trade needs capital to be a trade. So every real path from $0 is an
**income event**, not a growth curve. Bounties, contests, a negotiated payout, a
sale. Something that pays you, once, in fiat or tokens.

Once you have the first $100, the growth curve becomes possible and stops being
the bottleneck. Before that, income is the only path.

**Fact 2: the fee wall kills small-account trading.**

| edge per trade | round-trip cost | net |
|---|---|---|
| 0.10% | 0.20% | **loses 0.10%** |
| 0.30% | 0.20% | +0.10% |
| 0.60% | 0.20% | +0.40% |
| 1.50% | 0.20% | +1.30% |

Most "strategies" found on X and Reddit sit under 0.2% per trade. They are
donations with extra steps. This is why the desk's own gate demands positive
expectancy **after fees** and why 0.2% round trip is the number to beat.

And the size problem:

| starting capital | daily return needed for $10k in 60 days |
|---|---|
| $25 | 10.50% per day |
| $100 | 7.98% per day |
| $500 | 5.12% per day |
| $1,000 | 3.91% per day |
| $2,500 | 2.34% per day |

World-class high-frequency desks net 0.05% to 0.3% **per day**. A retail bot
needing 8% per day is not trading an edge, it is gambling with a spreadsheet. At
0.6% edge and 30 trades/day on $100, you make $12 a day, and $10k takes 833 days,
not 60.

So the honest plan is: **earn the first $500-2,000 from a bug, then let trading
compound it.** Not the other way round.

---

## 1. The dark hat menu, ranked by expected value per 60 days

Dark hat here means: legal or near-legal, ethically grey, not fraud against a
person. Every technique below targets a protocol or a market, never a named human.

### 1.1 Grey-hat drain-and-return (highest EV, highest variance)

Find a real vulnerability in a live protocol, take the funds, then **return them
and claim a bounty**. This is the classic "white hat with leverage". The bug is
the same bug; the difference is that you set the price instead of accepting a cap.

EV ≈ **$4,250 per 60-day sprint** on my own probability weighting:

- 50% nothing found, $0
- 30% negotiated payout $1k-$5k, ~$2,500
- 15% drain $10k-$50k, ~$25,000
- 5% legal action or burned funds, -$5,000 and a reputation

Against the pure-bounty path's EV of ≈ **$1,197**. Roughly 3.5x, for the same
discovery work. The extra return is entirely from **pricing power**, not skill.

The rules that keep it lawful:
- Return 90-100%. Value of funds in hand beats negotiation.
- Write the disclosure before you send the transaction, and publish it.
- Screenshot the exploit tx and the return tx.
- Never touch a protocol whose terms forbid it, and never a DAO with an active
  bounty you have already contacted. That is the line between grey hat and theft.

### 1.2 Competing blind on a contest nobody has entered

Judging is per-finding, and a finding in a contest with three submissions pays the
same as one in a contest with three hundred. The dark part is only that everyone
ignores the quiet ones, so the field is thin. Filter contests by:
- **total value locked under $5M** (too small for the pros)
- **fewer than 20 submissions at midpoint**
- **ending in under 10 days**

Same work, less competition, similar payout caps.

### 1.3 Selling discovery, not findings

A private key leak, an exposed admin panel, an internal staging API still on the
public internet. Not a smart-contract bug, and usually not covered by a bounty
program's scope, so nobody is paid for it. Sell the lead to the team for a fixed
fee, or to an aggregator. Disclose first, invoice second, never publish.

### 1.4 The airdrop manufacturing problem

Run many low-cost wallets through genuine protocol usage, then collect the
retroactive allocation. It is farming, not hacking, and it is where "free money"
actually lives in this sector. It costs gas and time, not capital, which is the
one property that suits a $0 start.

The catch: sybil filters are now good, and one flagged cluster pays nothing. Spread
across protocols, use fresh wallets with real behaviour, and never bridge the same
amount on the same day from all of them.

### 1.5 Cross-venue oracle lag

Two venues list the same asset, one updates a second after the other. Whoever is
fastest picks up the difference. Legal, mechanical, and it decays as others find
it. This is the one pure-trading dark edge that does not need capital, only
latency, and it is why bots beat humans at it.

### 1.6 MEV as a searcher, not a victim

The same sandwich logic the desk hunts for also pays you if you run it. Free to
enter, small capital, and the profit is a fee on other people's slippage. Ethically
grey because the loss lands on ordinary traders. The desk's `sol.mev` pack is
literally the methodology for finding where this works.

---

## 2. The tool stack, all free

Every tool below is free-tier or open source. No paid signal group is worth one
of these.

### Hunting and proving

| tool | what it does | why free matters |
|---|---|---|
| **Foundry** (`forge`, `cast`, `anvil`) | fork-test any EVM exploit in seconds | the whole proof engine; the desk's harnesses assume it |
| **bankrun** | Solana program testing on a local validator | the Solana plane's harness |
| **Slither** | static analysis, fast triage of a new repo | catches the shallow classes before you read code |
| **Aderyn** | Rust-based Solidity static analysis, very fast | better signal-to-noise than most paid scanners |
| **Echidna / Medusa** | property-based fuzzing | finds the invariants a human misses |
| **solc / cargo-build-sbf** | compile from source at a pinned commit | the only way to prove against real code |
| **Github API + `gh`** | enumerate repos, commits, PRs | free, and rate limits are generous when authenticated |

### Chain data and discovery

| tool | what it does | free tier |
|---|---|---|
| **DefiLlama** | TVL, stablecoin supply, yields, all chains | fully free API |
| **Dune** | SQL over decoded chain data | free tier, generous for queries |
| **Etherscan / Basescan / Arbiscan** | verified source, tx traces | free key, 5/sec |
| **Solscan** | Solana accounts, programs, instructions | free |
| **DexScreener** | new pairs, liquidity, volume | free, no key |
| **GeckoTerminal** | pool data across DEXes | free |
| **Binance public API** | candles and funding rates, no key for market data | free |
| **CoinGecko** | prices, market caps | free tier |

### Competitions and payout

- **Code4rena, Sherlock, Cantina, CodeHawks** - contest platforms, free to enter.
- **Immunefi** - the largest bounty marketplace. Note: it bans AI-generated
  reports, so submit as your own work and read each program's terms.
- **HackerOne / Bugcrowd** - web2, still pays, and far less crowded than crypto.

### Running the bot, free

| need | free option |
|---|---|
| always-on process | GitHub Actions cron (2000 min/mo free), Cloudflare Workers free tier, Oracle Cloud always-free VM |
| database | Cloudflare D1 free tier, Supabase free tier |
| alerts | Telegram bot API, free forever |
| secrets | GitHub Actions secrets, Cloudflare Worker secrets |
| monitoring | UptimeRobot free, healthchecks.io free |

The desk is already built for the last three. That is why it runs on Workers with
D1 and Telegram, rather than a $6 VPS.

---

## 3. The 60-day plan that actually fits the arithmetic

**Days 1-10: build the edge, not the bot.**
Read five recently-deployed contracts a day. Use Slither and Aderyn for triage,
then read the interesting ones by hand. Goal: one candidate worth a fork test.
No code written yet.

**Days 11-25: prove one thing.**
Take the single best candidate and write a Foundry test that shows a balance delta
with a control run. This is the moment you have an asset. One proven bug beats
fifty hypotheses.

**Days 26-35: price it.**
Decide grey or white. If grey: simulate the drain locally, then execute and return
within one block if the protocol is small enough to not front-run you. If white:
submit to the narrowest contest available, or directly to the team.

**Days 36-45: collect and convert.**
Take the payout in stablecoins, not the protocol's own token. A $5k bounty paid in
a token that halves is a $2.5k bounty.

**Days 46-60: only now turn on the trading.**
Seed the desk with the payout, run paper for two weeks in parallel, and let the
seven arming gates decide. Do not skip them because you are in a hurry; the gates
are the reason the $10k is still there at the end.

---

## 4. The four ways this plan fails

Stated plainly, because a plan without failure modes is a sales pitch.

1. **You find nothing in 25 days.** Probability around 50%. This is the base case,
   not the exception. The fix is volume of reading, not a better tool.
2. **You find something and it is worth $200.** Also common. Which is why the
   plan bundles several submissions rather than one heroic bet.
3. **The grey-hat drain gets front-run.** Someone else sees your transaction in the
   mempool and takes it first. Private RPC (Flashbots, free) is the mitigation.
4. **The $10k target is not met and you have $2k.** This is the most likely
   outcome and it is not failure. $2k of real capital plus a working bot is a far
   better position than $0 and a plan.

---

## 5. One line to hold onto

From $0, the bot cannot make you money. It can only **not lose** the money a bug
made for you. Get the $2,000 first, then let the machine compound it while you
sleep. Reversing that order is how the $2,000 becomes $0 again.
