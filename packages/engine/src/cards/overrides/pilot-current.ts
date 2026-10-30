import { searchLibraryCards } from '../effect-builders';
import { allOf, CHOSEN_SUBTYPE, ofColor, ofType, OTHER, YOURS } from '../selector';
import { costReductionFor, spell, triggered } from '../templates';
import { constant } from '../value';
import { defineCard } from './index';

/**
 * Card batch `pilot-current` (card authoring plan, phase 6): the ten pilot cards drawn for the
 * current workflow, authored and finished by hand as PR11b was, to time against `pilot-new`.
 */
export function registerPilotCurrentOverrides(): void {
  // "Black spells you cast cost {1} less to cast." A cost reduction applies only to the generic
  // part of the total cost (CR 601.2f), so a spell whose cost is all {B} costs the same.
  defineCard(
    'bccb06f1-8839-4104-9ffa-c79a817f8378',
    'Jet Medallion',
    ['Black spells you cast cost {1} less to cast.'],
    { ruleStatics: [costReductionFor(ofColor('B'), 1)] },
  );

  // "You may play an additional land this turn. Draw a card." The spell grants one more land play
  // this turn (CR 305.2) and plays nothing itself; the parser's draw stays the second effect.
  defineCard(
    'b8f566ea-8283-4afa-9ac8-737e26419283',
    'Explore',
    ['You may play an additional land this turn.'],
    {
      spellAbility: spell({
        effects: [
          { op: 'additionalLandPlaysThisTurn', count: constant(1) },
          { op: 'draw', count: constant(1) },
        ],
        description: 'You may play an additional land this turn. Draw a card',
      }),
    },
  );

  // "This spell costs {X} less to cast, where X is the greatest power among creatures you
  // control." A self cost reduction, measured as the spell's total cost is determined (CR
  // 601.2f), so it reduces only the generic {7}: Henge never costs less than {G}{G}.
  defineCard(
    '78427103-9543-41fb-b6d4-72963fe87275',
    'The Great Henge',
    [
      'This spell costs {X} less to cast, where X is the greatest power among creatures you control.',
    ],
    {
      ruleStatics: [
        {
          kind: 'costReduction',
          amount: {
            kind: 'greatestPowerAmong',
            selector: allOf(ofType('Creature'), YOURS),
            scope: 'all',
          },
          selfOnly: true,
        },
      ],
    },
  );

  // "Search your library for a card, put that card into your hand, discard a card at random, then
  // shuffle." In that order: the found card is in hand before the random discard, so it may be
  // the card discarded, and the library is shuffled last. The random pick uses the game's seeded
  // generator.
  defineCard(
    'a54f0869-94c8-42af-9080-166efb9486a4',
    'Gamble',
    [
      'Search your library for a card, put that card into your hand, discard a card at random, then shuffle.',
    ],
    {
      spellAbility: spell({
        effects: [
          searchLibraryCards(allOf(), [{ zone: 'hand' }]),
          { op: 'discardAtRandom', count: constant(1) },
          { op: 'shuffle' },
        ],
        description:
          'Search your library for a card, put that card into your hand, discard a card at random, then shuffle',
      }),
    },
  );
  // "{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen
  // type or activate an ability of a creature source of the chosen type." A CR 106.6 restriction
  // on the mana, checked as it is spent against the type chosen as the land entered (CR
  // 614.1c); the parser keeps the choice and the {C} ability. The restriction is matched on the
  // spell's or source's printed types, so a noncreature source of that type (a Tribal artifact
  // aside) cannot use it.
  defineCard(
    '79ba18fd-f184-43c1-86df-56ee18ce806c',
    'Secluded Courtyard',
    [
      '{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen type or activate an ability of a creature source of the chosen type.',
    ],
    {
      manaAbilities: [
        { units: [['C']] },
        {
          units: [['W', 'U', 'B', 'R', 'G']],
          restriction: {
            purposes: ['castSpell', 'activateAbility'],
            filter: allOf(ofType('Creature'), CHOSEN_SUBTYPE),
            description:
              'cast a creature spell of the chosen type or activate an ability of a creature source of the chosen type',
          },
        },
      ],
    },
  );
  // "Whenever one or more other creatures die, draw a card. This ability triggers only once each
  // turn." Creatures dying at the same time are one event (CR 603.2c), so a board wipe draws one
  // card; any player's creatures count. The once-each-turn limit is on Opportunist's object, so a
  // new Opportunist (CR 400.7) may trigger again.
  defineCard(
    '322f44f0-e6da-4ee0-b474-e7d5e9a461c5',
    'Morbid Opportunist',
    [
      'Whenever one or more other creatures die, draw a card. This ability triggers only once each turn.',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'dies',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), OTHER) },
            aggregate: true,
            oncePerTurn: true,
          },
          {
            effects: [{ op: 'draw', count: constant(1) }],
            description: 'Whenever one or more other creatures die, draw a card',
          },
        ),
      ],
    },
  );
}
