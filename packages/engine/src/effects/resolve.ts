/**
 * Effect resolution (brief §6.2): applying the mechanical outcome of `EffectSpec`s, plus
 * the shared damage/draw/life primitives used by combat and turn-based actions.
 */

import type { Color, ObjectId, PlayerId } from '@mtg/shared';
import { ALL_COLORS } from '@mtg/shared';
import { computeTargetOptions, isCreatureSpell, permanentMatchesKind } from '../actions/legal';
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
import { TAP_COST } from '../cards/definition';
import { evaluateCondition, isChoiceCondition, resolveCondition } from '../cards/condition';
import { selectMatches } from '../cards/selector';
import type { GameGen } from '../decisions';
import { UnmodeledCardError } from '../errors';
import { candidateOf, computeCharacteristics, matchesSelector, selectPermanents } from './continuous';
import { evaluateValueIn } from './values';
import type { Value, ValueScope } from '../cards/value';
import { evaluateValue } from '../cards/value';
import { canPay, describeManaCost, entryIsUsable, planPayment, withX } from '../mana/cost';
import type { ParsedManaCost } from '../mana/cost';
import { addMana, removeMana, selectEntriesToSpend } from '../mana/pool';
import type { ManaEntry, PaymentPurpose } from '../cards/ability';
import { debug, emit } from '../log/log';
import { cardOption, plainOption, playerOption, presentedSource, valueOption } from '../present';
import { chooseCard } from './choose';
import {
  applyCopy,
  createToken,
  makePermanent,
  moveObject,
  playerById,
  queueCastTriggers,
  queuePlayerTriggersForEvent,
  queueTriggersForEvent,
  queueTriggersForObject,
  spellManaValue,
  tokenSpecCopying,
} from '../state/objects';
import {
  allowanceFor,
  cardZoneCandidate,
  colorsOf,
  damageAmountAfterReplacements,
  damageMultiplierFor,
  effectivePT,
  findPermanent,
  getDefByOracleId,
  graveyardTargets,
  hasKeyword,
  hasProtectionFrom,
  manaRestrictionAllows,
  manaSourcesFor,
  opponentsOf,
  spellProtectedFromCounter,
} from '../state/queries';
import type {
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
  GameContext,
} from '../state/types';

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
  perm.goadedBy = [
    ...existing,
    { goaderId, appliedTurn: ctx.state.turnNumber },
  ];
}

/** Locate a physical card after a zone change, whose object id is deliberately no longer stable. */
function findObjectByCardId(ctx: GameContext, cardId: string): EngineObject | undefined {
  const foundStack = ctx.state.stack.find((object) => object.sourceCardId === cardId || object.card?.cardId === cardId);
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
    emit(ctx, 'damagePrevented', { source: source.name, target: target.name, amount, reason: 'combatShield' });
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

/** Deal damage from `source` to a player. Tracks commander combat damage (brief §5.7). */
export function dealDamageToPlayer(
  ctx: GameContext,
  source: EffectSource,
  target: EnginePlayerState,
  amount: number,
  opts: { combat: boolean; sourceIsCommander: boolean; sourceHasLifelink: boolean; sourceHasInfect?: boolean },
): void {
  if (amount <= 0) return;
  if (opts.combat && (ctx.state.combatDamagePrevention.all || ctx.state.combatDamagePrevention.players[target.id] === true)) {
    const tokenSpec = ctx.state.combatDamagePrevention.tokenSpecs?.[target.id];
    if (tokenSpec !== undefined) {
      for (let i = 0; i < amount; i++) createToken(ctx, tokenSpec, target.id);
    }
    emit(ctx, 'damagePrevented', { source: source.name, target: target.id, amount, reason: 'combatShield' });
    return;
  }
  // Damage-doubling replacement (CR 616 — Neriv, Heart of the Storm).
  amount = damageAmountAfterReplacements(ctx, source.cardId, target.id, amount);
  if (opts.sourceHasInfect === true) {
    target.poisonCounters += amount;
    emit(ctx, 'counters', { source: source.name, target: target.id, counter: 'poison', added: amount, total: target.poisonCounters }, source.controllerId);
  } else {
    target.life = ctx.state.lifeFloorPlayers[target.id] === true
      ? Math.max(1, target.life - amount)
      : target.life - amount;
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
}

/** Deal non-combat damage from `source` to whichever kind of object `id` names. */
function dealDamageToObject(
  ctx: GameContext,
  source: EffectSource,
  id: ObjectId,
  amount: number,
): void {
  const sourcePermanent = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
  const sourceHasInfect = sourcePermanent !== undefined && hasKeyword(ctx, sourcePermanent, 'infect');
  const sourceHasLifelink = sourcePermanent !== undefined && hasKeyword(ctx, sourcePermanent, 'lifelink');
  const sourceHasDeathtouch = sourcePermanent !== undefined && hasKeyword(ctx, sourcePermanent, 'deathtouch');
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
  // CR 120.3c: damage to a planeswalker removes that many loyalty counters instead of marking
  // damage — a planeswalker has no toughness to compare marked damage against.
  if (computeCharacteristics(ctx, perm).types.includes('Planeswalker')) {
    amount = damageAmountAfterReplacements(ctx, source.cardId, perm.controllerId, amount);
    const have = perm.counters['loyalty'] ?? 0;
    perm.counters['loyalty'] = Math.max(0, have - amount);
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
  player.life = ctx.state.lifeFloorPlayers[player.id] === true
    ? Math.max(1, player.life - amount)
    : player.life - amount;
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
        (perm) => perm.controllerId === player.id && ctx.defs.get(perm.oracleId)?.emptyLibraryCreatureReplacement === true,
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
    yield* moveObject(ctx, top, { zone: 'hand' });
    emit(ctx, 'draw', {
      player: player.id,
      cardId: top.cardId,
      name: top.name,
      isLand: getDefByOracleId(ctx, top.oracleId, top.name).types.includes('Land'),
    }, player.id);
  }
}

/** Discard N cards, one controller choice at a time (CR 701.8a). */
function* discardCards(ctx: GameContext, player: EnginePlayerState, count: number, excludeCardId?: string): GameGen<void> {
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
): GameGen<void> {
  for (const cost of costs) {
    switch (cost.kind) {
      case 'discardCard':
        yield* discardCards(ctx, player, cost.count ?? 1, sourceInHand ? sourceCardId : undefined);
        break;
      case 'sacrificeOther': {
        const count = cost.count ?? 1;
        for (let i = 0; i < count; i++) {
          const options = ctx.state.battlefield.filter((candidate) =>
            candidate.controllerId === player.id &&
            matchesSelector(ctx, candidate, cost.selector, { cardId: sourceCardId, controllerId: player.id }),
          );
          if (options.length === 0) throw new Error('engine bug: spell additional sacrifice cost became unpayable');
          const chosen = yield* chooseCard(ctx, {
            player: player.id,
            prompt: player.id + ': choose a permanent to sacrifice as a spell cost (' + (i + 1) + ' of ' + count + ').',
            cards: options,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (chosen === null) throw new Error('engine bug: spell additional sacrifice choice was invalid');
          const permanent = chosen as EnginePermanent;
          emit(ctx, 'sacrifice', { name: permanent.name, cardId: permanent.cardId }, player.id);
          yield* moveObject(ctx, permanent, { zone: 'graveyard' });
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
): boolean {
  const { kind, controller, filter } =
    typeof spec === 'string' ? { kind: spec, controller: undefined, filter: undefined } : spec;

  if (kind === 'spellOrNonlandPermanent') {
    const entry = ctx.state.stack.find((s) => s.id === targetId && s.kind === 'spell');
    if (entry !== undefined) return controller === undefined || (controller === 'you' ? entry.controllerId === spellControllerId : controller === 'opponent' ? entry.controllerId !== spellControllerId : entry.controllerId === eventPlayerId);
  }
  if (kind === 'spell' || kind === 'noncreatureSpell') {
    const entry = ctx.state.stack.find((s) => s.id === targetId && s.kind === 'spell');
    if (entry === undefined) return false;
    return kind !== 'noncreatureSpell' || !isCreatureSpell(ctx, entry);
  }
  if (kind === 'stackObject') return ctx.state.stack.some((entry) => entry.id === targetId);
  if (kind === 'commanderInCommandZone') {
    const player = playerById(ctx, spellControllerId);
    return player.commandZone.some((c) => (c.cardId === targetId || c.id === targetId) && c.isCommander);
  }
  if (kind === 'cardInGraveyard') {
    if (typeof spec === 'object' && spec.graveyardOwnerScope === 'any') {
      return ctx.state.players.some((player) => graveyardTargets(ctx, player.id, filter).some((c) => c.id === targetId));
    }
    return graveyardTargets(ctx, spellControllerId, filter).some((c) => c.id === targetId);
  }
  const player = ctx.state.players.find((p) => p.id === targetId);
  if (player !== undefined) {
    if (!(kind === 'anyTarget' || kind === 'player' || kind === 'playerOrPlaneswalker') || player.hasLost) return false;
    if (controller === 'you' && player.id !== spellControllerId) return false;
    if (controller === 'opponent' && player.id === spellControllerId) return false;
    if (controller === 'eventPlayer' && player.id !== eventPlayerId) return false;
    return true;
  }
  const perm = findPermanent(ctx, targetId);
  if (perm === undefined || !permanentMatchesKind(ctx, perm, kind === 'spellOrNonlandPermanent' ? 'nonlandPermanent' : kind)) return false;
  if (filter !== undefined && !matchesSelector(ctx, perm, filter, { cardId: '', controllerId: spellControllerId })) return false;
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
  const before = perm.counters[counter] ?? 0;
  perm.counters[counter] = (perm.counters[counter] ?? 0) + count;
  emit(ctx, 'counters', {
    source: source.name,
    target: perm.name,
    targetCardId: perm.cardId,
    counter,
    added: count,
    total: perm.counters[counter],
  });
  const def = ctx.defs.get(perm.oracleId);
  for (const threshold of def?.counterThresholdTriggers ?? []) {
    if (threshold.counter !== counter || before >= threshold.threshold || perm.counters[counter] < threshold.threshold) continue;
    ctx.state.pendingTriggers.push({
      controllerId: perm.controllerId,
      sourceCardId: perm.cardId,
      sourceOracleId: perm.oracleId,
      sourceName: perm.name,
      ability: threshold.ability,
    });
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
function affectedBy(ctx: GameContext, source: EffectSource, selector: Selector): EnginePermanent[] {
  return selectPermanents(ctx, selector, {
    cardId: source.cardId,
    controllerId: source.controllerId,
  });
}

/** "Grizzly Bears, Llanowar Elves get +3/+3 until end of turn" — the locked-in set, by name. */
function describeMassEffect(affected: EnginePermanent[], clause: string): string {
  return `${affected.map((p) => p.name).join(', ')} ${clause} until end of turn`;
}

/** Resolve a targetless card cast for a free-cast permission effect. */
function* resolveFreeCard(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
): GameGen<void> {
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  const isPermanent = def.types.some((type) => ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'].includes(type));
  const ability = def.spellAbility;
  const targetSlots = ability?.targets.map((spec) => ({ slot: 0, options: computeTargetOptions(ctx, spec, controllerId, def.colors) })) ?? [];
  if (targetSlots.some((slot) => slot.options.length === 0)) return;
  const targets: ObjectId[] = [];
  if (targetSlots.length > 0) {
    const outcome = yield {
      decisionType: 'chooseTargets',
      player: controllerId,
      prompt: `Choose targets for free-cast ${card.name}.`,
      options: [{
        type: 'chooseTargets',
        description: `Targets for ${card.name}`,
        targets: targetSlots.map((slot, index) => ({ slot: index, options: slot.options })),
        interaction: { kind: 'choice', targetSlots: targetSlots.map((slot, index) => ({ slot: index, options: slot.options })) },
      }],
    };
    for (let i = 0; i < targetSlots.length; i++) targets[i] = outcome.targets.get(i) ?? (targetSlots[i]?.options[0] as ObjectId);
  }
  const freeSpell: EngineStackObject = {
    id: `free-${ctx.state.nextObjectNum++}` as ObjectId,
    sourceId: card.id,
    controllerId,
    kind: 'spell',
    description: card.name,
    targets,
    card: null,
    ability,
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
    triggerScope: { manaSpent: 0 },
  };
  queueCastTriggers(ctx, freeSpell);
  if (isPermanent) {
    yield* moveObject(ctx, card, { zone: 'battlefield', controllerId });
    return;
  }
  if (ability === null) return;
  yield* executeAbility(ctx, {
    cardId: card.cardId,
    name: card.name,
    oracleId: card.oracleId,
    controllerId,
  }, ability, targets);
  yield* moveObject(ctx, card, { zone: 'graveyard' });
}

function freeCardIsCastable(ctx: GameContext, card: EngineCardObject, controllerId: PlayerId): boolean {
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  if (def.types.some((type) => ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'].includes(type))) return true;
  if (def.spellAbility === null) return false;
  return def.spellAbility.targets.every((spec) => computeTargetOptions(ctx, spec, controllerId, def.colors).length > 0);
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

  const scope: ValueScope = {
    controllerId: source.controllerId,
    sourceCardId: source.cardId,
    ...(targets !== undefined ? { targets } : {}),
    ...(triggerObjectCardId !== undefined ? { triggerObjectCardId } : {}),
    ...(extraScope ?? {}),
  };
  /** Evaluate an effect's `Value` amount in this ability's scope. */
  const amountOf = (value: Value | number): number =>
    typeof value === 'number' ? value : evaluateValueIn(ctx, value, scope);

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

  /** Resolve an effect referent to an object id, or null when it is gone / no longer legal. */
  const ref = (r: EffectRef): ObjectId | null => {
    if (r === 'source') {
      return ctx.state.battlefield.find((p) => p.cardId === source.cardId)?.id ?? null;
    }
    if (r === 'eventPlayer') {
      return (scope.eventPlayerId as unknown as ObjectId | undefined) ?? null;
    }
    if (r === 'attachedToSource') {
      const sourcePermanent = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      if (sourcePermanent === undefined || sourcePermanent.attachedTo === null) return null;
      return findPermanent(ctx, sourcePermanent.attachedTo)?.id ?? null;
    }
    if (r === 'triggerObject') {
      if (triggerObjectCardId === undefined) {
        throw new Error(`engine bug: ${source.name} used 'triggerObject' with no trigger object`);
      }
      // Gone from the battlefield by resolution: the effect simply does nothing to it.
      const perm = ctx.state.battlefield.find((p) => p.cardId === triggerObjectCardId);
      if (perm === undefined) {
        debug(ctx, 'effect', `${source.name}: trigger object has left the battlefield — skipped`);
        return null;
      }
      return perm.id;
    }
    const cachedCardId = refCardIdCache.get(r);
    if (cachedCardId !== undefined) {
      return cachedCardId === null ? null : (findObjectByCardId(ctx, cachedCardId)?.id ?? null);
    }
    const id = targets[r];
    const spec = ability.targets[r];
    if (id === undefined || spec === undefined) {
      refCardIdCache.set(r, null);
      return null;
    }
    if (!isTargetStillLegal(ctx, id, spec, source.controllerId, undefined, scope.eventPlayerId)) {
      debug(ctx, 'effect', `${source.name}: target ${id} illegal — skipped`);
      refCardIdCache.set(r, null);
      return null;
    }
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

  for (const effect of (ability.effects ?? [])) {
    switch (effect.op) {
      case 'chooseOne': {
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: choose one.`,
          options: effect.options.map((option) => ({ type: 'chooseEffect', description: option.description })),
        };
        const chosen = effect.options[outcome.index] ?? effect.options[0];
        if (chosen !== undefined) {
          yield* executeAbility(ctx, source, { ...ability, effects: chosen.effects }, targets, triggerObjectCardId, extraScope, countTargets, divisionAmounts);
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
        const perm = findPermanent(ctx, t) as EnginePermanent;
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
        const perm = findPermanent(ctx, t) as EnginePermanent;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} can't be blocked this turn`,
          targetCardIds: [perm.cardId],
          kind: 'cantBeBlocked',
          timestamp: ctx.state.nextTimestamp++,
        });
        break;
      }      case 'grantKeywordUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
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
        const affected = affectedBy(ctx, source, effect.selector);
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
      }      case 'grantKeywordEachUntilEot': {
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
      case 'dealDamage': {
        const t = ref(effect.target);
        if (t === null) break;
        dealDamageToObject(ctx, source, t, amountOf(effect.amount));
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
          (p) => p.controllerId === targetPlayer.id && computeCharacteristics(ctx, p).types.includes('Creature'),
        );
        let sacrificed = false;
        if (creatures.length > 0) {
          const outcome = yield {
            decisionType: 'general',
            player: targetPlayer.id,
            prompt: `${source.name} deals ${amount} damage to you unless you sacrifice a creature. Sacrifice a creature?`,
            options: [
              ...creatures.map((c) => ({ type: 'sacrifice', description: `Sacrifice ${c.name}`, payload: c.id })),
              { type: 'decline', description: `Don't sacrifice (take ${amount} damage)` },
            ],
          };
          if (outcome.index < creatures.length) {
            const chosen = creatures[outcome.index] as EnginePermanent;
            emit(ctx, 'sacrifice', { name: chosen.name, cardId: chosen.cardId }, targetPlayer.id);
            yield* moveObject(ctx, chosen, { zone: 'graveyard' });
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
          if (spec === undefined || !isTargetStillLegal(ctx, id, spec, source.controllerId)) {
            continue;
          }
          dealDamageToObject(ctx, source, id, amount);
        }
        break;
      }
      case 'putCountersEachChosen': {
        const spec = ability.targets[effect.targetSlot];
        const count = amountOf(effect.count);
        for (const id of countTargets?.[effect.targetSlot] ?? []) {
          if (spec === undefined || !isTargetStillLegal(ctx, id, spec, source.controllerId)) {
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
          if (spec === undefined || !isTargetStillLegal(ctx, id, spec, source.controllerId)) {
            continue;
          }
          const perm = findPermanent(ctx, id);
          if (perm === undefined) continue;
          emit(ctx, 'exile', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'exile' });
        }
        break;
      }
      case 'exileTargetGraveyardAndBuffIfCreature': {
        const targetId = scope.targets?.[effect.targetSlot];
        if (!targetId) break;
        let cardObj: any = null;
        let cardOwner: any = null;
        for (const p of ctx.state.players) {
          const idx = p.graveyard.findIndex((c) => c.cardId === targetId || String(c.id) === targetId);
          if (idx !== -1) {
            cardObj = p.graveyard[idx];
            cardOwner = p;
            p.graveyard.splice(idx, 1);
            break;
          }
        }
        if (!cardObj || !cardOwner) break;
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
        const targetPlayerId = scope.targets?.[effect.targetSlot] as any;
        if (!targetPlayerId) break;
        const targetCardIds = ctx.state.battlefield
          .filter(
            (perm) =>
              perm.controllerId === targetPlayerId && computeCharacteristics(ctx, perm).types.includes('Creature'),
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
            prompt: 'May search your library for a basic land card, put that card onto the battlefield tapped, then shuffle',
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
          (p) => p.controllerId === source.controllerId && p.isToken && computeCharacteristics(ctx, p).types.includes('Creature')
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
          createToken(ctx, {
            name: chosenToken.name,
            typeLine: chosenToken.typeLine,
            types: chars.types,
            subtypes: chars.subtypes,
            colors: chars.colors,
            power: chars.power,
            toughness: chars.toughness,
            keywords: chars.keywords,
          }, source.controllerId);
        }
        break;
      }
      case 'untapAttackingPlayerNonlandPermanents': {
        const attackingPlayerId = scope.eventPlayerId ?? scope.controllerId;
        for (const perm of ctx.state.battlefield) {
          if (perm.controllerId === attackingPlayerId && !computeCharacteristics(ctx, perm).types.includes('Land')) {
            perm.tapped = false;
          }
        }
        break;
      }
      case 'untapTargetPlayerCreatures': {
        const targetPlayerId = scope.targets?.[effect.targetSlot] as any;
        if (!targetPlayerId) break;
        for (const perm of ctx.state.battlefield) {
          if (perm.controllerId === targetPlayerId && computeCharacteristics(ctx, perm).types.includes('Creature')) {
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
          if (spec === undefined || !isTargetStillLegal(ctx, id, spec, source.controllerId)) {
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
          if (spec === undefined || !isTargetStillLegal(ctx, id, spec, source.controllerId)) {
            continue;
          }
          dealDamageToObject(ctx, source, id, amount);
        }
        break;
      }
      case 'destroy': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        if (hasKeyword(ctx, perm, 'indestructible')) {
          debug(ctx, 'effect', `${perm.name} is indestructible — destroy has no effect`);
          emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
        } else {
          emit(ctx, 'destroy', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'graveyard' });
        }
        break;
      }
      case 'destroyAndCreateTokenForController': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t);
        if (perm === undefined) break;
        const targetControllerId = perm.controllerId;
        if (hasKeyword(ctx, perm, 'indestructible')) {
          debug(ctx, 'effect', perm.name + ' is indestructible � destroy has no effect');
          emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
        } else {
          emit(ctx, 'destroy', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'graveyard' });
        }
        for (let i = 0; i < amountOf(effect.count); i++) createToken(ctx, effect.spec, targetControllerId);
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
        const tokenCount = spellManaValue(getDefByOracleId(ctx, perm.oracleId, perm.name), undefined);
        if (hasKeyword(ctx, perm, 'indestructible')) {
          debug(ctx, 'effect', perm.name + ' is indestructible � destroy has no effect');
          emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
        } else {
          emit(ctx, 'destroy', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'graveyard' });
        }
        for (let i = 0; i < tokenCount; i++) createToken(ctx, effect.spec, controller.id);
        break;
      }
      case 'destroyEach': {
        // The affected set is fixed here (CR 611.2c), mirroring `damageEach`/`putCountersEach`.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          if (hasKeyword(ctx, perm, 'indestructible')) {
            debug(ctx, 'effect', `${perm.name} is indestructible — destroy has no effect`);
            emit(ctx, 'destroyPrevented', { target: perm.name, source: source.name });
            continue;
          }
          emit(ctx, 'destroy', { target: perm.name, source: source.name });
          yield* moveObject(ctx, perm, { zone: 'graveyard' });
        }
        break;
      }
      case 'exileTargetPlayerGraveyard': {
        const targetId = ref(effect.target);
        if (targetId === null) break;
        const player = ctx.state.players.find((candidate) => candidate.id === targetId);
        if (player === undefined) break;
        for (const card of [...player.graveyard]) yield* moveObject(ctx, card, { zone: 'exile' });
        break;
      }
      case 'exileEachOpponentGraveyard': {
        for (const opponent of opponentsOf(ctx, source.controllerId)) {
          for (const card of [...opponent.graveyard]) yield* moveObject(ctx, card, { zone: 'exile' });
        }
        break;
      }
      case 'exile': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'exile' });
        break;
      }
      case 'exileCard': {
        const t = ref(effect.target);
        if (t === null) break;
        const card = findObjectById(ctx, t);
        if (card !== undefined && card.zone === 'graveyard') yield* moveObject(ctx, card, { zone: 'exile' });
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
          emit(ctx, 'counterSpell', { countered: countered.description, by: source.name });
          debug(ctx, 'stack', `${countered.description} countered by ${source.name}`);
          if (countered.card !== null) {
            yield* moveObject(ctx, countered.card, { zone: 'graveyard' });
          }
        }
        break;
      }
      case 'sacrifice': {
        const t = ref(effect.target);
        const perm = t === null ? undefined : findPermanent(ctx, t);
        if (perm !== undefined) yield* moveObject(ctx, perm, { zone: 'graveyard' });
        break;
      }
      case 'gainControlTarget': {
        const t = ref(effect.target);
        const perm = t === null ? undefined : findPermanent(ctx, t);
        if (perm !== undefined && perm.controllerId !== source.controllerId) {
          perm.controllerId = source.controllerId;
          perm.timestamp = ctx.state.nextTimestamp++;
          perm.summoningSick = true;
          emit(ctx, 'gainControl', { source: source.name, target: perm.name, newController: source.controllerId });
        }
        break;
      }
      case 'putCounters': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        addCounters(ctx, source, perm, effect.counter, amountOf(effect.count));
        break;
      }
      case 'putCounterByPermanentType': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        const isPlaneswalker = computeCharacteristics(ctx, perm).types.includes('Planeswalker');
        addCounters(ctx, source, perm, isPlaneswalker ? effect.planeswalkerCounter : effect.creatureCounter, amountOf(effect.count));
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
        const players = effect.target === 'eachOpponent'
          ? opponentsOf(ctx, controller.id)
          : (() => {
              const id = ref(effect.target);
              const player = id === null ? undefined : ctx.state.players.find((p) => p.id === id);
              return player === undefined ? [] : [player];
            })();
        for (const player of players) {
          player.poisonCounters += count;
          emit(ctx, 'counters', { source: source.name, target: player.id, counter: 'poison', added: count, total: player.poisonCounters }, controller.id);
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
          emit(ctx, 'energy', { player: controller.id, amount, total: controller.energy }, controller.id);
        }
        break;
      }      case 'mill': {
        const count = amountOf(effect.count);
        for (let i = 0; i < count; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          yield* moveObject(ctx, top, { zone: 'graveyard' });
          emit(ctx, 'mill', { player: controller.id, cardId: top.cardId, name: top.name }, controller.id);
        }
        break;
      }      case 'draw':
        yield* drawCards(ctx, controller, amountOf(effect.count));
        break;
      case 'discard':
        yield* discardCards(ctx, controller, effect.count);
        break;
      case 'gainLife':
        gainLife(ctx, controller, amountOf(effect.amount));
        break;
      case 'loseLife':
        loseLife(ctx, controller, amountOf(effect.amount));
        break;
      case 'eachOpponentLosesLife':
        for (const opp of opponentsOf(ctx, controller.id)) {
          loseLife(ctx, opp, amountOf(effect.amount));
        }
        break;
      case 'loseLifeTarget': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
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
        dealDamageToPlayer(ctx, source, playerById(ctx, target.controllerId), effectivePT(ctx, target).power, {
          combat: false,
          sourceIsCommander: false,
          sourceHasLifelink: false,
        });
        break;
      }
      case 'drawForEachOpponent':
        for (const opponent of opponentsOf(ctx, controller.id)) yield* drawCards(ctx, opponent, 1);
        yield* drawCards(ctx, controller, opponentsOf(ctx, controller.id).length);
        break;
      case 'drawTargetAndController': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        yield* drawCards(ctx, target, 1);
        yield* drawCards(ctx, controller, 1);
        break;
      }
      case 'drawTargetAndControllerN': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        yield* drawCards(ctx, target, effect.count);
        yield* drawCards(ctx, controller, effect.count);
        break;
      }
      case 'drawTarget': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        yield* drawCards(ctx, target, amountOf(effect.count));
        break;
      }
      case 'breenaAttack': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const attacker = scope.eventPlayerId === undefined ? controller : playerById(ctx, scope.eventPlayerId);
        yield* drawCards(ctx, attacker, 1);
        addCounters(ctx, source, target, '+1/+1', 2);
        break;
      }
      case 'schemingSymmetry': {
        for (const slot of [0, 1]) {
          const targetId = ref(slot);
          const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
          if (target === undefined || target.library.length === 0) continue;
          const chosen = yield* chooseCard(ctx, { player: target.id, prompt: `${source.name}: choose a card to put on top of your library`, cards: target.library, type: 'search', verb: 'Choose' });
          if (chosen !== null) yield* moveObject(ctx, chosen, { zone: 'library', libraryPosition: 'top' });
        }
        break;
      }
      case 'sacrificePermanentOnDamage': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const permanents = ctx.state.battlefield.filter((perm) => perm.controllerId === target.id);
        const chosen = yield* chooseCard(ctx, { player: target.id, prompt: `${source.name}: sacrifice a permanent`, cards: permanents, type: 'sacrifice', verb: 'Sacrifice' });
        if (chosen !== null) yield* moveObject(ctx, chosen, { zone: 'graveyard' });
        break;
      }
      case 'kambal': {
        const caster = scope.eventPlayerId === undefined ? undefined : playerById(ctx, scope.eventPlayerId);
        if (caster === undefined) break;
        loseLife(ctx, caster, 2);
        gainLife(ctx, controller, 2);
        break;
      }
      case 'kambal': {
        const caster = scope.eventPlayerId === undefined ? undefined : playerById(ctx, scope.eventPlayerId);
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
          ability: { kind: 'triggered', targets: [], effects: [{ op: 'arcbondDamage' }], description: 'That creature deals that much damage to each other creature and each player' },
          expiry: 'cleanup',
        });
        break;
      }
      case 'arcbondDamage': {
        const amount = amountOf({ kind: 'damageDealt' });
        const trigger = triggerObjectCardId === undefined ? undefined : findPermanent(ctx, triggerObjectCardId);
        for (const creature of ctx.state.battlefield.filter((perm) => computeCharacteristics(ctx, perm).types.includes('Creature') && perm.cardId !== trigger?.cardId)) {
          dealDamageToCreature(ctx, source, creature, amount, { combat: false, sourceHasDeathtouch: false, sourceHasLifelink: false });
        }
        for (const player of ctx.state.players.filter((p) => !p.hasLost)) {
          dealDamageToPlayer(ctx, source, player, amount, { combat: false, sourceIsCommander: false, sourceHasLifelink: false });
        }
        break;
      }
      case 'combatCalligrapher': {
        const attackingPlayerId = scope.eventPlayerId ?? (triggerObjectCardId === undefined ? undefined : findPermanent(ctx, triggerObjectCardId)?.controllerId);
        const attacker = triggerObjectCardId === undefined ? undefined : findPermanent(ctx, triggerObjectCardId);
        if (attackingPlayerId === undefined || attacker?.attacking === null || attacker?.attacking === undefined) break;
        const token = createToken(ctx, { name: 'Inkling', typeLine: 'Creature — Inkling', types: ['Creature'], subtypes: ['Inkling'], colors: ['W', 'B'], power: 2, toughness: 1, keywords: ['flying'] }, attackingPlayerId);
        token.tapped = true;
        token.attacking = attacker.attacking;
        token.statuses.push('attacking');
        break;
      }
      case 'inkshield':
        ctx.state.combatDamagePrevention.players[controller.id] = true;
        if (ctx.state.combatDamagePrevention.tokenSpecs === undefined) ctx.state.combatDamagePrevention.tokenSpecs = {};
        ctx.state.combatDamagePrevention.tokenSpecs[controller.id] = { name: 'Inkling', typeLine: 'Creature — Inkling', types: ['Creature'], subtypes: ['Inkling'], colors: ['W', 'B'], power: 2, toughness: 1, keywords: ['flying'] };
        break;
      case 'delirium': {
        const targetId = ref(0);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        target.tapped = true;
        queueTriggersForObject(ctx, 'becomesTapped', target);
        dealDamageToPlayer(ctx, source, playerById(ctx, target.controllerId), effectivePT(ctx, target).power, { combat: false, sourceIsCommander: false, sourceHasLifelink: false });
        ctx.state.combatDamagePrevention.players[target.controllerId] = true;
        break;
      }
      case 'deflectingPalm':
        ctx.state.combatDamagePrevention.players[controller.id] = true;
        break;
      case 'gisela':
        emit(ctx, 'damageReplacement', { source: source.name, rule: 'double damage to opponents; prevent half damage to controller' });
        break;
      case 'humbleDefector': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        const permanent = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
        if (target === undefined || permanent === undefined) break;
        yield* drawCards(ctx, controller, 2);
        permanent.controllerId = target.id;
        permanent.timestamp = ctx.state.nextTimestamp++;
        break;
      }
      case 'shadrixModes': {
        const players = ctx.state.players.filter((p) => !p.hasLost);
        const choosePlayer = function* (prompt: string, excluded: PlayerId | undefined): GameGen<PlayerId> {
          const eligible = players.filter((p) => p.id !== excluded);
          const outcome = yield { decisionType: 'general', player: controller.id, prompt, options: eligible.map((p) => ({ type: 'choosePlayer', description: p.id, payload: p.id })) };
          return eligible[outcome.index]?.id ?? eligible[0]?.id ?? controller.id;
        };
        const first = yield { decisionType: 'general', player: controller.id, prompt: `${source.name}: choose the first mode`, options: [{ type: 'token', description: 'Target player creates an Inkling' }, { type: 'draw', description: 'Target player draws a card and loses 1 life' }, { type: 'counter', description: 'Target player puts a +1/+1 counter on each creature they control' }] };
        const firstPlayer = yield* choosePlayer(`${source.name}: choose the first target player`, undefined);
        const second = yield { decisionType: 'general', player: controller.id, prompt: `${source.name}: choose the second mode`, options: [{ type: 'token', description: 'Target player creates an Inkling' }, { type: 'draw', description: 'Target player draws a card and loses 1 life' }, { type: 'counter', description: 'Target player puts a +1/+1 counter on each creature they control' }] };
        const secondPlayer = yield* choosePlayer(`${source.name}: choose the second target player`, firstPlayer);
        for (const [mode, playerId] of [[first.index, firstPlayer], [second.index, secondPlayer]] as [number, PlayerId][]) {
          const player = playerById(ctx, playerId);
          if (mode === 0) createToken(ctx, { name: 'Inkling', typeLine: 'Creature — Inkling', types: ['Creature'], subtypes: ['Inkling'], colors: ['W', 'B'], power: 2, toughness: 1, keywords: ['flying'] }, player.id);
          else if (mode === 1) { yield* drawCards(ctx, player, 1); loseLife(ctx, player, 1); }
          else for (const perm of ctx.state.battlefield.filter((p) => p.controllerId === player.id && computeCharacteristics(ctx, p).types.includes('Creature'))) addCounters(ctx, source, perm, '+1/+1', 1);
        }
        break;
      }
      case 'masterOfCeremonies': {
        for (const opponent of opponentsOf(ctx, controller.id)) {
          const outcome = yield { decisionType: 'general', player: opponent.id, prompt: `${source.name}: choose money, friends, or secrets`, options: [{ type: 'money', description: 'Money' }, { type: 'friends', description: 'Friends' }, { type: 'secrets', description: 'Secrets' }] };
          if (outcome.index === 0) { createToken(ctx, { name: 'Treasure', typeLine: 'Artifact — Treasure', types: ['Artifact'], subtypes: ['Treasure'], colors: [], power: null, toughness: null, manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']] }] }, controller.id); createToken(ctx, { name: 'Treasure', typeLine: 'Artifact — Treasure', types: ['Artifact'], subtypes: ['Treasure'], colors: [], power: null, toughness: null, manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']] }] }, opponent.id); }
          else if (outcome.index === 1) { createToken(ctx, { name: 'Citizen', typeLine: 'Creature — Citizen', types: ['Creature'], subtypes: ['Citizen'], colors: ['G', 'W'], power: 1, toughness: 1 }, controller.id); createToken(ctx, { name: 'Citizen', typeLine: 'Creature — Citizen', types: ['Creature'], subtypes: ['Citizen'], colors: ['G', 'W'], power: 1, toughness: 1 }, opponent.id); }
          else { yield* drawCards(ctx, controller, 1); yield* drawCards(ctx, opponent, 1); }
        }
        break;
      }
      case 'dealDamageNonbasicLands': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const amount = ctx.state.battlefield.filter((perm) => {
          if (perm.controllerId !== target.id) return false;
          const chars = computeCharacteristics(ctx, perm);
          return chars.types.includes('Land') && !chars.supertypes.includes('Basic');
        }).length;
        dealDamageToPlayer(ctx, source, target, amount, { combat: false, sourceIsCommander: false, sourceHasLifelink: false });
        break;
      }
      case 'sacrificeOneEachOpponent':
        for (const opponent of opponentsOf(ctx, controller.id)) {
          const permanents = ctx.state.battlefield.filter((perm) => {
            if (perm.controllerId !== opponent.id) return false;
            if (effect.filter === 'creature') return computeCharacteristics(ctx, perm).types.includes('Creature');
            return !computeCharacteristics(ctx, perm).types.includes('Land');
          });
          const chosen = yield* chooseCard(ctx, {
            player: opponent.id,
            prompt: `${source.name}: choose a ${effect.filter === 'creature' ? 'creature' : 'nonland permanent'} to sacrifice`,
            cards: permanents,
            type: 'sacrifice',
            verb: 'Sacrifice',
          });
          if (chosen !== null) yield* moveObject(ctx, chosen, { zone: 'graveyard' });
        }
        break;
      case 'sacrificeEachPlayer':
        for (const player of ctx.state.players.filter((p) => !p.hasLost)) {
          for (let i = 0; i < effect.count; i++) {
            const candidates = ctx.state.battlefield.filter((perm) => perm.controllerId === player.id && (effect.filter === 'any' || computeCharacteristics(ctx, perm).types.includes('Creature')));
            if (candidates.length === 0) break;
            const chosen = yield* chooseCard(ctx, {
              player: player.id,
              prompt: `${source.name}: choose a ${effect.filter === 'any' ? 'permanent' : 'creature'} to sacrifice (${i + 1} of ${effect.count})`,
              cards: candidates,
              type: 'sacrifice',
              verb: 'Sacrifice',
            });
            if (chosen === null) break;
            yield* moveObject(ctx, chosen, { zone: 'graveyard' });
          }
        }
        break;
      case 'sacrificeAndDrawForPower': {
        const candidates = ctx.state.battlefield.filter((perm) => perm.controllerId === controller.id && perm.cardId !== source.cardId && computeCharacteristics(ctx, perm).types.includes('Creature'));
        const chosen = yield* chooseCard(ctx, {
          player: controller.id,
          prompt: `${source.name}: sacrifice another creature`,
          cards: candidates,
          type: 'sacrifice',
          verb: 'Sacrifice',
        });
        if (chosen !== null) {
          const power = effectivePT(ctx, chosen as EnginePermanent).power;
          yield* moveObject(ctx, chosen, { zone: 'graveyard' });
          gainLife(ctx, controller, power);
          yield* drawCards(ctx, controller, power);
        }
        break;
      }
      case 'sacrificeGreatestEachOpponent': {
        const metricOf = (perm: EnginePermanent): number =>
          effect.metric === 'power' ? effectivePT(ctx, perm).power : spellManaValue(getDefByOracleId(ctx, perm.oracleId, perm.name), undefined);
        for (const opponent of opponentsOf(ctx, controller.id)) {
          const candidates = ctx.state.battlefield.filter((perm) => perm.controllerId === opponent.id && (() => {
            const chars = computeCharacteristics(ctx, perm);
            return chars.types.includes('Creature') || (effect.selector === 'creatureOrPlaneswalker' && chars.types.includes('Planeswalker'));
          })());
          const greatest = Math.max(0, ...candidates.map((perm) => metricOf(perm)));
          const choices = candidates.filter((perm) => metricOf(perm) === greatest);
          const metricLabel = effect.metric === 'power' ? 'power' : 'mana value';
          const verb = effect.action === 'exile' ? 'Exile' : 'Sacrifice';
          const chosen = yield* chooseCard(ctx, { player: opponent.id, prompt: `${source.name}: ${verb.toLowerCase()} a permanent with the greatest ${metricLabel}`, cards: choices, type: 'sacrifice', verb });
          if (chosen !== null) yield* moveObject(ctx, chosen, { zone: effect.action === 'exile' ? 'exile' : 'graveyard' });
        }
        break;
      }
      case 'transferCountersFromTriggerObject': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        const trigger = triggerObjectCardId === undefined ? undefined : findObjectByCardId(ctx, triggerObjectCardId);
        const counters = (trigger as any)?.rememberedCounters as Record<string, number> | undefined;
        if (target !== undefined && counters !== undefined) {
          for (const [counter, count] of Object.entries(counters)) target.counters[counter] = (target.counters[counter] ?? 0) + count;
        }
        break;
      }
      case 'mayPayLifeForTriggerPowerAndCounter': {
        const entering = triggerObjectCardId === undefined ? undefined : findPermanent(ctx, triggerObjectCardId);
        if (entering === undefined || entering.controllerId !== controller.id) break;
        const power = effectivePT(ctx, entering).power;
        const outcome = yield {
          decisionType: 'general', player: controller.id,
          prompt: `${source.name}: pay ${power} life to put ${power} +1/+1 counter(s) on ${entering.name}?`,
          options: [
            { type: 'payLife', description: `Pay ${power} life and add ${power} counter(s)` },
            { type: 'decline', description: 'Decline' },
          ],
        };
        if (outcome.index === 0) {
          loseLife(ctx, controller, power);
          entering.counters['+1/+1'] = (entering.counters['+1/+1'] ?? 0) + power;
        }
        break;
      }
      case 'vindictiveLichModes': {
        const mode = yield {
          decisionType: 'general', player: controller.id,
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
          decisionType: 'general', player: controller.id,
          prompt: `${source.name}: choose the opponent`,
          options: opponents.map((p) => playerOption(p.id, p.id, { type: 'choosePlayer', description: p.id, payload: p.id, verb: 'Choose' })),
        };
        const opponent = opponents[selectedOpponent.index] ?? opponents[0]!;
        if (mode.index === 0) {
          const creatures = ctx.state.battlefield.filter((perm) => perm.controllerId === opponent.id && computeCharacteristics(ctx, perm).types.includes('Creature'));
          const chosen = yield* chooseCard(ctx, { player: opponent.id, prompt: `${source.name}: choose a creature to sacrifice`, cards: creatures, type: 'sacrifice', verb: 'Sacrifice' });
          if (chosen !== null) yield* moveObject(ctx, chosen, { zone: 'graveyard' });
        } else if (mode.index === 1) {
          yield* discardCards(ctx, opponent, 2);
        } else {
          loseLife(ctx, opponent, 5);
        }
        break;
      }
      case 'returnExiledAttachedCard': {
        const card = ctx.state.exile.find((candidate) => candidate.attachedToCardId === source.cardId);
        if (card !== undefined) {
          delete card.attachedToCardId;
          yield* moveObject(ctx, card, { zone: 'hand' });
        }
        break;
      }
      case 'sacrificeOneCreatureEachPlayer':
        for (const player of ctx.state.players.filter((p) => !p.hasLost)) {
          const creatures = ctx.state.battlefield.filter((perm) => perm.controllerId === player.id && computeCharacteristics(ctx, perm).types.includes('Creature'));
          const chosen = yield* chooseCard(ctx, { player: player.id, prompt: `${source.name}: choose a creature to sacrifice`, cards: creatures, type: 'sacrifice', verb: 'Sacrifice' });
          if (chosen !== null) yield* moveObject(ctx, chosen, { zone: 'graveyard' });
        }
        break;
      case 'sacrificeOtherForMana': {
        const candidates = ctx.state.battlefield.filter((perm) => perm.controllerId === controller.id && perm.cardId !== source.cardId && computeCharacteristics(ctx, perm).types.includes('Creature'));
        const chosen = yield* chooseCard(ctx, { player: controller.id, prompt: `${source.name}: sacrifice another creature`, cards: candidates, type: 'sacrifice', verb: 'Sacrifice' });
        if (chosen !== null) {
          const value = spellManaValue(getDefByOracleId(ctx, chosen.oracleId, chosen.name), undefined);
          yield* moveObject(ctx, chosen, { zone: 'graveyard' });
          for (let i = 0; i < value; i++) controller.manaEntries.push({ symbol: 'B' });
          controller.manaPool.B = (controller.manaPool.B ?? 0) + value;
        }
        break;
      }
      case 'livingDeath': {
        const returning: EngineCardObject[] = [];
        for (const player of ctx.state.players) {
          const creatures = player.graveyard.filter((card) => getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Creature'));
          for (const card of creatures) {
            const moved = yield* moveObject(ctx, card, { zone: 'exile' });
            if (moved !== null && moved.zone !== 'battlefield') returning.push(moved as EngineCardObject);
          }
        }
        for (const perm of [...ctx.state.battlefield]) {
          if (computeCharacteristics(ctx, perm).types.includes('Creature')) yield* moveObject(ctx, perm, { zone: 'graveyard' });
        }
        for (const card of returning) {
          const current = ctx.state.exile.find((candidate) => candidate.cardId === card.cardId);
          if (current !== undefined) yield* moveObject(ctx, current, { zone: 'battlefield', controllerId: current.ownerId });
        }
        break;
      }
      case 'exileGraveyardCreateTokens': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const cards = [...target.graveyard];
        const count = cards.filter((card) => {
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          return def.types.includes('Artifact') || def.types.includes('Land');
        }).length;
        for (const card of cards) yield* moveObject(ctx, card, { zone: 'exile' });
        for (let i = 0; i < count; i++) createToken(ctx, effect.spec, controller.id);
        break;
      }
      case 'millAndCreateTokensForCreatures': {
        let creatureCount = 0;
        for (let i = 0; i < 3; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          if (getDefByOracleId(ctx, top.oracleId, top.name).types.includes('Creature')) creatureCount++;
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
            return def.types.includes('Artifact') && def.types.includes('Creature') && spellManaValue(def, undefined) <= remaining;
          });
          if (choices.length === 0) break;
          const chosen = yield* chooseCard(ctx, { player: controller.id, prompt: `${source.name}: return an artifact creature (up to ${remaining} mana value)`, cards: choices, type: 'returnToBattlefield', verb: 'Return', decline: { type: 'decline', description: 'Return no more cards', verb: 'Done' } });
          if (chosen === null) break;
          remaining -= spellManaValue(getDefByOracleId(ctx, chosen.oracleId, chosen.name), undefined);
          yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: controller.id });
        }
        break;
      }
      case 'halfLifeDrainTargetOpponent': {
        const opponents = opponentsOf(ctx, controller.id);
        if (opponents.length === 0) break;
        const selected = yield {
          decisionType: 'general', player: controller.id, prompt: `${source.name}: choose an opponent`,
          options: opponents.map((p) => playerOption(p.id, p.id, { type: 'choosePlayer', description: p.id, payload: p.id, verb: 'Choose' })),
        };
        const opponent = opponents[selected.index] ?? opponents[0]!;
        const lost = Math.ceil(Math.max(0, opponent.life) / 2);
        loseLife(ctx, opponent, lost);
        gainLife(ctx, controller, lost);
        break;
      }
      case 'tombBladeHit': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        const creatures = ctx.state.battlefield.filter((perm) => perm.controllerId === target.id && computeCharacteristics(ctx, perm).types.includes('Creature'));
        const chosen = yield* chooseCard(ctx, { player: target.id, prompt: `${source.name}: sacrifice a creature or lose ${creatures.length} life`, cards: creatures, type: 'sacrifice', verb: 'Sacrifice', decline: { type: 'decline', description: `Lose ${creatures.length} life`, verb: 'Decline' } });
        if (chosen === null) loseLife(ctx, target, creatures.length);
        else yield* moveObject(ctx, chosen, { zone: 'graveyard' });
        break;
      }
      case 'emptyLibraryCreatureOrLose':
        if (controller.library.length > 0) break;
        {
          const creatures = controller.graveyard.filter((card) => getDefByOracleId(ctx, card.oracleId, card.name).types.includes('Creature'));
          const chosen = yield* chooseCard(ctx, { player: controller.id, prompt: `${source.name}: return a creature from your graveyard`, cards: creatures, type: 'returnToBattlefield', verb: 'Return', decline: { type: 'loseGame', description: 'No creature — lose the game', verb: 'Lose' } });
          if (chosen === null) controller.hasLost = true;
          else yield* moveObject(ctx, chosen, { zone: 'battlefield', controllerId: controller.id });
        }
        break;
      case 'grantUnearthToArtifactCreaturesInGraveyard': {
        for (const card of controller.graveyard) {
          const def = ctx.defs.get(card.oracleId);
          if (def?.types.includes('Artifact') !== true || !def.types.includes('Creature')) continue;
          ctx.state.temporaryGraveyardAbilities[card.cardId] = [{
            costs: [{ kind: 'mana', cost: effect.cost }],
            timing: 'any',
            zone: 'graveyard',
            ability: {
              kind: 'activated',
              targets: [],
              effects: [{ op: 'unearth' }],
              description: `Unearth ${describeManaCost(effect.cost)}`,
            },
          }];
        }
        break;
      }
      case 'unearth': {
        const card = controller.graveyard.find((candidate) => candidate.cardId === source.cardId);
        if (card === undefined) break;
        yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: controller.id });
        const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === source.cardId);
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
          ability: { kind: 'triggered', targets: [], effects: [{ op: 'exileSource' }], description: 'Exile this permanent' },
          expiry: 'endStep',
        });
        break;
      }
      case 'exileSource': {
        const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === source.cardId);
        if (permanent !== undefined) yield* moveObject(ctx, permanent, { zone: 'exile' });
        break;
      }
      case 'exileResolvingSpell': {
        const entry = ctx.state.stack.find((stackObject) => stackObject.sourceCardId === source.cardId);
        if (entry?.card !== null && entry?.card !== undefined) yield* moveObject(ctx, entry.card, { zone: 'exile' });
        break;
      }
      case 'millTargetPlayer': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
        if (target === undefined) break;
        for (let i = 0; i < effect.count; i++) {
          const top = target.library[0];
          if (top === undefined) break;
          yield* moveObject(ctx, top, { zone: 'graveyard' });
          emit(ctx, 'mill', { player: target.id, cardId: top.cardId, name: top.name }, controller.id);
        }
        break;
      }
      case 'millAndChooseArtifact': {
        for (let i = 0; i < 3; i++) {
          const top = controller.library[0];
          if (top === undefined) break;
          yield* moveObject(ctx, top, { zone: 'graveyard' });
          emit(ctx, 'mill', { player: controller.id, cardId: top.cardId, name: top.name }, controller.id);
        }
        const choices = controller.graveyard.filter((card) => {
          const def = getDefByOracleId(ctx, card.oracleId, card.name);
          return def.types.includes('Artifact') && def.types.includes('Creature');
        });
        const chosen = yield* chooseCard(ctx, { player: controller.id, prompt: `${source.name}: you may return an artifact creature milled this way`, cards: choices, type: 'returnToHand', verb: 'Return', decline: { type: 'decline', description: 'Take none', verb: 'Skip' } });
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
        emit(ctx, 'draw', { player: controller.id, cardId: top.cardId, name: top.name, revealed: true }, controller.id);
        break;
      }
      case 'goadEachOpponent':
        for (const perm of ctx.state.battlefield) {
          if (perm.controllerId !== controller.id && computeCharacteristics(ctx, perm).types.includes('Creature')) {
            addGoadRequirement(ctx, perm, controller.id);
          }
        }
        break;
      case 'createTreasureForDeaths':
        for (let i = 0; i < ctx.state.creaturesDiedThisTurn; i++) {
          createToken(ctx, {
            name: 'Treasure', typeLine: 'Artifact — Treasure', types: ['Artifact'], subtypes: ['Treasure'], colors: [], power: null, toughness: null,
            manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']] },],
          }, controller.id);
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
        const original = ctx.state.stack.find((entry) => entry.id === targetId && entry.kind === 'spell');
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
        const affected = affectedBy(ctx, source, effect.selector);
        for (const perm of affected) {
          dealDamageToCreature(ctx, source, perm, amountOf(effect.amount), {
            combat: false,
            sourceHasDeathtouch: false,
            sourceHasLifelink: false,
          });
        }
        emit(ctx, 'damageEach', {
          source: source.name,
          targets: affected.map((p) => p.name),
          amount: effect.amount,
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
      case 'searchLibrary': {
        const destinations =
          effect.count !== undefined
            ? Array.from({ length: amountOf(effect.count) }, () => effect.destinations[0] as SearchDestination)
            : effect.destinations;
        yield* searchLibrary(ctx, source, controller, effect.filter, destinations);
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
        yield* scry(ctx, source, controller, effect.count);
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
        // Each token is created separately, so each fires its own ETB trigger.
        for (let i = 0; i < amountOf(effect.count); i++) {
          const spec = {
            ...effect.spec,
            ...(effect.powerOverride !== undefined
              ? { power: typeof effect.powerOverride === 'number' ? effect.powerOverride : evaluateValueIn(ctx, effect.powerOverride, scope) }
              : {}),
            ...(effect.toughnessOverride !== undefined
              ? { toughness: typeof effect.toughnessOverride === 'number' ? effect.toughnessOverride : evaluateValueIn(ctx, effect.toughnessOverride, scope) }
              : {}),
          };
          createToken(ctx, spec, controller.id);
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
          ...(effect.addTypes !== undefined ? { types: [...new Set([...baseSpec.types, ...effect.addTypes])] } : {}),
          ...(effect.powerOverride !== undefined ? { power: typeof effect.powerOverride === 'number' ? effect.powerOverride : evaluateValueIn(ctx, effect.powerOverride, scope) } : {}),
          ...(effect.toughnessOverride !== undefined ? { toughness: typeof effect.toughnessOverride === 'number' ? effect.toughnessOverride : evaluateValueIn(ctx, effect.toughnessOverride, scope) } : {}),
          ...(effect.addKeywords !== undefined ? { keywords: [...new Set([...(baseSpec.keywords ?? []), ...effect.addKeywords])] } : {}),
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
        const player = t === null ? undefined : ctx.state.players.find((candidate) => candidate.id === t);
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
        emit(ctx, 'becomeCopy', { source: source.name, target: target.name, untilEot: effect.untilEot === true });
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
        emit(ctx, 'becomeCopy', { source: source.name, target: copy.name, untilEot: effect.untilEot === true });
        break;
      }
      case 'untapEach':
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          perm.tapped = false;
        }
        break;
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
        const manaValue = spellManaValue(getDefByOracleId(ctx, cardObj.oracleId, cardObj.name), undefined);
        emit(ctx, 'graveyardToBattlefield', { target: cardObj.name, source: source.name });
        yield* moveObject(ctx, cardObj, { zone: 'battlefield', controllerId: source.controllerId });
        loseLife(ctx, controller, manaValue);
        break;
      }
      case 'graveyardToLibraryTop': {
        const t = ref(effect.target);
        if (t === null) break;
        const card = findObjectById(ctx, t);
        if (card !== undefined) yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'top' });
        break;
      }      case 'graveyardToHand': {
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
        const stackIndex = ctx.state.stack.findIndex((entry) => entry.id === t && entry.kind === 'spell');
        const stackEntry = stackIndex < 0 ? undefined : ctx.state.stack[stackIndex];
        if (stackEntry?.card === null || stackEntry?.card === undefined) break;
        ctx.state.stack.splice(stackIndex, 1);
        emit(ctx, 'returnToHand', { target: stackEntry.card.name, source: source.name });
        yield* moveObject(ctx, stackEntry.card, { zone: 'hand' });
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
            options: candidates.map((perm) => cardOption(ctx, perm, {
              type: 'choose',
              description: `Return ${perm.name} to its owner’s hand`,
              payload: perm.id,
              verb: 'Return',
              role: 'affirm',
            })),
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
      }      case 'doublePower': {
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
        const max = Math.min(effect.count, controller.library.length);
        const options = Array.from({ length: max + 1 }, (_, amount) =>
          valueOption(amount, `Draw ${amount} card${amount === 1 ? '' : 's'}`, {
            type: 'drawUpTo',
            description: `Draw ${amount} card${amount === 1 ? '' : 's'}`,
            verb: 'Draw',
          }),
        );
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: draw up to ${effect.count} cards. Choose an amount.`,
          options,
        };
        yield* drawCards(ctx, controller, outcome.index);
        break;
      }
      case 'mayPayEnergyUpTo': {
        const max = Math.min(
          Math.max(0, Math.floor(amountOf(effect.max))),
          controller.energy,
        );
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
          yield* executeAbility(ctx, source, { ...ability, effects: effect.then }, targets, triggerObjectCardId, { ...scope }, countTargets, divisionAmounts);
        }
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
              ? [plainOption({ type: 'payEnergy', description: `Pay ${amount} energy`, verb: 'Pay' })]
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
          yield* executeAbility(ctx, source, { ...ability, effects: effect.then }, targets, triggerObjectCardId, { ...scope }, countTargets, divisionAmounts);
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
          const revealedDef = getDefByOracleId(ctx, revealed.oracleId, revealed.name);
          if (revealedDef.types.some((type) => ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'].includes(type))) {
            yield* moveObject(ctx, revealed, { zone: 'battlefield', controllerId: owner.id });
          }
        }
        break;
      }
      case 'manifestTop': {
        const playerId = effect.player === 'eventPlayer' ? (scope.eventPlayerId ?? controller.id) : controller.id;
        const player = playerById(ctx, playerId);
        const top = player.library[0];
        if (top === undefined) break;
        const manifested = yield* moveObject(ctx, top, { zone: 'battlefield', controllerId: player.id });
        if (manifested !== null && manifested.zone === 'battlefield') {
          (manifested as EnginePermanent).faceDown = true;
        }
        break;
      }
      case 'manifestTopForTargetController': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : findPermanent(ctx, targetId);
        if (target === undefined) break;
        const player = playerById(ctx, target.controllerId);
        const top = player.library[0];
        if (top === undefined) break;
        const manifested = yield* moveObject(ctx, top, { zone: 'battlefield', controllerId: player.id });
        if (manifested !== null && manifested.zone === 'battlefield') {
          (manifested as EnginePermanent).faceDown = true;
        }
        break;
      }
      case 'opponentMayDrawOrMillThenDamage': {
        const targetId = ref(effect.target);
        const target = targetId === null ? undefined : ctx.state.players.find((p) => p.id === targetId);
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
            return perm.controllerId !== player.id && (chars.types.includes('Artifact') || chars.types.includes('Enchantment'));
          });
          const outcome = yield {
            decisionType: 'general',
            player: player.id,
            prompt: `${source.name}: choose an artifact or enchantment you don't control to destroy, or choose none.`,
            options: [
              plainOption({ type: 'decline', description: 'Choose none', verb: 'Skip' }),
              ...options.map((perm) => cardOption(ctx, perm, { type: 'destroy', description: `Destroy ${perm.name}`, payload: perm.id, verb: 'Choose' })),
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
          if (hasKeyword(ctx, current, 'indestructible')) {
            emit(ctx, 'destroyPrevented', { target: current.name, source: source.name });
          } else {
            emit(ctx, 'destroy', { target: current.name, source: source.name });
            yield* moveObject(ctx, current, { zone: 'graveyard' });
          }
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
        const manifested = yield* moveObject(ctx, top, { zone: 'battlefield', controllerId: player.id });
        if (manifested !== null && manifested.zone === 'battlefield') {
          (manifested as EnginePermanent).faceDown = true;
        }
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
        if (exiled !== undefined) yield* moveObject(ctx, exiled, { zone: 'battlefield', controllerId: targetController });
        break;
      }
      case 'blinkOneCreatureYouControl': {
        const creatures = ctx.state.battlefield.filter((perm) => perm.controllerId === source.controllerId && computeCharacteristics(ctx, perm).types.includes('Creature'));
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: exile a creature you control and return it to the battlefield, or choose none.`,
          options: [
            plainOption({ type: 'decline', description: 'Choose none', verb: 'Skip' }),
            ...creatures.map((perm) => cardOption(ctx, perm, { type: 'blink', description: `Blink ${perm.name}`, payload: perm.id, verb: 'Blink' })),
          ],
        };
        const chosen = outcome.index === 0 ? undefined : creatures[outcome.index - 1];
        if (chosen !== undefined) {
          const cardId = chosen.cardId;
          const targetController = chosen.controllerId;
          yield* moveObject(ctx, chosen, { zone: 'exile' });
          const exiled = ctx.state.exile.find((card) => card.cardId === cardId);
          if (exiled !== undefined) yield* moveObject(ctx, exiled, { zone: 'battlefield', controllerId: targetController });
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
        const checkTargetCardId = checkTargetId === null ? null : findObjectById(ctx, checkTargetId)?.cardId;
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
        yield* counterUnlessPays(ctx, source, t, effect.cost);
        break;
      }
      case 'grantAbilityUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        if (perm) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: `${perm.name} gains ability until end of turn`,
            targetCardIds: [perm.cardId],
            kind: 'grantAbility',
            ability: effect.ability,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        break;
      }
      case 'becomeCreatureUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent | undefined;
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
        const perm = findPermanent(ctx, t) as EnginePermanent | undefined;
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
        const n = amountOf(effect.count);
        for (const player of ctx.state.players) {
          if (player.hasLost) continue;
          yield* discardCards(ctx, player, player.hand.length);
          yield* drawCards(ctx, player, n);
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
        const target = playerId === null ? undefined : ctx.state.players.find((p) => p.id === playerId);
        if (target === undefined) break;
        const chosenIds = countTargets?.[effect.cardsSlot] ?? [];
        for (const cardId of chosenIds) {
          const card = target.graveyard.find((c) => c.id === cardId || c.cardId === cardId);
          if (card === undefined) continue;
          yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'bottom' });
        }
        ctx.rng.shuffle(target.library);
        emit(ctx, 'shuffle', { player: target.id }, target.id);
        break;
      }
      case 'destroyEachNonlandMVFromDamagedControllers': {
        const mv = amountOf(effect.mv);
        const damagedControllers = new Set(ctx.state.combatDamagePlayersBySource[source.cardId] ?? []);
        const toDestroy = ctx.state.battlefield.filter((p) => {
          if (!damagedControllers.has(p.controllerId)) return false;
          const chars = computeCharacteristics(ctx, p);
          if (chars.types.includes('Land')) return false;
          const def = getDefByOracleId(ctx, p.oracleId, p.name);
          return spellManaValue(def, undefined) === mv;
        });
        for (const perm of toDestroy) {
          if (hasKeyword(ctx, perm, 'indestructible')) continue;
          yield* moveObject(ctx, perm, { zone: 'graveyard' });
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
          if (!canPay(withX(effect.templatedCost, x), controller.manaEntries, sources, allows)) break;
          choices.push(x);
        }
        if (choices.length === 0) break;
        const outcome = yield {
          decisionType: 'general',
          player: controller.id,
          prompt: `${source.name}: pay ${describeManaCost(effect.templatedCost)} for X? (0 declines)`,
          options: choices.map((x) => ({
            type: 'payX',
            description: x === 0 ? "Don't pay" : `Pay X=${x} (${describeManaCost(withX(effect.templatedCost, x))})`,
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
          ...eligible.map((card) => cardOption(ctx, card, {
            type: 'castFree',
            description: `Cast ${card.name} without paying its mana cost`,
            verb: 'Cast for free',
          })),
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
          if (!ctx.state.players.some((p) => p.library.some((candidate) => candidate.cardId === card.cardId))) continue;
          if (card !== eligible[outcome.index]) {
            const current = controller.library.find((candidate) => candidate.cardId === card.cardId);
            if (current !== undefined && current !== eligible[outcome.index]) yield* moveObject(ctx, current, { zone: 'library', libraryPosition: 'bottom' });
          }
        }
        break;
      }
      case 'castAnyFromHandFree': {
        for (;;) {
          const eligible = controller.hand.filter((card) => freeCardIsCastable(ctx, card, controller.id));
          if (eligible.length === 0) break;
          const options = [
            ...eligible.map((card) => cardOption(ctx, card, {
              type: 'castFree',
              description: `Cast ${card.name} without paying its mana cost`,
              verb: 'Cast for free',
            })),
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
            ? (triggerObjectCardId === undefined ? null : (findPhysicalObjectByCardId(ctx, triggerObjectCardId)?.id ?? null))
            : effect.target !== undefined
              ? ref(effect.target)
              : null;
        const targetPlayer = t === null ? undefined : ctx.state.players.find((player) => player.id === t);
        const targetStack = t === null ? undefined : ctx.state.stack.find((entry) => entry.id === t);
        const targetObject = t === null ? undefined : findObjectById(ctx, t);
        const targetId = t === null
          ? undefined
          : targetPlayer !== undefined
            ? targetPlayer.id
            : targetStack?.controllerId ?? targetObject?.cardId;
        const delayedController =
          effect.controller === 'targetController'
            ? targetPlayer?.id ?? targetStack?.controllerId ?? ((targetObject as unknown as { controllerId?: PlayerId } | undefined)?.controllerId ?? source.controllerId)
            : source.controllerId;
        ctx.state.delayedTriggers.push({
          id: `dt-${ctx.state.nextObjectNum++}`,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          controllerId: delayedController,
          ...(targetId !== undefined ? { targetId } : {}),
          when: effect.when,
          ability: effect.ability,
          expiry: effect.expiry,
        });
        break;
      }
      case 'commandZoneToBattlefield': {
        const t = ref(effect.target);
        if (t === null) break;
        const player = playerById(ctx, source.controllerId);
        const card = player.commandZone.find((c) => c.cardId === t || c.id === t) ?? player.commandZone[0];
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
            prompt: 'Kairi: choose nonland permanents with total mana value 6 or less to return to hands',
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
              plainOption({ type: 'decline', description: 'Done returning spells', verb: 'Done', role: 'decline' }),
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
        const moved = (yield* moveObject(ctx, chosenCard, { zone: 'exile' })) as EngineCardObject | null;
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
        const card = ctx.state.exile.find((c: EngineCardObject) => c.attachedToCardId === source.cardId);
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
            yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: source.controllerId });
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
  if (amount <= 0 || palette.length === 0) return;

  if (effect.fixedSymbols !== undefined) {
    const produced = effect.fixedSymbols.map((symbol) => ({
      symbol,
      ...(effect.restriction !== undefined ? { restriction: effect.restriction } : {}),
      ...(effect.persistent === true ? { persistent: true } : {}),
    }));
    addMana(controller, produced);
    emit(ctx, 'manaAdded', { source: source.name, player: controller.id, symbols: produced.map((entry) => entry.symbol) });
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

  const selectorSource = { cardId: source.cardId, controllerId: player.id };
  const eligible = looked.filter((card) =>
    selectMatches(cardZoneCandidate(ctx, card, player.id), effect.mayPut.filter, selectorSource),
  );

  let taken: EngineCardObject | undefined;
  if (eligible.length > 0) {
    const destination = effect.mayPut.destination;
    const where =
      destination.zone === 'battlefield'
        ? `onto the battlefield${destination.tapped === true ? ' tapped' : ''}`
        : `into your ${destination.zone}`;
    const outcome = yield {
      decisionType: 'general',
      player: player.id,
      prompt: `${source.name}: you may put a card from among the top ${looked.length} ${where}.`,
      options: [
        // No raw `payload` — these are cards off the top of the library, never rendered
        // on-screen, so a payload-derived `subjectId` would strand the option behind an
        // unreachable "click the board object" affordance (see `chooseCard`'s doc comment).
        ...eligible.map((card) =>
          cardOption(ctx, card, {
            type: 'putFromTop',
            description: `Put ${card.name} ${where}`,
            verb: `Put ${where}`,
          }),
        ),
        plainOption({ type: 'decline', description: 'Put none of them', verb: 'Put none of them', role: 'decline' }),
      ],
    };
    if (outcome.index < eligible.length) taken = eligible[outcome.index];
  }

  const rest = looked.filter((card) => card !== taken);
  ctx.rng.shuffle(rest);
  player.library.push(...rest);
  emit(
    ctx,
    'lookAtTop',
    { player: player.id, looked: looked.length, took: taken?.name ?? null },
    player.id,
  );

  if (taken !== undefined) {
    const destination = effect.mayPut.destination;
    yield* moveObject(
      ctx,
      taken,
      destination.zone === 'battlefield'
        ? {
            zone: 'battlefield',
            controllerId: player.id,
            ...(destination.tapped === true ? { entersTapped: true } : {}),
          }
        : { zone: destination.zone },
    );
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
  cost: ParsedManaCost,
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
  const canAfford = canPay(cost, controller.manaEntries, manaSourcesFor(ctx, controller.id));
  if (canAfford) {
    const outcome = yield {
      decisionType: 'general',
      player: controller.id,
      prompt: `${source.name}: pay ${describeManaCost(cost)} or ${entry.description} is countered.`,
      options: [
        { type: 'payCost', description: `Pay ${describeManaCost(cost)}` },
        { type: 'decline', description: `Let ${entry.description} be countered` },
      ],
    };
    if (outcome.index === 0) {
      yield* payManaCost(ctx, controller, cost);
      emit(ctx, 'wardPaid', { source: source.name, spell: entry.description }, controller.id);
      return;
    }
  }

  ctx.state.stack.splice(index, 1);
  emit(ctx, 'counterSpell', { countered: entry.description, by: source.name });
  debug(ctx, 'stack', `${entry.description} countered by ${source.name} (unpaid)`);
  if (entry.card !== null) yield* moveObject(ctx, entry.card, { zone: 'graveyard' });
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
): GameGen<void> {
  const selectorSource = { cardId: source.cardId, controllerId: player.id };
  for (const destination of destinations) {
    const matches = player.library.filter((card) =>
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
    if (distinctNames.size === 1) {
      const card = matches[0] as EngineCardObject;
      if (destination.zone === 'libraryTop') {
        player.library.splice(player.library.indexOf(card), 1);
        shuffleLibrary(ctx, player);
        player.library.unshift(card);
        emit(ctx, 'searchFound', { player: player.id, name: card.name, to: destination.zone });
        continue;
      }
      emit(ctx, 'searchFound', { player: player.id, name: card.name, to: destination.zone });
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
        plainOption({ type: 'findNothing', description: 'Find nothing', verb: 'Find nothing', role: 'decline' }),
      ],
    };
    if (outcome.index >= matches.length) break;

    const card = matches[outcome.index] as EngineCardObject;
    if (destination.zone === 'libraryTop') {
      player.library.splice(player.library.indexOf(card), 1);
      shuffleLibrary(ctx, player);
      player.library.unshift(card);
      emit(ctx, 'searchFound', { player: player.id, name: card.name, to: destination.zone });
      continue;
    }
    emit(ctx, 'searchFound', { player: player.id, name: card.name, to: destination.zone });
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
      plainOption({ type: 'findNothing', description: 'Find nothing', verb: 'Find nothing', role: 'decline' }),
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
  emit(ctx, 'scry', { player: player.id, looked: looked.length, bottomed: bottom.length }, player.id);
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
      emit(ctx, 'counters', { source: source.name, target: player.id, counter: 'poison', added: 1, total: player.poisonCounters }, controller.id);
    }
  }
}
/** End all until-end-of-turn effects (cleanup, CR 514.2). */
export function endUntilEotEffects(ctx: GameContext): void {
  if (ctx.state.effects.length > 0) {
    debug(ctx, 'effect', `ending ${ctx.state.effects.length} until-end-of-turn effect(s)`);
    ctx.state.effects = [];
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
): GameGen<void> {
  const sources = manaSourcesFor(ctx, player.id);
  const allows = allowanceFor(ctx, player.id, purpose);
  const plan = planPayment(cost, player.manaEntries, sources, allows);
  if (plan === null) {
    throw new Error(`engine bug: cost for ${player.id} became unpayable at application time`);
  }
  for (const cardId of plan.tapCardIds) {
    const perm = ctx.state.battlefield.find((p) => p.cardId === cardId);
    if (perm === undefined) throw new Error('engine bug: payment source vanished');
    // Riders on the mana ability itself — a painland's "deals 1 damage to you". Mana abilities
    // never use the stack (CR 605.3a), so this resolves immediately rather than being queued.
    // Applied BEFORE the cost, so a source that sacrifices itself still exists to do it.
    for (const ability of computeCharacteristics(ctx, perm).manaAbilities) {
      for (const effect of ability.onActivate ?? []) {
        applyManaRider(ctx, perm, player, effect);
      }
    }
    const source = sources.find((s) => s.cardId === cardId);
    yield* payAbilityCosts(ctx, player, perm, source?.costs ?? TAP_COST, 'tapForMana');
  }

  // Add exactly the mana the planner chose to produce — the SPECIFIC symbol per unit (correct
  // for multi-color sources, where the first symbol would mispay), carrying whatever restriction,
  // spend trigger and persistence the producing ability attaches. Surplus floats.
  addMana(
    player,
    plan.produced.map(({ cardId, symbol }) => {
      const source = plan.tapCardIds.includes(cardId)
        ? sources.find((s) => s.cardId === cardId && s.units.some((u) => u.includes(symbol)))
        : undefined;
      return {
        symbol,
        ...(source?.restriction !== undefined ? { restriction: source.restriction } : {}),
        ...(source?.spendTrigger !== undefined ? { spendTrigger: source.spendTrigger } : {}),
        ...(source?.persistent === true ? { persistent: true } : {}),
      };
    }),
  );

  // Spend specific entries, so the right spend triggers fire. Only mana this payment may
  // legally use is eligible — the pool can hold restricted mana that is not spendable here.
  const eligible = player.manaEntries.filter((e) => entryIsUsable(e, allows));
  const spent = selectEntriesToSpend(eligible, cost);
  if (spent === null) {
    throw new Error(`engine bug: payment shortfall for ${player.id} after producing mana`);
  }
  removeMana(player, spent);

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
): GameGen<{ stationPower?: number }> {
  let stationPower: number | undefined;
  for (const cost of costs) {
    switch (cost.kind) {
      case 'tap':
        perm.tapped = true;
        queueTriggersForObject(ctx, 'becomesTapped', perm);
        emit(ctx, tapEvent, { name: perm.name, cardId: perm.cardId }, player.id);
        break;
      case 'tapOther': {
        const options = ctx.state.battlefield.filter((candidate) =>
          candidate.id !== perm.id && candidate.controllerId === player.id && !candidate.tapped &&
          matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: player.id }),
        );
        if (options.length === 0) throw new Error('engine bug: additional tap cost became unpayable');
        const outcome = yield {
          decisionType: 'general', player: player.id,
          prompt: `${perm.name}: choose a permanent to tap as an activation cost.`,
          options: options.map((candidate) => ({ type: 'tapCost', description: `Tap ${candidate.name}`, payload: candidate.id })),
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
          const options = ctx.state.battlefield.filter((candidate) =>
            candidate.id !== perm.id && candidate.controllerId === player.id && !candidate.tapped &&
            matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: player.id }),
          );
          if (options.length === 0) throw new Error('engine bug: additional tap costs became unpayable');
          const outcome = yield {
            decisionType: 'general', player: player.id,
            prompt: `${perm.name}: choose permanent ${i + 1} of ${cost.count} to tap as an activation cost.`,
            options: options.map((candidate) => ({ type: 'tapCost', description: `Tap ${candidate.name}`, payload: candidate.id })),
          };
          const chosen = options[outcome.index];
          if (chosen === undefined) throw new Error('engine bug: additional tap choice was invalid');
          chosen.tapped = true;
          queueTriggersForObject(ctx, 'becomesTapped', chosen);
          emit(ctx, tapEvent, { name: chosen.name, cardId: chosen.cardId }, player.id);
        }
        break;
      }
      case 'tapXOthers': {
        for (let i = 0; i < announcedX; i++) {
          const options = ctx.state.battlefield.filter((candidate) =>
            candidate.id !== perm.id && candidate.controllerId === player.id && !candidate.tapped &&
            matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: player.id }),
          );
          if (options.length === 0) throw new Error('engine bug: X tap cost became unpayable');
          const outcome = yield {
            decisionType: 'general', player: player.id,
            prompt: `${perm.name}: choose artifact ${i + 1} of ${announcedX} to tap as an activation cost.`,
            options: options.map((candidate) => ({ type: 'tapCost', description: `Tap ${candidate.name}`, payload: candidate.id })),
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
          const options = ctx.state.battlefield.filter((candidate) =>
            candidate.id !== perm.id && candidate.controllerId === player.id &&
            matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: player.id }),
          );
          if (options.length === 0) throw new Error('engine bug: sacrifice cost became unpayable');
          const outcome = yield {
            decisionType: 'general', player: player.id,
            prompt: `${perm.name}: choose permanent ${i + 1} of ${count} to sacrifice as an activation cost.`,
            options: options.map((candidate) => ({ type: 'sacrificeCost', description: `Sacrifice ${candidate.name}`, payload: candidate.id })),
          };
          const chosen = options[outcome.index];
          if (chosen === undefined) throw new Error('engine bug: sacrifice-cost choice was invalid');
          emit(ctx, 'sacrifice', { name: chosen.name, cardId: chosen.cardId }, player.id);
          yield* moveObject(ctx, chosen, { zone: 'graveyard' });
        }
        break;
      }
      case 'removeCounters': {
        const count = typeof cost.count === 'number' ? cost.count : evaluateValueIn(ctx, cost.count, { controllerId: player.id, sourceCardId: perm.cardId });
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
      case 'payEnergy':
        if (player.energy < cost.amount) throw new Error('engine bug: energy cost became unpayable');
        player.energy -= cost.amount;
        emit(ctx, 'energy', { amount: -cost.amount, total: player.energy }, player.id);
        break;
      case 'loyalty': {
        const have = perm.counters['loyalty'] ?? 0;
        perm.counters['loyalty'] = Math.max(0, have + cost.delta);
        emit(
          ctx,
          'counters',
          {
            target: perm.name,
            targetCardId: perm.cardId,
            counter: 'loyalty',
            added: cost.delta,
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
        const hostName = perm.attachedTo === null ? undefined : findPermanent(ctx, perm.attachedTo)?.name;
        perm.attachedTo = null;
        emit(ctx, 'unattach', { equipment: perm.name, from: hostName }, player.id);
        break;
      }
      case 'discardCard':
        yield* discardCards(ctx, player, cost.count ?? 1);
        break;
      case 'discardHand':
        yield* discardCards(ctx, player, player.hand.length);
        break;
      case 'tapCreaturesTotalPower': {
        let tappedPower = 0;
        for (;;) {
          const options = ctx.state.battlefield.filter((candidate) =>
            candidate.id !== perm.id && candidate.controllerId === player.id && !candidate.tapped &&
            computeCharacteristics(ctx, candidate).types.includes('Creature'),
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
    yield* moveObject(ctx, perm, { zone: 'graveyard' });
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
