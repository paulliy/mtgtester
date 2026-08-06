/** Executable authored overrides for the Ur-Dragon fixture. */

import { defineCard } from './index';
import { constant } from '../value';
import { manaCost } from '../templates';
import {
  allOf,
  anyOf,
  IS_COMMANDER,
  not,
  ofSubtype,
  ofType,
  OPPONENTS,
  SELF,
  withKeyword,
  YOURS,
} from '../selector';

export function registerURDRAGONOverrides(): void {
  const dragonTempestDef = {
    triggers: [
      {
        kind: 'triggered' as const,
        trigger: {
          when: 'enters' as const,
          subject: {
            kind: 'permanent' as const,
            selector: allOf(ofType('Creature'), withKeyword('flying'), YOURS),
          },
        },
        targets: [],
        effects: [{ op: 'grantKeywordUntilEot' as const, target: 'triggerObject' as const, keyword: 'haste' as const }],
        description: 'Flying creature enters — gains haste',
      },
      {
        kind: 'triggered' as const,
        trigger: {
          when: 'enters' as const,
          subject: { kind: 'permanent' as const, selector: allOf(ofSubtype('Dragon'), YOURS) },
        },
        targets: [{ kind: 'anyTarget' as const }],
        effects: [{
          op: 'dealDamage' as const,
          target: 0,
          amount: { kind: 'countPermanents' as const, selector: ofSubtype('Dragon'), scope: 'you' as const },
        }],
        description: 'Dragon enters — damage equal to Dragons controlled',
      },
    ],
  };
  defineCard('b9bacb46-fd1d-459b-81c2-d7d08fe73848', 'Dragon Tempest', [
      'Whenever a creature you control with flying enters, it gains haste until end of turn.',
      'Whenever a Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control.',
    ], dragonTempestDef);

  const iymrithDef = {
    staticEffects: [{
      affects: SELF,
      op: { layer: 6 as const, addWard: manaCost('{4}') },
      condition: { kind: 'isUntapped' as const },
    }],
    triggers: [{
      kind: 'triggered' as const,
      trigger: { when: 'dealsCombatDamageToPlayer' as const, subject: { kind: 'self' as const } },
      targets: [],
      effects: [
        { op: 'draw' as const, count: constant(1) },
        { op: 'drawUpTo' as const, count: 3 },
      ],
      description: 'Combat damage — draw, then draw to three cards in hand',
    }],
  };
  defineCard('d5efba91-8400-41a3-91c6-cb5e81f07976', 'Iymrith, Desert Doom', [
      "~ has ward {4} as long as it's untapped.",
      'Whenever ~ deals combat damage to a player, draw a card. Then if you have fewer than three cards in hand, draw cards equal to the difference.',
    ], iymrithDef);

  const kairiDef = {
    triggers: [{
      kind: 'triggered' as const,
      trigger: { when: 'dies' as const, subject: { kind: 'self' as const } },
      targets: [],
      modes: {
        minChoices: 1 as const,
        maxChoices: 1 as const,
        options: [
          { description: 'Return nonland permanents with total mana value six or less', effects: [{ op: 'bounceUpTo6MV' as const }] },
          { description: 'Mill six, then return up to two instant or sorcery cards', effects: [{ op: 'millAndReturnSpells' as const }] },
        ],
      },
      effects: [],
      description: 'Dies — choose Kairi mode',
    }],
  };
  defineCard('85aa53e8-f062-4d02-bc69-1413f7f0dcf1', 'Kairi, the Swirling Sky', [
      'When ~ dies, choose one \u2014',
      '\u2022 Return any number of target nonland permanents with total mana value 6 or less to their owners\' hands.',
      '\u2022 Mill six cards, then return up to two instant and/or sorcery cards from your graveyard to your hand.',
    ], kairiDef);

  const lozhanDef = {
    triggers: [{
      kind: 'triggered' as const,
      trigger: {
        when: 'castsSpell' as const,
        caster: 'you' as const,
        filter: anyOf(ofSubtype('Adventure'), ofSubtype('Dragon')),
      },
      targets: [{ kind: 'anyTarget' as const, filter: not(IS_COMMANDER) }],
      effects: [{ op: 'dealDamage' as const, target: 0, amount: { kind: 'spellManaValue' as const } }],
      description: 'Cast Adventure or Dragon — deal its mana value to a noncommander target',
    }],
  };
  defineCard('be2075af-1cd8-42fe-a29b-a0fd2b047a44', "Lozhan, Dragons' Legacy", [
    'Whenever you cast an Adventure or Dragon spell, ~ deals damage equal to that spell\'s mana value to any target that isn\'t a commander.',
  ], lozhanDef);

  const firkraagDef = {
    triggers: [
      {
        kind: 'triggered' as const,
        trigger: {
          when: 'attacks' as const,
          subject: { kind: 'permanent' as const, selector: allOf(ofSubtype('Dragon'), YOURS) },
          aggregate: 'byEventPlayer' as const,
        },
        targets: [{ kind: 'creature' as const, controller: 'eventPlayer' as const }],
        effects: [{ op: 'goad' as const, target: 0 }],
        description: 'Dragons attack an opponent — goad that player’s creature',
      },
      {
        kind: 'triggered' as const,
        trigger: {
          when: 'dealsCombatDamageToPlayer' as const,
          subject: { kind: 'permanent' as const, selector: allOf(ofType('Creature'), OPPONENTS) },
        },
        targets: [],
        effects: [
          {
            op: 'conditionalEffect' as const,
            condition: { kind: 'hadToAttackThisCombat' as const },
            then: [
              { op: 'putCountersEach' as const, selector: SELF, counter: '+1/+1', count: 1 },
              { op: 'draw' as const, count: constant(1) },
            ],
            else: [],
          },
        ],
        description: 'Forced attacker damages an opponent — grow Firkraag and draw',
      },
    ],
  };
  defineCard('81dad7c5-5950-4c45-adb0-cf1a15a74250', 'Firkraag, Cunning Instigator', [
      'Whenever one or more Dragons you control attack an opponent, goad target creature that player controls.',
      'Whenever a creature deals combat damage to one of your opponents, if that creature had to attack this combat, you put a +1/+1 counter on ~ and you draw a card.',
    ], firkraagDef);
  const thrakkusDef = {
    triggers: [{
      kind: 'triggered' as const,
      trigger: { when: 'attacks' as const, subject: { kind: 'self' as const } },
      targets: [],
      effects: [{ op: 'doublePower' as const, selector: allOf(ofSubtype('Dragon'), YOURS) }],
      description: 'Attack — double each Dragon’s power until end of turn',
    }],
  };
  defineCard('f7cd7ede-51c1-4117-99b5-484d0d80c95f', 'Thrakkus the Butcher', [
    'Whenever ~ attacks, double the power of each Dragon you control until end of turn.',
  ], thrakkusDef);
}