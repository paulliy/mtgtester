# 0006 — CR 613.8 dependency ordering, and selectors over current characteristics

Date: 2026-07-24
Status: Accepted
Supersedes the "deferred" note on dependency reordering in [ADR 0005](./0005-continuous-effects-layers.md).

## Context

ADR 0005 built the layer engine and ordered effects within a layer by timestamp alone
(CR 613.7). It recorded two limitations that turn out to be the same limitation:

1. **Selectors read printed characteristics.** `Selector` was evaluated against the candidate's
   `CardDefinition`, so no continuous effect could see what an earlier layer had done.
2. **No CR 613.8 dependency reordering.**

(2) was unreachable _because_ of (1): dependency only exists when one effect can change
another's existence, affected set, or magnitude — and with selectors frozen on printed values,
none of those could ever change. The engine was ordering effects that could not interact.

The cost of leaving this is not exotic. Blood Moon plus Urborg, Tomb of Yawgmoth is a common
interaction with a published ruling, and timestamp-only ordering gets it wrong roughly half
the time — silently, with no halt, because every card involved is "modeled".

## Decision

### 1. One layered pass over the whole battlefield

`computeCharacteristics(ctx, perm)` used to gather the effects applying to a single permanent.
It now runs the layers over a working copy of _every_ permanent's characteristics and reads the
answer out at the end. A selector is evaluated against those working values, so layer 4's
output is what layer 4's next effect (and every later layer) sees.

`Characteristics` gained `supertypes` (a selector needs "nonbasic" from live state), and
`manaOverride` became a list of mana abilities rather than one, since a land can end up with
more than one basic land type.

**Performance.** This makes a single query cost O(battlefield) instead of O(1), and the query
functions (`effectivePT`, `hasKeyword`, `isCreaturePermanent`) run in combat and legality
loops. Measured on the full-game tests, the naive version was a ~3× slowdown and blew the
5s test timeout. So `computeCharacteristics` keeps a fast path: **if no permanent in play has a
static ability, only until-end-of-turn effects exist, each pinned to one object — no permanent
can influence another's characteristics, and only the queried permanent is computed.** The
whole-battlefield pass, and with it all dependency analysis, engages exactly when something in
play could make it matter. Suite runtime is back to its pre-change 4s.

> **Superseded by [ADR 0007](./0007-characteristics-single-source-of-truth.md).** This fast path
> protected the test suite, not real decks: it switches off the moment any anthem, lord, or
> Blood Moon is on the board. Measured, a four-static board cost 17× the fast path. ADR 0007
> replaces it with a digest-keyed cache and removes the fast path entirely.

### 2. Dependency detected empirically, not by static analysis

CR 613.8a asks whether applying Y first would change X's existence, what X applies to, or what
X does to those objects. Rather than maintain a table of which op kinds can affect which
selector kinds — which would silently rot as ops and selectors are added — the engine
**answers that question by trying it**: fingerprint X, apply Y to a throwaway copy of the
working state, fingerprint X again, and compare. The fingerprint is exactly the three things
613.8a names (existence, affected card ids, `Value`-resolved parameters).

This is quadratic in the number of effects _within one layer_, with a clone per probe. That is
affordable because the counts are tiny (a layer with two static effects in it is already
unusual) and because the fast path above skips it entirely when nothing static is in play.

Then CR 613.8b: repeatedly apply the earliest-timestamped effect that depends on nothing still
unapplied, recomputing after each application. CR 613.8c: if everything remaining depends on
something else — a loop — apply the remainder in plain timestamp order.

The 613.8a clause about characteristic-defining abilities ("neither or both") is satisfied for
free: CDAs occupy sublayer 7a alone, and dependency is only ever computed between effects in
the same layer/sublayer.

### 3. Ability removal is what makes dependency real (CR 305.7)

A static ability stops contributing the moment its source loses the abilities generated from
its rules text. Setting a land's subtype does exactly that: under Blood Moon, Urborg is a
Mountain whose text box is gone. So Urborg's effect _depends_ on Blood Moon's, Blood Moon's
does not depend on Urborg's, and Blood Moon applies first regardless of who arrived first —
which is the published ruling, and now the engine's behavior in both entry orders.

Layer 4 also gained `addSubtypes` ("a Swamp **in addition to** its other types"), which does
not remove abilities, and a land's mana abilities are recomputed from its _current_ basic land
types.

## Consequences

Three new tests, two of which are built to fail under timestamp-only ordering — verified by
temporarily disabling 613.8 and watching them produce the specific wrong answers
(`['Forest','Swamp']` instead of `['Forest']`; no Mountain on an animated artifact):

- **Blood Moon vs. Urborg**, asserted in _both_ entry orders — dependency makes the result
  order-independent.
- **An effect that widens another's affected set applies first**: "each artifact is a land in
  addition to its other types" enters _after_ Blood Moon, and Blood Moon still catches the
  artifact, because Blood Moon depends on it.
- **A dependency loop** (two nonbasic lands each reading "nonbasic lands are …", each deleting
  the other's text) falls back to timestamp order per 613.8c, and reversing entry order
  reverses the winner. It does not hang or throw.

129 tests pass; the determinism test (same seed + same decisions ⇒ byte-identical event logs)
still holds, so this changed no behavior for the existing card pool.

### Deliberately not done

- **Urborg and Yavimaya are not parsed by the interpreter**, though the layer engine handles
  their effect correctly. A land with two basic land types has two mana abilities, and asking
  a player to choose between mana abilities is not modeled. Rather than ship a card that is
  marked "modeled" and then halts the moment anyone taps a land, the interpreter leaves them
  unmodeled and the behavior is proven by hand-written definitions in tests. A test asserts
  the halt is loud (`UnmodeledCardError`) rather than a silent guess. **Choosing among mana
  abilities is the prerequisite; these cards land with it.**
- **Layers 1 (copy), 2 (control), 3 (text), 5 (color), and 7e (P/T switch)** remain unbuilt, as
  in ADR 0005. Layer 1 is the notable one: base P/T is read from the permanent specifically so
  a copy effect can set it there.
- **Layer 6 removal** ("loses all abilities" as its own effect, à la Humility) — only layer-4
  ability removal via CR 305.7 exists today. Humility + Opalescence needs that plus layer-7b
  `Value`-from-mana-value; it is the natural next stress case now that the ordering machinery
  is in place.
