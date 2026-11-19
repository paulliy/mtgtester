# ADR 0050: Bot answer discipline, face damage and play styles

Status: Proposed

Date: 2026-11-19

Builds on [ADR 0043](0043-card-aware-bot-baseline-and-fixes.md) (the bot's policy fixes and their
gate) and [ADR 0044](0044-tactician-escalation-triggers.md) (the `scarce-answer` trigger). Prompted
by the paid duel recorded in [ADR 0039](0039-bot-led-tactics.md) ("Paid duel, 2026-11-19").

## Context

In the 2026-11-19 paid duel, bot-led seats won 1 of 5 finished games against the model tactician.
Two things limit what that says:

- The duel ran with `AI_BOT_ESCALATION` empty (the default), so the bot never asked the model
  anything. It measured the bot with every ADR 0044 trigger off.
- It kept no per-decision record, so no lost game can be replayed to see where the bot went wrong.

What the record does show is the bot's own regression suite. On the 50 bot-bench positions the
card-aware bot with every ADR 0043 fix scored 93%. It missed four positions, and three of them were
the same mistake:

| Position                       | Bot's answer                   | Grade                                                        |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------ |
| `hold-negate-for-a-threat`     | Negate on Mind Stone           | 0%                                                           |
| `hold-the-counter`             | Counterspell on Rampant Growth | 0%                                                           |
| `hold-the-swords-for-a-threat` | Swords on Savannah Lions       | 30%                                                          |
| `shock-the-other-threat`       | Shock at P2's face             | 30% (the Lions were the target; the Bears were already dead) |

The first three are ADR 0044's `scarce-answer` positions: the bot spends its only counterspell or
hard removal on something small. A counterspell's value was a flat `counterAnswer` bonus whenever
any opposing spell was on the stack, whatever that spell was, and removal was worth a share of its
best target with no notion that it was the last answer in hand. The fourth is target scoring: any
opponent as a target was worth a flat 10 LEP, so two damage at a player on 30 life outranked killing
a 2/1.

Separately, the strategist steers the bot with six knobs (`BotSteering`). They reach attacks
(`aggression`, and only as two thresholds, so 0.2 to 0.74 all play the same), target order, held
mana, overextension, and per-card `prioritize` and `hold`. Nothing the strategist says changes
what the bot keeps its answers for, what it thinks damage at a player is worth, or which card roles
it values, so a "play like control this turn" plan cannot be expressed.

## Decision

1. **`scarceAnswer` policy fix.** When the bot would cast the last counterspell or hard removal of
   its kind in hand, and the public board shows no lethal either way, it keeps the card unless the
   target is worth it:
   - a countered spell must reach a threat of 4: its mana value, plus 3 for a wipe, an extra turn
     or a team pump;
   - hard removal's best target must reach 9 LEP, ADR 0043's lethal and clear-the-blocker bonuses
     included.

   A held answer scores just below passing. The cap is applied before the strategist's knobs, so a
   `prioritize` on the card still spends it. A target the bot cannot value (an ability on the stack,
   an unknown card, removal with no target slots) is never held, and wipes are left alone: they are
   already valued by what they remove on each side. The fix builds on `neverYield`, without which
   the bot keeps the counter and then yields the turn away with it.

   "Last of its kind" and "lethal on the public board" are the definitions ADR 0044's trigger used.
   They move from `server/src/ai/escalation.ts` to `bot/src/answers.ts`, and the trigger imports
   them, so the bot and the trigger cannot disagree about either.

2. **`faceDamage` policy fix.** Damage at a player that does not kill is worth the damage times
   `faceDamagePerLife` (1) times 0.5 plus aggression, plus the usual pressure term, instead of the
   flat player value. Killing damage keeps the flat value. The fix builds on `ownStack`, which is
   what sees that a Bolt already on the stack kills the Bears.

3. **The `scarce-answer` trigger becomes a double-check.** It still fires when the bot would spend
   a last answer and no lethal is at stake, but the bot now does that only above the thresholds,
   so the trigger fires less and asks the model about the spends that are close, not the ones the
   bot already gets wrong. On ADR 0044's own positions it now fires on `negate-the-blasphemous-act`
   and `wrath-the-crowded-table` only.

4. **`ai-mode-duel --trace F.jsonl`.** One JSON line per decision: seat, mode, the menu, the answer
   with its targets named, who answered (bot, cache, plan, model, fallback), the triggers that
   fired, the knobs in force and every seat's life; an `end` line closes a finished game. Lines are
   appended as decisions are made, so a hung game keeps what it played. The next paid duel should
   run with it.

5. **Play styles, measured but not yet wired to the strategist.** `BotSteering.style` takes
   `aggro`, `midrange`, `control` or `combo`. A style fills the knobs the strategist left unset
   (`aggression`, `holdUpMana`, `avoidOverextending`) and scales a few weights: the two
   `scarceAnswer` thresholds, `faceDamagePerLife`, and the values of card roles. The presets live
   in `WEIGHTS.styles`; `midrange` is the plain bot. `bot-league` has an arm per preset and a
   `styled` arm that takes the style from the deck's archetype (`server/src/ai/play-style.ts`).

   The strategist cannot set a style yet: `cleanSteering` drops the field and the bot-led primer
   does not mention it. Wiring it is one knob in each, plus the deck's archetype as the default
   when the strategist sets none. That waits for the measurements below to show a preset is worth
   offering.

## Measurements

Full tables and commands: [review](../reviews/bot-answer-discipline-2026-11-19.md).

- **bot-bench, eight gate seeds** (ADR 0043 decision 3.1): the bot with both fixes against the bot
  before them, 52 positions. Overall 92% to 100% on every seed, five positions higher, none lower.
- **Held-out positions** (decision 3, written after the fixes were tuned): `counter-the-angel`
  (the last counter still answers a five-mana flier: 100% with and without the fix) and
  `bolt-the-tusker-not-the-face` (30% before, 100% after).
- **League** (decision 3.3): 100 games, `fixed` against `fixed-0043`, seats swapped each seed.
  44 wins to 36 (55%, 95% interval 44 to 66%), life share 0.55 to 0.45; 20 games halted on an
  engine payment refusal that also halts games without these fixes. Not a significant gain, and no
  sign of a loss, which is what the gate asks.
- **Styles**: see the review. League decks are generated from the coverage pool and 97% of them
  classify as midrange (194 of 200 seats; 6 control, no aggro or combo), so the `styled` arm is
  nearly the plain bot there. Each preset was measured on its own against the plain bot instead.

## Consequences

- `BOT_POLICY_VERSION` changes. Seeded tests and replays that depended on the bot spending a last
  counter or bolting a face now see it hold or hit a creature.
- ADR 0044's call census numbers for `scarce-answer` were taken with the old bot and overstate how
  often it fires now.
- The fallback bot in model mode plays with these fixes too, as with every ADR 0043 fix.
- The thresholds are starting values chosen from the bench positions, then checked on positions
  written afterwards and in the league; they are tuning candidates like every other weight.
- Style presets are guesses until the league or a paid duel says otherwise. The league cannot test
  "style matched to deck" until it plays decks that are not all midrange.
