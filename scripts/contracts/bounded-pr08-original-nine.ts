import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import {
  manaCost,
  mana,
  TAP,
  activated,
  triggered,
  onEtb,
  onUpkeep,
  onEndStep,
  onBeginCombat,
  spell,
  targetSlots,
  removeCountersCost,
  whenAttacks,
  whenEnters,
} from '../../packages/engine/src/cards/templates';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { allOf, hasCounter, ofType, OTHER } from '../../packages/engine/src/cards/selector';
import { constant } from '../../packages/engine/src/cards/value';
import { SOLDIER_1_1, TREASURE, OGRE_3_3_RED } from '../../packages/engine/src/cards/tokens';
import { searchLibraryCards } from '../../packages/engine/src/cards/effect-builders';
import { executableDefinitionShape } from './bounded-choice-spells';

export const ORIGINAL_PR08_COMPOSITION_IDS = [
  'cytoplast-manipulator',
  'humble-defector',
  'wishclaw-talisman',
  'druid-of-purification',
  'akroan-horse',
  'scheming-symmetry',
  'kazuul',
  'agitator-ant',
  'alicia-masters',
] as const;
export type OriginalPr08CompositionId = (typeof ORIGINAL_PR08_COMPOSITION_IDS)[number];

function base(
  id: OriginalPr08CompositionId,
  typeLine: string,
  types: string[],
  colors: string[],
  cost: string,
  power: number | null = null,
  toughness: number | null = null,
): CardDefinition {
  return {
    oracleId: `independent-pr08-${id}`,
    name: `Independent ${id}`,
    typeLine,
    supertypes: typeLine.startsWith('Legendary') ? ['Legendary'] : [],
    types,
    subtypes: typeLine.includes(' — ') ? typeLine.split(' — ')[1]!.split(' ') : [],
    colors: colors as CardDefinition['colors'],
    colorIdentity: colors as CardDefinition['colorIdentity'],
    manaCost: manaCost(cost),
    hasUnsupportedCost: false,
    power,
    toughness,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    modeled: true,
    unmodeledReasons: [],
  };
}
function compose(id: OriginalPr08CompositionId): CardDefinition {
  switch (id) {
    case 'cytoplast-manipulator': {
      const d = base(id, 'Creature — Human Wizard Mutant', ['Creature'], ['U'], '{2}{U}{U}', 0, 0);
      d.entersWithCounters = { '+1/+1': 2 };
      d.triggers = [
        triggered(whenEnters(allOf(OTHER, ofType('Creature'))), {
          condition: { kind: 'sourceHasCounters', counter: '+1/+1', cmp: '>=', n: 1 },
          optional: true,
          effects: [
            { op: 'moveCounters', from: 'source', to: 'triggerObject', counter: '+1/+1', count: 1 },
          ],
        }),
      ];
      const slots = targetSlots({
        counteredCreature: { kind: 'creature', filter: hasCounter('+1/+1') },
      });
      d.activatedAbilities = [
        activated({
          costs: [mana('{U}'), TAP],
          targets: slots.targets,
          effects: [
            {
              op: 'gainControlTarget',
              target: slots.slot.counteredCreature,
              duration: 'whileSourceOnBattlefield',
            },
          ],
        }),
      ];
      return d;
    }
    case 'humble-defector': {
      const d = base(id, 'Creature — Human Rogue', ['Creature'], ['R'], '{1}{R}', 2, 1);
      const slots = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
      d.activatedAbilities = [
        activated({
          costs: [TAP],
          timing: 'yourTurn',
          targets: slots.targets,
          effects: [
            { op: 'draw', count: constant(2) },
            {
              op: 'gainControlTarget',
              target: 'source',
              recipient: { targetPlayer: slots.slot.opponent },
            },
          ],
        }),
      ];
      return d;
    }
    case 'wishclaw-talisman': {
      const d = base(id, 'Artifact', ['Artifact'], ['B'], '{1}{B}');
      d.entersWithCounters = { wish: 3 };
      d.activatedAbilities = [
        activated({
          costs: [mana('{1}'), TAP, removeCountersCost('wish', 1)],
          timing: 'yourTurn',
          effects: [
            searchLibraryCards(allOf(), [{ zone: 'hand' }]),
            { op: 'shuffle' },
            { op: 'gainControlTarget', target: 'source', recipient: { chooseOpponent: true } },
          ],
        }),
      ];
      return d;
    }
    case 'druid-of-purification': {
      const d = base(id, 'Creature — Human Druid', ['Creature'], ['G'], '{3}{G}', 2, 3);
      d.triggers = [triggered(onEtb(), { effects: [{ op: 'druidPurification' }] })];
      return d;
    }
    case 'akroan-horse': {
      const d = base(id, 'Artifact Creature — Horse', ['Artifact', 'Creature'], [], '{4}', 0, 4);
      d.keywords = ['defender'];
      d.triggers = [
        triggered(onEtb(), {
          effects: [
            { op: 'gainControlTarget', target: 'source', recipient: { chooseOpponent: true } },
          ],
        }),
        triggered(onUpkeep(), {
          effects: [{ op: 'eachOpponentCreatesTokens', spec: SOLDIER_1_1, count: constant(1) }],
        }),
      ];
      return d;
    }
    case 'scheming-symmetry': {
      const d = base(id, 'Sorcery', ['Sorcery'], ['B'], '{B}');
      const slots = targetSlots({ players: { kind: 'player', count: { min: 2, max: 2 } } });
      d.spellAbility = spell({
        targets: slots.targets,
        effects: [{ op: 'schemingSymmetry', targetSlot: slots.slot.players }],
      });
      return d;
    }
    case 'kazuul': {
      const d = base(
        id,
        'Legendary Creature — Ogre Warrior',
        ['Creature'],
        ['R'],
        '{3}{R}{R}',
        5,
        4,
      );
      d.triggers = [
        triggered(
          whenAttacks(allOf(ofType('Creature'), { kind: 'controller', who: 'opponents' })),
          {
            condition: { kind: 'eventObjectDefendingPlayerIsYou' },
            effects: [
              {
                op: 'unlessPays',
                payer: 'eventObjectController',
                cost: manaCost('{3}'),
                then: [{ op: 'createToken', spec: OGRE_3_3_RED, count: constant(1) }],
              },
            ],
          },
        ),
      ];
      return d;
    }
    case 'agitator-ant': {
      const d = base(id, 'Creature — Insect', ['Creature'], ['R'], '{2}{R}', 2, 2);
      d.triggers = [
        triggered(onEndStep('you'), {
          effects: [
            { op: 'eachPlayerMayPutCountersAndGoad', counter: '+1/+1', count: constant(2) },
          ],
        }),
      ];
      return d;
    }
    case 'alicia-masters': {
      const d = base(
        id,
        'Legendary Creature — Human Artificer',
        ['Creature'],
        ['R'],
        '{1}{R}',
        0,
        4,
      );
      d.triggers = [
        triggered(onBeginCombat('you'), {
          condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
          effects: [{ op: 'createToken', spec: TREASURE, count: constant(1) }],
        }),
        triggered(onEndStep('you'), { effects: [{ op: 'regainControlOfOwnCreatures' }] }),
      ];
      return d;
    }
  }
}
export const BOUNDED_PR08_ORIGINAL_NINE = ORIGINAL_PR08_COMPOSITION_IDS.map((id) => ({
  id,
  definition: compose(id),
}));
export function matchesBoundedPr08OriginalNine(
  definition: CardDefinition,
  id?: OriginalPr08CompositionId,
): boolean {
  try {
    return (
      validateCardDefinition(definition).length === 0 &&
      BOUNDED_PR08_ORIGINAL_NINE.some(
        (entry) =>
          (id === undefined || id === entry.id) &&
          JSON.stringify(executableDefinitionShape(definition, true)) ===
            JSON.stringify(executableDefinitionShape(entry.definition, true)),
      )
    );
  } catch {
    return false;
  }
}
