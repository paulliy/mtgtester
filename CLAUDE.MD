# MTG Commander AI Simulator

Read [docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md)
in full before writing any code. It is the authoritative spec — do not start implementing
until you've read it. (The brief and this file historically referenced
`docs/project-brief.md`; the real filename is the link above. See
[docs/decisions/0001-foundations.md](docs/decisions/0001-foundations.md).)

**Current phase: Phase 2 — Engine core — implementation complete; awaiting phase-boundary
approval (and review of the Phase 2 scope cuts listed in
[docs/decisions/0003-engine-core.md](docs/decisions/0003-engine-core.md)). Phase 1's
live-import demonstration against four real deck URLs is still pending user-supplied URLs.**

## Model preference

- Phase 2: prefer Fable 5 for architecture/design steps, Opus 4.8 for routine implementation.

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
| `packages/server` | `@mtg/server` | Bun server: Gemini, SQLite, WebSocket, deck import      |
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
bun run dev:web     # Vite dev server (stub until Phase 4)

# Phase 1 deck pipeline (import → resolve → validate → snapshot):
bun run decks <deckUrlOrFile> [more...]   # Moxfield/Archidekt URL or plaintext file
bun run decks --no-save <...>             # validate only, skip SQLite
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

## Phase log

- **Phase 0 — Foundations** (complete): Bun-workspace monorepo; strict TS + ESLint/Prettier +
  Vitest + Playwright stub; shared types transcribed from the brief; reference docs fetched;
  Scryfall bulk cached. `typecheck` / `lint` / `test` green.
  See [docs/decisions/0001-foundations.md](docs/decisions/0001-foundations.md).
- **Phase 1 — Deck pipeline** (implementation complete): Moxfield/Archidekt live adapters +
  plaintext paste behind a `DeckSource` interface; Scryfall oracle-name resolution (strict then
  unambiguous-loose, never guesses); full §8.3 validation reporting _every_ problem; immutable
  snapshotting into `bun:sqlite` with a per-deck card cache; the `bun run decks` CLI. 37 tests
  green. See [docs/decisions/0002-deck-pipeline.md](docs/decisions/0002-deck-pipeline.md).
- **Phase 2 — Engine core** (implementation complete): generator-driven `Engine` behind
  `advance()`/`submit()` with forced-decision auto-resolve; identity-stable objects + stable
  `cardId`; seeded xoshiro128\*\* PRNG; full CR 500–514 turn structure; priority/APNAP per
  CR 117; the stack with trigger ordering, fizzling, countering; every §5.6 SBA; combat with
  first-strike step, trample/deathtouch/lifelink, 21-commander-damage; commander tax +
  CR 903.9a/b command-zone returns; London mulligans (free first); complete legal-action
  generation with engine auto-payment of mana; oracle-text interpreter that halts loudly on
  unmodeled cards (§6.3); `PlayerView` projection; scripted/random providers. Full 4-player
  random games play to a winner; 114 tests green. Scope cuts (menace, ward, protection, {X},
  modal, DFC, activated abilities, …) are listed for approval in
  [docs/decisions/0003-engine-core.md](docs/decisions/0003-engine-core.md).
