import type { TriggerHead } from './ability';
import type { AuthoringIssue } from './authoring-validation';
import { validateExpression } from './expression-validation';
import { assertNever } from '../utils/assert-never';

/** Every event belongs to an explicit dispatcher; new events require classification. */
export function triggerEventFamily(
  when: TriggerHead['when'],
): 'object' | 'cast' | 'step' | 'player' | 'attackDeclaration' {
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
    case 'leavesBattlefield':
    case 'transformsInto':
    case 'countersPut':
      return 'object';
    case 'castsSpell':
      return 'cast';
    case 'upkeep':
    case 'endStep':
    case 'untapStep':
    case 'drawStep':
    case 'beginningOfCombat':
    case 'endOfCombat':
    case 'mainPhase':
    case 'precombatMain':
      return 'step';
    case 'gainsLife':
    case 'drawsCard':
    case 'foretells':
    case 'damagePreventedToPlayer':
    case 'playerDealtDamage':
      return 'player';
    case 'attackDeclared':
      return 'attackDeclaration';
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
    case 'becomesTargeted':
    case 'castsSpell':
    case 'gainsLife':
    case 'drawsCard':
    case 'foretells':
    case 'damagePreventedToPlayer':
    case 'playerDealtDamage':
    case 'attackDeclared':
    case 'upkeep':
    case 'endStep':
    case 'untapStep':
    case 'drawStep':
    case 'beginningOfCombat':
    case 'endOfCombat':
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
    case 'dealtDamage':
    case 'sacrificed':
    case 'tokenCreated':
    case 'putIntoGraveyardFromAnywhere':
    case 'leavesGraveyard':
    case 'leavesBattlefield':
    case 'transformsInto':
    case 'countersPut':
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
      ? [
          'subject',
          'aggregate',
          'entersUntapped',
          'entersFrom',
          'entersWithoutManaSpentToCast',
          'leavesTo',
          'defendingPlayerIsEventPlayer',
          'withOtherAttackers',
          'counter',
          'byYou',
          'oncePerTurn',
        ]
      : family === 'cast'
        ? ['caster', 'filter', 'targetFilter', 'ordinal', 'castFrom']
        : family === 'attackDeclaration'
          ? ['attacker', 'attacking', 'perDefender', 'minAttackers']
          : ['player', ...(head['when'] === 'playerDealtDamage' ? ['sourceController'] : [])]),
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
      head['withOtherAttackers'] !== undefined &&
      (head['when'] !== 'attacks' ||
        typeof head['withOtherAttackers'] !== 'number' ||
        !Number.isInteger(head['withOtherAttackers']) ||
        head['withOtherAttackers'] < 1)
    )
      issues.push({
        path: `${path}.withOtherAttackers`,
        message: 'an attacker-count requirement needs an attacks event and a positive count',
      });
    if (
      head['entersWithoutManaSpentToCast'] !== undefined &&
      (head['entersWithoutManaSpentToCast'] !== true || head['when'] !== 'enters')
    )
      issues.push({
        path: `${path}.entersWithoutManaSpentToCast`,
        message: 'uncast or free entry restriction requires an enters event',
      });
    if (head['leavesTo'] !== undefined) {
      const zones = head['leavesTo'];
      if (
        head['when'] !== 'leavesBattlefield' ||
        !Array.isArray(zones) ||
        zones.length === 0 ||
        zones.some((zone) => zone !== 'graveyard' && zone !== 'exile')
      )
        issues.push({
          path: `${path}.leavesTo`,
          message: 'destination restriction requires a leaves-the-battlefield event',
        });
    }
    if (head['entersFrom'] !== undefined) {
      const origin = head['entersFrom'];
      const record =
        origin !== null && typeof origin === 'object' && !Array.isArray(origin)
          ? (origin as Record<string, unknown>)
          : undefined;
      if (
        head['when'] !== 'enters' ||
        record === undefined ||
        record['zone'] !== 'graveyard' ||
        (record['graveyardOwner'] !== undefined && record['graveyardOwner'] !== 'you') ||
        Object.keys(record).some((key) => !['zone', 'graveyardOwner'].includes(key))
      )
        issues.push({
          path: `${path}.entersFrom`,
          message: 'origin-zone entry restriction requires an enters event and a graveyard origin',
        });
    }
    if (
      head['defendingPlayerIsEventPlayer'] !== undefined &&
      (head['defendingPlayerIsEventPlayer'] !== true || head['when'] !== 'attacks')
    )
      issues.push({
        path: `${path}.defendingPlayerIsEventPlayer`,
        message: 'defending player requires an attacks event',
      });
    if (
      head['counter'] !== undefined &&
      (typeof head['counter'] !== 'string' || head['when'] !== 'countersPut')
    )
      issues.push({
        path: `${path}.counter`,
        message: 'a counter kind requires a countersPut event',
      });
    if (head['byYou'] !== undefined && (head['byYou'] !== true || head['when'] !== 'countersPut'))
      issues.push({
        path: `${path}.byYou`,
        message: 'a placing player requires a countersPut event',
      });
    if (head['oncePerTurn'] !== undefined && head['oncePerTurn'] !== true)
      issues.push({ path: `${path}.oncePerTurn`, message: 'once each turn is a flag' });
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
    if (
      head['castFrom'] !== undefined &&
      !['graveyard', 'notHand'].includes(head['castFrom'] as string)
    )
      issues.push({ path: `${path}.castFrom`, message: 'unknown spell origin restriction' });
  } else if (family === 'attackDeclaration') {
    if (
      !['you', 'opponent', 'otherPlayer', 'any', 'enchantedPlayer'].includes(
        head['attacker'] as string,
      )
    )
      issues.push({
        path: `${path}.attacker`,
        message: 'attack trigger requires an attacker scope',
      });
    const attacking = head['attacking'];
    if (attacking !== undefined) {
      const record =
        attacking !== null && typeof attacking === 'object' && !Array.isArray(attacking)
          ? (attacking as Record<string, unknown>)
          : undefined;
      if (
        record === undefined ||
        !['you', 'opponent', 'enchantedPlayer'].includes(record['who'] as string) ||
        typeof record['planeswalkers'] !== 'boolean' ||
        Object.keys(record).some((key) => !['who', 'planeswalkers'].includes(key))
      )
        issues.push({ path: `${path}.attacking`, message: 'attacked-player filter is malformed' });
    }
    if (head['perDefender'] !== undefined && head['perDefender'] !== true)
      issues.push({ path: `${path}.perDefender`, message: 'per-defender grouping is a flag' });
    if (
      head['minAttackers'] !== undefined &&
      (!Number.isSafeInteger(head['minAttackers']) || (head['minAttackers'] as number) < 1)
    )
      issues.push({
        path: `${path}.minAttackers`,
        message: 'attacker count must be a positive integer',
      });
  } else if (
    !(
      head['when'] === 'drawsCard'
        ? ['you', 'each', 'opponent']
        : head['when'] === 'foretells'
          ? ['you']
          : family === 'step' && !['mainPhase', 'precombatMain'].includes(head['when'] as string)
            ? ['you', 'each', 'enchanted']
            : ['you', 'each']
    ).includes(head['player'] as string)
  )
    issues.push({ path: `${path}.player`, message: 'trigger requires a supported player scope' });
  if (head['sourceController'] !== undefined && head['sourceController'] !== 'opponent')
    issues.push({
      path: `${path}.sourceController`,
      message: 'source controller restriction must be opponent',
    });
  if (head['condition'] !== undefined)
    validateExpression('condition', head['condition'], `${path}.condition`, issues);
}
