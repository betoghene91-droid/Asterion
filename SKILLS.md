# Skills

A **skill** is expert hunting methodology for one bug class, stored as data next
to the playbook that triggers it. The playbook says *what to test*; the skill
says *how a senior auditor decides whether an instance is real*.

```
skills/
  sol.reentrancy/
    SKILL.md      # long form, for a human or a model that wants the full story
    skill.json    # machine-readable: questions, false positives, PoC obligations
```

`app/src/skills.ts` loads them and hands them to whatever needs them.

## Why a skill, when we already have playbooks and a corpus

Three different things, and confusing them is why most "AI security agents"
produce garbage:

| Layer | Question it answers | Failure mode if you only have this |
| --- | --- | --- |
| **Playbook** (`playbooks.ts`) | Which class do we hunt here? | Runs a class that cannot possibly apply |
| **Corpus prior** (`corpus.ts`) | Does this class historically pay? | Knows it pays, has no idea how to check |
| **Skill** (this directory) | *Is this particular instance real?* | Confidently reports lookalikes |

The corpus tells you reentrancy has 810 high-or-critical findings. The skill
tells you that a `nonReentrant` guard under a different name — `lock`,
`entered`, a `ReentrancyGuard` base — is the single most common reason those
810 are not 8,000.

## Why discriminating questions beat templates

A template asks *"is there reentrancy here?"* and invites a yes/no guess. A
discriminating question asks something whose answer is a **fact about the code**
and which collapses the search space either way:

> Does the external call execute before the storage write that the same path
> later reads — or is the write strictly before the call?

Both answers are useful. "Yes, the call precedes the write" advances the hunt.
"No, CEI holds" kills it in ten seconds, which is worth more than a report full
of maybes. Eight questions of this shape, applied honestly, will eliminate most
of a class's false positives before a line of PoC is written.

The second-best question shape names the **attacker-controlled input**:

> Is the called address attacker-controlled (calldata, attacker-written storage,
> a token the attacker deploys) or a fixed immutable/constant?

That single question separates "reentrancy exists" from "reentrancy is
exploitable", and it is the one most rushed reviews skip.

## What a skill contains

| Key | Purpose |
| --- | --- |
| `id` | Must equal the playbook id and the directory name. Enforced. |
| `version` | Bump when the methodology changes materially. |
| `name`, `cls`, `family` | Must match `playbooks.ts`. Enforced by test. |
| `requires` | What a target must expose for the skill to be worth applying. |
| `questions` | ≥5 (we ship 8). The core value. Most-specific first. |
| `false_positives` | ≥4 (we ship 7–8). Honest, concrete, from real review fatigue. |
| `poc_must_show` | The exact measured delta that makes the PoC a proof. |
| `impact_bar` | What separates reportable from informational. |

`SKILL.md` carries six sections: when it is worth hunting, how to confirm
reachability, the discriminating questions, common false positives, what a
minimal PoC must demonstrate, and the impact bar.

## API

```ts
import {
  listSkills,          // (opts?) => SkillMeta[]
  getSkill,            // (id, opts?) => Skill | null
  selectSkills,        // (opts) => Skill[]
  questionsFor,        // (id, opts?) => string[]
  renderSkillForPrompt,// (id, opts?) => string   (bounded, MAX_PROMPT_CHARS = 4000)
  skillLoadReport,     // (opts?) => SkillLoadReport  — why the loader is empty, if it is
} from './skills.js';
```

`selectSkills` ordering is a documented total order — exact playbook first, then
corpus weight descending, then id ascending — so the same input always yields
the same list. The corpus weight comes from `priorFor(digest, id).weight`:

```ts
const ranked = selectSkills({
  playbook: 'sol.rounding',
  weights: { 'sol.rounding': 0.8, 'sol.inflation': 1.255, 'sol.oracle': 0.925 },
});
```

## Adding a skill

1. Create `skills/<playbook-id>/` — the id must already exist in
   `playbooks.ts` or the test set fails as a dead skill.
2. Write `SKILL.md` with the six sections. Be specific: name the code shapes,
   the boundary conditions, and the numbers.
3. Write `skill.json` with all ten required keys. Use an existing file as the
   shape reference.
4. Run `cd v1 && npm run build && npm test`. Do not skip the build — tests import
   compiled JS from `build/`.

## Honest limits

A skill is **guidance for a model, not a verifier**. It cannot:

- **Upgrade a verdict.** Only a PoC measured on a fork can do that. The rendered
  prompt block says so in its last line, so the model is told this every time.
- **Prove a bug exists.** It changes what the model looks for and what it must
  measure; it does not establish that anything is wrong.
- **Replace the corpus.** A skill is hand-written priors about *method*; the
  corpus is empirical priors about *outcomes*. They answer different questions.
- **Cover classes it has no file for.** Skills now exist for every playbook the
  bot can dispatch: all ten `sol.*`, all fourteen `web2` packs, and the one
  `infra` pack (`web.takeover`). There is no uncovered class left, but note what
  the coverage *is*: the Solidity packs are grounded in the audit corpus, while
  every Web2 pack has **n=0** corpus findings — its 180k rows are entirely
  web3 — so those questions are first-principles reasoning, not measured
  priors. Each Web2 SKILL.md says so at the top. Do not read "25 packs" as
  "25 corpus-grounded packs".
- **Stay current.** The methodology is written from domain knowledge, not
  scraped from the latest writeups. It will drift as the field moves; the
  `version` field exists so a stale skill can be identified rather than trusted.

Two further honest notes about the numbers in these files:

- Per-class corpus counts quoted in `SKILL.md` come from the shipped
  `corpus-digest.json` and can be re-verified against it. They are context for
  prioritisation, not evidence about any specific target.
- Nothing here claims a specific real-world incident was read. The methodology
  is general practice, deliberately not decorated with invented citations.
