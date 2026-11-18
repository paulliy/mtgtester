# Card compiler calibration run 01 (2026-11-13)

The first run of the calibration set (`scripts/card-compiler/calibration.json`) through the meaning
check, to find out whether back-translation and judge by Haiku workers catch a patch that is known
to be wrong. This trial has no cards of its own (`targets.json` is empty): `run.ts calibrate` with
`--calibration 50` filled it with 30 cases, one for each card the set covers.

## Result

| Case                                                  | Cases | Judged "different" | Judged "same" |
| ----------------------------------------------------- | ----: | -----------------: | ------------: |
| Wrong: the two patches the trial 01 audit found wrong |     2 |                  2 |             0 |
| Wrong: broken variants of audited-correct patches     |    25 |                 25 |             0 |
| Correct: audited patches                              |     3 |                  0 |             3 |

- **Every wrong patch was caught, 27 of 27**, and each listed difference names the change that was
  made: the added target on Charmbreaker Devils, the spending restriction on Thran Turbine, each
  flipped "you may", each widened target, each dropped effect or condition, each number off by one.
- **No false alarm on the three correct cases.** That is too few to measure a false-alarm rate. The
  trials measured about 3 in 18. A false alarm costs a review, not a wrong card.
- The free text check (`render.ts`) matched none of the 27 wrong patches; a test holds it to that.

## How it was run

Four Haiku workers, one stage each: two back-translated 15 prompts each from
`work/batches/back-NN.txt`, and two others judged 15 each from `work/batches/judge-NN.txt`. No worker
saw both stages, the back-translators saw no Oracle text, and the judges saw no card data. Each
worker read only its stage's prefix file, its batch list and the prompts on it.

One judge worker saved an answer under the wrong extension before saving it correctly; the stray
file was removed. `run.ts check` warns about a file like that.

## Caveats

- The broken variants are single-step changes. A patch that is wrong in a way no mutation operator
  makes (a misread rule, a wrong zone) is represented only by the two audited cases.
- The judge workers were told that differences are common and that known cases are planted. That
  pushes toward "different", which is the safe direction and may raise false alarms.
- One run, 30 cases. Every campaign chunk carries ten more, so the record grows with the campaign.
