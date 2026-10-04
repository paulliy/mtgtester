# UI polish plan

Prepared 2026-10-04 for review. Status: **in progress** — U1 and U2 are done; U3–U5 are proposed.
Desktop first; narrow-screen layout is deliberately deferred.

This plan covers the larger UI work found in a live walkthrough of the app on 2026-10-04 (setup,
one player game, one spectator game, statistics, and a batch at 1440×1000) and the still-open
findings of the [2026-09-05 browser trial](../reviews/browser-experience-2026-09-05.md). It sits
under [Phase 9](phase-9-single-player-experience.md): where an item overlaps a Phase 9 section, it
is a concrete, smaller slice of that section rather than a replacement for it.

## Already done on `claude/adoring-gauss-6dt17h`

These small fixes shipped separately and are not repeated below:

- A refused start (Play my deck or Advanced setup) stays on Setup, keeps the form and preview, and
  shows the reason beside the button instead of bouncing back with the reason hidden.
- Player-facing turn positions ("Main phase 1", "Combat · Declare blockers"), connection state
  ("Connected"), priority prompt, and auto-pay summary ("Forest ×2, Sol Ring").
- Abandon confirmation in player mode, shared with spectator mode.
- Seat names on recent opponent actions; readable loss reasons and deck headings in statistics.
- Batch results show how far a failed or running game got and why it failed.
- "Random bots" relabelled "Built-in bots": the `random` kind runs the seeded heuristic bot.

## Recommended order

| Order | Item                                     | Size   | Why this position                                  |
| ----- | ---------------------------------------- | ------ | -------------------------------------------------- |
| 1     | U1 Recover an orphaned player session    | Small  | Done 2026-10-04 (idle expiry only, by decision)    |
| 2     | U2 Make playable actions obvious         | Medium | Done 2026-10-04, including the land-drop reminder  |
| 3     | U3 Correct "Who beats me" and tidy stats | Medium | Statistics currently contradict themselves         |
| 4     | U4 Player board hierarchy and density    | Large  | Biggest visual change; needs a design review first |
| —     | U5 Test coverage for the player flow     | Medium | Runs alongside U2–U4, not after them               |
| Later | U6 Narrow-screen layout                  | Large  | Deferred by decision on 2026-10-04                 |

## U1 Recover an orphaned player session

**Problem.** The server keeps a single-player session after its browser disconnects so the same
browser can resume it (`packages/server/src/ws/server.ts`, websocket `close` handler returns before
`startOrphanTimer` for `singlePlayer`). Any other socket is refused with "Resume the active player
session before replacing it." If the original browser is gone (closed private window, cleared
storage, another machine profile), nothing can start or abandon that game until the server
restarts. Reproduced on 2026-10-04 with two browser contexts.

**Decision (2026-10-04).** Another browser may **not** take over a disconnected game. Only the
idle expiry ships.

**Done.** `PLAYER_IDLE_GRACE_MS` (30 minutes, in `packages/shared/src/protocol.ts`) starts when the
player socket closes; resuming cancels it, and each disconnect starts a fresh one. On expiry the
server abandons the game, which frees the seat for a new start. The Setup refusal message says
when the seat clears instead of advising a restart. Regressions are in
`packages/server/src/ws/audit-lifecycle.test.ts` (expiry frees the seat, resume cancels, a later
disconnect does not inherit an earlier timer).

## U2 Make playable actions obvious

**Problem.** In player mode the only action buttons at a main-phase priority stop are **Pass
priority** and **Pass and yield until end of turn**. Lands and spells are played by clicking a
hand card, but the cue is a 1px, 75%-opacity blue border (`.actionable` in
`PlayerGameView.vue`) plus a grey hint line at the bottom of the board. In the walkthrough a
whole turn passed with a land in hand and the land drop unused.

**Decision (2026-10-04).** Ship all three parts, including the land-drop reminder.

**Done** (a slice of Phase 9.2/9.3):

1. Playable cards and permanents have an accent outline and glow; hand cards carry a
   Play/Cast/Activate tag from the best offered action; unplayable hand cards recede while
   something is playable. Nothing here animates, so reduced motion needs no separate state.
2. A **Playable now** list in the action panel names each source the engine offers to play, cast,
   or activate. Selecting one behaves exactly like clicking the card (a land plays in one click
   unless "Confirm passes & lands" is on).
3. Passing or passing-and-yielding while the engine still offers a `playLand` asks once per turn
   ("Play a land" / "Pass anyway"). The "Land drop reminder" setting turns it off. Keyboard
   shortcuts are ignored while any dialog is open.

Engine-offered actions remain the only source of truth, and only the viewer's own offered actions
are used, so hidden information is unchanged. Card Test Lab Playwright tests cover the tag and
list, the reminder (including Space on the dialog not passing), and turning it off.

**Still to check.** A screenshot review with real card art: the glow was only seen over
placeholder art in a sandbox that cannot reach Scryfall.

## U3 Correct "Who beats me" and tidy statistics

**Problem.** `MatchRunner` records `eliminatedBySeat` as the last player to deal damage to each
seat, for every seat including the winner and self-damage
(`packages/server/src/match/runner.ts`, `eliminators`). The statistics queries count any row with
an attribution (`packages/server/src/db/stats.ts`, `lossesTo`), so a deck with 100% wins can list
opponents under "Who beats me", and a deck can "beat itself". Separately, unnamed historical
decks, repeated snapshots of the same commander, and two "Unavailable" mana rows per deck make the
page hard to scan.

**Proposal.**

1. Record an eliminator only for seats that actually lost, and never the seat itself.
2. Filter `lossesTo` to genuine losses (`loss_reason IS NOT NULL`), so existing rows display
   correctly without rewriting them. Per the contributor guide, historical rows are not changed.
3. Group statistics by deck with snapshots as a secondary breakdown, and collapse mana metrics
   into one "Mana rates unavailable for these games" note when both are null.

**Verification.** Focused regressions in `packages/server/src/db/stats.test.ts` (a winner with
an attribution, a self-attribution) and a runner test that a winner records no eliminator.

## U4 Player board hierarchy and density

**Problem.** At 1440×1000 the player board spends most of its space on empty regions: three fixed
opponent panels that are mostly blank early in the game, a large empty battlefield, and a log
column taller than the decision panel. The current decision does not dominate the screen, and
labels are small and abbreviated.

**Proposal** (a slice of Phase 9.2 and 9.5):

1. Opponent panels sized by content, with an expanded state for the active, attacking, or
   targeted seat.
2. A persistent resource strip for the human seat: life, mana available by color, land drop,
   commander tax, graveyard/exile counts.
3. Make the decision panel the visual anchor: larger prompt, the U2 playable list, and a
   bot-turn summary ("P2 played Forest, cast Llanowar Elves") replacing the four-line recent
   actions list.
4. Let the log collapse to a smaller height by default on the player board.

**Process.** Because this is the largest visual change, produce a static mock (or a screenshot
of a branch prototype with real card art) for review before implementation, then land it in
steps: strip, panels, decision anchor, log.

**Verification.** Existing Card Test Lab Playwright suite (layout changes must not break its
locators), plus screenshot comparison at 1280, 1440, and 1920 widths.

## U5 Test coverage for the player flow

- **A real human-play e2e.** Nothing drives a player game past the opening hand. Add one seeded
  Playwright flow: keep, play a land, cast a spell with auto-pay, attack, pass, abandon with
  confirmation. Use built-in bots for determinism.
- **Wire `test:e2e:setup` into CI.** It covers Play my deck against a real database but is not
  run in CI because CI lacks the gitignored Scryfall bulk file. A committed small Oracle fixture
  (the `coverage-oracle.json` population is enough) would let it run.
- **Stop depending on remote card art.** Many Card Test Lab assertions use `getByAltText(card
name)`. `CardImage` removes the `<img>` when the art fails to load, so the suite fails offline
  or when Scryfall is slow. Add a stable `data-card-name` (or `aria-label`) to the card wrapper and
  assert on that instead.

## U6 Narrow-screen layout (deferred)

Recorded so it is not lost. At 390×844: the hand is not shown at all (a discard decision cannot be
answered), opponent panels collapse to clipped strips, the header and playback controls overflow,
and the top navigation wraps. The 2026-09-05 trial's recommendation stands: persistent hand/action
area, one selectable opponent panel, collapsible log.

## Out of scope here

- Bot mulligan policy. Built-in bots took two mulligans in the sampled game. That is
  `packages/bot` policy, not UI; investigate separately if it keeps showing up.
- Card art availability. Art loads from Scryfall at runtime; offline play shows initials.
