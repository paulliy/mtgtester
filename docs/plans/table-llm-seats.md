# Plan: LLM seats at tables

Status: draft, awaiting answers to the open questions at the end. Amends
[ADR 0031](../decisions/0031-multiplayer-tables.md) decision 10 once accepted.

## Goal

A table host can give an empty seat to a **model-driven bot** (the same `OpenAiDecisionProvider` +
`StrategyCoordinator` stack the tester uses for "AI bots"), next to the existing built-in bot. Off
unless the server operator turns it on and supplies a key.

## Why ADR 0031 said no, and what the host secret does and does not fix

ADR 0031 decision 10 gives three reasons LLM seats are not offered at tables:

| Reason                                               | Does the host secret solve it?                                                                                                                                                                                                                                                                                                                                                                          | What this plan does                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No per-game call cap bounds the host's spending.     | **Partly.** Only the host secret creates a table, and only the host token can call `hostSetSeat` (`table/table.ts:525`), so an invited player can never add a paid seat. But one game still has no ceiling: a 4-hour, 3-model-seat game, or a retry storm, has no bound. Anyone holding the secret (it is printed in the journal at every start) can also open up to `TABLE_MAX_TABLES` tables at once. | A per-table spend cap and a server-wide daily cap, both enforced on the server. A seat that hits a cap finishes the game on the heuristic bot.                |
| Cost reports leak (token counts track a bot's hand). | **No.** The secret controls who creates tables, not what players at the table see.                                                                                                                                                                                                                                                                                                                      | The table policy already denies `apiWaiting` and AI notes (decision 3). Keep both denied during play; add tests. Document the remaining latency side channel. |
| A table must answer within its clock.                | **No.**                                                                                                                                                                                                                                                                                                                                                                                                 | A hard per-decision deadline for model seats, after which the heuristic bot answers.                                                                          |

So the host secret is a good reason to allow LLM seats as a host-only choice. It is not enough by
itself; the caps and the deadline are still required.

## What already exists

- `MatchSession` takes the model stack as an injected `ai: SessionAi` (`match/session-ai.ts`), so
  table code only needs to pass it. The table worker passes nothing today.
- `ai/` imports `benchmark/` only as types (`ai/policy-registry.ts:1`, `ai/strategy-router.ts:2`),
  which the module-graph test allows (`table/module-graph.test.ts`). This still needs proving by
  running the test with `sessionAi` wired into the worker.
- The AI provider already falls back to the heuristic bot when a call fails
  (`ai/provider.ts:531-567`), and answers dominated decisions locally (`heuristics.ts`, decision
  cache) without a call.
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
  money spent per game or per day.
- **The fallback uses a request-id RNG.** The heuristic fallback inside the AI provider seeds from
  `new HeuristicRng(request.requestId)` (`ai/provider.ts:553`), not from the seat's ChaCha20
  stream (ADR 0031 decision 4).

## Phases

Each phase is its own pull request. I stop after each one for your review.

### Phase 0: decision and measurement (no product code)

1. Write ADR 00NN, "LLM seats at tables", amending 0031 decision 10. It records the host-only rule,
   the caps, the deadline, the accepted latency side channel, and the provider/mode choice from
   the open questions. Run `bun run adr:index`.
2. Measure a 4-seat game with three model seats on the chosen provider and model, offline with
   `bun run ai-call-census` and then one paid game through the tester. Record calls per turn,
   dollars per game, and p50/p95/max seconds per model decision. The only paid figures today are
   from OpenRouter models: about $0.13 billed for one model seat over a 98-minute duel
   (ADR 0039, ADR 0040). The new Claude preset (Haiku tactician, Sonnet strategist, commit
   `02f99fbd`) has not been measured. These numbers set the cap defaults and the deadline.

### Phase 1: per-seat provider kind in the session (tester behavior unchanged)

1. Make `seatControllers[seat]` the source of truth in `MatchSession`. `providerFor`, the call
   logger, the turn prefetch, the strategy coordinator's seat set, reflection seats and diplomacy's
   `proposesOnItsOwn` all ask "is this seat a model seat?" instead of reading `opts.providerKind`.
   Single-player and spectator games still derive every bot seat from `providerKind`, so they play
   the same.
2. Require `opts.ai` when any seat is a model seat, not only when `providerKind === 'ai'`.
3. The heuristic fallback inside the AI provider takes an injected `{ nextInt }` source. In table
   games that is the seat's own fallback stream. Other games keep the current seeding, so their
   decisions stay the same.
4. Tests: a mixed game (one model seat with a stubbed client, one heuristic seat) asks the model
   only for the model seat. Existing session tests pass unchanged. `bun run hill-climb` shows
   identical fingerprints, because no benchmark game has mixed seats.

### Phase 2: table-side AI limits

New module `table/ai-limits.ts`, used only when the table enables model seats.

1. **Per-decision deadline.** A table model seat gets its own `AiConfig` override with a hard
   wall-clock deadline per decision (default from Phase 0's p95). Retries happen only within that
   deadline, with `retryOnTimeout: false`. When the deadline passes, the existing heuristic
   fallback answers and the decision is recorded as `fallback`.
2. **Per-table spend cap** (`TABLE_AI_MAX_USD_PER_GAME`). It uses the billed cost each call
   already reports (ADR 0040) and counts across all model seats at the table. Once the cap is
   reached, every model seat switches to the heuristic bot for the rest of the game, with one
   public log line ("AI budget reached; bots continue on built-in play"). No exception and no halt.
3. **Server-wide daily cap** (`TABLE_AI_MAX_USD_PER_DAY`), stored in the table database so a
   restart does not reset it. The main thread checks it before starting a game with model seats.
   If the cap is already reached, the start is refused with a host-only message.
4. **No JEV, no reflection, no post-game call** at tables in v1. The config is built in code, not
   from whatever is in the environment.
5. Tests with a stubbed client cover each case: a slow client hits the deadline, a costly client
   hits the per-game cap mid-game, and a start is refused at the daily cap.

### Phase 3: wiring the table worker

1. Add `TABLE_AI_SEATS=1` to the table server's settings. The server reads it at startup and
   refuses to start if it is set without a usable provider key (`loadAiConfig` resolving a
   provider). Without it, everything works as today.
2. The worker boot message carries `aiSeats: boolean`. When it is on, the worker passes
   `ai: sessionAi` to the session. Before relying on this, check that a Bun `Worker` sees the
   parent's `process.env` (the provider key). If it does not, pass the provider settings in the
   boot message rather than re-reading the environment.
3. `in-process-port.ts` maps the new controller to `'ai'` in `seatControllers` and in the
   `gameStarted` payload's `controllers`.
4. Run `table/module-graph.test.ts` with the worker now reaching `ai/`. If it pulls in any
   runtime `benchmark/` or `batch/` module, add a thin table-only entry instead of `sessionAi`
   (for example `table/table-ai.ts` exporting the same object) rather than widening the
   allowlist.
5. Memory check on a 1 GB-style limit (`MemoryHigh=700M` in `mtg-table.service`): start a table
   with three model seats and record resident memory.

### Phase 4: protocol and lobby

1. `TableSeatController` gains `'model'` and `HostSeatController` gains `'model'`, with a
   `PROTOCOL_VERSION` bump. The parser accepts `'model'` only when the server advertises it.
2. The lobby payload advertises `modelSeats: boolean` (true only with `TABLE_AI_SEATS=1`). The
   host's seat control in `apps/web/src/table/TableLobby.vue` adds "AI bot (uses API budget)"
   next to "Built-in bot" only when the server advertises it. Other players see "AI bot" on the
   seat.
3. `TableStatusBar.vue`, the post-game results (`TableResultsDeck.controller`) and
   `game_decision_sources` label model seats distinctly from built-in bots.
4. Tests: the protocol parser accepts `'model'` only when enabled, a non-host socket cannot set it,
   and the lobby shows the option only when the server offers it.

### Phase 5: disclosure check, end-to-end and deploy

1. Disclosure tests on a table with a model seat. No `apiWaiting`, AI note, strategist plan or
   cost figure reaches any socket during play. `table/frame-scan.ts` and `exposure.ts` cover the
   new frames.
2. Post-game: the host's post-game view shows the table's total model spend. Showing each AI seat's
   reasoning after the game is a separate, optional change (open question 4).
3. `scripted-run.ts` plays a table with a model seat against a stubbed client. Then one real
   table game on `bun run dev --table` with the real provider.
4. Deploy notes: update `deploy/oracle-cloud/mtg-table.env.example`, replacing the current
   misleading "model-driven opponents" comment with `TABLE_AI_SEATS`, the key, and the two caps.
   Add a section to `docs/guides/deploy-oracle-cloud.md`. Turning it on, on the VPS, is your
   step.

## Accepted risks (stated in the ADR)

- **Latency side channel.** A model seat visibly thinks longer on some decisions than others, and
  that can hint at its hand. The deadline bounds this but does not remove it. Padding every model
  answer to a fixed time would remove it at the cost of slower games, so it is not done in v1.
- **The provider sees the bot's own view.** The model receives only that seat's redacted view,
  as in the tester. It never sees other hands or the RNG key.

## Open questions for you

1. **Provider and model on the VPS.** Anthropic preset (Haiku tactician, Sonnet strategist, the new
   default) or an OpenRouter chain?
2. **Cap values.** Dollars per table game and per day. Phase 0 gives real numbers, but a starting
   guess helps.
3. **Tactical mode.** `model` (the default; won the 2026-11-19 duel, more calls, slower) or `bot`
   (strategist steers the heuristic bot; far fewer calls and much less waiting for humans, but it
   missed the win bar)? For a table where people are waiting, I lean `bot` with escalation on.
4. **Post-game AI reasoning and reflection.** Leave off for v1, or show the AI seats' notes to
   everyone once the game ends?
