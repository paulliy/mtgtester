# 0005 — Continuous effects & the CR 613 layer system

Status: accepted (increment) — 2026-07-24
Context: a design stress-test against notoriously hard cards (ADR 0004 follow-up). The
ability IR (ADR 0004) models one subsystem — effects that resolve on the stack. A pile of
real cards is not expressible that way no matter how many `Effect` primitives are added.

## Expressiveness assessment

Cards grouped by the subsystem they demand:

| Class              | Example                                       | Subsystem                             | New `Effect` primitive enough? |
| ------------------ | --------------------------------------------- | ------------------------------------- | ------------------------------ |
| Resolution verbs   | bounce, tap-all, tutor, tokens                | more `Effect` ops                     | yes (the easy majority)        |
| Type-changing      | Mutavault, Blood Moon, Conspiracy             | **continuous effects + layers** (4/6) | no                             |
| P/T from state     | Tarmogoyf, `*`/`*` CDAs                       | **`Value`** (layer 7a)                | no                             |
| Copy               | Clone, Vesuvan                                | copy layer (1)                        | no                             |
| Layer dependencies | Humility + Opalescence                        | layer **dependency** ordering (613.8) | no (hard corner)               |
| Modes              | Cryptic Command, charms                       | modal abilities                       | no                             |
| Variable           | Fireball, X spells                            | `X`/values + target ranges + division | no                             |
| Replacement        | Doubling Season, Rest in Peace, Panharmonicon | **replacement effects** (off-stack)   | no                             |
| Alt-cast           | Flashback, Escape, Cascade, Adventure         | cast-permission + cost model          | no                             |
| Irreducible        | Shahrazad, Mindslaver, Chaos Orb, ante        | —                                     | **excluded by policy**         |

## Decision

Generalize the IR's core abstractions so subsystems plug in without a rewrite, and build the
continuous-effect subsystem first (it is what "change card types" needs).

- **`Value`** (`cards/value.ts`) — a number that is constant OR computed from game state
  (X, CDAs, "equal to its power"). Introduced before more `amount: number` gets baked in.
- **`Selector`** (`cards/selector.ts`) — a predicate over permanents/players. One abstraction
  covers targeting, "each", and the _affected set_ of a continuous effect.
- **`ContinuousEffect` + the layer engine** (`effects/continuous.ts`) — a permanent's current
  characteristics are computed by applying every applicable continuous effect in CR 613
  order: layer 4 (type), 6 (abilities), 7a CDA / 7b set / 7c counters / 7d modify, ordered
  within a layer by **timestamp**. Sources: static abilities of battlefield permanents
  (Blood Moon), CDAs (Tarmogoyf), until-end-of-turn effects (Giant Growth → 7d, keyword grant
  → 6), and counters (7c). `effectivePT` / `hasKeyword` / type checks / mana all read through
  this, so a type-change is respected everywhere.

### Scope of this increment

Proven on **Tarmogoyf** (CDA 7a), **Blood Moon** (static, layer-4 selector over other
permanents, with the mana-ability consequence), and **Mutavault**'s continuous effect (7b set

- layer-4 add-creature, its activated-ability trigger is a later increment). Behavior for the
  existing pool is unchanged (determinism test byte-identical): those cards contribute only
  7c/7d/6 effects that sum as before.

### Deliberately deferred (documented, not silent)

- **CR 613.8 dependency reordering** (the Humility + Opalescence pretzel). This increment does
  layer + sublayer + **timestamp** ordering (613.7), correct for the vast majority; selectors
  are evaluated against base characteristics, so a dependency where one effect changes what
  another applies to is not yet reordered. Next layer-system step.
- Copy (layer 1), control (2), text (3), color (5) effects; P/T switch (7e).

### Policy exclusion list (never modeled — as in every production engine)

Subgames (Shahrazad), controlling another player's turn (Mindslaver), physical dexterity
(Chaos Orb, Falling Star), ante, and cards that restart the game. Real randomness that is
seedable (coin flips, dice) is **not** excluded — it goes through the game PRNG.
