# Server-computed presentation

Decision record: [ADR 0032](../decisions/0032-server-computed-presentation.md). Status: proposed.

This track runs between multiplayer milestones M2 and M3
([multiplayer plan](multiplayer-tables.md)):

- **P1** can start alongside M2.
- **P2** waits for M2's allowlist redaction.
- **P6** lands before M3.
- **P7** lands before M6.

## Goal

The browser lays out the board, animates it, and collects input. Every value it shows that comes
from rules or engine data is computed on the server and arrives typed. AI prompts, bot behavior
and fixed-seed engine event streams do not change.

## Audit of today's client calculations

| #   | Today                                                                                                                                                                 | Problem                                                                     | Replacement                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `PlayerGameView.vue:129` `isPiledLand`; `SeatPanel.vue:62-63`; `lib/card.ts:2` `isTokenTypeLine`; `lib/tokenArt.ts:40` `cardTypes`                                    | Printed type line matched as text; views disagree; wrong for animated lands | Projection `types`, `supertypes`, `subtypes`, `isToken`; shared `boardGroupOf(types)` |
| 2   | `PlayerGameView.vue:1064` `actionCost`, `:1105` `pendingSummary`, `:1880` (`sourceName`); `lib/actionLabels.ts` (variant labels, enters-tapped notes, optional costs) | Reads untyped `data`                                                        | `ActionPresentation.label`, `summary`, `costLabels`, `entryNote`                      |
| 3   | `PlayerGameView.vue:491` X-value grouping by `data.x` and `data.modeLabel`                                                                                            | Same                                                                        | `ActionPresentation.xFamily`                                                          |
| 4   | `PlayerGameView.vue:1178-1198` payment sources                                                                                                                        | Same                                                                        | `ActionPresentation.payment`                                                          |
| 5   | `components/ManaTaps.vue:12` `data.symbols`; `lib/actionLabels.ts:80` `data.targetReductionSlot`                                                                      | Same                                                                        | `ActionPresentation.manaSymbols`, `targetHint`                                        |
| 6   | `lib/turnLabels.ts:38` `playerFacingPrompt`, used at `DecisionPanel.vue:80` and `PlayerGameView.vue:2050`                                                             | Regex over engine prompt text                                               | `DecisionPresentation.playerPrompt`                                                   |
| 7   | `PlayerGameView.vue:182` game-over line found by matching log text                                                                                                    | Text matching                                                               | `GameOverPayload.summary`                                                             |
| 8   | `CommanderDamageGrid.vue:17` `LETHAL = 21`                                                                                                                            | Rules constant in the client                                                | `lethal` and `remaining` on commander-damage entries                                  |
| 9   | `useCombatStrikes.ts`, `useLifeFlash.ts`, `useBoardFlash.ts`                                                                                                          | Diff snapshots to guess hits                                                | Server-built per-seat `damage` and `lifeChange` cues (ADR 0032 decision 8)            |

The browser reads 17 `data` keys today:

- `x`, `sourceName`, `modeLabel`, `targetReductionSlot`, `symbols`;
- `paymentSourceNames`, `paymentSourceIds`, `manaCost`, `energyCost`;
- `payLifeToUntap`, `entersTappedConditional`, `entersTapped`;
- `optionalMechanic`, `optionalCostCount`, `castVariant`;
- `abilityDescription`, `abilityCosts`.

The engine emits more, among them `abilityEffectOps`, `subjects`, `chooseAttackers`,
`blockingPlayer`, `instantSpeed`, `sourceZone` and `publicDescription`. P1's registry records
which consumer handles each key.

Stays in the client:

- **Selection and interaction state:**
  - hover and drag;
  - the next unfilled target slot in `isLegalTarget`;
  - the combat plan being composed;
  - `playableSources`, which reads the typed `interaction`;
  - the unplayed-land reminder.
- **Layout and display:**
  - stacking identical permanents;
  - widths;
  - grouping already-projected log lines;
  - phase and step names in `turnPositionLabel`;
  - low-life styling;
  - routine-action confirmation;
  - reduced motion.

## Steps (each is one PR)

### P1 — `data` key registry

- `packages/shared/src/action-data-keys.ts` lists every key the engine emits. For each key it
  records a one-line meaning, the set of value types seen (`number`, `string`, `boolean`,
  `object`, `array`), and its consumers (`ai`, `bot`, `match`, `presentation`, `engine`,
  `none`).
- `packages/server/src/cards/action-data-keys.test.ts` runs every scenario registered through
  `createCardTestScenario`, plus a fixed-seed four-bot game. It collects the keys and value
  types of every surfaced `LegalAction.data`. It fails on any of these:
  - an unregistered key;
  - a value type outside the registered set;
  - a key that presentation handles but nothing emits.
- No runtime change.

### P2 — Projection types (after M2 task 4)

- `view/spectator.ts`:
  - `permanentView` adds `types`, `supertypes` and `subtypes` from `chars`;
  - `cardView` adds `isToken` and printed types;
  - `shared/src/spectator.ts` adds them as optional.
- M2's allowlist redaction handles the new fields:
  - face-down permanents get `types: ['Creature']` and empty subtypes;
  - redacted exile cards get no types;
  - the allowlist coverage test includes the new keys.
- `shared` gains `boardGroupOf(types)`. The client switches item 1 to it, and `lib/card.ts` and
  `cardTypes` are deleted.
- Intentional fixes, each with a test:
  - an attacking animated manland groups with creatures;
  - Dryad Arbor groups with creatures in both views.

### P3 — Move the label code to the server, with its tests

- **Move the existing module.** `lib/actionLabels.ts` and its existing test
  (`lib/actionLabels.test.ts`) move unchanged to `packages/server/src/match/presentation/`.
  Behavior is the same by construction.
- **Extract and test the view helpers first.** The helpers inside `PlayerGameView.vue`
  (`actionCost`, `pendingSummary`, payment summary, and the X grouping) are extracted as pure
  functions with unit tests while still in the web app. The X grouping is a `computed` over
  selection refs, so it becomes a pure grouping function plus the existing selection state. That
  PR is checked by `player-game.spec.ts` and the Card Test Lab e2e specs, and shipped behavior
  must not change. The next PR moves the functions and their tests to the server unchanged.
- **Mark the moved code.** The web keeps calling its copies until P5. A test asserts the two
  copies are byte-identical while both exist.

### P4 — Server enrichment

- `match/presentation.ts` `enrichPresentation(request, board)`:
  - **Priority decisions:** set `layout: 'priority'` and create one `ActionPresentation` per
    action. The verb is `Cast`, `Play`, `Activate` or `Pass`; subjects are empty; and the new
    fields come from P3's functions.
  - **Choice decisions:** add the new fields to the engine's entries.
  - **Every decision:** set `playerPrompt`.
  - **Commander-damage and game-over fields:** `lethal`, `remaining` and `summary`.
- `MatchSession.sendPlayerActionRequired` calls it after smart-yield filtering. This lands after
  M1, which rewrites the same function.
- **Property tests over the P1 sweep:**
  - every cast, activation and land play has a non-empty `label`;
  - every key that the registry marks `presentation` is used;
  - a yielded action has no entry;
  - every object id in an entry is present in the seat's projection.

### P5 — Client switch

- `PlayerGameView.vue`, `DecisionPanel.vue`, `ManaTaps.vue`, `CommanderDamageGrid.vue`,
  `HandStrip.vue`, `ZoneStrip.vue` and `PermanentChip.vue` read the new fields.
- Delete the web copies from P3, `playerFacingPrompt`, and the log-text game-over search.

### P6 — Raw-data capability and lint (before M3)

- **Capabilities on connect.** The first player message and every resume message carry
  `capabilities: { rawActionData?: boolean }`. On the tester that is the existing `startGame`
  or `resumeGame` payload; on the table server it is `joinTable` or `resumeSeat`.
- **The agent client asks for raw data** (`agent-client-core.ts`). Without the capability, the
  session strips `data` from player-bound legal actions. Tests cover both settings.
- **Two syntactic rules** for `apps/web/src` in `eslint.config.js`:
  - no string or regex calls on a `typeLine` member;
  - no regex `.test` on `prompt` or `text` members.

### P7 — Damage and life cues (before M6)

- `match/presentation.ts` `buildCues(events, boardBefore, boardAfter, seat)` returns `damage`
  cues and `lifeChange` cues.
  - **`damage`:** carries the source and target object or player ids, the amount and the combat
    flag. Permanent targets use `targetCardId`; player targets use the target player id. Both
    damage payload shapes in `effects/resolve.ts` are handled.
  - **`lifeChange`:** comes from `lifeGain` and `lifeLoss`.
- Ids are looked up on the before and after boards. A cue whose objects are in neither board is
  dropped.
- Cues ride on the seat's `eventBatch`. `useCombatStrikes.ts`, `useLifeFlash.ts` and
  `useBoardFlash.ts` read them and stop diffing snapshots.
- The Phase 8 plan gains a note that its `ActionCue` contract extends this one.

## Tests that span steps

- **AI unchanged:** an `ai/context.test.ts` fixture prompt is byte-identical after P2 and P4.
- **Bots unchanged:** combat-sweep fixed-seed results are unchanged.
- **Events unchanged:** a fixed-seed four-bot game has the same `game_events` hash.
  `SpectatorState` JSON gains fields in P2, so tests that compare whole snapshots are updated
  there, and the PR explains the change.
- **Privacy:** an opponent's face-down permanent has `types: ['Creature']`, no subtypes and no
  name. Redacted exile has no types. No presentation entry or cue names an object outside the
  seat's projection.
- **End to end:** `test:e2e` after P2, P3, P5 and P7.

## Exit criteria

- The client derivations listed in the audit are gone, apart from what "stays in the client"
  names.
- The registry and property tests pass.
- AI prompts, bot results and engine event streams are unchanged.
- CI is green.

## Delegation

- **Sonnet `implementer`:**
  - P1's collection;
  - P3's extraction and move (the e2e specs are the check);
  - P5's switch, one audit row per task.
- **Main thread:**
  - P2 (engine projection);
  - P4's priority layout;
  - P7's id mapping;
  - the lint rules.

## Risks

| Risk                                          | Mitigation                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| What players see changes by accident          | Code moved unchanged with its tests; intentional fixes isolated in P2    |
| AI prompts or bot behavior change             | `data` and `view.ts` untouched; byte-identical prompt test; combat sweep |
| A renamed `data` key blanks a label           | Registry test; property test that every action has a label               |
| New projection fields leak on face-down exile | P2 waits for M2's allowlist; privacy tests                               |
| Cues drop events about creatures that died    | Before and after boards; a test with a creature killed by combat damage  |
