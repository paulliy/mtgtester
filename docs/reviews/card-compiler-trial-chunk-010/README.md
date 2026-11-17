# Campaign chunk 010 (2026-11-16)

Chunk 010 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 7,785 to 8,537). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**77 cards were promoted.** Vow of Lightning was retired later, in chunk 013, when that chunk's review showed its "can't attack you" restriction never applies ([chunk 013](../card-compiler-trial-chunk-013/README.md)). Plate Armor was retired later, in chunk 012, when that chunk's review showed
its own cost reduction is never applied ([chunk 012](../card-compiler-trial-chunk-012/README.md)). The pinned pool now models 4,508 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   203 |
| Valid patch (validator and smoke games) |    97 |
| Meaning check passed                    |    70 |
| Meaning check flagged                   |    27 |
| Audit accepted                          |    88 |
| Audit rejected                          |     9 |
| Held back: no smoke game exercised it   |    11 |
| **Promoted**                            |    77 |

The compile rate was 32% (97 of 300). Five patches failed the validator or a smoke game on the first
round; the Sonnet retry round fixed two.

## Calibration

The first meaning check missed two calibration cases, both mutations of correct patches: Dogged
Detective with its optional return made mandatory, and Exsanguinator Cavalry with its trigger
widened. Under the stop rule its verdicts were voided and fresh back-translation and judge workers
reran it. The second run passed with no missed case and no false alarm.

## What the audit found

| Card                         | What was wrong                                                              | Checks     |
| ---------------------------- | --------------------------------------------------------------------------- | ---------- |
| Freeze in Place              | Stun counters have no effect in this engine                                 | all passed |
| Irreverent Gremlin           | "Do this only once each turn" limits the loot, not the trigger              | all passed |
| Family's Favor               | Shield counters have no effect in this engine                               | flagged    |
| Kyler, Sigardian Emissary    | Counts only +1/+1 counters; the card counts every counter on Kyler          | flagged    |
| Treachery                    | "You control enchanted creature" made an enters trigger instead of a static | flagged    |
| Great Hall of the Biblioplex | Its animation is permanent; `becomeCreatureUntilEot` ends it at end of turn | flagged    |
| Titanic Brawl                | A cost reduction keyed to the spell's own target is never priced            | flagged    |
| Commence the Endgame         | Its `spellAbility` replaces the parsed spell and loses "can't be countered" | flagged    |
| Slice from the Shadows       | The same                                                                    | flagged    |

**Two wrong patches passed every automatic check** (2 of 70). Across the campaign that is 20 of
754, about 2.7%.

**The reviewer caught three the main thread had passed:** Titanic Brawl, Commence the Endgame and
Slice from the Shadows. Scans of every compiled patch in chunks 001 to 010 found no promoted card
with either defect: the dropped "can't be countered" appears only in these two, and the
self-targeted cost reduction only here and in Price of Fame (chunk 005, not promoted).

## Checks on the promoted tree

- `run.ts verify`: additive. 77 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 149 of 154 games passed. All five failures are the
  mana-payment planner halts that games without a promoted card also hit.

## Findings for the backlog

1. An unmodeled spell's "can't be countered" is stored as `spellCantBeCountered`, which casting reads
   only when the definition has no `spellAbility`; a patch that sets `spellAbility` must restate it
   as `spellAbility.cantBeCountered`, and nothing checks that it does.
2. `targetedCostReductionFor` sees only battlefield and command-zone sources, so a spell's
   reduction keyed to its own target is never applied.
3. There is no permanent (no-duration) animation op for an activated ability.
4. Repeats: stun and shield counters are unimplemented.

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found 4 wrong patches among this chunk's promotions. They were retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Groundchuck & Dirtbag:** A land's tapped-for-mana rider also augments its non-tap mana abilities (sacrifice-only abilities, mana filters); the engine has no tap-for-mana qualification.
- **Primal Empathy:** Greatest power starts at zero, so negative powers compare wrongly.
- **Rout:** 'flash if you pay {2} more' is modelled as an alternative cost, which is skipped outside the hand and cannot combine with other alternative costs.
- **Zhur-Taa Ancient:** A land's tapped-for-mana rider also augments its non-tap mana abilities (sacrifice-only abilities, mana filters); the engine has no tap-for-mana qualification.
