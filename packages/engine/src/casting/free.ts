import { castingPreviewContext } from './preview';
import { countTargetsCanComplete } from '../targets/announcement';
import type { ObjectId, PlayerId } from '@mtg/shared';
import {
  computeTargetOptions,
  costReductionFor,
  manaPortionOf,
  maxChoicesFor,
  modalSelections,
  modeAdditionalCosts,
  selectedModeTargetSlots,
  targetLifeTaxFor,
} from '../actions/legal';
import type { AbilityCost } from '../cards/ability';
import type { GameGen } from '../decisions';
import { addGeneric, subtractColored, subtractGeneric } from '../mana/cost';
import { planSpellPayment } from '../mana/spell-payment';
import { getDefByOracleId, castingSpellsBlockedFor } from '../state/queries';
import type { EngineCardObject, GameContext } from '../state/types';
import { castSpell } from './cast';
import { selectedSpellDefinition } from '../cards/spell-faces';
import type { CardDefinition } from '../cards/definition';
import { requireModeled } from '../state/queries';
import { spellManaValue } from '../state/objects';

interface FreeCastSelection {
  definition: CardDefinition;
  alternativeCast?: 'adventure' | 'omen';
  altIndex?: number;
  modes?: number[];
  optionalCostCount: number;
  targets: Map<number, ObjectId>;
}

/** The resolving instruction supplies the permission; timing is not ordinary priority timing. */
function legalFreeCastSelections(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
  manaValueLessThan = Infinity,
): FreeCastSelection[] {
  const player = ctx.state.players.find((candidate) => candidate.id === controllerId);
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  requireModeled(def, 'configuring a free cast');
  if (
    player === undefined ||
    player.hasLost ||
    def.types.includes('Land') ||
    castingSpellsBlockedFor(ctx, controllerId)
  )
    return [];
  // Permissions name a particular zone object, never merely its physical card identity.
  if (
    ![
      ...ctx.state.exile,
      ...ctx.state.players.flatMap((owner) => [
        ...owner.hand,
        ...owner.library,
        ...owner.graveyard,
        ...owner.commandZone,
      ]),
    ].includes(card)
  )
    return [];
  const selections: FreeCastSelection[] = [];
  const variants: {
    definition: CardDefinition;
    alternativeCast?: 'adventure' | 'omen';
    altIndex?: number;
  }[] = [{ definition: def }];
  for (const [altIndex, alternative] of (def.alternativeCasts ?? []).entries()) {
    if (alternative.kind === 'adventure' || alternative.kind === 'omen')
      variants.push({
        definition: selectedSpellDefinition(def, alternative),
        alternativeCast: alternative.kind,
        altIndex,
      });
  }
  for (const { definition, ...variant } of variants) {
    if (spellManaValue(definition, 0) >= manaValueLessThan) continue;
    const preview = castingPreviewContext(ctx, card, controllerId, definition);
    const previewPlayer = preview.state.players.find((candidate) => candidate.id === controllerId)!;
    const reduction = costReductionFor(
      preview,
      controllerId,
      card.oracleId,
      card.cardId,
      definition,
    );
    for (const modes of modalSelections(
      definition,
      maxChoicesFor(preview, definition, { cardId: card.cardId, controllerId }),
    )) {
      const active = selectedModeTargetSlots(definition, modes);
      let targetAssignments = [new Map<number, ObjectId>()];
      for (const [slot, spec] of (definition.spellAbility?.targets ?? []).entries()) {
        if (active !== undefined && !active.includes(slot)) continue;
        if (spec.count !== undefined) continue;
        targetAssignments = targetAssignments.flatMap((targets) => {
          const earlier: ObjectId[] = [];
          for (const [index, id] of targets) earlier[index] = id;
          return computeTargetOptions(
            preview,
            spec,
            controllerId,
            definition.colors,
            undefined,
            earlier,
            card.cardId,
          ).map((id) => new Map([...targets, [slot, id]]));
        });
      }
      const optional = definition.optionalAdditionalCost;
      for (
        let optionalCostCount = 0;
        optionalCostCount <= (optional === undefined ? 0 : optional.repeatable === true ? 100 : 1);
        optionalCostCount++
      ) {
        const costs: AbilityCost[] = [
          ...(definition.spellAdditionalCosts ?? []),
          ...modeAdditionalCosts(definition, modes),
        ];
        for (let i = 0; i < optionalCostCount; i++)
          costs.push({ kind: 'mana', cost: optional!.cost });
        const commanderTax =
          card.zone === 'command' ? 2 * (previewPlayer.commanderCastCount[card.cardId] ?? 0) : 0;
        let mana = addGeneric(manaPortionOf(costs), commanderTax);
        if (reduction.colored !== undefined) mana = subtractColored(mana, reduction.colored);
        mana = subtractGeneric(mana, reduction.generic);
        for (const targets of targetAssignments) {
          const ordinary: ObjectId[] = [];
          for (const [slot, id] of targets) ordinary[slot] = id;
          if (
            countTargetsCanComplete(
              preview,
              definition.spellAbility ?? { kind: 'spell', targets: [], effects: [] },
              {
                controllerId,
                sourceCardId: card.cardId,
                sourceColors: definition.colors,
                chosenTargets: ordinary,
                x: 0,
              },
              {},
              active,
              (counted) =>
                planSpellPayment(preview, previewPlayer, {
                  mana,
                  costs,
                  sourceCardId: card.cardId,
                  sourceOracleId: card.oracleId,
                  sourceIsCommander: card.isCommander,
                  spellDefinition: definition,
                  x: 0,
                  targetLifeTax: targetLifeTaxFor(preview, controllerId, [
                    ...targets.values(),
                    ...Object.values(counted).flat(),
                  ]),
                }) !== null,
            )
          )
            selections.push({
              definition,
              ...variant,
              ...(modes === undefined ? {} : { modes }),
              optionalCostCount,
              targets,
            });
        }
      }
    }
  }
  return selections;
}

export function freeCardIsCastable(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
  manaValueLessThan = Infinity,
): boolean {
  return legalFreeCastSelections(ctx, card, controllerId, manaValueLessThan).length > 0;
}

/** Free spells still announce, pay additional costs, and wait on the normal spell stack. */
export function* resolveFreeCard(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
  manaValueLessThan = Infinity,
): GameGen<void> {
  const selections = legalFreeCastSelections(ctx, card, controllerId, manaValueLessThan);
  if (selections.length === 0) return;
  const outcome = yield {
    decisionType: 'chooseTargets',
    player: controllerId,
    prompt: `Configure free-cast ${card.name}.`,
    options: selections.map((selection) => ({
      type: 'castFree',
      description:
        `Cast ${selection.definition.name}` +
        (selection.modes === undefined
          ? ''
          : ' — ' +
            selection.modes
              .map(
                (mode) =>
                  selection.definition.spellAbility?.modes?.options[mode]?.description ??
                  `mode ${mode + 1}`,
              )
              .join('; ')) +
        (selection.optionalCostCount === 0
          ? ''
          : ` — ${selection.definition.optionalAdditionalCost?.mechanic} ${selection.optionalCostCount}`),
      ...(selection.targets.size === 0
        ? {}
        : { targets: [...selection.targets].map(([slot, id]) => ({ slot, options: [id] })) }),
    })),
  };
  const selection = Number.isSafeInteger(outcome.index) ? selections[outcome.index] : undefined;
  if (selection === undefined) throw new Error('invalid free-cast configuration');
  if (
    outcome.targets.size !== selection.targets.size ||
    [...selection.targets].some(([slot, id]) => outcome.targets.get(slot) !== id)
  ) {
    throw new Error('invalid free-cast target response');
  }
  const player = ctx.state.players.find((candidate) => candidate.id === controllerId)!;
  yield* castSpell(
    ctx,
    player,
    {
      kind: 'castSpell',
      objectId: card.id,
      ...(selection.alternativeCast === undefined
        ? {}
        : { alternativeCast: selection.alternativeCast, altIndex: selection.altIndex }),
      fromCommand: card.zone === 'command',
      ...(card.zone === 'exile' ? { fromExile: true } : {}),
      ...(card.zone === 'graveyard' ? { fromGraveyard: true } : {}),
      ...(card.zone === 'library' ? { fromLibraryTop: true } : {}),
      ...(selection.modes === undefined ? {} : { modes: selection.modes }),
      ...(selection.optionalCostCount === 0
        ? {}
        : { optionalCostCount: selection.optionalCostCount }),
      ...(selection.definition.manaCost?.x !== undefined || selection.definition.announcesX === true
        ? { x: 0 }
        : {}),
    },
    { index: 0, targets: selection.targets },
    { card, withoutManaCost: true },
  );
}
