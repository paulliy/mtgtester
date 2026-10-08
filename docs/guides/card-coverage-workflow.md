# Card model and coverage workflow

## Completion standard

The canonical completion standard is [Modeling a Card and Testing It](card-modeling-and-testing.md). Follow its clause-to-test manifest, offline Oracle fixture, engine-path, real-viewer evidence, and separate gameplay-AI requirements. No other checklist may weaken that standard.

## Implementation layers

- Use the template layer in `packages/engine/src/cards/` first: reusable grammar, selectors, values, effects, conditions, and rule statics before bespoke overrides.
- Overrides live in `packages/engine/src/cards/overrides/`; update their handled-lines deliberately.
- Interpretation and override snapshot fixtures change only on purpose. Regenerate with `bun run scripts/snapshot-interpret-defs.ts` or `bun run scripts/snapshot-override-defs.ts`, review the diff, then confirm with `bun run snapshots:check`.

## Backlog

- [EDH staple coverage](../plans/edh-staple-coverage.md)
- [Post-Tier-3 residue](../plans/post-tier3-card-coverage.md)

Precon coverage is strongest. Community fixtures and the EDH-staples report expose the significant remaining gaps. Use `bun run coverage`, `bun run staples`, and `bun run test:implemented`.
