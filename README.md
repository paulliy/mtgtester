# MTG Commander AI Simulator

A local application that plays complete, rules-accurate games of **Magic: The Gathering
Commander** between **four AI-controlled players**, so a human spectator can evaluate how
their decks actually perform. You supply four decklists, press start, and watch a legal
four-player game play to a single winner — then review per-deck statistics across games.

**This is a deck-evaluation tool, not a game you play.** See the full specification in
[docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md).

## Architecture (the one decision that matters)

A **hybrid**: a deterministic TypeScript **engine** is authoritative on all rules — it
computes the complete set of legal actions at every decision point. The **AI** (Google
Gemini) only _chooses_ among engine-offered options; it never adjudicates legality. When
there is only one legal action, the engine resolves it with no AI call.

## Repository layout

```
packages/
  shared/   Types shared across engine, server, and web
  engine/   Pure TS rules engine — no I/O, no network, no framework
  server/   Bun server: orchestration, Gemini, SQLite, WebSocket
apps/
  web/      Vue 3 spectator UI
docs/
  rules/       Reference material (Comprehensive Rules, Commander rules, banned list)
  decisions/   ADRs for significant choices
data/          Card cache + Scryfall bulk data (gitignored)
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (package manager and runtime)

## Getting started

```bash
bun install
cp .env.example .env    # then add your GEMINI_API_KEY
bun run typecheck
bun run lint
bun run test
```

## Reference data

- **Reference rules** live in `docs/rules/` as plain text / markdown.
- **Scryfall bulk data** (`data/scryfall-oracle-cards.json`, ~180 MB) is gitignored;
  see [data/README.md](data/README.md) to (re)download it.

## Privacy note

The AI runs on Google Gemini. On Google's free tier, requests may be used by Google for
model improvement. This tool sends decklists and board state; decklists are not sensitive,
so this is acceptable — but be aware of it if you use a free-tier key.

## Status

**Phase 0 — Foundations.** Development proceeds in the phases defined in the brief §14,
stopping for approval at each boundary.
