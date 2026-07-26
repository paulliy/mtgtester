# MTG Commander AI Simulator

A local application that plays complete, rules-accurate games of **Magic: The Gathering
Commander** between **four AI-controlled players**, so a human spectator can evaluate how
their decks actually perform. You supply four decklists, press start, and watch a legal
four-player game play to a single winner — then review per-deck statistics across games.

**This is a deck-evaluation tool, not a game you play.** See the full specification in
[docs/mtg-commander-ai-simulator-brief.md](docs/mtg-commander-ai-simulator-brief.md).

## Architecture (the one decision that matters)

A **hybrid**: a deterministic TypeScript **engine** is authoritative on all rules — it
computes the complete set of legal actions at every decision point. The **AI** only
_chooses_ among engine-offered options; it never adjudicates legality. When there is only
one legal action, the engine resolves it with no AI call.

Any OpenAI-compatible provider works; OpenRouter is the default and the vendor is
auto-detected from whichever key is present. See
[docs/decisions/0011-openai-compatible-provider.md](docs/decisions/0011-openai-compatible-provider.md).

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
cp .env.example .env    # then add one provider API key (OpenRouter by default)
bun run typecheck
bun run lint
bun run test
```

## Watching a game

Two processes under the hood — the server owns the engine and the API key, the web app is a
view — but one command starts both:

```bash
bun run dev        # server on :3001 + Vue spectator UI on :5173
```

Or run them separately (useful for restarting one without the other):

```bash
bun run serve      # http://localhost:3001 — HTTP + /ws, holds the engine
bun run dev:web    # http://localhost:5173 — Vue spectator UI (proxies /ws)
```

Open the UI, pick four decks, and press start. Decks come from two places:

- **Generated from the engine-supported pool** (the default) — always playable.
- **Imported** from a Moxfield/Archidekt URL or a pasted list. These are **pre-flighted**: any
  card the engine cannot yet model is reported by name on the setup screen, because a deck must
  be fully modeled to be simulated. See
  [docs/decisions/0009-supported-pool-decks.md](docs/decisions/0009-supported-pool-decks.md).

The provider is selectable per game — `random` needs no API key and is the fast way to exercise
the UI; `ai` spends real calls.

## Reference data

- **Reference rules** live in `docs/rules/` as plain text / markdown.
- **Scryfall bulk data** (`data/scryfall-oracle-cards.json`, ~180 MB) is gitignored;
  see [data/README.md](data/README.md) to (re)download it.

## Privacy note

Requests go to whichever OpenAI-compatible provider you configure. On free tiers (Google's
included) requests may be used for model improvement. This tool sends decklists and board
state; decklists are not sensitive, so this is acceptable — but be aware of it if you use a
free-tier key. The Comprehensive Rules are **never** sent to the model: they are a reference
for implementing the engine, not runtime context (brief §7.4).

## Status

**Phase 4 — Spectator UI.** Complete pending phase-boundary approval. Phases 0–3
(foundations, deck pipeline, engine core, AI integration) are in; see the phase log in
[CLAUDE.md](CLAUDE.md) and the ADRs in [docs/decisions/](docs/decisions/). Development
proceeds in the phases defined in the brief §14, stopping for approval at each boundary.
