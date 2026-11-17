# Campaign chunk 014 (2026-11-17)

Chunk 014 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 10,744 to
11,491). Every valid patch was audited by the
main thread, and every flagged one reviewed by a Sonnet reviewer. It is the first chunk run under
the promotion safeguards added after the 2026-11-16 review: `promote` refuses retired patch hashes
and any trial whose calibration is unfinished or missed a case.

**91 cards were promoted.** The pinned pool now models 4,820 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                 | Cards |
| ------------------------------------- | ----: |
| Selected                              |   300 |
| Compiler declined (`inexpressible`)   |   186 |
| Valid patch (validator)               |   114 |
| Failed a smoke game                   |     1 |
| Meaning check passed                  |    94 |
| Meaning check flagged                 |    19 |
| Audit accepted                        |   107 |
| Audit rejected                        |     7 |
| Held back: no smoke game exercised it |    16 |
| **Promoted**                          |    91 |

The compile rate was 38% (114 of 300), the highest since chunk 003. Four patches failed the
validator on the first round. The Sonnet retry round fixed three, all of them JSON or answer-wrapper
slips. It declined Bagel and Schmear for the reason chunks 012 and 013 found: a non-empty patch
turns off the interpreter's ability-word label stripping, so its "Nosh —" line shows as
unrecognized. The meaning check passed calibration on its first run (10 cases) with no missed case
and no false alarm.

## What the audit found

| Card                         | What was wrong                                                                    | Checks       |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------ |
| Vindictive Flamestoker       | Its own oil-counter activation cost reduction is never applied on the battlefield | all passed   |
| Angelic Ascension            | The token is created before the exile; the card exiles first                      | flagged      |
| Ephara's Dispersal           | A cost reduction keyed to the spell's own target is never priced                  | flagged      |
| Grow Extra Arms              | The same                                                                          | flagged      |
| Iron Man, Master of Machines | Counts artifacts you control now that entered this turn                           | flagged      |
| Herald of Ilharg             | Counts only +1/+1 counters; the card counts every counter on it                   | flagged      |
| Miner's Guidewing            | Its smoke game threw: `explore` on a dies trigger has no bound event object       | smoke failed |

**One wrong patch passed every automatic check** (1 of 94), and it repeats an engine gap chunk 012
found (Mobilized District, Plate Armor). All seven rejections repeat known gaps except Herald of
Ilharg, whose patch picked the wrong counter value, and Miner's Guidewing, a new engine finding.
The reviewer accepted all fifteen flagged patches it was sent as judge or back-translation
artifacts; the main thread rejected Herald of Ilharg after checking that `allCountersOnSelf`
exists. The reviewer also confirmed that an `attacks` trigger whose subject is `attachedToSource`
does match the equipped creature (Icingdeath, Frost Tyrant's token): the attachment gap is limited
to conditions and `attackRestriction`.

Across the campaign, counting the five the PR review found, that is 39 of 1,071 wrong patches that
passed every automatic check, about 3.6%.

## Checks on the promoted tree

- `run.ts verify`: additive. 91 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run modelled-cards` was not run: it needs `data/scryfall-oracle-cards.json`, which this
  environment does not have.
- `bun run test` on a clean tree: 781 files passed, 5 skipped; 12,661 tests passed, 36 skipped.
- Fuzz, two pods per promoted card: 176 of 182 games passed. Five failures are mana-payment planner
  halts that plain games also hit. The sixth, Grim Flayer's random-pod game, threw "life cost
  became unpayable" while paying an activation cost (`effects/resolve.ts` `payLife`). Grim Flayer's
  patch is a static +2/+2 with no life cost, so this joins the earlier unexplained "cost became
  unpayable" failures.

## Findings for the backlog

1. `explore` resolving from a dies trigger throws "event object information has no bound event
   object" (Miner's Guidewing, smoke scenario `on-battlefield`).
2. The validator still accepts a battlefield `selfOnly` activation cost reduction and a spell's
   `targetFilter` cost reduction, neither of which is priced (repeat; three of this chunk's seven
   rejections).
