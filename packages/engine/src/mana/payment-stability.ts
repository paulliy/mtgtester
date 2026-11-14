import type { Condition } from '../cards/condition';
import type { Selector } from '../cards/selector';

/**
 * Selector kinds whose answer for one permanent depends only on that permanent's own
 * characteristics and identity, never on whether it is tapped, what is attached to it, or how
 * combat stands. While a payment taps permanents and adds mana, these answers stay fixed for every
 * permanent that stays on the battlefield (the premise `planStatefulManaPayment` already rests
 * on: a fixed-capacity activation changes no characteristic).
 */
const STABLE_SELECTOR_KINDS: ReadonlySet<Selector['kind']> = new Set<Selector['kind']>([
  'self',
  'other',
  'type',
  'subtype',
  'supertype',
  'name',
  'sameNameAsSource',
  'color',
  'chosenColor',
  'chosenType',
  'chosenSubtype',
  'controller',
  'powerAtLeast',
  'powerAtMost',
  'toughnessAtLeast',
  'basePowerToughness',
  'manaValueAtMost',
  'manaValueAtLeast',
  'manaCostIs',
  'hasKeyword',
  'isToken',
  'isCommander',
  'owner',
  'isMonocolored',
]);

function stableSelector(selector: Selector): boolean {
  if (selector.kind === 'allOf' || selector.kind === 'anyOf')
    return selector.of.every(stableSelector);
  if (selector.kind === 'not') return stableSelector(selector.of);
  return STABLE_SELECTOR_KINDS.has(selector.kind);
}

/**
 * True when an activation gate that is false now stays false through any payment whose
 * activations only tap permanents, pay mana, and gain life or deal damage to their controller
 * (the fixed-capacity shapes). Conservative: anything not proven here may become true, so the
 * capacity bound must not ignore it.
 *
 * "You control a Dragon" (`countPermanents`, `>=`) qualifies: such a payment neither adds a
 * permanent nor changes which permanents match a stable selector, so the count cannot rise. A
 * `<=` count, a count over a tapped-status selector, or any other condition kind does not.
 */
export function gateCannotOpenDuringPayment(condition: Condition): boolean {
  return (
    condition.kind === 'countPermanents' &&
    condition.cmp === '>=' &&
    stableSelector(condition.selector)
  );
}
