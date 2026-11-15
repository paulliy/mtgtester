# Contributor instructions

Read `CLAUDE.md` or `CODEX.md` for repository-wide architecture and command guidance.

For every card-modeling change, the sole completion standard is
`docs/guides/card-modeling-and-testing.md`. Follow its pinned-Oracle, clause mapping, positive and
negative engine scenarios, normal cast/activation path, real-viewer evidence, and separate
gameplay-AI evidence requirements. `modeled: true`, snapshots, deck membership, aggregate
coverage, mocked UI checks, and written completion claims are not proof.

Unsupported mechanics must remain explicit with `unimplemented()` or `unsupportedCard()` until
implemented faithfully. Never substitute a mana cost, target, event, or `noOp` for unsupported
rules behavior.

## Performance and cost work (hill climbing)

Measure, change, compare, and keep only real wins. `bun run hill-climb` reports engine CPU, game
setup time, model calls and tokens per turn, and card coverage, and proves the benchmark games
played the same through their fingerprints. The full guide is `docs/guides/hill-climbing.md`.

1. On the base commit: `bun run hill-climb --repeat 3 --save <scratch>/before.json`.
2. Make one change.
3. `bun run hill-climb --repeat 3 --against <scratch>/before.json`.
4. Keep the change only if the table shows `IMPROVED` on the target metric, no `REGRESSED` row, and
   every fingerprint identical. For engine CPU, the exact `engine.work.*` counters (layer passes,
   state copies, mana planner states) prove a win the noisy timings cannot. `UNCHANGED` means the change is inside the noise: drop it.
5. Paste the table in the pull request, then bank the win with `bun run hill-climb --write-baseline`.

Never rewrite the baseline to make a regression pass. A change meant to alter play passes
`--allow-behavior-change` and says so in the pull request.
