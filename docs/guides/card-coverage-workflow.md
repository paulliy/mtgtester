# Card model and coverage workflow

## Completion standard

The canonical completion standard is [Modeling a Card and Testing It](card-modeling-and-testing.md). Follow its clause-to-test manifest, offline Oracle fixture, engine-path, real-viewer evidence, and separate gameplay-AI requirements. No other checklist may weaken that standard.

## Implementation layers

- Use the template layer in `packages/engine/src/cards/` first: reusable grammar, selectors, values, effects, conditions, and rule statics before bespoke overrides.
- Overrides live in `packages/engine/src/cards/overrides/`; update their handled-lines deliberately.
- Interpretation and override snapshot fixtures change only on purpose. Regenerate with `bun run scripts/snapshot-interpret-defs.ts` or `bun run scripts/snapshot-override-defs.ts`, review the diff, then confirm with `bun run snapshots:check`. The interpretation script writes three nets (ADR 0038): the Ur-Dragon fixture, the full pinned fixture, and the outcomes of the one-line probe corpus, whose diff is a coverage change's measured yield. A new or changed Card Test Lab scenario also needs `bun run lab:index --write` (ADR 0037).
- A change that adds a `LegalAction.data` key registers it in `packages/shared/src/action-data-keys.ts`; `packages/server/src/cards/action-data-keys.test.ts` fails on an unregistered key or value type.

## Backlog

- [EDH staple coverage](../plans/edh-staple-coverage.md)
- [EDHREC coverage modelling plan](../plans/edhrec-coverage-modelling.md): how the 15 unmodeled staples and the 5,917 one-line cards are sequenced, and the verification bar for each rank band.
- [EDHREC triage](../plans/edhrec-triage.md): the grammar slot that fails in each one-line card, grouped by phrase; the work queue for the coverage plan. Regenerate with `bun run edhrec:triage` after a parser change (`snapshots:check` fails until you do).
- [Deck coverage](../plans/deck-coverage.md): how many whole decks play start to finish (every card modeled), how many would with provisional cards from the compiled-card review queue, and the cards that would unblock the most decks. Regenerate with `bun run deck-coverage` after a card or parser change (`snapshots:check` fails until you do). The EDHREC average-deck population needs network and the Scryfall bank, once: `bun run edhrec:fetch --average-decks 200`, then `bun run deck-coverage --pin`, then `bun run deck-coverage`, and commit the three fixtures.
- [EDHREC ready list](../plans/edhrec-ready-list.md): the cards filling 95% of real Commander deck slots that are modeled or one unparsed line away. Regenerate with `bun run edhrec:ready-list` after a parser change; refreeze the ranking with `bun run edhrec:fetch`.
- [Post-Tier-3 residue](../plans/post-tier3-card-coverage.md)

Precon coverage is strongest. Community fixtures and the EDH-staples report expose the significant remaining gaps. Use `bun run coverage`, `bun run staples`, and `bun run test:implemented`.
