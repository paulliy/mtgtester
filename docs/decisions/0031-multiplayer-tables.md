# ADR 0031: Multiplayer tables

Status: Proposed

Date: 2026-10-27

Supersedes in part: [0018](0018-single-player-mode.md) decisions 1, 4 and 5 (one human seat, an
untimed human, every bot pausing while that human is away), and the 0018 deferral of multiple
humans. 0018 decision 7 (unlock replay and debug only after the game ends) applies per seat,
with the narrower disclosure in decision 3 below. Everything else in 0018 and 0019 still holds.

Plan: [multiplayer tables](../plans/multiplayer-tables.md). Related:
[ADR 0032](0032-server-computed-presentation.md) (server-computed presentation).

## Context

A game today has zero human seats (`spectator`) or exactly one (`singlePlayer`). Several people
should be able to sit at one Commander table, each in their own browser, with bots in any empty
seats. Unlike single-player, the people at a table may not trust each other.

What already works:

- **The engine is authoritative.** `Engine.submit()` accepts only an action it offered.
- **Each seat gets a redacted board.** `Engine.playerState(seat)` redacts hidden information:
  opponents' hands and libraries, face-down identities, and private log lines.
- **Humans and bots share one interface.** A human seat is an `AsyncDecisionProvider`, as the
  bots are.
- **Decisions are sequential, as the rules require.** They come one at a time, and the rules make
  mulligans and votes sequential in turn order anyway (CR 103.5, CR 701.38).
- **Decisions are logged.** Every surfaced decision is logged as a `decision` event with the exact
  `submittedResponse` (`engine.ts:235-275`). Forced decisions are resolved by the engine itself
  and not logged.

What assumes one trusted human:

- **One of everything.**
  - `WsServer` holds one `session`, one `playerSocket` and one `sessionToken`.
  - `MatchSession` holds one `humanSeat` and one each of its connection gate, smart-yield
    memory, ignored abilities, revision counter and last human decision.
  - `StrategyCoordinator` takes one `humanSeat`.
  - Every bot decision waits on the single connection gate.
- **Mode branches fail open.** About 35 branches test `gameMode === 'singlePlayer'`. Several
  are information fences:
  - the halt reason (`session.ts:300`);
  - debug events;
  - escalation of a failed legal menu;
  - AI annotation release (`match/annotations.ts:38`).

  A new mode that is not `'singlePlayer'` would fall into the spectator branch and receive
  spectator-level detail.

- **The server is loopback-only.** It binds `127.0.0.1` and allows only loopback origins. The
  testing guide keeps it that way "unless an authenticated remote-sharing design is explicitly
  approved". This ADR is that design.

What a hostile player could exploit today:

- **The RNG has a 32-bit key space.** `Prng` hashes the seed string with 32-bit FNV-1a before
  seeding (`rng/prng.ts:23-30,38-39`), so any seed gives at most 2^32 possible games, however long
  it is. The default seed is 8 hex characters (`ws/server.ts:788`). A player who knows their own
  decklist and sees their opening hand can search every state offline and learn their future
  draws and every later random result.
- **The seed is sent to the player.** It goes out in `gameStarted`, in every player board frame
  (`buildPlayerBoardState` spreads the spectator state, which carries `seed`), and in the game
  report.
- **Commander views reveal hidden zones.** They report which zone each commander is in, and its
  object id, even when that zone is an opponent's hand or library (`view/spectator.ts:143-170`).
- **Yield state is broadcast.** Every seat's `yieldingUntilEndOfTurn` goes to everyone, which
  tells opponents who will not respond this turn.
- **Human decisions reach LLM bots in full.** `StrategyCoordinator.recordDecision` stores a
  human's full action description, which names face-down and foretold cards, in context that LLM
  bots read.
- **Redaction is a deny list.** Face-down permanents and exile cards are redacted by copying
  every field and overriding a fixed list, so a new field leaks unless someone remembers it. The
  player log filter is also a deny list.
- **Replay is not reproducible from the log alone.**
  - `Engine.cancelYield` changes engine state outside any decision and logs nothing.
  - The game config (each seat's manual-mana setting, the turn cap) is not stored.
  - `ENGINE_VERSION` is a fixed string.

The repository also serves as the card-coverage and AI test bench. Its Card Test Lab, batches,
AI benchmarks and debug views show every hand by design and must never be reachable from a
table.

## Decision

1. **One repository, two server entry points.** `bun run serve` stays the loopback-only tester.
   A new `bun run serve:table` runs table games only. Both share `packages/engine`,
   `packages/bot`, `packages/shared` and `packages/server/src/match`. Table code lives in
   `packages/server/src/table/`.

   Two checks enforce the separation:
   - `no-restricted-imports` blocks direct imports;
   - a test builds the table entry's module graph and fails if it reaches `batch/`,
     `benchmark/` or the Card Test Lab.

   The second check is needed because imports are transitive: `match/session.ts` imports
   `ai/`, which imports `benchmark/` contracts. The session's tester-only dependencies are either
   separated behind interfaces or listed as allowed in that test, with a reason for each.
   Extracting a `packages/match` package is deferred until that list grows past a handful of
   entries.

2. **Each seat gets its own controller, and mode checks fail closed.**
   - The session takes `seatControllers: Record<PlayerId, SeatControllerKind>`, and
     `GameMode` gains `'table'`. Every per-player structure becomes a map keyed by seat,
     including the strategy coordinator's human seats.
   - Each mode branch becomes an exhaustive `switch` or a named predicate (`isPlayerGame`,
     `revealsSpectatorDetail`), so a new mode fails typecheck until each branch is decided.
   - In table mode, a bot never waits on a human's connection gate. Only that human's own seat
     waits.
   - Single-player keeps today's behavior.

3. **Disclosure is an injected, deny-by-default policy.** Each entry point constructs the
   session with a `DisclosurePolicy` covering:
   - the seed;
   - debug events;
   - AI annotations;
   - halt reasons;
   - raw `LegalAction.data`;
   - full-state replay unlock.

   Every field defaults to deny. The tester sets today's values. The table server leaves the seed
   and replay to unlock at game end, and never enables debug, raw halt reasons or other seats'
   AI notes. Per-seat content goes only to that seat's socket. Public frames go only to sockets
   bound to a seat at that table.

4. **Table games use a cryptographic RNG, and the key stays secret until the game ends.** Hiding
   the seed alone is not enough while the key space is 2^32.
   - `GameConfig` gains `rng: 'legacy' | 'chacha20'`. The engine creates its RNG in one place
     (`state/game.ts:166`).
   - `chacha20` is a pure-TypeScript ChaCha20 stream keyed with 256 bits from
     `crypto.getRandomValues`, checked against the RFC 8439 test vectors. It is deterministic
     given the key, so replay still works.
   - The table server uses it, and derives bot RNG streams from the same key.
   - The tester keeps `legacy`, so fixed-seed games, benchmarks and existing replays are
     unchanged.
   - The key is removed from `gameStarted`, from every player board frame, and from the game
     report until the game is over.

5. **Tables, seats and tokens.**
   - **Creating a table requires a host secret.** The server prints it at startup, and only
     someone with it can open a table.
   - **Inviting.** The host shares an invite code (128 random bits, in the URL fragment). A
     player joins with a display name and a **plaintext** decklist. Saved-deck ids, pool decks
     and URL imports are not accepted from remote players. Deck problems go only to that player.
     Table decks are stored in the table server's own database, under ids that are not shared
     with other tables.
   - **Seat tokens.** Claiming a seat returns a seat token (256 random bits): the seat's identity
     on every message, checked alongside the existing revision, ownership, action-id and target
     checks. The browser keeps it in `localStorage` under the table id, until the table ends.
     One socket holds one seat. A second socket using the same token takes the seat over, and the
     first socket is told.
   - **What the host can and cannot do.** The host never sees a token. The host can kick and
     reassign seats only before the game starts. Joining closes at the start. After the start, a
     player who loses their token loses the seat to the fallback bot.

6. **Decision clocks bound stalling.** Each table picks `relaxed` or `standard`. `off` is
   allowed only on a loopback bind.
   - Each decision has a short free allowance (10 seconds); time beyond it comes out of a bank
     (10 minutes relaxed, 5 standard). Smart yield and the engine's own quiet-window passing mean
     routine priority costs nothing.
   - Each seat has a cumulative disconnect budget, and the game has a wall-clock cap.
   - When a clock runs out, the seat's **fallback bot** answers. It is always a heuristic bot,
     never an LLM.
     - It sees the menu without manual-mana activations, which it has never been designed for.
     - Any reasoning note is stripped from its response.
     - The seat's revision is bumped before it starts, so a late human answer is rejected as
       stale.
   - After three timeouts in a row, the fallback bot plays the seat until the player acts again.

7. **A disconnect waits, but only for a while.** A disconnected human's decision waits for a grace
   period, which is charged to the disconnect budget. Then the fallback bot plays the seat until
   the player reconnects with the seat token. Reconnecting resyncs the board, the player-safe
   log, yield preferences and the pending choice, as single-player does today.

8. **Replay: reproducible from what is stored, on the same build.** A wall clock decides _when_ a
   timeout fires, so a timeout picks a legal action just as a human does. The rules-engine
   constraint is then met in this form: a game is reproducible from its stored configuration,
   key and recorded inputs.

   Four changes make that true:
   - `Engine.cancelYield` logs a `yieldCancelled` event, and replay applies it at the same point.
   - The `games` row stores the full `GameConfig` (deck snapshots, manual mana per seat, turn
     cap, RNG kind) and the build commit (`build-info.ts`).
   - A `game_decision_sources` table records who answered each request: `human`, `auto` (a
     smart-yield pass), `timeout`, `fallback` or `bot`. The source is tagged before the session's
     `onDecision` runs, so timeouts are not recorded as human decisions.
   - Replay is checked with state hashes, reusing the benchmark replay hashing in tests only.
     Replay is guaranteed only on the same build.

9. **Network exposure is opt-in and narrow.**
   - `serve:table` binds loopback by default.
   - Any other bind requires three things, and the server refuses to start without them:
     - an origin allowlist;
     - a host-name allowlist;
     - TLS, through a reverse proxy or a certificate.

     `--insecure-lan` allows plain `ws://` on a private network, with a warning shown to every
     player that tokens can be sniffed there.

   - Origin checks are defense in depth, not access control. Tokens are the access control.
   - Limits: a pre-authentication timeout, concurrent sockets per IP address, messages per socket,
     maximum frame size and deck size.
   - A watchdog ends a table whose single engine step runs past a time budget, so one table cannot
     stall the event loop for every other table.
   - The protocol carries a version, and a stale tab reloads.

10. **LLM seats are off by default.** A table may use an LLM bot only when the host's
    environment configures a key. That table has a fixed call budget (ADR 0010) shown in the
    lobby. Post-game reflection (ADR 0022) is off for tables unless the host enables it.

11. **Persistence.** Table games are recorded in the table server's own SQLite file. The new
    tables and columns are additive migrations, and no historical rows are rewritten. A restart
    ends live games. Restoring a game from its stored inputs is a possible later step and is not
    promised here.

12. **Hidden-information fixes, applied to every player game.** These also make single-player
    more correct:
    - Commander views show a hand or library zone and object id only to the owner. Other seats
      see `hidden`.
    - `yieldingUntilEndOfTurn` is sent only to its own seat.
    - The strategy coordinator records human decisions by their public description.
    - Face-down permanent redaction, exile redaction and the player-log filter become
      allowlists. A test fails when a projected type gains a field the allowlist does not cover.
    - Face-down exile is redacted by a first-class flag, not by two specific cases.

13. **Presentation follows ADR 0032.** Table views read server-computed presentation only. Player
    sockets receive raw `LegalAction.data` only when the client asks for it, which the browser
    never does.

## Trust assumptions and accepted risks

- **The host sees everything.** The host runs the server, so the SQLite file and process memory
  hold every hand and the RNG key. The lobby says so.
- **Waiting is a tell.** The engine passes priority automatically for a player with nothing to do,
  so "waiting on Alice" during your turn means Alice has a real option. Arena has the same tell.
  Hiding it would mean stopping every player at every priority window. A padded-stop table
  option is listed as a follow-up, not built.
- **One person can hold several seats** by using several invites, because there are no accounts.
  Tables are for people who know each other.
- **Object ids are a global counter.** Gaps between public ids reveal how many hidden zone moves
  happened. The risk is low, and renumbering ids per viewer is deferred.
- **The fallback bot plays your hand** while you are away or out of time.

## Consequences

- A table seats one to four humans with bots in the rest. A one-human table on the table server
  plays under table rules: clock, cryptographic RNG, key hidden until the end, no debug.
- Single-player on the tester gains decision 12's fixes. Its RNG, seeds and fixed-seed games are
  unchanged.
- The JSON agent client can sit at a table with a seat token. That is the multi-human test
  harness from the table server's first milestone onward.
- New leak paths need tests: cross-seat routing, the key, AI notes, commander zones, yield state,
  new projection fields, lobby metadata, and post-game unlock timing. A frame scan cannot detect
  RNG predictability or timing tells, which is why decisions 4 and the trust assumptions address
  them directly.
- One slow or absent player costs the others time, bounded by the clock, the disconnect budget
  and the game cap.

## Alternatives considered

- **Split into two repositories.** Rejected. Both depend on the engine and card definitions,
  which change with every card-coverage PR. The product split is a deployment boundary, which two
  entry points provide.
- **Add multiplayer to the existing `WsServer` behind mode checks.** Rejected. Missing one check
  leaks, and the session already shows mode checks failing open. A separate entry point and an
  injected deny-by-default policy fail closed.
- **Hide the seed but keep the legacy RNG.** Rejected. It leaves a 2^32 space to search offline.
- **Make the cryptographic RNG the default for every game.** Rejected. It would change every
  fixed-seed game, benchmark baseline and stored replay.
- **A `game_decisions` table duplicating the decision events.** Rejected. The engine's events
  already hold the exact responses; only their source, the config and the yield cancel are
  missing.
- **Let the host reissue tokens mid-game.** Rejected. It lets the host take over any seat and read
  its hand.
- **Peer-to-peer or client-hosted engine.** Rejected. It puts every hand and the key on every
  player's machine.
- **Accounts and public matchmaking first.** Deferred. Invite tables cover play among friends.

## Open questions

Defaults are chosen above; changing one changes the plan, not this ADR's structure.

1. Audience: invite tables for friends (default) or public matchmaking?
2. Hosting: a LAN with `--insecure-lan` (default first target), or a VPS behind TLS?
3. Default clock: `relaxed` (default) or `standard`?
4. Should the host be able to assign supported-pool decks? Default: no, players bring their own.
