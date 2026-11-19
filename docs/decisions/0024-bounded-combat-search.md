# 0024 — Bounded combat search for the heuristic bot (ADR 0023 Phase 7)

Date: 2026-08-06

Status: Accepted (2026-11-14)
Status note: accepted in part. Phases 7-pre, 7a, 7b and 7c are built (`packages/bot/src/combat-search.ts` searches block declarations and damage division, and `bun run combat-sweep` measures it). Phase 7d, the attack-declaration search, is not built. It was Proposed until 2026-11-14, although the shipped code already cited it.

## Context

ADR 0023 built a heuristic bot (`packages/bot`) that scores every decision — including combat —
as a one-shot evaluation of the _current_ board (`evaluate.ts`). That is a reasonable model for
most decisions (cast this spell, play this land: consequences are local and immediate) but it is
known-weak for combat specifically. A block or damage-split choice's real cost often only shows up
a turn later: a chump-block that turns out to matter once a wrath resolves, a trade that opens a
lethal swing back, a damage split that leaves the wrong creature alive. 0023 named this gap and
deliberately deferred fixing it (its Phase 7 row: "Deferred, optional, separately-scoped — bounded
combat search"), because the prerequisite — some form of lookahead — runs into a real constraint:

> Full fork-based MCTS remains unavailable while the engine is generator-driven [...] Neither claim
> rules out _bounded_ search that doesn't need to clone the whole engine [...] If full-engine search
> ever becomes desirable, the prerequisite is still a cloneable state representation, and that
> should be its own ADR.

0023 named two plausible bounded techniques without committing to either:

1. **Seed-replay branching** — since every game is fully seeded (brief §5.9), reach a hypothetical
   alternate branch by replaying recorded decisions from the seed and diverging at the fork. Exact,
   but expensive: a full generator re-run per hypothetical.
2. **Combat-only structured search** — restrict the search to the attack/block candidate space
   itself, validate candidates with the engine's own legality checks, and estimate the opponent's
   response with a cheap greedy/beam-limited heuristic rather than full search.

This ADR picks between them and defines a minimal, shippable Phase 7.

## Decision

Adopt **technique 2 (combat-only structured search)** as the primary mechanism. Seed-replay
branching is exact but pays a full engine re-execution per hypothetical branch explored, which is
disproportionate for what is, in the cases that matter, a same-phase, single-decision lookahead.

1. **Scope is all three combat decisions: block declaration, combat-damage-split, and attack
   declaration.** An earlier draft of this ADR excluded attack declaration on the grounds that
   "the attacker already benefits from `evaluate.ts`'s threat-weighting against public
   information (0023 item 8)". **That premise does not hold.** `evaluate.ts`'s
   `attackDeclarationTargets` filters `NO_ATTACK_TARGET` out of each slot's options and then
   picks, from what remains, the opponent with the lowest life — so whenever a creature _can_
   attack it _does_, every turn, into any board. There is no threat weighting and no attack/hold
   judgment; `veto.ts` does not compensate, since it guards life payment only. The attacker side
   is not adequately scored, it is barely scored, and the asymmetry this ADR was built around is
   an artifact of the draft rather than of the code.

   The defending side still comes first, because that is where the "wrong choice costs you a turn
   later" failure mode is sharpest and because the attacker search depends on it — see item 3.

2. **A separate, minimal `CombatSnapshot`, not a `GameState` clone.** The search operates over just
   what a single combat phase needs to resolve — attacker/blocker power, toughness, and the
   keywords that change combat math (first strike, deathtouch, trample, indestructible, menace) —
   built once per decision from the same `PlayerView` the bot already has. It is never a general
   engine clone, and it carries no reference to full game state.

   **This has an unmet prerequisite.** `PlayerView` cannot supply those keywords today:
   `PermanentView` (`packages/shared/src/view.ts`) carries `power`, `toughness`, `tapped`,
   `status[]` and `blockedBy` and no keyword list, and the batched block option's
   `data.subjects` (`combat.ts`'s `buildBlockOption`) carries only
   `subjectId`/`power`/`toughness`/`mustBlock`. 0023 scoped the projection as its **item 20**
   and it did not land — `evaluate.ts`'s damage-split code still reads "lethal" as plain
   toughness for exactly this reason. Item 20 must ship first, widened to the union of both
   lists: 0023 named deathtouch, first strike, trample and lifelink; this ADR also needs
   indestructible and menace. See the prerequisite row in the sub-phasing table.

3. **Search shape, bounded on both axes:**
   - Generate a **top-K candidate set** of block assignments, seeded from `evaluate.ts`'s existing
     scoring (not exhaustive enumeration — a wide board makes the full assignment space
     combinatorial).
   - For each candidate, resolve combat on the snapshot, then run a **single greedy 1-ply estimate**
     of the opponent's best response (attack-back or obvious removal) using the same `evaluate.ts`
     scoring against the resulting snapshot.
   - Score candidates on (post-combat board + 1-ply opponent response) instead of Phase 4's
     (post-combat board) alone; pick the max.
   - **On the attacking side the 1-ply response is the defender's block declaration**, which is
     the same combinatorial space the blocking search already explores. So the attacker search
     does not need its own opponent model: it reuses the block search, run for the defender, as
     its response estimate. This is the concrete reason attack declaration sequences _after_
     blocks rather than beside them — and it is also where the compute bound bites hardest, since
     a naive reading nests one bounded search inside another. The attacker's response estimate
     therefore runs the block search's **greedy top-1**, not its full top-K.

4. **Legality is never delegated to the snapshot — the search only ever reorders options the
   engine already offered.** The bot does not construct block assignments. It receives a
   per-blocker menu (`LegalAction.targets[].options`, built by `combat.ts`'s `buildBlockOption`)
   and picks one entry per slot; the engine then re-checks the assembled declaration and fixes it
   through `repairBlockDeclaration`. So the search's candidate set is a **permutation of the
   engine's own legal menu**, never a superset of it, and the snapshot informs scoring only.

   Stated this way deliberately, because the obvious alternative phrasing — "validate each
   candidate through `combat.ts`'s `validateBlockDeclaration`" — is not implementable and would
   send an implementer the wrong way. That function is module-private, takes engine state, and
   the bot only ever holds a `PlayerView`; reaching it would mean either exporting engine
   internals into `packages/bot` or handing the bot `GameState`, and the second breaks the
   hidden-information rule (brief §7.1) this ADR commits to in item 7. The property wanted here
   — "engine is authoritative on legality" (brief §1.2) — already holds structurally, for free,
   exactly the way 0023 arranged it.

5. **A hard bound with a static fallback, not a timeout.** If candidate count or combat width
   exceeds a fixed bound, skip search entirely and fall back to Phase 4's existing static
   heuristic. **Starting values: top-K = 8, and a width cutoff of 6 blockable attackers or 8
   total permanents in combat.** These are picked, not derived — see "Choosing the bounds" below
   for how they get corrected. This mirrors the
   project's existing cost-consciousness (brief §5.1, "no AI call when there's only one legal
   action") applied to compute cost instead of API cost — search is an enhancement, never a
   dependency.

6. **Determinism is non-negotiable.** No `Math.random()` anywhere in the snapshot simulator or
   candidate generation (brief §4/§5.9). Any tie-breaking among equally-scored candidates draws from
   the bot's existing seeded RNG (`packages/bot/src/rng.ts`).

7. **The snapshot must not leak hidden information.** It is built from the deciding seat's own
   `PlayerView`, exactly like every other bot decision — never from `GameState`. The 1-ply opponent
   estimate scores what the _view_ shows, not what the engine internally knows; this needs explicit
   test coverage because it is a new code path that constructs its own state object rather than
   reading one the engine already scoped correctly.

### Non-goals

- No `GameState` cloning, now or as an implicit stepping stone.
- No multi-turn lookahead — one combat phase, one opponent-response ply. Deeper search is future
  scope, not this phase.
- No change to mana decisions or any non-combat decision type.
- No dependency on Phase 6 (offline weight tuning). The bounds are tuned against seeded games with
  the tooling that exists today — see "Choosing the bounds".

## Consequences

- Closes the lookahead gap 0023 identified for the specific decisions where it costs games, without
  requiring a cloneable engine or reopening the MCTS/RL rejection from 0023's Context section.
- Adds a second, parallel combat-resolution model (the snapshot simulator) that must stay in sync
  with `combat.ts`'s real keyword/damage rules. This is a real maintenance cost and a drift risk:
  any future combat rules fix in `combat.ts` (new keyword support, a CR correction) needs a matching
  update in the snapshot, or the search starts scoring against rules the engine no longer has.
- Adds nonzero compute cost per combat decision. Bounded by design (top-K, 1-ply, hard width
  cutoff), but still real, and worst on the attacking side, where the response estimate is itself a
  search — which is why item 3 caps that inner run at greedy top-1. Needs measurement once built,
  not assumed free; that is what the sweep below is for.
- Needs its own fixture-driven test suite comparing the snapshot simulator's predicted outcomes
  against `combat.ts`'s actual resolutions across a battery of hand-built board states (multi-block,
  first strike, trample, deathtouch, menace, indestructible), independent of the bot's own tests —
  this is what catches drift from item above before it silently degrades decision quality.

## Success criterion, and choosing the bounds

The search must be shown to beat the Phase 4 static heuristic before each sub-phase is considered
done, and the bar has to be measurable: this ADR's premise is that the failure mode shows up **a
turn later**, which is precisely the kind of thing that cannot be judged by watching a game or by
inspecting a single decision. Without a stated bar, the work cannot be evaluated and the bounds
have nothing to tune against.

**The bar:** bot-with-search versus bot-without, over a fixed set of seeded games, on head-to-head
win rate — with the per-decision compute cost from Consequences reported alongside it, since a
win-rate gain bought at an unacceptable latency cost is a different decision than a free one.

**Correction, from building 7c:** an earlier draft of this paragraph said that because both arms
are deterministic under the same seeds (item 6), the comparison "is exactly reproducible and needs
no statistical machinery beyond a large enough sample". The first half is true and the second does
not follow from it. Determinism buys _reproducibility_ — the same seeds give the same games on
every run — and buys nothing at all in _precision_. A configuration that never changes a single
decision does not land on 50%; it lands wherever that particular set of seeds and decks happens to
put it. The sample-size arithmetic is exactly what it would be for a coin: at 120 games one
standard error is about 4.5 points. The sweep tool prints this alongside its own results so the
numbers cannot be read as tighter than they are.

### Choosing the bounds

Top-K and the width cutoff are **picked and then corrected against results**, not derived and not
gated on Phase 6's offline weight tuning. Item 5's starting values (top-K 8; cutoff at 6 blockable
attackers or 8 permanents in combat) are a deliberate guess; the measurement above is what makes
them honest. Sweep each axis independently over a small range, keep what wins, and record the
numbers that were tried alongside the ones that were kept — a bound that turns out not to matter
is as useful to know as one that does.

Two failure modes bound the sweep on either side, and both are visible in the same run: too small
a K (or too aggressive a cutoff) shows up as no measurable win-rate gain over Phase 4, and too
large shows up as per-decision cost climbing without the win rate following.

### What 7b actually cost (measured, not assumed)

The Consequences section above says the per-decision compute cost "needs measurement once built,
not assumed free". For the blocking side that measurement now exists, taken at the widest boards
the cutoff admits, 200 iterations each:

| board                     | per block decision |
| ------------------------- | ------------------ |
| 6 attackers × 2 blockers  | 0.74 ms            |
| 3 attackers × 5 blockers  | 1.04 ms            |
| 4 attackers × 4 blockers  | 1.25 ms            |
| anything above the cutoff | declines, ~0 ms    |

Engagement, over five seeded four-player `pool --play` games: **49 of 51** block declarations were
searched, the other two declining on width. Damage division came up **once in five games** — it
was then offered only with 2+ live blockers on one attacker. That implementation omitted the
single-blocker trample choice: CR 702.19b lets the attacker assign excess either to the blocker
or to the defending player. The engine now offers that choice whenever excess is available.

> Corrected by 7c'''s larger sample: damage division is rarer than block declaration but not that
> rare. Over 120 games it came up 64 times against 668 block declarations, so about once every two
> games rather than once every five. Five games was simply too small a sample to rate it.

So the cost is real but small, and the cutoff is currently doing very little: it fires on about 4%
of decisions. That is a fact for the sweep to act on — the width bound has room to widen before
cost becomes the binding constraint, and `topK` is the likelier lever.

### What 7c built, and the three bugs it had to get past first

The harness is `bun run combat-sweep` (`packages/server/src/cli/combat-sweep.ts`), and it is the
thin script this section anticipated — with one structural surprise.

**How the arms are compared.** Both arms play in the _same_ game: two seats run the search, two run
the Phase 4 heuristic, on identical decks from one seed. Four search bots in one game and four
static bots in another would be two populations with no common opponent and no way to attribute a
win. Which pair of seats searches alternates by game index, so each arm holds the first-player seat
exactly half the time; turn order is worth enough in Commander to swamp the effect otherwise.

**Each game runs in its own process, under a wall-clock kill from the parent.** This is the
surprise, and it is not defensive over-engineering. A game can spin inside a single
`Engine.advance()` call without surfacing a decision or advancing a turn, and when it does, the
engine's own runaway guards cannot fire: the turn cap in `flow/game.ts` and `runToCompletion`'s
`maxDecisions` both assume the game keeps _reaching_ them. The loop is synchronous JavaScript, so
no timer fires and nothing in the same process can interrupt it. The wall clock deliberately lives
in the parent and never in the engine — a timeout that could halt a game would make outcomes depend
on machine speed, and every game is supposed to be reproducible from its seed alone (brief §4,
§5.9). Here it only decides whether a result is _counted_, never what any result is. The decks
cross the process boundary as JSON; that round-trip is verified game-identical.

**Three pre-existing bugs surfaced before any measurement was possible.** None was caused by the
search — all three reproduce with the search disabled — and they are recorded here because they are
the reason 7c took the shape it did:

1. **The repeat-activation damper had a hole for free abilities** (ADR 0023 item 5). Its whole
   mechanism is decaying the benefit and subtracting a fixed cost, and `weights.ts` said as much:
   "a fixed cost subtracted after decay is what lets repeated activation eventually score below
   `pass`". That silently assumed every repeatable ability _has_ a cost. A `{0}` ability scores
   `tempo.activateAbility * 0.6^n - 0`, which is positive at every n and beats `pass` forever. A
   Hyalopterous Lemure put **1,270 copies of its own `{0}` ability on the stack** in one priority
   window and the turn never ended. Fixed by `WEIGHTS.repeatActivationPenalty`, a flat per-repeat
   charge that makes the score actually cross zero. This one was affecting live games, not just
   the harness — every bot seat uses the same scorer.
2. **A targeted spell cast for an alternative cost carried no target slots.** `legal.ts`'s
   `nonMana` branch computed `computeCastTargets` and used it to gate castability (CR 601.2c), then
   never attached it to the option it built — unlike the `energy` and `commanderFree` branches
   beside it. Any caller filling targets from the offered menu sent nothing for slot 0 and the
   engine threw "missing target for slot 0". A one-line omission; fixed, with a regression test
   that reads the slots off the offered option. The existing Force of Will test could not catch it
   because it builds its own target map by hand, which is precisely the step that was broken.
   `overload`, `adventure` and `omen` never compute targets at all — a wider gap, left alone
   because it needs intent this ADR does not have.
3. **Twilight Diviner loops on its own token.** Its "a creature enters from a graveyard" trigger
   fires on the copy token it just created, so the battlefield grows without bound. This is a
   card-modelling loop and belongs to the coverage stream, not here. It is why the harness needs
   process isolation rather than one more targeted fix: the next such card would take the run down
   again.

**What this needs that does not exist yet:** `bun run play-decks` runs exactly one seeded game per
invocation and reports no aggregate. A multi-seed loop that runs N games across both arms and
prints win rate and per-decision timing is a thin script over the existing CLI, and it is the only
new tooling this ADR requires — deliberately much less than 0023's Phase 6 harness, which remains
deferred and is not a dependency of this work.

### The first bound sweep, and what it says

`bun run combat-sweep --games 120 --seed sweepA --top-k 1,2,4,16 --max-permanents 12`. Each row is
120 four-player games; the search arm holds two seats and the Phase 4 heuristic the other two, in
the same games. "engaged" is the share of block declarations the search actually ran on rather than
declining; "marginal" is the millisecond cost the search adds per combat decision on top of what
the control arm already pays to score the same menu.

| configuration           | search | control | win%  | engaged       | marginal |
| ----------------------- | ------ | ------- | ----- | ------------- | -------- |
| shipped (topK 8, cut 8) | 61     | 56      | 52.1% | 95% (634/668) | 0.288 ms |
| topK = 1                | 58     | 59      | 49.6% | 89% (622/696) | 0.244 ms |
| topK = 2                | 59     | 58      | 50.4% | 94% (645/686) | 0.240 ms |
| topK = 4                | 61     | 56      | 52.1% | 94% (632/670) | 0.274 ms |
| topK = 16               | 61     | 56      | 52.1% | 95% (634/668) | 0.253 ms |
| maxPermanents = 12      | 61     | 56      | 52.1% | 95% (636/668) | 0.276 ms |

Three things fall out, and only one of them is about win rate.

**Top-K is saturated at 8, provably.** `topK = 16` did not merely score the same as the shipped
default — it produced _identical_ counters in every column: same 634 searched, same 34 declined,
same 61 damage divisions, same wins. Two runs that diverged anywhere would have diverged in the
number of block decisions the rest of the game produced, and they did not diverge at all. Across
634 block declarations the wider beam never once picked a different assignment. Whatever K=8
misses, K=16 misses too, so the answer is not more breadth.

**The width cutoff is not the binding constraint, and 7b predicted this.** Raising it from 8
permanents to 12 unlocked **two** additional searched decisions out of 668 and changed no outcome.
The cutoff fires on about 5% of decisions; nearly all of that 5% is boards wide enough that 12 does
not help either.

**Marginal cost is flat in K** — 0.24 to 0.29 ms with no trend, and `topK = 1` is not meaningfully
cheaper than `topK = 16`. The cost is dominated by building the snapshot and running the 1-ply
exposure estimate, both of which happen once per candidate-set rather than per candidate. So there
is no cost argument for lowering K either: the bound this ADR spent its Decision item 5 on turns
out to govern almost nothing. That is worth knowing precisely because item 5 assumed otherwise.

Only the K = 1 and K = 2 rows differ from the rest, and by one game each. A beam of 1 is pure
greedy, so _some_ breadth matters; whatever it buys is bought entirely by K = 4.

### Does 7b meet this ADR's bar? Yes.

Two independent 600-game batches on disjoint seeds — `sweepB` was run as a replication of
`sweepA`, at a sample size fixed in advance, with fresh seeds and therefore fresh decks:

|                            | sweepA         | sweepB         | combined                 |
| -------------------------- | -------------- | -------------- | ------------------------ |
| decided games              | 577            | 574            | **1151**                 |
| search / control wins      | 311 / 266      | 312 / 262      | 623 / 528                |
| **per-seat win rate**      | 26.9% vs 23.1% | 27.2% vs 22.8% | **27.1% vs 22.9%**       |
| **relative gain per seat** | +16.9%         | +19.1%         | **+18.0%**               |
| arm-level win share        | 53.9%          | 54.4%          | 54.1% (95% CI 51.2–57.0) |
| two-sided p vs a 50% null  | 0.061          | **0.037**      | **0.005**                |
| marginal cost              | 0.25 ms        | 0.21 ms        | ~0.23 ms                 |

**Read the per-seat row first.** A four-player free-for-all gives every seat a 25% baseline. The
search seats win **27.1%** of their games against the control seats' **22.9%** — they win about
**18% more often** — from a change that touches only blocking and damage division and costs a
quarter of a millisecond per combat decision.

**The bar is met.** The combined 95% interval excludes 50%, two-sided p = 0.005. More convincing
than the pooled number: `sweepB` reached p = 0.037 **on its own**, out of sample, with an effect
size within two points of `sweepA`'s. That is a replication, not a longer look at the same data —
which matters, because the sample was extended more than once and a result that only appeared after
pooling would deserve suspicion. This one does not depend on pooling.

The arm-level row is the same fact stated against the metric as measured, where the null is 50%
because each arm holds two of four seats. Both describe one outcome; the per-seat one is what the
effect means.

One caveat that survives: **the cost figure is far better established than the win rate.** Roughly
6,600 searched block declarations across the two batches is a large sample for timing and a modest
one for wins, because the win rate gets only one observation per game.

Where the remaining upside is: the bounds are now known **not** to be the lever — every row of the
bound sweep says so, and `topK = 16` came out bit-identical to `topK = 8`. That leaves the
**weights**. `creatureBaseValue` in particular is a number picked to make orderings come out right,
never measured, and no sweep of the weights has been run at all. That is ADR 0023's deferred Phase
6, which this ADR declared a non-dependency — a call that was right for building 7b and looks wrong
for tuning it further.

### A fourth pre-existing bug — and the harness as an accidental fuzzer

The two 600-game runs excluded 48 games between them (46 threw, 2 never terminated), and each
surfaced **12 distinct failure signatures** — none caused by the search, all reproducible with it
disabled:

- `Dethrone — put a +1/+1 counter on this creature used 'triggerObject' with no trigger object`,
  on three different creatures
- `value "xValue" needs a resolving ability's scope — use evaluateValueIn`, and the same for
  `countersOnSelf`
- `payment source vanished`, `cost for P4 became unpayable at application time`,
  `sacrifice cost became unpayable`, `spell to cast not found`
- a raw `TypeError: undefined is not an object (evaluating 'perm.name')`

That is the more valuable output of this sub-phase than the win rate, and it was not a goal of it.
Six hundred seeded four-player games with a deterministic bot is a rules fuzzer, and nothing else
in the project runs one: `bun run coverage` checks that cards can be _modelled_, not that they
survive being _played_ for fifty turns against three opponents. These belong to the card stream,
and the list above is a work queue for it.

At about 4% of games excluded they do not threaten the measurement — but the harness reports
exclusions in its own output rather than dropping them quietly, precisely so this list exists.

## Resolved questions

Both of this ADR's original open questions are now decided:

- **The top-K and width-cutoff values are picked, then corrected by measurement** — not derived up
  front and not blocked on Phase 6. See "Choosing the bounds".
- **Attack declaration gets the same treatment**, as its own sub-phase after the blocking side.
  The asymmetry the first draft assumed does not survive contact with `attackDeclarationTargets`
  — see Decision item 1.

## Suggested sub-phasing

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7-pre | **ADR 0023 item 20's `PermanentView.keywords: string[]` projection**, widened to cover deathtouch, first strike, trample, lifelink, indestructible and menace. Blocks 7a — see Decision item 2. Independently useful to the LLM path and the browser, as 0023 already noted. **Built.**                                                                                                                                    |
| 7a    | `CombatSnapshot` + resolution simulator, with fixture tests against `combat.ts`. No bot wiring. **Built.**                                                                                                                                                                                                                                                                                                                 |
| 7b    | Top-K candidate generation + 1-ply opponent scoring, wired into `blockDeclarationTargets`/`combatDamageSplitFor` behind a bound/fallback per Decision item 5. **Built** — `packages/bot/src/combat-search.ts`; costs above.                                                                                                                                                                                                |
| 7c    | The multi-seed measurement loop over `play-decks`, and the first bound sweep against it. Gates 7b's numbers; gives 7d something to measure against. **Built** — `bun run combat-sweep`. No bound in the swept range moves the result. 7b lands at **27.1% vs 22.9% per seat** against a 25% baseline (**+18% relative**) over 1,151 games in two independent batches, two-sided p = 0.005 — **the bar is met**. See above. |
| 7d    | Attack declaration: candidate attack sets scored against the 7b block search run as the defender's greedy response (Decision items 1 and 3).                                                                                                                                                                                                                                                                               |

Each sub-phase is independently shippable and stops at a boundary for approval, per brief §14 — the
same convention 0023 followed throughout.
