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
import type { Ability, KeywordAbility, ObjectTriggerWhen, TokenSpec } from '../cards/ability';
import { actsOnItsTriggerObject } from '../cards/source-identity';
import { evaluateCondition, resolveCondition } from '../cards/condition';
import type { CardDefinition } from '../cards/definition';
import type { Selector, SelectorCandidate, SelectorSource } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import type { TriggerScope } from '../cards/value';
import { evaluateValue } from '../cards/value';
import type { GameGen } from '../decisions';
import { chooseCard } from '../effects/choose';
import { evaluateValueIn } from '../effects/values';
import { computeCharacteristics, matchesSelector, selectPermanents } from '../effects/continuous';
import { CREATURE_TYPES } from '../cards/creature-types';
import { debug, emit } from '../log/log';
import {
  cardZoneCandidate,
  counterAmountAfterReplacements,
  counterAmountAfterReplacementsForCandidate,
  colorsOf,
  damageKeywordsOf,
  getDefByOracleId,
  opponentsOf,
  tokenCreationMultiplierFor,
  triggersOf,
} from './queries';
import type {
  CardId,
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
  /** Internal card-zone batch: queue one aggregate departure event after every move completes. */
  deferCardZoneTriggers?: boolean;
  /** Internal battlefield batch: enters triggers are queued once every object has entered. */
  deferEntersTriggers?: boolean;
  /** Battlefield only: the controller it enters under (defaults to its owner). */
  controllerId?: PlayerId;
  /** Aura host chosen when casting, attached before entry triggers are collected. */
  attachedTo?: ObjectId;
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
  /** Library only: where to put it. Defaults to 'top'. Index 0 is the top. */
  libraryPosition?: 'top' | 'bottom';
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
  const frontDef = ctx.defs.get(obj.oracleId);
  const landFace = mdfcLandFaceFor(ctx, obj);
  const transformFace = frontDef?.backFace;
  const castFromStack = obj.zone === 'stack' && zone === 'battlefield';
  return {
    id: newObjectId(ctx),
    cardId: obj.cardId,
    oracleId: original?.oracleId ?? obj.oracleId,
    ownerId: obj.ownerId,
    name:
      original?.name ??
      (zone === 'battlefield' && landFace !== undefined
        ? landFace.name
        : (frontDef?.name ?? obj.name)),
    typeLine:
      original?.typeLine ??
      (zone === 'battlefield' && landFace !== undefined
        ? landFace.typeLine
        : (frontDef?.typeLine ?? obj.typeLine)),
    oracleText:
      original?.oracleText ??
      (zone === 'battlefield' && landFace !== undefined
        ? landFace.oracleText
        : (landFace?.frontOracleText ?? transformFace?.frontOracleText ?? obj.oracleText)),
    manaCost:
      original?.manaCost ??
      (zone === 'battlefield' && landFace !== undefined
        ? landFace.manaCost
        : (landFace?.frontManaCost ?? transformFace?.frontManaCostText ?? obj.manaCost)),
    isToken: obj.isToken,
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
  };
}
/** Apply a control-changing effect without replacing the permanent's initial controller. */
export function changeController(
  ctx: GameContext,
  perm: EnginePermanent,
  controllerId: PlayerId,
): void {
  (perm.controlChanges ??= []).push(controllerId);
  perm.controllerId = controllerId;
  perm.timestamp = ctx.state.nextTimestamp++;
  perm.summoningSick = true;
  perm.attacking = null;
  perm.blocking = null;
  perm.statuses = perm.statuses.filter((status) => status !== 'attacking' && status !== 'blocking');
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
  faceDown = false,
): EnginePermanent {
  const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
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
    counters[counter] = (counters[counter] ?? 0) + amount;
  }
  // Static entry replacements are generated by permanents already on the battlefield. Evaluate
  // the incoming card by its printed characteristics, as CR 614.1c does before it exists.
  const incoming = cardZoneCandidate(ctx, obj as EngineCardObject, controllerId);
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
    if (source.faceDown) continue;
    const sourceDef = getDefByOracleId(ctx, source.oracleId, source.name);
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
      counters[replacement.counter] = (counters[replacement.counter] ?? 0) + amount;
    }
  }
  for (const [counter, amount] of Object.entries(counters)) {
    counters[counter] = counterAmountAfterReplacementsForCandidate(ctx, incoming, counter, amount);
  }
  return {
    ...reincarnate(ctx, obj, 'battlefield'),
    zone: 'battlefield',
    controllerId,
    defaultControllerId: controllerId,
    transformed: false,
    tapped:
      entersTappedOverride ?? (faceDown ? false : (landFace?.entersTapped ?? def.entersTapped)),
    faceDown,
    power: landFace === undefined ? def.power : null,
    toughness: landFace === undefined ? def.toughness : null,
    damageMarked: 0,
    counters,
    statuses: [],
    summoningSick: true,
    attachedTo: null,
    attacking: null,
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
    ...((obj as EngineCardObject).optionalCostCounts?.kicker
      ? { wasKicked: true, kicked: true }
      : {}),
  };
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
  perm.attacking = null;
  perm.blocking = null;
  perm.blockedByOrdered = [];
  perm.statuses = perm.statuses.filter((st) => st !== 'attacking' && st !== 'blocking');
  // Removed from combat (CR 701.19c). An attacker it was blocking REMAINS blocked (CR 509.1h), so
  // its id stays in that attacker's `blockedByOrdered`; it just no longer counts as a live blocker.
  for (const other of ctx.state.battlefield) {
    if (other.blocking === perm.id) other.blocking = null;
  }
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
  for (const perm of ctx.state.battlefield) perm.regenerationShields = 0;
}

/** Transform a permanent in place without changing its object identity or attached state. */
export function transformPermanent(ctx: GameContext, perm: EnginePermanent): boolean {
  const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
  if (def.backFace === undefined) return false;

  perm.transformed = !perm.transformed;
  const face = perm.transformed ? def.backFace : def;
  perm.name = face.name;
  perm.typeLine = face.typeLine;
  perm.oracleText = perm.transformed ? def.backFace.oracleText : def.backFace.frontOracleText;
  perm.manaCost = (
    perm.transformed ? def.backFace.manaCostText : def.backFace.frontManaCostText
  ) as EnginePermanent['manaCost'];
  if (face.cantBlock === true) perm.cantBlock = true;
  else delete perm.cantBlock;
  if (face.cantBeBlocked === true) perm.cantBeBlocked = true;
  else delete perm.cantBeBlocked;

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
  perm.copyOriginal ??= {
    oracleId: perm.oracleId,
    name: perm.name,
    typeLine: perm.typeLine,
    oracleText: perm.oracleText,
    manaCost: perm.manaCost,
    power: perm.power,
    toughness: perm.toughness,
  };
  perm.oracleId = target.oracleId;
  perm.name = opts.nameOverride ?? target.name;
  perm.typeLine = target.typeLine;
  perm.oracleText = target.oracleText;
  perm.manaCost = target.manaCost;
  perm.power = target.power;
  perm.toughness = target.toughness;
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

export function* moveObject(
  ctx: GameContext,
  obj: EngineObject,
  dest: MoveDestination,
): GameGen<EngineCardObject | EnginePermanent | null> {
  const from = obj.zone;
  let target: MoveDestination = dest;

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
    if (outcome.index === 0) target = { zone: 'command' };
  }

  // Last known information (CR 113.7a), read while it is still on the battlefield.
  if (from === 'battlefield') rememberLeavingSourceTraits(ctx, obj as EnginePermanent);

  if (target.zone === 'battlefield' && !target.faceDown) {
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
    if (def.subtypes.includes('Aura')) {
      const enchant = def.spellAbility?.targets[0];
      const controllerId = target.controllerId ?? obj.ownerId;
      const hosts =
        enchant === undefined
          ? []
          : computeTargetOptions(
              ctx,
              enchant,
              controllerId,
              def.colors,
              undefined,
              undefined,
              obj.cardId,
              false,
            );
      if (target.attachedTo !== undefined) {
        if (!hosts.includes(target.attachedTo)) return null;
      } else {
        // CR 303.4f: putting an Aura onto the battlefield chooses an enchantable
        // permanent without targeting it. With no host it stays in its current zone.
        if (hosts.length === 0) return null;
        const outcome = yield {
          decisionType: 'general',
          player: controllerId,
          prompt: `${obj.name}: choose a permanent to enchant.`,
          options: hosts.map((id) => ({
            type: 'attachAura',
            description: `Enchant ${ctx.state.battlefield.find((p) => p.id === id)!.name}`,
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
    if (!target.deferLeaveProcessing) queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
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
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
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
    const perm = makePermanent(ctx, incoming, controllerId, entersTappedOverride, target.faceDown);
    perm.attachedTo = target.attachedTo ?? null;
    ctx.state.battlefield.push(perm);
    next = perm;

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
      const candidates = selectPermanents(ctx, config.selector, {
        cardId: perm.cardId,
        controllerId,
      }).filter((p) => p.cardId !== perm.cardId);
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
          perm.counters[counter] = (perm.counters[counter] ?? 0) + count;
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
    name: target.faceDown ? 'Face-down permanent' : obj.name,
    from,
    to: target.zone,
    owner: obj.ownerId,
    newObjectId: next.id,
  });
  debug(ctx, 'zoneChange', `${obj.name}: ${from} → ${target.zone}`, { cardId: obj.cardId });

  // Syr Konrad's card-zone events are distinct from dies: the graveyard-entry event here
  // intentionally covers only non-battlefield origins so one battlefield death cannot fire twice.
  if (target.zone === 'graveyard' && from !== 'battlefield' && from !== 'graveyard') {
    queueCardZoneTriggers(ctx, 'putIntoGraveyardFromAnywhere', [next as EngineCardObject]);
  }
  if (
    from === 'graveyard' &&
    target.zone !== 'graveyard' &&
    target.deferCardZoneTriggers !== true
  ) {
    queueCardZoneTriggers(ctx, 'leavesGraveyard', [obj as EngineCardObject]);
  }

  if (target.reason === 'sacrifice' && from === 'battlefield') {
    queueTriggersForObject(ctx, 'sacrificed', obj as EnginePermanent);
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
    if (!target.deferLeaveProcessing) queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
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
  for (const object of objects) {
    const entering = destination.zone === 'battlefield' && object.zone !== 'battlefield';
    const next = yield* moveObject(ctx, object, {
      ...destination,
      ...(leavingGraveyard.includes(object as EngineCardObject)
        ? { deferCardZoneTriggers: true }
        : {}),
      ...(entering ? { deferEntersTriggers: true } : {}),
    });
    moved.push(next);
    if (entering && next !== null && next.zone === 'battlefield')
      entered.push(next as EnginePermanent);
  }
  for (const permanent of entered) {
    if (ctx.state.battlefield.includes(permanent)) queueTriggersForObject(ctx, 'enters', permanent);
  }
  if (leavingGraveyard.length > 0) {
    queueCardZoneTriggers(ctx, 'leavesGraveyard', leavingGraveyard);
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
function registerTokenDef(ctx: GameContext, spec: TokenSpec): OracleId {
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
  const { grantHasteUntilEot: _haste, ...copiable } = spec;
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
    ctx.defs.set(oracleId, {
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
      entersTapped: false,
      spellAbility: null,
      triggers: spec.triggers ?? [],
      staticEffects: [],
      ruleStatics: [],
      modeled: true,
      unmodeledReasons: [],
    });
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
  const stub: EngineObject = {
    id: newObjectId(ctx),
    // Tokens need a stable `cardId` like any other object — commander damage, until-EOT effect
    // sets and the layer cache are all keyed by it — but no two tokens ever share one.
    cardId: `tok-${ctx.state.nextObjectNum++}`,
    oracleId,
    ownerId: controllerId,
    name: spec.name,
    typeLine: spec.typeLine,
    oracleText: '',
    manaCost: spec.manaCostText ?? null,
    isToken: true,
    isCommander: false,
    zone: 'battlefield',
  };
  const perm = makePermanent(ctx, stub, controllerId, entersTapped ? true : undefined);
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
): void {
  if (spec.types.includes('Creature')) {
    const replacements = ctx.state.battlefield
      .filter((candidate) => candidate.controllerId === controllerId)
      .flatMap((candidate) => {
        const def = ctx.defs.get(candidate.oracleId);
        return def?.tokenCreationReplacement === undefined ? [] : [def.tokenCreationReplacement];
      });
    for (const replacement of replacements) createToken(ctx, replacement, controllerId, false);
  }
  if (
    spec.types.includes('Artifact') &&
    ctx.state.battlefield.some((candidate) => {
      if (candidate.controllerId !== controllerId) return false;
      const def = ctx.defs.get(candidate.oracleId);
      return def?.ruleStatics.some((rs) => rs.kind === 'artifactTokenCreatesThopter') ?? false;
    })
  ) {
    createToken(
      ctx,
      {
        name: 'Thopter',
        typeLine: 'Artifact Creature — Thopter',
        types: ['Artifact', 'Creature'],
        subtypes: ['Thopter'],
        colors: [],
        power: 1,
        toughness: 1,
        keywords: ['flying'],
      },
      controllerId,
      false,
    );
  }
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
  const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
  return {
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
    // A copy copies the mana cost (CR 707.2), so the token's mana value is the original's —
    // except that a copy of a back face has mana value 0 (CR 202.3b, 712.8e), never the front's.
    manaCost: perm.transformed ? null : def.manaCost,
    manaCostText: perm.transformed ? null : perm.manaCost,
  };
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
}

/**
 * Number of additional times `source`'s triggered ability fires because of Harmonic Prodigy
 * effects. Computed once for the original event, so copied triggers never recursively copy.
 */
export function additionalTypedTriggerCopies(ctx: GameContext, source: EnginePermanent): number {
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
 */
function queueCardZoneTriggers(
  ctx: GameContext,
  when: 'putIntoGraveyardFromAnywhere' | 'leavesGraveyard',
  cards: EngineCardObject[],
): void {
  const hasWatcher = ctx.state.battlefield.some((source) =>
    triggersOf(ctx, source).some((ability) => ability.trigger?.when === when),
  );
  if (!hasWatcher) return;
  for (const source of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when || !('subject' in spec)) continue;
      const from: SelectorSource = {
        cardId: source.cardId,
        controllerId: source.controllerId,
        attachedToCardId:
          source.attachedTo === null
            ? null
            : (ctx.state.battlefield.find((perm) => perm.id === source.attachedTo)?.cardId ?? null),
      };
      const matched = cards.filter((card) => {
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
            ...(spec.aggregate === true ? { scope: { triggerCount: firing.length } } : {}),
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
  if (subjects.length === 0) return;

  // A dying permanent is gone from the battlefield but is still an ability source for its own
  // "when this dies" trigger, so it has to be added back as a candidate source.
  const missing = subjects
    .map((s) => s.permanent)
    .filter((perm) => !ctx.state.battlefield.some((p) => p.cardId === perm.cardId));
  const sources = [...ctx.state.battlefield, ...missing];

  for (const source of sources) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;

      const from: SelectorSource = {
        cardId: source.cardId,
        controllerId: source.controllerId,
        attachedToCardId:
          source.attachedTo === null
            ? null
            : (ctx.state.battlefield.find((perm) => perm.id === source.attachedTo)?.cardId ?? null),
      };
      const matched = subjects.filter((s) => {
        // "an opponent controls" (Thunderbreak Regent) — the watcher's own targeting spells
        // and abilities never qualify, regardless of what the subject selector matches.
        if (when === 'becomesTargeted' && s.sourceControllerId === source.controllerId)
          return false;
        if ('entersUntapped' in spec && spec.entersUntapped === true && s.permanent.tapped) {
          return false;
        }
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
      const firings: TriggerEventSubject[][] =
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

      const enteringArtifactOrCreature =
        when === 'enters' &&
        matched.some((s) => {
          const chars = computeCharacteristics(ctx, s.permanent);
          return chars.types.includes('Artifact') || chars.types.includes('Creature');
        });
      const entryCopies = enteringArtifactOrCreature
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
      const additionalCopies = entryCopies + additionalTypedTriggerCopies(ctx, source);
      for (let copy = 0; copy <= additionalCopies; copy++) {
        for (const group of firings) {
          const first = group[0] as TriggerEventSubject;
          // Intervening-if, first check (CR 603.4), with the event object available for
          // conditions such as "if that creature had to attack".
          if (
            spec.condition !== undefined &&
            !evaluateCondition(ctx, spec.condition, {
              ...from,
              ...(spec.subject.kind === 'self'
                ? {}
                : { triggerObjectCardId: first.permanent.cardId }),
            })
          ) {
            debug(ctx, 'stack', `trigger not queued: ${source.name} � intervening-if false`);
            continue;
          }
          const amounts = group.filter((s) => s.amount !== undefined);
          const eventPlayerId =
            'defendingPlayerIsEventPlayer' in spec &&
            spec.defendingPlayerIsEventPlayer === true &&
            first.permanent.attacking !== null
              ? first.permanent.attacking
              : spec.aggregate === 'byEventPlayer'
                ? byEventPlayerKey(first)
                : first.playerId;
          const scope: TriggerScope = {
            ...(spec.aggregate !== undefined ? { triggerCount: group.length } : {}),
            ...(eventPlayerId !== undefined ? { eventPlayerId } : {}),
            ...(spec.subject.kind !== 'self' &&
            (remembersEventObject(ability) ||
              (actsOnItsTriggerObject(ability) &&
                ctx.state.battlefield.some((permanent) => permanent.id === first.permanent.id)))
              ? { eventObjectId: first.permanent.id }
              : {}),
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
            : matchesSelector(ctx, s.permanent, spec.subject.selector, from),
        );
        for (const s of matched) {
          if (
            spec.condition !== undefined &&
            !evaluateCondition(ctx, spec.condition, {
              ...from,
              triggerObjectCardId: s.permanent.cardId,
            })
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
            : matchesSelector(ctx, subject.permanent, spec.subject.selector, from),
        );
        for (const subject of matched) {
          ctx.state.pendingTriggers.push({
            controllerId: emblem.controllerId,
            sourceCardId: emblem.id,
            sourceOracleId: '' as never,
            sourceName: emblem.name,
            ability,
            triggerObjectCardId: subject.permanent.cardId,
          });
          debug(ctx, 'stack', `emblem trigger queued: ${emblem.name}`);
        }
      }
    }
  }
  for (const delayed of ctx.state.delayedTriggers) {
    if (delayed.when !== when) continue;
    const matchingSubject =
      delayed.targetId !== undefined
        ? subjects.find((s) => s.permanent.cardId === delayed.targetId)
        : subjects[0];

    if (matchingSubject === undefined) continue;

    const scope: TriggerScope = {
      ...(matchingSubject.amount !== undefined ? { damageDealt: matchingSubject.amount } : {}),
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
  }
}

/** The one-subject case, which is every event except attacks and combat damage. */
/**
 * Whether a trigger's effects remember the exact object that fired it (a `sameObject` delayed
 * trigger on 'triggerObject'). Only those capture the event object's id, so every other
 * trigger's pending entry stays as it was.
 */
function remembersEventObject(ability: Ability): boolean {
  return ability.effects.some(
    (effect) =>
      effect.op === 'registerDelayedTrigger' &&
      effect.sameObject === true &&
      effect.target === 'triggerObject',
  );
}

/**
 * A permanent is leaving: record its colors and damage keywords on every ability of its own
 * waiting on the stack or about to be put there, so its targets and the damage it deals after it
 * is gone use the colors, deathtouch, lifelink and infect it had immediately before it left
 * (CR 113.7a, Mordant Dragon). Damage keywords are only recorded when it had any.
 */
function rememberLeavingSourceTraits(ctx: GameContext, perm: EnginePermanent): void {
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
    entry.sourceColors = [...colors];
    if (keywords.length > 0) entry.sourceDamageKeywords = keywords;
    else delete entry.sourceDamageKeywords;
  }
}

export function queueTriggersForObject(
  ctx: GameContext,
  when: ObjectTriggerWhen,
  permanent: EnginePermanent,
): void {
  queueTriggersForEvent(ctx, when, [{ permanent }]);
}

/**
 * Queue "whenever you cast …" triggers (CR 603.2). The subject is a spell on the stack, not a
 * permanent, so it is matched against the *card's* characteristics via `cardCandidate` — the
 * same projection library searches use.
 *
 * Fired at announcement, after the spell is on the stack, so the trigger resolves FIRST
 * (CR 603.3b puts it above the spell that caused it).
 */
export function queueCastTriggers(ctx: GameContext, spell: EngineStackObject): void {
  const def = ctx.defs.get(spell.sourceOracleId);
  if (def === undefined) return;

  const caster = playerById(ctx, spell.controllerId);
  caster.spellsCastThisTurn += 1;
  // A spell's type is read off its printed characteristics — it is on the stack, not the
  // battlefield, so the layer engine has produced nothing for it (CR 608.2 has not run yet).
  if (!def.types.includes('Creature')) caster.noncreatureSpellsCastThisTurn += 1;

  // A spell is matched on its printed characteristics: it is not on the battlefield, so the
  // layer engine has produced nothing for it.
  const candidate: SelectorCandidate = {
    cardId: spell.sourceCardId,
    controllerId: spell.controllerId,
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
    // A spell on the stack is a card, never a token (CR 111.1) — a token is only ever a
    // permanent, so nothing that gets here can be one.
    isToken: false,
    enteredThisTurn: false,
  };
  const manaValue = spellManaValue(def, spell.announcedX);

  for (const source of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, source)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== 'castsSpell') continue;

      const isController = spell.controllerId === source.controllerId;
      if (spec.caster === 'you' && !isController) continue;
      if (spec.caster === 'opponent' && isController) continue;
      if (spec.ordinal !== undefined && caster.spellsCastThisTurn !== spec.ordinal) continue;

      const from: SelectorSource = {
        cardId: source.cardId,
        controllerId: source.controllerId,
        attachedToCardId:
          source.attachedTo === null
            ? null
            : (ctx.state.battlefield.find((perm) => perm.id === source.attachedTo)?.cardId ?? null),
      };
      // `selectMatches`, not `matchesSelector`: the spell is not a permanent, so there are no
      // layered characteristics to compute — the candidate above is already the whole answer.
      if (spec.filter !== undefined && !selectMatches(candidate, spec.filter, from)) continue;
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
          ability,
          scope: {
            spellManaValue: manaValue,
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
}

/**
 * Keyword abilities that trigger when their spell is cast. Cascade is attached to the spell
 * rather than a battlefield permanent, so it is queued beside ordinary cast triggers after the
 * spell has entered the stack.
 */
export function queueKeywordCastTriggers(ctx: GameContext, spell: EngineStackObject): void {
  const def = ctx.defs.get(spell.sourceOracleId);
  if (def === undefined) return;
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
  if (permanents.length === 0) return;
  // Only what really reaches the graveyard dies; an unearthed permanent is exiled instead.
  const dying = permanents.filter((perm) => leavesBattlefieldTo(perm, 'graveyard') === 'graveyard');
  ctx.state.creaturesDiedThisTurn += dying.filter((perm) =>
    computeCharacteristics(ctx, perm).types.includes('Creature'),
  ).length;
  if (reason === 'sacrifice')
    queueTriggersForEvent(
      ctx,
      'sacrificed',
      permanents.map((permanent) => ({ permanent })),
    );
  queueTriggersForEvent(
    ctx,
    'dies',
    dying.map((permanent) => ({ permanent })),
  );
  for (const perm of permanents) {
    yield* moveObject(ctx, perm, { zone: 'graveyard', deferLeaveProcessing: true });
  }
  // Linked returns happen after every member has left; ETB effects cannot change
  // which other permanents were dying in the same event.
  for (const perm of permanents) yield* returnExiledUntilLeaves(ctx, perm.cardId);
}

function queueLeaveBattlefieldTriggers(ctx: GameContext, obj: EngineObject, to: Zone): void {
  // "dies" means battlefield → graveyard (CR 700.4). The pre-move battlefield object
  // carries the controller.
  if (to !== 'graveyard') return;
  const perm = obj as EnginePermanent;
  if (perm.controllerId === undefined) return;
  if (computeCharacteristics(ctx, perm).types.includes('Creature')) {
    ctx.state.creaturesDiedThisTurn += 1;
  }
  queueTriggersForObject(ctx, 'dies', perm);
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
    const exiled = ctx.state.exile.find((c) => c.cardId === entry.cardId);
    if (exiled === undefined || playerById(ctx, exiled.ownerId).hasLost) continue;
    yield* moveObject(ctx, exiled, { zone: 'battlefield', controllerId: exiled.ownerId });
  }
}

export function queuePlayerTriggersForEvent(
  ctx: GameContext,
  when: 'gainsLife' | 'drawsCard',
  playerId: PlayerId,
  amount?: number,
): void {
  for (const perm of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, perm)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;
      if (spec.player === 'you' && perm.controllerId !== playerId) continue;
      if (
        spec.player === 'opponent' &&
        !opponentsOf(ctx, perm.controllerId).some((opponent) => opponent.id === playerId)
      )
        continue;
      const source: SelectorSource = {
        cardId: perm.cardId,
        controllerId: perm.controllerId,
        eventPlayerId: playerId,
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
            eventPlayerId: playerId,
            ...(amount !== undefined ? { damageDealt: amount } : {}),
          },
        });
        debug(ctx, 'stack', `${when} trigger queued: ${perm.name}`);
      }
    }
  }
}
