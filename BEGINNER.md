# Asterion for someone who has never traded crypto

This is the whole system, in order, in plain words. No jargon you have to look
up. If you have opened Telegram and can type, you can run this.

Read it once top to bottom. Then use it with the sections as a checklist.

---

## 1. What this thing is, in one paragraph

Asterion is two workers in one program. One **hunts for bugs in crypto software**
and pays for itself by finding security holes before someone else does. The other
**trades on paper** (fake money, real prices) to find out whether a trading
strategy works, before you risk a single real dollar. Both run on a schedule, on
a server, while you sleep. You read two screens: one for the desk, one for the
trading. That is it.

The important part: **nothing here can spend your money until you say so.** It
runs in paper mode, forever, until seven separate conditions are true and you
flip a switch. That is by design, and it is the safest part of the whole system.

---

## 2. The five words you need

Before anything else, these five. Everything else is detail.

**Paper mode** - trading with fake money. Prices are real, orders are real, the
money is imaginary. You lose nothing and learn everything.

**Live mode** - trading with real money. Same code, real orders, real risk.

**A position** - something you bought and still own. If you bought $50 of a coin
and hold it, you have an open position of $50.

**A stop** - an automatic sell that happens when the price falls to a level you
set in advance. It is the thing that stops one bad day from becoming a bad month.
The desk sets it for you.

**Slippage** - the gap between the price you expected and the price you got. On
small coins, selling can move the price down against you, so you get a bit less.
There is slippage on the way in and on the way out, and the desk models both.

---

## 3. What actually runs, and when

Nothing in this system is a button you press repeatedly. It is a schedule. Five
timers run on the server. You do not have to be awake, or online, or to have your
laptop open.

| when | what wakes up | what it does |
|---|---|---|
| every 5 minutes | sentinel + desk tick | scans the watchlist, then one trading pass |
| every hour | crawler + analyst | fetches new bug-bounty programs, re-scores what passed |
| 03:15 daily | maintenance + calibration | verifies the audit log, ages out old approvals |
| every 6 hours | dead-man's switch | checks the worker is still alive, alerts if not |
| 06:30 daily | briefing | sends you one Telegram message with the day's summary |

You do nothing for any of these. They are the heartbeat.

**The desk tick is the important one.** Every 5 minutes it does four things in
order, and the order matters:

1. **Scout** - looks at every liquid coin on the chain and throws away the
   obviously wrong ones (too new, too little liquidity, no volume).
2. **Filter** - runs the expensive checks on what survived: who holds it, can
   the owner mint more, is it a honeypot that lets you buy but not sell.
3. **Analyst** - scores what is left from 0 to 100 and writes down why.
4. **Risk** - checks the open positions, moves stops up if a trade is winning,
   and opens a new one if a position slot is free.

If nothing survives those four gates, it opens nothing. **An empty trade list is
a normal, correct outcome.** It means the desk looked and found nothing worth
your money. It does not mean the bot is broken.

---

## 4. The Trade screen, section by section

This is the screen that looks like a trading app. It reads bottom-up in the
order you care about, but on screen it reads top-down. Here is what each block
is telling you.

### Equity

**Equity** is the money you have, if you closed everything right now. In paper
mode it starts at whatever the desk is configured with and moves as trades close.

**Net** is the total profit or loss from every closed trade, added up. Green is
up, red is down. This is the number that matters. Everything else is detail
about how you got there.

**Mode** says `paper` or `LIVE`. Until you do the seven things in section 8, it
will say paper, and that is correct.

### Equity curve

A row of thin bars. Each bar is one closed trade. Height is where your running
total stood after that trade. Green above the line, red below it.

The point of the curve is not the individual bars. It is the **shape**. A good
strategy looks like a staircase going up with small dips. A bad one looks like a
spike followed by a long slide, which usually means one lucky trade paid for
twenty unlucky ones.

If there are fewer than two bars, you get a sentence instead of a curve, because
one point has no shape. That is honesty, not a missing feature.

### Performance

Four numbers, and all four matter together. Reading any one alone will mislead
you.

**Trades** - how many have closed. Under 30, ignore every other number on this
screen; it is noise. The desk wants 200 before it will consider going live.

**Win rate** - the percentage of trades that made money. Higher is better, but
a 90% win rate with one catastrophic loss is worse than 55% with small losses.

**Profit factor** - total money won, divided by total money lost. Above 1.0 you
are profitable. Above 1.3 is good. Above 2.0 is suspicious, and you should
assume it will not last. If it says `n/a (no losses yet)`, that means you have
not lost a trade yet, so the division has nothing to divide by. That is
arithmetic, not a great sign.

**Wins / losses** - the split, so you can see whether the win rate is real.

### Open risk

Everything you currently own. **Size** is what you put in. **Entry** is the price
you paid. **Stop** is the price where it sells itself automatically.

The only number that matters here is the distance between the current price and
the stop. If entry is $1.00 and stop is $0.85, your worst case on that position
is 15%, and you already knew that when you opened it.

If a position says `trailing`, it means the stop has moved up as the price rose.
A trailing stop only ever moves up. It locks in profit rather than letting a
winner turn into a loser.

The marks are the last stored price, not a live quote, because a dashboard read
must not spend the API budget. The panel says so. Treat it as slightly stale.

### Closed

Every exit, most recent first. Each row shows the profit, the percentage, and the
**reason it closed**. The reason codes are the useful part:

- `stop` - the price hit the stop. Normal, expected, fine.
- `trail` - the trailing stop caught it on the way down after a rise. Good.
- `thesis` - the reason you bought stopped being true. Good, that is discipline.
- `time` - held too long with nothing happening. Neutral.

A screen where every loss says `stop` and every win says `trail` is a healthy
system. A screen full of `thesis` exits means the entry logic is guessing.

### Cannot go live yet

A list of the conditions still unmet. Each one names what it wants and what it
has. This is the honest gate. It is not a suggestion.

---

## 5. The Hunt targets screen

This one answers a different question: **what is the desk looking at right now,
and what did it already throw away?**

It reads one table, the one the desk actually fills. That distinction matters,
because the old Watchlist panel read a different table that nothing was writing
to, which is why it always looked empty.

### The five counts

**Passed** - survived every gate and is tradeable right now. This is what the
desk will buy from. If this is 0, nothing is being bought, and the screen tells
you why below.

**Scored** - survived the cheap checks and got a score, but no position was
opened. Usually because all position slots are full, or the score did not clear
the bar.

**In (raw)** - the scout saw it and has not checked it properly yet. A queue.

**Killed** - rejected, with a reason. This is the most informative number on the
screen, because it tells you the desk is doing its job. A desk that kills nothing
is not filtering.

**Expired** - too old to be interesting any more. Rows age out.

### Each target row

Symbol, then the facts: which exchange it trades on, market cap, liquidity,
holders, and how old the pair is. Then on the right, either a state label or a
score out of 100.

Under the facts, a **why** line, when there is a score. That line is the only part
worth reading carefully. It says which check failed. A token with a score of 78
that was still killed has a why line explaining which single floor it missed,
and that reason is far more useful than the total.

Two things to know about the numbers:

**Liquidity** is how much money is in the pool you would trade against. A $40k
pool and a $20M market cap means the first real sell moves the price, and you
might not be able to get out. The desk requires liquidity to be at least 3% of
market cap for exactly this reason.

**Holders** is how many separate wallets own it. Ten holders means one wallet
selling crashes it.

---

## 6. The Library screen, and what changed

The Library lists **what the program can actually do**. Each entry is one bug
class it knows how to hunt, and each shows two things:

**A playbook** - the exact route and proof method. If it has one, the bot can
actually run it against a target and prove a result.

**A method pack** - the questions to ask first, the false positives to rule out,
and what a proof must show. This is the thinking, not the executing.

An entry can have both, or just the method. An entry with only a method is
honest: it means the bot knows how to think about that bug class but has no
automated route to prove it yet.

**What changed this round:** the Solidity set went from 13 to 20, and 17 of
those now have a playbook and a working proof harness. The seven new classes:

- `sol.overflow` - arithmetic that wraps or a cast that silently truncates
- `sol.mev` - sandwich and ordering attacks
- `sol.erc4626` - vault share price and the first-depositor donation attack
- `sol.erc20` - tokens that take a fee, rebase, or return nothing
- `sol.proxy` - storage slots that collide between a proxy and its logic
- `sol.erc4337` - account abstraction and paymaster drains
- `sol.signature.ecdsa` - signature replay and the zero-address recovery bug

**Also fixed:** the three Solana classes used to be filed under a heading that
read "Solidity", because their ids start with `sol.`. They are Solana programs.
They now have their own heading.

---

## 7. Reading the rest of the screens

**Hunt** - describe a target in plain text. The bot compiles it into a real
engagement with rules, and puts it in the queue for you to approve. Nothing runs
until you tap approve.

**Queue** - the approvals waiting for you. Approving is the one irreversible
action in the whole console, so it asks first, and it is written to an
append-only log that cannot be edited afterwards.

**Ask** - talk to the bot in sentences. It answers about the system.

**Ops** - the inventory: programs, findings, history, the audit log, the desk,
the trade screen, the hunt-target screen, status, and the scoreboard.

---

## 8. How a trade actually happens

The full path, once, end to end:

1. The scout sees a new coin with enough liquidity and volume. It writes a row.
2. The filter checks the dangerous things: can the owner mint unlimited tokens,
   can they freeze your wallet, is selling actually possible.
3. The analyst scores it. Under the floor on any single check kills it, no matter
   what the total is.
4. The risk step checks if there is a free position slot and if the day's loss
   limit has been hit. If both are fine, it opens a position **at half size**.
5. The other half is bought a moment later, at a confirmed price, which is what
   stops a fast-moving price from filling you at a bad level.
6. A stop is set immediately. It only ever moves up.
7. When the stop, the trail, or the thesis fires, it sells and writes the exit.

Two more limits, and both are hard:

- **1% risk per trade**, maximum, and only 3 positions open at once.
- **A daily circuit breaker**: lose 3% in a day and it stops opening new
  positions until tomorrow. This is the thing that stops a bad day becoming a
  bad week.

---

## 9. Going live, and why it takes seven checks

Paper mode is not live mode with a number changed. Going live needs all seven of
these, and each one exists because something went wrong once:

1. **200 closed paper trades.** Fewer than that and the statistics mean nothing.
2. **30 days of paper history.** A strategy can look great for a week and be
   broken by a month.
3. **Positive expectancy after fees.** It must make money after costs, not before.
4. **Max drawdown under 20%.** The worst peak-to-trough run has to be survivable.
5. **`DESK_LIVE=1` set as a server secret.** A deliberate act, not a default.
6. **A capital cap set to a positive number.** A hard ceiling on what can be lost.
7. **The signing key held outside the worker.** The key that can move money must
   not live in the same place as the code that decides to move it.

Until all seven are true, the mode stays `paper` no matter what you type. You can
ask `/desk live` in Telegram and it will list what is missing. It cannot arm
itself.

**The one thing the screen does not do:** there is no button to go live. Arming is
a server-side secret. The reason is stated in the code: a web control that can
start real trading is one leaked URL away from an empty wallet.

---

## 10. The Telegram commands

Everything the web console does, the bot does too, in the chat:

`/start` or `/menu` - the main menu
`/status` - worker alive, how many programs, what is queued
`/hunt <target>` - start a hunt on something
`/desk` - desk status and the unmet gates
`/pos` - open positions
`/kills` - what was rejected and why
`/calib` - how accurate the filters have been
`/corpus` - the precedent data behind the scoring
`/ui` - a link to the full console

---

## 11. What "no results" means, in every place it can appear

This is the section to re-read when something looks empty. Empty is usually
correct, and each empty has a different cause.

**No closed trades.** Paper mode has not exited a position yet. Positions only
close on a stop, a trail, or a thesis break. If nothing is moving, nothing closes.

**No open positions.** All slots were empty and nothing passed the gates. Normal.

**No targets in the universe.** The scout has not written a row since deploy. The
tick runs every 5 minutes; wait one, then look again. If it is still zero, every
candidate failed a coarse gate before a row existed.

**No approvals in the queue.** Nothing is waiting on you. Correct.

**No findings.** The bot has not proven a bug yet. This is the design: a finding
is only written when it is proven, not when it is suspected.

**Library shows a class with only a method.** That class can be reasoned about
but has no automated proof route yet. Honest, and now labelled as such.

---

## 12. The five things that will cost you money, if you let them

**Overfitting.** A strategy tuned on past data will fit that data and nothing
else. This is why the desk holds back 30% of the history the strategy never saw,
and why the live switch needs 30 days rather than 30 trades.

**Thin liquidity.** A $40k pool cannot absorb your exit. You will see a paper
profit that is impossible to realise. The 3% liquidity rule is the defence.

**One bad week.** Which is why the daily breaker and the compounded 1% risk exist.
Ten 1% losers in a row is 10%, survivable. Ten 10% losers is ruin.

**A honeypot.** A token that lets you buy and blocks your sell. The filter checks
for it directly, by simulating a sell, because reading the code is not enough.

**Believing the backtest.** Every backtest is a story about the past. The only
number that has ever predicted the future is live results, and even those only
after a few hundred trades.

---

## 13. The one-minute version

Open the console. Look at Trade, read equity and net, then the curve's shape.
Look at Hunt targets, check the passed count and read the why lines on anything
killed. If passed is zero and kills have real reasons, everything is working.
Leave it alone. Check again tomorrow.

The desk is not a slot machine. It is a filter that occasionally finds something
worth doing. Most days it will do nothing, and that is the feature.
