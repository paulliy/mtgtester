# Campaign chunk 015 (2026-11-17)

Chunk 015 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 11,493 to 12,227). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**77 cards were promoted.** The pinned pool now models 4,897 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                 | Cards |
| ------------------------------------- | ----: |
| Selected                              |   300 |
| Compiler declined (`inexpressible`)   |   198 |
| Valid patch (validator)               |   102 |
| Failed a smoke game                   |     2 |
| Meaning check passed                  |    80 |
| Meaning check flagged                 |    20 |
| Audit accepted                        |    95 |
| Audit rejected                        |     7 |
| Held back: no smoke game exercised it |    18 |
| **Promoted**                          |    77 |

The compile rate was 34% (102 of 300). Three patches failed the validator on the first round. The
Sonnet retry round fixed one, Curious Inquiry, whose first answer was not valid JSON, and declined
the other two (Brightmare needs a variable-count tap and a power-of-chosen-target value; Deathgorge
Scavenger needs to know whether the exiled graveyard card was a creature). The meaning check passed
calibration on its first run (10 cases) with no missed case and no false alarm.

## What the audit found

| Card                          | What was wrong                                                                                   | Checks       |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------ |
| Nest Invader                  | Its Eldrazi Spawn token has no Spawn subtype                                                     | all passed   |
| Brush Off                     | A cost reduction keyed to the spell's own target is never priced                                 | flagged      |
| Vow of Flight                 | An `attackRestriction` filter never matches `attachedToSource`                                   | flagged      |
| Dread Statuary                | `becomeCreatureUntilEot` without `replaceTypes` only adds Creature; it never becomes an artifact | flagged      |
| Omnibian                      | The target keeps its other creature types; the card makes it only a Frog                         | flagged      |
| Cenote Scout                  | Its smoke game threw: `explore` from a trigger has no bound event object                         | smoke failed |
| Sentinel of the Nameless City | Its smoke game threw the same way, from its Map token's ability                                  | smoke failed |

**One wrong patch passed every automatic check** (1 of 80), and it repeats a gap chunk 013 found
(Kozilek's Predator, Rapacious One). The main thread found Nest Invader, Brush Off and Vow of
Flight; the reviewer found Dread Statuary and Omnibian, and accepted the other sixteen flagged
patches as judge or back-translation artifacts.

A search of every compiled patch that uses `becomeCreatureUntilEot` found no promoted card with
Dread Statuary's error: the ones that say "artifact creature" (Guardian Idol, Dimir Keyrune, Tough
Cookie) are already artifacts, and every land says "It's still a land". Omnibian's "becomes a Frog"
cannot be written: `replaceTypes ["Creature"]` would also drop an artifact or enchantment creature's
other card types, and there is no creature-subtypes-only replacement (chunk 003's finding).

Chunk 014 found that `explore` throws from a dies trigger. Cenote Scout (an enters trigger) and
Sentinel's Map token (an activated ability on a token) show that every compiled `explore` with a
target other than `triggerObject` throws. No promoted compiled card uses `explore`.

Across the campaign, counting the five the PR review found, that is 40 of 1,151 wrong patches that
passed every automatic check, about 3.5%.

## Checks on the promoted tree

- `run.ts verify`: additive. 77 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run modelled-cards` was not run: it needs `data/scryfall-oracle-cards.json`, which this
  environment does not have.
- `bun run test` on a clean tree: 781 files passed, 5 skipped; 12,661 tests passed, 36 skipped.
- Fuzz, two pods per promoted card: 146 of 154 games passed. Seven failures are mana-payment planner
  halts that plain games also hit. The eighth, Phantom Train's heuristic-pod game, threw "cost for
  P1 became unpayable at application time" while paying an attack tax (`combat/combat.ts`
  `payAttackTax`), which Phantom Train has no part in; it joins the earlier unexplained "cost became
  unpayable" failures.

## Findings for the backlog

1. `explore` with a `source` or slot target throws "event object information has no bound event
   object" from triggers and activated abilities alike (Cenote Scout, Sentinel of the Nameless
   City, chunk 014's Miner's Guidewing); only `target: 'triggerObject'` works.
2. `becomeCreatureUntilEot` adds Creature without `replaceTypes`; the validator does not check
   "artifact creature" text against it.
3. `finishLayer4` with `setLandSubtype` and `loseAbilities` does not clear non-mana activated
   abilities (reviewer, Spreading Seas): an animated land enchanted by it keeps them.

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found 7 wrong patches among this chunk's promotions. They were retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Flamehold Grappler:** The copy path has no permanent-spell support; the copy trigger is consumed with no copy.
- **Gauntlet of Might:** A land's tapped-for-mana rider also augments its non-tap mana abilities (sacrifice-only abilities, mana filters); the engine has no tap-for-mana qualification.
- **Phantom Train:** Its animation overwrites base P/T and fails to add Artifact.
- **Promise of Bunrei:** 'if you do' is modelled as a separate counterable trigger.
- **Spreading Seas:** The enchanted land keeps printed nonmana abilities, and an animated land loses its creature subtypes.
- **Uncover the Moon-Letters:** 'If you do, discard' still discards after drawing zero.
- **Weaponcraft Enthusiast:** Fabricate still offers counters it cannot place, yielding no Servos.
