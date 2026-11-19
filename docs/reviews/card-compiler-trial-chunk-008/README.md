# Campaign chunk 008 (2026-11-15)

Chunk 008 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 6,233 to 7,001). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**76 cards were promoted.** Genesis was retired later, after a review on the pull request found it wrong; `docs/reviews/compiled-card-retired.json` gives the reason. Inquisitorial Rosette was retired later, in chunk 013, when that chunk's audit showed its token enters tapped; the card's token is attacking but untapped ([chunk 013](../card-compiler-trial-chunk-013/README.md)). The pinned pool now models 4,347 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   205 |
| Valid patch (validator and smoke games) |    95 |
| Meaning check passed                    |    71 |
| Meaning check flagged                   |    24 |
| Audit accepted                          |    92 |
| Audit rejected                          |     3 |
| Held back: no smoke game exercised it   |    16 |
| **Promoted**                            |    76 |

The compile rate fell to 32% (95 of 300). Seven patches failed the validator on the first round;
the Sonnet retry round fixed one. The meaning check passed calibration on its first run with no
missed case and no false alarm.

## A smoke game that never finished

The first check ran for twenty minutes without ending. Timing each patch's smoke games found
**Theoretical Duplication**: its game never finished and never asked for a decision. The patch
registers a delayed "whenever a nontoken creature an opponent controls enters this turn, create a
token copy of it" trigger, and the game loops inside it; the cause is not traced. The smoke
harness has no time limit, so one looping patch stops the whole check. The main thread replaced
the compiled answer with a refusal that says so, and the card is unmodeled.

## What the audit found

| Card        | What was wrong                                                                    | Checks  |
| ----------- | --------------------------------------------------------------------------------- | ------- |
| Cindervines | Deals the damage before the destroy; the card destroys first                      | flagged |
| Evil Twin   | `sameNameAsSource` in a target filter never matches, so the ability has no target | flagged |
| Root Sliver | `cantBeCountered` only protects its controller's spells, not every Sliver spell   | flagged |

**No wrong patch passed every automatic check** (0 of 71). Across the campaign that is 15 of 603,
about 2.5%.

**The reviewer caught two the main thread had passed.** Evil Twin and Root Sliver both read right;
the engine runs them differently. Root Sliver's scope rule was already known from an earlier chunk's audit
(`cantBeCountered` is scoped to its controller's spells) and should have been caught in the audit.

## Checks on the promoted tree

- `run.ts verify`: additive. 76 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 144 of 152 games passed. Seven failures are the
  mana-payment planner halts that games without a promoted card also hit; one hit the 300-second
  limit (Suki, Courageous Rescuer).

## Findings for the backlog

1. The smoke harness has no time limit; a patch whose game loops without a decision hangs `check`
   (Theoretical Duplication). The loop itself is not traced.
2. `sameNameAsSource` works in a static's selector but not in a target filter:
   `targets/legality.ts` passes no source name (Evil Twin).
3. Once a card has any patch, generic ability labels stop being stripped (chunk 004 finding), which
   blocked Samurai's Katana and Termagant Swarm in the retry round.
4. `grantHasteToResolvingSpell` finds the bottom-most spell on the stack, not the one the mana paid
   for (Generator Servant; minor, existing grammar behaviour).
5. Repeat: `cantBeCountered` is scoped to its controller's spells.

## Retired after the Codex review on PR #72 (2026-11-17)

The automated review that ran when the pull request was marked ready found a wrong patch among this chunk's promotions, and it was retired (`docs/reviews/compiled-card-retired.json`):

- **Chrome Dome:** "That token gains haste" was modelled as `createTokenCopyOf` with `addKeywords`, which writes haste into the token's copiable values, so a copy of the token wrongly has haste. The card grants haste to the token after it is created, and no op can do that. Kiki-Jiki, Mirror Breaker ("except it has haste") is correct as modelled and stays.

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found 5 wrong patches among this chunk's promotions. They were retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Generator Servant:** The haste marker attaches to the first spell found, not the spell its mana paid for.
- **Norin the Wary:** Queues one trigger for several attackers.
- **Self-Destruct:** Its damage is dealt in two events, not simultaneously.
- **Steelburr Champion:** Offspring has no intervening-if, so the trigger goes on the stack when offspring was not paid.
- **Trace of Abundance:** A land's tapped-for-mana rider also augments its non-tap mana abilities (sacrifice-only abilities, mana filters); the engine has no tap-for-mana qualification.
