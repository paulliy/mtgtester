# Campaign chunk 016 (2026-11-17)

Chunk 016 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md), and its
last: the remaining 258 pinned EDHREC cards by rank that no trial had seen (ranks 12,228 to 12,819).
Every valid patch was audited by the main thread, and every flagged one reviewed by a Sonnet
reviewer.

**69 cards were promoted, and two cards promoted in chunk 009 were retired** (Smoke Shroud and
Benefactor's Draught; see below). The pinned pool now models 4,964 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                 | Cards |
| ------------------------------------- | ----: |
| Selected                              |   258 |
| Compiler declined (`inexpressible`)   |   168 |
| Valid patch (validator and smoke)     |    90 |
| Meaning check passed                  |    74 |
| Meaning check flagged                 |    16 |
| Audit accepted                        |    81 |
| Audit rejected                        |     9 |
| Held back: no smoke game exercised it |    12 |
| **Promoted**                          |    69 |

The compile rate was 35% (90 of 258). Four patches failed the validator on the first round. The
Sonnet retry round fixed three (two missing braces and a stray field) and declined Walk with the
Ancestors, whose "up to one target" graveyard card no op accepts. The meaning check passed
calibration on its first run (10 cases) with no missed case and no false alarm.

## What the audit found

| Card                        | What was wrong                                                                                  | Checks     |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| Eerie Gravestone            | "Mill four" is modelled as a look: the chosen creature never goes to the graveyard              | all passed |
| Gaea's Herald               | `cantBeCountered` covers only its controller's spells                                           | all passed |
| Procrastinate               | Stun counters have no effect in this engine                                                     | all passed |
| Infested Thrinax            | An untargeted delayed dies trigger ignores its subject selector and fires once per event        | all passed |
| Skyfire Phoenix             | `returnDepartedSourceToBattlefield` from a graveyard trigger never finds the card               | all passed |
| Gahiji, Honored One         | `triggerObjectAttackingOpponent` never matches an attack on a planeswalker                      | flagged    |
| Oroku Saki, Shredder Rising | Sneak is only a cost: the creature does not enter tapped and attacking                          | flagged    |
| Veilstone Amulet            | The hexproof grant is fixed at resolution; creatures that enter later this turn are not covered | flagged    |
| Mind Control                | An enters trigger takes control once; control does not follow the Aura as the static would      | flagged    |

**Five wrong patches passed every automatic check** (5 of 74), the most of any chunk with Chunk 013. The main thread found Eerie Gravestone, Gaea's Herald and Procrastinate (all known gaps); the
reviewer found the other six, two of them through engine gaps no earlier chunk had seen:

- **A delayed trigger with no target ignores its inner trigger's subject selector.**
  `queueObjectEventTriggers` fires an untargeted delayed trigger for the first subject of any
  matching event. Benefactor's Draught (chunk 009, "whenever a creature an opponent controls
  blocks") drew when its controller's own creatures blocked, and once for several blockers. It was
  retired. Forth Eorlingas! (chunk 004) has the same shape but is a sorcery, so only its
  controller's attackers can deal the combat damage; it stays.
- **`returnDepartedSourceToBattlefield` cannot work from a graveyard-functioning trigger.** It
  looks for a graveyard card whose `leftBattlefieldObjectId` equals the source's id, but the source
  of a graveyard trigger is the graveyard card itself, with a new id. Smoke Shroud (chunk 009)
  therefore never returned to the battlefield. It was retired. No other promoted card uses the op
  from the graveyard.

Across the campaign, counting the five the 2026-11-16 PR review found, that is 47 of 1,225 wrong
patches that passed every automatic check, about 3.8%.

The reviewer also confirmed three engine paths that work: a `manaActivationRider` with an
`attachedToSource` source does see the enchanted land (Verdant Haven), the cast trigger's `ordinal`
counts only spells that match its filter (The Frightful Four), and `commanderCastCount` counts only
casts from the command zone (Font of Magic).

## Checks on the promoted tree

- `run.ts verify`: additive. 69 cards promoted and nothing else changed. The two retirements were a
  separate commit, regenerated and checked on their own.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run modelled-cards` was not run: it needs `data/scryfall-oracle-cards.json`, which this
  environment does not have.
- `bun run test` on a clean tree: 781 files passed, 5 skipped; 12,661 tests passed, 36 skipped.
- Fuzz, two pods per promoted card: 134 of 138 games passed. All four failures (Coastal Breach,
  Flare of Faith, Fresh Start, Pore Over the Pages) are mana-payment planner halts that plain games
  also hit.

## Findings for the backlog

1. An untargeted `registerDelayedTrigger` ignores its ability's trigger subject selector and
   aggregation (`state/objects.ts`, `queueObjectEventTriggers`): it fires once, for `subjects[0]`.
2. `returnDepartedSourceToBattlefield` matches `leftBattlefieldObjectId` against the source's id,
   which a graveyard-functioning trigger's source never has (`effects/resolve.ts`).
3. `triggerObjectAttackingOpponent` returns false for an attack on a planeswalker
   (`cards/condition.ts`, `defenderIdOf`).
4. Sneak's alternative cast has no "enters tapped and attacking" for a permanent spell.
5. There is no "control enchanted creature" static; a trigger-based steal does not follow the Aura.
6. The validator accepts all of the above, and `lookAtTopN` for a "mill" line.

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found 4 wrong patches among this chunk's promotions. They were retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Felothar, Dawn of the Abzan:** Omits its reflexive trigger and applies the counters inline.
- **Monkey Cage:** Token creation is gated on the self-sacrifice and counts entrants wrongly.
- **Verdant Haven:** A land's tapped-for-mana rider also augments its non-tap mana abilities (sacrifice-only abilities, mana filters); the engine has no tap-for-mana qualification.
- **Witch-king, Sky Scourge:** Uses current attackers instead of the triggering attack group and LKI.

## Retired after the Codex review of 36921d8 (2026-11-17)

- **Catastrophe:** "Creatures destroyed this way can't be regenerated" also covers land creatures
  destroyed by the land branch, but only the creature branch set `cantRegenerate`, so an animated
  land with a regeneration shield survived. Splitting the land branch into two `destroyEach` ops
  would not destroy everything at once, so the card was retired.
