# 0014 — Playback correctness: two clocks, and boards that mean "after"

Date: 2026-07-27
Status: Accepted

Supersedes parts of [0012](0012-spectator-ui.md) §1 and §2.

## Context

Phase 4 shipped the spectator UI, and watching a game with it did not work. Three symptoms,
reported together:

1. the battlefield did not match the action-log line the user clicked;
2. the timeline scrubber at the bottom was broken;
3. stepping to the next action did nothing, or threw the viewer back to the start of the game.

Each turned out to be a different defect, and investigating them surfaced several more. This
ADR records the two structural decisions; the rest were straightforward fixes.

## Decision

### 1. A per-action board is the state *after* that action, captured lazily

`emit()` built a `SpectatorState` inline and stored it under the event's sequence number. An
event is appended when it is *announced*, which is routinely before its effect lands:
`applyPriorityAction` emits `playLand` and only then calls `moveObject`, and `Engine.submit`
emits `decision` before the generator applies the chosen action at all. Every seek was
therefore one action stale — measured over a 30-turn game, 12 of 12 `playLand` events stored a
board with the land still in hand.

Snapshots are now settled at the *next* emit, when the state has moved on, and only for events
that produce a spectator log line (seeking is by log line, so no other event is reachable).
This fixes the semantics and the cost together: the old scheme built one full projection per
raw event — every permanent re-run through `computeCharacteristics` — and retained roughly
11 MB of live objects per 30 turns inside `GameState`, forever. The server now drains them
(`Engine.drainSpectatorSnapshots`) and caps what it keeps, so the retention policy sits with
the component that knows how far back the viewer can seek.

The alternative — snapshotting after each `advance()` in the runner — was rejected because the
runner only regains control at decision points, and many log lines (resolutions, combat damage,
SBAs) fall between two of them. Action-by-action seeking is a §10.1 requirement.

### 2. Compute and presentation are separate clocks

§10.1's live mode is "compute forward continuously while the user watches, staying at most five
turns ahead of the user's current view position". The session implemented this by pushing each
turn as it was computed *and* setting the runner's view turn to it. That makes
`frontierTurn <= viewTurn + 5` true by construction: the cap could never bind, and a
random-provider game computed sixty turns in about two seconds. Live mode showed the setup
screen and then the final board. There was nothing to watch, and for an AI match the cost guard
the cap exists to be was not guarding anything.

The session now runs a presentation clock. The engine computes as fast as its budget allows;
the viewer is walked forward one turn per `livePaceMs`, and *that* position is what the cap is
measured against — so the frontier now genuinely sits five turns ahead of the viewer and parks.
Log lines are buffered and released in step with the board, because a log running ahead of the
battlefield is the same desync from the other side.

Speed is a UI control (1×/2×/4×/Max) and rides on `setPlaybackMode` as an optional `paceMs`,
following ADR 0012 §6's rule of widening payloads rather than the message set.

### 3. The server says which action a board belongs to

`stateSnapshot` gained an optional `sequence`. The client used to set its own "you are here"
highlight optimistically when it requested a seek, so when the server could not serve that exact
board and fell back to the turn snapshot, the log highlighted a line the board was not at. The
client now takes the position from the reply and clears it when the reply says `null`.

## Consequences

- Live mode has a wall-clock duration. A 60-turn game at 1× is about 72 seconds; "Max" restores
  the old as-fast-as-it-computes behaviour, and is what the tests use.
- The compute-ahead cap now binds in live mode, which is the point. Anything measuring API spend
  against it (Phase 5 stats) will see different numbers than an unpaced Phase 4 run would have.
- `GameState.sequenceSnapshots` is drained rather than accumulated, so it is no longer a
  meaningful part of the state's memory profile — but it is still *on* the state, which remains
  the wrong home for a display projection. Moving it into the engine's own bookkeeping is a
  tidy-up for whenever `GameState` is next revisited.
- A seek in live mode drops the client to manual. Fighting the presentation clock was the whole
  reason scrubbing and log clicks appeared to do nothing.
