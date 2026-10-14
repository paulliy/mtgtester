import { OPPONENTS, SELF } from '../selector';
import { triggered } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlGraveyardTriggerOverrides(): void {
  replaceCard('994e27e1-0bff-47c9-a1e6-b9e3ae4ffb1e', 'Planar Void', [
    'unrecognized rules text: "Whenever another card is put into a graveyard from anywhere, exile that card."',
  ], { triggers: [triggered({ when: 'putIntoGraveyardFromAnywhere', fromAnyOrigin: true, subject: { kind: 'permanent', selector: { kind: 'other' } } }, {
    effects: [{ op: 'exileGraveyardEventCard' }], description: 'Exile that card from its graveyard',
  })] }, 'Queues a real trigger after any card enters a graveyard; remembers its exact incarnation and excludes itself and tokens.');
  replaceCard('e70f5520-1b9c-4351-8484-30f0dc692e01', 'The Haunt of Hightower', [
    'unrecognized rules text: "Whenever ~ attacks, defending player discards a card."',
    'unrecognized rules text: "Whenever a card is put into an opponent\'s graveyard from anywhere, put a +1/+1 counter on ~."',
  ], { triggers: [
    triggered({ when: 'attacks', subject: { kind: 'self' }, defendingPlayerIsEventPlayer: true }, {
      effects: [{ op: 'discardTarget', target: 'eventPlayer', count: constant(1) }], description: 'Defending player discards a card',
    }),
    triggered({ when: 'putIntoGraveyardFromAnywhere', fromAnyOrigin: true, subject: { kind: 'permanent', selector: OPPONENTS } }, {
      effects: [{ op: 'putCountersEach', selector: SELF, counter: '+1/+1', count: 1 }], description: 'Put a +1/+1 counter on this creature',
    }),
  ] }, 'Uses defending player attack binding and actual all-origin opponent-owned graveyard card events, preserving flying and lifelink.');
}
