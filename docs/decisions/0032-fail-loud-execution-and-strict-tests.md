# ADR 0032: Fail loud in card execution and in the tests that prove it

Status: Proposed

Date: 2026-10-27

Companion: [ADR 0031](0031-forge-informed-card-authoring.md) (faster card modeling) and the
implementation plan [card authoring speed and fail-loud execution](../plans/card-authoring-and-fail-loud.md).
Evidence: [Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

## Context

The brief's rule is "halt loudly, never guess" (§6.3). Most of the loud machinery already exists,
and this ADR keeps all of it:

- exhaustive `assertNever` dispatch over `Effect`, `AbilityCost`, selectors, values and
  conditions (card-engine-quality Phase 1);
- `validateCardDefinition` on every final merged definition, with `enforceCardDefinition`
  turning invalid IR into `modeled: false` and a reason, and `assertValidModeledDefinition`
  throwing for custom and token definitions (`cards/authoring-validation.ts`);
- `scripts/audit-card-ir.ts`, which fails when a fixture card is demoted by invalid IR without
  an `unsupported` manifest declaration;
- the `handledLines` drift guard, `failedRegistrations`, `conflictingRegistrations`,
  the override and interpretation snapshots, primitive contract evidence and the card gate;
- `UnmodeledCardError` halting a game, and `IllegalDecisionError` rejecting a provider answer
  that is not on the legal-action menu (`engine.ts:200-215`).

What still fails silently was measured at `8b93725`. Each item is a path where a mistake produces
a game that keeps running and a test that keeps passing.

1. **References between instructions are not resolved.** A search effect's `bind` and
   `untapBoundIf`'s `binding` are free strings. The executor reads
   `effectBindings.get(effect.binding) ?? []` (`resolve.ts:6797`). Changing Fabled Passage's
   binding to `'foundLnad'` gives an empty issue list from `validateCardDefinition`; in a game the
   land would never untap. "Life lost this way" is a hidden accumulator that three of the ten
   life-loss ops feed (`resolve.ts:4306-4340`), so `eachPlayerLosesLife` followed by
   `gainLifeEqualToLifeLostThisWay` validates and gains nothing.
2. **Every executor early exit looks the same.** The `executeAbility` switch has about 200 one-line
   `if (x === undefined | null) break | return | continue` guards. Some are the rules (CR
   608.2b: an illegal target is not affected; "if you do" after a declined choice). Others are
   authoring or engine bugs (an unbound reference, a slot an earlier effect emptied by mistake).
   Nothing records which one happened.
3. **Decision answers fall back to option 0.** About 21 sites read `options[outcome.index] ?? options[0]`
   or an equivalent (`resolve.ts:1725, 2046, 2844, 4529, 5166, 5355, 7443, 9184` and others in
   `resolve.ts`, `sba.ts`, `damage-modifiers.ts`, `choose.ts`). `Engine.submit` validates
   production answers, so in a real game these are unreachable. Tests drive generators directly
   with `pump()`, which bypasses that check, so a wrong index silently becomes the first option.
   Some sites use an index past the end as "decline", with or without an explicit decline option;
   those are intended, not fallbacks.
4. **IR that validates but says something the card does not.** Two of the five bugs fixed in
   `5c8e41f` were of this kind: Securitron Squadron's trigger had an "another" the card does not
   print, and Overwhelming Instinct's event qualification was modeled as an intervening "if" the
   card does not have. Both type-checked, validated and had passing tests.
5. **The override merge can drop parsed abilities.** `applyOverride` is a shallow spread. An
   override that sets `activatedAbilities` discards every parsed activated ability, including
   ones from lines it does not claim. Rule 4 in `overrides/index.ts` documents this; nothing
   checks it.
6. **Catalog bypass outside lint scope.** The inline-`TokenSpec` lint covers `overrides/**` and
   `interpret.ts`. Master of Ceremonies' Treasure without its sacrifice cost lived in
   `resolve.ts` (its `masterOfCeremonies` case, with a copy in the unused `createTreasureForDeaths`),
   where the lint does not apply.
7. **Test drivers guess.** `pump()` answers every unforced decision it is not told about with
   index 0 (`tests/fixtures.ts:337-355`); about 1,940 of its 2,638 calls, in 280 of the 303
   files that use it, pass no answer at all.
   `RuleBasedProvider` falls back to the first option and never reports a rule that did not fire
   (`tests/fixtures.ts:370-398`). A `whenChoose` with a misspelled option silently does nothing.
8. **A test can claim a clause without executing it.** The verification manifest maps each Oracle
   clause to test IDs, but nothing checks that those tests ran the clause's ability and that its
   effects were applied. A positive test asserting state that was already true passes.
9. **State corruption shows up late or not at all.** No routine check confirms that object ids
   are unique, that each card is in one zone, that attachments point at live permanents, or that a
   `PlayerView` hides other players' hands, except where a specific test happens to look.
10. **A listed test can stop running.** `test:card-gate` passes 158 entries to Vitest as substring
    filters, and Vitest ignores one that matches no file: a nonexistent path beside a real one exits 0. All 158 match today. Separately, 231 of the manifest's 2,446 engine test IDs live in files the
    card gate does not run. Forge added `TestSuiteIntegrityTest` after eight test classes stopped running
    and its CI stayed green for a year.

Forge, the reference engine compared in the companion review, does not solve these either: most of
its script errors surface at run time or not at all, and it has few card-level tests. This ADR is
about what our typed IR lets us do that a string-based script cannot.

## Decision

### 1. Every reference between instructions resolves, or the card is unsupported

`validateCardDefinition` resolves every reference from one effect to another in an ability. A
`binding` must name a `bind` published earlier in the same ability (after ADR 0031 decision 2, a
result reference must name a result), with a compatible kind. Names are unique within an ability
across all of its modes, because a modal ability's chosen modes are folded into one effect list
(`actions/ability-modes.ts`) and two modes publishing the same name would collide. Until results replace
it, `gainLifeEqualToLifeLostThisWay` is valid only after an op that feeds the accumulator. Anything
else is an authoring issue: the card becomes `modeled: false` with the exact path, through the
existing `enforceCardDefinition` route.

This rule ships first. Only after it does the executor change: a binding that was never set (as
opposed to one set to `[]` by a search that found nothing, `resolve.ts:6016`) becomes an
`EngineInvariantError`, which a validated definition can no longer reach.

`EngineInvariantError` is a new class in `errors.ts`. `Engine.advance` treats it as it treats
`UnmodeledCardError` (`engine.ts:181-196`): it emits `engineHalt` and returns a halted
`GameResult`, so a live match ends visibly instead of crashing the server. When the engine runs
with `strictInvariants` (tests, the scenario runner, fuzz), it rethrows instead, so the failing
test points at the line.

### 2. Executor early exits are classified

Every early exit in `executeAbility` and its helpers goes through one of two helpers:

- `noop(ctx, reason, detail?)` for an exit the rules sanction. `reason` comes from a closed union
  (`targetIllegal`, `objectLeft`, `noCandidates`, `declined`, `conditionFalse`, `playerLeft`,
  `replacedOrPrevented`, …); each value carries the CR rule that sanctions it in its doc comment,
  and a reason without one is not added. `detail` is a function, called only when a sink exists,
  so production pays nothing.
- `invariant(ctx, reason, detail?)` for an exit only a bug can reach (`unboundReference`,
  `missingBinding`, `malformedIr`). It throws `EngineInvariantError`.

Neither touches the RNG, the game event log or the persisted debug log, so fixed-seed replay, event
hashes and benchmark hashes are unchanged.

The migration is staged so it cannot halt correct games. Every guard is first converted to `noop`
with a reason the main thread writes in a table (site, op, reason, CR rule), and nothing throws. A
histogram of reasons by site from the suite and the fuzz run then ranks the sites to examine; a
site the histogram never saw is a candidate, not proof. A site moves to `invariant` only with a
written argument that the rules cannot reach it from a validated definition, in its own commit,
with a test that reaches it through malformed IR.

### 3. Decision answers are checked where they are read

The 21 index-fallback sites fall into three classes, recorded in a table in the pull request:

- **True fallbacks** (for example `resolve.ts:2046, 2844, 4529, 5166, 5355, 7443, 9184`): they use
  `optionAt(options, outcome, label)`, which throws `EngineInvariantError` for an out-of-range
  index. `Engine.submit` already rejects such answers, so production behavior does not change.
- **Decline option already present** (for example `resolve.ts:6050-6061, 8670-8689`): the index
  past the list is the explicit decline option. No menu change; the read is made explicit.
- **Decline implied** (an index past the list means decline, but no option says so): the menu gains
  a decline option. This changes legal-action menus, so seeded random and heuristic picks and
  logged decisions change for those prompts. Each such site lands in its own commit with the
  benchmark rehash it causes, after confirming which presentation fields feed the AI hashes.

### 4. A diagnostics sink records what card abilities did

`createGame` is the one place a `GameContext` is built. It takes an optional sink from
`GameConfig.diagnostics` and, when the config has none, from a test-only default installed by
`installDefaultDiagnostics()` in a Vitest setup file. Production never installs one. This reaches
the 216 test files that build their own games without editing them. It is not the persisted
`debugLog`, which the server stores for every game (`match/runner.ts:500-505`).

Speculative work must not record. The payment probe's `clone()` already drops the sink. The cast
preview (`casting/preview.ts:58`) spreads the context and would keep it, so it drops it explicitly.
`castingCheckpoint` (`casting/checkpoint.ts`) records the sink's length and truncates it on
rollback, so an abandoned cast leaves no records. Each of the three has a test.

A record is `{ oracleId, abilityPath, effectIndex, op, outcome, reason? }`. The path is known where
an ability is put on the stack or resolved from its definition (the spell ability, `triggers[i]`,
`activatedAbilities[i]`, a mode index, an alternative cast or face), so it travels on the stack
object as an `origin` field. Copies keep the original's origin and are marked `copy`; abilities
granted by another permanent's static are marked `external` with the granting card's oracle id.
`applied` is written when an effect finishes without a `noop`.

### 5. Clauses are proven by execution, not by test names

The IR coverage run uses its own Vitest configuration (`vitest.ir-coverage.config.ts`), so the
execution configuration bound into primitive contract evidence does not change. A setup file
attaches each test's records to `task.meta` in `onTestFinished`; a reporter in the main process
reads `TestCase.meta()` and writes one `test-results/ir-coverage.json`, so nothing depends on worker
files.

Manifest `engineTestIds` have never been matched to executed tests; today they are checked as
substrings of source text. Of 2,446 unique IDs, 297 are `file::title` and the rest are title
prefixes or slugs; 47 are computed names with no literal source; 18 occur in more than one file;
231 live outside the `test:card-gate` files; 5 live only in suites skipped without bulk data. So the
check is introduced in three steps:

1. Define the matcher: an ID matches a test when the file (if given) is equal and the ID is a prefix
   of the test's full title. Report every ID with zero or several matches.
2. Normalize: replace computed names with explicit titles, disambiguate duplicates, and mark the
   bulk-only IDs `notExecutableInCi`.
3. Gate: for every `implemented-reviewed` card and every card whose snapshot entry changed against
   the base commit, every effect path in its final definition needs an `applied` record from one of
   its manifest tests, and every manifest ID must match exactly one executed test. Each mode,
   alternative cast and face is its own path, so a modal spell needs a test that applies each mode.

The gate runs only after the guard conversion of decision 2, since `applied` means nothing while
guards are unclassified. It runs after the full-suite job on non-draft pull requests, because 231
IDs live outside the card gate's files. Records marked `copy` or `external` count only for the
card that printed the ability. Negative tests are not checked this way; their assertions prove
them. Statics and replacement fields are not executed through `executeAbility` and stay proven by
their behavior tests. The plan measures the added suite time before the gate is turned on.

### 6. Oracle facets are cross-checked against the IR

`cards/facets.ts` extracts a small, closed set of facets from each Oracle clause (after reminder
text and self-name substitution, the same normalization `handledLines` uses) and from the IR built
for that clause:

| Facet            | Oracle text                                 | IR                                            |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| `other`          | "another", "other" in a subject or selector | a selector excluding the source               |
| `interveningIf`  | `, if` after a trigger condition (CR 603.4) | a trigger `condition` rechecked on resolution |
| `untilEndOfTurn` | "until end of turn"                         | an `…UntilEot` op or an end-of-turn duration  |
| `optional`       | "you may" before an instruction             | `optional: true` or a decline option          |
| `targetCount`    | each "target" and "up to N target"          | the ability's target slots and counts         |

A mismatch is a finding. The first three have one-to-one encodings and start the gate. `optional`
and `targetCount` have many encodings ("you may" as an optional cost, an alternative or a
permission; "any number of", "up to N"), so they stay report-only until they reach the bar below.

A facet joins the gate only when, over the 168 reviewed cards, at least 90% of its findings are
real defects or known modeling choices, and every finding is fixed or waived. Waivers live in
`tests/fixtures/facet-waivers.json`, keyed by oracle id, facet and the SHA-256 of the clause text,
with a reason. A waiver whose clause hash no longer matches expires and the finding returns.

The gate covers reviewed cards and cards whose `interpret-defs.json` or `override-defs.json` entry
changed against the base commit. It does not see a change made only in the executor; primitive
contracts cover those. A refactor that leaves both snapshots byte-identical changes no entry and
triggers nothing. The extractor's own test is the two pre-fix definitions from `5c8e41f`: it must
flag both and pass both fixes.

### 7. Catalog and merge rules are checked, not documented

- The inline-`TokenSpec` lint applies to all of `packages/engine/src` except `cards/tokens.ts`
  and `parseTokenFace`'s existing inline disable.
- `applyOverride(def, provenance)` receives the interpreter's line provenance (ADR 0031 decision
  6). A replace-mode override that removes a parsed entry from a line it neither claims in
  `handledLines` nor names in a new `replacesLines` field leaves the card `modeled: false` with the
  line named. `replacesLines` is how an override legitimately re-models a parsed line, as Desolate
  Mire's does. Entries the interpreter rewrites after its line loop are unattributed and never
  trip the check. Existing violations go to an exemptions list.

### 8. Tests and simulations check the whole state

`packages/engine/src/testing/invariants.ts` exports `checkStateInvariants(ctx)`. It returns
violations rather than throwing, so each caller decides. It runs only at priority checkpoints,
after state-based actions, and checks:

- object ids are unique across every zone, `phasedOut` and the stack, and each card id is in
  exactly one of them (spell copies, which have no card, are skipped);
- each attachment's host exists: a permanent, a player, or a graveyard card where the rules allow
  one (`sba.ts:356-369`);
- counters, life totals and mana pool amounts are safe integers, counters and mana nonnegative;
- every pending decision has at least one option;
- no seat's serialized `PlayerView` contains the object id or oracle id of a card in another
  player's hand or in any library, except library cards in that seat's `revealedLibraryTops`. This
  is a scan of the serialized view, not a re-derivation of the view's own logic.

The checker must not change the game. It never consumes RNG, and building a view can warm the layer
cache, so a test runs the determinism scenario with the checker on and off and requires identical
event logs and RNG state. The privacy scan runs on a sample of checkpoints in fuzz runs.

The first run's violations are either engine bugs, each fixed with a regression, or documented
exceptions encoded in the checker with a reason.

The test drivers (`drive()`, the scenario runner below), the Card Test Lab scenario tests and
`bun run fuzz` call it after every checkpoint and fail on any violation. Production games do not:
an import lint forbids `testing/invariants.ts` outside tests, tools and the scenario runner.

`bun run fuzz [--games N] [--seed S]` plays seeded games with the random and heuristic providers,
diagnostics, invariants and `strictInvariants` on. `pool --play` and `play-decks` read the
gitignored bulk Oracle file, so fuzz instead uses the committed coverage decks
(`packages/server/fixtures/coverage-decks/`) with the pinned `coverage-oracle.json`, as
`serve --oracle-fixture` already does; decks with unsupported cards are reported and left out. It
fails on any thrown error, invariant violation or exhausted decision budget, and prints the seed
and decks needed to reproduce. Per-game time is measured before the CI seed count is chosen. Fuzz
runs as its own parallel CI job, not inside the card gate, plus a scheduled workflow with a larger
budget. No AI provider is used.

A seed that starts failing after an unrelated change is a real bug that the change exposed, not
noise. The pull request either fixes it or moves the seed to `fuzz-known-failures.json` with an
issue link; known failures are re-run and reported every time and the list may only shrink.

### 9. Test drivers never guess

- `pump(gen, answer, { strict: true })` throws on an unforced decision the answer function does
  not handle, and prints its prompt and options. `script([...])` builds an answer function from an
  ordered list of expected decisions matched by prompt and option description; an unexpected
  decision or a leftover entry fails the test. A bare `() => ({ index: 0 })` is the same guess as
  no answer, so new tests use `script()`.
- `drive()` fails when a `once` rule of its `RuleBasedProvider` never fired. Falling back to the
  first option is opt-in, per rule.
- `expect.requireAssertions` is on in the Vitest configuration, so a test whose loop or
  `it.each([])` runs zero times fails instead of passing empty.
- A reporter fails CI on a test whose `task.mode` is `skip` or `todo` unless
  `tests/fixtures/allowed-skips.json` lists its file, count and reason; tests filtered out by `-t`
  or sharding are not counted. The reporter shares code with
  `scripts/contracts/primitive-reporter.ts`, which already records skips. The bulk-data `skipIf`
  suites are listed, and a scheduled job that supplies the bulk file fails on any skip, so a listed
  skip is still run somewhere.
- A pre-step script resolves every entry of `test:card-gate` as Vitest does (a substring filter
  over test file paths) and fails if one matches no file.
- One-argument `pump()` calls stay where they are. A custom rule in the `card-authoring` ESLint
  plugin reports them, and `tests/fixtures/lenient-pump-counts.json` holds the current count per
  file.

Every shrink-only list (lenient `pump()` counts, allowed skips, facet waivers, override
exemptions, card-named ops, fuzz known failures) is enforced by one script,
`scripts/check-ratchets.ts`. It compares each list against the base commit, which the card-gate
job already fetches, and fails when an entry is added without a reason or when a count goes up.
When an actual count falls below its listed count, the list must be lowered in the same pull
request.

### 10. One scenario format for engine tests and the Card Test Lab

Engine tests and Card Test Lab scenarios build the same thing: a prepared position, a sequence of
choices and expected results. The engine already has `PreparedScenarioSpec`
(`engine/src/testing/prepared-scenario.ts`) for the first part. A shared scenario runner adds:

- `pin(name)`, reading one content-addressed Oracle pin store whose hashes equal the manifest's
  `oracleSha256`, in place of new local `pinned()` helpers and per-batch `*-oracle.json` files;
- a decision script (decision 9) and expectations on zones, life, counters and events;
- `Engine.advance`/`Engine.submit` as the only driver, so every scenario uses the legal-action
  menu, priority and the stack;
- `strictInvariants`, invariants after every checkpoint, and the diagnostics sink.

One spec registers as an engine test and, through a server adapter, as a Card Test Lab scenario.
Viewer evidence stays bound as it is today: through `VIEWER_CATALOG` entries (`file` and `key`),
the discovery identity, `card-evidence-input` and trace hashes, and a fresh Playwright capture from
a clean tree. The adapter adds catalog entries; it does not change how evidence is bound or hashed.
Primitive contract evidence hashes the test dependency closure, so the runner lives in its own
modules rather than in `tests/fixtures.ts`, and contract tests do not import it.

New card batches use the runner; the 216 test files with their own `game()` or `pod()` setup are
not migrated wholesale.

### 11. Known gaps this ADR does not close

These test-suite weaknesses are real and stay open; each is a candidate for a later decision:

- snapshot scripts write by default, and `snapshots:check` proves only that the committed snapshot
  equals a regeneration, not that anyone read the diff;
- 217 test files read source text, and `card-test-lab-gate` asserts on Playwright spec text, so a
  comment can satisfy a check;
- 101 test files assert `modeled).toBe(true)`; IR coverage makes this insufficient for reviewed
  cards but does not forbid it;
- Playwright `skip` and `fixme` are invisible to the Vitest reporter, and "Require viewer traces"
  needs only one `trace.zip`.

## Consequences

- A misspelled binding, an out-of-range answer or a dropped parsed ability stops being a silent
  no-op. Each now leaves a card unsupported with a reason or fails a test at the line responsible.
- Reviewed cards gain a proof that each clause's effects ran in its positive tests. A manifest
  entry pointing at a test that never touched the card fails.
- The two semantic bugs of the last audit that type-checked would have been findings. The other
  three would not: one is caught by the wider lint, and two (Confiscation Coup's zero-energy
  payment and Rakdos Charm's damage sources) are executor semantics that only primitive contracts
  and behavior tests catch. This ADR does not claim more.
- Fixed-seed replay, the game event log, persisted debug logs, `PlayerView` and production
  performance are unchanged; diagnostics and invariants run only in tests and tools. The one
  exception is decision 3's decline-implied sites, whose new menu options change seeded choices;
  each lands with its own benchmark rehash.
- CI gains the facet check in the card gate, the IR coverage check after the full suite on
  non-draft pull requests, and a parallel fuzz job. The first two gate reviewed and changed cards
  and report for the rest, in line with the card gate's existing scope. Each step's added minutes
  are measured and recorded before it becomes required.
- A promoted invariant ends a live match with a visible halt, like an unmodeled card, rather than
  crashing the server.
- New tests are written against `script()` and the scenario runner. Old tests keep working.

## Alternatives rejected

- **Throw on every executor early exit.** Many exits are the rules; a blanket throw would halt
  correct games. The staged classification of decision 2 gets the same loudness for real bugs.
- **Put per-effect diagnostics in the debug log.** The server persists it for every game.
- **Runtime schema validation (zod or similar) of card data.** The IR is already typed and the
  validator already walks it; a second schema would drift from both.
- **Make the facet check a full Oracle-text generator.** Exact text generation is a large project
  with many false positives. Five precise facets catch the observed class at a fraction of the cost.
- **Migrate every existing test to strict drivers first.** It would stall card work for weeks.
  The ratchet makes all new tests strict immediately.
