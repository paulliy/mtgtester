# Running Jev test games locally

How to try the Jev decision model (ADR 0041) on your own machine. Every command runs from the
repository root. Paid runs read `OPENROUTER_API_KEY` from your local `.env`; nothing prints or
stores the key.

## 1. Free check first

Plays two games with no network and no key. The chat tactician is the bot and Jev is a stub, so
the numbers only show that every seat is wired up and how many calls a paid run would make.

```powershell
bun install
bun run jev-duel --offline --games 2 --turn-cap 30 --seats bot,bot-jev,bot-shadow,jev --out .jev-runs/offline
```

Look at `perPreset.<preset>.jev.calls` in the report: that is how many Jev calls each seat would
make. `chat.tacticianCalls` should be 0 for every preset except `model` and `jev-model`.

## 2. Paid runs

Each command stops making calls at `--max-usd` (chat and Jev together) and finishes the game on
the bot. Costs below are rough: about $0.00006 per Jev call, and the strategist runs for every
seat.

| Goal                                          | Command                                                                                           | Rough cost                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| Does Jev agree with the bot? (play unchanged) | `bun run jev-duel --seats bot-shadow,bot,bot-shadow,bot --max-usd 0.10 --out .jev-runs/shadow`    | strategist + under $0.01 of Jev |
| Does Jev on close calls beat the plain bot?   | `bun run jev-duel --seats bot-jev,bot,bot-jev,bot --games 4 --max-usd 0.40 --out .jev-runs/close` | strategist + about $0.01 of Jev |
| All four placements at one table              | `bun run jev-duel --seats bot,bot-jev,model,jev --games 4 --max-usd 0.60 --out .jev-runs/four`    | the `model` seat dominates      |

`--games N` rotates the lineup one seat per game, so every preset plays every seat. Add
`--jev-min-confidence 0.6` (and `--jev-min-margin 0.1`) to make Jev hand low-confidence decisions
back to the bot.

## 3. Reading the results

`--out DIR` writes three files:

- `report.json`: wins per preset, chat and Jev calls, tokens and cost per preset, and agreement.
- `jev-traces.jsonl`: one line per decision Jev was offered: shape, outcome, confidence, margin,
  chosen option, latency and cost.
- `jev-comparisons.jsonl`: one line per decision where Jev answered beside another answerer:
  the played action, Jev's action, whether they agree, and whether the bot called it close.

`agreement.closeCallsAgreed / agreement.closeCalls` is the number to watch for the close-call
placement. If agreement is high, Jev adds little over the bot there; if it is low, only the
`bot-jev` win rate says whether Jev's different choices are better.

## Seat presets

| Preset       | Tactics                         | Jev                                                                  |
| ------------ | ------------------------------- | -------------------------------------------------------------------- |
| `bot`        | bot-led (ADR 0039)              | none                                                                 |
| `bot-shadow` | bot-led                         | answers beside the bot, never changes play                           |
| `bot-jev`    | bot-led                         | decides the bot's close calls; the bot's answer stands if Jev cannot |
| `model`      | chat tactician                  | none                                                                 |
| `jev`        | Jev on every supported decision | the bot answers the rest                                             |
| `jev-model`  | Jev on every supported decision | the chat tactician answers the rest                                  |

The same placements work in the app and `pool --ai` through `.env`; see `.env.example`
(`AI_JEV_*`).
