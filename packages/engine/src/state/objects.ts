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
import type { Ability, KeywordAbility, ObjectTriggerWhen, TokenSpec } from '../cards/ability';
import { evaluateCondition, resolveCondition } from '../cards/condition';
import type { CardDefinition } from '../cards/definition';
import type { SelectorCandidate, SelectorSource } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import type { TriggerScope } from '../cards/value';
import { evaluateValue } from '../cards/value';
import type { GameGen } from '../decisions';
import { chooseCard } from '../effects/choose';
import { computeCharacteristics, matchesSelector, selectPermanents } from '../effects/continuous';
import { debug, emit } from '../log/log';
import { cardZoneCandidate, counterAmountAfterReplacementsForCandidate, getDefByOracleId, tokenCreationMultiplierFor, triggersOf } from './queries';
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
  /** Battlefield only: the controller it enters under (defaults to its owner). */
  controllerId?: PlayerId;
  /** Battlefield only: choose the back face of an MDFC land // spell. */
  face?: 'front' | 'back';
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

function mdfcLandFaceFor(ctx: GameContext, obj: EngineObject) {
  if (obj.face !== 'back') return undefined;
  return ctx.defs.get(obj.oracleId)?.alternativeCasts?.find((alt) => alt.kind === 'mdfc')?.landFace;
}

/** Clone `obj` as a brand-new object (new `ObjectId`) in `zone` (CR 400.7). */
function reincarnate(ctx: GameContext, obj: EngineObject, zone: Zone): EngineCardObject {
  const original = obj.zone === 'battlefield' ? (obj as EnginePermanent).copyOriginal : undefined;
  const frontDef = ctx.defs.get(obj.oracleId);
  const landFace = mdfcLandFaceFor(ctx, obj);
  return {
    id: newObjectId(ctx),
    cardId: obj.cardId,
    oracleId: original?.oracleId ?? obj.oracleId,
    ownerId: obj.ownerId,
    name: original?.name ?? (zone === 'battlefield' ? landFace?.name ?? obj.name : frontDef?.name ?? obj.name),
    typeLine: original?.typeLine ?? (zone === 'battlefield' ? landFace?.typeLine ?? obj.typeLine : frontDef?.typeLine ?? obj.typeLine),
    oracleText: original?.oracleText ?? (zone === 'battlefield' ? landFace?.oracleText ?? obj.oracleText : landFace?.frontOracleText ?? obj.oracleText),
    manaCost: original?.manaCost ?? (zone === 'battlefield' ? landFace?.manaCost ?? obj.manaCost : landFace?.frontManaCost ?? obj.manaCost),
    isToken: obj.isToken,
    isCommander: obj.isCommander,
    zone,
    ...(zone === 'battlefield' && obj.face !== undefined ? { face: obj.face } : {}),
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
  const landFace = mdfcLandFaceFor(ctx, obj);
  // Planeswalkers/battles enter with their printed loyalty/defense (CR 306.5b, 310.6).
  const counters: Record<string, number> = {};
  if (landFace === undefined && def.types.includes('Planeswalker') && def.loyalty !== null) counters['loyalty'] = def.loyalty;
  if (landFace === undefined && def.types.includes('Battle') && def.defense !== null) counters['defense'] = def.defense;
  // "~ enters with N +1/+1 counters on it" is a replacement effect (CR 614.1c): the counters
  // are already there as it enters, so it is never momentarily 0-toughness.
  for (const [counter, n] of Object.entries(def.entersWithCounters ?? {})) {
    counters[counter] = (counters[counter] ?? 0) + n;
  }
  const incoming = cardZoneCandidate(ctx, obj as EngineCardObject, controllerId);
  for (const [counter, amount] of Object.entries(counters)) {
    counters[counter] = counterAmountAfterReplacementsForCandidate(ctx, incoming, counter, amount);
  }
  return {
    ...reincarnate(ctx, obj, 'battlefield'),
    zone: 'battlefield',
    controllerId,
    tapped: entersTappedOverride ?? landFace?.entersTapped ?? def.entersTapped,
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
    dealtFirstStrikeDamage: false,
    ...(def.cantBlock === true ? { cantBlock: true } : {}),
    ...(def.cantBeBlocked === true ? { cantBeBlocked: true } : {}),
    timestamp: ctx.state.nextTimestamp++,
    activationsThisTurn: [],
    enteredTurnNumber: ctx.state.turnNumber,
  };
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

  if (from === 'battlefield' && target.zone === 'graveyard') {
    (obj as unknown as EngineCardObject).rememberedCounters = { ...(obj as EnginePermanent).counters };
  }

  // Tokens cease to exist when they leave the battlefield (CR 704.5d; applied directly
  // on the move rather than at the next SBA check — indistinguishable in Phase 2).
  if (obj.isToken && from === 'battlefield' && target.zone !== 'battlefield') {
    emit(ctx, 'tokenCeased', { name: obj.name, cardId: obj.cardId });
    debug(ctx, 'zoneChange', `token ${obj.name} ceased to exist`);
    queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
    yield* returnExiledUntilLeaves(ctx, obj.cardId);
    return null;
  }

  let next: EngineCardObject | EnginePermanent;
  if (target.zone === 'battlefield') {
    const controllerId = target.controllerId ?? obj.ownerId;
    // As-enters replacement (CR 614.1c): "enters tapped unless <condition>". Resolved BEFORE
    // the permanent exists, so it is never momentarily tapped-then-untapped — and because the
    // condition may be a choice ("you may pay 2 life"), it is resolved here, in the generator.
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
    const landFace = target.face === 'back' ? def.alternativeCasts?.find((alt) => alt.kind === 'mdfc')?.landFace : undefined;
    let entersTappedOverride: boolean | undefined;
    const entersTappedUnless = landFace?.entersTappedUnless ?? def.entersTappedUnless;
    if (entersTappedUnless !== undefined) {
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
    const perm = makePermanent(ctx, incoming, controllerId, entersTappedOverride);
    ctx.state.battlefield.push(perm);
  if (ctx.state.createdTokenThisTurn) ctx.state.createdTokenThisTurn[controllerId] = true;
    next = perm;

    const chars = computeCharacteristics(ctx, perm);
    if (chars.types.includes('Creature') && chars.keywords.includes('riot')) {
      const outcome = yield {
        decisionType: 'general',
        player: controllerId,
        prompt: `Riot choice for ${perm.name}: choose a +1/+1 counter or haste`,
        options: [
          { type: 'riotCounter', description: `Put a +1/+1 counter on ${perm.name}`, payload: perm.id },
          { type: 'riotHaste', description: `Give ${perm.name} haste until end of turn`, payload: perm.id },
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
        perm.counters['+1/+1'] = (perm.counters['+1/+1'] ?? 0) + 1;
        emit(ctx, 'putCounter', { target: perm.name, counter: '+1/+1', count: 1 });
      }
    }

    // As-enters modal choice (CR 614.1c), e.g. Caged Sun's color or Frontier Siege's mode.
    // Resolved here, before anything else can observe the permanent, so nothing built on
    // `chosenOption` can ever run before it exists.
    if (def.entersChoosingOption !== undefined) {
      const { prompt, options } = def.entersChoosingOption;
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

    // "You may have this enter the battlefield as a copy of …" (CR 707.2, as-enters
    // replacement — Dack's Duplicate, Spark Double, Sculpting Steel). Resolved after the
    // permanent exists (so it can be excluded from its own candidate list) but before
    // `queueTriggersForObject(ctx, 'enters', …)` below, so ETB triggers reflect the copied
    // identity rather than the entering card's own.
    if (def.entersAsCopy !== undefined) {
      const config = def.entersAsCopy;
      const candidates = selectPermanents(ctx, config.selector, { cardId: perm.cardId, controllerId })
        .filter((p) => p.cardId !== perm.cardId);
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
          perm.counters[counter] = (perm.counters[counter] ?? 0) + config.addCounterByType.count;
        }
        emit(ctx, 'becomeCopy', { source: originalName, target: copyTargetPerm.name, untilEot: false });
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
    name: obj.name,
    from,
    to: target.zone,
    owner: obj.ownerId,
    newObjectId: next.id,
  });
  debug(ctx, 'zoneChange', `${obj.name}: ${from} → ${target.zone}`, { cardId: obj.cardId });

  // Triggers: enters on arriving, dies on battlefield → graveyard.
  if (target.zone === 'battlefield' && from !== 'battlefield') {
    queueTriggersForObject(ctx, 'enters', next as EnginePermanent);
  }
  if (from === 'battlefield') {
    queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
    yield* returnExiledUntilLeaves(ctx, obj.cardId);
  }

  return next;
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
  const oracleId =
    `token:${spec.name}:${spec.typeLine}:${(spec.supertypes ?? []).join('+')}:${spec.power ?? ''}/${spec.toughness ?? ''}` as OracleId;
  if (!ctx.defs.has(oracleId)) {
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
    ctx.defs.set(oracleId, {
      oracleId,
      name: spec.name,
      typeLine: spec.typeLine,
      supertypes: spec.supertypes ?? [],
      types: spec.types ?? (spec.typeLine.includes('Creature') ? ['Creature'] : spec.typeLine.includes('Land') ? ['Land'] : spec.typeLine.includes('Artifact') ? ['Artifact'] : ['Creature']),
      subtypes: spec.subtypes ?? [],
      colors: spec.colors,
      colorIdentity: spec.colors,
      manaCost: null,
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
export function createToken(
  ctx: GameContext,
  spec: TokenSpec,
  controllerId: PlayerId,
  applyTokenReplacements = true,
): EnginePermanent {
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
    manaCost: null,
    isToken: true,
    isCommander: false,
    zone: 'battlefield',
  };
  const perm = makePermanent(ctx, stub, controllerId);
  ctx.state.battlefield.push(perm);
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
  emit(ctx, 'tokenCreated', { name: spec.name, controller: controllerId, cardId: perm.cardId });
  debug(ctx, 'zoneChange', `token created: ${spec.name} under ${controllerId}`);
  queueTriggersForObject(ctx, 'enters', perm);
  if (
    applyTokenReplacements &&
    spec.types.includes('Artifact') &&
    ctx.state.battlefield.some((candidate) => {
      if (candidate.controllerId !== controllerId) return false;
      const def = ctx.defs.get(candidate.oracleId);
      return def?.ruleStatics.some((rs) => rs.kind === 'artifactTokenCreatesThopter') ?? false;
    })
  ) {
    createToken(ctx, {
      name: 'Thopter',
      typeLine: 'Artifact Creature — Thopter',
      types: ['Artifact', 'Creature'],
      subtypes: ['Thopter'],
      colors: [],
      power: 1,
      toughness: 1,
      keywords: ['flying'],
    }, controllerId, false);
  }
  if (applyTokenReplacements) {
    const multiplier = tokenCreationMultiplierFor(ctx, controllerId);
    for (let i = 1; i < multiplier; i++) createToken(ctx, spec, controllerId, false);
  }

  return perm;
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
        if (when === 'becomesTargeted' && s.sourceControllerId === source.controllerId) return false;
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
            ? [...new Map(matched.map((s) => [byEventPlayerKey(s), matched.filter((other) => byEventPlayerKey(other) === byEventPlayerKey(s))])).values()]
            : matched.map((s) => [s]);

      const enteringArtifactOrCreature =
        when === 'enters' && matched.some((s) => {
          const chars = computeCharacteristics(ctx, s.permanent);
          return chars.types.includes('Artifact') || chars.types.includes('Creature');
        });
      const additionalCopies = enteringArtifactOrCreature
        ? ctx.state.battlefield.filter((perm) => {
            if (perm.controllerId !== source.controllerId) return false;
            const def = ctx.defs.get(perm.oracleId);
            return def?.ruleStatics.some((rs) => rs.kind === 'triggerAdditionalOnArtifactOrCreatureEntry') ?? false;
          }).length
        : 0;
      for (let copy = 0; copy <= additionalCopies; copy++) {
        for (const group of firings) {
        const first = group[0] as TriggerEventSubject;
        // Intervening-if, first check (CR 603.4), with the event object available for
        // conditions such as "if that creature had to attack".
        if (
          spec.condition !== undefined &&
          !evaluateCondition(ctx, spec.condition, {
            ...from,
            ...(spec.subject.kind === 'self' ? {} : { triggerObjectCardId: first.permanent.cardId }),
          })
        ) {
          debug(ctx, 'stack', `trigger not queued: ${source.name} � intervening-if false`);
          continue;
        }
        const amounts = group.filter((s) => s.amount !== undefined);
        const eventPlayerId = spec.aggregate === 'byEventPlayer' ? byEventPlayerKey(first) : first.playerId;
        const scope: TriggerScope = {
          ...(spec.aggregate !== undefined ? { triggerCount: group.length } : {}),
            ...(eventPlayerId !== undefined ? { eventPlayerId } : {}),
          ...(amounts.length > 0
            ? { damageDealt: amounts.reduce((sum, s) => sum + (s.amount ?? 0), 0) }
            : {}),
        };
        ctx.state.pendingTriggers.push({
          controllerId: source.controllerId,
          sourceCardId: source.cardId,
          sourceOracleId: source.oracleId,
          sourceName: source.name,
          ability,
          // Only meaningful when the subject is something other than the source itself.
          ...(spec.subject.kind === 'self' ? {} : { triggerObjectCardId: first.permanent.cardId }),
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
            !evaluateCondition(ctx, spec.condition, { ...from, triggerObjectCardId: s.permanent.cardId })
          ) {
            continue;
          }
          ctx.state.pendingTriggers.push({
            controllerId: card.ownerId,
            sourceCardId: card.cardId,
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
    const matchingSubject = delayed.targetId !== undefined
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
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, from)) continue;

      ctx.state.pendingTriggers.push({
        controllerId: source.controllerId,
        sourceCardId: source.cardId,
        sourceOracleId: source.oracleId,
        sourceName: source.name,
        ability,
        scope: { spellManaValue: manaValue, eventPlayerId: spell.controllerId, ...(spell.triggerScope?.manaSpent !== undefined ? { manaSpent: spell.triggerScope.manaSpent } : {}) },
      });
      debug(ctx, 'stack', `cast trigger queued: ${source.name} — ${spell.description}`);
    }
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
  return cost.generic + colored + cost.colorless + (cost.x ?? 0) * (announcedX ?? 0);
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
 * leaves — regardless of where it goes — every card it exiled this way comes back, under the
 * control it had when exiled. Each return is a normal zone change (a NEW object, "enters"
 * triggers included), just like any other return from exile.
 */
function* returnExiledUntilLeaves(ctx: GameContext, sourceCardId: CardId): GameGen<void> {
  const entries = ctx.state.exiledUntilLeaves[sourceCardId];
  if (entries === undefined) return;
  delete ctx.state.exiledUntilLeaves[sourceCardId];
  for (const entry of entries) {
    const exiled = ctx.state.exile.find((c) => c.cardId === entry.cardId);
    if (exiled === undefined) continue;
    yield* moveObject(ctx, exiled, { zone: 'battlefield', controllerId: entry.controllerId });
  }
}

export function queuePlayerTriggersForEvent(
  ctx: GameContext,
  when: 'gainsLife',
  playerId: PlayerId,
  amount?: number,
): void {
  for (const perm of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, perm)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;
      if (spec.player === 'you' && perm.controllerId !== playerId) continue;
      const source = { cardId: perm.cardId, controllerId: perm.controllerId };
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, source)) continue;
      ctx.state.pendingTriggers.push({
        controllerId: perm.controllerId,
        sourceCardId: perm.cardId,
        sourceOracleId: perm.oracleId,
        sourceName: perm.name,
        ability,
        ...(amount !== undefined ? { scope: { damageDealt: amount } } : {}),
      });
      debug(ctx, 'stack', `${when} trigger queued: ${perm.name}`);
    }
  }
}
