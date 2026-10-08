# Player smart-yield review

Smart yield repeatedly asked the player to decline opportunities they had already declined.
This change makes the preference apply immediately and remembers declined opportunities while
preserving new response windows and required decisions.

## Findings and fixes

- Choosing Smart yield during a response/combat window immediately reoffered the same action.
  It now declines the current opportunity for that spell or printed activation, including its
  modes and X values. If only passing remains, the session submits an ordinary engine pass.
- Passing a smart-yield stop did not remember the decision. The session now records accepted
  passes against the visible stack-object ids and combat checkpoint. Other players passing or
  declined stack objects resolving do not wake the action again. New stack objects and relevant
  combat changes do. Stale submissions cannot dismiss an opportunity; reconnecting preserves it.
- The same broad combat policy applied to utility abilities, and it kept stopping after damage.
  Known draw, scry, and library-search activations use modeled effect metadata to stay quiet for
  unrelated targeted interaction and combat. They wake for source/player interaction and once
  at the last opponent end step before the player untaps. Unknown effects and team protection
  retain conservative stops. Ordinary post-damage and end-of-combat windows stay quiet; the gap
  between first-strike and normal damage remains available.

Rules legality, required payments/targets, and attack/block declarations still use the engine's
ordinary menus. Preferences persist across turns. Resume removes a preference. Unyielded
optional actions can still require input, and untargeted opponent effects still stop conservatively.

## Validation

- 38 focused tests passed: smart yields, ordinary activations, and modal activation announcement.
  The session regressions exercise actual priority progression, stale submissions, reconnect,
  required declarations, War Room's modeled effect metadata, and the next upkeep.
- Both new browser regressions passed against the real frontend/server: quiet windows followed
  by one declined combat stop, and immediate yielding of a live opponent spell. Traces and
  screenshots are retained under `test-results/player-smart-yield-*`.
- Both DB-backed seeded player-game/setup browser tests passed.
- Production/test typechecks, lint, changed-file formatting, and the web build passed.
- Benchmark compatibility pins were refreshed for the descriptive engine metadata change;
  all 11 benchmark compatibility/refresh tests passed. Card-definition pins did not change.

The broader suites are not clean. The full unit run reported unrelated AI strategist-state and
card-coverage expectation failures, plus two evidence-parser timeouts. The later gameplay/unit
rerun reproduced the AI/coverage failures; its engine compatibility failure was resolved by
refreshing the benchmark pins. The full viewer run passed 93 tests and stopped at the separate
Conjurer's Closet test, skipping the rest of that serial card suite. Repository-wide formatting
reported 384 files, so only changed files were formatted.
