# Plan: modelling the EDHREC coverage list

Status: in progress. Phases retooled 2026-11-02 after decisions D1 to D4 below. Phase 1 steps 1
to 7 are done. Phase 3 is done (2026-11-03): all 15 staples
are modeled. Phase 2 is done; each subsystem lists the cards it still leaves open. See each phase's
status. Baseline: `253d682`. Scope: the 15 unmodeled EDHREC staples and the 5,917 cards in the
[EDHREC ready list](edhrec-ready-list.md) that are blocked by exactly one unparsed rules line.

Related: [EDH staple coverage](edh-staple-coverage.md) (earlier tiers),
[post-Tier-3 residue](post-tier3-card-coverage.md),
[faster card authoring](card-authoring-and-fail-loud.md),
[card coverage workflow](../guides/card-coverage-workflow.md), ADR
[0009](../decisions/0009-supported-pool-decks.md),
[0025](../decisions/0025-card-template-layer.md),
[0033](../decisions/0033-forge-informed-card-authoring.md) and
[0038](../decisions/0038-phrase-level-card-grammar.md).

## Summary

- **Staples (15 cards).** Eleven are one line away, and most of those lines are shared by other
  ranked cards. The other four need the subsystems in Phase 2: copy-with-exception for Phyrexian
  Metamorph, last-known counters for The Ozolith, and a creature front face on a modal DFC for Witch
  Enchanter, plus Storm for Flusterstorm.
- **The 5,917 cards.** "One line away" makes them sound cheap, but the lines barely repeat. There
  are 5,592 distinct lines, and after numbers, colors, types and mana symbols are normalized there
  are still 5,342 distinct templates. Only 883 cards (5.4% of slots) share a template with another
  card. A grammar rule for a whole sentence therefore closes about 1.1 cards. This matches ADR
  0009's finding that 94% of unparsed lines are unique to one card.
- **So the parser is rewritten first.** Rewriting one feature per line (amounts, intervening-if
  conditions, optional costs, `unless`) shows that a single phrase-level fix closes 377 cards on
  its own; amounts alone close 227. Generalizing the trigger-event vocabulary closes 208 more, and
  keywords close 193. Those gains come from composable phrase parsers, which the current
  sentence-regex parser cannot provide (ADR 0038).
- **Tests follow features, not cards (D1).** A card that only composes grammar and primitives
  already under test needs no tests of its own; it is pinned offline, covered by the
  interpretation snapshots (D3), and stays `implemented-unreviewed`. A card that adds a feature
  meets the full completion standard for it.

## Decisions (2026-11-02)

- **D1. Tests per feature, not per card.** A card is _simple_ when modeling it adds no new grammar
  production, `Effect` op, `Value`, `Condition` or `Selector` kind, trigger event, rule static,
  keyword or subsystem. A simple card gets no tests of its own: it is covered by the tests of the
  productions it uses, its Oracle text is pinned (D3), and its definition is in the interpretation
  snapshot. It counts as modeled and stays `implemented-unreviewed`. That is the state the
  [completion standard](../guides/card-modeling-and-testing.md) already gives every card the
  interpreter models without an audit, and nothing in this plan reports a simple card as complete
  or reviewed. A card that adds any of those features meets the full completion standard
  (`AGENTS.md`) for the clauses the feature covers: pinned Oracle text, a clause-to-test manifest
  entry, positive and negative engine scenarios, the normal cast or activation path, and
  real-viewer evidence. The feature's executor tests, plus a primitive contract test for a new op,
  serve as its engine evidence, so later simple cards reuse them.
- **D2. Rewrite the parser into phrase-level grammar** before adding coverage breadth.
  [ADR 0038](../decisions/0038-phrase-level-card-grammar.md) records the design.
- **D3. Pin Oracle text offline.** Every card this plan models has its Oracle record in a committed
  fixture, and a ratchet like the staples `knownUnmodeled` list fails offline when a modeled card
  regresses. The Scryfall bank is still needed to add new pins.
- **D4. Build the missing subsystems now** (Phase 2), rather than deferring the cards that need
  them: face-down exile and face-down permanents, voting, last-known counters, copy with
  exceptions, and modal DFCs with a permanent front face.

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

## Phases

Each phase ends with `bun run snapshots:check` (which includes the Phase 1.1 nets once they land),
the override `handledLines` drift sweep (a generic rule can strand an override's claim, as
happened twice in the Tier 1–2 work), `bun run staples`, and the `chore(benchmarks)` re-seal for
engine changes. Where the Scryfall bank is available, also run `bun run edhrec:ready-list` and
`bun run bulk-smoke`. Main-thread and subagent roles follow `CLAUDE.md`: rules semantics and parser
design stay on the main thread, Sonnet implements from written decisions, and Haiku runs triage
and reads test output.

### Phase 1: parser foundation (D2, D3)

Status (2026-11-03): steps 1 to 7 done.

- The nets are in `snapshots:check`, together with `edhrec:triage --check`.
- `cards/grammar/` holds `words`, `subject`, `amount`, `condition`, `cost`, `trigger-event`,
  `effect` and `diagnostics`. `interpret.ts` is down from 9,252 to 4,182 lines, and every net
  is unchanged.
- Step 4 is done as a move, not yet as a split. `parseEffectSentence` has 151 top-level branches,
  and 34 of them can match a sentence starting with any word, scattered between the
  verb-specific ones, so a mechanical split by verb could reorder matches the nets cannot see.
  Each verb family is instead rebuilt on the slot parsers when Phase 4 extends it, and its old
  branches are deleted once the nets show the rebuilt family produces the same definitions.
- [EDHREC triage](edhrec-triage.md) is the work queue: the failing slot of every one-line card.

The goal is a parser built from phrase parsers that report which slot failed, with no change to
any card's behavior. Each step is a pure refactor proven by the nets in step 1.1.

1. **Equivalence nets.** Widen the interpretation snapshot from the 93-card Ur-Dragon fixture to
   the full pinned fixture (`coverage-oracle.json`, 1,031 cards). Add the one-line probe corpus: the
   5,917 blocking lines on synthetic cards (see the appendix), with a snapshot of each line's
   outcome. A refactor must leave both unchanged. A coverage step's diff on the corpus is its
   measured yield.
2. **Extract the leaf phrase parsers** from `interpret.ts` into `packages/engine/src/cards/grammar/`:
   number and color words first, then amounts and subjects.
3. **Extract the remaining slots**: conditions, trigger events, durations, player scope, costs.
4. **Decompose `parseEffectSentence`.** It is about 1,900 lines of ordered sentence branches. It
   becomes a clause pipeline (subject, verb, object, amount, duration, condition) with a verb-keyed
   table, ported one verb family at a time. Card-shaped block parsers such as
   `parseCounterUnlessFerociousBlock` are re-expressed as compositions and deleted.
5. **Slot-failure reporting.** The parser records which slot failed, for example
   `unrecognized amount "the number of Shrines you control"`. The card-facing `unmodeledReasons`
   strings do not change; the detail goes into a separate diagnostics field.
6. **`edhrec:triage`.** A committed tool that reads those diagnostics over the ready list and writes
   the work queue for Phases 3 to 6, replacing the throwaway probe.
7. **Offline pins (D3).** A `coverage:pin` command copies the Oracle records of ready-list cards
   from the bank into a pinned fixture, and a ratchet records the modeled set. The command needs
   the bank, so it runs on a machine that has `data/scryfall-oracle-cards.json`.
   Done: `packages/server/fixtures/edhrec-pinned-oracle.json` pins 8,972 ready-list cards, one
   per line, and only ever adds or refreshes. `edhrec-modeled.json` records the 3,094 that model.
   `coverage:pin --check`, which runs in `snapshots:check`, fails offline on a regressed or
   unrecorded modeled card. So does `edhrec-pins.test.ts` in the card gate.

Exit: both nets unchanged through steps 2 to 5, and `interpret.ts` reduced to card assembly
(faces, layouts, keyword lines) over the grammar modules.

### Phase 2: subsystems (D4)

Status (2026-11-03): all five subsystems have landed; each lists the cards it still leaves open.

- **Last-known counters**: The Ozolith. A leave-the-battlefield head over another permanent reads
  "if it had counters on it" from the departed object's last-known facts (CR 603.10a). "Put
  those counters on ~" transfers them, and the new `moveAllCounters` op follows CR 122.5 (nothing
  moves when either object is gone or both are the same object).
- **Copy with exceptions**: Phyrexian Metamorph. `cards/grammar/copy.ts` reads "You may have this
  … enter as a copy of …, except …" into `entersAsCopy`. It covers copy candidates, added card
  types (copiable values, CR 707.9b, with a copy-of-a-copy test), "isn't legendary" and
  implemented keywords. Clone, Copy Artifact, Mirrormade, Clever Impersonator and nine more
  one-line cards close, and Sculpting Steel's override is retired. Added subtypes and supertypes
  ("it's a Bird in addition", Mockingbird) and quoted abilities stay unparsed.
- **Modal DFC with a permanent front face**: Witch Enchanter. A land face can be played whatever
  the front face is. A land-face permanent gets only that face's characteristics
  (`landFacePermanentDefinition`, CR 712.8f), so no front-face static, rule static or trigger
  reaches it.
- **Voting**: Plea for Power. The `councilVote` op (CR 701.38a) has every player vote once, in
  turn order starting with the controller, and each vote is a public event. The Will of the
  council template covers Tyrant's Choice, and `takeExtraTurn` covers Time Sieve and Temporal
  Manipulation. Still open: secret votes (Mob Verdict), Council's dilemma per-vote counts
  (Expropriate), extra votes (Brago's Representative), "whenever players finish voting"
  triggers, and outcomes that target.
- **Face-down permanents**: Nantuko Vigilante, Gudul Lurker, Hunted Bonebrute, Hooded Hydra
  and Innocuous Rat.
  - A "turned face up" trigger event (CR 708.8), queued by the turn-face-up special action.
  - Megamorph's +1/+1 counter (CR 702.37b).
  - Disguise's ward {2} on the face-down permanent (CR 702.168a). A manifested card does not
    get it.
  - "As this creature is turned face up, put N counters on it".
  - The `manifestDread` op (CR 701.62a).
  - Still open: cloak, turning permanents face down (Cyber Conversion), "its controller
    manifests dread" (needs the departed creature's last-known controller), and Vesuvan
    Shapeshifter.
- **Face-down exile**: Gonti, Lord of Luxury, Thief of Sanity and Praetor's Grasp.
  - The `exileFaceDownPlayable` op exiles a card face down from the top N or by search.
  - The permission to cast or play it lasts while the card stays exiled.
  - Only the player allowed to play it may look at it (CR 406.3), in both the spectator board
    and the AI's `PlayerView`. The AI view now also redacts a generic face-down exiled card.
  - "Mana of any type can be spent" makes every pip generic for that cast (`anyTypeCost`).
  - Still open: face-down piles (Hostile Negotiations, Riddles in the Dark), Scroll Rack and
    Memory Jar.

Each subsystem adds features, so each brings its own executor tests and contract tests (D1).
Main-thread rules decisions are listed for each.

| Subsystem                                | Cards in the 5,917 | Examples                                                               | Rules to settle on the main thread                                                                       |
| ---------------------------------------- | -----------------: | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Copy with exceptions                     |                 98 | Phyrexian Metamorph, Helm of the Host, Cursed Mirror, Thespian's Stage | CR 707.9: exceptions become copiable values; copy of a copy                                              |
| Face-down exile and face-down permanents |                 58 | Gonti, Praetor's Grasp, Thief of Sanity, Hooded Hydra, Scroll Rack     | CR 708: hidden information in `PlayerView`, morph, megamorph, disguise, manifest, cloak, turning face up |
| Voting                                   |                 25 | Expropriate, Selvala's Stampede, Plea for Power, Split Decision        | CR 701.38: vote order, extra votes; how the AI provider votes                                            |
| Last-known counters                      |                  6 | The Ozolith, Prize Pig, Host of the Hereafter, Vampire Hexmage         | CR 608.2h: counters a permanent had as it left; moving counters                                          |
| Modal DFC with a permanent front face    |                  — | Witch Enchanter // Witch-Blessed Meadow                                | CR 712: the front face's characteristics on the stack and the battlefield                                |

The counts are lines that mention the subsystem, from the probe. Face-down exile (cards exiled face
down that their owner may look at or play) is the smaller half and lands first; face-down
permanents need `PlayerView` privacy work and land second.

Exit: each subsystem has an executor test for every rule decision in the table, and the cards that
were waiting only on it are modeled or listed with the line that still blocks them.

### Phase 3: the 15 staples

Status (2026-11-03): done. `bun run staples --complete` passes at 200/200 and `knownUnmodeled`
is empty. Each staple has a scenario file in `packages/engine/tests/scenarios/` that the engine
runner and the Card Test Lab both play, a viewer flow in `runner-card-test-lab.spec.ts`, and a
manifest entry. Every staple stays `implemented-unreviewed` until a human review. Features beyond
the table below:

- Faerie Mastermind's "second card each turn" is now part of the trigger event
  (`ordinalThisTurn`), not an intervening-if. A third draw before the trigger resolves no longer
  counters it (CR 603.4), and a regression scenario covers it.
- Shadowspear uses a new timestamp-ordered layer-6 `removeKeywords`, so a later grant gives the
  keyword back (CR 613.7). Arcane Lighthouse's `denyKeywords` still holds against every grant.
- Flusterstorm adds the Storm keyword (CR 702.40a), which counts every player's spells cast
  before it this turn, and a general "Counter target <type> spell [unless …]" production.
- Finale of Devastation adds a two-zone search: library, graveyard or both, may find nothing
  (CR 701.19b), and a shuffle only when the library was searched.
- Braids is an override in a new `edhrec-staples` batch over a new
  `sacrificeThenOpponentsShareTypeOrPunish` op. Opponents answer in APNAP order and sacrifice
  together.

Ordered so that each staple lands together with the grammar it shares with other ranked cards.
Ranks are positions in the combined ranking, as in the ready list; the staples file ranks nonland
cards only, so its numbers are lower. Three staples are not in the 5,917: Flusterstorm and The
Ozolith each have two unparsed lines, and Witch Enchanter is blocked by its layout.

| Staple                   | Rank | Blocker                                                                                          | Primitive and siblings                                                                                                                   |
| ------------------------ | ---: | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ruby Medallion           |  287 | `Red spells you cast cost {1} less to cast.`                                                     | Cost-reduction subject slot over the `costReduction` rule static. Sapphire, Pearl, Emerald Medallion. Retire the Jet Medallion override. |
| Urza's Incubator         |  305 | `Creature spells of the chosen type cost {2} less to cast.`                                      | Chosen-type filter on the same static.                                                                                                   |
| Seedborn Muse            |  283 | `Untap all permanents you control during each other player's untap step.`                        | `untapStep` + `player: 'each'` + `untapEach`. Unwinding Clock, Drumbellower, Bender's Waterskin.                                         |
| Sun Titan                |  311 | `return target permanent card with mana value 3 or less from your graveyard to the battlefield`  | Mana-value qualifier in the graveyard target slot. Sevinne's Reclamation.                                                                |
| Craterhoof Behemoth      |  290 | `+X/+X … where X is the number of creatures you control`                                         | Amount slot. Overwhelming Stampede.                                                                                                      |
| Mana Geyser              |  285 | `Add {R} for each tapped land your opponents control.`                                           | Amount slot in mana production, using `countTappedPermanents`.                                                                           |
| Finale of Devastation    |  292 | library and/or graveyard search, MV ≤ X, X ≥ 10 rider                                            | Amount slot and a two-zone search. Chord of Calling, Green Sun's Zenith.                                                                 |
| Faerie Mastermind        |  282 | `{3}{U}: Each player draws a card.`                                                              | Player-scope slot on `draw`. Geier Reach Sanitarium.                                                                                     |
| Aetherize                |  281 | `Return all attacking creatures to their owner's hand.`                                          | Mass bounce with an `attacking` selector.                                                                                                |
| Shadowspear              |  299 | `Permanents your opponents control lose hexproof and indestructible until end of turn.`          | Layer-6 removal of named keywords until end of turn.                                                                                     |
| Flusterstorm             |  303 | `Storm` + `counter … unless its controller pays {1}`                                             | Storm keyword (9 ranked cards). `unlessPays` exists.                                                                                     |
| Phyrexian Metamorph      |  308 | `enter as a copy … except it's an artifact in addition to its other types`                       | Phase 2 copy with exceptions.                                                                                                            |
| Witch Enchanter          |  284 | `unsupported layout "modal_dfc"`                                                                 | Phase 2 modal DFC with a permanent front face.                                                                                           |
| The Ozolith              |  298 | counters it had when it left; move all counters                                                  | Phase 2 last-known counters.                                                                                                             |
| Braids, Arisen Nightmare |  306 | sacrifice; each opponent may sacrifice a permanent sharing a type, or lose 2 life while you draw | Bespoke override.                                                                                                                        |

Every staple except the Medallions after Ruby adds a feature, so each meets the full completion
standard (D1): a manifest entry, engine and viewer evidence, and passing mutation. Exit: `bun run staples --complete` passes
at 200/200 and `knownUnmodeled` is empty.

### Phase 4: grammar breadth

Status (2026-11-03): in progress. Two batches have landed, worked from the
[triage](edhrec-triage.md) queue (its largest effect-slot groups) rather than strictly in the
order below. The pinned ratchet is at 3,237 modeled.

- **Batch 1:** subjectless "gain N life", investigate, "each opponent discards", "target player
  mills", Fog, karoo returns, and "it deals N damage to target opponent". It also fixed
  "target opponent" being read as any player. The corpus net closes 97 cards.
- **Batch 2:** the "look at the top N" reveal and pick shapes. It also fixed Orb of Dragonkind,
  which searched its whole library instead of looking at the top seven. The corpus net closes
  28 cards.

Extend the Phase 1 slots, in order of the cards each closes:

1. **Amounts** (227 cards close on this alone): `X`, `for each <selector>`, `equal to <value>`,
   `where X is <value>`, `that much` and `that many`, mapped onto the existing `Value` kinds. Add a
   `Value` kind only where the triage shows several cards need it.
2. **Trigger events** (208 cards blocked only at the event; 715 lines with an event gap): gain
   life, you attack, is dealt damage, cycle or discard, taps for mana, cast with a spell filter
   (historic, multicolored, second spell each turn), scry or surveil, commit a crime, expend. Each
   event fires from one chokepoint with an executor test.
3. **Intervening-if conditions** (62 cards alone; 178 lines involve one): turn-history and
   cast-history conditions over state that mostly exists already.
4. **Effect-internal costs and payments**: `you may <cost>. If you do, …` (37 cards),
   `unless <player> pays …` (26), reflexive `When you do` (8).
5. **Player scope**: `each opponent`, `each player`, `target opponent`, `that player`.
6. **Keywords**, by ranked-card count: Modular, Toxic, Mobilize, Myriad, Umbra armor, Ninjutsu,
   Encore, Madness, Squad, Prowess, Living weapon, Buyback, Foretell, Exalted, Delve, Dredge,
   Eternalize, Transmute, Choose a Background, and the rest of the 82.

Each production or keyword is a feature and brings its tests. The cards it closes are simple cards
from then on and need no tests of their own (D1). Each step records its yield from the corpus net.

### Phase 5: shared templates

Whatever the Phase 4 slots do not already close among the 308 shared templates (883 cards). Lands
come first because they have the highest slot share per rule: karoo (20), Landscapes and Panoramas
(15), ETB-ping lands (10), the life-threshold tapped lands (10), reveal lands (8), Vivid (5),
Discover lands (5). Then Fog, Control Magic, bite, `each opponent discards`, `Counter target
<type> spell`, `doesn't untap`, `each player sacrifices`, and the rest of the table above.

### Phase 6: the tail, by engine surface and in rank order

What remains is mostly one card per template. Work it in batches of about 25 cards from the triage
queue, grouped by the surface the failing slot needs and ordered by slot share. A card that fits
existing productions is simple and is modeled, pinned and snapshotted. A card that needs a new
production meets the full standard for that production (D1). A card that needs a bespoke override
always meets the full standard, because
no generic production stands behind it. The families the probe found:

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
"draw and discard" because of "hand"). The Phase 1 triage replaces them with the slot that
actually fails.

## Expected yield

Estimates, replaced by the corpus net's measurements as each step lands:

| After   | Cards newly modeled | Basis                                                                                          |
| ------- | ------------------: | ---------------------------------------------------------------------------------------------- |
| Phase 1 |                   0 | Refactor only, by design                                                                       |
| Phase 2 |         ~100 to 150 | Cards waiting only on a subsystem                                                              |
| Phase 3 |            15 + ~25 | Staples plus the siblings named in the table                                                   |
| Phase 4 |     ~1,000 to 1,400 | 377 single-feature closes, 208 event-only cards, 193 keyword cards, and what the slots compose |
| Phase 5 |         ~300 to 600 | Shared templates the slots did not already close                                               |
| Phase 6 |           remainder | Mostly one card per template, by rank                                                          |

Under D1 the cost is per feature rather than per card, so after Phase 4 the effort is set by how
many new productions the tail needs, not by its 4,000-odd cards.

## Risks

- **False positives.** A production that claims a line but implements nothing reports
  `modeled: true` with the behavior missing. Under D1 a simple card has no test of its own to
  catch this, so every production needs an executor test that exercises it, and every phase runs
  `facets.ts::facetMismatches`.
- **Refactor drift.** The pinned fixture is 1,031 cards and the ready list spans 8,916, so the nets
  cannot see every card. Run `bulk-smoke` against the bank before each Phase 1 step merges, where
  the bank is available.
- **Stranded overrides.** Generic productions flip existing overrides back to `modeled: false`
  through the drift guard. Sweep after each step, not only when regenerating snapshots.
- **Other lines on these cards are unverified.** "One line away" means the other lines parsed, not
  that they are right. Fix bugs found that way in separate commits with regression tests.
- **Benchmark churn.** Every engine change re-seals the AI benchmark pins. Phase 1 is a refactor
  but still changes engine sources, so batch its steps to keep re-seals few.
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

The probe guesses some type lines wrong (it read Seedborn Muse and Mana Geyser as sorceries and
Finale of Devastation as a static), so the counts are accurate to a few percent, which is enough
for ordering the work. Phase 1 step 6 replaces the probe with a committed, checked tool.
