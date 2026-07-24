# 0008 — Compositional selectors, and locked-in affected sets

Date: 2026-07-24
Status: Accepted

## Context

Anthems and lords are the most common static ability in Commander, and the engine could not
express one. `Selector` was a closed enum of five named sets — `self`, `others`, `lands`,
`nonbasicLands`, `artifacts` — each with a hand-written case in `selectMatches`. That shape
works while every static ability is a one-off (Blood Moon, Urborg) and stops working the
moment the _subject_ varies per card while the mechanic does not:

| card                     | subject                          | mechanic |
| ------------------------ | -------------------------------- | -------- |
| Glorious Anthem          | creatures you control            | +1/+1    |
| Elvish Archdruid         | other Elves you control          | +1/+1    |
| Bad Moon                 | black creatures                  | +1/+1    |
| Night of Souls' Betrayal | creatures your opponents control | −1/−1    |

Under a closed enum each row is a new engine case. Forge does not do this: its `Affected`
language composes predicates (`Creature.YouCtrl+Elf+Other`), so a new card is a new _parse_
and the engine never changes.

A second gap sat next to it. `UntilEotEffect` held a single `targetCardId`, so an
until-end-of-turn effect could only ever be about one permanent. Overrun — "Creatures you
control get +3/+3 and gain trample until end of turn" — has no representation at all.

## Decision

### 1. `Selector` is a predicate grammar

Leaves over a permanent's current characteristics (`type`, `subtype`, `supertype`, `color`,
`controller`, plus the relative `self` / `other`), combined with `allOf` / `anyOf` / `not`.
Blood Moon's subject stops being a named enum member and becomes
`allOf(ofType('Land'), not(ofSupertype('Basic')))`.

Selectors are still evaluated against **current** characteristics inside the layer pass, so
this inherits ADR 0006's property: a layer-4 animation widens a layer-7d anthem's affected
set, and an animated land is caught by "creatures you control".

Note what a selector deliberately **cannot** read: power, toughness, tapped-ness, damage.
That is not an omission. It is what keeps sublayer 7d free of dependency analysis (ADR 0007) —
7d ops change only P/T, so if no selector can read P/T then no 7d effect can change what
another 7d effect does. The exclusion is a consequence of the grammar's shape, and the
grammar is where it should be enforced.

`colors` joins `Characteristics` so the color predicate reads it from the same place as
everything else. **Layer 5 (color-changing) is still not implemented**, so the value is always
the printed color — but there is now exactly one line to change when layer 5 lands, rather
than a printed-color read to hunt down, which is the ADR 0007 lesson applied in advance.

### 2. A resolved spell's affected set is fixed at resolution (CR 611.2c)

`UntilEotEffect.targetCardId` becomes `targetCardIds`, and the two new primitives —
`pumpEachUntilEot`, `grantKeywordEachUntilEot` — evaluate their selector **once**, when the
spell resolves, and store the resulting card ids.

This is the rule, not an optimization. CR 611.2c: a continuous effect created by a resolving
spell or ability determines its set of affected objects at that time, and the set does not
change afterwards — explicitly unlike a static ability, which re-derives its set on every
layer pass. Storing card ids rather than the selector gets this for free: a creature that
enters after Overrun resolves is not pumped, and one that leaves and returns is a new object
(CR 400.7) and is not pumped either.

(An earlier note in this work cited CR 613.6 for this. That was wrong; 611.2c is the rule.)

The single-target pump collapses into the same representation as a one-element set, so there
is one code path, not two.

### 3. Tribal plurals resolve against the card's own subtypes

"Other **Elves** you control" has to become the printed subtype `Elf`. The engine has no
subtype dictionary, and a bad guess ("Elve") produces a selector that silently matches
nothing — a wrong game with no error, which the brief forbids.

So the vocabulary is the card's **own** subtypes: a plural is accepted only if it is a plural
form of a subtype the card itself has. A lord is virtually always a member of the tribe it
pumps, so this resolves the real cases; anything else returns null and the card is left
unmodeled, which halts loudly. The limitation is real — a non-tribal lord like Hivestone's
"Slivers you control" is unmodeled — and it is a limitation in the honest direction.

## Consequences

144 tests pass (up from 134), and the determinism log stays byte-identical. The suite is also
green under `MTG_VERIFY_LAYER_CACHE=1 npx vitest run --testTimeout=300000`, with no stale-cache
error — see the correction added to ADR 0007 about why the raised timeout is required.

Each new behavioral claim was checked against its wrong answer by disabling the mechanism:

| disabled                                | expected             | got instead                                   |
| --------------------------------------- | -------------------- | --------------------------------------------- |
| the `controller` predicate              | opponent's bear 2/2  | 3/3 (anthem buffs everyone)                   |
| CR 611.2c lock-in (re-derive each pass) | latecomer 2/2        | 5/5 (pumped by a spell that already resolved) |
| current-characteristics selectors       | animated manland 3/3 | 2/2 (anthem misses it)                        |

Four real cards' verbatim oracle text is parsed in the suite (Glorious Anthem, Elvish
Archdruid, Lord of the Undead, Bad Moon) rather than paraphrases shaped to fit the regexes.
Elvish Archdruid is additionally asserted to be unmodeled _only_ for its second line, which is
how we know the anthem line was accounted for rather than swept up with the failure.

Cost is flat in the number of anthems: on a 40-creature board, 20k `effectivePT` calls take
58/57/42/45/43 ms for 0/1/2/4/8 anthems, and the worst case with state mutated between every
query stays flat too. Re-enabling 7d dependency analysis costs less than run-to-run noise at
this size, so §1's exclusion is justified by the reasoning, not by a measured win — what it
buys is that the quadratic probe count cannot start mattering as boards grow.

### Deliberately not done

- **Real-deck coverage is not measured.** The Scryfall bulk data is gitignored and absent from
  this environment, so the honest claim is "these card texts parse", not a corpus percentage.
  Re-running the §11 deck survey is the way to get a real number.
- **Tribal subjects on spells** ("Elves you control get +2/+2 until end of turn") do not
  resolve: an instant has no creature subtypes to draw the vocabulary from. Unmodeled, loudly.
- **`anyOf` has no producer yet.** It is in the grammar because `allOf`/`not` without `or` is
  an odd half-algebra, and dual-type subjects ("artifact creatures you control" is `allOf`,
  but "creature or planeswalker" is `anyOf`) are one card away.
- **Layer 5 is still absent**, so color predicates match printed colors only.
- **`ofSupertype` is used only by Blood Moon's "nonbasic"**; legendary/snow subjects are
  expressible but unparsed.
