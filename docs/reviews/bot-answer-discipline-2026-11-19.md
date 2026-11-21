# Bot answer discipline, face damage and play styles: gate results (2026-11-19)

Evidence for [ADR 0051](../decisions/0051-bot-answer-discipline-and-play-styles.md). Everything here
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

| Arm             | Wins against `fixed` | Win rate (95% interval) | Life share | Halted, timed out |
| --------------- | -------------------- | ----------------------- | ---------- | ----------------- |
| `style-aggro`   | 54 to 38             | 58.7% (48.6 to 68.8%)   | 0.59       | 7, 1              |
| `style-control` | 42 to 45             | 48.3% (37.8 to 58.8%)   | 0.48       | 12, 1             |

No errors in either run. `style-combo` and `styled` were not run.

On generated decks, aggro was the one signal. Those decks are 97% midrange, though: 194 of 200
seats classified the way match setup does (`play-style.ts`), 6 control, no aggro or combo.

### Premade mirrors

Each preset was then tested on coverage decks built for that style, with every seat playing the
same deck (`--deck`), two seats with the preset and two without, seats swapped each seed:
`bun run bot-league --games 200 --seed mirror --deck <deck> --a <preset> --b fixed --jobs 4 --timeout-ms 300000`.
Decks were chosen by what they are built to do, from the classifier's features, because the
classifier calls every coverage deck midrange or ramp:

- aggro: `ruby-the-most-daring-of-trackers` (35 creatures, 16 with aggressive keywords) and
  `brigid-clachans-heart` (37 creatures, average mana value 2.89, go-wide tokens);
- control: `white-black-control` (13 instants, average mana value 2.5, 8 spot removal, 4 stax) and
  `pramikon-sky-rampart` (15 instants, 8 board wipes, 4 counterspells, 8 stax);
- combo: no coverage deck plays as combo, so that preset is untested.

| Deck                               | Preset          | Wins (preset to plain) | Win rate (95% interval) | Life share | Halted, timed out |
| ---------------------------------- | --------------- | ---------------------- | ----------------------- | ---------- | ----------------- |
| `ruby-the-most-daring-of-trackers` | `style-aggro`   | 102 to 98              | 51.0% (44.1 to 57.9%)   | 0.51       | 0, 0              |
| `brigid-clachans-heart`            | `style-aggro`   | 106 to 85              | 55.5% (48.4 to 62.5%)   | 0.56       | 9, 0              |
| `white-black-control`              | `style-control` | 104 to 96              | 52.0% (45.1 to 58.9%)   | 0.52       | 0, 0              |
| `pramikon-sky-rampart`             | `style-control` | 87 to 103              | 45.8% (38.7 to 52.9%)   | 0.46       | 0, 8              |
| `white-black-control`              | `style-aggro`   | 93 to 107              | 46.5% (39.6 to 53.4%)   | 0.47       | 0, 0              |
| `ruby-the-most-daring-of-trackers` | `style-control` | 54 to 146              | 27.0% (20.8 to 33.2%)   | 0.27       | 0, 0              |

No errors in any run. The matched presets are within noise of the plain bot on all four decks. The
mismatched ones lean worse, and the control preset on Ruby, an aggressive deck, loses 146 to 54.
The style matters for what the deck is about mostly as a way to lose when it is wrong; the presets
as tuned add nothing measurable when it is right.
