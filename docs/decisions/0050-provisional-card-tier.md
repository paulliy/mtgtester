# ADR 0050: Provisional cards, an opt-in trust tier for machine-checked patches

Status: Accepted (2026-11-17)
Status note: Paul answered question 1 of the 2026-11-14 architecture review on 2026-11-16: provisional cards may play, marked for review. The tier stays opt-in through `--provisional`; turning it on by default is a separate change. Numbered 0050 because open PR #72 takes 0047 and PR #74 renumbers two older ADRs to 0048 and 0049.

Date: 2026-11-14

Relates to PR #72's ADR 0047 (compiled cards promoted into the registry as
`implemented-unreviewed` after an audit). That route makes audited cards ordinary modeled cards;
this one lets checked but unaudited cards play only where a person asks for them, marked as such.
PR #72's audit found 5 wrong patches among 150 that passed every automatic check (about 3%), which
is the error rate this tier's marks and demotion exist for.

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
   no entry in `docs/reviews/provisional-demoted.json` for those bytes. A malformed patch file is
   skipped with its reason like any other failure. A card with two admissible
   patches plays the first in queue order. Every skip is reported with its reason, never thrown.
4. **Opt-in per game.** `GameConfig.allowProvisional` is off by default; `createGame` refuses
   `provisionalDefinitions` without it, and replaces only cards that are in a deck and unmodeled.
   `serve`, `play-decks` and `fuzz` take `--provisional`. Benchmarks, fingerprints, coverage and the
   bot league never opt in, and a test fails if one of their entry points mentions the tier.
5. **Visible everywhere.** The spectator and player views carry `provisional: true` on such cards
   and commanders (redacted with the rest of a face-down card), the web app shows a "P" mark, the
   log says "<card> is provisional" after the first public cast, play, activation, unlock or turn
   face up (never while the card is face down), the `GameResult`
   lists the provisional cards the decks held, and the stored replay config pins each patch's
   bytes. A replay refuses a pin the loaded catalog does not hold at the same bytes, and opts in
   only the pinned cards.
6. **Fuzz demotes.** `fuzz --provisional --demote <path>` plays each admitted card in pods and adds
   it to the demotion list when its game throws, breaks an invariant or halts (not on the turn cap)
   while the same pod without it passes.
7. **Sampled audit.** `run.ts audit --seed S` draws cards by seed and prints Oracle text beside the
   patch rendered into English (or its IR); `run.ts audit-verdict` records the verdict in the queue.

## Consequences

- A game with a provisional card is not reviewed evidence. Its result says so; tables and
  statistics built on stored games should read `provisionalCards` or the replay pins and keep such
  games apart (follow-up: surface the count in batch summaries and coverage numbers).
- A wrong provisional card gives a wrong game with no error. The defences are the narrow
  admission rule, the marks, fuzz demotion, and the sampled audit.
- H4 (cards as data) later replaces the queue-reading loader with precompiled definitions that
  carry the same trust field.
