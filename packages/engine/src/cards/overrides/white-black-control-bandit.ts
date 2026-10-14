import { SELF } from '../selector';
import { activated, mana, triggered } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlBanditOverrides(): void {
  replaceCard('bcbe879a-4609-4493-bd7d-47c26d27e83c', "Bandit's Talent", [
    'unsupported layout "class"',
    'unrecognized rules text: "When this Class enters, each opponent discards two cards unless they discard a nonland card."',
    'unrecognized rules text: "{B}: Level 2"',
    'unrecognized rules text: "At the beginning of each opponent\'s upkeep, if that player has one or fewer cards in hand, they lose 2 life."',
    'unrecognized rules text: "{3}{B}: Level 3"',
    'unrecognized rules text: "At the beginning of your draw step, draw an additional card for each opponent who has one or fewer cards in hand."',
  ], {
    triggers: [triggered({ when: 'enters', subject: { kind: 'self' } }, {
      effects: [{ op: 'discardEachPlayer', scope: 'opponents', count: constant(2), nonlandMaySatisfyCount: true }],
      description: 'Each opponent discards two cards unless they discard a nonland card',
    })],
    activatedAbilities: [
      { ...activated({ costs: [mana('{B}')], timing: 'sorcery', effects: [{ op: 'gainClassLevel', level: 2 }], description: 'Gain Class level 2' }),
        condition: { kind: 'sourceClassLevel', cmp: '==', n: 1 } },
      { ...activated({ costs: [mana('{3}{B}')], timing: 'sorcery', effects: [{ op: 'gainClassLevel', level: 3 }], description: 'Gain Class level 3' }),
        condition: { kind: 'sourceClassLevel', cmp: '==', n: 2 } },
    ],
    staticEffects: [
      { affects: SELF, condition: { kind: 'sourceClassLevel', cmp: '>=', n: 2 }, op: { layer: 6,
        addTrigger: triggered({ when: 'upkeep', player: 'opponent' }, {
          condition: { kind: 'eventPlayerHandSize', cmp: '<=', n: 1 },
          effects: [{ op: 'loseLifeTarget', target: 'eventPlayer', amount: constant(2) }],
          description: 'If the upkeep player has one or fewer cards, they lose 2 life',
        }) } },
      { affects: SELF, condition: { kind: 'sourceClassLevel', cmp: '>=', n: 3 }, op: { layer: 6,
        addTrigger: triggered({ when: 'drawStep', player: 'you' }, {
          effects: [{ op: 'drawForOpponentsWithSmallHands', maximum: 1 }],
          description: 'Draw an additional card for each opponent with one or fewer cards',
        }) } },
    ],
  }, 'Class levels advance sequentially through sorcery-speed paid activations; gained abilities are live layer-six grants and are retained at higher levels, with genuine discard alternatives and hand-size checks.');
}
