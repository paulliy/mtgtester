# Server-computed presentation

Decision record: [ADR 0032](../decisions/0032-server-computed-presentation.md). Status: proposed.
It does not depend on the multiplayer work and can start now. The table build's views
([multiplayer plan](multiplayer-tables.md) M6) consume what it produces.

## Goal

The browser lays out the board, animates it, and collects input. Every value it shows that comes
from rules or engine data is computed on the server and arrives typed. AI prompts, bot behavior
and fixed-seed engine event streams do not change.

## Audit of today's client calculations

| #   | Today                                                                                                                                                                 | Problem                                                                     | Replacement                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `PlayerGameView.vue:129` `isPiledLand`; `SeatPanel.vue:62-63`; `lib/card.ts:2` `isTokenTypeLine`; `lib/tokenArt.ts:40` `cardTypes`                                    | Printed type line matched as text; views disagree; wrong for animated lands | Projection `types`, `supertypes`, `subtypes`, `isToken`; server `boardGroup`                           |
| 2   | `PlayerGameView.vue:1064` `actionCost`, `:1105` `pendingSummary`, `:1880` (`sourceName`); `lib/actionLabels.ts` (variant labels, enters-tapped notes, optional costs) | Reads untyped `data`                                                        | `ActionPresentation.label`, `summary`, `costLabels`, `entryNote`                                       |
| 3   | `PlayerGameView.vue:491` X-value grouping by `data.x` and `data.modeLabel`                                                                                            | Same                                                                        | `ActionPresentation.xFamily`; `DecisionPresentation.xFamilies`                                         |
| 4   | `PlayerGameView.vue:1178-1198` payment sources                                                                                                                        | Same                                                                        | `ActionPresentation.payment`                                                                           |
| 5   | `components/ManaTaps.vue:12` `data.symbols`; `lib/actionLabels.ts:80` `data.targetReductionSlot`                                                                      | Same                                                                        | `ActionPresentation.manaSymbols`, `targetHint`                                                         |
| 6   | `lib/turnLabels.ts:38` `playerFacingPrompt`, used at `DecisionPanel.vue:80` and `PlayerGameView.vue:2050`                                                             | Regex over engine prompt text                                               | `DecisionPresentation.playerPrompt`                                                                    |
| 7   | `PlayerGameView.vue:182` game-over line found by matching log text                                                                                                    | Text matching                                                               | `GameOverPayload.summary`                                                                              |
| 8   | `CommanderDamageGrid.vue:17` `LETHAL = 21`                                                                                                                            | Rules constant in the client                                                | `lethal` and `remaining` on commander-damage entries                                                   |
| 9   | `useCombatStrikes.ts`, `useLifeFlash.ts`, `useBoardFlash.ts`                                                                                                          | Diff snapshots to guess hits                                                | Phase 8's server-built cue contract (ADR 0032 decision 8), built per seat with before and after boards |

The browser reads 17 `data` keys today: `x`, `sourceName`, `modeLabel`,
`targetReductionSlot`, `paymentSourceNames`, `paymentSourceIds`, `payLifeToUntap`,
`optionalMechanic`, `optionalCostCount`, `manaCost`, `entersTappedConditional`,
`entersTapped`, `energyCost`, `castVariant`, `abilityDescription`, `abilityCosts` and
`symbols`. The engine emits more (`abilityEffectOps`, `subjects`, `chooseAttackers`,
`blockingPlayer`, `instantSpeed`, `sourceZone`, `publicDescription`, and others). The key
registry in P1 records which consumer handles each.

Stays in the client:

- selection and interaction state: hover, drag, the next unfilled target slot in
  `isLegalTarget`, the combat plan being composed, and `playableSources` (which reads the typed
  `interaction`, not `data`);
- the unplayed-land reminder, which only confirms unsent input;
- visual stacking of identical permanents;
- layout widths;
- grouping already-projected log lines by seat;
- the phase and step name lookup in `turnPositionLabel`;
- low-life styling, routine-action confirmation and reduced motion.

## Steps (each is one PR)

### P1 — Key registry and runtime check

- `packages/shared/src/action-data-keys.ts`: every `data` key the engine emits, with a one-line
  meaning and its consumers (`ai`, `bot`, `match`, `presentation`, `engine`, or `none`).
- `packages/server/src/cards/action-data-keys.test.ts` runs the Card Test Lab scenarios
  (`packages/server/src/cards/card-test-scenarios*.ts`, run directly in tests, not through the
  DEV-only UI) and a fixed-seed four-bot game, collecting every key of every surfaced
  `LegalAction.data`. It fails on any of these:
  - an emitted key that is not registered;
  - a registered presentation key that nothing emits;
  - a key whose value type changed (a `typeof` sample per key).
- No runtime change.

### P2 — Projection types

- `view/spectator.ts` `permanentView` adds `types`, `supertypes` and `subtypes` from `chars`.
  `cardView` adds `isToken` and printed types. `shared/src/spectator.ts` adds them as optional.
- `match/presentation.ts` (new) gains `boardGroup(permanent)` and `normalizeLegacySnapshot`.
  The latter runs inside `GameRecorder.loadTurnSnapshot`, fills missing types from the printed
  line without the `Token` word, and sets `typesFrom: 'printed'`. The replay view shows a short
  note for those games.
- The client switches item 1 to `types` and `boardGroup`, and `lib/card.ts` and `cardTypes`
  are deleted.
- This PR lands the intentional fixes, each with its own test:
  - an attacking animated manland groups with creatures;
  - Dryad Arbor groups with creatures in both views.

### P3 — Prepare golden capture

- Extract the derivation code in `PlayerGameView.vue` into `apps/web/src/lib/legacy-presentation.ts`
  as pure functions over `(request, board, prefs)`: `actionCost`, `pendingSummary`, the X
  grouping, payment summary, and `actionLabel`.
- The X grouping is currently a `computed` over selection refs, so this is a refactor, not a
  copy. It lands alone, behind the existing `player-game.spec.ts` and Card Test Lab e2e specs.
  Shipped behavior must not change.

### P4 — Server labels with golden parity

- `scripts/capture-presentation-fixtures.ts` writes
  `packages/server/src/match/__fixtures__/presentation-inputs.json`. It records each
  `(filtered request, board)` pair from two sources:
  - Card Test Lab scenarios covering painlands, X spells, kicker and replicate, MDFC, energy,
    bestow, overload, a face-down permanent, a Room unlock, a Killian target-reduction cast and a
    partner commander;
  - one fixed-seed single-player game.
- A web test runs `legacy-presentation.ts` over the fixtures and writes the golden file.
- `match/presentation.test.ts` asserts the server's `enrichDecisionPresentation` equals the
  golden.
- **What parity proves.** The golden proves the server equals the extracted client functions on
  these fixtures. It does not prove the server is correct for every card, and it pins any
  existing label bug. So live property tests are added: across the Card Test Lab sweep, every
  offered cast, activation and land play gets a non-empty `label`, and every presentation key in
  the P1 registry is handled.
- `MatchSession.sendPlayerActionRequired` enriches the presentation after smart-yield filtering.
  A test asserts that a yielded action carries no presentation.

### P5 — Client switch for items 2–8

- Point `PlayerGameView.vue`, `DecisionPanel.vue`, `ManaTaps.vue` and
  `CommanderDamageGrid.vue` at the new fields. Add `GameOverPayload.summary` and the
  commander-damage fields. Delete `legacy-presentation.ts`, `lib/actionLabels.ts` and
  `playerFacingPrompt`.
- The golden file stays as the server's regression test.

### P6 — Raw-data capability and lint

- The first player message carries `capabilities: { rawActionData?: boolean }`.
  `agent-client-core.ts` sets it. The session strips `data` from player-bound legal actions
  unless it is set. Tests cover both settings.
- Add `no-restricted-syntax` and `vue/no-restricted-syntax` selectors for `apps/web/src` in
  `eslint.config.js`. They reject member access named `data` on a `LegalAction`-typed value
  (matched by `actionData` and `.data?.[`), string or regex calls on a `typeLine` member, regex
  calls on `prompt` and `text` members, and the numeric literal `21` in components.
- Exceptions use `eslint-disable-next-line` with a reason, which review checks.

### P7 — Animation cues

Done with the Phase 8 animation plan, not here: its `ActionCue` contract becomes server-built
and per-seat, as ADR 0032 decision 8 requires. Then `useCombatStrikes.ts`, `useLifeFlash.ts`
and `useBoardFlash.ts` stop diffing snapshots.

## Tests that span steps

- **AI unchanged:** an `ai/context.test.ts` fixture prompt is byte-identical before and after
  P2 and P4.
- **Bots unchanged:** the combat sweep's fixed-seed results are unchanged.
- **Engine event streams unchanged:** a fixed-seed four-bot game produces the same `game_events`
  hash. `SpectatorState` gains fields, so any test that compares whole snapshots is updated in P2,
  and the update is explained in the PR.
- **Privacy:** an opponent's face-down permanent projects `types: ['Creature']`, no subtypes, no
  name. Enriched presentation contains only object ids present in the seat's projection.
- **End to end:** `test:e2e` (`player-game.spec.ts`, the Card Test Lab spec, the spectator
  smoke spec) after P2, P3 and P5.

## Exit criteria

- The lint selectors pass with no unexplained disables.
- Golden parity holds, apart from the two documented intentional fixes.
- The key registry test passes.
- AI prompt bytes, bot results and engine event streams are unchanged.
- CI is green.

## Delegation

- **Sonnet `implementer`:**
  - P1's key collection;
  - P3's extraction (with the e2e specs as the check);
  - P4's fixture capture;
  - P5's client switch, one audit row per task.
- **Main thread:** the projection fields (P2, in `packages/engine`) and the lint selectors.

## Risks

| Risk                                         | Mitigation                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Changing what players see by accident        | Golden parity; intentional fixes in P2 with their own tests                     |
| AI prompts or bot behavior change            | `data` untouched; `view.ts` untouched; byte-identical prompt test; combat sweep |
| Old replays break                            | Optional fields; labeled legacy derivation on load                              |
| A renamed `data` key silently blanks a label | Key registry test; property test that every action has a label                  |
| Client derivation creeps back                | Lint selectors                                                                  |
