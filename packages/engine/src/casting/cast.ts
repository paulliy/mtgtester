import { chooseSpellPayment } from '../mana/spell-payment';
/**
 * Shared casting entry point extracted from priority actions. Resolution permissions are
 * migrated here incrementally; this module owns configuration, targeting, payment, and casts.
 */

import type { Color, ObjectId, PlayerId } from '@mtg/shared';

import type { WardCost } from '../cards/ability';
import { evaluateCondition } from '../cards/condition';
import type { Ability, AbilityCost, CardDefinition } from '../cards/definition';
import type { DecisionOutcome, GameGen } from '../decisions';
import { loseLife, payManaCost, paySpellAdditionalCosts } from '../effects/resolve';

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
  queueCastTriggers,
  queueKeywordCastTriggers,
  queueTriggersForEvent,
  removeFromCurrentZone,
} from '../state/objects';
import {
  castFromLibraryTopCandidates,
  getDefByOracleId,
  playFromZonePermission,
  wardCostOf,
} from '../state/queries';
import type {
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
  if (modes === undefined) return def.spellAbility;
  const indices = selectedModes ?? [0];
  if (indices.length < modes.minChoices || indices.length > (maxChoices ?? modes.maxChoices)) {
    throw new Error(`engine bug: invalid mode count ${indices.length} for ${cardName}`);
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
  for (const targetId of targets) {
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
  const subjects = targets
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
): GameGen<{
  countTargets: Record<number, ObjectId[]>;
  divisionAmounts: Record<ObjectId, number>;
}> {
  const countTargets: Record<number, ObjectId[]> = {};
  const divisionAmounts: Record<ObjectId, number> = {};
  const chosen = new Set<ObjectId>(ordinaryTargets);
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
        : evaluateValueIn(ctx, divided.total, { controllerId: playerId, sourceCardId });
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
        ).filter((id) => !chosen.has(id)),
      );
      if (candidates.length === 0) break;
      const canStop = picked.length >= spec.count.min;
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
      if (outcome.index >= candidates.length) break;
      const id = candidates[outcome.index] as ObjectId;
      picked.push(id);
      chosen.add(id);
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
        const assigned = choices[outcome.index] ?? 1;
        divisionAmounts[targetId] = assigned;
        remaining -= assigned;
      }
    }
  }
  return { countTargets, divisionAmounts };
}

export function* castSpell(
  ctx: GameContext,
  player: EnginePlayerState,
  payload: Extract<PriorityActionPayload, { kind: 'castSpell' }>,
  outcome: DecisionOutcome,
): GameGen<void> {
  const s = ctx.state;

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
  const obj = fromZone.find((o) => o.id === payload.objectId);
  if (obj === undefined) throw new Error('engine bug: spell to cast not found');
  const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
  let consumeZonePermission: 'libraryTop' | 'graveyard' | undefined;
  if (payload.fromGraveyard === true && payload.alternativeCast === undefined) {
    validatePlayFromZonePermission(ctx, player, obj, 'graveyard', payload.zoneBudgetType);
    consumeZonePermission = 'graveyard';
  }
  if (payload.fromLibraryTop === true && payload.alternativeCast === undefined) {
    const permission = playFromZonePermission(ctx, player.id, obj, 'libraryTop');
    if (permission !== null) {
      validatePlayFromZonePermission(ctx, player, obj, 'libraryTop', payload.zoneBudgetType);
      consumeZonePermission = 'libraryTop';
    } else if (!castFromLibraryTopCandidates(ctx, player.id).some((card) => card.id === obj.id)) {
      throw new Error('cast from library top is not legal');
    }
  }
  let castingAdditionalCosts: AbilityCost[] = [...(def.spellAdditionalCosts ?? [])];
  if (
    payload.fromExile === true &&
    obj.onAdventure !== true &&
    obj.playableUntilEotBy !== player.id
  ) {
    throw new Error('exile cast permission is not legal');
  }
  if (payload.reboundCast === true) {
    throw new Error('rebound cards may be cast only while their delayed trigger resolves');
  }

  const tax = payload.fromCommand ? 2 * (player.commanderCastCount[obj.cardId] ?? 0) : 0;
  const reduction = costReductionFor(ctx, player.id, obj.oracleId, obj.cardId);
  const applyRed = (c: ParsedManaCost): ParsedManaCost => {
    let base = c;
    if (reduction.colored !== undefined) {
      base = subtractColored(base, reduction.colored);
    }
    return subtractGeneric(base, reduction.generic);
  };

  let cost: ParsedManaCost;
  let ability: Ability;
  let targets: ObjectId[];
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
    ability = resolveCastAbility(def, undefined, obj.name) ?? {
      kind: 'spell',
      targets: [],
      effects: [],
    };
    targets = validateChosenTargets(ctx, def, player.id, outcome.targets);
  } else if (payload.alternativeCast === 'commanderFree') {
    if (
      def.commanderFreeCast !== true ||
      payload.fromCommand ||
      !s.battlefield.some((perm) => perm.controllerId === player.id && perm.isCommander)
    ) {
      throw new Error('commander-free alternate cost is not legal');
    }
    cost = emptyCost();
    ability = resolveCastAbility(def, undefined, obj.name) ?? {
      kind: 'spell',
      targets: [],
      effects: [],
    };
    targets = validateChosenTargets(ctx, def, player.id, outcome.targets);
  } else if (payload.alternativeCast === 'nonMana') {
    const alt =
      def.alternativeCasts?.[payload.altIndex ?? 0] ??
      def.alternativeCasts?.find((a) => a.kind === 'nonMana');
    if (alt?.kind !== 'nonMana') throw new Error('missing non-mana alternative cost');
    if (
      (payload.fromGraveyard === true && alt.from !== 'graveyard') ||
      (payload.fromGraveyard !== true && alt.from === 'graveyard')
    ) {
      throw new Error('graveyard alternative cost is not legal from this zone');
    }
    if (
      alt.condition !== undefined &&
      !evaluateCondition(ctx, alt.condition, { cardId: obj.cardId, controllerId: player.id })
    ) {
      throw new Error('non-mana alternative cost condition is not met');
    }
    castingAdditionalCosts = [...castingAdditionalCosts, ...(alt.costs ?? [])];
    cost = payload.fromGraveyard === true ? alt.manaCost : emptyCost();
    exileOnResolution = alt.exileOnResolution === true;
    escaped = alt.escaped === true;
    ability = resolveCastAbility(def, undefined, obj.name) ?? {
      kind: 'spell',
      targets: [],
      effects: [],
    };
    targets = validateChosenTargets(ctx, def, player.id, outcome.targets);
  } else if (payload.alternativeCast === 'overload') {
    const alt = def.alternativeCasts?.find((a) => a.kind === 'overload');
    if (!alt) throw new Error('missing overload cost');
    cost = alt.manaCost;
    ability = {
      kind: 'spell',
      targets: [],
      effects: [{ op: 'overloadBounceAllNonlandOpponents' }],
    };
    targets = [];
  } else if (payload.alternativeCast === 'adventure' || payload.alternativeCast === 'omen') {
    const alt =
      def.alternativeCasts?.[payload.altIndex ?? 0] ??
      def.alternativeCasts?.find((a) => a.kind === payload.alternativeCast);
    if (!alt) throw new Error(`missing ${payload.alternativeCast} cost`);
    cost = alt.manaCost;
    ability = alt.ability ?? { kind: 'spell', targets: [], effects: [] };
    targets = validateChosenTargets(ctx, def, player.id, outcome.targets);
  } else {
    cost = withX(addGeneric(def.manaCost ?? emptyCost(), tax), payload.x ?? 0);
    const selectedModes =
      payload.modes ?? (payload.mode !== undefined ? [payload.mode] : undefined);
    castingAdditionalCosts = [
      ...castingAdditionalCosts,
      ...modeAdditionalCosts(def, selectedModes),
    ];
    const optional = def.optionalAdditionalCost;
    const optionalCostCount = payload.optionalCostCount ?? 0;
    if (optionalCostCount < 0 || (optional?.repeatable !== true && optionalCostCount > 1)) {
      throw new Error('engine bug: invalid optional additional-cost count');
    }
    if (optionalCostCount > 0 && optional === undefined) {
      throw new Error('engine bug: optional additional cost is not available');
    }
    if (optional !== undefined) {
      for (let i = 0; i < optionalCostCount; i++) {
        castingAdditionalCosts.push({ kind: 'mana', cost: optional.cost });
      }
    }
    ability = resolveCastAbility(
      def,
      payload.modes ?? (payload.mode !== undefined ? [payload.mode] : undefined),
      obj.name,
      maxChoicesFor(ctx, def, { cardId: obj.cardId, controllerId: player.id }),
    ) ?? {
      kind: 'spell',
      targets: [],
      effects: [],
    };
    targets = validateChosenTargets(
      ctx,
      def,
      player.id,
      outcome.targets,
      selectedModeTargetSlots(def, selectedModes),
    );
  }

  const counted = yield* chooseCountTargets(
    ctx,
    ability,
    player.id,
    obj.cardId,
    targets,
    selectedModeTargetSlots(
      def,
      payload.modes ?? (payload.mode !== undefined ? [payload.mode] : undefined),
    ),
    def.colors,
  );
  const allTargets = [...targets, ...Object.values(counted.countTargets).flat()];
  // CR 601.2f: reductions apply once, to the TOTAL — mana cost with X announced plus every
  // additional cost — exactly as `computePriorityOptions` priced the offered action.
  cost = applyRed(addManaCosts(cost, manaPortionOf(castingAdditionalCosts)));
  const targetLifeTax = targetLifeTaxFor(ctx, player.id, allTargets);
  const payment = yield* chooseSpellPayment(ctx, player, {
    mana: cost,
    costs: castingAdditionalCosts,
    sourceCardId: obj.cardId,
    sourceOracleId: obj.oracleId,
    sourceIsCommander: obj.isCommander,
    x: payload.x ?? 0,
    targetLifeTax,
    energyAlternativeCost: energyAlternativeCostToPay,
  });
  if (targetLifeTax > 0) loseLife(ctx, player, targetLifeTax);
  if (energyAlternativeCostToPay > 0) {
    player.energy -= energyAlternativeCostToPay;
    emit(ctx, 'energy', { amount: -energyAlternativeCostToPay, total: player.energy }, player.id);
  }
  const manaPayment = yield* payManaCost(
    ctx,
    player,
    cost,
    {
      kind: 'castSpell',
      oracleId: obj.oracleId,
      isCommander: obj.isCommander,
    },
    [],
    payment.reservedObjectIds,
    payment.manaPlan,
  );
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
    consumePlayFromZonePermission(ctx, player, obj, consumeZonePermission, payload.zoneBudgetType);
  }

  if (payload.fromCommand) {
    player.commanderCastCount[obj.cardId] = (player.commanderCastCount[obj.cardId] ?? 0) + 1;
  }

  removeFromCurrentZone(ctx, obj);
  const spellCard: EngineCardObject = {
    ...obj,
    id: `o-${s.nextObjectNum++}` as ObjectId,
    zone: 'stack',
    ...(payload.x !== undefined ? { announcedX: payload.x } : {}),
    ...(def.optionalAdditionalCost !== undefined && (payload.optionalCostCount ?? 0) > 0
      ? {
          optionalCostCounts: {
            [def.optionalAdditionalCost.mechanic]: payload.optionalCostCount ?? 0,
          },
        }
      : {}),
    ...(manaPayment.treasureManaSpent > 0
      ? { treasureManaSpentToCast: manaPayment.treasureManaSpent }
      : {}),
    ...(escaped ? { escaped: true } : {}),
  };
  const spellEntry: EngineStackObject = {
    id: spellCard.id,
    sourceId: spellCard.id,
    controllerId: player.id,
    kind: 'spell',
    description: `${obj.name}`,
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
    ...(payload.x !== undefined ? { announcedX: payload.x } : {}),
    ...(spellCard.optionalCostCounts !== undefined
      ? {
          optionalCostCounts: { ...spellCard.optionalCostCounts },
          ...(spellCard.optionalCostCounts.kicker ? { wasKicked: true, kicked: true } : {}),
        }
      : {}),
    ...(exileOnResolution ? { exileOnResolution: true } : {}),
    ...(escaped ? { escaped: true } : {}),
    ...(payload.fromExile !== true &&
    payload.fromLibraryTop !== true &&
    payload.fromGraveyard !== true &&
    payload.fromCommand !== true &&
    def.keywords.includes('rebound')
      ? { reboundPending: true }
      : {}),
    triggerScope: { manaSpent: manaPayment.manaSpent },
  };
  s.stack.push(spellEntry);
  breakYieldsForStop(ctx, spellEntry);
  emit(
    ctx,
    'castSpell',
    {
      player: player.id,
      name: obj.name,
      cardId: obj.cardId,
      targets,
      fromCommand: payload.fromCommand,
      commanderTax: tax,
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
  queueWardTriggers(ctx, player.id, spellCard.id, allTargets);
  queueBecomesTargetedTriggers(ctx, player.id, allTargets);
  return;
}
