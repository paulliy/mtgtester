# 0002 — Deck pipeline (Phase 1)

Date: 2026-07-24
Status: Accepted (2026-07-24)
Status note: implementation
Context: brief §8 (deck import/validation), §9 (persistence), §14.1 (Phase 1).

Phase 1 turns four deck inputs into four validated, immutable snapshots or precise errors. The
pipeline is `import → resolve → validate → snapshot`, orchestrated by `runDeckPipeline`
(`packages/server/src/decks/pipeline.ts`) and exercised by the `bun run decks` CLI.

## Decisions

1. **Trust Scryfall `color_identity` verbatim.** It already implements CR 903.4 (cost/text mana
   symbols, color indicators, basic land types, reminder-text exclusions). Re-deriving it would
   be strictly worse. `OracleCard.colorIdentity` is copied straight from the bulk field.

2. **Banned list is parsed from the reference doc, with Scryfall legality as a secondary net.**
   `docs/rules/commander-banned-list.md` is authoritative per §3/§8.3; we parse its `#### Name`
   headings into an apostrophe-normalized set (44 names in the current snapshot). As defense in
   depth we _also_ reject cards whose Scryfall `legalities.commander` is `banned` or `not_legal`
   (the latter covers the silver-border/acorn/un-set pool exclusion the banned-list intro
   describes). Consequence: a legitimately legal card that Scryfall marks `not_legal` due to
   stale data would be over-rejected — acceptable and precise; refresh the bulk to fix.

3. **Name resolution never guesses (§8.2 step 2).** Two keys: a _strict_ key (apostrophe + case +
   whitespace normalized) tried first, then a _loose_ key (diacritics stripped, punctuation
   folded, DFC front-face) used **only when unambiguous**. Any miss or loose-ambiguity is
   reported as an unresolved name with its original spelling; the whole deck fails resolution
   rather than resolving to a wrong card. Front faces of `A // B` cards are indexed so a
   front-only name resolves.

4. **Companion conditions: a registry, exact where readable, honest where not.**
   `companions.ts` maps each of the ten companions to a predicate over the starting deck.
   Conditions readable from oracle data (Lurrus, Gyruda, Keruga, Obosh, Jegantha, Kaheera,
   Umori, Yorion) are checked exactly. **Zirda** ("every permanent has an activated ability") is
   approximated by scanning for an activated-ability cost (`:`), and says so in its message. An
   unrecognized card that nonetheless has a real "Companion —" ability is left **unverified**
   rather than rejected — we never fail a deck on a rule we cannot evaluate. Color-identity and
   singleton for the companion are covered by the global checks.

5. **Validation reports every problem, not the first (§8.3).** `validateDeck` accumulates issues
   across all seven rule families and returns them together, each tagged with a `ValidationCode`
   and (when card-specific) a `cardName`.

6. **Card cache stores the full `OracleCard` as JSON; games read the cache, not the bulk (§3).**
   Only a deck's resolved cards are persisted (`card_cache`). The ~180 MB bulk is read once per
   import to build an in-memory index and is never loaded by the engine.

7. **Full §9 schema laid down now.** `card_cache`, `decks`, `deck_snapshots` are written this
   phase; `games`, `game_players`, `game_events`, `game_state_snapshots`, `ai_calls`,
   `mana_metrics` are created (so the schema is settled) but populated in their phases, marked
   with `TODO(phase-N)` in `db/schema.ts`. Re-importing a URL inserts a **new** snapshot row so
   historical stats never shift (§8.2).

8. **Live adapters degrade to a clear error, not a crash.** Moxfield (v3 then v2 endpoint shapes)
   and Archidekt adapters set a descriptive User-Agent and, on any non-OK HTTP status (private
   deck, rate limit, API block), return a `DeckImportError` suggesting the plaintext-paste
   fallback rather than throwing. Source is chosen by URL host; anything else is treated as a
   plaintext paste.

## Tooling

- Added `@types/bun`; `packages/server/tsconfig.json` sets `types: ["node", "bun"]` for
  `bun:sqlite` and `node:fs`. Root script `decks` runs the CLI under Bun.

## New shared types

`packages/shared/src/cards.ts` (`OracleCard`, `CommanderLegality`) and
`packages/shared/src/decks.ts` (`ParsedDeck`, `ResolvedDeck`, `ResolutionResult`,
`ValidationIssue`/`ValidationResult`, `DeckSnapshot`, source/validation enum tuples).

## Divergences from the brief

- None material. The §9 column set is followed as written; JSON-shaped columns
  (`card_list_json`, `commander_names`, `color_identity`) hold serialized arrays. The companion
  Zirda check is explicitly approximate (decision 4).

## Verification

- `typecheck` / `lint` / `test` green (37 tests: normalization, resolution incl. ambiguity,
  type-line parsing, plaintext parsing, banned-list parsing against the real doc, and validation
  covering a legal deck plus deliberately-broken decks for each rule family).
- CLI run against the real 180 MB bulk: 34,429 oracle cards indexed, 44 banned names; a valid
  100-card deck snapshotted to SQLite, a broken deck reporting count + singleton + color-identity
  - banned problems together.

## Pending at the phase boundary

- Live-import demonstration against four real Moxfield/Archidekt URLs (the user will provide
  them). The live adapters are implemented and unit-covered but not yet exercised end-to-end
  against the services.
