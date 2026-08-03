# Project: MTG Server Two-Tier AI Strategist/Tactician Hardening

## Overview
Refactor, debug, and strengthen test coverage for the two-tier AI strategist/tactician system in the `@mtg/server` package, addressing race conditions, queue expiration resynchronization, strategy invalidation across active player deviations, and automated verification.

## Architecture
- Module: `@mtg/server` (`packages/server/src/ai/`)
- Core Components:
  - `StrategyCoordinator` (`packages/server/src/ai/strategy-coordinator.ts`): Orchestrates async prefetching, strategist execution, strategy cache management, and tactician context assembly.
  - `TurnPlanManager` (`packages/server/src/ai/turn-plan.ts`): Manages turn plan queues, step execution matching, step expiration, and plan invalidation state.
- Test Specs:
  - `packages/server/src/ai/strategy-coordinator.test.ts`
  - `packages/server/src/ai/turn-plan.test.ts`

## Code Layout
- Implementation: `packages/server/src/ai/`
- Tests: `packages/server/src/ai/`
- Documentation: `docs/decisions/0016-two-tier-ai-planning.md`

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | R1: Async Strategist Stale Plan Fix | Remedy race conditions in `StrategyCoordinator.runStrategist` when delayed strategist calls (20–60s) complete over advanced/diverged board state. | None | DONE |
| M2 | R2: Turn Plan Queue Expiration Resync | Fix `TurnPlanManager.tryExecutePlan` to continuously evaluate queue items after discarded/expired steps. | M1 | DONE |
| M3 | R3: Strategy Invalidation Synchronization | Ensure `StrategyCoordinator.strategy` and `TurnPlanManager` remain strictly in sync on active player/game state deviations. | M1, M2 | DONE |
| M4 | R4: E2E Verification & Test Suite Hardening | Add unit and integration tests in `strategy-coordinator.test.ts` and `turn-plan.test.ts` and verify clean 100% test pass. | M1, M2, M3 | DONE |

## Interface Contracts
### `StrategyCoordinator` ↔ `TurnPlanManager`
- `StrategyCoordinator.runStrategist()` must validate current game state / turn / active player before installing completed async plans.
- `StrategyCoordinator.strategy` getter/setter must invalidate atomically when `TurnPlanManager` plan is invalidated or active player changes.
- `TurnPlanManager.tryExecutePlan()` must loop through expired/invalid steps until finding a valid step for the current phase/decision or returning null when empty.
