# Campaign chunk 013 (2026-11-16)

Chunk 013 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 10,013 to 10,743). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**76 cards were promoted, and five cards promoted in earlier chunks were retired** (Inquisitorial
Rosette, Sigiled Sword of Valeron, Vow of Duty, Vow of Lightning and Vow of Torment; see below).
The pinned pool now models 4,734 of 8,972 cards (3,718 before the campaign). They are
`implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   199 |
| Valid patch (validator and smoke games) |   101 |
| Meaning check passed                    |    75 |
| Meaning check flagged                   |    26 |
| Audit accepted                          |    92 |
| Audit rejected                          |     9 |
| Held back: no smoke game exercised it   |    16 |
| **Promoted**                            |    76 |

The compile rate was 34% (101 of 300). Seven patches failed the validator on the first round; the
Sonnet retry round fixed four, all of them invalid JSON. Pink Horror and Liliana, the Repentant
were declined for the reason chunk 012 found with Sierra: a non-empty patch turns off the
interpreter's ability-word label stripping, so an already-parsed labelled line shows as
unrecognized. The meaning check passed calibration on its first run with no missed case and no
false alarm.

## What the audit found

| Card                        | What was wrong                                                                         | Checks     |
| --------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| Fire Servant                | `damageDoubled` never applies to a spell source                                        | all passed |
| Kozilek's Predator          | Its Eldrazi Spawn tokens have no Spawn subtype                                         | all passed |
| Rapacious One               | The same                                                                               | all passed |
| Noggle the Mind             | `setTypes` replaces every card type; "is a colorless Noggle" keeps them                | all passed |
| The Sentry, Golden Guardian | The target is any player; the card targets an opponent                                 | all passed |
| Malcator, Purity Overseer   | Counts artifacts you control now that entered this turn                                | flagged    |
| Mystical Dispute            | A cost reduction keyed to the spell's own target is never priced                       | flagged    |
| Vow of Wildness             | An `attackRestriction` filter never matches `attachedToSource`                         | flagged    |
| Mirror of the Forebears     | A target filter never sees the chosen creature type, so nothing is ever a legal target | flagged    |

**Five wrong patches passed every automatic check** (5 of 75), the most of any chunk. All five
repeat engine gaps found in earlier chunks. The main thread found seven of the nine; the reviewer
found Vow of Wildness and Mirror of the Forebears, and also Fire Servant's exact cause.

The audit and review found three engine gaps that reach promoted cards:

- **`createTokenAttacking` always creates its tokens tapped.** Inquisitorial Rosette (chunk 008)
  and Sigiled Sword of Valeron (chunk 011) create a vigilance token that is attacking but untapped,
  so theirs could not block until their controller's next untap step. Both passed every automatic
  check. Every other promoted card with the op says "tapped and attacking".
- **An `attackRestriction` rule static matches its filter without the source's attachment**
  (`combat/combat.ts`), so "enchanted creature can't attack you or planeswalkers you control"
  never applies. Vow of Duty (chunk 009), Vow of Lightning (chunk 010) and Vow of Torment (chunk 011) had it. All three had been flagged by the meaning check, and the main thread had accepted
  them after reading the rule static's doc comment.
- **A target filter never sees the source's chosen option** (`targets/legality.ts`). No promoted
  card uses `chosenSubtype`, `chosenColor` or `chosenType` in a target filter.

All five cards were retired. Across the campaign that is 33 of 977 wrong patches that passed every
automatic check, about 3.4%.

## Checks on the promoted tree

- `run.ts verify`: additive. 76 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run modelled-cards` was not run: it needs `data/scryfall-oracle-cards.json`, which this
  environment does not have.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 143 of 152 games passed. Eight halted in the
  mana-payment planner (a static production rider, or a state, depth or symbol-choice budget),
  which halts by design and which plain games also hit. Mage's Attendant's game ran out of memory,
  the mana-solver failure chunks 001 and 004 saw with Tragic Slip and Siphon Insight; nothing in it
  points at the patch, which only creates a Wizard token with a counter ability.

## Findings for the backlog

1. `createTokenAttacking` has no untapped option; "a token that's attacking" cannot be written.
2. `attackRestriction` (`combat/combat.ts`, `attackRestrictionApplies`) builds its selector source
   without `attachedToCardId`, so `attachedToSource` never matches.
3. `targetIsLegal` (`targets/legality.ts`) does not bind the source's chosen option, so
   `chosenSubtype`, `chosenColor` and `chosenType` match nothing in a target filter.
4. `damageDoubled` and `damageMultiplierFor` skip any source that is not a battlefield permanent
   (repeat, now with the cause).
5. `results.json` is written by `run.ts report`, not `check`; a retried patch shows as `pending`
   until the report is rerun.
6. The validator accepts all of the above. The judge flags `persistent` mana as having no duration;
   its prompt should say `persistent` means until end of turn.
