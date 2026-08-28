# 0025 — Card template layer (authoring builders for the ability IR)

Status: accepted — 2026-08-07
Context: reported symptom — "a lot of divergence quality from the new cards … two cards, maybe
creatures with abilities, but they seem to be working differently."

## The finding

They do work differently, and the cause is not where it looks. There is exactly one executor
(`effects/resolve.ts::executeAbility`) and no per-card code, so two similar cards behaving
differently can only mean **divergent authored data**.

ADR 0004 made a card's behavior data. It did not say how that data gets *written*, and the answer
was: by hand, per card, per file. Measured across `overrides/` before this change (14 files, 9,564
lines, ~880 registration sites, ~430 cards):

- `targets: []` typed 290 times; `{ kind: 'tap' }` re-typed 38 times although `TAP_COST` was
  already exported and used zero times; `{ kind: 'self' }` 116 times against an unused
  `SELF_SUBJECT`; `parseManaCost(s).cost!` 53 times.
- A `const M = (cost) => ({ kind: 'mana', … })` helper copied into four files, plus a fifth calling
  it `MANA`. `living-energy.ts` defined a local `constant` that shadowed the exported one which
  five other files imported.
- `condition.ts`'s `countPermanents`/`allOfConditions`/`anyOfConditions` had **zero** callers; all
  53 such conditions were raw literals.
- Every card registered twice (real Scryfall id + derived `oracle-<slug>` fixture id) via three
  different mechanisms — 325 copy-pasted blocks — while a helper doing both already existed.

That authoring surface produced real bugs, not just noise:

- **Three different Treasure tokens**: correct; missing its `{T}`; and one with **no costs at all**,
  a free repeatable any-color mana source.
- **Trostani Discordant** created `['W','G']` Soldiers while its own handled line reads "two 1/1
  **white** Soldier creature tokens" — the commander's identity used as the token's.
- **15 U+FFFD replacement characters** in source, in token type lines and in `description` strings —
  the strings the AI tactician reads to pick an action (ADR 0016), so a display bug and an
  AI-quality bug at once.
- **Six cards with fields that are not in the IR** (`exileFromGraveyard` as an `AbilityCost`,
  `amount:` where the field is `count:`, `entersTappedUnless.filter` where it is `subtypes`, a
  layer-7b P/T given bare numbers where a `Value` is required, an `EffectRef` given a `Selector`
  object, a `ManaAbilitySpec` missing `units`). All hidden by one `def: any`, and all silent at
  runtime — `resolve.ts` skips an effect it cannot resolve rather than throwing, so a malformed
  card is indistinguishable from a card that never triggers.
- **Five cards whose Unicode-corrected `handledLines` were re-registered under the Scryfall id
  only**, leaving the fixture id with mojibake — so Elder Gargaroth and four others were unmodeled
  whenever a test built them by name.

## Decision

Add an **authoring layer** over the IR: `cards/templates.ts` (builders) and `cards/tokens.ts` (the
token catalog). Every override composes these instead of writing literals.

The builders are thin — each returns exactly the IR the literal did — so adopting one changes how a
card is written, never what it does. Coverage is chosen by measured frequency, not completeness:
there are 182 `Effect` ops and wrapping each would just rename the problem. What is wrapped is the
*boilerplate* (ability envelopes, trigger heads, costs, tokens, statics, registration); effects stay
literals, because they are already a well-typed discriminated union.

Two invariants are worth stating because they are load-bearing and easy to get wrong by hand:

- **Builders never emit a key the caller did not pass.** `applyOverride` merges with a shallow
  spread, where a key present with value `undefined` still overwrites while an absent key preserves.
  A builder always writing `optional: undefined` would silently clear a parser-derived value on
  every card it touched.
- **`targetSlots` allocates variable-count slots last.** A slot's position IS the index every
  `EffectRef` number points at, and a wrong index does not throw — the effect is skipped.

Registration (`defineCard`, `unimplemented`) lives in `overrides/index.ts` beside the registry, not
in `templates.ts`, which every override file imports — putting it there formed a cycle that survived
only on function hoisting.

## Verification

A refactor of the authoring layer needs proof it left the data alone, and nothing existing gives it:
`docs/modelled-cards.md` compares card *names*, and `determinism.test.ts` compares a run against a
re-run of itself. So `overrides/snapshot.ts` serializes the registry to canonical JSON (object keys
sorted, since the merge is key-order-insensitive; array order preserved, since it is the slot index)
and `tests/override-defs.test.ts` pins it, plus two structural invariants: every card is registered
under both ids, and no card's real id carries behavior its fixture id lacks.

The migration commits are byte-identical against that snapshot. The bug-fix commits change exactly
the intended registrations and nothing else.

The same problem exists one layer up for `interpretCard` itself: `overrides/snapshot.ts` only
covers the registry, not what the generic grammar produces. `cards/interpret-snapshot.ts` +
`tests/interpret-defs.test.ts` cover that half, pinned against the committed, offline, 93-card
Ur-Dragon fixture `urdragon-coverage.test.ts` already used (no new gitignored-data dependency). It
paid for itself immediately: the first `--check` after migrating interpret.ts's hand-authored
special cases onto the builders showed a diff of exactly one card, which was the one case that also
carried an intentional data fix (below) — proving the envelope migration itself moved nothing.

## Increment 2 — the token catalog and interpret.ts (2026-08-07)

Two follow-ups landed in the same session, both flagged as "not done" above:

**Every remaining inline `TokenSpec` in `overrides/`** now references a named `tokens.ts` const —
14 new consts, one dead `INKLING` deleted outright. Cataloguing surfaced two more divergences of the
exact kind this whole layer exists to prevent: Night Scythe's Necron Warrior had `colors: []` and an
extra `'Warrior'` subtype against its own handled line reading "black Necron Warrior"; and
`THOPTER_1_1_FLYING` itself had shipped with `colors: ['U']` in increment 1 and gone uncaught because
nothing referenced the const yet — every card that prints it says "1/1 **colorless** Thopter",
verbatim, in its own `handledLines`. Both fixed, both covered in `token-catalog-fill-in.test.ts`.

**`interpret.ts`'s ~16 hand-authored `if (card.name === '...')` special cases** (Dragon Tempest,
Firkraag, Iymrith, Morophon, the two Sarkhans, and others the generic grammar cannot read at all)
now compose `templates.ts` builders — structurally these were always identical to what override
literals looked like before increment 1, so the migration was the same kind of mechanical swap.
`triggered()`/`spell()` gained `modes` support (absent until Kairi's modal death trigger needed it —
justified the same way as every other builder parameter, because 10 override sites already needed it
too). The **~45 generic grammar functions** (`parseTriggerLine`, `parseActivatedLine`,
`parseStaticLine`, `parseManaProduction`, …) were deliberately left alone: they build ability shapes
across mutable accumulators and closures before the final literal, which doesn't fit the builders'
single-call shape, and forcing it would mean redesigning the builders around one caller — the
"never widen a shape to fit a second card" rule, at file scope.

This surfaced a fourth Treasure spelling, distinct from the three fixed in increment 1's overrides:
`interpret.ts`'s own `PREDEFINED_TOKENS.treasure` had `typeLine: 'Token Artifact — Treasure'`,
encoding-corrupted in source on top of that, against the catalog's correct `'Artifact — Treasure'`.
It fed both a special case (Sarkhan, Dragon Ascendant) and the generic "create a Treasure token"
grammar (Old Gnawbone, in the same fixture) — fixed to `treasure: TREASURE`, one spelling, the same
const now used everywhere else a Treasure is created.

## Consequences

- `overrides/` drops from 9,564 to ~4,300 lines; `remaining-common.ts` is deleted.
- A new card is one `defineCard` call composing builders, instead of two copy-pasted blocks of
  literals. Its shape is tested once in `templates.test.ts` rather than restated per card.
- ESLint blocks `registerOverride` and `parseManaCost` inside `overrides/**` so new cards cannot
  regress to the primitives the builders replaced.
- No override file and no interpret.ts special case builds a raw `TokenSpec` literal anymore —
  every token is a named `tokens.ts` export. A lint rule banning inline `TokenSpec` shape in either
  location is now enforceable, not yet added.
- Suite goes 979 → 1,019 tests.
- **Still not done:** interpret.ts's generic grammar functions (the ~45 parser functions
  themselves, not the name-keyed special cases) do not use the builders — see above for why. Adopting
  the token catalog inside `parseTokenFace` (so a parsed "1/1 white Soldier creature token with
  lifelink" resolves to the same object as `SOLDIER_1_1_LIFELINK` rather than a structurally-equal
  but separately-constructed one) is the remaining piece of "parser-produced and hand-authored cards
  are structurally identical by construction," and is a smaller, more contained change than the
  grammar functions themselves.

## Increment 3 — closing both flagged gaps (2026-08-07)

**`parseTokenFace`'s catalog lookup.** `tokens.ts` exports `ALL_TOKENS` (every named const) plus
`canonicalizeToken(spec)`, which structurally matches a parsed `TokenSpec` against the catalog and,
on a hit, returns the catalog object itself rather than the freshly-parsed one. `interpret.ts` calls
it at every `createToken` spec it builds (the bare parse, the keyword-merged form, and — where it
still applies — the same-shape check after a granted trigger is attached).

The match key excludes `typeLine`: the catalog's own builders spell it `"Creature — Human"` (the
real printed type line) while `parseTokenFace` spells it `"Token Creature — Human"`, a "one word
off" difference already flagged and left alone in two override files' comments
(`queen-marchesa-queens-gambit.ts`, `draconic-destruction.ts`). Keying on it would make every lookup
miss on formatting alone rather than on anything a card's text actually says. A hit still replaces
the *whole* object, `typeLine` included — the substitution is what actually fixes the formatting
mismatch for any card it applies to, not something the key comparison needed to special-case.

This turned up the same mojibake em-dash bug ADR 0025 fixed across `overrides/` (increment 1), but
in `interpret.ts` itself: `parseTokenFace`'s dynamically-built `typeLine` used the corrupted
`"Token Creature â€” Pest"` byte sequence, live in the string template, not just in a comment. Two
more hand-authored `AlternativeCast` Omen faces (Bloomvine Regent, Marang River Regent) carried the
same corruption in their own `typeLine` literals. All three fixed; the golden interpret snapshot
picked up exactly those two Omen-face cards and nothing else — no fixture-deck card's own parsed
token happens to match the catalog closely enough to also flip on the `canonicalizeToken` change,
so the fix landed with a two-card diff, not a large one.

**The lint rule.** `eslint.config.js` gets a structural selector — an `ObjectExpression` carrying
`typeLine`+`subtypes`+`colors` together but not `oracleId` (which excludes `CardDefinition` itself,
built the same way at the bottom of `interpretCard`) — applied to both `overrides/**` and
`interpret.ts`. `parseTokenFace` is the one legitimate site left (it IS the token constructor for a
phrase with no name to look up), carrying its own inline `eslint-disable-next-line` with the reason
attached: `creatureToken`/`artifactToken` don't fit there either, since a token's power/toughness
from card text can be an X value or unknown ("`*`"), which those builders don't accept.

Covered by `tests/token-catalog-canonicalization.test.ts`: object identity on a match, a
non-matching token still parsing correctly (a miss is a no-op, not a dropped card), the
keyword-before-match ordering, and the em-dash regression on a token that has no catalog match (so
the assertion can't be accidentally passing via a substituted object instead of the actual fix).

## Increment 4 — post-merge review hardening (2026-08-07)

A review of the merged migration (PR #7) surfaced nine issues, all fixed in the same session, all
covered by new regression tests. None changed a live card's behavior in the shipped pool — the bugs
were in the *machinery* the migration touched, reachable by any future override, not in a card any
current deck plays. Grouped by the durable lesson, since the point of this section is prevention,
not a changelog:

- **A shallow merge doesn't know an override changed an ability's KIND.** Desolate Mire's override
  switched a line from the interpreter's stack-based `activatedAbilities` reading to a true
  `manaAbilities` one, but only set `manaAbilities` — `applyOverride`'s `{ ...def, ...override.def }`
  left the interpreted `activatedAbilities` entry for the same line sitting alongside it, so the
  land offered its mana twice (once uncounterable, once responder-vulnerable). Fixed by also
  clearing `activatedAbilities: []`; captured as rule 4 in `overrides/index.ts`'s docstring.
- **`handledLines: []` is a superpower, not a shrug.** Beast Within's override kept a hardcoded
  `def` "just in case," years after `parseTokenFace` started canonicalizing away the exact
  near-miss it existed to patch — a `handledLines: []` registration claims no line, so the drift
  guard has nothing to check it against, and a stale override could silently keep overriding a
  correct interpretation forever with no diagnostic. Deleted rather than kept as a no-op; captured
  as rule 5.
- **A catalog lookup returning a shared object is a mutation hazard, not just an equality win.**
  `parseCreateTokenSentence` named a token by writing `spec.name = …` directly onto whatever
  `parseTokenFace` returned — which, on a catalog hit, IS the shared exported `TokenSpec` const,
  not a copy. Any card creating a same-shaped NAMED token would have corrupted that const for every
  other card creating the plain version afterward in the same process. Fixed by cloning before
  mutating; captured as rule 4 in `tokens.ts`'s docstring.
- **An "is this patch empty" heuristic has to match its own type's shape, not a syntax guess.**
  `isEmptyPatch` treated any `boolean` value as "contributes nothing" if `false`, and any object
  value as "always contributes something" regardless of content. Both wrong: `entersTapped: false`
  is a real, meaningful override (few `CardDefinition` fields are required with a non-`false`
  interpreted default — `entersTapped` is one), while `entersWithCounters: {}` is exactly the same
  "nothing here" as an absent key that arrays already got right. Fixed with a small denylist for
  the required-boolean case rather than a blanket rule, since most boolean fields ARE optional
  flags where `false` and absent are interchangeable.
- **A guard duplicated by hand drifts from the original.** `registerOverride`'s legacy-fixture
  guard re-implemented "is this patch empty" as `Object.keys(def).length === 0` — the exact bug
  `isEmptyPatch` exists to fix for `applyOverride`, left unfixed in this sibling function one
  screen away. Fixed by calling `isEmptyPatch` from both places instead of re-deriving the check.
- **A throw at module-init time has a blast radius equal to whatever imports the module — not
  just the file that threw.** `templates.mana()` deliberately throws on a bad cost string (see its
  docstring), but every deck's `registerXOverrides()` used to run unguarded in one sequence at
  `overrides/index.ts` import time, which `interpret.ts` imports statically. One typo in any deck
  file would have crashed card-interpretation module load entirely — every card in the pool, not
  just the one with the typo. Fixed by wrapping each deck's registration individually
  (`registerDeck`), with failures collected in an exported `failedRegistrations` array a test
  asserts is empty — loud in CI, contained in blast radius.
- **A generic-parsing branch that duplicates a builder's shape defeats the builder.** Two of
  `interpret.ts`'s own `costReduction` cases hand-wrote the object literal `costReductionFor`
  exists to produce, inside the very PR that added it. Fixed by calling it from both sites;
  `costReductionFor`'s `filter` parameter widened to accept `undefined` so `interpret.ts`'s
  internal "any spell" sentinel can resolve to "omit the key" before calling in, rather than the
  sentinel leaking into the builder.
- **A test suite that imports a large gitignored fixture statically fails the same way a real bug
  does.** Five suites imported `data/scryfall-oracle-cards.json` via a static
  `assert { type: 'json' }` import; on any machine without that ~180 MB file staged (a fresh clone,
  any CI run — the repo has no workflow provisioning it), that's a "can't find module" crash at
  collection time, indistinguishable from a real regression. Fixed with
  `cards/scryfall-bulk-fixture.ts` — a `readFileSync` behind `existsSync`, `describe.skipIf`'d, with
  a `console.warn` naming the missing file — so absence is a reported skip, not noise. (One of the
  five loaded its data-file path from a hand-authored absolute Windows path, unrelated to the
  gitignored-fixture problem but caught by the same pass; fixed to `resolve(...)` alongside it.)

None of these needed a new increment of the authoring layer itself — the builders' shapes were
right. What was missing was closer scrutiny of the *composition* code around them (`applyOverride`,
`registerOverride`, `parseCreateTokenSentence`'s post-parse mutation, the registration entry point)
and of two overrides that had quietly outlived the bug they were written to work around. The rule-4
and rule-5 additions to `overrides/index.ts` and `tokens.ts` above are the durable artifact: read
them before writing a new override, not just this ADR.
