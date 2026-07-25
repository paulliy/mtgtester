# Deep Component Interaction & Edge Case Analysis: AI Decision System & Game Engine

## Executive Summary

This report presents a detailed architectural and edge-case analysis of the interaction between the AI Decision System (`packages/server/src/ai`) and the MTG Game Engine (`packages/engine`). Four primary system interaction areas were investigated: turn plan queue handling, pre-planned target validation, priority passing loops on opponent turns, and LLM JSON parsing/error recovery robustness. 

Several key structural issues and bugs were discovered:
1. **Turn Plan Encapsulation Failure**: `TurnPlanManager` tracks opponent intervention via `recordDecision`, but because `OpenAiDecisionProvider` is instantiated per seat/player, Player 1's provider never observes Player 2's decisions. Consequently, `this.opponentIntervened` is unreachable dead code in production, allowing stale plans to execute after opponent counter-plays.
2. **Unvalidated Plan Generation**: `validateResponse` pre-validates primary decision outputs, but leaves `plannedActions` unvalidated. Invalid target choices or malformed planned actions pass initial validation, causing silent plan drops later at execution time.
3. **Priority Loop Latency Overhead on Non-Empty Stacks**: While `isForced` auto-passes empty decision menus and `tryDeferInstant` yields on empty stacks, a non-empty stack disables `tryDeferInstant` and changes the `DecisionCache` digest on every stack item resolution, prompting the LLM once per stack item when holding instant-speed options.
4. **Corrective Retry Bypass on JSON Parse Error**: `parseJsonResponse` throws an exception inside `client.requestDecision` when receiving malformed JSON or HTML error pages. Because `withRetry` classifies unrecognized syntax errors as `fatal`, `requestDecision` rejects immediately. In `provider.ts`, this exception bypasses Step 2 (Corrective Retry) of the 3-step error recovery chain and jumps directly to Step 3 (Safest Fallback).

---

## 1. Stale Turn Plan Queues During Priority Sequence Transitions or Opponent Actions

### 1.1 Architectural Encapsulation Bug in `TurnPlanManager`
- **Location**: `packages/server/src/ai/turn-plan.ts` (lines 83-104) vs `packages/server/src/ai/provider.ts` (lines 51-52).
- **Mechanism**: `TurnPlanManager` implements opponent intervention detection in `recordDecision`:
  ```ts
  if (request.decidingPlayer !== request.activePlayer) {
    const chosenAction = request.legalActions.find((a) => a.id === response.actionId);
    if (chosenAction !== undefined && chosenAction.type !== 'pass' && ...) {
      this.opponentIntervened = true;
      this.queue = [];
    }
  }
  ```
- **Flaw**: In `provider.ts`, `TurnPlanManager` is declared as a private field inside `OpenAiDecisionProvider`:
  ```ts
  export class OpenAiDecisionProvider implements AsyncDecisionProvider {
    private readonly turnPlan = new TurnPlanManager();
  ```
  Game drivers (e.g. `runToCompletionAsync` in `packages/engine/src/providers/providers.ts`) resolve providers per seat: `providerFor(step.request.decidingPlayer).decide(step.request)`.
  When Player 2 (opponent) makes a decision, `provider2.decide()` executes. `provider1.decide()` is never called, so `provider1.turnPlan.recordDecision()` is **never invoked** with `request.decidingPlayer !== 'P1'`.
- **Impact**: `opponentIntervened` in Player 1's `TurnPlanManager` remains `false`. If Player 1 pre-plans `[castSpell: Lightning Bolt, pass]`, and Player 2 responds by casting an instant (e.g. `Giant Growth`), when priority returns to Player 1, Player 1's `tryExecutePlan` evaluates `opponentIntervened === false`. Since `pass` is still a legal action with `Giant Growth` on the stack, `findMatchingAction` returns `pass`, and Player 1 blindly passes priority without re-evaluating the opponent's response.
- **Unit Test Masking**: In `turn-plan.test.ts` (lines 69-88), the test manually feeds an opponent request into a single shared `TurnPlanManager` instance, masking the fact that per-seat provider encapsulation prevents this in production.

### 1.2 Phase/Step Transition Tracking
- **Location**: `packages/server/src/ai/turn-plan.ts` (lines 29, 76).
- **Mechanism**: `TurnPlanManager` checks `this.turnNumber !== request.turn || this.activePlayer !== request.activePlayer`. It **does not track `phase` or `step`**.
- **Impact**:
  - If a planned action is specific to a phase (e.g. `playLand` in Precombat Main) and priority advances to Combat, `findMatchingAction` fails to find `playLand` in `legalActions` (returns `null`), which correctly triggers `this.clear()`.
  - However, if the queued action is `pass`, `findMatchingAction` finds `pass` in the new phase/step, executing it out of context (e.g., executing a pass pre-planned for Main 1 during Combat or Postcombat Main).

---

## 2. Target Selection Mismatch in Pre-Planned Actions

### 2.1 Target Legality Validation at Execution Time
- **Location**: `packages/server/src/ai/turn-plan.ts` (lines 135-143).
- **Mechanism**: When `tryExecutePlan` evaluates a queued action, `isTargetValid` verifies target choices against the offered `LegalAction`:
  ```ts
  const isTargetValid = (action: LegalAction): boolean => {
    if (action.targets === undefined || action.targets.length === 0) return true;
    for (const slot of action.targets) {
      if (slot.options.length <= 1) continue;
      const choiceObj = planned.targets?.find((t) => t.slot === slot.slot);
      if (choiceObj === undefined || !slot.options.includes(choiceObj.choice)) return false;
    }
    return true;
  };
  ```
- **Evaluation**:
  - Target legality **is checked** against current `slot.options` at execution time. If a pre-planned target died, gained hexproof, or left the battlefield, `slot.options.includes(choiceObj.choice)` returns `false`.
  - When `isTargetValid` returns `false`, `findMatchingAction` returns `null`, logging `turn plan invalidated: planned action not in legal options` and clearing the queue.

### 2.2 Target Edge Cases & Validation Gaps
- **Single-Option Target Check Bypass**: Line 138 (`if (slot.options.length <= 1) continue;`) skips choice validation when only 1 legal target exists. If `planned.targets` specified an explicit target ID that became invalid, but field state changed such that only 1 legal target remains, the pre-planned target choice check is bypassed. In `engine.ts` (lines 139-141), the engine auto-assigns `slot.options[0]` when `choice === undefined`, which may execute the action on a target the AI did not originally intend.
- **Unvalidated `plannedActions` in `validateResponse`**: `validateResponse` (`packages/server/src/ai/validate.ts`) validates `response.actionId` and `response.targets` for the current request, but **does not validate `response.plannedActions`**. If an LLM returns malformed targets or invalid card names in `plannedActions`, `validateResponse` returns `null` (valid). The malformed plan is saved, only to be silently discarded later during `tryExecutePlan` without triggering a corrective retry prompt to the LLM.
- **Stale `ObjectId` References**: Pre-planned targets store raw `ObjectId` strings. If game state changes alter object IDs (or if an LLM guesses an ID for a future turn), `isTargetValid` fails and invalidates the plan.

---

## 3. Priority Pass Loops on Opponent Turns

### 3.1 Forced Decisions & Auto-Pass Mechanism
- **Location**: `packages/engine/src/decisions.ts` (lines 54-61), `packages/engine/src/turn/priority.ts` (lines 115-130).
- **Mechanism**: The engine auto-resolves priority requests without surfacing them to the AI when `isForced(decision)` is true:
  ```ts
  export function isForced(decision: PendingDecision): boolean {
    if (decision.decisionType === 'priority' && decision.options.every(isPassOption)) {
      return true;
    }
    ...
  }
  ```
- **Evaluation**: If a player on an opponent's turn has no playable instants or activated abilities, `options` contains only pass variations (`pass`, `passAndYieldTurn`, `yieldToAbility`). `isForced` returns `true`, and the engine auto-passes instantly with zero network/LLM overhead.

### 3.2 Yield State Persistence & Reset
- **Location**: `packages/engine/src/turn/priority.ts` (lines 28, 45-51, 137-140), `packages/engine/src/actions/apply.ts` (lines 188, 266).
- **Mechanism**: `tryDeferInstant` (`packages/server/src/ai/heuristics.ts`) selects `passAndYieldTurn` on opponent turns when holding instant-speed cards into an empty stack outside critical combat steps.
  - In `priority.ts`, `passAndYieldTurn` sets `player.yieldUntilEndOfTurn = true`.
  - For the rest of the opponent's turn, `shouldAutoPassPriority` returns `true` for all priority checks.
  - When an opponent casts a spell or activates an ability, `resetOpponentYields(ctx, player.id)` resets `p.yieldUntilEndOfTurn = false` for all opponents, ensuring non-active players regain priority to respond to new stack items.

### 3.3 Priority Prompt Loops on Non-Empty Stacks
- **Location**: `packages/server/src/ai/heuristics.ts` (line 71), `packages/server/src/ai/decision-cache.ts` (lines 94-100).
- **Mechanism & Problem**:
  - When `view.stack.length > 0` (opponent cast a spell or trigger hit stack), `tryDeferInstant` explicitly returns `null` (deactivated).
  - As items resolve off the stack one by one, `digestDecision` hashes `view.stack` (length and item IDs). Each resolution changes `digestDecision`, causing `DecisionCache` to miss.
  - If a non-active player holds instant-speed cards, `isForced` is `false`, `tryDeferInstant` returns `null`, and `DecisionCache` misses.
  - Result: The non-active player is prompted via network LLM call for **every single item on the stack** as it resolves. If the LLM repeatedly chooses `pass`, N separate API calls are executed for N stack items on the opponent's turn.

### 3.4 Infinite Action Loop Protection
- **Location**: `packages/engine/src/turn/priority.ts` (line 168 - CR 117.3c actor retains priority), `packages/engine/src/providers/providers.ts` (line 166).
- **Mechanism**: If two players repeatedly respond to each other or an AI repeatedly activates a `{0}` ability, `runToCompletionAsync` limits total surfaced decisions to `maxDecisions` (default 100,000). If exceeded, it throws `exceeded 100000 surfaced decisions — runaway game?`.

---

## 4. Malformed JSON / HTML Error Response Handling from LLM Proxies

### 4.1 Greedy Regex Extraction (`/\{[\s\S]*\}/`)
- **Location**: `packages/server/src/ai/client.ts` (lines 195-200).
- **Code**:
  ```ts
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match !== null) {
    cleaned = match[0];
  }
  ```
- **Flaws**:
  1. **Conversational Text with Braces**: If an LLM includes reasoning containing braces before the final JSON object (e.g. `Reasoning: { "analysis": "play land" } Response: { "actionId": 1 }`), the regex matches from the *first* `{` of the reasoning to the *last* `}` of the response, producing invalid JSON string `{ "analysis": "play land" } Response: { "actionId": 1 }`. `JSON.parse` throws `SyntaxError`.
  2. **HTML Error Pages with Inline CSS/JS**: If a proxy returns an HTTP 200 OK with HTML content containing `<style>body { color: red; }</style>`, the regex extracts `body { color: red; }`, causing `JSON.parse` to fail with `SyntaxError`.

### 4.2 Error Classification & Retry Bypass
- **Location**: `packages/server/src/ai/retry.ts` (lines 77-111), `packages/server/src/ai/client.ts` (lines 150, 166-185), `packages/server/src/ai/provider.ts` (lines 112-194).
- **Chain Analysis**:
  1. When `JSON.parse` or `res.json()` throws a `SyntaxError` or `AiResponseValidationError`, `requestDecision` rejects with that error.
  2. `withRetry` invokes `classifyError(err)`. In `retry.ts`:
     - `status` is `undefined`.
     - `text` contains `"syntaxerror: unexpected token..."`.
     - `classifyError` checks for 401/403 (false), 404 (false), `json_validate_failed` (false), quota errors (false), and 5xx status codes (false).
     - `classifyError` defaults to returning **`'fatal'`**.
  3. `withRetry` sees `'fatal'` and **immediately re-throws without retrying**.
  4. In `provider.ts`:
     ```ts
     try {
       return await this.decideViaModel(request, view);
     } catch (err) {
       if (isTerminalAiError(err)) throw err;
       const fallback = safestFallback(request);
       ...
       return fallback;
     }
     ```
- **CRITICAL RECOVERY CHAIN BUG**:
  Step 2 of the 3-step error recovery chain (§7.7: Primary -> Corrective Retry -> Safest Fallback) is **completely bypassed** on JSON parsing errors. Corrective retries (which re-prompt the LLM with `Validation error: ... Return ONLY JSON`) are only invoked if `requestDecision` succeeds and returns a `DecisionResponse` that fails `validateResponse`. If `parseJsonResponse` throws an exception, `decideViaModel` aborts immediately to Step 3 (`safestFallback`).

### 4.3 Unvalidated Nested JSON Fields in `parseJsonResponse`
- **Location**: `packages/server/src/ai/client.ts` (lines 230-236).
- **Code**:
  ```ts
  if (Array.isArray(obj['targets'])) {
    response.targets = obj['targets'];
  }
  if (Array.isArray(obj['plannedActions'])) {
    response.plannedActions = obj['plannedActions'];
  }
  ```
- **Flaw**: `parseJsonResponse` verifies `Array.isArray(...)` but does not validate element schemas inside `targets` or `plannedActions`. If an LLM returns numeric values for string fields (e.g. `plannedActions: [{ type: 123, name: 456 }]`), downstream consumers such as `TurnPlanManager.findMatchingAction` execute `.toLowerCase()` on non-string values, throwing uncaught `TypeError` at runtime during plan execution.

---

## Synthesis of Recommended Fixes (for Implementation Phase)

| Component | Target File | Recommended Fix |
|---|---|---|
| **Turn Plan** | `packages/server/src/ai/turn-plan.ts` | Track `phase` and `step` in `TurnPlanManager`. Clear queue on phase/step transitions. Pass opponent action notifications from engine/session layer to active player's plan manager. |
| **Target Pre-planning** | `packages/server/src/ai/validate.ts` | Validate `plannedActions` array in `validateResponse` (check action types, target slot candidate ranges, and name formats) so invalid plans trigger corrective retries at generation time. |
| **Priority Loops** | `packages/server/src/ai/heuristics.ts` & `decision-cache.ts` | Normalize stack item IDs in `digestDecision` or enable a lightweight non-active priority pass heuristic when top-of-stack action does not target/affect non-active player. |
| **JSON Parser** | `packages/server/src/ai/client.ts` & `retry.ts` | Use non-greedy JSON block extraction (e.g., finding balanced braces or last JSON block), classify `AiResponseValidationError` / `SyntaxError` as `'retryable'` in `classifyError`, and validate nested item schemas in `parseJsonResponse`. |
