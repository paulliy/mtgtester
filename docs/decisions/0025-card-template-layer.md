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

## Consequences

- `overrides/` drops from 9,564 to ~4,400 lines; `remaining-common.ts` is deleted.
- A new card is one `defineCard` call composing builders, instead of two copy-pasted blocks of
  literals. Its shape is tested once in `templates.test.ts` rather than restated per card.
- ESLint blocks `registerOverride` and `parseManaCost` inside `overrides/**` so new cards cannot
  regress to the primitives the builders replaced.
- Suite goes 979 → 1,014 tests.
- **Not done:** `interpret.ts` still builds its own literals. It is a parser with roughly one
  construction site per grammar rule and is internally consistent, so it was left alone; adopting
  the token catalog there is the obvious next step. The remaining inline `TokenSpec`s in
  `overrides/` should also migrate to the catalog, at which point a lint rule banning `typeLine:`
  in an override becomes enforceable.
