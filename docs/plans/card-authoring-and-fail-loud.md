# Plan: faster card authoring and fail-loud execution

Status: Proposed. Baseline: `8b93725` (2026-10-27).

Implements [ADR 0031](../decisions/0031-forge-informed-card-authoring.md) (faster card authoring)
and [ADR 0032](../decisions/0032-fail-loud-execution-and-strict-tests.md) (fail-loud execution and
strict tests). The evidence behind both is in the
[Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

## Goals

1. The mechanical tail of a card batch (snapshots, rehash, scenario binding, manifest skeleton,
   gate list) is generated and reviewed, not typed.
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
  engine-changing pull request re-seals them with `bun run ai-bench refresh --suite core-fast
--write` in a `chore(benchmarks)` commit, as today.
- A refactor is proven by unchanged snapshots (`bun run snapshots:check`) and an unchanged
  determinism test; a behavior change changes the snapshot for its own cards only, each with a
  regression test.
- Primitive contract evidence hashes engine sources, the test dependency closure, `package.json`,
  `bun.lock`, `ci.yml`, the manifest and the evidence scripts. Receipts are not committed: each
  phase's exit includes `bun run test:primitive-contracts --output <new dir>` passing on a clean tree.
  New Vitest settings that only some runs need go in a separate config (`mergeConfig` over the base).
- Each new CI step's added minutes are measured and recorded before it is required.

## Work split

Per `CLAUDE.md`, subagents run on Sonnet or Haiku only. The main thread decides rules questions:
the index-site table (phase 1), each `invariant` promotion (phase 4), equivalent mutations and facet
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
2. `EngineInvariantError`, halted `GameResult` in `Engine.advance`, and
   `EngineOptions.strictInvariants` to rethrow. Tests for both paths.
3. Reference validation (ADR 0032 decision 2): same-list, unconditional `bind` scope; the three
   accumulator feeders. Tests: Fabled Passage's misspelled binding; a bind in a conditional branch;
   `eachPlayerLosesLife` then `gainLifeEqualToLifeLostThisWay`. `bun run audit:card-ir` reports
   nothing new. Then the never-set binding throws.
4. The main thread commits the index-site table. True fallbacks use `optionAt()`, each with a test
   that an out-of-range answer throws; decline sites read a named `DECLINE_INDEX`. No menu changes.
5. The inline-`TokenSpec` lint over `packages/engine/src`, ordered before the existing
   `no-restricted-syntax` entries; the 13 literals move to `tokens.ts` or carry a reasoned disable.
6. `RuleBasedProvider(rules, { fallback: 'first' })` and `drive()` failing on unfired `once` rules.
   Consumers: `engine.test.ts`, `token-triumph-deck.test.ts`, `packages/server/src/cli/test-cards-l4-l6.ts`.
7. `expect.requireAssertions` on; fix the four tests it finds.
8. Suite integrity: every tracked test or spec file claimed by exactly one runner and collecting at
   least one test; skip and `.only` lint with `// allowed-skip:` reasons.

Exit: full suite, card gate, `snapshots:check` and primitive contracts pass; each new check has a
test proving it fires.

## Phase 2: the authoring commands and the gate list

1. `bun run card:check "<name>"`: interpret, validate, this card's snapshot diff (facets join in
   phase 3).
2. `bun run card:new "<name>" [--batch <id>]` (ADR 0031 decision 1), including the interaction
   prompts and nearest-card list, writing scaffolds the gates reject until filled. It uses the pin
   store from step 4.
3. `test:card-gate` becomes `scripts/card-gate.ts` reading a committed list of directories and
   globs; an entry matching no file fails. The 158 current entries move over unchanged first, and a
   test proves the same file set runs.
4. The content-addressed pin store and `pin(name)` (ADR 0032 decision 10), throwing on unknown
   names; existing per-batch fixtures stay.
5. `bun run card:finish [--batch <id>]`: snapshots with a per-card semantic diff, benchmark
   re-seal, scenario registration and evidence-generator binding, containment retirements, and the
   manifest and progress skeleton.
6. `card:new --primitive <op>` stub rows in the five files plus a contract-test skeleton.

Exit: re-running PR12's tail with `card:finish` on a scratch branch reproduces its committed
snapshot, benchmark and binding changes; `card:new` on a PR12 card reproduces its `handledLines`.

## Phase 3: tests that depend on the card

1. Strict drivers: `pump(..., { strict: true })`, `script([...])`, and a diff-based check rejecting
   one-argument `pump()` and `() => ({ index: 0 })` in added lines.
2. The scenario runner on `PreparedScenarioSpec` with seed, script, expectations, end condition and
   `strictInvariants`; the generic per-card modifier list; the server adapter producing a
   `CardTestScenario` registered like `PR11_SCENARIOS`, with derived scenario-ID lists; an import
   lint keeping contract tests from importing the runner.
3. Manifest references (ADR 0032 decision 5): the matcher, a report of every ID with zero or several
   matches, explicit titles for the 47 computed names, disambiguation of the 18 duplicates,
   `notExecutableInCi` for bulk-only IDs; then the check is required in the card gate.
4. IR mutation: `installDefinitionTransform()`, the fixed mutation set, and
   `scripts/mutate-cards.ts` running changed cards' manifest tests once per mutation. Run it over
   all 168 reviewed cards once as a report; fix weak tests or record equivalent mutations; then
   require it on non-draft pull requests for changed reviewed cards.
5. Facet warnings in `card:check` and the card gate, with `facetNotes` on manifest entries. The
   test is the two pre-fix definitions from `5c8e41f`.
6. Pilot: re-express Chrome Mox's clauses with the runner beside its existing tests.

Exit: for the pilot, the card gate, primitive contracts, the `card-evidence-input` tests,
`test:e2e` and a fresh viewer capture pass; the mutation report over the reviewed cards is
committed; its added CI minutes are recorded.

## Phase 4: invariants and fuzz

1. `checkStateInvariants(ctx)` and the test-only checkpoint hook in `flow/game.ts`; the
   on/off determinism test; the import lint.
2. Wire it into `drive()`, the scenario runner and the Card Test Lab scenario tests; fix or encode
   the first run's violations.
3. `packages/server/src/cli/fuzz.ts` over the coverage decks and pinned Oracle, with changed-card
   pods; measure per-game time; an advisory PR job on engine changes and an authoritative nightly
   job that opens an issue.
4. The nightly bulk job: bulk-data suites with no skips and the whole-population interpret and
   validate smoke, against a checksum-pinned download.
5. The diagnostics sink and `noop`/`invariant` helpers, used from here on as cards touch ops. A
   guard becomes `invariant` only with a written unreachability argument and a malformed-IR test.

Exit: suite and fuzz seeds pass with invariants on; the determinism on/off test passes; fuzz time is
recorded.

## Phase 5: keyword registry, card by card

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
   random to the new workflow and 10 to the current one.
2. Build typed results (ADR 0031 decision 3) when the first new-workflow card needs one, with their
   contracts, and re-express `bind`/`untapBoundIf` and `lifeLostThisWay` then.
3. Merge a duplicate rule-static family when one of its cards is touched.
4. Measure both groups with the phase 0 rule: commit-time span per card, engine lines outside
   `cards/` and the per-op tables, and follow-up fixes within 30 days.

Targets: the new-workflow group's median time per card and follow-up fixes are below the control's;
no new-workflow card adds a card-named op; every new-workflow reviewed card passes manifest
references and mutation. The review records the result either way.

## Order and dependencies

Phase 0 first. Phase 1 next, because every later test result depends on the real harness running.
Phase 2 delivers the first speed gain and needs only phase 1. Phase 3 needs phase 2's pin store.
Phase 4 needs phase 1's `strictInvariants` and can run beside phase 3. Phase 5 needs phase 2's
`card:new`. Phase 6 needs all of them.

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
| `card:finish` writes something wrong unread      | It prints a per-card diff; reproducing PR12's tail is the exit               |
| Mutation runs are slow                           | Changed reviewed cards only; time measured before it is required             |
| Equivalent mutations are misjudged               | Main-thread decision with a reason on the manifest clause                    |
| Facets warn on correct cards                     | Warnings only, with `facetNotes`, until a real defect is found               |
| A keyword move changes behavior                  | One keyword per commit, byte-identical snapshots, same emission position     |
| Results change LKI or zone tracking              | Built only for a real card, through `movedReferent`, with contract negatives |
| Fuzz fails unrelated pull requests               | Advisory on PRs; nightly is authoritative                                    |
