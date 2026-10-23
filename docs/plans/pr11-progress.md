# PR11 progress: protection, phasing and game lifecycle

PR11 in [card-coverage-chunks.md](card-coverage-chunks.md) holds 30 cards. It is split in two:
this increment models the 18 protection, phasing and lifecycle cards, and the 12 layout cards
(Sagas, Class levels, prepare, split and fuse, Rooms, modal double-faced and transform) move to a
separate PR11b. It stacks on PR10.

## Cards

| #     | Card                   | Group      |
| ----- | ---------------------- | ---------- |
| 11.01 | Arcane Lighthouse      | protection |
| 11.03 | Smokestack             | lifecycle  |
| 11.05 | Angel's Grace          | phasing    |
| 11.08 | Gut, True Soul Zealot  | lifecycle  |
| 11.09 | Out of the Tombs       | lifecycle  |
| 11.12 | Caged Sun              | lifecycle  |
| 11.15 | Mystic Remora          | lifecycle  |
| 11.16 | Chrome Mox             | lifecycle  |
| 11.17 | Gemstone Caverns       | lifecycle  |
| 11.18 | Teferi's Protection    | phasing    |
| 11.19 | Mana Vault             | lifecycle  |
| 11.20 | The One Ring           | phasing    |
| 11.22 | Clever Concealment     | phasing    |
| 11.24 | Shanna, Sisay's Legacy | protection |
| 11.25 | Basri's Lieutenant     | protection |
| 11.28 | Negative Zone Portal   | lifecycle  |
| 11.29 | Spirit Mantle          | protection |
| 11.30 | Unquestioned Authority | protection |

All 18 interpret with no unmodeled reasons. The overrides live in
`packages/engine/src/cards/overrides/coverage-pr11.ts`; cards that were contained by the catalog
audits (Angel's Grace, Smokestack, Out of the Tombs, Caged Sun, Gut) are restored with
`replaceCard`, as PR09 did.

## Engine primitives

- Protection keyed on a source's colors and card types (protection from multicolored, from
  creatures), and targeting contexts that know whether a spell or an ability targets (Shanna).
- Player protection from everything until your next turn and a locked life total (Teferi's
  Protection, The One Ring); "can't lose this turn" with a damage life floor (Angel's Grace).
- Split second: while such a spell is on the stack, priority offers no spells or non-mana
  abilities. Mana abilities stay available.
- Phasing out chosen permanents with their attachments (Clever Concealment), and phasing in before
  the untap step.
- Hexproof and shroud removal that also denies later grants (Arcane Lighthouse).
- "Doesn't untap during your untap step", cumulative upkeep, the Smokestack soot count, and the
  empty-library draw replacement that returns a creature (Out of the Tombs) and no longer offers a
  decline.
- Chosen-color land mana riders (Caged Sun), imprint colors from linked exile (Chrome Mox), linked
  graveyard exile with a creature draw and a coin flip (Negative Zone Portal), and opening-hand
  placement for a non-starting player (Gemstone Caverns).

## Evidence

- Engine behavior tests: `packages/engine/tests/pr11-protection.test.ts`,
  `pr11-phasing.test.ts` and `pr11-lifecycle.test.ts`, with shared helpers in `pr11-helpers.ts`.
  Each test id names its card and clause (for example `vault-c02-c03`).
- 41 Card Test Lab scenarios in
  [pr11-scenarios.ts](../../packages/server/src/cards/pr11-scenarios.ts).
  [pr11-scenarios.test.ts](../../packages/server/src/cards/pr11-scenarios.test.ts) plays each
  one headlessly through the production decision path and checks the outcome (life totals, zones,
  counters, phasing, characteristics and which targets each player was offered). A scripted P2
  acts only with an empty stack. P1 always holds a free Lab Trinket so the viewer keeps priority.
- [pr11-card-test-lab.spec.ts](../../apps/web/e2e/pr11-card-test-lab.spec.ts) runs all 41 in a
  real browser against the lab server, records traces, and enforces the exact scenario-ID set. All
  41 passed locally. The generic Card Test Lab walkthrough skips these ids.
- `card-verification-manifest.json` has `implemented-reviewed` entries for the 18 cards, with
  clause-level engine test ids and viewer scenario ids. The coverage ledger rows are
  `implemented-reviewed` under `PR11.NN`.

Five clauses have engine tests but no viewer scenario, because a prepared Lab position cannot set
them up: Arcane Lighthouse's `{T}: Add {C}`, Gut's Choose a Background (deck construction),
Gemstone Caverns' opening-hand clause, The One Ring's indestructible, and Negative Zone Portal's
coin flip, which needs four cards already linked to it.

## Not done in this increment

- No bounded primitive contract extensions and no `run-pr11-verification.ts` receipt generator,
  the same gap PR10 records.
- No live-provider gameplay-AI assessment.
- The 12 layout cards (PR11b).
