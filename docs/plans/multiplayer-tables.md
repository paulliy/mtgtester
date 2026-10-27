# Multiplayer tables

Decision record: [ADR 0031](../decisions/0031-multiplayer-tables.md). Status: proposed and awaiting
approval. No milestone after M1 starts until ADR 0031 is accepted, because M3 opens a
non-loopback listener ([testing discipline](../guides/testing-discipline.md)).

## Purpose

Let one to four people play one Commander game from their own browsers, with bots in the empty
seats, without weakening the tester. The engine stays authoritative and unchanged, each seat sees
only what its player may see, and the tester's debug and analysis surfaces stay on loopback.

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
- a loopback-default table server with opt-in LAN or internet binding behind an origin allowlist;
- one web app with a table build that hides tester routes.

Out of scope (revisit after M5):

- accounts, friend lists, public matchmaking, ranking;
- live spectators who watch a table (a hidden-information design of its own);
- restoring a live game after a server restart (see M6, optional);
- in-app chat beyond a fixed set of short messages;
- engine changes. If a milestone appears to need one, stop and write it up as a separate ADR.

## Ground rules for every milestone

- `Engine.submit()` with an offered action id remains the only authority. The browser and
  the table server never build legality themselves.
- No live payload carries `spectatorState()`, the seed, AI notes, debug events or another
  seat's private data. Every new message type gets a privacy test before it ships.
- Fixed-seed games with no human seats are bit-for-bit unchanged. Run the existing spectator and
  combat-sweep tests on every milestone.
- Wire types go in `packages/shared/src/protocol.ts`, and every consumer is updated in the same
  change (web store, agent client, tests).
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
   - Replace the `isPlayerGame` checks (about 15 `gameMode === 'singlePlayer'` branches) with
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

## M2 — Table server skeleton on loopback

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
seat only), the existing in-game player messages, and `tableClosed`.

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
7. Request checks: reuse `isAllowedLocalRequest` unchanged (still loopback only in M2).

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

## M3 — Network exposure (needs ADR 0031 accepted)

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

## M4 — Clocks, fallback bots and disconnects

Goal: one slow or absent player cannot stall a table indefinitely.

### Tasks

1. `match/decision-clock.ts`: a per-seat `DecisionClock { perDecisionMs, bankMs }` with the
   presets from the ADR. The clock starts when `playerActionRequired` goes out and stops on an
   accepted submission. Time beyond the per-decision allowance comes out of the bank.
2. `TimedHumanProvider` wraps `HumanDecisionProvider`: it races the human's answer against the
   clock. On expiry it asks the seat's fallback provider (the table's bot kind) to decide the
   same `DecisionRequest` and submits its answer through the same path. A late human answer is
   rejected as a stale revision.
3. Takeover: after three timeouts in a row, or after the disconnect grace period
   (`TABLE_DISCONNECT_GRACE_MS`, 60 s), the seat is marked `fallback`. Decisions go straight
   to the bot and the clock is paused. The player's next `resumeSeat` or accepted action ends
   takeover at the next decision.
4. Decision history. Live games currently store only `game_events` and turn snapshots, so this
   is new. Add a `game_decisions` table
   (`game_id, idx, seat, source, request_json, response_json, request_hash, response_hash,
state_hash_before, state_hash_after`) as an additive migration in `db/schema.ts`. Write rows
   from the runner's `onDecision` for every seat, bots included, using the hashing helpers in
   `benchmark/replay.ts` rather than new ones. `source` is `human`, `timeout`, `fallback` or
   `bot`. Old games have no rows and stay that way, with no backfill.
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
  submitted in order, with no clocks) matches every recorded `state_hash_after` and the final
  `game_events` stream. This is the determinism guarantee from ADR decision 8.
- Disconnecting P1 for longer than the grace period puts P1 into takeover while P2 keeps playing;
  P1 reconnects and gets the board, yield preferences and pending choice back.
- The frame scan stays clean while a seat is in takeover: bot reasoning notes for a human seat
  never go out.

### Exit criteria

A four-human table where one player closes their laptop mid-game still finishes, and that
player can rejoin.

---

## M5 — Web app: lobby, table play, and the table build

Goal: lobby and table play in the existing Vue app, with tester routes absent from the table
build.

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

### Exit criteria

The player outcome list at the top of this plan works end to end in E2E.

---

## M6 — Hardening and optional follow-ups

Do these on evidence, not by default.

1. **Event-loop isolation.** Measure p95 event-loop lag with 8 tables of 2 humans and 2
   heuristic bots. If it exceeds 100 ms, run each table's `MatchSession` in a Bun Worker, with
   the table server relaying messages. Worker messages reuse the shared protocol types.
2. **Restore after restart.** Because M4 records the game as seed plus decisions, a table can
   be rebuilt by replaying recorded decisions into a fresh engine and re-issuing seat tokens to
   the host. This needs a design note on token re-issue and on human actions that were taken
   but not yet recorded.
3. **Agent client at a table.** Allow `agent-client --table <invite> --name bot1` to claim a
   seat. This enables scripted multi-human soak tests.
4. **Extracting `packages/match`.** Only if a trigger from ADR 0031's Consequences applies.
5. **Spectators.** A separate ADR: spectating a live table needs a delayed public-only
   projection.

---

## Order and sizing

| Milestone                    | Depends on                | Relative size               | Can ship alone              |
| ---------------------------- | ------------------------- | --------------------------- | --------------------------- |
| M1 Seat controllers          | —                         | L (mostly mechanical, wide) | Yes (cleaner single-player) |
| M2 Table server (loopback)   | M1                        | M                           | Yes (local multi-tab play)  |
| M3 Network exposure          | M2, ADR accepted          | M                           | Yes (LAN play)              |
| M4 Clocks and fallback       | M2                        | M                           | Yes                         |
| M5 Web lobby and table build | M2 (M4 for clock display) | M                           | —                           |
| M6 Hardening                 | M5                        | varies                      | per item                    |

M3 and M4 can run in parallel after M2. M5's lobby work can start against M2.

## Delegation notes

Per `CLAUDE.md`: the M1 field-to-map refactor and its test updates suit a Sonnet `implementer`
given this plan's M1 task list as the checklist. The privacy frame-scan tests and the M3
security review stay on the main thread. Haiku `explorer` tasks: list every caller of the
`MatchSession` methods gaining a `seat` parameter, and every consumer of `GameStartedPayload.seed`.

## Risks

| Risk                                               | Mitigation                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A refactor slip sends one seat's board to another  | Frame-scan privacy tests from M1 onward; `sendToSeat` throws on an unknown seat in tests |
| The seed leaks through a report, error or log line | A raw frame scan for the seed string in M2 and M4 tests                                  |
| Tester-only messages reachable from a table        | Separate handler that never registers them; refusal test                                 |
| Bot CPU starves other tables                       | Table caps; measurement and the Worker option in M6                                      |
| Timeouts break deterministic replay                | Decisions are recorded with their source; replay test in M4                              |
| A host exposes `serve` instead of `serve:table`    | `serve` keeps refusing non-loopback; hosting guide warns                                 |
| Deck import as a parsing attack surface            | Size limits before parsing; existing pipeline already rejects unknown cards              |
