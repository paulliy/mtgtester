# Multiplayer tables

Decision record: [ADR 0031](../decisions/0031-multiplayer-tables.md). Status: proposed and awaiting
approval. Presentation work is a separate track,
[server-computed presentation](server-computed-presentation.md)
([ADR 0032](../decisions/0032-server-computed-presentation.md)). It runs between M2 and M3.

**Overall order:**

1. M1, then M2. P1 can start alongside M2.
2. P2 to P6.
3. M3, then M4 (clocks), then M5 (network exposure). P7 can run during M3 to M5.
4. M6.

M1, M2 and the presentation track improve the tester on their own and stay on loopback. M3
onward waits for ADR 0031 to be accepted. M5 is the milestone that opens a non-loopback listener
([testing discipline](../guides/testing-discipline.md)).

## Purpose

Let one to four people who know each other play one Commander game from their own browsers,
with bots in the empty seats, without weakening the tester. The engine stays authoritative,
each seat sees only what its player may see, randomness cannot be predicted from a player's
view, and the tester's debug and analysis surfaces stay on loopback.

## Player outcome

A host should be able to:

1. Run `bun run serve:table`, copy the host secret it prints, create a table, and send friends
   the invite link.
2. Approve each player who asks for a seat, choose bots for the other seats, and start.

A guest should be able to:

1. Open the invite link, choose a display name, paste a decklist, and see private deck problems.
2. Play with the same board, controls, smart yield and manual mana as single-player.
3. See whose decision the table is waiting on and how much time they have left.
4. Close the tab or browser and reopen the invite link in the same browser within the disconnect
   budget, then continue from the same pending choice.
5. After the game, see the results, every decklist, the replay and the RNG key.

## Scope and non-goals

In scope:

- one to four human seats, with heuristic or random bots in the rest (LLM bots only with a
  host-configured key);
- invite tables with host approval, seat tokens, display names, and plaintext decklists;
- per-seat projections, ids, logs and errors, behind a deny-by-default disclosure policy;
- a ChaCha20 RNG for table games;
- clocks, fallback bots, reconnects;
- worker isolation, and opt-in LAN or TLS exposure;
- a table web build without tester views.

Out of scope (revisit after M6):

- accounts and public matchmaking (they need a new ADR);
- spectators of a table;
- restoring a live game after a restart;
- chat;
- padded priority stops;
- per-viewer object ids.

Engine rules changes are also out of scope. M2 and M3 add an RNG option, a `yieldCancelled`
event, a step budget and allowlist redaction; none changes how a rule is applied. If a milestone
appears to need a rules change, stop and write a separate ADR.

## Ground rules for every milestone

- `Engine.submit()` with an offered action id remains the only authority.
- **Disclosure goes through the injected `DisclosurePolicy`.** Every mode branch is a `switch`
  ending in `assertNever`.
- **What a live player frame may not carry:**
  - `spectatorState()`;
  - the RNG key;
  - AI notes;
  - debug events;
  - raw error or halt text;
  - another seat's private data;
  - global request ids or event sequences (from M3).

  Each new message type or projection field gets a privacy test.

- **No-human legacy games stay identical.** Their `game_events` streams and AI prompts are
  unchanged. Run the spectator, combat-sweep and `ai/context` tests on every milestone.
- **Wire types go in `packages/shared`.** Every consumer is updated in the same change: the web
  store, `agent-client-core.ts`, and tests.
- **Run what CI runs:** `typecheck`, `typecheck:tests`, `lint`, `format:check`, `test`, the web
  build, and the e2e configs for viewer changes.

---

## M1 — Seat controllers (refactor, single-player unchanged)

### Tasks

1. **Protocol.** Add `SeatControllers` and `'table'` to `GameMode` in `shared/src/protocol.ts`.
   `StartGamePayload` keeps `{ gameMode: 'singlePlayer', humanSeat }`. Update every `GameMode`
   consumer:
   - the web store;
   - stats and recents filtering;
   - `agent-client-core.ts`;
   - the game report.
2. **Session state.** In `match/session.ts`, `seatControllers` and a derived `humanSeats`
   replace `humanSeat`.
   - `HumanSeatState` holds, per human seat:
     - `humanProvider`;
     - `connectionGate`;
     - `ignoredAbilities`;
     - `smartYieldMemory`;
     - `playerRevision`;
     - `lastHumanDecision`.
   - Manual mana is enabled per human seat.
   - Seat-scoped public methods take an explicit `seat`.
3. **Mode branches.** There are about 38 `singlePlayer` checks across `session.ts`,
   `ws/server.ts` and `match/annotations.ts`.
   - Each becomes a `switch` on `GameMode` ending in `assertNever`.
   - The `'table'` case takes the most restrictive choice: no debug, a fixed halt message, no
     raw errors, no other seat's notes, and no seed.
   - Add `assertNever` to `packages/shared`.
4. **Output.** Replace `send` with `sendPublic` and `sendToSeat`, and format a per-seat log for
   each human seat. `GameServer` maps its one human seat to `playerSocket`. Sending to any other
   seat throws in tests.
5. **Strategy coordinator.** It takes `humanSeats: ReadonlySet<PlayerId>` (today a single
   `humanSeat` at `ai/strategy-coordinator.ts:207`) and skips planning for every human seat. The
   session's `onDecision` records human decisions to it for each human seat, when the provider
   kind is `ai`, as it does today for one seat (`session.ts:325`).
6. **Bot waits.** Bots keep waiting on the human's gate in single-player. In `'table'` they wait
   on none.

### Tests

- **Existing tests still pass,** with their assertions unchanged:
  - `match/*.test.ts`;
  - `ws/*.test.ts`;
  - `stores/game.test.ts`;
  - `agent-client-core.test.ts`;
  - `ai/strategy-coordinator.test.ts`.

  Call sites may change to pass an explicit `seat` or a set of human seats.

- **Wire transcript.** Record every `ServerToClientMessage` of a fixed-seed single-player game
  with a scripted human, before and after M1. Normalize the game id, session token and
  timestamps; everything else must match byte for byte.
- **`match/session-multi-human.test.ts`,** in-process with `gameMode: 'table'`:
  - two human seats and two random bots reach a turn cap of 6;
  - each seat's stream holds only its own hand;
  - one seat cannot answer another's request or reuse its revision;
  - no frame carries the seed, debug events or raw halt text;
  - with a mocked AI client, the coordinator skips both human seats.

### Exit

- CI is green.
- No `humanSeat!` assertions remain.
- Every mode branch ends in `assertNever`.

---

## M2 — Hidden information and replay hardening

These fixes also apply to single-player. No network port opens.

### Tasks

1. **`DisclosurePolicy`** (`match/disclosure.ts`). It covers:
   - the public label;
   - debug events;
   - annotations, per seat;
   - raw errors and halts;
   - archetype tags;
   - the full-state replay unlock.

   Every field defaults to deny. `GameServer` builds today's values. M1's restrictive `'table'`
   cases read the policy.

2. **Seed out of player frames.**
   - `PlayerBoardState` omits `seed`; `buildPlayerBoardState` drops it from the spectator
     spread.
   - `gameReport()` and `gameStarted` take the seed from the policy. The tester's policy still
     shows it.
3. **The RNG.** `engine/src/rng/`:
   - An `EngineRng` interface replaces the `Prng` class type in `state/types.ts`.
   - `chacha20.ts` holds all mutable state as plain number properties: key and counter words, a
     `number[]` block, and a position.
   - `GameConfig` gains `rng` (default `legacy`) and `rngKey`. `state/game.ts:166` picks the
     generator.
   - The key is never copied into `EngineState`, events or snapshots. For `chacha20`, `seed` is
     a random label.
   - `clone()` deep-copies the block and position.
   - `bot/src` and `RandomDecisionProvider` take an injected `{ nextInt(n) }` source.
     `MatchSession` builds each bot's source as a domain-separated ChaCha20 stream (nonce = seat
     index plus a purpose byte) for `chacha20` games, and as today's seed string for `legacy`.
   - **Tests:**
     - the RFC 8439 section 2.4.2 vectors;
     - determinism given a key;
     - a casting-checkpoint rewind restores the stream exactly;
     - `clone()` independence;
     - legacy streams unchanged for existing seeds;
     - a `chacha20` game's events and snapshots contain no key bytes.
4. **Allowlist redaction** (`view/spectator.ts`):
   - face-down permanents and exile cards are built field by field;
   - `moveObject` sets a `faceDown` flag on exile objects moved face down;
   - the player-log filter uses `satisfies Record<DecisionType, boolean>`;
   - the `engineHalt` line shows a fixed text to players;
   - a coverage test builds each projected type with every key and fails on an unclassified key.
5. **Commanders, yields and tags.**
   - A viewer-aware commander view returns `zone: 'hidden'` and `objectId: null` to non-owners
     for a commander in a hand or library.
   - `yieldingUntilEndOfTurn` goes only to its own seat.
   - `archetypeTag` for human seats goes only to that seat.
6. **Replay inputs.**
   - `Engine.cancelYield` emits `yieldCancelled { player }` only when it changes state.
   - The `games` row gains `config_json` and `build_commit` plus `build_dirty` (from
     `readBuildInfo`, which may be null outside git).
   - A new `game_decision_sources (game_id, request_id, seat, source)` table records attribution.
   - The session tags each response's source before `onDecision`. The smart-yield pass is
     `auto`.
   - All of this goes through the existing `MIGRATIONS_SQL` list and `CREATE TABLE IF NOT EXISTS`.
7. **Replay harness** (test-only, `match/replay-from-log.test.ts`).
   - Build an engine from `config_json`.
   - Feed it each `decision` event's `submittedResponse` in order, and apply each `yieldCancelled`
     when the engine's next event sequence equals the event's.
   - Fail loudly on a request id or sequence mismatch.
   - Compare the final state hash using the benchmark replay hashing.
   - Replay ends at the last recorded event.
8. **Docs.** Amend `docs/guides/rules-engine-constraints.md` (the timing line, per ADR 0031
   decision 8) and `docs/decisions/0030-manual-mana-activation.md` (add an "Amended by 0031"
   line).

### Tests

- Each task's tests above.
- **Frame scan** (`ws/player-frame-privacy.test.ts`) of every frame of a scripted single-player
  game. It fails on:
  - another seat's hand ids;
  - another seat's commander in a hand or library zone;
  - another seat's yield flag;
  - a human seat's archetype tag sent to someone else;
  - a `note` key;
  - raw halt text.
- **Replay** of a single-player game with a cancelled yield and manual mana.

### Exit

- CI is green.
- Single-player differs from M1 only in the documented privacy fixes.
- No-human legacy event streams are unchanged.

---

## M3 — Table server on loopback, with scripted clients

### Layout

```
packages/server/src/table/
  registry.ts     tables by random id; caps; reaping
  table.ts        lobby state machine; seats; approvals; owns one MatchSession
  tokens.ts       host secret, host tokens, invite codes, seat tokens; constant-time compare; throttling
  wire-ids.ts     per-seat request ids and per-viewer log sequences
  table-ws.ts     table message set only
  table-http.ts   create table (host secret); summary (invite required)
  config.ts       TABLE_* settings
packages/server/src/cli/serve-table.ts   (--oracle-fixture supported, as serve)
```

### Lobby state machine

```
open ──requestSeat──▶ open (pending approval)
open ──hostApprove / hostDeny / leaveSeat / hostSetSeat / hostKick──▶ open
open ──hostStart (≥1 human, every seat human or bot, every deck valid)──▶ starting
starting ──setup ok──▶ playing        starting ──setup problems──▶ open (each seat told privately)
playing ──game over / hostAbandon / game cap / every human gone past budget──▶ finished
finished ──idle timeout──▶ reaped
```

Requests, approvals, kicks and seat changes are refused outside `open`.

### Protocol (`shared/src/table-protocol.ts`)

- **Client to server.**
  - From anyone holding the invite:
    - `joinTable {inviteCode, displayName, protocolVersion, capabilities}`;
    - `requestSeat {seat, decklist}`;
    - `leaveSeat`.
  - From a seat-token holder:
    - `resumeSeat {seatToken, protocolVersion, capabilities}`;
    - `resumeControl`;
    - the existing in-game messages.
  - From the host-token holder, after `hostAuth {hostToken}`:
    - `hostApprove {seat}`, `hostDeny {seat}`;
    - `hostSetSeat {seat, controller}`, `hostKick {seat}`;
    - `hostStart`, `hostAbandon`.
- **Server to client:**
  - `tableState`: seats, display names, pending requests (host only), human or bot, clock, and
    whether the table can start;
  - `seatGranted {seat, seatToken}`;
  - `deckProblems`, to that seat only;
  - the in-game player messages;
  - `seatTakenOver`, `protocolMismatch` and `tableClosed`.

The table server never registers the tester's messages.

### Tasks

1. **Registry and tokens.**
   - The host secret is printed at startup.
   - Host tokens and seat tokens are 256 bits, and invite codes are 128 bits.
   - Failed attempts are throttled per client address.
   - Table ids are random.
   - Display names must be unique within a table.
2. **Claims.**
   - Parse the plaintext decklist into the table database under table-scoped ids, and remove
     denied or unclaimed decks.
   - Claims are rate-limited per socket.
   - Report problems with `projectSetupProblems`.
3. **Start.**
   - Build `seatControllers`, the table `DisclosurePolicy`, and the `chacha20` config with a
     fresh key.
   - Close joining.
   - `TABLE_TEST_RNG_KEY` is accepted only on a loopback bind, so e2e hands are reproducible.
4. **`wire-ids.ts`.** Per-seat request ids, mapped back on submit, and per-viewer log sequences
   on every table frame.
5. **Engine step budget.** Add `EngineConfig.maxStepWork`, a cap on forced resolutions and events
   in one `advance()`. Exceeding it halts the game through the existing `engineHalt` path, with a
   fixed message to players. Default: unlimited for the tester, set for tables.
6. **`PROTOCOL_VERSION`** in `shared`.
7. **Request checks.** Use the loopback-only `isAllowedLocalRequest`.
8. **Module-graph test** for `cli/serve-table.ts`.
   - Run `bun build --metafile` on the entry.
   - Fail on `batch/`, `benchmark/` (beyond listed type-only contracts) or any
     `createCardTestScenario` module.
   - Add `no-restricted-imports` for `table/**`.
   - Confirm `--metafile` on the CI-pinned Bun version first.
9. **Agent client table mode.** Add `agent-client --table <url> --invite <code> --name <n>`,
   with `--policy first-legal`. It sends the `rawActionData` capability (P6) and re-sends it on
   resume. Loopback only in M3.

### Tests

- **`table/table.test.ts`.** The state machine, including approvals and refusals outside `open`.
- **`table/table-ws.test.ts`**, with two scripted agent clients and two bots on an ephemeral port,
  using the fixture oracle and a test key.
  - Frame scan of every frame. It fails on:
    - the key;
    - `spectatorState`;
    - debug events;
    - `note`;
    - raw halt text;
    - `data` to a socket without the capability;
    - other seats' hand ids;
    - other seats' commander zones and yield flags;
    - global request ids or sequences.
  - Tester messages are refused, and a forged seat in a payload is ignored.
  - Two tables run concurrently without cross-talk.
  - A stale protocol version gets `protocolMismatch`.
  - A takeover notifies the first socket, which does not reconnect.
  - Host messages without `hostAuth` are refused.
  - An unapproved client cannot take a seat.
- **`table/tokens.test.ts`**, `wire-ids.test.ts`, and an engine step-budget test with a
  forced-trigger loop fixture.

### Exit

Two scripted clients and two bots finish a game on loopback, and the frame scan is clean.

---

## M4 — Clocks, fallback bots and disconnects

### Tasks

1. **`match/decision-clock.ts`,** with an injected `now()` and timer.
   - Free 10-second allowance per decision.
   - Bank: 10 minutes relaxed, 5 standard.
   - 60-second disconnect grace, charged to a 5-minute budget per seat.
   - Game cap: 3 hours relaxed, 2 hours standard, after which the game is a draw for every player
     still in it.
   - `off` is allowed only on loopback.
2. **`TimedHumanProvider`.** On expiry:
   1. bump the seat's revision;
   2. ask the heuristic bot with `activateManaAbility` options filtered out, the same way the
      smart-yield filter in `sendPlayerActionRequired` removes options while keeping ids;
   3. strip `note`;
   4. submit with source `timeout`.
3. **Takeover.** After three timeouts in a row, or once grace ends, the seat plays as `fallback`
   until its player sends `resumeControl`.
4. **Protocol.**
   - `clockState {seat, remainingMs, bankMs, running}` goes to seat-bound sockets.
   - `seatStatus {seat, connected, fallback}`.

### Tests

- **Clock** behavior with the injected clock.
- **Late answers.** A late human answer is stale.
- **Manual mana.** The fallback bot on a manual-mana seat never taps a source by hand.
- **Replay.** The M2 harness replays a game that has `human`, `auto`, `timeout` and `fallback`
  sources.
- **Disconnect.** P1 disconnects past grace and goes to fallback while P2 plays on. P1 resumes,
  sends `resumeControl`, and gets the next decision.
- **Bots never get clocks.** Spectator and bot-only games construct no clock or fallback.

### Exit

Four scripted clients, one of which disconnects and rejoins, finish a game.

---

## M5 — Network exposure (needs ADR 0031 accepted)

### Tasks

1. **Worker per table.**
   - Each table's `MatchSession` runs in a Bun Worker, and the table server relays shared-protocol
     messages.
   - The worker sends a heartbeat every second. A worker that misses three is `terminate()`d and
     the table ends with a fixed message.
   - This is required before any non-loopback bind.
2. **Config.**
   - `TABLE_HOST`;
   - `TABLE_ALLOWED_ORIGINS` and `TABLE_ALLOWED_HOSTS`;
   - TLS (certificate paths, or `TABLE_BEHIND_TLS_PROXY` together with a trusted
     forwarded-for setting);
   - `--insecure-lan`.

   The server refuses a non-loopback bind without the allowlists, and without TLS unless
   `--insecure-lan` is set.

3. **Limits.**
   - `maxPayloadLength` of 256 KiB in the `Bun.serve` websocket config;
   - a pre-authentication timeout of 10 seconds;
   - a 64 KiB, 250-line decklist;
   - 20 messages per second per socket;
   - concurrent sockets and opens per client address;
   - takeover rate limits.
4. **Display names.** 1–24 characters, trimmed, with control and bidirectional-override
   characters removed.
5. **The `--insecure-lan` banner** is sent to every player in `tableState`.
6. **Agent client.** Accepts `wss:` table URLs, and `ws:` LAN URLs only with `--insecure-lan`.
7. **Docs.**
   - `docs/guides/table-hosting.md` covers LAN, TLS behind a proxy, what the host sees, and the
     trust assumptions, and warns never to expose `serve`.
   - `testing-discipline.md`'s loopback line points to ADR 0031 for the table server.
8. **Review.** Run `/security-review` on the diff and write the checklist and its findings to
   `docs/reviews/table-server-security-<date>.md`.

### Tests

- Config refusal cases.
- Origin and host checks.
- The pre-authentication timeout.
- Rate-limit closes the socket.
- Oversize frames and decks are rejected.
- The display-name table.
- **Worker:** a hung worker is terminated and the other tables keep running.
- **In-process TLS:** a test starts a local TLS proxy (self-signed certificate) in front of the
  table server, and two scripted clients finish a game through it.

### Exit

- The in-process TLS test passes.
- A manual LAN game with `--insecure-lan` is recorded in the review document.
- The review document lists no unresolved high findings.

---

## M6 — Web: lobby, table play, table build, CI

### Tasks

1. **Router split.** `router.ts` imports every view statically today. Change to lazy imports. A
   `VITE_APP_MODE=table` entry registers:
   - create, join, lobby;
   - the player board;
   - a table post-game view, which reuses `GameView`'s replay in read-only mode after
     `replayUnlocked`.

   A test reads the build manifest and fails if the table bundle contains `StatsView`,
   `DebugView`, the batch views or `CardTestLabView`.

2. **Store adapter.** `PlayerGameView.vue` uses `useGameStore` throughout. `stores/table.ts`
   feeds table messages into the game store's existing `handle()`, so the player board works
   unchanged. It also owns the lobby state and the seat token:
   - the token lives in `localStorage` by table id and is cleared at `tableClosed`;
   - it reconnects with backoff, but never after `seatTakenOver`;
   - it handles `protocolMismatch` and sends `resumeControl`.
3. **Player board additions.**
   - Display names and human, bot or fallback badges.
   - "Waiting on Alice — 0:42" from `clockState`.
   - Your own clock and bank.
   - A "Take back control" button.
   - The `--insecure-lan` banner.
4. **Lobby.**
   - Seat grid and decklist paste with private problems.
   - Host approval queue.
   - Bot kind per seat, clock preset, kick, start and abandon.
   - Copy the invite link.
5. **Dev and CI.**
   - `scripts/dev.ts --table`.
   - `playwright.table.config.ts`, with its own server and web ports, `TABLE_TEST_RNG_KEY`, and
     the committed Oracle fixture.
   - A `table-e2e` job in `.github/workflows/ci.yml`, alongside the viewer job. It uses the same
     `changes` and `full` gating and the same trace check, and its spec patterns are added to the
     existing configs' `testIgnore`.
   - Making it a required check is a repository setting the owner changes.
6. **Docs.** Update `current-state.md`, `json-agent-client.md` (table mode, capabilities) and
   `project-commands.md`.

### Tests

- `stores/table.test.ts`.
- E2E `table-game.spec.ts`, with a fixed test key:
  - two browser contexts join and the host approves;
  - start against two bots;
  - each plays a land and passes;
  - one closes and reopens, then resumes;
  - the host abandons;
  - both see the post-game view with the key.
- The bundle-manifest test.
- `player-game.spec.ts` still passes in the tester build.

### Exit

The player outcome list works end to end in `table-e2e`.

---

## M7 — Follow-ups, on evidence

1. **Restore after restart,** on the same build, from M2's stored inputs. It needs a design note
   on token re-issue.
2. **Padded priority stops.**
3. **Per-viewer object ids.**
4. **Spectators,** which need a separate ADR.

---

## Order and sizing

| Milestone                 | Depends on                      | Size | Ships alone                          |
| ------------------------- | ------------------------------- | ---- | ------------------------------------ |
| M1 Seat controllers       | —                               | L    | Yes (refactor)                       |
| M2 Hidden info and replay | M1                              | M    | Yes (single-player privacy fixes)    |
| P1–P6 Presentation        | P2 after M2 task 4; P4 after M1 | M    | Yes (animated-land fix, thin client) |
| M3 Table server, loopback | M2, P6, ADR 0031 accepted       | M    | Yes (scripted local tables)          |
| M4 Clocks and fallback    | M3                              | M    | Yes                                  |
| M5 Network exposure       | M4                              | M    | Yes (LAN or TLS, scripted clients)   |
| M6 Web and CI             | M5, P7                          | M    | —                                    |
| M7 Follow-ups             | M6                              | —    | per item                             |

Files both tracks touch, and who goes first:

| File                   | First                              | Then        |
| ---------------------- | ---------------------------------- | ----------- |
| `match/session.ts`     | M1                                 | P4, then P6 |
| `view/spectator.ts`    | M2 tasks 4–5                       | P2          |
| `agent-client-core.ts` | P6                                 | M3 task 9   |
| `eslint.config.js`     | P6 and M3 task 8 (separate blocks) | —           |

## Delegation notes

Per `CLAUDE.md`:

- **Sonnet `implementer`:**
  - M1 tasks 1, 2 and 4;
  - M3 registry, tokens and agent-client table mode;
  - M6 lobby, store adapter and Playwright config.
- **Main thread:**
  - M1 task 3 (every mode branch is a disclosure decision);
  - all of M2;
  - M3 tasks 4 and 5;
  - M5's worker and security review;
  - every frame-scan test.
- **Haiku `explorer`:**
  - list `GameMode` consumers;
  - list every `seed` read in `packages/server` and `apps/web`;
  - list every `createCardTestScenario` module.

## Risks

| Risk                              | Mitigation                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| A mode branch leaks in table mode | `assertNever` switches with restrictive `'table'` cases (M1); policy (M2); scans    |
| Predictable randomness            | ChaCha20 key outside state; per-seat bot streams; fail-closed config (M2, M3)       |
| Activity leaks through counters   | Per-seat request ids and per-viewer sequences (M3); object ids are an accepted risk |
| A new projection field leaks      | Allowlist redaction with coverage test (M2)                                         |
| Replay drifts                     | Stored config and build, `yieldCancelled`, replay harness (M2, M4)                  |
| The host takes a seat             | No token reissue; host approval and changes only in `open` (M3)                     |
| One client fills every seat       | Host approval of each claim (M3)                                                    |
| Token sniffing on a LAN           | TLS by default; `--insecure-lan` banner; takeover notice (M3, M5)                   |
| A runaway step freezes the server | Engine step budget (M3); worker per table, terminated on missed heartbeats (M5)     |
| Stalling                          | Allowance, bank, disconnect budget, game cap (M4)                                   |
| Fallback bot misplays manual mana | Mana activations filtered from its menu (M4)                                        |
| Tester views in the table bundle  | Lazy router and bundle-manifest test (M6)                                           |
| Flaky table e2e                   | Fixed test key on loopback; fixture oracle (M3, M6)                                 |
