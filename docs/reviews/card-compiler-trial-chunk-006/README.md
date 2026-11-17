# Campaign chunk 006 (2026-11-15)

Chunk 006 of the [batch card compiler campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 4,706 to 5,468). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**89 cards were promoted.** The pinned pool now models 4,185 of 8,972 cards (3,718 before the
campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   194 |
| Valid patch (validator and smoke games) |   105 |
| Smoke game failed                       |     1 |
| Meaning check passed                    |    73 |
| Meaning check flagged                   |    32 |
| Audit accepted                          |   101 |
| Audit rejected                          |     5 |
| Held back: no smoke game exercised it   |    12 |
| **Promoted**                            |    89 |

The compile rate was 35% (106 of 300). Six patches failed the validator on the first round; the
Sonnet retry round fixed five.

## The stop, and how it was resolved

The first meaning check missed three calibration cases (Charmbreaker Devils, Minas Morgul,
Voldaren Estate), all in one judge worker's batch. Under the stop rule its verdicts were voided
and fresh back-translation and judge workers reran it. The second run missed Minas Morgul and
Voldaren Estate again, and the campaign stopped.

The repository owner chose to fix the judge prompt rather than drop the cases:

- **Reminder text.** The judge was told to ignore reminder text, and Voldaren Estate's line under
  test is only "Create a Blood token"; what a Blood token does is in the reminder. The judge prompt
  now carries the reminder text printed on the lines under test (`reminderTextFor` in
  `prompts.ts`, tested on the real cards), and says a token must have the abilities that text
  gives it.
- **Effect versus static.** The instructions now say an effect an ability creates ("as long as
  that creature has a shadow counter, it's a Wraith") is not a static ability of its source ("each
  creature with a shadow counter is a Wraith").

The third run, with fresh workers, caught Minas Morgul. A third judge in a row still called
Voldaren Estate's "create a Blood artifact token" the same as the card's Blood token, with the
reminder text in front of it, so as agreed the case was taken out of the calibration set (now 60
cases, 32 wrong) and out of this chunk's state. The third run passes with no missed case and two
false alarms.

## What the audit found

| Card                   | What was wrong                                                                 | Checks       |
| ---------------------- | ------------------------------------------------------------------------------ | ------------ |
| Pugnacious Hammerskull | Stun counters have no effect in this engine                                    | all passed   |
| Grappling Kraken       | The same                                                                       | flagged      |
| Ruinous Intrusion      | Puts the counters before the exile, so an exiled counter doubler still doubles | flagged      |
| Rile                   | Its `spellAbility` replaces the parsed spell and leaves out "Draw a card."     | flagged      |
| Shardmage's Rescue     | A smoke game threw: maximum call stack size exceeded                           | smoke failed |

**One wrong patch passed every automatic check** (1 of 73). Across the campaign that is 15 of 451,
about 3%.

**The reviewer caught one the main thread had passed.** Rile's patch restates the damage and
trample but not the draw, and a patch's `spellAbility` replaces the parsed one
(`cards/overrides/index.ts`). A scan of every compiled spell patch in chunks 001 to 006 for parsed
spell effects the patch drops found only Rile.

## Checks on the promoted tree

- `run.ts verify`: additive. 89 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 173 of 178 games passed. Four failures are the
  mana-payment planner halts that games without a promoted card also hit; one hit the 300-second
  limit (Dauntless Scrapbot) and was still running when a replay hit a 1,500-second limit; it is
  not traced to a cause.

## Findings for the backlog

1. A patch that sets `spellAbility` replaces the parsed spell, so it must restate every spell line;
   nothing checks that it does (Rile).
2. Shardmage's Rescue: a layer 6 static whose condition is `sourceMatches enteredThisTurn` recursed
   until the stack overflowed in a smoke game.
3. Delayed triggers with `expiry: 'endStep'` are swept at the end of the current end step, so one
   created during an end step never fires (Avacyn's return, Saheeli's sacrifice; reviewer finding).
4. Repeats: stun counters are unimplemented (chunk 004).

## Retired after the Codex review on PR #72 (2026-11-17)

The automated review that ran when the pull request was marked ready found a wrong patch among this chunk's promotions, and it was retired (`docs/reviews/compiled-card-retired.json`):

- **Saheeli, the Sun's Brilliance:** "That token gains haste" was modelled as `createTokenCopyOf` with `addKeywords`, which writes haste into the token's copiable values, so a copy of the token wrongly has haste. The card grants haste to the token after it is created, and no op can do that. Kiki-Jiki, Mirror Breaker ("except it has haste") is correct as modelled and stays.

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found 5 wrong patches among this chunk's promotions. They were retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Fecundity:** The optional draw belongs to Fecundity's controller instead of the dying creature's controller.
- **Loyal Inventor:** Shuffles before searching; a search to hand or for nothing leaves the library unshuffled.
- **Prosperous Bandit:** Offspring has no intervening-if, so the trigger goes on the stack when offspring was not paid.
- **Sanctum of Calm Waters:** 'If you do, discard' still discards after drawing zero.
- **Saproling Symbiosis:** 'flash if you pay {2} more' is modelled as an alternative cost, which is skipped outside the hand and cannot combine with other alternative costs.
