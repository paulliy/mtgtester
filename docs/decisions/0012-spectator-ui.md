# 0012 — Phase 4 scope, adjusted to the repo as it actually stands

Date: 2026-07-25
Status: Accepted

## Context

Brief §14.1 defines Phase 4 as "Spectator UI. Board view, action log, timeline scrubber,
playback modes, compute-ahead with hold-and-wait, deck import screen." That sentence assumes
a few things the tree does not currently provide. This ADR records what Phase 4 additionally
has to build, and why each item could not simply be assumed done.

## Decision

### 1. A `MatchRunner` owns the pump; `runToCompletion` cannot

`runToCompletion` / `runToCompletionAsync` (`engine/src/providers/providers.ts`) are blocking
loops that return only a finished `GameResult`. The playback model in §10.1 — compute forward
while staying at most five turns ahead of the viewer, stop dead on a problematic state — is not
expressible over them: there is no point at which the caller regains control to check the
viewer's position or to decide not to continue.

Phase 4 therefore adds `server/src/match/runner.ts`, which drives `engine.advance()` /
`engine.submit()` itself. The runner:

- computes while `state.turnNumber <= viewTurn + LOOKAHEAD_TURNS` (default 5), then parks in a
  `waitingForView` state until `setViewTurn` raises the ceiling;
- persists one spectator snapshot per turn boundary and flushes new events in batches;
- transitions to `halted` and computes nothing further on any problematic state.

The CLI keeps using `runToCompletionAsync`; nothing about it changes. The two drivers coexist
because they answer different questions — "play the whole game" vs "play as far as the human
has watched."

### 2. Game persistence moves from Phase 2 into Phase 4

`db/schema.ts` creates `games`, `game_players`, `game_events`, and `game_state_snapshots`
carrying `TODO(phase-2)` markers, but `GameStore` only ever grew deck methods, and no code path
writes any of the four. Phase 2 shipped without them and the gap was not noticed because a
CLI game prints its result and exits.

The scrubber cannot be built on top of nothing: §10.1 requires that "all past turn states and
the complete action log are persisted" so the user can move to any already-played turn. So
Phase 4 writes these tables. This is not scope creep into Phase 5 — Phase 5 owns _aggregate
statistics_ over `games`/`game_players`, which is a different concern from recording that a
game happened at all.

`game_state_snapshots.state_json` holds the **`SpectatorState` projection, not `GameState`**.
The snapshot exists to redraw a past board, not to resume a game from it (`game_events` is the
replay record, per §4), and a raw `GameState` would carry four full library orderings into a
row that the UI immediately discards.

### 3. The setup screen leads with generated pool decks, not four URLs

The brief's definition of done starts "the user can paste in four decklists." ADR 0009 already
established that this does not currently work: the engine halts on any unmodeled card, deck
playability is all-or-nothing, and 94% of unparsed rules lines occur on exactly one card. A
setup screen offering only URL import would, for essentially every real decklist, produce a
game that halts on turn one.

So the setup screen offers two paths:

- **Generate from the supported pool** (default) — `generateCommanderDeck` per seat from the
  engine-supported pool, which is exactly the set ADR 0009 built for this.
- **Import** — Moxfield/Archidekt URL or plaintext, run through the Phase 1 pipeline, then
  **pre-flighted through `interpretCard`** so unmodeled cards are reported on the setup screen
  as a per-deck list of blocking card names, before a game is started rather than as a halt
  five seconds in.

The pre-flight is the important half. It converts ADR 0009's constraint from a mid-game
failure into a visible, actionable property of the deck at import time.

### 4. Seat providers are selectable (`random` | `ai`)

Not in the brief. ADR 0010 and 0011 make every AI-driven decision a metered call against a real
budget; a UI that could only run AI games would be unusable for UI iteration and impossible to
E2E-test. The runner takes a provider kind per match. `random` is the default in the UI and the
only mode Playwright exercises.

This does not weaken §1.2 — the engine is authoritative either way, and the random provider is
the same one Phase 2 used to prove full games complete.

### 5. §7.7's human override becomes an escalation callback

`OpenAiDecisionProvider` today goes primary → corrective retry → safest fallback, with no seam
for step 2 of §7.7 ("pause and surface the choice to the user... wait 5 seconds"). Phase 4 adds
an optional `DecisionEscalation` to the provider, supplied by the runner:

- **viewer is at the compute frontier** (they are watching this decision happen): the runner
  emits `decisionPending`, waits `ESCALATION_TIMEOUT_MS` (5000) for `resolveHeldDecision`, and
  returns the human's pick — or `null` on timeout, which restores the safest-fallback path.
- **viewer is behind the frontier** (this is compute-ahead, nobody is watching): the runner
  throws `ComputeHaltError`. The match halts at that decision and computes nothing further,
  which is §7.7's "problematic states are never resolved unsupervised" rule.

Without the escalation the provider behaves exactly as before, so the CLI paths are unaffected.

### 6. The WebSocket protocol becomes a discriminated union

`shared/src/protocol.ts` carried `TODO(phase-4): replace the generic payload with a per-type
discriminated union`. Done, with the same eight server→client and five client→server message
names §11 lists. Two pieces of information that would otherwise have wanted their own message
types are folded into existing payloads instead of widening the set:

- the compute frontier rides on `eventBatch` and `stateSnapshot`, so the scrubber's upper bound
  advances without re-sending a whole board;
- AI call/token counters ride on `apiWaiting`.

### 7. A match does not outlive its audience

The brief says one game at a time (§15) but not what happens when the last spectator disconnects.
Doing nothing is the wrong default in both directions: an AI match with nobody watching keeps
spending real money, and its `games` row reads `running` forever, which quietly corrupts the
Phase 5 statistics that filter on status. Abandoning immediately is also wrong — a page reload
drops the socket for a fraction of a second.

So the server abandons an unwatched match after a grace period (`ORPHAN_GRACE_MS`, 30s), which
routes through the same `abandon()` path as the UI button and closes the row out as `abandoned`.
Reconnecting inside the window cancels it. Note that the compute-ahead cap already limits the
damage — with no viewer, `viewTurn` never moves, so the runner parks after five turns — but
parked is not finished, and a row that never closes is still wrong.

## Consequences

- Phase 4 is meaningfully larger than "build a Vue app": roughly half of it is the server-side
  orchestration and persistence layer that Phase 2 and Phase 3 each left to the other.
- `game_state_snapshots` rows are display projections. Anything that later needs to _resume_ a
  game from mid-flight must replay `game_events` from the seed, which is what §4 already
  specifies; the snapshot table must not grow into a half-authoritative second source.
- The pre-flight makes the coverage backlog visible in the product surface, not just in
  `bun run coverage`. Expect this to be where the next mechanics get prioritised from.
- Debug panel, aggregate stats, and mana metrics remain Phase 5. The `ai_calls` counters
  surfaced in `apiWaiting` are the minimum §7.5 requires ("surface queue depth and current wait
  state so the user understands why playback paused"), not the §13 panel.
