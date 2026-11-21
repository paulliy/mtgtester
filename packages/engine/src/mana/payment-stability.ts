import type { Condition } from '../cards/condition';
import type { Selector } from '../cards/selector';
import type { Value } from '../cards/value';
import { selectedPermanentDefinition } from '../cards/spell-faces';
import type { GameContext } from '../state/types';

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

/** Like `stableSelector`, but with no negation: a negated count can rise as permanents leave. */
function positiveStableSelector(selector: Selector): boolean {
  if (selector.kind === 'allOf' || selector.kind === 'anyOf')
    return selector.of.every(positiveStableSelector);
  return selector.kind !== 'not' && STABLE_SELECTOR_KINDS.has(selector.kind);
}

/** Whether a selector reads power or toughness, which a permanent leaving may change. */
export function selectorReadsPowerOrToughness(selector: Selector): boolean {
  if (selector.kind === 'allOf' || selector.kind === 'anyOf')
    return selector.of.some(selectorReadsPowerOrToughness);
  if (selector.kind === 'not') return selectorReadsPowerOrToughness(selector.of);
  return (
    selector.kind === 'powerAtLeast' ||
    selector.kind === 'powerAtMost' ||
    selector.kind === 'toughnessAtLeast' ||
    selector.kind === 'basePowerToughness'
  );
}

/**
 * True when a counted mana amount ("add X mana, where X is the number of other creatures you
 * control", Brigid) can only fall during a payment whose activations tap permanents, pay mana, pay
 * life or energy, sacrifice and gain life or deal damage to their controller, so that the amount
 * resolved now is the most the source can make: a payment adds no permanent, and with
 * `characteristicsFixedDuringPayment` and `leavingPermanentsKeepProduction` holding no permanent
 * that stays starts to match a negation-free stable selector. Any other value (a life total, a
 * count of cards, a product) is not proven here.
 */
export function amountCannotRiseDuringPayment(amount: Value): boolean {
  return amount.kind === 'countPermanents' && positiveStableSelector(amount.selector);
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
 * Condition and value kinds, under a static's condition, that a payment's own activations never
 * change: a board count; whether this permanent entered this turn (the turn and the permanent's
 * entry turn are fixed); whether its controller controls their own commander (a fact about which
 * permanents are on the battlefield: only a sacrifice can change it, from true to false); and a
 * comparison of constants and devotion, which reads the mana costs of the controller's permanents
 * (CR 700.5). A tap, a mana payment, a life or energy payment and a life or damage rider change
 * none of these. A permanent leaving can: `leavingKeepsProduction` handles that, and lets only the
 * kinds that can only stop holding through (`conditionOnlyEnds`).
 */
const PAYMENT_INERT_CONDITION_KINDS: ReadonlySet<string> = new Set([
  'countPermanents',
  'enteredThisTurn',
  'controlsYourCommander',
  'compareValues',
  'devotionTo',
  'const',
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
  if (
    underCondition &&
    record['kind'] !== undefined &&
    !PAYMENT_INERT_CONDITION_KINDS.has(String(record['kind']))
  )
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

/**
 * Every definition whose statics are in play. The capacity bound and the copy-free search rest
 * on activations leaving every characteristic as it is; a static that reads tapped status or life
 * breaks that ("while this is untapped, lands you control lose all abilities": tapping it gives the
 * lands their mana abilities back), and then the search copies the game with no bound at all.
 */
export function definitionsInPlay(ctx: GameContext) {
  return ctx.state.battlefield.flatMap((permanent) => {
    if (permanent.faceDown) return [];
    const printed = ctx.defs.get(permanent.oracleId);
    if (printed === undefined) return [];
    return [printed, selectedPermanentDefinition(printed, permanent.face, permanent.unlockedDoors)];
  });
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
  // "Can't be the target of abilities your opponents control" (Shanna) restricts targeting by
  // opponents' abilities on its own holder. A payment targets nothing, so ending it gives no
  // source anything back.
  'cantBeTargetedByOpponentAbilities',
  'cantBlockAlone',
  'cantBlockCreatures',
  'cantBlockMatching',
  'cantCastSpells',
  'castAsThoughFlash',
  'castFromZone',
  'convoke',
  'costReduction',
  // "If a card would be put into a graveyard from anywhere, exile it instead" (Rest in Peace) and
  // "you may put a discarded card on top of your library" (Library of Leng) only redirect where a
  // card goes. A payment moves a card to a graveyard only by sacrificing it; no mana ability, gate
  // (a battlefield count), selector or dynamic production reads a graveyard (the one reading
  // exile, Chrome Mox, reads the cards exiled with itself), so ending either gives nothing back.
  'graveyardToExile',
  'effectDiscardMayGoToLibraryTop',
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
  // "Spells your opponents cast that target this creature cost an additional 3 life" (Terror of
  // the Peaks) is owed by a spell that targets it: the life is part of the spell's cost, fixed
  // before the mana is paid (`lifeReserved`), and the tax says nothing about a source. Ending it
  // only lowers what is owed, so it gives no source anything back.
  'targetLifeTax',
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

/**
 * Whether a static's condition, once it stops holding, is the only change a permanent leaving can
 * make to it: "you control a Dragon" (`>=`), "entered this turn", "you control your commander"
 * only turn false as permanents leave. A `<=` or `==` count and a devotion comparison can turn
 * true, which starts the effect: it may take an ability away or give a keyword a gate reads, so
 * its static keeps the sacrifice bounds off.
 */
function conditionOnlyEnds(condition: unknown): boolean {
  if (condition === undefined) return true;
  const { kind, cmp } = condition as { kind?: string; cmp?: string };
  return (
    kind === 'enteredThisTurn' ||
    kind === 'controlsYourCommander' ||
    (kind === 'countPermanents' && cmp === '>=')
  );
}

function leavingKeepsProduction(
  staticEffects: readonly unknown[],
  ruleStatics: readonly unknown[],
): LeavingAnswer {
  const ops = staticEffects.map((effect) => (effect as { op?: Record<string, unknown> }).op ?? {});
  return {
    general:
      ops.every((op) => !endingCanRaise(op)) &&
      staticEffects.every((effect) =>
        conditionOnlyEnds((effect as { condition?: unknown }).condition),
      ) &&
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
