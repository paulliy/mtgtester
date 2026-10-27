# Server-computed presentation

Decision record: [ADR 0032](../decisions/0032-server-computed-presentation.md). Status: proposed.

This track runs between multiplayer milestones M2 and M3
([multiplayer plan](multiplayer-tables.md)):

- **P1** can start alongside M2a.
- **P2** waits for M2a's allowlist redaction.
- **P5** lands before M3.
- **P6** lands before M6.

## Goal

The browser lays out the board, animates it, and collects input. Every value it shows that comes
from rules or engine data is computed on the server and arrives typed. AI prompts, bot behavior
and fixed-seed engine event streams do not change.

## Audit of today's client calculations

| #   | Today                                                                                                                                                                 | Problem                                                                     | Replacement                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `PlayerGameView.vue:129` `isPiledLand`; `SeatPanel.vue:62-63`; `lib/card.ts:2` `isTokenTypeLine`                                                                      | Printed type line matched as text; views disagree; wrong for animated lands | Projection `types`, `supertypes`, `subtypes`, `isToken`; shared `boardGroupOf(types)` |
| 2   | `PlayerGameView.vue:1064` `actionCost`, `:1105` `pendingSummary`, `:1880` (`sourceName`); `lib/actionLabels.ts` (variant labels, enters-tapped notes, optional costs) | Reads untyped `data`                                                        | `ActionPresentation.label`, `summary`, `costLabels`, `entryNote`                      |
| 3   | `PlayerGameView.vue:491` X-value grouping by `data.x` and `data.modeLabel`                                                                                            | Same                                                                        | `ActionPresentation.xFamily`                                                          |
| 4   | `PlayerGameView.vue:1178-1198` payment sources                                                                                                                        | Same                                                                        | `ActionPresentation.payment`                                                          |
| 5   | `components/ManaTaps.vue:12` `data.symbols`; `lib/actionLabels.ts:80` `data.targetReductionSlot`                                                                      | Same                                                                        | `ActionPresentation.manaSymbols`, `targetHint`                                        |
| 6   | `lib/turnLabels.ts:39` `playerFacingPrompt`, used at `DecisionPanel.vue:80` and `PlayerGameView.vue:2050`                                                             | Regex over engine prompt text                                               | `DecisionPresentation.playerPrompt`                                                   |
| 7   | `PlayerGameView.vue:182` game-over line found by matching log text                                                                                                    | Text matching                                                               | `GameOverPayload.summary`                                                             |
| 8   | `CommanderDamageGrid.vue:17` `LETHAL = 21`                                                                                                                            | Rules constant in the client                                                | `lethal` and `remaining` on commander-damage entries                                  |
| 9   | `useCombatStrikes.ts`, `useLifeFlash.ts`                                                                                                                              | Diff snapshots to guess who hit what                                        | Server-built `damage` and `lifeChange` cues (ADR 0032 decision 8)                     |

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
  - reduced motion;
  - tap and untap flashes in `useBoardFlash.ts`, which display state changes;
  - token-art lookup (`lib/tokenArt.ts`), a cosmetic Scryfall search.

## Steps (each is one PR)

### P1 — `data` key registry

- `packages/shared/src/action-data-keys.ts` lists every key the engine emits. For each key it
  records a one-line meaning, the set of value types seen (`number`, `string`, `boolean`,
  `object`, `array`), and its consumers (`ai`, `bot`, `match`, `presentation`, `engine`,
  `none`).
- `packages/server/src/cards/action-data-keys.test.ts` collects keys and value types from two
  sources:
  - the first surfaced decision of every scenario registered through `createCardTestScenario`;
  - four fixed-seed four-bot games.

  It fails on any of these:
  - an unregistered key;
  - a value type outside the registered set;
  - a key that presentation handles but nothing emits.

  Its runtime is measured in the PR and must stay under CI's test budget.

- `docs/guides/card-coverage-workflow.md` gains one line: a change that adds a `data` key
  registers it.
- No runtime change.

### P2 — Projection types (after M2a task 4)

- `view/spectator.ts`:
  - `permanentView` adds `types`, `supertypes` and `subtypes` from `chars`;
  - `cardView` adds `isToken` and printed types;
  - `shared/src/spectator.ts` adds them as optional.
- M2a's allowlist redaction handles the new fields:
  - face-down permanents get `types: ['Creature']` and empty subtypes;
  - redacted exile cards get no types;
  - the coverage test includes the new keys.
- `shared` gains `boardGroupOf(types)`. The client switches item 1 to it, and `lib/card.ts` is
  deleted.
- Intentional fixes, each with a test:
  - an attacking animated manland groups with creatures;
  - Dryad Arbor groups with creatures in both views.

### P3 — Move the label code into `shared`, with its tests

- **Move `lib/actionLabels.ts`.** It imports only the shared `LegalAction` type. It and its test
  move unchanged to `packages/shared/src/presentation/labels.ts`. The web imports it from there
  for now.
- **Extract and move the view helpers.** The helpers inside `PlayerGameView.vue` (`actionCost`,
  `pendingSummary`, payment summary, X grouping) become pure functions with unit tests in the
  same `shared/src/presentation/` folder. The X grouping is a `computed` over selection refs, so
  it splits into a pure grouping function plus the existing selection state.
- **Checks.** This PR is checked by `player-game.spec.ts` and the Card Test Lab e2e specs, and
  shipped behavior must not change.
- **Why `shared`.** Both the web, until P4, and the server import from it. There is one copy, so
  parity holds by construction.

### P4 — Server enrichment and client switch (one PR, after M1)

- **Server.** `packages/server/src/match/presentation.ts` `enrichPresentation(request, board)`
  uses P3's functions.
  - **Priority decisions:** set `layout: 'priority'` and create an `ActionPresentation` per
    action, with the verb derived from the action type and empty subjects.
  - **Choice decisions:** add the new fields to the engine's entries.
  - **Every decision:** set `playerPrompt`.
  - **Game over and commander damage:** `GameOverPayload.summary`, and `lethal` and `remaining`
    on commander-damage entries.
- **Session.** `MatchSession.sendPlayerActionRequired` calls it after smart-yield filtering.
  The game report path calls it too.
- **Client switch, in the same PR.** `PlayerGameView.vue`, `DecisionPanel.vue`, `ManaTaps.vue`,
  `CommanderDamageGrid.vue`, `HandStrip.vue`, `ZoneStrip.vue` and `PermanentChip.vue` read the
  new fields. The web stops importing `shared/src/presentation/`, enforced by a
  `no-restricted-imports` rule for `apps/web/src`. `playerFacingPrompt` and the log-text
  game-over search are deleted.
- **Agent client.** `agent-client-core.ts`'s `projectAgentGameOver` allowlist adds `summary`.
- **Property tests over the P1 sweep:**
  - every cast, activation and land play has a non-empty `label`;
  - every registry key marked `presentation` is used;
  - a yielded action has no entry;
  - every object id in an entry is in the seat's projection.

### P5 — Raw-data capability, browser type and lint (before M3)

- **Capabilities on connect.** The first player message and every resume message carry
  `capabilities: { rawActionData?: boolean }`. On the tester those messages are `startGame`,
  `startCardTestScenario` and `resumeGame`; on the table server, `joinTable` and `resumeSeat`.
- **The agent client asks for raw data** (`agent-client-core.ts`). Without the capability, the
  session strips `data` from player-bound legal actions and from the game report. Tests cover
  both settings.
- **Browser type.** The web's protocol types use `Omit<LegalAction, 'data'>`.
- **Two syntactic rules** for `apps/web/src` in `eslint.config.js`. `lib/tokenArt.ts` is exempt.
  - No string or regex calls on a `typeLine` member.
  - No regex `.test` on `prompt` or `text` members.

### P6 — Damage and life cues (before M6)

- `match/presentation.ts` `buildCues(events, boardBefore, boardAfter, viewer)` returns `damage`
  cues and `lifeChange` cues.
  - **`damage`:** carries the source and target object or player ids, the amount and the combat
    flag.
    - Permanent targets are resolved from `targetCardId` to an object id on either board, and
      player targets use the player id. Both payload shapes in `effects/resolve.ts` are handled.
    - A cue never carries a card id.
  - **`lifeChange`:** comes from `lifeGain` and `lifeLoss`.
  - Each cue carries its log line's sequence: the per-viewer sequence at tables, the event
    sequence elsewhere.
  - A cue whose objects are on neither board is dropped.
- **Who gets cues.** They ride on each seat's `eventBatch`. Spectator and replay frames get cues
  built with no viewer filter.
- **Client.** `useCombatStrikes.ts` and `useLifeFlash.ts` read cues and stop diffing snapshots.
- **Phase 8.** Its plan gains a note that its `ActionCue` contract extends this one.

## Tests that span steps

- **AI unchanged:** an `ai/context.test.ts` fixture prompt is byte-identical after P2 and P4.
- **Bots unchanged:** combat-sweep fixed-seed results are unchanged.
- **Events unchanged:** a fixed-seed four-bot game has the same `game_events` hash.
  `SpectatorState` JSON gains fields in P2, so tests that compare whole snapshots are updated
  there, and the PR explains the change.
- **Privacy:**
  - an opponent's face-down permanent has `types: ['Creature']`, no subtypes and no name;
  - redacted exile has no types;
  - no presentation entry or cue names an object outside the seat's projection or carries a card
    id.
- **End to end:** `test:e2e` after P2, P3, P4 and P6.

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
  - P4's view switch, one audit row per task.
- **Main thread:**
  - P2 (engine projection);
  - P4's priority layout;
  - P6's id mapping;
  - the lint rules.

## Risks

| Risk                                          | Mitigation                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| What players see changes by accident          | One shared copy of the label code (P3); intentional fixes isolated in P2 |
| Button text changes before the view is ready  | Enrichment and client switch in one PR (P4)                              |
| AI prompts or bot behavior change             | `data` and `view.ts` untouched; byte-identical prompt test; combat sweep |
| A renamed `data` key blanks a label           | Registry test; property test that every action has a label               |
| New projection fields leak on face-down exile | P2 waits for M2a's allowlist; privacy tests                              |
| Cues drop events about creatures that died    | Before and after boards; a test with a creature killed in combat         |
| Cues leak counters or card ids                | Per-viewer sequence; object ids only; frame scan                         |
