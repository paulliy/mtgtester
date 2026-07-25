# Full Static Verification and Automated Test Results

**Date**: 2026-07-25  
**Repository**: `mtg-commander-sim` (`c:\Users\paulf\OneDrive\Documents\GitHub\mtgtester`)  
**Executed By**: Worker 1  

---

## 1. Typecheck (`bun run typecheck`)

- **Command**: `bun run typecheck` (`tsc --build`)
- **Exit Status**: `0` (Success)
- **Exact Output**:
```
$ tsc --build
```
- **Status**: PASSED — 0 errors, 0 warnings across all workspace packages (`packages/*`, `apps/*`).

---

## 2. Lint (`bun run lint`)

- **Command**: `bun run lint` (`eslint .`)
- **Exit Status**: `0` (Success)
- **Exact Output**:
```
$ eslint .
```
- **Status**: PASSED — 0 lint violations across all workspace packages (`packages/*`, `apps/*`).

---

## 3. Test Suite (`bun run test`)

- **Command**: `bun run test` (`vitest run`)
- **Exit Status**: `0` (Success)
- **Summary**:
  - **Test Files**: 50 passed / 50 total (100%)
  - **Tests**: 374 passed / 374 total (100%)
  - **Failures**: 0
  - **Skipped**: 0
  - **Total Duration**: 3.70s (transform 2.80s, setup 0ms, collect 11.37s, tests 6.15s, environment 10ms, prepare 10.82s)

### Detailed Suite Breakdown (50 Test Files)

| # | Test File | Test Count | Pass / Fail | Duration |
|---|---|---|---|---|
| 1 | `packages/engine/tests/prng.test.ts` | 5 | 5 Pass / 0 Fail | 57ms |
| 2 | `packages/engine/tests/urdragon-coverage.test.ts` | 3 | 3 Pass / 0 Fail | 24ms |
| 3 | `packages/engine/tests/anthems.test.ts` | 11 | 11 Pass / 0 Fail | 21ms |
| 4 | `packages/engine/tests/activated.test.ts` | 11 | 11 Pass / 0 Fail | 29ms |
| 5 | `packages/engine/tests/library.test.ts` | 13 | 13 Pass / 0 Fail | 29ms |
| 6 | `packages/server/src/cards/coverage.test.ts` | 14 | 14 Pass / 0 Fail | 28ms |
| 7 | `packages/engine/tests/priority.test.ts` | 7 | 7 Pass / 0 Fail | 36ms |
| 8 | `packages/engine/tests/triggers.test.ts` | 9 | 9 Pass / 0 Fail | 47ms |
| 9 | `packages/engine/tests/engine.test.ts` | 5 | 5 Pass / 0 Fail | 51ms |
| 10 | `packages/engine/tests/trigger-events.test.ts` | 14 | 14 Pass / 0 Fail | 40ms |
| 11 | `packages/engine/tests/combat.test.ts` | 11 | 11 Pass / 0 Fail | 46ms |
| 12 | `packages/server/src/decks/generate.test.ts` | 10 | 10 Pass / 0 Fail | 33ms |
| 13 | `packages/engine/tests/stack.test.ts` | 3 | 3 Pass / 0 Fail | 24ms |
| 14 | `packages/engine/tests/counters.test.ts` | 6 | 6 Pass / 0 Fail | 22ms |
| 15 | `packages/engine/tests/async-providers.test.ts` | 2 | 2 Pass / 0 Fail | 732ms |
| 16 | `packages/engine/tests/characteristics-source.test.ts` | 2 | 2 Pass / 0 Fail | 20ms |
| 17 | `packages/engine/tests/layers.test.ts` | 8 | 8 Pass / 0 Fail | 22ms |
| 18 | `packages/engine/tests/interpret.test.ts` | 20 | 20 Pass / 0 Fail | 22ms |
| 19 | `packages/engine/tests/permanents.test.ts` | 3 | 3 Pass / 0 Fail | 16ms |
| 20 | `packages/engine/tests/commander.test.ts` | 6 | 6 Pass / 0 Fail | 21ms |
| 21 | `packages/engine/tests/visibility.test.ts` | 4 | 4 Pass / 0 Fail | 18ms |
| 22 | `packages/engine/tests/sba.test.ts` | 14 | 14 Pass / 0 Fail | 25ms |
| 23 | `packages/engine/tests/mana-dynamic.test.ts` | 7 | 7 Pass / 0 Fail | 17ms |
| 24 | `packages/engine/tests/enters-tapped.test.ts` | 8 | 8 Pass / 0 Fail | 18ms |
| 25 | `packages/server/src/ai/provider.test.ts` | 12 | 12 Pass / 0 Fail | 16ms |
| 26 | `packages/engine/tests/abilities-layer6.test.ts` | 3 | 3 Pass / 0 Fail | 15ms |
| 27 | `packages/engine/tests/mulligan.test.ts` | 3 | 3 Pass / 0 Fail | 14ms |
| 28 | `packages/server/src/ai/decision-cache.test.ts` | 17 | 17 Pass / 0 Fail | 9ms |
| 29 | `packages/server/src/ai/client.test.ts` | 8 | 8 Pass / 0 Fail | 13ms |
| 30 | `packages/server/src/ai/retry.test.ts` | 10 | 10 Pass / 0 Fail | 10ms |
| 31 | `packages/server/src/ai/config.test.ts` | 11 | 11 Pass / 0 Fail | 8ms |
| 32 | `packages/engine/tests/overrides.test.ts` | 5 | 5 Pass / 0 Fail | 12ms |
| 33 | `packages/server/src/ai/heuristics.test.ts` | 29 | 29 Pass / 0 Fail | 8ms |
| 34 | `packages/engine/tests/mana.test.ts` | 12 | 12 Pass / 0 Fail | 9ms |
| 35 | `packages/server/src/decks/validate.test.ts` | 10 | 10 Pass / 0 Fail | 11ms |
| 36 | `packages/server/src/ai/context.test.ts` | 7 | 7 Pass / 0 Fail | 7ms |
| 37 | `packages/server/src/ai/logger.test.ts` | 2 | 2 Pass / 0 Fail | 8ms |
| 38 | `packages/server/src/ai/validate.test.ts` | 5 | 5 Pass / 0 Fail | 4ms |
| 39 | `packages/server/src/cards/scryfall.test.ts` | 6 | 6 Pass / 0 Fail | 6ms |
| 40 | `packages/engine/tests/determinism.test.ts` | 2 | 2 Pass / 0 Fail | 1856ms |
| 41 | `packages/server/src/decks/plaintext.test.ts` | 3 | 3 Pass / 0 Fail | 5ms |
| 42 | `packages/shared/src/index.test.ts` | 5 | 5 Pass / 0 Fail | 7ms |
| 43 | `packages/engine/tests/scaffold.test.ts` | 2 | 2 Pass / 0 Fail | 5ms |
| 44 | `packages/server/src/ai/turn-plan.test.ts` | 4 | 4 Pass / 0 Fail | 4ms |
| 45 | `packages/server/src/ai/queue.test.ts` | 2 | 2 Pass / 0 Fail | 5ms |
| 46 | `packages/server/src/ai/fallback.test.ts` | 3 | 3 Pass / 0 Fail | 4ms |
| 47 | `packages/server/src/ai/primer.test.ts` | 4 | 4 Pass / 0 Fail | 4ms |
| 48 | `packages/server/src/decks/banned.test.ts` | 3 | 3 Pass / 0 Fail | 4ms |
| 49 | `packages/server/src/cards/oracle-index.test.ts` | 8 | 8 Pass / 0 Fail | 5ms |
| 50 | `packages/engine/tests/fullgame.test.ts` | 2 | 2 Pass / 0 Fail | 2699ms |

- **TOTALS**: 50 test files passed, 374 unit tests passed out of 374. Exit code 0.

---

## 4. Verification Conclusion

All 3 verification commands (`bun run typecheck`, `bun run lint`, `bun run test`) completed with exit code 0. The codebase passes typescript static checks, eslint checks, and all 374 unit tests across 50 test files cleanly without any failures.
