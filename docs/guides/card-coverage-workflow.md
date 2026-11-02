# Card model and coverage workflow

## Completion standard

The canonical completion standard is [Modeling a Card and Testing It](card-modeling-and-testing.md). Follow its clause-to-test manifest, offline Oracle fixture, engine-path, real-viewer evidence, and separate gameplay-AI requirements. No other checklist may weaken that standard.

## Implementation layers

- Use the template layer in `packages/engine/src/cards/` first: reusable grammar, selectors, values, effects, conditions, and rule statics before bespoke overrides.
- Overrides live in `packages/engine/src/cards/overrides/`; update their handled-lines deliberately.
- Interpretation and override snapshot fixtures change only on purpose. Regenerate with `bun run scripts/snapshot-interpret-defs.ts` or `bun run scripts/snapshot-override-defs.ts`, review the diff, then confirm with `bun run snapshots:check`.
- A change that adds a `LegalAction.data` key registers it in `packages/shared/src/action-data-keys.ts`; `packages/server/src/cards/action-data-keys.test.ts` fails on an unregistered key or value type.

## Backlog

- [EDH staple coverage](../plans/edh-staple-coverage.md)
- [EDHREC ready list](../plans/edhrec-ready-list.md): the cards filling 95% of real Commander deck slots that are modeled or one unparsed line away. Regenerate with `bun run edhrec:ready-list` after a parser change; refreeze the ranking with `bun run edhrec:fetch`.
- [Post-Tier-3 residue](../plans/post-tier3-card-coverage.md)

Precon coverage is strongest. Community fixtures and the EDH-staples report expose the significant remaining gaps. Use `bun run coverage`, `bun run staples`, and `bun run test:implemented`.
