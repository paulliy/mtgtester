# MTG Tester

MTG Tester is a local, rules-driven **Magic: The Gathering Commander** simulator. It runs seeded four-player games through a deterministic TypeScript engine, as a spectator experience or with one human player against automated opponents.

The engine is authoritative: it produces legal actions. Humans, the heuristic bot, and OpenAI-compatible providers only choose from those actions; they do not adjudicate Magic rules.

> **Status:** Functional for supported cards, but not a general-purpose Commander simulator. Card coverage remains incomplete; audited unsupported behavior is kept out of the playable pool.

## Implemented capabilities

- Seeded four-player Commander games with priority, stack resolution, combat, commander damage, state-based actions, continuous effects, and player/spectator projections.
- Spectator and single-player modes, replay controls, local history, batches, statistics, and a Vue web application.
- Generated supported-pool decks; Moxfield, Archidekt, and plaintext imports with validation and model-coverage reporting.
- A seeded heuristic bot, optional OpenAI-compatible strategist/tactician provider, and bounded combat search with a reproducible A/B sweep harness.
- A card template/override system, real-deck fixtures, and coverage reports for planning rules support.

## Repository layout

```
apps/web/          Vue 3 player and spectator UI
packages/shared/   Cross-package game, protocol, view, and persistence types
packages/engine/   Pure deterministic rules engine; no I/O or network access
packages/bot/      Seeded heuristic decision provider and combat search
packages/server/   Bun HTTP/WebSocket server, AI, decks, SQLite, and batches
docs/decisions/    Architecture decision records
docs/plans/        Card-coverage and product work plans
docs/reviews/      Dated review, remediation, and browser-trial evidence
data/              Gitignored Scryfall bulk data and local application data
```

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- Scryfall Oracle bulk data for card import and coverage workflows; see [data/README.md](data/README.md)
- A provider key only for LLM games. The random and heuristic-bot paths do not need one.

## Get started

```powershell
bun install
Copy-Item .env.example .env   # optional for LLM games; add a supported provider key
bun run typecheck
bun run lint
bun run test
bun run dev
```

`bun run dev` starts the server at `http://localhost:3001` and the UI at `http://localhost:5173`.

```powershell
bun run serve                 # server only
bun run dev:web               # web UI only
bun run pool --play --seed s  # generate and play four supported decks
bun run decks <url-or-file>   # import and validate a deck
bun run coverage              # real-deck model coverage
bun run staples               # coverage of 200 EDH staples
bun run combat-sweep --games 120 --seed s
bun run test:e2e              # Playwright browser tests
```

For the full command reference and contributor guidance, see [CLAUDE.MD](CLAUDE.MD).

## Current limitations

- **Rules and cards:** only cards the engine can model are safe to simulate. Original precon fixtures have the strongest coverage; community decks still expose major missing mechanics. Use `bun run coverage` and `bun run staples` as the source of truth.
- **Product follow-up:** narrow-screen gameplay, failed-import draft preservation, human-abandon confirmation, and statistics presentation/history need more work.
- **Metrics:** invalid legacy mana rates now display as unavailable; versioned end-of-turn mana observations are not yet implemented.

## Documentation map

- [ADRs](docs/decisions/) are the source of truth for major design choices. Start with [card templates](docs/decisions/0025-card-template-layer.md) and [bounded combat search](docs/decisions/0024-bounded-combat-search.md).
- [Card coverage plans](docs/plans/edh-staple-coverage.md) and [post-Tier-3 work](docs/plans/post-tier3-card-coverage.md) describe the modeling backlog.
- The [project review](docs/reviews/project-review-2026-09-04.md), [remediation](docs/reviews/audit-remediation-2026-09-05.md), and [browser trial](docs/reviews/browser-experience-2026-09-05.md) contain the latest evidence-backed quality state.
- [Rules reference](docs/rules/) is implementation material and is never sent to an AI provider.

## Privacy

When configured, AI requests go to the selected OpenAI-compatible provider and may include the acting player's legal decision context and visible game state. The engine must never expose hidden game state to a player or model, and it never sends the Comprehensive Rules as prompt context.
