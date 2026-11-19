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

/** Layer-4 keys that replace or strip what a permanent is, so that ending them can give it back. */
const TYPE_STRIPPING_KEYS = [
  'setLandSubtype',
  'setTypes',
  'setSubtypes',
  'removeCreatureType',
  'setSupertypes',
  'loseAbilities',
];

/** Ops, in any layer, whose end can restore a mana ability, a color, a keyword or a gate. */
const STRIPPING_OPS = ['setColors', 'denyKeywords', 'removeKeywords', 'loseAllAbilities'];

/**
 * Rule statics that say nothing about mana abilities, activation, sacrifice candidates, life or
 * what a source produces, so that one leaving the battlefield cannot raise what a payment can
 * make. Anything not listed (`cantActivateAbilities`, life and damage replacements, a ruling on
 * which type a source produces) is treated as one that could.
 */
const RULES_IRRELEVANT_TO_PRODUCTION: ReadonlySet<string> = new Set([
  'attackOnlyNearestOpponent',
  'attackRequirement',
  'attackRestriction',
  'attackTax',
  'cantAttackAlone',
  'cantAttackOwner',
  'cantBeCountered',
  'cantBeSacrificed',
  'cantBeTargetedByOpponentAbilities',
  'cantBlockAlone',
  'cantBlockCreatures',
  'cantBlockMatching',
  'cantCastSpells',
  'castAsThoughFlash',
  'castFromZone',
  'convoke',
  'costReduction',
  'grantForetell',
  'improvise',
  'kicker',
  'legendRuleDoesntApply',
  // A rider adds mana (or a penalty) when a mana ability fires, so ending one can only take mana
  // away from a source that has it listed among its units now.
  'manaActivationRider',
  'minBlockers',
  'noMaximumHandSize',
  'opponentNonHandSpellCostIncrease',
  'opponentsAttackWithAll',
  'playFromZone',
  'additionalLandDrops',
  'artifactTokenCreatesThopter',
  'counterPlacementReplacement',
  'spellCastLimit',
  'spellCostIncrease',
  // A trigger waits for the stack, so doubling, adding to or suppressing one changes nothing a
  // payment reads (Harmonic Prodigy, Panharmonicon, Torbran-style riders).
  'suppressObjectTriggers',
  'triggerAdditionalForShamanOrOtherWizard',
  'triggerAdditionalOnArtifactOrCreatureEntry',
  'triggerAdditionalTime',
]);

const present = (op: Record<string, unknown>, key: string): boolean =>
  op[key] !== undefined && op[key] !== false;

/** Could ending this effect make a permanent lose less than it loses now, power aside? */
function endingCanRaise(op: Record<string, unknown>): boolean {
  if (STRIPPING_OPS.some((key) => present(op, key))) return true;
  if (op['layer'] === 4) return TYPE_STRIPPING_KEYS.some((key) => present(op, key));
  return false;
}

/**
 * Could ending this layer-7 effect leave a power or toughness higher than it is now? A pump only
 * adds, but a set value, a characteristic-defining one, or a negative or computed modifier (which
 * may change sign as the payment sacrifices) can end higher.
 */
function endingCanRaisePower(op: Record<string, unknown>): boolean {
  if (op['layer'] !== 7) return false;
  const nonNegative = (value: unknown): boolean => typeof value === 'number' && value >= 0;
  return !(op['sublayer'] === 'd' && nonNegative(op['power']) && nonNegative(op['toughness']));
}

interface LeavingAnswer {
  /** Nothing but a power or toughness effect can give anything back. */
  general: boolean;
  /** No layer-7 effect can end higher. */
  power: boolean;
}

function leavingKeepsProduction(
  staticEffects: readonly unknown[],
  ruleStatics: readonly unknown[],
): LeavingAnswer {
  const ops = staticEffects.map((effect) => (effect as { op?: Record<string, unknown> }).op ?? {});
  return {
    general:
      ops.every((op) => !endingCanRaise(op)) &&
      ruleStatics.every((rule) =>
        RULES_IRRELEVANT_TO_PRODUCTION.has(String((rule as { kind?: unknown }).kind)),
      ),
    power: ops.every((op) => !endingCanRaisePower(op)),
  };
}

const leavingByDefinition = new WeakMap<object, LeavingAnswer>();

/**
 * True when no permanent in play can, by leaving the battlefield, give another one back an ability,
 * a color, a type or a mana-affecting rule it holds back now. Sacrificing a permanent to pay for
 * mana changes the board in a way a tap or a life rider does not: every source then keeps only what
 * it makes now or less, so the capacity bound may count each source at its present units. A static
 * that suppresses (Blood Moon, "loses all abilities", a ban on activating abilities) breaks that,
 * and so does any rule static not listed as irrelevant; the caller must then search without the
 * bound. Power and toughness count only when a mana ability is gated (`powerGated`): nothing else
 * reads them. Conservative: it is a bound's premise, never a rule.
 */
export function leavingPermanentsKeepProduction(
  definitions: readonly StaticHolder[],
  powerGated: boolean,
): boolean {
  return definitions.every((definition) => {
    let answer = leavingByDefinition.get(definition);
    if (answer === undefined) {
      const front = leavingKeepsProduction(definition.staticEffects, definition.ruleStatics);
      const back =
        definition.backFace === undefined
          ? { general: true, power: true }
          : leavingKeepsProduction(
              definition.backFace.staticEffects,
              definition.backFace.ruleStatics,
            );
      answer = { general: front.general && back.general, power: front.power && back.power };
      leavingByDefinition.set(definition, answer);
    }
    return answer.general && (!powerGated || answer.power);
  });
}
