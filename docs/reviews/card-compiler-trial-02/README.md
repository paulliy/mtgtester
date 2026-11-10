# Card compiler trial 02 (2026-11-10)

This run took 300 more unmodeled EDHREC cards through the batch card compiler (`scripts/card-compiler/`).
Each card is blocked by one rules line the parser cannot read. The cards are spread evenly over the
5,125 cards that fit that description, and trial 01's cards are left out. Haiku-class worker agents
answered every compile, back-translation and judge prompt. A Sonnet-class worker did the retry round.
There was no API key, so no API call was made.

None of these cards can be played yet. Each checked card goes to `docs/reviews/compiled-card-queue.json`
and waits there for review.

## Result

| Outcome            | Cards | Share |
| ------------------ | ----: | ----: |
| `compiled-checked` |    85 |   28% |
| `meaning-differs`  |    23 |    8% |
| `smoke-failed`     |     1 |  0.3% |
| `invalid`          |     0 |       |
| `inexpressible`    |   191 |   64% |

- **Cost.** About $0.37 for the whole run, or about $0.004 per checked card. This is estimated from
  prompt and answer sizes at Claude API prices (`results.json`), with the schema prefix counted as a
  cache read. Compile calls are $0.36 of that. Over the 5,125-card pool, the same pass rate would give
  about 1,450 checked cards for about $6.
- **Retries.** Five patches failed validation in round 1. In round 2, four of them were fixed and one
  was declined.
- **Hand audit.** I checked 10 random `compiled-checked` patches against Oracle text, and all 10 were
  correct: Scale the Heights, The Gold Saucer, Dogged Detective, Bramble Wurm, Astral Cornucopia, Death
  Baron, Might of Old Krosa, Guardian of Faith, Exsanguinator Cavalry and The Fifth Doctor. Guardian of
  Faith writes "any number" as a target count of at most 1,000. A reviewer should decide whether that
  stand-in is acceptable. The 23 flagged cards were not audited. In trial 01 and in the XMage pilot,
  most flags were false alarms.
- **The smoke game caught a validator gap.** Viridian Joiner's mana ability adds mana equal to its
  power (`powerOfSource`). The validator accepted it, but the engine throws, because mana abilities
  cannot read that value. Either the validator should reject it or mana abilities should support it.
- **The free text check settled only 4 of 109 valid patches.** The trial 01 cards were simple enough
  for the renderer, and these are not. Before it saves real model calls, the renderer needs to cover
  static effects, token specs, conditions and loyalty abilities.

## What would unlock the most cards

`refusal-groups.json` sorts the 191 declines by the engine feature each one is missing. A Sonnet-class
worker grouped them from the compiler's one-line reasons and the Oracle line. The grouping is a
judgement call, and some groups are loose.

**The gaps form a long tail.** No single feature blocks more than 7 of the 191 cards. There are 48
groups:

- 17 groups have at least 4 cards each, 120 cards together.
- Groups of 2 or 3 cards hold 70 cards.
- 37 cards need a one-off mechanic.

Each of the top features would unlock about 4 to 7 cards per 300, which is roughly 70 to 120 cards
across the pool.

| Cards | Missing feature                                                                                  |
| ----: | ------------------------------------------------------------------------------------------------ |
|     7 | Characteristic-setting effects with durations: base P/T, types, colors, abilities, become-a-copy |
|     6 | New trigger events: combat damage to a creature or planeswalker, land played, cycling, and more  |
|     6 | Dynamic mana-value comparisons in selectors (X, a count, a dead target's mana value)             |
|     6 | Turn-history conditions: attacked, lost life, a permanent left, creatures died this turn         |
|     6 | Per-player scope and "that player chooses" on effects                                            |
|     5 | Conditions on the triggering object or the event's player                                        |
|     5 | Alternative-cost keywords: evoke, buyback, encore, mayhem, paradigm                              |
|     5 | Granting landwalk, horsemanship and afflict                                                      |
|     5 | Reveal, exile or mill until a condition, then deal with the rest                                 |
|     4 | Mana that can only be spent on some spells or costs                                              |
|     4 | "Enters with counters" on blink, reanimation and copy effects                                    |
|     4 | Another player's optional choice on resolution                                                   |
|     4 | Random choice of a permanent, player or card                                                     |
|     4 | An announced X where the IR needs a fixed number                                                 |
|     4 | Variable target counts and a "number chosen" value                                               |
|     4 | Conditional spell cost changes                                                                   |
|     4 | Newer keyword actions: venture, the Ring tempts you, suspect, commit a crime                     |

## Files

- `targets.json`: the 300 cards.
- `patches/`: the 109 valid patches (source `compiler@haiku-worker`; four came from the Sonnet retry).
- `results.json`: per-card outcomes and the cost estimate.
- `refusal-groups.json`: the declines, grouped by missing feature.
- `work/`: pipeline state, every model answer, and the worker batch lists.
