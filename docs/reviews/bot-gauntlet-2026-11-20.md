# Bot gauntlet: the new bot against the old one across archetypes (2026-11-20)

ADR 0050's mirrors showed whether a preset beats the plain bot on its own deck. This review asks
the question that matters in a real pod: with three opponents on other decks, all played by the
old bot, does a seat do better under the new bot? It also records which test decks were found,
whether combo decks can work with the bot at all, the review of the games that changed, and an
engine fix the runs exposed.

## Method

`bun run bot-gauntlet` (`packages/server/src/cli/bot-gauntlet.ts`):

- 18 premade decks (13 coverage decks, 5 real lists adapted to the modeled pool), each pinned to
  the style it is built for in `fixtures/deck-styles.json`;
- 80 pods of four different decks, every deck seated about equally often;
- each pod is played once with the old bot (`fixed-0043`) in every seat, then replayed with the
  same seed, decks and seats and **one** seat switched to a new arm, for each seat and each arm;
- each (pod, seat) is a pair: that seat's result under the old bot and the new one at the same
  table. Only the discordant pairs move the result: `+n` the new bot won and the old lost, `−n`
  the reverse.

`bun run bot-gauntlet --pods 80 --seed field --new fixed,styled,proxy-v2-styled --jobs 4`, 1,040
games per run. Arms:

| Arm               | What the switched seat plays                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `fixed`           | The production bot: ADR 0043's fixes plus `scarceAnswer` and `faceDamage`.       |
| `styled`          | `fixed` plus the deck's style preset.                                            |
| `proxy-v2-styled` | `styled` plus knobs from the deterministic proxy strategist, re-asked on change. |

The archetype classifier (`styleForDeck`) calls 16 of these 18 decks midrange, including the
control, combo and aggro test decks, so the gauntlet pins styles by hand rather than trusting it.

## Test decks

Three decks per archetype were the target. Sources searched:

- **Archidekt** (338 public Commander decks across six archetypes, five or more per commander):
  none was playable as is. The fewest unmodeled cards in any of them was 14.
- **MTGJSON precon deck lists:** only the 8 already in `fixtures/coverage-decks` model fully.
- **Moxfield** refused automated requests (403).

Five Archidekt lists were adapted: each unmodeled card was swapped for a modeled one of the same
type, color identity and mana value ±1 that shares the most roles, creature types and power
(`fixtures/archetype-decks/manifest.json` lists every swap and source URL). Tatyova was dropped:
its adapted list ran away (an engine out-of-memory kill) and Aesi replaced it.

| Style    | Decks                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| aggro    | Ruby, Brigid, Purphoros (adapted), Token Triumph                                          |
| control  | White-black control, Pramikon, Grand Arbiter Augustin IV (adapted)                        |
| ramp     | Living Energy, Urdragon, Aesi (adapted)                                                   |
| combo    | Niv-Mizzet, Parun (adapted), Kiki-Jiki, Mirror Breaker (adapted): no third deck was found |
| value    | Marchesa, the Black Rose; Necron Dynasties; Silverquill Influence                         |
| midrange | Queen Marchesa; Draconic Destruction; The Fantastic Four                                  |

How strong each deck is in the bot's hands (old bot, every seat, first run's decided base games):
Ruby, Draconic Destruction and Queen Marchesa win 53 to 56% of their pods and Purphoros 50%;
Aesi, Niv-Mizzet, Marchesa, Brigid and Necron win 6 to 7%, and The Fantastic Four 0 of 15. Ramp
and combo decks convert poorly whichever bot plays them.

## Results

| Arm               | First run (v2 bot) | After the review (v3 bot) |
| ----------------- | ------------------ | ------------------------- |
| `fixed`           | +8 / −5            | +12 / −11                 |
| `styled`          | +18 / −18          | +18 / −18                 |
| `proxy-v2-styled` | +24 / −24          | +23 / −23                 |

About 290 usable pairs per arm and run; a seat wins about a quarter of its pods either way.

By style, discordant pairs (v2 → v3):

| Style    | `fixed`       | `styled`      | `proxy-v2-styled` |
| -------- | ------------- | ------------- | ----------------- |
| aggro    | +1/−1 → +2/−1 | +9/−3 → +6/−2 | +10/−4 → +10/−3   |
| control  | +3/−0 → +4/−1 | +1/−5 → +4/−4 | +6/−5 → +6/−5     |
| combo    | +2/−0 → +2/−1 | +4/−1 → +4/−1 | +3/−3 → +3/−2     |
| ramp     | +0/−0 → +1/−1 | +2/−2 → +2/−3 | +0/−2 → +0/−3     |
| value    | +0/−1 → +3/−4 | +0/−4 → +2/−5 | +2/−3 → +3/−2     |
| midrange | +2/−3 → +0/−3 | +2/−3 → +0/−3 | +3/−7 → +1/−8     |

What holds across both runs:

- **The aggro preset wins in the field.** Styled and proxy-steered aggro seats together:
  +35 / −12 discordant pairs over the two runs. The preset's high aggression clears the risky-attack
  gate, so creatures with attack triggers (Krenko, Purphoros, Ohran) attack where the old bot held
  them back, and the commander comes down early.
- **The control preset no longer loses** once its knob defaults are gone (+1/−5 → +4/−4).
- **The value preset still loses** (+2 / −9 over both runs).
- **Midrange under the proxy strategist loses** (+4 / −15 over both runs), unchanged by the smaller
  target-order bonus. This is the proxy, a stand-in rule set, not the model strategist.
- **The production bot (`fixed`) is neutral to slightly positive** in the field, as in ADR 0050's
  league gate. Its clearest wins are control decks keeping removal for a real threat.

The totals are small samples: a style row is 5 to 15 discordant pairs. Only the aggro and
proxy-midrange patterns repeat strongly enough to act on.

## Review of the games that changed

Four reviewers (`reviewer`, Sonnet) read the 97 excerpts of the first run where switching the seat
changed the winner, cut at the first decision where the two bots chose differently
(`divergence.py` in the run's scratch folder). Their findings, with what was done:

| Finding                                                                                                                                                                         | Evidence                       | Done                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| The control preset's `holdUpMana: 2` took a flat −10 off every sorcery-speed cast, the commander included: Grand Arbiter was cast on turn 23 by the old bot, turn 27 by the new | pod 21 (styled, proxy), pod 41 | Control preset has no knob defaults; hold-up never blocks casting the commander, nor casting from a hand of 7 or more                |
| At aggression 0.85 a lone 1/2 commander attacked into a 5/5 and a 5/7                                                                                                           | pod 47                         | A risky attack now needs an attack trigger, a second creature, more than 1 power, and not the commander                              |
| The proxy strategist's target order (+9/+6/+3) swamped the bot's own pressure score (1 to 5), attacking the biggest board instead of the low-life seat                          | pods 5, 19, 45, 75, 79         | Bonus 3 → 1 per place; the proxy ranks low life from 40 life, not 20                                                                 |
| The proxy always set aggression, overriding the style                                                                                                                           | pods 17, 41, 44, 47            | The proxy sets aggression only when behind on life or ahead on board                                                                 |
| The aggro preset's ramp discount delayed mana the hand needed                                                                                                                   | pods 47, 52                    | Aggro and tempo no longer scale ramp down                                                                                            |
| The value preset's lower answer thresholds spent removal early                                                                                                                  | pods 0, 7, 28, 46              | Value thresholds back to 1                                                                                                           |
| Wheel of Fortune cast ahead of deploying, discarding the hand                                                                                                                   | pods 5, 58                     | Combo draw scale 1.5 → 1.25                                                                                                          |
| The bot sacrificed its own commander (Kiki-Jiki) to Ashnod's Altar to pay for a spell: `permanentValue` ignores commander status                                                | pod 17                         | Fixed by `costChoices` and `commanderValue` ([follow-up](bot-commander-value-2026-11-20.md)): the Altar's sacrifice was never scored |
| `scarceAnswer` held cheap removal from early commanders and engines                                                                                                             | pods 38, 61, 76 (midrange)     | Not changed: the same hold is why `fixed` wins for control (pods 5, 12, 45). Needs a commander-aware threat value first              |
| Cheap ramp (Sol Ring) discarded over lands; ramp decks cast one spell a turn on 7 lands                                                                                         | pods 38, 74                    | Not changed: hand-card value and mana use, a core change for its own test                                                            |

## Can combo decks work with the bot?

Not as combo decks, today:

- Of 40 pieces of well-known Commander combos checked against the modeled pool, 22 are modeled,
  and the missing ones include the key win lines (the adapted Niv-Mizzet and Kiki-Jiki lists hold
  no complete combo after substitution).
- The engine has no loop shortcut, so an infinite combo would have to be played out step by step
  under the decision budget.
- The bot has no idea which cards form a combo. It values each card on its own, damps repeated
  activations, and never tutors for, protects or assembles a piece.

In the gauntlet, Kiki-Jiki wins 29% of its pods and Niv-Mizzet 6%, both by ordinary value play; the
combo preset (tutors ×2, counters kept for bigger threats) is mildly positive (+4/−1). To play
combo, the bot would need a per-deck list of combo pieces (from the deck builder's archetype data
or a manifest), a bonus for keeping and finding missing pieces, a bonus for completing a set, and
a rule that releases held protection when a piece is on the stack; the engine would need a bounded
loop or a damage finish for any infinite line.

## Engine: Treasures and the mana payment search

The gauntlet ran three times slower than the mirrors, and 10 to 17% of its games halted with
"mana activation state budget exceeded". A CPU profile put about 90% of a slow game in
`searchPayment` under `priorityOptions`: every spell on the menu that could not be paid went
through the full copying search, about 0.1 s each. The cause was a Treasure. Any self-sacrificing
mana source switched off the planner's capacity bound, which proves an unpayable cost impossible
without searching.

The fix (`mana/payment-stability.ts`, `departuresCannotAddCapacity`) lets a self-sacrificing source
join the bound when no static in play reads what its departure changes: a count, a zone or a
graveyard, or, when some source is gated, power and toughness. Measured:

- 16 gauntlet tables: 109 s → 76 s wall; 14 games identical, the other 2 had halted on the
  budget and now finish;
- `hill-climb --only engine,setup`: all 6 fingerprints identical, timings unchanged (no benchmark
  game has a Treasure beside an unpayable spell);
- halts in the gauntlet: 81 of 1,040 games → 62.

## Still open

- **Value preset:** loses in both runs. Map value decks to midrange, or retune the role scales
  against the gauntlet, before the strategist can choose it.
- **Proxy-steered midrange:** loses in both runs. The proxy's 0.8 aggression and
  `avoidOverextending` are the next suspects.
- **Commander value:** done in the [follow-up](bot-commander-value-2026-11-20.md); bench positions
  now seat commanders.
- **The archetype classifier** calls almost every deck midrange.
- **Engine halts:** 62 of 1,040 games still halt on payment budgets with other sources (Exotic
  Orchard-style dynamic production, filter lands with riders).
