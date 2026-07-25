/**
 * Effect resolution (brief §6.2): applying the mechanical outcome of `EffectSpec`s, plus
 * the shared damage/draw/life primitives used by combat and turn-based actions.
 */

import type { ObjectId, PlayerId } from '@mtg/shared';
import { permanentMatchesKind } from '../actions/legal';
import type {
  Ability,
  Effect,
  EffectRef,
  SearchDestination,
  Selector,
  TargetKind,
  TargetSpec,
} from '../cards/definition';
import type { SelectorCandidate } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import type { GameGen } from '../decisions';
import { UnmodeledCardError } from '../errors';
import { selectPermanents } from './continuous';
import { debug, emit } from '../log/log';
import { moveObject, playerById } from '../state/objects';
import {
  effectivePT,
  findPermanent,
  getDefByOracleId,
  hasKeyword,
  opponentsOf,
} from '../state/queries';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
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
  opts: { combat: boolean; sourceHasDeathtouch: boolean; sourceHasLifelink: boolean },
): void {
  if (amount <= 0) return;
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
): boolean {
  const { kind, controller } =
    typeof spec === 'string' ? { kind: spec, controller: undefined } : spec;

  if (kind === 'spell') {
    return ctx.state.stack.some((s) => s.id === targetId && s.kind === 'spell');
  }
  const player = ctx.state.players.find((p) => p.id === targetId);
  if (player !== undefined) {
    return (kind === 'anyTarget' || kind === 'player') && !player.hasLost;
  }
  const perm = findPermanent(ctx, targetId);
  if (perm === undefined || !permanentMatchesKind(ctx, perm, kind)) return false;
  if (perm.controllerId !== spellControllerId && hasKeyword(ctx, perm, 'hexproof')) return false;
  if (controller === 'you' && perm.controllerId !== spellControllerId) return false;
  if (controller === 'opponent' && perm.controllerId === spellControllerId) return false;
  return true;
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
): GameGen<void> {
  const controller = playerById(ctx, source.controllerId);

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
          dealDamageToPlayer(ctx, source, targetPlayer, effect.amount, {
            combat: false,
            sourceIsCommander: false,
            sourceHasLifelink: false,
          });
        } else {
          const perm = findPermanent(ctx, t) as EnginePermanent;
          dealDamageToCreature(ctx, source, perm, effect.amount, {
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
        yield* drawCards(ctx, controller, effect.count);
        break;
      case 'gainLife':
        gainLife(ctx, controller, effect.amount);
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
          dealDamageToCreature(ctx, source, perm, effect.amount, {
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
    }
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
    selectMatches(cardCandidate(ctx, card, player.id), effect.mayPut.filter, selectorSource),
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

/** Shuffle a library with the game's seeded PRNG — never `Math.random` (brief §4/§5.9). */
export function shuffleLibrary(ctx: GameContext, player: EnginePlayerState): void {
  ctx.rng.shuffle(player.library);
  emit(ctx, 'shuffle', { player: player.id }, player.id);
}

/**
 * The candidate a selector is matched against for a card that is NOT on the battlefield.
 *
 * Library and graveyard cards have no layered characteristics — nothing continuous applies to
 * them — so this reads the printed definition. `self`/`other` are meaningless here and are
 * rejected rather than silently answering false.
 */
function cardCandidate(
  ctx: GameContext,
  card: EngineCardObject,
  ownerId: PlayerId,
): SelectorCandidate {
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  return {
    cardId: card.cardId,
    controllerId: ownerId,
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
  };
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
      selectMatches(cardCandidate(ctx, card, player.id), filter, selectorSource),
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
      gainLife(ctx, controller, effect.amount);
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

/** Does this permanent's damage carry deathtouch/lifelink (for combat)? */
export function combatDamageTraits(
  ctx: GameContext,
  perm: EnginePermanent,
): { deathtouch: boolean; lifelink: boolean } {
  return {
    deathtouch: hasKeyword(ctx, perm, 'deathtouch'),
    lifelink: hasKeyword(ctx, perm, 'lifelink'),
  };
}

/** Convenience: definition lookup for a permanent. */
export function defOf(
  ctx: GameContext,
  perm: EnginePermanent,
): ReturnType<typeof getDefByOracleId> {
  return getDefByOracleId(ctx, perm.oracleId, perm.name);
}
