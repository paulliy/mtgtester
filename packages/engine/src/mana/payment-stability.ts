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

/**
 * Selector, condition and value kinds that read what a fixed-capacity payment changes: tapped
 * status, life (a damage rider lowers it, a life-gain rider raises it), energy, damage dealt, and
 * mana spent. "Gets -X/-X where X is your life total" (Death's Shadow) reads `lifeTotal` in a
 * value, not a condition, and a damage rider can still raise that creature's power past a gate's
 * `powerAtLeast`.
 */
const PAYMENT_STATE_KINDS: ReadonlySet<string> = new Set([
  'tapped',
  'isUntapped',
  'countTappedPermanents',
  'tappedCreaturesControlledByTarget',
  'lifeTotal',
  'opponentsLostLifeThisTurn',
  'damageDealt',
  'energyAvailable',
  'manaSpent',
  'treasureManaSpent',
]);

/**
 * Whether anything in `value` could read state that a fixed-capacity payment changes: a kind in
 * `PAYMENT_STATE_KINDS`, or any condition other than a board count (a life total, a turn fact, a
 * source's own status).
 */
function readsPaymentState(value: unknown, underCondition = false): boolean {
  if (Array.isArray(value)) return value.some((item) => readsPaymentState(item, underCondition));
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record['kind'] === 'string' && PAYMENT_STATE_KINDS.has(record['kind'])) return true;
  if (underCondition && record['kind'] !== undefined && record['kind'] !== 'countPermanents')
    return true;
  return Object.entries(record).some(([key, child]) =>
    readsPaymentState(child, key === 'condition' ? true : underCondition && key !== 'selector'),
  );
}

/**
 * The premise behind the stateful planner's capacity bound and its copy-free search: activations
 * that only tap permanents, pay mana, gain life or damage their controller change no permanent's
 * characteristics, so every source keeps its mana abilities, gates and symbols until it is tapped.
 *
 * It fails when a static ability or rule static in play reads tapped status or life ("while this
 * artifact is untapped, lands you control lose all abilities": tapping the artifact gives the lands
 * their mana abilities back), so the caller must then search on copies of the game. Conservative:
 * every condition except a board count is treated as one that could change.
 */
type StaticHolder = {
  staticEffects: readonly unknown[];
  ruleStatics: readonly unknown[];
  backFace?: { staticEffects: readonly unknown[]; ruleStatics: readonly unknown[] };
};

/** Definitions are replaced whole, never edited (`ctx.defs.set`), so one answer per object. */
const fixedByDefinition = new WeakMap<object, boolean>();

/**
 * Layer ops that never reach a mana ability, a gate's selector or a source's symbols: "has ward
 * {4} as long as it's untapped" (Iymrith) may switch with a tap and change nothing a payment reads.
 * Keyword, color, type and power changes are left out on purpose: gates and dynamic symbols read
 * them.
 */
const OPS_OUTSIDE_PAYMENT = [
  'addWard',
  'addProtection',
  'addProtectionFromChosenColor',
  'setCantBeBlocked',
  'setMustAttackEachCombat',
  'addGoad',
  'addTrigger',
];

/** Rule statics a payment reads: mana riders, activation bans, convoke and improvise. */
const RULES_IN_PAYMENT: ReadonlySet<string> = new Set([
  'manaActivationRider',
  'cantActivateAbilities',
  'convoke',
  'improvise',
]);

function staticsKeepCharacteristics(
  staticEffects: readonly unknown[],
  ruleStatics: readonly unknown[],
): boolean {
  const matters = staticEffects.filter((effect) => {
    const op = (effect as { op?: Record<string, unknown> }).op ?? {};
    return !OPS_OUTSIDE_PAYMENT.some((key) => key in op);
  });
  const rules = ruleStatics.filter((rule) =>
    RULES_IN_PAYMENT.has(String((rule as { kind?: unknown }).kind)),
  );
  return !readsPaymentState(matters) && !readsPaymentState(rules);
}

function definitionKeepsCharacteristics(definition: StaticHolder): boolean {
  let answer = fixedByDefinition.get(definition);
  if (answer === undefined) {
    answer =
      staticsKeepCharacteristics(definition.staticEffects, definition.ruleStatics) &&
      (definition.backFace === undefined ||
        staticsKeepCharacteristics(
          definition.backFace.staticEffects,
          definition.backFace.ruleStatics,
        ));
    fixedByDefinition.set(definition, answer);
  }
  return answer;
}

export function characteristicsFixedDuringPayment(definitions: readonly StaticHolder[]): boolean {
  return definitions.every(definitionKeepsCharacteristics);
}
