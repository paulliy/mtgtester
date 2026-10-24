# PR11b progress: layout cards

PR11b models the 12 layout cards split out of PR11 in
[card-coverage-chunks.md](card-coverage-chunks.md): Sagas, a Class, prepare, split cards with
fuse, a Room, and modal double-faced and transforming cards. It stacks on the PR12 branch, which
stacks on PR11 and PR10.

## Cards

| #     | Card                                            | Layout             |
| ----- | ----------------------------------------------- | ------------------ |
| 11.02 | Malakir Rebirth // Malakir Mire                 | modal DFC (spell)  |
| 11.04 | Valakut Awakening // Valakut Stoneforge         | modal DFC (spell)  |
| 11.06 | Defacing Duskmage // Vandal's Edit              | prepare            |
| 11.07 | Eiganjo Dynastorian // Replenish                | prepare            |
| 11.10 | Wandering Archaic // Explore the Vastlands      | modal DFC (spell)  |
| 11.11 | Wear // Tear                                    | split with fuse    |
| 11.13 | The War in Heaven                               | Saga               |
| 11.14 | Intermediate Chirography                        | Class              |
| 11.21 | Urza's Saga                                     | Saga               |
| 11.23 | Legion's Landing // Adanto, the First Fort      | transform          |
| 11.26 | Dollmaker's Shop // Porcelain Gallery           | Room               |
| 11.27 | Mila, Crafty Companion // Lukka, Wayward Bonder | modal DFC (walker) |

All 12 interpret with no unmodeled reasons. Wear // Tear is modeled by the interpreter itself;
the other 11 are authored in `packages/engine/src/cards/overrides/coverage-pr11b.ts`. Cards the
catalog audits had contained are restored with `replaceCard`, and Wear // Tear's two containment
entries are deleted and recorded in the catalog audit's `interpreterRestored` list.

## Engine primitives

- Sagas (CR 714): a lore counter as a Saga enters and in its controller's precombat main phase,
  chapter abilities that trigger on a lore counter crossing their number, and the sacrifice
  state-based action once the last chapter has left the stack.
- Class levels (CR 716) gained in order at sorcery speed, with level-gated abilities.
- Split cards (CR 709): each half is cast as its own spell with only that half's characteristics,
  and the card has both halves combined everywhere else. Fuse (CR 702.102) casts both halves
  from hand, with the left half's targets and instructions first.
- Rooms (CR 709.5): a door cast as a permanent spell enters unlocked; a Room put onto the
  battlefield any other way has both doors locked. On the battlefield a Room has only its
  unlocked doors' name, mana cost and abilities, so its colors and mana value come from those
  doors alone. Unlocking a locked door for its mana cost is a special action at sorcery timing.
  External graveyard permissions also allow either door, spending the selected spell's permanent
  type budget; fuse remains restricted to casting from hand.
- Prepare (CR 722): becoming prepared makes a castable copy of the card's spell in exile, and
  casting it unprepares the permanent. A draw trigger can name the Nth card drawn this turn.
- Modal double-faced instant and sorcery faces; transforming once (CR 701.27f); planeswalker-only
  attack triggers; attack triggers that count only attackers matching a filter ("non-Toy").
- Grants locked to one object (CR 400.7): a returned creature's dies trigger, a Saga's chapter
  abilities, and "they're artifacts in addition to their other types". Room attack triggers are
  grouped per attacked player; non-Toy attackers sent at two players create two Toy tokens.
- Split second filters spell casts and nonmana ability activations by their action payloads, so
  turning a permanent face up through morph or manifest and activating mana abilities remain legal.

## Evidence

- Engine behavior tests: `packages/engine/tests/pr11b-mdfc.test.ts`, `pr11b-transform.test.ts`,
  `pr11b-class.test.ts`, `pr11b-saga.test.ts`, `pr11b-split.test.ts`, `pr11b-archaic.test.ts`,
  `pr11b-mila.test.ts`, `pr11b-prepare.test.ts`, `pr11b-room.test.ts` and
  `pr11b-split-second.test.ts`. Each test id names
  its card and clause (for example `room-c01-negative-toy`).
- 26 Card Test Lab scenarios in
  [pr11b-scenarios.ts](../../packages/server/src/cards/pr11b-scenarios.ts).
  [pr11b-scenarios.test.ts](../../packages/server/src/cards/pr11b-scenarios.test.ts) plays each
  one headlessly through the production decision path and checks the outcome.
- [pr11b-card-test-lab.spec.ts](../../apps/web/e2e/pr11b-card-test-lab.spec.ts) runs all 26 in a
  real browser against the lab server, records traces, and enforces the exact scenario-ID set.
  The graveyard Room scenario checks Muldrotha's per-turn permanent-type budget while both doors
  are payable; simultaneous attacks against two players are also covered. All 26 passed locally.
  The generic Card
  Test Lab walkthrough skips these ids.
- `card-verification-manifest.json` has `implemented-reviewed` entries for the 12 cards, with
  clause-level engine test ids and viewer scenario ids. The coverage ledger rows for the five
  cards it tracks are `implemented-reviewed` under `PR11.NN`.

Some clauses have engine tests but no viewer scenario: Duskmage's deathtouch and Dynastorian's
vigilance (keywords), The War in Heaven's chapter II, Chirography's enter trigger, level 3 and
end-step Inkling, Explore the Vastlands, Adanto's abilities, Mila's targeted draw, and Lukka's +1
and −7.

## Not done in this increment

- No `run-pr11b-verification.ts` receipt generator, the same gap PR10 and PR11 record.
- No live-provider gameplay-AI assessment.
- The interpreter's generic "the Nth card each turn" grammar still rechecks the draw count on
  resolution; Duskmage uses the event-time `ordinalThisTurn` instead. Moving the interpreter to
  it is a follow-up.
- Rooms are authored by override. The interpreter does not yet read a Room's two doors itself,
  and there is no "when you unlock this door" trigger (CR 709.5h), which no card in scope needs.
