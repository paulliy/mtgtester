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
2. **Every executor early exit looks the same.** The `executeAbility` switch has 198 one-line
   `if (x === undefined | null) break | return | continue` guards. Some are the rules (CR
   608.2b: an illegal target is not affected; "if you do" after a declined choice). Others are
   authoring or engine bugs (an unbound reference, a slot an earlier effect emptied by mistake).
   Nothing records which one happened.
3. **Decision answers fall back to option 0.** 21 sites read `options[outcome.index] ?? options[0]`
   or an equivalent (`resolve.ts:1725, 2046, 2844, 4529, 5166, 5355, 7443, 9184` and others in
   `resolve.ts`, `sba.ts`, `damage-modifiers.ts`, `choose.ts`). `Engine.submit` validates
   production answers, so in a real game these are unreachable. Tests drive generators directly
   with `pump()`, which bypasses that check, so a wrong index silently becomes the first option.
   Some sites use an index past the end as "decline"; those are intended, not fallbacks.
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
   `resolve.ts` (`createTreasureForDeaths`), where the lint does not apply.
7. **Test drivers guess.** `pump()` answers every unforced decision it is not told about with
   index 0 (`tests/fixtures.ts:337-355`); about 1,236 of its 2,639 calls pass no answer at all.
   `RuleBasedProvider` falls back to the first option and never reports a rule that did not fire
   (`tests/fixtures.ts:370-398`). A `whenChoose` with a misspelled option silently does nothing.
8. **A test can claim a clause without executing it.** The verification manifest maps each Oracle
   clause to test IDs, but nothing checks that those tests ran the clause's ability and that its
   effects were applied. A positive test asserting state that was already true passes.
9. **State corruption shows up late or not at all.** No routine check confirms that object ids
   are unique, that each card is in one zone, that attachments point at live permanents, or that a
   `PlayerView` hides other players' hands, except where a specific test happens to look.

Forge, the reference engine compared in the companion review, does not solve these either: most of
its script errors surface at run time or not at all, and it has few card-level tests. This ADR is
about what our typed IR lets us do that a string-based script cannot.

## Decision

### 1. Every reference between instructions resolves, or the card is unsupported

`validateCardDefinition` resolves every reference from one effect to another in an ability: a
`binding` must name a `bind` (and, after ADR 0031 decision 2, a result reference must name a
result) published by an earlier effect of the same ability, in the same mode, with a compatible
kind. Until results replace it, `gainLifeEqualToLifeLostThisWay` is valid only after an op that
feeds the accumulator. Anything else is an authoring issue, so the card becomes `modeled: false`
with the exact path, through the existing `enforceCardDefinition` route. The executor's `?? []`
for a missing binding becomes an `EngineInvariantError`, which can now only be reached by an engine
bug.

`EngineInvariantError` is a new class in `errors.ts`. Like any non-`UnmodeledCardError`, it
propagates out of `Engine.advance()` and fails the game and the test loudly.

### 2. Executor early exits are classified

Every early exit in `executeAbility` and its helpers goes through one of two helpers:

- `noop(reason, detail)` for an exit the rules sanction. `reason` comes from a closed union:
  `targetIllegal`, `objectLeft`, `noCandidates`, `declined`, `conditionFalse`, `playerLeft`,
  `zeroAmount`, `alreadyInState`, `replacedOrPrevented`. Each value names the CR rule that
  sanctions it in a doc comment.
- `invariant(reason, detail)` for an exit that only a bug can reach (`unboundReference`,
  `missingBinding`, `malformedIr`, `unexpectedZone`). It throws `EngineInvariantError`.

`noop` writes to an optional diagnostics sink (decision 4). It never touches the RNG, the game
event log or the persisted debug log, so fixed-seed replay, event hashes and benchmark hashes are
unchanged.

The migration is staged so it cannot halt correct games. First every guard is converted to `noop`
with its best reason and nothing throws. The full suite and the fuzz job (decision 8) then produce a
histogram of reasons by site. A site moves to `invariant` only when the histogram and a reading of
the code agree that the rules never reach it, and it moves in its own commit with a test that
reaches it through malformed IR.

### 3. Decision answers are checked where they are read

The 21 index-fallback sites are read one by one. Where an index past the list means "decline", the
option list gains an explicit decline option with `role: 'decline'`, as `choose.ts` already does.
Every other site uses one helper, `optionAt(options, outcome, label)`, which throws
`EngineInvariantError` for an out-of-range index. Production behavior does not change because
`Engine.submit` already rejects such answers. Tests that drive generators directly stop guessing.

### 4. A diagnostics sink records what card abilities did

`GameConfig.diagnostics` carries an optional sink into `GameContext.diagnostics`. It is absent in
production games and present in tests, fuzz runs and the coverage tools. It is not the persisted
`debugLog`, which the server stores for every game (`match/runner.ts:500-505`) and which would grow
with one entry per effect. A context copied for a speculative run (a stateful payment probe, a bot
combat search) drops the sink, so only the authoritative game records.

A record is `{ oracleId, effect, op, outcome: 'applied' | 'noop', reason? }`, where `effect` is the
effect's canonical JSON. Abilities are copied, flattened from modes and rebuilt on the stack, so
object identity cannot locate an effect in its definition; its canonical form can. The coverage
tools map records to definition paths (`definition.triggers[1].effects[0]`, the form the validator
already reports). The sink holds nothing the engine does not already know and is never sent to a
provider or a viewer.

### 5. Clauses are proven by execution, not by test names

With the sink on, a Vitest setup file stores records under the running test's name and writes them
to `test-results/ir-coverage/`. `bun run ir-coverage:check` merges them and, for every
`implemented-reviewed` card and every card whose snapshot entry changed against the base commit:

- requires at least one `applied` record for every effect in the card's final definition, within
  the card's manifest `engineTestIds`. Each mode, alternative cast and face is its own path, so a
  modal spell needs a test that applies each mode;
- where line provenance (ADR 0031 decision 6) maps an ability to a clause, narrows that to the
  clause's own test IDs;
- fails on a manifest test ID that matches no executed test, or more than one.

An effect whose canonical form appears more than once in one card is credited at each occurrence.
This over-approximation is documented and small; the manifest's positive and negative tests per
clause still apply. Negative tests are not checked this way; their assertions prove them. Statics
and replacement fields are not executed through `executeAbility` and stay proven by their behavior
tests.

The check reports for every other card and gates only reviewed and changed ones, so it never
blocks unrelated work.

### 6. Oracle facets are cross-checked against the IR

`cards/facets.ts` extracts a small, closed set of facets from each Oracle clause (after reminder
text and self-name substitution, the same normalization `handledLines` uses) and from the IR built
for that clause:

| Facet            | Oracle text                                 | IR                                            |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| `other`          | "another", "other" in a subject or selector | a selector excluding the source               |
| `interveningIf`  | `, if` after a trigger condition (CR 603.4) | a trigger `condition` rechecked on resolution |
| `optional`       | "you may"                                   | `optional: true` or a decline option          |
| `untilEndOfTurn` | "until end of turn"                         | an `…UntilEot` op or an end-of-turn duration  |
| `targetCount`    | each "target" and "up to N target"          | the ability's target slots and counts         |

A mismatch is a finding. Findings for `implemented-reviewed` cards and for cards changed in the
pull request fail the card gate unless `tests/fixtures/facet-waivers.json` names the card, the
facet and a reason. Findings for the rest of the population go to a ranked audit report.

The facet set starts with these five because they are high-precision and are the ones the last
audit missed. A facet joins the gate only after it is run over the 168 reviewed cards and each
finding is either fixed or waived with a reason. The extractor's own test is the two pre-fix
definitions from `5c8e41f`: it must flag both and pass both fixes.

### 7. Catalog and merge rules are checked, not documented

- The inline-`TokenSpec` lint applies to all of `packages/engine/src` except `cards/tokens.ts`
  and `parseTokenFace`'s existing inline disable.
- `applyOverride` receives the interpreter's line provenance (ADR 0031 decision 6). A
  replace-mode override that removes a parsed entry from a line it does not claim leaves the card
  `modeled: false` with the line named. The fix is `extendCard` or claiming the line. Existing
  cards that trip this are listed in an exemptions fixture by oracle id, and the list may only
  shrink.

### 8. Tests and simulations check the whole state

`packages/engine/src/testing/invariants.ts` exports `checkStateInvariants(ctx)`. It returns
violations rather than throwing, so each caller decides. It runs only at priority checkpoints,
after state-based actions, and checks:

- object ids are unique across zones and the stack, and each card id is in exactly one zone;
- attachments point at permanents that exist;
- counters, life totals and mana pool amounts are safe integers, counters and mana nonnegative;
- every pending decision has at least one option;
- a continuous effect that lasts while its source is on the battlefield has a live source;
- each player's `PlayerView` is structurally private: its hand is exactly that player's hand,
  opponents expose a hand size only, and library cards appear only in `revealedLibraryTops`, which
  equals `visibleLibraryTops(ctx, viewer)`. Event-log filtering keeps its own tests.

The first run's violations are either engine bugs, each fixed with a regression, or documented
exceptions encoded in the checker with a reason (spell copies have no card, for example).

The test drivers (`drive()`, the scenario runner below), the Card Test Lab scenario tests and a
new `bun run fuzz` call it after every checkpoint and fail on any violation. Production games do
not call it.

`bun run fuzz [--games N] [--seed S]` plays seeded games over the supported pool with the random
and heuristic providers, diagnostics and invariants on. It fails on any thrown error, invariant
violation or exhausted decision budget, and prints the seed and decks needed to reproduce. CI runs
a fixed small set of seeds in the card gate job (target: under three minutes); a scheduled
workflow runs a larger budget. No AI provider is used, so CI stays deterministic and keyless.

### 9. Test drivers never guess

- `pump(gen, answer)` gains `strict` mode, in which an unforced decision without an answer throws
  and prints its prompt and options. `script([...])` builds an answer function from an ordered
  list of expected decisions matched by prompt and option description. Leftover entries fail the
  test.
- `drive()` fails when a `once` rule of its `RuleBasedProvider` never fired. Falling back to the
  first option needs `{ fallback: 'first' }` on the provider.
- A Vitest reporter fails CI on a skipped or `todo` test not listed with a reason in
  `tests/fixtures/allowed-skips.json` (the bulk-data `skipIf` suites are listed).
- Lenient `pump()` calls stay where they are. A lint rule rejects a one-argument `pump()` in any
  test file not in a committed list of current files, and that list may only shrink. New tests are
  strict without any migration of the 1,236 existing calls.

### 10. One scenario format for engine tests and the Card Test Lab

Engine tests and Card Test Lab scenarios build the same thing: a prepared position, a sequence of
choices and expected results. The engine already has `PreparedScenarioSpec`
(`engine/src/testing/prepared-scenario.ts`) for the first part. A shared scenario runner adds:

- `pin(name)`, reading one content-addressed Oracle pin store and verifying its hash, in place of
  the 44 local `pinned()` helpers and the per-batch `*-oracle.json` files;
- a decision script (decision 9) and expectations on zones, life, counters and events;
- `Engine.advance`/`Engine.submit` as the only driver, so every scenario uses the legal-action
  menu, priority and the stack;
- invariants after every checkpoint and the diagnostics sink on.

One spec registers as an engine test and, through a server adapter, as a Card Test Lab scenario,
so a clause's engine evidence and viewer scenario come from one definition. New card batches use
the runner; the 216 test files with their own `game()` or `pod()` setup are not migrated
wholesale.

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
  performance are unchanged; diagnostics and invariants run only in tests and tools.
- CI gains the IR coverage check, the facet check and a small fuzz run. Each gates reviewed and
  changed cards and reports for the rest, in line with the card gate's existing scope.
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
