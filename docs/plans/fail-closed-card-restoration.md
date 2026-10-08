# Fail-Closed Card Restoration Plan

**Status date:** 2026-09-28 (re-audit and gate repair; restoration status unchanged since 2026-09-24)  
**Scope:** Arcane Denial, Chaos Warp, Deflecting Swat, Fabled Passage, Myriad Landscape, Smothering Tithe, Toxic Deluge, and War Room.  
**Current state:** Arcane Denial, Smothering Tithe, Fabled Passage, Myriad Landscape, and War Room are implemented-reviewed; Toxic Deluge was restored in coverage PR02 (gate: `packages/engine/tests/pr02-card-coverage.test.ts`); Chaos Warp and Deflecting Swat remain explicitly unsupported. Do not remove any remaining containment guard until that card's completion gate is satisfied.

## Objective

Restore the eight cards through reusable engine primitives, not card-specific approximations. A card is complete only when every printed Oracle clause is faithful through the normal action menu, costs, choices, stack, priority, resolution, state-based actions, hidden-information projection, replay/determinism, Card Test Lab, and generated evidence paths defined by `docs/guides/card-modeling-and-testing.md`.

Implementation must preserve unrelated changes in the dirty worktree. Before each slice, record `git status --short` and a path-scoped diff baseline. Never reset, clean, or rewrite unrelated files.

## Pinned inventory and current blocker validation

| Card             | Oracle ID                              | Pinned SHA-256                                                     | Current containment                                                                            | Verified blocker                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arcane Denial    | `ab1cc360-b9de-48d9-9983-4dfe4a7d2a37` | `7d764e957064fa08627fd48a85e1ea9aa50de341ffa09a88c2d36d0598156746` | `living-energy.ts` — **implemented-reviewed; no longer fail-closed**                           | Previous blocker is closed: unscoped next-occurrence upkeep triggers survive cleanup and route the optional 0/1/2 draw to the countered spell's controller and the mandatory draw to Arcane Denial's controller. Engine, replay/privacy, Card Test Lab, and Playwright evidence are recorded below. |
| Chaos Warp       | `07a0cba9-8768-4fd9-a3d5-b0f83b4bf8e8` | `91d1633155fb401878a9c262aec1695bc6c94cf12b7c014d358242dac30f55d7` | `living-energy.ts`                                                                             | `chaosWarp` moves/shuffles and conditionally puts a permanent onto the battlefield, but it does not emit a public reveal for the top card; a nonpermanent silently remains hidden on top.                                                                                                           |
| Deflecting Swat  | `ae120613-97d6-4393-b39d-c3e6c076f5d6` | `59d61f13ab689ea2b364e26bf4c2216a6038b75fbbd09c680af867abd759feac` | `marchesa-the-black-rose.ts`                                                                   | Existing authored behavior copies a targeted spell. Oracle requires choosing new targets for the original target spell or ability. A stack-object retarget primitive and legal target reconstruction are absent.                                                                                    |
| Fabled Passage   | `0c85b8f7-0bd0-4680-9ec5-d4b110460a54` | `fd064f3f1c8289f7cd3a05433a31b03a8676ba4ce9035cd6706bd37087c9a7ef` | `queen-marchesa-queens-gambit.ts` — **implemented-reviewed**                                   | Previous blocker is closed: hidden-zone failure-to-find is explicit, the found basic is bound by stable card identity across entry, and only that land untaps after the post-entry four-land check succeeds.                                                                                        |
| Myriad Landscape | `2549bc57-9ffb-4053-9f10-f2a5f792b845` | `696f038611a9d1540a151ab63ccc13e36fd4aa355a54806e741eb6a44f77442b` | `necron-dynasties.ts` — **implemented-reviewed**                                               | Previous blocker is closed: grouped search enforces a shared land subtype, supports zero/one/two choices, pays normal activation costs, preserves privacy/replay, and is proven through production Card Test Lab and Playwright scenarios.                                                          |
| Smothering Tithe | `153376c9-dffd-458c-8ce3-a4c8269bc4e9` | `38346bcc71227873ac4c358bd89d277f9d1f94a65e7778392c5e0aefeb7ab2c4` | `queen-marchesa-queens-gambit-remaining.ts` — **implemented-reviewed**                         | Previous blocker is closed: each opponent card draw queues a distinct trigger, the captured drawing player may pay `{2}` through normal mana sources, and decline/inability creates exactly one canonical Treasure for the captured Tithe controller.                                               |
| Toxic Deluge     | `afaef788-34d1-460b-b884-9d7ae6ddeb18` | `8d4c686fcd606a82ad2a0dbba2ab363d1b5ca67300bf21b0a3de199ec277cad9` | `marchesa-the-black-rose.ts`                                                                   | Existing behavior loses life on resolution. Oracle requires announcing X and paying X life as an additional casting cost, retaining X on the stack, then applying `-X/-X` until end of turn.                                                                                                        |
| War Room         | `71c52bf5-2a5d-488e-8b15-7ef290e4b77d` | `7014d3a7b8e20db7e2a12576165361775173e73cb28f1106afa40a659d6d0c74` | `silverquill-influence.ts` and `silverquill-influence-remaining.ts` — **implemented-reviewed** | Dynamic commander color-identity life payment is evaluated at activation, paid before priority, and the draw resolves only when the ability resolves; production Card Test Lab, gameplay-AI, and evidence gates pass.                                                                               |

Before editing a card override, re-read its full pinned Oracle record and copy each `handledLines` string exactly. If local fixture content or hash differs, stop and update the pin deliberately; do not loosen the drift guard.

## Current verification snapshot (2026-09-24)

- `packages/engine/tests/fail-closed-restoration.test.ts` checks Arcane Denial, Smothering Tithe, Fabled Passage, and Myriad Landscape as modeled and the remaining four cards as unsupported for their documented reasons; the verification manifest maps every in-scope clause to engine and viewer scenario IDs.
- Arcane Denial engine tests cover normal casting, next-upkeep routing, 0/1/2 choice, illegal and uncounterable targets, simultaneous trigger ordering, delayed-state clone/hash behavior, privacy, and prepared-scenario replay. Generated viewer evidence is in `docs/reviews/arcane-denial-verification.json`; quality-only heuristic/random observations are in `docs/reviews/arcane-denial-gameplay-ai.json` (no live LLM was run).
- Verified locally: `rtk bunx playwright test apps/web/e2e/card-test-lab.spec.ts` — 67 passed, including both Arcane Denial scenarios; `rtk bun run typecheck`, `rtk bun run typecheck:tests`, `rtk bun run lint`, and `rtk git diff --check` passed.
- Before the partial Smothering Tithe source edit, the two synthetic benchmark fixtures were reviewed and pinned to engine hash `c883c2c046ae4437f66867df4a5fbb81cce022485b019fc7eace1298927ac96c`; the full unit suite then passed **2,316/2,316**. The initial partial edit made the decline-path test pass but incorrectly exposed Tithe as modeled, so the fail-closed restoration test failed; it also changed the engine source hash and correctly tripped benchmark compatibility. The product guard is restored while candidate behavior is exercised through the closed `customDefinitions` fixture hook. Benchmark pins remain untouched until the supported Tithe source revision is final and both synthetic cases are re-reviewed as semantically unchanged.
- Phase 0 inventory baselines are now captured: `bun run coverage` reports **507/802 unique cards modeled (63.2%)**, and `bun run staples` reports **181/200 modeled (90.5%)** with Smothering Tithe still listed as explicitly unsupported. The two pre-existing 102-card coverage-deck warnings remain informational.
- Smothering Tithe's supported revision raises those inventories to **508/802 (63.3%)** and **182/200 staples (91.0%)**. Its focused engine, server scenario, manifest, snapshot, benchmark, typecheck, lint, **2,335/2,335 full unit suite**, and **69/69 production Card Test Lab** checks pass. Final generated viewer/replay and local gameplay-AI evidence is in `docs/reviews/smothering-tithe-verification.json` and `docs/reviews/smothering-tithe-gameplay-ai.json`; no live LLM was run.
- Fabled Passage's supported revision raises the inventories to **509/802 (63.5%)** and **183/200 staples (91.5%)**. Stable bound-search and explicit hidden-zone failure-to-find have generic engine coverage; focused card/server/manifest/snapshot/benchmark checks, typechecks, lint, **2,349/2,349 full unit suite**, and **70/70 production Card Test Lab** checks pass. Generated viewer/replay and local gameplay-AI evidence is in `docs/reviews/fabled-passage-verification.json` and `docs/reviews/fabled-passage-gameplay-ai.json`; no live LLM was run. The two synthetic benchmark cases retain their reviewed inputs and gold semantics and are pinned to engine hash `0d2a20d8b190af359ded832abc686500b377bddcfa754dc688074530c23cec1f` and card-definition hash `28f3c6baed8b618f16c958cba86c6884a391e9b785a01ad489f5b816f6c35bc1`.
- Myriad Landscape's supported revision adds the grouped `shareLandType` search definition and removes its stale unsupported registry entry. Focused engine/guard/snapshot and server/manifest/gameplay-AI checks pass; the production Card Test Lab browser gate passes **73/73**, including normal land play, colorless mana activation, and grouped shared-type search. Generated viewer/replay and separate local gameplay-AI evidence is in `docs/reviews/myriad-landscape-verification.json` and `docs/reviews/myriad-landscape-gameplay-ai.json`; no live LLM was run.
- `scripts/generate-arcane-denial-evidence.ts` hashes this plan itself. After editing this document, rerun `rtk bun run scripts/generate-arcane-denial-evidence.ts` so the evidence `workspaceRevision` binds to the updated plan, then verify the evidence and targeted tests again.

## Re-audit and gate repair (2026-09-28)

This pass re-audited the five restored cards against their pinned Oracle records and repaired the
verification gate. It made no engine behavior change and did not run the browser suite.

**Rules audit — no defect found in any of the five.** Verified against the pinned fixture
(`packages/engine/tests/fixtures/marchesa-batch1-oracle.json`) and the current overrides:

- **Arcane Denial** — both delayed triggers are ordered by Arcane Denial's controller (CR 603.7d,
  asserted as `ordering?.player === 'P1'`) while the countered spell's controller is the affected
  player who makes the zero/one/two choice. An uncounterable but legal target still schedules both
  draws; an illegal target fizzles and schedules nothing.
- **Fabled Passage** — the four-or-more-lands check runs after the found land has entered, so the
  new land counts; fail-to-find is explicit and untaps nothing; the untap is bound to the found
  card, not to another land of the same name.
- **Myriad Landscape** — the grouped search filters to basic lands, enforces a shared land type,
  and offers exactly the zero-, one-, and two-card choices; a nonbasic dual and a disjoint-type
  pair are both excluded.
- **Smothering Tithe** — one trigger per card drawn by an opponent, the drawing opponent is the
  payer through the normal mana solver, and decline and inability each create exactly one Treasure
  for the captured controller.
- **War Room** — `commanderIdentityColorCount` is evaluated and the life paid at activation; a
  colorless commander identity legally charges zero.

**The injected-stack concern was mis-attributed to Myriad Landscape.** The only `stack:` injection
registered in the lab is Arcane Denial's, and what it injects is the _countered_ spell — the
target — not the card under test. Arcane Denial itself is cast from hand and paid normally.
Myriad Landscape's three scenarios drive normal land play, a solver-paid `{C}`, and a normal
`{2}`/tap/sacrifice activation; none of them inject stack state.

**Manifest drift found and fixed.** `card-verification-manifest.json` declared
`myriad-landscape-viewer-search-shared-type` for Myriad Landscape; the registered scenario — and
every other reference in code and evidence — is `myriad-landscape-viewer-shared-type-search`. The
manifest now names the real scenario. Its three declared `engineTestIds` also matched no test;
`myriad-landscape-enters-tapped` and `myriad-landscape-shared-land-type-search` are now carried by
the existing tests, and `myriad-landscape-colorless-mana-normal-activation` is a new test that
pays a real spell cost with Myriad's `{C}` — a mana ability is activated by the payment solver
rather than at priority, so paying a cost with it is its normal path.

**Root cause of that drift.** `fail-closed-restoration.test.ts` cross-checked clause requirements
with one hand-written block per card and simply had no block for Myriad Landscape, so its declared
ids were never checked. The per-card blocks are replaced by a `RESTORED_ENGINE_TEST_FILES` table
covering all five; adding a restored card without its engine test file now fails the test.

**Card gate wired.** None of the restoration or containment tests were in `test:card-gate`; the
`reviewed-five-*` entries are a different, older batch (Tribute Mage, Gev, Nightscape Familiar,
Thran Vigil, Harmonic Prodigy). `package.json` now gates `fail-closed-restoration`, the five
restored cards, and `toxic-deluge`/`chaos-warp`, and `ci-card-gate.test.ts` pins those entries.

**Checks run on this revision.** `bun run test:card-gate` 51 files / 890 tests passed;
`bun run snapshots:check` clean (93 interpret cards, 717 override registrations unchanged);
`bun run typecheck` and `bun run typecheck:tests` both clean; `git diff --check` clean; Prettier
clean on the two engine files corrected in this pass.

**Not run in this pass — do not read the 2026-09-24 snapshot above as current.** The Card Test Lab
browser suite and all five evidence scripts were deliberately not run. `test-results/` is empty, so
every `*-verification.json` currently references a `viewerTrace` path that does not exist on disk
and each generator would throw at its `existsSync` check. Because Playwright clears `test-results/`
at the start of a run and trace archives are not byte-reproducible, the remaining sequence is: one
full `apps/web/e2e/card-test-lab.spec.ts` run, inspect all nine traces, then regenerate all five
evidence files in that same session. Benchmark case pins were not touched and are deferred.

**Known carry-forward.** ~~`benchmarkSourceHashes` hashes working-tree text under
`packages/engine/src`; with `core.autocrlf=true` and no `eol=lf` attribute for engine sources, 45
files there are still CRLF locally and will not reproduce CI's Linux hash.~~ **Resolved 2026-09-29.**
The line-ending exposure was real, but the count was not: 44 of the 65 `.ts` files under
`packages/engine/src` were CRLF when this was re-measured, not 45, and 42 are CRLF now that
`actions/apply.ts` and `actions/legal.ts` have been Prettier-formatted to LF. The root cause of the
benchmark hash mismatch was _not_ line endings on its own — the fixtures were pinned to engine
sources that have since legitimately changed — but the hash was additionally platform-dependent,
which would have made the pins unreproducible on CI even with identical source. `benchmarkSourceHashes`
now normalizes CRLF to LF before hashing, restricts the walk to `.ts` files, and normalizes relative
paths to forward slashes _before_ sorting, so a Windows checkout and CI's Linux checkout agree.
`canonicalJson` now orders keys by UTF-16 code unit instead of `localeCompare`, so ICU collation data
can no longer influence a sealed digest. The remaining local CRLF files are therefore no longer a
correctness risk for these hashes; they still fail a whole-tree `prettier --check` (`endOfLine: "lf"`),
which is tracked separately and was deliberately not mass-normalized here. The two synthetic cases
were re-pinned with `bun run ai-bench refresh --suite core-fast --write` to engine hash
`cb7ae528b9062ac525ebe9964517f1b33da85b6e0528b88c22cc928ee8649e45` and card-definition hash
`16788a4e88b3e7e5f68812c7f0da07dab0202d1e4f9ad809343d540f54d6b451`; their reviewed inputs and gold
semantics are unchanged. Separately, four viewer
scenario ids declared by older `implemented-reviewed` cards — `gev-viewer-entry-counters`,
`gev-viewer-lizard-target`, `nightscape-viewer-cost-reduction`, and `harmonic-viewer-prowess` —
are registered nowhere. Both are outside this plan's scope and are recorded here, not fixed.

## Cross-cutting design rules

1. **Separate trigger controller, affected player, and deciding player.** Arcane Denial and Smothering Tithe cannot infer all three from `source.controllerId`.
2. **Announced choices belong on the stack object.** Toxic Deluge's X and Deflecting Swat's selected stack target/new target set must survive cloning, replay, hashing, and serialization.
3. **Searches are transactions.** Selection constraints, “up to,” destination, reveal policy, shuffle, and references to found objects must be explicit and deterministic.
4. **Retarget; do not copy or recast.** Deflecting Swat modifies the original stack object without changing its controller, source, modes, costs, or non-target choices.
5. **Public reveals are events, not UI guesses.** Chaos Warp must expose the revealed card to every player and spectator while preserving all other library information.
6. **Costs are paid during announcement/activation.** Sacrifice, tap, mana, and life costs remain paid if the spell/ability is later countered. A player may pay life equal to their current life but never more.
7. **Support metadata follows evidence.** Keep `unsupportedCard()`/`unimplemented()` until all required gates for that card pass. Do not flip all eight at the end as a batch.
8. **Gameplay-AI evidence is separate.** It can reveal poor descriptions or decisions, but it neither proves nor invalidates rules correctness.

## Phase 0 — Baseline and evidence scaffolding (complete)

### RED

- Add/extend a focused audit test that asserts Arcane Denial is modeled and the other seven cards remain fail-closed for their documented reasons.
- Add manifest clause entries with required scenario IDs but no handwritten pass flags.
- Capture baseline output for focused tests, coverage, staples, and `git status --short`.

### GREEN

No production behavior changes. The baseline test and manifest must accurately represent the current split status: Arcane Denial implemented-reviewed, seven cards fail-closed.

### Likely files

- `packages/engine/tests/audit-regressions.test.ts` or a new `fail-closed-restoration.test.ts`
- `packages/server/fixtures/card-verification-manifest.json`
- `packages/server/fixtures/coverage-contract.json` only if pin verification requires an intentional update

### Gate — complete

- Every card has clause IDs for every printed ability/sentence.
- Arcane Denial is recorded as `implemented-reviewed`; unsupported declarations remain active for the other seven cards.
- Clause-level engine/viewer requirements and fail-closed reasons are asserted by `fail-closed-restoration.test.ts`.
- The pre-Tithe baseline full suite passed 2,316/2,316. Coverage and staples baselines are captured above. During Tithe development, benchmark compatibility remains intentionally fail-closed until the final supported engine/card-definition hashes can be reviewed and pinned without intermediate churn.

## Phase 1 — Player-routed delayed and draw-trigger choices

This phase builds reusable decision primitives for **Arcane Denial** and **Smothering Tithe**. Phase 1A is complete for Arcane Denial; Phase 1B and Smothering Tithe remain next.

### Phase 1A status — Arcane Denial complete (2026-09-24)

The next-occurrence delayed-trigger primitive and Arcane Denial's two same-upkeep effects are implemented. The card is modeled under both its pinned Oracle ID and fixture alias, and the verification manifest marks it `implemented-reviewed`. Focused engine tests and both real Card Test Lab browser scenarios passed; generated engine/viewer evidence and separate gameplay-AI observations are listed in the verification snapshot above. Do not repeat Phase 1A unless evidence becomes stale or a regression is found.

### Primitive 1A: delayed triggers keyed to the next occurrence of a step — complete

Use a reusable unscoped delayed-trigger schedule for the next occurrence of a matching step, independently of the delayed trigger's controller and of every affected or deciding player. Preserve `expiry: 'onFire'` so the trigger survives cleanup until that next matching step, then fires exactly once. Player-scoped scheduling remains appropriate for text such as “your next upkeep,” but Arcane Denial must not use it.

Arcane Denial resolution schedules two delayed triggers for the same next upkeep, whoever owns that next turn:

- At that upkeep, the targeted spell's controller as captured at Arcane Denial's resolution may draw **zero, one, or two** cards. This is an `up to two` numeric choice, not a binary draw-two/decline shortcut; that player both decides and receives the cards even when another player owns the turn.
- At that same upkeep, Arcane Denial's controller draws one card mandatorily, even when another player owns the turn.

If the target is illegal when Arcane Denial tries to resolve, the spell does not resolve and schedules nothing. If the target is legal but cannot be countered, Arcane Denial still resolves and schedules both later draw effects; Oracle does not make them conditional on a successful counter.

### Primitive 1B: affected-player optional payment on a draw event — complete

Add a reusable effect/choice that asks the captured event player to pay a specified mana cost. Payment must use the normal payment solver and available mana abilities. Decline and inability are distinct legal outcomes but both execute the “if they don't” branch.

Smothering Tithe queues one trigger for each card an opponent draws, including multi-card draw effects. The opponent who drew decides whether to pay `{2}`; the Tithe controller creates exactly one canonical Treasure only when payment is declined or impossible.

The behavior was first proven behind the closed engine-test/Card Test Lab `customDefinitions` hook while the product registry remained fail-closed. After those gates passed, the normal product definition was enabled, the lab scenarios were switched to that normal registry path, the override snapshot and supported-pool inventories were updated, and both synthetic benchmark cases were reviewed as semantically unchanged before resealing their engine/card-definition/content hashes.

### Phase 1B RED tests (Smothering Tithe)

- Smothering Tithe queues one trigger for each card drawn by each opponent, including multi-card draws; the controller's own draws create no trigger.
- The opponent who drew makes the `{2}` payment decision; that player pays through the normal mana solver, including available mana abilities. Decline and inability both create exactly one Treasure for the Tithe controller.
- Cover multiple opponents and multiple draws, insufficient/available mana, Tithe leaving before trigger resolution, and a countered trigger.
- Trigger controller, affected player, and deciding player remain distinct and correct; optional-payment results and Treasure events are public without exposing drawn card identities.
- Clone/replay/hash preserve pending event-player ownership and decisions.
- Whole-game tests use legal permanent deployment, priority, stack, and actual payment—not direct resolver calls alone.

### Likely files for Phase 1B

- `packages/engine/src/state/types.ts`
- `packages/engine/src/triggers/queue.ts` or the current step/event trigger module
- `packages/engine/src/cards/ability.ts`
- `packages/engine/src/effects/resolve.ts`
- `packages/engine/src/actions/legal.ts` and `actions/apply.ts` if payment choices need normal action payloads
- `packages/engine/src/cards/templates.ts`
- `packages/engine/src/cards/overrides/living-energy.ts`
- `packages/engine/src/cards/overrides/queen-marchesa-queens-gambit-remaining.ts`
- `packages/engine/tests/delayed-triggers.test.ts`
- new/focused `arcane-denial.test.ts` and `smothering-tithe.test.ts`
- `packages/engine/tests/player-view.test.ts` or equivalent projection tests
- `packages/server/src/cards/card-test-scenarios.ts`
- `apps/web/e2e/card-test-lab.spec.ts`
- `packages/server/fixtures/card-verification-manifest.json`

### Phase 1B acceptance gate

- Focused engine tests pass from RED to GREEN for Smothering Tithe's optional payment and trigger semantics.
- Card Test Lab scenarios prove Smothering Tithe pay/decline paths through production WebSockets/UI; Arcane Denial's draw-0/draw-2 scenarios already passed.
- Regenerate and verify engine/viewer evidence against the final tested revision.
- Remove Smothering Tithe's unsupported declaration only after its own full card gate passes. Arcane Denial's declaration has already been removed and its manifest status reviewed.

### Candidate validation blocker (re-verified 2026-09-28)

The earlier wording of this section claimed that no candidate-definition injection existed. That was wrong, and it is corrected here: `customDefinitions` is a field on the production game config (`packages/engine/src/state/types.ts:516`), it is consumed when the game state is built (`packages/engine/src/state/game.ts:37`), and `buildGuardedCandidateDefinition` is re-exported from the engine's public barrel (`packages/engine/src/index.ts:17`). Injection therefore exists and is reachable outside tests.

What actually keeps Toxic Deluge and Chaos Warp contained is the **guard inside the helper**, not the absence of a hook. `buildGuardedCandidateDefinition` (`packages/engine/src/testing/candidate-definition.ts`) refuses to return a definition unless the real product card is still fail-closed: it throws when `interpretCard` reports the card already `modeled`, throws unless an `explicitly unsupported:` reason is present, and throws unless the candidate's `handledLines` match the remaining interpreter reasons one-for-one. A candidate can only ever be exercised _while_ its product card stays unsupported, so the helper cannot be used to promote a card by the back door.

The consequence for evidence is unchanged. The production Card Test Lab scenario factory does not pass `customDefinitions`, so the real lab resolves the global override registry, where Toxic Deluge and Chaos Warp are `unsupportedCard()`. There is still no approved path to produce production WebSocket/browser/gameplay-AI evidence for an unpromoted candidate. Do not weaken the guard and do not wire candidate injection into the lab factory; both cards stay locked until a faithful model plus its own full gate replaces the containment.

`packages/engine/src/testing/candidate-definition.ts` is currently untracked. It must be committed together with `packages/engine/tests/toxic-deluge.test.ts` and `packages/engine/tests/chaos-warp.test.ts`, which import it by relative path; committing those tests without it breaks CI.

**Completed:** Arcane Denial, Smothering Tithe, Fabled Passage, Myriad Landscape, and War Room.  
**Next:** Toxic Deluge (after its full engine, Card Test Lab, gameplay-AI, evidence, and manifest gates).  
**Still fail-closed:** Chaos Warp, Deflecting Swat, and Toxic Deluge.

## Phase 2 — Transactional library search and result binding

This phase unlocks **Fabled Passage** and **Myriad Landscape**.

### Primitive 2A: grouped constrained search

Represent a single search choice with `min`, `max`, selector, and a relation constraint over the selected set. Add a reusable `shareLandType` relation based on actual land subtypes, not card names or colors. “Up to two” permits zero, one, or two selections; two selections must share at least one land type. Selection is simultaneous from the searcher's private library view.

### Primitive 2B: named/bound search results

Allow later effects in the same resolving ability to refer to the specific object(s) moved by the search, using stable card identity across the zone change. Do not re-find by name, library position, or “most recently entered.”

Fabled Passage instructs a search for one basic land, but hidden-zone search rules permit failure to find. Represent that distinction accurately in descriptions/evidence rather than rewriting the printed clause as “up to one.” It puts a found card onto the battlefield tapped, shuffles, then checks the controller's land count after entry and untaps that exact found land if the count is at least four.

Myriad Landscape pays `{2}`, taps, and sacrifices itself during activation; then it searches for up to two basic lands sharing a land type, puts them tapped, and shuffles.

### RED tests

- Myriad offers zero/one/two; two basics with a shared subtype are legal; disjoint basics are not; dual basics sharing one subtype are legal; fewer than two eligible cards works; nonbasic lands are excluded.
- Costs are paid before the ability reaches the stack and remain paid if countered.
- Fabled checks land count after the found land enters; exactly four untaps it, three leaves it tapped; failure to find in the hidden library is legal and does not untap another land.
- Myriad Landscape's separate “enters tapped” clause is included in its clause map and normal-play evidence even if the generic parser already handles it.
- The bound object remains correct with replacement effects or other same-name lands.
- Search options are private; public logs reveal only information required by the destination/zone change; library order remains hidden.
- Seeded shuffle is deterministic and replay hashes reproduce.
- Whole-game activation tests prove both abilities appear only when their full costs are payable.

### Likely files

- `packages/engine/src/cards/ability.ts`
- `packages/engine/src/effects/resolve.ts`
- `packages/engine/src/state/types.ts` if effect-scope bindings need typed storage
- `packages/engine/src/actions/legal.ts` and `actions/apply.ts`
- selector/subtype helpers under `packages/engine/src/cards/`
- `packages/engine/src/cards/overrides/queen-marchesa-queens-gambit.ts`
- `packages/engine/src/cards/overrides/necron-dynasties.ts`
- `packages/engine/src/cards/overrides/necron-dynasties-remaining.ts`
- focused engine tests for search constraints, Fabled Passage, and Myriad Landscape
- server lab scenarios, Playwright, and verification manifest

### Acceptance gate

- Search relation and binding primitives have generic tests independent of either card.
- Both cards pass positive, negative, cancellation, countered-ability, hidden-info, replay, whole-game, server-lab, and browser scenarios.
- Remove each containment declaration only after its own evidence is generated.

**Unlocked:** Fabled Passage and Myriad Landscape.  
**Next within this phase:** none.  
**Partially advanced:** Chaos Warp's reveal/search-adjacent infrastructure may reuse event work but remains unsupported.

## Phase 3 — Dynamic announced costs and values

This phase has unlocked **War Room**; Toxic Deluge remains fail-closed pending its complete card gate.

### Primitive 3A: dynamic commander-identity life cost

Add a dynamic `AbilityCost` amount equal to the number of distinct colors in the union of the player's commanders' color identities. Support zero-color commanders and partner/background configurations without double-counting colors. Read commander definitions by stable commander card IDs, regardless of their current zones.

War Room's activation remains `{3}, {T}, Pay N life: Draw a card`; all costs are paid on activation and the draw happens only on resolution.

### Primitive 3B: chosen numeric X as an additional casting cost

Add an announced integer choice for X, legal from zero through current payable life. Store it on the cast payload and stack object; include it in deterministic clone/replay/hash forms and legal-action descriptions. Pay X life during cast announcement after legality is established and before priority.

Toxic Deluge resolves by creating a `-X/-X` continuous effect for all creatures until end of turn. Run state-based actions after the effect applies. Indestructible does not prevent death from zero or less toughness. The effect expires during cleanup.

### RED tests

- War Room: mono-, two-, three-, four-, five-, and colorless identity; partners with overlapping colors; commander outside command zone; insufficient life; zero-life cost; countered ability retains paid costs and draws nothing.
- Toxic Deluge: X=0, ordinary X, X equal to life, X greater than life rejected, life paid before opponents receive priority, countered spell retains paid life, and announced X survives stack/replay.
- The resolving effect applies only to creatures present when it resolves; creatures entering later that turn do **not** receive the earlier `-X/-X` effect (CR 611.2c). Indestructible creatures still die at nonpositive toughness, and cleanup restores surviving affected creatures.
- If X equals the caster's life total, verify the engine's state-based-action/player-elimination behavior immediately after casting; do not assume the spell later resolves merely because paying that amount was legal.
- Normal cast/activation menu descriptions expose the exact dynamic amount/X without leaking private state.
- Player/spectator projections and replay reproduce the announced X and resulting SBAs.

### Likely files

- `packages/engine/src/cards/ability.ts`
- `packages/engine/src/cards/definition.ts`
- `packages/engine/src/state/types.ts`
- `packages/engine/src/actions/legal.ts`
- `packages/engine/src/actions/apply.ts`
- `packages/engine/src/effects/resolve.ts`
- `packages/engine/src/effects/continuous.ts` and continuous-effect types
- replay/hash/view projection files touched by stack-object fields
- `packages/engine/src/cards/overrides/marchesa-the-black-rose.ts`
- `packages/engine/src/cards/overrides/silverquill-influence.ts`
- `packages/engine/src/cards/overrides/silverquill-influence-remaining.ts`
- focused engine, whole-game, lab, Playwright, and manifest files

### Acceptance gate

- Dynamic cost evaluation is generic and tested independently of the cards.
- Cost payment timing and stack persistence are proven through whole-game tests.
- Toxic Deluge includes explicit SBA/indestructible and cleanup evidence.
- Remove containment separately for each passing card.

**Fully unlocked:** War Room.  
**Partially advanced:** Deflecting Swat may reuse stack serialization changes but remains unsupported.

## Phase 4 — Public reveal flow and Chaos Warp

Add a generic “reveal top card to all players, retain it in place unless a following effect moves it” operation/event. The event must carry only the revealed card and must be present in authoritative logs, player views, spectator snapshots, replay, and Card Test Lab.

Refactor `chaosWarp` into composable or internally explicit steps:

1. Revalidate target permanent on resolution.
2. Move the targeted permanent to its owner's library. Tokens cease to exist after the zone change under existing token rules.
3. Apply any supported commander replacement choice through the normal zone-change path rather than bypassing it.
4. Shuffle that owner's library deterministically.
5. Reveal the top card publicly, if any.
6. If it is a permanent card, put that same object onto the battlefield under its owner's control; otherwise leave it on top, still having been revealed.

### RED tests

- Owner differs from controller.
- Permanent and nonpermanent top cards.
- Empty library.
- Token target.
- Commander replacement accept/decline where supported.
- Target becomes illegal before resolution.
- Revealed permanent enters through the normal battlefield-entry path, including replacement/ETB handling.
- All viewers see the reveal; no viewer sees adjacent library cards or later hidden order.
- Deterministic shuffle/replay.

### Likely files

- `packages/engine/src/cards/ability.ts`
- `packages/engine/src/effects/resolve.ts`
- event/shared protocol and `packages/engine/src/view/view.ts`
- replay/spectator projection tests
- `packages/engine/src/cards/overrides/living-energy.ts`
- focused Chaos Warp engine/whole-game tests
- Card Test Lab, Playwright, and manifest

### Acceptance gate

Remove Chaos Warp's unsupported declaration only after public reveal and all movement/ownership edge cases have generated engine and viewer evidence. The guarded candidate currently has an engine-level public-reveal test, but production Card Test Lab/browser evidence is blocked by the candidate-path limitation recorded above.

**Fully unlocked:** none.  
**Partially advanced:** Chaos Warp's guarded engine candidate covers the public reveal event; production support remains fail-closed pending the complete evidence gate.

## Phase 5 — Legal stack-object retargeting and Deflecting Swat

Implement a true retarget operation for an existing spell or ability on the stack.

### Required semantics

- Target a spell or ability on the stack; revalidate that target when Deflecting Swat resolves.
- Reconstruct legal choices from the original object's target schema, modes, chosen modes, target-slot dependencies, “another,” distinctness, controller/owner relations, and player/permanent/stack target kinds.
- Permit leaving any or all targets unchanged because Oracle says “you may choose new targets.”
- Preserve the original object's controller, source, modes, X, costs, non-target choices, and timestamp/order.
- For multiple targets, validate the complete proposed target vector atomically; never partially mutate then discover an illegal later slot.
- Preserve the original number of targets and per-slot cardinality unless the original object's own target schema already permits variable selection; “choose new targets” does not grant permission to add or remove targets.
- If no alternate targets exist, unchanged targets remain a legal resolution.
- Support both spells and activated/triggered abilities represented on the stack.
- Deflecting Swat's commander condition changes only its casting mana cost to zero. It does not waive additional costs. Use the existing `controlsYourCommander` condition and normal free-cast action path.

### RED tests

- Single permanent target, player target, and stack target.
- Multi-target spell with one, several, or no changes.
- Duplicate-prohibited slots and “another” restrictions.
- Original target disappears before Swat resolves.
- Target stack object disappears before Swat resolves.
- Ability on stack, not only spell.
- Unchanged target vector.
- Free cast while controlling own commander; not free when commander is absent, stolen, or only another player's commander is controlled.
- Normal-cost cast remains available when condition is false and legal.
- Retargeted original resolves once; no copy is created.
- Replay/hash/view preserve the final target vector.

### Likely files

- `packages/engine/src/cards/ability.ts`
- stack-object types under `packages/engine/src/state/` and `packages/engine/src/stack/`
- target enumeration/validation helpers currently in `packages/engine/src/actions/legal.ts` and `packages/engine/src/effects/resolve.ts`
- `packages/engine/src/actions/apply.ts`
- player/spectator view and replay/hash files
- `packages/engine/src/cards/overrides/marchesa-the-black-rose.ts`
- new generic retarget tests and focused Deflecting Swat whole-game tests
- Card Test Lab, Playwright, and manifest

### Acceptance gate

- Generic retarget tests cover every supported target kind and atomic multi-target validation.
- Whole-game and browser evidence proves the original object—not a copy—has its targets changed.
- Only then remove Deflecting Swat's unsupported declaration. This phase is mechanically independent of Chaos Warp's rules implementation, but its production Card Test Lab/browser evidence is subject to the same lack of an approved isolated-candidate path; no Chaos Warp promotion is a prerequisite for guarded retarget engine work.

**Current blocker (2026-09-24):** A first guarded candidate probe confirmed that the stack retains
the original target schema, but it also exposed a design dependency before a primitive can be
implemented safely. `isTargetStillLegal` and `computeTargetOptions` take one controller argument
that simultaneously supplies the original spell/ability's `you`/`opponent` relationship and the
new targeting object's hexproof/protection identity. Deflecting Swat needs both identities: target
restrictions remain relative to the original object, while hexproof/protection must be evaluated
against the Swat controller. Passing either controller for both checks is incorrect. The target
legality API must first be split (or given explicit original-schema and targeting-source scopes),
then generic retarget tests must cover that distinction, abilities, counted/modal target graphs,
and atomic replacement. No retarget primitive or Swat candidate remains in the worktree, and the
production unsupported declaration stays active.

**Fully unlocked:** none.

## Per-card completion gate

A card may leave fail-closed containment only when all boxes are satisfied for that card:

- [ ] Pinned Oracle ID, full text, retrieval metadata, and SHA match the local fixture.
- [ ] Every Oracle clause maps to an implementation primitive and positive/negative scenario IDs.
- [ ] Real ID and fixture alias both interpret with no unmodeled reasons.
- [ ] Generic primitive tests pass.
- [ ] Direct behavior tests cover each ability and applicable edge cases.
- [ ] Whole-game test proves normal action menu, costs, choices, targets, priority, stack, and resolution.
- [ ] Hidden-information and public projection tests pass.
- [ ] Deterministic clone/replay/hash tests pass for new state fields or events.
- [ ] Card Test Lab server scenario passes through the production engine.
- [ ] Playwright drives the real frontend/backend and verifies interaction and result.
- [ ] Generated engine/viewer evidence is bound to the tested revision, Oracle hash, and scenario hash.
- [ ] Gameplay-AI observation is recorded separately with the exact provider/seed/run metadata; its result is not used as a correctness gate.
- [ ] Override snapshot changes are reviewed before regeneration.
- [ ] The card-specific unsupported declaration is removed only after the above pass.

## Verification sequence per phase

Use repository commands with the required `rtk` prefix and record exact counts/results. Start narrow, then widen:

```bash
rtk bunx vitest run <focused-engine-tests>
rtk bun run typecheck
rtk bun run typecheck:tests
rtk bun run lint
rtk bun run format:check
rtk bun run test
rtk bunx playwright test apps/web/e2e/card-test-lab.spec.ts
rtk bun run coverage
rtk bun run staples
rtk bun run modelled-cards
rtk git diff --check
rtk git status --short
```

If package scripts differ, inspect `package.json` and use the actual script names; do not report an unrun command as passing. A focused Playwright grep is not sufficient when the spec's global assertions require the full catalog.

For gameplay-AI evidence, use card-specific curated legal Commander decks and multiple seeds/provider runs. Save the generated report artifact and reference it from the manifest or review record; do not replace deterministic engine/viewer evidence with AI observations.

## Risk controls

For AI benchmark fixture maintenance, `refresh` verifies each original content hash before
recomputing compatibility pins, including dry runs, and preflights every selected case before
writes. Case, suite, variant, and capture-manifest paths are confined to their benchmark areas;
legitimate suite `../` references may still resolve within `benchmarks/`. Each changed fixture
uses a same-directory temporary file and rename, providing per-file atomicity. A multi-file
refresh is not transaction atomic: a later rename failure reports the exact paths already
updated, and rerunning after the failure skips those already-current files. See
`benchmarks/README.md` for the command contract.

- **Dirty worktree:** maintain a before/after file inventory for every phase; never reset or clean.
- **Schema drift:** any new stack/delayed-trigger/effect field must be carried through clone, replay, canonical hash, server transport, and player/spectator projections.
- **Decision ownership:** tests must assert the requested player, not merely the selected option.
- **Hidden information:** search/reveal tests compare owner, opponent, and spectator views.
- **Object identity:** use stable card identity across zone changes; do not retain stale object IDs.
- **Commander rules:** War Room uses the union of all commanders' identities; Deflecting Swat requires control of the player's own commander.
- **SBA timing:** Toxic Deluge must trigger SBAs immediately after effect application and before further priority.
- **Target graph complexity:** factor target enumeration/validation before Deflecting Swat; do not duplicate a weaker validator inside the effect resolver.
- **Coverage inflation:** coverage/staples are inventory signals only. Do not call a card complete from count changes.

## Recommended first implementation increment

Myriad Landscape and War Room are complete. The next card slice is **Toxic Deluge only**. Keep Toxic Deluge, Chaos Warp, and Deflecting Swat fail-closed until each has its own complete card gate.

## Expected unlock order

1. ~~Arcane Denial~~ — implemented-reviewed
2. ~~Smothering Tithe~~ — implemented-reviewed
3. ~~Fabled Passage~~ — implemented-reviewed
4. ~~Myriad Landscape~~ — implemented-reviewed
5. ~~War Room~~ — implemented-reviewed
6. Toxic Deluge
7. Chaos Warp
8. Deflecting Swat

This order prioritizes reusable, lower-risk primitives and leaves atomic stack retargeting—the broadest and highest-risk change—until the target model and serialization paths have already been strengthened.
