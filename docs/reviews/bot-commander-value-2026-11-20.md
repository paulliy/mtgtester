# Bot: commander value and cost choices (2026-11-20)

The [gauntlet review](bot-gauntlet-2026-11-20.md) caught the bot sacrificing its own commander,
Kiki-Jiki, to Ashnod's Altar (pod 17). `commanderValue` was tried there with no measurable effect
and removed, because the bench could not seat a commander to gate it. This review records the
bench support, the root cause, the two fixes that ship, and their ADR 0043 gate.

## Root cause

`commanderValue` alone could not have changed pod 17. Ashnod's Altar's sacrifice is an activation
cost, which the engine offers as a `sacrificeCost` choice. `choiceValue` scored only the choices
in `LOSS_CHOICES` (`sacrifice`, `discard`, `exile`, `bottomCard`, `tapCost`), so the bot gave
every `sacrificeCost` option the same score and the seeded tie-break picked one. Raising the
commander's `permanentValue` had nothing to act on.

## What ships

| Fix              | Change                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `costChoices`    | A `sacrificeCost` choice is scored like any other loss: the least valuable permanent goes.                                                                    |
| `commanderValue` | A commander, the bot's own or an opponent's, is worth `commanderPermanentBonus` (4) more as a permanent and as a spell on the stack. Builds on `costChoices`. |

Bench positions can now name each seat's commander(s) (`position.commanders`); the scenario
builder puts a named commander on the battlefield from the command zone, or leaves it in the
command zone, with commander status either way (`bot-bench/README.md`).

Held-out positions, in `bot-bench/cases/tactician/single/`:

| Case                                | Fix              | Position                                                                   |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `altar-the-bears-not-the-angel`     | `costChoices`    | Wheel of Fortune paid through Ashnod's Altar: Grizzly Bears or Serra Angel |
| `altar-the-beast-not-the-commander` | `commanderValue` | The same payment: Kalonian Tusker or the bot's commander, Kiki-Jiki        |
| `swords-the-commander`              | `commanderValue` | The last Swords to Plowshares: an opponent's Talrand or a bigger Tusker    |

## Gate

**Bench, 8 seeds** (`bot-gate.json`; `local-heuristic` against `local-heuristic-0050`, the same
bot without the two fixes): PASS, +3.1 points overall, no position lower on any seed.

| Case                                | Before | After |
| ----------------------------------- | ------ | ----- |
| `altar-the-bears-not-the-angel`     | 38%    | 100%  |
| `altar-the-beast-not-the-commander` | 63%    | 100%  |
| `swords-the-commander`              | 30%    | 100%  |

Scoring `sacrificeCost` without `commanderValue` makes things worse on the commander position:
Kiki-Jiki goes to the Altar on 8 of 8 seeds, against 5 of 8 for the coin flip. `bot-fixes.test.ts`
pins this with `BUILDS_ON`.

**Gauntlet** (`bot-gauntlet --pods 80 --seed field --new fixed`, run twice: once with the two fixes
removed from the production defaults, once with them):

| `fixed` arm                  | Pairs | +   | −   | z    |
| ---------------------------- | ----- | --- | --- | ---- |
| without the two fixes        | 294   | 8   | 7   | 0.26 |
| with them                    | 293   | 13  | 12  | 0.20 |
| with against without, paired | 320   | 11  | 11  | 0.00 |

All 80 baseline games were identical across the two runs, so the third row pairs each (pod, seat)
directly. 102 of 320 seat games played differently and the wins came out even: no measurable
effect in the field either way. The Kiki-Jiki deck went 5 → 6 wins (+1/−0). In pod 17's Kiki-Jiki
seat, the bot without the fixes sacrificed Kiki-Jiki to the Altar twice (turn 22 for Wheel of
Fortune, once more later); with them it sacrificed Ingenious Artillerist and an Inkling instead
and copied creatures with Kiki-Jiki on turn 30. The table still lost that pod.

Three games that timed out at the gauntlet's 300 s limit were replayed with 30 minutes; two
became an ordinary win and a draw, and pod 46 seat 3 ended in the payment-budget halt below.

**Hill-climb** (`--repeat 3 --allow-behavior-change`, against the baseline at `c4524aba`): engine,
setup, coverage, authoring and compiler unchanged; the `bot` and `botCached` census modes improve
(calls per turn −3.1%, prompt tokens −5.5%). The `default` and `model` modes regress: calls per
turn 6.125 → 6.735, prompt tokens per turn 21,084 → 24,268, cacheable share 8.8% → 8.3%. That is
one census game changing course: with `commanderValue`, game 1 reaches a Cosmic Crucible copy of
Clever Concealment and takes 346 model calls instead of 197 (copy targets, trigger ordering,
Mister Fantastic's optional draws); games 0 and 2 get cheaper (−63 and −13 calls) and game 3 is
identical. The engine fixes below change no census game.

## Engine bugs the runs exposed

The hill-climb census hung on that game, and two gauntlet games timed out on the same spell.
`chooseNewTargets` (`stack/replicate-targets.ts`), which offers "you may choose new targets for
the copy" (CR 115.7d), proves every offered target has a legal completion by backtracking over all
positions and judging legality at the leaf:

- an illegal pick (an opponent's permanent for "target nonland permanents you control") walked
  every completion of the later targets before failing; six targets against forty permanents never
  finished;
- the menu loop skipped the search's duplicate check, so a pick equal to an earlier, already fixed
  target did the same; twelve targets never finished;
- standalone legality (re-running the layers) was repeated for every leaf.

Both loops now share one rejection check, and a target whose legality reads no other chosen target
is judged once per candidate. `packages/engine/tests/new-targets-search.test.ts` covers six and
twelve targets; both hung before. Offered menus are unchanged.

## Still open

- **Payment search cost:** pod 46's seat 3 spent minutes in `searchPayment` proving a spell
  castable twelve to fifteen activations deep, each activation queueing triggers and recomputing
  the layers, before the state budget halted it. Same machinery as the gauntlet review's halts.
- **"Cost became unpayable at application time":** pod 0, seat 4, without the two fixes, at the
  first decision (0 turns), reproducible.
- **Hill-climb baseline:** not rewritten until the `model` census regression above is accepted.
