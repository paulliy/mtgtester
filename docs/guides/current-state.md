# Current state

This Bun/TypeScript monorepo contains a working local Commander simulator:

- `packages/engine`: authoritative deterministic rules engine.
- `packages/bot`: seeded heuristic decision provider and bounded combat search.
- `packages/server`: human/bot/LLM orchestration, deck import, SQLite, batches, AI benchmarks, and HTTP/WebSocket APIs.
- `apps/web`: Vue 3 spectator and single-player UI, including the Card Test Lab.
- `packages/shared`: cross-package game, protocol, view, database, and batch types.

Spectator play, one-human-versus-three-opponent play, replay, supported-pool decks, imports, batches, and statistics are implemented. The optional LLM provider is OpenAI-compatible (configured through `.env.example`); random and heuristic bot providers do not need an API key.

## Known residual risks

- Full list: [audit remediation](../reviews/audit-remediation-2026-09-05.md).
- Browser-trial payment regression: covered by focused normal-path tests and `scripts/reproduce-browser-payment.ts`, which reuses the original derived seed. The original generated deck configuration was not captured, so do not describe that script as an exact full-game replay. See [browser trial](../reviews/browser-experience-2026-09-05.md).
