# Campaign chunk 007 (2026-11-15)

Chunk 007 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 5,470 to 6,232). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**86 cards were promoted.** The pinned pool now models 4,271 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   189 |
| Valid patch (validator and smoke games) |   111 |
| Meaning check passed                    |    81 |
| Meaning check flagged                   |    30 |
| Audit accepted                          |   107 |
| Audit rejected                          |     4 |
| Held back: no smoke game exercised it   |    21 |
| **Promoted**                            |    86 |

The compile rate was 37% (111 of 300). Eight patches failed the validator on the first round; the
Sonnet retry round fixed three. A usage limit stopped nine of the twelve compile workers partway;
they had written 289 of the 300 answers, and one worker answered the other eleven.

This was the first chunk judged with the reminder-text prompt from chunk 006. The meaning check
passed calibration on its first run, with no missed case and no false alarm.

## What the audit found

| Card              | What was wrong                                                                       | Checks  |
| ----------------- | ------------------------------------------------------------------------------------ | ------- |
| Aya of Alexandria | Its historic filter leaves out Sagas                                                 | flagged |
| Fateful Absence   | Creates the Clue before the destroy                                                  | flagged |
| Trickster's Elk   | Adds Elk to the creature's types; "is a green Elk creature" replaces them            | flagged |
| Molt Tender       | A mana ability cannot pay "exile a card from your graveyard", so it never makes mana | flagged |

**No wrong patch passed every automatic check** (0 of 81). Across the campaign that is 15 of 532,
about 3%.

**The reviewer caught one the main thread had passed.** Molt Tender's patch reads right, but the
engine refuses its cost on a mana ability (`state/queries.ts`, `canPayNonManaCosts`) and the
validator does not say so.

## Checks on the promoted tree

- `run.ts verify`: additive. 86 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 164 of 172 games passed. Six failures are mana-payment
  planner halts; most such halts also hit games without a promoted card, but two (Dictate of
  Karametra, a static mana rider, and Gene Pollinator, which taps another permanent as a cost) name
  exactly the payment forms the planner says are outside its scope, so those two cards may make
  the planner halt more often. Two games hit the 300-second limit: Carnivorous Canopy finished normally in a replay with a
  longer limit; Cruel Ultimatum was still running after 1,500 seconds and is not traced to a cause.

## Findings for the backlog

1. A mana ability cannot use `exileOtherCardsFromGraveyard`, `exileCardFromHand` or
   `returnUnblockedAttacker` as a cost: `canPayNonManaCosts` rejects them and `payAbilityCosts`
   throws, but the validator accepts the patch (Molt Tender).
2. `searchLibrary` with two fixed destinations cannot put a lone found card into the second one
   (Jarad's Orders when only one creature is found; minor).
