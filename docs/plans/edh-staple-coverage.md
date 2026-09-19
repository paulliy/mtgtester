# Plan — closing the EDH-staple coverage gap

> Status: in progress. Tier 0 and Clusters A–C are implemented; Cluster B has the reusable goad/forced-attack surface in place, while the remaining bespoke cards and the original Tier 1–2 backlog remain open. Library-top tutors and two safe compound modal selectors are now generic. Cascade and Rebound now have generic keyword parsing, Cascade library-hit resolution, and Rebound next-upkeep exile casting. Measured fixture coverage after this pass: **623 / 802 (77.7%)**.
> community decks were added to the coverage list and the Scryfall bulk was refreshed:
> **597 / 802 unique cards modeled (74.4%)** across 12 decks.
>
> The earlier baseline (107 / 200 of the most-included EDH cards, measured 2026-08-07 at
> `83120f5`) is preserved below — it measures a different population and is still the right
> instrument for "what do players actually cast". The two numbers are complements, not rivals.

## Where the measurement comes from

The 200 cards are the most-included cards in Commander by deck count (user-supplied CSV),
resolved against live Scryfall data via `/cards/collection` and converted with the production
[`toOracleCard`](../../packages/server/src/cards/scryfall.ts) before running through
`interpretCard`. This matters: it is a _real-world_ frequency ranking, not the seven precon
fixture decks the engine was built against, so it is the first coverage number here that
reflects what players actually cast. The seven-deck coverage report (`bun run coverage`) needs
the gitignored 180 MB bulk file and measures a different, precon-shaped population — the two
numbers are not comparable and neither supersedes the other.

Reproduce with the three `scryfall_response_*.json` batches and the checker in the session
scratchpad; nothing about this measurement is committed, by design (the responses are ~2 MB of
third-party data with no test value).

## What the two new decks changed (2026-08-28)

Two community decks were added to `packages/server/fixtures/coverage-decks/`:

| Fixture                 | Commander               | Modeled             | Shape                            |
| ----------------------- | ----------------------- | ------------------- | -------------------------------- |
| `brigid-clachans-heart` | Brigid, Clachan's Heart | **28 / 76** (36.8%) | GW go-wide tokens + counters     |
| `pramikon-sky-rampart`  | Pramikon, Sky Rampart   | **30 / 86** (34.9%) | WUR goad / politics / pillowfort |

Both are 102-card decks someone is still tuning, snapshotted verbatim rather than trimmed —
`coverage:snapshot --lenient` and `coverage` (non-`--strict`) now measure deck coverage without
requiring Commander legality, because which _cards_ the engine models is independent of whether
the pile around them is a legal 100.

Full fixture picture:

| Band                                 | Decks | Coverage |
| ------------------------------------ | ----- | -------- |
| Precons the engine was built against | 6     | 97–100%  |
| Community / crossover decks          | 4     | 35–40%   |

That gap is the finding. The precons are effectively closed and no longer generate useful
signal; **every remaining mechanic of consequence lives in the four community decks**, and the
two new ones concentrate it into two coherent clusters rather than a long tail of one-offs.
This is what makes them worth planning around: they are not 93 unrelated cards, they are two
archetypes, each blocked by a handful of primitives that repeat across many cards.

### Cluster A — "count what I control" (Brigid, ~10 cards on one primitive)

The single highest-leverage missing primitive in the whole fixture set. One dynamic value —
_the number of permanents matching a selector_ — appears as a characteristic-defining P/T, as a
token count, and as a counter count:

- `~'s power and toughness are each equal to the number of creatures you control` (Queen Allenal)
- `~'s power is equal to the number of creatures you control` (Adeline)
- `~ gets +1/+1 for each creature you control` (Shanna)
- `~ enters with a number of +1/+1 counters on it equal to one plus the number of other creatures you control` (Boss's Chauffeur)
- `~ enters with X +1/+1 counters on it` (Royal Talon Fighter Jet)
- `Create X 1/1 white Ally creature tokens…` (United Front), `create a number of … tokens equal to …` (Jacked Rabbit, Ainok Strike Leader)
- `Creatures you control get +X/+X, where X is the number of creatures that entered … this turn` (Kinbinding)

`non-numeric power/toughness "*"` is the same primitive wearing a different hat — it is the
CDA form, and it is 4 of the aggregate's blocked cards. Build `countOf(selector)` as a `Value`
usable in all three positions (P/T layer 7a CDA, `createToken.count`, `putCounters.count`) and
this cluster collapses at once. **Do this first.**

### Cluster B — goad and forced attacks (Pramikon, ~10 cards, primitive already half-built)

`goadEachOpponent` already exists and Kardur, Doomscourge already uses it. What is missing is
almost entirely _parser_ surface plus a targeted/static form of the same idea:

- `Goad target creature …` / `Goad all creatures you don't control` (Grenzo, Disrupt Decorum, Agitator Ant)
- `… is goaded` as an aura/equipment static (Bloodthirsty Blade, Shiny Impetus; Coercive Impetus already has this authored)
- `Creatures your opponents control attack each combat if able` (Angler Turtle, Fumiko) — 2 cards on one identical sentence
- `Target creature attacks this turn if able` / `Each creature attacks this turn if able` (Basandra, Goblin Diplomats)
- `~ attacks each combat if able` (Alexios), `All creatures have double strike and attack each combat if able` (Avatar of Slaughter)

Cheap relative to its yield, and it makes the _archetype_ playable rather than just raising a
number — a goad deck whose goad does nothing is not a testable deck.

### Cluster C — "enters with additional counters" statics (spans both decks)

`Each other creature you control enters with … additional +1/+1 counter(s)` — Arwen (equal to
Arwen's toughness), Sage of Fables (Wizards), Gev (per opponent who lost life), Kalain (per
Treasure mana spent).

**This one carries a correctness warning.** `Sage of Fables` and `Gev, Scaled Scorch` currently
_claim_ this line in `handledLines` while their `def` implements nothing for it, so both report
`modeled: true` with the static silently absent. They are false positives of exactly the kind
commit `2ca67b2` fixed for empty patches. Whoever builds this primitive must also drop those
two stale claims — otherwise the work looks like it changes nothing.

Kalain, Reclusive Painter additionally needs mana-_source_ tracking (see Tier 3), and is the
one card in the fixture set currently failing `remaining-four-decks.test.ts`.

### Cluster D — planeswalker loyalty abilities (Pramikon, 3 cards)

`+2:` / `−2:` / `−8:` lines go unparsed entirely on Rowan Kenrith, Venser, and Mila // Lukka.
Loyalty costs already exist as an `AbilityCost` (`{ kind: 'loyalty', delta }`, used by Saheeli's
authored override), so this is parser work over an existing primitive, not a new subsystem.
Note two of the three are also blocked by `unsupported layout` (`modal_dfc`), already Tier 2
item 3.

## The principle this plan is organized around

The user's constraint on the previous increment was: **build extendable grammar, not card-specific
implementations.** That is not a style preference here, it is the cheapest path — the previous
increment closed 25 of these cards with ~7 generic rules and _deleted_ four overrides in the
process. So this plan is ordered by **cards unlocked per unit of work**, and every item below is
phrased as a capability, never as a card. Cards are listed only as evidence that the capability
recurs.

The corollary, learned the hard way last increment: **every generic rule that lands can strand an
override's `handledLines`.** ADR 0009's drift guard flips such a card back to `modeled: false`,
which is correct and loud, but it means each phase below must end with a sweep of the ~867
registrations for newly-stale claims, not just a snapshot regen. Two rounds of that were needed
last time and both were caught only because the guard exists.

## Tier 0 — a bug, found while auditing

**`interpret.ts`'s general bounce regex never matches the singular possessive.**

```
/^return (?:up to (\w+) )?(other )?target (nonland permanent|creature|permanent)s? to (?:their|its) owners?' hands?$/
```

`owners?'` requires the apostrophe _after_ an optional `s`, so it accepts `their owners' hands`
but not `its owner's hand`. Verified:

| text                                                                | matches |
| ------------------------------------------------------------------- | ------- |
| `return up to two target nonland permanents to their owners' hands` | ✅      |
| `return target creature to its owner's hand`                        | ❌      |
| `return target nonland permanent to its owner's hand`               | ❌      |

The rule was written for Marang River Regent (plural, variable-count) and the singular form —
the single most common bounce template in Magic — has never worked. It is masked today by an
exact-string special case one branch above it for the one singular phrasing a fixture deck
needed (`return target nonland permanent you don't control to its owner's hand`), which is why
no test caught it.

Fix first, on its own commit, with a regression test covering both possessive forms. It is a
prerequisite for Snap, Sink into Stupor, and Hullbreaker Horror below, and it silently affects
an unknown number of cards outside these 200.

## Tier 1 — parser-only: no new `Effect`, `Selector`, or `Value`

Each of these composes primitives that already exist. Highest leverage, lowest risk; the golden
snapshots should stay byte-identical except where a card genuinely changes.

| #    | Capability                                                                                                                                   | Unlocks                                                             | Notes                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Split an effect sentence on `and` when **both** halves parse independently                                                                   | Tatyova; the second half of Deadly Dispute / Big Score / Storm-Kiln | The `, then ` split already exists and is the model to copy. Must be conservative: only split when both sides parse, or "destroy all creatures and planeswalkers" breaks.                               |
| 1.2  | `with mana value N or less/greater` as a **target-clause** qualifier                                                                         | Despark, Abrupt Decay                                               | `manaValueAtMost`/`manaValueAtLeast` already exist and now work on the battlefield; `parseMassSubject` already reads this phrase. Only `parseTargetClause` is missing it.                               |
| 1.3  | Controller suffix on mass subjects (`… your opponents control`)                                                                              | Ruinous Ultimatum                                                   | `parseMassSubject` drops the suffix `parseSubject` already handles.                                                                                                                                     |
| 1.4  | `A creature destroyed this way can't be regenerated` as a no-op sentence                                                                     | Damn                                                                | Sibling of the existing `it can't be regenerated`.                                                                                                                                                      |
| 1.5  | `attackTax` in `parseRuleStaticLine`                                                                                                         | Propaganda                                                          | The `RuleStatic` exists; Ghostly Prison has a hand-authored override for the **byte-identical** sentence. Generalizing lets that override be deleted — the exact duplication this whole effort targets. |
| 1.6  | Cost-reduction subjects: `Instant and sorcery spells you cast`, `Each spell you cast that's <color> or <color>`                              | Goblin Electromancer, Goblin Anarchomancer                          | `costReduction` `RuleStatic` already carries a `filter`.                                                                                                                                                |
| 1.7  | `cast or copy` as a `castsSpell` trigger head                                                                                                | Archmage Emeritus; half of Storm-Kiln                               | Filter half already works as of the last increment.                                                                                                                                                     |
| 1.8  | `dies` in the aggregate trigger head; `oncePerTurn` on **triggered** abilities                                                               | Morbid Opportunist                                                  | `AGGREGATE_TRIGGER_HEAD_RE` allows only `attack`/`deal combat damage`. `ActivatedAbility` has `oncePerTurn`; `Ability` does not.                                                                        |
| 1.9  | `Target player draws N cards [and loses N life]`                                                                                             | Sign in Blood                                                       | Needs a plain `drawTarget` op — `drawTargetAndController[N]` exists but always draws for both.                                                                                                          |
| 1.10 | `Untap up to N lands` (count slot, untargeted)                                                                                               | contributes to Snap, Frantic Search                                 | `untapEach` exists; the bounded "up to N" form does not.                                                                                                                                                |
| 1.11 | `If you control a commander, you may cast this spell without paying its mana cost`                                                           | Flawless Maneuver                                                   | `commanderFreeCast` already on `CardDefinition`; two overrides hand-author this exact line and can shrink.                                                                                              |
| 1.12 | `Put target <X> card from a graveyard onto the battlefield under your control` + `You lose life equal to that card's/permanent's mana value` | Reanimate, Feed the Swarm                                           | `graveyardToBattlefield` and the `manaValueOfTarget` `Value` both already exist — only the phrasings are missing.                                                                                       |
| 1.13 | `Untap all permanents you control during each other player's untap step`                                                                     | Seedborn Muse                                                       | `untapStep` + `player: 'each'` + `untapEach` all exist.                                                                                                                                                 |

**≈14 cards, no new engine surface.** Do these first and in one or two commits.

## Tier 2 — one new primitive, several cards each

Ordered by cards-per-primitive. Each is a real design decision, so each gets its own commit and
its own executor test (parser coverage alone is not enough — a primitive that parses and then
does nothing is worse than staying unmodeled).

1. **Additional costs on casting a spell — 6 cards.**
   Deadly Dispute, Big Score, Thrill of Possibility, Village Rites, Crop Rotation, Harrow.
   **Status (2026-08-30): implemented.** The generic primitive is wired through card definitions, parsing, legality, announcement payment, and executor coverage.
   `AbilityCost` already has `sacrificeOther`/`discardSelf`/`sacrificeSelf`; what is missing is
   anywhere to _hang_ costs on casting. `ActivatedAbility` carries `costs`, but a spell's only
   cost today is its mana cost, and `modes[].additionalCost` (Spree) is per-mode, not per-spell.
   Proposal: `CardDefinition.spellAdditionalCosts?: AbilityCost[]`, paid at announcement
   (CR 601.2h) alongside mana, and — critically — checked for _payability_ during option
   generation, so the engine never offers Village Rites with no creature to sacrifice.

2. **`libraryTop` as a `SearchDestination` — 4 cards.**
   **Status (2026-08-30): implemented.** SearchDestination.zone now includes libraryTop; the
   interpreter handles Enlightened, Mystical, Worldly, and Vampiric Tutor, and executor tests
   assert that the selected card is placed on top after the library is shuffled.
   (Gamble needs random discard too and is not closed by this alone.)

3. **MDFC layout — 3 cards.**
   **Status (2026-08-30): implemented.** Modal DFC spell // land cards now reuse the
   `AlternativeCast` shape for a typed back-face land option; legality, as-enters choices,
   battlefield characteristics, mana production, and front-face restoration on zone change are
   covered by the generic runtime path and dedicated executor tests.
   Sink into Stupor, Fell the Profane, and Revitalizing Repast are modeled.

4. **`unless that player pays {N}` on a cast trigger — 3 cards.**
   **Status (2026-08-30): shared primitive implemented.** The generic `unlessPays` effect now
   carries the cast-event player through trigger scope, asks that player whether they can pay, and
   executes the wrapped effect only when they decline or cannot pay. Rhystic Study is modeled and
   covered by dedicated executor tests. Mystic Remora still needs cumulative upkeep; Esper Sentinel
   still needs "first … each turn" plus `X = this creature’s power`.

5. **Free alternative casts with a non-mana cost — 2 cards.**
   **Status (2026-08-30): implemented.** `AlternativeCast` now carries typed non-mana costs and an optional
   announcement condition; Force of Will and Force of Negation are parsed and covered through legal
   option generation, life/payment resolution, and actual counter-spell execution.
   Force of Will, Force of Negation (`exile a blue card from your hand` ± `pay 1 life`).

6. **Commander-conditional modal header — 2 cards.**
   **Status (2026-08-30): implemented.** Modal abilities now carry a generic conditional maximum;
   Jeska's Will and Akroma's Will's choose-one/choose-both header shape is parsed and covered
   through announcement option generation, runtime mode execution, and forged-payload rejection.

7. **Token / counter doubling replacement — 2 cards.**
   Doubling Season, Hardened Scales. `RuleStatic` already carries `damageDoubled` as precedent
   for a CR 616 replacement; these are the same shape over `createToken` and `putCounters`.

**18 cards implemented; approximately 4 cards remain across 2 primitives.**

## Tier 3 — the long tail, planned

Re-triaged 2026-09-01 by running `interpretCard` over the named cards and cross-cutting the
result with `bun run coverage --json` (181 unmodeled cards across the 12 fixture decks). The
previous edition of this section was a flat list carrying the note "not worth planning in detail
yet". That is no longer true: Tiers 1–2 have consumed the cheap generic grammar, so the tail _is_
the work — and it is less flat than it looked. Sorting the 181 fixture blockers by the engine
surface they need, rather than by their sentence, produces clusters of 5–15 cards each.

### First, four corrections to the old list

It was written before Tier 2 landed, and four of its entries are now wrong:

| Old claim                    | Reality (measured)                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| cascade (Maelstrom Wanderer) | **Already closed.** `cascade` is an `IMPLEMENTED_KEYWORDS` member with a resolver; Maelstrom Wanderer is `modeled: true`.                       |
| Avenger of Zendikar          | **Already closed** — `modeled: true`. Landfall parses as `enters` with a land subject.                                                          |
| Sun Titan                    | **Not Tier 3.** "enters or attacks" already splits into two abilities (`interpret.ts:2330`). It is blocked only on Tier 1 item 1.12's phrasing. |
| Kutzil / Rishkar's Expertise | **Half-closed.** Kutzil's `cantCastSpells` line and Rishkar's `greatestPowerAmong` draw both parse; only their second lines remain.             |

Two further findings from the same pass, both of which should be fixed **before** Tier 3 starts:

- **Two overrides are stranded right now.** `Malakir Rebirth // Malakir Mire` and
  `Valakut Awakening // Valakut Stoneforge` each claim `unsupported layout "modal_dfc"`, a line
  Tier 2.3 removed. The drift guard has correctly flipped both to `modeled: false`. This is
  exactly the regression this plan warns about, and it accounts for the gap between the header's
  623/802 and today's measured **621/802 (77.4%)**.
- **`tokenCountMultiplier`'s regex misses Anointed Procession**, a top-20 EDH staple. It requires
  `…creates twice that many instead`; Anointed Procession prints `…creates twice that many of
those tokens instead`. Doubling Season matches, Anointed Procession does not. One optional group
  in `interpret.ts:3337` — Tier 1 cost, inside Tier 2.7's own family.

### The principle, restated for the tail

Tiers 1–2 grouped cards by _sentence shape_, because that is where the duplication was. In the
tail the sentences are all different and the duplication has moved one level down, into the
**engine surface** each sentence needs: a trigger event that does not exist, a zone permission
that is hardcoded, a modal block the parser only tries on spells. So Tier 3 is grouped by surface,
and each sub-tier below is one coherent change to one part of the engine, sized to be a single
commit with a single executor test.

Ordered by cards-per-unit-work, as everywhere else in this plan.

### 3.A — Trigger-event vocabulary (~14 cards, smallest surface)

**The gap.** `ObjectTriggerWhen` has ten members — `enters`, `dies`, `attacks`, `blocks`,
`dealsCombatDamageToPlayer`, `becomesTapped`, `fights`, `becomesTargeted`,
`enchantedPlayerAttacked`, `dealtDamage` — and the player-scoped dispatcher
(`objects.ts::queuePlayerTriggersForEvent`) is typed `when: 'gainsLife'` and nothing else. Three
of the most common EDH trigger events are simply not in the vocabulary: 7 fixture cards mention a
sacrifice event, 3 a token-creation event, and the draw event blocks four staples.

| Item | Event                                                        | Where it fires from                                                                                                                                                                                                                                                                               | Unlocks                                                               |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 3.A1 | `sacrificed` as an `ObjectTriggerWhen`                       | Needs a chokepoint. Sacrifice is spread across the `sacrifice*` ops and the `sacrificeSelf`/`sacrificeOther` costs, all funnelling into `moveObject` — which does **not** carry a reason. Add a reason to `MoveDestination` (or a thin `sacrificePermanent()` wrapper) and fire from there, once. | Mayhem Devil, Korvold, Mirkwood Bats' second half, 7 fixture cards    |
| 3.A2 | `tokenCreated` as an `ObjectTriggerWhen`                     | `objects.ts::createTokens` is already the single chokepoint — it is where `tokenCountMultiplier` and `applyTokenCreationReplacements` hook. Fire once per creation event, **after** the multiplier, so a doubled creation triggers on the real count.                                             | Mirkwood Bats, 3 fixture cards                                        |
| 3.A3 | `drawsCard` on `queuePlayerTriggersForEvent`                 | Widen the hardcoded `when: 'gainsLife'` parameter to a union and fire from `resolve.ts::drawCards`, already the single draw path (mulligan and turn draw both route through it).                                                                                                                  | Consecrated Sphinx, Nekusar, Orcish Bowmasters, Notion Thief (partly) |
| 3.A4 | `except the first one they draw in each of their draw steps` | A per-player, per-turn counter on `EnginePlayerState`, reset in `turn.ts` beside `landsPlayedThisTurn`. Expressed as a `Condition` on the trigger spec, not as a new event.                                                                                                                       | Orcish Bowmasters, Notion Thief                                       |
| 3.A5 | `putIntoGraveyardFromAnywhere` / `leavesGraveyard`           | Both are `moveObject` observations. The narrowest useful form is Syr Konrad's three-way head; do not generalize past what parses.                                                                                                                                                                 | Syr Konrad                                                            |

**Risk.** 3.A1 is the one with teeth: getting the chokepoint wrong means either double-firing (a
sacrifice that is also a state-based death) or missing cost-paid sacrifices, which are the common
case. Land the chokepoint and its executor test first, the parser second.

**Not included.** Amass (Orcish Bowmasters' `Then amass Orcs 1.`) is its own mechanic and stays in
3.H; 3.A3 + 3.A4 shrink Bowmasters to one remaining clause but do not close it.

### 3.B — Modal blocks beyond spells (~13 cards)

**The gap.** `parseModalSpellBlock` is competent — it handles `choose one`, `one or more`,
`one or both`, `any number`, `two`, `three`, exact-vs-up-to counts, per-mode target-slot
allocation, and (since Tier 2.6) a conditional maximum. It is called from exactly one place,
inside `if (isSpell)` at `interpret.ts:3916`. Every modal **triggered** or **activated** ability
therefore fails at its header line, which is why `unrecognized rules text: "Choose one —"` is the
joint-top reason string in the fixture run and why 9 fixture cards carry a modal blocker.

1. **Lift the block parser out of the `isSpell` guard.** A triggered ability's body is a modal
   block whenever the text after the trigger head starts with a choose-header. The mode choice is
   then made on resolution (CR 700.2) rather than at announcement, which the existing
   `Ability.modes` shape already expresses — the executor path for modes is shared.
   Unlocks **Hullbreaker Horror**, **Black Market Connections**.
2. **`choose up to one`** in the header regex (Hullbreaker Horror) — a new alternative with
   `minChoices: 0`.
3. **Named modes** — `• Sell Contraband — Create a Treasure token. You lose 1 life.` The bullet
   regex must strip a leading `<Name> —` label before handing the rest to `parseEffectSentence`,
   keeping the label as the mode `description`. Ability-word prefixes are already stripped
   elsewhere; this is the same shape one level in.
   Unlocks **Black Market Connections**, 6 fixture ability-word cards.
4. **`Choose three. You may choose the same mode more than once.`** — a `repeatable: true` flag on
   `Ability['modes']` and a selection loop that does not remove a chosen option.
   Unlocks **Mystic Confluence** and the Cryptic Command family.
5. **`Change the target of target spell or ability with a single target`** — retargeting: a real
   new primitive (a `TargetKind: 'spellOrAbility'` plus a `retarget` op). Unlocks **Untimely
   Malfunction**'s third mode. Take it last or defer it to 3.H; modes 1 and 2 parse today, and a
   partly-parsed modal spell must stay `modeled: false` regardless.

**Verification note.** Modal blocks are the highest-risk area for this plan's "no over-permissive
parsing" non-goal. A modal ability where one bullet parses and one does not must return `null` for
the whole block, never a partial mode list. `parseModalSpellBlock` gets this right today (`return
null` inside the bullet loop); the lifted version must keep it, and the test for that should be
written before the lift.

### 3.C — Zone-permission statics (~10 cards)

**The gap.** Two rules-of-the-game questions are hardcoded rather than modelled:

- **How many lands may I play?** `legal.ts:577` and `legal.ts:605` both test
  `player.landsPlayedThisTurn < 1` inline.
- **From which zone?** `RuleStatic` has `castFromZone` with `zone: 'libraryTop'`, for _spells_
  only. Playing a **land** from anywhere but the hand has no representation at all.

1. **`{ kind: 'additionalLandDrops'; count: Value }` `RuleStatic`**, plus a
   `queries.ts::landDropLimitFor(ctx, playerId)` that sums them, replacing both hardcoded
   comparisons. `Value` rather than `number`, so Azusa's "two additional" and Exploration's "an
   additional" are one rule.
   Unlocks **Exploration**, **Dryad of the Ilysian Grove** (half), **Azusa**, **Wayward
   Swordtooth** (half), **Oracle of Mul Daya** (half).
2. **Widen `castFromZone` into a `playFromZone`** covering `zone: 'libraryTop' | 'graveyard'` with
   a `permanentTypes` restriction. Muldrotha's "a permanent spell of each permanent type" needs a
   per-type, per-turn budget on the player state — the same shape as 3.A4's per-turn counter, and
   worth building the two together.
   Unlocks **Oracle of Mul Daya**, **Courser of Kruphix**, **Ancient Greenwarden** (half),
   **Muldrotha**.
3. **`Play with the top card of your library revealed`** — a visibility change, not a rules change:
   it belongs in `view.ts`, not in `RuleStatic`. Needed by Oracle and Courser, and the item most
   likely to be mis-scoped, because the engine must reveal that card to _every_ `PlayerView`
   without leaking the rest of the library (brief §7.1). Its own commit, with a view-level test.
4. **Widen `cantCastSpells` to cover activated abilities.** The static already carries
   `who`/`yourTurnOnly`; Grand Abolisher additionally bars "activate abilities of artifacts,
   creatures, or enchantments" — a `Selector` over the ability's source.
   Unlocks **Grand Abolisher**; **Kutzil**'s first line already uses the unwidened form.
5. **`Lands you control are every basic land type`** — a layer-4 type-setting `ContinuousOp` over a
   `Selector`. It interacts with mana production (those lands must then tap for all five colors),
   so it is a `staticEffects` change with a `manaAbilities` consequence and needs both tests.
   Unlocks **Dryad of the Ilysian Grove**, **Leyline of the Guildpact** (with its all-colors half).

### 3.D — Alternative casts from the graveyard (~6 cards)

**The gap.** Flashback and escape are the same primitive: cast this card from your graveyard for a
replacement cost, then exile it. Tier 2.5 already built **typed non-mana costs on
`AlternativeCast`** and Tier 2.2 built graveyard-adjacent zone movement, so the machinery exists.
What is missing is a `from: 'graveyard'` on `AlternativeCast` and its legality plumbing.

1. `AlternativeCast.from?: 'hand' | 'graveyard'` (defaulting to hand), plus "exile it as it
   resolves or is countered" (CR 702.33a) — a post-resolution replacement, not a rider effect.
2. Parse `Flashback {2}{R}` and `Flashback—{1}{U}, Pay 3 life.` The em-dash form is _already_ the
   Tier 2.5 shape: a mana cost plus a typed non-mana cost.
   Unlocks **Faithless Looting**, **Deep Analysis**.
3. Parse `Escape—{G}{G}{U}{U}, Exile five other cards from your graveyard.` plus the `it escaped`
   condition Uro reads back — which needs a "was cast for its escape cost" flag on the stack
   object, something nothing carries today.
   Unlocks **Uro**, 1 fixture card (`Escape—{2}{R}{G}, Exile three other cards…`).
4. **Defer** the statics that _grant_ flashback or escape to other cards (Past in Flames,
   Underworld Breach) to 3.H. They need a granted-ability-over-a-zone mechanism nothing else needs.

### 3.E — Library and hand ordering (~7 cards)

**The gap.** `lookAtTopN` exists but hardcodes `rest: 'bottomRandom'`, and there is no way to put a
card from **hand** onto the library. 5 fixture cards need one of these, and four of the cheapest
staples in the whole backlog sit here.

1. `lookAtTopN.rest: 'bottomRandom' | 'topAnyOrder'`, plus `mayShuffle?: true`.
   Unlocks **Ponder**, **Sensei's Divining Top** (first ability), **Portent** (with a target
   player), and **Sylvan Library**'s put-back half.
2. `{ op: 'putFromHandOnLibraryTop'; count: Value; anyOrder: true }`.
   Unlocks **Brainstorm** and the Frantic Search family.
3. `{ op: 'discardAtRandom'; count: Value }` — via the engine's seeded RNG, never `Math.random()`
   (brief §5.9). Unlocks **Gamble**, together with the existing `searchLibrary`.
4. **Sylvan Library** additionally needs "cards drawn this turn" as a tracked set and a per-card
   `pay 4 life or put it back` loop. That is bespoke; the items above shrink it but do not close
   it. It stays in 3.H unless it falls out for free.

### 3.F — Mana-system reach (~6 cards)

**The gap.** `ManaAbilitySpec.dynamic` has three members (`commanderIdentity`,
`opponentLandColors`, `chosenColor`). The two recurring EDH shapes it lacks are colour-counting,
and mana produced as a rider on _tapping a land_ — an event the engine has no representation for.

1. `DynamicManaKind: 'colorsAmongPermanents'` — "For each color among permanents you control, add
   one mana of that color". Pairs with a `colorsAmongPermanents` **`Value`** for the P/T half.
   Unlocks **Bloom Tender**, **Faeburrow Elder** (both of its lines).
2. `devotionTo(color)` as a `Value`, reading the mana costs of controlled permanents (CR 702.4c) —
   a pure `queries.ts` function, no new state.
   Unlocks **Gray Merchant of Asphodel**, **Nykthos**, 1 fixture card.
3. **Mana riders on land taps.** Wild Growth and Mirari's Wake both add mana as a rider on someone
   else's mana ability. This is the awkward one: mana abilities do not use the stack (CR 605.3a),
   so the "trigger" must resolve inline inside mana production, the way `ManaAbilitySpec.onActivate`
   already does for painlands. Model it as a **static rider that the mana-production path consults**,
   not as a `pendingTriggers` entry.
   Unlocks **Wild Growth**, **Mirari's Wake**.
4. `ManaRestriction` + "and that spell can't be countered" — the restriction half already exists;
   the rider is a per-spell flag set at payment time. Unlocks **Delighted Halfling**.
5. `Add {C} equal to that spell's mana value` on a delayed main-phase trigger — **Mana Drain**.
   `spellManaValue` and delayed triggers both exist; this is pure composition, so take it here
   rather than leaving it in the residue.

### 3.G — Transform DFCs (~7 fixture cards, the largest single fixture win left)

**The gap.** `unsupported layout "transform"` is the joint-top reason string in the fixture run,
and four more fixture cards are blocked on transform-adjacent trigger text (`Whenever this creature
enters or transforms into ~`, `you may pay {G}. If you do, transform ~`). Nothing in the engine
models a second face a permanent flips to in place.

**Why it is cheaper than it looks.** Tier 2.3 built the whole back-face apparatus for MDFCs:
`MdfcLandFace` carries a full second set of characteristics, legality knows about alternative
faces, `entersChoosingOption`/`chosenOption` already stores per-permanent as-enters state, and
front-face restoration on zone change is implemented and tested. Transform differs in exactly three
ways: the flip happens **on the battlefield** rather than at cast time, it is triggered rather than
chosen, and the back face is a full permanent rather than a land.

**The work.** Generalize `MdfcLandFace` into a `BackFace` with the same shape as the front
(`types`, `power`, `toughness`, `keywords`, `staticEffects`, `triggers`); add a
`{ op: 'transformSelf' }` effect and a `transformed: boolean` on `EnginePermanent` that
`computeCharacteristics` reads; reuse the existing front-face-on-zone-change reset. Do this
**after** 3.A–3.C — it is the largest sub-tier, and it benefits from the trigger vocabulary landing
first.

### 3.H — Residue: genuinely bespoke, and honestly so

What is left after 3.A–3.G really is one-card-one-mechanic, and grinding it is still a poor use of
time. Listed so the backlog stays visible:

- **Whole subsystems with no reuse in sight**: phasing (Teferi's Protection), amass (Orcish
  Bowmasters), exalted (both Hierarchs), ward-as-life-payment, granted-ability-over-a-zone (Past in
  Flames, Underworld Breach), retargeting (Untimely Malfunction) if not taken in 3.B.
- **Multi-clause one-offs**: The One Ring, Etali, Scute Swarm, Windfall, Eerie Ultimatum, Culling
  Ritual, Victimize, Annie Joins Up, The Great Henge, Rishkar's Expertise (second line only), Swan
  Song, An Offer You Can't Refuse, Professional Face-Breaker, Deathrite Shaman, Tireless
  Provisioner, Inspiring Call, Sylvan Library.
- **Individually cheap; take opportunistically** when a neighbouring sub-tier is already open:
  **Farewell** (needs only `exile all graveyards` — its other three bullets parse today), **Swan
  Song** and **An Offer You Can't Refuse** (counter, then a token for the _target's_ controller),
  **Assassin's Trophy** (`searchLibrary` run for another player).

That last bullet is worth reading twice: **three of the "bespoke" cards share one missing
capability** — an effect whose beneficiary is the target's controller rather than the ability's
controller. It may deserve promotion out of the residue once someone has counted how often that
shape recurs outside these 200.

## Sequencing

Re-ordered 2026-08-28. The clusters above come **first**: they are measured against decks the
engine currently cannot play at all, where the precon-derived Tier 1/2 items below are measured
against decks already at 96–100% and therefore buy far less per unit of work.

| Phase | Content                                                                                                                | Expected (fixture aggregate) |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A     | **Cluster A** — `countOf(selector)` as a `Value` in P/T, token counts, counter counts                                  | 597 → ~609                   |
| B     | **Cluster B** — goad + forced-attack parsing over existing `goadEachOpponent`                                          | ~609 → ~619                  |
| C     | **Cluster C** — "others enter with additional counters" static, **and** dropping the Sage of Fables / Gev false claims | ~619 → ~624                  |
| D     | **Cluster D** — loyalty-ability parsing over the existing `loyalty` `AbilityCost`                                      | ~624 → ~629                  |
| 0–4   | The original precon/staple phases below, unchanged                                                                     | as stated                    |

Phases A–D are independent of one another and of 0–4; take them in any order, but take each as
its own commit. Cluster C should not be started before someone has read the false-claim warning
in it.

### Original sequencing (the 200-staple population)

| Phase | Content                                                | Expected                     |
| ----- | ------------------------------------------------------ | ---------------------------- |
| 0     | The bounce-regex bug + regression test                 | +0–1 here, unknown elsewhere |
| 1     | Tier 1 items 1.1–1.13, 1–2 commits                     | ~107 → ~121                  |
| 2     | Tier 2 items 1–3 (additional costs, library-top, MDFC) | ~121 → ~134                  |
| 3     | Tier 2 items 4–7                                       | ~134 → ~143                  |
| 4     | Re-measure, re-triage Tier 3 with fresh counts         | done 2026-09-01 — see Tier 3 |

Do not batch phases into one commit. Last increment's two drift-guard regressions were both
found by re-running the 200-card check between commits; a single large commit would have hidden
which rule stranded which override.

### Tier 3 sequencing (added 2026-09-01)

Phase 4's re-triage is done, and Tier 3 now has its own ordering. The two prerequisites are not
optional: P1 restores two cards the drift guard has already flipped off, and P2 restores the
instrument the rest of this table is measured with.

| Phase | Content                                                                        | Expected (fixture aggregate) |
| ----- | ------------------------------------------------------------------------------ | ---------------------------- |
| P1    | Un-strand the two `modal_dfc` overrides; fix the Anointed Procession regex     | 621 → ~623                   |
| P2    | Commit the 200-staple checker and its card list (see below)                    | —                            |
| 3.A   | Trigger-event vocabulary — sacrifice, token-created, draw, graveyard-crossing  | ~623 → ~633                  |
| 3.C   | Zone-permission statics — land drops, play-from-zone, revealed top, type grant | ~633 → ~640                  |
| 3.E   | Library and hand ordering                                                      | ~640 → ~645                  |
| 3.B   | Modal blocks beyond spells                                                     | ~645 → ~654                  |
| 3.D   | Graveyard alternative casts (flashback, escape)                                | ~654 → ~659                  |
| 3.F   | Mana-system reach                                                              | ~659 → ~664                  |
| 3.G   | Transform DFCs                                                                 | ~664 → ~671                  |
| 3.H   | Residue — opportunistic only, never as a phase of its own                      | —                            |

3.A before everything else: three later sub-tiers (3.C's per-turn budgets, 3.D's escape flag,
3.G's transform trigger) each want a per-turn/per-object counter of the shape 3.A4 introduces, and
building that once is the whole point. 3.G last because it is the largest and reads best on top of
the trigger vocabulary. 3.B's ordering is soft — it is independent of the rest and can move
earlier if the modal reason strings start dominating a re-measure.

**P2 is a real blocker, not bookkeeping.** The 200-staple checker is not committed — the plan's
own "Reproduce with the three `scryfall_response_*.json` batches and the checker in the session
scratchpad" means the staple number cannot currently be re-measured by anyone but its author. Every
"Expected" column in the original sequencing table above is stated in a unit nobody can compute
today. Committing the card list (names only — no third-party card data) plus a checker that reads
the existing gitignored bulk file costs an afternoon and makes the other half of this plan
falsifiable.

## Verification (every phase, non-negotiable)

```bash
bun run typecheck                                   # baseline 2026-08-28: CLEAN
bun run typecheck:tests                             # baseline: CLEAN (engine + server test projects)
bun run test                                        # baseline: 1107 passing, 1 failing (Kalain — see Cluster C)
bun run lint                                        # baseline: 66 pre-existing errors — introduce none
bun run coverage                                    # 2026-09-01: 621/802 (77.4%) across 12 fixtures
bun run scripts/snapshot-override-defs.ts --check   # 2026-09-01: 842 registrations
bun run scripts/snapshot-interpret-defs.ts --check  # 93 cards
```

The `bun run coverage` figure was **597/802 (74.4%)** on 2026-08-28 and is **621/802 (77.4%)** as
of 2026-09-01. Note that the header of this document claims 623 — the two-card difference is the
pair of stranded `modal_dfc` overrides that Tier 3 phase P1 exists to fix, not a measurement
error. The override registration count fell from 844 to 842 as Tier 2 deleted redundant
registrations, which is the intended direction.

The typecheck baselines changed on 2026-08-28: the two `test-cards-*` harnesses no longer
statically `import … assert { type: 'json' }` the 200 MB bulk file (which made `tsc` OOM once
the file grew), and `packages/server` now splits production from test typechecking the way
`packages/engine` already did — `tsconfig.json` excludes suites, `tsconfig.test.json` includes
them plus `packages/engine/tests`.

Plus, per phase:

1. Re-run the 200-card checker and record the new modeled count.
2. **Grep the override registry for newly-stale `handledLines`** matching whatever shapes the
   phase generalized. The 200-card check only exercises registrations that happen to collide with
   those 200 cards; the sweep is what catches the other ~800.
3. Any override the phase makes fully redundant is **deleted**, not left empty — an empty `def`
   is rejected by `applyOverride` and only adds noise.
4. A new primitive needs an executor test, not just a parser assertion.

## Non-goals

- Trimming the two 102-card community fixtures to a legal 100. They are snapshotted verbatim on
  purpose; the illegal count costs the coverage measurement nothing, and editing someone's deck
  to fit the tool inverts which one is serving the other.
- Chasing the 200-card number for its own sake. A card modeled by a bespoke override that no
  other card can reuse is worth less than a generic rule that closes three cards and shrinks two
  overrides.
- Over-permissive parsing. The engine's contract is to halt loudly on what it cannot model
  (brief §6.3); a rule that half-reads a sentence and silently drops a clause is strictly worse
  than leaving the card unmodeled. Every item above should return `null` on anything it does not
  fully understand.
- Fixing the pre-existing `typeLine: "Token Creature — X"` vs `"Creature — X"` divergence between
  `parseTokenFace` and the shared token catalog. It is real (it is why three token-creating
  removal overrides still exist), but it touches every parser-derived token and deserves its own
  change, not a drive-by inside a coverage phase.
