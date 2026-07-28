# MTG Commander AI Simulator

A local application that plays complete, rules-accurate games of **Magic: The Gathering
Commander** either between **four AI-controlled players** or with **one human against three
bots**. Supply four decklists, choose spectator or single-player mode, and play or watch a
legal four-player game through to one winner — then review per-deck statistics across games.

The deterministic engine remains authoritative in both modes. See the original specification in
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
  server/   Bun server: orchestration, AI providers, SQLite, WebSocket
apps/
  web/      Vue 3 spectator and player UI
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

Open the UI, pick four decks, choose spectator or single-player mode, and press start.
Single-player supports one selected human seat against three AI (or seeded random) bots. The
human decision provider has no timer; disconnecting pauses new bot work, and reconnecting to
the running server restores the private board and pending choice.

Decks come from two places:

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

**Phase 6 — Single-player Commander.** Implementation complete pending phase-boundary
approval. Spectator playback, Phase 5 statistics/diagnostics, and the single-player mode are
available; see the phase log in [CLAUDE.md](CLAUDE.md) and the ADRs in
[docs/decisions/](docs/decisions/).
