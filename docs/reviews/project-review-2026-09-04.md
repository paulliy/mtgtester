> Follow-up: see the [September 5 remediation report](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/audit-remediation-2026-09-05.md) for implemented fixes, validation, quarantined cards, and open work. This review records the earlier state.

# Comprehensive project review — MTG Commander Simulator

Review date: September 4, 2026. Reviewed working tree based on commit `c577415c97583f423463ca531106c112433d11e4`, including staged, unstaged, and untracked implementation files.

## Assessment

Keep the TypeScript/Bun/Vue architecture and the deterministic engine/provider boundary. The project has substantial useful infrastructure: explicit game decisions, a compositional card model, seeded play, dedicated player projections, transaction-backed event persistence, bounded combat search, and a large scenario suite. A wholesale rewrite would discard considerable domain knowledge without addressing the main problem.

The immediate priority is **rules correctness and trustworthy measurements**. Several optimizations change the legal game, some cards reported as modeled implement different effects from their text, and the mana statistics do not measure what their labels claim. Those defects can bias deck comparisons even when every existing test passes. Optimize the hot paths after, or alongside, correcting their semantics.

### Scope and evidence

This was an architecture-wide review with detailed inspection of the engine, mana solver, layers, priority/SBAs, representative card overrides, bot search, AI orchestration, server/session lifecycle, persistence/statistics, deck pipeline, Vue stores/views, and tooling. It is not a line-by-line certification of every card. Initial inventory: 344 TypeScript/Vue files, approximately 86,390 lines including tests. The largest files are approximately 5,869 lines of interpretation, 4,962 of effect execution, 1,924 of player UI, and 1,309 of legal-action generation.

Files changed concurrently during this review. An initial test-type error in `state/queries.ts` disappeared in later source; both final type-check commands passed. The full suite result below describes the earlier run, not an atomic snapshot of all subsequent edits. Source hashes and raw outputs are retained in the evidence directory. No application source was changed by this review; additions are this report and its reproduction/evidence files. Build checks generated normal ignored outputs.

| Check                          | Observed result                                                       |
| ------------------------------ | --------------------------------------------------------------------- |
| `bun run test`                 | 158 files / 1,249 tests passed; 32.57 seconds elapsed                 |
| `bun run typecheck`            | Passed, including final recheck                                       |
| `bun run typecheck:tests`      | Initial error during concurrent edits; final recheck passed           |
| `bun run lint`                 | Passed; Vue files are explicitly excluded                             |
| `bun run --cwd apps/web build` | Passed; JS 206.63 kB / 71.73 kB gzip; CSS 53.02 kB / 10.00 kB gzip    |
| `bunx playwright test --list`  | No tests found                                                        |
| Review reproduction harness    | Eight targeted behavior probes demonstrate the issues described below |

No paid AI calls, live deck imports, production database modifications, or network penetration testing were performed. Real-card behavioral coverage and production-scale heap profiling remain outside the measurements here.

## Prioritized findings

P1 means high priority because ordinary supported gameplay, privacy, or responsiveness is affected. P2 means a material correctness/reliability or validation issue with narrower impact. Reproduced findings have output in [review-checks-final.log](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/review-checks-final.log); other findings are explicitly based on source inspection.

### F01 · P1 · Strategy preferences suppress legal actions

[priority.ts:42](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/turn/priority.ts:42) automatically passes all empty-stack upkeep/draw windows and skips uninvolved players during combat. [legal.ts:1234](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/actions/legal.ts:1234) additionally removes temporary pump/keyword effects outside combat. These are strategic judgments inside the authoritative legality layer.

**Reproduced:** P1 has a Mountain and a payable instant in upkeep. The action generator contains a cast, but the priority generator finishes without offering a decision. A payable Giant Growth appears in combat and disappears from the main-phase menu. The latter also prevents saving a creature from damage on the stack during a main phase, and can suppress precombat haste or power-based sequencing.

Move these policies to the heuristic/AI provider, or explicit human yield preferences. Only mathematically forced choices may be auto-resolved by the rules engine. Replace the existing tests that assert blanket auto-passing with legal-window tests and separate provider-policy tests. Priority availability is governed by CR 117, not tactical usefulness; see the [official rules reference](https://media.wizards.com/2026/downloads/MagicCompRules%2020260619.pdf).

### F02 · P1 · Manifest exposes hidden cards and applies face-up behavior

[resolve.ts:3154](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/effects/resolve.ts:3154) moves the card to the battlefield normally and only afterward sets `faceDown = true`. Visibility checks instead read `statuses.includes('faceDown')` in [view.ts:109](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/view/view.ts:109) and [spectator.ts:245](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/view/spectator.ts:245).

**Reproduced through `executeAbility`:** a manifested creature retains an empty status array, queues its printed enters trigger, and exposes its real name and Oracle text to both opponent projections. The human projection also exposes its printing ID. A separate probe shows a face-down Exploration-like card still grants an additional land play because [queries.ts:795](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/state/queries.ts:795) gathers printed rule statics without checking face-down state or effective ability removal.

Make face orientation one authoritative field. Pass entry characteristics into the zone transition before replacement effects and triggers run. Derive active abilities/statics from the same effective-characteristics model, and independently redact every opponent-facing projection, including card art, names, logs, and action presentation. Test actual manifest execution, not only hand-edited status fixtures.

### F03 · P1 · Layer-cache hits can return stale ward

[layer-cache.ts:101](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/effects/layer-cache.ts:101) hashes many permanent fields but omits `tapped`. [urdragon.ts:60](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/cards/overrides/urdragon.ts:60) implements Iymrith's ward as a static effect conditional on being untapped.

**Reproduced:** querying an untapped Iymrith caches ward 4; tapping it and querying again still returns ward 4. Targeting/payment can therefore depend on an earlier query.

Add the missing dependency immediately and audit all static `Condition` inputs. Longer term, centralize mutations and derive cache invalidation from state revisions/dependency domains. Keep a slow uncached oracle for equivalence tests. A 32-bit hash equality alone is also not a correctness proof; use a revision or verify canonical inputs on hash matches. Do not add more caches before establishing their ownership and invalidation contract.

### F04 · P1 · Simultaneous deaths are processed sequentially

[sba.ts:142](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/sba/sba.ts:142) moves the first lethally damaged creature and returns, then repeats the whole check against the changed battlefield. Watchers and continuous effects belonging to the first creature are absent when the second is processed.

**Reproduced:** a 2/2 with “Whenever another creature dies, draw a card” and another 2/2 both have lethal damage. Both die, but zero triggers reach the stack; one is required for the watcher seeing the other's simultaneous death.

Collect all applicable SBAs against one evaluated state, capture last-known characteristics/observers, and commit the resulting event together. Then recompute and repeat. A batched zone-transition primitive is needed; moving the loop into a helper alone will not repair simultaneity. This follows CR 704.3 in the [official rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260619.pdf).

### F05 · P1 · Hybrid payment can reject a payable cost

[cost.ts:314](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/mana/cost.ts:314) greedily assigns floating pool mana to hybrid symbols before backtracking. It never revisits those choices.

**Reproduced:** `{W/U}{W/B}` with floating W and U, and no untapped sources, returns unpayable. Assigning U to the first pip and W to the second pays it exactly.

Include floating mana in the same constrained assignment problem as sources, or solve overlapping hybrid constraints with matching/backtracking before committing pool consumption. Test symbol-order permutations and overlapping hybrid choices. Preserve restrictions, linked output, and alternative abilities belonging to the same permanent.

### F06 · P1 · Impossible mana payments can stall the server

[cost.ts:359](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/mana/cost.ts:359) explores source/assignment combinations with a total-unit bound, but no initial feasibility check for a missing required color and no failed-state memoization.

**Measured:** with 16 untapped sources each producing G or W, testing `{8}{U}` took approximately 2.36 seconds per call. There is no source of U, so the failure is cheaply knowable. The 8-source case took approximately 1.8 ms and the 12-source case approximately 30.4 ms. See the benchmark section for methodology.

This is especially costly because [legal.ts:741](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/actions/legal.ts:741) and nearby paths perform repeated `canPay` calls and then another payment search for the preview. All run synchronously on the server event loop.

Add color feasibility and suffix production bounds, memoize impossible residual states, and compute one payment result per candidate rather than repeating a boolean search and preview search. Use exact fast paths for simple producers and a complete general fallback. Never turn a search budget exhaustion into “illegal action”; yield/resume the computation or report an explicit engine limit.

### F07 · P1 · Representative overrides mark incorrect semantics as supported

Source inspection found multiple discrepancies in [silverquill-influence-remaining.ts:97](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/cards/overrides/silverquill-influence-remaining.ts:97):

| Card                        | Encoded behavior                                                                     | Required distinction missing from its own handled text                                   |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Land Tax                    | Opponents collectively have at least one land                                        | An individual opponent must have more lands than you                                     |
| Parasitic Impetus           | Any enchanted creature attacking triggers; `loseLife` affects the ability controller | The particular enchanted creature attacks; that creature's controller loses life         |
| Pearl-Ear, Imperial Advisor | Fixed generic reduction of one; draw on Aura casts                                   | Affinity depends on Aura count; draw requires targeting a modified permanent you control |

These are source-level findings, not three additional executed card scenarios. They demonstrate why “text recognized,” “executor arm exists,” and “modeled=true” must not be treated as equivalent to correct card behavior.

Audit recent override batches with condition-negative and different-controller fixtures. Introduce support states such as parsed, executable, behavior-verified, and interaction-verified, with provenance to actual tests. Keep the existing strict handled-text drift guard; strengthen its behavioral counterpart.

### F08 · P2 · Mana statistics misclassify ordinary games

[runner.ts:497](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/match/runner.ts:497) captures metrics at turn advancement, counts every nonland hand card with a mana-cost string as `spellsCastable`, and records whether a land was already played. At the new active player's first decision that land-drop counter has normally just reset.

[stats.ts:181](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/db/stats.ts:181) treats those samples as end-turn resources, compares lands **in hand** with a global-turn expectation, and interprets five rows of cumulative totals as a trailing-five-draw window. Samples are collected for all players on each global turn, so rows and draws are particularly different in multiplayer.

Capture the relevant player's end-turn opportunity/resources, count castable and uncastable spells separately through an engine query, record lands on the battlefield and actual draw events, and use player-turn numbering. Version the metric definition; existing incomplete raw fields cannot reconstruct every corrected historical statistic. This must be corrected before using flood/drought rates to tune decks.

### F09 · P2 · Concurrent start requests can leave multiple sessions running

[server.ts:423](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/ws/server.ts:423) abandons the current session before awaiting deck setup. WebSocket message handlers dispatch asynchronously without serializing starts. Two requests can both pass that point before either new session is installed; the last setup result replaces the pointer while another runner can remain alive.

An invalid replacement also abandons a valid current game before validation succeeds. Interactive start lacks the batch-active exclusion enforced in the opposite direction by the batch POST route.

Use one session-operation coordinator for interactive and batch transitions. Prepare/validate first, use a generation token to discard superseded setup results, and atomically replace/abandon only the selected session. Add interleaved-start, failed-replacement, and batch-versus-interactive tests.

### F10 · P2 · A local app accepts unauthenticated network control

[server.ts:84](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/ws/server.ts:84) supplies a port but no hostname, and upgrades `/ws` without an Origin check. HTTP batch creation and spectator start are not authenticated. Bun documents the default bind address as all interfaces; see [Bun server configuration](https://bun.sh/docs/runtime/http/server).

If that port is reachable, another client can start simulations or AI-backed work and access historical debug data. A hostile web page can also attempt cross-origin WebSocket control; the existing single-player resume token protects an established human session, not initial access to the service.

For the advertised local application, bind explicitly to loopback, validate allowed UI Origins, and require an application session capability for state-changing routes. Network sharing should be an explicit mode with authentication. This finding is based on configuration and control-flow inspection; no exploit was sent.

### F11 · P2 · Batch failure handling does not cover setup/construction

[manager.ts:88](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/batch/manager.ts:88) awaits setup and [manager.ts:95](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/server/src/batch/manager.ts:95) constructs a session outside the per-game `try`. The promise installed in `start()` only has `finally` cleanup.

An unexpected exception in setup, persistence, or construction can leave a running database record after the in-memory promise clears. `activeBatchExists()` can then block later batches. Expected `setup.ok=false` failures are handled; thrown failures are the gap.

Wrap the complete run lifecycle in terminal-state handling, ensure every started batch reaches a durable terminal status, and reconcile interrupted running rows on startup. Add a throwing dependency test; the four current batch tests are not sufficient lifecycle coverage.

### F12 · P2 · Optional life payment is offered when unaffordable

[condition.ts:377](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/cards/condition.ts:377) always offers “pay life” and subtracts the amount without checking affordability.

**Reproduced:** at 1 life, choosing to pay 2 is accepted and leaves -1. Paying down to zero is allowed; paying more life than the player has is not. Gate this option using the same cost legality as other life payments, including effects that prevent changing life totals. Add below-cost, exact-cost, and above-cost cases.

### F13 · P2 · Green checks omit the largest UI component

[eslint.config.js:26](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/eslint.config.js:26) ignores every `.vue` file. The web package's typecheck invokes ordinary `tsc`, with no `vue-tsc` dependency/script, and [playwright.config.ts:7](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/playwright.config.ts:7) points to an absent test suite. The 1,924-line player view therefore lacks the advertised command-line component type/lint coverage and browser workflow verification.

Add Vue-aware type checking and linting, and a small Playwright suite for start, target selection, combat declaration, reconnect/resume, game completion, and stats. Vue's documentation recommends [vue-tsc for single-file components](https://vuejs.org/guide/typescript/overview); Vite's successful transform/build does not replace it. Add repository CI for those checks. No `.github` workflow directory was present.

## Engine efficiency analysis

### Measurements

Bun 1.3.14 on this Windows workspace. Synthetic stable boards, no network or SQLite. Each operation is warmed up; results are medians of five repeats, except difficult mana cases, which use three. These are microbenchmarks, not whole-game speedups or service-level latency guarantees. Data below is from the saved `review-checks.log` run; the final portable harness run is also retained and may differ with machine load.

| Workload                                     |      Current path | Comparison / implication                              |
| -------------------------------------------- | ----------------: | ----------------------------------------------------- |
| 100 full-board read passes, 20 permanents    |           7.83 ms | One characteristics map per pass: 0.50 ms             |
| Same, 80 permanents                          |          34.44 ms | One map per pass: 0.40 ms                             |
| Same, 160 permanents                         |         130.12 ms | One map per pass: 0.79 ms                             |
| Impossible payment, 8 G/W sources, `{4}{U}`  |     1.80 ms/check | No source can satisfy U                               |
| Impossible payment, 12 G/W sources, `{6}{U}` |    30.43 ms/check | Strong combinatorial growth                           |
| Impossible payment, 16 G/W sources, `{8}{U}` | 2,363.07 ms/check | Ordinary menus can multiply this cost                 |
| 1,000 empty event polls, history 1,000       |           3.20 ms | Full history scanned for no new events                |
| Same, history 10,000                         |          32.57 ms | Linear cost per poll                                  |
| Same, history 100,000                        |         499.59 ms | Cumulative polling becomes quadratic as history grows |

### Recommended changes, in value order

1. **Repair and reuse payment plans.** Separate exact feasibility from presentation. Reuse one successful plan for preview within the immutable menu context; revalidate before applying if state can change. Precompute suffix unit/color bounds. Canonical failed-state memoization must include restrictions, linked mana, and the used-source identity constraints. For X menus, find the affordable range efficiently and avoid recomputing invariant targets for each X.
2. **Evaluate characteristics once per stable query scope.** `computeCharacteristics()` does a battlefield membership scan and a full digest on every call, even on cache hits. SBA, targeting, views, mana, and triggers repeatedly call it inside battlefield loops. Pass an evaluated board/query context through each pure read operation. Never reuse it across generator yields or mutations without revision checking.
3. **Centralize mutations before revision caching.** Add narrow operations for zone changes, counters, tapping, control/face changes, effects, and turn resources. Keep deterministic array order, with maintained maps for object ID/card ID and controller/zone lookup. Initially rebuild indexes at a checkpoint; incrementally maintain only after invariants are covered. Merely adding a revision field to today's unrestricted mutable state is unsafe.
4. **Remove repeated historical scans.** [Engine.eventsSince](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/engine.ts:306) filters the entire log. Use a sequence-indexed slice or binary search, and a bounded outbox/persistent event repository for long runs. `drainDebugLog()` advances a cursor but retains the original debug array; either name this retention explicitly or actually release drained records when the recorder owns history.
5. **Make snapshots and diagnostics optional for headless games.** [log.ts:25](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/packages/engine/src/log/log.ts:25) constructs spectator boards for loggable events. Batch execution instantiates the full `MatchSession` with a no-op sender, so presentation work still occurs. Provide recording policies such as minimal metrics, events, turn snapshots, and full interactive replay. Retain failure diagnostics without paying for every successful game's full UI timeline.
6. **Index read-heavy derived data.** `candidateOf()` scans the battlefield for attachments; rule statics are gathered repeatedly, including inside mana-source iteration; trigger discovery repeatedly scans every source. Build attachment, active-static, and event-kind watcher indexes per evaluated board. Treat these as derived caches with explicit invalidation, not additional authoritative state.
7. **Optimize layer dependency probing only after profiling.** `applyGroup()` probes dependencies by cloning working state and recalculates after each applied effect; dense effect groups can produce many pairwise probes. Attach conservative read/write metadata to operations to rule out impossible dependencies, retaining the current slow algorithm as an oracle. Preserve the existing safe shortcut for independent modifier effects.
8. **Isolate simulation from the HTTP event loop.** The runner yields between surfaced decisions, but `Engine.advance()` can execute an arbitrarily long forced sequence. Its decision/turn caps do not bound work inside that call. Add a deterministic operation budget with resumable `continue` steps, or run matches in workers. The existing combat-sweep subprocess harness is a useful starting point. Do not use wall-clock limits to choose game outcomes.

## Whole-project architecture and refactoring plan

### Engine and card compilation

Retain the generator-driven engine contract, seeded RNG, shared decision types, and ability IR. Extract `interpret.ts` by grammar family: normalization, costs, targets/selectors, triggers, continuous/rule statics, effect sentences, face handling, and compilation diagnostics. Return structured parse outcomes containing consumed text and unsupported reasons. Compile validated card definitions once per Oracle content/version and share immutable definitions across games; current per-game interpretation is reasonable for one match but redundant across batches. Measure startup separately from gameplay.

Split `resolve.ts` into cohesive domain executors: damage/life, zone/library, counters/tokens, copying/faces, mana/costs, and choices. Use an exhaustive typed dispatcher with `never` checks. The current regex test that finds matching `case` labels is a useful inventory alarm, but it cannot prove that an arm implements the right behavior or even runs in the relevant context.

The deepest selective rewrite should be **event application and observation**: a transaction captures before-state, computes replacements, commits simultaneous mutations, then discovers triggers from the correct state/last-known information. Use that primitive for SBAs, sweepers, combat and multi-object effects. Do not attempt full event-sourcing as an immediate replacement for the running engine.

### Bot and AI

Keep `packages/bot` dependent only on shared public views. The bounded search and heuristic fallback are appropriate; there is no evidence that a general game-tree/MCTS rewrite would pay off yet. Strengthen parity fixtures around damaged creatures, commander lethal, protection/replacements, and multi-block combat. `CombatSnapshot` supports marked damage, but `toCreature()` does not project it into the search input; document where estimates are intentionally simplified and decline unsupported states where estimates would be misleading.

The strategist has useful generation checks and cancellation. Extend its stale-result identity to an explicit board revision/plan version, particularly when the active player's own choices diverge while a request is pending. The decision cache hashes only selected view fields and omits current strategy/public context; treat exact-state reuse as a claim needing tests for counters, keyword changes, graveyard contents, and alternate combat response shapes. These are improvement targets, not additional reproduced failures in this report.

At the provider boundary, use one reusable admission/rate limiter per actual provider credential while allowing strategist and tactician scheduling priorities. The current queue checks the RPM window once, sleeps, and then reserves without rechecking; concurrent wakeups need dedicated fake-clock coverage. Add complete cancellation propagation and report incurred usage even for discarded strategist responses. Avoid increasing LLM complexity until engine correctness is established.

### Server and persistence

Separate transport handling, session ownership, simulation running, presentation pacing, and durable recording. A headless runner should not need a UI session. Share validated immutable deck/definition inputs across a scenario. SQLite with WAL and transactional append operations is appropriate for this scale; replacing it with a distributed database is unjustified.

Use explicit numbered transactional migrations and recovery of interrupted jobs. Consolidate repeated stats queries: current per-deck breakdown queries form an N+1 pattern, and batch/non-batch aggregation code duplicates logic. Add indexes based on actual query plans once a representative database is available. Page debug exports or stream large exports instead of loading every row into one response. Persist engine/card-model version and provider policy with results so statistics remain interpretable across fixes.

### Deck import and support reporting

Retain conservative name resolution, adapters for recognized services, validation aggregation, and immutable deck identities. The bulk file is read/parsed in full at startup; avoid repeating that work in every worker. A normalized persisted index with content/version checks is a reasonable next step only if measured startup/heap costs warrant it.

Make support reporting honest about behavioral confidence. Add positive and negative card scenarios, especially source-controller versus affected-controller distinctions, absent prerequisites, ability loss, and zone changes. Report rejected/unmodeled and halted games alongside completed games; win-rate comparisons over only successful runs can hide a mechanics-dependent bias.

### Vue interface

Keep Vue/Pinia. The production bundle is modest; framework replacement is not a performance priority. Split `PlayerGameView.vue` into a page coordinator plus composables for action selection, target validation, combat drafting, keyboard controls, and focus/preview behavior. Existing `combatPlan` is a useful seam. Keep legality on the server.

Preserve the existing shallow board refs and bounded log/debug arrays. The event store rebuilds/deduplicates/sorts retained log entries for each batch; append monotonic events on the normal path and reserve merging for resync. Virtualize the action log if profiling confirms rendering cost near its 4,000-line limit. Watch the last sequence rather than only list length for auto-follow once that cap is reached. Exercise reconnect ordering with a fake socket and real browser test; queued commands need request/revision identity and a resume handshake.

### Documentation and build workflow

README and CLAUDE/ADR status summaries have drifted: some text still describes combat-search blockers and an unbuilt lab although related code is present. Use one concise current-status page and link to historical decisions. Remove misleading comments only when behavior is verified; comments asserting exactness currently coexist with counterexamples.

Make root build/typecheck/test commands explicit about what they cover. Add separate fast unit, scenario, deterministic full-game, browser, and benchmark workflows. Keep benchmarking out of correctness assertions that depend on absolute wall time; use structural counters and broad regression budgets on controlled runners.

## Recommended delivery order

| Stage                                  | Work                                                       | Exit criteria                                                                                             |
| -------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1 — Correctness and exposure           | F01–F05, F07, F10, F12; quarantine inaccurate overrides    | Reproductions become passing regression tests; visibility and legal-action invariants hold                |
| 2 — Exact fast queries                 | F06, evaluated-board scopes, payment reuse, event cursors  | Identical outcomes across seeded fixtures; bounded pathological mana work; measured before/after profiles |
| 3 — Reliable orchestration and metrics | F08, F09, F11; headless runner, operation budgets/workers  | Recoverable cancellation/restarts; one owner per session; accurate versioned metrics                      |
| 4 — Maintainability and coverage       | F13, parser/executor/UI extraction, CI, support provenance | Vue checks and browser flow pass; module boundaries enforced; card claims tied to behavior tests          |

Use small, reviewable changes with fixture parity between old and new paths. A language/runtime rewrite, framework migration, general ECS conversion, distributed services, and a complete parser replacement are not justified by the evidence. Focus selective rewrites on mana assignment, simultaneous-event processing, and session lifecycle, where current abstractions are directly causing failures.

## Reproduce and inspect

Run from the repository root:

```powershell
bun run docs/reviews/2026-09-04/checks.ts
```

This observational harness prints actual/expected results and microbenchmark timings; it deliberately does not install permanent failing tests or change game implementation. It uses synthetic fixtures plus the real Iymrith override. Some probes construct states directly to isolate engine primitives; manifest is exercised through its executor. Timing may vary by machine and concurrent work.

- [Portable checks](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/checks.ts)
- [Final probe output](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/review-checks-final.log)
- [Full test output](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/review-tests.log)
- [Final production typecheck](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/review-typecheck-final.log)
- [Final test typecheck](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/review-test-types-final.log)
- [Web build](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/review-web-build.log)
- [Browser test discovery](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/review-playwright.log)
- [Source hashes](C:/Users/paulf/OneDrive/Documents/GitHub/mtgtester/docs/reviews/2026-09-04/source-hashes.json)
