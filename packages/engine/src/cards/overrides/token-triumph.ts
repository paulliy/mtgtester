/**
 * Authored card overrides for token-triumph.txt.
 */

import { registerOverride } from './index';
import { allOf, IS_TOKEN, not, ofType, toughnessAtLeast, YOURS } from '../selector';

export function registerTOKEN_TRIUMPHOverrides(): void {
  registerOverride({
    oracleId: "c65ba242-3369-48a9-864f-1b1f85238f67",
    name: "Emmara, Soul of the Accord",
    handledLines: [
          "Whenever ~ becomes tapped, create a 1/1 white Soldier creature token with lifelink."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-emmara-soul-of-the-accord",
    name: "Emmara, Soul of the Accord",
    handledLines: [
          "Whenever ~ becomes tapped, create a 1/1 white Soldier creature token with lifelink."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "19bb51dd-2b93-45f0-927d-bbafddadd0a3",
    name: "Aura Mutation",
    handledLines: [
          "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'enchantment' }], effects: [{ op: 'destroyAndCreateTokensEqualToManaValue', target: 0, spec: { name: 'Saproling', typeLine: 'Creature � Saproling', types: ['Creature'], subtypes: ['Saproling'], colors: ['G'], power: 1, toughness: 1 } }], description: 'Destroy target enchantment and create Saprolings equal to its mana value' },
    },
  });
  registerOverride({
    oracleId: "oracle-aura-mutation",
    name: "Aura Mutation",
    handledLines: [
          "Destroy target enchantment. Create X 1/1 green Saproling creature tokens, where X is that enchantment's mana value."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'enchantment' }], effects: [{ op: 'destroyAndCreateTokensEqualToManaValue', target: 0, spec: { name: 'Saproling', typeLine: 'Creature � Saproling', types: ['Creature'], subtypes: ['Saproling'], colors: ['G'], power: 1, toughness: 1 } }], description: 'Destroy target enchantment and create Saprolings equal to its mana value' },
    },
  });

  registerOverride({
    oracleId: "4a2fea39-99d6-4766-9f2c-0a63925349cb",
    name: "Selesnya Evangel",
    handledLines: [
          "{1}, {T}, Tap an untapped creature you control: Create a 1/1 green Saproling creature token."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-selesnya-evangel",
    name: "Selesnya Evangel",
    handledLines: [
          "{1}, {T}, Tap an untapped creature you control: Create a 1/1 green Saproling creature token."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "123d2b6e-114e-4767-860d-50790382ca4a",
    name: "Hornet Nest",
    handledLines: [
          "Whenever this creature is dealt damage, create that many 1/1 green Insect creature tokens with flying and deathtouch."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-hornet-nest",
    name: "Hornet Nest",
    handledLines: [
          "Whenever this creature is dealt damage, create that many 1/1 green Insect creature tokens with flying and deathtouch."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1d5ff280-7f4d-4801-aefd-9b6e6b1f2818",
    name: "Ajani, Caller of the Pride",
    handledLines: [
          "+1: Put a +1/+1 counter on up to one target creature.",
          "−3: Target creature gains flying and double strike until end of turn.",
          "−8: Create X 2/2 white Cat creature tokens, where X is your life total."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ajani-caller-of-the-pride",
    name: "Ajani, Caller of the Pride",
    handledLines: [
          "+1: Put a +1/+1 counter on up to one target creature.",
          "−3: Target creature gains flying and double strike until end of turn.",
          "−8: Create X 2/2 white Cat creature tokens, where X is your life total."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c549b0fd-1e08-4873-952e-a14dc45a0fd2",
    name: "Champion of Lambholt",
    handledLines: [
          "Creatures with power less than this creature's power can't block creatures you control.",
          "Whenever another creature you control enters, put a +1/+1 counter on this creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-champion-of-lambholt",
    name: "Champion of Lambholt",
    handledLines: [
          "Creatures with power less than this creature's power can't block creatures you control.",
          "Whenever another creature you control enters, put a +1/+1 counter on this creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9a2fdc0e-e0de-47fc-95e4-04e725ddf060",
    name: "Trostani Discordant",
    handledLines: [
          "When Trostani enters, create two 1/1 white Soldier creature tokens with lifelink.",
          "At the beginning of your end step, each player gains control of all creatures they own."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-trostani-discordant",
    name: "Trostani Discordant",
    handledLines: [
          "When Trostani enters, create two 1/1 white Soldier creature tokens with lifelink.",
          "At the beginning of your end step, each player gains control of all creatures they own."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d7a38484-2acc-49a6-b32d-d54dddb14d31",
    name: "Dawn of Hope",
    handledLines: [
          "Whenever you gain life, you may pay {2}. If you do, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-dawn-of-hope",
    name: "Dawn of Hope",
    handledLines: [
          "Whenever you gain life, you may pay {2}. If you do, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1ff25f67-36a7-4cfa-a2b1-2135b5b6fb67",
    name: "Scavenging Ooze",
    handledLines: [
          "{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this creature and you gain 1 life."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-scavenging-ooze",
    name: "Scavenging Ooze",
    handledLines: [
          "{G}: Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this creature and you gain 1 life."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9aab386c-d48c-4611-b757-aa69b26cc1b1",
    name: "Camaraderie",
    handledLines: [
          "You gain X life and draw X cards, where X is the number of creatures you control. Creatures you control get +1/+1 until end of turn."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [
          { op: 'gainLife', amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } },
          { op: 'draw', count: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } },
          { op: 'pumpEachUntilEot', selector: allOf(ofType('Creature'), YOURS), power: 1, toughness: 1 },
        ], description: 'Creatures grant life, cards, and +1/+1',
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
        kind: 'spell', targets: [],
        effects: [
          { op: 'gainLife', amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } },
          { op: 'draw', count: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } },
          { op: 'pumpEachUntilEot', selector: allOf(ofType('Creature'), YOURS), power: 1, toughness: 1 },
        ], description: 'Creatures grant life, cards, and +1/+1',
      },
    },
  });

  registerOverride({
    oracleId: "3ac01298-e45b-4ea0-8379-2074279716a4",
    name: "Citywide Bust",
    handledLines: [
          "Destroy all creatures with toughness 4 or greater."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), toughnessAtLeast(4)) }], description: 'Destroy creatures with toughness four or greater' },
    },
  });
  registerOverride({
    oracleId: "oracle-citywide-bust",
    name: "Citywide Bust",
    handledLines: [
          "Destroy all creatures with toughness 4 or greater."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), toughnessAtLeast(4)) }], description: 'Destroy creatures with toughness four or greater' },
    },
  });

  registerOverride({
    oracleId: "38abf769-e4ef-4b47-9c79-c8cda0b90f6c",
    name: "Collective Unconscious",
    handledLines: [
          "Draw a card for each creature you control."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'draw', count: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } }], description: 'Draw for each creature controlled' },
    },
  });
  registerOverride({
    oracleId: "oracle-collective-unconscious",
    name: "Collective Unconscious",
    handledLines: [
          "Draw a card for each creature you control."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'draw', count: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } }], description: 'Draw for each creature controlled' },
    },
  });

  registerOverride({
    oracleId: "e938ee4c-d5df-4d93-bd61-9e518fb1dc30",
    name: "Conclave Tribunal",
    handledLines: [
          "When this enchantment enters, exile target nonland permanent an opponent controls until this enchantment leaves the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-conclave-tribunal",
    name: "Conclave Tribunal",
    handledLines: [
          "When this enchantment enters, exile target nonland permanent an opponent controls until this enchantment leaves the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "979a5d92-1c67-4fa4-b932-638b0cc1adcd",
    name: "Commander's Insignia",
    handledLines: [
          "Creatures you control get +1/+1 for each time you've cast your commander from the command zone this game."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-commander-s-insignia",
    name: "Commander's Insignia",
    handledLines: [
          "Creatures you control get +1/+1 for each time you've cast your commander from the command zone this game."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b6689782-08d8-48e1-a05d-cd040dfe85bc",
    name: "Curse of Bounty",
    handledLines: [
          "Enchant player",
          "Whenever enchanted player is attacked, untap all nonland permanents you control. Each opponent attacking that player untaps all nonland permanents they control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-curse-of-bounty",
    name: "Curse of Bounty",
    handledLines: [
          "Enchant player",
          "Whenever enchanted player is attacked, untap all nonland permanents you control. Each opponent attacking that player untaps all nonland permanents they control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d683d985-9888-4d21-8b5f-69e69ce4a03b",
    name: "Path to Exile",
    handledLines: [
          "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-path-to-exile",
    name: "Path to Exile",
    handledLines: [
          "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5334dc24-040e-4094-80f4-8d1b9de01230",
    name: "Devouring Light",
    handledLines: [
          "Exile target attacking or blocking creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-devouring-light",
    name: "Devouring Light",
    handledLines: [
          "Exile target attacking or blocking creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "30b24e8e-3b0e-4d8e-90f3-f66eb7c1858c",
    name: "Eternal Witness",
    handledLines: [
          "When this creature enters, you may return target card from your graveyard to your hand."
    ],
    def: {
      triggers: [{
        kind: 'triggered', optional: true,
        trigger: { when: 'enters', subject: { kind: 'self' } },
        targets: [{ kind: 'cardInGraveyard' }],
        effects: [{ op: 'graveyardToHand', target: 0 }],
        description: 'Enters � you may return a card from your graveyard to your hand',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-eternal-witness",
    name: "Eternal Witness",
    handledLines: [
          "When this creature enters, you may return target card from your graveyard to your hand."
    ],
    def: {
      triggers: [{
        kind: 'triggered', optional: true,
        trigger: { when: 'enters', subject: { kind: 'self' } },
        targets: [{ kind: 'cardInGraveyard' }],
        effects: [{ op: 'graveyardToHand', target: 0 }],
        description: 'Enters � you may return a card from your graveyard to your hand',
      }],
    },
  });

  registerOverride({
    oracleId: "16629f59-bae8-4c19-bf50-443eb0ed6856",
    name: "Felidar Retreat",
    handledLines: [
          "Whenever a land you control enters, choose one —",
          "• Create a 2/2 white Cat Beast creature token.",
          "• Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-felidar-retreat",
    name: "Felidar Retreat",
    handledLines: [
          "Whenever a land you control enters, choose one —",
          "• Create a 2/2 white Cat Beast creature token.",
          "• Put a +1/+1 counter on each creature you control. Those creatures gain vigilance until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "56f1a16a-9f41-41fb-b580-c200bca27cd6",
    name: "Fortified Village",
    handledLines: [
          "As this land enters, you may reveal a Forest or Plains card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-fortified-village",
    name: "Fortified Village",
    handledLines: [
          "As this land enters, you may reveal a Forest or Plains card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5dba7746-c087-4ec1-92ca-ab9882dea24d",
    name: "Great Oak Guardian",
    handledLines: [
          "When this creature enters, creatures target player controls get +2/+2 until end of turn. Untap them."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-great-oak-guardian",
    name: "Great Oak Guardian",
    handledLines: [
          "When this creature enters, creatures target player controls get +2/+2 until end of turn. Untap them."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ec6d52f9-1c8f-48da-951c-be8d7813c7be",
    name: "Harvest Season",
    handledLines: [
          "Search your library for up to X basic land cards, where X is the number of tapped creatures you control, put those cards onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-harvest-season",
    name: "Harvest Season",
    handledLines: [
          "Search your library for up to X basic land cards, where X is the number of tapped creatures you control, put those cards onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e6b77545-de5c-4f4a-b7ea-83498fb33ba8",
    name: "Holdout Settlement",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-holdout-settlement",
    name: "Holdout Settlement",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3bc13640-03f8-4b19-b0a4-7e7cb5271c0c",
    name: "Hour of Reckoning",
    handledLines: [
          "Destroy all nontoken creatures."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(IS_TOKEN)) }],
        description: 'Destroy all nontoken creatures',
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
        kind: 'spell', targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(IS_TOKEN)) }],
        description: 'Destroy all nontoken creatures',
      },
    },
  });

  registerOverride({
    oracleId: "c232d974-9c65-4bce-b045-e5a7cc0c62e0",
    name: "Idol of Oblivion",
    handledLines: [
          "{T}: Draw a card. Activate only if you created a token this turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-idol-of-oblivion",
    name: "Idol of Oblivion",
    handledLines: [
          "{T}: Draw a card. Activate only if you created a token this turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e2f98813-4f39-4135-b05b-407e9eb797f6",
    name: "Jaspera Sentinel",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-jaspera-sentinel",
    name: "Jaspera Sentinel",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "fc3e48c9-e303-435c-bdb1-7dc7881a9858",
    name: "Karametra's Favor",
    handledLines: [
          "When this Aura enters, draw a card.",
          "Enchanted creature has \"{T}: Add one mana of any color.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-karametra-s-favor",
    name: "Karametra's Favor",
    handledLines: [
          "When this Aura enters, draw a card.",
          "Enchanted creature has \"{T}: Add one mana of any color.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "55eb9310-f24b-410b-850b-a7d0d5117946",
    name: "Leafkin Druid",
    handledLines: [
          "{T}: Add {G}. If you control four or more creatures, add {G}{G} instead."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-leafkin-druid",
    name: "Leafkin Druid",
    handledLines: [
          "{T}: Add {G}. If you control four or more creatures, add {G}{G} instead."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "de1cfa83-2049-48ab-b093-2f120a3ef4f2",
    name: "Loyal Guardian",
    handledLines: [
          "At the beginning of combat on your turn, if you control your commander, put a +1/+1 counter on each creature you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-loyal-guardian",
    name: "Loyal Guardian",
    handledLines: [
          "At the beginning of combat on your turn, if you control your commander, put a +1/+1 counter on each creature you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b9f4f96b-6e54-4fe6-8df7-623e0fc72409",
    name: "Mentor of the Meek",
    handledLines: [
          "Whenever another creature you control with power 2 or less enters, you may pay {1}. If you do, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-mentor-of-the-meek",
    name: "Mentor of the Meek",
    handledLines: [
          "Whenever another creature you control with power 2 or less enters, you may pay {1}. If you do, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "4dcfd397-9d29-420c-8fd8-c7c2a99de122",
    name: "Nullmage Shepherd",
    handledLines: [
          "Tap four untapped creatures you control: Destroy target artifact or enchantment."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-nullmage-shepherd",
    name: "Nullmage Shepherd",
    handledLines: [
          "Tap four untapped creatures you control: Destroy target artifact or enchantment."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9ba89c25-5302-414f-a2ec-436b8981999d",
    name: "Overwhelming Instinct",
    handledLines: [
          "Whenever you attack with three or more creatures, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-overwhelming-instinct",
    name: "Overwhelming Instinct",
    handledLines: [
          "Whenever you attack with three or more creatures, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "04046ae4-5c51-434b-930c-f3b1d348bf4b",
    name: "Rootborn Defenses",
    handledLines: [
          "Populate. Creatures you control gain indestructible until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-rootborn-defenses",
    name: "Rootborn Defenses",
    handledLines: [
          "Populate. Creatures you control gain indestructible until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "761021ce-4559-464e-aa03-85c2fe78e267",
    name: "Rishkar, Peema Renegade",
    handledLines: [
          "When ~ enters, put a +1/+1 counter on each of up to two target creatures.",
          "Each creature you control with a counter on it has \"{T}: Add {G}.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-rishkar-peema-renegade",
    name: "Rishkar, Peema Renegade",
    handledLines: [
          "When ~ enters, put a +1/+1 counter on each of up to two target creatures.",
          "Each creature you control with a counter on it has \"{T}: Add {G}.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "a07483b4-c04f-42a4-b979-8b77c11fa8f5",
    name: "Slate of Ancestry",
    handledLines: [
          "{4}, {T}, Discard your hand: Draw a card for each creature you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-slate-of-ancestry",
    name: "Slate of Ancestry",
    handledLines: [
          "{4}, {T}, Discard your hand: Draw a card for each creature you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "aeec8e85-6571-4da6-8a48-f5d3985ca10b",
    name: "Sylvan Reclamation",
    handledLines: [
          "Exile up to two target artifacts and/or enchantments.",
          "Basic landcycling {2}"
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sylvan-reclamation",
    name: "Sylvan Reclamation",
    handledLines: [
          "Exile up to two target artifacts and/or enchantments.",
          "Basic landcycling {2}"
    ],
    def: {},
  });

  registerOverride({
    oracleId: "f55334d9-1ec2-4667-bf28-5a0384d6f053",
    name: "Thunderfoot Baloth",
    handledLines: [
          "As long as you control your commander, this creature gets +2/+2 and other creatures you control get +2/+2 and have trample."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-thunderfoot-baloth",
    name: "Thunderfoot Baloth",
    handledLines: [
          "As long as you control your commander, this creature gets +2/+2 and other creatures you control get +2/+2 and have trample."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9b40faad-1b96-4461-89d8-9a207b58e832",
    name: "Voice of Many",
    handledLines: [
          "When this creature enters, draw a card for each opponent who controls fewer creatures than you."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-voice-of-many",
    name: "Voice of Many",
    handledLines: [
          "When this creature enters, draw a card for each opponent who controls fewer creatures than you."
    ],
    def: {},
  });

}
