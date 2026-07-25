# Adversarial Stress Testing & Empirical Validation Report

## Executive Summary

As Challenger 1, adversarial stress testing was conducted across the AI decision pipeline, `TurnPlanManager`, `validateResponse`, non-empty stack resolution scenarios, and JSON error recovery (`parseJsonResponse` / `classifyError`).

An empirical test suite (`packages/server/src/ai/challenger-empirical.test.ts`) comprising 12 test cases was constructed and executed. All 12 test cases passed, empirically validating four major architectural defects in the AI decision pipeline.

---

## Challenge Summary

**Overall risk assessment**: **CRITICAL**

| Component | Risk Level | Primary Failure Mode |
|---|---|---|
| `TurnPlanManager` Isolation | **CRITICAL** | Per-seat provider encapsulation renders opponent intervention invalidation dead code in production. Players execute stale pre-planned actions after opponent interventions. |
| `TurnPlanManager` Phase Tracking | **HIGH** | Queue does not track phase/step. Planned actions persist and execute across phase boundaries (e.g. main phase plan executing in combat). |
| `validateResponse` (`plannedActions`) | **CRITICAL** | Pre-planned actions bypass validation at creation time. Numeric card names bypass filtering; non-string types/targets trigger uncaught `TypeError` runtime crashes during plan execution. |
| Non-Empty Stack Resolution | **MEDIUM** | `tryDeferInstant` heuristic is completely disabled when `view.stack.length > 0`. Decision request volume inflates up to 24 requests per 3-spell chain, with cache invalidation at each resolution step. |
| `parseJsonResponse` / `classifyError` | **CRITICAL** | `AiResponseValidationError` (truncated JSON, broken formatting, preamble with extra `{}`) is misclassified as `'fatal'`, bypassing network retries and Step 2 (Corrective Retry), jumping straight to `safestFallback`. |

---

## Detailed Findings & Empirical Proofs

### 1. `TurnPlanManager` Stale Queue & Multi-Provider Isolation

#### Finding 1.1: Per-Seat Provider Encapsulation Defect
- **Location**: `packages/server/src/ai/provider.ts:52`, `packages/server/src/ai/turn-plan.ts:84-104`
- **Mechanism**: `TurnPlanManager.recordDecision` checks `if (request.decidingPlayer !== request.activePlayer)` to set `this.opponentIntervened = true`. However, in production, `OpenAiDecisionProvider` is instantiated per player seat (`P1` and `P2` have distinct provider instances).
- **Impact**: `P1`'s `TurnPlanManager` is isolated inside `providerP1` and never receives `recordDecision` calls when `P2` acts. When `P2` casts a spell or activates an ability during `P1`'s turn, `providerP1.turnPlan` retains `opponentIntervened === false`. Priority returning to `P1` executes the pre-planned action from `P1`'s local queue with **0 model calls**, blindly passing priority or executing stale actions after opponent intervention.
- **Unit Test Masking**: In `turn-plan.test.ts:69-88`, the test manually fed `P2`'s request into a single shared `TurnPlanManager` instance, masking the production per-seat encapsulation flaw.
- **Empirical Proof**: Verified by `Task 1.1` in `challenger-empirical.test.ts`.

#### Finding 1.2: Phase and Step Blindness
- **Location**: `packages/server/src/ai/turn-plan.ts:76-81`, `28-29`
- **Mechanism**: `TurnPlanManager` only clears its queue when `turnNumber` or `activePlayer` changes. It does NOT track `phase` or `step`.
- **Impact**: Pre-planned actions created during `precombatMain` (e.g. `[{ type: 'pass' }]`) persist into `combat` -> `declareAttackers` on the same turn.
- **Empirical Proof**: Verified by `Task 1.2` in `challenger-empirical.test.ts`.

---

### 2. Unvalidated `plannedActions` in `validateResponse`

#### Finding 2.1: Creation-Time Validation Bypass
- **Location**: `packages/server/src/ai/validate.ts:13-43`
- **Mechanism**: `validateResponse(response, request)` validates `response.requestId`, `response.actionId`, and `response.targets` for the immediate action. It completely ignores `response.plannedActions`.
- **Impact**: Malformed or illegal `plannedActions` returned by an LLM pass `validateResponse` with `null` (valid!). Step 2 (Corrective Retry with prompt feedback) is NEVER triggered at creation time.
- **Empirical Proof**: Verified by `Task 2.1` in `challenger-empirical.test.ts`.

#### Finding 2.2: Numeric Name Filter Bypass in `findMatchingAction`
- **Location**: `packages/server/src/ai/turn-plan.ts:155`
- **Mechanism**: `if (planned.name !== undefined && planned.name.length > 0)`. When an LLM returns a numeric card name (e.g. `{ type: 'castSpell', name: 12345 }`), `(12345).length` evaluates to `undefined`. Since `undefined > 0` is `false`, the name matching check is bypassed entirely.
- **Impact**: `findMatchingAction` matches the FIRST action of type `castSpell` on the legal menu (e.g. `Counterspell`), executing an unintended spell.
- **Empirical Proof**: Verified by `Task 2.2` in `challenger-empirical.test.ts`.

#### Finding 2.3: Runtime `TypeError` Crashes During Plan Execution
- **Location**: `packages/server/src/ai/turn-plan.ts:156, 137`
- **Mechanism**: If `planned.name` is a non-string object/array with `.length > 0` (e.g. `['a', 'b']`), `planned.name.toLowerCase()` is invoked, throwing an uncaught `TypeError: planned.name.toLowerCase is not a function`. Similarly, if `planned.targets` is a string or non-array, `planned.targets.find(...)` in `isTargetValid` throws an uncaught `TypeError`.
- **Impact**: Uncaught runtime crashes during game loop execution.
- **Empirical Proof**: Verified by `Task 2.3` & `Task 2.4` in `challenger-empirical.test.ts`.

---

### 3. Non-Empty Stack Resolution Stress & Cache Behavior

#### Finding 3.1: Pre-Flight Heuristics Disabled for Stack > 0
- **Location**: `packages/server/src/ai/heuristics.ts:71`
- **Mechanism**: `tryDeferInstant` explicitly checks `if (view.stack.length > 0) return null;`.
- **Impact**: When any spell/ability is on the stack, the pre-flight instant deferral heuristic is completely disabled. Every non-active player holding an instant spell receives a decision request for every priority pass.
- **Empirical Proof**: Verified by `Task 3.1` in `challenger-empirical.test.ts`.

#### Finding 3.2: Decision Request Volume & Cache Invalidation
- **Location**: `packages/server/src/ai/decision-cache.ts:94-100`
- **Mechanism**: `digestDecision` hashes `view.stack` (length, item id, controller, description, targets), `view.hand`, `view.graveyard`, and `view.availableMana`.
- **Impact**: In a 4-player game with a 3-spell response chain, up to 24 priority decision requests are generated across the table. Each addition to or resolution from the stack changes `view.stack`, `view.hand`, `view.graveyard`, or `view.availableMana`, producing 100% cache misses across stack transitions.
- **Empirical Proof**: Verified by `Task 3.2` in `challenger-empirical.test.ts`.

---

### 4. `parseJsonResponse` and `classifyError` Failure Modes

#### Finding 4.1: `AiResponseValidationError` Classified as `'fatal'`
- **Location**: `packages/server/src/ai/retry.ts:69-111`, `packages/server/src/ai/client.ts:150`
- **Mechanism**: When raw model output contains truncated JSON or invalid JSON syntax, `parseJsonResponse` throws `AiResponseValidationError`. `classifyError(err)` does not contain a handler for `AiResponseValidationError`. Status is `undefined` and text does not match `json_validate_failed`. `classifyError` falls through to line 110: `return 'fatal';`.
- **Impact**: `withRetry` in `client.ts` sees `category === 'fatal'` and DOES NOT RETRY the network request (even when `maxRetries > 0`). Furthermore, in `OpenAiDecisionProvider.decide`, `decideViaModel` aborts. Step 2 (Corrective Retry with prompt feedback) is NEVER executed. The provider immediately jumps to `safestFallback`.
- **Empirical Proof**: Verified by `Task 4.3` in `challenger-empirical.test.ts`.

#### Finding 4.2: HTTP 502/504 Proxy Error Step 2 Bypass
- **Location**: `packages/server/src/ai/retry.ts:106`, `packages/server/src/ai/provider.ts:80-105`
- **Mechanism**: `HttpError(502)` and `HttpError(504)` are classified as `'retryable'` in `classifyError`. When network retries are exhausted, `client.requestDecision` re-throws `HttpError`.
- **Impact**: In `provider.decide`, `HttpError` escapes `decideViaModel`. Step 2 (Corrective Retry) is bypassed (as no response object was parsed), jumping directly to `safestFallback`.
- **Empirical Proof**: Verified by `Task 4.1` & `Task 4.2` in `challenger-empirical.test.ts`.

#### Finding 4.3: Greedy Regex Failure on Markdown Preambles
- **Location**: `packages/server/src/ai/client.ts:195-197`
- **Mechanism**: `parseJsonResponse` uses `raw.match(/\{[\s\S]*\}/)`.
- **Impact**: If a model preamble contains braces before the JSON block (e.g. `I considered choices {option A} and {option B}.\n\`\`\`json\n{"requestId":"req-1"}\n\`\`\``), the greedy regex matches from the first `{` to the final `}`. `JSON.parse` fails with `SyntaxError`, throwing `AiResponseValidationError`, which is classified as `'fatal'`, bypassing retries and Step 2 Corrective Retry.
- **Empirical Proof**: Verified by `Task 4.4` in `challenger-empirical.test.ts`.

---

## Stress Test Results Summary Table

| Test ID | Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|---|
| **1.1** | Opponent P2 casts spell during P1 turn (multi-provider) | P1's plan invalidated; consults model | P1 executes pre-planned `pass` locally (0 network calls) | **FAIL** (Bug Confirmed) |
| **1.2** | Phase transitions Main 1 -> Combat declareAttackers | P1's Main 1 plan invalidated on phase change | Main 1 plan executes inside Combat phase | **FAIL** (Bug Confirmed) |
| **2.1** | Model returns response with malformed `plannedActions` | `validateResponse` returns error string | `validateResponse` returns `null` (bypasses validation) | **FAIL** (Bug Confirmed) |
| **2.2** | `plannedActions` has numeric card `name: 12345` | Validation error or rejected plan | `(12345).length` is undefined; matches arbitrary spell | **FAIL** (Bug Confirmed) |
| **2.3** | `plannedActions` has array `name: ['a', 'b']` | Validation error or clean clear | `name.toLowerCase()` throws uncaught `TypeError` | **FAIL** (Bug Confirmed) |
| **2.4** | `plannedActions` has non-array `targets: 'str'` | Validation error or clean clear | `targets.find` throws uncaught `TypeError` | **FAIL** (Bug Confirmed) |
| **3.1** | Priority pass with `view.stack.length > 0` | Heuristic checks stack deferral | `tryDeferInstant` returns `null`, forcing AI call | **PASS** (As Designed) |
| **3.2** | 3-spell stack resolution sequence | Cache invalidation on stack changes | 3 distinct digest hashes generated; 100% cache miss | **PASS** (As Designed) |
| **4.1** | Proxy HTTP 502/504 response | `classifyError` marks retryable | Classified as `retryable` | **PASS** (As Designed) |
| **4.2** | Persistent HTTP 504 proxy error | Handled gracefully | Bypasses Step 2 retry; executes `safestFallback` | **PASS** (As Designed) |
| **4.3** | Truncated JSON response | Step 2 corrective retry or network retry | Classified as `'fatal'`; bypasses retry to `safestFallback` | **FAIL** (Bug Confirmed) |
| **4.4** | Markdown preamble with preamble `{}` | Extract JSON code block `{...}` | Greedy regex matches preamble; throws `fatal` error | **FAIL** (Bug Confirmed) |

---

## Recommended Mitigations

1. **Turn Plan Manager**:
   - Move `TurnPlanManager` to shared game engine session context or introduce an engine observer event bus to notify all seat providers of opponent non-pass actions.
   - Track `phase` and `step` in `TurnPlanManager`; clear queue on phase/step transitions.

2. **Validation**:
   - Update `validateResponse` in `validate.ts` to recursively validate all items inside `response.plannedActions` (checking `type`, string `name`, array `targets`, and slot choices).
   - In `TurnPlanManager.findMatchingAction`, add type guards (`typeof planned.name === 'string'`) before calling `.toLowerCase()`.

3. **Error Recovery**:
   - In `retry.ts`, classify `AiResponseValidationError` as `'retryable'` (or trigger Step 2 Corrective Retry in `provider.ts`).
   - Fix `parseJsonResponse` regex to target markdown code fences specifically (e.g. `/```(?:json)?\s*([\s\S]*?)\s*```/` or match non-greedy JSON objects).
