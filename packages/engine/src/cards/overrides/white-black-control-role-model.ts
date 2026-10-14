import { allOf, ofType, YOURS } from '../selector';
import { triggered, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlRoleModelOverrides(): void {
  const chosen = targetSlots({ creature: { kind: 'creature', count: { min: 0, max: 1 } } });
  replaceCard('8d24c12a-a300-4199-b2a9-3d5ead8df617', 'Reluctant Role Model', [
    'unrecognized rules text: "Survival — At the beginning of your second main phase, if this creature is tapped, put a flying, lifelink, or +1/+1 counter on it."',
    'unrecognized rules text: "Whenever this creature or another creature you control dies, if it had counters on it, put those counters on up to one target creature."',
  ], { keywords: [], triggers: [
    triggered({ when: 'secondMainPhase', player: 'you' }, {
      condition: { kind: 'not', of: { kind: 'isUntapped' } },
      effects: [{ op: 'chooseOne', options: ['flying', 'lifelink', '+1/+1'].map(counter => ({
        description: `Put a ${counter} counter on Reluctant Role Model`,
        effects: [{ op: 'putCounters', target: 'source', counter, count: constant(1) }],
      })) }], description: 'Survival: if tapped, choose a flying, lifelink, or +1/+1 counter',
    }),
    triggered({ when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) } }, {
      condition: { kind: 'triggerObjectMatches', selector: { kind: 'hasAnyCounter' } },
      targets: chosen.targets,
      effects: [{ op: 'transferCountersFromTriggerObjectToChosenCreatures', targetSlot: chosen.slot.creature }],
      description: 'Put the counters from the creature that died on up to one target creature',
    }),
  ] }, 'Survival checks tapped status at the second main phase and resolution; counter inheritance uses dying-object facts, optional counted targeting, replacements, and normal counter-placement events.');
}
