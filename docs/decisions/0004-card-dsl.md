# 0004 — Data-driven card DSL (ability IR)

Status: accepted (increment 1) — 2026-07-24
Context: post-Phase-2 review. The regex→`EffectSpec[]`→switch interpreter models a card's
behavior in three coupled places (a sentence regex, an `EffectSpec` variant, a `resolve`
switch case) and has no path to hand-author a card the text parser can't read. That is the
ceiling the coverage probe hit (9/18 staples). Direction chosen: a data-driven card DSL, the
way production engines (MTGA's GRE, Forge, XMage) scale to thousands of cards.

## The model

Each card's behavior is structured **data** — an `Ability` — executed by one general
interpreter. Three layers:

1. **Ability IR (`cards/ability.ts`).** The card-agnostic representation:
   - `Ability = { kind: 'spell' | 'triggered', trigger?, optional?, targets: TargetSpec[],
effects: Effect[], description? }`.
   - `Effect` — a discriminated union of atomic primitives (`pumpUntilEot`,
     `grantKeywordUntilEot`, `dealDamage`, `destroy`, `exile`, `counter`, `draw`, `gainLife`,
     `eachOpponentLosesLife`, `eachOpponentDamage`). Targeted primitives reference a **target
     slot by index** into `Ability.targets` — so target kinds are _declared_, not derived
     from the effect type.
   - `TargetSpec = { kind: 'creature' | 'anyTarget' | 'spell' }`.

2. **Parser (`cards/interpret.ts`, text → IR).** The interpreter now emits `Ability`s. A
   spell becomes one `spell` ability; each triggered line becomes a `triggered` ability.
   Slots are allocated as targeted effects are parsed. Unparseable text still →
   `modeled: false` (halt-loudly unchanged).

3. **Executor (`effects/resolve.ts::executeAbility`, IR → mutations).** One function walks an
   ability's effects and applies each primitive through the existing shared helpers
   (`dealDamageToCreature`, `drawCards`, `moveObject`, …), resolving targeted ops through
   their declared slot. Fizzle and target-legality now read `Ability.targets` directly.

## Scope of increment 1 (this commit)

IR + executor + the parser retargeted to full parity — **no behavior change**. The event log
stays byte-identical (determinism test green); the same cards model, the same halts fire.

Deliberately still specialized, not yet folded into `Ability`:

- **Mana abilities** (`ManaAbilitySpec`) — they never use the stack and feed the payment
  solver directly; a distinct representation is correct for them.
- **Activated abilities, costs beyond mana, static abilities** — future increments.

The authored-override registry (hand-written `Ability`s for cards the text parser can't read
— "add any color" mana, tutors, bounce) is **increment 2**, next.

## Consequences

Adding a mechanic becomes: one `Effect` primitive + one executor case + a parser grammar (or
an authored override) — not three coupled edits. Target kinds are declared per slot, so an
ability can express targets the fixed effect→kind mapping couldn't. `EffectSpec`/`TriggerSpec`
are replaced by `Effect`/`Ability`; `CardDefinition.spellEffects` → `spellAbility: Ability |
null`, `triggers: TriggerSpec[]` → `triggers: Ability[]`.
