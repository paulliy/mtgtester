import type { TriggerHead } from './ability';
import type { AuthoringIssue } from './authoring-validation';
import { validateExpression } from './expression-validation';
import { assertNever } from '../utils/assert-never';

/** Every event belongs to an explicit dispatcher; new events require classification. */
export function triggerEventFamily(
  when: TriggerHead['when'],
): 'object' | 'cast' | 'step' | 'player' | 'attackDeclaration' | 'card' {
  switch (when) {
    case 'discardsCard':
      return 'card';
    case 'enters':
    case 'dies':
    case 'attacks':
    case 'blocks':
    case 'becomesBlocked':
    case 'dealsCombatDamageToPlayer':
    case 'dealsDamageToOpponent':
    case 'becomesTapped':
    case 'becomesCrewed':
    case 'turnedFaceUp':
    case 'fights':
    case 'becomesTargeted':
    case 'enchantedPlayerAttacked':
    case 'attacksUnblocked':
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
    case 'secondMainPhase':
      return 'step';
    case 'gainsLife':
    case 'losesLife':
    case 'drawsCard':
    case 'foretells':
    case 'activatesAbility':
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
    case 'discardsCard':
      return true;
    case 'attacks':
    case 'enchantedPlayerAttacked':
    case 'attacksUnblocked':
    case 'dealsCombatDamageToPlayer':
    case 'becomesTargeted':
    case 'dealsDamageToOpponent':
    case 'castsSpell':
    case 'gainsLife':
    case 'losesLife':
    case 'drawsCard':
    case 'foretells':
    case 'activatesAbility':
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
    case 'secondMainPhase':
      return true;
    case 'enters':
    case 'dies':
    case 'blocks':
    case 'becomesBlocked':
    case 'becomesTapped':
    case 'becomesCrewed':
    case 'turnedFaceUp':
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
    ...(head['when'] === 'attacks' ? ['eventCondition'] : []),
    ...(family === 'object'
      ? [
          'subject',
          'aggregate',
          'fromAnyOrigin',
          'entersUntapped',
          'entersFrom',
          'entersWithoutManaSpentToCast',
          'leavesTo',
          'defendingPlayerIsEventPlayer',
          'attackingPlayerIsEventPlayer',
          'subjectControllerIsEventPlayer',
          'withOtherAttackers',
          'counter',
          'chapter',
          'byYou',
          'forMana',
          'oncePerTurn',
        ]
      : family === 'cast'
        ? ['caster', 'filter', 'targetFilter', 'ordinal', 'castFrom']
        : family === 'attackDeclaration'
          ? ['attacker', 'attacking', 'perDefender', 'minAttackers', 'attackerFilter']
          : family === 'card'
            ? ['player', 'filter']
            : [
                'player',
                ...(head['when'] === 'playerDealtDamage' ? ['sourceController'] : []),
                ...(head['when'] === 'activatesAbility' ? ['lifePaid'] : []),
                ...(head['when'] === 'losesLife' ? ['firstTimeEachTurn'] : []),
                ...(head['when'] === 'drawsCard' ? ['ordinalThisTurn'] : []),
              ]),
  ];
  for (const key of Object.keys(head))
    if (!allowed.includes(key))
      issues.push({
        path: `${path}.${key}`,
        message: `field is incompatible with ${family} trigger`,
      });
  if (family === 'object') {
    if (
      head['fromAnyOrigin'] !== undefined &&
      (head['fromAnyOrigin'] !== true || head['when'] !== 'putIntoGraveyardFromAnywhere')
    )
      issues.push({
        path: `${path}.fromAnyOrigin`,
        message: 'all-origin graveyard entry requires its card-zone event and true flag',
      });
    if (
      head['when'] === 'dealsDamageToOpponent' &&
      (head['subject'] as { kind?: string } | undefined)?.kind !== 'self'
    )
      issues.push({
        path: `${path}.subject`,
        message: "opponent damage currently supports only the damaging source's own ability",
      });
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
        (record['orCastFrom'] !== undefined && record['orCastFrom'] !== true) ||
        Object.keys(record).some((key) => !['zone', 'graveyardOwner', 'orCastFrom'].includes(key))
      )
        issues.push({
          path: `${path}.entersFrom`,
          message: 'origin-zone entry restriction requires an enters event and a graveyard origin',
        });
    }
    if (
      head['defendingPlayerIsEventPlayer'] !== undefined &&
      (head['defendingPlayerIsEventPlayer'] !== true ||
        !['attacks', 'attacksUnblocked'].includes(String(head['when'])))
    )
      issues.push({
        path: `${path}.defendingPlayerIsEventPlayer`,
        message: 'defending player requires an attacks event',
      });
    if (
      head['attackingPlayerIsEventPlayer'] !== undefined &&
      (head['attackingPlayerIsEventPlayer'] !== true ||
        head['when'] !== 'attacks' ||
        head['aggregate'] !== 'byEventPlayer' ||
        head['defendingPlayerIsEventPlayer'] !== undefined)
    )
      issues.push({
        path: `${path}.attackingPlayerIsEventPlayer`,
        message:
          'attacking player binding requires defender-grouped attacks without a defending-player binding',
      });
    if (
      head['subjectControllerIsEventPlayer'] !== undefined &&
      (head['subjectControllerIsEventPlayer'] !== true ||
        head['when'] !== 'dies' ||
        (head['subject'] as { kind?: string } | undefined)?.kind !== 'permanent' ||
        head['aggregate'] !== undefined)
    )
      issues.push({
        path: `${path}.subjectControllerIsEventPlayer`,
        message: "the dying permanent's controller binding requires a per-permanent dies event",
      });
    if (
      head['counter'] !== undefined &&
      (typeof head['counter'] !== 'string' || head['when'] !== 'countersPut')
    )
      issues.push({
        path: `${path}.counter`,
        message: 'a counter kind requires a countersPut event',
      });
    if (
      head['chapter'] !== undefined &&
      (head['when'] !== 'countersPut' ||
        head['counter'] !== 'lore' ||
        (head['subject'] as { kind?: string } | undefined)?.kind !== 'self' ||
        typeof head['chapter'] !== 'number' ||
        !Number.isInteger(head['chapter']) ||
        head['chapter'] < 1)
    )
      issues.push({
        path: `${path}.chapter`,
        message: "a chapter ability is a positive lore-counter crossing of the Saga's own counters",
      });
    if (head['byYou'] !== undefined && (head['byYou'] !== true || head['when'] !== 'countersPut'))
      issues.push({
        path: `${path}.byYou`,
        message: 'a placing player requires a countersPut event',
      });
    if (
      head['forMana'] !== undefined &&
      (head['forMana'] !== true || head['when'] !== 'becomesTapped')
    )
      issues.push({
        path: `${path}.forMana`,
        message: 'tapped for mana requires a becomesTapped event',
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
      !['graveyard', 'notHand', 'hand'].includes(head['castFrom'] as string)
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
        (record['planeswalkersOnly'] !== undefined &&
          (record['planeswalkersOnly'] !== true || record['planeswalkers'] !== true)) ||
        Object.keys(record).some(
          (key) => !['who', 'planeswalkers', 'planeswalkersOnly'].includes(key),
        )
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
  } else if (family === 'card') {
    if (!['you', 'each', 'opponent'].includes(head['player'] as string))
      issues.push({
        path: `${path}.player`,
        message: 'card trigger requires a supported player scope',
      });
    if (head['filter'] !== undefined)
      validateExpression('selector', head['filter'], `${path}.filter`, issues);
  } else if (
    !(
      head['when'] === 'drawsCard'
        ? ['you', 'each', 'opponent']
        : head['when'] === 'foretells' || head['when'] === 'activatesAbility'
          ? ['you']
          : family === 'step' && !['mainPhase', 'precombatMain'].includes(head['when'] as string)
            ? [
                'you',
                'each',
                'enchanted',
                // "At the beginning of each opponent's upkeep / end step / combat".
                ...(head['when'] === 'upkeep' ||
                head['when'] === 'endStep' ||
                head['when'] === 'beginningOfCombat'
                  ? ['opponent']
                  : []),
              ]
            : ['you', 'each']
    ).includes(head['player'] as string)
  )
    issues.push({ path: `${path}.player`, message: 'trigger requires a supported player scope' });
  if (head['sourceController'] !== undefined && head['sourceController'] !== 'opponent')
    issues.push({
      path: `${path}.sourceController`,
      message: 'source controller restriction must be opponent',
    });
  if (head['lifePaid'] !== undefined && head['lifePaid'] !== true)
    issues.push({ path: `${path}.lifePaid`, message: 'life paid qualification requires true' });
  if (head['condition'] !== undefined)
    validateExpression('condition', head['condition'], `${path}.condition`, issues);
  if (head['eventCondition'] !== undefined)
    validateExpression('condition', head['eventCondition'], `${path}.eventCondition`, issues);
}
