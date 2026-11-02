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
- Engine speed on big boards: in a fuzz game with 56 to 71 permanents (Council of Reeds copying itself), one engine step takes 4 to 13 seconds, and the state invariants double that. Fuzz's 300-second game clock holds, but a table with such a board would wait.
- The stateful mana planner still tries every order of activations when only a dynamic source could make a needed color (Exotic Orchard for {1}{W} with no white opposing land), and halts the game past 2,048 states. Its bounds prune too few sources and colors no source can make.
- The weekly bulk-data job needs its pin: set the repository variables `SCRYFALL_BULK_URL` and `SCRYFALL_BULK_SHA256`, then commit the baseline from `bun run bulk-smoke --write` over that file (see `data/README.md`). Until then the job fails and says so; it has not run against real data.
- Bun 1.3.14, the pinned version, never settles `server.stop()` once a server-side WebSocket has closed. The table server waits a second for it and goes on, since the port closes at once; upgrading Bun removes the wait. A cost of "sacrifice ten" asks for nine one-at-a-time picks even when exactly ten candidates exist ([pilot review](../reviews/card-authoring-pilot-2026-10-31.md), finding 9).
- Tables: a manual LAN game across two machines with `--insecure-lan` is still owed, and the served table bundle has not had its own security review. See [table server security](../reviews/table-server-security-2026-10-29.md).
- Browser-trial payment regression: covered by focused normal-path tests and `scripts/reproduce-browser-payment.ts`, which reuses the original derived seed. The original generated deck configuration was not captured, so do not describe that script as an exact full-game replay. See [browser trial](../reviews/browser-experience-2026-09-05.md).
