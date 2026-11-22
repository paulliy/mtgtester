# Strategist cases

Positions where only a good plan meets the objectives. Each spans two or three of the seat's own
turns, with every turn in between played whole (`continue.throughTurns`, so opponents' turns have
their combat). Every lineup entry plays them; put strategists in front of the tacticians
(`--strategists`, or a `strategists` × `tacticians` lineup) and compare each pair with its
`none` row to see what the plan added.

```powershell
bun run bot-bench list                                  # strategist cases show as "strategist 2t"
bun run bot-bench verify --role strategist
bun run bot-bench run --role strategist --models bot-led:never,decision:typesafe/jev-1.14 --strategists none,case,openrouter:z-ai/glm-5.3-flash@low
```

`--role` picks the set: `tactician` (the default, so earlier runs keep their fingerprint),
`strategist`, or `all`.

| Case                             | Turns | What only a plan gets right                                                                      |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `counter-the-wrath-not-the-bait` | 2     | Hold Counterspell through P2's Dreadmaw for P3's shown Wrath; cast Serra Angel only after it     |
| `focus-the-reachable-opponent`   | 2     | Two flyers over two attacks kill exactly one opponent, P2 and its Dragon; splitting kills nobody |
| `keep-the-deal`                  | 2     | P3 at 6 is protected by P1's no-attack promise; eliminate P2 over two turns instead              |
| `keep-blockers-for-the-swing`    | 2     | At 2 life, keep Leatherback Baloth home for P3's Dreadmaw; the vigilant Angel can still attack   |
| `save-swords-for-the-threat`     | 2     | Not the only Swords on a mana elf because the mana is there: P4's Gigantosaurus is coming        |
| `bait-the-fog-before-overrun`    | 3     | P2 Fogs the first attack: attack plain first, Overrun later; 0 + 18 + 9 is exactly 27            |

## How they are built

- **A quiet table with scripted plays.** Opponents pass and never attack or block
  (`table.policy: passive`) except where `table.script` makes them: P2 casts the bait, P3 casts
  the Wrath, P3 attacks, P2 casts Fog during blockers. A script step waits until its action is on
  the menu, so the same reply happens whatever the seat did before it.
- **Reviewed lines across the turns.** A line's steps are taken in order by the seat's decisions;
  a step that names a target not yet there (a Counterspell for a Wrath not yet cast) waits for it
  instead of failing. `verify` replays every line through the engine and checks the best one meets
  every objective and the grades agree with the scores.
- **A reviewed `context`.** The strategy a perfect strategist would hand over: the `case` row of a
  grid. It reaches a chat or decision-model tactician as its strategy and a bot-led tactician as
  knobs, and stays out of the `none` row.
- **Public signals, not hidden knowledge.** The plan has to be readable from the seat's own view:
  a Wrath or Fog already in an opponent's graveyard, open mana, life totals, a deal in force.

## First results (bot baselines, free)

| Case                           | `local:heuristic` | `bot-led:never` + `case` knobs |
| ------------------------------ | ----------------- | ------------------------------ |
| bait-the-fog-before-overrun    | 0%                | 100%                           |
| counter-the-wrath-not-the-bait | 0%                | 0%                             |
| focus-the-reachable-opponent   | 0%                | 25%                            |
| keep-blockers-for-the-swing    | 75%               | 100%                           |
| keep-the-deal                  | 0%                | 0%                             |
| save-swords-for-the-threat     | 100%              | 100%                           |

The knobs fix two positions and leave two where no knob says the right thing, which is the
"knob missing" evidence ADR 0045 asked for:

- **`counter-the-wrath-not-the-bait`**: no knob says "counter the sweeper, not the creature", so
  the bot counters the Dreadmaw. And `hold` lasts until the knobs change: it cannot say "hold the
  Angel until after the Wrath", so the Angel is never cast.
- **`keep-the-deal`**: the bench gives the bot no deal-play hooks, and `targetOrder` does not
  override an attack that kills a player: the bot attacks P3.

## Adding a case

As for a tactician turn case (`bot-bench/README.md`, "Adding a case"), plus: `role: "strategist"`,
`scope: "turn"`, `continue.throughTurns` (4 reaches the seat's next turn at a four-seat table, 8
the one after), `turns` equal to `1 + floor(throughTurns / 4)`, a `maxActorDecisions` that covers
the window (80 for two turns, 120 for three), and a `context`. Run `bun run bot-bench inspect <id>`
and read every line's play before trusting `verify`.
