# Plan: faster card authoring and fail-loud execution

Status: Proposed. Baseline: `8b93725` (2026-10-27).

Implements [ADR 0031](../decisions/0031-forge-informed-card-authoring.md) (faster card authoring)
and [ADR 0032](../decisions/0032-fail-loud-execution-and-strict-tests.md) (fail-loud execution and
strict tests). The evidence behind both is in the
[Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

## Goals

1. The mechanical tail of a card batch (snapshots, rehash, scenario binding, manifest skeleton, gate
   list) is generated and reviewed, not typed.
2. A card whose clauses are keywords or compositions of existing primitives needs no engine change.
3. A wrong reference, a misapplied override, an out-of-range test answer, a guessed test decision, a
   test that does not depend on its card, a test that stopped running, and corrupt state each fail
   loudly at the line responsible.

## Constraints

These hold in every phase, and every phase's exit checks them.

- The [card modeling guide](../guides/card-modeling-and-testing.md) stays the completion standard.
- The [rules-engine constraints](../guides/rules-engine-constraints.md) hold: no I/O or provider
  policy in the engine, seeded games, `PlayerView` as the privacy boundary.
- Decision requests, seeded choices, the game event log and the persisted debug log do not change
  unless a step says so. Benchmark compatibility pins hash every engine source file, so an
  engine-changing pull request re-seals them with
  `bun run ai-bench refresh --suite core-fast --write` in a `chore(benchmarks)` commit, as today.
- A refactor is proven by unchanged snapshots (`bun run snapshots:check`) and an unchanged
  determinism test; a behavior change changes the snapshot for its own cards only, each with a
  regression test.
- Primitive contract evidence hashes engine sources, the test dependency closure, `package.json`,
  `bun.lock`, `ci.yml`, the manifest and the evidence scripts. Receipts are not committed: each
  phase's exit includes `bun run test:primitive-contracts --output <new dir>` passing on a clean
  tree. New Vitest settings that only some runs need go in a separate config (`mergeConfig` over the
  base).
- Each new CI step's added minutes are measured and recorded before it is required.

## Work split

Per `CLAUDE.md`, subagents run on Sonnet or Haiku only. The main thread decides rules questions: the
index-site table (phase 1), each `invariant` promotion (phase 4), equivalent mutations and facet
notes (phase 3), keyword semantics (phase 5) and result semantics (phase 6). Sonnet implementers do
mechanical work from written decisions; Haiku explorers run audits and summarize output to the
scratchpad.

## Phase 0: baseline

`scripts/card-authoring-metrics.ts` prints JSON and Markdown, with the exact regex or AST rule and
commit hashes behind every number:

- per card, for a named commit range: every commit touching its override, tests, manifest entry or
  scenarios; lines changed by category (generated, tests, engine `src` outside `cards/`, the per-op
  tables); commit-time span; and follow-up `fix` commits naming the card within 30 days;
- op, rule-static, compound and card-named counts; one-argument `pump()` calls (AST); manifest test
  ID shapes;
- the keyword frequency ranking, computed locally from the bulk Oracle file and committed with that
  file's SHA-256, so the ranking is reproducible without the file in CI.

Exit: the report is committed as `docs/reviews/card-authoring-baseline-<date>.md`; the script runs
offline in under a minute.

## Phase 1: the harness runs, and cheap loudness

1. Delete the tracked `packages/engine/tests/fixtures.js`, `.js.map`, `.d.ts` and `.d.ts.map`; fix
   whatever the real `fixtures.ts` breaks, each as a separate commit with its reason. Add a check
   that fails on a tracked `.js` or `.d.ts` beside a same-named `.ts` under `packages/*/tests`.
2. `EngineInvariantError` (with `site`), the halted `GameResult` in `Engine.advance` keeping site
   and seed, and `GameConfig.strictInvariants` (copied onto `GameContext`, passed through
   `EngineOptions`) to rethrow. Tests for both paths. `drive()` fails on a halted result.
3. Reference validation (ADR 0032 decision 2): same-list, unconditional `bind` scope; the three
   accumulator feeders. Tests: Fabled Passage's misspelled binding; a bind in a conditional branch;
   `eachPlayerLosesLife` then `gainLifeEqualToLifeLostThisWay`. `bun run audit:card-ir` reports
   nothing new. Then the never-set binding throws.
4. Scope contracts (ADR 0032 decision 2): the table of scope fields each `Value` and `Condition`
   kind needs and each trigger head, cast path and activation provides; validation against it, with
   the Nissa `damageDealt` probe as the test; `audit:card-ir` over the fixtures. Executor reads of
   absent fields become invariants one kind per commit afterwards.
5. The main thread commits the index-site table. True fallbacks use `optionAt()`, each with a test
   that an out-of-range answer throws; decline sites read a named `DECLINE_INDEX`. No menu changes.
6. The inline-`TokenSpec` lint over `packages/engine/src`, ordered before the existing
   `no-restricted-syntax` entries; the 13 literals move to `tokens.ts` or carry a reasoned disable.
7. `RuleBasedProvider(rules, { fallback: 'first' })` and `drive()` failing on unfired `once` rules.
   Consumers: `engine.test.ts`, `token-triumph-deck.test.ts`,
   `packages/server/src/cli/test-cards-l4-l6.ts`.
8. `expect.requireAssertions: true` in `vitest.config.ts`; fix the four tests it finds. This changes
   the configuration primitive evidence hashes, which the exit's fresh receipt run absorbs.
9. Suite integrity: every tracked test or spec file claimed by exactly one runner and collecting at
   least one test; every entry of `test:card-gate` in `package.json` matching at least one file;
   skip and `.only` lint with `// allowed-skip:` reasons.
10. `scripts/check-ratchets.ts` (base SHA from the pull request, with `ci.yml`'s push fallback): the
    card-named-op list and `notExecutableInCi` IDs may not grow; a discriminant equal to a card-name
    slug from the committed slug list fails; one containing `And` or `Then` warns.

Exit: full suite, card gate, `snapshots:check` and a fresh primitive-contract run pass; each new
check has a test proving it fires.

## Phase 2: the authoring commands and the gate list

1. The content-addressed pin store, `pinStore.get(name)` (ADR 0032 decision 10), throwing on unknown
   names; existing per-batch fixtures and `pinned()` helpers stay.
2. `script([...])` and `pumpStrict()` (ADR 0032 decision 9), which the runner needs.
3. The scenario runner on `PreparedScenarioSpec` with seed, script, expectations, end condition,
   `strictInvariants` and failure on a halted result; the generic per-card modifier list; the server
   adapter producing a `CardTestScenario` registered like `PR11_SCENARIOS`, with derived scenario-ID
   lists; an import lint keeping contract tests from importing the runner.
4. `bun run card:check "<name>"`: interpret, validate, this card's snapshot diff (facets join in
   phase 3).
5. `bun run card:new "<name>" [--batch <id>]` (ADR 0031 decision 1): the interaction prompts, the
   nearest-card list and the Forge script reference (ADR 0031 decision 7: commit `6a2dcdc`,
   `.cache/forge/`, skipped offline and in CI), writing an `unimplemented()` stub, manifest entries
   and a runner test file whose `it.todo` placeholders intentionally fail the skip lint until
   filled. The Forge-script-line check joins the card gate.
6. `test:card-gate` becomes `scripts/card-gate.ts` reading a committed list of directories and
   globs; an entry matching no file fails, and the step 9 check of phase 1 moves to the list. The
   158 current entries move over unchanged first, and a test proves the same file set runs.
7. `bun run card:finish [--batch <id>]`: snapshots with a per-card semantic diff, benchmark re-seal,
   scenario registration and evidence-generator binding, containment retirements, and the manifest
   and progress skeleton.
8. `card:new --primitive <op>` stub rows in the five files plus a contract-test skeleton.
9. Mini-pilot: three unmodeled cards modeled with the commands, timed against the PR11 median from
   phase 0, before phases 3 to 5 continue.

Exit: on a branch at the parent of `e61a3d9` with PR11b's `feat` commits applied,
`card:finish --batch pr11b` reproduces the generated parts of `e61a3d9..da2e2c6` (snapshots,
benchmark pins, evidence-generator binding lines, containment retirements; scenario bodies and prose
are excluded); `card:new` on a PR11b card reproduces its `handledLines`; the mini-pilot's times are
recorded.

## Phase 3: tests that depend on the card

1. The pull-request `pump()` check (ADR 0032 decision 9), AST-based.
2. Manifest references (ADR 0032 decision 5): the matcher, a report of every ID with zero or several
   matches, explicit titles for the 47 computed names, disambiguation of the 18 duplicates,
   `notExecutableInCi` for bulk-only IDs; then the check is required in the card gate.
3. IR mutation: `installDefinitionTransform()` at the public `interpretCard` and `createGame`'s
   custom definitions, the operator table, assertion-only kills, unreached mutants, and
   `scripts/mutate-cards.ts` under `vitest.mutation.config.ts`. Run it once over all 168 reviewed
   cards as a report only; fix weak tests or record equivalent mutants; then require it on non-draft
   pull requests for changed reviewed cards.
4. Facet warnings in `card:check` and the card gate, with `facetNotes` on manifest entries. The test
   is the two pre-fix definitions from `5c8e41f`, taken from the override snapshot at its parent.
5. Pilot: re-express Chrome Mox's clauses with the runner beside its existing tests.

Exit: for the pilot, the card gate, a fresh primitive-contract run, the `card-evidence-input` tests,
`test:e2e` and a fresh viewer capture pass; the mutation report over the reviewed cards is
committed; its added CI minutes are recorded.

## Phase 4: invariants and fuzz

1. `checkStateInvariants(ctx)` and the checkpoint hook in `flow/game.ts`, on when `strictInvariants`
   is set; sampled layer-cache verification under the same flag; the on/off determinism test; the
   import lint over the three test-only hooks.
2. Wire it into `drive()`, the scenario runner and the Card Test Lab scenario tests; fix or encode
   the first run's violations.
3. The zone-mutation lint with its 12 current sites resolved or reasoned, and the tap-site table
   (`consumeRegenerationShield`'s missing `becomesTapped` is the first case to decide).
4. `packages/server/src/cli/fuzz.ts` over the coverage decks and pinned Oracle, with changed-card
   pods from the pin store; failure on halted results, wall-clock and step caps, AI fallbacks and
   the empty-veto path; the liveness report; measured per-game time; an advisory PR job on engine
   changes and an authoritative nightly job that opens an issue.
5. The nightly bulk job: bulk-data suites with no skips and the whole-population interpret and
   validate smoke, against a checksum-pinned download.
6. The diagnostics sink and `noop`/`invariant` helpers, used from here on as cards touch ops. A
   guard becomes `invariant` only with a written unreachability argument and a malformed-IR test.

Exit: suite and fuzz seeds pass with invariants on; the determinism on/off test passes; fuzz time is
recorded.

## Phase 5: keyword registry, card by card

Go/no-go: if the phase 0 ranking shows fewer than five unmodeled staple or fixture cards blocked
only by a missing keyword, this phase is deferred and its steps 1 and 2 happen when the first such
card is modeled.

1. `defineKeyword` with `flag`, `multiple`, derived grantability and `expand(args, line)`;
   `IMPLEMENTED_KEYWORDS` generated from it; the meta-tests; the keyword-claim authoring check.
2. Line provenance (ADR 0031 decision 6) and the two-sided merge check (ADR 0032 decision 7), tested
   with a test-local `registerOverride`.
3. Each keyword a pilot card needs is added with its contract and the card's evidence. Each inline
   branch a pilot card touches moves byte-identically in its own commit.

Exit: no override hand-authors a registered keyword; each moved branch left both snapshots
byte-identical.

## Phase 6: pilot batch

1. Draw 20 unmodeled cards by one rule from the EDH staples and fixture reports, and assign 10 at
   random to the new workflow and 10 to the current one. With 10 per arm and one agent working both,
   the result is indicative, not a statistical proof; it is reported with that caveat.
2. Build typed results (ADR 0031 decision 3) when the first new-workflow card needs one, with their
   contracts, and re-express `bind`/`untapBoundIf` and `lifeLostThisWay` then.
3. Merge a duplicate rule-static family when one of its cards is touched.
4. Measure both groups with the phase 0 rule: commit-time span per card, engine lines outside
   `cards/` and the per-op tables, and follow-up fixes within 30 days.

Targets: the new-workflow group's median time per card is at least 25% below the control's and its
follow-up fixes are no more than the control's; no new-workflow card adds a card-named op; every
new-workflow reviewed card passes manifest references and mutation. The review records the result
either way.

## Order and dependencies

Phase 0 first. Phase 1's first step (the real harness) precedes everything, because every later test
result depends on it; the rest of phase 1 can run beside phase 2. Phase 2 delivers the first speed
gain. Phase 3 needs phase 2's pin store and runner. Phase 4 needs phase 1's `strictInvariants` and
can run beside phase 3. Phase 5 needs phase 2's `card:new` and its go/no-go. Phase 6 needs all of
them.

Every phase's exit also updates the guides for what it ships: `card-modeling-and-testing.md` (its
note that `pump()` defaults to option 0, the strict drivers, the runner and the commands),
`testing-discipline.md` and `project-commands.md`. The completion standard itself is unchanged; it
gains the manifest-reference and mutation checks.

## CI placement

| Check                                                             | Where                          |
| ----------------------------------------------------------------- | ------------------------------ |
| Harness, suite-integrity, ratchets, manifest refs, facet warnings | Card-gate job (runs on drafts) |
| IR mutation on changed reviewed cards                             | Its own job, non-draft PRs     |
| Fuzz on engine changes                                            | Its own job, advisory          |
| Fuzz at larger budget; bulk-data suites and population smoke      | Nightly                        |

## Risks

| Risk                                             | Mitigation                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Deleting the stale harness exposes failing tests | Each fix is its own commit with its reason; this is the point of phase 1     |
| `card:finish` writes something wrong unread      | It prints a per-card diff; reproducing PR11b's generated tail is the exit    |
| Mutation runs are slow                           | Changed reviewed cards only; time measured before it is required             |
| Equivalent mutations are misjudged               | Main-thread decision with a reason on the manifest clause                    |
| Facets warn on correct cards                     | Warnings only, with `facetNotes`, until a real defect is found               |
| A keyword move changes behavior                  | One keyword per commit, byte-identical snapshots, same emission position     |
| Results change LKI or zone tracking              | Built only for a real card, through `movedReferent`, with contract negatives |
| Fuzz fails unrelated pull requests               | Advisory on PRs; nightly is authoritative                                    |

## Review record

The ADRs and this plan went through three rounds of independent review before being proposed.

1. **Evidence, engine feasibility, testing and CI.** Corrected counts (48 rule statics, about
   1,940 lenient `pump()` calls, five files per primitive, at least 15 card-named ops); fixed results
   scoping across nested resolutions and delayed triggers; made `EngineInvariantError` halt a live
   match instead of crashing it; replaced invariants that are false in legal states (phasing,
   player and graveyard attachment hosts); found that manifest test IDs had never been matched to
   executed tests and that the fuzz CLIs need the gitignored bulk file.
2. **Return on investment, implementation readiness, resolution and missed Forge lessons.**
   Measured that the evidence tail, not engine code, dominates a card's cost, and reordered the plan
   to lead with `card:new`, `card:check` and `card:finish`. Replaced IR execution coverage with
   manifest-reference checks and IR mutation; cut primitive modules, generated descriptions,
   wholesale guard conversion, menu changes and central count files. Found the stale compiled
   `fixtures.js` shadowing `fixtures.ts`. Added Forge's suite-integrity method, keyword families and
   `multiple`, registry meta-tests, and loaders that throw on unknown input. The user chose Forge
   scripts as a reference only (ADR 0031 decision 7).
3. **Red team on silent failures, consistency, final defense.** Added scope contracts for values and
   conditions (a probe-confirmed silent zero), fuzz failure on halted games and livelocks, sampled
   layer-cache verification, the zone-mutation lint and tap-site table, the mutation hook points,
   operator table and assertion-only kills, the phase 2 ordering and named `card:finish` exit, a
   mini-pilot and a keyword go/no-go, and fixed cross-references and wrapping.

Consciously left open, and named where they belong: non-damage replacement ordering, reminder-text
stripping, dead exports and empty server `catch` blocks (ADR 0032 decision 11); bugs no mutation
operator models; and the small, single-agent pilot (phase 6).
