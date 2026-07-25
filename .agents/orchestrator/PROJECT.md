# Project: MTG Tester Engine & Server Audit

## Architecture
- Workspace packages: `@mtg/engine`, `@mtg/server`, `@mtg/shared`
- AI decision pipeline: `OpenAiDecisionProvider`, `TurnPlanManager`, `tryHeuristic` (`tryDeferInstant`, `tryObviousLandDrop`), `parseJsonResponse`

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Deep Code Inspection & Interaction Edge Cases | `@mtg/engine`, `@mtg/server`, `@mtg/shared` | none | DONE |
| 2 | Automated Static Checks & Unit Testing | Typecheck (0 err), Lint (0 err), 386 unit tests across 51 files | M1 | DONE |
| 3 | Adversarial Stress Testing & Forensic Audit | TurnPlanManager, OpenAiDecisionProvider, heuristics | M2 | DONE |
| 4 | Audit Report Synthesis | Executive audit report & recommendations | M3 | DONE |

## Interface Contracts
- AI decision provider interface `DecisionProvider` (`chooseAction`, `chooseTargets`, `choosePayment`, etc.)
- TurnPlanManager queue management & plan execution API
- Heuristic fallback handlers (`tryDeferInstant`, `tryObviousLandDrop`)
- LLM JSON response parser (`parseJsonResponse`)

## Code Layout
- `packages/engine/` - Card game state engine, priority system, action resolution
- `packages/server/` - Server setup, AI decision integration, proxy endpoints, WS connection
- `packages/shared/` - Shared types, schemas, protocol definitions
