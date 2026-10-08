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

import type { Color, PlayerId } from '@mtg/shared';
import type { GameContext } from '../state/types';
import type { Selector } from './selector';
import type { EffectRef } from './ability';

/** What a resolving ability knows that the board alone does not. */
export interface ValueScope {
  /** Whose "you" this is. */
  controllerId: PlayerId;
  /** The source object's card id, for `self`-relative selectors. */
  sourceCardId?: string;
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
  /** Mana actually spent to cast the spell that fired a trigger (Aetherflux Conduit). */
  manaSpent?: number;
  /** Mana produced by Treasure permanents that was spent to cast the entering spell. */
  treasureManaSpent?: number;
  /** Energy paid by a preceding variable-payment effect in this same resolution. */
  energyPaid?: number;
  stationPower?: number;
  /** Player involved in the firing event (for that-player-controlled targets). */
  eventPlayerId?: PlayerId;
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
  | 'triggerCount'
  | 'spellManaValue'
  | 'manaSpent'
  | 'eventPlayerId'
  | 'stationPower'
  | 'sourceCountersTotal'
  | 'triggerObjectId'
  | 'eventObjectId'
>;

export type Value =
  | { kind: 'const'; n: number }
  /** Number of card types among cards in all graveyards (Tarmogoyf, CR 208.2b). */
  | { kind: 'cardTypesInAllGraveyards' }
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
  /** Colored mana symbols in the mana costs of permanents controlled by the resolving player. */
  | { kind: 'devotionTo'; color: import('@mtg/shared').Color }
  /** Number of opponents of the resolving controller. */
  | { kind: 'countOpponents' }
  /** "the greatest toughness among creatures you control" (Last March of the Ents). */
  | { kind: 'greatestToughnessAmong'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /** "the greatest power among creatures you control". */
  | { kind: 'greatestPowerAmong'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
  /** Greatest mana value among permanents matching a selector. */
  | { kind: 'greatestManaValueAmong'; selector: Selector; scope: 'you' | 'opponents' | 'all' }
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
  /** "equal to that spell's mana value" — the spell that fired a `castsSpell` trigger. */
  | { kind: 'spellManaValue' }
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

/** The eight card types a permanent/card can have (for graveyard-type counting). */
const CARD_TYPES = [
  'Artifact',
  'Battle',
  'Creature',
  'Enchantment',
  'Instant',
  'Land',
  'Planeswalker',
  'Sorcery',
] as const;

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
    default:
      return true;
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
    default:
      return true;
  }
}

/** Number of card types among cards in all graveyards (CR 208.2b). */
export function cardTypesInAllGraveyards(ctx: GameContext): number {
  const present = new Set<string>();
  for (const player of ctx.state.players) {
    for (const card of player.graveyard) {
      const def = ctx.defs.get(card.oracleId);
      if (def === undefined) continue;
      for (const t of def.types) {
        if ((CARD_TYPES as readonly string[]).includes(t)) present.add(t);
      }
    }
  }
  return present.size;
}

/**
 * Devotion to a colour (CR 700.5): mana symbols of that colour in the mana costs of permanents
 * you control. Printed costs, read straight off the definitions — nothing continuous changes a
 * permanent's mana cost, so this needs no layer pass and is safe to answer from `evaluateValue`.
 */
export function devotionTo(ctx: GameContext, controllerId: PlayerId, color: Color): number {
  return ctx.state.battlefield
    .filter((perm) => perm.controllerId === controllerId)
    .reduce(
      (total, perm) => total + (ctx.defs.get(perm.oracleId)?.manaCost?.colored[color] ?? 0),
      0,
    );
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
  countAurasYouControlAttachedToCreatures?: () => number;
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
    case 'countersOnSelf':
      if (scope?.sourceCounters === undefined) {
        throw new Error('engine bug: source counters need a layer evaluation scope');
      }
      return scope.sourceCounters[value.counter] ?? 0;
    case 'countPermanents':
      if (!scope?.countPermanents) {
        throw new Error('engine bug: value countPermanents needs a layer evaluation scope');
      }
      return scope.countPermanents(value.selector, value.scope);
    case 'aurasYouControlAttachedToCreatures':
      if (scope?.countAurasYouControlAttachedToCreatures === undefined) {
        throw new Error('engine bug: attached Aura count needs a layer evaluation scope');
      }
      return scope.countAurasYouControlAttachedToCreatures();
    case 'devotionTo':
      if (scope?.controllerId === undefined) {
        throw new Error(`engine bug: value "devotionTo" needs a source controller`);
      }
      return devotionTo(ctx, scope.controllerId, value.color);
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
    case 'commanderIdentityColorCount': {
      if (scope?.controllerId === undefined) {
        throw new Error(
          'engine bug: value "commanderIdentityColorCount" needs a source controller',
        );
      }
      const player = ctx.state.players.find((p) => p.id === scope.controllerId);
      return player?.commanderColorIdentity.length ?? 0;
    }
    default:
      throw new Error(
        `engine bug: value "${value.kind}" needs a resolving ability's scope — use evaluateValueIn`,
      );
  }
}
