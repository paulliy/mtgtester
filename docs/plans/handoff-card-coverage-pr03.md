# Handoff: card coverage PR03 and beyond

Written 2026-10-08, after PR02 merged. This note is for a new Claude session continuing the
card-coverage plan. It covers the PR02 session's working rules, how PR01 and PR02 were built, and
the traps that cost time. Read it once, then work from the plan.

## Kick-off prompt

Paste this to start the next session:

> Read `docs/plans/handoff-card-coverage-pr03.md`, then start PR03 from
> `docs/plans/card-coverage-chunks.md` on a new branch. Follow the handoff's working rules. Stop
> only if a blocking change needs me; otherwise write up a final report and open a PR when done.

## Where things stand

- **Plan:** [card-coverage-chunks.md](card-coverage-chunks.md) splits the remaining work into 11
  PRs. PR01 ([paulliy/mtgtester#13](https://github.com/paulliy/mtgtester/pull/13), 29 cards) and
  PR02 ([paulliy/mtgtester#15](https://github.com/paulliy/mtgtester/pull/15), 33 cards) are
  merged. Coverage is 666/906 combined: 572/802 deck cards and 188/200 staples.
- **Next:** PR03, zone-change history, LKI, death and return. It has 28 cards: 21 fail-closed, 7
  unmodeled. Its section in the plan lists the primitives and every card's blocker. It depends
  only on PR01. After PR03, follow the dependency arrows in the plan. PR05 can run alongside
  PR04 to PR08 once PR03 lands.
- **Main changed after PR02.**
  - `3ccc190` split `CLAUDE.md` into `docs/guides/*.md`. The guides that matter here are
    `card-coverage-workflow.md`, `testing-discipline.md`, `rules-engine-constraints.md` and
    `project-commands.md`. `CLAUDE.md` now also sets subagent policy: Haiku for read-only search,
    Sonnet for bounded implementation and diff review, and the main thread for rules decisions.
  - `12b0b88` split CI into separate jobs. Docs-only PRs (only `docs/decisions/` and
    `docs/guides/`) skip the code jobs. `docs/plans/` is not docs-only.

## Working rules from the user

1. **One PR at a time.** Start each on a new branch from the latest `main`. Use the branch the
   session is given if there is one; otherwise use something like `claude/cards-pr03-zone-history`.
2. **Don't stop to ask.** Work through the whole PR. Stop only for a blocking change that needs
   the user. When done, run every gate, write a final report as the PR body, and open the PR.
3. **Review after each card group.** After every group of cards that share a primitive, start a
   Sonnet subagent to review that group's diff for bugs while you continue with the next group.
   Fix each confirmed finding with a regression test that fails without the fix. List the fixes
   and their commits in the PR body under "Review follow-ups".
4. **One card per commit.** Use the plan's commit subjects: `fix(cards): model <Card> (PR03.nn)`
   for fail-closed cards and `feat(cards): …` for new ones. Each commit leaves the tree green.
5. **Don't approximate.** If a card needs a primitive a later PR owns, move the card to that PR
   in the plan, in its own commit. Never ship a partial override.
6. **Commit trailers.** End every commit message with the session's `Co-Authored-By` and
   `Claude-Session` lines. Never put a model name in a commit, PR or code comment.
7. **Git rules.** Never skip or disable a test, push an empty commit, or use a bare `git stash`.
   Open a PR only once the work is done or the user asks.
8. **The user may ask you to watch the PR.** If so, follow the PR-watching rules in the system
   prompt, including review bots (CodeRabbit; Codex reviews are out of credits).

## How PR02 was built (copy this layout)

| Piece                                                            | PR02 location                                                    | PR03 equivalent                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Engine tests, one `describe` per card                            | `packages/engine/tests/pr02-card-coverage.test.ts`               | `pr03-card-coverage.test.ts`       |
| Headless viewer-scenario tests                                   | `packages/server/src/cards/card-test-scenarios-pr02.test.ts`     | `card-test-scenarios-pr03.test.ts` |
| Card Test Lab scenarios                                          | registered in `packages/server/src/cards/card-test-scenarios.ts` | same file                          |
| Browser tests, one per scenario                                  | `apps/web/e2e/card-test-lab.spec.ts`                             | same file                          |
| Viewer evidence catalog                                          | `VIEWER_CATALOG` in `scripts/card-evidence-input.ts`             | same file                          |
| Override for newly modeled cards                                 | `packages/engine/src/cards/overrides/coverage-pr02.ts`           | `coverage-pr03.ts`                 |
| Oracle fixture for new cards                                     | `packages/engine/tests/fixtures/coverage-pr02-oracle.json`       | `coverage-pr03-oracle.json`        |
| Manifest entries (clauses → test IDs, scenario IDs, Oracle hash) | `packages/server/fixtures/card-verification-manifest.json`       | same file                          |
| Card gate test list                                              | `test:card-gate` in root `package.json`                          | add both new test files            |

- **Fail-closed cards.** PR03's 21 fail-closed cards already have pinned Oracle text in
  `packages/engine/tests/fixtures/marchesa-batch1-oracle.json`, so they need no new fixture.
  Fix the card by teaching the interpreter or the templates where possible, and delete the
  override registration so the interpreter reads the card. For every restored card:
  - add an `interpreterRestored` entry in `docs/plans/card-catalog-audit.json`;
  - lower that source file's inventory count to match;
  - add or correct its row in `docs/plans/card-coverage-ledger.json`.
- **Unmodeled cards** (Victimize, Aurora Phoenix, Candlekeep Sage, Flickerwisp, Keeper of
  Secrets, God-Eternal Rhonas, Venser) need entries in the new fixture and its SHA-256 in the
  manifest. Add the new override and fixture to `SOURCE_FILES` in all five
  `scripts/generate-*-evidence.ts` generators.
- **Manifest status.** Declare new cards `implemented-unreviewed`. CI's
  `primitive-promotions` step rejects any card newly marked `implemented-reviewed` unless
  every one of its capabilities has an executable primitive contract
  (`bun run test:primitive-contracts`). PR01 and PR02 cards are all unreviewed for this
  reason. Promoting cards to reviewed is separate work; ask the user before taking it on.

## Main's engine architecture (after PR #14)

The `codex/card-engine-quality` refactor reorganised the engine, and several lints enforce the
new boundaries.

- **Casting.**
  - `casting/cast.ts` holds `proposeCast` and `castSpell`. A cast runs through a
    checkpoint/recover wrapper, and `resolutionPermission` covers casts during resolution.
  - `casting/free.ts` holds free and resolution-time casting (`legalFreeCastSelections`,
    `resolveFreeCard`).
  - Only `casting/*` and `actions/apply.ts` may import `casting/cast`.
  - Spell copies are built only in `stack/copy.ts`.
- **Payment.** `mana/spell-payment.ts` provides `planSpellPayment` and `chooseSpellPayment`,
  which make one joint payment decision.
- **Targets.** `targets/announcement.ts` (`legalTargetMenus`) and `targets/legality.ts`
  (`targetCandidates`).
- **IR registries are exhaustive.** A new effect, condition, trigger event, value or cost
  shape needs entries in:
  - `cards/capabilities.ts`
  - `effect-reference-contracts.ts`
  - `expression-validation.ts`
  - `trigger-contracts.ts`, which also sets object versus player event family
  - `condition.ts`
  - `authoring-validation.ts`

  Typecheck or the IR audit (`audit:card-ir`, which runs inside `test:card-gate`) tells you
  which one you missed.

- **Card-authoring lint.** Any override you change must use the builders: `spell()`,
  `triggered()`, `activated()` and `targetSlots()` from `cards/templates.ts`. Untouched legacy
  overrides are exempted by `packages/engine/tests/fixtures/legacy-authoring-exemptions.json`.
  When you migrate an override, update that file but keep its existing order and descriptions.
  A naive regeneration re-sorts it and loses them.
- **PR03 overlap.** Main already has zone-change identity contracts
  (`zone-change-trigger-identity-contract`, `card-zone-event-identity-contract`,
  `graveyard-exile-transition-contract`, `delayed-object-event-contract`). Read them before
  adding PR03's enter-origin, leaves-battlefield and delayed-return primitives. Some of the
  support may already exist.

## Gates to run before opening the PR

Run each of these and fix any failure:

```bash
bun run test                     # full suite; fullgame timing tests can flake under load
bun run typecheck                # NODE_OPTIONS=--max-old-space-size=8192 if it runs out of memory
bun run typecheck:tests
bun run lint
bun run format:check
bun run --cwd apps/web build
bun run test:card-gate
bun run snapshots:check
bun run test:e2e                 # Card Test Lab + smoke
bun run test:e2e:setup           # player-game + player-setup
```

Then run CI's promotion check locally, with `<base-sha>` set to `origin/main`'s full SHA:

```bash
bun run test:primitive-contracts --output <scratch>/pc
bun run primitive-promotions --base <base-sha> --primitive-evidence <scratch>/pc
```

Measure coverage from the committed fixture, because the full Scryfall bulk file isn't in a cloud
container. Use a throwaway script that runs `interpretCard(card).modeled` over
`packages/server/fixtures/coverage-oracle.json` (906 cards), plus the deck and staple
breakdowns. Delete the script afterwards. Record before and after numbers in the plan's
progression tables in the same PR.

## Traps that cost time

- **Snapshots.** After any interpreter or override change, regenerate with
  `bun run scripts/snapshot-interpret-defs.ts` and `bun run scripts/snapshot-override-defs.ts`.
  Read the diff before committing.
- **AI benchmark pins.** Card-definition changes invalidate the core-fast benchmark hash pins.
  Re-pin with `bun run ai-bench refresh --suite core-fast --write`. Run prettier before the
  re-pin, never after: formatting the pinned files after re-pinning invalidated the pin once.
- **Player-game e2e seed.** `apps/web/e2e/player-game.spec.ts` deals from the supported pool.
  When the pool grows, its seed can deal a different opening, and the test fails. Pick a new
  seed that gives P1 a land drop and a castable spell, and update the comment and the steps.
  It is currently `e2e-895` ("Play Forest ×3").
- **Card Test Lab e2e.** The spec's `afterAll` requires every catalog scenario to have run, so
  `playwright test -g <name>` always reports a failure even when the chosen test passed. Judge
  a single test by its own result, and run the full spec before pushing. Each run takes about
  10 minutes.
- **Leaving chips.** A permanent that leaves keeps its chip in the DOM during the leave
  transition. The spec's `permanent()` helper skips `board-card-leave-active`; use it, not raw
  locators, for blink and flicker cards.
- **Shell.** `pkill -f <pattern>` can match and kill your own shell; filter `ps` output instead.
  Don't call prettier with an empty file list, or it hangs waiting on stdin.
- **Hidden information.** `PlayerView` and logs must never leak face-down or hidden identities.
  Decision events carry a `publicDescription` for other seats. Test what other seats see with
  `formatPlayerLog`.
- **Determinism.** Viewer and e2e assertions that depend on a shuffle or draw must accept every
  card that could be drawn, not just the one today's seed gives.

## Open follow-ups from PR02

- **Kogla and Yidaro e2e (CodeRabbit, not yet fixed).** In `apps/web/e2e/card-test-lab.spec.ts`,
  the "Kogla and Yidaro: discard it to destroy P2's artifact" test has the wrong comment. Before
  the shuffle, the library holds a Mountain, a Forest and Lab Zombie. Widen
  `/draws (Forest|Kogla and Yidaro)/` to `/draws (Forest|Mountain|Lab Zombie|Kogla and Yidaro)/`
  and fix the comment. This is test-only and fits in PR03's first commit that touches the spec.
- **Known PR02 limitations.** These stay fail-closed or out of scope until a later card needs
  them:
  - Anrakyr casts X spells only at X=0.
  - Convoke is read from the main face.
  - Killian with "up to N" target slots is offered at full price but charged the reduced price.
  - Morph casts only from hand.
  - Replicate copies can't retarget "up to N" slots.
  - The heuristic bot has no foretell policy.
- **Branches outside this plan.** `codex/multiplayer-threat-assessment` has one unmerged commit
  of about 2.3k lines. Nine branches are fully merged and could be deleted. Leave them unless
  the user asks.
