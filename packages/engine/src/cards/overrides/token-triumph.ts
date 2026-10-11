import {
  CAT_2_2_WHITE,
  CAT_BEAST_2_2_WHITE,
  INSECT_1_1_FLYING_DEATHTOUCH_GREEN,
  SAPROLING_1_1_GREEN,
  SOLDIER_1_1_LIFELINK,
} from '../tokens';
import { defineCard, unsupportedCard } from './index';
import { TAP, mana, manaCost, spell } from '../templates';
import { constant } from '../value';
import {
  HAS_ANY_COUNTER,
  SELF,
  YOURS,
  OTHER,
  ofSupertype,
  ofType,
  allOf,
  anyOf,
  powerAtMost,
  IN_COMBAT,
  toughnessAtLeast,
} from '../selector';

export function registerTOKEN_TRIUMPHOverrides(): void {
  // Coverage PR01: X is the number of TAPPED creatures you control, fixed as the spell resolves.
  defineCard(
    'ec6d52f9-1c8f-48da-951c-be8d7813c7be',
    'Harvest Season',
    [
      'Search your library for up to X basic land cards, where X is the number of tapped creatures you control, put those cards onto the battlefield tapped, then shuffle.',
    ],
    {
      spellAbility: spell({
        targets: [],
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf(ofSupertype('Basic'), ofType('Land')),
            destinations: [{ zone: 'battlefield', tapped: true }],
            count: { kind: 'countTappedPermanents', selector: ofType('Creature'), scope: 'you' },
            allowFailToFind: true,
          },
          { op: 'shuffle' },
        ],
      }),
    },
  );
  // Idol of Oblivion: restored in coverage PR02. The interpreter reads the draw's "Activate only
  // if you created a token this turn" condition and the 10/10 colorless Eldrazi creature token.
  // Coverage PR01: "up to two" is a 0..2 count slot, so the spell may be cast with no target.
  defineCard(
    'aeec8e85-6571-4da6-8a48-f5d3985ca10b',
    'Sylvan Reclamation',
    ['Exile up to two target artifacts and/or enchantments.'],
    {
      spellAbility: spell({
        targets: [
          {
            kind: 'permanent',
            filter: anyOf(ofType('Artifact'), ofType('Enchantment')),
            count: { min: 0, max: 2 },
          },
        ],
        effects: [{ op: 'exileEachChosen', targetSlot: 0 }],
      }),
    },
  );
  // Karametra's Favor: restored in coverage PR05. The interpreter reads the enters draw and the
  // granted mana ability, so no override remains.
  // Curse of Bounty: restored in coverage PR05. The interpreter reads Enchant player with the
  // player as the Aura's host, and the enchanted-player-attacked trigger untaps the curse
  // controller's nonland permanents and those of the attacking player when that player is an
  // opponent.
  // Coverage PR01: "up to two" is a 0..2 count slot, so the trigger resolves with no target.
  defineCard(
    '761021ce-4559-464e-aa03-85c2fe78e267',
    'Rishkar, Peema Renegade',
    [
      'When ~ enters, put a +1/+1 counter on each of up to two target creatures.',
      'Each creature you control with a counter on it has "{T}: Add {G}."',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'creature', count: { min: 0, max: 2 } }],
          effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
          description: 'Put a +1/+1 counter on each of up to two target creatures',
        },
      ],
      staticEffects: [
        {
          affects: allOf(ofType('Creature'), YOURS, HAS_ANY_COUNTER),
          op: { layer: 6, addManaAbility: { units: [['G']], costs: [TAP] } },
        },
      ],
    },
  );
  // Coverage PR01: the lieutenant buff reaches creatures only, and only while you control
  // your own commander (CR 903.7; a stolen commander does not count).
  defineCard(
    'f55334d9-1ec2-4667-bf28-5a0384d6f053',
    'Thunderfoot Baloth',
    [
      'As long as you control your commander, this creature gets +2/+2 and other creatures you control get +2/+2 and have trample.',
    ],
    {
      staticEffects: [
        {
          affects: SELF,
          op: { layer: 7, sublayer: 'd', power: 2, toughness: 2 },
          condition: { kind: 'controlsYourCommander' },
        },
        {
          affects: allOf(ofType('Creature'), YOURS, OTHER),
          op: { layer: 7, sublayer: 'd', power: 2, toughness: 2 },
          condition: { kind: 'controlsYourCommander' },
        },
        {
          affects: allOf(ofType('Creature'), YOURS, OTHER),
          op: { layer: 6, addKeyword: 'trample' },
          condition: { kind: 'controlsYourCommander' },
        },
      ],
    },
  );
  // Emmara, Soul of the Accord no longer needs an override: the generic parser reads
  // "Whenever ~ becomes tapped, ..." since City of Brass added `becomes tapped` to the object
  // trigger head, and produces the identical IR. The drift guard flagged the stale
  // `handledLines` claim, which is what this comment replaces.
  // Leafkin Druid
  defineCard(
    '55eb9310-f24b-410b-850b-a7d0d5117946',
    'Leafkin Druid',
    ['{T}: Add {G}. If you control four or more creatures, add {G}{G} instead.'],
    {
      manaAbilities: [
        {
          units: [['G']],
          costs: [TAP],
          conditionalUnits: {
            condition: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS),
              scope: 'you',
              cmp: '>=',
              n: 4,
            },
            units: [['G'], ['G']],
          },
        },
      ],
    },
  );
  // Nullmage Shepherd: restored in coverage PR02. "Tap four untapped creatures you control" is
  // a tapOthers cost with allowSelf, so Nullmage Shepherd may be one of the four.
  // Fortified Village
  defineCard(
    '56f1a16a-9f41-41fb-b580-c200bca27cd6',
    'Fortified Village',
    [
      "As this land enters, you may reveal a Forest or Plains card from your hand. If you don't, this land enters tapped.",
    ],
    {
      entersTappedUnless: {
        kind: 'mayRevealCardFromHand',
        subtypes: ['Forest', 'Plains'],
      },
    },
  );
  // Overwhelming Instinct
  defineCard(
    '9ba89c25-5302-414f-a2ec-436b8981999d',
    'Overwhelming Instinct',
    ['Whenever you attack with three or more creatures, draw a card.'],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'attacks',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
            aggregate: true,
            condition: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS, IN_COMBAT),
              scope: 'you',
              cmp: '>=',
              n: 3,
            },
          },
          targets: [],
          effects: [{ op: 'draw', count: constant(1) }],
          description: 'Draw a card',
        },
      ],
    },
  );
  // Ajani, Caller of the Pride
  defineCard(
    '1d5ff280-7f4d-4801-aefd-9b6e6b1f2818',
    'Ajani, Caller of the Pride',
    [
      '+1: Put a +1/+1 counter on up to one target creature.',
      '−3: Target creature gains flying and double strike until end of turn.',
      '−8: Create X 2/2 white Cat creature tokens, where X is your life total.',
    ],
    {
      activatedAbilities: [
        {
          costs: [{ kind: 'loyalty', delta: 1 }],
          timing: 'sorcery',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'creature', count: { min: 0, max: 1 } }],
            effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
            description: '+1: Put a +1/+1 counter on up to one target creature.',
          },
        },
        {
          costs: [{ kind: 'loyalty', delta: -3 }],
          timing: 'sorcery',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'creature' }],
            effects: [
              { op: 'grantKeywordUntilEot', target: 0, keyword: 'flying' },
              { op: 'grantKeywordUntilEot', target: 0, keyword: 'double strike' },
            ],
            description: '-3: Target creature gains flying and double strike until end of turn.',
          },
        },
        {
          costs: [{ kind: 'loyalty', delta: -8 }],
          timing: 'sorcery',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'createToken',
                spec: CAT_2_2_WHITE,
                count: { kind: 'lifeTotal', scope: 'you' },
              },
            ],
            description: '-8: Create X 2/2 white Cat creature tokens, where X is your life total.',
          },
        },
      ],
    },
  );
  // Mentor of the Meek
  defineCard(
    'b9f4f96b-6e54-4fe6-8df7-623e0fc72409',
    'Mentor of the Meek',
    [
      'Whenever another creature you control with power 2 or less enters, you may pay {1}. If you do, draw a card.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: {
              kind: 'permanent',
              selector: allOf(ofType('Creature'), YOURS, OTHER, powerAtMost(2)),
            },
          },
          targets: [],
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'mayPayMana', cost: manaCost('{1}') },
              then: [{ op: 'draw', count: constant(1) }],
              else: [],
            },
          ],
          description:
            'Whenever another creature with power 2 or less enters under your control, you may pay {1}. If you do, draw a card.',
        },
      ],
    },
  );
  // Commander's Insignia
  defineCard(
    '979a5d92-1c67-4fa4-b932-638b0cc1adcd',
    "Commander's Insignia",
    [
      "Creatures you control get +1/+1 for each time you've cast your commander from the command zone this game.",
    ],
    {
      staticEffects: [
        {
          affects: allOf(ofType('Creature'), YOURS),
          op: {
            layer: 7,
            sublayer: 'd',
            power: { kind: 'commanderCastCount', player: 'you' },
            toughness: { kind: 'commanderCastCount', player: 'you' },
          },
        },
      ],
    },
  );
  // Catalog audit token-triumph-batch-6: eliminated players still count as opponents.
  // Coverage PR01: only opponents still in the game are counted (CR 800.4a).
  defineCard(
    '9b40faad-1b96-4461-89d8-9a207b58e832',
    'Voice of Many',
    [
      'When this creature enters, draw a card for each opponent who controls fewer creatures than you.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'draw', count: { kind: 'countOpponentsWithFewerCreatures' } }],
          description: 'Draw a card for each opponent who controls fewer creatures than you',
        },
      ],
    },
  );
  // Loyal Guardian
  defineCard(
    'de1cfa83-2049-48ab-b093-2f120a3ef4f2',
    'Loyal Guardian',
    [
      'At the beginning of combat on your turn, if you control your commander, put a +1/+1 counter on each creature you control.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'beginningOfCombat',
            player: 'you',
            condition: { kind: 'controlsYourCommander' },
          },
          targets: [],
          effects: [
            {
              op: 'putCountersEach',
              selector: allOf(ofType('Creature'), YOURS),
              counter: '+1/+1',
              count: 1,
            },
          ],
          description: 'Put a +1/+1 counter on each creature you control.',
        },
      ],
    },
  );
  // Dawn of Hope
  defineCard(
    'd7a38484-2acc-49a6-b32d-d54dddb14d31',
    'Dawn of Hope',
    ['Whenever you gain life, you may pay {2}. If you do, draw a card.'],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'gainsLife', player: 'you' },
          targets: [],
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'mayPayMana', cost: manaCost('{2}') },
              then: [{ op: 'draw', count: constant(1) }],
              else: [],
            },
          ],
          description: 'Whenever you gain life, you may pay {2}. If you do, draw a card.',
        },
      ],
      activatedAbilities: [
        {
          costs: [mana('{3}{W}')],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'createToken',
                spec: SOLDIER_1_1_LIFELINK,
                count: constant(1),
              },
            ],
            description: '{3}{W}: Create a 1/1 white Soldier creature token with lifelink.',
          },
        },
      ],
    },
  );
  // Hornet Nest
  defineCard(
    '123d2b6e-114e-4767-860d-50790382ca4a',
    'Hornet Nest',
    [
      'Whenever this creature is dealt damage, create that many 1/1 green Insect creature tokens with flying and deathtouch.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'dealtDamage', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: INSECT_1_1_FLYING_DEATHTOUCH_GREEN,
              count: { kind: 'damageDealt' },
            },
          ],
          description:
            'Create that many 1/1 green Insect creature tokens with flying and deathtouch.',
        },
      ],
    },
  );
  // Trostani Discordant
  defineCard(
    '9a2fdc0e-e0de-47fc-95e4-04e725ddf060',
    'Trostani Discordant',
    [
      'When Trostani enters, create two 1/1 white Soldier creature tokens with lifelink.',
      'At the beginning of your end step, each player gains control of all creatures they own.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: SOLDIER_1_1_LIFELINK,
              count: constant(2),
            },
          ],
          description:
            'When ~ enters, create two 1/1 white and green Soldier creature tokens with lifelink.',
        },
        {
          kind: 'triggered',
          trigger: { when: 'endStep', player: 'you' },
          targets: [],
          effects: [{ op: 'regainControlOfOwnCreatures' }],
          description:
            'At the beginning of your end step, each player gains control of all creatures they own.',
        },
      ],
    },
  );
  // Slate of Ancestry
  defineCard(
    'a07483b4-c04f-42a4-b979-8b77c11fa8f5',
    'Slate of Ancestry',
    ['{4}, {T}, Discard your hand: Draw a card for each creature you control.'],
    {
      activatedAbilities: [
        {
          costs: [mana('{4}'), TAP, { kind: 'discardHand' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'draw',
                count: {
                  kind: 'countPermanents',
                  selector: allOf(ofType('Creature'), YOURS),
                  scope: 'you',
                },
              },
            ],
            description: '{4}, {T}, Discard your hand: Draw a card for each creature you control.',
          },
        },
      ],
    },
  );
  // Scavenging Ooze: restored in coverage PR03. The interpreter reads the graveyard exile with its
  // creature-card rider, a real zone change, so no override remains.
  // Felidar Retreat
  defineCard(
    '16629f59-bae8-4c19-bf50-443eb0ed6856',
    'Felidar Retreat',
    [
      'Whenever a land you control enters, choose one —',
      '• Create a 2/2 white Cat Beast creature token.',
      '• Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) },
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
                    op: 'createToken',
                    spec: CAT_BEAST_2_2_WHITE,
                    count: constant(1),
                  },
                ],
                description: 'Create a 2/2 white Beast creature token.',
              },
              {
                effects: [
                  {
                    op: 'putCountersEach',
                    selector: allOf(ofType('Creature'), YOURS),
                    counter: '+1/+1',
                    count: 1,
                  },
                  {
                    op: 'grantKeywordEachUntilEot',
                    selector: allOf(ofType('Creature'), YOURS),
                    keyword: 'vigilance',
                  },
                ],
                description:
                  'Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn.',
              },
            ],
          },
          description: 'Landfall — Choose one',
        },
      ],
    },
  );
  // Great Oak Guardian
  defineCard(
    '5dba7746-c087-4ec1-92ca-ab9882dea24d',
    'Great Oak Guardian',
    [
      'When this creature enters, creatures target player controls get +2/+2 until end of turn. Untap them.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }],
          effects: [
            { op: 'untapTargetPlayerCreatures', targetSlot: 0 },
            { op: 'pumpTargetPlayerCreaturesUntilEot', targetSlot: 0, power: 2, toughness: 2 },
          ],
          description:
            'When ~ enters, untap all creatures target player controls. They get +2/+2 until end of turn.',
        },
      ],
    },
  );
  // Conclave Tribunal: restored in coverage PR02. Convoke is a real payment now (creatures
  // tapped while casting it), so no override remains.
  // Catalog audit token-triumph-batch-7: can't-block is a name check, not a static.
  unsupportedCard(
    'c549b0fd-1e08-4873-952e-a14dc45a0fd2',
    'Champion of Lambholt',
    "The can't-block static is hardcoded by card name, so copies lack it and lost abilities still apply it.",
  );
  // Rootborn Defenses
  defineCard(
    '04046ae4-5c51-434b-930c-f3b1d348bf4b',
    'Rootborn Defenses',
    ['Populate. Creatures you control gain indestructible until end of turn.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'populate' },
          {
            op: 'grantKeywordEachUntilEot',
            selector: allOf(ofType('Creature'), YOURS),
            keyword: 'indestructible',
          },
        ],
        description: 'Populate. Creatures you control gain indestructible until end of turn.',
      },
    },
  );
  // Aura Mutation
  defineCard(
    '19bb51dd-2b93-45f0-927d-bbafddadd0a3',
    'Aura Mutation',
    [
      "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value.",
    ],
    {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'enchantment' }],
        effects: [
          {
            op: 'destroyAndCreateTokensEqualToManaValue',
            target: 0,
            spec: SAPROLING_1_1_GREEN,
          },
        ],
        description:
          "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value.",
      },
    },
  );
  // Citywide Bust
  defineCard(
    '3ac01298-e45b-4ea0-8379-2074279716a4',
    'Citywide Bust',
    ['Destroy all creatures with toughness 4 or greater.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), toughnessAtLeast(4)) }],
        description: 'Destroy all creatures with toughness 4 or greater.',
      },
    },
  );
  // Collective Unconscious
  defineCard(
    '38abf769-e4ef-4b47-9c79-c8cda0b90f6c',
    'Collective Unconscious',
    ['Draw a card for each creature you control.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'draw',
            count: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS),
              scope: 'you',
            },
          },
        ],
        description: 'Draw a card for each creature you control.',
      },
    },
  );
  // Camaraderie
  defineCard(
    '9aab386c-d48c-4611-b757-aa69b26cc1b1',
    'Camaraderie',
    [
      'You gain X life and draw X cards, where X is the number of creatures you control. Creatures you control get +1/+1 until end of turn.',
    ],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'gainLife',
            amount: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS),
              scope: 'you',
            },
          },
          {
            op: 'draw',
            count: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS),
              scope: 'you',
            },
          },
          {
            op: 'pumpEachUntilEot',
            selector: allOf(ofType('Creature'), YOURS),
            power: 1,
            toughness: 1,
          },
        ],
        description:
          'You gain X life and draw X cards, where X is the number of creatures you control. Creatures you control get +1/+1 until end of turn.',
      },
    },
  );
  // Hour of Reckoning: restored in coverage PR02. Convoke is a real payment now, so no override
  // remains.
}
