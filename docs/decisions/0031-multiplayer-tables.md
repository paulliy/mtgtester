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
humans needs no new engine concept. Every surfaced decision is already logged as a `decision`
event in `game_events` with the exact submitted response (`engine.ts`, "a game can be replayed
exactly from the log").

The server and protocol are where single-player is assumed:

- `WsServer` holds one `session`, one `playerSocket` and one `sessionToken` (`ws/server.ts`).
- `MatchSession` holds one `humanSeat` and one each of its connection gate, smart-yield memory,
  ignored-ability map, player revision and last human decision (`match/session.ts`).
- The session has one `send` sink. In player mode it formats the log for `humanSeat`, and the
  WebSocket server forwards every message to the single player socket.
- About 30 branches in the server and session test `gameMode === 'singlePlayer'`.
- The server binds `127.0.0.1` and allows only loopback origins. The testing guide says to keep
  it that way "unless an authenticated remote-sharing design is explicitly approved". This ADR
  is that design, and it needs explicit approval before any non-loopback listener ships.
- `gameStarted` sends the game seed to the client. With one human, that only lets the player
  spoil their own game. Between people it is a cheat: the seed and a decklist are enough to
  work out library order.

The browser also derives game facts on its own. It never decides legality, but it classifies
cards by matching text in `typeLine`, builds cost and option labels by parsing the untyped
`LegalAction.data`, rewrites the engine's prompt text with a regex, holds the 21-point
commander-damage rule, and guesses combat hits by comparing board snapshots. One of these is
already wrong. The projection's `typeLine` is the printed type line (`perm.typeLine` in
`view/spectator.ts`), while power, toughness and keywords there come from
`computeCharacteristics`. So an animated manland that is attacking still reads "Land", and the
player board puts it in the lands pile. The spectator panel and the player board also disagree
about land creatures, because each checks `typeLine` its own way. With several players, every
browser would make these same derivations independently.

Two constraints shape the fix. First, `LegalAction.data` cannot move or change. The AI context
serializes `legalActions` verbatim (`ai/context.ts`), and the heuristic bot reads `data`
(`bot/src/evaluate.ts`, `combat-search.ts`, `veto.ts`), so changing it would change AI prompts
and fixed-seed bot games. Second, turn snapshots of `SpectatorState` are stored in SQLite and
replayed later, so any new projection field is missing from older saved games (which is why
`isToken` and `colors` are optional today).

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
   `projectSetupProblems`, and the presentation from decision 12) goes only to that seat's
   socket. During a live player game, nothing carrying `spectatorState()`, AI reasoning notes,
   debug events or the seed goes out on any channel.

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
   fires, so a timeout changes which legal action is chosen, exactly as a human does. That is
   already covered: the engine logs every surfaced decision as a `decision` event in
   `game_events`, with the exact `submittedResponse` (action id, targets, modes, X, splits,
   order). Replaying those responses into a fresh engine with the same seed reproduces the
   game, which is the guarantee the rules-engine constraints require. The only new record is
   who answered: the server writes the source (`human`, `timeout`, `fallback`, `bot`) to a
   small `game_decision_sources` table keyed by game id and request id. The engine does not
   change.

   The same `decision` events also store `submittedResponse.note`, which is AI reasoning. It
   stays in the server database; per-seat logs are built from event descriptions only, and a
   test confirms a note never reaches a player frame.

9. **Network exposure is opt-in and narrow.** `serve:table` binds loopback by default. Binding
   any other address requires `--host` plus a configured `TABLE_ALLOWED_ORIGINS` allowlist, and
   the server refuses to start without both. Outside a LAN, TLS is terminated by a reverse proxy
   (documented, not built in). The table server applies size limits on messages and deck
   imports, rate limits on each socket and each IP address, and caps on tables, sockets and
   concurrent games. Display names are length-limited and rendered as text only. Browser and
   server ship from the same repository, but an open tab can outlive a server upgrade, so the
   table protocol carries a version and the client reloads when it changes.

10. **LLM seats are off by default.** A table may use an LLM provider only when the host's
    environment configures a key. That table then has a fixed call budget (ADR 0010) shown in
    the lobby. Heuristic and random bots need no configuration.

11. **Persistence matches today's.** Table games are recorded in SQLite: the table server's own
    database file by default, or the tester's if configured. They use the existing `game_mode`
    and `controller_kind` columns, the existing `decision` events, and the
    `game_decision_sources` table from decision 8 (an additive migration that rewrites no
    historical rows). A server restart ends live games, as in ADR 0018. Restoring a game by
    replaying its logged decisions is a possible later step (see the plan) and is not promised
    here.

12. **The server computes; the client renders.** Every value a player sees that comes from
    rules or engine data is computed on the server, typed, and projected per seat before it is
    sent. The client may lay out the board, animate, remember unsent input, and keep display
    preferences, including cosmetic thresholds such as low-life styling. It may not parse engine
    text (prompts, log lines, action descriptions), read `LegalAction.data`, classify cards from
    `typeLine`, hold rules constants, or infer game events by comparing board snapshots.

    The work splits three ways:
    - **Engine projection** (`view/spectator.ts`):
      - Adds the permanent's current `types`, `supertypes` and `subtypes` from
        `computeCharacteristics`, so they reflect continuous effects the way power, toughness
        and keywords already do. A face-down permanent already computes as a plain Creature
        (CR 708.2).
      - Adds `isToken` on every projected card.
      - These fields are optional in `shared`, because older saved snapshots lack them.
      - The rules logic is unchanged.
    - **Server presentation** (`match/presentation.ts`, new): composes everything else per seat.
      - Action labels, cost labels, X-value families, payment sources, a per-source index of
        the legal menu, the player-facing prompt, commander-damage cells, the game-over
        summary, and presentation events for animation.
      - Reads `LegalAction.data` where it needs to, so this is the one module outside the
        engine, AI and bot code that interprets `data`. Its keys are declared once in `shared`
        as `LegalActionData`, and the engine's construction sites check against that type with
        `satisfies`. `data` keeps its runtime shape, so AI prompts and bot behavior do not
        change.
      - Builds from the seat's player projection and the already-filtered legal menu, never
        from `GameState`.
      - Is built after smart-yield filtering, so it never shows a yielded action.
    - **Client:** renders those fields.

    Three rules protect hidden information and history:
    - **Face-down redaction becomes an allowlist.** The player board redacts a face-down
      permanent by copying every field and then overriding a fixed list, so a new field leaks
      unless someone remembers to add it. The redaction is rewritten to build the redacted
      permanent field by field from an allowlist, and a test fails when `SpectatorPermanent`
      gains a field the allowlist does not cover.
    - **Legacy snapshots are filled on the server.** When an older snapshot without `types` is
      loaded (`GameRecorder.loadTurnSnapshot`), the server fills it from the printed type line
      before sending it, the same derivation the client used. This is a documented read-time
      derivation, not a rewrite of stored rows.
    - **The table server stops sending `LegalAction.data` to players.** The tester's player
      socket keeps sending it, because the JSON agent client's documented contract publishes
      `legalActions` exactly as received. The browser does not read it in either build, and a
      lint test enforces that.

    Preferences that decide whether a seat is asked to act, such as the unplayed-land reminder,
    move to the server alongside smart yield, so they agree with automatic passing and the
    decision clock.

## Consequences

- A table seats one to four humans with bots in the rest. A one-human table on the table server
  is not single-player mode: it plays under table rules (clock, hidden seed, no debug).
- Single-player on the tester is unchanged for users, apart from decision 12's fixes (animated
  lands and land creatures are classified by their current types). Its code path becomes the
  one-human case of the seat-controller model, so the existing single-player tests must pass with
  no changes to what they assert.
- The JSON agent client (`bun run agent-client`) can later sit in a table seat with a seat token,
  which gives scripted multi-human tests at no extra cost. At a table it receives presentation
  instead of `data`.
- All tables run on the server's one event loop at first. The bounded combat search (ADR 0024)
  limits each bot decision, but several tables with bots can still delay each other. The plan
  measures this and moves each table into a Bun Worker if event-loop lag passes a threshold.
- One slow or idle player costs the others time at the table, limited by the clock and the
  disconnect grace period.
- New hidden-information leak paths, all of which need tests: cross-seat message routing, the
  seed, per-seat logs, AI notes stored in decision events, setup errors, post-game unlock timing,
  new projection fields on face-down permanents, presentation events about hidden objects, and
  lobby metadata (deck names and commanders are hidden from other players until the game starts;
  display names are shown).
- Decision 12 has an audit of every client calculation in the plan (milestone M2). It is worth
  doing before any multiplayer work: it fixes the animated-land bug and the view disagreement,
  and it makes the agent client and any later client simpler, since none of them re-derive
  presentation.
- The server does a little more work per human decision: indexing one legal menu, which is small
  next to bot search. The projection gains three short type arrays per permanent;
  `computeCharacteristics` already runs for every projected permanent.
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
  the logic. Parsing engine text and untyped `data` breaks silently when the engine changes, and
  the printed `typeLine` the browser reads is not the permanent's current type.
- **Move `data` out of `LegalAction` into typed presentation.** Rejected. AI prompts serialize
  `legalActions` verbatim and the heuristic bot reads `data`, so this would change prompts, AI
  benchmark baselines and fixed-seed bot games. Typing `data` with `satisfies` gets compile-time
  checking without changing a byte on the wire.
- **Build presentation inside the engine as finished strings.** Rejected. The rules-engine
  constraints keep UI logic out of `packages/engine`. The engine supplies typed facts and the
  server writes the words.
- **A separate `game_decisions` table for replay.** Rejected. The engine's `decision` events
  already record the exact submitted responses. A second copy could drift from the first. Only
  the decision's source is missing.
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
6. Should combat-plan composition (`apps/web/src/stores/combatPlan.ts`) also move to the
   server? Default: no. It composes only from engine-offered options and submits one proposal
   the engine validates, so moving it would add a round trip per click for little gain.
