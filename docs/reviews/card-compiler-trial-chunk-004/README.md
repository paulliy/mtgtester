# Campaign chunk 004 (2026-11-14): stopped at the meaning check

Chunk 004 of the [batch card compile campaign](../../plans/batch-card-compile-campaign.md): the
next 300 pinned EDHREC cards by rank that no trial had seen (ranks 3,130 to 3,904). **Nothing from
this chunk is promoted.** The campaign is stopped under its stop rule: the meaning check missed a
known-wrong calibration case twice.

## Where it stopped

| Stage                                   | Cards |
| --------------------------------------- | ----: |
| Selected                                |   300 |
| Compiler declined (`inexpressible`)     |   212 |
| Valid patch (validator and smoke games) |    88 |
| Meaning check                           |  void |

Both meaning checks (the first, and a second by fresh back-translation and judge workers with the
same instructions) called the calibration case **Urza's Power Plant** "same". That patch checks for
permanents _named_ Urza's Mine and Urza's Tower, where the card means the land _types_. Both
back-translations said "a permanent named Urza's Mine", so the difference was on the page; both
judges read "an Urza's Mine" in the card as a name. The plan says a second miss stops the campaign,
so it stops here for a decision.

The case joined the calibration set after the PR #72 review. It is a fair test only if a judge is
expected to know that Urza's Mine is a land type; the judge prompt does not say so, and the two
earlier misses (Thran Turbine) were fixed by adding a rule to the prompt, which also weakened that
case as a test.

## Main-thread audit (done before the stop)

Every valid patch was read against Oracle text and the engine. Seven would be rejected: Daybreak
Coronet (the enchant restriction is checked only on cast), Eye of Nidhogg (adds Dragon instead of
replacing creature types), Cryogen Relic (stun counters do nothing in the engine), Flourishing
Defenses (one trigger per placement, not per counter), Infiltration Lens (one trigger, not one per
blocker), Invigorating Surge (doubles every counter kind) and Secrets of the Dead (any graveyard,
not yours). None is recorded in the review queue, because the queue refuses a trial that failed
calibration.

## Pipeline finding

The retry round found that once a card has any registered patch, the interpreter stops stripping
generic ability labels ("Summary Execution —", "Eukrasia —"), so a line it parsed before becomes
unrecognized and the card cannot be completed (Commissar Severina Raine, Alphinaud Leveilleur).
