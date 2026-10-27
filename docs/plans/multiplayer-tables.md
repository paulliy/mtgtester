# Multiplayer tables

Decision record: [ADR 0031](../decisions/0031-multiplayer-tables.md). Status: proposed and awaiting
approval. M1 and M2 improve the tester on their own and can start now. Later milestones wait for
ADR 0031 to be accepted; M4 is the one that opens a non-loopback listener
([testing discipline](../guides/testing-discipline.md)).

## Purpose

Let one to four people play one Commander game from their own browsers, with bots in the empty
seats, without weakening the tester. The engine stays authoritative, each seat sees only what its
player may see, the server does the calculations and the browser renders them, and the tester's
debug and analysis surfaces stay on loopback.

## Player outcome

A host should be able to:

1. Run `bun run serve:table`, create a table, and send friends an invite link.
2. See who has joined, which seats are bots, and when everyone is ready, then start the game.

A guest should be able to:

1. Open the invite link, choose a display name, import a deck, and get a clear private message if
   the deck has unmodeled cards.
2. Play with the same board, controls, smart yield and manual mana as single-player.
3. See whose decision the table is waiting on and how much time they have left.
4. Close the tab, reopen it within the grace period, and continue from the same pending choice.
5. Once the game ends, see the replay, every decklist and the seed.

## Scope and non-goals

In scope:

- one to four human seats, with heuristic or random bots in the rest (LLM bots only with a
  host-configured key);
- invite-link tables, seat tokens, display names, and per-player deck import;
- per-seat projections, logs and errors; decision clocks; fallback bots; reconnects;
- server-computed presentation, so browsers render rather than derive (M2);
- a loopback-default table server with opt-in LAN or internet binding behind an origin allowlist;
- one web app with a table build that hides tester routes.

Out of scope (revisit after M6):

- accounts, friend lists, public matchmaking, ranking;
- live spectators who watch a table (a hidden-information design of its own);
- restoring a live game after a server restart (see M7, optional);
- in-app chat beyond a fixed set of short messages;
- rules changes in the engine. M2 adds descriptive projection fields and a type declaration for
  `LegalAction.data`, neither of which changes rules behavior. If a milestone appears to need a
  rules change, stop and write a separate ADR.

## Ground rules for every milestone

- `Engine.submit()` with an offered action id remains the only authority. The browser and
  the table server never build legality themselves.
- **The server computes; the client renders** (ADR 0031 decision 12). Once a calculation has
  moved to the server under M2, a new client feature may not bring it back. M2's
  client-boundary lint test enforces this.
- No live payload carries `spectatorState()`, the seed, AI notes, debug events or another
  seat's private data. Every new message type or projection field gets a privacy test before it
  ships.
- Fixed-seed games with no human seats are bit-for-bit unchanged, and so are AI prompts. Run
  the existing spectator, combat-sweep and `ai/context` tests on every milestone.
- Wire types go in `packages/shared`, and every consumer is updated in the same change (web
  store, agent client, tests).
- Run what CI runs: `typecheck`, `typecheck:tests`, `lint`, `format:check`, `test`, the web
  build, and `test:e2e` plus `test:e2e:setup` for viewer changes.

---

## M1 — Seat controllers (refactor, no behavior change)

Goal: the session supports any number of human seats internally while single-player and spectator
behave exactly as today. This milestone is worth doing even if the table server is never built.

### Tasks

1. **Protocol vocabulary** (`packages/shared/src/protocol.ts`)
   - Add `export type SeatControllers = Readonly<Record<PlayerId, SeatControllerKind>>`.
   - Add `'table'` to `GameMode`. Keep `StartGamePayload` accepting today's
     `{ gameMode: 'singlePlayer', humanSeat }`; the server converts it to seat controllers. The
     tester's wire format does not change.
   - Validator tests in `protocol.test.ts` for the new type and for rejecting duplicate or
     unknown seats.

2. **`MatchSession` options** (`packages/server/src/match/session.ts`)
   - Replace `gameMode?` + `humanSeat?` with `seatControllers: SeatControllers` and
     `gameMode: GameMode`. Derive `humanSeats: ReadonlySet<PlayerId>`.
   - Replace the player-game checks (about 15 `gameMode === 'singlePlayer'` branches) with
     `humanSeats.size > 0`, plus mode-specific helpers where single-player and table actually
     differ (seed disclosure, debug unlock).
   - Turn each per-player field into a `Map<PlayerId, …>` held in one `HumanSeatState` record:
     `humanProvider`, `connectionGate`, `ignoredAbilities`, `smartYieldMemory`,
     `playerRevision`, `lastHumanDecision`.
   - Enable manual mana for every human seat: `players.map(...)` and `enableManualMana` in a
     loop.
   - `controllerKind` for each seat comes from `seatControllers`. `onDecision` checks
     `humanSeats.has(request.decidingPlayer)`.
   - Public methods that take a seat implicitly (`submitPlayerAction`, `yieldPlayerAbility`,
     `resumePlayerAbility`, `cancelYield`, `resync`, `gameReport`) take an explicit
     `seat: PlayerId`. The tester's `WsServer` passes its single human seat.

3. **Per-seat output**
   - Replace `send(message)` in `MatchSessionOptions` with `sendPublic(message)` and
     `sendToSeat(seat, message)`.
   - With one or more human seats, the runner's `formatEvents` produces a log for each human seat
     (`formatPlayerLog(events, seat)`), and each seat's batch goes out with `sendToSeat`.
     Spectator mode keeps the single public batch.
   - `publishPlayerState`, `sendPlayerActionRequired` and the game-over release loop over human
     seats.
   - Tester `WsServer`: `sendPublic` broadcasts in spectator mode; `sendToSeat(humanSeat, …)`
     goes to `playerSocket`; anything sent to another seat is a programming error (throw in
     tests, drop and log in production).

4. **Strategy coordinator** (`packages/server/src/ai/strategy-coordinator.ts`): record human
   decisions for each human seat rather than the single one.

### Tests

- Every existing test in `packages/server/src/match/*.test.ts`,
  `packages/server/src/ws/*.test.ts` and `apps/web/src/stores/game.test.ts` passes without
  changing what it asserts. Changes to how sessions are constructed are fine.
- New `match/session-multi-human.test.ts`, in-process and without sockets:
  - two human seats plus two random bots on a fixed seed; drive both humans by submitting the
    first offered pass or land play; the game reaches the turn cap;
  - each seat's `sendToSeat` stream contains only that seat's hand, and nothing in it references
    an object id from another seat's hand or library;
  - P2 submitting while P1's decision is pending is rejected without a state change;
  - a revision from P1 replayed as P2 is rejected;
  - a disconnect on P1 does not hold up P2's decision (each seat has its own gate).
- Determinism: an existing fixed-seed spectator game produces an identical event stream
  before and after the refactor (snapshot of a hash).
- `test:e2e` `player-game.spec.ts` passes unchanged.

### Exit criteria

Full CI green. A diff review against this checklist: no `humanSeat!` non-null assertions
remain, and no session field is single-player-only by accident.

---

## M2 — Server-computed presentation (thin client)

Goal: the browser only lays out, animates, and collects input. Every value it shows that comes
from rules or engine data is computed on the server, typed, and projected per seat.

### Why

- **There is a bug today.** The projection's `typeLine` is the printed line (`perm.typeLine`),
  while its power, toughness and keywords come from `computeCharacteristics`. A manland that has
  been animated and is attacking still reads "Land", so the player board puts it in the lands
  pile. The spectator `SeatPanel` and the player board also disagree about land creatures such
  as Dryad Arbor.
- **Clients must agree.** With several players, two browsers deriving the same fact separately
  can disagree.
- **Every client would repeat the work.** The web app, the JSON agent client and any later
  client would each reimplement these derivations.
- **Text parsing fails silently.** A changed engine string or a renamed `data` key drops a cost
  from a confirm dialog and no test fails.
- **Rules knowledge belongs with the rules.** A client constant such as 21 commander damage is a
  second copy of a rule.

### Client boundary (ADR 0031 decision 12)

The client may lay out the board, animate, remember unsent input, and keep display preferences
(including cosmetic thresholds such as low-life styling at 10). It may not:

- parse engine text (prompts, log lines, action descriptions);
- read `LegalAction.data`;
- classify cards from `typeLine`;
- hold rules constants;
- infer game events by comparing one board snapshot with the next.

### Constraints found in the code

1. **`LegalAction.data` stays exactly as it is.** `ai/context.ts:186` puts
   `request.legalActions` into the prompt verbatim, and the heuristic bot reads `data`
   (`bot/src/evaluate.ts`, `combat-search.ts`, `veto.ts`). Changing it would change AI
   prompts, AI benchmark baselines, and fixed-seed bot games.
2. **Saved snapshots lack new fields.** `GameRecorder.saveTurnSnapshot` stores `SpectatorState`
   JSON, and `loadTurnSnapshot` returns it for replay. Every new projection field is optional in
   `shared` and filled on the server for legacy rows.
3. **Face-down redaction is a deny list.** `buildPlayerBoardState` (`view/spectator.ts:311`)
   copies a face-down opponent permanent with `...permanent` and overrides name, type line, cost,
   text, art, `isToken` and colors. A new field passes through unless someone adds it to the
   override list.
4. **The engine log carries card ids, not object ids.** `damage` events carry `source`, `target`
   (names), `sourceCardId`, `targetCardId`, `amount` and `combat`. Board anchors are keyed by
   object id, so presentation events need a server-side map through the seat's projection.
5. **The agent client's contract.** `agent-client-core.ts` publishes `legalActions` exactly as
   received, including `data`. Stripping `data` on the tester would break that documented
   contract.
6. **`MatchSession.sendPlayerActionRequired` filters the menu** through smart yield before
   sending. Presentation must be built from the filtered menu, or it would show yielded actions as
   playable.

### Audit of current client calculations

| #   | Today                                                                                                                                         | Problem                                                                                                           | Server-side replacement                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `PlayerGameView.vue:129` `isPiledLand`; `SeatPanel.vue:62-63`; `lib/card.ts:2` `isTokenTypeLine`; `lib/tokenArt.ts:40` `cardTypes`            | Printed type line, matched as text; two views disagree; wrong for animated lands                                  | Engine projection: optional `types`, `supertypes`, `subtypes` from `computeCharacteristics`, and `isToken` on every card. Server: `boardGroup` (`lands`, `creatures`, `other`) from one function                         |
| 2   | `PlayerGameView.vue:1064` `actionCost`, `:1105` `pendingSummary`; `lib/actionLabels.ts` (variant labels, enters-tapped notes, optional costs) | Reads 12 untyped `data` keys                                                                                      | `label`, `costLabels`, `entryNote` per action                                                                                                                                                                            |
| 3   | `PlayerGameView.vue:491` X-value grouping by `data.x` and `data.modeLabel`                                                                    | Same                                                                                                              | `xFamily` (`key`, `x`) per action; `xFamilies` (`key`, `min`, `max`, action id per X) per decision                                                                                                                       |
| 4   | `PlayerGameView.vue:1178-1198` payment from `data.paymentSourceIds` and `data.paymentSourceNames`                                             | Same                                                                                                              | `payment` (`sourceIds`, `summary`) per action                                                                                                                                                                            |
| 5   | `components/ManaTaps.vue:12` mana symbols from `data.symbols`; `lib/actionLabels.ts:80` `data.targetReductionSlot`                            | Same                                                                                                              | `manaSymbols` and `targetHint` per action                                                                                                                                                                                |
| 6   | `PlayerGameView.vue:591` playable-source ranking; `:1142` `isLegalTarget` scanning every action on each hover                                 | An index of the menu rebuilt in the browser                                                                       | `sources`, keyed by object id: `verb`, `actionIds`, `targetIds`                                                                                                                                                          |
| 7   | `lib/turnLabels.ts:38` `playerFacingPrompt` (used by `DecisionPanel.vue:80`)                                                                  | Regex over engine prompt text                                                                                     | `prompt` (player-facing). The engine's `request.prompt` stays for the AI                                                                                                                                                 |
| 8   | `PlayerGameView.vue:182` game-over line found by matching log text                                                                            | Text matching                                                                                                     | `summary` on `GameOverPayload`, built from `result` and `standings`                                                                                                                                                      |
| 9   | `CommanderDamageGrid.vue:17` `LETHAL = 21`                                                                                                    | A rules constant in the client                                                                                    | `commanderDamage` cells: `amount`, `lethal`, `remaining`                                                                                                                                                                 |
| 10  | `composables/useCombatStrikes.ts`, `useLifeFlash.ts`, `useBoardFlash.ts`                                                                      | Diff snapshots to guess hits; the code's own comment admits misattribution (non-combat damage, trample)           | `presentationEvents` on each seat's `eventBatch`: `damage` (source and target object ids, amount, combat flag), `lifeChange`, `counterChange`. Derived from engine events; only objects visible in the seat's projection |
| 11  | `PlayerGameView.vue:644` `needsLandReminder`                                                                                                  | Decides whether to interrupt the player; under a decision clock (M5) it can spend clock time the server can't see | A per-seat server preference next to smart yield; the server sends `landReminder: true` with the pass it would otherwise accept                                                                                          |

The 17 `data` keys the web reads today: `x` (6 reads), `sourceName` (3), `modeLabel` (2),
`targetReductionSlot`, `paymentSourceNames`, `paymentSourceIds`, `payLifeToUntap`,
`optionalMechanic`, `optionalCostCount`, `manaCost`, `entersTappedConditional`, `entersTapped`,
`energyCost`, `castVariant`, `abilityDescription`, `abilityCosts`, and `symbols`.
`LegalActionData` declares at least these.

Stays in the client: visual stacking of identical permanents (`lib/stackPermanents.ts`, which
uses server fields only), widths and column layout, grouping already-projected log lines by seat,
the phase and step name lookup in `turnPositionLabel`, low-life styling,
`confirmRoutineActions`, reduced motion, and combat-plan composition (ADR open question 6).

### Design

**Engine (`packages/engine`), descriptive only:**

1. `permanentView` adds `types`, `supertypes` and `subtypes` from the `chars` it already
   computes. `cardView` adds `isToken` and printed types for non-battlefield cards.
2. `buildPlayerBoardState` builds a redacted face-down permanent from an explicit allowlist
   (id, controller, owner, tapped, P/T, damage, counters, statuses, combat fields,
   attachments, keywords), not by spreading and overriding. Redacted values: name
   `Face-down permanent`, types `Creature`, everything else empty. The same applies to redacted
   exile cards.
3. `packages/shared/src/engine.ts` declares `LegalActionData` with every key the engine emits,
   each optional and documented. `LegalAction.data` becomes `LegalActionData`. Construction sites
   in `actions/legal.ts` and `mana/manual.ts` use `satisfies LegalActionData`, so a renamed key
   fails typecheck. Runtime values are unchanged.

**Server (`packages/server/src/match/presentation.ts`, new):**

```ts
export interface SeatDecisionPresentation {
  prompt: string;
  actions: Record<number, SeatActionPresentation>; // keyed by LegalAction.id
  sources: Record<ObjectId, { verb: string; actionIds: number[]; targetIds: string[] }>;
  xFamilies: XFamily[];
  landReminder?: true;
}
export interface SeatActionPresentation {
  label: string;
  summary: string;
  costLabels: string[];
  entryNote?: string;
  xFamily?: { key: string; x: number };
  payment?: { sourceIds: ObjectId[]; summary: string };
  manaSymbols?: string[];
  targetHint?: string;
}
export function presentDecision(
  request: DecisionRequest, // already smart-yield filtered
  board: PlayerBoardState,
  prefs: SeatPreferences,
): SeatDecisionPresentation;
export function presentBoard(board: PlayerBoardState): BoardPresentation; // boardGroup, commander cells
export function presentEvents(
  events: readonly GameEvent[],
  board: PlayerBoardState,
): PresentationEvent[];
export function normalizeLegacySnapshot(state: SpectatorState): SpectatorState;
```

- These are pure functions with no session state and no `GameState`, and they are unit-testable.
- `PlayerActionRequiredPayload` gains `presentation: SeatDecisionPresentation`, separate from
  the engine's own `request.presentation`, which stays as it is.
- `PlayerStateSnapshotPayload` gains `boardPresentation`, and the seat's `eventBatch` gains
  `presentationEvents`.
- Spectator payloads on the tester get the same `presentBoard` and `presentEvents` with no
  seat filter, so `GameView` and `SeatPanel` also stop deriving.
- `presentEvents` maps `sourceCardId` and `targetCardId` to object ids through the seat's
  board. It drops an event whose object is not visible to that seat, and it never forwards the
  event's name strings.
- `normalizeLegacySnapshot` runs in `GameRecorder.loadTurnSnapshot`. For a snapshot without
  `types`, it fills them from the printed type line, the same derivation the client uses
  today, and documents it as legacy-only.
- Hook points in `MatchSession`:
  - `sendPlayerActionRequired`, after the smart-yield filter;
  - `publishPlayerState`;
  - the per-seat `eventBatch`;
  - `publishGameOver`, for the summary.

**Table server only:** player frames carry `legalActions` without `data`. The tester keeps
sending `data` to its player socket for the agent client's contract. The browser ignores it in
both builds.

**Client:** `PlayerGameView.vue`, `SeatPanel.vue`, `DecisionPanel.vue`, `ManaTaps.vue`,
`CommanderDamageGrid.vue`, the three composables, and `HandStrip`, `ZoneStrip` and
`PermanentChip` (token badge) read the new fields. `lib/actionLabels.ts`, `lib/card.ts` and
`playerFacingPrompt` are deleted.

### Migration: move, prove parity, delete

1. **Capture fixtures.** A new `scripts/capture-presentation-fixtures.ts` writes
   `apps/web/src/lib/__fixtures__/presentation-inputs.json`. It records each human
   `(request, board)` pair from:
   - a fixed-seed single-player game against random bots, with the human driven by a fixed
     policy (first non-pass action, else pass);
   - Card Test Lab scenarios that cover painlands, X spells, kicker and replicate, MDFC,
     energy, bestow, overload, a face-down permanent, a Room unlock, a Killian
     target-reduction cast, and a partner commander.
2. **Golden output from today's client.** The `.vue` functions are first extracted, unchanged,
   into `apps/web/src/lib/legacy-presentation.ts`. A web test runs them over the fixtures and
   commits `presentation-golden.json`.
3. **Server matches the golden.** `match/presentation.test.ts` asserts the server output equals
   the golden for every fixture.
4. **Switch and delete.** Point the client at the server fields and delete the legacy module.
   The golden file stays as the server's regression test.
5. **Intentional fixes come after parity, in their own commit.** Current types for animated
   lands, and land creatures shown with creatures, each update the golden with a note
   explaining the change.

Step 1 runs on the server's real engine, so if a fixture key goes missing, that shows up as a
golden mismatch, not as a silent blank.

### Order (each step is one PR)

1. Engine: the `LegalActionData` declaration with `satisfies` (type-only), and the allowlist
   redaction with its coverage test.
2. Engine projection type fields; `normalizeLegacySnapshot`; item 1 (with parity, then the fix).
3. Fixtures and golden capture; items 2–6 (action presentation).
4. Items 7–9: prompt, game-over summary, commander damage.
5. Item 11: the land reminder moves to the server.
6. Item 10: presentation events. Coordinate with the animation plan
   (`docs/plans/phase-8-action-animations.md`).
7. The boundary lint test `apps/web/src/client-boundary-lint.test.ts`, modeled on
   `packages/engine/tests/casting-boundary-lint.test.ts`. It fails on:
   - `.data?.[` or `actionData(` in `apps/web/src`;
   - `typeLine` used with `.includes`, `.test`, `.match` or `.split`;
   - a regex applied to `line.text` or `prompt`;
   - the literal `21` in a component.

   Exceptions go in a reviewed allowlist file.

### Tests

- `match/presentation.test.ts`: unit tests for each function, plus golden parity.
- Redaction: a test that builds a `SpectatorPermanent` with every key set and asserts the
  redacted opponent copy contains only allowlisted keys. It fails when a new key appears without
  a decision.
- Face-down: an opponent's face-down Morph shows types `Creature`, no subtypes, no name, and its
  `presentationEvents` carry only its object id.
- Legacy: a snapshot saved without `types` loads with types filled; one saved with them
  is returned unchanged.
- AI unchanged: a fixed request built before and after the engine type change produces a
  byte-identical prompt in `ai/context.test.ts`; the combat sweep's fixed-seed results are
  unchanged.
- Animated land: a fixed scenario where an activated manland attacks shows `types` including
  Creature and `boardGroup: 'creatures'`, and the land pile excludes it.
- Smart yield: a yielded action is absent from `sources` and from `actions`.
- Table server: player frames contain no `data`. On the tester, the agent-client tests still
  see `data`.
- `test:e2e` `player-game.spec.ts` and the Card Test Lab spec pass, and so does the spectator
  smoke spec.

### Exit criteria

- The client-boundary lint passes with an empty allowlist, or with each remaining entry
  reviewed and justified.
- Golden parity holds, apart from the documented intentional fixes.
- AI prompt bytes and fixed-seed bot games are unchanged.
- CI is green.

---

## M3 — Table server skeleton on loopback

Goal: `bun run serve:table` runs several tables at once on 127.0.0.1, each with multiple human
seats, playable from several browser tabs on one machine.

### Layout

```
packages/server/src/table/
  registry.ts        TableRegistry: tableId → Table; caps; idle reaping
  table.ts           Table: lobby state machine, seats, tokens, owns one MatchSession
  tokens.ts          invite codes and seat/host tokens (crypto.getRandomValues, constant-time compare)
  table-ws.ts        WebSocket handler: table message set only
  table-http.ts      REST: create table, table summary, deck validation
  config.ts          TABLE_* environment parsing
  *.test.ts
packages/server/src/cli/serve-table.ts
```

`package.json`: add `"serve:table": "bun run packages/server/src/cli/serve-table.ts"`.

### Lobby state machine (`table.ts`)

```
open ──claimSeat/leaveSeat/setBot──▶ open
open ──host start (≥1 human, every seat filled or bot, every deck valid)──▶ starting
starting ──setupSeats ok──▶ playing     starting ──setup problems──▶ open (problems sent to each seat)
playing ──gameOver──▶ finished          playing ──host abandon / all humans gone past grace──▶ finished
finished ──idle timeout──▶ reaped
```

### Protocol (new `TableClientMessage` / `TableServerMessage` unions in `shared`)

Client to server: `joinTable {inviteCode, displayName, protocolVersion}`,
`claimSeat {seat, deck}`, `leaveSeat`, `setReady {ready}`, `hostSetSeat {seat, controller}`,
`hostKick {seat}`, `hostStart`, `hostReissueSeat {seat}`,
`resumeSeat {seatToken, protocolVersion}`, plus the existing in-game messages
`submitPlayerAction`, `yieldPlayerAbility`, `resumePlayerAbility` and `cancelYield`. The seat
comes from the socket's authenticated seat token, never from the payload.

Server to client: `tableState` (public lobby: seats, display names, bot or human, ready flags,
clock settings, whether the table can start; no deck contents), `seatGranted {seat, seatToken}`,
`deckProblems` (to that seat only), the existing in-game player messages with M2's
presentation, `protocolMismatch` (the client reloads), and `tableClosed`.

The table server never registers `startGame`, `startCardTestScenario`, `jumpToTurn`,
`setPlaybackMode`, `resolveHeldDecision`, `setDebugFlags` or `abandonGame`. They are
unknown messages there.

### Tasks

1. `TableRegistry` with caps: `TABLE_MAX_TABLES` (default 8), `TABLE_MAX_SOCKETS` (64). An open
   table with no sockets for 15 minutes is reaped.
2. Tokens: invite codes of 128 bits in base32; seat and host tokens of 256 bits; compare with
   `crypto.timingSafeEqual`. Tokens live in memory only.
3. Deck claim: reuse `setupSeats` validation for one seat. Report problems through
   `projectSetupProblems` to the claiming socket only.
4. Start: build `seatControllers` from the lobby, create a `MatchSession` with
   `gameMode: 'table'`, and wire `sendToSeat` to that seat's socket (several tabs on one token:
   the latest wins and the previous socket receives `seatTakenOver`).
5. Seed handling: `gameStarted` sent by the table server omits `seed` (make it optional in
   `GameStartedPayload` and update the web store). The post-game unlock sends it.
6. A `tableGame` flag in the session:
   - no debug unlock at game end;
   - the AI-notes release includes only notes from bot seats;
   - `data` is stripped from player-bound legal actions (M2).
7. Request checks: reuse `isAllowedLocalRequest` unchanged (still loopback only in M3).
8. `PROTOCOL_VERSION` constant in `shared`; a mismatch at join or resume returns
   `protocolMismatch`.

### Tests

- `table/table.test.ts`: the state machine above, including a start refused while a deck is
  invalid and a seat freed when a player leaves.
- `table/table-ws.test.ts` with real Bun sockets on an ephemeral port:
  - two clients join, claim P1 and P3, the host bots P2 and P4 and starts; each client receives
    only its own `playerStateSnapshot`;
  - no frame to any client contains the seed, `spectatorState`, `debugEvents`, a `note`, a
    `data` field on a legal action, or another seat's hand object ids (scan raw frames);
  - tester-only message types are refused;
  - a forged seat in a payload is ignored, because the socket's token decides;
  - two tables run at once without cross-talk;
  - a stale protocol version gets `protocolMismatch`.
- `table/tokens.test.ts`: code length and alphabet, mismatched tokens rejected.

### Exit criteria

Two browser windows on one machine can finish a game against two bots. The privacy frame scan
passes.

---

## M4 — Network exposure (needs ADR 0031 accepted)

Goal: friends on a LAN, or over the internet behind a TLS proxy, can join safely.

### Tasks

1. `config.ts`: `TABLE_HOST` (default `127.0.0.1`), `TABLE_PORT`, `TABLE_ALLOWED_ORIGINS`
   (comma-separated exact origins), `TABLE_TRUST_PROXY` (accept `X-Forwarded-For` for rate
   limiting only). Refuse to start if the host is not loopback and the allowlist is empty.
2. `isAllowedTableRequest(request, config)`: check `Origin` against the allowlist and `Host`
   against the configured host names. This prevents DNS rebinding in the same way as
   `isAllowedLocalRequest`.
3. Limits: maximum WebSocket frame size of 256 KiB; maximum deck import of 64 KiB and 250
   lines; 20 messages per second per socket with a burst of 40; 10 socket opens per minute per
   IP; display names of 1–24 characters after NFKC normalization, with control and
   bidirectional-override characters stripped.
4. The invite link format `https://host/table#code=…` keeps the code out of server logs. The
   browser sends it in `joinTable`.
5. Seat tokens are stored in `sessionStorage` under the table id and are never placed in URLs.
6. Documentation: `docs/guides/table-hosting.md` covering LAN (`TABLE_HOST=0.0.0.0` plus an
   allowlist of `http://192.168.x.y:port`), internet (a reverse proxy example with automatic
   TLS, and a warning not to expose `serve`), and what the host can see (everything at game end,
   and server logs).
7. A security review of the table server diff with `/security-review` before merging.

### Tests

- Config refusal cases; origin and host checks (a foreign origin, a rebinding host, a missing
  origin over a non-loopback bind).
- The rate limiter closes a flooding socket with a policy-violation close code, and other tables
  are unaffected.
- Oversized frames and decks are rejected before parsing.
- Display-name normalization table test.

### Exit criteria

A game played across two machines on a LAN. The security review produced no unresolved high
findings.

---

## M5 — Clocks, fallback bots and disconnects

Goal: one slow or absent player cannot stall a table indefinitely.

### Tasks

1. `match/decision-clock.ts`: a per-seat `DecisionClock { perDecisionMs, bankMs }` with the
   presets from the ADR. The clock starts when `playerActionRequired` goes out and stops on an
   accepted submission. Time beyond the per-decision allowance comes out of the bank. The
   server owns the clock; the client only displays `clockState`.
2. `TimedHumanProvider` wraps `HumanDecisionProvider`: it races the human's answer against the
   clock. On expiry it asks the seat's fallback provider (the table's bot kind) to decide the
   same `DecisionRequest` and submits its answer through the same path. A late human answer is
   rejected as a stale revision.
3. Takeover: after three timeouts in a row, or after the disconnect grace period
   (`TABLE_DISCONNECT_GRACE_MS`, 60 s), the seat is marked `fallback`. Decisions go straight
   to the bot and the clock is paused. The player's next `resumeSeat` or accepted action ends
   takeover at the next decision.
4. Decision sources. The engine already logs each decision's exact `submittedResponse` in
   `game_events`, so only who answered is new.
   - Add `game_decision_sources (game_id, request_id, seat, source)` as an additive migration in
     `db/schema.ts`. `source` is `human`, `timeout`, `fallback` or `bot`.
   - Write a row from the runner's `onDecision`.
   - Old games have no rows and are left as they are, with no backfill.
5. Protocol: `clockState {seat, remainingMs, bankMs, running}` (public; it reveals only who is
   deciding, which the table already knows), and `seatStatus {seat, connected, fallback}`.
6. The connection gate on disconnect: it waits only for the grace period, then releases into
   takeover. Other seats' decisions never wait on it.

### Tests

- The clock with fake timers: the bank is drawn down, resets at the next decision, and pauses
  during takeover.
- A timeout chooses a legal action that the engine accepts, and the decision is recorded with
  source `timeout`.
- Replay: take a recorded table game with human, timeout and fallback decisions. Feed each
  `decision` event's `submittedResponse` from `game_events` into a fresh engine with the same
  seed, with no clocks. The resulting event stream must equal the recorded one. This is the
  determinism guarantee from ADR decision 8.
- Disconnecting P1 for longer than the grace period puts P1 into takeover while P2 keeps playing;
  P1 reconnects and gets the board, yield preferences and pending choice back.
- The frame scan stays clean while a seat is in takeover: neither the fallback bot's reasoning
  notes nor the stored `note` field reaches any player.

### Exit criteria

A four-human table where one player closes their laptop mid-game still finishes, and that
player can rejoin.

---

## M6 — Web app: lobby, table play, and the table build

Goal: lobby and table play in the existing Vue app, with tester routes absent from the table
build. New views consume only M2's server-computed fields.

### Tasks

1. A build flag `VITE_APP_MODE=tester|table` (default `tester`). In `table` mode,
   `router.ts` registers only `/` (create or join), `/table` (lobby) and `/table/play`
   (player board). Stats, debug, batch and Card Test Lab are not registered.
2. `stores/table.ts`: lobby state, seat token persistence, reconnect loop with backoff, and the
   `seatTakenOver`, `protocolMismatch` and `tableClosed` handling.
3. `PlayerGameView.vue`: show the display name and a human, bot or fallback badge on each
   opponent panel; a "Waiting on Alice — 0:42" status line driven by `clockState`; the
   player's own clock and bank; a disconnected or bot-controlled marker.
4. Lobby view: seat grid, deck import with private problem list, ready toggle, host controls
   (bot kind per seat, clock preset, kick, reissue token, start), and copying the invite link.
   Whether the table can start comes from `tableState`; the client does not work it out.
5. `scripts/dev.ts`: a `--table` option to run `serve:table` with the table web build.
6. Single-player in the tester build: no visible change beyond M2's fixes.

### Tests

- Unit: `stores/table.test.ts` for token storage, reconnect, and takeover.
- E2E `table-game.spec.ts`: two browser contexts join one table, claim seats, start against two
  bots, each plays a land and passes, one context reloads and resumes, the host abandons, and
  both see the post-game unlock with the seed.
- E2E: the table build has no route to `/debug`, `/stats`, `/batch` or the lab (direct
  navigation 404s or redirects).
- `player-game.spec.ts` still passes in the tester build.
- The client-boundary lint from M2 covers the new views.

### Exit criteria

The player outcome list at the top of this plan works end to end in E2E.

---

## M7 — Hardening and optional follow-ups

Do these on evidence, not by default.

1. **Event-loop isolation.** Measure p95 event-loop lag with 8 tables of 2 humans and 2
   heuristic bots. If it exceeds 100 ms, run each table's `MatchSession` in a Bun Worker, with
   the table server relaying messages. Worker messages reuse the shared protocol types. M2's
   presentation runs in the worker with its session.
2. **Restore after restart.** The engine's `decision` events already record each submitted
   response, so a table can be rebuilt by replaying them into a fresh engine and re-issuing seat
   tokens to the host. This needs a design note on token re-issue and on a decision accepted but
   not yet written when the process died.
3. **Agent client at a table.** Allow `agent-client --table <invite> --name bot1` to claim a
   seat. This enables scripted multi-human soak tests. At a table, it reads M2's presentation,
   because table frames carry no `data`.
4. **Extracting `packages/match`.** Only if a trigger from ADR 0031's Consequences applies.
5. **Spectators.** A separate ADR: spectating a live table needs a delayed public-only
   projection.

---

## Order and sizing

| Milestone                    | Depends on             | Relative size               | Can ship alone                    |
| ---------------------------- | ---------------------- | --------------------------- | --------------------------------- |
| M1 Seat controllers          | —                      | L (mostly mechanical, wide) | Yes (cleaner single-player)       |
| M2 Server presentation       | —                      | L (seven small PRs)         | Yes (fixes the animated-land bug) |
| M3 Table server (loopback)   | M1                     | M                           | Yes (local multi-tab play)        |
| M4 Network exposure          | M3, ADR accepted       | M                           | Yes (LAN play)                    |
| M5 Clocks and fallback       | M3                     | M                           | Yes                               |
| M6 Web lobby and table build | M2, M3 (M5 for clocks) | M                           | —                                 |
| M7 Hardening                 | M6                     | varies                      | per item                          |

M1 and M2 touch different code (the session's seat handling versus the projection and
presentation path) and can run in parallel. The one shared file is `session.ts`: M1 changes its
seat handling and M2 adds hook calls. Land M1's `HumanSeatState` first if both are in flight. M4
and M5 can run in parallel after M3. M6's lobby work can start against M3.

## Delegation notes

Per `CLAUDE.md`:

- **Sonnet `implementer`:**
  - the M1 field-to-map refactor and its test updates, using this plan's M1 task list as the
    checklist;
  - M2's fixture capture, legacy extraction and per-item port, one audit row per task;
  - the `satisfies` annotations at the engine's construction sites.
- **Main thread:**
  - the `LegalActionData` declaration;
  - the face-down allowlist and the projection type fields, since both are in
    `packages/engine`;
  - the privacy frame-scan tests;
  - the M4 security review.
- **Haiku `explorer`:**
  - list every caller of the `MatchSession` methods gaining a `seat` parameter;
  - list every consumer of `GameStartedPayload.seed`;
  - list every `data` key the engine emits, to seed `LegalActionData`.

## Risks

| Risk                                              | Mitigation                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A refactor slip sends one seat's board to another | Frame-scan privacy tests from M1 onward; `sendToSeat` throws on an unknown seat in tests       |
| The seed or an AI note leaks                      | Raw frame scan for the seed string and the `note` key in M3 and M5 tests                       |
| Tester-only messages reachable from a table       | Separate handler that never registers them; refusal test                                       |
| A new projection field leaks on a face-down card  | Allowlist redaction with a key-coverage test (M2 step 1)                                       |
| Moving a calculation changes what players see     | Golden parity from today's client; intentional fixes in separate, documented commits           |
| Typing `data` changes AI prompts or bot behavior  | Type-only `satisfies`; byte-identical prompt test; combat-sweep fixed-seed comparison          |
| Old replays break on missing fields               | Optional fields; `normalizeLegacySnapshot` on load; legacy-snapshot test                       |
| Presentation events reveal hidden objects         | Built from the seat's projection; dropped when the object isn't visible; names never forwarded |
| Client logic creeps back                          | Client-boundary lint test with a reviewed allowlist                                            |
| A stale tab after a server upgrade                | `PROTOCOL_VERSION` check on join and resume                                                    |
| Bot CPU starves other tables                      | Table caps; measurement and the Worker option in M7                                            |
| Timeouts break deterministic replay               | Engine `decision` events already hold exact responses; replay test in M5                       |
| A host exposes `serve` instead of `serve:table`   | `serve` keeps refusing non-loopback; hosting guide warns                                       |
| Deck import as a parsing attack surface           | Size limits before parsing; existing pipeline already rejects unknown cards                    |
