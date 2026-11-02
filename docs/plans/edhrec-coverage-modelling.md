# Plan: modelling the EDHREC coverage list

Status: proposed, 2026-11-02. Baseline: `253d682`. Scope: the 15 unmodeled EDHREC staples and the
5,917 cards in the [EDHREC ready list](edhrec-ready-list.md) that are blocked by exactly one
unparsed rules line.

Related: [EDH staple coverage](edh-staple-coverage.md) (earlier tiers),
[post-Tier-3 residue](post-tier3-card-coverage.md),
[faster card authoring](card-authoring-and-fail-loud.md),
[card coverage workflow](../guides/card-coverage-workflow.md), ADR
[0009](../decisions/0009-supported-pool-decks.md),
[0025](../decisions/0025-card-template-layer.md) and
[0033](../decisions/0033-forge-informed-card-authoring.md).

## Summary

- **Staples (15 cards).** Close all 15 to the full completion standard. Eleven are one line
  away, and most of those lines are shared by other ranked cards. Two primitives need real design
  work: copy-with-exception for Phyrexian Metamorph, and counters tracked through a zone change
  for The Ozolith.
- **The 5,917 cards.** "One line away" makes them sound cheap, but the lines barely repeat. There
  are 5,592 distinct lines, and after numbers, colors, types and mana symbols are normalized there
  are still 5,342 distinct templates. Only 883 cards (5.4% of slots) share a template with another
  card. A grammar rule for a whole sentence therefore closes about 1.1 cards. This matches ADR
  0009's finding that 94% of unparsed lines are unique to one card.
- **So most of the work is in phrase-level grammar, not sentence rules.** Rewriting one feature
  per line (amounts, intervening-if conditions, optional costs, `unless`) shows that a single
  phrase-level fix closes 377 cards on its own. Amounts alone close 227. Generalizing the trigger
  head vocabulary closes 208 more, and keywords close 193.
- **Verification is the real cost.** The pilot measured a median of 23 to 28 minutes per card at
  the completion standard. At that rate the 5,917 cards would take about 2,500 agent-hours. This
  plan holds the full standard for staples and for ranks 1 to 2,000 (665 cards, 12.7% of slots).
  Everything else that becomes `modeled` stays `implemented-unreviewed` behind primitive-level
  evidence. That split is a policy decision (decision D1 below), not a default.

## The population

From the frozen ranking (`packages/server/fixtures/edhrec-ranking.json`, 840,730,733 nonbasic
slots in 10,468,351 decks):

| EDHREC rank | One-line cards | Share of slots |
| ----------- | -------------: | -------------: |
| 1–500       |             70 |          2.67% |
| 501–1,000   |            212 |          4.96% |
| 1,001–2,000 |            383 |          5.04% |
| 2,001–4,000 |            918 |          6.19% |
| 4,001–8,000 |          1,919 |          6.05% |
| 8,001+      |          2,415 |          3.37% |
| **Total**   |      **5,917** |     **28.28%** |

The cards ranked 1 to 2,000 are 11% of the cards and 45% of the slot share. The 2,415 cards past
rank 8,000 are 41% of the cards and 12% of the slots.

There are 327 lands (2.84% of slots). Lands are the densest templated group: karoo bounce lands,
Landscapes and Panoramas, the "deals 1 damage to target opponent" lands, the
`enters tapped unless a player has N or less life` lands, reveal lands and Vivid lands.

### Where the blocking line fails

Each blocking line was split into its parts, and each part was run through `interpretCard` on its
own (method in the appendix):

| Shape     | Failing part                         | Cards |
| --------- | ------------------------------------ | ----: |
| Trigger   | effect body only                     | 1,341 |
| Trigger   | event and body                       |   481 |
| Trigger   | event only (body already parses)     |   205 |
| Trigger   | intervening-if, with or without body |   178 |
| Activated | effect only                          |   695 |
| Activated | cost or "Activate only…" restriction |   217 |
| Spell     | one sentence                         |   991 |
| Spell     | several sentences                    |   811 |
| Static    | whole line                           |   803 |
| Keyword   | the keyword                          |   193 |

Most failures are in effect bodies, and the same effect grammar serves triggers, activations and
spells. So effect grammar is where the leverage is, provided it is built from phrases rather than
whole sentences.

### Single-feature rewrites

Each line was rewritten one feature at a time. When the rewritten line parsed, that feature was
the card's only gap:

| Feature replaced                                                    | Cards closed by that alone |
| ------------------------------------------------------------------- | -------------------------: |
| Amount: `X`, `for each …`, `equal to …`, `where X is …`             | 227 (103 of them bare `X`) |
| Intervening `if …` condition                                        |                         62 |
| Optional cost inside an effect: `you may pay/sacrifice … If you do` |                         37 |
| `unless …` payment                                                  |                         26 |
| Player scope: `each opponent`, `each player`, `target opponent`     |                         10 |
| Reflexive sequencing: `When you do`, `If you don't`, `Otherwise`    |                          8 |
| Event pronouns: `that much`, `that many`, `that creature`           |                         10 |

The `Value` union in `value.ts` already has more than 60 kinds, including `xValue`,
`countPermanents` and `countTappedPermanents`. The gap is in the parser: each sentence regex
accepts its own fixed amount phrasing, so a value the engine can already compute is rejected in
most positions.

### Shared templates worth a rule each

These are the largest groups whose normalized template appears on more than one card. 308
templates cover 883 cards, so they are the only place where a sentence-level rule still pays:

| Template (normalized)                                                                                                                    | Cards |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| Karoo: `When this land enters, return a land you control to its owner's hand.`, plus the two `sacrifice it unless you return …` variants |    20 |
| Landscape and Panorama: `{M}, Sacrifice this land: Search … basic A, B, or C …`                                                          |    15 |
| `When this land enters, it deals 1 damage to target opponent.`                                                                           |    10 |
| `~ enters tapped unless a player has N or less life.`                                                                                    |    10 |
| Reveal lands: `As this land enters, you may reveal a/an A [or B] card …`                                                                 |     8 |
| `When this creature enters, each opponent discards a card.`                                                                              |     7 |
| `Prevent all combat damage that would be dealt this turn.` (Fog)                                                                         |     6 |
| `You control enchanted creature/permanent.` (Control Magic)                                                                              |     6 |
| `You may have this … enter as a copy of any …` (with and without "except")                                                               |     8 |
| `Target creature you control deals damage equal to its power to …` (bite)                                                                |     9 |
| `Counter target <type> spell.`                                                                                                           |     5 |
| Vivid lands: `~ enters tapped with N charge counters on it.`                                                                             |     5 |
| Medallions: `<Color> spells you cast cost {1} less to cast.`                                                                             |     4 |
| `~ doesn't untap during your untap step.`                                                                                                |     4 |
| `Untap all <type> you control during each other player's untap step.`                                                                    |     3 |

### Keywords

193 cards are blocked by a bare keyword line (82 keywords; the top 20 cover 110 cards): Modular
11, Toxic 10, Storm 9, Mobilize 8, Myriad 8, Umbra armor 7, Squad 6, Prowess 5, Living weapon 5,
Buyback 5, Exalted 4, Delve 4, Dredge 4, Choose a Background 4, Partner 4, and smaller counts.
Keywords with a cost are counted under other families by the classifier but are the same kind of
work: Madness 10, Encore 7, Ninjutsu 7, Foretell 6, Sneak 5, Eternalize 4, Embalm 4, Evoke 4,
Transmute 4, Freerunning 4, Warp 4, Offspring 4, Mayhem 4. None of these is in
`IMPLEMENTED_KEYWORDS` today.

### Trigger events

715 trigger lines fail at the event, and 208 of those fail only there. Across the 715, the most
common events are: you gain life (26), you attack (20), this is dealt damage (19), you cycle (13),
you discard (12), turned face up (10), a player or enchanted land taps for mana (15), compound
heads such as `enters or dies` and `enters or is put into a graveyard from the battlefield` (15),
you commit a crime (8), each player's draw step (8), you cast a historic or multicolored spell
(11), upkeep variants for opponents and enchanted players (13), you sacrifice a Food (5), you
scry (5), and you expend (5).

### Intervening-if conditions

178 trigger lines carry an intervening `if`. The most common are turn-history conditions (a
creature died, you gained life or gained N life, you attacked, you descended, a permanent left the
battlefield, an opponent lost life) and cast-history conditions (`if you cast it from your hand`,
`if you control your commander`). Most of the needed state already exists as `Value`s
(`creaturesDiedThisTurn`, `opponentsLostLifeThisTurn`). What is missing is the `Condition`
grammar over them.

## Decisions to make before Phase 3

- **D1. Verification bar for the bulk.** Recommendation: the full completion standard
  (clause-to-test manifest, engine, viewer and mutation evidence) for staples and for ranks 1 to
  2,000. Beyond rank 2,000, a card that becomes `modeled` through a generic rule is
  `implemented-unreviewed`. It is covered by that rule's primitive contract, its executor test, a
  golden snapshot and a seeded sample (see Phase 4). It is not listed as complete. The other
  options are the full standard everywhere (about 2,500 agent-hours) or interpreter-only, which
  the completion rule forbids calling done.
- **D2. Phrase-level grammar (proposed ADR 0038).** `interpret.ts` is 9,252 lines with about 400
  anchored regexes and card-shaped block parsers (`parseCounterUnlessFerociousBlock`,
  `parseDestroyThenLoseLifeEqualToManaValueBlock`). With 5,342 templates for 5,917 cards, adding
  sentence regexes does not scale. Recommendation: split effect parsing into composable slot
  parsers: amount (to `Value`), player scope, selector or target, duration, condition, and
  trigger event. Port the existing sentence rules onto them behind byte-identical
  `snapshots:check` for all 2,999 modeled cards. Rule 1 of the template layer still applies: no
  new `Effect` op comes from the grammar layer.
- **D3. Where Oracle text for these cards is pinned.** The ready list needs the gitignored
  Scryfall bank, which CI and cloud sessions do not have (this container could not reach
  Scryfall). Recommendation: add each card to `coverage-oracle.json` in the commit that models
  it, and add a ratchet like the staples `knownUnmodeled` one, so a modeled card that regresses
  fails offline. Pinning all 8,916 cards up front would add roughly 10 MB of fixture.
- **D4. Out of scope until a subsystem exists.** Face-down permanents (morph, disguise, "turned
  face up": 10 event cards plus Megamorph), voting, and the Ozolith-style "counters it had"
  last-known information. Each gets its own plan instead of being forced into this one.

## Phases

Each phase ends with `bun run snapshots:check`, the override `handledLines` drift sweep (a
generic rule can strand an override's claim, as happened twice in the Tier 1–2 work),
`bun run staples`, `bun run edhrec:ready-list` from a machine that has the bank, and the
`chore(benchmarks)` re-seal for engine changes. Main thread and subagent roles follow
`CLAUDE.md`: rules semantics and parser design stay on the main thread, Sonnet implements from
written decisions, and Haiku runs triage and reads test output.

### Phase 0: instrument (no modelling)

1. **`edhrec:triage`.** Build the appendix probe properly: real type lines from the bank instead of
   guessed ones, and a committed `edhrec-triage.json` with one record per card (rank, decks,
   blocker line, failing part, normalized template, closing single-feature rewrite). Add
   `--check` like the ready list. This is the work queue for every later phase.
2. **Staples ratchet stays as is.** Add the D3 ratchet for the ready list.
3. **Correct the probe's known misreads.** It guessed sorcery for Seedborn Muse and Mana Geyser
   and static for Finale of Devastation. The appendix numbers are approximate until step 1 lands.

Exit: the triage JSON reproduces 5,917 and the counts in this plan to within the probe's error.

### Phase 1: the 15 staples, full completion standard

Ordered so that each staple lands together with the generic rule it shares with other ranked
cards. Ranks are positions in the combined ranking, as in the ready list; the staples file ranks
nonland cards only, so its numbers are lower.

Three staples are not in the 5,917: Flusterstorm and The Ozolith each have two unparsed lines,
and Witch Enchanter is blocked by its layout.

| Staple                   | Rank | Blocker                                                                                          | Primitive and siblings                                                                                                                                     |
| ------------------------ | ---: | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ruby Medallion           |  287 | `Red spells you cast cost {1} less to cast.`                                                     | Parser over the `costReduction` rule static. Sapphire, Pearl, Emerald Medallion. Retire the Jet Medallion override.                                        |
| Urza's Incubator         |  305 | `Creature spells of the chosen type cost {2} less to cast.`                                      | Chosen-type filter on the same static. Chosen creature type exists (post-Tier-3 B5).                                                                       |
| Seedborn Muse            |  283 | `Untap all permanents you control during each other player's untap step.`                        | Tier 1.13, never landed: `untapStep` + `player: 'each'` + `untapEach`. Unwinding Clock, Drumbellower, Bender's Waterskin.                                  |
| Sun Titan                |  311 | `return target permanent card with mana value 3 or less from your graveyard to the battlefield`  | Target-clause MV qualifier on a graveyard card (Tier 1.12). Sevinne's Reclamation.                                                                         |
| Craterhoof Behemoth      |  290 | `+X/+X … where X is the number of creatures you control`                                         | First user of the D2 amount slot. Overwhelming Stampede (`greatest power`).                                                                                |
| Mana Geyser              |  285 | `Add {R} for each tapped land your opponents control.`                                           | Amount slot in mana production, using `countTappedPermanents`.                                                                                             |
| Finale of Devastation    |  292 | library and/or graveyard search, MV ≤ X, X ≥ 10 rider                                            | Amount slot plus a two-zone search. Chord of Calling and Green Sun's Zenith share the `MV X or less` tutor.                                                |
| Faerie Mastermind        |  282 | `{3}{U}: Each player draws a card.`                                                              | Player scope `each player` on `draw`. Geier Reach Sanitarium.                                                                                              |
| Aetherize                |  281 | `Return all attacking creatures to their owner's hand.`                                          | Mass bounce with an `attacking` selector, plus the singular possessive form from Tier 0.                                                                   |
| Shadowspear              |  299 | `Permanents your opponents control lose hexproof and indestructible until end of turn.`          | Layer-6 ability removal for named keywords until end of turn. Main-thread rules decision.                                                                  |
| Flusterstorm             |  303 | `Storm` + `counter … unless its controller pays {1}`                                             | Storm keyword (9 ranked cards: Grapeshot, Empty the Warrens, …). `unlessPays` already exists.                                                              |
| Phyrexian Metamorph      |  308 | `enter as a copy … except it's an artifact in addition to its other types`                       | Clone parser over the existing `entersAsCopy` (8 cards share the template). The "except" type addition is a copiable-values rule (CR 707.9b): main thread. |
| Witch Enchanter          |  284 | `unsupported layout "modal_dfc"`                                                                 | MDFC with a creature front (current MDFC support covers spell and land fronts).                                                                            |
| The Ozolith              |  298 | two lines: counters it had when it left; move all counters                                       | Last-known counters on leaves-the-battlefield, plus a counter-move effect. Ozolith, the Shattered Spire is separate (a replacement).                       |
| Braids, Arisen Nightmare |  306 | sacrifice; each opponent may sacrifice a permanent sharing a type, or lose 2 life while you draw | Bespoke override. The "for each opponent who doesn't" shape recurs too rarely for a rule.                                                                  |

Exit: `bun run staples --complete` passes at 200/200, `knownUnmodeled` is empty, and every staple
has a manifest entry, engine and viewer evidence and passing mutation.

### Phase 2: shared templates and keywords (about 1,000 cards, sentence rules still pay)

1. **Land templates first**, because they have the highest slot share per rule: karoo (20),
   Landscapes and Panoramas (15), ETB-ping lands (10), the life-threshold tapped lands (10),
   reveal lands (8), Vivid (5), Discover lands (5). Each template gets a rule, an executor
   test and the cards it closes listed in the commit.
2. **Other templates with three or more cards**, worked down the triage JSON in order of slot
   share: Fog, Control Magic, clone, bite, `each opponent discards`, `Counter target <type>
spell`, `doesn't untap`, `each player sacrifices`, `return from graveyard to battlefield
tapped`, and the others listed above.
3. **Keywords**, in order of ranked-card count: Modular, Toxic, Storm (if not done in Phase 1),
   Mobilize, Myriad, Umbra armor, Ninjutsu, Encore, Madness, Squad, Prowess, Living weapon,
   Buyback, Foretell, Exalted, Delve, Dredge, Eternalize, Transmute, Choose a Background. The main
   thread decides keyword semantics (ADR 0033 phase 5); each keyword is one primitive with a
   contract test.

Exit: every template with three or more cards is closed or has a recorded reason in the triage
JSON.

### Phase 3: phrase-level grammar (after D2 is decided)

1. **Refactor without behavior change.** Introduce the slot parsers and move the existing sentence
   rules onto them. Proof: byte-identical interpret and override snapshots, and an unchanged
   determinism test.
2. **Amount slot everywhere** (227 cards close on it alone): `X`, `for each <selector>`,
   `equal to <value>`, `where X is <value>`, `that much` and `that many`, mapped onto the existing
   `Value` kinds. Add a `Value` kind only where the triage JSON shows several cards need it.
3. **Condition grammar for intervening-if** (62 cards close on it alone; 178 lines involve it):
   turn-history and cast-history conditions over existing state, plus the counters added in
   post-Tier-3 3.A4.
4. **Trigger event vocabulary** (208 event-only cards, 715 lines with an event gap): gain life, you attack, is dealt damage,
   cycle or discard, taps for mana, cast with a spell filter (historic, multicolored, second spell
   each turn), scry or surveil, commit a crime, expend. Each event fires from one chokepoint with
   an executor test, the same discipline as Tier 3.A.
5. **Effect-internal costs and payments**: `you may <cost>. If you do, …` (37 cards),
   `unless <player> pays …` (26), reflexive `When you do` (8).
6. **Player-scope slot**: `each opponent`, `each player`, `target opponent`, `that player`.

Every step re-runs the triage, records the cards it closed, and spot-checks closed cards against
the "claimed but not implemented" false positive that Sage of Fables and Gev showed
(`facets.ts::facetMismatches` is the automated check).

### Phase 4: the tail, by engine surface and in rank order

What remains after Phase 3 is mostly one card per template. Work it in batches of about 25 cards
of the same surface family, in descending slot share, using the `card:new` and `card:finish`
workflow. These are the families from the probe:

| Surface family                                  | Cards | In ranks 1–2,000 | Slots |
| ----------------------------------------------- | ----: | ---------------: | ----: |
| Draw and discard                                |   480 |               63 | 2.47% |
| Library manipulation (look, reveal, mill, scry) |   407 |               49 | 1.97% |
| Counters (+1/+1, other, proliferate)            |   450 |               37 | 1.79% |
| Copy and clone                                  |   272 |               41 | 1.63% |
| Tokens                                          |   335 |               32 | 1.33% |
| Removal (destroy, exile, sacrifice, bounce)     |   280 |               33 | 1.28% |
| Pump and keyword grants                         |   280 |               29 | 1.25% |
| Replacement (`would … instead`)                 |   190 |               34 | 1.12% |
| Cost modification                               |   228 |               20 | 1.10% |
| Graveyard recursion                             |   232 |               24 | 1.03% |
| Damage                                          |   283 |               15 | 1.01% |
| Prevention, protection, hexproof grants         |   182 |               25 | 0.99% |
| Combat requirements and evasion                 |   181 |               22 | 0.87% |
| Cast and play permissions                       |   157 |               21 | 0.86% |
| Life                                            |   179 |               15 | 0.81% |
| Tutors                                          |   106 |               27 | 0.75% |
| Tap and untap                                   |   145 |               21 | 0.74% |
| Mana production and mana rules                  |   103 |               16 | 0.65% |
| Control change                                  |   155 |               11 | 0.57% |
| Type and characteristic change                  |   125 |               11 | 0.54% |
| Extra turns, win or lose, extra combat          |    58 |               13 | 0.42% |
| Chosen value (type, color, name)                |    58 |                8 | 0.34% |
| Counterspells                                   |    53 |                4 | 0.28% |
| Not classified                                  |   420 |               37 | 1.84% |

The families come from a keyword classifier and overlap at the edges (the karoo lands land in
"draw and discard" because of "hand"). Phase 0's triage JSON replaces them with the surface each
card's failing part actually needs.

Rules for the tail:

- **Ranks 1 to 2,000** meet the full completion standard, one manifest entry per card.
- **Ranks above 2,000** (if D1 is accepted): a card closed by a generic rule is
  `implemented-unreviewed`. Each batch draws a seeded 10% sample (at least 3 cards) and brings it
  to the full standard. A sample failure blocks the batch and goes back to the rule. A card that
  needs a bespoke override always meets the full standard, because nothing generic stands behind
  it.
- **Ranks above 8,000** (2,415 cards, 3.37% of slots) are last. Revisit the order once Phase 3's
  yield is measured.

## Expected yield

These are estimates, to be replaced by measurements as each phase lands:

| After   | Cards newly modeled | Basis                                                                            |
| ------- | ------------------: | -------------------------------------------------------------------------------- |
| Phase 1 |            15 + ~25 | Staples plus the template siblings named in the Phase 1 table                    |
| Phase 2 |         ~700 to 900 | 883 cards share templates, plus 193 keyword cards, with some overlap             |
| Phase 3 |         ~600 to 900 | 377 single-feature closes plus 208 event-only cards, plus what the slots compose |
| Phase 4 |           remainder | Mostly one card per template, by rank                                            |

Phase 4 is where the hours go. If D1 is accepted, the full-standard queue is the 665 cards ranked
1 to 2,000 plus the 10% samples, about 1,200 cards in total, which comes to roughly 500
agent-hours at the pilot median. Without D1, it is about 2,500.

## Risks

- **False positives.** A rule that claims a line but implements nothing reports `modeled: true`
  with the behavior missing. Every new rule needs an executor test, and every phase runs the
  `facetMismatches` check.
- **Stranded overrides.** Generic rules flip existing overrides back to `modeled: false` through
  the drift guard. Sweep after each phase, not only when regenerating snapshots.
- **Other lines on these cards are unverified.** "One line away" means the other lines parsed,
  not that they are right. Cards that go to the full standard will turn up existing parser bugs,
  as the Tier 0 bounce regex did. Fix those in separate commits with regression tests.
- **Benchmark churn.** Every engine change re-seals the AI benchmark pins. Batch engine changes
  per phase step so that re-seals do not dominate the commit history.
- **Ranking drift.** The ranking is frozen. Do not refreeze it during the work, or progress
  numbers stop being comparable.

## Appendix: how the numbers were produced

The Scryfall bank is not in this container, and Scryfall was unreachable (proxy 403). Every count
above therefore comes from the committed ready list, parsed back into 5,917 (rank, name, line)
rows, plus a throwaway probe that ran each line through the production `interpretCard` on a
synthetic card built with `supportCard`:

- **Type line.** `land` from the ranking's kind. Otherwise guessed from the text: Equipment, Aura,
  artifact, enchantment or land from "this …" wording, a creature for triggers, activations and
  statics, and a sorcery for the rest. The full line reproduces as unparsed on 5,914 of 5,917
  rows.
- **Part split.** A regex split each line into trigger event, intervening `if` and body, or into
  activation cost and effect. Each part was probed with a known-good partner (`you gain 1 life.`,
  `Draw a card.`), and bodies were probed as a sorcery.
- **Single-feature rewrites.** Each rewrite in the table above was applied to the full line alone.
  A card counts as closed by a rewrite when the rewritten line parses.
- **Templates.** Numbers, colors, basic land types, card types, mana symbols, P/T and capitalized
  subtypes were normalized, and lines were grouped on the result.
- **Slot share.** The ranking's deck counts divided by `totalSlots`.

The probe misreads some cards (see Phase 0 step 3), so the counts are accurate to a few percent,
which is enough for ordering the work. Phase 0 replaces the probe with a committed, checked tool.
