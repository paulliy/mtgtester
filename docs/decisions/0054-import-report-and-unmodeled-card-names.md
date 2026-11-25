# ADR 0054: Import report and the unmodeled card names a preview sends

Status: Accepted (2026-11-23)

Date: 2026-11-23

Amends [ADR 0052](0052-decktank-visual-identity.md) decision 8 (the import report is now built,
not deferred), and the boundary comment on `SetupPreviewSeat` in `packages/shared/src/protocol.ts`.
The work is phase 4 of [docs/plans/decktank-redesign.md](../plans/decktank-redesign.md).

## Context

A blocked import used to say only "P2: Deck is not fully modeled." The engine halts on any
unmodeled card ([ADR 0009](0009-supported-pool-decks.md)), so a pasted list is
all-or-nothing, and the person needs to know which cards stop it. The server already computed those
names for a saved deck and threw them away. `SetupPreviewSeat` documented that "no card list or
private card data crosses this boundary", which is why.

## Decision

1. **Only unmodeled names cross.** `SetupPreviewSeat` gains `unmodeledCards?: { name,
oracleSha256?, status }[]`, filled for URL, plaintext and saved seats. It lists only the cards of
   that deck the engine's interpreter does not model on its own. A deck whose cards are all modeled,
   and every generated seat, sends no card names. The rest of a deck, and its card counts, still never
   cross.
2. **Why this is safe.** A preview is requested by the local person at setup, for decks they chose
   or pasted, on the loopback-only tester server. The names come from their own list and are public
   card names. Table play does not use previews, and a refused single-player _start_ keeps
   [ADR 0034](0034-fail-loud-execution-and-strict-tests.md)'s rule and `setup-privacy.ts`: it still
   forwards no `unmodeledCards`.
3. **Status is real, never invented.** `unsupported`: `interpretCard(card).modeled` is false and no
   provisional definition covers it. `provisional`: the server admitted a machine-checked definition
   for it ([ADR 0050](0050-provisional-card-tier.md)); it does not block. A preview never sends
   `implemented-unreviewed`, because a modeled card is not listed; the Import report endpoint below
   does use it.
4. **`GET /api/card-report?names=…`.** Repeated `names` values (card names hold commas), at most
   250, with a 400 beyond. Per card: Oracle text, `oracleSha256` (the hash the Card Test Lab and the
   audit ledger pin), the interpreter's `unmodeledReasons`, the status, and the evidence fields of
   `docs/plans/card-catalog-audit.json` (`engineEvidence`, `viewerEvidence`, `gameplayAiEvidence`)
   only where the ledger records them. A card is `implemented-reviewed` only when the interpreter
   models it and the ledger calls it reviewed under the same Oracle hash. A ledger entry the engine
   now contradicts is reported as `auditConflict` with its evidence left out. Lab scenarios are
   matched by `oracleSha256` only when the server runs the Card Test Lab; otherwise `scenarios` is
   null. No field defaults to "complete".
5. **Import report screen.** `/workshop/import-report`, a production route, shows the last failed
   import from a session-scoped store, with a work order built from the same data
   (`apps/web/src/lib/workOrder.ts`) that a person can save or hand to an LLM. The pasted list is kept
   in that store, which also fixes failed-import draft preservation.
