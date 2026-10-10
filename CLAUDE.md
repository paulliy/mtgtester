# MTG Tester contributor guide

## Start here

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md) before changing game behavior. It is the original product and architecture brief, frozen as the v1 spec; where it disagrees with an ADR, the ADR wins. The ADRs most relevant to current work are [0025 card templates](docs/decisions/0025-card-template-layer.md), [0024 bounded combat search](docs/decisions/0024-bounded-combat-search.md), and, for the LLM provider, [0026](docs/decisions/0026-ai-benchmark-and-strategy-context.md) through [0028](docs/decisions/0028-ai-counterfactual-routing-cache-and-promotion.md). [docs/reviews/](docs/reviews/) holds the evidence behind the current quality state.

Current work is organized around card coverage, rules correctness, simulation reliability, and product polish. The numbered phase plans in `docs/plans/` are historical records.

## Working with subagents

Subagents run on Sonnet or Haiku only. Never spawn one on Opus. The main thread stays on Opus.

- **Haiku** (`explorer`): read-only search and triage. Locating where a card, mechanic, or coverage entry lives, tracing call paths, checking fixtures and snapshots, running tests and reading output, comparing card lists against coverage reports.
- **Sonnet** (`implementer`): bounded implementation. Behavior tests from an existing clause-to-test manifest, mechanical refactors across several files, snapshot updates after an intentional change, and diff review against a written checklist (`reviewer`).
- **Main thread (Opus)**: choosing an approach, resolving ambiguous Oracue text, anything deciding rules correctness in `packages/engine`, and final review of subagent output before reporting it done.

Delegate when a task would read many files or produce output the main thread doesn't need. Do small lookups inline.

Limits (prompt rules):

- Haiku tasks: one bounded question with a known search area, e.g. "find where `Ward` is handled in `packages/engine/src/cards/`". No open-ended surveys.
- Grep before reading, read only matching ranges, stop after about 15 files, and report what remains if the limit is hit.
- Returns: at most about 15 bullets, each `path:line - finding`.
- Long output (tests, coverage, logs): write to the scratchpad, return the path and a summary.

Read these only when the task needs them:

- **Before changing engine, bot, or provider code:** [rules-engine constraints](docs/guides/rules-engine-constraints.md)
- **Package overview, audit residual risks:** [current state](docs/guides/current-state.md)
- **Modeling or auditing cards, template layer, snapshots, coverage backlog:** [card coverage workflow](docs/guides/card-coverage-workflow.md)
- **Test requirements and change discipline:** [testing discipline](docs/guides/testing-discipline.md)
- **All `bun` and PowerShell commands:** [project commands](docs/guides/project-commands.md)
- **Rules, banned list, and Scryfall data files:** [reference data](docs/guides/reference-data.md)
