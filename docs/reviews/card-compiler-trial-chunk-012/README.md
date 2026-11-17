# Campaign chunk 012 (2026-11-16)

Chunk 012 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 9,299 to 10,008). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**78 cards were promoted, and one card promoted in an earlier chunk was retired** Giott, King of the Dwarves was retired later, after a review on the pull request found it wrong; `docs/reviews/compiled-card-retired.json` gives the reason. (Plate Armor from
chunk 010; see below). The pinned pool now models 4,663 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   199 |
| Valid patch (validator and smoke games) |   101 |
| Meaning check passed                    |    72 |
| Meaning check flagged                   |    29 |
| Audit accepted                          |    89 |
| Audit rejected                          |    12 |
| Held back: no smoke game exercised it   |    11 |
| **Promoted**                            |    78 |

The compile rate was 34% (101 of 300). Four patches failed the validator or a smoke game on the
first round, and the Sonnet retry round declined all four. Three needed a condition on a targeted
graveyard card, which no condition can read. The fourth, Sierra, Nuka's Biggest Fan, was declined
because a non-empty patch stops the interpreter stripping the "The Nuka-Cola Challenge —" label
from its first line, so that line shows as unrecognized. That is a harness or interpreter
question, not a card one. The meaning check passed calibration on its first run with no missed
case and no false alarm.

## What the audit found

| Card                      | What was wrong                                                                                        | Checks     |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| Mobilized District        | Its own "costs {1} less to activate" reduction is never applied on the battlefield                    | all passed |
| Ring of Thune             | Its "if it's white" condition selects `attachedToSource`, which never matches in a condition          | all passed |
| Slumbering Trudge         | Stun counters have no effect in this engine                                                           | all passed |
| Dwalin, Weaponmaster      | Hone counters have no effect in this engine                                                           | flagged    |
| Balthor the Defiled       | `graveyardToBattlefieldEach` ignores `scope: 'all'`, so only its controller's cards return            | flagged    |
| Thran Temporal Gateway    | The filter admits legendary instants and sorceries; `handToBattlefield` does not check for permanents | flagged    |
| Unending Whisper          | Harmonize's tap-a-creature cost reduction is missing                                                  | flagged    |
| Unlicensed Disintegration | The damage comes before the destroy                                                                   | flagged    |
| Quest for the Necropolis  | Its own activation cost reduction is never applied, as for Mobilized District                         | flagged    |
| Red Hulk                  | "Any other target" lost "other": the reflexive damage can target Red Hulk                             | flagged    |
| Planar Atlas              | "You may look" is mandatory: the trigger is not optional, and the rest always go to the bottom        | flagged    |
| Splinter, Hamato Yoshi    | Sneak's "enters tapped and attacking" is missing                                                      | flagged    |

**Three wrong patches passed every automatic check** (3 of 72). The reviewer's Quest for the
Necropolis finding showed that a battlefield permanent's own activation cost reduction
(`costReduction` with `appliesTo: 'activate'` and `selfOnly`) is never priced: `gatherRuleStatics`
skips it, and only abilities activated from hand read it. The main thread had accepted Mobilized
District with that shape, and a search of every compiled patch found one promoted card with it,
Plate Armor (chunk 010), whose equip discount never happened. Plate Armor was retired. Across the
campaign that is 26 of 902 wrong patches that passed every automatic check, about 2.9%.

The reviewer caught three the main thread had passed: Quest for the Necropolis, Red Hulk and
Planar Atlas. The main thread found the other nine, Ring of Thune among them by the shape chunk
011 found.

## Checks on the promoted tree

- `run.ts verify`: additive. 78 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run modelled-cards` was not run: it needs `data/scryfall-oracle-cards.json`, which this
  environment does not have.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 149 of 156 games passed. Five games (Falcon and Redwing,
  Ideas Unbound, Jor Kadeen, Overabundance, Tolarian Kraken) halted in the mana-payment planner
  on a static production rider, and Grove of the Guardian's on the activation state budget; the
  planner halts by design, and plain games without a promoted card hit the same halts. Goblin
  Assault's game reached the 80-turn cap, which plain games also reach. Nothing threw.

## Findings for the backlog

1. A battlefield `costReduction` with `appliesTo: 'activate'` and `selfOnly: true` is never applied
   (`state/queries.ts` skips it in `gatherRuleStatics`; `actions/legal.ts` reads `selfOnly` only for
   abilities activated from hand). The validator accepts it.
2. `graveyardToBattlefieldEach` and `graveyardToHandEach` accept `scope: 'all'` but read only the
   controller's graveyard (`effects/resolve.ts`).
3. `handToBattlefield` puts any matching card onto the battlefield, with no check that it is a
   permanent card.
4. There is no "other than the source" restriction for an `anyTarget` slot; a player-target filter
   must be always-true.
5. Hone counters, like stun and shield counters, have no effect.
6. A non-empty patch turns off the interpreter's generic-label stripping
   (`genericLabelStripAllowed` in `cards/interpret.ts`), so a labelled line the patch does not
   handle shows as unrecognized (Sierra, Nuka's Biggest Fan).

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found 2 wrong patches among this chunk's promotions. They were retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Overabundance:** A land's tapped-for-mana rider also augments its non-tap mana abilities (sacrifice-only abilities, mana filters); the engine has no tap-for-mana qualification. Its damage also waits as an ordinary trigger instead of resolving with the mana.
- **Stirring Hopesinger:** Cast-target matching ignores countTargets, so a six-target Hex gives no trigger.
