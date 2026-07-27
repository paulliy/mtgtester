# MTG Commander AI Simulator

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md)
in full before writing any code. It is the authoritative spec — do not start implementing
until you've read it. (The brief and this file historically referenced
`docs/project-brief.md`; the real filename is the link above. See
[docs/decisions/0001-foundations.md](docs/decisions/0001-foundations.md).)

**Current phase: Phase 4 — Spectator UI — implementation complete; awaiting phase-boundary
approval.** The Phase 4 plan was adjusted against the state of the tree before implementing;
the six adjustments are recorded in
[docs/decisions/0012-spectator-ui.md](docs/decisions/0012-spectator-ui.md). The Phase 2 scope
cuts in [docs/decisions/0003-engine-core.md](docs/decisions/0003-engine-core.md) are still
outstanding for review.

**Card coverage is the live constraint, and the strategy for it changed — read
[docs/decisions/0009-supported-pool-decks.md](docs/decisions/0009-supported-pool-decks.md)
before doing coverage work.** Because the engine halts on any unmodeled card, deck playability
is all-or-nothing, and incremental coverage does not converge (94% of unparsed rules lines
occur on exactly one card). Playable decks are therefore generated from the engine-supported
pool (`bun run pool --play`); simulating a *specific* real decklist is a per-deck effort, not a
coverage threshold. `bun run coverage` remains the instrument that ranks which mechanics to
build next.

### Task Offloading Rules (`agy`)

You have access to the `antigravity_delegate` MCP tool. Follow these guidelines for task delegation:

- **Delegate to `agy` when:**
  - **Easy/Simple Tasks:** Generating standard boilerplate, writing simple scripts, adding straightforward CRUD functions, or making simple/repetitive code edits.
  - **Research & Planning:** Gathering information, analyzing codebase structure, researching external libraries, or drafting architectural plans.

- **Handle directly in Claude Code when:**
  - Tasks involve complex business logic, subtle bugs, or deep architectural decision-making.
  - Multi-step, highly context-sensitive refactoring across interconnected systems.

- **Execution guidelines:**
  - Use `mode: "plan"` for research and exploratory planning tasks.
  - Use `mode: "accept-edits"` for simple coding and boilerplate generation tasks.
  - Briefly verify or test the output from `agy` once the delegate call finishes.

## Key constraints (from the brief)

- Engine is authoritative on legality; the AI only chooses among engine-generated options (§1.2).
- No AI call when there's only one legal action (§5.1) — the biggest cost lever.
- Every game is fully seeded; **no `Math.random()` in the engine** (§4, §5.9).
- The AI must never see hidden state — it receives a `PlayerView`, never `GameState` (§7.1).
- Work in the phases defined in §14; **stop at each phase boundary for approval.**

## Repository layout

| Path              | Package       | Role                                                    |
| ----------------- | ------------- | ------------------------------------------------------- |
| `packages/shared` | `@mtg/shared` | Types shared across engine/server/web (no logic)        |
| `packages/engine` | `@mtg/engine` | Pure TS rules engine — no I/O, no network, no framework |
| `packages/server` | `@mtg/server` | Bun server: AI provider, SQLite, WebSocket, deck import |
| `apps/web`        | `@mtg/web`    | Vue 3 spectator UI                                      |
| `docs/rules`      | —             | Reference material (CR, commander rules, banned list)   |
| `docs/decisions`  | —             | ADRs for significant choices                            |
| `data/`           | —             | Scryfall bulk data + card cache (gitignored)            |

## How to run

```bash
bun install
bun run typecheck   # tsc --build across all packages (full strict)
bun run lint        # eslint (flat config)
bun run test        # vitest

# Watch a game — server owns the engine and the API key, web app is a view; one command starts both:
bun run dev                          # server on :3001 + Vue spectator UI on :5173
# ...or separately, e.g. to restart just one:
bun run serve [--port N] [--no-db]   # HTTP + /ws on :3001; GET /health for a liveness check
bun run dev:web                      # Vue spectator UI on :5173, proxying /ws to the server

# Phase 1 deck pipeline (import → resolve → validate → snapshot):
bun run decks <deckUrlOrFile> [more...]   # Moxfield/Archidekt URL or plaintext file
bun run decks --no-save <...>             # validate only, skip SQLite

# Playable decks from the engine-supported card pool (ADR 0009):
bun run pool                              # what the engine can currently play with
bun run pool --commanders                 # every commander the pool supports
bun run pool --play [--seed S]            # build 4 decks and play a full game
bun run pool --write [--seed S]           # commit the 4 decks as fixtures

# Real-deck model coverage — the mechanics backlog:
bun run coverage                          # per-deck + aggregate, ranked blocking mechanics
bun run coverage --json                   # machine-diffable
bun run coverage:snapshot [url...]        # refresh/add deck fixtures from live URLs
```

## Reference data

- `docs/rules/comprehensive-rules.txt` — Wizards Comprehensive Rules, effective 2026-06-19 (verbatim).
- `docs/rules/commander-rules.md` — mtgcommander.net construction & play rules.
- `docs/rules/commander-banned-list.md` — mtgcommander.net banned list (44 individual cards + category bans).
- `data/scryfall-oracle-cards.json` — Scryfall `oracle-cards` bulk (~180 MB, gitignored; see `data/README.md`).
- **Never send the Comprehensive Rules to Gemini** — it is a reference for implementing the
  engine, not runtime context (§7.4). The compact rules primer (Phase 3) is separate.

## Conventions

- TypeScript strict everywhere (`tsconfig.base.json`), plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — use `import type` for type-only imports.
- Packages resolve each other **by source** (`exports` → `./src/index.ts`); no build step to run
  code. `dist/` is a typecheck byproduct only and is gitignored.
- `TODO(phase-N)` markers flag stubs to be fleshed out in a later phase.
