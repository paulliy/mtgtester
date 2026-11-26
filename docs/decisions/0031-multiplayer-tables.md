# ADR 0031: Multiplayer tables

Status: Accepted (2026-10-29)

Date: 2026-10-27

**Scope.** This ADR covers private tables for people who know each other. Public matchmaking
breaks the trust assumptions below and would need its own ADR.

**What this changes in earlier decisions.**

- **Supersedes in part** [0018](0018-single-player-mode.md):

  - decision 1 (one human seat);
  - decision 4 (the human is untimed);
  - decision 5 (every bot pauses while the human is away);
  - the 0018 deferral of multiple humans.

  0018 decision 7 still holds (replay and debug unlock only after the game ends), and decision 3
  below narrows what unlocks.

- **Amends** [0030](0030-manual-mana-activation.md). The fallback bot of decision 7 sees its
  seat's menu without manual-mana options. Ordinary bots still never opt in.
- **Amends** [rules-engine constraints](../guides/rules-engine-constraints.md). The rule
  "timing, wall clocks, and provider/network behavior must not alter fixed-seed engine
  outcomes" is restated as decision 8 has it.

Plan: [multiplayer tables](../plans/multiplayer-tables.md). Related:
[ADR 0032](0032-server-computed-presentation.md) (server-computed presentation).

## Context

A game today has zero human seats (`spectator`) or exactly one (`singlePlayer`). Several people
should be able to sit at one Commander table, each in their own browser, with bots in any empty
seats. Unlike single-player, the people at a table do not see each other's hands and may try to.

What already works:

- **The engine is authoritative.** `Engine.submit()` accepts only an action it offered.
- **Each seat gets a redacted board.** `Engine.playerState(seat)` redacts hands, libraries,
  face-down identities and private log lines.
- **Humans and bots share one interface.** A human seat is an `AsyncDecisionProvider`, as the
  bots are.
- **Decisions are sequential.** They come one at a time, and the rules make mulligans and votes
  sequential in turn order (CR 103.5, CR 701.38).
- **Decisions are logged.** Every surfaced decision is logged as a `decision` event with the exact
  `submittedResponse` (`engine.ts:235-287`).

What assumes one trusted human:

- **One of everything.**
  - `GameServer` (`ws/server.ts:119`) holds one `session`, one `playerSocket` and one
    `sessionToken`.
  - `MatchSession` holds one `humanSeat` and one each of its connection gate, smart-yield
    memory, ignored abilities, revision counter and last human decision.
  - `StrategyCoordinator` takes one `humanSeat` (`ai/strategy-coordinator.ts:207`).
  - Every bot decision waits on the single connection gate.
- **Mode branches fail open.** About 38 branches test `gameMode === 'singlePlayer'`. Some are
  information fences:

  - the halt reason (`session.ts:300`);
  - debug events;
  - escalation of a failed legal menu;
  - AI annotation release (`match/annotations.ts:43`).

  A new mode would fall into the spectator branch.

- **The server is loopback-only.** It binds `127.0.0.1` and allows only loopback origins. The
  testing guide keeps it that way "unless an authenticated remote-sharing design is explicitly
  approved". This ADR is that design.

What a hostile player could exploit today:

- **The RNG has a 32-bit key space.** `Prng` hashes the seed string with 32-bit FNV-1a
  (`rng/prng.ts:23-30,38-39`), so any seed gives at most 2^32 games. The default seed is 8 hex
  characters (`ws/server.ts:788`). A player who knows their decklist and opening hand can search
  every state offline and learn their future draws and every later random result.
- **The seed is in every player frame.** It travels in `gameStarted`, in every player board frame
  (`buildPlayerBoardState` spreads the spectator state, which carries `seed`), and in the game
  report. It also lives in `EngineState.seed`, the `gameStart` event, snapshots, the
  `games.seed` column, and the bot seeds (`${seed}-${seat}`, `session.ts:1209`).
- **Global counters leak activity.** The request id carries a per-game counter of surfaced
  decisions (`engine.ts:442`), and log lines carry the global event sequence. Gaps in what a
  player receives count how often other seats had a real choice, and how many filtered events
  (draws, scries, private choices) happened.
- **Commanders and yields are broadcast.** Commander views report a commander's hidden zone (hand
  or library) and object id to everyone (`view/spectator.ts:143-170`). Every seat's
  `yieldingUntilEndOfTurn` goes to everyone. `SeatSummary.archetypeTag`, which a classifier
  computes from the hidden decklist, goes to everyone in `gameStarted`.
- **Errors pass through raw.** Raw error messages go out on the non-single-player error paths
  (`ws/server.ts` `startGame`, `session.ts:300`). The `engineHalt` log line carries the raw
  reason.
- **Redaction is a deny list.** Face-down permanents and exile cards are redacted by copying
  every field and overriding a fixed list. Face-down exile is detected by two special cases. The
  player-log filter is a deny list of three decision types.
- **Replay needs more than the log.** `Engine.cancelYield` changes state without an event. The
  game config is not stored, and `ENGINE_VERSION` is a fixed string.
- **Engine steps are synchronous.** `engine.advance()` runs synchronously (`match/runner.ts:352`)
  and resolves forced decisions in a loop. A runaway step blocks the whole process, and a timer
  cannot interrupt it.

The repository is also the card-coverage and AI test bench. Its Card Test Lab, batches, AI
benchmarks and debug views show every hand by design and must never be reachable from a table.

## Decision

1. **One repository, two server entry points.** `bun run serve` stays the loopback-only tester.
   `bun run serve:table` runs table games only. Both share `packages/engine`, `packages/bot`,
   `packages/shared` and `packages/server/src/match`. Table code lives in
   `packages/server/src/table/`.

   - `no-restricted-imports` blocks direct imports from `table/` into tester modules.
   - A module-graph test of the table entry fails if it reaches `batch/`, `benchmark/`, or any
     module that registers Card Test Lab scenarios. This is needed because imports are
     transitive: `match/session.ts` reaches `ai/`, which imports `benchmark/` contracts. The test
     lists each allowed exception with a reason.
   - A `packages/match` package is extracted only if that list grows past a handful of entries.

2. **Each seat gets its own controller, and mode checks fail closed.**

   - The session takes `seatControllers: Record<PlayerId, SeatControllerKind>`, and `GameMode`
     gains `'table'`. Every per-player structure becomes a map keyed by seat, including the
     strategy coordinator's human seats.
   - Every mode branch becomes a `switch` ending in `assertNever`, so a new mode fails
     typecheck until each branch is decided.
   - The first implementation of each `'table'` branch is the most restrictive choice. Decision 3
     then makes those choices explicit.
   - In table mode a bot never waits on a human's connection gate.
   - Single-player keeps today's behavior.

3. **Disclosure is an injected, deny-by-default policy.** Each entry point constructs the session
   with a `DisclosurePolicy` covering:

   - the public game label;
   - debug events;
   - AI annotations, per seat;
   - AI cost reports;
   - raw error and halt reasons;
   - archetype tags;
   - decklists and the RNG key;
   - the full-state replay unlock.

   Every field defaults to deny. The tester's policy reproduces today's behavior. The table's
   policy:

   - unlocks replay, decklists and the RNG key only after the game ends;
   - never sends debug events;
   - never sends raw errors or halt reasons, only a fixed message;
   - never sends another seat's AI notes;
   - never sends an archetype tag before the game ends: a human seat's tag goes only to that
     seat, and a bot's tag, which a classifier computes from its secret generated list, is
     withheld from everyone;
   - never sends AI cost reports (`apiWaiting`), because token counts track a bot's hand.

   Per-seat content goes only to that seat's socket, and public frames go only to sockets bound
   to a seat at that table. Both send paths check an allowlist of message types, and the
   allowlist depends on the table's phase. Full-state types (`replayUnlocked`, `replayTurnState`)
   are allowed only once the table is `finished`. The check runs on the main thread, after the
   worker boundary, so a worker bug cannot route them early. Anything not allowed throws in tests
   and is dropped in production.

   After the game ends, the main thread serves the post-game view and replay from the stored
   game in the table database, never from the worker. Before worker startup, the main thread
   commits a start-attempt manifest containing approved deck snapshots, the game id, key,
   build/card-data identity and limits. If a worker is terminated, the main thread atomically
   records `workerFailure` for a still-running game and finishes the table. A failure before
   game creation is `setupFailed`; neither creates an engine result or counts as a win/draw.
   A genuine already-committed outcome wins a race with termination. Players can still see the
   decks, key, fixed interruption reason and the explicitly bounded committed replay range;
   a manifest-only attempt has no replay. No interrupted turn is presented as a complete game.
   A typed preparation/validation failure instead retires its private attempt and returns to
   `open`, sending only private deck problems and no key/replay unlock. A corrected retry gets
   a fresh attempt/key; bot snapshots must be persisted before a worker reports ready.
   Worker generations are fenced and terminated before terminal commit and full unlock.
   `hostAbandon` follows that same sequence with a distinct `hostAbandoned` interruption reason.

   A **halted** game counts as finished for the table. That covers an engine halt, the step
   budget, an unmodeled card and a draw loop. Players get a fixed message, the table moves to
   `finished`, and the post-game unlock applies. Today a halt goes to `recordHalt` and never
   reaches `onGameOver` (`match/runner.ts:589-611`). Raw `LegalAction.data` is not a policy field. ADR 0032 decision 7
   handles it as a client capability on every server.

4. **Table games use a cryptographic RNG whose key never enters game state.**

   - `GameConfig` gains `rng: 'legacy' | 'chacha20'` and `rngKey`, a 32-byte key.
   - `seed` remains a public label. For `chacha20` it is a random display id and never feeds
     randomness.
   - The key lives only in the RNG object and in the stored config. It is never in
     `EngineState`, events, snapshots or frames until the game ends.
   - The table server refuses to start a game unless `rng` is `chacha20` with a 32-byte key, so
     a missing field cannot silently downgrade.
   - The key comes from `crypto.getRandomValues`. The only exception is a fixed test key, allowed
     under the development mode in decision 9.
   - The engine's RNG becomes an `EngineRng` interface. Today it is the `Prng` class type
     (`state/types.ts:986`).
   - The ChaCha20 implementation holds all mutable state as plain number properties, because the
     casting checkpoint rewinds `ctx.rng` by walking and reassigning its own properties
     (`casting/checkpoint.ts:43`). Typed arrays and private fields would break that rewind.
   - `clone()` keeps its meaning: an independent stream at the current position.
   - **Every consumer gets its own stream.** Each stream has a fixed, distinct nonce:

     - the game;
     - each bot seat;
     - each fallback bot;
     - each bot seat's generated decklist.

     A test asserts that no two consumers share a key and nonce. A `random` bot's choices are
     raw draws from its stream, so a shared stream would reveal the game's shuffles.

   - Bots take an injected `{ nextInt }` source. The bot package does not import the engine.
   - Pool decks for bot seats are generated from their own stream, not from the public label.
     Today they use `Prng(gameSeed-seatN)` (`match/setup.ts:290`).
   - **Why pure TypeScript:**
     - the engine is synchronous, and WebCrypto's cipher API is asynchronous;
     - the engine must stay free of platform I/O;
     - ChaCha20 is short to implement and has published test vectors (RFC 8439).
   - The tester keeps `legacy`, so fixed-seed games, benchmarks and stored replays are unchanged.

5. **Per-seat wire ids and cadence.** Table frames hide counters and timing that reveal other
   seats' activity.

   - **Request ids** are a per-seat counter. The session translates them back to engine ids
     before the human provider sees them, and memoizes the mapping so re-sent requests keep their
     id. Auto-passed decisions do not advance the counter.
   - **Log lines and cues** carry a per-viewer sequence.
   - **A seat's board/decision revision** counts only board/decision frames sent to that seat.
     A pending action pins its own revision; clock/status telemetry and health probes never
     invalidate it. Display revisions and current socket authority are separate concerns.
   - **Board snapshots** are sent only when that seat's projection changed. Today the revision is
     bumped, and a snapshot sent, on every engine advance (`session.ts:274-278`), so the frame
     rate tracks every seat's activity.
   - **Object ids and card ids** are not translated, and their gaps are an accepted risk stated
     below. Cues never carry card ids.

6. **Tables, hosts, seats and tokens.**

   - **Creating a table.** The server prints a **host secret** at startup, and it is used only to
     create a table. Creating one returns a table-scoped **host token** (256 bits) and an
     **invite code** (128 bits, in the URL fragment). Table ids are random.
   - **Failed attempts are throttled.** Failed host-secret, host-token and invite attempts are
     throttled per client address, and every comparison is constant-time.
   - **Claiming a seat needs the host's approval.** A player claims a seat with a unique display
     name and a **plaintext** decklist.
     - The decklist is parsed in memory with the plaintext parser directly, not through
       `importDeck`, which sniffs for a URL and would fetch it (`decks/source.ts:33`). Saved-deck
       ids, pool decks and URL imports are not accepted from remote players.
     - **The host approves each claim by its claim id.** That stops one client filling every
       seat with one shared invite, and approval by claim id cannot pick the wrong claimant.
     - Pending claims are capped per table, per socket and per client address.
     - The host and the claimant both see a short verification code for each claim, so the host
       can tell the person who asked from someone using their name. Display names are also
       compared after removing lookalike characters.
     - The host can rotate the invite code while the table is `open`, which cuts off a denied or
       kicked player.
     - Deck problems go only to that player.
     - A deck is written to the table server's database only after approval, under table-scoped
       ids.
   - **The host plays like any other player.** The host's own seat is a claim the host approves.
     The host's browser holds the host token on its lobby connection and a seat token on its
     game connection, one seat per game connection.
   - **Seat tokens.** An approved claim gets a seat token (256 bits): the seat's identity on
     every message, alongside the existing revision, ownership, action-id and target checks. The
     browser keeps it in `localStorage` under the table id until the table ends.
     - One socket holds one seat.
     - A second socket with the same token takes over the seat, and the first socket is told.
       A client told it was taken over does not reconnect on its own, and takeovers are
       rate-limited.
     - Every inbound game message must come from the current socket generation bound to that
       table and seat. A superseded socket is refused even when its request id/revision are valid.
       Invite-only lobby sockets never receive player frames after game start.
   - **What the host can and cannot do.** The host never sees a seat token. Kick, approve, seat
     changes and start are allowed only before the game starts, and joining closes at the start.
     Kick, deny, leave and seat changes revoke the old seat token. A player who loses their token
     after the start loses the seat to the fallback bot. An eliminated player's seat has no clock.
     That player keeps receiving their own redacted view until the game ends.

7. **Clocks bound stalling.**

   - Presets are `relaxed` and `standard`. `off` is allowed only in development mode
     (decision 9).
   - Each decision has a free 10-second allowance. Most priority responses take less, so
     routine play costs nothing. Smart yield and the engine's quiet-window passing skip routine
     windows entirely.
   - Time beyond the allowance comes from a bank: 20 minutes relaxed, 10 standard. That allows
     several long turns and combats per player in a game that commonly runs 60–90 minutes in
     paper. The values are starting points, to be tuned from recorded table games.
   - A disconnected seat waits for a 60-second grace period, charged to a cumulative 5-minute
     disconnect budget. The decision clock is paused while the grace period runs, so the same
     time is never charged twice.
     Reconnect resumes the same pending choice and remaining allowance/bank. It does not renew
     spent grace or budget; repeated disconnects during that choice share its remaining grace.
   - The game has a wall-clock cap: 4 hours relaxed, 3 hours standard. These are well beyond a
     normal game and exist only to end abandoned tables. When the cap is reached, the server
     ends the game as a draw for every player still in it, through a new engine entry point,
     `Engine.concede(players, 'drawByTimeLimit')`, which emits an event and replay applies like
     `yieldCancelled`. The event is emitted from `playGame`'s catch, after the casting
     checkpoint's rewind (`casting/cast.ts:1225-1234`) has restored the event log, so a game
     conceded mid-cast does not lose it.
   - **A deliberate draw is a real outcome, not a halt.** Today every result with no winner is
     recorded as a halt labeled "probable rules bug" (`match/runner.ts:598-606`, brief §4). A
     game result gains an `endReason` (`'rules'` by default, or `'timeLimit'`, `'allAway'`). The
     runner records a no-winner result as a halt only when `endReason` is `'rules'`. A
     `'timeLimit'` or `'allAway'` result goes through `persistOutcome` and `onGameOver` as a draw,
     shows the standings with that reason, and counts in stats as a draw. This amends brief §4:
     a drawn game is a bug only when the rules engine produced it.
   - **When every human has been gone past their disconnect budget,** the table ends the same
     way, with `'allAway'`.
   - **The fallback bot** answers when the clock runs out or the grace period ends. It is always
     a heuristic bot, never an LLM.
     - It sees the menu without manual-mana options (the amendment to 0030).
     - Any note is stripped from its response.
     - The seat's revision is bumped before it starts, so a late human answer is stale.
   - After three timeouts in a row, or once the grace period ends, the seat stays with the
     fallback bot until its player sends `resumeControl`, which requires a connected socket with
     the seat token. The next decision then goes to the human.

8. **Replay: reproducible from stored inputs on the same build.** A clock decides _when_ a
   timeout fires, so a timeout chooses a legal action just as a human does. The rules-engine
   constraint is restated as: a game is reproducible from its stored config, key and recorded
   inputs.

   Three changes make that true:

   - `Engine.cancelYield` emits `yieldCancelled` when it changes state, and `Engine.concede`
     emits its own event.
     - Replay applies each one when the engine's next event sequence equals the event's sequence,
       checked after both `advance()` and `submit()`, and fails loudly on any mismatch.
     - `yieldCancelled` is filtered out of the AI's recent log (`view/view.ts` `visibleEvent`),
       so it never changes an AI prompt.
   - The `games` row stores `config_json`: a hash of the card data the game ran on (the same
     sha256 the game report already computes, since the Oracle data is not in git), deck snapshot
     ids rather than full card objects, plus
     manual mana per seat, turn cap, RNG kind and key, and the engine options, including the step
     budget. It also stores the build commit and dirty flag from `build-info.ts`. Card Test Lab
     games, which start from a prepared engine, store none.
   - Replay is checked with state hashes, in tests only. It is promised only on the same build,
     and it ends at the last recorded event, whether a game ended, was capped or was abandoned.

   Separately, `game_decision_sources` records who answered each request: `human`, `auto` (a
   smart-yield pass), `timeout`, `fallback` or `bot`. That is for attribution and stats; replay
   does not need it.

   Games that never call `cancelYield` or `concede` (every game with no human seat) keep
   byte-identical event streams.

9. **Isolation and exposure do not depend on the bind address.** A reverse proxy or a tunnel
   (cloudflared, Tailscale Funnel) connects to 127.0.0.1, so a loopback bind can still face the
   internet.

   Three rules follow:

   - **The table server always runs each table in its own Bun Worker.** The main thread relays
     messages and probes worker health every 5 seconds. A worker answers probes while waiting
     for a human or timer. Thirty seconds of unanswered probes ends that worker; lack of game
     progress alone does not. A blocked synchronous computation cannot answer and is terminated.
     The engine step budget handles tight emitting loops sooner. Worker generations fence late
     replies, and health traffic is never forwarded to players or counted in seat revisions.
   - **The engine gains a deterministic step budget.** It is counted in the event emitter, so a
     runaway inside a single generator step is caught. The counter is a shared object, because effect
     resolution copies the context by spreading it (`effects/resolve.ts:1693`), and a plain number
     would be copied by value. The halt event is exempt, and `advance()` handles the budget error
     in its own branch. It is set
     in `EngineOptions`, so it stays out of state hashes, and it is stored with the game. Pure
     computation that emits nothing is bounded only by the worker.
   - **Development mode** (`--dev`) is the only mode that allows clock `off` and a fixed test RNG
     key. In it the server refuses any request whose `Host` or `Origin` is not loopback, and it
     refuses to start with any proxy or allowlist setting.

   Everything else is production mode:

   - It serves the table web build itself, from the same origin as its WebSocket, so the
     invite link, the origin check and `wss` all refer to one origin. It builds invite links
     from `TABLE_PUBLIC_ORIGIN`.
   - It requires an origin allowlist, a host-name allowlist, and TLS, through a proxy or a
     certificate. The server refuses to start without them.
   - `--insecure-lan` allows plain `ws://` on a private network. It requires peers in private
     address ranges, and refuses a loopback peer that sends a non-loopback `Host` unless a proxy
     is configured. Every player sees a warning that tokens can be sniffed on that network.
   - Throttles delay a client address rather than lock it out, so one outsider cannot shut
     everyone else out of a table.
   - Origin checks are defense in depth; tokens are the access control.
   - Limits:
     - `maxPayloadLength` on the socket;
     - a pre-authentication timeout;
     - concurrent sockets per client address, using the rightmost forwarded-for entry added
       by the configured proxy, and only when one is configured;
     - outbound backpressure and an idle limit per socket;
     - a cumulative cap on objects created per game, enforced by the engine and halting the game
       (the per-advance step budget cannot bound a total);
     - messages per socket;
     - claims per socket;
     - decklist size.
   - Pages are sent with a `frame-ancestors 'none'` content security policy, so the lobby cannot
     be framed and clicked through.
   - The protocol carries a version, and a stale tab reloads.
   - Static files are served only from the web build's manifest, never from a directory path. The
     table database lives outside the served directory. Tests cover encoded `..` paths.
   - **Until M5 lands, `serve:table` refuses to start without `--dev`.** Production mode and its
     gates ship together, so no earlier build can be exposed.

10. **LLM seats are not offered at tables yet.** _(Amended by [ADR 0055](0055-claude-bots-at-tables.md): a host may give a table's bots to Claude, with a per-game call cap.)_ Their cost reports leak, as decision 3 notes. No
    per-game call cap exists to bound a host's spending. And a table must answer within its clock.
    Table bot seats are heuristic or random. LLM seats at tables need their own design, with a
    per-table call cap. Post-game reflection (ADR 0022) is off for tables.

11. **Persistence.** Table games are recorded in the table server's own SQLite file through
    additive migrations, and no historical rows are rewritten. A restart ends live games.
    Restoring one from stored inputs is possible later and is not promised here.

12. **Hidden-information fixes for every player game.** These also apply to single-player:

    - **Commander views** show a commander's zone, object id and art only to its owner, when it is
      in a hand or library or is face down. Others see `hidden`.
    - **`yieldingUntilEndOfTurn`** goes only to its own seat.
    - **Allowlists, with a coverage test.** These become allowlists:

      - face-down permanent redaction;
      - exile redaction;
      - the player-log filter, which classifies every decision type
        (`satisfies Record<DecisionType, boolean>`) and keeps an explicit list for event types
        (`draw`, `scry`, `surveil`, and the new `yieldCancelled`).

      A test fails when a projected type gains a field the allowlist doesn't cover.

    - **Face-down exile** gets a first-class flag, set where an object moves face down
      (`moveObject`).
    - **The `engineHalt` log line** shows a fixed text to players.

13. **Presentation follows ADR 0032.** Table views read server-computed presentation.

## Trust assumptions and accepted risks

- **The host sees everything.** The host runs the server; its database and memory hold every hand
  and the key. The lobby says so.
- **Waiting is a tell.** The engine passes priority for a player with nothing to do, so a visible
  wait means that player has a real option. Arena has the same tell. Hiding it would mean
  stopping everyone at every window. Padded stops are a follow-up.
- **Object ids are global.** They are minted on every zone move and share a counter with effect
  and delayed-trigger ids (`state/objects.ts:248,1116`). Gaps in the ids a player sees reveal how
  many hidden moves and effect creations happened, not what they were. Per-viewer object ids are
  a follow-up. Until then this is accepted for tables among friends.
- **The fallback bot plays your hand** while you are away or out of time.
- **Card ids follow decklist order.** They persist across zones (`state/game.ts:48-71`). They
  appear only where the projection already shows a card, and cues use object ids, so this reveals
  nothing a player cannot already see.
- **The public commander narrows a bot's deck.** A bot's generated deck has its own secret stream,
  but its commander is public. That is no more than a human player's commander reveals. Its
  archetype tag, which would reveal more, is withheld until the game ends.
- **What per-seat ids buy.** Request ids, revisions, frame cadence and log sequences hide how often
  other seats had a real choice and how many private events happened. Object-id gaps reveal a
  different count (hidden moves and effects). Both are counts, not contents. Hiding the first
  set is cheap and ships in M3; hiding the second needs per-viewer object ids and is a follow-up.

## Consequences

- A table seats one to four humans with bots in the rest, under table rules: clock, ChaCha20,
  key hidden until the end, no debug.
- Single-player gains decision 12's fixes. Its RNG, seeds and fixed-seed games are unchanged.
- The JSON agent client gains a table mode and is the multi-human test harness from the first
  table milestone.
- New leak paths need tests: routing, the key, per-seat ids, AI notes, commander zones, yield
  flags, archetype tags, error text, new projection fields, and post-game unlock timing. A frame
  scan cannot detect RNG predictability or timing tells, which is why decision 4 and the trust
  assumptions address them directly.
- Worker isolation, the engine step budget and the clocks all land before the table is exposed to
  a network.

## Alternatives considered

- **Split into two repositories.** Rejected. Both depend on the engine and card definitions, which
  change with every card-coverage PR. Two entry points give the deployment split.
- **Add tables to the existing `GameServer` behind mode checks.** Rejected. Mode checks already
  fail open in the session. A separate entry point and a deny-by-default policy fail closed.
- **Hide the seed but keep the legacy RNG.** Rejected. That leaves a 2^32 offline search.
- **Use ChaCha20 for every game.** Rejected. It would change every fixed-seed game, benchmark
  baseline and stored replay.
- **A timer watchdog.** Rejected. A timer cannot interrupt a synchronous step. The engine budget
  and worker termination can.
- **One shared invite with no approval.** Rejected. One client could take every seat.
- **Host token reissue mid-game.** Rejected. It lets the host take over a seat.
- **A `game_decisions` table.** Rejected. Decision events already hold the exact responses.
- **Peer-to-peer play.** Rejected. Every hand and the key would sit on every machine.

## Resolved questions

Decided by the owner on 2026-10-29, when this ADR was accepted:

1. Hosting default: LAN with `--insecure-lan` is the first target; TLS behind a proxy is also
   supported.
2. Default clock: `relaxed`.
3. The host cannot assign supported-pool decks.
