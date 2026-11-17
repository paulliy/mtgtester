# Campaign chunk 003 (2026-11-14)

The third chunk of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md), and
the first after the two pilot chunks: the next 300 pinned EDHREC cards by rank that no trial had
seen (ranks 2,326 to 3,123). The audit stayed at every card (decided 2026-11-14, after the pilots
found about 3% of fully checked patches wrong). Haiku workers answered every compile,
back-translation and judge prompt; a Sonnet worker did the retry round and reviewed the flagged
patches; the main thread audited every valid patch against Oracle text and the engine.

**82 cards were promoted.** Blade of the Bloodchief was retired later, in chunk 011, when that
chunk's review showed its Vampire check can never pass ([chunk 011](../card-compiler-trial-chunk-011/README.md)). The pinned pool now models 3,956 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   180 |
| Valid patch (validator and smoke games) |   120 |
| Meaning check passed                    |    93 |
| Meaning check flagged                   |    26 |
| Smoke game failed                       |     1 |
| Audit accepted                          |   110 |
| Audit rejected                          |    10 |
| Held back: no smoke game exercised it   |    28 |
| **Promoted**                            |    82 |

The compile rate was 40% (120 of 300), up from 34% in both pilot chunks. The meaning check passed
calibration on its first run with no false alarm.

More patches than before were held back because no smoke game exercised them (28, against 17 and
16). Most are statics and triggers the generated boards rarely meet: "activated abilities can't be
activated", spells that cost less, cards that need your commander or a Food on the battlefield.

## What the audit found

| Card                     | What was wrong                                                                 | Checks        |
| ------------------------ | ------------------------------------------------------------------------------ | ------------- |
| Angrath's Marauders      | Damage doubling only matches permanent sources, so your spells are not doubled | all passed    |
| Dictate of the Twin Gods | The same: burn spells are not doubled                                          | all passed    |
| Voldaren Estate          | Its Blood token has no ability                                                 | all passed    |
| Planar Nexus             | Adds only the reminder text's land types, not every nonbasic land type         | not exercised |
| Diamond City             | Counts creatures still on the battlefield, not every creature that entered     | flagged       |
| Kona, Rescue Beastie     | "Permanent card" leaves out battles                                            | flagged       |
| Malevolent Rumble        | Reveals only the chosen card; the card reveals all four                        | flagged       |
| Lignify                  | Replaces noncreature subtypes too; "is a Treefolk" keeps them (CR 205.1b)      | flagged       |
| Marauding Raptor         | The pump checks only that the creature is a Dinosaur, not that it was damaged  | flagged       |
| Ulvenwald Tracker        | A smoke game threw on the second target                                        | smoke failed  |

**Three wrong patches passed every automatic check** (3 of 93). Across the campaign that is 8 of 243,
about 3%, steady across the three chunks.

**The reviewer caught two the main thread had passed.** Lignify and Marauding Raptor were accepted
in the main-thread audit; the meaning check flagged both, and the Sonnet reviewer showed each was a
real defect with the engine line that decides it. As in chunk 002, the audit and the meaning check
catch different errors.

## Checks on the promoted tree

- `run.ts verify`: additive. 82 cards promoted and nothing else changed.
- `bun run test`, clean tree: 781 files and 12,655 tests passed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- Fuzz, two pods for each promoted card: 154 of 164 games passed. Eight failures are the
  mana-payment planner halts that games without a promoted card also hit (chunk 001). One timeout
  (Alseid of Life's Bounty). One "cost became unpayable at application time" (Kaervek the
  Merciless), the same error chunk 001 saw with Mortuary Mire; it is not traced to a cause.

## After the pull request review

A review of PR #72 found three promoted cards wrong and one defect in the smoke harness.

- **Retired:** Artifact Mutation created its Saproling tokens before destroying the artifact, so
  anything watching tokens enter saw the artifact still there. Planar Engineering (this chunk) and
  Lotus Field (chunk 001) sacrificed one land and then another, where the card sacrifices both at
  once (CR 603.10a). All three are unmodeled again, so the engine halts on them.
- **Judge instruction:** it said to ignore "ordering", which let Artifact Mutation through. It
  now says the order of steps inside one ability matters, including two sacrifices against one.
- **Calibration:** the seven wrong patches whose error shows in the data (Urza's Power Plant,
  Lotus Field, Satyr Wayfinder, Minas Morgul, Voldaren Estate, Artifact Mutation, Planar
  Engineering) joined the calibration set, which now holds 62 cases, 34 of them known-wrong.
- **Smoke targets:** the harness picked each target slot on its own, so "fights another target
  creature" could name one creature twice and throw. Ulvenwald Tracker and Gleaming Splendor
  (chunk 002) failed that way, not because of their patches. With distinct targets both pass, and
  both were promoted, with Sword of War and Peace, The Earth King and Uncivil Unrest, which the
  replay exercised.

Net: 82 + 5 − 3 promoted cards across this branch's changes to this chunk and the earlier ones;
the pinned pool models 3,958 of 8,972. Full suite after the changes: 781 files and 12,657 tests
passed. Fuzz on the five new cards: 7 of 10 games passed, the 3 failures being the mana-payment
planner halts.

## Engine findings for the backlog

New in this chunk; none is fixed here, because a promotion may not change engine source.

1. `damageDoubled` skips any source that is not a permanent (`effects/damage-modifiers.ts`), so
   "a source you control" cannot include spells. The validator does not say so.
2. Layer 4 `setSubtypes` replaces every subtype, so "is a [creature type]" removes land and
   artifact subtypes.
3. There is no condition for "if it was dealt damage this way".
4. Blood is not in the token catalog, so the predefined-token check cannot catch a Blood token
   without its ability.
5. `differentFromSlots` on a second target throws in play (Ulvenwald Tracker; also Gleaming
   Splendor in chunk 002).

## Retired after the Codex review on PR #72 (2026-11-17)

The automated review that ran when the pull request was marked ready found a wrong patch among this chunk's promotions, and it was retired (`docs/reviews/compiled-card-retired.json`):

- **Fear of Missing Out:** `queueObjectEventTriggers` checks the trigger's condition before it records `oncePerTurn`. A first attack without delirium leaves the trigger free to fire on a later attack that turn; the card triggers only on the creature's first attack.

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found 5 wrong patches among this chunk's promotions. They were retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Gogo, Mysterious Mime:** Its rider applies even when it fails to become a copy.
- **Impostor Syndrome:** The copy reads the event object after it left, so a departed creature yields no copy.
- **Mirrorworks:** The copy reads the event object after it left, so a departed artifact yields no copy.
- **Necroduality:** The copy reads the event object after it left; a bounced Zombie yields no copy.
- **Sword of War and Peace:** CardsInTargetHand does not handle eventPlayer, so the damage is always 0.
