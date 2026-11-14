# ADR 0047: Provisional cards, an opt-in trust tier for machine-checked patches

Status: Proposed (2026-11-14). Waiting on Paul's answer to "may provisional cards be played?"
(question 1 of the 2026-11-14 architecture review). Until it is accepted the tier stays off
everywhere unless a person passes `--provisional`.

Date: 2026-11-14

Amends the 2026-11-09 decision recorded in `scripts/card-compiler/README.md` that compiled cards
are never playable before review. Does not change brief §6.3: a card that is neither modeled nor
provisional still halts the engine.

## Context

The card compiler (PR #58) and the XMage translation pilot (PR #60) put 208 patches in
`docs/reviews/compiled-card-queue.json`. 174 entries (166 distinct cards) passed every automatic
check: the IR validator, generated smoke games, and a meaning check (the deterministic renderer or
a blind back-translation and judge). No person has reviewed any of them, so none can be played,
and there is no cheap review step. Hand audits of 30 checked patches found 28 correct; both wrong
ones had already been flagged by the meaning check and are not `compiled-checked`.

## Decision

1. **A trust field.** `CardDefinition.trust` is absent for today's cards and `'provisional'` for a
   definition built from a checked queue patch, with `trustSource` naming the patch origin. Being
   absent by default keeps every definition snapshot and fingerprint unchanged.
2. **Built like the compiler checked it.** `interpretProvisional` (engine) registers the patch as an
   `'append'` override for one interpretation, validates the merged definition, and restores the
   registry. Nothing stays registered, so `interpretCard` answers as before for every caller. It
   refuses a patch that sets identity or trust fields, a card under `unsupportedCard`, and a card
   the interpreter now models on its own (appending would double an ability).
3. **Admission** (`packages/server/src/cards/provisional.ts`): only `compiled-checked` entries whose
   patch file still has the queued SHA-256, with no `rejected` review, no `differs` cross-check, and
   no entry in `docs/reviews/provisional-demoted.json` for those bytes. A card with two admissible
   patches plays the first in queue order. Every skip is reported with its reason, never thrown.
4. **Opt-in per game.** `GameConfig.allowProvisional` is off by default; `createGame` refuses
   `provisionalDefinitions` without it, and replaces only cards that are in a deck and unmodeled.
   `serve`, `play-decks` and `fuzz` take `--provisional`. Benchmarks, fingerprints, coverage and the
   bot league never opt in, and a test fails if one of their entry points mentions the tier.
5. **Visible everywhere.** The spectator and player views carry `provisional: true` on such cards
   (redacted with the rest of a face-down card), the web app shows a "P" mark, the log says
   "<card> is provisional" the first time one is cast or activated in public, the `GameResult`
   lists the provisional cards the decks held, and the stored replay config pins each patch's
   bytes.
6. **Fuzz demotes.** `fuzz --provisional --demote <path>` plays each admitted card in pods and adds
   it to the demotion list when its game throws, breaks an invariant or halts (not on the turn cap)
   while the same pod without it passes.
7. **Sampled audit.** `run.ts audit --seed S` draws cards by seed and prints Oracle text beside the
   patch rendered into English (or its IR); `run.ts review` records the verdict in the queue.

## Consequences

- A game with a provisional card is not reviewed evidence. Its result says so; tables and
  statistics built on stored games should read `provisionalCards` or the replay pins and keep such
  games apart (follow-up: surface the count in batch summaries and coverage numbers).
- A wrong provisional card gives a wrong game with no error. The defences are the narrow
  admission rule, the marks, fuzz demotion, and the sampled audit.
- H4 (cards as data) later replaces the queue-reading loader with precompiled definitions that
  carry the same trust field.
