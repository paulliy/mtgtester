# Handoff Report: AI Decision System & Engine Interaction Analysis

## 1. Observation

### Observation 1: Per-Seat Provider Encapsulation of `TurnPlanManager`
- **File**: `packages/server/src/ai/turn-plan.ts`, lines 83-104; `packages/server/src/ai/provider.ts`, lines 51-52.
- **Verbatim Code**:
  - `turn-plan.ts` (lines 83-103):
    ```ts
    if (request.decidingPlayer !== request.activePlayer) {
      const chosenAction = request.legalActions.find((a) => a.id === response.actionId);
      if (
        chosenAction !== undefined &&
        chosenAction.type !== 'pass' &&
        chosenAction.type !== 'passAndYieldTurn' &&
        chosenAction.type !== 'yieldToAbility' &&
        source !== 'heuristic' &&
        source !== 'cache'
      ) {
        if (this.queue.length > 0) { ... }
        this.opponentIntervened = true;
        this.queue = [];
      }
    }
    ```
  - `provider.ts` (lines 51-52):
    ```ts
    export class OpenAiDecisionProvider implements AsyncDecisionProvider {
      private readonly cache = new DecisionCache();
      private readonly turnPlan = new TurnPlanManager();
    ```
- **Driver invocation**: `packages/engine/src/providers/providers.ts` line 169: `await providerFor(step.request.decidingPlayer).decide(step.request)`.

### Observation 2: Unvalidated `plannedActions` in `validateResponse`
- **File**: `packages/server/src/ai/validate.ts`, lines 13-43.
- **Verbatim Code**: `validateResponse` checks `response.requestId`, `response.actionId`, and `response.targets` against `request.legalActions`. It contains no checks for `response.plannedActions`.

### Observation 3: Deactivation of Instant Deferral on Non-Empty Stack & Decision Cache Digest
- **File**: `packages/server/src/ai/heuristics.ts`, line 71; `packages/server/src/ai/decision-cache.ts`, lines 94-100.
- **Verbatim Code**:
  - `heuristics.ts` line 71: `if (view.stack.length > 0) return null;`
  - `decision-cache.ts` lines 94-100:
    ```ts
    h = mix(h, view.stack.length);
    for (const item of view.stack) {
      h = hashString(h, item.id);
      h = hashString(h, item.controller);
      h = hashString(h, item.description);
      for (const target of item.targets) h = hashString(h, target);
    }
    ```

### Observation 4: JSON Extraction Regex and Error Classification Fatal Fallthrough
- **File**: `packages/server/src/ai/client.ts`, lines 195-200; `packages/server/src/ai/retry.ts`, lines 77-111; `packages/server/src/ai/provider.ts`, lines 81-105.
- **Verbatim Code**:
  - `client.ts` line 195: `const match = cleaned.match(/\{[\s\S]*\}/);`
  - `retry.ts` lines 110-111: `return 'fatal';` (default return of `classifyError` for unrecognized errors/SyntaxError).
  - `provider.ts` lines 81-105:
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

---

## 2. Logic Chain

1. **Stale Plan Invalidation Failure**:
   - *Observation 1* shows that `TurnPlanManager` is an instance property of `OpenAiDecisionProvider`, which is instantiated per seat (`P1` and `P2` have separate providers).
   - `providerFor(step.request.decidingPlayer)` calls `provider2` when `decidingPlayer === 'P2'`. `provider1.turnPlan.recordDecision()` is never called when `P2` acts.
   - Therefore, `P1`'s `this.opponentIntervened` is never set to `true` when `P2` casts a spell or activates an ability on `P1`'s turn.
   - When priority returns to `P1`, `P1`'s `tryExecutePlan` evaluates `this.opponentIntervened === false`. If the next pre-planned action is `pass`, `findMatchingAction` matches `pass` and executes it blindly without re-evaluating `P2`'s response.

2. **Pre-Planned Target Validation Gap**:
   - *Observation 2* shows `validateResponse` only validates current-turn `actionId` and `targets`.
   - When an LLM returns `plannedActions` with invalid target choices or malformed properties, `validateResponse` returns `null` (success).
   - The malformed plan is stored in `TurnPlanManager.queue`. At execution time, `findMatchingAction` fails `isTargetValid` and clears the plan queue without generating a corrective retry prompt to the LLM.

3. **Priority Request Multiplication on Opponent Turns**:
   - *Observation 3* shows `tryDeferInstant` returns `null` whenever `view.stack.length > 0`.
   - As items resolve off the stack, `view.stack` changes, altering `digestDecision` in `DecisionCache` and causing cache misses.
   - Consequently, if a non-active player holds instant-speed spells/abilities during stack resolution, every item resolution triggers a fresh network LLM call, generating N API calls for N stack items.

4. **Corrective Retry Bypass on JSON Parse Errors**:
   - *Observation 4* shows `parseJsonResponse` uses greedy regex `/\{[\s\S]*\}/` and runs inside `client.requestDecision`.
   - If HTML text or conversational braces cause `JSON.parse` or `parseJsonResponse` to throw `AiResponseValidationError` or `SyntaxError`, `classifyError` classifies the error as `'fatal'`.
   - `withRetry` re-throws the error immediately without retrying.
   - In `provider.ts`, `decideViaModel` catches the error in its outer `try...catch` block and invokes `safestFallback(request)`, completely skipping Step 2 (Corrective Retry) of the §7.7 error recovery protocol.

---

## 3. Caveats

- **No Live Network Calls Executed**: Analysis was performed strictly via code inspection and static control flow tracing in accordance with read-only investigation rules.
- **Model-Specific Parsing Differences**: Different LLM providers (e.g. OpenAI vs DeepSeek vs Groq vs Ollama) vary in their output formatting (e.g., Markdown code block wrapping vs raw JSON output vs thinking tokens). The greedy regex issue primarily affects providers that output conversational preamble or thinking blocks alongside JSON.

---

## 4. Conclusion

The MTG tester AI decision pipeline contains critical component interaction edge cases:
1. **Encapsulation Defect**: `TurnPlanManager` opponent intervention tracking is ineffective in multi-provider production setups, risking invalid pre-planned actions after opponent responses.
2. **Validation Defect**: `plannedActions` are unvalidated at creation time, causing silent plan drops instead of corrective LLM feedback.
3. **Latency & Cost Overhead**: Stack resolution on opponent turns bypasses heuristic deferral and decision caching, resulting in redundant network prompts.
4. **Error Recovery Defect**: JSON parsing errors and HTML responses bypass the corrective retry loop (§7.7 Step 2) due to `classifyError` defaulting to `'fatal'`.

---

## 5. Verification Method

### Test Commands
Run test suite to verify existing component tests:
```bash
npx vitest run packages/server/src/ai/turn-plan.test.ts
npx vitest run packages/server/src/ai/client.test.ts
npx vitest run packages/server/src/ai/provider.test.ts
```

### Direct File Inspection Checklist
1. Inspect `packages/server/src/ai/turn-plan.ts` lines 83-104 to confirm `recordDecision` relies on receiving opponent requests.
2. Inspect `packages/server/src/ai/provider.ts` lines 51-52 to confirm `TurnPlanManager` is private to each provider instance.
3. Inspect `packages/server/src/ai/client.ts` line 195 to confirm greedy `/\{[\s\S]*\}/` regex.
4. Inspect `packages/server/src/ai/retry.ts` line 110 to confirm default `'fatal'` classification.

### Invalidation Conditions
- The `TurnPlanManager` encapsulation finding is invalidated if an engine-level observer or event bus is introduced to broadcast opponent decisions to all active `TurnPlanManager` instances.
- The recovery bypass finding is invalidated if `parseJsonResponse` is moved out of `client.requestDecision` into `provider.ts` after validation.
