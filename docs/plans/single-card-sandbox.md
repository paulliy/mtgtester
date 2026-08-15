# Single-Card Sandbox

## Purpose

`docs/guides/card-modeling-and-testing.md` §5 names a real gap: there is no "load one card, cast
it, see what happens" workspace. Levels 4-6 of that guide's testing pyramid exist today only by
hand-assembling a small real decklist and running it through `play-decks` or the full setup
screen. That works, but it costs several minutes of manual deck-building per card, every time —
which is exactly the kind of friction that gets a step skipped under time pressure, and skipped
steps are how a card ships `modeled: true` with a green unit test and a wrong trigger timing
nobody exercised in a real game.

This plan automates the deck-assembly step and adds a fast eyeball/assertion loop on top of it,
for both the CLI dev loop and the real client. It deliberately does **not** build
`docs/plans/phase-10-deck-testing-lab.md` — see [Relationship to Phase 10](#relationship-to-phase-10).

## Card-author outcome

Someone who just wrote an override for a card should be able to:

- Run one CLI command and watch a real, legal, seeded game goldfish-draw and cast that specific
  card within a few turns, with the moment it's cast/activated/resolves called out in the log.
- Get a pass/fail signal ("was this card cast by turn 8?") without reading a full decision log.
- Open the real web client, search for the card by name, and land straight in a single-player or
  spectator game with a deck built around it — no manual decklist required — to check UX-adjacent
  correctness (targeting prompts, stack visuals) and whether the gameplay AI actually chooses to
  use it well.
- Still fall back to a hand-built decklist (today's workflow) for the cases auto-building can't
  reliably serve — see [Non-goals](#scope-and-non-goals).

## Scope and non-goals

In scope:

- A deterministic "deck around a card" builder from the engine-supported pool.
- A CLI sandbox command wrapping that builder with a scripted goldfish run and simple pass/fail
  assertions.
- A web entry point that reuses the existing single-player/spectator session machinery, so a
  sandbox game is a normal game as far as `GameView.vue`/`PlayerGameView.vue` are concerned.
- Docs updates pointing card authors at the new tool.

Non-goals (this is intentionally the small, fast slice, not the product):

- No experiment/version persistence, no deck-snapshot comparison, no aggregate/statistical
  reporting across many games — that is `phase-10-deck-testing-lab.md`'s job.
- Does not replace levels 1-3 (fixture/unit/whole-game tests) as the primary correctness signal;
  the sandbox is automation for levels 4-6, not a substitute for them.
- Does not attempt to stage an arbitrary bespoke board state ("exactly 3 blockers, one with first
  strike, opponent at 2 life"). Auto-building is about reliably *drawing and casting* one card in
  a legal game, not scripting a specific battlefield — that remains a level-2 fixture job.
- No changes to engine legality, rules authority, or the AI's decision surface.

## Product decisions

1. **A sandbox game is a normal game.** It must produce a real `MatchSession` through the
   existing `setupSeats`/session path, so nothing downstream (playback, stats, the human decision
   provider, the two-tier AI) needs a special case for "this is a sandbox."
2. **The target card is guaranteed present and modeled, or the tool refuses.** Same halt-loudly
   posture as the rest of the engine (brief §6.3) — if the card is unmodeled, or the auto-builder
   cannot legally include it, say so; never silently substitute or drop it.
3. **Deterministic and seeded.** Same seed, same sandbox deck, same shuffle — a reported result is
   reproducible, consistent with every other deck-construction path in the repo.
4. **CLI first.** The CLI sandbox is the cheaper, faster-iterating surface and should land first;
   the web entry point reuses its deck-building core rather than duplicating it.

## Work plan

### 1. Deck-around-a-card builder

Add `generateSandboxDeck(pool, targetCard, options)` alongside `generateCommanderDeck` in
`packages/server/src/decks/generate.ts` (or a sibling `sandbox-deck.ts` if that file is getting
crowded):

- Includes `targetCard` in the 99 (or, if the caller passes `--commander`, allows it to *be* the
  commander).
- Picks a commander whose color identity is a superset of the target card's color identity,
  chosen deterministically by seed from the supported pool — same `Prng`-driven approach
  `generateCommanderDeck` already uses, no `Math.random`.
- Biases the rest of the 99 toward drawing/casting the target reliably: enough lands/ramp to hit
  its mana value on curve, and preference for low-curve filler over other build-arounds so the
  target isn't competing with unrelated payoffs for space.
- Still produces a **legal** deck by construction (100 cards, singleton outside basics, inside
  color identity, CR 903.5a) and draws only from the supported pool, same guarantees
  `generateCommanderDeck` already documents.
- Throws a clear error (not a silently-short/illegal deck) when the target card has no legal
  commander in the pool that shares its color identity, or is itself unmodeled.

Tests (`packages/server/src/decks/generate.test.ts`, extending existing coverage): legality,
determinism (same seed → same deck), target-card presence and drawability, and the
no-legal-commander failure path.

### 2. CLI: `bun run sandbox`

New `packages/server/src/cli/sandbox.ts`, registered as `"sandbox": "bun run
packages/server/src/cli/sandbox.ts"` in `package.json`, following `play-decks.ts`'s shape:

```
bun run sandbox "<Card Name>" [--seed S] [--opponent <deckUrlOrFile>] [--turns N]
                               [--ai] [--assert castByTurn=8] [--verbose]
```

- Builds the sandbox deck for seat 0 via `generateSandboxDeck`; loads the opponent the same way
  `play-decks.ts` already loads decks (URL/file), or generates one from the pool when omitted.
- Runs with `HeuristicDecisionProvider`/`RandomDecisionProvider` by default, or the real AI
  provider under `--ai` (mirrors `pool --play --ai`).
- `--verbose` reuses `play-decks`'s existing turn-by-turn decision log, plus one new marker line
  the first time the target card is cast, an ability is activated, or a trigger resolves — a
  grep-friendly anchor a card author scans for instead of reading the whole log.
- Halts on `UnmodeledCardError` exactly as today — this tool never masks an unmodeled required
  card.

### 3. Scenario assertions

A small predicate module (e.g. `packages/server/src/cli/sandbox-assertions.ts`) evaluated over
the engine's own event log/state — never by string-matching the decision-log text, same principle
`phase-10-deck-testing-lab.md` §10.3 lays out for its scenario objectives:

- `castByTurn(turn)`, `resolvedAbility()`, `enteredBattlefield()`, `diedBy(turn)` to start —
  enough to answer "did the card actually get cast/used in this run."
- `--assert <predicate>=<value>` on the CLI exits non-zero with a specific failure message when
  unmet, and zero when satisfied — a one-line pass/fail a card author (or, later, CI) can act on
  without reading a log.
- This module is deliberately written so `phase-10-deck-testing-lab.md`'s later "typed predicates
  over authoritative state/events" scenario objectives can absorb or extend it rather than
  starting over.

### 4. Web: sandbox entry point

- New `apps/web/src/views/SandboxSetupView.vue`, modeled on `SetupView.vue`/`BatchSetupView.vue`:
  a card-name search box (against the oracle index) instead of a four-seat deck picker, an
  opponent-pod picker reusing the existing `SeatSource` options (pool / URL / plaintext), and a
  mode toggle (single-player human seat vs. spectator AI-vs-AI), matching the existing
  vocabulary in `SetupView.vue` rather than inventing new terms.
- Server-side, extend the existing `startGame` WS message path (`packages/shared/src/protocol.ts`,
  handled in `packages/server/src/ws/server.ts:226`) rather than adding a parallel REST endpoint:
  a `sandboxCard` field alongside `seats`, resolved through `generateSandboxDeck` before
  `setupSeats` runs, so the rest of the session/runner/UI pipeline is unmodified — a sandbox game
  is a normal `MatchSession` from `GameView.vue`'s perspective.
- No new persistence: this reuses whatever the normal game path already stores; no experiment
  tables, no comparison UI (that's Phase 10).

### 5. Docs

- Update `docs/guides/card-modeling-and-testing.md` §5: replace "planned but unbuilt" with a
  pointer to `bun run sandbox` and the web Sandbox entry point as the primary levels 4-6 path,
  keeping the hand-built-decklist instructions as the documented fallback for the non-goals cases.
- Once shipped, add an ADR (next number after 0025) covering the deck-around-a-card algorithm and
  the assertion predicate design, per this repo's existing ADR practice.

## Relationship to Phase 10

`phase-10-deck-testing-lab.md` is the full deck-testing product: saved deck versions, reusable
pods, batch orchestration, persisted experiments, comparison/reporting. Its §10.1 and §10.3
already gesture at a single-deck entry point and scenario/goldfish builders, and this plan's
deck-builder and assertion predicates are written so that work can absorb them later rather than
duplicate them. But Phase 10 is a large, multi-milestone product effort with its own
phase-boundary approval, and the card-modeling gap is needed now, at a fraction of the scope: no
persistence, no comparison, no batch UI, no experiment identity. This plan is that fraction.

## Verification and acceptance

- `generateSandboxDeck` unit tests: legality, determinism, target-card presence/drawability, and
  the no-legal-commander error path.
- CLI test: a sandbox run against a known modeled card produces the target-card marker line and
  exits 0 with a satisfied assertion; an unmet assertion exits non-zero with a specific message;
  an unmodeled target card halts with the existing `UnmodeledCardError`, unchanged.
- Web: a Playwright test drives the Sandbox entry point end to end into an existing `GameView`,
  for both single-player and spectator modes, reusing existing e2e patterns.
- Acceptance: a card author can go from "just finished an override" to "watched it get cast in a
  real game, with a pass/fail signal" in under a minute of setup — one CLI command, or one web
  search box — with no hand-built decklist required for the common case.

## Definition of done

Levels 4-6 of `docs/guides/card-modeling-and-testing.md` are backed by a real tool instead of
manual deck assembly: `bun run sandbox` for the CLI dev loop, and a web Sandbox entry point for
interactive/AI-observation testing — both deterministic, both halting loudly on unmodeled cards,
neither adding persistence or reporting scope that belongs to Phase 10.
