# Execution Plan

## Phase 1: Code Inspection & Deep Analysis (Explorers)
- Dispatch 3 `teamwork_preview_explorer` subagents to perform deep inspection on:
  1. Explorer 1: Inspect modified and untracked code in `@mtg/engine`, `@mtg/server`, `@mtg/shared` (git status, diffs, structure, AI decision providers, TurnPlanManager, pre-flight heuristics, JSON parsing, debug logging).
  2. Explorer 2: Focus on Component Interaction Edge Cases:
     - Stale turn plan queues during priority sequence transitions or opponent actions.
     - Target selection mismatch when pre-planned actions require specific target choices.
     - Priority pass loops on opponent turns.
     - Malformed JSON / HTML error response handling from LLM proxies.
  3. Explorer 3: Audit existing unit tests (50 test files, 374+ tests) and check test coverage against recent engine/server changes.

## Phase 2: Automated Verification (Worker)
- Dispatch `teamwork_preview_worker` to:
  - Execute `bun run typecheck` across all workspace packages.
  - Execute `bun run lint` across all workspace packages.
  - Execute `bun run test` (all unit test suites).
  - Report exact pass/fail results, log errors if any, or confirm clean pass.

## Phase 3: Adversarial Verification & Integrity Audit (Challenger & Auditor)
- Dispatch `teamwork_preview_challenger` to stress-test edge case logic and generate test scenarios for turn plan queues, target selection mismatch, priority pass loops, and malformed proxy responses.
- Dispatch `teamwork_preview_auditor` to conduct a forensic integrity audit on the changes.

## Phase 4: Synthesis & Final Audit Report
- Synthesize all findings from Explorers, Worker, Challenger, and Auditor.
- Produce `AUDIT_REPORT.md` detailing implementation safety, edge case resilience, and component interaction guarantees.
