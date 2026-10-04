# AI live smoke audit — 2026-09-21

## Scope and safeguards

- User approved sending repository-derived benchmark game-state prompts to OpenRouter.
- Model: `deepseek/deepseek-v4-flash` for strategist and tactician roles.
- Reasoning disabled; one model in each fallback chain; one retry allowed per logical request.
- Raw mode excluded heuristic answers and corrective follow-up requests.
- Campaign ceiling: fewer than 10 physical provider requests and a $0.01 known-spend cap per run.
- Actual total: 4 accepted physical requests, no retries, and $0.0004208702 provider-reported cost.

These were live model decisions over frozen game states, not complete multiplayer games. The small
smoke run is useful for integration, schema, cost, and cache evidence but is not promotion evidence.

## Results

| Sample                     | Trials | Requests |             Acceptable |    Known cost | p95 latency |
| -------------------------- | -----: | -------: | ---------------------: | ------------: | ----------: |
| Strategist                 |      1 |        1 |                    1/1 |  $0.000121426 |   15,581 ms |
| Tactician, original label  |      2 |        2 | initially reported 0/2 | $0.0002580542 |    2,987 ms |
| Tactician, corrected label |      1 |        1 |                    1/1 |   $0.00004139 |    3,101 ms |

All four responses were accepted by the provider. Every result was valid JSON and matched the
response schema. All tactician responses passed menu validation. The strategist identified P2 as
the top threat and explicitly held mana for interaction. Every tactician response selected Swords
to Plowshares and targeted the visible lethal commander.

## Audit finding and correction

The original tactician fixture offered action 1 without its required target slot and labeled only
`actionId: 1`. The semantic scorer correctly distinguishes target assignments, so the model's
otherwise correct `{ actionId: 1, targets: [{ slot: 0, choice: "threat" }] }` response could not
exactly match the incomplete gold pattern and was incorrectly recorded as a critical failure.

The fixture now includes target slot 0 with `threat` as its legal option, the gold pattern includes
that exact target, the immutable content hash is resealed, and a regression test proves that the
fully specified removal decision scores as acceptable. The corrected live rerun passed.

## Cache evidence

The two repeated original-label tactician requests had the same stable-prefix hash. The provider
reported one cache-read request with 1,530 cache-read tokens out of 4,024 aggregate prompt tokens,
an observed aggregate read-token rate of 38.02%. The first request's cold-cache status remains
unverified. Complete-response caching was disabled, so the quality samples were independent.

The observed first and repeated latencies were 2,847 ms and 2,735 ms. Two observations are not
enough to claim a latency improvement.

## Retained evidence and limitations

Raw local evidence is under `benchmark-output/live-under-10-20260921/` and is intentionally
gitignored. The committed live configuration is `benchmarks/variants/cheap-live-v1.json`; it is a
measurement-only variant and does not change production defaults.

This run covered one development case per role. It did not exercise a complete game, hidden test
cases, production recovery, or engine submission (`engineAcceptance` remained `not_checked`). No
policy, router, cache-layout, or model default should be promoted from this evidence alone.
