# ADR 0031: Faster card authoring, informed by Forge

Status: Proposed

Date: 2026-10-27

Companion: [ADR 0032](0032-fail-loud-execution-and-strict-tests.md) (fail-loud execution and strict
tests) and the implementation plan
[card authoring speed and fail-loud execution](../plans/card-authoring-and-fail-loud.md). Evidence:
[Forge comparison](../reviews/forge-card-modeling-comparison-2026-10-27.md).

## Context

ADR 0004 made card behavior data. ADR 0025 made that data uniform to write. Neither made a card fast
to finish. Measured at `8b93725`:

- **Most of a card's cost is evidence, not engine code.** Across 19 recent `feat(cards)` commits
  (PR11, PR11b, PR12), generated snapshots and benchmark fixtures are 46% of changed lines, tests
  33%, engine source outside `resolve.ts` 10%, `resolve.ts` 3.5%, and the per-op validation tables
  2%. The ten PR11 `feat` commits span 59 minutes of commit time, while the PR11b evidence tail took
  hours of its own (PR11's tail included `98a1b20`): Card Test Lab scenarios (`e61a3d9`, 1,805
  lines), manifest, ledger and progress docs (`e039bc8`, 647 lines), binding scenario IDs into five
  evidence generators (`5861a5f`, `fedd925`), retiring stale containment expectations (`63dd312`),
  benchmark rehashes (`da2e2c6`), snapshot regeneration, and edits to the 14 KB `test:card-gate`
  line in `package.json`.
- **Escaped bugs are rules interactions.** The last 400 non-merge commits hold 84 `feat(cards)` and
  97 `fix(cards|engine)` commits. The fixes are edge cases of copies, phasing, last known
  information, per-player grouping, graveyard cast permissions and type reads (`2ac4b96` CR 722.3c,
  `dc7b7c6`, `03e6854`, `393851e`), not malformed IR.
- **Few keywords expand by themselves.** Of 37 keyword lines chosen to find gaps, only Cycling,
  Basic landcycling, Undying, Persist and Riot come out of `interpretCard` modeled; a second sample
  of 17 other keywords found 11 modeled (Equip, Flashback, Ward, Crew, Unearth, Cascade, Protection,
  Morph, Rebound, Escape, Menace) and Kicker, Scavenge, Madness, Suspend, Exploit and Mutate not.
  Where a keyword works, it is a branch of the interpreter cascade (Equip and Equip commander are
  two copies of one block, `interpret.ts:8611-8650`), a regex for one card (annihilator exists only
  in Eldrazi Conscription's grant, `interpret.ts:6664-6668`), or re-authored per card (Harmonic
  Prodigy's Prowess, `overrides/reviewed-five.ts:128-145`).
- **Primitives are minted per card.** The `Effect` union has 344 ops. 32 join two instructions with
  `And` in the name, most of them two clauses fused into one op
  (`destroyTargetAndControllerMaySearchBasicTypedLand`, `counterAndCreateTokenForController`,
  `reanimateAndLoseLife`, …), and others with `Then`. At least 15 are named after a card
  (`angelGrace`, `gisela`, `humbleDefector`, `kambal`, `etaliPrimalConqueror`, `druidPurification`,
  `livingDeath`, `huntingWilds`, `chaosWarp`, `inkshield`, `capstoneParadigm`, `masterOfCeremonies`,
  `vindictiveLichModes`, `shadrixModes`, `schemingSymmetry`). `RuleStatic` has 48 kinds, including
  `triggerAdditionalForShamanOrOtherWizard` beside the general `triggerAdditionalTime { filter }`
  that could express it, and three damage-multiplier kinds. Rakdos Charm's own op re-implemented
  damage and got source attribution wrong (fixed in `5c8e41f`).
- **A later instruction cannot name what an earlier one did, except by special case.** `EffectRef`
  has six forms. "Life lost this way" is an accumulator three of the ten life-loss ops feed
  (`resolve.ts:4306-4340`); "those cards" is a free-string `bind` read with `?? []`. Each new "and
  then its controller…" clause therefore became a new compound op.

[Forge](https://github.com/Card-Forge/forge) models its 34,131 card scripts with no text parser. Its
speed comes from 202 keywords expanded once in the engine, 204 generic effect types chained by
`SubAbility$` with shared references (`Defined$ Targeted`, `TargetedController`, `Remembered`,
`TriggeredCard`), and starting each card from a similar card's script. Its weaknesses are the other
side of the same choices: untyped string parameters that fail open, errors that surface only in a
game, and tests touching about 1.4% of card faces.

## Decision

Attack the measured cost first: the evidence tail and the start of each card. Then adopt Forge's
vocabulary ideas in typed form, each when a real card needs it. Keep the interpreter, the typed IR,
the validator and the evidence standard of the card modeling guide unchanged.

### 1. Three commands carry a card from start to finish

**`bun run card:new "<card name>" [--batch <id>]`** starts a card:

1. finds it in the pinned fixtures (or, locally, the bulk Oracle file) and adds it to the shared pin
   store (ADR 0032 decision 10), throwing on an unknown name;
2. runs `interpretCard` and prints `unmodeledReasons` verbatim, the exact strings `handledLines`
   needs, and which lines the parser or the keyword registry already model;
3. lists the nearest modeled cards for each unparsed line, ranked by similarity of normalized text,
   with the `file:line` of their definitions, and never copies one;
4. shows, as a reference only, the card's Forge script when one exists (decision 7);
5. prints **interaction prompts** for the clause shapes behind recent escaped bugs: copies, phasing,
   last known information, per-player grouping, graveyard cast permissions, type reads off the
   battlefield, "another", "you may", intervening "if";
6. writes an `unimplemented()` stub with the exact `handledLines`, manifest clause entries without
   test IDs, and a scenario-runner test file with `it.todo` placeholders for each clause's positive
   and negative case.

The commands import the engine's own interpreter, validator, keyword registry and facet extractor;
they carry no copy of any vocabulary, which is how Forge's Workshop parser drifted from its engine.

**`bun run card:check "<card name>"`** is the edit loop: interpret, validate, facet warnings (ADR
0032 decision 6) and this card's snapshot diff, for one card, in seconds.

**`bun run card:finish [--batch <id>]`** does the mechanical tail: regenerates both snapshots and
prints a per-card semantic diff to read; re-seals benchmark compatibility
(`bun run ai-bench refresh --suite core-fast --write`); registers the batch's scenarios and binds
their IDs into the evidence generators; derives which containment expectations the batch retires;
and emits the manifest and progress skeleton. It writes nothing a gate would accept unread: the
snapshot diff and the manifest skeleton are still reviewed, and every scaffold stays rejected until
filled.

The explicit 158-entry list of `test:card-gate` becomes a committed list of directories and globs
read by a small runner script, so a new batch adds a directory once instead of editing
`package.json`, and an entry that matches nothing fails (ADR 0032 decision 9).

### 2. Keywords are a registry, adopted card by card

`packages/engine/src/cards/keywords/` holds one module per keyword, or per family of keywords that
share one expansion (Forge's Graft, Fading, Vanishing and Bloodthirst share one counter
replacement):

```ts
export const prowess = defineKeyword({
  name: 'prowess',
  cr: '702.108a',
  flag: true,
  multiple: 'cumulative', // CR 702.108b: each instance triggers separately
  parse: (element) => (element === 'prowess' ? {} : null),
  expand: (_args, line) => ({
    triggers: [
      triggered(onCast('you', not(ofType('Creature'))), {
        effects: [{ op: 'pumpUntilEot', target: 'source', power: 1, toughness: 1 }],
        description: line,
      }),
    ],
  }),
});
```

- `IMPLEMENTED_KEYWORDS` is generated from the registry's flagged keywords.
- `flag: true` keeps the keyword in the definition's `keywords` list, so `hasKeyword`,
  `denyKeywords`, `loseAllAbilities` and counting instances keep working. `multiple` (redundant,
  cumulative or special, with its CR cite) states what a second instance does.
- `expand(args, line)` returns `CardDefinition` fragments for any list a keyword can fill. Whether a
  keyword can be granted is derived from those fragment kinds: layer 6 carries `addTrigger`,
  `addActivatedAbility`, `addManaAbility`, `addKeyword`, `addWard` and `addProtection`. A keyword
  needing anything else cannot be granted, and a grant of it stays unmodeled.
- Parsing stays atomic: `parseKeywordLine` (13 call sites, several of them grants) accepts a line
  only when every element parses.
- An override whose `handledLines` contains a line the registry parses is an authoring issue.
- Registry meta-tests: each `cr` cite exists in `docs/rules/` and names the keyword; `parse` of a
  keyword's own name round-trips; no element is accepted by two modules.
- Each keyword or family has one primitive contract with positive and negative cases, inherited by
  every card printing it through the capability fingerprint. Each card still needs its own evidence.

New keywords are added as cards need them, guided by a committed frequency ranking (the plan pins
the bulk Oracle file's hash beside it). An existing inline branch moves into the registry only when
a card touches it, in its own commit, with both snapshots byte-identical: it is emitted at the same
position in the line loop, and order-sensitive branches (Equip commander before Equip) keep their
order. A branch that cannot move byte-identically stays inline with a comment saying why.

### 3. Instructions publish typed results, when the first card needs them

Results are built when the first card in the plan's pilot needs "its controller", "those cards" or
"that much" after another instruction. Until then the existing special cases stay, validated by ADR
0032 decision 2.

Any effect may carry `as: '<name>'`. Each publishing op's contract declares what it publishes:

- **objects**, typed `'permanent' | 'player' | 'card'`, that the instruction actually changed, with
  last known information for objects that left (CR 608.2h). A destroy that regeneration or
  indestructible stopped publishes nothing for that object. An object moved to a public zone is
  followed only as CR 400.7j allows, through the existing `movedReferent`; one moved to a hidden
  zone is not followed;
- **amount**, where meaningful, summed across everything affected: life actually lost (zero for a
  player whose life can't change), damage actually dealt after prevention, cards actually drawn
  (`drawCards` already returns this count).

Later effects refer to a result: `EffectRef` gains `{ result }` and `{ controllerOfResult }`;
`Selector` gains `{ kind: 'inResult', result }`, for permanents and public-zone cards, accepted only
by ops whose contract takes a set; `Value` gains `resultCount` and `resultAmount`.

```ts
// "Each opponent loses 2 life. You gain life equal to the life lost this way."
effects: [
  { op: 'eachOpponentLosesLife', amount: constant(2), as: 'drain' },
  { op: 'gainLife', amount: { kind: 'resultAmount', result: 'drain' } },
];
```

Scope rules, checked by the validator:

- a reference resolves to an unconditional publisher earlier in the same effect list, or earlier in
  an enclosing list before the nested body that holds the reference. A name published inside a
  conditional branch, a repeatable mode or a per-player body is not visible after it;
- names are unique within an ability across all modes, and a repeatable mode, which can be chosen
  more than once (`actions/ability-modes.ts`), may not publish a name at all;
- result references may not appear in anything stored past the resolution (continuous-effect
  selectors, grants, delayed-trigger bodies). A delayed trigger that needs "those cards" captures
  them with `remember: '<result>'` on `registerDelayedTrigger`, stored as a list of object ids; an
  object that has since changed zones is a new object it does not follow (CR 400.7, 603.7c).

`as` is an envelope field, so `overload.ts`'s per-field tables (`:41-56`) list it as `'unsupported'`
for overload derivation. The executor keeps one results map per resolution, passed by reference into
nested bodies. Each publishing op has a contract case for its "actually" negative: life that can't
change, prevented damage, a replaced destroy. `bind`/`untapBoundIf`, `lifeLostThisWay` and
`createdThisResolution` then become uses of results, with their cards' behavior tests unchanged.

### 4. Parameterize instead of minting

A new `Effect` op, `RuleStatic`, `Condition`, `Value` or `Selector` kind:

- is named after the mechanic. A check fails on a discriminant equal to a card-name slug from a
  committed slug list (generated from the pinned fixtures and the manifest, since the bulk file is
  not in CI). A name containing `And` or `Then` produces a warning, not a failure;
- takes selectors, values and references as parameters instead of fixing "opponent", "creature" or
  "basic land" in its name;
- carries a one-line justification in its pull request of why existing primitives cannot express the
  clause.

The two measured duplicate families are merged when one of their cards is next touched:
`triggerAdditionalForShamanOrOtherWizard` into `triggerAdditionalTime { filter }` (with an event
filter for Panharmonicon), and the three damage-multiplier statics into one `damageModifier`.

### 5. A new primitive starts from a generated scaffold

`bun run card:new --primitive <op>` writes the stub rows a new op needs in its five places
(`ability.ts`, `resolve.ts`, `expression-validation.ts`, `effect-reference-contracts.ts`,
`capabilities.ts`) and a contract-test skeleton. The tables, their exhaustiveness and the executor
switch stay as they are.

### 6. The interpreter reports where each ability came from

`interpretCard` records which Oracle line produced each ability, static, keyword expansion and
replacement field, so the override merge check (ADR 0032 decision 7), the keyword-claim check and
`card:new` can name lines.

The line loop (`interpret.ts:8002-9065`) leaves each iteration through many `continue`s, so the
change in each list's length is taken at the start of the next iteration, not the end. Constructs
that consume several lines record a line range; split and multi-face cards tag the face. Entries the
interpreter rewrites outside the loop (`reasons.length = 0` sites before it,
`interpret.ts:7766-7936`; a Pathway clearing `manaAbilities` after it, `interpret.ts:9090-9113`) are
unattributed rather than guessed.

The record travels beside the definition: `applyOverride(def, provenance)` gains the parameter at
its two call sites (`interpret.ts:7526, 9118`), and `interpretCardWithProvenance` exposes it to
tools. It is not stored on `CardDefinition`, so neither snapshot changes.

### 7. Forge scripts are a reference, never a source

When a card has a Forge script, `card:new` shows it beside the card's unparsed lines and nearest
modeled cards: the author sees which generic effects, chains and references Forge used, which often
points at the composition of our primitives the card needs. The script is fetched on demand from
Forge commit `6a2dcdc` (the one the comparison review read) into the gitignored `.cache/forge/`,
works only with network access, and is skipped silently in CI and offline. It is never translated
automatically and never committed.

Forge is GPL-3.0 and this repository is not, so its script text must not enter the repository,
directly or through a translator. A card-gate check fails when a tracked file outside `docs/` (and
other than the check itself) contains a Forge script line: one starting `A:`, `T:`, `S:`, `R:` or
`SVar:` followed by `SP$`, `AB$`, `DB$`, `Mode$` or `Event$` and a `|`-separated parameter list. It
finds nothing today. A person or agent retyping a script by hand is not caught by any check; the
rule against it is stated in the card modeling guide, and is an accepted residual risk. Card rules
themselves are not Forge's; the Oracle text, the Comprehensive Rules and our own tests remain the
only sources of a card's behavior, and Forge's scripts, which fail open and are rarely tested, are a
hint, not evidence.

## What we do not adopt from Forge

- **A string script language.** Its speed comes from terseness and its failures from untyped
  strings. Our builders and typed IR give most of the terseness without the failures.
- **Hand-scripting every card.** The interpreter models thousands of templated cards with no
  per-card work.
- **Keyword macros that build and re-parse strings.** Forge's own test of one asserts on a generated
  string and says it cannot drive the real cast; typed fragments and engine scenarios are stronger.
- **AI hints in card data** (`AI:RemoveDeck`, `AILogic$`, `SVar:PlayMain1`). Provider policy stays
  out of the engine.
- **Its evidence level.** The card modeling guide's standard is unchanged.

## Consequences

- The completion standard in `card-modeling-and-testing.md` is unchanged; the commands make it
  cheaper to meet, and each phase updates that guide and `project-commands.md` for what it ships.
- The mechanical tail of a card batch becomes three commands whose output is reviewed, not typed.
- A card whose clauses are registered keywords or compositions of existing primitives needs an
  override (or nothing), a manifest entry and scenarios, and no engine change.
- Keywords become a coverage lever: one module and its contract cover every printing.
- The `Effect` union stops gaining card-named ops; compound ops are discouraged and, once results
  exist, unnecessary.
- Snapshots stay the proof for every migration: each keyword move is byte-identical, and each
  results or family rewrite changes the snapshot for its own cards only.
- Success is measured in the plan by wall-clock time, engine lines and follow-up fixes per card on a
  randomized pilot, not by files touched.

## Alternatives rejected

- **One module per primitive, with a `ResolutionContext` and a split `Effect` union.** The per-op
  table rows are 2% of a card's changed lines, while the refactor would touch an 11,000-line
  generator that re-enters itself eleven times. The `--primitive` scaffold removes the chore without
  the risk.
- **Generated default descriptions.** Each rendering would be a maintained surface feeding the AI
  tactician, to save a one-line chore.
- **Migrate every inline keyword branch up front.** It buys no speed; branches move when a card
  touches them.
- **Port Forge's script format, or translate its scripts into our IR.** A translator would map 204
  effect types and about 1,300 parameter names onto our ops for partial coverage, start from scripts
  that fail open, and still leave every card needing our full evidence. Translated scripts would
  also be derivative works of GPL-3.0 code, which would require licensing this repository GPL-3.0.
  Showing the script as a reference (decision 7) keeps most of the benefit.
- **Rewrite `interpret.ts` around a grammar library.** The parser's problem is not its regexes but
  that its output is checked only by snapshots; ADR 0032 addresses that.
