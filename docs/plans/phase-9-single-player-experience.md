# Phase 9 — Single-Player Experience

## Purpose

Phase 9 makes the one-human-versus-three-bots mode feel like playing digital Magic rather than
operating a legal-action debugger. It keeps the rules engine authoritative, preserves the
player-safe visibility boundary, and reduces the time between a player's intent and the next
meaningful decision.

This plan follows Phase 7's direct-controls work. It may coexist with Phase 8's optional action
animations; animations must never be a dependency for submitting, yielding, or seeing an action.

## Player outcome

A player should be able to:

1. Start from an imported deck without configuring a full pod by hand.
2. Read their hand and board at a glance, then drag or click a card to express an action.
3. See exactly what can be targeted, what has already been selected, what remains to choose, and
   what the action will cost before it is submitted.
4. Move quickly through routine turns, while still receiving deliberate confirmations for choices
   that are easy to misclick or materially change the game.
5. Reach their next meaningful decision without watching three full bot turns of routine passes.

## Scope and non-goals

In scope:

- four-player Commander with one human seat and three bots;
- card-first casting, targeting, combat, priority, and mana-payment interaction;
- configurable confirmations and a fast path through routine priority;
- a responsive, readable player board that remains hidden-information safe.

Out of scope:

- remote multiplayer, live spectators, two human seats, or recovery after server restart;
- changing rules legality or letting the browser infer an unoffered action;
- replacing the existing generic legal-choice fallback for mechanics without a dedicated visual
  control;
- AI strategy, card-coverage expansion, or batch deck-analysis work (Phase 10).

## Product decisions

1. **Intent first, engine last.** Dragging a card to the battlefield or a legal target is an
   interaction adapter that selects an existing offered action. `Engine.submit()` remains the
   only authority.
2. **Use progressive disclosure.** The board presents the likely next action directly; menus
   appear only for real ambiguity such as modes, optional costs, ordering, or uncommon mechanics.
3. **Confirm risk, not every click by default.** Spells, activated abilities, target groups,
   combat declarations, mulligans, and irreversible choices require a final confirmation.
   Land plays and ordinary passes are one-click by default but honour a per-player
   `confirmRoutineActions` setting. The current all-actions-confirm behavior remains available
   as that setting.
4. **Make the current choice visible in space.** Selected sources, selected targets, required
   remaining targets, payment sources, attackers, blockers, and pending confirmation all have
   distinct board states; no action description parsing is allowed.
5. **Default to meaningful stops.** Bot play runs continuously until the human has priority with
   a non-routine option, a required selection, a stack response opportunity, or an explicit
   stop point. The player can always choose to stop at every priority window instead.

## “Playing Magic” guardrails

The following are experience constraints, not optional polish. A Phase 9 implementation that
technically supports card clicks but violates these constraints has not met the purpose of the
phase.

1. **The default path never names engine machinery.** Ordinary play must not expose action IDs,
   legal-option indices, payloads, state revisions, or generic phrases such as `You have an
   action`. Those remain available only in Debug. Player-facing language says what is happening:
   `Choose targets for Lightning Bolt`, `Order these triggers`, or `Pay {2}{W}`.
2. **A card is the control.** A player begins an ordinary cast by clicking or dragging the card
   they mean, begins an activation on its permanent, and chooses a target by clicking it. The UI
   may show a small mode/cost picker only when the card genuinely has several actions.
3. **The board shows the transaction in progress.** From selection through confirmation, the
   source remains visibly selected, targets receive numbered markers, expected mana sources are
   previewed, and the prospective spell/ability appears on a pending stack. Cancellation returns
   the board to its prior visual state without changing the engine.
4. **Routine Magic is fast; consequential Magic is deliberate.** A player can play a normal land
   or pass normally with one interaction, while casting, targeting, combat, modal decisions, and
   irreversible costs receive an intentional review. `Full control` and `Confirm all actions`
   remain available for players who want them.
5. **The app explains only when the rules require a decision.** It must not interrupt a player
   for forced resolutions or routine priority passes, but it must interrupt immediately and
   clearly for a legal response, a mandatory choice, or a choice that changes a card's result.
6. **Feedback is spatial and immediate.** Hover/focus shows the complete card; selection,
   legality, targeting, tapping, stack movement, combat, damage, and zone changes are visible on
   the objects involved. Phase 8 motion is welcome, but equivalent non-animated states are
   required when motion is Off.

These guardrails intentionally mirror the interaction vocabulary players already know from
digital Magic: inspect a card, drag it to cast, select highlighted targets, review the spell, and
pass only when there is nothing else to do.

## Work plan

### 9.1 Simplify starting a player game

- Add a `Play my deck` entry point that accepts one imported/saved deck for the human seat and
  fills the three opponent seats from named generated or saved bot profiles.
- Show a compact matchup summary before start: commanders, colors, archetype labels, controller
  kind, seed, and whether each deck is fully modeled.
- Persist recently used player decks and opponent pods locally/server-side so the normal loop is
  `choose deck → choose pod → play`, not four repeated imports.
- Keep the advanced four-deck configuration under an `Advanced pod setup` disclosure.

### 9.2 Establish a clear player-board hierarchy

- Make the human hand the primary, fanned/scrollable interaction surface at the bottom of the
  board. Every hand card and every public permanent supports the same hover/focus magnifier.
- Group each battlefield by card identity while preserving individual object hit areas and states
  for target selection, damage, attachments, and combat.
- Give the human a persistent resource strip: life, commander tax, available mana by color,
  land-play availability, graveyard/exile counts, and current phase/priority.
- Collapse inactive opponent boards to a readable summary. Expand a seat automatically when it
  is active, controls a stack target, attacks/blocks, or is a legal target; leave manual expand
  available at all times.
- Show stack objects and their targets next to the pending decision, not only in a separate rail.
  Hovering a stack item, card, or ability always opens the same detailed card/ability preview.

### 9.3 Finish direct card interaction

- Support click or drag from hand to battlefield for land plays and non-targeted casts; drag from
  source to a card, permanent, player, or stack object for target-bearing casts/activations.
- For every target slot, highlight only legal choices for the next unfilled slot. Mark chosen
  targets with their slot number; show `Target 2 of 3` and a clear completion message when the
  maximum is reached.
- Permit deselection/replacement before confirmation where the engine's target contract allows
  it. A completed target group must never silently submit.
- While an action is being composed, render a non-authoritative pending stack card/ability and
  a concise natural-language summary (`Cast … targeting …; tap …`). This is a visual preview,
  not a second stack or a client-side rules model; the real stack changes only after submission.
- Turn combat into board gestures: click/drag attacker to defending seat, blocker to attacker,
  retain visual combat lanes, and show a final declaration review. Keep the existing
  creature-by-creature engine requests behind that interaction.
- Add keyboard equivalents for common operations: inspect, cancel, confirm, pass priority,
  yield, and cycle legal sources/targets. All keyboard focus states must expose the same labels
  as pointer interactions.

### 9.4 Add deliberate mana and cost handling

- Extend the offered-action contract with structured, engine-generated payment plans: selected
  mana sources, color/generic allocation, non-mana costs, and payment alternatives. A client may
  choose only among these plans; it never creates a mana payment.
- Default to the engine's current land-first automatic payment plan. Before confirmation, show
  which lands/permanents will tap and why; retain the preference that lands tap before creatures.
- Offer `Auto pay` and `Choose payment` whenever more than one material plan exists. In manual
  mode, selecting a source previews an engine-valid remaining payment; invalid combinations are
  unavailable rather than rejected after the fact.
- Surface and confirm all non-mana costs in the composed action: life, counters, discard,
  sacrifice, commander tax, alternate/additional costs, and modal/X choices.
- Test restricted mana, flexible mana, mana abilities with riders, tapped/summoning-sick sources,
  and the requirement that a manual payment cannot leak hidden information or alter legality.

### 9.5 Make priority and bot pacing fast without hiding choices

- Replace the single pace setting with `Stop at every priority`, `Stop when I can act`, and
  `Advance until my next turn` modes. All modes interrupt instantly for a required human choice.
- Make `Stop when I can act` the normal player-mode default, and expose `Full control` as a
  deliberate toggle for players who want every priority window. The UI must state the selected
  policy in ordinary Magic terms, not as an optimization setting.
- Make pass/yield controls persistent and contextual: pass once, yield through the current
  stack, yield through the turn, yield through a named ability, and resume any saved yield.
- Add an explicit bot-turn summary at each human stop: land played, spells/abilities used,
  targets, combat, and life/board changes, linked to the detailed log/replay.
- Coalesce routine bot passes and forced engine actions in the live presentation while retaining
  their full event sequence for replay/debugging.
- Expose a visible `Bots deciding` state with the current seat and a cancel/abandon route; never
  imply that the game is frozen while the server is awaiting an AI response.

### 9.6 Handle uncommon choices gracefully

- Build request-specific visual controls for mulligan/bottoming, trigger and damage ordering,
  commander replacement, legend rule, optional costs, multi-mode casts, and divide-as-chosen
  effects as their structured contracts become available.
- Keep a compact generic choice sheet as the safety net. It must name the source, show a card
  preview and legal objects, maintain the same Cancel/Confirm behavior, and never surface a
  blank `You have an action` state.
- Give every action a short structured explanation of its consequence, independent of its raw
  rules-text description.
- Reserve the generic choice sheet for genuinely uncommon decisions. It must never be the normal
  route for casting a spell, playing a land, activating an ordinary ability, selecting targets,
  declaring combat, or passing priority.

### 9.7 Persistence, protocol, and accessibility

- Version player preferences (confirmation level, stop mode, bot pace, card zoom, reduced
  motion) locally and include only active game settings needed for reconnect resynchronization.
- Extend player-safe protocol payloads only with public board identity and structured action
  presentation/payment data. Add projection tests that reject opponent private zones, decklists,
  library order, face-down identities, and private events.
- Support pointer, keyboard, and narrow-screen layouts. Use visible focus rings, sufficient
  contrast, textual target labels, and `prefers-reduced-motion`; a card preview must not obscure
  the selected source or confirmation controls.

### 9.8 Animation, reactivity, and board clarity

`docs/decisions/0021-player-experience-overhaul.md` shipped most of this plan's other asks but
logged three gaps under "Scope cuts made without a further check-in": no combat overlay, no
board-change feedback beyond life totals, and no drag polish beyond `dragend` cleanup. This
section closes exactly those three gaps. It deliberately does not resurrect Phase 8's full typed
`ActionCue`/`CueGroup`/`CueAnchor` protocol contract — that plan was sized to animate every action
type off a `GameEvent.sequence`-keyed replay feed, which is more generality than three concrete,
already-identified gaps need, and is the scope that made Phase 8 stall in the first place.
Instead, generalize the existing `useLifeFlash` watch-diff-timeout pattern into one reusable
composable, and add exactly one new geometry primitive — a `ResizeObserver`-backed anchor
registry — because it is the one thing neither composables nor CSS classes can already provide: a
permanent's on-screen rect, needed to draw a line to it. Everything here is local to `apps/web`;
no protocol change, no engine change, no cue store.

- **Combat overlay.** Add a small anchor registry (`registerAnchor(id, el)` /
  `unregisterAnchor(id)`, kept current by `ResizeObserver` plus a window-resize listener) and an
  absolutely positioned SVG overlay that reads the existing combat-plan store's order,
  assignment, current entry, and mode alongside that registry — no new store. Draw a dashed,
  lower-opacity line per pending assignment while composing; a solid line matching the existing
  `attacking` indicator once committed; and a highlighted line for the entry currently being
  placed. Register anchors from each permanent tile and each seat panel; the existing attack/block
  badges and pulse remain the non-overlay fallback so combat stays legible with the overlay off.
- **Attack/hit animation.** MTGA-style: the striking permanent's tile lifts and lunges toward its
  target's anchor, then returns, timed to the combat damage that actually landed rather than to
  declaration. A new composable diffs each freshly pushed board's `damageMarked`/life totals
  against the previous one and, for each increase it can attribute to a still-visible
  `attacking`/`blocking`/`blockedBy` pairing, hands the striking permanent's tile a travel vector
  computed from the same anchor registry the overlay lines use; no new store, no protocol change.
  This is presentation inferred from state deltas, not a dedicated engine damage event, so a
  non-combat damage source landing on a permanent that happens to be mid-combat, or trample
  discounted through a blocker, can misattribute the animation — acceptable for board juice, not
  something anything else depends on. The existing per-permanent damage flash and per-seat life
  flash already provide the target-side "impact" feedback, so this only adds the source-side
  motion. Symmetric by construction: an opponent's creature attacking the human player animates
  exactly the same way as the reverse, since both directions read the same board.
- **Generalized board-change feedback.** Generalize the life-flash composable's shape (watch a
  piece of reactive state, derive a transient class from the delta, clear it on a timeout) into
  one reusable primitive, and reimplement the life-flash helpers as thin wrappers over it so the
  generalization is proven before it is extended. Apply it to damage marks and to a tap/untap
  transition on permanent tiles. Use Vue's built-in `<TransitionGroup>` — unused anywhere in the
  app today — scoped strictly to enter/leave, for token creation and zone changes (death, exile,
  return) on each seat's battlefield, and for stack items appearing, resolving, or being
  countered.
- **Drag polish.** Build on the existing drag-start/drag-end handling. Add a custom drag-ghost
  image (the dragged card's own image, via `dataTransfer.setDragImage`) in place of the browser's
  default full-tile ghost, and a cursor-following line while dragging, sharing the combat
  overlay's anchor lookups. A drop still resolves to at most one matching legal action exactly as
  it does today — auto-filling that action's only target where one exists — but does not gain a
  new silent-submit path: this plan's own guardrail 4 ("consequential Magic is deliberate")
  reserves one-click submission for land plays and passes, so a dropped cast or activation still
  surfaces the pending-action preview for an explicit Confirm. The existing opt-in "skip confirm
  step" preference already covers a player who wants that submission automatic, without changing
  the default for everyone else.
- **Reduced-motion and Off contract.** Add a `reducedMotion` preference alongside the existing
  pace/confirmation player preferences, defaulted from the OS `prefers-reduced-motion` media query
  and player-overridable. Every addition above must have a fully-informative non-animated
  equivalent when motion is off: the overlay absent (existing badges stand alone), the flash
  primitive short-circuiting to an instant state update with no transition class, transition-group
  enter/leave collapsing to an instant insert/remove, and drag falling back to the browser default
  ghost with no cursor line. This directly fulfills this plan's existing guardrail on motion
  (§ "Playing Magic" guardrails, point 6) rather than introducing a new one.

## Verification and acceptance

- Combat-overlay, board-flash, and drag-polish component tests: the anchor registry
  registers/unregisters and updates rects on a simulated resize; the flash primitive classifies
  increase/decrease/appear/disappear correctly and clears on timeout, including the life-flash
  call sites behaving identically to today.
- Playwright coverage for 9.8: composing an attack draws a dashed preview line between the correct
  anchors; confirming swaps it to a solid line matching the committed attack; an unblocked attacker
  animates a lunge toward the defending player and a blocked one toward its blocker (and back) at
  the moment damage actually lands, in both directions (human attacking and human defending); a
  death or token-entry during a scripted turn shows the transition and settles on correct state;
  dragging shows a custom ghost and cursor line; dropping on a single legal target auto-fills it
  and still opens the pending-action preview for Confirm, matching guardrail 4, unless "skip
  confirm step" is enabled.
- Reduced-motion check, under both the OS setting and an explicit in-app override: no
  animation/transition exceeds an effectively-zero duration, the combat overlay and attack/hit
  animation are both absent, and every fact they would have shown (attacker/blocker pairing,
  damage delta, tapped state, zone presence) remains readable from static badges/state alone.
- Unit/contract tests prove every direct gesture resolves to an offered action id, target slot,
  or engine-generated payment plan; stale, duplicate, wrong-seat, and modified submissions are
  rejected.
- Component/browser tests cover: any duplicate land copy; click and drag casting; one and
  multi-target selection/deselection; target maximum feedback; click and drag combat; auto and
  manual payment; cost review; pass/yield scopes; stop modes; hover/focus preview; and generic
  fallback choices.
- End-to-end mocked-bot tests cover one complete player game with mulligan, land play, targeted
  spell, stack response, combat, disconnect/reconnect, and player-mode replay, asserting no
  player traffic contains private opponent information.
- Usability acceptance: a player can import one deck, begin a game against a saved/generated pod,
  play a land and a targeted spell by card interaction, inspect all selected targets and payments,
  and advance to their next meaningful decision without reading a legal-action menu.
- Experience acceptance: during a scripted ordinary turn (play a land, cast a targeted spell,
  pass, observe one opponent turn, attack, and choose blockers), a playtester can identify each
  next action from the board itself; no step requires them to interpret a raw action description,
  open the generic choice sheet, or understand simulation terminology.

## Definition of done

Phase 9 is complete when the common play loop is card-first, legible, and fast enough to feel
like playing Magic rather than operating a simulator; routine waits do not dominate a four-player
game; every irreversible action remains safely reviewable; and the browser remains a constrained
adapter over authoritative, hidden-information-safe engine actions.
Finish with an ADR covering the payment-plan and stop-mode contracts, then obtain phase-boundary
approval before beginning additional player or testing scope.
