# Post-Tier-3 card coverage — the residue, clustered

Written 2026-09-03, after the Tier 3 sub-tiers landed and a reachability pass over their named
targets. This plan covers **what Tier 3 does not**: the 34 remaining EDH staples and the 130
unmodeled fixture cards, grouped by the engine surface they need rather than by the sentence they
print — the same principle [edh-staple-coverage.md](edh-staple-coverage.md) adopted for its own
tail, applied to what is left after it.

## Status — 2026-09-04

Executed via the staged plan (Phase A correctness, then Phase B coverage, primitive-first).

| Phase | Item                                                             | State               |
| ----- | ---------------------------------------------------------------- | ------------------- |
| A     | A1 kicker → fail closed                                          | done                |
| A     | A2+A3 hand-activated abilities                                   | done                |
| A     | A4 mana cost in a mana ability → fail closed                     | done                |
| A     | A5 `activationCostReductionFor` chosenOption                     | done                |
| A     | A6 `onActivate` narrowed to the chosen ability                   | done                |
| A     | A7 guard tests (`rule-static-coverage`, `ability-cost-coverage`) | done                |
| B     | B1 wording fixes (R.5 counters, R.4 land types)                  | done                |
| B     | B2 R.3 mana riders (Ancient Tomb, City of Brass)                 | done                |
| B     | B3 R.2 counted and conditional mana                              | done                |
| B     | B4 R.6 modal bullets                                             | done                |
| B     | B5 R.1 chosen creature type                                      | done                |
| B     | B6 R.7 residue                                                   | partial — see below |

```
bun run staples     185/200 modeled (92.5%)   (was 166/200)
bun run coverage    666/802 modeled (83.0%)   (was 672/802)
bun run test        1283 passing, 0 failing   (was 1219)
bun run lint        CLEAN
bun run typecheck / typecheck:tests   CLEAN
```

**The coverage number went DOWN by six, deliberately.** Phase A closed a class of silent failures
— IR that the parser produced and nothing consumed — and the honest way to close one is to stop
claiming the card is modeled:

- five cards lost to A4 (Fetid Heath, Graven Cairns, Rugged Prairie, Study Hall, Orb of Dragonkind),
  whose overrides authored a mana ability with a mana cost that nothing ever charged, so they
  produced free mana every turn;
- one card lost to A1 (kicker), which parsed into a `RuleStatic` no code read, leaving `wasKicked`
  permanently false.

Two cards moved the other way inside A4 without appearing in any metric: Desolate Mire and
Shadowblood Ridge were _modeled and wrong_, and are now modeled and right — the interpreter's
generic reading of `{1}, {T}: Add {W}{B}` charges the `{1}` correctly, and the override was
overriding it with a broken one.

Phase A is invisible to `staples` and `coverage` by construction: neither metric can see a card
that is modeled and does nothing. Judge it by the three guard tests instead
(`effect-op-coverage`, `rule-static-coverage`, `ability-cost-coverage`), each of which was
negative-tested to confirm it actually fails when the gap it guards is reintroduced.

Two corrections to the plan as written, both found by measurement:

- **A4's blast radius was 13 mana abilities across 7 cards, not 2.** The filter lands were the
  serious case and were not listed: Desolate Mire's `{1}, {T}: Add {W}{B}` tapped for two mana
  from nothing, in a committed fixture deck sitting at 100% coverage, with no test covering it.
  The fix is in `manaSourcesFor`, one layer below the parser, so it also covers future overrides.
- **Cabal Coffers belongs with Nykthos and Three Tree City, not with Itlimoc.** Its cost is
  `{2}, {T}`, so it is blocked on the same unscoped item and stays unmodeled. Gaea's Cradle and
  Itlimoc are tap-only and were the real beneficiaries of B3's counted-amount primitive.

Two overrides became redundant as generic grammar grew and were deleted after the drift guard
flagged their stale `handledLines`: **Emmara, Soul of the Accord** (once `becomes tapped` joined
the object-trigger head for City of Brass) and **Midnight Reaper** (once the damage-to-controller
sentence existed). Both now parse to the identical IR generically.

**Phase B bought 19 staples and zero fixture cards**, which is what the plan predicted: only one
of the 130 unmodeled fixture cards shares a shape with R.1-R.6. That tail is still flat and still
needs its own clustering pass.

Two more silent-failure instances turned up inside Phase B, both of the same class Phase A closed:

- **`addMana` with `colors: []` and `fixedSymbols` never added any mana.** The empty-palette guard
  returned before the fixed-symbol branch, so a producer that spells its symbols out was a no-op.
- **An exiled LAND could be offered as `playLand` and then crash.** `PriorityActionPayload.playLand`
  had no `fromExile`, so `applyPriorityAction` looked for the card in hand and threw. Reachable
  today through a shipped override, not only through Jeska's Will.

Three overrides became redundant as generic grammar grew, each surfaced by the drift guard:
**Emmara, Soul of the Accord**, **Midnight Reaper**, and **Decoction Module**'s activated ability.
**Morophon, the Boundless** stopped being a bespoke interpreter branch that hardcoded "Dragon" —
correct only in the Ur-Dragon fixture deck it was written for — and now reads its own chosen type.

### What B6 left, and why

Fifteen staples remain. They are not a backlog of near-misses; each needs machinery that does not
exist:

| Card                                        | Missing                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Cabal Coffers, Nykthos, Three Tree City     | mana abilities that cost mana (the A4 item, still unscoped)                          |
| Boseiju, Who Endures                        | an opponent's optional library search, plus "nonbasic land" in compound target nouns |
| Urza's Saga                                 | the saga layout                                                                      |
| Teferi's Protection, The One Ring           | protection from everything, and phasing                                              |
| Chrome Mox, Gemstone Caverns                | exile-imprint mana; opening-hand starts                                              |
| Mana Vault, Mystic Remora                   | "doesn't untap"; cumulative upkeep                                                   |
| Esper Sentinel                              | "unless that player pays {X}, where X is this creature's power"                      |
| Mystic Sanctuary, Victimize, Roaming Throne | conditional enters-tapped; two-target graveyard reanimation; trigger doubling        |

**Otawara, Soaring City** did land, and it is the one that proves A2+A3 paid off: hand-zone
activation, a `discardSelf` cost, targets from hand, and a self-only activation discount that
`activationCostReductionFor` cannot see because the source is in hand. Boseiju shares all of that
and is blocked only on its second sentence.

Notes that outlived their items:

- **Leyline of the Guildpact** did not flip with the rest of R.4: its other two lines
  (opening-hand start, "each nonland permanent you control is all colors") are separate work.
- **Wastes is not a basic land type** (CR 305.6, `docs/rules/comprehensive-rules.txt:1705`). The
  five-type list is correct; do not "fix" it.
- **A changeling would have made the R.1 creature-type domain 324 options.** The domain reads
  PRINTED subtypes for exactly this reason; see `creatureTypeChoicesFor`.

## Measured baseline

```
bun run staples     166/200 modeled (83.0%)
bun run coverage    672/802 modeled (83.8%) across 12 fixture decks
bun run typecheck   CLEAN
bun run test        1219 passing, 0 failing
```

The fixture split that [CLAUDE.md](../../CLAUDE.md) calls out still holds and is still the whole
story: the precons the engine was built against sit at 97.8–100%, the four community decks at
57.5–68.9%.

| Deck                             | Modeled |
| -------------------------------- | ------- |
| draconic-destruction             | 100.0%  |
| living-energy                    | 100.0%  |
| marchesa-the-black-rose          | 100.0%  |
| necron-dynasties                 | 100.0%  |
| silverquill-influence            | 100.0%  |
| token-triumph                    | 100.0%  |
| urdragon                         | 100.0%  |
| queen-marchesa-queens-gambit     | 97.8%   |
| ruby-the-most-daring-of-trackers | 68.9%   |
| pramikon-sky-rampart             | 58.1%   |
| brigid-clachans-heart            | 57.9%   |
| the-fantastic-four               | 57.5%   |

## The shape of what is left

The single most useful fact for planning, and the one that separates this plan from Tier 3's:

**72 of the 130 unmodeled fixture cards have exactly one remaining blocker.**

| Remaining blockers | Cards |
| ------------------ | ----- |
| 1                  | 72    |
| 2                  | 41    |
| 3                  | 13    |
| 4                  | 3     |
| 5                  | 1     |

Tier 3's tail was _cards with several missing primitives each_, which is why it grouped by engine
surface and why any one change rarely flipped a card. The residue is not that. Most of it is one
clause away, so here a clause fixed is a card modeled — and the planning unit should be the clause,
not the subsystem.

The counterweight, and the reason this plan does not simply promise 72 cards: those 72 blockers do
not cluster. Sorted by shape they are 33 static/spell lines, 29 trigger _bodies_, 6 phase-step
triggers, 2 activated abilities, 1 back face and 1 mana ability — and the trigger heads are all
already recognized, so there is no dominant event to widen. The staple list is where the clustering
still lives, and that is what the sub-plans below are built from.

### A caution this session earned

Adding the Fantastic Four cycle's shared intervening-if (`castSpellThisTurn`) made 9 cards' first
blocker disappear and flipped **zero** of them to modeled — every one had a second, unrelated
clause. Estimate in clauses-removed, and only claim cards for a cluster after checking those cards
have nothing else outstanding. The `1 blocker` column above is the honest denominator; the
`2+` rows are not.

## Sub-plans

Ordered by cards-per-unit-work, as everywhere else in this project.

### R.1 — Chosen-type permanents (5 staples)

**Cards.** Cavern of Souls, Herald's Horn, Patchwork Banner, Roaming Throne, Three Tree City.

**The gap.** `As this <permanent> enters, choose a creature type.` plus statics and mana abilities
that read the choice back. The mechanism already exists and is proven: `entersChoosingOption` /
`chosenOption` is what Caged Sun's color pick, Frontier Siege's mode pick and the Pathway lands'
face pick all use, and `DynamicManaKind: 'chosenColor'` already reads it at query time. What is
missing is a **creature-type** option domain (the options are not a fixed list — they are "any
creature type") and the three readers below.

1. `entersChoosingOption` with an open creature-type domain, plus a `chosenType` on the permanent.
2. A `Selector` clause `ofChosenType` matching against the source's recorded choice. Unlocks
   **Patchwork Banner** (`Creatures you control of the chosen type get +1/+1`) and
   **Herald's Horn**'s cost reduction.
3. `DynamicManaKind: 'chosenTypeRestricted'` — Cavern of Souls' `Add one mana of any color. Spend
this mana only to cast a creature spell of the chosen type, and that spell can't be countered.`
   Both halves already exist separately: `ManaRestriction` for the spend clause and Delighted
   Halfling's per-spell uncounterable flag for the rider. This is composition, not new machinery.

**Not included.** Roaming Throne's third line (`If a triggered ability of another creature you
control of the chosen type triggers, it triggers an additional time`) is trigger-doubling and
belongs with R.7.

### R.2 — Scaled and conditional mana abilities (6 staples, 1 fixture back face)

**Cards.** Cabal Coffers, Nykthos, Three Tree City, Temple of the False God, Reflecting Pool,
Mox Amber; Itlimoc (Growing Rites' back face).

**The gap.** `ManaAbilitySpec.units` is a fixed list of symbol choices. Three shapes it cannot say:

1. **A counted amount** — `Add {B} for each Swamp you control` (Cabal Coffers), `{T}: Add {G} for
each creature you control` (Itlimoc). Needs `units` to carry a `Value` multiplier. This is the
   single highest-yield item in R.2 and should land first.
2. **Choose a colour, then count** — `Choose a color. Add an amount of mana of that color equal to
your devotion to that color` (Nykthos) and the same shape counting creatures of the chosen type
   (Three Tree City). `devotionTo` already exists as a `Value` **and now parses** from text; the
   missing halves are the amount-carrying `units` from item 1 plus an at-activation colour choice
   (distinct from `chosenColor`, which is an as-enters choice).
3. **An activation condition** — `Activate only if you control five or more lands` (Temple of the
   False God). `ManaAbilitySpec.condition` already exists and is already honoured by
   `manaSourcesFor`; this is a parser gap only.

**Also here.** Reflecting Pool (`any type that a land you control could produce`) and Mox Amber
(`any color among legendary creatures and planeswalkers you control`) are two more
`DynamicManaKind` members alongside the existing `opponentLandColors`, which Fellwar Stone already
proves the shape of.

### R.3 — Mana abilities with a rider (3 staples)

**Cards.** Ancient Tomb, City of Brass, Mana Vault.

**The gap.** Mostly already closed and simply not parsed. `ManaAbilitySpec.onActivate` exists for
painlands, which is exactly Ancient Tomb's `{T}: Add {C}{C}. ~ deals 2 damage to you.`
City of Brass phrases the same effect as a trigger — `Whenever this land becomes tapped, it deals 1
damage to you` — and `becomesTapped` is already an `ObjectTriggerWhen`. Take both as parser work.

Mana Vault is the outlier and needs three things nothing else here needs: a doesn't-untap flag
honoured by the untap step, an upkeep "you may pay {4}" untap, and a draw-step conditional damage.
Defer it to R.7.

### R.4 — Land-type grants (2 staples, 1 fixture, 1 Tier 3 debt)

**Cards.** Urborg, Yavimaya; Dryad of the Ilysian Grove; Leyline of the Guildpact.

**The gap.** `Each land is a Swamp in addition to its other land types` / `Lands you control are
every basic land type in addition to their other types` — a layer-4 subtype-adding `ContinuousOp`
over a `Selector`, with the mana consequence that those lands then tap for the corresponding
colours.

This is **Tier 3.C item 5, which never landed**, and it is listed here rather than left in Tier 3
because two of the four cards are staples outside Tier 3's population. The engine already resolves
mana abilities through `computeCharacteristics` (the Blood Moon → Mountain case is implemented and
tested), so the mana half follows from the type half rather than needing its own mechanism.

### R.5 — Counter replacement (2 staples)

**Cards.** Doubling Season, Hardened Scales.

**The gap.** Very nearly closed. `counterAmountAfterReplacements` and
`counterAmountAfterReplacementsForCandidate` already exist, are already applied at every counter
entry point (`makePermanent`, the `+1/+1` path in `moveObject`, the copy path), and Tier 2.7 built
`tokenCountMultiplier` as the token-side twin. What is missing is the **counter-side** replacement
spec and its two arithmetic forms — `twice that many` (Doubling Season) and `that many plus one`
(Hardened Scales) — plus Doubling Season's token half, which `tokenCountMultiplier` already covers.

Worth doing early despite being only two cards: both are top-30 staples, and the chokepoint work is
already paid for.

### R.6 — Commander-conditional modal bullets (2 staples)

**Cards.** Akroma's Will, Jeska's Will.

**The gap.** The _header_ already works — Tier 2.6 built `maxChoicesIf` with a
`controlsYourCommander` condition for exactly `Choose one. If you control a commander as you cast
this spell, you may choose both instead.` Both cards fail on their **bullets**:

- Akroma's Will: `Creatures you control gain flying, vigilance, and double strike until end of
turn.` — a mass multi-keyword grant. The single-keyword mass grant already parses.
- Jeska's Will: `Add {R} for each card in target opponent's hand.` (R.2 item 1 with a targeted
  count) and `Exile the top three cards of your library. You may play them this turn.` (impulse
  draw, which recurs across the fixture decks).

Take R.2 first; Jeska's Will then costs only the impulse-draw half.

### R.7 — Residue, named honestly

One card, one mechanic, no reuse in sight. Listed so the backlog stays visible, never scheduled as
a phase of its own — take an entry opportunistically when a neighbouring sub-plan is already open.

**Whole subsystems:** phasing (Teferi's Protection), the `saga` layout and chapter abilities
(Urza's Saga), cumulative upkeep (Mystic Remora), opening-hand replacement (Gemstone Caverns),
trigger-doubling (Roaming Throne).

**Multi-clause one-offs:** Chrome Mox, Command Beacon, Esper Sentinel, Mana Vault, Mystic
Sanctuary, The One Ring, Tireless Provisioner, Victimize, Windfall, Worldly Tutor.

**Individually cheap, take opportunistically:** Boseiju and Otawara are one shape between them
(a `{cost}, Discard this card:` ability activated from **hand** with a per-legendary-creature cost
reduction — `ActivatedAbility.zone: 'hand'` and `activationCostReductionFor` both already exist,
so this is close to parser-only and buys two staples).

## Tier 3 debts this plan does not absorb

Three Tier 3 items were built but are not reachable from real card text, and they stay Tier 3's to
finish rather than moving here:

| Item                      | State                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.G transform             | `transformSelf`, `transformPermanent`, `BackFace` and front-face reset all exist and are tested. No printed transform card is modeled: `Whenever this creature transforms into ~` has no parser, and every real card wraps `transform ~` in an intervening-if or a compound body. |
| 3.B `Return target spell` | Hullbreaker Horror's blocker is not its modal header (fixed this session) but its bullet — targeting a spell on the stack is still a missing `TargetKind`.                                                                                                                        |
| 3.A draw-step counter     | `eventPlayerDrawCount` reads `cardsDrawnThisTurn`, a per-**turn** counter. The printed clause is "except the first one they draw in each of their **draw steps**". Latent — no card reaches it today — but wrong when one does, and a passing test encodes the wrong semantics.   |

## Verification (every sub-plan, non-negotiable)

Unchanged from [edh-staple-coverage.md](edh-staple-coverage.md), with the staple checker now
committed and therefore usable as the unit of record:

```bash
bun run typecheck                                   # baseline 2026-09-03: CLEAN
bun run typecheck:tests                             # baseline: CLEAN
bun run test                                        # baseline: 1219 passing, 0 failing
bun run staples                                     # baseline: 166/200 (83.0%)
bun run coverage                                    # baseline: 672/802 (83.8%)
bun run scripts/snapshot-override-defs.ts --check
bun run scripts/snapshot-interpret-defs.ts --check
```

Plus, per sub-plan:

1. Re-run `bun run staples` and record the new modeled count **and** the new
   blockers-per-card histogram from `bun run coverage --json`. Report clauses removed separately
   from cards flipped; they are different numbers and only the second one is coverage.
2. Grep the override registry for newly-stale `handledLines` matching whatever shapes the sub-plan
   generalized — the staple check only exercises registrations that collide with those 200 cards.
3. **Check the card, not the fixture.** Several Tier 3 sub-tiers passed their own tests while their
   named cards stayed unmodeled, because the test fixture used a phrasing no printing has (a
   two-line block joined onto one line, a synthetic bullet set). Every sub-plan's test must include
   at least one assertion driven by real Scryfall oracle text via the bulk cache.
