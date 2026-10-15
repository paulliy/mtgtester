/** Executable authored overrides for the Ur-Dragon fixture. */

import { defineCard, unsupportedCard } from './index';
import { constant } from '../value';
import { manaCost } from '../templates';
import { allOf, anyOf, IS_COMMANDER, not, ofSubtype, ofType, SELF, YOURS } from '../selector';

export function registerURDRAGONOverrides(): void {
  // Dragon Tempest: restored in coverage PR06 (no override remains).

  const iymrithDef = {
    staticEffects: [
      {
        affects: SELF,
        op: {
          layer: 6 as const,
          addWard: { kind: 'mana' as const, cost: manaCost('{4}') },
        },
        condition: { kind: 'isUntapped' as const },
      },
    ],
    triggers: [
      {
        kind: 'triggered' as const,
        trigger: { when: 'dealsCombatDamageToPlayer' as const, subject: { kind: 'self' as const } },
        targets: [],
        effects: [
          { op: 'draw' as const, count: constant(1) },
          { op: 'drawUpTo' as const, count: 3 },
        ],
        description: 'Combat damage — draw, then draw to three cards in hand',
      },
    ],
  };
  defineCard(
    'd5efba91-8400-41a3-91c6-cb5e81f07976',
    'Iymrith, Desert Doom',
    [
      "~ has ward {4} as long as it's untapped.",
      'Whenever ~ deals combat damage to a player, draw a card. Then if you have fewer than three cards in hand, draw cards equal to the difference.',
    ],
    iymrithDef,
  );

  // Coverage PR01: the mode is chosen as the trigger is put on the stack (CR 700.2a). The bounce
  // mode targets any number of nonland permanents whose mana values total 6 or less.
  defineCard(
    '85aa53e8-f062-4d02-bc69-1413f7f0dcf1',
    'Kairi, the Swirling Sky',
    [
      'When ~ dies, choose one —',
      "• Return any number of target nonland permanents with total mana value 6 or less to their owners' hands.",
      '• Mill six cards, then return up to two instant and/or sorcery cards from your graveyard to your hand.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'dies', subject: { kind: 'self' } },
          targets: [
            {
              kind: 'permanent',
              filter: not(ofType('Land')),
              count: { min: 0, max: Infinity },
              totalManaValueAtMost: 6,
            },
          ],
          effects: [],
          modes: {
            minChoices: 1,
            maxChoices: 1,
            options: [
              {
                description:
                  "Return any number of target nonland permanents with total mana value 6 or less to their owners' hands",
                effects: [{ op: 'returnToHandEachChosen', targetSlot: 0 }],
                targetSlots: [0],
              },
              {
                description:
                  'Mill six cards, then return up to two instant and/or sorcery cards from your graveyard to your hand',
                effects: [{ op: 'millAndReturnSpells' }],
                // Explicitly targetless: a mode without `targetSlots` would announce every slot.
                targetSlots: [],
              },
            ],
          },
          description: 'When Kairi dies, choose one',
        },
      ],
    },
  );

  const lozhanDef = {
    triggers: [
      {
        kind: 'triggered' as const,
        trigger: {
          when: 'castsSpell' as const,
          caster: 'you' as const,
          filter: anyOf(ofSubtype('Adventure'), ofSubtype('Dragon')),
        },
        targets: [{ kind: 'anyTarget' as const, filter: not(IS_COMMANDER) }],
        effects: [
          { op: 'dealDamage' as const, target: 0, amount: { kind: 'spellManaValue' as const } },
        ],
        description: 'Cast Adventure or Dragon — deal its mana value to a noncommander target',
      },
    ],
  };
  defineCard(
    'be2075af-1cd8-42fe-a29b-a0fd2b047a44',
    "Lozhan, Dragons' Legacy",
    [
      "Whenever you cast an Adventure or Dragon spell, ~ deals damage equal to that spell's mana value to any target that isn't a commander.",
    ],
    lozhanDef,
  );

  // Catalog audit urdragon-batch-2: intervening-if reads Firkraag, not the damaging creature.
  unsupportedCard(
    '81dad7c5-5950-4c45-adb0-cf1a15a74250',
    'Firkraag, Cunning Instigator',
    'The intervening-if checks whether Firkraag had to attack, not the creature that dealt damage.',
  );
  const thrakkusDef = {
    triggers: [
      {
        kind: 'triggered' as const,
        trigger: { when: 'attacks' as const, subject: { kind: 'self' as const } },
        targets: [],
        effects: [{ op: 'doublePower' as const, selector: allOf(ofSubtype('Dragon'), YOURS) }],
        description: 'Attack — double each Dragon’s power until end of turn',
      },
    ],
  };
  defineCard(
    'f7cd7ede-51c1-4117-99b5-484d0d80c95f',
    'Thrakkus the Butcher',
    ['Whenever ~ attacks, double the power of each Dragon you control until end of turn.'],
    thrakkusDef,
  );
}
