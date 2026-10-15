import type { CardDefinition } from '../definition';
import { allOf, anyOf, IS_TOKEN, not, ofType, OPPONENTS, SELF } from '../selector';
import { activated, mana, manaCost, spell, TAP, targetSlots, triggered } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlTergridOverrides(): void {
  const oracleId = '8485cfaa-1dbf-432b-b5d0-92a6aa6a329b';
  const playerTarget = targetSlots({ player: { kind: 'player' } });
  const lanternText =
    "{T}: Target player loses 3 life unless they sacrifice a nonland permanent of their choice or discard a card.\n{3}{B}: Untap Tergrid's Lantern.";
  const frontText =
    'Menace\nWhenever an opponent sacrifices a nontoken permanent or discards a permanent card, you may put that card from a graveyard onto the battlefield under your control.';
  const lantern: CardDefinition = {
    oracleId,
    name: "Tergrid's Lantern",
    typeLine: 'Legendary Artifact',
    supertypes: ['Legendary'],
    types: ['Artifact'],
    subtypes: [],
    colors: ['B'],
    colorIdentity: ['B'],
    manaCost: manaCost('{3}{B}'),
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    entersTapped: false,
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    spellAbility: spell({ effects: [] }),
    activatedAbilities: [
      activated({
        costs: [TAP],
        targets: playerTarget.targets,
        effects: [
          {
            op: 'sacrificeNonlandOrDiscardOrLoseLife',
            target: playerTarget.slot.player,
            amount: constant(3),
          },
        ],
        description:
          'Target player loses 3 life unless they sacrifice a nonland permanent or discard a card',
      }),
      activated({
        costs: [mana('{3}{B}')],
        effects: [{ op: 'untapEach', selector: SELF }],
        description: "Untap Tergrid's Lantern",
      }),
    ],
    modeled: true,
    unmodeledReasons: [],
  };
  const permanentCards = anyOf(
    ...['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'].map(ofType),
  );
  replaceCard(
    oracleId,
    "Tergrid, God of Fright // Tergrid's Lantern",
    [
      'unsupported layout "modal_dfc"',
      'unrecognized rules text: "Whenever an opponent sacrifices a nontoken permanent or discards a permanent card, you may put that card from a graveyard onto the battlefield under your control."',
    ],
    {
      name: 'Tergrid, God of Fright',
      triggers: [
        triggered(
          {
            when: 'sacrificed',
            subject: { kind: 'permanent', selector: allOf(OPPONENTS, not(IS_TOKEN)) },
          },
          {
            optional: true,
            effects: [{ op: 'graveyardToBattlefield', target: 'triggerObject' }],
            description:
              'Put the sacrificed card from a graveyard onto the battlefield under your control',
          },
        ),
        triggered(
          { when: 'discardsCard', player: 'opponent', filter: permanentCards },
          {
            optional: true,
            effects: [{ op: 'graveyardToBattlefield', target: 'triggerObject' }],
            description:
              'Put the discarded permanent card from a graveyard onto the battlefield under your control',
          },
        ),
      ],
      alternativeCasts: [
        {
          kind: 'mdfc',
          name: lantern.name,
          typeLine: lantern.typeLine,
          manaCost: lantern.manaCost!,
          ability: lantern.spellAbility!,
          spellFace: lantern,
          spellFaceText: {
            oracleText: lanternText,
            manaCost: '{3}{B}',
            frontOracleText: frontText,
            frontManaCost: '{3}{B}{B}',
          },
          description: "Cast Tergrid's Lantern",
        },
      ],
    },
    'Tracks the first public graveyard incarnation of sacrificed/discarded cards and supports both modal permanent faces through normal casting, with real Lantern alternatives and untapping.',
  );
}
