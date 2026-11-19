# 0042 — Engine-backed tactician benchmark with a judge bundle, and one primer catalog

Date: 2026-11-10

Status: Accepted (2026-11-10)

## Context

ADR 0026 gave the project frozen snapshot fixtures: a serialized `PlayerView`, a legal menu and an
optional gold label, scored without running the engine. That design is right for prompt and
context regressions, where the input must not move. It does not answer the questions that come up
when choosing a tactician model:

- What does each legal answer actually lead to? A gold label says which answer is acceptable; it
  does not show that the other block loses the game.
- Can the model play a whole turn? Land, spell, attack, pump and damage assignment are separate
  decisions, and a snapshot covers one.
- Is the model worth its latency and its bill? `core-fast` holds one tactical case, so its timing
  and cost samples are one call.
- How do several independent reviewers compare the candidates? Promotion (ADR 0028) is a numeric
  gate; there was no artifact a person or a judge model could read.

The primers had also drifted. Each live fragment was a separate constant, the order/value fragment
told the model to return `modes`, `xValue` and `order`, which `parseJsonResponse` never reads, and
a benchmark that wanted to show "the instructions the model received" had no way to list them
without copying text.

## Decision

1. A second benchmark, `bot-bench/`, sits beside `benchmarks/` rather than inside it. It holds
   cases, lineups, judge documents and the harness source; ADR 0026's fixtures, hashes and path
   rules are untouched. It tests the tactician; strategist cases are reserved.
2. A case arranges a position with the engine's own scenario format (`CardScenario`,
   `buildCardScenario`), scripts play up to the decision under test, and names the tested seat.
   `single` cases test one decision. `turn` cases test every decision of the seat's turn. Nothing
   longer than a turn is in scope.
3. The reference is investigated with the engine. For a `single` case every legal answer is played
   out and recorded beside its reviewed grade (`best`, `good`, `weak`, `blunder`). For a `turn`
   case reviewed lines are replayed and the final state is checked against weighted objectives.
   `verifyCase` fails a case whose reference the engine no longer supports, and runs in the suite.
4. A model plays through `OpenAiDecisionProvider` itself, with the strategist, the decision cache
   and (in the default `raw` mode) local heuristics off. Prompt assembly, primer, parser,
   validator, corrective retry and heuristic fallback are the production ones. An answer the model
   never legally produced scores nothing on a `single` case even when the fallback bot found the
   right play.
5. Other seats are the heuristic bot plus scripted replies. After the one decision of a `single`
   case the tested seat holds still unless the case says otherwise, so the recorded consequence
   is that decision's alone.
6. Results are reported in three groups that are never combined: accuracy (with reliability),
   speed, and cost with its provenance (`reported`, `estimated`, `unknown`, `free`).
7. A run writes a self-contained ZIP for judges: brief and rubric, primer, summary, a page per
   case and per model, a scorecard template and schema, and the raw data. Judges score accuracy,
   speed and cost separately from 0 to 10, give an overall recommendation and a blurb, and may
   dispute a reference grade. Candidate models are anonymised in the bundle by default; the key
   stays beside the ZIP.
8. Live primer sections are defined once in a catalog in `ai/primer.ts`. `tacticianPrimerFor`
   assembles from it, `primerCatalog()` exposes it, and the bundle renders it at build time. The
   frozen pre-split primer (`RULES_PRIMER`) keeps its bytes for the `legacy-v1` variant.
9. The live primers were rewritten against the parser and the wire types. The common primer now
   names the payload keys and asks for a lethal check first; the attack and block sections say
   when not to attack and when to chump; the order/value section says that each option is a
   complete choice picked by `actionId`. `AI_VERSIONS.tacticianPrimer` and `.strategistPrimer`
   are bumped to `v3`.

## Consequences

- A change to a primer, the prompt assembler or the provider changes the next benchmark run and
  the next bundle with no edit in `bot-bench/`.
- A change to the engine, a card or the heuristic bot can change what a position leads to. The
  suite reports it as a failed reference instead of a silently different benchmark.
- The rewritten common primer is about 60 tokens longer than the one it replaces, and the attack
  and block sections about 75 each. The change is not yet measured against live models: no
  provider key is available to CI, and the first lineup run is the measurement.
- Thirty positions (twelve at first, eighteen added later, six of the added ones failed by the
  heuristic bot) screen for board-reading failures; they do not rank two strong models with
  confidence. The set grows from real misplays.
- Positions have no commanders, because the scenario format arranges none.
- The fast CI lane runs `bot-bench/src` and `primer.test.ts` (about 25 seconds, no network).
