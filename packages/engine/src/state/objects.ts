import { counterCount, setCounterCount } from './counters';
import { offBattlefieldTypes } from './off-battlefield-types';
import { playerProtectedFromEverything } from './phasing';
import { selectedPermanentDefinition } from '../cards/spell-faces';
import { assertTriggerEventFamily } from '../cards/trigger-contracts';
import { attackedPlaneswalker, spellDefinitionOf, canBeSacrificed, isModified } from './queries';
/**
 * Object identity and zone movement (CR 400.7, brief §5.2). A card changing zones becomes
 * a NEW object with a new `ObjectId`; the stable `cardId` links its zone-visits together.
 *
 * `moveObject` is a generator because moving a commander into its owner's hand or library
 * asks the owner whether to put it into the command zone instead (CR 903.9b — an AI
 * decision, brief §5.7). Graveyard/exile command-zone returns are a state-based action
 * (CR 903.9a) handled by the SBA loop, not here.
 */

import type { ObjectId, OracleId, PlayerId, Zone } from '@mtg/shared';
import { computeTargetOptions } from '../actions/legal';
import { BESTOW_ENCHANT } from '../cards/spell-faces';
import type {
  Ability,
  Effect,
  KeywordAbility,
  ObjectTriggerWhen,
  StackAbilitySnapshot,
  TokenSpec,
  TriggerSpec,
} from '../cards/ability';
import { captureObjectFacts, eventObjectScope } from '../cards/source-identity';
import type { ObjectFacts } from '../cards/source-identity';
import { evaluateCondition, resolveCondition } from '../cards/condition';
import type { BackFace, CardDefinition, StaticEffect } from '../cards/definition';
import { assertValidModeledDefinition } from '../cards/authoring-validation';
import type { Selector, SelectorCandidate, SelectorSource } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import type { TriggerScope } from '../cards/value';
import { evaluateValue } from '../cards/value';
import type { GameGen } from '../decisions';
import { chooseCard } from '../effects/choose';
import { evaluateValueIn } from '../effects/values';
import {
  candidateOf,
  computeCharacteristics,
  matchesSelector,
  selectPermanents,
} from '../effects/continuous';
import { CREATURE_TYPES } from '../cards/creature-types';
import { debug, emit } from '../log/log';
import {
  cardZoneCandidate,
  counterAmountAfterReplacements,
  counterAmountAfterReplacementsForCandidate,
  colorsOf,
  damageKeywordsOf,
  getDefByOracleId,
  gatherRuleStatics,
  hasProtectionFrom,
  opponentsOf,
  tokenCreationMultiplierFor,
  triggersOf,
} from './queries';
import type {
  CardId,
  ControlChange,
  ControlChangeDuration,
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
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
  /** Why the object entered the graveyard, when this move is an explicit sacrifice. */
  reason?: 'sacrifice';
  /** Internal simultaneous-move batch: leave processing is owned by the batch. */
  deferLeaveProcessing?: boolean;
  /** Shared pre-event snapshot for an internal simultaneous departure batch. */
  lastKnownFacts?: ObjectFacts;
  /** Internal card-zone batch: queue one aggregate departure event after every move completes. */
  deferCardZoneTriggers?: boolean;
  /** Internal battlefield batch: enters triggers are queued once every object has entered. */
  deferEntersTriggers?: boolean;
  /** Battlefield only: the controller it enters under (defaults to its owner). */
  controllerId?: PlayerId;
  /** Aura host chosen when casting, attached before entry triggers are collected. */
  attachedTo?: ObjectId;
  /** Battlefield only: it enters as a bestowed Aura (CR 702.103b), attached to `attachedTo`. */
  bestowed?: true;
  /** Battlefield only: choose the back face of an MDFC land // spell. */
  face?: 'front' | 'back';
  /**
   * Battlefield only: the moving EFFECT says it enters tapped ("put it onto the battlefield
   * tapped"). Independent of the card's own `entersTapped`/`entersTappedUnless`, and decisive:
   * a condition that would have let it enter untapped cannot untap it (CR 614.1c).
   */
  entersTapped?: boolean;
  /** Manifest: enter with face-down characteristics before replacements and triggers. */
  faceDown?: boolean;
  /** With `faceDown`: it was manifested, so a creature card can be turned face up for its mana
   * cost (CR 701.40b). A face-down spell that resolves is not manifested. */
  manifested?: true;
  /** Library only: where to put it. Defaults to 'top'. Index 0 is the top. */
  libraryPosition?: 'top' | 'bottom';
  /**
   * Library only: this many cards from the top go above it ("third from the top" is 2). A
   * library with fewer cards takes it on the bottom (CR 401.7). Overrides `libraryPosition`.
   */
  libraryCardsAbove?: number;
  /**
   * Battlefield only: the moving effect says it enters with these counters ("return it … with a
   * -1/-1 counter on it", persist). They are on it as it enters, alongside its own
   * enters-with-counters, and counter replacements apply to them (CR 614.1c).
   */
  withCounters?: Record<string, number>;
  /**
   * Battlefield only: the moving effect gives it these card types in addition to its others
   * ("They're artifacts in addition to their other types"). The effect is in place as it enters,
   * so enters triggers see the new types, and it lasts for as long as it stays this object.
   */
  addTypes?: string[];
}

/**
 * CR 400.7: a resolved effect's fixed set never follows a card into a new incarnation, so a
 * permanent that has left is dropped from every fixed effect.
 */
function releaseFixedEffects(ctx: GameContext, cardId: CardId): void {
  ctx.state.effects = ctx.state.effects.filter((effect) => {
    if (!effect.targetCardIds.includes(cardId)) return true;
    effect.targetCardIds = effect.targetCardIds.filter((id) => id !== cardId);
    // A fixed set that has lost its last member affects nothing ever again.
    return effect.targetCardIds.length > 0;
  });
}

/**
 * Remove `obj` from whatever zone container currently holds it. A permanent leaving releases
 * its fixed effects at once, unless the caller still needs its last known characteristics
 * (`moveObject`, which releases them after leave processing).
 */
export function removeFromCurrentZone(
  ctx: GameContext,
  obj: EngineObject,
  keepEffectsForLastKnownInformation = false,
): void {
  const s = ctx.state;
  const pull = (arr: { id: ObjectId }[]): void => {
    const i = arr.findIndex((o) => o.id === obj.id);
    if (i >= 0) arr.splice(i, 1);
  };
  switch (obj.zone) {
    case 'battlefield':
      if (!keepEffectsForLastKnownInformation) releaseFixedEffects(ctx, obj.cardId);
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

function mdfcLandFaceFor(ctx: GameContext, obj: EngineObject) {
  if (obj.face !== 'back') return undefined;
  return ctx.defs.get(obj.oracleId)?.alternativeCasts?.find((alt) => alt.kind === 'mdfc')?.landFace;
}

/** Clone `obj` as a brand-new object (new `ObjectId`) in `zone` (CR 400.7). */
function reincarnate(ctx: GameContext, obj: EngineObject, zone: Zone): EngineCardObject {
  const original = obj.zone === 'battlefield' ? (obj as EnginePermanent).copyOriginal : undefined;
  const frontDef = ctx.defs.get(original?.oracleId ?? obj.oracleId);
  const modalFace =
    obj.face === 'back'
      ? frontDef?.alternativeCasts?.find(
          (alt) => alt.kind === 'mdfc' && alt.spellFace !== undefined,
        )
      : undefined;
  const landFace = mdfcLandFaceFor(ctx, obj);
  const transformFace = frontDef?.backFace;
  const castFromStack = obj.zone === 'stack' && zone === 'battlefield';
  return {
    id: newObjectId(ctx),
    cardId: obj.cardId,
    oracleId: original?.oracleId ?? obj.oracleId,
    ownerId: obj.ownerId,
    name:
      (original !== undefined ? frontDef?.name : undefined) ??
      (zone === 'battlefield' && landFace !== undefined
        ? landFace.name
        : ((zone === 'battlefield' ? modalFace?.spellFace?.name : undefined) ??
          frontDef?.name ??
          obj.name)),
    typeLine:
      (original !== undefined ? frontDef?.typeLine : undefined) ??
      (zone === 'battlefield' && landFace !== undefined
        ? landFace.typeLine
        : ((zone === 'battlefield' ? modalFace?.spellFace?.typeLine : undefined) ??
          frontDef?.typeLine ??
          obj.typeLine)),
    oracleText:
      (original !== undefined
        ? (frontDef?.backFace?.frontOracleText ?? original.oracleText)
        : undefined) ??
      (zone === 'battlefield' && landFace !== undefined
        ? landFace.oracleText
        : ((zone === 'battlefield'
            ? modalFace?.spellFaceText?.oracleText
            : modalFace?.spellFaceText?.frontOracleText) ??
          landFace?.frontOracleText ??
          transformFace?.frontOracleText ??
          obj.oracleText)),
    manaCost:
      original !== undefined
        ? frontDef?.backFace !== undefined
          ? frontDef.backFace.frontManaCostText
          : original.manaCost
        : zone === 'battlefield' && landFace !== undefined
          ? landFace.manaCost
          : ((zone === 'battlefield'
              ? modalFace?.spellFaceText?.manaCost
              : modalFace?.spellFaceText?.frontManaCost) ??
            landFace?.frontManaCost ??
            transformFace?.frontManaCostText ??
            obj.manaCost),
    isToken: obj.isToken,
    ...(obj.isCardCopy === true ? { isCardCopy: true } : {}),
    isCommander: obj.isCommander,
    zone,
    ...(zone === 'battlefield' && obj.face !== undefined ? { face: obj.face } : {}),
    ...(zone === 'battlefield' && obj.escaped === true ? { escaped: true } : {}),
    // How a spell was cast — its X and any kicker-style payments — describes the permanent that
    // spell becomes (CR 107.3m, 702.33d), and nothing after: a kicked creature that dies and is
    // reanimated was not kicked, and an X creature put onto the battlefield later has X = 0.
    ...(castFromStack && (obj as EngineCardObject).announcedX !== undefined
      ? { announcedX: (obj as EngineCardObject).announcedX }
      : {}),
    ...(castFromStack && (obj as EngineCardObject).optionalCostCounts !== undefined
      ? { optionalCostCounts: { ...(obj as EngineCardObject).optionalCostCounts } }
      : {}),
    ...(castFromStack && (obj as EngineCardObject).castByPlayerId !== undefined
      ? {
          castByPlayerId: (obj as EngineCardObject).castByPlayerId,
          castFromZone: (obj as EngineCardObject).castFromZone,
          manaSpentToCast: (obj as EngineCardObject).manaSpentToCast ?? 0,
        }
      : {}),
  };
}
/**
 * Apply a control-changing effect without replacing the permanent's initial controller
 * (`defaultControllerId`). EVERY effect is recorded — including one naming the controller the
 * permanent already answers to — so an effect expiring later can still fall back to the
 * record underneath it (`refreshControlEffects`). Each record carries a fresh *effect*
 * timestamp; the permanent's own layer timestamp is left untouched (CR 613.7).
 *
 * Only an ACTUAL controller transition is an event: it sets summoning sickness (CR 302.6) and
 * removes the permanent from combat (CR 506.4).
 */
export function changeController(
  ctx: GameContext,
  perm: EnginePermanent,
  controllerId: PlayerId,
  duration: ControlChangeDuration = { kind: 'permanent' },
): void {
  // CR 800.4b: an object cannot change control to a player who left the game.
  if (ctx.state.players.some((player) => player.id === controllerId && player.hasLost)) return;
  if (duration.kind === 'whileSourceOnBattlefield') {
    const { sourceObjectId } = duration;
    if (!ctx.state.battlefield.some((source) => source.id === sourceObjectId)) return;
  }
  // A newer permanent record for the same player outlives an older one exactly as long (both end
  // only when that player leaves), so the older can never decide control: drop it to keep a
  // repeating rotation (upkeep control swaps) from growing the stack without bound.
  const kept =
    duration.kind === 'permanent'
      ? (perm.controlChanges ?? []).filter(
          (entry) => !(entry.duration.kind === 'permanent' && entry.controllerId === controllerId),
        )
      : (perm.controlChanges ?? []);
  perm.controlChanges = [...kept, { controllerId, timestamp: ctx.state.nextTimestamp++, duration }];
  applyControllerTransition(ctx, perm, controllerId);
}

/**
 * Keep the defending player of the attack combat assignment is about to end (CR 508.5). Called
 * immediately before every path clears `attacking` — removal from combat, a controller change,
 * combat cleanup, phasing, a player leaving — so an intervening-if over the exact original
 * attacker (Kazuul's "if you're the defending player") still answers with the LAST defending
 * player instead of losing the event. A still-current `attacking` wins at the read site; a new
 * attack simply overwrites this through the same retain-then-clear order.
 */
export function retainAttackDefender(perm: EnginePermanent): void {
  if (perm.attacking !== null) perm.lastAttackingDefendingPlayerId = perm.attacking;
}

/** Both a new effect and an expired effect can cause a controller transition (CR 302.6, 506.4). */
function applyControllerTransition(
  ctx: GameContext,
  perm: EnginePermanent,
  controllerId: PlayerId,
): void {
  // A duration can end after the initial controller departed. The object keeps its current
  // controller in that case (CR 800.4b); this is not a new control-changing effect.
  if (ctx.state.players.some((player) => player.id === controllerId && player.hasLost)) return;
  const transition = perm.controllerId !== controllerId;
  perm.controllerId = controllerId;
  if (!transition) return;
  perm.summoningSick = true;
  retainAttackDefender(perm);
  perm.attacking = null;
  perm.attackingPlaneswalker = null;
  perm.attackedPlaneswalkerRemoved = false;
  perm.blocking = null;
  perm.statuses = perm.statuses.filter((status) => status !== 'attacking' && status !== 'blocking');
  // A planeswalker that changes controller is removed from combat (CR 506.4): creatures attacking
  // it stay attacking but attack nothing. Marked here, not lazily, so regaining it can't undo that.
  for (const attacker of ctx.state.battlefield) {
    if (attacker.attackingPlaneswalker === perm.id && attacker.attacking !== controllerId) {
      attacker.attackedPlaneswalkerRemoved = true;
    }
  }
}

/** Current controller, with a record/entry fallback for card-shaped control-history queries. */
export function controlledBy(perm: {
  controllerId?: PlayerId;
  controlChanges?: ControlChange[];
  defaultControllerId?: PlayerId;
  ownerId: PlayerId;
}): PlayerId {
  return (
    perm.controllerId ??
    perm.controlChanges?.at(-1)?.controllerId ??
    perm.defaultControllerId ??
    perm.ownerId
  );
}

/**
 * Expire control-change records whose duration has ended and recompute the controller: the
 * latest surviving record, else the controller it entered under, else its owner (CR 613.7
 * ordering — records are resolution-ordered, the newest one wins while it survives).
 *
 * Losing three kinds of duration run through here:
 *   - recipient departed the game (CR 800.4e), even buried underneath newer records;
 *   - a `whileSourceOnBattlefield` record whose source no longer has that exact object id on
 *     the battlefield: the source left, or phased out (CR 702.26f), or blinked into a NEW
 *     incarnation that no record tracks (CR 400.7);
 *   - an `untilEndOfTurn` record, at the cleanup step (CR 514.2) — phased-out permanents
 *     included, they still expire on schedule.
 *
 * Reversion records no new effect or timestamp. An actual controller transition still updates
 * summoning sickness and combat, exactly as when a new effect changes the controller.
 */
export function refreshControlEffects(
  ctx: GameContext,
  perm: EnginePermanent,
  opts?: { expireEndOfTurn?: boolean },
): void {
  if (perm.controlChanges === undefined) return;
  const surviving = perm.controlChanges.filter((entry) => {
    if (ctx.state.players.some((p) => p.id === entry.controllerId && p.hasLost)) return false;
    switch (entry.duration.kind) {
      case 'permanent':
        return true;
      case 'whileSourceOnBattlefield': {
        const { sourceObjectId } = entry.duration;
        return ctx.state.battlefield.some((p) => p.id === sourceObjectId);
      }
      case 'untilEndOfTurn':
        return !(opts?.expireEndOfTurn ?? false);
    }
  });
  if (surviving.length === 0) delete perm.controlChanges;
  else perm.controlChanges = surviving;
  const nextController = surviving.at(-1)?.controllerId ?? perm.defaultControllerId ?? perm.ownerId;
  applyControllerTransition(ctx, perm, nextController);
}

/**
 * Expire (via `refreshControlEffects`) every control-change record that tracks `sourceObjectId`
 * — the source just left the battlefield, so "for as long as …" ends for every other permanent
 * it held (CR 611.2b). The source's own copies die with it when it reincarnates.
 */
export function expireSourceControlEffects(ctx: GameContext, sourceObjectId: ObjectId): void {
  for (const perm of [
    ...ctx.state.battlefield,
    ...(ctx.state.phasedOut ?? []).map((record) => record.permanent),
  ]) {
    if (
      !perm.controlChanges?.some(
        (entry) =>
          entry.duration.kind === 'whileSourceOnBattlefield' &&
          entry.duration.sourceObjectId === sourceObjectId,
      )
    )
      continue;
    refreshControlEffects(ctx, perm);
  }
}

/** What a face-down permanent is called while face down (CR 708.2a). */
export const FACE_DOWN_PERMANENT_NAME = 'Face-down permanent';

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
  faceDown = false,
  /** Counters a moving effect puts on it as it enters (`MoveDestination.withCounters`). */
  entryCounters: Record<string, number> = {},
): EnginePermanent {
  const def = selectedPermanentDefinition(getDefByOracleId(ctx, obj.oracleId, obj.name), obj.face);
  const landFace = mdfcLandFaceFor(ctx, obj);
  // Planeswalkers/battles enter with their printed loyalty/defense (CR 306.5b, 310.6).
  const counters: Record<string, number> = {};
  if (
    !faceDown &&
    landFace === undefined &&
    def.types.includes('Planeswalker') &&
    def.loyalty !== null
  )
    counters['loyalty'] = def.loyalty;
  if (!faceDown && landFace === undefined && def.types.includes('Battle') && def.defense !== null)
    counters['defense'] = def.defense;
  // A Saga enters with a lore counter (CR 714.3a), which triggers its chapter I (CR 714.2b).
  if (!faceDown && landFace === undefined && def.subtypes.includes('Saga')) counters['lore'] = 1;
  // "~ enters with N +1/+1 counters on it" is a replacement effect (CR 614.1c): the counters
  // are already there as it enters, so it is never momentarily 0-toughness.
  const valueScope = {
    controllerId,
    sourceCardId: obj.cardId,
    ...((obj as EngineCardObject).announcedX !== undefined
      ? { x: (obj as EngineCardObject).announcedX }
      : {}),
    ...((obj as EngineCardObject).treasureManaSpentToCast !== undefined
      ? { treasureManaSpent: (obj as EngineCardObject).treasureManaSpentToCast }
      : {}),
  };
  for (const [counter, value] of Object.entries(
    !faceDown && landFace === undefined ? (def.entersWithCounters ?? {}) : {},
  )) {
    const amount = typeof value === 'number' ? value : evaluateValueIn(ctx, value, valueScope);
    setCounterCount(counters, counter, counterCount(counters, counter) + amount);
  }
  for (const [counter, amount] of Object.entries(entryCounters))
    setCounterCount(counters, counter, counterCount(counters, counter) + amount);
  // Static entry replacements are generated by permanents already on the battlefield. Evaluate
  // the incoming card by its printed characteristics, as CR 614.1c does before it exists.
  const incoming = cardZoneCandidate(ctx, obj as EngineCardObject, controllerId, def);
  if (landFace !== undefined)
    Object.assign(incoming, {
      types: landFace.types,
      supertypes: landFace.supertypes,
      subtypes: landFace.subtypes,
      colors: landFace.colors,
      power: 0,
      powerUnknown: true,
      keywords: [],
      manaValue: 0,
    });
  if (faceDown)
    Object.assign(incoming, {
      types: ['Creature'],
      supertypes: [],
      subtypes: [],
      colors: [],
      keywords: [],
      power: 2,
      toughness: 2,
      manaValue: 0,
    });
  for (const source of ctx.state.battlefield) {
    if (source.faceDown || ctx.enteringTogether?.has(source.cardId) === true) continue;
    const sourceDef = selectedPermanentDefinition(
      getDefByOracleId(ctx, source.oracleId, source.name),
      source.face,
    );
    for (const replacement of sourceDef.additionalCountersOnEntry ?? []) {
      if (
        !selectMatches(incoming, replacement.affects, {
          cardId: source.cardId,
          controllerId: source.controllerId,
        })
      )
        continue;
      const amount = evaluateValueIn(ctx, replacement.count, {
        ...valueScope,
        controllerId: source.controllerId,
        sourceCardId: source.cardId,
      });
      setCounterCount(
        counters,
        replacement.counter,
        counterCount(counters, replacement.counter) + amount,
      );
    }
  }
  for (const [counter, amount] of Object.entries(counters)) {
    setCounterCount(
      counters,
      counter,
      counterAmountAfterReplacementsForCandidate(ctx, incoming, counter, amount),
    );
  }
  const externallyTapped = gatherRuleStatics(ctx).some(
    (entry) =>
      entry.static.kind === 'otherPermanentsEnterTapped' &&
      ctx.enteringTogether?.has(entry.sourceCardId) !== true &&
      selectMatches(incoming, entry.static.filter, {
        cardId: entry.sourceCardId,
        controllerId: entry.controllerId,
      }),
  );
  return {
    ...reincarnate(ctx, obj, 'battlefield'),
    // A face-down permanent has no name (CR 708.2a): every event, prompt and view that names it
    // reads this, so its identity reaches no other player. The definition keeps the real one.
    ...(faceDown ? { name: FACE_DOWN_PERMANENT_NAME } : {}),
    zone: 'battlefield',
    controllerId,
    defaultControllerId: controllerId,
    transformed: false,
    tapped:
      externallyTapped ||
      (entersTappedOverride ?? (faceDown ? false : (landFace?.entersTapped ?? def.entersTapped))),
    faceDown,
    power: landFace === undefined ? def.power : null,
    toughness: landFace === undefined ? def.toughness : null,
    damageMarked: 0,
    counters,
    statuses: [],
    summoningSick: true,
    attachedTo: null,
    attacking: null,
    attackingPlaneswalker: null,
    attackedPlaneswalkerRemoved: false,
    blocking: null,
    blockedByOrdered: [],
    damagedByDeathtouch: false,
    regenerationShields: 0,
    dealtFirstStrikeDamage: false,
    ...(!faceDown && def.cantBlock === true ? { cantBlock: true } : {}),
    ...(!faceDown && def.cantBeBlocked === true ? { cantBeBlocked: true } : {}),
    timestamp: ctx.state.nextTimestamp++,
    activationsThisTurn: [],
    enteredTurnNumber: ctx.state.turnNumber,
    // A token stub or permanent-spell copy is built in the battlefield zone: it entered from
    // nowhere, so no origin-zone trigger condition can match it.
    ...(obj.zone === 'battlefield' ? {} : { enteredFromZone: obj.zone }),
    ...((obj as EngineCardObject).optionalCostCounts?.kicker
      ? { wasKicked: true, kicked: true }
      : {}),
  };
}

/**
 * Remove a permanent from combat (CR 506.4): it stops being an attacking, blocking, blocked or
 * unblocked creature. An attacker it was blocking REMAINS blocked (CR 509.1h), so its id stays in
 * that attacker's `blockedByOrdered`; it just no longer counts as a live blocker.
 */
export function removeFromCombat(ctx: GameContext, perm: EnginePermanent): void {
  retainAttackDefender(perm);
  perm.attacking = null;
  perm.attackingPlaneswalker = null;
  perm.attackedPlaneswalkerRemoved = false;
  perm.blocking = null;
  perm.blockedByOrdered = [];
  perm.statuses = perm.statuses.filter((st) => st !== 'attacking' && st !== 'blocking');
  for (const other of ctx.state.battlefield) {
    if (other.blocking === perm.id) other.blocking = null;
  }
}

/**
 * Apply a one-shot regeneration replacement (CR 701.19a). Returns true when destruction was
 * replaced. A "can't be regenerated" destruction bypasses the shield without consuming it.
 */
export function consumeRegenerationShield(
  ctx: GameContext,
  perm: EnginePermanent,
  cantRegenerate = false,
): boolean {
  if (cantRegenerate || perm.regenerationShields <= 0) return false;
  perm.regenerationShields--;
  perm.damageMarked = 0;
  perm.damagedByDeathtouch = false;
  perm.tapped = true;
  // Removed from combat (CR 701.19c).
  removeFromCombat(ctx, perm);
  emit(
    ctx,
    'regenerated',
    { permanent: perm.name, remainingShields: perm.regenerationShields },
    perm.controllerId,
  );
  return true;
}

/** Regeneration shields last only through the current turn (CR 701.19a). */
export function expireRegenerationShields(ctx: GameContext): void {
  for (const perm of [
    ...ctx.state.battlefield,
    ...(ctx.state.phasedOut ?? []).map((record) => record.permanent),
  ])
    perm.regenerationShields = 0;
}

/** Transform a permanent in place without changing its object identity or attached state. */
export function transformPermanent(ctx: GameContext, perm: EnginePermanent): boolean {
  const def = getDefByOracleId(ctx, perm.copyOriginal?.oracleId ?? perm.oracleId, perm.name);
  if (def.backFace === undefined) return false;

  const nextFace = perm.transformed ? def : def.backFace;
  if (nextFace.types.some((type) => type === 'Instant' || type === 'Sorcery')) return false;

  perm.transformed = !perm.transformed;
  perm.transformations = (perm.transformations ?? 0) + 1;
  // A copy effect continues to apply when the physical DFC turns over (CR 712.20).
  if (perm.copyOriginal === undefined) {
    const face = perm.transformed ? def.backFace : def;
    perm.name = face.name;
    perm.typeLine = face.typeLine;
    perm.oracleText = perm.transformed ? def.backFace.oracleText : def.backFace.frontOracleText;
    perm.manaCost = (
      perm.transformed ? def.backFace.manaCostText : def.backFace.frontManaCostText
    ) as EnginePermanent['manaCost'];
    perm.power = face.power;
    perm.toughness = face.toughness;
    if (face.cantBlock === true) perm.cantBlock = true;
    else delete perm.cantBlock;
    if (face.cantBeBlocked === true) perm.cantBeBlocked = true;
    else delete perm.cantBeBlocked;
  }

  emit(ctx, 'transform', {
    cardId: perm.cardId,
    name: perm.name,
    face: perm.transformed ? 'back' : 'front',
  });
  queueTriggersForObject(ctx, 'transformsInto', perm);
  return true;
}
export interface ApplyCopyOptions {
  /** Reverted at cleanup instead of persisting (Living Energy's temporary clone). */
  untilEot?: boolean | undefined;
  /** "…except it's also an artifact" (Phyrexian Metamorph)-style additions. */
  addTypes?: string[] | undefined;
  /** Keywords the copy has that the copied object doesn't (Dack's Duplicate's "and has haste"). */
  addKeywords?: KeywordAbility[] | undefined;
  /** Triggered abilities the copy has that the copied object doesn't, for mechanics with no
   * generic keyword representation (Dack's Duplicate's "and has dethrone"). */
  addTriggers?: Ability[] | undefined;
  /** Supertypes stripped from the copy ("except it isn't legendary" — Spark Double). */
  removeSupertypes?: string[] | undefined;
  /** Static abilities folded into the copiable values (CR 707.9b — Mocking Doppelganger). */
  addStaticEffects?: StaticEffect[] | undefined;
  /** Supertypes the copy has that the copied object doesn't ("it's legendary in addition to
   * its other types" — Sarkhan, Soul Aflame). */
  addSupertypes?: string[] | undefined;
  /** Name kept instead of the copied object's ("except its name is Sarkhan, Soul Aflame" —
   * Sarkhan, Soul Aflame). */
  nameOverride?: string | undefined;
}

/**
 * Rewrite `perm`'s copiable values (CR 707.2) to `target`'s. Snapshots `perm`'s own printed
 * identity the first time (`copyOriginal`) so a later zone change — or, for `untilEot`,
 * cleanup — can restore it; a copy never survives past the object it copied onto.
 */
export function applyCopy(
  ctx: GameContext,
  perm: EnginePermanent,
  target: EnginePermanent,
  opts: ApplyCopyOptions = {},
): void {
  const base = copiableDefinition(ctx, target);
  const copied =
    opts.addStaticEffects === undefined || opts.addStaticEffects.length === 0
      ? base
      : { ...base, staticEffects: [...base.staticEffects, ...opts.addStaticEffects] };
  const imageFace = copyImageFace(ctx, target);
  perm.copyOriginal ??= {
    oracleId: perm.oracleId,
    name: perm.name,
    typeLine: perm.typeLine,
    oracleText: perm.oracleText,
    manaCost: perm.manaCost,
    power: perm.power,
    toughness: perm.toughness,
  };
  perm.oracleId = internCopyDefinition(ctx, copied);
  perm.copyImageFace = imageFace;
  perm.name = opts.nameOverride ?? copied.name;
  perm.typeLine = copied.typeLine;
  perm.oracleText = target.faceDown ? '' : target.oracleText;
  perm.manaCost = target.faceDown ? null : target.manaCost;
  perm.power = copied.power;
  perm.toughness = copied.toughness;
  if (copied.cantBlock) perm.cantBlock = true;
  else delete perm.cantBlock;
  if (copied.cantBeBlocked) perm.cantBeBlocked = true;
  else delete perm.cantBeBlocked;
  perm.copyAddTypes = opts.addTypes === undefined ? [] : [...opts.addTypes];
  perm.copyAddKeywords = opts.addKeywords === undefined ? [] : [...opts.addKeywords];
  perm.copyAddTriggers = opts.addTriggers === undefined ? [] : [...opts.addTriggers];
  perm.copyRemoveSupertypes = opts.removeSupertypes === undefined ? [] : [...opts.removeSupertypes];
  perm.copyAddSupertypes = opts.addSupertypes === undefined ? [] : [...opts.addSupertypes];
  if (opts.nameOverride !== undefined) perm.copyNameOverride = opts.nameOverride;
  else delete perm.copyNameOverride;
  perm.timestamp = ctx.state.nextTimestamp++;
  perm.copyUntilEot = opts.untilEot === true;
}

/**
 * Move an object to a new zone, yielding the new object (or null when a token ceases to
 * exist). Emits the zone-change event, applies the CR 903.9b commander replacement, sets
 * the CR 903.9a bookkeeping flag, and queues ETB/dies triggers.
 */
/**
 * The creature types offered by "As this enters, choose a creature type" (Cavern of Souls,
 * Herald's Horn, Patchwork Banner, Three Tree City).
 *
 * **A deliberate deviation from the rules, and the reason is the decision shape.** CR 614.1c
 * lets a player name ANY creature type — roughly 280 of them. The engine's as-enters choice is a
 * closed option list rendered one entry per option (see the prompt in `moveObject`), and there
 * is no free-text decision anywhere in the protocol; offering 280 options would also put a
 * 280-way choice in front of the AI for a decision that is nearly always obvious.
 *
 * So the domain is narrowed to types the controller could plausibly care about: every creature
 * type appearing in their own DECKLIST (`decklistOracleIds`, which the engine already keeps)
 * plus every creature type on the battlefield right now, including opponents'. That is what a
 * real player names in all but one case.
 *
 * The case it mis-serves: naming a type that is nowhere yet — a Cavern held open for a creature
 * still to be drawn, or a type an opponent has not played. The decklist half covers the first;
 * the second is genuinely lost. Revisit if a board ever turns on it.
 *
 * Both halves read PRINTED subtypes, not computed ones. A changeling (CR 702.73 — "this card is
 * every creature type") would otherwise contribute all ~324 of them and blow the option list up
 * to exactly the size this design exists to avoid. Reading it as its printed Shapeshifter loses
 * nothing that matters, because every option is equivalent against an all-types permanent: it
 * is hit whichever type you name. What this does forfeit is a type a permanent acquired from a
 * layer-4 effect, which no printing in the current pool turns on.
 *
 * Sorted for determinism (brief §4 — no unseeded ordering anywhere in the engine).
 */
export function creatureTypeChoicesFor(
  ctx: GameContext,
  controllerId: PlayerId,
): { key: string; label: string }[] {
  const types = new Set<string>();
  const player = ctx.state.players.find((p) => p.id === controllerId);
  for (const oracleId of player?.decklistOracleIds ?? []) {
    const def = ctx.defs.get(oracleId);
    if (def === undefined || !def.types.includes('Creature')) continue;
    for (const subtype of def.subtypes) types.add(subtype);
  }
  for (const perm of ctx.state.battlefield) {
    const def = ctx.defs.get(perm.oracleId);
    if (def === undefined || !def.types.includes('Creature')) continue;
    for (const subtype of def.subtypes) types.add(subtype);
  }
  return [...types]
    .filter((type) => CREATURE_TYPES.includes(type))
    .sort()
    .map((type) => ({ key: type, label: type }));
}

/**
 * Where a permanent leaving the battlefield for `zone` actually goes: an unearthed permanent is
 * exiled instead (CR 702.84a). Batch moves read this before queueing "dies" triggers, since a
 * permanent exiled this way never dies (CR 700.4).
 */
export function leavesBattlefieldTo(perm: EnginePermanent, zone: Zone): Zone {
  return perm.unearthed === true && zone !== 'exile' ? 'exile' : zone;
}

/** Graveyard replacements read the pre-event battlefield, including a source leaving with it. */
function graveyardDestination(ctx: GameContext, obj: EngineObject, zone: Zone): Zone {
  if (zone !== 'graveyard') return zone;
  for (const { controllerId, static: rule } of gatherRuleStatics(ctx)) {
    if (rule.kind !== 'graveyardToExile' || (!rule.includeTokens && obj.isToken)) continue;
    const subjectPlayer =
      rule.basis === 'controller' && obj.zone === 'battlefield'
        ? (obj as EnginePermanent).controllerId
        : obj.ownerId;
    if (
      rule.scope === 'opponents' &&
      !opponentsOf(ctx, controllerId).some((player) => player.id === subjectPlayer)
    )
      continue;
    if (
      rule.creatureFromBattlefieldOnly === true &&
      (obj.zone !== 'battlefield' ||
        !computeCharacteristics(ctx, obj as EnginePermanent).types.includes('Creature'))
    )
      continue;
    return 'exile';
  }
  return zone;
}

export function* moveObject(
  ctx: GameContext,
  obj: EngineObject,
  dest: MoveDestination,
): GameGen<EngineCardObject | EnginePermanent | null> {
  const from = obj.zone;
  if (
    from === 'battlefield' &&
    dest.reason === 'sacrifice' &&
    !canBeSacrificed(ctx, obj as EnginePermanent)
  )
    return obj;
  let target: MoveDestination = dest;
  if (
    obj.zone === 'stack' &&
    dest.zone === 'graveyard' &&
    (obj as EngineCardObject).exileIfGraveyardFromStack === true
  )
    target = { ...dest, zone: 'exile' };

  // CR 702.84a: an unearthed permanent that would leave the battlefield is exiled instead. Applied
  // before the commander replacement below; either order ends in exile, since 903.9b only offers
  // the command zone for a move to hand or library.
  if (
    from === 'battlefield' &&
    leavesBattlefieldTo(obj as EnginePermanent, dest.zone) !== dest.zone
  ) {
    target = {
      zone: 'exile',
      ...(dest.reason !== undefined ? { reason: dest.reason } : {}),
      ...(dest.deferLeaveProcessing !== undefined
        ? { deferLeaveProcessing: dest.deferLeaveProcessing }
        : {}),
      ...(dest.deferCardZoneTriggers !== undefined
        ? { deferCardZoneTriggers: dest.deferCardZoneTriggers }
        : {}),
    };
  }

  // CR 903.9b — commander headed to hand or library: owner may redirect to command zone.
  target = { ...target, zone: graveyardDestination(ctx, obj, target.zone) };
  if (obj.isCommander && (target.zone === 'hand' || target.zone === 'library')) {
    const outcome = yield {
      decisionType: 'commanderReplacement',
      player: obj.ownerId,
      prompt: `${obj.name} would be put into your ${target.zone}. Put it into the command zone instead?`,
      options: [
        { type: 'commanderToCommandZone', description: `Put ${obj.name} into the command zone` },
        { type: 'keepMoving', description: `Let ${obj.name} go to your ${target.zone}` },
      ],
    };
    // A batch move keeps owning leave processing and its pre-event facts: the redirect changes
    // only where the card goes, so its leave triggers are not queued a second time.
    if (outcome.index === 0)
      target = {
        zone: 'command',
        ...(target.deferLeaveProcessing !== undefined
          ? { deferLeaveProcessing: target.deferLeaveProcessing }
          : {}),
        ...(target.lastKnownFacts !== undefined ? { lastKnownFacts: target.lastKnownFacts } : {}),
        ...(target.deferCardZoneTriggers !== undefined
          ? { deferCardZoneTriggers: target.deferCardZoneTriggers }
          : {}),
      };
  }

  // Last known information (CR 113.7a), read while it is still on the battlefield.
  if (from === 'battlefield')
    rememberLeavingSourceTraits(ctx, obj as EnginePermanent, target.lastKnownFacts);

  if (target.zone === 'battlefield' && !target.faceDown) {
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
    if (def.subtypes.includes('Aura')) {
      const enchant = def.spellAbility?.targets[0];
      const controllerId = target.controllerId ?? obj.ownerId;
      // Chosen without targeting (CR 303.4f), but protection still forbids being enchanted by
      // an Aura of that color (CR 702.16d).
      const hosts =
        enchant === undefined
          ? []
          : computeTargetOptions(
              ctx,
              enchant,
              controllerId,
              undefined,
              undefined,
              undefined,
              obj.cardId,
              false,
            ).filter((id) => {
              const host = ctx.state.battlefield.find((perm) => perm.id === id);
              // Attachments are chosen as the batch enters (CR 303.4f). Fellow entrants
              // placed earlier by this implementation were not yet battlefield objects.
              if (host !== undefined && ctx.enteringTogether?.has(host.cardId) === true)
                return false;
              return host === undefined
                ? !playerProtectedFromEverything(ctx, id)
                : !hasProtectionFrom(ctx, host, def);
            });
      if (target.attachedTo !== undefined) {
        if (!hosts.includes(target.attachedTo)) return null;
      } else {
        // CR 303.4f: putting an Aura onto the battlefield chooses an enchantable
        // permanent without targeting it. With no host it stays in its current zone.
        if (hosts.length === 0) return null;
        const outcome = yield {
          decisionType: 'general',
          player: controllerId,
          prompt: `${obj.name}: choose ${enchant?.kind === 'player' ? 'a player' : 'a permanent'} to enchant.`,
          options: hosts.map((id) => ({
            type: 'attachAura',
            description: `Enchant ${ctx.state.battlefield.find((p) => p.id === id)?.name ?? id}`,
            payload: id,
          })),
        };
        target = { ...target, attachedTo: hosts[outcome.index]! };
      }
    }
  }

  // Its fixed effects stay until leave processing has read its last known characteristics: an
  // animated land that dies is a creature dying (CR 113.7a, 603.10a).
  const keepForLeaveProcessing = from === 'battlefield' && target.zone !== 'battlefield';
  removeFromCurrentZone(ctx, obj, keepForLeaveProcessing);
  // An ability granted to a card in a graveyard ("gains unearth {3} until end of turn") does not
  // follow it to a new zone: it is a new object there (CR 400.7).
  if (from === 'graveyard') delete ctx.state.temporaryGraveyardAbilities[obj.cardId];

  if (from === 'battlefield' && target.zone === 'graveyard') {
    (obj as unknown as EngineCardObject).rememberedCounters = {
      ...(obj as EnginePermanent).counters,
    };
  }

  // Tokens cease to exist when they leave the battlefield (CR 704.5d; applied directly
  // on the move rather than at the next SBA check — indistinguishable in Phase 2).
  if (obj.isToken && from === 'battlefield' && target.zone !== 'battlefield') {
    emit(ctx, 'tokenCeased', { name: obj.name, cardId: obj.cardId });
    debug(ctx, 'zoneChange', `token ${obj.name} ceased to exist`);
    if (!target.deferLeaveProcessing) {
      queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
      if (target.reason === 'sacrifice')
        queueTriggersForObject(ctx, 'sacrificed', obj as EnginePermanent);
    }
    expireSourceControlEffects(ctx, obj.id);
    releaseFixedEffects(ctx, obj.cardId);
    if (!target.deferLeaveProcessing) yield* returnExiledUntilLeaves(ctx, obj.cardId);
    return null;
  }

  let next: EngineCardObject | EnginePermanent;
  if (target.zone === 'battlefield') {
    const controllerId = target.controllerId ?? obj.ownerId;
    // As-enters replacement (CR 614.1c): "enters tapped unless <condition>". Resolved BEFORE
    // the permanent exists, so it is never momentarily tapped-then-untapped — and because the
    // condition may be a choice ("you may pay 2 life"), it is resolved here, in the generator.
    const def = selectedPermanentDefinition(
      getDefByOracleId(ctx, obj.oracleId, obj.name),
      target.face ?? obj.face,
    );
    const landFace =
      target.face === 'back'
        ? def.alternativeCasts?.find((alt) => alt.kind === 'mdfc')?.landFace
        : undefined;
    let entersTappedOverride: boolean | undefined;
    const entersTappedUnless = landFace?.entersTappedUnless ?? def.entersTappedUnless;
    if (
      !target.faceDown &&
      entersTappedUnless !== undefined &&
      !losesAbilitiesAsItEnters(
        ctx,
        target.face === 'back' ? { ...obj, face: 'back' } : obj,
        controllerId,
      )
    ) {
      const met = yield* resolveCondition(
        ctx,
        entersTappedUnless,
        { cardId: obj.cardId, controllerId },
        landFace?.name ?? obj.name,
      );
      entersTappedOverride = !met;
    }
    if (target.entersTapped === true) entersTappedOverride = true;
    const incoming = target.face === 'back' ? { ...obj, face: 'back' as const } : obj;
    const perm = makePermanent(
      ctx,
      incoming,
      controllerId,
      entersTappedOverride,
      target.faceDown,
      target.withCounters,
    );
    perm.attachedTo = target.attachedTo ?? null;
    if (target.bestowed === true && perm.attachedTo !== null) perm.bestowed = true;
    if (target.manifested === true && perm.faceDown === true) perm.manifested = true;
    ctx.state.battlefield.push(perm);
    next = perm;
    if (target.addTypes !== undefined && target.addTypes.length > 0) {
      ctx.state.effects.push({
        id: `eff-${ctx.state.nextObjectNum++}`,
        sourceId: perm.cardId,
        description: `${perm.name} is ${target.addTypes.join(' ')} in addition to its other types`,
        targetCardIds: [perm.cardId],
        targetObjectIds: [perm.id],
        kind: 'addTypes',
        addTypes: [...target.addTypes],
        duration: 'permanent',
        timestamp: ctx.state.nextTimestamp++,
      });
    }

    const chars = computeCharacteristics(ctx, perm);
    if (chars.types.includes('Creature') && chars.keywords.includes('riot')) {
      const outcome = yield {
        decisionType: 'general',
        player: controllerId,
        prompt: `Riot choice for ${perm.name}: choose a +1/+1 counter or haste`,
        options: [
          {
            type: 'riotCounter',
            description: `Put a +1/+1 counter on ${perm.name}`,
            payload: perm.id,
          },
          {
            type: 'riotHaste',
            description: `Give ${perm.name} haste until end of turn`,
            payload: perm.id,
          },
        ],
      };
      if (outcome.index === 1) {
        ctx.state.effects.push({
          id: `eff-${ctx.state.nextObjectNum++}`,
          sourceId: perm.cardId,
          description: `${perm.name} gains haste until end of turn (Riot)`,
          targetCardIds: [perm.cardId],
          kind: 'grantKeyword',
          keyword: 'haste',
          timestamp: ctx.state.nextTimestamp++,
        });
        emit(ctx, 'grantKeyword', { source: 'Riot', target: perm.name, keyword: 'haste' });
      } else {
        const count = counterAmountAfterReplacements(ctx, perm, '+1/+1', 1);
        perm.counters['+1/+1'] = (perm.counters['+1/+1'] ?? 0) + count;
        emit(ctx, 'putCounter', { target: perm.name, counter: '+1/+1', count });
      }
    }

    // As-enters modal choice (CR 614.1c), e.g. Caged Sun's color or Frontier Siege's mode.
    // Resolved here, before anything else can observe the permanent, so nothing built on
    // `chosenOption` can ever run before it exists.
    if (!target.faceDown && def.entersChoosingOption !== undefined) {
      const { prompt, domain } = def.entersChoosingOption;
      const options =
        domain === 'creatureType'
          ? creatureTypeChoicesFor(ctx, controllerId)
          : (def.entersChoosingOption.options ?? []);
      if (options.length === 0) {
        // Nothing to choose from — a Cavern of Souls in a deck with no creatures at all. The
        // permanent still enters; it simply never records a choice, and every "of the chosen
        // type" clause reading `chosenOption` correctly matches nothing.
        debug(ctx, 'decision', `${perm.name}: no options for as-enters choice, skipping`);
      } else {
        const outcome = yield {
          decisionType: 'general',
          player: controllerId,
          prompt: `${perm.name}: ${prompt}`,
          // No `payload` — resolved by `outcome.index` below, and `o.key` (e.g. "Khans", "red")
          // is not an on-screen object id. Setting it as payload would make `interactionFor`
          // treat this as "click the board object with this id," which nothing on the board has,
          // stranding the choice unreachable for a human player (the same bug class as
          // `searchLibrary`'s raw card-id payloads).
          options: options.map((o) => ({ type: 'chooseOption', description: o.label })),
        };
        const chosen = options[outcome.index]?.key;
        if (chosen !== undefined) perm.chosenOption = chosen;
      }
    }

    // "You may have this enter the battlefield as a copy of …" (CR 707.2, as-enters
    // replacement — Dack's Duplicate, Spark Double, Sculpting Steel). Resolved after the
    // permanent exists (so it can be excluded from its own candidate list) but before
    // `queueTriggersForObject(ctx, 'enters', …)` below, so ETB triggers reflect the copied
    // identity rather than the entering card's own.
    if (!target.faceDown && def.entersAsCopy !== undefined) {
      const config = def.entersAsCopy;
      // A permanent entering in the same simultaneous event is not there to copy (CR 614.12).
      const candidates = selectPermanents(ctx, config.selector, {
        cardId: perm.cardId,
        controllerId,
      }).filter((p) => p.cardId !== perm.cardId && ctx.enteringTogether?.has(p.cardId) !== true);
      const originalName = perm.name;
      const copyTarget = yield* chooseCard(ctx, {
        player: controllerId,
        prompt: `${originalName}: you may have it enter as a copy of another permanent`,
        cards: candidates,
        type: 'entersAsCopy',
        verb: 'Copy',
        decline: { type: 'decline', description: 'Enter normally', verb: 'Decline' },
      });
      if (copyTarget !== null) {
        const copyTargetPerm = copyTarget as EnginePermanent;
        applyCopy(ctx, perm, copyTargetPerm, {
          addTypes: config.addTypes,
          addKeywords: config.addKeywords,
          addTriggers: config.addTriggers,
          removeSupertypes: config.removeSupertypes,
          addStaticEffects: config.addStaticEffects,
        });
        if (config.addCounterByType !== undefined) {
          const copiedTypes = computeCharacteristics(ctx, perm).types;
          const counter = copiedTypes.includes('Planeswalker')
            ? config.addCounterByType.planeswalkerCounter
            : config.addCounterByType.creatureCounter;
          const count = counterAmountAfterReplacements(
            ctx,
            perm,
            counter,
            config.addCounterByType.count,
          );
          setCounterCount(perm.counters, counter, counterCount(perm.counters, counter) + count);
        }
        emit(ctx, 'becomeCopy', {
          source: originalName,
          target: copyTargetPerm.name,
          untilEot: false,
        });
      }
    }
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
        if (target.libraryCardsAbove !== undefined)
          owner.library.splice(Math.min(target.libraryCardsAbove, owner.library.length), 0, next);
        else if ((target.libraryPosition ?? 'top') === 'top') owner.library.unshift(next);
        else owner.library.push(next);
        break;
      case 'stack':
        // The caller (casting code) owns placing the object into its stack entry.
        break;
    }
  }

  // CR 400.7e: an ability triggered by this permanent leaving may find the card it became.
  if (from === 'battlefield' && ['graveyard', 'exile', 'command'].includes(target.zone))
    (next as EngineCardObject).leftBattlefieldObjectId = obj.id;
  // CR 903.9a — commander newly in graveyard/exile: flag for the next SBA check.
  if (from === 'battlefield' && target.zone !== 'hand' && target.zone !== 'library')
    (obj as EnginePermanent).firstDestinationObjectId = next.id;
  if (next.isCommander && (target.zone === 'graveyard' || target.zone === 'exile')) {
    (next as EngineCardObject).commanderSbaPending = true;
  }

  // CR 400.7j permits other parts of this effect to find the new object only when the
  // effect moved it to a public zone. This is deliberately scoped to its execution context.
  ctx.resolutionObjectMoves?.set(
    obj.id,
    target.zone === 'hand' || target.zone === 'library' ? null : next.id,
  );

  // Leave/death triggers look back to the controller before this event (CR 603.10a).
  // A stolen watcher still observes its control source leaving under its old controller.
  // End source-bound control only after those firings are captured, but before post-event
  // card-zone triggers or linked returns inspect the new battlefield. Batch departures have
  // already captured their firings together in movePermanentsTogether.
  if (keepForLeaveProcessing) {
    if (!target.deferLeaveProcessing) {
      queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
      if (target.reason === 'sacrifice')
        queueTriggersForObject(ctx, 'sacrificed', obj as EnginePermanent);
    }
    expireSourceControlEffects(ctx, obj.id);
  }

  emit(ctx, 'zoneChange', {
    cardId: obj.cardId,
    // A face-down permanent leaving the battlefield is revealed (CR 708.9).
    name: target.faceDown
      ? FACE_DOWN_PERMANENT_NAME
      : obj.zone === 'battlefield' && (obj as EnginePermanent).faceDown === true
        ? (ctx.defs.get(obj.oracleId)?.name ?? obj.name)
        : obj.name,
    from,
    to: target.zone,
    owner: obj.ownerId,
    newObjectId: next.id,
  });
  debug(ctx, 'zoneChange', `${obj.name}: ${from} → ${target.zone}`, { cardId: obj.cardId });

  // Syr Konrad's card-zone events are distinct from dies: the graveyard-entry event here
  // intentionally covers only non-battlefield origins so one battlefield death cannot fire twice.
  if (
    target.zone === 'graveyard' &&
    from !== 'graveyard' &&
    target.deferCardZoneTriggers !== true
  ) {
    queueCardZoneTriggers(
      ctx,
      'putIntoGraveyardFromAnywhere',
      [next as EngineCardObject],
      [],
      from === 'battlefield',
      from === 'battlefield'
        ? new Map([[obj.cardId, (obj as EnginePermanent).lastKnownFacts!]])
        : new Map(),
    );
  }
  if (
    from === 'graveyard' &&
    target.zone !== 'graveyard' &&
    target.deferCardZoneTriggers !== true
  ) {
    queueCardZoneTriggers(
      ctx,
      'leavesGraveyard',
      [obj as EngineCardObject],
      target.zone === 'battlefield' ? [next.id] : [],
    );
  }

  // Triggers: enters on arriving, dies on battlefield → graveyard.
  if (
    target.zone === 'battlefield' &&
    from !== 'battlefield' &&
    target.deferEntersTriggers !== true
  ) {
    queueTriggersForObject(ctx, 'enters', next as EnginePermanent);
  }
  if (from === 'battlefield') {
    if (!keepForLeaveProcessing && !target.deferLeaveProcessing)
      queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
    if (keepForLeaveProcessing) releaseFixedEffects(ctx, obj.cardId);
    if (!target.deferLeaveProcessing) yield* returnExiledUntilLeaves(ctx, obj.cardId);
  }

  return next;
}

/**
 * CR 614.12: a permanent's own "enters tapped unless" applies only if it would have that ability
 * on the battlefield. Checked against the permanent as it would exist there, under the continuous
 * effects already in play (a nonbasic land under Blood Moon has no abilities, so it enters
 * untapped). The probe is never put anywhere, and its object id is handed back.
 */
function losesAbilitiesAsItEnters(
  ctx: GameContext,
  obj: EngineObject,
  controllerId: PlayerId,
): boolean {
  const nextObjectNum = ctx.state.nextObjectNum;
  const probe = makePermanent(ctx, obj, controllerId);
  ctx.state.nextObjectNum = nextObjectNum;
  return computeCharacteristics(ctx, probe).loseAbilities === true;
}

/**
 * Move cards as one zone-change event. Every card still gets the new object identity required
 * by CR 400.7, while aggregate "one or more cards leave" abilities see one event. Objects put
 * onto the battlefield together enter simultaneously: no enters trigger is checked until all of
 * them are there (CR 603.6a), so each sees the others.
 */
export function* moveObjects(
  ctx: GameContext,
  objects: EngineObject[],
  destination: MoveDestination,
): GameGen<(EngineCardObject | EnginePermanent | null)[]> {
  const leavingGraveyard =
    destination.zone === 'graveyard'
      ? []
      : objects.filter((object): object is EngineCardObject => object.zone === 'graveyard');
  const moved: (EngineCardObject | EnginePermanent | null)[] = [];
  const entered: EnginePermanent[] = [];
  // Permanents leaving the battlefield together are one departure event (CR 603.10a).
  const departing =
    destination.zone === 'battlefield'
      ? []
      : objects.filter(
          (object): object is EnginePermanent =>
            object.zone === 'battlefield' &&
            (destination.reason !== 'sacrifice' || canBeSacrificed(ctx, object as EnginePermanent)),
        );
  const departed =
    departing.length > 0
      ? yield* movePermanentsTogether(ctx, departing, destination, destination.reason)
      : [];
  for (const object of objects) {
    const departure = departing.indexOf(object as EnginePermanent);
    if (departure >= 0) {
      moved.push(departed[departure] ?? null);
      continue;
    }
    const entering = destination.zone === 'battlefield' && object.zone !== 'battlefield';
    const outer = ctx.enteringTogether;
    // Fellow entrants placed so far were not on the battlefield before this event (CR 614.12).
    if (entering) ctx.enteringTogether = new Set(entered.map((permanent) => permanent.cardId));
    let next: EngineCardObject | EnginePermanent | null;
    try {
      next = yield* moveObject(ctx, object, {
        ...destination,
        ...(leavingGraveyard.includes(object as EngineCardObject)
          ? { deferCardZoneTriggers: true }
          : {}),
        ...(entering ? { deferEntersTriggers: true } : {}),
      });
    } finally {
      if (outer === undefined) delete ctx.enteringTogether;
      else ctx.enteringTogether = outer;
    }
    moved.push(next);
    if (entering && next !== null && next.zone === 'battlefield')
      entered.push(next as EnginePermanent);
  }
  // One enters event for the whole batch: "one or more … enter" triggers once (CR 603.2c), and
  // an ordinary watcher still fires once for each permanent it matches.
  queueTriggersForEvent(
    ctx,
    'enters',
    entered
      .filter((permanent) => ctx.state.battlefield.includes(permanent))
      .map((permanent) => ({ permanent })),
  );
  if (leavingGraveyard.length > 0) {
    queueCardZoneTriggers(
      ctx,
      'leavesGraveyard',
      leavingGraveyard,
      entered.map((permanent) => permanent.id),
    );
  }
  return moved;
}

/**
 * Register a token's face as a `CardDefinition` and return its synthetic oracle id.
 *
 * Tokens are not cards (CR 111.1), but everything downstream of `makePermanent` — the layer
 * engine, `triggersOf`, `manaSourcesFor` — reaches a permanent's behavior through
 * `ctx.defs.get(oracleId)`. Giving a token a definition is what lets it participate in all of
 * that without a parallel code path, which is where a token that quietly ignores anthems or
 * fails to fire its own dies trigger would come from.
 *
 * The id is derived from the spec, so N Treasures share one definition entry.
 */
/**
 * The definition a face-down spell is cast with (CR 708.2a, 708.4): a 2/2 creature with no
 * name, mana cost, color, types beyond creature, or abilities. A morph card cast face down is
 * put on the stack under this definition, so cast triggers, reductions and restrictions see
 * only what is public.
 */
export function faceDownSpellOracleId(ctx: GameContext): OracleId {
  return registerTokenDef(ctx, {
    name: 'Face-down creature spell',
    typeLine: 'Creature',
    types: ['Creature'],
    subtypes: [],
    colors: [],
    power: 2,
    toughness: 2,
  });
}

function registerTokenDef(ctx: GameContext, spec: TokenSpec): OracleId {
  const { copyDefinition, startsTransformed } = spec as CopyTokenSpec;
  const evalPower =
    spec.power === null || spec.power === undefined
      ? null
      : typeof spec.power === 'number'
        ? spec.power
        : evaluateValue(ctx, spec.power);
  const evalToughness =
    spec.toughness === null || spec.toughness === undefined
      ? null
      : typeof spec.toughness === 'number'
        ? spec.toughness
        : evaluateValue(ctx, spec.toughness);
  // Resolve dynamic P/T before interning. All copiable characteristics, including
  // colors and abilities, distinguish definitions; creation-only haste does not.
  const { grantHasteUntilEot: _haste, copyDefinition: _copy, ...copiable } = spec as CopyTokenSpec;
  const copyValues =
    copyDefinition === undefined
      ? undefined
      : (() => {
          const { oracleId: _oracle, scryfallId: _printing, ...values } = copyDefinition;
          return values;
        })();
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  const oracleId = `token:${JSON.stringify(
    canonical({
      ...copiable,
      ...(copyValues !== undefined ? { copyDefinition: copyValues } : {}),
      power: evalPower,
      toughness: evalToughness,
      supertypes: spec.supertypes ?? [],
      keywords: spec.keywords ?? [],
      triggers: spec.triggers ?? [],
      manaAbilities: spec.manaAbilities ?? [],
      activatedAbilities: spec.activatedAbilities ?? [],
    }),
  )}` as OracleId;
  if (!ctx.defs.has(oracleId)) {
    ctx.defs.set(
      oracleId,
      assertValidModeledDefinition({
        ...copyDefinition,
        oracleId,
        name: spec.name,
        typeLine: spec.typeLine,
        supertypes: spec.supertypes ?? [],
        types:
          spec.types ??
          (spec.typeLine.includes('Creature')
            ? ['Creature']
            : spec.typeLine.includes('Land')
              ? ['Land']
              : spec.typeLine.includes('Artifact')
                ? ['Artifact']
                : ['Creature']),
        subtypes: spec.subtypes ?? [],
        colors: spec.colors,
        colorIdentity: spec.colors,
        manaCost: spec.manaCost ?? null,
        hasUnsupportedCost: false,
        power: evalPower,
        toughness: evalToughness,
        loyalty: null,
        defense: null,
        keywords: spec.keywords ?? [],
        manaAbilities: spec.manaAbilities ?? [],
        activatedAbilities: spec.activatedAbilities ?? [],
        entersTapped: copyDefinition?.entersTapped ?? false,
        spellAbility: null,
        triggers: spec.triggers ?? [],
        staticEffects: [...(copyDefinition?.staticEffects ?? []), ...(spec.staticEffects ?? [])],
        ruleStatics: [...(copyDefinition?.ruleStatics ?? []), ...(spec.ruleStatics ?? [])],
        modeled: true,
        unmodeledReasons: [],
      }),
    );
  }
  if (copyDefinition?.backFace !== undefined) {
    const active = startsTransformed ? copyDefinition.backFace : copyDefinition;
    const addedTypes = spec.types.filter((type) => !active.types.includes(type));
    const addedKeywords = (spec.keywords ?? []).filter(
      (keyword) => !active.keywords.includes(keyword),
    );
    const removedSuper = [
      ...new Set([
        ...((spec as CopyTokenSpec).removeSupertypes ?? []),
        ...active.supertypes.filter((type) => !(spec.supertypes ?? []).includes(type)),
      ]),
    ];
    const modify = <T extends CardDefinition | BackFace>(face: T): T => ({
      ...face,
      typeLine: removedSuper.reduce(
        (line, type) => line.replace(new RegExp(`^${type} `), ''),
        face.typeLine,
      ),
      types: [...new Set([...face.types, ...addedTypes])],
      keywords: [...new Set([...face.keywords, ...addedKeywords])],
      supertypes: face.supertypes.filter((type) => !removedSuper.includes(type)),
      ...(spec.power !== active.power ? { power: evalPower } : {}),
      ...(spec.toughness !== active.toughness ? { toughness: evalToughness } : {}),
    });
    ctx.defs.set(
      oracleId,
      assertValidModeledDefinition({
        ...modify(copyDefinition),
        oracleId,
        backFace: modify(copyDefinition.backFace),
      }),
    );
  }
  return oracleId;
}

/**
 * Put a token onto the battlefield (CR 111.1). Returns the new permanent.
 *
 * It goes through `makePermanent` and `queueTriggersForObject` exactly as a resolving permanent
 * spell does, so a token with an ETB trigger fires it and a token entering under an anthem is
 * pumped. It does NOT go through `moveObject`, because a token has no previous zone to leave.
 */
function queueTokenCreatedEvent(ctx: GameContext, tokens: EnginePermanent[]): void {
  if (tokens.length === 0) return;
  queueTriggersForEvent(
    ctx,
    'tokenCreated',
    tokens.map((permanent) => ({ permanent })),
  );
}

export function createToken(
  ctx: GameContext,
  spec: TokenSpec,
  controllerId: PlayerId,
  applyTokenReplacements = true,
  queueEvent = true,
  queueEntersEvent = true,
  entersTapped = false,
): EnginePermanent {
  if (applyTokenReplacements) {
    const multiplier = tokenCreationMultiplierFor(ctx, controllerId);
    const created: EnginePermanent[] = [];
    for (let i = 0; i < multiplier; i++) {
      created.push(createToken(ctx, spec, controllerId, false, false, false, entersTapped));
    }
    queueTokenCreatedEvent(ctx, created);
    queueTriggersForEvent(
      ctx,
      'enters',
      created.map((permanent) => ({ permanent })),
    );
    applyTokenCreationReplacements(ctx, spec, controllerId);
    const first = created[0];
    if (first === undefined) throw new Error('engine bug: token multiplier created no token');
    return first;
  }
  const oracleId = registerTokenDef(ctx, spec);
  const copySpec = spec as CopyTokenSpec;
  const def = getDefByOracleId(ctx, oracleId, spec.name);
  // Entry replacements and ETB triggers must see the face that enters, without a transform event.
  const entryId =
    copySpec.startsTransformed && def.backFace !== undefined
      ? internCopyDefinition(
          ctx,
          copiableDefinition(ctx, {
            oracleId,
            name: spec.name,
            transformed: true,
          } as EnginePermanent),
        )
      : oracleId;
  const stub: EngineObject = {
    id: newObjectId(ctx),
    // Tokens need a stable `cardId` like any other object — commander damage, until-EOT effect
    // sets and the layer cache are all keyed by it — but no two tokens ever share one.
    cardId: `tok-${ctx.state.nextObjectNum++}`,
    oracleId: entryId,
    ownerId: controllerId,
    name: spec.name,
    typeLine: spec.typeLine,
    oracleText:
      copySpec.oracleText ??
      (copySpec.startsTransformed
        ? (def.backFace?.oracleText ?? '')
        : (def.backFace?.frontOracleText ?? '')),
    manaCost: spec.manaCostText ?? null,
    isToken: true,
    isCommander: false,
    zone: 'battlefield',
  };
  const perm = makePermanent(ctx, stub, controllerId, entersTapped ? true : undefined);
  perm.oracleId = oracleId;
  perm.transformed = copySpec.startsTransformed === true;
  if (copySpec.imageFace !== undefined) perm.copyImageFace = copySpec.imageFace;
  ctx.state.battlefield.push(perm);
  // "If you created a token this turn" — set by token creation, not by any permanent entering.
  if (ctx.state.createdTokenThisTurn) ctx.state.createdTokenThisTurn[controllerId] = true;
  if (spec.grantHasteUntilEot === true) {
    ctx.state.effects.push({
      id: `eff-${ctx.state.nextObjectNum++}`,
      sourceId: perm.cardId,
      description: `${spec.name} has haste until end of turn`,
      targetCardIds: [perm.cardId],
      kind: 'grantKeyword',
      keyword: 'haste',
      timestamp: ctx.state.nextTimestamp++,
    });
  }
  if (queueEvent) queueTokenCreatedEvent(ctx, [perm]);
  emit(ctx, 'tokenCreated', { name: spec.name, controller: controllerId, cardId: perm.cardId });
  debug(ctx, 'zoneChange', `token created: ${spec.name} under ${controllerId}`);
  if (queueEntersEvent) queueTriggersForObject(ctx, 'enters', perm);
  if (applyTokenReplacements) applyTokenCreationReplacements(ctx, spec, controllerId);
  return perm;
}

/**
 * "If one or more <kind> tokens would be created under your control, those tokens plus an
 * additional <token> are created instead" — Queen Allenal of Ruadach, Stridehangar Automaton.
 *
 * Applied once per token-creation EVENT, not once per token (CR 614.1c/616.1): the printed
 * trigger condition is "one or more", so creating three Soldiers in one resolution adds one
 * Soldier, not three. That is why this is a separate function rather than a tail on
 * `createToken` — `createTokens` runs it once for a whole batch. The extra tokens are themselves
 * created with replacements OFF, so one replacement can never feed another.
 */
export function applyTokenCreationReplacements(
  ctx: GameContext,
  spec: TokenSpec,
  controllerId: PlayerId,
  deferredEvents?: EnginePermanent[],
): void {
  const createAdditional = (additional: TokenSpec): void => {
    const token = createToken(
      ctx,
      additional,
      controllerId,
      false,
      deferredEvents === undefined,
      deferredEvents === undefined,
    );
    deferredEvents?.push(token);
  };
  if (spec.types.includes('Creature')) {
    const replacements = ctx.state.battlefield
      .filter((candidate) => candidate.controllerId === controllerId)
      .flatMap((candidate) => {
        const def = ctx.defs.get(candidate.oracleId);
        return def?.tokenCreationReplacement === undefined ? [] : [def.tokenCreationReplacement];
      });
    for (const replacement of replacements) createAdditional(replacement);
  }
  if (
    spec.types.includes('Artifact') &&
    ctx.state.battlefield.some((candidate) => {
      if (candidate.controllerId !== controllerId) return false;
      const def = ctx.defs.get(candidate.oracleId);
      return def?.ruleStatics.some((rs) => rs.kind === 'artifactTokenCreatesThopter') ?? false;
    })
  ) {
    createAdditional({
      name: 'Thopter',
      typeLine: 'Artifact Creature — Thopter',
      types: ['Artifact', 'Creature'],
      subtypes: ['Thopter'],
      colors: [],
      power: 1,
      toughness: 1,
      keywords: ['flying'],
    });
  }
}

/**
 * Whether `attachment` could be attached to `host` (CR 701.3a): an Aura to what its enchant ability
 * allows, chosen without targeting (CR 303.4), and not while it is a creature (CR 303.4d); an
 * Equipment only to a creature other than itself, and not while it is a creature (CR 301.5c).
 * Reattaching to what it is already on is not a move (CR 701.3b).
 */
export function canAttach(
  ctx: GameContext,
  attachment: EnginePermanent,
  host: EnginePermanent,
): boolean {
  if (host.id === attachment.id || attachment.attachedTo === host.id) return false;
  if (!ctx.state.battlefield.includes(host)) return false;
  const chars = computeCharacteristics(ctx, attachment);
  if (chars.types.includes('Creature')) return false;
  // Protection: can't be Enchanted or Equipped by something it is protected from (CR 702.16d).
  if (hasProtectionFrom(ctx, host, chars)) return false;
  if (chars.subtypes.includes('Aura')) return enchantAllows(ctx, attachment, host) === true;
  if (chars.subtypes.includes('Equipment'))
    return computeCharacteristics(ctx, host).types.includes('Creature');
  return false;
}

/**
 * Whether an Aura's enchant ability allows `host` for the Aura's current controller, chosen without
 * targeting (CR 303.4a), and `host` has no protection from the Aura's colors (CR 702.16c). Undefined
 * when the definition carries no enchant restriction to check.
 */
export function enchantAllows(
  ctx: GameContext,
  aura: EnginePermanent,
  host: EnginePermanent,
): boolean | undefined {
  const chars = computeCharacteristics(ctx, aura);
  if (hasProtectionFrom(ctx, host, chars)) return false;
  // A bestowed Aura has "enchant creature" (CR 702.103b).
  const enchant =
    aura.bestowed === true
      ? BESTOW_ENCHANT
      : getDefByOracleId(ctx, aura.oracleId, aura.name).spellAbility?.targets[0];
  if (enchant === undefined) return undefined;
  return computeTargetOptions(
    ctx,
    enchant,
    aura.controllerId,
    undefined,
    undefined,
    undefined,
    aura.cardId,
    false,
  ).includes(host.id);
}

/**
 * Attach an Aura or Equipment on the battlefield to `host` (CR 701.3a). It doesn't move if it can't
 * legally be attached there (CR 701.3b), and moving to a different object gives it a new
 * timestamp (CR 701.3c, 613.7e). Returns whether it moved.
 */
export function attachPermanent(
  ctx: GameContext,
  attachment: EnginePermanent,
  host: EnginePermanent,
): boolean {
  if (!canAttach(ctx, attachment, host)) return false;
  attachment.attachedTo = host.id;
  attachment.timestamp = ctx.state.nextTimestamp++;
  emit(ctx, 'attach', { equipment: attachment.name, to: host.name });
  return true;
}

/**
 * Create `count` tokens as ONE creation event: each token is a separate object with its own ETB
 * trigger (CR 707.2), but the "one or more tokens would be created" replacements above see a
 * single event and fire once.
 */
export function createTokens(
  ctx: GameContext,
  spec: TokenSpec,
  count: number,
  controllerId: PlayerId,
  entersTapped = false,
): EnginePermanent[] {
  const created: EnginePermanent[] = [];
  const multiplier = tokenCreationMultiplierFor(ctx, controllerId);
  for (let i = 0; i < count * multiplier; i++)
    created.push(createToken(ctx, spec, controllerId, false, false, false, entersTapped));
  if (created.length > 0) {
    queueTokenCreatedEvent(ctx, created);
    queueTriggersForEvent(
      ctx,
      'enters',
      created.map((permanent) => ({ permanent })),
    );
    applyTokenCreationReplacements(ctx, spec, controllerId);
  }
  return created;
}

/** Multiple players create tokens simultaneously (CR 101.4), with ownership per creator. */
export function createTokensForPlayers(
  ctx: GameContext,
  spec: TokenSpec,
  count: number,
  creators: readonly PlayerId[],
): EnginePermanent[] {
  // Read every creator's multiplier before any token enters. All entries precede any ETB or
  // token-created observation, including additional tokens from the existing replacements.
  const plans = [...new Set(creators)]
    .filter((id) => ctx.state.players.some((player) => player.id === id && !player.hasLost))
    .map((id) => ({ id, count: count * tokenCreationMultiplierFor(ctx, id) }));
  const created: EnginePermanent[] = [];
  for (const plan of plans) {
    for (let index = 0; index < plan.count; index++)
      created.push(createToken(ctx, spec, plan.id, false, false, false));
  }
  for (const plan of plans) {
    if (plan.count > 0) applyTokenCreationReplacements(ctx, spec, plan.id, created);
  }
  queueTokenCreatedEvent(ctx, created);
  queueTriggersForEvent(
    ctx,
    'enters',
    created.map((permanent) => ({ permanent })),
  );
  return created;
}

/**
 * The token spec for "a copy of `<permanent>`" (CR 707.2).
 *
 * Reads the PRINTED definition, never `computeCharacteristics`: copiable values exclude
 * everything layers 4–7 did to the original, so a copy of a Dragon wearing +3/+3 is a plain
 * Dragon. Reading current characteristics here is the subtle way to make Miirym generate a
 * snowballing board that the printed rules do not.
 */
export function tokenSpecCopying(
  ctx: GameContext,
  perm: EnginePermanent,
  exceptNonLegendary: boolean,
): TokenSpec {
  const def = copiableDefinition(ctx, perm);
  const printed = getDefByOracleId(ctx, perm.copyOriginal?.oracleId ?? perm.oracleId, perm.name);
  let copyDefinition = def;
  if (!perm.faceDown && printed.backFace !== undefined) {
    const front = copiableDefinition(ctx, { ...perm, transformed: false });
    const back = copiableDefinition(ctx, { ...perm, transformed: true });
    const {
      name,
      typeLine,
      manaCost,
      hasUnsupportedCost,
      supertypes,
      types,
      subtypes,
      colors,
      power,
      toughness,
      loyalty,
      defense,
      keywords,
      ward,
      protectionFrom,
      manaAbilities,
      activatedAbilities,
      entersTapped,
      entersTappedUnless,
      entersWithCounters,
      triggers,
      staticEffects,
      ruleStatics,
      cantBlock,
      cantBeBlocked,
    } = back;
    copyDefinition = {
      ...front,
      backFace: {
        name,
        typeLine,
        manaCost,
        hasUnsupportedCost,
        supertypes,
        types,
        subtypes,
        colors,
        power,
        toughness,
        loyalty,
        defense,
        keywords,
        manaAbilities,
        activatedAbilities,
        entersTapped,
        triggers,
        staticEffects,
        ruleStatics,
        ...(ward !== undefined ? { ward } : {}),
        ...(protectionFrom !== undefined ? { protectionFrom } : {}),
        ...(entersTappedUnless !== undefined ? { entersTappedUnless } : {}),
        ...(entersWithCounters !== undefined ? { entersWithCounters } : {}),
        ...(cantBlock !== undefined ? { cantBlock } : {}),
        ...(cantBeBlocked !== undefined ? { cantBeBlocked } : {}),
        oracleText: perm.copyOriginal ? perm.oracleText : printed.backFace.oracleText,
        manaCostText: perm.copyOriginal ? perm.manaCost : printed.backFace.manaCostText,
        frontOracleText: perm.copyOriginal ? perm.oracleText : printed.backFace.frontOracleText,
        frontManaCostText: perm.copyOriginal ? perm.manaCost : printed.backFace.frontManaCostText,
      },
    };
  }
  const spec: CopyTokenSpec = {
    copyDefinition,
    oracleText: perm.faceDown ? '' : perm.oracleText,
    imageFace: copyImageFace(ctx, perm),
    ...(exceptNonLegendary ? { removeSupertypes: ['Legendary'] } : {}),
    startsTransformed: !perm.faceDown && printed.backFace !== undefined && perm.transformed,
    name: def.name,
    // The type LINE is display text, but it is also what `registerTokenDef` keys on, so the
    // exception has to be applied to both or a non-legendary copy shares a definition with a
    // legendary one.
    typeLine: exceptNonLegendary ? def.typeLine.replace(/^Legendary /, '') : def.typeLine,
    supertypes: exceptNonLegendary
      ? def.supertypes.filter((t) => t !== 'Legendary')
      : def.supertypes,
    types: def.types,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power,
    toughness: def.toughness,
    keywords: def.keywords,
    triggers: def.triggers,
    manaAbilities: def.manaAbilities,
    activatedAbilities: def.activatedAbilities,
    // The active face's cost is displayed; double-faced tokens retain the front cost in their
    // definition for mana value (CR 707.8a, 202.3b).
    manaCost: def.manaCost,
    manaCostText: perm.faceDown ? null : perm.manaCost,
  };
  return spec;
}

/** Runtime copy metadata, produced only by the engine, never authored card IR. */
interface CopyTokenSpec extends TokenSpec {
  copyDefinition?: CardDefinition;
  oracleText?: string;
  startsTransformed?: boolean;
  removeSupertypes?: string[];
  imageFace?: 'front' | 'back';
}

/** The printing image follows the copied face, rather than the copying card's physical face. */
export function copyImageFace(ctx: GameContext, perm: EnginePermanent): 'front' | 'back' {
  if (perm.faceDown) return 'front';
  const def = ctx.defs.get(perm.oracleId);
  if (def?.backFace !== undefined) return perm.transformed ? 'back' : 'front';
  if (perm.copyImageFace !== undefined) return perm.copyImageFace;
  return perm.face === 'back' ? 'back' : 'front';
}

/** Layer-1 values only: counters, attachments and later continuous effects never enter a copy. */
function copiableDefinition(ctx: GameContext, perm: EnginePermanent): CardDefinition {
  const def = selectedPermanentDefinition(
    getDefByOracleId(ctx, perm.oracleId, perm.name),
    perm.face,
  );
  const face = perm.transformed ? def.backFace : undefined;
  const faceValues =
    face === undefined
      ? undefined
      : (() => {
          const {
            oracleText: _text,
            manaCostText: _cost,
            frontOracleText: _frontText,
            frontManaCostText: _frontCost,
            ...values
          } = face;
          return values;
        })();
  let result: CardDefinition =
    faceValues === undefined
      ? { ...def }
      : {
          ...faceValues,
          oracleId: def.oracleId,
          ...(def.scryfallId !== undefined ? { scryfallId: def.scryfallId } : {}),
          colorIdentity: def.colorIdentity,
          spellAbility: null,
          modeled: def.modeled,
          unmodeledReasons: def.unmodeledReasons,
        };
  delete result.backFace;
  delete result.alternativeCasts;
  if (perm.faceDown) {
    result = {
      oracleId: def.oracleId,
      name: '',
      typeLine: 'Creature',
      supertypes: [],
      types: ['Creature'],
      subtypes: [],
      colors: [],
      colorIdentity: [],
      manaCost: null,
      hasUnsupportedCost: false,
      power: 2,
      toughness: 2,
      loyalty: null,
      defense: null,
      keywords: [],
      manaAbilities: [],
      activatedAbilities: [],
      entersTapped: false,
      spellAbility: null,
      triggers: [],
      staticEffects: [],
      ruleStatics: [],
      modeled: true,
      unmodeledReasons: [],
    };
  } else {
    result.types = [...new Set([...result.types, ...(perm.copyAddTypes ?? [])])];
    result.keywords = [...new Set([...result.keywords, ...(perm.copyAddKeywords ?? [])])];
    result.triggers = [...result.triggers, ...(perm.copyAddTriggers ?? [])];
    result.supertypes = [
      ...new Set([
        ...result.supertypes.filter((type) => !perm.copyRemoveSupertypes?.includes(type)),
        ...(perm.copyAddSupertypes ?? []),
      ]),
    ];
    result.name = perm.copyNameOverride ?? result.name;
  }
  return result;
}

function internCopyDefinition(ctx: GameContext, def: CardDefinition): OracleId {
  const { oracleId: _id, scryfallId: _printing, ...values } = def;
  const oracleId = `copy:${JSON.stringify(values)}` as OracleId;
  if (!ctx.defs.has(oracleId))
    ctx.defs.set(
      oracleId,
      assertValidModeledDefinition({
        ...values,
        ...(def.scryfallId !== undefined ? { scryfallId: def.scryfallId } : {}),
        oracleId,
      }),
    );
  return oracleId;
}

/**
 * One object's participation in an event: the permanent, plus whatever the event knows about
 * it that the board does not. Combat damage is the reason this is a record rather than a bare
 * permanent — "create that many Treasure tokens" needs the amount *this* creature dealt.
 */
export interface TriggerEventSubject {
  permanent: EnginePermanent;
  /** Damage this object dealt in the event (`dealsCombatDamageToPlayer`). */
  amount?: number;
  /** Player involved in this event (the defender for attacks/combat damage). */
  playerId?: PlayerId | undefined;
  /**
   * The controller of the spell/ability that caused this event — "becomes the target of a
   * spell or ability AN OPPONENT controls" (Thunderbreak Regent) needs to compare this against
   * the watching permanent's own controller, which nothing else in `TriggerEventSubject` names.
   */
  sourceControllerId?: PlayerId;
  /** `blocks`: the attacking creature this blocker blocked, by object. */
  blockedObjectId?: ObjectId;
  /** `leavesBattlefield`: the zone this permanent went to. */
  toZone?: Zone;
  /** `countersPut`: the counter kinds this placement put on the permanent. */
  counterKinds?: readonly string[];
  /** `countersPut`: each kind's count before and after this placement, for chapter crossings. */
  counterCounts?: Readonly<Record<string, { before: number; after: number }>>;
  /** `becomesTapped`: it was tapped to activate a mana ability. */
  forMana?: true;
}

/** Discard is an action, including when a replacement changes the card's destination. */
export function* discardCard(
  ctx: GameContext,
  card: EngineCardObject,
  playerId: PlayerId,
  cause: 'effect' | 'cost' | 'cleanup' = 'effect',
): GameGen<boolean> {
  if (!ctx.state.players.find((player) => player.id === playerId)?.hand.includes(card))
    throw new Error("discard requires a card in that player's hand");
  let hidden = false;
  if (
    cause === 'effect' &&
    gatherRuleStatics(ctx).some(
      (entry) =>
        entry.controllerId === playerId && entry.static.kind === 'effectDiscardMayGoToLibraryTop',
    )
  ) {
    const choice = yield {
      decisionType: 'general',
      player: playerId,
      prompt: 'Library of Leng: put the discarded card on top of your library?',
      options: [
        { type: 'discardToLibrary', description: 'Put it on top of your library' },
        { type: 'discardNormally', description: 'Discard it normally' },
      ],
    };
    hidden = choice.index === 0;
  }
  emit(
    ctx,
    'discard',
    { player: playerId, ...(hidden ? {} : { name: card.name }), cardId: card.cardId },
    playerId,
  );
  const discardingPlayer = playerById(ctx, playerId);
  discardingPlayer.discardedCardsThisTurn = (discardingPlayer.discardedCardsThisTurn ?? 0) + 1;
  for (const source of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec?.when !== 'discardsCard') continue;
      if (spec.player === 'you' && playerId !== source.controllerId) continue;
      if (spec.player === 'opponent' && playerId === source.controllerId) continue;
      const from: SelectorSource = {
        cardId: source.cardId,
        objectId: source.id,
        controllerId: source.controllerId,
      };
      if (spec.filter !== undefined) {
        // CR 701.9c: a discard into a hidden zone has undefined characteristics.
        const matchesHiddenIdentity = (filter: Selector): boolean => {
          if (filter.kind === 'other') return source.cardId !== card.cardId;
          if (filter.kind === 'self') return source.cardId === card.cardId;
          if (filter.kind === 'allOf') return filter.of.every(matchesHiddenIdentity);
          if (filter.kind === 'anyOf') return filter.of.some(matchesHiddenIdentity);
          return false;
        };
        if (
          hidden
            ? !matchesHiddenIdentity(spec.filter)
            : !selectMatches(cardZoneCandidate(ctx, card, playerId), spec.filter, from)
        )
          continue;
      }
      if (
        spec.condition !== undefined &&
        !evaluateCondition(ctx, spec.condition, { ...from, eventPlayerId: playerId })
      )
        continue;
      for (let copy = 0; copy <= additionalTypedTriggerCopies(ctx, source); copy++) {
        ctx.state.pendingTriggers.push({
          controllerId: source.controllerId,
          sourceCardId: source.cardId,
          sourceObjectId: source.id,
          sourceOracleId: source.oracleId,
          sourceName: source.name,
          ability,
          triggerObjectCardId: card.cardId,
          scope: { eventPlayerId: playerId, eventObjectId: card.id },
        });
      }
    }
  }
  const discarded = yield* moveObject(
    ctx,
    card,
    hidden ? { zone: 'library', libraryPosition: 'top' } : { zone: 'graveyard' },
  );
  if (!hidden && discarded !== null) {
    for (const trigger of ctx.state.pendingTriggers) {
      if (trigger.scope?.eventObjectId === card.id)
        trigger.scope.eventObjectDestinationId = discarded.id;
    }
  }
  return !hidden;
}

/**
 * Number of additional times `source`'s triggered ability fires because of Harmonic Prodigy
 * effects. Computed once for the original event, so copied triggers never recursively copy.
 */
export function additionalTypedTriggerCopies(ctx: GameContext, source: EnginePermanent): number {
  return harmonicCopies(ctx, source) + additionalTriggerTimes(ctx, source);
}

/** "It triggers an additional time" statics (Annie Joins Up, Roaming Throne), one each. */
function additionalTriggerTimes(ctx: GameContext, source: EnginePermanent): number {
  let copies = 0;
  for (const { static: rule, sourceCardId, controllerId } of gatherRuleStatics(ctx)) {
    if (rule.kind !== 'triggerAdditionalTime' || controllerId !== source.controllerId) continue;
    if (rule.excludesSelf === true && sourceCardId === source.cardId) continue;
    const amplifier = ctx.state.battlefield.find((perm) => perm.cardId === sourceCardId);
    const from: SelectorSource = {
      cardId: sourceCardId,
      controllerId,
      ...(amplifier?.chosenOption === undefined ? {} : { chosenOption: amplifier.chosenOption }),
    };
    if (matchesSelector(ctx, source, rule.filter, from)) copies++;
  }
  return copies;
}

function harmonicCopies(ctx: GameContext, source: EnginePermanent): number {
  const sourceSubtypes = computeCharacteristics(ctx, source).subtypes;
  const isShaman = sourceSubtypes.includes('Shaman');
  const isWizard = sourceSubtypes.includes('Wizard');
  if (!isShaman && !isWizard) return 0;

  return ctx.state.battlefield.filter((amplifier) => {
    if (amplifier.controllerId !== source.controllerId) return false;
    const hasEffect =
      ctx.defs
        .get(amplifier.oracleId)
        ?.ruleStatics.some((rule) => rule.kind === 'triggerAdditionalForShamanOrOtherWizard') ??
      false;
    if (!hasEffect) return false;
    return isShaman || (isWizard && source.cardId !== amplifier.cardId);
  }).length;
}

/**
 * Queue the narrow non-battlefield card-transition events used by Syr Konrad. These are card
 * events rather than permanent events, so they match printed card characteristics directly and
 * intentionally scan only battlefield sources.
 *
 * Leaving a graveyard looks back in time (CR 603.10a): a permanent that this same event put onto
 * the battlefield was not there to see it, so its new object ids are passed in `enteredIds`.
 */
function queueCardZoneTriggers(
  ctx: GameContext,
  when: 'putIntoGraveyardFromAnywhere' | 'leavesGraveyard',
  cards: EngineCardObject[],
  enteredIds: readonly string[] = [],
  fromBattlefield = false,
  departureFacts: ReadonlyMap<string, ObjectFacts> = new Map(),
): void {
  const sources = ctx.state.battlefield.filter((source) => !enteredIds.includes(source.id));
  const hasWatcher = sources.some((source) =>
    triggersOf(ctx, source).some((ability) => ability.trigger?.when === when),
  );
  if (!hasWatcher) return;
  for (const source of sources) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when || !('subject' in spec)) continue;
      if (fromBattlefield && spec.fromAnyOrigin !== true) continue;
      const from: SelectorSource = {
        cardId: source.cardId,
        objectId: source.id,
        ...(source.lastKnownFacts === undefined ? {} : { sourceFacts: source.lastKnownFacts }),
        controllerId: source.controllerId,
        attachedToCardId:
          source.attachedTo === null
            ? null
            : (ctx.state.battlefield.find((perm) => perm.id === source.attachedTo)?.cardId ?? null),
      };
      const matched = cards.filter((card) => {
        // "From anywhere" triggers inspect the post-event battlefield (unlike dies).
        // The dying object's characteristics still come from before it left.
        if (fromBattlefield) {
          const facts = departureFacts.get(card.cardId);
          if (facts === undefined) throw new Error('engine bug: missing graveyard departure facts');
          if (
            gatherRuleStatics(ctx).some(
              (entry) =>
                entry.static.kind === 'suppressObjectTriggers' &&
                entry.static.events.includes('dies') &&
                selectMatches(facts.candidate, entry.static.filter, {
                  cardId: entry.sourceCardId,
                  controllerId: entry.controllerId,
                }),
            )
          )
            return false;
        }
        const candidate = cardZoneCandidate(ctx, card, card.ownerId);
        return spec.subject.kind === 'self'
          ? source.cardId === card.cardId
          : selectMatches(candidate, spec.subject.selector, from);
      });
      if (matched.length === 0) continue;
      const firings = spec.aggregate === true ? [matched] : matched.map((card) => [card]);
      for (const firing of firings) {
        const first = firing[0] as EngineCardObject;
        if (
          spec.condition !== undefined &&
          !evaluateCondition(ctx, spec.condition, {
            ...from,
            triggerObjectCardId: first.cardId,
          })
        ) {
          continue;
        }
        const copies = 1 + additionalTypedTriggerCopies(ctx, source);
        for (let copy = 0; copy < copies; copy++) {
          ctx.state.pendingTriggers.push({
            controllerId: source.controllerId,
            sourceCardId: source.cardId,
            sourceObjectId: source.id,
            sourceOracleId: source.oracleId,
            sourceName: source.name,
            ability,
            ...(spec.subject.kind === 'self' ? {} : { triggerObjectCardId: first.cardId }),
            scope: {
              ...(spec.subject.kind === 'self' ? {} : { eventObjectId: first.id }),
              ...(spec.aggregate === true ? { triggerCount: firing.length } : {}),
            },
          });
          debug(ctx, 'stack', `${when} trigger queued: ${source.name}`);
        }
      }
    }
  }
}

/**
 * Queue every ability that triggers on this event (CR 603.3b).
 *
 * Two vantage points, one mechanism. A subject's OWN abilities fire on `{kind:'self'}`; every
 * other battlefield permanent's abilities fire if their selector matches a subject ("whenever
 * a Dragon you control attacks"). So this scans the whole battlefield, not just the objects the
 * event happened to.
 *
 * It takes a LIST of subjects because some events are genuinely simultaneous — all attackers are
 * declared at once (CR 508.1), all combat damage is dealt at once (CR 510.2) — and an aggregate
 * trigger has to see the whole set to know its count. Non-aggregate triggers still fire once per
 * matching subject, so passing a one-element list reproduces the old per-object behavior exactly.
 *
 * Everything is read from *current* characteristics. For a `dies` event the permanent has
 * already left, so that is last-known information — continuous effects from other permanents
 * still applied to it, and that is what decides whether it had the trigger at all.
 */
export function queueTriggersForEvent(
  ctx: GameContext,
  when: ObjectTriggerWhen,
  subjects: TriggerEventSubject[],
): void {
  assertTriggerEventFamily(when, 'object');
  if (subjects.length === 0) return;

  // A dying permanent is gone from the battlefield but is still an ability source for its own
  // "when this dies" trigger, so it has to be added back as a candidate source.
  const missing = subjects
    .map((s) => s.permanent)
    .filter((perm) => !ctx.state.battlefield.some((p) => p.cardId === perm.cardId));
  const sources = [...ctx.state.battlefield, ...missing];
  const counterSubjects = subjects;
  if (when === 'enters' || when === 'dies') {
    const suppressors = sources.flatMap((source) => {
      if (
        source.faceDown ||
        (source.lastKnownFacts?.loseAbilities ?? computeCharacteristics(ctx, source).loseAbilities)
      )
        return [];
      const def = selectedPermanentDefinition(
        getDefByOracleId(ctx, source.oracleId, source.name),
        source.face,
      );
      const rules =
        source.transformed && def.backFace !== undefined
          ? def.backFace.ruleStatics
          : def.ruleStatics;
      return rules
        .filter((rule) => rule.kind === 'suppressObjectTriggers' && rule.events.includes(when))
        .map((rule) => ({ rule, source }));
    });
    subjects = subjects.filter(
      (subject) =>
        !suppressors.some(
          ({ rule, source }) =>
            rule.kind === 'suppressObjectTriggers' &&
            selectMatches(
              subject.permanent.lastKnownFacts?.candidate ??
                candidateOf(ctx, subject.permanent, computeCharacteristics(ctx, subject.permanent)),
              rule.filter,
              { cardId: source.cardId, controllerId: source.controllerId },
            ),
        ),
    );
  }

  for (const source of sources) {
    for (const [abilityIndex, ability] of triggersOf(ctx, source).entries()) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;
      // A graveyard-only ability does not function on the battlefield (CR 112.6).
      if (ability.functionsInGraveyard === true) continue;

      const from: SelectorSource = {
        cardId: source.cardId,
        objectId: source.id,
        ...(source.lastKnownFacts === undefined ? {} : { sourceFacts: source.lastKnownFacts }),
        controllerId: source.controllerId,
        // "When enchanted creature dies" looks back (CR 603.10a): the dying permanent has left
        // the battlefield, but the Aura is still attached to it until state-based actions run.
        attachedToCardId:
          source.attachedTo === null
            ? null
            : (sources.find((perm) => perm.id === source.attachedTo)?.cardId ?? null),
      };
      const matched = subjects.filter((s) => {
        // "an opponent controls" (Thunderbreak Regent) — the watcher's own targeting spells
        // and abilities never qualify, regardless of what the subject selector matches.
        if (when === 'becomesTargeted' && s.sourceControllerId === source.controllerId)
          return false;
        if (!matchesEntryRestrictions(spec, s.permanent, source.controllerId)) return false;
        if ('leavesTo' in spec && spec.leavesTo !== undefined) {
          if (s.toZone !== 'graveyard' && s.toZone !== 'exile') return false;
          if (!spec.leavesTo.includes(s.toZone)) return false;
        }
        if (
          'counter' in spec &&
          spec.counter !== undefined &&
          !(s.counterKinds ?? []).includes(spec.counter)
        )
          return false;
        if ('chapter' in spec && spec.chapter !== undefined) {
          const lore = s.counterCounts?.['lore'];
          if (lore === undefined || lore.before >= spec.chapter || lore.after < spec.chapter)
            return false;
        }
        if ('byYou' in spec && spec.byYou === true && s.playerId !== source.controllerId)
          return false;
        if ('forMana' in spec && spec.forMana === true && s.forMana !== true) return false;
        // "...attack an opponent" (Firkraag) is about attacking the player; a creature attacking
        // only a planeswalker of theirs isn't attacking that opponent.
        if (
          when === 'attacks' &&
          spec.aggregate === 'byEventPlayer' &&
          s.permanent.attackingPlaneswalker !== null
        )
          return false;
        return spec.subject.kind === 'self'
          ? source.cardId === s.permanent.cardId
          : matchesSelector(ctx, s.permanent, spec.subject.selector, from);
      });
      if (matched.length === 0) continue;

      // Aggregate triggers can either combine the whole event or combine separately for each
      // player involved in it ("one or more ... attack an opponent"). For `attacks`, `playerId`
      // on each subject is the ATTACKER (Breena, Combat Calligrapher: "that attacking player" —
      // non-aggregate, one firing per creature, so this is unambiguous). `byEventPlayer` grouping
      // is a different vantage point: "one or more Dragons you control attack an opponent" reads
      // per DEFENDER — one shared firing per opponent attacked, targeting/eventPlayer bound to
      // that opponent (Firkraag, Cunning Instigator) — so only this branch swaps in the
      // defender (`permanent.attacking`) instead of the attacker.
      const byEventPlayerKey = (s: TriggerEventSubject): PlayerId | undefined =>
        when === 'attacks' ? (s.permanent.attacking ?? undefined) : s.playerId;
      const grouped: TriggerEventSubject[][] =
        spec.aggregate === true
          ? [matched]
          : spec.aggregate === 'byEventPlayer'
            ? [
                ...new Map(
                  matched.map((s) => [
                    byEventPlayerKey(s),
                    matched.filter((other) => byEventPlayerKey(other) === byEventPlayerKey(s)),
                  ]),
                ).values(),
              ]
            : matched.map((s) => [s]);
      // Battalion: the other creatures declared as attackers alongside this one (CR 508.1).
      if (
        'withOtherAttackers' in spec &&
        spec.withOtherAttackers !== undefined &&
        subjects.filter((subject) => subject.permanent.id !== source.id).length <
          spec.withOtherAttackers
      )
        continue;
      // "if none of them were cast or no mana was spent to cast them" — judged over the firing.
      const firings =
        'entersWithoutManaSpentToCast' in spec && spec.entersWithoutManaSpentToCast === true
          ? grouped.filter((group) =>
              group.every((subject) => (subject.permanent.manaSpentToCast ?? 0) === 0),
            )
          : grouped;

      // Panharmonicon-style doubling is decided per firing: in a simultaneous batch, only a
      // firing for an entering artifact or creature is doubled, not one for a land beside it.
      const entryDoublers =
        when === 'enters'
          ? ctx.state.battlefield.filter((perm) => {
              if (perm.controllerId !== source.controllerId) return false;
              const def = ctx.defs.get(perm.oracleId);
              return (
                def?.ruleStatics.some(
                  (rs) => rs.kind === 'triggerAdditionalOnArtifactOrCreatureEntry',
                ) ?? false
              );
            }).length
          : 0;
      const typedCopies = additionalTypedTriggerCopies(ctx, source);
      const additionalCopiesFor = (group: TriggerEventSubject[]): number =>
        typedCopies +
        (entryDoublers > 0 &&
        group.some((s) => {
          const chars = computeCharacteristics(ctx, s.permanent);
          return chars.types.includes('Artifact') || chars.types.includes('Creature');
        })
          ? entryDoublers
          : 0);
      for (const group of firings) {
        for (let copy = 0; copy <= additionalCopiesFor(group); copy++) {
          const first = group[0] as TriggerEventSubject;
          const eventPlayerId =
            'defendingPlayerIsEventPlayer' in spec &&
            spec.defendingPlayerIsEventPlayer === true &&
            first.permanent.attacking !== null
              ? first.permanent.attacking
              : 'attackingPlayerIsEventPlayer' in spec && spec.attackingPlayerIsEventPlayer === true
                ? first.playerId
                : // "That creature's controller" (Dingus Staff): the dying permanent's controller
                  // as it last existed on the battlefield (CR 603.10a).
                  'subjectControllerIsEventPlayer' in spec &&
                    spec.subjectControllerIsEventPlayer === true
                  ? first.permanent.controllerId
                  : spec.aggregate === 'byEventPlayer'
                    ? byEventPlayerKey(first)
                    : first.playerId;
          // Attack qualifications are checked once at the event. A genuine intervening-if
          // is also checked here, then checked again on resolution (CR 603.4).
          if (
            [spec.eventCondition, spec.condition].some(
              (condition) =>
                condition !== undefined &&
                !evaluateCondition(ctx, condition, {
                  ...from,
                  ...(eventPlayerId === undefined ? {} : { eventPlayerId }),
                  ...eventObjectScope(ctx, first.permanent),
                  ...(spec.subject.kind === 'self'
                    ? {}
                    : { triggerObjectCardId: first.permanent.cardId }),
                }),
            )
          ) {
            debug(ctx, 'stack', `trigger not queued: ${source.name} — condition false at event`);
            continue;
          }
          // "This ability triggers only once each turn": the object's first firing this turn is
          // the only one, even within one simultaneous event. An effect that makes that firing
          // trigger additional times still adds its copies.
          if ('oncePerTurn' in spec && spec.oncePerTurn === true && copy === 0) {
            if (source.triggeredOnceThisTurn?.includes(abilityIndex) === true) break;
            source.triggeredOnceThisTurn = [...(source.triggeredOnceThisTurn ?? []), abilityIndex];
          }
          const amounts = group.filter((s) => s.amount !== undefined);
          const scope: TriggerScope = {
            ...(spec.aggregate !== undefined ? { triggerCount: group.length } : {}),
            ...(spec.aggregate !== undefined &&
            ability.effects.some(
              (effect) =>
                effect.op === 'createTokenCopyOfEventGroupMember' ||
                effect.op === 'mayReturnEventGroupMemberToHand',
            )
              ? { eventGroupIds: group.map((subject) => subject.permanent.id) }
              : {}),
            ...(eventPlayerId !== undefined ? { eventPlayerId } : {}),
            ...(first.blockedObjectId !== undefined
              ? { blockedObjectId: first.blockedObjectId }
              : {}),
            ...(spec.subject.kind !== 'self' ? eventObjectScope(ctx, first.permanent) : {}),
            ...(amounts.length > 0
              ? { damageDealt: amounts.reduce((sum, s) => sum + (s.amount ?? 0), 0) }
              : {}),
          };
          ctx.state.pendingTriggers.push({
            controllerId: source.controllerId,
            sourceCardId: source.cardId,
            sourceObjectId: source.id,
            sourceOracleId: source.oracleId,
            sourceName: source.name,
            ...(source.lastKnownFacts === undefined ? {} : { sourceFacts: source.lastKnownFacts }),
            ability,
            // Only meaningful when the subject is something other than the source itself.
            ...(spec.subject.kind === 'self'
              ? {}
              : { triggerObjectCardId: first.permanent.cardId }),
            ...(Object.keys(scope).length > 0 ? { scope } : {}),
          });
          debug(ctx, 'stack', `trigger queued: ${source.name} — ${ability.description ?? ''}`);
        }
      }
    }
  }

  // Graveyard-functioning triggers (CR 112.6a/603.6d, Spit Flame) — a card whose ability says
  // it works from the graveyard is scanned here in addition to the battlefield; nothing else
  // ever looks at a graveyard card's `def.triggers`.
  for (const player of ctx.state.players) {
    for (const card of player.graveyard) {
      const def = ctx.defs.get(card.oracleId);
      if (def === undefined) continue;
      for (const ability of def.triggers) {
        if (ability.functionsInGraveyard !== true) continue;
        const spec = ability.trigger;
        if (spec === undefined || spec.when !== when || !('subject' in spec)) continue;
        const from: SelectorSource = { cardId: card.cardId, controllerId: card.ownerId };
        const matched = subjects.filter((s) =>
          spec.subject.kind === 'self'
            ? false
            : matchesEntryRestrictions(spec, s.permanent, card.ownerId) &&
              enteredWithoutManaIfRequired(spec, s.permanent) &&
              matchesSelector(ctx, s.permanent, spec.subject.selector, from),
        );
        for (const s of matched) {
          if (
            [spec.eventCondition, spec.condition].some(
              (condition) =>
                condition !== undefined &&
                !evaluateCondition(ctx, condition, {
                  ...from,
                  triggerObjectCardId: s.permanent.cardId,
                }),
            )
          ) {
            continue;
          }
          ctx.state.pendingTriggers.push({
            controllerId: card.ownerId,
            sourceCardId: card.cardId,
            sourceObjectId: card.id,
            sourceOracleId: card.oracleId,
            sourceName: card.name,
            ability,
            triggerObjectCardId: s.permanent.cardId,
            scope: eventObjectScope(ctx, s.permanent),
          });
          debug(ctx, 'stack', `graveyard trigger queued: ${card.name}`);
        }
      }
    }
  }

  for (const player of ctx.state.players) {
    for (const emblem of player.emblems) {
      for (const ability of emblem.abilities) {
        const spec = ability.trigger;
        if (spec === undefined || spec.when !== when || !('subject' in spec)) continue;
        const from: SelectorSource = { cardId: emblem.id, controllerId: emblem.controllerId };
        const matched = subjects.filter((subject) =>
          spec.subject.kind === 'self'
            ? false
            : matchesEntryRestrictions(spec, subject.permanent, emblem.controllerId) &&
              enteredWithoutManaIfRequired(spec, subject.permanent) &&
              matchesSelector(ctx, subject.permanent, spec.subject.selector, from),
        );
        for (const subject of matched) {
          const eventPlayerId =
            spec.defendingPlayerIsEventPlayer === true && subject.permanent.attacking !== null
              ? subject.permanent.attacking
              : subject.playerId;
          const scope: TriggerScope = {
            ...eventObjectScope(ctx, subject.permanent),
            ...(eventPlayerId === undefined ? {} : { eventPlayerId }),
          };
          if (
            [spec.eventCondition, spec.condition].some(
              (condition) =>
                condition !== undefined &&
                !evaluateCondition(ctx, condition, {
                  ...from,
                  ...scope,
                  triggerObjectCardId: subject.permanent.cardId,
                }),
            )
          )
            continue;
          ctx.state.pendingTriggers.push({
            controllerId: emblem.controllerId,
            sourceCardId: emblem.id,
            sourceOracleId: '' as never,
            sourceName: emblem.name,
            ability,
            triggerObjectCardId: subject.permanent.cardId,
            scope,
          });
          debug(ctx, 'stack', `emblem trigger queued: ${emblem.name}`);
        }
      }
    }
  }
  const firedDelayedIds = new Set<string>();
  for (const delayed of ctx.state.delayedTriggers) {
    if (delayed.when !== when) continue;
    const matchingSubject =
      delayed.targetId !== undefined
        ? subjects.find(
            (s) =>
              s.permanent.cardId === delayed.targetId &&
              (delayed.targetObjectId === undefined || s.permanent.id === delayed.targetObjectId),
          )
        : subjects[0];

    if (matchingSubject === undefined) continue;

    const scope: TriggerScope = {
      ...eventObjectScope(ctx, matchingSubject.permanent),
      ...(matchingSubject.amount !== undefined ? { damageDealt: matchingSubject.amount } : {}),
      ...(delayed.affectedPlayerId === undefined
        ? {}
        : { eventPlayerId: delayed.affectedPlayerId }),
      ...(delayed.targetObjectId === undefined ? {} : { triggerObjectId: delayed.targetObjectId }),
    };

    ctx.state.pendingTriggers.push({
      controllerId: delayed.controllerId,
      sourceCardId: delayed.sourceCardId,
      sourceOracleId: delayed.sourceOracleId,
      sourceName: 'Delayed Trigger',
      ability: delayed.ability,
      triggerObjectCardId: matchingSubject.permanent.cardId,
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
    });
    debug(ctx, 'stack', `delayed trigger queued: ${delayed.id}`);
    if (delayed.expiry === 'onFire') firedDelayedIds.add(delayed.id);
  }
  if (firedDelayedIds.size > 0)
    ctx.state.delayedTriggers = ctx.state.delayedTriggers.filter(
      (delayed) => !firedDelayedIds.has(delayed.id),
    );
  // A permanent that enters with counters has had them put on it (CR 122.6), by its controller
  // unless an effect says otherwise (CR 122.6a): one placement for each entering permanent.
  if (when === 'enters') {
    queueTriggersForEvent(
      ctx,
      'countersPut',
      counterSubjects.flatMap((subject) => {
        const counterKinds = Object.entries(subject.permanent.counters)
          .filter(([, count]) => count > 0)
          .map(([counter]) => counter);
        return counterKinds.length === 0
          ? []
          : [
              {
                permanent: subject.permanent,
                playerId: subject.permanent.controllerId,
                counterKinds,
                counterCounts: Object.fromEntries(
                  counterKinds.map((counter) => [
                    counter,
                    { before: 0, after: subject.permanent.counters[counter] ?? 0 },
                  ]),
                ),
              },
            ];
      }),
    );
  }
}

/**
 * A permanent is leaving: record its colors and damage keywords on every ability of its own
 * waiting on the stack or about to be put there, so its targets and the damage it deals after it
 * is gone use the colors, deathtouch, lifelink and infect it had immediately before it left
 * (CR 113.7a, Mordant Dragon). Damage keywords are only recorded when it had any.
 */
function rememberLeavingSourceTraits(
  ctx: GameContext,
  perm: EnginePermanent,
  batchFacts?: ObjectFacts,
): void {
  const facts = batchFacts ?? captureObjectFacts(ctx, perm);
  perm.lastKnownFacts = facts;
  ctx.resolutionObjectFacts?.set(perm.id, facts);
  for (const entry of ctx.state.stack) {
    const scope = entry.triggerScope;
    if ((scope?.triggerObjectId ?? scope?.eventObjectId) === perm.id)
      scope!.triggerObjectFacts = facts;
  }
  for (const pending of ctx.state.pendingTriggers) {
    const scope = pending.scope;
    if ((scope?.triggerObjectId ?? scope?.eventObjectId) === perm.id)
      scope!.triggerObjectFacts = facts;
  }
  for (const scope of [
    ...ctx.state.stack.map((entry) => entry.triggerScope),
    ...ctx.state.pendingTriggers.map((pending) => pending.scope),
  ]) {
    if (scope?.eventGroupIds?.includes(perm.id) === true)
      scope.eventGroupFacts = { ...scope.eventGroupFacts, [perm.id]: facts };
  }
  const entries = ctx.state.stack.filter(
    (entry) =>
      entry.kind !== 'spell' &&
      entry.sourceCardId === perm.cardId &&
      (entry.sourceId === perm.id || entry.sourceId === perm.cardId),
  );
  // Triggers that have fired but are not on the stack yet: combat damage that also kills the
  // source triggers first, then state-based actions remove the source before it is put there.
  const pending = ctx.state.pendingTriggers.filter(
    (trigger) =>
      trigger.sourceCardId === perm.cardId &&
      (trigger.sourceObjectId === undefined || trigger.sourceObjectId === perm.id),
  );
  if (entries.length === 0 && pending.length === 0) return;
  const keywords = damageKeywordsOf(ctx, perm);
  const colors = colorsOf(ctx, perm);
  for (const entry of [...entries, ...pending]) {
    entry.sourceFacts = facts;
    entry.sourceColors = [...colors];
    if (keywords.length > 0) entry.sourceDamageKeywords = keywords;
    else delete entry.sourceDamageKeywords;
  }
}

/**
 * The parts of an enters event a trigger head can require beyond its subject: entering untapped
 * (Mystic Sanctuary) and entering from a graveyard, or from the watcher controller's own
 * graveyard (CR 603.6a). Applied the same way wherever the trigger's source lives — on the
 * battlefield, in a graveyard or on an emblem.
 */
function matchesEntryRestrictions(
  spec: TriggerSpec,
  permanent: EnginePermanent,
  watcherControllerId: PlayerId,
): boolean {
  if ('entersUntapped' in spec && spec.entersUntapped === true && permanent.tapped) return false;
  if ('entersFrom' in spec && spec.entersFrom !== undefined) {
    if (
      permanent.enteredFromZone !== spec.entersFrom.zone &&
      !(spec.entersFrom.orCastFrom === true && permanent.castFromZone === spec.entersFrom.zone)
    )
      return false;
    // A card is only ever in its owner's graveyard (CR 404.2).
    if (spec.entersFrom.graveyardOwner === 'you' && permanent.ownerId !== watcherControllerId)
      return false;
  }
  return true;
}

/**
 * `entersWithoutManaSpentToCast` for a watcher that fires once per permanent (graveyard and
 * emblem sources do not aggregate): that permanent was not cast, or was cast for no mana.
 * Battlefield sources judge the whole firing group instead.
 */
function enteredWithoutManaIfRequired(spec: TriggerSpec, permanent: EnginePermanent): boolean {
  if (!('entersWithoutManaSpentToCast' in spec) || spec.entersWithoutManaSpentToCast !== true)
    return true;
  return (permanent.manaSpentToCast ?? 0) === 0;
}

export function queueTriggersForObject(
  ctx: GameContext,
  when: ObjectTriggerWhen,
  permanent: EnginePermanent,
  /** `becomesTapped` for a mana ability: the player who activated it. */
  tappedForMana?: PlayerId,
): void {
  queueTriggersForEvent(ctx, when, [
    tappedForMana === undefined
      ? { permanent }
      : { permanent, forMana: true, playerId: tappedForMana },
  ]);
}

/**
 * Queue "whenever you cast …" triggers (CR 603.2). The subject is a spell on the stack, not a
 * permanent, so it is matched against the *card's* characteristics via `cardCandidate` — the
 * same projection library searches use.
 *
 * Fired at announcement, after the spell is on the stack, so the trigger resolves FIRST
 * (CR 603.3b puts it above the spell that caused it).
 */
/** "casts a spell from a graveyard" / "from anywhere other than your hand", by the cast record. */
function castFromMatches(
  spec: Extract<TriggerSpec, { when: 'castsSpell' }>,
  spell: EngineStackObject,
): boolean {
  if (spec.castFrom === undefined) return true;
  const origin = spell.card?.castFromZone;
  if (origin === undefined) return false;
  if (spec.castFrom === 'hand') return origin === 'hand';
  return spec.castFrom === 'graveyard' ? origin === 'graveyard' : origin !== 'hand';
}

/** CR 113.6a: a spell's own characteristic-defining power ability works on the stack.
 * Battlefield pumps do not apply to spells. Evaluate only its self-defining layer-7a effects,
 * against the board at cast time, before the creature itself has entered (CR 603.2).
 */
function castSpellPower(ctx: GameContext, spell: EngineStackObject): number {
  const definition = spellDefinitionOf(ctx, spell);
  let power = definition.power ?? 0;
  for (const effect of definition.staticEffects) {
    if (
      effect.affects.kind !== 'self' ||
      effect.op.layer !== 7 ||
      effect.op.sublayer !== 'a' ||
      effect.op.power === undefined
    )
      continue;
    power =
      typeof effect.op.power === 'number'
        ? effect.op.power
        : evaluateValueIn(ctx, effect.op.power, {
            controllerId: spell.controllerId,
            sourceCardId: spell.sourceCardId,
          });
  }
  return power;
}

export function queueCastTriggers(ctx: GameContext, spell: EngineStackObject): void {
  const def = spellDefinitionOf(ctx, spell);

  const caster = playerById(ctx, spell.controllerId);
  // Casting a prepare spell's copy unprepares its permanent as the spell becomes cast (CR
  // 722.3c, 601.2i).
  const preparedBy = spell.card?.preparedBy;
  if (preparedBy !== undefined) {
    const prepared = ctx.state.battlefield.find((perm) => perm.id === preparedBy);
    if (prepared !== undefined) delete prepared.prepared;
  }
  caster.spellsCastThisTurn += 1;
  // Addendum: "if you cast this spell during your main phase" is a fact of the cast itself.
  if (
    ctx.state.currentTurnPlayer === caster.id &&
    (ctx.state.phase === 'precombatMain' || ctx.state.phase === 'postcombatMain')
  )
    spell.castDuringOwnMainPhase = true;
  // A spell's type is read off its printed characteristics — it is on the stack, not the
  // battlefield, so the layer engine has produced nothing for it (CR 608.2 has not run yet).
  if (!def.types.includes('Creature')) caster.noncreatureSpellsCastThisTurn += 1;

  // Match the spell itself, including its own characteristic-defining power. Battlefield
  // continuous effects do not apply to it while it is on the stack.
  const candidate: SelectorCandidate = {
    cardId: spell.sourceCardId,
    controllerId: spell.controllerId,
    types: offBattlefieldTypes(ctx, def.types, spell.controllerId),
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: castSpellPower(ctx, spell),
    keywords: def.keywords,
    // A spell on the stack is a card, never a token (CR 111.1) — a token is only ever a
    // permanent, so nothing that gets here can be one.
    isToken: false,
    enteredThisTurn: false,
  };
  const manaValue = spellManaValue(def, spell.announcedX);
  const castThisTurn = (caster.spellsCastThisTurnRecords ??= []);
  castThisTurn.push({ objectId: spell.sourceId, candidate, manaValue });
  // "Your fourth NONCREATURE spell each turn" numbers the spells that match the filter, not
  // every spell cast: a creature spell cast first does not use up "first noncreature".
  const ordinalMatches = (
    spec: Extract<TriggerSpec, { when: 'castsSpell' }>,
    from: SelectorSource,
  ): boolean =>
    spec.ordinal === undefined ||
    castThisTurn.filter(
      (record) => spec.filter === undefined || selectMatches(record.candidate, spec.filter, from),
    ).length === spec.ordinal;

  for (const source of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== 'castsSpell') continue;
      // A graveyard-only ability does not function on the battlefield (CR 112.6).
      if (ability.functionsInGraveyard === true) continue;

      const isController = spell.controllerId === source.controllerId;
      if (spec.caster === 'you' && !isController) continue;
      if (spec.caster === 'opponent' && isController) continue;
      if (!castFromMatches(spec, spell)) continue;

      const from: SelectorSource = {
        cardId: source.cardId,
        objectId: source.id,
        controllerId: source.controllerId,
        eventPlayerId: spell.controllerId,
        ...(spell.triggerScope?.manaSpent !== undefined
          ? { manaSpent: spell.triggerScope.manaSpent }
          : {}),
        attachedToCardId:
          source.attachedTo === null
            ? null
            : (ctx.state.battlefield.find((perm) => perm.id === source.attachedTo)?.cardId ?? null),
      };
      // `selectMatches`, not `matchesSelector`: the spell is not a permanent, so there are no
      // layered characteristics to compute — the candidate above is already the whole answer.
      if (spec.filter !== undefined && !selectMatches(candidate, spec.filter, from)) continue;
      if (!ordinalMatches(spec, from)) continue;
      if (spec.targetFilter !== undefined) {
        const hasMatchingTarget = spell.targets.some((targetId) => {
          const target = ctx.state.battlefield.find(
            (permanent) => permanent.id === targetId || permanent.cardId === targetId,
          );
          return (
            target !== undefined &&
            matchesSelector(ctx, target, spec.targetFilter as Selector, from)
          );
        });
        if (!hasMatchingTarget) continue;
      }
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, from)) continue;

      const copies = 1 + additionalTypedTriggerCopies(ctx, source);
      for (let copy = 0; copy < copies; copy++) {
        ctx.state.pendingTriggers.push({
          controllerId: source.controllerId,
          sourceCardId: source.cardId,
          sourceObjectId: source.id,
          sourceOracleId: source.oracleId,
          sourceName: source.name,
          ability: bindCastSpell(ctx, ability, spell),
          scope: {
            spellManaValue: manaValue,
            spellColorCount: candidate.colors.length,
            eventPlayerId: spell.controllerId,
            ...(spell.triggerScope?.manaSpent !== undefined
              ? { manaSpent: spell.triggerScope.manaSpent }
              : {}),
          },
        });
        debug(ctx, 'stack', `cast trigger queued: ${source.name} — ${spell.description}`);
      }
    }
  }

  // Delayed cast triggers (Galvanic Iteration's "when you next cast an instant or sorcery spell
  // this turn"): only the controller's own matching spells, and a `once` trigger fires once.
  const firedCastDelayed = new Set<string>();
  for (const delayed of ctx.state.delayedTriggers) {
    if (delayed.when !== 'castsSpell' || delayed.controllerId !== spell.controllerId) continue;
    const from: SelectorSource = {
      cardId: delayed.sourceCardId,
      controllerId: delayed.controllerId,
      eventPlayerId: spell.controllerId,
    };
    if (delayed.castFilter !== undefined && !selectMatches(candidate, delayed.castFilter, from))
      continue;
    ctx.state.pendingTriggers.push({
      controllerId: delayed.controllerId,
      sourceCardId: delayed.sourceCardId,
      sourceOracleId: delayed.sourceOracleId,
      sourceName: 'Delayed Trigger',
      ability: bindCastSpell(ctx, delayed.ability, spell),
      scope: {
        spellManaValue: manaValue,
        spellColorCount: candidate.colors.length,
        eventPlayerId: spell.controllerId,
      },
    });
    debug(ctx, 'stack', `delayed cast trigger queued: ${delayed.id} — ${spell.description}`);
    if (delayed.once === true) firedCastDelayed.add(delayed.id);
  }
  if (firedCastDelayed.size > 0)
    ctx.state.delayedTriggers = ctx.state.delayedTriggers.filter(
      (delayed) => !firedCastDelayed.has(delayed.id),
    );

  // Graveyard-functioning cast triggers (CR 112.6a, Aurora Phoenix): a card whose ability says
  // it works from the graveyard watches casts from there, under its owner's control.
  for (const player of ctx.state.players) {
    for (const card of player.graveyard) {
      const def = ctx.defs.get(card.oracleId);
      if (def === undefined) continue;
      for (const ability of def.triggers) {
        if (ability.functionsInGraveyard !== true) continue;
        const spec = ability.trigger;
        if (spec === undefined || spec.when !== 'castsSpell') continue;
        const isController = spell.controllerId === card.ownerId;
        if (spec.caster === 'you' && !isController) continue;
        if (spec.caster === 'opponent' && isController) continue;
        if (!castFromMatches(spec, spell)) continue;
        const from: SelectorSource = {
          cardId: card.cardId,
          objectId: card.id,
          controllerId: card.ownerId,
          eventPlayerId: spell.controllerId,
        };
        if (spec.filter !== undefined && !selectMatches(candidate, spec.filter, from)) continue;
        if (!ordinalMatches(spec, from)) continue;
        // No graveyard-functioning card watches a spell's targets; fail closed rather than fire.
        if (spec.targetFilter !== undefined) continue;
        if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, from)) continue;
        ctx.state.pendingTriggers.push({
          controllerId: card.ownerId,
          sourceCardId: card.cardId,
          sourceObjectId: card.id,
          sourceOracleId: card.oracleId,
          sourceName: card.name,
          ability,
          scope: {
            spellManaValue: manaValue,
            spellColorCount: candidate.colors.length,
            eventPlayerId: spell.controllerId,
            ...(spell.triggerScope?.manaSpent !== undefined
              ? { manaSpent: spell.triggerScope.manaSpent }
              : {}),
          },
        });
        debug(ctx, 'stack', `graveyard cast trigger queued: ${card.name} — ${spell.description}`);
      }
    }
  }

  // Emblem cast triggers (CR 114.4): "You get an emblem with 'Whenever you cast a spell, …'"
  // (Venser, the Sojourner). An emblem has no characteristics of its own to filter on.
  for (const player of ctx.state.players) {
    for (const emblem of player.emblems) {
      for (const ability of emblem.abilities) {
        const spec = ability.trigger;
        if (spec === undefined || spec.when !== 'castsSpell') continue;
        const isController = spell.controllerId === emblem.controllerId;
        if (spec.caster === 'you' && !isController) continue;
        if (spec.caster === 'opponent' && isController) continue;
        if (!castFromMatches(spec, spell)) continue;
        const from: SelectorSource = {
          cardId: emblem.id,
          controllerId: emblem.controllerId,
          eventPlayerId: spell.controllerId,
        };
        if (spec.filter !== undefined && !selectMatches(candidate, spec.filter, from)) continue;
        if (!ordinalMatches(spec, from)) continue;
        // No emblem watches a spell's targets; fail closed rather than fire.
        if (spec.targetFilter !== undefined) continue;
        if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, from)) continue;
        ctx.state.pendingTriggers.push({
          controllerId: emblem.controllerId,
          sourceCardId: emblem.id,
          sourceOracleId: '' as never,
          sourceName: emblem.name,
          ability,
          scope: {
            spellManaValue: manaValue,
            spellColorCount: candidate.colors.length,
            eventPlayerId: spell.controllerId,
            ...(spell.triggerScope?.manaSpent !== undefined
              ? { manaSpent: spell.triggerScope.manaSpent }
              : {}),
          },
        });
        debug(ctx, 'stack', `emblem cast trigger queued: ${emblem.name} — ${spell.description}`);
      }
    }
  }
}

/**
 * A cast spell as copy effects need it: every decision made for it, plus the definition and
 * ability, so a copy can still be made from last known information after it has left the stack
 * (CR 707.10).
 */
function castSpellSnapshot(
  ctx: GameContext,
  spell: EngineStackObject,
  def: CardDefinition = spellDefinitionOf(ctx, spell),
): Extract<Effect, { op: 'replicateCopies' }>['spell'] {
  return {
    stackObjectId: spell.id,
    oracleId: spell.sourceOracleId,
    name: spell.description,
    targets: [...spell.targets],
    definition: def,
    ...(spell.ability === null ? {} : { ability: spell.ability }),
    ...(spell.announcedX === undefined ? {} : { announcedX: spell.announcedX }),
    ...(spell.countTargets === undefined
      ? {}
      : {
          countTargets: Object.fromEntries(
            Object.entries(spell.countTargets).map(([slot, ids]) => [slot, [...ids]]),
          ),
        }),
    ...(spell.divisionAmounts === undefined
      ? {}
      : { divisionAmounts: { ...spell.divisionAmounts } }),
    ...(spell.optionalCostCounts === undefined
      ? {}
      : { optionalCostCounts: { ...spell.optionalCostCounts } }),
    ...(spell.wasKicked === undefined ? {} : { wasKicked: spell.wasKicked }),
    ...(spell.kicked === undefined ? {} : { kicked: spell.kicked }),
    targetNames: Object.fromEntries(ctx.state.battlefield.map((perm) => [perm.id, perm.name])),
    oracleText: spell.card?.oracleText ?? '',
    manaCost: spell.card?.manaCost ?? null,
  };
}

/** An ability on the stack, recorded so it can still be copied after it leaves (CR 707.10). */
export function stackAbilitySnapshot(entry: EngineStackObject): StackAbilitySnapshot {
  if (entry.kind === 'spell' || entry.ability === null)
    throw new Error('engine bug: only an ability on the stack has an ability snapshot');
  return {
    stackObjectId: entry.id,
    kind: entry.kind,
    description: entry.description,
    ability: entry.ability,
    targets: [...entry.targets],
    ...(entry.countTargets === undefined
      ? {}
      : {
          countTargets: Object.fromEntries(
            Object.entries(entry.countTargets).map(([slot, ids]) => [slot, [...ids]]),
          ),
        }),
    ...(entry.divisionAmounts === undefined
      ? {}
      : { divisionAmounts: { ...entry.divisionAmounts } }),
    ...(entry.announcedX === undefined ? {} : { announcedX: entry.announcedX }),
    sourceId: entry.sourceId,
    sourceOracleId: entry.sourceOracleId,
    sourceCardId: entry.sourceCardId,
    ...(entry.sourceColors === undefined ? {} : { sourceColors: [...entry.sourceColors] }),
    ...(entry.triggerScope === undefined ? {} : { triggerScope: { ...entry.triggerScope } }),
    ...(entry.triggerObjectCardId === undefined
      ? {}
      : { triggerObjectCardId: entry.triggerObjectCardId }),
  };
}

/** Bind a cast trigger's `copyCastSpell` effects to the spell that was cast. */
function bindCastSpell(ctx: GameContext, ability: Ability, spell: EngineStackObject): Ability {
  // "They may pay {2}. If they don't, you may copy that spell" (Wandering Archaic) nests the copy.
  const copies = (effect: Effect): boolean =>
    effect.op === 'copyCastSpell' || (effect.op === 'unlessPays' && effect.then.some(copies));
  if (!ability.effects.some(copies)) return ability;
  const snapshot = castSpellSnapshot(ctx, spell);
  const bind = (effect: Effect): Effect =>
    effect.op === 'copyCastSpell'
      ? {
          op: 'replicateCopies' as const,
          count: 1,
          spell: snapshot,
          ...(effect.optional === true ? { optional: true as const } : {}),
          ...(effect.oncePerTurn === true ? { oncePerTurn: true as const } : {}),
        }
      : effect.op === 'unlessPays'
        ? { ...effect, then: effect.then.map(bind) }
        : effect;
  return { ...ability, effects: ability.effects.map(bind) };
}

/**
 * Keyword abilities that trigger when their spell is cast. Cascade is attached to the spell
 * rather than a battlefield permanent, so it is queued beside ordinary cast triggers after the
 * spell has entered the stack.
 */
export function queueKeywordCastTriggers(ctx: GameContext, spell: EngineStackObject): void {
  const def = spellDefinitionOf(ctx, spell);
  // Replicate (CR 702.56a): "When you cast this spell, if a replicate cost was paid for it, copy
  // it for each time its replicate cost was paid."
  const replicated = spell.optionalCostCounts?.replicate ?? 0;
  if (def.optionalAdditionalCost?.mechanic === 'replicate' && replicated > 0) {
    ctx.state.pendingTriggers.push({
      controllerId: spell.controllerId,
      sourceCardId: spell.sourceCardId,
      sourceOracleId: spell.sourceOracleId,
      sourceName: spell.description,
      ability: {
        kind: 'triggered',
        targets: [],
        effects: [
          {
            op: 'replicateCopies',
            count: replicated,
            spell: castSpellSnapshot(ctx, spell, def),
          },
        ],
        description: `${spell.description}: Replicate ${replicated}`,
      },
    });
  }
  const cascadeCount = def.keywords.filter((keyword) => keyword === 'cascade').length;
  if (cascadeCount === 0) return;

  const manaValue = spellManaValue(def, spell.announcedX);
  for (let i = 0; i < cascadeCount; i++) {
    ctx.state.pendingTriggers.push({
      controllerId: spell.controllerId,
      sourceCardId: spell.sourceCardId,
      sourceOracleId: spell.sourceOracleId,
      sourceName: spell.description,
      ability: {
        kind: 'triggered',
        targets: [],
        effects: [{ op: 'cascade' }],
        description: spell.description + ': Cascade',
      },
      scope: { spellManaValue: manaValue },
    });
    debug(ctx, 'stack', spell.description + ' — Cascade keyword trigger queued');
  }
}
/**
 * Mana value of a card (CR 202.3). `{X}` counts as the value announced for it (CR 202.3b) when
 * it is on the stack, or 0 off the stack — which is why this takes the announced X rather than
 * reading the printed cost alone: Lozhan off an X spell would otherwise always deal 0, and a
 * card sitting in a hand (`handToBattlefield`'s mana-value bound) is correctly valued at X=0.
 */
export function spellManaValue(def: CardDefinition, announcedX: number | undefined): number {
  const cost = def.manaCost;
  if (cost === null) return 0;
  const colored = Object.values(cost.colored).reduce((sum, n) => sum + n, 0);
  return (
    cost.generic +
    colored +
    cost.colorless +
    (cost.hybrid?.length ?? 0) +
    (cost.phyrexian?.length ?? 0) +
    (cost.x ?? 0) * (announcedX ?? 0)
  );
}

/** Resolve a simultaneous graveyard move using pre-event characteristics and watchers. */
export function* movePermanentsToGraveyard(
  ctx: GameContext,
  permanents: EnginePermanent[],
  reason?: 'sacrifice',
): GameGen<void> {
  yield* movePermanentsTogether(
    ctx,
    reason === 'sacrifice'
      ? permanents.filter((permanent) => canBeSacrificed(ctx, permanent))
      : permanents,
    { zone: 'graveyard' },
    reason,
  );
}

/**
 * Permanents leaving the battlefield in one event, for any destination ("exile all creatures",
 * "return all nonland permanents to their owners' hands"). Every leave and dies trigger is
 * checked against the game as it was before the event (CR 603.10a), so a watcher leaving in the
 * same event still sees the others leave, and each one is read with its last-known information.
 */
export function* movePermanentsTogether(
  ctx: GameContext,
  permanents: EnginePermanent[],
  destination:
    | Pick<MoveDestination, 'zone' | 'libraryPosition'>
    | ((permanent: EnginePermanent) => Pick<MoveDestination, 'zone' | 'libraryPosition'>),
  reason?: 'sacrifice',
): GameGen<(EngineCardObject | EnginePermanent | null)[]> {
  if (permanents.length === 0) return [];
  const destinationOf = (permanent: EnginePermanent) =>
    typeof destination === 'function' ? destination(permanent) : destination;
  // Plan the entire event before a departure can change controllers or other board facts.
  const plannedDestinations = new Map(
    permanents.map((permanent) => [permanent.id, destinationOf(permanent)]),
  );
  const departureFacts = new Map(
    permanents.map((perm) => [perm.id, captureObjectFacts(ctx, perm)]),
  );
  const destinations = new Map(
    permanents.map((perm) => [
      perm.id,
      graveyardDestination(
        ctx,
        perm,
        leavesBattlefieldTo(perm, plannedDestinations.get(perm.id)!.zone),
      ),
    ]),
  );
  // Only what really reaches the graveyard dies.
  const dying = permanents.filter((perm) => destinations.get(perm.id) === 'graveyard');
  for (const perm of dying) recordCreatureDeath(ctx, perm);
  const pendingStart = ctx.state.pendingTriggers.length;
  if (reason === 'sacrifice')
    queueTriggersForEvent(
      ctx,
      'sacrificed',
      permanents.map((permanent) => ({ permanent })),
    );
  queueTriggersForEvent(
    ctx,
    'leavesBattlefield',
    permanents.map((permanent) => ({
      permanent,
      toZone: destinations.get(permanent.id)!,
    })),
  );
  queueTriggersForEvent(
    ctx,
    'dies',
    dying.map((permanent) => ({ permanent })),
  );
  // Watchers and last-known facts are captured before any member leaves. Destination
  // incarnations become available only during movement; bind them to these exact firings.
  const departureTriggers = ctx.state.pendingTriggers.slice(pendingStart);
  const moved: (EngineCardObject | EnginePermanent | null)[] = [];
  for (const perm of permanents) {
    const next = yield* moveObject(ctx, perm, {
      ...plannedDestinations.get(perm.id)!,
      zone: destinations.get(perm.id)!,
      deferLeaveProcessing: true,
      deferCardZoneTriggers: true,
      lastKnownFacts: departureFacts.get(perm.id)!,
    });
    moved.push(next);
    if (perm.firstDestinationObjectId !== undefined) {
      for (const trigger of departureTriggers) {
        if (trigger.scope?.eventObjectId === perm.id)
          trigger.scope.eventObjectDestinationId = perm.firstDestinationObjectId;
      }
    }
  }
  // Linked returns happen after every member has left; ETB effects cannot change
  queueCardZoneTriggers(
    ctx,
    'putIntoGraveyardFromAnywhere',
    moved.filter((card): card is EngineCardObject => card !== null && card.zone === 'graveyard'),
    [],
    true,
    new Map(permanents.map((permanent) => [permanent.cardId, departureFacts.get(permanent.id)!])),
  );
  // which other permanents were dying in the same event.
  for (const perm of permanents) yield* returnExiledUntilLeaves(ctx, perm.cardId);
  return moved;
}

function queueLeaveBattlefieldTriggers(ctx: GameContext, obj: EngineObject, to: Zone): void {
  const perm = obj as EnginePermanent;
  if (perm.controllerId === undefined) return;
  // "leaves the battlefield" — for any destination, read with last-known information.
  queueTriggersForEvent(ctx, 'leavesBattlefield', [{ permanent: perm, toZone: to }]);
  // "dies" means battlefield → graveyard (CR 700.4). The pre-move battlefield object
  // carries the controller.
  if (to !== 'graveyard') return;
  recordCreatureDeath(ctx, perm);
  queueTriggersForObject(ctx, 'dies', perm);
}

/** Count a dying creature, and whether it died modified (CR 700.9), before it leaves. */
function recordCreatureDeath(ctx: GameContext, perm: EnginePermanent): void {
  if (!computeCharacteristics(ctx, perm).types.includes('Creature')) return;
  ctx.state.creaturesDiedThisTurn += 1;
  if (isModified(ctx, perm))
    (ctx.state.modifiedCreatureDiedThisTurn ??= {})[perm.controllerId] = true;
}

/**
 * Queue the `attackDeclared` triggers (CR 508.2a) for one declaration: `declared` is every creature
 * declared as an attacker, of any player. Per watcher ability and attacking player the attackers
 * form a group — all of that player's attackers, or only those attacking the player `attacking`
 * names, one group per attacked player with `perDefender`. The group's size is a trigger
 * condition checked now (`minAttackers`), and the group is remembered by object for resolution.
 */
export function queueAttackDeclarationTriggers(
  ctx: GameContext,
  declared: readonly EnginePermanent[],
): void {
  if (declared.length === 0) return;
  assertTriggerEventFamily('attackDeclared', 'attackDeclaration');
  const attackingPlayers = [...new Set(declared.map((a) => a.controllerId))];
  for (const source of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== 'attackDeclared') continue;
      const watcherId = source.controllerId;
      const enchantedPlayerId =
        source.attachedTo !== null && ctx.state.players.some((p) => p.id === source.attachedTo)
          ? source.attachedTo
          : undefined;
      const opponentIds = new Set(opponentsOf(ctx, watcherId).map((p) => p.id));
      const targetPlayerOf = (
        who: 'you' | 'opponent' | 'enchantedPlayer',
        id: PlayerId,
      ): boolean =>
        who === 'you'
          ? id === watcherId
          : who === 'opponent'
            ? opponentIds.has(id)
            : id === enchantedPlayerId;
      for (const attackingPlayerId of attackingPlayers) {
        const attackerOk =
          spec.attacker === 'you'
            ? attackingPlayerId === watcherId
            : spec.attacker === 'opponent'
              ? opponentIds.has(attackingPlayerId)
              : spec.attacker === 'otherPlayer'
                ? attackingPlayerId !== watcherId
                : spec.attacker === 'enchantedPlayer'
                  ? attackingPlayerId === enchantedPlayerId
                  : true;
        if (!attackerOk) continue;
        const mine = declared.filter((a) => a.controllerId === attackingPlayerId);
        // Attacking a planeswalker is not attacking its controller (CR 506.2); one removed from
        // combat attacks nothing.
        const filter = spec.attacking;
        const members =
          filter === undefined
            ? mine
            : mine.filter(
                (a) =>
                  a.attacking !== null &&
                  targetPlayerOf(filter.who, a.attacking) &&
                  (a.attackingPlaneswalker === null
                    ? filter.planeswalkersOnly !== true
                    : filter.planeswalkers && attackedPlaneswalker(ctx, a) !== null),
              );
        const groups: { members: EnginePermanent[]; attackedPlayerId?: PlayerId }[] =
          spec.perDefender === true
            ? [...new Set(members.map((a) => a.attacking as PlayerId))].map((defenderId) => ({
                members: members.filter((a) => a.attacking === defenderId),
                attackedPlayerId: defenderId,
              }))
            : [{ members }];
        for (const group of groups) {
          if (group.members.length < (spec.minAttackers ?? 1)) continue;
          const groupScope = {
            eventPlayerId: attackingPlayerId,
            attackGroupIds: group.members.map((a) => a.id),
            ...(group.attackedPlayerId === undefined
              ? {}
              : { attackedPlayerId: group.attackedPlayerId }),
            attackedWatcher: mine.some(
              (a) => a.attacking === watcherId && a.attackingPlaneswalker === null,
            ),
            triggerCount: group.members.length,
          } satisfies TriggerScope;
          const from: SelectorSource = {
            cardId: source.cardId,
            objectId: source.id,
            controllerId: watcherId,
            attachedToCardId: null,
            ...groupScope,
          };
          if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, from))
            continue;
          const copies = 1 + additionalTypedTriggerCopies(ctx, source);
          for (let copy = 0; copy < copies; copy++) {
            ctx.state.pendingTriggers.push({
              controllerId: watcherId,
              sourceCardId: source.cardId,
              sourceObjectId: source.id,
              sourceOracleId: source.oracleId,
              sourceName: source.name,
              ability,
              scope: groupScope,
            });
            debug(ctx, 'stack', `attackDeclared trigger queued: ${source.name}`);
          }
        }
      }
    }
  }
}

/**
 * "Until SOURCE leaves the battlefield" (Conclave Tribunal, CR 610.2b): when the source itself
 * leaves — regardless of where it goes — every card it exiled this way comes back, under the control
 * of its owner (CR 610.3c). Each return is a normal zone change (a NEW object, "enters"
 * triggers included), just like any other return from exile.
 */
export function* returnExiledUntilLeaves(ctx: GameContext, sourceCardId: CardId): GameGen<void> {
  const entries = ctx.state.exiledUntilLeaves[sourceCardId];
  if (entries === undefined) return;
  delete ctx.state.exiledUntilLeaves[sourceCardId];
  for (const entry of entries) {
    const exiled = ctx.state.exile.find((c) =>
      entry.objectId === undefined ? c.cardId === entry.cardId : c.id === entry.objectId,
    );
    if (exiled === undefined || playerById(ctx, exiled.ownerId).hasLost) continue;
    yield* moveObject(ctx, exiled, { zone: 'battlefield', controllerId: exiled.ownerId });
  }
}

/**
 * "Whenever you activate an ability that isn't a mana ability" (Verrak, Rowan Kenrith's emblem):
 * queued once `ability` is on the stack with its costs paid (CR 602.2i). A copy of an ability is
 * not activated (CR 707.10), so copies never get here. `lifePaid` is the life paid as part of the
 * activation's total cost, Phyrexian mana included.
 */
export function queueActivationTriggers(
  ctx: GameContext,
  ability: EngineStackObject,
  lifePaid: number,
): void {
  assertTriggerEventFamily('activatesAbility', 'player');
  const playerId = ability.controllerId;
  const watchers: {
    controllerId: PlayerId;
    sourceCardId: string;
    sourceObjectId?: ObjectId;
    sourceOracleId: OracleId;
    sourceName: string;
    abilities: Ability[];
    permanent?: EnginePermanent;
  }[] = [
    ...ctx.state.battlefield.map((perm) => ({
      controllerId: perm.controllerId,
      sourceCardId: perm.cardId,
      sourceObjectId: perm.id,
      sourceOracleId: perm.oracleId,
      sourceName: perm.name,
      abilities: triggersOf(ctx, perm),
      permanent: perm,
    })),
    // Emblem triggers (CR 114.4): an emblem has no characteristics of its own.
    ...ctx.state.players.flatMap((player) =>
      player.emblems.map((emblem) => ({
        controllerId: emblem.controllerId,
        sourceCardId: emblem.id,
        sourceOracleId: '' as OracleId,
        sourceName: emblem.name,
        abilities: emblem.abilities,
      })),
    ),
  ];
  for (const watcher of watchers) {
    for (const watched of watcher.abilities) {
      const spec = watched.trigger;
      if (spec === undefined || spec.when !== 'activatesAbility') continue;
      if (spec.player === 'you' && watcher.controllerId !== playerId) continue;
      if (spec.lifePaid === true && lifePaid <= 0) continue;
      const from: SelectorSource = {
        cardId: watcher.sourceCardId,
        controllerId: watcher.controllerId,
        eventPlayerId: playerId,
      };
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, from)) continue;
      const copies =
        1 +
        (watcher.permanent === undefined
          ? 0
          : additionalTypedTriggerCopies(ctx, watcher.permanent));
      for (let copy = 0; copy < copies; copy++) {
        ctx.state.pendingTriggers.push({
          controllerId: watcher.controllerId,
          sourceCardId: watcher.sourceCardId,
          ...(watcher.sourceObjectId === undefined
            ? {}
            : { sourceObjectId: watcher.sourceObjectId }),
          sourceOracleId: watcher.sourceOracleId,
          sourceName: watcher.sourceName,
          ability: bindActivatedAbility(watched, ability, lifePaid),
          scope: { eventPlayerId: playerId, lifePaid },
        });
        debug(
          ctx,
          'stack',
          `activation trigger queued: ${watcher.sourceName} — ${ability.description}`,
        );
      }
    }
  }
}

/** Bind an activation trigger's `copyActivatedAbility` effects to the ability that was activated. */
function bindActivatedAbility(
  watched: Ability,
  activated: EngineStackObject,
  lifePaid: number,
): Ability {
  if (!watched.effects.some((effect) => effect.op === 'copyActivatedAbility')) return watched;
  const snapshot = stackAbilitySnapshot(activated);
  return {
    ...watched,
    effects: watched.effects.map((effect) =>
      effect.op === 'copyActivatedAbility'
        ? {
            op: 'copyStackAbility' as const,
            stackAbility: snapshot,
            ...(effect.mayPayLifeAgain === true ? { lifeCost: lifePaid } : {}),
          }
        : effect,
    ),
  };
}

export function queuePlayerTriggersForEvent(
  ctx: GameContext,
  when:
    | 'gainsLife'
    | 'losesLife'
    | 'drawsCard'
    | 'foretells'
    | 'damagePreventedToPlayer'
    | 'playerDealtDamage',
  playerId: PlayerId,
  amount?: number,
  /** `playerDealtDamage`: who controls the source that dealt the damage; it is the event player. */
  sourceControllerId?: PlayerId,
  /** `losesLife`: this is the player's first life loss this turn. */
  firstThisTurn?: boolean,
): void {
  assertTriggerEventFamily(when, 'player');
  for (const perm of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, perm)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;
      if (spec.when === 'losesLife' && spec.firstTimeEachTurn === true && firstThisTurn !== true)
        continue;
      if (
        spec.when === 'drawsCard' &&
        spec.ordinalThisTurn !== undefined &&
        ctx.state.players.find((candidate) => candidate.id === playerId)?.cardsDrawnThisTurn !==
          spec.ordinalThisTurn
      )
        continue;
      if (spec.player === 'you' && perm.controllerId !== playerId) continue;
      if (
        spec.player === 'opponent' &&
        !opponentsOf(ctx, perm.controllerId).some((opponent) => opponent.id === playerId)
      )
        continue;
      if (
        spec.when === 'playerDealtDamage' &&
        spec.sourceController === 'opponent' &&
        !opponentsOf(ctx, perm.controllerId).some((opponent) => opponent.id === sourceControllerId)
      )
        continue;
      const eventPlayerId =
        spec.when === 'playerDealtDamage' && sourceControllerId !== undefined
          ? sourceControllerId
          : playerId;
      const source: SelectorSource = {
        cardId: perm.cardId,
        controllerId: perm.controllerId,
        eventPlayerId,
      };
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, source)) continue;
      const copies = 1 + additionalTypedTriggerCopies(ctx, perm);
      for (let copy = 0; copy < copies; copy++) {
        ctx.state.pendingTriggers.push({
          controllerId: perm.controllerId,
          sourceCardId: perm.cardId,
          sourceObjectId: perm.id,
          sourceOracleId: perm.oracleId,
          sourceName: perm.name,
          ability,
          scope: {
            eventPlayerId,
            ...(amount !== undefined ? { damageDealt: amount } : {}),
          },
        });
        debug(ctx, 'stack', `${when} trigger queued: ${perm.name}`);
      }
    }
  }
}
