# ADR 0040: Stream model calls and account for every billed attempt

Status: Accepted (2026-11-10)

Date: 2026-11-10

## Context

The paid mode duel in ADR 0039 reported about $0.065 for the game. OpenRouter billed about $0.13.

Every model call was a plain, non-streamed request that the client aborted at its deadline:
10 s for the tactician and 45 s for the strategist, which ran medium-effort reasoning. OpenRouter
documents that a non-streamed request keeps running after the client disconnects and is billed in
full. A timed-out attempt reached the attempt log with no token or cost fields, so cost tallies
added nothing for it and still reported a complete total. Timeouts were retryable, so one decision
could be billed up to three times.

Per call, the strategist was about 11 times the cost of a tactician call, and most of a strategist
call is reasoning output.

## Decision

1. **Stream OpenRouter calls** (`AI_STREAM_RESPONSES`, default on). The client sends
   `stream: true` with `stream_options.include_usage` and reads the SSE stream back into the same
   body shape as before (`ai/streaming.ts`). An aborted stream stops generation and billing at
   supported providers. Other vendors and test doubles keep the plain JSON path.
2. **Keep the generation id of every attempt.** The first chunk carries it, so an attempt that
   times out mid-stream still records its id and an estimate of the tokens it produced.
3. **Look up what was billed.** Attempts that end without a reported cost are kept on the client.
   `OpenAiCompatibleClient.settleUnknownCosts()` asks OpenRouter's `GET /generation?id=` what each
   one cost. `pool --ai` prints the unreported calls and the billed total at game end.
4. **Do not retry our own timeout** (`AI_RETRY_ON_TIMEOUT`, default off). A `RequestTimeoutError`
   is fatal for the call, and the decision falls back to the bot, which is free and, after ADR 0039,
   plays well. Socket errors and 5xx responses are still retried.
5. **Strategist on `z-ai/glm-5.3-flash` at low effort**, with `deepseek/deepseek-v4-flash` as
   the fallback (Paul's choice). Low effort cuts the reasoning tokens that dominate each call and
   shortens calls, so fewer of them reach the deadline.

## Consequences

- Cost reports can now be checked against the bill. An attempt without a reported cost is no
  longer silently free.
- A slow strategist call now produces no plan for that turn instead of a retry. With bot-led seats,
  the seat keeps its previous knobs.
- `ai-mode-duel` (PR #61) charges attempts through the attempt observer. To report billed totals it
  should also call `settleUnknownCosts()` at game end.
- The strategist quality change from medium to low effort, and the model change, have not been
  measured. The next paid duel should compare win rate and billed cost against ADR 0039's game.
