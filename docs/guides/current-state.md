# Current state

This Bun/TypeScript monorepo contains a working local Commander simulator:

- `packages/engine`: authoritative deterministic rules engine.
- `packages/bot`: seeded heuristic decision provider and bounded combat search.
- `packages/server`: human/bot/LLM orchestration, deck import, SQLite, batches, AI benchmarks, and HTTP/WebSocket APIs. `serve:table` is the separate table server ([ADR 0031](../decisions/0031-multiplayer-tables.md)): one worker per game, clocks and fallback bots, and the exposure rules in [table hosting](table-hosting.md).
- `apps/web`: Vue 3 spectator and single-player UI, including the Card Test Lab. `--mode table` builds the table app (lobby, table board, post-game replay) into `apps/web/dist-table`, a bundle with no tester views.
- `packages/shared`: cross-package game, protocol, view, database, and batch types.

Spectator play, one-human-versus-three-opponent play, replay, supported-pool decks, imports, batches, and statistics are implemented. Tables for two to four people with bots in the empty seats are implemented end to end (multiplayer plan M1–M6); `bun run test:e2e:table` plays one in two browser contexts against the built bundle, and `bun run dev --table` runs the table app with a dev server. The optional LLM provider is OpenAI-compatible (configured through `.env.example`); random and heuristic bot providers do not need an API key.

## Known residual risks

- Full list: [audit remediation](../reviews/audit-remediation-2026-09-05.md).
- Engine speed on big boards: the 71-permanent fuzz board (Council of Reeds copying itself, `fuzz-2`) now plays in 23 seconds instead of 100, and its slowest step takes 1.4 seconds instead of 5.4 ([big-board review](../reviews/big-board-and-tables-2026-11-04.md)). What is left is mostly the layer-cache digest: every characteristics query still reads the whole board, so a loop over the board that asks once per permanent is quadratic (`sbaPass`, `triggersOf`).
- The stateful mana planner no longer exhausts its budget over a color only a dynamic source could make, or over a life cost the payer cannot meet. It is still exponential in the number of distinct sources when no bound can disprove a payment, and halts the game past 2,048 states.
- The weekly bulk-data job has its baseline (`bulk-population.json`, for `oracle-cards-20261103220204.jsonl.gz`) and passed locally against that file. The repository variables `SCRYFALL_BULK_URL` and `SCRYFALL_BULK_SHA256` (values in `data/README.md`) still have to be set before it can run in CI. That bank also differs from the pinned coverage fixture on 133 of its 1,031 cards; refreshing the fixture is a separate change (`coverage:rebaseline`).
- Tables: a LAN game with `--insecure-lan` has been played between two network namespaces on one machine, and the served bundle has been reviewed ([big-board review](../reviews/big-board-and-tables-2026-11-04.md)). A game between two physical machines, with real browsers on a real network, is still worth one manual run. Players' browsers fetch card images and token art from Scryfall directly.
- Browser-trial payment regression: covered by focused normal-path tests and `scripts/reproduce-browser-payment.ts`, which reuses the original derived seed. The original generated deck configuration was not captured, so do not describe that script as an exact full-game replay. See [browser trial](../reviews/browser-experience-2026-09-05.md).
