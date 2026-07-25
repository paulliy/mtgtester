/**
 * Object identity and zone movement (CR 400.7, brief §5.2). A card changing zones becomes
 * a NEW object with a new `ObjectId`; the stable `cardId` links its zone-visits together.
 *
 * `moveObject` is a generator because moving a commander into its owner's hand or library
 * asks the owner whether to put it into the command zone instead (CR 903.9b — an AI
 * decision, brief §5.7). Graveyard/exile command-zone returns are a state-based action
 * (CR 903.9a) handled by the SBA loop, not here.
 */

import type { ObjectId, PlayerId, Zone } from '@mtg/shared';
import { evaluateCondition, resolveCondition } from '../cards/condition';
import type { SelectorSource } from '../cards/selector';
import type { GameGen } from '../decisions';
import { matchesSelector } from '../effects/continuous';
import { debug, emit } from '../log/log';
import { getDefByOracleId, triggersOf } from './queries';
import type {
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  GameContext,
} from './types';

export function newObjectId(ctx: GameContext): ObjectId {
  return `o-${ctx.state.nextObjectNum++}`;
}

export function playerById(ctx: GameContext, id: PlayerId): EnginePlayerState {
  const p = ctx.state.players.find((pl) => pl.id === id);
  if (p === undefined) throw new Error(`unknown player ${id}`);
  return p;
}

/** Where a moved object should land. */
export interface MoveDestination {
  zone: Zone;
  /** Battlefield only: the controller it enters under (defaults to its owner). */
  controllerId?: PlayerId;
  /**
   * Battlefield only: the moving EFFECT says it enters tapped ("put it onto the battlefield
   * tapped"). Independent of the card's own `entersTapped`/`entersTappedUnless`, and decisive:
   * a condition that would have let it enter untapped cannot untap it (CR 614.1c).
   */
  entersTapped?: boolean;
  /** Library only: where to put it. Defaults to 'top'. Index 0 is the top. */
  libraryPosition?: 'top' | 'bottom';
}

/** Remove `obj` from whatever zone container currently holds it. */
export function removeFromCurrentZone(ctx: GameContext, obj: EngineObject): void {
  const s = ctx.state;
  const pull = (arr: { id: ObjectId }[]): void => {
    const i = arr.findIndex((o) => o.id === obj.id);
    if (i >= 0) arr.splice(i, 1);
  };
  switch (obj.zone) {
    case 'battlefield':
      pull(s.battlefield);
      break;
    case 'exile':
      pull(s.exile);
      break;
    case 'stack':
      // A spell's card object is embedded in its stack entry; the stack entry itself is
      // removed by the resolution/counter code.
      break;
    case 'hand':
      pull(playerById(ctx, obj.ownerId).hand);
      break;
    case 'library':
      pull(playerById(ctx, obj.ownerId).library);
      break;
    case 'graveyard':
      pull(playerById(ctx, obj.ownerId).graveyard);
      break;
    case 'command':
      pull(playerById(ctx, obj.ownerId).commandZone);
      break;
  }
}

/** Clone `obj` as a brand-new object (new `ObjectId`) in `zone` (CR 400.7). */
function reincarnate(ctx: GameContext, obj: EngineObject, zone: Zone): EngineCardObject {
  return {
    id: newObjectId(ctx),
    cardId: obj.cardId,
    oracleId: obj.oracleId,
    ownerId: obj.ownerId,
    name: obj.name,
    typeLine: obj.typeLine,
    oracleText: obj.oracleText,
    manaCost: obj.manaCost,
    isToken: obj.isToken,
    isCommander: obj.isCommander,
    zone,
  };
}

/** Build the battlefield form of an object (used by moveObject and by casting). */
export function makePermanent(
  ctx: GameContext,
  obj: EngineObject,
  controllerId: PlayerId,
  /**
   * Tapped-ness already decided by an as-enters replacement (`entersTappedUnless`). Resolved by
   * the caller because that condition can be a *choice* ("you may pay 2 life"), and this
   * function is not a generator so it cannot ask.
   */
  entersTappedOverride?: boolean,
): EnginePermanent {
  const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
  // Planeswalkers/battles enter with their printed loyalty/defense (CR 306.5b, 310.6).
  const counters: Record<string, number> = {};
  if (def.types.includes('Planeswalker') && def.loyalty !== null) counters['loyalty'] = def.loyalty;
  if (def.types.includes('Battle') && def.defense !== null) counters['defense'] = def.defense;
  // "~ enters with N +1/+1 counters on it" is a replacement effect (CR 614.1c): the counters
  // are already there as it enters, so it is never momentarily 0-toughness.
  for (const [counter, n] of Object.entries(def.entersWithCounters ?? {})) {
    counters[counter] = (counters[counter] ?? 0) + n;
  }
  return {
    ...reincarnate(ctx, obj, 'battlefield'),
    zone: 'battlefield',
    controllerId,
    tapped: entersTappedOverride ?? def.entersTapped,
    power: def.power,
    toughness: def.toughness,
    damageMarked: 0,
    counters,
    statuses: [],
    summoningSick: true,
    attachedTo: null,
    attacking: null,
    blocking: null,
    blockedByOrdered: [],
    damagedByDeathtouch: false,
    dealtFirstStrikeDamage: false,
    timestamp: ctx.state.nextTimestamp++,
  };
}

/**
 * Move an object to a new zone, yielding the new object (or null when a token ceases to
 * exist). Emits the zone-change event, applies the CR 903.9b commander replacement, sets
 * the CR 903.9a bookkeeping flag, and queues ETB/dies triggers.
 */
export function* moveObject(
  ctx: GameContext,
  obj: EngineObject,
  dest: MoveDestination,
): GameGen<EngineCardObject | EnginePermanent | null> {
  const from = obj.zone;
  let target: MoveDestination = dest;

  // CR 903.9b — commander headed to hand or library: owner may redirect to command zone.
  if (obj.isCommander && (dest.zone === 'hand' || dest.zone === 'library')) {
    const outcome = yield {
      decisionType: 'commanderReplacement',
      player: obj.ownerId,
      prompt: `${obj.name} would be put into your ${dest.zone}. Put it into the command zone instead?`,
      options: [
        { type: 'commanderToCommandZone', description: `Put ${obj.name} into the command zone` },
        { type: 'keepMoving', description: `Let ${obj.name} go to your ${dest.zone}` },
      ],
    };
    if (outcome.index === 0) target = { zone: 'command' };
  }

  removeFromCurrentZone(ctx, obj);

  // Tokens cease to exist when they leave the battlefield (CR 704.5d; applied directly
  // on the move rather than at the next SBA check — indistinguishable in Phase 2).
  if (obj.isToken && from === 'battlefield' && target.zone !== 'battlefield') {
    emit(ctx, 'tokenCeased', { name: obj.name, cardId: obj.cardId });
    debug(ctx, 'zoneChange', `token ${obj.name} ceased to exist`);
    queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
    return null;
  }

  let next: EngineCardObject | EnginePermanent;
  if (target.zone === 'battlefield') {
    const controllerId = target.controllerId ?? obj.ownerId;
    // As-enters replacement (CR 614.1c): "enters tapped unless <condition>". Resolved BEFORE
    // the permanent exists, so it is never momentarily tapped-then-untapped — and because the
    // condition may be a choice ("you may pay 2 life"), it is resolved here, in the generator.
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
    let entersTappedOverride: boolean | undefined;
    if (def.entersTappedUnless !== undefined) {
      const met = yield* resolveCondition(
        ctx,
        def.entersTappedUnless,
        { cardId: obj.cardId, controllerId },
        obj.name,
      );
      entersTappedOverride = !met;
    }
    if (target.entersTapped === true) entersTappedOverride = true;
    const perm = makePermanent(ctx, obj, controllerId, entersTappedOverride);
    ctx.state.battlefield.push(perm);
    next = perm;
  } else {
    next = reincarnate(ctx, obj, target.zone);
    const owner = playerById(ctx, obj.ownerId);
    switch (target.zone) {
      case 'hand':
        owner.hand.push(next);
        break;
      case 'graveyard':
        owner.graveyard.push(next); // last element = top of graveyard
        break;
      case 'command':
        owner.commandZone.push(next);
        break;
      case 'exile':
        ctx.state.exile.push(next);
        break;
      case 'library':
        if ((target.libraryPosition ?? 'top') === 'top') owner.library.unshift(next);
        else owner.library.push(next);
        break;
      case 'stack':
        // The caller (casting code) owns placing the object into its stack entry.
        break;
    }
  }

  // CR 903.9a — commander newly in graveyard/exile: flag for the next SBA check.
  if (next.isCommander && (target.zone === 'graveyard' || target.zone === 'exile')) {
    (next as EngineCardObject).commanderSbaPending = true;
  }

  emit(ctx, 'zoneChange', {
    cardId: obj.cardId,
    name: obj.name,
    from,
    to: target.zone,
    owner: obj.ownerId,
    newObjectId: next.id,
  });
  debug(ctx, 'zoneChange', `${obj.name}: ${from} → ${target.zone}`, { cardId: obj.cardId });

  // Triggers: enters on arriving, dies on battlefield → graveyard.
  if (target.zone === 'battlefield' && from !== 'battlefield') {
    queueTriggersForEvent(ctx, 'enters', next as EnginePermanent);
  }
  if (from === 'battlefield') {
    queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
  }

  return next;
}

/**
 * Queue every ability that triggers on `subject`'s event (CR 603.3b).
 *
 * Two vantage points, one mechanism. The subject's OWN abilities fire on `{kind:'self'}`; every
 * other battlefield permanent's abilities fire if their selector matches the subject ("whenever
 * a Dragon you control attacks"). So this scans the whole battlefield, not just the object the
 * event happened to.
 *
 * Everything is read from *current* characteristics. For a `dies` event the permanent has
 * already left, so that is last-known information — continuous effects from other permanents
 * still applied to it, and that is what decides whether it had the trigger at all.
 */
export function queueTriggersForEvent(
  ctx: GameContext,
  when: 'enters' | 'dies' | 'attacks',
  subject: EnginePermanent,
): void {
  // A dying permanent is gone from the battlefield but is still an ability source for its own
  // "when this dies" trigger, so it has to be added back as a candidate source.
  const sources = ctx.state.battlefield.some((p) => p.cardId === subject.cardId)
    ? ctx.state.battlefield
    : [...ctx.state.battlefield, subject];

  for (const source of [...sources]) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;

      const from: SelectorSource = { cardId: source.cardId, controllerId: source.controllerId };
      const matches =
        spec.subject.kind === 'self'
          ? source.cardId === subject.cardId
          : matchesSelector(ctx, subject, spec.subject.selector, from);
      if (!matches) continue;

      // Intervening-if, first check (CR 603.4): a trigger whose condition is false right now
      // never goes on the stack at all.
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, from)) {
        debug(ctx, 'stack', `trigger not queued: ${source.name} — intervening-if false`);
        continue;
      }

      ctx.state.pendingTriggers.push({
        controllerId: source.controllerId,
        sourceCardId: source.cardId,
        sourceOracleId: source.oracleId,
        sourceName: source.name,
        ability,
        // Only meaningful when the subject is something other than the source itself.
        ...(spec.subject.kind === 'self' ? {} : { triggerObjectCardId: subject.cardId }),
      });
      debug(ctx, 'stack', `trigger queued: ${source.name} — ${ability.description ?? ''}`);
    }
  }
}

function queueLeaveBattlefieldTriggers(ctx: GameContext, obj: EngineObject, to: Zone): void {
  // "dies" means battlefield → graveyard (CR 700.4). The pre-move battlefield object
  // carries the controller.
  if (to !== 'graveyard') return;
  const perm = obj as EnginePermanent;
  if (perm.controllerId === undefined) return;
  queueTriggersForEvent(ctx, 'dies', perm);
}
