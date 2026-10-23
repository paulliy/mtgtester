import type { ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type { Ability, Effect, StackAbilitySnapshot } from '../cards/ability';
import type { CardDefinition } from '../cards/definition';
import { isPermanentCard } from '../cards/definition';
import type { DamageKeyword, EngineStackObject, GameContext } from '../state/types';
import { getDefByOracleId, spellDefinitionOf } from '../state/queries';

/** CR 707.10: a spell copy is a separate stack object, never a cast or a physical card. */
export function queueSpellCopy(
  ctx: GameContext,
  original: EngineStackObject,
  controllerId: PlayerId,
): EngineStackObject {
  if (original.kind !== 'spell' || original.castInProgress || original.ability?.kind !== 'spell')
    throw new Error('only a completed executable spell can be copied');
  const definition = spellDefinitionOf(ctx, original);
  const modalText =
    original.alternativeCastKind === 'mdfc'
      ? getDefByOracleId(ctx, original.sourceOracleId, original.description).alternativeCasts?.find(
          (alt) => alt.kind === 'mdfc' && alt.spellFace?.name === definition.name,
        )?.spellFaceText
      : undefined;
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
    ...(isPermanentCard(definition)
      ? {
          permanentSpellCopy: {
            oracleText:
              original.permanentSpellCopy?.oracleText ??
              modalText?.oracleText ??
              original.card?.oracleText ??
              '',
            manaCost:
              original.permanentSpellCopy?.manaCost ??
              modalText?.manaCost ??
              original.card?.manaCost ??
              null,
          },
        }
      : {}),
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
  // Addendum asks whether the spell was CAST in a main phase; a copy was never cast.
  delete copy.castDuringOwnMainPhase;
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
    ...((original?.optionalCostCounts ?? spell.optionalCostCounts) === undefined
      ? {}
      : { optionalCostCounts: { ...(original?.optionalCostCounts ?? spell.optionalCostCounts) } }),
    ...((original?.wasKicked ?? spell.wasKicked) === undefined
      ? {}
      : { wasKicked: original?.wasKicked ?? spell.wasKicked }),
    ...((original?.kicked ?? spell.kicked) === undefined
      ? {}
      : { kicked: original?.kicked ?? spell.kicked }),
    ...((original?.announcedX ?? spell.announcedX) !== undefined
      ? { announcedX: original?.announcedX ?? spell.announcedX }
      : {}),
    // A copy copies every decision made for the spell (CR 707.10), into its own records.
    ...((original?.countTargets ?? spell.countTargets) !== undefined
      ? {
          countTargets: Object.fromEntries(
            Object.entries(original?.countTargets ?? spell.countTargets!).map(([slot, ids]) => [
              slot,
              [...ids],
            ]),
          ),
        }
      : {}),
    ...((original?.divisionAmounts ?? spell.divisionAmounts) !== undefined
      ? { divisionAmounts: { ...(original?.divisionAmounts ?? spell.divisionAmounts) } }
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

/**
 * A copy of an activated or triggered ability (CR 707.10): same source, same decisions, a new
 * controller. It is not activated or triggered, so it fires nothing that watches those events.
 * Made from last known information when the original has already left the stack.
 */
export function queueAbilityCopy(
  ctx: GameContext,
  original: StackAbilitySnapshot,
  controllerId: PlayerId,
): EngineStackObject {
  const id = `o-${ctx.state.nextObjectNum++}` as ObjectId;
  const copy: EngineStackObject = {
    id,
    sourceId: original.sourceId as ObjectId,
    controllerId,
    kind: original.kind,
    description: `Copy of ${original.description}`,
    targets: [...original.targets] as ObjectId[],
    ...(original.countTargets === undefined
      ? {}
      : {
          countTargets: Object.fromEntries(
            Object.entries(original.countTargets).map(([slot, ids]) => [slot, [...ids]]),
          ) as Record<number, ObjectId[]>,
        }),
    ...(original.divisionAmounts === undefined
      ? {}
      : { divisionAmounts: { ...original.divisionAmounts } }),
    ...(original.announcedX === undefined ? {} : { announcedX: original.announcedX }),
    card: null,
    ability: original.ability,
    sourceOracleId: original.sourceOracleId as OracleId,
    sourceCardId: original.sourceCardId,
    ...(original.sourceColors === undefined ? {} : { sourceColors: [...original.sourceColors] }),
    ...(original.sourceFacts === undefined ? {} : { sourceFacts: original.sourceFacts }),
    ...(original.sourceDamageKeywords === undefined
      ? {}
      : { sourceDamageKeywords: [...original.sourceDamageKeywords] }),
    ...(original.triggerScope === undefined ? {} : { triggerScope: { ...original.triggerScope } }),
    ...(original.triggerObjectCardId === undefined
      ? {}
      : { triggerObjectCardId: original.triggerObjectCardId }),
    isCommanderCast: false,
  };
  ctx.state.stack.push(copy);
  return copy;
}
