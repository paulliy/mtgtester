# 0011 — An OpenAI-compatible client with a model fallback chain, not `@google/genai`

Date: 2026-07-25
Status: Accepted (2026-07-25)
Diverges from: brief §7.2, which specifies the `@google/genai` SDK instantiated as
`new GoogleGenAI({})` reading `GEMINI_API_KEY`.

## Context

§7.2 names one SDK and one vendor. Building against it surfaced three problems, none of
which are visible from the brief:

1. **Free-tier Gemini RPM is the binding constraint on how far a game gets.** A four-player
   game is a long sequential chain of decisions ([ADR 0010](./0010-decision-call-budget.md)
   measured 1,326 across three games). At 15 RPM a game does not finish in a sitting. The
   brief anticipates the rate-limit problem (§7.5) but assumes a single vendor's ceiling is
   the one to pace against.
2. **Vendor lock at the call site.** `@google/genai` has a bespoke request/response shape.
   Swapping vendors later would mean rewriting the client, the retry logic, and the response
   parsing — not just a config value, which is what §7.2's own "configurable in one place"
   requirement is asking for in spirit.
3. **Model names churn faster than the code.** The Flash-tier lineup has turned over
   repeatedly. A single hardcoded model string is a build that breaks on a vendor's schedule.

## Decision

**Talk OpenAI's chat-completions wire format, and treat the vendor as configuration.**

Every major provider — Google (via `generativelanguage.googleapis.com/v1beta/openai/`),
Groq, DeepSeek, OpenAI — exposes an OpenAI-compatible endpoint. One client
(`ai/client.ts::OpenAiCompatibleClient`) therefore serves all of them, and switching vendors
is `AI_BASE_URL` + `AI_MODELS` + `AI_API_KEY` in `.env`, with no code change.

**`models` is an ordered fallback chain, not a string.** The client cascades to the next
model on:

- model unavailability (404 / `model_not_found`) — covers a name that was retired or never
  existed on this vendor,
- daily quota exhaustion (RPD) for that model,
- RPM ceiling for that model.

When every model in the chain is RPM-blocked it waits for the bucket to refill rather than
failing the game. When every model is out of _daily_ quota it throws
`DailyQuotaExhaustedError`, which is the §7.5 requirement to distinguish
recoverable-in-seconds from not-recoverable-today and say so plainly.

This subsumes §7.2's "do not default to a Pro model": the default chain is Flash-Lite tier
first, then Flash, and never Pro.

## What this preserves from §7.2

- **Configurable in one place** — `ai/config.ts`, more so than before: endpoint, key, model
  chain, RPM, retries, and backoff are all there.
- **No hardcoded rate-limit numbers** — `rpmLimit` defaults conservatively (30) and is
  env-overridable, with the vendor's console as the source of truth for current values.
- **Flash-tier default**, never Pro.

## Consequences

- The `.env.example` ships four documented provider blocks. Groq is the uncommented default
  because its free tier is the one that actually completes a game; Gemini is one uncomment
  away, which is what the brief asked for functionally.
- **Free-tier data usage (§7.2's README note) now has more than one answer** — each vendor
  has its own training-data policy, so the note has to name the vendor rather than state a
  single fact. This is a genuine cost of the divergence.
- **`GET /models` is not an availability check.** It lists `gemini-2.5-flash-lite`, but a
  chat completion against that model returns `404 NOT_FOUND: "no longer available to new
users."` The listing reflects the model catalogue, not what this key may call. Only an
  actual completion answers the question — which is exactly what the cascade does, at a cost
  of one wasted call per dead entry. The chain is effectively two models, not three, and
  should be pruned.
- **The free-tier ceiling is per-day, and it is smaller than one game.**
  `GenerateRequestsPerDayPerProjectPerModel-FreeTier` is **500 requests/day/model**, while
  [ADR 0010](./0010-decision-call-budget.md) measures ~440 decisions per game with ~16%
  answered locally — roughly 370 calls. So Gemini's free tier funds about one game per day
  per model, with no margin for a retry or a second run. Note the 429 body also carries a
  `RetryInfo: 42s` hint that is actively misleading here: the window is a day, not a minute.
  **This is the strongest argument for the divergence in this ADR** — a single-vendor build
  would simply stop after one game, and Groq is the default in `.env.example` for this reason.
- Structured output is requested via the OpenAI `response_format` JSON mode rather than
  `@google/genai`'s schema binding; `ai/validate.ts` re-validates every response against the
  legal-action menu regardless, so schema support is an optimization and not the guarantee.
- If the project later wants Gemini-specific features the OpenAI shim does not expose —
  **context caching for the static primer block (§7.4) is the concrete one** — that is the
  point to revisit this. The primer is currently re-sent as a system message on every call.
