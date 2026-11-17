# Campaign chunk 005 (2026-11-15)

Chunk 005 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 3,905 to 4,705). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**72 cards were promoted.** High Score was retired later, after a review on the pull request found it wrong; `docs/reviews/compiled-card-retired.json` gives the reason. The pinned pool now models 4,096 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   197 |
| Valid patch (validator and smoke games) |   102 |
| Smoke game failed                       |     1 |
| Meaning check passed                    |    68 |
| Meaning check flagged                   |    34 |
| Audit accepted                          |    92 |
| Audit rejected                          |    11 |
| Held back: no smoke game exercised it   |    20 |
| **Promoted**                            |    72 |

The compile rate recovered to 34% (103 of 300) from chunk 004's 29%. Calibration passed with no
missed case. The meaning check flagged more than before (34, against 21 to 26): 28 of the flagged
patches were sound, and the Sonnet reviewer recommended accepting all 19 of the flagged patches it
was given.

## What the audit found

| Card                  | What was wrong                                                                    | Checks       |
| --------------------- | --------------------------------------------------------------------------------- | ------------ |
| Furnace of Rath       | Damage doubling only matches permanent sources, so spells are not doubled         | all passed   |
| Protection Magic      | Shield counters have no effect in this engine                                     | all passed   |
| Shield Sphere         | A -0/-1 counter has no effect; only +1/+1 and -1/-1 counters change P/T           | all passed   |
| Trenzalore Clocktower | "Time Lord" is stored as two subtypes, so the condition never holds               | all passed   |
| Big Mother Mouser     | Doubles every kind of counter, not only +1/+1                                     | flagged      |
| Boomerang Basics      | Draws, then returns the permanent; the card returns it, then draws                | flagged      |
| Crawling Infestation  | Without `fromAnyOrigin` the trigger misses creatures dying                        | flagged      |
| Lilypad Village       | Counts creatures still on the battlefield, not every one that entered             | flagged      |
| Master Chef           | The other-creatures bonus is unconditional; the card grants it via your commander | flagged      |
| Ossification          | Its enchant restriction is checked only on cast (CR 303.4d)                       | flagged      |
| Fanatical Offering    | A smoke game failed                                                               | smoke failed |

**Four wrong patches passed every automatic check** (4 of 68). Across the campaign that is 14 of
378, about 4%. All four are wrong in how the engine runs the data, which no back-translation can
show. Furnace of Rath repeats a chunk 003 finding; the other three are new engine gaps.

## Checks on the promoted tree

- `run.ts verify`: additive. 72 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run test`, clean tree: 781 files and 12,657 tests passed.
- Fuzz, two pods for each promoted card: 137 of 144 games passed. Four failures are the
  mana-payment planner halts that games without a promoted card also hit; one is an out-of-memory
  in the mana solver (Siphon Insight, as Tragic Slip in chunk 001); two hit the 300-second limit
  (Chocobo Knights, Growing Ranks) and finished normally in replays with a longer limit.

## Findings for the backlog

1. Shield counters, and P/T counters other than +1/+1 and -1/-1 (here -0/-1), have no effect, and
   the validator accepts a patch that puts them.
2. Multi-word creature types ("Time Lord") are stored split on whitespace, so a subtype filter
   naming the whole type never matches.
3. `putIntoGraveyardFromAnywhere` leaves out cards leaving the battlefield unless `fromAnyOrigin` is
   set; compilers miss this flag.
4. Repeats from earlier chunks: `damageDoubled` skips spells (chunk 003), `doubleCountersTarget`
   doubles every counter kind (chunk 004), enchant restrictions are checked only on cast (chunk 004).
