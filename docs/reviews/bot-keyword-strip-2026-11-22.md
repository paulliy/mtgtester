# Bot: Shadowspear with nothing to strip (2026-11-22)

In a paid four-seat game (seed `four-way-1`, traced), the bot-led seat P3 (Klauth, Unrivaled
Ancient) activated Shadowspear's `{1}: Permanents your opponents control lose hexproof and
indestructible until end of turn` 26 times, usually three times in its own upkeep and again in
opponents' upkeeps. No opposing permanent had hexproof or indestructible. The mana went before its
main phase, and the seat cast 5 spells in 9 turns. This review records the root cause, the fix
(`keywordStrip`) and its ADR 0043 gate.

## Root cause

The card-trait classifier (`packages/server/src/ai/card-traits.ts`) gives Shadowspear's first
ability no role: `loseKeywordsEachUntilEot` matches none of the role patterns, so `abilityRoles` is
`[[], []]`. The policy (`actionValue` in `packages/bot/src/policy.ts`) scores every activation as
`tempo.activateAbility` (3) plus its roles' value, so this one scored a flat 3 against `pass` at 0.
The repeat damper (`evaluate.ts`) then gave `3 × 0.6^n − 0.5n`: 3, 1.3 and 0.08 for the first
three activations in a window, and −0.85 for the fourth. That is the three activations per upkeep
seen in the game. The equip ability was already handled by `attachOrCrewPenalty`.

The obvious fix, no tempo baseline for an ability with no role, would have been far too broad. Of
the 1,331 activated abilities in the pinned EDHREC pool that the engine models, 458 have no role,
and most of them do real work: surveil and scry (32), untap (37), manlands animating (18),
proliferate (8), unblockable (12), Walking Ballista's counters. Dropping their baseline would stop
the bot using any of them. Only three abilities in the pool only strip keywords:
`loseKeywordsEachUntilEot` (Shadowspear, Bonds of Mortality) and `denyKeywordsEachUntilEot`
(Arcane Lighthouse).

## What ships

| Change                                                                                                                                                                                                                 | Where                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `CardTraits.abilityKeywordStrip`: per ability, the selector and keywords of an ability whose only effect is to strip keywords until end of turn; `null` for any other ability                                          | `packages/bot/src/card-knowledge.ts`, `packages/server/src/ai/card-traits.ts` |
| `keywordStrip` fix: such an activation scores `pointlessActivation` (−2) when no opponent's permanent that the selector matches has one of the keywords, or while this seat's earlier activation is still on the stack | `packages/bot/src/policy.ts`, `fixes.ts`                                      |
| `BOT_POLICY_VERSION` `2026-11-22.keyword-strip.1`                                                                                                                                                                      | `packages/bot/src/version.ts`                                                 |
| League arm `fixed-0052` (production bot before `keywordStrip`) and bench entries `local-heuristic-0052` and `fix-keyword-strip`                                                                                        | `bot-league.ts`, `bot-gate.json`                                              |

Details:

- "Hexproof from [quality]" counts as hexproof, because an effect that removes hexproof removes
  those too (CR 702.11e). Keywords are matched by prefix.
- The view leaves `PermanentView.keywords` out when a permanent has **none**, not only when it is
  face down (`engine/src/view/view.ts`). The first version of the fix read "absent" as "might be
  hidden" and changed nothing in real play; the unit tests had missed it because their helper always
  sets `keywords: []`. Only a face-down permanent, which also has no `typeLine`, now counts as a
  possible subject. The field's doc comment in `shared/src/view.ts` now says so.
- When there is a subject, the ability keeps today's value. Whether the bot then follows up (removal
  on the newly targetable creature) is not modeled. Activating with a subject but no follow-up in
  hand is still possible and is left open.

Held-out positions in `bot-bench/cases/tactician/single/`:

| Case                               | Position                                                                                 | Best     |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| `shadowspear-idle-in-upkeep`       | Own upkeep, Kalonian Tusker and Serra Angel in hand, no opposing hexproof/indestructible | Pass     |
| `shadowspear-idle-in-their-upkeep` | P2's upkeep, Swords to Plowshares in hand, the same board                                | Pass     |
| `shadowspear-before-murder`        | Main phase, Murder in hand, P2's Carnage Tyrant is the only creature                     | Activate |

Unit tests: `packages/bot/src/policy.test.ts` (`keywordStrip`: no subject, a pin of the old
three-per-window behaviour without the fix, hexproof / hexproof from / indestructible, absent
keywords against face down, own activation on the stack, a creatures-only selector) and
`packages/server/src/ai/card-traits.test.ts` (Shadowspear, Arcane Lighthouse, Bonds of Mortality,
and Lightning Greaves without the field). `bot-fixes.test.ts` pins the two idle positions to
`keywordStrip`, which builds on `scarceAnswer` and `neverYield`. Alone, it keeps Shadowspear idle in P2's
upkeep but spends the Swords on a mana elf.

## Gate

**Bench, 8 seeds** (`bot-gate.json`; `local-heuristic` against `local-heuristic-0052`): PASS, +2.8
points overall, no position lower on any seed.

| Case                               | Before | After |
| ---------------------------------- | ------ | ----- |
| `shadowspear-idle-in-upkeep`       | 0%     | 100%  |
| `shadowspear-idle-in-their-upkeep` | 30%    | 100%  |
| `shadowspear-before-murder`        | 100%   | 100%  |

**Gauntlet** (`bot-gauntlet --pods 80 --seed field --new fixed,fixed-0052 --jobs 4`):

720 games: 80 baseline pods with the old bot (`fixed-0043`) in every seat, then each seat switched
to each arm. 648 ended in a win, 67 halted on the known payment-search budget (see the
[commander value review](bot-commander-value-2026-11-20.md)) and 5 timed out, the same for both
arms.

| Arm against `fixed-0043`      | Pairs | +   | −   | z     |
| ----------------------------- | ----- | --- | --- | ----- |
| `fixed` (with `keywordStrip`) | 287   | 15  | 19  | −0.69 |
| `fixed-0052` (without)        | 287   | 15  | 19  | −0.69 |
| with against without, paired  | 320   | 0   | 0   | 0.00  |

The two arms played identically in 318 of 320 seat games. Both that differed are the Silverquill
Influence seat, the only gauntlet deck with a keyword stripper (Arcane Lighthouse), and in neither
did that seat's result change: in pod 19 the same seat won on the same turn with different life
totals; in pod 42 the seat lost either way (another seat won on turn 32 with the fix, turn 49
without). No regression, and no measurable effect in the field: no gauntlet deck plays Shadowspear
or Bonds of Mortality. The `fixed` arm's −0.69 against the old bot is the existing production
bot's, unchanged by this fix.

## Not reproduced

`packages/server/src/cli/ai-four-way.ts`, the script named in the report, is not in this checkout
and nothing in the repository refers to the `four-way-1` seed, so the paid game itself was not
replayed. The bench positions reproduce the decision: on the old policy the bot activates
Shadowspear at score 3.00 in both upkeep positions.
