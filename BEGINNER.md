# Start here (beginner guide)

This guide assumes you have never deployed anything. If you get stuck, the
answer is almost always in `SETUP.md`, which has the exact click path for every
step below.

---

## 1. What this thing actually is, in one picture

```
   YOU (Telegram)                    THE BOT                    THE PROOF ENGINE
   ─────────────                     ───────                    ─────────────────
   "look at                            a Cloudflare Worker       a GitHub Actions job
    app.example.com"  ───────────►     that reads your text,  ──► that clones a repo,
                                        decides if it is          writes a test that
                                        allowed, and replies      proves or disproves
                                                                  a bug, runs it
```

Three pieces, one bot:

| Piece | Lives where | What it does | You touch it? |
|---|---|---|---|
| **The Worker** | Cloudflare (free tier) | talks to you on Telegram, decides what is allowed, stores findings | no |
| **The database** | Cloudflare D1 | remembers hunts, findings, and 180,907 past findings | no |
| **The proof engine** | GitHub Actions | actually runs code to prove a bug is real | only when you press Run |

You talk to it in Telegram. Everything else is automatic.

---

## 2. Before you start, get four things

| You need | Where | Free? |
|---|---|---|
| A Telegram bot token | message `@BotFather` → `/newbot` | yes |
| A Cloudflare account | cloudflare.com | yes |
| A GitHub account | github.com | yes |
| An archive RPC URL | alchemy.com (Base network) | yes |

An **archive RPC** is a URL that can read old blockchain history. The free
`https://mainnet.base.org` cannot, and proofs will honestly fail with it. This is
the single most common setup mistake, and it is not a bug.

Your own chat ID: message `@userinfobot`, it replies with a number.

---

## 3. Set it up (about 20 minutes)

Follow `SETUP.md` top to bottom. It is written as numbered steps 0–10 with a
verification command after each one. Do not skip the verification lines; they are
what tell you a step worked.

The short version:

1. `SETUP.md` §1 — create the bot, get the token and your chat ID
2. §2 — push this repo to GitHub
3. §3–4 — make a Cloudflare API token, add it plus your other secrets to GitHub
4. §5 — create the D1 database and R2 bucket
5. §6 — push. CI builds, migrates, loads the 180k corpus, deploys
6. §7 — verify: the bot answers `/start`, `/health` returns `{"ok":true}`

If §7 passes, you have a working bot. Stop and enjoy that for a second.

---

## 4. Your first five minutes with it

Open Telegram, find your bot, send `/start`. You get a menu. Then try, in order:

```
/health        is it alive? seconds to answer
/corpus        what does it know? should say 180,907
/status        what has it been doing?
```

Then describe a target in plain English:

```
look at app.example.com — the login page feels wrong
```

It will ask you questions until it understands the brief. Answer them. You are
not writing config; you are talking.

> **You cannot dispatch a proof yet.** See §6 below. This is the one real gap.

---

## 5. What the buttons mean

| You see | It means |
|---|---|
| `≡ Browse playbooks` | the 8 bug classes it knows how to look for |
| `▶ Hunt this` | start a hunt using that playbook |
| `/hunt <text>` | plain-English hunt, same as typing a sentence |
| `/precedent <class>` | the 250 real past findings it will compare against |
| `/seed <hosts>` | queue hosts for discovery |

`/precedent sol.reentrancy` is worth doing once — it shows you the actual thing
that makes this bot different from a scanner. It is not guessing from a template;
it is citing 250 real reentrancy findings and weighting the hunt toward the shape
that actually paid out before.

---

## 6. The honest part: what does not work yet

Read this before you get frustrated.

**A proof cannot run end-to-end from a Telegram brief yet.** The brief the bot
collects does not contain a git URL, a commit, or a contract name, and the proof
workflow needs all three. The bot will refuse and tell you exactly which one is
missing — that refusal is correct behaviour, not a crash.

**What you can do today:**

1. Use the bot for hunting, corpus lookup, discovery and triage — all of that works.
2. Run a proof **manually** from GitHub: Actions → prove → Run workflow, filling
   `repo`, `commit`, `contract`, `fork_block`, and **`address`** (SETUP.md §10).
3. Read the verdict honestly (next section).

**What is also true:** no verdict can currently reach `proven`. The highest is
`partial`, because the workflow never generates a "with the fix applied"
comparison run. That is a real ceiling, described in `OPERATING.md`, not something
the bot is hiding from you.

---

## 7. Reading a verdict without fooling yourself

Every attempt comes back as one of four words. The differences matter more than
the severity numbers.

| Verdict | Plain meaning | What to do |
|---|---|---|
| `proven` | the bug is real, and removing the cause removes the effect | report it. (Not reachable today.) |
| `partial` | the test reproduced, but causality is not established | **never report.** keep digging |
| `inconclusive` | the test could not run properly | fix the environment, retry |
| `disproved` | the test ran and passed: no bug here | move on |

Two rules that will save you from embarrassment:

1. **Never report `partial`.** It means "something failed" — not "a bug exists".
2. **`inconclusive` is not a negative result.** It usually means a bad RPC URL, a
   blank `address`, or the wrong block. Fix that, rerun, then believe the answer.

---

## 8. When something goes wrong

| Symptom | Usual cause | Fix |
|---|---|---|
| Bot does not reply | webhook not pointed at the Worker | SETUP.md §6, last step |
| `/health` fails | Worker did not deploy | read the Actions log for the deploy job |
| `/corpus` says 0 | digest not loaded | it is automatic now; check the deploy log for the corpus step |
| Proof says `inconclusive` + "not a valid address" | `address` blank | fill it in (§10) |
| Proof says `inconclusive` + fork error | not an archive RPC | use Alchemy, not `mainnet.base.org` |
| Proof says `disproved` always | old bug: exit code misread | fixed; make sure you are on current `main` |

---

## 9. Where to go next

- `OPERATING.md` — the daily 2-minute routine, and how to pick targets
- `SETUP.md` — every step with its exact command
- `ECOSYSTEM.md` — what was borrowed from which open-source project, and why

One last thing: the bot is deliberately built to say "I don't know" rather than
guess. If a verdict feels unhelpful, that is usually it working correctly. The
failure mode to fear is a confident wrong answer, and the whole design is aimed at
preventing that one.
