# bot-bench: tactician benchmark with a judge bundle

Puts several models in the same Commander positions, plays their answers through the real rules
engine, and writes one ZIP you can hand to judge models. The ZIP holds the judging instructions,
the rubric (accuracy, speed and cost scored separately, plus a blurb), the primer the models were
given, every position, every model's answers side by side, and the scorecard to send back.

It benchmarks the **tactician** only. Strategist cases are reserved
([cases/strategist/README.md](cases/strategist/README.md)).

## Quick start

```powershell
bun run bot-bench list                      # the 12 cases
bun run bot-bench inspect lethal-alpha-strike   # every legal answer, played out by the engine
bun run bot-bench verify                    # every reference still agrees with the engine

# No key needed: the local baselines only.
bun run bot-bench run --lineup bot-bench/lineups/baselines.json

# Real models. Needs a provider key in .env (see .env.example).
bun run bot-bench run --models local:heuristic,openrouter:qwen/qwen3.7-flash,openrouter:deepseek/deepseek-v4-flash
bun run bot-bench run --lineup bot-bench/lineups/example.json --trials 3 --spend-cap 2
```

A run prints a line per case as it goes, then a small leaderboard, then where the bundle is:

```
judge bundle: 26 files, 1035 KB
  folder  benchmark-output/bot-bench/<run>/bundle
  zip     benchmark-output/bot-bench/<run>/bot-bench-<run>.zip   <- send this to the judges
  key     benchmark-output/bot-bench/<run>/judge-key.json        <- which alias is which model; keep it
```

`benchmark-output/` is gitignored.

## Trying more models

- `--models` takes a comma-separated list: `local:heuristic`, `local:first-legal`, `local:random`,
  `openrouter:<vendor/model>`, `groq:<model>`, `gemini:<model>`, `deepseek:<model>`,
  `openai:<model>`. Add `@low`, `@medium` or `@high` to turn reasoning on:
  `openrouter:deepseek/deepseek-v4-flash@low`.
- `--lineup <file.json>` for anything more: a label, any OpenAI-compatible `baseUrl`, the name of
  the environment variable that holds the key (`apiKeyEnv`), `maxOutputTokens`,
  `requestTimeoutMs`, and `pricing` (USD per million tokens, used only when the provider does not
  report a cost). See [lineups/example.json](lineups/example.json). A lineup file never contains
  a key.
- `--out <run directory>` pointing at an earlier run **adds** the new models to it and rebuilds
  the bundle, so you can try one more model without paying for the others again. The cases, mode
  and trial count have to match, and so does the run's fingerprint (the case files, the live
  primer, the engine and the AI versions): after any of those change, start a new run.
- `--trials N` plays every case N times per model and reports how often it chose the same thing.
- `--spend-cap <USD>` stops every model once the known spend passes it. It is checked before
  every decision, so a whole-turn case stops mid-turn; a case cut off that way is not scored.
- `--mode production` lets the pipeline answer dominated decisions locally before asking the
  model, as a live game does. The default, `raw`, sends every decision to the model.
- A model whose provider fails three decisions in a row (bad key, unknown model) is stopped and
  marked as such instead of being scored on the fallback bot's play.

## What is measured

Three groups, never blended into one number:

| Group    | What it holds                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accuracy | Score per case; grades on one-decision cases (best, good, weak, blunder); objectives met on whole-turn cases; and reliability: legal on the first try, corrective retries, fallbacks, refused answers, turns cut off for looping, agreement across trials. |
| Speed    | Wall-clock time per decision (median, 90th percentile, mean, slowest) and per whole turn, retries included.                                                                                                                                                |
| Cost     | Total, per decision and per 300 decisions (about one game, after ADR 0010), with tokens per decision. Each figure says whether it was reported by the provider, estimated from your price list, or unknown.                                                |

## The cases

Eight one-decision cases and four whole-turn cases under [cases/tactician/](cases/tactician/).
Each is a JSON file: a position in the engine's own scenario format, the seat under test, and a
reviewed reference.

| Kind         | Case                             | What it tests                                                          |
| ------------ | -------------------------------- | ---------------------------------------------------------------------- |
| one decision | `lethal-alpha-strike`            | Seeing a guaranteed kill and sending every attacker at it              |
| one decision | `keep-blockers-home`             | Not tapping the blockers that keep you alive next turn                 |
| one decision | `block-the-trampler`             | Blocking a lethal attack when trample makes the obvious block wrong    |
| one decision | `removal-on-the-lethal-attacker` | Aiming removal at what kills you, not at the biggest creature          |
| one decision | `burn-out-the-low-player`        | Three damage to the face of a player at three life                     |
| one decision | `hold-the-counter`               | Passing when the only counterspell is castable but not worth it        |
| one decision | `counter-the-finisher`           | Countering when it is the only way to survive                          |
| one decision | `land-for-the-turn`              | Picking the land that casts a spell this turn                          |
| whole turn   | `overrun-for-the-kill`           | Land, pump, attack, trample over, without tapping an attacker for mana |
| whole turn   | `clear-the-blocker-and-pump`     | Removal before combat, attack, activated ability for exact lethal      |
| whole turn   | `wrath-then-rebuild`             | Board wipe before the creature, with all nine mana                     |
| whole turn   | `ramp-with-every-mana`           | A development turn: mana rock first, then spend everything             |

`hold-the-counter` and `counter-the-finisher` are a pair on purpose: a model that always passes
fails one and a model that always acts fails the other.

How a case is scored:

- **One decision.** The reference lists reviewed answers with a grade; the first that matches the
  model's answer grades it, and `otherwise` grades the rest. `best` is worth 1, `good` 0.7,
  `weak` 0.3, `blunder` 0. An answer the model never legally produced is worth 0.
- **Whole turn.** The reference lists objectives with points, checked against the engine's final
  state (a seat eliminated, a life total, a card in a zone, an action taken). The score is the
  share of points met. Reference lines (the best line and typical mistakes) are replayed by the
  engine and shown to judges next to each model's own sequence.

The reference is investigated with the engine, not asserted. For a one-decision case every legal
answer is played to the end of the arranged window and its consequences are recorded; for a
whole-turn case every reference line is replayed. `inspect` prints that, the case pages show it
to judges, and `verify` (also in the test suite) fails when a reference stops agreeing with the
engine: a reviewed option no legal answer matches, a best line that no longer meets every
objective, a line whose grade and score disagree.

### Adding a case

1. Copy the nearest case in `cases/tactician/single/` or `turn/` and rename it to `<id>.json`.
2. Arrange `position` with cards from the pinned Oracle fixtures
   (`packages/server/fixtures/coverage-oracle.json`, `edhrec-pinned-oracle.json`). A card the
   engine does not model is refused.
3. Script `setup` up to the decision under test (for example the opponent's attack). `focus`
   picks the decision when it is not the seat's first one.
4. Run `bun run bot-bench inspect <id>` and read what the engine says each answer leads to. Write
   the reference from that, not from memory: several of the committed cases were corrected this way.
5. Name answers the way a person would. `{"choose": "Cast Swords to Plowshares", "targets":
["Shivan Dragon"]}`; for attacks and blocks `{"choose": "Declare attackers", "assign":
{"Serra Angel": "P4", "Colossal Dreadmaw": "-"}}`, where `-` holds back, `+` is "attacks or
   blocks something" and `*` is anything.
6. `table.policy` is how the other seats play (`heuristic`, or `passive` for a quiet table);
   `table.script` pins the replies that matter, such as the correct block.
7. `bun run bot-bench verify` and `bun run test bot-bench`.

## Sending the bundle to judges

Send `bot-bench-<run>.zip`. The judge starts at `JUDGE_BRIEF.md`, which tells it to read
`PRIMER.md`, `SUMMARY.md`, the case pages and the model pages, then return one JSON scorecard:
for each model an `accuracy`, `speed`, `cost` and `overall` score from 0 to 10, each with a
reason, a `blurb`, a ranking, and any reference grade it disagrees with.

Candidate models are anonymised by default ("Model A", "Model B"), so a judge scores the play and
not the brand. `judge-key.json`, written beside the ZIP and never inside it, maps the aliases
back. Pass `--reveal-models` to `run` or `bundle` to use real names. Local baselines keep their
names and are marked as calibration, not candidates.

When the scorecards come back:

```powershell
bun run bot-bench collate --run benchmark-output/bot-bench/<run> judge1.json judge2.json
```

That writes `judges.md` in the run directory: mean and range per axis across judges, each judge's
blurb and reasons per model under its real name, and the reference grades the judges disputed.

`bun run bot-bench bundle --run <run directory>` rebuilds the bundle from a run's saved results
without calling any model.

## What it reuses from the main code

The harness holds no copy of game or prompt logic, so it changes when the product does:

| Piece                                   | Where it comes from                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Positions                               | `buildCardScenario` and the `CardScenario` format in `packages/engine/src/testing/`, the same format the Card Test Lab uses                                                                |
| Legality, results, the public log       | the engine (`Engine.advance`/`submit`, `formatSpectatorLog`)                                                                                                                               |
| What the model sees                     | `Engine.view(seat)`, the anti-cheat `PlayerView`                                                                                                                                           |
| The model's whole pipeline              | `OpenAiDecisionProvider` in `packages/server/src/ai/provider.ts`: `assemblePrompt`, the primer, the client and parser, `validateResponse`, the corrective retry and the heuristic fallback |
| The primer shown to judges              | `primerCatalog()` in `packages/server/src/ai/primer.ts`, read when the bundle is built                                                                                                     |
| Provider presets and tactician settings | `PROVIDERS`, `loadAiConfig`, `configForRole` in `packages/server/src/ai/config.ts`                                                                                                         |
| Opponents and the `heuristic` baseline  | `HeuristicDecisionProvider` in `packages/bot`                                                                                                                                              |

Changing a primer, the prompt assembler or the provider changes the next benchmark run with no
edit here. Changing the engine, a card or the heuristic bot can change what a position leads to;
`verify` and the tests say so.

## Limits

- Twelve positions are a screen, not a statistic. They separate a model that reads the board from
  one that does not; they do not rank two good models with confidence. Use `--trials` and add
  cases from real games where a model misplayed.
- Positions have no commanders: the scenario format arranges none. Commander damage and the
  command zone are not tested.
- The table is the heuristic bot plus scripted replies, not a strong opponent. A reference marks
  what holds against correct play, and the case pages say when a consequence depends on the bot.
- Speed is measured from wherever the harness runs, over a few dozen calls per model.
- One provider request per decision is made at the client's fixed temperature of 0.1.
