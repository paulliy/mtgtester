# ADR 0055: LLM seats at tables

Status: Proposed

Date: 2026-11-26

Amends [ADR 0031](0031-multiplayer-tables.md) decision 10 ("LLM seats are not offered at tables
yet"). The work plan is [docs/plans/table-llm-seats.md](../plans/table-llm-seats.md).

## Context

Tables ([ADR 0031](0031-multiplayer-tables.md)) seat only people and the heuristic bot. Decision 10
kept model-driven seats out for three reasons: AI cost reports leak information about a bot's hand,
nothing bounds what one game spends, and a table must answer within its clock.

Two things have changed. The table server runs on one operator's VM, and only the holder of its
host secret can create a table; only the host token can give a seat to a bot
(`table/table.ts:525`), so an invited player can never add a paid seat. And the operator wants
model opponents at their own tables.

The session already takes the model stack as an injected `ai: SessionAi`
(`match/session-ai.ts`), and the AI provider already falls back to the heuristic bot when a call
fails (`ai/provider.ts:531-567`). What is missing is per-seat provider choice, the limits below,
and the table protocol and lobby.

### Measured so far (offline census, 2026-11-26)

`bun run ai-call-census --games 4` (4 seats, all in model mode, 40-turn cap, stub client):

| Per game turn (4 model seats) | Value  |
| ----------------------------- | ------ |
| Tactician calls               | 5.04   |
| Strategist calls              | 1.18   |
| Tactician prompt tokens       | 16,835 |
| Strategist prompt tokens      | 3,475  |

Tactician calls by decision type over 158 turns (796 calls): `priority` 458, `general` 161,
`declareAttackers` 78, `declareBlockers` 24, `orderTriggers` 23, `mulligan` 20, `chooseTargets` 16,
`optionalTrigger` 9, `assignCombatDamage` 6, `bottomCards` 1.

### Paid games (2026-11-26, OpenRouter, one game per setting)

`bun run ai-mode-duel --max-usd 2 --trace` on the default seed, every role on
`anthropic/claude-haiku-5.5` through OpenRouter (no provider cache reads on that path), strategist
reasoning at medium effort. P2 and P4 play model-led; P1 and P3 play bot-led. Costs are billed
figures OpenRouter reported.

| Two model-led seats                            | A: tactician reasoning off | B: tactician reasoning low |
| ---------------------------------------------- | -------------------------- | -------------------------- |
| Game                                           | 28 turns, 7.9 min          | 34 turns, 30.8 min         |
| Model seats' own turns                         | 14                         | 19                         |
| Cost, both model seats                         | $0.14                      | $0.55                      |
| Tactician calls (per own turn)                 | 176 (12.6)                 | 623 (32.8)                 |
| Decisions other than turn start: p50, p95, max | 0.9 s, 7.5 s, 14.3 s       | 1.9 s, 5.4 s, 18.5 s       |
| Turn-start wait, duel harness only (median)    | 16.2 s (14 waits)          | 14.6 s (31 waits)          |
| Winner                                         | P1 (bot-led)               | P4 (model-led)             |

Three things follow. A seat costs roughly $0.07 to $0.28 a game on Haiku, so three model seats fit
under $1 in both games, though B's rate is close to it on a longer game. The turn-start waits are an
artifact of the duel harness, which puts the strategist and every tactician call on one queue that
runs one request at a time (`cli/ai-mode-duel.ts:490-534`). A real session gives the strategist its
own queue (`match/session.ts`, `aiStrategistQueue`), and a decision never waits for a turn plan
(`guidanceFor` reads whatever has landed); a session test with a strategist that never answers
confirms it. At a table, a person waits only for the tactician (0.9 s p50, 7.5 s p95 in game A).
One game per setting says nothing about strength. A partial game with a Sonnet strategist (stopped at
turn 15 when the models changed) had Haiku tactician decisions at 1.1 s p50 and 6.2 s p90.

## Decision

1. **Host-only, operator opt-in.** A seat becomes a model seat only through `hostSetSeat`, and only
   when the server runs with `TABLE_AI_SEATS=1` and a usable provider key. Without the setting, the
   lobby does not offer it and the protocol parser refuses it.
2. **Models.** Claude Haiku 5.5 for every role (Paul, 2026-11-26): the strategist with reasoning at
   medium effort, the tactician with thinking off (setting A above, cheaper and faster per
   decision). The table's `AiConfig` is built in code from these settings, so stray `AI_*`
   variables on the host cannot turn on JEV, reflection or other experiments. The server calls the
   Anthropic Messages API directly (Paul, 2026-11-26), so decision 5's price table is required.

   "Thinking off" must be sent as `thinking: {"type": "disabled"}`. Anthropic's effort page says
   Haiku 5.5 accepts it at effort `high` or below, and that Opus 5.5 rejects it with a 400 at every
   effort. Today `anthropicEffort` maps reasoning off to effort `low` with thinking left on
   (`ai/anthropic.ts:58-65`), which matches setting B more than A. The table phase sends the
   disabled form for models that accept it.

3. **Model-led play, with routine decision types on the card-aware bot.** `tacticalMode: 'model'`.
   A new `botDecisionTypes` list sends whole decision types to the card-aware bot
   ([ADR 0039](0039-bot-led-tactics.md)) after the plan, heuristics and cache, and before the
   tactician. Starting set: `mulligan`, `bottomCards`, `orderTriggers`, `optionalTrigger`,
   `commanderReplacement`, `legendRule`, `assignCombatDamage`. That is 7% of tactician calls in the
   census and 3% to 6% in the paid games, so it is a small saving. Empty by default, so
   the tester is unchanged. Accepted only with a duel or league showing no loss in model-seat
   strength.
4. **Spending.** Account-wide spending is bounded by the limit on the API key itself, which the
   operator sets with the provider. Each game has its own cap, `TABLE_AI_MAX_USD_PER_GAME`
   (default `1.00`), shared by all model seats at the table. A call is made only while the game's
   total is under the cap. When it is reached, or the provider reports the key out of credit or
   over its limit, every model seat finishes the game on the heuristic bot, with one public log
   line. Nothing halts.
5. **Cost must be known to be capped.** Today a dollar cost exists only where OpenRouter reports
   `usage.cost` (`ai/client.ts:567`); the Messages API path reports tokens but no price. Model seats
   on the Anthropic API therefore need a local price table per model (input, output, cache read,
   cache write), applied to each attempt's usage, including failed and timed-out attempts that were
   billed. An attempt sent with no usage reported is charged its whole prompt and output allowance. A model with no price entry cannot be used at a table: the server refuses to start rather
   than run an uncapped game.
6. **Clock.** A tactician call gets a hard wall-clock deadline (15 s to start with, about twice the
   measured p95). Retries happen only inside it, the AI provider's corrective retry after an
   invalid answer included: the deadline is per decision, not per call. When it passes, the heuristic fallback answers,
   recorded as `fallback`. The strategist call at turn start has its own deadline (30 s to start
   with); when it passes, the seat plays on without a plan for that turn. Paul asked for the
   strategist to start earlier so people would not wait for it, but the wait was the duel
   harness's shared queue, not the session (see the paid-games notes): at a table nobody waits for
   the strategist. It already starts at the previous turn's last decision. Starting it a full turn
   earlier would make the plan ready sooner, at the cost of planning from an older board and of a
   per-seat plan slot in the coordinator; that is left out until play shows early decisions
   suffer from the missing plan.
7. **Randomness.** At a keyed table, the heuristic fallback inside a model seat's AI provider
   breaks ties on that seat's own bot stream (stream 1 + seat, ADR 0031 decision 4), not on
   `HeuristicRng(requestId)`. No heuristic bot reads that stream, because the seat is the model's,
   and a model seat never has a clock fallback bot.
8. **Disclosure.** ADR 0031 decision 3 stands: no `apiWaiting`, AI note, strategist plan or cost
   figure reaches any player during play, and AI reasoning is not shown after the game either. The
   host's post-game view gets the table's total model spend and whether the cap was reached. Post-game
   reflection stays off at tables. When the budget stops, every seat gets one `aiBudget` table
   frame naming only the reason (the cap, or the key refused), never an amount. The host's spend
   line is a `tableAiSpend` frame, sent after the game to host sockets only.

## Consequences

- Each model seat sends its own redacted view to the provider, as in the tester. The provider never
  sees other hands or the RNG key.
- **Latency side channel, accepted.** A model seat thinks longer on some decisions than others, and
  that can hint at its hand. The deadline bounds it. Padding every answer to a fixed time would
  remove it at the cost of slower games, and is not done.
- A game can switch from model play to the heuristic bot partway through when the cap is reached.
  The paid measurement shows how often that would happen at $1.
- The table worker now bundles `ai/`. The module-graph test (`table/module-graph.test.ts`) must still
  find no runtime `batch/` or `benchmark/` module.
