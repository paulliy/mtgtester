# ADR 0031: Multiplayer tables

Status: Proposed

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
- **Amends** [rules-engine constraints](../guides/rules-engine-constraints.md). "Timing must not
  alter fixed-seed outcomes" is restated as decision 8 has it.

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
  `submittedResponse` (`engine.ts:235-275`).

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
   - raw error and halt reasons;
   - archetype tags;
   - the full-state replay unlock.

   Every field defaults to deny. The tester's policy reproduces today's behavior. The table's
   policy:
   - unlocks replay, decklists and the RNG key only after the game ends;
   - never sends debug events;
   - never sends raw errors or halt reasons, only a fixed message;
   - never sends another seat's AI notes;
   - never sends archetype tags for human seats.

   Per-seat content goes only to that seat's socket, and public frames go only to sockets bound
   to a seat at that table. Raw `LegalAction.data` is not a policy field. ADR 0032 decision 7
   handles it as a client capability on every server.

4. **Table games use a cryptographic RNG whose key never enters game state.**
   - `GameConfig` gains `rng: 'legacy' | 'chacha20'` and `rngKey`, a 32-byte key.
   - `seed` remains a public label. For `chacha20` it is a random display id and never feeds
     randomness.
   - The key lives only in the RNG object and in the stored config. It is never in
     `EngineState`, events, snapshots or frames until the game ends.
   - The table server refuses to start a game unless `rng` is `chacha20` with a 32-byte key from
     `crypto.getRandomValues`, so a missing field cannot silently downgrade.
   - The engine's RNG becomes an `EngineRng` interface. Today it is the `Prng` class type
     (`state/types.ts:986`).
   - The ChaCha20 implementation holds all mutable state as plain number properties, because the
     casting checkpoint rewinds `ctx.rng` by walking and reassigning its own properties
     (`casting/checkpoint.ts:43`). Typed arrays and private fields would break that rewind.
   - `clone()` keeps its meaning: an independent stream at the current position.
   - Bots and the random provider take an injected `{ nextInt }` source. Each bot seat gets its
     own domain-separated stream (a distinct nonce), so bot tie-breaks reveal nothing about the
     game stream. The bot package does not import the engine.
   - **Why pure TypeScript:**
     - the engine is synchronous, and WebCrypto's cipher API is asynchronous;
     - the engine must stay free of platform I/O;
     - ChaCha20 is short to implement and has published test vectors (RFC 8439).
   - The tester keeps `legacy`, so fixed-seed games, benchmarks and stored replays are unchanged.

5. **Per-seat wire ids.** Table frames carry a request id that is a per-seat counter, which the
   server maps back on submit. Log lines carry a per-viewer sequence. Object ids are not
   translated; their gaps are an accepted risk, stated below.

6. **Tables, hosts, seats and tokens.**
   - **Creating a table.** The server prints a **host secret** at startup, and it is used only to
     create a table. Creating one returns a table-scoped **host token** (256 bits) and an
     **invite code** (128 bits, in the URL fragment). Table ids are random.
   - **Failed attempts are throttled.** Failed host-secret, host-token and invite attempts are
     throttled per client address, and every comparison is constant-time.
   - **Claiming a seat needs the host's approval.** A player claims a seat with a unique display
     name and a **plaintext** decklist. Saved-deck ids, pool decks and URL imports are not
     accepted from remote players. **The host approves each claim.** That is what stops one
     client filling every seat with one shared invite. Deck problems go only to that player.
     Table decks are stored in the table server's own database under table-scoped ids, and
     unclaimed ones are removed.
   - **Seat tokens.** An approved claim gets a seat token (256 bits): the seat's identity on
     every message, alongside the existing revision, ownership, action-id and target checks. The
     browser keeps it in `localStorage` under the table id until the table ends.
     - One socket holds one seat.
     - A second socket with the same token takes over the seat, and the first socket is told.
       A client told it was taken over does not reconnect on its own, and takeovers are
       rate-limited.
   - **What the host can and cannot do.** The host never sees a seat token. Kick, approve, seat
     changes and start are allowed only before the game starts, and joining closes at the start.
     A player who loses their token after the start loses the seat to the fallback bot.

7. **Clocks bound stalling.**
   - Presets are `relaxed` and `standard`. `off` is allowed only on a loopback bind.
   - Each decision has a free 10-second allowance. Most priority responses take less, so
     routine play costs nothing. Smart yield and the engine's quiet-window passing skip routine
     windows entirely.
   - Time beyond the allowance comes from a bank: 10 minutes relaxed, 5 standard. That allows a
     few long turns per game, about what friends playing paper Commander tolerate.
   - A disconnected seat waits for a 60-second grace period, charged to a cumulative 5-minute
     disconnect budget.
   - The game has a wall-clock cap: 3 hours relaxed, 2 hours standard. When it is reached, the
     game ends as a draw for every player still in it.
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
   - `Engine.cancelYield` emits `yieldCancelled` when it changes state. Replay applies the
     cancel when the engine's next event sequence equals the event's sequence, and fails loudly
     on any mismatch.
   - The `games` row stores `config_json` (the full `GameConfig`: decks, manual mana per seat,
     turn cap, RNG kind and key) and the build commit and dirty flag from `build-info.ts`.
   - Replay is checked with state hashes, in tests only. It is promised only on the same build,
     and it ends at the last recorded event, whether a game ended, was capped or was abandoned.

   Separately, `game_decision_sources` records who answered each request: `human`, `auto` (a
   smart-yield pass), `timeout`, `fallback` or `bot`. That is for attribution and stats; replay
   does not need it.

   Games that never call `cancelYield` (every game with no human seat) keep byte-identical
   event streams.

9. **Isolation and network exposure.** Two mechanisms bound runaway steps:
   - **An engine budget.** The engine gains a deterministic step budget for each `advance()`:
     a cap on forced resolutions and events. Hitting it halts the game with the existing
     engine-halt path.
   - **One Bun Worker per table.** It is required before any non-loopback bind. The table server
     relays messages and `terminate()`s a worker that misses a heartbeat.

   Exposure is opt-in:
   - `serve:table` binds loopback by default.
   - Any other bind needs an origin allowlist, a host-name allowlist, and TLS, through a proxy
     or a certificate. The server refuses to start without them.
   - `--insecure-lan` allows plain `ws://` on a private network. Every player then sees a
     warning that tokens can be sniffed on that network.
   - Origin checks are defense in depth; tokens are the access control.
   - Limits:
     - `maxPayloadLength` on the socket;
     - a pre-authentication timeout;
     - concurrent sockets per client address, using a trusted forwarded-for header only when
       behind the configured proxy;
     - messages per socket;
     - claims per socket;
     - decklist size.
   - The protocol carries a version, and a stale tab reloads.

10. **LLM seats are off by default.** A table may use an LLM bot only when the host's environment
    configures a key. Such a table has a fixed call budget (ADR 0010) shown in the lobby.
    Post-game reflection (ADR 0022) is off for tables unless the host enables it.

11. **Persistence.** Table games are recorded in the table server's own SQLite file through
    additive migrations, and no historical rows are rewritten. A restart ends live games.
    Restoring one from stored inputs is possible later and is not promised here.

12. **Hidden-information fixes for every player game.** These also apply to single-player:
    - **Commander views** show a hand or library zone and object id only to the owner. Others see
      `hidden`.
    - **`yieldingUntilEndOfTurn`** goes only to its own seat.
    - **Allowlists, with a coverage test.** These become allowlists:
      - face-down permanent redaction;
      - exile redaction;
      - the player-log decision-type filter, using `satisfies Record<DecisionType, boolean>`.

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

## Open questions

1. Hosting default: LAN with `--insecure-lan` (default first target), or TLS behind a proxy?
2. Default clock: `relaxed` (default) or `standard`?
3. Should the host be able to assign supported-pool decks? Default: no.
