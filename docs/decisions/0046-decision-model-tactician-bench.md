# ADR 0046: Benchmarking decision models as the tactician

Status: Accepted (2026-11-12)

Date: 2026-11-12

Builds on [ADR 0041](0041-jev-placement-and-local-tests.md) (where Jev sits) and
[ADR 0042](0042-engine-backed-tactician-bench-and-judge-bundle.md) (the engine-backed bench).

## Context

The tactician bench (`bot-bench`) measured chat models only: every model entry ran through
`OpenAiDecisionProvider` and the chat completions endpoint. Jev, the one typed decision model the
product already integrates, had one case in the older suite and no measured play quality. Its
registry entry is still `unmeasured`.

Decision models are now a category of their own. OpenRouter's Decisions API serves Jev 1.14 (the
current release; 1.13 is what the product pins), OpenAI GPT-6 Luna Decisions, Google Gemini
Decision 1 (released 2026-11-11), Microsoft Decision-1, Perplexity Decider, Cloudflare Clef,
Liquid d1.1 and others. They take a state plus typed questions and return one choice with
probabilities. They write no text, are billed mostly or only on input, and answer in a few hundred
milliseconds.

The production decision lane (`buildJevActionRequest`, `JevActionPolicy`, `JevClient`) already
takes any model id. Only the bench was chat-only.

A decision model cannot express every tactician decision. One Choice answer cannot declare
several attackers or blockers, divide combat damage, pick X or modes, order triggers or split
mana (`classifyTacticalDecision`). In the 30 cases, 4 of the 19 one-decision cases are attack or
block declarations, and 7 of the 11 whole-turn cases end in an attack declaration.

## Decision

1. **A `decision` lineup entry.** `{ "kind": "decision", "model": "<vendor/model>" }`, or
   `--models decision:<vendor/model>`. It runs through the production decision lane unchanged:
   the compact state without primer or menu, one Choice option per legal action, target expansion
   (`expandTargets`, default on), the answer adapter, then `validateResponse` and the engine.
   Confidence thresholds are zero, so the model's answer is always played. Its confidence and
   top-two margin are recorded beside each answer for later calibration. The key comes from
   `apiKeyEnv`, else `AI_JEV_API_KEY`, else `OPENROUTER_API_KEY`.
2. **Unsupported shapes are never sent.** The entry's `unsupported` setting decides what plays
   them:
   - `bot` (the default) hands them to the heuristic bot, as a live decision-model seat does
     (ADR 0041's `jev` preset), and records the answer with the new source `bot`.
   - `hold` (`decision:<model>@hold`) holds the seat still, so only the model's own answers count.

   A `bot` answer is left out of "legal on first try" and of speed. It is counted on its own
   ("answered by the bot"), flagged on the case, and marked on the grade. The summary adds a
   one-decision accuracy over the model's own answers only. The heuristic baseline in the same run
   plays the same attacks the same way, so a decision model's difference from it is what the model
   added.

3. **Failures are told apart.** A provider that never answered is a `provider error` and counts
   towards stopping the model after three in a row. A refusal or an unusable answer is
   `no legal answer`: billed, scored as no answer, and not a sign of a dead provider. A decision
   settled without any request (a `bot` answer, a production-mode local answer) neither counts
   towards nor resets that streak. Before this change a bot-answered attack reset it, so a dead
   decision model was never stopped.
4. **Judges see what decision models were sent.** In a judge bundle, decision models are
   anonymised candidates like chat models. `PRIMER.md` explains the typed request and the `bot`
   rule. Each case page shows the exact decision request, with the model name left out, or says
   that the decision could not be expressed.
5. **A sweep lineup.** `bot-bench/lineups/decision-sweep.json` holds the heuristic baseline and
   every decision model we could identify. Ids are pinned, not `~typesafe/jev-latest`, so a run is
   reproducible (the Jev plan's rule).

Production defaults do not change. Jev stays off and `unmeasured`. This ADR only adds the
evidence-gathering path the Jev plan's promotion gates ask for.

## Consequences

- One run compares chat and decision models on the same positions: put both kinds in a lineup.
- Whole-turn scores of decision models mix their choices with the bot's attacks. Read them
  against the heuristic baseline and the "own answers only" column, not against chat models
  alone.
- Some models in the sweep may reject the request shape (for example a 255-option menu limit
  that is Jev's, not theirs, or a vendor-specific state format). They fail as provider errors,
  are stopped after three, and are marked in the summary. They cost nothing beyond those calls.
- `:free` decision models return 404 unless the account's OpenRouter privacy settings allow
  training on the request. The sweep's free entry is stopped and marked if so.
- Letting a decision model declare attacks would need several Choice questions per request
  (one per creature) and a legality check of the combined answer. That is a change to the
  production decision lane's V1 contract, and is left for a later ADR if the bench shows decision
  models are worth it.
