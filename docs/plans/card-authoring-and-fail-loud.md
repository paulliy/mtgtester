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
   clause no test executed, a test that stopped running, and corrupt state each fail loudly at the
   line responsible.
4. New tests are strict and come from one scenario format that also yields the viewer scenario.

## Constraints

These hold in every phase, and every phase's exit checks them.

- The [card modeling guide](../guides/card-modeling-and-testing.md) stays the completion standard.
  Nothing here replaces a manifest clause, a normal-path engine scenario or viewer evidence.
- The [rules-engine constraints](../guides/rules-engine-constraints.md) hold: the engine stays free of
  I/O and provider policy, games stay seeded, and `PlayerView` stays the privacy boundary.
- Fixed-seed replay, the game event log, the persisted debug log and AI benchmark inputs do not
  change unless a step says so and says why. Diagnostics and invariants run only in tests and tools.
- A refactor is proven by unchanged interpretation and override snapshots (`bun run snapshots:check`)
  and an unchanged determinism test. A behavior change changes the snapshot for its own cards
  only, and each changed card has a regression test.
- Every new check starts as a report, is run over the reviewed cards, and becomes a gate only after
  each finding is fixed or waived with a reason. Gates cover `implemented-reviewed` cards and cards
  changed in the pull request; other cards get reports, so unrelated work is never blocked.
- Every exemption, waiver and known-failure list is committed JSON keyed by oracle id (or file),
  carries a reason per entry, and is enforced as shrink-only by `scripts/check-ratchets.ts`.
- Each new CI step's added minutes are measured and recorded before it becomes required.

## Evidence compatibility

The existing evidence machinery is not replaced, and each phase must leave it working:

- **Primitive contract evidence** (`bun run test:primitive-contracts`) hashes the test dependency
  closure, all engine sources and the execution configuration, and needs a clean tree. Any engine
  change invalidates current receipts; regenerate them after the phase lands. New test helpers live
  in their own modules, and new Vitest configuration goes in separate config files or CLI flags, so
  `vitest.config.ts` and `tests/fixtures.ts` change only where a step says so.
- **Viewer evidence** binds Card Test Lab scenarios through `VIEWER_CATALOG` entries (`file`, `key`),
  the discovery identity, `card-evidence-input` and trace hashes. New scenarios are added to the
  catalog the same way; capture is a fresh Playwright run from a clean tree.
- **Manifest pins** (`oracleSha256`) must equal the hashes in any new pin store.

## Work split

Per `CLAUDE.md`, subagents run on Sonnet or Haiku only. The main thread decides anything about rules
correctness: the reason given to each executor guard and every promotion to an invariant (phase 2),
each decision-index site's class (phase 1), facet waivers (phase 4), keyword semantics (phase 5) and
result semantics (phase 6). Sonnet implementers do the mechanical work once a decision is written
down: converting guards from a given reason table, moving inline keyword branches, normalizing
manifest IDs, writing tests from a manifest. Haiku explorers run audits and summarize test output to
the scratchpad.

## Phase 0: baseline measurements

Add `scripts/card-authoring-metrics.ts`, which prints JSON and Markdown for:

- `Effect` ops and `RuleStatic` kinds with their authoring-site counts, and the compound (`…And…`) and
  card-named lists;
- the keyword probe from ADR 0031, over the pinned fixtures and, when `data/` holds it, the bulk
  Oracle file, ranked by the number of cards printing each unmodeled keyword;
- executor guard count, decision-index fallback sites, one-argument `pump()` calls per file, and
  test files defining their own `game()`/`pod()`, `pinned()` or cast helper;
- manifest `engineTestIds` by shape (`file::title`, prefix, computed), by how many test files
  contain them, and whether those files are in `test:card-gate`;
- per card, over a commit range: every commit that touched the card's override, tests, manifest
  entry or scenarios, with files and lines touched, and whether any file under
  `packages/engine/src/effects/` or `cards/ability.ts` changed.

Commit the first output as `docs/reviews/card-authoring-baseline-<date>.md`. Recorded at `8b93725`:
344 ops, 32 with `And` in the name and at least 15 card-named; 48 rule-static kinds; 5 of 37
gap-selected keywords and 11 of 17 others modeled; about 200 executor guards; about 21
index-fallback sites; about 1,940 one-argument `pump()` calls in 280 files; about 216 local
`game()`/`pod()`/`setup()` helpers, 44 `pinned()` helpers and 60 per-batch Oracle fixtures; 2,446 manifest test IDs, of which 231 live outside the card-gate files. The
per-card cost of PR11 and PR11b, under the counting rule above, is computed by the script; the
draft figure of a median 9.5 files covers only 18 `feat(cards)` commits (the later hash of each
rebased pair; the earlier hashes give 8.0) and is not the baseline. The report lists the exact
regexes and commit hashes behind every number.

Exit: the script runs offline in under a minute and the report is committed.

## Phase 1: fail-loud quick wins

1. Add `EngineInvariantError` to `errors.ts`. `Engine.advance` turns it into `engineHalt` and a
   halted `GameResult`, like `UnmodeledCardError`; with `strictInvariants` it rethrows. Tests for
   both paths.
2. Validate references between instructions (ADR 0032 decision 1): `binding` names an earlier `bind`
   in the same ability; names are unique across modes; `gainLifeEqualToLifeLostThisWay` follows an
   op that feeds the accumulator. Tests: Fabled Passage with a misspelled binding becomes
   unsupported with the path; two modes binding the same name are rejected; `eachPlayerLosesLife`
   then `gainLifeEqualToLifeLostThisWay` is rejected; `bun run audit:card-ir` reports nothing new.
3. Only then, a binding that was never set (not one set to `[]`) throws `EngineInvariantError`.
4. Sort the 21 decision-index sites into true fallbacks, decline option already present and decline
   implied, in a table in the pull request. True fallbacks use `optionAt()`, with a test per site
   that an out-of-range answer throws. Decline-option-present sites make the read explicit with no
   menu change. Decline-implied sites gain an option, each in its own commit with its benchmark
   rehash, after confirming which presentation fields feed AI hashes.
5. Extend the inline-`TokenSpec` lint to all of `packages/engine/src` except `cards/tokens.ts` and
   `parseTokenFace`. Fix or catalogue anything it finds.
6. `RuleBasedProvider` records which `once` rules fired; `drive()` fails on any that did not. First-
   option fallback is opt-in per rule. Update its consumers: `engine.test.ts`,
   `token-triumph-deck.test.ts`, `packages/server/src/cli/test-cards-l4-l6.ts`,
   `pr09-choice-scenarios.test.ts` and `pr08-agitator-ant-scenarios.test.ts`; delete the stale
   tracked `tests/fixtures.d.ts` or regenerate it.
7. `scripts/check-ratchets.ts`: compares every shrink-only list against the base commit and fails on
   an added entry without a reason or a raised count. Wire it into the card-gate job, which already
   has the base SHA.
8. A pre-step script resolves each `test:card-gate` entry as a substring filter over test file
   paths and fails if one matches no file.
9. Turn on `expect.requireAssertions`, fixing the tests it exposes, each as a correction with its
   own regression or a recorded reason.

Exit: full suite, card gate and `snapshots:check` pass; snapshots and determinism unchanged; each
new check has a test proving it fires; `check-ratchets` and the gate-path script run in CI.

## Phase 2: diagnostics, invariants and fuzzing

1. `createGame` takes a sink from `GameConfig.diagnostics` or, failing that, from the test-only
   `installDefaultDiagnostics()`. The cast preview drops it explicitly; `castingCheckpoint` records
   its length and truncates on rollback. Tests: preview, payment probe and a rolled-back cast record
   nothing.
2. `noop(ctx, reason, detail?)` and `invariant(ctx, reason, detail?)`, with `detail` lazy. The main
   thread writes the guard table (site, op, reason, CR rule) for every guard; a Sonnet
   implementer converts them in batches by op family. Nothing throws yet. Snapshots, determinism
   and benchmark hashes unchanged.
3. Stack objects carry an `origin` (oracle id and ability path; `copy` and `external` marks), and
   records carry `abilityPath` and `effectIndex`. `applied` is written when an effect finishes
   without a `noop`.
4. `checkStateInvariants(ctx)` with the list in ADR 0032 decision 8. A test runs the determinism
   scenario with the checker on and off and requires identical event logs and RNG state. An import
   lint forbids `testing/invariants.ts` outside tests, tools and the scenario runner.
5. Wire invariants and `strictInvariants` into `drive()` and the Card Test Lab scenario tests. The
   first run's violations become fixes with regressions or reasoned exceptions in the checker.
6. `bun run fuzz [--games N] [--seed S]` over the committed coverage decks with the pinned
   `coverage-oracle.json`, leaving out decks with unsupported cards and reporting them. Measure
   per-game time with invariants on, then pick the CI seed count. Add it as its own parallel CI job,
   a scheduled workflow with a larger budget, and `fuzz-known-failures.json` under the ratchet.
7. Commit the histogram of `noop` reasons by site from the suite and fuzz.

Exit: suite and fixed-seed fuzz pass with invariants on; the determinism on/off test and the import
lint pass; the histogram and the measured fuzz time are committed.

## Phase 3: strict drivers and one scenario format

1. `pump(gen, answer, { strict: true })` and `script([...])` (ADR 0032 decision 9), with tests for
   an unexpected decision and a leftover entry.
2. A custom `card-authoring` ESLint rule reports one-argument `pump()`;
   `tests/fixtures/lenient-pump-counts.json` holds per-file counts under the ratchet.
3. The skip reporter, sharing code with `scripts/contracts/primitive-reporter.ts` and keyed by file,
   count and reason, run through CLI flags rather than `vitest.config.ts`. A scheduled job supplies
   the bulk Oracle file and fails on any skip.
4. A content-addressed Oracle pin store with `pin(name)`, whose hashes equal the manifest's
   `oracleSha256`. Existing per-batch fixtures stay.
5. The scenario runner (`packages/engine/tests/scenario/`) on `PreparedScenarioSpec`: setup, a
   decision script, expectations, `Engine.advance`/`Engine.submit` only, `strictInvariants`,
   invariants and the sink (from phase 2). Contract tests do not import it.
6. A server adapter registers the same spec as a Card Test Lab scenario and adds its
   `VIEWER_CATALOG` entry.
7. Pilot: re-express Chrome Mox's clauses (PR11) with the runner, beside its existing tests.

Exit: for the pilot, the card gate accepts the new evidence IDs, and `test:primitive-contracts`,
the `card-evidence-input` tests, `test:e2e` and a fresh viewer capture all pass; new tests cannot
add lenient `pump()` calls.

## Phase 4: provenance, merge check, IR coverage and facets

1. Line provenance from per-iteration list-length deltas, post-loop rewrites unattributed;
   `applyOverride(def, provenance)` at both call sites; `interpretCardWithProvenance` for tools.
   Snapshots unchanged.
2. The merge check with `replacesLines` (ADR 0032 decision 7). Desolate Mire moves to
   `replacesLines`; a reconstruction of its old failure is the test. Existing violations go to an
   exemptions list under the ratchet.
3. IR coverage, in order: the separate config `vitest.ir-coverage.config.ts`, `task.meta`
   collection and a main-process reporter; the matcher (file equal if given, ID a prefix of the full
   title); a report of every ID with zero or several matches; normalization (explicit titles for the
   47 computed names, the 18 duplicates disambiguated, the 5 bulk-only IDs marked
   `notExecutableInCi`); then the gate for reviewed and changed cards, run after the full-suite job
   on non-draft pull requests. Measure the added time before the gate is required.
4. `cards/facets.ts`. Its test is the two pre-fix definitions from `5c8e41f`, committed as a fixture:
   both flagged, both fixes clean. Run it over the 168 reviewed cards; gate `other`,
   `interveningIf` and `untilEndOfTurn` once each meets the 90% bar with every finding fixed or
   waived; `optional` and `targetCount` stay reports until they do. Waivers are keyed by oracle id,
   facet and clause hash. Commit the population report as an audit backlog.

Exit: the facet gate runs in the card-gate job and the IR coverage gate after the full suite; both
population reports are committed.

## Phase 5: keyword registry

1. `defineKeyword` and the registry with `flag`, `grantable`, priority and `expand(args, line)`;
   `IMPLEMENTED_KEYWORDS` generated from it. `parseKeywordLine` stays atomic.
2. Move each inline keyword branch into a module, one commit per keyword, emitted at the same loop
   position: both snapshots byte-identical. A branch that cannot meet that stays inline with a
   comment.
3. Grants read the registry. Eldrazi Conscription's annihilator becomes a grant of the registered
   keyword; its snapshot entry is the only possible change.
4. The authoring check rejects an override claiming a line the registry parses, and a ratchet-listed
   check (`registered-keyword-overrides.json`, empty) proves none remain. Harmonic Prodigy's Prowess
   moves to the registry; its snapshot entry is the only change.
5. Add keywords in the phase 0 frequency order, each with its primitive contract (positive and
   negative), one pinned card's full evidence under the card modeling guide, and its capability
   registration.

Exit: the phase 0 probe shows each added keyword modeled; the registered-keyword check is empty.

## Phase 6: results and parameterization

1. `loseLife`, `gainLife` and `drawCards` return the actual amount, with tests under a floor and a
   replacement.
2. Op contracts declare what they publish. `EffectRef` gains `{ result }` and
   `{ controllerOfResult }`, `Selector` gains `inResult`, `Value` gains `resultCount` and
   `resultAmount`. The validator resolves name, order, scope and kind. One results map per
   resolution, passed by reference into nested bodies; `registerDelayedTrigger` gains `remember`.
   Each publishing op has a contract case for its "actually" negative.
3. Re-express `bind`/`untapBoundIf` and `lifeLostThisWay` as results. Their cards' behavior tests are
   unchanged; their snapshot entries are the only changes.
4. The card-name check runs against a committed slug list; `card-named-ops.json` and
   `compound-ops.json` hold the existing names under the ratchet, so adding one fails CI.
5. Merge `triggerAdditionalForShamanOrOtherWizard` into `triggerAdditionalTime`, add the event filter
   Panharmonicon needs, and merge the three damage-multiplier statics into `damageModifier`. Each
   merge keeps its cards' behavior tests unchanged.

Exit: the compound and card-named lists have not grown; the two families are merged; their cards'
tests are unchanged.

## Phase 7: primitive modules, workbench and descriptions

1. Extract `ResolutionContext` with `child()`. Snapshots, determinism and the full suite unchanged.
2. Split `Effect` into `LegacyEffect | ModuleEffect`; `definePrimitive` and the registry, with the
   compile-time check that every module op is in all four tables. The next new primitive is the
   pilot; one simple legacy op moves as a second pilot.
3. `bun run card:new` (ADR 0031 decision 5). Its scaffolds are rejected by the gates until filled.
   Its `it.todo` placeholders fail the skip reporter by design; locally, `bun run test <file>`
   shows them as todo while authoring.
4. `describeEffect` for the most-used ops by phase 0 counts, golden-tested; builders default to it
   only when every effect is covered. Existing descriptions unchanged.

Exit: a module-form primitive's pull request touches the module, the registry and its contract
test, and no other engine file.

## Phase 8: pilot batch and promotion

1. Choose ten unmodeled cards from the EDH staples and fixture reports, drawn at random from those
   whose clauses the workbench reports as keywords or compositions, and a matched control of ten
   cards from PR11 and PR11b with similar clause counts. Model the ten with `card:new`, the scenario
   runner, results and the registry, to the full standard of the card modeling guide.
2. Measure both groups with the phase 0 per-card rule and record the result in `docs/reviews/`.
3. Promote `noop` sites to `invariant` where a written argument shows a validated definition cannot
   reach them, one commit per site, each with a test that reaches it through malformed IR.

Success targets:

- primary: no pilot card changes a file under `packages/engine/src/effects/` or
  `cards/ability.ts`;
- the pilot's median and p90 files and lines per card are below the control's, counted the same
  way;
- no pilot card adds to the compound or card-named lists;
- every pilot card passes IR coverage and the gated facets without a waiver.

If a target is missed, the review records why and which phase's assumption failed. The phases are
not rolled back for missing a target; each must already have met its own exit.

## Order and dependencies

Phase 0 comes first. Phases 1 and 2 are independent of each other. Phase 3 needs phase 2's sink,
invariants and `strictInvariants`. Phase 4's provenance and facets need nothing; its IR coverage
gate needs phase 2's guard conversion and origins. Phase 5 needs phase 4's provenance. Phase 6
needs phase 1's reference validation. Phase 7's workbench needs phases 3, 4 and 5, and its
primitive modules need phase 6's result contracts. Phase 8 needs all of them.

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

Phases that change engine sources regenerate primitive contract evidence. Phases touching the
scenario runner or Card Test Lab also run `bun run test:e2e`. Phases 2 and 8 run `bun run fuzz` with
the CI seeds. Phase 5 and phase 8 card additions run the coverage tools and the evidence generators
the card modeling guide lists.

## CI placement

| Check                                 | Where                                   |
| ------------------------------------- | --------------------------------------- |
| Ratchets, gate-path check, facets     | Card-gate job (runs on drafts)          |
| IR coverage                           | After the full-suite job, non-draft PRs |
| Fuzz, fixed seeds                     | Its own parallel job                    |
| Fuzz, larger budget; bulk-data suites | Scheduled workflow                      |

## Risks

| Risk                                                    | Mitigation                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A promoted invariant halts correct games                | Promotion needs a written unreachability argument and a malformed-IR test; live matches halt visibly, never crash |
| Facets flag correct cards                               | Only one-to-one facets gate first; each gated facet needs 90% precision on the reviewed set                       |
| A waiver hides a later clause change                    | Waivers are keyed by clause hash and expire on mismatch                                                           |
| IR coverage misattributes copied or granted abilities   | Records carry the stack object's origin; copies and grants count only for the printing card                       |
| Manifest test IDs do not match executed tests uniquely  | Matcher, report and normalization before the gate                                                                 |
| The keyword move changes behavior                       | One keyword per commit at the same emission position, both snapshots byte-identical                               |
| `ResolutionContext` extraction breaks nested resolution | `child()` states what is shared; determinism and full suite unchanged before any module uses it                   |
| Results change LKI or zone-tracking semantics           | Results follow objects only through `movedReferent`; contract negatives for each publishing op                    |
| CI time grows                                           | Each step measured and placed per the table above; fuzz in parallel                                               |
| A fuzz seed fails after an unrelated change             | Treated as a real bug: fix, or list with an issue under the ratchet and keep reporting it                         |
| Evidence receipts go stale                              | Regenerated after every engine-changing phase; new config outside `vitest.config.ts`                              |
