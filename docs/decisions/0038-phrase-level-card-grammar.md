# ADR 0038: Rewrite the card interpreter as phrase-level grammar

Status: Accepted (2026-11-02)

Date: 2026-11-02

Plan: [modelling the EDHREC coverage list](../plans/edhrec-coverage-modelling.md), Phase 1.

## Context

The EDHREC ready list has 5,917 cards that are each blocked by one unparsed rules line. Those cards
have 5,592 distinct lines. After numbers, colors, card types, subtypes and mana symbols are
normalized, 5,342 distinct templates remain, and only 883 cards share a template with another
card. A rule that matches a whole sentence closes about 1.1 cards. ADR 0009 found the same thing on
a smaller population: 94% of unparsed lines occur on exactly one card.

The interpreter is written as whole-sentence rules. `cards/interpret.ts` is 9,252 lines with about
400 anchored regular expressions. `parseEffectSentence` alone is about 1,900 lines of ordered
branches, and some branches parse one card's sentence (`parseCounterUnlessFerociousBlock`,
`parseHellkiteCourserBlock`, `parseDestroyThenLoseLifeEqualToManaValueBlock`). Phrase parsers
exist (`parseSubject`, `parseDynamicCountValue`, `parseConditionClause`, `parseTriggerSubject`,
`parseTargetClause`), but each sentence rule decides for itself which of them to call. Each rule
also accepts its own fixed phrasing for amounts and players. As a result, the engine can often
compute a value that the parser rejects in most positions.

Rewriting one feature per blocking line measured what phrase-level parsing would buy. Accepting any
amount phrase in any amount position closes 227 cards on its own. Intervening-if conditions close
62, optional costs inside effects 37, and `unless` payments 26. A shared trigger-event vocabulary
would close another 208 cards that fail only at the event. The `Value` union already has more than
60 kinds, including `xValue`, `countPermanents` and `countTappedPermanents`, so most of this is
parser work rather than engine work.

## Decision

1. **Grammar modules.** Phrase parsers move out of `interpret.ts` into
   `packages/engine/src/cards/grammar/`, one module per slot:

   | Module             | Parses                                                                       |
   | ------------------ | ---------------------------------------------------------------------------- |
   | `words.ts`         | number words, color words, plural forms, subtype resolution                  |
   | `amount.ts`        | counts and amounts to `Value`: `X`, `for each …`, `equal to …`, `that many`  |
   | `subject.ts`       | permanent subjects, mass subjects, target nouns, card filters, spell filters |
   | `player.ts`        | player scope: `you`, `each opponent`, `target player`, `that player`         |
   | `duration.ts`      | `until end of turn`, `until your next turn`, `for as long as …`              |
   | `condition.ts`     | intervening-if, `as long as`, activation and resolution conditions           |
   | `trigger-event.ts` | trigger heads to `ObjectTriggerWhen` and player events                       |
   | `cost.ts`          | activation costs, additional costs, costs inside effects                     |
   | `effect.ts`        | the clause pipeline and the verb table (decision 3)                          |

   `interpret.ts` keeps card assembly: layouts and faces, keyword lines, line splitting, overrides,
   and the final `CardDefinition`.

2. **Slot results carry their failure.** A slot parser returns the parsed value or the slot and
   text it could not parse. Extracted functions keep their current `T | null` signatures while they
   are moved, so a move stays byte-identical; the failure form is added afterwards (Phase 1 step 5).
   Failures go into a diagnostics field, not into `unmodeledReasons`, whose strings do not change.
   `edhrec:triage` reads the diagnostics to build the work queue.

3. **Effects are a clause pipeline.** An effect sentence is decomposed into subject or player
   scope, verb, object, amount, duration and condition. The verb selects an entry in a verb table,
   and the entry composes slot parsers. `parseEffectSentence` is ported one verb family at a time,
   with the existing branch order kept inside each family during the port. A card-shaped block
   parser is deleted once its card parses through the pipeline.

4. **The grammar emits existing IR only.** A grammar production never introduces a new `Effect`
   op or executor case. That belongs in the engine, as for the template layer (ADR 0025 rule 1).
   A new op lands first with its executor and contract tests, then the production that emits it.

5. **Proof of equivalence.** Every refactor step leaves these unchanged:
   - the existing 93-card interpretation snapshot and the override snapshot;
   - a new interpretation snapshot over the full pinned fixture (`coverage-oracle.json`, 1,031
     cards);
   - a new outcome snapshot over the one-line probe corpus (the 5,917 ready-list blocking lines on
     synthetic cards).

   Where the Scryfall bank is available, `bun run bulk-smoke` also passes before a step merges.
   A step that changes behavior on purpose is a coverage step, not a refactor step, and its
   corpus diff is its measured yield.

6. **Tests follow productions.** A pure move needs no new tests, because the nets prove it. A new
   production or slot form gets unit tests in `grammar/*.test.ts` and an executor test for the
   behavior it enables. A card that composes existing productions needs no tests of its own
   (decision D1 in the plan).

## Consequences

- Adding an amount, condition, event or player form makes it available in every sentence that
  has that slot, instead of in one sentence.
- Each unparsed line reports which slot failed, so triage no longer has to guess with rewrites.
- The refactor touches engine sources, so each step re-seals the AI benchmark pins
  (`chore(benchmarks)`). Steps are batched to keep re-seals few.
- The nets cover 1,031 real cards and 5,917 synthetic ones, not the whole bank. A refactor that
  changes a card outside both can pass them; `bulk-smoke` on a machine with the bank is the
  backstop.
- `interpret.ts` shrinks to card assembly, and the parser's structure follows Oracle wording
  rather than the order in which cards were added.

## Alternatives considered

- **Keep adding sentence rules.** At about 1.1 cards per rule over 5,342 templates, this is the
  most expensive option, and every rule re-implements amount and player parsing.
- **A parser generator or PEG grammar.** It would replace the parser all at once, with no way to
  prove equivalence step by step. It can be revisited for a single slot once the slots are
  separate modules.
- **Bespoke overrides for the tail.** An override is per-card code and needs per-card tests under
  D1, so it costs the most per card. Overrides remain for genuinely one-off cards.
