# MTG Tester contributor guide

## Start here

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md) before changing game behavior. It is the original product and architecture brief, frozen as the v1 spec; where it disagrees with an ADR, the ADR wins. The ADRs most relevant to current work are [0025 card templates](docs/decisions/0025-card-template-layer.md), [0024 bounded combat search](docs/decisions/0024-bounded-combat-search.md), and, for the LLM provider, [0026](docs/decisions/0026-ai-benchmark-and-strategy-context.md) through [0028](docs/decisions/0028-ai-counterfactual-routing-cache-and-promotion.md). [docs/reviews/](docs/reviews/) holds the evidence behind the current quality state.

Current work is organized around card coverage, rules correctness, simulation reliability, and product polish. The numbered phase plans in `docs/plans/` are historical records.

## Working with subagents

Use GPT-6 Luna subagents for bounded work that can proceed independently from the main thread. They are most useful for read-only search and triage, such as locating where a card or mechanic is implemented, tracing call paths, checking fixtures and snapshots, summarizing command output, or comparing coverage lists. They can also handle clearly specified mechanical edits when the task does not require deciding rules correctness.

- Choose the `gpt-6-luna` model for these subagents. Use high reasoning for tightly defined implementation or medium for multi-file tracing; use low reasoning for straightforward searches and summaries.
- Give each subagent one concrete deliverable, the relevant paths, a completion boundary, and any command or file-count limit. Prefer independent questions that do not require agents to edit the same files.
- Ask search agents to use `rg` before opening files, inspect only relevant ranges, stop after about 15 files, and report any remaining scope if the limit is reached.
- Ask for concise findings, ideally `path:line - finding`, with no more than about 15 bullets. For long command output, have the agent save it to a scratch file and return the path plus a filtered summary.
- Keep approach selection, ambiguous Oracle interpretation, rules-correctness decisions in `packages/engine`, and final review of subagent output on the main thread.
- Treat subagent reports as leads, not verification. Independently inspect changes and run the relevant command before claiming a card is modeled or a check passes.
- Do not delegate conflicting edits to multiple agents. Assign disjoint files or use read-only parallel tasks, then integrate and review the results on the main thread.

## Where to find everything else

Read these only when the task needs them:

- **Before changing engine, bot, or provider code:** [rules-engine constraints](docs/guides/rules-engine-constraints.md)
- **Package overview, audit residual risks:** [current state](docs/guides/current-state.md)
- **Modeling or auditing cards, template layer, snapshots, coverage backlog:** [card coverage workflow](docs/guides/card-coverage-workflow.md)
- **Test requirements and change discipline:** [testing discipline](docs/guides/testing-discipline.md)
- **All `bun` and PowerShell commands:** [project commands](docs/guides/project-commands.md)
- **Rules, banned list, and Scryfall data files:** [reference data](docs/guides/reference-data.md)

