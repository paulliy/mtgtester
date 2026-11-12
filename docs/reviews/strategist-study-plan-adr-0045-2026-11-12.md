# ADR 0045 strategist study: plan and numbers (2026-11-12)

[ADR 0045 decision 7](../decisions/0045-strategist-critical-turns.md#7-exit) requires the study's
numbers to be committed before the first paid run. This page holds them. Nothing here has been
spent yet: the tooling is built, and everything that costs nothing has been run.

## Tooling (decision 1)

| Need                         | Where                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Capture games                | `bun run strategist-capture` (`packages/server/src/cli/strategist-capture.ts`)                                  |
| Turn-level counterfactual    | `runArm` / `runTurnStudy` in `packages/server/src/benchmark/turn-counterfactual.ts`                             |
| Seed variation check         | `seedVariationTooNarrow` in the same file                                                                       |
| Tactician and reference arms | `tacticianArm`, `referenceArm` in `packages/server/src/benchmark/turn-arms.ts`                                  |
| Evaluators per class         | `OWN_POSITION`, `SURVIVAL`, `ELIMINATIONS`, `pressureOn(seat)`, `GAME_RESULT` in `benchmark/turn-study.ts`      |
| Marking turns                | `seatTurns`, `swingTurns`, `sampledTurns`, `botArmsDisagree` in `benchmark/turn-study.ts`                       |
| Knob grid                    | `knobGrid`, `pairwiseArms` in `benchmark/turn-study.ts`                                                         |
| Verdicts                     | `verdictFor` in `benchmark/turn-study.ts`                                                                       |
| The whole study, one game    | `bun run strategist-study` (`packages/server/src/cli/strategist-study.ts`)                                      |
| Strategist flag, shadow      | `TurnStrategy.tacticianRequest`, `AI_STRATEGIST_TACTICIAN_FLAG=shadow`, `StrategyCoordinator.tacticianRequests` |
| Benchmark format             | bot-bench case `context` (strategy and deals) and `turns` (decision 6)                                          |

How a capture works. All four seats play bot-led through the production pipeline. The strategist
runs every turn (`AI_STRATEGIST_REPLAN=everyTurn`), table diplomacy is on with the heuristic
proposer, the tactician flag is in shadow, and every ADR 0044 trigger is in shadow. The output is
a `ReplayTranscript` plus, at the first decision of each seat's turn, every seat's knobs and deals.
Each tactician request records which table change would have woken the strategist under
`onChange`. An empty `wake` means production would have reused the old knobs and made no call.

How a marked turn is studied. The game is forked at the seat's first decision, and each arm plays
until the end of the seat's next turn.

- Bot arms keep their knobs until the horizon.
- The tactician and reference arms play the forked turn only. The seat then plays the card-aware
  bot with its recorded knobs.
- The other seats play the card-aware bot with their recorded knobs, frozen. No strategist runs
  inside a rollout.
- A decision the tactician's fallback bot made goes back to the rollout's bot and is never credited
  to the model.
- Trials vary only the rollout seeds, so every trial plays the same deal.

## What has been run for free

Three offline captures, using `--offline` with a stub strategist that returns fixed knobs:

| Seed    | Turn cap | Game turns | Decisions | Wall clock | Per game turn |
| ------- | -------- | ---------- | --------- | ---------- | ------------- |
| `cap-1` | 20       | 20         | 79        | 2.1 s      | 106 ms        |
| `cap-2` | 40       | 34         | 134       | 6.3 s      | 184 ms        |
| `cap-3` | 40       | 40         | 170       | 6.1 s      | 152 ms        |

The bot-led game itself is fast. A paid capture's time is the strategist's: about one call per
seat per game turn under `everyTurn` (46 calls in 34 turns for `cap-2`). Those calls are queued
off the decision path but awaited at the end. So the first paid capture is timed, and the game
count below is re-checked against it before more are run (decision 1.1).

`strategist-study` on `cap-1` (four sampled turns) and `cap-2` (six swing turns), 3 rollout seeds:

- Every marked turn passed the ADR's disagreement filter: on the same seed, two bot arms reached
  different final states. Almost any knob change alters the final state, so as written the filter
  sends nearly every marked turn to the paid tactician arm.
- With the evaluator gap alone (`own-position-v1`, a gap strictly above the margin), a margin of 4
  would have passed 3 of the 10 turns (gaps 10, 9 and 6; the others were 4, 4, 3.3, 2.3, 1.3, 1
  and 1). That margin was read off this data, from offline captures whose stub strategist always
  set `aggression 0.5`, so it is weak evidence. `strategist-study --disagree gap
--disagree-margin <n>` implements it.
- Seed variation was not too narrow: the bot arms reached different final states across seeds on
  every turn. Hidden-zone re-sampling is not needed on this evidence.
- Bot arms are free but not instant: about 15 s per marked turn for a grid of about 20 arms and 3
  seeds.

## The numbers (set before the first paid run)

| Item                        | Value                                                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Captured games              | 8: 4 with generated decks (seeds `study-1` to `study-4`) and 4 with arranged decks (`--decks`), built so that combos and deals can occur. Turn cap 40. 6 of the 8 run with the flag in shadow and 2 with `--no-flag` (the primer check, decision 5.5)                            |
| Marked turns                | Swing turns (a life change of 10 or more, a power change of 8 or more, or an elimination; the acting seat's 2 preceding own turns) plus 10% of seat-turns sampled, seeded by the capture file name. At most 12 per game (a seeded draw, not the first 12) and 80 in total        |
| Rollout seeds per bot arm   | 3                                                                                                                                                                                                                                                                                |
| Disagreement filter         | The ADR's definition, as written: a different final state on the same seed, or a gap above 2 points of the turn's named evaluator. The gap-only filter above is an option the study owner may adopt by amending ADR 0045 decision 2; this plan does not adopt it on offline data |
| K (tactician trials)        | 3 with the strategist context and 3 without, on each turn that passes the filter. A trial in which the fallback bot played any decision, or which ran after the spend cap, is discarded and not credited                                                                         |
| Margin and share (verdicts) | Margin 2 points of the turn's named evaluator. The tactician "reaches" a line when it beats the best grid arm by more than 2 and comes within 2 of the reference, in at least 2 of 3 credited trials. With no credited trials a turn gets no verdict                             |
| Confirmation                | A situation enters the catalogue only when it is confirmed on marked turns from at least 3 different games                                                                                                                                                                       |
| Seed narrowness             | Too narrow when the bot arms reach identical final states on every seed on more than half of the marked turns. Hidden-zone re-sampling is then built first                                                                                                                       |
| Pairwise follow-up          | Pairs of the single-knob arms whose mean moved the evaluator by more than the margin, run automatically whenever the reference line beats every single-knob arm                                                                                                                  |
| Spend cap                   | $15 in total, kept as a running ledger in the study notes because each command enforces only its own cap. Captures: 8 × `--max-usd 1` = $8. Tactician arms: 8 × `--max-usd 0.6` = $4.80. bot-bench positions from confirmed situations: $2                                       |

Evaluators, named before any run, by situation class:

| Class                                   | Evaluator                                        |
| --------------------------------------- | ------------------------------------------------ |
| A kill, or a missed kill                | `eliminations-v1`                                |
| Defence, or holding an answer           | `survival-v1`                                    |
| Development, mana, card advantage       | `own-position-v1`                                |
| Political: sparing or pressing one seat | `pressure-on-<seat>-v1` for the seat in question |
| Anything decided past the horizon       | `game-result-v1`, or game result only            |

Lines before arms (decision 1.5). `strategist-study --mark-only` lists the marked turns and writes
the seat's view and knobs at each fork, and runs nothing. The reviewer writes a reference line for
every marked turn into the `--lines` file from those views, before any arm runs. Each line names
the evaluator for the turn's class and records the main-thread judgements (`namingArm`,
`ruleCouldFind`, `knobCouldExpress`) with their reasons. The disagreement filter then uses the
line's evaluator.

Known fidelity gaps, accepted for the study:

- The tactician arm starts at the fork with no digest of the seat's earlier decisions; production
  has one.
- Captures use the table's heuristic deal proposer. The strategist sees deals in its prompt, but its
  own `dealProposal` is not offered at the table as a live session would offer it.
- Under `everyTurn`, the `wake` recorded with each tactician request comes from a simulated
  `onChange` (its table snapshot and reuse count), not from a real one.
- Deals: a capture records each seat's binding obligations at every turn start. Every rollout bot
  holds its seat's obligations to the horizon, and the tactician arm with context sees its own
  seat's deals. Obligations are frozen at the fork, so a deal that would have run out inside the
  horizon is held a little long, and no new deal is made inside a rollout.

How results are kept honest:

- A rollout that hits the decision limit, or ends on an answer the engine refused, is incomplete.
  It is counted in `incompleteRuns` and kept out of the filter, the grid means, the reference and
  the tactician values.
- A turn whose reference line, or whose strategist arm, never reached the horizon gets no verdict
  (`needs: completedRuns`).
- A line's evaluator is resolved by name before any arm runs, so an unknown name stops the study
  instead of scoring 0.
- `--arms` narrows the grid to named arms, for a follow-up on the knob a line names.

## Exit (decision 7)

The study stops after the 8 games and at most 80 marked turns, or at the spend cap. Its output is a
catalogue of situations: each with its frequency per game, its verdict, and the tactician's lift
with and without the strategist's context. If nothing is confirmed, strategist escalation is not
built, and whole-turn judgement positions are written by hand.

## Commands

```bash
bun run strategist-capture --seed study-1 --turn-cap 40 --max-usd 1 --out benchmark-output/study-1.json
```

```bash
bun run strategist-study --capture benchmark-output/study-1.json --mark-only --sample-rate 0.1 --max-turns 12
```

```bash
bun run strategist-study --capture benchmark-output/study-1.json --seeds 3 --sample-rate 0.1 --max-turns 12 --margin 2 --lines benchmark-output/study-1.lines.json --tactician --trials 3 --max-usd 0.6
```
