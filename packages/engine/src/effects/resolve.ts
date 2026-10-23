import { targetingSourceFields } from '../targets/context';
import type { TargetingSource } from '../targets/context';
import { copyData } from '../state/copy-data';
import { offBattlefieldTypes } from '../state/off-battlefield-types';
import { HUMAN_SOLDIER_1_1_WHITE } from '../cards/tokens';
import {
  discover,
  revealUntilAura,
  exileEachUntilNonlandAndCast,
  revealCreatureOrBottom,
  bottomCards,
} from './library-reveal';
import { lookAtLibraryAndCast } from './library-cast';
import {
  playerLifeLocked,
  phaseOutControlledPermanents,
  phaseOutPermanents,
} from '../state/phasing';
import { returnToOwnerLibraryChoices } from './owner-library-choices';
import {
  counterCount,
  setCounterCount,
  expireCounterBoundAttackRestrictions,
} from '../state/counters';
import { isPermanentCard } from '../cards/definition';
import type { ObjectFacts } from '../cards/source-identity';
import { eventObjectFacts, sourceObjectFacts } from '../cards/source-identity';
import { assertDelayedTriggerEvent } from '../cards/trigger-contracts';
import { queueAbilityCopy, queueReplicateCopy, queueSpellCopy } from '../stack/copy';
import { chooseReplicateTargets } from '../stack/replicate-targets';
import { allStackTargets, changeSingleStackTarget, chooseNewStackTargets } from '../stack/retarget';
import { newObjectId, stackAbilitySnapshot } from '../state/objects';
import { findObjectByCardId, spellDefinitionOf } from '../state/queries';
import type { ProtectionSource } from '../state/queries';
import { freeCardIsCastable, resolveFreeCard } from '../casting/free';
import { permanentManaValue, targetIsLegal } from '../targets/legality';
import { captureResolutionTargets, type ResolutionTargets } from '../targets/resolution';
import { assertNever } from '../utils/assert-never';
import { assertManaRiders } from '../cards/mana-riders';
/**
 * Effect resolution (brief §6.2): applying the mechanical outcome of `EffectSpec`s, plus
 * the shared damage/draw/life primitives used by combat and turn-based actions.
 */

import type { Color, ObjectId, PlayerId } from '@mtg/shared';
import { ALL_COLORS } from '@mtg/shared';
import { abilityModeSelections } from '../actions/ability-modes';
import type {
  AttackRequirementSpec,
  ManaRider,
  StackAbilitySnapshot,
  WardCost,
} from '../cards/ability';
import type {
  Ability,
  AbilityCost,
  Effect,
  EffectRef,
  SearchDestination,
  Selector,
  TargetKind,
  TargetSpec,
} from '../cards/definition';
import { queueBecomesTargetedTriggers, queueWardTriggers } from '../actions/apply';
import { evaluateCondition, isChoiceCondition, resolveCondition } from '../cards/condition';
import { allOf, ofSupertype, ofType, selectMatches, YOURS } from '../cards/selector';
import type { GameGen } from '../decisions';
import { UnmodeledCardError } from '../errors';
import {
  candidateOf,
  computeCharacteristics,
  matchesSelector,
  selectPermanents,
} from './continuous';
import { evaluateValueIn } from './values';
import type { Value, ValueScope } from '../cards/value';
import { evaluateValue } from '../cards/value';
import {
  addGeneric,
  canPay,
  describeManaCost,
  entryIsUsable,
  planPayment,
  sacrificesArePayable,
  totalPips,
  withX,
} from '../mana/cost';
import { withoutReserved } from '../mana/activation';
import type { ParsedManaCost, PaymentPlan } from '../mana/cost';
import type { SpellPaymentChoice } from '../mana/spell-payment';
import { addMana, removeMana, selectEntriesToSpend } from '../mana/pool';
import type { GainControlIRDuration, ManaEntry, PaymentPurpose } from '../cards/ability';
import { debug, emit } from '../log/log';
import { cardOption, plainOption, playerOption, presentedSource, valueOption } from '../present';
import { chooseCard, type ChooseCardSpec } from './choose';
import { applyDamageModifiers, chooseDamageSource } from './damage-modifiers';
import {
  additionalTypedTriggerCopies,
  discardCard,
  applyCopy,
  applyTokenCreationReplacements,
  attachPermanent,
  consumeRegenerationShield,
  removeFromCombat,
  createToken,
  changeController,
  refreshControlEffects,
  createTokens,
  createTokensForPlayers,
  makePermanent,
  canAttach,
  moveObject,
  moveObjects,
  movePermanentsToGraveyard,
  movePermanentsTogether,
  playerById,
  queuePlayerTriggersForEvent,
  queueTriggersForEvent,
  queueTriggersForObject,
  removeFromCurrentZone,
  spellManaValue,
  tokenSpecCopying,
  transformPermanent,
} from '../state/objects';
import {
  allowanceFor,
  cardZoneCandidate,
  counterAmountAfterReplacements,
  tokenCreationMultiplierFor,
  effectivePT,
  findPermanent,
  getDefByOracleId,
  landPlayLimitFor,
  hasKeyword,
  hasProtectionFrom,
  isCreaturePermanent,
  manaRestrictionAllows,
  manaSourcesFor,
  opponentsOf,
  playersInApnapOrder,
  sourceTraitsOf,
  targetingFromDefinition,
  spellProtectedFromCounter,
  requireModeled,
  castingSpellsBlockedFor,
  convokeSourcesFor,
  spellHasConvoke,
  sacrificeCandidateAllowed,
  canBeSacrificed,
  selfMayTap,
  resolveConditionalUnits,
  resolveDynamicAmount,
  resolveDynamicUnits,
  playerCantLose,
} from '../state/queries';
import type {
  ControlChangeDuration,
  AttackRequirementEntry,
  AttackRequirementRule,
  DamageKeyword,
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
  GameContext,
} from '../state/types';

function* destroyPermanent(
  ctx: GameContext,
  source: EffectSource,
  perm: EnginePermanent,
  cantRegenerate = false,
): GameGen<boolean> {
  if (hasKeyword(ctx, perm, 'indestructible')) {
    debug(ctx, 'effect', `${perm.name} is indestructible — destroy has no effect`);
    emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
    return false;
  }
  if (consumeRegenerationShield(ctx, perm, cantRegenerate)) {
    debug(ctx, 'effect', `${perm.name} regenerates instead of being destroyed`);
    return false;
  }
  emit(ctx, 'destroy', { target: perm.name, source: source.name });
  yield* moveObject(ctx, perm, { zone: 'graveyard' });
  return true;
}

/** Any engine object with this stable object id, in whatever zone it currently occupies. */
function findObjectById(ctx: GameContext, id: ObjectId): EngineObject | undefined {
  const foundStack = ctx.state.stack.find((object) => object.id === id);
  if (foundStack !== undefined) return foundStack as unknown as EngineObject;
  const zones: EngineObject[][] = [ctx.state.battlefield, ctx.state.exile];
  for (const player of ctx.state.players) {
    zones.push(player.hand, player.library, player.graveyard, player.commandZone);
  }
  for (const zone of zones) {
    const found = zone.find((object) => object.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A card currently sitting in ANY player's graveyard, by object id — not just the ability
 * controller's own (Reanimate: "target creature card from A graveyard" offers candidates from
 * every graveyard at the targeting step, so resolution has to look in all of them too).
 *
 * Deliberately narrower than `findObjectById`: if the card left the graveyard between
 * announcement and resolution (CR 608.2b), the correct outcome is "target is gone, do nothing" —
 * not finding it in whatever OTHER zone it ended up in and acting on it there. `ref()` already
 * re-checks the target's legality before this ever runs, so returning `undefined` here is the
 * expected "gone" case, not a bug.
 */
function findCardInAnyGraveyard(ctx: GameContext, id: ObjectId): EngineCardObject | undefined {
  for (const player of ctx.state.players) {
    const found = player.graveyard.find((c) => c.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Apply CR 701.15a/d: one player contributes at most one active goad requirement. */
function addGoadRequirement(
  ctx: GameContext,
  perm: EnginePermanent,
  goaderId: PlayerId,
  permanent = false,
): void {
  const existing = perm.goadedBy ?? [];
  const same = existing.find((requirement) => requirement.goaderId === goaderId);
  if (same !== undefined) {
    // A goad that lasts for the rest of the game replaces one that would have expired.
    if (permanent && same.permanent !== true) same.permanent = true;
    return;
  }
  perm.goadedBy = [
    ...existing,
    {
      goaderId,
      appliedTurn: ctx.state.turnNumber,
      ...(permanent ? { permanent: true as const } : {}),
    },
  ];
}

/**
 * Locate a physical card by `cardId`, in whatever non-stack zone it currently occupies.
 * Legacy unpinned callers exclude stack entries: an ability sharing `sourceCardId` must not
 * be mistaken for its source card. Exact bindings use `findObjectById` instead.
 */
function findPhysicalObjectByCardId(ctx: GameContext, cardId: string): EngineObject | undefined {
  const zones: EngineObject[][] = [ctx.state.battlefield, ctx.state.exile];
  for (const player of ctx.state.players) {
    zones.push(player.hand, player.library, player.graveyard, player.commandZone);
  }
  for (const zone of zones) {
    const found = zone.find((object) => object.cardId === cardId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Identity of whatever is dealing damage / causing an effect, for logging + rules. */
export interface EffectSource {
  lastKnownFacts?: ObjectFacts;
  /** Target legality captured before this resolution's first instruction. */
  resolutionTargets?: ResolutionTargets;
  /** The source incarnation, when resolving an ability of a permanent. */
  id?: ObjectId;
  cardId: string;
  name: string;
  oracleId: string;
  controllerId: PlayerId;
  /** Present only while a spell itself is resolving; permits self-replacement destinations. */
  resolvingStackObject?: EngineStackObject;
  /** The source's colors as its ability went on the stack — protection's last known information. */
  lastKnownColors?: readonly Color[];
  /** The resolving spell's card types (its selected face), for protection from a card type. */
  lastKnownTypes?: readonly string[];
  /** The source's damage keywords as it left the battlefield — LKI for damage it deals after. */
  lastKnownDamageKeywords?: readonly DamageKeyword[];
}

/**
 * An effect source's colors and card types for protection (CR 702.16): current while it is on
 * the battlefield, otherwise what it had as its ability went on the stack or as it left.
 */
export function effectSourceTraits(ctx: GameContext, source: EffectSource): ProtectionSource {
  return sourceTraitsOf(ctx, source.cardId, source.oracleId, {
    ...(source.lastKnownColors === undefined ? {} : { colors: source.lastKnownColors }),
    ...(source.lastKnownTypes !== undefined
      ? { types: source.lastKnownTypes }
      : source.lastKnownFacts !== undefined
        ? { types: source.lastKnownFacts.candidate.types }
        : {}),
  });
}

/** Deal non-combat or combat damage from `source` to a creature. */
export function* dealDamageToCreature(
  ctx: GameContext,
  source: EffectSource,
  target: EnginePermanent,
  amount: number,
  opts: {
    combat: boolean;
    sourceHasDeathtouch: boolean;
    sourceHasLifelink: boolean;
    sourceHasInfect?: boolean;
    /** The source's colors and types, for protection (CR 702.16). Omitted ⇒ none applies. */
    sourceTraits?: ProtectionSource;
    /**
     * Simultaneous combat damage (CR 510.2) is one event for "is dealt damage" (CR 603.2c): the
     * caller passes a map, the amount dealt is added to it, and it queues the trigger once per
     * creature with the total after every assignment. Omitted ⇒ this hit queues its own trigger.
     */
    dealtTotals?: Map<EnginePermanent, number>;
  },
): GameGen<void> {
  if (amount <= 0) return;
  // Replacement and prevention effects (CR 616.1): the combat shield, protection (CR 702.16 — the
  // D in DEBT, so no damage is marked and no lifelink is gained), Guard Gomazoa, and the damage
  // doublers and halvers, ordered by the damaged permanent's controller when the order matters.
  amount = (yield* applyDamageModifiers(ctx, {
    source,
    recipient: { kind: 'permanent', permanent: target },
    amount,
    combat: opts.combat,
    ...(opts.sourceTraits !== undefined ? { sourceTraits: opts.sourceTraits } : {}),
  })).amount;
  if (amount <= 0) return;
  // Excess damage this turn (Rith, Liberated Primeval) — the amount by which this single hit
  // exceeded what was needed to reduce the target to 0 toughness, accounting for damage already
  // marked. Tracked by the DAMAGED permanent's controller, regardless of who dealt it.
  const remainingToughness = Math.max(0, effectivePT(ctx, target).toughness - target.damageMarked);
  const neededToKill = target.damagedByDeathtouch
    ? 0
    : opts.sourceHasDeathtouch
      ? Math.min(1, remainingToughness)
      : remainingToughness;
  if (amount > neededToKill) {
    ctx.state.excessDamageControllerIds.push(target.controllerId);
  }
  if (opts.sourceHasInfect === true) addCounters(ctx, source, target, '-1/-1', amount);
  else target.damageMarked += amount;
  if (opts.sourceHasDeathtouch) target.damagedByDeathtouch = true;
  if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
  // CR 702.90e: infect still counts as "dealt damage" for triggers even though it marks
  // -1/-1 counters instead of damage.
  if (opts.dealtTotals !== undefined)
    opts.dealtTotals.set(target, (opts.dealtTotals.get(target) ?? 0) + amount);
  else queueTriggersForEvent(ctx, 'dealtDamage', [{ permanent: target, amount }]);
  emit(ctx, 'damage', {
    source: source.name,
    sourceCardId: source.cardId,
    target: target.name,
    targetCardId: target.cardId,
    amount,
    combat: opts.combat,
  });
}

/**
 * Deal damage from `source` to a player. Tracks commander combat damage (brief §5.7). Returns the
 * damage actually dealt — 0 when it was prevented — for "deals damage to a player" consequences.
 */
export function* dealDamageToPlayer(
  ctx: GameContext,
  source: EffectSource,
  target: EnginePlayerState,
  amount: number,
  opts: {
    combat: boolean;
    sourceIsCommander: boolean;
    sourceHasLifelink: boolean;
    sourceHasInfect?: boolean;
    /** Internal simultaneous player-damage batch: modifiers were planned before any life changed. */
    preparedAmount?: true;
    deferredObservations?: (() => void)[];
  },
): GameGen<number> {
  if (amount <= 0) return 0;
  // Replacement and prevention effects (CR 616.1): the combat shield, the damage doublers and
  // halvers, ordered by the damaged player when the order matters.
  if (opts.preparedAmount !== true)
    amount = (yield* applyDamageModifiers(ctx, {
      source,
      recipient: { kind: 'player', player: target },
      amount,
      combat: opts.combat,
    })).amount;
  if (amount <= 0) return 0;
  if (opts.sourceHasInfect === true) {
    target.poisonCounters += amount;
    emit(
      ctx,
      'counters',
      {
        source: source.name,
        target: target.id,
        counter: 'poison',
        added: amount,
        total: target.poisonCounters,
      },
      source.controllerId,
    );
  } else {
    target.life =
      ctx.state.lifeFloorPlayers[target.id] === true
        ? Math.max(1, target.life - amount)
        : target.life - amount;
    // CR 120.3: damage dealt to a player causes that player to lose that much life. Cards that
    // ask who "lost life this turn" (Gev, Scaled Scorch) must see damage, not just `loseLife`.
    // The infect branch above is deliberately excluded: it gives poison counters instead.
    ctx.state.lifeLostThisTurn[target.id] = true;
  }
  ctx.state.damageDealtToPlayersThisTurn[target.id] =
    (ctx.state.damageDealtToPlayersThisTurn[target.id] ?? 0) + amount;
  // "…whose controller was dealt combat damage by this creature this turn" (Steel Hellkite) —
  // by SOURCE, unlike the total above, and combat damage only.
  if (opts.combat) {
    const bySource = ctx.state.combatDamagePlayersBySource[source.cardId] ?? [];
    if (!bySource.includes(target.id)) {
      ctx.state.combatDamagePlayersBySource[source.cardId] = [...bySource, target.id];
    }
  }
  // 21+ combat damage from the same commander eliminates — COMBAT damage only (§5.7).
  if (opts.combat && opts.sourceIsCommander) {
    target.commanderDamageTaken[source.cardId] =
      (target.commanderDamageTaken[source.cardId] ?? 0) + amount;
  }
  const observe = () => {
    if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
    emit(ctx, 'damage', {
      source: source.name,
      sourceCardId: source.cardId,
      controller: source.controllerId,
      target: target.id,
      amount,
      combat: opts.combat,
      commanderDamage: opts.combat && opts.sourceIsCommander,
    });
    // "Whenever a source ... deals damage to you" watches damage actually dealt, once per source's
    // damage event, infect included (CR 702.90b).
    queuePlayerTriggersForEvent(ctx, 'playerDealtDamage', target.id, amount, source.controllerId);
    // "Whenever this creature deals damage to an opponent" needs damage actually dealt (after every
    // modifier), so it is queued here, only for a source still on the battlefield.
    const damagingPermanent = ctx.state.battlefield.find((permanent) => permanent.id === source.id);
    if (damagingPermanent !== undefined && damagingPermanent.controllerId !== target.id)
      queueTriggersForEvent(ctx, 'dealsDamageToOpponent', [
        { permanent: damagingPermanent, amount, playerId: target.id },
      ]);
  };
  if (opts.deferredObservations === undefined) observe();
  else opts.deferredObservations.push(observe);
  return amount;
}

/** One source deals varying amounts to several players as a single damage event. */
function* dealDamageToPlayersTogether(
  ctx: GameContext,
  source: EffectSource,
  hits: { player: EnginePlayerState; amount: number }[],
): GameGen<void> {
  const plans: { player: EnginePlayerState; amount: number }[] = [];
  for (const hit of hits) {
    if (hit.amount <= 0 || hit.player.hasLost) continue;
    const adjusted = yield* applyDamageModifiers(ctx, {
      source,
      recipient: { kind: 'player', player: hit.player },
      amount: hit.amount,
      combat: false,
    });
    plans.push({ player: hit.player, amount: adjusted.amount });
  }
  const observations: (() => void)[] = [];
  const permanent = ctx.state.battlefield.find((entry) => entry.id === source.id);
  const lifelink =
    permanent === undefined
      ? source.lastKnownDamageKeywords?.includes('lifelink') === true
      : hasKeyword(ctx, permanent, 'lifelink');
  const infect =
    permanent === undefined
      ? source.lastKnownDamageKeywords?.includes('infect') === true
      : hasKeyword(ctx, permanent, 'infect');
  let total = 0;
  for (const plan of plans)
    total += yield* dealDamageToPlayer(ctx, source, plan.player, plan.amount, {
      combat: false,
      sourceIsCommander: false,
      sourceHasLifelink: false,
      sourceHasInfect: infect,
      preparedAmount: true,
      deferredObservations: observations,
    });
  if (lifelink) gainLife(ctx, playerById(ctx, source.controllerId), total);
  for (const observe of observations) observe();
}

/**
 * Damage to a planeswalker removes that many loyalty counters, and damage to a battle that many
 * defense counters, instead of marking damage (CR 120.3c/h). Runs through the damage modifier
 * pipeline like every damage event, so combat damage can be prevented, doubled or halved here too.
 * Returns the damage actually dealt.
 */
function* dealDamageToLoyaltyOrDefense(
  ctx: GameContext,
  source: EffectSource,
  perm: EnginePermanent,
  counterKind: 'loyalty' | 'defense',
  amount: number,
  opts: { combat: boolean; sourceHasLifelink: boolean; sourceTraits: ProtectionSource },
): GameGen<number> {
  if (amount <= 0) return 0;
  amount = (yield* applyDamageModifiers(ctx, {
    source,
    recipient: { kind: 'permanent', permanent: perm },
    amount,
    combat: opts.combat,
    sourceTraits: opts.sourceTraits,
  })).amount;
  if (amount <= 0) return 0;
  const have = counterCount(perm.counters, counterKind);
  if (counterKind === 'loyalty' && amount > have)
    ctx.state.excessDamageControllerIds.push(perm.controllerId);
  setCounterCount(perm.counters, counterKind, Math.max(0, have - amount));
  // Lifelink applies to damage dealt to any object or player (CR 702.15b).
  if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
  emit(ctx, 'damage', {
    source: source.name,
    sourceCardId: source.cardId,
    target: perm.name,
    targetCardId: perm.cardId,
    amount,
    combat: opts.combat,
  });
  return amount;
}

/** Combat damage from `source` to the planeswalker it is attacking (CR 120.3c, 510.2). */
export function* dealCombatDamageToPlaneswalker(
  ctx: GameContext,
  source: EffectSource,
  perm: EnginePermanent,
  amount: number,
  opts: { sourceHasLifelink: boolean; sourceTraits: ProtectionSource },
): GameGen<number> {
  return yield* dealDamageToLoyaltyOrDefense(ctx, source, perm, 'loyalty', amount, {
    combat: true,
    ...opts,
  });
}

/**
 * Where a creature put onto the battlefield attacking attacks (CR 508.4): its controller chooses
 * one of `defenderIds`, or (when the text allows) a planeswalker one of them controls. Asks only
 * when there is more than one choice.
 */
function* chooseEnteringAttackTarget(
  ctx: GameContext,
  controller: EnginePlayerState,
  sourceName: string,
  defenderIds: readonly PlayerId[],
  allowPlaneswalkers: boolean,
): GameGen<{ defenderId: PlayerId; planeswalkerId: ObjectId | null }> {
  const choices: { defenderId: PlayerId; planeswalker: EnginePermanent | null }[] =
    defenderIds.flatMap((defenderId) => [
      { defenderId, planeswalker: null },
      ...(allowPlaneswalkers
        ? ctx.state.battlefield
            .filter(
              (p) =>
                p.controllerId === defenderId &&
                computeCharacteristics(ctx, p).types.includes('Planeswalker'),
            )
            .map((planeswalker) => ({ defenderId, planeswalker }))
        : []),
    ]);
  let chosen = choices[0] as (typeof choices)[number];
  if (choices.length > 1) {
    const outcome = yield {
      decisionType: 'general',
      player: controller.id,
      prompt: `${sourceName}: choose who the token attacks`,
      options: choices.map(({ defenderId, planeswalker }) =>
        planeswalker === null
          ? playerOption(defenderId, defenderId, {
              type: 'choosePlayer',
              description: `Attack ${defenderId}`,
              payload: defenderId,
              verb: 'Attack',
            })
          : cardOption(ctx, planeswalker, {
              viewerId: controller.id,
              type: 'choosePlaneswalker',
              description: `Attack ${planeswalker.name}`,
              payload: planeswalker.id,
              verb: 'Attack',
            }),
      ),
    };
    chosen = choices[outcome.index] ?? chosen;
  }
  return { defenderId: chosen.defenderId, planeswalkerId: chosen.planeswalker?.id ?? null };
}

/** Deal non-combat damage from `source` to whichever kind of object `id` names. */
function* dealDamageToObject(
  ctx: GameContext,
  source: EffectSource,
  id: ObjectId,
  amount: number,
): GameGen<void> {
  const sourcePermanent = ctx.state.battlefield.find(
    (p) => p.cardId === source.cardId && (source.id === undefined || p.id === source.id),
  );
  // A source that has left deals damage with its last known abilities (CR 113.7a): a Mordant
  // Dragon that had deathtouch as it left still destroys.
  const sourceHas = (kw: DamageKeyword): boolean =>
    sourcePermanent !== undefined
      ? hasKeyword(ctx, sourcePermanent, kw)
      : (source.lastKnownDamageKeywords?.includes(kw) ?? false);
  const sourceHasInfect = sourceHas('infect');
  const sourceHasLifelink = sourceHas('lifelink');
  const sourceHasDeathtouch = sourceHas('deathtouch');
  // Protection (CR 702.16e) prevents damage from a protected-from source, noncombat included.
  const sourceTraits = effectSourceTraits(ctx, source);
  const targetPlayer = ctx.state.players.find((p) => p.id === id);
  if (targetPlayer !== undefined) {
    yield* dealDamageToPlayer(ctx, source, targetPlayer, amount, {
      combat: false,
      sourceIsCommander: false,
      sourceHasLifelink,
      sourceHasInfect,
    });
    return;
  }
  const perm = findPermanent(ctx, id);
  if (perm === undefined) return;
  // CR 120.3c/h: damage to a planeswalker removes that many loyalty counters, and damage to a
  // battle that many defense counters, instead of marking damage — neither has toughness.
  const permTypes = computeCharacteristics(ctx, perm).types;
  const counterKind = permTypes.includes('Planeswalker')
    ? 'loyalty'
    : permTypes.includes('Battle') && !permTypes.includes('Creature')
      ? 'defense'
      : null;
  if (counterKind !== null) {
    yield* dealDamageToLoyaltyOrDefense(ctx, source, perm, counterKind, amount, {
      combat: false,
      sourceHasLifelink,
      sourceTraits,
    });
    return;
  }
  yield* dealDamageToCreature(ctx, source, perm, amount, {
    combat: false,
    sourceHasDeathtouch,
    sourceHasLifelink,
    sourceHasInfect,
    sourceTraits,
  });
}

export function gainLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  gainLifeForPlayers(ctx, [{ player, amount }]);
}

/** Simultaneous gains update every life total before any trigger observes the event. */
function gainLifeForPlayers(
  ctx: GameContext,
  grants: readonly { player: EnginePlayerState; amount: number }[],
): void {
  const gains = grants.filter(
    ({ player, amount }) => amount > 0 && !playerLifeLocked(ctx, player.id),
  );
  for (const { player, amount } of gains) player.life += amount;
  for (const { player, amount } of gains) {
    emit(ctx, 'lifeGain', { player: player.id, amount, life: player.life });
    queuePlayerTriggersForEvent(ctx, 'gainsLife', player.id, amount);
  }
}

export function loseLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (amount <= 0 || playerLifeLocked(ctx, player.id)) return;
  // Angel's Grace's floor is for damage only (applyDamageToPlayer); life loss goes below 1.
  player.life -= amount;
  ctx.state.lifeLostThisTurn[player.id] = true;
  emit(ctx, 'lifeLoss', { player: player.id, amount, life: player.life });
}

/** CR 119.4 / 119.4b: positive life payments need enough life; zero is always payable. */
export function payLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('life cost became unpayable');
  }
  if (amount === 0) return;
  if (amount > player.life || playerLifeLocked(ctx, player.id))
    throw new Error('life cost became unpayable');
  player.life -= amount;
  if (ctx.costLifePaid !== undefined) ctx.costLifePaid.amount += amount;
  ctx.state.lifeLostThisTurn[player.id] = true;
  emit(ctx, 'lifeLoss', { player: player.id, amount, life: player.life });
}

/**
 * Draw cards. Drawing from an empty library sets the loss flag checked at the next SBA
 * check, not an immediate loss (brief §5.6). A generator: a drawn commander (one shuffled
 * into the library) triggers the CR 903.9b hand-replacement choice inside `moveObject`.
 *
 * Returns the number of cards ACTUALLY drawn: one per card whose move to hand led to the
 * `draw` event. A draw instruction that did not move a card to hand — the empty-library
 * flag, or the empty-library replacement putting a graveyard creature back — is not a
 * draw, so callers such as "draw for each opponent who drew a card this way" must not
 * count it (CR 608.2h reads what actually happened).
 */
export function* drawCards(
  ctx: GameContext,
  player: EnginePlayerState,
  count: number,
): GameGen<number> {
  let drawnCount = 0;
  for (let i = 0; i < count; i++) {
    const top = player.library[0];
    if (top === undefined) {
      const replacement = ctx.state.battlefield.find(
        (perm) =>
          perm.controllerId === player.id &&
          ctx.defs.get(perm.oracleId)?.emptyLibraryCreatureReplacement === true,
      );
      if (replacement !== undefined) {
        const creatures = player.graveyard.filter((card) =>
          getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Creature'),
        );
        const chosen = yield* chooseCard(ctx, {
          player: player.id,
          prompt: `${replacement.name}: return a creature from your graveyard instead of drawing`,
          cards: creatures,
          type: 'returnToBattlefield',
          verb: 'Return',
        });
        // "If you can't, you lose the game": a creature card must be returned when there is one.
        if (chosen === null) {
          if (!playerCantLose(ctx, player.id)) player.hasLost = true;
        } else yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: player.id });
        // The reanimation AS A DRAW REPLACEMENT is not a draw: no card reached the hand.
        continue;
      }
      player.attemptedDrawFromEmptyLibrary = true;
      emit(ctx, 'drawFromEmptyLibrary', { player: player.id });
      debug(ctx, 'engine', `${player.id} attempted to draw from an empty library`);
      continue;
    }
    const drawn = yield* moveObject(ctx, top, { zone: 'hand' });
    if (drawn?.zone !== 'hand') continue;
    // The count is banked exactly when this successful emitted draw exists: the card moved
    // to hand and the `draw` event below is about to record it.
    drawnCount += 1;
    emit(
      ctx,
      'draw',
      {
        player: player.id,
        cardId: top.cardId,
        name: top.name,
        isLand: getDefByOracleId(ctx, top.oracleId, top.name).types.includes('Land'),
      },
      player.id,
    );
    player.cardsDrawnThisTurn += 1;
    player.cardsDrawnThisDrawStep += 1;
    queuePlayerTriggersForEvent(ctx, 'drawsCard', player.id);
  }
  return drawnCount;
}

/** Discard N cards, one controller choice at a time (CR 701.8a). */
function* discardCards(
  ctx: GameContext,
  player: EnginePlayerState,
  count: number,
  excludeCardId?: string,
  canDiscard?: (card: EngineCardObject, ordinal: number) => boolean,
  cause: 'effect' | 'cost' = 'effect',
): GameGen<{ card: EngineCardObject; characteristicsKnown: boolean }[]> {
  const discarded: { card: EngineCardObject; characteristicsKnown: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const cards = player.hand.filter(
      (card) => card.cardId !== excludeCardId && (canDiscard?.(card, i) ?? true),
    );
    if (cards.length === 0) {
      if (canDiscard !== undefined) throw new Error('prepared discard cost became unpayable');
      break;
    }
    const chosen =
      canDiscard === undefined
        ? yield* chooseCard(ctx, {
            player: player.id,
            prompt: `Discard a card (${i + 1} of ${count}).`,
            cards,
            type: 'discard',
            verb: 'Discard',
          })
        : (cards[0] ?? null);
    if (chosen === null) throw new Error('engine bug: discard choice was not in hand');
    const card = chosen as EngineCardObject;
    const characteristicsKnown = yield* discardCard(ctx, card, player.id, cause);
    discarded.push({ card, characteristicsKnown });
  }
  return discarded;
}

/** Put a chosen set of hand cards on top of the library (CR 701.7). */
function* putFromHandOnLibraryTop(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  count: number,
  anyOrder: boolean,
): GameGen<void> {
  const selected: EngineCardObject[] = [];
  const limit = Math.min(Math.max(0, count), player.hand.length);
  for (let i = 0; i < limit; i++) {
    const chosen = yield* chooseCard(ctx, {
      player: player.id,
      prompt: `Put a card from your hand on top (${i + 1} of ${limit}).`,
      cards: player.hand,
      type: 'putFromHand',
      verb: 'Put on top',
    });
    if (chosen === null) break;
    const moved = yield* moveObject(ctx, chosen as EngineCardObject, {
      zone: 'library',
      libraryPosition: 'bottom',
    });
    if (moved !== null) selected.push(moved as EngineCardObject);
  }
  if (selected.length === 0) return;
  for (const card of selected) removeFromCurrentZone(ctx, card);
  const ordered = anyOrder
    ? yield* orderForLibrary(ctx, source, player, selected, 'top')
    : selected;
  player.library.unshift(...ordered);
}

/** Discard cards chosen by the game's seeded PRNG (CR 701.8a). */
function* discardAtRandomCards(
  ctx: GameContext,
  player: EnginePlayerState,
  count: number,
): GameGen<void> {
  for (let i = 0; i < count; i++) {
    if (player.hand.length === 0) break;
    const card = player.hand[ctx.rng.nextInt(player.hand.length)];
    if (card === undefined) break;
    yield* discardCard(ctx, card, player.id);
  }
}

/**
 * Pay the non-mana components of a spell's additional casting cost. Mana components are folded
 * into the normal payment plan before this generator is called.
 */
export function* paySpellAdditionalCosts(
  ctx: GameContext,
  player: EnginePlayerState,
  costs: readonly AbilityCost[],
  sourceCardId: string,
  _sourceInHand: boolean,
  announcedX = 0,
  preparedChoices?: readonly SpellPaymentChoice[],
): GameGen<void> {
  function* pickCost<T extends EngineCardObject | EnginePermanent>(
    spec: ChooseCardSpec<T>,
  ): GameGen<T | null> {
    if (preparedChoices !== undefined) return spec.cards[0] ?? null;
    return yield* chooseCard(ctx, spec);
  }
  const assigned = (objectId: ObjectId, costIndex: number, ordinal = 0): boolean =>
    preparedChoices === undefined ||
    preparedChoices.some(
      (choice) =>
        choice.costIndex === costIndex &&
        choice.ordinal === ordinal &&
        choice.objectId === objectId,
    );
  const orderedCosts = [...costs.entries()];
  // CR 601.2h permits costs in any order. Tap a shared permanent before sacrificing it.
  if (preparedChoices !== undefined)
    orderedCosts.sort(
      (a, b) => Number(b[1].kind === 'tapOther') - Number(a[1].kind === 'tapOther'),
    );
  for (const [costIndex, cost] of orderedCosts) {
    switch (cost.kind) {
      case 'returnUnblockedAttacker': {
        if (ctx.state.currentTurnPlayer !== player.id || ctx.state.step !== 'declareBlockers')
          throw new Error('Sneak requires your declare blockers step');
        const cards = ctx.state.battlefield.filter(
          (perm) =>
            perm.controllerId === player.id &&
            perm.attacking !== null &&
            perm.blockedByOrdered.length === 0 &&
            computeCharacteristics(ctx, perm).types.includes('Creature') &&
            assigned(perm.id, costIndex),
        );
        const chosen = yield* pickCost({
          player: player.id,
          cards,
          type: 'returnSneakCost',
          verb: 'Return to hand',
          prompt: 'Return an unblocked attacker you control to its owner’s hand as the Sneak cost.',
        });
        if (chosen === null) throw new Error('Sneak return cost is not payable');
        yield* moveObject(ctx, chosen, { zone: 'hand' });
        break;
      }

      case 'discardCard':
        yield* discardCards(
          ctx,
          player,
          cost.count ?? 1,
          sourceCardId,
          preparedChoices === undefined
            ? undefined
            : (card, ordinal) => assigned(card.id, costIndex, ordinal),
          'cost',
        );
        break;
      case 'exileOtherCardsFromGraveyard': {
        for (let i = 0; i < cost.count; i++) {
          const options = player.graveyard.filter(
            (card) => card.cardId !== sourceCardId && assigned(card.id, costIndex, i),
          );
          if (options.length === 0)
            throw new Error('engine bug: exile-from-graveyard cost became unpayable');
          const chosen = yield* pickCost({
            player: player.id,
            prompt:
              player.id +
              ': choose a card to exile from your graveyard as a spell cost (' +
              (i + 1) +
              ' of ' +
              cost.count +
              ').',
            cards: options,
            type: 'exile',
            verb: 'Exile',
          });
          if (chosen === null)
            throw new Error('engine bug: exile-from-graveyard choice was invalid');
          const card = chosen as EngineCardObject;
          emit(
            ctx,
            'exile',
            { player: player.id, name: card.name, cardId: card.cardId },
            player.id,
          );
          yield* moveObject(ctx, card, { zone: 'exile' });
        }
        break;
      }
      case 'exileCardFromHand': {
        const count = cost.count ?? 1;
        for (let i = 0; i < count; i++) {
          const options = player.hand.filter(
            (card) =>
              card.cardId !== sourceCardId &&
              assigned(card.id, costIndex, i) &&
              selectMatches(cardZoneCandidate(ctx, card, player.id), cost.selector, {
                cardId: sourceCardId,
                controllerId: player.id,
              }),
          );
          if (options.length === 0)
            throw new Error('engine bug: exile-from-hand cost became unpayable');
          const chosen = yield* pickCost({
            player: player.id,
            prompt: player.id + ': choose a card to exile from hand as a spell cost.',
            cards: options,
            type: 'exile',
            verb: 'Exile',
          });
          if (chosen === null) throw new Error('engine bug: exile-from-hand choice was invalid');
          const card = chosen as EngineCardObject;
          emit(
            ctx,
            'exile',
            { player: player.id, name: card.name, cardId: card.cardId },
            player.id,
          );
          yield* moveObject(ctx, card, { zone: 'exile' });
        }
        break;
      }
      case 'payLife':
        payLife(ctx, player, cost.amount);
        break;
      case 'payLifeValue':
        payLife(
          ctx,
          player,
          evaluateValueIn(ctx, cost.amount, {
            controllerId: player.id,
            sourceCardId,
            x: announcedX,
          }),
        );
        break;
      case 'tapOther': {
        const options = ctx.state.battlefield.filter(
          (candidate) =>
            candidate.controllerId === player.id &&
            !candidate.tapped &&
            assigned(candidate.id, costIndex) &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: sourceCardId,
              controllerId: player.id,
            }),
        );
        if (options.length === 0)
          throw new Error('engine bug: spell additional tap cost became unpayable');
        const chosen = yield* pickCost({
          player: player.id,
          prompt: player.id + ': choose a permanent to tap as a spell cost.',
          cards: options,
          type: 'tapCost',
          verb: 'Tap',
        });
        if (chosen === null) throw new Error('engine bug: spell additional tap choice was invalid');
        const permanent = chosen as EnginePermanent;
        permanent.tapped = true;
        queueTriggersForObject(ctx, 'becomesTapped', permanent);
        emit(ctx, 'tap', { name: permanent.name, cardId: permanent.cardId }, player.id);
        break;
      }
      case 'sacrificeOther': {
        const count = cost.count ?? 1;
        for (let i = 0; i < count; i++) {
          const options = ctx.state.battlefield.filter(
            (candidate) =>
              candidate.controllerId === player.id &&
              assigned(candidate.id, costIndex, i) &&
              matchesSelector(ctx, candidate, cost.selector, {
                cardId: sourceCardId,
                controllerId: player.id,
              }),
          );
          if (options.length === 0)
            throw new Error('engine bug: spell additional sacrifice cost became unpayable');
          const chosen = yield* pickCost({
            player: player.id,
            prompt:
              player.id +
              ': choose a permanent to sacrifice as a spell cost (' +
              (i + 1) +
              ' of ' +
              count +
              ').',
            cards: options,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (chosen === null)
            throw new Error('engine bug: spell additional sacrifice choice was invalid');
          const permanent = chosen as EnginePermanent;
          emit(ctx, 'sacrifice', { name: permanent.name, cardId: permanent.cardId }, player.id);
          yield* moveObject(ctx, permanent, { zone: 'graveyard', reason: 'sacrifice' });
        }
        break;
      }
      case 'mana':
        break;
      default:
        throw new Error('engine bug: unsupported spell additional cost ' + cost.kind);
    }
  }
}
/**
 * Is `target` (an object id or player id) still a legal target (CR 608.2b)?
 *
 * Shares `permanentMatchesKind` with `computeTargetOptions` deliberately: these two encode the
 * same rules at two different moments, and any drift between them means the engine offers a
 * target it will then refuse to act on.
 */
export function isTargetStillLegal(
  ctx: GameContext,
  targetId: ObjectId,
  spec: TargetKind | TargetSpec,
  spellControllerId: PlayerId,
  source?: TargetingSource,
  eventPlayerId?: PlayerId,
  sourceCardId = '',
  chosenTargets?: readonly ObjectId[],
): boolean {
  return targetIsLegal(ctx, spec, targetId, {
    controllerId: spellControllerId,
    sourceCardId,
    phase: 'resolution',
    ...targetingSourceFields(source),
    ...(eventPlayerId === undefined ? {} : { eventPlayerId }),
    ...(chosenTargets === undefined ? {} : { chosenTargets }),
  });
}

/**
 * Can `entry` be countered right now? Two independent sources, both DEBT-style — "still a legal
 * target, but the consequence is prevented":
 *
 * - `Ability.cantBeCountered` is fixed at cast time (Last March of the Ents), baked onto the
 *   `Ability` the spell carries.
 * - `spellProtectedFromCounter` is a STATE-DEPENDENT rule (Rhythm of the Wild's "creature spells
 *   you control can't be countered"), re-checked here rather than at cast time because its
 *   source could have left the battlefield since. Only spells qualify — an activated or
 *   triggered ability is never a "spell" the printed template could mean.
 */
function protectedFromCounter(ctx: GameContext, entry: EngineStackObject): boolean {
  if (entry.ability?.cantBeCountered === true) return true;
  if (entry.kind !== 'spell') return false;
  return spellProtectedFromCounter(
    ctx,
    entry.controllerId,
    entry.sourceOracleId,
    spellDefinitionOf(ctx, entry),
  );
}

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n}`;

/**
 * "Double the number of each kind of counter you have": every player counter kind, energy and
 * poison as well as the named ones such as experience (CR 122.1, 122.8). Each kind that grows is
 * logged as proliferate logs it.
 */
function doubleEachPlayerCounter(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  actorId: PlayerId,
): void {
  const logCounter = (counter: string, added: number, total: number) =>
    emit(
      ctx,
      'counters',
      { source: source.name, target: player.id, counter, added, total },
      actorId,
    );
  const energy = player.energy;
  if (energy > 0) {
    player.energy = energy * 2;
    emit(ctx, 'energy', { player: player.id, amount: energy, total: player.energy }, actorId);
  }
  const poison = player.poisonCounters;
  if (poison > 0) {
    player.poisonCounters = poison * 2;
    logCounter('poison', poison, player.poisonCounters);
  }
  const named = player.counters ?? {};
  for (const [kind, have] of Object.entries(named)) {
    if (have <= 0) continue;
    named[kind] = have * 2;
    logCounter(kind, have, have * 2);
  }
}

/**
 * One requested counter placement in a simultaneous batch (Agitator Ant, CR 608.2d): several
 * placements planned together against the ONE pre-placement board state, applied together, and
 * observed together by one `countersPut` event — not a loop of `addCounters` calls, which would
 * let a later placement's trigger observe an earlier placement's counters.
 */
interface CounterPlacement {
  perm: EnginePermanent;
  counter: string;
  count: number;
  /** Whose "put counters this way" event each placement is (`countersPut` rows' `playerId`). */
  placingPlayerId: PlayerId;
}

/**
 * Place every requested batch of counters as one simultaneous event (CR 608.2d): plan ALL
 * positive requested amounts and their replacements from the PRE-placement state, capture the
 * before-counts and expire counter-bound attack restrictions correctly, then apply every
 * mutation and timestamp BEFORE any `countersPut` trigger observes anything, one counters log
 * per placement, ONE batched `countersPut` event whose rows name each actual placer, and then
 * the existing counter-threshold triggers read against the batch's before/final values.
 *
 * Returns the amounts ACTUALLY placed per selected permanent: zero for a nonpositive request,
 * zero for a placement fully replaced to zero (which still logs its 0, like the single path,
 * but is never a row of the batched event — no counters were put).
 */
function addCounterPlacements(
  ctx: GameContext,
  source: EffectSource,
  placements: readonly CounterPlacement[],
): Map<ObjectId, number> {
  const planned: {
    placement: CounterPlacement;
    before: number;
    adjustedCount: number;
  }[] = [];
  // Planning reads only pre-placement state: replacements were consulted before any placement
  // in this batch moved anything (they are counters "put ... this way", one batch).
  for (const placement of placements) {
    if (placement.count <= 0) continue;
    expireCounterBoundAttackRestrictions(placement.perm);
    planned.push({
      placement,
      before: counterCount(placement.perm.counters, placement.counter),
      adjustedCount: counterAmountAfterReplacements(
        ctx,
        placement.perm,
        placement.counter,
        placement.count,
      ),
    });
  }
  for (const { placement, adjustedCount } of planned) {
    if (adjustedCount <= 0) continue;
    setCounterCount(
      placement.perm.counters,
      placement.counter,
      counterCount(placement.perm.counters, placement.counter) + adjustedCount,
    );
    placement.perm.counterTimestamps ??= {};
    setCounterCount(placement.perm.counterTimestamps, placement.counter, ctx.state.nextTimestamp++);
  }
  for (const { placement, adjustedCount } of planned) {
    emit(ctx, 'counters', {
      source: source.name,
      target: placement.perm.name,
      targetCardId: placement.perm.cardId,
      counter: placement.counter,
      added: adjustedCount,
      total: counterCount(placement.perm.counters, placement.counter),
    });
  }
  const actual = new Map<ObjectId, number>();
  for (const placement of placements) actual.set(placement.perm.id, 0);
  // One batched event: aggregate "one or more counters are put" triggers read every placement.
  queueTriggersForEvent(
    ctx,
    'countersPut',
    planned
      .filter(({ adjustedCount }) => adjustedCount > 0)
      .map(({ placement, adjustedCount }) => {
        actual.set(placement.perm.id, adjustedCount);
        return {
          permanent: placement.perm,
          playerId: placement.placingPlayerId,
          counterKinds: [placement.counter],
        };
      }),
  );
  for (const { placement, before, adjustedCount } of planned) {
    if (adjustedCount <= 0) continue;
    const def = ctx.defs.get(placement.perm.oracleId);
    for (const threshold of def?.counterThresholdTriggers ?? []) {
      const final = counterCount(placement.perm.counters, placement.counter);
      if (
        threshold.counter !== placement.counter ||
        before >= threshold.threshold ||
        final < threshold.threshold
      )
        continue;
      const copies = 1 + additionalTypedTriggerCopies(ctx, placement.perm);
      for (let copy = 0; copy < copies; copy++) {
        ctx.state.pendingTriggers.push({
          controllerId: placement.perm.controllerId,
          sourceCardId: placement.perm.cardId,
          sourceObjectId: placement.perm.id,
          sourceOracleId: placement.perm.oracleId,
          sourceName: placement.perm.name,
          ability: threshold.ability,
        });
      }
    }
  }
  return actual;
}

/**
 * Put counters on a permanent. `+1/+1` and `-1/-1` feed layer 7c through `perm.counters`, so
 * effective P/T follows immediately; pairs of them annihilate at the next SBA check (CR 704.5r).
 * A single placement is the one-placement case of the simultaneous batch, with the ability's
 * controller as the placing player; the return value stays "counters actually placed".
 */
function addCounters(
  ctx: GameContext,
  source: EffectSource,
  perm: EnginePermanent,
  counter: string,
  count: number,
): number {
  const actual = addCounterPlacements(ctx, source, [
    { perm, counter, count, placingPlayerId: source.controllerId },
  ]);
  return actual.get(perm.id) ?? 0;
}

/**
 * "Each player may put N <counter> counters on a creature they control. Goad each creature that
 * had counters put on it this way." — the whole clause is one resolution in APNAP order
 * (CR 101.4): the ACTIVE player starts, not the ability's controller.
 *
 * Every choice is collected before any counter moves (CR 608.2d): "each player may" is one
 * instruction, so no player's choice can see what another player's choice received. The
 * choices are each player's own, made public as they are made; a player with no creature is
 * not asked. A player who declines puts nothing. The goad is always applied by the ability's
 * controller (CR 701.15a), never by the chooser merely for choosing, and only on creatures
 * that actually received counters: a placement
 * fully replaced to zero put none.
 */
function* eachPlayerMayPutCountersAndGoad(
  ctx: GameContext,
  source: EffectSource,
  goaderId: PlayerId,
  effect: Extract<Effect, { op: 'eachPlayerMayPutCountersAndGoad' }>,
  count: number,
): GameGen<void> {
  const choices: { playerId: PlayerId; perm: EnginePermanent }[] = [];
  for (const player of playersInApnapOrder(ctx)) {
    // "on a creature they control": each player picks among the creatures THEY control as this
    // instruction resolves — no target slots, so hexproof and shroud do not distinguish
    // anything; and a player controlling no creature is not prompted at all.
    const creatures = ctx.state.battlefield.filter(
      (perm) =>
        perm.controllerId === player.id &&
        computeCharacteristics(ctx, perm).types.includes('Creature'),
    );
    if (creatures.length === 0) continue;
    const picked = yield* chooseCard(ctx, {
      player: player.id,
      prompt: `${source.name}: put ${count} ${effect.counter} counters on a creature you control, or put none.`,
      cards: creatures,
      type: 'putCounters',
      verb: 'Choose',
      describe: (perm) => `Put ${count} ${effect.counter} counters on ${perm.name}`,
      decline: { type: 'decline', description: 'Put no counters', verb: 'Decline' },
    });
    // The choice is public the moment it is made (druidPurification's precedent), with the
    // chooser as the acting player. No raw card payload: the standard picker reads the choice
    // back by index, which keeps the option reachable for hidden-zone picks too.
    emit(
      ctx,
      'permanentChoice',
      { source: source.name, name: picked?.name ?? null, objectId: picked?.id ?? null },
      player.id,
    );
    if (picked !== null) choices.push({ playerId: player.id, perm: picked });
  }
  // All choices are frozen before the batch, and each frozen object is rechecked on the
  // battlefield as the batch is assembled: a creature that left the battlefield between the
  // choice and the counters is a new object (CR 400.7) and receives nothing.
  const placements: CounterPlacement[] = [];
  for (const { playerId, perm } of choices) {
    const current = findPermanent(ctx, perm.id);
    if (current === undefined) continue;
    placements.push({
      perm: current,
      counter: effect.counter,
      count,
      placingPlayerId: playerId,
    });
  }
  const placed = addCounterPlacements(ctx, source, placements);
  for (const { perm } of choices) {
    if ((placed.get(perm.id) ?? 0) <= 0) continue;
    const goaded = findPermanent(ctx, perm.id);
    if (goaded === undefined) continue;
    addGoadRequirement(ctx, goaded, goaderId);
    emit(ctx, 'goad', { target: goaded.name, source: source.name });
  }
}

/**
 * The permanents a selector-scoped until-end-of-turn effect applies to, fixed once here.
 *
 * CR 611.2c: a continuous effect created by a resolving spell or ability determines its set of
 * affected objects at resolution, and that set never changes afterwards — unlike a static
 * ability, which re-derives its set on every layer pass. A creature that enters after Overrun
 * resolves is not pumped; one that leaves and returns comes back as a new object and is not
 * pumped either. The engine gets this for free by storing card ids rather than the selector.
 */
function affectedBy(
  ctx: GameContext,
  source: EffectSource,
  selector: Selector,
  eventPlayerId?: PlayerId,
): EnginePermanent[] {
  return selectPermanents(ctx, selector, {
    cardId:
      source.id !== undefined && !ctx.state.battlefield.some((p) => p.id === source.id)
        ? ''
        : source.cardId,
    controllerId: source.controllerId,
    ...(eventPlayerId !== undefined ? { eventPlayerId } : {}),
  });
}

/** "Grizzly Bears, Llanowar Elves get +3/+3 until end of turn" — the locked-in set, by name. */
function describeMassEffect(affected: EnginePermanent[], clause: string): string {
  return `${affected.map((p) => p.name).join(', ')} ${clause} until end of turn`;
}

/** A public resolution choice, independent of player targeting restrictions. */
function* chooseOpponentForSharedEffect(
  ctx: GameContext,
  source: EffectSource,
  chooserId: PlayerId,
  purpose: string,
): GameGen<PlayerId | null> {
  const eligible = opponentsOf(ctx, chooserId);
  if (eligible.length === 0) return null;
  const outcome = yield {
    decisionType: 'general',
    player: chooserId,
    prompt: `${source.name}: choose an opponent ${purpose}`,
    options: eligible.map((player) =>
      playerOption(player.id, player.id, {
        type: 'choosePlayer',
        description: `${player.id} ${purpose}`,
        verb: 'Choose',
      }),
    ),
  };
  const chosen = eligible[outcome.index];
  if (chosen === undefined) throw new Error('engine bug: invalid mandatory opponent choice');
  emit(ctx, 'chooseOpponent', { source: source.name, player: chosen.id }, chooserId);
  return chosen.id;
}

/**
 * "An opponent gains control of …" (Wishclaw Talisman) — the recipient is not a target but a
 * choice made as the effect resolves (CR 608.2d: the ability's controller chooses, the same
 * player who cast the spell in a spell's case). The eligible set is the LIVING opponents of that
 * controller, not of the permanent: an earlier control change on the permanent cannot rewrite who
 * is asked. Nothing about the choice is a targeting restriction, so a player with hexproof or
 * shroud is still offered; a player who has left the game is not eligible.
 *
 * Returns null when no opponent is left — the caller performs nothing, and the rest of the
 * resolution (already done, e.g. the search and shuffle) stands (CR 608.2h).
 */
function* chooseOpponentRecipient(
  ctx: GameContext,
  source: EffectSource,
  chooserId: PlayerId,
  permanentName: string,
): GameGen<PlayerId | null> {
  const eligible = ctx.state.players.filter((player) => !player.hasLost && player.id !== chooserId);
  if (eligible.length === 0) return null;
  const outcome = yield {
    decisionType: 'general',
    player: chooserId,
    prompt: `${source.name}: choose an opponent to gain control of ${permanentName}`,
    options: eligible.map((player) =>
      playerOption(player.id, player.id, {
        type: 'choosePlayer',
        description: `${player.id} gains control of ${permanentName}`,
        verb: 'Give control to',
      }),
    ),
  };
  return eligible[outcome.index]?.id ?? null;
}

/**
 * Resolve a control-change duration at runtime. The source-bound IR value stays declarative
 * ('whileSourceOnBattlefield') and becomes the source's exact ObjectId here: an effect whose
 * source is not ON the battlefield when its duration starts gives no effect at all (CR 611.2b),
 * and a later blink incarnation carries a new id that no recorded effect ever tracks (CR 400.7).
 */
function resolveControlChangeDuration(
  ctx: GameContext,
  source: EffectSource,
  ir: GainControlIRDuration | undefined,
): ControlChangeDuration | null {
  switch (ir) {
    case 'untilEndOfTurn':
      return { kind: 'untilEndOfTurn' };
    case 'whileSourceOnBattlefield': {
      const id = source.id ?? source.lastKnownFacts?.objectId;
      return id !== undefined && ctx.state.battlefield.some((p) => p.id === id)
        ? { kind: 'whileSourceOnBattlefield', sourceObjectId: id }
        : null;
    }
    default:
      // Omitted means permanent.
      return { kind: 'permanent' };
  }
}

/**
 * Resolve one Cascade instance. The first nonland card with mana value below the source spell's
 * mana value is the hit; every revealed card that remains in exile is randomized to the bottom.
 */
function* resolveCascade(
  ctx: GameContext,
  source: EffectSource,
  sourceManaValue: number,
): GameGen<void> {
  const controller = playerById(ctx, source.controllerId);
  const exiled: EngineCardObject[] = [];
  let hit: EngineCardObject | undefined;

  for (;;) {
    const top = controller.library[0];
    if (top === undefined) break;
    const moved = (yield* moveObject(ctx, top, { zone: 'exile' })) as EngineCardObject | null;
    if (moved === null) break;
    exiled.push(moved);

    const def = getDefByOracleId(ctx, moved.oracleId, moved.name);
    if (def.types.includes('Land')) continue;
    if (spellManaValue(def, undefined) < sourceManaValue) {
      hit = moved;
      break;
    }
  }

  if (hit !== undefined) {
    const hitDef = getDefByOracleId(ctx, hit.oracleId, hit.name);
    requireModeled(hitDef, 'Cascade reveal');
    if (freeCardIsCastable(ctx, hit, controller.id, sourceManaValue)) {
      const outcome = yield {
        decisionType: 'general',
        player: controller.id,
        prompt: source.name + ': cast the Cascade hit without paying its mana cost?',
        options: [
          { type: 'castFree', description: 'Cast ' + hit.name + ' without paying its mana cost' },
          { type: 'decline', description: 'Leave ' + hit.name + ' in exile' },
        ],
      };
      if (outcome.index === 0) yield* resolveFreeCard(ctx, hit, controller.id, sourceManaValue);
    }
  }

  const remaining = exiled
    .map((card) => ctx.state.exile.find((candidate) => candidate.cardId === card.cardId))
    .filter((card): card is EngineCardObject => card !== undefined);
  ctx.rng.shuffle(remaining);
  for (const card of remaining) {
    const current = ctx.state.exile.find((candidate) => candidate.cardId === card.cardId);
    if (current !== undefined)
      yield* moveObject(ctx, current, { zone: 'library', libraryPosition: 'bottom' });
  }
}

/** Resolve Rebound's one-shot cast permission when its next-upkeep trigger resolves. */
function* resolveReboundCastFromExile(
  ctx: GameContext,
  source: EffectSource,
  controllerId: PlayerId,
): GameGen<void> {
  const card = ctx.state.exile.find(
    (candidate) => candidate.cardId === source.cardId && candidate.reboundCastBy === controllerId,
  );
  if (card === undefined) return;
  delete card.reboundCastBy;
  if (!freeCardIsCastable(ctx, card, controllerId)) return;
  const outcome = yield {
    decisionType: 'general' as const,
    player: controllerId,
    prompt: source.name + ': cast this card from exile without paying its mana cost?',
    options: [
      { type: 'castFree', description: 'Cast ' + card.name + ' without paying its mana cost' },
      { type: 'decline', description: 'Leave ' + card.name + ' in exile' },
    ],
  };
  if (outcome.index !== 0) return;
  yield* resolveFreeCard(ctx, card, controllerId);
}

/**
 * Execute an ability's effects with pre-chosen targets (ADR 0004). Targeted primitives
 * reference a slot index into `ability.targets`; a slot whose target became illegal is
 * skipped (CR 608.2b). The all-illegal "fizzle" case is handled by the caller before this.
 *
 * `triggerObjectCardId` supplies the `'triggerObject'` referent — the attacking creature in
 * "whenever a Dragon you control attacks, IT gains double strike". Not a target: never
 * announced, never legality-checked, and it cannot fizzle the ability (CR 115.10a).
 */
export function* executeAbility(
  ctx: GameContext,
  source: EffectSource,
  ability: Ability,
  targets: ObjectId[],
  triggerObjectCardId?: string,
  /** X, plus what the firing event contributed — everything a `Value` needs beyond the board. */
  extraScope?: Omit<ValueScope, 'controllerId' | 'sourceCardId'>,
  /** Chosen ids for a variable-count target slot (`TargetSpec.count`), keyed by slot index. */
  countTargets?: Record<number, ObjectId[]>,
  /** The announced division of a `dealDamageDivided` effect's total, keyed by object id. */
  divisionAmounts?: Record<ObjectId, number>,
): GameGen<void> {
  const resolutionObjectMoves = ctx.resolutionObjectMoves ?? new Map<ObjectId, ObjectId | null>();
  const resolutionObjectFacts = ctx.resolutionObjectFacts ?? new Map<ObjectId, ObjectFacts>();
  // Share the game itself, but carry transition tracking only through this effect's calls.
  // A caller retaining the original context cannot alter these bindings during a yield.
  ctx = { ...ctx, resolutionObjectMoves, resolutionObjectFacts };
  const movedReferent = (id: ObjectId): ObjectId | null => {
    let current: ObjectId | null = id;
    while (current !== null && resolutionObjectMoves.has(current)) {
      current = resolutionObjectMoves.get(current) ?? null;
    }
    return current;
  };
  const controller = playerById(ctx, source.controllerId);
  // Tokens this resolution created, for "attach it to the token" later in the same ability.
  const createdThisResolution: EnginePermanent[] = [];

  // A modal ability's mode belongs to its announcement (CR 700.2a-b): triggers choose it in
  // `pushTriggerOnStack`, battlefield activations in the option `computePriorityOptions` offers,
  // and spells in the cast path — each folds the chosen effects in before the ability reaches
  // the stack. This is only a defensive fallback for a path that still carries `modes` here (a
  // modal hand or graveyard activation, which no modeled card has), so the choice is at least
  // asked rather than silently doing nothing.
  if (ability.kind !== 'spell' && ability.modes !== undefined) {
    const selections = abilityModeSelections(ability.modes);
    if (selections.length === 0) return;
    const outcome = yield {
      decisionType: 'general',
      player: controller.id,
      prompt: `${source.name}: choose modes.`,
      options: selections.map((selection) => ({
        type: 'chooseModes',
        description: selection
          .map((index) => ability.modes?.options[index]?.description ?? `mode ${index + 1}`)
          .join('; '),
      })),
    };
    const selected = selections[outcome.index] ?? selections[0];
    if (selected === undefined) return;
    const effects = selected.flatMap((index) => ability.modes?.options[index]?.effects ?? []);
    const { modes: _modes, ...abilityWithoutModes } = ability;
    yield* executeAbility(
      ctx,
      source,
      { ...abilityWithoutModes, effects },
      targets,
      triggerObjectCardId,
      extraScope,
      countTargets,
      divisionAmounts,
    );
    return;
  }

  const scope: ValueScope = {
    controllerId: source.controllerId,
    sourceCardId: source.cardId,
    ...(source.id === undefined ? {} : { sourceObjectId: source.id }),
    ...(source.lastKnownFacts === undefined ? {} : { sourceFacts: source.lastKnownFacts }),
    ...(source.resolvingStackObject === undefined
      ? {}
      : {
          resolvingSourceManaValue: spellManaValue(
            spellDefinitionOf(ctx, source.resolvingStackObject),
            source.resolvingStackObject.announcedX,
          ),
          sourceCastState: {
            wasKicked:
              source.resolvingStackObject.wasKicked === true ||
              source.resolvingStackObject.kicked === true,
            announcedX: source.resolvingStackObject.announcedX ?? 0,
            escaped: source.resolvingStackObject.escaped === true,
            castDuringOwnMainPhase: source.resolvingStackObject.castDuringOwnMainPhase === true,
          },
        }),
    ...(targets !== undefined ? { targets } : {}),
    ...(triggerObjectCardId !== undefined ? { triggerObjectCardId } : {}),
    ...(source.resolvingStackObject?.optionalCostCounts !== undefined
      ? { resolvingOptionalCostCounts: source.resolvingStackObject.optionalCostCounts }
      : {}),
    ...(extraScope ?? {}),
  };
  /**
   * The object an effect names as the source of its damage. "That creature deals damage" still
   * happens once the creature has left, with its last known characteristics (CR 608.2h, 113.7a).
   */
  const damageSourceOf = (r: EffectRef): EffectSource | undefined => {
    const id = ref(r);
    const permanent = id === null ? undefined : findPermanent(ctx, id);
    if (permanent !== undefined) return permanentSource(permanent);
    if (r !== 'triggerObject') return undefined;
    const facts = eventObjectFacts(ctx, scope);
    if (facts === undefined || facts.name === undefined || facts.oracleId === undefined)
      return undefined;
    return {
      id: facts.objectId,
      cardId: facts.candidate.cardId,
      name: facts.name,
      oracleId: facts.oracleId,
      controllerId: facts.candidate.controllerId as PlayerId,
      lastKnownColors: facts.candidate.colors,
      lastKnownDamageKeywords: (['deathtouch', 'lifelink', 'infect'] as const).filter((keyword) =>
        facts.candidate.keywords.includes(keyword),
      ),
    };
  };
  /** Evaluate an effect's `Value` amount in this ability's scope. */
  const amountOf = (value: Value | number): number => {
    return typeof value === 'number' ? value : evaluateValueIn(ctx, value, scope);
  };
  /** Resolve an explicitly routed draw recipient without silently falling back to the controller. */
  const drawRecipient = (player: 'controller' | 'eventPlayer' | undefined) => {
    if (player !== 'eventPlayer') return controller;
    if (scope.eventPlayerId === undefined) {
      throw new Error(`engine bug: ${source.name} used eventPlayer draw without an event player`);
    }
    return playerById(ctx, scope.eventPlayerId);
  };
  /**
   * Life actually lost by opponents during THIS resolution, for a following "you gain life
   * equal to the life lost this way" clause (CR 118.3 — the gain tracks the real loss, not the
   * requested amount). Resolution-scoped by construction: a new `executeAbility` call starts
   * over at 0.
   */
  let lifeLostThisWay = 0;
  /** Stable card identities captured by one effect for later effects in this resolution. */
  const effectBindings = new Map<string, string[]>();

  // Initial legality (CR 608.2b) and identity (CR 400.7) are separate. A physical
  // cardId is never enough to recover a vanished target. Only public-zone transitions
  // performed by this effect may update its referent (CR 400.7j).
  /** Players and stack objects keep their announced identity, including after countering. */
  const refStableIdCache = new Map<number, ObjectId>();
  /** Controller captured when a target slot is first resolved, before an earlier effect moves it. */
  const refControllerCache = new Map<number, PlayerId | undefined>();

  /**
   * CR 608.2b recheck of one target, with the same protection (CR 702.16) and event-player
   * context the target was chosen under — otherwise a creature that gained protection from the
   * source's color in response would still be hit.
   */
  const resolutionTargets =
    source.resolutionTargets ??
    captureResolutionTargets(ctx, ability.targets, targets, countTargets ?? {}, {
      controllerId: source.controllerId,
      sourceCardId: source.cardId,
      sourceTraits: effectSourceTraits(ctx, source),
      sourceKind: source.resolvingStackObject === undefined ? 'ability' : 'spell',
      ...(source.lastKnownFacts === undefined ? {} : { sourceFacts: source.lastKnownFacts }),
      ...(scope.eventPlayerId === undefined ? {} : { eventPlayerId: scope.eventPlayerId }),
    });
  source = { ...source, resolutionTargets };
  for (const [slot, id] of targets.entries()) {
    const player = ctx.state.players.find((candidate) => candidate.id === id);
    const stack = ctx.state.stack.find((entry) => entry.id === id);
    const object = findObjectById(ctx, id) as { controllerId?: PlayerId } | undefined;
    refControllerCache.set(slot, player?.id ?? stack?.controllerId ?? object?.controllerId);
    if (player !== undefined || stack !== undefined) refStableIdCache.set(slot, id);
  }
  const stillLegal = (id: ObjectId, spec: TargetSpec, slot?: number): boolean =>
    (slot === undefined
      ? resolutionTargets.legality.get(spec)
      : resolutionTargets.slotLegality.get(slot)
    )?.get(id) === true;
  // Legacy slot-based effects and scoped Values must also skip initially illegal targets.
  // Preserve indexes; removing a target must not shift another target into its slot.
  scope.targets = targets.map((id, slot) => {
    const spec = ability.targets[slot];
    return spec !== undefined && stillLegal(id, spec, slot) ? id : '';
  });
  if (countTargets !== undefined) {
    countTargets = Object.fromEntries(
      Object.entries(countTargets).map(([slot, ids]) => {
        const spec = ability.targets[Number(slot)];
        return [
          slot,
          spec === undefined ? [] : ids.filter((id) => stillLegal(id, spec, Number(slot))),
        ];
      }),
    );
  }

  /**
   * The source permanent "it" names ("sacrifice it", "it fights", "~ gains indestructible"): the
   * very incarnation the ability came from (`source.id`), so a source blinked in response is a
   * new object the ability no longer affects (CR 400.7).
   */
  const sourcePermanent = (): EnginePermanent | undefined =>
    ctx.state.battlefield.find(
      (permanent) =>
        permanent.cardId === source.cardId &&
        (source.id === undefined || permanent.id === movedReferent(source.id)),
    );

  /**
   * The chosen permanents of a variable-count slot that are still legal targets, all decided
   * before any of them is affected (CR 608.2b): removing one must not change whether another
   * was legal as resolution began. A slot with a collective budget (Kairi's total mana value 6
   * or less) whose remaining legal targets now exceed it affects none of them.
   */
  const chosenReferents = (slot: number): ObjectId[] =>
    (countTargets?.[slot] ?? []).flatMap((id) => {
      const currentId = movedReferent(id);
      return currentId === null ? [] : [currentId];
    });
  const legalChosenPermanents = (slot: number): EnginePermanent[] => {
    // A per-player spec (Nils) was expanded into one slot per player; naming it names them all.
    const slots = ability.targets.flatMap((candidate, index) =>
      index === slot || candidate.slotGroup === slot ? [index] : [],
    );
    return slots.flatMap((index) => {
      const spec = ability.targets[index];
      if (spec === undefined) return [];
      return (countTargets?.[index] ?? []).flatMap((id) => {
        if (!stillLegal(id, spec, index)) return [];
        const currentId = movedReferent(id);
        const permanent = currentId === null ? undefined : findPermanent(ctx, currentId);
        return permanent === undefined ? [] : [permanent as EnginePermanent];
      });
    });
  };

  /** Resolve an effect referent to an object id, or null when it is gone / no longer legal. */
  const ref = (r: EffectRef): ObjectId | null => {
    if (typeof r === 'object') {
      // The controller of a targeted permanent, as of resolution (a player id, like 'eventPlayer').
      const permanentId = ref(r.controllerOf);
      const permanent = permanentId === null ? undefined : findPermanent(ctx, permanentId);
      return permanent === undefined ? null : (permanent.controllerId as unknown as ObjectId);
    }
    if (r === 'source') return sourcePermanent()?.id ?? null;
    if (r === 'eventPlayer') {
      if (scope.eventPlayerId === undefined)
        throw new Error(`engine bug: ${source.name} used event player without a binding`);
      return scope.eventPlayerId as unknown as ObjectId;
    }
    if (r === 'attachedToSource') {
      const attachment = sourcePermanent();
      if (attachment === undefined || attachment.attachedTo === null) return null;
      return findPermanent(ctx, attachment.attachedTo)?.id ?? null;
    }
    if (r === 'triggerObject') {
      if (triggerObjectCardId === undefined) {
        throw new Error(`engine bug: ${source.name} used 'triggerObject' with no trigger object`);
      }
      // Gone from the battlefield by resolution: the effect simply does nothing to it. A delayed
      // trigger that remembers the permanent itself also skips a new object of the same card.
      // A trigger that acts on its event object remembers it (`eventObjectId`), so a creature
      // blinked in response is a new object it no longer affects (CR 400.7).
      const pinnedId = extraScope?.triggerObjectId ?? extraScope?.eventObjectId;
      const currentId = pinnedId === undefined ? undefined : movedReferent(pinnedId);
      const perm = ctx.state.battlefield.find(
        (p) => p.cardId === triggerObjectCardId && (pinnedId === undefined || p.id === currentId),
      );
      if (perm === undefined) {
        debug(ctx, 'effect', `${source.name}: trigger object has left the battlefield — skipped`);
        return null;
      }
      return perm.id;
    }
    const id = targets[r];
    const spec = ability.targets[r];
    if (id === undefined || spec === undefined) {
      return null;
    }
    if (!stillLegal(id, spec, r)) {
      debug(ctx, 'effect', `${source.name}: target ${id} illegal — skipped`);
      return null;
    }
    const stableId = refStableIdCache.get(r);
    if (stableId !== undefined) return stableId;
    const targetPlayer = ctx.state.players.find((player) => player.id === id);
    const targetStack = ctx.state.stack.find((entry) => entry.id === id);
    const targetObject = findObjectById(ctx, id) as { controllerId?: PlayerId } | undefined;
    if (!refControllerCache.has(r)) {
      refControllerCache.set(
        r,
        targetPlayer?.id ?? targetStack?.controllerId ?? targetObject?.controllerId,
      );
    }
    // Preserve announced player/stack identities and captured controllers even after a
    // counter instruction removes the stack entry (Arcane Denial's delayed draws).
    if (targetPlayer !== undefined || targetStack !== undefined) {
      refStableIdCache.set(r, id);
      return id;
    }
    const currentId = movedReferent(id);
    return currentId !== null && findObjectById(ctx, currentId) !== undefined ? currentId : null;
  };

  for (const effect of ability.effects ?? []) {
    switch (effect.op) {
      case 'transformSelf': {
        const current = sourcePermanent();
        if (current !== undefined) transformPermanent(ctx, current);
        break;
      }
      case 'selfToLibraryTop': {
        const current = sourcePermanent();
        // `moveObject` already routes to the OWNER's library, which is what "its owner's
        // library" asks for even when someone else controls the permanent.
        if (current !== undefined)
          yield* moveObject(ctx, current, { zone: 'library', libraryPosition: 'top' });
        break;
      }
      case 'chooseOne': {
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose one.`,
          options: effect.options.map((option) => ({
            type: 'chooseEffect',
            description: option.description,
          })),
        };
        const chosen = effect.options[outcome.index] ?? effect.options[0];
        if (chosen !== undefined) {
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: chosen.effects },
            targets,
            triggerObjectCardId,
            extraScope,
            countTargets,
            divisionAmounts,
          );
        }
        break;
      }
      case 'fight': {
        const firstId = ref(effect.first);
        const secondId = ref(effect.second);
        const first = firstId === null ? undefined : findPermanent(ctx, firstId);
        const second = secondId === null ? undefined : findPermanent(ctx, secondId);
        if (first === undefined || second === undefined || first.id === second.id) break;
        // CR 701.14b: if either is no longer a creature, neither fights.
        if (!isCreaturePermanent(ctx, first) || !isCreaturePermanent(ctx, second)) break;
        const firstPower = effectivePT(ctx, first).power;
        const secondPower = effectivePT(ctx, second).power;
        const firstTraits = combatDamageTraits(ctx, first);
        const secondTraits = combatDamageTraits(ctx, second);
        yield* dealDamageToCreature(ctx, permanentSource(first), second, firstPower, {
          combat: false,
          sourceHasDeathtouch: firstTraits.deathtouch,
          sourceHasLifelink: firstTraits.lifelink,
          sourceHasInfect: firstTraits.infect,
          sourceTraits: firstTraits,
        });
        yield* dealDamageToCreature(ctx, permanentSource(second), first, secondPower, {
          combat: false,
          sourceHasDeathtouch: secondTraits.deathtouch,
          sourceHasLifelink: secondTraits.lifelink,
          sourceHasInfect: secondTraits.infect,
          sourceTraits: secondTraits,
        });
        emit(ctx, 'fight', { source: source.name, first: first.name, second: second.name });
        queueTriggersForObject(ctx, 'fights', first);
        queueTriggersForObject(ctx, 'fights', second);
        break;
      }
      case 'pumpUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        const power = amountOf(effect.power);
        const toughness = amountOf(effect.toughness);
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} gets ${signed(power)}/${signed(toughness)} until end of turn`,
          targetCardIds: [perm.cardId],
          kind: 'ptDelta',
          power,
          toughness,
          timestamp: ctx.state.nextTimestamp++,
        });
        const pt = effectivePT(ctx, perm);
        emit(ctx, 'pump', {
          source: source.name,
          target: perm.name,
          power,
          toughness,
          nowPower: pt.power,
          nowToughness: pt.toughness,
        });
        break;
      }
      case 'creaturesCantBeBlockedThisTurn': {
        ctx.state.creaturesCantBeBlockedThisTurn = true;
        emit(ctx, 'creaturesCantBeBlocked', { source: source.name });
        break;
      }
      case 'cantBeBlockedUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} can't be blocked this turn`,
          targetCardIds: [perm.cardId],
          kind: 'cantBeBlocked',
          timestamp: ctx.state.nextTimestamp++,
        });
        break;
      }
      case 'cantBeBlockedEachChosen': {
        const chosen = legalChosenPermanents(effect.targetSlot);
        if (chosen.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: `${chosen.map((permanent) => permanent.name).join(', ')} can't be blocked this turn`,
            targetCardIds: chosen.map((permanent) => permanent.cardId),
            kind: 'cantBeBlocked',
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        break;
      }
      case 'grantKeywordUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} gains ${effect.keyword} until end of turn`,
          targetCardIds: [perm.cardId],
          kind: 'grantKeyword',
          keyword: effect.keyword,
          timestamp: ctx.state.nextTimestamp++,
        });
        emit(ctx, 'grantKeyword', {
          source: source.name,
          target: perm.name,
          keyword: effect.keyword,
        });
        break;
      }
      case 'pumpEachUntilEot': {
        const except =
          effect.exceptTriggerObject === true
            ? (scope.triggerObjectId ?? scope.eventObjectId)
            : undefined;
        const affected = affectedBy(ctx, source, effect.selector, scope.eventPlayerId).filter(
          (perm) => except === undefined || perm.id !== except,
        );
        const power = amountOf(effect.power);
        const toughness = amountOf(effect.toughness);
        const clause = `get ${signed(power)}/${signed(toughness)}`;
        if (affected.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: describeMassEffect(affected, clause),
            targetCardIds: affected.map((p) => p.cardId),
            kind: 'ptDelta',
            power,
            toughness,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        emit(ctx, 'pump', {
          source: source.name,
          targets: affected.map((p) => p.name),
          power,
          toughness,
        });
        break;
      }
      case 'grantKeywordEachUntilEot': {
        const affected = affectedBy(ctx, source, effect.selector);
        if (affected.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: describeMassEffect(affected, `gain ${effect.keyword}`),
            targetCardIds: affected.map((p) => p.cardId),
            kind: 'grantKeyword',
            keyword: effect.keyword,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        emit(ctx, 'grantKeyword', {
          source: source.name,
          targets: affected.map((p) => p.name),
          keyword: effect.keyword,
        });
        break;
      }
      case 'denyKeywordsEachUntilEot': {
        const affected = affectedBy(ctx, source, effect.selector);
        const lost = effect.keywords.join(' and ');
        if (affected.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: describeMassEffect(affected, `lose ${lost} and can't have ${lost}`),
            targetCardIds: affected.map((p) => p.cardId),
            targetObjectIds: affected.map((p) => p.id),
            kind: 'denyKeywords',
            deniedKeywords: [...effect.keywords],
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        emit(ctx, 'denyKeywords', {
          source: source.name,
          targets: affected.map((p) => p.name),
          keywords: [...effect.keywords],
        });
        break;
      }
      case 'grantKeywordToAttackGroupUntilEot': {
        const group = (scope.attackGroupIds ?? [])
          .map((id) => findPermanent(ctx, id))
          .filter((p): p is EnginePermanent => p !== undefined);
        if (group.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: describeMassEffect(group, `gain ${effect.keyword}`),
            targetCardIds: group.map((p) => p.cardId),
            kind: 'grantKeyword',
            keyword: effect.keyword,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        emit(ctx, 'grantKeyword', {
          source: source.name,
          targets: group.map((p) => p.name),
          keyword: effect.keyword,
        });
        break;
      }
      case 'putCountersOnCreatureOfChoice': {
        const candidates = ctx.state.battlefield.filter(
          (perm) => perm.controllerId === controller.id && isCreaturePermanent(ctx, perm),
        );
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: choose a creature you control to put ${effect.count} ${effect.counter} counters on`,
          cards: candidates,
          type: 'putCounters',
          verb: 'Choose',
        });
        if (chosen !== null) addCounters(ctx, source, chosen, effect.counter, effect.count);
        break;
      }
      case 'returnBlockedCreatureAtEndOfCombat': {
        const blockedId = scope.blockedObjectId;
        const blocked = blockedId === undefined ? undefined : findPermanent(ctx, blockedId);
        if (blocked === undefined) break;
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId as never,
          controllerId: controller.id,
          targetId: blocked.cardId,
          targetObjectId: blocked.id,
          when: 'endOfCombat',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'returnToHand', target: 'triggerObject' }],
            description: "Return that creature to its owner's hand at end of combat",
          },
          expiry: 'onFire',
        });
        break;
      }
      case 'grantProtectionEachUntilEot': {
        // Same shape as `grantKeywordEachUntilEot`; the affected set is fixed at resolution
        // (CR 611.2c), so a creature that enters afterwards is not protected.
        const affected = affectedBy(ctx, source, effect.selector);
        if (affected.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: describeMassEffect(
              affected,
              `gain protection from ${effect.colors.join('')}`,
            ),
            targetCardIds: affected.map((p) => p.cardId),
            kind: 'grantProtection',
            protectionFrom: [...effect.colors],
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        break;
      }
      case 'grantChosenColorProtectionUntilEot': {
        const target = ref(effect.target);
        const permanent = target === null ? undefined : findPermanent(ctx, target);
        if (permanent === undefined) break;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `Choose a color for ${permanent.name}'s protection.`,
          options: ALL_COLORS.map((color) => ({
            type: 'chooseColor',
            description: `Protection from ${color}`,
            payload: color,
            interaction: { kind: 'choice' as const },
          })),
        };
        const color = ALL_COLORS[outcome.index];
        if (color === undefined) throw new Error('engine bug: invalid protection color choice');
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${permanent.name} gains protection from ${color}`,
          targetCardIds: [permanent.cardId],
          kind: 'grantProtection',
          protectionFrom: [color],
          timestamp: ctx.state.nextTimestamp++,
        });
        break;
      }
      case 'changeSingleTarget': {
        const entry = ctx.state.stack.find((candidate) => candidate.id === ref(effect.target));
        if (entry !== undefined) yield* changeSingleStackTarget(ctx, entry, controller.id);
        break;
      }
      case 'chooseNewTargets': {
        const entry = ctx.state.stack.find((candidate) => candidate.id === ref(effect.target));
        if (entry !== undefined)
          yield* chooseNewStackTargets(ctx, entry, controller.id, source.name);
        break;
      }
      case 'phaseOutAndProtectControllerUntilNextTurn':
        phaseOutControlledPermanents(ctx, controller.id);
        (ctx.state.playerProtectionUntilNextTurn ??= {})[controller.id] = ctx.state.turnNumber;
        emit(ctx, 'playerProtectionUntilNextTurn', { player: controller.id });
        break;
      case 'controllerProtectionFromEverythingUntilNextTurn':
        (ctx.state.playerProtectionFromEverythingUntilNextTurn ??= {})[controller.id] =
          ctx.state.turnNumber;
        emit(ctx, 'playerProtectionUntilNextTurn', { player: controller.id });
        break;
      case 'phaseOutEachChosen':
        // Each object phases in during its controller's untap step (CR 702.26b). The targets
        // are "you control", so that is this spell's controller.
        phaseOutPermanents(
          ctx,
          legalChosenPermanents(effect.targetSlot).flatMap((chosen) => {
            const perm = findPermanent(ctx, chosen.id);
            return perm === undefined ? [] : [perm.id];
          }),
          controller.id,
        );
        break;
      case 'prohibitSpellsThisTurn':
        ctx.state.spellsProhibitedTurn = ctx.state.turnNumber;
        emit(ctx, 'spellCastingProhibited', { turn: ctx.state.turnNumber });
        break;
      case 'controllerHexproofUntilEot':
        (ctx.state.playerHexproofTurn ??= {})[controller.id] = ctx.state.turnNumber;
        emit(ctx, 'playerHexproof', { player: controller.id, turn: ctx.state.turnNumber });
        break;
      case 'exileSpellAndPlot': {
        const target = ref(effect.target);
        const index = ctx.state.stack.findIndex((entry) => entry.id === target);
        const entry = ctx.state.stack[index];
        if (entry === undefined || entry.kind !== 'spell') break;
        // Exiling is not countering. A copy disappears and provides no plotted card.
        ctx.state.stack.splice(index, 1);
        if (entry.card !== null) {
          const exiled = yield* moveObject(ctx, entry.card, { zone: 'exile' });
          if (exiled !== null && exiled.zone === 'exile') exiled.plottedTurn = ctx.state.turnNumber;
        }
        emit(ctx, 'exileSpell', {
          name: entry.description,
          source: source.name,
          plotted:
            entry.card !== null &&
            ctx.state.exile.some(
              (card) =>
                card.cardId === entry.card!.cardId && card.plottedTurn === ctx.state.turnNumber,
            ),
        });
        break;
      }
      case 'returnSpellToOwnerHand': {
        const target = ref(effect.target);
        const index = ctx.state.stack.findIndex((entry) => entry.id === target);
        const entry = ctx.state.stack[index];
        if (entry === undefined || entry.kind !== 'spell') break;
        ctx.state.stack.splice(index, 1);
        if (entry.card !== null) yield* moveObject(ctx, entry.card, { zone: 'hand' });
        emit(ctx, 'returnSpell', { name: entry.description, source: source.name });
        break;
      }
      case 'dealDamage': {
        const t = ref(effect.target);
        if (t === null) break;
        const damageSource = effect.source === undefined ? source : damageSourceOf(effect.source);
        if (damageSource === undefined) break;
        yield* dealDamageToObject(ctx, damageSource, t, amountOf(effect.amount));
        break;
      }
      case 'dealDamageUnlessSacrifice': {
        const t = ref(effect.target);
        if (t === null) break;
        const amount = amountOf(effect.amount);
        const targetPlayer = ctx.state.players.find((p) => p.id === t);
        if (targetPlayer === undefined) {
          yield* dealDamageToObject(ctx, source, t, amount);
          break;
        }
        const creatures = ctx.state.battlefield.filter(
          (p) =>
            p.controllerId === targetPlayer.id &&
            canBeSacrificed(ctx, p) &&
            computeCharacteristics(ctx, p).types.includes('Creature'),
        );
        let sacrificed = false;
        if (creatures.length > 0) {
          const outcome = yield {
            decisionType: 'general',
            player: targetPlayer.id,
            prompt: `${source.name} deals ${amount} damage to you unless you sacrifice a creature. Sacrifice a creature?`,
            options: [
              ...creatures.map((c) => ({
                type: 'sacrifice',
                description: `Sacrifice ${c.name}`,
                payload: c.id,
              })),
              { type: 'decline', description: `Don't sacrifice (take ${amount} damage)` },
            ],
          };
          if (outcome.index < creatures.length) {
            const chosen = creatures[outcome.index] as EnginePermanent;
            emit(ctx, 'sacrifice', { name: chosen.name, cardId: chosen.cardId }, targetPlayer.id);
            yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
            sacrificed = true;
          }
        }
        if (!sacrificed) yield* dealDamageToObject(ctx, source, t, amount);
        break;
      }
      case 'dealDamageEachChosen': {
        const amount = amountOf(effect.amount);
        for (const id of chosenReferents(effect.targetSlot)) {
          yield* dealDamageToObject(ctx, source, id, amount);
        }
        break;
      }
      case 'grantKeywordEachChosenUntilEot': {
        const chosen = legalChosenPermanents(effect.targetSlot);
        if (chosen.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: describeMassEffect(chosen, `gain ${effect.keyword}`),
            targetCardIds: chosen.map((permanent) => permanent.cardId),
            kind: 'grantKeyword',
            keyword: effect.keyword,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        break;
      }
      case 'untapUpTo': {
        const available = affectedBy(ctx, source, effect.selector).filter(
          (permanent) => permanent.tapped,
        );
        for (let chosen = 0; chosen < effect.max && available.length > 0; chosen += 1) {
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `${source.name}: choose a permanent to untap, or choose none.`,
            presentationSource: presentedSource(ctx, source),
            options: [
              plainOption({
                type: 'decline',
                description: 'Choose none',
                verb: 'Done',
                role: 'decline',
              }),
              ...available.map((permanent) =>
                cardOption(ctx, permanent, {
                  viewerId: controller.id,
                  type: 'untap',
                  description: `Untap ${permanent.name}`,
                  verb: 'Untap',
                }),
              ),
            ],
          };
          if (outcome.index === 0) break;
          const [permanent] = available.splice(outcome.index - 1, 1);
          if (permanent !== undefined) permanent.tapped = false;
        }
        break;
      }
      case 'putCountersEachChosen': {
        const count = amountOf(effect.count);
        for (const permanent of legalChosenPermanents(effect.targetSlot)) {
          addCounters(ctx, source, permanent, effect.counter, count);
        }
        break;
      }
      case 'exileEachChosen': {
        const exiled: EnginePermanent[] = [];
        for (const chosen of legalChosenPermanents(effect.targetSlot)) {
          const perm = findPermanent(ctx, chosen.id);
          if (perm === undefined) continue;
          emit(ctx, 'exile', { target: perm.name, source: source.name });
          exiled.push(perm);
        }
        yield* movePermanentsTogether(ctx, exiled, { zone: 'exile' });
        break;
      }
      case 'destroyEachChosen': {
        for (const chosen of legalChosenPermanents(effect.targetSlot)) {
          const permanent = findPermanent(ctx, chosen.id);
          if (permanent === undefined) continue;
          yield* destroyPermanent(ctx, source, permanent, false);
        }
        break;
      }
      case 'tapAndGoadEachChosen': {
        for (const permanent of legalChosenPermanents(effect.targetSlot)) {
          if (!permanent.tapped) {
            permanent.tapped = true;
            queueTriggersForObject(ctx, 'becomesTapped', permanent);
          }
          addGoadRequirement(ctx, permanent, controller.id);
          emit(ctx, 'goad', { target: permanent.name, source: source.name });
        }
        break;
      }
      case 'blinkEachChosen': {
        for (const permanent of legalChosenPermanents(effect.targetSlot)) {
          const cardId = permanent.cardId;
          const returnControllerId =
            effect.returnUnder === 'owner' ? permanent.ownerId : source.controllerId;
          yield* moveObject(ctx, permanent, { zone: 'exile' });
          const exiled = ctx.state.exile.find((card) => card.cardId === cardId);
          if (exiled !== undefined) {
            yield* moveObject(ctx, exiled, {
              zone: 'battlefield',
              controllerId: returnControllerId,
            });
          }
        }
        break;
      }
      case 'exileTargetGraveyardAndBuffIfCreature': {
        const targetId = scope.targets?.[effect.targetSlot];
        if (!targetId) break;
        const cardObj = ctx.state.players
          .flatMap((player) => player.graveyard)
          .find((card) => card.id === targetId);
        if (cardObj === undefined) break;
        const def = getDefByOracleId(ctx, cardObj.oracleId, cardObj.name);
        yield* moveObject(ctx, cardObj, { zone: 'exile' });
        if (def.types.includes('Creature')) {
          const sourcePerm = sourcePermanent();
          if (sourcePerm) addCounters(ctx, source, sourcePerm, '+1/+1', 1);
          const controller = ctx.state.players.find((p) => p.id === source.controllerId);
          if (controller) gainLife(ctx, controller, 1);
        }
        break;
      }
      case 'pumpTargetPlayerCreaturesUntilEot': {
        const targetPlayerId = scope.targets?.[effect.targetSlot] as PlayerId | undefined;
        if (!targetPlayerId) break;
        const targetCardIds = ctx.state.battlefield
          .filter(
            (perm) =>
              perm.controllerId === targetPlayerId &&
              computeCharacteristics(ctx, perm).types.includes('Creature'),
          )
          .map((perm) => perm.cardId);
        if (targetCardIds.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: `Creatures target player controls get ${signed(effect.power)}/${signed(effect.toughness)} until end of turn`,
            targetCardIds,
            kind: 'ptDelta',
            power: effect.power,
            toughness: effect.toughness,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        break;
      }
      case 'exileEachChosenUntilSourceLeaves': {
        if (source.id === undefined || !ctx.state.battlefield.some((perm) => perm.id === source.id))
          break;
        const permanents = legalChosenPermanents(effect.targetSlot);
        const moved = (yield* moveObjects(ctx, permanents, { zone: 'exile' })).filter(
          (card): card is EngineCardObject => card?.zone === 'exile',
        );
        if (!ctx.state.battlefield.some((perm) => perm.id === source.id)) {
          yield* moveObjects(ctx, moved, { zone: 'battlefield' });
        } else {
          ctx.state.exiledUntilLeaves[source.cardId] = [
            ...(ctx.state.exiledUntilLeaves[source.cardId] ?? []),
            ...moved.map((card) => ({
              cardId: card.cardId,
              controllerId: card.ownerId,
              objectId: card.id,
            })),
          ];
        }
        break;
      }
      case 'exileUntilSourceLeaves': {
        // CR 610.3a: if the duration ended before this effect resolves, exile nothing.
        if (
          !ctx.state.battlefield.some(
            (p) => p.cardId === source.cardId && (source.id === undefined || p.id === source.id),
          )
        )
          break;
        const targetId = scope.targets?.[effect.targetSlot];
        if (!targetId) break;
        const perm = findPermanent(ctx, targetId);
        if (perm === undefined) break;
        ctx.state.exiledUntilLeaves[source.cardId] = [
          ...(ctx.state.exiledUntilLeaves[source.cardId] ?? []),
          { cardId: perm.cardId, controllerId: perm.controllerId },
        ];
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'exile' });
        break;
      }
      case 'exileCreatureAndControllerSearchBasicLand':
      case 'exileEachCreatureAndControllersSearchBasicLands': {
        const targetId =
          effect.op === 'exileCreatureAndControllerSearchBasicLand' ? ref(effect.target) : null;
        const affected =
          effect.op === 'exileEachCreatureAndControllersSearchBasicLands'
            ? affectedBy(ctx, source, effect.selector)
            : ctx.state.battlefield.filter((permanent) => permanent.id === targetId);
        const beneficiaries = affected.map((permanent) => permanent.controllerId);
        const moved = yield* movePermanentsTogether(ctx, affected, { zone: 'exile' });
        const searches = new Map<PlayerId, number>();
        affected.forEach((permanent, index) => {
          if (permanent.isToken || moved[index]?.zone === 'exile') {
            const player = beneficiaries[index]!;
            searches.set(player, (searches.get(player) ?? 0) + 1);
          }
        });
        const found: { card: EngineCardObject; playerId: PlayerId }[] = [];
        for (const player of playersInApnapOrder(ctx)) {
          if (player.hasLost) continue;
          for (let search = 0; search < (searches.get(player.id) ?? 0); search++) {
            const candidates = player.library.filter((card) => {
              const def = getDefByOracleId(ctx, card.oracleId, card.name);
              return (
                def.types.includes('Land') &&
                def.supertypes.includes('Basic') &&
                !found.some((entry) => entry.card.id === card.id)
              );
            });
            const card = yield* chooseCard(ctx, {
              player: player.id,
              prompt: `${source.name}: search for a basic land (${search + 1} of ${searches.get(player.id)})`,
              cards: candidates,
              type: 'search',
              verb: 'Find',
              decline: { type: 'decline', description: 'Fail to find a land', verb: 'Skip' },
            });
            if (card !== null) found.push({ card, playerId: player.id });
          }
        }
        // All searches precede entry. Move as one event so entry observers see every land.
        // Each card goes to its owner's battlefield; these library cards are owned by searchers.
        yield* moveObjects(
          ctx,
          found.map((entry) => entry.card),
          { zone: 'battlefield', entersTapped: true },
        );
        for (const player of playersInApnapOrder(ctx))
          if (searches.has(player.id) && !player.hasLost) shuffleLibrary(ctx, player);
        break;
      }
      case 'destroyTargetAndControllerMaySearchBasicTypedLand': {
        const targetId = ref(effect.target);
        const permanent = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (permanent === undefined) break;
        const beneficiary = playerById(ctx, permanent.controllerId);
        yield* destroyPermanent(ctx, source, permanent);
        const response = yield {
          decisionType: 'general',
          player: beneficiary.id,
          prompt: `${source.name}: search your library for a land with a basic land type?`,
          options: [
            { type: 'search', description: 'Search library' },
            { type: 'decline', description: 'Do not search' },
          ],
        };
        if (response.index !== 0) break;
        const lands = beneficiary.library.filter((card) => {
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          return (
            def.types.includes('Land') &&
            def.subtypes.some((type) =>
              ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].includes(type),
            )
          );
        });
        const chosen = yield* chooseCard(ctx, {
          player: beneficiary.id,
          prompt: `${source.name}: choose a land with a basic land type`,
          cards: lands,
          type: 'search',
          verb: 'Find',
          decline: { type: 'decline', description: 'Fail to find a land', verb: 'Skip' },
        });
        if (chosen !== null)
          yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: beneficiary.id });
        shuffleLibrary(ctx, beneficiary);
        break;
      }
      case 'removeTargetAndControllerMaySearchBasicLand': {
        const targetId = ref(effect.target);
        if (targetId === null) break;
        const perm = findPermanent(ctx, targetId);
        if (perm === undefined) break;
        const beneficiary = playerById(ctx, perm.controllerId);
        if (effect.action === 'destroy') {
          yield* destroyPermanent(ctx, source, perm);
        } else {
          emit(ctx, 'exile', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'exile' });
        }
        const basics = beneficiary.library.filter((card) => {
          const candidate = getDefByOracleId(ctx, card.oracleId, card.name);
          return candidate.types.includes('Land') && candidate.supertypes.includes('Basic');
        });
        const chosen = yield* chooseCard(ctx, {
          player: beneficiary.id,
          prompt: `${source.name}: you may search for a basic land`,
          cards: basics,
          type: 'search',
          verb: 'Find',
          decline: { type: 'decline', description: "Don't find a card", verb: 'Skip' },
        });
        if (chosen !== null) {
          yield* moveObject(ctx, chosen, {
            zone: 'battlefield',
            controllerId: beneficiary.id,
            ...(effect.entersTapped ? { entersTapped: true } : {}),
          });
        }
        shuffleLibrary(ctx, beneficiary);
        break;
      }
      case 'exileTargetAndControllerMaySearchBasicLandTapped': {
        const targetId = scope.targets?.[effect.targetSlot];
        if (!targetId) break;
        const perm = findPermanent(ctx, targetId);
        if (perm === undefined) break;
        const targetControllerId = perm.controllerId;
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'exile' });
        const targetPlayer = ctx.state.players.find((p) => p.id === targetControllerId);
        if (targetPlayer) {
          const choice = yield {
            decisionType: 'general',
            player: targetControllerId,
            prompt:
              'May search your library for a basic land card, put that card onto the battlefield tapped, then shuffle',
            options: [
              { type: 'search', description: 'Search for a basic land card' },
              { type: 'decline', description: "Don't search" },
            ],
          };
          if (choice.index === 0) {
            const landIdx = targetPlayer.library.findIndex((c) => {
              const def = getDefByOracleId(ctx, c.oracleId, c.name);
              return def.types.includes('Land') && def.supertypes.includes('Basic');
            });
            if (landIdx !== -1) {
              const landCard = targetPlayer.library.splice(landIdx, 1)[0]!;
              const landPerm = makePermanent(ctx, landCard, targetControllerId);
              landPerm.tapped = true;
              ctx.state.battlefield.push(landPerm);
              queueTriggersForObject(ctx, 'enters', landPerm);
            }
          }
        }
        break;
      }
      case 'populate': {
        const myTokens = ctx.state.battlefield.filter(
          (p) =>
            p.controllerId === source.controllerId &&
            p.isToken &&
            computeCharacteristics(ctx, p).types.includes('Creature'),
        );
        if (myTokens.length > 0) {
          let chosenToken = myTokens[0]!;
          if (myTokens.length > 1) {
            const choice = yield {
              decisionType: 'general',
              player: source.controllerId,
              prompt: 'Choose a creature token to populate (create a copy of it)',
              options: myTokens.map((t) => ({
                type: 'choose',
                description: `${t.name} (${effectivePT(ctx, t).power}/${effectivePT(ctx, t).toughness})`,
              })),
            };
            chosenToken = myTokens[choice.index] ?? myTokens[0]!;
          }
          const chars = computeCharacteristics(ctx, chosenToken);
          createToken(
            ctx,
            {
              name: chosenToken.name,
              typeLine: chosenToken.typeLine,
              types: chars.types,
              subtypes: chars.subtypes,
              colors: chars.colors,
              power: chars.power,
              toughness: chars.toughness,
              keywords: chars.keywords,
            },
            source.controllerId,
          );
        }
        break;
      }
      case 'untapAttackingPlayerNonlandPermanents': {
        const attackingPlayerId = scope.eventPlayerId ?? scope.controllerId;
        for (const perm of ctx.state.battlefield) {
          if (
            perm.controllerId === attackingPlayerId &&
            !computeCharacteristics(ctx, perm).types.includes('Land')
          ) {
            perm.tapped = false;
          }
        }
        break;
      }
      case 'untapTargetPlayerCreatures': {
        const targetPlayerId = scope.targets?.[effect.targetSlot] as PlayerId | undefined;
        if (!targetPlayerId) break;
        for (const perm of ctx.state.battlefield) {
          if (
            perm.controllerId === targetPlayerId &&
            computeCharacteristics(ctx, perm).types.includes('Creature')
          ) {
            perm.tapped = false;
          }
        }
        break;
      }
      case 'regainControlOfOwnCreatures': {
        // "Each player gains control of all creatures they own" (Trostani Disciple, Alicia Masters,
        // Skilled Sculptor). The set of affected objects is decided ONCE, when the effect resolves:
        // each grant is a new control-changing effect with its own effect timestamp, and a type
        // can depend on who controls the permanent ("Artifacts you control are creatures"), so a
        // per-iteration `computeCharacteristics` would let an earlier grant change what a later
        // permanent is and sweep up an object that was not a creature when this effect began.
        // Noncreatures are excluded and anything that arrives later is not.
        //
        // EVERY living owner's own creature is granted, including one its owner ALREADY controls:
        // a creature's characteristics are chosen as this resolves, but the record is a fresh
        // permanent control change that must survive whatever temporary control history sits
        // under it. Adding it even with no controller transition (CR 613.7 sets no layer
        // timestamp and CR 302.6/506.4 need none) is what stops an older "until end of turn" grant
        // from taking the creature back at the cleanup step when it expires (CR 514.2).
        //
        // `ownerId` is the grant's recipient throughout — never the current `controllerId` — and
        // `changeController` keeps the timestamped record stack plus its entry-facts fallback, so
        // an expired record still falls back to what lies beneath it.
        const livingOwners = new Set(
          ctx.state.players.filter((player) => !player.hasLost).map((player) => player.id),
        );
        const grants = ctx.state.battlefield.filter(
          (perm) =>
            livingOwners.has(perm.ownerId) &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        // No zone change and no state-based action runs between grants: the whole grant is one
        // effect, so nothing is destroyed or exiled out from under a later owner.
        for (const perm of grants) changeController(ctx, perm, perm.ownerId);
        break;
      }
      case 'swapCreatureControlUntilEot': {
        const opponentId = ref(effect.target);
        const opponent = ctx.state.players.find(
          (player) => player.id === opponentId && !player.hasLost,
        );
        if (opponent === undefined) break;
        const creatures = () =>
          ctx.state.battlefield.filter(
            (perm) =>
              (perm.controllerId === controller.id || perm.controllerId === opponent.id) &&
              computeCharacteristics(ctx, perm).types.includes('Creature'),
          );
        const toUntap = creatures();
        for (const perm of toUntap) perm.tapped = false;
        emit(ctx, 'untap', {
          source: source.name,
          objects: toUntap.map((perm) => ({
            id: perm.id,
            name: perm.faceDown ? 'Face-down permanent' : perm.name,
          })),
        });
        // The control instruction follows the untap instruction. Both sets must be read now,
        // before either grant changes controller-dependent creature characteristics (CR 611.2c).
        const affected = creatures();
        const grants = affected.map((perm) => ({
          perm,
          recipient: perm.controllerId === controller.id ? opponent.id : controller.id,
        }));
        for (const { perm, recipient } of grants) {
          changeController(ctx, perm, recipient, { kind: 'untilEndOfTurn' });
          emit(ctx, 'gainControl', {
            source: source.name,
            target: perm.name,
            newController: recipient,
          });
        }
        for (const perm of affected) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: `${perm.name} gains haste until end of turn`,
            targetCardIds: [perm.cardId],
            targetObjectIds: [perm.id],
            kind: 'grantKeyword',
            keyword: 'haste',
            timestamp: ctx.state.nextTimestamp++,
          });
          emit(ctx, 'grantKeyword', { source: source.name, target: perm.name, keyword: 'haste' });
        }
        break;
      }
      case 'returnToHandEachChosen': {
        // "Return up to two other target nonland permanents to their owners' hands" (Marang
        // River Regent) — the `returnToHand` analog of `dealDamageEachChosen` above: every
        // object chosen in the variable-count slot is returned independently.
        const returned: EnginePermanent[] = [];
        for (const chosen of legalChosenPermanents(effect.targetSlot)) {
          const perm = findPermanent(ctx, chosen.id);
          if (perm === undefined) continue;
          emit(ctx, 'returnToHand', { target: perm.name, source: source.name });
          returned.push(perm);
        }
        yield* movePermanentsTogether(ctx, returned, { zone: 'hand' });
        break;
      }
      case 'dealDamageDivided': {
        // Ureni: the split was decided at announcement (CR 601.2d) and rides on
        // `divisionAmounts`; a target that left before resolution is simply skipped, same as
        // any other target (CR 608.2b) rather than redistributing its share.
        const spec = ability.targets[effect.targetSlot];
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          const amount = divisionAmounts?.[id] ?? 0;
          if (amount <= 0) continue;
          if (spec === undefined || !stillLegal(id, spec)) {
            continue;
          }
          const currentId = movedReferent(id);
          if (currentId !== null) yield* dealDamageToObject(ctx, source, currentId, amount);
        }
        break;
      }
      case 'destroy': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        yield* destroyPermanent(ctx, source, perm, effect.cantRegenerate === true);
        break;
      }
      case 'regenerate': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm !== undefined) {
          perm.regenerationShields++;
          emit(
            ctx,
            'regenerationShield',
            { permanent: perm.name, shields: perm.regenerationShields },
            perm.controllerId,
          );
        }
        break;
      }
      case 'destroyAndCreateTokenForController': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        const targetControllerId = perm.controllerId;
        yield* destroyPermanent(ctx, source, perm);
        for (let i = 0; i < amountOf(effect.count); i++)
          createToken(ctx, effect.spec, targetControllerId);
        break;
      }
      case 'exileAndGainLifeTargetController': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        const life = Math.max(0, computeCharacteristics(ctx, perm).power ?? 0);
        const targetController = playerById(ctx, perm.controllerId);
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'exile' });
        gainLife(ctx, targetController, life);
        break;
      }
      case 'destroyAndCreateTokensEqualToManaValue': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        const tokenCount = spellManaValue(
          getDefByOracleId(ctx, perm.oracleId, perm.name),
          undefined,
        );
        yield* destroyPermanent(ctx, source, perm);
        for (let i = 0; i < tokenCount; i++) createToken(ctx, effect.spec, controller.id);
        break;
      }
      case 'destroyEach': {
        // CR 701.7: evaluate indestructibility before any static-granting permanent leaves.
        // Replacements and all death watchers likewise see one simultaneous departure event.
        const affected = affectedBy(ctx, source, effect.selector, extraScope?.eventPlayerId);
        const protectedIds = new Set(
          affected.filter((perm) => hasKeyword(ctx, perm, 'indestructible')).map((perm) => perm.id),
        );
        const destroyed: EnginePermanent[] = [];
        for (const perm of affected) {
          if (protectedIds.has(perm.id)) {
            emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
          } else if (!consumeRegenerationShield(ctx, perm, effect.cantRegenerate === true)) {
            emit(ctx, 'destroy', { target: perm.name, source: source.name });
            destroyed.push(perm);
          }
        }
        yield* movePermanentsToGraveyard(ctx, destroyed);
        break;
      }
      case 'exileTargetPlayerGraveyard': {
        const targetId = ref(effect.target);
        if (targetId === null) break;
        const player = ctx.state.players.find((candidate) => candidate.id === targetId);
        if (player === undefined) break;
        yield* moveObjects(ctx, [...player.graveyard], { zone: 'exile' });
        break;
      }
      case 'exileAllGraveyards': {
        yield* moveObjects(
          ctx,
          ctx.state.players.flatMap((player) => [...player.graveyard]),
          { zone: 'exile' },
        );
        break;
      }
      case 'resolvingSpellToLibraryBottom': {
        const entry = source.resolvingStackObject;
        if (entry?.kind !== 'spell' || entry.card === null) break;
        const card = entry.card;
        entry.card = null;
        yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'bottom' });
        break;
      }
      case 'shuffleSourceFromGraveyardIntoLibrary': {
        const owner = ctx.state.players.find((player) =>
          player.graveyard.some((card) => card.cardId === source.cardId),
        );
        const card = owner?.graveyard.find((candidate) => candidate.cardId === source.cardId);
        if (owner === undefined || card === undefined) break;
        yield* moveObject(ctx, card, { zone: 'library' });
        shuffleLibrary(ctx, owner);
        break;
      }
      case 'resolvingSpellExile': {
        const entry = source.resolvingStackObject;
        if (entry?.kind !== 'spell' || entry.card === null) break;
        const card = entry.card;
        // Clearing the stack entry's card keeps resolution from also moving it to the graveyard.
        entry.card = null;
        yield* moveObject(ctx, card, { zone: 'exile' });
        break;
      }
      case 'resolvingSpellShuffleIntoLibrary': {
        const entry = source.resolvingStackObject;
        if (entry?.kind !== 'spell' || entry.card === null) break;
        const card = entry.card;
        // Clearing the stack entry's card keeps resolution from also moving it to the graveyard.
        entry.card = null;
        yield* moveObject(ctx, card, { zone: 'library' });
        shuffleLibrary(ctx, playerById(ctx, card.ownerId));
        break;
      }
      case 'exileEachOpponentGraveyard': {
        yield* moveObjects(
          ctx,
          opponentsOf(ctx, source.controllerId).flatMap((opponent) => [...opponent.graveyard]),
          { zone: 'exile' },
        );
        break;
      }
      case 'exile': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'exile' });
        break;
      }
      case 'exileCard': {
        const t = ref(effect.target);
        if (t === null) break;
        const card = findObjectById(ctx, t);
        if (card !== undefined && card.zone === 'graveyard')
          yield* moveObject(ctx, card, { zone: 'exile' });
        break;
      }
      case 'exileGraveyardEventCard': {
        const id = extraScope?.eventObjectId;
        if (id === undefined)
          throw new Error('engine bug: graveyard exile without event card identity');
        const card = ctx.state.players
          .flatMap((player) => player.graveyard)
          .find((card) => card.id === id);
        if (card !== undefined) yield* moveObject(ctx, card, { zone: 'exile' });
        break;
      }
      case 'capstoneParadigm': {
        const exiled: EngineCardObject[] = [];
        let total = 0;
        while (total < effect.minimumManaValue && controller.library.length > 0) {
          const top = controller.library[0]!;
          const moved = yield* moveObject(ctx, top, { zone: 'exile' });
          if (moved === null) break;
          if (moved.zone !== 'exile') continue;
          exiled.push(moved);
          total += spellManaValue(getDefByOracleId(ctx, moved.oracleId, moved.name), 0);
        }
        for (;;) {
          const candidates = exiled.filter(
            (card) =>
              ctx.state.exile.includes(card) && freeCardIsCastable(ctx, card, controller.id),
          );
          if (candidates.length === 0) break;
          const card = yield* chooseCard(ctx, {
            player: controller.id,
            cards: candidates,
            type: 'castFree',
            verb: 'Cast for free',
            prompt: `${source.name}: you may cast any number of spells exiled this way.`,
            decline: { type: 'stopCasting', description: 'Stop casting cards', verb: 'Stop' },
          });
          if (card === null) break;
          yield* resolveFreeCard(ctx, card, controller.id);
        }
        const entry = source.resolvingStackObject;
        if (entry !== undefined) {
          const definition = spellDefinitionOf(ctx, entry);
          if (!(controller.resolvedSpellNames ?? []).includes(definition.name)) {
            const template = {
              definition: copyData(definition),
              oracleText: entry.card?.oracleText ?? '',
              manaCost: entry.card?.manaCost ?? null,
            };
            ctx.state.delayedTriggers.push({
              id: 'dt-' + ctx.state.nextObjectNum++,
              sourceCardId: source.cardId,
              sourceOracleId: source.oracleId,
              controllerId: controller.id,
              when: 'precombatMain',
              player: 'you',
              expiry: 'permanent',
              ability: {
                kind: 'triggered',
                targets: [],
                effects: [{ op: 'castParadigmCopy', template }],
                description: `Paradigm: create a copy of ${definition.name} in exile; you may cast it without paying its mana cost`,
              },
            });
          }
          entry.exileOnResolution = true;
        }
        break;
      }
      case 'castParadigmCopy': {
        const objectId = newObjectId(ctx);
        const oracleId = 'card-copy-definition-' + objectId;
        const definition = { ...copyData(effect.template.definition), oracleId };
        ctx.defs.set(oracleId, definition);
        const card: EngineCardObject = {
          id: objectId,
          cardId: 'card-copy-' + objectId,
          oracleId,
          ownerId: controller.id,
          name: definition.name,
          typeLine: definition.typeLine,
          oracleText: effect.template.oracleText,
          manaCost: effect.template.manaCost,
          zone: 'exile',
          isToken: false,
          isCommander: false,
          isCardCopy: true,
        };
        ctx.state.exile.push(card);
        emit(
          ctx,
          'cardCopied',
          { name: card.name, cardId: card.cardId, zone: 'exile' },
          controller.id,
        );
        if (!freeCardIsCastable(ctx, card, controller.id)) break;
        const choice = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `Paradigm: cast the copy of ${card.name} without paying its mana cost?`,
          options: [
            plainOption({
              type: 'castFree',
              description: `Cast the copy of ${card.name} for free`,
              verb: 'Cast',
            }),
            plainOption({
              type: 'decline',
              description: 'Decline casting the copy',
              verb: 'Decline',
              role: 'decline',
            }),
          ],
        };
        if (choice.index === 0) yield* resolveFreeCard(ctx, card, controller.id);
        break;
      }
      case 'exileAndCastNextUpkeep': {
        const target = ref(effect.target);
        const card =
          target === null ? undefined : controller.graveyard.find((card) => card.id === target);
        if (card === undefined) break;
        const exiled = yield* moveObject(ctx, card, { zone: 'exile' });
        if (exiled?.zone !== 'exile') break;
        ctx.state.delayedTriggers.push({
          id: 'dt-' + ctx.state.nextObjectNum++,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          controllerId: controller.id,
          when: 'upkeep',
          expiry: 'onFire',
          player: 'you',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'castRememberedExile', objectId: exiled.id, exileSpell: true }],
            description: `${source.name}: you may cast ${exiled.name} without paying its mana cost`,
          },
        });
        break;
      }
      case 'castRememberedExile': {
        const card = ctx.state.exile.find((card) => card.id === effect.objectId);
        if (card === undefined || !freeCardIsCastable(ctx, card, controller.id)) break;
        const choice = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: cast ${card.name} without paying its mana cost?`,
          options: [
            plainOption({
              type: 'castFree',
              description: `Cast ${card.name} for free`,
              verb: 'Cast',
            }),
            plainOption({
              type: 'decline',
              description: 'Leave the card in exile',
              verb: 'Decline',
              role: 'decline',
            }),
          ],
        };
        if (choice.index === 0)
          yield* resolveFreeCard(ctx, card, controller.id, Infinity, 0, undefined, true);
        break;
      }
      case 'trickery': {
        const target = ref(effect.target);
        const index = ctx.state.stack.findIndex(
          (entry) => entry.id === target && entry.kind === 'spell',
        );
        const entry = ctx.state.stack[index];
        if (entry === undefined) break;
        const victim = playerById(ctx, entry.controllerId);
        const counteredDefinition = spellDefinitionOf(ctx, entry);
        const spellNames = counteredDefinition.alternativeCasts?.some((alt) =>
          ['adventure', 'omen', 'mdfc'].includes(alt.kind),
        )
          ? [counteredDefinition.name.split(' // ')[0]!]
          : counteredDefinition.name.split(' // ');
        if (protectedFromCounter(ctx, entry))
          emit(ctx, 'counterPrevented', { target: entry.description, source: source.name });
        else {
          ctx.state.stack.splice(index, 1);
          emit(ctx, 'counterSpell', { countered: entry.description, by: source.name });
          if (entry.card !== null)
            yield* moveObject(ctx, entry.card, { zone: counteredCardZone(entry) });
        }
        const count = 1 + ctx.rng.nextInt(3);
        for (let i = 0; i < count; i++) {
          const top = victim.library[0];
          if (top === undefined) break;
          yield* moveObject(ctx, top, { zone: 'graveyard' });
          emit(ctx, 'mill', { player: victim.id, cardId: top.cardId, name: top.name }, victim.id);
        }
        const exiled: EngineCardObject[] = [];
        let hit: EngineCardObject | undefined;
        while (victim.library.length > 0) {
          const top = victim.library[0]!;
          const definition = getDefByOracleId(ctx, top.oracleId, top.name);
          const moved = yield* moveObject(ctx, top, { zone: 'exile' });
          if (moved?.zone !== 'exile') continue;
          exiled.push(moved);
          // Adventure and modal faces have only their front name in a library (CR 201.2).
          const name = definition.alternativeCasts?.some((alt) =>
            ['adventure', 'omen', 'mdfc'].includes(alt.kind),
          )
            ? definition.name.split(' // ')[0]!
            : definition.name;
          if (
            !definition.types.includes('Land') &&
            !name.split(' // ').some((part) => spellNames.includes(part))
          ) {
            hit = moved;
            break;
          }
        }
        if (hit !== undefined && freeCardIsCastable(ctx, hit, victim.id)) {
          const choice = yield {
            decisionType: 'general',
            player: victim.id,
            prompt: `${source.name}: cast ${hit.name} without paying its mana cost?`,
            options: [
              plainOption({
                type: 'castFree',
                description: `Cast ${hit.name} for free`,
                verb: 'Cast',
              }),
              plainOption({
                type: 'decline',
                description: 'Decline the free cast',
                verb: 'Decline',
                role: 'decline',
              }),
            ],
          };
          if (choice.index === 0) yield* resolveFreeCard(ctx, hit, victim.id);
        }
        yield* bottomCards(ctx, exiled);
        break;
      }
      case 'counterAndCreateTokenForController': {
        const t = ref(effect.target);
        if (t === null) break;
        const idx = ctx.state.stack.findIndex((entry) => entry.id === t);
        const countered = ctx.state.stack[idx];
        if (countered === undefined) break;
        const beneficiary = countered.controllerId;
        if (protectedFromCounter(ctx, countered)) {
          debug(ctx, 'stack', `${countered.description} can't be countered - no effect`);
          emit(ctx, 'counterPrevented', { target: countered.description, source: source.name });
        } else {
          ctx.state.stack.splice(idx, 1);
          emit(ctx, 'counterSpell', { countered: countered.description, by: source.name });
          debug(ctx, 'stack', `${countered.description} countered by ${source.name}`);
          if (countered.card !== null)
            yield* moveObject(ctx, countered.card, { zone: counteredCardZone(countered) });
        }
        createTokens(ctx, effect.spec, amountOf(effect.count), beneficiary);
        break;
      }
      case 'counter': {
        const t = ref(effect.target);
        if (t === null) break;
        const idx = ctx.state.stack.findIndex((s) => s.id === t);
        const countered = ctx.state.stack[idx];
        const manaSpent = effect.manaSpentAtNextMainPhase;
        if (
          countered !== undefined &&
          manaSpent !== undefined &&
          evaluateCondition(ctx, manaSpent.condition, {
            cardId: source.cardId,
            controllerId: controller.id,
            ...(source.id === undefined ? {} : { objectId: source.id }),
          })
        ) {
          // A copy was not cast, so no mana was spent to cast it (CR 707.10).
          const spent = countered.card?.manaSpentToCast ?? 0;
          ctx.state.delayedTriggers.push({
            id: `dt-${ctx.state.nextObjectNum++}`,
            sourceCardId: source.cardId,
            sourceOracleId: source.oracleId,
            controllerId: controller.id,
            when: 'mainPhase',
            ability: {
              kind: 'triggered',
              targets: [],
              effects: [
                {
                  op: 'addMana',
                  amount: { kind: 'const', n: spent },
                  colors: ['C'],
                  fixedSymbols: Array.from({ length: spent }, () => 'C' as const),
                },
              ],
              description: `Add {C} equal to the mana spent to cast the countered spell (${spent})`,
            },
            expiry: 'onFire',
            player: 'you',
          });
        }
        if (countered !== undefined) {
          // "This spell can't be countered" (CR 601): still a legal target — DEBT-style, like
          // indestructible on `destroy` above — but the countering itself has no effect.
          if (protectedFromCounter(ctx, countered)) {
            debug(ctx, 'stack', `${countered.description} can't be countered — no effect`);
            emit(ctx, 'counterPrevented', { target: countered.description, source: source.name });
            break;
          }
          ctx.state.stack.splice(idx, 1);
          if (effect.addManaAtNextMainPhase === true) {
            const counteredDef = spellDefinitionOf(ctx, countered);
            const manaValue = spellManaValue(counteredDef, countered.announcedX);
            ctx.state.delayedTriggers.push({
              id: `dt-${ctx.state.nextObjectNum++}`,
              sourceCardId: source.cardId,
              sourceOracleId: source.oracleId,
              controllerId: controller.id,
              when: 'mainPhase',
              ability: {
                kind: 'triggered',
                targets: [],
                effects: [
                  {
                    op: 'addMana',
                    amount: { kind: 'const', n: manaValue },
                    colors: ['C'],
                    fixedSymbols: Array.from({ length: manaValue }, () => 'C' as const),
                  },
                ],
                description: `Add {C} equal to the countered spell's mana value (${manaValue})`,
              },
              expiry: 'onFire',
              player: 'you',
            });
          }
          emit(ctx, 'counterSpell', { countered: countered.description, by: source.name });
          debug(ctx, 'stack', `${countered.description} countered by ${source.name}`);
          if (countered.card !== null) {
            yield* moveObject(ctx, countered.card, {
              zone: effect.exileIfCountered === true ? 'exile' : counteredCardZone(countered),
            });
          }
        }
        break;
      }
      case 'eachPlayerKeepsCreatureWithVow': {
        const allCreatures = ctx.state.battlefield.filter((permanent) =>
          computeCharacteristics(ctx, permanent).types.includes('Creature'),
        );
        const chosenCreatures: EnginePermanent[] = [];
        // All players choose in APNAP order before counters or sacrifices change the board.
        for (const player of playersInApnapOrder(ctx)) {
          const chosen = yield* chooseCard(ctx, {
            player: player.id,
            prompt: 'Choose a creature to keep and put a vow counter on.',
            cards: allCreatures.filter((permanent) => permanent.controllerId === player.id),
            type: 'chooseCard',
            verb: 'Keep',
          });
          if (chosen !== null) chosenCreatures.push(chosen);
        }
        for (const permanent of chosenCreatures) {
          addCounters(ctx, source, permanent, 'vow', 1);
          (permanent.cantAttackPlayerWhileCounter ??= []).push({
            playerId: controller.id,
            counter: 'vow',
          });
        }
        yield* movePermanentsToGraveyard(
          ctx,
          allCreatures.filter((permanent) => !chosenCreatures.includes(permanent)),
          'sacrifice',
        );
        break;
      }
      case 'sacrificeTargetPlayerCreature': {
        const player = ctx.state.players.find((player) => player.id === ref(effect.target));
        if (player === undefined || player.hasLost) break;
        const creatures = ctx.state.battlefield.filter(
          (permanent) =>
            permanent.controllerId === player.id &&
            computeCharacteristics(ctx, permanent).types.includes('Creature'),
        );
        const chosen = yield* chooseCard(ctx, {
          player: player.id,
          prompt: 'Sacrifice a creature.',
          cards: creatures,
          type: 'sacrifice',
          verb: 'Sacrifice',
        });
        if (chosen !== null) yield* movePermanentsToGraveyard(ctx, [chosen], 'sacrifice');
        break;
      }
      case 'separatePermanentsIntoPilesThenSacrifice': {
        const player = ctx.state.players.find((player) => player.id === ref(effect.target));
        if (player === undefined || player.hasLost) break;
        const permanents = ctx.state.battlefield.filter(
          (permanent) => permanent.controllerId === player.id,
        );
        const piles: [EnginePermanent[], EnginePermanent[]] = [[], []];
        for (const permanent of permanents) {
          const choice = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `Put ${permanent.name} in a pile.`,
            options: [
              { type: 'pile1', description: 'Put it in pile 1' },
              { type: 'pile2', description: 'Put it in pile 2' },
            ],
          };
          const pile = piles[choice.index];
          if (pile === undefined) throw new Error('engine bug: invalid pile assignment');
          pile.push(permanent);
        }
        const choice = yield {
          decisionType: 'general',
          player: player.id,
          prompt: 'Choose a pile of permanents to sacrifice.',
          options: piles.map((pile, index) => ({
            type: 'sacrificePile',
            description: `Sacrifice pile ${index + 1}: ${pile.map((permanent) => permanent.name).join(', ') || 'empty'}`,
          })),
        };
        const pile = piles[choice.index];
        if (pile === undefined) throw new Error('engine bug: invalid sacrifice pile');
        yield* movePermanentsToGraveyard(ctx, pile, 'sacrifice');
        break;
      }
      case 'separateIntoPilesLimitAttackers': {
        const eventPlayerId = ref('eventPlayer') as unknown as PlayerId | null;
        const attacker = ctx.state.players.find((player) => player.id === eventPlayerId);
        if (attacker === undefined || attacker.hasLost) break;
        const creatures = ctx.state.battlefield.filter(
          (permanent) =>
            permanent.controllerId === attacker.id && isCreaturePermanent(ctx, permanent),
        );
        const piles: [EnginePermanent[], EnginePermanent[]] = [[], []];
        const describePile = (pile: readonly EnginePermanent[]) =>
          pile.length === 0 ? 'empty' : pile.map((permanent) => permanent.name).join(', ');
        // The controller separates (CR 700.3); the pile choice is the affected player's, and with
        // no creature to separate there is nothing to choose between.
        for (const creature of creatures) {
          const choice = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `Put ${creature.name} in a pile.`,
            options: [
              {
                type: 'pile1',
                description: 'Put it in pile 1',
                data: { pile: describePile(piles[0]) },
              },
              {
                type: 'pile2',
                description: 'Put it in pile 2',
                data: { pile: describePile(piles[1]) },
              },
            ],
          };
          const pile = piles[choice.index];
          if (pile === undefined) throw new Error('engine bug: invalid pile assignment');
          pile.push(creature);
        }
        let allowed: EnginePermanent[] = [];
        if (creatures.length > 0) {
          const choice = yield {
            decisionType: 'general',
            player: attacker.id,
            prompt: `${source.name}: choose a pile of creatures; only those can attack this turn.`,
            options: piles.map((pile, index) => ({
              type: 'attackPile',
              description: `Attack with pile ${index + 1}: ${describePile(pile)}`,
            })),
          };
          allowed = piles[choice.index] ?? [];
        }
        // Read live from the affected player's point of view (CR 611.2c): a creature that arrives
        // later is in neither pile, so it can't attack. Two of these in one turn both bind.
        (ctx.state.attackRequirements ??= []).push({
          id: `ar-${ctx.state.nextObjectNum++}`,
          controllerId: controller.id,
          sourceCardId: source.cardId,
          affects: {
            kind: 'selector',
            selector: allOf(ofType('Creature'), YOURS),
            viewpointId: attacker.id,
          },
          requirements: [],
          restrictions: [
            { kind: 'cantAttackExcept', objectIds: allowed.map((permanent) => permanent.id) },
          ],
          expires: { kind: 'thisTurn', turn: ctx.state.turnNumber },
        });
        emit(ctx, 'attackRestriction', {
          source: source.name,
          player: attacker.id,
          allowed: allowed.map((permanent) => permanent.name),
        });
        break;
      }
      case 'sacrifice': {
        const t = ref(effect.target);
        const perm = t === null ? undefined : findPermanent(ctx, t);
        if (perm !== undefined)
          yield* moveObject(ctx, perm, { zone: 'graveyard', reason: 'sacrifice' });
        break;
      }
      case 'gainControlTarget': {
        const t = ref(effect.target);
        const perm = t === null ? undefined : findPermanent(ctx, t);
        const duration = resolveControlChangeDuration(ctx, source, effect.duration);
        if (perm === undefined || duration === null) break;
        let newController = source.controllerId;
        const recipient = effect.recipient;
        if (
          recipient !== undefined &&
          'chooseOpponent' in recipient &&
          recipient.chooseOpponent === true
        ) {
          const opponent = yield* chooseOpponentRecipient(ctx, source, controller.id, perm.name);
          if (opponent === null) break;
          newController = opponent;
        } else if (recipient !== undefined && 'targetPlayer' in recipient) {
          const recipientId = ref(recipient.targetPlayer);
          const player = ctx.state.players.find(
            (candidate) => candidate.id === recipientId && !candidate.hasLost,
          );
          if (player === undefined) break;
          newController = player.id;
        }
        const change = perm.controllerId !== newController;
        changeController(ctx, perm, newController, duration);
        if (change)
          emit(ctx, 'gainControl', {
            source: source.name,
            target: perm.name,
            newController,
          });
        break;
      }
      case 'putCounters': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        addCounters(ctx, source, perm, effect.counter, amountOf(effect.count));
        break;
      }
      case 'putCounterByPermanentType': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        const isPlaneswalker = computeCharacteristics(ctx, perm).types.includes('Planeswalker');
        addCounters(
          ctx,
          source,
          perm,
          isPlaneswalker ? effect.planeswalkerCounter : effect.creatureCounter,
          amountOf(effect.count),
        );
        break;
      }
      case 'putCountersEach': {
        // Like the `…EachUntilEot` primitives, the affected set is fixed here at resolution
        // (CR 611.2c) — but counters are a permanent change, so nothing is recorded to undo.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          addCounters(ctx, source, perm, effect.counter, amountOf(effect.count));
        }
        break;
      }
      case 'putCountersOnCreaturesTargetPlayerControls': {
        const playerId = ref(effect.target);
        if (playerId === null) break;
        const count = amountOf(effect.count);
        const permanents = ctx.state.battlefield.filter(
          (candidate) =>
            candidate.controllerId === playerId &&
            computeCharacteristics(ctx, candidate).types.includes('Creature'),
        );
        addCounterPlacements(
          ctx,
          source,
          permanents.map((perm) => ({
            perm,
            counter: effect.counter,
            count,
            placingPlayerId: playerId as PlayerId,
          })),
        );
        break;
      }
      case 'returnToHandEach': {
        // The affected set is fixed before anything moves (CR 611.2c): bouncing the first
        // permanent can change what the selector would match (an anthem leaving, a type-changer
        // going away), and a mass bounce must not re-derive its own targets mid-resolution.
        // They leave in one event, so leave triggers see each other leave (CR 603.10a).
        yield* movePermanentsTogether(ctx, affectedBy(ctx, source, effect.selector), {
          zone: 'hand',
        });
        break;
      }
      case 'exileEach': {
        // Same fixed-set rule as `returnToHandEach`/`destroyEach` above it.
        yield* movePermanentsTogether(ctx, affectedBy(ctx, source, effect.selector), {
          zone: 'exile',
        });
        break;
      }
      case 'graveyardToBattlefieldEach':
      case 'graveyardToHandEach': {
        // "Return all Zombie cards from your graveyard to the battlefield." One simultaneous move:
        // every returned creature is on the battlefield before any enters trigger is checked, so
        // each sees the others enter (CR 603.6a), and leaving the graveyard is one event.
        const owner = playerById(ctx, source.controllerId);
        const matching = owner.graveyard.filter((card) =>
          selectMatches(cardZoneCandidate(ctx, card, owner.id), effect.filter, {
            cardId: source.cardId,
            controllerId: source.controllerId,
          }),
        );
        yield* moveObjects(
          ctx,
          matching,
          effect.op === 'graveyardToBattlefieldEach'
            ? { zone: 'battlefield', controllerId: source.controllerId }
            : { zone: 'hand' },
        );
        break;
      }
      case 'returnOneFromYourGraveyardToBattlefield': {
        const owner = playerById(ctx, source.controllerId);
        const candidates = owner.graveyard.filter((card) =>
          selectMatches(cardZoneCandidate(ctx, card, owner.id), effect.filter, {
            cardId: source.cardId,
            controllerId: source.controllerId,
          }),
        );
        if (candidates.length === 0) break;
        let selected = candidates[0]!;
        if (new Set(candidates.map((card) => card.name)).size > 1) {
          const choice = yield {
            decisionType: 'general',
            player: source.controllerId,
            prompt: `${source.name}: choose a card to return from your graveyard to the battlefield`,
            presentationSource: presentedSource(ctx, source),
            // No raw `payload`: graveyard cards have no click affordance in the viewer, so a
            // payload-derived `subjectId` would strand the option (see Kairi above).
            options: candidates.map((card) =>
              cardOption(ctx, card, {
                viewerId: source.controllerId,
                type: 'choose',
                description: `Return ${card.name} to the battlefield`,
                verb: 'Return',
                role: 'affirm',
              }),
            ),
          };
          selected = candidates[choice.index] ?? selected;
        }
        emit(ctx, 'graveyardToBattlefield', { target: selected.name, source: source.name });
        yield* moveObject(ctx, selected, {
          zone: 'battlefield',
          controllerId: source.controllerId,
        });
        break;
      }
      case 'grantHasteOnResolution': {
        // Paired with a reanimation op on the same slot, so the returned creature can attack the
        // turn it arrives. Until end of turn, like every other printed "gains haste" rider.
        const t = ref(effect.target);
        const perm = t === null ? undefined : findPermanent(ctx, t);
        if (perm === undefined) break;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} gains haste until end of turn`,
          targetCardIds: [perm.cardId],
          kind: 'grantKeyword',
          keyword: 'haste',
          timestamp: ctx.state.nextTimestamp++,
        });
        break;
      }
      case 'copyEachTargetedSpell': {
        // Display of Power's "copy any number of target instant or sorcery spells": one copy per
        // chosen spell, each controlled by this ability's controller (CR 707.10).
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          const original = ctx.state.stack.find(
            (entry) => entry.id === id && entry.kind === 'spell',
          );
          if (original === undefined) continue;
          yield* copySpellOnStack(
            ctx,
            original,
            controller.id,
            source.name,
            effect.newTargets === true,
          );
        }
        break;
      }
      case 'removeCounters': {
        const id = ref(effect.target);
        const permanent = id === null ? undefined : findPermanent(ctx, id);
        if (permanent === undefined) break;
        const present = counterCount(permanent.counters, effect.counter);
        const removed = Math.min(present, amountOf(effect.count));
        if (removed <= 0) break;
        if (removed === present) delete permanent.counters[effect.counter];
        else setCounterCount(permanent.counters, effect.counter, present - removed);
        expireCounterBoundAttackRestrictions(permanent);
        emit(ctx, 'removeCounter', {
          target: permanent.name,
          counter: effect.counter,
          count: removed,
        });
        break;
      }
      case 'removeCountersEach': {
        // The counterpart to `putCountersEach`, and NOT symmetric with it: removal is capped at
        // what is actually there (CR 122.1c — you cannot remove counters a permanent lacks), and
        // the key is deleted at zero so `hasCounters`/`sourceHasCounters` read a clean absence
        // rather than a lingering 0.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          const present = counterCount(perm.counters, effect.counter);
          const removed = Math.min(present, amountOf(effect.count));
          if (removed <= 0) continue;
          const left = present - removed;
          if (left === 0) delete perm.counters[effect.counter];
          else setCounterCount(perm.counters, effect.counter, left);
          expireCounterBoundAttackRestrictions(perm);
          emit(ctx, 'removeCounter', {
            target: perm.name,
            counter: effect.counter,
            count: removed,
          });
        }
        break;
      }
      case 'doubleCountersTarget': {
        const t = ref(effect.target);
        const perm = t === null ? undefined : findPermanent(ctx, t);
        if (perm === undefined) break;
        for (const [counter, count] of Object.entries(perm.counters)) {
          if (count > 0) addCounters(ctx, source, perm, counter, count);
        }
        break;
      }
      case 'doubleCountersEachChosen':
        for (const perm of legalChosenPermanents(effect.targetSlot)) {
          for (const [counter, count] of Object.entries(perm.counters)) {
            if (count > 0) addCounters(ctx, source, perm, counter, count);
          }
        }
        break;
      case 'doubleCountersEach':
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          for (const [counter, count] of Object.entries(perm.counters)) {
            if (count > 0) addCounters(ctx, source, perm, counter, count);
          }
        }
        break;
      case 'giveTargetPoisonCounters': {
        const count = amountOf(effect.count);
        const players =
          effect.target === 'eachOpponent'
            ? opponentsOf(ctx, controller.id)
            : (() => {
                const id = ref(effect.target);
                const player = id === null ? undefined : ctx.state.players.find((p) => p.id === id);
                return player === undefined ? [] : [player];
              })();
        for (const player of players) {
          player.poisonCounters += count;
          emit(
            ctx,
            'counters',
            {
              source: source.name,
              target: player.id,
              counter: 'poison',
              added: count,
              total: player.poisonCounters,
            },
            controller.id,
          );
        }
        break;
      }
      case 'createEmblem': {
        const ownerId = effect.forPlayer === undefined ? controller.id : ref(effect.forPlayer);
        const owner =
          ownerId === null ? undefined : ctx.state.players.find((player) => player.id === ownerId);
        if (owner === undefined || owner.hasLost) break;
        owner.emblems.push({
          id: `emblem-${ctx.state.nextObjectNum++}`,
          name: effect.name,
          controllerId: owner.id,
          abilities: effect.abilities,
        });
        emit(ctx, 'createEmblem', { player: owner.id, name: effect.name }, owner.id);
        break;
      }
      case 'gainEnergy': {
        const amount = amountOf(effect.amount);
        if (amount > 0) {
          controller.energy += amount;
          emit(
            ctx,
            'energy',
            { player: controller.id, amount, total: controller.energy },
            controller.id,
          );
        }
        break;
      }
      case 'mill': {
        const count = amountOf(effect.count);
        for (let i = 0; i < count; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          yield* moveObject(ctx, top, { zone: 'graveyard' });
          emit(
            ctx,
            'mill',
            { player: controller.id, cardId: top.cardId, name: top.name },
            controller.id,
          );
        }
        break;
      }
      case 'draw': {
        const drawingPlayer = drawRecipient(effect.player);
        yield* drawCards(ctx, drawingPlayer, amountOf(effect.count));
        break;
      }
      case 'discard':
        yield* discardCards(ctx, controller, effect.count);
        break;
      case 'connive': {
        // CR 701.50a: draw a card, then discard a card; a nonland discard puts a +1/+1 counter
        // on the conniving permanent. CR 701.50c: if it has left the battlefield, its controller
        // still draws and discards, and no counter is put on anything.
        yield* drawCards(ctx, controller, 1);
        const [discarded] = yield* discardCards(ctx, controller, 1);
        if (discarded === undefined || !discarded.characteristicsKnown) break;
        const def = getDefByOracleId(ctx, discarded.card.oracleId, discarded.card.name);
        const conniver = sourcePermanent();
        if (!def.types.includes('Land') && conniver !== undefined)
          addCounters(ctx, source, conniver, '+1/+1', 1);
        break;
      }
      case 'putFromHandOnLibraryTop':
        yield* putFromHandOnLibraryTop(
          ctx,
          source,
          controller,
          amountOf(effect.count),
          effect.anyOrder,
        );
        break;
      case 'discardAtRandom':
        yield* discardAtRandomCards(ctx, controller, amountOf(effect.count));
        break;
      case 'discardTarget': {
        const playerId = ref(effect.target);
        const player = ctx.state.players.find((candidate) => candidate.id === playerId);
        if (player === undefined || player.hasLost) break;
        if (effect.atRandom === true)
          yield* discardAtRandomCards(ctx, player, amountOf(effect.count));
        else yield* discardCards(ctx, player, amountOf(effect.count));
        break;
      }
      case 'discardOrLoseLife': {
        const player = ctx.state.players.find((candidate) => candidate.id === ref(effect.target));
        if (player === undefined || player.hasLost) break;
        const amount = amountOf(effect.amount);
        const card = yield* chooseCard(ctx, {
          player: player.id,
          prompt: `Discard a card or lose ${amount} life.`,
          cards: player.hand,
          type: 'discard',
          verb: 'Discard',
          decline: {
            type: 'decline',
            description: `Lose ${amount} life`,
            verb: `Lose ${amount} life`,
          },
        });
        if (card === null) loseLife(ctx, player, amount);
        else yield* discardCard(ctx, card, player.id);
        break;
      }
      case 'sacrificeNonlandOrDiscardOrLoseLife': {
        const player = ctx.state.players.find((candidate) => candidate.id === ref(effect.target));
        if (player === undefined || player.hasLost) break;
        const permanents = ctx.state.battlefield.filter(
          (permanent) =>
            permanent.controllerId === player.id &&
            canBeSacrificed(ctx, permanent) &&
            !computeCharacteristics(ctx, permanent).types.includes('Land'),
        );
        const choices = [
          { type: 'loseLife', description: `Lose ${amountOf(effect.amount)} life` },
          ...(permanents.length === 0
            ? []
            : [{ type: 'sacrifice', description: 'Sacrifice a nonland permanent' }]),
          ...(player.hand.length === 0 ? [] : [{ type: 'discard', description: 'Discard a card' }]),
        ];
        const outcome = yield {
          decisionType: 'general' as const,
          player: player.id,
          prompt: 'Lose life unless you sacrifice a nonland permanent or discard a card.',
          options: choices,
        };
        const choice = choices[outcome.index];
        if (choice?.type === 'sacrifice') {
          const permanent = yield* chooseCard(ctx, {
            player: player.id,
            prompt: 'Sacrifice a nonland permanent.',
            cards: permanents,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (permanent !== null)
            yield* movePermanentsToGraveyard(ctx, [permanent as EnginePermanent], 'sacrifice');
        } else if (choice?.type === 'discard') {
          yield* discardCards(ctx, player, 1);
        } else loseLife(ctx, player, amountOf(effect.amount));
        break;
      }
      case 'millEachPlayer': {
        const count = Math.max(0, Math.floor(amountOf(effect.count)));
        for (const player of playersInApnapOrder(ctx)) {
          if (player.hasLost || (effect.scope === 'opponents' && player.id === controller.id))
            continue;
          for (let i = 0; i < count; i++) {
            const top = player.library[0];
            if (top === undefined) break;
            yield* moveObject(ctx, top, { zone: 'graveyard' });
            emit(
              ctx,
              'mill',
              { player: player.id, cardId: top.cardId, name: top.name },
              controller.id,
            );
          }
        }
        break;
      }
      case 'discardChosenPlayers': {
        const chosen = new Set(chosenReferents(effect.targetSlot));
        const count = Math.max(0, Math.floor(amountOf(effect.count)));
        const selections: { player: EnginePlayerState; cards: EngineCardObject[] }[] = [];
        for (const player of playersInApnapOrder(ctx)) {
          if (player.hasLost || !chosen.has(player.id)) continue;
          const cards: EngineCardObject[] = [];
          for (let i = 0; i < count; i++) {
            const available = player.hand.filter((card) => !cards.includes(card));
            if (available.length === 0) break;
            const card = yield* chooseCard(ctx, {
              player: player.id,
              prompt: `Discard a card (${i + 1} of ${count}).`,
              cards: available,
              type: 'discard',
              verb: 'Discard',
            });
            if (card === null) throw new Error('engine bug: discard choice was not in hand');
            cards.push(card);
          }
          selections.push({ player, cards });
        }
        for (const selection of selections)
          for (const card of selection.cards) yield* discardCard(ctx, card, selection.player.id);
        break;
      }
      case 'millAndLoseLifeChosenPlayers': {
        const chosen = new Set(chosenReferents(effect.targetSlot));
        const count = Math.max(0, Math.floor(amountOf(effect.count)));
        const amount = amountOf(effect.amount);
        const players = playersInApnapOrder(ctx).filter(
          (player) => !player.hasLost && chosen.has(player.id),
        );
        for (const player of players)
          for (let i = 0; i < count; i++) {
            const top = player.library[0];
            if (top === undefined) break;
            yield* moveObject(ctx, top, { zone: 'graveyard' });
            emit(
              ctx,
              'mill',
              { player: player.id, cardId: top.cardId, name: top.name },
              controller.id,
            );
          }
        for (const player of players) loseLife(ctx, player, amount);
        break;
      }
      case 'eachPlayerLosesLifeAndDraws': {
        const players = playersInApnapOrder(ctx).filter((player) => !player.hasLost);
        const amount = amountOf(effect.amount);
        const count = amountOf(effect.count);
        for (const player of players) loseLife(ctx, player, amount);
        for (const player of players) yield* drawCards(ctx, player, count);
        break;
      }
      case 'revealHandAndDiscard': {
        const playerId = ref(effect.target);
        const player = ctx.state.players.find((candidate) => candidate.id === playerId);
        if (player === undefined || player.hasLost) break;
        for (const card of player.hand)
          emit(
            ctx,
            'revealCard',
            { player: player.id, cardId: card.cardId, name: card.name, revealed: true },
            player.id,
          );
        const eligible = player.hand.filter((card) =>
          selectMatches(cardZoneCandidate(ctx, card, player.id), effect.filter, {
            cardId: source.cardId,
            ...(source.id === undefined ? {} : { objectId: source.id }),
            controllerId: controller.id,
          }),
        );
        if (eligible.length === 0) break;
        const selected = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `Choose a card from ${player.id}'s revealed hand to discard.`,
          cards: eligible,
          type: 'discard',
          verb: 'Discard',
        });
        if (selected === null)
          throw new Error('engine bug: revealed hand discard choice was invalid');
        yield* discardCard(ctx, selected as EngineCardObject, player.id);
        break;
      }
      case 'discardEachPlayer': {
        const count = Math.max(0, Math.floor(amountOf(effect.count)));
        const unableLife =
          effect.opponentsUnableLoseLife === undefined
            ? 0
            : amountOf(effect.opponentsUnableLoseLife);
        const selections: { player: EnginePlayerState; cards: EngineCardObject[] }[] = [];
        for (const player of playersInApnapOrder(ctx)) {
          if (player.hasLost || (effect.scope === 'opponents' && player.id === controller.id))
            continue;
          const cards: EngineCardObject[] = [];
          let chosenCount = count;
          let nonlandOnly = false;
          if (
            effect.nonlandMaySatisfyCount === true &&
            player.hand.some(
              (card) => !getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Land'),
            )
          ) {
            const outcome = yield {
              decisionType: 'general' as const,
              player: player.id,
              prompt: 'Discard a nonland card or discard two cards.',
              options: [
                { type: 'chooseEffect', description: 'Discard one nonland card' },
                { type: 'chooseEffect', description: 'Discard two cards' },
              ],
            };
            if (outcome.index === 0) {
              chosenCount = 1;
              nonlandOnly = true;
            }
          }
          for (let index = 0; index < chosenCount; index++) {
            const available = player.hand.filter(
              (card) =>
                !cards.includes(card) &&
                (!nonlandOnly ||
                  !getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Land')),
            );
            if (available.length === 0) break;
            const card =
              effect.atRandom === true
                ? available[ctx.rng.nextInt(available.length)]
                : yield* chooseCard(ctx, {
                    player: player.id,
                    prompt: `Discard a card (${index + 1} of ${chosenCount}).`,
                    cards: available,
                    type: 'discard',
                    verb: 'Discard',
                  });
            if (card == null) throw new Error('engine bug: discard choice was not in hand');
            cards.push(card as EngineCardObject);
          }
          selections.push({ player, cards });
        }
        let discarded = 0;
        for (const selection of selections) {
          for (const card of selection.cards) {
            yield* discardCard(ctx, card, selection.player.id);
            discarded++;
          }
        }
        if (effect.drawForDiscarded === true) yield* drawCards(ctx, controller, discarded);
        for (const selection of selections)
          if (
            selection.player.id !== controller.id &&
            selection.cards.length === 0 &&
            count > 0 &&
            unableLife > 0
          )
            loseLife(ctx, selection.player, unableLife);
        break;
      }
      case 'gainLife':
        gainLife(ctx, controller, amountOf(effect.amount));
        break;
      case 'loseLife':
        loseLife(ctx, controller, amountOf(effect.amount));
        break;
      case 'eachOpponentLosesLife': {
        // The amount is evaluated ONCE (CR 608.2h) and applied to each opponent. What each
        // one ACTUALLY lost is banked for a later "life lost this way" clause, since a
        // life-loss floor can make the real loss smaller than the amount asked for.
        const requested = amountOf(effect.amount);
        for (const opp of opponentsOf(ctx, controller.id)) {
          if (effect.emptyHandOnly === true && opp.hand.length !== 0) continue;
          const before = opp.life;
          loseLife(ctx, opp, requested);
          lifeLostThisWay += before - opp.life;
        }
        break;
      }
      case 'gainLifeEqualToLifeLostThisWay':
        if (lifeLostThisWay > 0) gainLife(ctx, controller, lifeLostThisWay);
        break;
      case 'loseLifeTarget':
      case 'loseHalfLifeTarget': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const before = target.life;
        loseLife(
          ctx,
          target,
          effect.op === 'loseLifeTarget'
            ? amountOf(effect.amount)
            : Math.ceil(Math.max(0, target.life) / 2),
        );
        // What the player actually lost, for a following "life lost this way".
        lifeLostThisWay += before - target.life;
        break;
      }
      case 'eachOpponentDamage': {
        // The source's own lifelink and infect apply, last-known if it has left (CR 702.15b,
        // 702.90b): the shared object path reads them, as for any other noncombat damage.
        const amount = amountOf(effect.amount);
        for (const opp of opponentsOf(ctx, controller.id))
          yield* dealDamageToObject(ctx, source, opp.id, amount);
        break;
      }
      case 'damageEachCreatureController': {
        // This is intentionally one resolving effect. It deals one damage per creature, but
        // never creates one player decision/trigger per creature.
        const amount = amountOf(effect.amount);
        const creatures = ctx.state.battlefield.filter((perm) =>
          computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        for (const creature of creatures) {
          const owner = playerById(ctx, creature.controllerId);
          yield* dealDamageToPlayer(ctx, source, owner, amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        }
        break;
      }
      case 'angelGrace':
        // Opponents can only win here as the last player left (CR 104.2a), which "can't lose"
        // already rules out.
        (ctx.state.cantLoseTurn ??= {})[controller.id] = ctx.state.turnNumber;
        ctx.state.lifeFloorPlayers[controller.id] = true;
        emit(ctx, 'lifeFloor', { player: controller.id, minimum: 1 });
        break;
      case 'drawForEachOpponent': {
        // Cut a Deal (CR 608.2g/h: the instructions resolve one after the other). Each
        // opponent still in the game (a lost player is out and draws nothing) draws one
        // card, in APNAP order (CR 101.4). Then the SECOND instruction's count reads what
        // actually happened: only an opponent whose draw succeeded — a card reached their
        // hand and the `draw` event fired — is "each opponent who drew a card this way".
        // An empty-library draw whose replacement reanimated a creature is not a draw, and
        // neither is the empty-library flag itself. No state-based action runs between the
        // draws: the empty-library flag waits for the next SBA check, and the caster's own
        // draws resolve with the count fixed before they begin.
        let opponentsWhoDrew = 0;
        for (const opponent of opponentsOf(ctx, controller.id))
          if ((yield* drawCards(ctx, opponent, 1)) >= 1) opponentsWhoDrew += 1;
        yield* drawCards(ctx, controller, opponentsWhoDrew);
        break;
      }
      case 'drawTargetAndController': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        // "You and target opponent each draw": the players draw in APNAP order (CR 101.4).
        for (const drawer of playersInApnapOrder(ctx)) {
          if (drawer.id === controller.id || drawer.id === target.id) {
            yield* drawCards(ctx, drawer, 1);
          }
        }
        break;
      }
      case 'drawTargetAndControllerN': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        // "You and target opponent each draw": the players draw in APNAP order (CR 101.4).
        for (const drawer of playersInApnapOrder(ctx)) {
          if (drawer.id === controller.id || drawer.id === target.id) {
            yield* drawCards(ctx, drawer, effect.count);
          }
        }
        break;
      }
      case 'drawTarget': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        yield* drawCards(ctx, target, amountOf(effect.count));
        break;
      }
      case 'schemingSymmetry': {
        const targetIds = new Set(chosenReferents(effect.targetSlot));
        const searchers = playersInApnapOrder(ctx).filter(
          (player) => !player.hasLost && targetIds.has(player.id),
        );
        const selections: { player: EnginePlayerState; card: EngineCardObject | null }[] = [];
        // Unrestricted searches must find a card in a nonempty library. Hidden choices are made
        // in APNAP order; a search never targets or reveals the found card (CR 101.4, 701.19).
        for (const player of searchers) {
          const card =
            player.library.length === 0
              ? null
              : yield* chooseCard(ctx, {
                  player: player.id,
                  prompt: `${source.name}: choose a card to put on top of your library`,
                  cards: player.library,
                  type: 'search',
                  verb: 'Choose',
                });
          if (player.library.length > 0 && card === null)
            throw new Error('engine bug: mandatory library search did not choose a card');
          selections.push({ player, card });
        }
        for (const { player, card } of selections) {
          // Set the found card aside during the shuffle, retaining its library object identity
          // (CR 701.19b). Even an empty library is shuffled. No moveObject/zone-change event occurs.
          if (card !== null) player.library.splice(player.library.indexOf(card), 1);
          shuffleLibrary(ctx, player);
        }
        for (const { player, card } of selections) if (card !== null) player.library.unshift(card);
        break;
      }
      case 'kambal': {
        const caster =
          scope.eventPlayerId === undefined ? undefined : playerById(ctx, scope.eventPlayerId);
        if (caster === undefined) break;
        loseLife(ctx, caster, 2);
        gainLife(ctx, controller, 2);
        break;
      }
      case 'inkshield':
        ctx.state.combatDamagePrevention.players[controller.id] = true;
        if (ctx.state.combatDamagePrevention.tokenSpecs === undefined)
          ctx.state.combatDamagePrevention.tokenSpecs = {};
        ctx.state.combatDamagePrevention.tokenSpecs[controller.id] = {
          name: 'Inkling',
          typeLine: 'Creature — Inkling',
          types: ['Creature'],
          subtypes: ['Inkling'],
          colors: ['W', 'B'],
          power: 2,
          toughness: 1,
          keywords: ['flying'],
        };
        break;
      case 'gisela':
        emit(ctx, 'damageReplacement', {
          source: source.name,
          rule: 'double damage to opponents; prevent half damage to controller',
        });
        break;
      case 'humbleDefector': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        const permanent = ctx.state.battlefield.find(
          (p) => p.cardId === source.cardId && (source.id === undefined || p.id === source.id),
        );
        if (target === undefined || permanent === undefined) break;
        yield* drawCards(ctx, controller, 2);
        changeController(ctx, permanent, target.id);
        break;
      }
      case 'shadrixModes': {
        const players = ctx.state.players.filter((p) => !p.hasLost);
        const choosePlayer = function* (
          prompt: string,
          excluded: PlayerId | undefined,
        ): GameGen<PlayerId> {
          const eligible = players.filter((p) => p.id !== excluded);
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt,
            options: eligible.map((p) => ({
              type: 'choosePlayer',
              description: p.id,
              payload: p.id,
            })),
          };
          return eligible[outcome.index]?.id ?? eligible[0]?.id ?? controller.id;
        };
        const first = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose the first mode`,
          options: [
            { type: 'token', description: 'Target player creates an Inkling' },
            { type: 'draw', description: 'Target player draws a card and loses 1 life' },
            {
              type: 'counter',
              description: 'Target player puts a +1/+1 counter on each creature they control',
            },
          ],
        };
        const firstPlayer = yield* choosePlayer(
          `${source.name}: choose the first target player`,
          undefined,
        );
        const second = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose the second mode`,
          options: [
            { type: 'token', description: 'Target player creates an Inkling' },
            { type: 'draw', description: 'Target player draws a card and loses 1 life' },
            {
              type: 'counter',
              description: 'Target player puts a +1/+1 counter on each creature they control',
            },
          ],
        };
        const secondPlayer = yield* choosePlayer(
          `${source.name}: choose the second target player`,
          firstPlayer,
        );
        for (const [mode, playerId] of [
          [first.index, firstPlayer],
          [second.index, secondPlayer],
        ] as [number, PlayerId][]) {
          const player = playerById(ctx, playerId);
          if (mode === 0)
            createToken(
              ctx,
              {
                name: 'Inkling',
                typeLine: 'Creature — Inkling',
                types: ['Creature'],
                subtypes: ['Inkling'],
                colors: ['W', 'B'],
                power: 2,
                toughness: 1,
                keywords: ['flying'],
              },
              player.id,
            );
          else if (mode === 1) {
            yield* drawCards(ctx, player, 1);
            loseLife(ctx, player, 1);
          } else
            for (const perm of ctx.state.battlefield.filter(
              (p) =>
                p.controllerId === player.id &&
                computeCharacteristics(ctx, p).types.includes('Creature'),
            ))
              addCounters(ctx, source, perm, '+1/+1', 1);
        }
        break;
      }
      case 'masterOfCeremonies': {
        for (const opponent of opponentsOf(ctx, controller.id)) {
          const outcome = yield {
            decisionType: 'general',
            player: opponent.id,
            prompt: `${source.name}: choose money, friends, or secrets`,
            options: [
              { type: 'money', description: 'Money' },
              { type: 'friends', description: 'Friends' },
              { type: 'secrets', description: 'Secrets' },
            ],
          };
          if (outcome.index === 0) {
            createToken(
              ctx,
              {
                name: 'Treasure',
                typeLine: 'Artifact — Treasure',
                types: ['Artifact'],
                subtypes: ['Treasure'],
                colors: [],
                power: null,
                toughness: null,
                manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']] }],
              },
              controller.id,
            );
            createToken(
              ctx,
              {
                name: 'Treasure',
                typeLine: 'Artifact — Treasure',
                types: ['Artifact'],
                subtypes: ['Treasure'],
                colors: [],
                power: null,
                toughness: null,
                manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']] }],
              },
              opponent.id,
            );
          } else if (outcome.index === 1) {
            createToken(
              ctx,
              {
                name: 'Citizen',
                typeLine: 'Creature — Citizen',
                types: ['Creature'],
                subtypes: ['Citizen'],
                colors: ['G', 'W'],
                power: 1,
                toughness: 1,
              },
              controller.id,
            );
            createToken(
              ctx,
              {
                name: 'Citizen',
                typeLine: 'Creature — Citizen',
                types: ['Creature'],
                subtypes: ['Citizen'],
                colors: ['G', 'W'],
                power: 1,
                toughness: 1,
              },
              opponent.id,
            );
          } else {
            yield* drawCards(ctx, controller, 1);
            yield* drawCards(ctx, opponent, 1);
          }
        }
        break;
      }
      case 'dealDamageNonbasicLands': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const amount = ctx.state.battlefield.filter((perm) => {
          if (perm.controllerId !== target.id) return false;
          const chars = computeCharacteristics(ctx, perm);
          return chars.types.includes('Land') && !chars.supertypes.includes('Basic');
        }).length;
        yield* dealDamageToPlayer(ctx, source, target, amount, {
          combat: false,
          sourceIsCommander: false,
          sourceHasLifelink: false,
        });
        break;
      }
      case 'sacrificeOneEachOpponent': {
        const selected: EnginePermanent[] = [];
        for (const opponent of opponentsOf(ctx, controller.id)) {
          const filter = effect.filter;
          const permanents = ctx.state.battlefield.filter((perm) => {
            if (perm.controllerId !== opponent.id) return false;
            if (typeof filter !== 'string') return matchesSelector(ctx, perm, filter, source);
            if (filter === 'creature')
              return computeCharacteristics(ctx, perm).types.includes('Creature');
            return !computeCharacteristics(ctx, perm).types.includes('Land');
          });
          const chosen = yield* chooseCard(ctx, {
            player: opponent.id,
            prompt: `${source.name}: choose a permanent to sacrifice`,
            cards: permanents,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (chosen !== null) selected.push(chosen);
        }
        // Choices are made in APNAP order, then all selected permanents leave together.
        yield* movePermanentsToGraveyard(ctx, selected, 'sacrifice');
        break;
      }
      case 'mayPayManaThenReflexive':
      case 'putCountersOnSourceThenReflexive': {
        // CR 603.12: the reflexive ability triggers only on the action actually happening.
        let done = false;
        if (effect.op === 'mayPayManaThenReflexive') {
          done = yield* resolveCondition(
            ctx,
            { kind: 'mayPayMana', cost: effect.cost },
            {
              ...scope,
              cardId: source.cardId,
              controllerId: source.controllerId,
              ...(source.id === undefined ? {} : { objectId: source.id }),
            },
            source.name,
          );
        } else {
          const perm = sourcePermanent();
          done =
            perm !== undefined && addCounters(ctx, source, perm, effect.counter, effect.count) > 0;
        }
        if (!done) break;
        ctx.state.pendingTriggers.push({
          controllerId: source.controllerId,
          sourceCardId: source.cardId,
          ...(source.id === undefined ? {} : { sourceObjectId: source.id }),
          sourceOracleId: source.oracleId,
          sourceName: source.name,
          ability: effect.then,
        });
        break;
      }
      case 'mayPayEnergyThenReflexive': {
        // CR 603.12: the reflexive ability triggers only on energy actually paid, and "that much"
        // is the amount paid, which the pending trigger carries to its own resolution.
        const min = Math.max(1, Math.floor(effect.min));
        const options = [
          plainOption({ type: 'decline', description: 'Pay no energy', verb: 'Decline' }),
          ...Array.from(
            {
              length:
                effect.exact === true
                  ? controller.energy >= min
                    ? 1
                    : 0
                  : Math.max(0, controller.energy - min + 1),
            },
            (_, offset) => {
              const amount = min + offset;
              return valueOption(amount, `Pay ${amount} energy`, {
                type: 'payEnergy',
                description: `Pay ${amount} energy`,
                verb: 'Pay',
              });
            },
          ),
        ];
        // Nothing to offer without enough energy to pay the minimum.
        if (options.length === 1) break;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay energy? (${
            effect.exact === true ? `exactly ${min}` : min === 1 ? 'one or more' : `${min} or more`
          })`,
          options,
        };
        if (outcome.index === 0) break;
        const paid = min + outcome.index - 1;
        controller.energy -= paid;
        emit(ctx, 'energy', { amount: -paid, total: controller.energy }, controller.id);
        ctx.state.pendingTriggers.push({
          controllerId: source.controllerId,
          sourceCardId: source.cardId,
          ...(source.id === undefined ? {} : { sourceObjectId: source.id }),
          sourceOracleId: source.oracleId,
          // The card's own name: while a trigger resolves, `source.name` is that trigger's text.
          sourceName: ctx.defs.get(source.oracleId)?.name ?? source.name,
          ability: effect.then,
          scope: { energyPaid: paid },
        });
        break;
      }
      case 'sacrificeSourceThenReflexive': {
        const perm = sourcePermanent();
        // Only a permanent you control can be sacrificed (CR 701.21a).
        if (
          perm === undefined ||
          perm.controllerId !== source.controllerId ||
          !canBeSacrificed(ctx, perm)
        )
          break;
        yield* moveObject(ctx, perm, { zone: 'graveyard', reason: 'sacrifice' });
        ctx.state.pendingTriggers.push({
          controllerId: source.controllerId,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          sourceName: source.name,
          ability: effect.then,
        });
        break;
      }
      case 'sacrificeOneThen': {
        const candidates = affectedBy(ctx, source, effect.selector).filter(
          (permanent) => permanent.controllerId === controller.id,
        );
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: choose a permanent to sacrifice`,
          cards: candidates,
          type: 'sacrifice',
          verb: 'Sacrifice',
        });
        if (chosen === null) break;
        yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
        if (effect.then.length > 0) {
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: effect.then },
            targets,
            triggerObjectCardId,
            extraScope,
            countTargets,
            divisionAmounts,
          );
        }
        break;
      }
      case 'sacrificeEachPlayer': {
        // CR 101.4: each player chooses in APNAP order, then everything chosen is sacrificed at
        // once — the same shape as `sacrificeOneEachOpponent`.
        const selected: EnginePermanent[] = [];
        for (const player of playersInApnapOrder(ctx)) {
          for (let i = 0; i < effect.count; i++) {
            const candidates = ctx.state.battlefield.filter(
              (perm) =>
                perm.controllerId === player.id &&
                !selected.includes(perm) &&
                (effect.filter === 'any' ||
                  computeCharacteristics(ctx, perm).types.includes('Creature')),
            );
            if (candidates.length === 0) break;
            // Owing at least as many as they have is no choice at all: all of them go.
            if (candidates.length <= effect.count - i) {
              selected.push(...candidates);
              break;
            }
            const chosen = yield* chooseCard(ctx, {
              player: player.id,
              prompt: `${source.name}: choose a ${effect.filter === 'any' ? 'permanent' : 'creature'} to sacrifice (${i + 1} of ${effect.count})`,
              cards: candidates,
              type: 'sacrifice',
              verb: 'Sacrifice',
            });
            if (chosen === null) break;
            selected.push(chosen);
          }
        }
        yield* movePermanentsToGraveyard(ctx, selected, 'sacrifice');
        break;
      }
      case 'eventPlayerSacrificesPermanents': {
        const player =
          scope.eventPlayerId === undefined ? undefined : playerById(ctx, scope.eventPlayerId);
        if (player === undefined || player.hasLost) break;
        const count = amountOf(effect.count);
        const selected: EnginePermanent[] = [];
        for (let i = 0; i < count; i++) {
          const candidates = ctx.state.battlefield.filter(
            (perm) => perm.controllerId === player.id && !selected.includes(perm),
          );
          if (candidates.length === 0) break;
          // Owing at least as many as they have is no choice at all: all of them go.
          if (candidates.length <= count - i) {
            selected.push(...candidates);
            break;
          }
          const chosen = yield* chooseCard(ctx, {
            player: player.id,
            prompt: `${source.name}: choose a permanent to sacrifice (${i + 1} of ${count})`,
            cards: candidates,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (chosen === null) break;
          selected.push(chosen);
        }
        yield* movePermanentsToGraveyard(ctx, selected, 'sacrifice');
        break;
      }
      case 'sacrificeAndDrawForPower': {
        const candidates = ctx.state.battlefield.filter(
          (perm) =>
            perm.controllerId === controller.id &&
            perm.cardId !== source.cardId &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: sacrifice another creature`,
          cards: candidates,
          type: 'sacrifice',
          verb: 'Sacrifice',
        });
        if (chosen !== null) {
          const power = effectivePT(ctx, chosen as EnginePermanent).power;
          yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
          gainLife(ctx, controller, power);
          yield* drawCards(ctx, controller, power);
        }
        break;
      }
      case 'sacrificeGreatestEachOpponent': {
        // A permanent's own mana value: a face-down permanent's is 0 (CR 708.2).
        const metricOf = (perm: EnginePermanent): number =>
          effect.metric === 'power' ? effectivePT(ctx, perm).power : permanentManaValue(ctx, perm);
        const selected: EnginePermanent[] = [];
        const hits: { player: EnginePlayerState; amount: number }[] = [];
        for (const opponent of opponentsOf(ctx, controller.id)) {
          const candidates = ctx.state.battlefield.filter(
            (perm) =>
              perm.controllerId === opponent.id &&
              (() => {
                const chars = computeCharacteristics(ctx, perm);
                return (
                  chars.types.includes('Creature') ||
                  (effect.selector === 'creatureOrPlaneswalker' &&
                    chars.types.includes('Planeswalker'))
                );
              })(),
          );
          const greatest = Math.max(-Infinity, ...candidates.map((perm) => metricOf(perm)));
          const choices = candidates.filter((perm) => metricOf(perm) === greatest);
          const metricLabel = effect.metric === 'power' ? 'power' : 'mana value';
          const verb = effect.action === 'exile' ? 'Exile' : 'Sacrifice';
          const chosen = yield* chooseCard(ctx, {
            player: opponent.id,
            prompt: `${source.name}: ${verb.toLowerCase()} a permanent with the greatest ${metricLabel}`,
            cards: choices,
            type: effect.action,
            verb,
          });
          if (chosen !== null) {
            selected.push(chosen);
            hits.push({ player: opponent, amount: metricOf(chosen) });
          }
        }
        // CR 101.4: each opponent chooses in APNAP order, then all of them are moved at once.
        if (effect.action === 'exile') {
          const moved = yield* moveObjects(ctx, selected, { zone: 'exile' });
          const threshold = effect.damageIfGraveyardSpellsAtLeast;
          if (
            threshold !== undefined &&
            controller.graveyard.filter((card) => {
              const def = getDefByOracleId(ctx, card.oracleId, card.name);
              return def.types.includes('Instant') || def.types.includes('Sorcery');
            }).length >= threshold
          ) {
            yield* dealDamageToPlayersTogether(
              ctx,
              source,
              hits.filter((_, index) => selected[index]?.isToken || moved[index]?.zone === 'exile'),
            );
          }
        } else yield* movePermanentsToGraveyard(ctx, selected, 'sacrifice');
        break;
      }
      case 'transferCountersFromTriggerObject': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        const counters = eventObjectFacts(ctx, scope)?.counters;
        if (target !== undefined && counters !== undefined) {
          for (const [counter, count] of Object.entries(counters)) {
            addCounters(ctx, source, target, counter, count);
          }
        }
        break;
      }
      case 'transferCountersFromTriggerObjectToChosenCreatures': {
        const counters = eventObjectFacts(ctx, scope)?.counters;
        if (counters !== undefined)
          for (const target of legalChosenPermanents(effect.targetSlot))
            for (const [counter, count] of Object.entries(counters))
              addCounters(ctx, source, target, counter, count);
        break;
      }
      case 'mayForgoTriggerObjectCombatDamageForRandomDiscard': {
        const creatureId = scope.triggerObjectId ?? scope.eventObjectId;
        const creature = ctx.state.battlefield.find((permanent) => permanent.id === creatureId);
        const defender = ctx.state.players.find((player) => player.id === scope.eventPlayerId);
        if (creature === undefined || defender === undefined || defender.hasLost) break;
        const outcome = yield {
          decisionType: 'optionalTrigger' as const,
          player: controller.id,
          prompt: `${source.name}: have ${creature.name} assign no combat damage this turn?`,
          options: [
            {
              type: 'acceptTrigger',
              description: 'Assign no combat damage; defending player discards at random',
            },
            { type: 'declineTrigger', description: 'Decline' },
          ],
        };
        if (outcome.index === 0) {
          creature.assignsNoCombatDamageTurn = ctx.state.turnNumber;
          yield* discardAtRandomCards(ctx, defender, 1);
        }
        break;
      }
      case 'gainClassLevel': {
        const permanent = sourcePermanent();
        if (
          permanent !== undefined &&
          computeCharacteristics(ctx, permanent).subtypes.includes('Class') &&
          (permanent.classLevel ?? 1) + 1 === effect.level
        ) {
          permanent.classLevel = effect.level;
          emit(
            ctx,
            'classLevelGained',
            { cardId: permanent.cardId, name: permanent.name, level: effect.level },
            controller.id,
          );
        }
        break;
      }
      case 'drawForOpponentsWithSmallHands': {
        const count = opponentsOf(ctx, controller.id).filter(
          (player) => !player.hasLost && player.hand.length <= effect.maximum,
        ).length;
        yield* drawCards(ctx, controller, count);
        break;
      }
      case 'transferCountersFromSource': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        const counters = sourceObjectFacts(ctx, scope)?.counters;
        if (target !== undefined && counters !== undefined) {
          for (const [counter, count] of Object.entries(counters))
            addCounters(ctx, source, target, counter, count);
        }
        break;
      }
      case 'bolster': {
        const creatures = ctx.state.battlefield.filter(
          (perm) =>
            perm.controllerId === controller.id &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        if (creatures.length === 0) break;
        const toughness = (perm: EnginePermanent) => effectivePT(ctx, perm).toughness;
        const least = Math.min(...creatures.map(toughness));
        const tied = creatures.filter((perm) => toughness(perm) === least);
        const chosen =
          tied.length === 1
            ? tied[0]
            : yield* chooseCard(ctx, {
                player: controller.id,
                prompt: `${source.name}: bolster ${effect.count} — choose a creature with the least toughness`,
                cards: tied,
                type: 'bolster',
                verb: 'Bolster',
              });
        if (chosen !== null && chosen !== undefined)
          addCounters(ctx, source, chosen, '+1/+1', effect.count);
        break;
      }
      case 'distributeCountersFromSource': {
        const selfId = ref('source');
        const self = selfId === null ? undefined : findPermanent(ctx, selfId);
        if (self === undefined) break;
        const available = counterCount(self.counters, effect.counter);
        const recipients = ctx.state.battlefield.filter(
          (perm) =>
            perm.id !== self.id &&
            matchesSelector(ctx, perm, effect.selector, {
              cardId: self.cardId,
              objectId: self.id,
              controllerId: self.controllerId,
            }),
        );
        // Choose the whole division first (CR 122.5: the counters move together).
        const assigned = new Map<string, number>();
        let total = 0;
        while (total < available && recipients.length > 0) {
          const chosen = yield* chooseCard(ctx, {
            player: controller.id,
            prompt: `${source.name}: move a ${effect.counter} counter onto another creature (${available - total} left)`,
            cards: recipients,
            type: 'moveCounter',
            verb: 'Move',
            describe: (perm) =>
              `Move a ${effect.counter} counter onto ${perm.name} (${(assigned.get(perm.id) ?? 0) + 1})`,
            decline: { type: 'decline', description: 'Move no more counters', verb: 'Stop' },
          });
          if (chosen === null) break;
          assigned.set(chosen.id, (assigned.get(chosen.id) ?? 0) + 1);
          total++;
        }
        if (total === 0) break;
        if (total === available) delete self.counters[effect.counter];
        else setCounterCount(self.counters, effect.counter, available - total);
        expireCounterBoundAttackRestrictions(self);
        emit(ctx, 'removeCounter', { target: self.name, counter: effect.counter, count: total });
        for (const [id, count] of assigned) {
          const recipient = findPermanent(ctx, id);
          if (recipient !== undefined) addCounters(ctx, source, recipient, effect.counter, count);
        }
        break;
      }
      case 'moveCounters': {
        const fromId = ref(effect.from);
        const toId = ref(effect.to);
        const from = fromId === null ? undefined : findPermanent(ctx, fromId);
        const to = toId === null ? undefined : findPermanent(ctx, toId);
        if (from === undefined || to === undefined || from.id === to.id) break;
        const present = counterCount(from.counters, effect.counter);
        const moved = Math.min(present, effect.count);
        if (moved <= 0) break;
        if (moved === present) delete from.counters[effect.counter];
        else setCounterCount(from.counters, effect.counter, present - moved);
        expireCounterBoundAttackRestrictions(from);
        emit(ctx, 'removeCounter', { target: from.name, counter: effect.counter, count: moved });
        addCounters(ctx, source, to, effect.counter, moved);
        break;
      }
      case 'mayPayLifeForTriggerPowerAndCounter': {
        const facts = eventObjectFacts(ctx, scope);
        if (facts === undefined) break;
        const power = Math.max(0, facts.power);
        // Life is a payment, including zero, rather than loss that may drive life negative.
        if (power > 0 && controller.life < power) break;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay ${power} life to put ${power} +1/+1 counter(s) on the entering creature?`,
          options: [
            { type: 'payLife', description: `Pay ${power} life and add ${power} counter(s)` },
            { type: 'decline', description: 'Decline' },
          ],
        };
        if (outcome.index === 0) {
          payLife(ctx, controller, power);
          const currentId = ref('triggerObject');
          const entering = currentId === null ? undefined : findPermanent(ctx, currentId);
          if (entering !== undefined) {
            addCounters(ctx, source, entering, '+1/+1', power);
          }
        }
        break;
      }
      case 'vindictiveLichModes': {
        const mode = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose a mode`,
          options: [
            { type: 'sacrifice', description: 'Target opponent sacrifices a creature' },
            { type: 'discard', description: 'Target opponent discards two cards' },
            { type: 'loseLife', description: 'Target opponent loses 5 life' },
          ],
        };
        const opponents = opponentsOf(ctx, controller.id);
        if (opponents.length === 0) break;
        const selectedOpponent = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose the opponent`,
          options: opponents.map((p) =>
            playerOption(p.id, p.id, {
              type: 'choosePlayer',
              description: p.id,
              payload: p.id,
              verb: 'Choose',
            }),
          ),
        };
        const opponent = opponents[selectedOpponent.index] ?? opponents[0]!;
        if (mode.index === 0) {
          const creatures = ctx.state.battlefield.filter(
            (perm) =>
              perm.controllerId === opponent.id &&
              computeCharacteristics(ctx, perm).types.includes('Creature'),
          );
          const chosen = yield* chooseCard(ctx, {
            player: opponent.id,
            prompt: `${source.name}: choose a creature to sacrifice`,
            cards: creatures,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (chosen !== null)
            yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
        } else if (mode.index === 1) {
          yield* discardCards(ctx, opponent, 2);
        } else {
          loseLife(ctx, opponent, 5);
        }
        break;
      }
      case 'returnExiledAttachedCard': {
        // Only cards this very permanent's Hideaway exiled (CR 607.2a). A copied Hideaway
        // trigger exiles a second linked card, and "the exiled card" means each of them.
        const cards = ctx.state.exile.filter(
          (candidate) =>
            candidate.attachedToCardId === source.cardId &&
            (candidate.attachedToObjectId === undefined ||
              source.id === undefined ||
              candidate.attachedToObjectId === source.id),
        );
        for (const card of cards) {
          delete card.attachedToCardId;
          delete card.attachedToObjectId;
        }
        if (cards.length > 0) yield* moveObjects(ctx, cards, { zone: 'hand' });
        break;
      }
      case 'sacrificeOneCreatureEachPlayer': {
        // CR 101.4: choices in APNAP order, then one simultaneous sacrifice.
        const selected: EnginePermanent[] = [];
        for (const player of playersInApnapOrder(ctx)) {
          const creatures = ctx.state.battlefield.filter(
            (perm) =>
              perm.controllerId === player.id &&
              computeCharacteristics(ctx, perm).types.includes('Creature'),
          );
          const chosen = yield* chooseCard(ctx, {
            player: player.id,
            prompt: `${source.name}: choose a creature to sacrifice`,
            cards: creatures,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (chosen !== null) selected.push(chosen);
        }
        yield* movePermanentsToGraveyard(ctx, selected, 'sacrifice');
        break;
      }
      case 'sacrificeOtherForMana': {
        const candidates = ctx.state.battlefield.filter(
          (perm) =>
            perm.controllerId === controller.id &&
            perm.cardId !== source.cardId &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: sacrifice another creature`,
          cards: candidates,
          type: 'sacrifice',
          verb: 'Sacrifice',
        });
        if (chosen !== null) {
          const value = spellManaValue(
            getDefByOracleId(ctx, chosen.oracleId, chosen.name),
            undefined,
          );
          yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
          for (let i = 0; i < value; i++) controller.manaEntries.push({ symbol: 'B' });
          controller.manaPool.B = (controller.manaPool.B ?? 0) + value;
        }
        break;
      }
      case 'livingDeath': {
        // Each step is one simultaneous event (CR 101.4): every player's graveyard creature cards
        // are exiled together, every creature is sacrificed together, and every exiled card comes
        // back together, each under the player who exiled it (its owner).
        const graveyardCreatures = ctx.state.players.flatMap((player) =>
          player.graveyard.filter((card) =>
            getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Creature'),
          ),
        );
        const exiled = (yield* moveObjects(ctx, graveyardCreatures, { zone: 'exile' })).filter(
          (card): card is EngineCardObject => card !== null && card.zone === 'exile',
        );
        yield* movePermanentsToGraveyard(
          ctx,
          ctx.state.battlefield.filter((perm) =>
            computeCharacteristics(ctx, perm).types.includes('Creature'),
          ),
          'sacrifice',
        );
        // Only the exact cards exiled this way, if they are still in exile (CR 400.7).
        const stillExiled = exiled.filter((card) => ctx.state.exile.includes(card));
        yield* moveObjects(ctx, stillExiled, { zone: 'battlefield' });
        break;
      }
      case 'exileGraveyardCreateTokens': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const cards = [...target.graveyard];
        const count = cards.filter((card) => {
          const types = offBattlefieldTypes(
            ctx,
            getDefByOracleId(ctx, card.oracleId, card.name).types,
            card.ownerId,
          );
          return types.includes('Artifact') || types.includes('Land');
        }).length;
        yield* moveObjects(ctx, cards, { zone: 'exile' });
        for (let i = 0; i < count; i++) createToken(ctx, effect.spec, controller.id);
        break;
      }
      case 'millAndCreateTokensForCreatures': {
        let creatureCount = 0;
        for (let i = 0; i < 3; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          if (getDefByOracleId(ctx, top.oracleId, top.name).types.includes('Creature'))
            creatureCount++;
          yield* moveObject(ctx, top, { zone: 'graveyard' });
        }
        for (let i = 0; i < creatureCount; i++) createToken(ctx, effect.spec, controller.id);
        break;
      }
      case 'returnArtifactCreaturesUpToManaValue': {
        // "Return any number of artifact creature cards with total mana value N or less": choose
        // the whole set first (a mana value 0 card still fits when nothing is left of the budget),
        // then return it as one simultaneous move, so each sees the others enter (CR 603.6a).
        let remaining = effect.maxManaValue;
        const chosen: EngineCardObject[] = [];
        for (;;) {
          const choices = controller.graveyard.filter((card) => {
            if (chosen.includes(card)) return false;
            const def = getDefByOracleId(ctx, card.oracleId, card.name);
            const types = offBattlefieldTypes(ctx, def.types, card.ownerId);
            return (
              types.includes('Artifact') &&
              types.includes('Creature') &&
              spellManaValue(def, undefined) <= remaining
            );
          });
          if (choices.length === 0) break;
          const pick = yield* chooseCard(ctx, {
            player: controller.id,
            prompt: `${source.name}: return an artifact creature (up to ${remaining} mana value)`,
            cards: choices,
            type: 'returnToBattlefield',
            verb: 'Return',
            decline: { type: 'decline', description: 'Return no more cards', verb: 'Done' },
          });
          if (pick === null) break;
          chosen.push(pick);
          remaining -= spellManaValue(getDefByOracleId(ctx, pick.oracleId, pick.name), undefined);
        }
        yield* moveObjects(ctx, chosen, { zone: 'battlefield', controllerId: controller.id });
        break;
      }
      case 'halfLifeDrainTargetOpponent': {
        const opponents = opponentsOf(ctx, controller.id);
        if (opponents.length === 0) break;
        const selected = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose an opponent`,
          options: opponents.map((p) =>
            playerOption(p.id, p.id, {
              type: 'choosePlayer',
              description: p.id,
              payload: p.id,
              verb: 'Choose',
            }),
          ),
        };
        const opponent = opponents[selected.index] ?? opponents[0]!;
        const lost = Math.ceil(Math.max(0, opponent.life) / 2);
        loseLife(ctx, opponent, lost);
        gainLife(ctx, controller, lost);
        break;
      }
      case 'tombBladeHit': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const creatures = ctx.state.battlefield.filter(
          (perm) =>
            perm.controllerId === target.id &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        const chosen = yield* chooseCard(ctx, {
          player: target.id,
          prompt: `${source.name}: sacrifice a creature or lose ${creatures.length} life`,
          cards: creatures,
          type: 'sacrifice',
          verb: 'Sacrifice',
          decline: {
            type: 'decline',
            description: `Lose ${creatures.length} life`,
            verb: 'Decline',
          },
        });
        if (chosen === null) loseLife(ctx, target, creatures.length);
        else yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
        break;
      }
      case 'emptyLibraryCreatureOrLose':
        if (controller.library.length > 0) break;
        {
          const creatures = controller.graveyard.filter((card) =>
            getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Creature'),
          );
          const chosen = yield* chooseCard(ctx, {
            player: controller.id,
            prompt: `${source.name}: return a creature from your graveyard`,
            cards: creatures,
            type: 'returnToBattlefield',
            verb: 'Return',
            decline: { type: 'loseGame', description: 'No creature — lose the game', verb: 'Lose' },
          });
          if (chosen === null) {
            if (!playerCantLose(ctx, controller.id)) controller.hasLost = true;
          } else
            yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: controller.id });
        }
        break;
      case 'grantUnearthToArtifactCreaturesInGraveyard': {
        for (const card of controller.graveyard) {
          const def = ctx.defs.get(card.oracleId);
          const types = def === undefined ? [] : offBattlefieldTypes(ctx, def.types, card.ownerId);
          if (!types.includes('Artifact') || !types.includes('Creature')) continue;
          ctx.state.temporaryGraveyardAbilities[card.cardId] = [
            {
              costs: [{ kind: 'mana', cost: effect.cost }],
              // Unearth is always "activate only as a sorcery" (CR 702.84a), granted or printed.
              timing: 'sorcery',
              zone: 'graveyard',
              ability: {
                kind: 'activated',
                targets: [],
                effects: [{ op: 'unearth' }],
                description: `Unearth ${describeManaCost(effect.cost)}`,
              },
            },
          ];
        }
        break;
      }
      case 'unearth': {
        const card = controller.graveyard.find((candidate) => candidate.cardId === source.cardId);
        if (card === undefined) break;
        yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: controller.id });
        const permanent = ctx.state.battlefield.find(
          (candidate) => candidate.cardId === source.cardId,
        );
        if (permanent === undefined) break;
        permanent.unearthed = true;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${permanent.name} gains haste until end of turn`,
          targetCardIds: [permanent.cardId],
          kind: 'grantKeyword',
          keyword: 'haste',
          timestamp: ctx.state.nextTimestamp++,
        });
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId as never,
          controllerId: controller.id,
          targetId: source.cardId,
          targetObjectId: permanent.id,
          when: 'endStep',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'exile', target: 'triggerObject' }],
            description: 'Exile this permanent',
          },
          expiry: 'endStep',
        });
        break;
      }
      case 'exileSource': {
        const permanent = sourcePermanent();
        if (permanent !== undefined) yield* moveObject(ctx, permanent, { zone: 'exile' });
        break;
      }
      case 'exileResolvingSpell': {
        // The resolving entry has already been popped from the stack. Its final destination
        // is applied once by finishSpellCard, after all instructions finish (CR 608.2).
        if (source.resolvingStackObject !== undefined)
          source.resolvingStackObject.exileOnResolution = true;
        break;
      }
      case 'millTargetPlayer': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        for (let i = 0; i < effect.count; i++) {
          const top = target.library[0];
          if (top === undefined) break;
          yield* moveObject(ctx, top, { zone: 'graveyard' });
          emit(
            ctx,
            'mill',
            { player: target.id, cardId: top.cardId, name: top.name },
            controller.id,
          );
        }
        break;
      }
      case 'millAndChooseArtifact': {
        const milled: (EngineCardObject | EnginePermanent)[] = [];
        for (let i = 0; i < 3; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          const moved = yield* moveObject(ctx, top, { zone: 'graveyard' });
          // CR 701.17c: follow the milled card into its public replacement destination.
          // Retain the new object, never another incarnation of the same physical card.
          if (moved !== null && moved.zone !== 'library' && moved.zone !== 'hand')
            milled.push(moved);
          emit(
            ctx,
            'mill',
            { player: controller.id, cardId: top.cardId, name: top.name },
            controller.id,
          );
        }
        const choices = milled.filter((card) => {
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          const types = offBattlefieldTypes(ctx, def.types, card.ownerId);
          return (
            findObjectById(ctx, card.id) === card &&
            ((types.includes('Artifact') && types.includes('Creature')) ||
              def.subtypes.includes('Vehicle'))
          );
        });
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: you may return an artifact creature or Vehicle milled this way`,
          cards: choices,
          type: 'returnToHand',
          verb: 'Return',
          decline: { type: 'decline', description: 'Take none', verb: 'Skip' },
        });
        if (chosen !== null) yield* moveObject(ctx, chosen, { zone: 'hand' });
        break;
      }
      case 'discover':
        yield* discover(ctx, source, controller.id, amountOf(effect.count));
        break;
      case 'revealUntilAura':
        yield* revealUntilAura(ctx, source, controller.id);
        break;
      case 'exileEachUntilNonlandCast':
        yield* exileEachUntilNonlandAndCast(ctx, source, controller.id);
        break;
      case 'revealCreatureOrBottom':
        yield* revealCreatureOrBottom(ctx, source, controller.id);
        break;
      case 'explore': {
        const currentId = ref(effect.target);
        const permanent = currentId === null ? undefined : findPermanent(ctx, currentId);
        const last = eventObjectFacts(ctx, scope);
        const playerId = permanent?.controllerId ?? last?.candidate.controllerId ?? controller.id;
        const player = playerById(ctx, playerId);
        const top = player.library[0];
        if (top !== undefined)
          emit(
            ctx,
            'revealCard',
            { player: player.id, cardId: top.cardId, name: top.name, revealed: true },
            player.id,
          );
        if (
          top !== undefined &&
          getDefByOracleId(ctx, top.oracleId, top.name).types.includes('Land')
        ) {
          yield* moveObject(ctx, top, { zone: 'hand' });
        } else {
          if (permanent !== undefined)
            addCounterPlacements(ctx, source, [
              { perm: permanent, counter: '+1/+1', count: 1, placingPlayerId: player.id },
            ]);
          if (top !== undefined) {
            const choice = yield {
              decisionType: 'general',
              player: player.id,
              prompt: `${source.name}: put the revealed card into your graveyard?`,
              options: [
                plainOption({
                  type: 'exploreGraveyard',
                  description: `Put ${top.name} into your graveyard`,
                  verb: 'Put into graveyard',
                }),
                plainOption({
                  type: 'keepTop',
                  description: `Keep ${top.name} on top`,
                  verb: 'Keep on top',
                  role: 'decline',
                }),
              ],
            };
            if (choice.index === 0) yield* moveObject(ctx, top, { zone: 'graveyard' });
          }
        }
        emit(
          ctx,
          'explore',
          { player: player.id, permanent: permanent?.name ?? last?.name ?? source.name },
          player.id,
        );
        break;
      }
      case 'exileLibraryTop': {
        const player = effect.player === 'eventPlayer' ? drawRecipient('eventPlayer') : controller;
        const top = player.library[0];
        if (top === undefined) break;
        const moved = yield* moveObject(ctx, top, { zone: 'exile' });
        if (effect.grantCastUntilEot === true && moved?.zone === 'exile') {
          moved.playableUntilEotBy = controller.id;
          moved.castOnlyUntilEot = true;
          if (effect.spendAsAnyColor === true) moved.spendAsAnyColorUntilEot = true;
        }
        if (
          effect.castFree === true &&
          moved !== null &&
          moved.zone === 'exile' &&
          freeCardIsCastable(ctx, moved, controller.id)
        ) {
          const choice = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `${source.name}: cast ${moved.name} without paying its mana cost?`,
            options: [
              plainOption({
                type: 'castFree',
                description: `Cast ${moved.name} for free`,
                verb: 'Cast',
              }),
              plainOption({
                type: 'decline',
                description: 'Leave the card in exile',
                verb: 'Decline',
                role: 'decline',
              }),
            ],
          };
          if (choice.index === 0) yield* resolveFreeCard(ctx, moved, controller.id);
        }
        break;
      }
      case 'partitionLibrary': {
        const looked = controller.library.slice(0, effect.count);
        if (effect.mode === 'handBottomExile') {
          const hand = yield* chooseCard(ctx, {
            player: controller.id,
            cards: looked,
            type: 'iterationHand',
            verb: 'Put into hand',
            prompt: `${source.name}: choose a card to put into your hand.`,
          });
          if (hand !== null) yield* moveObject(ctx, hand, { zone: 'hand' });
          const remaining = looked.filter(
            (card) => card !== hand && controller.library.includes(card),
          );
          const bottom = yield* chooseCard(ctx, {
            player: controller.id,
            cards: remaining,
            type: 'iterationBottom',
            verb: 'Put on bottom',
            prompt: `${source.name}: choose a card to put on the bottom.`,
          });
          if (bottom !== null) {
            controller.library.splice(controller.library.indexOf(bottom), 1);
            controller.library.push(bottom);
          }
          const exile = remaining.find((card) => card !== bottom);
          if (exile !== undefined) {
            const moved = yield* moveObject(ctx, exile, { zone: 'exile' });
            if (moved?.zone === 'exile')
              (moved as EngineCardObject).playableUntilEotBy = controller.id;
          }
        } else {
          const chosen: EngineCardObject[] = [];
          const candidates = looked.filter((card) =>
            isPermanentCard(getDefByOracleId(ctx, card.oracleId, card.name)),
          );
          for (;;) {
            const card = yield* chooseCard(ctx, {
              player: controller.id,
              cards: candidates.filter((card) => !chosen.includes(card)),
              type: 'choosePermanent',
              verb: 'Choose',
              prompt: `${source.name}: choose any number of permanents to put onto the battlefield.`,
              decline: { type: 'done', description: 'Finish choosing permanents', verb: 'Done' },
            });
            if (card === null) break;
            chosen.push(card);
          }
          yield* moveObjects(ctx, chosen, { zone: 'battlefield', controllerId: controller.id });
          for (const card of looked)
            if (controller.library.includes(card)) yield* moveObject(ctx, card, { zone: 'hand' });
        }
        break;
      }
      case 'recruit': {
        yield* drawCards(ctx, controller, 1);
        const card = yield* chooseCard(ctx, {
          player: controller.id,
          cards: controller.hand,
          type: 'discard',
          verb: 'Discard',
          prompt: `${source.name}: discard a card.`,
        });
        if (card !== null) {
          const nonland = !getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Land');
          const discarded = yield* discardCard(ctx, card, controller.id);
          if (discarded && nonland) createTokens(ctx, HUMAN_SOLDIER_1_1_WHITE, 1, controller.id);
        }
        break;
      }
      case 'drawRevealTopLoseManaValue': {
        const top = controller.library[0];
        if (top === undefined) break;
        const manaValue = spellManaValue(getDefByOracleId(ctx, top.oracleId, top.name), undefined);
        emit(
          ctx,
          'revealCard',
          { player: controller.id, cardId: top.cardId, name: top.name, revealed: true },
          controller.id,
        );
        yield* moveObject(ctx, top, { zone: 'hand' });
        loseLife(ctx, controller, manaValue);
        break;
      }
      case 'mutualRevealTopLoseManaValue': {
        const otherId = ref(effect.target);
        const other = ctx.state.players.find((player) => player.id === otherId && !player.hasLost);
        if (other === undefined) break;
        const players = [controller, other];
        const tops = players.map((player) => player.library[0]);
        const values = tops.map((card) =>
          card === undefined
            ? 0
            : spellManaValue(getDefByOracleId(ctx, card.oracleId, card.name), undefined),
        );
        for (const [index, top] of tops.entries()) {
          if (top !== undefined)
            emit(
              ctx,
              'revealCard',
              {
                player: players[index]!.id,
                cardId: top.cardId,
                name: top.name,
                revealed: true,
              },
              players[index]!.id,
            );
        }
        loseLife(ctx, controller, values[1]!);
        loseLife(ctx, other, values[0]!);
        for (const top of tops)
          if (top !== undefined) yield* moveObject(ctx, top, { zone: 'hand' });
        break;
      }
      case 'goadEachOpponent':
        for (const perm of ctx.state.battlefield) {
          if (
            perm.controllerId !== controller.id &&
            computeCharacteristics(ctx, perm).types.includes('Creature')
          ) {
            addGoadRequirement(ctx, perm, controller.id);
          }
        }
        break;
      case 'createTreasureForDeaths':
        for (let i = 0; i < ctx.state.creaturesDiedThisTurn; i++) {
          createToken(
            ctx,
            {
              name: 'Treasure',
              typeLine: 'Artifact — Treasure',
              types: ['Artifact'],
              subtypes: ['Treasure'],
              colors: [],
              power: null,
              toughness: null,
              manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']] }],
            },
            controller.id,
          );
        }
        break;
      case 'preventCombatDamageAll':
        ctx.state.combatDamagePrevention.all = true;
        break;
      case 'createDamageShield': {
        let shieldedId: ObjectId | undefined;
        if (effect.target !== undefined) {
          // A shield on one permanent, by object: nothing to shield once it is gone.
          const shielded = ref(effect.target);
          if (shielded === null) break;
          shieldedId = shielded;
        }
        let sourceObjectId: ObjectId | undefined;
        if (effect.chosenSource === true) {
          const chosen = yield* chooseDamageSource(ctx, controller.id, source);
          if (chosen === null) break;
          sourceObjectId = chosen;
        }
        // The shield keeps the effect's source as last known information, without the stack
        // object or targets that exist only while this resolution runs.
        const {
          resolvingStackObject: _stackObject,
          resolutionTargets: _targets,
          ...effectSource
        } = source;
        ctx.state.damageShields.push({
          id: `shield-${ctx.state.nextObjectNum++}`,
          effectSource,
          ...(shieldedId !== undefined
            ? {
                object: {
                  id: shieldedId,
                  dealtTo: effect.dealtTo === true,
                  dealtBy: effect.dealtBy === true,
                },
              }
            : { playerId: controller.id }),
          ...(effect.combatOnly === true ? { combatOnly: true as const } : {}),
          ...(sourceObjectId !== undefined ? { sourceObjectId } : {}),
          ...(effect.oneShot === true ? { oneShot: true as const } : {}),
          ...(effect.reflect !== undefined ? { reflect: effect.reflect } : {}),
          ...(effect.andPlaneswalkersYouControl === true
            ? { andPlaneswalkersTheyControl: true as const }
            : {}),
          ...(effect.sources === 'youDontControl' ? { sourceNotControlledBy: controller.id } : {}),
        });
        break;
      }
      case 'replicateCopies': {
        yield* replicateCopies(ctx, controller.id, effect, source);
        break;
      }
      case 'copyCastSpell':
        throw new Error(`engine bug: ${source.name} copies a cast spell outside a cast trigger`);
      case 'copyActivatedAbility':
        throw new Error(
          `engine bug: ${source.name} copies an activated ability outside an activation trigger`,
        );
      case 'copyStackAbility': {
        const lifeCost = effect.lifeCost;
        if (lifeCost !== undefined) {
          // "You may pay that much life again. If you do, copy that ability." (CR 119.4)
          const canPay = controller.life >= lifeCost && !playerLifeLocked(ctx, controller.id);
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `${source.name}: pay ${lifeCost} life to copy ${effect.stackAbility.description}?`,
            options: [
              plainOption({ type: 'decline', description: 'Decline', verb: 'Decline' }),
              ...(canPay
                ? [
                    plainOption({
                      type: 'payLife',
                      description: `Pay ${lifeCost} life`,
                      verb: 'Pay',
                    }),
                  ]
                : []),
            ],
          };
          if (outcome.index !== 1 || !canPay) break;
          payLife(ctx, controller, lifeCost);
        }
        yield* copyAbilityOnStack(ctx, effect.stackAbility, controller.id, source.name);
        break;
      }
      case 'copyTargetAbility': {
        const targetId = ref(effect.target);
        const original = ctx.state.stack.find(
          (entry) => entry.id === targetId && entry.kind !== 'spell' && entry.ability !== null,
        );
        if (original === undefined) break;
        const snapshot = stackAbilitySnapshot(original);
        for (let i = 0; i < effect.count; i++)
          yield* copyAbilityOnStack(ctx, snapshot, controller.id, source.name);
        break;
      }
      case 'nextCastThisTurn':
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          controllerId: controller.id,
          when: 'castsSpell',
          castFilter: effect.filter,
          ability: effect.ability,
          expiry: 'cleanup',
          once: true,
        });
        emit(ctx, 'delayedTriggerCreated', { source: source.name }, controller.id);
        break;
      case 'copyTargetSpell': {
        const targetId = ref(effect.target);
        const original = ctx.state.stack.find(
          (entry) => entry.id === targetId && entry.kind === 'spell',
        );
        if (original === undefined) break;
        yield* copySpellOnStack(
          ctx,
          original,
          controller.id,
          source.name,
          effect.newTargets === true,
        );
        break;
      }
      case 'damageController':
        yield* dealDamageToPlayer(ctx, source, controller, effect.amount, {
          combat: false,
          sourceIsCommander: false,
          sourceHasLifelink: false,
        });
        break;
      case 'damageEach': {
        // The affected set is fixed here (CR 611.2c) and the damage is dealt simultaneously,
        // so a creature that dies to it still received its share. An explicit source ("that
        // creature deals damage", Arcbond) keeps dealing it with last known information after it
        // has left the battlefield (CR 608.2h).
        const damageSource = effect.source === undefined ? source : damageSourceOf(effect.source);
        if (damageSource === undefined) break;
        const controlledBy =
          effect.controlledBy === undefined ? undefined : ref(effect.controlledBy);
        if (controlledBy === null) break;
        const affected = affectedBy(ctx, source, effect.selector).filter(
          (permanent) =>
            (effect.exceptSource !== true || permanent.cardId !== damageSource.cardId) &&
            (controlledBy === undefined || permanent.controllerId === controlledBy),
        );
        const amount = amountOf(effect.amount);
        for (const perm of affected) {
          yield* dealDamageToObject(ctx, damageSource, perm.id, amount);
        }
        emit(ctx, 'damageEach', {
          source: damageSource.name,
          targets: affected.map((p) => p.name),
          amount,
        });
        break;
      }
      case 'damageEachOtherOpponent': {
        const amount = amountOf(effect.amount);
        for (const opponent of opponentsOf(ctx, controller.id)) {
          if (opponent.id === scope.eventPlayerId) continue;
          yield* dealDamageToObject(ctx, source, opponent.id, amount);
        }
        break;
      }
      case 'damageEachPlayer': {
        // Earthquake's second half. Split from `damageEach` rather than folded in, because a
        // `Selector` describes permanents and players are not permanents.
        const amount = amountOf(effect.amount);
        // With an explicit source ("it deals that much damage to each player", Arcbond) the
        // damage is that object's, so its lifelink and protection-relevant colors apply.
        const damageSource =
          effect.source === undefined ? undefined : damageSourceOf(effect.source);
        if (effect.source !== undefined && damageSource === undefined) break;
        for (const player of ctx.state.players.filter((p) => !p.hasLost)) {
          if (damageSource !== undefined) {
            yield* dealDamageToObject(ctx, damageSource, player.id, amount);
            continue;
          }
          yield* dealDamageToPlayer(ctx, source, player, amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        }
        break;
      }
      case 'cascade':
        yield* resolveCascade(ctx, source, scope.spellManaValue ?? 0);
        break;
      case 'reboundCastFromExile':
        yield* resolveReboundCastFromExile(ctx, source, controller.id);
        break;
      case 'searchLibrary': {
        const destinations =
          effect.count !== undefined && effect.destinations.length === 1
            ? Array.from(
                { length: amountOf(effect.count) },
                () => effect.destinations[0] as SearchDestination,
              )
            : effect.destinations;
        const foundCardIds = yield* searchLibrary(
          ctx,
          source,
          controller,
          effect.filter,
          destinations,
          effect.differentNames === true,
          effect.allowFailToFind === true,
          effect.reveal === true,
        );
        if (effect.bind !== undefined) effectBindings.set(effect.bind, foundCardIds);
        break;
      }
      case 'searchLibraryGroup': {
        const foundCardIds = yield* searchLibraryGroup(ctx, source, controller, effect);
        if (effect.bind !== undefined) effectBindings.set(effect.bind, foundCardIds);
        break;
      }
      case 'huntingWilds': {
        const selectorSource = { cardId: source.cardId, controllerId: controller.id };
        // Both choices are made first: "put them onto the battlefield" is one event, so the
        // Forests enter together (CR 603.6a) and each one's entry sees the other.
        const chosen: EngineCardObject[] = [];
        for (let i = 0; i < 2; i++) {
          const matches = controller.library.filter(
            (card) =>
              !chosen.includes(card) &&
              selectMatches(
                cardZoneCandidate(ctx, card, controller.id),
                { kind: 'subtype', value: 'Forest' },
                selectorSource,
              ),
          );
          if (matches.length === 0) break;
          const outcome = yield {
            decisionType: 'general' as const,
            player: controller.id,
            prompt: `${source.name}: search for a Forest card.`,
            options: [
              ...matches.map((card) =>
                cardOption(ctx, card, {
                  viewerId: controller.id,
                  type: 'findCard',
                  description: `Put ${card.name} onto the battlefield tapped`,
                  verb: 'Put onto battlefield tapped',
                }),
              ),
              plainOption({
                type: 'findNothing',
                description: 'Find nothing',
                verb: 'Find nothing',
                role: 'decline',
              }),
            ],
          };
          if (outcome.index >= matches.length) break;
          chosen.push(matches[outcome.index] as EngineCardObject);
        }
        const found = (yield* moveObjects(ctx, chosen, {
          zone: 'battlefield',
          controllerId: controller.id,
          entersTapped: true,
        })).filter(
          (moved): moved is EnginePermanent =>
            moved !== null &&
            moved.zone === 'battlefield' &&
            ctx.state.battlefield.includes(moved as EnginePermanent),
        );
        shuffleLibrary(ctx, controller);
        if (amountOf({ kind: 'optionalCostCount', mechanic: 'kicker' }) > 0) {
          for (const permanent of found) permanent.tapped = false;
          if (found.length > 0) {
            ctx.state.effects.push({
              id: `eff-${ctx.state.nextObjectNum++}`,
              sourceId: source.cardId,
              description: 'Hunting Wilds animated Forests',
              targetCardIds: found.map((permanent) => permanent.cardId),
              targetObjectIds: found.map((permanent) => permanent.id),
              kind: 'becomeCreature',
              duration: 'permanent',
              becomeCreature: {
                addSubtypes: [],
                power: 3,
                toughness: 3,
                addKeywords: ['haste'],
                setColors: ['G'],
              },
              timestamp: ctx.state.nextTimestamp++,
            });
          }
        }
        break;
      }
      case 'etaliPrimalConqueror': {
        const exiled: EngineCardObject[] = [];
        for (const player of ctx.state.players) {
          while (player.library.length > 0) {
            const card = player.library.shift() as EngineCardObject;
            card.zone = 'exile';
            card.id = `o-${ctx.state.nextObjectNum++}` as ObjectId;
            ctx.state.exile.push(card);
            const cardDef = getDefByOracleId(ctx, card.oracleId, card.name);
            if (!cardDef.types.includes('Land')) {
              exiled.push(card);
              break;
            }
          }
        }
        while (true) {
          const castable = exiled.filter(
            (card) =>
              ctx.state.exile.includes(card) && freeCardIsCastable(ctx, card, controller.id),
          );
          if (castable.length === 0) break;
          const outcome = yield {
            decisionType: 'general' as const,
            player: controller.id,
            prompt: `${source.name}: cast an exiled nonland card without paying its mana cost.`,
            options: [
              ...castable.map((card) =>
                cardOption(ctx, card, {
                  viewerId: controller.id,
                  type: 'castSpell',
                  description: `Cast ${card.name} for free`,
                  verb: 'Cast for free',
                }),
              ),
              plainOption({
                type: 'decline',
                description: 'Cast no more cards',
                verb: 'Done',
                role: 'decline',
              }),
            ],
          };
          if (outcome.index >= castable.length) break;
          yield* resolveFreeCard(ctx, castable[outcome.index] as EngineCardObject, controller.id);
        }
        break;
      }
      case 'doublePowerAndToughnessEachUntilEot': {
        for (const permanent of affectedBy(ctx, source, effect.selector)) {
          const pt = effectivePT(ctx, permanent);
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: `${permanent.name} has doubled power and toughness until end of turn`,
            targetCardIds: [permanent.cardId],
            kind: 'ptDelta',
            power: pt.power,
            toughness: pt.toughness,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        break;
      }
      case 'searchLibraryCastFree': {
        yield* searchLibraryCastFree(ctx, source, controller, effect.filter);
        break;
      }
      case 'shuffle':
        shuffleLibrary(ctx, controller);
        break;
      case 'scry':
        yield* scry(ctx, source, controller, amountOf(effect.count));
        break;
      case 'surveil':
        yield* surveil(ctx, source, controller, effect.count);
        break;
      case 'proliferate':
        yield* proliferate(ctx, source, controller);
        break;
      case 'lookAtTopN':
        yield* lookAtTopN(ctx, source, controller, effect);
        break;
      case 'counterUnlessPays':
        yield* counterUnlessPays(ctx, source, effect.stackObjectId, effect.cost);
        break;
      case 'attachSelfTo': {
        const t = ref(effect.target);
        const equipment = ctx.state.battlefield.find(
          (p) => p.cardId === source.cardId && (source.id === undefined || p.id === source.id),
        );
        if (t === null || equipment === undefined) break;
        const host = findPermanent(ctx, t);
        // CR 701.3b-c, 613.7e: attaching to a different creature gives it a new timestamp;
        // attaching to the creature it is already on, or to one it can't equip, does nothing.
        if (host !== undefined) attachPermanent(ctx, equipment, host);
        break;
      }
      case 'createToken': {
        // Each token is a separate object and fires its own ETB trigger, but the whole batch is
        // ONE creation event — see `createTokens`, which applies "if one or more tokens would be
        // created" replacements once for it rather than once per token.
        const spec = {
          ...effect.spec,
          ...(effect.powerOverride !== undefined
            ? {
                power:
                  typeof effect.powerOverride === 'number'
                    ? effect.powerOverride
                    : evaluateValueIn(ctx, effect.powerOverride, scope),
              }
            : {}),
          ...(effect.toughnessOverride !== undefined
            ? {
                toughness:
                  typeof effect.toughnessOverride === 'number'
                    ? effect.toughnessOverride
                    : evaluateValueIn(ctx, effect.toughnessOverride, scope),
              }
            : {}),
        };
        createdThisResolution.push(
          ...createTokens(ctx, spec, amountOf(effect.count), controller.id, effect.tapped === true),
        );
        break;
      }
      case 'reflexiveOnCreatedToken': {
        const tokens = createdThisResolution.filter((token) =>
          ctx.state.battlefield.includes(token),
        );
        if (tokens.length === 0) break;
        let token = tokens[0] as EnginePermanent;
        if (tokens.length > 1) {
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `${source.name}: choose the token the reflexive ability refers to.`,
            presentationSource: presentedSource(ctx, source),
            options: tokens.map((candidate) =>
              cardOption(ctx, candidate, {
                viewerId: controller.id,
                type: 'chooseToken',
                description: `Choose ${candidate.name}`,
                verb: 'Choose',
              }),
            ),
          };
          token = tokens[outcome.index] ?? token;
        }
        ctx.state.pendingTriggers.push({
          controllerId: source.controllerId,
          sourceCardId: source.cardId,
          ...(source.id === undefined ? {} : { sourceObjectId: source.id }),
          sourceOracleId: source.oracleId,
          sourceName: source.name,
          ability: effect.then,
          triggerObjectCardId: token.cardId,
          scope: { eventObjectId: token.id },
        });
        break;
      }
      case 'returnChosenCardsAttachedTo': {
        const hostId = ref(effect.to);
        const host = hostId === null ? undefined : findPermanent(ctx, hostId);
        for (const cardId of chosenReferents(effect.targetSlot)) {
          const card = controller.graveyard.find((candidate) => candidate.id === cardId);
          if (card === undefined) continue;
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          if (def.subtypes.includes('Aura')) {
            // An undefined host leaves the Aura where it is (CR 303.4i); moveObject also refuses a
            // host its enchant ability doesn't allow.
            if (host === undefined) continue;
            const attached = yield* moveObject(ctx, card, {
              zone: 'battlefield',
              controllerId: controller.id,
              attachedTo: host.id,
            });
            if (attached !== null && attached.zone === 'battlefield')
              emit(ctx, 'graveyardToBattlefield', { target: card.name, source: source.name });
            continue;
          }
          emit(ctx, 'graveyardToBattlefield', { target: card.name, source: source.name });
          // An Equipment enters attached, so its entry already sees it equipping the host; one
          // that couldn't equip it enters unattached (CR 301.5e): a creature can't be equipped
          // by an Equipment that is itself a creature or of a color it has protection from.
          const equips =
            host !== undefined &&
            def.subtypes.includes('Equipment') &&
            !def.types.includes('Creature') &&
            computeCharacteristics(ctx, host).types.includes('Creature') &&
            !hasProtectionFrom(ctx, host, def);
          yield* moveObject(ctx, card, {
            zone: 'battlefield',
            controllerId: controller.id,
            ...(equips ? { attachedTo: host.id } : {}),
          });
        }
        break;
      }
      case 'attach': {
        const attachmentId =
          effect.what === 'source' ? (sourcePermanent()?.id ?? null) : ref('triggerObject');
        const attachment = attachmentId === null ? undefined : findPermanent(ctx, attachmentId);
        if (attachment === undefined) break;
        if (
          effect.requireAura === true &&
          !computeCharacteristics(ctx, attachment).subtypes.includes('Aura')
        )
          break;
        const candidates =
          effect.to === 'createdToken'
            ? createdThisResolution
            : (() => {
                const id = ref('triggerObject');
                const perm = id === null ? undefined : findPermanent(ctx, id);
                return perm === undefined ? [] : [perm];
              })();
        const hosts = candidates.filter((host) => canAttach(ctx, attachment, host));
        if (hosts.length === 0) break;
        if (effect.optional !== true && hosts.length === 1) {
          attachPermanent(ctx, attachment, hosts[0] as EnginePermanent);
          break;
        }
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: attach ${attachment.name}?`,
          presentationSource: presentedSource(ctx, source),
          options: [
            ...hosts.map((host) =>
              cardOption(ctx, host, {
                viewerId: controller.id,
                type: 'attach',
                description: `Attach ${attachment.name} to ${host.name}`,
                verb: 'Attach',
              }),
            ),
            ...(effect.optional === true
              ? [
                  plainOption({
                    type: 'decline',
                    description: `Don't attach ${attachment.name}`,
                    verb: 'Decline',
                    role: 'decline',
                  }),
                ]
              : []),
          ],
        };
        const host = hosts[outcome.index];
        if (host !== undefined) attachPermanent(ctx, attachment, host);
        break;
      }
      case 'createTokenAttacking': {
        const count = amountOf(effect.count);
        if (count <= 0) break;
        // The event player (the attacking player) creates them for "that attacking player".
        const owner =
          effect.player === 'eventPlayer'
            ? scope.eventPlayerId === undefined
              ? undefined
              : playerById(ctx, scope.eventPlayerId)
            : controller;
        if (owner === undefined || owner.hasLost) break;
        let attackChoice: { defenderId: PlayerId; planeswalkerId: ObjectId | null };
        if (effect.defender === 'attackedPlayer') {
          // "…that's attacking that opponent": the player the firing was about, not a planeswalker
          // of theirs, and only while they are still in the game and not the token's controller.
          const attacked = scope.attackedPlayerId;
          const player = ctx.state.players.find((candidate) => candidate.id === attacked);
          if (player === undefined || player.hasLost || player.id === owner.id) break;
          attackChoice = { defenderId: player.id, planeswalkerId: null };
        } else {
          const defenders = (ctx.state.combat?.defendingPlayers ?? []).filter((id) => {
            const player = ctx.state.players.find((candidate) => candidate.id === id);
            return player !== undefined && !player.hasLost && id !== owner.id;
          });
          if (defenders.length === 0) break;
          // "Tapped and attacking" names no player (CR 508.4): its controller chooses which
          // defending player, or planeswalker one of them controls, it attacks.
          attackChoice = yield* chooseEnteringAttackTarget(
            ctx,
            owner,
            source.name,
            defenders,
            true,
          );
        }
        const spec = {
          ...effect.spec,
          ...(effect.powerOverride === undefined ? {} : { power: amountOf(effect.powerOverride) }),
          ...(effect.toughnessOverride === undefined
            ? {}
            : { toughness: amountOf(effect.toughnessOverride) }),
        };
        const created: EnginePermanent[] = [];
        const multiplier = tokenCreationMultiplierFor(ctx, owner.id);
        for (let i = 0; i < count * multiplier; i++) {
          const token = createToken(ctx, spec, owner.id, false, false, false);
          token.tapped = true;
          token.attacking = attackChoice.defenderId;
          token.attackingPlaneswalker = attackChoice.planeswalkerId;
          token.statuses.push('attacking');
          created.push(token);
        }
        if (created.length > 0) {
          queueTriggersForEvent(
            ctx,
            'tokenCreated',
            created.map((permanent) => ({ permanent })),
          );
          queueTriggersForEvent(
            ctx,
            'enters',
            created.map((permanent) => ({ permanent })),
          );
          applyTokenCreationReplacements(ctx, spec, owner.id);
        }
        break;
      }
      case 'createAttachedToken': {
        const targetId = ref(effect.target);
        const attachedTo = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (attachedTo === undefined) break;
        const created: EnginePermanent[] = [];
        const multiplier = tokenCreationMultiplierFor(ctx, controller.id);
        for (let i = 0; i < multiplier; i++) {
          const token = createToken(ctx, effect.spec, controller.id, false, false, false);
          token.attachedTo = attachedTo.id;
          created.push(token);
          emit(ctx, 'attach', { equipment: token.name, to: attachedTo.name });
        }
        queueTriggersForEvent(
          ctx,
          'tokenCreated',
          created.map((permanent) => ({ permanent })),
        );
        queueTriggersForEvent(
          ctx,
          'enters',
          created.map((permanent) => ({ permanent })),
        );
        applyTokenCreationReplacements(ctx, effect.spec, controller.id);
        break;
      }
      case 'createTokenForPlayer': {
        const targetId = ref(effect.target);
        if (effect.opponentsOnly === true && targetId === controller.id) break;
        if (targetId !== null && ctx.state.players.some((player) => player.id === targetId)) {
          createTokens(ctx, effect.spec, amountOf(effect.count), targetId as PlayerId);
        }
        break;
      }
      case 'createTokenForEachPlayerExceptTarget': {
        const targetId = ref(effect.target);
        if (targetId === null) break;
        for (const player of ctx.state.players) {
          if (player.id !== targetId) {
            createTokens(ctx, effect.spec, amountOf(effect.count), player.id);
          }
        }
        break;
      }
      case 'eachOpponentCreatesTokens': {
        createTokensForPlayers(
          ctx,
          effect.spec,
          amountOf(effect.count),
          opponentsOf(ctx, controller.id).map((player) => player.id),
        );
        break;
      }
      case 'shareTokensWithChosenOpponent': {
        const chosen = yield* chooseOpponentForSharedEffect(
          ctx,
          source,
          controller.id,
          'to create tokens with you',
        );
        createTokensForPlayers(ctx, effect.spec, amountOf(effect.count), [
          controller.id,
          ...(chosen === null ? [] : [chosen]),
        ]);
        break;
      }
      case 'shareCreatureLifeWithChosenOpponent': {
        const chosen = yield* chooseOpponentForSharedEffect(
          ctx,
          source,
          controller.id,
          'to gain life for their creatures',
        );
        const recipients = new Set([controller.id, ...(chosen === null ? [] : [chosen])]);
        const amount = amountOf(effect.amount);
        // Determine both amounts before gaining life: a life-dependent type effect must not
        // change the other player's creature count partway through this simultaneous event.
        const grants = playersInApnapOrder(ctx)
          .filter((player) => !player.hasLost && recipients.has(player.id))
          .map((player) => ({
            player,
            amount:
              amount *
              ctx.state.battlefield.filter(
                (permanent) =>
                  permanent.controllerId === player.id &&
                  computeCharacteristics(ctx, permanent).types.includes('Creature'),
              ).length,
          }));
        gainLifeForPlayers(ctx, grants);
        break;
      }
      case 'createTokenForEachOpponent': {
        // "For each opponent, create a token" is one creation event, so the replacements run
        // once at the end rather than once per opponent.
        const opponents = opponentsOf(ctx, controller.id);
        const multiplier = tokenCreationMultiplierFor(ctx, controller.id);
        const created: EnginePermanent[] = [];
        for (const opponent of opponents) {
          // Adeline: "attacking that player or a planeswalker they control" — one choice per
          // opponent for the whole batch; the others name only the player.
          const attackChoice =
            effect.attacking === true && effect.orPlaneswalker === true
              ? yield* chooseEnteringAttackTarget(ctx, controller, source.name, [opponent.id], true)
              : { defenderId: opponent.id, planeswalkerId: null };
          for (let i = 0; i < multiplier; i++) {
            const token = createToken(ctx, effect.spec, controller.id, false, false);
            created.push(token);
            if (effect.attacking === true) {
              // Adeline / Ainok Strike Leader: "tapped AND attacking that player". The token is
              // put onto the battlefield already attacking, so it was never declared as an
              // attacker (CR 508.4) — but it is still tapped, exactly as printed.
              token.tapped = true;
              token.attacking = attackChoice.defenderId;
              token.attackingPlaneswalker = attackChoice.planeswalkerId;
              token.statuses.push('attacking');
            }
          }
        }
        if (created.length > 0) {
          queueTriggersForEvent(
            ctx,
            'tokenCreated',
            created.map((permanent) => ({ permanent })),
          );
          applyTokenCreationReplacements(ctx, effect.spec, controller.id);
        }
        break;
      }
      case 'createTokenCopyOf':
      case 'createTokenCopyOfEventGroupMember': {
        const copyOptions: Partial<Extract<Effect, { op: 'createTokenCopyOf' }>> =
          effect.op === 'createTokenCopyOf' ? effect : {};
        let original: EnginePermanent | undefined;
        if (effect.op === 'createTokenCopyOfEventGroupMember') {
          original = yield* chooseEventGroupMember(ctx, controller.id, source.name, scope);
        } else {
          const t = ref(effect.ref);
          const live = t === null ? undefined : findPermanent(ctx, t);
          // The referent may have left before this resolved. `'triggerObject'` is not a target
          // (CR 115.10a), so that is a no-op rather than a fizzle. A trigger that copies ITS OWN
          // source ("each opponent creates a copy of it") still copies it with its last known
          // copiable values (CR 608.2h, 707.2): the source's definition at the time it triggered,
          // which for a copy is the copied definition.
          const lastKnownSourceDef = ctx.defs.get(source.oracleId);
          // The copies show the rules text and cost it showed as it left (a copy's, for a copy of
          // something); without those facts, the card itself, wherever it went.
          const facts = source.lastKnownFacts;
          const sourceCard =
            live === undefined && facts?.oracleText === undefined
              ? findObjectByCardId(ctx, source.cardId)
              : undefined;
          original =
            live ??
            (effect.ref === 'source' && lastKnownSourceDef !== undefined
              ? ({
                  id: source.id ?? source.cardId,
                  cardId: source.cardId,
                  oracleId: source.oracleId,
                  name: source.name,
                  typeLine: lastKnownSourceDef.typeLine,
                  oracleText: facts?.oracleText ?? sourceCard?.oracleText ?? '',
                  manaCost:
                    facts?.oracleText !== undefined
                      ? (facts.manaCost ?? null)
                      : (sourceCard?.manaCost ?? null),
                  transformed: false,
                } as unknown as EnginePermanent)
              : undefined);
        }
        if (original === undefined) break;
        const baseSpec = tokenSpecCopying(ctx, original, copyOptions.exceptNonLegendary === true);
        const spec = {
          ...baseSpec,
          ...(copyOptions.addTypes !== undefined
            ? { types: [...new Set([...baseSpec.types, ...copyOptions.addTypes])] }
            : {}),
          ...(copyOptions.powerOverride !== undefined
            ? {
                power:
                  typeof copyOptions.powerOverride === 'number'
                    ? copyOptions.powerOverride
                    : evaluateValueIn(ctx, copyOptions.powerOverride, scope),
              }
            : {}),
          ...(copyOptions.toughnessOverride !== undefined
            ? {
                toughness:
                  typeof copyOptions.toughnessOverride === 'number'
                    ? copyOptions.toughnessOverride
                    : evaluateValueIn(ctx, copyOptions.toughnessOverride, scope),
              }
            : {}),
          ...(copyOptions.addKeywords !== undefined
            ? { keywords: [...new Set([...(baseSpec.keywords ?? []), ...copyOptions.addKeywords])] }
            : {}),
        };
        if (copyOptions.eachOpponent === true) {
          // Each opponent, in turn order from the active player, creates their own copies.
          for (const opponent of opponentsOf(ctx, controller.id)) {
            for (const token of createTokens(ctx, spec, amountOf(effect.count), opponent.id)) {
              if (copyOptions.goadedForRestOfGame === true)
                addGoadRequirement(ctx, token, controller.id, true);
            }
          }
          break;
        }
        for (let i = 0; i < amountOf(effect.count); i++) {
          const token = createToken(ctx, spec, controller.id);
          if (copyOptions.goadedForRestOfGame === true)
            addGoadRequirement(ctx, token, controller.id, true);
          if (copyOptions.sacrificeAt === 'endStep') {
            ctx.state.delayedTriggers.push({
              id: `dt-${ctx.state.nextObjectNum++}`,
              sourceCardId: source.cardId,
              sourceOracleId: source.oracleId,
              controllerId: source.controllerId,
              targetId: token.cardId,
              when: 'endStep',
              expiry: 'endStep',
              ability: {
                kind: 'triggered',
                targets: [],
                effects: [{ op: 'sacrifice', target: 'triggerObject' }],
                description: 'Sacrifice the token at the beginning of the next end step',
              },
            });
          }
        }
        break;
      }
      case 'doublePlayerCountersTarget': {
        const t = ref(effect.target);
        const player =
          t === null ? undefined : ctx.state.players.find((candidate) => candidate.id === t);
        if (player === undefined) break;
        doubleEachPlayerCounter(ctx, source, player, controller.id);
        break;
      }
      case 'becomeCopyOf': {
        const targetId = ref(effect.ref);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        const self = ctx.state.battlefield.find(
          (p) => p.cardId === source.cardId && (source.id === undefined || p.id === source.id),
        );
        if (target === undefined || self === undefined || target.cardId === self.cardId) break;
        applyCopy(ctx, self, target as EnginePermanent, {
          untilEot: effect.untilEot,
          addTypes: effect.addTypes,
          addSupertypes: effect.addSupertypes,
          nameOverride: effect.nameOverride,
        });
        emit(ctx, 'becomeCopy', {
          source: source.name,
          target: target.name,
          untilEot: effect.untilEot === true,
        });
        break;
      }
      case 'becomeCopyOfTarget': {
        const targetId = ref(effect.target);
        const copyId = ref(effect.ref);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        const copy = copyId === null ? undefined : findPermanent(ctx, copyId);
        if (target === undefined || copy === undefined || target.cardId === copy.cardId) break;
        applyCopy(ctx, target as EnginePermanent, copy as EnginePermanent, {
          untilEot: effect.untilEot,
          addTypes: effect.addTypes,
          addSupertypes: effect.addSupertypes,
          nameOverride: effect.nameOverride,
        });
        emit(ctx, 'becomeCopy', {
          source: source.name,
          target: copy.name,
          untilEot: effect.untilEot === true,
        });
        break;
      }
      case 'untapEach':
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          perm.tapped = false;
        }
        break;
      case 'reanimateEnchantedCardAndAttach': {
        // Intervening if (CR 603.4): only while this Aura is still on the battlefield.
        const aura = sourcePermanent();
        if (aura === undefined) break;
        const cardId = aura.attachedTo;
        // It loses "enchant creature card in a graveyard" either way.
        aura.reanimatedHostId = null;
        const card =
          cardId === null
            ? undefined
            : ctx.state.players.flatMap((p) => p.graveyard).find((c) => c.id === cardId);
        if (card === undefined) break;
        const def = getDefByOracleId(ctx, card.oracleId, card.name);
        if (!def.types.includes('Creature')) break;
        emit(ctx, 'graveyardToBattlefield', { target: card.name, source: source.name });
        const moved = yield* moveObject(ctx, card, {
          zone: 'battlefield',
          controllerId: controller.id,
        });
        const creature =
          moved === null ? undefined : ctx.state.battlefield.find((p) => p.id === moved.id);
        if (creature === undefined) break;
        aura.reanimatedHostId = creature.id;
        // A creature with protection from the Aura's color returns but can't be enchanted by it
        // (CR 702.16c): the Aura stays unattached, state-based actions put it into the graveyard
        // (CR 704.5m), and the leave trigger below makes that creature's controller sacrifice it.
        if (!hasProtectionFrom(ctx, creature, computeCharacteristics(ctx, aura))) {
          aura.attachedTo = creature.id;
          aura.timestamp = ctx.state.nextTimestamp++;
          emit(ctx, 'attach', { equipment: aura.name, to: creature.name });
        }
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: aura.cardId,
          sourceOracleId: aura.oracleId,
          controllerId: controller.id,
          targetId: aura.cardId,
          targetObjectId: aura.id,
          when: 'leavesBattlefield',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'sacrificeRememberedPermanent', objectId: creature.id }],
            description: `${creature.name}'s controller sacrifices it`,
          },
          expiry: 'onFire',
        });
        break;
      }
      case 'sacrificeRememberedPermanent': {
        const perm = ctx.state.battlefield.find((p) => p.id === effect.objectId);
        if (perm !== undefined)
          yield* moveObject(ctx, perm, { zone: 'graveyard', reason: 'sacrifice' });
        break;
      }
      case 'attackingOpponentUntapsNonland': {
        const attacker = scope.eventPlayerId;
        if (attacker === undefined || attacker === controller.id) break;
        for (const perm of ctx.state.battlefield) {
          if (perm.controllerId !== attacker) continue;
          if (computeCharacteristics(ctx, perm).types.includes('Land')) continue;
          perm.tapped = false;
        }
        break;
      }
      case 'untapBoundIf': {
        if (!evaluateCondition(ctx, effect.condition, source)) break;
        for (const cardId of effectBindings.get(effect.binding) ?? []) {
          const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === cardId);
          if (permanent !== undefined) permanent.tapped = false;
        }
        break;
      }
      case 'gainControl': {
        const duration = resolveControlChangeDuration(ctx, source, effect.duration);
        if (duration === null) break;
        // CR 611.2c: the affected set is frozen BEFORE anything changes hands — taking a
        // creature can change what the selector would match next (controller-dependent power,
        // "creatures you control" scoping), and the untap/haste riders apply to that same
        // frozen set, not to whatever matches afterwards.
        const affected = affectedBy(ctx, source, effect.selector);
        for (const perm of affected) {
          const change = perm.controllerId !== source.controllerId;
          changeController(ctx, perm, source.controllerId, duration);
          if (change)
            emit(ctx, 'gainControl', {
              source: source.name,
              target: perm.name,
              newController: source.controllerId,
            });
        }
        if (effect.untap === true) {
          for (const perm of affected) perm.tapped = false;
          emit(ctx, 'untap', {
            source: source.name,
            objects: affected.map((perm) => ({
              id: perm.id,
              name: perm.faceDown ? 'Face-down permanent' : perm.name,
            })),
          });
        }
        if (effect.grantHaste === true) {
          for (const perm of affected) {
            ctx.state.effects.push({
              id: `eff-${ctx.state.nextObjectNum++}`,
              sourceId: source.cardId,
              description: `${perm.name} gains haste until end of turn`,
              targetCardIds: [perm.cardId],
              targetObjectIds: [perm.id],
              kind: 'grantKeyword',
              keyword: 'haste',
              timestamp: ctx.state.nextTimestamp++,
            });
            emit(ctx, 'grantKeyword', {
              source: source.name,
              target: perm.name,
              keyword: 'haste',
            });
          }
        }
        break;
      }
      case 'graveyardToBattlefield': {
        // CR 400.7e / 603.6c: a death trigger can find its first public destination,
        // including an opponent-owned card. Leaving that incarnation ends the exception.
        const eventBinding =
          scope.eventObjectDestinationId ?? scope.triggerObjectId ?? scope.eventObjectId;
        const cardObj =
          effect.target === 'triggerObject'
            ? triggerObjectCardId === undefined
              ? undefined
              : eventBinding === undefined
                ? ctx.state.players
                    .flatMap((player) => player.graveyard)
                    .find((card) => card.cardId === triggerObjectCardId)
                : (() => {
                    const id = movedReferent(eventBinding);
                    return id === null ? undefined : findCardInAnyGraveyard(ctx, id);
                  })()
            : (() => {
                const t = ref(effect.target);
                // The target may be a permanent card in ANY player's graveyard, not just the
                // ability's controller's own (`cardInGraveyard`'s `graveyardOwnerScope: 'any'`
                // already offers candidates from every graveyard at the targeting step).
                return t === null ? undefined : findCardInAnyGraveyard(ctx, t);
              })();
        // Left the graveyard between announcement and resolution (CR 608.2b) — `ref` already
        // re-checked legality via `graveyardTargets`, so this is the "gone" case, not a bug.
        if (cardObj === undefined) break;
        if (!isPermanentCard(getDefByOracleId(ctx, cardObj.oracleId, cardObj.name))) break;
        emit(ctx, 'graveyardToBattlefield', { target: cardObj.name, source: source.name });
        const entered = yield* moveObject(ctx, cardObj, {
          zone: 'battlefield',
          controllerId: effect.under === 'owner' ? cardObj.ownerId : source.controllerId,
        });
        if (effect.gainsHaste === true && entered !== null && entered.zone === 'battlefield')
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: `${entered.name} gains haste`,
            targetCardIds: [entered.cardId],
            targetObjectIds: [entered.id],
            kind: 'grantKeyword',
            keyword: 'haste',
            duration: 'permanent',
            timestamp: ctx.state.nextTimestamp++,
          });
        break;
      }
      case 'reanimateAndLoseLife': {
        const t = ref(effect.target);
        const cardObj = t === null ? undefined : findCardInAnyGraveyard(ctx, t);
        // Left the graveyard between announcement and resolution (CR 608.2b) — the "gone" case,
        // not a bug. No life loss either: nothing was actually reanimated.
        if (cardObj === undefined) break;
        const manaValue = spellManaValue(
          getDefByOracleId(ctx, cardObj.oracleId, cardObj.name),
          undefined,
        );
        emit(ctx, 'graveyardToBattlefield', { target: cardObj.name, source: source.name });
        yield* moveObject(ctx, cardObj, { zone: 'battlefield', controllerId: source.controllerId });
        loseLife(ctx, controller, manaValue);
        break;
      }
      case 'graveyardToLibraryTop':
      case 'graveyardToLibraryBottom': {
        const t = ref(effect.target);
        if (t === null) break;
        const card = findObjectById(ctx, t);
        if (card !== undefined)
          yield* moveObject(ctx, card, {
            zone: 'library',
            libraryPosition: effect.op === 'graveyardToLibraryTop' ? 'top' : 'bottom',
          });
        break;
      }
      case 'graveyardToHand': {
        const t = ref(effect.target);
        if (t === null) break;
        const cardObj = findCardInAnyGraveyard(ctx, t);
        if (cardObj === undefined) break;
        emit(ctx, 'graveyardToHand', { target: cardObj.name, source: source.name });
        yield* moveObject(ctx, cardObj, { zone: 'hand' });
        break;
      }
      case 'returnToHand': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm !== undefined) {
          emit(ctx, 'returnToHand', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'hand' });
          break;
        }
        const stackIndex = ctx.state.stack.findIndex(
          (entry) => entry.id === t && entry.kind === 'spell',
        );
        const stackEntry = stackIndex < 0 ? undefined : ctx.state.stack[stackIndex];
        if (stackEntry?.card === null || stackEntry?.card === undefined) break;
        ctx.state.stack.splice(stackIndex, 1);
        emit(ctx, 'returnToHand', { target: stackEntry.card.name, source: source.name });
        // A flashback spell is exiled whenever it would leave the stack (CR 702.34a).
        yield* moveObject(ctx, stackEntry.card, {
          zone: stackEntry.exileOnResolution === true ? 'exile' : 'hand',
        });
        break;
      }
      case 'returnOneToHand': {
        const candidates = affectedBy(ctx, source, effect.selector);
        if (candidates.length === 0) break;
        let selected = candidates[0]!;
        if (candidates.length > 1) {
          const choice = yield {
            decisionType: 'general',
            player: source.controllerId,
            prompt: `${source.name}: choose a permanent to return to its owner’s hand`,
            presentationSource: presentedSource(ctx, source),
            options: candidates.map((perm) =>
              cardOption(ctx, perm, {
                viewerId: source.controllerId,
                type: 'choose',
                description: `Return ${perm.name} to its owner’s hand`,
                payload: perm.id,
                verb: 'Return',
                role: 'affirm',
              }),
            ),
          };
          selected = candidates[choice.index] ?? selected;
        }
        emit(ctx, 'returnToHand', { target: selected.name, source: source.name });
        yield* moveObject(ctx, selected, { zone: 'hand' });
        break;
      }
      case 'handToBattlefield': {
        const maxMv = effect.maxManaValue === undefined ? undefined : amountOf(effect.maxManaValue);
        yield* handToBattlefield(ctx, source, controller, effect.filter, maxMv, effect.count);
        break;
      }
      case 'addMana':
        yield* addManaFromAbility(ctx, source, controller, effect, amountOf(effect.amount));
        break;
      case 'goad': {
        const t = ref(effect.target);
        if (t !== null) {
          const perm = findPermanent(ctx, t);
          if (perm) {
            addGoadRequirement(ctx, perm, controller.id);
            emit(ctx, 'goad', { target: perm.name, source: source.name });
          }
        }
        break;
      }
      case 'targetPlayerMaySearchNamed': {
        const playerId = ref(effect.target);
        const searcher =
          playerId === null
            ? undefined
            : ctx.state.players.find((player) => player.id === playerId);
        if (searcher === undefined || searcher.hasLost) break;
        const outcome = yield {
          decisionType: 'general' as const,
          player: searcher.id,
          prompt: `${source.name}: search your library for a card named ${effect.name}?`,
          options: [
            plainOption({ type: 'search', description: 'Search', verb: 'Search' }),
            plainOption({
              type: 'decline',
              description: "Don't search",
              verb: 'Decline',
              role: 'decline',
            }),
          ],
        };
        if (outcome.index !== 0) break;
        yield* searchLibrary(
          ctx,
          source,
          searcher,
          { kind: 'name', value: effect.name },
          [{ zone: 'hand' }],
          false,
          true,
          true,
        );
        shuffleLibrary(ctx, searcher);
        break;
      }
      case 'addAttackRequirement': {
        // The fixed set names its object now; a selector set is read live (CR 611.2c).
        if (effect.relativeToPlayer !== undefined && ref(effect.relativeToPlayer) === null) break;
        let affects: AttackRequirementEntry['affects'] | undefined;
        if (effect.selector !== undefined)
          affects = {
            kind: 'selector',
            selector: effect.selector,
            ...(effect.relativeToPlayer !== undefined
              ? { viewpointId: ref(effect.relativeToPlayer) as unknown as PlayerId }
              : effect.relativeTo === 'activePlayer'
                ? { viewpointId: ctx.state.currentTurnPlayer }
                : effect.relativeTo === 'eventPlayer'
                  ? { viewpointId: ref('eventPlayer') as unknown as PlayerId }
                  : {}),
          };
        else {
          const targetId = effect.target === undefined ? null : ref(effect.target);
          if (targetId !== null) affects = { kind: 'objects', objectIds: [targetId] };
        }
        if (affects === undefined) break;
        const playerRef = (spec: AttackRequirementSpec): AttackRequirementRule | null => {
          if (spec.kind === 'anyAttack') return { kind: 'anyAttack' };
          const playerId =
            spec.kind === 'notPlayer' ? controller.id : (ref('eventPlayer') as unknown as PlayerId);
          return { kind: spec.kind, playerId };
        };
        const requirements = effect.requirements.flatMap((spec) => playerRef(spec) ?? []);
        const expires: AttackRequirementEntry['expires'] =
          effect.duration === 'thisTurn'
            ? { kind: 'thisTurn', turn: ctx.state.turnNumber }
            : effect.duration === 'duringTheirNextTurn'
              ? {
                  kind: 'theirNextTurn',
                  playerId:
                    affects.kind === 'selector' && affects.viewpointId !== undefined
                      ? affects.viewpointId
                      : controller.id,
                  setTurn: ctx.state.turnNumber,
                }
              : {
                  kind: effect.duration === 'untilYourNextTurn' ? 'untilNextTurn' : 'endOfNextTurn',
                  playerId: controller.id,
                  setTurn: ctx.state.turnNumber,
                };
        (ctx.state.attackRequirements ??= []).push({
          id: `ar-${ctx.state.nextObjectNum++}`,
          controllerId: controller.id,
          sourceCardId: source.cardId,
          affects,
          requirements,
          ...(effect.cantAttack === 'you'
            ? { restrictions: [{ kind: 'cantAttackPlayer' as const, playerId: controller.id }] }
            : {}),
          expires,
        });
        emit(ctx, 'attackRequirement', { source: source.name });
        break;
      }
      case 'chooseAttackersAndBlockers': {
        (ctx.state.combatChoices ??= []).push({
          id: `cc-${ctx.state.nextObjectNum++}`,
          casterId: controller.id,
          sourceCardId: source.cardId,
          turn: ctx.state.turnNumber,
        });
        emit(ctx, 'combatChoice', { source: source.name }, controller.id);
        break;
      }
      case 'cantBlockEach': {
        const objectIds = selectPermanents(ctx, effect.selector, {
          cardId: source.cardId,
          controllerId: controller.id,
        }).map((perm) => perm.id);
        (ctx.state.blockRestrictions ??= []).push({
          id: `br-${ctx.state.nextObjectNum++}`,
          controllerId: controller.id,
          objectIds,
          expires: {
            kind: 'untilNextTurn',
            playerId: controller.id,
            setTurn: ctx.state.turnNumber,
          },
        });
        break;
      }
      case 'limitAttacksToNearestOpponent': {
        // "The last chosen direction" is this Teyo's own latest choice: it replaces what this
        // object made before, while another Teyo (or this card back as a new object) makes an
        // effect of its own, and disagreeing effects can leave no legal attack.
        const sourceObjectId = source.id ?? source.cardId;
        ctx.state.attackDirections = (ctx.state.attackDirections ?? []).filter(
          (entry) => entry.sourceObjectId !== sourceObjectId,
        );
        ctx.state.attackDirections.push({
          id: `ad-${ctx.state.nextObjectNum++}`,
          controllerId: controller.id,
          sourceObjectId,
          direction: effect.direction,
          expires: {
            kind: 'untilNextTurn',
            playerId: controller.id,
            setTurn: ctx.state.turnNumber,
          },
        });
        break;
      }
      case 'chooseOpponentForSource': {
        const opponents = opponentsOf(ctx, controller.id);
        if (opponents.length === 0) break;
        let chosen = opponents[0] as (typeof opponents)[number];
        if (opponents.length > 1) {
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `${source.name}: choose an opponent`,
            // No `payload`: a player is not an on-screen source the web UI can focus, so the
            // choice is read back by index and shown as one "Choose" button per player.
            options: opponents.map((opponent) =>
              playerOption(opponent.id, opponent.id, {
                type: 'choosePlayer',
                description: opponent.id,
                verb: 'Choose',
              }),
            ),
          };
          chosen = opponents[outcome.index] ?? chosen;
        }
        // Only the permanent itself remembers it: a Stalker that has left has nothing to store on,
        // and the same card back as a new object is not the one whose trigger this is (CR 400.7).
        const holder = ctx.state.battlefield.find((perm) =>
          source.id !== undefined ? perm.id === source.id : perm.cardId === source.cardId,
        );
        if (holder !== undefined) holder.chosenOption = chosen.id;
        emit(ctx, 'chooseOpponent', { source: source.name, player: chosen.id });
        break;
      }
      case 'removeAttackersFromCombat': {
        const removed = ctx.state.battlefield.filter((perm) => perm.attacking !== null);
        for (const perm of removed) {
          removeFromCombat(ctx, perm);
          if (effect.untap === true) perm.tapped = false;
        }
        emit(ctx, 'removedFromCombat', { source: source.name, count: removed.length });
        if (effect.thenCombat === undefined) break;
        const combatId = `ec-${ctx.state.nextObjectNum++}`;
        ctx.state.extraCombats.unshift({
          id: combatId,
          after: ctx.state.phase,
          controllerId: controller.id,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          sourceName: source.name,
        });
        if (removed.length > 0)
          (ctx.state.attackRequirements ??= []).push({
            id: `ar-${ctx.state.nextObjectNum++}`,
            controllerId: controller.id,
            sourceCardId: source.cardId,
            affects: { kind: 'objects', objectIds: removed.map((perm) => perm.id) },
            requirements: [{ kind: 'anyAttack' }],
            restrictions: [{ kind: 'cantAttackPlayer', playerId: controller.id }],
            expires: { kind: 'combat', combatId },
          });
        break;
      }
      case 'forceAttack': {
        const targetId = ref(effect.target);
        const perm = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (perm !== undefined) perm.mustAttackThisTurn = true;
        break;
      }
      case 'forceAttackEach':
        for (const perm of selectPermanents(ctx, effect.selector, {
          cardId: source.cardId,
          controllerId: controller.id,
        })) {
          perm.mustAttackThisTurn = true;
        }
        break;
      case 'doublePowerTarget': {
        const targetId = ref(effect.target);
        const perm = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (perm !== undefined) {
          const currentPower = computeCharacteristics(ctx, perm).power;
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: `Double power of ${perm.name}`,
            targetCardIds: [perm.cardId],
            kind: 'ptDelta',
            power: currentPower,
            toughness: 0,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        break;
      }
      case 'doublePower': {
        for (const perm of ctx.state.battlefield) {
          if (
            selectMatches(
              candidateOf(ctx, perm, computeCharacteristics(ctx, perm)),
              effect.selector,
              { cardId: source.cardId, controllerId: source.controllerId },
            )
          ) {
            const currentPower = computeCharacteristics(ctx, perm).power;
            ctx.state.effects.push({
              id: `eff-${ctx.state.nextObjectNum++}`,
              sourceId: source.cardId,
              description: `Double power of ${perm.name}`,
              targetCardIds: [perm.cardId],
              kind: 'ptDelta',
              power: currentPower,
              toughness: 0,
              timestamp: ctx.state.nextTimestamp++,
            });
          }
        }
        break;
      }
      case 'drawUpTo': {
        const currentHand = controller.hand.length;
        const diff = effect.count - currentHand;
        if (diff > 0) {
          yield* drawCards(ctx, controller, diff);
        }
        break;
      }
      case 'eventPlayerMayDraw': {
        const eventPlayerId = ref('eventPlayer') as unknown as PlayerId | null;
        const drawer = ctx.state.players.find((player) => player.id === eventPlayerId);
        if (drawer === undefined || drawer.hasLost) break;
        const outcome = yield {
          decisionType: 'general',
          player: drawer.id,
          prompt: `${source.name}: draw a card?`,
          options: [
            plainOption({ type: 'draw', description: 'Draw a card', verb: 'Draw', role: 'affirm' }),
            plainOption({
              type: 'decline',
              description: 'Do not draw',
              verb: 'Decline',
              role: 'decline',
            }),
          ],
        };
        if (outcome.index !== 0) break;
        // "If they do" means a card was actually drawn: an attempt on an empty library, or a draw
        // replaced by something else, is not drawing one (CR 121.3, 614.6).
        const drawnBefore = drawer.cardsDrawnThisTurn;
        yield* drawCards(ctx, drawer, 1);
        if (drawer.cardsDrawnThisTurn === drawnBefore) break;
        yield* executeAbility(
          ctx,
          source,
          { ...ability, effects: effect.then },
          targets,
          triggerObjectCardId,
          extraScope,
          countTargets,
          divisionAmounts,
        );
        break;
      }
      case 'drawUpToN': {
        const drawingPlayer = drawRecipient(effect.player);
        // A player may choose any permitted number even when their library has fewer cards.
        // Drawing from an empty library is a legal attempt whose loss is handled by the next SBA.
        const options = Array.from({ length: effect.count + 1 }, (_, amount) =>
          valueOption(amount, `Draw ${amount} card${amount === 1 ? '' : 's'}`, {
            type: 'drawUpTo',
            description: `Draw ${amount} card${amount === 1 ? '' : 's'}`,
            verb: 'Draw',
          }),
        );
        const outcome = yield {
          decisionType: 'general',
          player: drawingPlayer.id,
          prompt: `${source.name}: draw up to ${effect.count} cards. Choose an amount.`,
          options,
        };
        yield* drawCards(ctx, drawingPlayer, outcome.index);
        break;
      }
      case 'mayPayEnergyUpTo': {
        const max = Math.min(Math.max(0, Math.floor(amountOf(effect.max))), controller.energy);
        const options = [
          plainOption({ type: 'decline', description: 'Pay no energy', verb: 'Decline' }),
          ...Array.from({ length: Math.max(0, max - effect.min + 1) }, (_, offset) => {
            const amount = effect.min + offset;
            return valueOption(amount, `Pay ${amount} energy`, {
              type: 'payEnergy',
              description: `Pay ${amount} energy`,
              verb: 'Pay',
            });
          }),
        ];
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose how much energy to pay (one decision).`,
          options,
        };
        const paid = outcome.index === 0 ? 0 : effect.min + outcome.index - 1;
        if (paid > 0) {
          controller.energy -= paid;
          emit(ctx, 'energy', { amount: -paid, total: controller.energy }, controller.id);
        }
        scope.energyPaid = paid;
        if (paid > 0 && effect.then !== undefined) {
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: effect.then },
            targets,
            triggerObjectCardId,
            { ...scope },
            countTargets,
            divisionAmounts,
          );
        }
        break;
      }
      case 'mayPayManaAndSacrificeSource': {
        const found = sourcePermanent();
        const self = found?.controllerId === controller.id ? found : undefined;
        // The Wraith is spoken for by the sacrifice half of this cost, so no mana ability paying
        // the {3} half may sacrifice it (CR 601.2g-h: an unpayable part makes the whole illegal).
        const reserved = new Set<string>(self === undefined ? [] : [self.id]);
        const payable =
          self !== undefined &&
          canPay(
            effect.cost,
            controller.manaEntries,
            withoutReserved(ctx, manaSourcesFor(ctx, controller.id), reserved),
            allowanceFor(ctx, controller.id, { kind: 'other' }),
            controller.life,
          );
        if (!payable) break;
        const costText = describeManaCost(effect.cost);
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay ${costText} and sacrifice ${self.name}?`,
          options: [
            plainOption({ type: 'decline', description: 'Decline', verb: 'Decline' }),
            plainOption({
              type: 'payCost',
              description: `Pay ${costText} and sacrifice ${self.name}`,
              verb: 'Pay',
            }),
          ],
        };
        if (outcome.index !== 1) break;
        yield* payManaCost(ctx, controller, effect.cost, { kind: 'other' }, [], reserved);
        emit(ctx, 'sacrifice', { name: self.name, cardId: self.cardId }, controller.id);
        yield* moveObject(ctx, self, { zone: 'graveyard', reason: 'sacrifice' });
        yield* executeAbility(
          ctx,
          source,
          { ...ability, effects: effect.then },
          targets,
          triggerObjectCardId,
          { ...scope },
          countTargets,
          divisionAmounts,
        );
        break;
      }
      case 'searchBasicsNamedLikeChosenLand': {
        const lands = ctx.state.battlefield.filter(
          (permanent) =>
            permanent.controllerId === controller.id &&
            computeCharacteristics(ctx, permanent).types.includes('Land'),
        );
        const byName = [...new Map(lands.map((land) => [land.name, land])).values()];
        if (byName.length === 0) break;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose a land you control.`,
          presentationSource: presentedSource(ctx, source),
          options: byName.map((land) =>
            cardOption(ctx, land, {
              viewerId: controller.id,
              type: 'chooseLand',
              description: `Choose ${land.name}`,
              verb: 'Choose',
            }),
          ),
        };
        const chosen = byName[outcome.index] ?? byName[0]!;
        emit(ctx, 'chosen', { name: chosen.name, source: source.name }, controller.id);
        yield* searchLibrary(
          ctx,
          source,
          controller,
          allOf(ofSupertype('Basic'), ofType('Land')),
          Array.from({ length: effect.count }, () => effect.destination),
          false,
          true,
          false,
          (card) => card.name === chosen.name,
        );
        break;
      }
      case 'mayPayEnergy': {
        const amount = Math.max(0, Math.floor(amountOf(effect.amount)));
        const canPayAmount = controller.energy >= amount;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay ${amount} energy?`,
          options: [
            plainOption({ type: 'decline', description: 'Decline', verb: 'Decline' }),
            ...(canPayAmount
              ? [
                  plainOption({
                    type: 'payEnergy',
                    description: `Pay ${amount} energy`,
                    verb: 'Pay',
                  }),
                ]
              : []),
          ],
        };
        const paid = outcome.index === 1 && canPayAmount ? amount : 0;
        if (paid > 0) {
          controller.energy -= paid;
          emit(ctx, 'energy', { amount: -paid, total: controller.energy }, controller.id);
        }
        scope.energyPaid = paid;
        if (paid > 0 && effect.then !== undefined) {
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: effect.then },
            targets,
            triggerObjectCardId,
            { ...scope },
            countTargets,
            divisionAmounts,
          );
        }
        break;
      }
      case 'doublePlayerCounters':
        doubleEachPlayerCounter(ctx, source, controller, controller.id);
        break;
      case 'shuffleHandGraveyardIntoLibrary': {
        const cards = [...controller.hand, ...controller.graveyard];
        controller.hand = [];
        controller.graveyard = [];
        ctx.rng.shuffle(cards);
        controller.library.push(...cards);
        break;
      }
      case 'chaosWarp': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const owner = playerById(ctx, target.ownerId);
        yield* moveObject(ctx, target, { zone: 'library', libraryPosition: 'bottom' });
        ctx.rng.shuffle(owner.library);
        const revealed = owner.library[0];
        if (revealed !== undefined) {
          emit(
            ctx,
            'revealCard',
            { player: owner.id, cardId: revealed.cardId, name: revealed.name, revealed: true },
            null,
          );
          const revealedDef = getDefByOracleId(ctx, revealed.oracleId, revealed.name);
          if (
            revealedDef.types.some((type) =>
              ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'].includes(
                type,
              ),
            )
          ) {
            yield* moveObject(ctx, revealed, { zone: 'battlefield', controllerId: owner.id });
          }
        }
        break;
      }
      case 'manifestTop': {
        const playerId =
          effect.player === 'eventPlayer' ? drawRecipient('eventPlayer').id : controller.id;
        const player = playerById(ctx, playerId);
        const top = player.library[0];
        if (top === undefined) break;
        yield* moveObject(ctx, top, {
          zone: 'battlefield',
          controllerId: player.id,
          faceDown: true,
          manifested: true,
        });
        break;
      }
      case 'manifestTopForTargetController': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const player = playerById(ctx, target.controllerId);
        const top = player.library[0];
        if (top === undefined) break;
        yield* moveObject(ctx, top, {
          zone: 'battlefield',
          controllerId: player.id,
          faceDown: true,
          manifested: true,
        });
        break;
      }
      case 'opponentMayDrawOrMillThenDamage': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const choice = yield {
          decisionType: 'general',
          player: target.id,
          prompt: `${source.name}: have its controller draw three cards?`,
          options: [
            { type: 'draw', description: 'Have the caster draw three cards' },
            { type: 'mill', description: 'Decline; mill three cards and take damage' },
          ],
        };
        if (choice.index === 0) {
          yield* drawCards(ctx, controller, effect.drawCount);
        } else {
          let damage = 0;
          for (let i = 0; i < effect.millCount; i++) {
            const top = controller.library[0];
            if (top === undefined) break;
            damage += spellManaValue(getDefByOracleId(ctx, top.oracleId, top.name), undefined);
            yield* moveObject(ctx, top, { zone: 'graveyard' });
          }
          yield* dealDamageToObject(ctx, source, target.id, damage);
        }
        break;
      }
      case 'setMustBlockThisTurn': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target !== undefined) target.mustBlockThisTurn = true;
        break;
      }
      case 'extraCombatPhase':
        // Directly after the current phase, ahead of anything scheduled after it earlier.
        ctx.state.extraCombats.unshift({
          id: `ec-${ctx.state.nextObjectNum++}`,
          after: ctx.state.phase,
          controllerId: controller.id,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          sourceName: source.name,
          ...(effect.untapYourCreatures === true ? { untapAllAtBeginning: true as const } : {}),
          ...(effect.additionalMain === true ? { additionalMain: true as const } : {}),
        });
        break;
      case 'becomeMonarch':
        ctx.state.monarchPlayerId = controller.id;
        emit(ctx, 'monarch', { player: controller.id }, controller.id);
        break;
      case 'rotateSourceAtUpkeep': {
        const permanent = sourcePermanent();
        const player = ctx.state.players.find(
          (entry) => entry.id === ctx.state.currentTurnPlayer && !entry.hasLost,
        );
        if (permanent === undefined || player === undefined) break;
        changeController(ctx, permanent, player.id);
        permanent.tapped = false;
        addCounters(ctx, { ...source, controllerId: player.id }, permanent, '+1/+1', 1);
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${permanent.name} gains haste until end of turn`,
          targetCardIds: [permanent.cardId],
          targetObjectIds: [permanent.id],
          kind: 'grantKeyword',
          keyword: 'haste',
          timestamp: ctx.state.nextTimestamp++,
        });
        emit(ctx, 'gainControl', {
          source: source.name,
          target: permanent.name,
          newController: player.id,
        });
        break;
      }
      case 'attackingCreaturesToOwnerLibraries':
        yield* returnToOwnerLibraryChoices(
          ctx,
          source.name,
          ctx.state.battlefield.filter(
            (permanent) =>
              permanent.attacking !== null &&
              computeCharacteristics(ctx, permanent).types.includes('Creature'),
          ),
        );
        break;
      case 'choosePermanentTypesThenSacrificeOthers': {
        const kept = new Set<ObjectId>();
        const board = ctx.state.battlefield.map((permanent) => ({
          permanent,
          types: computeCharacteristics(ctx, permanent).types,
        }));
        for (const player of playersInApnapOrder(ctx)) {
          if (player.hasLost) continue;
          for (const type of effect.types) {
            const picked = yield* chooseCard(ctx, {
              player: controller.id,
              prompt: `${source.name}: choose ${player.id}'s ${type.toLowerCase()} to keep`,
              cards: board
                .filter(
                  (entry) =>
                    entry.permanent.controllerId === player.id && entry.types.includes(type),
                )
                .map((entry) => entry.permanent),
              type: 'chooseCard',
              verb: 'Keep',
            });
            if (picked !== null) kept.add(picked.id);
          }
        }
        const sacrificed = board
          .filter(({ permanent, types }) => !types.includes('Land') && !kept.has(permanent.id))
          .map(({ permanent }) => permanent);
        yield* movePermanentsToGraveyard(ctx, sacrificed, 'sacrifice');
        break;
      }
      case 'druidPurification': {
        const abilityControllerId = controller.id;
        const startIndex = ctx.state.turnOrder.indexOf(abilityControllerId);
        if (startIndex < 0)
          throw new Error('engine bug: Druid choice controller is absent from turn order');
        const orderedPlayerIds = [
          ...ctx.state.turnOrder.slice(startIndex),
          ...ctx.state.turnOrder.slice(0, startIndex),
        ].filter((id) => !playerById(ctx, id).hasLost);
        const allChosen: EnginePermanent[] = [];
        for (const playerId of orderedPlayerIds) {
          const player = playerById(ctx, playerId);
          const options = ctx.state.battlefield.filter((perm) => {
            const chars = computeCharacteristics(ctx, perm);
            return (
              perm.controllerId !== abilityControllerId &&
              (chars.types.includes('Artifact') || chars.types.includes('Enchantment'))
            );
          });
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: `${source.name}: choose an artifact or enchantment ${controller.id} doesn't control to destroy, or choose none.`,
            options: [
              plainOption({ type: 'decline', description: 'Choose none', verb: 'Skip' }),
              ...options.map((perm) =>
                cardOption(ctx, perm, {
                  viewerId: player.id,
                  type: 'destroy',
                  description: `Destroy ${perm.name}`,
                  payload: perm.id,
                  verb: 'Choose',
                }),
              ),
            ],
          };
          if (outcome.index > 0) {
            const picked = options[outcome.index - 1];
            if (picked !== undefined) allChosen.push(picked);
          }
          const picked = outcome.index > 0 ? options[outcome.index - 1] : undefined;
          emit(
            ctx,
            'permanentChoice',
            {
              source: source.name,
              name: picked?.name ?? null,
              objectId: picked?.id ?? null,
            },
            player.id,
          );
        }
        const uniqueChosen: EnginePermanent[] = [];
        const seen = new Set<ObjectId>();
        for (const perm of allChosen) {
          if (seen.has(perm.id)) continue;
          seen.add(perm.id);
          const current = findPermanent(ctx, perm.id);
          if (current !== undefined) uniqueChosen.push(current);
        }
        const protectedIds = new Set(
          uniqueChosen
            .filter((perm) => hasKeyword(ctx, perm, 'indestructible'))
            .map((perm) => perm.id),
        );
        const destroyed: EnginePermanent[] = [];
        for (const perm of uniqueChosen) {
          if (protectedIds.has(perm.id)) {
            emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
          } else if (!consumeRegenerationShield(ctx, perm, false)) {
            emit(ctx, 'destroy', { target: perm.name, source: source.name });
            destroyed.push(perm);
          }
        }
        yield* movePermanentsToGraveyard(ctx, destroyed);
        break;
      }
      case 'eachPlayerMayPutCountersAndGoad':
        yield* eachPlayerMayPutCountersAndGoad(
          ctx,
          source,
          controller.id,
          effect,
          amountOf(effect.count),
        );
        break;
      case 'voteAndExileMost': {
        // The candidate set is fixed as the ability resolves (CR 611.2c) and is measured against
        // the ability's ORIGINAL controller — "each player votes for a permanent you don't
        // control". Nothing here is a target: hexproof, shroud and protection remove no option.
        const abilityControllerId = controller.id;
        const candidates = affectedBy(ctx, source, effect.selector);
        if (candidates.length === 0) break;
        const startIndex = ctx.state.turnOrder.indexOf(abilityControllerId);
        if (startIndex < 0)
          throw new Error('engine bug: vote controller is absent from turn order');
        // "Starting with you": the rotation runs from the ability controller's own turn slot, not
        // the active player's. Every living player votes — there is no "may" and no abstain — and
        // every vote is collected before anything leaves (CR 608.2c).
        const orderedPlayerIds = [
          ...ctx.state.turnOrder.slice(startIndex),
          ...ctx.state.turnOrder.slice(0, startIndex),
        ].filter((id) => !playerById(ctx, id).hasLost);
        const tally = new Map<ObjectId, number>();
        for (const playerId of orderedPlayerIds) {
          const outcome = yield {
            decisionType: 'general',
            player: playerId,
            prompt: `${source.name}: vote for a permanent ${abilityControllerId} doesn't control.`,
            options: candidates.map((perm) =>
              cardOption(ctx, perm, {
                viewerId: playerId,
                type: 'chooseCard',
                description: `Vote for ${perm.name}`,
                verb: 'Vote',
              }),
            ),
          };
          const picked = candidates[outcome.index];
          if (picked === undefined) throw new Error('engine bug: vote choice is not a candidate');
          tally.set(picked.id, (tally.get(picked.id) ?? 0) + 1);
          // Battlefield permanents are public information, so the vote itself is: source, voter,
          // and the exact object named. No library or hand identity is involved.
          emit(
            ctx,
            'vote',
            { source: source.name, voter: playerId, objectId: picked.id, name: picked.name },
            playerId,
          );
        }
        // "each permanent with the most votes or tied for most votes": counted by permanent
        // object, never by card name, so two copies of the same card are two separate candidates.
        // Zero-vote candidates cannot match — `most` is at least one. All winners leave together.
        const most = Math.max(...tally.values());
        const winners = candidates.filter((perm) => tally.get(perm.id) === most);
        yield* movePermanentsTogether(ctx, winners, { zone: 'exile' });
        break;
      }
      case 'exileTargetWithSource': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        emit(ctx, 'exile', { target: target.name, source: source.name });
        const exiled = yield* moveObject(ctx, target, { zone: 'exile' });
        // Linked to the source object that exiled it (CR 607.2a); a replacement that sent the
        // card elsewhere means nothing was exiled with it.
        const currentSource = ctx.state.battlefield.find(
          (perm) =>
            perm.cardId === source.cardId && (source.id === undefined || perm.id === source.id),
        );
        if (currentSource !== undefined && exiled !== null && exiled.zone === 'exile') {
          currentSource.exiledWithIds = [...(currentSource.exiledWithIds ?? []), exiled.id];
        }
        break;
      }
      case 'exileFromHandWithSource': {
        const candidates = controller.hand.filter(
          (card) =>
            !getDefByOracleId(ctx, card.oracleId, card.name).types.some((type) =>
              effect.excludeTypes.includes(type),
            ),
        );
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: you may exile a card from your hand`,
          cards: candidates,
          type: 'exile',
          verb: 'Exile',
          decline: { type: 'decline', description: 'Exile nothing', verb: 'Decline' },
        });
        if (chosen === null) break;
        const exiled = yield* moveObject(ctx, chosen, { zone: 'exile' });
        // Linked to the source object that exiled it (CR 607.2a), as Duplicant's exile is.
        const currentSource = ctx.state.battlefield.find(
          (perm) =>
            perm.cardId === source.cardId && (source.id === undefined || perm.id === source.id),
        );
        if (currentSource !== undefined && exiled !== null && exiled.zone === 'exile')
          currentSource.exiledWithIds = [...(currentSource.exiledWithIds ?? []), exiled.id];
        break;
      }
      case 'exileGraveyardCardWithSource': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findObjectById(ctx, targetId);
        if (target === undefined || target.zone !== 'graveyard') break;
        const types = getDefByOracleId(ctx, target.oracleId, target.name).types;
        const exiled = yield* moveObject(ctx, target, { zone: 'exile' });
        // Linked to the source object that exiled it (CR 607.2a), as Duplicant's exile is.
        const currentSource = ctx.state.battlefield.find(
          (perm) =>
            perm.cardId === source.cardId && (source.id === undefined || perm.id === source.id),
        );
        if (currentSource !== undefined && exiled !== null && exiled.zone === 'exile')
          currentSource.exiledWithIds = [...(currentSource.exiledWithIds ?? []), exiled.id];
        if (effect.drawIfCardType !== undefined && types.includes(effect.drawIfCardType))
          yield* drawCards(ctx, controller, 1);
        break;
      }
      case 'exileAndManifestTarget': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const targetController = target.controllerId;
        emit(ctx, 'exile', { target: target.name, source: source.name });
        yield* moveObject(ctx, target, { zone: 'exile' });
        const player = playerById(ctx, targetController);
        const top = player.library[0];
        if (top === undefined) break;
        yield* moveObject(ctx, top, {
          zone: 'battlefield',
          controllerId: player.id,
          faceDown: true,
          manifested: true,
        });
        break;
      }
      case 'blinkTarget': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const targetCardId = target.cardId;
        const targetController = target.controllerId;
        yield* moveObject(ctx, target, { zone: 'exile' });
        const exiled = ctx.state.exile.find((card) => card.cardId === targetCardId);
        if (exiled !== undefined)
          yield* moveObject(ctx, exiled, { zone: 'battlefield', controllerId: targetController });
        break;
      }
      case 'blinkOneCreatureYouControl': {
        const creatures = ctx.state.battlefield.filter(
          (perm) =>
            perm.controllerId === source.controllerId &&
            computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: exile a creature you control and return it to the battlefield, or choose none.`,
          options: [
            plainOption({ type: 'decline', description: 'Choose none', verb: 'Skip' }),
            ...creatures.map((perm) =>
              cardOption(ctx, perm, {
                viewerId: controller.id,
                type: 'blink',
                description: `Blink ${perm.name}`,
                payload: perm.id,
                verb: 'Blink',
              }),
            ),
          ],
        };
        const chosen = outcome.index === 0 ? undefined : creatures[outcome.index - 1];
        if (chosen !== undefined) {
          const cardId = chosen.cardId;
          const targetController = chosen.controllerId;
          yield* moveObject(ctx, chosen, { zone: 'exile' });
          const exiled = ctx.state.exile.find((card) => card.cardId === cardId);
          if (exiled !== undefined)
            yield* moveObject(ctx, exiled, { zone: 'battlefield', controllerId: targetController });
        }
        break;
      }
      case 'byResolutionCountThisTurn': {
        const counts = (ctx.state.abilityResolutionsThisTurn ??= {});
        const id = `${source.id ?? source.cardId}:${effect.key}`;
        const count = (counts[id] ?? 0) + 1;
        counts[id] = count;
        const chosen = effect.cases.find((entry) => entry.n === count)?.effects ?? effect.otherwise;
        if (chosen.length > 0) {
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: chosen },
            targets,
            triggerObjectCardId,
            extraScope,
            countTargets,
            divisionAmounts,
          );
        }
        break;
      }
      case 'conditionalEffect': {
        // "Ferocious — if you control a creature with power 4 or greater, counter that spell
        // instead" (Stubborn Denial) — checked at RESOLUTION, when the board is current, not at
        // announcement. Recurses into `executeAbility` with the chosen branch substituted for
        // `effects`, so it reuses every existing op (and `ref`'s legality re-check) unchanged
        // rather than duplicating the dispatch.
        const checkTargetId = effect.checkTarget !== undefined ? ref(effect.checkTarget) : null;
        const checkTargetCardId =
          checkTargetId === null ? null : findObjectById(ctx, checkTargetId)?.cardId;
        const effectiveTriggerObjectCardId =
          checkTargetCardId !== null && checkTargetCardId !== undefined
            ? checkTargetCardId
            : triggerObjectCardId;
        const conditionSource = {
          ...scope,
          cardId: source.cardId,
          controllerId: source.controllerId,
          ...(source.id === undefined ? {} : { objectId: source.id }),
          ...(effect.checkTarget === undefined
            ? {}
            : {
                eventObjectId: checkTargetId ?? '',
                triggerObjectId: checkTargetId ?? '',
              }),
          ...(effectiveTriggerObjectCardId !== undefined
            ? { triggerObjectCardId: effectiveTriggerObjectCardId }
            : {}),
        };
        // "You may pay {R}. If you do, …" (Spit Flame) — a choice condition needs the
        // interactive `resolveCondition`, not the pure `evaluateCondition` every other
        // `conditionalEffect` (Provoke the Trolls, Stubborn Denial) uses.
        const holds = isChoiceCondition(effect.condition)
          ? yield* resolveCondition(ctx, effect.condition, conditionSource, source.name)
          : evaluateCondition(ctx, effect.condition, conditionSource);
        const chosen = holds ? effect.then : effect.else;
        if (chosen.length > 0) {
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: chosen },
            targets,
            effectiveTriggerObjectCardId,
            effect.checkTarget === undefined
              ? extraScope
              : {
                  ...extraScope,
                  eventObjectId: checkTargetId ?? '',
                  triggerObjectId: checkTargetId ?? '',
                },
            countTargets,
            divisionAmounts,
          );
        }
        break;
      }
      case 'counterUnlessControllerPays': {
        // Stubborn Denial's base mode. Unlike ward's `counterUnlessPays`, this reads a real,
        // announced target slot rather than a recorded stack-object id — `ref` already reruns
        // the CR 608.2b legality check before handing back an id.
        const t = ref(effect.target);
        if (t === null) break;
        yield* counterUnlessPays(ctx, source, t, {
          kind: 'mana',
          cost: effect.cost,
        });
        break;
      }
      case 'unlessPays': {
        let payerId: PlayerId | undefined;
        if (effect.payer === 'eventPlayer') {
          payerId = scope.eventPlayerId;
        } else if (effect.payer === 'controller') {
          payerId = controller.id;
        } else {
          // 'eventObjectController' — ask the CURRENT controller of the exact original event
          // permanent; once it has departed, the controller it last had (departure LKI,
          // CR 608.2h). Never the ability's event player, never a blinked new incarnation.
          if ((scope.triggerObjectId ?? scope.eventObjectId) === undefined)
            throw new Error(source.name + ': unlessPays has no exact event object');
          payerId = eventObjectFacts(ctx, scope)?.candidate.controllerId as PlayerId | undefined;
        }
        if (payerId === undefined) throw new Error(source.name + ': unlessPays has no payer');
        const payer = playerById(ctx, payerId);
        // "…pays {X}, where X is this creature's power" — resolved now, against the source as it
        // currently is (CR 608.2), and folded into the generic portion of the printed cost.
        const owed =
          effect.genericValue === undefined
            ? effect.cost
            : addGeneric(effect.cost, evaluateValueIn(ctx, effect.genericValue, scope));
        const costDescription = describeManaCost(owed);
        const canAfford =
          // A payer who left the game cannot pay (CR 800.4): no prompt, just the unpaid branch.
          // Scoped to the event-object payer so the existing payer values behave exactly as before.
          !(effect.payer === 'eventObjectController' && payer.hasLost) &&
          canPay(owed, payer.manaEntries, manaSourcesFor(ctx, payer.id));
        let paid = false;
        let notPaidReason: 'declined' | 'unable' = 'unable';
        if (canAfford) {
          const outcome = yield {
            decisionType: 'general' as const,
            player: payer.id,
            prompt: source.name + ': pay ' + costDescription + ' or its effect does not happen.',
            options: [
              { type: 'payCost', description: 'Pay ' + costDescription },
              { type: 'decline', description: "Don't pay " + costDescription },
            ],
          };
          if (outcome.index === 0) {
            yield* payManaCost(ctx, payer, owed);
            emit(
              ctx,
              'unlessPaid',
              { source: source.name, player: payer.id, cost: costDescription },
              payer.id,
            );
            paid = true;
          } else {
            notPaidReason = 'declined';
          }
        }
        if (!paid) {
          emit(
            ctx,
            'unlessNotPaid',
            {
              source: source.name,
              player: payer.id,
              cost: costDescription,
              reason: notPaidReason,
            },
            payer.id,
          );
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: effect.then },
            targets,
            triggerObjectCardId,
            extraScope,
            countTargets,
            divisionAmounts,
          );
        }
        break;
      }
      case 'grantAbilityUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} gains ability until end of turn`,
          targetCardIds: [perm.cardId],
          kind: 'grantAbility',
          ability: effect.ability,
          timestamp: ctx.state.nextTimestamp++,
        });
        break;
      }
      case 'becomeCreatureUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} becomes a ${effect.power}/${effect.toughness} ${effect.subtypes.join(' ')} creature until end of turn`,
          targetCardIds: [perm.cardId],
          kind: 'becomeCreature',
          becomeCreature: {
            addSubtypes: effect.subtypes,
            power: effect.power,
            toughness: effect.toughness,
            addKeywords: effect.keywords,
            ...(effect.replaceTypes !== undefined ? { replaceTypes: effect.replaceTypes } : {}),
            ...(effect.colors !== undefined ? { setColors: [...effect.colors] } : {}),
            ...(effect.supertypes !== undefined ? { supertypes: [...effect.supertypes] } : {}),
          },
          timestamp: ctx.state.nextTimestamp++,
        });
        emit(ctx, 'becomeCreature', { source: source.name, target: perm.name });
        break;
      }
      case 'crewVehicle':
      case 'becomeArtifactCreature': {
        const t = ref('source');
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} becomes an artifact creature until end of turn`,
          targetCardIds: [perm.cardId],
          kind: 'becomeCreature',
          becomeCreature: {
            addSubtypes: [],
            power: perm.power ?? 0,
            toughness: perm.toughness ?? 0,
            addKeywords: [],
          },
          timestamp: ctx.state.nextTimestamp++,
        });
        emit(ctx, 'becomeCreature', { source: source.name, target: perm.name });
        // "Whenever this Vehicle becomes crewed" means "whenever a crew ability of it resolves"
        // (CR 702.122e); another effect that animates the Vehicle does not crew it.
        if (effect.op === 'crewVehicle') queueTriggersForObject(ctx, 'becomesCrewed', perm);
        break;
      }
      case 'fightUpToOneChosen': {
        const aId = ref(effect.a);
        const bId = countTargets?.[effect.bSlot]?.[0];
        if (aId === null || bId === undefined) break;
        // An illegal target fights nothing (CR 701.14b, 608.2b).
        const bSpec = ability.targets[effect.bSlot];
        if (bSpec !== undefined && !stillLegal(bId, bSpec)) break;
        const a = findPermanent(ctx, aId);
        const currentBId = movedReferent(bId);
        const b = currentBId === null ? undefined : findPermanent(ctx, currentBId);
        if (a === undefined || b === undefined || a.id === b.id) break;
        // CR 701.14b: if either is no longer a creature, neither fights.
        if (!isCreaturePermanent(ctx, a) || !isCreaturePermanent(ctx, b)) break;
        const aPower = effectivePT(ctx, a).power;
        const bPower = effectivePT(ctx, b).power;
        const aTraits = combatDamageTraits(ctx, a);
        const bTraits = combatDamageTraits(ctx, b);
        yield* dealDamageToCreature(ctx, permanentSource(a), b, aPower, {
          combat: false,
          sourceHasDeathtouch: aTraits.deathtouch,
          sourceHasLifelink: aTraits.lifelink,
          sourceHasInfect: aTraits.infect,
          sourceTraits: aTraits,
        });
        yield* dealDamageToCreature(ctx, permanentSource(b), a, bPower, {
          combat: false,
          sourceHasDeathtouch: bTraits.deathtouch,
          sourceHasLifelink: bTraits.lifelink,
          sourceHasInfect: bTraits.infect,
          sourceTraits: bTraits,
        });
        emit(ctx, 'fight', { source: source.name, first: a.name, second: b.name });
        queueTriggersForObject(ctx, 'fights', a);
        queueTriggersForObject(ctx, 'fights', b);
        break;
      }
      case 'discardHand': {
        yield* discardCards(ctx, controller, controller.hand.length);
        break;
      }
      case 'eachPlayerDiscardHandThenDraw': {
        // Two phases, not one loop. CR 608.2 resolves the whole discard before the whole draw,
        // and Windfall's count cannot be known until every hand has been discarded. Splitting it
        // also fixes the fixed-count case, where a player who discarded early would otherwise
        // have already drawn before a later player discarded.
        const discarded = new Map<PlayerId, number>();
        for (const player of ctx.state.players) {
          if (player.hasLost) continue;
          const size = player.hand.length;
          discarded.set(player.id, size);
          yield* discardCards(ctx, player, size);
        }
        const fixed = effect.count === undefined ? undefined : amountOf(effect.count);
        const greatest = Math.max(0, ...discarded.values());
        for (const player of ctx.state.players) {
          if (player.hasLost) continue;
          // "cards equal to the greatest number a player discarded this way" is the SAME number
          // for everyone — the maximum across players, not each player's own discard.
          yield* drawCards(ctx, player, fixed ?? greatest);
        }
        break;
      }
      case 'returnDiedSourceToBattlefield': {
        // Only the card this very permanent became (CR 400.7e): a card that left the graveyard
        // and came back is a new object, and a token never reaches a graveyard at all.
        const departed = source.id;
        if (departed === undefined) break;
        const card = ctx.state.players
          .flatMap((player) => player.graveyard)
          .find(
            (candidate) =>
              candidate.cardId === source.cardId && candidate.leftBattlefieldObjectId === departed,
          );
        if (card === undefined) break;
        emit(ctx, 'graveyardToBattlefield', { target: card.name, source: source.name });
        yield* moveObject(ctx, card, {
          zone: 'battlefield',
          controllerId: card.ownerId,
          withCounters: { [effect.counter]: 1 },
        });
        break;
      }
      case 'putDepartedSourceIntoLibrary': {
        // Only the card this very permanent became in a graveyard or exile (CR 400.7e).
        const departed = source.id;
        if (departed === undefined) break;
        const card = [
          ...ctx.state.players.flatMap((player) => player.graveyard),
          ...ctx.state.exile,
        ].find(
          (candidate) =>
            candidate.cardId === source.cardId && candidate.leftBattlefieldObjectId === departed,
        );
        if (card === undefined) break;
        yield* moveObject(ctx, card, { zone: 'library', libraryCardsAbove: effect.fromTop - 1 });
        break;
      }
      case 'returnDepartedSourceToHand': {
        // Only the card this very permanent became in a graveyard or exile (CR 400.7e).
        const departed = source.id;
        if (departed === undefined) break;
        const card = [
          ...ctx.state.players.flatMap((player) => player.graveyard),
          ...(effect.fromGraveyard === true ? [] : ctx.state.exile),
        ].find(
          (candidate) =>
            candidate.cardId === source.cardId && candidate.leftBattlefieldObjectId === departed,
        );
        if (card === undefined) break;
        yield* moveObject(ctx, card, { zone: 'hand' });
        break;
      }
      case 'exileTargetReturnAtNextEndStep': {
        const targetId = ref(effect.target);
        const perm = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (perm === undefined) break;
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        const exiled = yield* moveObject(ctx, perm, { zone: 'exile' });
        // A token ceased to exist; a commander may already have gone to the command zone.
        if (exiled === null || exiled.zone !== 'exile') break;
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId as never,
          controllerId: source.controllerId,
          targetId: exiled.cardId,
          targetObjectId: exiled.id,
          when: 'endStep',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'returnExiledTriggerObject', returnUnder: effect.returnUnder }],
            description: `Return ${exiled.name} to the battlefield`,
          },
          // Survives a cleanup it has not reached yet: an end step that already began (this
          // resolved during it) is not "the next" one.
          expiry: 'onFire',
        });
        break;
      }
      case 'returnExiledTriggerObject': {
        const remembered = extraScope?.triggerObjectId;
        const card = ctx.state.exile.find((candidate) => candidate.id === remembered);
        if (card === undefined) break;
        yield* moveObject(ctx, card, {
          zone: 'battlefield',
          controllerId: effect.returnUnder === 'owner' ? card.ownerId : source.controllerId,
        });
        break;
      }
      case 'reanimateTargetHasteExileAtYourNextEndStep': {
        const targetId = ref(effect.target);
        const card = targetId === null ? undefined : findObjectById(ctx, targetId);
        if (card === undefined || card.zone !== 'graveyard') break;
        const entered = yield* moveObject(ctx, card, {
          zone: 'battlefield',
          controllerId: source.controllerId,
        });
        if (entered === null || entered.zone !== 'battlefield') break;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${entered.name} gains haste`,
          targetCardIds: [entered.cardId],
          targetObjectIds: [entered.id],
          kind: 'grantKeyword',
          keyword: 'haste',
          duration: 'permanent',
          timestamp: ctx.state.nextTimestamp++,
        });
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId as never,
          controllerId: source.controllerId,
          targetId: entered.cardId,
          targetObjectId: entered.id,
          when: 'endStep',
          player: 'you',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'exile', target: 'triggerObject' }],
            description: `Exile ${entered.name}`,
          },
          expiry: 'onFire',
        });
        break;
      }
      case 'returnDiedTriggerObjectTapped': {
        const remembered = extraScope?.triggerObjectId;
        if (remembered === undefined) break;
        const card = ctx.state.players
          .flatMap((player) => player.graveyard)
          .find((candidate) => candidate.leftBattlefieldObjectId === remembered);
        if (card === undefined) break;
        yield* moveObject(ctx, card, {
          zone: 'battlefield',
          controllerId: source.controllerId,
          entersTapped: true,
        });
        break;
      }
      case 'returnDiedTriggerObjectAtNextEndStep': {
        // The card the dying subject became in a graveyard (CR 400.7e); a card already gone from
        // there, or a token that ceased to exist, returns nothing.
        const remembered = extraScope?.triggerObjectId ?? extraScope?.eventObjectId;
        if (remembered === undefined) break;
        const card = ctx.state.players
          .flatMap((player) => player.graveyard)
          .find((candidate) => candidate.leftBattlefieldObjectId === remembered);
        if (card === undefined) break;
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId as never,
          controllerId: source.controllerId,
          targetId: card.cardId,
          targetObjectId: card.id,
          when: 'endStep',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'returnRememberedGraveyardCard', returnUnder: effect.returnUnder }],
            description: `Return ${card.name} to the battlefield`,
          },
          // An end step that already began (this resolved during it) is not "the next" one.
          expiry: 'onFire',
        });
        break;
      }
      case 'returnRememberedGraveyardCard': {
        const remembered = extraScope?.triggerObjectId;
        const card = ctx.state.players
          .flatMap((player) => player.graveyard)
          .find((candidate) => candidate.id === remembered);
        if (card === undefined) break;
        const host = effect.attachToObjectId;
        if (host !== undefined && findPermanent(ctx, host) === undefined) break;
        // Logged only once it lands: moveObject refuses a host the Aura can't enchant.
        const returned = yield* moveObject(ctx, card, {
          zone: 'battlefield',
          controllerId: effect.returnUnder === 'owner' ? card.ownerId : source.controllerId,
          ...(host === undefined ? {} : { attachedTo: host }),
        });
        if (returned !== null && returned.zone === 'battlefield')
          emit(ctx, 'graveyardToBattlefield', { target: card.name, source: source.name });
        break;
      }
      case 'returnDepartedSourceToBattlefield': {
        const departed = source.id;
        if (departed === undefined) break;
        const graveyards =
          effect.fromYourGraveyard === true
            ? [controller.graveyard]
            : ctx.state.players.map((player) => player.graveyard);
        const card = graveyards
          .flat()
          .find(
            (candidate) =>
              candidate.cardId === source.cardId && candidate.leftBattlefieldObjectId === departed,
          );
        if (card === undefined) break;
        let host: ObjectId | undefined;
        if (effect.attachTo === 'triggerObject') {
          // The card the trigger object became, followed through this resolution's own moves:
          // "return that card ... Return this card ... attached to that creature".
          const destination = scope.eventObjectDestinationId;
          const current = destination === undefined ? null : movedReferent(destination);
          if (current === null || findPermanent(ctx, current) === undefined) break;
          host = current;
        }
        if (effect.delay === 'nextEndStep') {
          ctx.state.delayedTriggers.push({
            id: `dt-${ctx.state.nextObjectNum++}`,
            sourceCardId: source.cardId,
            sourceOracleId: source.oracleId as never,
            controllerId: source.controllerId,
            targetId: card.cardId,
            targetObjectId: card.id,
            when: 'endStep',
            ability: {
              kind: 'triggered',
              targets: [],
              effects: [
                {
                  op: 'returnRememberedGraveyardCard',
                  returnUnder: 'sourceController',
                  ...(host === undefined ? {} : { attachToObjectId: host }),
                },
              ],
              description: `Return ${card.name} to the battlefield`,
            },
            // An end step that already began (this resolved during it) is not "the next" one.
            expiry: 'onFire',
          });
          break;
        }
        const returned = yield* moveObject(ctx, card, {
          zone: 'battlefield',
          controllerId: source.controllerId,
          ...(host === undefined ? {} : { attachedTo: host }),
        });
        if (returned !== null && returned.zone === 'battlefield')
          emit(ctx, 'graveyardToBattlefield', { target: card.name, source: source.name });
        break;
      }
      case 'reanimateEachChosenTapped': {
        // The legal chosen cards still in a graveyard (CR 608.2b), entering together (CR 603.6a).
        const cards = chosenReferents(effect.targetSlot).flatMap((cardId) => {
          const card = ctx.state.players
            .flatMap((player) => player.graveyard)
            .find((candidate) => candidate.id === cardId);
          return card === undefined ? [] : [card];
        });
        yield* moveObjects(ctx, cards, {
          zone: 'battlefield',
          controllerId: source.controllerId,
          entersTapped: true,
        });
        break;
      }
      case 'returnSelfFromGraveyardToHand': {
        // The ability's own graveyard card, and only while it is that object (CR 400.7): a card
        // that left the graveyard and came back is a new object.
        const card = controller.graveyard.find(
          (c) => c.cardId === source.cardId && (source.id === undefined || c.id === source.id),
        );
        if (card === undefined) break;
        yield* moveObject(ctx, card, { zone: 'hand' });
        break;
      }
      case 'shuffleChosenGraveyardCardsIntoLibrary': {
        const playerId = ref(effect.playerSlot);
        const target =
          playerId === null ? undefined : ctx.state.players.find((p) => p.id === playerId);
        if (target === undefined) break;
        const chosenIds = countTargets?.[effect.cardsSlot] ?? [];
        const chosen = chosenIds.flatMap((cardId) => {
          const currentId = movedReferent(cardId);
          const card = target.graveyard.find((c) => c.id === currentId);
          return card === undefined ? [] : [card];
        });
        yield* moveObjects(ctx, chosen, { zone: 'library', libraryPosition: 'bottom' });
        ctx.rng.shuffle(target.library);
        emit(ctx, 'shuffle', { player: target.id }, target.id);
        break;
      }
      case 'destroyEachNonlandMVFromDamagedControllers': {
        const mv = amountOf(effect.mv);
        const damagedControllers = new Set(
          ctx.state.combatDamagePlayersBySource[source.cardId] ?? [],
        );
        const toDestroy = ctx.state.battlefield.filter((p) => {
          if (!damagedControllers.has(p.controllerId)) return false;
          const chars = computeCharacteristics(ctx, p);
          if (chars.types.includes('Land')) return false;
          const def = getDefByOracleId(ctx, p.oracleId, p.name);
          return spellManaValue(def, undefined) === mv;
        });
        for (const perm of toDestroy) {
          yield* destroyPermanent(ctx, source, perm);
        }
        break;
      }
      case 'mayPayXThenDealDamage': {
        const t = ref(effect.target);
        if (t === null) break;
        const sources = manaSourcesFor(ctx, controller.id);
        const allows = allowanceFor(ctx, controller.id, { kind: 'other' });
        // Search upward for the largest affordable X; a hard cap guards against a templated
        // cost with no `{X}` symbol ever growing, which would make every candidate identical
        // and loop forever (see the op's doc comment).
        const hardCap = controller.manaEntries.length + sources.length * 2 + 1;
        const choices: number[] = [];
        for (let x = 0; x <= hardCap; x++) {
          if (!canPay(withX(effect.templatedCost, x), controller.manaEntries, sources, allows))
            break;
          choices.push(x);
        }
        if (choices.length === 0) break;
        // Declining and paying X=0 (just the rest of the cost, e.g. {R}) are different choices
        // (CR 107.3b, 601.2b): the second spends mana, the first does not.
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay ${describeManaCost(effect.templatedCost)} for X?`,
          options: [
            plainOption({ type: 'decline', description: "Don't pay", verb: 'Decline' }),
            ...choices.map((x) => ({
              type: 'payX',
              description: `Pay X=${x} (${describeManaCost(withX(effect.templatedCost, x))})`,
            })),
          ],
        };
        if (outcome.index <= 0) break;
        const chosenX = choices[outcome.index - 1] ?? 0;
        yield* payManaCost(ctx, controller, withX(effect.templatedCost, chosenX));
        yield* dealDamageToObject(ctx, source, t, chosenX);
        break;
      }
      case 'exileTopNPlayableUntilEot': {
        const count = amountOf(effect.count);
        for (let i = 0; i < count; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          const moved = (yield* moveObject(ctx, top, { zone: 'exile' })) as EngineCardObject | null;
          if (moved !== null) {
            moved.playableUntilEotBy = controller.id;
            if (effect.castOnly === true) moved.castOnlyUntilEot = true;
          }
        }
        break;
      }
      case 'lookAtTopNCastOneFree': {
        yield* lookAtLibraryAndCast(ctx, source, controller.id, {
          count: typeof effect.count === 'number' ? effect.count : amountOf(effect.count),
          ...(effect.filter === undefined ? {} : { filter: effect.filter }),
          ...(effect.maxManaValue === undefined
            ? {}
            : { maxManaValue: amountOf(effect.maxManaValue) }),
          ...(effect.visibility === undefined ? {} : { visibility: effect.visibility }),
        });
        break;
      }
      case 'castOneFromHandFreeUpTo': {
        const eligible = controller.hand.filter((card) => {
          if (!freeCardIsCastable(ctx, card, controller.id)) return false;
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          return spellManaValue(def, undefined) <= effect.maxManaValue;
        });
        if (eligible.length === 0) break;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: cast one spell with mana value ${effect.maxManaValue} or less without paying its mana cost, or decline.`,
          options: [
            ...eligible.map((card) =>
              cardOption(ctx, card, {
                viewerId: controller.id,
                type: 'castFree',
                description: `Cast ${card.name} without paying its mana cost`,
                verb: 'Cast for free',
              }),
            ),
            plainOption({ type: 'decline', description: 'Cast no spell', verb: 'Done' }),
          ],
        };
        if (outcome.index < eligible.length) {
          const chosen = eligible[outcome.index];
          if (chosen !== undefined) yield* resolveFreeCard(ctx, chosen, controller.id);
        }
        break;
      }
      case 'castForLifeFromZones': {
        const lifeFor = (card: EngineCardObject): number =>
          spellManaValue(getDefByOracleId(ctx, card.oracleId, card.name), undefined);
        const zoneOf = (card: EngineCardObject): string =>
          controller.hand.includes(card) ? 'hand' : 'graveyard';
        const eligible = effect.zones
          .flatMap((zone) => (zone === 'hand' ? controller.hand : controller.graveyard))
          .filter(
            (card) =>
              selectMatches(cardZoneCandidate(ctx, card, controller.id), effect.selector, {
                cardId: source.cardId,
                controllerId: controller.id,
              }) && freeCardIsCastable(ctx, card, controller.id, Infinity, lifeFor(card)),
          );
        if (eligible.length === 0) break;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: you may cast an artifact spell by paying life equal to its mana value.`,
          options: [
            ...eligible.map((card) =>
              cardOption(ctx, card, {
                viewerId: controller.id,
                type: 'castForLife',
                description: `Cast ${card.name} from your ${zoneOf(card)} for ${lifeFor(card)} life`,
                verb: 'Cast',
              }),
            ),
            plainOption({ type: 'decline', description: 'Cast no spell', verb: 'Done' }),
          ],
        };
        const chosen = outcome.index < eligible.length ? eligible[outcome.index] : undefined;
        if (chosen !== undefined)
          yield* resolveFreeCard(ctx, chosen, controller.id, Infinity, lifeFor(chosen));
        break;
      }
      case 'castAnyFromHandFree': {
        for (;;) {
          const eligible = controller.hand.filter((card) =>
            freeCardIsCastable(ctx, card, controller.id),
          );
          if (eligible.length === 0) break;
          const options = [
            ...eligible.map((card) =>
              cardOption(ctx, card, {
                type: 'castFree',
                description: `Cast ${card.name} without paying its mana cost`,
                verb: 'Cast for free',
              }),
            ),
            plainOption({ type: 'decline', description: 'Cast no more spells', verb: 'Done' }),
          ];
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `${source.name}: cast any number of spells from your hand for free. Choose one or Done.`,
            options,
          };
          if (outcome.index >= eligible.length) break;
          const chosen = eligible[outcome.index];
          if (chosen === undefined) break;
          yield* resolveFreeCard(ctx, chosen, controller.id);
        }
        break;
      }
      case 'registerDelayedTrigger': {
        assertDelayedTriggerEvent(effect.when);
        if (!['endStep', 'cleanup', 'onFire'].includes(effect.expiry))
          throw new Error('invalid delayed trigger expiry');
        // A delayed ability inherits the exact event/destination binding, including when
        // that object has already left. It cannot acquire a new incarnation by card identity.
        const eventBinding =
          effect.target === 'triggerObject'
            ? (scope.eventObjectDestinationId ?? scope.triggerObjectId ?? scope.eventObjectId)
            : undefined;
        const currentEventBinding =
          eventBinding === undefined ? undefined : movedReferent(eventBinding);
        const t =
          effect.target === 'triggerObject'
            ? triggerObjectCardId === undefined
              ? null
              : eventBinding === undefined
                ? (findPhysicalObjectByCardId(ctx, triggerObjectCardId)?.id ?? null)
                : currentEventBinding !== null &&
                    currentEventBinding !== undefined &&
                    findObjectById(ctx, currentEventBinding) !== undefined
                  ? currentEventBinding
                  : null
            : effect.target !== undefined
              ? ref(effect.target)
              : null;
        const targetPlayer =
          t === null ? undefined : ctx.state.players.find((player) => player.id === t);
        const targetStack =
          t === null ? undefined : ctx.state.stack.find((entry) => entry.id === t);
        const targetObject = t === null ? undefined : findObjectById(ctx, t);
        const capturedTargetController =
          typeof effect.target === 'number' && refControllerCache.has(effect.target)
            ? refControllerCache.get(effect.target)
            : (targetPlayer?.id ??
              targetStack?.controllerId ??
              (targetObject as unknown as { controllerId?: PlayerId } | undefined)?.controllerId ??
              (effect.target === 'triggerObject'
                ? (eventObjectFacts(ctx, scope)?.candidate.controllerId as PlayerId | undefined)
                : undefined));
        // A remembered trigger object that no longer exists anywhere (a token that died fighting
        // and ceased to exist) still names its card, so the delayed ability does nothing.
        const goneTriggerObjectCardId =
          t === null && effect.target === 'triggerObject' ? triggerObjectCardId : undefined;
        const targetId =
          t === null
            ? goneTriggerObjectCardId
            : targetPlayer !== undefined
              ? targetPlayer.id
              : (targetStack?.controllerId ?? targetObject?.cardId);
        const delayedController =
          effect.controller === 'targetController'
            ? (capturedTargetController ?? source.controllerId)
            : source.controllerId;
        const affectedPlayerId =
          effect.affectedPlayer === 'sourceController'
            ? source.controllerId
            : effect.affectedPlayer === 'activePlayer'
              ? ctx.state.currentTurnPlayer
              : effect.affectedPlayer === 'targetController'
                ? capturedTargetController
                : undefined;
        if (effect.affectedPlayer === 'targetController' && affectedPlayerId === undefined) {
          throw new Error(
            `engine bug: ${source.name} affected target controller could not be captured`,
          );
        }
        // `t` is the object's current id in whatever zone it is in; a creature that already died
        // keeps a graveyard id that no later battlefield object can ever match.
        // The trigger object as it was when the event fired, when the firing trigger captured
        // it: a creature blinked in response is a new object that never fought (CR 400.7).
        const rememberedObjectId =
          eventBinding !== undefined
            ? (currentEventBinding ?? eventBinding)
            : effect.sameObject === true || targetObject !== undefined
              ? (t ?? undefined)
              : undefined;
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          controllerId: delayedController,
          ...(targetId !== undefined ? { targetId } : {}),
          ...(rememberedObjectId !== undefined ? { targetObjectId: rememberedObjectId } : {}),
          when: effect.when,
          ability: effect.ability,
          expiry: effect.expiry,
          ...(affectedPlayerId !== undefined ? { affectedPlayerId } : {}),
        });
        break;
      }
      case 'commandZoneToHand': {
        // Every commander the controller owns that is currently IN the command zone. A player
        // with partners has two; one already on the battlefield or in a graveyard is not here
        // and is correctly untouched.
        const owner = playerById(ctx, source.controllerId);
        for (const card of [...owner.commandZone]) {
          if (!owner.commanderCardIds.includes(card.cardId)) continue;
          yield* moveObject(ctx, card, { zone: 'hand' });
        }
        break;
      }
      case 'commandZoneToBattlefield': {
        const t = ref(effect.target);
        if (t === null) break;
        const player = playerById(ctx, source.controllerId);
        const card = player.commandZone.find((c) => c.id === t);
        if (card) {
          yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: source.controllerId });
          if (effect.entersHaste) {
            ctx.state.effects.push({
              id: `eff-${ctx.state.nextObjectNum++}`,
              sourceId: source.cardId,
              description: `${card.name} gains haste until end of turn`,
              targetCardIds: [card.cardId],
              kind: 'grantKeyword',
              keyword: 'haste',
              timestamp: ctx.state.nextTimestamp++,
            });
          }
        }
        break;
      }
      case 'returnToCommandZone': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm) {
          yield* moveObject(ctx, perm, { zone: 'command' });
        }
        break;
      }
      case 'grantHasteToResolvingSpell': {
        const spell = ctx.state.stack.find((s) => s.kind === 'spell');
        if (spell) {
          spell.grantHasteOnResolution = true;
        }
        break;
      }
      case 'bounceUpTo6MV': {
        const eligible = ctx.state.battlefield.filter(
          (p) => !computeCharacteristics(ctx, p).types.includes('Land'),
        );
        if (eligible.length > 0) {
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt:
              'Kairi: choose nonland permanents with total mana value 6 or less to return to hands',
            options: [
              ...eligible.map((p) => ({
                type: 'returnToHand',
                description: `Return ${p.name}`,
                payload: p.id,
              })),
              { type: 'decline', description: 'Done returning permanents' },
            ],
          };
          if (outcome.index < eligible.length) {
            const chosen = eligible[outcome.index] as EnginePermanent;
            emit(ctx, 'returnToHand', { target: chosen.name, source: source.name });
            yield* moveObject(ctx, chosen, { zone: 'hand' });
          }
        }
        break;
      }
      case 'millAndReturnSpells': {
        // `library[0]` is the top of the library everywhere else in the engine (`drawCards`,
        // `moveObject`'s `libraryPosition: 'top'` via `unshift`) — this read the OTHER end,
        // milling from the bottom instead of the top.
        const n = Math.min(6, controller.library.length);
        for (let i = 0; i < n; i++) {
          const topCard = controller.library[0] as EngineCardObject;
          yield* moveObject(ctx, topCard, { zone: 'graveyard' });
          // The same per-card event the generic `mill` op emits, so "mills" reads the same.
          emit(
            ctx,
            'mill',
            { player: controller.id, cardId: topCard.cardId, name: topCard.name },
            controller.id,
          );
        }
        for (let pass = 0; pass < 2; pass++) {
          const spellsInGy = controller.graveyard.filter((c) => {
            const def = getDefByOracleId(ctx, c.oracleId, c.name);
            return def.types.includes('Instant') || def.types.includes('Sorcery');
          });
          if (spellsInGy.length === 0) break;
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `Kairi: choose instant/sorcery card from graveyard to return to hand (${pass + 1}/2)`,
            options: [
              // No raw `payload` — graveyard cards render in `ZoneStrip` for preview only, with
              // no click handler, so a payload-derived `subjectId` would strand the option
              // behind an unreachable "click the board object" affordance.
              ...spellsInGy.map((c) =>
                cardOption(ctx, c, {
                  viewerId: controller.id,
                  type: 'returnToHand',
                  description: `Return ${c.name} from graveyard`,
                  verb: 'Return to hand',
                }),
              ),
              plainOption({
                type: 'decline',
                description: 'Done returning spells',
                verb: 'Done',
                role: 'decline',
              }),
            ],
          };
          if (outcome.index >= spellsInGy.length) break;
          const chosen = spellsInGy[outcome.index] as EngineCardObject;
          emit(ctx, 'graveyardToHand', { target: chosen.name, source: source.name });
          yield* moveObject(ctx, chosen, { zone: 'hand' });
        }
        break;
      }
      case 'tapEach': {
        for (const perm of affectedBy(ctx, source, effect.selector, extraScope?.eventPlayerId)) {
          if (perm.tapped) continue;
          perm.tapped = true;
          queueTriggersForObject(ctx, 'becomesTapped', perm);
        }
        break;
      }
      case 'tapTarget': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm !== undefined && !perm.tapped) {
          perm.tapped = true;
          queueTriggersForObject(ctx, 'becomesTapped', perm);
        }
        break;
      }
      case 'untapTarget': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm) perm.tapped = false;
        break;
      }
      case 'overloadBounceAllNonlandOpponents': {
        const toBounce = ctx.state.battlefield.filter((p) => {
          if (p.controllerId === source.controllerId) return false;
          const chars = computeCharacteristics(ctx, p);
          return !chars.types.includes('Land');
        });
        for (const perm of toBounce) {
          yield* moveObject(ctx, perm, { zone: 'hand' });
        }
        break;
      }
      case 'hideaway':
      case 'hideawayExileTop4': {
        const player = playerById(ctx, source.controllerId);
        const count = effect.op === 'hideaway' ? effect.count : 4;
        const top4 = player.library.slice(0, count);
        if (top4.length === 0) break;
        const chosenCard =
          top4.length === 1
            ? top4[0]!
            : ((yield* chooseCard(ctx, {
                player: source.controllerId,
                prompt: `Look at the top ${count} cards of your library. Exile one of them face down.`,
                cards: top4,
                type: 'hideawayExile',
                verb: 'Exile face down',
              })) ?? top4[0]!);
        const moved = (yield* moveObject(ctx, chosenCard, {
          zone: 'exile',
          faceDown: true,
        })) as EngineCardObject | null;
        if (moved !== null) {
          moved.attachedToCardId = source.cardId;
          if (source.id !== undefined) moved.attachedToObjectId = source.id;
        }

        yield* bottomCards(
          ctx,
          top4.filter((card) => card !== chosenCard),
        );
        break;
      }
      case 'playExiledCardFree': {
        const card = ctx.state.exile.find(
          (candidate) =>
            candidate.attachedToCardId === source.cardId &&
            (source.id === undefined || candidate.attachedToObjectId === source.id),
        );
        if (card === undefined) break;
        const def = getDefByOracleId(ctx, card.oracleId, card.name);
        const isLand = def.types.includes('Land');
        if (
          isLand
            ? ctx.state.currentTurnPlayer !== controller.id ||
              controller.landsPlayedThisTurn >= landPlayLimitFor(ctx, controller.id)
            : !freeCardIsCastable(ctx, card, controller.id)
        )
          break;
        const choice = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `Play ${card.name} without paying its mana cost?`,
          options: [
            { type: 'playFree', description: `Play ${card.name}` },
            { type: 'decline', description: 'Leave the card in exile' },
          ],
        };
        if (choice.index !== 0) break;
        if (isLand) {
          controller.landsPlayedThisTurn++;
          emit(
            ctx,
            'playLand',
            { player: controller.id, name: card.name, cardId: card.cardId },
            controller.id,
          );
          yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: controller.id });
        } else {
          yield* resolveFreeCard(ctx, card, controller.id);
        }
        break;
      }
      case 'flipCoin': {
        // CR 705.2: the flip is random; the game PRNG keeps replays deterministic.
        const won = ctx.rng.nextInt(2) === 0;
        emit(ctx, 'coinFlip', { player: controller.id, source: source.name, won }, controller.id);
        const branch = won ? effect.onWin : effect.onLose;
        if (branch.length > 0)
          yield* executeAbility(
            ctx,
            source,
            { ...ability, effects: branch },
            targets,
            triggerObjectCardId,
            extraScope,
            countTargets,
            divisionAmounts,
          );
        break;
      }
      case 'returnRandomExiledWithSourceToHand': {
        const self = ctx.state.battlefield.find((perm) => perm.cardId === source.cardId);
        const exiled = (self?.exiledWithIds ?? []).flatMap((objectId) => {
          const card = ctx.state.exile.find((entry) => entry.id === objectId);
          return card === undefined ? [] : [card];
        });
        const card = exiled[ctx.rng.nextInt(Math.max(1, exiled.length))];
        if (card === undefined) break;
        emit(ctx, 'returnToHand', { target: card.name, source: source.name });
        yield* moveObject(ctx, card, { zone: 'hand' });
        break;
      }
      case 'noOp':
        throw new Error('engine bug: executable noOp effect is prohibited');

      default:
        assertNever(effect, 'Effect executor');
    }
    // Damage an effect owes for preventing damage is dealt right after that damage event, not
    // as a trigger (Deflecting Palm's rulings).
    yield* flushDamageReflections(ctx);
  }
}

/**
 * Deal the damage that prevention effects queued as "deals that much damage to ..." (Deflecting
 * Palm). It is dealt by the preventing effect as last known, through the same damage pipeline, so
 * it can itself be modified or prevented, which may queue more.
 */
export function* flushDamageReflections(ctx: GameContext): GameGen<void> {
  while (ctx.state.damageReflections.length > 0) {
    const reflection = ctx.state.damageReflections.shift()!;
    ctx.state.damageChain = reflection.chain;
    yield* dealDamageToObject(
      ctx,
      reflection.effectSource,
      reflection.toId as unknown as ObjectId,
      reflection.amount,
    );
    ctx.state.damageChain = [];
  }
}

/**
 * "Add X mana in any combination of colors" (Klauth) — mana entering the pool from a
 * RESOLVING ability rather than an activation (CR 605 vs the stack). The whole distribution is
 * one decision so an AI provider makes one call rather than one call per mana.
 */
function* addManaFromAbility(
  ctx: GameContext,
  source: EffectSource,
  controller: EnginePlayerState,
  effect: Extract<Effect, { op: 'addMana' }>,
  amount: number,
): GameGen<void> {
  const palette = effect.colors === 'any' ? ALL_COLORS : effect.colors;

  // Checked BEFORE the palette, because fixed symbols do not use one. A producer that spells the
  // symbols out passes `colors: []` (there is no choice to make), and the empty-palette guard
  // below used to swallow it — the mana was never added, silently.
  if (effect.fixedSymbols !== undefined) {
    const produced = effect.fixedSymbols.map((symbol) => ({
      symbol,
      ...(effect.restriction !== undefined ? { restriction: effect.restriction } : {}),
      ...(effect.persistent === true ? { persistent: true } : {}),
    }));
    addMana(controller, produced);
    emit(ctx, 'manaAdded', {
      source: source.name,
      player: controller.id,
      symbols: produced.map((entry) => entry.symbol),
    });
    return;
  }

  if (amount <= 0 || palette.length === 0) return;

  // One allowed color is not a choice (brief §5.1 — never ask when there is one legal answer).
  // Jeska's Will's "Add {R} for each card in target opponent's hand" is this case: a computed
  // AMOUNT with a single color, which the distribute prompt below would turn into a decision
  // with exactly one outcome.
  const only = palette.length === 1 ? palette[0] : undefined;
  if (only !== undefined) {
    const produced: ManaEntry[] = Array.from({ length: amount }, () => ({
      symbol: only,
      ...(effect.restriction !== undefined ? { restriction: effect.restriction } : {}),
      ...(effect.persistent === true ? { persistent: true } : {}),
    }));
    addMana(controller, produced);
    emit(ctx, 'manaAdded', {
      source: source.name,
      player: controller.id,
      symbols: produced.map((entry) => entry.symbol),
    });
    return;
  }

  const outcome = yield {
    decisionType: 'general',
    player: controller.id,
    prompt: `${source.name}: distribute all ${amount} mana among the allowed colors. Return manaSplit counts whose sum is exactly ${amount}.`,
    options: palette.map((sym) => ({
      type: 'addMana',
      description: `Distribute ${amount} mana (allowed: {${sym}} and the other listed colors)`,
    })),
    manaSplit: { amount, colors: [...palette] },
  };
  const split = outcome.manaSplit ?? {};
  const validSplit =
    palette.every((sym) => Number.isInteger(split[sym]) && (split[sym] ?? 0) >= 0) &&
    Object.entries(split).every(
      ([sym, count]) =>
        palette.some((allowed) => allowed === sym) && Number.isInteger(count) && count >= 0,
    ) &&
    palette.reduce((total, sym) => total + (split[sym] ?? 0), 0) === amount;
  const counts = validSplit ? split : { [palette[outcome.index] ?? palette[0]]: amount };
  const produced: ManaEntry[] = [];
  for (const sym of palette) {
    for (let i = 0; i < (counts[sym] ?? 0); i++) {
      produced.push({
        symbol: sym,
        ...(effect.restriction !== undefined ? { restriction: effect.restriction } : {}),
        ...(effect.persistent === true ? { persistent: true } : {}),
      });
    }
  }
  addMana(controller, produced);
  emit(ctx, 'manaAdded', {
    source: source.name,
    player: controller.id,
    symbols: produced.map((e) => e.symbol),
  });
}

/**
 * "Put a/any number of `<filter>` cards from your hand onto the battlefield" — Broodcaller
 * Scourge's single mana-value-bounded pick and Last March of the Ents' unbounded "any number"
 * share one loop because both are the same decision, asked once or repeated to a decline.
 *
 * `eligible` is recomputed every iteration rather than fixed up front: nothing in either printed
 * card lets taking one card change whether another still qualifies, but re-deriving it is what
 * makes "no more matches" and "declined" the same exit, checked identically each time.
 */
function* handToBattlefield(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  filter: Selector,
  maxManaValue: number | undefined,
  count: 'one' | 'any',
): GameGen<void> {
  const selectorSource = { cardId: source.cardId, controllerId: player.id };
  for (;;) {
    const eligible = player.hand.filter((card) => {
      if (!selectMatches(cardZoneCandidate(ctx, card, player.id), filter, selectorSource)) {
        return false;
      }
      if (maxManaValue === undefined) return true;
      const def = getDefByOracleId(ctx, card.oracleId, card.name);
      // Off the stack, X counts as 0 (CR 202.3b) — exactly what `spellManaValue(def, undefined)`
      // answers.
      return spellManaValue(def, undefined) <= maxManaValue;
    });
    if (eligible.length === 0) break;

    const outcome = yield {
      decisionType: 'general',
      player: player.id,
      prompt: `${source.name}: you may put a card from your hand onto the battlefield.`,
      options: [
        ...eligible.map((card) => ({
          type: 'putFromHand',
          description: `Put ${card.name} onto the battlefield`,
          payload: card.id,
        })),
        { type: 'decline', description: 'Put none of them' },
      ],
    };
    if (outcome.index >= eligible.length) break;

    const chosen = eligible[outcome.index] as EngineCardObject;
    emit(ctx, 'handToBattlefield', { player: player.id, name: chosen.name });
    yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: player.id });
    if (count === 'one') break;
  }
}

/**
 * "Look at the top N. You may put a `<filter>` card from among them `<somewhere>`. Put the rest
 * on the bottom in a random order."
 *
 * The random order is drawn from `ctx.rng`, the game's single seeded PRNG — never
 * `Math.random` (brief §4/§5.9), or the game stops being replayable.
 */
function* lookAtTopN(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  effect: Extract<Effect, { op: 'lookAtTopN' }>,
): GameGen<void> {
  // Looking does not move cards out of the library. Keep them there while decisions or a
  // destination replacement suspend resolution, so counts and zone queries remain accurate.
  const looked = player.library.slice(0, effect.count);
  if (looked.length === 0) return;

  const mayPut = effect.mayPut;
  let taken: EngineCardObject | undefined;
  if (mayPut !== undefined) {
    const selectorSource = { cardId: source.cardId, controllerId: player.id };
    const eligible = looked.filter((card) =>
      selectMatches(cardZoneCandidate(ctx, card, player.id), mayPut.filter, selectorSource),
    );
    if (eligible.length > 0) {
      const destination = mayPut!.destination;
      const where =
        destination.zone === 'battlefield'
          ? `onto the battlefield${destination.tapped === true ? ' tapped' : ''}`
          : destination.zone === 'libraryTop'
            ? 'on top of your library'
            : `into your ${destination.zone}`;
      const outcome = yield {
        decisionType: 'general',
        player: player.id,
        prompt: `${source.name}: you may put a card from among the top ${looked.length} ${where}.`,
        options: [
          ...eligible.map((card) =>
            cardOption(ctx, card, {
              viewerId: player.id,
              type: 'putFromTop',
              description: `Put ${card.name} ${where}`,
              verb: `Put ${where}`,
            }),
          ),
          plainOption({
            type: 'decline',
            description: 'Put none of them',
            verb: 'Put none of them',
            role: 'decline',
          }),
        ],
      };
      if (outcome.index < eligible.length) taken = eligible[outcome.index];
    }
  }

  if (taken !== undefined) {
    const destination = mayPut!.destination;
    if (mayPut!.reveal === true) {
      emit(
        ctx,
        'revealCard',
        {
          player: player.id,
          cardId: taken.cardId,
          name: taken.name,
          revealed: true,
        },
        player.id,
      );
    }
    if (destination.zone === 'libraryTop') {
      player.library.splice(player.library.indexOf(taken), 1);
      player.library.unshift(taken);
    } else if (destination.zone === 'battlefield') {
      const moved = yield* moveObject(ctx, taken, {
        zone: 'battlefield',
        controllerId: player.id,
        ...(destination.tapped === true ? { entersTapped: true } : {}),
      });
      // An Aura with no legal host never entered (CR 303.4g), so it belongs to the rest.
      if (moved === null) taken = undefined;
      if (mayPut!.attachEquipment === true && moved?.zone === 'battlefield') {
        const equipment = ctx.state.battlefield.find((perm) => perm.id === moved.id);
        if (
          equipment !== undefined &&
          computeCharacteristics(ctx, equipment).subtypes.includes('Equipment')
        ) {
          const hosts = ctx.state.battlefield.filter(
            (perm) =>
              perm.controllerId === player.id &&
              perm.id !== equipment.id &&
              canAttach(ctx, equipment, perm),
          );
          const host = yield* chooseCard(ctx, {
            player: player.id,
            cards: hosts,
            type: 'attachEquipment',
            verb: 'Attach',
            prompt: `${source.name}: you may attach ${equipment.name} to a creature you control.`,
            decline: {
              type: 'decline',
              description: 'Leave the Equipment unattached',
              verb: 'Decline',
            },
          });
          if (host !== null) {
            const permanent = ctx.state.battlefield.find((perm) => perm.id === host.id);
            if (permanent !== undefined) attachPermanent(ctx, equipment, permanent);
          }
        }
      }
    } else {
      yield* moveObject(ctx, taken, { zone: destination.zone });
    }
  }

  // Move the chosen card first, then reorder only the remainder. Reordering within a library
  // is not a zone change; the chosen card's actual move above uses the normal transition path.
  const rest = looked.filter((card) => player.library.includes(card) && card !== taken);
  let ordered = rest;
  if (effect.rest === 'topAnyOrder') {
    ordered = yield* orderForLibrary(ctx, source, player, rest, 'top');
  } else {
    ctx.rng.shuffle(ordered);
  }
  const restObjects = new Set(rest);
  player.library = player.library.filter((card) => !restObjects.has(card));
  if (effect.rest === 'topAnyOrder') {
    const offset = taken !== undefined && mayPut?.destination.zone === 'libraryTop' ? 1 : 0;
    player.library.splice(offset, 0, ...ordered);
  } else {
    player.library.push(...ordered);
  }
  emit(
    ctx,
    'lookAtTop',
    {
      player: player.id,
      looked: looked.length,
      took: taken?.name ?? null,
      ...(taken !== undefined && mayPut?.reveal === true ? { revealed: true } : {}),
    },
    player.id,
  );

  if (effect.mayShuffle === true) {
    const outcome = yield {
      decisionType: 'general',
      player: player.id,
      prompt: `${source.name}: shuffle your library?`,
      options: [
        plainOption({ type: 'shuffle', description: 'Shuffle your library', verb: 'Shuffle' }),
        plainOption({
          type: 'decline',
          description: 'Keep this order',
          verb: 'Keep this order',
          role: 'decline',
        }),
      ],
    };
    if (outcome.index === 0) ctx.rng.shuffle(player.library);
  }
}

/**
 * "Counter it unless its controller pays `<cost>`" — ward's payoff (CR 702.21b) and Stubborn
 * Denial's tax.
 *
 * Identified by stack-object id rather than by target: ward's trigger is not targeted, and the
 * spell it answers may have moved down the stack since. A spell that already left the stack
 * (countered by something else) is simply not there, and this does nothing.
 */
function* counterUnlessPays(
  ctx: GameContext,
  source: EffectSource,
  stackObjectId: string,
  cost: WardCost,
): GameGen<void> {
  const index = ctx.state.stack.findIndex((s) => s.id === stackObjectId);
  const entry = ctx.state.stack[index];
  if (entry === undefined) return;
  // Uncounterable (CR 601): countering would have no effect either way, so there is nothing to
  // pay to prevent — the controller is never asked.
  if (protectedFromCounter(ctx, entry)) return;

  const controller = playerById(ctx, entry.controllerId);
  // A ward tax is neither casting nor activating (CR 106.6), so restricted mana cannot pay it —
  // which the default `ManaAllowance` expresses by refusing every restriction.
  const costDescription =
    cost.kind === 'mana' ? `pay ${describeManaCost(cost.cost)}` : `pay ${cost.amount} life`;
  const canAfford =
    cost.kind === 'mana'
      ? canPay(
          cost.cost,
          controller.manaEntries,
          manaSourcesFor(ctx, controller.id),
          undefined,
          controller.life,
        )
      : controller.life >= cost.amount;
  if (canAfford) {
    const outcome = yield {
      decisionType: 'general',
      player: controller.id,
      prompt: `${source.name}: ${costDescription} or ${entry.description} is countered.`,
      options: [
        { type: 'payCost', description: costDescription.replace(/^pay/, 'Pay') },
        { type: 'decline', description: `Let ${entry.description} be countered` },
      ],
    };
    if (outcome.index === 0) {
      if (cost.kind === 'mana') yield* payManaCost(ctx, controller, cost.cost);
      else payLife(ctx, controller, cost.amount);
      emit(ctx, 'wardPaid', { source: source.name, spell: entry.description }, controller.id);
      return;
    }
  }

  ctx.state.stack.splice(index, 1);
  emit(ctx, 'counterSpell', { countered: entry.description, by: source.name });
  debug(ctx, 'stack', `${entry.description} countered by ${source.name} (unpaid)`);
  if (entry.card !== null) yield* moveObject(ctx, entry.card, { zone: counteredCardZone(entry) });
}

/**
 * Where a countered spell's card goes: its owner's graveyard, unless it was cast with flashback,
 * which exiles it instead "any time it would leave the stack" (CR 702.34a) — countered included,
 * exactly as the fizzle path in `stack.ts` already does.
 */
function counteredCardZone(entry: EngineStackObject): 'exile' | 'graveyard' {
  return entry.exileOnResolution === true ? 'exile' : 'graveyard';
}

/** Shuffle a library with the game's seeded PRNG — never `Math.random` (brief §4/§5.9). */
export function shuffleLibrary(ctx: GameContext, player: EnginePlayerState): void {
  ctx.rng.shuffle(player.library);
  emit(ctx, 'shuffle', { player: player.id }, player.id);
}

/**
 * "Search your library for a Forest card, put it onto the battlefield" (CR 701.19).
 *
 * A stated quality permits failure to find (CR 701.19b); an unrestricted quantity must find
 * as many as possible (CR 701.19d). An explicitly optional search may also find nothing.
 */
function* searchLibrary(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  filter: Selector,
  destinations: readonly SearchDestination[],
  differentNames = false,
  allowFailToFind = false,
  reveal = false,
  /** An extra per-card condition a selector cannot express (a name chosen on resolution). */
  cardFilter: (card: EngineCardObject) => boolean = () => true,
): GameGen<string[]> {
  const selectorSource = { cardId: source.cardId, controllerId: player.id };
  const canFindNothing =
    allowFailToFind || differentNames || filter.kind !== 'allOf' || filter.of.length > 0;
  const chosenNames = new Set<string>();
  const foundCardIds: string[] = [];
  // CR 701.16a: a revealed card is public to every player whatever zone it goes to.
  const found = (card: EngineCardObject, to: SearchDestination['zone']): void =>
    emit(ctx, 'searchFound', {
      player: player.id,
      name: card.name,
      to,
      ...(reveal ? { revealed: true } : {}),
    });
  for (const destination of destinations) {
    const matches = player.library.filter(
      (card) =>
        (!differentNames || !chosenNames.has(card.name)) &&
        cardFilter(card) &&
        selectMatches(cardZoneCandidate(ctx, card, player.id), filter, selectorSource),
    );
    if (matches.length === 0) break;

    const where =
      destination.zone === 'battlefield'
        ? `onto the battlefield${destination.tapped === true ? ' tapped' : ''}`
        : destination.zone === 'libraryTop'
          ? 'on top of your library'
          : `into your ${destination.zone}`;

    // A mandatory unrestricted search with one matching name has no meaningful card choice.
    // Quality searches must still offer the legal choice to find nothing.
    const distinctNames = new Set(matches.map((c) => c.name));
    if (!canFindNothing && distinctNames.size === 1) {
      const card = matches[0] as EngineCardObject;
      foundCardIds.push(card.cardId);
      if (destination.zone === 'libraryTop') {
        player.library.splice(player.library.indexOf(card), 1);
        shuffleLibrary(ctx, player);
        player.library.unshift(card);
        found(card, destination.zone);
        continue;
      }
      found(card, destination.zone);
      chosenNames.add(card.name);
      yield* moveObject(
        ctx,
        card,
        destination.zone === 'battlefield'
          ? {
              zone: 'battlefield',
              controllerId: player.id,
              ...(destination.tapped === true ? { entersTapped: true } : {}),
            }
          : { zone: destination.zone },
      );
      continue;
    }

    const outcome = yield {
      decisionType: 'general',
      player: player.id,
      prompt: `${source.name}: search your library for a card to put ${where}.`,
      presentationSource: presentedSource(ctx, source),
      options: [
        ...matches.map((card) =>
          cardOption(ctx, card, {
            viewerId: player.id,
            type: 'findCard',
            description: `Put ${card.name} ${where}`,
            verb: `Put ${where}`,
          }),
        ),
        ...(canFindNothing
          ? [
              plainOption({
                type: 'findNothing',
                description: 'Find nothing',
                verb: 'Find nothing',
                role: 'decline',
              }),
            ]
          : []),
      ],
    };
    if (outcome.index >= matches.length) break;

    const card = matches[outcome.index] as EngineCardObject;
    foundCardIds.push(card.cardId);
    if (destination.zone === 'libraryTop') {
      player.library.splice(player.library.indexOf(card), 1);
      shuffleLibrary(ctx, player);
      player.library.unshift(card);
      found(card, destination.zone);
      continue;
    }
    found(card, destination.zone);
    chosenNames.add(card.name);
    yield* moveObject(
      ctx,
      card,
      destination.zone === 'battlefield'
        ? {
            zone: 'battlefield',
            controllerId: player.id,
            ...(destination.tapped === true ? { entersTapped: true } : {}),
          }
        : { zone: destination.zone },
    );
  }
  // The searcher saw their library; shuffling is part of every printed search we model, and the
  // effect list carries an explicit `shuffle` op for it, so nothing is done here.
  return foundCardIds;
}

function* searchLibraryGroup(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  effect: Extract<Effect, { op: 'searchLibraryGroup' }>,
): GameGen<string[]> {
  if (effect.min < 0 || effect.max < effect.min) {
    throw new UnmodeledCardError(
      source.name,
      [`invalid grouped library search bounds ${effect.min}..${effect.max}`],
      'resolving a grouped library search',
    );
  }
  const selectorSource = { cardId: source.cardId, controllerId: player.id };
  const matches = player.library
    .filter((card) =>
      selectMatches(cardZoneCandidate(ctx, card, player.id), effect.filter, selectorSource),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.cardId.localeCompare(b.cardId));

  const selections: EngineCardObject[][] = [];
  const selected: EngineCardObject[] = [];
  const relationHolds = (cards: readonly EngineCardObject[]): boolean => {
    if (effect.relation === undefined || cards.length < 2) return true;
    const subtypeSets = cards.map(
      (card) => new Set(cardZoneCandidate(ctx, card, player.id).subtypes),
    );
    return [...subtypeSets[0]!].some((subtype) =>
      subtypeSets.slice(1).every((subtypes) => subtypes.has(subtype)),
    );
  };
  const buildSelections = (start: number, size: number): void => {
    if (selected.length === size) {
      if (relationHolds(selected)) selections.push([...selected]);
      return;
    }
    for (let index = start; index < matches.length; index++) {
      selected.push(matches[index]!);
      buildSelections(index + 1, size);
      selected.pop();
    }
  };
  for (let size = effect.min; size <= Math.min(effect.max, matches.length); size++) {
    buildSelections(0, size);
  }
  if (selections.length === 0) return [];

  const where =
    effect.destination.zone === 'battlefield'
      ? `onto the battlefield${effect.destination.tapped === true ? ' tapped' : ''}`
      : effect.destination.zone === 'libraryTop'
        ? 'on top of your library'
        : `into your ${effect.destination.zone}`;
  const outcome = yield {
    decisionType: 'general',
    player: player.id,
    prompt: `${source.name}: search your library for ${effect.min === 0 ? 'up to ' : ''}${effect.max} cards to put ${where}.`,
    presentationSource: presentedSource(ctx, source),
    options: selections.map((cards) =>
      cards.length === 0
        ? plainOption({
            type: 'findNothing',
            description: 'Find nothing',
            verb: 'Find nothing',
            role: 'decline',
          })
        : plainOption({
            type: 'findCards',
            description: `Put ${cards.map((card) => card.name).join(' and ')} ${where}`,
            verb: `Put ${where}`,
            data: { cardCount: cards.length, cardNames: cards.map((card) => card.name) },
          }),
    ),
  };
  const chosen = selections[outcome.index] ?? [];
  const foundCardIds: string[] = [];
  for (const card of chosen) {
    foundCardIds.push(card.cardId);
    emit(ctx, 'searchFound', {
      player: player.id,
      name: card.name,
      to: effect.destination.zone,
    });
    if (effect.destination.zone === 'libraryTop') {
      player.library.splice(player.library.indexOf(card), 1);
      shuffleLibrary(ctx, player);
      player.library.unshift(card);
      continue;
    }
    yield* moveObject(
      ctx,
      card,
      effect.destination.zone === 'battlefield'
        ? {
            zone: 'battlefield',
            controllerId: player.id,
            ...(effect.destination.tapped === true ? { entersTapped: true } : {}),
          }
        : { zone: effect.destination.zone },
    );
  }
  return foundCardIds;
}

/** "Search your library for a `<filter>` card and cast that card without paying its mana cost"
 * (Sunforger) — `searchLibrary`'s single-destination search, but the found card is cast for
 * free via `resolveFreeCard` instead of moved to a zone. */
/**
 * Replicate's copies (CR 702.56a): `count` copies of the cast spell, each put on the stack with
 * targets its controller keeps or changes (CR 707.10c). A copy of a permanent spell becomes a
 * token as it resolves (CR 707.10f). If the spell has left the stack, its last known
 * information is copied (CR 707.10).
 */
/**
 * Copy a spell on the stack for `controllerId` (CR 707.10), letting them choose new targets for
 * the copy when the effect says so. A spell that "can't be copied" (Display of Power) is not.
 */
function* copySpellOnStack(
  ctx: GameContext,
  original: EngineStackObject,
  controllerId: PlayerId,
  sourceName: string,
  newTargets: boolean,
): GameGen<EngineStackObject | undefined> {
  if (original.kind !== 'spell' || original.ability === null || original.castInProgress)
    return undefined;
  if (spellDefinitionOf(ctx, original).cantBeCopied === true) return undefined;
  const copy = queueSpellCopy(ctx, original, controllerId);
  if (newTargets) yield* chooseNewStackTargets(ctx, copy, controllerId, sourceName, true);
  else {
    queueWardTriggers(ctx, controllerId, copy.id, allStackTargets(copy));
    queueBecomesTargetedTriggers(ctx, controllerId, allStackTargets(copy));
  }
  emit(
    ctx,
    'spellCopied',
    { name: original.description, targets: allStackTargets(copy) },
    controllerId,
  );
  return copy;
}

/**
 * "One of them" (Twilight Diviner): the controller picks one permanent of the group that fired
 * the trigger. One that has left the battlefield is copied as it last existed (CR 608.2h).
 */
function* chooseEventGroupMember(
  ctx: GameContext,
  controllerId: PlayerId,
  sourceName: string,
  scope: ValueScope,
): GameGen<EnginePermanent | undefined> {
  const members = (scope.eventGroupIds ?? []).flatMap((id): EnginePermanent[] => {
    const live = ctx.state.battlefield.find((permanent) => permanent.id === id);
    if (live !== undefined) return [live];
    const facts = scope.eventGroupFacts?.[id];
    if (facts?.oracleId === undefined) return [];
    return [
      {
        id,
        cardId: facts.candidate.cardId,
        oracleId: facts.oracleId,
        name: facts.name ?? '',
        typeLine:
          getDefByOracleId(ctx, facts.oracleId, facts.name ?? facts.oracleId).typeLine ?? '',
        oracleText: facts.oracleText ?? '',
        manaCost: facts.manaCost ?? null,
        transformed: false,
      } as unknown as EnginePermanent,
    ];
  });
  if (members.length <= 1) return members[0];
  const choice = yield {
    decisionType: 'general',
    player: controllerId,
    prompt: `${sourceName}: choose one of them to copy.`,
    options: members.map((member) =>
      plainOption({ type: 'chooseOption', description: member.name, verb: 'Copy' }),
    ),
  };
  return members[choice.index];
}

/**
 * Copy an activated or triggered ability for `controllerId` (CR 707.10), who may choose new
 * targets for the copy (CR 707.10c). Copies made from last known information work the same way.
 */
function* copyAbilityOnStack(
  ctx: GameContext,
  original: StackAbilitySnapshot,
  controllerId: PlayerId,
  sourceName: string,
): GameGen<EngineStackObject> {
  const copy = queueAbilityCopy(ctx, original, controllerId);
  yield* chooseNewStackTargets(ctx, copy, controllerId, sourceName, true);
  emit(
    ctx,
    'abilityCopied',
    { name: original.description, targets: allStackTargets(copy) },
    controllerId,
  );
  return copy;
}

function* replicateCopies(
  ctx: GameContext,
  controllerId: PlayerId,
  effect: Extract<Effect, { op: 'replicateCopies' }>,
  source: EffectSource,
): GameGen<void> {
  const original = ctx.state.stack.find(
    (entry) => entry.id === effect.spell.stackObjectId && entry.kind === 'spell',
  );
  const def =
    original === undefined
      ? (effect.spell.definition ?? getDefByOracleId(ctx, effect.spell.oracleId, effect.spell.name))
      : spellDefinitionOf(ctx, original);
  const ability = original?.ability ?? effect.spell.ability ?? def.spellAbility;
  if (ability === null || ability === undefined) return;
  // "This spell can't be copied" (Display of Power).
  if (def.cantBeCopied === true) return;
  // "Do this only once each turn" (Cosmic Crucible): keyed by the source object, so a new object
  // of the same card may copy again (CR 400.7).
  const onceKey = `${source.id ?? source.cardId}:copyCastSpell`;
  const taken = (ctx.state.onceEachTurnActionsTaken ??= []);
  if (effect.oncePerTurn === true && taken.includes(onceKey)) return;
  if (effect.optional === true) {
    const outcome = yield {
      decisionType: 'general',
      player: controllerId,
      prompt: `${source.name}: copy ${effect.spell.name}?`,
      options: [
        { type: 'accept', description: `Copy ${effect.spell.name}` },
        { type: 'decline', description: "Don't copy it" },
      ],
    };
    if (outcome.index !== 0) return;
  }
  if (effect.oncePerTurn === true) taken.push(onceKey);
  const originalTargets = original?.targets ?? (effect.spell.targets as ObjectId[]);
  const originalCounted = original?.countTargets ?? effect.spell.countTargets ?? {};
  const originalDivision = original?.divisionAmounts ?? effect.spell.divisionAmounts ?? {};
  for (let copyIndex = 0; copyIndex < effect.count; copyIndex++) {
    const selected = yield* chooseReplicateTargets(
      ctx,
      controllerId,
      effect.spell.name,
      copyIndex,
      effect.count,
      ability,
      targetingFromDefinition(def, 'spell'),
      // The copy is a new object (its id comes later), so the original spell is a legal
      // target for it; only a spell targeting itself is barred (CR 115.5).
      '',
      originalTargets,
      originalCounted,
      originalDivision,
      effect.spell.targetNames,
    );
    const { targets } = selected;
    const copy = queueReplicateCopy(
      ctx,
      controllerId,
      effect.spell,
      original,
      def,
      ability,
      targets,
    );
    if (Object.keys(selected.countTargets).length > 0) copy.countTargets = selected.countTargets;
    if (Object.keys(selected.divisionAmounts).length > 0)
      copy.divisionAmounts = selected.divisionAmounts;
    emit(ctx, 'spellCopied', { name: effect.spell.name, targets }, controllerId);
    // A copy's targets become targets of a spell (ward, "becomes the target") like a cast's.
    const allTargets = [
      ...targets.filter((id) => id !== undefined),
      ...Object.values(copy.countTargets ?? {}).flat(),
    ];
    queueWardTriggers(ctx, controllerId, copy.id, allTargets);
    queueBecomesTargetedTriggers(ctx, controllerId, allTargets);
  }
}

function* searchLibraryCastFree(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  filter: Selector,
): GameGen<void> {
  const selectorSource = { cardId: source.cardId, controllerId: player.id };
  // A spell that could not be cast now ("players can't cast spells during combat") is not
  // offered as a find (CR 101.2).
  const matches = castingSpellsBlockedFor(ctx, player.id)
    ? []
    : player.library.filter((card) =>
        selectMatches(cardZoneCandidate(ctx, card, player.id), filter, selectorSource),
      );
  if (matches.length === 0) return;

  const outcome = yield {
    decisionType: 'general',
    player: player.id,
    prompt: `${source.name}: search your library for a card to cast without paying its mana cost.`,
    presentationSource: presentedSource(ctx, source),
    options: [
      ...matches.map((card) =>
        cardOption(ctx, card, {
          viewerId: player.id,
          type: 'findCard',
          description: `Cast ${card.name} without paying its mana cost`,
          verb: 'Cast for free',
        }),
      ),
      // CR 701.19c: searching never obliges you to find.
      plainOption({
        type: 'findNothing',
        description: 'Find nothing',
        verb: 'Find nothing',
        role: 'decline',
      }),
    ],
  };
  if (outcome.index >= matches.length) return;

  const card = matches[outcome.index] as EngineCardObject;
  emit(ctx, 'searchFound', { player: player.id, name: card.name, to: 'stack' }, player.id);
  yield* resolveFreeCard(ctx, card, player.id);
}

/**
 * Choose an ordering for cards returning to a library. Keeping the existing relative order is
 * always an explicit option, so callers can decline the extra decision work.
 */
function* orderForLibrary(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  cards: EngineCardObject[],
  destination: 'top' | 'bottom',
): GameGen<EngineCardObject[]> {
  if (cards.length < 2) return cards;
  const initial = yield {
    decisionType: 'general',
    player: player.id,
    prompt: `${source.name}: reorder the cards on the ${destination}, or keep their current order?`,
    presentationSource: presentedSource(ctx, source),
    options: [
      plainOption({
        type: 'keepOrder',
        description: `Keep the current ${destination} order`,
        verb: 'Keep current order',
        role: 'decline',
      }),
      plainOption({
        type: 'reorder',
        description: `Choose a new ${destination} order`,
        verb: 'Choose a new order',
        role: 'affirm',
      }),
    ],
  };
  if (initial.index === 0) return cards;

  const remaining = [...cards];
  const ordered: EngineCardObject[] = [];
  while (remaining.length > 0) {
    const chosen = yield* chooseCard(ctx, {
      player: player.id,
      prompt: `${source.name}: choose the next card on the ${destination}.`,
      cards: remaining,
      type: 'orderLibrary',
      verb: `Put next on the ${destination}`,
      describe: (card) => `Put ${card.name} next on the ${destination}`,
    });
    if (chosen === null) throw new Error('engine bug: library ordering choice was invalid');
    const idx = remaining.findIndex((c) => c.id === chosen.id);
    remaining.splice(idx, 1);
    ordered.push(chosen as EngineCardObject);
  }
  return ordered;
}

/** Scry N (CR 701.18): choose top/bottom, then optionally order both groups. */
function* scry(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  count: number,
): GameGen<void> {
  const looked = player.library.splice(0, count);
  const keep: EngineCardObject[] = [];
  const bottom: EngineCardObject[] = [];
  for (const card of looked) {
    const outcome = yield {
      decisionType: 'general',
      player: player.id,
      prompt: `${source.name}: scry — keep ${card.name} on top, or put it on the bottom?`,
      presentationSource: presentedSource(ctx, source),
      options: [
        cardOption(ctx, card, {
          viewerId: player.id,
          type: 'scryKeep',
          description: `Keep ${card.name} on top`,
          verb: 'Keep on top',
          role: 'affirm',
        }),
        cardOption(ctx, card, {
          viewerId: player.id,
          type: 'scryBottom',
          description: `Put ${card.name} on the bottom`,
          verb: 'Put on the bottom',
          role: 'decline',
        }),
      ],
    };
    (outcome.index === 0 ? keep : bottom).push(card);
  }
  player.library.unshift(...(yield* orderForLibrary(ctx, source, player, keep, 'top')));
  player.library.push(...(yield* orderForLibrary(ctx, source, player, bottom, 'bottom')));
  emit(
    ctx,
    'scry',
    { player: player.id, looked: looked.length, bottomed: bottom.length },
    player.id,
  );
}

/** Surveil N (CR 701.47): keep cards on top or put them into the graveyard. */
function* surveil(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  count: number,
): GameGen<void> {
  const looked = player.library.splice(0, count);
  const keep: EngineCardObject[] = [];
  for (const card of looked) {
    const outcome = yield {
      decisionType: 'general',
      player: player.id,
      prompt: `${source.name}: surveil — keep ${card.name} on top, or put it into your graveyard?`,
      presentationSource: presentedSource(ctx, source),
      options: [
        cardOption(ctx, card, {
          viewerId: player.id,
          type: 'surveilKeep',
          description: `Keep ${card.name} on top`,
          verb: 'Keep on top',
          role: 'affirm',
        }),
        cardOption(ctx, card, {
          viewerId: player.id,
          type: 'surveilGraveyard',
          description: `Put ${card.name} into your graveyard`,
          verb: 'Put into graveyard',
          role: 'decline',
        }),
      ],
    };
    if (outcome.index === 0) {
      keep.push(card);
    } else {
      // `moveObject` owns zone identity, commander replacement, and movement triggers. Put the
      // card back briefly so it can perform the normal library-to-graveyard transition.
      player.library.unshift(card);
      yield* moveObject(ctx, card, { zone: 'graveyard' });
      emit(ctx, 'mill', { player: player.id, cardId: card.cardId, name: card.name }, player.id);
    }
  }
  player.library.unshift(...(yield* orderForLibrary(ctx, source, player, keep, 'top')));
  emit(ctx, 'surveil', { player: player.id, looked: looked.length }, player.id);
}

/** Proliferate (CR 701.27): each eligible permanent/player is independently optional. */
function* proliferate(
  ctx: GameContext,
  source: EffectSource,
  controller: EnginePlayerState,
): GameGen<void> {
  for (const perm of ctx.state.battlefield) {
    const counters = Object.entries(perm.counters).filter(([, count]) => count > 0);
    if (counters.length === 0) continue;
    const outcome = yield {
      decisionType: 'general',
      player: controller.id,
      prompt: `${source.name}: proliferate ${perm.name}?`,
      presentationSource: presentedSource(ctx, source),
      options: [
        cardOption(ctx, perm, {
          viewerId: controller.id,
          type: 'proliferate',
          description: `Proliferate ${perm.name}`,
          payload: perm.id,
          verb: 'Proliferate',
          role: 'affirm',
          controller: perm.controllerId,
        }),
        cardOption(ctx, perm, {
          viewerId: controller.id,
          type: 'skipProliferate',
          description: `Do not proliferate ${perm.name}`,
          payload: perm.id,
          verb: 'Skip',
          role: 'decline',
          controller: perm.controllerId,
        }),
      ],
    };
    if (outcome.index === 0) {
      for (const [counter] of counters) addCounters(ctx, source, perm, counter, 1);
    }
  }
  for (const player of ctx.state.players) {
    if (player.energy <= 0 && player.poisonCounters <= 0) continue;
    const outcome = yield {
      decisionType: 'general',
      player: controller.id,
      prompt: `${source.name}: proliferate counters on ${player.id}?`,
      presentationSource: presentedSource(ctx, source),
      options: [
        // No `payload` (resolved by `outcome.index` below): a player isn't an on-screen
        // "source" the way a permanent is — the web UI never lets a human focus an opponent (or
        // themselves) as a click target the way it does a battlefield permanent, so a
        // payload-derived `subjectId` here would strand the option unreachable.
        playerOption(player.id, player.id, {
          type: 'proliferate',
          description: `Proliferate ${player.id}`,
          verb: 'Proliferate',
          role: 'affirm',
        }),
        playerOption(player.id, player.id, {
          type: 'skipProliferate',
          description: `Do not proliferate ${player.id}`,
          verb: 'Skip',
          role: 'decline',
        }),
      ],
    };
    if (outcome.index !== 0) continue;
    if (player.energy > 0) {
      player.energy += 1;
      emit(ctx, 'energy', { player: player.id, amount: 1, total: player.energy }, controller.id);
    }
    if (player.poisonCounters > 0) {
      player.poisonCounters += 1;
      emit(
        ctx,
        'counters',
        {
          source: source.name,
          target: player.id,
          counter: 'poison',
          added: 1,
          total: player.poisonCounters,
        },
        controller.id,
      );
    }
  }
}
/** End all until-end-of-turn effects (cleanup, CR 514.2). */
export function endUntilEotEffects(ctx: GameContext): void {
  delete ctx.state.playerHexproofTurn;
  delete ctx.state.spellsProhibitedTurn;
  const expiring = ctx.state.effects.filter((effect) => effect.duration !== 'permanent');
  if (expiring.length > 0) {
    debug(ctx, 'effect', `ending ${expiring.length} until-end-of-turn effect(s)`);
    ctx.state.effects = ctx.state.effects.filter((effect) => effect.duration === 'permanent');
  }
  // Until-end-of-turn control changes end here too — for every permanent, phased-out ones
  // included: they still expire on schedule (CR 514.2).
  for (const perm of [
    ...ctx.state.battlefield,
    ...(ctx.state.phasedOut ?? []).map((record) => record.permanent),
  ]) {
    refreshControlEffects(ctx, perm, { expireEndOfTurn: true });
  }
  for (const perm of [
    ...ctx.state.battlefield,
    ...(ctx.state.phasedOut ?? []).map((record) => record.permanent),
  ]) {
    if (perm.copyUntilEot !== true || perm.copyOriginal === undefined) continue;
    const original = perm.copyOriginal;
    perm.oracleId = original.oracleId;
    perm.name = original.name;
    perm.typeLine = original.typeLine;
    perm.oracleText = original.oracleText;
    perm.manaCost = original.manaCost;
    perm.power = original.power;
    perm.toughness = original.toughness;
    const def = ctx.defs.get(original.oracleId);
    const face = perm.transformed ? def?.backFace : def;
    if (face !== undefined) {
      perm.name = face.name;
      perm.typeLine = face.typeLine;
      perm.power = face.power;
      perm.toughness = face.toughness;
      if (def?.backFace !== undefined) {
        perm.oracleText = perm.transformed ? def.backFace.oracleText : def.backFace.frontOracleText;
        perm.manaCost = (
          perm.transformed ? def.backFace.manaCostText : def.backFace.frontManaCostText
        ) as EnginePermanent['manaCost'];
      }
      if (face.cantBlock) perm.cantBlock = true;
      else delete perm.cantBlock;
      if (face.cantBeBlocked) perm.cantBeBlocked = true;
      else delete perm.cantBeBlocked;
    }
    perm.timestamp = ctx.state.nextTimestamp++;
    delete perm.copyOriginal;
    delete perm.copyUntilEot;
    delete perm.copyImageFace;
    delete perm.copyAddTypes;
    delete perm.copyAddKeywords;
    delete perm.copyAddTriggers;
    delete perm.copyRemoveSupertypes;
    delete perm.copyAddSupertypes;
    delete perm.copyNameOverride;
  }
  for (const card of ctx.state.exile) {
    if (card.playableUntilEotBy !== undefined) delete card.playableUntilEotBy;
    delete card.castOnlyUntilEot;
    delete card.spendAsAnyColorUntilEot;
  }
  // "Gains unearth {3} until end of turn" (Ghost Ark) ends with the other until-end-of-turn
  // effects (CR 514.2).
  ctx.state.temporaryGraveyardAbilities = {};
}

/**
 * Activate sources per plan, add their production to the pool, then spend `cost` from it.
 *
 * `purpose` says what is being paid for, which is what decides whether restricted mana may be
 * spent (CR 106.6) and which spend triggers fire. It defaults to `{kind:'other'}` — the closed
 * answer: an unstated purpose can never unlock "spend only on X" mana.
 *
 * A generator because not every mana ability costs {T}: "Sacrifice this creature: Add {R}{R}"
 * moves a permanent to the graveyard, and `moveObject` can ask the CR 903.9b commander question.
 */
export function* payManaCost(
  ctx: GameContext,
  player: EnginePlayerState,
  cost: ParsedManaCost,
  purpose: PaymentPurpose = { kind: 'other' },
  excludedSourceCardIds: readonly string[] = [],
  /** Permanents another part of the same cost will sacrifice; no mana ability may use them. */
  reservedObjectIds: ReadonlySet<string> = new Set(),
  /** Locked by a joint cost planner against this unchanged context. */
  preparedPlan?: PaymentPlan,
  /** Isolated planner probe; called after costs and before production, never in a live cast. */
  inspectProduction?: (
    production: Pick<import('../cards/ability').ManaAbilitySpec, 'units' | 'linked'>,
  ) => void,
): GameGen<{ spellCantBeCountered: boolean; treasureManaSpent: number; manaSpent: number }> {
  const excluded = new Set(excludedSourceCardIds);
  const allows = allowanceFor(ctx, player.id, purpose);
  // Convoke (CR 702.51): the spell's controller may tap creatures to help pay for it.
  const convoke =
    purpose.kind === 'castSpell' &&
    spellHasConvoke(
      purpose.spellDefinition ?? getDefByOracleId(ctx, purpose.oracleId, purpose.oracleId),
    )
      ? convokeSourcesFor(ctx, player.id)
      : [];
  const sources = withoutReserved(
    ctx,
    [...manaSourcesFor(ctx, player.id), ...convoke].filter(
      (source) => !excluded.has(source.cardId),
    ),
    reservedObjectIds,
  );
  const plan =
    preparedPlan ??
    planPayment(
      cost,
      player.manaEntries,
      sources,
      allows,
      playerLifeLocked(ctx, player.id) ? 0 : player.life,
    );
  if (plan === null) {
    throw new Error(`engine bug: cost for ${player.id} became unpayable at application time`);
  }
  // Prepared plans cannot bypass the supported immediate-rider scope either.
  for (const source of plan.tapSources) assertManaRiders(source.cardId, source.onActivate);
  // Convoke assignments are local cost payments, never spendable mana in the player's pool.
  const convokedEntries: ManaEntry[] = [];
  // Activate the sources in the order the plan gives them and add each one's production as it
  // goes, rather than tapping everything and then adding it all. The distinction is invisible
  // for a board of ordinary lands — the pool ends up identical — and load-bearing for a source
  // whose own activation costs mana, which can only be paid out of what earlier sources made.
  for (const [sourceIndex, source] of plan.tapSources.entries()) {
    const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
    if (perm === undefined) throw new Error('engine bug: payment source vanished');
    // Read before the cost is paid: a Treasure's cost sacrifices it, so by the time its mana is
    // added the permanent is gone and its subtypes are unreadable.
    const fromTreasure = computeCharacteristics(ctx, perm).subtypes.includes('Treasure');
    const lastKnownTraits = combatDamageTraits(ctx, perm);
    // The mana half of the activation cost (CR 601.2h — costs are paid before the ability does
    // anything), spent only from unrestricted mana, which is the pool `planPayment` proved this
    // order against. See `solveWithCostly` for why restricted mana is held out of it.
    if (source.manaCost !== undefined) {
      const payable = player.manaEntries.filter((entry) => entry.restriction === undefined);
      const spentOnSource = selectEntriesToSpend(payable, source.manaCost);
      if (spentOnSource === null) {
        throw new Error(`engine bug: ${perm.name}'s own mana cost became unpayable`);
      }
      removeMana(player, spentOnSource);
    }
    const future = plan.tapSources.slice(sourceIndex + 1);
    // Life paid here is paid to activate the mana ability, not the ability or spell this mana
    // pays for (CR 605.3b), so it stays out of an enclosing activation's tally (Verrak).
    const enclosingLifeTally = ctx.costLifePaid;
    delete ctx.costLifePaid;
    try {
      yield* payAbilityCosts(
        ctx,
        player,
        perm,
        source.costs,
        // Tapping a creature for convoke is not activating a mana ability (CR 702.51b).
        source.convoke === true ? 'tap' : 'tapForMana',
        0,
        // A tap cost (Springleaf Drum) may not take a permanent a later source of this payment
        // taps (a convoking creature, a mana elf), and must leave the later tap costs payable —
        // the distinct assignment `planPayment` proved.
        (candidate, remainingCosts) => {
          const taken = new Set([candidate.cardId, ...future.map((s) => s.cardId)]);
          if (future.some((s) => s.cardId === candidate.cardId)) return false;
          const untapped = new Set(
            ctx.state.battlefield.filter((p) => !p.tapped).map((p) => p.cardId),
          );
          // This source's own tap costs still to pay are the last entries of its `taps`.
          const ownLeft = remainingCosts.reduce(
            (sum, remaining) =>
              sum +
              (remaining.kind === 'tapOther'
                ? 1
                : remaining.kind === 'tapOthers'
                  ? remaining.count
                  : 0),
            0,
          );
          const own = ownLeft === 0 ? [] : (source.taps ?? []).slice(-ownLeft);
          const groups = [...own, ...future.flatMap((s) => [...(s.taps ?? [])])].map((group) =>
            group.filter((id) => untapped.has(id)),
          );
          return sacrificesArePayable(groups, taken);
        },
        (candidate, remainingCosts) => {
          // A permanent reserved for another part of the same cost is never sacrifice fodder.
          if (reservedObjectIds.has(candidate.id)) return false;
          const available = new Set(
            ctx.state.battlefield.filter((p) => !reservedObjectIds.has(p.id)).map((p) => p.cardId),
          );
          const unavailable = new Set([
            candidate.cardId,
            ...future.map((s) => s.cardId),
            ...sources.map((s) => s.cardId).filter((id) => !available.has(id)),
          ]);
          const groups = future.flatMap((s) => [...(s.sacrifices ?? [])]);
          for (const remaining of remainingCosts) {
            if (remaining.kind !== 'sacrificeOther') continue;
            const candidates = ctx.state.battlefield
              .filter(
                (p) =>
                  p.controllerId === player.id &&
                  sacrificeCandidateAllowed(ctx, remaining, perm, p) &&
                  matchesSelector(ctx, p, remaining.selector, {
                    cardId: perm.cardId,
                    controllerId: player.id,
                  }),
              )
              .map((p) => p.cardId);
            for (let i = 0; i < (remaining.count ?? 1); i++) groups.push(candidates);
          }
          return (
            !future.some((s) => s.cardId === candidate.cardId) &&
            sacrificesArePayable(
              groups.map((g) => g.filter((id) => available.has(id))),
              unavailable,
            )
          );
        },
      );
    } finally {
      if (enclosingLifeTally !== undefined) ctx.costLifePaid = enclosingLifeTally;
    }

    const production =
      source.productionSpec === undefined
        ? source
        : resolveDynamicAmount(
            ctx,
            resolveDynamicUnits(
              ctx,
              resolveConditionalUnits(ctx, source.productionSpec, perm),
              perm,
            ),
            perm,
          );
    inspectProduction?.(production);
    const selectedProduction = plan.produced.filter(
      (p) => p.cardId === source.cardId && p.activation === source.activation,
    );
    if (
      source.productionSpec !== undefined &&
      (selectedProduction.length !== production.units.length ||
        selectedProduction.some(
          (chosen, index) => !production.units[index]!.includes(chosen.symbol),
        ) ||
        (production.linked === true &&
          selectedProduction.some((chosen) => chosen.symbol !== selectedProduction[0]?.symbol)))
    )
      throw new Error('mana production changed after activation costs');

    // Add exactly the mana the planner chose this source to produce — the SPECIFIC symbol per
    // unit (correct for multi-color sources, where the first symbol would mispay), carrying
    // whatever restriction, spend trigger and persistence the producing ability attaches.
    // Surplus floats.
    const entries = selectedProduction.map(({ symbol }) => ({
      symbol,
      ...(source.restriction !== undefined ? { restriction: source.restriction } : {}),
      ...(source.spendTrigger !== undefined ? { spendTrigger: source.spendTrigger } : {}),
      ...(source.uncounterableSpell === true ? { uncounterableSpell: true as const } : {}),
      ...(fromTreasure ? { fromTreasure: true as const } : {}),
      ...(source.persistent === true ? { persistent: true } : {}),
      ...(source.convoke === true ? { convoked: true as const } : {}),
    }));
    if (source.convoke === true) convokedEntries.push(...entries);
    else addMana(player, entries);
    // CR 602.2b / 605.3b: pay the activation costs before resolving the mana ability.
    // A sacrificed source can still deal damage using its last known characteristics;
    // it cannot receive counters once the battlefield object has ceased to exist.
    const traits = ctx.state.battlefield.includes(perm)
      ? combatDamageTraits(ctx, perm)
      : lastKnownTraits;
    for (const effect of source.onActivate ?? []) {
      yield* applyManaRider(ctx, perm, player, effect, traits);
    }
  }

  // Spend specific entries, so the right spend triggers fire. Only mana this payment may
  // legally use is eligible — the pool can hold restricted mana that is not spendable here.
  const eligible = [
    ...player.manaEntries.filter((e) => entryIsUsable(e, allows)),
    ...convokedEntries,
  ];
  const paidManaCost = plan.resolvedCost ?? cost;
  const spent = selectEntriesToSpend(eligible, paidManaCost);
  if (spent === null) {
    throw new Error(`engine bug: payment shortfall for ${player.id} after producing mana`);
  }
  if (convokedEntries.some((entry) => !spent.includes(entry)))
    throw new Error('engine bug: a convoke assignment did not pay a spell cost');
  removeMana(
    player,
    spent.filter((entry) => entry.convoked !== true),
  );
  if ((plan.lifePaid ?? 0) > 0) payLife(ctx, player, plan.lifePaid ?? 0);

  // "When you spend this mana to cast a Dragon creature spell, you gain 2 life" — a reflexive
  // trigger, fired once per consumed mana that carries one and whose own condition is met
  // (Scaled Nurturer's is the same clause as a restriction; Path of Ancestry's is narrower than
  // the unrestricted mana it rides on).
  for (const entry of spent) {
    const trigger = entry.spendTrigger;
    if (trigger === undefined) continue;
    if (!manaRestrictionAllows(ctx, trigger.when, purpose, player.id)) continue;
    ctx.state.pendingTriggers.push({
      controllerId: player.id,
      sourceCardId: `mana:${entry.symbol}`,
      sourceOracleId: '' as never,
      sourceName: trigger.when.description,
      ability: trigger.ability,
    });
    debug(ctx, 'stack', `mana spend trigger queued: ${trigger.when.description}`);
  }
  return {
    spellCantBeCountered:
      purpose.kind === 'castSpell' && spent.some((entry) => entry.uncounterableSpell === true),
    treasureManaSpent:
      purpose.kind === 'castSpell'
        ? spent.filter((entry) => entry.fromTreasure === true).length
        : 0,
    // Creatures tapped for convoke paid part of the cost without spending mana (CR 702.51b).
    manaSpent: totalPips(paidManaCost) - spent.filter((entry) => entry.convoked === true).length,
  };
}

/**
 * Pay the NON-mana components of an activation cost (CR 601.2h): tap, remove counters,
 * sacrifice. A generator because sacrificing is a zone change, and `moveObject` can ask the
 * CR 903.9b commander question.
 *
 * Sacrifice is applied last so a tap/counter cost on the same permanent is recorded on a
 * permanent that still exists.
 */
export function* payAbilityCosts(
  ctx: GameContext,
  player: EnginePlayerState,
  perm: EnginePermanent,
  costs: readonly AbilityCost[],
  tapEvent: 'tap' | 'tapForMana',
  announcedX = 0,
  canTap?: (candidate: EnginePermanent, remaining: readonly AbilityCost[]) => boolean,
  canSacrifice?: (candidate: EnginePermanent, remaining: readonly AbilityCost[]) => boolean,
): GameGen<{ stationPower?: number }> {
  let stationPower: number | undefined;
  for (const [costIndex, cost] of costs.entries()) {
    switch (cost.kind) {
      case 'tap':
        perm.tapped = true;
        queueTriggersForObject(
          ctx,
          'becomesTapped',
          perm,
          tapEvent === 'tapForMana' ? player.id : undefined,
        );
        emit(ctx, tapEvent, { name: perm.name, cardId: perm.cardId }, player.id);
        break;
      case 'tapOther': {
        const options = ctx.state.battlefield.filter(
          (candidate) =>
            (selfMayTap(cost, costs) || candidate.id !== perm.id) &&
            candidate.controllerId === player.id &&
            !candidate.tapped &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: perm.cardId,
              controllerId: player.id,
            }) &&
            (canTap?.(candidate, costs.slice(costIndex + 1)) ?? true),
        );
        if (options.length === 0)
          throw new Error('engine bug: additional tap cost became unpayable');
        const outcome = yield {
          decisionType: 'general',
          player: player.id,
          prompt: `${perm.name}: choose a permanent to tap as an activation cost.`,
          options: options.map((candidate) => ({
            type: 'tapCost',
            description: `Tap ${candidate.name}`,
            payload: candidate.id,
          })),
        };
        const chosen = options[outcome.index];
        if (chosen === undefined) throw new Error('engine bug: additional tap choice was invalid');
        if (cost.capturePowerForStation === true) stationPower = effectivePT(ctx, chosen).power;
        chosen.tapped = true;
        queueTriggersForObject(ctx, 'becomesTapped', chosen);
        emit(ctx, tapEvent, { name: chosen.name, cardId: chosen.cardId }, player.id);
        break;
      }
      case 'tapOthers': {
        for (let i = 0; i < cost.count; i++) {
          const options = ctx.state.battlefield.filter(
            (candidate) =>
              (selfMayTap(cost, costs) || candidate.id !== perm.id) &&
              candidate.controllerId === player.id &&
              !candidate.tapped &&
              matchesSelector(ctx, candidate, cost.selector, {
                cardId: perm.cardId,
                controllerId: player.id,
              }) &&
              (canTap?.(candidate, [
                {
                  kind: 'tapOthers',
                  selector: cost.selector,
                  count: cost.count - i - 1,
                  ...(cost.allowSelf === true ? { allowSelf: true } : {}),
                },
                ...costs.slice(costIndex + 1),
              ]) ??
                true),
          );
          if (options.length === 0)
            throw new Error('engine bug: additional tap costs became unpayable');
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: `${perm.name}: choose permanent ${i + 1} of ${cost.count} to tap as an activation cost.`,
            options: options.map((candidate) => ({
              type: 'tapCost',
              description: `Tap ${candidate.name}`,
              payload: candidate.id,
            })),
          };
          const chosen = options[outcome.index];
          if (chosen === undefined)
            throw new Error('engine bug: additional tap choice was invalid');
          chosen.tapped = true;
          queueTriggersForObject(ctx, 'becomesTapped', chosen);
          emit(ctx, tapEvent, { name: chosen.name, cardId: chosen.cardId }, player.id);
        }
        break;
      }
      case 'tapXOthers': {
        for (let i = 0; i < announcedX; i++) {
          const options = ctx.state.battlefield.filter(
            (candidate) =>
              candidate.id !== perm.id &&
              candidate.controllerId === player.id &&
              !candidate.tapped &&
              matchesSelector(ctx, candidate, cost.selector, {
                cardId: perm.cardId,
                controllerId: player.id,
              }) &&
              (canTap?.(candidate, [
                { kind: 'tapOthers', selector: cost.selector, count: announcedX - i - 1 },
                ...costs.slice(costIndex + 1),
              ]) ??
                true),
          );
          if (options.length === 0) throw new Error('engine bug: X tap cost became unpayable');
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: `${perm.name}: choose artifact ${i + 1} of ${announcedX} to tap as an activation cost.`,
            options: options.map((candidate) => ({
              type: 'tapCost',
              description: `Tap ${candidate.name}`,
              payload: candidate.id,
            })),
          };
          const chosen = options[outcome.index];
          if (chosen === undefined) throw new Error('engine bug: X tap choice was invalid');
          chosen.tapped = true;
          queueTriggersForObject(ctx, 'becomesTapped', chosen);
          emit(ctx, tapEvent, { name: chosen.name, cardId: chosen.cardId }, player.id);
        }
        break;
      }
      case 'sacrificeOther': {
        const count = cost.count ?? 1;
        for (let i = 0; i < count; i++) {
          const options = ctx.state.battlefield.filter(
            (candidate) =>
              sacrificeCandidateAllowed(ctx, cost, perm, candidate) &&
              candidate.controllerId === player.id &&
              matchesSelector(ctx, candidate, cost.selector, {
                cardId: perm.cardId,
                controllerId: player.id,
              }) &&
              (canSacrifice?.(candidate, [
                { ...cost, count: count - i - 1 },
                ...costs.slice(costIndex + 1),
              ]) ??
                true),
          );
          if (options.length === 0) throw new Error('engine bug: sacrifice cost became unpayable');
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: `${perm.name}: choose permanent ${i + 1} of ${count} to sacrifice as an activation cost.`,
            options: options.map((candidate) => ({
              type: 'sacrificeCost',
              description: `Sacrifice ${candidate.name}`,
              payload: candidate.id,
            })),
          };
          const chosen = options[outcome.index];
          if (chosen === undefined)
            throw new Error('engine bug: sacrifice-cost choice was invalid');
          emit(ctx, 'sacrifice', { name: chosen.name, cardId: chosen.cardId }, player.id);
          yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
        }
        break;
      }
      case 'removeCounters': {
        const count =
          typeof cost.count === 'number'
            ? cost.count
            : evaluateValueIn(ctx, cost.count, {
                controllerId: player.id,
                sourceCardId: perm.cardId,
              });
        const have = counterCount(perm.counters, cost.counter);
        if (have < count) throw new Error('engine bug: counter cost became unpayable');
        setCounterCount(perm.counters, cost.counter, have - count);
        expireCounterBoundAttackRestrictions(perm);
        emit(
          ctx,
          'counters',
          {
            target: perm.name,
            targetCardId: perm.cardId,
            counter: cost.counter,
            added: -count,
            total: counterCount(perm.counters, cost.counter),
          },
          player.id,
        );
        break;
      }
      case 'removeCountersFromAmong': {
        const options = ctx.state.battlefield.filter(
          (candidate) =>
            candidate.controllerId === player.id &&
            (candidate.counters[cost.counter] ?? 0) >= cost.count &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: perm.cardId,
              controllerId: player.id,
            }),
        );
        if (options.length === 0) throw new Error('engine bug: counter cost became unpayable');
        let chosen = options[0] as EnginePermanent;
        if (options.length > 1) {
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: `${perm.name}: choose a permanent to remove ${cost.count === 1 ? 'a' : cost.count} ${cost.counter} counter${cost.count === 1 ? '' : 's'} from as an activation cost.`,
            options: options.map((candidate) => ({
              type: 'removeCounterCost',
              description: `Remove from ${candidate.name}`,
              payload: candidate.id,
            })),
          };
          const picked = options[outcome.index];
          if (picked === undefined) throw new Error('engine bug: counter cost choice was invalid');
          chosen = picked;
        }
        chosen.counters[cost.counter] = (chosen.counters[cost.counter] ?? 0) - cost.count;
        expireCounterBoundAttackRestrictions(chosen);
        emit(
          ctx,
          'counters',
          {
            target: chosen.name,
            targetCardId: chosen.cardId,
            counter: cost.counter,
            added: -cost.count,
            total: chosen.counters[cost.counter],
          },
          player.id,
        );
        break;
      }
      case 'payLife':
        // CR 119.4: positive life payments need a life total ≥ the amount, and payment is not
        // damage — nothing replaces or prevents it.
        payLife(ctx, player, cost.amount);
        break;
      case 'payLifeValue':
        payLife(
          ctx,
          player,
          evaluateValueIn(ctx, cost.amount, {
            controllerId: player.id,
            sourceCardId: perm.cardId,
          }),
        );
        break;
      case 'payEnergy':
        if (player.energy < cost.amount)
          throw new Error('engine bug: energy cost became unpayable');
        player.energy -= cost.amount;
        emit(ctx, 'energy', { amount: -cost.amount, total: player.energy }, player.id);
        break;
      case 'loyalty': {
        const have = perm.counters['loyalty'] ?? 0;
        const adjustedDelta =
          cost.delta > 0
            ? counterAmountAfterReplacements(ctx, perm, 'loyalty', cost.delta)
            : cost.delta;
        perm.counters['loyalty'] = Math.max(0, have + adjustedDelta);
        emit(
          ctx,
          'counters',
          {
            target: perm.name,
            targetCardId: perm.cardId,
            counter: 'loyalty',
            added: adjustedDelta,
            total: perm.counters['loyalty'],
          },
          player.id,
        );
        // A +N loyalty cost puts counters on the permanent (CR 606.4), so "whenever you put
        // counters" triggers see it like any other placement.
        if (adjustedDelta > 0)
          queueTriggersForEvent(ctx, 'countersPut', [
            { permanent: perm, playerId: player.id, counterKinds: ['loyalty'] },
          ]);
        break;
      }
      case 'mana':
        break; // paid separately — see `payActivationCosts`
      case 'sacrificeSelf':
        break; // applied below
      case 'exileSelf':
        break; // applied below
      case 'unattachSelf': {
        const hostName =
          perm.attachedTo === null ? undefined : findPermanent(ctx, perm.attachedTo)?.name;
        perm.attachedTo = null;
        emit(ctx, 'unattach', { equipment: perm.name, from: hostName }, player.id);
        break;
      }
      case 'discardCard':
        yield* discardCards(ctx, player, cost.count ?? 1, undefined, undefined, 'cost');
        break;
      case 'exileCardFromHand':
        throw new Error('engine bug: exileCardFromHand is only supported for spell costs');
      case 'discardSelf':
      case 'exileSelfFromGraveyard':
      case 'exileOtherCardsFromGraveyard':
        throw new Error(`engine bug: ${cost.kind} is not a battlefield activation cost`);
      case 'discardHand':
        yield* discardCards(ctx, player, player.hand.length, undefined, undefined, 'cost');
        break;
      case 'tapCreaturesTotalPower': {
        let tappedPower = 0;
        for (;;) {
          const options = ctx.state.battlefield.filter(
            (candidate) =>
              candidate.id !== perm.id &&
              candidate.controllerId === player.id &&
              !candidate.tapped &&
              computeCharacteristics(ctx, candidate).types.includes('Creature') &&
              (canTap?.(candidate, [
                {
                  kind: 'tapCreaturesTotalPower',
                  minPower: Math.max(
                    0,
                    cost.minPower - tappedPower - effectivePT(ctx, candidate).power,
                  ),
                },
                ...costs.slice(costIndex + 1),
              ]) ??
                true),
          );
          const canStop = tappedPower >= cost.minPower;
          if (!canStop && options.length === 0) {
            throw new Error('engine bug: crew cost became unpayable');
          }
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: canStop
              ? `${perm.name}: tap another creature to crew (${tappedPower}/${cost.minPower} power), or stop.`
              : `${perm.name}: choose a creature to tap to crew (need ${cost.minPower - tappedPower} more power).`,
            options: [
              ...options.map((candidate) => ({
                type: 'tapCost',
                description: `Tap ${candidate.name} (${effectivePT(ctx, candidate).power} power)`,
                payload: candidate.id,
              })),
              ...(canStop ? [{ type: 'decline', description: 'Stop tapping creatures' }] : []),
            ],
          };
          if (outcome.index >= options.length) break;
          const chosen = options[outcome.index];
          if (chosen === undefined) throw new Error('engine bug: crew tap choice was invalid');
          tappedPower += effectivePT(ctx, chosen).power;
          chosen.tapped = true;
          queueTriggersForObject(ctx, 'becomesTapped', chosen);
          emit(ctx, tapEvent, { name: chosen.name, cardId: chosen.cardId }, player.id);
        }
        break;
      }

      case 'returnUnblockedAttacker':
        throw new Error('Sneak return is supported only as a spell cost');
      default:
        assertNever(cost, 'activation cost');
    }
  }
  if (costs.some((c) => c.kind === 'sacrificeSelf')) {
    emit(ctx, 'sacrifice', { name: perm.name, cardId: perm.cardId }, player.id);
    yield* moveObject(ctx, perm, { zone: 'graveyard', reason: 'sacrifice' });
  } else if (costs.some((c) => c.kind === 'exileSelf')) {
    emit(ctx, 'exile', { target: perm.name, cardId: perm.cardId }, player.id);
    yield* moveObject(ctx, perm, { zone: 'exile' });
  }
  return stationPower === undefined ? {} : { stationPower };
}

/**
 * Apply a mana ability's `onActivate` rider — a painland's "This land deals 1 damage to you".
 *
 * Deliberately NOT `executeAbility`: a mana ability never uses the stack (CR 605.3a), so its
 * rider cannot target and cannot be responded to. Only the non-targeted ops are accepted;
 * anything else throws rather than being silently skipped, which would hand the player free
 * mana (brief §6.3). It is a generator only because its damage runs through the replacement
 * pipeline, where a CR 616.1 replacement-order choice can interrupt it; the rider itself never
 * uses the stack.
 */
export function* applyManaRider(
  ctx: GameContext,
  perm: EnginePermanent,
  controller: EnginePlayerState,
  effect: ManaRider,
  traits = combatDamageTraits(ctx, perm),
): GameGen<void> {
  assertManaRiders(perm.name, [effect]);
  const source = permanentSource(perm);
  switch (effect.op) {
    case 'damageController':
      yield* dealDamageToPlayer(ctx, source, controller, effect.amount, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: traits.lifelink,
        sourceHasInfect: traits.infect,
      });
      yield* flushDamageReflections(ctx);
      return;
    case 'gainLife':
      // A mana rider has no ability scope, so its amount must be board-answerable.
      gainLife(ctx, controller, evaluateValue(ctx, effect.amount));
      return;
    case 'putCounters': {
      if (effect.target !== 'source') {
        throw new UnmodeledCardError(
          perm.name,
          ['mana ability putCounters rider must target its source'],
          'activating a mana ability',
        );
      }
      if (!ctx.state.battlefield.includes(perm)) return;
      const count =
        typeof effect.count === 'number' ? effect.count : evaluateValue(ctx, effect.count);
      addCounters(ctx, source, perm, effect.counter, count);
      return;
    }
    default:
      assertNever(effect, 'immediate mana rider');
  }
}

/** Source descriptor for a permanent (combat damage, triggers). */
export function permanentSource(perm: EnginePermanent): EffectSource {
  return {
    id: perm.id,
    cardId: perm.cardId,
    name: perm.name,
    oracleId: perm.oracleId,
    controllerId: perm.controllerId,
  };
}

/** Does this permanent's damage carry deathtouch/lifelink, and in what colors (for combat)? */
export function combatDamageTraits(
  ctx: GameContext,
  perm: EnginePermanent,
): { deathtouch: boolean; lifelink: boolean; infect: boolean; colors: Color[]; types: string[] } {
  const chars = computeCharacteristics(ctx, perm);
  return {
    deathtouch: chars.keywords.includes('deathtouch'),
    lifelink: chars.keywords.includes('lifelink'),
    infect: chars.keywords.includes('infect'),
    // Protection reads the source's colors and card types (CR 702.16a).
    colors: [...chars.colors],
    types: [...chars.types],
  };
}

/** Convenience: definition lookup for a permanent. */
export function defOf(
  ctx: GameContext,
  perm: EnginePermanent,
): ReturnType<typeof getDefByOracleId> {
  return getDefByOracleId(ctx, perm.oracleId, perm.name);
}
