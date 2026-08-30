# Plan — closing the EDH-staple coverage gap

> Status: proposed. Baseline measured 2026-08-07 at commit `83120f5`:
> **107 / 200 modeled**, 93 remaining.

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

## Tier 3 — genuinely bespoke, and honestly so

The remaining ~57 are each one deep mechanic, and grinding them is a poor use of time relative to
Tiers 1–2. They are worth _listing_ so the backlog is visible, not worth planning in detail yet:

- **Whole subsystems**: phasing (Teferi's Protection), cascade (Maelstrom Wanderer), flashback
  (Faithless Looting), amass (Orcish Bowmasters), devotion (Gray Merchant), exalted (both
  Hierarchs), ward-as-life-payment (Hexing Squelcher).
- **Mana-system reach**: `for each color among permanents you control` (Faeburrow Elder, Bloom
  Tender), triggered extra mana on land tap (Mirari's Wake, Wild Growth), restricted-and-uncounterable
  mana (Delighted Halfling), `Add {C} equal to that spell's mana value` (Mana Drain).
- **Rules-modifying statics**: additional land drops (Explore, Exploration, Dryad), basic-land-type
  grants (Dryad, Leyline of the Guildpact), cast-from-graveyard-by-type (Muldrotha), opponent
  action locks (Grand Abolisher), all-colors (Leyline).
- **Multi-clause one-offs**: Sylvan Library, The One Ring, Etali, Syr Konrad, Scute Swarm,
  Avenger of Zendikar, Sun Titan, Windfall, Eerie Ultimatum, Culling Ritual, Victimize,
  Untimely Malfunction (retargeting), Hullbreaker Horror, Black Market Connections, Annie Joins
  Up, Kutzil, The Great Henge, Rishkar's Expertise, Assassin's Trophy, Swan Song, An Offer You
  Can't Refuse, Farewell (needs `exile all graveyards`), Professional Face-Breaker, Deathrite
  Shaman, Tireless Provisioner, Mirkwood Bats, Mayhem Devil, Brainstorm, Inspiring Call, Ponder,
  Frantic Search, Gamble.

Some of these are individually cheap (Ponder, Brainstorm, Farewell, Mirkwood Bats, Mayhem Devil)
and are fine to pick up opportunistically once a neighbouring Tier-1/2 item is in hand. None
should be done _before_ Tiers 1–2.

## Sequencing

| Phase | Content                                                | Expected                     |
| ----- | ------------------------------------------------------ | ---------------------------- |
| 0     | The bounce-regex bug + regression test                 | +0–1 here, unknown elsewhere |
| 1     | Tier 1 items 1.1–1.13, 1–2 commits                     | ~107 → ~121                  |
| 2     | Tier 2 items 1–3 (additional costs, library-top, MDFC) | ~121 → ~134                  |
| 3     | Tier 2 items 4–7                                       | ~134 → ~143                  |
| 4     | Re-measure, re-triage Tier 3 with fresh counts         | —                            |

Do not batch phases into one commit. Last increment's two drift-guard regressions were both
found by re-running the 200-card check between commits; a single large commit would have hidden
which rule stranded which override.

## Verification (every phase, non-negotiable)

```bash
bun run typecheck                                   # baseline: 8 pre-existing errors, all from the gitignored data/ bulk file
bun run test                                        # baseline: 1031 passing, 5 files failing to load for the same reason
bun run lint                                        # baseline: 83 pre-existing errors — introduce none
bun run scripts/snapshot-override-defs.ts --check   # 867 registrations
bun run scripts/snapshot-interpret-defs.ts --check  # 93 cards
```

Plus, per phase:

1. Re-run the 200-card checker and record the new modeled count.
2. **Grep the override registry for newly-stale `handledLines`** matching whatever shapes the
   phase generalized. The 200-card check only exercises registrations that happen to collide with
   those 200 cards; the sweep is what catches the other ~800.
3. Any override the phase makes fully redundant is **deleted**, not left empty — an empty `def`
   is rejected by `applyOverride` and only adds noise.
4. A new primitive needs an executor test, not just a parser assertion.

## Non-goals

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
