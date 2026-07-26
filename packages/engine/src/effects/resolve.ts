/**
 * Effect resolution (brief §6.2): applying the mechanical outcome of `EffectSpec`s, plus
 * the shared damage/draw/life primitives used by combat and turn-based actions.
 */

import type { Color, ObjectId, PlayerId } from '@mtg/shared';
import { ALL_COLORS } from '@mtg/shared';
import { permanentMatchesKind } from '../actions/legal';
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
import { selectMatches } from '../cards/selector';
import type { GameGen } from '../decisions';
import { UnmodeledCardError } from '../errors';
import { computeCharacteristics, selectPermanents } from './continuous';
import { evaluateValueIn } from './values';
import type { Value, ValueScope } from '../cards/value';
import { evaluateValue } from '../cards/value';
import { canPay, describeManaCost, entryIsUsable, planPayment } from '../mana/cost';
import type { ParsedManaCost } from '../mana/cost';
import { addMana, removeMana, selectEntriesToSpend } from '../mana/pool';
import type { ManaEntry, PaymentPurpose } from '../cards/ability';
import { debug, emit } from '../log/log';
import {
  createToken,
  moveObject,
  playerById,
  spellManaValue,
  tokenSpecCopying,
} from '../state/objects';
import {
  allowanceFor,
  cardZoneCandidate,
  colorsOf,
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
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
  GameContext,
} from '../state/types';

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
    /** The source's colors, for protection (CR 702.16). Omitted ⇒ colorless. */
    sourceColors?: readonly Color[];
  },
): void {
  if (amount <= 0) return;
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
  target.damageMarked += amount;
  if (opts.sourceHasDeathtouch) target.damagedByDeathtouch = true;
  if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
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
  opts: { combat: boolean; sourceIsCommander: boolean; sourceHasLifelink: boolean },
): void {
  if (amount <= 0) return;
  target.life -= amount;
  // 21+ combat damage from the same commander eliminates — COMBAT damage only (§5.7).
  if (opts.combat && opts.sourceIsCommander) {
    target.commanderDamageTaken[source.cardId] =
      (target.commanderDamageTaken[source.cardId] ?? 0) + amount;
  }
  if (opts.sourceHasLifelink) gainLife(ctx, playerById(ctx, source.controllerId), amount);
  emit(ctx, 'damage', {
    source: source.name,
    sourceCardId: source.cardId,
    target: target.id,
    amount,
    combat: opts.combat,
    commanderDamage: opts.combat && opts.sourceIsCommander,
  });
}

export function gainLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (amount <= 0) return;
  player.life += amount;
  emit(ctx, 'lifeGain', { player: player.id, amount, life: player.life });
}

export function loseLife(ctx: GameContext, player: EnginePlayerState, amount: number): void {
  if (amount <= 0) return;
  player.life -= amount;
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
      player.attemptedDrawFromEmptyLibrary = true;
      emit(ctx, 'drawFromEmptyLibrary', { player: player.id });
      debug(ctx, 'engine', `${player.id} attempted to draw from an empty library`);
      continue;
    }
    yield* moveObject(ctx, top, { zone: 'hand' });
    emit(ctx, 'draw', { player: player.id, cardId: top.cardId, name: top.name }, player.id);
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
): boolean {
  const { kind, controller, filter } =
    typeof spec === 'string' ? { kind: spec, controller: undefined, filter: undefined } : spec;

  if (kind === 'spell') {
    return ctx.state.stack.some((s) => s.id === targetId && s.kind === 'spell');
  }
  if (kind === 'cardInGraveyard') {
    return graveyardTargets(ctx, spellControllerId, filter).some((c) => c.id === targetId);
  }
  const player = ctx.state.players.find((p) => p.id === targetId);
  if (player !== undefined) {
    return (kind === 'anyTarget' || kind === 'player') && !player.hasLost;
  }
  const perm = findPermanent(ctx, targetId);
  if (perm === undefined || !permanentMatchesKind(ctx, perm, kind)) return false;
  // Shroud (CR 702.18): untargetable by anything, including its own controller.
  if (hasKeyword(ctx, perm, 'shroud')) return false;
  if (perm.controllerId !== spellControllerId && hasKeyword(ctx, perm, 'hexproof')) return false;
  // Protection (CR 702.16), the T in DEBT: untargetable by sources of the named colors.
  if (sourceColors !== undefined && hasProtectionFrom(ctx, perm, sourceColors)) return false;
  if (controller === 'you' && perm.controllerId !== spellControllerId) return false;
  if (controller === 'opponent' && perm.controllerId === spellControllerId) return false;
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
  perm.counters[counter] = (perm.counters[counter] ?? 0) + count;
  emit(ctx, 'counters', {
    source: source.name,
    target: perm.name,
    targetCardId: perm.cardId,
    counter,
    added: count,
    total: perm.counters[counter],
  });
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
): GameGen<void> {
  const controller = playerById(ctx, source.controllerId);

  const scope: ValueScope = {
    controllerId: source.controllerId,
    sourceCardId: source.cardId,
    ...(extraScope ?? {}),
  };
  /** Evaluate an effect's `Value` amount in this ability's scope. */
  const amountOf = (value: Value): number => evaluateValueIn(ctx, value, scope);

  /** Resolve an effect referent to an object id, or null when it is gone / no longer legal. */
  const ref = (r: EffectRef): ObjectId | null => {
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
    const id = targets[r];
    const spec = ability.targets[r];
    if (id === undefined || spec === undefined) return null;
    if (!isTargetStillLegal(ctx, id, spec, source.controllerId)) {
      debug(ctx, 'effect', `${source.name}: target ${id} illegal — skipped`);
      return null;
    }
    return id;
  };

  for (const effect of ability.effects) {
    switch (effect.op) {
      case 'pumpUntilEot': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: source.cardId,
          description: `${perm.name} gets ${signed(effect.power)}/${signed(effect.toughness)} until end of turn`,
          targetCardIds: [perm.cardId],
          kind: 'ptDelta',
          power: effect.power,
          toughness: effect.toughness,
          timestamp: ctx.state.nextTimestamp++,
        });
        const pt = effectivePT(ctx, perm);
        emit(ctx, 'pump', {
          source: source.name,
          target: perm.name,
          power: effect.power,
          toughness: effect.toughness,
          nowPower: pt.power,
          nowToughness: pt.toughness,
        });
        break;
      }
      case 'grantKeywordUntilEot': {
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
        const clause = `get ${signed(effect.power)}/${signed(effect.toughness)}`;
        if (affected.length > 0) {
          ctx.state.effects.push({
            id: `eff-${ctx.state.nextObjectNum++}`,
            sourceId: source.cardId,
            description: describeMassEffect(affected, clause),
            targetCardIds: affected.map((p) => p.cardId),
            kind: 'ptDelta',
            power: effect.power,
            toughness: effect.toughness,
            timestamp: ctx.state.nextTimestamp++,
          });
        }
        emit(ctx, 'pump', {
          source: source.name,
          targets: affected.map((p) => p.name),
          power: effect.power,
          toughness: effect.toughness,
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
      case 'dealDamage': {
        const t = ref(effect.target);
        if (t === null) break;
        const targetPlayer = ctx.state.players.find((p) => p.id === t);
        if (targetPlayer !== undefined) {
          dealDamageToPlayer(ctx, source, targetPlayer, amountOf(effect.amount), {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        } else {
          const perm = findPermanent(ctx, t) as EnginePermanent;
          dealDamageToCreature(ctx, source, perm, amountOf(effect.amount), {
            combat: false,
            sourceHasDeathtouch: false,
            sourceHasLifelink: false,
          });
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
      case 'exile': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        emit(ctx, 'exile', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'exile' });
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
      case 'putCounters': {
        const t = ref(effect.target);
        if (t === null) break;
        const perm = findPermanent(ctx, t) as EnginePermanent;
        addCounters(ctx, source, perm, effect.counter, effect.count);
        break;
      }
      case 'putCountersEach': {
        // Like the `…EachUntilEot` primitives, the affected set is fixed here at resolution
        // (CR 611.2c) — but counters are a permanent change, so nothing is recorded to undo.
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          addCounters(ctx, source, perm, effect.counter, effect.count);
        }
        break;
      }
      case 'draw':
        yield* drawCards(ctx, controller, amountOf(effect.count));
        break;
      case 'gainLife':
        gainLife(ctx, controller, amountOf(effect.amount));
        break;
      case 'eachOpponentLosesLife':
        for (const opp of opponentsOf(ctx, controller.id)) {
          loseLife(ctx, opp, effect.amount);
        }
        break;
      case 'eachOpponentDamage':
        for (const opp of opponentsOf(ctx, controller.id)) {
          dealDamageToPlayer(ctx, source, opp, effect.amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        }
        break;
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
      case 'searchLibrary':
        yield* searchLibrary(ctx, source, controller, effect.filter, effect.destinations);
        break;
      case 'shuffle':
        shuffleLibrary(ctx, controller);
        break;
      case 'scry':
        yield* scry(ctx, source, controller, effect.count);
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
          createToken(ctx, effect.spec, controller.id);
        }
        break;
      }
      case 'createTokenCopyOf': {
        const t = ref(effect.ref);
        const original = t === null ? undefined : findPermanent(ctx, t);
        // The referent may have left before this resolved. `'triggerObject'` is not a target
        // (CR 115.10a), so that is a no-op rather than a fizzle.
        if (original === undefined) break;
        const spec = tokenSpecCopying(ctx, original, effect.exceptNonLegendary === true);
        for (let i = 0; i < amountOf(effect.count); i++) {
          createToken(ctx, spec, controller.id);
        }
        break;
      }
      case 'untapEach':
        for (const perm of affectedBy(ctx, source, effect.selector)) {
          perm.tapped = false;
        }
        break;
      case 'graveyardToBattlefield': {
        const t = ref(effect.target);
        if (t === null) break;
        const owner = playerById(ctx, source.controllerId);
        const cardObj = owner.graveyard.find((c) => c.id === t);
        // Left the graveyard between announcement and resolution (CR 608.2b) — `ref` already
        // re-checked legality via `graveyardTargets`, so this is the "gone" case, not a bug.
        if (cardObj === undefined) break;
        emit(ctx, 'graveyardToBattlefield', { target: cardObj.name, source: source.name });
        yield* moveObject(ctx, cardObj, { zone: 'battlefield', controllerId: source.controllerId });
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
        const perm = findPermanent(ctx, t) as EnginePermanent;
        emit(ctx, 'returnToHand', { target: perm.name, source: source.name });
        yield* moveObject(ctx, perm, { zone: 'hand' });
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
    }
  }
}

/**
 * "Add X mana in any combination of colors" (Klauth) — mana entering the pool from a
 * RESOLVING ability rather than an activation (CR 605 vs the stack). One decision per mana
 * produced: choosing red, then red, then blue for three mana ends up with the same pool a
 * single "distribute" decision would, so this is not a rules deviation, only a simpler shape
 * than a combinatorial one-shot distribution decision would be.
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

  const produced: ManaEntry[] = [];
  for (let i = 0; i < amount; i++) {
    const outcome = yield {
      decisionType: 'general',
      player: controller.id,
      prompt: `${source.name}: choose a color for mana ${i + 1} of ${amount}.`,
      options: palette.map((sym) => ({ type: 'addMana', description: `Add {${sym}}` })),
    };
    const sym = (palette[outcome.index] ?? palette[0]) as Color | 'C';
    produced.push({
      symbol: sym,
      ...(effect.restriction !== undefined ? { restriction: effect.restriction } : {}),
      ...(effect.persistent === true ? { persistent: true } : {}),
    });
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
        ...eligible.map((card) => ({
          type: 'putFromTop',
          description: `Put ${card.name} ${where}`,
          payload: card.id,
        })),
        { type: 'decline', description: 'Put none of them' },
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
        : `into your ${destination.zone}`;

    // Auto-select when all matching cards share the same name (e.g., mono-color basic
    // land search): the choice is meaningless and would waste an AI call.
    const distinctNames = new Set(matches.map((c) => c.name));
    if (distinctNames.size === 1) {
      const card = matches[0] as EngineCardObject;
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
      options: [
        ...matches.map((card) => ({
          type: 'findCard',
          description: `Put ${card.name} ${where}`,
          payload: card.id,
        })),
        // CR 701.19c: searching never obliges you to find.
        { type: 'findNothing', description: 'Find nothing' },
      ],
    };
    if (outcome.index >= matches.length) break;

    const card = matches[outcome.index] as EngineCardObject;
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

/**
 * Scry N (CR 701.18): look at the top N cards, put any number of them on the bottom, and the
 * rest back on top.
 *
 * Deliberate scope cut: the kept cards go back in their existing relative order rather than an
 * order the player chooses. That is *under*-permissive — an option is unavailable, never an
 * illegal one offered — and it is invisible for scry 1, which is every scry the engine models
 * today.
 */
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
      options: [
        { type: 'scryKeep', description: `Keep ${card.name} on top` },
        { type: 'scryBottom', description: `Put ${card.name} on the bottom` },
      ],
    };
    (outcome.index === 0 ? keep : bottom).push(card);
  }
  player.library.unshift(...keep);
  player.library.push(...bottom);
  emit(ctx, 'scry', { player: player.id, looked: looked.length, bottomed: bottom.length }, player.id);
}

/** End all until-end-of-turn effects (cleanup, CR 514.2). */
export function endUntilEotEffects(ctx: GameContext): void {
  if (ctx.state.effects.length > 0) {
    debug(ctx, 'effect', `ending ${ctx.state.effects.length} until-end-of-turn effect(s)`);
    ctx.state.effects = [];
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
): GameGen<void> {
  for (const cost of costs) {
    switch (cost.kind) {
      case 'tap':
        perm.tapped = true;
        emit(ctx, tapEvent, { name: perm.name, cardId: perm.cardId }, player.id);
        break;
      case 'removeCounters': {
        const have = perm.counters[cost.counter] ?? 0;
        if (have < cost.count) throw new Error('engine bug: counter cost became unpayable');
        perm.counters[cost.counter] = have - cost.count;
        emit(
          ctx,
          'counters',
          {
            target: perm.name,
            targetCardId: perm.cardId,
            counter: cost.counter,
            added: -cost.count,
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
      case 'mana':
        break; // paid separately — see `payActivationCosts`
      case 'sacrificeSelf':
        break; // applied below
    }
  }
  if (costs.some((c) => c.kind === 'sacrificeSelf')) {
    emit(ctx, 'sacrifice', { name: perm.name, cardId: perm.cardId }, player.id);
    yield* moveObject(ctx, perm, { zone: 'graveyard' });
  }
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
): { deathtouch: boolean; lifelink: boolean; colors: Color[] } {
  return {
    deathtouch: hasKeyword(ctx, perm, 'deathtouch'),
    lifelink: hasKeyword(ctx, perm, 'lifelink'),
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
