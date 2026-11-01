# ADR 0032: Server-computed presentation

Status: Accepted (2026-10-29)

Date: 2026-10-27

Amends: [0019](0019-direct-player-controls.md) decision 5. Presentation facts for casts and
abilities move from `LegalAction.data` to server-built presentation.

Plan: [server-computed presentation](../plans/server-computed-presentation.md). Related:
[ADR 0031](0031-multiplayer-tables.md) (multiplayer tables).

## Context

The engine decides legality and the browser never does (ADR 0018, ADR 0019). The browser does,
however, derive game facts on its own, and one of those derivations is wrong.

- **Card types come from the printed type line.** The projection's `typeLine` is the printed line
  (`perm.typeLine`, `view/spectator.ts:55`), while power, toughness, keywords and colors in the
  same function come from `computeCharacteristics`. The browser classifies cards by matching text
  in that line (`PlayerGameView.vue:129`, `SeatPanel.vue:62-63`, `lib/card.ts:2`). So an attacking animated manland still reads "Land" and the player board
  piles it with lands. The spectator `SeatPanel` and the player board also disagree about land
  creatures.
- **Labels and costs come from the untyped `LegalAction.data`.** The browser reads 17 keys of it
  to build cost lines, cast-variant labels, X-value groups, payment summaries and mana symbols
  (`PlayerGameView.vue`, `lib/actionLabels.ts`, `ManaTaps.vue`). A renamed key silently drops a
  cost from a confirm dialog.
- **Text is parsed in more places than one.**
  - `ManaTaps.vue:24` builds button text with `action.description.split(': add ')`.
  - `lib/lossReasons.ts:22` rewrites the elimination log line with a regex `.replace`.
  - The engine's prompt is rewritten by regex (`lib/turnLabels.ts:39`, used at
    `DecisionPanel.vue:80` and `PlayerGameView.vue:2050`). The game-over line is found by matching
    log text (`PlayerGameView.vue:182`).
- **Rules are copied.** The 21-point commander-damage rule is a constant in
  `CommanderDamageGrid.vue:17`.
- **Events are guessed.** Combat-strike and life-flash animations guess what happened by diffing
  snapshots (`useCombatStrikes.ts`, `useLifeFlash.ts`, `useBoardFlash.ts`).

Every client repeats this work: the web app, the JSON agent client, and any later client.

Constraints found in the code:

- **`LegalAction.data` cannot change shape.** AI prompts include `legalActions` verbatim
  (`ai/context.ts:186`). The bot (`evaluate.ts`, `combat-search.ts`, `veto.ts`), `match/`
  (`player-yield.ts`, `human-provider.ts`) and `ai/` (`primer.ts`, `heuristics.ts`) all read it.
- **Presentation exists only for choice decisions.** `ActionPresentation` (verb, subjects, role)
  and `DecisionPresentation` (layout and per-action entries) exist in `shared/src/engine.ts`, but
  the engine fills them only for choice decisions (`decisions.ts`, helpers in `present.ts`).
  Priority actions — casts, activations, land plays — have none. The browser reads `presentation`
  in two places:
  - `DecisionPanel.vue`, which uses `actions[id].verb` in place of the description when present;
  - `stores/combatPlan.ts`, which reads the attack and block declarations.

  The typed `interaction` field already carries source ids and target
  slots for every action.

- **AI prompts never see the spectator projection.** They read `PlayerView` and `PermanentView`,
  so new `SpectatorPermanent` fields cannot reach them, but changing `view/view.ts` would.
- **Old snapshots are not displayed.** Turn snapshots are read back only for the game the current
  server is running (`GameRecorder.loadTurnSnapshot`, reached through `recorderFor` on the live
  game). No screen shows a saved snapshot from an older game, so new optional fields need no
  read-time migration today.

## Decision

1. **The server computes; the client renders.** Every value a player sees that comes from rules
   or engine data is computed on the server, typed, and sent.

   The client may:
   - lay out the board and animate it;
   - keep interactive state (hover, drag, partly chosen targets, the combat plan being composed,
     unsent input and its confirmations);
   - keep display preferences.

   It may not:
   - parse engine text;
   - read `LegalAction.data`;
   - classify cards from `typeLine`;
   - hold rules constants;
   - infer game events from board snapshots.

2. **Card types come from characteristics.** `permanentView` adds optional `types`,
   `supertypes` and `subtypes` from the `computeCharacteristics` result it already computes.
   `cardView` adds `isToken` and printed types. A face-down permanent computes as a plain
   Creature (CR 708.2). The projection also sends a `boardGroup` for each permanent (`lands`,
   `creatures`, `other`), computed on the server by one function. A land creature groups with
   creatures, because it can attack and block. The client does not classify; it reads the field.
   `PlayerView` and `view.ts` are unchanged.

3. **Every action gets a presentation entry, through the existing structure.**
   - `DecisionPresentation` gains a `'priority'` layout and `playerPrompt`.
   - `ActionPresentation` gains optional `label`, `summary`, `costLabels`, `entryNote`,
     `xFamily`, `payment`, `manaSymbols` and `targetHint`.
   - For priority decisions the server creates the entries. Each verb is derived from the action
     type (`Cast`, `Play`, `Activate`, `Tap for mana`, `Pass`, and so on), and subjects are
     empty. Because `DecisionPanel.vue` already shows `verb` in place of the description, the
     server enrichment and the client switch land in one change, so no button text changes
     before its view is ready.
   - For choice decisions the server adds the new fields to the engine's existing entries.
   - This is the first time priority actions carry presentation. It uses the existing types
     rather than a second per-action structure.
   - The client keeps grouping actions by the typed `interaction`, as ADR 0019 decision 2
     specifies.
   - The new `match/presentation.ts` builds entries from the already-filtered menu and the seat's
     player projection, never from `GameState`.

4. **The `data` keys are registered and checked at run time.** `data` stays
   `Record<string, unknown>`. A registry in `shared` names each key the engine emits, the set of
   value types seen for it, and its consumers.

   A test collects keys from two sources:
   - the first surfaced decision of every registered Card Test Lab scenario;
   - several fixed-seed four-bot games.

   It fails on an unregistered key, on a value type outside the registered set, or on a
   presentation key that nothing emits. It proves coverage only of the keys those runs reach.
   The card-coverage workflow therefore adds a step: a change that adds a `data` key registers
   it.

5. **Game over, eliminations and commander damage.**
   - `GameOverPayload` gains `summary`.
   - The player-facing elimination log line is written on the server, with the reason in player
     terms, replacing `lib/lossReasons.ts`.
   - Commander-damage entries gain `lethal` and `remaining`.
   - Mana-ability actions get a presentation `label` and `manaSymbols`, replacing the split in
     `ManaTaps.vue`.

6. **The new projection fields are optional.** No read-time migration is needed, because no
   screen shows an old game's snapshot. If a historical replay screen is added later, it must
   show missing types as unavailable rather than derive them from the printed line, as the
   repository's rule on legacy data requires.

7. **Raw `data` reaches a player socket only on request.** A player connection declares
   `capabilities` in its first message, and again on every resume. Only the JSON agent client
   asks for `rawActionData`, which keeps its documented contract. The browser never asks. Every
   server follows this one rule. (The game report carries only the pending request's id, type,
   prompt and option descriptions, so it has no raw `data` to strip.)

   This is a consistency rule, not a security boundary, because `data` holds only the deciding
   player's own options. The browser's protocol types use a `LegalAction` without `data`, so a
   web read of `data` fails typecheck.

8. **Server-built animation cues.** This ADR defines the first slice of Phase 8's planned
   `ActionCue` contract (`docs/plans/phase-8-action-animations.md`): `damage` and `lifeChange`
   cues.
   - Each cue carries the same sequence as the log line it accompanies: per viewer at tables
     (ADR 0031 decision 5), the event sequence elsewhere.
   - It carries object or player ids, never card ids. The server maps card ids from engine
     events to object ids with a private map built from engine state before and after the batch.
   - A `lifeChange` cue carries the real change in a player's life total over the batch, taken
     from the before and after totals, because damage to a player emits no life field and the
     damage amount is not always the life lost (infect, Angel's Grace).
   - Cues are built per seat from engine events, with object ids looked up on the boards before
     and after the event batch, so an event about a creature that just died is kept.
   - A cue carries only what the seat's projection shows.
   - Damage cues are grouped per damage step (first strike, regular), one group per step, so
     Phase 8's per-step animation can extend them without changing their shape.
   - Spectator and replay views get the same cues built with no seat filter, so their
     animations keep working.
   - Tap and untap flashes are state, not events, so they keep comparing consecutive boards. That
     is a display of state, not an inference of what happened.

   Phase 8 had keyed cues to spectator snapshots and had no per-seat rule, so these are new
   requirements on that plan. Phase 8 extends this slice instead of defining its own.

9. **Lint is narrow; run-time checks do the rest.** The repository's lint config is untyped, so a
   rule cannot tell a `LegalAction` from anything else. `eslint.config.js` gains only two
   syntactic rules for `apps/web/src`:
   - string or regex calls on a `typeLine` member;
   - string or regex calls (`.test`, `.match`, `.split`, `.replace`, `.includes`) on
     `description`, `prompt` or `text` members.

   Reading `data` is prevented by the browser's protocol type and by run-time stripping
   (decision 7), and the deleted modules cannot be re-imported because they no longer exist.
   Token-art lookup (`lib/tokenArt.ts`) is exempt: it splits the type line only to build a
   Scryfall search for the printed token's picture. That is a cosmetic lookup, not a rules
   classification.

## Consequences

- The animated-land bug and the spectator/player disagreement are fixed, each with its own test.
- `lib/actionLabels.ts`, `lib/card.ts` and `playerFacingPrompt` are removed from the browser.
  The combat-strike and life-flash composables stop diffing snapshots and read cues instead.
- AI prompts, bot behavior and fixed-seed engine event streams are unchanged. `SpectatorState`
  JSON gains fields, so tests that compare whole snapshots are updated in the same change.
- The server does a little more work per human decision, building one menu's presentation. The
  projection gains three short arrays per permanent, and `computeCharacteristics` is already
  cached.
- Combat-plan composition stays in the client. It offers only engine-provided options and submits
  one proposal the engine validates, and moving it would add a round trip on every click.

## Alternatives considered

- **Keep derivation in the browser.** Rejected. It is wrong once already, every client repeats it,
  and it fails silently when engine wording or keys change.
- **Move `data` into typed presentation.** Rejected. That would change AI prompts and bot
  behavior.
- **Close the `data` type with `satisfies`.** Rejected for now. It touches every construction
  site (`legal.ts`, `resolve.ts`, `combat.ts`, `cast.ts`, `condition.ts`, `manual.ts`) and every
  reader. The runtime registry catches the same renames with a smaller change.
- **A parallel per-seat presentation type.** Rejected. It would put two per-action structures in
  one frame.
- **A per-source index of the menu.** Rejected. It duplicates the typed `interaction`.
- **Finished strings built in the engine.** Rejected. The rules-engine constraints keep UI logic
  out of `packages/engine`.
- **Move the unplayed-land reminder to the server.** Rejected. It confirms unsent input, and a
  running clock keeps running either way.
- **Fill old snapshots' types from the printed line.** Rejected. Nothing reads them today, and
  guessing would break the repository's rule on legacy data.
