import { registerOverride } from './index';
import { parseManaCost } from '../../mana/cost';
import { constant } from '../value';
import {
  YOURS,
  OTHER,
  ofType,
  ofSubtype,
  ofSupertype,
  allOf,
  anyOf,
  not,
  powerAtMost,
  HAS_ANY_COUNTER,
  SELF,
  IN_COMBAT,
  toughnessAtLeast,
  IS_TOKEN,
} from '../selector';

export function registerTOKEN_TRIUMPHOverrides(): void {
  // Emmara, Soul of the Accord
  registerOverride({
    oracleId: "c65ba242-3369-48a9-864f-1b1f85238f67",
    name: "Emmara, Soul of the Accord",
    handledLines: [
    "Whenever ~ becomes tapped, create a 1/1 white Soldier creature token with lifelink."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'becomesTapped', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: {
                name: 'Soldier',
                typeLine: 'Creature — Soldier',
                types: ['Creature'],
                subtypes: ['Soldier'],
                colors: ['W'],
                power: 1,
                toughness: 1,
                keywords: ['lifelink'],
              },
              count: constant(1),
            },
          ],
          description: 'Create a 1/1 white Soldier creature token with lifelink',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-emmara-soul-of-the-accord",
    name: "Emmara, Soul of the Accord",
    handledLines: [
    "Whenever ~ becomes tapped, create a 1/1 white Soldier creature token with lifelink."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'becomesTapped', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: {
                name: 'Soldier',
                typeLine: 'Creature — Soldier',
                types: ['Creature'],
                subtypes: ['Soldier'],
                colors: ['W'],
                power: 1,
                toughness: 1,
                keywords: ['lifelink'],
              },
              count: constant(1),
            },
          ],
          description: 'Create a 1/1 white Soldier creature token with lifelink',
        },
      ],
    },
  });
  // Karametra's Favor
  registerOverride({
    oracleId: "fc3e48c9-e303-435c-bdb1-7dc7881a9858",
    name: "Karametra's Favor",
    handledLines: [
    "Enchanted creature has \"{T}: Add one mana of any color.\""
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'draw', count: constant(1) }],
          description: 'Draw a card',
        },
      ],
      staticEffects: [
        {
          affects: { kind: 'attachedToSource' },
          op: {
            layer: 6,
            addManaAbility: { units: [['W'], ['U'], ['B'], ['R'], ['G']] },
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-karametra-s-favor",
    name: "Karametra's Favor",
    handledLines: [
    "Enchanted creature has \"{T}: Add one mana of any color.\""
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'draw', count: constant(1) }],
          description: 'Draw a card',
        },
      ],
      staticEffects: [
        {
          affects: { kind: 'attachedToSource' },
          op: {
            layer: 6,
            addManaAbility: { units: [['W'], ['U'], ['B'], ['R'], ['G']] },
          },
        },
      ],
    },
  });
  // Leafkin Druid
  registerOverride({
    oracleId: "55eb9310-f24b-410b-850b-a7d0d5117946",
    name: "Leafkin Druid",
    handledLines: [
    "{T}: Add {G}. If you control four or more creatures, add {G}{G} instead."
],
    def: {
      manaAbilities: [
        {
          units: [['G']],
          costs: [{ kind: 'tap' }],
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
  });
  registerOverride({
    oracleId: "oracle-leafkin-druid",
    name: "Leafkin Druid",
    handledLines: [
    "{T}: Add {G}. If you control four or more creatures, add {G}{G} instead."
],
    def: {
      manaAbilities: [
        {
          units: [['G']],
          costs: [{ kind: 'tap' }],
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
  });
  // Nullmage Shepherd
  registerOverride({
    oracleId: "4dcfd397-9d29-420c-8fd8-c7c2a99de122",
    name: "Nullmage Shepherd",
    handledLines: [
    "Tap four untapped creatures you control: Destroy target artifact or enchantment."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'tapOthers', selector: allOf(ofType('Creature'), YOURS), count: 4 }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'artifactOrEnchantment' }],
            effects: [{ op: 'destroy', target: 0 }],
            description: 'Destroy target artifact or enchantment',
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-nullmage-shepherd",
    name: "Nullmage Shepherd",
    handledLines: [
    "Tap four untapped creatures you control: Destroy target artifact or enchantment."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'tapOthers', selector: allOf(ofType('Creature'), YOURS), count: 4 }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'artifactOrEnchantment' }],
            effects: [{ op: 'destroy', target: 0 }],
            description: 'Destroy target artifact or enchantment',
          },
        },
      ],
    },
  });
  // Thunderfoot Baloth
  registerOverride({
    oracleId: "f55334d9-1ec2-4667-bf28-5a0384d6f053",
    name: "Thunderfoot Baloth",
    handledLines: [
    "As long as you control your commander, this creature gets +2/+2 and other creatures you control get +2/+2 and have trample."
],
    def: {
      staticEffects: [
        {
          condition: { kind: 'controlsYourCommander' },
          affects: YOURS,
          op: { layer: 7, sublayer: 'd', power: 2, toughness: 2 },
        },
        {
          condition: { kind: 'controlsYourCommander' },
          affects: allOf(YOURS, OTHER),
          op: { layer: 6, addKeyword: 'trample' },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-thunderfoot-baloth",
    name: "Thunderfoot Baloth",
    handledLines: [
    "As long as you control your commander, this creature gets +2/+2 and other creatures you control get +2/+2 and have trample."
],
    def: {
      staticEffects: [
        {
          condition: { kind: 'controlsYourCommander' },
          affects: YOURS,
          op: { layer: 7, sublayer: 'd', power: 2, toughness: 2 },
        },
        {
          condition: { kind: 'controlsYourCommander' },
          affects: allOf(YOURS, OTHER),
          op: { layer: 6, addKeyword: 'trample' },
        },
      ],
    },
  });
  // Fortified Village
  registerOverride({
    oracleId: "56f1a16a-9f41-41fb-b580-c200bca27cd6",
    name: "Fortified Village",
    handledLines: [
    "As this land enters, you may reveal a Forest or Plains card from your hand. If you don't, this land enters tapped."
],
    def: {
      entersTappedUnless: {
        kind: 'mayRevealCardFromHand',
        subtypes: ['Forest', 'Plains'],
      },
    },
  });
  registerOverride({
    oracleId: "oracle-fortified-village",
    name: "Fortified Village",
    handledLines: [
    "As this land enters, you may reveal a Forest or Plains card from your hand. If you don't, this land enters tapped."
],
    def: {
      entersTappedUnless: {
        kind: 'mayRevealCardFromHand',
        subtypes: ['Forest', 'Plains'],
      },
    },
  });
  // Overwhelming Instinct
  registerOverride({
    oracleId: "9ba89c25-5302-414f-a2ec-436b8981999d",
    name: "Overwhelming Instinct",
    handledLines: [
    "Whenever you attack with three or more creatures, draw a card."
],
    def: {
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
  });
  registerOverride({
    oracleId: "oracle-overwhelming-instinct",
    name: "Overwhelming Instinct",
    handledLines: [
    "Whenever you attack with three or more creatures, draw a card."
],
    def: {
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
  });
  // Rishkar, Peema Renegade
  registerOverride({
    oracleId: "761021ce-4559-464e-aa03-85c2fe78e267",
    name: "Rishkar, Peema Renegade",
    handledLines: [
    "When ~ enters, put a +1/+1 counter on each of up to two target creatures.",
    "Each creature you control with a counter on it has \"{T}: Add {G}.\""
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'creature', count: { min: 1, max: 2 } }],
          effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
          description: 'Put a +1/+1 counter on each of up to two target creatures.',
        },
      ],
      staticEffects: [
        {
          affects: allOf(ofType('Creature'), YOURS, HAS_ANY_COUNTER),
          op: {
            layer: 6,
            addManaAbility: { units: [['G']], costs: [{ kind: 'tap' }] },
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-rishkar-peema-renegade",
    name: "Rishkar, Peema Renegade",
    handledLines: [
    "When ~ enters, put a +1/+1 counter on each of up to two target creatures.",
    "Each creature you control with a counter on it has \"{T}: Add {G}.\""
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'creature', count: { min: 1, max: 2 } }],
          effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
          description: 'Put a +1/+1 counter on each of up to two target creatures.',
        },
      ],
      staticEffects: [
        {
          affects: allOf(ofType('Creature'), YOURS, HAS_ANY_COUNTER),
          op: {
            layer: 6,
            addManaAbility: { units: [['G']], costs: [{ kind: 'tap' }] },
          },
        },
      ],
    },
  });
  // Ajani, Caller of the Pride
  registerOverride({
    oracleId: "1d5ff280-7f4d-4801-aefd-9b6e6b1f2818",
    name: "Ajani, Caller of the Pride",
    handledLines: [
    "+1: Put a +1/+1 counter on up to one target creature.",
    "−3: Target creature gains flying and double strike until end of turn.",
    "−8: Create X 2/2 white Cat creature tokens, where X is your life total."
],
    def: {
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
                spec: { name: 'Cat', typeLine: 'Creature — Cat', types: ['Creature'], subtypes: ['Cat'], colors: ['W'], power: 2, toughness: 2 },
                count: { kind: 'lifeTotal', scope: 'you' },
              },
            ],
            description: '-8: Create X 2/2 white Cat creature tokens, where X is your life total.',
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-ajani-caller-of-the-pride",
    name: "Ajani, Caller of the Pride",
    handledLines: [
    "+1: Put a +1/+1 counter on up to one target creature.",
    "−3: Target creature gains flying and double strike until end of turn.",
    "−8: Create X 2/2 white Cat creature tokens, where X is your life total."
],
    def: {
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
                spec: { name: 'Cat', typeLine: 'Creature — Cat', types: ['Creature'], subtypes: ['Cat'], colors: ['W'], power: 2, toughness: 2 },
                count: { kind: 'lifeTotal', scope: 'you' },
              },
            ],
            description: '-8: Create X 2/2 white Cat creature tokens, where X is your life total.',
          },
        },
      ],
    },
  });
  // Sylvan Reclamation
  registerOverride({
    oracleId: "aeec8e85-6571-4da6-8a48-f5d3985ca10b",
    name: "Sylvan Reclamation",
    handledLines: [
    "Exile up to two target artifacts and/or enchantments."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'artifactOrEnchantment', count: { min: 1, max: 2 } }],
        effects: [{ op: 'exileEachChosen', targetSlot: 0 }],
        description: 'Exile up to two target artifacts and/or enchantments.',
      },
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{2}').cost! }, { kind: 'discardSelf' }],
          timing: 'any',
          zone: 'hand',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'searchLibrary',
                filter: allOf(ofType('Land'), ofSupertype('Basic')),
                destinations: [{ zone: 'hand' }],
              },
            ],
            description: 'Basic landcycling {2}',
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-sylvan-reclamation",
    name: "Sylvan Reclamation",
    handledLines: [
    "Exile up to two target artifacts and/or enchantments."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'artifactOrEnchantment', count: { min: 1, max: 2 } }],
        effects: [{ op: 'exileEachChosen', targetSlot: 0 }],
        description: 'Exile up to two target artifacts and/or enchantments.',
      },
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{2}').cost! }, { kind: 'discardSelf' }],
          timing: 'any',
          zone: 'hand',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'searchLibrary',
                filter: allOf(ofType('Land'), ofSupertype('Basic')),
                destinations: [{ zone: 'hand' }],
              },
            ],
            description: 'Basic landcycling {2}',
          },
        },
      ],
    },
  });
  // Mentor of the Meek
  registerOverride({
    oracleId: "b9f4f96b-6e54-4fe6-8df7-623e0fc72409",
    name: "Mentor of the Meek",
    handledLines: [
    "Whenever another creature you control with power 2 or less enters, you may pay {1}. If you do, draw a card."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, OTHER, powerAtMost(2)) },
          },
          targets: [],
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'mayPayMana', cost: parseManaCost('{1}').cost! },
              then: [{ op: 'draw', count: constant(1) }],
              else: [],
            },
          ],
          description: 'Whenever another creature with power 2 or less enters under your control, you may pay {1}. If you do, draw a card.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-mentor-of-the-meek",
    name: "Mentor of the Meek",
    handledLines: [
    "Whenever another creature you control with power 2 or less enters, you may pay {1}. If you do, draw a card."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, OTHER, powerAtMost(2)) },
          },
          targets: [],
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'mayPayMana', cost: parseManaCost('{1}').cost! },
              then: [{ op: 'draw', count: constant(1) }],
              else: [],
            },
          ],
          description: 'Whenever another creature with power 2 or less enters under your control, you may pay {1}. If you do, draw a card.',
        },
      ],
    },
  });
  // Commander's Insignia
  registerOverride({
    oracleId: "979a5d92-1c67-4fa4-b932-638b0cc1adcd",
    name: "Commander's Insignia",
    handledLines: [
    "Creatures you control get +1/+1 for each time you've cast your commander from the command zone this game."
],
    def: {
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
  });
  registerOverride({
    oracleId: "oracle-commander-s-insignia",
    name: "Commander's Insignia",
    handledLines: [
    "Creatures you control get +1/+1 for each time you've cast your commander from the command zone this game."
],
    def: {
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
  });
  // Voice of Many
  registerOverride({
    oracleId: "9b40faad-1b96-4461-89d8-9a207b58e832",
    name: "Voice of Many",
    handledLines: [
    "When this creature enters, draw a card for each opponent who controls fewer creatures than you."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'draw',
              count: { kind: 'countOpponentsWithFewerCreatures' },
            },
          ],
          description: 'Draw a card for each opponent who controls fewer creatures than you.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-voice-of-many",
    name: "Voice of Many",
    handledLines: [
    "When this creature enters, draw a card for each opponent who controls fewer creatures than you."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'draw',
              count: { kind: 'countOpponentsWithFewerCreatures' },
            },
          ],
          description: 'Draw a card for each opponent who controls fewer creatures than you.',
        },
      ],
    },
  });
  // Loyal Guardian
  registerOverride({
    oracleId: "de1cfa83-2049-48ab-b093-2f120a3ef4f2",
    name: "Loyal Guardian",
    handledLines: [
    "At the beginning of combat on your turn, if you control your commander, put a +1/+1 counter on each creature you control."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'beginningOfCombat', player: 'you', condition: { kind: 'controlsYourCommander' } },
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
  });
  registerOverride({
    oracleId: "oracle-loyal-guardian",
    name: "Loyal Guardian",
    handledLines: [
    "At the beginning of combat on your turn, if you control your commander, put a +1/+1 counter on each creature you control."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'beginningOfCombat', player: 'you', condition: { kind: 'controlsYourCommander' } },
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
  });
  // Dawn of Hope
  registerOverride({
    oracleId: "d7a38484-2acc-49a6-b32d-d54dddb14d31",
    name: "Dawn of Hope",
    handledLines: [
    "Whenever you gain life, you may pay {2}. If you do, draw a card."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'gainsLife', player: 'you' },
          targets: [],
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'mayPayMana', cost: parseManaCost('{2}').cost! },
              then: [{ op: 'draw', count: constant(1) }],
              else: [],
            },
          ],
          description: 'Whenever you gain life, you may pay {2}. If you do, draw a card.',
        },
      ],
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{3}{W}').cost! }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'createToken',
                spec: { name: 'Soldier', typeLine: 'Creature — Soldier', types: ['Creature'], subtypes: ['Soldier'], colors: ['W'], power: 1, toughness: 1, keywords: ['lifelink'] },
                count: constant(1),
              },
            ],
            description: '{3}{W}: Create a 1/1 white Soldier creature token with lifelink.',
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-dawn-of-hope",
    name: "Dawn of Hope",
    handledLines: [
    "Whenever you gain life, you may pay {2}. If you do, draw a card."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'gainsLife', player: 'you' },
          targets: [],
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'mayPayMana', cost: parseManaCost('{2}').cost! },
              then: [{ op: 'draw', count: constant(1) }],
              else: [],
            },
          ],
          description: 'Whenever you gain life, you may pay {2}. If you do, draw a card.',
        },
      ],
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{3}{W}').cost! }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'createToken',
                spec: { name: 'Soldier', typeLine: 'Creature — Soldier', types: ['Creature'], subtypes: ['Soldier'], colors: ['W'], power: 1, toughness: 1, keywords: ['lifelink'] },
                count: constant(1),
              },
            ],
            description: '{3}{W}: Create a 1/1 white Soldier creature token with lifelink.',
          },
        },
      ],
    },
  });
  // Hornet Nest
  registerOverride({
    oracleId: "123d2b6e-114e-4767-860d-50790382ca4a",
    name: "Hornet Nest",
    handledLines: [
    "Whenever this creature is dealt damage, create that many 1/1 green Insect creature tokens with flying and deathtouch."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'dealtDamage', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: { name: 'Insect', typeLine: 'Creature — Insect', types: ['Creature'], subtypes: ['Insect'], colors: ['G'], power: 1, toughness: 1, keywords: ['flying', 'deathtouch'] },
              count: { kind: 'damageDealt' },
            },
          ],
          description: 'Create that many 1/1 green Insect creature tokens with flying and deathtouch.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-hornet-nest",
    name: "Hornet Nest",
    handledLines: [
    "Whenever this creature is dealt damage, create that many 1/1 green Insect creature tokens with flying and deathtouch."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'dealtDamage', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: { name: 'Insect', typeLine: 'Creature — Insect', types: ['Creature'], subtypes: ['Insect'], colors: ['G'], power: 1, toughness: 1, keywords: ['flying', 'deathtouch'] },
              count: { kind: 'damageDealt' },
            },
          ],
          description: 'Create that many 1/1 green Insect creature tokens with flying and deathtouch.',
        },
      ],
    },
  });
  // Idol of Oblivion
  registerOverride({
    oracleId: "c232d974-9c65-4bce-b045-e5a7cc0c62e0",
    name: "Idol of Oblivion",
    handledLines: [
    "{T}: Draw a card. Activate only if you created a token this turn."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'tap' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'conditionalEffect',
                condition: { kind: 'createdTokenThisTurn' },
                then: [{ op: 'draw', count: constant(1) }],
                else: [],
              },
            ],
            description: '{T}: Draw a card. Activate only if you created a token this turn.',
          },
        },
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{8}').cost! }, { kind: 'tap' }, { kind: 'sacrificeSelf' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'createToken',
                spec: { name: 'Eldrazi Construct', typeLine: 'Artifact Creature — Eldrazi Construct', types: ['Artifact', 'Creature'], subtypes: ['Eldrazi', 'Construct'], colors: [], power: 10, toughness: 10 },
                count: constant(1),
              },
            ],
            description: '{8}, {T}, Sacrifice ~: Create a 10/10 colorless Eldrazi Construct artifact creature token.',
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-idol-of-oblivion",
    name: "Idol of Oblivion",
    handledLines: [
    "{T}: Draw a card. Activate only if you created a token this turn."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'tap' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'conditionalEffect',
                condition: { kind: 'createdTokenThisTurn' },
                then: [{ op: 'draw', count: constant(1) }],
                else: [],
              },
            ],
            description: '{T}: Draw a card. Activate only if you created a token this turn.',
          },
        },
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{8}').cost! }, { kind: 'tap' }, { kind: 'sacrificeSelf' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'createToken',
                spec: { name: 'Eldrazi Construct', typeLine: 'Artifact Creature — Eldrazi Construct', types: ['Artifact', 'Creature'], subtypes: ['Eldrazi', 'Construct'], colors: [], power: 10, toughness: 10 },
                count: constant(1),
              },
            ],
            description: '{8}, {T}, Sacrifice ~: Create a 10/10 colorless Eldrazi Construct artifact creature token.',
          },
        },
      ],
    },
  });
  // Trostani Discordant
  registerOverride({
    oracleId: "9a2fdc0e-e0de-47fc-95e4-04e725ddf060",
    name: "Trostani Discordant",
    handledLines: [
    "When Trostani enters, create two 1/1 white Soldier creature tokens with lifelink.",
    "At the beginning of your end step, each player gains control of all creatures they own."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: { name: 'Soldier', typeLine: 'Creature — Soldier', types: ['Creature'], subtypes: ['Soldier'], colors: ['W', 'G'], power: 1, toughness: 1, keywords: ['lifelink'] },
              count: constant(2),
            },
          ],
          description: 'When ~ enters, create two 1/1 white and green Soldier creature tokens with lifelink.',
        },
        {
          kind: 'triggered',
          trigger: { when: 'endStep', player: 'you' },
          targets: [],
          effects: [{ op: 'regainControlOfOwnCreatures' }],
          description: 'At the beginning of your end step, each player gains control of all creatures they own.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-trostani-discordant",
    name: "Trostani Discordant",
    handledLines: [
    "When Trostani enters, create two 1/1 white Soldier creature tokens with lifelink.",
    "At the beginning of your end step, each player gains control of all creatures they own."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'createToken',
              spec: { name: 'Soldier', typeLine: 'Creature — Soldier', types: ['Creature'], subtypes: ['Soldier'], colors: ['W', 'G'], power: 1, toughness: 1, keywords: ['lifelink'] },
              count: constant(2),
            },
          ],
          description: 'When ~ enters, create two 1/1 white and green Soldier creature tokens with lifelink.',
        },
        {
          kind: 'triggered',
          trigger: { when: 'endStep', player: 'you' },
          targets: [],
          effects: [{ op: 'regainControlOfOwnCreatures' }],
          description: 'At the beginning of your end step, each player gains control of all creatures they own.',
        },
      ],
    },
  });
  // Harvest Season
  registerOverride({
    oracleId: "ec6d52f9-1c8f-48da-951c-be8d7813c7be",
    name: "Harvest Season",
    handledLines: [
    "Search your library for up to X basic land cards, where X is the number of tapped creatures you control, put those cards onto the battlefield tapped, then shuffle."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf(ofType('Land'), ofSupertype('Basic')),
            destinations: [{ zone: 'battlefield', tapped: true }],
            count: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS),
              scope: 'you',
            },
          },
        ],
        description: 'Search your library for up to X basic land cards...',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-harvest-season",
    name: "Harvest Season",
    handledLines: [
    "Search your library for up to X basic land cards, where X is the number of tapped creatures you control, put those cards onto the battlefield tapped, then shuffle."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf(ofType('Land'), ofSupertype('Basic')),
            destinations: [{ zone: 'battlefield', tapped: true }],
            count: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS),
              scope: 'you',
            },
          },
        ],
        description: 'Search your library for up to X basic land cards...',
      },
    },
  });
  // Slate of Ancestry
  registerOverride({
    oracleId: "a07483b4-c04f-42a4-b979-8b77c11fa8f5",
    name: "Slate of Ancestry",
    handledLines: [
    "{4}, {T}, Discard your hand: Draw a card for each creature you control."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{4}').cost! }, { kind: 'tap' }, { kind: 'discardHand' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'draw',
                count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' },
              },
            ],
            description: '{4}, {T}, Discard your hand: Draw a card for each creature you control.',
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-slate-of-ancestry",
    name: "Slate of Ancestry",
    handledLines: [
    "{4}, {T}, Discard your hand: Draw a card for each creature you control."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{4}').cost! }, { kind: 'tap' }, { kind: 'discardHand' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'draw',
                count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' },
              },
            ],
            description: '{4}, {T}, Discard your hand: Draw a card for each creature you control.',
          },
        },
      ],
    },
  });
  // Scavenging Ooze
  registerOverride({
    oracleId: "1ff25f67-36a7-4cfa-a2b1-2135b5b6fb67",
    name: "Scavenging Ooze",
    handledLines: [
    "{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this creature and you gain 1 life."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{G}').cost! }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'cardInGraveyard' }],
            effects: [{ op: 'exileTargetGraveyardAndBuffIfCreature', targetSlot: 0 }],
            description: '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on ~ and you gain 1 life.',
          },
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-scavenging-ooze",
    name: "Scavenging Ooze",
    handledLines: [
    "{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this creature and you gain 1 life."
],
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'mana', cost: parseManaCost('{G}').cost! }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'cardInGraveyard' }],
            effects: [{ op: 'exileTargetGraveyardAndBuffIfCreature', targetSlot: 0 }],
            description: '{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on ~ and you gain 1 life.',
          },
        },
      ],
    },
  });
  // Felidar Retreat
  registerOverride({
    oracleId: "16629f59-bae8-4c19-bf50-443eb0ed6856",
    name: "Felidar Retreat",
    handledLines: [
    "Whenever a land you control enters, choose one —",
    "• Create a 2/2 white Cat Beast creature token.",
    "• Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) } },
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
                    spec: { name: 'Cat Beast', typeLine: 'Creature — Cat Beast', types: ['Creature'], subtypes: ['Cat', 'Beast'], colors: ['W'], power: 2, toughness: 2 },
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
                description: 'Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn.',
              },
            ],
          },
          description: 'Landfall — Choose one',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-felidar-retreat",
    name: "Felidar Retreat",
    handledLines: [
    "Whenever a land you control enters, choose one —",
    "• Create a 2/2 white Cat Beast creature token.",
    "• Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) } },
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
                    spec: { name: 'Cat Beast', typeLine: 'Creature — Cat Beast', types: ['Creature'], subtypes: ['Cat', 'Beast'], colors: ['W'], power: 2, toughness: 2 },
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
                description: 'Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn.',
              },
            ],
          },
          description: 'Landfall — Choose one',
        },
      ],
    },
  });
  // Great Oak Guardian
  registerOverride({
    oracleId: "5dba7746-c087-4ec1-92ca-ab9882dea24d",
    name: "Great Oak Guardian",
    handledLines: [
    "When this creature enters, creatures target player controls get +2/+2 until end of turn. Untap them."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }],
          effects: [
            { op: 'untapTargetPlayerCreatures', targetSlot: 0 },
            { op: 'pumpTargetPlayerCreaturesUntilEot', targetSlot: 0, power: 2, toughness: 2 },
          ],
          description: 'When ~ enters, untap all creatures target player controls. They get +2/+2 until end of turn.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-great-oak-guardian",
    name: "Great Oak Guardian",
    handledLines: [
    "When this creature enters, creatures target player controls get +2/+2 until end of turn. Untap them."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }],
          effects: [
            { op: 'untapTargetPlayerCreatures', targetSlot: 0 },
            { op: 'pumpTargetPlayerCreaturesUntilEot', targetSlot: 0, power: 2, toughness: 2 },
          ],
          description: 'When ~ enters, untap all creatures target player controls. They get +2/+2 until end of turn.',
        },
      ],
    },
  });
  // Conclave Tribunal
  registerOverride({
    oracleId: "e938ee4c-d5df-4d93-bd61-9e518fb1dc30",
    name: "Conclave Tribunal",
    handledLines: [
    "When this enchantment enters, exile target nonland permanent an opponent controls until this enchantment leaves the battlefield."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'nonlandPermanent', controller: 'opponent' }],
          effects: [{ op: 'exileUntilSourceLeaves', targetSlot: 0 }],
          description: 'When ~ enters, exile target nonland permanent an opponent controls until ~ leaves the battlefield.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-conclave-tribunal",
    name: "Conclave Tribunal",
    handledLines: [
    "When this enchantment enters, exile target nonland permanent an opponent controls until this enchantment leaves the battlefield."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'nonlandPermanent', controller: 'opponent' }],
          effects: [{ op: 'exileUntilSourceLeaves', targetSlot: 0 }],
          description: 'When ~ enters, exile target nonland permanent an opponent controls until ~ leaves the battlefield.',
        },
      ],
    },
  });
  // Champion of Lambholt
  registerOverride({
    oracleId: "c549b0fd-1e08-4873-952e-a14dc45a0fd2",
    name: "Champion of Lambholt",
    handledLines: [
    "Whenever another creature you control enters, put a +1/+1 counter on this creature.",
    "Creatures with power less than this creature's power can't block creatures you control."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, OTHER) } },
          targets: [],
          effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }],
          description: 'Whenever another creature enters under your control, put a +1/+1 counter on ~.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-champion-of-lambholt",
    name: "Champion of Lambholt",
    handledLines: [
    "Whenever another creature you control enters, put a +1/+1 counter on this creature.",
    "Creatures with power less than this creature's power can't block creatures you control."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, OTHER) } },
          targets: [],
          effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }],
          description: 'Whenever another creature enters under your control, put a +1/+1 counter on ~.',
        },
      ],
    },
  });
  // Curse of Bounty
  registerOverride({
    oracleId: "b6689782-08d8-48e1-a05d-cd040dfe85bc",
    name: "Curse of Bounty",
    handledLines: [
    "Enchant player",
    "Whenever enchanted player is attacked, untap all nonland permanents you control. Each opponent attacking that player untaps all nonland permanents they control."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enchantedPlayerAttacked', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'untapAttackingPlayerNonlandPermanents' }],
          description: 'Whenever enchanted player is attacked, untap all nonland permanents attacking player controls.',
        },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-curse-of-bounty",
    name: "Curse of Bounty",
    handledLines: [
    "Enchant player",
    "Whenever enchanted player is attacked, untap all nonland permanents you control. Each opponent attacking that player untaps all nonland permanents they control."
],
    def: {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enchantedPlayerAttacked', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'untapAttackingPlayerNonlandPermanents' }],
          description: 'Whenever enchanted player is attacked, untap all nonland permanents attacking player controls.',
        },
      ],
    },
  });
  // Path to Exile
  registerOverride({
    oracleId: "d683d985-9888-4d21-8b5f-69e69ce4a03b",
    name: "Path to Exile",
    handledLines: [
    "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'exileTargetAndControllerMaySearchBasicLandTapped', targetSlot: 0 }],
        description: 'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-path-to-exile",
    name: "Path to Exile",
    handledLines: [
    "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'exileTargetAndControllerMaySearchBasicLandTapped', targetSlot: 0 }],
        description: 'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
      },
    },
  });
  // Rootborn Defenses
  registerOverride({
    oracleId: "04046ae4-5c51-434b-930c-f3b1d348bf4b",
    name: "Rootborn Defenses",
    handledLines: [
    "Populate. Creatures you control gain indestructible until end of turn."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'populate' },
          { op: 'grantKeywordEachUntilEot', selector: allOf(ofType('Creature'), YOURS), keyword: 'indestructible' },
        ],
        description: 'Populate. Creatures you control gain indestructible until end of turn.',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-rootborn-defenses",
    name: "Rootborn Defenses",
    handledLines: [
    "Populate. Creatures you control gain indestructible until end of turn."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'populate' },
          { op: 'grantKeywordEachUntilEot', selector: allOf(ofType('Creature'), YOURS), keyword: 'indestructible' },
        ],
        description: 'Populate. Creatures you control gain indestructible until end of turn.',
      },
    },
  });
  // Aura Mutation
  registerOverride({
    oracleId: "19bb51dd-2b93-45f0-927d-bbafddadd0a3",
    name: "Aura Mutation",
    handledLines: [
    "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'enchantment' }],
        effects: [
          {
            op: 'destroyAndCreateTokensEqualToManaValue',
            target: 0,
            spec: { name: 'Saproling', typeLine: 'Creature — Saproling', types: ['Creature'], subtypes: ['Saproling'], colors: ['G'], power: 1, toughness: 1 },
          },
        ],
        description: "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value.",
      },
    },
  });
  registerOverride({
    oracleId: "oracle-aura-mutation",
    name: "Aura Mutation",
    handledLines: [
    "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'enchantment' }],
        effects: [
          {
            op: 'destroyAndCreateTokensEqualToManaValue',
            target: 0,
            spec: { name: 'Saproling', typeLine: 'Creature — Saproling', types: ['Creature'], subtypes: ['Saproling'], colors: ['G'], power: 1, toughness: 1 },
          },
        ],
        description: "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value.",
      },
    },
  });
  // Citywide Bust
  registerOverride({
    oracleId: "3ac01298-e45b-4ea0-8379-2074279716a4",
    name: "Citywide Bust",
    handledLines: [
    "Destroy all creatures with toughness 4 or greater."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), toughnessAtLeast(4)) }],
        description: 'Destroy all creatures with toughness 4 or greater.',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-citywide-bust",
    name: "Citywide Bust",
    handledLines: [
    "Destroy all creatures with toughness 4 or greater."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), toughnessAtLeast(4)) }],
        description: 'Destroy all creatures with toughness 4 or greater.',
      },
    },
  });
  // Collective Unconscious
  registerOverride({
    oracleId: "38abf769-e4ef-4b47-9c79-c8cda0b90f6c",
    name: "Collective Unconscious",
    handledLines: [
    "Draw a card for each creature you control."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'draw', count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } },
        ],
        description: 'Draw a card for each creature you control.',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-collective-unconscious",
    name: "Collective Unconscious",
    handledLines: [
    "Draw a card for each creature you control."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'draw', count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } },
        ],
        description: 'Draw a card for each creature you control.',
      },
    },
  });
  // Camaraderie
  registerOverride({
    oracleId: "9aab386c-d48c-4611-b757-aa69b26cc1b1",
    name: "Camaraderie",
    handledLines: [
    "You gain X life and draw X cards, where X is the number of creatures you control. Creatures you control get +1/+1 until end of turn."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'gainLife', amount: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } },
          { op: 'draw', count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } },
          { op: 'pumpEachUntilEot', selector: allOf(ofType('Creature'), YOURS), power: 1, toughness: 1 },
        ],
        description: 'You gain X life and draw X cards, where X is the number of creatures you control. Creatures you control get +1/+1 until end of turn.',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-camaraderie",
    name: "Camaraderie",
    handledLines: [
    "You gain X life and draw X cards, where X is the number of creatures you control. Creatures you control get +1/+1 until end of turn."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'gainLife', amount: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } },
          { op: 'draw', count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } },
          { op: 'pumpEachUntilEot', selector: allOf(ofType('Creature'), YOURS), power: 1, toughness: 1 },
        ],
        description: 'You gain X life and draw X cards, where X is the number of creatures you control. Creatures you control get +1/+1 until end of turn.',
      },
    },
  });
  // Hour of Reckoning
  registerOverride({
    oracleId: "3bc13640-03f8-4b19-b0a4-7e7cb5271c0c",
    name: "Hour of Reckoning",
    handledLines: [
    "Destroy all nontoken creatures."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(IS_TOKEN)) }],
        description: 'Convoke. Destroy all nontoken creatures.',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-hour-of-reckoning",
    name: "Hour of Reckoning",
    handledLines: [
    "Destroy all nontoken creatures."
],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(IS_TOKEN)) }],
        description: 'Convoke. Destroy all nontoken creatures.',
      },
    },
  });
}
