# How to get the most out of this bot

`BEGINNER.md` gets it running. This is about squeezing real findings out of it.
The difference between a user and an operator is mostly knowing **what this bot is
good at** and refusing to use it for everything else.

---

## The one idea that matters

This bot is not a scanner. A scanner asks "does this endpoint look like it has a
bug?" and gives you a list you then have to check by hand.

This bot asks a harder question: **"can I write a test that fails on this code,
and stops failing when the cause is removed?"** If it cannot, it says so instead
of guessing.

That makes it slow, narrow, and — when it works — worth far more than a scanner
list. Every habit below follows from that one idea.

---

## Habit 1: hunt where a test can exist

| Target type | Can it be proven? | Why |
|---|---|---|
| Solidity contract with source | **yes** | a test can call it on a fork |
| Solidity, verified bytecode only | no | nothing to compile against |
| Web API with auth | partially | we can prove behaviour, not always impact |
| Web page / UI | no | there is no failing assertion to write |
| Closed-source binary | no | out of scope for this engine |

If the answer is "no", the bot will eventually produce `inconclusive`, and you
will have spent a time box learning what you already knew. Pick targets where
the test is possible.

---

## Habit 2: give it ground truth, not adjectives

Weak brief (the bot asks you four questions):

```
look at this protocol, something feels off with the withdrawals
```

Strong brief (it starts immediately):

```
repo: https://github.com/acme/vault
commit: a1b2c3d4e5f6...
contract: Vault
address: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
fork_block: 41287001
the withdrawal path in Vault.withdraw releases funds before updating balances
```

Every one of those tokens is parsed as an explicit statement of intent. Prose
about a feeling is not. The bot derives nothing it cannot point at in your text,
which is why it refuses rather than guessing — and that refusal is the feature.

**Three things it will never infer, so always state them:** the repo, the commit,
and the contract name. Without all three, no proof is dispatched.

---

## Habit 3: let the corpus choose your order

Ask `/corpus` before you pick a playbook. It ranks classes by **measured**
precedent — how often that class actually paid out in 180,907 historical findings.

Current weights from the digest:

| Class | Historical findings | Weight |
|---|---|---|
| `sol.inflation` | 6,602 | **1.255** (highest) |
| `sol.flashloan` | 706 | 1.167 |
| `sol.reentrancy` | 1,640 | 0.996 |
| `sol.accesscontrol` | 8,719 | 0.933 |
| `sol.oracle` | 3,771 | 0.925 |
| `sol.signature` | 2,281 | 0.848 |
| `sol.rounding` | 8,175 | 0.800 |
| `sol.dos` | 6,837 | 0.797 |
| `sol.upgrade` | 3,664 | 0.651 |
| `sol.delegatecall` | 3,832 | 0.535 |

Three things to notice.

1. `sol.accesscontrol` has the **most** findings and a *lower* weight — raw counts
   are not payouts.
2. `sol.inflation` wins with a quarter of access control's volume.
3. `sol.flashloan` is second-highest on only 706 findings — small, high-yield.

**Hunt the weight, not the count.**

Every `web.*` class shows **n = 0**. Not a low prior — literally zero rows. The
corpus is entirely web3, which is why the web2 path below is marked "later".

Run `/precedent sol.inflation` and read the actual findings. Ten minutes there
will teach you more about this bot than any doc.

---

## Habit 4: treat `partial` as a to-do, never a finding

This is the mistake that gets people banned from a programme.

```
partial  =  the test failed, but I cannot say why
```

It might be your bug. It might be a broken fixture. It might be the wrong block.
Reporting it is how you lose credibility with a triager in one message.

What to do instead: open the `proof-bundle` artifact, read the assertion that
failed, and check whether it is the one your claim is about. If it is, the work is
*identifying the cause*, not submitting.

---

## Habit 5: fix `inconclusive` before you believe anything

`inconclusive` almost always means the environment, not the code:

| Message in the log | Real cause |
|---|---|
| `TARGET is not a valid address` | `address` input blank |
| fork / state errors | not an archive RPC |
| `no forge artifact` | contract name does not match `src/<Name>.sol` |
| out of gas | raise the fork block or the gas limit |

Every one of those is 2 minutes to fix and gives you a real answer instead of a
non-answer. Never record `inconclusive` as "no bug".

---

## Habit 6: one brief, one question

The intake cap is 16 targets, and that is deliberate. `BEGINNER.md` explains how
to set it up; here is why it matters.

If you put 16 hosts in one brief and get 16 `inconclusive`s, you learn nothing and
you cannot tell which one failed for which reason. Ten briefs with one question
each give you ten interpretable answers.

Split by **question**, not by asset. "Does this withdrawal reenter?" is one brief.
"Is this protocol insecure?" is not a brief, it is a project.

---

## Habit 7: use the fuzzer only where a property exists

V3 (Echidna seeding) is real but narrow. It can only help where an honest
property can be written — currently `sol.reentrancy`, `sol.rounding` and
`sol.inflation`. Set `fuzz_playbook` to one of those and the workflow will try to
find a falsifying sequence before writing a hand-shaped test.

For access control, oracle, upgrade and DoS there is **no property** and the stage
refuses rather than inventing one. A made-up property produces confident nonsense,
which is worse than no fuzzing.

When a seed does come back, it arrives as an extra attempt in the same plan — it
does not replace the static one, and it still has to survive the same judge.

---

## The workflow that actually earns

```
Week 1   pick 3 protocols on Base with verified source
         /corpus, read /precedent for your top class
         write 3 one-question briefs

Week 2   run proofs manually (Actions -> prove)
         expect mostly inconclusive at first; fix the environment until
         you get real answers

Week 3   you now have either partials worth chasing or honest "no bug"
         for each partial, identify the missing cause by hand
         that manual work is the actual job; the bot removed the boilerplate
```

The bot does not replace the thinking. It removes the 3 hours of writing a
harness so you can spend them on the 1 hour that requires judgement.

---

## What to ignore

- **Severity numbers before a verdict.** A `critical` label on a `partial` is noise.
- **The web2 path, for now.** The corpus is entirely web3, so web2 hunts carry no
  prior. You are hunting blind — do that later, once the web3 loop works.
- **Chasing `proven` today.** It cannot be reached until the with-fix
  counterfactual exists. Aim for a clean, well-understood `partial` and treat the
  cause analysis as the deliverable.

---

## The honest summary

This bot is good at: reading code, ranking by real precedent, writing a test
harness, running it, and refusing to lie about the result.

It is not good at: deciding what is worth your time, understanding business logic
intent, or proving impact in systems where no test can be written.

Use it for the first list. Do the second yourself. That division is the whole
operating model.
