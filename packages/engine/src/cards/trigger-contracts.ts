import type { TriggerHead } from './ability';
import type { AuthoringIssue } from './authoring-validation';
import { validateExpression } from './expression-validation';
import { assertNever } from '../utils/assert-never';

/** Every event belongs to an explicit dispatcher; new events require classification. */
export function triggerEventFamily(
  when: TriggerHead['when'],
): 'object' | 'cast' | 'step' | 'player' {
  switch (when) {
    case 'enters':
    case 'dies':
    case 'attacks':
    case 'blocks':
    case 'becomesBlocked':
    case 'dealsCombatDamageToPlayer':
    case 'becomesTapped':
    case 'becomesCrewed':
    case 'fights':
    case 'becomesTargeted':
    case 'enchantedPlayerAttacked':
    case 'dealtDamage':
    case 'sacrificed':
    case 'tokenCreated':
    case 'putIntoGraveyardFromAnywhere':
    case 'leavesGraveyard':
    case 'transformsInto':
      return 'object';
    case 'castsSpell':
      return 'cast';
    case 'upkeep':
    case 'endStep':
    case 'untapStep':
    case 'drawStep':
    case 'beginningOfCombat':
    case 'mainPhase':
    case 'precombatMain':
      return 'step';
    case 'gainsLife':
    case 'drawsCard':
    case 'foretells':
      return 'player';
    default:
      return assertNever(when, 'trigger event dispatcher');
  }
}

/** Specialized dispatchers may not silently accept another event domain. */
export function assertTriggerEventFamily(
  when: TriggerHead['when'],
  family: ReturnType<typeof triggerEventFamily>,
): void {
  if (triggerEventFamily(when) !== family)
    throw new Error(`trigger event ${when} requires a different dispatcher`);
}

/** Delayed registrations currently have object and step dispatchers only. */
export function assertDelayedTriggerEvent(when: TriggerHead['when']): void {
  const family = triggerEventFamily(when);
  if (family !== 'object' && family !== 'step')
    throw new Error(`delayed trigger event ${when} has no supported dispatcher`);
}

/** Only these dispatchers bind a player independently of the ability controller. */
export function triggerProvidesEventPlayer(when: TriggerHead['when']): boolean {
  switch (when) {
    case 'attacks':
    case 'enchantedPlayerAttacked':
    case 'dealsCombatDamageToPlayer':
    case 'castsSpell':
    case 'gainsLife':
    case 'drawsCard':
    case 'foretells':
    case 'upkeep':
    case 'endStep':
    case 'untapStep':
    case 'drawStep':
    case 'beginningOfCombat':
    case 'mainPhase':
    case 'precombatMain':
      return true;
    case 'enters':
    case 'dies':
    case 'blocks':
    case 'becomesBlocked':
    case 'becomesTapped':
    case 'becomesCrewed':
    case 'fights':
    case 'becomesTargeted':
    case 'dealtDamage':
    case 'sacrificed':
    case 'tokenCreated':
    case 'putIntoGraveyardFromAnywhere':
    case 'leavesGraveyard':
    case 'transformsInto':
      return false;
    default:
      return assertNever(when, 'event player dispatcher');
  }
}

/** A union's combined field inventory is insufficient: each event has its own required shape. */
export function validateTriggerHead(value: unknown, path: string, issues: AuthoringIssue[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'trigger requires an event head' });
    return;
  }
  const head = value as Record<string, unknown>;
  let family: ReturnType<typeof triggerEventFamily>;
  try {
    family = triggerEventFamily(head['when'] as TriggerHead['when']);
  } catch {
    issues.push({ path: `${path}.when`, message: 'unknown trigger event' });
    return;
  }
  const allowed = [
    'when',
    'condition',
    ...(family === 'object'
      ? ['subject', 'aggregate', 'entersUntapped', 'defendingPlayerIsEventPlayer']
      : family === 'cast'
        ? ['caster', 'filter', 'targetFilter', 'ordinal']
        : ['player']),
  ];
  for (const key of Object.keys(head))
    if (!allowed.includes(key))
      issues.push({
        path: `${path}.${key}`,
        message: `field is incompatible with ${family} trigger`,
      });
  if (family === 'object') {
    const subject = head['subject'];
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject))
      issues.push({ path: `${path}.subject`, message: 'object trigger requires a subject' });
    else {
      const record = subject as Record<string, unknown>;
      const kind = record['kind'];
      if (kind !== 'self' && kind !== 'permanent')
        issues.push({ path: `${path}.subject`, message: 'unknown object trigger subject' });
      for (const key of Object.keys(record))
        if (key !== 'kind' && !(kind === 'permanent' && key === 'selector'))
          issues.push({
            path: `${path}.subject.${key}`,
            message: 'incompatible trigger subject field',
          });
      if (kind === 'permanent')
        validateExpression('selector', record['selector'], `${path}.subject.selector`, issues);
    }
    if (
      head['aggregate'] !== undefined &&
      ![true, false, 'byEventPlayer'].includes(head['aggregate'] as boolean | string)
    )
      issues.push({ path: `${path}.aggregate`, message: 'invalid trigger aggregation' });
    if (
      head['entersUntapped'] !== undefined &&
      (head['entersUntapped'] !== true || head['when'] !== 'enters')
    )
      issues.push({
        path: `${path}.entersUntapped`,
        message: 'untapped entry restriction requires an enters event',
      });
    if (
      head['defendingPlayerIsEventPlayer'] !== undefined &&
      (head['defendingPlayerIsEventPlayer'] !== true || head['when'] !== 'attacks')
    )
      issues.push({
        path: `${path}.defendingPlayerIsEventPlayer`,
        message: 'defending player requires an attacks event',
      });
  } else if (family === 'cast') {
    if (!['you', 'opponent', 'each'].includes(head['caster'] as string))
      issues.push({
        path: `${path}.caster`,
        message: 'spell trigger requires an explicit caster scope',
      });
    for (const key of ['filter', 'targetFilter'])
      if (head[key] !== undefined)
        validateExpression('selector', head[key], `${path}.${key}`, issues);
    if (
      head['ordinal'] !== undefined &&
      (!Number.isSafeInteger(head['ordinal']) || (head['ordinal'] as number) < 1)
    )
      issues.push({ path: `${path}.ordinal`, message: 'spell ordinal must be a positive integer' });
  } else if (
    !(
      head['when'] === 'drawsCard'
        ? ['you', 'each', 'opponent']
        : head['when'] === 'foretells'
          ? ['you']
          : ['you', 'each']
    ).includes(head['player'] as string)
  )
    issues.push({ path: `${path}.player`, message: 'trigger requires a supported player scope' });
  if (head['condition'] !== undefined)
    validateExpression('condition', head['condition'], `${path}.condition`, issues);
}
