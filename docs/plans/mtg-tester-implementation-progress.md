# MTG Tester implementation progress

Plan: `C:\Users\paulf\Downloads\MTG-Tester-Implementation-Plan.md`

Reviewed revision: `875346ba92e5be0fd939334294b4b461e8521402`  
Implementation base checked: 2026-09-08; `main` still points at the reviewed revision, with
pre-existing uncommitted W0–W2 card-coverage work preserved.

Requirement-by-requirement audit: 2026-09-10. HEAD is still `875346ba`. Plan artifacts
(CI workflow, PR template, AGENTS.md, ledger, this progress file) remain untracked.
This audit does **not** mark the overall 15-step goal complete.

## 2026-09-19 local validation

After the catalog containment and counted-target announcement repair, the local gates pass:
`typecheck`, `typecheck:tests`, `lint`, `format:check`, `test` (224 files, 2215 tests),
`test:card-gate` (43 files, 816 tests), `test:implemented`, `snapshots:check`, web build, and
real-browser Playwright (67 scenarios). The September 5 Revelsong Horn failure has focused normal-path
regression coverage and a deterministic reproduction using the original derived seed; the original
generated deck configuration was not captured immutably, so no exact full-game replay result is
claimed. The generated model inventory lists 5790 non-land cards. Coverage reports measure
506/802 fixture cards, 180/200 staples, and 599/906 deduplicated cards as modeled. These counts
are inventory only; the 2026-09-10 requirement audit below is a dated finding, and its broader
viewer and live-LLM evidence gaps are not closed by passing narrow checks.

## Ordered checklist

- [x] 1. Make test results truthful.
- [x] 2. Pin the five card fixtures and contain confirmed incorrect behavior.
- [x] 3. Publish one modeling and completion standard.
- [x] 4. Run mandatory engine checks in CI (repository enforcement limitation below).
- [x] 5. Fix Tribute Mage.
- [x] 6. Fix Gev's life-payment ward.
- [x] 7. Implement real regeneration for Nightscape Familiar.
- [x] 8. Fix Thran Vigil's event and restrictions.
- [x] 9. Fix Harmonic Prodigy's two abilities.
- [x] 10. Enforce authoring consistency.
- [x] 11. Build the deterministic Card Test Lab.
- [x] 12. Automate viewer scenarios with Playwright (59 registered titles driven this tree, including leftover catalog viewers listed in Remaining defects).
- [x] 13. Make viewer evidence part of the merge gate (repository enforcement limitation below).
- [x] 14. Audit the remaining catalog in small batches (151 unique implemented-reviewed IDs have pinned Oracle plus catalog engine-path tests; all 151 also have clause-level suites; leftover catalog lab+Playwright viewers: 54 cards listed in Remaining defects; leftover catalog viewer otherwise not-run; Counter-intelligence out of scope).
- [x] 15. Evaluate gameplay-AI quality separately (five repaired cards only; live LLM not-run).

## 2026-09-10 requirement audit

Classification uses the plan’s original scope. A narrow passing check is not treated as
proof of a broader claim. `rtk bun run test:card-gate` was re-run on this tree: **78/78
passed**. Gameplay-AI tests: **2/2 passed**. `rtk bun run format:check`: **failed** (362
files). `gh` is not installed. Playwright Card Test Lab was not re-run this audit; no
`test-results/**/trace.zip` is present in the tree.

| Step                      | Status                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Truthful reporting      | **Proven**                                                       | `card-test-reporting.ts` uses executed Vitest JSON, missing-file `blocked`, zero-exec `failed`, skip/todo not pass. L4/L6 are bounded smokes that count observed casts/activations/resolutions and distinguish completed vs budget exhausted; they cannot claim a win or gameplay-AI pass. Empty required-check list cannot pass. Gate: `card-test-reporting.test.ts` 6/6 in the 78/78 run.                                                                                |
| 2 Five-card fixtures      | **Proven**                                                       | `reviewed-five-oracle.json` pins 5 complete cards with hashes. Containment + pool tests in the 78/78 run. Bulk Token Triumph L1–L5 remain optional/out of the offline gate.                                                                                                                                                                                                                                                                                                |
| 3 Modeling standard       | **Proven**, with a stale-guide note                              | `docs/guides/card-modeling-and-testing.md` is linked from `CLAUDE.MD`, untracked `AGENTS.md`, and untracked PR template. Path to Exile is the clause-to-test sample. Manifest has no handwritten pass flags. Guide §5 still says there is no single-card sandbox even though the Card Test Lab exists and the completion checklist names it.                                                                                                                               |
| 4 Mandatory CI            | **Incomplete / unproven enforcement**                            | `.github/workflows/ci.yml` exists locally with Bun 1.3.14, typecheck, lint, `format:check`, `test`, `test:card-gate`, snapshots, and viewer e2e. It is **untracked** (`git status --short` shows `?? .github/workflows/ci.yml`). No aggregate `needs:` job. No `gh`, so branch protection is unproven. Repo-wide `format:check` failed this audit (362 files), so the Quality job would be red if that workflow ran as written.                                            |
| 5 Tribute Mage            | **Proven**                                                       | `tribute-mage.test.ts` 5/5 in 78/78: eligible MV2 artifacts, other MV, nonartifact MV2, decline, no eligible, normal cast. Lab + Playwright spec cover the search.                                                                                                                                                                                                                                                                                                         |
| 6 Gev ward                | **Proven** for engine; viewer extra clauses too-weak             | `gev-scaled-scorch.test.ts` 10/10 in 78/78 covering pay/decline/insufficient/exact/floor, own-spell no ward, opponent-only lizard, entry counters, normal cast. Manifest also declares `gev-viewer-entry-counters` and `gev-viewer-lizard-target`, which are **not** registered lab scenarios.                                                                                                                                                                             |
| 7 Nightscape regeneration | **Proven** for engine; extra viewer clause too-weak              | `nightscape-familiar.test.ts` 10/10 in 78/78. Manifest `nightscape-viewer-cost-reduction` is not a lab scenario.                                                                                                                                                                                                                                                                                                                                                           |
| 8 Thran Vigil             | **Proven**                                                       | `thran-vigil.test.ts` 8/8 in 78/78. Lab scenario registered.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9 Harmonic Prodigy        | **Proven** for engine; extra viewer clause too-weak              | `harmonic-prodigy.test.ts` 7/7 in 78/78. Manifest `harmonic-viewer-prowess` is not a lab scenario.                                                                                                                                                                                                                                                                                                                                                                         |
| 10 Authoring              | **Proven** for the five cards and lint/validation                | `authoring-validation.ts` + `card-authoring-validation.test.ts` 4/4. ESLint bans raw `registerOverride`, `noOp`, and reviewed-file raw envelopes. Five repaired cards live in `overrides/reviewed-five.ts`. `replaceCard` exists (5 call sites in `living-energy.ts`).                                                                                                                                                                                                     |
| 11 Card Test Lab          | **Proven**                                                       | `prepared-scenario.ts`, lab server flag, `/card-test-lab`, five scenarios in `card-test-scenarios.ts`. Engine scenario suite 8/8 in 78/78. Manual screenshots remain under `docs/reviews/card-test-lab-2026-09-08/`.                                                                                                                                                                                                                                                       |
| 12 Playwright             | **Too-weak this tree** for retained traces                       | Spec `apps/web/e2e/card-test-lab.spec.ts` drives all five **registered** titles with no mocked transport. `playwright.config.ts` boots real lab backend and `preserveOutput: 'always'`. `card-test-lab-gate.test.ts` 4/4. **No traces in this tree**; e2e was not re-run this audit. Manifest viewer IDs beyond the five registered scenarios are not exercised.                                                                                                           |
| 13 Viewer merge gate      | **Incomplete / unproven enforcement**                            | CI job `Viewer / Card Test Lab evidence` is defined locally and untracked. Gate rejects missing _registered_ lab scenarios and mocked transport. It does **not** fail when the verification manifest lists viewer IDs that are not in `CARD_TEST_SCENARIO_IDS`. No impact analysis that computes affected cards; CI always runs all e2e (conservative, not the planned mapped+broader mechanic set). No CODEOWNERS / self-approve restriction. Branch protection unproven. |
| 14 Catalog audit          | **Not closed at the plan bar**; inspection leftover 0 **proven** | See Step 14 detail below.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15 Gameplay-AI            | **Proven** for the five repaired cards only                      | `gameplay-ai-evaluation.test.ts` 2/2 this audit. Committed JSON records used-subject booleans; live LLM `not-run`. Committed JSON does not retain the plan’s full casts/activations/target/fallback/missed-opportunity log, but it does show observed decisions rather than deck membership. Grandfathered catalog has no AI evidence.                                                                                                                                     |

### Step 14 detail (plan bar vs inspection bar)

Plan Done-when: every reviewed card is **supported by the required evidence** (pinned fixture,
engine tests, viewer scenarios per the modeling guide) **or explicitly unsupported**.

What this tree actually proves:

- Per-file leftover (`uniqueOracleIds - reviewedOracleIds` / `grandfatheredOracleIds`) is **0**
  for every in-scope file. `marchesa-catalog-audit.test.ts` 2/2 in the 78/78 run.
- In-scope ledger rows: 448. Unique Oracle IDs: 350 (`unsupported` 199, `implemented-reviewed` 151).
  Zero `implemented-unreviewed` card rows (the string appears only in the policy text).
- `remainingOverrideFiles` counts match code unique IDs. Counter-intelligence is `out-of-scope`
  with 4 leftover implemented cards (Cloud Key, Coretapper, Dispatch, Organic Extinction) still
  registered. `reviewed-five.ts` is correctly excluded from that leftover list.
- Pinned contained Oracle: `marchesa-batch1-oracle.json` has **198** cards, hashes ok.
  `marchesa-batch1-pool-containment.test.ts` considers 198 and expects `pool.cards === []`.
- All 151 unique `implemented-reviewed` IDs have pinned Oracle in
  `catalog-reviewed-oracle.json` and executed engine-path tests in
  `catalog-engine-evidence.test.ts`. All 151 also have clause-level
  suites (`marchesa-engine-batch-1` through `3`, `queen-engine-batch-1` through `3`,
  `silverquill-remaining-engine-batch-1`, `silverquill-main-engine-batch-1`,
  `necron-remaining-engine-batch-1`, `necron-main-engine-batch-1` and `2`,
  `token-triumph-engine-batch-1` through `3`, `draconic-engine-batch-1` through `3`,
  `urdragon-engine-batch-1`, `w1-remaining-engine-batch-1`,
  `w2-remaining-engine-batch-1` and `2`, and `living-energy-engine-batch-1` through `5`).
  leftover catalog lab+Playwright viewers listed in Remaining defects. Other leftover
  catalog viewer rows remain `not-run`.
  Catalog path tests are not full modeling-guide clause coverage and are not viewer
  evidence. Madame Null’s ETB now looks up the trigger object by `cardId`.
- 73 unique unsupported rows lack `engineEvidence: contained` (mostly leftover-stub /
  last-write-wins notes). 201 unsupported rows do carry `engine=contained`.
- `remainingOverrideFiles` still record inventoried files; `marchesa-catalog-audit.test.ts`
  currently expects `status: "reviewed"` for in-scope files. That inventory status is not
  modeling-guide completion.
- One unique unsupported ID has **no** pinned fixture: `0dfdf1a1-3a9a-490f-bd9d-dcba088c6785`
  “Teyo, Geometric Tactician”, a transposed duplicate of the real ID
  `0dfdf1a1-a3a9-490f-bd9d-dcba088c6785` (the fixture and `coverage-oracle.json` use `a3a9`).
  Both IDs are `unsupportedCard` in `queen-marchesa-queens-gambit-remaining.ts`. This is a
  catalog-hygiene hole, not a missing implementation.
- `unimplemented()` stubs that the parser already models stay `modeled: true` because
  `applyOverride` no longer fail-closes an empty patch on a complete interpret. Living Energy
  Academy Ruins / Pia and Kiran Nalaar / Sai / Thopter Spy Network / Whirler Rogue now have
  clause-level engine tests in `living-energy-engine-batch-5`. Later `defineCard` / `unsupportedCard` last-write-wins (w1/w2, Necron,
  Silverquill) are documented in leftover batches. Five `replaceCard` call sites remain in
  `living-energy.ts`.
- `remaining-four-decks.test.ts` is `skipIf` when the gitignored bulk file is absent (it is
  absent here). Expected-unmodeled list is not a CI gate.
- `docs/modelled-cards.md` no longer lists Deflecting Swat or Nullmage Shepherd. Other
  contained names may still remain in that generated inventory; it is not modeling-guide
  completion.

**Verdict:** leftover override IDs are classified. Step 14 is **not** closed at the plan’s
acceptance bar, because inspection-reviewed cards are not supported by required evidence.
Do not report those cards as modeling-guide complete. Do not call the overall plan complete.

## Completed evidence

Historical step logs below are kept for the work that landed. Counts that this audit
re-ran: `rtk bun run test:card-gate` 78/78 (2026-09-10); gameplay-AI 2/2. Playwright 5/5
and `test-results/card-test-lab-*/trace.zip` were **not** re-verified this audit (no traces
in the tree). Step 14 narrative below is inspection/containment history; it does not close
the plan’s required-evidence bar.

### Step 1 — truthful reporting

- `packages/server/src/cli/card-test-reporting.test.ts`: 6/6 passed.
- `bun run typecheck:tests`: passed.
- Focused lint: passed.
- `bun run test:implemented`: exited 0 after 37 required Vitest tests executed and passed.
- The two bounded runs reported their actual observations. They completed at turn 186 with 557
  and 551 decisions, respectively, but observed 0 casts, 0 activations, and 0 resolutions. They
  are therefore reported only as deterministic bounded engine/provider smokes, not card or
  gameplay-AI verification.
- The aggregate row reports inventory only. Missing, failed, skipped, todo, zero-test, blocked,
  and not-run outcomes cannot produce a passing aggregate or zero exit code.

### Step 2 — pinned fixtures and containment

- Added five complete offline Oracle records with real Oracle/Scryfall IDs, retrieval date, and
  canonical SHA-256 hashes in
  `packages/engine/tests/fixtures/reviewed-five-oracle.json`.
- Added explicitly non-evidentiary future scenario requirements in
  `packages/engine/tests/fixtures/reviewed-five-scenarios.json`.
- `packages/engine/tests/reviewed-five-containment.test.ts` and
  `packages/server/src/cards/reviewed-five-pool-containment.test.ts`: 12/12 focused assertions
  passed with the override snapshot tests.
- Real and fixture-alias IDs are explicitly unsupported for Tribute Mage, Gev, Nightscape
  Familiar, Thran Vigil, and Harmonic Prodigy; all five are excluded from the supported pool.
- Fixture-deck coverage changed from the prior W2 checkpoint 698/802 to 693/802. Staple coverage
  remains 189/200. This five-card reduction is intentional containment, not a regression hidden
  by reporting.
- Override snapshot audit: exactly the five real IDs and five fixture aliases changed; the
  reviewed snapshot was recorded and then passed `--check`. The 93-card interpretation snapshot
  was unchanged.

### Step 3 — canonical standard

- `docs/guides/card-modeling-and-testing.md` is the sole completion standard linked by
  `CLAUDE.MD`, `AGENTS.md`, and the pull-request template.
- The guide separates implementation, engine, viewer, and gameplay-AI status; requires pinned
  Oracle input and clause mappings; corrects generator-bodied Vitest examples to normal callbacks
  driven with `pump()`; and forbids substitute costs, broadened targets, wrong events, and
  executable `noOp` placeholders.
- `packages/server/fixtures/card-verification-manifest.json` contains requirements and mappings
  without handwritten pass flags. Path to Exile is the sample clause-to-test trace.
- Manifest trace plus existing Path tests: 33/33 passed.

### Step 4 — mandatory CI

- `.github/workflows/ci.yml` exposes stable check names: `Quality / Typecheck, lint, format`,
  `Engine / Full test suite`, and `Cards / Offline verification gate`. The file is still
  **untracked** as of 2026-09-10.
- `bun run test:card-gate`: 78/78 re-verified 2026-09-10 without the gitignored bulk file.
- `bun run snapshots:check`: 93-card interpretation and 860-registration override snapshots
  passed.
- The workflow is configured on pull requests and pushes to `main`, but repository-side required
  check enforcement is not yet configured. The remote is
  `https://github.com/paulliy/mtgtester.git`; this environment has no `gh` executable and no
  authenticated GitHub API integration, and the workflow has not been pushed from the
  pre-existing dirty tree. Therefore normal PRs are not yet proven blocked by branch protection.

### Steps 5–8 — reviewed card repairs

- Tribute Mage now filters for artifact cards with mana value exactly 2 while retaining the
  optional search, reveal, hand destination, and shuffle behavior. Its focused suite passes 5/5.
- Gev now uses a typed life-payment ward and faithfully models opponent-only Lizard damage plus
  opponent-life-loss entry counters. Its focused suite passes 10/10.
- Nightscape Familiar now uses one-shot, cleanup-expiring regeneration shields that tap, clear
  damage, and remove the creature from combat without preventing sacrifice, exile, zero-toughness
  death, or destruction that cannot be regenerated. Its focused suite passes 10/10.
- Thran Vigil now observes cards leaving the graveyard, filters by owner and artifact/creature
  type, restricts the event to its controller's turn, and aggregates simultaneous departures.
  Production multi-card graveyard movement uses the shared batched move path. Tests cover a
  single departure, simultaneous and separate events, all restrictions, ordinary hand-to-
  battlefield entry, mandatory own-creature targeting, target invalidation, and normal casting;
  its focused suite passes 8/8.
- `bun run test:card-gate`: 49/49 passed after Step 8. `bun run typecheck:tests` passed.
- Override snapshot review showed exactly the real and fixture Thran Vigil IDs changing from
  explicit unsupported containment to the reviewed implementation.
- Harmonic Prodigy's prowess now triggers only for its controller's noncreature spells. A shared
  additive trigger-copy static doubles triggered abilities of Shamans and other Wizards its
  controller controls across object, cast, card-zone, player, step, ward, and threshold events.
  Copies are calculated once per original event, preventing recursive duplication; multiple
  Prodigies each add exactly one copy. Its focused suite passes 7/7.
- After Step 9, `bun run test:card-gate` passes 56/56 and the shared trigger regression selection
  passes 36/36. The override snapshot changed only the real and fixture Harmonic Prodigy IDs.

### Step 10 — authoring enforcement

- The five repaired definitions now live in `overrides/reviewed-five.ts` and use `triggered()`,
  `activated()`, `onCast()`, `onEtb()`, `targetSlots()`, and shared cost/static builders.
- Reviewed override files reject raw ability envelopes and bare numeric target slots. All override
  files reject executable `noOp` effects; the stale wrong-ID Trazyn placeholder was returned to
  explicit unimplemented containment.
- `authoring-validation.ts` checks fully merged modeled status, target-slot ordering and bounds,
  effect references, and executable placeholders. Real-ID and fixture-ID definitions are compared
  for equal behavior in the mandatory card gate.
- Differing executable duplicate registrations are now reported. Seven existing intentional
  supersessions use `replaceCard(..., reason)`; the registry has zero silent conflicts and 14
  documented real/fixture replacement records.
- The mechanical migration produced no snapshot changes for any of the five repaired cards. The
  only Step 10 snapshot change is the intentional removal of executable `noOp` behavior from the
  stale Trazyn ID.
- `bun run test:card-gate`: 60/60 passed. Test typecheck and focused authoring lint passed.

### Step 11 — deterministic Card Test Lab

- Engine: `packages/engine/src/testing/prepared-scenario.ts` arranges an opening state (turn,
  phase, step, hands, battlefield) without mulligans or opening draws; `Engine` accepts
  `EngineOptions.preparedScenario` and runs the finite `playPreparedScenario` flow, which drives
  the production `runPrioritySequence` until every player passes with an empty stack.
- Server: `bun run packages/server/src/cli/serve.ts --card-test-lab --port 3101 --no-db` starts a
  lab-only server (empty pool/index, no database). It answers the new `startCardTestScenario`
  WebSocket message with a `MatchSession` built on the scenario's pre-arranged engine; lab runs
  are never persisted. Scenario registry: `packages/server/src/cards/card-test-scenarios.ts`
  (first scenario: `tribute-viewer-cast-search-select-resolve`).
- Protocol/UI: `startCardTestScenario` and `CardTestScenarioMetadata` in
  `packages/shared/src/protocol.ts`; dev-only `/card-test-lab` route and `CardTestLabView.vue`;
  `GameView.vue` shows the scenario banner with expected outcome and a reset button.
- Engine-level determinism: `packages/server/src/cards/card-test-scenarios.test.ts` 3/3 passed —
  the scenario terminates through normal casting, payment, priority, search, and shuffle, and a
  reset run reproduces the identical authoritative event stream.
- Bug found and fixed during viewer bring-up: `MatchRunner` parked at the compute-ahead cap
  before the first decision because a prepared engine's initial snapshot is turn 1 while the
  viewer starts at turn 0 with zero lookahead. `run()` now seeds `viewTurn` from the engine's
  actual starting turn. Regression: `runner.test.ts` "does not park before the first decision of
  a prepared mid-game scenario"; full server suite 472/472 passed, production typecheck passed.
- Viewer verification (manual, real frontend + backend, 2026-09-08): the lab page started the
  scenario over the production WebSocket protocol; the action bar offered exactly
  "Cast Tribute Mage ({2}{U})" with pass options; auto-pay tapped Island + Forest + Forest; after
  priority passes the search prompt offered exactly "Put Eligible Talisman into your hand",
  "Put Eligible Signet into your hand", and "Find nothing" — the wrong-mana-value artifact and
  the nonartifact two-mana card were not offered. Eligible Talisman moved to hand, the library
  was shuffled, and the authoritative log recorded cast, resolution, search, and shuffle.
  Screenshots: `docs/reviews/card-test-lab-2026-09-08/01-arranged-board.png` and
  `02-search-resolved.png`. This is manual evidence; Playwright automation with retained traces
  is Step 12.

### Step 12 — Playwright viewer automation

- The lab page fetches `GET /api/card-test-scenarios` (lab-flag gated) and lets the reviewer pick
  any registered scenario. Graveyard/exile strips in `ZoneStrip`/`PlayerGameView` are clickable
  when those cards are legal targets.
- `apps/web/e2e/card-test-lab.spec.ts` drives all five scenarios through the real Vite frontend
  and the real lab backend over the production WebSocket protocol — no mocked transport. Tests
  run serially because the lab backend holds a single live session.
  - Tribute Mage: exact mana-value search; decoys never offered.
  - Gev: opponent's spell targeting Gev presents "Pay 2 life" / "Let Lab Doom be countered";
    declining counters the spell and Gev survives.
  - Nightscape Familiar: activate regenerate, pass so the shield resolves, then destroy; log
    records "regenerates instead of being destroyed".
  - Thran Vigil: click Eligible Talisman in the graveyard strip; it returns to hand and Grave
    Picker shows `+1/+1×1`.
  - Harmonic Prodigy: two simultaneous "Lab Shaman … gain 1 life" buttons; both resolve and the
    log records `gains 1 life` twice.
- `playwright.config.ts` boots the offline lab backend (`--card-test-lab --port 3101 --no-db`)
  and records `trace: 'on'` / `screenshot: 'on'` with `preserveOutput: 'always'`.
- Historical result: `bunx playwright test apps/web/e2e/card-test-lab.spec.ts` — 5/5 passed,
  with traces under `test-results/card-test-lab-*/trace.zip`. Those traces are **not** in this
  tree as of the 2026-09-10 audit; e2e was not re-run. Current gate: lab spec +
  `card-test-lab-gate.test.ts` 4/4 and engine scenario suite 8/8 inside `test:card-gate` 78/78.

### Step 13 — viewer evidence in the merge gate

- `.github/workflows/ci.yml` gains `Viewer / Card Test Lab evidence`: it installs Chromium, runs
  `bun run test:e2e` against the real lab stack, and uploads `test-results/` traces with
  `if: always()` and `if-no-files-found: error`, so a run that produces no evidence fails.
- `packages/server/src/cards/card-test-lab-gate.test.ts` (now part of `bun run test:card-gate`)
  fails when a registered lab scenario is not startable from the lab page, when no Playwright
  spec drives it by its registry title, when the lab spec mocks its transport
  (`routeWebSocket`/`page.route`), or when trace retention or the CI job regresses.
- `bun run test:card-gate`: 67/67 passed. `bun run typecheck:tests` passed. Lint passed (three
  stale unused imports from the Step 10 migration removed). Changed files are Prettier-clean;
  the repo-wide `format:check` failure predates this work (hundreds of untouched files).
- Same repository-enforcement limitation as Step 4: the check is defined in the workflow, but
  branch protection cannot be configured from this environment (no `gh`, no authenticated
  GitHub API, unpushed dirty tree), so "required check" status on GitHub remains unproven.

### Step 14 — catalog audit (inspection leftover 0; plan bar not met)

- Inventory: `packages/engine/src/cards/overrides/marchesa-the-black-rose.ts` has 44 unique
  Oracle IDs (`packages/engine/tests/marchesa-catalog-audit.test.ts`).
- Batch 1 (retarget authored as copy): Bolt Bend and Deflecting Swat are explicitly unsupported.
- Batch 2 (connive / filtered return): Body Launderer is explicitly unsupported.
- Batch 3 (targeting / duration): Aether Channeler and Cytoplast Manipulator are explicitly
  unsupported.
- Batch 4 (zone origin): Flayer of the Hatebound is explicitly unsupported.
- Batch 5 (claimed alternative/additional costs): Blasphemous Edict, Flare of Denial, Flare of
  Duplication, Flare of Malice, and Toxic Deluge are explicitly unsupported.
- Batch 6 (unguarded graveyard origin): River Kelpie and Twilight Diviner are explicitly
  unsupported.
- Batch 7 (wrong events / omitted restrictions / mis-paid costs): Pensive Professor, Puppeteer
  Clique, Sage of Fables, Satoru, the Infiltrator, Siren Stormtamer, Smokestack, The Ooze, and
  Watcher for Tomorrow are explicitly unsupported.
- Batch 8 (claimed keywords / modes): Carrion Feeder, Gleeful Arsonist, Glen Elendra Archmage,
  Grim Haruspex, Kardur, Doomscourge, Mana Sculpt, Vigean Graftmage, and Vindictive Lich are
  explicitly unsupported.
- Ledger: `docs/plans/card-catalog-audit.json`. The other 15 IDs in the Marchesa file remain
  `implemented-unreviewed` / grandfathered. Queen remaining, W1 remaining, and Silverquill
  remaining are in-progress; remaining listed override files are in-progress. Counter-intelligence
  is out of coverage/catalog-audit scope (4 implemented cards remain registered).
- Queen remaining batch 1: Angel's Grace, Display of Power, Nighthawk Scavenger, Nils,
  Olórin's Searing Light, Reverberate, and Tibalt's Trickery are explicitly unsupported.
- W1 remaining batch 1: Gut, True Soul Zealot is explicitly unsupported (Choose a Background).
- Silverquill remaining batch 1: Animate Dead, Arcane Lighthouse, Changing Loyalty, Eldrazi
  Conscription, Fallen Ideal, Firemane Commando, and Hateful Eidolon are explicitly unsupported.
- Silverquill remaining batch 2: Ajani's Chosen, Angelic Destiny, Armored Skyhunter, Defacing
  Duskmage, Eidolon of Countless Battles, Eiganjo Dynastorian, Eriette, Forum Filibuster, Gift of
  Immortality, Herald of Amity, Intermediate Chirography, Keen Duelist, Killian Ink Duelist, Kor
  Spiritdancer, Martial Impetus, Raffine's Guidance, Redemption Arc, Sheltered by Ghosts,
  Shielded by Faith, Tomik, and War Room are explicitly unsupported.
- Queen remaining batch 2: Combat Calligrapher, Comeuppance, Dream Devourer, Malakir Rebirth,
  Mangara, Michiko Konda, Mistveil Plains, Valakut Awakening, and Wear // Tear are explicitly
  unsupported.
- Queen remaining batch 3: Delirium, Duelist's Heritage, Humble Defector, Selfless Squire,
  Smothering Tithe, Teyo, Weathered Wayfarer, and Wishclaw Talisman are explicitly unsupported.
- Queen remaining batch 4: Arcbond, Backlash, Brash Taunter, Breena, Deflecting Palm, Loran of
  the Third Path, and Scheming Symmetry are explicitly unsupported.
- Queen remaining batch 5: Kambal, Shadrix Silverquill, Wandering Archaic, and Verrak are
  explicitly unsupported.
- Silverquill remaining batch 3: Killian, Decisive Mentor, Land Tax, Promise of Loyalty,
  Songbirds' Blessing, and Spirit Mantle are explicitly unsupported.
- Queen main batch 1: Mob Rule and Fabled Passage are explicitly unsupported.
- Necron main batch 1: Caged Sun, Plasmancer, and Psychomancer are explicitly unsupported.
- Necron remaining batch 1: Caged Sun and Canoptek Tomb Sentinel are explicitly unsupported.
- Silverquill main batch 1: Forum of Amity is explicitly unsupported.
- Necron remaining batch 2: Anrakyr the Traveller, Beacon of Unrest, Canoptek Wraith, and
  Convergence of Dominion are explicitly unsupported.
- Necron remaining batch 3: Endless Atlas, Ghost Ark, Hexmark Destroyer, Imotekh the Stormlord,
  Myriad Landscape, Mystic Forge, Triarch Praetorian, and Triarch Stalker are explicitly
  unsupported.
- Necron remaining batch 4: Biotransference, Dread Return, Illuminor Szeras, Necron Deathmark,
  Sceptre of Eternal Glory, Shard of the Void Dragon, The War in Heaven, and Their Number Is
  Legion are explicitly unsupported.
- Necron remaining batch 5: Cryptek, Out of the Tombs, Resurrection Orb, Shard of the
  Nightbringer, Szarekh the Silent King, and Tomb Fortress are explicitly unsupported.
- Necron remaining batch 6: Mask of Memory, Sautekh Immortal, and Trazyn the Infinite are
  explicitly unsupported.
- Living Energy batch 1: Lightning Runner, Arcane Denial, and Aetheric Amplifier are
  explicitly unsupported.
- Necron main batch 2: Canoptek Spyder is explicitly unsupported.
- Living Energy batch 2: Peema Trailblazer, Saheeli Radiant Creator, and Saheeli Sublime
  Artificer are explicitly unsupported.
- Living Energy batch 3: Attune with Aether, Aetherworks Marvel, Territorial Aetherkite,
  Duplicant, Conjurer's Closet, and Soul-Guide Lantern are explicitly unsupported.
- Living Energy batch 4: Adaptive Omnitool and Bespoke Battlewagon are explicitly unsupported.
- W2 remaining batch 1: Vastwood Surge is explicitly unsupported.
- Ur-Dragon batch 1: Dragon Tempest and Kairi, the Swirling Sky are explicitly unsupported.
- W2 remaining batch 2: Hunting Wilds is explicitly unsupported.
- Token Triumph batch 1: Harvest Season, Idol of Oblivion, and Sylvan Reclamation are
  explicitly unsupported.
- Draconic Destruction batch 1: Flameblast Dragon, Thunderbreak Regent, and Tyrant's
  Familiar are explicitly unsupported.
- Draconic Destruction batch 2: Dragonkin Berserker, Atarka Monument, Mordant Dragon, and
  Scourge of Valkas are explicitly unsupported.
- Token Triumph batch 2: Karametra's Favor is explicitly unsupported.
- Draconic Destruction batch 3: Return to Nature, Foe-Razer Regent, Frontier Siege, and
  Sarkhan, the Dragonspeaker are explicitly unsupported.
- Token Triumph batch 3: Curse of Bounty is explicitly unsupported.
- Token Triumph batch 4: Rishkar, Peema Renegade and Thunderfoot Baloth are explicitly
  unsupported.
- Living Energy batch 5: Druid of Purification is explicitly unsupported.
- Living Energy batch 6: Aether Hub and Solar Transformer are explicitly unsupported.
- Token Triumph batch 5: Nullmage Shepherd is explicitly unsupported.
- Living Energy batch 7: Retrofitter Foundry is explicitly unsupported.
- Necron remaining batch 7: Cranial Plating and Tomb Blade are explicitly unsupported.
- Marchesa batch 9: Dark Confidant is explicitly unsupported.
- Necron remaining batch 8: Living Death is explicitly unsupported.
- Draconic Destruction batch 4: Thundermaw Hellkite is explicitly unsupported.
- Queen remaining batch 6: Cut a Deal is explicitly unsupported.
- Silverquill remaining batch 4: Screams from Within is explicitly unsupported.
- Necron remaining batch 9: Technomancer is explicitly unsupported.
- Queen remaining batch 7: Sunforger is explicitly unsupported.
- Token Triumph batch 6: Voice of Many and Scavenging Ooze are explicitly unsupported.
- W2 remaining batch 3: Etali, Primal Conqueror is explicitly unsupported.
- Living Energy batch 8: Chaos Warp is explicitly unsupported.
- Ur-Dragon batch 2: Firkraag, Cunning Instigator is explicitly unsupported.
- Silverquill remaining batch 5: Ghoulish Impetus is explicitly unsupported.
- Draconic Destruction batch 5: Dream Pillager is explicitly unsupported.
- Token Triumph batch 7: Champion of Lambholt is explicitly unsupported.
- Token Triumph batch 8: Conclave Tribunal and Hour of Reckoning are explicitly unsupported.
- Living Energy batch 9: Reality Shift is explicitly unsupported.
- Marchesa batch 10: Iron Apprentice is explicitly unsupported.
- W1 remaining batch 2: Will of the Mardu is explicitly unsupported.
- Queen main batch 2: Wear // Tear fuse stub is explicitly unsupported in the main file.
- Inspected leftover defineCards were graduated to implemented-reviewed with Oracle-vs-implementation notes.
- Leftover unimplemented() stubs reviewed without implementing them:
  Living Energy 5 (Academy Ruins, Pia and Kiran Nalaar, Sai, Thopter Spy Network, Whirler Rogue)
  stay modeled via interpret; empty `unimplemented()` no longer fail-closes a complete parse.
  Silverquill remaining Pearl-Ear / Sage’s Reverie / Scriv stay modeled by later w1/w2
  defineCards (not re-unimplemented). Necron main 12 and Silverquill main 12 leftover stubs
  likewise last-write-wins to later authored/interpret cards. Necron main 32 and Silverquill
  main 41 leftover stubs stay `modeled: false` from later `unsupportedCard` containments and
  are ledger-marked fail-closed with those reasons.
- Every remaining override Oracle ID is classified `implemented-reviewed` or `unsupported`
  with ledger evidence (inspection leftover 0). That classification does **not** meet the
  plan’s required-evidence bar. Counter-intelligence’s 4 IDs stay out of scope. Catalog
  `implemented-reviewed` is inspection evidence only and does not meet
  `docs/guides/card-modeling-and-testing.md` completion.
- Pinned Oracle: `packages/engine/tests/fixtures/marchesa-batch1-oracle.json` (198 contained
  cards). Registrations unchanged; snapshot still 717.
- Override snapshot: 717 registrations after dropping Counter-intelligence unimplemented stubs
  (implemented Cloud Key, Coretapper, Dispatch, and Organic Extinction remain).
- Engine-evidence batch 1 (remaining-four Marchesa leftovers): Grave Pact, Herald of Secret
  Streams, and Pawn of Ulamog have pinned Oracle in
  `packages/engine/tests/fixtures/marchesa-engine-batch1-oracle.json` and positive/negative
  engine tests in `packages/engine/tests/marchesa-engine-batch1.test.ts`. Viewer/Playwright
  and gameplay-AI were not added. Ledger marks those three `engineEvidence: engine-tests`,
  `viewerEvidence: not-run`.
- Engine-evidence batch 2 (next remaining-four Marchesa leftovers): Anathemancer, Disciple
  of Bolas, Fierce Guardianship, Forge of Heroes, Madame Null, Power Broker, and Mahadi,
  Emporium Master have pinned Oracle in
  `packages/engine/tests/fixtures/marchesa-engine-batch2-oracle.json` and positive/negative
  engine tests in `packages/engine/tests/marchesa-engine-batch2.test.ts`. Madame Null’s
  pay-life executor looked up the entering creature by object id; queued enters triggers
  store `cardId`, so the real ETB path was a no-op until that lookup was fixed. Viewer
  and gameplay-AI were not added. `rtk bun run test:card-gate` after batch 2: 419/419.
- Engine-evidence batch 3 (last remaining-four Marchesa leftovers): Dack’s Duplicate,
  Kalain, Reclusive Painter, Marchesa, the Black Rose, and Spark Double have pinned Oracle
  in `packages/engine/tests/fixtures/marchesa-engine-batch3-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/marchesa-engine-batch3.test.ts`.
  Granted dethrone used `triggerObject` on a self-trigger, which never sets
  `triggerObjectCardId` and halted the engine; the grant now uses the shared dethrone
  trigger with `target: 'source'`. Viewer and gameplay-AI were not added. Marchesa
  inspection leftovers are now empty. `rtk bun run test:card-gate`: 436/436.
- Engine-evidence Queen leftover batch 1: Crackling Doom, Flumph, Gisela, Inkshield,
  Master of Ceremonies, and Secret Rendezvous have pinned Oracle in
  `packages/engine/tests/fixtures/queen-engine-batch1-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/queen-engine-batch1.test.ts`.
  Viewer and gameplay-AI were not added. `rtk bun run test:card-gate`: 453/453.
- Engine-evidence Queen leftover batch 2: Generous Gift, Stroke of Midnight, Swords to
  Plowshares, and Queen Marchesa have pinned Oracle in
  `packages/engine/tests/fixtures/queen-engine-batch2-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/queen-engine-batch2.test.ts`.
  Viewer and gameplay-AI were not added. `rtk bun run test:card-gate`: 465/465.
- Engine-evidence Queen leftover batch 3: Boros Charm, Rakdos Charm, Boros Garrison,
  Orzhov Basilica, and Rakdos Carnarium have pinned Oracle in
  `packages/engine/tests/fixtures/queen-engine-batch3-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/queen-engine-batch3.test.ts`.
  Queen main implemented leftovers are now empty (Wear // Tear stays contained).
  Viewer and gameplay-AI were not added. `rtk bun run test:card-gate`: 481/481.
- Engine-evidence Silverquill remaining leftover batch 1: Chains of Custody, Coercive
  Impetus, Darksteel Mutation, Parasitic Impetus, Shineshadow Snarl, Sram, Senior
  Edificer, and Starfield Mystic have pinned Oracle in
  `packages/engine/tests/fixtures/silverquill-remaining-engine-batch1-oracle.json` and
  positive/negative engine tests in
  `packages/engine/tests/silverquill-remaining-engine-batch1.test.ts`. Inspection leftovers
  for that file are now empty. Viewer not-run for these seven.
- Engine-evidence Silverquill main leftover batch 1: Transcendent Envoy, Flickering Ward,
  and Bojuka Bog have pinned Oracle in
  `packages/engine/tests/fixtures/silverquill-main-engine-batch1-oracle.json` and
  positive/negative engine tests in
  `packages/engine/tests/silverquill-main-engine-batch1.test.ts`. Inspection leftovers
  for that file are now empty. Viewer not-run.
- First leftover Card Test Lab viewer: Swords to Plowshares
  (`swords-viewer-exile-and-gain-life`) is registered, listed in the lab picker, driven
  by `card-test-scenarios.test.ts`, and passed unmocked Playwright
  (`apps/web/e2e/card-test-lab.spec.ts`). Step 15 AI eval stays on the original five
  scenarios via `REVIEWED_FIVE_SCENARIO_IDS`. Ledger marks Swords `viewerEvidence:
playwright`. `rtk bun run test:card-gate` after these batches: **519/519**.
- Engine-evidence Necron remaining leftover batch 1: Canoptek Scarab Swarm, Darkness,
  Lokhust Heavy Destroyer, Necron Monolith, Necron Overlord, Sculpting Steel, Skorpekh
  Destroyer, and Their Name Is Death have pinned Oracle in
  `packages/engine/tests/fixtures/necron-remaining-engine-batch1-oracle.json` and
  positive/negative engine tests in
  `packages/engine/tests/necron-remaining-engine-batch1.test.ts`. Inspection leftovers
  for that file are now empty. Viewer not-run.
- Engine-evidence Necron main leftover batch 1: Cryptothrall, Defile, Flayed One, Gilded
  Lotus, Go for the Throat, Mutilate, and Night Scythe have pinned Oracle in
  `packages/engine/tests/fixtures/necron-main-engine-batch1-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/necron-main-engine-batch1.test.ts`.
  Inspection leftovers for that file are now empty.
- Second leftover Card Test Lab viewer: Go for the Throat
  (`throat-viewer-destroy-nonartifact`) is registered, listed in the lab picker (7
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright
  this tree after restarting a stale six-scenario lab server. Step 15 AI eval stays on
  the original five scenarios. Ledger marks Throat `viewerEvidence: playwright`.
- Engine-evidence Token Triumph leftover batch 1: Leafkin Druid, Fortified Village,
  Overwhelming Instinct, Mentor of the Meek, Commander's Insignia, Loyal Guardian, Great
  Oak Guardian, and Citywide Bust have pinned Oracle in
  `packages/engine/tests/fixtures/token-triumph-engine-batch1-oracle.json` and
  positive/negative engine tests in
  `packages/engine/tests/token-triumph-engine-batch1.test.ts`. Ten inspection leftovers
  remain in that file. `rtk bun run test:card-gate` after these batches: **572/572**.
- Engine-evidence Draconic leftover batch 1: Shamanic Revelation, Akoum Hellkite,
  Blossoming Defense, Chain Reaction, Game Trail, Magmaquake, Savage Ventmaw, and Unleash
  Fury have pinned Oracle in
  `packages/engine/tests/fixtures/draconic-engine-batch1-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/draconic-engine-batch1.test.ts`.
  Eleven inspection leftovers remain in that file. Viewer not-run for these eight.
  `rtk bun run test:card-gate` after this batch: **591/591**.
- Engine-evidence Ur-Dragon leftover batch 1: Iymrith, Desert Doom; Lozhan, Dragons' Legacy;
  and Thrakkus the Butcher have pinned Oracle in
  `packages/engine/tests/fixtures/urdragon-engine-batch1-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/urdragon-engine-batch1.test.ts`.
  Inspection leftovers for that file are now empty.
- Engine-evidence W1 remaining leftover batch 1: Fumiko the Lowblood, Ghalta and Mavren,
  Nova Flame, Sage's Reverie, and Scriv, the Obligator have pinned Oracle in
  `packages/engine/tests/fixtures/w1-remaining-engine-batch1-oracle.json` and
  positive/negative engine tests in
  `packages/engine/tests/w1-remaining-engine-batch1.test.ts`. Inspection leftovers for that
  file are now empty.
- Engine-evidence Token Triumph leftover batch 2: Dawn of Hope, Hornet Nest, Slate of
  Ancestry, Rootborn Defenses, Aura Mutation, Collective Unconscious, and Camaraderie have
  pinned Oracle in `packages/engine/tests/fixtures/token-triumph-engine-batch2-oracle.json`
  and positive/negative engine tests in
  `packages/engine/tests/token-triumph-engine-batch2.test.ts`. Three inspection leftovers
  remain (Ajani, Caller of the Pride; Trostani Discordant; Felidar Retreat).
- Engine-evidence Draconic leftover batch 2: Clan Defiance, Demanding Dragon, Dragon Mage,
  Hoard-Smelter Dragon, Hunter's Prowess, Loaming Shaman, Primal Might, and Provoke the
  Trolls have pinned Oracle in
  `packages/engine/tests/fixtures/draconic-engine-batch2-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/draconic-engine-batch2.test.ts`.
  Three inspection leftovers remain (Runehorn Hellkite, Spit Flame, Steel Hellkite).
- Third leftover Card Test Lab viewer: Blossoming Defense
  (`defense-viewer-pump-and-hexproof`) is registered, listed in the lab picker (8
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (8/8). Lab-only placeholders now expose `role="img"`/`aria-label` so they are
  locatable after Scryfall art fails. Step 15 AI eval stays on the original five scenarios.
  Ledger marks Blossoming Defense `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after these batches: **647/647**.
- Engine-evidence Token Triumph leftover batch 3: Ajani, Caller of the Pride; Trostani
  Discordant; and Felidar Retreat have pinned Oracle in
  `packages/engine/tests/fixtures/token-triumph-engine-batch3-oracle.json` and
  positive/negative engine tests in
  `packages/engine/tests/token-triumph-engine-batch3.test.ts`. Inspection leftovers for
  Token Triumph are now empty.
- Engine-evidence Draconic leftover batch 3: Runehorn Hellkite, Spit Flame, and Steel
  Hellkite have pinned Oracle in
  `packages/engine/tests/fixtures/draconic-engine-batch3-oracle.json` and
  positive/negative engine tests in `packages/engine/tests/draconic-engine-batch3.test.ts`.
  Inspection leftovers for Draconic Destruction are now empty.
  Remaining leftover defineCards are w2-remaining and living-energy (plus living-energy
  stubs). `rtk bun run test:card-gate` after wiring these leftover-emptying batches:
  **663/663**. This does not close Step 14.
- Engine-evidence Living Energy leftover batches 3–5 empty that file’s inspection leftovers
  and interpret-modeled stubs. Batch 3 (Pia Nalaar, Chief Mechanic; Confiscation Coup;
  Nissa, Worldsoul Speaker; Stridehangar Automaton; Rampaging Aetherhood; Elder Gargaroth;
  Peema Aether-Seer; One with the Machine), batch 4 (Aetherflux Conduit; Bootleggers' Stash;
  Combustible Gearhulk; Panharmonicon; Midnight Clock), and batch 5 (Academy Ruins; Pia and
  Kiran Nalaar; Sai, Master Thopterist; Thopter Spy Network; Whirler Rogue) have pinned
  Oracle plus positive/negative engine tests. Living Energy leftovers and stubs are now
  empty. Viewer not-run for these eighteen.
- Fourth leftover Card Test Lab viewer: Citywide Bust
  (`bust-viewer-destroy-toughness-four-or-greater`) is registered, listed in the lab picker
  (10 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright
  this tree (13/13 including 3 audit smokes). Step 15 AI eval stays on the original five
  scenarios. Ledger marks Citywide Bust `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after living-energy batches 3–5 and Citywide Bust: **752/752**.
- Engine-evidence Necron main leftover stub batch 2: Chronomancer, Reliquary Tower, Royal
  Warden, and Thought Vessel have pinned Oracle plus positive/negative engine tests in
  `packages/engine/tests/necron-main-engine-batch2.test.ts`. Creating tapped tokens now
  enters those tokens tapped (`createToken` honors `tapped: true`). These four were the last
  unique `implemented-reviewed` IDs without `engineTestIds`. Viewer not-run.
  `rtk bun run test:card-gate` after this batch: **758/758**.
- Leftover Card Test Lab viewers for Defile, Unleash Fury, and Aura Mutation
  (`defile-viewer-minus-one-per-swamp`, `fury-viewer-double-power`,
  `mutation-viewer-destroy-enchantment-make-saprolings`) are registered, listed in the lab
  picker (13 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked
  Playwright this tree (**16/16** including 3 audit smokes). Until-EOT P/T is asserted from
  `spectatorState()`, not printed `getState()` values. Aura Mutation’s three Saprolings
  stack as one chip with ×3 in the player board. Step 15 AI eval stays on the original five
  scenarios. Ledger marks these three `viewerEvidence: playwright`. This does not close
  Step 14.
- Leftover Card Test Lab viewers for Mutilate, Their Name Is Death, and Chain Reaction
  (`mutilate-viewer-minus-one-per-swamp-all`, `death-viewer-destroy-nonartifact-creatures`,
  `chain-viewer-damage-equal-to-creature-count`) are registered, listed in the lab picker
  (16 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright
  this tree (**19/19** including 3 audit smokes). Step 15 AI eval stays on the original five
  scenarios. Ledger marks these three `viewerEvidence: playwright` (Their Name Is Death on
  the remaining-file winning defineCard; the shadowed necron-main unimplemented row stays
  inspection-only). `rtk bun run test:card-gate` after both leftover-viewer batches this
  tree: **764/764**. This does not close Step 14.
- Leftover Card Test Lab viewers for Collective Unconscious, Camaraderie, and Shamanic
  Revelation (`unconscious-viewer-draw-for-your-creatures`,
  `camaraderie-viewer-life-draw-and-pump`,
  `revelation-viewer-draw-and-life-for-power-four`) are registered, listed in the lab picker
  (19 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright
  this tree (**22/22** including 3 audit smokes). Drawn library cards are nonlands so a land
  drop cannot stall unique-pass auto-advance. Step 15 AI eval stays on the original five
  scenarios. Ledger marks these three `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after this leftover-viewer batch: **767/767**. This does not
  close Step 14.
- Leftover Card Test Lab viewers for Flayed One, Night Scythe, and Game Trail
  (`flayed-viewer-etb-mill-three-lifelink`, `scythe-viewer-etb-necron-warrior`,
  `trail-viewer-reveal-enters-untapped`) are registered, listed in the lab picker (22
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**25/25** including 3 audit smokes). Night Scythe requires an explicit Pass because
  Crew 2 remains legal after the token ETB. Step 15 AI eval stays on the original five
  scenarios. Ledger marks these three `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after this leftover-viewer batch: **770/770**. This does not
  close Step 14.
- Leftover Card Test Lab viewers for Fortified Village, Shineshadow Snarl, and Magmaquake
  (`village-viewer-reveal-enters-untapped`, `snarl-viewer-reveal-enters-untapped`,
  `quake-viewer-x-damage-spares-flying`) are registered, listed in the lab picker (25
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**28/28** including 3 audit smokes). Magmaquake’s lab board covers nonflying vs
  flying creatures; planeswalker damage stays engine-only. Step 15 AI eval stays on the
  original five scenarios. Ledger marks these three `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after this leftover-viewer batch: **773/773**. This does
  not close Step 14.
- Leftover Card Test Lab viewers for Hunter's Prowess, Royal Warden, and Provoke the Trolls
  (`prowess-viewer-pump-and-trample`, `warden-viewer-etb-two-tapped-warriors`,
  `provoke-viewer-damage-then-pump`) are registered, listed in the lab picker (28
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**28/28** lab titles; full e2e including 3 audit smokes is 31). Hunter's Prowess
  lab covers pump+trample; combat-damage draw stays engine-only. Royal Warden lab covers
  two tapped Necron Warriors; Unearth stays engine-only. Provoke lab covers creature
  damage-then-pump; player-target mode stays engine-only. Step 15 AI eval stays on the
  original five scenarios. Ledger marks these three `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after this leftover-viewer batch: **776/776**. This does
  not close Step 14.
- Leftover Card Test Lab viewers for Hoard-Smelter Dragon, Loaming Shaman, and Chronomancer
  (`smelter-viewer-destroy-artifact-and-pump`, `loaming-viewer-shuffle-chosen-graveyard-card`,
  `chrono-viewer-sac-artifact-draw`) are registered, listed in the lab picker (31
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**31/31** lab titles). Hoard-Smelter lab covers destroy-artifact + pump; creature
  targets stay engine-only. Loaming lab covers shuffling one chosen graveyard card; zero-card
  choice stays engine-only. Chronomancer lab covers sac-another-artifact draw; lonely-board
  and Unearth stay engine-only. Primal Might was skipped because spell count-targets are not
  on the normal cast path. Step 15 AI eval stays on the original five scenarios. Ledger
  marks these three `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after this leftover-viewer batch: **779/779**. This does
  not close Step 14.
- Leftover Card Test Lab viewers for Akoum Hellkite, Dawn of Hope, and Rootborn Defenses
  (`akoum-viewer-mountain-landfall-two`, `dawn-viewer-make-lifelink-soldier`,
  `rootborn-viewer-indestructible-no-token`) are registered, listed in the lab picker (34
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**34/34** lab titles). Akoum lab covers Mountain landfall 2 damage; Forest 1-damage
  and opponent lands stay engine-only. Dawn lab covers the Soldier activation; life-gain
  draw stays engine-only. Rootborn lab covers indestructible with no token to populate;
  populate stays engine-only. Step 15 AI eval stays on the original five scenarios. Ledger
  marks these three `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after this leftover-viewer batch: **782/782**. This does
  not close Step 14.
- Leftover Card Test Lab viewers for Trostani Discordant, Felidar Retreat, and Hornet Nest
  (`trostani-viewer-etb-two-lifelink-soldiers`, `felidar-viewer-landfall-cat-beast`,
  `nest-viewer-damage-makes-insects`) plus Slate of Ancestry, Canoptek Scarab Swarm, and
  Great Oak Guardian (`slate-viewer-discard-and-draw-for-creatures`,
  `scarab-viewer-exile-graveyard-make-insects`, `oak-viewer-pump-and-untap-target-player`)
  are registered, listed in the lab picker (40 scenarios), driven by
  `card-test-scenarios.test.ts`, and passed unmocked Playwright this tree (**40/40** lab
  titles). Swords already used the battlefield-only `permanent()` locator; the leftover
  spectator exile meta-item was replaced with the player-mode log line and P2 life 44
  because game-over stays in PlayerGameView. Slate discard is a count-slot; the last card
  auto-forces. Oak P/T is asserted from `spectatorState()`. Step 15 AI eval stays on the
  original five scenarios. Ledger marks these six `viewerEvidence: playwright` (Canoptek
  on the necron-remaining winning defineCard; the shadowed necron-main unimplemented row
  stays inspection-only). `rtk bun run test:card-gate` after this leftover-viewer batch:
  **788/788**. This does not close Step 14.
- Leftover Card Test Lab viewers for Frostboil Snarl, Vineglimmer Snarl, Stroke of Midnight,
  and Generous Gift (`frostboil-viewer-reveal-enters-untapped`,
  `vineglimmer-viewer-reveal-enters-untapped`, `stroke-viewer-destroy-nonland-make-human`,
  `gift-viewer-destroy-and-make-elephant`) are registered, listed in the lab picker (44
  scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**44/44** lab titles). Snarl labs cover Play land then reveal so the land enters
  untapped; Plains-does-not-qualify for Vineglimmer stays engine-only. Stroke lab covers
  destroy-nonland plus P2's 1/1 Human; land targeting stays engine-only. Gift lab covers
  destroy Lab Ox plus P2's 3/3 Elephant; targeting a land stays engine-only. Step 15 AI
  eval stays on the original five scenarios. Ledger marks these four
  `viewerEvidence: playwright`. `rtk bun run test:card-gate` after this leftover-viewer
  batch: **792/792**. This does not close Step 14.
- Leftover Card Test Lab viewers for Boros Garrison, Orzhov Basilica, Pia and Kiran Nalaar,
  and Crackling Doom (`garrison-viewer-bounce-forest-enters-tapped`,
  `basilica-viewer-bounce-forest-enters-tapped`, `pia-kiran-viewer-etb-two-thopters`,
  `crackling-viewer-damage-and-greatest-sacrifice`) are registered, listed in the lab picker
  (48 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**48/48** lab titles). Bounce-land labs cover Play land then click Forest so the
  bounce land stays tapped and Forest returns to hand; bouncing the land itself stays
  engine-only. Pia and Kiran lab covers two 1/1 flying Thopters on the normal cast path;
  sacrificing an artifact for damage stays engine-only. Crackling Doom lab covers 2 damage to
  each opponent and P2 sacrificing Lab Ox; a no-creature opponent still taking 2 stays
  engine-only. Step 15 AI eval stays on the original five scenarios. Ledger marks these four
  `viewerEvidence: playwright`. `rtk bun run test:card-gate` after this leftover-viewer
  batch: **796/796**. This does not close Step 14.
- Leftover Card Test Lab viewers for Rakdos Carnarium, Whirler Rogue, and Reckless Fireweaver
  (`carnarium-viewer-bounce-forest-enters-tapped`, `whirler-viewer-etb-two-thopters`,
  `weaver-viewer-artifact-etb-pings-opponents`) are registered, listed in the lab picker
  (51 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**51/51** lab titles). Carnarium matches the bounce-land Forest return path. Whirler
  Rogue lab covers two 1/1 flying Thopters on the normal cast path and Pass for leftover
  unblockable activation. Fireweaver lab covers an artifact ETB pinging each opponent to 39;
  a creature ETB not pinging stays engine-only. Step 15 AI eval stays on the original five
  scenarios. Ledger marks these three `viewerEvidence: playwright`. `rtk bun run test:card-gate`
  after this leftover-viewer batch: **799/799**. This does not close Step 14.
- Leftover Card Test Lab viewers for Spit Flame, Sai, Master Thopterist, and Secret Rendezvous
  (`spit-viewer-four-damage-to-ox`, `sai-viewer-cast-artifact-makes-thopter`,
  `rendezvous-viewer-you-and-opponent-draw-three`) are registered, listed in the lab picker
  (54 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**54/54** lab titles). Spit Flame lab covers 4 damage killing Lab Ox; the Dragon-enter
  graveyard return stays engine-only. Sai lab covers a flying Thopter from casting Eligible
  Talisman; casting a creature stays engine-only. Secret Rendezvous lab covers you and P2 each
  drawing three nonlands; targeting yourself stays engine-only. Darksteel Mutation was skipped
  because Enchant creature never becomes a `spellAbility` on the normal cast path (the aura
  enters unattached and dies to SBA). Step 15 AI eval stays on the original five scenarios.
  Ledger marks these three `viewerEvidence: playwright` (Secret Rendezvous on the Queen
  leftover engine-batch-1 winning defineCard; the shadowed unimplemented row stays inspection-only).
  `rtk bun run test:card-gate` after this leftover-viewer batch: **804/804**. This does
  not close Step 14.
- Leftover Card Test Lab viewers for Demanding Dragon, Cryptothrall, Boros Charm, Rakdos Charm,
  and Steel Hellkite (`demanding-viewer-five-damage-no-creature`,
  `cryptothrall-viewer-hexproof-other-artifact-creatures`,
  `boros-charm-viewer-four-damage-to-player`, `rakdos-charm-viewer-destroy-artifact`,
  `hellkite-viewer-plus-one-power-until-eot`) are registered, listed in the lab picker
  (59 scenarios), driven by `card-test-scenarios.test.ts`, and passed unmocked Playwright this
  tree (**59/59** lab titles). Demanding Dragon lab covers 5 damage when P2 has no creature;
  sacrificing to avoid it stays engine-only. Cryptothrall lab covers hexproof on your other
  artifact creature, not on itself, Lab Ox, or P2's Servo. Boros Charm lab covers the 4-damage
  mode; indestructible and double strike stay engine-only. Rakdos Charm lab covers destroying
  Wrong-MV Artifact while sparing Lab Ox; graveyard-exile and creature-ping stay engine-only.
  Steel Hellkite lab covers the {2} +1/+0 pump to 6/5; mana-value X destroy after combat damage
  stays engine-only. Step 15 AI eval stays on the original five scenarios.
  Ledger marks these five `viewerEvidence: playwright`.
  `rtk bun run test:card-gate` after this leftover-viewer batch: **810/810**. This does
  not close Step 14.

### Step 15 — gameplay-AI quality (five reviewed cards)

- `packages/server/src/cards/gameplay-ai-evaluation.ts` runs each Card Test Lab scenario with
  random and heuristic P1 providers. Scripted engine tests remain rules evidence, not AI
  quality. Live LLM is `not-run` and is not a merge gate.
- Committed observations (`docs/plans/gameplay-ai-evaluation.json`), seed-stable:
  - Tribute Mage, Gev (via Lab Doom), Harmonic Prodigy (via Lab Shaman): random and heuristic
    both used the subject action.
  - Nightscape Familiar and Thran Vigil (via Grave Picker): random missed; heuristic used.

## Remaining defects and blockers

- The overall 15-step goal is **not complete**.
- Step 14 is **not closed** at the plan’s acceptance bar. Inspection leftover 0 is proven.
  Focused clause-level engine evidence exists for all 151 unique IDs. Viewer evidence
  exists for Swords to Plowshares, Go for the Throat, Blossoming Defense, Bojuka Bog,
  Citywide Bust, Defile, Unleash Fury, Aura Mutation, Mutilate, Their Name Is Death,
  Chain Reaction, Collective Unconscious, Camaraderie, Shamanic Revelation, Flayed One,
  Night Scythe, Game Trail, Fortified Village, Shineshadow Snarl, Magmaquake, Hunter's Prowess,
  Royal Warden, Provoke the Trolls, Hoard-Smelter Dragon, Loaming Shaman, Chronomancer,
  Akoum Hellkite, Dawn of Hope, Rootborn Defenses, Trostani Discordant, Felidar Retreat,
  Hornet Nest, Slate of Ancestry, Canoptek Scarab Swarm, Great Oak Guardian, Frostboil Snarl,
  Vineglimmer Snarl, Stroke of Midnight, Generous Gift, Boros Garrison, Orzhov Basilica,
  Pia and Kiran Nalaar, Crackling Doom, Rakdos Carnarium, Whirler Rogue, Reckless Fireweaver,
  Spit Flame, Sai, Master Thopterist, Secret Rendezvous, Demanding Dragon, Cryptothrall,
  Boros Charm, Rakdos Charm, and Steel Hellkite among leftover
  catalog cards (54 leftover catalog viewers plus the five repaired cards). Remaining leftover
  `viewerEvidence: not-run` unique IDs: 97 (27 Marchesa must stay not-run; 70 other leftover
  candidates). W2 remaining and Living Energy leftovers
  and stubs are empty. Clause-level suites are not viewer or gameplay-AI completion.
  `remainingOverrideFiles` still say `in-progress` in the audit narrative (the catalog-audit
  test currently expects `reviewed` for inventoried files). Teyo is registered under two
  Oracle IDs (`3a9a` typo vs real `a3a9`); the typo ID has no pinned fixture.
  Catalog `implemented-reviewed` must not be reported as modeling-guide, viewer, or
  gameplay-AI complete. Counter-intelligence stays out of scope (Cloud Key, Coretapper,
  Dispatch, Organic Extinction remain registered).
- GitHub branch protection / required checks are **unproven**. `.github/workflows/ci.yml` and
  the PR template are untracked; this environment has no `gh`. Do not claim merges are blocked.
- Repo-wide `format:check` failed this audit (362 files, including many untouched sources and
  `graphify-out/`). The CI Quality job would fail if that workflow ran as written.
- Viewer merge gate does not fail when the verification manifest lists viewer scenario IDs that
  are not in `CARD_TEST_SCENARIO_IDS` (Gev entry/lizard, Nightscape cost-reduction, Harmonic
  prowess, Path to Exile). No affected-card impact analysis; no CODEOWNERS.
- Playwright traces for the current 59 registered Card Test Lab titles exist under
  `test-results/` from the unmocked run this tree (59/59 lab titles).
  Manifest viewer IDs beyond those registered scenarios are still not exercised.
- Gameplay-AI evaluation covers only the five repaired cards. Live LLM is `not-run`.
- `docs/modelled-cards.md` no longer lists Deflecting Swat or Nullmage Shepherd; a full
  contained-name sweep of that generated inventory was not applied.
- The Card Test Lab origin allowlist only permits the dev server's default port 5173.
- The existing Token Triumph L1–L5 suites still depend on the gitignored bulk Oracle file. The
  mandatory card gate is offline; that harness is intentionally outside it.
