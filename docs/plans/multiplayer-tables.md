# Multiplayer tables

Decision record: [ADR 0031](../decisions/0031-multiplayer-tables.md). Status: proposed and awaiting
approval. Presentation work is a separate track:
[server-computed presentation](server-computed-presentation.md)
([ADR 0032](../decisions/0032-server-computed-presentation.md)).

M1 and M2 improve the tester on their own, stay on loopback, and can start now. M3 onward waits
for ADR 0031 to be accepted. M4 is the milestone that opens a non-loopback listener
([testing discipline](../guides/testing-discipline.md)).

## Purpose

Let one to four people who know each other play one Commander game from their own browsers,
with bots in the empty seats, without weakening the tester. The engine stays authoritative,
each seat sees only what its player may see, randomness cannot be predicted from a player's own
view, and the tester's debug and analysis surfaces stay on loopback.

## Player outcome

A host should be able to:

1. Run `bun run serve:table`, copy the host secret it prints, create a table, and send friends
   an invite link.
2. See who has joined and which seats are bots, then start the game.

A guest should be able to:

1. Open the invite link, choose a display name, paste a decklist, and get a clear private
   message if the deck has unmodeled cards.
2. Play with the same board, controls, smart yield and manual mana as single-player.
3. See whose decision the table is waiting on and how much time they have left.
4. Close the tab or browser, reopen the invite link on the same browser within the disconnect
   budget, and continue from the same pending choice.
5. Once the game ends, see the replay, every decklist and the RNG key.

## Scope and non-goals

In scope:

- one to four human seats, with heuristic or random bots in the rest (LLM bots only with a
  host-configured key);
- invite tables with a host secret, seat tokens, display names, and plaintext deck import;
- per-seat projections, logs and errors, behind a deny-by-default disclosure policy;
- a cryptographic RNG for table games;
- decision clocks, fallback bots and reconnects;
- a loopback-default table server with opt-in LAN or TLS exposure;
- one web app with a table build that contains no tester views.

Out of scope (revisit after M6):

- accounts, public matchmaking, ranking;
- live spectators of a table;
- restoring a live game after a restart (M7 note only);
- chat;
- padded priority stops to hide the waiting tell (ADR 0031 trust assumptions).
- Engine rules changes are also out of scope. M2 adds an RNG option and a `yieldCancelled`
  event, and makes redaction allowlists; none changes how a rule is applied. If a milestone
  appears to need a rules change, stop and write a separate ADR.

## Ground rules for every milestone

- `Engine.submit()` with an offered action id remains the only authority.
- Disclosure decisions go through the injected `DisclosurePolicy`. Mode branches are
  exhaustive, so a new `GameMode` fails typecheck until each branch is decided.
- No live player frame carries `spectatorState()`, the RNG key, AI notes, debug events, raw halt
  reasons or another seat's private data. Each new message type or projection field gets a
  privacy test.
- Legacy-RNG, no-human games keep identical `game_events` streams, and AI prompts stay
  byte-identical. Run the spectator, combat-sweep and `ai/context` tests on every milestone.
- Wire types go in `packages/shared`, and every consumer is updated in the same change: the web
  store, `agent-client-core.ts`, and tests.
- Run what CI runs: `typecheck`, `typecheck:tests`, `lint`, `format:check`, `test`, the web
  build, and `test:e2e` plus `test:e2e:setup` for viewer changes.

---

## M1 — Seat controllers (refactor, single-player unchanged)

### Tasks

1. **Protocol.** Add `SeatControllers` and `'table'` to `GameMode` in
   `shared/src/protocol.ts`. `StartGamePayload` keeps accepting
   `{ gameMode: 'singlePlayer', humanSeat }`. Update the consumers that switch on `GameMode`:
   the web store, stats and recents filtering, `agent-client-core.ts` and the game report.
2. **Session state.** In `match/session.ts`, replace `humanSeat` with `seatControllers` and a
   derived `humanSeats`.
   - Move `humanProvider`, `connectionGate`, `ignoredAbilities`, `smartYieldMemory`,
     `playerRevision` and `lastHumanDecision` into a `HumanSeatState` per human seat.
   - Enable manual mana per human seat.
   - Public seat-scoped methods take an explicit `seat`.
3. **Mode branches.** Rewrite each `gameMode === 'singlePlayer'` and `getGameMode()` check in
   `session.ts`, `ws/server.ts` and `match/annotations.ts` as an exhaustive `switch` or a named
   predicate. About 35 branches, 15 of them in the session. For `'table'`, each branch throws
   until M2 decides it. That is deliberate: no table session exists yet, so nothing can reach
   them.
4. **Output.** Replace `send` with `sendPublic` and `sendToSeat`. Format a per-seat log for each
   human seat. The tester's `WsServer` maps its one human seat to `playerSocket`. A message to
   any other seat throws in tests.
5. **Strategy coordinator.** `StrategyCoordinator` takes `humanSeats: ReadonlySet<PlayerId>`
   (today a single `humanSeat` at `ai/strategy-coordinator.ts:207`). It skips planning for every
   human seat and records each human decision.
6. **Bot waits.** Bots keep waiting on the single human's gate in single-player. The `'table'`
   behavior, where bots never wait on a human gate, is implemented in M5.

### Tests

- Existing tests pass with what they assert unchanged. That covers `match/*.test.ts`,
  `ws/*.test.ts`, `stores/game.test.ts` and `agent-client-core.test.ts`.
- **Wire transcript.** Record every `ServerToClientMessage` of a fixed-seed single-player game
  with a scripted human, before and after the change, and require them to be identical. This is
  stricter than an event hash.
- **`match/session-multi-human.test.ts`,** in-process:
  - two human seats plus two random bots reach the turn cap;
  - each seat's stream holds only its own hand;
  - P2 cannot answer P1's request, and P1's revision is rejected for P2;
  - the coordinator skips both human seats on an `ai` provider fixture with a mocked client.

### Exit

CI green. No `humanSeat!` assertions remain. Every mode branch is exhaustive.

---

## M2 — Hidden-information and replay hardening (tester-safe)

Everything here also improves single-player. Nothing here opens a network port.

### Tasks

1. **`DisclosurePolicy`** (`match/disclosure.ts`). It covers the RNG key or seed, debug events,
   AI annotations (per seat), raw halt reasons, raw `LegalAction.data`, and the full-state replay
   unlock (when, and to whom). Every field defaults to deny.
   - `ws/server.ts` constructs today's values for spectator and single-player.
   - Each M1 `'table'` branch now reads the policy instead of throwing.
2. **Key and seed out of player frames.**
   - Remove `seed` from `buildPlayerBoardState`'s output. It currently inherits it from the
     spectator spread, so `PlayerBoardState` changes to omit `seed`.
   - Gate the seed in `gameReport()` and `gameStarted` through the policy. The tester's policy
     allows it, so single-player shows it as today.
3. **`chacha20` RNG** (`engine/src/rng/chacha20.ts`).
   - `GameConfig.rng: 'legacy' | 'chacha20'`, default `legacy`.
   - `state/game.ts:166` picks the generator.
   - `clone()` keeps its semantics: an independent stream at the current position.
   - Bot providers built for a `chacha20` game take a stream derived from the same key and seat.
     `bot/src/provider.ts` gains an injected RNG instead of a seed string.
   - Tests: RFC 8439 section 2.4.2 vectors, determinism given a key, and identical legacy streams
     for existing seeds.
4. **Redaction allowlists** (`view/spectator.ts`).
   - Build redacted face-down permanents and redacted exile cards field by field from an
     allowlist. Face-down exile gets a first-class flag.
   - Make the player-log filter an allowlist of event types and decision types.
   - Add a coverage test that constructs each projected type with every key and fails when a key
     is neither allowed nor redacted.
5. **Commander views and yield state.**
   - `commanderViews` returns `zone: 'hidden'` and `objectId: null` to non-owners when the
     commander is in a hand or library. This needs a viewer-aware variant inside
     `buildPlayerBoardState`.
   - `yieldingUntilEndOfTurn` goes only to its own seat.
6. **Coordinator privacy.** `StrategyCoordinator.recordDecision` uses the action's
   `publicDescription` when one exists.
7. **Replay inputs.**
   - `Engine.cancelYield` emits `yieldCancelled { player }`.
   - The `games` row gains `config_json` (the full `GameConfig`, including per-seat manual mana,
     turn cap and RNG kind) and `build_commit` (from `build-info.ts`).
   - Add a `game_decision_sources (game_id, request_id, seat, source)` table, with `source` one
     of `human`, `auto`, `timeout`, `fallback` or `bot`. The session tags each response's source
     before `onDecision` runs. The smart-yield auto-pass is `auto`.
   - These are additive schema changes using the existing `ALTER` list and
     `CREATE TABLE IF NOT EXISTS`.
8. **Replay test harness** (test-only, `match/replay-from-log.test.ts`). Build an engine from
   `config_json` and the key, then feed it, in sequence order:
   - each `decision` event's `submittedResponse`;
   - each `yieldCancelled` event.

   Assert every surfaced request id matches, and the final state hash matches, using the
   benchmark replay hashing.

### Tests

- Each task's own tests, listed above.
- **Frame scan** (`ws/player-frame-privacy.test.ts`). Scan every frame of a scripted
  single-player game for:
  - another seat's hand object ids;
  - commander zones `hand` or `library` of another seat;
  - another seat's `yieldingUntilEndOfTurn: true`;
  - any `note` key.
- **Replay.** A single-player game in which the human cancels a yield and uses manual mana
  replays exactly.

### Exit

CI green. Single-player differs from M1 only in the documented privacy fixes. Legacy fixed-seed
event streams are unchanged.

---

## M3 — Table server on loopback, with a scripted client

### Layout

```
packages/server/src/table/
  registry.ts     tables by id; caps; idle reaping
  table.ts        lobby state machine; seats; owns one MatchSession
  tokens.ts       host secret, invite codes, seat tokens; constant-time compare
  table-ws.ts     table message set only
  table-http.ts   create table (host secret), table summary
  config.ts       TABLE_* settings
  watchdog.ts     per-step compute budget
packages/server/src/cli/serve-table.ts
```

### Lobby state machine

```
open ──claimSeat / leaveSeat / hostSetSeat / hostKick──▶ open
open ──hostStart (≥1 human, every seat human or bot, every deck valid)──▶ starting
starting ──setup ok──▶ playing        starting ──setup problems──▶ open (each seat told privately)
playing ──game over / host abandon / game cap / every human gone past budget──▶ finished
finished ──idle timeout──▶ reaped
```

Joining, kicking and seat changes are refused outside `open`.

### Protocol (`shared/src/table-protocol.ts`)

- Client to server:
  - `joinTable {inviteCode, displayName, protocolVersion, capabilities}`;
  - `claimSeat {seat, decklist}`, where `decklist` is plaintext only;
  - `leaveSeat`;
  - host only: `hostSetSeat {seat, controller}`, `hostKick {seat}`, `hostStart`;
  - `resumeSeat {seatToken, protocolVersion}`;
  - the existing in-game messages.
- The seat comes from the socket's token.
- Server to client: `tableState`, `seatGranted {seat, seatToken}`, `deckProblems`, the in-game
  player messages, `seatTakenOver`, `protocolMismatch` and `tableClosed`.
  - `tableState` is public: seats, display names, human or bot, clock, and whether the table can
    start. It never carries decks or commanders.
  - `deckProblems` goes to that seat only.

The table server never registers tester messages (`startGame`, `startCardTestScenario`,
`jumpToTurn`, `setPlaybackMode`, `resolveHeldDecision`, `setDebugFlags`, `abandonGame`).

### Tasks

1. Registry caps (`TABLE_MAX_TABLES`, `TABLE_MAX_SOCKETS`, per-IP sockets) and reaping of idle
   tables.
2. Tokens:
   - the host secret is printed at startup, and creating a table requires it;
   - invite codes are 128 bits and seat tokens 256 bits;
   - tokens are kept in memory only.
3. Deck claim. Parse the plaintext list with the existing import pipeline into the table
   server's own database, under table-scoped ids. Report problems with `projectSetupProblems`.
4. Start. Build `seatControllers` and the table `DisclosurePolicy`, and use the `chacha20` RNG
   with a fresh 256-bit key. Rotate the invite code.
5. Watchdog. If a single `engine.advance()` runs past `TABLE_STEP_BUDGET_MS`, the table ends
   with a public "the rules engine stopped" message.
6. `PROTOCOL_VERSION` in `shared`.
7. Request checks: the loopback-only `isAllowedLocalRequest` for now.
8. A module-graph test for `cli/serve-table.ts`:
   - it uses `bun build --metafile` on the entry;
   - it fails on `batch/`, `benchmark/` or `cards/card-test-*`;
   - exceptions are listed with reasons;
   - `no-restricted-imports` for `table/**` in `eslint.config.js` blocks direct imports.
9. Agent client table mode. `agent-client --table <invite> --name <n>` claims a seat and plays
   through stdin and stdout. A `--policy first-legal` flag gives scripted tests a client.

### Tests

- `table/table.test.ts`: the state machine, including refusals outside `open`.
- `table/table-ws.test.ts`, with real sockets on an ephemeral port and two scripted agent clients
  plus two bots:
  - **frame scan** of every frame for the key, `spectatorState`, debug events, `note`, raw
    `data`, other seats' hand object ids, commander zones and yield flags;
  - tester messages refused;
  - a forged seat in a payload is ignored;
  - two tables run concurrently without cross-talk;
  - a stale protocol version gets `protocolMismatch`;
  - a second socket with the same token takes the seat over and the first is told.
- `table/tokens.test.ts` and `table/watchdog.test.ts`.

### Exit

Two scripted clients and two bots finish a game on loopback, and the frame scan is clean.

---

## M4 — Network exposure (needs ADR 0031 accepted)

### Tasks

1. Config:
   - `TABLE_HOST`;
   - `TABLE_ALLOWED_ORIGINS` and `TABLE_ALLOWED_HOSTS`;
   - TLS settings (certificate paths, or `TABLE_BEHIND_TLS_PROXY`);
   - `--insecure-lan`.

   The server refuses a non-loopback bind without the allowlists, and without TLS unless
   `--insecure-lan` is set.

2. `isAllowedTableRequest`: origin and host allowlists. They are defense in depth; tokens
   decide access.
3. Limits:
   - pre-authentication timeout (10 s to send `joinTable` or `resumeSeat`);
   - frame size of 256 KiB;
   - decklist of 64 KiB and 250 lines;
   - 20 messages per second per socket;
   - socket opens and concurrent sockets per IP address.
4. Display names: 1–24 characters after trimming, with control and bidirectional-override
   characters removed. They are rendered as text.
5. With `--insecure-lan`, every player sees a banner: "This table is not encrypted. Anyone on
   this network could take your seat."
6. `docs/guides/table-hosting.md`. It covers:
   - LAN setup;
   - TLS through a reverse proxy;
   - what the host can see;
   - the trust assumptions;
   - a warning never to expose `serve`.
7. Update `docs/guides/testing-discipline.md`: its loopback line now points to ADR 0031 for the
   table server.
8. Run `/security-review` on the table server diff before merging.

### Tests

- Config refusal cases.
- Origin and host checks, including a missing origin on a non-loopback bind.
- Pre-authentication timeout; rate limit closes the socket with a policy code; oversize frames
  and decks are rejected before parsing.
- Display-name table test.

### Exit

A game across two machines on a LAN, with scripted clients, under `--insecure-lan`, and one
behind a local TLS proxy. The security review has no unresolved high findings.

---

## M5 — Clocks, fallback bots, disconnects

### Tasks

1. **`match/decision-clock.ts`** with an injected clock (`now()`, `setTimer`).
   - Each decision has a free allowance (10 s), then draws on the bank.
   - A cumulative disconnect budget per seat.
   - A game wall-clock cap.
   - Presets: `relaxed` (10-minute bank) and `standard` (5 minutes). `off` is allowed only on
     loopback.
2. **`TimedHumanProvider`.** On expiry, it first bumps the seat's revision. Then it asks the
   fallback heuristic bot (`packages/bot`), never an LLM, with `activateManaAbility` options
   filtered out, the same way `PersistentAbilityYieldProvider` filters. It strips `note` and
   submits with source `timeout`.
3. **Takeover.** After three timeouts in a row, or once the disconnect grace (charged to the
   budget) has elapsed, the seat plays as `fallback` until its player acts.
4. **Table bots stop waiting on human gates.** This is the M1 task 6 behavior for `'table'`.
5. **Protocol.**
   - `clockState {seat, remainingMs, bankMs, running}` goes to seat-bound sockets.
   - `seatStatus {seat, connected, fallback}`.

### Tests

- Clock behavior with the injected clock: allowance, bank, budget, cap.
- **Timeout race.** A late human answer after expiry is rejected as stale.
- **Manual mana.** The fallback bot on a manual-mana seat never taps a source by hand.
- **Replay.** Using the M2 harness, a game with `human`, `auto`, `timeout` and `fallback`
  sources replays exactly.
- **Disconnects.** P1 disconnects past grace and goes to fallback while P2 plays on. P1
  resumes and gets the board, yield preferences and the pending choice back.
- **Bots never get clocks.** A spectator or bot-only game constructs no clock and no fallback
  provider.

### Exit

A four-client table where one client disconnects mid-game finishes, and the client rejoins.

---

## M6 — Web: lobby, table play, table build, CI

### Tasks

1. **Table build.** `VITE_APP_MODE=table` builds an entry whose router lazy-loads only the
   create, join, lobby and player-board views. A build test reads the bundle manifest and fails if
   it contains `GameView`, `StatsView`, `DebugView`, the batch views or `CardTestLabView`. The
   server is the real boundary; this keeps tester code out of what players download.
2. **`stores/table.ts`:**
   - the seat token in `localStorage` keyed by table id, removed at `tableClosed`;
   - reconnect with backoff;
   - handling for `seatTakenOver` and `protocolMismatch`.
3. **Player board.**
   - Each seat shows its display name and a human, bot or fallback badge.
   - A "Waiting on Alice — 0:42" line from `clockState`.
   - The player's own clock and bank.
   - The `--insecure-lan` banner.
   - It reads presentation fields only (ADR 0032). Any part of the presentation track not yet
     done for these views is finished here first.
4. **Lobby:**
   - seat grid;
   - decklist paste with private problem list;
   - host controls (bot kind per seat, clock preset, kick, start) while the table is `open`;
   - copy invite link.
5. **Dev and CI.**
   - `scripts/dev.ts --table`.
   - A third Playwright config, `playwright.table.config.ts`, with its own server and web
     ports. The table server's allowlist includes its web port.
   - A CI job (`table-e2e` in `.github/workflows/ci.yml`) running it in parallel with the
     existing viewer job, not serially inside it.
   - `testIgnore` updates so existing configs skip the table specs.
6. **Docs.** Update `docs/guides/current-state.md`, `docs/guides/json-agent-client.md` (table
   mode, the `rawActionData` capability) and `docs/guides/project-commands.md`.

### Tests

- `stores/table.test.ts`.
- E2E `table-game.spec.ts`:
  - two browser contexts join, claim seats and start against two bots;
  - each plays a land and passes;
  - one closes and reopens and resumes;
  - the host abandons;
  - both see the post-game unlock with the key.
- Bundle-manifest test.
- `player-game.spec.ts` still passes in the tester build.

### Exit

The player outcome list works end to end in the table e2e job.

---

## M7 — Follow-ups, on evidence

1. **Isolate tables on evidence.** Measure event-loop lag with 8 tables of 2 humans and 2
   heuristic bots, as a manual measurement, not a CI test. If p95 lag exceeds 100 ms, run each
   table in a Bun Worker. The M3 watchdog already bounds the worst case.
2. **Restore after restart.** The M2 replay inputs make it possible on the same build. It needs a
   design note on re-issuing tokens and on a decision accepted but not yet persisted.
3. **Padded priority stops,** to hide the waiting tell, as a table option.
4. **Per-viewer object ids,** to remove the counter-gap tell.
5. **Spectators** need a separate ADR.

---

## Order and sizing

| Milestone                 | Depends on             | Size | Ships alone                       |
| ------------------------- | ---------------------- | ---- | --------------------------------- |
| M1 Seat controllers       | —                      | L    | Yes (refactor)                    |
| M2 Hidden info and replay | M1                     | M    | Yes (single-player privacy fixes) |
| M3 Table server, loopback | M2, ADR 0031 accepted  | M    | Yes (scripted local tables)       |
| M4 Network exposure       | M3                     | M    | Yes (LAN with scripted clients)   |
| M5 Clocks and fallback    | M3                     | M    | Yes                               |
| M6 Web and CI             | M3, M5, ADR 0032 track | M    | —                                 |
| M7 Follow-ups             | M6                     | —    | per item                          |

The presentation track (P1–P7) can run alongside M1–M5. Its P4 changes
`sendPlayerActionRequired`, so it lands after M1's change to the same function, or rebases onto
it. M4 and M5 can run in parallel after M3.

## Delegation notes

Per `CLAUDE.md`:

- **Sonnet `implementer`:**
  - M1 tasks 1, 2 and 4, with the task list as the checklist;
  - M3 registry, tokens and the agent-client table mode;
  - M6 lobby views and Playwright config.
- **Main thread:**
  - M1 task 3 (every mode branch is a disclosure decision);
  - M2 in full (engine RNG, redaction, policy);
  - M4's security review;
  - every frame-scan test.
- **Haiku `explorer`:**
  - list every `GameMode` consumer;
  - list every `seed` read in `packages/server` and `apps/web`.

## Risks

| Risk                                     | Mitigation                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| A mode branch leaks in table mode        | Exhaustive switches (M1); deny-by-default policy (M2); frame scans       |
| Predictable randomness                   | `chacha20` keyed with 256 bits for tables (M2); key hidden until the end |
| A new projection field leaks             | Allowlist redaction with a key-coverage test (M2)                        |
| Replay drifts                            | Stored config, build commit, `yieldCancelled`; replay harness (M2, M5)   |
| The host takes over a seat               | No token reissue; seat changes only in `open` (M3)                       |
| Token sniffing on a LAN                  | TLS by default; `--insecure-lan` banner; takeover notice (M3, M4)        |
| One table starves the others             | Step watchdog (M3); caps; Worker option (M7)                             |
| Stalling                                 | Allowance and bank, disconnect budget, game cap (M5)                     |
| Fallback bot misplays a manual-mana seat | Mana activations filtered from its menu (M5)                             |
| A tester view ships in the table bundle  | Bundle-manifest test (M6)                                                |
| CI time grows                            | Separate parallel `table-e2e` job (M6)                                   |
