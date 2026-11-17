# Campaign chunk 011 (2026-11-16)

Chunk 011 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 8,541 to 9,293). Every valid
patch was audited by the main thread, and every flagged one reviewed by a Sonnet reviewer.

**80 cards were promoted, and two cards promoted in earlier chunks were retired** Vow of Torment was retired later, in chunk 013, when that chunk's review showed its "can't attack you" restriction never applies ([chunk 013](../card-compiler-trial-chunk-013/README.md)). Sigiled Sword of Valeron was retired later, in chunk 013, when that chunk's audit showed its token enters tapped; the card's token is attacking but untapped ([chunk 013](../card-compiler-trial-chunk-013/README.md)). (Ring of Evos
Isle from chunk 009 and Blade of the Bloodchief from chunk 003; see below). The pinned pool now
models 4,586 of 8,972 cards (3,718 before the campaign). They are `implemented-unreviewed`
([ADR 0047](../../decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

## Result

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   206 |
| Valid patch (validator and smoke games) |    94 |
| Meaning check passed                    |    76 |
| Meaning check flagged                   |    18 |
| Audit accepted                          |    91 |
| Audit rejected                          |     3 |
| Held back: no smoke game exercised it   |    11 |
| **Promoted**                            |    80 |

The compile rate was 31% (94 of 300). Six patches failed the validator on the first round. The
Sonnet retry round fixed three: two first answers were not valid JSON, and one lacked the answer
wrapper. Shao Jun was declined because the validator still reports its already-parsed Rope Dart
line as unrecognized; that is a harness question, not a card one. The meaning check passed
calibration on its first run with no missed case and one false alarm. A usage limit paused the
reviewer partway; it resumed after the reset.

## What the audit found

| Card            | What was wrong                                                                                   | Checks  |
| --------------- | ------------------------------------------------------------------------------------------------ | ------- |
| Growth Curve    | `doubleCountersTarget` doubles every kind of counter; the card doubles only +1/+1 counters       | flagged |
| Ring of Kalonia | Its "if it's green" condition selects `attachedToSource`, which never matches in a condition     | flagged |
| Reality Heist   | `lookAtTopN` makes the second pick mandatory (and automatic with one artifact left); "up to two" | flagged |

**No wrong patch in this chunk passed every automatic check** (0 of 76). The reviewer's Ring of
Kalonia finding, though, exposed two earlier escapes: Ring of Evos Isle (chunk 009) has the same
condition shape and never put its counter, and Blade of the Bloodchief (chunk 003) never gave a
Vampire its second counter. A replay of the Blade's trigger on an equipped Vampire put one counter,
not two. Both were retired, and a search of every compiled patch found no other condition that
selects `attachedToSource`. Across the campaign that is 22 of 830 wrong patches that passed every
automatic check, about 2.7%.

A search for the Reality Heist shape found two other promoted cards, Flow State (chunk 005) and
Accumulate Wisdom (chunk 006). Both say "put two" or "put each", so the mandatory picks are right
for them.

## Checks on the promoted tree

- `run.ts verify`: additive. 80 cards promoted and nothing else changed.
- `typecheck`, `typecheck:tests`, `lint`, `format:check`, `snapshots:check`, `check:ratchets` and
  `audit:card-ir` pass.
- `bun run modelled-cards` was not run: it needs `data/scryfall-oracle-cards.json`, which this
  environment does not have. `docs/modelled-cards.md` is not updated.
- `bun run test`, clean tree: 781 files and 12,659 tests passed.
- Fuzz, two pods for each promoted card: 154 of 160 games passed. Bag End Banquet, Shifting
  Ceratops and Stun hit "cost became unpayable at application time", the payment error earlier
  chunks saw with other cards. Dawn's Reflection and District Guide halted in the mana-payment
  planner (a static production rider, and the activation state budget), which halts by design.
  The Sandstorm Salvager game threw an invariant on Mirage Mirror, a hand-written card: it was
  attached to an object that was no longer a permanent. The replay reproduces it, but nothing in
  it points at the Salvager's patch, so it is recorded here rather than retired.

## Findings for the backlog

1. A condition inside a resolving ability has no attachment context: the condition source that
   `conditionalEffect` builds (`effects/resolve.ts`) carries no `attachedToCardId`, so
   `attachedToSource` (`cards/selector.ts`) matches nothing there. The validator accepts it, and a
   direct `attachedToSource` effect target on the same patch works, which hides the defect in smoke
   games.
2. `lookAtTopN` with `mayPut.count` above 1 treats the later picks as mandatory; there is no "up to
   N" form.
3. `doubleCountersTarget` doubles every counter kind; there is no "+1/+1 counters only" form.
4. The validator rejects Shao Jun's patch for a line the interpreter already parses (Rope Dart).
5. Mirage Mirror (hand-written) can end up attached to an object that is no longer a permanent:
   `bun run fuzz --from 1 --card "Sandstorm Salvager" --games 0 --card-games 1 --turn-cap 80 --decisions 20000`
   reproduces it at turn 58.

## Retired after the owner's review on PR #72 (2026-11-17)

The owner's review of every promoted card found a wrong patch among this chunk's promotions. It was retired (`docs/reviews/compiled-card-retired.json`), because the engine cannot express the correct behavior or the patch got it wrong:

- **Four Knocks:** Vanishing is collapsed into the upkeep trigger; removing the last time counter another way never sacrifices it.
