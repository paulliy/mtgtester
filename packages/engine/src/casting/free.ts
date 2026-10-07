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

interface FreeCastSelection {
  modes?: number[];
  optionalCostCount: number;
  targets: Map<number, ObjectId>;
}

/** The resolving instruction supplies the permission; timing is not ordinary priority timing. */
function legalFreeCastSelections(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
): FreeCastSelection[] {
  const player = ctx.state.players.find((candidate) => candidate.id === controllerId);
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  if (
    player === undefined ||
    player.hasLost ||
    !def.modeled ||
    def.types.includes('Land') ||
    castingSpellsBlockedFor(ctx, controllerId)
  )
    return [];
  const preview = castingPreviewContext(ctx, card, controllerId);
  const previewPlayer = preview.state.players.find((candidate) => candidate.id === controllerId)!;
  const selections: FreeCastSelection[] = [];
  const reduction = costReductionFor(preview, controllerId, card.oracleId, card.cardId);
  for (const modes of modalSelections(
    def,
    maxChoicesFor(preview, def, { cardId: card.cardId, controllerId }),
  )) {
    const active = selectedModeTargetSlots(def, modes);
    let targetAssignments = [new Map<number, ObjectId>()];
    for (const [slot, spec] of (def.spellAbility?.targets ?? []).entries()) {
      if (active !== undefined && !active.includes(slot)) continue;
      if (spec.count !== undefined) continue;
      targetAssignments = targetAssignments.flatMap((targets) => {
        const earlier: ObjectId[] = [];
        for (const [index, id] of targets) earlier[index] = id;
        return computeTargetOptions(
          preview,
          spec,
          controllerId,
          def.colors,
          undefined,
          earlier,
          card.cardId,
        ).map((id) => new Map([...targets, [slot, id]]));
      });
    }
    const optional = def.optionalAdditionalCost;
    for (
      let optionalCostCount = 0;
      optionalCostCount <= (optional === undefined ? 0 : optional.repeatable === true ? 100 : 1);
      optionalCostCount++
    ) {
      const costs: AbilityCost[] = [
        ...(def.spellAdditionalCosts ?? []),
        ...modeAdditionalCosts(def, modes),
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
            def.spellAbility ?? { kind: 'spell', targets: [], effects: [] },
            {
              controllerId,
              sourceCardId: card.cardId,
              sourceColors: def.colors,
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
                x: 0,
                targetLifeTax: targetLifeTaxFor(preview, controllerId, [
                  ...targets.values(),
                  ...Object.values(counted).flat(),
                ]),
              }) !== null,
          )
        )
          selections.push({
            ...(modes === undefined ? {} : { modes }),
            optionalCostCount,
            targets,
          });
      }
    }
  }
  return selections;
}

export function freeCardIsCastable(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
): boolean {
  return legalFreeCastSelections(ctx, card, controllerId).length > 0;
}

/** Free spells still announce, pay additional costs, and wait on the normal spell stack. */
export function* resolveFreeCard(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId: PlayerId,
): GameGen<void> {
  const selections = legalFreeCastSelections(ctx, card, controllerId);
  if (selections.length === 0) return;
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  const outcome = yield {
    decisionType: 'chooseTargets',
    player: controllerId,
    prompt: `Configure free-cast ${card.name}.`,
    options: selections.map((selection) => ({
      type: 'castFree',
      description:
        `Cast ${card.name}` +
        (selection.modes === undefined
          ? ''
          : ' — ' +
            selection.modes
              .map(
                (mode) => def.spellAbility?.modes?.options[mode]?.description ?? `mode ${mode + 1}`,
              )
              .join('; ')) +
        (selection.optionalCostCount === 0
          ? ''
          : ` — ${def.optionalAdditionalCost?.mechanic} ${selection.optionalCostCount}`),
      ...(selection.targets.size === 0
        ? {}
        : { targets: [...selection.targets].map(([slot, id]) => ({ slot, options: [id] })) }),
    })),
  };
  const selection = selections[outcome.index];
  if (selection === undefined) throw new Error('invalid free-cast configuration');
  const player = ctx.state.players.find((candidate) => candidate.id === controllerId)!;
  yield* castSpell(
    ctx,
    player,
    {
      kind: 'castSpell',
      objectId: card.id,
      fromCommand: card.zone === 'command',
      ...(card.zone === 'exile' ? { fromExile: true } : {}),
      ...(card.zone === 'graveyard' ? { fromGraveyard: true } : {}),
      ...(card.zone === 'library' ? { fromLibraryTop: true } : {}),
      ...(selection.modes === undefined ? {} : { modes: selection.modes }),
      ...(selection.optionalCostCount === 0
        ? {}
        : { optionalCostCount: selection.optionalCostCount }),
      ...(def.manaCost?.x !== undefined || def.announcesX === true ? { x: 0 } : {}),
    },
    { index: 0, targets: selection.targets },
    { card, withoutManaCost: true },
  );
}
