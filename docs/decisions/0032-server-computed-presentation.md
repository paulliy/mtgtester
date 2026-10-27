# ADR 0032: Server-computed presentation

Status: Proposed

Date: 2026-10-27

Plan: [server-computed presentation](../plans/server-computed-presentation.md). Related:
[ADR 0031](0031-multiplayer-tables.md) (multiplayer tables), which depends on this ADR only for
the views it adds.

## Context

The engine decides legality and the browser never does (ADR 0018, ADR 0019). The browser does,
however, derive game facts on its own, and some of what it derives is wrong.

- **Card types come from the printed type line.** The projection's `typeLine` is
  `perm.typeLine` (`view/spectator.ts:55`), the printed line, while power, toughness, keywords
  and colors in the same function come from `computeCharacteristics`. The browser classifies
  cards by matching text in that line:
  - `PlayerGameView.vue:129` `isPiledLand`;
  - `SeatPanel.vue:62-63`;
  - `lib/card.ts:2`;
  - `lib/tokenArt.ts:40`.

  So an animated manland that is attacking still reads "Land", and the player board piles it
  with lands. The spectator `SeatPanel` and the player board also disagree about land creatures,
  because each checks the text its own way.

- **Labels and costs come from the untyped `LegalAction.data`.** The browser reads 17 keys of
  `LegalAction.data` (`Record<string, unknown>`) to build cost lines, cast-variant labels,
  X-value groups, payment summaries and mana symbols. Those reads are in `PlayerGameView.vue`,
  `lib/actionLabels.ts` and `ManaTaps.vue`. A renamed key silently drops a cost from a confirm
  dialog.
- **Text is parsed.** The engine's prompt is rewritten with a regex (`lib/turnLabels.ts:38`,
  used by `DecisionPanel.vue:80` and `PlayerGameView.vue:2050`). The game-over line is found by
  matching log text (`PlayerGameView.vue:182`).
- **Rules are copied.** The 21-point commander-damage rule is a constant in
  `CommanderDamageGrid.vue:17`.

Every client repeats this work: the web app, the JSON agent client, and any later client.

Constraints found in the code:

- **`LegalAction.data` cannot change shape.** `ai/context.ts:186` puts `legalActions` into AI
  prompts verbatim. The heuristic bot reads `data` (`bot/src/evaluate.ts:59,107`,
  `combat-search.ts:109`, `veto.ts:16`), and so do `match/player-yield.ts:22`,
  `match/human-provider.ts:53`, `ai/primer.ts` and `ai/heuristics.ts`. Moving or renaming keys
  would change prompts, AI benchmark baselines and fixed-seed bot games.
- **There are already typed per-action UI structures.** `ActionInteraction`
  (`shared/src/engine.ts`) carries source ids and target slots. `DecisionPresentation` and
  `ActionPresentation` carry a verb, subjects and a role per action id. Neither reaches the AI.
  Any new presentation must extend these rather than run alongside them.
- **Saved snapshots lack new fields.** Turn snapshots of `SpectatorState` are stored as JSON in
  `game_state_snapshots`, and read back only through `GameRecorder.loadTurnSnapshot`
  (`db/games.ts:198`). Any new projection field is missing from older games. The repository
  rule is to document derivations, and to show legacy values as unavailable rather than guess
  them.
- **AI prompts never see the spectator projection.** They read `PlayerView` and
  `PermanentView` (`view/view.ts`, `ai/card-summary.ts`). New `SpectatorPermanent` fields cannot
  reach AI prompts, but changing `view.ts` would.

## Decision

1. **The server computes; the client renders.** Every value a player sees that comes from rules
   or engine data is computed on the server, typed, and sent. The client may:
   - lay out the board and animate it;
   - keep interactive state: hover, drag, partly chosen targets, the combat plan being
     composed, unsent input;
   - keep display preferences, including cosmetic thresholds such as low-life styling.

   It may not:
   - parse engine text (prompts, log lines, action descriptions);
   - read `LegalAction.data`;
   - classify cards from `typeLine`;
   - hold rules constants;
   - infer game events by comparing board snapshots.

2. **Card types come from characteristics.** `permanentView` adds optional `types`,
   `supertypes` and `subtypes` from the `computeCharacteristics` result it already computes.
   `cardView` adds `isToken`, which permanents already carry, and printed types for cards off
   the battlefield. A face-down permanent computes as a plain Creature (CR 708.2).
   `PlayerView` and `view.ts` do not change, so AI prompts do not change.

3. **Per-action presentation extends `ActionPresentation`.** The engine keeps building
   `request.presentation` as it does now. Before a request reaches a browser, the server
   enriches a copy of it in a new `match/presentation.ts`. Each `ActionPresentation` gains
   optional `label`, `summary`, `costLabels`, `entryNote`, `xFamily`, `payment`, `manaSymbols`
   and `targetHint`. `DecisionPresentation` gains `playerPrompt` and `xFamilies`.
   - There is no second per-action structure, and no new index of sources: the client keeps
     grouping by the typed `interaction`, as ADR 0019 decision 2 specifies.
   - `presentation.ts` is one more reader of `data`, alongside the engine, AI, bot and `match/`
     readers listed above, and it is the only one that feeds a browser.
   - It builds from the already-filtered menu and the seat's player projection, never from
     `GameState`.

4. **`data` keys are checked at run time, not by retyping `data`.** `data` stays
   `Record<string, unknown>`. Closing the type would touch every construction site in
   `legal.ts`, `resolve.ts`, `combat.ts`, `cast.ts`, `condition.ts` and `manual.ts`, and every
   reader. A registry in `shared` names each `data` key the engine emits and which consumer
   handles it. A test runs the Card Test Lab scenarios and a fixed-seed game, collects every
   emitted key, and fails on an unregistered key, or on a registered key that presentation reads
   but nothing emits.

5. **Board, game-over and commander damage.**
   - The server adds `boardGroup` (`lands`, `creatures`, `other`) per permanent from the
     characteristic types, so every view groups the same way. A land creature groups with
     creatures, because it can attack and block.
   - `GameOverPayload` gains `summary`.
   - Commander-damage entries gain `lethal` and `remaining`.

6. **Legacy snapshots are labeled, not guessed.** A snapshot saved without `types` is filled on
   load from the printed type line, ignoring the `Token` word. It is marked
   `typesFrom: 'printed'`, and the replay view shows a one-line note that older games group cards
   by printed type. `GameRecorder.loadTurnSnapshot` is the only reader of `state_json`, so this
   is the only place that needs it. Stored rows are never rewritten.

7. **Raw `data` reaches a player socket only on request.** A player connection says in its first
   message whether it wants raw `LegalAction.data`. The JSON agent client asks for it, keeping
   its documented contract that `legalActions` are published exactly as received. The browser
   never asks. Both the tester and the table server follow this one rule.

8. **Animation cues belong to Phase 8.** Combat-strike and life-flash cues currently diff
   snapshots. They move to the typed, server-built cue contract that
   `docs/plans/phase-8-action-animations.md` already plans. That contract has two requirements:
   - it is built per seat from engine events, with object ids looked up on the board both
     before and after the event batch, so an event about a creature that just died is kept;
   - it carries only what the seat's projection shows.

   This ADR does not define a second cue type.

9. **A lint rule keeps the boundary.** `eslint.config.js` gains `no-restricted-syntax` and
   `vue/no-restricted-syntax` selectors for `apps/web/src`, the same approach the repository
   already uses for card authoring. They reject member access to `.data` on a legal action,
   string matching on `typeLine`, regex calls on log or prompt text, and the named rules
   constants. Reviewed exceptions use an inline disable with a reason.

## Consequences

- The animated-land bug and the spectator/player disagreement are fixed, and the fix shows up
  as an intentional, documented change in golden tests.
- The browser stops importing `lib/actionLabels.ts`, `lib/card.ts` and `playerFacingPrompt`.
  `PlayerGameView.vue` loses its derivation helpers.
- The agent client and any later client get labels and costs without re-deriving them.
- AI prompts, bot behavior and fixed-seed engine event streams are unchanged. `SpectatorState`
  bytes do change (the new fields), so any test comparing whole snapshots is updated in the same
  change.
- The server does a little more work per human decision: enriching one menu. The projection
  gains three short arrays per permanent. `computeCharacteristics` already runs for each
  projected permanent and is cached.
- What stays in the client is listed in the plan. Moving combat-plan composition to the server
  was considered and rejected: it already offers only engine-provided options and submits one
  proposal the engine validates, so moving it would add a round trip on every click.

## Alternatives considered

- **Keep derivation in the browser.** Rejected. It is already wrong once, it is repeated in
  every client, and it fails silently when engine wording or keys change.
- **Move `data` into typed presentation.** Rejected. It would change AI prompts and bot behavior.
- **Close the `data` type and use `satisfies`.** Rejected for now. It is a wide refactor across
  the engine and its readers, and a runtime key registry catches the same renames with a smaller
  change.
- **A new parallel `SeatDecisionPresentation` type.** Rejected. It would put two per-action UI
  structures in one frame.
- **Build finished strings in the engine.** Rejected. The rules-engine constraints keep UI logic
  out of `packages/engine`. The engine supplies typed facts and the server writes the words.
- **Move the unplayed-land reminder to the server.** Rejected. It is a confirmation of unsent
  input. Under a decision clock the clock keeps running whether or not a dialog is open, so the
  server loses nothing by leaving it in the client.
