import { playerLifeLocked } from '../state/phasing';
import { spellDefinitionOf } from '../state/queries';
import type { ObjectId, PlayerId } from '@mtg/shared';
import type { TargetKind, TargetSpec } from '../cards/ability';
import { playerFilterAlwaysTrue } from '../cards/effect-reference-contracts';
import type { SelectorCandidate } from '../cards/selector';
import { selectMatches, selectorReadsSourcePower } from '../cards/selector';
import { candidateOf, computeCharacteristics, matchesSelector } from '../effects/continuous';
import { spellTargetOccurrences } from '../stack/target-occurrences';
import { offBattlefieldCdaPower } from '../effects/values';
import { spellManaValue } from '../state/objects';
import {
  cardZoneCandidate,
  findPermanent,
  hasKeyword,
  hasProtectionFrom,
  playersInApnapOrder,
} from '../state/queries';
import type {
  EngineCardObject,
  EnginePermanent,
  EngineStackObject,
  GameContext,
} from '../state/types';
import { assertNever } from '../utils/assert-never';
import type { TargetContext } from './context';

/** Generate only the domain; every restriction is applied by targetIsLegal. */
export function targetDomainCandidates(ctx: GameContext, kind: TargetKind): ObjectId[] {
  switch (kind) {
    case 'stackObject':
    case 'spell':
    case 'noncreatureSpell':
      return ctx.state.stack.map((entry) => entry.id);
    case 'spellOrNonlandPermanent':
      return [
        ...ctx.state.stack.map((entry) => entry.id),
        ...ctx.state.battlefield.map((p) => p.id),
      ];
    case 'cardInGraveyard':
      return playersInApnapOrder(ctx).flatMap((player) => player.graveyard.map((card) => card.id));
    case 'commanderInCommandZone':
      return playersInApnapOrder(ctx).flatMap((player) =>
        player.commandZone.map((card) => card.id),
      );
    case 'player':
      return playersInApnapOrder(ctx).map((player) => player.id);
    case 'anyTarget':
    case 'playerOrPlaneswalker':
      return [
        ...ctx.state.battlefield.map((p) => p.id),
        ...playersInApnapOrder(ctx).map((p) => p.id),
      ];
    case 'creature':
    case 'artifact':
    case 'enchantment':
    case 'land':
    case 'planeswalker':
    case 'artifactOrEnchantment':
    case 'artifactEnchantmentOrPlaneswalker':
    case 'nonlandPermanent':
    case 'permanent':
      return ctx.state.battlefield.map((p) => p.id);
    default:
      return assertNever(kind, 'target domain');
  }
}

/**
 * The source's power for a filter relative to it: its last-known power once it has left the
 * battlefield (CR 608.2h), else its current power. Neither known (a source that left without
 * facts) leaves it unset, so the filter matches nothing.
 */
function sourcePowerFor(ctx: GameContext, context: TargetContext): { sourcePower?: number } {
  if (context.sourceFacts !== undefined) return { sourcePower: context.sourceFacts.power };
  const permanent = ctx.state.battlefield.find(
    (candidate) => candidate.cardId === context.sourceCardId,
  );
  return permanent === undefined
    ? {}
    : { sourcePower: computeCharacteristics(ctx, permanent).power };
}

/**
 * A graveyard card as a selector candidate. A "*" power is its characteristic-defining ability
 * evaluated in the graveyard (CR 604.3); with none, it stays unknown and a source-power
 * comparison refuses it.
 */
function graveyardCandidate(
  ctx: GameContext,
  card: EngineCardObject,
  ownerId: PlayerId,
): SelectorCandidate {
  const candidate = cardZoneCandidate(ctx, card, ownerId);
  if (candidate.powerUnknown !== true) return candidate;
  const power = offBattlefieldCdaPower(ctx, card, ownerId);
  if (power === undefined) return candidate;
  const { powerUnknown: _unknown, ...known } = candidate;
  return { ...known, power };
}

/** Authoritative domain/characteristic predicate at preview, announcement, and resolution. */
export function targetIsLegal(
  ctx: GameContext,
  target: TargetKind | TargetSpec,
  candidate: ObjectId,
  context: TargetContext,
): boolean {
  const spec = typeof target === 'string' ? { kind: target } : target;
  const { kind, filter, controller } = spec;
  const { controllerId, eventPlayerId } = context;
  const source = {
    cardId: context.sourceCardId ?? '',
    controllerId,
    ...(filter !== undefined && selectorReadsSourcePower(filter)
      ? sourcePowerFor(ctx, context)
      : {}),
  };
  const matchesController = (id: PlayerId): boolean => {
    switch (controller) {
      case undefined:
        return true;
      case 'you':
        return id === controllerId;
      case 'opponent':
        return id !== controllerId && ctx.state.players.some((p) => p.id === id && !p.hasLost);
      case 'eventPlayer':
        return eventPlayerId !== undefined && id === eventPlayerId;
      default:
        return assertNever(controller, 'target controller');
    }
  };
  if (kind === 'cardInGraveyard') {
    const ownerSlot = spec.graveyardOwnerSlot;
    const selectedOwner = ownerSlot === undefined ? undefined : context.chosenTargets?.[ownerSlot];
    if (
      ownerSlot !== undefined &&
      selectedOwner === undefined &&
      context.phase !== 'preview' &&
      context.phase !== undefined
    )
      return false;
    const ownerScope = spec.graveyardOwnerScope ?? 'controller';
    return ctx.state.players.some((player) => {
      if (player.hasLost) return false;
      if (ownerSlot !== undefined && selectedOwner !== undefined) {
        if (player.id !== selectedOwner) return false;
      } else if (ownerSlot === undefined) {
        switch (ownerScope) {
          case 'controller':
            if (player.id !== controllerId) return false;
            break;
          case 'opponent':
            if (player.id === controllerId) return false;
            break;
          case 'any':
            break;
          default:
            return assertNever(ownerScope, 'graveyard owner');
        }
      }
      const card = player.graveyard.find((card) => card.id === candidate);
      return (
        card !== undefined &&
        (filter === undefined ||
          selectMatches(graveyardCandidate(ctx, card, player.id), filter, source))
      );
    });
  }
  if (kind === 'commanderInCommandZone') {
    return ctx.state.players.some(
      (player) =>
        player.id === controllerId &&
        !player.hasLost &&
        player.commandZone.some((card) => card.id === candidate && card.isCommander),
    );
  }
  if (
    kind === 'stackObject' ||
    kind === 'spell' ||
    kind === 'noncreatureSpell' ||
    kind === 'spellOrNonlandPermanent'
  ) {
    const entry = ctx.state.stack.find((entry) => entry.id === candidate);
    if (entry !== undefined) {
      // CR 115.5: a proposed spell cannot target itself during announcement.
      if (entry.kind === 'spell' && entry.sourceCardId === context.sourceCardId) return false;
      if (!matchesController(entry.controllerId)) return false;
      if (kind !== 'stackObject' && entry.kind !== 'spell') return false;
      if (kind === 'noncreatureSpell' && isCreatureSpell(ctx, entry)) return false;
      if (spec.spellHasSingleTarget === true && spellTargetOccurrences(entry).length !== 1)
        return false;
      if (spec.spellTargetsPermanentYouControl === true) {
        const targets = [...entry.targets, ...Object.values(entry.countTargets ?? {}).flat()];
        if (
          !targets.some((id) =>
            ctx.state.battlefield.some(
              (permanent) => permanent.id === id && permanent.controllerId === controllerId,
            ),
          )
        )
          return false;
      }
      return (
        filter === undefined ||
        (entry.kind === 'spell' && spellMatchesSelector(ctx, entry, filter, controllerId))
      );
    }
    if (kind !== 'spellOrNonlandPermanent') return false;
  }
  const player = ctx.state.players.find((player) => player.id === candidate);
  if (player !== undefined) {
    return (
      (kind === 'player' || kind === 'anyTarget' || kind === 'playerOrPlaneswalker') &&
      !player.hasLost &&
      (context.targeting === false || !playerLifeLocked(ctx, player.id)) &&
      !(context.targeting !== false &&
        player.id !== controllerId &&
        ctx.state.playerHexproofTurn?.[player.id] === ctx.state.turnNumber
      ) &&
      matchesController(player.id) &&
      (filter === undefined || playerFilterAlwaysTrue(filter))
    );
  }
  const permanent = findPermanent(ctx, candidate);
  if (
    permanent === undefined ||
    !permanentMatchesKind(ctx, permanent, kind) ||
    !matchesController(permanent.controllerId)
  )
    return false;
  if (context.targeting !== false) {
    if (hasKeyword(ctx, permanent, 'shroud')) return false;
    if (permanent.controllerId !== controllerId && hasKeyword(ctx, permanent, 'hexproof'))
      return false;
    if (
      context.sourceColors !== undefined &&
      hasProtectionFrom(ctx, permanent, context.sourceColors)
    )
      return false;
  }
  return filter === undefined || matchesSelector(ctx, permanent, filter, source);
}

export function targetCandidates(
  ctx: GameContext,
  spec: TargetKind | TargetSpec,
  context: TargetContext,
): ObjectId[] {
  return targetDomainCandidates(ctx, typeof spec === 'string' ? spec : spec.kind).filter(
    (candidate) => targetIsLegal(ctx, spec, candidate, context),
  );
}

/**
 * Does a permanent match a target kind, by its COMPUTED types (ADR 0007) — an animated
 * Mutavault is a legal "target creature" while a Blood-Mooned land is not a legal "target
 * artifact". Shared by option generation and the CR 608.2b re-check at resolution so the two
 * cannot drift.
 */
export function permanentMatchesKind(
  ctx: GameContext,
  perm: EnginePermanent,
  kind: TargetKind,
): boolean {
  const types = computeCharacteristics(ctx, perm).types;
  switch (kind) {
    case 'creature':
      return types.includes('Creature');
    case 'artifact':
      return types.includes('Artifact');
    case 'enchantment':
      return types.includes('Enchantment');
    case 'land':
      return types.includes('Land');
    case 'planeswalker':
      return types.includes('Planeswalker');
    case 'artifactOrEnchantment':
      return types.includes('Artifact') || types.includes('Enchantment');
    case 'artifactEnchantmentOrPlaneswalker':
      return (
        types.includes('Artifact') ||
        types.includes('Enchantment') ||
        types.includes('Planeswalker')
      );
    case 'nonlandPermanent':
    case 'spellOrNonlandPermanent':
      return !types.includes('Land');
    case 'permanent':
      return true;
    case 'anyTarget':
      // CR 115.4: "any target" is a creature, player, planeswalker, or battle.
      return (
        types.includes('Creature') || types.includes('Planeswalker') || types.includes('Battle')
      );
    case 'playerOrPlaneswalker':
      return types.includes('Planeswalker');
    case 'player':
    case 'spell':
    case 'stackObject':
    case 'cardInGraveyard':
    case 'noncreatureSpell':
    case 'commanderInCommandZone':
      return false;

    default:
      assertNever(kind, 'permanent target kind');
  }
}

/**
 * Does the object a stack `spell` entry is casting have the Creature type? Shared by
 * `computeTargetOptions` and `isTargetStillLegal` (`effects/resolve.ts`) so "noncreature spell"
 * cannot drift between offering a target and rechecking it at resolution — the same reason
 * `permanentMatchesKind` is shared for battlefield kinds.
 */
export function isCreatureSpell(ctx: GameContext, entry: EngineStackObject): boolean {
  const def = spellDefinitionOf(ctx, entry);
  return def.types.includes('Creature');
}

/** Legal target object-ids (or player ids) for one target slot, from `caster`'s seat. */
/** Match a stack spell against a printed-characteristic selector. */
export function spellMatchesSelector(
  ctx: GameContext,
  entry: EngineStackObject,
  selector: import('../cards/selector').Selector,
  casterId: PlayerId,
): boolean {
  const def = spellDefinitionOf(ctx, entry);
  const candidate: SelectorCandidate = {
    cardId: entry.sourceCardId,
    controllerId: entry.controllerId,
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
    manaValue: spellManaValue(def, entry.announcedX),
    isToken: false,
    enteredThisTurn: false,
    isCommander: entry.isCommanderCast,
  };
  return selectMatches(candidate, selector, { cardId: '', controllerId: casterId });
}
/**
 * A count slot's remaining candidates under its `totalManaValueAtMost` budget (Kairi): each must
 * fit within what the already-picked permanents leave. Without a budget, `candidates` is
 * returned unchanged.
 */
export function withinTotalManaValue(
  ctx: GameContext,
  spec: TargetSpec,
  picked: readonly ObjectId[],
  candidates: ObjectId[],
): ObjectId[] {
  const budget = spec.totalManaValueAtMost;
  if (budget === undefined) return candidates;
  const manaValue = (id: ObjectId): number => {
    const perm = ctx.state.battlefield.find((candidate) => candidate.id === id);
    return perm === undefined ? 0 : permanentManaValue(ctx, perm);
  };
  const spent = picked.reduce((total, id) => total + manaValue(id), 0);
  return candidates.filter((id) => manaValue(id) <= budget - spent);
}

/** A permanent's current mana value, as targeting and budgets read it. */
export function permanentManaValue(ctx: GameContext, perm: EnginePermanent): number {
  return candidateOf(ctx, perm, computeCharacteristics(ctx, perm)).manaValue ?? 0;
}
