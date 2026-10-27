# ADR 0034: Fail loud in card execution and in the tests that prove it

Status: Proposed

Date: 2026-10-27

Companion: [ADR 0033](0033-forge-informed-card-authoring.md) (faster card modeling) and the
implementation plan
[card authoring speed and fail-loud execution](../plans/card-authoring-and-fail-loud.md). Evidence:
[Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

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
   `fixtures.js.map`, `fixtures.d.ts` and `fixtures.d.ts.map` are tracked in git. `fixtures.js` (441
   lines, last changed in `d588082`) is older than `fixtures.ts` (553 lines), and Vite resolves the
   extensionless `./fixtures` import to `.js` before `.ts`, so about 300 test files run a stale copy
   of the shared harness. An edit to `fixtures.ts` has no effect on them.
2. **References between instructions are not resolved.** A search effect's `bind` and
   `untapBoundIf`'s `binding` are free strings, read with `effectBindings.get(effect.binding) ?? []`
   (`resolve.ts:6797`). Changing Fabled Passage's binding to `'foundLnad'` gives an empty issue list
   from `validateCardDefinition`; in a game the land would never untap. "Life lost this way" is an
   accumulator three of the ten life-loss ops feed (`eachOpponentLosesLife`, `loseLifeTarget`,
   `loseHalfLifeTarget`, `resolve.ts:4306-4340`), so `eachPlayerLosesLife` followed by
   `gainLifeEqualToLifeLostThisWay` validates and gains nothing.
3. **Values and conditions read missing scope as zero or false.** `effects/values.ts:197-220`
   returns `scope.damageDealt ?? 0`, `spellManaValue ?? 0`, `manaSpent ?? 0`, `energyPaid ?? 0`, and
   `cards/condition.ts` has about 20 `if (x === undefined) return false` guards. The scope is filled
   by the ability's trigger head or cast path, and nothing checks the pairing: a Nissa, Worldsoul
   Speaker enters trigger drawing `damageDealt` or `energyPaid` cards validates with no issue and
   draws zero.
4. **Decision answers fall back to option 0.** Eight sites read
   `options[outcome.index] ?? options[0]` or an equivalent
   (`resolve.ts:1725, 2046, 2844, 4529, 5166, 5355, 7443, 9184`). `Engine.submit` validates
   production answers, so in a real game these are unreachable; tests drive generators directly with
   `pump()`, which bypasses that check, so a wrong index silently becomes the first option. About a
   dozen more sites default differently, mostly treating an index past the list as "decline", with
   or without an explicit decline option; those are intended.
5. **Executor early exits look the same.** The `executeAbility` switch has about 200 one-line
   `if (x === undefined | null) break | return | continue` guards. Some are the rules (CR 608.2b: an
   illegal target is not affected). Others are reachable only through an authoring or engine bug.
   Nothing distinguishes them.
6. **IR that validates but says something the card does not.** Two of the five bugs fixed in
   `5c8e41f` were of this kind: Securitron Squadron's trigger had an "another" the card does not
   print, and Overwhelming Instinct's event qualification was modeled as an intervening "if" the
   card does not have. Both type-checked, validated and had passing tests.
7. **The override merge can keep or drop the wrong parsed abilities.** `applyOverride` is a shallow
   spread. An override that sets `activatedAbilities` discards parsed entries from lines it does not
   claim; an override that models a parsed line in a different list leaves the parsed entry beside
   it, which is how Desolate Mire once offered its mana twice (ADR 0025 increment 4). Rule 4 in
   `overrides/index.ts` documents this; nothing checks it.
8. **Catalog bypass outside lint scope.** The inline-`TokenSpec` lint covers `overrides/**` and
   `interpret.ts`. Master of Ceremonies' Treasure without its sacrifice cost lived in `resolve.ts`
   (its `masterOfCeremonies` case, with a copy in the unused `createTreasureForDeaths`). The same
   selector over the rest of `packages/engine/src` finds 13 more literals in `capabilities.ts`,
   `resolve.ts` and `state/objects.ts`.
9. **Test drivers guess.** `pump()` answers every unforced decision it is not told about with index
   0 (`tests/fixtures.ts:337-355`); about 1,940 of its 2,638 calls, in 280 of the 303 files that use
   it, pass no answer. `RuleBasedProvider` falls back to the first option and never reports a rule
   that did not fire (`tests/fixtures.ts:370-398`).
10. **A test can claim a card without depending on it.** Manifest `engineTestIds` are checked only
    as substrings of test source text, and nothing checks that a test would fail if the card's
    behavior were wrong. A positive test asserting state that was already true passes.
11. **State corruption shows up late or not at all.** No routine check confirms that object ids are
    unique, that each card is in one zone, that attachments have hosts, or that a `PlayerView` hides
    other players' hands, except where a specific test happens to look.
12. **A listed test can stop running.** `test:card-gate` passes 158 entries to Vitest as substring
    filters, and Vitest ignores one that matches no file: a nonexistent path beside a real one
    exits 0. All 158 match today. Separately, 231 of the manifest's 2,446 engine test IDs live in
    files the card gate does not run. Forge added `TestSuiteIntegrityTest` after eight test classes
    stopped running and its CI stayed green for a year.

Recent escaped bugs are mostly rules interactions (ADR 0033 context), which no check below can find
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
must follow one of the three ops that feed its accumulator. Anything else is an authoring issue: the
card becomes `modeled: false` with the exact path. When ADR 0033's results exist, they follow the
scope rules stated there.

Only after this ships does the executor change: a binding that was never set (not one set to `[]` by
a search that found nothing, `resolve.ts:6016`) throws `EngineInvariantError`.

`EngineInvariantError` is a new class in `errors.ts`, carrying the `site` that raised it.
`Engine.advance` treats it as it treats `UnmodeledCardError` (`engine.ts:181-196`): it emits
`engineHalt` and returns a halted `GameResult`, and the halt record keeps the site and the game
seed, which today's halt record (`match/runner.ts:322-336`, message only) loses.
`GameConfig.strictInvariants`, copied by `createGame` onto `GameContext` and passed through
`EngineOptions` by the test drivers, the scenario runner and fuzz, makes it rethrow, so the failing
test points at the line. The same field turns on the invariant checkpoint of decision 8.

Scope-dependent values and conditions get the same treatment. Each `Value` and `Condition` kind that
reads the evaluation scope (`damageDealt`, `spellManaValue`, `manaSpent`, `energyPaid`,
`triggerCount`, the trigger object's facts, …) declares which scope fields it needs, and each
trigger head, cast path and activation declares which fields it provides, in a table checked for
exhaustiveness like the existing contracts. `validateCardDefinition` rejects a kind used where its
fields are not provided. Once that ships, the executor's `?? 0` and `return false` reads of an
absent required field become `EngineInvariantError`, one kind per commit with a malformed-IR test.

### 3. Decision answers are checked where they are read

The main thread commits a table of every index site with its class before any change:

- **True fallbacks** (the eight sites above) read through `optionAt(options, outcome, label)`, which
  throws `EngineInvariantError` for an out-of-range index. `resolve.ts:4529`, which falls back
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
`GameConfig.diagnostics` or from `installDefaultDiagnostics()`, which the fuzz CLI calls and
production never does. Its readers are the fuzz liveness report (decision 8), which lists, per card
in play, the ops that only ever took a `noop` exit, and the reason histogram a guard's promotion to
`invariant` is argued from. The cast preview (`casting/preview.ts:58`) drops it, the payment probe's
`clone()` already does, and `castingCheckpoint` truncates it on rollback, so speculative work
records nothing. Neither helper touches the RNG, the game event log or the persisted debug log.

### 5. Tests must depend on the card: manifest checks and IR mutation

Two checks replace trust in test names.

**Manifest references.** Each manifest `engineTestId` must match exactly one collected test: equal
to its full title, or its full title must start with the ID followed by `—`; where the ID names a
file, the file must match. The test's file must mention the card's name or oracle id. IDs with no
literal source (47 computed names) get explicit titles first; IDs that run only with the bulk file
are marked `notExecutableInCi`; the 18 that occur in several files are disambiguated.

**IR mutation.** For each `implemented-reviewed` card whose snapshot entry changed against the base
commit, `scripts/mutate-cards.ts` applies mutations to the card's final definition one at a time and
runs the card's manifest tests once per mutation.

The mutation is applied by a test-only `installDefinitionTransform()` hook at the two places a
definition enters a game or a test: the exported `interpretCard` (once, in the public entry point,
not in its recursive calls for split halves and synthetic faces, `interpret.ts:7422, 7586`) and
`createGame`'s `customDefinitions`. A test that builds an ability by hand and passes it to
`executeAbility` never sees the mutation; such a test cannot prove the card, so a mutation the hook
never applied during a run is reported as **unreached** and fails the check, which pushes the card's
evidence toward tests that load the card itself.

| IR shape                   | Mutations                                                        |
| -------------------------- | ---------------------------------------------------------------- |
| effect list                | drop each effect                                                 |
| trigger                    | drop `condition` or `eventCondition`; widen the subject selector |
| target slot                | widen the filter to the slot's kind                              |
| `optional`                 | flip it                                                          |
| constant `Value`           | add one; subtract one when above zero                            |
| modes                      | drop each mode                                                   |
| activated or mana ability  | drop each non-mana cost; drop each mana ability                  |
| static effect, rule static | drop each entry                                                  |
| replacement field          | flip `entersTapped`; remove `entersWithCounters`                 |
| keyword flag               | drop each keyword                                                |

Every top-level ability, static, replacement field and keyword of the card yields at least one
mutant, so a static-only card is not exempt. A mutant counts as **killed** only when one of the
manifest tests fails on an assertion (`expect`); a test that crashes, times out or fails a strict
driver does not kill it, because those failures do not show that an assertion depends on the card. A
surviving mutant fails the check unless the card's manifest entry records why it is equivalent (it
cannot change anything in a state the card can reach), a main-thread decision.

Mutation proves what the manifest only asserts: that a test would notice if the card were wrong. It
runs only the changed cards' tests, with its hook installed through a separate
`vitest.mutation.config.ts`. Changed but unreviewed cards get the same run as a report. A pull
request whose snapshot diff touches many cards for a refactor (a keyword move, a family merge)
proves the refactor with byte-identical snapshots instead; the mutation run covers only cards whose
entries changed.

### 6. Oracle facets warn where IR and text disagree

`cards/facets.ts` compares a small set of facets between a card's Oracle text (after reminder text
and self-name substitution, the normalization `handledLines` uses) and its final definition, per
card rather than per clause, because 156 of the 168 reviewed cards are overrides with no
clause-level link to their IR:

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
`5c8e41f`, taken from `tests/fixtures/override-defs.json` at its parent commit and committed as a
fixture: both must warn and both fixes must not. Warnings become a gate only after a facet finds a
real defect outside that fixture.

### 7. Catalog and merge rules are checked, not documented

- The inline-`TokenSpec` lint applies to all of `packages/engine/src` except `cards/tokens.ts` and
  `parseTokenFace`. The 13 literals it finds move into `tokens.ts` or carry an inline disable with a
  reason. The new flat-config entry is ordered before the existing `no-restricted-syntax` entries,
  which replace one another.
- `applyOverride(def, provenance)` (ADR 0033 decision 6) checks both directions of rule 4. An
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
- each attachment's host exists: a permanent, a player, or a graveyard card where the rules allow
  one (`sba.ts:356-369`);
- counters, life totals and mana pool amounts are safe integers, counters and mana nonnegative;
- every pending decision has at least one option;
- no seat's serialized `PlayerView` contains the object id of a card in another player's hand or in
  any library, except library cards in that seat's `revealedLibraryTops`. Object ids, not oracle
  ids, because a basic land in a hand shares its oracle id with public ones.

`strictInvariants` also turns on sampled verification of layer-cache hits, which today runs only
under `MTG_VERIFY_LAYER_CACHE=1` (`effects/layer-cache.ts:22-26`) because verifying every hit is
about twenty times slower; fuzz and the nightly run sample it.

Two structural rules join the checks. Zone mutations (`battlefield.push`, `library.splice` and their
kin) are allowed only in `state/objects.ts`; a lint flags the 12 sites outside it, such as the
hand-rolled search at `resolve.ts:2815-2819`, which skips the player's choice and entry
replacements, and each either moves to the shared helpers or carries a reason. And the test table of
every site that taps a permanent asserts whether it queues `becomesTapped`;
`consumeRegenerationShield` (`state/objects.ts:691`) taps without it.

The checker must not change the game: it consumes no RNG, and a test runs the determinism scenario
with it on and off and requires identical event logs and RNG state. An import lint forbids
`testing/invariants.ts`, `installDefaultDiagnostics` and `installDefinitionTransform` outside tests
and tools. The first run's violations are either engine bugs, each fixed with a regression, or
exceptions encoded in the checker with a reason.

`bun run fuzz` (`packages/server/src/cli/fuzz.ts`) plays seeded four-player games with the random
and heuristic providers and `strictInvariants`. It uses the committed coverage decks with the pinned
`coverage-oracle.json`, the way `serve --oracle-fixture` does, because the `pool` and `play-decks`
CLIs read the gitignored bulk file. Those decks are fully modeled, so for each card changed in a
pull request fuzz also plays pods in which that card, read from the shared pin store (decision 10),
replaces a basic land. The decks are used as committed (two have 102 cards); fuzz tests the engine,
not deck legality. Each seed maps to a fixed pod and a decision budget. It fails on a thrown error,
an invariant violation, an exhausted budget, a halted result (`UnmodeledCardError` and the turn cap
both end a game as `halted` rather than throwing, `engine.ts:181-196`, `flow/game.ts:92-96`), a
per-game wall-clock limit, or a per-checkpoint step cap that catches a loop that never yields
(`sba/sba.ts` and `turn/priority.ts` have unbounded `for (;;)` loops). It reports the AI fallback
count and the bot's empty-veto path, and fails when either fires in a heuristic-only run, and prints
the seed and decks to reproduce. Alongside, it writes the liveness report: for each card in play,
the ops that only ever took a `noop` exit.

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
- A pull-request check parses the changed test files (AST, so prettier's line wrapping does not
  matter) and rejects any `pump()` call that is new or changed against the base without an answer
  that is a `script()` or without `{ strict: true }`, and any `() => ({ index: 0 })` answer.
  `pumpStrict(gen)` is the accepted form for a generator expected to raise no unforced decision.
  Renamed files are compared with their base version. Existing calls are untouched and no per-file
  counts are kept.
- `expect.requireAssertions` is on, so a test that runs no `expect` fails. A full-suite run with the
  flag found four such tests in three files (`fail-closed-restoration`,
  `marchesa-batch1-containment`, `tokens`), each fixed or given a real assertion. It does not catch
  an `it.each([])` that registers no tests; the suite-integrity check below covers suites that
  collect nothing.
- `it.skip`, `it.todo`, `describe.skip` and `.only` are rejected by lint unless the line carries an
  `// allowed-skip: <reason>` comment; bulk-data `skipIf` suites carry one. A scheduled job that
  supplies a checksum-pinned bulk Oracle file runs those suites and fails on any skip, and also runs
  `interpretCard` and `validateCardDefinition` over the whole bulk population, failing on a throw,
  invalid IR in a modeled card, or a drop in the modeled count.
- Suite integrity, as Forge's `TestSuiteIntegrityTest` does it: every tracked `*.test.ts` and
  `*.spec.ts` is claimed by exactly one runner (Vitest `include` or Playwright `testMatch`) and
  collects at least one test, and every entry of the card-gate list (ADR 0033 decision 1) matches at
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
`Engine.advance`/`Engine.submit`, with `strictInvariants` on, and fails on a halted result.

- `pinStore.get(name)` reads one content-addressed Oracle pin store, keyed by
  `sha256(JSON.stringify(card))`, equal to the manifest's `oracleSha256`. It throws on an unknown
  name. Existing per-file `pinned()` and `pin()` helpers stay and are not migrated. The runner
  throws on an unknown spec field or card name, unlike Forge's game-state loader, which logs and
  continues.
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

- Non-damage replacement effects are folded in battlefield order (`state/queries.ts:1696-1710`): a
  "+1 counter" and a "twice that many" give 3 or 4 counters depending on order, with no choice for
  the affected player (CR 616.1). Only damage modifiers ask. A rule that every site folding two or
  more non-commuting replacement statics uses an ordering helper or throws is a candidate; a
  two-replacement scenario is added to the runner's first batch.
- `stripReminderText` (`interpret.ts:289`) deletes any parenthetical, so a parenthetical carrying
  rules text would drop silently. No real card in the fixtures does this; a facet warning for a
  parenthetical containing a rules verb is a candidate.
- Dead code reads as coverage: `createTreasureForDeaths` and `safestFallback` (which has substring
  bugs) have no production callers. A dead-export check is a candidate.
- `catch {}` blocks in the server (`match/preview.ts:199`, `match/session.ts:1141`) drop the cause.

- Snapshot scripts write by default, and `snapshots:check` proves only that the committed snapshot
  equals a regeneration. `card:finish` prints a per-card semantic diff, but nothing proves it was
  read.
- 217 test files read source text, and `card-test-lab-gate` asserts on Playwright spec text, so a
  comment can satisfy a check.
- Playwright `skip` and `fixme` are invisible to the Vitest checks, and "Require viewer traces"
  needs only one `trace.zip`.
- 101 test files assert `modeled).toBe(true)`, some as their only check, and 52 `vi.mock` or
  `vi.spyOn` uses are not checked for being asserted. Mutation covers this for reviewed cards only.
- Executor semantics (Confiscation Coup's zero-energy payment, Rakdos Charm's damage sources) are
  caught only by primitive contracts and behavior tests; mutation makes those tests trustworthy but
  does not write them.

## Consequences

- The completion standard in `card-modeling-and-testing.md` is unchanged except that it gains the
  manifest-reference and mutation checks; its note that `pump()` defaults to option 0 is updated
  with the strict drivers.
- The shared harness tests actually run the code in `fixtures.ts`.
- A misspelled binding, an out-of-range test answer or a misapplied override stops being a silent
  no-op: each leaves a card unsupported with a reason or fails a test at the line responsible.
- A changed reviewed card's tests are shown to fail, on an assertion, under each mutation in the
  table, not just to exist. Bugs no mutation models (wrong zone, wrong player, wrong duration) are
  not covered, and existing reviewed cards are mutated once as a report and then again only when
  changed.
- Of the five bugs fixed in `5c8e41f`, facets are regression-tested to warn on two and the wider
  lint catches a third; the other two remain the job of behavior tests.
- Fixed-seed replay, decision requests, seeded choices, persisted debug logs, `PlayerView` and
  production performance are unchanged. Benchmark compatibility pins hash every engine source file,
  so any engine-changing pull request re-seals them with
  `bun run ai-bench refresh --suite core-fast --write`, as today.
- An invariant failure in a live match ends it with a halt that names the site and the seed.
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
