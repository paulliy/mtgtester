/**
 * Coverage PR01 (docs/plans/card-coverage-chunks.md): cards that had no registration at all.
 * Each one meets the completion standard individually and is gated by the PR01 restoration
 * gate in `tests/pr01-card-coverage.test.ts`, so this file is not part of the catalog audit
 * inventory.
 */

import { allOf, anyOf, ENTERED_THIS_TURN, ofSubtype, ofSupertype, ofType } from '../selector';
import { activated, mana } from '../templates';
import { constant } from '../value';
import { defineCard } from './index';

export function registerCoveragePr01Overrides(): void {
  // Mystic Sanctuary: the Islands are counted before it is on the battlefield, so "other" holds.
  defineCard(
    '17b60106-a4c7-410a-8ac3-ec8e74e29a7c',
    'Mystic Sanctuary',
    [
      '~ enters tapped unless you control three or more other Islands.',
      'When this land enters untapped, you may put target instant or sorcery card from your graveyard on top of your library.',
    ],
    {
      entersTappedUnless: {
        kind: 'countPermanents',
        selector: ofSubtype('Island'),
        scope: 'you',
        cmp: '>=',
        n: 3,
      },
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' }, entersUntapped: true },
          optional: true,
          targets: [
            { kind: 'cardInGraveyard', filter: anyOf(ofType('Instant'), ofType('Sorcery')) },
          ],
          effects: [{ op: 'graveyardToLibraryTop', target: 0 }],
          description:
            'You may put target instant or sorcery card from your graveyard on top of your library',
        },
      ],
    },
  );

  // Brokers Hideout: the search is a reflexive trigger (CR 603.12), so it uses the stack after
  // the sacrifice instead of happening inside the enters trigger's resolution.
  defineCard(
    'bd002797-a545-4bee-88bf-b878436e7cca',
    'Brokers Hideout',
    [
      'When this land enters, sacrifice it. When you do, search your library for a basic Forest, Plains, or Island card, put it onto the battlefield tapped, then shuffle and you gain 1 life.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'sacrificeSourceThenReflexive',
              then: {
                kind: 'triggered',
                targets: [],
                effects: [
                  {
                    op: 'searchLibrary',
                    filter: allOf(
                      ofSupertype('Basic'),
                      anyOf(ofSubtype('Forest'), ofSubtype('Plains'), ofSubtype('Island')),
                    ),
                    destinations: [{ zone: 'battlefield', tapped: true }],
                    allowFailToFind: true,
                  },
                  { op: 'shuffle' },
                  { op: 'gainLife', amount: constant(1) },
                ],
                description:
                  'Search for a basic Forest, Plains, or Island, put it onto the battlefield tapped, then shuffle and gain 1 life',
              },
            },
          ],
          description: 'Sacrifice this land',
        },
      ],
    },
  );

  // Sweet-Gum Recluse: any number of targets, each a creature that entered this turn (itself
  // included, since it has just entered).
  defineCard(
    '8ea10a5a-b698-4f7d-a9c8-520f8d835f34',
    'Sweet-Gum Recluse',
    [
      'When this creature enters, put three +1/+1 counters on each of any number of target creatures that entered this turn.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [
            {
              kind: 'creature',
              filter: ENTERED_THIS_TURN,
              count: { min: 0, max: Infinity },
            },
          ],
          effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 3 }],
          description:
            'Put three +1/+1 counters on each of any number of target creatures that entered this turn',
        },
      ],
    },
  );

  // Kogla, the Titan Ape: the enters fight is "up to one" (a 0..1 slot), the attack trigger
  // reads the DEFENDING player, and the activation's indestructible needs its target to still
  // be legal (CR 608.2b: the whole ability fizzles otherwise).
  defineCard(
    '8b21062e-97b0-4967-96df-30e8309f4fba',
    'Kogla, the Titan Ape',
    [
      "When ~ enters, it fights up to one target creature you don't control.",
      'Whenever ~ attacks, destroy target artifact or enchantment defending player controls.',
      "{1}{G}: Return target Human you control to its owner's hand. ~ gains indestructible until end of turn.",
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'creature', controller: 'opponent', count: { min: 0, max: 1 } }],
          effects: [{ op: 'fightUpToOneChosen', a: 'source', bSlot: 0 }],
          description: "It fights up to one target creature you don't control",
        },
        {
          kind: 'triggered',
          trigger: {
            when: 'attacks',
            subject: { kind: 'self' },
            defendingPlayerIsEventPlayer: true,
          },
          targets: [{ kind: 'artifactOrEnchantment', controller: 'eventPlayer' }],
          effects: [{ op: 'destroy', target: 0 }],
          description: 'Destroy target artifact or enchantment defending player controls',
        },
      ],
      activatedAbilities: [
        activated({
          costs: [mana('{1}{G}')],
          targets: [{ kind: 'permanent', controller: 'you', filter: ofSubtype('Human') }],
          effects: [
            { op: 'returnToHand', target: 0 },
            { op: 'grantKeywordUntilEot', target: 'source', keyword: 'indestructible' },
          ],
          description:
            "Return target Human you control to its owner's hand; Kogla gains indestructible until end of turn",
        }),
      ],
    },
  );
}
