# 0007 — Computed characteristics as the single source of truth

Date: 2026-07-24
Status: Accepted

## Context

A survey of the two mature open-source engines turned up three things worth copying, and one
worth _not_ copying.

[Forge](https://github.com/Card-Forge/forge) applies continuous effects in
`GameAction.checkStaticAbilities()`: clear previously applied changes → collect active static
abilities → sort by timestamp and characteristic-defining status → apply layer by layer,
re-evaluating dependency after each application. It is called on every zone change and inside
the state-based-action loop, and results are stored on each `Card` as timestamped
`addChanged*` lists, so `getType()` and `getKeywords()` are cheap reads.
[XMage](https://github.com/magefree/mage)'s `ContinuousEffects.apply(game)` does the same into
game state. **Neither computes characteristics on demand per query.**

Two further points from Forge: its layer 6 (`ABILITIES`) covers "keywords, spellabilities,
triggers, replacements" — the whole ability set, not just keywords — and its
`CONTINUOUS_LAYERS_WITH_DEPENDENCY` constant deliberately _excludes_ `COLOR`, `MODIFYPT` and
`RULES`, skipping dependency analysis in layers where it cannot arise.

The thing not to copy: XMage handles CR 613.8 with a hand-maintained 13-value `DependencyType`
enum (`BecomeForest`, `BecomeIsland`, `AddingAbility`, …) that its own documentation calls
"a workaround solution to handle dependencies of continuous effects". Our empirical
trial-application detection (ADR 0006) needs no such table and matches Forge's
re-evaluate-after-each-application behavior. **Keep it.**

Measured against our engine, three concrete problems:

1. **The ADR 0006 fast path protects the test suite, not real decks.** 20k `effectivePT` calls
   over 40 permanents: 130 ms with no static ability in play, 421 ms with one, 698 ms with two,
   **2215 ms with four** — an ordinary Commander board. Combat performs O(attackers × blockers)
   P/T reads on top of that.
2. **Abilities bypass the layer system.** `Characteristics` computes `keywords`, but triggers
   and mana abilities were read straight off `CardDefinition` (`turn.ts`, `objects.ts`,
   `queries.ts`). A permanent that loses its abilities still triggered, a granted trigger was
   inexpressible, and `manaOverride` existed only as a bolt-on for Blood Moon.
3. **Types and subtypes bypass it inconsistently.** `isCreaturePermanent` routed through the
   layers, but the Planeswalker, Battle, Aura and Equipment state-based actions and the
   land-play/flash legality checks read printed values. An animated permanent got the right
   combat math and the wrong SBA.

## Decision

### 1. Memoize the layer pass on a content digest

A revision counter bumped at each mutation site was rejected: missing one site returns stale
characteristics _silently_, and the test suite's direct state surgery
(`perm.counters['+1/+1'] = 1`) would defeat it wholesale. Instead the cache is keyed on a
**digest of exactly the state the pass reads** — battlefield membership and each permanent's
timestamp, oracle id, base P/T and counters, plus the until-end-of-turn effect list. A digest
cannot miss a mutation: if an input changed, the key changes.

Counters are folded generically rather than just the two the engine reads today, so an op that
starts reading a new counter kind cannot silently get a stale answer.

The one variable-cost input is graveyard contents, read only by state-dependent `Value`s
(Tarmogoyf's CDA). Folding every graveyard on every call would undo the savings, so the cache
records whether the last pass actually used one; if not, graveyards stay out of the key. This
is sound: a change no effect reads cannot change the answer, and a Tarmogoyf _entering_ alters
the battlefield portion of the digest, forcing a miss.

`MTG_VERIFY_LAYER_CACHE=1` recomputes on every cache hit and throws if the results disagree.
The full suite — including four complete games and the determinism runs — passes under it.

With the cache in place the ADR 0006 fast path is deleted: one pass serves every subsequent
query until state changes.

**Result:** cost is now flat in the number of static abilities — 42/38/40/**37** ms for
0/1/2/4 statics, against 130/421/698/**2215** ms before. The honest worst case, state mutated
between every single query, is unchanged at ~2.3 s; in play, reads greatly outnumber mutations.

## Consequences

- ADR 0006's fast-path section is superseded.
- Dependency analysis is skipped in sublayer 7d, following Forge's
  `CONTINUOUS_LAYERS_WITH_DEPENDENCY`: pump effects cannot change each other's existence,
  affected set, or magnitude.

<!-- Sections 2 (abilities into Characteristics) and 3 (routing the remaining reads) follow. -->
