# Multiplayer tables

Decision record: [ADR 0031](../decisions/0031-multiplayer-tables.md). Status: proposed and awaiting
approval. Presentation work is a separate track,
[server-computed presentation](server-computed-presentation.md)
([ADR 0032](../decisions/0032-server-computed-presentation.md)).

**Order:**

1. M1, then M2a and M2b. P1 can run alongside them.
2. P2 to P5.
3. M3, then M4, then M5. P6 can run during M3 to M5.
4. M6.

M1, M2 and the presentation track improve the tester on their own and stay on loopback. M3
onward waits for ADR 0031 to be accepted. M5 is the milestone that allows exposure beyond the
host's machine ([testing discipline](../guides/testing-discipline.md)).

## Purpose

Let one to four people who know each other play one Commander game from their own browsers,
with bots in the empty seats, without weakening the tester. The engine stays authoritative,
each seat sees only what its player may see, randomness cannot be predicted from a player's
view, and the tester's debug and analysis surfaces stay on loopback.

## Player outcome

A host should be able to:

1. Run `bun run serve:table`, copy the host secret it prints, open the table page the server
   serves, create a table, and send friends the invite link.
2. Approve each player who asks for a seat (the host's own seat included), choose bots for the
   others, and start.

A guest should be able to:

1. Open the invite link, choose a display name, paste a decklist, and see private deck problems.
2. Play with the same board, controls, smart yield and manual mana as single-player.
3. See whose decision the table is waiting on and how much time they have left.
4. Close the tab or browser and reopen the invite link in the same browser within the disconnect
   budget, then continue from the same pending choice.
5. After the game, or after an engine halt, see the results, every decklist, a turn-by-turn
   replay and the RNG key.

## Scope and non-goals

In scope:

- one to four human seats, with heuristic or random bots in the rest;
- invite tables with host approval, seat tokens, display names, and plaintext decklists;
- per-seat projections, ids, cadence, logs and errors, behind a deny-by-default disclosure
  policy;
- a ChaCha20 RNG for table games;
- clocks, fallback bots, reconnects;
- a worker per table;
- a same-origin table web build served by the table server.

Out of scope (revisit after M6):

- LLM seats at tables;
- accounts and public matchmaking (they need a new ADR);
- spectators of a table;
- restoring a live game after a restart;
- chat;
- padded priority stops;
- per-viewer object ids.

Engine rules changes are also out of scope. The engine gains several mechanisms that change no
rule: an RNG option, `yieldCancelled`, `concede` for the time limit, a step budget, and
allowlist redaction. If a milestone appears to need a rules change, stop and write a separate
ADR.

## Ground rules for every milestone

- `Engine.submit()` with an offered action id remains the only authority.
- **Disclosure** goes through the injected `DisclosurePolicy` and the outbound message-type
  allowlist. Every mode branch is a `switch` ending in `assertNever`.
- **What a live player frame may not carry:**
  - `spectatorState()`;
  - the RNG key or seed (in table mode);
  - AI notes or cost reports;
  - debug events;
  - raw error or halt text;
  - another seat's private data;
  - global request ids, event sequences or revisions (from M3).

  Each new message type or projection field gets a privacy test.

- **No-human legacy games stay identical.** Their `game_events` streams and AI prompts are
  unchanged. Run the spectator, combat-sweep and `ai/context` tests on every milestone.
- **Wire types go in `packages/shared`.** Every consumer is updated in the same change: the web
  store, `agent-client-core.ts`, and tests.
- **Run what CI runs:** `typecheck`, `typecheck:tests`, `lint`, `format:check`, `test`, the web
  build, the e2e configs for viewer changes, and the `card-verification` job
  (`test:card-gate`, which includes `prng.test.ts`) for engine changes.

---

## M1 — Seat controllers (refactor, single-player unchanged)

### Tasks

1. **Protocol.** Add `SeatControllers` and `'table'` to `GameMode` in `shared/src/protocol.ts`.
   `StartGamePayload` keeps `{ gameMode: 'singlePlayer', humanSeat }`. Update every `GameMode`
   consumer:
   - the web store;
   - stats and recents filtering;
   - `agent-client-core.ts`;
   - the game report;
   - `match/preview.ts`.
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
   - `lookaheadTurns: 0` applies whenever any seat is human.
   - Seat-scoped public methods take an explicit `seat`.
3. **Mode branches.** There are about 38 `singlePlayer` checks across `session.ts`,
   `ws/server.ts`, `match/annotations.ts` and `match/preview.ts`. Each becomes a `switch` on
   `GameMode` ending in `assertNever`, which is added to `packages/shared`. Each branch is one of
   two kinds:
   - **Flow branches** (`onEvents`, `onProgress`, `start()`, bot pacing, presentation clock):
     `'table'` behaves like single-player, per human seat. It never falls into the spectator
     branch, which would start `startPresenting` and send `spectatorState`.
   - **Fence branches** (halt reason, debug, legal-menu escalation, annotations, errors):
     `'table'` takes the most restrictive choice.
     - No debug.
     - A fixed halt message.
     - No raw errors.
     - No other seat's notes.
     - No `apiWaiting`.
     - No seed. The session strips `seed` from player-bound state for `'table'` only, so the
       single-player wire output is unchanged.
4. **Output.** Replace `send` with `sendPublic` and `sendToSeat`.
   - The runner's `formatEvents` becomes a per-seat formatter.
   - `GameServer` maps its one human seat to `playerSocket`.
   - Sending to any other seat throws in tests.
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
  timestamps; everything else must match byte for byte. M2a re-baselines this file once for its
  documented privacy fixes.
- **`match/session-multi-human.test.ts`,** in-process with `gameMode: 'table'`:
  - two human seats and two random bots reach a turn cap of 6;
  - each seat's stream holds only its own hand;
  - one seat cannot answer another's request or reuse its revision;
  - no frame carries `seed`, `spectatorState`, debug events, `apiWaiting` or raw halt text;
  - with a mocked AI client, the coordinator skips both human seats.

### Exit

- CI is green.
- No `humanSeat!` assertions remain.
- Every mode branch ends in `assertNever` and is labeled flow or fence.

---

## M2a — Hidden information and replay hardening

These fixes also apply to single-player. No network port opens.

### Tasks

1. **`DisclosurePolicy`** (`match/disclosure.ts`).
   - It covers:
     - the public label;
     - debug events;
     - annotations, per seat;
     - raw errors and halts;
     - archetype tags (a human seat's tag goes only to that seat);
     - AI cost reports;
     - the full-state replay unlock.
   - Every field defaults to deny. `GameServer` builds today's values. M1's fence branches read
     the policy.
   - `sendPublic` and `sendToSeat` check an outbound message-type allowlist taken from the
     policy.
2. **Seed in player frames.** `PlayerBoardState` makes `seed` optional. `buildPlayerBoardState`
   includes it only when the policy allows. `gameReport()` and `gameStarted` take the seed from
   the policy. The tester's policy still shows it.
3. **Halts are terminal.** `MatchRunner.finish` calls a new `onHalted` hook. The session treats a
   halt as terminal for the policy's post-game unlock, and sends a fixed message in table mode.
4. **Allowlist redaction** (`view/spectator.ts`).
   - Face-down permanents and exile cards are built field by field.
   - `moveObject` sets a `faceDown` flag on exile objects moved face down.
   - The player-log filter classifies every decision type with
     `satisfies Record<DecisionType, boolean>`. Its explicit event list covers `draw`, `scry`,
     `surveil` and `yieldCancelled`.
   - The `engineHalt` line shows a fixed text to players.
   - A coverage test builds each projected type with every key and fails on an unclassified key.
5. **Commanders and yields.**
   - The viewer-aware commander view returns `zone: 'hidden'`, `objectId: null` and
     `scryfallId: null` to non-owners for a commander in a hand or library, or face down.
   - `yieldingUntilEndOfTurn` goes only to its own seat.
6. **Replay inputs.**
   - `Engine.cancelYield` emits `yieldCancelled { player }` only when it changes state.
     `view/view.ts` `visibleEvent` hides it from the AI's recent log.
   - The `games` row gains three columns:
     - `config_json`: deck snapshot ids, manual mana per seat, turn cap, RNG kind and key, and
       engine options;
     - `build_commit`;
     - `build_dirty`, which `readBuildInfo` may leave null outside git.

     Card Test Lab games store none of them.

   - A new `game_decision_sources (game_id, request_id, seat, source)` table records attribution.
     The session tags each response's source before `onDecision`; the smart-yield pass is `auto`.
   - All of this goes through `MIGRATIONS_SQL` and `CREATE TABLE IF NOT EXISTS`.

7. **Replay harness** (test-only, `match/replay-from-log.test.ts`).
   - Build an engine from `config_json`.
   - Feed it each `decision` event's `submittedResponse`.
   - Apply each `yieldCancelled` (and, from M4, each `concede` event) when the engine's next
     event sequence equals the event's. Check after both `advance()` and `submit()`.
   - Fail loudly on a request id or sequence mismatch.
   - Compare the final state hash.
8. **Docs.**
   - Amend `docs/guides/rules-engine-constraints.md`, rewording the timing line per ADR 0031
     decision 8.
   - Add an "Amended by 0031" line to `docs/decisions/0030-manual-mana-activation.md`.

### Tests

- Each task's tests above.
- **Frame scan** (`ws/player-frame-privacy.test.ts`) of every frame of a scripted single-player
  game. It fails on:
  - another seat's hand ids;
  - another seat's commander zone or art when hidden;
  - another seat's yield flag;
  - another seat's archetype tag;
  - a `note` key;
  - raw halt text.
- **Replay** of a single-player game with a cancelled yield and manual mana.
- **Halt.** A forced engine halt unlocks the post-game view.

### Exit

- CI is green.
- Single-player differs from M1 only in the documented privacy fixes, plus the added event in
  games where the human cancels a yield.
- No-human legacy event streams are unchanged.

---

## M2b — ChaCha20 RNG

### Tasks

1. **`EngineRng`.** An `EngineRng` interface replaces the `Prng` class type in
   `state/types.ts:986` and in `providers.ts`.
2. **`engine/src/rng/chacha20.ts`.** All mutable state is plain number properties: key and
   counter words, a `number[]` block, and a position. `clone()` deep-copies the block and
   position. `nextInt(n)` matches `Prng.nextInt`, including its error on `n <= 0`.
3. **`GameConfig`** gains `rng` (default `legacy`) and `rngKey`. `state/game.ts:166` picks the
   generator. The key is never copied into `EngineState`, events or snapshots. For `chacha20`,
   `seed` is a random label.
4. **Streams.**
   - Fixed nonces:
     - `0` for the game;
     - `1 + seat` for each bot seat;
     - `5 + seat` for each fallback bot;
     - `9 + seat` for each bot seat's generated deck.
   - `HeuristicDecisionProvider` accepts `string | { nextInt }`. A string keeps today's `Rng`,
     so legacy output and the benchmark and CLI call sites are unchanged.
   - The bot's own `Rng.nextInt(0)` returns 0. The injected source wraps ChaCha20 to match that,
     so the bot sees the same contract.
   - `setupPoolSeat` takes its deck RNG from the bot seat's deck stream for `chacha20` games.
   - `ai/provider.ts:227`'s `HeuristicRng(request.requestId)` is seeded from a public id. It is
     listed in the RNG inventory and left alone, since it reveals nothing.

### Tests

- The RFC 8439 section 2.4.2 vectors.
- Determinism given a key.
- A casting-checkpoint rewind restores the stream exactly.
- `clone()` independence.
- Legacy streams are unchanged for existing seeds, and `test:card-gate` (including
  `prng.test.ts`) passes.
- No two consumers share a key and nonce.
- A `chacha20` game's events, snapshots and frames contain no key bytes.

### Exit

CI is green, including `card-verification`.

---

## M3 — Table server on loopback, with scripted clients and workers

### Layout

```
packages/server/src/table/
  registry.ts       tables by random id; caps; reaping
  table.ts          lobby state machine; claims; approvals; owns a TableSessionPort
  session-port.ts   async interface to one MatchSession; worker and in-process implementations
  table-worker.ts   worker entry: own GameStore, own MatchSession, message relay
  tokens.ts         host secret, host tokens, invite codes, seat tokens; constant-time compare; throttling
  wire-ids.ts       per-seat request ids and revisions; per-viewer log sequences
  table-ws.ts       table message set only
  table-http.ts     static table web build; create table (host secret); summary (invite in POST body)
  config.ts         TABLE_* settings; dev mode
packages/server/src/cli/serve-table.ts   (--oracle-fixture and --dev supported)
```

### Lobby state machine

```
open ──requestSeat──▶ open (claim pending)
open ──hostApprove{claimId} / hostDeny{claimId} / leaveSeat / hostSetSeat / hostKick──▶ open
open ──hostStart (≥1 human, every seat human or bot, every deck valid)──▶ starting
starting ──setup ok──▶ playing        starting ──setup problems──▶ open (each seat told privately)
playing ──game over / halt / hostAbandon / game cap / every human gone past budget──▶ finished
finished ──idle timeout──▶ reaped
```

Requests, approvals, kicks and seat changes are refused outside `open`. Kick, deny, leave and
seat changes revoke the affected seat token.

### Protocol (`shared/src/table-protocol.ts`)

- **Client to server.**
  - **Lobby connection, from anyone holding the invite:**
    - `joinTable {inviteCode, displayName, protocolVersion, capabilities}`;
    - `requestSeat {seat, decklist}`, which returns a `claimId`;
    - `leaveSeat`.
  - **Lobby connection, from the host-token holder, after `hostAuth {hostToken}`:**
    - `hostApprove {claimId}` and `hostDeny {claimId}`;
    - `hostSetSeat {seat, controller}` and `hostKick {seat}`;
    - `hostStart` and `hostAbandon`.
  - **Game connection, from a seat-token holder:**
    - `resumeSeat {seatToken, protocolVersion, capabilities}`;
    - `resumeControl`;
    - the existing in-game messages;
    - after the game is finished, `replayTurn {turn}`.
- **Server to client:**
  - `tableState`: seats, display names, pending claims (host only), human or bot, clock,
    whether the table can start, the insecure-LAN flag;
  - `claimPending {claimId}`, `seatGranted {seat, seatToken}`, `deckProblems` (to that
    claimant only);
  - the in-game player messages, filtered by the outbound allowlist;
  - after finishing, `replayUnlocked` and `replayTurnState`;
  - `seatTakenOver`, `protocolMismatch` and `tableClosed`.

The table server never registers the tester's messages. `replayTurn` is the table's own
read-only message, accepted only in `finished`.

### Tasks

1. **Registry and tokens.**
   - The host secret is printed at startup.
   - Host tokens and seat tokens are 256 bits, and invite codes are 128 bits.
   - Failed attempts are throttled per client address.
   - Table ids are random.
   - Display names must be unique within a table.
2. **Claims.**
   - Parse the plaintext decklist in memory with `parsePlaintextDeck` (not `importDeck`) and
     validate it.
   - Write it to the table database under a table-scoped id only after approval.
   - Pending claims are capped per table (8) and per socket (1).
3. **Workers.**
   - `TableSessionPort` is an async interface, so the table calls the session the same way
     whatever runs it.
   - The worker implementation runs its own `GameStore` on the table database, with `busy_timeout`
     set, and its own `MatchSession`.
   - The main thread treats a worker as dead after 30 s without a reply and `terminate()`s it,
     and the table ends with a fixed message.
   - Tests may use the in-process implementation. `serve:table` always uses workers.
4. **Start.**
   - Build `seatControllers`, the table `DisclosurePolicy`, and the `chacha20` config with a
     fresh key.
   - Close joining.
   - In `--dev` mode only, `TABLE_TEST_RNG_KEY` is accepted, so e2e hands are reproducible.
5. **`wire-ids.ts`.**
   - Per-seat request ids are translated back to engine ids before the human provider, and the
     mapping is memoized so re-sent requests keep their id. Auto-passed decisions do not advance
     the counter.
   - Each seat's revision counts only that seat's frames.
   - Per-viewer log sequences.
   - A board snapshot is sent only when that seat's projection changed.
   - The game report is mapped the same way.
6. **Engine step budget.**
   - `EngineOptions.maxStepWork` counts events emitted in one `advance()`, through a counter on
     `GameContext` incremented in `emit()`.
   - The `engineHalt` emit is exempt.
   - Probe contexts (`stateful-payment.ts`) default to unlimited.
   - Exceeding the budget halts through the existing path. It is unlimited for the tester, set
     for tables, and stored with the game.
7. **Same-origin web.** `table-http.ts` serves the `VITE_APP_MODE=table` build (from M6; until
   then, a placeholder page) and builds invite links from `TABLE_PUBLIC_ORIGIN`, which defaults
   to the loopback URL.
8. **Dev mode** (`--dev`). Clock `off` and the test key are allowed. Requests whose `Host` or
   `Origin` is not loopback are refused. The server refuses to start in dev mode with any proxy
   or allowlist setting.
9. **`PROTOCOL_VERSION`** in `shared`.
10. **Module-graph test** for `cli/serve-table.ts` and `table/table-worker.ts`.
    - Use `bun build --metafile`, checking it on the CI-pinned Bun version first.
    - Fail on `batch/`, `benchmark/` runtime modules, or any `createCardTestScenario` module.
      Type-only imports do not appear in the bundle graph and are allowed.
    - Add `no-restricted-imports` for `table/**`.
11. **Agent client table mode.** Add `agent-client --table <url> --invite <code> --name <n>`,
    with `--policy first-legal`. It sends the `rawActionData` capability (P5) and re-sends it on
    resume. Loopback only in M3.
12. **`package.json` and docs.** Add `"serve:table"`, and update `docs/guides/project-commands.md`
    and `docs/guides/json-agent-client.md` (table mode, capabilities).

### Tests

- **`table/table.test.ts`.** The state machine, claim-id approval, token revocation on kick, and
  refusals outside `open`.
- **`table/table-ws.test.ts`**, with two scripted agent clients and two bots, using the fixture
  oracle, dev mode and a test key.
  - Frame scan of every frame. It fails on:
    - the key or seed;
    - `spectatorState`;
    - debug events;
    - `apiWaiting`;
    - `note`;
    - raw halt text;
    - `data` without the capability;
    - other seats' hand ids;
    - hidden commander zones;
    - other seats' yield flags;
    - global request ids, sequences or revisions;
    - card ids in cues.
  - Frame timing: a seat's frame count does not change when a different seat makes a hidden
    decision. That is tested with a scripted opponent scry.
  - Tester messages are refused, and a forged seat in a payload is ignored.
  - Two tables run concurrently without cross-talk.
  - A stale protocol version gets `protocolMismatch`.
  - A takeover notifies the first socket, which does not reconnect.
  - Host messages without `hostAuth` are refused.
  - An unapproved client cannot take a seat.
  - A kicked player's token cannot `resumeSeat`.
  - After the game, `replayTurn` works; before it, `replayTurn` is refused.
- **Further tests:**
  - `tokens.test.ts`, `wire-ids.test.ts`;
  - a step-budget test with a forced-trigger loop fixture;
  - a worker test in which a hung worker is terminated while another table keeps running;
  - a dev-mode test that a non-loopback `Host` header is refused.

### Exit

- Two scripted clients and two bots finish a game on loopback in workers, and the frame scan is
  clean.
- A halted game reaches `finished` and unlocks.

---

## M4 — Clocks, fallback bots and disconnects

### Tasks

1. **`match/decision-clock.ts`,** with an injected `now()` and timer.
   - A free 10-second allowance per decision.
   - Bank: 20 minutes relaxed, 10 standard.
   - A 60-second disconnect grace, charged to a 5-minute budget per seat. The decision clock is
     paused during grace.
   - Game cap: 4 hours relaxed, 3 hours standard.
   - `off` is allowed only in dev mode.
2. **`Engine.concede(players, reason)`.**
   - Emits a `conceded` event and ends the game through the existing game-over path as a draw
     for those players.
   - The replay harness applies it like `yieldCancelled`.
   - The player-log filter and `visibleEvent` classify it.
3. **`TimedHumanProvider`.** On expiry:
   1. bump the seat's revision;
   2. ask the heuristic bot (on the seat's fallback stream) with `activateManaAbility` options
      filtered out, keeping ids, as the smart-yield filter in `sendPlayerActionRequired` does;
   3. strip `note`;
   4. submit with source `timeout`.
4. **Takeover.** After three timeouts in a row, or once grace ends, the seat plays as `fallback`
   until its player sends `resumeControl`. Eliminated seats have no clock.
5. **Protocol.**
   - `clockState {seat, remainingMs, bankMs, running}` goes to seat-bound sockets.
   - `seatStatus {seat, connected, fallback}`.

### Tests

- **With the injected clock:**
  - allowance;
  - bank exhaustion;
  - three timeouts in a row;
  - grace pausing the clock;
  - budget exhaustion;
  - the game cap ending in a draw.
- **Late answers.** A late human answer is stale.
- **Manual mana.** The fallback bot on a manual-mana seat never taps a source by hand.
- **Replay.** The M2a harness replays a game with `human`, `auto`, `timeout` and `fallback`
  sources, and one that ends at the cap.
- **Disconnect.** P1 disconnects past grace and goes to fallback while P2 plays on. P1 resumes,
  sends `resumeControl`, and gets the next decision.
- **Bots never get clocks.** Spectator and bot-only games construct no clock or fallback.

### Exit

Four scripted clients, one of which disconnects and rejoins, finish a game.

---

## M5 — Exposure beyond the host machine (needs ADR 0031 accepted)

### Tasks

1. **Production mode config.**
   - `TABLE_PUBLIC_ORIGIN`;
   - `TABLE_ALLOWED_ORIGINS` and `TABLE_ALLOWED_HOSTS`;
   - TLS (certificate paths, or `TABLE_BEHIND_TLS_PROXY` with the proxy's address for
     forwarded-for);
   - `--insecure-lan`.

   Without `--dev`, the server refuses to start without the allowlists, and without TLS unless
   `--insecure-lan` is set. This applies whatever address it binds, because a tunnel or proxy can
   expose a loopback bind.

2. **Limits.**
   - `maxPayloadLength` of 256 KiB in the `Bun.serve` websocket config.
   - A 10-second pre-authentication timeout.
   - A 64 KiB, 250-line decklist.
   - 20 messages per second per socket.
   - Concurrent sockets and opens per client address, using the rightmost proxy-added
     forwarded-for entry.
   - Takeover rate limits.
   - Outbound backpressure and an idle limit.
3. **Headers.** `Content-Security-Policy: frame-ancestors 'none'` on served pages.
4. **Display names.** 1–24 characters, trimmed, with control and bidirectional-override
   characters removed.
5. **The `--insecure-lan` banner** is shown to every player through `tableState`.
6. **Agent client.** Accepts `wss:` table URLs, and `ws:` LAN URLs only with `--insecure-lan`.
7. **Docs.**
   - `docs/guides/table-hosting.md` covers LAN, TLS behind a proxy, tunnels, what the host sees,
     and the trust assumptions, and warns never to expose `serve`.
   - `testing-discipline.md`'s loopback line points to ADR 0031 for the table server.
8. **Review.** Run `/security-review` on the diff and write the checklist and its findings to
   `docs/reviews/table-server-security-<date>.md`.

### Tests

- Config refusal cases, including a loopback bind without `--dev` and without allowlists.
- Origin and host checks.
- Forwarded-for parsing.
- The pre-authentication timeout.
- Rate-limit closes the socket.
- Oversize frames and decks are rejected.
- The display-name table.
- The CSP header.
- **In-process TLS:** a test starts a local TLS proxy (self-signed certificate) in front of the
  table server, and two scripted clients finish a game through it.

### Exit

- The in-process TLS test passes.
- A manual LAN game with `--insecure-lan` is recorded in the review document.
- The review document lists no unresolved high findings.

---

## M6 — Web: lobby, table play, post-game, CI

### Tasks

1. **Router split.** `router.ts` imports every view statically today; change to lazy imports.
   - A `VITE_APP_MODE=table` entry registers:
     - create, join, lobby;
     - the player board;
     - the post-game view, which shows standings, decklists, the key, and a turn-by-turn replay
       driven by `replayTurn`.
   - A test reads the build manifest and fails if the table bundle contains `StatsView`,
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
   - The insecure-LAN banner.
4. **Lobby.**
   - Seat grid and decklist paste with private problems.
   - Host approval queue by claim.
   - Bot kind per seat, clock preset, kick, start and abandon.
   - Copy the invite link.
5. **Dev and CI.**
   - `scripts/dev.ts --table`.
   - `playwright.table.config.ts`, with its own server and web ports, `--dev`,
     `TABLE_TEST_RNG_KEY`, and the committed Oracle fixture.
   - A `table-e2e` job in `.github/workflows/ci.yml`, alongside the viewer job. It uses the same
     `changes` and `full` gating and the same trace check, and its spec patterns are added to the
     existing configs' `testIgnore`.
   - Making it a required check is a repository setting the owner changes.
6. **Docs.** Update `docs/guides/current-state.md`.

### Tests

- `stores/table.test.ts`.
- E2E `table-game.spec.ts`, with a fixed test key:
  - two browser contexts join and the host approves;
  - start against two bots;
  - each plays a land and passes;
  - one closes and reopens, then resumes;
  - the host abandons;
  - both see the post-game view with the key;
  - both can step the replay back one turn.
- The bundle-manifest test.
- `player-game.spec.ts` still passes in the tester build.

### Exit

The player outcome list works end to end in `table-e2e`.

---

## M7 — Follow-ups, on evidence

1. **Restore after restart,** on the same build, from M2a's stored inputs. It needs a design note
   on token re-issue.
2. **LLM seats at tables,** with a per-table call cap and a design for clock limits.
3. **Padded priority stops.**
4. **Per-viewer object ids.**
5. **Spectators,** which need a separate ADR.

---

## Order and sizing

| Milestone                 | Depends on                       | Size | Ships alone                          |
| ------------------------- | -------------------------------- | ---- | ------------------------------------ |
| M1 Seat controllers       | —                                | L    | Yes (refactor)                       |
| M2a Hidden info, replay   | M1                               | M    | Yes (single-player privacy fixes)    |
| M2b ChaCha20 RNG          | M1                               | M    | Yes (unused until M3)                |
| P1–P5 Presentation        | P2 after M2a task 4; P4 after M1 | M    | Yes (animated-land fix, thin client) |
| M3 Table server, loopback | M2a, M2b, P5, ADR 0031 accepted  | L    | Yes (scripted local tables)          |
| M4 Clocks and fallback    | M3                               | M    | Yes                                  |
| M5 Exposure               | M4                               | M    | Yes (LAN or TLS, scripted clients)   |
| M6 Web and CI             | M5, P6                           | M    | —                                    |
| M7 Follow-ups             | M6                               | —    | per item                             |

Files both tracks touch, and who goes first:

| File                     | First                  | Then                          |
| ------------------------ | ---------------------- | ----------------------------- |
| `shared/src/protocol.ts` | M1                     | P4, P5, then M3               |
| `match/session.ts`       | M1                     | M2a, P4, P5, then M3          |
| `view/spectator.ts`      | M2a tasks 4–5          | P2                            |
| `agent-client-core.ts`   | M1                     | P4, P5, then M3 task 11       |
| `eslint.config.js`       | P4 and P5 (web blocks) | M3 task 10 (`table/**` block) |

## Delegation notes

Per `CLAUDE.md`:

- **Sonnet `implementer`:**
  - M1 tasks 1, 2 and 4;
  - M3 registry, tokens, static serving and agent-client table mode;
  - M6 lobby, store adapter and Playwright config.
- **Main thread:**
  - M1 task 3 (every branch is a flow or disclosure decision);
  - all of M2a and M2b;
  - M3 tasks 3, 5 and 6;
  - M5's security review;
  - every frame-scan test.
- **Haiku `explorer`:**
  - list `GameMode` consumers;
  - list every `seed` read in `packages/server` and `apps/web`;
  - list every `createCardTestScenario` module.

## Risks

| Risk                                       | Mitigation                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| A mode branch leaks in table mode          | Flow/fence `assertNever` switches (M1); policy and outbound allowlist (M2a); scans |
| Predictable randomness                     | ChaCha20 key outside state; one nonce per consumer; fail-closed config (M2b, M3)   |
| Activity leaks through counters or cadence | Per-seat ids and revisions; snapshots only on change (M3); object ids accepted     |
| A new projection field leaks               | Allowlist redaction with a coverage test (M2a)                                     |
| Replay drifts                              | Stored config and build, `yieldCancelled`, `conceded`, replay harness (M2a, M4)    |
| The host takes a seat                      | No token reissue; approval by claim id; changes only in `open` (M3)                |
| A tunnel exposes a loopback server         | Production rules apply on any bind; dev mode refuses non-loopback hosts (M3, M5)   |
| A runaway step freezes the server          | Step budget in the emitter (M3); worker per table, always (M3)                     |
| A halt strands the table                   | Halt is terminal and unlocks (M2a, M3)                                             |
| Stalling                                   | Allowance, bank, disconnect budget, game cap (M4)                                  |
| Fallback bot misplays manual mana          | Mana activations filtered from its menu (M4)                                       |
| Tester views in the table bundle           | Lazy router and bundle-manifest test (M6)                                          |
| Flaky table e2e                            | Dev-mode test key; fixture oracle (M3, M6)                                         |
