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
   layers, but the Planeswalker, Battle, Aura and Equipment state-based actions and the legend
   rule read printed values. An animated permanent got the right combat math and the wrong SBA.
   (The initial survey also flagged the land-play and flash legality checks; on inspection
   those read cards outside the battlefield and are correct — see section 3.)

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

> **Correction (ADR 0008).** Verify mode recomputes the whole battlefield on every query, which
> is roughly 20× slower, so the two whole-game tests exceed vitest's default 5s per-test limit
> and report as failures. They are timeouts, not staleness. The check must be run as
> `MTG_VERIFY_LAYER_CACHE=1 npx vitest run --testTimeout=300000`; under that it is green, with
> no "stale layer cache" error. The unqualified claim above was an overstatement.

With the cache in place the ADR 0006 fast path is deleted: one pass serves every subsequent
query until state changes.

**Result:** cost is now flat in the number of static abilities — 42/38/40/**37** ms for
0/1/2/4 statics, against 130/421/698/**2215** ms before. The honest worst case, state mutated
between every single query, is unchanged at ~2.3 s; in play, reads greatly outnumber mutations.

### 2. Abilities are characteristics

`Characteristics` now carries `triggers` and `manaAbilities` alongside `keywords`, and layer 6
gained `loseAllAbilities` as an effect in its own right — distinct from the CR 305.7 ability
loss that follows a layer-4 subtype change. `manaOverride` is deleted: mana abilities are just
abilities, replaced by a subtype change or removed by layer 6 like anything else.

`triggersOf(ctx, perm)` replaces `def.triggers` at both queue sites. For a `diesSelf` trigger
the permanent has already left the battlefield, so this is last-known information — continuous
effects from _other_ permanents still apply to it, which is what decides whether it had the
trigger at all.

`ManaAbilitySpec` moved from `definition.ts` to `ability.ts` so `Characteristics` can hold it
without an import cycle. A mana ability is an ability; it belongs with the IR.

### 3. Routing the remaining reads, and one non-bug

The four state-based actions that read printed values — planeswalker loyalty, battle defense,
Aura attachment, Equipment attachment — plus the legend rule's `Legendary` check now read
computed characteristics. Previously an animated permanent got the right combat math and the
wrong SBA.

**`actions/legal.ts` was listed as a bug in the plan and is not one.** Its `def.types` and
`def.keywords` reads are against cards in hand or the command zone, which no modeled continuous
effect reaches — printed values are correct there. (Play-permission effects like Leyline of
Anticipation are Forge's layer 8 `RULES`, a separate mechanism, not layer 6 on the card.)

`tests/characteristics-source.test.ts` guards the boundary: it fails if any module outside an
explicit, reasoned allowlist reads `def.types|subtypes|supertypes|keywords|triggers|
manaAbilities`. A second assertion fails when an allowlist entry stops being needed, so the
list cannot rot — it caught `cards/interpret.ts` immediately, which builds definitions from
locals and never reads one.

## Consequences

134 tests pass (up from 129). The determinism log stays byte-identical, and the full suite —
four complete games included — passes under `MTG_VERIFY_LAYER_CACHE=1`.

Three new behavioral tests, and the trigger one was checked to fail when `queueTriggers` is
reverted to `def.triggers`, so it is evidence rather than decoration.

- ADR 0006's fast-path section is superseded.
- Dependency analysis is skipped in sublayer 7d, following Forge's
  `CONTINUOUS_LAYERS_WITH_DEPENDENCY`: pump effects cannot change each other's existence,
  affected set, or magnitude.

### Deliberately not done

- **Layer-6 ability removal does not retroactively unmake layer-4 effects.** A source stripped
  in layer 6 stops contributing to layers 6 and later, but a layer-4 effect it already
  contributed stays applied — which is the correct reading, and the reason Humility +
  Opalescence is still the open stress case. Opalescence additionally needs a
  `Value` for mana value.
- **Activated abilities are not yet characteristics**, because the engine has no activated
  abilities at all. When they arrive they belong in `Characteristics` next to `triggers`, and
  Mutavault's self-animation becomes expressible.
- **The interpreter emits no `loseAllAbilities`**; it is reachable only from hand-written
  definitions. Real Humility needs layer-7b set-P/T from a `Value` as well.

## Amendment 1 (2026-11-15): a 53-bit digest

The digest was one 32-bit lane of `h = (h ^ x) * prime`. The engine work counters found it
colliding in benchmark games, and any 32-bit key collides about 8 times over the 2^18
tapped/untapped mixes of 18 lands (the old one did 12). A collision is a cache hit on a different
state. `digestOf` now scrambles each word MurmurHash3-style into two lanes that rotate and
multiply differently and returns 53 bits, the most a JS number holds exactly; strings fold in as
their own 53-bit digests, and variable-length runs are length-prefixed or terminated.
`tests/layer-digest.test.ts` pins the width and the absence of collisions on those grids. Games
and work counts were unchanged on the benchmark seeds.

## Amendment 2 (2026-11-15): tapped status is a key input only when a pass reads it

Tapped status was folded into the digest unconditionally (Iymrith's "ward {4} as long as it's
untapped"). The stateful mana planner taps a source in every state it searches, so every searched
state missed the cache and ran a full layer pass: 72% of all layer passes on the benchmark seeds,
almost all from one Exotic Orchard game.

Tapped status is now gated like graveyards, but measured rather than inferred. Every tapped read a
layer pass can reach goes through `tappedState` (`cards/selector.ts`), which counts its reads; the
pass records whether the count moved (`usedTapped`), and the next lookup leaves `tapped` out of the
key when it did not. This is sound for the graveyard flag's reason: the pass is a function of the
digest's other inputs plus whatever it read, so a pass that read no tapped status has the same
answer for every tapped mix of the same board, and a reader entering changes the battlefield part
of the digest and forces a miss that sets the flag again.

The risk is a raw `.tapped` read added to code a pass reaches. `tests/layer-tap-reads.test.ts`
fails on one in the files a pass runs (continuous, values, condition, selector, source identity),
and `MTG_VERIFY_LAYER_CACHE=1` and the `strictInvariants` sampling still recompute on hits. Result
on `engine-bench --games 6 --turn-cap 40`: layer passes 38,228 to 17,860, every fingerprint
identical.
