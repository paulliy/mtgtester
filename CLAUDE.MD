# MTG Commander AI Simulator

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md)
in full before writing any code. It is the original v1 spec — do not start implementing
until you've read it. (The brief and this file historically referenced
`docs/project-brief.md`; the real filename is the link above. See
[docs/decisions/0001-foundations.md](docs/decisions/0001-foundations.md).)

**v1 shipped and the project has moved past it.** The brief's Phase 0-5 plan is done;
phases 6-10 (single-player mode, direct player controls, action animations, the
player-experience overhaul, and a planned deck-testing lab) exist only as ADRs and plan
docs under `docs/decisions/` and `docs/plans/` — read `docs/decisions/0021-player-experience-overhaul.md`
(most recent) for where things currently stand. Where this file or the brief conflicts
with a numbered ADR, the ADR wins.

## Current architecture at a glance

- **Packages:** `packages/shared` (types shared by engine/server/web) →
  `packages/engine` (pure rules engine, no I/O) → `packages/server` (Bun HTTP+WS server:
  AI orchestration in `src/ai/`, deck import in `src/decks/`, card pool/coverage in
  `src/cards/`, SQLite in `src/db/`, match orchestration in `src/match/`, CLI entry
  points in `src/cli/`) → `apps/web` (Vue 3 spectator **and** player UI).
- **AI provider:** OpenAI-compatible client (`packages/server/src/ai/client.ts`), not
  `@google/genai`. **OpenRouter is the default provider**, auto-detected from whichever
  `*_API_KEY` is set (Groq, Gemini, DeepSeek, and OpenAI are also supported presets) — see
  `packages/server/src/ai/config.ts` and `.env.example`, and
  `docs/decisions/0011-openai-compatible-provider.md`.
- **Two-tier AI: strategist + tactician.** `packages/server/src/ai/strategy-coordinator.ts`
  runs a **strategist** call once per active turn, on its own request queue, prefetched
  asynchronously at the previous turn boundary so it overlaps untap/upkeep/draw and never
  blocks a tactical decision. Each **tactician** decision (the per-menu-pick call) consults
  the strategist's latest plan if one has landed, and re-plans once if an opponent
  intervenes. See `docs/decisions/0016-two-tier-ai-planning.md` and
  `docs/decisions/0021-player-experience-overhaul.md` §1.
- **Game modes:** spectator (four AI seats) and single-player (one human seat + three AI,
  `docs/decisions/0018-single-player-mode.md`) are both live, chosen from the web UI's
  `SetupView.vue`. Decks per seat are either generated from the engine-supported pool
  (`bun run pool`, default and always-playable) or imported from Moxfield/Archidekt/plaintext
  (`bun run decks`) — see `packages/shared/src/protocol.ts`'s `SeatSource`/`GameMode` types.


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

## How to run

```bash
bun install
cp .env.example .env   # then set exactly one provider key, e.g. OPENROUTER_API_KEY
bun run typecheck       # tsc --build across all packages (full strict)
bun run typecheck:clean # tsc --build --clean
bun run lint             # eslint (flat config)
bun run lint:fix
bun run format           # prettier --write .
bun run format:check
bun run test             # vitest run
bun run test:watch       # vitest (watch mode)
bun run build            # tsc --build

# Watch a game — server owns the engine and the AI provider key, web app is a view; one command starts both:
bun run dev                          # server on :3001 + Vue spectator/player UI on :5173
# ...or separately, e.g. to restart just one:
bun run serve [--port N] [--no-db]   # HTTP + /ws on :3001; GET /health for a liveness check
bun run dev:web                      # Vue UI on :5173, proxying /ws to the server
# Game mode (spectator vs. single-player) and deck source (pool vs. import) are chosen
# in the web UI's setup screen, not via CLI flags — see SetupView.vue.

# Deck pipeline (import → resolve → validate → snapshot):
bun run decks <deckUrlOrFile> [more...]   # Moxfield/Archidekt URL or plaintext file
bun run decks --no-save <...>             # validate only, skip SQLite

# Archetype tags are inferred at import (ADR 0022); backfill older decks with:
bun run retag                             # dry run — prints changes, writes nothing
bun run retag --write [--force]           # apply; --force also re-scores heuristic tags.
                                          # A 'manual' tag is never touched. Note this regroups
                                          # the stats "who beats me" view, which keys on the tag.

# Playable decks from the engine-supported card pool (ADR 0009):
bun run pool                              # what the engine can currently play with
bun run pool --commanders                 # every commander the pool supports
bun run pool --play [--seed S] [--ai]     # build 4 decks and play a full game (random or AI-driven)
bun run pool --write [--seed S]           # commit the 4 decks as fixtures

# Play specific curated decklists against each other (fixtures or URLs):
bun run play-decks <deckA> <deckB> ...

# Real-deck model coverage — the mechanics backlog:
bun run coverage                          # per-deck + aggregate, ranked blocking mechanics
bun run coverage --json                   # machine-diffable
bun run coverage:snapshot [url...]        # refresh/add deck fixtures from live URLs
bun run snapshot:oracle                   # per-deck OracleCard JSON fixtures for CI-safe engine coverage tests
bun run modelled-cards                    # list cards the engine currently models
```

## Reference data

- `docs/rules/comprehensive-rules.txt` — Wizards Comprehensive Rules, effective 2026-06-19 (verbatim).
- `docs/rules/commander-rules.md` — mtgcommander.net construction & play rules.
- `docs/rules/commander-banned-list.md` — mtgcommander.net banned list (44 individual cards + category bans).
- `data/scryfall-oracle-cards.json` — Scryfall `oracle-cards` bulk (~180 MB, gitignored; see `data/README.md`).
- **Never send the Comprehensive Rules to the AI provider** — it is a reference for
  implementing the engine, not runtime context (§7.4). The compact rules primer is separate.

## Conventions

- TypeScript strict everywhere (`tsconfig.base.json`), plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — use `import type` for type-only imports.
- Packages resolve each other **by source** (`exports` → `./src/index.ts`); no build step to run
  code. `dist/` is a typecheck byproduct only and is gitignored.
- `TODO(phase-N)` markers flag stubs to be fleshed out in a later phase.
