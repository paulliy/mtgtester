# MTG Tester contributor guide

## Start here

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md) before changing game behavior. It is the original product and architecture brief, frozen as the v1 spec; where it disagrees with an ADR, the ADR wins. The ADRs most relevant to current work are [0025 card templates](docs/decisions/0025-card-template-layer.md), [0024 bounded combat search](docs/decisions/0024-bounded-combat-search.md), and, for the LLM provider, [0026](docs/decisions/0026-ai-benchmark-and-strategy-context.md) through [0028](docs/decisions/0028-ai-counterfactual-routing-cache-and-promotion.md). [docs/reviews/](docs/reviews/) holds the evidence behind the current quality state.

Current work is organized around card coverage, rules correctness, simulation reliability, and product polish. The numbered phase plans in `docs/plans/` are historical records.

## Current state

This Bun/TypeScript monorepo contains a working local Commander simulator:

- `packages/engine`: authoritative deterministic rules engine.
- `packages/bot`: seeded heuristic decision provider and bounded combat search.
- `packages/server`: human/bot/LLM orchestration, deck import, SQLite, batches, AI benchmarks, and HTTP/WebSocket APIs.
- `apps/web`: Vue 3 spectator and single-player UI, including the Card Test Lab.
- `packages/shared`: cross-package game, protocol, view, database, and batch types.

Spectator play, one-human-versus-three-opponent play, replay, supported-pool decks, imports, batches, and statistics are implemented. The optional LLM provider is OpenAI-compatible (configured through `.env.example`); random and heuristic bot providers do not need an API key.

Known residual risks from the last audit are listed in [audit remediation](docs/reviews/audit-remediation-2026-09-05.md). The browser-trial payment regression is covered by focused normal-path tests and by `scripts/reproduce-browser-payment.ts`, which reuses the original derived seed. The original generated deck configuration was not captured, so do not describe that script as an exact full-game replay. See [browser trial](docs/reviews/browser-experience-2026-09-05.md).

## Rules-engine constraints

- The engine computes every legal action. Providers choose from its options; they never decide legality.
- Auto-resolve only mathematically forced actions. Strategic filtering belongs in provider policy or explicit player preference, not legal-action generation.
- Games are fully seeded. Do not use `Math.random()` in engine or bot paths; use the project PRNG/RNG.
- Providers receive a `PlayerView`, never `GameState`. Protect hidden information in UI, logs, events, action presentation, and AI context.
- Preserve deterministic replay: timing, wall clocks, and provider/network behavior must not alter fixed-seed engine outcomes.
- Prefer `unimplemented()` to an approximate card implementation. A modeled card must faithfully implement the semantics it claims.
- Coverage is evidence, not a general Commander-support claim. Add behavior tests and run coverage tools before reporting a card as modeled.

## Card model and coverage

The canonical completion standard is
[Modeling a Card and Testing It](docs/guides/card-modeling-and-testing.md). Follow its
clause-to-test manifest, offline Oracle fixture, engine-path, real-viewer evidence, and separate
gameplay-AI requirements. No other checklist may weaken that standard.

Use the template layer in `packages/engine/src/cards/` first: reusable grammar, selectors, values, effects, conditions, and rule statics before bespoke overrides. Overrides live in `packages/engine/src/cards/overrides/`; update their handled-lines deliberately. The interpretation and override snapshot fixtures also change only on purpose: regenerate them with `bun run scripts/snapshot-interpret-defs.ts` or `bun run scripts/snapshot-override-defs.ts`, review the diff, and confirm with `bun run snapshots:check`.

The coverage backlog is clustered by shared primitives:

- [EDH staple coverage](docs/plans/edh-staple-coverage.md)
- [Post-Tier-3 residue](docs/plans/post-tier3-card-coverage.md)

Precon coverage is strongest. Community fixtures and the EDH-staples report expose the significant remaining gaps. Use `bun run coverage`, `bun run staples`, and `bun run test:implemented`.

## Commands

```powershell
bun install
Copy-Item .env.example .env             # provider key only for LLM games

bun run typecheck                       # production TypeScript + Vue templates
bun run typecheck:tests                 # engine/server test type projects
bun run lint
bun run format:check
bun run --cwd apps/web build            # web build
bun run test                            # full Vitest suite
bun run test <path-or-filter>           # one test file or pattern
bun run test:card-gate                  # offline card verification gate
bun run snapshots:check                 # interpretation/override snapshot drift
bun run test:e2e                        # Playwright

bun run dev                             # server :3001 and UI :5173
bun run serve [--port N] [--no-db]
bun run dev:web

bun run decks <deckUrlOrFile> [more...]
bun run decks --no-save <deckUrlOrFile>
bun run pool [--commanders]
bun run pool --play [--seed S] [--ai]
bun run pool --write [--seed S]
bun run play-decks <deckA> <deckB> ...

bun run retag                           # dry run
bun run retag --write [--force]
bun run coverage [--json]
bun run staples
bun run coverage:complete               # coverage + staples over the full fixture population
bun run coverage:snapshot [url...]
bun run snapshot:oracle
bun run modelled-cards
bun run combat-sweep [--games N] [--seed S] [--json out.json]
bun run ai-bench                        # AI benchmark harness (ADR 0026)
bun run agent-client [--seat P1] [--seed S] [--port N] [--provider random|ai]
```

If the production typecheck runs out of memory, set `NODE_OPTIONS=--max-old-space-size=8192` for that command.

Combat sweeps compare search and static heuristic seats in the same seeded games. Treat excluded/failing games as reliability findings, not data to silently discard.

`agent-client` plays one seat over the running server's `/ws` as a JSON process: NDJSON events on
stdout, one reply line per decision on stdin, diagnostics on stderr. It is a client of the existing
single-player flow, not another way to run a game — see
[the JSON agent client](docs/guides/json-agent-client.md).

## Testing and change discipline

- Add a focused regression for every engine/card correctness fix.
- Run the smallest relevant test first (`bun run test <path>`), then `bun run test`. For affected surfaces, also run what CI runs: `typecheck`, `typecheck:tests`, `lint`, `format:check`, and the web build; `test:card-gate` and `snapshots:check` for card changes; `test:e2e` for viewer changes.
- CI has no provider key, so AI tests must be deterministic and must not make live model calls.
- The audit smoke spec mocks network/AI; the Card Test Lab spec drives the real frontend and server. Complete human play, mobile interaction, reconnection, and imports still lack end-to-end coverage.
- Do not silently rewrite historical SQLite data. Document derivations and migrations; legacy mana metrics intentionally display as unavailable rather than guessed.
- Keep the server on local loopback unless an authenticated remote-sharing design is explicitly approved.
- Keep `packages/engine` free of I/O, network access, UI logic, and provider policy. Put shared wire types in `packages/shared` and update every consumer for protocol changes.

## Reference data

- `docs/rules/comprehensive-rules.txt` is the local Comprehensive Rules reference.
- `docs/rules/commander-rules.md` and `docs/rules/commander-banned-list.md` support Commander validation.
- `data/scryfall-oracle-cards.json` is gitignored; see [data/README.md](data/README.md).
- Never send the Comprehensive Rules to an AI provider; they are implementation reference, not runtime prompt context.
