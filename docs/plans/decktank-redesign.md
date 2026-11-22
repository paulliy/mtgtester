# Decktank redesign: implementation plan

Status: proposed, 2026-11-22. Planned on Claude Opus; the board and combat phases are high-effort and should be re-planned task by task before implementation, per [AGENTS.md](../../AGENTS.md).

This plan brings the "Decktank" redesign into `apps/web`. The design was mocked up as interactive canvas screens; their source is copied into [docs/design/decktank/](../design/decktank/) as reference. Each `.dc.html` file is one self-contained screen: the markup is the layout and styling, and the `class Component` script at the bottom is the behaviour (state, handlers, animation maths). The scripts use sample data throughout; nothing in them is a source of truth for game data.

| Mockup file                                   | Becomes                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `Main.dc.html`, `MainPhone.dc.html`           | `SetupView.vue` (New game: compass, setup panel, inline deck picker)          |
| `TopBar.dc.html`                              | `App.vue` navigation (ruler nav, phone menu)                                  |
| `Deck.dc.html`                                | Superseded by the inline deck picker in `Main.dc.html`; reference only        |
| `Board.dc.html` (+ `BoardMedium`, `BoardMany`) | `PlayerGameView.vue`, `GameView.vue`, `SeatPanel.vue`, `PermanentChip.vue`     |
| `CombatDeclare.dc.html`, `CombatBlock.dc.html` | `CombatOverlay.vue`, `combatPlan` store, `PermanentChip.vue`                   |
| `Stats.dc.html`, `Batches.dc.html`            | `StatsView.vue`, `BatchResultsView.vue`, `BatchSetupView.vue`                 |
| `CardLab.dc.html`                             | `CardTestLabView.vue` plus a new import report (phase 4)                      |
| `Deals.dc.html`, `Debug.dc.html`              | `DealsPreviewView.vue`, `DebugView.vue`                                       |

## What exists today, and what that means for the plan

- The UI is Vue 3 with plain CSS (`apps/web/src/styles.css`): a dark theme with a light `prefers-color-scheme` variant, system fonts, and CSS variables `--bg --surface --surface-2 --line --text --muted --accent --ok --warn --danger` that every component reads. The redesign keeps plain CSS. Brief §2 forbids a component framework and an animation library, and the mockups need neither, since every animation in them is CSS or a `requestAnimationFrame` loop. What changes is the visual direction: a light paper-and-ink theme, serif display type, and more motion. That needs an ADR (phase 0).
- Most of the interaction the mockups show already exists in some form:
  - **Combat lines:** `CombatOverlay.vue` draws dashed lines while you plan and solid ones once declared.
  - **Following the pointer:** a drag line follows the pointer (`draggedId` and `dragPointer` in `PlayerGameView.vue`).
  - **Anchors:** `useBoardAnchors` measures cards and seats so lines know where to go.
  - **Reduced motion:** honoured through `game.reducedMotion` and the `.reduced-motion` CSS override.

  The combat work is therefore an extension of this code, not a rewrite.
- Setup already does what the mockup's setup panel does:
  - **Seat choices:** game mode, who controls each seat (`random` is the built-in bot, `ai` the language-model bot), rerolls and the seed.
  - **Preview:** a live matchup preview (`POST /api/setup-preview`).
  - **Decks:** known and saved deck galleries, plus URL and plaintext import.

  Batch setup is a separate route (`BatchSetupView.vue`).
- A failed import only reports `"<seat>: Deck is not fully modeled."` in `SetupPreview.blockers`. The names of the unmodeled cards are computed for saved decks (`packages/server/src/match/preview.ts`) but never sent. The README lists "failed-import draft preservation" as open product work. Phase 4 closes both gaps.
- The Card Test Lab (`/card-test-lab`) is a dev-only list of engine scenarios (`CardTestScenarioMetadata`: title, instructions, `oracleSha256`, `clauseIds`). Per-card evidence of the kind the mockup shows lives in `docs/plans/card-catalog-audit.json` (`implementationStatus`, `engineEvidence`, `viewerEvidence`, `gameplayAiEvidence`) and in the completion rule of [card modeling and testing](../guides/card-modeling-and-testing.md). No endpoint serves it yet.
- The Playwright suites find elements by role and accessible name: the heading "New game", the buttons "Start game" and `Keep N`, deck buttons named by commander, and many board controls in the `white-black-control-*` and `*-card-test-lab` specs. Every phase keeps those names, or updates the specs in the same pull request.

## Phase 0: decisions (one ADR, no code)

Write ADR 0052 "Decktank visual identity", amending the brief §2 styling row and ADR 0021. Run `bun run adr:index`. It records:

1. **Name.** The product is "Decktank". This plan changes only the user-facing brand: the nav brand, `index.html` title and README heading. Package names (`@mtg/*`) and the repository name stay.
2. **Theme.** Paper `#f5f3ec`, ink `#2d2a2a`, muted text `#66625f`, rules `#bdbbb6`, warm accent `#a77e5f`, and the muted Magic colours W `#ddd2b0`, U `#9fb1c1`, B `#5e5753` (light letter), R `#c99580`, G `#9cae94`, colourless `#d6d4ce`. Status colours (ok, warn, danger) get muted equivalents chosen for 4.5:1 contrast on paper.
3. **Dark mode.** Decide: drop it, or keep a night variant of the same tokens. The recommendation is to ship light first and keep every colour in tokens, so a night theme is a later token swap.
4. **Fonts.** Bodoni Moda (display), Archivo (labels and buttons), Cutive Mono (body). All three are OFL. Self-host them under `apps/web/public/fonts/` rather than loading Google Fonts, because the app runs locally and offline. Add them to `THIRD_PARTY_NOTICES.md`.
5. **Motion.** Motion is allowed as CSS transitions and `requestAnimationFrame` loops, with no library. Every animation is off under reduced motion, and an animation never delays a state change: the state lands at once and the motion is decoration on top.
6. **Batch mode.** Fold batch setup into the New game screen as the compass's East option (the mockup's design), with `/batch` kept as a redirect. Or keep `/batch` as its own restyled page. The recommendation is to fold it in.
7. **The fourth compass option.** The mockup shows "Multiplayer · soon". The table server (ADR 0031) already exists, so either link it to the table app or leave it disabled.
8. **Import report in production.** The Card Test Lab is dev-only. Phase 4's failed-import report must work in production, so it is a separate, always-available route; the scenario runner stays dev-only.

## Phase 1: foundation (1 pull request)

**Files:** `apps/web/src/styles.css` (split into `styles/tokens.css`, `styles/base.css`, `styles/motion.css`); `apps/web/index.html`; `apps/web/public/fonts/*`; `App.vue` (brand only); `components/ManaPips.vue`; `components/DeckColors.vue`.

1. Add the tokens: `--paper --paper-2 (#eeeadf) --ink --ink-soft (#413e3d) --muted --rule --accent`, the mana colours `--mana-w/u/b/r/g/c` plus light tints for unselected filters, the three font families, the house easing `--ease: cubic-bezier(0.165, 0.84, 0.44, 1)`, and spacing.
2. Add a compatibility layer: map the old variables onto the new tokens (`--bg → --paper`, `--surface → --paper`, `--surface-2 → --paper-2`, `--line → --ink`, `--text → --ink`, `--muted → --muted`, `--accent → --ink`, plus the muted status colours). Every existing component then switches theme with no edits, and later phases restyle them one at a time.
3. Base styles from the mockups:
   - **Outlined button:** the 1px ink border with uppercase Archivo 0.7rem/0.08em fills ink on hover, with an arrow that nudges 3px.
   - **Primary button:** solid ink.
   - **Inputs:** an underline only.
   - **Focus:** a 2px ink outline.
   - **Keyframes:** the shared ones (`orrRiseA/B`, `orrFade`, `orrRule`, `orrTick`, `orrDrop`).
4. Merge `ManaPips` and `DeckColors` into one `ManaPip` component: a 1px ink ring, a Bodoni letter, the muted fills, WUBRG order, C for colourless, and one `aria-label` naming the colours. Keep both props shapes, or keep `DeckColors` as a thin wrapper.
5. Rename the brand: the nav `.brand` text and the `<title>` become "Decktank".

**Checks:** `bun run typecheck`, `lint`, `format:check`, the web build, `bun run test`, `test:e2e:setup`. Add screenshots of setup, the board and stats to `docs/reviews/` (the repository's browser-trial convention).

## Phase 2: shell and navigation (1 pull request)

**Files:** `App.vue`, plus a new `components/shell/RulerNav.vue` and `components/shell/PhoneMenu.vue`. Reference: `TopBar.dc.html` and the header in `Main.dc.html`.

1. Replace the flat link row with the ruler. Places are grouped as I. New game, II. Records (Stats, Batch runs) and III. Workshop (Card lab, Deals, Debug). The dev-only items stay behind `import.meta.env.DEV` as now. A warm tick marks the current route and slides to the hovered item (one absolutely positioned bar with a `transform: translateX` transition; the mockup's `navAt * 7.2rem` maths).
2. When a game is running (`store.gameId !== null`), show a "Return to game" item, because the mockup's nav has no Board entry and the board is reached from setup.
3. Keep `#top-bar-status`: the board teleports round and phase into it.
4. Below 760px the brand becomes a button that opens a full-height sheet of places with descriptions (`MainPhone.dc.html`).
5. The New game opening screen hides the bar (phase 3 sets a flag the shell reads).

**Checks:** nav e2e locators. The current links are named Setup, Board, Stats, Debug, Batch, Card Test Lab and Deals. Grep `e2e/` for any spec that clicks them, and update it.

## Phase 3: New game (3 pull requests)

`SetupView.vue` is 1,242 lines. Split it while restyling, so the result is a thin view over components:

| New file                               | Holds                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `components/setup/ModeCompass.vue`     | The instrument: bezel, rings, rose, needle, four options, opening artwork, "Where to?"              |
| `components/setup/SetupPanel.vue`      | The right-hand panel: summary plate, tabs (Seats, Bots, Pacing or Scenarios, Extras), Start button  |
| `components/setup/DeckPicker.vue`      | The inline deck chooser that takes the compass's place                                              |
| `lib/compass.ts` (+ `compass.test.ts`) | Pure angle maths: wrap, shortest turn, cumulative needle, ring landing, magnet snap and release      |
| `stores/setup.ts` (optional)           | Setup state now spread through the view, if splitting needs a shared store                          |

**3a. Compass** (reference: `Main.dc.html`, `renderVals`, `kickRings`, `dialMove`, `dialUp`, `replayOpening`):

- **Options:** four buttons on a plate that rotates so the chosen one comes to north (rotation `-angle`, with each label counter-rotated `+angle`). Angles are cumulative, so repeated clicks add turns instead of jumping. The needle and rose hold north.
- **Hover:** the needle leans toward a hovered option or follows the pointer over the face. It snaps on within 12° and releases past 17°, with a 0.4s spring back. Leaving an option button waits 40ms before the needle returns.
- **Drag:** dragging the face turns the plate with the pointer. On release, the nearest option within 32° comes to north.
- **Rings:** three rings each spin about a turn in alternating directions per change and land on quarters (`kickRings`).
- **Opening screen:** the star-chart artwork (degree ring, pentagram with the muted colour letters, orbit and planet, rotating constellations) shows until the first choice. It returns once per browser session, under the key `sessionStorage['decktank.opened.<key>']`, with a "Replay opening" link to see it again. Move the large static SVG paths into a `.svg` asset or a constants module, not inline in the template.
- **Accessibility:** the options stay real buttons with `aria-pressed`. Add left and right arrow keys to move between them. Everything decorative is `aria-hidden`.
- **Reduced motion:** no ring spin, drift or swing; option changes apply instantly.

**3b. Setup panel** (reference: the `<aside class="setup">` in `Main.dc.html`). Wire it to the existing state; don't invent new state:

| Mockup                                  | Today                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Play / Watch                            | `StartGameMode` (player vs spectator)                                                     |
| You / Built-in / AI per seat            | `SeatControllerKind` (`human`, `random`, `ai`); labels from `lib/providerLabels.ts`        |
| Seats tab: deck, Change deck, Reroll    | Current seat summary, pool reroll, gallery selection                                      |
| Pacing: Live or Step by hand, Pace      | Current playback and pace settings                                                        |
| Extras: Table talk, Replay seed         | Current table-talk (ADR 0035) and seed fields                                             |
| Batch: Scenarios                        | `BatchSetupView.vue` form (if phase 0 folds it in)                                        |
| Summary plate                           | Derived from the same state and the preview response                                      |

Keep the live preview on every change, the client-fixed seed, `useConfirmedStart`, the start errors and `recentSetup`. Keep an `<h1>` named "New game" (visually hidden if the display title is "Play against bots") so `player-setup.spec.ts` keeps working. Below 900px the panel stacks under the compass at full width, as in the fixed mockup.

**3c. Inline deck picker** (reference: the `picking` branch in `Main.dc.html`). "Change deck" on a seat swaps the compass for the picker. Cancel or "Use this deck" brings the compass back, and its entrance animation replays. The picker has:

- seat buttons A to D
- commander search and WUBRG filters (muted tints, full colour with a 3px ink border when on)
- I. Generated, II. Modeled decks (`/api/known-decks`), III. Saved decks (`/api/saved-decks`)
- IV. Bring your own: the existing URL and plaintext `SeatSource`, checked through the setup preview

**Checks:** `compass.test.ts`, all existing setup unit tests, `test:e2e:setup`, plus one new e2e that changes a seat's deck through the picker and starts.

## Phase 4: failed import goes to the Card lab, with an LLM work order (3 pull requests)

**4a. Server and protocol.** In `packages/shared/src/protocol.ts`, extend `SetupPreviewSeat` with `unmodeledCards?: { name: string; oracleSha256?: string; status: 'unsupported' | 'implemented-unreviewed' | 'provisional' }[]`. Fill it in `packages/server/src/match/preview.ts` for URL, plaintext and saved seats. The saved-deck path already computes the names; the status comes from `interpretCard`, the provisional tier (ADR 0050) and the catalog audit. The protocol comment says "No card list or private card data crosses this boundary". Amend it in the ADR, because every previewed deck was supplied by the user at setup, and these are only its unmodeled names. Add preview tests for an import with unsupported cards.

**4b. Import report screen.** Add a production route, `/workshop/import-report` (phase 0, decision 8):

- **Data:** a Pinia store `importReport` holds the last failed import: the seat, source text or URL, deck name and the unmodeled cards. It is mirrored to `sessionStorage` so a reload keeps it. This also keeps the pasted list, which fixes the open "failed-import draft preservation" issue.
- **Entry point:** when the preview blocks an import, the picker shows the cards and an "Open in Card lab" link.
- **Layout:** the report follows `CardLab.dc.html`'s "Imported deck" tab: a needs-work / supported / all filter and a card list. Selecting a card shows its Oracle text, clauses, scenarios and evidence.
- **Card data:** a new endpoint, `GET /api/card-report?names=…`, returns per card the Oracle text, `oracleSha256`, implementation status, and the evidence fields from `card-catalog-audit.json` (`engineEvidence`, `viewerEvidence`, `gameplayAiEvidence`) where reviewed. Lab scenarios for the card are matched by `oracleSha256`. Show only evidence that exists; never default to "6 of 6".

**4c. Work order.** Add `lib/workOrder.ts` (pure, with `workOrder.test.ts`), reference `workOrder()` in `CardLab.dc.html`. Its Markdown output is built from real data:

1. the deck and source, with counts
2. the goal: one pull request that models the listed cards
3. the definition of done, copied from the completion rule in [card modeling and testing](../guides/card-modeling-and-testing.md): pinned Oracle, clause mapping, positive and negative engine scenarios, the normal cast or activation path, real-viewer evidence, and separate gameplay-AI evidence
4. per card: Oracle text, hash, status, known clauses and scenarios, and the evidence still missing
5. a pointer to `AGENTS.md` and the card coverage workflow, plus "do not change supported cards"
6. the cards already supported

Offer "Save work order" (Blob download, file `decktank-work-order-<deck>.md`), "Copy for an LLM" (Clipboard API), and a preview with the full text as the fallback when either is blocked.

**4d. Card Test Lab restyle** (dev-only). Restyle `CardTestLabView.vue` to the same layout: scenarios grouped by card through `oracleSha256` and `clauseIds`, the "Run all scenarios" sequence, and the evidence column. Keep every name the `*-card-test-lab.spec.ts` suites use. Those suites are large and sampled in CI (ADR 0037), so run `ci:lab-verbose` on this pull request.

## Phase 5: board (4 or more pull requests; re-plan on Fable or Opus before starting)

`PlayerGameView.vue` is 3,078 lines, and the board is the highest-risk surface because nearly every gameplay e2e drives it. Restyle bottom-up, one component per pull request, after phase 1's compatibility layer has already moved it to the new palette:

1. **Card tile** (`PermanentChip.vue`, `HandStrip.vue`, `CardImage.vue`, `CardPreviewOverlay.vue`):
   - **Frame:** a 5:7 ink frame with the name in Archivo capitals and a P/T box in the lower right.
   - **Supertype:** Legendary, Basic or Token as an outlined tag in the art's corner.
   - **Card type:** a small muted line.
   - **Subtypes:** a Bodoni line.
   - **Commander:** a double border.

   Type-line data comes from the server presentation (ADR 0032). If the parts aren't split there, split them server-side, not in the view.
2. **Seat panels** (`SeatPanel.vue`, `ZonePile.vue`, `ZoneStrip.vue`, `CommanderDamageGrid.vue`): a large Bodoni life total, the commander name hoverable for its card, "Cmdr in play" or "Cmdr in zone", the colour pips, and the side rail (Life, Graveyard, Exile, Library, Cmdr tax).
3. **Top bar and turn** (`#top-bar-status` content): "Round N" in Bodoni, a solid "Your turn" tag, and a step ruler (Beginning, Main, Combat, Second main, End) with filled finished steps and a sliding warm dot. On phones only the current step keeps its label.
4. **Commander in hand:** while castable from the command zone, the commander sits at the start of the hand behind a rule, with its tax on hover.
5. **Combat strip:** the summary bar with its legend (Attacking, Chosen not confirmed, Blocking) and an × to hide it, restored from a "[ Combat ]" control in the top bar.

`GameView.vue` (spectator) shares the components; check it after each pull request. **Checks:** `test:e2e` (gameplay suites) on every pull request in this phase, with `ci:e2e`.

## Phase 6: combat declaration animation (2 pull requests; re-plan before starting)

Reference: `CombatDeclare.dc.html` and `CombatBlock.dc.html` (`frame()`, `draw()`, and the `mine` and `opps` click handlers). Build on `CombatOverlay.vue`, `combatPlan`, `useBoardAnchors` and `PermanentChip.vue`; the protocol doesn't change.

**6a. Geometry, anchors and click-to-lift.**

- **Geometry:** add `lib/combatLines.ts` (pure, unit-tested): the cubic curve between two points (vertical tangents, control length `max(40, 0.45·|dy|)`), the arrowhead and block bar oriented along the end tangent, the overshoot easing for the fly-in, and seeded two-sine wobble noise.
- **New anchors:** register `life:<seatId>` on each seat's life total and `pt:<objectId>` on each P/T box, so attack lines end on the defender's life and block lines on the attacker's P/T.
- **Click-to-lift:** add it as an alternative to today's HTML5 drag, and keep drag working. Clicking an eligible creature lifts it (CSS transform and shadow on the chip; a slow bob) and starts a line that follows the pointer (`dragPointer` already exists). Clicking a target places the assignment through the existing `combatPlan` actions. Clicking the creature again, or empty board, cancels. Keyboard focus with Enter does the same through the existing `focusedSourceId` path.

**6b. Motion.**

- **Placing:** a placed line flies from the release point to its anchor (about 460ms, slight overshoot).
- **Wobble:** while declaring attackers, the following line wobbles strongly and the pending lines faintly. Use per-line random phases, amplitude from a constant, and run it only while the plan is `composing`. Block lines don't wobble.
- **Lifted creatures:** pending attackers and blockers stay lifted until the declaration is confirmed. They settle when `combatPlan` moves to `replaying` or the declaration is accepted.
- **Engine retry:** a rejected proposal returns to `composing` with the legal remainder. The lift and lines must rebuild from the store, never from component-local state.
- **Performance:** one `requestAnimationFrame` loop owned by the overlay, running only while something animates. Measure through `useBoardAnchors`, not a fresh `getBoundingClientRect` per line per frame.
- **Reduced motion:** no wobble, bob or fly-in; the existing reduced-motion fallback for the overlay stays.

**Checks:** `combatLines.test.ts`, existing `combatPlan.test.ts`, every `white-black-control-*combat*` and `combat-trigger-regressions` spec, and a new e2e that declares attackers and blockers by clicking.

## Phase 7: Records and Workshop (2 or 3 pull requests)

- **`StatsView.vue`:**
  - **Values:** switching decks animates the values in place. Numbers count up or down over about 0.8s and bars slide; entrance animations play once.
  - **Renames:** "Head to head" becomes "Matchups", and the explanatory sentences go.
  - **Generated decks:** listed in a collapsible section.
  - **Buttons:** outlined.
- **`BatchResultsView.vue`, `BatchSetupView.vue`:** restyle, or redirect if batch setup moved into New game.
- **`DebugView.vue`, `DealsPreviewView.vue`:** restyle only.
- **All pages:** the star-and-rule ornament spans each page title, and the footer line reads "Decktank · II. Records · a. Stats".

## Phase 8: multiplayer tables (1 pull request)

`apps/web/src/table/` is a separate bundle (`bundle.test.ts` checks what it contains) and shares components. Apply the tokens and fonts there last, and confirm the bundle check still passes.

## Order and size

| Phase | Pull requests | Depends on | Risk                                                   |
| ----- | ------------- | ---------- | ------------------------------------------------------ |
| 0     | 1 (ADR)       | none       | Low; decisions only                                    |
| 1     | 1             | 0          | Low; compatibility layer keeps every view working      |
| 2     | 1             | 1          | Low; nav locators                                      |
| 3     | 3             | 1, 2       | Medium; largest view, setup e2e                        |
| 4     | 3 (+1 lab)    | 3c         | Medium; protocol and server change                     |
| 5     | 4 or more     | 1          | High; board e2e coverage                               |
| 6     | 2             | 5.1        | High; combat correctness and engine retry paths        |
| 7     | 2 or 3        | 1          | Low                                                    |
| 8     | 1             | 1          | Low                                                    |

Phases 5 and 7 can run in parallel with 3 and 4 once phase 1 lands, as long as they touch disjoint files.

## Rules for every pull request in this plan

- Keep every accessible name a Playwright spec uses, or update that spec in the same pull request.
- Run what CI runs for viewer changes: `typecheck`, `typecheck:tests`, `lint`, `format:check`, the web build, `test:e2e` and `test:e2e:setup` ([testing discipline](../guides/testing-discipline.md)).
- Text contrast stays at least 4.5:1 on paper, including small grey labels. Touch targets are at least 44px. Icon-only buttons get an `aria-label`.
- Every animation honours `game.reducedMotion` and `prefers-reduced-motion`.
- Mockup sample data (deck names, figures, the sample failed import) never ships. Every value on screen comes from the server or the store.
- Attach before and after screenshots in `docs/reviews/` for any screen the pull request restyles.
