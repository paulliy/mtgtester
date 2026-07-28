# 0018 — Single-player mode over the authoritative decision contract

Date: 2026-07-28

Status: Accepted

## Context

The engine already stops at authoritative legal decision points and accepts exactly one offered
action through `Engine.submit()`. Phase 5 was completed before this work began, so Phase 6 can
extend the live runner and persisted game metadata without designing around unfinished
statistics or diagnostics contracts.

Single-player must not expose the spectator projection: that projection intentionally contains
all hands and is suitable only for AI-only playback or a completed-game replay.

## Decision

1. Support two explicit game modes: four-controller `spectator` and one-human,
   three-bot `singlePlayer`.
2. Attach typed `interaction` metadata to surfaced legal actions. Browser gestures select an
   offered action and targets; they never construct or apply rules state.
3. Give the browser a separate `PlayerBoardState` projection containing the human hand and
   public information while redacting opponent hands, libraries, face-down identities, and
   private events.
4. Implement the human seat as an untimed asynchronous decision provider. Forced decisions
   remain engine-resolved and never prompt the browser.
5. Gate new bot calls while the owning player socket is disconnected. Sessions are resumable
   with an in-memory token until abandonment or server shutdown; resync restores the private
   board, deduplicated player-safe log, pace, and pending choice.
6. Validate request IDs, state revisions, seat ownership, action IDs, and targets before
   forwarding a human choice to `Engine.submit()`.
7. Disable compute-ahead and seeking during an active player game. Unlock the complete
   spectator projection, replay, and persisted debug/export surfaces only after the game ends.
8. Persist game mode and controller kind, record human actions in normal game history, and
   route human choices through the strategy coordinator without counting them as AI calls.

## Consequences

- Existing four-bot spectator games retain their playback behavior.
- A human can play any one seat using click controls, common drag gestures, and a generic legal
  action fallback without duplicating the engine's legality rules in the UI.
- Reconnection works only while the current server process is alive. Durable authoritative
  engine restoration, multiple humans, remote spectators, and live spectator clients for a
  player game remain deferred.
- Player-mode protocol and projection tests become a required hidden-information boundary.
