# Original User Request

## Initial Request — 2026-07-25T20:59:49Z

<USER_REQUEST>
Comprehensive audit of all uncommitted code changes in `@mtg/engine`, `@mtg/server`, and `@mtg/shared` to identify implementation flaws, edge cases, and poor component interactions.

Working directory: c:\Users\paulf\OneDrive\Documents\GitHub\mtgtester
Integrity mode: development

## Requirements

### R1. Deep Inspection of Uncommitted Engine and Server AI Changes
Review all modified and untracked code across `@mtg/engine`, `@mtg/server`, and `@mtg/shared`. Focus on AI decision providers, TurnPlanManager, pre-flight heuristics, JSON response parsing, and debug logging.

### R2. Component Interaction & Edge Case Analysis
Analyze how `TurnPlanManager`, `OpenAiDecisionProvider`, `tryHeuristic` (`tryDeferInstant`, `tryObviousLandDrop`), and `parseJsonResponse` interact. Check for:
- Stale turn plan queues during priority sequence transitions or opponent actions.
- Target selection mismatch when pre-planned actions require specific target choices.
- Priority pass loops on opponent turns.
- Malformed JSON / HTML error response handling from LLM proxies.

### R3. Automated & Verification Testing
Ensure all static checks (`bun run typecheck`, `bun run lint`) and unit test suites (`bun run test`) pass with 100% success rate across all 50 test files.

## Acceptance Criteria

### Implementation Quality & Verification
- [ ] `bun run typecheck` produces 0 errors across all workspace packages.
- [ ] `bun run lint` produces 0 ESLint warnings/errors.
- [ ] `bun run test` passes all 374+ unit tests cleanly across 50 test files.
- [ ] A written audit report detailing implementation safety, edge case resilience, and component interaction guarantees.
</USER_REQUEST>
