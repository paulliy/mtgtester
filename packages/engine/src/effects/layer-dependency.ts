/**
 * A conservative read/write prefilter for CR 613.8 dependency ordering.
 *
 * Effect A depends on effect B only if applying B could change A's existence, what A applies to,
 * or what A does (CR 613.8a). All three are functions of a handful of characteristic kinds, so
 * when what B can write and what A can read share no kind, B cannot change A and the expensive
 * probe (a fingerprint plus a whole-board trial clone) is skipped.
 *
 * Soundness rule: a kind not classified here reads or writes `EVERYTHING`, so an unknown selector,
 * condition, value or op can only cause a probe, never skip one. `MTG_VERIFY_LAYER_DEPENDENCY=1`
 * checks the prefilter against the probe on every pair.
 */
import type { Condition } from '../cards/condition';
import type { ContinuousOp } from '../cards/continuous-types';
import type { Selector } from '../cards/selector';
import type { Value } from '../cards/value';

export const TYPES = 1;
export const SUBTYPES = 2;
export const SUPERTYPES = 4;
export const COLORS = 8;
/** Keywords and the other layer-6 grants (wards, protection, triggers, mana/activated abilities). */
export const GRANTS = 16;
/** Whether a permanent still has the abilities its rules text gives it (`chars.loseAbilities`). */
export const ABILITIES = 32;
export const POWER_TOUGHNESS = 64;
export const EVERYTHING = 127;

/** The characteristic kinds a selector reads off the object it judges. */
export function selectorReads(selector: Selector): number {
  switch (selector.kind) {
    // Judged on game state, printed data or the source, never on a layer's output.
    case 'self':
    case 'other':
    case 'attachedToSource':
    case 'name':
    case 'sameNameAsSource':
    case 'controller':
    case 'owner':
    case 'manaValueAtMost':
    case 'manaValueAtLeast':
    case 'manaCostIs':
    case 'hasAnyCounter':
    case 'hasCounter':
    case 'isToken':
    case 'enteredThisTurn':
    case 'isCommander':
    case 'isEnchanted':
    case 'enchantedByAuraYouControl':
    case 'isEquipped':
    case 'combatRole':
    case 'attackingOpponent':
    case 'attackingChosenPlayer':
      return 0;
    case 'type':
    case 'chosenType':
      return TYPES;
    case 'subtype':
    case 'chosenSubtype':
      return SUBTYPES;
    case 'supertype':
      return SUPERTYPES;
    case 'color':
    case 'chosenColor':
    case 'isMonocolored':
      return COLORS;
    case 'allOf':
    case 'anyOf':
      return selector.of.reduce((mask, of) => mask | selectorReads(of), 0);
    case 'not':
      return selectorReads(selector.of);
    default:
      // Power, toughness, keywords, tapped, combat and anything added later.
      return EVERYTHING;
  }
}

/** The kinds a `Value` reads while it is evaluated. */
export function valueReads(value: number | Value): number {
  if (typeof value === 'number') return 0;
  switch (value.kind) {
    case 'const':
      return 0;
    case 'plus':
    case 'negate':
    case 'times':
      return valueReads(value.of);
    case 'countPermanents':
      return selectorReads(value.selector);
    default:
      return EVERYTHING;
  }
}

function conditionReads(condition: Condition | undefined): number {
  if (condition === undefined) return 0;
  return condition.kind === 'countPermanents' ? selectorReads(condition.selector) : EVERYTHING;
}

/** The kinds an op can change on the objects it applies to. */
export function writesOf(op: ContinuousOp): number {
  switch (op.layer) {
    case 4:
      return TYPES | SUBTYPES | SUPERTYPES | (op.loseAbilities === true ? ABILITIES : 0);
    case 5:
      return COLORS;
    case 6:
      if ('loseAllAbilities' in op) return GRANTS | ABILITIES;
      if (
        'addKeyword' in op ||
        'denyKeywords' in op ||
        'removeKeywords' in op ||
        'addWard' in op ||
        'addProtection' in op ||
        'addTrigger' in op ||
        'addActivatedAbility' in op ||
        'addManaAbility' in op ||
        'setCantBeBlocked' in op ||
        'setMustAttackEachCombat' in op ||
        'addGoad' in op
      )
        return GRANTS;
      return EVERYTHING;
    case 7:
      return POWER_TOUGHNESS;
    default:
      return EVERYTHING;
  }
}

interface ReadableEffect {
  applies: { kind: 'fixed' } | { kind: 'selector'; selector: Selector };
  op: ContinuousOp;
  condition?: Condition | undefined;
}

/** The kinds an effect's existence, affected set and action can read. */
export function readsOf(effect: ReadableEffect): number {
  const op = effect.op;
  const opReads = op.layer === 7 ? valueReads(op.power) | valueReads(op.toughness) : 0;
  // A fixed effect (CR 611.2c) exists whatever its source does and applies to named objects.
  if (effect.applies.kind === 'fixed') return opReads;
  return (
    ABILITIES | selectorReads(effect.applies.selector) | conditionReads(effect.condition) | opReads
  );
}
