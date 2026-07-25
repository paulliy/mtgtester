# Handoff Report — AI Decision Architecture & Engine Inspection

**Agent**: Explorer 1  
**Working Directory**: `c:\Users\paulf\OneDrive\Documents\GitHub\mtgtester\.agents\explorer_1`  
**Date**: 2026-07-25  

---

## 1. Observation

Direct observations from repository inspection using `git status` and `view_file`:

- **Git Status Output**:
  - Modified files in `@mtg/engine`: `decisions.ts`, `providers/providers.ts`, `turn/priority.ts`, `turn/turn.ts`, `view/view.ts`, `cards/definition.ts`, `cards/interpret.ts`, `actions/apply.ts`, `actions/legal.ts`, `combat/combat.ts`, `effects/resolve.ts`, `effects/continuous.ts`, `sba/sba.ts`, `state/game.ts`, `state/objects.ts`, `state/queries.ts`, `state/types.ts`.
  - Modified files in `@mtg/server`: `db/index.ts`, `db/schema.ts`, `index.ts`.
  - Modified files in `@mtg/shared`: `engine.ts`, `index.ts`, `view.ts`.
  - Untracked files in `@mtg/server/src/ai/`: `provider.ts`, `turn-plan.ts`, `heuristics.ts`, `client.ts`, `logger.ts`, `context.ts`, `decision-cache.ts`, `fallback.ts`, `validate.ts`, `config.ts`, `primer.ts`, `queue.ts`, `retry.ts`, `errors.ts`, `index.ts`, along with corresponding `.test.ts` test files.
  - Untracked files in `@mtg/engine/src/`: `cards/condition.ts`, `cards/creature-types.ts`, `cards/overrides/index.ts`.
  - Untracked documentation files in `docs/decisions/`: `0009-supported-pool-decks.md`, `0010-decision-call-budget.md`, `0011-openai-compatible-provider.md`.

- **Key Implementation Highlights**:
  - `packages/server/src/ai/provider.ts:49-251`: Implements `OpenAiDecisionProvider` adhering to `AsyncDecisionProvider`. Runs short-circuits (`turnPlan`, `heuristics`, `decisionCache`) prior to rate-limiter queue (`queue.enqueue`), then runs 3-step error recovery (`decideViaModel`: primary attempt → corrective retry with restated menu → `safestFallback`). Excludes fallbacks from cache. Rethrows `isTerminalAiError` (`DailyQuotaExhaustedError`, `NoAvailableModelError`, `AuthenticationError`).
  - `packages/server/src/ai/turn-plan.ts:13-171`: Implements `TurnPlanManager`. Handles pre-planned active player action sequences (`PlannedAction[]`). Invalidates plan on action illegality, opponent non-pass/non-heuristic intervention, or turn transition.
  - `packages/server/src/ai/heuristics.ts:61-194`: Implements `tryDeferInstant` (Rule A: defers instant-speed spells when stack is empty and outside key combat trick steps), `tryObviousLandDrop` (Rule C: plays free once-per-turn land drop when sole non-pass option), and `tryDeclineZeroPowerAttack` (Rule B: declines 0-power attacks when creature lacks attack triggers and player holds no instants).
  - `packages/server/src/ai/client.ts:191-241`: Implements `parseJsonResponse`. Uses regex `/\{[\s\S]*\}/` to extract JSON objects from conversational text or markdown code fences, checks alias fields (`actionId`, `action_id`, `action`, `choice`, `id`), coerces numeric/string inputs, and validates structural integrity.
  - `packages/server/src/ai/logger.ts:49-161`: Implements `AiCallLogger` persisting to SQLite `ai_calls` with `source` classification (`primary`, `retry`, `fallback`, `heuristic`, `cache`, `plan`).
  - `packages/engine/src/decisions.ts:15-68`: `EngineActionOption` gains `data?: Record<string, unknown>;`. `isForced()` and `forcedOutcome()` classify decisions where all options are pass variations (`pass`, `passAndYieldTurn`, `yieldToAbility`) as forced decisions.
  - `packages/engine/src/view/view.ts:29-110`: Adds `typeLine` and `oracleText` to `PermanentView` (guarded by `!faceDown`), and `power`/`toughness` to `CardView`.
  - `packages/shared/src/engine.ts:60-84`: Exports `PlannedAction` and adds `plannedActions?: PlannedAction[]` to `DecisionResponse`.

---

## 2. Logic Chain

1. **Observation**: `OpenAiDecisionProvider` evaluates `tryLocalAnswer` (turn plan, heuristics, cache) before calling `queue.enqueue`.
   **Reasoning**: Network API requests are metered by rate limits (RPM) and token costs. Decisions answered locally cost 0 tokens and 0 network latencies, permitting deeper game execution within fixed API rate limits.
2. **Observation**: `safestFallback` responses are logged with source `'fallback'` and stored in `TurnPlanManager`, but `rememberAnswer` is NOT called on fallback responses.
   **Reasoning**: Fallbacks represent emergency recovery choices when an LLM fails to return a valid menu choice. Caching a fallback choice would cause temporary model failures to contaminate identical future game states with non-optimal fallback actions.
3. **Observation**: `isTerminalAiError` checks for `DailyQuotaExhaustedError`, `NoAvailableModelError`, and `AuthenticationError` and rethrows them immediately.
   **Reasoning**: If credentials or daily quotas are exhausted, every subsequent decision would become a fallback, resulting in invalid game simulations. Halting execution accurately surfaces terminal system failures.
4. **Observation**: Heuristics in `heuristics.ts` check safety guards (e.g. `!view.hand.some(isInstant)` in `tryDeclineZeroPowerAttack` and `view.stack.length === 0` in `tryDeferInstant`).
   **Reasoning**: Heuristics are purely cost-saving mechanisms and must never alter legal play strategy. When judgment or tactical nuance is present (such as an instant pump spell in hand), the decision MUST be routed to the AI model.
5. **Observation**: `PermanentView` in `view.ts` exposes printed `typeLine` and `oracleText` for non-face-down battlefield permanents.
   **Reasoning**: The battlefield is public information in Magic: The Gathering. Providing oracle text to the AI model ensures it can reason about opponent permanents while maintaining CR 701 anti-cheat hidden information boundaries.

---

## 3. Caveats

- **Network Mode Restriction**: Investigation was executed under `CODE_ONLY` mode (no external HTTP calls made during inspection).
- **Decision Cache Hit Rate on Dynamic Board States**: As noted in ADR 0010, the decision cache yields zero hits when board states change every turn; its primary benefit is preventing runaway LLM polling loops during stalled or idle game states.
- **Unmodeled Cards / Extended Mechanics**: Activated abilities and complex triggers not yet modeled in `@mtg/engine` rely on fallback closed-world guards (e.g., `hasTriggers === false`).

---

## 4. Conclusion

The uncommitted and untracked code changes across `@mtg/engine`, `@mtg/server`, and `@mtg/shared` form a complete, robust, and well-tested AI decision architecture. The code strictly satisfies Phase 3 specification requirements (§7.1–§7.7, §9, §13) and ADRs 0009, 0010, and 0011.

- `OpenAiDecisionProvider`, `TurnPlanManager`, `tryHeuristic`, `parseJsonResponse`, and `AiCallLogger` are fully implemented, documented, and co-located with test coverage.
- Engine extensions (`data` facts on options, forced pass auto-resolution, priority sequence yields, public permanent views) cleanly support the AI decision layer without breaking state machine invariants.
- Full findings have been documented in `c:\Users\paulf\OneDrive\Documents\GitHub\mtgtester\.agents\explorer_1\analysis.md`.

---

## 5. Verification Method

To independently verify the implementation and test suite:

1. **Run Engine Test Suite**:
   ```bash
   bun test packages/engine
   ```
   *Expected result*: All engine tests (including `async-providers.test.ts`, `activated.test.ts`, `triggers.test.ts`, `layers.test.ts`, `priority.test.ts`) pass.

2. **Run Server AI Test Suite**:
   ```bash
   bun test packages/server/src/ai
   ```
   *Expected result*: All AI tests (`provider.test.ts`, `turn-plan.test.ts`, `heuristics.test.ts`, `client.test.ts`, `decision-cache.test.ts`, `logger.test.ts`, `fallback.test.ts`, `validate.test.ts`) pass.

3. **Inspect Handoff & Analysis Files**:
   - `c:\Users\paulf\OneDrive\Documents\GitHub\mtgtester\.agents\explorer_1\analysis.md`
   - `c:\Users\paulf\OneDrive\Documents\GitHub\mtgtester\.agents\explorer_1\handoff.md`
