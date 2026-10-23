# PR12 progress: reopened quality-audit cards

PR12 in [card-coverage-chunks.md](card-coverage-chunks.md) holds the seven cards the card-engine
quality merge reopened. This increment models all seven and retires their containment. It stacks
on PR11.

## Cards

| #     | Card                                  | Population | Was                                   |
| ----- | ------------------------------------- | ---------- | ------------------------------------- |
| 12.01 | Black Bolt, Inhuman King              | FF4        | event-player containment              |
| 12.02 | Dingus Staff                          | PRA        | event-player containment              |
| 12.03 | Sivitri, Dragon Master                | URD        | executable `noOp` (+1 attack tax)     |
| 12.04 | Zurgo and Ojutai                      | URD        | executable `noOp` (combat-damage dig) |
| 12.05 | Bloomvine Regent // Claim Territory   | URD        | substituted Omen face                 |
| 12.06 | Marang River Regent // Coil and Catch | URD        | substituted Omen face                 |
| 12.07 | Monster Manual // Zoological Study    | URD        | omitted Adventure face                |

All seven interpret with no unmodeled reasons under both their real and fixture oracle ids. Black
Bolt, Marang River Regent and Coil and Catch were already faithful in the interpreter; they only
needed their containment removed and evidence added. The two authored faces live in
`packages/engine/src/cards/overrides/coverage-pr12.ts`; `unsupported-spell-faces.ts` is deleted.

## Engine primitives

- An attack life tax until your next turn (Sivitri's +1): `attackLifeTaxUntilYourNextTurn` adds
  an `AttackLifeTaxEntry` covering its controller and their planeswalkers. The attack declaration
  checks the life for every attacker together with any mana tax, pays life before mana, and treats
  a player whose life total cannot change as unable to pay. Only free attacks are forced by goad
  (CR 508.1d). The entry expires at its controller's next untap step and when they leave the game.
  Attack declaration subjects carry `attackLifeTax` for deciders.
- Dies triggers scoped to the dying creature's controller (`subjectControllerIsEventPlayer`), so
  "that creature's controller" binds from last known information. The interpreter sets it, so
  Dingus Staff needs no override.
- Zurgo's mandatory look-three (`mayPut.required`, `rest: 'bottomAnyOrder'`) and
  `mayReturnEventGroupMemberToHand`, which offers only triggering Dragons still on the battlefield.
- `millThenReturnMilledCard` follows the milled cards (CR 701.13c) for Zoological Study, and
  `defineSpellFace` registers an authored spell face under `<id>:back` for both identities.
- Fix: the shared Dragon tutor grammar dropped "reveal it" and "then shuffle". Sivitri's −3 and
  Maelstrom of the Spirit Dragon now reveal and shuffle.

## Evidence

- Engine behavior tests: `packages/engine/tests/pr12-triggers.test.ts`, `pr12-sivitri.test.ts`
  and `pr12-spell-faces.test.ts` (44 tests), with helpers in `pr12-helpers.ts` and the pins in
  `tests/fixtures/coverage-pr12-oracle.json`.
- 17 Card Test Lab scenarios in
  [pr12-scenarios.ts](../../packages/server/src/cards/pr12-scenarios.ts).
  [pr12-scenarios.test.ts](../../packages/server/src/cards/pr12-scenarios.test.ts) plays each one
  headlessly through the production decision path and checks the outcome. The scripted P2 casts
  once with an empty stack and declares its planned attacks, which is how the Sivitri tax is shown
  being paid and being unaffordable.
- [pr12-card-test-lab.spec.ts](../../apps/web/e2e/pr12-card-test-lab.spec.ts) runs all 17 in a
  real browser against the lab server, records traces, and enforces the exact scenario-ID set. All
  17 passed locally. The generic Card Test Lab walkthrough skips these ids.
- `card-verification-manifest.json` has `implemented-reviewed` entries for the seven cards, with
  clause-level engine test ids and viewer scenario ids; spell-face clauses use `clause-face-N` ids.
  The coverage ledger rows are `implemented-reviewed` under `PR12.NN`.
- Measured over `packages/server/fixtures/coverage-oracle.json` with `interpretCard`: 939 → 946 of
  958 modeled, and exactly these seven cards changed.

Two clauses have engine tests but no viewer scenario: Zurgo's hexproof on the turn it entered and
Sivitri's "can be your commander".

## Residuals

- Zurgo's "or battle" branch cannot arise: the engine and the population have no battles.
- Forbidding Spirit stays contained. Its mana-tax line is now unrecognized text rather than a
  `noOp`, because the Sivitri life-tax rule no longer matches it.
- The older Ur-Dragon fixture predates `backFace`, so there the three two-faced cards stay
  unmodeled for a missing spell face. The pinned PR12 fixture models them.
- The web viewer shows neither the mana nor the life attack tax; it is enforced by the engine.
- No bounded primitive contract extensions, receipt generator, or live-provider gameplay-AI
  assessment, the same gaps PR10 and PR11 record.
