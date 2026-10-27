# Plan: faster card authoring and fail-loud execution

Status: Proposed. Baseline: `8b93725` (2026-10-27).

Implements [ADR 0031](../decisions/0031-forge-informed-card-authoring.md) (faster card authoring)
and [ADR 0032](../decisions/0032-fail-loud-execution-and-strict-tests.md) (fail-loud execution and
strict tests). The evidence behind both is in the
[Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

## Goals

1. A card whose clauses are keywords or compositions of existing primitives needs no engine change.
2. A card that needs a new primitive needs one module and its contract.
3. A wrong reference, a dropped parsed ability, an out-of-range answer, a guessed test decision, a
   clause no test executed, and corrupt state each fail loudly at the line responsible.
4. New tests are strict and come from one scenario format that also yields the viewer scenario.

## Constraints

These hold in every phase, and every phase's exit checks them.

- The [card modeling guide](../guides/card-modeling-and-testing.md) stays the completion standard.
  Nothing here replaces a manifest clause, a normal-path engine scenario or viewer evidence.
- The [rules-engine constraints](../guides/rules-engine-constraints.md) hold: the engine stays free of
  I/O and provider policy, games stay seeded, and `PlayerView` stays the privacy boundary.
- Fixed-seed replay, the game event log, the persisted debug log and AI benchmark inputs do not
  change unless a phase says so and says why. Diagnostics and invariants run only in tests and tools.
- A refactor is proven by unchanged interpretation and override snapshots (`bun run snapshots:check`)
  and an unchanged determinism test. A behavior change changes the snapshot for its own cards
  only, and each changed card has a regression test.
- Every new check starts as a report, is run over the reviewed cards, and becomes a gate only after
  each finding is fixed or waived with a reason. Gates cover `implemented-reviewed` cards and cards
  changed in the pull request; other cards get reports, so unrelated work is never blocked.
- Exemption and waiver lists are committed JSON, name cards by oracle id, carry a reason per entry,
  and may only shrink unless a pull request adds an entry with its reason.

## Work split

Per `CLAUDE.md`, subagents run on Sonnet or Haiku only. The main thread decides anything about rules
correctness: the reason given to each executor guard (phase 3), each decision-index site's
classification (phase 1), facet waivers (phase 4), keyword semantics (phase 5) and result semantics
(phase 6). Sonnet implementers do the mechanical work once a decision is written down: converting
guards with a given reason table, moving inline keyword branches, writing tests from a manifest.
Haiku explorers run audits and summarize test output to the scratchpad.

## Phase 0: baseline measurements

Add `scripts/card-authoring-metrics.ts`, which prints JSON and Markdown for:

- `Effect` ops and `RuleStatic` kinds with their authoring-site counts, the compound (`…And…`) and
  card-named lists;
- the keyword probe from ADR 0031, over the pinned fixtures and, when `data/` holds it, the bulk
  Oracle file, ranked by the number of cards printing each unmodeled keyword;
- executor guard count, decision-index fallback sites, one-argument `pump()` calls, and test files
  defining their own `game()`/`pod()`, `pinned()` or cast helper;
- for a commit range, files and lines touched per `feat(cards)` commit.

Commit the first output as `docs/reviews/card-authoring-baseline-<date>.md`. Recorded at `8b93725`:
344 ops, 32 compound and 11 card-named; 51 rule-static kinds; 5 of 37 probed keywords modeled; 198
executor guards; 21 index-fallback sites; about 1,236 one-argument `pump()` calls; 216, 44 and 33
local harness helpers; and across the 18 unique PR11 and PR11b `feat(cards)` commits a median of
9.5 files and about 500 inserted lines, before their manifest and viewer-scenario commits.

Exit: the script runs in under a minute offline, and the baseline report is committed.

## Phase 1: fail-loud quick wins

1. Add `EngineInvariantError` to `errors.ts` and export it.
2. Validate references between instructions (ADR 0032 decision 1): `binding` must name an earlier
   `bind` in the same ability and mode; `gainLifeEqualToLifeLostThisWay` must follow an op that
   feeds the accumulator. Tests: Fabled Passage with a misspelled binding becomes unsupported with
   the path; `eachPlayerLosesLife` then `gainLifeEqualToLifeLostThisWay` is rejected;
   `bun run audit:card-ir` reports nothing new.
3. Replace the executor's `?? []` for a missing binding with `EngineInvariantError`.
4. Classify the 21 decision-index sites in a table in the pull request (decline-by-index or
   fallback). Decline-by-index sites get an explicit `role: 'decline'` option; fallbacks use
   `optionAt()`. Test: a generator answered with an out-of-range index throws at each fallback site.
5. Extend the inline-`TokenSpec` lint to all of `packages/engine/src` except `cards/tokens.ts` and
   `parseTokenFace`. Fix or catalogue anything it finds.
6. `RuleBasedProvider` records which `once` rules fired; `drive()` fails on any that did not, unless
   the provider was built with `{ fallback: 'first' }`. Update the six files that use it.
7. Add a Vitest reporter that fails on skipped or `todo` tests missing from
   `tests/fixtures/allowed-skips.json`; list the bulk-data `skipIf` suites with their reasons.

Exit: full suite, card gate and `snapshots:check` pass; snapshots and determinism unchanged; every
new check has a test that proves it fires.

## Phase 2: strict drivers and one scenario format

1. `pump(gen, answer, { strict: true })` throws on an unanswered unforced decision and prints its
   prompt and options. `script([...])` matches decisions by prompt and option description, in
   order, and fails on leftovers.
2. A lint rule rejects one-argument `pump()` in test files outside a committed list of current
   files. The list may only shrink.
3. A content-addressed Oracle pin store (`packages/engine/tests/fixtures/oracle-pins/`) and a shared
   `pin(name)` that verifies the hash. Existing per-batch fixtures stay where they are.
4. A scenario runner (`packages/engine/tests/scenario/`) built on `PreparedScenarioSpec`: setup,
   a decision script, expectations on zones, life, counters and events, driven only through
   `Engine.advance` and `Engine.submit`.
5. A server adapter registers the same spec as a Card Test Lab scenario with pinned Oracle and
   clause IDs, so one definition produces the engine test and the viewer scenario.
6. Pilot: re-express one reviewed card's clauses (Chrome Mox from PR11) with the runner, side by
   side with its existing tests, and confirm the card gate accepts the new evidence IDs.

Exit: the pilot's engine and viewer evidence come from one spec; `test:e2e` passes for its
scenarios; new tests cannot use lenient `pump()`.

## Phase 3: diagnostics, invariants and fuzzing

1. `GameConfig.diagnostics` carries an optional sink into `GameContext.diagnostics`. A context copied
   for a payment probe or a bot search drops it, so speculative executions never record. Test that
   both paths record nothing.
2. `noop(reason, detail)` and `invariant(reason, detail)` helpers. The main thread writes the reason
   for every executor guard in a table (site, op, reason, CR rule). A Sonnet implementer converts the
   198 guards to `noop` from that table, in batches by op family. Nothing throws yet. Snapshots,
   determinism and benchmark hashes stay unchanged.
3. `checkStateInvariants(ctx)` in `engine/src/testing/invariants.ts` (ADR 0032 decision 8). The
   privacy check is structural: the view's hand is exactly the viewer's hand, opponents expose a
   hand size only, and library cards appear only in `revealedLibraryTops`, which equals
   `visibleLibraryTops(ctx, viewer)`. The first full run's violations are either engine bugs, fixed
   with a regression each, or documented exceptions encoded in the checker with a reason.
4. Wire invariants into `drive()`, the scenario runner and the Card Test Lab scenario tests.
5. `bun run fuzz [--games N] [--seed S]` over supported-pool decks with the random and heuristic
   providers; it prints seed and decks on any failure. Add a fixed-seed step to the card gate job
   with a budget measured to stay under three minutes, and a scheduled workflow with a larger
   budget.
6. Commit a histogram of `noop` reasons by site from the suite and the fuzz run.

Exit: the suite and fixed-seed fuzz pass with invariants on; the histogram is committed; production
paths do not call the checker or record diagnostics.

## Phase 4: provenance, merge check, IR coverage and facets

1. `interpretCard` records the Oracle line behind each ability, static, keyword expansion and
   replacement field in a side record, passed to `applyOverride` and exposed as
   `interpretCardWithProvenance`. Snapshots unchanged.
2. `applyOverride` rejects a replace-mode override that removes a parsed entry from a line it does
   not claim. Current violations go to an exemptions list. Test with a reconstruction of the
   Desolate Mire failure from ADR 0025.
3. IR coverage (ADR 0032 decision 5). Records carry the oracle id and the effect's canonical form;
   the checker maps them to definition paths, and an effect that appears identically more than once
   in a card is credited at each occurrence. First produce a report: which manifest test IDs match
   exactly one executed test, and which reviewed cards have an effect never applied. Rename
   ambiguous tests and fill gaps, then turn the gate on for reviewed and changed cards. Scope:
   ability effects, including modes, alternative casts and faces. Statics and replacement fields
   stay proven by their behavior tests.
4. `cards/facets.ts` with the five facets of ADR 0032 decision 6. Its test is the two pre-fix
   definitions from `5c8e41f` (Securitron Squadron, Overwhelming Instinct), committed as a fixture:
   both flagged, both fixes clean. Run it over the reviewed cards, fix or waive each finding, then
   gate reviewed and changed cards. Commit the population report as an audit backlog.

Exit: both gates run in the card gate job; the population reports are committed.

## Phase 5: keyword registry

1. `defineKeyword` and the registry; `parseKeywordLine` offers each element to it.
2. Move each inline keyword branch into a module, one commit per keyword (Equip and Equip commander
   become one module with a target option): both snapshots byte-identical.
3. Grants read the registry. Eldrazi Conscription's annihilator becomes a grant of the registered
   keyword; its snapshot entry is the only change, and only if the expansion's shape differs.
4. An override claiming a line the registry parses is an authoring issue. Harmonic Prodigy's Prowess
   moves to the registry; its snapshot entry is the only change.
5. Add keywords in the phase 0 frequency order. Each lands with its primitive contract (positive and
   negative cases), one pinned card's full evidence under the card modeling guide, and its
   capability registration.

Exit: re-running the phase 0 probe shows each added keyword modeled; no override hand-authors a
registered keyword.

## Phase 6: results and parameterization

1. Op contracts declare what they publish. `EffectRef` gains `{ result }` and
   `{ controllerOfResult }`; `Value` gains `resultCount` and `resultAmount`. The validator resolves
   names, order, mode and kind. The executor keeps one results map and follows moved objects only
   through `movedReferent`.
2. Re-express `bind`/`untapBoundIf` and `lifeLostThisWay` as results. Their cards' behavior tests are
   unchanged; their snapshot entries are the only changes.
3. A check rejects new discriminant names that match a card-name slug. The 11 existing card-named
   ops are listed and may only be removed.
4. Merge `triggerAdditionalForShamanOrOtherWizard` into `triggerAdditionalTime`, add the event filter
   Panharmonicon needs, and merge the three damage-multiplier statics into `damageModifier`. Each
   merge keeps its cards' behavior tests unchanged.
5. Review rule: a pull request adding a compound op is rejected.

Exit: no compound op added since the phase began; the two families merged; their cards' tests
unchanged.

## Phase 7: primitive modules, workbench and descriptions

1. Extract `ResolutionContext` from `executeAbility`'s closures. Snapshots, determinism and the
   full suite unchanged.
2. `definePrimitive` and the registry; `executeAbility`'s `default` dispatches to it before
   `assertNever`. The next new primitive is the pilot; then one simple legacy op moves as a second
   pilot. Both keep the existing tables' exhaustiveness.
3. `bun run card:new` (ADR 0031 decision 5). Its scaffolds are rejected by the gates until filled.
4. `describeEffect` for the most-used ops by the phase 0 counts; builders default to it only when
   every effect is covered. Existing descriptions unchanged.

Exit: a new primitive in the module form touches the module, one union line, one registry line and
its contract test.

## Phase 8: pilot batch and promotion

1. Choose about ten unmodeled cards from the EDH staples and fixture reports whose clauses are
   keywords or compositions. Model them with `card:new`, the scenario runner, results and the
   registry, to the full standard of the card modeling guide.
2. Measure against the phase 0 baseline and record the result in `docs/reviews/`.
3. Promote `noop` sites to `invariant` where the histogram and the code agree that the rules never
   reach them, one commit per site, each with a test that reaches it through malformed IR.

Success targets, checked in this phase:

- keyword-only and composition-only cards change no file under `packages/engine/src/effects` or
  `cards/ability.ts`;
- median files touched per `feat(cards)` commit falls from 9.5 to 5 or fewer, counting the scenario
  file that replaces separate engine and viewer scenario code;
- no new card in the batch needs a new compound or card-named primitive;
- every reviewed card in the batch passes IR coverage and facets without a waiver.

If a target is missed, the review records why and which phase's assumption failed. The phases are
not rolled back for missing a target; each must already have met its own exit.

## Order and dependencies

Phases 1, 2 and 3 are independent of each other and start immediately. Phase 4 needs phase 3's sink
for IR coverage; its provenance and facets need nothing. Phase 5 needs phase 4's provenance for the
keyword-claim check. Phase 6 needs phase 1's reference validation. Phase 7's workbench needs phases
2, 4 and 5; its primitive modules need phase 6's result contracts. Phase 8 needs all of them.

## Gates per phase

Every phase runs what CI runs for its surfaces:

```bash
bun run typecheck
bun run typecheck:tests
bun run lint
bun run format:check
bun run test
bun run test:card-gate
bun run snapshots:check
```

Phases touching the scenario runner or Card Test Lab also run `bun run test:e2e`. Phases 3 and 8 run
`bun run fuzz` with the CI seeds. Phase 5 and phase 8 card additions run the coverage tools and the
evidence generators the card modeling guide lists.

## Risks

| Risk                                                                | Mitigation                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A guard's reason is wrong and a later promotion halts correct games | Promotion only after the histogram and a reading agree, one site per commit, each reversible                 |
| Facets flag correct cards                                           | Five high-precision facets only; gate only after the reviewed set is clean or waived                         |
| IR coverage over-credits identical effects                          | Documented over-approximation; the manifest still requires positive and negative tests per clause            |
| Manifest test IDs do not match executed tests uniquely              | Report first, rename, then gate                                                                              |
| The keyword move changes behavior                                   | One keyword per commit, both snapshots byte-identical                                                        |
| `ResolutionContext` extraction breaks closures' timing              | Mechanical move, determinism and full suite unchanged before any module uses it                              |
| CI time grows                                                       | The fuzz budget is measured and capped; diagnostics are off in production code paths                         |
| Results change LKI or zone-tracking semantics                       | Results follow objects only through the existing `movedReferent`; their cards' behavior tests stay unchanged |
