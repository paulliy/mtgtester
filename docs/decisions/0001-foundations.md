# 0001 — Phase 0 Foundations

- **Status:** Accepted
- **Date:** 2026-07-23
- **Phase:** 0 — Foundations (brief §14.1)

## Context

Phase 0 establishes the monorepo, tooling, shared types, reference documentation, and the
Scryfall card data that later phases build on. The guiding architectural constraint (brief
§1.2) is the engine/AI split: a deterministic TypeScript engine is authoritative on all
rules and generates every legal action; the AI only chooses among them.

## Decisions

1. **Monorepo on Bun workspaces**, rooted at the existing repo (`mtgtester/`). Packages:
   `@mtg/shared`, `@mtg/engine`, `@mtg/server`, `@mtg/web`.
2. **Source-based package resolution** — each package's `exports` points at `./src/index.ts`,
   so Bun, Vite, and Vitest run directly from source with no build step. Cross-package
   typechecking uses TypeScript **composite project references** driven by `tsc --build`;
   emitted `dist/` output is a typecheck byproduct only (gitignored).
3. **Strict TypeScript beyond `strict`** — `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
   `verbatimModuleSyntax`, `isolatedModules`. A rules-fidelity engine lives or dies on
   index/nullability safety, so the extra rigor is worth the friction.
4. **`shared/` carries real Phase-0 content** (the core types transcribed from the brief);
   `engine`/`server` are folder scaffolds with placeholders, and `web` is a minimal Vue+Vite
   stub. No engine/AI/UI logic is implemented in Phase 0.
5. **Reference docs fetched as canonical text** (user decision): the Comprehensive Rules as a
   verbatim `.txt` from Wizards (effective 2026-06-19), and the Commander rules + banned list
   **deterministically extracted** from mtgcommander.net HTML via `scratchpad/extract.mjs`
   rather than model-summarized (fidelity matters for validation). The pre-existing PDFs/DOCX
   in `docs/rules/` were left untouched.
6. **Scryfall `oracle-cards` bulk downloaded now** (user decision), gitignored (~180 MB).

## Divergences from the brief (flagged per §14.2)

- **Repo root:** brief §2.1 illustrates `mtg-commander-sim/`; we use the existing `mtgtester/`
  root and map the §2.1 tree onto it. No nested project folder.
- **Brief filename:** the brief and the original `CLAUDE.md` reference `docs/project-brief.md`,
  but the file is `docs/mtg-commander-ai-simulator-brief.md`. `CLAUDE.md` now points at the real
  name; the brief file was **not** renamed (it is the authoritative artifact).
- **`PlayerState.poisonCounters`:** added to the shared type though the brief's illustrative
  struct (§5.2) omits it — the poison state-based action (§5.6) requires it.
- **`config/` files:** `config/ai.ts` (§7.2) and `config/mana-metrics.ts` (§9.2) are not created
  yet; they will live under `packages/server` when Phases 3 and 5 need them.

## Consequences

- Running code needs no build; `bun run test`/`dev` work straight from TypeScript source.
- Banned-list card names carry curly apostrophes from the source page (e.g. _Yawgmoth's Bargain_).
  Phase 1 deck validation must normalize apostrophes when matching against Scryfall names.
- Adding a mechanic or message type later means fleshing out a `TODO(phase-N)` stub in `shared`
  (e.g. `ContinuousEffect`, `GameEvent`, the WebSocket payloads) without restructuring.
