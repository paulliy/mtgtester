# Phase 8 — Action Animations

## Purpose

Phase 8 turns the event-by-event playback delivered by Phase 7 into readable, optional visual
feedback. It adds presentation only: the rules engine remains authoritative, and an animation
can never delay, alter, or infer a game action.

The phase covers every currently visible action, with special attention to the requested combat
moments:

| Engine moment                                                                                | Viewer feedback                                                                                                 |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A spell or activated ability is cast                                                         | source card lifts from its zone, travels to the stack, and the stack item briefly highlights.                   |
| Attackers and blockers are declared                                                          | participating creature tiles receive attack/block indicators; attacker-to-defender lanes are drawn.             |
| Combat or noncombat damage hits a creature                                                   | a source-to-target impact travels, the target flashes, and the marked-damage value ticks to its new value.      |
| Damage hits a player                                                                         | a source-to-seat impact travels, the life total ticks down, and commander damage is called out when applicable. |
| A permanent is destroyed, sacrificed, or dies to an SBA                                      | the permanent flashes, fades out, and its graveyard/command-zone destination is highlighted.                    |
| Other public actions (land play, token creation, exile, counter, life gain/loss, resolution) | a short, non-blocking cue on the affected zone, card, or seat.                                                  |

## Phase 7 dependency and scope boundary

This plan assumes the Phase 7 playback plan is complete and accepted: the client has ordered
`GameEvent.sequence` values, can seek an exact per-action board snapshot, and treats server
state as authoritative. Phase 8 builds on those guarantees; it does not rework playback,
game rules, AI decisions, card rendering, or persistence.

Before implementation, confirm the Phase 7 acceptance suite is green. If a Phase 7 feature
changes the event/snapshot protocol, update the cue mapping below before changing UI code.

## Design decisions

1. **Use explicit visual cues, not log-text parsing.** A `SpectatorLogLine` is prose and often
   intentionally omits details. The engine/server must derive a compact, typed `ActionCue`
   from a `GameEvent` while the event has stable source, target, and zone identifiers.
   `ActionCue` extends the `PresentationCue` contract of ADR 0032 decision 8 (plan P6): the
   damage and life cues already ride on `eventBatch`, carry object ids and never card ids, and
   take a viewer's own log sequence at a table.
2. **Key cues to event sequences.** Every cue carries the originating `sequence`; the client
   plays a cue only for the exact action snapshot at that sequence. Seeking, stepping
   backward, reconnecting, and a new game cancel the active cue rather than replaying stale UI.
3. **Render overlays above the board.** Cards do not move between layouts. The animation
   layer measures registered card/seat/stack anchors and uses a fixed, pointer-inert SVG/CSS
   overlay for paths, impacts, and labels. This avoids reflow, preserves grouped permanent
   tiles, and works across the four-seat layout.
4. **Respect Magic simultaneity.** Each damage step is represented as one cue group whose
   impacts begin together. A creature can deal damage to a blocker and a player in the same
   group (trample); deaths occur only after the damage group completes, when its later SBA/zone
   event is reached.
5. **Never block the game.** The server continues computing according to the existing playback
   pace. The viewer may coalesce a backlog to the newest relevant cue, and the animation layer
   must have no influence on engine timing or action submission.
6. **Accessible by default.** Honour `prefers-reduced-motion`; offer an in-app setting with
   `Full`, `Reduced`, and `Off`. Reduced mode uses brief highlights and numeric life/damage
   changes, while Off retains the action log and final board state.

## Work plan

### 8.1 Establish the cue contract

- Add shared, discriminated types for `ActionCue`, `CueAnchor`, and `CueGroup`; include the
  event `sequence`, cue kind, source/target object or player IDs, amount where applicable, and
  zone/destination metadata for casts and deaths.
- Add an optional `actionCues` field to the existing event-batch payload rather than a parallel
  WebSocket message, so log lines and visual cues retain one ordering and reconnect behaviour.
- Replace ambiguous event payload fields used by visual events with stable IDs where missing:
  source permanent/card ID, target permanent or player ID, controller, amount, and zone-change
  origin/destination. Keep names only as labels/fallbacks.
- Derive cues in the engine/server event-formatting boundary. Do not send engine-internal state
  wholesale and do not make the Vue app reconstruct combat or zone changes from snapshots.
- Define a deliberate fallback: an event with insufficient public identity produces no motion
  cue but remains visible in the action log. The protocol must never guess a target from a
  duplicated card name or a grouped tile.

### 8.2 Cover the action taxonomy

- **Casting and resolution:** cue `castSpell`/activated ability source → stack; flash the stack
  on `resolved`, `counterSpell`, and `fizzle`; cue land play hand/command zone → battlefield
  where the public source is available.
- **Combat:** emit a grouped declaration cue after `attackersDeclared`, containing every
  attacker and defender; emit block links from blocker → attacker; preserve their pairing until
  combat ends or the viewer seeks elsewhere.
- **Damage:** enrich both combat and effect damage events with source/target IDs and make one
  simultaneous cue group per combat damage step. Support creature → creature, creature →
  player, spell/ability → creature, and spell/ability → player. For each impact, show amount,
  damage/commander marker as relevant, target flash, and life/marked-damage counter transition.
- **Death and zone movement:** derive distinct `death`, `destroy`, `sacrifice`, `exile`, and
  `return` cues from the authoritative zone-change/SBA event sequence. The destination cue
  follows the board snapshot in which the card actually left, so a commander replacement never
  falsely animates it to the graveyard.
- **Supporting visible changes:** add compact, coalescible cues for token creation, counters,
  life gain/loss, tapping/untapping, and commander-zone movement. These complete the "all
  actions" surface without turning routine priority passes or debug events into visual noise.

### 8.3 Build the animation presentation layer

- Create a Pinia animation store that accepts ordered cue groups, keeps at most one active group
  plus a bounded queue, exposes the current sequence, and cancels/reset safely on game change,
  snapshot seek, manual action step, reconnect, halt, and unmount.
- Add anchor registration to `PermanentChip`, seat life badges, graveyard/command-zone badges,
  hand/stack locations, and the relevant player-board equivalents. Anchors use stable permanent
  object IDs; grouped tiles register every represented ID or the cue is reduced to a seat/zone
  highlight.
- Add a single `ActionAnimationLayer` above `GameView` (and reuse it in `PlayerGameView` only for
  information that player is entitled to see). Use CSS transforms/opacity and SVG lines; do not
  introduce a third-party animation library unless a prototype proves CSS/WAAPI inadequate.
- Add small, semantic component states (`isCasting`, `isAttacking`, `isBlocking`, `isDamaged`,
  `isDying`, `isTargeted`) so the board remains intelligible if path measurement is unavailable.
- Scale durations from the existing live pace without exceeding a short cap; at Max speed or
  with queued events, show the final highlight/counter result and skip travel paths.

### 8.4 Playback, settings, and responsiveness

- Add the motion preference next to playback controls. Persist it locally, default it from
  `prefers-reduced-motion`, and expose the current mode in the player and spectator views.
- In live mode, play only new cues at the live edge. In manual mode, play the cue when the user
  steps forward one action; log selection or backward stepping shows the exact board without
  auto-playing a potentially disorienting historical animation.
- Recalculate anchors with `ResizeObserver` and on layout changes; fall back to component
  highlights below the responsive breakpoint where a source-to-target path would be unclear.
- Ensure overlays have `pointer-events: none`, never obscure the held-decision/player-action UI,
  and use `aria-live` only for concise damage/life/death announcements in reduced-motion mode.

### 8.5 Verification and acceptance

- Unit-test cue derivation with stable IDs for: cast → stack → resolve; attacker declaration;
  block pairing; unblocked player damage; creature-versus-creature damage; trample split damage;
  first/double-strike two-step combat; direct damage; lethal damage then SBA death; indestructible
  survival; sacrifice; destroy; commander replacement; and multiple same-named creatures.
- Unit-test the animation store for ordering, simultaneous groups, coalescing, motion modes,
  and cancellation on seek/new-game/reconnect/halt.
- Add component tests for semantic states and counters, plus Playwright coverage that proves an
  action-step animation appears on the correct source/target and is absent when motion is Off.
- Run `bun run typecheck`, `bun run lint`, and `bun run test`; run the browser suite if its
  environment is configured. Capture a short deterministic scripted combat recording or
  screenshots for each requested class: casting, attack, creature hit, player hit, and death.

## Definition of done

Phase 8 is complete when a deterministic replay makes each requested action visually clear,
motion never changes the engine result or blocks a human decision, action-step/seek state never
shows a stale animation, reduced-motion and Off are fully usable, and the protocol plus UI tests
above pass. Finish with a brief ADR documenting the cue contract and a phase-boundary review;
do not begin further gameplay or visual scope without approval.
