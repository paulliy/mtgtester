# Audit remediation - 2026-09-05

This follows the September 4 project review and the delayed-trigger/override follow-up. Changes were made in the existing dirty working tree; pre-existing card-coverage and combat-search work was preserved. No commit was created and no production database or AI provider was used for validation.

## Outcomes

- Restored legal priority during upkeep, draw, and bystander combat windows. Pump spells and abilities remain available outside combat. Explicit player yields still work.
- Fixed overlapping hybrid mana allocation in both planning and actual pool spending. Added optimistic color-capacity bounds to reject impossible flexible-source searches early.
- Manifest now enters face down before entry replacements and triggers, suppresses printed abilities and rule statics, and hides its identity in opponent projections and the public zone-change event. Face-down objects also lose printed supertypes, ward, protection, and activated abilities.
- Lethal/zero-toughness creature deaths and zero-loyalty/defense deaths are collected against one board state. Death triggers see the complete event before any member leaves; linked exile returns wait until all members have moved.
- Life payments cannot exceed available life. Paying exactly the current total remains legal.
- Sram triggers for Aura, Equipment, and Vehicle spells you cast, not arbitrary artifacts or opponents' spells.
- Removed executable approximations for Pearl-Ear, Killian (Decisive Mentor), Sage's Reverie, Spirit Mantle, Scriv, Songbirds' Blessing, and Promise of Loyalty. These are explicitly unsupported, not fully implemented fixes. The real-card coverage test confirms all seven are excluded.
- Concurrent game starts are rejected. Setup failures preserve the current game; cancellation/disconnection prevents a pending replacement from installing. Interactive starts and batch starts exclude each other.
- The game server binds to IPv4 loopback, checks local Host and browser Origin, and accepts the configured server port or the standard Vite UI origin on port 5173. The Vite proxy explicitly targets IPv4 loopback.
- Thrown batch setup and session-construction errors produce durable terminal failures. At server startup, interrupted batches and their unfinished game rows are recovered; completed history is preserved. Recovery runs after the listening port is acquired.
- Invalid historical flood/drought percentages return null and display **Unavailable**. Existing raw records are preserved for inspection. This is a mitigation, not a rebuilt metrics pipeline.
- Event polling uses a binary search plus a suffix copy instead of filtering the entire retained log.
- Added Vue template type checking and essential Vue lint rules, fixing the newly exposed stale combat cursor reference, DOM ref signatures, optional props, route access, and unused import. Added a lint guard against generator-bodied Vitest tests.
- Added three mocked browser smoke tests for setup/navigation, unavailable mana metrics, and statistics request recovery.

Hellkite Courser's repaired test, Hunter's Insight, Herd Heirloom, Land Tax, Parasitic Impetus, and the Iymrith cache regression were already passing when work resumed. They were verified rather than attributed to this patch.

## Original finding status

| Finding | Status after this work |
| --- | --- |
| F01: strategic filtering changes legality | Reproduced cases fixed; explicit user yields retained. |
| F02: manifest identity and printed behavior | Reproduced entry/static/visibility defects fixed. Full face-down rules and all information-flow paths are not exhaustively audited. |
| F03: tapped state omitted from cache | Fix was already present; Iymrith regression passes. |
| F04: sequential simultaneous SBAs | Simultaneous lethal/zero-characteristic death group fixed. A complete transaction covering every combination of legend choices, attachment SBAs, counter cancellation, and player elimination remains architectural work. |
| F05: hybrid payment false negative | Reproduced pool/source cases fixed in planning and spending. |
| F06: impossible mana search stalls | Missing-color stall fixed with suffix feasibility bounds. General search memoization and the costly-source solver's existing limitations remain. |
| F07: approximate overrides | Sram corrected; seven identified approximations quarantined. Prior Land Tax/Parasitic fixes retained. Other authored overrides still need a systematic semantics audit. |
| F08: invalid mana statistics | Misleading percentages withdrawn. Accurate versioned measurements still required. |
| F09: asynchronous start race | Fixed, including failed setup preservation and pending-start cancellation. |
| F10: network control exposure | Restricted to the local application boundary. Authenticated LAN/remote sharing is not implemented. |
| F11: batch exceptions strand active state | Setup/construction failures handled; restart recovery added and tested. Unrecoverable database write failures still require operator intervention. |
| F12: unaffordable life payment | Fixed and tested at 0, 1, 2, and 3 life. |
| F13: missing Vue/browser validation | Vue checking/lint and three browser tests added. Full import-to-winner browser coverage and hosted CI remain open. |

## Evidence and validation

- Full Vitest run before the final isolated recovery addition: **167 files, 1,342 tests passed**, 26.49 seconds.
- Added SQLite recovery regression: **1 test passed**, using Bun with an in-memory database. It verifies terminal failure, completed-history preservation, and idempotent recovery.
- Browser tests: **3 passed**; network/AI interactions mocked.
- Production TypeScript, Vue templates, and engine/server test types pass.
- ESLint, including Vue files, passes.
- Production web build passes: 206.47 kB JS / 71.65 kB gzip; 53.02 kB CSS / 9.99 kB gzip.
- All original engine correctness reproductions now return their expected results.
- Only the 16 registrations for the eight audited cards were updated in the golden snapshot. The previous working-tree snapshot was backed up; unrelated entries were preserved. The complete registry check passes at 818 registrations. That count includes earlier work, not just this patch.
- One full-game async test needed a 15-second integration-test budget after restoring legal response windows. It remains an actual game-to-winner assertion; no test was skipped or marked expected-failing.

The original review's "1,249 passed" was a runner result that included three generator-bodied tests whose assertions did not execute. Those three were converted before this work resumed. The new lint guard prevents the direct `it/test(..., function* ...)` pattern from recurring.

### Performance

Synthetic medians on the same local workspace, not claims about whole-game throughput:

| Case | Original review | After fixes |
| --- | ---: | ---: |
| Impossible 16-source G/W payment needing U | ~2,363 ms | ~0.08 ms |
| 1,000 empty event polls against 100,000 retained events | ~500 ms | ~0.18 ms |

Stable-board characteristic queries still show the original repeated-digest cost. Revisions/indexes need disciplined mutation ownership first; this change does not pretend to deliver that architectural refactor.

## Next implementation work

1. Restore the seven quarantined cards only with exact primitives and positive/negative behavioral fixtures. In particular, protection from creatures needs targeting, blocking, damage, and attachment rules together; Promise of Loyalty needs survivor choice, vow counters, and source-relative attack restrictions.
2. Build versioned mana observations at the correct player end-turn boundary: actual draw history, player-turn count, battlefield lands, available mana, land-drop outcome, and affordable/uncastable hand counts. Legacy rows cannot reconstruct these fields and must not be silently reinterpreted.
3. Extend the simultaneous-move boundary to a complete SBA transaction with last-known characteristics, including mixed kinds of SBAs and legend choices.
4. Replace repeated board digests with evaluated-board reuse and scoped revisions after centralizing mutations. Add failed-state memoization and address the costly-source payment solver's existing restrictions and ordering limitations.
5. Continue the systematic override audit, headless recording policy, database migration/error handling, and full browser game flow described in the original report.

## Files to inspect

- [Engine regression tests](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/tests/audit-regressions.test.ts)
- [Server lifecycle tests](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/ws/audit-lifecycle.test.ts)
- [SQLite recovery test](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/db/batches-recovery.test.ts)
- [Browser smoke tests](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/apps/web/e2e/audit-smoke.spec.ts)
- [Final audit reproduction output](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/audit-checks-after.log)
- [Full test output](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/audit-fix-tests-final.log)
- [Pre-update override snapshot](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/override-defs-before-audit-fixes.json)
- [Original project review](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/project-review-2026-09-04.md)
