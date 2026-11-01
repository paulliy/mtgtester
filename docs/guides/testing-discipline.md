# Testing and change discipline

- Add a focused regression for every engine/card correctness fix.
- Run the smallest relevant test first (`bun run test <path>`), then `bun run test`. For affected surfaces, also run what CI runs: `typecheck`, `typecheck:tests`, `lint`, `format:check`, and the web build; `test:card-gate` and `snapshots:check` for card changes; `test:e2e` and `test:e2e:setup` for viewer changes.
- CI has no provider key, so AI tests must be deterministic and must not make live model calls.
- E2E coverage: the audit smoke spec mocks network/AI; the Card Test Lab spec drives the real frontend and server. `player-game.spec.ts` plays a seeded game through the player board (land, cast, pass, abandon) against the committed Oracle fixture. Still missing: a full game to victory, combat from the player board, mobile interaction, reconnection, and imports.
- Do not silently rewrite historical SQLite data. Document derivations and migrations; legacy mana metrics intentionally display as unavailable rather than guessed.
- Keep the tester's server (`serve`) on local loopback. The table server (`serve:table`) is the one
  approved remote-sharing design: [ADR 0031](../decisions/0031-multiplayer-tables.md) and
  [table hosting](table-hosting.md) set what it must have before it leaves loopback.
- Put shared wire types in `packages/shared` and update every consumer for protocol changes.
- Combat sweeps compare search and static heuristic seats in the same seeded games. Treat excluded or failing games as reliability findings, not data to silently discard.
