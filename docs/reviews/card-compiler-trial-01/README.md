# Card compiler trial 01 (2026-11-09)

First run of the batch card compiler (`scripts/card-compiler/`) on 50 unmodeled EDHREC cards. Each
card was blocked by exactly one rules line the parser could not read. Cards were spread across rank
683 to 12,608; 30 came from the set the XMage scan found built only from XMage library classes that
cards we already model also use, so the two approaches can be compared on the same cards.

## Result

| Outcome            | Cards | Meaning                                                                     |
| ------------------ | ----: | --------------------------------------------------------------------------- |
| `compiled-checked` |    15 | Valid IR, smoke games pass, back-translation judged the same as Oracle text |
| `meaning-differs`  |     5 | Valid IR and smoke pass, but the meaning check flagged a difference         |
| `inexpressible`    |    30 | The model declined: the IR cannot say the line exactly                      |
| `invalid`          |     0 | Still rejected by the validator after retries                               |

- **Cost.** About $0.16 for the whole run, estimated from prompt and answer sizes at Claude API prices
  (`results.json`, `estimatedCost`). $0.12 of that is one Sonnet retry paying a cache write on the
  49,000-token schema prefix; the 50 first-round Haiku compiles cost about $0.04, and the
  back-translation and judge calls about $0.001 together. That is under a cent per checked card,
  against about 25 agent-minutes per card for the manual workflow. At scale the retry model's
  prefix is a cache read too, so a retry costs about half a cent.
- **Retries.** One card failed validation on the first round (an effect referencing a target slot it
  had not declared). The retry declined it as inexpressible.
- **XMage overlap.** 13 of the 30 "known classes" cards came out `compiled-checked`, against 2 of the
  20 others. The XMage class scan is a good predictor of which cards the compiler can do today.

## How good are the checks?

Every valid patch was audited by hand against Oracle text (main thread, rules review).

- **18 of 20 valid patches are correct.** Two are subtly wrong: Charmbreaker Devils makes the
  random graveyard card a target (the real card does not target), and Thran Turbine restricts the mana
  to activating abilities (the real card only forbids casting spells).
- **The meaning check caught both** in each of two runs. The first run flagged Charmbreaker Devils for
  the wrong reason (a back-translation slip) but still sent it to review.
- **False alarms: 3 of 18 correct patches per run.** All six came from the cheap back-translator
  misreading the data (layer 7b "base power" read as +4/+4, one trigger with two effects read as two
  triggers, a missing implicit {T}) or from the judge reading whole-card context as missing lines.
  Between the runs the back-translation prompt gained notes on implicit {T}, default graveyard owner
  and random targets, and the judge saw the whole card; that fixed three alarms and produced three
  different ones, so the alarm rate is noise in a cheap model, not a prompt bug to tune away on these
  same 20 cards. A false alarm costs a review, not a wrong card.
- **The smoke game never failed** on a validated patch. It confirms the card runs in a real game
  (cast, abilities resolved in 15 of 20) but it is not where errors were caught; the validator and
  the meaning check did that work.
- **Refusals are honest.** Seven of the 30 refusals were checked against the engine source (Adept
  Watershaper, Grand Arbiter Augustin IV, Smallpox, Feline Sovereign, Game Over, Transpose, Spawnbed
  Protector); each named a real gap. None of the 30 looked like a line the IR can already say.

## The refusals are a primitive backlog

Each refusal names the missing piece in one sentence, so the compiler doubles as a gap finder. From
this trial: either/or additional costs, protection from a creature type or from players, an
opponents' spell tax for all zones, "cast from hand" conditions, a value for the sacrificed
permanent's mana value, "tapped" in continuous effects, "dealt damage this turn" targeting, the
starting life total, life-payment triggers, damage-plus-one replacements, and a no-op for
deck-construction lines like Rat Colony's. Run over the 5,175 candidate cards, the refusal reasons
grouped by missing piece would rank primitives by how many cards (and deck slots) each unlocks.

## Caveats

- The model calls were made by Haiku- and Sonnet-class agents reading the same prompt files, because
  this environment has no API key. Cost is estimated from text size (about 3.5 characters per token).
  `run.ts exec` makes the real API calls and records measured usage in `work/usage.jsonl`.
- 50 cards is a small sample; the pass rate could move by ten points either way.

## Files

- `targets.json`: the 50 cards and their XMage bucket.
- `patches/`: the 20 validated patches.
- `results.json`: per-card outcome, validator issues, refusal reason, smoke runs, back-translation and
  judge differences, and the cost estimate.
- `work/state.json` and `work/answers/`: the raw pipeline state and every model answer, including the
  first meaning-check run (`answers/back.<timestamp>/`, `answers/judge.<timestamp>/`).
