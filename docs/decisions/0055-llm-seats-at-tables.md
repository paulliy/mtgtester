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

Input tokens alone, at OpenRouter's listed prices for Haiku 5.5 ($0.10 per million) and Sonnet 5.5
($2 per million), come to about $0.07 (tactician) and $0.28 (strategist) per 40-turn, four-seat game.
Output, including the thinking that current Claude models cannot turn off, is not in the census and
is expected to dominate: Sonnet output is $10 per million. The paid game in the plan's Phase 0
settles the real figure.

## Decision

1. **Host-only, operator opt-in.** A seat becomes a model seat only through `hostSetSeat`, and only
   when the server runs with `TABLE_AI_SEATS=1` and a usable provider key. Without the setting, the
   lobby does not offer it and the protocol parser refuses it.
2. **Models.** The Anthropic preset: Haiku 5.5 tactician (Sonnet 5.5 as its backup), Sonnet 5.5
   strategist (`PROVIDERS.anthropic.roleModels`). The table's `AiConfig` is built in code from the
   preset plus the overrides below, so stray `AI_*` variables on the host cannot turn on JEV,
   reflection or other experiments.
3. **Model-led play, with routine decision types on the card-aware bot.** `tacticalMode: 'model'`.
   A new `botDecisionTypes` list sends whole decision types to the card-aware bot
   ([ADR 0039](0039-bot-led-tactics.md)) after the plan, heuristics and cache, and before the
   tactician. Starting set: `mulligan`, `bottomCards`, `orderTriggers`, `optionalTrigger`,
   `commanderReplacement`, `legendRule`, `assignCombatDamage`. That is 7% of tactician calls in the
   census, so it is mainly a latency saving; the cost driver is the strategist. Empty by default, so
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
   billed. A model with no price entry cannot be used at a table: the server refuses to start rather
   than run an uncapped game.
6. **Clock.** A model seat gets a hard wall-clock deadline per decision, set from the paid game's
   measured latency. Retries happen only inside it. When it passes, the heuristic fallback answers,
   recorded as `fallback`.
7. **Randomness.** The heuristic fallback inside the AI provider draws from the seat's own ChaCha20
   fallback stream at tables (ADR 0031 decision 4), not from `HeuristicRng(requestId)`.
8. **Disclosure.** ADR 0031 decision 3 stands: no `apiWaiting`, AI note, strategist plan or cost
   figure reaches any player during play, and AI reasoning is not shown after the game either. The
   host's post-game view gets the table's total model spend and whether the cap was reached. Post-game
   reflection stays off at tables.

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
