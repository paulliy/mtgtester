# ADR 0032: Fail loud in card execution and in the tests that prove it

Status: Proposed

Date: 2026-10-27

Companion: [ADR 0031](0031-forge-informed-card-authoring.md) (faster card modeling) and the
implementation plan [card authoring speed and fail-loud execution](../plans/card-authoring-and-fail-loud.md).
Evidence: [Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

## Context

The brief's rule is "halt loudly, never guess" (§6.3). Most of the loud machinery already exists,
and this ADR keeps all of it:

- exhaustive `assertNever` dispatch over `Effect`, `AbilityCost`, selectors, values and conditions
  (card-engine-quality Phase 1);
- `validateCardDefinition` on every final merged definition, rejecting unknown fields and invalid
  references, with `enforceCardDefinition` turning invalid IR into `modeled: false` and a reason,
  and `assertValidModeledDefinition` throwing for custom and token definitions;
- `scripts/audit-card-ir.ts`, which fails when a fixture card is demoted by invalid IR without an
  `unsupported` manifest declaration;
- the `handledLines` drift guard, `failedRegistrations`, `conflictingRegistrations`, the override
  and interpretation snapshots, primitive contract evidence and the card gate;
- `UnmodeledCardError` halting a game, and `IllegalDecisionError` rejecting a provider answer that
  is not on the legal-action menu (`engine.ts:200-215`).

What still fails silently was measured at `8b93725`. Each item is a path where a mistake produces a
game that keeps running or a test that keeps passing.

1. **A stale compiled harness shadows the real one.** `packages/engine/tests/fixtures.js`,
   `fixtures.js.map`, `fixtures.d.ts` and `fixtures.d.ts.map` are tracked in git. `fixtures.js`
   (441 lines, last changed in `d588082`) is older than `fixtures.ts` (553 lines), and Vite resolves
   the extensionless `./fixtures` import to `.js` before `.ts`, so about 300 test files run a stale
   copy of the shared harness. An edit to `fixtures.ts` has no effect on them.
2. **References between instructions are not resolved.** A search effect's `bind` and
   `untapBoundIf`'s `binding` are free strings, read with `effectBindings.get(effect.binding) ?? []`
   (`resolve.ts:6797`). Changing Fabled Passage's binding to `'foundLnad'` gives an empty issue list
   from `validateCardDefinition`; in a game the land would never untap. "Life lost this way" is an
   accumulator three of the ten life-loss ops feed (`eachOpponentLosesLife`, `loseLifeTarget`,
   `loseHalfLifeTarget`, `resolve.ts:4306-4340`), so `eachPlayerLosesLife` followed by
   `gainLifeEqualToLifeLostThisWay` validates and gains nothing.
3. **Decision answers fall back to option 0.** Eight sites read `options[outcome.index] ??
options[0]` or an equivalent (`resolve.ts:1725, 2046, 2844, 4529, 5166, 5355, 7443, 9184`).
   `Engine.submit` validates production answers, so in a real game these are unreachable; tests
   drive generators directly with `pump()`, which bypasses that check, so a wrong index silently
   becomes the first option. About a dozen more sites default differently, mostly treating an index
   past the list as "decline", with or without an explicit decline option; those are intended.
4. **Executor early exits look the same.** The `executeAbility` switch has about 200 one-line
   `if (x === undefined | null) break | return | continue` guards. Some are the rules (CR 608.2b:
   an illegal target is not affected). Others are reachable only through an authoring or engine
   bug. Nothing distinguishes them.
5. **IR that validates but says something the card does not.** Two of the five bugs fixed in
   `5c8e41f` were of this kind: Securitron Squadron's trigger had an "another" the card does not
   print, and Overwhelming Instinct's event qualification was modeled as an intervening "if" the
   card does not have. Both type-checked, validated and had passing tests.
6. **The override merge can keep or drop the wrong parsed abilities.** `applyOverride` is a shallow
   spread. An override that sets `activatedAbilities` discards parsed entries from lines it does not
   claim; an override that models a parsed line in a different list leaves the parsed entry beside
   it, which is how Desolate Mire once offered its mana twice (ADR 0025 increment 4). Rule 4 in
   `overrides/index.ts` documents this; nothing checks it.
7. **Catalog bypass outside lint scope.** The inline-`TokenSpec` lint covers `overrides/**` and
   `interpret.ts`. Master of Ceremonies' Treasure without its sacrifice cost lived in `resolve.ts`
   (its `masterOfCeremonies` case, with a copy in the unused `createTreasureForDeaths`). The same
   selector over the rest of `packages/engine/src` finds 13 more literals in `capabilities.ts`,
   `resolve.ts` and `state/objects.ts`.
8. **Test drivers guess.** `pump()` answers every unforced decision it is not told about with index
   0 (`tests/fixtures.ts:337-355`); about 1,940 of its 2,638 calls, in 280 of the 303 files that use
   it, pass no answer. `RuleBasedProvider` falls back to the first option and never reports a rule
   that did not fire (`tests/fixtures.ts:370-398`).
9. **A test can claim a card without depending on it.** Manifest `engineTestIds` are checked only as
   substrings of test source text, and nothing checks that a test would fail if the card's behavior
   were wrong. A positive test asserting state that was already true passes.
10. **State corruption shows up late or not at all.** No routine check confirms that object ids are
    unique, that each card is in one zone, that attachments have hosts, or that a `PlayerView` hides
    other players' hands, except where a specific test happens to look.
11. **A listed test can stop running.** `test:card-gate` passes 158 entries to Vitest as substring
    filters, and Vitest ignores one that matches no file: a nonexistent path beside a real one exits 0. All 158 match today. Separately, 231 of the manifest's 2,446 engine test IDs live in files
    the card gate does not run. Forge added `TestSuiteIntegrityTest` after eight test classes
    stopped running and its CI stayed green for a year.

Recent escaped bugs are mostly rules interactions (ADR 0031 context), which no check below can find
by inspecting IR. Only tests that depend on behavior (decision 5) and games that explore states
nobody scripted (decision 8) reach that class.

## Decision

### 1. The real harness runs

The four stale compiled harness files are deleted in the first commit. A check fails when a tracked
`.js` or `.d.ts` file sits beside a `.ts` file of the same name under `packages/*/tests`.

### 2. Every reference between instructions resolves, or the card is unsupported

`validateCardDefinition` resolves every reference from one effect to another, with the scope the
executor actually has. `executeAbility` re-enters itself for nested bodies with fresh bindings
(`resolve.ts:1813-1815`; nested calls at 1729, 2048, 4804 and others), so a `binding` must name a
`bind` earlier in the same effect list, published unconditionally. A bind inside a conditional
branch, a repeatable mode or another invocation does not count. `gainLifeEqualToLifeLostThisWay`
must follow one of the three ops that feed its accumulator. Anything else is an authoring issue:
the card becomes `modeled: false` with the exact path. When ADR 0031's results exist, they follow
the scope rules stated there.

Only after this ships does the executor change: a binding that was never set (not one set to `[]`
by a search that found nothing, `resolve.ts:6016`) throws `EngineInvariantError`.

`EngineInvariantError` is a new class in `errors.ts`. `Engine.advance` treats it as it treats
`UnmodeledCardError` (`engine.ts:181-196`): it emits `engineHalt` and returns a halted `GameResult`,
so a live match ends visibly instead of crashing. `EngineOptions.strictInvariants` (set by the test
drivers, the scenario runner and fuzz) makes it rethrow, so the failing test points at the line.

### 3. Decision answers are checked where they are read

The main thread commits a table of every index site with its class before any change:

- **True fallbacks** (the eight sites above) read through `optionAt(options, outcome, label)`,
  which throws `EngineInvariantError` for an out-of-range index. `resolve.ts:4529`, which falls back
  through two lists, gets an equivalent explicit check. `Engine.submit` already rejects such
  answers, so production behavior does not change.
- **Decline sites**, with or without an explicit decline option, are left as they are, with the
  past-the-end read named by a `DECLINE_INDEX` constant. No menu changes, so seeded choices and
  benchmark inputs are unchanged.

### 4. Early exits are classified as cards touch them

There is no wholesale conversion of the ~200 guards. Two helpers exist:

- `invariant(ctx, site, reason)` throws `EngineInvariantError`. It replaces a guard when reference
  validation (decision 2) makes the guard unreachable from a validated definition, with a test that
  reaches it through malformed IR.
- `noop(ctx, site, reason, detail?)` records a rules-sanctioned exit. `site` is a literal string,
  `reason` comes from a closed union whose every value cites its CR rule, and `detail` is a function
  called only when a sink exists. It is added to an op when a card touches that op.

`noop` writes only to an optional test-only diagnostics sink: `createGame` takes it from
`GameConfig.diagnostics` or from `installDefaultDiagnostics()`, which a test setup file or the fuzz
CLI calls and production never does. The cast preview (`casting/preview.ts:58`) drops it, the
payment probe's `clone()` already does, and `castingCheckpoint` truncates it on rollback, so
speculative work records nothing. Neither helper touches the RNG, the game event log or the
persisted debug log.

### 5. Tests must depend on the card: manifest checks and IR mutation

Two checks replace trust in test names.

**Manifest references.** Each manifest `engineTestId` must match exactly one collected test: equal
to its full title, or its full title must start with the ID followed by `—`; where the ID names a
file, the file must match. The test's file must mention the card's name or oracle id. IDs with no
literal source (47 computed names) get explicit titles first; IDs that run only with the bulk file
are marked `notExecutableInCi`; the 18 that occur in several files are disambiguated.

**IR mutation.** For each `implemented-reviewed` card whose snapshot entry changed against the base
commit, a script applies a fixed set of mutations to the card's final definition, one at a time:
drop one effect, drop a trigger or ability condition, flip `optional`, widen a target or subject
selector to its unfiltered kind, change a constant amount by one. A test-only
`installDefinitionTransform()` hook, applied as `interpretCard` returns, mutates the definition,
so both games built by `createGame` and tests that interpret a card directly see it. Production
never installs it. The script runs the card's manifest tests once per mutation and requires at least one
failure. A surviving mutation fails the check unless the manifest clause carries a reason it is
equivalent (an effect that cannot matter in any state the card can reach).

Mutation proves what the manifest only asserts: that a test would notice if the card were wrong. It
needs no sink, no ability paths and no second full-suite run, because it runs only the changed
cards' tests. Changed but unreviewed cards get the same run as a report. A pull request whose
snapshot diff touches many cards for a refactor (a keyword move, a family merge) proves the refactor
with byte-identical snapshots instead, and the mutation run covers only cards whose entries
changed.

### 6. Oracle facets warn where IR and text disagree

`cards/facets.ts` compares a small set of facets between a card's Oracle text (after reminder text
and self-name substitution, the normalization `handledLines` uses) and its final definition, per
card rather than per clause, because 156 of the 168 reviewed cards are overrides with no clause-level
link to their IR:

| Facet            | Oracle text                                 | IR                                            |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| `other`          | "another", "other" in a subject or selector | a selector excluding the source               |
| `interveningIf`  | `, if` after a trigger condition (CR 603.4) | a trigger `condition` rechecked on resolution |
| `untilEndOfTurn` | "until end of turn"                         | an `…UntilEot` op or an end-of-turn duration  |
| `optional`       | "you may" before an instruction             | `optional: true` or a decline option          |
| `targetCount`    | each "target" and "up to N target"          | the ability's target slots and counts         |

Each facet is compared as a count: the number of occurrences in the text against the number in the
IR. A mismatch is a warning printed by `card:check` and by the card gate for changed cards. A known
modeling choice is recorded on the manifest card entry as `facetNotes: [{ facet, reason }]`, which
the warning then shows instead. The extractor's own test is the two pre-fix definitions from
`5c8e41f`: both must warn and both fixes must not. Warnings become a gate only after a facet finds
a real defect outside that fixture.

### 7. Catalog and merge rules are checked, not documented

- The inline-`TokenSpec` lint applies to all of `packages/engine/src` except `cards/tokens.ts` and
  `parseTokenFace`. The 13 literals it finds move into `tokens.ts` or carry an inline disable with a
  reason. The new flat-config entry is ordered before the existing `no-restricted-syntax` entries,
  which replace one another.
- `applyOverride(def, provenance)` (ADR 0031 decision 6) checks both directions of rule 4. An
  override that replaces a list and removes a parsed entry from a line it neither claims in
  `handledLines` nor names in a new `replacesLines` field leaves the card `modeled: false` with the
  line named. And every line in `handledLines` or `replacesLines` must have no parsed entry left in
  any list after the merge, which catches the duplicate Desolate Mire shipped. Unattributed entries
  never trip either check. Tests use a test-local `registerOverride`, since Desolate Mire's override
  no longer exists.

### 8. Tests and simulations check the whole state

`packages/engine/src/testing/invariants.ts` exports `checkStateInvariants(ctx)`, which returns
violations. A test-only checkpoint hook, called in `flow/game.ts` after state-based actions at each
priority checkpoint, runs it when `strictInvariants` is set. It checks:

- object ids are unique across every zone, `phasedOut` and the stack, and each card id is in exactly
  one of them (spell copies, which have no card, are skipped);
- each attachment's host exists: a permanent, a player, or a graveyard card where the rules allow one
  (`sba.ts:356-369`);
- counters, life totals and mana pool amounts are safe integers, counters and mana nonnegative;
- every pending decision has at least one option;
- no seat's serialized `PlayerView` contains the object id of a card in another player's hand or in
  any library, except library cards in that seat's `revealedLibraryTops`. Object ids, not oracle
  ids, because a basic land in a hand shares its oracle id with public ones.

The checker must not change the game: it consumes no RNG, and a test runs the determinism scenario
with it on and off and requires identical event logs and RNG state. An import lint forbids
`testing/invariants.ts` outside tests and tools. The first run's violations are either engine bugs,
each fixed with a regression, or exceptions encoded in the checker with a reason.

`bun run fuzz` (`packages/server/src/cli/fuzz.ts`) plays seeded four-player games with the random
and heuristic providers and `strictInvariants`. It uses the committed coverage decks with the pinned
`coverage-oracle.json`, the way `serve --oracle-fixture` does, because the `pool` and `play-decks`
CLIs read the gitignored bulk file. Those decks are fully modeled, so for each card changed in a pull
request fuzz also plays pods in which that card replaces a basic land. Each seed maps to a fixed pod
and a decision budget. It fails on a thrown error, an invariant violation or an exhausted budget,
and prints the seed and decks to reproduce.

On pull requests that touch `packages/engine/src`, fuzz runs as its own job and is advisory: an
engine change shifts the decision stream, so a seed can start failing on a bug the pull request did
not write. A nightly run with a larger budget is authoritative and opens an issue with the seed and
decks. Per-game time is measured before the PR seed count is chosen.

### 9. Test drivers never guess, and the suite cannot shrink unnoticed

- `pump(gen, answer, { strict: true })` throws on an unforced decision the answer function does not
  handle and prints its prompt and options. `script([...])` answers from an ordered list of expected
  decisions matched by prompt and option description; an unexpected decision or a leftover entry
  fails the test.
- `new RuleBasedProvider(rules, { fallback: 'first' })` makes first-option fallback opt-in, and
  `drive()` fails when a rule with `once: true` (the `whenChoose` default) never fired.
- A diff-based check on pull requests rejects one-argument `pump()` and `() => ({ index: 0 })`
  answers in added lines. Existing calls are untouched and no per-file counts are kept.
- `expect.requireAssertions` is on, so a test that runs no `expect` fails. A full-suite run with the
  flag found four such tests in three files (`fail-closed-restoration`, `marchesa-batch1-containment`,
  `tokens`), each fixed or given a real assertion. It does not catch an `it.each([])` that registers
  no tests; the suite-integrity check below covers suites that collect nothing.
- `it.skip`, `it.todo`, `describe.skip` and `.only` are rejected by lint unless the line carries an
  `// allowed-skip: <reason>` comment; bulk-data `skipIf` suites carry one. A scheduled job that
  supplies a checksum-pinned bulk Oracle file runs those suites and fails on any skip, and also runs
  `interpretCard` and `validateCardDefinition` over the whole bulk population, failing on a throw,
  invalid IR in a modeled card, or a drop in the modeled count.
- Suite integrity, as Forge's `TestSuiteIntegrityTest` does it: every tracked `*.test.ts` and
  `*.spec.ts` is claimed by exactly one runner (Vitest `include` or Playwright `testMatch`) and
  collects at least one test, and every entry of the card-gate list (ADR 0031 decision 1) matches at
  least one file.

Lists that must not grow (card-named ops, `notExecutableInCi` IDs) are checked against the base
commit by `scripts/check-ratchets.ts`; it copies the push-event base-SHA fallback from `ci.yml`.
Justified exceptions (skips, facet notes, equivalent mutations, invariant exceptions) live inline
beside what they excuse, with a reason, rather than in central files.

### 10. One scenario format for engine tests and the Card Test Lab

Engine tests and Card Test Lab scenarios build the same thing: a prepared position, choices and
expected results. `PreparedScenarioSpec` (`engine/src/testing/prepared-scenario.ts`) already covers
the position. A scenario runner (`packages/engine/tests/scenario/`) adds a seed, a decision script
(decision 9), expectations on zones, life, counters and events, and an end condition; it drives only
`Engine.advance`/`Engine.submit`, with `strictInvariants` on.

- `pin(name)` reads one content-addressed Oracle pin store, keyed by
  `sha256(JSON.stringify(card))`, equal to the manifest's `oracleSha256`. It throws on an unknown
  name. The runner throws on an unknown spec field or card name, unlike Forge's game-state loader,
  which logs and continues.
- New arrangement needs (another `goadedBy`, `foretold` or `continueThrough*`) become entries in a
  generic per-card modifier list, not new top-level fields.
- A server adapter turns the same spec into a `CardTestScenario` (`card-test-scenarios.ts:140`),
  registered the way `PR11_SCENARIOS` is, with scenario-ID lists derived from the registrations
  instead of hand-kept arrays. Playwright steps stay hand-written; viewer evidence stays bound as
  today, through the manifest's `viewerScenarioIds`, the scenario registry, the hand-written spec
  and `card-test-lab-gate.test.ts`.
- Primitive contract evidence hashes the test dependency closure, so the runner lives in its own
  modules and an import lint keeps contract tests from importing it.

New card batches use the runner; the existing per-file `game()`, `pod()` and `setup()` helpers are
not migrated wholesale.

### 11. Known gaps this ADR does not close

- Snapshot scripts write by default, and `snapshots:check` proves only that the committed snapshot
  equals a regeneration. `card:finish` prints a per-card semantic diff, but nothing proves it was
  read.
- 217 test files read source text, and `card-test-lab-gate` asserts on Playwright spec text, so a
  comment can satisfy a check.
- Playwright `skip` and `fixme` are invisible to the Vitest checks, and "Require viewer traces"
  needs only one `trace.zip`.
- Executor semantics (Confiscation Coup's zero-energy payment, Rakdos Charm's damage sources) are
  caught only by primitive contracts and behavior tests; mutation makes those tests trustworthy but
  does not write them.

## Consequences

- The shared harness tests actually run the code in `fixtures.ts`.
- A misspelled binding, an out-of-range test answer or a misapplied override stops being a silent
  no-op: each leaves a card unsupported with a reason or fails a test at the line responsible.
- A reviewed card's tests are shown to fail when its definition is wrong, not just to exist.
- Facets would have warned on both type-checked bugs of the last audit; the wider lint would have
  caught the third. Two remain the job of behavior tests.
- Fixed-seed replay, decision requests, seeded choices, persisted debug logs, `PlayerView` and
  production performance are unchanged. Benchmark compatibility pins hash every engine source file,
  so any engine-changing pull request re-seals them with
  `bun run ai-bench refresh --suite core-fast --write`, as today.
- A promoted invariant ends a live match with a visible halt rather than crashing the server.
- CI gains a ratchet and suite-integrity step and facet warnings in the card gate, a mutation job on
  non-draft pull requests that change reviewed cards, an advisory fuzz job on engine changes, and
  nightly fuzz and bulk-data jobs. Each step's added minutes are measured before it is required.

## Alternatives rejected

- **IR execution coverage** (recording which effects ran in which test). It proves an effect ran,
  not that any assertion depends on it, and needs ability paths threaded through the stack, a second
  Vitest configuration and a second full-suite run. Mutation is cheaper and proves more.
- **Convert all ~200 guards up front.** It costs a rules decision per site, conflicts with every
  card branch, and feeds only a histogram. Guards are classified as cards touch them.
- **Add decline options where an index past the list means decline.** It changes menus, seeded
  choices and benchmark inputs for no correctness gain.
- **Central shrink-only count files.** Per-file counts make every pull request touching a test a
  merge-conflict site; diff-based checks and inline reasons give the same protection.
- **Required fixed-seed fuzz on every pull request.** It would fail unrelated work whenever the
  decision stream shifts.
- **Put per-effect diagnostics in the debug log.** The server persists it for every game.
- **Runtime schema validation (zod or similar) of card data.** The IR is already typed and
  validated; a second schema would drift.
