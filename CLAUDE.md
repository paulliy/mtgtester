# MTG Tester contributor guide

## Start here

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md) before changing game behavior. It is the original product and architecture brief, frozen as the v1 spec; where it disagrees with an ADR, the ADR wins. The ADRs most relevant to current work are [0025 card templates](docs/decisions/0025-card-template-layer.md), [0024 bounded combat search](docs/decisions/0024-bounded-combat-search.md), and, for the LLM provider, [0026](docs/decisions/0026-ai-benchmark-and-strategy-context.md) through [0028](docs/decisions/0028-ai-counterfactual-routing-cache-and-promotion.md). [docs/reviews/](docs/reviews/) holds the evidence behind the current quality state.

Current work is organized around card coverage, rules correctness, simulation reliability, and product polish. The numbered phase plans in `docs/plans/` are historical records.

## Working with subagents

Delegate to subagents by default. Use them more often than not for work that is separable from the main decision, so the main thread stays focused and cheaper to run.

- **Haiku** for read-only search and triage: locating where a card, mechanic, or coverage entry lives; tracing call paths; checking fixture and snapshot files; summarizing test, lint, or coverage output; comparing a list of cards against the coverage reports.
- **Sonnet** for bounded implementation: writing behavior tests from an existing clause-to-test manifest, mechanical refactors across several files, updating a snapshot after an intentional change, and reviewing a diff against a written checklist.
- **Stay on the main thread** for choosing an approach, resolving ambiguous Oracle text, anything that decides rules correctness in `packages/engine`, and the final review of subagent output before it is reported as done.

Limits for this repo (no enforced per-agent token cap, so these are prompt rules):

- Haiku tasks: one bounded question with a known search area, e.g. "find where `Ward` is handled in `packages/engine/src/cards/`". No open-ended surveys.
- Budget in the prompt: grep before reading, read only matching ranges, stop after about 15 files, and report what remains if the limit is hit.
- Returns: at most about 15 bullets, each `path:line - finding`.
- Long output (tests, coverage, logs): write it to the scratchpad and return the path plus a summary. Filter with `rtk err`, `tail`, or `rtk summary` first.
- Read-only search agents get no `Bash`.
- Verify any subagent claim that a card is modeled or a test passes by running the relevant command yourself.

## Where to find everything else

Read these only when the task needs them:

- **Before changing engine, bot, or provider code:** [rules-engine constraints](docs/guides/rules-engine-constraints.md)
- **Package overview, audit residual risks:** [current state](docs/guides/current-state.md)
- **Modeling or auditing cards, template layer, snapshots, coverage backlog:** [card coverage workflow](docs/guides/card-coverage-workflow.md)
- **Test requirements and change discipline:** [testing discipline](docs/guides/testing-discipline.md)
- **All `bun` and PowerShell commands:** [project commands](docs/guides/project-commands.md)
- **Rules, banned list, and Scryfall data files:** [reference data](docs/guides/reference-data.md)
