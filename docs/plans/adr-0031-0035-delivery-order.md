# Delivery order for ADRs 0031 to 0035

Status: In progress. Baseline: `ec1b000` (2026-10-28).

This plan orders the work across five ADRs. It does not repeat them. Each step points at the plan
that owns its detail:

| ADR                                                               | Status   | Owning plan                                                                         |
| ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| [0031](../decisions/0031-multiplayer-tables.md) multiplayer       | Accepted | [multiplayer tables](multiplayer-tables.md) (M1 to M7)                              |
| [0032](../decisions/0032-server-computed-presentation.md)         | Accepted | [server-computed presentation](server-computed-presentation.md) (P1 to P6)          |
| [0033](../decisions/0033-forge-informed-card-authoring.md)        | Accepted | [card authoring and fail-loud](card-authoring-and-fail-loud.md) (phases 2, 5, 6)    |
| [0034](../decisions/0034-fail-loud-execution-and-strict-tests.md) | Accepted | [card authoring and fail-loud](card-authoring-and-fail-loud.md) (phases 0, 1, 3, 4) |
| [0035](../decisions/0035-table-diplomacy-and-deals.md) deals      | Accepted | phases 1 to 4 done; [integration](multiplayer-diplomacy-integration.md) for tables  |

## Why this order

- **The harness first.** `packages/engine/tests/fixtures.js` is tracked and older than
  `fixtures.ts`, and the extensionless import resolves to it, so about 300 test files run a stale
  harness. Every later result depends on the real one running.
- **Loudness before refactors.** ADR 0031 adds engine entry points (`Engine.concede`, the step
  budget, replay events) and splits every per-player structure in the session. Strict drivers,
  `EngineInvariantError` and reference validation make those refactors fail at the line that broke.
- **Independent presentation steps in parallel.** P1 (the `data` key registry) and P3 (label code
  into `shared`) depend on nothing and can run beside 0034.
- **Tables in milestone order, exposure last.** M5 gates exposure beyond the host machine and
  needs ADR 0031 accepted; until it lands `serve:table` refuses to start without `--dev`.
- **Authoring speed on top of loud foundations.** `card:new` needs 0034's pin store and scenario
  runner; the keyword registry and typed results are adopted card by card.
- **Deals at tables last.** Human deals at a table need M4's clocks, and the integration plan's
  event-sourced reducer conflicts with ADR 0035 decision 22 (saved snapshot). That conflict is
  settled before the work starts.

## Steps

Each step is one or more pull requests. A step's exit is the exit of the plan it points at.

| #   | Work                                                                         | Depends on | Owning section                    |
| --- | ---------------------------------------------------------------------------- | ---------- | --------------------------------- |
| 1   | 0034 phase 1 step 1: delete the stale harness, add the guard                 | none       | card-authoring phase 1.1          |
| 2   | 0034 phase 0: authoring baseline metrics                                     | none       | card-authoring phase 0            |
| 3   | 0034 phase 1 steps 2 to 10: invariant error, references, `optionAt`, drivers | 1          | card-authoring phase 1            |
| 4   | 0032 P1 and P3: `data` key registry; label code into `shared`                | none       | presentation P1, P3               |
| 5   | 0031 M1: seat controllers, `'table'` mode, fail-closed mode switches         | 3          | multiplayer M1                    |
| 6   | 0031 M2a and M2b: hidden-information fixes, replay hardening, ChaCha20       | 5          | multiplayer M2a, M2b              |
| 7   | 0032 P2, P4, P5: projection types, server enrichment, raw-data capability    | 4, 5, 6    | presentation P2, P4, P5           |
| 8   | 0034/0033 phase 2: pin store, scenario runner, `card:*` commands, gate list  | 3          | card-authoring phase 2            |
| 9   | 0031 M3, M4: table server on loopback with workers; clocks and fallback bots | 6, 7       | multiplayer M3, M4                |
| 10  | 0032 P6: damage and life cues                                                | 9 (M3)     | presentation P6                   |
| 11  | 0034 phases 3 and 4: manifest references, IR mutation, invariants, fuzz      | 8          | card-authoring phases 3, 4        |
| 12  | 0031 M5, M6: exposure (needs ADR 0031 accepted); web lobby and table play    | 9, 10      | multiplayer M5, M6                |
| 13  | 0033 phases 5 and 6: keyword registry, provenance, typed results, pilot      | 8, 11      | card-authoring phases 5, 6        |
| 14  | Deals at tables; ADR 0035 later vocabulary                                   | 9, 12      | multiplayer-diplomacy-integration |

## Decisions needed from the owner

- **Accepting ADRs 0031 to 0034.** Decided 2026-10-29: all four accepted, so M5 may start.
- **ADR 0031 open questions.** Decided 2026-10-29: the defaults stand. LAN with `--insecure-lan`
  first, `relaxed` clock, host cannot assign pool decks.
- **Reducer or snapshot for table deals** (step 14), before that step starts.

## Rules for every step

- Subagents per `CLAUDE.md`: Haiku explorers for search and test triage, Sonnet implementers for
  mechanical work from a written decision, never Opus. Rules-correctness choices in
  `packages/engine` stay on the main thread.
- Fixed-seed event streams, decision requests and snapshots do not change unless the step says so.
  An engine-changing pull request re-seals benchmark pins with
  `bun run ai-bench refresh --suite core-fast --write` in a `chore(benchmarks)` commit.
- Before each push: `bun run typecheck`, `bun run lint`, `bun run format:check`, the affected
  tests, and `bun run snapshots:check` for engine changes.

## Progress

| Step | State | Done so far                                                                                                                                             | Pull request |
| ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1    | done  | stale harness deleted; harness-integrity guard                                                                                                          | #44          |
| 2    | done  | `scripts/card-authoring-metrics.ts`; `docs/reviews/card-authoring-baseline-2026-10-28.md`                                                               | #44          |
| 3    | done  | phase 1 done: scope reads are invariants per kind; every test file collects a test (`check:suite-collect`)                                              | #44          |
| 4    | done  | P1 data-key registry; P3 label code in `@mtg/shared/presentation`                                                                                       | #44          |
| 5    | done  | M1 seat controllers: `'table'` mode, per-seat state, fail-closed switches                                                                               | #44          |
| 6    | done  | M2a disclosure policy, privacy fixes, replay inputs and harness; M2b ChaCha20 and streams                                                               | #44          |
| 7    | done  | P2 projection types and board groups; P4 server presentation; P5 raw `data` on request, lint                                                            | #44          |
| 8    | done  | phase 2: pin store, script/strict pump, scenario runner and lab adapter, card:check/new/finish, gate list, mini-pilot                                   | #44          |
| 9    | done  | M3 workers, health, manifest, post-game, agent table mode, scans; M4 clocks, fallback, concede                                                          | #44          |
| 10   | done  | P6: server-built damage and life cues on each batch; the board animates from them                                                                       | #44          |
| 11   | done  | phase 3: manifest refs, IR mutation (all reviewed cards proven), facets; phase 4: invariants, zone lint, tap sites, fuzz, nightly bulk job, diagnostics | #44          |
| 12   | done  | M5 exposure, TLS run, review; M6 table app, lobby, table bar, post-game, table e2e and CI job                                                           | #44          |
| 13   | doing | phase 5 deferred by its go/no-go; phase 6 draw rule (`pilot:draw`) ready, waiting on Scryfall access to draw                                            | #44          |

## Notes from delivery

- **Engine work limits (M3 task 6).** Calibrated over every Card Test Lab scenario and six seeded
  four-bot games capped at 40 turns: at most 63 events in one `advance()` and 436 objects in one
  game. The defaults stay at 50,000 and 20,000 (`match/engine-limits.ts`), because ten times that
  sample would halt long games and board wipes it did not cover.
- **A slow bot game.** One of those six games (`calibrate-0`) took 12 minutes, against 6 to 14
  seconds for the others. Worth profiling before table clocks depend on bot speed.
- **Lobby choices (M3).** A display name that matches another after folding lookalike characters
  is refused at join, since names must be unique within a table. A seat whose deck fails at start
  is vacated, so the corrected deck goes through host approval again.
- **One prompt still parsed in the browser (P5).** `OpeningHand.vue` reads the "put N more" count
  from the mulligan prompt; no presentation field carries it. The fix is an engine-emitted count.
- **Table routes (M3).** The socket is `GET /tables/:id/ws`, and an invite link is
  `/t/<id>#<invite>`, so the invite stays in the fragment and out of request logs. The summary
  endpoint takes the invite in the POST body. To be confirmed before M6.
- **Workers get their cards from the main thread (M3).** A worker receives the supported pool
  and the cards the approved decklists resolve to, not the bulk file, so starting a table game
  costs no second multi-second Oracle load, and every worker sees exactly the cards the
  claim-time check resolved against.
- **A `gameStarted` per seat (M3).** `GameServer` sends a single player's start frame itself, so
  the session port now builds one per human seat through the table policy (no seed, other seats'
  tags withheld) and re-sends it when a seat resyncs.
- **The scripted run (M3 exit).** `table-scripted-run.ts` plays two `first-legal` agent clients and
  two bots to a 6-turn cap in real workers in about 7 seconds; the scan read 18 hand ids and
  found no violation over 135 frames.
- **A concession mid-cast (M4).** `Engine.concede` throws into the game generator, so a cast in
  progress rewinds through its checkpoint, event counter included. Its events may already have
  been flushed, so the concession carries a sequence floor and `conceded` is numbered after
  them; otherwise the database would drop it on conflict and the runner's cursor would skip it.
- **The fallback bot and replay (M4).** Replay reads responses, never who gave them, so a game
  with timeout and fallback answers that ends at its time limit replays to the same hash
  (`replay-from-log.test.ts`), now that the harness replays `chacha20` games and `conceded`.
- **Open from M3: the scry cadence test.** The hub sends a seat a board only when its projection
  changed and the runner sends no empty batch, which is what keeps another seat's hidden decision
  from adding frames; an end-to-end test with a scripted opponent scry is still to be written.
- **Unmodeled cards in a table deck** are reported to that seat as `unresolved` with the card
  name; a dedicated problem code can follow if the lobby needs to tell them apart.
- **Three table servers in the e2e (M6).** The plan asks for one server; the scenarios need
  three settings that cannot share a process (a lightly scaled clock for play, a clock scaled
  down 120 times for a timeout, and a one-event engine budget for a forced halt), so
  `playwright.table.config.ts` runs three, each serving the same built bundle from its own
  origin. Two development-only settings serve them: `TABLE_HOST_SECRET` and
  `TABLE_MAX_STEP_WORK`.
- **The host plays too (M6).** A host sees the lobby before joining and joins by name like anyone
  else to take a seat; the invite comes from the address fragment or, for the host, the table
  state.
- **Smart yield at a table (M6).** A person is offered priority only when they have something
  to do, so the e2e yields an instant (Fell the Profane) that opens every window and checks the
  next opponent's upkeep and draw are no longer offered.
- **Card Test Lab failures that predate this work.** Four lab scenarios fail on this machine
  both at `095d955` (before this delivery's code) and now: Master Warcraft, Hunted Phantasm,
  Vindictive Lich (`chooseTargetPlayer`), and Aetherworks Marvel positive. They are left for the
  card-coverage track; CI's `viewer-evidence` job is the reference once Actions runs again.
  `player-game.spec.ts` also failed there: its seed no longer deals Forests. It now plays
  whichever basic the seed deals, discards at cleanup when it must, and passes into its next turn,
  so it passes again as M6 requires.
- **The runner yields on time as well as steps (M6).** With every seat bot-driven (a lone player
  away at a table), late-game steps took 350 to 400 ms each, so 200 steps between yields held a
  table worker's thread for over a minute: it answered no health probe and read no
  `resumeControl`. `MatchRunner` now also yields every 50 ms. The table e2e found it.
- **Slow steps.** Those 350 to 400 ms `advance()` calls in a four-seat game deserve a profile
  alongside the slow bot game noted above.
- **Scope reads (phase 1 step 4 tail).** Every scope-reading `Value` kind throws
  `EngineInvariantError` at `values.<field>` on an absent field, one kind per commit. Making all
  eight throw at once over the engine and card suites found one provider gap, the enters scope
  for a permanent not cast with Treasure mana (Kalain), which now states 0.
- **Empty suites (phase 1 step 9 tail).** `check:suite-collect` lists every runner's tests and
  fails on a tracked file that collects none. Five server suites build their tests from the
  untracked Scryfall bulk file; they declare it with `// suite-requires:` and the run lists them
  as not run while it is missing, which is always so in CI. About 2.5 minutes, nearly all Vitest
  collection; it runs after the full suite in the engine job.
- **Phase 2 exit (card authoring).** In a worktree at `e61a3d9`, `card:finish`'s binding step
  wrote all five evidence generators byte-identical to `da2e2c6` and its re-seal wrote both pins
  identical to `da2e2c6`; `card-new-handled-lines.test.ts` shows `card:new`'s handledLines
  interpret every PR11b card exactly as the authored lines do. The mini-pilot is recorded in
  [the pilot review](../reviews/card-authoring-mini-pilot-2026-10-29.md).
- **Manifest references (phase 3 step 2).** The first run found 595 of 3,463 IDs naming no test
  or several. Most were prose summaries or a test's ID with its description run on; titles now
  read `<id> — <what it shows>`, and parametrized templates print their IDs unquoted and whole
  (Vitest truncates a quoted `$id` past 40 characters). Shared tests on stand-in cards moved to a
  clause's `contractTestIds`. Path to Exile's two IDs named a bulk-only suite; rather than grow the
  `notExecutableInCi` list, its runner scenarios are its evidence, with a declined search added.
  The check lists the Vitest collection: about 2.5 minutes in the card-verification job.
- **IR mutation (phase 3 steps 3 to 5).** The first run over the 168 reviewed cards killed 602 of
  859 mutants; 66 cards had nothing left to prove
  ([report](../reviews/ir-mutation-reviewed-cards-2026-10-30.md)). Most survivors were a mandatory
  trigger made optional, which `pump()`'s default yes hides. Once tests asserted the missing
  amounts and "no yes/no first", and loaded the card where they had built its ability by hand, the
  second run killed 847 and recorded 12 as equivalent: every reviewed card is proven. The run takes 28 minutes for all
  reviewed cards at about 1 second per mutant; the CI job runs only a pull request's changed
  reviewed cards after a 2.5-minute listing. Each card runs in its own child process, because a
  mutant can exhaust a test worker's heap (Celebrate the Mountain-king's widened target slot) and
  Vitest then exits. Facet warnings flag 47 reviewed cards, advisory until a facet finds a real
  defect outside its fixture.
- **Fuzz (phase 4 step 4).** `bun run fuzz` plays four of the 13 coverage decks per seed, with
  heuristic, random or mixed seats, under the invariants and the table limits. Twelve seeds with
  four jobs on four cores: median 29 seconds a game, most 120. Heuristic-only games end in 32 to 48
  turns; random players seldom finish, so a pod with one plays to the turn cap, and the cap fails
  only heuristic-only games. The first run found three engine defects, each fixed with a
  regression: the stateful mana planner deep-copied the spectator snapshots and logs at every
  searched state (one turn took 225 seconds); its capacity bound was off beside a dynamic source,
  so proving eight sources could not pay nine mana halted the game; and the layer digest missed a
  player's loss, so a cached Nighthawk Scavenger kept that player's graveyard. The pull-request
  job runs six seeds plus three per changed pinned card; the nightly job plays the next 48 seeds
  and opens or updates an issue. The liveness report waits for the diagnostics sink (step 6).
- **Nightly bulk data (phase 4 step 5).** The five suites that skip without the Scryfall bank
  run nightly from a checksum-pinned download, and the job fails on any skip; `bun run
bulk-smoke` interprets and validates the whole bank and fails on a throw, invalid modeled IR or
  fewer modeled cards than the baseline recorded for that bank. The same smoke runs in the suite
  over the 958-card coverage fixture. Scryfall is unreachable from the build container, so the job
  was exercised on a synthetic bank only; the pin and first baseline are the owner's.
- **Diagnostics (phase 4 step 6).** `noop(ctx, site, reason, detail?)` and
  `invariant(site, reason)` live in `engine/src/exits.ts`. `invariant` takes no context: it
  records nothing and only throws. The reasons start with the three the first sites need (CR
  608.2b, 400.7, 609.3). The first `noop` sites are the referent skips for an illegal target and a
  departed trigger object, so the liveness report is empty on the first fuzz seeds; it fills as
  cards touch ops. Nothing is recorded without a sink, and a game plays the same with one.
- **Phase 5 deferred by its go/no-go (step 13).** Of the 1,058 distinct cards in the pinned
  fixtures, which hold all 200 EDH staples, 52 are unmodeled and none is blocked only by a missing
  keyword: they wait on adventure and omen spell faces (46), invalid IR (4), one unrecognized
  creature line and one explicitly unsupported trigger. The keyword registry and line provenance (phase 5 steps 1 and 2) wait for the first card
  a keyword blocks. The bulk ranking is still owed where the bank exists.
- **Phase 6 pilot draw.** Decided 2026-10-30: the 20 pilot cards are new to the project, not the
  52 unmodeled pinned ones, 46 of which wait on the same spell-face feature. `bun run pilot:draw`
  takes, from the Scryfall bank, the 20 best EDHREC-ranked commander-legal cards that no fixture
  pins, are not adventure or omen cards, and do not interpret; a seeded hash splits them 10 and 10. It records the draw and the bank's hash in `docs/reviews/card-authoring-pilot-draw.json`.
  Scryfall is not reachable from the build environment, so the draw waits for the bank.
- **Two hash definitions for pins.** Pins before PR08 hashed a card's JSON with sorted keys; later
  ones hash it as written. The pin store keeps the manifest's key and accepts either.
