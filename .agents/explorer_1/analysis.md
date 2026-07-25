# Comprehensive Technical Analysis: Uncommitted and Untracked Code Changes

**Scope**: `@mtg/engine`, `@mtg/server`, `@mtg/shared`, and associated project configuration/docs  
**Date**: 2026-07-25  
**Author**: Explorer 1  

---

## 1. Executive Summary

This deep-dive inspection covers all uncommitted and untracked code changes in the MTG Tester repository across `@mtg/engine`, `@mtg/server`, and `@mtg/shared`. The changes complete Phase 3 of the project roadmap (AI Agent Decision Infrastructure) and expand MTG game engine fidelity, card definition handling, pre-flight heuristics, turn planning, response validation, and auditing.

### Key Architectural Highlights:
1. **AI Decision Provider Infrastructure (`OpenAiDecisionProvider`)**: Implements an `AsyncDecisionProvider` operating on an OpenAI-compatible JSON Chat Completions endpoint. Integrates a 3-step error recovery pipeline (Primary AI call → Single corrective retry with validation feedback → Conservative safest legal action fallback) coupled with local short-circuit mechanisms (Turn Plan execution → Pre-flight heuristics → Content-digest decision cache).
2. **Turn Pre-Planning (`TurnPlanManager`)**: Allows active players' AI models to return a sequence of `plannedActions` alongside their immediate decision. Subsequent requests on the active player's turn are answered locally without network roundtrips as long as the plan remains valid and un-intervened by opponent actions.
3. **Pre-flight Cost Heuristics (`tryHeuristic`)**: Short-circuits dominated, unambiguous decisions before reaching the network rate limiter. Implements `tryDeferInstant` (holding instants when the stack is empty and outside key combat trick steps), `tryObviousLandDrop` (taking a free once-per-turn land drop when it is the sole non-pass option), and `tryDeclineZeroPowerAttack` (declining attacks with 0-power creatures absent triggers or held pump instants).
4. **Robust JSON Parsing & Coercion (`parseJsonResponse`)**: Extracts JSON payload objects from conversational or markdown-fenced LLM responses, normalizes action key aliases (`actionId`, `action_id`, `action`, `choice`, `id`), coerces data types, and validates structural integrity before state machine submission.
5. **Debug Logging & Persistence (`AiCallLogger` & Engine Debug)**: Persists all decision attempts (including skipped local decisions) into the SQLite `ai_calls` database table with latency, token usage, model ID, and source classification (`primary`, `retry`, `fallback`, `heuristic`, `cache`, `plan`). Emits structured debug events into `engine.addDebug()`.

---

## 2. AI Decision Architecture & Infrastructure (`packages/server/src/ai/`)

### 2.1 OpenAiDecisionProvider (`provider.ts`)
* **Location**: `packages/server/src/ai/provider.ts`
* **Purpose**: Implements `AsyncDecisionProvider` from `@mtg/engine`. Drives decision resolution for AI seats in asynchronous completion runs (`runToCompletionAsync`).

#### Short-Circuit Chain (`tryLocalAnswer`):
Before entering the rate-limited request queue (`queue.enqueue`), `tryLocalAnswer` checks three local evaluation layers in strict sequence:
1. **Turn Plan Execution**: `turnPlan.tryExecutePlan(request, this.engine)`
   - If a valid pre-planned action matches the requested legal menu, returns it instantly.
2. **Pre-Flight Heuristics**: `tryHeuristic(request, view)` (guarded by `config.heuristicsEnabled`)
   - Resolves dominated decisions locally. Emits debug event `decision answered locally ... via heuristic`.
3. **Decision Cache**: `cache.get(request, view)` (guarded by `config.decisionCacheEnabled`)
   - Reuses past choices when the game state content digest (`digestDecision`) is identical.

#### 3-Step Error Recovery Pipeline (`decideViaModel`):
If local short-circuits return `null`, the provider executes `decideViaModel`:
1. **Step 1: Primary Attempt**
   - Assembles prompt (`assemblePrompt(request, view)`).
   - Enqueues API call to `client.requestDecision(prompt, request)`.
   - Validates response via `validateResponse(result.response, request)`.
   - On success: logs with source `'primary'`, updates cache (`rememberAnswer`), records decision in `TurnPlanManager`, returns response.
2. **Step 2: Single Corrective Retry**
   - Triggered if `error1` is returned by `validateResponse`.
   - Constructs corrective message history: original prompt + assistant raw response + user validation error prompt restating the legal action menu.
   - Enqueues retry call (`retryResult`).
   - Validates response via `validateResponse(retryResult.response, request)`.
   - On success: logs with source `'retry'`, updates cache, records decision in `TurnPlanManager`, returns response.
3. **Step 3: Safest Conservative Fallback**
   - Triggered if retry validation fails (`error2 !== null`) OR if an unhandled non-terminal request error occurs during network fetch.
   - Calls `safestFallback(request)` to obtain a non-destructive legal option.
   - **Crucial Design Choice**: Fallbacks are **deliberately excluded from the decision cache** (`rememberAnswer` is bypassed). Fallbacks represent AI failure recovery, not genuine player intent; caching them would cause model errors to propagate across future turns for free.
   - Records decision in `TurnPlanManager` with source `'fallback'`.

#### Terminal Error Handling (`isTerminalAiError`):
- Non-recoverable errors (`DailyQuotaExhaustedError`, `NoAvailableModelError`, `AuthenticationError`) are rethrown immediately rather than caught by fallback logic.
- **Rationale**: Falling back during credential or quota exhaustion would cause games to complete silently using 100% fallback actions, producing invalid game test telemetry.

---

### 2.2 Turn Plan Manager (`turn-plan.ts`)
* **Location**: `packages/server/src/ai/turn-plan.ts`
* **Purpose**: Allows active players to execute multi-step turn sequences (e.g. play land → cast creature → attack) within a single AI turn planning cycle.

#### Mechanics & State Tracking:
- Tracks `activePlayer`, `turnNumber`, `queue: PlannedAction[]`, and `opponentIntervened: boolean`.
- Active players return `plannedActions?: PlannedAction[]` inside their LLM JSON responses (`DecisionResponse`).
- When `recordDecision` processes an active player's response with `plannedActions`, it populates `queue` and resets `opponentIntervened = false`.

#### Matching & Execution (`tryExecutePlan`):
- Only fires when `request.decidingPlayer === request.activePlayer` and `turnNumber === request.turn` and `!opponentIntervened`.
- Compares `queue[0]` against `request.legalActions`:
  - Target matching (`isTargetValid`): Ensures target choices specified in `planned.targets` exist within valid options for target slots.
  - Action type & name matching: Matches `planned.type` and optional `planned.name` substring in `legalActions.description`.
- If match succeeds: removes action from `queue`, constructs `DecisionResponse`, logs debug event, and returns.
- If match fails (planned action no longer legal): invalidates plan (`clear()`), logs debug warning, and proceeds to model call.

#### Plan Invalidation Conditions (`recordDecision` & `clear`):
1. **Opponent Intervention**: If `request.decidingPlayer !== request.activePlayer` and the opponent takes a real non-pass action (excluding `pass`, `passAndYieldTurn`, `yieldToAbility`, and actions answered by local heuristics/cache), `opponentIntervened` is set to `true` and `queue` is cleared.
2. **Turn Transition**: Changing `turnNumber` or `activePlayer` resets the queue.
3. **Illegality**: If the head of the queue cannot be matched against legal actions, the plan is cleared.

---

### 2.3 Pre-Flight Heuristics (`heuristics.ts`)
* **Location**: `packages/server/src/ai/heuristics.ts`
* **Purpose**: Local resolution of dominated decisions that survive engine-level `isForced()` checks.

#### Heuristic Rules:

| Rule | Function | Logic | Safety & Scope Constraints |
|---|---|---|---|
| **Rule A** | `tryDeferInstant` | Defers casting instant-speed spells when there is nothing on the stack to respond to. | • `request.decisionType === 'priority'`<br>• Stack must be empty (`view.stack.length === 0`)<br>• Excludes key combat trick steps (`declareAttackers`, `declareBlockers`, `firstStrikeCombatDamage`, `combatDamage`). Allowed ONLY in non-combat or harmless combat steps (`beginCombat`, `endCombat`)<br>• Prefers `passAndYieldTurn` on opponent turns, otherwise `pass`. |
| **Rule C** | `tryObviousLandDrop` | Automatically plays a land when it is the sole non-pass action offered. | • `request.decisionType === 'priority'`<br>• `nonPassActions.length === 1` and `nonPassActions[0].type === 'playLand'`<br>• If multiple lands are available or spells can be cast, defers to LLM for sequencing/color decisions. |
| **Rule B** | `tryDeclineZeroPowerAttack` | Declines attacking with 0-power creatures that deal no combat damage. | • `request.decisionType === 'declareAttackers'`<br>• Player must NOT hold any instant cards in hand (`!view.hand.some(isInstant)`) to allow "attack then pump" tactics.<br>• Requires `hasTriggers === false` in option data.<br>• Supports batch shortcut (`noAttackRest`) when all remaining creatures are powerless. |

---

### 2.4 JSON Response Parsing (`parseJsonResponse` in `client.ts`)
* **Location**: `packages/server/src/ai/client.ts`
* **Purpose**: Robust extraction and normalization of LLM JSON outputs.

#### Parsing Protocol:
1. **Code Block & Conversational Stripping**:
   - Uses regex `\{[\s\S]*\}` to extract the outermost JSON object, stripping markdown formatting (` ```json ... ``` `) and preamble/postscript text.
   - Throws `AiResponseValidationError` if no `{...}` object exists.
2. **JSON Deserialization**:
   - Runs `JSON.parse`. Throws `AiResponseValidationError` on syntax error or non-object payload.
3. **Action ID Normalization**:
   - Inspects alias fields in priority order: `obj['actionId'] ?? obj['action_id'] ?? obj['action'] ?? obj['choice'] ?? obj['id']`.
   - Coerces numbers and strings via `Math.floor(rawActionId)` or `Number.parseInt(String(rawActionId), 10)`.
   - Validates `!Number.isNaN(actionId)`, throwing `AiResponseValidationError` on failure.
4. **Payload Extraction**:
   - Extracts optional `targets` array, `plannedActions` array, and `note` string.
   - Defaults `requestId` to `expectedRequestId` if missing in LLM response.

---

### 2.5 Debug Logging & Telemetry (`logger.ts` & Engine Debug Integration)
* **Location**: `packages/server/src/ai/logger.ts`
* **Purpose**: Auditing decision sources, model token costs, latencies, and debugging state transitions.

#### Database Persistence (`AiCallLogger`):
- Writes records into SQLite table `ai_calls`:
  - Fields: `game_id`, `sequence`, `seat`, `model`, `prompt_tokens`, `response_tokens`, `request_json`, `response_json`, `was_retry`, `was_fallback`, `latency_ms`, `source`.
- Tracks `source` classification (`primary`, `retry`, `fallback`, `heuristic`, `cache`, `plan`).
- `SKIPPED_SOURCES` (`heuristic`, `cache`, `plan`) are recorded with zero token cost/latency metadata (`localCallMeta()`) to maintain accurate decision volume metrics without distorting network API billings.
- Provides `summary()` method returning aggregate statistics (total decisions, skipped calls, retries, fallbacks, total prompt/response tokens, average latency).

#### Engine Debug Logging Integration:
- `OpenAiDecisionProvider` invokes `this.engine.addDebug?.('decision', message, payload)` at key lifecycle points:
  - Initiation of network API call.
  - Completion of network API call (including latency, model, token stats).
  - Local resolution via heuristic or cache.
  - Turn plan recording and invalidation events.

---

## 3. Engine Core Modifications (`packages/engine/src/`)

### 3.1 Decision & Provider Enhancements
* **`decisions.ts`**:
  - `EngineActionOption`: Added `data?: Record<string, unknown>;` field. Transports engine-calculated facts (e.g. `instantSpeed`, `power`, `hasTriggers`, combat group aggregates) to `LegalAction.data`. Purely descriptive.
  - `isForced()` & `forcedOutcome()`: Updated to classify priority decisions where all options are pass variations (`pass`, `passAndYieldTurn`, `yieldToAbility`) as forced decisions, auto-resolving them in the engine pump.
* **`providers/providers.ts`**:
  - Added `AsyncDecisionProvider` interface (`decide(request: DecisionRequest): Promise<DecisionResponse>`).
  - Added `runToCompletionAsync()` supporting asynchronous decision providers and optional `onDecision` completion callbacks.
  - Updated `runToCompletion()` signature to accept optional configuration object (`{ maxDecisions?, onDecision? }`).

### 3.2 Priority Engine & Auto-Pass Yielding
* **`turn/priority.ts`**:
  - Expanded priority actions: `passAndYieldTurn` (sets `player.yieldUntilEndOfTurn = true`) and `yieldToAbility` (appends oracle ID to `player.yieldedAbilities`).
  - Implemented `shouldAutoPassPriority()`: auto-passes priority when `yieldUntilEndOfTurn` is active or top of stack matches a yielded trigger oracle ID.
  - Added `resetOpponentYields()`: clears yield flags for opponents when a controller takes active game actions.
  - Resets yield flags during the untap step (`turn.ts`).

### 3.3 Public State Visibility in Player Views
* **`view/view.ts`**:
  - Extended `PermanentView` to include `typeLine` and `oracleText` for non-face-down permanents.
  - Extended `CardView` to include `power` and `toughness` from definitions.
  - Enables AI decision providers to inspect public battlefield text and creature stats without violating anti-cheat hidden information boundaries (§7.1).

### 3.4 Intervening-If Conditions & Card Overrides
* **`cards/condition.ts`** *(Untracked File)*:
  - Implements `evaluateCondition()` for evaluating condition trees (e.g., intervening-if CR 603.4 for upkeep triggers, control checks, target checks).
* **`cards/creature-types.ts` & `cards/overrides/index.ts`** *(Untracked Files)*:
  - Added support for creature type taxonomy and card-specific engine overrides.

---

## 4. Shared Type System Extensions (`packages/shared/src/`)

- **`engine.ts`**:
  - Defined `PlannedAction` interface (`type`, `name?`, `description?`, `targets?`).
  - Added `plannedActions?: PlannedAction[]` to `DecisionResponse`.
- **`view.ts`**:
  - Added `typeLine?: string` and `oracleText?: string` to `PermanentView`.
  - Added `power?: number | null` and `toughness?: number | null` to `CardView`.
- **`index.ts`**:
  - Re-exported `PlannedAction`.

---

## 5. Server Database & Schema Updates (`packages/server/src/db/`)

- **`schema.ts`**:
  - Added `source TEXT` column to `ai_calls` table schema.
  - Introduced `MIGRATIONS_SQL`: `ALTER TABLE ai_calls ADD COLUMN source TEXT`.
- **`index.ts`**:
  - Updated `GameStore` constructor to execute `MIGRATIONS_SQL` upon opening database connections. Wraps migration execution in `try-catch` to silently ignore "duplicate column name" errors on existing databases.

---

## 6. Architecture Decision Records (ADRs) Summary

1. **ADR 0009 (`0009-supported-pool-decks.md`)**: Establishes supported Commander pool decks (Ur-Dragon, Necron Dynasties, Token Triumph, etc.) and oracle coverage standards.
2. **ADR 0010 (`0010-decision-call-budget.md`)**: Defines rate-limiting strategies and decision metering. Introduces pre-flight heuristics, content-digest decision caching, structured option `data`, and batch combat shortcuts (`noAttackRest`, `attackRest`, `noBlockRest`).
3. **ADR 0011 (`0011-openai-compatible-provider.md`)**: Outlines the transition to an OpenAI-compatible API client supporting multi-model fallback chains (e.g., Gemini 3.5 Flash / Lite, DeepSeek, Groq, local Ollama).

---

## 7. Risk Analysis & Design Trade-offs

| Component | Potential Risk | Mitigation / Design Safeguard |
|---|---|---|
| **Heuristics (`tryDeferInstant`)** | Might defer an instant when a subtle combat trick or stack interaction was desired. | Strictly excluded in active combat trick steps (`declareAttackers`, `declareBlockers`, `damage`). Requires empty stack. |
| **Heuristics (`tryDeclineZeroPowerAttack`)** | Might prevent attacking with a 0-power creature that has an attack trigger or held pump spell. | Blocked if player holds ANY instant in hand (`!view.hand.some(isInstant)`). Explicitly requires engine-certified `hasTriggers === false`. |
| **Decision Cache (`DecisionCache`)** | Might return a stale action if game state changes are omitted from key hash. | Key is computed as an FNV-1a content digest over all public battlefield objects, player hand names, available mana, stack contents, and offered legal action IDs (`digestDecision`). Does NOT key on turn number or request ID. |
| **Turn Planning (`TurnPlanManager`)** | Could execute invalid or unintended sequence if board state shifts unexpectedly. | Invalidated immediately if legal options do not match, or if an opponent takes a real non-pass action. |
| **Database Migrations (`MIGRATIONS_SQL`)** | Schema evolution on SQLite databases in production/dev. | Idempotent `try-catch` execution on `ALTER TABLE` handles pre-existing databases without requiring a full migration framework. |

---

## 8. Verification & Test Suite Coverage

The changes are backed by extensive unit and integration tests across engine and server packages:
- `packages/server/src/ai/provider.test.ts`: Provider chain, retries, fallbacks, terminal error rethrowing.
- `packages/server/src/ai/turn-plan.test.ts`: Plan execution, matching, opponent intervention invalidation.
- `packages/server/src/ai/heuristics.test.ts`: Verification of Rule A, Rule B, Rule C edge cases.
- `packages/server/src/ai/client.test.ts`: `parseJsonResponse` markdown stripping, key alias coercion, fallback endpoint retries.
- `packages/server/src/ai/decision-cache.test.ts`: Digest key stability and LRU eviction.
- `packages/server/src/ai/logger.test.ts`: SQLite logging and summary calculations.
- `packages/engine/tests/async-providers.test.ts`: `runToCompletionAsync` flow.
