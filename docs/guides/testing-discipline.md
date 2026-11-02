# Testing and change discipline

- Add a focused regression for every engine/card correctness fix.
- Run the smallest relevant test first (`bun run test <path>`), then `bun run test`. For affected surfaces, also run what CI runs: `typecheck`, `typecheck:tests`, `lint`, `format:check`, and the web build; `test:card-gate` and `snapshots:check` for card changes; `test:e2e` and `test:e2e:setup` for viewer changes.
- CI has no provider key, so AI tests must be deterministic and must not make live model calls.
- CI minutes ([ADR 0036](../decisions/0036-ci-minutes-budget.md)): each pull request push runs only
  the fast checks. Run the local checks above before pushing, then pick the slow suites the change
  needs with labels once the branch is ready: `ci:engine` (full suite, collection checks, IR
  mutation), `ci:lab`, `ci:setup` and `ci:table` (the Playwright suites), `ci:e2e` (all three) or
  `ci:full` (everything). `CI / Gate` blocks merging a ready pull request until at least one suite is
  picked and every picked suite has passed; the nightly run covers the rest, so use `ci:full` when
  unsure. Remove the labels while pushing further fixes you do not need verified yet. `ci:fuzz` adds
  the advisory fuzz job to an engine pull request.
- E2E coverage: the audit smoke spec mocks network/AI; the Card Test Lab spec drives the real frontend and server. `player-game.spec.ts` plays a seeded game through the player board (land, cast, pass, abandon) against the committed Oracle fixture. Still missing: a full game to victory, combat from the player board, mobile interaction, reconnection, and imports.
- Do not silently rewrite historical SQLite data. Document derivations and migrations; legacy mana metrics intentionally display as unavailable rather than guessed.
- Keep the tester's server (`serve`) on local loopback. The table server (`serve:table`) is the one
  approved remote-sharing design: [ADR 0031](../decisions/0031-multiplayer-tables.md) and
  [table hosting](table-hosting.md) set what it must have before it leaves loopback.
- Put shared wire types in `packages/shared` and update every consumer for protocol changes.
- Combat sweeps compare search and static heuristic seats in the same seeded games. Treat excluded or failing games as reliability findings, not data to silently discard.
