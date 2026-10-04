/** Authored overrides for queen-marchesa-queens-gambit.txt. */

import type { CardDefinition } from '../definition';
import { constant } from '../value';
import { allOf, ofSupertype, ofType, YOURS } from '../selector';
import { defineCard, unsupportedCard } from './index';
import { ASSASSIN_1_1 as ASSASSIN_TOKEN, ELEPHANT_3_3_GREEN, HUMAN_1_1_WHITE } from '../tokens';

const BOROS_CHARM: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'playerOrPlaneswalker' }, { kind: 'creature' }],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        {
          description: 'Deal 4 damage to target player or planeswalker',
          targetSlots: [0],
          effects: [{ op: 'dealDamage', target: 0, amount: constant(4) }],
        },
        {
          description: 'Permanents you control gain indestructible until end of turn',
          targetSlots: [],
          effects: [{ op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'indestructible' }],
        },
        {
          description: 'Target creature gains double strike until end of turn',
          targetSlots: [1],
          effects: [{ op: 'grantKeywordUntilEot', target: 1, keyword: 'double strike' }],
        },
      ],
    },
    effects: [],
    description: 'Choose one — Boros Charm mode',
  },
};

const RAKDOS_CHARM: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'player' }, { kind: 'artifact' }],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        {
          description: "Exile target player's graveyard",
          targetSlots: [0],
          effects: [{ op: 'exileTargetPlayerGraveyard', target: 0 }],
        },
        {
          description: 'Destroy target artifact',
          targetSlots: [1],
          effects: [{ op: 'destroy', target: 1 }],
        },
        {
          description: 'Each creature deals 1 damage to its controller',
          targetSlots: [],
          effects: [{ op: 'damageEachCreatureController', amount: constant(1) }],
        },
      ],
    },
    effects: [],
    description: 'Choose one — Rakdos Charm mode',
  },
};

const QUEEN_MARCHESA: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'enters', subject: { kind: 'self' } },
      targets: [],
      effects: [{ op: 'becomeMonarch' }],
      description: 'Enters — you become the monarch',
    },
    {
      kind: 'triggered',
      trigger: { when: 'upkeep', player: 'you', condition: { kind: 'opponentIsMonarch' } },
      targets: [],
      effects: [{ op: 'createToken', count: constant(1), spec: ASSASSIN_TOKEN }],
      description: 'Upkeep — if an opponent is the monarch, create an Assassin',
    },
  ],
};

const GENEROUS_GIFT: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'permanent' }],
    effects: [
      {
        op: 'destroyAndCreateTokenForController',
        target: 0,
        count: constant(1),
        spec: ELEPHANT_3_3_GREEN,
      },
    ],
    description: 'Destroy target permanent; its controller creates a 3/3 Elephant',
  },
};

const STROKE_OF_MIDNIGHT: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'nonlandPermanent' }],
    effects: [
      {
        op: 'destroyAndCreateTokenForController',
        target: 0,
        count: constant(1),
        spec: HUMAN_1_1_WHITE,
      },
    ],
    description: 'Destroy target nonland permanent; its controller creates a 1/1 Human',
  },
};

const SWORDS_TO_PLOWSHARES: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'creature' }],
    effects: [{ op: 'exileAndGainLifeTargetController', target: 0 }],
    description: 'Exile target creature; its controller gains life equal to its power',
  },
};

export const FABLED_PASSAGE_HANDLED_LINES: string[] = [
  'unrecognized rules text: "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land."',
];

export const FABLED_PASSAGE_CANDIDATE: Partial<CardDefinition> = {
  activatedAbilities: [
    {
      costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf(ofSupertype('Basic'), ofType('Land')),
            destinations: [{ zone: 'battlefield', tapped: true }],
            bind: 'foundLand',
            allowFailToFind: true,
          },
          { op: 'shuffle' },
          {
            op: 'untapBoundIf',
            binding: 'foundLand',
            condition: {
              kind: 'countPermanents',
              selector: ofType('Land'),
              scope: 'you',
              cmp: '>=',
              n: 4,
            },
          },
        ],
        description: 'Search for a basic land; untap it if you control four or more lands',
      },
    },
  ],
};

export function registerQUEEN_MARCHESA_QUEENS_GAMBITOverrides(): void {
  // Blightstep/Brightclimb/Needleverge Pathway: a modal-DFC "choose a color as it enters" land
  // now parses generically (`buildPathwayLand` in interpret.ts) -- no override needed at all.
  // Malakir Rebirth // Malakir Mire and Valakut Awakening // Valakut Stoneforge are a different
  // shape (spell // land, not land // land) that generic function doesn't cover; their real
  // overrides are in queen-marchesa-queens-gambit-remaining.ts. Wandering Archaic //
  // Explore the Vastlands (creature // enchantment) stays `unimplemented()` there too.

  // Catalog audit queen-main-batch-2: fuse stub; remaining file already contains the same ID.
  unsupportedCard(
    '9842734c-1eac-4509-a731-4c22017ae586',
    'Wear // Tear',
    'Fuse is authored as a third mode with an extra {2}{W} rather than casting both halves.',
  );
  defineCard(
    '2679d0dd-ba30-4a1c-b6a0-b3ac6c790496',
    'Boros Charm',
    [
      'unrecognized rules text: "Choose one —"',
      'unrecognized rules text: "• ~ deals 4 damage to target player or planeswalker."',
      'unrecognized rules text: "• Permanents you control gain indestructible until end of turn."',
      'unrecognized rules text: "• Target creature gains double strike until end of turn."',
    ],
    BOROS_CHARM,
  );
  defineCard(
    '5e62b51d-faec-4aa0-9504-cf2c282d08ea',
    'Rakdos Charm',
    [
      'unrecognized rules text: "Choose one —"',
      'unrecognized rules text: "• Exile target player\'s graveyard."',
      'unrecognized rules text: "• Destroy target artifact."',
      'unrecognized rules text: "• Each creature deals 1 damage to its controller."',
    ],
    RAKDOS_CHARM,
  );
  // Catalog audit queen-main-batch-1: gainControl has no until-end-of-turn duration.
  unsupportedCard(
    'acca2128-6ebb-48a5-a6a2-1bc5e4aa86ce',
    'Mob Rule',
    'Until-end-of-turn steal is implemented as permanent gainControl.',
  );
  defineCard(
    'd7ac4be1-dcca-49b6-8ddb-d1b0e6cf2dcf',
    'Queen Marchesa',
    [
      'unrecognized rules text: "When ~ enters, you become the monarch."',
      'unrecognized rules text: "At the beginning of your upkeep, if an opponent is the monarch, create a 1/1 black Assassin creature token with deathtouch and haste."',
    ],
    QUEEN_MARCHESA,
  );
  // The "destroy target X, its controller creates a token" line now parses generically
  // (`parseDestroyAndCreateTokenBlock`), so there is no longer an unmodeled reason to claim —
  // handledLines is empty. The `def` stays: the generic parser's own token spec derivation
  // prints `typeLine: "Token Creature — Elephant"`, one word off the shared catalog's
  // `"Creature — Elephant"` (`tokens.ts`'s `creatureToken`), and this override's job is now
  // solely to keep this card on the catalog token rather than the parser's own near-miss.
  defineCard('fae37e28-e137-4177-b973-fa8b4dd8f409', 'Generous Gift', [], GENEROUS_GIFT);
  defineCard('9a107e48-3d50-4941-95b1-10f2b29a4245', 'Stroke of Midnight', [], STROKE_OF_MIDNIGHT);
  defineCard(
    'b1544f21-7e98-461b-aed5-e748b0168c52',
    'Swords to Plowshares',
    [
      'unrecognized rules text: "Exile target creature. Its controller gains life equal to its power."',
    ],
    SWORDS_TO_PLOWSHARES,
  );
  defineCard(
    '0c85b8f7-0bd0-4680-9ec5-d4b110460a54',
    'Fabled Passage',
    FABLED_PASSAGE_HANDLED_LINES,
    FABLED_PASSAGE_CANDIDATE,
  );
  // Boros/Orzhov/Rakdos Signet: no override needed at all now — a "{1}, {T}: Add {X}{Y}." line
  // parses generically as a stack-based activated ability (`interpret.ts`'s `MANA_ABILITY_RE`
  // case in `parseEffectSentence`), with no token/typeLine divergence risk the way the
  // destroy-and-create-token cards above have. Deleted rather than kept-empty.
  defineCard(
    '8fa3ac81-3dfe-4565-be99-5554f7597b4b',
    'Boros Garrison',
    [
      'unrecognized rules text: "When this land enters, return a land you control to its owner\'s hand."',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'returnOneToHand', selector: allOf(ofType('Land'), YOURS) }],
          description: 'Enters — return a land you control to its owner’s hand',
        },
      ],
    },
  );
  defineCard(
    'aa00ae0b-7c0f-427e-8102-ce0e2a6af5df',
    'Orzhov Basilica',
    [
      'unrecognized rules text: "When this land enters, return a land you control to its owner\'s hand."',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'returnOneToHand', selector: allOf(ofType('Land'), YOURS) }],
          description: 'Enters — return a land you control to its owner’s hand',
        },
      ],
    },
  );
  defineCard(
    '0a023964-2905-4928-9c3e-dc63e6ebd218',
    'Rakdos Carnarium',
    [
      'unrecognized rules text: "When this land enters, return a land you control to its owner\'s hand."',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'returnOneToHand', selector: allOf(ofType('Land'), YOURS) }],
          description: 'Enters — return a land you control to its owner’s hand',
        },
      ],
    },
  );
}
