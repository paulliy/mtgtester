import { allOf, OTHER, ofType, YOURS } from '../selector';
import { CONTRACT_AURA, DINOSAUR_X_X_TRAMPLE_GREEN, VAMPIRE_1_1_LIFELINK_WHITE } from '../tokens';
import { constant } from '../value';
import { defineCard, unsupportedCard } from './index';

const ATTACKING = { kind: 'combatRole', role: 'attacking' } as const;
const YOUR_ATTACKERS = allOf(ofType('Creature'), YOURS);
const OTHER_ATTACKERS = allOf(ofType('Creature'), OTHER, ATTACKING);

export function registerW1RemainingOverrides(): void {
  defineCard(
    'cba58942-b98c-45aa-8651-7dc666e31c93',
    'Fumiko the Lowblood',
    ['~ has bushido X, where X is the number of attacking creatures.'],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'blocks', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'pumpUntilEot',
              target: 'source',
              power: { kind: 'attackingCreatures' },
              toughness: { kind: 'attackingCreatures' },
            },
          ],
          description: 'Bushido X — blocks',
        },
        {
          kind: 'triggered',
          trigger: { when: 'becomesBlocked', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'pumpUntilEot',
              target: 'source',
              power: { kind: 'attackingCreatures' },
              toughness: { kind: 'attackingCreatures' },
            },
          ],
          description: 'Bushido X — becomes blocked',
        },
      ],
    },
  );

  defineCard(
    '756042c5-e444-45d7-8dc6-ae7c83c98438',
    'Ghalta and Mavren',
    [
      'Whenever you attack, choose one —',
      '• Create a tapped and attacking X/X green Dinosaur creature token with trample, where X is the greatest power among other attacking creatures.',
      '• Create X 1/1 white Vampire creature tokens with lifelink, where X is the number of other attacking creatures.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'attacks',
            subject: { kind: 'permanent', selector: YOUR_ATTACKERS },
            aggregate: true,
          },
          targets: [],
          effects: [],
          modes: {
            minChoices: 1,
            maxChoices: 1,
            options: [
              {
                effects: [
                  {
                    op: 'createTokenAttacking',
                    spec: DINOSAUR_X_X_TRAMPLE_GREEN,
                    count: constant(1),
                    powerOverride: {
                      kind: 'greatestPowerAmong',
                      selector: OTHER_ATTACKERS,
                      scope: 'all',
                    },
                    toughnessOverride: {
                      kind: 'greatestPowerAmong',
                      selector: OTHER_ATTACKERS,
                      scope: 'all',
                    },
                  },
                ],
                description: 'Create a tapped and attacking X/X Dinosaur with trample',
              },
              {
                effects: [
                  {
                    op: 'createToken',
                    spec: VAMPIRE_1_1_LIFELINK_WHITE,
                    count: {
                      kind: 'countPermanents',
                      selector: OTHER_ATTACKERS,
                      scope: 'all',
                    },
                  },
                ],
                description: 'Create a Vampire for each other attacking creature',
              },
            ],
          },
          description: 'Whenever you attack, choose a token mode',
        },
      ],
    },
  );

  // Catalog audit w1-batch-1: Choose a Background is claimed without a background companion.
  unsupportedCard(
    '60e7130a-d321-4e50-93a4-999013c76054',
    'Gut, True Soul Zealot',
    'Choose a Background is claimed without a background companion implementation.',
  );

  defineCard(
    'f4310dfd-52eb-4c1f-b1ad-bfbc9b50fe7b',
    'Nova Flame',
    [
      'Put X +1/+1 counters on target creature you control. It deals damage equal to its power to each other creature.',
    ],
    {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature', controller: 'you' }],
        effects: [
          { op: 'putCounters', target: 0, counter: '+1/+1', count: { kind: 'xValue' } },
          {
            op: 'damageEach',
            selector: ofType('Creature'),
            amount: { kind: 'powerOfTarget', target: 0 },
            source: 0,
            exceptSource: true,
          },
        ],
        description: 'Put X counters on your creature; it deals its power to each other creature',
      },
    },
  );

  const auraCount = { kind: 'aurasYouControlAttachedToCreatures' } as const;
  defineCard(
    'bd92cacd-c7d8-43a2-a261-ea4754fefdc5',
    "Sage's Reverie",
    [
      "When this Aura enters, draw a card for each Aura you control that's attached to a creature.",
      "Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature.",
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'draw', count: auraCount }],
          description: 'Draw for each Aura you control attached to a creature',
        },
      ],
      staticEffects: [
        {
          affects: { kind: 'attachedToSource' },
          op: { layer: 7, sublayer: 'd', power: auraCount, toughness: auraCount },
        },
      ],
    },
  );

  const scrivTrigger = {
    targets: [{ kind: 'creature', controller: 'opponent' }] as const,
    effects: [{ op: 'createAttachedToken', spec: CONTRACT_AURA, target: 0 }] as const,
    description: 'Create a Contract attached to target creature an opponent controls',
  };
  defineCard(
    '64c986f0-e786-419c-9b51-8c316c8fae0e',
    'Scriv, the Obligator',
    [
      'Whenever ~ enters or attacks, create a white Aura enchantment token named Contract attached to target creature an opponent controls. The token has enchant creature and "Whenever enchanted creature attacks, it gets +2/+0 until end of turn if it\'s attacking one of your opponents. Otherwise, its controller loses 2 life."',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [...scrivTrigger.targets],
          effects: [...scrivTrigger.effects],
          description: scrivTrigger.description,
        },
        {
          kind: 'triggered',
          trigger: { when: 'attacks', subject: { kind: 'self' } },
          targets: [...scrivTrigger.targets],
          effects: [...scrivTrigger.effects],
          description: scrivTrigger.description,
        },
      ],
    },
  );

  // Catalog audit w1-remaining-batch-2: "a commander" is not "your commander".
  unsupportedCard(
    'd8df9813-0376-4d30-8cdc-30451fb67726',
    'Will of the Mardu',
    'Choose-both requires controlling your own commander, not any commander you control.',
  );
}
