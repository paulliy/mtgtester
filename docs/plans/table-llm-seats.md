# Plan: LLM seats at tables

Status: Phases 3 and 4 in review (2026-11-26). Phases 0 to 2 done. Phase 5 left: real paid table game and deploy. Amends
[ADR 0031](../decisions/0031-multiplayer-tables.md) decision 10 once accepted.

## Goal

A table host can give an empty seat to a **model-driven bot** (the same `OpenAiDecisionProvider` +
`StrategyCoordinator` stack the tester uses for "AI bots"), next to the existing built-in bot. Off
unless the server operator turns it on and supplies a key.

## Decisions (Paul, 2026-11-26)

- **Models (revised 2026-11-26):** Claude Haiku 5.5 for both roles. Strategist reasoning at
  medium effort; tactician thinking off (ADR 0055 decision 2 and its paid-game table).
- **Provider:** the Anthropic Messages API directly, with the key Paul holds (not OpenRouter).
- **Strategist starts early:** a model seat's turn plan is requested before its turn begins, so
  people do not wait at the start of its turn.
- **Server:** the existing Oracle Cloud VM (`docs/guides/deploy-oracle-cloud.md`).
- **Account-wide spending** is bounded by the limit set on the API key itself, outside this code.
  The server does not keep its own daily cap.
- **Per-game cap: about $1** for all model seats at one table together.
- **Model-led play** (`tacticalMode: 'model'`), but routine decisions that do not need judgment
  go to the card-aware heuristic bot instead of the model (Phase 2).
- **AI reasoning after the game:** out of scope. Notes and reflection stay off at tables.

## Why ADR 0031 said no, and what changes

ADR 0031 decision 10 gives three reasons LLM seats are not offered at tables:

| Reason                                               | Answer in this plan                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No per-game call cap bounds the host's spending.     | Only the host secret creates a table, and only the host token can call `hostSetSeat` (`table/table.ts:525`), so an invited player can never add a paid seat. The key's own limit bounds the account. A $1 per-game cap, enforced by the server, bounds each game; a seat that reaches it finishes on the heuristic bot. |
| Cost reports leak (token counts track a bot's hand). | The table policy already denies `apiWaiting` and AI notes (decision 3). Both stay denied, now with tests on a table that has a model seat. The remaining latency side channel is accepted and documented.                                                                                                               |
| A table must answer within its clock.                | A hard per-decision deadline for model seats, after which the heuristic bot answers.                                                                                                                                                                                                                                    |

## What already exists

- `MatchSession` takes the model stack as an injected `ai: SessionAi` (`match/session-ai.ts`), so
  table code only needs to pass it. The table worker passes nothing today.
- `ai/` imports `benchmark/` only as types (`ai/policy-registry.ts:1`, `ai/strategy-router.ts:2`),
  which the module-graph test allows (`table/module-graph.test.ts`). This still needs proving by
  running the test with `sessionAi` wired into the worker.
- The AI provider already falls back to the heuristic bot when a call fails
  (`ai/provider.ts:531-567`).
- In model mode, `heuristics.ts` already answers _dominated_ decisions (one sensible option)
  without a call, and the decision cache reuses identical answers.
- The table disclosure policy (`tablePolicy()`) already withholds AI cost reports and other seats'
  AI notes.

## What is missing

- **The session chooses the provider for the whole game, not per seat.** `providerFor` checks
  `opts.providerKind !== 'ai'` (`match/session.ts:2398`), and so do the logger (`:431`), the turn
  prefetch (`:620`), reflection seats (`:2188`) and diplomacy proposing (`:423`). A table with one
  model seat and one built-in bot needs this decided per seat from `seatControllers`.
- **The table worker always starts the game with `providerKind: 'random'`.** It also maps every
  non-human seat to `'random'` (`table/in-process-port.ts:207-261`).
- **The table protocol has no model controller.** `TableSeatController` is
  `'open' | 'bot' | 'human'`, `HostSeatController` is `'bot' | 'open'`
  (`shared/src/table-protocol.ts:43-46`), and the parser rejects anything else (`:427`).
- **No spend cap exists anywhere in `ai/`.** There are rate limits and retries, but nothing limits
  money spent per game.
- **Model mode has no "routine decisions to the bot" route.** The bot answers only dominated
  decisions, failures and (in `bot` mode) everything. Nothing sends a whole decision _type_ to the
  card-aware bot while the model keeps the rest.
- **The fallback uses a request-id RNG.** The heuristic fallback inside the AI provider seeds from
  `new HeuristicRng(request.requestId)` (`ai/provider.ts:553`), not from the seat's ChaCha20
  stream (ADR 0031 decision 4).

## Phases

Each phase is its own pull request. I stop after each one for your review.

### Phase 0: decision and measurement (no product code)

1. Write ADR 00NN, "LLM seats at tables", amending 0031 decision 10. It records the decisions
   above, the host-only rule, the per-game cap, the deadline, the routine-decision route, and the
   accepted latency side channel. Run `bun run adr:index`.
2. Measure a 4-seat game with three model seats on the Anthropic preset: offline with
   `bun run ai-call-census` first, then one paid game through the tester. Record:
   - calls per turn by role and by `decisionType`;
   - dollars per game, to check that **$1 covers a full game**. Claude models at tables had
     never been measured. The only paid figure is from cheaper OpenRouter models: about $0.13
     billed for one model seat over a 98-minute duel (ADR 0039, ADR 0040). If a typical game
     costs more than $1, the cap would hand most games to the bot partway through, and we should
     talk before Phase 2;
   - p50, p95 and maximum seconds per tactician decision and per strategist call. These set the
     deadline.

### Phase 1: per-seat provider kind in the session (tester behavior unchanged)

1. Make `seatControllers[seat]` the source of truth in `MatchSession`. `providerFor`, the call
   logger, the turn prefetch, the strategy coordinator's seat set, reflection seats and diplomacy's
   `proposesOnItsOwn` all ask "is this seat a model seat?" instead of reading `opts.providerKind`.
   Single-player and spectator games still derive every bot seat from `providerKind`, so they play
   the same.
2. Require `opts.ai` when any seat is a model seat, not only when `providerKind === 'ai'`.
3. The heuristic fallback inside the AI provider takes an injected `{ nextInt }` source. In table
   games that is the seat's own bot stream, which no heuristic bot reads at a model seat. Other
   games keep the current seeding, so their decisions stay the same.
4. Tests: a mixed game (one model seat with a stubbed client, one heuristic seat) asks the model
   only for the model seat. Existing session tests pass unchanged. `bun run hill-climb` shows
   identical fingerprints, because no benchmark game has mixed seats.

### Phase 2: routine decisions to the bot, the deadline and the cap

1. **Routine decisions go to the card-aware bot.** A new config field, `botDecisionTypes`, lists
   the `DecisionType`s the card-aware bot (`bot/src/policy.ts`, ADR 0039) answers in model mode.
   That happens after the plan, heuristics and cache, and before any tactician call. The default
   is empty, so the tester is unchanged; table model seats get the table set. The starting set,
   to be confirmed by Phase 0's census:
   - **bot:** `mulligan`, `bottomCards`, `orderTriggers`, `optionalTrigger`,
     `commanderReplacement`, `legendRule`, `assignCombatDamage`;
   - **model:** `priority`, `declareAttackers`, `declareBlockers`, `chooseTargets`,
     `chooseModes`, `chooseX`, `general`.

   The strategist still plans every turn, so its knobs (aggression, cards to hold, targets) steer
   the bot's routine picks the same way they do in bot mode. Evidence before the set is accepted:
   `bun run bot-league` or a mode duel with the route on and off, with no drop in model-seat win
   rate and fewer tactician calls per turn. Recorded as `bot` in `game_decision_sources`.

2. **Deadlines.** A table model seat gets its own `AiConfig` override: 15 s per tactician call and
   30 s for the turn-start strategist call (ADR 0055 decision 6, from Phase 0's measurements).
   Retries happen only within the deadline, with `retryOnTimeout: false`. A tactician call past its
   deadline gets the heuristic fallback, recorded as `fallback`; a strategist call past its
   deadline leaves the seat on its previous knobs.

3. **Per-game cap**, `TABLE_AI_MAX_USD_PER_GAME`, default `1.00`. On OpenRouter it uses the billed
   cost each call reports (ADR 0040). **The Anthropic API path reports no dollar cost today**
   (`ai/client.ts:567` reads only OpenRouter's `usage.cost`), so this phase adds a per-model price
   table (input, output, cache read, cache write) applied to every billed attempt's usage, and the
   server refuses to enable model seats for a model with no price entry (ADR 0055 decision 5). The
   cap counts across all model seats at the table. A call is sent only
   if the running total is under the cap. Once the cap is reached, every model seat switches to
   the heuristic bot for the rest of the game. No exception and no halt. The session reports the
   stop through `tableAi.onBudgetStop`; the public log line ("AI budget reached; bots continue on
   built-in play") and the host's message are wired in Phase 4 with the rest of the table UI.

   Built: `ai/pricing.ts` (Haiku 5.5 only, from Anthropic's pricing page) and `ai/game-budget.ts`
   (`GameAiBudget`, `limitedClient`). The wrapper refuses a call once the budget stops and charges
   every physical attempt the client reports, including failed ones.

4. **The key's own limit.** When the provider says the key is out of credit or over its limit
   (a billing or quota error, not an ordinary 429 rate limit), the table treats it the same as
   reaching the cap: the seats switch to the bot at once, rather than paying the deadline on every
   decision. One host-only message says so.

5. **Thinking off, and the strategist wait.** For models that accept it (Haiku 5.5),
   `anthropicRequest` sends `thinking: {"type": "disabled"}` when a role's reasoning is off,
   instead of effort `low` with thinking on (ADR 0055 decision 2). Starting the strategist earlier
   turned out to be unnecessary for waiting: the paid games' turn-start pauses came from the duel
   harness's shared queue. A session test with a strategist that never answers shows a model
   seat's decisions go ahead without it (ADR 0055 decision 6).

6. **No JEV, no reflection and no post-game call** at tables. The table's `AiConfig` is built in
   code from the Anthropic preset plus the table overrides, so a stray `AI_*` variable on the VM
   cannot turn these on.

7. Tests with a stubbed client cover each case: a routine decision never reaches the client, a
   slow client hits the deadline, a costly client hits the cap mid-game (end to end, priced from
   the tokens a stubbed Messages API reports), and an out-of-credit error stops the budget.

### Phase 3: wiring the table worker

1. Add `TABLE_AI_SEATS=1` to the table server's settings. The server reads it at startup and
   refuses to start if it is set without `ANTHROPIC_API_KEY`. Without it, everything works as
   today.
2. The worker boot message carries `aiSeats: boolean`. When it is on, the worker passes
   `ai: sessionAi` (or the table-only equivalent from step 4) to the session. Before relying on
   this, check that a Bun `Worker` sees the parent's `process.env`. If it does not, pass the
   provider settings in the boot message rather than re-reading the environment.
3. `in-process-port.ts` maps the new controller to `'ai'` in `seatControllers` and in the
   `gameStarted` payload's `controllers`.
4. Run `table/module-graph.test.ts` with the worker now reaching `ai/`. If it pulls in any
   runtime `benchmark/` or `batch/` module, add a thin table-only entry (for example
   `table/table-ai.ts` exporting the same object) rather than widening the allowlist.
5. Memory check against `mtg-table.service`'s `MemoryHigh=700M`: start a table with three model
   seats and record resident memory. That matters most if the VM is the 1 GB AMD micro rather
   than the Ampere shape.

Built (2026-11-26): `TABLE_AI_SEATS`, `ANTHROPIC_API_KEY` and `TABLE_AI_MAX_USD_PER_GAME` in
`table/config.ts` (the key is checked but never stored in the config); the start config and
session port carry a `model` seat and the cap; the worker passes `sessionAi` and the key from its
own environment (a Bun worker inherits the parent's, checked on Bun 1.4.4). The module-graph test
passes with the worker reaching `ai/`. A model seat on a port without AI services fails the start
with `setupFailed` rather than playing uncapped.

### Phase 4: protocol and lobby

1. `TableSeatController` and `HostSeatController` gain `'model'`, with a `PROTOCOL_VERSION` bump.
   The parser accepts `'model'` only when the server advertises it.
2. The lobby payload advertises `modelSeats: boolean` (true only with `TABLE_AI_SEATS=1`). The
   host's seat control in `apps/web/src/table/TableLobby.vue` adds "AI bot (uses API budget)"
   next to "Built-in bot" only when the server advertises it. Other players see "AI bot" on the
   seat.
3. `TableStatusBar.vue`, the post-game results (`TableResultsDeck.controller`) and
   `game_decision_sources` label model seats distinctly from built-in bots.
4. Tests: the protocol parser accepts `'model'` only when enabled, a non-host socket cannot set it,
   and the lobby shows the option only when the server offers it.

Built (2026-11-26): `model` in `TableSeatController` and `HostSeatController`,
`PROTOCOL_VERSION` 2, `TableStatePayload.modelSeats`, and the `modelSeatsOff` refusal. The budget
notice is a new table frame, `aiBudget` (`{ reason: 'cap' | 'key' }`, gated `always`, no
amount), which the status bar shows as one line. Checked in Chromium against `serve:table --dev`
with a dummy key: the lobby offers "AI bot" on open seats, and in play Anthropic's 401 on the
first model call stopped the budget and showed "The AI service refused this server".

### Phase 5: disclosure check, end-to-end and deploy

1. Disclosure tests on a table with a model seat. No `apiWaiting`, AI note, strategist plan or
   cost figure reaches any socket during play or after it. `table/frame-scan.ts` and
   `exposure.ts` cover the new frames.
2. The host's post-game view shows the table's total model spend, and whether the cap was reached.
   That is a number, not reasoning.
3. `scripted-run.ts` plays a table with a model seat against a stubbed client. Then one real
   table game on `bun run dev --table` with the Anthropic key.
4. Deploy notes: update `deploy/oracle-cloud/mtg-table.env.example`, replacing the current
   misleading "model-driven opponents" comment with `TABLE_AI_SEATS`, `AI_PROVIDER=anthropic`,
   `ANTHROPIC_API_KEY` and `TABLE_AI_MAX_USD_PER_GAME`. Add a section to
   `docs/guides/deploy-oracle-cloud.md`. Setting the key and turning it on, on the VM, is Paul's
   step.

## Accepted risks (stated in the ADR)

- **Latency side channel.** A model seat visibly thinks longer on some decisions than others, and
  that can hint at its hand. The deadline bounds this but does not remove it. Padding every model
  answer to a fixed time would remove it at the cost of slower games, so it is not done here.
- **The provider sees the bot's own view.** The model receives only that seat's redacted view,
  as in the tester. It never sees other hands or the RNG key.
- **The cap can end model play partway through a game.** Phase 0 shows how often that would
  happen at $1.
