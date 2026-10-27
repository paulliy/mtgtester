# ADR 0031: Faster card authoring, informed by Forge

Status: Proposed

Date: 2026-10-27

Companion: [ADR 0032](0032-fail-loud-execution-and-strict-tests.md) (fail-loud execution and strict
tests) and the implementation plan
[card authoring speed and fail-loud execution](../plans/card-authoring-and-fail-loud.md).
Evidence: [Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

## Context

ADR 0004 made card behavior data. ADR 0025 made that data uniform to write. Neither made it fast to
write a card whose clause is not already a primitive, and that is where the time goes. Measured at
`8b93725`:

- **A new primitive is a change to six or more files.** The `Effect` type in `ability.ts`, its case
  in `resolve.ts`, and its rows in `authoring-validation.ts`, `expression-validation.ts`,
  `effect-reference-contracts.ts` and `capabilities.ts`, before any test. Chrome Mox (`c3a0dbf`)
  touched 10 files and 267 lines; Intermediate Chirography (`82a4682`) 15 files and 832 lines; Mana
  Vault and Mystic Remora (`73ac3c0`) 8 files and 547 lines. Each table is type-checked, so this is
  safe, but it is slow.
- **Primitives are minted per card.** The `Effect` union has 344 ops. At least 32 are compound
  (`destroyTargetAndControllerMaySearchBasicTypedLand`, `exileCreatureAndControllerSearchBasicLand`,
  `counterAndCreateTokenForController`, `reanimateAndLoseLife`, …) and at least 11 are named after a
  card (`angelGrace`, `gisela`, `humbleDefector`, `kambal`, `etaliPrimalConqueror`,
  `druidPurification`, `livingDeath`, `huntingWilds`, `chaosWarp`, `inkshield`, `capstoneParadigm`).
  `RuleStatic` has 51 kinds, including `triggerAdditionalForShamanOrOtherWizard` beside the general
  `triggerAdditionalTime { filter }` that could express it, and three damage-multiplier kinds.
  Rakdos Charm's own op re-implemented damage and got source attribution wrong (fixed in `5c8e41f`).
- **Few keywords expand by themselves.** Running 37 common keyword lines through `interpretCard`,
  only Cycling, Basic landcycling, Undying, Persist and Riot come out modeled. Prowess, Exalted,
  Afterlife, Annihilator, Toxic, Dash, Evoke, Mentor, Ninjutsu, Buyback, Delve, Training, Bushido,
  Flanking, Wither, Myriad, Battle cry, Extort, Embalm, Encore, Blitz, Squad, Backup, Bloodthirst,
  Fabricate, Modular, Living weapon, Shadow, Horsemanship, Skulk, Fear and Intimidate do not. Where
  a keyword works, it is a branch in `interpret.ts`'s 9,225-line cascade (Equip and Equip commander
  are two copies of the same block, `interpret.ts:8611-8650`), or a regex for one card (annihilator
  exists only inside Eldrazi Conscription's grant, `interpret.ts:6664-6668`), or authored again on
  each card (Harmonic Prodigy's Prowess, `overrides/reviewed-five.ts:128-145`).
- **A later instruction cannot name what an earlier one did, except by special case.** `EffectRef`
  has six forms. "Life lost this way" is a hidden accumulator fed by three of the ten life-loss ops
  (`resolve.ts:4306-4340`), so `eachPlayerLosesLife` followed by `gainLifeEqualToLifeLostThisWay`
  validates and gains nothing. "Those cards" is a free-string `bind` read with `?? []`. Each new
  "and then its controller…" clause therefore became a new compound op.
- **Descriptions are typed by hand.** Overrides carry 519 `description` strings. The AI tactician
  chooses from them (ADR 0016), so each is a correctness surface as well as a chore.
- **Every batch rebuilds its test scaffolding** (216 files with their own `game()` or `pod()`, 44
  with their own `pinned()`, about 40 per-batch Oracle fixture files). ADR 0032 decision 10 covers
  this.

[Forge](https://github.com/Card-Forge/forge) models its 34,131 card scripts with no text parser.
Its speed comes from four things the comparison review documents with source references: 202
keywords are data expanded once in the engine; 204 generic, parameterized effect types are chained
by `SubAbility$` with shared references to targets and earlier results (`Defined$ Targeted`,
`TargetedController`, `Remembered`, `TriggeredCard`); 858 token scripts and `Count$` values are
shared vocabularies; and a new card usually starts as a copy of a similar card's script. Its weaknesses are the other side of the same choices: parameters
are untyped strings, many mistakes surface only at run time or never, and card-level tests are rare.

## Decision

Adopt Forge's four sources of speed in typed form. Keep the interpreter, the typed IR, the
validator and the evidence standard of the card modeling guide unchanged.

### 1. Keywords are a registry

`packages/engine/src/cards/keywords/` holds one module per keyword that expands into behavior:

```ts
export const prowess = defineKeyword({
  name: 'prowess',
  cr: '702.108a',
  parse: (element) => (element === 'prowess' ? {} : null),
  expand: () => ({
    triggers: [
      triggered(onCast('you', not(ofType('Creature'))), {
        effects: [{ op: 'pumpUntilEot', target: 'source', power: 1, toughness: 1 }],
        description: 'Prowess — this creature gets +1/+1 until end of turn',
      }),
    ],
  }),
});
```

- `parseKeywordLine` offers each comma-separated element to the registry. Flags that the engine
  reads directly (flying, reach, trample, …) stay in `IMPLEMENTED_KEYWORDS`; the registry holds
  keywords that become abilities, costs, statics or replacements.
- A grant ("has annihilator 2", "Other Dragons you control have ward {2}") reads the same registry,
  so the keyword is written once whether it is printed or granted. Layer 6 already carries
  `addTrigger`, `addActivatedAbility`, `addManaAbility`, `addKeyword`, `addWard` and
  `addProtection`; a keyword whose expansion needs something else (an alternative cost, a casting
  permission) declares itself not grantable, and a grant of it stays unmodeled.
- An override whose `handledLines` contains a line the registry parses is an authoring issue
  naming the keyword. A card never re-authors a registered keyword.
- Each keyword has one primitive contract with positive and negative cases. Every card printing it
  inherits that evidence through the capability fingerprint, and still needs its own card evidence
  under the card modeling guide.

The existing inline keyword branches move into the registry first, one commit per keyword, with
the interpretation and override snapshots byte-identical, the method ADR 0025 used. New keywords
follow in order of frequency in the Oracle population.

### 2. Instructions publish typed results

Any effect may carry `as: '<name>'`. Each op's contract declares what it publishes: the objects it
affected (`'permanent' | 'card' | 'player'`, with last known information for objects that left,
CR 608.2h) and, where meaningful, an amount (life actually lost, damage actually dealt, cards
actually drawn). Later effects of the same ability refer to a result:

- `EffectRef` gains `{ result: name }` and `{ controllerOfResult: name }`;
- `Value` gains `{ kind: 'resultCount', result }` and `{ kind: 'resultAmount', result }`.

```ts
effects: [
  { op: 'eachPlayerLosesLife', amount: constant(2), as: 'drain' },
  { op: 'gainLife', amount: { kind: 'resultAmount', result: 'drain' } },
];
```

The validator checks that every result name is published earlier in the same ability and mode with
a compatible kind (ADR 0032 decision 1), so a typo or an op that publishes nothing is an authoring
issue, never a silent zero. The executor keeps one `results` map per resolution. It follows a
moved object only where CR 400.7j allows, through the existing `movedReferent` tracking.

`bind`/`untapBoundIf`, `lifeLostThisWay`/`gainLifeEqualToLifeLostThisWay` and
`createdThisResolution` become uses of results. No new compound op is added. An existing compound
op is rewritten as a composition only when its card is touched for another reason, with its
behavior tests unchanged and the override snapshot changing for that card alone.

### 3. Parameterize instead of minting

A new `Effect` op, `RuleStatic`, `Condition`, `Value` or `Selector` kind must:

- be named after the mechanic, not a card. A check compares new discriminant names against card
  name slugs in the pinned Oracle population; the 11 existing card-named ops are listed and may
  only be removed;
- take selectors, values and references as parameters instead of fixing "opponent", "creature" or
  "basic land" in its name;
- state in its pull request why existing primitives composed with results cannot express the clause.

The measured duplicate families are merged: `triggerAdditionalForShamanOrOtherWizard` into
`triggerAdditionalTime { filter }`, with an optional event filter added for Panharmonicon's
`triggerAdditionalOnArtifactOrCreatureEntry`; `damageDoubled`, `damageDoubledToOpponents` and
`damageHalvedToYou` into one `damageModifier { source, recipient, factor }`. Each merge keeps the
affected cards' behavior tests unchanged.

### 4. A new primitive is one module

New ops are written as one module under `packages/engine/src/effects/ops/`:

```ts
export const surveil = definePrimitive({
  op: 'surveil',
  references: {},
  expressions: { count: value },
  capability: { … },
  publishes: { objects: 'card' },
  *execute(rc, effect) { … },
});
```

`rc` is a `ResolutionContext`: the helpers `executeAbility` keeps as closures today (`ref`,
`amountOf`, `sourcePermanent`, `legalChosenPermanents`, the results map) as one object. The
registry spreads each module's contract, expression and capability rows into the existing tables,
which keep their `satisfies` exhaustiveness checks. `executeAbility`'s `default` dispatches to the
registry before `assertNever`. Legacy ops stay in the switch and move into modules only when they
are touched.

A new primitive then costs one module, one line in the `Effect` union, one registry line and its
contract test, instead of six coordinated edits.

### 5. An authoring workbench starts each card

`bun run card:new "<card name>" [--batch <id>]`:

1. finds the card in the pinned fixtures or the bulk Oracle file and adds it to the shared pin store
   (ADR 0032 decision 10);
2. runs `interpretCard` and prints `unmodeledReasons` verbatim, the exact strings `handledLines`
   needs;
3. shows, per line, whether the parser or the keyword registry already models it, and the facets
   of ADR 0032 decision 6 ("another", "you may", target count, …);
4. lists the nearest modeled cards for each unparsed line, ranked by similarity of normalized text,
   with the `file:line` of their definitions, and never copies one;
5. writes an `unimplemented()` stub with the exact `handledLines`, manifest clause entries with no
   test IDs, and a scenario-runner test file with `it.todo` placeholders for each clause's positive
   and negative case.

Every scaffold is something the existing gates reject until it is filled: `unimplemented()` leaves
the card unsupported, the card gate fails on clauses without evidence, and ADR 0032's reporter fails
on `todo`. The workbench speeds up the start; it never decides semantics.

### 6. The interpreter reports where each ability came from

`interpretCard` records which Oracle line produced each ability, static, keyword expansion and
replacement field. The record travels beside the definition (to `applyOverride`, and through
`interpretCardWithProvenance` to tools); it is not stored on `CardDefinition`, so neither snapshot
changes. ADR 0032 uses it for the override merge check and the facet check, and the workbench uses it
for step 3.

### 7. Descriptions default to generated text

`describeEffect` renders the most-used ops (chosen by measured frequency, as ADR 0025 chose
builders) into the house description style. `spell()`, `triggered()` and `activated()` use it
when `description` is omitted and the renderer covers every effect, and require one otherwise.
Existing descriptions are not changed, so AI benchmark inputs stay stable.

## What we do not adopt from Forge

- **A string script language.** Forge's parameters are `Map<String, String>`; a misspelled key is
  ignored. Our IR is a discriminated union the compiler and validator check.
- **Hand-scripting every card.** The interpreter models thousands of templated cards with no
  per-card work. It stays, and it emits through the same builders, keyword registry and results.
- **AI hints in card data** (`AI:RemoveDeck`, `AILogic$`, `SVar:PlayMain1`). Provider policy stays
  out of the engine (rules-engine constraints).
- **Its evidence level.** Forge has few card-level tests. The card modeling guide's standard is
  unchanged; this ADR and ADR 0032 make meeting it cheaper.

## Consequences

- A card whose clauses are keywords or compositions of existing primitives needs an override (or
  nothing), a manifest entry and scenarios, and no engine change.
- A card that does need a new primitive needs one module and its contract, not six edits.
- The `Effect` union stops growing by one op per unusual card. Compound and card-named ops shrink
  as their cards are touched.
- Keywords become a coverage lever: one keyword module plus its contract covers every printing.
- Snapshots stay the proof for each migration. The keyword move and the module move are
  byte-identical refactors; each merge or composition rewrite changes the snapshot for its own cards
  only.
- The success measures are in the plan: files and lines touched per new card, the share of new
  cards needing a new primitive, keyword lines modeled by the registry, and scaffolding lines per
  card, each measured against the PR11 and PR11b commits.

## Alternatives rejected

- **Port Forge's script format or its card scripts.** It would trade compile-time checking for
  speed, and Forge's GPL-3.0 scripts cannot be copied into this repository's code.
- **Effect builders for every op.** ADR 0025 rejected this: effects are already a typed union, and a
  builder per op only renames them. Results and keywords remove more code than builders would.
- **Rewrite `interpret.ts` around a grammar library.** The parser's problem is not its regexes but
  that its output is checked only by snapshots; ADR 0032's facets and provenance address that at a
  fraction of the risk.
