import { activationManaSources } from '../mana/activation';
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
import type { AbilityCost, CardDefinition, TargetKind, TargetSpec } from '../cards/definition';
import type { SelectorCandidate, SelectorSource } from '../cards/selector';
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
  withX,
} from '../mana/cost';
import type { ManaSource, ParsedManaCost } from '../mana/cost';
import {
  activatingAbilitiesBlockedFor,
  allowanceFor,
  cardZoneCandidate,
  canPlayFromZone,
  canPayNonManaCosts,
  colorsOf,
  playFromZonePermission,
  castFromLibraryTopCandidates,
  castingSpellsBlockedFor,
  findPermanent,
  gatherRuleStatics,
  graveyardTargets,
  hasProtectionFrom,
  getDefByOracleId,
  hasKeyword,
  landPlayLimitFor,
  manaSourcesFor,
  playersInApnapOrder,
  previewLandManaSymbols,
  previewManaAbilities,
  requireModeled,
} from '../state/queries';
import { playerById, spellManaValue } from '../state/objects';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
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
      x?: number;
      /** Which modal option was chosen (CR 601.2b), when `spellAbility.modes` is present. */
      mode?: number;
      /** Chosen modal subset; supersedes mode for ranged modal spells. */
      modes?: number[];
      /** Number of times the card's optional additional cost was paid. */
      optionalCostCount?: number;
      alternativeCast?: 'overload' | 'adventure' | 'omen' | 'nonMana' | 'energy' | 'commanderFree';
      altIndex?: number;
    }
  /** Activate `index` of the source permanent's `activatedAbilities` (CR 602). */
  | {
      kind: 'activateAbility';
      objectId: ObjectId;
      index: number;
      x?: number;
      fromGraveyard?: boolean;
      fromHand?: boolean;
    }
  | { kind: 'companionToHand' };

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
  sourceInHand: boolean,
  announcedX = 0,
): boolean {
  let discardAvailable = player.hand.filter(
    (card) => !sourceInHand || card.cardId !== sourceCardId,
  ).length;
  const sacrificeCosts = costs.filter(
    (cost): cost is Extract<AbilityCost, { kind: 'sacrificeOther' }> =>
      cost.kind === 'sacrificeOther',
  );
  const tapCosts = costs.filter(
    (cost): cost is Extract<AbilityCost, { kind: 'tapOther' }> => cost.kind === 'tapOther',
  );

  for (const cost of costs) {
    if (cost.kind === 'discardCard') {
      const count = cost.count ?? 1;
      if (discardAvailable < count) return false;
      discardAvailable -= count;
    } else if (cost.kind === 'payLife') {
      if (player.life < cost.amount) return false;
    } else if (cost.kind === 'payLifeValue') {
      if (
        player.life <
        evaluateValueIn(ctx, cost.amount, { controllerId: player.id, sourceCardId, x: announcedX })
      )
        return false;
    } else if (cost.kind === 'exileOtherCardsFromGraveyard') {
      const eligible = player.graveyard.filter((card) => card.cardId !== sourceCardId);
      if (eligible.length < cost.count) return false;
    } else if (cost.kind === 'exileCardFromHand') {
      const count = cost.count ?? 1;
      const eligible = player.hand.filter(
        (card) =>
          (!sourceInHand || card.cardId !== sourceCardId) &&
          selectMatches(cardZoneCandidate(ctx, card, player.id), cost.selector, {
            cardId: sourceCardId,
            controllerId: player.id,
          }),
      );
      if (eligible.length < count) return false;
    } else if (cost.kind !== 'sacrificeOther' && cost.kind !== 'tapOther' && cost.kind !== 'mana') {
      return false;
    }
  }

  if (tapCosts.length > 0) {
    const available = ctx.state.battlefield.filter(
      (permanent) => permanent.controllerId === player.id && !permanent.tapped,
    );
    const canAssignTap = (index: number, used: Set<string>): boolean => {
      const cost = tapCosts[index];
      if (cost === undefined) return true;
      for (const candidate of available) {
        if (used.has(candidate.cardId)) continue;
        if (
          !matchesSelector(ctx, candidate, cost.selector, {
            cardId: sourceCardId,
            controllerId: player.id,
          })
        ) {
          continue;
        }
        const next = new Set(used);
        next.add(candidate.cardId);
        if (canAssignTap(index + 1, next)) return true;
      }
      return false;
    };
    if (!canAssignTap(0, new Set())) return false;
  }

  if (sacrificeCosts.length === 0) return true;
  const candidates = ctx.state.battlefield.filter((perm) => perm.controllerId === player.id);
  const canAssign = (costIndex: number, used: Set<string>): boolean => {
    const cost = sacrificeCosts[costIndex];
    if (cost === undefined) return true;
    const count = cost.count ?? 1;
    const eligible = candidates.filter(
      (perm) =>
        !used.has(perm.cardId) &&
        matchesSelector(ctx, perm, cost.selector, {
          cardId: sourceCardId,
          controllerId: player.id,
        }),
    );
    const chooseForCost = (remaining: number, nextUsed: Set<string>): boolean => {
      if (remaining === 0) return canAssign(costIndex + 1, nextUsed);
      for (const candidate of eligible) {
        if (nextUsed.has(candidate.cardId)) continue;
        const updated = new Set(nextUsed);
        updated.add(candidate.cardId);
        if (chooseForCost(remaining - 1, updated)) return true;
      }
      return false;
    };
    return chooseForCost(count, used);
  };
  return canAssign(0, new Set());
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
): Record<string, unknown> {
  const plan = planPayment(cost, player.manaEntries, sources, allows, player.life);
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
): CostReductionResult {
  const def = getDefByOracleId(ctx, castOracleId, castOracleId);
  const candidate: SelectorCandidate = {
    cardId: castCardId,
    controllerId: casterId,
    types: def.types,
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
    if (entry.controllerId !== casterId) continue;
    if (entry.static.yourTurnOnly === true && ctx.state.currentTurnPlayer !== casterId) continue;
    if (entry.static.excludesSelf === true && entry.sourceCardId === castCardId) continue;
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
  }
}

/**
 * Does the object a stack `spell` entry is casting have the Creature type? Shared by
 * `computeTargetOptions` and `isTargetStillLegal` (`effects/resolve.ts`) so "noncreature spell"
 * cannot drift between offering a target and rechecking it at resolution — the same reason
 * `permanentMatchesKind` is shared for battlefield kinds.
 */
export function isCreatureSpell(ctx: GameContext, entry: EngineStackObject): boolean {
  const def = getDefByOracleId(ctx, entry.sourceOracleId, entry.description);
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
  const def = getDefByOracleId(ctx, entry.sourceOracleId, entry.description);
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
export function computeTargetOptions(
  ctx: GameContext,
  spec: TargetKind | TargetSpec,
  casterId: PlayerId,
  /** The targeting source's colors, for protection (CR 702.16). Omitted ⇒ colorless. */
  sourceColors?: readonly Color[],
  /** The player associated with this trigger event, if target text refers to them. */
  eventPlayerId?: PlayerId,
  /**
   * Earlier ordinary slots' chosen ids, keyed by slot index — how `graveyardOwnerSlot`
   * (Loaming Shaman: "target cards from THEIR graveyard") finds whose graveyard to search.
   * Omitted when no such lookup is needed, or when this slot is only being previewed before
   * the referenced slot has been chosen (falls back to the caster's own graveyard).
   */
  chosenTargets?: readonly ObjectId[],
): ObjectId[] {
  const { kind, controller, filter } =
    typeof spec === 'string' ? { kind: spec, controller: undefined, filter: undefined } : spec;

  if (kind === 'stackObject') {
    return ctx.state.stack.map((entry) => entry.id);
  }
  if (kind === 'spellOrNonlandPermanent') {
    const permanentSpec = {
      kind: 'nonlandPermanent' as const,
      ...(controller !== undefined ? { controller } : {}),
      ...(filter !== undefined ? { filter } : {}),
    };
    const spellSpec = {
      kind: 'spell' as const,
      ...(controller !== undefined ? { controller } : {}),
    };
    return [
      ...computeTargetOptions(ctx, spellSpec, casterId, sourceColors, eventPlayerId, chosenTargets),
      ...computeTargetOptions(
        ctx,
        permanentSpec,
        casterId,
        sourceColors,
        eventPlayerId,
        chosenTargets,
      ),
    ];
  }
  if (kind === 'spell' || kind === 'noncreatureSpell') {
    return ctx.state.stack
      .filter((s) => s.kind === 'spell')
      .filter((s) => kind !== 'noncreatureSpell' || !isCreatureSpell(ctx, s))
      .filter((s) => filter === undefined || spellMatchesSelector(ctx, s, filter, casterId))
      .filter(
        (s) =>
          controller === undefined ||
          (controller === 'you'
            ? s.controllerId === casterId
            : controller === 'opponent'
              ? s.controllerId !== casterId
              : s.controllerId === eventPlayerId),
      )
      .map((s) => s.id);
  }
  if (kind === 'commanderInCommandZone') {
    const player = playerById(ctx, casterId);
    return player.commandZone.filter((c) => c.isCommander).map((c) => c.id);
  }
  // A card in a graveyard — the caster's own, unless `graveyardOwnerSlot` names an earlier
  // slot holding the actual owner (Loaming Shaman: "target cards from THEIR graveyard").
  if (kind === 'cardInGraveyard') {
    const graveyardOwnerSlot = typeof spec === 'object' ? spec.graveyardOwnerSlot : undefined;
    const graveyardOwnerScope = typeof spec === 'object' ? spec.graveyardOwnerScope : undefined;
    if (graveyardOwnerScope === 'any') {
      return ctx.state.players.flatMap((player) =>
        graveyardTargets(ctx, player.id, filter).map((c) => c.id),
      );
    }
    const ownerId =
      graveyardOwnerSlot === undefined
        ? casterId
        : ((chosenTargets?.[graveyardOwnerSlot] as PlayerId | undefined) ?? casterId);
    return graveyardTargets(ctx, ownerId, filter).map((c) => c.id);
  }
  const players = playersInApnapOrder(ctx).map((p) => p.id);
  if (kind === 'player') {
    return players.filter(
      (id) =>
        controller === undefined ||
        (controller === 'you'
          ? id === casterId
          : controller === 'opponent'
            ? id !== casterId
            : id === eventPlayerId),
    );
  }

  const permanents = ctx.state.battlefield
    .filter((p) => permanentMatchesKind(ctx, p, kind))
    // Shroud (CR 702.18) removes a permanent from every target list, its controller's included.
    .filter((p) => !hasKeyword(ctx, p, 'shroud'))
    // Hexproof: can't be the target of spells/abilities OPPONENTS control (CR 702.11).
    .filter((p) => p.controllerId === casterId || !hasKeyword(ctx, p, 'hexproof'))
    // Protection (CR 702.16). Kept in lockstep with `isTargetStillLegal`, which re-checks the
    // same three at resolution — a divergence means offering a target we would then refuse.
    .filter((p) => sourceColors === undefined || !hasProtectionFrom(ctx, p, sourceColors))
    .filter(
      (p) =>
        controller === undefined ||
        (controller === 'you'
          ? p.controllerId === casterId
          : controller === 'opponent'
            ? p.controllerId !== casterId
            : p.controllerId === eventPlayerId),
    )
    .filter(
      (p) =>
        filter === undefined ||
        matchesSelector(ctx, p, filter, { cardId: '', controllerId: casterId }),
    )
    .map((p) => p.id);

  // "Any target" adds players to its permanents (CR 115.4); "player or planeswalker" likewise.
  // Players are never hexproof-filtered.
  return kind === 'anyTarget' || kind === 'playerOrPlaneswalker'
    ? [...permanents, ...players]
    : permanents;
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

/** Target slots for casting a card, or null when a required slot has zero options. */
function computeCastTargets(
  ctx: GameContext,
  def: CardDefinition,
  casterId: PlayerId,
  activeSlots?: readonly number[],
): { slot: number; options: ObjectId[] }[] | null {
  const slots: { slot: number; options: ObjectId[] }[] = [];
  for (const [slotNum, spec] of (def.spellAbility?.targets ?? []).entries()) {
    if (activeSlots !== undefined && !activeSlots.includes(slotNum)) continue;
    // Protection (CR 702.16): a spell can't target a permanent protected from its colors.
    const options = computeTargetOptions(ctx, spec, casterId, def.colors);
    if (spec.count !== undefined) {
      if (options.length < spec.count.min) return null;
      continue; // Counted targets are chosen at announcement after the action is selected.
    }
    if (options.length === 0) return null; // can't cast without a legal target (CR 601.2c)
    slots.push({ slot: slotNum, options });
  }
  return slots;
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
  ): void => {
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
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
    if (def.manaCost === null) return; // cost-less nonland card: not castable
    const instantSpeed = def.types.includes('Instant') || def.keywords.includes('flash');
    if (!instantSpeed && !sorcerySpeed) return;

    const tax = fromCommand ? 2 * (player.commanderCastCount[obj.cardId] ?? 0) : 0;
    const reboundCast = fromExile && obj.reboundCastBy === player.id;
    const spellAdditionalCosts = def.spellAdditionalCosts ?? [];
    const sourceInHand = !fromCommand && !fromLibraryTop && !fromExile && !fromGraveyard;
    if (
      fromGraveyard &&
      !(def.alternativeCasts?.some((alt) => alt.from === 'graveyard') ?? false) &&
      !canPlayFromZone(ctx, player.id, obj, 'graveyard')
    )
      return;
    const additionalManaCost = manaPortionOf(spellAdditionalCosts);
    const reduction = costReductionFor(ctx, player.id, obj.oracleId, obj.cardId);
    const unreduced = reboundCast ? emptyCost() : addGeneric(def.manaCost, tax);
    // CR 601.2f: reductions apply to the total cost, after {X} has a value — so a reduction can
    // pay for X's share, not just for whatever generic mana the printed cost happens to have.
    const costWithX = (x: number): ParsedManaCost => {
      let c = withX(unreduced, x);
      if (reduction.colored !== undefined) c = subtractColored(c, reduction.colored);
      return subtractGeneric(c, reduction.generic);
    };

    // {X} is announced as part of casting (CR 601.2b), so each affordable value of X is its own
    // option. Enumerated rather than asked as a follow-up decision because the option menu is
    // the contract: an action offered here must be applicable with no further legality check.
    // Restricted mana ("spend only to cast a Dragon spell") may or may not pay for THIS card,
    // so affordability is asked with the purpose attached — see `mana/cost.ts::ManaAllowance`.
    const allows = allowanceFor(ctx, player.id, {
      kind: 'castSpell',
      oracleId: obj.oracleId,
      isCommander: obj.isCommander,
    });

    const xSymbols = reboundCast ? 0 : (def.manaCost.x ?? 0);
    const announcesAdditionalX = def.announcesX === true;
    const xChoices: number[] = [];
    if (xSymbols === 0 && !announcesAdditionalX) xChoices.push(0);
    else if (announcesAdditionalX) {
      for (let x = 0; x <= player.life; x++) xChoices.push(x);
    } else {
      for (let x = 0; ; x++) {
        if (
          !canPay(
            addManaCosts(costWithX(x), additionalManaCost),
            player.manaEntries,
            sources,
            allows,
            player.life,
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
      def,
      maxChoicesFor(ctx, def, { cardId: obj.cardId, controllerId: player.id }),
    );

    for (const x of xChoices) {
      const cost = costWithX(x);
      if (!canPay(cost, player.manaEntries, sources, allows, player.life)) continue;

      for (const selectedModes of selections) {
        const targets = computeCastTargets(
          ctx,
          def,
          player.id,
          selectedModeTargetSlots(def, selectedModes),
        );
        if (targets === null) continue;
        const modeCosts = modeAdditionalCosts(def, selectedModes);
        const optional = def.optionalAdditionalCost;
        const optionalCounts: number[] = [0];
        if (optional !== undefined) {
          const max = optional.repeatable === true ? 100 : 1;
          for (let count = 1; count <= max; count++) {
            let prospective = addManaCosts(
              cost,
              manaPortionOf([...spellAdditionalCosts, ...modeCosts]),
            );
            for (let i = 0; i < count; i++) prospective = addManaCosts(prospective, optional.cost);
            if (!canPay(prospective, player.manaEntries, sources, allows, player.life)) break;
            optionalCounts.push(count);
          }
        }
        const modeLabel =
          selectedModes === undefined
            ? undefined
            : selectedModes
                .map(
                  (mode) =>
                    def.spellAbility?.modes?.options[mode]?.description ?? `mode ${mode + 1}`,
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
          const selectionCost = addManaCosts(cost, manaPortionOf(additionalCosts));
          if (!canPay(selectionCost, player.manaEntries, sources, allows, player.life)) continue;
          if (
            !canPaySpellAdditionalCosts(ctx, player, additionalCosts, obj.cardId, sourceInHand, x)
          )
            continue;
          const payableTargets = targets.map((slot) => ({
            ...slot,
            options: slot.options.filter((targetId) => {
              const lifeTax = targetLifeTaxFor(ctx, player.id, [targetId]);
              return canPay(
                selectionCost,
                player.manaEntries,
                sources,
                allows,
                player.life - lifeTax,
              );
            }),
          }));
          if (payableTargets.some((slot) => slot.options.length === 0)) continue;
          const optionalLabel =
            optional !== undefined && optionalCostCount > 0
              ? ` — ${optional.mechanic} ${optionalCostCount}`
              : '';
          const option: EngineActionOption = {
            type: 'castSpell',
            description:
              `Cast ${obj.name} (${describeManaCost(selectionCost)})` +
              (xSymbols > 0 || announcesAdditionalX ? ` with X=${x}` : '') +
              (modeLabel !== undefined ? ` — ${modeLabel}` : '') +
              optionalLabel +
              (fromCommand
                ? ` from the command zone${tax > 0 ? `, commander tax {${tax}}` : ''}`
                : '') +
              (fromLibraryTop ? ' from the top of your library' : '') +
              (fromExile ? ' from exile' : '') +
              (fromGraveyard ? ' from your graveyard' : '') +
              (reboundCast ? ' without paying its mana cost' : ''),
            payload: {
              kind: 'castSpell',
              objectId: obj.id,
              fromCommand,
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
            },
            data: {
              instantSpeed,
              sourceName: obj.name,
              sourceZone: fromCommand
                ? 'command'
                : fromLibraryTop
                  ? 'library'
                  : fromExile
                    ? 'exile'
                    : 'hand',
              manaCost: describeManaCost(selectionCost),
              ...paymentPreview(ctx, player, selectionCost, sources, allows),
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
    const energyAlternativeCost = ctx.state.battlefield
      .filter((perm) => perm.controllerId === player.id)
      .map((perm) => getDefByOracleId(ctx, perm.oracleId, perm.name).energyAlternativeCost)
      .find((amount): amount is number => amount !== undefined);
    // Lands are permanents, but they are played rather than cast as permanent spells, so Nissa's
    // alternate energy cost must never be offered for a land card.
    const isPermanentSpell = def.types.some((type) =>
      ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Planeswalker'].includes(type),
    );
    if (
      isPermanentSpell &&
      energyAlternativeCost !== undefined &&
      player.energy >= energyAlternativeCost &&
      !fromExile &&
      !fromGraveyard &&
      canPaySpellAdditionalCosts(ctx, player, spellAdditionalCosts, obj.cardId, sourceInHand)
    ) {
      const targets = computeCastTargets(ctx, def, player.id);
      if (targets !== null) {
        const option: EngineActionOption = {
          type: 'castSpell',
          description:
            `Cast ${obj.name} by paying ${energyAlternativeCost} energy` +
            (fromCommand ? ' from the command zone' : ''),
          payload: { kind: 'castSpell', objectId: obj.id, fromCommand, alternativeCast: 'energy' },
          data: {
            instantSpeed,
            sourceName: obj.name,
            sourceZone: fromCommand ? 'command' : 'hand',
            manaCost: `{${energyAlternativeCost}} energy`,
            energyCost: energyAlternativeCost,
            castVariant: 'energy',
            ...(spellAdditionalCosts.length > 0 ? { abilityCosts: spellAdditionalCosts } : {}),
          },
        };
        if (targets.length > 0) option.targets = targets;
        options.push(option);
      }
    }
    if (
      def.commanderFreeCast === true &&
      !fromCommand &&
      !fromGraveyard &&
      ctx.state.battlefield.some((perm) => perm.controllerId === player.id && perm.isCommander) &&
      canPaySpellAdditionalCosts(ctx, player, spellAdditionalCosts, obj.cardId, sourceInHand)
    ) {
      const targets = computeCastTargets(ctx, def, player.id);
      if (targets !== null) {
        options.push({
          type: 'castSpell',
          description: `Cast ${obj.name} without paying its mana cost (you control a commander)`,
          payload: {
            kind: 'castSpell',
            objectId: obj.id,
            fromCommand,
            alternativeCast: 'commanderFree',
          },
          data: {
            instantSpeed,
            sourceName: obj.name,
            sourceZone: 'hand',
            manaCost: 'free',
            castVariant: 'commanderFree',
            ...(spellAdditionalCosts.length > 0 ? { abilityCosts: spellAdditionalCosts } : {}),
          },
          ...(targets.length > 0 ? { targets } : {}),
        });
      }
    }
    if (fromGraveyard || fromLibraryTop) {
      const permission = playFromZonePermission(
        ctx,
        player.id,
        obj,
        fromGraveyard ? 'graveyard' : 'libraryTop',
      );
      const separatelyCastableFromTop =
        fromLibraryTop &&
        castFromLibraryTopCandidates(ctx, player.id).some((card) => card.id === obj.id);
      if (permission === null && !separatelyCastableFromTop) {
        options.splice(normalOptionsStart);
      } else if (permission?.budgetTypes !== undefined) {
        const generated = options.splice(normalOptionsStart);
        for (const budgetType of permission.budgetTypes) {
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
    }
    const applyRed = (c: ParsedManaCost): ParsedManaCost => {
      let b = c;
      if (reduction.colored !== undefined) {
        b = subtractColored(b, reduction.colored);
      }
      return subtractGeneric(b, reduction.generic);
    };

    // Alternative casts from the top of the library are not offered: their payloads cannot say
    // where the card is, and a top-of-library permission ("cast creature spells from the top")
    // has not been checked against them — offering one made `applyPriorityAction` look in hand
    // and throw (found by fuzzing an Omen card). Fail closed until both are modeled.
    if (def.alternativeCasts && def.alternativeCasts.length > 0 && !fromExile && !fromLibraryTop) {
      for (const [index, alt] of def.alternativeCasts.entries()) {
        if (fromGraveyard ? alt.from !== 'graveyard' : alt.from === 'graveyard') continue;
        if (alt.kind === 'nonMana') {
          const alternativeCosts = [...spellAdditionalCosts, ...(alt.costs ?? [])];
          const cost = addManaCosts(applyRed(alt.manaCost), manaPortionOf(alternativeCosts));
          if (
            (alt.condition === undefined ||
              evaluateCondition(ctx, alt.condition, {
                cardId: obj.cardId,
                controllerId: player.id,
              })) &&
            canPay(cost, player.manaEntries, sources, allows, player.life) &&
            canPaySpellAdditionalCosts(ctx, player, alternativeCosts, obj.cardId, sourceInHand)
          ) {
            const targets = computeCastTargets(ctx, def, player.id);
            if (targets !== null) {
              options.push({
                type: 'castSpell',
                description: fromGraveyard
                  ? `Cast ${obj.name} from your graveyard (${describeManaCost(cost)})`
                  : 'Cast ' + obj.name + ' without paying its mana cost (alternate cost)',
                payload: {
                  kind: 'castSpell',
                  objectId: obj.id,
                  fromCommand,
                  ...(fromGraveyard ? { fromGraveyard: true } : {}),
                  alternativeCast: 'nonMana',
                  altIndex: index,
                },
                data: {
                  instantSpeed,
                  sourceName: obj.name,
                  sourceZone: fromCommand ? 'command' : fromGraveyard ? 'graveyard' : 'hand',
                  manaCost: fromGraveyard ? describeManaCost(cost) : 'free',
                  ...paymentPreview(ctx, player, cost, sources, allows),
                  castVariant: 'nonMana',
                  abilityCosts: alternativeCosts,
                },
                // `targets` was computed above (and gates castability, CR 601.2c) but was not
                // attached, so a targeted spell cast for its alternative cost reached
                // `validateChosenTargets` with slot 0 unanswered and threw. The `energy` and
                // `commanderFree` branches above attach it exactly this way.
                ...(targets.length > 0 ? { targets } : {}),
              });
            }
          }
        } else if (alt.kind === 'overload') {
          const cost = addManaCosts(applyRed(alt.manaCost), additionalManaCost);
          if (
            canPay(cost, player.manaEntries, sources, allows, player.life) &&
            canPaySpellAdditionalCosts(ctx, player, spellAdditionalCosts, obj.cardId, sourceInHand)
          ) {
            options.push({
              type: 'castSpell',
              description: `Cast ${obj.name} via Overload (${describeManaCost(cost)})`,
              payload: {
                kind: 'castSpell',
                objectId: obj.id,
                fromCommand,
                alternativeCast: 'overload',
                altIndex: index,
              },
              data: {
                instantSpeed,
                sourceName: obj.name,
                sourceZone: fromCommand ? 'command' : 'hand',
                manaCost: describeManaCost(cost),
                ...paymentPreview(ctx, player, cost, sources, allows),
                castVariant: 'overload',
              },
            });
          }
        } else if (alt.kind === 'adventure' || alt.kind === 'omen') {
          // The payload below is hand-only (no commander tax, `fromCommand: false`), so a
          // commander's Adventure/Omen half is not offered from the command zone rather than
          // offered at the wrong price and then looked for in hand.
          if (fromCommand) continue;
          const cost = addManaCosts(applyRed(alt.manaCost), additionalManaCost);
          if (
            canPay(cost, player.manaEntries, sources, allows, player.life) &&
            canPaySpellAdditionalCosts(ctx, player, spellAdditionalCosts, obj.cardId, sourceInHand)
          ) {
            const altName = alt.name ?? alt.description;
            const note =
              alt.kind === 'omen'
                ? '[Omen Spell: shuffles into library on resolution]'
                : '[Adventure Spell: exiles on resolution, cast main face later]';
            options.push({
              type: 'castSpell',
              description: `Cast ${altName} via ${alt.kind === 'omen' ? 'Omen' : 'Adventure'} (${describeManaCost(cost)}) ${note}`,
              payload: {
                kind: 'castSpell',
                objectId: obj.id,
                fromCommand: false,
                alternativeCast: alt.kind,
                altIndex: index,
              },
              data: {
                instantSpeed: alt.typeLine?.includes('Instant') ?? false,
                sourceName: obj.name,
                sourceZone: 'hand',
                manaCost: describeManaCost(cost),
                ...paymentPreview(ctx, player, cost, sources, allows),
                castVariant: alt.kind,
              },
            });
          }
        }
      }
    }
  };

  for (const obj of player.hand) considerCast(obj, false);
  for (const obj of player.commandZone) considerCast(obj, true);
  const libraryTop = player.library[0];
  if (
    libraryTop !== undefined &&
    (castFromLibraryTopCandidates(ctx, player.id).some((obj) => obj.id === libraryTop.id) ||
      canPlayFromZone(ctx, player.id, libraryTop, 'libraryTop'))
  )
    considerCast(libraryTop, false, true);
  for (const obj of player.graveyard) considerCast(obj, false, false, false, true);
  for (const obj of ctx.state.exile) {
    // One pass per card even when both permissions apply, or every option is offered twice.
    if (
      (obj.ownerId === player.id && obj.onAdventure === true) ||
      obj.playableUntilEotBy === player.id
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
        if (canPay(cost, player.manaEntries, augmentedSources, allows, player.life))
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
      // CR 602.5f — "activate only once each turn", tracked on the permanent.
      if (activated.oncePerTurn === true && perm.activationsThisTurn.includes(index)) continue;
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
      const reduction = activationCostReductionFor(ctx, player.id, perm.oracleId, perm.cardId);
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
          if (!canPay(reducedWithX(x), player.manaEntries, usable, allows, player.life)) break;
          xChoices.push(x);
        }
        if (xChoices.length === 0) continue;
      }

      for (const x of xChoices) {
        const manaCost = reducedWithX(x);
        if (!canPay(manaCost, player.manaEntries, usable, allows, player.life)) continue;
        if (!canPayNonManaCosts(ctx, perm, activated.costs, x)) continue;
        const jointSources = activationManaSources(ctx, player, perm, activated.costs, manaCost, x);
        if (jointSources === null) continue;

        const slots: { slot: number; options: ObjectId[] }[] = [];
        let slotNum = 0;
        let missingTarget = false;
        // Equip (CR 702.6, `attachSelfTo`): re-attaching to the creature this is ALREADY
        // attached to is a strict no-op — same state in, same state out — so it is not a
        // meaningful target. Left in, the model can spam it forever for free once the
        // decision cache starts answering it identically every time (ADR 0010).
        const isAttachAbility = activated.ability.effects.some(
          (e: import('../cards/ability').Effect) => e.op === 'attachSelfTo',
        );
        for (const spec of activated.ability.targets) {
          let targetOptions = computeTargetOptions(ctx, spec, player.id, colorsOf(ctx, perm));
          if (isAttachAbility && perm.attachedTo !== null) {
            targetOptions = targetOptions.filter((id) => id !== perm.attachedTo);
          }
          if (spec.count !== undefined) {
            if (targetOptions.length < spec.count.min) missingTarget = true;
            continue;
          }
          // CR 602.2b: an ability with no legal target for a slot cannot be activated at all.
          if (targetOptions.length === 0) {
            missingTarget = true;
            break;
          }
          slots.push({ slot: slotNum++, options: targetOptions });
        }
        if (missingTarget) continue;

        const option: EngineActionOption = {
          type: 'activateAbility',
          description:
            `${perm.name}: ${activated.ability.description ?? 'activate ability'}` +
            (xSymbols > 0 ? ` with X=${x}` : ''),
          payload: {
            kind: 'activateAbility',
            objectId: perm.id,
            index,
            ...(xSymbols > 0 ? { x } : {}),
          },
          data: {
            sourceName: perm.name,
            sourceZone: 'battlefield',
            abilityDescription: activated.ability.description ?? 'activate ability',
            manaCost: describeManaCost(manaCost),
            ...paymentPreview(ctx, player, manaCost, jointSources, allows),
            abilityCosts: activated.costs,
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

  // Activated abilities that function from the HAND (CR 112.6a) — cycling and its typed
  // variants. Same shape as the graveyard loop below: the source is a card, not an
  // `EnginePermanent`, so there is no tap/sacrifice/`activationsThisTurn` machinery to reuse.
  for (const card of player.hand) {
    const def = getDefByOracleId(ctx, card.oracleId, card.name);
    for (const [index, activated] of def.activatedAbilities.entries()) {
      if (activated.zone !== 'hand') continue;
      if (activated.timing === 'sorcery' && !sorcerySpeed) continue;
      const allows = allowanceFor(ctx, player.id, {
        kind: 'activateAbility',
        sourceOracleId: card.oracleId,
      });
      // `discardSelf` is the only non-mana cost any hand ability in this pool has, and a card
      // being enumerated is by definition still in hand, so it is always payable. Anything else
      // has no payment branch in `apply.ts` and must not be offered.
      if (activated.costs.some((c) => c.kind !== 'mana' && c.kind !== 'discardSelf')) continue;
      const manaCost = handActivationCost(ctx, def, activated.costs, player.id, card.cardId);
      if (!canPay(manaCost, player.manaEntries, sources, allows, player.life)) continue;

      // CR 602.2b — an ability with no legal target for a slot cannot be activated at all.
      // Channel lands (Otawara) target; cycling does not.
      const slots: { slot: number; options: ObjectId[] }[] = [];
      let missingTarget = false;
      for (const [slot, spec] of activated.ability.targets.entries()) {
        const targetOptions = computeTargetOptions(ctx, spec, player.id, def.colors);
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
      const allows = allowanceFor(ctx, player.id, {
        kind: 'activateAbility',
        sourceOracleId: card.oracleId,
      });
      // Mana and exiling the card itself are the only costs the graveyard payment path pays;
      // anything else must not be offered rather than offered for free (fail closed, like the
      // hand path above).
      if (activated.costs.some((c) => c.kind !== 'mana' && c.kind !== 'exileSelfFromGraveyard'))
        continue;
      const manaCost = manaPortionOf(activated.costs);
      if (!canPay(manaCost, player.manaEntries, sources, allows, player.life)) continue;
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

  // Companion: pay {3} at sorcery speed to move it to hand, once per game (brief §5.7).
  if (
    sorcerySpeed &&
    player.companion !== null &&
    !player.companionMovedToHand &&
    // No purpose: the companion {3} is neither casting nor activating, so restricted mana
    // cannot pay it — which is correct, and is what the default allowance expresses.
    canPay(COMPANION_COST, player.manaEntries, sources, undefined, player.life)
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
): ObjectId[] {
  const targets: ObjectId[] = [];
  for (const [slotNum, spec] of (def.spellAbility?.targets ?? []).entries()) {
    if (activeSlots !== undefined && !activeSlots.includes(slotNum)) continue;
    if (spec.count !== undefined) continue;
    const choice = chosen.get(slotNum);
    if (choice === undefined) {
      throw new Error(`missing target for slot ${slotNum} of ${def.name}`);
    }
    const legal = computeTargetOptions(ctx, spec, casterId, def.colors);
    if (!legal.includes(choice)) {
      throw new Error(`illegal target ${choice} for slot ${slotNum} of ${def.name}`);
    }
    targets[slotNum] = choice;
  }
  return targets;
}

export { findPermanent };
