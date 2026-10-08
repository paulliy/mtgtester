import type { TargetSpec } from './ability';
import type { Selector } from './selector';
import { validateExpression } from './expression-validation';

interface CardTargetOptions {
  filter?: Selector;
  count?: { min: number; max: number };
}
function options(value: CardTargetOptions, allowed: readonly string[]): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error('target builder: unknown option');
  if (value.filter !== undefined) {
    const issues: { path: string; message: string }[] = [];
    validateExpression('selector', value.filter, 'target.filter', issues);
    if (issues.length) throw new Error('target builder: invalid selector');
  }
  if (
    value.count !== undefined &&
    (value.count === null ||
      typeof value.count !== 'object' ||
      Object.keys(value.count).some((key) => !['min', 'max'].includes(key)) ||
      !Number.isSafeInteger(value.count.min) ||
      value.count.min < 0 ||
      (!Number.isSafeInteger(value.count.max) && value.count.max !== Infinity) ||
      value.count.min > value.count.max)
  )
    throw new Error('target builder: invalid count bounds');
}

/** Explicitly choose an owner. 'controller' preserves the IR's established absent-key default. */
export function graveyardCardTarget(
  owner: 'controller' | 'opponent' | 'any' | { playerSlot: number },
  configuration: CardTargetOptions = {},
): TargetSpec {
  options(configuration, ['filter', 'count']);
  let ownership: Partial<TargetSpec>;
  if (typeof owner === 'string') {
    if (!['controller', 'opponent', 'any'].includes(owner))
      throw new Error('target builder: invalid graveyard owner');
    ownership = owner === 'controller' ? {} : { graveyardOwnerScope: owner };
  } else {
    if (
      owner === null ||
      typeof owner !== 'object' ||
      Array.isArray(owner) ||
      Object.keys(owner).length !== 1 ||
      !Object.hasOwn(owner, 'playerSlot') ||
      !Number.isSafeInteger(owner.playerSlot) ||
      owner.playerSlot < 0
    )
      throw new Error('target builder: invalid graveyard player slot');
    // The owning ability's semantic validator checks that this is an earlier ordinary player slot.
    ownership = { graveyardOwnerSlot: owner.playerSlot };
  }
  return {
    kind: 'cardInGraveyard',
    ...ownership,
    ...(configuration.filter === undefined ? {} : { filter: configuration.filter }),
    ...(configuration.count === undefined ? {} : { count: { ...configuration.count } }),
  };
}

/** A spell target retains all controllers unless the printed clause explicitly narrows them. */
export function counterSpellTarget(
  kind: 'spell' | 'noncreatureSpell' = 'spell',
  configuration: { filter?: Selector; controller?: 'you' | 'opponent' } = {},
): TargetSpec {
  options(configuration, ['filter', 'controller']);
  if (!['spell', 'noncreatureSpell'].includes(kind))
    throw new Error('target builder: countering requires a spell domain');
  if (
    configuration.controller !== undefined &&
    !['you', 'opponent'].includes(configuration.controller)
  )
    throw new Error('target builder: invalid spell controller');
  return {
    kind,
    ...(configuration.filter === undefined ? {} : { filter: configuration.filter }),
    ...(configuration.controller === undefined ? {} : { controller: configuration.controller }),
  };
}
