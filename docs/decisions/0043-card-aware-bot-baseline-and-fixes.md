# ADR 0043: Benchmark the bot that would actually play, then fix its gaps

Status: Accepted (2026-11-11)

Date: 2026-11-11

First of three. [ADR 0044](0044-tactician-escalation-triggers.md) decides when the bot calls the
tactician; [ADR 0045](0045-strategist-critical-turns.md) investigates turns where the strategist
should. Both depend on this one.

## Context

The first paid tactician sweep (ADR 0042: 30 positions, 14 models with reasoning off and on low,
four blind judges) measured every model against the heuristic bot. The bot scored 62%; the best
models scored 96 to 99%.

That comparison used the wrong bot. The benchmark's `local:heuristic` builds
`HeuristicDecisionProvider` without `knowledge`, the card traits ADR 0039 gives the bot in bot-led
mode (`knowledgeFor` in `ai/bot-tactician.ts`). The fallback bot that plays when a model fails in a
live game (`fallbackDecide` in `match/session.ts`) is built the same way. Re-running the 30
positions with knowledge on, with both bots on the same seeds:

|                        | Bot without card knowledge | Bot with card knowledge                                                                                                                                                    |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overall, across seeds  | 62 to 65%                  | 71 to 74%                                                                                                                                                                  |
| Fixed by knowledge     |                            | `burn-out-the-low-player`, `stoke-the-flames-lethal`, `burn-to-finish`, `hold-the-wrath`, `pyroclasm-not-wrath`, `wrath-then-rebuild`; `two-bolts-two-kills` from 0 to 50% |
| Broken by knowledge    |                            | `pump-the-unblocked-attacker`, `removal-on-the-lethal-attacker`, `overrun-for-the-kill`                                                                                    |
| Decided by a tie-break |                            | `land-for-the-turn`, `land-for-the-angel`, `firebreathing-for-exact` (with knowledge only; the plain bot always pumps before combat)                                       |
| Wrong either way       |                            | `hold-the-counter`, `keep-blockers-home`, `clear-the-blocker-and-pump`, `ramp-with-every-mana`                                                                             |

Three things in that table matter for the fixes:

- **The bot breaks ties with its seeded RNG** (`evaluate.ts`). Every land scores the same flat value,
  and `pass` and `passAndYieldTurn` score the same baseline. Three positions flip with the seed
  alone, and the totals move about three points with no code change.
- **The plain bot's results on two positions were option order.** Without knowledge a target slot's polarity is
  neutral and the bot takes the first option. That happened to be the right creature in
  `pump-the-unblocked-attacker`, and exiled its own Tusker in `removal-on-the-lethal-attacker`.
- **What remains is computable from the seat's `PlayerView`:** counting lethal, choosing which threat
  kills you, letting your own spell resolve, trying casting orders, counting coloured sources and
  pricing the opponents' next attack. Bot fixes cost nothing per game; a model call costs every time.

## Decision

### 1. Measure the bot that would actually play

1. **One bot in every seat it plays.** The fallback bot (`fallbackDecide`) and the heuristic bot
   seats of a live table (the heuristic seat factory in `match/session.ts`) get card knowledge
   (`knowledgeFor(engine)`), so the bot in bot-led mode, the one that answers when a model fails and
   a table's bot opponents are the same bot. bot-bench's table opponents stay plain, so the
   reference lines already recorded against them keep holding.
2. **The benchmark follows it.** `local:heuristic` keeps meaning "the production fallback" and so
   gains card knowledge. `local:heuristic-plain` keeps the old baseline. Results stored from the
   first sweep under `local:heuristic` are not comparable with new runs; the run manifest says
   which was used.
3. **A `bot-led` lineup kind.** It plays a case through the production pipeline in bot mode: the bot
   answers, and escalation rules decide when a named model is asked. Today `resolveLlmConfig` forces
   `tacticalMode: 'model'`. Each case records how many decisions were escalated and why. ADR 0044
   uses this kind to judge its triggers.
4. **A seed option for local and `bot-led` entries.** Today the local bot's seed is the fixed label
   `bot-bench-actor:<case id>`. The gate's eight seeds are checked into the lineup file, so every run
   of the gate uses the same ones; ADR 0044's gate runs the `bot-led` kind across the same seeds.

### 2. Fix the bot

All fixes live in the bot's policy (`packages/bot`), never in legal-action generation
([rules-engine constraints](../guides/rules-engine-constraints.md)). The bot sees only a
`PlayerView`, depends only on `@mtg/shared`, and stays seeded. Two fixes need data the bot does not
have today; those changes reach `@mtg/shared` or the server's card-trait classifier, and are
reviewed as engine-facing changes, not bot-only ones.

| Fix                                                                                                                                                                                                                       | Positions                                                                                     | Notes                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let your own spell resolve: count only opponents' stack objects as "responding", and discount damage already on the stack                                                                                                 | `two-bolts-two-kills`, the pre-combat pump in `clear-the-blocker-and-pump`                    | Today any non-empty stack counts as responding (`idleReactivePenalty` in `policy.ts`)                                                                                                              |
| Never yield the turn while holding a usable instant-speed action and the mana for it                                                                                                                                      | `firebreathing-for-exact`                                                                     | Breaks the `pass` / `passAndYieldTurn` tie that forfeits the combat pump                                                                                                                           |
| Count lethal before choosing a target: remove the creature that kills you rather than the biggest; pump the unblocked attacker; remove the blocker that stops a kill                                                      | `removal-on-the-lethal-attacker`, `pump-the-unblocked-attacker`, `clear-the-blocker-and-pump` | Needs which player each attacker is attacking, which `PermanentView` does not carry today, and pump sizes, which `CardTraits` does not                                                             |
| Value a spell that makes lethal above card draw                                                                                                                                                                           | `overrun-for-the-kill`                                                                        | The bot plays the land first, then rates Harmonize above Overrun. Needs pump size and granted keywords (Overrun's trample) in `CardTraits`                                                         |
| Choose casting order by trying the orders of the castable spells (land drop first, at most four spells, so at most 24 orders, one turn) on a mana model built from the view: lands, rocks and creatures that tap for mana | `ramp-with-every-mana`                                                                        | No engine clone. Draws and searches are unknown outcomes, not simulated                                                                                                                            |
| Count coloured sources when choosing a land                                                                                                                                                                               | `land-for-the-angel`, `land-for-the-turn`                                                     | The bot has no colour logic today; equal land scores fall to the RNG. Also fixes the stale comment in `isUncertain` that skips land close calls because "the bot's color logic already handles it" |
| Before attacking, compare the opponents' untapped power next turn with your life and the blockers you keep                                                                                                                | `keep-blockers-home`                                                                          | Replaces today's reserve, which keeps only the single highest-toughness creature home. Vigilance is read from `keywords`, so the Angel still attacks                                               |

`hold-the-counter` is left to ADR 0044: whether to spend a counter on a spell that is not lethal is a
judgement about threats not yet seen, not arithmetic.

### 3. The gate

Each fix is gated in three ways:

1. **Seeds.** bot-bench runs the bot over a fixed set of eight seeds. A fix must raise the overall
   score and must not lower any position's mean score across the seeds, partial-credit positions
   included.
2. **Variants.** Positions an option order or a tie can decide get reordered variants, so a fix
   cannot pass by luck: `pump-the-unblocked-attacker`, `removal-on-the-lethal-attacker` and the two
   land cases.
3. **Games.** Each fix ships behind a policy option with its own `bot-league` arm, since the league
   picks arms from a fixed table of option flags. The league plays the fixed bot against the current
   card-aware bot, seats swapped each seed. A fix is blocked when its win rate is lower and the
   interval excludes no change. At 100 games the interval is about 10 points either way, so it only
   catches large regressions. The fixes that touch most decisions run 400 games (about 5 points):
   letting your own spell resolve, never yielding, and the attack reserve.

Each fix also adds at least one new position it was not tuned on, kept out of its own tuning.

## Consequences

- The tactician's lift from the first sweep was measured against the bot without card knowledge.
  Against the card-aware bot it is about 8 to 12 points smaller, and it shrinks again as each fix
  lands. That is the intended direction.
- The fallback bot changes behaviour in model mode too, wherever a model fails, and so do a live
  table's bot seats. Seeded tests that depend on their choices may need updating.
- The never-yield rule makes a bot holding an instant take every priority window instead of
  yielding: more decisions per turn and, in bot-led mode, more chances to escalate. ADR 0044's call
  census counts them.
- bot-bench becomes the bot's regression suite as well as the model benchmark. The fixes are tuned
  against 30 hand-written positions, so the held-out positions and the league gate are what guard
  against overfitting.
- With these fixes in, few positions still need a model (`hold-the-counter` and, perhaps,
  `clear-the-blocker-and-pump`). ADR 0044 owns new single-decision positions for its triggers; ADR
  0045's confirmed situations cover whole turns.
