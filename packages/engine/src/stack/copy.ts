import type { ObjectId, PlayerId } from '@mtg/shared';
import type { Ability, Effect } from '../cards/ability';
import type { CardDefinition } from '../cards/definition';
import { isPermanentCard } from '../cards/definition';
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

/**
 * One of Replicate's copies (CR 702.56a): a copy of the cast spell with the targets its
 * controller kept or chose (CR 707.10c). A copy of a permanent spell becomes a token as it
 * resolves (CR 707.10f). If the spell has left the stack, its last known information is copied.
 */
export function queueReplicateCopy(
  ctx: GameContext,
  controllerId: PlayerId,
  spell: Extract<Effect, { op: 'replicateCopies' }>['spell'],
  original: EngineStackObject | undefined,
  def: CardDefinition,
  ability: Ability,
  targets: ObjectId[],
): EngineStackObject {
  const permanent = isPermanentCard(def);
  const copyId = `o-${ctx.state.nextObjectNum++}` as ObjectId;
  const copy: EngineStackObject = {
    id: copyId,
    sourceId: copyId,
    controllerId,
    kind: 'spell',
    description: `Copy of ${spell.name}`,
    targets,
    card: null,
    ability,
    sourceOracleId: spell.oracleId,
    spellDefinition: def,
    sourceColors: [...def.colors],
    // A permanent copy's token takes this id as it resolves; a nonpermanent copy just needs
    // one that is not the original card's.
    sourceCardId: `tok-${ctx.state.nextObjectNum++}`,
    isCommanderCast: false,
    ...(original?.announcedX !== undefined ? { announcedX: original.announcedX } : {}),
    // A copy copies every decision made for the spell (CR 707.10), into its own records.
    ...(original?.countTargets !== undefined
      ? {
          countTargets: Object.fromEntries(
            Object.entries(original.countTargets).map(([slot, ids]) => [slot, [...ids]]),
          ),
        }
      : {}),
    ...(original?.divisionAmounts !== undefined
      ? { divisionAmounts: { ...original.divisionAmounts } }
      : {}),
    ...(permanent
      ? {
          permanentSpellCopy: {
            oracleText: original?.card?.oracleText ?? spell.oracleText,
            manaCost: original?.card?.manaCost ?? spell.manaCost,
          },
        }
      : {}),
  };
  ctx.state.stack.push(copy);
  return copy;
}
