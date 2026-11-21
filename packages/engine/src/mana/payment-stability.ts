import type { Condition } from '../cards/condition';
import type { Selector } from '../cards/selector';
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

export function stableSelector(selector: Selector): boolean {
  if (selector.kind === 'allOf' || selector.kind === 'anyOf')
    return selector.of.every(stableSelector);
  if (selector.kind === 'not') return stableSelector(selector.of);
  return STABLE_SELECTOR_KINDS.has(selector.kind);
}

/**
 * Selector kinds whose match can only stop holding for a permanent as other permanents leave the
 * battlefield, given `leavingPermanentsKeepProduction` with power counted (no ending effect strips
 * a type, color or keyword back, or leaves a power or toughness higher). A type, a keyword or a
 * power floor can only be lost when a granting effect or a pump ends. `powerAtMost`, a monocolor
 * test and any negation can start to match as a pump or an added color ends, so they are left out
 * (found by Codex review: a 1/1 under a sacrificed +1/+1 anthem starts matching `powerAtMost(1)`).
 */
const FALLING_SELECTOR_KINDS: ReadonlySet<Selector['kind']> = new Set<Selector['kind']>([
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
  'toughnessAtLeast',
  'basePowerToughness',
  'manaValueAtMost',
  'manaValueAtLeast',
  'manaCostIs',
  'hasKeyword',
  'isToken',
  'isCommander',
  'owner',
]);

/** Whether `selector`'s matches can only shrink as permanents leave (see `FALLING_SELECTOR_KINDS`). */
export function selectorOnlyFallsAsPermanentsLeave(selector: Selector): boolean {
  if (selector.kind === 'allOf' || selector.kind === 'anyOf')
    return selector.of.every(selectorOnlyFallsAsPermanentsLeave);
  return FALLING_SELECTOR_KINDS.has(selector.kind);
}

/**
 * True when a board count stays what it is now through a payment in which no permanent leaves:
 * a count of permanents over a stable selector, which a tap, a mana payment or a life rider cannot
 * change. The caller must know that nothing in the payment sacrifices.
 */
export function countFixedWhileNothingLeaves(condition: Condition): boolean {
  return condition.kind === 'countPermanents' && stableSelector(condition.selector);
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
 * Condition kinds a payment cannot change: a board count (its selector is checked on its own), the
 * turn and step, a permanent's own entry, cast and kicker history, a choice already made, the
 * monarch, the number of opponents. "Has hexproof as long as it entered this turn" (Zurgo and
 * Ojutai) broke the premise for every payment at the table and halted fuzz-26 and fuzz-169.
 * Combinators pass through, and each child is checked. Counts of what happened this turn are not
 * here: the payment belongs to a cast that may itself be counted.
 */
const PAYMENT_FIXED_CONDITION_KINDS: ReadonlySet<string> = new Set([
  'countPermanents',
  'allOf',
  'anyOf',
  'not',
  'enteredThisTurn',
  'yourTurn',
  'notYourTurn',
  'duringStep',
  'duringYourMainPhase',
  'beforeAttackersDeclared',
  'castDuringYourMainPhase',
  'wasKicked',
  'sourceWasCast',
  'escaped',
  'giftPromised',
  'chosenOptionIs',
  'opponentIsMonarch',
  'opponentCount',
  // Also fixed by a payment's own activations (a tap, a mana, life or energy payment, a life or
  // damage rider: none adds, removes or changes a permanent): whether its controller controls
  // their own commander; a comparison of constants and devotion, which reads the mana costs of
  // the controller's permanents (CR 700.5, "isn't a creature unless your devotion to red and
  // green is 7 or more", Purphoros-style gods). A comparison of any other value is still caught
  // by its operands (`lifeTotal`, `countTappedPermanents`, `energyAvailable` ... are in
  // `PAYMENT_STATE_KINDS`; an unlisted operand kind is not in this set). A permanent leaving can
  // change these: `leavingKeepsProduction` lets through only the conditions that can only stop
  // holding (`conditionOnlyEnds`).
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
    !PAYMENT_FIXED_CONDITION_KINDS.has(String(record['kind']))
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
  // Damage modifiers change only how much damage is dealt. No source's production reads damage,
  // and ending one never raises a life total, so the life checks keep their premise too (Neriv,
  // Heart of the Storm on a Treasure board dropped the bound and halted fuzz-26).
  'damageDoubled',
  'damageDoubledToOpponents',
  // "If a source you control would deal damage to an opponent, it deals double that damage
  // instead" (Fiery Emancipation, Torbran): a replacement of how much damage is dealt, `factor`
  // (at least 2) and `plus` (at least 1) only multiply or add: authoring validation admits no other. The only damage a payment deals is a source's rider to its own
  // controller, and no mana ability, gate, selector or dynamic production reads damage dealt. Ending
  // the replacement can only make that rider hurt less, and life never rises past what it is now
  // under the premise of a payment (`lifeCanRise` is false where a bound uses life), so no
  // pay-life source or life reservation is made easier to meet than the root says.
  'damageReplacement',
  'damageHalvedToYou',
  'preventCombatDamageToSelf',
  // Neither changes a source's production when it ends: a cost the opponents pay to target
  // (Terror of the Peaks, fuzz-26), rules for cards off the battlefield or not yet drawn, how a
  // token's or another permanent's entry is replaced (no fixed-capacity activation makes one), or
  // an untap step.
  'targetLifeTax',
  'alsoTypesOffBattlefield',
  'beginOnBattlefieldFromOpeningHand',
  'createClueFoodAndTreasure',
  'effectDiscardMayGoToLibraryTop',
  'graveyardToExile',
  'lookTopLibrary',
  'revealTopLibrary',
  'otherPermanentsEnterTapped',
  'tokenCountMultiplier',
  'untapDuringOthersUntapSteps',
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

/** Condition kinds a permanent leaving can change: a board count, devotion, a commander's presence. */
const BOARD_CONDITION_KINDS: ReadonlySet<string> = new Set([
  'countPermanents',
  'compareValues',
  'enteredThisTurn',
  'controlsYourCommander',
]);

/**
 * Whether a static's condition can only stop holding as permanents leave. "You control a Dragon"
 * (`>=`), "entered this turn", "you control your commander" only turn false; a `<=` or `==` count
 * and a devotion comparison can turn true, which starts the effect: it may take an ability away or
 * give a keyword a gate reads, so its static keeps the sacrifice bounds off. A condition that reads
 * no board fact (the turn, the step, kicker, a choice already made) does not move at all. A
 * negation turns "can only stop holding" into "can only start holding", so it passes only over a
 * condition that does not move.
 */
function conditionOnlyEnds(condition: Condition | undefined): boolean {
  if (condition === undefined) return true;
  switch (condition.kind) {
    case 'allOf':
    case 'anyOf':
      return condition.of.every(conditionOnlyEnds);
    case 'not':
      return conditionNeverMoves(condition.of);
    case 'countPermanents':
      return condition.cmp === '>=';
    case 'compareValues':
      return false;
    default:
      return true;
  }
}

/** A condition no permanent leaving changes: it reads no board fact. */
function conditionNeverMoves(condition: Condition): boolean {
  if (condition.kind === 'allOf' || condition.kind === 'anyOf')
    return condition.of.every(conditionNeverMoves);
  if (condition.kind === 'not') return conditionNeverMoves(condition.of);
  return !BOARD_CONDITION_KINDS.has(condition.kind);
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
        conditionOnlyEnds((effect as { condition?: Condition }).condition),
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

/**
 * A self-sacrificing source (a Treasure: "{T}, Sacrifice this artifact: Add one mana of any
 * color") changes the board by more than a tap: it leaves the battlefield, and a card goes to its
 * owner's graveyard. Under `characteristicsFixedDuringPayment` no static reads tapped status,
 * life or any condition but a board count, so a departure can add capacity only through a static
 * that reads a count, a zone or a graveyard ("as long as you control no artifacts, lands lose all
 * abilities", "for each artifact", threshold); a gate that counts up ("activate only if you control
 * three or more artifacts", `gateCannotOpenDuringPayment`) can only close. So the capacity bound
 * may count such a source when no static in play reads any of these. Conservative: one that does
 * keeps the copying search, whichever way it would move.
 */
function readsBoardMembership(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(readsBoardMembership);
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  // Devotion (the mana costs of the permanents you control) and whether you control your
  // commander are board membership too: a departure moves them (`PAYMENT_FIXED_CONDITION_KINDS`
  // admits them only because a tap or a mana payment does not).
  if (typeof kind === 'string' && /count|zone|graveyard|devotion|commander/i.test(kind))
    return true;
  return Object.values(record).some(readsBoardMembership);
}

/** Layer-7 keys: a static that only changes power and toughness. */
const PT_ONLY_KEYS: ReadonlySet<string> = new Set(['layer', 'sublayer', 'power', 'toughness']);

function membershipStatics(
  staticEffects: readonly unknown[],
  ruleStatics: readonly unknown[],
  gated: boolean,
) {
  const matters = staticEffects.filter((effect) => {
    const op = (effect as { op?: Record<string, unknown> }).op ?? {};
    if (OPS_OUTSIDE_PAYMENT.some((key) => key in op)) return false;
    // Power and toughness reach a payment only through a gate's selector ("activate only if you
    // control a creature with power 4 or greater"); with no gate, a P/T static cannot add capacity.
    return gated || !Object.keys(op).every((key) => PT_ONLY_KEYS.has(key));
  });
  // A rule no source's production reads (an attack tax, a cost increase) cannot add capacity
  // whatever it counts: Nils, Discipline Enforcer's tax counts counters, and kept every Treasure
  // board at the table off the bound (fuzz-131).
  const rules = ruleStatics.filter(
    (rule) => !RULES_IRRELEVANT_TO_PRODUCTION.has(String((rule as { kind?: unknown }).kind)),
  );
  return !readsBoardMembership(matters) && !readsBoardMembership(rules);
}

const departureSafeByDefinition = new WeakMap<object, boolean>();

const departureSafeGated = new WeakMap<object, boolean>();

/**
 * `gated`: some mana ability of the payer has an activation condition, so statics that only
 * change power and toughness count too.
 */
export function departuresCannotAddCapacity(
  definitions: readonly StaticHolder[],
  gated: boolean,
): boolean {
  const cache = gated ? departureSafeGated : departureSafeByDefinition;
  return definitions.every((definition) => {
    let answer = cache.get(definition);
    if (answer === undefined) {
      answer =
        membershipStatics(definition.staticEffects, definition.ruleStatics, gated) &&
        (definition.backFace === undefined ||
          membershipStatics(
            definition.backFace.staticEffects,
            definition.backFace.ruleStatics,
            gated,
          ));
      cache.set(definition, answer);
    }
    return answer;
  });
}
