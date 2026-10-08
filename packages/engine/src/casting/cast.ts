import { supportsAdditionalXAnnouncement } from '../cards/cost-contracts';
import { selectedSpellDefinition } from '../cards/spell-faces';
import { castingPreviewContext } from './preview';
import { castingCheckpoint } from './checkpoint';
import { countTargetsCanComplete, type CountedTargetChoices } from '../targets/announcement';
import { chooseSpellPayment, planSpellPayment } from '../mana/spell-payment';
/**
 * Shared casting entry point extracted from priority actions. Resolution permissions are
 * migrated here incrementally; this module owns configuration, targeting, payment, and casts.
 */

import type { Color, ObjectId, PlayerId } from '@mtg/shared';

import type { WardCost } from '../cards/ability';
import { evaluateCondition } from '../cards/condition';
import type { Ability, AbilityCost, CardDefinition } from '../cards/definition';
import type { DecisionOutcome, GameGen } from '../decisions';
import { payLife, payManaCost, paySpellAdditionalCosts } from '../effects/resolve';
import { mayCastCommanderFromCommand } from './permissions';

import { evaluateValueIn } from '../effects/values';
import { emit, debug } from '../log/log';
import type { ParsedManaCost } from '../mana/cost';
import {
  addGeneric,
  describeManaCost,
  emptyCost,
  subtractColored,
  subtractGeneric,
  withX,
} from '../mana/cost';
import {
  additionalTypedTriggerCopies,
  faceDownSpellOracleId,
  queueCastTriggers,
  queueKeywordCastTriggers,
  queueTriggersForEvent,
  removeFromCurrentZone,
} from '../state/objects';
import {
  castFromLibraryTopCandidates,
  castingSpellsBlockedFor,
  convokeSourcesFor,
  manaSourcesFor,
  spellHasConvoke,
  getDefByOracleId,
  playFromZonePermission,
  wardCostOf,
  requireModeled,
} from '../state/queries';
import type {
  DamageKeyword,
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
  GameContext,
} from '../state/types';
import type { PriorityActionPayload } from '../actions/legal';
import {
  computeTargetOptions,
  withinTotalManaValue,
  costReductionFor,
  manaPortionOf,
  maxChoicesFor,
  modeAdditionalCosts,
  selectedModeTargetSlots,
  targetLifeTaxFor,
  targetMatchesReduction,
  targetedCostReductionFor,
  targetedReductionAmount,
  validateChosenTargets,
} from '../actions/legal';
import { breakYieldsForStop } from '../turn/stops';

function addManaCosts(a: ParsedManaCost, b: ParsedManaCost): ParsedManaCost {
  const hybrid = [...(a.hybrid ?? []), ...(b.hybrid ?? [])];
  const phyrexian = [...(a.phyrexian ?? []), ...(b.phyrexian ?? [])];
  return {
    generic: a.generic + b.generic,
    colorless: a.colorless + b.colorless,
    colored: {
      W: a.colored.W + b.colored.W,
      U: a.colored.U + b.colored.U,
      B: a.colored.B + b.colored.B,
      R: a.colored.R + b.colored.R,
      G: a.colored.G + b.colored.G,
    },
    ...((a.x ?? 0) + (b.x ?? 0) > 0 ? { x: (a.x ?? 0) + (b.x ?? 0) } : {}),
    ...(hybrid.length > 0 ? { hybrid } : {}),
    ...(phyrexian.length > 0 ? { phyrexian } : {}),
  };
}
function resolveCastAbility(
  def: CardDefinition,
  selectedModes: number[] | undefined,
  cardName: string,
  maxChoices?: number,
): Ability | null {
  if (def.spellAbility === null) {
    return def.spellCantBeCountered === true
      ? { kind: 'spell', targets: [], effects: [], cantBeCountered: true }
      : null;
  }
  const modes = def.spellAbility.modes;
  if (modes === undefined) {
    if (selectedModes !== undefined) throw new Error('this spell has no modal configuration');
    return def.spellAbility;
  }
  const indices = selectedModes ?? [0];
  if (indices.length < modes.minChoices || indices.length > (maxChoices ?? modes.maxChoices)) {
    throw new Error(`engine bug: invalid mode count ${indices.length} for ${cardName}`);
  }
  if (modes.repeatable !== true && new Set(indices).size !== indices.length) {
    throw new Error(`repeated mode is not legal for ${cardName}`);
  }
  if (indices.some((index) => !Number.isSafeInteger(index) || index < 0)) {
    throw new Error(`invalid mode index for ${cardName}`);
  }
  const chosen = indices.map((index) => modes.options[index]);
  if (chosen.some((option) => option === undefined)) {
    throw new Error(`engine bug: invalid modes ${indices.join(',')} for ${cardName}`);
  }
  return { ...def.spellAbility, effects: chosen.flatMap((option) => option?.effects ?? []) };
}

export function queueWardTriggers(
  ctx: GameContext,
  controllerId: PlayerId,
  stackObjectId: ObjectId,
  targets: readonly ObjectId[],
): void {
  for (const targetId of new Set(targets)) {
    const perm = ctx.state.battlefield.find((p) => p.id === targetId);
    if (perm === undefined) continue;
    // "an opponent controls" — a permanent's own controller never triggers its ward.
    if (perm.controllerId === controllerId) continue;
    const cost = wardCostOf(ctx, perm);
    if (cost === null) continue;
    const costDescription = describeWardCost(cost);

    const copies = 1 + additionalTypedTriggerCopies(ctx, perm);
    for (let copy = 0; copy < copies; copy++) {
      ctx.state.pendingTriggers.push({
        controllerId: perm.controllerId,
        sourceCardId: perm.cardId,
        sourceObjectId: perm.id,
        sourceOracleId: perm.oracleId,
        sourceName: perm.name,
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'counterUnlessPays', cost, stackObjectId }],
          description: `ward—${costDescription}`,
        },
      });
      debug(ctx, 'stack', `ward triggered: ${perm.name} (${costDescription})`);
    }
  }
}

function describeWardCost(cost: WardCost): string {
  return cost.kind === 'mana' ? describeManaCost(cost.cost) : `pay ${cost.amount} life`;
}

/**
 * "Becomes the target of a spell or ability" (Thunderbreak Regent, CR 603.3d) — every
 * permanent named in `targets` just became a target, regardless of whose. `queueTriggersForEvent`
 * itself enforces "an opponent controls" against `sourceControllerId`.
 */
export function queueBecomesTargetedTriggers(
  ctx: GameContext,
  sourceControllerId: PlayerId,
  targets: readonly ObjectId[],
): void {
  const subjects = [...new Set(targets)]
    .map((id) => ctx.state.battlefield.find((p) => p.id === id))
    .filter((p): p is EnginePermanent => p !== undefined)
    .map((permanent) => ({ permanent, sourceControllerId }));
  queueTriggersForEvent(ctx, 'becomesTargeted', subjects);
}

function validatePlayFromZonePermission(
  ctx: GameContext,
  player: EnginePlayerState,
  card: EngineCardObject,
  zone: 'libraryTop' | 'graveyard',
  chosenBudgetType: string | undefined,
): string | undefined {
  const permission = playFromZonePermission(ctx, player.id, card, zone);
  if (permission === null) throw new Error(`play from ${zone} is not legal`);
  if (permission.budgetTypes === undefined) {
    if (chosenBudgetType !== undefined) throw new Error('unexpected permanent-type budget choice');
    return undefined;
  }
  if (chosenBudgetType === undefined || !permission.budgetTypes.includes(chosenBudgetType)) {
    throw new Error('permanent-type play budget is not available');
  }
  return chosenBudgetType;
}

export function consumePlayFromZonePermission(
  ctx: GameContext,
  player: EnginePlayerState,
  card: EngineCardObject,
  zone: 'libraryTop' | 'graveyard',
  chosenBudgetType: string | undefined,
): void {
  const budgetType = validatePlayFromZonePermission(ctx, player, card, zone, chosenBudgetType);
  if (budgetType !== undefined) {
    player.playFromZoneTypeUsesThisTurn[budgetType] =
      (player.playFromZoneTypeUsesThisTurn[budgetType] ?? 0) + 1;
  }
}

export function* chooseCountTargets(
  ctx: GameContext,
  ability: Ability,
  playerId: PlayerId,
  sourceCardId: string,
  ordinaryTargets: readonly ObjectId[],
  activeSlots?: readonly number[],
  /** The spell's or ability source's colors, for protection (CR 702.16). */
  sourceColors?: readonly Color[],
  payable: (chosen: CountedTargetChoices) => boolean = () => true,
  x = 0,
): GameGen<{
  countTargets: Record<number, ObjectId[]>;
  divisionAmounts: Record<ObjectId, number>;
}> {
  const countTargets: Record<number, ObjectId[]> = {};
  const divisionAmounts: Record<ObjectId, number> = {};
  const context = {
    controllerId: playerId,
    sourceCardId,
    chosenTargets: ordinaryTargets,
    x,
    ...(sourceColors === undefined ? {} : { sourceColors }),
  };
  if (!countTargetsCanComplete(ctx, ability, context, {}, activeSlots, payable)) {
    throw new Error(
      'spell total cost is not jointly payable: required counted targets have no completion',
    );
  }
  for (const [slot, spec] of ability.targets.entries()) {
    if (spec.count === undefined || (activeSlots !== undefined && !activeSlots.includes(slot)))
      continue;
    const divided = ability.effects.find(
      (effect): effect is Extract<import('../cards/ability').Effect, { op: 'dealDamageDivided' }> =>
        effect.op === 'dealDamageDivided' && effect.targetSlot === slot,
    );
    const total =
      divided === undefined
        ? undefined
        : evaluateValueIn(ctx, divided.total, { controllerId: playerId, sourceCardId, x });
    const maximum = Math.min(spec.count.max, total ?? Infinity);
    const picked: ObjectId[] = [];
    for (let index = 0; index < maximum; index++) {
      const candidates = withinTotalManaValue(
        ctx,
        spec,
        picked,
        computeTargetOptions(
          ctx,
          spec,
          playerId,
          sourceColors,
          undefined,
          ordinaryTargets,
          sourceCardId,
        ).filter(
          (id) =>
            !picked.includes(id) &&
            countTargetsCanComplete(
              ctx,
              ability,
              context,
              { ...countTargets, [slot]: [...picked, id] },
              activeSlots,
              payable,
            ),
        ),
      );
      if (candidates.length === 0) break;
      const canStop =
        picked.length >= spec.count.min &&
        countTargetsCanComplete(
          ctx,
          ability,
          context,
          { ...countTargets, [slot]: picked },
          activeSlots,
          payable,
        );
      const outcome = yield {
        decisionType: 'general',
        player: playerId,
        prompt: `Choose target ${picked.length + 1} for ${ability.description ?? 'ability'}`,
        options: [
          ...candidates.map((id) => ({
            type: 'pickTarget',
            description: `Target ${ctx.state.battlefield.find((p) => p.id === id)?.name ?? id}`,
          })),
          ...(canStop ? [{ type: 'decline', description: 'Choose no more targets' }] : []),
        ],
      };
      if (
        !Number.isSafeInteger(outcome.index) ||
        outcome.index < 0 ||
        outcome.index >= candidates.length + (canStop ? 1 : 0)
      )
        throw new Error('invalid counted target choice');
      if (outcome.index === candidates.length) break;
      const id = candidates[outcome.index] as ObjectId;
      picked.push(id);
    }
    if (picked.length < spec.count.min) {
      throw new Error(`missing required counted targets for slot ${slot}`);
    }
    countTargets[slot] = picked;
    if (total !== undefined && picked.length > 0) {
      let remaining = total;
      for (const [index, targetId] of picked.entries()) {
        const left = picked.length - index;
        if (left === 1) {
          divisionAmounts[targetId] = remaining;
          break;
        }
        const choices = Array.from({ length: remaining - left + 1 }, (_, n) => n + 1);
        const outcome = yield {
          decisionType: 'general',
          player: playerId,
          prompt: `Assign damage to ${targetId}`,
          options: choices.map((amount) => ({ type: 'assignDamage', description: `${amount}` })),
        };
        const assigned = choices[outcome.index];
        if (assigned === undefined) throw new Error('invalid damage division');
        divisionAmounts[targetId] = assigned;
        remaining -= assigned;
      }
    }
  }
  return { countTargets, divisionAmounts };
}

function* proposeCast(
  ctx: GameContext,
  player: EnginePlayerState,
  payload: Extract<PriorityActionPayload, { kind: 'castSpell' }>,
  outcome: DecisionOutcome,
  /** Internal, immediate permission from the resolving instruction, never a client payload. */
  resolutionPermission?: { card: EngineCardObject; withoutManaCost: true; lifeCost?: number },
): GameGen<void> {
  const s = ctx.state;
  if (!s.players.includes(player) || player.hasLost) throw new Error('invalid casting player');
  if (castingSpellsBlockedFor(ctx, player.id)) throw new Error('casting spells is prohibited');
  const flags = [
    payload.fromCommand,
    payload.fromExile,
    payload.fromLibraryTop,
    payload.fromGraveyard,
  ];
  if (typeof payload.fromCommand !== 'boolean') throw new Error('missing command-zone source flag');
  if (flags.some((flag) => flag !== undefined && typeof flag !== 'boolean'))
    throw new Error('invalid casting source flag');
  if (flags.filter((flag) => flag === true).length > 1)
    throw new Error('conflicting casting source zones');
  for (const value of [payload.x, payload.optionalCostCount, payload.altIndex]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('invalid casting configuration');
    }
  }
  if (payload.modes !== undefined && !Array.isArray(payload.modes)) {
    throw new Error('invalid mode configuration');
  }
  if (payload.mode !== undefined && (!Number.isSafeInteger(payload.mode) || payload.mode < 0)) {
    throw new Error('invalid mode index');
  }
  if (
    payload.modes !== undefined &&
    payload.mode !== undefined &&
    (payload.modes.length !== 1 || payload.modes[0] !== payload.mode)
  ) {
    throw new Error('conflicting mode configuration');
  }
  if (
    resolutionPermission !== undefined &&
    payload.alternativeCast !== undefined &&
    payload.alternativeCast !== 'adventure' &&
    payload.alternativeCast !== 'omen'
  ) {
    throw new Error('without-mana-cost permission cannot combine alternative costs or nonzero X');
  }

  const fromZone =
    payload.fromExile === true
      ? s.exile
      : payload.fromLibraryTop === true
        ? player.library
        : payload.fromGraveyard === true
          ? player.graveyard
          : payload.fromCommand
            ? player.commandZone
            : player.hand;
  const permittedCard = resolutionPermission?.card;
  const obj =
    permittedCard === undefined
      ? fromZone.find((o) => o.id === payload.objectId)
      : [
          ...s.exile,
          ...s.players.flatMap((p) => [...p.hand, ...p.library, ...p.graveyard, ...p.commandZone]),
        ].find((card) => card === permittedCard && card.id === payload.objectId);
  if (obj === undefined) throw new Error('engine bug: spell to cast not found');
  if (
    resolutionPermission === undefined &&
    payload.fromCommand &&
    !mayCastCommanderFromCommand(player, obj)
  ) {
    throw new Error('command-zone casting permission is not legal');
  }
  const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
  requireModeled(def, 'casting a spell');
  if (
    resolutionPermission === undefined &&
    payload.alternativeCast === undefined &&
    def.manaCost === null
  ) {
    throw new Error('a spell with no mana cost requires an alternative cost');
  }
  if (
    payload.fromLibraryTop === true &&
    resolutionPermission === undefined &&
    player.library[0] !== obj
  ) {
    throw new Error('card is not on top of the library');
  }
  if (payload.alternativeCast === 'faceDown') {
    if (resolutionPermission !== undefined) throw new Error('a face-down cast needs no permission');
    yield* castFaceDown(ctx, player, obj, def);
    return;
  }
  if (
    payload.alternativeCast !== undefined &&
    !['energy', 'commanderFree', 'nonMana', 'overload', 'adventure', 'omen'].includes(
      payload.alternativeCast,
    )
  )
    throw new Error('unknown casting alternative');
  const authoredAlternative =
    payload.alternativeCast === 'nonMana' ||
    payload.alternativeCast === 'overload' ||
    payload.alternativeCast === 'adventure' ||
    payload.alternativeCast === 'omen';
  if (payload.altIndex !== undefined && !authoredAlternative) {
    throw new Error('unexpected alternative index');
  }
  const selectedAlternative = authoredAlternative
    ? payload.altIndex === undefined
      ? def.alternativeCasts?.find((alternative) => alternative.kind === payload.alternativeCast)
      : def.alternativeCasts?.[payload.altIndex]
    : undefined;
  if (authoredAlternative && selectedAlternative?.kind !== payload.alternativeCast) {
    throw new Error('missing or mismatched casting alternative');
  }
  if (selectedAlternative !== undefined) {
    const from = selectedAlternative.from;
    const freeSpellFace =
      resolutionPermission !== undefined &&
      (selectedAlternative.kind === 'adventure' || selectedAlternative.kind === 'omen');
    const temporaryExileSpellFace =
      payload.fromExile === true &&
      obj.playableUntilEotBy === player.id &&
      (selectedAlternative.kind === 'adventure' || selectedAlternative.kind === 'omen');
    if (
      (!freeSpellFace &&
        (payload.fromLibraryTop === true ||
          (payload.fromExile === true && !temporaryExileSpellFace))) ||
      (payload.fromCommand && from === 'hand') ||
      (payload.fromExile === true && from === 'hand') ||
      (!freeSpellFace &&
        (payload.fromGraveyard === true
          ? from !== 'graveyard'
          : from === 'graveyard' || from === 'exile'))
    ) {
      throw new Error('casting alternative is not supported from this zone');
    }
    if (
      selectedAlternative.condition !== undefined &&
      !evaluateCondition(
        castingPreviewContext(ctx, obj, player.id),
        selectedAlternative.condition,
        {
          cardId: obj.cardId,
          controllerId: player.id,
        },
      )
    ) {
      throw new Error('casting alternative condition is not met');
    }
  }
  const printedSpellDef = selectedSpellDefinition(def, selectedAlternative);
  // Without paying the mana cost, an X in the mana cost is 0 (CR 107.3b); an X announced only
  // for an additional cost ("pay X life", Toxic Deluge) is still chosen (CR 601.2b).
  if (
    resolutionPermission !== undefined &&
    (payload.x ?? 0) !== 0 &&
    (printedSpellDef.manaCost?.x !== undefined || printedSpellDef.announcesX !== true)
  ) {
    throw new Error('without-mana-cost permission cannot combine alternative costs or nonzero X');
  }
  if (!supportsAdditionalXAnnouncement(printedSpellDef))
    throw new Error('additional X requires a direct pay-X-life cost');
  if (printedSpellDef.types.includes('Land')) throw new Error('a land cannot be cast as a spell');
  if (
    payload.alternativeCast === 'energy' &&
    (payload.fromGraveyard === true || payload.fromExile === true)
  ) {
    throw new Error('energy alternative is not supported from this zone');
  }
  if (payload.alternativeCast === 'commanderFree' && payload.fromGraveyard === true) {
    throw new Error('commander-free alternative is not supported from this zone');
  }
  if (resolutionPermission === undefined) {
    const instantSpeed =
      printedSpellDef.types.includes('Instant') || printedSpellDef.keywords.includes('flash');
    if (
      !instantSpeed &&
      (s.currentTurnPlayer !== player.id ||
        s.stack.length > 0 ||
        !['precombatMain', 'postcombatMain'].includes(s.phase))
    )
      throw new Error('casting timing is not legal');
    if (s.priorityPlayerIndex !== null && s.turnOrder[s.priorityPlayerIndex] !== player.id)
      throw new Error('casting player does not have priority');
  }
  let consumeZonePermission: 'libraryTop' | 'graveyard' | undefined;
  if (
    resolutionPermission === undefined &&
    payload.fromGraveyard === true &&
    selectedAlternative?.from !== 'graveyard' &&
    // A card's own "you may cast this card from your graveyard" needs no outside permission.
    printedSpellDef.castFromGraveyard !== true
  ) {
    validatePlayFromZonePermission(ctx, player, obj, 'graveyard', payload.zoneBudgetType);
    consumeZonePermission = 'graveyard';
  }
  if (resolutionPermission === undefined && payload.fromLibraryTop === true) {
    const permission = playFromZonePermission(ctx, player.id, obj, 'libraryTop');
    if (permission !== null) {
      validatePlayFromZonePermission(ctx, player, obj, 'libraryTop', payload.zoneBudgetType);
      consumeZonePermission = 'libraryTop';
    } else if (!castFromLibraryTopCandidates(ctx, player.id).some((card) => card.id === obj.id)) {
      throw new Error('cast from library top is not legal');
    }
  }
  if (payload.zoneBudgetType !== undefined && consumeZonePermission === undefined) {
    throw new Error('unexpected permanent-type budget choice');
  }
  let castingAdditionalCosts: AbilityCost[] = [
    ...(printedSpellDef.spellAdditionalCosts ?? []),
    // Life paid rather than the mana cost (Anrakyr) is paid with the other costs (CR 601.2h).
    ...((resolutionPermission?.lifeCost ?? 0) > 0
      ? [{ kind: 'payLife' as const, amount: resolutionPermission!.lifeCost! }]
      : []),
  ];
  // A foretold card is cast on a later turn for its foretell cost (CR 702.143a).
  const foretold =
    resolutionPermission === undefined &&
    payload.fromExile === true &&
    obj.ownerId === player.id &&
    obj.foretold !== undefined &&
    obj.foretold.turn < s.turnNumber
      ? obj.foretold
      : null;
  if (
    resolutionPermission === undefined &&
    payload.fromExile === true &&
    !(obj.onAdventure === true && obj.ownerId === player.id) &&
    obj.playableUntilEotBy !== player.id &&
    foretold === null
  ) {
    throw new Error('exile cast permission is not legal');
  }
  if (foretold !== null && payload.alternativeCast !== undefined) {
    throw new Error('a foretold card is cast only for its foretell cost');
  }
  if (payload.reboundCast === true) {
    throw new Error('rebound cards may be cast only while their delayed trigger resolves');
  }

  // CR 601.2a: the proposed spell leaves its source zone before modes, targets, and cost
  // evaluation. No cast event or cast trigger exists until the complete payment succeeds.
  removeFromCurrentZone(ctx, obj);
  const spellCard: EngineCardObject = {
    ...obj,
    id: `o-${s.nextObjectNum++}` as ObjectId,
    zone: 'stack',
    ...(payload.x !== undefined ? { announcedX: payload.x } : {}),
  };
  const spellEntry: EngineStackObject = {
    id: spellCard.id,
    sourceId: spellCard.id,
    controllerId: player.id,
    kind: 'spell',
    description: printedSpellDef.name,
    spellDefinition: printedSpellDef,
    targets: [],
    card: spellCard,
    ability: null,
    sourceOracleId: obj.oracleId,
    sourceCardId: obj.cardId,
    isCommanderCast: payload.fromCommand,
    castInProgress: true,
  };
  s.stack.push(spellEntry);

  const tax = payload.fromCommand ? 2 * (player.commanderCastCount[obj.cardId] ?? 0) : 0;
  const reduction = costReductionFor(ctx, player.id, obj.oracleId, obj.cardId, printedSpellDef);
  const applyRed = (c: ParsedManaCost): ParsedManaCost => {
    let base = c;
    if (reduction.colored !== undefined) {
      base = subtractColored(base, reduction.colored);
    }
    return subtractGeneric(base, reduction.generic);
  };

  let cost: ParsedManaCost;
  let abilityDef = printedSpellDef;
  let exileOnResolution = false;
  let escaped = false;
  let energyAlternativeCostToPay = 0;
  if (payload.alternativeCast === 'energy') {
    const energyAlternativeCost = s.battlefield
      .filter((perm) => perm.controllerId === player.id)
      .map((perm) => getDefByOracleId(ctx, perm.oracleId, perm.name).energyAlternativeCost)
      .find((amount): amount is number => amount !== undefined);
    if (
      !def.types.some((type) =>
        ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Planeswalker'].includes(type),
      ) ||
      energyAlternativeCost === undefined ||
      player.energy < energyAlternativeCost
    ) {
      throw new Error('energy alternative cost is not legal');
    }
    energyAlternativeCostToPay = energyAlternativeCost;
    cost = emptyCost();
  } else if (payload.alternativeCast === 'commanderFree') {
    if (
      def.commanderFreeCast !== true ||
      payload.fromCommand ||
      !s.battlefield.some((perm) => perm.controllerId === player.id && perm.isCommander)
    ) {
      throw new Error('commander-free alternate cost is not legal');
    }
    cost = emptyCost();
  } else if (payload.alternativeCast === 'nonMana') {
    const alt = selectedAlternative;
    if (alt?.kind !== 'nonMana') throw new Error('missing non-mana alternative cost');
    if (
      (payload.fromGraveyard === true && alt.from !== 'graveyard') ||
      (payload.fromGraveyard !== true && alt.from === 'graveyard')
    ) {
      throw new Error('graveyard alternative cost is not legal from this zone');
    }
    castingAdditionalCosts = [...castingAdditionalCosts, ...(alt.costs ?? [])];
    cost = alt.manaCost;
    exileOnResolution = alt.exileOnResolution === true;
    escaped = alt.escaped === true;
  } else if (payload.alternativeCast === 'overload') {
    const alt = selectedAlternative;
    if (alt?.kind !== 'overload') throw new Error('missing overload cost');
    if (alt.ability === undefined)
      throw new Error('overload alternative has no executable ability');
    cost = alt.manaCost;
    abilityDef = {
      ...def,
      spellAbility: alt.ability,
    };
  } else if (payload.alternativeCast === 'adventure' || payload.alternativeCast === 'omen') {
    const alt = selectedAlternative;
    if (alt?.kind !== payload.alternativeCast)
      throw new Error(`missing ${payload.alternativeCast} cost`);
    cost = alt.manaCost;
    if (alt.ability === undefined)
      throw new Error('alternative spell face has no executable ability');
    abilityDef = printedSpellDef;
  } else {
    cost =
      resolutionPermission !== undefined
        ? emptyCost()
        : foretold !== null
          ? foretold.cost
          : (def.manaCost ?? emptyCost());
  }
  // Every alternative cost still announces modes, pays additional costs, and includes the
  // commander tax (CR 118.9d, 601.2b/f). Only the printed mana-cost component is replaced.
  if (resolutionPermission !== undefined) cost = emptyCost();
  if ((payload.x ?? 0) > 0 && (cost.x ?? 0) === 0 && abilityDef.announcesX !== true)
    throw new Error('this spell does not announce X');
  cost = withX(addGeneric(cost, tax), payload.x ?? 0);
  const selectedModes = payload.modes ?? (payload.mode !== undefined ? [payload.mode] : undefined);
  castingAdditionalCosts = [
    ...castingAdditionalCosts,
    ...modeAdditionalCosts(abilityDef, selectedModes),
  ];
  const optional = abilityDef.optionalAdditionalCost;
  const optionalCostCount = payload.optionalCostCount ?? 0;
  if (
    (optional?.repeatable !== true && optionalCostCount > 1) ||
    (optionalCostCount > 0 && optional === undefined)
  ) {
    throw new Error('invalid optional additional-cost count');
  }
  if (optional !== undefined) {
    for (let i = 0; i < optionalCostCount; i++)
      castingAdditionalCosts.push({ kind: 'mana', cost: optional.cost });
  }
  let ability = resolveCastAbility(
    abilityDef,
    selectedModes,
    obj.name,
    maxChoicesFor(ctx, abilityDef, { cardId: obj.cardId, controllerId: player.id }),
  ) ?? {
    kind: 'spell',
    targets: [],
    effects: [],
  };
  const targets = validateChosenTargets(
    ctx,
    abilityDef,
    player.id,
    outcome.targets,
    selectedModeTargetSlots(abilityDef, selectedModes),
    obj.cardId,
  );

  // "Spells you cast that target a creature cost {2} less" (Killian): priced against the targets
  // just chosen (CR 601.2c before 601.2f), as `computePriorityOptions` offered it.
  const targeted =
    (abilityDef.spellAbility?.targets.length ?? 0) > 0
      ? targetedCostReductionFor(ctx, player.id)
      : [];
  const slot = payload.targetReductionSlot;
  if (slot !== undefined && slot >= 0) {
    const chosen = targets[slot];
    if (
      chosen === undefined ||
      !targeted.every((entry) => targetMatchesReduction(ctx, chosen, entry))
    ) {
      throw new Error('illegal action: the reduced cast needs a matching target');
    }
  }
  // Payment preview narrows targeting continuations before anything is paid.
  const totalMana = subtractGeneric(
    applyRed(addManaCosts(cost, manaPortionOf(castingAdditionalCosts))),
    targetedReductionAmount(ctx, targeted, targets),
  );
  // Convoke (CR 702.51): untapped creatures may help pay for this spell.
  const convokeSources = spellHasConvoke(printedSpellDef)
    ? { sources: [...manaSourcesFor(ctx, player.id), ...convokeSourcesFor(ctx, player.id)] }
    : {};
  const payableTargets = (chosen: CountedTargetChoices): boolean =>
    planSpellPayment(ctx, player, {
      ...convokeSources,
      mana: totalMana,
      costs: castingAdditionalCosts,
      sourceCardId: obj.cardId,
      sourceOracleId: obj.oracleId,
      sourceIsCommander: obj.isCommander,
      spellDefinition: printedSpellDef,
      x: payload.x ?? 0,
      energyAlternativeCost: energyAlternativeCostToPay,
      targetLifeTax: targetLifeTaxFor(ctx, player.id, [
        ...targets,
        ...Object.values(chosen).flat(),
      ]),
    }) !== null;
  const counted = yield* chooseCountTargets(
    ctx,
    ability,
    player.id,
    obj.cardId,
    targets,
    selectedModeTargetSlots(abilityDef, selectedModes),
    abilityDef.colors,
    payableTargets,
    payload.x ?? 0,
  );
  const allTargets = [...targets, ...Object.values(counted.countTargets).flat()];
  spellEntry.targets = targets;
  spellEntry.ability = ability;
  if (Object.keys(counted.countTargets).length > 0) spellEntry.countTargets = counted.countTargets;
  if (Object.keys(counted.divisionAmounts).length > 0)
    spellEntry.divisionAmounts = counted.divisionAmounts;
  // CR 601.2c: target triggers are recorded now, even if their sources leave during payment.
  // They are placed only at the enclosing priority checkpoint after this cast/resolution ends.
  queueWardTriggers(ctx, player.id, spellCard.id, allTargets);
  queueBecomesTargetedTriggers(ctx, player.id, allTargets);
  // CR 601.2f: reductions apply once, to the TOTAL — mana cost with X announced plus every
  // additional cost — exactly as `computePriorityOptions` priced the offered action.
  cost = subtractGeneric(
    applyRed(addManaCosts(cost, manaPortionOf(castingAdditionalCosts))),
    targetedReductionAmount(ctx, targeted, allTargets),
  );
  const targetLifeTax = targetLifeTaxFor(ctx, player.id, allTargets);
  const payment = yield* chooseSpellPayment(ctx, player, {
    ...(spellHasConvoke(printedSpellDef)
      ? { sources: [...manaSourcesFor(ctx, player.id), ...convokeSourcesFor(ctx, player.id)] }
      : {}),
    mana: cost,
    costs: castingAdditionalCosts,
    sourceCardId: obj.cardId,
    sourceOracleId: obj.oracleId,
    sourceIsCommander: obj.isCommander,
    spellDefinition: printedSpellDef,
    x: payload.x ?? 0,
    targetLifeTax,
    energyAlternativeCost: energyAlternativeCostToPay,
  });
  const manaPayment = yield* payManaCost(
    ctx,
    player,
    cost,
    {
      kind: 'castSpell',
      oracleId: obj.oracleId,
      isCommander: obj.isCommander,
      spellDefinition: printedSpellDef,
    },
    [],
    payment.reservedObjectIds,
    payment.manaPlan,
  );
  // CR 601.2g precedes 601.2h: finish mana activations before paying spell costs.
  if (targetLifeTax > 0) payLife(ctx, player, targetLifeTax);
  if (energyAlternativeCostToPay > 0) {
    player.energy -= energyAlternativeCostToPay;
    emit(ctx, 'energy', { amount: -energyAlternativeCostToPay, total: player.energy }, player.id);
  }
  if (manaPayment.spellCantBeCountered) ability = { ...ability, cantBeCountered: true };
  yield* paySpellAdditionalCosts(
    ctx,
    player,
    payment.lockedCosts,
    obj.cardId,
    payload.fromCommand === false &&
      payload.fromLibraryTop !== true &&
      payload.fromExile !== true &&
      payload.fromGraveyard !== true,
    payload.x ?? 0,
    payment.choices,
  );
  if (consumeZonePermission !== undefined) {
    // Permission was validated before the proposal; losing its source while paying does not
    // retroactively invalidate a legal cast. Its per-turn budget is consumed at finalization.
    if (payload.zoneBudgetType !== undefined)
      player.playFromZoneTypeUsesThisTurn[payload.zoneBudgetType] =
        (player.playFromZoneTypeUsesThisTurn[payload.zoneBudgetType] ?? 0) + 1;
  }

  if (payload.fromCommand) {
    player.commanderCastCount[obj.cardId] = (player.commanderCastCount[obj.cardId] ?? 0) + 1;
  }

  Object.assign(spellCard, {
    ...(abilityDef.optionalAdditionalCost !== undefined && (payload.optionalCostCount ?? 0) > 0
      ? {
          optionalCostCounts: {
            [abilityDef.optionalAdditionalCost.mechanic]: payload.optionalCostCount ?? 0,
          },
        }
      : {}),
    ...(manaPayment.treasureManaSpent > 0
      ? { treasureManaSpentToCast: manaPayment.treasureManaSpent }
      : {}),
    ...(escaped ? { escaped: true } : {}),
  });
  Object.assign(spellEntry, {
    id: spellCard.id,
    sourceId: spellCard.id,
    controllerId: player.id,
    kind: 'spell',
    description: printedSpellDef.name,
    spellDefinition: printedSpellDef,
    sourceColors: [...printedSpellDef.colors],
    sourceDamageKeywords: printedSpellDef.keywords.filter((keyword): keyword is DamageKeyword =>
      ['infect', 'lifelink', 'deathtouch'].includes(keyword),
    ),
    targets,
    ...(Object.keys(counted.countTargets).length > 0 ? { countTargets: counted.countTargets } : {}),
    ...(Object.keys(counted.divisionAmounts).length > 0
      ? { divisionAmounts: counted.divisionAmounts }
      : {}),
    card: spellCard,
    ability,
    sourceOracleId: obj.oracleId,
    sourceCardId: obj.cardId,
    isCommanderCast: payload.fromCommand,
    ...(payload.alternativeCast ? { alternativeCastKind: payload.alternativeCast } : {}),
    ...(payload.altIndex === undefined ? {} : { altIndex: payload.altIndex }),
    ...(payload.x !== undefined ? { announcedX: payload.x } : {}),
    ...(spellCard.optionalCostCounts !== undefined
      ? {
          optionalCostCounts: { ...spellCard.optionalCostCounts },
          ...(spellCard.optionalCostCounts.kicker ? { wasKicked: true, kicked: true } : {}),
        }
      : {}),
    ...(exileOnResolution ? { exileOnResolution: true } : {}),
    ...(escaped ? { escaped: true } : {}),
    ...(resolutionPermission === undefined &&
    payload.fromExile !== true &&
    payload.fromLibraryTop !== true &&
    payload.fromGraveyard !== true &&
    payload.fromCommand !== true &&
    abilityDef.keywords.includes('rebound')
      ? { reboundPending: true }
      : {}),
    triggerScope: {
      manaSpent: manaPayment.manaSpent,
      treasureManaSpent: manaPayment.treasureManaSpent,
    },
  });
  delete spellEntry.castInProgress;
  breakYieldsForStop(ctx, spellEntry);
  emit(
    ctx,
    'castSpell',
    {
      player: player.id,
      name: printedSpellDef.name,
      cardId: obj.cardId,
      targets,
      fromCommand: payload.fromCommand,
      commanderTax: tax,
      ...(resolutionPermission === undefined ? {} : { duringResolution: true }),
    },
    player.id,
  );
  debug(ctx, 'stack', `${player.id} casts ${obj.name}${tax > 0 ? ` (tax {${tax}})` : ''}`, {
    targets,
  });
  // "Whenever you cast a Dragon spell" fires now, with the spell already on the stack below
  // it (CR 603.3b), so the trigger resolves first.
  queueCastTriggers(ctx, spellEntry);
  queueKeywordCastTriggers(ctx, spellEntry);
  return;
}

/**
 * Morph's face-down cast (CR 702.37c, 708.4): from hand, for {3} less any reduction that
 * applies to a vanilla colorless creature spell, as a 2/2 creature spell with no name, cost,
 * color or abilities. The stack object carries the face-down definition, so cast triggers and
 * every other player see only that; the card resolves into a face-down permanent.
 */
function* castFaceDown(
  ctx: GameContext,
  player: EnginePlayerState,
  obj: EngineCardObject,
  def: CardDefinition,
): GameGen<void> {
  if (def.morphCost === undefined || !player.hand.some((card) => card.id === obj.id)) {
    throw new Error('illegal action: this card cannot be cast face down');
  }
  const faceDownId = faceDownSpellOracleId(ctx);
  const reduction = costReductionFor(ctx, player.id, faceDownId, obj.cardId);
  const base: ParsedManaCost = { ...emptyCost(), generic: 3 };
  const cost = subtractGeneric(
    reduction.colored === undefined ? base : subtractColored(base, reduction.colored),
    reduction.generic,
  );
  const manaPayment = yield* payManaCost(ctx, player, cost, {
    kind: 'castSpell',
    oracleId: faceDownId,
    isCommander: false,
  });
  removeFromCurrentZone(ctx, obj);
  const spellCard: EngineCardObject = {
    ...obj,
    id: `o-${ctx.state.nextObjectNum++}` as ObjectId,
    zone: 'stack',
  };
  const spellEntry: EngineStackObject = {
    id: spellCard.id,
    sourceId: spellCard.id,
    controllerId: player.id,
    kind: 'spell',
    description: 'Face-down creature spell',
    targets: [],
    card: spellCard,
    ability: { kind: 'spell', targets: [], effects: [] },
    sourceOracleId: faceDownId,
    sourceCardId: obj.cardId,
    isCommanderCast: false,
    alternativeCastKind: 'faceDown',
    triggerScope: { manaSpent: manaPayment.manaSpent },
  };
  ctx.state.stack.push(spellEntry);
  breakYieldsForStop(ctx, spellEntry);
  emit(
    ctx,
    'castSpell',
    {
      player: player.id,
      name: 'Face-down creature spell',
      cardId: obj.cardId,
      targets: [],
      fromCommand: false,
      commanderTax: 0,
      faceDown: true,
    },
    player.id,
  );
  debug(ctx, 'stack', `${player.id} casts a face-down creature spell`);
  queueCastTriggers(ctx, spellEntry);
}

/** Complete a cast exactly once; errors and interrupted supported proposals restore in place. */
export function* castSpell(...args: Parameters<typeof proposeCast>): GameGen<void> {
  const recover = castingCheckpoint(args[0]);
  let finalized = false;
  try {
    yield* proposeCast(...args);
    finalized = true;
  } finally {
    if (!finalized) recover();
  }
}
