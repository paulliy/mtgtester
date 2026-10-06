/**
 * Effect resolution (brief §6.2): applying the mechanical outcome of `EffectSpec`s, plus
 * the shared damage/draw/life primitives used by combat and turn-based actions.
 */

import type { Color, ObjectId, PlayerId } from '@mtg/shared';
import { ALL_COLORS } from '@mtg/shared';
import {
  canPaySpellAdditionalCosts,
  computeTargetOptions,
  isCreatureSpell,
  manaPortionOf,
  maxChoicesFor,
  modalSelections,
  permanentMatchesKind,
  selectedModeTargetSlots,
  spellMatchesSelector,
} from '../actions/legal';
import { abilityModeSelections } from '../actions/ability-modes';
import type { WardCost } from '../cards/ability';
import type {
  Ability,
  AbilityCost,
  CardDefinition,
  Effect,
  EffectRef,
  SearchDestination,
  Selector,
  TargetKind,
  TargetSpec,
} from '../cards/definition';
import { evaluateCondition, isChoiceCondition, resolveCondition } from '../cards/condition';
import { allOf, ofSupertype, ofType, selectMatches } from '../cards/selector';
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
  totalPips,
  withX,
} from '../mana/cost';
import type { ManaSource, ParsedManaCost } from '../mana/cost';
import { addMana, removeMana, selectEntriesToSpend } from '../mana/pool';
import type { ManaEntry, PaymentPurpose } from '../cards/ability';
import { debug, emit } from '../log/log';
import { cardOption, plainOption, playerOption, presentedSource, valueOption } from '../present';
import { chooseCard } from './choose';
import {
  additionalTypedTriggerCopies,
  applyCopy,
  applyTokenCreationReplacements,
  consumeRegenerationShield,
  createToken,
  createTokens,
  makePermanent,
  moveObject,
  moveObjects,
  movePermanentsToGraveyard,
  playerById,
  queueCastTriggers,
  queueKeywordCastTriggers,
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
  colorsOf,
  tokenCreationMultiplierFor,
  damageAmountAfterReplacements,
  effectivePT,
  findPermanent,
  getDefByOracleId,
  graveyardTargets,
  hasKeyword,
  hasProtectionFrom,
  manaRestrictionAllows,
  manaSourcesFor,
  opponentsOf,
  playersInApnapOrder,
  sourceColorsOf,
  spellProtectedFromCounter,
  requireModeled,
} from '../state/queries';
import type {
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
  GameContext,
} from '../state/types';
import { breakYieldsForStop } from '../turn/stops';

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
function addGoadRequirement(ctx: GameContext, perm: EnginePermanent, goaderId: PlayerId): void {
  const existing = perm.goadedBy ?? [];
  if (existing.some((requirement) => requirement.goaderId === goaderId)) return;
  perm.goadedBy = [...existing, { goaderId, appliedTurn: ctx.state.turnNumber }];
}

/** Locate a physical card after a zone change, whose object id is deliberately no longer stable. */
function findObjectByCardId(ctx: GameContext, cardId: string): EngineObject | undefined {
  const foundStack = ctx.state.stack.find(
    (object) => object.sourceCardId === cardId || object.card?.cardId === cardId,
  );
  if (foundStack !== undefined) return foundStack as unknown as EngineObject;
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

/**
 * Locate a physical card by `cardId`, in whatever non-stack zone it currently occupies.
 * Unlike `findObjectByCardId`, this never matches a stack entry — it exists for referents that
 * are themselves permanents/cards (a delayed trigger's remembered `'triggerObject'`), where a
 * same-source triggered ability that happens to *also* be sitting on the stack (sharing that
 * `sourceCardId`) would otherwise be mistaken for the object itself.
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
  cardId: string;
  name: string;
  oracleId: string;
  controllerId: PlayerId;
  /** Present only while a spell itself is resolving; permits self-replacement destinations. */
  resolvingStackObject?: EngineStackObject;
  /** The source's colors as its ability went on the stack — protection's last known information. */
  lastKnownColors?: readonly Color[];
  /**
   * The source permanent this ability came from, for an ability that acts on "it" (sacrifice it,
   * it fights): null when it was already off the battlefield. Absent when not tracked, and the
   * source is then found by card.
   */
  objectId?: ObjectId | null;
}

/** Deal non-combat or combat damage from `source` to a creature. */
export function dealDamageToCreature(
  ctx: GameContext,
  source: EffectSource,
  target: EnginePermanent,
  amount: number,
  opts: {
    combat: boolean;
    sourceHasDeathtouch: boolean;
    sourceHasLifelink: boolean;
    sourceHasInfect?: boolean;
    /** The source's colors, for protection (CR 702.16). Omitted ⇒ colorless. */
    sourceColors?: readonly Color[];
  },
): void {
  if (amount <= 0) return;
  if (opts.combat && ctx.state.combatDamagePrevention.all) {
    emit(ctx, 'damagePrevented', {
      source: source.name,
      target: target.name,
      amount,
      reason: 'combatShield',
    });
    return;
  }
  // Damage-doubling replacement (CR 616 — Neriv, Heart of the Storm), applied to the amount
  // BEFORE protection: the source deals more damage, independent of whether the target can
  // prevent it.
  amount = damageAmountAfterReplacements(ctx, source.cardId, target.controllerId, amount);
  // Protection (CR 702.16), the D in DEBT: damage from a source of a protected-from color is
  // prevented entirely, so no damage is marked and no lifelink is gained.
  if (opts.sourceColors !== undefined && hasProtectionFrom(ctx, target, opts.sourceColors)) {
    emit(ctx, 'damagePrevented', {
      source: source.name,
      target: target.name,
      targetCardId: target.cardId,
      amount,
      reason: 'protection',
    });
    return;
  }
  // Excess damage this turn (Rith, Liberated Primeval) — the amount by which this single hit
  // exceeded what was needed to reduce the target to 0 toughness, accounting for damage already
  // marked. Tracked by the DAMAGED permanent's controller, regardless of who dealt it.
  const neededToKill = Math.max(0, effectivePT(ctx, target).toughness - target.damageMarked);
  if (amount > neededToKill) {
    ctx.state.excessDamageControllerIds.push(target.controllerId);
  }
  if (opts.sourceHasInfect === true) addCounters(ctx, source, target, '-1/-1', amount);
  else target.damageMarked += amount;
  if (opts.sourceHasDeathtouch) target.damagedByDeathtouch = true;
  if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
  // CR 702.90e: infect still counts as "dealt damage" for triggers even though it marks
  // -1/-1 counters instead of damage.
  queueTriggersForEvent(ctx, 'dealtDamage', [{ permanent: target, amount }]);
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
export function dealDamageToPlayer(
  ctx: GameContext,
  source: EffectSource,
  target: EnginePlayerState,
  amount: number,
  opts: {
    combat: boolean;
    sourceIsCommander: boolean;
    sourceHasLifelink: boolean;
    sourceHasInfect?: boolean;
  },
): number {
  if (amount <= 0) return 0;
  if (
    opts.combat &&
    (ctx.state.combatDamagePrevention.all ||
      ctx.state.combatDamagePrevention.players[target.id] === true)
  ) {
    const tokenSpec = ctx.state.combatDamagePrevention.tokenSpecs?.[target.id];
    if (tokenSpec !== undefined) {
      for (let i = 0; i < amount; i++) createToken(ctx, tokenSpec, target.id);
    }
    emit(ctx, 'damagePrevented', {
      source: source.name,
      target: target.id,
      amount,
      reason: 'combatShield',
    });
    return 0;
  }
  // Damage-doubling replacement (CR 616 — Neriv, Heart of the Storm).
  amount = damageAmountAfterReplacements(ctx, source.cardId, target.id, amount);
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
  return amount;
}

/** Deal non-combat damage from `source` to whichever kind of object `id` names. */
function dealDamageToObject(
  ctx: GameContext,
  source: EffectSource,
  id: ObjectId,
  amount: number,
): void {
  const sourcePermanent = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
  const sourceHasInfect =
    sourcePermanent !== undefined && hasKeyword(ctx, sourcePermanent, 'infect');
  const sourceHasLifelink =
    sourcePermanent !== undefined && hasKeyword(ctx, sourcePermanent, 'lifelink');
  const sourceHasDeathtouch =
    sourcePermanent !== undefined && hasKeyword(ctx, sourcePermanent, 'deathtouch');
  // Protection (CR 702.16e) prevents damage from a protected-from source, noncombat included.
  const sourceColors = sourceColorsOf(ctx, source.cardId, source.oracleId, source.lastKnownColors);
  const targetPlayer = ctx.state.players.find((p) => p.id === id);
  if (targetPlayer !== undefined) {
    dealDamageToPlayer(ctx, source, targetPlayer, amount, {
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
    if (amount <= 0) return;
    amount = damageAmountAfterReplacements(ctx, source.cardId, perm.controllerId, amount);
    if (hasProtectionFrom(ctx, perm, sourceColors)) {
      emit(ctx, 'damagePrevented', {
        source: source.name,
        target: perm.name,
        targetCardId: perm.cardId,
        amount,
        reason: 'protection',
      });
      return;
    }
    const have = perm.counters[counterKind] ?? 0;
    perm.counters[counterKind] = Math.max(0, have - amount);
    // Lifelink applies to damage dealt to any object or player (CR 702.15b).
    if (sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
    emit(ctx, 'damage', {
      source: source.name,
      sourceCardId: source.cardId,
      target: perm.name,
      targetCardId: perm.cardId,
      amount,
      combat: false,
    });
    return;
  }
  dealDamageToCreature(ctx, source, perm, amount, {
    combat: false,
    sourceHasDeathtouch,
    sourceHasLifelink,
    sourceHasInfect,
    sourceColors,
  });
}

export function gainLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (amount <= 0) return;
  player.life += amount;
  emit(ctx, 'lifeGain', { player: player.id, amount, life: player.life });
  queuePlayerTriggersForEvent(ctx, 'gainsLife', player.id, amount);
}

export function loseLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (amount <= 0) return;
  player.life =
    ctx.state.lifeFloorPlayers[player.id] === true
      ? Math.max(1, player.life - amount)
      : player.life - amount;
  ctx.state.lifeLostThisTurn[player.id] = true;
  emit(ctx, 'lifeLoss', { player: player.id, amount, life: player.life });
}

/**
 * Draw cards. Drawing from an empty library sets the loss flag checked at the next SBA
 * check, not an immediate loss (brief §5.6). A generator: a drawn commander (one shuffled
 * into the library) triggers the CR 903.9b hand-replacement choice inside `moveObject`.
 */
export function* drawCards(
  ctx: GameContext,
  player: EnginePlayerState,
  count: number,
): GameGen<void> {
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
          decline: { type: 'loseGame', description: 'No creature — lose the game', verb: 'Lose' },
        });
        if (chosen === null) player.hasLost = true;
        else yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: player.id });
        continue;
      }
      player.attemptedDrawFromEmptyLibrary = true;
      emit(ctx, 'drawFromEmptyLibrary', { player: player.id });
      debug(ctx, 'engine', `${player.id} attempted to draw from an empty library`);
      continue;
    }
    const drawn = yield* moveObject(ctx, top, { zone: 'hand' });
    if (drawn?.zone !== 'hand') continue;
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
}

/** Discard N cards, one controller choice at a time (CR 701.8a). */
function* discardCards(
  ctx: GameContext,
  player: EnginePlayerState,
  count: number,
  excludeCardId?: string,
): GameGen<void> {
  for (let i = 0; i < count; i++) {
    const cards = player.hand.filter((card) => card.cardId !== excludeCardId);
    if (cards.length === 0) break;
    const chosen = yield* chooseCard(ctx, {
      player: player.id,
      prompt: `Discard a card (${i + 1} of ${count}).`,
      cards,
      type: 'discard',
      verb: 'Discard',
    });
    if (chosen === null) throw new Error('engine bug: discard choice was not in hand');
    const card = chosen as EngineCardObject;
    emit(ctx, 'discard', { player: player.id, name: card.name, cardId: card.cardId }, player.id);
    yield* moveObject(ctx, card, { zone: 'graveyard' });
  }
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
    emit(ctx, 'discard', { player: player.id, name: card.name, cardId: card.cardId }, player.id);
    yield* moveObject(ctx, card, { zone: 'graveyard' });
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
  sourceInHand: boolean,
  announcedX = 0,
): GameGen<void> {
  for (const cost of costs) {
    switch (cost.kind) {
      case 'discardCard':
        yield* discardCards(ctx, player, cost.count ?? 1, sourceInHand ? sourceCardId : undefined);
        break;
      case 'exileOtherCardsFromGraveyard': {
        for (let i = 0; i < cost.count; i++) {
          const options = player.graveyard.filter((card) => card.cardId !== sourceCardId);
          if (options.length === 0)
            throw new Error('engine bug: exile-from-graveyard cost became unpayable');
          const chosen = yield* chooseCard(ctx, {
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
              (!sourceInHand || card.cardId !== sourceCardId) &&
              selectMatches(cardZoneCandidate(ctx, card, player.id), cost.selector, {
                cardId: sourceCardId,
                controllerId: player.id,
              }),
          );
          if (options.length === 0)
            throw new Error('engine bug: exile-from-hand cost became unpayable');
          const chosen = yield* chooseCard(ctx, {
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
        loseLife(ctx, player, cost.amount);
        break;
      case 'payLifeValue':
        loseLife(
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
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: sourceCardId,
              controllerId: player.id,
            }),
        );
        if (options.length === 0)
          throw new Error('engine bug: spell additional tap cost became unpayable');
        const chosen = yield* chooseCard(ctx, {
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
              matchesSelector(ctx, candidate, cost.selector, {
                cardId: sourceCardId,
                controllerId: player.id,
              }),
          );
          if (options.length === 0)
            throw new Error('engine bug: spell additional sacrifice cost became unpayable');
          const chosen = yield* chooseCard(ctx, {
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
  /** The targeting source's colors, for protection (CR 702.16). Omitted ⇒ colorless. */
  sourceColors?: readonly Color[],
  /** The player associated with this trigger event, if target text refers to them. */
  eventPlayerId?: PlayerId,
  /** The source's card id, so `OTHER` in a filter excludes the source (see computeTargetOptions). */
  sourceCardId = '',
): boolean {
  const { kind, controller, filter } =
    typeof spec === 'string' ? { kind: spec, controller: undefined, filter: undefined } : spec;

  if (kind === 'spellOrNonlandPermanent') {
    const entry = ctx.state.stack.find((s) => s.id === targetId && s.kind === 'spell');
    if (entry !== undefined)
      return (
        controller === undefined ||
        (controller === 'you'
          ? entry.controllerId === spellControllerId
          : controller === 'opponent'
            ? entry.controllerId !== spellControllerId
            : entry.controllerId === eventPlayerId)
      );
  }
  if (kind === 'spell' || kind === 'noncreatureSpell') {
    const entry = ctx.state.stack.find((s) => s.id === targetId && s.kind === 'spell');
    if (entry === undefined) return false;
    if (kind === 'noncreatureSpell' && isCreatureSpell(ctx, entry)) return false;
    if (controller === 'you' && entry.controllerId !== spellControllerId) return false;
    if (controller === 'opponent' && entry.controllerId === spellControllerId) return false;
    if (controller === 'eventPlayer' && entry.controllerId !== eventPlayerId) return false;
    return filter === undefined || spellMatchesSelector(ctx, entry, filter, spellControllerId);
  }
  if (kind === 'stackObject') return ctx.state.stack.some((entry) => entry.id === targetId);
  if (kind === 'commanderInCommandZone') {
    const player = playerById(ctx, spellControllerId);
    return player.commandZone.some(
      (c) => (c.cardId === targetId || c.id === targetId) && c.isCommander,
    );
  }
  if (kind === 'cardInGraveyard') {
    if (typeof spec === 'object' && spec.graveyardOwnerScope === 'any') {
      return ctx.state.players.some((player) =>
        graveyardTargets(ctx, player.id, filter).some((c) => c.id === targetId),
      );
    }
    return graveyardTargets(ctx, spellControllerId, filter).some((c) => c.id === targetId);
  }
  const player = ctx.state.players.find((p) => p.id === targetId);
  if (player !== undefined) {
    if (
      !(kind === 'anyTarget' || kind === 'player' || kind === 'playerOrPlaneswalker') ||
      player.hasLost
    )
      return false;
    if (controller === 'you' && player.id !== spellControllerId) return false;
    if (controller === 'opponent' && player.id === spellControllerId) return false;
    if (controller === 'eventPlayer' && player.id !== eventPlayerId) return false;
    return true;
  }
  const perm = findPermanent(ctx, targetId);
  if (
    perm === undefined ||
    !permanentMatchesKind(ctx, perm, kind === 'spellOrNonlandPermanent' ? 'nonlandPermanent' : kind)
  )
    return false;
  if (
    filter !== undefined &&
    !matchesSelector(ctx, perm, filter, { cardId: sourceCardId, controllerId: spellControllerId })
  )
    return false;
  // Shroud (CR 702.18): untargetable by anything, including its own controller.
  if (hasKeyword(ctx, perm, 'shroud')) return false;
  if (perm.controllerId !== spellControllerId && hasKeyword(ctx, perm, 'hexproof')) return false;
  // Protection (CR 702.16), the T in DEBT: untargetable by sources of the named colors.
  if (sourceColors !== undefined && hasProtectionFrom(ctx, perm, sourceColors)) return false;
  if (controller === 'you' && perm.controllerId !== spellControllerId) return false;
  if (controller === 'opponent' && perm.controllerId === spellControllerId) return false;
  if (controller === 'eventPlayer' && perm.controllerId !== eventPlayerId) return false;
  return true;
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
  return spellProtectedFromCounter(ctx, entry.controllerId, entry.sourceOracleId);
}

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n}`;

/**
 * Put counters on a permanent. `+1/+1` and `-1/-1` feed layer 7c through `perm.counters`, so
 * effective P/T follows immediately; pairs of them annihilate at the next SBA check (CR 704.5r).
 */
function addCounters(
  ctx: GameContext,
  source: EffectSource,
  perm: EnginePermanent,
  counter: string,
  count: number,
): void {
  if (count <= 0) return;
  const adjustedCount = counterAmountAfterReplacements(ctx, perm, counter, count);
  const before = perm.counters[counter] ?? 0;
  perm.counters[counter] = (perm.counters[counter] ?? 0) + adjustedCount;
  emit(ctx, 'counters', {
    source: source.name,
    target: perm.name,
    targetCardId: perm.cardId,
    counter,
    added: adjustedCount,
    total: perm.counters[counter],
  });
  const def = ctx.defs.get(perm.oracleId);
  for (const threshold of def?.counterThresholdTriggers ?? []) {
    if (
      threshold.counter !== counter ||
      before >= threshold.threshold ||
      perm.counters[counter] < threshold.threshold
    )
      continue;
    const copies = 1 + additionalTypedTriggerCopies(ctx, perm);
    for (let copy = 0; copy < copies; copy++) {
      ctx.state.pendingTriggers.push({
        controllerId: perm.controllerId,
        sourceCardId: perm.cardId,
        sourceOracleId: perm.oracleId,
        sourceName: perm.name,
        ability: threshold.ability,
      });
    }
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
    cardId: source.cardId,
    controllerId: source.controllerId,
    ...(eventPlayerId !== undefined ? { eventPlayerId } : {}),
  });
}

/** "Grizzly Bears, Llanowar Elves get +3/+3 until end of turn" — the locked-in set, by name. */
function describeMassEffect(affected: EnginePermanent[], clause: string): string {
  return `${affected.map((p) => p.name).join(', ')} ${clause} until end of turn`;
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
    if (freeCardIsCastable(ctx, hit, controller.id)) {
      const outcome = yield {
        decisionType: 'general',
        player: controller.id,
        prompt: source.name + ': cast the Cascade hit without paying its mana cost?',
        options: [
          { type: 'castFree', description: 'Cast ' + hit.name + ' without paying its mana cost' },
          { type: 'decline', description: 'Leave ' + hit.name + ' in exile' },
        ],
      };
      if (outcome.index === 0) yield* resolveFreeCard(ctx, hit, controller.id);
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

function abilityForModes(def: CardDefinition, selectedModes: number[] | undefined): Ability | null {
  if (def.spellAbility === null) {
    return def.spellCantBeCountered === true
      ? { kind: 'spell', targets: [], effects: [], cantBeCountered: true }
      : null;
  }
  const modes = def.spellAbility.modes;
  if (modes === undefined) return def.spellAbility;
  const chosen = (selectedModes ?? [0]).map((index) => modes.options[index]);
  if (chosen.some((option) => option === undefined)) return null;
  return { ...def.spellAbility, effects: chosen.flatMap((option) => option?.effects ?? []) };
}

function legalFreeCastSelections(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
): (number[] | undefined)[] {
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  const controller = playerById(ctx, controllerId);
  const selections = modalSelections(
    def,
    maxChoicesFor(ctx, def, { cardId: card.cardId, controllerId }),
  );
  return selections.filter((selectedModes) => {
    const activeSlots = selectedModeTargetSlots(def, selectedModes);
    const targetSpecs = def.spellAbility?.targets ?? [];
    const hasTargets = targetSpecs.every((spec, index) =>
      activeSlots !== undefined && !activeSlots.includes(index)
        ? true
        : computeTargetOptions(ctx, spec, controllerId, def.colors).length > 0,
    );
    if (!hasTargets) return false;
    const modeCosts =
      selectedModes?.flatMap(
        (mode) => def.spellAbility?.modes?.options[mode]?.additionalCost ?? [],
      ) ?? [];
    const costs = [...(def.spellAdditionalCosts ?? []), ...modeCosts];
    const mana = manaPortionOf(costs);
    return (
      canPay(
        mana,
        controller.manaEntries,
        manaSourcesFor(ctx, controllerId),
        allowanceFor(ctx, controllerId, {
          kind: 'castSpell',
          oracleId: card.oracleId,
          isCommander: card.isCommander,
        }),
      ) && canPaySpellAdditionalCosts(ctx, controller, costs, card.cardId, false)
    );
  });
}

/** Cast a card without paying its mana cost, using the normal stack and announcement rules. */
function* resolveFreeCard(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
): GameGen<void> {
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  const controller = playerById(ctx, controllerId);
  const selections = legalFreeCastSelections(ctx, card, controllerId);
  if (selections.length === 0) return;
  let selectedModes = selections[0];
  if (selections.length > 1) {
    const outcome = yield {
      decisionType: 'general' as const,
      player: controllerId,
      prompt: `Choose modes for free-cast ${card.name}.`,
      options: selections.map((selection) => ({
        type: 'chooseModes',
        description:
          selection === undefined
            ? `Cast ${card.name}`
            : selection
                .map(
                  (mode) =>
                    def.spellAbility?.modes?.options[mode]?.description ?? `mode ${mode + 1}`,
                )
                .join('; '),
      })),
    };
    selectedModes = selections[outcome.index] ?? selections[0];
  }
  const ability = abilityForModes(def, selectedModes);
  const activeSlots = selectedModeTargetSlots(def, selectedModes);
  const targetSlots =
    ability?.targets.flatMap((spec, index) =>
      activeSlots !== undefined && !activeSlots.includes(index)
        ? []
        : [{ slot: index, options: computeTargetOptions(ctx, spec, controllerId, def.colors) }],
    ) ?? [];
  const targets: ObjectId[] = [];
  if (targetSlots.length > 0) {
    const outcome = yield {
      decisionType: 'chooseTargets',
      player: controllerId,
      prompt: `Choose targets for free-cast ${card.name}.`,
      options: [
        {
          type: 'chooseTargets',
          description: `Targets for ${card.name}`,
          targets: targetSlots.map((slot, index) => ({ slot: index, options: slot.options })),
          interaction: {
            kind: 'choice',
            targetSlots: targetSlots.map((slot) => ({ slot: slot.slot, options: slot.options })),
          },
        },
      ],
    };
    for (const slot of targetSlots)
      targets[slot.slot] = outcome.targets.get(slot.slot) ?? (slot.options[0] as ObjectId);
  }

  const modeCosts =
    selectedModes?.flatMap(
      (mode) => def.spellAbility?.modes?.options[mode]?.additionalCost ?? [],
    ) ?? [];
  const additionalCosts = [...(def.spellAdditionalCosts ?? []), ...modeCosts];
  const additionalMana = manaPortionOf(additionalCosts);
  if (totalPips(additionalMana) > 0) {
    yield* payManaCost(ctx, controller, additionalMana, {
      kind: 'castSpell',
      oracleId: card.oracleId,
      isCommander: card.isCommander,
    });
  }
  yield* paySpellAdditionalCosts(ctx, controller, additionalCosts, card.cardId, false);

  removeFromCurrentZone(ctx, card);
  const spellCard: EngineCardObject = {
    ...card,
    id: `o-${ctx.state.nextObjectNum++}` as ObjectId,
    zone: 'stack',
    ...(def.manaCost?.x !== undefined ? { announcedX: 0 } : {}),
  };

  const freeSpell: EngineStackObject = {
    id: spellCard.id,
    sourceId: spellCard.id,
    controllerId,
    kind: 'spell',
    description: card.name,
    targets,
    card: spellCard,
    ability,
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
    ...(def.manaCost?.x !== undefined ? { announcedX: 0 } : {}),
    triggerScope: { manaSpent: totalPips(additionalMana) },
  };
  ctx.state.stack.push(freeSpell);
  breakYieldsForStop(ctx, freeSpell);
  emit(
    ctx,
    'castSpell',
    {
      player: controllerId,
      name: card.name,
      cardId: card.cardId,
      targets,
      fromCommand: false,
      commanderTax: 0,
    },
    controllerId,
  );
  queueCastTriggers(ctx, freeSpell);
  queueKeywordCastTriggers(ctx, freeSpell);
}

function freeCardIsCastable(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
): boolean {
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  if (def.types.includes('Land') || def.manaCost === null) return false;
  if (
    def.spellAbility === null &&
    !def.types.some((type) =>
      ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Planeswalker'].includes(type),
    )
  )
    return false;
  return legalFreeCastSelections(ctx, card, controllerId).length > 0;
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
  const controller = playerById(ctx, source.controllerId);

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
    ...(targets !== undefined ? { targets } : {}),
    ...(triggerObjectCardId !== undefined ? { triggerObjectCardId } : {}),
    ...(source.resolvingStackObject?.optionalCostCounts !== undefined
      ? { resolvingOptionalCostCounts: source.resolvingStackObject.optionalCostCounts }
      : {}),
    ...(extraScope ?? {}),
  };
  /** Evaluate an effect's `Value` amount in this ability's scope. */
  const amountOf = (value: Value | number): number =>
    typeof value === 'number' ? value : evaluateValueIn(ctx, value, scope);
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

  // CR 608.2b: a target's legality is checked once per resolution, not re-derived from
  // `ability.targets[r]`'s original zone/kind on every later reference to the same slot. Doing
  // so would spuriously fail once an earlier effect of THIS SAME ability has itself moved the
  // object — e.g. Hellkite Courser: `commandZoneToBattlefield` puts the chosen commander onto
  // the battlefield, then `registerDelayedTrigger` refers to that same slot to remember which
  // permanent to return. By then it is no longer a legal `commanderInCommandZone` target (even
  // though nothing illegal happened), and the zone change minted it a new `ObjectId` — only
  // `cardId` stays stable across that. So the referent is captured by `cardId` the first time a
  // slot resolves, and re-located via `findObjectByCardId` on every later call, following it
  // through zone changes the same way `triggerObjectCardId` does.
  const refCardIdCache = new Map<number, string | null>();
  /** Controller captured when a target slot is first resolved, before an earlier effect moves it. */
  const refControllerCache = new Map<number, PlayerId | undefined>();

  /**
   * CR 608.2b recheck of one target, with the same protection (CR 702.16) and event-player
   * context the target was chosen under — otherwise a creature that gained protection from the
   * source's color in response would still be hit.
   */
  const stillLegal = (id: ObjectId, spec: TargetSpec): boolean =>
    isTargetStillLegal(
      ctx,
      id,
      spec,
      source.controllerId,
      sourceColorsOf(ctx, source.cardId, source.oracleId, source.lastKnownColors),
      scope.eventPlayerId,
      source.cardId,
    );

  /**
   * The source permanent "it" names ("sacrifice it", "it fights"): the very object the ability
   * came from when that was recorded (a blinked source is a new object, CR 400.7), otherwise the
   * source card's permanent.
   */
  const sourcePermanent = (): EnginePermanent | undefined => {
    if (source.objectId === null) return undefined;
    return ctx.state.battlefield.find((permanent) =>
      source.objectId === undefined
        ? permanent.cardId === source.cardId
        : permanent.id === source.objectId,
    );
  };

  /** Resolve an effect referent to an object id, or null when it is gone / no longer legal. */
  const ref = (r: EffectRef): ObjectId | null => {
    if (r === 'source') return sourcePermanent()?.id ?? null;
    if (r === 'eventPlayer') {
      return (scope.eventPlayerId as unknown as ObjectId | undefined) ?? null;
    }
    if (r === 'attachedToSource') {
      const attachment = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      if (attachment === undefined || attachment.attachedTo === null) return null;
      return findPermanent(ctx, attachment.attachedTo)?.id ?? null;
    }
    if (r === 'triggerObject') {
      if (triggerObjectCardId === undefined) {
        throw new Error(`engine bug: ${source.name} used 'triggerObject' with no trigger object`);
      }
      // Gone from the battlefield by resolution: the effect simply does nothing to it. A delayed
      // trigger that remembers the permanent itself also skips a new object of the same card.
      const pinnedId = extraScope?.triggerObjectId;
      const perm = ctx.state.battlefield.find(
        (p) => p.cardId === triggerObjectCardId && (pinnedId === undefined || p.id === pinnedId),
      );
      if (perm === undefined) {
        debug(ctx, 'effect', `${source.name}: trigger object has left the battlefield — skipped`);
        return null;
      }
      return perm.id;
    }
    const cachedCardId = refCardIdCache.get(r);
    if (cachedCardId !== undefined) {
      if (cachedCardId === null) return null;
      // The card itself, wherever it now is — NOT a triggered ability on the stack that merely
      // shares its source card id (Snakeskin Veil's "it gains hexproof" after its counter, aimed
      // at a creature whose own ETB trigger is still waiting on the stack). Only a target that is
      // itself a spell on the stack falls through to the stack lookup.
      return (
        findPhysicalObjectByCardId(ctx, cachedCardId)?.id ??
        findObjectByCardId(ctx, cachedCardId)?.id ??
        null
      );
    }
    const id = targets[r];
    const spec = ability.targets[r];
    if (id === undefined || spec === undefined) {
      refCardIdCache.set(r, null);
      return null;
    }
    if (!stillLegal(id, spec)) {
      debug(ctx, 'effect', `${source.name}: target ${id} illegal — skipped`);
      refCardIdCache.set(r, null);
      return null;
    }
    const targetPlayer = ctx.state.players.find((player) => player.id === id);
    const targetStack = ctx.state.stack.find((entry) => entry.id === id);
    const targetObject = findObjectById(ctx, id) as { controllerId?: PlayerId } | undefined;
    refControllerCache.set(
      r,
      targetPlayer?.id ?? targetStack?.controllerId ?? targetObject?.controllerId,
    );
    // Stack objects and players do not have a battlefield cardId to re-resolve through zone
    // changes -- a stack object's identity is only stable for this resolution (Arcane Denial's
    // delayed draw plus counter both need the same stack item), and a player's id needs no
    // re-resolution at all (players don't change zones). Caching either through
    // `findObjectByCardId` would incorrectly resolve to `undefined` on the SECOND effect that
    // references the same player slot (e.g. Sign in Blood: draw, then lose life, both off slot
    // 0) -- `findObjectById` finds no permanent for a PlayerId, so the cache would poison itself
    // with `null` after the first effect and every later effect referencing that slot would
    // silently do nothing.
    if (spec.kind === 'stackObject' || spec.kind === 'player') return id;
    refCardIdCache.set(r, findObjectById(ctx, id)?.cardId ?? null);
    return id;
  };

  for (const effect of ability.effects ?? []) {
    switch (effect.op) {
      case 'transformSelf': {
        const current = ctx.state.battlefield.find((perm) => perm.cardId === source.cardId);
        if (current !== undefined) transformPermanent(ctx, current);
        break;
      }
      case 'selfToLibraryTop': {
        const current = ctx.state.battlefield.find((perm) => perm.cardId === source.cardId);
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
        const firstPower = effectivePT(ctx, first).power;
        const secondPower = effectivePT(ctx, second).power;
        const firstTraits = combatDamageTraits(ctx, first);
        const secondTraits = combatDamageTraits(ctx, second);
        dealDamageToCreature(ctx, permanentSource(first), second, firstPower, {
          combat: false,
          sourceHasDeathtouch: firstTraits.deathtouch,
          sourceHasLifelink: firstTraits.lifelink,
          sourceHasInfect: firstTraits.infect,
          sourceColors: firstTraits.colors,
        });
        dealDamageToCreature(ctx, permanentSource(second), first, secondPower, {
          combat: false,
          sourceHasDeathtouch: secondTraits.deathtouch,
          sourceHasLifelink: secondTraits.lifelink,
          sourceHasInfect: secondTraits.infect,
          sourceColors: secondTraits.colors,
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
        const affected = affectedBy(ctx, source, effect.selector, scope.eventPlayerId);
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
      case 'dealDamage': {
        const t = ref(effect.target);
        if (t === null) break;
        const damageSourceId = effect.source === undefined ? null : ref(effect.source);
        if (effect.source !== undefined && damageSourceId === null) break;
        const damageSource =
          damageSourceId === null ? undefined : findPermanent(ctx, damageSourceId);
        if (effect.source !== undefined && damageSource === undefined) break;
        dealDamageToObject(
          ctx,
          damageSource === undefined ? source : permanentSource(damageSource),
          t,
          amountOf(effect.amount),
        );
        break;
      }
      case 'dealDamageUnlessSacrifice': {
        const t = ref(effect.target);
        if (t === null) break;
        const amount = amountOf(effect.amount);
        const targetPlayer = ctx.state.players.find((p) => p.id === t);
        if (targetPlayer === undefined) {
          dealDamageToObject(ctx, source, t, amount);
          break;
        }
        const creatures = ctx.state.battlefield.filter(
          (p) =>
            p.controllerId === targetPlayer.id &&
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
        if (!sacrificed) dealDamageToObject(ctx, source, t, amount);
        break;
      }
      case 'dealDamageEachChosen': {
        // "3 damage to each of up to two other targets" (Drakuseth) — each chosen id gets the
        // FULL amount independently, unlike `dealDamageDivided`'s shared total.
        const spec = ability.targets[effect.targetSlot];
        const amount = amountOf(effect.amount);
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          if (spec === undefined || !stillLegal(id, spec)) {
            continue;
          }
          dealDamageToObject(ctx, source, id, amount);
        }
        break;
      }
      case 'grantKeywordEachChosenUntilEot': {
        const spec = ability.targets[effect.targetSlot];
        const chosen = (countTargets?.[effect.targetSlot] ?? [])
          .filter((id) => spec !== undefined && stillLegal(id, spec))
          .map((id) => findPermanent(ctx, id))
          .filter((permanent): permanent is EnginePermanent => permanent !== undefined);
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
        const spec = ability.targets[effect.targetSlot];
        const count = amountOf(effect.count);
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          if (spec === undefined || !stillLegal(id, spec)) {
            continue;
          }
          const perm = findPermanent(ctx, id);
          if (perm === undefined) continue;
          addCounters(ctx, source, perm as EnginePermanent, effect.counter, count);
        }
        break;
      }
      case 'exileEachChosen': {
        const spec = ability.targets[effect.targetSlot];
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          if (spec === undefined || !stillLegal(id, spec)) {
            continue;
          }
          const perm = findPermanent(ctx, id);
          if (perm === undefined) continue;
          emit(ctx, 'exile', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'exile' });
        }
        break;
      }
      case 'destroyEachChosen': {
        const spec = ability.targets[effect.targetSlot];
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          if (spec === undefined || !stillLegal(id, spec)) {
            continue;
          }
          const permanent = findPermanent(ctx, id);
          if (permanent === undefined) continue;
          yield* destroyPermanent(ctx, source, permanent, false);
        }
        break;
      }
      case 'blinkEachChosen': {
        const spec = ability.targets[effect.targetSlot];
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          if (spec === undefined || !stillLegal(id, spec)) {
            continue;
          }
          const permanent = findPermanent(ctx, id);
          if (permanent === undefined) continue;
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
        let cardObj: EngineCardObject | undefined;
        for (const player of ctx.state.players) {
          const idx = player.graveyard.findIndex(
            (card) => card.cardId === targetId || String(card.id) === targetId,
          );
          if (idx !== -1) {
            cardObj = player.graveyard.splice(idx, 1)[0];
            break;
          }
        }
        if (cardObj === undefined) break;
        ctx.state.exile.push(cardObj);
        emit(ctx, 'exile', { target: cardObj.name, source: source.name });
        const def = getDefByOracleId(ctx, cardObj.oracleId, cardObj.name);
        if (def.types.includes('Creature')) {
          const sourcePerm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
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
      case 'exileUntilSourceLeaves': {
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
        for (const perm of ctx.state.battlefield) {
          const chars = computeCharacteristics(ctx, perm);
          if (chars.types.includes('Creature') && perm.controllerId !== perm.ownerId) {
            perm.controllerId = perm.ownerId;
          }
        }
        break;
      }
      case 'returnToHandEachChosen': {
        // "Return up to two other target nonland permanents to their owners' hands" (Marang
        // River Regent) — the `returnToHand` analog of `dealDamageEachChosen` above: every
        // object chosen in the variable-count slot is returned independently.
        const spec = ability.targets[effect.targetSlot];
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          if (spec === undefined || !stillLegal(id, spec)) {
            continue;
          }
          const perm = findPermanent(ctx, id);
          if (perm === undefined) continue;
          emit(ctx, 'returnToHand', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'hand' });
        }
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
          dealDamageToObject(ctx, source, id, amount);
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
        const t = effect.target === 'source' ? source.cardId : ref(effect.target);
        if (t === null) break;
        const perm = ctx.state.battlefield.find(
          (candidate) => candidate.id === t || candidate.cardId === t,
        );
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
        // The affected set is fixed here (CR 611.2c), mirroring `damageEach`/`putCountersEach`.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          yield* destroyPermanent(ctx, source, perm, effect.cantRegenerate === true);
        }
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
            const counteredDef = getDefByOracleId(
              ctx,
              countered.sourceOracleId,
              countered.description,
            );
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
        if (perm !== undefined && perm.controllerId !== source.controllerId) {
          perm.controllerId = source.controllerId;
          perm.timestamp = ctx.state.nextTimestamp++;
          perm.summoningSick = true;
          emit(ctx, 'gainControl', {
            source: source.name,
            target: perm.name,
            newController: source.controllerId,
          });
        }
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
        for (const permanent of ctx.state.battlefield.filter(
          (candidate) =>
            candidate.controllerId === playerId &&
            computeCharacteristics(ctx, candidate).types.includes('Creature'),
        )) {
          addCounters(ctx, source, permanent, effect.counter, count);
        }
        break;
      }
      case 'returnToHandEach': {
        // The affected set is fixed before anything moves (CR 611.2c): bouncing the first
        // permanent can change what the selector would match (an anthem leaving, a type-changer
        // going away), and a mass bounce must not re-derive its own targets mid-resolution.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          yield* moveObject(ctx, perm, { zone: 'hand' });
        }
        break;
      }
      case 'exileEach': {
        // Same fixed-set rule as `returnToHandEach`/`destroyEach` above it.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          yield* moveObject(ctx, perm, { zone: 'exile' });
        }
        break;
      }
      case 'graveyardToBattlefieldEach':
      case 'graveyardToHandEach': {
        // "Return all Zombie cards from your graveyard to the battlefield." The set is snapshotted
        // first: `moveObject` mutates the graveyard array being iterated.
        const owner = playerById(ctx, source.controllerId);
        const matching = owner.graveyard.filter((card) =>
          selectMatches(cardZoneCandidate(ctx, card, owner.id), effect.filter, {
            cardId: source.cardId,
            controllerId: source.controllerId,
          }),
        );
        for (const card of [...matching]) {
          yield* moveObject(
            ctx,
            card,
            effect.op === 'graveyardToBattlefieldEach'
              ? { zone: 'battlefield', controllerId: source.controllerId }
              : { zone: 'hand' },
          );
        }
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
          if (original === undefined || original.ability === null) continue;
          ctx.state.stack.push({
            ...original,
            id: `o-${ctx.state.nextObjectNum++}`,
            sourceId: `o-${ctx.state.nextObjectNum++}`,
            card: null,
            description: `Copy of ${original.description}`,
            controllerId: controller.id,
            sourceCardId: source.cardId,
            sourceOracleId: source.oracleId,
            targets: [...original.targets],
          });
        }
        break;
      }
      case 'removeCountersEach': {
        // The counterpart to `putCountersEach`, and NOT symmetric with it: removal is capped at
        // what is actually there (CR 122.1c — you cannot remove counters a permanent lacks), and
        // the key is deleted at zero so `hasCounters`/`sourceHasCounters` read a clean absence
        // rather than a lingering 0.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          const present = perm.counters[effect.counter] ?? 0;
          const removed = Math.min(present, amountOf(effect.count));
          if (removed <= 0) continue;
          const left = present - removed;
          if (left === 0) delete perm.counters[effect.counter];
          else perm.counters[effect.counter] = left;
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
      case 'createEmblem':
        controller.emblems.push({
          id: `emblem-${ctx.state.nextObjectNum++}`,
          name: effect.name,
          controllerId: controller.id,
          abilities: effect.abilities,
        });
        emit(ctx, 'createEmblem', { player: controller.id, name: effect.name }, controller.id);
        break;
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
          const before = opp.life;
          loseLife(ctx, opp, requested);
          lifeLostThisWay += before - opp.life;
        }
        break;
      }
      case 'gainLifeEqualToLifeLostThisWay':
        if (lifeLostThisWay > 0) gainLife(ctx, controller, lifeLostThisWay);
        break;
      case 'loseLifeTarget': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target !== undefined) loseLife(ctx, target, amountOf(effect.amount));
        break;
      }
      case 'eachOpponentDamage':
        for (const opp of opponentsOf(ctx, controller.id)) {
          dealDamageToPlayer(ctx, source, opp, effect.amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        }
        break;
      case 'damageEachCreatureController': {
        // This is intentionally one resolving effect. It deals one damage per creature, but
        // never creates one player decision/trigger per creature.
        const amount = amountOf(effect.amount);
        const creatures = ctx.state.battlefield.filter((perm) =>
          computeCharacteristics(ctx, perm).types.includes('Creature'),
        );
        for (const creature of creatures) {
          const owner = playerById(ctx, creature.controllerId);
          dealDamageToPlayer(ctx, source, owner, amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        }
        break;
      }
      case 'angelGrace':
        ctx.state.lifeFloorPlayers[controller.id] = true;
        emit(ctx, 'lifeFloor', { player: controller.id, minimum: 1 });
        break;
      case 'tapAndDamageController': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        target.tapped = true;
        queueTriggersForObject(ctx, 'becomesTapped', target);
        dealDamageToPlayer(
          ctx,
          source,
          playerById(ctx, target.controllerId),
          effectivePT(ctx, target).power,
          {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          },
        );
        break;
      }
      case 'drawForEachOpponent':
        for (const opponent of opponentsOf(ctx, controller.id)) yield* drawCards(ctx, opponent, 1);
        yield* drawCards(ctx, controller, opponentsOf(ctx, controller.id).length);
        break;
      case 'drawTargetAndController': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        yield* drawCards(ctx, target, 1);
        yield* drawCards(ctx, controller, 1);
        break;
      }
      case 'drawTargetAndControllerN': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        yield* drawCards(ctx, target, effect.count);
        yield* drawCards(ctx, controller, effect.count);
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
      case 'breenaAttack': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const attacker =
          scope.eventPlayerId === undefined ? controller : playerById(ctx, scope.eventPlayerId);
        yield* drawCards(ctx, attacker, 1);
        addCounters(ctx, source, target, '+1/+1', 2);
        break;
      }
      case 'schemingSymmetry': {
        for (const slot of [0, 1]) {
          const targetId = ref(slot);
          const target =
            targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
          if (target === undefined || target.library.length === 0) continue;
          const chosen = yield* chooseCard(ctx, {
            player: target.id,
            prompt: `${source.name}: choose a card to put on top of your library`,
            cards: target.library,
            type: 'search',
            verb: 'Choose',
          });
          if (chosen !== null)
            yield* moveObject(ctx, chosen, { zone: 'library', libraryPosition: 'top' });
        }
        break;
      }
      case 'sacrificePermanentOnDamage': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const permanents = ctx.state.battlefield.filter((perm) => perm.controllerId === target.id);
        const chosen = yield* chooseCard(ctx, {
          player: target.id,
          prompt: `${source.name}: sacrifice a permanent`,
          cards: permanents,
          type: 'sacrifice',
          verb: 'Sacrifice',
        });
        if (chosen !== null)
          yield* moveObject(ctx, chosen, { zone: 'graveyard', reason: 'sacrifice' });
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
      case 'arcbond': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId as never,
          controllerId: source.controllerId,
          targetId: target.cardId,
          when: 'dealtDamage',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'arcbondDamage' }],
            description:
              'That creature deals that much damage to each other creature and each player',
          },
          expiry: 'cleanup',
        });
        break;
      }
      case 'arcbondDamage': {
        const amount = amountOf({ kind: 'damageDealt' });
        const trigger =
          triggerObjectCardId === undefined ? undefined : findPermanent(ctx, triggerObjectCardId);
        for (const creature of ctx.state.battlefield.filter(
          (perm) =>
            computeCharacteristics(ctx, perm).types.includes('Creature') &&
            perm.cardId !== trigger?.cardId,
        )) {
          dealDamageToCreature(ctx, source, creature, amount, {
            combat: false,
            sourceHasDeathtouch: false,
            sourceHasLifelink: false,
          });
        }
        for (const player of ctx.state.players.filter((p) => !p.hasLost)) {
          dealDamageToPlayer(ctx, source, player, amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        }
        break;
      }
      case 'combatCalligrapher': {
        const attackingPlayerId =
          scope.eventPlayerId ??
          (triggerObjectCardId === undefined
            ? undefined
            : findPermanent(ctx, triggerObjectCardId)?.controllerId);
        const attacker =
          triggerObjectCardId === undefined ? undefined : findPermanent(ctx, triggerObjectCardId);
        if (
          attackingPlayerId === undefined ||
          attacker?.attacking === null ||
          attacker?.attacking === undefined
        )
          break;
        const token = createToken(
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
          attackingPlayerId,
        );
        token.tapped = true;
        token.attacking = attacker.attacking;
        token.statuses.push('attacking');
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
      case 'delirium': {
        const targetId = ref(0);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        target.tapped = true;
        queueTriggersForObject(ctx, 'becomesTapped', target);
        dealDamageToPlayer(
          ctx,
          source,
          playerById(ctx, target.controllerId),
          effectivePT(ctx, target).power,
          { combat: false, sourceIsCommander: false, sourceHasLifelink: false },
        );
        ctx.state.combatDamagePrevention.players[target.controllerId] = true;
        break;
      }
      case 'deflectingPalm':
        ctx.state.combatDamagePrevention.players[controller.id] = true;
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
        const permanent = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
        if (target === undefined || permanent === undefined) break;
        yield* drawCards(ctx, controller, 2);
        permanent.controllerId = target.id;
        permanent.timestamp = ctx.state.nextTimestamp++;
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
        dealDamageToPlayer(ctx, source, target, amount, {
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
      case 'sacrificeSourceThenReflexive': {
        const perm = sourcePermanent();
        // Only a permanent you control can be sacrificed (CR 701.21a).
        if (perm === undefined || perm.controllerId !== source.controllerId) break;
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
        const metricOf = (perm: EnginePermanent): number =>
          effect.metric === 'power'
            ? effectivePT(ctx, perm).power
            : spellManaValue(getDefByOracleId(ctx, perm.oracleId, perm.name), undefined);
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
          const greatest = Math.max(0, ...candidates.map((perm) => metricOf(perm)));
          const choices = candidates.filter((perm) => metricOf(perm) === greatest);
          const metricLabel = effect.metric === 'power' ? 'power' : 'mana value';
          const verb = effect.action === 'exile' ? 'Exile' : 'Sacrifice';
          const chosen = yield* chooseCard(ctx, {
            player: opponent.id,
            prompt: `${source.name}: ${verb.toLowerCase()} a permanent with the greatest ${metricLabel}`,
            cards: choices,
            type: 'sacrifice',
            verb,
          });
          if (chosen !== null) {
            yield* moveObject(
              ctx,
              chosen,
              effect.action === 'exile'
                ? { zone: 'exile' }
                : { zone: 'graveyard', reason: 'sacrifice' },
            );
          }
        }
        break;
      }
      case 'transferCountersFromTriggerObject': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        const trigger =
          triggerObjectCardId === undefined
            ? undefined
            : findObjectByCardId(ctx, triggerObjectCardId);
        const counters =
          trigger !== undefined && trigger.zone !== 'battlefield'
            ? (trigger as EngineCardObject).rememberedCounters
            : undefined;
        if (target !== undefined && counters !== undefined) {
          for (const [counter, count] of Object.entries(counters)) {
            const adjustedCount = counterAmountAfterReplacements(ctx, target, counter, count);
            target.counters[counter] = (target.counters[counter] ?? 0) + adjustedCount;
          }
        }
        break;
      }
      case 'mayPayLifeForTriggerPowerAndCounter': {
        // Queued enters triggers store `cardId`, not battlefield object id.
        const entering =
          triggerObjectCardId === undefined
            ? undefined
            : ctx.state.battlefield.find((perm) => perm.cardId === triggerObjectCardId);
        if (entering === undefined || entering.controllerId !== controller.id) break;
        const power = effectivePT(ctx, entering).power;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay ${power} life to put ${power} +1/+1 counter(s) on ${entering.name}?`,
          options: [
            { type: 'payLife', description: `Pay ${power} life and add ${power} counter(s)` },
            { type: 'decline', description: 'Decline' },
          ],
        };
        if (outcome.index === 0) {
          loseLife(ctx, controller, power);
          const adjustedCount = counterAmountAfterReplacements(ctx, entering, '+1/+1', power);
          entering.counters['+1/+1'] = (entering.counters['+1/+1'] ?? 0) + adjustedCount;
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
        const card = ctx.state.exile.find(
          (candidate) => candidate.attachedToCardId === source.cardId,
        );
        if (card !== undefined) {
          delete card.attachedToCardId;
          yield* moveObject(ctx, card, { zone: 'hand' });
        }
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
        const returning: EngineCardObject[] = [];
        for (const player of ctx.state.players) {
          const creatures = player.graveyard.filter((card) =>
            getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Creature'),
          );
          for (const card of creatures) {
            const moved = yield* moveObject(ctx, card, { zone: 'exile' });
            if (moved !== null && moved.zone !== 'battlefield')
              returning.push(moved as EngineCardObject);
          }
        }
        for (const perm of [...ctx.state.battlefield]) {
          if (computeCharacteristics(ctx, perm).types.includes('Creature'))
            yield* moveObject(ctx, perm, { zone: 'graveyard' });
        }
        for (const card of returning) {
          const current = ctx.state.exile.find((candidate) => candidate.cardId === card.cardId);
          if (current !== undefined)
            yield* moveObject(ctx, current, { zone: 'battlefield', controllerId: current.ownerId });
        }
        break;
      }
      case 'exileGraveyardCreateTokens': {
        const targetId = ref(effect.target);
        const target =
          targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const cards = [...target.graveyard];
        const count = cards.filter((card) => {
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          return def.types.includes('Artifact') || def.types.includes('Land');
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
        let remaining = effect.maxManaValue;
        while (remaining > 0) {
          const choices = controller.graveyard.filter((card) => {
            const def = getDefByOracleId(ctx, card.oracleId, card.name);
            return (
              def.types.includes('Artifact') &&
              def.types.includes('Creature') &&
              spellManaValue(def, undefined) <= remaining
            );
          });
          if (choices.length === 0) break;
          const chosen = yield* chooseCard(ctx, {
            player: controller.id,
            prompt: `${source.name}: return an artifact creature (up to ${remaining} mana value)`,
            cards: choices,
            type: 'returnToBattlefield',
            verb: 'Return',
            decline: { type: 'decline', description: 'Return no more cards', verb: 'Done' },
          });
          if (chosen === null) break;
          remaining -= spellManaValue(
            getDefByOracleId(ctx, chosen.oracleId, chosen.name),
            undefined,
          );
          yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: controller.id });
        }
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
          if (chosen === null) controller.hasLost = true;
          else yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: controller.id });
        }
        break;
      case 'grantUnearthToArtifactCreaturesInGraveyard': {
        for (const card of controller.graveyard) {
          const def = ctx.defs.get(card.oracleId);
          if (def?.types.includes('Artifact') !== true || !def.types.includes('Creature')) continue;
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
          when: 'endStep',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'exileSource' }],
            description: 'Exile this permanent',
          },
          expiry: 'endStep',
        });
        break;
      }
      case 'exileSource': {
        const permanent = ctx.state.battlefield.find(
          (candidate) => candidate.cardId === source.cardId,
        );
        if (permanent !== undefined) yield* moveObject(ctx, permanent, { zone: 'exile' });
        break;
      }
      case 'exileResolvingSpell': {
        const entry = ctx.state.stack.find(
          (stackObject) => stackObject.sourceCardId === source.cardId,
        );
        if (entry?.card !== null && entry?.card !== undefined)
          yield* moveObject(ctx, entry.card, { zone: 'exile' });
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
        for (let i = 0; i < 3; i++) {
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
        const choices = controller.graveyard.filter((card) => {
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          return def.types.includes('Artifact') && def.types.includes('Creature');
        });
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: you may return an artifact creature milled this way`,
          cards: choices,
          type: 'returnToHand',
          verb: 'Return',
          decline: { type: 'decline', description: 'Take none', verb: 'Skip' },
        });
        if (chosen !== null) yield* moveObject(ctx, chosen, { zone: 'hand' });
        break;
      }
      case 'drawRevealTopLoseManaValue': {
        const top = controller.library[0];
        if (top === undefined) {
          controller.attemptedDrawFromEmptyLibrary = true;
          emit(ctx, 'drawFromEmptyLibrary', { player: controller.id });
          break;
        }
        const manaValue = spellManaValue(getDefByOracleId(ctx, top.oracleId, top.name), undefined);
        yield* moveObject(ctx, top, { zone: 'hand' });
        loseLife(ctx, controller, manaValue);
        emit(
          ctx,
          'draw',
          { player: controller.id, cardId: top.cardId, name: top.name, revealed: true },
          controller.id,
        );
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
      case 'preventCombatDamageToController':
        ctx.state.combatDamagePrevention.players[controller.id] = true;
        break;
      case 'copyTargetSpell': {
        const targetId = targets[effect.target];
        const original = ctx.state.stack.find(
          (entry) => entry.id === targetId && entry.kind === 'spell',
        );
        if (original === undefined || original.ability === null) break;
        const copy: EngineStackObject = {
          ...original,
          id: `o-${ctx.state.nextObjectNum++}`,
          sourceId: `o-${ctx.state.nextObjectNum++}`,
          card: null,
          description: `Copy of ${original.description}`,
          controllerId: controller.id,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          targets: [...original.targets],
        };
        ctx.state.stack.push(copy);
        break;
      }
      case 'damageController':
        dealDamageToPlayer(ctx, source, controller, effect.amount, {
          combat: false,
          sourceIsCommander: false,
          sourceHasLifelink: false,
        });
        break;
      case 'damageEach': {
        // The affected set is fixed here (CR 611.2c) and the damage is dealt simultaneously,
        // so a creature that dies to it still received its share.
        const damageSourceId = effect.source === undefined ? null : ref(effect.source);
        const damageSource =
          damageSourceId === null ? undefined : findPermanent(ctx, damageSourceId);
        if (effect.source !== undefined && damageSource === undefined) break;
        const affected = affectedBy(ctx, source, effect.selector).filter(
          (permanent) => effect.exceptSource !== true || permanent.cardId !== damageSource?.cardId,
        );
        const amount = amountOf(effect.amount);
        for (const perm of affected) {
          dealDamageToObject(
            ctx,
            damageSource === undefined ? source : permanentSource(damageSource),
            perm.id,
            amount,
          );
        }
        emit(ctx, 'damageEach', {
          source: damageSource?.name ?? source.name,
          targets: affected.map((p) => p.name),
          amount,
        });
        break;
      }
      case 'damageEachPlayer': {
        // Earthquake's second half. Split from `damageEach` rather than folded in, because a
        // `Selector` describes permanents and players are not permanents.
        const amount = amountOf(effect.amount);
        for (const player of ctx.state.players.filter((p) => !p.hasLost)) {
          dealDamageToPlayer(ctx, source, player, amount, {
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
        const found: EnginePermanent[] = [];
        const selectorSource = { cardId: source.cardId, controllerId: controller.id };
        for (let i = 0; i < 2; i++) {
          const matches = controller.library.filter((card) =>
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
          const card = matches[outcome.index] as EngineCardObject;
          yield* moveObject(ctx, card, {
            zone: 'battlefield',
            controllerId: controller.id,
            entersTapped: true,
          });
          const permanent = ctx.state.battlefield.find(
            (candidate) => candidate.cardId === card.cardId,
          );
          if (permanent !== undefined) found.push(permanent);
        }
        shuffleLibrary(ctx, controller);
        if (amountOf({ kind: 'optionalCostCount', mechanic: 'kicker' }) > 0) {
          for (const permanent of found) permanent.tapped = false;
          if (found.length > 0) {
            ctx.state.effects.push({
              id: `eff-${ctx.state.nextObjectNum++}`,
              sourceId: source.cardId,
              description: 'Hunting Wilds animated Forests',
              targetCardIds: found.map((permanent) => permanent.cardId),
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
        const equipment = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
        if (t === null || equipment === undefined) break;
        // CR 702.6b: equipping moves the Equipment; it never leaves the battlefield, so its
        // timestamp is unchanged and the granted abilities keep their layer position.
        equipment.attachedTo = t;
        emit(ctx, 'attach', {
          equipment: equipment.name,
          to: findPermanent(ctx, t)?.name ?? t,
        });
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
        createTokens(ctx, spec, amountOf(effect.count), controller.id, effect.tapped === true);
        break;
      }
      case 'createTokenAttacking': {
        const count = amountOf(effect.count);
        if (count <= 0) break;
        const defenders = (ctx.state.combat?.defendingPlayers ?? []).filter((id) => {
          const player = ctx.state.players.find((candidate) => candidate.id === id);
          return player !== undefined && !player.hasLost && id !== controller.id;
        });
        if (defenders.length === 0) break;
        let defenderId = defenders[0] as PlayerId;
        if (defenders.length > 1) {
          const outcome = yield {
            decisionType: 'general',
            player: controller.id,
            prompt: `${source.name}: choose who the token attacks`,
            options: defenders.map((id) =>
              playerOption(id, id, {
                type: 'choosePlayer',
                description: `Attack ${id}`,
                payload: id,
                verb: 'Attack',
              }),
            ),
          };
          defenderId = defenders[outcome.index] ?? defenderId;
        }
        const spec = {
          ...effect.spec,
          ...(effect.powerOverride === undefined ? {} : { power: amountOf(effect.powerOverride) }),
          ...(effect.toughnessOverride === undefined
            ? {}
            : { toughness: amountOf(effect.toughnessOverride) }),
        };
        const created: EnginePermanent[] = [];
        const multiplier = tokenCreationMultiplierFor(ctx, controller.id);
        for (let i = 0; i < count * multiplier; i++) {
          const token = createToken(ctx, spec, controller.id, false, false, false);
          token.tapped = true;
          token.attacking = defenderId;
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
          applyTokenCreationReplacements(ctx, spec, controller.id);
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
      case 'createTokenForEachOpponent': {
        // "For each opponent, create a token" is one creation event, so the replacements run
        // once at the end rather than once per opponent.
        const opponents = opponentsOf(ctx, controller.id);
        const multiplier = tokenCreationMultiplierFor(ctx, controller.id);
        const created: EnginePermanent[] = [];
        for (const opponent of opponents) {
          for (let i = 0; i < multiplier; i++) {
            const token = createToken(ctx, effect.spec, controller.id, false, false);
            created.push(token);
            if (effect.attacking === true) {
              // Adeline / Ainok Strike Leader: "tapped AND attacking that player". The token is
              // put onto the battlefield already attacking, so it was never declared as an
              // attacker (CR 508.4) — but it is still tapped, exactly as printed.
              token.tapped = true;
              token.attacking = opponent.id;
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
      case 'createTokenCopyOf': {
        const t = ref(effect.ref);
        const original = t === null ? undefined : findPermanent(ctx, t);
        // The referent may have left before this resolved. `'triggerObject'` is not a target
        // (CR 115.10a), so that is a no-op rather than a fizzle.
        if (original === undefined) break;
        const baseSpec = tokenSpecCopying(ctx, original, effect.exceptNonLegendary === true);
        const spec = {
          ...baseSpec,
          ...(effect.addTypes !== undefined
            ? { types: [...new Set([...baseSpec.types, ...effect.addTypes])] }
            : {}),
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
          ...(effect.addKeywords !== undefined
            ? { keywords: [...new Set([...(baseSpec.keywords ?? []), ...effect.addKeywords])] }
            : {}),
        };
        for (let i = 0; i < amountOf(effect.count); i++) {
          const token = createToken(ctx, spec, controller.id);
          if (effect.sacrificeAt === 'endStep') {
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
        player.energy *= 2;
        player.poisonCounters *= 2;
        emit(ctx, 'energy', { amount: player.energy, total: player.energy }, player.id);
        break;
      }
      case 'becomeCopyOf': {
        const targetId = ref(effect.ref);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        const self = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
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
      case 'untapBoundIf': {
        if (!evaluateCondition(ctx, effect.condition, source)) break;
        for (const cardId of effectBindings.get(effect.binding) ?? []) {
          const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === cardId);
          if (permanent !== undefined) permanent.tapped = false;
        }
        break;
      }
      case 'gainControl':
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          if (perm.controllerId === source.controllerId) continue;
          perm.controllerId = source.controllerId;
          perm.timestamp = ctx.state.nextTimestamp++;
          // CR 302.6: not continuously controlled by the new controller since their turn began.
          // Left true under haste, exactly like a freshly cast creature.
          perm.summoningSick = true;
          emit(ctx, 'gainControl', {
            source: source.name,
            target: perm.name,
            newController: source.controllerId,
          });
        }
        break;
      case 'graveyardToBattlefield': {
        const owner = playerById(ctx, source.controllerId);
        // `ref()` restricts `'triggerObject'` to the battlefield — right for effects that act
        // on a still-live permanent, but this op exists specifically to revive something that
        // has already left it (a "dies" trigger's object, by definition, always has). Look
        // that referent up directly by `triggerObjectCardId` instead of through `ref()`.
        const cardObj =
          effect.target === 'triggerObject'
            ? triggerObjectCardId === undefined
              ? undefined
              : owner.graveyard.find((c) => c.cardId === triggerObjectCardId)
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
        emit(ctx, 'graveyardToBattlefield', { target: cardObj.name, source: source.name });
        yield* moveObject(ctx, cardObj, { zone: 'battlefield', controllerId: source.controllerId });
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
      case 'graveyardToLibraryTop': {
        const t = ref(effect.target);
        if (t === null) break;
        const card = findObjectById(ctx, t);
        if (card !== undefined)
          yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'top' });
        break;
      }
      case 'graveyardToHand': {
        const t = ref(effect.target);
        if (t === null) break;
        const owner = playerById(ctx, source.controllerId);
        const cardObj = owner.graveyard.find((c) => c.id === t);
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
            jointlyPayableSources(ctx, manaSourcesFor(ctx, controller.id), reserved),
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
      case 'doublePlayerCounters': {
        controller.energy *= 2;
        controller.poisonCounters *= 2;
        emit(ctx, 'energy', { amount: controller.energy, total: controller.energy }, controller.id);
        break;
      }
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
          effect.player === 'eventPlayer' ? (scope.eventPlayerId ?? controller.id) : controller.id;
        const player = playerById(ctx, playerId);
        const top = player.library[0];
        if (top === undefined) break;
        yield* moveObject(ctx, top, {
          zone: 'battlefield',
          controllerId: player.id,
          faceDown: true,
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
          dealDamageToObject(ctx, source, target.id, damage);
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
        ctx.state.extraCombatPhases += 1;
        break;
      case 'becomeMonarch':
        ctx.state.monarchPlayerId = controller.id;
        emit(ctx, 'monarch', { player: controller.id }, controller.id);
        break;
      case 'druidPurification': {
        const chosen: EnginePermanent[] = [];
        const orderedPlayers = [controller, ...opponentsOf(ctx, controller.id)];
        for (const player of orderedPlayers) {
          const options = ctx.state.battlefield.filter((perm) => {
            const chars = computeCharacteristics(ctx, perm);
            return (
              perm.controllerId !== player.id &&
              (chars.types.includes('Artifact') || chars.types.includes('Enchantment'))
            );
          });
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: `${source.name}: choose an artifact or enchantment you don't control to destroy, or choose none.`,
            options: [
              plainOption({ type: 'decline', description: 'Choose none', verb: 'Skip' }),
              ...options.map((perm) =>
                cardOption(ctx, perm, {
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
            if (picked !== undefined) chosen.push(picked);
          }
        }
        for (const perm of chosen) {
          const current = findPermanent(ctx, perm.id);
          if (current === undefined) continue;
          yield* destroyPermanent(ctx, source, current);
        }
        break;
      }
      case 'exileTargetWithSource': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const targetCardId = target.cardId;
        yield* moveObject(ctx, target, { zone: 'exile' });
        const currentSource = ctx.state.battlefield.find((perm) => perm.cardId === source.cardId);
        if (currentSource !== undefined) {
          currentSource.exiledCardIds = [...(currentSource.exiledCardIds ?? []), targetCardId];
        }
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
          cardId: source.cardId,
          controllerId: source.controllerId,
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
            triggerObjectCardId,
            extraScope,
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
        const payerId = effect.payer === 'eventPlayer' ? scope.eventPlayerId : controller.id;
        if (payerId === undefined) throw new Error(source.name + ': unlessPays has no payer');
        const payer = playerById(ctx, payerId);
        // "…pays {X}, where X is this creature's power" — resolved now, against the source as it
        // currently is (CR 608.2), and folded into the generic portion of the printed cost.
        const owed =
          effect.genericValue === undefined
            ? effect.cost
            : addGeneric(effect.cost, evaluateValueIn(ctx, effect.genericValue, scope));
        const costDescription = describeManaCost(owed);
        const canAfford = canPay(owed, payer.manaEntries, manaSourcesFor(ctx, payer.id));
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
          },
          timestamp: ctx.state.nextTimestamp++,
        });
        emit(ctx, 'becomeCreature', { source: source.name, target: perm.name });
        break;
      }
      case 'crewVehicle': {
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
        break;
      }
      case 'fightUpToOneChosen': {
        const aId = ref(effect.a);
        const bId = countTargets?.[effect.bSlot]?.[0];
        if (aId === null || bId === undefined) break;
        const a = findPermanent(ctx, aId);
        const b = findPermanent(ctx, bId);
        if (a === undefined || b === undefined || a.id === b.id) break;
        const aPower = effectivePT(ctx, a).power;
        const bPower = effectivePT(ctx, b).power;
        const aTraits = combatDamageTraits(ctx, a);
        const bTraits = combatDamageTraits(ctx, b);
        dealDamageToCreature(ctx, permanentSource(a), b, aPower, {
          combat: false,
          sourceHasDeathtouch: aTraits.deathtouch,
          sourceHasLifelink: aTraits.lifelink,
          sourceHasInfect: aTraits.infect,
          sourceColors: aTraits.colors,
        });
        dealDamageToCreature(ctx, permanentSource(b), a, bPower, {
          combat: false,
          sourceHasDeathtouch: bTraits.deathtouch,
          sourceHasLifelink: bTraits.lifelink,
          sourceHasInfect: bTraits.infect,
          sourceColors: bTraits.colors,
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
      case 'returnSelfFromGraveyardToHand': {
        const card = controller.graveyard.find((c) => c.cardId === source.cardId);
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
          const card = target.graveyard.find((c) => c.id === cardId || c.cardId === cardId);
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
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay ${describeManaCost(effect.templatedCost)} for X? (0 declines)`,
          options: choices.map((x) => ({
            type: 'payX',
            description:
              x === 0
                ? "Don't pay"
                : `Pay X=${x} (${describeManaCost(withX(effect.templatedCost, x))})`,
          })),
        };
        const chosenX = choices[outcome.index] ?? 0;
        if (chosenX <= 0) break;
        yield* payManaCost(ctx, controller, withX(effect.templatedCost, chosenX));
        dealDamageToObject(ctx, source, t, chosenX);
        break;
      }
      case 'exileTopNPlayableUntilEot': {
        const count = amountOf(effect.count);
        for (let i = 0; i < count; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          const moved = (yield* moveObject(ctx, top, { zone: 'exile' })) as EngineCardObject | null;
          if (moved !== null) moved.playableUntilEotBy = controller.id;
        }
        break;
      }
      case 'lookAtTopNCastOneFree': {
        const top = controller.library.slice(0, effect.count);
        const eligible = top.filter((card) => freeCardIsCastable(ctx, card, controller.id));
        if (eligible.length === 0) break;
        const options = [
          ...eligible.map((card) =>
            cardOption(ctx, card, {
              type: 'castFree',
              description: `Cast ${card.name} without paying its mana cost`,
              verb: 'Cast for free',
            }),
          ),
          plainOption({ type: 'decline', description: 'Cast nothing', verb: 'Decline' }),
        ];
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose at most one card from the top ${effect.count} cards to cast for free.`,
          options,
        };
        if (outcome.index < eligible.length) {
          const chosen = eligible[outcome.index];
          if (chosen !== undefined) yield* resolveFreeCard(ctx, chosen, controller.id);
        }
        for (const card of top) {
          if (
            !ctx.state.players.some((p) =>
              p.library.some((candidate) => candidate.cardId === card.cardId),
            )
          )
            continue;
          if (card !== eligible[outcome.index]) {
            const current = controller.library.find(
              (candidate) => candidate.cardId === card.cardId,
            );
            if (current !== undefined && current !== eligible[outcome.index])
              yield* moveObject(ctx, current, { zone: 'library', libraryPosition: 'bottom' });
          }
        }
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
        // `'triggerObject'` here is deliberately NOT resolved through `ref()`: `ref` restricts
        // 'triggerObject' to the battlefield (right, for effects that act on a still-live
        // permanent), but a delayed trigger registered from a 'dies' ability fires with its
        // triggerObject already in the graveyard — that's the whole premise of "dies". This
        // effect's job is to remember the object regardless of zone (same rationale as the
        // Hellkite Courser cardId-tracking note above), so it looks the card up directly by
        // `triggerObjectCardId` across every zone instead.
        const t =
          effect.target === 'triggerObject'
            ? triggerObjectCardId === undefined
              ? null
              : (findPhysicalObjectByCardId(ctx, triggerObjectCardId)?.id ?? null)
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
              (targetObject as unknown as { controllerId?: PlayerId } | undefined)?.controllerId);
        // A remembered trigger object that no longer exists anywhere (a token that died fighting
        // and ceased to exist) still names its card, so the delayed ability does nothing.
        const goneTriggerObjectCardId =
          t === null && effect.target === 'triggerObject' && effect.sameObject === true
            ? triggerObjectCardId
            : undefined;
        const targetId =
          t === null
            ? goneTriggerObjectCardId
            : targetPlayer !== undefined
              ? targetPlayer.id
              : (targetStack?.controllerId ?? targetObject?.cardId);
        const delayedController =
          effect.controller === 'targetController'
            ? (targetPlayer?.id ??
              targetStack?.controllerId ??
              (targetObject as unknown as { controllerId?: PlayerId } | undefined)?.controllerId ??
              source.controllerId)
            : source.controllerId;
        const affectedPlayerId =
          effect.affectedPlayer === 'sourceController'
            ? source.controllerId
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
        const eventObjectId =
          effect.target === 'triggerObject' ? extraScope?.eventObjectId : undefined;
        const rememberedObjectId =
          effect.sameObject === true ? (eventObjectId ?? (t !== null ? t : undefined)) : undefined;
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
        const card =
          player.commandZone.find((c) => c.cardId === t || c.id === t) ?? player.commandZone[0];
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
        for (const perm of affectedBy(ctx, source, effect.selector)) {
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
      case 'hideawayExileTop4': {
        const player = playerById(ctx, source.controllerId);
        const top4 = player.library.slice(0, 4);
        if (top4.length === 0) break;
        const chosenCard =
          top4.length === 1
            ? top4[0]!
            : ((yield* chooseCard(ctx, {
                player: source.controllerId,
                prompt: 'Look at the top four cards of your library. Exile one of them face down.',
                cards: top4,
                type: 'hideawayExile',
                verb: 'Exile face down',
              })) ?? top4[0]!);
        const moved = (yield* moveObject(ctx, chosenCard, {
          zone: 'exile',
        })) as EngineCardObject | null;
        if (moved !== null) {
          moved.attachedToCardId = source.cardId;
        }

        const rest = top4.filter((c) => c.id !== chosenCard.id);
        ctx.rng.shuffle(rest);
        for (const c of rest) {
          yield* moveObject(ctx, c, { zone: 'library', libraryPosition: 'bottom' });
        }
        break;
      }
      case 'playExiledCardFree': {
        const card = ctx.state.exile.find(
          (c: EngineCardObject) => c.attachedToCardId === source.cardId,
        );
        if (!card) break;
        const def = getDefByOracleId(ctx, card.oracleId, card.name);
        const isLand = def.types.includes('Land');
        if (isLand) {
          yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: source.controllerId });
        } else {
          const isPermanent = def.types.some((t) =>
            ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'].includes(t),
          );
          if (isPermanent) {
            yield* moveObject(ctx, card, {
              zone: 'battlefield',
              controllerId: source.controllerId,
            });
          } else {
            const spellAbility = def.spellAbility ?? { kind: 'spell', targets: [], effects: [] };
            yield* executeAbility(
              ctx,
              {
                cardId: card.cardId,
                name: card.name,
                oracleId: card.oracleId,
                controllerId: source.controllerId,
              },
              spellAbility,
              [],
            );
            yield* moveObject(ctx, card, { zone: 'graveyard' });
          }
        }
        break;
      }
      case 'noOp':
        break;
    }
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
  const looked = player.library.splice(0, effect.count);
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

  const rest = looked.filter((card) => card !== taken);
  if (effect.rest === 'topAnyOrder') {
    const ordered = yield* orderForLibrary(ctx, source, player, rest, 'top');
    player.library.unshift(...ordered);
  } else {
    ctx.rng.shuffle(rest);
    player.library.push(...rest);
  }
  emit(
    ctx,
    'lookAtTop',
    { player: player.id, looked: looked.length, took: taken?.name ?? null },
    player.id,
  );

  if (taken !== undefined) {
    const destination = mayPut!.destination;
    if (destination.zone === 'libraryTop') {
      player.library.unshift(taken);
    } else if (destination.zone === 'battlefield') {
      yield* moveObject(ctx, taken, {
        zone: 'battlefield',
        controllerId: player.id,
        ...(destination.tapped === true ? { entersTapped: true } : {}),
      });
    } else {
      yield* moveObject(ctx, taken, { zone: destination.zone });
    }
  }

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
      ? canPay(cost.cost, controller.manaEntries, manaSourcesFor(ctx, controller.id))
      : controller.life >= cost.amount &&
        (ctx.state.lifeFloorPlayers[controller.id] !== true || controller.life - cost.amount >= 1);
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
      else loseLife(ctx, controller, cost.amount);
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
 * One decision per destination, each offering the matching cards plus "find nothing" — CR
 * 701.19c never requires a player to find a card, and a search with fewer matches than
 * destinations simply stops early.
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

    // Auto-select when all matching cards share the same name (e.g., mono-color basic
    // land search): the choice is meaningless and would waste an AI call.
    const distinctNames = new Set(matches.map((c) => c.name));
    if (!allowFailToFind && distinctNames.size === 1) {
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
            type: 'findCard',
            description: `Put ${card.name} ${where}`,
            verb: `Put ${where}`,
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
function* searchLibraryCastFree(
  ctx: GameContext,
  source: EffectSource,
  player: EnginePlayerState,
  filter: Selector,
): GameGen<void> {
  const selectorSource = { cardId: source.cardId, controllerId: player.id };
  const matches = player.library.filter((card) =>
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
          type: 'scryKeep',
          description: `Keep ${card.name} on top`,
          verb: 'Keep on top',
          role: 'affirm',
        }),
        cardOption(ctx, card, {
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
          type: 'surveilKeep',
          description: `Keep ${card.name} on top`,
          verb: 'Keep on top',
          role: 'affirm',
        }),
        cardOption(ctx, card, {
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
          type: 'proliferate',
          description: `Proliferate ${perm.name}`,
          payload: perm.id,
          verb: 'Proliferate',
          role: 'affirm',
          controller: perm.controllerId,
        }),
        cardOption(ctx, perm, {
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
  const expiring = ctx.state.effects.filter((effect) => effect.duration !== 'permanent');
  if (expiring.length > 0) {
    debug(ctx, 'effect', `ending ${expiring.length} until-end-of-turn effect(s)`);
    ctx.state.effects = ctx.state.effects.filter((effect) => effect.duration === 'permanent');
  }
  for (const perm of ctx.state.battlefield) {
    if (perm.copyUntilEot !== true || perm.copyOriginal === undefined) continue;
    const original = perm.copyOriginal;
    perm.oracleId = original.oracleId;
    perm.name = original.name;
    perm.typeLine = original.typeLine;
    perm.oracleText = original.oracleText;
    perm.manaCost = original.manaCost;
    perm.power = original.power;
    perm.toughness = original.toughness;
    perm.timestamp = ctx.state.nextTimestamp++;
    delete perm.copyOriginal;
    delete perm.copyUntilEot;
    delete perm.copyAddTypes;
    delete perm.copyAddKeywords;
    delete perm.copyAddTriggers;
    delete perm.copyRemoveSupertypes;
    delete perm.copyAddSupertypes;
    delete perm.copyNameOverride;
  }
  for (const card of ctx.state.exile) {
    if (card.playableUntilEotBy !== undefined) delete card.playableUntilEotBy;
  }
}

/** One permanent a mana source's "sacrifice another" activation cost needs. */
type SacrificeDemand = (candidate: EnginePermanent) => boolean;

/** Each sacrifice a mana source's activation costs demand, one entry per permanent. */
function sacrificeDemandsOf(
  ctx: GameContext,
  source: ManaSource,
): { perm: EnginePermanent; demands: SacrificeDemand[]; sacrificesItself: boolean } | undefined {
  const perm = ctx.state.battlefield.find((permanent) => permanent.cardId === source.cardId);
  if (perm === undefined) return undefined;
  const demands: SacrificeDemand[] = [];
  for (const cost of source.costs) {
    if (cost.kind !== 'sacrificeOther') continue;
    const accepts: SacrificeDemand = (candidate) =>
      (cost.allowSelf === true || candidate.id !== perm.id) &&
      candidate.controllerId === perm.controllerId &&
      matchesSelector(ctx, candidate, cost.selector, {
        cardId: perm.cardId,
        controllerId: perm.controllerId,
      });
    for (let i = 0; i < (cost.count ?? 1); i++) demands.push(accepts);
  }
  return { perm, demands, sacrificesItself: source.costs.some((c) => c.kind === 'sacrificeSelf') };
}

/** A mana source that needs nothing but itself: no sacrifice and no mana in its cost. */
function isPlainManaSource(source: ManaSource): boolean {
  return (
    source.manaCost === undefined &&
    source.costs.every((cost) => cost.kind !== 'sacrificeOther' && cost.kind !== 'sacrificeSelf')
  );
}

/** Whether every demand can be met by its own distinct permanent, none of them `unavailable`. */
function demandsAllocatable(
  ctx: GameContext,
  demands: readonly SacrificeDemand[],
  unavailable: ReadonlySet<string>,
): boolean {
  const used = new Set(unavailable);
  const assign = (index: number): boolean => {
    const demand = demands[index];
    if (demand === undefined) return true;
    for (const candidate of ctx.state.battlefield) {
      if (used.has(candidate.id) || !demand(candidate)) continue;
      used.add(candidate.id);
      if (assign(index + 1)) return true;
      used.delete(candidate.id);
    }
    return false;
  };
  return assign(0);
}

/**
 * The mana sources that can all be activated together when `reserved` permanents are spoken for
 * by another part of the same cost (Ashnod's Altar paying for Canoptek Wraith's "{3} and
 * sacrifice it" may not sacrifice the Wraith). Sacrifice costs must be met by DISTINCT
 * permanents: two Altars cannot both sacrifice the one other creature. A plain source (Birds of
 * Paradise) may be one of them, since it is tapped for mana first; any other kept source may
 * not, since it must survive to be activated. Sources are kept in order while the kept set
 * stays jointly payable, so the result is deterministic.
 */
function jointlyPayableSources(
  ctx: GameContext,
  sources: readonly ManaSource[],
  reserved: ReadonlySet<string>,
): ManaSource[] {
  if (reserved.size === 0) return [...sources];
  const kept: ManaSource[] = [];
  let demands: SacrificeDemand[] = [];
  let unavailable = new Set(reserved);
  for (const source of sources) {
    const info = sacrificeDemandsOf(ctx, source);
    if (info === undefined) continue;
    if (unavailable.has(info.perm.id)) continue;
    const nextDemands = [...demands, ...info.demands];
    // A plain source is activated before any sacrifice (see `payManaCost`), so it can make its
    // mana and still be sacrificed afterwards. Any other kept source must survive to be used.
    const nextUnavailable = isPlainManaSource(source)
      ? unavailable
      : new Set([...unavailable, info.perm.id]);
    if (!demandsAllocatable(ctx, nextDemands, nextUnavailable)) continue;
    kept.push(source);
    demands = nextDemands;
    unavailable = nextUnavailable;
  }
  return kept;
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
): GameGen<{ spellCantBeCountered: boolean; treasureManaSpent: number; manaSpent: number }> {
  const excluded = new Set(excludedSourceCardIds);
  const sources = jointlyPayableSources(
    ctx,
    manaSourcesFor(ctx, player.id).filter((source) => !excluded.has(source.cardId)),
    reservedObjectIds,
  );
  const allows = allowanceFor(ctx, player.id, purpose);
  const plan = planPayment(cost, player.manaEntries, sources, allows, player.life);
  if (plan === null) {
    throw new Error(`engine bug: cost for ${player.id} became unpayable at application time`);
  }
  // Activate the sources in the order the plan gives them and add each one's production as it
  // goes, rather than tapping everything and then adding it all. The distinction is invisible
  // for a board of ordinary lands — the pool ends up identical — and load-bearing for a source
  // whose own activation costs mana, which can only be paid out of what earlier sources made.
  // With permanents reserved, plain sources go first: they depend on nothing, and once they
  // have made their mana they are fair game for a later sacrifice cost (`jointlyPayableSources`).
  const tapSources =
    reservedObjectIds.size === 0
      ? plan.tapSources
      : [
          ...plan.tapSources.filter(isPlainManaSource),
          ...plan.tapSources.filter((source) => !isPlainManaSource(source)),
        ];
  for (const [sourceIndex, source] of tapSources.entries()) {
    const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
    if (perm === undefined) throw new Error('engine bug: payment source vanished');
    // Read before the cost is paid: a Treasure's cost sacrifices it, so by the time its mana is
    // added the permanent is gone and its subtypes are unreadable.
    const fromTreasure = computeCharacteristics(ctx, perm).subtypes.includes('Treasure');
    // Riders on the mana ability itself — a painland's "deals 1 damage to you". Mana abilities
    // never use the stack (CR 605.3a), so this resolves immediately rather than being queued.
    // Applied BEFORE the cost, so a source that sacrifices itself still exists to do it.
    //
    // Only the ACTIVATED ability's rider fires. A permanent with several mana abilities has
    // several riders (Ancient Tomb's {C} costs nothing, its {C}{C} costs 2 life), and applying
    // every one of them would charge for abilities that were never used.
    for (const effect of source.onActivate ?? []) {
      applyManaRider(ctx, perm, player, effect);
    }
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
    // With permanents reserved, a sacrifice choice must also leave the reserved ones alone and
    // enough distinct permanents for the sources still to be activated after this one.
    const canSacrifice =
      reservedObjectIds.size === 0
        ? undefined
        : (candidate: EnginePermanent, remainingHere: number): boolean => {
            const own = sacrificeDemandsOf(ctx, source)?.demands ?? [];
            const laterSources = tapSources.slice(sourceIndex + 1);
            const later = laterSources.flatMap(
              (next) => sacrificeDemandsOf(ctx, next)?.demands ?? [],
            );
            // A source still to be activated must survive to make its mana; one already used
            // may be sacrificed.
            const laterPermanents = laterSources.flatMap((next) => {
              const permanent = sacrificeDemandsOf(ctx, next)?.perm;
              return permanent === undefined ? [] : [permanent.id];
            });
            const unavailable = new Set([...reservedObjectIds, ...laterPermanents]);
            return (
              !unavailable.has(candidate.id) &&
              demandsAllocatable(
                ctx,
                [...own.slice(0, remainingHere), ...later],
                new Set([...unavailable, candidate.id]),
              )
            );
          };
    yield* payAbilityCosts(
      ctx,
      player,
      perm,
      source.costs,
      'tapForMana',
      0,
      undefined,
      canSacrifice,
    );

    // Add exactly the mana the planner chose this source to produce — the SPECIFIC symbol per
    // unit (correct for multi-color sources, where the first symbol would mispay), carrying
    // whatever restriction, spend trigger and persistence the producing ability attaches.
    // Surplus floats.
    addMana(
      player,
      plan.produced
        .filter((p) => p.cardId === source.cardId)
        .map(({ symbol }) => ({
          symbol,
          ...(source.restriction !== undefined ? { restriction: source.restriction } : {}),
          ...(source.spendTrigger !== undefined ? { spendTrigger: source.spendTrigger } : {}),
          ...(source.uncounterableSpell === true ? { uncounterableSpell: true as const } : {}),
          ...(fromTreasure ? { fromTreasure: true as const } : {}),
          ...(source.persistent === true ? { persistent: true } : {}),
        })),
    );
  }

  // Spend specific entries, so the right spend triggers fire. Only mana this payment may
  // legally use is eligible — the pool can hold restricted mana that is not spendable here.
  const eligible = player.manaEntries.filter((e) => entryIsUsable(e, allows));
  const paidManaCost = plan.resolvedCost ?? cost;
  const spent = selectEntriesToSpend(eligible, paidManaCost);
  if (spent === null) {
    throw new Error(`engine bug: payment shortfall for ${player.id} after producing mana`);
  }
  removeMana(player, spent);
  if ((plan.lifePaid ?? 0) > 0) loseLife(ctx, player, plan.lifePaid ?? 0);

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
    manaSpent: totalPips(paidManaCost),
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
  /**
   * Whether a permanent may be chosen for a "sacrifice another" cost, given how many more this
   * cost still needs after it — a payment that reserves permanents for its other parts.
   */
  canSacrifice?: (candidate: EnginePermanent, remainingHere: number) => boolean,
): GameGen<{ stationPower?: number }> {
  let stationPower: number | undefined;
  for (const [costIndex, cost] of costs.entries()) {
    switch (cost.kind) {
      case 'tap':
        perm.tapped = true;
        queueTriggersForObject(ctx, 'becomesTapped', perm);
        emit(ctx, tapEvent, { name: perm.name, cardId: perm.cardId }, player.id);
        break;
      case 'tapOther': {
        const options = ctx.state.battlefield.filter(
          (candidate) =>
            candidate.id !== perm.id &&
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
              candidate.id !== perm.id &&
              candidate.controllerId === player.id &&
              !candidate.tapped &&
              matchesSelector(ctx, candidate, cost.selector, {
                cardId: perm.cardId,
                controllerId: player.id,
              }) &&
              (canTap?.(candidate, [
                { kind: 'tapOthers', selector: cost.selector, count: cost.count - i - 1 },
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
              (cost.allowSelf === true || candidate.id !== perm.id) &&
              candidate.controllerId === player.id &&
              matchesSelector(ctx, candidate, cost.selector, {
                cardId: perm.cardId,
                controllerId: player.id,
              }) &&
              (canSacrifice?.(candidate, count - i - 1) ?? true),
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
        const have = perm.counters[cost.counter] ?? 0;
        if (have < count) throw new Error('engine bug: counter cost became unpayable');
        perm.counters[cost.counter] = have - count;
        emit(
          ctx,
          'counters',
          {
            target: perm.name,
            targetCardId: perm.cardId,
            counter: cost.counter,
            added: -count,
            total: perm.counters[cost.counter],
          },
          player.id,
        );
        break;
      }
      case 'payLife':
        // CR 118.8: paying life is legal at any life total ≥ the amount, and the payment is not
        // damage — nothing replaces or prevents it.
        loseLife(ctx, player, cost.amount);
        break;
      case 'payLifeValue':
        loseLife(
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
        yield* discardCards(ctx, player, cost.count ?? 1);
        break;
      case 'exileCardFromHand':
        throw new Error('engine bug: exileCardFromHand is only supported for spell costs');
      case 'discardHand':
        yield* discardCards(ctx, player, player.hand.length);
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
    }
  }
  if (costs.some((c) => c.kind === 'sacrificeSelf')) {
    emit(ctx, 'sacrifice', { name: perm.name, cardId: perm.cardId }, player.id);
    yield* moveObject(ctx, perm, { zone: 'graveyard', reason: 'sacrifice' });
  } else if (costs.some((c) => c.kind === 'exileSelf')) {
    emit(ctx, 'exile', { target: perm.name, cardId: perm.cardId }, player.id);
    yield* moveObject(ctx, perm, { zone: 'exile' });
  }
  ctx.state.temporaryGraveyardAbilities = {};
  return stationPower === undefined ? {} : { stationPower };
}

/**
 * Apply a mana ability's `onActivate` rider — a painland's "This land deals 1 damage to you".
 *
 * Deliberately NOT `executeAbility`: a mana ability never uses the stack (CR 605.3a), so its
 * rider cannot target, cannot be responded to, and must not yield. Only the non-targeted,
 * non-generator ops are accepted; anything else throws rather than being silently skipped,
 * which would hand the player free mana (brief §6.3).
 */
export function applyManaRider(
  ctx: GameContext,
  perm: EnginePermanent,
  controller: EnginePlayerState,
  effect: Effect,
): void {
  const source = permanentSource(perm);
  switch (effect.op) {
    case 'damageController':
      dealDamageToPlayer(ctx, source, controller, effect.amount, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      });
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
      const count =
        typeof effect.count === 'number' ? effect.count : evaluateValue(ctx, effect.count);
      addCounters(ctx, source, perm, effect.counter, count);
      return;
    }
    default:
      throw new UnmodeledCardError(
        perm.name,
        [`mana ability rider "${effect.op}" cannot be applied without the stack`],
        'activating a mana ability',
      );
  }
}

/** Source descriptor for a permanent (combat damage, triggers). */
export function permanentSource(perm: EnginePermanent): EffectSource {
  return {
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
): { deathtouch: boolean; lifelink: boolean; infect: boolean; colors: Color[] } {
  return {
    deathtouch: hasKeyword(ctx, perm, 'deathtouch'),
    lifelink: hasKeyword(ctx, perm, 'lifelink'),
    infect: hasKeyword(ctx, perm, 'infect'),
    colors: colorsOf(ctx, perm),
  };
}

/** Convenience: definition lookup for a permanent. */
export function defOf(
  ctx: GameContext,
  perm: EnginePermanent,
): ReturnType<typeof getDefByOracleId> {
  return getDefByOracleId(ctx, perm.oracleId, perm.name);
}
