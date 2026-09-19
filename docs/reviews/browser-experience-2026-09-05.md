# MTG Tester live browser trial - 2026-09-05

During the September 5 trial, the desktop experience was usable and the simulation could finish a game, but a reproducible payment crash blocked confidence in unattended deck testing. Statistics and narrow-screen gameplay also needed attention.

> **Resolution verified 2026-09-19:** the joint mana, source-tap, and creature-tap payment planner now reserves all required objects before applying the cost. `packages/engine/tests/activation-payment.test.ts` covers the unavailable and payable Revelsong Horn cases through normal legality, activation, and stack resolution. `scripts/reproduce-browser-payment.ts` uses the original derived seed in a focused deterministic reproduction and fails unless the Horn payment and resolution complete. The original generated deck configuration was not captured immutably, so this is not evidence of an exact full-game replay or a turn-48 outcome. The full unit, card-gate, and Playwright suites also pass.

## What I actually tried

Started the real app with `bun run dev`, using the existing local SQLite database and oracle data (6,401 supported cards; 34,997 indexed cards). Exercised the live Vue UI through headless Playwright Chromium at 1440 x 1000 and 390 x 844. No mocked API responses or WebSockets were used. The desktop browser connector failed to initialize because of a Windows sandbox ACL error, so Chromium was driven through a persistent Node session instead.

- Generated spectator game: completed normally after 36 turns. Snow Villiers beat Talrand, Psemilla, and Rivaz. Results modal displayed placements and elimination descriptions.
- Replay: dismissed results, selected Manual, and stepped back from turn 36 to turn 35; the board reflected earlier life totals and permanents.
- Human game, seed `browser-trial-2026-09-05`: kept opening hand, played Forests, yielded priority, discarded to hand size, cast and resolved Pygmy Razorback, then abandoned deliberately after reaching turn 10. Opponent hand names were hidden in the visible UI/log. This was not a comprehensive privacy audit.
- Inspected real historical statistics, modeled-deck choices, and invalid plaintext import handling.
- Ran a one-game batch twice with seed `browser-trial-batch-2026-09-05`, Random provider, all four seats blank/generated. Both runs halted identically.
- No JavaScript page errors, console errors, or HTTP responses >=400 were captured. The engine failure was successfully surfaced through application data, so a clean browser console does not imply a correct game.

These actions created local game/batch records. No AI provider was selected; both batches reported zero AI calls and $0 cost. No application source was edited for this trial.

## Findings, in priority order

### P1 - Reproducible engine payment crash (resolved 2026-09-19)

Both batches halted at turn 28, precombat main phase, after event 928 selected P1's Revelsong Horn activated ability: `{1}, {T}, Tap an untapped creature you control: Target creature gets +1/+1 until end of turn.` The preceding events show P1 casting and resolving the Horn, paying for that spell with two Forests.

Error: `engine bug: cost for P1 became unpayable at application time`.

Reproduction: Batch -> Games 1 -> seed `browser-trial-batch-2026-09-05` -> Random -> leave all seats blank -> Start batch. Derived game seed: `browser-trial-batch-2026-09-05:s1:g1`.

Both runs ended at exactly the same event and turn. The guard is in `packages/engine/src/effects/resolve.ts:4635`, where `payManaCost` receives no viable plan. The underlying legality/payment mismatch is not yet isolated; do not assume the Horn definition alone is responsible. Add this seeded scenario as a regression, then compare the offered ability's costs/source reservations with application-time payment.

The batch UI handles failure well, but its table shows a dash for Turns despite persisted events reaching turn 28. Show the last processed turn, failing action, and a diagnostic/replay link.

Evidence: `browser-trial-2026-09-05/batch-failure-evidence.json`, `10-batch.png`, `11-batch-repeat.png`. Batch IDs: `b-a2ea7b73-cd71-4b47-9148-2318c494a175` and `b-7681bdec-9760-4416-bcac-9b757308eed9`.

### P2 - Statistics contradict their own win/loss summaries

Historical Queen Marchesa and Ur-Dragon entries show 100% wins and no losses, yet list that same commander under "Who beats me". Read-only database inspection found 17 finished winner rows with a non-null `eliminated_by_seat`, including four self-attributions. These are historical records, not proof that the newly played game wrote bad data.

The stats query in `packages/server/src/db/stats.ts:148` includes rows solely on non-null attribution and does not require an actual loss. Filter genuine losses, repair the recording invariant, and separately assess historical repair. Do not silently rewrite historical data without a clear derivation.

UUID deck headings, raw `lifeZeroOrLess` reason codes, and repeated entries for the same commander also make comparisons difficult. Prefer deck names, translated reasons, and explicit snapshot/version grouping. Mana rates correctly say Unavailable, although the repeated empty metrics consume substantial space.

Evidence: `winner-attribution-evidence.json`, `06-stats.png`, `13-stats-detail.png` in the evidence directory.

### P2 - Narrow-screen gameplay hides essential game information

At 390 x 844, the page has no horizontal document overflow, but opponent panels collapse into thin clipped strips and the player's hand/battlefield are not visible in the captured layout. The action log occupies most of the screen. Width containment alone is not sufficient responsive behavior.

Use a mobile layout with a persistent hand/action area, one selectable opponent panel, and a collapsible log. Verify that playable cards remain visible and usable during both human and bot turns. Evidence: `09-human-mobile.png` (Pygmy Razorback resolves in the log, but the board/hand are out of view).

### P2 - Failed imports discard the correction context

Selected Import decklists, entered `not a valid decklist`, and started. The app correctly reported that P1 card names could not be resolved. However, it returned to the default generated-deck setup and hid the supplied deck text. Users should remain in Import mode with the original input preserved and unresolved names identified inline.

Evidence: `12-import-validation.png`.

### P2 - Human Abandon has no confirmation

One click on Abandon immediately terminated the human game and returned to Setup. Spectator mode presents an explicit confirmation dialog. Apply consistent confirmation behavior to avoid accidental loss of an active human match.

### P3 - Defaults and wording weaken the experience

- A Random opponent mulliganed six times and kept two cards. This is legal, but makes the default mode a weak demonstration of meaningful deck testing. Use a sensible opening-hand policy even when later actions are random, or expose a deterministic heuristic opponent separately.
- The cast preview displays `Auto-pay: Forest ? Forest`. This is an actual source string (`PlayerGameView.vue:1087`), not terminal corruption. Replace the separator with a clear comma or plus sign.
- Phase names such as `precombatMain` and `combatDamage`, plus the connection label `open`, should be translated into player-facing language.
- Modeled-deck setup promises fully modeled decks while listing choices with coverage such as 44/76 and 78/86. The counts are useful, but the promise should distinguish complete from partial coverage. This trial did not test whether incomplete choices can start.
- Desktop card art and the log provide rich inspection, but small labels, abbreviations, and dense simultaneous panels increase scanning effort. Make the current decision and relevant cards visually dominant.

## What works well

Setup has a clear hierarchy, explicit provider cost language, and a useful replay seed. The spectator match ran to completion with card art, combat, commander damage, and a readable winner summary. Manual turn replay worked. Human play exposes a focused choice panel, card-based actions, and payment previews. Opponent hands remained visually hidden. Batch failures were durable and clearly distinguished from completed games, and the application remained usable afterward.

## Recommended next pass

1. Keep the focused Horn payment regression in the unit gate and its deterministic reproduction script. Future browser failures should retain the immutable game configuration with the dated evidence.
2. Correct loss attribution filtering and recording, then add mobile gameplay layout coverage.
3. Preserve import drafts and confirm human abandonment.
4. Improve default opponent mulligans and player-facing terminology.

This was an exploratory browser trial, not a complete rules audit. Live AI, external deck-provider URLs, full human combat, reconnection, keyboard-only access, and an entire human game to victory remain untested. The server and Vite UI were left running at http://localhost:5173 for further inspection.
