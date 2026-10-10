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
