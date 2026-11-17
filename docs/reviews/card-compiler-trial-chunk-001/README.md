# Campaign chunk 001 (2026-11-14)

The first pilot chunk of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md):
the 300 highest-ranked pinned EDHREC cards no trial had seen (ranks 318 to 1,372), each blocked by
unparsed rules lines only. Haiku workers answered every compile, back-translation and judge prompt,
a Sonnet worker did the validator retry round and the review of flagged patches, and the main thread
audited every valid patch against Oracle text and the engine.

**78 cards were promoted.** The pinned pool now models 3,796 of 8,972 cards (was 3,718). They are
`implemented-unreviewed` ([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   197 |
| Valid patch (validator and smoke games) |   103 |
| Meaning check passed                    |    77 |
| Meaning check flagged                   |    25 |
| Smoke game failed                       |     1 |
| Audit accepted                          |    95 |
| Audit rejected                          |     8 |
| Held back: no smoke game exercised it   |    17 |
| **Promoted**                            |    78 |

The compile rate was 34% (103 of 300), against 36% in trial 02. Cost is estimated at $0.37 at API
prices from prompt and answer sizes; worker agents made the calls, so nothing was billed.

## What the audit found

Eight patches were rejected. The reason is recorded on each queue entry.

| Card                         | What was wrong                                                                     | Meaning check |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| Urza's Mine                  | Looks for one subtype "Urza's Power-Plant"; subtypes are separate words            | passed        |
| Urza's Power Plant           | Matches the other lands by name, not by land type                                  | passed        |
| Banner of Kinship            | Counters are counted before the creature type is chosen, so it enters with none    | passed        |
| Lion's Eye Diamond           | A mana ability cannot say "activate only as an instant"                            | flagged       |
| Roiling Regrowth             | The land sacrifice became an additional cost; on the card it is part of the effect | flagged       |
| Valakut, the Molten Pinnacle | Counts the entering Mountain toward "five other Mountains"                         | flagged       |
| Rise of the Dark Realms      | The executor ignores `scope: 'all'`, so only your own graveyard returns            | flagged       |
| Aetherflux Reservoir         | A smoke game threw after a player was eliminated                                   | flagged       |

**Three wrong patches passed every automatic check** (3 of 77, about 4%), and all three would have
been promoted without the audit. Each is wrong in how the engine reads the data, not in what the data
says in English, so a back-translation cannot see it. This is the number that decides how much
auditing later chunks need: see "Open decision" below.

The other 21 flagged patches were false alarms. A Sonnet reviewer checked each against the engine
and recommended accepting all of them, which agreed with the main-thread audit.

## What changed in the tooling during the chunk

- **The back-translator could not see comparison operators.** `>=`, `<=` and `==` were hidden as free
  text, so a wrong comparison could pass. Fixed, with a test.
- **The first meaning check failed calibration.** It called the known-wrong Thran Turbine patch
  "same", so its verdicts were voided under the plan's stop rule. It was also flagging patches only
  because the back-translation did not restate the card's other lines. The instructions now tell the
  back-translator not to remark on what is absent and the judge to compare the lines under test. The
  second pass caught every known-wrong case with no false alarm, and flagged 25 patches where the
  first flagged 36.
- **The Thran Turbine case is now weaker as a check.** The judge instructions gained a general rule
  about restrictions ("only X" against "not Y") after that miss. The rule is true in general, and it
  was written with that case in view, so the calibration set needs new cases the instructions have
  never seen.
- **Promotion now refuses a token that differs from the catalog.** The generated module is exempt
  from the lint rule that sends authored cards to the token catalog, so `promote` checks instead.
- `review` formats the queue it writes, and chunk patch files are exempt from prettier because their
  bytes are hashed.

## Engine findings for the backlog

These are defects or gaps in the engine or its validator that the audit turned up. None is fixed
here, because a promotion may not change engine source.

1. `graveyardToBattlefieldEach` and `graveyardToHandEach` declare `scope?: 'you' | 'all'` and the
   executor never reads it (`effects/resolve.ts`, the `graveyardToBattlefieldEach` case). The
   validator accepts `scope: 'all'`.
2. `entersWithCounters` is evaluated before an `entersChoosingOption` choice is made, so a count over
   `chosenSubtype` is always zero. The validator accepts the combination.
3. A mana ability has no timing restriction, and the validator accepts a patch that claims a line
   saying "Activate only as an instant".
4. The Aetherflux Reservoir busy-board smoke game threw (`threw: [object Object]`) after a player
   was eliminated. The cause is not yet known.

## Checks on the promoted tree

- `run.ts verify`: additive. 78 cards promoted and nothing else changed.
- `bun run test` on a clean tree: 781 files and 12,655 tests passed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- Fuzz, two pods for each promoted card: 143 of 156 games passed. Of the 13 failures, 10 are halts
  in the mana-payment planner, and one each is an "unpayable at application time" error (Mortuary
  Mire), an out-of-memory in the mana solver (Tragic Slip) and a 300-second timeout (Amphibian
  Downpour). The planner halts are not caused by the promotion: 40 plain games with no promoted card
  fail 4 times, twice with the same halt, and those games fail identically with the generated module
  emptied. The other three are in the same mana code and have not been traced to a cause, so they
  are engine finding 5.

5. The mana-payment planner halts ("state budget exceeded", "depth budget exceeded") or fails in
   about one fuzz game in ten on this branch's base, which hides card-specific fuzz failures behind
   background noise.

## Not run

- `bun run modelled-cards`: it needs the Scryfall bulk file, which this container does not have.
- CI: it fails at the account level before its first step, on every pull request since #70.

## Open decision

ADR 0047 lets audits drop to a sample after two fully audited chunks: every card ranked 1 to 2,000
and a random 20 of the rest. At a 4% escape rate, a sampled chunk of about 80 promoted cards would
let through two or three wrong cards at ranks past 2,000. Either the validator has to catch this
class first (findings 1 to 3 are each a validator rule), or the audit stays at every card.

## Retired after the Codex review on PR #72 (2026-11-17)

The automated review that ran when the pull request was marked ready found a wrong patch among this chunk's promotions, and it was retired (`docs/reviews/compiled-card-retired.json`):

- **Helm of the Host:** "That token gains haste" was modelled as `createTokenCopyOf` with `addKeywords`, which writes haste into the token's copiable values, so a copy of the token wrongly has haste. The card grants haste to the token after it is created, and no op can do that. Kiki-Jiki, Mirror Breaker ("except it has haste") is correct as modelled and stays.
