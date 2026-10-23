# Card coverage chunks: 302 cards to 906/906

Prepared 2026-10-06. Status: active; PR01 to PR07 are complete and PR08 is in progress. This plan divides the remaining work under
[complete card coverage](complete-card-coverage.md) into eleven original pull requests (PRs) of about 30
cards each. Each commit models one card. The scope, definition of done and completion gate in that
plan still apply. This document only orders the work and groups it into PRs.

## Baseline

The population is the frozen 906 unique Oracle IDs: the 12 committed coverage decks plus the
200 EDH staples. The plan was prepared from the working tree at `406b61c` (604/906). The current
numbers below were measured after PR07 for those original twelve decks and the staples. The
committed `packages/server/fixtures/coverage-oracle.json` now holds 958 cards because it also
includes the later white-black-control fixture. Default coverage includes that thirteenth deck.
For this plan's frozen 906-card population, exclude cards found only in white-black-control from
the fixture report, then union the remaining Oracle IDs with the 200 staples. PR08 keeps that
population fixed; the expanded default report is a separate inventory.

| Population            | Before PR01     | After PR01      | After PR02      | Main before PR03 | After PR03      | After PR04      | After PR05      | After PR06      | After PR07      | Remaining |
| --------------------- | --------------- | --------------- | --------------- | ---------------- | --------------- | --------------- | --------------- | --------------- | --------------- | --------: |
| Fixture decks         | 511/802 (63.7%) | 539/802 (67.2%) | 572/802 (71.3%) | 565/802 (70.4%)  | 591/802 (73.7%) | 612/802 (76.3%) | 635/802 (79.2%) | 663/802 (82.7%) | 691/802 (86.2%) |       111 |
| EDH staples           | 185/200 (92.5%) | 186/200 (93.0%) | 188/200 (94.0%) | 188/200 (94.0%)  | 189/200 (94.5%) | 189/200 (94.5%) | 189/200 (94.5%) | 189/200 (94.5%) | 189/200 (94.5%) |        11 |
| Combined unique cards | 604/906 (66.7%) | 633/906 (69.9%) | 666/906 (73.5%) | 659/906 (72.7%)  | 686/906 (75.7%) | 707/906 (78.0%) | 730/906 (80.6%) | 758/906 (83.7%) | 786/906 (86.8%) |       120 |

PR01 and PR02 landed exactly as planned: all 29 and all 33 cards are modeled, no card regressed,
and the remaining count for every deck matched the PR01 and PR02 columns below.

Main measured 659/906 before PR03, not 666. The card-engine quality merge (`9c7b93d`) landed after
the PR02 measurement and closed seven cards that had counted as modeled: Black Bolt, Inhuman King
(FF4) and Dingus Staff (PRA) now fail IR validation (an event-player reference with no event
scope); Sivitri, Dragon Master and Zurgo and Ojutai reject an executable `noOp`; and Bloomvine
Regent, Marang River Regent and Monster Manual are contained explicitly. No PR in this plan owns
them in the original eleven chunks; PR12 below now owns them. They stay in the remaining counts: the measured PR02 and PR03 columns below show them
as one extra card for PRA and FF4 and five for URD. The later columns are still the planned counts
without them.

PR03 modeled 27 of its 28 cards; Twilight Diviner moved to PR10 (see the PR03 section). No card
regressed: main plus those 27 cards gives exactly the 686 measured after PR03.

PR04 modeled its 21 cards (707 measured). PR05 modeled 23 of its 26 cards; Spirit Mantle and
Unquestioned Authority moved to PR11 and Tenuous Truce to PR06 (see the PR05 section). No card
regressed: main plus those 23 cards gives exactly the 730 measured after PR05.

PR06 modeled all 28 of its cards, including Human Torch and Tenuous Truce, which moved in from PR04
and PR05 (758 measured). No card regressed: main plus those 28 cards gives exactly the 758
measured after PR06, which is the planned 765 less the seven cards that main's quality merge had
already reopened and no PR owns yet (one each for PRA and FF4, five for URD).

PR07 modeled all 26 of its cards (786 measured). No card regressed: the 758 after PR06, plus
Bilbo's Gambit and Dark Confidant, which main's white-black control merge modeled ahead of PR10 and PR09,
plus the 26 gives exactly the 786 measured after PR07.

PR10 is in progress. Its stack retarget and spell-copy cards (Deflecting Swat, Reverberate, Bolt
Bend, Display of Power, Flare of Duplication, Galvanic Iteration and Cosmic Crucible) now have
production overrides and reviewed evidence, and Bilbo's Gambit, which main's white-black control
merge modeled ahead of PR10, is recorded with them. See [PR10 progress](pr10-progress.md).

When the plan was prepared, the 302 remaining cards fell into two groups (PR01 and PR02 have since
modeled 62 of them):

- **Fail-closed (193 cards).** An override exists, but the catalog audit found a semantic gap. The
  card reports `explicitly unsupported: …`, which names the exact gap. These are usually the
  smallest fixes. Each PR lists them first.
- **Unmodeled (109 cards).** These have no faithful override. They report unrecognized rules text,
  an unsupported layout or unsupported mana production.

`card-coverage-ledger.json` has a row for all 109 unmodeled cards and for 11 of the fail-closed
cards. The other 182 fail-closed cards came from the catalog audit and have no row yet. Five rows
were stale: Etali, Gut, Hunting Wilds, Vastwood Surge and Will of the Mardu were marked
`modeled-focused-tests-passed`, but the audit had closed them. PR01 corrected the rows for Hunting
Wilds, Vastwood Surge and Will of the Mardu; Etali and Gut remain stale until their own commits.
Each card's commit adds or corrects its row.

## Workflow

### One card per commit

- A commit models exactly one card, completely. It contains every clause, its tests and its ledger
  row. When the commit lands, coverage goes up by one and the tree is green.
- The commit for the first card that needs a shared primitive also contains that primitive. It
  includes a generic primitive test and the first card's wiring. Later cards in the PR reuse the
  primitive. Within each PR's table, cards that share a primitive should be done one after
  another. The listed order (fail-closed fixes first, then staples, then cards with fewer
  blockers) is the default. When a later card is the more natural introduction for a primitive,
  reorder the cards.
- Commit subject: `feat(cards): model <Card Name> (PRnn.mm)`. Use `fix(cards): …` for a
  fail-closed card whose override already exists. Use the row ID from the tables below.
- Each commit must satisfy [Modeling a Card and Testing It](../guides/card-modeling-and-testing.md),
  §7:
  - the pinned Oracle fixture and hash;
  - each clause mapped to a primitive and to positive and negative tests;
  - whole-game cast or activation through legality, priority and the stack;
  - the Card Test Lab scenario and the manifest entry;
  - snapshot regeneration that was reviewed rather than accepted blindly.
- Do not approximate. If a card turns out to need a primitive that a later PR owns, move the card
  to that PR in this document, in its own commit. Do not ship a partial override. The card stays
  fail-closed until every clause is faithful.

### About 30 cards per PR

- Branch per PR, for example `cards/pr03-zone-history`. Open the PR when every card in its table
  is modeled, or earlier as a draft.
- Run these before opening the PR: `bun run test`, `typecheck`, `typecheck:tests`, `lint`,
  `format:check`, `test:card-gate`, `snapshots:check`, both coverage reports, and `test:e2e`, which
  covers the Card Test Lab scenarios that were added. Run `test:e2e:setup` and the web build when
  a PR adds a new decision kind or choice UI.
- The PR body lists every card with its Oracle ID, the primitives introduced, test paths and the
  coverage delta. It follows the per-clause checklist in the modeling guide.
- After merging, regenerate the progression table below from real output. If the measured count
  differs from the planned count, record the difference rather than adjusting the denominator.
- For each deck that reaches full coverage, run the fixed-seed heuristic, random and replay
  acceptance games from [complete card coverage](complete-card-coverage.md#verification-and-definition-of-done).

### Dependency order

```text
PR01 targeting/resolution ─┬─> PR03 zone history ─> PR04 counters/history ─> PR06 combat events ─> PR07 combat restrictions ─> PR08 control/choices
PR02 costs ────────────────┼─> PR05 auras/equipment (needs PR02, PR03)
                           └─> PR09 library/free cast (needs PR02, PR08) ─> PR10 stack/copy/characteristics ─> PR11 protection/layouts/lifecycle
```

PR01 and PR02 are independent and can run in parallel. PR05 can run in parallel with PR04 through
PR08 once PR02 and PR03 have landed. All other PRs follow the arrows.

## PR overview

| PR   | Theme                                            | Cards | Fail-closed | Staples |         Combined after |
| ---- | ------------------------------------------------ | ----: | ----------: | ------: | ---------------------: |
| PR01 | Targeting, optional choices, resolution fidelity |    29 |          25 |       1 |                633/906 |
| PR02 | Activation and casting costs                     |    33 |          32 |       2 |                666/906 |
| PR03 | Zone-change history, LKI, death and return       |    27 |          20 |       1 | 693/906 (686 measured) |
| PR04 | Counters and turn history                        |    21 |           5 |       0 | 714/906 (707 measured) |
| PR05 | Auras, Equipment, attachment lifecycle           |    23 |          23 |       0 | 737/906 (730 measured) |
| PR06 | Combat and damage events, damage prevention      |    28 |          21 |       0 | 765/906 (758 measured) |
| PR07 | Combat requirements, restrictions, extra combats |    26 |          11 |       0 | 791/906 (786 measured) |
| PR08 | Control changes and multiplayer choices          |    23 |          10 |       1 |                814/906 |
| PR09 | Library access and casting during resolution     |    31 |          13 |       1 |                845/906 |
| PR10 | Stack manipulation, copying, characteristics     |    31 |          18 |       2 |                876/906 |
| PR11 | Protection, phasing, layouts, game lifecycle     |    30 |          15 |       7 |                906/906 |

### Remaining cards per deck after each PR

Deck codes: BRI Brigid, DRA Draconic Destruction, LEN Living Energy, MAR Marchesa the Black Rose,
NEC Necron Dynasties, PRA Pramikon, QMQ Queen Marchesa, RUB Ruby, SIL Silverquill Influence,
FF4 Fantastic Four, TOK Token Triumph, URD Urdragon, S EDH staples. A card that appears in
several decks counts in each of them.

| Deck | Start | PR01 | PR02 | PR03 | PR04 | PR05 | PR06 | PR07 | PR08 | PR09 | PR10 | PR11 |
| ---- | ----: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BRI  |    24 |   22 |   22 |   21 |   11 |   11 |   11 |    9 |    8 |    6 |    4 |    0 |
| DRA  |    14 |   10 |    9 |    9 |    9 |    9 |    3 |    3 |    3 |    2 |    0 |    0 |
| LEN  |    19 |   17 |   11 |   11 |   10 |   10 |    9 |    8 |    7 |    4 |    0 |    0 |
| MAR  |    31 |   30 |   23 |   14 |   11 |   11 |   11 |   10 |    8 |    7 |    1 |    0 |
| NEC  |    37 |   31 |   23 |   14 |   13 |   10 |    9 |    7 |    7 |    5 |    3 |    0 |
| PRA  |    36 |   35 |   36 |   33 |   33 |   33 |   25 |   16 |    6 |    5 |    3 |    0 |
| QMQ  |    39 |   38 |   35 |   34 |   34 |   33 |   22 |   18 |   11 |    9 |    5 |    0 |
| RUB  |    21 |   16 |   15 |   13 |   12 |   12 |   11 |   10 |   10 |    1 |    0 |    0 |
| SIL  |    40 |   38 |   35 |   35 |   35 |   18 |   14 |   10 |    9 |    5 |    5 |    0 |
| FF4  |    31 |   31 |   32 |   32 |   27 |   27 |   24 |   19 |   16 |    9 |    2 |    0 |
| TOK  |    13 |    8 |    4 |    3 |    3 |    1 |    1 |    0 |    0 |    0 |    0 |    0 |
| URD  |     3 |    2 |    7 |    7 |    7 |    7 |    1 |    0 |    0 |    0 |    0 |    0 |
| S    |    15 |   14 |   12 |   11 |   11 |   11 |   11 |   11 |   10 |    9 |    7 |    0 |

## PR sections

Every PR starts by checking which consumers already exist. Some of the primitives below may
already work in part. Reuse what works before adding new IR variants. The primitives listed for a
PR describe what its cards need. They do not prove the support is missing.

### PR01: Targeting, optional choices, resolution fidelity

Depends on: none. Most of these cards are fail-closed and each has one narrow gap, which makes this
the fastest PR.

- Zero targets for "up to N" and "any number of": legal actions must offer the empty choice.
  Optional "you may … target" is a choice, not a required target.
- Modal spells and triggers require targets only for the modes that were chosen. Applies to Return
  to Nature, Aether Channeler and Will of the Mardu. Will of the Mardu also needs "a commander" to
  mean any commander you control, not only your own.
- Searches: the found cards are publicly revealed, optional searches can be declined, and filters
  cover same name as a chosen land and Vehicle as a subtype. "Shuffle this into its owner's
  library" moves the resolving card.
- Selectors and values: the tapped creatures you control, lieutenant buffs for creatures only,
  "entered this turn", and eliminated players excluded from opponent counts.
- Conditional enters-tapped plus an "enters untapped" trigger (Mystic Sanctuary). Reflexive "when
  you do" after an enters-sacrifice (Brokers Hideout). The surveil keyword action. Choosing the
  returned card after the mill resolves (Tomb Fortress).

|    # | Card                    | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                                              |
| ---: | ----------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.01 | Forum of Amity          | SIL        | fail-closed | Surveil is claimed without a surveil implementation.                                                                                                   |
| 1.02 | Attune with Aether      | LEN        | fail-closed | The basic-land search omits revealing the found card.                                                                                                  |
| 1.03 | Beacon of Unrest        | NEC        | fail-closed | Shuffle this into its owner's library is implemented as shuffleLibrary only.                                                                           |
| 1.04 | Canoptek Spyder         | NEC        | fail-closed | Vehicle is selected as a type rather than a subtype, so Vehicles do not trigger the draw.                                                              |
| 1.05 | Canoptek Wraith         | NEC        | fail-closed | Same-name-as-chosen-land search is implemented as any two basics.                                                                                      |
| 1.06 | Conjurer's Closet       | LEN        | fail-closed | Optional exile-and-return is implemented as an untargeted choice among creatures you control.                                                          |
| 1.07 | Harvest Season          | TOK        | fail-closed | X counts all creatures you control rather than tapped creatures.                                                                                       |
| 1.08 | Land Tax                | SIL        | fail-closed | The upkeep search is mandatory and omits revealing the found cards.                                                                                    |
| 1.09 | Mordant Dragon          | DRA        | fail-closed | Optional combat-damage rider is a required target.                                                                                                     |
| 1.10 | Necron Deathmark        | NEC        | fail-closed | Destroy up-to-one is a required target.                                                                                                                |
| 1.11 | Plasmancer              | NEC        | fail-closed | The Swamp search omits revealing the found card.                                                                                                       |
| 1.12 | Sylvan Reclamation      | TOK        | fail-closed | Up-to-two exile requires at least one target.                                                                                                          |
| 1.13 | Thunderfoot Baloth      | RUB, TOK   | fail-closed | Lieutenant +2/+2 and trample apply to all permanents you control, not just creatures.                                                                  |
| 1.14 | Tomb Fortress           | NEC        | fail-closed | The creature return is a target chosen before milling.                                                                                                 |
| 1.15 | Voice of Many           | TOK        | fail-closed | Eliminated players still count as opponents who control fewer creatures.                                                                               |
| 1.16 | Foe-Razer Regent        | DRA        | fail-closed | Optional fight still requires a target creature you don't control.                                                                                     |
| 1.17 | Hunting Wilds           | RUB        | fail-closed | The Forest search omits revealing the found cards.                                                                                                     |
| 1.18 | Loran of the Third Path | QMQ        | fail-closed | Up-to-one destroy is a required target.                                                                                                                |
| 1.19 | Rishkar, Peema Renegade | BRI, TOK   | fail-closed | Up-to-two +1/+1 counters require at least one target.                                                                                                  |
| 1.20 | Vastwood Surge          | RUB        | fail-closed | The basic-land search omits revealing the found cards.                                                                                                 |
| 1.21 | Frontier Siege          | DRA        | fail-closed | The Dragons fight option still requires a target creature you don't control.                                                                           |
| 1.22 | Kairi, the Swirling Sky | URD        | fail-closed | Return-any-number targeting with total mana value 6 or less is an untargeted single bounce with no mana-value cap.                                     |
| 1.23 | Will of the Mardu       | BRI        | fail-closed | Choose-both requires controlling your own commander, not any commander you control.                                                                    |
| 1.24 | Aether Channeler        | MAR        | fail-closed | Return-another-target bounce is implemented as untargeted returnOneToHand.                                                                             |
| 1.25 | Return to Nature        | DRA        | fail-closed | Choose-one still requires targets for every mode.                                                                                                      |
| 1.26 | Mystic Sanctuary        | S          | unmodeled   | ~ enters tapped unless you control three or more other Islands. (+1)                                                                                   |
| 1.27 | Brokers Hideout         | PRA        | unmodeled   | When this land enters, sacrifice it. When you do, search your library for a basic Forest, Plains, or Island card, put it onto the battlefield tapped,… |
| 1.28 | Sweet-Gum Recluse       | RUB        | unmodeled   | When this creature enters, put three +1/+1 counters on each of any number of target creatures that entered this turn.                                  |
| 1.29 | Kogla, the Titan Ape    | RUB        | unmodeled   | When ~ enters, it fights up to one target creature you don't control. (+2)                                                                             |

### PR02: Activation and casting costs

Depends on: none. The W2 support for kicker, squad, offspring, escalate, affinity and Phyrexian
mana is the base.

- Ability composition: an authored activated, mana or static list must merge with the parsed
  abilities, not replace them. Applies to Aether Hub, Solar Transformer, Retrofitter Foundry and
  Bespoke Battlewagon's crew.
- Cost shapes:
  - sacrifice a creature, including the source;
  - tap N untapped creatures, including the source;
  - remove a counter from any creature you control;
  - sacrifice as part of a mana ability's cost (Illuminor Szeras);
  - exhaust with an energy cost;
  - discard this card from hand (Kogla and Yidaro).
- Activation conditions: three or more lands with the same name, an opponent controls more lands,
  you created a token this turn. Put a card on the bottom of the library rather than the top
  (Mistveil Plains).
- Alternative casting:
  - sacrifice a nontoken creature of a given color (the Flares);
  - {B} with thirteen creatures (Blasphemous Edict);
  - cast from the graveyard: an alternative mana cost, flashback with a sacrifice cost, and a
    plain graveyard cast;
  - pay life equal to mana value from hand or graveyard (Anrakyr).
- Additional costs and cost keywords: pay X life on announcement (Toxic Deluge; see
  [fail-closed restoration](fail-closed-card-restoration.md)), convoke as a real payment,
  replicate, morph face-down casting, and granted foretell.
- Cost reductions for graveyard activations, Boast activations and spells that target a creature.

|    # | Card                     | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                  |
| ---: | ------------------------ | ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| 2.01 | Idol of Oblivion         | TOK, S     | fail-closed | The draw restriction is a resolution no-op, and the token is an Eldrazi Construct artifact instead of an Eldrazi creature. |
| 2.02 | Toxic Deluge             | MAR, S     | fail-closed | Pay-X-life additional cost is implemented as loseLife on resolution.                                                       |
| 2.03 | Retrofitter Foundry      | LEN        | fail-closed | The {2}, {T} Servo creation is dropped when activatedAbilities replace the parsed abilities.                               |
| 2.04 | Anrakyr the Traveller    | NEC        | fail-closed | Artifact-from-hand-or-graveyard life cast is implemented as free casts from hand.                                          |
| 2.05 | Carrion Feeder           | MAR        | fail-closed | Sacrifice-a-creature cost uses sacrificeOther, which cannot sacrifice this creature.                                       |
| 2.06 | Conclave Tribunal        | TOK        | fail-closed | Convoke is stored as a ruleStatic but never offered as a payment.                                                          |
| 2.07 | Convergence of Dominion  | NEC        | fail-closed | Graveyard activation cost reduction is claimed without a static effect.                                                    |
| 2.08 | Dragonkin Berserker      | DRA        | fail-closed | Boast cost reduction applies only to this creature, not to Boast abilities you activate.                                   |
| 2.09 | Dread Return             | NEC        | fail-closed | Flashback—Sacrifice three creatures is claimed without a flashback alternative.                                            |
| 2.10 | Endless Atlas            | NEC        | fail-closed | The three-or-more-same-name land restriction is omitted from the draw ability.                                             |
| 2.11 | Flare of Denial          | MAR        | fail-closed | Sacrifice-a-nontoken-blue-creature alternative cost is claimed without an alternativeCast.                                 |
| 2.12 | Ghost Ark                | NEC        | fail-closed | Becomes-crewed is implemented as becomesTapped.                                                                            |
| 2.13 | Grim Haruspex            | MAR        | fail-closed | Morph cost is stored but never offered as a face-down alternative cast.                                                    |
| 2.14 | Hour of Reckoning        | TOK        | fail-closed | Convoke is stored as a ruleStatic but never offered as a payment.                                                          |
| 2.15 | Illuminor Szeras         | NEC        | fail-closed | Sacrifice-another-creature is an effect, not a cost.                                                                       |
| 2.16 | Killian, Ink Duelist     | SIL        | fail-closed | Spells-that-target-a-creature reduction is implemented as creature-spell reduction.                                        |
| 2.17 | Mistveil Plains          | QMQ        | fail-closed | Bottom-of-library is implemented as graveyardToLibraryTop.                                                                 |
| 2.18 | Nullmage Shepherd        | TOK        | fail-closed | The four creatures cannot include this creature.                                                                           |
| 2.19 | Raffine's Guidance       | SIL        | fail-closed | Graveyard recast is implemented as a return-to-hand activated ability.                                                     |
| 2.20 | Sage of Fables           | MAR        | fail-closed | Remove-a-counter cost is paid from this creature, not a creature you control.                                              |
| 2.21 | Sceptre of Eternal Glory | NEC        | fail-closed | The three-or-more-same-name land restriction is omitted from the three-mana ability.                                       |
| 2.22 | Weathered Wayfarer       | QMQ        | fail-closed | Opponent-controls-more-lands restriction is omitted from the search activation.                                            |
| 2.23 | Aether Hub               | LEN        | fail-closed | The colorless mana ability is dropped when the energy mana ability replaces manaAbilities.                                 |
| 2.24 | Blasphemous Edict        | MAR        | fail-closed | The thirteen-creature {B} alternative cost is claimed without an alternativeCast.                                          |
| 2.25 | Changing Loyalty         | SIL        | fail-closed | Replicate is claimed without a replicate implementation.                                                                   |
| 2.26 | Dream Devourer           | QMQ        | fail-closed | Foretell grant is omitted, and the pump fires on any spell you cast.                                                       |
| 2.27 | Flare of Malice          | MAR        | fail-closed | Sacrifice-a-nontoken-black-creature alternative cost is claimed without an alternativeCast.                                |
| 2.28 | Peema Trailblazer        | LEN        | fail-closed | Exhaust is omitted, and the ability requires tapping this creature.                                                        |
| 2.29 | Solar Transformer        | LEN        | fail-closed | The colorless mana ability is dropped when the energy mana ability replaces manaAbilities.                                 |
| 2.30 | Soul-Guide Lantern       | LEN        | fail-closed | Opponent-graveyard exile is authored with a free draw instead of a separate {1} draw ability.                              |
| 2.31 | Their Number Is Legion   | NEC        | fail-closed | Tokens are not created tapped, and graveyard cast is omitted.                                                              |
| 2.32 | Bespoke Battlewagon      | LEN        | fail-closed | Crew 4 is dropped when the energy activations replace the parsed activated abilities.                                      |
| 2.33 | Kogla and Yidaro         | RUB        | unmodeled   | When ~ enters, choose one — (+3)                                                                                           |

### PR03: Zone-change history, LKI, death and return

Depends on: PR01.

- Enter events record their origin zone ("enters from a graveyard"). Cast records hold the origin
  zone, whether mana was spent and whether the card was cast at all ("if you cast it"). Cast
  triggers can be scoped to opponents.
- "Leaves the battlefield" differs from "dies", and "put into exile from the battlefield" is
  handled. Exile from the library or graveyard must be a real zone change, so that leave-graveyard
  triggers fire (Scavenging Ooze, Imotekh, Etali in PR09).
- Persist and undying replacements. Delayed returns that are tapped, at the next end step, or under
  the owner's control (Flickerwisp, Venser, Cryptek, Puppeteer Clique).
- Living Death sacrifices rather than destroys. Multi-select with a total mana value cap
  (Technomancer). Victimize sacrifices, then returns the chosen cards.
- Last-known power comparisons (Body Launderer's connive and its return). Granted enters/leaves
  triggers on commanders (Candlekeep Sage). Placing a card third from the top (God-Eternal Rhonas).
  A cast trigger for spells with cascade that works from the graveyard (Aurora Phoenix).

|    # | Card                         | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                                              |
| ---: | ---------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.01 | Canoptek Tomb Sentinel       | NEC        | fail-closed | Enters-from-graveyard is implemented as any enter, and up-to-one is a required target.                                                                 |
| 3.02 | Cryptek                      | NEC        | fail-closed | The delayed return omits entering tapped.                                                                                                              |
| 3.03 | Glen Elendra Archmage        | MAR        | fail-closed | Persist is claimed without a persist/undying replacement.                                                                                              |
| 3.04 | Kambal, Consul of Allocation | QMQ        | fail-closed | Opponent-casts is implemented as caster each, so your own noncreature spells also trigger.                                                             |
| 3.05 | Living Death                 | NEC        | fail-closed | Battlefield creatures are put into graveyards instead of being sacrificed.                                                                             |
| 3.06 | Psychomancer                 | NEC        | fail-closed | Exile-from-battlefield is omitted, and loseLife hits the controller instead of the targeted opponent.                                                  |
| 3.07 | Satoru, the Infiltrator      | MAR        | fail-closed | Enter trigger omits the not-cast-or-no-mana-spent restriction.                                                                                         |
| 3.08 | Scavenging Ooze              | TOK        | fail-closed | Exile splices the card without a zone-change, so leave-graveyard events are skipped.                                                                   |
| 3.09 | Shard of the Nightbringer    | NEC        | fail-closed | The if-you-cast-it intervening if is omitted.                                                                                                          |
| 3.10 | Technomancer                 | NEC        | fail-closed | Zero-mana artifact creatures cannot be returned once remaining mana value hits 0.                                                                      |
| 3.11 | Triarch Praetorian           | NEC        | fail-closed | Enters-from-graveyard is implemented as any enter.                                                                                                     |
| 3.12 | Twilight Diviner             | MAR        | moved       | Moved to PR10 as 10.31: the token copies one of the entering creatures, which needs its copiable values (CR 707.2).                                    |
| 3.13 | Watcher for Tomorrow         | MAR        | fail-closed | Leaves-the-battlefield is implemented as dies.                                                                                                         |
| 3.14 | Body Launderer               | MAR        | fail-closed | Connive is approximated as unconditional +1/+1, and the return trigger omits equal-or-lesser power.                                                    |
| 3.15 | Flayer of the Hatebound      | MAR        | fail-closed | Enters-from-graveyard is implemented as any creature you control entering.                                                                             |
| 3.16 | Gleeful Arsonist             | MAR        | fail-closed | Undying is claimed without a persist/undying replacement.                                                                                              |
| 3.17 | Imotekh the Stormlord        | NEC        | fail-closed | The artifact-cards-leave-graveyard trigger is claimed without an implementation.                                                                       |
| 3.18 | Puppeteer Clique             | MAR        | fail-closed | Stolen creature is not exiled at the beginning of the next end step.                                                                                   |
| 3.19 | Shard of the Void Dragon     | NEC        | fail-closed | Exile-from-battlefield is omitted from the artifact-leaves trigger.                                                                                    |
| 3.20 | The Ooze                     | MAR        | fail-closed | Leaves-the-battlefield is implemented as dies.                                                                                                         |
| 3.21 | River Kelpie                 | MAR        | fail-closed | Graveyard-origin enters and cast triggers fire on any enter or cast.                                                                                   |
| 3.22 | Victimize                    | S          | unmodeled   | Choose two target creature cards in your graveyard. Sacrifice a creature. If you do, return the chosen cards to the battlefield tapped.                |
| 3.23 | Aurora Phoenix               | RUB        | unmodeled   | Whenever you cast a spell with cascade, return this card from your graveyard to your hand.                                                             |
| 3.24 | Candlekeep Sage              | PRA        | unmodeled   | Commander creatures you own have "When this creature enters or leaves the battlefield, draw a card."                                                   |
| 3.25 | Flickerwisp                  | PRA        | unmodeled   | When this creature enters, exile another target permanent. Return that card to the battlefield under its owner's control at the beginning of the next… |
| 3.26 | Keeper of Secrets            | RUB        | unmodeled   | Symphony of Pain — Whenever you cast a spell from anywhere other than your hand, this creature deals damage equal to that spell's mana value to targe… |
| 3.27 | God-Eternal Rhonas           | BRI        | unmodeled   | When ~ enters, double the power of each other creature you control until end of turn. Those creatures gain vigilance until end of turn. (+1)           |
| 3.28 | Venser, the Sojourner        | PRA        | unmodeled   | +2: Exile target permanent you own. Return it to the battlefield under your control at the beginning of the next end step. (+2)                        |

Twilight Diviner (3.12) moved to PR10. Its trigger creates "a token that's a copy of one of them":
the copy needs the entering creature's copiable values (CR 707.2), last-known if it has already
left (CR 608.2h), and the ability "triggers only once each turn". Both are PR10 copy work, so its
commit lands there instead of approximating the copy here.

### PR04: Counters and turn history

Depends on: PR03, for last-known counters.

- Counters on a creature that died, read through last-known information (Iron Apprentice). Enters
  with counters as a replacement effect: Sautekh Immortal, and the graft keyword (Vigean
  Graftmage).
- Triggers on counters being put on a permanent, with once-each-turn limits and increment (Pensive
  Professor, Mikey & Leo).
- Move counters, double each kind of counter, and bolster.
- Counts of how many times an ability has resolved this turn (Belladonna Took, Rumor Gatherer).
- Spell history: total mana value cast this turn, colors of spells cast, "your fourth noncreature
  spell", whether you cast a noncreature spell this turn, and whether a spell was cast during your
  main phase.
- Attack-group size, "power greater than base power" and base power/toughness selectors.
  Reflexive "pay; when you do" (Human Torch, Lockjaw, The Thing).

|    # | Card                           | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                                              |
| ---: | ------------------------------ | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.01 | Iron Apprentice                | MAR        | fail-closed | The dies intervening-if checks the battlefield, so it never sees this creature's counters.                                                             |
| 4.02 | Sautekh Immortal               | NEC        | fail-closed | Enters-with counters is implemented as an enters trigger.                                                                                              |
| 4.03 | Pensive Professor              | MAR        | fail-closed | Increment is claimed, and the draw trigger fires on damage instead of counters being placed.                                                           |
| 4.04 | Vigean Graftmage               | MAR        | fail-closed | Graft is claimed without enters-with-counters or move-counter behavior.                                                                                |
| 4.05 | Aetheric Amplifier             | LEN        | fail-closed | Choose-one is implemented as two independent activated abilities.                                                                                      |
| 4.06 | Belladonna Took                | BRI        | unmodeled   | Whenever a token you control enters, you gain 1 life if this is the first time this ability has resolved this turn. If it's the second time, draw a c… |
| 4.07 | Call Forth the Tempest         | RUB        | unmodeled   | ~ deals damage to each creature your opponents control equal to the total mana value of other spells you've cast this turn.                            |
| 4.08 | Captain America, Skybound      | BRI        | unmodeled   | Whenever ~ and at least two other creatures attack, put a +1/+1 counter on each attacking creature. They gain indestructible until end of turn.        |
| 4.09 | Crystal, Inhuman Princess      | FF4        | unmodeled   | Whenever you cast a noncreature spell, ~ deals X damage to each opponent, where X is the number of colors that spell is.                               |
| 4.10 | Finneas, Ace Archer            | BRI        | unmodeled   | Whenever ~ attacks, put a +1/+1 counter on each other creature you control that's a token or a Rabbit. Then if creatures you control have total power… |
| 4.11 | First Family                   | FF4        | unmodeled   | You draw X cards and gain X life, where X is the number of colors among permanents you control and spells you've cast this turn.                       |
| 4.12 | Forgotten Ancient              | BRI        | unmodeled   | At the beginning of your upkeep, you may move any number of +1/+1 counters from this creature onto other creatures.                                    |
| 4.13 | Kutzil, Malamet Exemplar       | BRI        | unmodeled   | Whenever one or more creatures you control each with power greater than its base power deals combat damage to a player, draw a card.                   |
| 4.14 | Lockjaw, Slobbering Teleporter | FF4        | unmodeled   | At the beginning of combat on your turn, if you've cast a noncreature spell this turn, put a +1/+1 counter on ~. When you do, ~ and up to one other t… |
| 4.15 | Mikey & Leo, Chaos & Order     | BRI        | unmodeled   | Whenever you put a counter on a creature you control, draw a card. This ability triggers only once each turn.                                          |
| 4.16 | Rumor Gatherer                 | BRI        | unmodeled   | Whenever another creature you control enters, scry 1. If this is the second time this ability has resolved this turn, draw a card instead.             |
| 4.17 | The Thing                      | FF4        | unmodeled   | Whenever ~ attacks, you may pay {R}{G}{W}{U}. When you do, double the number of each kind of counter on any number of target permanents you control.   |
| 4.18 | Unbreakable Formation          | BRI        | unmodeled   | If you cast this spell during your main phase, put a +1/+1 counter on each of those creatures and they gain vigilance until end of turn.               |
| 4.19 | Bess, Soul Nourisher           | BRI        | unmodeled   | Whenever one or more other creatures you control with base power and toughness 1/1 enter, put a +1/+1 counter on ~. (+1)                               |
| 4.20 | Elite Scaleguard               | BRI        | unmodeled   | When this creature enters, bolster 2. (+1)                                                                                                             |
| 4.21 | Human Torch                    | FF4        | moved       | Moved to PR06 as 6.27: the granted trigger needs the damaged player bound and Human Torch as the damage source.                                        |
| 4.22 | The Fantasticar                | FF4        | unmodeled   | Whenever you cast a noncreature spell, you may have ~ become an artifact creature until end of turn. (+1)                                              |

Human Torch (4.21) moved to PR06. Its first ability fits PR04's spell history, but the second
grants "whenever he deals combat damage to an opponent, he deals that much damage to each other
opponent" until end of turn. That needs the damaged player bound and Human Torch as the source of
the second damage, which are PR06's damage-event primitives, so its commit lands there instead of
approximating the trigger here.

### PR05: Auras, Equipment, attachment lifecycle

Depends on: PR02 for bestow and cost merging, and PR03 for death and return.

- Returning an Aura to the battlefield attached to an object: Ghoulish Impetus, Gift of
  Immortality, Forum Filibuster, and Animate Dead's graveyard enchant with its leave-play
  sacrifice. Untargeted Aura return (Screams from Within). Attaching an Aura to a new token (Ajani's
  Chosen). Optional attachment (Shielded by Faith).
- Abilities granted to the enchanted creature, including a sacrifice cost (Fallen Ideal) and a
  merged static (Karametra's Favor). Counting Auras attached to a specific object, with last-known
  information on death (Kor Spiritdancer, Hateful Eidolon).
- Granted creature types (Angelic Destiny), bestow, the Kindred card type with annihilator, and
  enchant player (Curse of Bounty).
- Ward granted by an Aura (Sheltered by Ghosts). Selectors for creatures enchanted by an Aura you
  control.
- Equipment: equip merges with other activations, equipped-creature damage triggers, returning a
  card under its owner's control, and the corrected Sunforger equip cost.

|    # | Card                         | Population | Kind        | Primary blocker (first reason; +N = more)                                                                              |
| ---: | ---------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| 5.01 | Ajani's Chosen               | SIL        | fail-closed | Aura-enters attach-to-token is omitted from the Cat trigger.                                                           |
| 5.02 | Cranial Plating              | NEC        | fail-closed | Equip {1} is dropped when the attach activation replaces activatedAbilities.                                           |
| 5.03 | Forum Filibuster             | SIL        | fail-closed | Reflexive Aura/Equipment return attached to the token is omitted.                                                      |
| 5.04 | Ghoulish Impetus             | SIL        | fail-closed | Delayed Aura return does not attach, so SBA immediately puts it into the graveyard.                                    |
| 5.05 | Gift of Immortality          | SIL        | fail-closed | Delayed Aura return attached to the creature is omitted.                                                               |
| 5.06 | Hateful Eidolon              | SIL        | fail-closed | Draws one card instead of one per Aura that was attached.                                                              |
| 5.07 | Karametra's Favor            | TOK        | fail-closed | The enchanted-creature +1/+1 is dropped when the mana ability replaces staticEffects.                                  |
| 5.08 | Martial Impetus              | SIL        | fail-closed | Other-attacking-your-opponents pump is implemented as all creatures in combat.                                         |
| 5.09 | Mask of Memory               | NEC        | fail-closed | Equipped-creature combat damage is implemented as any equipped creature.                                               |
| 5.10 | Redemption Arc               | SIL        | fail-closed | Exile-enchanted-creature activated ability is claimed without an implementation.                                       |
| 5.11 | Resurrection Orb             | NEC        | fail-closed | Return is under the equipment controller, not the card's owner.                                                        |
| 5.12 | Screams from Within          | SIL        | fail-closed | Return is a required attach target; current Oracle returns this Aura untargeted.                                       |
| 5.13 | Shielded by Faith            | SIL        | fail-closed | Optional attach is implemented as mandatory attach.                                                                    |
| 5.14 | Spirit Mantle                | SIL        | moved       | Moved to PR11 as 11.29: protection from creatures needs protection keyed on the source's card type.                    |
| 5.15 | Sunforger                    | QMQ        | fail-closed | Equip {2} is authored; current Oracle is Equip {3}.                                                                    |
| 5.16 | Angelic Destiny              | SIL        | fail-closed | Angel type-changing is claimed without a type-changing static.                                                         |
| 5.17 | Animate Dead                 | SIL        | fail-closed | Graveyard Aura attach and leave-the-battlefield sacrifice are omitted.                                                 |
| 5.18 | Curse of Bounty              | TOK        | fail-closed | Only the attacking player untaps; the curse controller always should.                                                  |
| 5.19 | Eidolon of Countless Battles | SIL        | fail-closed | Bestow is claimed, and the Aura-count buff is overwritten by a creature-count self pump.                               |
| 5.20 | Eldrazi Conscription         | SIL        | fail-closed | Annihilator 2 is claimed without an annihilator implementation.                                                        |
| 5.21 | Fallen Ideal                 | SIL        | fail-closed | Granted sacrifice ability is authored on the Aura, and sacrificeOther cannot sacrifice the enchanted creature.         |
| 5.22 | Killian, Decisive Mentor     | SIL        | fail-closed | Attack-trigger scoped to creatures enchanted by your Auras is unimplemented.                                           |
| 5.23 | Kor Spiritdancer             | SIL        | fail-closed | Attached-Aura pump counts all Auras you control.                                                                       |
| 5.24 | Sheltered by Ghosts          | SIL        | fail-closed | Ward {2} is claimed without a ward static.                                                                             |
| 5.25 | Unquestioned Authority       | PRA        | moved       | Moved to PR11 as 11.30: protection from creatures needs protection keyed on the source's card type.                    |
| 5.26 | Tenuous Truce                | PRA        | moved       | Moved to PR06 as 6.28: its sacrifice trigger also fires on attacks at planeswalkers, which need PR06's attack scoping. |

Spirit Mantle (5.14) and Unquestioned Authority (5.25) moved to PR11. Each Aura grants protection
from creatures, but the engine's protection is keyed on colors only: every damage, targeting,
blocking and attachment check passes the source's colors. Protection from a card type needs the
source's characteristics at each of those checks, which is PR11's protection-quality work, so the
two commits land there instead of approximating protection here.

Tenuous Truce (5.26) moved to PR06. Its Aura is sacrificed "when you attack enchanted opponent or a
planeswalker they control or when they attack you or a planeswalker you control", but creatures
attack only players in this engine. Modeling only the player halves would leave the planeswalker
halves silently missing, so the card waits for PR06's attack-event scoping, which records which
player or planeswalker was attacked.

### PR06: Combat and damage events, damage prevention

Depends on: PR04, for attack groups and history.

Status: all 28 cards are modeled (758/906 measured; fixture decks 663/802, staples 189/200). The
measured remaining count per deck matches the PR06 column above except PRA 26 (planned 25), FF4 25
(planned 24) and URD 6 (planned 1), the seven cards that main reopened before PR03.

- Attack-event scoping: which player or planeswalker was attacked, which defending player is
  bound, one trigger per group for "one or more creatures attack", and triggers on an opponent
  attacking. Applies to Breena, Mangara, Tomik, Ever-Watching Threshold, Firemane Commando,
  Frontier Warmonger, Duelist's Heritage and Tenuous Truce.
- The source of damage: the entering or chosen creature deals it (Dragon Tempest, Scourge of
  Valkas, Arcbond, Backlash, Delirium). The damaged player and the player whose spell or ability
  targeted the creature are bound (Tomb Blade, Michiko Konda, Thunderbreak Regent). Thundermaw
  Hellkite taps only the creatures dealt damage this way.
- Reflexive payment ordering: pay first, then choose targets (Flameblast Dragon, Territorial
  Aetherkite, Invisible Woman).
- Damage prevention:
  - all damage, from a source you choose;
  - prevention that triggers or reflects damage, and counters for prevented damage;
  - combat damage to one creature only.
    Applies to Comeuppance, Deflecting Palm, Selfless Squire and Guard Gomazoa.
- Block triggers with a delayed end-of-combat return (Wall of Tears). Brash Taunter's "another
  target". Delirium can be cast only during an opponent's turn.

|    # | Card                        | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                                               |
| ---: | --------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.01 | Arcbond                     | QMQ        | fail-closed | The delayed damage is dealt by Arcbond, not by the chosen creature.                                                                                     |
| 6.02 | Backlash                    | QMQ        | fail-closed | Untapped-creature targeting is implemented as any creature.                                                                                             |
| 6.03 | Breena, the Demagogue       | QMQ, SIL   | fail-closed | Defender-has-more-life-than-another-of-your-opponents is implemented as defender-has-more-life-than-the-attacker.                                       |
| 6.04 | Comeuppance                 | QMQ        | fail-closed | All-damage prevention and reflection are implemented as preventCombatDamageToController.                                                                |
| 6.05 | Deflecting Palm             | PRA, QMQ   | fail-closed | Source choice and reflection are implemented as unscoped combat-damage prevention.                                                                      |
| 6.06 | Duelist's Heritage          | PRA, QMQ   | fail-closed | Once-per-attack-group optional double strike is implemented as a per-attacker grant on any creature.                                                    |
| 6.07 | Flameblast Dragon           | DRA        | fail-closed | The damage target is chosen before you decide to pay X.                                                                                                 |
| 6.08 | Mangara, the Diplomat       | QMQ, SIL   | fail-closed | Two-or-more attacking you is implemented as any combat attack, and a second-spell trigger is added.                                                     |
| 6.09 | Michiko Konda, Truth Seeker | QMQ        | fail-closed | Damage-to-you is implemented as damage to permanents you control.                                                                                       |
| 6.10 | Scourge of Valkas           | DRA        | fail-closed | The entering Dragon is the damage source, implemented as damage from this creature.                                                                     |
| 6.11 | Territorial Aetherkite      | LEN        | fail-closed | The damage is a reflexive trigger after payment, implemented as the same resolution.                                                                    |
| 6.12 | Thunderbreak Regent         | DRA        | fail-closed | Damage to the targeting opponent uses eventPlayer, which is unset on becomes-targeted events.                                                           |
| 6.13 | Thundermaw Hellkite         | DRA        | fail-closed | Tap applies to all opposing fliers, not only creatures dealt that damage.                                                                               |
| 6.14 | Tomb Blade                  | NEC        | fail-closed | Combat-damage life loss targets any player, not the damaged player.                                                                                     |
| 6.15 | Tyrant's Familiar           | DRA, RUB   | fail-closed | Defending-player creature targeting uses eventPlayer, which is the attacking player.                                                                    |
| 6.16 | Brash Taunter               | QMQ        | fail-closed | Another-target fight can target this creature.                                                                                                          |
| 6.17 | Delirium                    | QMQ        | fail-closed | Cast-only-during-an-opponent's-turn is omitted.                                                                                                         |
| 6.18 | Dragon Tempest              | DRA, URD   | fail-closed | Dragon-dealt damage is implemented as damage from this enchantment.                                                                                     |
| 6.19 | Firemane Commando           | SIL        | fail-closed | Both attack triggers make you draw, ignoring the other-player and not-attacked-you clauses.                                                             |
| 6.20 | Selfless Squire             | QMQ        | fail-closed | All-damage prevention and the prevented-damage counters are implemented as preventCombatDamageToController on enter.                                    |
| 6.21 | Tomik, Wielder of Law       | SIL        | fail-closed | Affinity and opponent-attacks trigger are implemented as a self-attack drain.                                                                           |
| 6.22 | Ever-Watching Threshold     | PRA        | unmodeled   | Whenever an opponent attacks, if they attacked you and/or a planeswalker you control, draw a card.                                                      |
| 6.23 | Frontier Warmonger          | PRA        | unmodeled   | Whenever one or more creatures attack one of your opponents or a planeswalker they control, those creatures gain menace until end of turn.              |
| 6.24 | Guard Gomazoa               | PRA        | unmodeled   | Prevent all combat damage that would be dealt to this creature.                                                                                         |
| 6.25 | Invisible Woman             | FF4        | unmodeled   | Whenever you attack, you may pay {R}{G}{W}{U}. When you do, target creature gets +1/+0 until end of turn for each creature you control and can't be b…  |
| 6.26 | Wall of Tears               | PRA        | unmodeled   | Whenever this creature blocks a creature, return that creature to its owner's hand at end of combat.                                                    |
| 6.27 | Human Torch                 | FF4        | unmodeled   | At the beginning of combat on your turn, if you've cast a noncreature spell this turn, ~ gains flying, double strike, and haste until end of turn. (+1) |
| 6.28 | Tenuous Truce               | PRA        | unmodeled   | Enchant opponent; at enchanted opponent's end step you both draw; attacking between you, or at a planeswalker, sacrifices it.                           |

### PR07: Combat requirements, restrictions, extra combats

Depends on: PR06.

Status: all 26 cards are modeled (786/906 measured; fixture decks 691/802, staples 189/200). The
measured remaining count per deck matches the PR07 column above except PRA 17 (planned 16), FF4 20
(planned 19) and URD 5 (planned 0), the seven cards that main reopened before PR03, and BRI 8
(planned 9) and MAR 9 (planned 10), where main already modeled Bilbo's Gambit and Dark Confidant.

- Attack requirements are checked jointly for whether they can be satisfied. These include "attacks
  player X if able", effects lasting until your next turn, and goad that covers creatures entering
  later (Kardur, Galactus, Silver Surfer, Goblin Spymaster, Siren's Call, War's Toll).
- "Can't attack you or your planeswalkers", with optional pay-to-attack taxes (Nils, Combat
  Calligrapher, Eriette, Rite of the Raging Storm, Promise of Loyalty). Attacks limited by
  direction (Pramikon, Teyo).
- Block restrictions:
  - Champion of Lambholt as a layer-aware static rather than a check on the card name;
  - Hexmark Destroyer can't be blocked except by six or more creatures;
  - Toby's token can't attack or block alone;
  - Taunt from the Rampart's "can't block".
- Piles of creatures (Fight or Flight), tracking which creatures had to attack (Firkraag), how many
  times each creature attacked this turn, and extra combats with untap (Moraug, Lightning Runner,
  Illusionist's Gambit removing creatures from combat).
- Another player choosing attackers and blockers (Master Warcraft). Goaded token copies given to
  opponents (Life of the Party). "Can't attack you during their next turn" (Willie Lumpkin).
  Menace against a chosen opponent (Triarch Stalker).

|    # | Card                             | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                                              |
| ---: | -------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.01 | Champion of Lambholt             | BRI, TOK   | fail-closed | The can't-block static is hardcoded by card name, so copies lack it and lost abilities still apply it.                                                 |
| 7.02 | Hexmark Destroyer                | NEC        | fail-closed | Cannot-be-blocked-except-by-six-or-more is implemented as cantBeBlocked.                                                                               |
| 7.03 | Lightning Runner                 | LEN        | fail-closed | Untap all creatures you control is implemented as untapEach of all permanents you control.                                                             |
| 7.04 | Promise of Loyalty               | SIL, FF4   | fail-closed | Keep-one sacrifice, vow counters, and attack restriction are unimplemented.                                                                            |
| 7.05 | Combat Calligrapher              | QMQ, SIL   | fail-closed | Inklings-cannot-attack-you is omitted, and the token trigger is unscoped.                                                                              |
| 7.06 | Eriette of the Charmed Apple     | SIL        | fail-closed | Cannot-attack-you static is claimed without an implementation.                                                                                         |
| 7.07 | Firkraag, Cunning Instigator     | URD        | fail-closed | The intervening-if checks whether Firkraag had to attack, not the creature that dealt damage.                                                          |
| 7.08 | Kardur, Doomscourge              | MAR, QMQ   | fail-closed | Goad snapshots current creatures, and the death trigger fires for blockers as well as attackers.                                                       |
| 7.09 | Nils, Discipline Enforcer        | QMQ, SIL   | fail-closed | End-step trigger counters every creature, and the attack-tax static is omitted.                                                                        |
| 7.10 | Teyo, Geometric Tactician        | QMQ        | fail-closed | The −2 directional attack restriction is claimed without an implementation.                                                                            |
| 7.11 | Triarch Stalker                  | NEC        | fail-closed | Menace for attackers of the chosen opponent is implemented as all creatures in combat.                                                                 |
| 7.12 | Fight or Flight                  | PRA        | unmodeled   | At the beginning of combat on each opponent's turn, separate all creatures that player controls into two piles. Only creatures in the pile of their c… |
| 7.13 | Galactus, Devourer of Worlds     | FF4        | unmodeled   | Insatiable Hunger — ~ attacks an opponent with the most life among your opponents each combat if able unless you control a creature named Silver Surf… |
| 7.14 | Goblin Spymaster                 | PRA        | unmodeled   | At the beginning of each opponent's end step, that player creates a 1/1 red Goblin creature token with "Creatures you control attack each combat if a… |
| 7.15 | Taunt from the Rampart           | FF4        | unmodeled   | Goad all creatures your opponents control. Until your next turn, those creatures can't block.                                                          |
| 7.16 | Willie Lumpkin, Postman          | FF4        | unmodeled   | Whenever ~ deals combat damage to an opponent, you draw a card and that player may draw a card. If they do, that player can't attack you or permanent… |
| 7.17 | Illusionist's Gambit             | PRA        | unmodeled   | Cast this spell only during the declare blockers step on an opponent's turn. (+1)                                                                      |
| 7.18 | Life of the Party                | PRA        | unmodeled   | Whenever this creature attacks, it gets +X/+0 until end of turn, where X is the number of creatures you control. (+1)                                  |
| 7.19 | Moraug, Fury of Akoum            | RUB        | unmodeled   | Each creature you control gets +1/+0 for each time it has attacked this turn. (+1)                                                                     |
| 7.20 | Pramikon, Sky Rampart            | PRA        | unmodeled   | As ~ enters, choose left or right. (+1)                                                                                                                |
| 7.21 | Rite of the Raging Storm         | PRA        | unmodeled   | Creatures named Lightning Rager can't attack you or planeswalkers you control. (+1)                                                                    |
| 7.22 | Silver Surfer, Galactus's Herald | FF4        | unmodeled   | When ~ enters, you may search your library for a card named Galactus, Devourer of Worlds, reveal it, put it into your hand, then shuffle. (+1)         |
| 7.23 | Toby, Beastie Befriender         | BRI        | unmodeled   | When ~ enters, create a 4/4 white Beast creature token with "~ can't attack or block alone." (+1)                                                      |
| 7.24 | War's Toll                       | PRA        | unmodeled   | Whenever an opponent taps a land for mana, tap all lands that player controls. (+1)                                                                    |
| 7.25 | Master Warcraft                  | PRA        | unmodeled   | Cast this spell only before attackers are declared. (+2)                                                                                               |
| 7.26 | Siren's Call                     | PRA        | unmodeled   | Cast this spell only during an opponent's turn, before attackers are declared. (+2)                                                                    |

### PR08: Control changes and multiplayer choices

Depends on: PR03 and PR07, for goad.

- Control changes:
  - durations: until end of turn, for as long as, or permanent;
  - an opponent gains control (Akroan Horse, Humble Defector, Wishclaw Talisman);
  - owners regain control (Alicia Masters) and control rotates each upkeep (Alexios);
  - exchanges (Reins of Power), control of Survivors when Varchild leaves, and graft with Cytoplast
    Manipulator.
- Multiplayer choices:
  - choosing an opponent, and each player choosing in turn order starting with you (Benevolent
    Offering, Druid of Purification, Agitator Ant, Tragic Arrogance);
  - each owner choosing top or bottom of their library (Aetherspouts) and voting (Council's
    Judgment);
  - "each opponent who drew a card this way" (Cut a Deal) and "unless that player pays" (Kazuul);
  - choose one or more modes, each targeting a different player (Shadrix Silverquill, Vindictive
    Lich).
- Searches by opponents (Boseiju, Winds of Abandon, Scheming Symmetry). Each opponent exiles its
  greatest-power creature, then takes damage based on it (Olórin's Searing Light).

|    # | Card                             | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                                              |
| ---: | -------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8.01 | Cut a Deal                       | QMQ, FF4   | fail-closed | You draw for each opponent, not for each opponent who drew a card.                                                                                     |
| 8.02 | Druid of Purification            | LEN        | fail-closed | Each player chooses a permanent they do not control, not a permanent you do not control.                                                               |
| 8.03 | Humble Defector                  | PRA, QMQ   | fail-closed | Activate-only-during-your-turn is implemented as timing any.                                                                                           |
| 8.04 | Scheming Symmetry                | QMQ        | fail-closed | Shuffle-then-put-on-top is implemented as moving the chosen card to the top without shuffling.                                                         |
| 8.05 | Wishclaw Talisman                | QMQ        | fail-closed | Opponent-gains-control is omitted from the search activation.                                                                                          |
| 8.06 | Cytoplast Manipulator            | MAR        | fail-closed | Gain-control duration is omitted; gainControlTarget is a permanent steal.                                                                              |
| 8.07 | Olórin's Searing Light           | QMQ        | fail-closed | Graveyard-threshold opponent damage is claimed without an implementation.                                                                              |
| 8.08 | Mob Rule                         | QMQ        | fail-closed | Until-end-of-turn steal is implemented as permanent gainControl.                                                                                       |
| 8.09 | Shadrix Silverquill              | QMQ, SIL   | fail-closed | Optional choose-two is mandatory, and the same mode can be chosen twice.                                                                               |
| 8.10 | Vindictive Lich                  | MAR        | fail-closed | Modes are choose-one rather than one-or-more targeting different players.                                                                              |
| 8.11 | Boseiju, Who Endures             | S          | unmodeled   | {1}{G}, Discard this card: Destroy target artifact, enchantment, or nonbasic land an opponent controls. That player may search their library for a la… |
| 8.12 | Aetherspouts                     | PRA        | unmodeled   | For each attacking creature, its owner puts it on their choice of the top or bottom of their library.                                                  |
| 8.13 | Agitator Ant                     | PRA        | unmodeled   | At the beginning of your end step, each player may put two +1/+1 counters on a creature they control. Goad each creature that had counters put on it…  |
| 8.14 | Alicia Masters, Skilled Sculptor | FF4        | unmodeled   | Sense the Good — At the beginning of your end step, each player gains control of all creatures they own.                                               |
| 8.15 | Council's Judgment               | PRA        | unmodeled   | Starting with you, each player votes for a nonland permanent you don't control. Exile each permanent with the most votes or tied for most votes.       |
| 8.16 | Kazuul, Tyrant of the Cliffs     | PRA        | unmodeled   | Whenever a creature an opponent controls attacks, if you're the defending player, create a 3/3 red Ogre creature token unless that creature's control… |
| 8.17 | Reins of Power                   | PRA        | unmodeled   | Untap all creatures you control and all creatures target opponent controls. You and that opponent each gain control of all creatures the other contro… |
| 8.18 | Tragic Arrogance                 | FF4        | unmodeled   | For each player, you choose from among the permanents that player controls an artifact, a creature, an enchantment, and a planeswalker. Then each pla… |
| 8.19 | Winds of Abandon                 | BRI        | unmodeled   | Exile target creature you don't control. For each creature exiled this way, its controller searches their library for a basic land card. Those player… |
| 8.20 | Akroan Horse                     | PRA        | unmodeled   | When this creature enters, an opponent gains control of it. (+1)                                                                                       |
| 8.21 | Alexios, Deimos of Kosmos        | PRA        | unmodeled   | ~ attacks each combat if able, can't be sacrificed, and can't attack its owner. (+1)                                                                   |
| 8.22 | Benevolent Offering              | PRA        | unmodeled   | Choose an opponent. You and that player each create three 1/1 white Spirit creature tokens with flying. (+1)                                           |
| 8.23 | Varchild, Betrayer of Kjeldor    | PRA        | unmodeled   | Whenever ~ deals combat damage to a player, that player creates that many 1/1 red Survivor creature tokens. (+2)                                       |

### PR09: Library access and casting during resolution

Depends on: PR02 for alternative costs, and PR08 for per-player choices.

- One shared engine for look, reveal and exile-until, with public reveals and random bottom
  ordering. It emits real zone changes and handles an empty library.
- Free-cast permissions are bound to specific cards and expire: "until end of turn", "this turn",
  "your next upkeep". Permission to play a land is separate from permission to cast a spell (Dream
  Pillager casts spells only; Expressive Iteration can play the card). Casting from the top of the
  library (Mystic Forge) and spending mana as though it were any color (Grenzo).
- Keyword actions: discover N, cascade with rebound, explore, hideaway, sneak, paradigm, and recruit
  together with per-opponent "until this leaves" exile (Celebrate the Mountain-king). "Spells can't
  be countered" (Chimil).
- Reveal and put into hand is not a draw (Dark Confidant, Keen Duelist). Choosing from the cards
  milled this way (Szarekh). Chaos Warp's public reveal (fail-closed restoration). Tibalt's
  Trickery's random 1–3. Etali exiles from each player's library. Lurking Predators. Power Pack's
  random choice.

|    # | Card                                              | Population  | Kind        | Primary blocker (first reason; +N = more)                                                                                                                   |
| ---: | ------------------------------------------------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.01 | Chaos Warp                                        | LEN, QMQ, S | fail-closed | The top card is not revealed; a nonpermanent remains hidden on top of the library.                                                                          |
| 9.02 | Adaptive Omnitool                                 | LEN         | fail-closed | Artifact-from-library is put into hand without revealing.                                                                                                   |
| 9.03 | Armored Skyhunter                                 | SIL         | fail-closed | Equipment filter is any artifact, and attach is omitted.                                                                                                    |
| 9.04 | Dark Confidant                                    | MAR         | fail-closed | Reveal-and-put-into-hand is implemented as a draw, including empty-library loss.                                                                            |
| 9.05 | Dream Pillager                                    | DRA         | fail-closed | Exiled cards are playable, including lands; Oracle only permits casting spells.                                                                             |
| 9.06 | Etali, Primal Conqueror // Etali, Primal Sickness | RUB         | fail-closed | Exile splices library cards without a zone-change, so leave-library events are skipped.                                                                     |
| 9.07 | Keen Duelist                                      | SIL         | fail-closed | Mutual reveal is implemented as drawRevealTopLoseManaValue on you only.                                                                                     |
| 9.08 | Songbirds' Blessing                               | SIL         | fail-closed | Reveal-until-Aura with optional battlefield and hand fallback is unimplemented.                                                                             |
| 9.09 | Szarekh, the Silent King                          | NEC         | fail-closed | Milled-this-way artifact-creature-or-Vehicle is implemented as any artifact creature in the graveyard.                                                      |
| 9.10 | Tibalt's Trickery                                 | QMQ         | fail-closed | Mill, exile, and free-cast cascade are claimed as a counter-only spell.                                                                                     |
| 9.11 | Aetherworks Marvel                                | LEN         | fail-closed | Look-at-top-six free-cast does not put the rest on the bottom in a random order, and skips that reordering when no spell is castable.                       |
| 9.12 | Herald of Amity                                   | SIL         | fail-closed | Exile-and-cast-Aura is implemented as lookAtTopN putting an Aura onto the battlefield.                                                                      |
| 9.13 | Mystic Forge                                      | NEC         | fail-closed | Top-of-library cast omits colorless spells, and exile-top is implemented as mill.                                                                           |
| 9.14 | Cosmic Cube                                       | RUB         | unmodeled   | Whenever you attack, look at the top six cards of your library. You may cast a spell from among them with mana value less than or equal to the greate…      |
| 9.15 | Expressive Iteration                              | FF4         | unmodeled   | Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. Yo…      |
| 9.16 | Franklin Richards, Ascendant                      | FF4         | unmodeled   | At the beginning of combat on your turn, if you've cast a noncreature spell this turn, discover 6.                                                          |
| 9.17 | Genesis Ultimatum                                 | FF4         | unmodeled   | Look at the top five cards of your library. Put any number of permanent cards from among them onto the battlefield and the rest into your hand. Exile…      |
| 9.18 | Into the Time Vortex                              | FF4         | unmodeled   | instant/sorcery with no interpretable effect                                                                                                                |
| 9.19 | Lurking Predators                                 | RUB         | unmodeled   | Whenever an opponent casts a spell, reveal the top card of your library. If it's a creature card, put it onto the battlefield. Otherwise, you may put…      |
| 9.20 | Mind's Dilation                                   | FF4         | unmodeled   | Whenever an opponent casts their first spell each turn, that player exiles the top card of their library. If it's a nonland card, you may cast it wit…      |
| 9.21 | Monstrous Vortex                                  | RUB         | unmodeled   | Whenever you cast a creature spell with power 5 or greater, discover X, where X is that spell's mana value.                                                 |
| 9.22 | New Generation's Technique                        | RUB         | unmodeled   | Sneak {2}{G}                                                                                                                                                |
| 9.23 | Path of Discovery                                 | FF4         | unmodeled   | Whenever a creature you control enters, it explores.                                                                                                        |
| 9.24 | Power Pack                                        | FF4         | unmodeled   | Whenever ~ deals combat damage to a player, exile target instant or sorcery card from your graveyard chosen at random. At the beginning of your next…       |
| 9.25 | Sunbird's Invocation                              | RUB         | unmodeled   | Whenever you cast a spell from your hand, reveal the top X cards of your library, where X is that spell's mana value. You may cast a spell with mana…       |
| 9.26 | Celebrate the Mountain-king                       | BRI         | unmodeled   | When this enchantment enters, for each opponent, exile up to one target nonland permanent that player controls until this enchantment leaves the batt… (+1) |
| 9.27 | Chimil, the Inner Sun                             | RUB         | unmodeled   | Spells you control can't be countered. (+1)                                                                                                                 |
| 9.28 | Improvisation Capstone                            | RUB         | unmodeled   | Exile cards from the top of your library until you exile cards with total mana value 4 or greater. You may cast any number of spells from among them… (+1)  |
| 9.29 | Rabble Rousing                                    | BRI         | unmodeled   | Hideaway 5 (+1)                                                                                                                                             |
| 9.30 | Trumpeting Carnosaur                              | RUB         | unmodeled   | When this creature enters, discover 5. (+1)                                                                                                                 |
| 9.31 | Grenzo, Havoc Raiser                              | PRA         | unmodeled   | Whenever a creature you control deals combat damage to a player, choose one — (+2)                                                                          |

### PR10: Stack manipulation, copying, characteristics

Depends on: PR02, PR03 and PR09.

- Retargeting a stack object, which is not the same as copying it (Deflecting Swat, Bolt Bend).
- Spell copies with "you may choose new targets" (Reverberate, Flare of Duplication, Galvanic
  Iteration), including "can't be copied" (Display of Power) and once each turn (Cosmic Crucible).
  Copies of triggered and activated abilities (Mister Fantastic, Verrak, Rowan Kenrith's emblem).
  Trigger doubling (Annie Joins Up, Roaming Throne).
- Countering a spell or ability only when it has qualifying targets (Siren Stormtamer). Recording
  how much mana was spent on a countered spell (Mana Sculpt). Gift, plus "players can't cast spells
  this turn" (Bilbo's Gambit).
- Copy effects: becoming a copy (Mirage Mirror, Saheeli, Sublime Artificer), token copies with
  exceptions (Saheeli, Radiant Creator; Scute Swarm; Council of Reeds with its legend-rule
  exception), entering as a copy with an exception (Mocking Doppelganger), and Duplicant taking the
  characteristics of the exiled card.
- Characteristic changes:
  - type and color changes (Atarka Monument, Sarkhan), including on spells and on cards off the
    battlefield (Biotransference);
  - devotion (Xenagos) and characteristic-defining power/toughness (Nighthawk Scavenger, Dragon
    Man);
  - activated abilities gained from cards in the graveyard (Trazyn);
  - turning a manifested card face up (Reality Shift).

|     # | Card                       | Population | Kind    | Primary blocker (first reason; +N = more)                                                                                         |
| ----: | -------------------------- | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 10.01 | Deflecting Swat            | MAR, S     | modeled | Modeled: retargets the same stack object (PR10 evidence).                                                                         |
| 10.02 | Atarka Monument            | DRA        | modeled | Modeled: animation is a 4/4 red and green Dragon artifact creature with flying (PR10 evidence).                                   |
| 10.03 | Biotransference            | NEC        | modeled | Modeled: your creatures, creature spells and creature cards off the battlefield are artifacts (PR10 evidence).                    |
| 10.04 | Mana Sculpt                | MAR        | modeled | Modeled: Wizard checked on resolution; adds the mana spent (PR10 evidence).                                                       |
| 10.05 | Reality Shift              | LEN        | modeled | Modeled: exile and manifest, with a manifested creature card turning face up for its mana cost (PR10 evidence).                   |
| 10.06 | Reverberate                | QMQ        | modeled | Modeled: the copy chooses new targets (PR10 evidence).                                                                            |
| 10.07 | Saheeli, Sublime Artificer | LEN        | modeled | Modeled: Servo for each noncreature spell; the -2 copy as an artifact (PR10 evidence).                                            |
| 10.08 | Siren Stormtamer           | MAR        | modeled | Modeled: counters only what targets you or your creature (PR10 evidence).                                                         |
| 10.09 | Trazyn the Infinite        | NEC        | modeled | Modeled: activated and mana abilities of artifact cards in your graveyard (PR10 evidence).                                        |
| 10.10 | Verrak, Warped Sengir      | QMQ        | modeled | Modeled: pay the life again to copy the ability (PR10 evidence).                                                                  |
| 10.11 | Bolt Bend                  | MAR        | modeled | Modeled: changes the single target; cost reduction (PR10 evidence).                                                               |
| 10.12 | Display of Power           | QMQ        | modeled | Modeled: cannot be copied; copies choose new targets (PR10 evidence).                                                             |
| 10.13 | Duplicant                  | LEN        | modeled | Modeled: optional exile of a nontoken creature; takes the last exiled creature card's power, toughness and types (PR10 evidence). |
| 10.14 | Flare of Duplication       | MAR        | modeled | Modeled: sacrifice alternative cost; copy chooses new targets (PR10 evidence).                                                    |
| 10.15 | Nighthawk Scavenger        | QMQ        | modeled | Modeled: power counts card types in opponents' graveyards only (PR10 evidence).                                                   |
| 10.16 | Saheeli, Radiant Creator   | LEN        | modeled | Modeled: energy for artifact spells; the copy is chosen after the energy is paid (PR10 evidence).                                 |
| 10.17 | Sarkhan, the Dragonspeaker | DRA        | modeled | Modeled: legendary red Dragon creature only; the -3 and the emblem (PR10 evidence).                                               |
| 10.18 | Roaming Throne             | S          | modeled | Modeled: chosen creature type; doubles triggers of that type (PR10 evidence).                                                     |
| 10.19 | Galvanic Iteration         | FF4        | modeled | Modeled: next-cast copy with flashback (PR10 evidence).                                                                           |
| 10.20 | Mirage Mirror              | FF4        | modeled | Modeled: becomes a copy of a permanent until end of turn (PR10 evidence).                                                         |
| 10.21 | Mister Fantastic           | FF4        | modeled | Modeled: copies a triggered ability twice with new targets (PR10 evidence).                                                       |
| 10.22 | Mocking Doppelganger       | PRA        | modeled | Modeled: may enter as a copy of an opponent's creature that goads same-named creatures (PR10 evidence).                           |
| 10.23 | Scute Swarm                | BRI        | modeled | Modeled: an Insect, or a copy of itself with six or more lands (PR10 evidence).                                                   |
| 10.24 | Annie Joins Up             | FF4        | modeled | Modeled: enter damage; doubles legendary creature triggers (PR10 evidence).                                                       |
| 10.25 | Bilbo's Gambit             | BRI        | modeled | Modeled ahead of PR10 by the white-black control merge (Gift, spell lock).                                                        |
| 10.26 | Cosmic Crucible            | FF4        | modeled | Modeled: first-main mana and a once-each-turn spell copy (PR10 evidence).                                                         |
| 10.27 | Council of Reeds           | FF4        | modeled | Modeled: your creatures ignore the legend rule; a combat copy after a noncreature spell (PR10 evidence).                          |
| 10.28 | Xenagos, God of Revels     | RUB        | modeled | Modeled: a creature only at seven devotion to red and green; combat haste and doubled power (PR10 evidence).                      |
| 10.29 | Dragon Man, Reformed Robot | FF4        | modeled | Modeled: power from the greatest noncreature mana value; cast from the graveyard by discarding (PR10 evidence).                   |
| 10.30 | Rowan Kenrith              | PRA        | modeled | Modeled: all three loyalty abilities, Partner with Will Kenrith, can be your commander (PR10 evidence).                           |
| 10.31 | Twilight Diviner           | MAR        | modeled | Modeled: surveil 2; copies one creature that entered or was cast from a graveyard, once each turn (PR10 evidence).                |

### PR11: Protection, phasing, layouts, game lifecycle

Depends on: PR02, PR03, PR09 and PR10. This PR finishes seven of the 15 staples, so it may be
worth splitting further.

- Player protection from everything, "your life total can't change", "you can't lose and opponents
  can't win", and split second (Teferi's Protection, The One Ring, Angel's Grace).
- Phasing, including attachments and no zone-change triggers (Clever Concealment). Removing
  hexproof (Arcane Lighthouse). "Can't be the target of abilities your opponents control" (Shanna).
  Protection from multicolored (Basri's Lieutenant) and protection from creatures granted by an
  Aura (Spirit Mantle, Unquestioned Authority), which key protection on the source's card type.
- Layouts:
  - Saga chapters, lore counters and sacrifice (Urza's Saga, The War in Heaven);
  - Class levels (Intermediate Chirography) and prepare (Defacing Duskmage, Eiganjo Dynastorian);
  - split cards with fuse (Wear // Tear) and Rooms (Dollmaker's Shop);
  - modal double-faced spell faces (Malakir Rebirth, Valakut Awakening, Mila, Wandering Archaic)
    and transform (Legion's Landing).
- Setup and recurring lifecycle:
  - opening-hand actions (Gemstone Caverns) and imprinted color mana (Chrome Mox);
  - "doesn't untap" with an optional upkeep untap (Mana Vault) and cumulative upkeep (Mystic
    Remora);
  - Smokestack's per-player sacrifice and Out of the Tombs replacing a draw from an empty library;
  - additional-mana triggers (Caged Sun);
  - coin flips with linked exile (Negative Zone Portal);
  - Choose a Background as a second commander (Gut).

|     # | Card                                            | Population | Kind        | Primary blocker (first reason; +N = more)                                                                                                                  |
| ----: | ----------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.01 | Arcane Lighthouse                               | SIL        | fail-closed | Hexproof/shroud removal is implemented as granting menace.                                                                                                 |
| 11.02 | Malakir Rebirth // Malakir Mire                 | QMQ        | fail-closed | Spell face is claimed; only the land back is authored.                                                                                                     |
| 11.03 | Smokestack                                      | MAR        | fail-closed | Upkeep sacrifice hits every player for 1 and enters with a soot counter.                                                                                   |
| 11.04 | Valakut Awakening // Valakut Stoneforge         | QMQ        | fail-closed | Spell face is claimed; only the land back is authored.                                                                                                     |
| 11.05 | Angel's Grace                                   | QMQ        | fail-closed | Split second and cannot-lose/cannot-win are implemented as a damage life floor only.                                                                       |
| 11.06 | Defacing Duskmage // Vandal's Edit              | SIL        | fail-closed | Prepare is implemented as a pump trigger on any draw step.                                                                                                 |
| 11.07 | Eiganjo Dynastorian // Replenish                | SIL        | fail-closed | Prepare is implemented as a pump trigger when this creature attacks.                                                                                       |
| 11.08 | Gut, True Soul Zealot                           | PRA        | fail-closed | Choose a Background is claimed without a background companion implementation.                                                                              |
| 11.09 | Out of the Tombs                                | NEC        | fail-closed | Enters-with two eon counters is authored; the card only places counters on upkeep.                                                                         |
| 11.10 | Wandering Archaic // Explore the Vastlands      | QMQ        | fail-closed | Modal DFC copy-on-cast with retarget is unimplemented.                                                                                                     |
| 11.11 | Wear // Tear                                    | QMQ        | fail-closed | Fuse is authored as a third mode with an extra {2}{W} rather than casting both halves.                                                                     |
| 11.12 | Caged Sun                                       | NEC        | fail-closed | Land-mana of the chosen color is claimed without an additional-mana trigger.                                                                               |
| 11.13 | The War in Heaven                               | NEC        | fail-closed | Saga chapters are implemented as enter, upkeep, and end-step triggers.                                                                                     |
| 11.14 | Intermediate Chirography                        | SIL        | fail-closed | Class levels and later abilities are claimed without an implementation.                                                                                    |
| 11.15 | Mystic Remora                                   | S          | unmodeled   | Cumulative upkeep {1}                                                                                                                                      |
| 11.16 | Chrome Mox                                      | S          | unmodeled   | When this artifact enters, you may exile a nonartifact, nonland card from your hand. (+1)                                                                  |
| 11.17 | Gemstone Caverns                                | S          | unmodeled   | If this card is in your opening hand and you're not the starting player, you may begin the game with ~ on the battlefield with a luck counter on it.… (+1) |
| 11.18 | Teferi's Protection                             | S          | unmodeled   | Until your next turn, your life total can't change and you gain protection from everything. All permanents you control phase out. (+1)                     |
| 11.19 | Mana Vault                                      | S          | unmodeled   | ~ doesn't untap during your untap step. (+2)                                                                                                               |
| 11.20 | The One Ring                                    | S          | unmodeled   | When ~ enters, if you cast it, you gain protection from everything until your next turn. (+2)                                                              |
| 11.21 | Urza's Saga                                     | S          | unmodeled   | unsupported layout "saga (+3)                                                                                                                              |
| 11.22 | Clever Concealment                              | FF4        | unmodeled   | Any number of target nonland permanents you control phase out.                                                                                             |
| 11.23 | Legion's Landing // Adanto, the First Fort      | BRI        | unmodeled   | When you attack with three or more creatures, transform ~.                                                                                                 |
| 11.24 | Shanna, Sisay's Legacy                          | BRI        | unmodeled   | ~ can't be the target of abilities your opponents control.                                                                                                 |
| 11.25 | Basri's Lieutenant                              | BRI        | unmodeled   | Vigilance, protection from multicolored (+1)                                                                                                               |
| 11.26 | Dollmaker's Shop // Porcelain Gallery           | BRI        | unmodeled   | unsupported layout "split (+1)                                                                                                                             |
| 11.27 | Mila, Crafty Companion // Lukka, Wayward Bonder | PRA        | unmodeled   | unsupported layout "modal_dfc (+1)                                                                                                                         |
| 11.28 | Negative Zone Portal                            | FF4        | unmodeled   | {2}, {T}: Exile target card from an opponent's graveyard. If it's a creature card, draw a card. (+1)                                                       |
| 11.29 | Spirit Mantle                                   | SIL        | fail-closed | Protection from creatures is unimplemented.                                                                                                                |
| 11.30 | Unquestioned Authority                          | PRA        | unmodeled   | Enchanted creature has protection from creatures.                                                                                                          |

## Keeping this plan current

- Tick off a row by linking its commit in the PR body. Do not delete rows. Completed rows stay as
  acceptance history, as they do in the ledger.
- When a card moves between PRs, update both tables and the overview counts in the same commit.
- After each PR, rerun the measurement and replace the baseline and progression tables. If a fix
  shows that a card previously counted as modeled was wrong, report the regression rather than
  hiding it.

### PR12: Reopened quality-audit cards

Assigned during PR08 preparation on 2026-10-17. PR08 keeps its original 23-card scope and targets
809/906 from the measured 786/906 baseline. These seven cards are additional to the original
PR01–PR11 assignments; the existing later columns are historical planned counts, not new measurements.

Depends on PR09–PR11 where their shared primitives apply. Each card still requires the full
[card modeling and testing standard](../guides/card-modeling-and-testing.md), one card per green
commit, and explicit containment until every clause is faithfully implemented. Completing PR12
is necessary for the frozen population to reach 906/906.

|     # | Card                     | Population | Reopened blocker                                                   |
| ----: | ------------------------ | ---------- | ------------------------------------------------------------------ |
| 12.01 | Black Bolt, Inhuman King | FF4        | Event-player reference without an event scope fails IR validation. |
| 12.02 | Dingus Staff             | PRA        | Event-player reference without an event scope fails IR validation. |
| 12.03 | Sivitri, Dragon Master   | URD        | Executable `noOp` is rejected.                                     |
| 12.04 | Zurgo and Ojutai         | URD        | Executable `noOp` is rejected.                                     |
| 12.05 | Bloomvine Regent         | URD        | Explicitly contained; implement and verify all relevant faces.     |
| 12.06 | Marang River Regent      | URD        | Explicitly contained; implement and verify all relevant faces.     |
| 12.07 | Monster Manual           | URD        | Explicitly contained; implement and verify all relevant faces.     |
