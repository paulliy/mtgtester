import type { PlayerId } from '@mtg/shared';
import type { DamageKeyword, EngineStackObject, GameContext } from '../state/types';
import { spellDefinitionOf } from '../state/queries';

/** CR 707.10: a spell copy is a separate stack object, never a cast or a physical card. */
export function queueSpellCopy(
  ctx: GameContext,
  original: EngineStackObject,
  controllerId: PlayerId,
): EngineStackObject {
  if (original.kind !== 'spell' || original.castInProgress || original.ability?.kind !== 'spell')
    throw new Error('only a completed executable spell can be copied');
  const definition = spellDefinitionOf(ctx, original);
  const id = `o-${ctx.state.nextObjectNum++}`;
  const copy: EngineStackObject = {
    ...original,
    ...(original.triggerScope === undefined
      ? {}
      : { triggerScope: { ...original.triggerScope, manaSpent: 0, treasureManaSpent: 0 } }),
    id,
    sourceId: id,
    card: null,
    description: `Copy of ${original.description}`,
    controllerId,
    sourceCardId: id,
    sourceOracleId: original.sourceOracleId,
    spellDefinition: definition,
    sourceColors: [...definition.colors],
    isCommanderCast: false,
    sourceDamageKeywords:
      original.sourceDamageKeywords === undefined
        ? definition.keywords.filter((keyword): keyword is DamageKeyword =>
            ['infect', 'lifelink', 'deathtouch'].includes(keyword),
          )
        : [...original.sourceDamageKeywords],
    targets: [...original.targets],
    ...(original.countTargets === undefined
      ? {}
      : {
          countTargets: Object.fromEntries(
            Object.entries(original.countTargets).map(([slot, targets]) => [slot, [...targets]]),
          ),
        }),
    ...(original.divisionAmounts === undefined
      ? {}
      : { divisionAmounts: { ...original.divisionAmounts } }),
    ...(original.optionalCostCounts === undefined
      ? {}
      : { optionalCostCounts: { ...original.optionalCostCounts } }),
  };
  ctx.state.stack.push(copy);
  return copy;
}
