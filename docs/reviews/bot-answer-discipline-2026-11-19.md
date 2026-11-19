# Bot answer discipline, face damage and play styles: gate results (2026-11-19)

Evidence for [ADR 0050](../decisions/0050-bot-answer-discipline-and-play-styles.md). Everything here
is offline: bot-bench and the bot league, no model calls.

## bot-bench before the change

`bun run bot-bench run --models local:heuristic`, 50 positions, the production bot with every ADR
0043 fix: 93%. Four positions below 100%:

| Position                       | Answer                                     | Score |
| ------------------------------ | ------------------------------------------ | ----- |
| `hold-negate-for-a-threat`     | Cast Negate → Mind Stone                   | 0%    |
| `hold-the-counter`             | Cast Counterspell → Rampant Growth         | 0%    |
| `hold-the-swords-for-a-threat` | Cast Swords to Plowshares → Savannah Lions | 30%   |
| `shock-the-other-threat`       | Cast Shock → P2                            | 30%   |

After the change all four are 100% (Pass priority, Pass priority, Cast Kalonian Tusker, Shock →
Savannah Lions) and no other position moved.

## Which fix needs which

`bot-bench/src/bot-fixes.test.ts` pins each fix to its positions on two seeds. Run on its own,
`scarceAnswer` keeps Negate but then yields the turn (30% on `hold-negate-for-a-threat`); with
`neverYield` it passes. `neverYield` alone still spends Negate on Mind Stone (0%). `faceDamage`
needs `ownStack` to see that the Bolt already on the stack kills the Bears. The test records both
pairings (`BUILDS_ON`) and checks that the earlier fix alone still fails the positions.

## Held-out positions

Written after the thresholds were set and not tuned against (ADR 0043 decision 3):

| Position                       | Before (ADR 0043 bot)            | After                                  |
| ------------------------------ | -------------------------------- | -------------------------------------- |
| `counter-the-angel`            | 100%: Counterspell → Serra Angel | 100%: Counterspell → Serra Angel       |
| `bolt-the-tusker-not-the-face` | 30%: Lightning Bolt → P2         | 100%: Lightning Bolt → Kalonian Tusker |

`counter-the-angel` is the other side of `hold-the-counter`: the last counter must still answer a
real threat, so it guards against holding too much.

## Seed gate

`bot-bench run` over the eight `gate-*` seeds with `local-heuristic` (both fixes) and
`local-heuristic-0043` (the bot before them), then
`bot-bench seeds --baseline local-heuristic-0043 --candidate local-heuristic`:

```
gate local-heuristic against local-heuristic-0043: PASS (overall +7.9 points)
  higher  bolt-the-tusker-not-the-face: 30% -> 100%
  higher  hold-negate-for-a-threat: 0% -> 100%
  higher  hold-the-counter: 0% -> 100%
  higher  hold-the-swords-for-a-threat: 30% -> 100%
  higher  shock-the-other-threat: 30% -> 100%
```

Every seed scored 100% against 92%; no position is lower on any seed.

## League gate

`bun run bot-league --games 100 --seed gate-answers --a fixed --b fixed-0043 --jobs 3`, seats
swapped each seed, 120-turn cap:

| Arm          | Wins | Life share |
| ------------ | ---- | ---------- |
| `fixed`      | 44   | 0.55       |
| `fixed-0043` | 36   | 0.45       |

80 decided, 0 draws, 20 halted, 0 errors. `fixed` win rate 55%, 95% interval 44 to 66%. The gate
blocks a fix only when it loses with an interval that excludes no change; this is a win that the
interval does not confirm.

The 20 halted games stopped on the engine's `Unmodeled card "mana payment"` refusal (a casting
payment outside the proven scope). The same seeds halt with `fixed-0043` against `knowledge`, so
the halts come from the current card pool, not from these fixes.

## Play styles

Each preset on its own against the plain production bot, same decks and seeds, seats swapped:
`bun run bot-league --games 100 --seed style-exp --a <arm> --b fixed --jobs 4 --timeout-ms 300000`.

_Results pending: these runs were in progress when this was committed._

The league's decks are generated from the coverage pool. Classified the way match setup does
(`play-style.ts`), 194 of 200 seats are midrange and 6 control, with no aggro or combo. So these
runs measure what each preset does to a midrange deck, not whether matching the style to the deck
helps, and the `styled` arm (style from the deck) is nearly the plain bot on these decks.
