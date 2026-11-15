# ADR 0028: Counterfactuals, routing, cache evidence, and promotion

Date: 2026-09-21

Status: accepted for measurement; no production default promotion

## Decision

Counterfactual evaluation reconstructs two fresh engines at the same pending decision, applies one
complete response to each, and lets deterministic policies react to their own `PlayerView` until a
semantic horizon. Its first scalar is baseline-relative rollout disadvantage, not optimal-play
regret. Reports retain per-opponent resources, terminal outcomes, truncation, evaluator limitations,
and random-event divergence.

Routing begins as an interpretable shadow policy. Only registry entries with measured eligible
status can answer actively; configured model aliases start unmeasured. Unknown mechanics, missing
critical features, and absent eligible candidates recover to the fixed baseline. Jev remains an
optional adapter and is not enabled without a pinned implementation and complete-response coverage.

Prompt-cache layout and observed cache accounting are separate from complete-response caching.
Request identifiers stay outside the stable prefix. A cache hit is recorded only from provider
usage fields, and a fresh local process never proves a cold provider cache.

Promotion uses the committed release policy and returns pass, fail, or inconclusive. Privacy leaks
and engine-accepted illegal actions are hard failures. Unknown active-turn cost, incomplete cost
coverage, non-comparable latency, or a merely proposed policy prevent an unqualified pass.

Controlled leagues rotate candidate seats and deck assignments, freeze opponent policy factories,
and treat same seeds as branch reproducibility rather than trajectory identity. All-candidate tables
are reported separately.

## Consequences

- Production model defaults remain unchanged until live, held-out evidence passes a validated
  release policy.
- Counterfactual values are useful diagnostic signals with explicit evaluator limitations.
- Router and cache experiments can be audited without inferring savings from configuration alone.
- Manual live workflows use protected credentials; pull-request checks remain deterministic and
  secret-free. Repository CI cannot prove that branch protection requires a particular check.

## Update 2026-11-15: stable-prefix layout on by default

`providerPromptCacheLayoutEnabled` now defaults to true (hill-climb suggestion S5), with layout
`stable-prefix-v2`: the strategist's `strategyTask` and `yourStrategyProfile` move, unchanged, into
the stable prefix after the commander definitions, and a definition no longer repeats the
commander's name. v1 deleted `yourStrategyProfile` from the observation and restored it only for a
versioned profile, so a seat with just the legacy archetype tag lost it; v2 moves keys instead of
deleting them, and a test checks that both layouts send the same values.

The evidence is the offline hill-climb census, not provider usage: on the standard profile the
cacheable share of bot-mode prompt text rose from 9.9% to 21.9% and uncached prompt tokens per turn
fell 12.3% (model mode 10.0%), while total prompt tokens rose 1.1 to 1.2% from the extra prefix
message. The census models an ideal prefix cache, so the decision above still holds: a saving is
claimed only from the provider's reported cache reads, which `ai-mode-duel` now sums per mode.
`AI_PROVIDER_PROMPT_CACHE_LAYOUT_ENABLED=false` restores the plain layout.
