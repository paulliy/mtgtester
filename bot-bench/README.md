# bot-bench: tactician benchmark with a judge bundle

Puts several models (chat models, or typed decision models such as Jev, GPT-6 Luna Decisions and
Gemini Decision 1) in the same Commander positions, plays their answers through the real rules
engine, and writes one ZIP you can hand to judge models. The ZIP holds the judging instructions,
the rubric (accuracy, speed and cost scored separately, plus a blurb), the primer the models were
given, every position, every model's answers side by side, and the scorecard to send back.

It benchmarks the **tactician**, alone or behind a **strategist**: any strategist model can be put
in front of any tactician (the bot, a chat model, a decision model) and every pair is scored on the
same positions ([Strategists](#strategists-every-strategist-in-front-of-every-tactician)).
Strategist-specific positions are still to be written
([cases/strategist/README.md](cases/strategist/README.md)).

## Quick start

```powershell
bun run bot-bench list                      # the 49 cases
bun run bot-bench inspect lethal-alpha-strike   # every legal answer, played out by the engine
bun run bot-bench verify                    # every reference still agrees with the engine

# No key needed: the local baselines only.
bun run bot-bench run --lineup bot-bench/lineups/baselines.json

# Real models. Needs a provider key in .env (see .env.example).
bun run bot-bench run --models local:heuristic,openrouter:qwen/qwen3.7-flash,openrouter:deepseek/deepseek-v4-flash
bun run bot-bench run --lineup bot-bench/lineups/example.json --trials 3 --spend-cap 2

# The wide sweep: the models that finished the first sweep, with thinking off and on low where that worked (19 entries) plus the heuristic bot.
bun run bot-bench run --lineup bot-bench/lineups/tactician-sweep.json --spend-cap 5

# Decision models instead of chat models: Jev 1.14 and 1.13, OpenAI, Gemini and every other
# decision model we know of, plus the heuristic bot. Needs OPENROUTER_API_KEY.
bun run bot-bench run --lineup bot-bench/lineups/decision-sweep.json --spend-cap 1
bun run bot-bench run --models local:heuristic,decision:typesafe/jev-1.14,decision:google/gemini-decision-1
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
- [lineups/tactician-sweep.json](lineups/tactician-sweep.json) runs OpenRouter models with reasoning off (`-none`) and on low (`-low`). Entries that played 10 or fewer of the 30 cases in the first sweep (both Qwen models, `ling-3.1-flash`, and the `none` or `low` runs that were rejected or timed out) were removed. A model that cannot turn thinking off will reject the `none` entry; after three failed decisions in a row it is stopped and marked as such, and its `-low` entry still runs.
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

## The bot as a regression suite (ADR 0043)

`local:heuristic` is the production bot: card-aware, as it plays in bot-led mode, as a model's
fallback and in a table's bot seats. `local:heuristic-plain` is the same bot without card
knowledge, the baseline the first tactician sweep (ADR 0042) measured against; results stored
under `local:heuristic` before ADR 0043 are the plain bot's. A run's `run.json` records the bot's
`botPolicyVersion` (`packages/bot/src/version.ts`, bumped by any change to what the bot chooses),
which is part of the run fingerprint, so a run measured against one bot is never extended with
another's play.

A `bot-led` entry plays a case through the production pipeline in bot-led mode (ADR 0039): the
card-aware bot answers and its escalation triggers decide when the entry's `model` is asked.
`bot-led:never` names no model, needs no key and costs nothing; on the command line,
`--models bot-led:uncertain=openrouter/<vendor/model>[@low]` escalates close calls to a model. With
the same `seed` (or none), `bot-led:never` and `local:heuristic` play identically. Each decision records whether it
was escalated and which triggers fired; each case sums them under `escalations`.

```json
{
  "id": "bot-led-uncertain",
  "kind": "bot-led",
  "escalation": ["uncertain"],
  "margin": 1,
  "provider": "openrouter",
  "model": "deepseek/deepseek-v4-flash"
}
```

Escalation triggers (ADR 0044) are `uncertain`, `scarce-answer` and `unknown-card`; `lethal` is
shadow-only. Every bot-led decision records each trigger that fired, live or not, in `reasons`;
`escalation` makes the named ones live, one at a time when a trigger is being judged.

The bot breaks ties with a seeded RNG, so one run can be lucky. A lineup file's top-level `seeds`
list plays every heuristic and `bot-led` entry once per seed (`<id>.s1`, `<id>.s2`, ...).
[lineups/bot-gate.json](lineups/bot-gate.json) holds the gate's eight seeds, so every run of the
gate uses the same ones:

```powershell
bun run bot-bench run --lineup bot-bench/lineups/bot-gate.json --out benchmark-output/bot-bench/gate
bun run bot-bench seeds --run benchmark-output/bot-bench/gate --baseline local-heuristic-plain --candidate local-heuristic
```

`seeds` prints each case's mean score across seeds per entry. With `--baseline` and
`--candidate` it applies ADR 0043's seed gate: the candidate must raise the overall score and must
not lower any case's mean, and the command exits 1 when it fails.

## Decision models

A decision model is not a chat model. It gets the position as state plus one typed question, and
returns one choice with probabilities. It writes no text. [ADR 0046](../docs/decisions/0046-decision-model-tactician-bench.md)
has the reasoning. A `decision` entry runs through the production decision lane, the code that
puts Jev in a live seat (`buildJevActionRequest`, `JevActionPolicy`, `JevClient` in
`packages/server/src/ai/`):

- each legal action is one Choice option, and a targeted action with one open slot is offered once
  per legal target (`expandTargets`, default on);
- the chosen option is mapped back to the engine's action and checked by the same validator and
  engine as a chat model's answer;
- the model's answer is always played: there is no confidence threshold. Its confidence and its
  margin over the runner-up are shown as the "reason" beside each answer.

```json
{ "id": "jev-1.14", "kind": "decision", "model": "typesafe/jev-1.14" }
```

Optional fields: `label`, `baseUrl` (default OpenRouter), `apiKeyEnv` (default `AI_JEV_API_KEY`,
then `OPENROUTER_API_KEY`), `requestTimeoutMs` (default 10 s), `pricing`, `expandTargets`, and
`unsupported`. On the command line: `decision:<vendor/model>`, plus `@hold` for
`unsupported: "hold"`.

**What a decision model cannot answer.** One choice cannot declare attackers or blockers, divide
combat damage, pick X or modes, order triggers or split mana. Those decisions are never sent.
`unsupported` decides what plays them:

| `unsupported`   | What happens                                                                                                                                                                            | Read the score as                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bot` (default) | The production fallback bot (card-aware) answers, as in a live decision-model seat. The decision is recorded as answered by `bot-handoff`, flagged on the case and marked on the grade. | The hybrid you would deploy. Compare it with the `local-heuristic` row: the difference is what the model added. |
| `hold`          | The seat holds still: no attack, no block. Scored as no answer.                                                                                                                         | The model alone. Combat-only cases score 0 for every decision model.                                            |

Of the 50 cases, the 6 one-decision cases that are attacks or blocks (`lethal-alpha-strike`,
`keep-blockers-home`, `block-the-trampler`, `chump-the-giant`, `hold-the-ground-at-five`,
`two-home-to-live`) and the attack or block steps of 9 of the 14 whole-turn cases are the bot's
under `bot`. The summary adds a one-decision accuracy over the model's own
answers only, and counts the bot's answers separately. Bot answers are left out of "legal on first
try" and of speed.

A refusal or an option the menu never offered is a `no legal answer` (billed, scored as no
answer). A provider that never answers (unknown model, bad key, a `:free` model your OpenRouter
privacy settings exclude) is a `provider error`, and three in a row stop the model.

[lineups/decision-sweep.json](lineups/decision-sweep.json) holds the heuristic baseline and these
decision models, ids pinned so a run can be repeated (`~typesafe/jev-latest` follows new releases
and is avoided for that reason):

| Entry                     | Model                                | Notes                                                   |
| ------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `jev-1.14`                | `typesafe/jev-1.14`                  | Latest Jev release                                      |
| `jev-1.13`                | `typesafe/jev-1.13`                  | The version the product pins today                      |
| `gpt-6-luna-decisions`    | `openai/gpt-6-luna-decisions`        | OpenAI                                                  |
| `gemini-decision-1`       | `google/gemini-decision-1`           | Google, released 2026-11-11; $0.10/M input, output free |
| `microsoft-decision-1`    | `microsoft/microsoft-decision-1`     | $0.042/M input, output free                             |
| `pplx-decider-v1.2`       | `perplexity/pplx-decider-v1.2`       |                                                         |
| `pplx-decider-flash-v1.2` | `perplexity/pplx-decider-flash-v1.2` |                                                         |
| `clef`, `clef-flash`      | `cloudflare/clef`, `.../clef-flash`  |                                                         |
| `d1.1`                    | `liquid/d1.1`                        |                                                         |
| `drex-v1.5`, `drex-max`   | `nace-ai/drex-v1.5`, `.../drex-max`  |                                                         |
| `mercury-decide`          | `inception/mercury-decide`           |                                                         |
| `elephant-1`              | `baseten/elephant-1`                 |                                                         |
| `decisions-fast-free`     | `parallel/decisions-fast:free`       | Free; 404 unless your privacy settings allow training   |

Prices are listed only where OpenRouter's model page gave one; every decision response reports its
own cost, so the price list is a fallback. A model that rejects the request shape (a smaller option
limit than Jev's 255, a vendor-specific state format) fails as a provider error and is stopped.
Check the live list with `GET https://openrouter.ai/api/v1/models?output_modalities=decisions`
before a sweep and add new models the same way.

## Strategists: every strategist in front of every tactician

In a live game a strategist plans each seat's turn once, at its first decision after the beginning
phase, and the tactician plays the turn with that plan (ADR 0016). With a bot-led tactician the
strategist sets knobs instead (ADR 0039). An entry's `strategist` puts one in front of the tested
seat, and a lineup can cross a list of strategists with a list of tacticians:

```powershell
# Free: the grid machinery with no live strategist.
bun run bot-bench run --models local:heuristic,bot-led:never --strategists none,case

# Paid: two strategists in front of the bot, a chat tactician and a decision model.
bun run bot-bench run --models bot-led:never,openrouter:qwen/qwen3.7-flash,decision:typesafe/jev-1.14 --strategists none,openrouter:z-ai/glm-5.3-flash@low --scope turn --spend-cap 1

# The full grid: 4 strategists x 6 tacticians (22 cells, local bots sit out the model rows).
bun run bot-bench run --lineup bot-bench/lineups/strategist-grid.json --scope turn --trials 3 --spend-cap 5
```

A lineup file lists `strategists` and `tacticians` instead of `models`; each pair runs as
`<tactician>.st-<strategist>` ([lineups/strategist-grid.json](lineups/strategist-grid.json)). An
entry in a plain `models` list can carry its own `strategist` too. Three kinds:

| `kind` | What the tactician gets                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none` | No strategy, even when the case has a hand-written one. The case's deals stay: they are table facts.                                                                       |
| `case` | The case's own `context` (below). The same as an entry with no strategist. No committed case has a context yet, so for now this row plays as `none`.                       |
| `llm`  | A live strategist model, through the production `StrategyCoordinator`: its primer, prompt and parser. Fields as for a chat model, plus `replan` (`everyTurn`, `onChange`). |

```json
{
  "id": "glm-low",
  "kind": "llm",
  "provider": "openrouter",
  "model": "z-ai/glm-5.3-flash",
  "reasoning": "low"
}
```

What a live strategist does in a case:

- **It plans the tested seat's own turns only.** One-decision cases on an opponent's turn (blocks,
  counters, Fog) never call it, so its effect shows on whole-turn cases and on single decisions in
  the seat's own turn. Use `--scope turn` to spend only where it can matter.
- **The seat waits for it.** In a live game the strategist call races the tactician; here the
  seat's first decision of the turn waits for the plan, so the tactician always plays with it. That
  wait is recorded as the strategist's, never as the decision's latency.
- **What it returns depends on the tactician behind it, as in production.** A bot-led tactician gets
  the bot primer and knobs only. A chat or decision-model tactician gets an intent, a threat order
  and planned steps, and a step that matches the menu exactly is played without asking the
  tactician (`plan` in the "answered by" column, counted as _plan steps_). So one strategist row is
  not one identical prompt across the columns, and the report says so.
- **Opponents' actions reach it.** The table's decisions are fed to the coordinator as a live
  table's would be, so a non-pass action invalidates the plan and may start the turn's one re-plan.
  A re-plan whose answer the coordinator drops as stale (an opponent acting again while it was in
  flight) is still billed, and is counted as a call that installed nothing.
- **Local bots read no strategy**, so in a grid `local:*` sits behind `none` and `case` only, and an
  entry naming a live strategist in front of a local bot is refused. Use `bot-led:never` for the bot.
- **A dead strategist stops the entry**, like a dead tactician: three strategist calls in a row that
  fail at the provider stop it, so a cell is never quietly scored as its `none` row.

The report adds a **strategist × tactician grid** (whole-turn score, overall in brackets) to
`SUMMARY.md`, and a **Strategist** table: calls, calls that installed nothing, plan steps played,
time waited, and the strategist's cost with the pair's total. The speed and cost tables stay the
tactician's alone. Each model page lists what the strategist returned before each decision. In a
blind bundle a strategist gets its own alias (`Strategist A`) and a remote tactician that appears
in several cells gets one too (`Tactician B`), so a judge can read the grid without names; every
strategist model name is redacted and searched for like a tactician's.

## Games: `duel`, whole games between pairs

Positions measure single decisions and turns. `duel` plays whole four-player Commander games
between lineup entries ("arms"), for win rates and cost per game. Any entry can be an arm: a
tactician (bot, bot escalating to a model, chat model, decision model) with its strategist (none,
or a live model), named the same way as for `run`.

```powershell
# Free: the wiring, with every model replaced by the bot and fixed knobs.
bun run bot-bench duel --models bot-led:never,decision:typesafe/jev-1.14 --strategists none,openrouter:z-ai/glm-5.3-flash@low --arms bot-led-never.st-none,typesafe-jev-1.14.st-z-ai-glm-5.3-flash-low --offline

# Paid: the steered bot against the decision model, 5 deals (10 games).
bun run bot-bench duel --models bot-led:never,decision:typesafe/jev-1.14 --strategists none,openrouter:z-ai/glm-5.3-flash@low --arms bot-led-never.st-z-ai-glm-5.3-flash-low,typesafe-jev-1.14.st-none --deals 5 --spend-cap 2

# Four arms at one table, from the grid lineup.
bun run bot-bench duel --lineup bot-bench/lineups/strategist-grid.json --arms bot.st-none,bot.st-glm-low,qwen.st-glm-low,jev-1.14.st-glm-low --deals 3
```

- **Seating.** Two arms take two seats each (P1 and P3 against P2 and P4); four arms take one seat
  each. Every deal (four generated decks from `--seed`) is played once per rotation of the arms
  around the table, so deck and seat luck cancel within a deal: `--deals 5` is 10 games for two
  arms, 20 for four.
- **Every seat is the production pipeline**: `OpenAiDecisionProvider` and `StrategyCoordinator`,
  and for a decision model the production Jev lane with `jevFallback: bot`, so the bot plays the
  attacks, blocks and failures the model cannot. Dominated decisions are answered locally, as a
  live seat answers them (`production` mode).
- **Every accepted decision reaches every arm's coordinator**, so an opponent's action invalidates
  a plan and may start a re-plan, as in a live game. Each arm has its own coordinator only because
  each has its own strategist model and tactical mode.
- **Seats wait for their strategist** before their first decision of a turn. `--race` restores the
  live race; without the wait, fast bot-led seats finish turns before any plan lands.
- **The turn cap ends a game as a draw** (`--turn-cap`, default 40). A game the engine stops for
  any other reason is counted as _halted_ and left out of win rates.
- **Spend cap** (`--spend-cap`, default $2, none offline): chat requests are refused once it is
  reached, the seat's bot answers instead, and no further game starts. Decision-model requests are
  checked before each request. A game in progress when the cap is reached is marked `capped`.

The report (`summary.md`, `summary.json`, one line per game in `games.jsonl`) gives per arm: wins
over games that ended, win rate against the fair rate (50% for two arms, 25% for four), share of
the life left at the end, mean turn its seats were knocked out, cost per game, chat-tactician
requests, strategist calls and decision-model requests per game, and the **fallback share**: the
decisions its model was asked that the bot had to play instead. Above 5%, the report says the arm
did not get a fair game (ADR 0039's bar).

Not measured yet: per-decision traces (`ai-mode-duel --trace` has them), premade decks, and
diplomacy.

## What is measured

Three groups, never blended into one number:

| Group    | What it holds                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accuracy | Score per case; grades on one-decision cases (best, good, weak, blunder); objectives met on whole-turn cases; and reliability: legal on the first try, corrective retries, fallbacks, refused answers, turns cut off for looping, agreement across trials. |
| Speed    | Wall-clock time per decision (median, 90th percentile, mean, slowest) and per whole turn, retries included.                                                                                                                                                |
| Cost     | Total, per decision and per 300 decisions (about one game, after ADR 0010), with tokens per decision. Each figure says whether it was reported by the provider, estimated from your price list, or unknown.                                                |

## The cases

Thirty-five one-decision cases and fourteen whole-turn cases under
[cases/tactician/](cases/tactician/). Each is a JSON file: a position in the engine's own scenario
format, the seat under test, and a reviewed reference. The first twelve (the table below) were the
original set; the next eighteen (listed after it) double it and were written to include positions
the heuristic bot gets wrong; eleven came with ADR 0043's bot fixes and eight with ADR 0044's
escalation triggers.

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

### Added in the second set

`heuristic` is the local heuristic bot's score, measured with the engine; `calibration` cases are
ones it also solves, kept so a model that does worse than the bot shows up.

| Kind         | Case                            | Heuristic bot | What it tests                                                   |
| ------------ | ------------------------------- | ------------- | --------------------------------------------------------------- |
| one decision | `stoke-the-flames-lethal`       | fails         | Burn to the face of the player on four, not at a creature       |
| one decision | `hold-the-wrath`                | fails         | Not casting a board wipe on a board you are winning             |
| one decision | `land-for-the-angel`            | fails         | The land that gives the second white source                     |
| one decision | `pyroclasm-not-wrath`           | fails         | The one-sided sweeper over the symmetrical one                  |
| one decision | `pump-the-unblocked-attacker`   | calibration   | Giant Growth on the attacker nobody blocked                     |
| one decision | `chump-the-giant`               | calibration   | Chumping a 10/10 and trading up the other block at 3 life       |
| one decision | `fog-the-lethal-swing`          | calibration   | Fog against an exactly lethal swing                             |
| one decision | `leak-or-cancel`                | calibration   | Mana Leak is useless against spare mana; Cancel is not          |
| one decision | `protect-the-angel-in-response` | calibration   | A hexproof trick in response to Swords to Plowshares            |
| one decision | `counter-the-sweeper`           | calibration   | Negate on the Wrath of God that costs three creatures           |
| one decision | `tapped-land-when-idle`         | calibration   | Playing the tapped land when there is nothing to cast           |
| whole turn   | `burn-to-finish`                | fails         | Dragon in the air plus a Bolt to the face for exactly eight     |
| whole turn   | `two-bolts-two-kills`           | fails         | Two Bolts eliminating two players on three life                 |
| whole turn   | `develop-the-board`             | calibration   | The five-drop plus a mana source, using all six mana            |
| whole turn   | `firebreathing-for-exact`       | calibration   | Two flyers and three firebreathing pumps for exactly twelve     |
| whole turn   | `sweep-then-swing`              | calibration   | Pyroclasm clears the chump blockers before the lethal attack    |
| whole turn   | `anthem-then-alpha`             | calibration   | Glorious Anthem before the all-in attack for exactly nine       |
| whole turn   | `haste-for-lethal`              | calibration   | Lightning Greaves gives a ten-power creature haste for the kill |

### Added with ADR 0043

Four reordered variants, so a tie or option order cannot pass a position by luck, and one held-out
position per bot fix, written after the fixes were tuned and never tuned against.

| Kind         | Case                                       | For             | What it tests                                                   |
| ------------ | ------------------------------------------ | --------------- | --------------------------------------------------------------- |
| one decision | `pump-the-unblocked-attacker-reordered`    | variant         | The blocked attacker listed first                               |
| one decision | `removal-on-the-lethal-attacker-reordered` | variant         | The Bears listed before the lethal Dragon                       |
| one decision | `land-for-the-angel-reordered`             | variant         | The right land first in hand                                    |
| one decision | `land-for-the-turn-reordered`              | variant         | The right land first in hand                                    |
| one decision | `shock-the-other-threat`                   | `ownStack`      | A second burn spell not aimed where the first already kills     |
| whole turn   | `growth-after-attacks`                     | `neverYield`    | Keep priority for the combat trick instead of yielding the turn |
| one decision | `bolt-the-unblocked-lions`                 | `lethalTargets` | Burn the small attacker that kills you, not the bigger creature |
| whole turn   | `proportions-for-the-kill`                 | `lethalValue`   | The team pump that kills beats the bigger creature              |
| whole turn   | `rock-before-the-draw`                     | `castOrder`     | The mana rock first, then the draw spell                        |
| one decision | `temple-for-next-turn`                     | `landColors`    | The tapped dual that fixes next turn over a land nobody needs   |
| one decision | `hold-the-ground-at-five`                  | `attackReserve` | At five life, every creature stays home to block                |
| one decision | `two-home-to-live`                         | `attackReserve` | Surviving takes two blockers home, so no single recall helps    |

### Added with commander seats

Held-out positions for the two fixes from the bot gauntlet review
(`docs/reviews/bot-gauntlet-2026-11-20.md`). Two of them seat a commander (`position.commanders`).

| Kind         | Case                                | For              | What it tests                                               |
| ------------ | ----------------------------------- | ---------------- | ----------------------------------------------------------- |
| one decision | `altar-the-bears-not-the-angel`     | `costChoices`    | Ashnod's Altar eats the 2/2, not Serra Angel                |
| one decision | `altar-the-beast-not-the-commander` | `commanderValue` | Ashnod's Altar eats a vanilla 3/3, not the commander        |
| one decision | `swords-the-commander`              | `commanderValue` | The last Swords on the opposing commander, not a bigger 3/3 |

### Added for the scarce-answer exemptions

Two positions from the PR 124 review, where `scarceAnswer` held the last counterspell when it
should not: neither has lethal on the board, so only reading the stack lifts the hold.

| Kind         | Case                      | For            | What it tests                                               |
| ------------ | ------------------------- | -------------- | ----------------------------------------------------------- |
| one decision | `counter-the-lethal-bolt` | `scarceAnswer` | At 3 life, the last Counterspell answers a Bolt aimed at P1 |
| one decision | `win-the-counter-war`     | `scarceAnswer` | The last Counterspell counters a Negate aimed at our Wrath  |

### Added with ADR 0044

Four positions per escalation trigger. For `scarce-answer`, two where the last answer should be
held and two no-harm controls where it should still be cast; for `unknown-card`, four cards the
classifier has no role for, one of them an opponent's spell to answer.

| Kind         | Case                           | Trigger         | What it tests                                                    |
| ------------ | ------------------------------ | --------------- | ---------------------------------------------------------------- |
| one decision | `hold-the-swords-for-a-threat` | `scarce-answer` | Develop instead of spending the only removal on a mana elf       |
| one decision | `hold-negate-for-a-threat`     | `scarce-answer` | Do not Negate a mana rock with the only counterspell             |
| one decision | `negate-the-blasphemous-act`   | `scarce-answer` | Control: the last counterspell is for the one-sided sweeper      |
| one decision | `wrath-the-crowded-table`      | `scarce-answer` | Control: the only wipe into five opposing creatures and none own |
| one decision | `darkness-the-alpha-strike`    | `unknown-card`  | Darkness prevents the combat damage that would kill              |
| one decision | `crackling-doom-for-two-kills` | `unknown-card`  | Two damage to each opponent kills two players                    |
| one decision | `angels-grace-at-three`        | `unknown-card`  | Angel's Grace keeps the seat alive through a lethal attack       |
| one decision | `protect-from-feed-the-swarm`  | `unknown-card`  | A protection trick answers an opponent's unfamiliar removal      |

`hold-the-counter` and `counter-the-finisher` are a pair on purpose: a model that always passes
fails one and a model that always acts fails the other.

How a case is scored:

- **One decision.** The reference lists reviewed answers with a grade; the first that matches the
  model's answer grades it, and `otherwise` grades the rest. `best` is worth 1, `good` 0.7,
  `weak` 0.3, `blunder` 0. An answer the model never legally produced is worth 0.
- **Whole turn.** The reference lists objectives with points, checked against the engine's final
  state (a seat eliminated, a life total, a card in a zone, an action taken). The score is the
  share of points met. Reference lines (the best line and typical mistakes) are replayed by the
  engine and shown to judges next to each model's own sequence. A decision the model did not make
  (the pipeline fell back to its bot, the engine refused the answer, or the turn passed its
  decision cap) holds the seat still, so nothing the fallback would have achieved is credited.

The reference is investigated with the engine, not asserted. For a one-decision case every legal
answer is played to the end of the arranged window and its consequences are recorded; for a
whole-turn case every reference line is replayed. `inspect` prints that, the case pages show it
to judges, and `verify` (also in the test suite) fails when a reference stops agreeing with the
engine: a reviewed option no legal answer matches, a best line that no longer meets every
objective, a line whose grade and score disagree.

### Context and longer scopes (ADR 0045)

A case may carry what the seat's strategist and table would have told the tactician:

```json
"context": {
  "strategy": { "intent": "Keep Negate for P4's Wrath", "threatOrder": ["P4"], "steering": { "hold": ["Negate"] } },
  "deals": [{ "parties": ["P1", "P3"], "rounds": 1,
              "obligations": [{ "kind": "noAttack", "by": "P3", "against": "P1" }] }]
}
```

A model receives it through the production guidance (`turnStrategy` and `tableDeals` in its
prompt), and a `bot-led` entry's bot reads the strategy's knobs. The local bots ignore it. A turn
case may set `"turns": 2` or more when its `position.continue` reaches past the first turn
(`throughNextTurn`, or a count of upkeeps or main phases above 1). The count is checked against
that window and shown to judges; what the run covers comes from the window itself and
`maxActorDecisions`, under which the seat answers every decision of those turns.

### Adding a case

1. Copy the nearest case in `cases/tactician/single/` or `turn/` and rename it to `<id>.json`.
2. Arrange `position` with cards from the pinned Oracle fixtures
   (`packages/server/fixtures/coverage-oracle.json`, `edhrec-pinned-oracle.json`). A card the
   engine does not model is refused. `position.commanders` names a seat's commander or two
   partners, `{"P2": ["Talrand, Sky Summoner"]}`: one on that seat's battlefield is put there from
   the command zone with commander status, one named nowhere else waits in the command zone, and
   either way `PlayerView.commanders` and `opponents[].commanders` show it. A commander cannot also
   be in a hand, graveyard or library.
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
not the brand. The letters are handed out in a fixed shuffled order seeded by the run id, so the
lineup order does not leak and the two settings of one model are not neighbours. Once assigned, an
alias never changes: adding models with `--out` gives only the new ones a free letter, so
scorecards returned for an earlier bundle still resolve to the right models. Every name a
model could be recognised by is removed from the free text a provider or the model wrote: the model
string, its vendor, its short name (however punctuated or capitalised), the provider and its host.
After the bundle is built it is searched for those names again and the run prints a warning, and
exits non-zero, if any survive. A model's thinking setting (`none`, `low`) is the one setting a
judge still sees. `judge-key.json`, written beside the ZIP and never inside it, maps the aliases
back; a `--reveal-models` rebuild leaves it in place. Pass `--reveal-models` to `run` or `bundle`
to use real names. Local baselines keep their
names and are marked as calibration, not candidates.

When the scorecards come back:

```powershell
bun run bot-bench collate --run benchmark-output/bot-bench/<run> judge1.json judge2.json
```

That writes `judges.md` in the run directory: mean and range per axis across judges, each judge's
blurb and reasons per model under its real name, and the reference grades the judges disputed.

`bun run bot-bench bundle --run <run directory>` rebuilds the bundle from a run's saved results
without calling any model.

`bun run bot-bench rescore --run <run directory>` grades the saved play again against the
references as they are now, prints every case score that changed and rebuilds the bundle. Use it
after correcting a grade or an objective that judges disputed: the play was already paid for, and
a score depends only on the case and the recorded run. Copy the run directory first if you want
to keep the scores the judges saw. A rescored run takes no further models.

## What it reuses from the main code

The harness holds no copy of game or prompt logic, so it changes when the product does:

| Piece                                   | Where it comes from                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Positions                               | `buildCardScenario` and the `CardScenario` format in `packages/engine/src/testing/`, the same format the Card Test Lab uses                                                                |
| Legality, results, the public log       | the engine (`Engine.advance`/`submit`, `formatSpectatorLog`)                                                                                                                               |
| What the model sees                     | `Engine.view(seat)`, the anti-cheat `PlayerView`                                                                                                                                           |
| The model's whole pipeline              | `OpenAiDecisionProvider` in `packages/server/src/ai/provider.ts`: `assemblePrompt`, the primer, the client and parser, `validateResponse`, the corrective retry and the heuristic fallback |
| A decision model's whole pipeline       | `JevActionPolicy` and `JevClient` in `packages/server/src/ai/`: `buildJevActionRequest`, target expansion, `adaptJevActionAnswer`, `validateResponse`                                      |
| The primer shown to judges              | `primerCatalog()` in `packages/server/src/ai/primer.ts`, read when the bundle is built                                                                                                     |
| Provider presets and tactician settings | `PROVIDERS`, `loadAiConfig`, `configForRole` in `packages/server/src/ai/config.ts`                                                                                                         |
| Opponents and the `heuristic` baseline  | `HeuristicDecisionProvider` in `packages/bot`                                                                                                                                              |

Changing a primer, the prompt assembler or the provider changes the next benchmark run with no
edit here. Changing the engine, a card or the heuristic bot can change what a position leads to;
`verify` and the tests say so.

## Limits

- Thirty positions are a screen, not a statistic. They separate a model that reads the board from
  one that does not; they do not rank two good models with confidence. Use `--trials` and add
  cases from real games where a model misplayed.
- Positions have no commanders: the scenario format arranges none. Commander damage and the
  command zone are not tested.
- The table is the heuristic bot plus scripted replies, not a strong opponent. A reference marks
  what holds against correct play, and the case pages say when a consequence depends on the bot.
- Speed is measured from wherever the harness runs, over a few dozen calls per model.
- One provider request per decision is made at the client's fixed temperature of 0.1.
