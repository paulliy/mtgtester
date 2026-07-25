# Comprehensive Unit Test Suite Audit & Analysis

**Author**: Explorer 3  
**Date**: 2026-07-25  
**Scope**: `@mtg/engine`, `@mtg/server`, `@mtg/shared` unit test suites (50 test files, 374 tests) and uncommitted changes analysis.

---

## 1. Executive Summary

A comprehensive audit of the test suite across `@mtg/engine`, `@mtg/server`, and `@mtg/shared` was performed using `bun run vitest run`. 
- **Total Test Files**: 50 passed (50 total)
- **Total Tests**: 374 passed (374 total)
- **Total Execution Time**: ~3.99s

While 100% of existing tests pass, our deep audit reveals significant test gaps relative to recent uncommitted engine (+2,000 lines) and server (+1,500 lines) modifications. In particular, complex new subsystems such as natural language card interpretation (`interpret.ts`), AI turn planning (`turn-plan.ts`), AI fallback selection (`fallback.ts`), and combat first-strike resolution (`combat.ts`) have inadequate edge-case test coverage.

---

## 2. Test File Inventory & Package Distribution

The test suite spans **50 test files** distributed across the 3 workspace packages as follows:

| Package | Test Files | Total Tests | Status Breakdown |
|---|---|---|---|
| **`@mtg/engine`** | 29 | 211 | 10 Modified, 9 Untracked, 10 Unmodified |
| **`@mtg/server`** | 20 | 158 | 0 Modified, 15 Untracked, 5 Unmodified |
| **`@mtg/shared`** | 1 | 5 | 0 Modified, 0 Untracked, 1 Unmodified |
| **Total** | **50** | **374** | **10 Modified, 24 Untracked, 16 Unmodified** |

### Complete Breakdown by File

#### `@mtg/engine` (29 files, 211 tests)
1. `packages/engine/tests/abilities-layer6.test.ts` (3 tests) — Layer 6 continuous ability modifications
2. `packages/engine/tests/activated.test.ts` (11 tests) [UNTRACKED] — Activated abilities, tap/mana costs
3. `packages/engine/tests/anthems.test.ts` (11 tests) — Continuous P/T modifying anthem effects
4. `packages/engine/tests/async-providers.test.ts` (2 tests) [UNTRACKED] — Async decision provider integration
5. `packages/engine/tests/characteristics-source.test.ts` (2 tests) — Source characteristic resolution
6. `packages/engine/tests/combat.test.ts` (11 tests) — Combat phase, attack/block declaration, damage sub-steps
7. `packages/engine/tests/commander.test.ts` (6 tests) — Commander tax, zone movement choices, loss rules
8. `packages/engine/tests/counters.test.ts` (6 tests) [UNTRACKED] — +1/+1 and -1/-1 counters, SBA cancellation
9. `packages/engine/tests/determinism.test.ts` (2 tests) — PRNG seed replay determinism
10. `packages/engine/tests/engine.test.ts` (5 tests) — Game initialization and lifecycle
11. `packages/engine/tests/enters-tapped.test.ts` (8 tests) [UNTRACKED] — Permanent replacement ETB effects
12. `packages/engine/tests/fullgame.test.ts` (2 tests) — 4-player full game completion simulation
13. `packages/engine/tests/interpret.test.ts` (20 tests) — Oracle text NLP parser (`interpretCard`)
14. `packages/engine/tests/layers.test.ts` (8 tests) — 7-layer continuous effect resolution
15. `packages/engine/tests/library.test.ts` (13 tests) [UNTRACKED] — Library operations (draw, search, top-N)
16. `packages/engine/tests/mana-dynamic.test.ts` (7 tests) [UNTRACKED] — Dynamic mana costs and cost reductions
17. `packages/engine/tests/mana.test.ts` (12 tests) — Mana pool operations, payment validation
18. `packages/engine/tests/mulligan.test.ts` (3 tests) — London mulligan rule
19. `packages/engine/tests/overrides.test.ts` (5 tests) [UNTRACKED] — Custom card logic overrides
20. `packages/engine/tests/permanents.test.ts` (3 tests) — Battlefield permanent state tracking
21. `packages/engine/tests/priority.test.ts` (7 tests) — Turn priority pass & APNAP queueing
22. `packages/engine/tests/prng.test.ts` (5 tests) — PRNG helper unit tests
23. `packages/engine/tests/sba.test.ts` (14 tests) — State-Based Actions (CR 704)
24. `packages/engine/tests/scaffold.test.ts` (2 tests) — Package interface sanity check
25. `packages/engine/tests/stack.test.ts` (3 tests) — LIFO stack push/pop/resolution
26. `packages/engine/tests/trigger-events.test.ts` (14 tests) [UNTRACKED] — Event listeners (ETB, dies, attack)
27. `packages/engine/tests/triggers.test.ts` (9 tests) — Trigger queueing and stack placement
28. `packages/engine/tests/urdragon-coverage.test.ts` (3 tests) [UNTRACKED] — Card pool mechanics (Ur-Dragon)
29. `packages/engine/tests/visibility.test.ts` (4 tests) — Player view visibility filtering

#### `@mtg/server` (20 files, 158 tests)
1. `packages/server/src/ai/client.test.ts` (8 tests) [UNTRACKED] — OpenAiCompatibleClient & model fallback chain
2. `packages/server/src/ai/config.test.ts` (11 tests) [UNTRACKED] — AI provider environment & vendor configs
3. `packages/server/src/ai/context.test.ts` (7 tests) [UNTRACKED] — LLM prompt context construction
4. `packages/server/src/ai/decision-cache.test.ts` (17 tests) [UNTRACKED] — AI decision cache hashing & lookups
5. `packages/server/src/ai/fallback.test.ts` (3 tests) [UNTRACKED] — Safest action fallback selector
6. `packages/server/src/ai/heuristics.test.ts` (29 tests) [UNTRACKED] — Fast-path pre-flight heuristics
7. `packages/server/src/ai/logger.test.ts` (2 tests) [UNTRACKED] — Decision logging
8. `packages/server/src/ai/primer.test.ts` (4 tests) [UNTRACKED] — System prompt rules primer & token cap
9. `packages/server/src/ai/provider.test.ts` (12 tests) [UNTRACKED] — OpenAiDecisionProvider execution pipeline
10. `packages/server/src/ai/queue.test.ts` (2 tests) [UNTRACKED] — AI request rate limiting & concurrency queue
11. `packages/server/src/ai/retry.test.ts` (10 tests) [UNTRACKED] — Exponential backoff retry logic
12. `packages/server/src/ai/turn-plan.test.ts` (4 tests) [UNTRACKED] — TurnPlanManager multi-step turn execution
13. `packages/server/src/ai/validate.test.ts` (5 tests) [UNTRACKED] — LLM JSON response payload validation
14. `packages/server/src/cards/coverage.test.ts` (14 tests) [UNTRACKED] — Deck card modeling coverage validator
15. `packages/server/src/cards/oracle-index.test.ts` (8 tests) — Scryfall oracle name lookup & normalization
16. `packages/server/src/cards/scryfall.test.ts` (6 tests) — Scryfall JSON card projection
17. `packages/server/src/decks/banned.test.ts` (3 tests) — Commander ban list markdown parser
18. `packages/server/src/decks/generate.test.ts` (10 tests) [UNTRACKED] — Commander deck generator (CR 903.5)
19. `packages/server/src/decks/plaintext.test.ts` (3 tests) — Plaintext decklist parser
20. `packages/server/src/decks/validate.test.ts` (10 tests) — Commander deck validation rules

#### `@mtg/shared` (1 file, 5 tests)
1. `packages/shared/src/index.test.ts` (5 tests) — Enums, colors, phases, and decision contracts

---

## 3. Analysis of Test Coverage Relative to Uncommitted Changes

Significant source code changes exist in the workspace that are uncommitted. The matrix below compares the size and risk of uncommitted source code modifications with the depth of corresponding unit tests:

| Module / Path | Source Lines Modified / Added | Test Files & Count | Coverage Evaluation & Gaps |
|---|---|---|---|
| `packages/engine/src/cards/interpret.ts` | **+901 lines** | `interpret.test.ts` (20 tests) | **CRITICAL GAP**: Only 20 unit tests for a 1,200+ line NLP parser handling complex oracle text grammar (modal choices, conditional clauses, search destinations, target filters). |
| `packages/engine/src/effects/resolve.ts` | **+401 lines** | `library.test.ts` (13 tests), `counters.test.ts` (6 tests) | **MODERATE GAP**: Added library searching and top-N card looking, but failed search queries, empty library cases, and multi-destination searches are untested. |
| `packages/engine/src/actions/apply.ts` & `legal.ts` | **+326 lines** | `priority.test.ts` (7 tests), `activated.test.ts` (11 tests) | **HIGH GAP**: Legal action generation and priority execution added new target choice formats, but execution-time legality failures are untested. |
| `packages/engine/src/combat/combat.ts` | **+208 lines** | `combat.test.ts` (11 tests) | **MODERATE GAP**: Added first-strike damage sub-steps and blocker validation, but mid-combat gain/loss of first strike and trample over multiple blockers are untested. |
| `packages/server/src/ai/turn-plan.ts` | **+120 lines** (Untracked) | `turn-plan.test.ts` (4 tests) | **CRITICAL GAP**: Only 4 tests for pre-planned multi-step turn execution. Does not test plan invalidation during opponent priority passes vs actions, or target invalidation mid-plan. |
| `packages/server/src/ai/fallback.ts` | **+80 lines** (Untracked) | `fallback.test.ts` (3 tests) | **HIGH GAP**: Only 3 tests for emergency AI fallback selection. Does not test mandatory choice menus where priority pass or decline effect is unavailable. |
| `packages/server/src/ai/client.ts` & `provider.ts` | **+350 lines** (Untracked) | `client.test.ts` (8 tests), `provider.test.ts` (12 tests) | **MODERATE GAP**: AI provider error handling omits tests for malformed HTML HTTP error responses (502 Bad Gateway) and truncated JSON payloads. |

---

## 4. Missing Test Scenarios & Untested Edge Cases

### A. Engine Edge Cases
1. **Target Legality at Execution vs Selection**:
   - Spells/abilities cast with valid targets that become invalid before resolution (e.g. target creature gains Hexproof or leaves battlefield). The engine must fizzle the effect, but current tests only check resolution with valid targets.
2. **First-Strike Transition Edge Cases**:
   - A creature gaining or losing `First Strike` or `Double Strike` after the first-strike damage sub-step has already executed.
3. **Complex Library Search Gaps**:
   - Searching a library when 0 cards match the filter criteria (declining or failing to find).
   - Searching a library with fewer cards than requested.
4. **Counter Cancellation SBAs**:
   - Placing +1/+1 and -1/-1 counters on a permanent simultaneously in amounts that cancel out (CR 704.5q), specifically verifying that ETB triggers evaluate state prior to counter cancellation.
5. **APNAP Trigger Queueing Order**:
   - Multiple triggers firing simultaneously for Active Player and Non-Active Players during phase transitions.

### B. Server & AI Edge Cases
1. **Turn Plan Invalidation Flaws**:
   - `turn-plan.test.ts` has 4 tests. It does not test when opponent priority passes via instant-speed decision (e.g. opponent receives priority, chooses `PASS`). The plan should remain valid, but if opponent casts an instant, the plan must invalidate.
2. **Fallback Selector in Mandatory Menus**:
   - `fallback.test.ts` (3 tests) only tests menus containing `PASS_PRIORITY` or `DECLINE_EFFECT`. If the AI is presented with a mandatory choice menu (e.g. "Sacrifice a creature" or "Choose a target player"), neither option is present. The fallback behavior in mandatory menus is untested.
3. **Malformed LLM Responses**:
   - `client.test.ts` tests mock JSON responses. It does NOT test HTML proxy error pages (e.g. Cloudflare / Nginx 502/504 Bad Gateway responses returning `<html>...</html>`), truncated JSON string responses, or extra text surrounding JSON blocks.
4. **Rate Limit / Queue Exception Handling**:
   - `queue.test.ts` (2 tests) does not test queue behavior when an asynchronous task throws an unhandled exception or times out.

---

## 5. Test Suite Fragility & Debt

1. **Slow Integration Tests in Unit Suite**:
   - `fullgame.test.ts` (2 tests) takes **~2.88s** to execute.
   - `determinism.test.ts` (2 tests) takes **~2.03s** to execute.
   - These 2 test files account for **70%+ of total test duration** (4.9s out of 6.8s execution time). They run full random game loops that can fluctuate in duration and hide subtle regressions.
2. **Stderr Noise During Test Runs**:
   - `client.test.ts` and `provider.test.ts` output numerous `stderr` warning messages during standard test execution (e.g., `⚠ P1 decision req-1 failed (HTTP 400)`, `⚠ model-a hit RPM — falling back to model-b`). Expected error warnings in unit tests should be silenced using mock loggers.
3. **Untracked Test Files (Git Hygiene)**:
   - **24 out of 50 test files (48%)** are untracked in git. This creates risk of uncommitted test regression or accidental omission during commits.
4. **Hardcoded Option Index Dependencies**:
   - Tests in `heuristics.test.ts` and `turn-plan.test.ts` reference explicit action index numbers in legal menu arrays. If action menu ordering changes in `packages/engine/src/actions/legal.ts`, multiple server tests will fail fragilely.

---

## 6. Actionable Recommendations for Test Suite Hardening

1. **Expand `interpret.test.ts`**: Add 25+ targeted test cases for complex oracle text patterns, including conditional triggers, modal effects, search filter clauses, and cost reductions.
2. **Add Mandated Fallback Test**: Add tests in `fallback.test.ts` for mandatory choice menus (where pass/decline are absent).
3. **Add HTML & Truncated Response Tests**: Add tests in `client.test.ts` / `provider.test.ts` for 502 HTML responses and truncated JSON.
4. **Add Turn Plan Opponent Pass vs Action Test**: Expand `turn-plan.test.ts` to test opponent priority pass vs opponent spell cast.
5. **Silence Test Stderr Output**: Suppress expected warning logs in `client.test.ts` and `provider.test.ts` tests using `vi.spyOn(console, 'warn').mockImplementation(() => {})`.
6. **Track Untracked Test Files**: Stage and commit all 24 untracked test files to ensure baseline test suite stability.
