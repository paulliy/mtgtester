# UI polish plan

Prepared 2026-10-04 for review. Status: **done** — U1–U5 shipped on 2026-10-04; U6 (narrow screens) stays deferred. The
[2026-10-04 review](../reviews/ui-polish-2026-10-04.md) has the before/after screenshots.
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

| Order | Item                                     | Size   | Why this position                                        |
| ----- | ---------------------------------------- | ------ | -------------------------------------------------------- |
| 1     | U1 Recover an orphaned player session    | Small  | Done 2026-10-04 (idle expiry only, by decision)          |
| 2     | U2 Make playable actions obvious         | Medium | Done 2026-10-04, including the land-drop reminder        |
| 3     | U3 Correct "Who beats me" and tidy stats | Medium | Done 2026-10-04                                          |
| 4     | U4 Player board hierarchy and density    | Large  | Done 2026-10-04 (built directly, at the owner's request) |
| —     | U5 Test coverage for the player flow     | Medium | Done 2026-10-04                                          |
| Later | U6 Narrow-screen layout                  | Large  | Deferred by decision on 2026-10-04                       |

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

**Done.**

1. The runner credits an eliminator (`eliminatorFor` in `match/runner.ts`) only for a player who
   lost, not by drawing from an empty library, to another seat. It is still "last seat to deal
   damage", so a life-loss effect after that damage is not seen.
2. Both "Who beats me" queries apply the same rule, so rows written before the change display
   correctly without being rewritten.
3. Saved and imported decks are listed first; pool-generated decks are folded into a collapsed
   "Generated decks (N)" section. They are not merged by commander, because each generated deck
   has its own random list. One "Flood / drought: Unavailable" tile replaces the two mana tiles
   when neither rate can be calculated.

Regressions: `packages/server/src/db/stats-attribution.test.ts` (real SQLite with the old row
shapes: a winner, a self-attribution, a decked player; plus the `generated` flag), `eliminatorFor`
unit tests and a full seeded game in `match/runner.test.ts`, and a mocked stats page test in
`apps/web/e2e/audit-smoke.spec.ts`.

## U4 Player board hierarchy and density

**Problem.** At 1440×1000 the player board spends most of its space on empty regions: three fixed
opponent panels that are mostly blank early in the game, a large empty battlefield, and a log
column taller than the decision panel. The current decision does not dominate the screen, and
labels are small and abbreviated.

**Done** (a slice of Phase 9.2 and 9.5). The owner asked to build this directly rather than
review a mock first.

1. Opponent panels size to their boards, capped at 40% of the table height, and the active
   opponent's column is wider. Labels read "7 in hand · 92 in library".
2. A resource strip for your seat: land drop, **Mana ready** with colors, floating mana, commander
   tax, hand, library, graveyard, and exile. Mana ready comes from a new engine projection,
   `PlayerBoardState.viewerMana`: floating mana plus mana from sources that need no mana to
   activate and whose mana has no spending restriction, so it never overstates what is freely
   spendable. The AI view's `availableMana` was not reused because it credits a flexible source to
   every color at once.
3. "Since your last action" groups each opponent's log lines since you last did something other
   than pass (latest three per seat, plus a count), replacing the flat four-line list. The "Playable
   now" list collapses identical entries ("Play Swamp ×3").
4. The decision panel takes priority over the log in the rail, with a larger prompt.

Found along the way: a finished single-player game kept refusing starts from other browsers; the
server now lets any local browser replace a game that is over.

## U5 Test coverage for the player flow

**Done.**

- **Real player-game e2e.** `apps/web/e2e/player-game.spec.ts` plays seed `e2e-6` against built-in
  bots: keep, the land-drop reminder, a land from "Playable now", a spell paid by auto-pay, the
  opponent summary on the next turn, "Pass anyway", and abandoning with confirmation. Combat from
  the player board and a full game to victory are still not covered.
- **`test:e2e:setup` runs in CI.** `serve --oracle-fixture` loads the committed
  `packages/server/fixtures/coverage-oracle.json`, so the DB-backed specs no longer need the
  gitignored Scryfall bulk file. `player-setup.spec.ts` now abandons its game so the specs do not
  depend on order.
- **No dependency on remote card art.** The three `getByAltText` assertions now match
  `role="img"` by name, which the art placeholder already exposes. The full Card Test Lab suite
  passes with Scryfall unreachable.

## U6 Narrow-screen layout (deferred)

Recorded so it is not lost. At 390×844: the hand is not shown at all (a discard decision cannot be
answered), opponent panels collapse to clipped strips, the header and playback controls overflow,
and the top navigation wraps. The 2026-09-05 trial's recommendation stands: persistent hand/action
area, one selectable opponent panel, collapsible log.

## Out of scope here

- Bot mulligan policy. Built-in bots took two mulligans in the sampled game. That is
  `packages/bot` policy, not UI; investigate separately if it keeps showing up.
- Card art availability. Art loads from Scryfall at runtime; offline play shows initials.
