# ADR 0036: Run the slow CI jobs once per pull request, not on every push

Status: Accepted (2026-11-01)

Date: 2026-11-01

Amends: [ADR 0034](0034-fail-loud-execution-and-strict-tests.md) decisions 5, 8 and 9 (when the
mutation, fuzz and collection checks run; not what they check).

## Context

`ci.yml` ran the full test suite (about 18 minutes, plus a 2.5-minute Vitest listing), Playwright
(about 29 minutes for the Card Test Lab and setup suites, plus the table suite), IR mutation and,
for engine changes, a fuzz job of up to 30 minutes, on every push to a ready pull request, and then
again on the push to main. One ready engine pull request push cost roughly 70 to 110 billed runner
minutes, and each fix-up push repeated all of it. Other waste:

- The Vitest collection was listed three times per run (`check:suite-collect`,
  `check:manifest-tests`, `mutate-cards`), about 2.5 minutes each.
- `ai-benchmark-contracts` ran a subset of `bun run test` in its own job beside the full suite.
- Format, typecheck, lint and the web build were four jobs, each paying checkout, `bun install`
  and per-job minute rounding.
- The two Playwright jobs each installed Chromium's system packages.
- No job but fuzz set `timeout-minutes`, so a hung job could bill the 360-minute default.
- The nightly fuzz (up to 120 minutes) and bulk-data (up to 60) runs ran on days main did not
  change; the bulk run's input is pinned, so those runs repeated the previous result.

## Decision

1. **Fast checks on every pull request push.** One `Quality` job runs format, typecheck, lint, the
   web build and, when the full suite will not run, the AI benchmark contract tests. Every step runs
   even when an earlier one fails, so a push reports all problems at once. The offline card
   verification gate (card gate, ratchets, snapshots, primitive contracts) also runs on every push.
2. **Slow checks behind labels.** The full suite with the collection checks and IR mutation, and
   the Playwright suites, run on a pull request only while a label picks them (adding the label
   starts a run), and on the nightly and manual runs. The draft state no longer decides this.
   Decision 8 lists the labels.
3. **One required check, `CI / Gate`.** It fails when any job it waits on failed or was cancelled,
   and on a ready (non-draft) pull request that changed code but has no label picking a slow suite.
   A pull request therefore cannot merge without a green run of the suites it picked on its head
   commit; drafts pass, because they cannot merge. The gate names the suites left out.
4. **PR fuzz behind `ci:fuzz`.** The advisory fuzz job (ADR 0034 decision 8) runs only on engine
   pull requests that carry `ci:fuzz`. The nightly run stays authoritative.
5. **Main pushes run the fast checks only.** With "require branches to be up to date before
   merging", the merged tree is the one the pull request verified. A nightly `ci.yml` run repeats
   every job on main when main changed in the last 25 hours.
6. **Nightly runs skip idle days.** `ci.yml`, `fuzz-nightly.yml` and `bulk-nightly.yml` scheduled
   runs exit after checkout when main's head commit is more than 25 hours old. Manual dispatch
   always runs. Nightly fuzz seeds still advance with the run number, so skipped nights' seeds are
   not played.
7. **Shared work.** The full-suite run writes Vitest's JSON report, which
   `scripts/vitest-run-listing.ts` turns into the collection listing passed to
   `check:suite-collect`, `check:manifest-tests` and `mutate-cards` with `--collected`; a separate
   `vitest list` imported every suite a second time (about 7 minutes). When the full suite runs, the
   card gate checks its list and prints its facet warnings but leaves its test files to the full
   suite (`test:card-gate --skip-run`), so they run once. The Playwright suites share one job and
   one browser install. Every job sets `timeout-minutes`.
8. **Labels pick the slow suites** (added 2026-11-01). A pull request picks what its change needs:

   | Label       | Runs                                                       |
   | ----------- | ---------------------------------------------------------- |
   | `ci:engine` | full test suite, collection checks, IR mutation            |
   | `ci:lab`    | Card Test Lab Playwright (`test:e2e`), the longest suite   |
   | `ci:setup`  | Play my deck setup and player game Playwright              |
   | `ci:table`  | multiplayer table Playwright                               |
   | `ci:e2e`    | all three Playwright suites                                |
   | `ci:full`   | every slow suite                                           |
   | `ci:fuzz`   | the advisory fuzz job (decision 4), on engine changes only |

   Labels combine. The nightly run on main runs every suite, so a suite a pull request left out is
   still covered within a day of the merge.

## Consequences

- A typical pull request push costs a few minutes; the picked suites run once when the author adds
  their labels, and again on each push made while the labels stay on.
- A pull request that picks only some suites can merge a change that breaks one it left out. The
  nightly run reports it, and the gate's notice lists what was left out, so pick `ci:full` when
  unsure.
- `check:manifest-tests` moved from the card gate to the full-suite job, so a manifest test ID that
  stops matching is reported at the full run rather than on every push.
- Adding any label to a pull request reruns its workflow (GitHub has no per-label trigger filter),
  and cancels a run in progress. Skipping those runs would leave skipped check results that hide an
  earlier failure, so they run.
- Branch protection must require `CI / Gate` instead of the old per-job names.
- A direct push to main gets only the fast checks until the next nightly run.
