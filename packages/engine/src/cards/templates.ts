/**
 * Card templates — the authoring layer for the ability IR (ADR 0004).
 *
 * ## Why this exists
 *
 * A card's behavior is data, and one executor (`effects/resolve.ts::executeAbility`) runs all of
 * it. So when two creatures with similar abilities behave differently, the cause is never
 * divergent code — it is divergent *authored data*. Writing every override as a hand-typed object
 * literal guaranteed that divergence: the same "when this enters, create a token" shape was typed
 * out ~100 times, each time with a chance to spell a token, a selector, or a target slot slightly
 * differently, and each override file grew its own private copies of the same tiny helpers.
 *
 * These builders make the common shapes *the same by construction*. They are thin — each returns
 * exactly the IR the hand-written literal did, with no runtime behavior of its own — so adopting
 * them changes how a card is written, never what it does.
 *
 * ## Rules
 *
 * 1. **Compose existing primitives only.** A template may not introduce a new `Effect` op or need
 *    a new executor case; that belongs in the engine (`overrides/index.ts` rule 1). A template is
 *    a shorthand for IR that already works.
 * 2. **Never widen a shape to fit a second card.** If a card almost fits a template but needs one
 *    field different, add a parameter only if that parameter is meaningful for every caller;
 *    otherwise write the ability out with `triggered`/`activated` and the specific effects.
 * 3. **Optional fields stay absent when not passed.** `applyOverride` merges with a shallow spread,
 *    where a key present with value `undefined` still overwrites the interpreted value while an
 *    absent key preserves it. Builders here never emit a key the caller did not ask for.
 *
 * ## What to reach for
 *
 * - costs: `mana`, `TAP`, `SAC_SELF`, `payLife`, `payEnergy`, `loyalty`, `sacOther`
 * - trigger heads: `onEtb`, `onDies`, `onAttacks`, `whenEnters`, `onUpkeep`, `onCast`, …
 * - abilities: `spell`, `triggered`, `activated`
 * - registration: `defineCard`, `unimplemented`
 * - statics: `lord`, `auraBuff`, `costReductionFor`
 * - tokens: `./tokens`
 */

import type { Color } from '@mtg/shared';
import type { ParsedManaCost } from '../mana/cost';
import { parseManaCost } from '../mana/cost';
import type {
  Ability,
  AbilityCost,
  ActivatedAbility,
  Effect,
  KeywordAbility,
  ManaAbilitySpec,
  TargetSpec,
  TriggerHead,
  TriggerSpec,
} from './ability';
import type { Condition } from './condition';
import type { CardDefinition } from './definition';
import type { StaticEffect } from './continuous-types';
import type { RuleStatic } from './rule-statics';
import type { Selector } from './selector';
import type { Value } from './value';

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/**
 * A mana cost component: `mana('{4}{R}')`.
 *
 * Throws on a cost the parser cannot read rather than asserting non-null. Every override file
 * previously wrote `parseManaCost(s).cost!`, which turns an unsupported symbol into a `null` cost
 * silently accepted by the payment solver — the engine halts loudly on unmodeled cards everywhere
 * else, and an authored cost should be no different.
 */
export function mana(cost: string): AbilityCost {
  const parsed = parseManaCost(cost as Parameters<typeof parseManaCost>[0]);
  if (parsed.cost === null) {
    throw new Error(`templates.mana: unparseable mana cost ${cost}`);
  }
  return { kind: 'mana', cost: parsed.cost };
}

/** The parsed cost itself, for the fields that take a `ParsedManaCost` rather than an `AbilityCost`. */
export function manaCost(cost: string): ParsedManaCost {
  const component = mana(cost);
  return (component as { kind: 'mana'; cost: ParsedManaCost }).cost;
}

export const TAP: AbilityCost = { kind: 'tap' };
export const SAC_SELF: AbilityCost = { kind: 'sacrificeSelf' };
export const EXILE_SELF: AbilityCost = { kind: 'exileSelf' };
export const DISCARD_SELF: AbilityCost = { kind: 'discardSelf' };
export const DISCARD_HAND: AbilityCost = { kind: 'discardHand' };
export const UNATTACH_SELF: AbilityCost = { kind: 'unattachSelf' };
export const EXILE_SELF_FROM_GRAVEYARD: AbilityCost = { kind: 'exileSelfFromGraveyard' };

export function payLife(amount: number): AbilityCost {
  return { kind: 'payLife', amount };
}

export function payEnergy(amount: number): AbilityCost {
  return { kind: 'payEnergy', amount };
}

/** A planeswalker loyalty cost; `delta` is negative for a minus ability. */
export function loyalty(delta: number): AbilityCost {
  return { kind: 'loyalty', delta };
}

export function removeCountersCost(counter: string, count: Value | number): AbilityCost {
  return { kind: 'removeCounters', counter, count };
}

export function sacOther(selector: Selector, count?: number): AbilityCost {
  return count === undefined
    ? { kind: 'sacrificeOther', selector }
    : { kind: 'sacrificeOther', selector, count };
}

export function tapOther(selector: Selector): AbilityCost {
  return { kind: 'tapOther', selector };
}

// ---------------------------------------------------------------------------
// Trigger heads
// ---------------------------------------------------------------------------

/** "When this enters" — the single most common trigger in the card pool. */
export function onEtb(): TriggerHead {
  return { when: 'enters', subject: { kind: 'self' } };
}

/** "When this dies". */
export function onDies(): TriggerHead {
  return { when: 'dies', subject: { kind: 'self' } };
}

/** "Whenever this attacks". */
export function onAttacks(): TriggerHead {
  return { when: 'attacks', subject: { kind: 'self' } };
}

/** "Whenever this blocks". */
export function onBlocks(): TriggerHead {
  return { when: 'blocks', subject: { kind: 'self' } };
}

/** "Whenever this deals combat damage to a player". */
export function onCombatDamageToPlayer(): TriggerHead {
  return { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } };
}

/** "Whenever this becomes tapped". */
export function onBecomesTapped(): TriggerHead {
  return { when: 'becomesTapped', subject: { kind: 'self' } };
}

/** "Whenever this becomes the target of a spell or ability an opponent controls" (CR: opponent-only). */
export function onBecomesTargeted(): TriggerHead {
  return { when: 'becomesTargeted', subject: { kind: 'self' } };
}

/** "Whenever this is dealt damage". */
export function onDealtDamage(): TriggerHead {
  return { when: 'dealtDamage', subject: { kind: 'self' } };
}

/** "Whenever this fights". */
export function onFights(): TriggerHead {
  return { when: 'fights', subject: { kind: 'self' } };
}

/**
 * The same object events, watched on *other* permanents — "whenever a Dragon you control enters".
 *
 * `aggregate` implements CR 603.2c: "whenever one or more X attack, draw that many" is ONE trigger
 * carrying a count, not one per object. Getting this wrong makes a three-attacker trigger fire
 * three times and draw three each time.
 */
export function whenPermanent(
  when: 'enters' | 'dies' | 'attacks' | 'blocks' | 'dealsCombatDamageToPlayer' | 'becomesTapped' | 'dealtDamage',
  selector: Selector,
  opts?: { aggregate?: boolean | 'byEventPlayer' },
): TriggerHead {
  const head = { when, subject: { kind: 'permanent' as const, selector } };
  return opts?.aggregate === undefined ? head : { ...head, aggregate: opts.aggregate };
}

export function whenEnters(selector: Selector, opts?: { aggregate?: boolean | 'byEventPlayer' }): TriggerHead {
  return whenPermanent('enters', selector, opts);
}

export function whenDies(selector: Selector, opts?: { aggregate?: boolean | 'byEventPlayer' }): TriggerHead {
  return whenPermanent('dies', selector, opts);
}

export function whenAttacks(selector: Selector, opts?: { aggregate?: boolean | 'byEventPlayer' }): TriggerHead {
  return whenPermanent('attacks', selector, opts);
}

/** "Whenever you/an opponent casts a `<filter>` spell". */
export function onCast(caster: 'you' | 'opponent' | 'each', filter?: Selector): TriggerHead {
  return filter === undefined ? { when: 'castsSpell', caster } : { when: 'castsSpell', caster, filter };
}

/** "At the beginning of your/each upkeep". */
export function onUpkeep(player: 'you' | 'each' = 'you'): TriggerHead {
  return { when: 'upkeep', player };
}

/** "At the beginning of your/each end step". */
export function onEndStep(player: 'you' | 'each' = 'you'): TriggerHead {
  return { when: 'endStep', player };
}

export function onUntapStep(player: 'you' | 'each' = 'you'): TriggerHead {
  return { when: 'untapStep', player };
}

export function onDrawStep(player: 'you' | 'each' = 'you'): TriggerHead {
  return { when: 'drawStep', player };
}

/** "At the beginning of combat on your/each turn". */
export function onBeginCombat(player: 'you' | 'each' = 'you'): TriggerHead {
  return { when: 'beginningOfCombat', player };
}

/** "At the beginning of each of your main phases" — fires at BOTH main phases. */
export function onMainPhase(player: 'you' | 'each' = 'you'): TriggerHead {
  return { when: 'mainPhase', player };
}

/** "Whenever you gain life". */
export function onGainsLife(player: 'you' | 'each' = 'you'): TriggerHead {
  return { when: 'gainsLife', player };
}

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

/**
 * Target slots.
 *
 * Slot position IS the index every `EffectRef` number points at, and a mismatch fails *silently*:
 * `resolve.ts`'s `ref()` returns null for a missing or wrong-kind slot and the effect is skipped
 * with no error. Two conventions this enforces so callers do not have to remember them:
 *
 * - variable-count slots (`count`) are allocated AFTER every ordinary slot, because `targets` must
 *   stay dense over exactly the ordinary slots;
 * - the returned object hands back the indexes by name, so effects reference `slots.creature`
 *   rather than a bare `0` that silently shifts when a slot is inserted ahead of it.
 */
export function targetSlots<K extends string>(spec: Record<K, TargetSpec>): {
  targets: TargetSpec[];
  slot: Record<K, number>;
} {
  const entries = Object.entries(spec) as [K, TargetSpec][];
  const ordinary = entries.filter(([, t]) => t.count === undefined);
  const counted = entries.filter(([, t]) => t.count !== undefined);
  const ordered = [...ordinary, ...counted];
  const slot = {} as Record<K, number>;
  ordered.forEach(([key], index) => {
    slot[key] = index;
  });
  return { targets: ordered.map(([, t]) => t), slot };
}

interface AbilityBody {
  effects: Effect[];
  targets?: TargetSpec[];
  description?: string;
  optional?: boolean;
}

function buildAbility(kind: Ability['kind'], body: AbilityBody, trigger?: TriggerSpec): Ability {
  const ability: Ability = {
    kind,
    ...(trigger === undefined ? {} : { trigger }),
    targets: body.targets ?? [],
    effects: body.effects,
  };
  if (body.optional !== undefined) ability.optional = body.optional;
  if (body.description !== undefined) ability.description = body.description;
  return ability;
}

/** An instant's or sorcery's ability — what `CardDefinition.spellAbility` holds. */
export function spell(body: AbilityBody): Ability {
  return buildAbility('spell', body);
}

/**
 * A triggered ability. `condition` is the CR 603.4 intervening-if clause, checked both when the
 * ability would trigger and again as it resolves — not a targeting restriction.
 */
export function triggered(head: TriggerHead, body: AbilityBody & { condition?: Condition }): Ability {
  const trigger: TriggerSpec =
    body.condition === undefined ? head : ({ ...head, condition: body.condition } as TriggerSpec);
  return buildAbility('triggered', body, trigger);
}

/**
 * An activated ability — the whole `ActivatedAbility` wrapper, not just its inner `Ability`.
 *
 * `timing` defaults to `'any'`; pass `'sorcery'` for "activate only as a sorcery" (CR 602.5d).
 */
export function activated(
  spec: AbilityBody & {
    costs: AbilityCost[];
    timing?: 'any' | 'sorcery';
    oncePerTurn?: boolean;
    zone?: 'hand' | 'battlefield' | 'graveyard';
    requiresAttackedThisTurn?: true;
  },
): ActivatedAbility {
  const out: ActivatedAbility = {
    costs: spec.costs,
    timing: spec.timing ?? 'any',
    ability: buildAbility('activated', spec),
  };
  if (spec.oncePerTurn !== undefined) out.oncePerTurn = spec.oncePerTurn;
  if (spec.zone !== undefined) out.zone = spec.zone;
  if (spec.requiresAttackedThisTurn !== undefined) out.requiresAttackedThisTurn = spec.requiresAttackedThisTurn;
  return out;
}

/** A planeswalker loyalty ability — an activated ability at sorcery speed with a loyalty cost. */
export function loyaltyAbility(delta: number, body: AbilityBody): ActivatedAbility {
  return activated({ ...body, costs: [loyalty(delta)], timing: 'sorcery' });
}

// ---------------------------------------------------------------------------
// Static and rule-modifying abilities
// ---------------------------------------------------------------------------

/** "Other creatures you control get +1/+1" and friends — a layer 7d P/T modification. */
export function lord(affects: Selector, power: number | Value, toughness: number | Value): StaticEffect {
  return { affects, op: { layer: 7, sublayer: 'd', power, toughness } };
}

/** "Creatures you control have flying" — a layer 6 keyword grant. */
export function grantsKeyword(affects: Selector, keyword: KeywordAbility): StaticEffect {
  return { affects, op: { layer: 6, addKeyword: keyword } };
}

/** The permanent an Aura or Equipment is attached to. */
export const ATTACHED: Selector = { kind: 'attachedToSource' };

/**
 * "Enchanted creature gets +N/+N and has `<keywords>`" — the Aura shape, as one call.
 *
 * Emits the P/T modification first and then one static per keyword, which is the order the
 * hand-written Auras used; layer order is decided by the layer engine, not by this array.
 */
export function auraBuff(power: number, toughness: number, keywords: KeywordAbility[] = []): StaticEffect[] {
  return [
    lord(ATTACHED, power, toughness),
    ...keywords.map((keyword) => grantsKeyword(ATTACHED, keyword)),
  ];
}

/** "`<filter>` spells you cast cost {N} less to cast" (CR 601.2f) — a rule static, not a layer effect. */
export function costReductionFor(filter: Selector, amount: number | Value): RuleStatic {
  return {
    kind: 'costReduction',
    amount: typeof amount === 'number' ? { kind: 'const', n: amount } : amount,
    filter,
  };
}

/** A mana ability. `costs` defaults to `{T}`, the cost every printed mana ability has unless stated. */
export function manaAbility(units: (Color | 'C')[][], opts?: { costs?: AbilityCost[] }): ManaAbilitySpec {
  return { units, costs: opts?.costs ?? [TAP] };
}

// Registration (`defineCard` / `unimplemented`) lives in `./overrides/index`, with the registry it
// writes to. Keeping it there rather than here is deliberate: this module is imported BY every
// override file, so importing the registry back into it would form a cycle that only survives on
// function hoisting.
