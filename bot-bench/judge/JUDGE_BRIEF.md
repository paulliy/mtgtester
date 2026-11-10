# Judge brief: Commander tactician benchmark

You are judging language models that play Magic: The Gathering (Commander, four players) as a
**tactician**: at each decision the game engine shows the model the board and a menu of legal
actions, and the model picks one. Every model in this bundle was put in the same positions, with
the same instructions and the same menu, against the same scripted opponents. Your job is to say
how good each one is on three separate questions, then give a recommendation and a short blurb.

Run summary: {{RUN_LINE}}

Candidates to score: {{CANDIDATES}}

{{BASELINE_NOTE}}

{{BLIND_NOTE}}

## Read in this order

1. `JUDGE_BRIEF.md`: this file.
2. `PRIMER.md`: the rules you need to follow the positions, and the exact instructions the models
   were given.
3. `SUMMARY.md`: every model side by side. Accuracy, speed and cost tables, one grid of what each
   model did in each case, and the list of cases where the models disagreed.
4. `cases/`: one page per position. The board as the model saw it, the legal menu, the reference
   analysis with what the engine says each choice leads to, and every model's answer side by side.
5. `models/`: one page per model. Every decision it made, the reason it gave, its raw output, and
   the time and tokens it took.
6. `scorecard.template.json`: fill this in and return it. `scorecard.schema.json` defines it.
7. `data/`: the same information as JSON, including full prompts and raw responses.

## The two kinds of case

- **One decision** ({{SINGLE_COUNT}} cases). The model answers a single decision: an attack, a
  block, a target for a removal spell, whether to counter a spell, which land to play. The case
  page lists every legal answer, the grade the reference gives it, and what happened when the
  engine played it out.
- **Whole turn** ({{TURN_COUNT}} cases). The model makes every decision of its own turn, in order:
  land, spells, attack, combat tricks, damage assignment. The case page lists the objectives a good
  turn meets, reference lines the engine replayed (the best line and typical mistakes), and each
  model's sequence of actions with the first point where it left the best line.

## How the harness scored, so you can check it

- One-decision cases: the answer's reference grade is worth `best` 1.0, `good` 0.7, `weak` 0.3,
  `blunder` 0. An answer the model never legally produced scores 0.
- Whole-turn cases: the share of objective points the final position meets.
- If a model's answer was not legal, the production pipeline asks once more with the error
  (a "corrective retry"); if that also fails, the heuristic bot plays the decision (a "fallback").
  Both are counted against the model under reliability.

The harness score is evidence, not your verdict. The reference analysis was written by a reviewer
and each claim in it was replayed through the rules engine, but a grade can still be debatable.
Where you disagree with a reference grade, say so in `referenceDisagreements` and score the model
on your own judgment. The consequences shown for each option are what the engine actually did;
treat those as facts.

## Score three things separately, each from 0 to 10

Keep the three scores independent. A slow model does not lose accuracy points, and a cheap model
does not gain them.

### 1. Accuracy: does it choose well, and legally?

Weigh, in this order:

1. Blunders. An answer that gets the model eliminated, throws away a kill that was on the board,
   or wastes its only answer matters more than several small inefficiencies.
2. Best answers found in one-decision cases, and objectives met in whole-turn cases.
3. Reliability: answers that were illegal or unparseable, corrective retries, fallbacks, turns cut
   off for looping.
4. Consistency between trials, when the run has more than one.

Judge the action, not the explanation. A model's `note` can show whether a good answer was
understood or lucky; use it to break ties, never to excuse a bad action.

| Score | Anchor                                                                                       |
| ----: | -------------------------------------------------------------------------------------------- |
|    10 | Best answer in every case, every objective met, no illegal answers.                          |
|     8 | No blunders; at most a couple of non-best answers or missed minor objectives.                |
|     6 | Mostly sound; one or two blunders, or a pattern of weak choices.                             |
|     4 | Several blunders, or legal play that is clearly worse than the heuristic baseline in places. |
|     2 | Loses to the heuristic baseline overall, or frequently fails to produce a legal answer.      |
|     0 | Cannot be used: almost no legal, sensible answers.                                           |

### 2. Speed: how long does a decision take?

The tactician is called for every decision of a live game, one after another, while people watch;
a four-player game is on the order of {{DECISIONS_PER_GAME}} such calls. The production pipeline
gives a tactician call {{TIMEOUT_SECONDS}} seconds before it gives up. Use the per-decision
latency (median and 90th percentile) and the time to finish a whole turn. Latency is wall-clock
time measured by the harness, retries included, from one machine during one run: compare models
within this bundle, and treat small differences as noise.

| Score | Anchor (median / 90th percentile per decision)            |
| ----: | --------------------------------------------------------- |
|    10 | Under 0.5 s / under 1.5 s. Feels instant.                 |
|     8 | Under 1 s / under 3 s.                                    |
|     6 | Under 2 s / under 5 s. Noticeable but watchable.          |
|     4 | Under 4 s / under the timeout. A game drags.              |
|     2 | Median over 4 s, or the 90th percentile over the timeout. |
|     0 | Routinely times out.                                      |

### 3. Cost: what is a decision billed?

Use the cost tables: total spend, cost per decision, and the projection to a
{{DECISIONS_PER_GAME}}-decision game. Each figure carries its source: `reported` (the provider
returned the charge), `estimated` (tokens times the price list given to the harness) or `unknown`.
When the cost is unknown, compare token counts instead and say that your confidence is lower.

| Score | Anchor (projected cost per {{DECISIONS_PER_GAME}} decisions) |
| ----: | ------------------------------------------------------------ |
|    10 | $0.01 or less.                                               |
|     8 | $0.05 or less.                                               |
|     6 | $0.20 or less.                                               |
|     4 | $1 or less.                                                  |
|     2 | $5 or less.                                                  |
|     0 | More than $5.                                                |

If the person who sent you this bundle gave different speed or cost budgets, use theirs.

### Overall, and the blurb

`overall` (0 to 10) is your recommendation for the tactician seat, not an average of the three
scores. Accuracy comes first: a model that blunders is not rescued by being cheap or fast. Among
models of similar accuracy, prefer the faster and cheaper one, and say what the trade-off is.

For each model write a `blurb` of two to four plain sentences: what it does well, where it failed
(name the cases), and whether you would use it as the tactician. Write for someone who has not
read the case pages.

## Rules for judges

- Judge only from this bundle. Do not guess which model is behind an alias and do not use
  anything you believe about a model family.
- Name the case id for every claim about play quality.
- The rules engine is authoritative on what is legal and on what happened.
- If something cannot be judged (a model that stopped early, a cost that is unknown and has no
  token data), give `null` for that score and explain why in its reason.
- Do not score the baselines unless the brief above lists them as candidates.

## What to return

Return one JSON object that matches `scorecard.schema.json`, starting from
`scorecard.template.json`. Return only the JSON: no text before or after it.
