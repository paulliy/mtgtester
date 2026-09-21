# 0009 — Playable decks come from the supported pool, not from chasing coverage

Date: 2026-07-25
Status: Accepted

## Context

The engine halts loudly on any unmodeled card that reaches a decision point (brief §6.3,
`requireModeled`). That is the right call — a wrong game is worse than no game — but it has a
consequence that was not obvious until it was measured: **deck playability is all-or-nothing**.
A decklist with one unmodeled card in it cannot be simulated at all, so 99% coverage of a deck
is worth exactly as much as 0%.

We built a coverage instrument (`bun run coverage`) over seven real Commander decks — six
precons plus a user-supplied Ur-Dragon list — and measured what raising coverage would actually
buy. The results killed the plan we were executing:

| work                           | cards it unblocks | resulting coverage |
| ------------------------------ | ----------------- | ------------------ |
| activated abilities (non-mana) | +14               | 6.0% → 9.0%        |
| ＋ token creation              | +25               | 6.0% → 11.3%       |
| all 14 top mechanic families   | +302              | → 70.5%            |

The per-mechanic counts we had been ranking work by (activated abilities "blocks 128 cards")
are **upper bounds**, not yields. An unmodeled card carries **2.25 blocking mechanics on
average**, and 299 of 440 carry two or more, so fixing one mechanic rarely finishes a card.

Worse, the tail does not converge. Of 613 distinct unparsed rules-text lines, **577 (94%)
appear on exactly one card**. This is not a parser problem with a few hundred regexes left in
it; it is ~600 bespoke effects. And every one of the seven decks needs 63–106 more cards
modeled, spanning 19–24 distinct mechanic families, before it plays a single turn.

So: the incremental-coverage strategy cannot reach a running simulation, and Phase 3 (the
Gemini AI) needs games that run.

## Decision

**Invert the problem.** Rather than take arbitrary decks and chase their cards, enumerate the
cards the engine already models and construct legal Commander decks from that pool.

- `packages/server/src/cards/pool.ts` — `buildSupportedPool` filters the Scryfall bulk to
  commander-legal cards that `interpretCard` reports as modeled, tagging each with color
  identity, land-ness, commander eligibility, and singleton exemption.
- `packages/server/src/decks/generate.ts` — `generateCommanderDeck` builds a 100-card deck that
  is legal by construction: singleton outside basics (CR 903.5b), inside the commander's color
  identity (CR 903.4), commander excluded from the 99. Seeded via the engine's `Prng`, so a
  decklist is reproducible from its seed (brief §4/§5.9 — no `Math.random`).
- `bun run pool` reports the pool; `--commanders` lists usable commanders; `--write` commits
  decks as fixtures; `--play` runs a full four-player game as the end-to-end proof.

The generator is not trusted to be correct: generated decks are run through the existing
`validateDeck` (§8.3) independently, and all four pass.

**The metric changes.** "Percent of cards modeled" is not a goal in itself — it was being used
as a proxy for "can we simulate a game", and it is a bad one. The metric is now **how many
decks play end to end**, which went from 0 to 4.

## Consequences

Good:

- The simulator runs _now_: 1,412 modeled cards, 49 usable commanders, every color identity
  except colorless deep enough for a legal deck. A verification game plays 72 turns to a single
  winner across 2,821 events, byte-identical on re-run with the same seed.
- Phase 3 is unblocked. The AI can be built and evaluated against real games while card
  coverage grows underneath it, instead of waiting on it.
- Coverage work is now _optional and incremental_ rather than a gate. Each newly modeled
  mechanic widens the pool and makes generated decks more interesting; nothing is blocked on
  reaching a threshold.

Costs, stated plainly:

- **Generated decks are not real decks.** The pool skews to vanilla creatures, so games are
  mechanically thin — no activated abilities, no tokens, few interactions. They exercise the
  rules engine, not deck strategy, and an AI tuned only against them would be tuned against a
  weak distribution.
- Simulating a _specific_ real decklist remains out of reach and stays the long-term goal. The
  tractable route there is per-deck: pick one list and model its ~70 unmodeled cards
  deliberately — a closed set, where the authored-override registry (ADR 0004's increment 2)
  is the right tool. That is the opposite of what overrides are useless for, which is chasing
  a distribution.
- The coverage suite (`bun run coverage`) is retained as the instrument that tells us which
  mechanics to build next, and now measures the user's own decks alongside the precons.

## Verification

- `typecheck` / `lint` / `test` green — 187 tests, including 10 that guard legality-by-
  construction and seeded determinism against a synthetic pool (no bulk-file dependency, so
  they run in CI).
- `bun run pool --play` — a complete four-player game to a single winner; the same seed twice
  produces identical turn count, elimination order, and event count.
- `bun run decks --no-save <generated fixtures>` — 4/4 report VALID against the full §8.3
  Commander rules, independently of the generator.
