# ADR 0039: Bot-led tactics, steered by the strategist

Status: Accepted (2026-11-10)

Date: 2026-11-10

## Context

In-game model calls are the second-largest cost after card authoring. An offline census of
40-turn four-player games (every seat on the real `OpenAiDecisionProvider` and
`StrategyCoordinator`, only the network client stubbed) counts about 4.2 tactician calls and 1.1
strategist calls per turn, about 16,000 prompt tokens per turn. A third of the tactician calls are
mulligans, bottoming, may-triggers and resolution picks (`general`), which a competent bot answers
without judgment.

The heuristic bot (ADR 0023) was a safety net, not a player. It scored actions with one flat bonus
per action type, so every castable spell tied with every other, it took the first target slot
option even for removal (often its own creature), it mulliganed and bottomed at random because
`keep` and `mulligan` scored the same, it attacked with everything at the lowest-life opponent, and
it floated mana by activating mana abilities for no reason.

The strategist returned a list of exact planned actions. Those fail closed whenever a phase, target
or object id drifts, which is the expensive half of the tactician's job done badly.

## Decision

1. **Card knowledge from the IR.** `server/src/ai/card-traits.ts` walks each `CardDefinition` and
   classifies effect ops by name pattern into coarse roles (removal, wipe, counter, draw, ramp,
   tokens, pump, protection, recursion, tutor, burn, lifegain, discard, extraTurn) and each target
   slot into hostile or friendly. The bot gets a lookup by card name (`CardKnowledge`), so
   `@mtg/bot` still depends only on `@mtg/shared`. The lookup is built once per game from
   `Engine.cardDefinitions()`, and the bot only asks about names its view shows.
2. **A card-aware policy in the bot** (`bot/src/policy.ts`, weights in `WEIGHTS.policy`). Spells are
   worth their mana value plus their roles in context: a counterspell only with an opponent's spell
   on the stack, removal by the best hostile target it can hit, a wipe by the board it nets, a pump
   or protection instant only in combat or in response. Targets follow slot polarity, threat and
   steering, and distinct slots get distinct objects. Attacks weigh whether each attacker survives
   the defender's untapped blockers. Mulligan, bottoming, may-triggers, sacrifice, discard and
   search picks have real rules. The old scoring stays behind `legacy: true` for comparison only.
3. **The strategist sets knobs, not actions.** `TurnStrategy.steering` (`BotSteering` in
   `@mtg/shared`) carries aggression, target order, cards to prioritize or hold, mana to hold up,
   and whether to avoid overextending. In bot mode the strategist gets `BOT_STRATEGIST_PRIMER` and
   returns only knobs. Knobs persist across turns per seat.
4. **Bot-led tactical mode.** `AI_TACTICAL_MODE=bot` makes the bot answer every decision the plan,
   heuristics and cache leave. `AI_BOT_ESCALATION=uncertain` asks the tactician model only when the
   bot's top two options on a priority, target, mode or X decision are within
   `AI_BOT_ESCALATION_MARGIN` LEP and are genuinely different. The default is `never`.
5. **Re-plan on change.** With `AI_STRATEGIST_REPLAN=onChange` (the default in bot mode), a seat's
   turn reuses its knobs when the public table has not moved much since they were set (a life swing
   of 10, a power swing of 8 or half the board, four nonland permanents, a commander arriving or
   leaving, a player dying), up to `AI_STRATEGIST_MAX_REUSE_TURNS` turns in a row.
6. **Measured, not assumed.** `bun run ai-call-census` counts calls and prompt tokens per turn for
   each mode. `bun run bot-league` plays bot configurations against each other, two seats each,
   each seed twice with seats swapped.

`AI_TACTICAL_MODE` stayed `model` by default in this change. The quality evidence here is bot
against bot; the switch should flip after one comparison against the real tactician in paid games.

**Update 2026-11-14: the default is now `bot`.** Paul decided on 2026-11-10 that the bot is the
default tactician. The same change replaced the tactician chain, which still answers escalations
and every seat that sets `AI_TACTICAL_MODE=model`: `poolside/laguna-s-2.1` had no OpenRouter
provider left and `sao10k/l3-lunaris-8b` rate-limited the first duel, so the chain is now
`particle-ai/particle-1` at low reasoning, with `deepseek/deepseek-v4-flash` as the backup (both
listed on OpenRouter on 2026-11-19; an earlier draft of this change used `qwen/qwen3.7-flash`,
`deepseek/deepseek-v4-flash`, `upstage/solar-mini4`). The tactician is never routed to CoreWeave,
Modal or Cohere (`AI_TACTICIAN_IGNORE_PROVIDERS`, sent as OpenRouter `provider.ignore`). A fair duel, three seeds each played with seats swapped, is the
check against the model tactician; its numbers go under Measurements. The bar, set before the run: bot-led seats win at least 40%
of games and make under a third of the model seats' calls per turn, and the duel is rerun if model
seats fell back on more than 5% of tactician calls (`tacticianFallbackShare` in each report).
`bun run ai-mode-duel --offline` plays the same game with no key for a free wiring check.

## Measurements

`bun run ai-call-census`, six four-player games per mode, 40-turn cap (bot games end sooner, so
per-turn numbers are the fair comparison):

| Mode                      | Model calls per turn | Prompt tokens per turn |
| ------------------------- | -------------------- | ---------------------- |
| model (today)             | 5.57                 | about 17,300           |
| bot, re-plan every turn   | 1.22                 | about 3,400            |
| bot, re-plan on change    | 0.76                 | about 2,200            |
| bot, escalate close calls | 1.24 (4 of 6 games)  | about 3,700            |

Re-plan on change reused a seat's knobs 95 times in 209 turns.

Two limits on these numbers. The census strategist stub answers `plannedActions: []`, so in model
mode no decision is ever answered from a plan and every one becomes a tactician call; 5.57 and the
saving ratio are upper bounds, since a real strategist plan answers some decisions for free. And
0.76 assumes every strategist answer yields valid knobs: an answer whose knobs clean to nothing
stores no steering, so that seat is asked again every turn (the 1.22 row) until one is valid. The escalation run is partial (0.53 tactician calls per turn, all priority decisions): two
of its games halted on engine errors (`casting restriction is not met`, and a runaway past 20,000
decisions) that the stub tactician's answers reached; those are engine issues to follow up.

`bun run bot-league`, card-aware bot (`knowledge`) against the pre-ADR bot (`legacy`), 100 games,
paired seeds with seats swapped: 62 wins to 28, 9 draws, 1 timeout (68.9% of decided games, 95%
interval 59 to 79%), life share 0.67 to 0.33. Card knowledge from the IR is worth a little on its
own: `knowledge` beat the same policy with mana value only (`policy`) 30 to 24.

### Paid game (`bun run ai-mode-duel`)

One four-player game on OpenRouter, seed `mode-duel-1`, 60-turn cap, run from 6c0ae74 (before the
late-knobs fix, so the bot seats' strategist numbers are a worst case). P1 and P3 bot-led, P2 and
P4 model mode. The model seat P2 won on turn 45; 98 minutes, about $0.065 in all.

| Mode  | Tactician calls | Strategist calls | Calls per turn | Prompt tokens per turn | Cost    | Failed calls |
| ----- | --------------- | ---------------- | -------------- | ---------------------- | ------- | ------------ |
| bot   | 0               | 12               | 0.27           | about 900              | $0.0174 | 3            |
| model | 130             | 21               | 3.36           | about 11,800           | $0.0473 | 21           |

The cost side holds: bot-led seats made about a twelfth of the calls and a thirteenth of the
prompt tokens. The quality side is not settled by this game. Two of the three default tactician
models (`qwen/qwen3.7-flash`, `poolside/laguna-s-2.1`) were unavailable, so the model seats ran on
`sao10k/l3-lunaris-8b:nitro`, hit its rate limit 96 times, and had 33 decisions played by the
fallback bot. One game is also one sample. A fair quality comparison needs an available tactician
chain and several games with seats swapped.

## Consequences

- The fallback bot on a model failure, the table server's bots and the sweeps all play the new
  policy, because it is the default when `legacy` is unset. Seeded tests whose outcome depended on
  the old reckless attacks needed longer games (`session-diplomacy.test.ts`).
- Any change to `packages/engine/src` re-pins the benchmark fixtures'
  `supportedEngineVersion`; this one added `Engine.cardDefinitions()` and refreshed them with
  `bun run ai-bench refresh --suite core-fast --write`.
- Role classification is by op-name pattern. A new op lands in a sensible bucket or none; none costs
  the bot information, never legality.
- Not done here, and the next steps: tune `WEIGHTS.policy` by self-play with the league once the
  engine is cheaper (ADR 0023 item 12), compare bot mode against the model tactician in paid games,
  and use logged model answers to check the bot's close calls.

## Amendment (2026-11-16): wake rule `table-v2` (hill-climb S7)

`AI_STRATEGIST_WAKE_RULE` picks which table changes wake the strategist under `onChange`.
`table-v1` is decision 5 as written. `table-v2`, the new default, keeps its thresholds but drops
the changes a seat's knobs already expected:

- the seat's own power or nonland count growing (its own plays carrying out its knobs); its own
  losses still wake it;
- any commander arriving: every commander is public from turn 0, in the prompt with its text and
  cast count, and a big body still shows in its seat's power and permanents. A commander leaving,
  which nobody can schedule, still wakes.

Why: the census showed commander arrivals behind 30% of all wakes, most of them a commander
entering on any of the four seats, which woke every other seat in turn.

Evidence, all offline (`bun run hill-climb --only model`, standard profile, and `bun run
bot-league`, 200 games per pairing, seed `s7`):

| Measure                            | table-v1 | table-v2 | Change           |
| ---------------------------------- | -------- | -------- | ---------------- |
| `model.bot.callsPerTurn`           | 0.803    | 0.605    | -24.7%           |
| `model.bot.promptTokensPerTurn`    | 2,490    | 1,898    | -23.8%           |
| League proxy-strategist calls      | 2,613    | 2,193    | -16%             |
| League: v2 against v1, v2 win rate |          | 49.4%    | 95% CI 42 to 57% |

The league steers the bot with a deterministic proxy strategist (`ai/proxy-strategist.ts`) under
each schedule. The same league could not tell the proxy asked every turn from no strategist at all
(49.1%, CI 42 to 57%), so it shows only that v2 does not break the bot; it cannot see knob
staleness. The real check is paid: `bun run ai-mode-duel --opponents bot-v1` seats table-v2 bot
seats against table-v1 bot seats with the same strategist, and needs approval before it runs.
