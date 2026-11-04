import { counterCount } from '../state/counters';
/**
 * `Value` — a number that is either constant or computed from game state (ADR 0005). This is
 * the abstraction X spells, characteristic-defining abilities (Tarmogoyf), and "equal to its
 * power" effects share.
 *
 * Evaluation is deliberately split in two, and the split is structural rather than stylistic:
 *
 * - **`evaluateValue` (here)** answers the values the LAYER ENGINE needs — layer 7a/7b P/T. It
 *   reads printed cards and graveyards only. It must never read a permanent's *current*
 *   characteristics, because the layer pass is what produces those: a Value that called back
 *   into `computeCharacteristics` would re-enter the pass that is asking it.
 * - **`effects/values.ts::evaluateValueIn`** answers everything, including selector counts and
 *   the announced X. It runs at resolution, when the layer pass has already finished, so
 *   reading current characteristics there is safe.
 *
 * `evaluateValue` therefore THROWS on a value it cannot answer rather than returning 0 — a
 * silent zero would make an X-valued effect quietly do nothing (brief §6.3).
 */

import { assertNever } from '../utils/assert-never';
import type { Color, PlayerId } from '@mtg/shared';
import type { GameContext } from '../state/types';
import type { Selector } from './selector';
import type { ObjectFacts, SourceCastState } from './source-identity';
import type { EffectRef } from './ability';
import { selectedPermanentDefinition } from './spell-faces';
import { offBattlefieldTypes } from '../state/off-battlefield-types';

/** Specialized numeric consumers must reject referents lacking a proven lifetime path. */
export function assertNumericReference(
  reference: EffectRef,
): asserts reference is number | 'source' | 'triggerObject' {
  if (typeof reference === 'number') return;
  if (typeof reference === 'object')
    throw new Error('numeric controller references have no supported lifetime contract');
  switch (reference) {
    case 'source':
    case 'triggerObject':
      return;
    case 'attachedToSource':
      throw new Error('numeric attachment references have no supported lifetime contract');
    case 'eventPlayer':
      throw new Error('numeric permanent reference cannot refer to an event player');
    default:
      assertNever(reference, 'numeric effect reference');
  }
}

/** What a resolving ability knows that the board alone does not. */
export interface ValueScope {
  giftPromised?: boolean;
  /** Whose "you" this is. */
  controllerId: PlayerId;
  /** The source object's card id, for `self`-relative selectors. */
  sourceCardId?: string;
  /** Exact source incarnation and its departure facts for CR 608.2h. */
  sourceObjectId?: string;
  sourceFacts?: ObjectFacts;
  /** A resolving spell's selected stack characteristics, including announced X. */
  resolvingSourceManaValue?: number;
  sourceCastState?: SourceCastState;
  /** The X announced when the spell was cast (CR 601.2b). */
  x?: number;
  /** Damage that caused the trigger — Old Gnawbone's "that many". */
  damageDealt?: number;
  /**
   * How many objects fired an *aggregate* trigger — the "that many" in "whenever one or more
   * Dragons you control attack, draw that many cards" (CR 603.2c). Distinct from `damageDealt`:
   * the same event can carry both a count and a total.
   */
  triggerCount?: number;
  /** Mana value of the spell that fired a `castsSpell` trigger (Lozhan). */
  spellManaValue?: number;
  /** How many colors the spell that fired a `castsSpell` trigger is (Crystal, Inhuman Princess). */
  spellColorCount?: number;
  /** Mana actually spent to cast the spell that fired a trigger (Aetherflux Conduit). */
  manaSpent?: number;
  /** Mana produced by Treasure permanents that was spent to cast the entering spell. */
  treasureManaSpent?: number;
  /** Life paid to activate the ability that fired an `activatesAbility` trigger (Verrak). */
  lifePaid?: number;
  /** Energy paid by a preceding variable-payment effect in this same resolution. */
  energyPaid?: number;
  stationPower?: number;
  /** Player involved in the firing event (for that-player-controlled targets). */
  eventPlayerId?: PlayerId;
  /**
   * `attackDeclared`: the attackers of the group that fired the trigger, by object, as declared —
   * "those creatures" (Frontier Warmonger). Remembered, not re-derived (CR 603.7c).
   */
  attackGroupIds?: readonly string[];
  /**
   * An aggregate trigger's firing group, by object, for an effect that picks one of them
   * (Twilight Diviner), with the last known facts of any that have left the battlefield.
   */
  eventGroupIds?: readonly string[];
  eventGroupFacts?: Record<string, ObjectFacts>;
  /** `blocks`: the creature this blocker blocked, by object (Wall of Tears). */
  blockedObjectId?: string;
  /** `attackDeclared` with `perDefender`: the attacked player this firing is about (Breena). */
  attackedPlayerId?: PlayerId;
  /**
   * `attackDeclared`: whether any creature of the declaring player's whole attack was attacking
   * the watcher itself (not its planeswalkers) when declared — a fact about the declaration.
   */
  attackedWatcher?: boolean;
  /** Targets resolved for this ability, indexed by slot. */
  targets?: readonly string[];
  /** Card id of the object that fired the trigger. */
  triggerObjectCardId?: string;
  /**
   * The exact permanent a delayed trigger remembers, when it must not follow the card into a
   * new object (CR 400.7): "put counters on it" after it left and returned does nothing.
   */
  triggerObjectId?: string;
  /**
   * The exact object whose event fired this trigger, captured when it fired. A delayed trigger
   * that remembers "it" (Foe-Razer Regent's "the creature that fought") takes this rather than
   * looking the card up at resolution, which would find a new object blinked in response.
   */
  eventObjectId?: string;
  /** A zone-change event may find only the new object in its first public destination. */
  eventObjectDestinationId?: string;
  /** Last known facts of that exact event incarnation, refreshed immediately before it leaves. */
  triggerObjectFacts?: ObjectFacts;
  /** Total counters on an activated ability's source, captured before costs are paid. */
  sourceCountersTotal?: number;
  /**
   * Optional costs paid for the spell now resolving (kicker). It has already left the stack, so
   * `optionalCostCount` cannot find it there (Hunting Wilds' "if this spell was kicked").
   */
  resolvingOptionalCostCounts?: Partial<
    Record<'kicker' | 'squad' | 'offspring' | 'replicate', number>
  >;
  countPermanents?: (selector: Selector, scope: 'you' | 'opponents' | 'all') => number;
}

/**
 * The numeric facts an *event* contributes to a trigger's scope, captured when it fires and
 * carried through the stack. Everything else in a `ValueScope` is re-derived at resolution;
 * these cannot be, because the event is over by then.
 */
export type TriggerScope = Pick<
  ValueScope,
  | 'damageDealt'
  | 'energyPaid'
  | 'lifePaid'
  | 'triggerCount'
  | 'spellManaValue'
  | 'spellColorCount'
  | 'manaSpent'
  | 'treasureManaSpent'
  | 'eventPlayerId'
  | 'attackGroupIds'
  | 'eventGroupIds'
  | 'eventGroupFacts'
  | 'blockedObjectId'
  | 'attackedPlayerId'
  | 'attackedWatcher'
  | 'stationPower'
  | 'sourceCountersTotal'
  | 'triggerObjectId'
  | 'eventObjectId'
  | 'eventObjectDestinationId'
  | 'triggerObjectFacts'
>;

export type Value =
  | { kind: 'const'; n: number }
  /** Number of card types among cards in all graveyards (Tarmogoyf, CR 208.2b). */
  | { kind: 'cardTypesInAllGraveyards' }
  | { kind: 'cardTypesInYourGraveyard' }
  /** "card types among cards in your opponents' graveyards" (Nighthawk Scavenger). */
  | { kind: 'cardTypesInOpponentsGraveyards' }
  /** `of` plus a constant, e.g. Tarmogoyf's toughness = types + 1. */
  | { kind: 'plus'; of: Value; n: number }
  | { kind: 'negate'; of: Value }
  /** `of` multiplied — Thrakkus's "double the power of each Dragon". */
  | { kind: 'times'; of: Value; n: number }
  /** "the number of Dragons you control" / "the number of lands you control". */
  | { kind: 'countPermanents'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /**
   * "the number of tapped creatures you control" (Harvest Season). Tapped-ness is deliberately
   * not a selector leaf (see selector.ts), so the tapped filter lives on the value, which is only
   * ever evaluated at resolution, never inside a continuous effect.
   */
  | { kind: 'countTappedPermanents'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /** Number of matching permanents controlled by an announced player target. */
  | { kind: 'countPermanentsControlledByTarget'; target: EffectRef; selector: Selector }
  /** Number of Auras you control that are currently attached to creatures. */
  | { kind: 'aurasYouControlAttachedToCreatures' }
  /** "for each Aura attached to it" (Kor Spiritdancer): every Aura on the source, any controller. */
  | { kind: 'aurasAttachedToSource' }
  /**
   * Cards matching printed characteristics in a non-battlefield zone. Unlike
   * `countPermanents`, this deliberately uses card-zone candidates: continuous effects do not
   * change cards in graveyards, hands, or libraries.
   */
  | {
      kind: 'countCardsInZone';
      zone: 'graveyard' | 'hand' | 'library';
      selector: Selector;
      owner: 'you' | 'opponents' | 'all';
    }
  /** Number of distinct colors among permanents controlled by the resolving player. */
  | { kind: 'colorsAmongPermanents' }
  /**
   * "The number of colors among permanents you control and spells you've cast this turn" (First
   * Family): one set of colors over both, the resolving spell included — it was cast this turn.
   */
  | { kind: 'colorsAmongPermanentsAndSpellsCastThisTurn' }
  /** Colored mana symbols in the mana costs of permanents controlled by the resolving player. */
  /** Devotion (CR 700.5); `and` makes it "devotion to red and green" (CR 700.5a). */
  | { kind: 'devotionTo'; color: import('@mtg/shared').Color; and?: import('@mtg/shared').Color }
  /** Number of opponents of the resolving controller. */
  | { kind: 'countOpponents' }
  /** "the greatest toughness among creatures you control" (Last March of the Ents). */
  | { kind: 'greatestToughnessAmong'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /** "the greatest power among creatures you control". */
  | { kind: 'greatestPowerAmong'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /** Greatest mana value among permanents matching a selector. */
  | { kind: 'greatestManaValueAmong'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /**
   * "the greatest mana value among noncreature permanents you control and noncreature cards in
   * your graveyard" (Dragon Man, Reformed Robot); 0 when there are none.
   */
  | { kind: 'greatestNoncreatureManaValueYouControlOrInGraveyard' }
  /** "the total power of attacking creatures" (Klauth). */
  | { kind: 'totalPowerOfAttackers' }
  | { kind: 'totalPowerAmong'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /** The X announced for this spell (CR 601.2b). */
  | { kind: 'xValue' }
  /** Number of times an optional additional cost was paid for the resolving/entering spell. */
  | { kind: 'optionalCostCount'; mechanic: 'kicker' | 'squad' | 'offspring' | 'replicate' }
  /** "that many" / "equal to that damage" — the damage that caused this trigger. */
  | { kind: 'damageDealt' }
  /** "that many" where the trigger aggregated several objects (CR 603.2c). */
  | { kind: 'triggerCount' }
  /**
   * "for each Aura you controlled that was attached to it" (Hateful Eidolon): the trigger
   * object's last-known attached Auras whose controller was this ability's controller.
   */
  | { kind: 'aurasYouControlledAttachedToTriggerObject' }
  /** "equal to that spell's mana value" — the spell that fired a `castsSpell` trigger. */
  | { kind: 'spellManaValue' }
  /** "X is the number of colors that spell is" — read from the trigger's cast event. */
  | { kind: 'spellColorCount' }
  /**
   * "The total mana value of other spells you've cast this turn" (Call Forth the Tempest): every
   * spell the controller cast this turn except the resolving one (CR 202.3).
   */
  | { kind: 'manaValueOfOtherSpellsCastThisTurn' }
  | { kind: 'manaSpent' }
  | { kind: 'treasureManaSpent' }
  | { kind: 'energyPaid' }
  | { kind: 'energyAvailable' }
  /** Power of the creature tapped to pay a Station activation cost, captured at announcement. */
  | { kind: 'stationPower' }
  | { kind: 'countersOnSelf'; counter: string }
  /** Total number of counters of every kind on the source permanent. */
  | { kind: 'allCountersOnSelf' }
  | { kind: 'countersOnTarget'; target: EffectRef; counter: string }
  /** "Where X is that artifact's mana value" (Hoard-Smelter Dragon) — the target's mana value. */
  | { kind: 'manaValueOfTarget'; target: EffectRef }
  | { kind: 'commanderCastCount'; player?: 'you' }
  /** Number of distinct colors in the controller's commanders' color identity. */
  | { kind: 'commanderIdentityColorCount' }
  | { kind: 'lifeTotal'; scope?: 'you' | 'eventPlayer' }
  | { kind: 'countOpponentsWithFewerCreatures' }
  | { kind: 'creaturesDiedThisTurn' }
  | { kind: 'powerOfSource' }
  /**
   * How many times the AFFECTED creature has attacked this turn (Moraug): a layer Value read once
   * per object the static applies to, counting declared attacks only.
   */
  | { kind: 'timesAttackedThisTurn' }
  | { kind: 'toughnessOfSource' }
  /** Current power of an announced permanent target at resolution. */
  | { kind: 'powerOfTarget'; target: EffectRef }
  | { kind: 'opponentsLostLifeThisTurn' }
  | { kind: 'powerOfTriggerObject' }
  | { kind: 'cardsInTargetHand'; target: EffectRef }
  | { kind: 'tappedCreaturesControlledByTarget'; target: EffectRef }
  | { kind: 'attackingCreatures' }
  | { kind: 'spellsCastThisTurn' }
  | { kind: 'countersOnTriggerObject'; counter: string };

export const constant = (n: number): Value => ({ kind: 'const', n });

/**
 * The card types a card can have, for graveyard-type counting (CR 205.2a). Kindred was named
 * Tribal on older cards; both count as the one type.
 */
const CARD_TYPES = [
  'Artifact',
  'Battle',
  'Creature',
  'Enchantment',
  'Instant',
  'Kindred',
  'Land',
  'Planeswalker',
  'Sorcery',
] as const;
const cardType = (type: string): string => (type === 'Tribal' ? 'Kindred' : type);

/**
 * Does evaluating this read game state outside the permanent itself? Used by the layer cache
 * to decide whether graveyard contents belong in its key (ADR 0007).
 */
export function isDynamicValue(value: Value): boolean {
  switch (value.kind) {
    case 'const':
      return false;
    case 'plus':
    case 'negate':
    case 'times':
      return isDynamicValue(value.of);
    case 'cardTypesInAllGraveyards':
    case 'cardTypesInYourGraveyard':
    case 'cardTypesInOpponentsGraveyards':
    case 'greatestNoncreatureManaValueYouControlOrInGraveyard':
    case 'countPermanents':
    case 'countTappedPermanents':
    case 'countPermanentsControlledByTarget':
    case 'aurasYouControlAttachedToCreatures':
    case 'aurasAttachedToSource':
    case 'countCardsInZone':
    case 'colorsAmongPermanents':
    case 'colorsAmongPermanentsAndSpellsCastThisTurn':
    case 'devotionTo':
    case 'countOpponents':
    case 'greatestToughnessAmong':
    case 'greatestPowerAmong':
    case 'greatestManaValueAmong':
    case 'totalPowerOfAttackers':
    case 'totalPowerAmong':
    case 'xValue':
    case 'optionalCostCount':
    case 'damageDealt':
    case 'triggerCount':
    case 'aurasYouControlledAttachedToTriggerObject':
    case 'spellManaValue':
    case 'spellColorCount':
    case 'manaSpent':
    case 'treasureManaSpent':
    case 'energyPaid':
    case 'energyAvailable':
    case 'stationPower':
    case 'countersOnSelf':
    case 'allCountersOnSelf':
    case 'countersOnTarget':
    case 'manaValueOfTarget':
    case 'commanderCastCount':
    case 'commanderIdentityColorCount':
    case 'lifeTotal':
    case 'countOpponentsWithFewerCreatures':
    case 'creaturesDiedThisTurn':
    case 'timesAttackedThisTurn':
    case 'powerOfSource':
    case 'toughnessOfSource':
    case 'powerOfTarget':
    case 'opponentsLostLifeThisTurn':
    case 'powerOfTriggerObject':
    case 'cardsInTargetHand':
    case 'tappedCreaturesControlledByTarget':
    case 'attackingCreatures':
    case 'spellsCastThisTurn':
    case 'manaValueOfOtherSpellsCastThisTurn':
    case 'countersOnTriggerObject':
      return true;
    default:
      return assertNever(value, 'isDynamicValue');
  }
}

/**
 * True when the layer engine (`evaluateValue`) can answer this value from the board and the
 * static's controller. A static ability whose value it cannot answer would throw as layers are
 * applied, so the grammar refuses such a static rather than reporting it modeled.
 */
export function layerEvaluable(value: Value): boolean {
  switch (value.kind) {
    case 'plus':
    case 'negate':
    case 'times':
      return layerEvaluable(value.of);
    case 'lifeTotal':
      return value.scope !== 'eventPlayer';
    case 'const':
    case 'cardTypesInAllGraveyards':
    case 'cardTypesInYourGraveyard':
    case 'greatestNoncreatureManaValueYouControlOrInGraveyard':
    case 'cardTypesInOpponentsGraveyards':
    case 'timesAttackedThisTurn':
    case 'countersOnSelf':
    case 'countPermanents':
    case 'countCardsInZone':
    case 'aurasYouControlAttachedToCreatures':
    case 'aurasAttachedToSource':
    case 'devotionTo':
    case 'commanderCastCount':
    case 'commanderIdentityColorCount':
      return true;
    default:
      return false;
  }
}

/** True when this value needs a resolving ability's scope, so the layer engine cannot answer it. */
export function needsScope(value: Value): boolean {
  switch (value.kind) {
    case 'const':
    case 'cardTypesInAllGraveyards':
      return false;
    case 'plus':
    case 'negate':
    case 'times':
      return needsScope(value.of);
    case 'cardTypesInYourGraveyard':
    case 'cardTypesInOpponentsGraveyards':
    case 'greatestNoncreatureManaValueYouControlOrInGraveyard':
    case 'countPermanents':
    case 'countTappedPermanents':
    case 'countPermanentsControlledByTarget':
    case 'aurasYouControlAttachedToCreatures':
    case 'aurasAttachedToSource':
    case 'countCardsInZone':
    case 'colorsAmongPermanents':
    case 'colorsAmongPermanentsAndSpellsCastThisTurn':
    case 'devotionTo':
    case 'countOpponents':
    case 'greatestToughnessAmong':
    case 'greatestPowerAmong':
    case 'greatestManaValueAmong':
    case 'totalPowerOfAttackers':
    case 'totalPowerAmong':
    case 'xValue':
    case 'optionalCostCount':
    case 'damageDealt':
    case 'triggerCount':
    case 'aurasYouControlledAttachedToTriggerObject':
    case 'spellManaValue':
    case 'spellColorCount':
    case 'manaSpent':
    case 'treasureManaSpent':
    case 'energyPaid':
    case 'energyAvailable':
    case 'stationPower':
    case 'countersOnSelf':
    case 'allCountersOnSelf':
    case 'countersOnTarget':
    case 'manaValueOfTarget':
    case 'commanderCastCount':
    case 'commanderIdentityColorCount':
    case 'lifeTotal':
    case 'countOpponentsWithFewerCreatures':
    case 'creaturesDiedThisTurn':
    case 'timesAttackedThisTurn':
    case 'powerOfSource':
    case 'toughnessOfSource':
    case 'powerOfTarget':
    case 'opponentsLostLifeThisTurn':
    case 'powerOfTriggerObject':
    case 'cardsInTargetHand':
    case 'tappedCreaturesControlledByTarget':
    case 'attackingCreatures':
    case 'spellsCastThisTurn':
    case 'manaValueOfOtherSpellsCastThisTurn':
    case 'countersOnTriggerObject':
      return true;
    default:
      return assertNever(value, 'needsScope');
  }
}

/** Number of card types among cards in all graveyards (CR 208.2b). */
export function cardTypesInAllGraveyards(ctx: GameContext, owner?: PlayerId): number {
  const present = new Set<string>();
  for (const player of ctx.state.players) {
    if (owner !== undefined && player.id !== owner) continue;
    for (const card of player.graveyard) {
      const def = ctx.defs.get(card.oracleId);
      if (def === undefined) continue;
      for (const t of offBattlefieldTypes(ctx, def.types, card.ownerId).map(cardType)) {
        if ((CARD_TYPES as readonly string[]).includes(t)) present.add(t);
      }
    }
  }
  return present.size;
}

/**
 * Card types among cards in the graveyards of `controllerId`'s opponents, counted once across all
 * of them. A player who has left the game is no longer an opponent (CR 800.4a).
 */
export function cardTypesInOpponentsGraveyards(ctx: GameContext, controllerId: PlayerId): number {
  const present = new Set<string>();
  for (const player of ctx.state.players) {
    if (player.id === controllerId || player.hasLost) continue;
    for (const card of player.graveyard) {
      const def = ctx.defs.get(card.oracleId);
      if (def === undefined) continue;
      for (const t of offBattlefieldTypes(ctx, def.types, card.ownerId).map(cardType)) {
        if ((CARD_TYPES as readonly string[]).includes(t)) present.add(t);
      }
    }
  }
  return present.size;
}

/**
 * Devotion to one or two colours (CR 700.5, 700.5a): the mana symbols in the mana costs of
 * permanents you control that are any of those colours. A hybrid or Phyrexian symbol counts once
 * if any of its colours is one of them. Costs are copiable values read off the definitions (a
 * copy's `oracleId` is its copied definition), so this needs no layer pass. A face-down
 * permanent and a transformed permanent's back face have no mana cost.
 */
export function devotionTo(
  ctx: GameContext,
  controllerId: PlayerId,
  colors: Color | readonly Color[],
): number {
  const counted: readonly Color[] = typeof colors === 'string' ? [colors] : colors;
  let total = 0;
  for (const perm of ctx.state.battlefield) {
    if (perm.controllerId !== controllerId || perm.faceDown === true || perm.transformed) continue;
    const def = ctx.defs.get(perm.oracleId);
    const cost =
      def === undefined
        ? null
        : selectedPermanentDefinition(def, perm.face, perm.unlockedDoors).manaCost;
    if (cost == null) continue;
    for (const color of counted) total += cost.colored[color];
    for (const pip of cost.hybrid ?? []) if (pip.some((c) => counted.includes(c))) total += 1;
    for (const pip of cost.phyrexian ?? []) if (counted.includes(pip)) total += 1;
  }
  return total;
}

/**
 * Board-only evaluation, for the layer engine. See the module comment for what it refuses.
 *
 * `scope` is deliberately narrower than a resolving ability's full `ValueScope` — just the
 * static effect's source controller, which the layer engine always has on hand (CR 613's
 * "you" for a static ability is its controller) and which costs nothing to read: unlike `x`,
 * `damageDealt`, or `targets`, it is not tied to one resolution and does not go stale between
 * layer passes.
 */
export type LayerValueScope = Pick<ValueScope, 'controllerId' | 'countPermanents'> & {
  sourceCounters?: Readonly<Record<string, number>>;
  /** For `timesAttackedThisTurn`: the count of the one object the effect is being applied to. */
  affectedTimesAttacked?: number;
  countAurasYouControlAttachedToCreatures?: () => number;
  countCardsInZone?: (
    zone: 'graveyard' | 'hand' | 'library',
    selector: Selector,
    owner: 'you' | 'opponents' | 'all',
  ) => number;
  countAurasAttachedToSource?: () => number;
  /** Dragon Man: noncreature permanents read as the layers have them so far (CR 613.8a). */
  greatestNoncreatureManaValue?: () => number;
};

export function evaluateValue(ctx: GameContext, value: Value, scope?: LayerValueScope): number {
  switch (value.kind) {
    case 'const':
      return value.n;
    case 'plus':
      return evaluateValue(ctx, value.of, scope) + value.n;
    case 'negate':
      return -evaluateValue(ctx, value.of, scope);
    case 'times':
      return evaluateValue(ctx, value.of, scope) * value.n;
    case 'cardTypesInAllGraveyards':
      return cardTypesInAllGraveyards(ctx);
    case 'cardTypesInYourGraveyard':
      if (scope?.controllerId === undefined)
        throw new Error('your graveyard types require a controller');
      return cardTypesInAllGraveyards(ctx, scope.controllerId);
    case 'greatestNoncreatureManaValueYouControlOrInGraveyard':
      if (scope?.greatestNoncreatureManaValue === undefined)
        throw new Error('engine bug: greatest mana value needs a layer evaluation scope');
      return scope.greatestNoncreatureManaValue();
    case 'cardTypesInOpponentsGraveyards':
      if (scope?.controllerId === undefined)
        throw new Error("opponents' graveyard types require a controller");
      return cardTypesInOpponentsGraveyards(ctx, scope.controllerId);
    case 'timesAttackedThisTurn':
      return scope?.affectedTimesAttacked ?? 0;
    case 'countersOnSelf':
      if (scope?.sourceCounters === undefined) {
        throw new Error('engine bug: source counters need a layer evaluation scope');
      }
      return counterCount(scope.sourceCounters, value.counter);
    case 'countPermanents':
      if (!scope?.countPermanents) {
        throw new Error('engine bug: value countPermanents needs a layer evaluation scope');
      }
      return scope.countPermanents(value.selector, value.scope);
    case 'countCardsInZone':
      if (scope?.countCardsInZone === undefined)
        throw new Error('engine bug: value countCardsInZone needs a layer evaluation scope');
      return scope.countCardsInZone(value.zone, value.selector, value.owner);
    case 'aurasYouControlAttachedToCreatures':
      if (scope?.countAurasYouControlAttachedToCreatures === undefined) {
        throw new Error('engine bug: attached Aura count needs a layer evaluation scope');
      }
      return scope.countAurasYouControlAttachedToCreatures();
    case 'aurasAttachedToSource':
      if (scope?.countAurasAttachedToSource === undefined) {
        throw new Error(
          'engine bug: Auras-attached-to-source count needs a layer evaluation scope',
        );
      }
      return scope.countAurasAttachedToSource();
    case 'devotionTo':
      if (scope?.controllerId === undefined) {
        throw new Error(`engine bug: value "devotionTo" needs a source controller`);
      }
      return devotionTo(
        ctx,
        scope.controllerId,
        value.and === undefined ? value.color : [value.color, value.and],
      );
    case 'commanderCastCount': {
      if (scope?.controllerId === undefined) {
        throw new Error(
          `engine bug: value "commanderCastCount" needs a static effect's source controller`,
        );
      }
      const player = ctx.state.players.find((p) => p.id === scope.controllerId);
      if (!player) return 0;
      return Object.values(player.commanderCastCount).reduce((sum, n) => sum + n, 0);
    }
    case 'lifeTotal': {
      // "where X is your life total" (Death's Shadow): the static's controller's life, read by
      // the layer engine like any other board fact (CR 613's "you" is its controller).
      if (value.scope === 'eventPlayer' || scope?.controllerId === undefined)
        throw new Error("engine bug: a layer life total needs the static effect's controller");
      return ctx.state.players.find((p) => p.id === scope.controllerId)?.life ?? 0;
    }
    case 'commanderIdentityColorCount': {
      if (scope?.controllerId === undefined) {
        throw new Error(
          'engine bug: value "commanderIdentityColorCount" needs a source controller',
        );
      }
      const player = ctx.state.players.find((p) => p.id === scope.controllerId);
      return player?.commanderColorIdentity.length ?? 0;
    }
    case 'countTappedPermanents':
    case 'countPermanentsControlledByTarget':
    case 'colorsAmongPermanents':
    case 'colorsAmongPermanentsAndSpellsCastThisTurn':
    case 'countOpponents':
    case 'greatestToughnessAmong':
    case 'greatestPowerAmong':
    case 'greatestManaValueAmong':
    case 'totalPowerOfAttackers':
    case 'totalPowerAmong':
    case 'xValue':
    case 'optionalCostCount':
    case 'damageDealt':
    case 'triggerCount':
    case 'aurasYouControlledAttachedToTriggerObject':
    case 'spellManaValue':
    case 'spellColorCount':
    case 'manaSpent':
    case 'treasureManaSpent':
    case 'energyPaid':
    case 'energyAvailable':
    case 'stationPower':
    case 'allCountersOnSelf':
    case 'countersOnTarget':
    case 'manaValueOfTarget':
    case 'countOpponentsWithFewerCreatures':
    case 'creaturesDiedThisTurn':
    case 'powerOfSource':
    case 'toughnessOfSource':
    case 'powerOfTarget':
    case 'opponentsLostLifeThisTurn':
    case 'powerOfTriggerObject':
    case 'cardsInTargetHand':
    case 'tappedCreaturesControlledByTarget':
    case 'attackingCreatures':
    case 'spellsCastThisTurn':
    case 'manaValueOfOtherSpellsCastThisTurn':
    case 'countersOnTriggerObject':
      throw new Error(
        `engine bug: value "${value.kind}" needs a resolving ability's scope — use evaluateValueIn`,
      );
    default:
      return assertNever(value, 'layer Value');
  }
}
