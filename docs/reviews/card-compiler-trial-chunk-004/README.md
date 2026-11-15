# Campaign chunk 004 (2026-11-15)

Chunk 004 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 3,130 to 3,904). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**66 cards were promoted.** The pinned pool now models 4,024 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   212 |
| Valid patch (validator and smoke games) |    88 |
| Meaning check passed                    |    67 |
| Meaning check flagged                   |    21 |
| Audit accepted                          |    81 |
| Audit rejected                          |     7 |
| Held back: no smoke game exercised it   |    15 |
| **Promoted**                            |    66 |

The compile rate fell to 29% (88 of 300), against 34 to 40% in earlier chunks: the cards past
rank 3,000 lean on mechanics the IR does not have yet.

## The stop, and how it was resolved

Two meaning checks in a row (the second by fresh back-translation and judge workers with the same
instructions) called the calibration case **Urza's Power Plant** "same". Its patch checks for
permanents _named_ Urza's Mine and Urza's Tower, where the card means the land _types_. The
back-translations said "a permanent named Urza's Mine", so the difference was on the page, but
"an Urza's Mine" in the card reads as a name unless the reader knows it is a land type. Under the
plan's stop rule the campaign halted.

The repository owner decided to drop the case: it tests Magic knowledge the judge is not given,
not the meaning check. It was removed from `calibration.json` (now 61 cases, 33 wrong) and from
this chunk's state, and the second meaning check stands. It passes with no missed case and two
false alarms.

## What the audit found

| Card                 | What was wrong                                                       | Checks        |
| -------------------- | -------------------------------------------------------------------- | ------------- |
| Cryogen Relic        | Stun counters have no effect in this engine                          | all passed    |
| Infiltration Lens    | Triggers once per block, not once for each blocking creature         | all passed    |
| Secrets of the Dead  | Counts spells cast from any graveyard, not only yours                | not exercised |
| Flourishing Defenses | Triggers once per placement, not once per -1/-1 counter              | flagged       |
| Daybreak Coronet     | Its enchant restriction is checked only on cast (CR 303.4d)          | flagged       |
| Eye of Nidhogg       | Adds Dragon to the creature types; "is a black Dragon" replaces them | flagged       |
| Invigorating Surge   | Doubles every kind of counter, not only +1/+1                        | flagged       |

**Two wrong patches passed every automatic check** (2 of 67). Across the campaign that is 10 of 310,
about 3%. Both are wrong in how the engine runs the data, which no back-translation can show.

## Checks on the promoted tree

- `run.ts verify`: additive. 66 cards promoted and nothing else changed.
- `bun run test`, clean tree: 781 files and 12,657 tests passed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- Fuzz, two pods for each promoted card: 127 of 132 games passed. Three failures are the
  mana-payment planner halts that games without a promoted card also hit; one hit the 80-turn cap
  (Inferno Titan); one hit the 300-second limit (Mana Flare) and finished normally in a replay
  with a longer limit.

## Findings for the backlog

1. Stun counters are not implemented (`cards/interpret.ts` says so), and the validator accepts a
   patch that puts them.
2. `countersPut` and `becomesBlocked` fire once per event; there is no per-counter or per-blocker
   form for "a counter is put" or "becomes blocked by a creature".
3. `castFrom: 'graveyard'` cannot say "your graveyard".
4. Once a card has any registered patch, the interpreter stops stripping generic ability labels
   ("Summary Execution —", "Eukrasia —"), so a line it parsed before becomes unrecognized
   (Commissar Severina Raine, Alphinaud Leveilleur).
