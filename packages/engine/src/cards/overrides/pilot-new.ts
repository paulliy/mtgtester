import { allOf, anyOf, ofSubtype, ofSupertype, ofType, YOURS } from '../selector';
import {
  activated,
  mana,
  manaCost,
  onCombatDamageToPlayer,
  onDrawStep,
  onEtb,
  spell,
  targetSlots,
  triggered,
} from '../templates';
import { TREASURE } from '../tokens';
import { constant } from '../value';
import { defineCard } from './index';

/**
 * Card batch `pilot-new` (card authoring plan, phase 6): the ten pilot cards drawn for the new
 * workflow, each started with card:new and finished with card:finish.
 */
export function registerPilotNewOverrides(): void {
  // "Sacrifice a Treasure: Exile the top card of your library. You may play that card this
  // turn." Sacrificing is the whole cost (CR 602.2b), so it works while Face-Breaker is tapped or
  // summoning-sick. The card is played under the normal timing and land-drop rules (CR 305.2,
  // 601.3); the permission lasts until end of turn.
  defineCard(
    '04152e7a-969c-4858-841b-0a569a9fc1bf',
    'Professional Face-Breaker',
    ['Sacrifice a Treasure: Exile the top card of your library. You may play that card this turn.'],
    {
      activatedAbilities: [
        activated({
          costs: [{ kind: 'sacrificeOther', selector: allOf(YOURS, ofSubtype('Treasure')) }],
          effects: [{ op: 'exileTopNPlayableUntilEot', count: constant(1) }],
          description:
            'Sacrifice a Treasure: Exile the top card of your library. You may play that card this turn',
        }),
      ],
    },
  );

  // "When Mithril Coat enters, attach it to target legendary creature you control." A triggered
  // ability, not equip: it attaches at any time Coat enters (flash), with no equip cost. The target
  // is chosen as it goes on the stack and checked again on resolution (CR 608.2b); if Coat has
  // left the battlefield meanwhile, nothing is attached (CR 400.7).
  const host = targetSlots({
    creature: { kind: 'creature', controller: 'you', filter: ofSupertype('Legendary') },
  });
  defineCard(
    '3dc364f3-3094-4660-80ca-9418588c7fde',
    'Mithril Coat',
    ['When ~ enters, attach it to target legendary creature you control.'],
    {
      triggers: [
        triggered(onEtb(), {
          targets: host.targets,
          effects: [{ op: 'attachSelfTo', target: host.slot.creature }],
          description:
            'When Mithril Coat enters, attach it to target legendary creature you control',
        }),
      ],
    },
  );

  // "Channel — {3}{B}, Discard this card: Mill three cards, then return a creature or
  // planeswalker card from your graveyard to your hand. This ability costs {1} less to activate
  // for each legendary creature you control." Activated from hand (CR 602.1), discarding Takenuma
  // as a cost. The returned card is chosen on resolution, after the mill, from the whole
  // graveyard, so a card just milled may be it; it is not a target. The discount is the card-level
  // activation reduction the parser gives Boseiju and Otawara, and reduces only generic mana.
  defineCard(
    'ac2dd694-d2f1-4025-8400-12332bdc882a',
    'Takenuma, Abandoned Mire',
    [
      '{3}{B}, Discard this card: Mill three cards, then return a creature or planeswalker card from your graveyard to your hand. This ability costs {1} less to activate for each legendary creature you control.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{3}{B}'), { kind: 'discardSelf' }],
          zone: 'hand',
          effects: [
            { op: 'mill', count: constant(3) },
            {
              op: 'returnCardFromGraveyardToHand',
              filter: anyOf(ofType('Creature'), ofType('Planeswalker')),
            },
          ],
          description:
            'Channel — {3}{B}, Discard this card: Mill three cards, then return a creature or planeswalker card from your graveyard to your hand',
        }),
      ],
      ruleStatics: [
        {
          kind: 'costReduction',
          appliesTo: 'activate',
          selfOnly: true,
          amount: {
            kind: 'countPermanents',
            selector: allOf(YOURS, ofSupertype('Legendary'), ofType('Creature')),
            scope: 'you',
          },
        },
      ],
    },
  );

  // "If this artifact would enter, you may discard a land card instead. If you do, put this
  // artifact onto the battlefield. If you don't, put it into its owner's graveyard." A
  // replacement (CR 614.1c), not a cost or a trigger: it applies whenever Mox Diamond would enter,
  // cast or put there by another effect, and the land is discarded as it enters.
  defineCard(
    'f3c5978a-70fa-431f-933b-b954bd0db0ea',
    'Mox Diamond',
    [
      "If this artifact would enter, you may discard a land card instead. If you do, put this artifact onto the battlefield. If you don't, put it into its owner's graveyard.",
    ],
    { entersUnlessDiscard: { filter: ofType('Land') } },
  );

  // "Multikicker {2}" (CR 702.33c): an optional additional cost, announced with the spell and
  // payable any number of times. "This artifact enters with a charge counter on it for each time
  // it was kicked" reads that count as Chalice enters (CR 614.1c); the parser's mana ability adds
  // {C} per charge counter.
  defineCard(
    '0a79237e-0811-4a8a-bd4d-db3ca91bff22',
    'Everflowing Chalice',
    ['Multikicker {2}', '~ enters with a charge counter on it for each time it was kicked.'],
    {
      optionalAdditionalCost: { mechanic: 'kicker', cost: manaCost('{2}'), repeatable: true },
      entersWithCounters: { charge: { kind: 'optionalCostCount', mechanic: 'kicker' } },
    },
  );

  // "At the beginning of your draw step, you may draw two additional cards. If you do, choose two
  // cards in your hand drawn this turn. For each of those cards, pay 4 life or put the card on
  // top of your library." The trigger goes on the stack after the step's draw (CR 504.1-2), so
  // three cards drawn this turn are in hand to choose from. "If you do" makes the whole trigger
  // optional: declining draws nothing and keeps everything.
  defineCard(
    '92eed395-62ca-4293-882b-8565c40daab5',
    'Sylvan Library',
    [
      'At the beginning of your draw step, you may draw two additional cards. If you do, choose two cards in your hand drawn this turn. For each of those cards, pay 4 life or put the card on top of your library.',
    ],
    {
      triggers: [
        triggered(onDrawStep('you'), {
          optional: true,
          effects: [
            { op: 'draw', count: constant(2) },
            { op: 'payLifeOrTopDrawnCards', count: constant(2), life: constant(4) },
          ],
          description:
            'At the beginning of your draw step, you may draw two additional cards. If you do, choose two cards drawn this turn; pay 4 life or put each on top of your library',
        }),
      ],
    },
  );

  // "When this creature enters and whenever an opponent draws a card except the first one they
  // draw in each of their draw steps, this creature deals 1 damage to any target. Then amass Orcs
  // 1." Two triggers with one body. The exempted draw is only an opponent's first in their own
  // draw step (CR 504.1); every other draw, in any step or turn, triggers. Amass (CR 701.47a)
  // follows the damage; if the one target is illegal on resolution the whole ability does
  // nothing, amass included (CR 608.2b).
  const bolt = targetSlots({ victim: { kind: 'anyTarget' } });
  const bowmasters = (description: string) => ({
    targets: bolt.targets,
    effects: [
      { op: 'dealDamage' as const, target: bolt.slot.victim, amount: constant(1) },
      { op: 'amass' as const, subtype: 'Orc', count: constant(1) },
    ],
    description,
  });
  defineCard(
    'ea5103f5-27e0-4eb1-902c-7f34652d6bf3',
    'Orcish Bowmasters',
    [
      'When this creature enters and whenever an opponent draws a card except the first one they draw in each of their draw steps, this creature deals 1 damage to any target. Then amass Orcs 1.',
    ],
    {
      triggers: [
        triggered(
          onEtb(),
          bowmasters(
            'When Orcish Bowmasters enters, it deals 1 damage to any target. Then amass Orcs 1',
          ),
        ),
        triggered(
          { when: 'drawsCard', player: 'opponent' },
          {
            ...bowmasters(
              'Whenever an opponent draws a card except the first one they draw in each of their draw steps, Orcish Bowmasters deals 1 damage to any target. Then amass Orcs 1',
            ),
            condition: { kind: 'notFirstDrawInOwnDrawStep' },
          },
        ),
      ],
    },
  );

  // "If you would create a Clue, Food, or Treasure token, instead create one of each." A
  // replacement on its controller's token creation (CR 614.1a), not a trigger: the extra tokens
  // are created in the same event. Two Manufactors make three of each (the card's ruling).
  defineCard(
    'f36d1d8b-8303-44a9-ab56-531931641ea2',
    'Academy Manufactor',
    ['If you would create a Clue, Food, or Treasure token, instead create one of each.'],
    { ruleStatics: [{ kind: 'createClueFoodAndTreasure' }] },
  );

  // "Draw a card for each creature you control with a +1/+1 counter on it. Those creatures gain
  // indestructible until end of turn." Both read the same set as the spell resolves (CR 608.2c):
  // the count is taken once, and the grant reaches the creatures with a counter then, not ones
  // that get a counter later in the turn (CR 611.2c).
  const countered = allOf(ofType('Creature'), YOURS, { kind: 'hasCounter', counter: '+1/+1' });
  defineCard(
    '9b9a10ff-5a5d-4df8-88aa-18d84ff9117c',
    'Inspiring Call',
    [
      'Draw a card for each creature you control with a +1/+1 counter on it. Those creatures gain indestructible until end of turn.',
    ],
    {
      spellAbility: spell({
        effects: [
          { op: 'draw', count: { kind: 'countPermanents', selector: countered, scope: 'you' } },
          { op: 'grantKeywordEachUntilEot', selector: countered, keyword: 'indestructible' },
        ],
        description:
          'Draw a card for each creature you control with a +1/+1 counter on it. Those creatures gain indestructible until end of turn',
      }),
    },
  );

  // "Whenever Ragavan deals combat damage to a player, create a Treasure token and exile the top
  // card of that player's library. Until end of turn, you may cast that card." The card stays its
  // owner's; Ragavan's controller may cast it this turn, paying its costs (a Treasure helps), but
  // not play it as a land. "Dash {1}{R}" is interpreted (CR 702.109a).
  defineCard(
    '37108cd4-bbab-4ce3-9ed6-f60e8422e703',
    'Ragavan, Nimble Pilferer',
    [
      "Whenever ~ deals combat damage to a player, create a Treasure token and exile the top card of that player's library. Until end of turn, you may cast that card.",
    ],
    {
      triggers: [
        triggered(onCombatDamageToPlayer(), {
          effects: [
            { op: 'createToken', spec: TREASURE, count: constant(1) },
            {
              op: 'exileTopNPlayableUntilEot',
              count: constant(1),
              castOnly: true,
              library: 'eventPlayer',
            },
          ],
          description:
            "Whenever Ragavan deals combat damage to a player, create a Treasure token and exile the top card of that player's library. Until end of turn, you may cast that card",
        }),
      ],
    },
  );
}
