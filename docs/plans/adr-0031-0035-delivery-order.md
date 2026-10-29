# Delivery order for ADRs 0031 to 0035

Status: In progress. Baseline: `ec1b000` (2026-10-28).

This plan orders the work across five ADRs. It does not repeat them. Each step points at the plan
that owns its detail:

| ADR                                                               | Status   | Owning plan                                                                         |
| ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| [0031](../decisions/0031-multiplayer-tables.md) multiplayer       | Proposed | [multiplayer tables](multiplayer-tables.md) (M1 to M7)                              |
| [0032](../decisions/0032-server-computed-presentation.md)         | Proposed | [server-computed presentation](server-computed-presentation.md) (P1 to P6)          |
| [0033](../decisions/0033-forge-informed-card-authoring.md)        | Proposed | [card authoring and fail-loud](card-authoring-and-fail-loud.md) (phases 2, 5, 6)    |
| [0034](../decisions/0034-fail-loud-execution-and-strict-tests.md) | Proposed | [card authoring and fail-loud](card-authoring-and-fail-loud.md) (phases 0, 1, 3, 4) |
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

- **Accepting ADRs 0031 to 0034.** Implementation proceeds on the proposed text; the status line
  changes only on the owner's word. M5 does not start until 0031 is accepted.
- **ADR 0031 open questions.** Defaults until decided: LAN with `--insecure-lan` first, `relaxed`
  clock, host cannot assign pool decks.
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

| Step | State       | Done so far                                                                                  | Pull request |
| ---- | ----------- | -------------------------------------------------------------------------------------------- | ------------ |
| 1    | done        | stale harness deleted; harness-integrity guard                                               | #44          |
| 2    | done        | `scripts/card-authoring-metrics.ts`; `docs/reviews/card-authoring-baseline-2026-10-28.md`    | #44          |
| 3    | in progress | phase 1 steps 2 to 10 done; open: executor invariants for scope reads, empty suites          | #44          |
| 4    | done        | P1 data-key registry; P3 label code in `@mtg/shared/presentation`                            | #44          |
| 5    | done        | M1 seat controllers: `'table'` mode, per-seat state, fail-closed switches                    | #44          |
| 6    | done        | M2a disclosure policy, privacy fixes, replay inputs and harness; M2b ChaCha20 and streams    | #44          |
| 7    | done        | P2 projection types and board groups; P4 server presentation; P5 raw `data` on request, lint | #44          |
| 9    | in progress | M3 engine work budget; table protocol, tokens, wire ids, lobby; workers and sockets next     | #44          |

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
- **Unmodeled cards in a table deck** are reported to that seat as `unresolved` with the card
  name; a dedicated problem code can follow if the lobby needs to tell them apart.
