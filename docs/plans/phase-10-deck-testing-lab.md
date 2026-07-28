# Phase 10 — Deck Testing Lab and Simulation Engine

## Purpose

Phase 10 turns the simulator into a useful Commander deck-testing product. The primary workflow
becomes: choose a deck and a repeatable matchup, state what is being tested, run one interactive
game or many controlled simulations, then inspect evidence that explains the result.

The rules engine remains deterministic and authoritative. Batch simulation is an orchestration
feature, not a shortcut around rules, legality, visibility, or persisted game history.

## Player outcome

A deck builder should be able to answer questions such as:

- Does this list keep enough playable opening hands and hit its early land drops?
- What happens against this pod/archetype mix, and is the result stable across seeds?
- Which cards are cast, stranded, drawn too late, or repeatedly decisive?
- How did the same deck version perform before and after a card swap?
- Which results are trustworthy, which depend on bot strategy, and which are blocked by missing
  card-model coverage?

## Scope and non-goals

In scope:

- saved deck versions, reusable bot pods, test presets, scenario/goldfish tests, headless batch
  runs, test-oriented metrics, and comparison/reporting;
- deterministic/random-bot and AI-bot experiment labeling, including complete accounting of
  compute/API usage;
- preserving enough event and summary data to reproduce any reported result.

Out of scope:

- claiming that a small simulation sample proves a deck's real-world win rate;
- altering the engine's rule authority or using an LLM to adjudicate a card;
- online matchmaking, remote multiplayer, public sharing, or a full in-app deck editor;
- silently simulating a deck with unmodeled required cards.

## Product decisions

1. **A test is a named, reproducible experiment.** It records deck snapshot IDs, opponent pod,
   bot/controller kind and configuration, seed policy, game count, stop policy, engine version,
   coverage state, and metric definitions.
2. **One deck is the subject; a pod is a reusable fixture.** A user should not need four manual
   imports to test their deck. Pods may use saved/imported decks or generated archetype profiles.
3. **Batch runs are headless by default, inspectable on demand.** Store summaries for every game
   and full replay/debug detail for sampled, flagged, or user-pinned games; do not make browser
   playback a bottleneck for batch throughput.
4. **Metrics need context, not false certainty.** Show sample size, seed policy, bot policy,
   unfinished/halted games, confidence interval where appropriate, and direct links to examples.
5. **Coverage is part of test validity.** Preflight exposes blocking cards/mechanics before a
   run. A test is either supported, excluded with specific reasons, or explicitly marked as a
   partial scenario—not quietly substituted.

## Work plan

### 10.1 Create the testing entry point and reusable fixtures

- Add a `Test deck` workspace separate from the normal spectator/player setup. The first choice
  is the subject deck, not four seats.
- Let users select or import a saved deck snapshot, then choose one of: generated balanced pod,
  named generated archetype pod, saved opponent pod, or advanced four-deck configuration.
- Persist deck versions and pod definitions with stable labels. Re-importing creates a new version
  rather than overwriting historical test inputs.
- Add test presets: `Opening hands`, `Goldfish first 6 turns`, `Interactive single game`,
  `Matchup sample`, and `Custom`. Each preset displays the exact controls it fixes.

### 10.2 Make coverage and validity actionable

- Run deck validation and card-model coverage before a test is queued. Present a single summary:
  legal/illegal, modeled/blocked card count, blocking mechanics, commander validity, and whether
  the chosen test/pod can run.
- For a blocked real deck, retain the import and provide a coverage report grouped by mechanic and
  card. Do not discard the deck or send the user to a generic error.
- Add an explicit supported-pool fallback only when the user asks for it, labeled as a proxy deck
  rather than their deck.
- Version the supported-card/model data with each experiment so later coverage changes do not
  rewrite the meaning of an older result.

### 10.3 Add controlled scenarios and goldfishing

- Implement deterministic scenario builders that create legal engine states through normal setup
  and expose their assumptions: opening hand policy, draw sequence/seed, turn limit, mana base,
  opponents, and turn order.
- Start with high-value deck checks: opening-hand/mulligan sampling, first land drop/mana curve,
  first castable turn by mana value, commander cast turn, and goldfish through turn 6/8.
- Let users pin a seed/hand/state and open it in the existing player or spectator replay, never a
  separate approximate simulator.
- Treat scenario-specific objectives as typed predicates over authoritative state/events (for
  example `commanderCastByTurn`, `hasCastSpellOfManaValue`, `assembledNamedPieces`) rather than
  action-log text parsing.

### 10.4 Build batch orchestration responsibly

- Add a server-side experiment runner with bounded concurrency, cancellation, progress events,
  queue position, per-game timeout/error/halt status, and deterministic seed derivation.
- Support random bots for fast reproducible baselines and AI bots as explicitly labelled,
  cost-accounted experiments. Do not combine their results in one unqualified aggregate.
- Define a sampling policy for full persistence: retain every game summary and metrics row; retain
  full event/snapshot/AI detail for user-pinned games, failures/halts, outliers, and a configured
  deterministic sample. Allow a user to opt into retaining all replays.
- Protect the interactive server: batch work must not starve an active player game, exceed model
  rate limits, or hide token/API spend. Pause/resume and cancel are first-class operations.

### 10.5 Record deck-test metrics that explain play patterns

- Extend per-game/per-seat metrics with opening-hand land distribution, mulligans, kept-hand
  playability, land drops by turn, available versus spent mana, first castable/cast turns by mana
  value, commander casts/tax, card draw/cast/discard/exile frequency, and turn/game length.
- Attribute public events to stable card IDs and deck snapshot IDs so repeated copies and renamed
  printings do not merge incorrectly. Aggregate both card-level and category-level results.
- Record interaction outcomes: spells countered/fizzled, removal targets, creatures attacking or
  blocking, commander damage, and the immediate state before/after a card's resolution where it
  is public and meaningful.
- Keep the current flood/drought metrics configurable and display their thresholds with every
  report. Add no opaque score without its raw inputs or definition.

### 10.6 Present results as evidence, not a dashboard dump

- Build a test run page with progress, configuration, validity/coverage banner, summary metrics,
  distributions, and links to representative wins, losses, mulligans, halts, and outliers.
- Provide comparisons between two deck snapshots under the same test preset/pod. Show both the
  absolute values and delta, sample size, seed overlap, unfinished games, and controller policy.
- Add filters by matchup seat/archetype, turn range, draw/play position, game outcome, and cards
  drawn/cast. Every chart/table entry links to the games contributing to it.
- Make result language precise: `in this 100-game random-bot pod` rather than a universal claim.
  Clearly call out when an AI decision model, a small sample, or engine coverage bounds the
  inference.
- Export a self-contained experiment report (JSON first; CSV for tabular aggregates) containing
  configuration, versions, metrics, and replay references.

### 10.7 Persistence, protocol, and observability

- Add `experiments`, `experiment_runs`, `experiment_games`, `pod_snapshots`, and metric-version
  records through an additive migration. Associate existing normal games with an optional
  experiment ID rather than duplicating game data.
- Stream typed progress/result messages over WebSocket; browsers render server-calculated status
  and never reconstruct experiment totals from logs.
- Expose batch queue health, active capacity, API/cost totals, halt/error reasons, retention
  counts, and cancellation state in debug tooling.
- Preserve existing Phase 5 aggregates while allowing users to scope them by experiment, deck
  snapshot, game mode, and controller kind.

## Verification and acceptance

- Determinism tests prove the same experiment configuration and seeds produce byte-identical
  random-bot game outcomes, summaries, and metric rows.
- Contract tests prove tests cannot run with unmodeled required cards, invalid pods, mixed bot
  policies under one aggregate, or missing configuration/version metadata.
- Runner tests cover queue bounds, progress, cancellation, resume, seed derivation, interactive
  game priority, AI accounting/rate limits, failed/halted-game retention, and sampled/full replay
  retention.
- Metric fixtures cover mulligans, land drops, flood/drought, repeated-card identity, commander
  tax, castability, removal, combat, fizzle/counter, and comparison deltas.
- Browser tests cover the one-deck entry flow, coverage report, saved pod selection, a goldfish
  run, a cancellable batch, replaying an outlier, and comparing two deck versions.
- Acceptance: a user can import one supported deck, select a reusable opponent pod, run a named
  100-game random-bot matchup, inspect clear validity-labelled results and representative
  replays, then rerun the same experiment after a deck change and compare the two versions.

## Definition of done

Phase 10 is complete when the app answers deck-testing questions through repeatable,
well-labelled evidence rather than one opaque game, while preserving rule fidelity, reproducible
inputs, controller/cost transparency, and a direct path from any reported metric to the games
that produced it. Finish with ADRs for experiment identity/retention and metric versioning, then
obtain phase-boundary approval before expanding testing scope.
