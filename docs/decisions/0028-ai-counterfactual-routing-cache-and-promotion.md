# ADR 0028: Counterfactuals, routing, cache evidence, and promotion

Date: 2026-09-21

Status: Accepted (2026-09-21)
Status note: for measurement; no production default promotion

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

## Update 2026-11-15: stable-prefix layout v2, measured offline, still off by default

Layout `stable-prefix-v2` (hill-climb suggestion S5) moves the strategist's `strategyTask` and
`yourStrategyProfile` into the stable prefix after the commander definitions, unchanged, and a
definition no longer repeats the commander's name. v1 deleted `yourStrategyProfile` from the
observation and restored it only for a versioned profile, so a seat with only the legacy archetype
tag lost it. v2 moves keys and never deletes them, and a test checks that both layouts send the
same values. The bug never reached production because the flag was off.

`providerPromptCacheLayoutEnabled` stays false. The hill-climb census measures the layout as its own
mode, `botCached`. Against plain bot mode, it raises the cacheable share of prompt text from 9.9% to
21.9% and cuts uncached prompt tokens per turn by 12.3%, but it sends 1.2% more prompt tokens. The
stable prefix is about 3,000 characters, roughly 750 tokens, and `longPrefixCacheableSharePct`
reads 0% for it: below the 1,024-token minimum several provider caches need, it may earn nothing.
The decision above stands. The default flips only after a paid run (`ai-mode-duel` now sums provider
cache reads per mode) shows cache reads worth more than the added tokens.
