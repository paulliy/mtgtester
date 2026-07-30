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
import type { Color, ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type { AbilityCost, CardDefinition, TargetKind, TargetSpec } from '../cards/definition';
import type { SelectorCandidate, SelectorSource } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import type { EngineActionOption } from '../decisions';
import { computeCharacteristics, matchesSelector } from '../effects/continuous';
import { evaluateValueIn } from '../effects/values';
import { addGeneric, canPay, describeManaCost, emptyCost, planPayment, subtractColored, subtractGeneric, withX } from '../mana/cost';
import type { ManaSource, ParsedManaCost } from '../mana/cost';
import {
  allowanceFor,
  canPayNonManaCosts,
  castFromLibraryTopCandidates,
  castingSpellsBlockedFor,
  findPermanent,
  gatherRuleStatics,
  graveyardTargets,
  hasProtectionFrom,
  getDefByOracleId,
  hasKeyword,
  manaSourcesFor,
  playersInApnapOrder,
  previewLandManaSymbols,
  requireModeled,
} from '../state/queries';
import { playerById } from '../state/objects';
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
  | { kind: 'playLand'; objectId: ObjectId }
  | {
      kind: 'castSpell';
      objectId: ObjectId;
      fromCommand: boolean;
      /** Korlessa, Scale Singer's "cast Dragon spells from the top of your library". */
      fromLibraryTop?: boolean;
      fromExile?: boolean;
      x?: number;
      /** Which modal option was chosen (CR 601.2b), when `spellAbility.modes` is present. */
      mode?: number;
      /** Chosen modal subset; supersedes mode for ranged modal spells. */
      modes?: number[];
      alternativeCast?: 'overload' | 'adventure' | 'omen';
      altIndex?: number;
    }
  /** Activate `index` of the source permanent's `activatedAbilities` (CR 602). */
  | { kind: 'activateAbility'; objectId: ObjectId; index: number }
  | { kind: 'companionToHand' };

function addManaCosts(a: ParsedManaCost, b: ParsedManaCost): ParsedManaCost {
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
  };
}
export function selectedModeTargetSlots(def: CardDefinition, selectedModes: number[] | undefined): number[] | undefined {
  const modes = def.spellAbility?.modes;
  if (modes === undefined || selectedModes === undefined) return undefined;
  const chosen = selectedModes.map((index) => modes.options[index]);
  // Hand-authored legacy modes without ownership metadata retain their historical all-targets behavior.
  if (chosen.some((option) => option?.targetSlots === undefined)) return undefined;
  return [...new Set(chosen.flatMap((option) => option?.targetSlots ?? []))].sort((a, b) => a - b);
}

function modalSelections(def: CardDefinition): (number[] | undefined)[] {
  const modes = def.spellAbility?.modes;
  if (modes === undefined) return [undefined];
  const out: number[][] = [];
  const visit = (next: number, chosen: number[]): void => {
    if (chosen.length >= modes.minChoices && chosen.length <= modes.maxChoices) out.push([...chosen]);
    if (chosen.length === modes.maxChoices) return;
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
  }
  return total;
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
  const plan = planPayment(cost, player.manaEntries, sources, allows);
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
    .filter((rule): rule is Extract<(typeof def.ruleStatics)[number], { kind: 'costReduction' }> =>
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
    generic += evaluateValueIn(ctx, entry.static.amount, {
      controllerId: entry.controllerId,
      sourceCardId: entry.sourceCardId,
    });
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
      return types.includes('Artifact') || types.includes('Enchantment') || types.includes('Planeswalker');
    case 'nonlandPermanent':
      return !types.includes('Land');
    case 'permanent':
      return true;
    case 'anyTarget':
      return types.includes('Creature');
    case 'player':
    case 'spell':
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
export function computeTargetOptions(
  ctx: GameContext,
  spec: TargetKind | TargetSpec,
  casterId: PlayerId,
  /** The targeting source's colors, for protection (CR 702.16). Omitted ⇒ colorless. */
  sourceColors?: readonly Color[],
  /** The player associated with this trigger event, if target text refers to them. */
  eventPlayerId?: PlayerId,
): ObjectId[] {
  const { kind, controller, filter } =
    typeof spec === 'string' ? { kind: spec, controller: undefined, filter: undefined } : spec;

  if (kind === 'spell' || kind === 'noncreatureSpell') {
    return ctx.state.stack
      .filter((s) => s.kind === 'spell')
      .filter((s) => kind !== 'noncreatureSpell' || !isCreatureSpell(ctx, s))
      .filter(
        (s) =>
          controller === undefined ||
          (controller === 'you' ? s.controllerId === casterId : controller === 'opponent' ? s.controllerId !== casterId : s.controllerId === eventPlayerId),
      )
      .map((s) => s.id);
  }
  if (kind === 'commanderInCommandZone') {
    const player = playerById(ctx, casterId);
    return player.commandZone.filter((c) => c.isCommander).map((c) => c.id);
  }
  // A card in a graveyard, not a permanent — always the caster's own (see `TargetKind`).
  if (kind === 'cardInGraveyard') {
    return graveyardTargets(ctx, casterId, filter).map((c) => c.id);
  }
  const players = playersInApnapOrder(ctx).map((p) => p.id);
  if (kind === 'player') return players;

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
        (controller === 'you' ? p.controllerId === casterId : controller === 'opponent' ? p.controllerId !== casterId : p.controllerId === eventPlayerId),
    )
    .filter((p) => filter === undefined || matchesSelector(ctx, p, filter, { cardId: '', controllerId: casterId }))
    .map((p) => p.id);

  // "Any target" is creature-or-player (CR 115.4). Players are never hexproof-filtered.
  return kind === 'anyTarget' ? [...permanents, ...players] : permanents;
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
    const options = computeTargetOptions(ctx, spec, casterId);
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

  // "Your opponents can't cast spells during your turn" (Dragonlord Dromoka) — computed once;
  // it blocks every nonland cast source uniformly and never blocks playing a land (CR 305 —
  // a land is played, not cast).
  const spellCastingBlocked = castingSpellsBlockedFor(ctx, player.id);

  const considerCast = (
    obj: EngineCardObject,
    fromCommand: boolean,
    fromLibraryTop = false,
    fromExile = false,
  ): void => {
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
    requireModeled(
      def,
      fromLibraryTop ? 'on top of your library' : fromCommand ? 'in the command zone' : 'in hand',
    );

    if (def.types.includes('Land')) {
      // Korlessa's static only grants casting SPELLS from the library top, never playing a
      // land — nothing to offer here for that source.
      if (fromLibraryTop) return;
      // Lands are played, not cast — one per turn, main phase, empty stack (CR 305).
      if (sorcerySpeed && player.landsPlayedThisTurn < 1) {
        const producesMana = previewLandManaSymbols(ctx, def, player.id);
        const data: Record<string, unknown> = {
          producesMana,
          sourceName: obj.name,
          sourceZone: 'hand',
        };
        if (def.entersTappedUnless !== undefined) {
          if (def.entersTappedUnless.kind === 'mayPayLife') {
            data['payLifeToUntap'] = def.entersTappedUnless.n;
          } else {
            data['entersTappedConditional'] = true;
          }
        } else {
          data['entersTapped'] = def.entersTapped;
        }
        options.push({
          type: 'playLand',
          description: `Play ${obj.name}`,
          payload: { kind: 'playLand', objectId: obj.id },
          data,
        });
      }
      return;
    }

    if (spellCastingBlocked) return;
    if (def.manaCost === null) return; // cost-less nonland card: not castable
    const instantSpeed = def.types.includes('Instant') || def.keywords.includes('flash');
    if (!instantSpeed && !sorcerySpeed) return;

    const tax = fromCommand ? 2 * (player.commanderCastCount[obj.cardId] ?? 0) : 0;
    const reduction = costReductionFor(ctx, player.id, obj.oracleId, obj.cardId);
    let base = addGeneric(def.manaCost, tax);
    if (reduction.colored !== undefined) {
      base = subtractColored(base, reduction.colored);
    }
    base = subtractGeneric(base, reduction.generic);

    // {X} is announced as part of casting (CR 601.2b), so each affordable value of X is its own
    // option. Enumerated rather than asked as a follow-up decision because the option menu is
    // the contract: an action offered here must be applicable with no further legality check.
    // Restricted mana ("spend only to cast a Dragon spell") may or may not pay for THIS card,
    // so affordability is asked with the purpose attached — see `mana/cost.ts::ManaAllowance`.
    const allows = allowanceFor(ctx, player.id, { kind: 'castSpell', oracleId: obj.oracleId });

    const xSymbols = def.manaCost.x ?? 0;
    const xChoices: number[] = [];
    if (xSymbols === 0) xChoices.push(0);
    else {
      for (let x = 0; ; x++) {
        if (!canPay(withX(base, x), player.manaEntries, sources, allows)) break;
        xChoices.push(x);
      }
      if (xChoices.length === 0) return;
    }

    // A modal spell (CR 700.2) is announced with its mode chosen at cast time, before targets —
    // so each mode is its own cast option, the same "the option menu is the contract" treatment
    // {X} gets above. A non-modal spell has exactly one "mode" (undefined), so this loop is a
    // single iteration when `modes` is absent.
    const selections = modalSelections(def);

    for (const x of xChoices) {
      const cost = withX(base, x);
      if (!canPay(cost, player.manaEntries, sources, allows)) continue;

      for (const selectedModes of selections) {
        const targets = computeCastTargets(ctx, def, player.id, selectedModeTargetSlots(def, selectedModes));
        if (targets === null) continue;
        const additional = selectedModes?.flatMap((mode) => def.spellAbility?.modes?.options[mode]?.additionalCost ?? []) ?? [];
        const selectionCost = addManaCosts(cost, manaPortionOf(additional));
        if (!canPay(selectionCost, player.manaEntries, sources, allows)) continue;
        const modeLabel = selectedModes === undefined
          ? undefined
          : selectedModes.map((mode) => def.spellAbility?.modes?.options[mode]?.description ?? `mode ${mode + 1}`).join('; ');
        const option: EngineActionOption = {
          type: 'castSpell',
          description:
            `Cast ${obj.name} (${describeManaCost(selectionCost)})` +
            (xSymbols > 0 ? ` with X=${x}` : '') +
            (modeLabel !== undefined ? ` — ${modeLabel}` : '') +
            (fromCommand ? ` from the command zone${tax > 0 ? `, commander tax {${tax}}` : ''}` : '') +
            (fromLibraryTop ? ' from the top of your library' : '') +
            (fromExile ? ' from exile' : ''),
          payload: {
            kind: 'castSpell',
            objectId: obj.id,
            fromCommand,
            ...(fromLibraryTop ? { fromLibraryTop: true } : {}),
            ...(xSymbols > 0 ? { x } : {}),
            ...(selectedModes !== undefined ? { modes: selectedModes, ...(selectedModes.length === 1 ? { mode: selectedModes[0] } : {}) } : {}),
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
            ...(xSymbols > 0 ? { x } : {}),
            ...(modeLabel !== undefined ? { modeLabel } : {}),
          },
        };
        if (targets.length > 0) option.targets = targets;
        options.push(option);
      }
    }
    const applyRed = (c: ParsedManaCost): ParsedManaCost => {
      let b = c;
      if (reduction.colored !== undefined) {
        b = subtractColored(b, reduction.colored);
      }
      return subtractGeneric(b, reduction.generic);
    };

    if (def.alternativeCasts && def.alternativeCasts.length > 0 && !fromExile) {
      for (const [index, alt] of def.alternativeCasts.entries()) {
        if (alt.kind === 'overload') {
          const cost = applyRed(alt.manaCost);
          if (canPay(cost, player.manaEntries, sources, allows)) {
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
          const cost = applyRed(alt.manaCost);
          if (canPay(cost, player.manaEntries, sources, allows)) {
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
  for (const obj of castFromLibraryTopCandidates(ctx, player.id)) considerCast(obj, false, true);
  for (const obj of ctx.state.exile) {
    if (obj.ownerId === player.id && obj.onAdventure === true) {
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
        const allows = allowanceFor(ctx, player.id, { kind: 'castSpell', oracleId: cand.oracleId });
        if (canPay(cost, player.manaEntries, augmentedSources, allows)) unlocks.push(cand.name);
      }
      if (unlocks.length > 0) option.data = { ...option.data, unlocks };
    }
  }

  // Activated abilities of permanents this player controls (CR 602).
  for (const perm of ctx.state.battlefield) {
    if (perm.controllerId !== player.id) continue;
    const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
    for (const [index, activated] of def.activatedAbilities.entries()) {
      if (activated.timing === 'sorcery' && !sorcerySpeed) continue;
      // CR 602.5f — "activate only once each turn", tracked on the permanent.
      if (activated.oncePerTurn === true && perm.activationsThisTurn.includes(index)) continue;
      if (!canPayNonManaCosts(ctx, perm, activated.costs)) continue;
      // A cost that taps or sacrifices the source spends the source, so it cannot ALSO be
      // tapped for mana toward the same cost. `payActivationCosts` enforces the same thing by
      // paying the non-mana half first; excluding it here keeps the two in agreement.
      const spendsSelf = activated.costs.some(
        (c) => c.kind === 'tap' || c.kind === 'sacrificeSelf',
      );
      const usable = spendsSelf ? sources.filter((s) => s.cardId !== perm.cardId) : sources;
      const allows = allowanceFor(ctx, player.id, {
        kind: 'activateAbility',
        sourceOracleId: perm.oracleId,
      });
      const manaCost = manaPortionOf(activated.costs);
      if (!canPay(manaCost, player.manaEntries, usable, allows)) continue;

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
        let targetOptions = computeTargetOptions(ctx, spec, player.id);
        if (isAttachAbility && perm.attachedTo !== null) {
          targetOptions = targetOptions.filter((id) => id !== perm.attachedTo);
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
        description: `${perm.name}: ${activated.ability.description ?? 'activate ability'}`,
        payload: { kind: 'activateAbility', objectId: perm.id, index },
        data: {
          sourceName: perm.name,
          sourceZone: 'battlefield',
          abilityDescription: activated.ability.description ?? 'activate ability',
          manaCost: describeManaCost(manaCost),
          ...paymentPreview(ctx, player, manaCost, usable, allows),
          abilityCosts: activated.costs,
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

  // Companion: pay {3} at sorcery speed to move it to hand, once per game (brief §5.7).
  if (
    sorcerySpeed &&
    player.companion !== null &&
    !player.companionMovedToHand &&
    // No purpose: the companion {3} is neither casting nor activating, so restricted mana
    // cannot pay it — which is correct, and is what the default allowance expresses.
    canPay(COMPANION_COST, player.manaEntries, sources)
  ) {
    options.push({
      type: 'companionToHand',
      description: `Pay {3}: put your companion ${player.companion.name} into your hand`,
      payload: { kind: 'companionToHand' },
    });
  }

  // Phase-restricted action filtering: exclude temporary stat-buff abilities and combat
  // tricks during non-combat phases when no creatures are in combat. This prevents the
  // engine from querying the AI about Sacred Armory activation or Zealous Strike during
  // upkeep, main phases, and end steps — the AI always passes in these situations anyway.
  const inCombatPhase = s.phase === 'combat';
  const creaturesInCombat = ctx.state.battlefield.some(
    (p) => p.attacking !== null || p.blocking !== null,
  );
  if (!inCombatPhase && !creaturesInCombat) {
    const isCombatOnlyEffect = (effects: readonly import('../cards/ability').Effect[]): boolean =>
      effects.length > 0 &&
      effects.every(
        (e) => e.op === 'pumpUntilEot' || e.op === 'grantKeywordUntilEot',
      );

    const filtered = options.filter((opt) => {
      const payload = opt.payload as PriorityActionPayload | undefined;
      if (payload === undefined) return true;

      if (payload.kind === 'activateAbility') {
        const perm = ctx.state.battlefield.find((p) => p.id === payload.objectId);
        if (perm === undefined) return true;
        const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
        const activated = def.activatedAbilities[payload.index];
        if (activated === undefined) return true;
        return !isCombatOnlyEffect(activated.ability.effects);
      }

      if (payload.kind === 'castSpell') {
        // Find the card object in hand or command zone
        const allCards = [...player.hand, ...player.commandZone];
        const cardObj = allCards.find((c) => c.id === payload.objectId);
        if (cardObj === undefined) return true;
        const def = getDefByOracleId(ctx, cardObj.oracleId, cardObj.name);
        if (def.spellAbility === null) return true;
        // Only filter instant-speed combat tricks
        const isInstant = def.types.includes('Instant') || def.keywords.includes('flash');
        if (!isInstant) return true;
        return !isCombatOnlyEffect(def.spellAbility.effects);
      }

      return true;
    });

    // Only use filtered list if it still has at least one option (pass is always there)
    if (filtered.length > 0) return filtered;
  }

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
    const choice = chosen.get(slotNum);
    if (choice === undefined) {
      throw new Error(`missing target for slot ${slotNum} of ${def.name}`);
    }
    const legal = computeTargetOptions(ctx, spec, casterId);
    if (!legal.includes(choice)) {
      throw new Error(`illegal target ${choice} for slot ${slotNum} of ${def.name}`);
    }
    targets[slotNum] = choice;
  }
  return targets;
}

export { findPermanent };
