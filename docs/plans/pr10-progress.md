# PR10: stack manipulation, copying, characteristics

Branch: `pr10-evidence-stack`, started from `aab7307` (the PR10 retarget and cast-copy engine
primitives). PR10 as a whole covers 31 cards pinned in
[coverage-pr10-oracle.json](../../packages/engine/tests/fixtures/coverage-pr10-oracle.json). This
increment takes the seven stack retarget and spell-copy cards from engine-only to the same
`implemented-reviewed` evidence layer PR09 used, and records Bilbo's Gambit, which the
white-black control work modeled earlier. The other 23 pinned cards are not part of this increment.

## Current implementation

The overrides in
[coverage-pr10.ts](../../packages/engine/src/cards/overrides/coverage-pr10.ts) are now registered
in production (`index.ts` registers `coverage-pr10` beside `coverage-pr09`). Before this, only the
PR10 engine suites installed them through `tests/pr10-helpers.ts`; registering twice is harmless,
so that call stays. No rules logic changed.

| Card                 | PR10 id | Clauses | Engine cases (file)                 | Card Test Lab scenarios |
| -------------------- | ------- | ------- | ----------------------------------- | ----------------------- |
| Deflecting Swat      | 10.01   | 2       | `pr10-retarget.test.ts`             | 4                       |
| Reverberate          | 10.06   | 1       | `pr10-spell-copy.test.ts`           | 2                       |
| Bolt Bend            | 10.11   | 2       | `pr10-retarget.test.ts`             | 4                       |
| Display of Power     | 10.12   | 2       | `pr10-spell-copy.test.ts`           | 3                       |
| Flare of Duplication | 10.14   | 2       | `pr10-spell-copy.test.ts`           | 4                       |
| Galvanic Iteration   | 10.19   | 2       | `pr10-cast-copy.test.ts`            | 3                       |
| Cosmic Crucible      | 10.26   | 2       | `pr10-cast-copy.test.ts`            | 4                       |
| Bilbo's Gambit       | 10.25   | 2       | `white-black-control-gifts.test.ts` | not in this increment   |

What the scenarios show through the real frontend and backend:

- Choosing new targets changes the target of the same stack object; it is not a copy
  (Deflecting Swat, Bolt Bend). Bolt Bend must pick a different target and refuses a spell with two
  targets. The cost reduction is shown both with and without a creature of power 4 or greater, and
  Swat's free cast with and without a commander.
- Copies are separate spells with their own targets (Reverberate, Flare of Duplication, Display of
  Power, Galvanic Iteration, Cosmic Crucible). A creature spell cannot be copied by Reverberate or
  Flare. Flare's sacrifice alternative cost works for a nontoken red creature and is refused for a
  green creature. Display of Power copies two spells at once, and Reverberate targeting Display of
  Power creates no copy.
- Galvanic Iteration copies only the next instant or sorcery and is recastable from the graveyard
  with flashback. Cosmic Crucible adds four mana in any combination of colors at the beginning of
  the first main phase, copies only the first noncreature spell each turn, and never copies a
  creature spell.

## Validation

- The manifest maps every printed clause (13 across the seven cards) to named engine cases and to
  24 Card Test Lab scenarios, at `implemented-reviewed`. The earlier `unsupported` and contained
  entries for these cards are replaced, and the matching guard tests no longer treat them as
  contained (`marchesa-batch1-containment`, `fail-closed-restoration`,
  `marchesa-batch1-pool-containment`, `remaining-four-decks`).
- The 24 scenarios live in
  [pr10-scenarios.ts](../../packages/server/src/cards/pr10-scenarios.ts) with
  [pr10-scenarios.test.ts](../../packages/server/src/cards/pr10-scenarios.test.ts), which plays each
  one headlessly through the same decision path and checks life totals, copy counts and which
  actions were offered. The browser spec
  [pr10-card-test-lab.spec.ts](../../apps/web/e2e/pr10-card-test-lab.spec.ts) reuses the PR09 viewer
  helpers, records the trace, and enforces the exact scenario-ID set. The generic Card Test Lab
  walkthrough skips these ids, as it does for PR08 and PR09.
- A scripted P2 casts the opponent spell the viewer then answers. Negative scenarios keep a second,
  castable spell in hand so P1 still receives priority while the card under test is not offered.
- `bun run snapshots:check` is current for the production registration. The coverage ledger has
  `implemented-reviewed` rows for the seven cards and a `modeled-focused-tests-passed` row for
  Bilbo's Gambit. `docs/modelled-cards.md` lists the seven new cards (6494 total); it was edited
  by hand because `bun run modelled-cards` needs the local Scryfall bulk file.

## Not done in this increment

- No bounded primitive contract extensions exist for PR10 (the PR09 `bounded-pr09-library.ts`
  counterpart), and there is no `run-pr10-verification.ts` receipt generator. Final
  `primitive-promotions` and receipt runs for these declarations therefore remain to be added.
- No live-provider gameplay-AI assessment was performed. Lab opponents make scripted legal
  decisions; that is separate from rules and viewer correctness.
- Nothing here was pushed.
