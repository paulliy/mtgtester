# 0017 — Durable Phase 5 statistics and diagnostics

Date: 2026-07-28

Status: Accepted

## Context

The engine generated a detailed in-memory debug log and the server persisted replayable events
and AI calls, but neither historical deck statistics nor a full debug inspection surface existed.
Mana heuristics must remain retunable without replaying games.

## Decision

1. Persist engine diagnostics in `game_debug_events`, separate from the minimal spectator log.
2. Persist raw per-seat, per-turn mana observations, including cumulative land/card draws.
   Calculate flood and drought at read time using `config/mana-metrics.ts` constants.
3. Attribute an elimination to the controller of its most recent authoritative damage event.
   Losses without a damaging source remain explicitly unattributed.
4. Use read-only HTTP endpoints for historical stats, debug data, and JSON export; use the
   WebSocket for live verbose-engine streaming and debug display flags.
5. Keep AI requests, responses, and reasoning out of the spectator action log.

## Consequences

- Statistics can be recalculated after a threshold change without replaying a game.
- The complete debug trace survives a reload and exports with the seed, game events, AI calls,
  and mana inputs.
- A future end-of-turn mana hook can improve `unspent_mana` fidelity without changing the
  persistence, API, or UI contract.
