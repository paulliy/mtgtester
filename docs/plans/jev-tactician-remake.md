# Jev tactician remake

Status: implementation complete; production rollout disabled pending measured promotion evidence.

## Review outcome

The implementation review tightened four parts of the original design:

- The Jev action limit is configurable but cannot exceed the model's 255-choice ceiling.
- Shadow mode uses an independent queue and can never replace the chat tactician's answer.
- Match halt and abandonment cancel queued or in-flight Jev requests.
- Historical chat benchmarks explicitly select the frozen legacy primer; current runs identify the
  decision-shaped primer separately in their manifests.

The code for work packages 1-5 and the evaluation harness in work package 6 is complete. Jev remains
`unmeasured`, disabled by default, and ineligible for automatic routing. Confidence calibration,
held-out quality evidence, and promotion are evidence-producing operations rather than missing
implementation; they must not be manufactured from unit tests or a smoke call.

## Objective

Use TypeSafe Jev as the economical tactician for bounded `actionId` selection while preserving the
engine as the sole authority for legal actions. Keep the existing generative tactician for decision
shapes Jev cannot faithfully complete and preserve human or seeded-heuristic recovery after remote
policies fail.

Jev is a typed decision model, not a chat model. The server will map each engine-generated legal
action to a Jev Choice option, translate the selected option back to its numeric `actionId`, fill
only mechanically forced response fields, and validate the resulting `DecisionResponse` before
submission. Jev will never invent an action, target, mode, value, order, or distribution.

## Non-goals

- Do not use Jev for strategist turn-plan generation.
- Do not send hidden state, gold labels, evaluator features, UI-only presentation, or opponent deck
  profiles.
- Do not infer ambiguous targets or coupled assignments from an `actionId`.
- Do not enable a production default from smoke-test evidence.
- Do not use an always-latest model alias for reproducible evaluation.

## Target decision flow

```text
engine request
  -> scoped plan
  -> deterministic heuristic
  -> exact decision cache
  -> decision-shape classifier
       -> Jev-supported: Jev Choice(actionId)
            -> known choice + calibrated confidence + valid response: engine submission
            -> otherwise: configured generative tactician
       -> unsupported/complex: configured generative tactician
  -> one generative corrective retry
  -> watched-game human escalation
  -> seeded heuristic fallback
```

The original request is retained across the chain. A rejected or low-confidence Jev result is
advisory only; the generative fallback receives the complete original decision and is not forced to
repeat Jev's selection.

## V1 support contract

The classifier uses the response shape, not only `decisionType`.

| Shape                                                           | Jev V1 behavior                 |
| --------------------------------------------------------------- | ------------------------------- |
| Action with no supplemental fields                              | Supported                       |
| Action with target slots that each have one legal option        | Supported; fill targets locally |
| Any possible action with an ambiguous target slot               | Bypass Jev                      |
| Attack or block assignment                                      | Bypass Jev                      |
| Mana or combat-damage distribution                              | Bypass Jev                      |
| Trigger ordering, mode choice, X choice, or mulligan bottoming  | Bypass Jev                      |
| Unknown decision type, malformed menu, or more than 255 actions | Bypass Jev                      |

V1 only routes a request to Jev when every possible selected action can be converted into a
complete response without a second judgment. Later versions may evaluate action-specific target
questions, but independent Choice answers must never be treated as proof that a coupled assignment
is legal.

## Work packages

### 1. Decision contract and compact request builder

- Add a fail-closed tactical decision-shape classifier.
- Add stable option keys and an exact local option-to-`actionId` map.
- Reuse the permitted `PlayerView` serializer but omit the chat primer and duplicated legal menu.
- Express legal actions as structured Jev Choice criteria.
- Parse probabilities and confidence at a runtime boundary.
- Construct `DecisionResponse` locally and fill only forced targets.

Acceptance:

- Unknown choices and malformed probability data fail closed.
- Non-contiguous action IDs round-trip exactly.
- No ambiguous target request is classified as supported.
- Ordinary Jev state contains no monolithic tactician primer.

### 2. Transport boundary

- Add a dedicated Jev Decisions client; do not force decision responses through the chat parser.
- Use OpenRouter's typed Decisions API behind a narrow injectable interface.
- Pin `typesafe/jev-1.13` in benchmark and candidate configuration.
- Preserve provider request identity, resolved model, timings, usage, raw structured response, and
  errors without inventing unavailable fields.
- Start with zero application-level semantic retries. OpenRouter provider recovery remains
  separate from policy fallback.

Acceptance:

- Contract tests cover accepted, rejected, timed-out, malformed, and unavailable responses.
- Credentials never appear in manifests or logs.
- Benchmark mode retains every physical attempt.

### 3. Tiered tactician orchestration

- Introduce a `TacticalPolicy` boundary with Jev and chat implementations.
- Keep plan, heuristic, and cache short-circuits ahead of all network policies.
- Route V1-supported ordinary decisions to Jev.
- Route complex and critical decisions directly to the configured chat tactician.
- On Jev failure or low confidence, invoke chat once, then its existing corrective retry.
- Preserve watched-game human escalation and final seeded-heuristic fallback.
- Cache only the final validated response.

Acceptance:

- Tests assert exact policy call order and request counts.
- Jev failure never skips the generative fallback.
- A rejected Jev answer is never cached or submitted.
- Every remotely selected response passes `validateResponse` and engine submission.

### 4. Prompt reduction for the generative fallback

- Split `TACTICIAN_PRIMER` into a small common primer and decision-specific fragments.
- Include attack, block, targeting, ordering, or distribution instructions only when required.
- Keep the existing frozen benchmark path for comparisons.

Acceptance:

- An ordinary priority prompt is materially smaller than the strategist prompt on comparable
  states.
- Combat decision tests retain all required serialization instructions.
- Prompt snapshots prove unrelated fragments are absent.

### 5. Configuration, registry, and telemetry

- Add independent, default-off Jev configuration for model, timeout, shadow mode, maximum actions,
  and calibrated confidence policy.
- Add `jev-action-selector-1.13-v1` to the policy registry as `unmeasured`.
- Replace the provider's hard-coded shadow registry with injected/versioned registry data.
- Record confidence, probability distribution, top-two margin, classifier result, route reason,
  fallback reason, validation result, engine acceptance, latency, and known cost.
- Distinguish chat attempts from typed-decision attempts in benchmark artifacts.

Acceptance:

- Disabled configuration preserves current production behavior exactly.
- Missing usage remains unknown.
- Router and fallback attribution are reconstructable from retained artifacts.

### 6. Evaluation and promotion

- Expand tactical development and held-out suites across ordinary actions, lethal prevention,
  stack interaction, optional triggers, ambiguous targets, combat, ordering, distributions, and
  unsupported shapes.
- Compare raw Jev, raw chat baseline, and the full production pipeline separately.
- Calibrate confidence and top-two-margin thresholds on development cases only.
- Verify thresholds and routing on held-out cases and engine-backed scenarios.
- Run controlled complete-game evidence only after snapshot and engine-acceptance gates pass.

Promotion requires zero new confirmed critical blunders, zero privacy leaks, zero submitted illegal
actions, complete cost accounting, failure rate at most 5%, quality within the preregistered
two-point allowance, and latency/cost evidence sufficient to justify the route. The registry stays
`unmeasured` and all production flags remain off until those gates pass.

## Request budget

The preceding live campaign used four physical provider requests. No additional request was made
during implementation: the proposed one-request Jev smoke was blocked before execution because
the benchmark game-state payload requires explicit external-egress approval for OpenRouter/TypeSafe.
Meaningful calibration and promotion testing still require a separately approved request budget;
deterministic and mocked work does not consume that allowance.

## Implemented artifacts

- Fail-closed decision-shape classifier and compact typed request builder.
- Dedicated OpenRouter Decisions transport pinned to `typesafe/jev-1.13`.
- Active and shadow policy bindings with calibrated gates, cancellation, and exact chat fallback.
- Default-off session and CLI configuration with secrets kept outside manifests.
- Decision-shaped generative primer with an explicit frozen legacy benchmark path.
- Versioned `unmeasured` registry entry and injectable provider registry.
- Physical-attempt logging plus policy traces for classification, confidence, probability margin,
  validation, fallback reason, and engine acceptance.
- Raw Jev and production-pipeline benchmark modes with separate `jev-traces.jsonl` artifacts.

## Implementation order

1. Decision classifier, Jev request/response contracts, and unit tests.
2. Dedicated transport with mocked contract tests.
3. Tiered provider integration and exact fallback-order tests.
4. Conditional generative primer fragments and prompt-size tests.
5. Shadow telemetry and benchmark support.
6. Bounded live smoke, confidence calibration, held-out evidence, and promotion review.
