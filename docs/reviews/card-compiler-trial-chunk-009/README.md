# Campaign chunk 009 (2026-11-16)

Chunk 009 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 7,004 to 7,784). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**85 cards were promoted, and one of them (Spyglass Siren) was retired after fuzzing.** The pinned pool now models 4,431 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   191 |
| Valid patch (validator and smoke games) |   109 |
| Meaning check passed                    |    81 |
| Meaning check flagged                   |    28 |
| Audit accepted                          |    98 |
| Audit rejected                          |    11 |
| Held back: no smoke game exercised it   |    13 |
| **Promoted**                            |    85 |

The compile rate was 36% (109 of 300). Four patches failed the validator on the first round; the
Sonnet retry round fixed two. The meaning check passed calibration on its first run with no missed
case and one false alarm. A usage limit stopped the back-translation workers partway; every answer
had been written, and the chunk resumed after the reset.

## What the audit found

| Card                | What was wrong                                                                     | Checks     |
| ------------------- | ---------------------------------------------------------------------------------- | ---------- |
| Blightbeetle        | "Can't have counters put on them" is a counter replacement, which a +1 adder beats | all passed |
| Emrakul's Hatcher   | Its Eldrazi Spawn token has no Spawn subtype                                       | all passed |
| Growth Spasm        | The same                                                                           | all passed |
| Dalek Drone         | The life loss comes before the destroy                                             | flagged    |
| Gleeful Demolition  | The tokens come before the destroy                                                 | flagged    |
| Éowyn, Shieldmaiden | Counts Humans that entered and are still on the battlefield                        | flagged    |
| Spectra Ward        | Without "doesn't remove Auras", its protection knocks the Aura itself off          | flagged    |
| Sword of the Meek   | Checks base power and toughness 1/1, not a 1/1 creature                            | flagged    |
| Haunted Fengraf     | `random` is ignored on an activated ability's target, so the player chooses        | flagged    |
| Spider-Man No More  | Removes every card type; "is a Citizen" replaces only creature types               | flagged    |
| Turntimber Sower    | Mill moves cards one at a time, so it makes a Plant per land, not per event        | flagged    |

**Three wrong patches passed every automatic check** (3 of 81). Across the campaign that is 18 of
684, about 2.6%.

**The reviewer caught three the main thread had passed:** Haunted Fengraf, Spider-Man No More and,
from its engine notes, Turntimber Sower. A search of every compiled patch found one other with the
same aggregate graveyard trigger, Crawling Sensation (chunk 003); it is limited to once each turn,
which hides the defect, and it is not promoted.

## Checks on the promoted tree

- `run.ts verify`: additive. 85 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 161 of 170 games passed. Seven failures are the
  mana-payment planner halts that games without a promoted card also hit. Hexhaven Invigorator hit
  "cost became unpayable at application time", the error chunks 001 and 003 saw. **Spyglass Siren
  threw** "event object information has no bound event object": its Map token's ability explores,
  and the `explore` op reads a triggering object that an activated ability does not have
  (`effects/resolve.ts`). The card was retired. Two patches rejected in earlier chunks, Get Lost
  (chunk 002) and Fanatical Offering (chunk 005, smoke failed), have the same Map pattern; no
  promoted card does.

## Findings for the backlog

1. Zone moves of several cards (mill) fire aggregate "one or more" triggers once per card; only
   battlefield-to-graveyard batches aggregate.
2. `TargetSpec.random` is honoured only on triggered abilities (`sba/sba.ts`); an activated ability
   lets the player choose.
3. There is no layer 4 op that replaces only creature subtypes and keeps card types.
4. Protection from a color has no "doesn't remove Auras" option for compiled patches.
5. A "can't have counters put on" rule has no form; the counter replacement is the nearest and is
   wrong against additive replacements.
6. The `explore` op throws in an activated ability (Map tokens); the validator accepts it.
7. `optional` on an activated ability is ignored (`stack/stack.ts`); harmless where the effect
   offers a choice anyway.
