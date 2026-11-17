# Campaign chunk 002 (2026-11-14)

The second pilot chunk of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md):
the next 300 pinned EDHREC cards by rank that no trial had seen (ranks 1,375 to 2,325), each blocked
by unparsed rules lines only. It ran the same way as [chunk 001](../card-compiler-trial-chunk-001/README.md):
Haiku workers answered every compile, back-translation and judge prompt, a Sonnet worker did the
validator retry round and reviewed the flagged patches, and the main thread audited every valid
patch against Oracle text and the engine.

**78 cards were promoted.** Electroduplicate was retired later, after a review on the pull request found it wrong; `docs/reviews/compiled-card-retired.json` gives the reason. The pinned pool now models 3,874 of 8,972 cards (was 3,796 after chunk
001, 3,718 before the campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   197 |
| Valid patch (validator and smoke games) |   103 |
| Meaning check passed                    |    73 |
| Meaning check flagged                   |    27 |
| Smoke game failed                       |     3 |
| Audit accepted                          |    94 |
| Audit rejected                          |     9 |
| Held back: no smoke game exercised it   |    16 |
| **Promoted**                            |    78 |

The compile rate was 34% (103 of 300), the same as chunk 001. The first meaning check passed
calibration: it called every known-wrong case "different", with one false alarm on a correct case.

## What the audit found

Nine patches were rejected. The reason is recorded on each queue entry.

| Card                        | What was wrong                                                               | Checks        |
| --------------------------- | ---------------------------------------------------------------------------- | ------------- |
| Minas Morgul, Dark Fortress | The Wraith type is a static of the land; shadow counters do not grant shadow | all passed    |
| Satyr Wayfinder             | Reveals only the chosen card; the card reveals all four                      | all passed    |
| Ondu Spiritdancer           | Declining the copy still spends the once-per-turn                            | not exercised |
| Emeria Shepherd             | Forces the battlefield return where the card lets you choose                 | flagged       |
| Tome of Legends             | Matches a commander you control; "your commander" is one you own             | flagged       |
| Grisly Salvage              | Reveals only the chosen card; the card reveals all five                      | flagged       |
| Warden of the Grove         | Counts only +1/+1 counters, not all counters                                 | smoke failed  |
| Gleaming Splendor           | A smoke game threw on the second player target                               | smoke failed  |
| Get Lost                    | A smoke game threw on event object information                               | smoke failed  |

**Two wrong patches passed every automatic check** (2 of 73, about 3%; chunk 001 had 3 of 77).
Across both chunks that is 5 of 150, about 3%.

**The meaning check found one the audit missed.** Tome of Legends read correctly to the main thread;
the judge flagged "your commander" against "a commander you control", and it was right. The audit and
the meaning check catch different things, so neither replaces the other.

The reviewer recommended rejecting Coastal Piracy because a creature you control could in principle
deal combat damage to you. The main thread accepted it: a creature that changes control is removed
from combat (CR 506.4), so it cannot.

## What changed in the tooling during the chunk

- **The token check now covers only predefined tokens.** It refused Assemble the Legion because its
  red and white haste Soldier differed from the catalog's white Soldier. A creature token's name does
  not fix what it is; a Treasure's does (CR 111.10). Fixed with a test, and the card was promoted.

## Checks on the promoted tree

- `run.ts verify`: additive. 78 cards promoted and nothing else changed.
- `bun run test`: 779 files passed and 2 failed in the full run. Both are viewer-evidence tests that
  need a clean tree, and two documentation files were committed while the run was going. Rerun on a
  clean, quiet tree, both pass (80 tests).
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- Fuzz, two pods for each promoted card: 145 of 156 games passed. Ten failures are the
  mana-payment planner halts that plain games without a promoted card also hit (see chunk 001). The
  eleventh, Temur Battle Rage, hit the 300-second limit; replayed with a longer limit it finished
  normally in 553 seconds, so it is slow, not stuck.

## Engine findings for the backlog

New in this chunk. None is fixed here, because a promotion may not change engine source.

1. Shadow is not a keyword counter (`state/counters.ts`, `KEYWORD_COUNTERS`), so a shadow counter
   grants nothing.
2. The validator accepts a token whose power is a `countersOnSelf` value, and the smoke game then
   throws "source counters need a layer evaluation scope" (Warden of the Grove).
3. The validator accepts `differentFromSlots` on a second player target of an activated ability, and
   the smoke game throws "illegal target" (Gleaming Splendor).
4. Get Lost's `destroyAndCreateTokenForController` with a Map token threw "event object information
   has no bound event object" in a busy own-turn game.
5. `lookAtTopN` has no way to reveal every looked-at card, only the chosen one, so "reveal the top
   N" cards cannot be compiled exactly.
