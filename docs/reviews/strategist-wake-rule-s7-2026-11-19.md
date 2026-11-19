# Strategist wake rule `table-v2`: paid duels (hill-climb S7, 2026-11-19)

The paid check that PR #92 left pending: does `AI_STRATEGIST_WAKE_RULE=table-v2` cut strategist
calls against real models, and does it cost the bot-led seats strength? 56 four-player games on
OpenRouter, $0.94 in all.

**Result.** table-v2 made 18.6% fewer strategist calls and 15.9% fewer prompt tokens per seat
turn than table-v1, and lower in 44 of 47 comparable games. Wins were 20 to 19. This is evidence
for merging the rule; it does not rule out a strength difference smaller than about 15 points.

## Method

`bun run ai-mode-duel --opponents bot-v1 --max-usd 1 --seed <S> [--swap] --json <F>`, run from
the PR #92 head (`9b9edc87`) plus the reporting commit below. All four seats are bot-led with the
same strategist chain (`z-ai/glm-5.3-flash`, then `deepseek/deepseek-v4-flash`); P1 and P3 wake
the strategist under table-v2, P2 and P4 under table-v1, and `--swap` reverses that on the same
decks. Turn cap 60. No game reached its $1 cap and no call failed after retries.

Seeds: `s7-duel-1` to `s7-duel-3` (6 games), then `s7-batch-1` to `s7-batch-25` (50 games), each
seed played straight and swapped.

The first six games showed that strategist calls per game turn mislead: a side whose seats live
longer is asked more often whatever its rule. The duel report now gives each seat's own turns and
elimination turn, strategist calls and prompt tokens per own turn, each side's wake reasons and
the engine's halt reason. The call figures below come from the 50 games with that report.

In the per-game reports (`reports/`), `bot` is the table-v2 side and `model` the table-v1 side.
`summarize.py` reproduces every number here: `python3 -I summarize.py <this directory>`.

## Calls and tokens

| Rule     | Strategist calls | Own turns | Calls per own turn | Prompt tokens per own turn | Cost   |
| -------- | ---------------- | --------- | ------------------ | -------------------------- | ------ |
| table-v2 | 641              | 1,068     | 0.600              | 2,040                      | $0.379 |
| table-v1 | 796              | 1,080     | 0.737              | 2,424                      | $0.454 |
| Change   |                  |           | −18.6%             | −15.9%                     |        |

Per game (both sides at least 10 own turns, 47 games), table-v2's calls per own turn were a
median 0.81 of table-v1's, and lower in 44 games.

The offline hill-climb measured −24.7%. The difference is the reuse limit: with fewer table
wakes, table-v2 hits the 3-turn limit more often, and that limit is now the floor.

## Wake reasons

Counted per call, seat dropped; one call can have several reasons.

| Reason      | table-v2 | table-v1 |
| ----------- | -------- | -------- |
| commander   | 161      | 605      |
| life        | 286      | 259      |
| permanents  | 146      | 178      |
| power       | 125      | 158      |
| gone        | 101      | 104      |
| first knobs | 100      | 100      |
| reuse limit | 73       | 16       |

Commander wakes fell by three quarters. Under table-v2 every `commander` wake is a commander
leaving; arrivals no longer wake. The seat's own board growing no longer wakes either, which shows
as fewer `power` and `permanents` wakes.

## Wins

| Games       | Decided | table-v2 wins | table-v1 wins |
| ----------- | ------- | ------------- | ------------- |
| duel 1–3    | 5       | 2             | 3             |
| batch 1–10  | 14      | 5             | 9             |
| batch 11–25 | 20      | 13            | 7             |
| All         | 39      | 20            | 19            |

table-v2 won 51% of decided games (95% Wilson interval about 36 to 66%). Of the seeds where both
games were decided, each rule won both 3 times and 9 split. The table-v1 lead after the first 26
games (12 to 7) did not hold. Winners by seat: P1 7, P2 7, P3 12, P4 13.

## Halts

17 of 56 games ended without a winner, spread evenly over the rules: 12 on the unmodeled "mana
payment" gap (changing-resource casting payment), 4 at the 60-turn cap, and 1 from the first
batch, whose report did not yet carry a reason. Seeds `s7-batch-4`, `-7`, `-11` and `-19` halted
in both games. The 30% halt rate is well above the bot league's 12% and is an engine issue apart
from this rule.

## What this does not show

- Strength within about 15 points either way; ruling out a 5-point gap needs several hundred
  decided games.
- Strategist quality: knobs were not compared, only calls and outcomes.
- Other strategist models: every call ran on `z-ai/glm-5.3-flash` or its fallback.

## Reporting change

`ai-mode-duel` gained a `SeatTracker` (own turns and elimination turn per seat), per-side
`ownTurns`, `strategistCallsPerOwnTurn`, `promptTokensPerOwnTurn` and `strategistWakes`, and the
engine's `halted`, `haltReason` and `haltSite`. Covered by `ai-mode-duel.test.ts`.
