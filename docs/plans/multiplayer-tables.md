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
- rules changes in the engine. M2 adds typed descriptive presentation fields to engine output,
  which is not a rules change. If a milestone appears to need a rules change, stop and write a
  separate ADR.

## Ground rules for every milestone

- `Engine.submit()` with an offered action id remains the only authority. The browser and
  the table server never build legality themselves.
- **The server computes; the client renders** (ADR 0031 decision 12). Once a calculation has
  moved to the server under M2, a new client feature may not bring it back. The client-boundary
  lint test from M2 enforces this.
- No live payload carries `spectatorState()`, the seed, AI notes, debug events or another
  seat's private data. Every new message type gets a privacy test before it ships.
- Fixed-seed games with no human seats are bit-for-bit unchanged. Run the existing spectator and
  combat-sweep tests on every milestone.
- AI prompts are unchanged. Presentation data never enters `server/src/ai/context.ts`.
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

Goal: the browser only lays out, animates, and collects input. Every value it shows that
comes from rules or engine data is computed on the server, typed, and projected per seat.

Why this matters for multiplayer:

- **Clients must agree.** With several players, two browsers deriving the same fact separately
  can disagree. The current views already do (item 1 below).
- **Every client would repeat the work.** The web app, the JSON agent client and any later
  client would each have to reimplement these derivations.
- **Text parsing fails silently.** A changed engine string or a renamed `data` key drops a cost
  from a confirm dialog without any test failing.
- **Rules knowledge belongs with the rules.** A client-side constant such as 21 commander
  damage is a second copy of a rule.

### Client boundary (ADR 0031 decision 12)

The client may lay out the board, animate, remember unsent input, and keep display preferences.
It may not:

- parse engine text (prompts, log lines, action descriptions);
- read `LegalAction.data`;
- classify cards from `typeLine`;
- hold rules constants;
- infer game events by comparing one board snapshot with the next.

### Audit of current client calculations

| #   | Today                                                                                                                                                    | Problem                                                                                                                                                                     | Server-side replacement                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `PlayerGameView.vue:129` `isPiledLand` (regex); `SeatPanel.vue:62` `typeLine.includes('Land')`; `lib/card.ts:2` `isTokenTypeLine`; `lib/tokenArt.ts:40`  | The two views disagree: a land creature (Dryad Arbor) is in the lands pile in the spectator seat panel and on the battlefield in the player board. Type checks by substring | `types`, `supertypes`, `subtypes` arrays and a required `isToken` on every presented card and permanent, plus a `boardGroup` (`lands`, `creatures`, `other`) chosen by one server function |
| 2   | `PlayerGameView.vue:1064` `actionCost`, `:1105` `pendingSummary`; `lib/actionLabels.ts` (cast-variant labels, enters-tapped notes, optional-cost labels) | Reads untyped `LegalAction.data`                                                                                                                                            | `ActionPresentation.label`, `costLabels`, `entryNote`                                                                                                                                      |
| 3   | `PlayerGameView.vue:491` X-value grouping by `data.x` and `data.modeLabel`                                                                               | Same                                                                                                                                                                        | `ActionPresentation.xFamily` (`key`, `x`) and `DecisionPresentation.xFamilies` (`key`, `min`, `max`, action ids by X)                                                                      |
| 4   | `PlayerGameView.vue:1178-1198` payment sources from `data.paymentSourceIds` and `data.paymentSourceNames`                                                | Same                                                                                                                                                                        | `ActionPresentation.payment` (`sourceIds`, `summary`)                                                                                                                                      |
| 5   | `PlayerGameView.vue:591` playable-source ranking; `:1142` `isLegalTarget` scanning every legal action on each hover                                      | An index of the menu rebuilt in the browser                                                                                                                                 | `DecisionPresentation.sources`, keyed by object id: `verb`, `actionIds`, `targetIds`. Built once per decision                                                                              |
| 6   | `lib/turnLabels.ts:38` `playerFacingPrompt` rewrites the engine prompt with a regex                                                                      | Breaks when prompt wording changes                                                                                                                                          | `DecisionPresentation.prompt`, the player-facing string. The engine's `prompt` stays as it is for the AI                                                                                   |
| 7   | `PlayerGameView.vue:182` finds the game-over line by matching log text                                                                                   | Text matching                                                                                                                                                               | A `summary` string on the `gameOver` payload                                                                                                                                               |
| 8   | `CommanderDamageGrid.vue:17` `LETHAL = 21`                                                                                                               | A rules constant in the client                                                                                                                                              | Per cell: `amount`, `lethal`, `remaining`                                                                                                                                                  |
| 9   | `composables/useCombatStrikes.ts`, `useLifeFlash.ts`, `useBoardFlash.ts` infer hits and life changes by diffing snapshots                                | Its own comment admits misattribution (non-combat damage to an attacker, trample)                                                                                           | Per-seat `presentationEvents` (`damage`, `lifeChange`, `counterChange`) derived on the server from engine events, filtered by the same visibility projection as the player log             |
| 10  | `PlayerGameView.vue:644` `needsLandReminder`                                                                                                             | Decides whether to interrupt the player. Under a decision clock (M5), a client-side prompt can cost clock time that the server's auto-pass logic does not know about        | A per-seat server preference next to smart yield, so the reminder and automatic passing agree                                                                                              |

Stays in the client: visual stacking of identical permanents (`lib/stackPermanents.ts`, which
uses server fields only), widths and column layout, grouping of already-projected log lines by
seat, the phase and step name lookup in `turnPositionLabel`, confirmation preferences
(`confirmRoutineActions`), and reduced motion.

### Where the code goes

- **Engine** (`packages/engine`): typed descriptive facts only, added to the existing
  producers. `actions/legal.ts` already builds `DecisionPresentation`; cost components, X value,
  cast variant and the payment plan move from `data` into typed presentation fields. The view
  projections (`view/`) add card type arrays and a required `isToken`. No rules logic and no
  new player-facing strings. AI prompts are unaffected, because `presentation` is never sent to
  the AI (existing rule in `shared/src/engine.ts`).
- **Server** (`packages/server/src/match/presentation.ts`, new): pure per-seat functions that
  compose labels, cost labels, X families, the source index, the player-facing prompt,
  commander-damage cells and presentation events. The session calls it just before
  `playerActionRequired` and `playerStateSnapshot` go out.
- **Shared**: the new types in `shared/src/engine.ts` and `shared/src/view.ts`.
- **Web**: render the fields and delete the derivations.

### Approach: move, don't rewrite

For each audit item:

1. Port the client function to the server verbatim.
2. Add a parity test showing the server output matches the old client function for every
   decision in a fixed-seed single-player game.
3. Point the client at the new field.
4. Delete the client copy.

Intentional behavior fixes, such as item 1's land-creature placement, land in a separate commit
after parity, with their own test.

### Order

1. **Item 1, card types.** Small, and fixes a visible inconsistency. Decide where land
   creatures go; default: with creatures, as the player board does today, because they can
   attack and block.
2. **Items 2–5, action presentation.** The largest piece.
3. **Items 6–8,** prompt, game-over summary and commander damage.
4. **Item 10,** the land reminder moves to the server.
5. **Item 9,** presentation events. Coordinate with the Phase 8 animation work
   (`docs/plans/phase-8-action-animations.md`).
6. **Close the boundary.**
   - Stop sending `LegalAction.data` to player sockets, by stripping it in the server's player
     projection. The AI path keeps it.
   - Add `apps/web/src/client-boundary-lint.test.ts`, modeled on
     `packages/engine/tests/casting-boundary-lint.test.ts`. It fails on reads of
     `LegalAction.data`, `typeLine` substring or regex checks, regex matching on log or prompt
     text, and listed rules constants, with an allowlist file for reviewed exceptions.

### Tests

- `match/presentation.test.ts`: unit tests for each function, using fixtures from existing card
  tests (a painland's cost labels, an X spell's family, a commander-tax cast, Dryad Arbor's board
  group, a partner commander-damage cell).
- Parity tests as described above, one per item, deleted after the client copy is removed.
- AI prompt unchanged: the existing `ai/context.test.ts` passes, plus one assertion that no
  presentation field appears in a built prompt.
- Privacy: `presentationEvents` and `sources` pass the raw-frame scan. A presentation event
  about a hidden object, such as damage to a face-down creature, carries only what the player
  log would show.
- Player frames no longer contain `data` on legal actions.
- `test:e2e` `player-game.spec.ts` and the Card Test Lab spec pass.

### Exit criteria

The client-boundary lint passes with an empty allowlist, or with each remaining exception
reviewed. CI is green. The web bundle no longer imports `lib/actionLabels.ts` or
`lib/card.ts`.

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

Client to server: `joinTable {inviteCode, displayName}`, `claimSeat {seat, deck}`,
`leaveSeat`, `setReady {ready}`, `hostSetSeat {seat, controller}`, `hostKick {seat}`,
`hostStart`, `hostReissueSeat {seat}`, `resumeSeat {seatToken}`, plus the existing in-game
messages `submitPlayerAction`, `yieldPlayerAbility`, `resumePlayerAbility` and `cancelYield`.
The seat comes from the socket's authenticated seat token, never from the payload.

Server to client: `tableState` (public lobby: seats, display names, bot or human, ready flags,
clock settings; no deck contents), `seatGranted {seat, seatToken}`, `deckProblems` (to that
seat only), the existing in-game player messages with M2's presentation, and `tableClosed`.

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
6. A `tableGame` flag in the session: no debug unlock at game end, and the AI-notes release
   includes only notes from bot seats.
7. Request checks: reuse `isAllowedLocalRequest` unchanged (still loopback only in M3).

### Tests

- `table/table.test.ts`: the state machine above, including a start refused while a deck is
  invalid and a seat freed when a player leaves.
- `table/table-ws.test.ts` with real Bun sockets on an ephemeral port:
  - two clients join, claim P1 and P3, the host bots P2 and P4 and starts; each client receives
    only its own `playerStateSnapshot`;
  - no frame to any client contains `seed`, `spectatorState`, `debugEvents` or another seat's
    hand object ids (scan raw frames);
  - tester-only message types are refused;
  - a forged seat in a payload is ignored, because the socket's token decides;
  - two tables run at once without cross-talk.
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
4. Decision history. Live games currently store only `game_events` and turn snapshots, so this
   is new. Add a `game_decisions` table as an additive migration in `db/schema.ts`, with these
   columns: game id, index, seat, source, request JSON, response JSON, request hash, response
   hash, state hash before, state hash after. Write rows from the runner's `onDecision` for every
   seat, bots included, using the hashing helpers in `benchmark/replay.ts` rather than new ones.
   `source` is `human`, `timeout`, `fallback` or `bot`. Old games have no rows and stay that way,
   with no backfill.
5. Protocol: `clockState {seat, remainingMs, bankMs, running}` (public; it reveals only who is
   deciding, which the table already knows), and `seatStatus {seat, connected, fallback}`.
6. The connection gate on disconnect: it waits only for the grace period, then releases into
   takeover. Other seats' decisions never wait on it.

### Tests

- The clock with fake timers: the bank is drawn down, resets at the next decision, and pauses
  during takeover.
- A timeout chooses a legal action that the engine accepts, and the decision is recorded with
  source `timeout`.
- Replaying a recorded table game (a fresh engine with the seed and `game_decisions` rows
  submitted in order, with no clocks) matches every recorded state hash and the final
  `game_events` stream. This is the determinism guarantee from ADR decision 8.
- Disconnecting P1 for longer than the grace period puts P1 into takeover while P2 keeps playing;
  P1 reconnects and gets the board, yield preferences and pending choice back.
- The frame scan stays clean while a seat is in takeover: bot reasoning notes for a human seat
  never go out.

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
   `seatTakenOver` and `tableClosed` handling.
3. `PlayerGameView.vue`: show the display name and a human, bot or fallback badge on each
   opponent panel; a "Waiting on Alice — 0:42" status line driven by `clockState`; the
   player's own clock and bank; a disconnected or bot-controlled marker.
4. Lobby view: seat grid, deck import with private problem list, ready toggle, host controls
   (bot kind per seat, clock preset, kick, reissue token, start), and copying the invite link.
   Lobby readiness (every seat filled, decks valid, can start) comes from `tableState`; the
   client does not work it out.
5. `scripts/dev.ts`: a `--table` option to run `serve:table` with the table web build.
6. Single-player in the tester build: no visible change.

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
   presentation work runs in the worker with its session.
2. **Restore after restart.** Because M5 records the game as seed plus decisions, a table can
   be rebuilt by replaying recorded decisions into a fresh engine and re-issuing seat tokens to
   the host. This needs a design note on token re-issue and on human actions that were taken
   but not yet recorded.
3. **Agent client at a table.** Allow `agent-client --table <invite> --name bot1` to claim a
   seat. This enables scripted multi-human soak tests. The agent client can read M2's
   presentation instead of action descriptions.
4. **Extracting `packages/match`.** Only if a trigger from ADR 0031's Consequences applies.
5. **Spectators.** A separate ADR: spectating a live table needs a delayed public-only
   projection.

---

## Order and sizing

| Milestone                    | Depends on             | Relative size               | Can ship alone                         |
| ---------------------------- | ---------------------- | --------------------------- | -------------------------------------- |
| M1 Seat controllers          | —                      | L (mostly mechanical, wide) | Yes (cleaner single-player)            |
| M2 Server presentation       | —                      | L (many small moves)        | Yes (fixes view inconsistencies today) |
| M3 Table server (loopback)   | M1                     | M                           | Yes (local multi-tab play)             |
| M4 Network exposure          | M3, ADR accepted       | M                           | Yes (LAN play)                         |
| M5 Clocks and fallback       | M3                     | M                           | Yes                                    |
| M6 Web lobby and table build | M2, M3 (M5 for clocks) | M                           | —                                      |
| M7 Hardening                 | M6                     | varies                      | per item                               |

M1 and M2 touch different code (the session's seat handling versus the presentation path) and
can run in parallel. M4 and M5 can run in parallel after M3. M6's lobby work can start against
M3.

## Delegation notes

Per `CLAUDE.md`:

- **Sonnet `implementer`:**
  - the M1 field-to-map refactor and its test updates, using this plan's M1 task list as the
    checklist;
  - M2's port-and-parity steps, one audit item per task, with that row of the audit table as the
    brief.
- **Main thread:**
  - deciding M2's typed engine fields, since they are in `packages/engine`;
  - the privacy frame-scan tests;
  - the M4 security review.
- **Haiku `explorer`:**
  - list every caller of the `MatchSession` methods gaining a `seat` parameter;
  - list every consumer of `GameStartedPayload.seed`;
  - list every `LegalAction.data` key the web app reads.

## Risks

| Risk                                               | Mitigation                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A refactor slip sends one seat's board to another  | Frame-scan privacy tests from M1 onward; `sendToSeat` throws on an unknown seat in tests                        |
| The seed leaks through a report, error or log line | A raw frame scan for the seed string in M3 and M5 tests                                                         |
| Tester-only messages reachable from a table        | Separate handler that never registers them; refusal test                                                        |
| Moving a calculation changes what players see      | Move-don't-rewrite with parity tests; intentional fixes in separate commits                                     |
| Presentation leaks hidden information              | Presentation is built per seat from the player projection, never from `GameState`; frame scan covers its fields |
| Presentation bloats AI prompts                     | It stays in `presentation`, which never reaches the AI; `ai/context.test.ts` assertion                          |
| Client logic creeps back                           | Client-boundary lint test with a reviewed allowlist                                                             |
| Bot CPU starves other tables                       | Table caps; measurement and the Worker option in M7                                                             |
| Timeouts break deterministic replay                | Decisions are recorded with their source; replay test in M5                                                     |
| A host exposes `serve` instead of `serve:table`    | `serve` keeps refusing non-loopback; hosting guide warns                                                        |
| Deck import as a parsing attack surface            | Size limits before parsing; existing pipeline already rejects unknown cards                                     |
