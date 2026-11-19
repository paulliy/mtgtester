# 0021 — Player-experience overhaul: async strategist, yield stops, presentation contract, combat batching

Date: 2026-07-30

Status: Accepted (2026-07-30)

## Context

Phase 7 shipped direct player controls as a faithful adapter over engine-generated legal
actions, but eight problems surfaced in actual play: the strategist call blocked every turn for
20-60s even though tactical calls answer in 3-4s; "yield until end of turn" broke on the very
next opponent action instead of lasting the turn; hideaway auto-picked a card and never rendered
the result, so a modeled card was neither playable nor visible; combat needed one Confirm per
attacker; and the board gave almost no indication of whose turn it was or what an attacker was
attacking. Most of the UI/UX asks were already specified in `docs/plans/phase-8-action-animations.md`
and `docs/plans/phase-9-single-player-experience.md`; this work is largely their execution,
resequenced by where the pain actually was, plus three items those plans do not own: strategist
latency, the yield engine bug, and card-modeling shortcuts (audited separately).

## Decision

1. **Strategist runs off the critical path.** `StrategyCoordinator.prepare()` is now
   fire-and-forget instead of awaited; a `prefetch()` call fires at each turn boundary
   (`MatchRunner`'s new `onTurnBoundary` hook) so the reasoning call overlaps the end step,
   untap, upkeep, and draw of the _previous_ turn. It runs on its own `RequestQueue` lane
   (`strategistConcurrency`, default 1) so it can never contend with tactical calls, which stay
   strictly serial. It is never started for the human seat's turn. One re-plan per turn is
   allowed when an opponent's non-pass action invalidates the cached plan. Strategist and
   tactician latency are now logged separately.

2. **Yield until end of turn breaks on a stop list, not on any action.** `resetOpponentYields`
   (which cleared every yielding player's flag on _any_ cast, activation, or trigger) is replaced
   by `breakYieldsForStop`, which clears the flag only for players the new stack object actually
   threatens: it targets them or something they control, or its effects match a mass removal,
   life-loss, discard, or mill selector against them. Everything else leaves the yield standing.
   The actual UI bug — `passAndYieldTurn` requiring select-then-Confirm because
   `isRoutineAction` didn't recognize it as immediate, so a stray click elsewhere silently
   discarded the pending yield — is fixed alongside it: yielding is one click, with a persistent
   banner and an out-of-band `cancelYield` message to take priority back.

3. **A presentation contract, off `LegalAction` and off the AI prompt.** `DecisionRequest` gained
   an optional `presentation` sidecar (`source`, per-option `actions`, `combat`) built through
   `present.ts`/`choose.ts` helpers. It is deliberately not on `LegalAction`, because
   `legalActions` is serialized verbatim into every AI prompt
   (`packages/server/src/ai/context.ts`); putting `scryfallId`/`typeLine`/`zone` there would
   charge every AI decision, forever, for browser-only data. A regression test in
   `ai/context.test.ts` asserts none of the assembled prompts contain presentation data.
   `DecisionPanel.vue` renders any decision through this contract with no type allowlist,
   falling back to `description` when a presentation entry is absent.

4. **Combat batching is a client hint over unchanged sequential engine decisions.**
   `declareAttackers`/`declareBlockers` still yield one decision per creature — batching it in
   the engine would need a new `DecisionOutcome` shape, new submit-time validation, and a new AI
   response schema. Instead each decision now carries a `presentationCombat` hint naming the
   subjects and legal options still to come. The client `combatPlan` store composes a full
   assignment against that hint, submits nothing while composing, and on confirm replays the
   assignment one submit per subject — matched only by `interaction` fields, using the existing
   `noAttackRest`/`attackRest` shortcuts to collapse "everyone attacks the same defender" or "no
   attacks" into one submit. If the expected option is ever missing (a cost, a restriction the
   client does not model), it aborts to an `interrupted` state and hands the raw decision back to
   the normal per-decision UI — it cannot be wrong about a restriction, only fail to find its
   option and stop.

5. **Hideaway becomes a real decision, and exile becomes visible.** `hideawayExileTop4` now
   yields a `chooseCard` decision over the four looked-at cards instead of auto-picking the first
   non-land. This exposed a real gap: `PlayerView` had no exile field at all, so an AI seat could
   not see its own hidden card on a later turn (e.g. to decide whether to play it for free).
   `PlayerView.exile` now reports every player's exile zone, redacted to `"Face-down card"` for
   everyone but the owner of a card exiled face down — mirroring the redaction the human browser
   view already applied. The browser's own exile/graveyard thumbnail strip (previously
   spectator-only) is now a shared `ZoneStrip.vue` component, also rendered in player mode.

6. **Keyboard and turn legibility.** `PlayerGameView` now handles Enter (confirms when
   `canConfirm`, or confirms a composed combat plan), Escape (cancels the open tray or an
   in-progress combat plan), and Space (passes priority) — scoped to the view, ignored when a
   text input has focus. The Confirm button receives focus when the tray opens. A turn badge
   (`Turn N · Your turn` / `· <seat>`) was added to the player header, and the human battlefield
   zone gets the same active-turn highlight opponent panels already had. Drag-and-drop gained
   `dragend` cleanup so a drag released outside any drop target no longer leaves `draggedId`
   stale.

## Consequences

- A human turn no longer stalls on a wasted strategist call, and every other turn's reasoning
  call overlaps gameplay instead of blocking it.
- Yield now behaves like MTGO's F6: it survives a turn's worth of non-threatening opponent
  actions and breaks only when something actually concerns the yielding player.
- A newly modeled card that yields a `general` decision through `chooseCard`/`cardOption`/etc.
  gets a correct, image-bearing presentation for free; one not migrated falls back to its raw
  `description` rather than disappearing into an unlabeled type.
- Combat declaration is a single compose-then-confirm pass for the common case, with the engine
  still asked and still authoritative on every individual assignment.
- Hideaway is now an actual player decision in both human and AI play, and any card that exiles
  something face down is honestly represented to its owner and redacted to everyone else.

### Scope cuts made without a further check-in

Time-boxed within this pass; each is independently followable later and does not block anything
above:

- **No SVG arrow overlay** for committed/pending attacks (`CombatOverlay.vue`,
  `useBoardAnchors.ts`, the `ResizeObserver`-driven anchor system the original plan specified).
  Combat is legible today through the compose-then-confirm tray and named attacker/blocker badges
  on `PermanentChip`, but there is no line drawn across the board.
- **The presentation-contract migration covers a representative subset** — scry, surveil,
  discard, proliferate, and library ordering — not all ~24 `decisionType: 'general'` call sites
  in `resolve.ts`. The contract, the enforcement test, and the generic renderer are all in place;
  extending coverage to the remaining sites is mechanical follow-up, not open design.
- **No pause/resume state machine for a non-combat decision interleaved mid-declaration** (a
  triggered ability's own choice, a cost). `combatPlan.onRequest`/`answerCurrent` simply no-op
  when a decision's `presentation.combat` is absent, so the ordinary per-decision UI handles it
  and the plan resumes on the next declare-attackers/blockers request for a subject still in its
  order — this works but was not built as an explicit state, so an interleaved decision does not
  visually reference the paused plan.
- **Board change feedback** (flashing life/damage/zone changes against a previous-state shadow)
  was not built. The original plan itself named this as the entry point into Phase 8's cue
  contract and said to do the work there rather than invent a parallel mechanism; that reasoning
  held.
- **Drag polish beyond `dragend` cleanup** — a ghost image, a cursor-following line, drop-commits-
  directly for unambiguous actions — was not built. The concrete bug (stale `draggedId` after a
  drag released outside any drop target) is fixed; the rest is visual polish over a control that
  already works via click.
- **The card-modeling audit** (a separate deliverable this phase also covers) found and fixed one
  active bug — `millAndReturnSpells` reading the wrong end of the library — and completed a first
  pass over `resolve.ts`. It did not sweep `interpret.ts`, `cards/{condition,selector,value}.ts`,
  `combat.ts`, `sba.ts`, `state/objects.ts`, `turn/turn.ts`, or the two authored override files
  the plan scoped it to; that backlog is unranked and open.
