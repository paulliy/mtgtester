import { targetingSourceFields } from '../targets/context';
import type { TargetingSource } from '../targets/context';
import { playerLifeLocked } from '../state/phasing';
import { offBattlefieldTypes } from '../state/off-battlefield-types';
import { UnmodeledCardError } from '../errors';
import type { ObjectFacts } from '../cards/source-identity';
import { supportsAdditionalXAnnouncement } from '../cards/cost-contracts';
import { bestowedDefinition, selectedSpellDefinition } from '../cards/spell-faces';
import { assertNever } from '../utils/assert-never';
import { castingPreviewContext } from '../casting/preview';
import { mayCastCommanderFromCommand } from '../casting/permissions';
import { legalTargetMenus, type TargetMenu } from '../targets/announcement';
import { planSpellPayment } from '../mana/spell-payment';
import { targetCandidates, targetIsLegal } from '../targets/legality';
export {
  permanentMatchesKind,
  isCreatureSpell,
  spellMatchesSelector,
  withinTotalManaValue,
  permanentManaValue,
} from '../targets/legality';
import { activationManaSources } from '../mana/activation';
import {
  abilityModeLabel,
  abilityModeTargetSlots,
  legalAbilityModeSelections,
  slotIsActive,
} from './ability-modes';
/**
 * Legal-action generation (brief §1.2 — the engine computes EVERY legal option; the AI
 * only picks). This is the completeness-critical module: an option omitted here can never
 * be taken, and an option offered here must be applicable without further legality checks.
 *
 * Unmodeled cards: the moment an unmodeled card is in a player's hand (or command zone)
 * at one of their decision points, the engine cannot know that card's legality, so it
 * halts loudly (brief §6.3) rather than silently excluding it.
 */

import { ALL_COLORS } from '@mtg/shared';
import { evaluateCondition } from '../cards/condition';
import type { Color, ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type {
  AbilityCost,
  ActivatedAbility,
  CardDefinition,
  TargetKind,
  TargetSpec,
} from '../cards/definition';
import type { Selector, SelectorCandidate, SelectorSource } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import type { EngineActionOption } from '../decisions';
import { computeCharacteristics, matchesSelector } from '../effects/continuous';
import { evaluateValueIn } from '../effects/values';
import {
  addGeneric,
  canPay,
  describeManaCost,
  emptyCost,
  planPayment,
  subtractColored,
  subtractGeneric,
  totalPips,
  withX,
} from '../mana/cost';
import type { ManaSource, ParsedManaCost, PaymentPlan } from '../mana/cost';
import {
  activatingAbilitiesBlockedFor,
  allowanceFor,
  canPlayFromZone,
  canPayNonManaCosts,
  playFromZonePermission,
  castFromLibraryTopCandidates,
  castingSpellsBlockedFor,
  findPermanent,
  gatherRuleStatics,
  getDefByOracleId,
  nonHandSpellCostIncreaseFor,
  landPlayLimitFor,
  manaSourcesFor,
  previewLandManaSymbols,
  previewManaAbilities,
  requireModeled,
  convokeSourcesFor,
  spellHasConvoke,
  abilityOfPermanent,
  targetingFromDefinition,
} from '../state/queries';
import { faceDownSpellOracleId } from '../state/objects';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
  GameContext,
} from '../state/types';

/** Payloads attached to priority-window options, interpreted by `applyPriorityAction`. */
export type PriorityActionPayload =
  | { kind: 'pass' }
  | { kind: 'passAndYieldTurn' }
  | { kind: 'yieldToAbility'; sourceOracleId: OracleId }
  | {
      kind: 'playLand';
      objectId: ObjectId;
      alternativeCast?: 'mdfc';
      altIndex?: number;
      fromLibraryTop?: boolean;
      fromGraveyard?: boolean;
      fromExile?: boolean;
      zoneBudgetType?: string;
    }
  | {
      kind: 'castSpell';
      objectId: ObjectId;
      fromCommand: boolean;
      /** Korlessa, Scale Singer's "cast Dragon spells from the top of your library". */
      fromLibraryTop?: boolean;
      fromGraveyard?: boolean;
      /** Permanent type spent for a per-type non-hand play permission. */
      zoneBudgetType?: string;
      fromExile?: boolean;
      /** Rebound's free cast permission from exile. */
      reboundCast?: boolean;
      plotCast?: true;
      x?: number;
      /** Which modal option was chosen (CR 601.2b), when `spellAbility.modes` is present. */
      mode?: number;
      /** Chosen modal subset; supersedes mode for ranged modal spells. */
      modes?: number[];
      /** Number of times the card's optional additional cost was paid. */
      optionalCostCount?: number;
      alternativeCast?:
        | 'mdfc'
        | 'overload'
        | 'adventure'
        | 'omen'
        | 'nonMana'
        | 'energy'
        | 'commanderFree'
        | 'faceDown'
        | 'bestow';
      altIndex?: number;
      /**
       * The option priced with target-dependent reductions (Killian): the target slot that must
       * hold a matching target, or -1 for the variant that targets nothing matching.
       */
      targetReductionSlot?: number;
      /** Exact target-dependent discount locked by the offered option, including counted slots. */
      targetReductionAmount?: number;
    }
  /** Activate `index` of the source permanent's `activatedAbilities` (CR 602). */
  | {
      kind: 'activateAbility';
      objectId: ObjectId;
      index: number;
      x?: number;
      fromGraveyard?: boolean;
      fromHand?: boolean;
      /** The announced modes of a modal activated ability (CR 602.2b, 700.2a). */
      modes?: number[];
    }
  | { kind: 'companionToHand' }
  /** Foretell (CR 702.143a): pay {2} and exile this hand card face down. */
  | { kind: 'foretell'; objectId: ObjectId }
  /**
   * Turning a face-down permanent face up (CR 116.2b): for its morph cost (CR 702.37e), or, when
   * it was manifested and is a creature card, for its mana cost (`via: 'manaCost'`, CR 701.40b).
   */
  | { kind: 'turnFaceUp'; objectId: ObjectId; via?: 'manaCost' };

/**
 * The costs a face-down permanent can be turned face up for: its morph cost (CR 702.37e) and, if
 * it was manifested and its front face is a creature card, its mana cost (CR 701.40b). An {X} in
 * that mana cost is 0 (CR 107.3); a card with no mana cost can't be turned up this way.
 */
export function turnFaceUpCosts(
  perm: EnginePermanent,
  faceUpDef: CardDefinition,
): { cost: ParsedManaCost; via?: 'manaCost' }[] {
  const ways: { cost: ParsedManaCost; via?: 'manaCost' }[] = [];
  if (faceUpDef.morphCost !== undefined) ways.push({ cost: faceUpDef.morphCost });
  if (
    perm.manifested === true &&
    faceUpDef.types.includes('Creature') &&
    faceUpDef.manaCost !== null
  )
    ways.push({ cost: faceUpDef.manaCost, via: 'manaCost' });
  return ways;
}

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

export function modeAdditionalCosts(
  def: CardDefinition,
  selectedModes: number[] | undefined,
): AbilityCost[] {
  const modes = def.spellAbility?.modes;
  if (modes === undefined || selectedModes === undefined) return [];
  const costs = selectedModes.flatMap((mode) => modes.options[mode]?.additionalCost ?? []);
  const escalate = modes.additionalCostPerChoiceBeyondFirst ?? [];
  for (let i = 1; i < selectedModes.length; i++) costs.push(...escalate);
  return costs;
}
export function selectedModeTargetSlots(
  def: CardDefinition,
  selectedModes: number[] | undefined,
): number[] | undefined {
  const modes = def.spellAbility?.modes;
  if (modes === undefined || selectedModes === undefined) return undefined;
  const chosen = selectedModes.map((index) => modes.options[index]);
  // Hand-authored legacy modes without ownership metadata retain their historical all-targets behavior.
  if (chosen.some((option) => option?.targetSlots === undefined)) return undefined;
  return [...new Set(chosen.flatMap((option) => option?.targetSlots ?? []))].sort((a, b) => a - b);
}

export function maxChoicesFor(
  ctx: GameContext,
  def: CardDefinition,
  source: SelectorSource,
): number | undefined {
  const modes = def.spellAbility?.modes;
  if (modes === undefined || modes.maxChoicesIf === undefined) return modes?.maxChoices;
  return evaluateCondition(ctx, modes.maxChoicesIf.condition, source)
    ? modes.maxChoicesIf.maxChoices
    : modes.maxChoices;
}

export function modalSelections(
  def: CardDefinition,
  maxChoices = def.spellAbility?.modes?.maxChoices,
): (number[] | undefined)[] {
  const modes = def.spellAbility?.modes;
  if (modes === undefined) return [undefined];
  if (maxChoices === undefined) return [];
  const out: number[][] = [];
  if (modes.repeatable === true) {
    const visit = (next: number, chosen: number[]): void => {
      if (chosen.length >= modes.minChoices && chosen.length <= maxChoices) out.push([...chosen]);
      if (chosen.length === maxChoices) return;
      for (let i = next; i < modes.options.length; i++) {
        chosen.push(i);
        visit(i, chosen);
        chosen.pop();
      }
    };
    visit(0, []);
    return out;
  }
  const visit = (next: number, chosen: number[]): void => {
    if (chosen.length >= modes.minChoices && chosen.length <= maxChoices) out.push([...chosen]);
    if (chosen.length === maxChoices) return;
    for (let i = next; i < modes.options.length; i++) {
      chosen.push(i);
      visit(i + 1, chosen);
      chosen.pop();
    }
  };
  visit(0, []);
  return out;
}
const COMPANION_COST: ParsedManaCost = { ...emptyCost(), generic: 3 };
/** The foretell special action's cost (CR 702.143a). */
const FORETELL_COST: ParsedManaCost = { ...emptyCost(), generic: 2 };
/** The face-down cast cost of a morph card (CR 702.37c). */
const FACE_DOWN_COST: ParsedManaCost = { ...emptyCost(), generic: 3 };

/**
 * The mana components of an activation cost, summed. Everything else (tap, sacrifice, counters)
 * is checked by `canPayNonManaCosts` — this is the half `planPayment` understands.
 */
export function manaPortionOf(costs: readonly AbilityCost[]): ParsedManaCost {
  const total = emptyCost();
  for (const cost of costs) {
    if (cost.kind !== 'mana') continue;
    total.generic += cost.cost.generic;
    total.colorless += cost.cost.colorless;
    for (const c of ['W', 'U', 'B', 'R', 'G'] as const) total.colored[c] += cost.cost.colored[c];
    if (cost.cost.x !== undefined) total.x = (total.x ?? 0) + cost.cost.x;
    if (cost.cost.hybrid !== undefined) {
      total.hybrid = [...(total.hybrid ?? []), ...cost.cost.hybrid];
    }
    if (cost.cost.phyrexian !== undefined) {
      total.phyrexian = [...(total.phyrexian ?? []), ...cost.cost.phyrexian];
    }
  }
  return total;
}

/**
 * Check the non-mana components of a spell's additional casting costs. The spell is still in its
 * source zone while options are generated, so a hand-cast spell cannot discard itself.
 */
export function canPaySpellAdditionalCosts(
  ctx: GameContext,
  player: EnginePlayerState,
  costs: readonly AbilityCost[],
  sourceCardId: string,
  _sourceInHand: boolean,
  announcedX = 0,
): boolean {
  return (
    planSpellPayment(ctx, player, {
      mana: emptyCost(),
      costs,
      sourceCardId,
      sourceOracleId: '',
      sourceIsCommander: false,
      x: announcedX,
    }) !== null
  );
}
/**
 * The engine's deterministic auto-pay plan, exposed as presentation data only. The browser may
 * highlight these sources before confirmation but cannot alter payment or invent a plan.
 */
function paymentPreview(
  ctx: GameContext,
  player: EnginePlayerState,
  cost: ParsedManaCost,
  sources: readonly ManaSource[],
  allows: ReturnType<typeof allowanceFor>,
  preparedPlan?: PaymentPlan,
): Record<string, unknown> {
  const plan =
    preparedPlan ??
    planPayment(
      cost,
      player.manaEntries,
      sources,
      allows,
      playerLifeLocked(ctx, player.id) ? 0 : player.life,
    );
  if (plan === null || plan.tapCardIds.length === 0) return {};
  const permanents = plan.tapCardIds
    .map((cardId) => ctx.state.battlefield.find((permanent) => permanent.cardId === cardId))
    .filter((permanent): permanent is EnginePermanent => permanent !== undefined);
  return {
    paymentSourceIds: permanents.map((permanent) => permanent.id),
    paymentSourceNames: permanents.map((permanent) => permanent.name),
  };
}

/**
 * Total generic-mana reduction active on a cast of `castOracleId`/`castCardId` by `casterId`
 * (Temur Battlecrier, Eminence). Lives here rather than `state/queries.ts`: it needs
 * `evaluateValueIn` (a dynamic amount reads *current* board state), and `effects/values.ts`
 * already imports `state/queries.ts`, so the reverse import would cycle.
 *
 * Both `computePriorityOptions` (the displayed/affordability cost) and `applyPriorityAction`
 * (the charged cost) must call this identically, or the engine could offer a cast it then
 * charges a different price for — the same option-menu contract `allowanceFor` protects.
 */
export interface CostReductionResult {
  generic: number;
  colored?: ParsedManaCost;
}

export function costReductionFor(
  ctx: GameContext,
  casterId: PlayerId,
  castOracleId: OracleId,
  castCardId: string,
  spellDefinition?: CardDefinition,
): CostReductionResult {
  const def = spellDefinition ?? getDefByOracleId(ctx, castOracleId, castOracleId);
  const candidate: SelectorCandidate = {
    cardId: castCardId,
    controllerId: casterId,
    types: offBattlefieldTypes(ctx, def.types, casterId),
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
    isToken: false,
    enteredThisTurn: false,
  };
  const source: SelectorSource = { cardId: castCardId, controllerId: casterId };

  let generic = 0;
  let colored: ParsedManaCost | undefined;

  const ownReductions = def.ruleStatics
    .filter(
      (rule): rule is Extract<(typeof def.ruleStatics)[number], { kind: 'costReduction' }> =>
        rule.kind === 'costReduction' && rule.selfOnly === true,
    )
    .map((rule) => ({
      static: rule,
      sourceCardId: castCardId,
      sourceOracleId: castOracleId,
      controllerId: casterId,
    }));

  for (const entry of [...gatherRuleStatics(ctx), ...ownReductions]) {
    if (entry.static.kind !== 'costReduction') continue;
    if ((entry.static.appliesTo ?? 'cast') !== 'cast') continue;
    // Target-dependent reductions are priced once targets are known: `targetedCostReductionFor`.
    if (entry.static.targetFilter !== undefined) continue;
    if (entry.controllerId !== casterId) continue;
    if (entry.static.yourTurnOnly === true && ctx.state.currentTurnPlayer !== casterId) continue;
    if (entry.static.excludesSelf === true && entry.sourceCardId === castCardId) continue;
    // "This spell costs {3} less to cast if you control a creature with power 4 or greater"
    // (Bolt Bend): checked as the total cost is determined (CR 601.2f).
    if (
      entry.static.condition !== undefined &&
      !evaluateCondition(ctx, entry.static.condition, {
        cardId: entry.sourceCardId,
        controllerId: entry.controllerId,
      })
    )
      continue;
    if (entry.static.filter !== undefined) {
      // "Spells you cast of the CHOSEN type cost {1} less" (Cloud Key): the filter reads
      // the reduction's own SOURCE's chosen option, not the spell being cast — so `source`
      // (which stands in for the spell here) needs that source's choice threaded in per entry.
      const ruleSourcePerm = ctx.state.battlefield.find((p) => p.cardId === entry.sourceCardId);
      const entrySource: SelectorSource =
        ruleSourcePerm?.chosenOption !== undefined
          ? { ...source, chosenOption: ruleSourcePerm.chosenOption }
          : source;
      if (!selectMatches(candidate, entry.static.filter, entrySource)) continue;
    }
    generic += Math.max(
      0,
      evaluateValueIn(ctx, entry.static.amount, {
        controllerId: entry.controllerId,
        sourceCardId: entry.sourceCardId,
      }),
    );
    if (entry.static.coloredAmount !== undefined) {
      if (colored === undefined) {
        colored = {
          ...entry.static.coloredAmount,
          colored: { ...entry.static.coloredAmount.colored },
        };
      } else {
        for (const c of ALL_COLORS) {
          colored.colored[c] =
            (colored.colored[c] ?? 0) + (entry.static.coloredAmount.colored[c] ?? 0);
        }
      }
    }
  }
  return { generic, ...(colored !== undefined ? { colored } : {}) };
}

/** An active "spells you cast that target a <filter> cost {N} less" reduction (Killian). */
export interface TargetedCostReduction {
  generic: number;
  targetFilter: Selector;
  source: SelectorSource;
}

/**
 * The target-dependent cast reductions active for `casterId` (Killian, Ink Duelist). Each one
 * applies when at least one chosen target matches its filter (CR 601.2f prices the spell after
 * targets are chosen in 601.2c).
 */
export function targetedCostReductionFor(
  ctx: GameContext,
  casterId: PlayerId,
): TargetedCostReduction[] {
  const result: TargetedCostReduction[] = [];
  for (const entry of gatherRuleStatics(ctx)) {
    if (entry.static.kind !== 'costReduction') continue;
    if (entry.static.targetFilter === undefined) continue;
    if ((entry.static.appliesTo ?? 'cast') !== 'cast') continue;
    if (entry.controllerId !== casterId) continue;
    if (entry.static.yourTurnOnly === true && ctx.state.currentTurnPlayer !== casterId) continue;
    const source: SelectorSource = { cardId: entry.sourceCardId, controllerId: entry.controllerId };
    result.push({
      generic: Math.max(
        0,
        evaluateValueIn(ctx, entry.static.amount, {
          controllerId: entry.controllerId,
          sourceCardId: entry.sourceCardId,
        }),
      ),
      targetFilter: entry.static.targetFilter,
      source,
    });
  }
  return result;
}

/** Does the chosen target `id` match a targeted reduction's filter? Only permanents can. */
export function targetMatchesReduction(
  ctx: GameContext,
  id: ObjectId,
  reduction: TargetedCostReduction,
): boolean {
  const perm = ctx.state.battlefield.find((candidate) => candidate.id === id);
  return perm !== undefined && matchesSelector(ctx, perm, reduction.targetFilter, reduction.source);
}

/** The generic mana the chosen targets take off a spell's cost (Killian). */
export function targetedReductionAmount(
  ctx: GameContext,
  reductions: readonly TargetedCostReduction[],
  targetIds: readonly ObjectId[],
): number {
  return reductions
    .filter((reduction) => targetIds.some((id) => targetMatchesReduction(ctx, id, reduction)))
    .reduce((sum, reduction) => sum + reduction.generic, 0);
}

/**
 * Like `costReductionFor`, but for ACTIVATING an ability — "Boast abilities you activate cost
 * {1} less to activate for each Dragon you control" (Dragonkin Berserker). Matched against the
 * ACTIVATED ABILITY'S SOURCE permanent's characteristics, not a spell's.
 */
/**
 * The mana an ability activated FROM HAND actually costs.
 *
 * `activationCostReductionFor` reads `gatherRuleStatics`, which only sees the battlefield and the
 * command zone — a card in hand contributes nothing to it. So a channel land's own
 * "This ability costs {1} less to activate for each legendary creature you control" would never
 * apply, and the ability would be offered at full price. This is the hand-side twin of
 * `costReductionFor`'s `ownReductions`: the card's OWN `selfOnly` activation reductions, read
 * straight off its definition.
 */
export function handActivationCost(
  ctx: GameContext,
  def: CardDefinition,
  costs: readonly AbilityCost[],
  playerId: PlayerId,
  cardId: string,
): ParsedManaCost {
  const base = manaPortionOf(costs);
  let reduction = 0;
  for (const rule of def.ruleStatics) {
    if (rule.kind !== 'costReduction') continue;
    if (rule.appliesTo !== 'activate' || rule.selfOnly !== true) continue;
    reduction += evaluateValueIn(ctx, rule.amount, {
      controllerId: playerId,
      sourceCardId: cardId,
    });
  }
  // CR 601.2f — a reduction can never take a cost below zero, which `subtractGeneric` enforces.
  return reduction > 0 ? subtractGeneric(base, reduction) : base;
}

export function activationCostReductionFor(
  ctx: GameContext,
  controllerId: PlayerId,
  sourceOracleId: OracleId,
  sourceCardId: string,
  /** The ability being activated, for reductions that name a kind of ability (Boast). */
  ability?: ActivatedAbility,
): CostReductionResult {
  const def = getDefByOracleId(ctx, sourceOracleId, sourceOracleId);
  const candidate: SelectorCandidate = {
    cardId: sourceCardId,
    controllerId,
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
    isToken: false,
    enteredThisTurn: false,
  };
  const source: SelectorSource = { cardId: sourceCardId, controllerId };

  let generic = 0;
  for (const entry of gatherRuleStatics(ctx)) {
    if (entry.static.kind !== 'costReduction' || entry.static.appliesTo !== 'activate') continue;
    if (entry.controllerId !== controllerId) continue;
    // Graveyard-zone reductions are priced by `graveyardActivationCost`.
    if (entry.static.graveyardAbilities === true) continue;
    if (entry.static.boastOnly === true && ability?.boast !== true) continue;
    if (entry.static.filter !== undefined) {
      // The same per-entry re-source the CAST side does above: a "of the chosen type" filter
      // reads the REDUCTION SOURCE's own recorded choice, not the ability's source. Without
      // this, any chosen-type activation discount silently never matches — the cast side was
      // fixed for Cloud Key and this twin was not.
      const ruleSourcePerm = ctx.state.battlefield.find((p) => p.cardId === entry.sourceCardId);
      const entrySource: SelectorSource =
        ruleSourcePerm?.chosenOption !== undefined
          ? { ...source, chosenOption: ruleSourcePerm.chosenOption }
          : source;
      if (!selectMatches(candidate, entry.static.filter, entrySource)) continue;
    }
    generic += evaluateValueIn(ctx, entry.static.amount, {
      controllerId: entry.controllerId,
      sourceCardId: entry.sourceCardId,
    });
  }
  return { generic };
}

/**
 * The mana an activated ability of a card in `controllerId`'s graveyard costs after
 * "activated abilities of cards in your graveyard cost {2} less" (Convergence of Dominion). A
 * reduction never takes a cost with mana below its floor ("can't reduce the mana ... to less
 * than one mana"), and never adds mana to a cost that had none. Both `computePriorityOptions` and
 * `applyPriorityAction` price graveyard activations through this.
 */
export function graveyardActivationCost(
  ctx: GameContext,
  controllerId: PlayerId,
  cost: ParsedManaCost,
): ParsedManaCost {
  let reduced = cost;
  for (const entry of gatherRuleStatics(ctx)) {
    const rule = entry.static;
    if (rule.kind !== 'costReduction' || rule.graveyardAbilities !== true) continue;
    if (entry.controllerId !== controllerId) continue;
    const source = { cardId: entry.sourceCardId, controllerId: entry.controllerId };
    if (rule.condition !== undefined && !evaluateCondition(ctx, rule.condition, source)) continue;
    const amount = Math.max(
      0,
      evaluateValueIn(ctx, rule.amount, {
        controllerId: entry.controllerId,
        sourceCardId: entry.sourceCardId,
      }),
    );
    const floor = rule.minimumMana ?? 0;
    const room = Math.max(0, totalPips(reduced) - floor);
    reduced = subtractGeneric(reduced, Math.min(amount, room));
  }
  return reduced;
}

/** Compatibility API; domain generation and rechecking now share targetIsLegal. */
export function computeTargetOptions(
  ctx: GameContext,
  spec: TargetKind | TargetSpec,
  casterId: PlayerId,
  source?: TargetingSource,
  eventPlayerId?: PlayerId,
  chosenTargets?: readonly ObjectId[],
  sourceCardId = '',
  targeting = true,
  sourceFacts?: ObjectFacts,
): ObjectId[] {
  return targetCandidates(ctx, spec, {
    controllerId: casterId,
    sourceCardId,
    targeting,
    ...(sourceFacts === undefined ? {} : { sourceFacts }),
    ...targetingSourceFields(source),
    ...(eventPlayerId === undefined ? {} : { eventPlayerId }),
    ...(chosenTargets === undefined ? {} : { chosenTargets }),
  });
}

/** Life owed by an opposing spell for targeting permanents with a target-life-tax static. */
export function targetLifeTaxFor(
  ctx: GameContext,
  casterId: PlayerId,
  targets: readonly ObjectId[],
): number {
  const targetSet = new Set(targets);
  return gatherRuleStatics(ctx).reduce((total, entry) => {
    if (entry.static.kind !== 'targetLifeTax' || entry.controllerId === casterId) return total;
    const permanent = ctx.state.battlefield.find(
      (candidate) => candidate.cardId === entry.sourceCardId,
    );
    if (
      permanent === undefined ||
      (!targetSet.has(permanent.id) && !targetSet.has(permanent.cardId as ObjectId))
    ) {
      return total;
    }
    return total + entry.static.amount;
  }, 0);
}

/**
 * All legal actions for `player` at a priority window (brief §5.4). Pass is always legal
 * and always option 0 — auto-pass when it is the only option (brief §7.4).
 */
export function computePriorityOptions(
  ctx: GameContext,
  player: EnginePlayerState,
): EngineActionOption[] {
  const s = ctx.state;
  const options: EngineActionOption[] = [
    { type: 'pass', description: 'Pass priority', payload: { kind: 'pass' } },
    {
      type: 'passAndYieldTurn',
      description: 'Pass and yield until end of turn',
      payload: { kind: 'passAndYieldTurn' },
    },
  ];

  if (s.stack.length > 0) {
    const top = s.stack[s.stack.length - 1];
    if (
      top !== undefined &&
      top.kind === 'triggeredAbility' &&
      !player.yieldedAbilities?.includes(top.sourceOracleId)
    ) {
      const sourceName = top.card?.name ?? top.description;
      options.push({
        type: 'yieldToAbility',
        description: `Yield to this ability (${sourceName})`,
        payload: { kind: 'yieldToAbility', sourceOracleId: top.sourceOracleId },
        data: { sourceOracleId: top.sourceOracleId },
      });
    }
  }

  const isActive = s.turnOrder[s.activePlayerIndex] === player.id;
  const sorcerySpeed =
    isActive &&
    s.stack.length === 0 &&
    (s.phase === 'precombatMain' || s.phase === 'postcombatMain');

  const sources = manaSourcesFor(ctx, player.id);
  const baseCastSources = sources;
  const landPlayLimit = landPlayLimitFor(ctx, player.id);

  // "Your opponents can't cast spells during your turn" (Dragonlord Dromoka) — computed once;
  // it blocks every nonland cast source uniformly and never blocks playing a land (CR 305 —
  // a land is played, not cast).
  const spellCastingBlocked = castingSpellsBlockedFor(ctx, player.id);

  const considerCast = (
    obj: EngineCardObject,
    fromCommand: boolean,
    fromLibraryTop = false,
    fromExile = false,
    fromGraveyard = false,
    plotCast = false,
  ): void => {
    if (fromCommand && !mayCastCommanderFromCommand(player, obj)) return;
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
    let paymentCtx = ctx;
    let paymentPlayer = player;
    let paymentSources = sources;
    let paymentDefinition = def;
    const jointPayment = (
      mana: ParsedManaCost,
      costs: readonly AbilityCost[],
      x = 0,
      targetLifeTax = 0,
      energyAlternativeCost = 0,
    ) =>
      planSpellPayment(paymentCtx, paymentPlayer, {
        mana:
          fromExile && obj.playableUntilEotBy === player.id && obj.spendAsAnyColorUntilEot === true
            ? { ...mana, spendAsAnyColor: true }
            : mana,
        costs,
        sourceCardId: obj.cardId,
        sourceOracleId: obj.oracleId,
        sourceIsCommander: obj.isCommander,
        spellDefinition: paymentDefinition,
        sources: paymentSources,
        x,
        targetLifeTax,
        energyAlternativeCost,
      });
    const jointlyPayable = (...args: Parameters<typeof jointPayment>): boolean =>
      jointPayment(...args) !== null;
    requireModeled(
      def,
      fromLibraryTop
        ? 'on top of your library'
        : fromGraveyard
          ? 'in your graveyard'
          : fromCommand
            ? 'in the command zone'
            : fromExile
              ? 'in exile'
              : 'in hand',
    );

    if (def.types.includes('Land')) {
      if (fromExile && obj.castOnlyUntilEot === true) return;
      const permission =
        fromLibraryTop || fromGraveyard
          ? playFromZonePermission(ctx, player.id, obj, fromGraveyard ? 'graveyard' : 'libraryTop')
          : {};
      if (permission === null) return;
      // Lands are played, not cast -- one per turn plus active additional-land statics.
      if (sorcerySpeed && player.landsPlayedThisTurn < landPlayLimit) {
        const producesMana = previewLandManaSymbols(ctx, def, player.id);
        const baseData: Record<string, unknown> = {
          producesMana,
          sourceName: obj.name,
          sourceZone: fromLibraryTop
            ? 'library'
            : fromGraveyard
              ? 'graveyard'
              : fromExile
                ? 'exile'
                : 'hand',
        };
        if (def.entersTappedUnless !== undefined) {
          if (def.entersTappedUnless.kind === 'mayPayLife') {
            baseData['payLifeToUntap'] = def.entersTappedUnless.n;
          } else {
            baseData['entersTappedConditional'] = true;
          }
        } else {
          baseData['entersTapped'] = def.entersTapped;
        }
        for (const budgetType of permission.budgetTypes ?? [undefined]) {
          options.push({
            type: 'playLand',
            description:
              `Play ${obj.name}` +
              (budgetType === undefined ? '' : ` (using ${budgetType} permission)`),
            payload: {
              kind: 'playLand',
              objectId: obj.id,
              ...(fromLibraryTop ? { fromLibraryTop: true } : {}),
              ...(fromGraveyard ? { fromGraveyard: true } : {}),
              // "Exile the top three cards of your library. You may play them this turn"
              // (Jeska's Will) — a LAND among them is played, not cast, so it reaches this
              // branch. Without the flag `applyPriorityAction` looks for it in hand and throws.
              ...(fromExile ? { fromExile: true } : {}),
              ...(budgetType !== undefined ? { zoneBudgetType: budgetType } : {}),
            },
            data: {
              ...baseData,
              ...(budgetType !== undefined ? { zoneBudgetType: budgetType } : {}),
            },
          });
        }
      }
      if (!def.alternativeCasts?.some((alt) => alt.kind === 'adventure' || alt.kind === 'omen'))
        return;
    }

    const mdfcIndex =
      def.alternativeCasts?.findIndex((alt) => alt.kind === 'mdfc' && alt.landFace !== undefined) ??
      -1;
    const mdfc = mdfcIndex >= 0 ? def.alternativeCasts?.[mdfcIndex] : undefined;
    if (
      mdfc?.landFace !== undefined &&
      !fromCommand &&
      !fromLibraryTop &&
      !fromExile &&
      !fromGraveyard &&
      sorcerySpeed &&
      player.landsPlayedThisTurn < landPlayLimit
    ) {
      const face = mdfc.landFace;
      const data: Record<string, unknown> = {
        producesMana: previewManaAbilities(
          ctx,
          face.manaAbilities,
          player.id,
          `preview-${obj.oracleId}-mdfc`,
        ),
        sourceName: face.name,
        sourceZone: 'hand',
        castVariant: 'mdfc',
      };
      if (face.entersTappedUnless?.kind === 'mayPayLife')
        data['payLifeToUntap'] = face.entersTappedUnless.n;
      else if (face.entersTappedUnless !== undefined) data['entersTappedConditional'] = true;
      else data['entersTapped'] = face.entersTapped;
      options.push({
        type: 'playLand',
        description: `Play ${face.name}`,
        payload: {
          kind: 'playLand',
          objectId: obj.id,
          alternativeCast: 'mdfc',
          altIndex: mdfcIndex,
        },
        data,
      });
    }

    const normalOptionsStart = options.length;
    if (spellCastingBlocked) return;
    // Morph (CR 702.37c): cast this card from hand face down as a 2/2 creature spell for {3}.
    // The face-down spell has no abilities (CR 708.4), so it is cast at sorcery speed, and only
    // reductions that apply to a vanilla colorless creature spell apply to it.
    if (
      def.morphCost !== undefined &&
      sorcerySpeed &&
      !fromCommand &&
      !fromLibraryTop &&
      !fromExile &&
      !fromGraveyard
    ) {
      const faceDownId = faceDownSpellOracleId(ctx);
      const faceDownReduction = costReductionFor(ctx, player.id, faceDownId, obj.cardId);
      const cost = subtractGeneric(
        faceDownReduction.colored === undefined
          ? FACE_DOWN_COST
          : subtractColored(FACE_DOWN_COST, faceDownReduction.colored),
        faceDownReduction.generic,
      );
      const faceDownAllows = allowanceFor(ctx, player.id, {
        kind: 'castSpell',
        oracleId: faceDownId,
        isCommander: false,
      });
      if (
        canPay(
          cost,
          player.manaEntries,
          baseCastSources,
          faceDownAllows,
          playerLifeLocked(ctx, player.id) ? 0 : player.life,
        )
      ) {
        options.push({
          type: 'castSpell',
          description: `Cast ${obj.name} face down for ${describeManaCost(cost)}`,
          payload: {
            kind: 'castSpell',
            objectId: obj.id,
            fromCommand: false,
            alternativeCast: 'faceDown',
          },
          data: {
            instantSpeed: false,
            sourceName: obj.name,
            sourceZone: 'hand',
            manaCost: describeManaCost(cost),
            ...paymentPreview(ctx, player, cost, baseCastSources, faceDownAllows),
            castVariant: 'faceDown',
            // What other players may learn of this action (CR 708.5): `formatPlayerLog`.
            publicDescription: `Cast a face-down creature spell for ${describeManaCost(cost)}`,
          },
        });
      }
    }
    const instantSpeed = def.types.includes('Instant') || def.keywords.includes('flash');
    // "Cast this spell only during an opponent's turn": a restriction on casting it at all, in
    // every way it can be cast (enforced again as it is cast, `casting/cast.ts`).
    if (
      def.castRestriction !== undefined &&
      !evaluateCondition(ctx, def.castRestriction, { cardId: obj.cardId, controllerId: player.id })
    )
      return;

    const tax = fromCommand ? 2 * (player.commanderCastCount[obj.cardId] ?? 0) : 0;
    const reboundCast = fromExile && obj.reboundCastBy === player.id;
    // A foretold card is cast on a later turn for the foretell cost it was exiled with
    // (CR 702.143a), never for its mana cost or another alternative cost.
    const foretold =
      fromExile && obj.ownerId === player.id && obj.foretold !== undefined ? obj.foretold : null;
    const spellAdditionalCosts = [
      ...(def.spellAdditionalCosts ?? []),
      // The card's own graveyard permission carries its extra cost (Dragon Man).
      ...(fromGraveyard && def.castFromGraveyard === true
        ? (def.castFromGraveyardCosts ?? [])
        : []),
    ];
    if (
      fromGraveyard &&
      def.castFromGraveyard !== true &&
      !(def.alternativeCasts?.some((alt) => alt.from === 'graveyard') ?? false) &&
      !canPlayFromZone(ctx, player.id, obj, 'graveyard')
    )
      return;
    const castCtx = castingPreviewContext(ctx, obj, player.id);
    const castPlayer = castCtx.state.players.find((entry) => entry.id === player.id)!;
    // Convoke (CR 702.51): untapped creatures help pay for this spell, in every way it is cast.
    const castSources = spellHasConvoke(def)
      ? [...manaSourcesFor(castCtx, player.id), ...convokeSourcesFor(castCtx, player.id)]
      : manaSourcesFor(castCtx, player.id);
    paymentCtx = castCtx;
    paymentPlayer = castPlayer;
    paymentSources = castSources;

    // One configuration/target/payment loop for each permitted mana-cost alternative.
    // Alternative costs replace only the printed mana cost, never modes or additional costs.
    const offerCast = (
      baseCost: ParsedManaCost,
      spellAdditionalCosts: readonly AbilityCost[],
      castingDef: CardDefinition = def,
      variant: Partial<Extract<PriorityActionPayload, { kind: 'castSpell' }>> = {},
      variantLabel = '',
      energyCost = 0,
      familyInstantSpeed = instantSpeed,
      castName = obj.name,
    ): void => {
      if ((plotCast || !familyInstantSpeed) && !sorcerySpeed) return;
      if (
        plotCast &&
        variant.alternativeCast !== undefined &&
        !['adventure', 'omen', 'mdfc'].includes(variant.alternativeCast)
      )
        return;
      if (plotCast) baseCost = emptyCost();
      if (castingSpellsBlockedFor(ctx, player.id, castingDef)) return;
      const castCtx = castingPreviewContext(ctx, obj, player.id, castingDef);
      paymentCtx = castCtx;
      paymentPlayer = castCtx.state.players.find((p) => p.id === player.id)!;
      paymentDefinition = castingDef;
      const castSources = spellHasConvoke(castingDef)
        ? [...manaSourcesFor(castCtx, player.id), ...convokeSourcesFor(castCtx, player.id)]
        : manaSourcesFor(castCtx, player.id);
      paymentSources = castSources;
      const reduction = costReductionFor(castCtx, player.id, obj.oracleId, obj.cardId, castingDef);

      const additionalManaCost = manaPortionOf(spellAdditionalCosts);
      const unreduced = addGeneric(
        baseCost,
        tax + nonHandSpellCostIncreaseFor(castCtx, player.id, obj.zone),
      );
      // CR 601.2f: reductions apply to the TOTAL cost — the mana cost with {X} given a value, plus
      // every additional cost (kicker, mode costs) — so a reduction can pay for X's share or a
      // kicker's, not just for whatever generic mana the printed cost happens to have.
      const reduce = (c: ParsedManaCost): ParsedManaCost => {
        const colored = reduction.colored === undefined ? c : subtractColored(c, reduction.colored);
        return subtractGeneric(colored, reduction.generic);
      };
      const costWithX = (x: number): ParsedManaCost => withX(unreduced, x);
      // "Spells you cast that target a creature cost {2} less" (Killian): the price depends on
      // the targets, so affordability pre-checks use the best case and each option is priced
      // exactly below, per target variant.
      const targeted =
        (castingDef.spellAbility?.targets.length ?? 0) > 0
          ? targetedCostReductionFor(castCtx, player.id)
          : [];
      const bestTargeted = targeted.reduce((sum, entry) => sum + entry.generic, 0);
      const reduceBest = (c: ParsedManaCost): ParsedManaCost =>
        subtractGeneric(reduce(c), bestTargeted);

      // {X} is announced as part of casting (CR 601.2b), so each affordable value of X is its own
      // option. Enumerated rather than asked as a follow-up decision because the option menu is
      // the contract: an action offered here must be applicable with no further legality check.
      // Restricted mana ("spend only to cast a Dragon spell") may or may not pay for THIS card,
      // so affordability is asked with the purpose attached — see `mana/cost.ts::ManaAllowance`.
      const allows = allowanceFor(castCtx, castPlayer.id, {
        kind: 'castSpell',
        oracleId: obj.oracleId,
        isCommander: obj.isCommander,
        spellDefinition: castingDef,
      });

      const xSymbols = baseCost.x ?? 0;
      const announcesAdditionalX = castingDef.announcesX === true;
      const xChoices: number[] = [];
      if (xSymbols === 0 && !announcesAdditionalX) xChoices.push(0);
      else if (announcesAdditionalX) {
        const maximumChoices = 1024;
        if (!supportsAdditionalXAnnouncement(castingDef))
          throw new UnmodeledCardError(
            castName,
            ['additional X requires a direct pay-X-life cost'],
            'enumerating additional X',
          );
        // CR 601.2g-h: mana abilities can gain life before the announced life payment.
        // The joint witness, rather than the starting life total, bounds payable X.
        for (let x = 0; ; x++) {
          if (
            !jointlyPayable(
              reduce(addManaCosts(costWithX(x), additionalManaCost)),
              spellAdditionalCosts,
              x,
              0,
              energyCost,
            )
          )
            break;
          if (xChoices.length >= maximumChoices)
            throw new UnmodeledCardError(
              castName,
              ['additional life X choice budget exceeded'],
              'enumerating additional X',
            );
          xChoices.push(x);
        }
      } else {
        for (let x = 0; ; x++) {
          if (
            !jointlyPayable(
              reduceBest(addManaCosts(costWithX(x), additionalManaCost)),
              spellAdditionalCosts,
              x,
              0,
              energyCost,
            )
          )
            break;
          xChoices.push(x);
        }
        if (xChoices.length === 0) return;
      }

      // A modal spell (CR 700.2) is announced with its mode chosen at cast time, before targets —
      // so each mode is its own cast option, the same "the option menu is the contract" treatment
      // {X} gets above. A non-modal spell has exactly one "mode" (undefined), so this loop is a
      // single iteration when `modes` is absent.
      const selections = modalSelections(
        castingDef,
        maxChoicesFor(castCtx, castingDef, { cardId: obj.cardId, controllerId: castPlayer.id }),
      );

      for (const x of xChoices) {
        const cost = costWithX(x);
        if (!jointlyPayable(reduceBest(cost), [], x, 0, energyCost)) continue;

        for (const selectedModes of selections) {
          const modeCosts = modeAdditionalCosts(castingDef, selectedModes);
          const optional = castingDef.optionalAdditionalCost;
          const optionalCounts: number[] = [0];
          if (optional !== undefined) {
            const max = optional.repeatable === true ? 100 : 1;
            for (let count = 1; count <= max; count++) {
              let prospective = addManaCosts(
                cost,
                manaPortionOf([...spellAdditionalCosts, ...modeCosts]),
              );
              for (let i = 0; i < count; i++)
                prospective = addManaCosts(prospective, optional.cost);
              if (
                !jointlyPayable(
                  reduceBest(prospective),
                  [...spellAdditionalCosts, ...modeCosts],
                  x,
                  0,
                  energyCost,
                )
              )
                break;
              optionalCounts.push(count);
            }
          }
          const modeLabel =
            selectedModes === undefined
              ? undefined
              : selectedModes
                  .map(
                    (mode) =>
                      castingDef.spellAbility?.modes?.options[mode]?.description ??
                      `mode ${mode + 1}`,
                  )
                  .join('; ');
          for (const optionalCostCount of optionalCounts) {
            const optionalCosts: AbilityCost[] = [];
            if (optional !== undefined) {
              for (let i = 0; i < optionalCostCount; i++) {
                optionalCosts.push({ kind: 'mana', cost: optional.cost });
              }
            }
            const additionalCosts = [...spellAdditionalCosts, ...modeCosts, ...optionalCosts];
            const fullCost = reduce(addManaCosts(cost, manaPortionOf(additionalCosts)));
            const taxesTargets = gatherRuleStatics(castCtx).some(
              (entry) =>
                entry.static.kind === 'targetLifeTax' && entry.controllerId !== castPlayer.id,
            );
            const menusAt = (price: ParsedManaCost, discount: number, requiredSlot?: number) =>
              legalTargetMenus(
                castCtx,
                castingDef.spellAbility ?? { kind: 'spell', targets: [], effects: [] },
                {
                  controllerId: castPlayer.id,
                  sourceCardId: obj.cardId,
                  ...targetingSourceFields(targetingFromDefinition(castingDef, 'spell')),
                  x,
                },
                selectedModeTargetSlots(castingDef, selectedModes),
                (ordinary, counted) => {
                  const all = [...ordinary, ...Object.values(counted).flat()];
                  if (targetedReductionAmount(castCtx, targeted, all) !== discount) return false;
                  if (
                    requiredSlot !== undefined &&
                    requiredSlot >= 0 &&
                    ![ordinary[requiredSlot], ...(counted[requiredSlot] ?? [])].some(
                      (id) =>
                        id !== undefined &&
                        targeted.every((entry) => targetMatchesReduction(castCtx, id, entry)),
                    )
                  )
                    return false;
                  return (
                    !taxesTargets ||
                    jointlyPayable(
                      price,
                      additionalCosts,
                      x,
                      targetLifeTaxFor(castCtx, castPlayer.id, all),
                      energyCost,
                    )
                  );
                },
              );
            // Lock the target-dependent price across ordinary AND counted target slots.
            const priced: {
              slot: number | undefined;
              discount: number;
              selectionCost: ParsedManaCost;
              payment: NonNullable<ReturnType<typeof jointPayment>>;
              payableTargets: TargetMenu[];
            }[] = [];
            const reducedCost = subtractGeneric(fullCost, bestTargeted);
            const activeSlots = selectedModeTargetSlots(castingDef, selectedModes);
            const variants =
              targeted.length === 0
                ? [{ slot: undefined, discount: 0, selectionCost: fullCost }]
                : [
                    { slot: -1, discount: 0, selectionCost: fullCost },
                    ...(castingDef.spellAbility?.targets ?? []).flatMap((_spec, slot) =>
                      activeSlots !== undefined && !activeSlots.includes(slot)
                        ? []
                        : [{ slot, discount: bestTargeted, selectionCost: reducedCost }],
                    ),
                  ];
            for (const { slot, discount, selectionCost } of variants) {
              const payment = jointPayment(selectionCost, additionalCosts, x, 0, energyCost);
              if (payment === null) continue;
              for (const menu of menusAt(selectionCost, discount, slot)) {
                priced.push({
                  slot,
                  discount,
                  selectionCost,
                  payment,
                  payableTargets: menu,
                });
              }
            }
            for (const {
              slot: reductionSlot,
              discount,
              selectionCost,
              payment,
              payableTargets,
            } of priced) {
              const optionalLabel =
                optional !== undefined && optionalCostCount > 0
                  ? ` — ${optional.mechanic} ${optionalCostCount}`
                  : '';
              const option: EngineActionOption = {
                type: 'castSpell',
                description:
                  `Cast ${castName} (${describeManaCost(selectionCost)})${variantLabel}` +
                  (xSymbols > 0 || announcesAdditionalX ? ` with X=${x}` : '') +
                  (modeLabel !== undefined ? ` — ${modeLabel}` : '') +
                  optionalLabel +
                  (fromCommand
                    ? ` from the command zone${tax > 0 ? `, commander tax {${tax}}` : ''}`
                    : '') +
                  (fromLibraryTop ? ' from the top of your library' : '') +
                  (fromExile ? (foretold !== null ? ' (foretold)' : ' from exile') : '') +
                  (fromGraveyard ? ' from your graveyard' : '') +
                  (reboundCast ? ' without paying its mana cost' : '') +
                  (reductionSlot !== undefined && reductionSlot >= 0
                    ? ` — reduced for target slot ${reductionSlot + 1}`
                    : ''),
                payload: {
                  kind: 'castSpell',
                  objectId: obj.id,
                  fromCommand,
                  ...variant,
                  ...(plotCast ? { plotCast: true } : {}),
                  ...(fromLibraryTop ? { fromLibraryTop: true } : {}),
                  ...(fromGraveyard ? { fromGraveyard: true } : {}),
                  ...(fromExile
                    ? { fromExile: true, ...(reboundCast ? { reboundCast: true } : {}) }
                    : {}),
                  ...(xSymbols > 0 || announcesAdditionalX ? { x } : {}),
                  ...(selectedModes !== undefined
                    ? {
                        modes: selectedModes,
                        ...(selectedModes.length === 1 ? { mode: selectedModes[0] } : {}),
                      }
                    : {}),
                  ...(optionalCostCount > 0 ? { optionalCostCount } : {}),
                  ...(reductionSlot !== undefined ? { targetReductionSlot: reductionSlot } : {}),
                  ...(targeted.length > 0 ? { targetReductionAmount: discount } : {}),
                },
                data: {
                  instantSpeed: plotCast ? false : familyInstantSpeed,
                  ...(reductionSlot !== undefined && reductionSlot >= 0
                    ? { targetReductionSlot: reductionSlot }
                    : {}),
                  ...(variant.alternativeCast === undefined
                    ? {}
                    : { castVariant: variant.alternativeCast }),
                  ...(energyCost > 0 ? { energyCost } : {}),
                  sourceName: obj.name,
                  sourceZone: fromCommand
                    ? 'command'
                    : fromLibraryTop
                      ? 'library'
                      : fromGraveyard
                        ? 'graveyard'
                        : fromExile
                          ? 'exile'
                          : 'hand',
                  manaCost:
                    variant.alternativeCast !== undefined && totalPips(selectionCost) === 0
                      ? 'free'
                      : describeManaCost(selectionCost),
                  ...paymentPreview(
                    castCtx,
                    castPlayer,
                    selectionCost,
                    castSources,
                    allows,
                    payment.manaPlan,
                  ),
                  ...(tax > 0 ? { commanderTax: tax } : {}),
                  ...(xSymbols > 0 || announcesAdditionalX ? { x } : {}),
                  ...(modeLabel !== undefined ? { modeLabel } : {}),
                  ...(optionalCostCount > 0
                    ? { optionalCostCount, optionalMechanic: optional?.mechanic }
                    : {}),
                  ...(additionalCosts.length > 0 ? { abilityCosts: additionalCosts } : {}),
                },
              };
              if (payableTargets.length > 0) option.targets = payableTargets;
              options.push(option);
            }
          }
        }
      }
    };
    if (def.manaCost !== null || plotCast)
      offerCast(
        plotCast || reboundCast ? emptyCost() : foretold !== null ? foretold.cost : def.manaCost!,
        spellAdditionalCosts,
      );
    const energyAlternativeCost = castCtx.state.battlefield
      .filter((perm) => perm.controllerId === castPlayer.id)
      .map((perm) => getDefByOracleId(castCtx, perm.oracleId, perm.name).energyAlternativeCost)
      .find((amount): amount is number => amount !== undefined);
    if (
      def.types.some((type) =>
        ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Planeswalker'].includes(type),
      ) &&
      energyAlternativeCost !== undefined &&
      !fromExile &&
      !fromGraveyard
    ) {
      offerCast(
        emptyCost(),
        spellAdditionalCosts,
        def,
        { alternativeCast: 'energy' },
        ` by paying ${energyAlternativeCost} energy`,
        energyAlternativeCost,
      );
    }
    if (
      def.commanderFreeCast === true &&
      !fromCommand &&
      !fromGraveyard &&
      // Its payload is hand-only; a foretold card is cast only for its foretell cost.
      !fromExile &&
      !fromLibraryTop &&
      castCtx.state.battlefield.some(
        (perm) => perm.controllerId === castPlayer.id && perm.isCommander,
      )
    ) {
      offerCast(
        emptyCost(),
        spellAdditionalCosts,
        def,
        { alternativeCast: 'commanderFree' },
        ' without paying its mana cost (you control a commander)',
      );
    }
    // A card's own "you may cast this card from your graveyard" needs no outside permission and
    // spends no budget of one.
    if ((fromGraveyard && def.castFromGraveyard !== true) || fromLibraryTop) {
      const permission = playFromZonePermission(
        ctx,
        player.id,
        obj,
        fromGraveyard ? 'graveyard' : 'libraryTop',
      );
      const separatelyCastableFromTop =
        fromLibraryTop &&
        castFromLibraryTopCandidates(ctx, player.id).some((card) => card.id === obj.id);
      /** Keep the options generated from `start` only under `permission`, one per budget type. */
      const applyZonePermission = (
        start: number,
        zonePermission: { budgetTypes?: string[] } | null,
        separatelyCastable: boolean,
      ): void => {
        if (zonePermission === null && !separatelyCastable) {
          options.splice(start);
        } else if (zonePermission?.budgetTypes !== undefined) {
          const generated = options.splice(start);
          for (const budgetType of zonePermission.budgetTypes) {
            for (const option of generated) {
              const castPayload = option.payload as Extract<
                PriorityActionPayload,
                { kind: 'castSpell' }
              >;
              options.push({
                ...option,
                description: `${option.description} (using ${budgetType} permission)`,
                payload: { ...castPayload, zoneBudgetType: budgetType },
                data: { ...option.data, zoneBudgetType: budgetType },
              });
            }
          }
        }
      };
      applyZonePermission(normalOptionsStart, permission, separatelyCastableFromTop);
      // A permission to cast the card also allows its bestow cost (CR 118.9). Whether the
      // permission applies, and which permanent-type budget it spends, is judged on the bestowed
      // Aura enchantment spell, not the creature card (CR 601.3e, 702.103b).
      for (const [index, alt] of (def.alternativeCasts ?? []).entries()) {
        if (
          alt.kind !== 'bestow' &&
          alt.kind !== 'adventure' &&
          alt.kind !== 'omen' &&
          !(alt.kind === 'mdfc' && alt.spellFace !== undefined)
        )
          continue;
        // Graveyard face casts are handled by their own zone-scoped alternatives below.
        if (!fromLibraryTop && alt.kind !== 'bestow') continue;
        if (alt.from === 'hand' || alt.from === 'graveyard' || alt.from === 'exile') continue;
        const face = selectedSpellDefinition(def, alt);
        const start = options.length;
        offerCast(
          alt.manaCost,
          face.spellAdditionalCosts ?? [],
          face,
          { alternativeCast: alt.kind, altIndex: index },
          alt.kind === 'bestow'
            ? ' via Bestow'
            : ` via ${alt.kind === 'mdfc' ? 'back face' : alt.kind}`,
          0,
          face.types.includes('Instant') || face.keywords.includes('flash'),
          face.name,
        );
        applyZonePermission(
          start,
          playFromZonePermission(
            ctx,
            player.id,
            obj,
            fromGraveyard ? 'graveyard' : 'libraryTop',
            face,
          ),
          fromLibraryTop &&
            castFromLibraryTopCandidates(ctx, player.id, face).some((card) => card.id === obj.id),
        );
      }
    }

    // Adventure's own exile permission allows only the permanent face. A broad temporary
    // play permission also permits choosing a spell face or paying bestow (CR 118.9); other
    // alternate costs are not offered from exile.
    if ((!fromExile || obj.playableUntilEotBy === player.id || plotCast) && !fromLibraryTop) {
      for (const [index, alt] of (def.alternativeCasts ?? []).entries()) {
        if (
          fromExile &&
          alt.kind !== 'adventure' &&
          alt.kind !== 'omen' &&
          alt.kind !== 'bestow' &&
          alt.kind !== 'mdfc'
        )
          continue;
        if (fromExile && alt.from === 'hand' && !plotCast) continue;
        if (fromCommand && alt.from === 'hand') continue;
        if (
          fromGraveyard
            ? alt.from !== 'graveyard'
            : alt.from === 'graveyard' || alt.from === 'exile'
        )
          continue;
        if (
          alt.condition !== undefined &&
          !evaluateCondition(castCtx, alt.condition, {
            cardId: obj.cardId,
            controllerId: castPlayer.id,
          })
        )
          continue;
        switch (alt.kind) {
          case 'nonMana':
            offerCast(
              alt.manaCost,
              [...spellAdditionalCosts, ...(alt.costs ?? [])],
              def,
              { alternativeCast: alt.kind, altIndex: index },
              ' (alternate cost)',
              0,
              instantSpeed || alt.instantTiming === true,
            );
            break;
          case 'overload':
            if (alt.ability === undefined)
              throw new Error('overload alternative has no executable ability');
            offerCast(
              alt.manaCost,
              spellAdditionalCosts,
              {
                ...def,
                spellAbility: alt.ability,
              },
              { alternativeCast: alt.kind, altIndex: index },
              ' via Overload',
            );
            break;
          case 'adventure':
          case 'omen': {
            const face = selectedSpellDefinition(def, alt);
            offerCast(
              alt.manaCost,
              face.spellAdditionalCosts ?? [],
              face,
              { alternativeCast: alt.kind, altIndex: index },
              ` via ${alt.kind === 'omen' ? 'Omen' : 'Adventure'}`,
              0,
              face.types.includes('Instant') || face.keywords.includes('flash'),
              face.name,
            );
            break;
          }
          case 'bestow':
            offerCast(
              alt.manaCost,
              spellAdditionalCosts,
              bestowedDefinition(def),
              { alternativeCast: alt.kind, altIndex: index },
              ' via Bestow',
            );
            break;
          case 'mdfc':
            if (alt.spellFace !== undefined) {
              const face = selectedSpellDefinition(def, alt);
              offerCast(
                alt.manaCost,
                face.spellAdditionalCosts ?? [],
                face,
                { alternativeCast: alt.kind, altIndex: index },
                ' via back face',
                0,
                face.types.includes('Instant') || face.keywords.includes('flash'),
                face.name,
              );
            }
            break;
          default:
            assertNever(alt.kind, 'alternative cast kind');
        }
      }
    }
  };

  for (const obj of player.hand) considerCast(obj, false);
  for (const obj of player.commandZone) considerCast(obj, true);
  const libraryTop = player.library[0];
  /** Whether a library-top permission lets `libraryTop` be cast as `spell` (CR 601.3e). */
  const topCastableAs = (top: EngineCardObject, spell?: CardDefinition): boolean =>
    castFromLibraryTopCandidates(ctx, player.id, spell).some((obj) => obj.id === top.id) ||
    playFromZonePermission(ctx, player.id, top, 'libraryTop', spell) !== null;
  if (libraryTop !== undefined) {
    const topDef = getDefByOracleId(ctx, libraryTop.oracleId, libraryTop.name);
    if (
      topCastableAs(libraryTop) ||
      // A permission only the bestowed Aura spell satisfies ("Aura spells") still allows bestow.
      (topDef.alternativeCasts ?? []).some(
        (alt) =>
          (alt.kind === 'bestow' ||
            alt.kind === 'adventure' ||
            alt.kind === 'omen' ||
            (alt.kind === 'mdfc' && alt.spellFace !== undefined)) &&
          topCastableAs(libraryTop, selectedSpellDefinition(topDef, alt)),
      )
    )
      considerCast(libraryTop, false, true);
  }
  for (const obj of player.graveyard) considerCast(obj, false, false, false, true);
  for (const obj of ctx.state.exile) {
    if (
      obj.ownerId === player.id &&
      obj.plottedTurn !== undefined &&
      obj.plottedTurn < ctx.state.turnNumber &&
      sorcerySpeed
    )
      considerCast(obj, false, false, true, false, true);
    // One pass per card even when both permissions apply, or every option is offered twice.
    if (
      (obj.ownerId === player.id && obj.onAdventure === true) ||
      obj.playableUntilEotBy === player.id ||
      // Foretold: castable after the turn it was foretold (CR 702.143a).
      (obj.ownerId === player.id &&
        obj.foretold !== undefined &&
        obj.foretold.turn < ctx.state.turnNumber)
    ) {
      considerCast(obj, false, false, true);
    }
  }

  // Best-effort "unlocks" hint (Tier 1 extension of ADR 0010 decision 2): for each `playLand`
  // option, list hand cards that are not currently castable but WOULD be if this land's mana
  // were added. Computed independently of `considerCast` above (X and modes are ignored — a
  // floor-cost check is still a useful hint) so a mistake here can never make an uncastable
  // spell legal; it only ever annotates a `playLand` option that already exists.
  if (!spellCastingBlocked) {
    const affordableHandCardIds = new Set(
      options
        .filter((o) => o.type === 'castSpell')
        .map((o) => (o.payload as { objectId: ObjectId }).objectId),
    );
    const candidates = player.hand.filter((obj) => {
      if (affordableHandCardIds.has(obj.id)) return false;
      const cdef = getDefByOracleId(ctx, obj.oracleId, obj.name);
      if (!cdef.modeled || cdef.types.includes('Land') || cdef.manaCost === null) return false;
      const instantSpeed = cdef.types.includes('Instant') || cdef.keywords.includes('flash');
      return instantSpeed || sorcerySpeed;
    });
    for (const option of options) {
      if (option.type !== 'playLand') continue;
      const producesMana = option.data?.['producesMana'] as (Color | 'C')[] | undefined;
      if (producesMana === undefined || producesMana.length === 0) continue;
      const hypotheticalSource: ManaSource = {
        cardId: 'hypothetical-land-preview',
        units: [producesMana],
        costs: [],
      };
      const augmentedSources = [...sources, hypotheticalSource];
      const unlocks: string[] = [];
      for (const cand of candidates) {
        const cdef = getDefByOracleId(ctx, cand.oracleId, cand.name);
        const baseManaCost = cdef.manaCost;
        if (baseManaCost === null) continue;
        const reduction = costReductionFor(ctx, player.id, cand.oracleId, cand.cardId);
        let cost = addGeneric(baseManaCost, 0);
        if (reduction.colored !== undefined) cost = subtractColored(cost, reduction.colored);
        cost = subtractGeneric(cost, reduction.generic);
        const allows = allowanceFor(ctx, player.id, {
          kind: 'castSpell',
          oracleId: cand.oracleId,
          isCommander: cand.isCommander,
        });
        if (
          canPay(
            cost,
            player.manaEntries,
            augmentedSources,
            allows,
            playerLifeLocked(ctx, player.id) ? 0 : player.life,
          )
        )
          unlocks.push(cand.name);
      }
      if (unlocks.length > 0) option.data = { ...option.data, unlocks };
    }
  }

  // Activated abilities of permanents this player controls (CR 602).
  for (const perm of ctx.state.battlefield) {
    if (perm.controllerId !== player.id) continue;
    if (activatingAbilitiesBlockedFor(ctx, player.id, perm)) continue;
    const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
    const activatedAbilities =
      computeCharacteristics(ctx, perm).activatedAbilities ?? def.activatedAbilities;
    for (const [index, activated] of activatedAbilities.entries()) {
      // An ability that functions from another zone is NOT activatable from the battlefield
      // (CR 112.6). Without this the loop offered a creature its own cycling ability while it
      // was on the battlefield — and the `discardSelf` cost would then have been paid by a
      // card that is not in hand.
      if ((activated.zone ?? 'battlefield') !== 'battlefield') continue;
      if (
        activated.condition !== undefined &&
        !evaluateCondition(ctx, activated.condition, {
          cardId: perm.cardId,
          controllerId: player.id,
        })
      ) {
        continue;
      }
      if (activated.timing === 'sorcery' && !sorcerySpeed) continue;
      if (activated.timing === 'yourTurn' && !isActive) continue;
      // CR 602.5f — "activate only once each turn", tracked on the permanent.
      if (activated.oncePerTurn === true && perm.activationsThisTurn.includes(index)) continue;
      // CR 702.177: an exhaust ability can be activated only once for this object, ever.
      if (activated.exhaust === true && perm.exhaustedAbilities?.includes(index) === true) continue;
      // CR 606.3 — a loyalty ability (one with a loyalty cost) may be activated only if no
      // loyalty ability of this permanent has already been activated this turn. The restriction
      // is on the *permanent*, not the specific ability, so any prior activation this turn
      // (including a different loyalty ability) blocks all of them — unlike the oncePerTurn
      // check above, which only blocks that ability from repeating.
      if (activated.costs.some((c) => c.kind === 'loyalty') && perm.activationsThisTurn.length > 0)
        continue;
      // Boast (CR 702.146a): "activate only if this creature attacked this turn."
      if (activated.requiresAttackedThisTurn === true && perm.attackedThisTurn !== true) continue;
      if (!canPayNonManaCosts(ctx, perm, activated.costs)) continue;
      // A cost that taps or sacrifices the source spends the source, so it cannot ALSO be
      // tapped for mana toward the same cost. `payActivationCosts` enforces the same thing by
      // paying the non-mana half first; excluding it here keeps the two in agreement.
      const spendsSelf = activated.costs.some(
        (c) => c.kind === 'tap' || c.kind === 'sacrificeSelf' || c.kind === 'exileSelf',
      );
      const usable = spendsSelf ? sources.filter((s) => s.cardId !== perm.cardId) : sources;
      const allows = allowanceFor(ctx, player.id, {
        kind: 'activateAbility',
        sourceOracleId: perm.oracleId,
      });
      const reduction = activationCostReductionFor(
        ctx,
        player.id,
        perm.oracleId,
        perm.cardId,
        activated,
      );
      const baseManaCost = manaPortionOf(activated.costs);
      // CR 601.2f (via 602.2b): the reduction applies once X is part of the total.
      const reducedWithX = (x: number): ParsedManaCost =>
        subtractGeneric(withX(baseManaCost, x), reduction.generic);

      // {X} is announced as part of activating (CR 602.1b), same treatment casting gives it —
      // every affordable value is its own option (Steel Hellkite).
      const xSymbols = baseManaCost.x ?? 0;
      const xChoices: number[] = [];
      if (xSymbols === 0) xChoices.push(0);
      else {
        for (let x = 0; ; x++) {
          if (
            !canPay(
              reducedWithX(x),
              player.manaEntries,
              usable,
              allows,
              playerLifeLocked(ctx, player.id) ? 0 : player.life,
            )
          )
            break;
          xChoices.push(x);
        }
        if (xChoices.length === 0) continue;
      }

      for (const x of xChoices) {
        const manaCost = reducedWithX(x);
        if (
          !canPay(
            manaCost,
            player.manaEntries,
            usable,
            allows,
            playerLifeLocked(ctx, player.id) ? 0 : player.life,
          )
        )
          continue;
        if (!canPayNonManaCosts(ctx, perm, activated.costs, x)) continue;
        const jointSources = activationManaSources(ctx, player, perm, activated.costs, manaCost, x);
        if (jointSources === null) continue;

        // Equip (CR 702.6, `attachSelfTo`): re-attaching to the creature this is ALREADY
        // attached to is a strict no-op — same state in, same state out — so it is not a
        // meaningful target. Left in, the model can spam it forever for free once the
        // decision cache starts answering it identically every time (ADR 0010).
        const isAttachAbility = activated.ability.effects.some(
          (e: import('../cards/ability').Effect) => e.op === 'attachSelfTo',
        );
        const targetOptionsFor = (spec: TargetSpec): ObjectId[] => {
          const targetOptions = computeTargetOptions(
            ctx,
            spec,
            player.id,
            abilityOfPermanent(ctx, perm),
            undefined,
            undefined,
            perm.cardId,
          );
          return isAttachAbility && perm.attachedTo !== null
            ? targetOptions.filter((id) => id !== perm.attachedTo)
            : targetOptions;
        };
        // A modal ability's mode is announced as part of activating it, before its targets
        // (CR 602.2b, 700.2a) — one option per choosable mode, the same "the option menu is the
        // contract" treatment a modal spell gets. A non-modal ability is one `undefined` mode.
        const modes = activated.ability.modes;
        const selections: (number[] | undefined)[] =
          modes === undefined
            ? [undefined]
            : legalAbilityModeSelections(activated.ability, (spec) => targetOptionsFor(spec));

        for (const selectedModes of selections) {
          const activeSlots =
            modes === undefined || selectedModes === undefined
              ? undefined
              : abilityModeTargetSlots(modes, selectedModes);
          const modeLabel =
            modes === undefined || selectedModes === undefined
              ? undefined
              : abilityModeLabel(modes, selectedModes);
          const slots: { slot: number; options: ObjectId[] }[] = [];
          let missingTarget = false;
          for (const [slot, spec] of activated.ability.targets.entries()) {
            if (!slotIsActive(activeSlots, slot)) continue;
            const targetOptions = targetOptionsFor(spec);
            if (spec.count !== undefined) {
              if (targetOptions.length < spec.count.min) missingTarget = true;
              continue;
            }
            // CR 602.2b: an ability with no legal target for a slot cannot be activated at all.
            if (targetOptions.length === 0) {
              missingTarget = true;
              break;
            }
            slots.push({ slot, options: targetOptions });
          }
          if (missingTarget) continue;

          const option: EngineActionOption = {
            type: 'activateAbility',
            description:
              `${perm.name}: ${modeLabel ?? activated.ability.description ?? 'activate ability'}` +
              (xSymbols > 0 ? ` with X=${x}` : ''),
            payload: {
              kind: 'activateAbility',
              objectId: perm.id,
              index,
              ...(xSymbols > 0 ? { x } : {}),
              ...(selectedModes !== undefined ? { modes: selectedModes } : {}),
            },
            data: {
              sourceName: perm.name,
              sourceZone: 'battlefield',
              abilityDescription: activated.ability.description ?? 'activate ability',
              ...(modeLabel !== undefined ? { modeLabel } : {}),
              manaCost: describeManaCost(manaCost),
              ...paymentPreview(ctx, player, manaCost, jointSources, allows),
              abilityCosts: activated.costs,
              // Descriptive policy input only. Include every mode conservatively so
              // smart yield cannot hide an untargeted team buff/protection mode.
              abilityEffectOps: [
                ...activated.ability.effects,
                ...(activated.ability.modes?.options.flatMap((mode) => mode.effects) ?? []),
              ].map((effect) => effect.op),
              ...(xSymbols > 0 ? { x } : {}),
            },
            interaction: {
              kind: 'source',
              sourceId: perm.id,
              sourceCardId: perm.cardId,
              abilityIndex: index,
            },
          };
          if (slots.length > 0) option.targets = slots;
          options.push(option);
        }
      }
    }
  }

  // Activated abilities that function from the HAND (CR 112.6a) — cycling and its typed
  // variants. Same shape as the graveyard loop below: the source is a card, not an
  // `EnginePermanent`, so there is no tap/sacrifice/`activationsThisTurn` machinery to reuse.
  for (const card of player.hand) {
    const def = getDefByOracleId(ctx, card.oracleId, card.name);
    for (const [index, activated] of def.activatedAbilities.entries()) {
      if (activated.zone !== 'hand') continue;
      if (activated.timing === 'sorcery' && !sorcerySpeed) continue;
      if (activated.timing === 'yourTurn' && !isActive) continue;
      const allows = allowanceFor(ctx, player.id, {
        kind: 'activateAbility',
        sourceOracleId: card.oracleId,
      });
      // `discardSelf` is the only non-mana cost any hand ability in this pool has, and a card
      // being enumerated is by definition still in hand, so it is always payable. Anything else
      // has no payment branch in `apply.ts` and must not be offered.
      if (activated.costs.some((c) => c.kind !== 'mana' && c.kind !== 'discardSelf')) continue;
      const manaCost = handActivationCost(ctx, def, activated.costs, player.id, card.cardId);
      if (
        !canPay(
          manaCost,
          player.manaEntries,
          sources,
          allows,
          playerLifeLocked(ctx, player.id) ? 0 : player.life,
        )
      )
        continue;

      // CR 602.2b — an ability with no legal target for a slot cannot be activated at all.
      // Channel lands (Otawara) target; cycling does not.
      const slots: { slot: number; options: ObjectId[] }[] = [];
      let missingTarget = false;
      for (const [slot, spec] of activated.ability.targets.entries()) {
        const targetOptions = computeTargetOptions(
          ctx,
          spec,
          player.id,
          targetingFromDefinition(def, 'ability'),
        );
        if (spec.count !== undefined) {
          if (targetOptions.length < spec.count.min) missingTarget = true;
          continue;
        }
        if (targetOptions.length === 0) {
          missingTarget = true;
          break;
        }
        slots.push({ slot, options: targetOptions });
      }
      if (missingTarget) continue;

      const option: EngineActionOption = {
        type: 'activateAbility',
        description: `${card.name} (hand): ${activated.ability.description ?? 'activate ability'}`,
        payload: { kind: 'activateAbility', objectId: card.id, index, fromHand: true },
        data: {
          sourceName: card.name,
          sourceZone: 'hand',
          abilityDescription: activated.ability.description ?? 'activate ability',
          manaCost: describeManaCost(manaCost),
          ...paymentPreview(ctx, player, manaCost, sources, allows),
          abilityCosts: activated.costs,
        },
        interaction: {
          kind: 'source',
          sourceId: card.id,
          sourceCardId: card.cardId,
          abilityIndex: index,
        },
      };
      if (slots.length > 0) option.targets = slots;
      options.push(option);
    }
  }

  // Activated abilities that function from the graveyard (CR 112.6a/602.5c, Runehorn Hellkite)
  // — the same enumeration, but the source is a graveyard card rather than a battlefield
  // permanent, so it has no `activationsThisTurn`/tap/sacrifice machinery to reuse.
  for (const card of player.graveyard) {
    const def = getDefByOracleId(ctx, card.oracleId, card.name);
    const activatedAbilities = [
      ...def.activatedAbilities,
      ...(ctx.state.temporaryGraveyardAbilities[card.cardId] ?? []),
    ];
    for (const [index, activated] of activatedAbilities.entries()) {
      if (activated.zone !== 'graveyard') continue;
      if (activated.timing === 'sorcery' && !sorcerySpeed) continue;
      if (activated.timing === 'yourTurn' && !isActive) continue;
      const allows = allowanceFor(ctx, player.id, {
        kind: 'activateAbility',
        sourceOracleId: card.oracleId,
      });
      // Mana and exiling the card itself are the only costs the graveyard payment path pays;
      // anything else must not be offered rather than offered for free (fail closed, like the
      // hand path above).
      if (activated.costs.some((c) => c.kind !== 'mana' && c.kind !== 'exileSelfFromGraveyard'))
        continue;
      const manaCost = graveyardActivationCost(ctx, player.id, manaPortionOf(activated.costs));
      if (
        !canPay(
          manaCost,
          player.manaEntries,
          sources,
          allows,
          playerLifeLocked(ctx, player.id) ? 0 : player.life,
        )
      )
        continue;
      if (activated.ability.targets.length > 0) continue; // not needed by any card in this pool

      options.push({
        type: 'activateAbility',
        description: `${card.name} (graveyard): ${activated.ability.description ?? 'activate ability'}`,
        payload: { kind: 'activateAbility', objectId: card.id, index, fromGraveyard: true },
        data: {
          sourceName: card.name,
          sourceZone: 'graveyard',
          abilityDescription: activated.ability.description ?? 'activate ability',
          manaCost: describeManaCost(manaCost),
          ...paymentPreview(ctx, player, manaCost, sources, allows),
          abilityCosts: activated.costs,
        },
        interaction: {
          kind: 'source',
          sourceId: card.id,
          sourceCardId: card.cardId,
          abilityIndex: index,
        },
      });
    }
  }

  // Foretell (CR 702.143a, 702.143b): during your turn, any time you have priority, pay {2} and
  // exile a card with foretell from your hand face down — a special action. Dream Devourer gives
  // nonland cards in hand foretell for their mana cost reduced by {2}.
  const foretellGrant = gatherRuleStatics(ctx).find(
    (entry) => entry.static.kind === 'grantForetell' && entry.controllerId === player.id,
  );
  if (foretellGrant !== undefined && ctx.state.currentTurnPlayer === player.id) {
    const allows = allowanceFor(ctx, player.id, { kind: 'other' });
    if (
      canPay(
        FORETELL_COST,
        player.manaEntries,
        baseCastSources,
        allows,
        playerLifeLocked(ctx, player.id) ? 0 : player.life,
      )
    ) {
      for (const card of player.hand) {
        const def = getDefByOracleId(ctx, card.oracleId, card.name);
        if (def.types.includes('Land') || def.manaCost === null) continue;
        options.push({
          type: 'activateAbility',
          description: `Foretell ${card.name} ({2})`,
          payload: { kind: 'foretell', objectId: card.id },
          data: {
            sourceName: card.name,
            sourceZone: 'hand',
            abilityDescription: 'Foretell',
            manaCost: describeManaCost(FORETELL_COST),
            ...paymentPreview(ctx, player, FORETELL_COST, baseCastSources, allows),
            // The exiled card is hidden (CR 702.143a): `formatPlayerLog`.
            publicDescription: 'Foretell a card ({2})',
          },
          interaction: { kind: 'source', sourceId: card.id, sourceCardId: card.cardId },
        });
      }
    }
  }

  // Any time you have priority, turn a face-down permanent you control face up (CR 116.2b): for
  // its morph cost (CR 702.37e), or, if it was manifested and is a creature card, for its mana
  // cost (CR 701.40b). A special action: no stack, no response.
  for (const perm of ctx.state.battlefield) {
    if (perm.controllerId !== player.id || perm.faceDown !== true) continue;
    const faceUpDef = getDefByOracleId(ctx, perm.oracleId, perm.name);
    // Neither casting nor activating: restricted mana cannot pay it.
    const allows = allowanceFor(ctx, player.id, { kind: 'other' });
    for (const way of turnFaceUpCosts(perm, faceUpDef)) {
      if (
        !canPay(
          way.cost,
          player.manaEntries,
          baseCastSources,
          allows,
          playerLifeLocked(ctx, player.id) ? 0 : player.life,
        )
      )
        continue;
      options.push({
        type: 'activateAbility',
        // Only its controller sees this option, and may look at the card (CR 708.5).
        description: `Turn ${faceUpDef.name} face up (${describeManaCost(way.cost)})`,
        payload: {
          kind: 'turnFaceUp',
          objectId: perm.id,
          ...(way.via === undefined ? {} : { via: way.via }),
        },
        data: {
          sourceName: faceUpDef.name,
          sourceZone: 'battlefield',
          abilityDescription: 'Turn face up',
          manaCost: describeManaCost(way.cost),
          ...paymentPreview(ctx, player, way.cost, baseCastSources, allows),
          publicDescription: `Turn a face-down permanent face up`,
        },
        interaction: { kind: 'source', sourceId: perm.id, sourceCardId: perm.cardId },
      });
    }
  }

  // Companion: pay {3} at sorcery speed to move it to hand, once per game (brief §5.7).
  if (
    sorcerySpeed &&
    player.companion !== null &&
    !player.companionMovedToHand &&
    // No purpose: the companion {3} is neither casting nor activating, so restricted mana
    // cannot pay it — which is correct, and is what the default allowance expresses.
    canPay(
      COMPANION_COST,
      player.manaEntries,
      sources,
      undefined,
      playerLifeLocked(ctx, player.id) ? 0 : player.life,
    )
  ) {
    options.push({
      type: 'companionToHand',
      description: `Pay {3}: put your companion ${player.companion.name} into your hand`,
      payload: { kind: 'companionToHand' },
    });
  }

  // Strategic usefulness belongs to the decision provider, not legal-action generation.
  return options;
}

/** Re-validate a chosen target set at cast time (defensive; options came from us). */
export function validateChosenTargets(
  ctx: GameContext,
  def: CardDefinition,
  casterId: PlayerId,
  chosen: ReadonlyMap<number, ObjectId>,
  activeSlots?: readonly number[],
  sourceCardId?: string,
): ObjectId[] {
  const targets: ObjectId[] = [];
  const specs = def.spellAbility?.targets ?? [];
  for (const slot of chosen.keys()) {
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      specs[slot] === undefined ||
      specs[slot]?.count !== undefined ||
      (activeSlots !== undefined && !activeSlots.includes(slot))
    ) {
      throw new Error(`unexpected ordinary target slot ${slot} of ${def.name}`);
    }
  }
  for (const [slotNum, spec] of (def.spellAbility?.targets ?? []).entries()) {
    if (activeSlots !== undefined && !activeSlots.includes(slotNum)) continue;
    if (spec.count !== undefined) continue;
    const choice = chosen.get(slotNum);
    if (choice === undefined) {
      throw new Error(`missing target for slot ${slotNum} of ${def.name}`);
    }
    if (
      !targetIsLegal(ctx, spec, choice, {
        controllerId: casterId,
        ...targetingSourceFields(targetingFromDefinition(def, 'spell')),
        ...(sourceCardId === undefined ? {} : { sourceCardId }),
        chosenTargets: targets,
        phase: 'announcement',
      })
    ) {
      throw new Error(`illegal target ${choice} for slot ${slotNum} of ${def.name}`);
    }
    targets[slotNum] = choice;
  }
  return targets;
}

export { findPermanent };
