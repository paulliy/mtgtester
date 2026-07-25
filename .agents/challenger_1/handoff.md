# Hard Handoff Report — Challenger 1

## 1. Observation

Adversarial stress testing and empirical validation were executed against `@mtg/server` and `@mtg/engine` AI decision pipeline components (`TurnPlanManager`, `OpenAiDecisionProvider`, `validateResponse`, `DecisionCache`, `heuristics`, `parseJsonResponse`, `classifyError`).

### Verbatim Code Locations & Evidence:
1. `packages/server/src/ai/provider.ts:52`: `private readonly turnPlan = new TurnPlanManager();` — `TurnPlanManager` is private to each player seat's `OpenAiDecisionProvider`.
2. `packages/server/src/ai/turn-plan.ts:84-104`: `recordDecision` checks `request.decidingPlayer !== request.activePlayer` to set `this.opponentIntervened = true`. Because `providerP1` and `providerP2` are isolated, `providerP1.turnPlan` never observes `P2`'s actions.
3. `packages/server/src/ai/turn-plan.ts:76-81`: `turnPlan` clears queue only on `this.turnNumber !== request.turn || this.activePlayer !== request.activePlayer`. `phase` and `step` are not tracked.
4. `packages/server/src/ai/validate.ts:13-43`: `validateResponse` checks `response.requestId`, `response.actionId`, and `response.targets` for immediate action, but completely ignores `response.plannedActions`.
5. `packages/server/src/ai/turn-plan.ts:155`: `if (planned.name !== undefined && planned.name.length > 0)`. For numeric `planned.name` (e.g. `12345`), `(12345).length` is `undefined`, causing `undefined > 0` to evaluate to `false`, bypassing name matching.
6. `packages/server/src/ai/turn-plan.ts:156, 137`: Non-string `planned.name` with `.length > 0` (e.g. `['a']`) calls `.toLowerCase()`, throwing uncaught `TypeError`. Non-array `planned.targets` calls `.find()`, throwing uncaught `TypeError`.
7. `packages/server/src/ai/heuristics.ts:71`: `if (view.stack.length > 0) return null;` in `tryDeferInstant` disables instant deferral heuristic whenever any spell/ability is on the stack.
8. `packages/server/src/ai/retry.ts:69-111`: `classifyError` falls through to line 110 (`return 'fatal'`) for unhandled errors like `AiResponseValidationError` (thrown on truncated JSON or bad formatting).
9. `packages/server/src/ai/client.ts:195`: `parseJsonResponse` uses greedy regex `raw.match(/\{[\s\S]*\}/)`. Matches preamble `{...}` prior to JSON code fence, breaking `JSON.parse`.

---

## 2. Logic Chain

1. **Per-Seat TurnPlanManager Encapsulation Flaw**:
   - Provider instances are allocated per player seat.
   - When P2 makes a decision, `providerP2.turnPlan.recordDecision` is called, but `providerP1.turnPlan` is untouched.
   - P1's `turnPlan.opponentIntervened` remains `false`.
   - When priority returns to P1, `tryExecutePlan` evaluates `opponentIntervened === false` and executes P1's pre-planned action from queue with 0 model calls, blindly passing priority after P2's intervention.

2. **PlannedActions Creation Bypass & Runtime Crashes**:
   - `validateResponse` returns `null` for invalid `plannedActions`.
   - Creation-time validation and Step 2 Corrective Retry are skipped.
   - Invalid `plannedActions` are stored in `TurnPlanManager.queue`.
   - At execution time, `findMatchingAction` executes unsafe methods (`.toLowerCase()`, `.find()`), throwing uncaught `TypeError` or matching unintended spells.

3. **Stack Resolution Cost Inflation**:
   - Stack > 0 disables `tryDeferInstant`.
   - Every priority step requires decision requests for non-active players with instant spells.
   - Each stack addition/resolution alters `view.stack`, `view.hand`, `view.graveyard`, or `view.availableMana`, resulting in 100% cache invalidation across stack transitions.

4. **JSON Error Recovery Defect**:
   - Truncated JSON or preamble formatting errors throw `AiResponseValidationError`.
   - `classifyError` classifies `AiResponseValidationError` as `'fatal'`.
   - `withRetry` skips network retries, and `provider.decideViaModel` aborts without triggering Step 2 Corrective Retry.
   - `decide()` jumps directly to `safestFallback`.

---

## 3. Caveats

- All findings were empirically verified using mock clients/engine structures in unit tests without requiring real OpenAI API credentials.
- The stack resolution decision volume measurements assume a standard 4-player APNAP priority model as specified by MTG Rules CR 117.

---

## 4. Conclusion

All 4 hypotheses posed in the user request have been **empirically confirmed** and verified by test execution. The AI decision pipeline contains critical architectural flaws regarding `TurnPlanManager` state isolation, `plannedActions` validation, stack resolution cache thrashing, and JSON parse error recovery.

---

## 5. Verification Method

Run the newly created empirical test suite with Vitest:

```bash
cmd /c npx vitest run packages/server/src/ai/challenger-empirical.test.ts
```

All 12 test cases in `packages/server/src/ai/challenger-empirical.test.ts` pass, empirically confirming each failure mode.
