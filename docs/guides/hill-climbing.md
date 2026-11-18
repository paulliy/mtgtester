# Hill climbing: measure, change, compare, keep only real wins

`bun run hill-climb` is the one command for performance and cost work. It measures the metrics
below, compares them with a baseline, and exits 1 when anything regressed or a benchmark game
played differently. It uses no network and no paid model.

## What it measures

| Metric                                                   | What it is                                                                                                                              | Kind  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `engine.msPerDecision`                                   | Engine time per decision over the seeded benchmark games (`engine-bench` pods). The mean, so the slowest game dominates it.             | timed |
| `engine.medianGameMsPerDecision`                         | The same, for the median game: what a typical game costs.                                                                               | timed |
| `engine.work.<counter>`                                  | Exact counts of the engine's expensive operations over the same games: see below.                                                       | exact |
| `setup.msPerGame`                                        | Time to construct a four-player game: card interpretation, shuffles, opening hands.                                                     | timed |
| `model.<mode>.callsPerTurn`                              | Tactician plus strategist calls per turn, from the call census on fixed decks. Modes: `default` (what a new game uses), `model`, `bot`. | exact |
| `model.<mode>.promptTokensPerTurn`                       | Prompt tokens those calls would send per turn.                                                                                          | exact |
| `coverage.edhrecModeledCards`                            | Pinned EDHREC cards the interpreter models with no reasons, computed live.                                                              | exact |
| `coverage.edhrecSlotSharePct`                            | Share of all EDHREC deck slots those cards fill.                                                                                        | exact |
| `coverage.fixtureDeckCardsModeledPct`                    | Share of the coverage decks' cards that model.                                                                                          | exact |
| `coverage.compilerRefusals`, `coverage.playableDecksPct` | Read from `primitive-backlog.json` and `deck-coverage.json` when those reports exist.                                                   | exact |
| fingerprints                                             | One hash per benchmark game over every decision request, every answer and the event log.                                                | exact |

Exact metrics repeat to the last digit on any machine, so any move in the wrong direction fails.
Timed metrics only count as changed when they move by more than the noise: 10% when both sides
were measured with `--repeat 3` on one machine, 30% with fewer repeats or across machines
(scaled by a calibration run), and never less than twice the spread between repeats.

## Engine work counters

Timings in a cloud container move 15-30% between runs, so a 5% engine win cannot be shown by the
clock. The engine counts its expensive operations (`engineWork()` in `@mtg/engine`,
`packages/engine/src/work-counters.ts`), and the engine probe reports them over the benchmark
games. They repeat to the last digit on any machine, under the test suite's load too, and the probe
fails if two repeats of the same games count differently.

| Counter                            | Counts                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `layerPasses`                      | Full CR 613 layer passes over the battlefield (layer-cache misses).            |
| `layerCacheHits`                   | Characteristics queries answered from the cache. Shown only, never a verdict.  |
| `layerDigests`                     | Hashes of every layer input, once per read scope or per query outside one.     |
| `castCheckpoints`                  | Casting checkpoints, each capturing every object in the game for rollback.     |
| `castPreviews`                     | Casting previews: shallow projections of the game with a card on the stack.    |
| `manaSourceListings`               | Listings of a player's mana sources: every mana ability judged payable now.    |
| `spellPaymentSearches`             | Searches for a spell's joint payment of mana and non-mana costs.               |
| `manaPlannerSearches`              | Payments the stateful mana planner searched.                                   |
| `manaPlannerStates`, `stateCopies` | States that planner visited, and the deep copies of the game it made for them. |

A count measures the work the games needed, so it compares only when every fingerprint is
identical. When the games differ the row says `INCOMPARABLE` and does not fail. Counters include
the engine work the bot asks for through its view, and leave out the checks
`MTG_VERIFY_LAYER_CACHE=1` and `strictInvariants` make, so turning those on changes no count.
`bun run engine-bench` prints the totals too.

Use them as the target metric for engine CPU work: a change that leaves the games identical and
cuts `layerPasses` or `stateCopies` is a real win even when the timing row says `UNCHANGED`. Still
check the timing row for a `REGRESSED`, since a change can do fewer operations that each cost more.
To add a counter, add a field to `EngineWork`, call `countWork` where the work happens (never read
a counter in engine code: a test enforces it), and add its unit in `WORK_UNITS` in `probes.ts`.

## The loop

1. **Measure the base.** On a clean checkout of the commit you start from:
   `bun run hill-climb --repeat 3 --save <scratch>/before.json`
2. **Change one thing.**
3. **Compare on the same machine.**
   `bun run hill-climb --repeat 3 --against <scratch>/before.json`
4. **Keep it only if it is a real win.** The table must show `IMPROVED` on the metric you aimed
   at (for engine CPU, an `engine.work.*` counter or the timing), no `REGRESSED` row, and
   `games: all N fingerprints identical`. An `UNCHANGED` verdict means
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
exact model-call, coverage and engine work metrics and fails when one is worse than
`packages/server/fixtures/hill-climb-baseline.json`. The work counters are compared only while the
quick games still match the baseline's fingerprints; after a change that alters play, rewrite the
baseline to turn that gate back on. `packages/engine/tests/work-counters.test.ts` pins what each
counter counts. Timings and fingerprints are checked by the
command, not by the suite, because timings are not trustworthy while tests share the machine and
fingerprints change with every intended rules or card change. If main changed the games after the
baseline was written, the command says so: compare with `--against` a report from your base commit.

## Adding a metric

Add it to a probe in `packages/server/src/hill-climb/probes.ts` (or add a probe to `PROBES`), give
it a `better` direction and a kind, rewrite the baseline, and add a row to the table above. Prefer
exact counters over timings: a count of work done is a gate on every machine.
