# MTG Tester contributor guide

This is the one guide for every coding agent and person working in this repository. Claude Code reads it through `CLAUDE.md`; Codex and other agents read this file directly.

## Start here

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md) before changing game behavior. It is the original product and architecture brief, frozen as the v1 spec; where it disagrees with an ADR, the ADR wins. [docs/decisions/README.md](docs/decisions/README.md) lists every ADR with its status and what replaced it, and names the few to read first. The ADRs most relevant to current work are [0025 card templates](docs/decisions/0025-card-template-layer.md), [0024 bounded combat search](docs/decisions/0024-bounded-combat-search.md), and, for the LLM provider, [0026](docs/decisions/0026-ai-benchmark-and-strategy-context.md) through [0028](docs/decisions/0028-ai-counterfactual-routing-cache-and-promotion.md). [docs/reviews/](docs/reviews/) holds the evidence behind the current quality state.

Current work is organized around card coverage, rules correctness, simulation reliability, and product polish. The numbered phase plans in `docs/plans/` are historical records; [docs/plans/README.md](docs/plans/README.md) says which files there are still read by code.

## Card modeling standard

For every card-modeling change, the sole completion standard is [card modeling and testing](docs/guides/card-modeling-and-testing.md). Follow its pinned-Oracle, clause mapping, positive and negative engine scenarios, normal cast/activation path, real-viewer evidence, and separate gameplay-AI evidence requirements. `modeled: true`, snapshots, deck membership, aggregate coverage, mocked UI checks, and written completion claims are not proof.

Unsupported mechanics must remain explicit with `unimplemented()` or `unsupportedCard()` until implemented faithfully. Never substitute a mana cost, target, event, or `noOp` for unsupported rules behavior.

## Models and subagents

Who plans and who implements:

- **High-risk or high-effort work** is planned by Claude Fable. Easier work is planned by Claude Opus. Once a plan is ready, each task is implemented in its own session or thread.
- **The main thread** runs on Claude Opus in Claude Code. In any tool, it owns choosing an approach, resolving ambiguous Oracle text, anything deciding rules correctness in `packages/engine`, and final review of subagent output before reporting it done.
- **Subagents** run on smaller models only. Never spawn one on Opus or Fable.

| Role                 | Claude Code                                        | Codex                          | Use it for                                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explorer (read-only) | Haiku (`explorer`)                                 | `gpt-6-luna`, low reasoning    | Locating where a card, mechanic, or coverage entry lives, tracing call paths, checking fixtures and snapshots, running tests and reading output, comparing card lists against coverage reports.                                                                                                           |
| Implementer          | Sonnet (`implementer`)                             | `gpt-6-luna`, high reasoning   | Behavior tests from an existing clause-to-test manifest, mechanical refactors across several files, snapshot updates after an intentional change.                                                                                                                                                         |
| Reviewer             | Sonnet (`reviewer`)                                | `gpt-6-luna`, medium reasoning | Diff review against a written checklist, multi-file tracing.                                                                                                                                                                                                                                              |
| Card compiler worker | Haiku (`card-compile-worker`, `card-judge-worker`) | —                              | Answering the batch card compiler's prompt files, one stage per worker. The answers are data that the engine's validator and the compiler's checks gate ([ADR 0047](docs/decisions/0047-compiled-cards-as-unreviewed-overrides.md)); these workers read only their prompts and never edit the repository. |

The Claude Code agents are defined in `.claude/agents/`. Delegate when a task would read many files or produce output the main thread doesn't need. Do small lookups inline.

Limits (prompt rules):

- Give each subagent one concrete deliverable, the relevant paths, a completion boundary, and any command or file-count limit. Explorer tasks are one bounded question with a known search area, e.g. "find where `Ward` is handled in `packages/engine/src/cards/`". No open-ended surveys.
- Grep (`rg`) before reading, read only matching ranges, stop after about 15 files, and report what remains if the limit is hit.
- Returns: at most about 15 bullets, each `path:line - finding`.
- Long output (tests, coverage, logs): write to a scratch file, return the path and a filtered summary.
- Do not delegate conflicting edits to several agents. Assign disjoint files or use read-only parallel tasks, then integrate on the main thread.
- Treat subagent reports as leads, not verification. Inspect changes and run the relevant command yourself before claiming a card is modeled or a check passes.

## Performance and cost work (hill climbing)

Measure, change, compare, and keep only real wins. `bun run hill-climb` reports engine CPU, game setup time, model calls and tokens per turn, and card coverage, and proves the benchmark games played the same through their fingerprints. The full guide is `docs/guides/hill-climbing.md`.

1. On the base commit: `bun run hill-climb --repeat 3 --save <scratch>/before.json`.
2. Make one change.
3. `bun run hill-climb --repeat 3 --against <scratch>/before.json`.
4. Keep the change only if the table shows `IMPROVED` on the target metric, no `REGRESSED` row, and every fingerprint identical. For engine CPU, the exact `engine.work.*` counters (layer passes, state copies, mana planner states) prove a win the noisy timings cannot. `UNCHANGED` means the change is inside the noise: drop it.
5. Paste the table in the pull request, then bank the win with `bun run hill-climb --write-baseline`.

Never rewrite the baseline to make a regression pass. A change meant to alter play passes `--allow-behavior-change` and says so in the pull request.

## Where to find everything else

Read these only when the task needs them:

- **Before changing engine, bot, or provider code:** [rules-engine constraints](docs/guides/rules-engine-constraints.md)
- **Performance or cost work:** [hill climbing](docs/guides/hill-climbing.md)
- **Package overview, audit residual risks:** [current state](docs/guides/current-state.md)
- **Modeling or auditing cards, template layer, snapshots, coverage backlog:** [card coverage workflow](docs/guides/card-coverage-workflow.md)
- **Batch-compiling cards with Haiku workers, promoting or retiring a compiled card:** [batch card compiler](scripts/card-compiler/README.md) and the [campaign plan](docs/plans/batch-card-compile-campaign.md)
- **Test requirements and change discipline:** [testing discipline](docs/guides/testing-discipline.md)
- **All `bun` and PowerShell commands:** [project commands](docs/guides/project-commands.md)
- **Rules, banned list, and Scryfall data files:** [reference data](docs/guides/reference-data.md)
- **Adding or changing an ADR:** [decisions index](docs/decisions/README.md); run `bun run adr:index` after any status change.
