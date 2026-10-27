# ADR 0031: Multiplayer tables

Status: Proposed

Date: 2026-10-27

Supersedes in part: [0018](0018-single-player-mode.md) decisions 1, 4 and 5 (one human seat, an
untimed human, every bot pausing while that human is away). Everything else in 0018 and 0019
still holds.

Plan: [multiplayer tables](../plans/multiplayer-tables.md).

## Context

A game today has zero human seats (`spectator`) or exactly one (`singlePlayer`). Several people
should be able to sit at one Commander table, each in their own browser, with bots in any empty
seats.

The engine is already safe for that. `Engine.submit()` accepts only an action it offered, so a
client cannot assert legality. `Engine.playerState(seat)` gives each seat a board with hidden
information removed, and tests guard that boundary. A human seat is an `AsyncDecisionProvider`,
the same interface the bots implement. Decisions come one at a time, and the rules make
mulligans and votes sequential in turn order anyway (CR 103.5, CR 701.38), so a game with several
humans needs no new engine concept.

The server and protocol are where single-player is assumed:

- `WsServer` holds one `session`, one `playerSocket` and one `sessionToken` (`ws/server.ts`).
- `MatchSession` holds one `humanSeat` and one each of its connection gate, smart-yield memory,
  ignored-ability map, player revision and last human decision (`match/session.ts`).
- The session has one `send` sink. In player mode it formats the log for `humanSeat` and the
  WebSocket server forwards every message to the single player socket.
- About 30 branches in the server and session test `gameMode === 'singlePlayer'`.
- The server binds `127.0.0.1` and allows only loopback origins. The testing guide says to keep
  it that way "unless an authenticated remote-sharing design is explicitly approved". This ADR
  is that design, and it needs explicit approval before any non-loopback listener ships.
- `gameStarted` sends the game seed to the client. With one human, that only lets the player
  spoil their own game. Between people it is a cheat: the seed and a decklist are enough to
  work out library order.

The repository also serves as the card-coverage and AI test bench (Card Test Lab, batches,
`ai-bench`, coverage tools, debug views). Those surfaces show every hand and the AI's reasoning
by design, and must never be reachable from a table other people can join.

## Decision

1. **One repository, two server entry points.** `bun run serve` stays the loopback-only tester,
   unchanged in what it exposes. A new `bun run serve:table` starts the table server, which runs
   player games only. Both share `packages/engine`, `packages/bot`, `packages/shared` and
   `packages/server/src/match`. Table code lives in `packages/server/src/table/`. Lint
   boundaries keep `table/` from importing the tester-only modules (`batch/`, `benchmark/`,
   Card Test Lab, debug export) and keep `ws/server.ts` from importing `table/`. Moving the match
   core into its own `packages/match` is deferred until a trigger listed under Consequences
   applies.

2. **Each seat gets its own controller.** The session takes
   `seatControllers: Record<PlayerId, SeatControllerKind>` instead of
   `gameMode` + `humanSeat`. A session is a _player game_ when at least one seat is `human`.
   Every per-player structure (human provider, connection gate, smart-yield memory, ignored
   abilities, revision counter, last human decision) becomes a map keyed by seat. Spectator
   (no human seats) and single-player (one human seat, local) keep their behavior and their
   wire values, and gain the `'table'` mode as a third `GameMode`.

3. **Per-seat output instead of one broadcast.** The session's single `send` is replaced by
   `sendPublic(message)` and `sendToSeat(seat, message)`. Per-seat content (player board,
   `playerActionRequired`, the log via `formatPlayerLog(events, seat)`, setup problems through
   `projectSetupProblems`) goes only to that seat's socket. During a live player game, nothing
   carrying `spectatorState()`, AI reasoning notes, debug events or the seed goes out on any
   channel.

4. **The seed stays secret until the game ends.** On the table server, `gameStarted` carries the
   game id and no seed. The seed, full replay and opponents' decklists unlock for seated players
   once the game is over, the same way single-player releases its end-of-game reports (ADR 0018
   decision 7). AI call logs and debug flags stay on the tester only.

5. **Tables, seats and tokens.** The host creates a table and receives a host token plus an
   invite code (128 random bits, base32). The invite link puts the code in the URL fragment, so
   it never reaches request logs. A player claims an open seat by submitting a display name and
   a deck. The deck goes through the existing setup pipeline, and unmodeled-card blockers are
   reported to that player only. Claiming returns a seat token: a bearer credential that is the
   seat's identity on every message, checked alongside the existing revision, ownership,
   action-id and target checks (ADR 0018 decision 6). The host chooses the bot kind for empty
   seats, starts the game, and can kick a player before the start. There are no accounts. A lost
   seat token can be reissued by the host to a new browser, which revokes the old one.

6. **Decision clocks.** Each table picks a clock: `off`, `relaxed` (90 seconds per decision plus
   a 10-minute bank) or `standard` (30 seconds plus 5 minutes). Smart yield (ADR 0029) and
   automatic passing apply per seat, so routine priority costs no clock. When a clock runs out,
   that seat's fallback bot answers the pending decision through the normal provider path. After
   three timeouts in a row, the fallback bot plays the seat until its player acts again. The
   engine is untouched: a timeout is just a provider choosing a legal action.

7. **A disconnect pauses the table, but only for a while.** When a human's socket drops, a
   decision for that seat waits on its connection gate for a 60-second grace period, which is
   configurable. After the grace period, the fallback bot plays the seat until the player
   reconnects. Reconnecting with the seat token resyncs the board, the player-safe log,
   yield preferences and the pending choice, as single-player does today.

8. **Determinism is kept by recording, not by timing.** A wall clock decides _when_ a timeout
   fires, so a timeout changes which legal action is chosen, exactly as a human does. Live games
   today store only engine events (`game_events`) and per-turn snapshots, not the decisions
   that produced them. Table games will also store every accepted decision, whether from a
   human, a timeout or a fallback bot, with its source (`human`, `timeout`, `fallback`), in a
   new `game_decisions` table. Each record reuses the shape of the benchmark's
   `ReplayDecisionRecord` (`benchmark/replay.ts`): request, response and state hashes.
   Replaying the seed with the recorded decisions reproduces the game exactly, which is the
   guarantee the rules-engine constraints require.

9. **Network exposure is opt-in and narrow.** `serve:table` binds loopback by default. Binding
   any other address requires `--host` plus a configured `TABLE_ALLOWED_ORIGINS` allowlist, and
   the server refuses to start without both. Outside a LAN, TLS is terminated by a reverse proxy
   (documented, not built in). The table server applies size limits on messages and deck
   imports, rate limits on each socket and each IP address, and caps on tables, sockets and
   concurrent games. Display names are length-limited and rendered as text only.

10. **LLM seats are off by default.** A table may use an LLM provider only when the host's
    environment configures a key. That table then has a fixed call budget (ADR 0010) shown in
    the lobby. Heuristic and random bots need no configuration.

11. **Persistence matches today's.** Table games are recorded in SQLite: the table server's own
    database file by default, or the tester's if configured, using the existing `game_mode` and
    `controller_kind` columns plus the `game_decisions` table from decision 8 (an additive
    migration that rewrites no historical rows). A server restart ends live games, as in
    ADR 0018. Restoring a game by replaying the seed with its recorded decisions is a possible
    later step (see the plan) and is not promised here.

12. **The server computes; the client renders.** Every value a player sees that comes from
    rules or engine data is computed on the server, typed, and projected per seat before it is
    sent. The client may lay out the board, animate, remember unsent input and keep display
    preferences. It may not parse engine text (prompts, log lines, action descriptions), read
    `LegalAction.data`, classify cards from `typeLine`, hold rules constants, or infer game
    events by comparing board snapshots. The work splits three ways:
    - **Engine:** typed descriptive facts added to its existing presentation output
      (`DecisionPresentation` and the view projections). Card types, cost components, X values
      and payment plans move out of untyped `data`. This adds no rules logic, and presentation
      never reaches the AI, so prompts are unchanged.
    - **Server:** a per-seat presentation module composes labels, cost labels, X families, a
      per-source index of the legal menu, the player-facing prompt, commander-damage cells and
      presentation events. It reads the seat's player projection, never `GameState`.
    - **Client:** renders those fields.

    Player sockets stop receiving `LegalAction.data`. A lint test in `apps/web` fails on the
    forbidden patterns. Preferences that decide when a seat is asked to act, such as the
    unplayed-land reminder, move to the server alongside smart yield, so they agree with
    automatic passing and the decision clock.

## Consequences

- A table seats one to four humans with bots in the rest. A one-human table on the table server
  is not single-player mode: it plays under table rules (clock, hidden seed, no debug).
- Single-player on the tester is unchanged for users. Its code path becomes the one-human case
  of the seat-controller model, so the existing single-player tests must pass with no changes to
  what they assert.
- The JSON agent client (`bun run agent-client`) can later sit in a table seat with a seat token,
  which gives scripted multi-human tests at no extra cost.
- All tables run on the server's one event loop at first. The bounded combat search (ADR 0024)
  limits each bot decision, but several tables with bots can still delay each other. The plan
  measures this and moves each table into a Bun Worker if event-loop lag passes a threshold.
- One slow or idle player costs the others time at the table, limited by the clock and the
  disconnect grace period.
- New hidden-information leak paths, all of which need tests: cross-seat message routing, the
  seed, per-seat logs, setup errors, post-game unlock timing, and lobby metadata (deck names
  and commanders are hidden from other players until the game starts; display names are shown).
- Decision 12 has an audit of today's client calculations in the plan (milestone M2). It fixes
  an existing inconsistency: a land creature is in the lands pile in the spectator seat panel
  but on the battlefield in the player board, because each view checks `typeLine` its own way.
  It is worth doing before any multiplayer work, and it makes the JSON agent client and any later
  client simpler, since none of them re-derive presentation.
- The engine produces a little more presentation data and the server a little more work per
  decision: indexing one legal menu per human decision, which is small next to bot search. Player
  frames get slightly larger, offset by dropping `LegalAction.data` from them.
- **When to extract a `packages/match` package:** when the table server must be deployed without
  the tester's AI-bench, batch or coverage dependencies, or when the lint boundary in decision 1
  needs more than a handful of exceptions. Until then, a separate package only adds build and
  versioning overhead.

## Alternatives considered

- **Split into two repositories** (tester and multiplayer). Rejected. Both sides depend on the
  engine and card definitions, which change with every card-coverage PR, and the card gate would
  have to run in both repositories or the engine be published as a versioned package. The
  product split is a deployment boundary, which two entry points provide without the cost.
- **Add multiplayer to the existing `WsServer`.** Rejected. The tester's message set
  (`jumpToTurn`, `setPlaybackMode`, `resolveHeldDecision`, `setDebugFlags`,
  `startCardTestScenario`) and its "everything unlocks at game end" debug surfaces would all
  have to be fenced off one by one behind a mode check, and missing one would leak. A separate
  entry point that never registers those handlers fails closed.
- **Keep presentation derivation in the browser.** Rejected. With several players, each
  browser would derive the same facts separately and could disagree. Every client would repeat
  the logic. Parsing engine text and untyped `data` breaks silently when the engine changes.
- **Build presentation inside the engine as finished strings.** Rejected. The rules-engine
  constraints keep UI logic out of `packages/engine`. The engine supplies typed facts and the
  server writes the words.
- **Peer-to-peer or client-hosted engine.** Rejected. It puts every hand and the seed on every
  player's machine.
- **Accounts and public matchmaking first.** Deferred. Invite-link tables cover play among
  friends without storing passwords or emails. Accounts can sit in front of seat tokens later.

## Open questions

These have defaults above. Changing one changes the plan, not this ADR's structure.

1. Audience: invite-link tables for friends (default) or public matchmaking?
2. Hosting: one player's machine on a LAN (default first target), a VPS behind TLS, or a managed
   host?
3. Clock default: `relaxed` (default) or `off` for casual tables?
4. Timeout policy: fallback bot (default) or always pass when a pass is legal?
5. Do humans bring their own decks (default), or can the host assign supported-pool decks?
6. Decision 12 goes as far as presentation. Should combat-plan composition
   (`apps/web/src/stores/combatPlan.ts`) also move to the server as an incremental proposal
   that the server validates on each click? Default: no. It already composes only from
   engine-offered options and submits one proposal the engine validates, so moving it would add a
   round trip per click for little gain.
