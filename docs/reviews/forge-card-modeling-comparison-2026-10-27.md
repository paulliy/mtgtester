# Forge and MTG Tester card modeling compared (2026-10-27)

This review compares how [Forge](https://github.com/Card-Forge/forge) models cards with how this
repository does, to decide what would make our card modeling faster and less error-prone. It is the
evidence for [ADR 0031](../decisions/0031-forge-informed-card-authoring.md) and
[ADR 0032](../decisions/0032-fail-loud-execution-and-strict-tests.md).

Method. Forge was read at commit `6a2dcdc` (2026-10-27) from source; nothing was compiled or run.
Corpus counts come from regex scans of all 34,131 card scripts and are good to a few percent.
Forge enum sizes were counted from the enum sources. Our side was measured at `8b93725`, partly by
running `interpretCard` and `validateCardDefinition` on probe inputs. Forge paths below are relative
to its repository root; `FG` is `forge-game/src/main/java/forge/game`. Forge is GPL-3.0: this
review describes its design and copies none of its code or scripts.

## Summary

Forge is fast to extend because a card is a few lines of a terse script over a large, generic
vocabulary: 202 keywords that expand by themselves, 204 parameterized effect types chained by
`SubAbility$`, a shared reference vocabulary for "the target", "its controller", "the remembered
cards" and "the triggering card", 858 named token scripts, and `Count$` value expressions. A new
card is usually a copy of a similar card's script with its parameters changed.

Forge is error-prone for the same reason. Parameters are untyped strings. A misspelled parameter is
ignored, a misspelled trigger filter widens the trigger, a missing sub-ability is dropped with a
`println`, an unknown `Count$` evaluates to zero, and an unknown property in a filter evaluates to
false. Only enum-typed names (effect type, trigger mode, static mode, replacement event, zone) throw,
and only when a card is put into a game. About 500 of 35,058 card faces appear in any test.

We have the opposite trade. Our IR is a discriminated union checked by the compiler and by
`validateCardDefinition`; our evidence standard is far stronger. But our vocabulary grows by one op
per unusual card, keywords mostly do not expand by themselves, effects cannot name what an earlier
effect did except through special cases, and each new primitive is five coordinated edits.

The lesson is to take Forge's vocabulary design and keep our typing and evidence: a keyword
registry, typed results between instructions, a rule against card-shaped primitives, one module per
primitive, and an authoring tool that starts from the nearest modeled card.

## Side by side

| Concern                 | Forge                                                                                                                                                                    | MTG Tester                                                                                                                                                                 | Lesson                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Card source             | One hand-written `.txt` script per card; `Oracle:` line synced from Scryfall by a script and never compared with the logic                                               | Oracle text parsed by `interpret.ts` (9,225 lines); unparsed lines need a TypeScript override naming them in `handledLines`                                                | Keep the parser; it models thousands of cards with no per-card work. Check its output (ADR 0032 facets) |
| Keywords                | `Keyword` enum, 202 real keywords; `CardFactoryUtil` expands each into abilities, triggers, statics or replacements (194 branches, 4,165 lines)                          | 23 flag keywords plus ward and protection; others are branches of the interpreter cascade, single-card regexes or re-authored per card; 5 of 37 probed keyword lines model | Keyword registry (ADR 0031 decision 2)                                                                  |
| Effect vocabulary       | `ApiType`, 204 types over 201 effect classes, each generic and parameterized                                                                                             | `Effect` union, 344 ops; 32 with `And` in the name, at least 15 named after a card                                                                                         | Parameterize instead of minting (decision 4)                                                            |
| Composition             | `SubAbility$` chains; `Defined$ Targeted`, `TargetedController`, `Remembered`, `Imprinted`, `Triggered<Key>`, `…LKI`                                                     | `effects: Effect[]` in order; `EffectRef` has six forms; `bind` strings and a hidden `lifeLostThisWay` accumulator                                                         | Typed results (decision 3)                                                                              |
| Cross-instruction state | `Remember`/`Imprint` lists on the card, cleared by hand with `DB$ Cleanup` (3,043 uses); LKI versus live object chosen by spelling (`Remembered` versus `RememberedLKI`) | Resolution-scoped `effectBindings` and `resolutionObjectFacts`; LKI tracked by `movedReferent`                                                                             | Results are resolution-scoped (no cleanup step) and carry LKI by type, not by spelling                  |
| Filters                 | Valid expressions `Creature.Other+YouCtrl+cmcLE3`; unknown properties evaluate false                                                                                     | `Selector` union, 45 kinds, validated                                                                                                                                      | Ours is safer; keep it                                                                                  |
| Values                  | `Count$` expressions in SVars, about 190 heads; unknown text evaluates to 0                                                                                              | `Value` union, 56 kinds, validated                                                                                                                                         | Ours is safer; keep it                                                                                  |
| Triggers                | `TriggerType` enum, 149 modes; filters are params                                                                                                                        | `TriggerSpec` (`TriggerHead` plus `condition`, the intervening if, and `eventCondition`)                                                                                   | Equivalent; we separate intervening-if from qualification explicitly                                    |
| Statics                 | `StaticAbilityMode`, 90 modes; `Continuous` is 4,881 of 7,190 static lines                                                                                               | `staticEffects` (layers) and `RuleStatic` (48 kinds, several near-duplicates)                                                                                              | Merge duplicate rule statics (decision 4)                                                               |
| Replacements            | `ReplacementType`, 40 events, scripted with `ReplaceWith$`                                                                                                               | Dedicated fields (`entersTapped`, `entersWithCounters`) and replacement statics                                                                                            | No change                                                                                               |
| Tokens                  | 858 named token scripts referenced by `TokenScript$`                                                                                                                     | `tokens.ts` catalog, lint against inline tokens in `overrides/**` and `interpret.ts`                                                                                       | Extend the lint to all engine source (ADR 0032 decision 7)                                              |
| New primitive           | `ApiType` entry, an effect class, an AI mapping: three files                                                                                                             | Type, executor case and three validation or capability tables: five files                                                                                                  | Generated stub rows (ADR 0031 decision 5); the evidence tail is the bigger cost (decision 1)            |
| Descriptions            | Hand-written `SpellDescription$`/`TriggerDescription$`; effects generate stack text from params                                                                          | Hand-written `description` strings (519 in overrides), read by the AI tactician                                                                                            | Keep hand-written; generated text was rejected as a new AI-facing surface                               |
| Validation              | Enum names throw at card instantiation; free strings fail open; no test instantiates every card                                                                          | Compiler, `validateCardDefinition` on every merged definition, `audit-card-ir`, drift guard                                                                                | Ours is stronger; close the gaps in ADR 0032                                                            |
| AI hints                | In card data: `AILogic$` on 2,036 lines, `AI:RemoveDeck` on 4,669 files, about 5,800 AI-only `SVar` lines                                                                | None in card data; provider policy is outside the engine                                                                                                                   | Do not adopt                                                                                            |
| Card tests              | 163 test files in the desktop module, about 470 game-level tests touching about 500 card names (1.4% of faces); puzzles (376 `.pzl`) not run in CI                       | Manifest per card, positive and negative engine scenarios, Card Test Lab viewer evidence, primitive contracts                                                              | Keep our standard; make it cheaper (ADR 0032 decision 10)                                               |
| Test harness            | `AITest.addCardToZone`, `devModeSet` phase, `GameSimulator`; a declarative `GameStateSpecificationBuilder` used by two suites                                            | `PreparedScenarioSpec` for the lab; about 216 test files with their own `game()`/`pod()`/`setup()`, 44 with `pinned()`                                                     | One scenario format (ADR 0032 decision 10)                                                              |
| Suite integrity         | `TestSuiteIntegrityTest` exists because eight test classes stopped running and CI stayed green for a year                                                                | `test:card-gate` passes 158 substring filters; Vitest ignores one that matches no file; a stale compiled `fixtures.js` shadows `fixtures.ts`                               | Suite integrity check (ADR 0032 decision 9)                                                             |

## Keywords

Forge reads `K:Flashback:7 B B B` as a raw string, looks up its head in the `Keyword` enum
(`FG/keyword/Keyword.java:229-333`), and at card instantiation hands it to four factories in
`FG/card/CardFactoryUtil.java`. Each factory builds script strings and parses them with the same
parsers a card author uses. Flashback becomes a replacement that exiles the spell as it leaves the
stack (`CardFactoryUtil.java:2252-2300`) plus a graveyard-cast copy of the spell
(`FG/GameActionUtil.java:183-194`); Cycling becomes `AB$ Draw | Cost$ <cost> Discard<1/CARDNAME> |
ActivationZone$ Hand` (`:3717`); Ward becomes a becomes-target trigger with `DB$ Counter |
UnlessCost$` (`:1990`); Equip becomes `AB$ Attach | SorcerySpeed$ True` (`:2852`). Kicker is not an
object at all: it is an optional cost read at cast time.

The design choice that matters is that a keyword is written once and every card printing it
inherits it. The implementation is weak: an unknown keyword head becomes an inert `UNDEFINED`
(`Keyword.java:271, 333`), a malformed Equip prints "Malformed Equip entry!" and returns
(`CardFactoryUtil.java:2854`), and 8.2% of `K:` lines are not enum keywords at all (`etbCounter`,
plain-text rules).

We have the opposite: our implemented keywords are correct and validated, but few expand by
themselves. Of 37 keyword lines chosen to find gaps and run through `interpretCard`, only Cycling,
Basic landcycling, Undying, Persist and Riot come out modeled; a second sample of 17 other keywords
found 11 modeled (Equip, Flashback, Ward, Crew, Unearth, Cascade, Protection, Morph, Rebound, Escape,
Menace) and Kicker, Scavenge, Madness, Suspend, Exploit and Mutate not. Annihilator exists only inside Eldrazi
Conscription's grant (`interpret.ts:6664-6668`); Prowess is authored again on Harmonic Prodigy
(`overrides/reviewed-five.ts:128-145`); Equip and Equip commander are two copies of one block
(`interpret.ts:8611-8650`). ADR 0031 decision 2 takes Forge's design with a typed registry, a
contract per keyword, and an authoring check that rejects re-authoring a registered keyword.

## Effects and composition

Forge has 204 effect types. Each is generic: `Destroy`, `ChangeZone`, `Draw`, `PutCounter`,
`Token`. A card-specific clause is a chain. "Destroy target creature. Its controller may search
for a basic land" is a `Destroy` with a `SubAbility$` pointing at a `ChangeZone` whose
`Defined$ TargetedController` names the player. Forge's reference vocabulary is large
(`AbilityUtils.java:65-300`): the targets, their controllers, the triggering object and its last
known copy, the replaced object, the remembered and imprinted objects. Corpus counts: 2,049
`Defined$ Triggered*`, 1,847 `Defined$ Remembered`.

We have the sequence but not the vocabulary. `EffectRef` names a target slot, the trigger object,
the source, the attached object, the event player or a slot's controller. Anything else became an
op: `destroyTargetAndControllerMaySearchBasicTypedLand`,
`exileCreatureAndControllerSearchBasicLand`, `reanimateAndLoseLife`, `sacrificeAndDrawForPower`,
and more: 32 op names join two instructions with `And` (a few, like
`doublePowerAndToughnessEachUntilEot`, are not fused clauses) and others with `Then`. At least 15
ops are named after a card, among them Angel's Grace, Gisela, Humble Defector, Kambal, Etali, Druid
of Purification, Living Death, Hunting Wilds, Chaos Warp, Inkshield, Capstone Paradigm, Master of
Ceremonies, Vindictive Lich, Shadrix Silverquill and Scheming Symmetry. Rakdos Charm's own op re-implemented damage and got its sources wrong until `5c8e41f`.
Where we do have results, they are special cases with silent failure modes: a free-string `bind`
read with `?? []`, and a `lifeLostThisWay` accumulator only three of ten life-loss ops feed.

Forge's own result mechanism shows what to avoid. `Remember` and `Imprint` are lists on the card
that persist across zone changes and must be cleared by an explicit `DB$ Cleanup` link, the sixth
most used effect type; whether a reference reads last known information depends on its spelling.
ADR 0031 decision 3 makes results resolution-scoped (nothing to clean up), typed by what they hold,
and resolved by the validator.

## Adding a primitive

Forge adds an effect type in three places: the `ApiType` enum, an effect class, and the AI mapping
in `forge-ai` (`SpellApiToAi`). Nine effect types have no AI mapping; each logs "No AI assigned" to stderr
and is never played by the AI. Adding a trigger mode is an enum entry plus a class found by reflection.

We add an op in five places, all type-checked: the union in `ability.ts`, its case in
`resolve.ts`, and rows in `expression-validation.ts`, `effect-reference-contracts.ts` and
`capabilities.ts`. The checking is worth keeping. The scattering
is a chore, but a measured small one: the per-op table rows are 2% of a recent card commit's
changed lines, while snapshots, benchmark fixtures and tests are 79%. ADR 0031 therefore generates
the stub rows (`card:new --primitive`) and spends its effort on the evidence tail instead.

## Silent failures

| Mistake                                             | Forge                                                                                | MTG Tester today                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Unknown effect, trigger, static or replacement name | Throws when the card is put into a game                                              | Compile error                                                                                             |
| Misspelled parameter (`NumCrads$ 2`)                | Ignored; `DrawEffect` draws 1 (`DrawEffect.java:65`)                                 | Compile error; `validateCardDefinition` rejects unknown fields                                            |
| Misspelled trigger filter (`ValidCrad$`)            | Filter treated as absent, trigger fires more often (`FG/CardTraitBase.java:259-265`) | Compile error                                                                                             |
| Missing sub-ability                                 | `System.out.println`, effect dropped (`FG/ability/AbilityFactory.java:357-363`)      | Not possible; effects are inline                                                                          |
| Missing numeric variable                            | stderr, evaluates to 0 (`FG/ability/AbilityUtils.java:416-423`)                      | Compile error                                                                                             |
| Unknown filter property                             | Evaluates false (`FG/card/CardStateProperty.java:155`)                               | Compile error                                                                                             |
| Unknown counter type                                | Creates a new counter type (`FG/card/CounterType.java:12-23`)                        | Counter names are strings; covered by `counter-name-contract.test.ts`                                     |
| Misspelled reference between instructions           | Unknown `Defined$` key resolves to nothing (`AbilityKey.java:160`)                   | `binding` typo validates and untaps nothing (Fabled Passage probe)                                        |
| Result fed by the wrong op                          | Not applicable                                                                       | `gainLifeEqualToLifeLostThisWay` after a non-feeding op gains 0                                           |
| Out-of-range decision answer                        | Not applicable                                                                       | Production rejects it; tests driving generators fall back to option 0                                     |
| Clause modeled with the wrong meaning               | Not detected                                                                         | Not detected unless a test or review catches it (Securitron Squadron, Overwhelming Instinct in `5c8e41f`) |
| Test silently not run                               | Happened for a year (`TestSuiteIntegrityTest.java:15-28`)                            | A path in the `test:card-gate` list that matches no file is ignored                                       |

Forge's rule of thumb is that enum-typed names throw and free-string names fail open. Ours is that
anything the compiler or validator can see is checked, and three things still fail open: references
between instructions, decision answers in tests, and meaning. ADR 0032 addresses each.

## Testing

Forge's card tests are few and mostly in one desktop module. A test builds a two-player game with
`AITest.initAndCreateGame()`, adds real card scripts to zones with `addCardToZone`, forces the phase
with `devModeSet`, resolves an ability directly with `AbilityUtils.resolve` or simulates a cast with
`GameSimulator`, and asserts on game objects (`GameSimulationTest.java:470-503`). There is a
declarative builder (`GameStateSpecificationBuilder`, `PlayerActions`) used by two rule-section
suites, which the survey believes Surefire's default include pattern does not run (inferred, not
run). Puzzles are a good prepared-position format, `[metadata]` plus a `[state]` of zones, life and
counters, but none run in CI.

Two Forge lessons apply directly. First, a prepared position plus a script of actions is the right
unit; our `PreparedScenarioSpec` already is the first half, and ADR 0032 decision 10 adds the
script and expectations and uses it for engine tests as well as the Card Test Lab. Second, a suite
can stop running parts of itself without failing: Forge added `TestSuiteIntegrityTest` after eight
classes stopped running for a year. Our `test:card-gate` passes 158 entries to Vitest as substring filters, and Vitest ignores one that matches no file (checked: a nonexistent path beside a real one
exits 0). All 158 match today; ADR 0032 decision 9 makes that a check.

## What not to copy

- **The script language.** Its speed comes from terseness, and its failures from untyped strings.
  Our builders and typed IR give most of the terseness without the failures.
- **No parser.** Forge's 34,131 scripts are each written by hand. Our interpreter models thousands
  of templated cards with none.
- **AI hints in card data.** Forge mixes them into rules data; about 14% of scripts carry
  `AI:RemoveDeck`. Provider policy stays outside our engine.
- **Its test coverage.** About 1.4% of card faces appear in a test. Our standard stays.
