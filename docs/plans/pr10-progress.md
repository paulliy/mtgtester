# PR10: stack manipulation, copying, characteristics

Branches: `pr10-evidence-stack`, started from `aab7307` (the PR10 retarget and cast-copy engine
primitives), and `pr10-evidence-rest`, which continues it. PR10 as a whole covers 31 cards pinned in
[coverage-pr10-oracle.json](../../packages/engine/tests/fixtures/coverage-pr10-oracle.json). The cards
below went from engine-only to the same `implemented-reviewed` evidence layer PR09 used, and
Bilbo's Gambit, which the white-black control work modeled earlier, is recorded with them. Every pinned card is now covered.

## Current implementation

The overrides in
[coverage-pr10.ts](../../packages/engine/src/cards/overrides/coverage-pr10.ts) are registered in
production by `index.ts` beside `coverage-pr09`, one group at a time as its evidence landed: `registerPr10RetargetAndCopyOverrides` and `registerPr10CastCopyOverrides`, `registerPr10AbilityStackOverrides`, `registerPr10TriggerDoublingOverrides`, `registerPr10AnimationOverrides`, `registerPr10TokenCopyOverrides`, `registerPr10CharacteristicsOverrides`.
Before this, only the PR10 engine suites installed them through `tests/pr10-helpers.ts`;
registering twice is harmless, so that call stays. Registration itself changed no rules logic; the engine primitives the cards need landed in the earlier PR10 engine commits.

| Card                       | PR10 id | Clauses | Engine cases (file)                 | Card Test Lab scenarios |
| -------------------------- | ------- | ------- | ----------------------------------- | ----------------------- |
| Deflecting Swat            | 10.01   | 2       | `pr10-retarget.test.ts`             | 4                       |
| Atarka Monument            | 10.02   | 2       | `pr10-animation.test.ts`            | 3                       |
| Biotransference            | 10.03   | 2       | `pr10-biotransference.test.ts`      | 3                       |
| Mana Sculpt                | 10.04   | 1       | `pr10-ability-stack.test.ts`        | 2                       |
| Reality Shift              | 10.05   | 1       | `pr10-characteristics.test.ts`      | 2                       |
| Reverberate                | 10.06   | 1       | `pr10-spell-copy.test.ts`           | 2                       |
| Saheeli, Sublime Artificer | 10.07   | 2       | `pr10-animation.test.ts`            | 2                       |
| Siren Stormtamer           | 10.08   | 2       | `pr10-ability-stack.test.ts`        | 3                       |
| Trazyn the Infinite        | 10.09   | 2       | `pr10-characteristics.test.ts`      | 3                       |
| Verrak, Warped Sengir      | 10.10   | 2       | `pr10-ability-stack.test.ts`        | 4                       |
| Bolt Bend                  | 10.11   | 2       | `pr10-retarget.test.ts`             | 4                       |
| Display of Power           | 10.12   | 2       | `pr10-spell-copy.test.ts`           | 3                       |
| Duplicant                  | 10.13   | 2       | `pr10-duplicant.test.ts`            | 2                       |
| Flare of Duplication       | 10.14   | 2       | `pr10-spell-copy.test.ts`           | 4                       |
| Nighthawk Scavenger        | 10.15   | 2       | `pr10-characteristics.test.ts`      | 3                       |
| Saheeli, Radiant Creator   | 10.16   | 2       | `pr10-token-copy.test.ts`           | 4                       |
| Sarkhan, the Dragonspeaker | 10.17   | 3       | `pr10-animation.test.ts`            | 3                       |
| Roaming Throne             | 10.18   | 4       | `pr10-trigger-doubling.test.ts`     | 2                       |
| Galvanic Iteration         | 10.19   | 2       | `pr10-cast-copy.test.ts`            | 3                       |
| Mirage Mirror              | 10.20   | 1       | `pr10-animation.test.ts`            | 2                       |
| Mister Fantastic           | 10.21   | 3       | `pr10-ability-stack.test.ts`        | 4                       |
| Mocking Doppelganger       | 10.22   | 2       | `pr10-mocking-doppelganger.test.ts` | 2                       |
| Scute Swarm                | 10.23   | 1       | `pr10-token-copy.test.ts`           | 2                       |
| Annie Joins Up             | 10.24   | 2       | `pr10-trigger-doubling.test.ts`     | 3                       |
| Bilbo's Gambit             | 10.25   | 2       | `white-black-control-gifts.test.ts` | not in this increment   |
| Cosmic Crucible            | 10.26   | 2       | `pr10-cast-copy.test.ts`            | 4                       |
| Council of Reeds           | 10.27   | 2       | `pr10-token-copy.test.ts`           | 3                       |
| Xenagos, God of Revels     | 10.28   | 3       | `pr10-characteristics.test.ts`      | 3                       |
| Dragon Man, Reformed Robot | 10.29   | 3       | `pr10-characteristics.test.ts`      | 3                       |
| Rowan Kenrith              | 10.30   | 5       | `pr10-rowan.test.ts`                | 5                       |
| Twilight Diviner           | 10.31   | 2       | `pr10-token-copy.test.ts`           | 3                       |

What the scenarios show through the real frontend and backend:

- Choosing new targets changes the target of the same stack object; it is not a copy
  (Deflecting Swat, Bolt Bend). Bolt Bend must pick a different target and refuses a spell with two
  targets. The cost reduction is shown both with and without a creature of power 4 or greater, and
  Swat's free cast with and without a commander.
- Copies are separate spells with their own targets (Reverberate, Flare of Duplication, Display of
  Power, Galvanic Iteration, Cosmic Crucible). A creature spell cannot be copied by Reverberate or
  Flare. Flare's sacrifice alternative cost works for a nontoken red creature and is refused for a
  green creature. Display of Power copies two spells at once, and Reverberate targeting Display of
  Power creates no copy.
- Galvanic Iteration copies only the next instant or sorcery and is recastable from the graveyard
  with flashback. Cosmic Crucible adds four mana in any combination of colors at the beginning of
  the first main phase, copies only the first noncreature spell each turn, and never copies a
  creature spell.
- Siren Stormtamer is sacrificed to counter a spell that targets you, or an ability that targets
  your creature, and has no legal target when the spell is aimed elsewhere. Mana Sculpt counters the
  spell and, only with a Wizard, adds the mana that was spent at the beginning of the next main phase.
- Mister Fantastic copies a triggered ability you control twice and each copy picks its own new
  target, but never an opponent's trigger; its beginning-of-combat draw needs a noncreature spell
  this turn. Verrak copies an activated ability when you pay the life again, the copy may pick a new
  target, and an ability that cost no life never triggers it.
- Roaming Throne asks for a creature type as it enters, is also that type, and makes another
  creature of that type trigger twice; a creature of another type triggers once. Annie Joins Up deals
  5 damage to a creature an opponent controls (never your own) and makes a legendary creature's
  trigger fire twice but not a nonlegendary one's.
- Atarka Monument taps for red or green and, for {4}{R}{G}, becomes a red and green 4/4 flying Dragon
  artifact creature until end of turn. Sarkhan, the Dragonspeaker becomes a legendary red Dragon
  creature only (not a planeswalker), deals 4 damage to a creature with the -3, and gives the draw-two
  and discard-hand emblem with the -6. Mirage Mirror becomes a copy of a target artifact, creature,
  enchantment or land until end of turn. Saheeli, Sublime Artificer makes a Servo for each noncreature
  spell and turns an artifact into a copy of another artifact or creature you control, still an artifact.
- Scute Swarm makes a 1/1 Insect when a land enters, or a copy of itself once you control six or more
  lands. Council of Reeds lets your creatures share a name freely and copies itself at the beginning of
  combat after a noncreature spell. Twilight Diviner surveils 2 and copies one creature that entered or
  was cast from a graveyard, once each turn. Saheeli, Radiant Creator gains energy for artifact spells
  and, after you pay three energy, copies a permanent as a hasty 5/5 artifact. Mocking Doppelganger may
  enter as a copy of an opponent's creature that goads other creatures with the same name.
- Duplicant may exile a nontoken creature and takes its power, toughness and creature types. Nighthawk
  Scavenger counts card types in opponents' graveyards only. Xenagos is a creature only at seven
  devotion to red and green and hastes and doubles another creature at combat. Trazyn has the activated
  and mana abilities of artifact cards in your graveyard. Reality Shift exiles a creature and manifests,
  and a manifested creature card can turn face up for its mana cost. Dragon Man's power is the greatest
  noncreature mana value, and it can be cast from the graveyard by discarding. Rowan Kenrith has all
  three loyalty abilities, Partner with Will Kenrith and can be your commander. Biotransference makes
  your creatures, creature spells and creature cards outside the battlefield artifacts, and makes a
  Necron Warrior when you cast an artifact spell.

## Validation

- The manifest maps every printed clause (64 across the 30 cards) to named engine cases and to
  90 Card Test Lab scenarios, at `implemented-reviewed`. The earlier `unsupported` and contained
  entries for these cards are replaced, and the matching guard tests no longer treat them as
  contained (`marchesa-batch1-containment`, `fail-closed-restoration`,
  `marchesa-batch1-pool-containment`, `remaining-four-decks`).
- The scenarios live in
  [pr10-scenarios.ts](../../packages/server/src/cards/pr10-scenarios.ts) with
  [pr10-scenarios.test.ts](../../packages/server/src/cards/pr10-scenarios.test.ts), which plays each
  one headlessly through the same decision path and checks life totals, copy counts, event counts and
  which actions were offered. The browser spec
  [pr10-card-test-lab.spec.ts](../../apps/web/e2e/pr10-card-test-lab.spec.ts) reuses the PR09 viewer
  helpers, records the trace, and enforces the exact scenario-ID set. The generic Card Test Lab
  walkthrough skips these ids, as it does for PR08 and PR09.
- A scripted P2 casts the opponent spell or activates the opponent ability the viewer then answers.
  Negative scenarios keep a second, castable spell in hand so P1 still receives priority while the
  card under test is not offered.
- `bun run snapshots:check` is current for the production registration. The coverage ledger has
  `implemented-reviewed` rows for the 30 cards and a `modeled-focused-tests-passed` row for
  Bilbo's Gambit. `docs/modelled-cards.md` lists the new cards (6517 total); it was edited
  by hand because `bun run modelled-cards` needs the local Scryfall bulk file.

## Not done in this increment

- No bounded primitive contract extensions exist for PR10 (the PR09 `bounded-pr09-library.ts`
  counterpart), and there is no `run-pr10-verification.ts` receipt generator. Final
  `primitive-promotions` and receipt runs for these declarations therefore remain to be added.
- No live-provider gameplay-AI assessment was performed. Lab opponents make scripted legal
  decisions; that is separate from rules and viewer correctness.
- Nothing here was pushed.
