import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import {
  activated,
  mana,
  manaCost,
  onBeginCombat,
  onDies,
  onUpkeep,
  triggered,
} from '../../packages/engine/src/cards/templates';
import {
  allOf,
  anyOf,
  not,
  ofSubtype,
  ofType,
  OPPONENTS,
} from '../../packages/engine/src/cards/selector';
import { INKLING_2_1_FLYING, SURVIVOR_1_1_RED } from '../../packages/engine/src/cards/tokens';
import { constant } from '../../packages/engine/src/cards/value';
import { boundedChoiceSpell, executableDefinitionShape } from './bounded-choice-spells';

export const MULTIPLAYER_PERMANENT_KINDS = [
  'channel-land',
  'distinct-combat',
  'distinct-death',
  'upkeep-rotation',
  'survivor-rules',
] as const;
export type MultiplayerPermanentKind = (typeof MULTIPLAYER_PERMANENT_KINDS)[number];
export function boundedMultiplayerPermanent(kind: MultiplayerPermanentKind): CardDefinition {
  const definition = boundedChoiceSpell('owner-library');
  Object.assign(definition, {
    oracleId: `independent-multiplayer-${kind}`,
    name: `Independent ${kind}`,
    typeLine:
      kind === 'channel-land'
        ? 'Legendary Land'
        : kind === 'distinct-combat'
          ? 'Legendary Creature — Elder Dragon'
          : kind === 'distinct-death'
            ? 'Creature — Zombie Wizard'
            : kind === 'upkeep-rotation'
              ? 'Legendary Creature — Human Berserker'
              : 'Legendary Creature — Human Knight',
    supertypes: kind === 'distinct-death' ? [] : ['Legendary'],
    types: [kind === 'channel-land' ? 'Land' : 'Creature'],
    subtypes:
      kind === 'channel-land'
        ? []
        : kind === 'distinct-combat'
          ? ['Elder', 'Dragon']
          : kind === 'distinct-death'
            ? ['Zombie', 'Wizard']
            : ['Human', kind === 'upkeep-rotation' ? 'Berserker' : 'Knight'],
    colors:
      kind === 'channel-land'
        ? []
        : kind === 'distinct-combat'
          ? ['B', 'W']
          : kind === 'distinct-death'
            ? ['B']
            : ['R'],
    colorIdentity:
      kind === 'channel-land'
        ? ['G']
        : kind === 'distinct-combat'
          ? ['B', 'W']
          : kind === 'distinct-death'
            ? ['B']
            : ['R'],
    manaCost:
      kind === 'channel-land'
        ? null
        : manaCost(
            kind === 'distinct-combat'
              ? '{3}{W}{B}'
              : kind === 'distinct-death'
                ? '{3}{B}'
                : kind === 'upkeep-rotation'
                  ? '{3}{R}'
                  : '{2}{R}',
          ),
    power:
      kind === 'channel-land'
        ? null
        : kind === 'distinct-combat'
          ? 2
          : kind === 'survivor-rules'
            ? 3
            : 4,
    toughness:
      kind === 'channel-land'
        ? null
        : kind === 'distinct-combat'
          ? 5
          : kind === 'distinct-death'
            ? 1
            : kind === 'survivor-rules'
              ? 3
              : 4,
    keywords:
      kind === 'distinct-combat'
        ? ['flying', 'double strike']
        : kind === 'upkeep-rotation'
          ? ['trample']
          : [],
    spellAbility: null,
  });
  const targets = (opponents: boolean) =>
    [0, 1, 2].map((slot) => ({
      kind: 'player' as const,
      ...(opponents ? { controller: 'opponent' as const } : {}),
      differentPlayerTargetSlots: [0, 1, 2].filter((other) => other !== slot),
    }));
  switch (kind) {
    case 'channel-land':
      definition.manaAbilities = [{ units: [['G']] }];
      definition.activatedAbilities = [
        activated({
          zone: 'hand',
          costs: [mana('{1}{G}'), { kind: 'discardSelf' }],
          targets: [
            {
              kind: 'permanent',
              controller: 'opponent',
              filter: anyOf(
                ofType('Artifact'),
                ofType('Enchantment'),
                allOf(ofType('Land'), not({ kind: 'supertype', value: 'Basic' })),
              ),
            },
          ],
          effects: [{ op: 'destroyTargetAndControllerMaySearchBasicTypedLand', target: 0 }],
        }),
      ];
      definition.ruleStatics = [
        {
          kind: 'costReduction',
          appliesTo: 'activate',
          selfOnly: true,
          amount: {
            kind: 'countPermanents',
            selector: allOf(ofType('Creature'), { kind: 'supertype', value: 'Legendary' }),
            scope: 'you',
          },
        },
      ];
      break;
    case 'distinct-combat':
      definition.triggers = [
        triggered(onBeginCombat('you'), {
          targets: targets(false),
          effects: [],
          modes: {
            minChoices: 2,
            maxChoices: 2,
            optional: true,
            options: [
              {
                description: 'make token',
                targetSlots: [0],
                effects: [
                  {
                    op: 'createTokenForPlayer',
                    target: 0,
                    spec: INKLING_2_1_FLYING,
                    count: constant(1),
                  },
                ],
              },
              {
                description: 'draw lose',
                targetSlots: [1],
                effects: [
                  { op: 'drawTarget', target: 1, count: constant(1) },
                  { op: 'loseLifeTarget', target: 1, amount: constant(1) },
                ],
              },
              {
                description: 'counters',
                targetSlots: [2],
                effects: [
                  {
                    op: 'putCountersOnCreaturesTargetPlayerControls',
                    target: 2,
                    counter: '+1/+1',
                    count: constant(1),
                  },
                ],
              },
            ],
          },
        }),
      ];
      break;
    case 'distinct-death':
      definition.triggers = [
        triggered(onDies(), {
          targets: targets(true),
          effects: [],
          modes: {
            minChoices: 1,
            maxChoices: 3,
            options: [
              {
                description: 'sacrifice',
                targetSlots: [0],
                effects: [{ op: 'sacrificeTargetPlayerCreature', target: 0 }],
              },
              {
                description: 'discard',
                targetSlots: [1],
                effects: [{ op: 'discardTarget', target: 1, count: constant(2) }],
              },
              {
                description: 'lose',
                targetSlots: [2],
                effects: [{ op: 'loseLifeTarget', target: 2, amount: constant(5) }],
              },
            ],
          },
        }),
      ];
      break;
    case 'upkeep-rotation':
      definition.staticEffects = [
        { affects: { kind: 'self' }, op: { layer: 6, setMustAttackEachCombat: true } },
      ];
      definition.ruleStatics = [{ kind: 'cantBeSacrificed' }, { kind: 'cantAttackOwner' }];
      definition.triggers = [
        triggered(onUpkeep('each'), { effects: [{ op: 'rotateSourceAtUpkeep' }] }),
      ];
      break;
    case 'survivor-rules':
      definition.triggers = [
        triggered(
          { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          {
            effects: [
              {
                op: 'createTokenForPlayer',
                target: 'eventPlayer',
                spec: SURVIVOR_1_1_RED,
                count: { kind: 'damageDealt' },
              },
            ],
          },
        ),
        triggered(
          { when: 'leavesBattlefield', subject: { kind: 'self' } },
          { effects: [{ op: 'gainControl', selector: ofSubtype('Survivor') }] },
        ),
      ];
      definition.ruleStatics = [
        { kind: 'cantBlockMatching', filter: allOf(ofSubtype('Survivor'), OPPONENTS) },
        {
          kind: 'attackRestriction',
          filter: allOf(ofSubtype('Survivor'), OPPONENTS),
          includePlaneswalkers: true,
        },
      ];
      break;
  }
  return definition;
}
export function supportsBoundedMultiplayerPermanent(
  definition: CardDefinition,
  kind?: MultiplayerPermanentKind,
): boolean {
  try {
    return (
      validateCardDefinition(definition).length === 0 &&
      (kind === undefined ? MULTIPLAYER_PERMANENT_KINDS : [kind]).some(
        (candidate) =>
          JSON.stringify(executableDefinitionShape(definition, true)) ===
          JSON.stringify(executableDefinitionShape(boundedMultiplayerPermanent(candidate), true)),
      )
    );
  } catch {
    return false;
  }
}
