# Hill climbing: measure, change, compare, keep only real wins

`bun run hill-climb` is the one command for performance and cost work. It measures the metrics
below, compares them with a baseline, and exits 1 when anything regressed or a benchmark game
played differently. It uses no network and no paid model.

## What it measures

| Metric                                                   | What it is                                                                                                                                                                                | Kind  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `engine.msPerDecision`                                   | Engine time per decision over the seeded benchmark games (`engine-bench` pods). The mean, so the slowest game dominates it.                                                               | timed |
| `engine.medianGameMsPerDecision`                         | The same, for the median game: what a typical game costs.                                                                                                                                 | timed |
| `setup.msPerGame`                                        | Time to construct a four-player game: card interpretation, shuffles, opening hands.                                                                                                       | timed |
| `model.<mode>.callsPerTurn`                              | Tactician plus strategist calls per turn, from the call census on fixed decks. Modes: `default` (what a new game uses), `model`, `bot`.                                                   | exact |
| `model.<mode>.promptTokensPerTurn`                       | Prompt tokens those calls would send per turn.                                                                                                                                            | exact |
| `coverage.edhrecModeledCards`                            | Pinned EDHREC cards the interpreter models with no reasons, computed live.                                                                                                                | exact |
| `coverage.edhrecSlotSharePct`                            | Share of all EDHREC deck slots those cards fill.                                                                                                                                          | exact |
| `coverage.fixtureDeckCardsModeledPct`                    | Share of the coverage decks' cards that model.                                                                                                                                            | exact |
| `coverage.compilerRefusals`, `coverage.playableDecksPct` | Read from `primitive-backlog.json` and `deck-coverage.json` when those reports exist.                                                                                                     | exact |
| `compiler.textCheckSettledPatches`                       | Committed card-compiler trial patches the free text check settles with no model call (`scripts/card-compiler/settle.ts`). Guarded by `text-check.test.ts` against settling a wrong patch. | exact |
| `compiler.textCheckPoolMatches`                          | Modeled pinned-pool cards whose parsed IR renders to exactly their Oracle text: renderer coverage on the lines future patches look like.                                                  | exact |
| fingerprints                                             | One hash per benchmark game over every decision request, every answer and the event log.                                                                                                  | exact |

Exact metrics repeat to the last digit on any machine, so any move in the wrong direction fails.
Timed metrics only count as changed when they move by more than the noise: 10% when both sides
were measured with `--repeat 3` on one machine, 30% with fewer repeats or across machines
(scaled by a calibration run), and never less than twice the spread between repeats.

## The loop

1. **Measure the base.** On a clean checkout of the commit you start from:
   `bun run hill-climb --repeat 3 --save <scratch>/before.json`
2. **Change one thing.**
3. **Compare on the same machine.**
   `bun run hill-climb --repeat 3 --against <scratch>/before.json`
4. **Keep it only if it is a real win.** The table must show `IMPROVED` on the metric you aimed
   at, no `REGRESSED` row, and `games: all N fingerprints identical`. An `UNCHANGED` verdict means
   the change is inside the noise: drop it, however good the idea looked.
5. **Bank it.** In the pull request, paste the comparison table. Then run
   `bun run hill-climb --write-baseline` on the committed change and commit the baseline, so the
   next climb starts from the new level.

Use `--quick` (about 20 seconds) while iterating and `--only engine,setup` to skip probes you are
not working on. Quick timings are short and noisy: make the keep-or-drop call on the standard
profile.

## Rules

- A performance change must leave every fingerprint identical. If one differs, the change altered
  play: fix it, or treat the work as a behaviour change with its own tests.
- A rules, bot or card change that is meant to alter play passes `--allow-behavior-change`, says so
  in the pull request, and rewrites the baseline. The exact metrics still may not regress without
  a stated reason.
- Do not time anything while the test suite or another benchmark runs on the machine, and never
  compare a profiled run (`--cpu-prof`) with an unprofiled one.
- Do not edit the baseline by hand, and do not rewrite it to make a regression pass.
- A change that trades one metric for another (fewer calls for weaker play, say) needs the quality
  evidence too: `bun run bot-league` for the bot, a duel for the models. Paid model runs need
  Paul's approval first.

## What guards main

`packages/server/src/hill-climb/probes.test.ts` runs in the normal test suite. It recomputes the
exact model-call and coverage metrics and fails when one is worse than
`packages/server/fixtures/hill-climb-baseline.json`. Timings and fingerprints are checked by the
command, not by the suite, because timings are not trustworthy while tests share the machine and
fingerprints change with every intended rules or card change. If main changed the games after the
baseline was written, the command says so: compare with `--against` a report from your base commit.

## Adding a metric

Add it to a probe in `packages/server/src/hill-climb/probes.ts` (or add a probe to `PROBES`), give
it a `better` direction and a kind, rewrite the baseline, and add a row to the table above. Prefer
exact counters over timings: a count of work done is a gate on every machine.
