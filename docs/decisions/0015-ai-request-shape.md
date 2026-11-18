# 0015 — The AI request shape, and failures that are worth another sample

Date: 2026-07-27
Status: Accepted (2026-07-27)

Extends [0011](0011-openai-compatible-provider.md).

## Context

Every AI call in every game failed:

```
HTTP 400 {"error":{"message":"Only one of \"reasoning.effort\" and
\"reasoning.max_tokens\" can be specified","code":400}}
```

The body sent both spellings of the same control:

```ts
reasoning_effort: 'none',
reasoning: { enabled: false, max_tokens: 0, exclude: true },
```

OpenRouter folds a top-level `reasoning_effort` into `reasoning.effort`, so the request
contradicted itself before any model saw it. `max_tokens: 0` is independently out of range,
and `'none'` is not a value the OpenAI-compatible enum has. Nothing about this was specific to
`deepseek/deepseek-v4-flash`; it rejected every model on every provider, and the whole game
played itself out on §7.7-step-3 fallbacks — a "game" that never consulted the model at all.

That the failure was silent is the more interesting half. The provider catches everything and
falls back per decision, which is right when one call fails and wrong when the request itself
can never succeed. Chasing it surfaced four more defects in the same path, all of which turn a
recoverable moment into a lost decision.

## Decision

### 1. One spelling of reasoning per vendor, chosen by endpoint

`reasoningParams()` owns the whole question. OpenRouter gets the unified `reasoning` object and
never a top-level `reasoning_effort`; every other OpenAI-compatible vendor gets
`reasoning_effort` and never the object, which they would reject as an unknown field. `effort`
and `max_tokens` are mutually exclusive, so only ever one of them is on the wire, and "off" is
`{ enabled: false }` — not a zero budget. Off OpenRouter there is no portable way to say "off",
so the key is omitted entirely.

The config keeps `'max'` as an effort level because it reads naturally in `.env`; the wire
enum stops at `high`, so `WIRE_EFFORT` maps it down rather than sending a 400.

### 2. `max_tokens` is an answer budget, and reasoning needs its own headroom

The same commit added a flat `max_tokens: 1000`. That cap covers thinking tokens and answer
tokens together, so a thinking model can spend the entire budget mid-thought and return empty
`content` — a second way to lose every decision, this time without an HTTP error to explain it.
The budget is now `maxOutputTokens` (`AI_MAX_OUTPUT_TOKENS`, default 1000), with
`REASONING_TOKEN_HEADROOM` added on top when reasoning is enabled. When a model does run out
mid-thought anyway, the client reads `message.reasoning` before giving up — the decision JSON
is usually in there — and names the `finish_reason` in the error when it is not.

### 3. An unreadable answer is a sample, not a verdict

`AiResponseValidationError` — truncated JSON, prose instead of an object, an empty completion —
was classified `fatal`, which spent the entire decision on one unlucky generation: no network
retry, and not even the §7.7 step-1 corrective retry, because that only ran for a response that
parsed. It is now `retryable_generation`, and it reaches the corrective retry from both
directions, since "chose an illegal action" and "wrote something I cannot read" are the same
mistake from the model's side.

Generation failures get a cap of their own (`GENERATION_RETRY_CAP = 2`) rather than the
transport budget of 6. A model that cannot produce readable JSON twice will not produce it on
the sixth try either, every attempt is a full-price call, and showing the model its own bad
output is the better next move. Groq's `json_validate_failed` moves to this category too — same
failure, observed from the provider's side.

Transport failures were mirror-image wrong: a timeout from `AbortSignal.timeout` or a dropped
socket carries no HTTP status, fell through to the `fatal` default, and retired the decision on
the first attempt. They are retryable, and `errorFacts` now reads `name`, `code`, and `cause`,
where those errors keep the only identity they have.

### 4. The prompt-caching filter had never run

`getNonCachingProviders` built its URL with `encodeURIComponent(model)`, turning
`deepseek/deepseek-v4-flash` into a single `%2F`-bearing path segment. The route is
`/models/:author/:slug/endpoints` — two segments — so the lookup 404'd for every slash-bearing
model, which on OpenRouter is all of them. It degraded gracefully, returned `[]`, and the
filter silently never applied; it also re-paid for the doomed round-trip on every decision,
because only successful lookups were cached. Both are fixed, so **`provider: { ignore: [...] }`
now genuinely reaches OpenRouter for the first time** and requests will start landing on
caching providers. The existing guard still holds: nothing is excluded unless at least one
provider that does cache remains.

### 5. Brace-counting instead of a greedy regex

`/\{[\s\S]*\}/` spanned from the first brace anywhere in the reply to the last brace anywhere
in it, so one sentence like "I considered {A} and {B}" ahead of a perfectly good fenced object
made the whole response unparseable. Extraction now tries fenced blocks first, then every
balanced `{...}` slice in reading order, string- and escape-aware, preferring an object that
actually names an action over an earlier one that merely parses.

## Consequences

- The four `challenger-empirical` tests that pinned the old behaviour as "empirically verified
  bugs" now assert the fixed behaviour. Two of them (4.3, 4.4) were documenting exactly these
  defects.
- A per-decision failure still falls back silently, by design (§7.7 step 3). A _systemic_
  failure — bad credentials, a malformed request, a model that does not exist — is still only
  visible as a fallback warning on every decision. Making the provider distinguish "this call
  failed" from "no call can succeed" is left open; the fastest signal remains that a game with
  a broken config finishes with zero `primary` rows in `ai_calls`.
- Retrying generation failures costs up to 2 extra calls on a decision the model fumbles, which
  is a real budget change against ADR 0010. The corrective retry it feeds is the cheaper half
  of the trade: it recovers decisions that previously became fallbacks outright.
