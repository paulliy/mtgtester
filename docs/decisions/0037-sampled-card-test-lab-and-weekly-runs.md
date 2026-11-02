# ADR 0037: Sample the Card Test Lab on pull requests, and run the scheduled suites weekly

Status: Accepted (2026-11-02)

Date: 2026-11-02

Amends: [ADR 0036](0036-ci-minutes-budget.md) decisions 1, 5, 6 and 8 (which events run CI, how
often the scheduled runs happen, and what `ci:lab` runs). What each suite checks is unchanged.

## Context

The concern is billed Actions minutes, not wall time. After ADR 0036 the Card Test Lab Playwright
suite is still the longest slow suite: 980 browser tests over 967 scenarios on one worker, because
the lab backend holds one live session. A pull request that picks `ci:lab` plays every scenario on
every push while the label is on, although a card change touches a handful of them. The nightly
`ci.yml`, fuzz and bulk-data runs repeat on every day main changed, including days that changed
nothing they test.

The engine's capability index (`deriveCardCapabilities`) gives each scenario's cards a set of
primitive capabilities (`Effect.draw`, `Keyword.haste`). On the committed fixture there are 744
capabilities in 25 families, and 331 of them are used by only one card, so a sample that covers
every capability plays nearly every scenario. A sample per family does not.

## Decision

1. **`ci:lab` plays a sample.** `bun run lab:select` picks:
   - **the change's own scenarios**: those whose fingerprint (below) is new or differs from the
     committed index at the merge base, and those the diff names. A scenario is named by a changed
     line's string literal, or by the `case` label, `===` comparison, `test(...)` title, `id`
     property or (outside the engine) call argument around a changed line;
   - **one scenario for each engine primitive the change's engine edits name**: string literals in
     changed `packages/engine/src` lines and their enclosing `case` labels and `if` comparisons,
     matched against capability names (`case 'untapBoundIf':` names `Effect.untapBoundIf`). Tests
     and per-card overrides do not count; an override change changes its scenarios' fingerprints;
   - **one primitive from each capability family, and one scenario using it**, drawn by a SHA-256
     of the pull request's head commit, so a re-run of a commit plays the same sample and each push
     plays a different one.

   On recent engine commits this selects 25 to 30 scenarios, and the run lists about 40 tests
   instead of 980.

2. **Filtering.** The selection file names the IDs and titles of the scenarios left out, and
   `playwright.config.ts` turns them into `grepInvert` when `LAB_SELECTION` is set. A test titled
   with a scenario's ID or title runs only when that scenario is selected. A hand-titled test runs
   when any scenario its body names is selected, and always runs when it names none. Each spec's
   completeness check (`expectLabCoverage`) demands every selected scenario of its batch in a
   sampled run, and the whole batch when `LAB_SELECTION` is unset.

3. **The fingerprint index.** `packages/server/fixtures/card-test-lab-index.json` maps each scenario
   ID to a hash of its metadata (Oracle pin and clause IDs included), seed, seat cards, their card
   overrides, and a board summary (where each card sits and in what state, life totals, turn and
   step) that ignores engine-internal fields. `bun run lab:index --check` runs in the offline card
   gate job; after changing a scenario, run `bun run lab:index --write` and commit the result.

4. **Labels.**

   | Label            | Lab run                                                               |
   | ---------------- | --------------------------------------------------------------------- |
   | `ci:lab`         | the sample in decision 1                                              |
   | `ci:lab-latest`  | the scenarios added on main in the last 7 days, plus the change's own |
   | `ci:lab-verbose` | every scenario                                                        |
   | `ci:e2e`         | the sample, plus the setup and table suites                           |
   | `ci:full`        | the sample, plus every other slow suite                               |

   `ci:lab` and `ci:lab-latest` combine; `ci:lab-verbose` overrides both. A green sampled run
   satisfies `CI / Gate`, whose notice names the scenarios left out as covered by the weekly run.

5. **Weekly instead of nightly, and only after engine changes.** `ci.yml`, `fuzz-nightly.yml` and
   `bulk-nightly.yml` run on Mondays, and a scheduled run exits after checkout unless a commit on
   main touched `packages/engine/src` in the last 169 hours (a week and an hour). The weekly
   `ci.yml` run plays every suite with every lab scenario. Manual dispatch always runs everything.
   The fuzz and bulk files keep their names: the fuzz seeds advance with the workflow's run number,
   which a renamed file would restart, and its failure issue keeps its title so an open one is still
   found.

6. **Pull requests run CI on three events only** (added 2026-11-02): `opened`, `ready_for_review`
   and `labeled`. A push to a pull request (`synchronize`), a reopen, and a push to main run
   nothing. Each run checks the pull request's head at that moment. To check commits pushed since
   the last run, add a label; removing and re-adding one works.

## Consequences

- A regression in a lab scenario the sample did not draw merges and is found by the next weekly run,
  up to a week later. Pick `ci:lab-verbose` for viewer or presentation changes that touch many
  scenarios.
- A week with no engine commit runs nothing on schedule, even if `apps/web`, `packages/server` or the
  scenarios changed. Those changes are covered only by the suites their pull requests picked, until
  a later engine commit or a manual dispatch.
- The fuzz job plays 48 seeds per week instead of per day.
- `CI / Gate` reports on the commit a run checked. After a push, the new head has no gate result
  until a label is added, so branch protection that requires the gate holds the merge until then. A
  re-run from the Actions page repeats the old head, so it does not check the push.
- A branch updated with main (the "Update branch" button is a push) needs a label added before it
  can merge under "require branches to be up to date".
- Main gets no CI on merge; the weekly run is its only scheduled check.
- Scenario changes now also need the index regenerated. The check names the stale scenarios.
- A scenario edit that the fingerprint does not see (a scripted opponent's choice in a shared
  builder) and that names no scenario in its diff is not targeted. It still runs whenever the
  sample draws it, and in each weekly run.
- Local runs, evidence generation and the weekly run are unchanged: without `LAB_SELECTION` every
  test runs and every completeness check demands the whole catalog.
