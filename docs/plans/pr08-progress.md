# PR08 preparation checkpoint

Prepared 2026-10-17. Draft PR: <https://github.com/paulliy/mtgtester/pull/26>.
Branch: `cards/pr08-control-choices`, based on `origin/main` at `af01d793`.

## Scope and status

PR08 retains the 23 cards in [the coverage chunks](card-coverage-chunks.md#pr08-control-changes-and-multiplayer-choices).
Expected combined inventory after implementation is 809/906 from 786/906. No PR08 card is
implemented or verified by this preparation. The seven reopened quality-audit cards now belong
to PR12, as requested by the user.

## External blocker

[The initial CI run](https://github.com/paulliy/mtgtester/actions/runs/39058473513) did not start
its classification or format jobs. GitHub's check annotation states:

> The job was not started because recent account payments have failed or your spending limit
> needs to be increased. Please check the 'Billing & plans' section in your settings

Required checks cannot become green until the account owner resolves this billing/spending
restriction. No CI job, required check, or repository protection was weakened to bypass it.

## Local preparation

- Frozen dependency installation, production typecheck, test typecheck, and lint passed.
- The full baseline suite exposed the existing async-provider test's 15-second timeout
  under concurrent load. The run was stopped after the billing blocker was confirmed;
  it is not a passing full-suite result. No test was changed or disabled.
- GLM 5.3 Flash was invoked through the OpenCode provider for bounded scaffolding,
  control-lifetime, and isolated Cut a Deal tasks. All tasks were stopped at the blocker.
  No child implementation was accepted or committed.
- Local scratch artifacts are retained under `.tmp/pr08/`: logs, the exact CI annotation,
  23 Oracle pins generated from the committed coverage bank, and the unfinished scaffolding
  patch. These artifacts are preparation, not completion evidence.

## Rules decisions for continuation

Control history should record effect timestamps, recipients, and permanent, end-of-turn, or
exact-source-object durations. Recompute from surviving effects, preserving the entry controller
as the fallback. A later effect giving the current controller control must still be recorded.
Only an actual controller transition changes summoning sickness or removes an object from
combat. A control effect gets a timestamp; a permanent does not get a new timestamp merely
because its controller changes (CR 613.7). Cover overlapping effects, source blink/phasing,
phased-out end-of-turn expiry, and obscured effects granted to an eliminated player.

The supplied handoff's tentative Kazuul note is incorrect: an attack on a planeswalker you
control also makes you the defending player. See the
[official Commander Masters release notes](https://media.wizards.com/2023/downloads/CMM_Release_Notes/EN_MTGCMM_ReleaseNotes_20230616.pdf).
Include that positive case and an attack on another player's planeswalker as a negative case.

After billing is resolved, finish scaffolding and implement one card per green commit, with
each shared primitive accompanying its first card. Follow the sole
[card-completion standard](../guides/card-modeling-and-testing.md), including current engine
and real-viewer evidence. Keep the PR draft until all 23 cards, local gates, CI, and review
findings are complete.
