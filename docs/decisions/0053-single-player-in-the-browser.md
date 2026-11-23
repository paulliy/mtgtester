# ADR 0053: Single player runs in the browser

Status: Accepted (2026-11-23)
Status note: Paul set the scope on 2026-11-23. This ADR covers the first step, a browser-clean session; the worker, card bundle and merged site follow in the master plan's later sections.

Date: 2026-11-23

Amends [ADR 0031](0031-multiplayer-tables.md) (who runs a game) and
[ADR 0052](0052-decktank-visual-identity.md) decision on the multiplayer link. The work is planned
in the master plan (Claude Doc "Decktester merged site: master plan", 2026-11-23).

## Context

The live site serves only multiplayer tables from a 1 GB VM. The tester, with its New game
opening, deck chooser, watch mode and rewind, runs only against a local `serve`, which must never
be exposed: it shows every hand and has no authentication. A feasibility check on 2026-11-23 found
that the engine, bot and shared packages bundle for the browser unchanged (0.57 MB gzipped) and
play the same moves in Chromium as in Bun. The session code around them did not: it imported the
model code (the OpenRouter SDK, zod and `server/src/ai`), `node:crypto` and `node:fs`.

## Decision

1. **One site, the tester's UI.** The public site is the tester's UI. Single player and watch mode
   run in the visitor's browser, in a Web Worker. The compass's Multiplayer stop opens the tables
   screen in the same tab, and the tables screens link back to single player.
2. **Multiplayer stays server-authoritative.** Tables keep running on the VM. Nothing a browser
   computes is trusted by the server: not results, not statistics, not a game in progress.
3. **Heuristic bots only in the browser.** Model seats need the API key, so they never run there.
   `MatchSession` receives the model-backed services as `opts.ai` (`match/session-ai.ts`) instead
   of importing `ai/`; the server passes `sessionAi`, and a session without them refuses
   `providerKind: 'ai'`. Without them reflections are off and a free-text deal draft gets the same
   answer as a missing API key.
4. **Browser-safe modules.** Code a browser runs imports no Node or Bun API. File loaders live in
   their own modules (`cards/oracle-index-file.ts`, `decks/banned-file.ts`,
   `cards/provisional-load.ts`), and hashing that must match on both sides uses `sha256Hex` from
   `@mtg/shared`, which equals `node:crypto`'s digest. `server/src/browser/bundle-guard.test.ts`
   bundles those modules for the browser and fails on any Node or Bun import or model code.
5. **No saves in v1.** A browser game lasts as long as its tab. Saves (a replay log in browser
   storage) come later, with their own decision on versioning and eviction.
6. **Batch and Stats show as Coming soon** on the public site until they can run locally.

## Consequences

- A new value import of `ai/` from session code fails the guard test; add model behavior through
  `SessionAi` instead.
- The browser bundle of the session code is 0.62 MB gzipped, down from 0.96 MB.
- Every `new MatchSession` that uses model seats passes `ai: sessionAi`.
- Bot hands and the RNG key are visible in the browser's developer tools. That is accepted for
  single player, and is why decision 2 holds.
