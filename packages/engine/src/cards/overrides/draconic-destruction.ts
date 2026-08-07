/**
 * Authored card overrides for draconic-destruction.txt.
 */

import { constant } from '../value';
import { EXILE_SELF_FROM_GRAVEYARD, mana, manaCost } from '../templates';
import { BEAST_3_3_GREEN, DRAGON_5_5_FLYING } from '../tokens';
import { defineCard } from './index';
import { allOf, anyOf, not, OTHER, ofSubtype, ofType, SELF, withKeyword, YOURS } from '../selector';

const DRAGONKIN_BERSERKER_DEF = {
  ruleStatics: [{
    kind: 'costReduction' as const,
    appliesTo: 'activate' as const,
    amount: { kind: 'countPermanents' as const, selector: ofSubtype('Dragon'), scope: 'you' as const },
    filter: SELF,
  }],
  activatedAbilities: [{
    // The generic interpreter already parses this line's token-creation on its own; carried
    // over unchanged here so replacing `activatedAbilities` for the Boast restriction below
    // does not silently drop it.
    costs: [mana('{4}{R}')],
    timing: 'any' as const,
    requiresAttackedThisTurn: true as const,
    oncePerTurn: true,
    ability: {
      kind: 'activated' as const,
      targets: [],
      effects: [{
        op: 'createToken' as const,
        count: constant(1),
        spec: DRAGON_5_5_FLYING,
      }],
      description: 'Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying',
    },
  }],
};

const HOARD_SMELTER_DRAGON_DEF = {
  activatedAbilities: [{
    costs: [mana('{3}{R}')],
    timing: 'any' as const,
    ability: {
      kind: 'activated' as const,
      targets: [{ kind: 'artifact' as const }],
      // Pump BEFORE destroy: the mana-value read has to happen while the artifact is still
      // on the battlefield, or `manaValueOfTarget` has nothing left to look up.
      effects: [
        { op: 'pumpUntilEot' as const, target: 'source' as const, power: { kind: 'manaValueOfTarget' as const, target: 0 }, toughness: 0 },
        { op: 'destroy' as const, target: 0 },
      ],
      description: "Destroy target artifact; ~ gets +X/+0 until end of turn, X is that artifact's mana value",
    },
  }],
};

const LOAMING_SHAMAN_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'enters' as const, subject: { kind: 'self' as const } },
    targets: [
      { kind: 'player' as const },
      { kind: 'cardInGraveyard' as const, graveyardOwnerSlot: 0, count: { min: 0, max: Infinity } },
    ],
    effects: [{ op: 'shuffleChosenGraveyardCardsIntoLibrary' as const, playerSlot: 0, cardsSlot: 1 }],
    description: 'Enters — target player shuffles any number of target cards from their graveyard into their library',
  }],
};

const PRIMAL_MIGHT_DEF = {
  spellAbility: {
    kind: 'spell' as const,
    targets: [
      { kind: 'creature' as const, controller: 'you' as const },
      { kind: 'creature' as const, controller: 'opponent' as const, count: { min: 0, max: 1 } },
    ],
    effects: [
      { op: 'pumpUntilEot' as const, target: 0, power: { kind: 'xValue' as const }, toughness: { kind: 'xValue' as const } },
      { op: 'fightUpToOneChosen' as const, a: 0, bSlot: 1 },
    ],
    description: "Target creature you control gets +X/+X until end of turn, then fights up to one target creature you don't control",
  },
};

const RUNEHORN_HELLKITE_DEF = {
  activatedAbilities: [{
    costs: [
      mana('{5}{R}'),
      EXILE_SELF_FROM_GRAVEYARD,
    ],
    timing: 'any' as const,
    zone: 'graveyard' as const,
    ability: {
      kind: 'activated' as const,
      targets: [],
      effects: [{ op: 'eachPlayerDiscardHandThenDraw' as const, count: constant(7) }],
      description: 'Exile this card from your graveyard — each player discards their hand, then draws seven cards',
    },
  }],
};

const DRAGON_MAGE_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'dealsCombatDamageToPlayer' as const, subject: { kind: 'self' as const } },
    targets: [],
    effects: [{ op: 'eachPlayerDiscardHandThenDraw' as const, count: constant(7) }],
    description: 'Combat damage to a player — each player discards their hand, then draws seven cards',
  }],
};

const DREAM_PILLAGER_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'dealsCombatDamageToPlayer' as const, subject: { kind: 'self' as const } },
    targets: [],
    effects: [{ op: 'exileTopNPlayableUntilEot' as const, count: { kind: 'damageDealt' as const } }],
    description: 'Combat damage to a player — exile that many cards from the top of your library; you may cast them until end of turn',
  }],
};

const FOE_RAZER_REGENT_DEF = {
  triggers: [
    {
      kind: 'triggered' as const,
      trigger: { when: 'enters' as const, subject: { kind: 'self' as const } },
      optional: true,
      targets: [{ kind: 'creature' as const, controller: 'opponent' as const }],
      effects: [{ op: 'fight' as const, first: 'source' as const, second: 0 }],
      description: "Enters — you may have it fight target creature you don't control",
    },
    {
      kind: 'triggered' as const,
      trigger: { when: 'fights' as const, subject: { kind: 'permanent' as const, selector: allOf(ofType('Creature'), YOURS) } },
      targets: [],
      effects: [{
        op: 'registerDelayedTrigger' as const,
        when: 'endStep' as const,
        expiry: 'endStep' as const,
        target: 'triggerObject' as const,
        ability: {
          kind: 'triggered' as const,
          targets: [],
          effects: [{ op: 'putCounters' as const, target: 'triggerObject' as const, counter: '+1/+1', count: 2 }],
          description: 'Put two +1/+1 counters on it',
        },
      }],
      description: 'A creature you control fights — put two +1/+1 counters on it at the beginning of the next end step',
    },
  ],
};

const FLAMEBLAST_DRAGON_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'attacks' as const, subject: { kind: 'self' as const } },
    targets: [{ kind: 'anyTarget' as const }],
    effects: [{ op: 'mayPayXThenDealDamage' as const, target: 0, templatedCost: manaCost('{X}{R}') }],
    description: 'Attacks — you may pay {X}{R}; if you do, it deals X damage to any target',
  }],
};

const SARKHAN_THE_DRAGONSPEAKER_DEF = {
  activatedAbilities: [
    {
      costs: [{ kind: 'loyalty' as const, delta: 1 }],
      timing: 'sorcery' as const,
      ability: {
        kind: 'activated' as const,
        targets: [],
        effects: [{
          op: 'becomeCreatureUntilEot' as const, target: 'source' as const,
          subtypes: ['Dragon'], power: 4, toughness: 4, keywords: ['flying' as const, 'indestructible' as const, 'haste' as const],
          replaceTypes: ['Creature'],
        }],
        description: 'Until end of turn, ~ becomes a legendary 4/4 red Dragon creature with flying, indestructible, and haste',
      },
    },
    {
      // Oracle text no longer includes "That creature deals 4 damage to him" — Wizards errata'd
      // that clause away. The generic interpreter's loyalty-cost parsing still doesn't recognize
      // this line, so it stays authored here rather than left unmodeled.
      costs: [{ kind: 'loyalty' as const, delta: -3 }],
      timing: 'sorcery' as const,
      ability: {
        kind: 'activated' as const,
        targets: [{ kind: 'creature' as const }],
        effects: [
          { op: 'dealDamage' as const, target: 0, amount: constant(4) },
        ],
        description: '~ deals 4 damage to target creature',
      },
    },
    {
      costs: [{ kind: 'loyalty' as const, delta: -6 }],
      timing: 'sorcery' as const,
      ability: {
        kind: 'activated' as const,
        targets: [],
        effects: [{
          op: 'createEmblem' as const,
          name: 'Sarkhan Emblem',
          abilities: [
            {
              kind: 'triggered' as const,
              trigger: { when: 'drawStep' as const, player: 'you' as const },
              targets: [],
              effects: [{ op: 'draw' as const, count: constant(2) }],
              description: 'At the beginning of your draw step, draw two additional cards',
            },
            {
              kind: 'triggered' as const,
              trigger: { when: 'endStep' as const, player: 'you' as const },
              targets: [],
              effects: [{ op: 'discardHand' as const }],
              description: 'At the beginning of your end step, discard your hand',
            },
          ],
        }],
        description: 'You get an emblem with "At the beginning of your draw step, draw two additional cards" and "At the beginning of your end step, discard your hand"',
      },
    },
  ],
};

const SPIT_FLAME_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'enters' as const, subject: { kind: 'permanent' as const, selector: allOf(ofSubtype('Dragon'), YOURS) } },
    functionsInGraveyard: true as const,
    targets: [],
    effects: [{
      op: 'conditionalEffect' as const,
      condition: { kind: 'mayPayMana' as const, cost: manaCost('{R}') },
      then: [{ op: 'returnSelfFromGraveyardToHand' as const }],
      else: [],
    }],
    description: 'A Dragon you control enters — you may pay {R}; if you do, return this card from your graveyard to your hand',
  }],
};

const THUNDERBREAK_REGENT_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'becomesTargeted' as const, subject: { kind: 'permanent' as const, selector: allOf(ofSubtype('Dragon'), YOURS) } },
    targets: [],
    effects: [{ op: 'dealDamage' as const, target: 'eventPlayer' as const, amount: constant(3) }],
    description: 'A Dragon you control becomes the target of a spell or ability an opponent controls — deal 3 damage to that player',
  }],
};

const CLAN_DEFIANCE_DEF = {
  spellAbility: {
    kind: 'spell' as const,
    targets: [
      { kind: 'creature' as const, filter: withKeyword('flying') },
      { kind: 'creature' as const, filter: not(withKeyword('flying')) },
      { kind: 'playerOrPlaneswalker' as const },
    ],
    effects: [],
    modes: {
      minChoices: 1,
      maxChoices: 3,
      options: [
        { effects: [{ op: 'dealDamage' as const, target: 0, amount: { kind: 'xValue' as const } }], description: '~ deals X damage to target creature with flying', targetSlots: [0] },
        { effects: [{ op: 'dealDamage' as const, target: 1, amount: { kind: 'xValue' as const } }], description: '~ deals X damage to target creature without flying', targetSlots: [1] },
        { effects: [{ op: 'dealDamage' as const, target: 2, amount: { kind: 'xValue' as const } }], description: '~ deals X damage to target player or planeswalker', targetSlots: [2] },
      ],
    },
    description: 'Choose one or more — deal X damage to a flying creature, a nonflying creature, and/or a player or planeswalker',
  },
};

const STEEL_HELLKITE_DEF = {
  activatedAbilities: [
    {
      // Also already generically parsed; carried over unchanged for the same reason as above.
      costs: [mana('{2}')],
      timing: 'any' as const,
      ability: {
        kind: 'activated' as const,
        targets: [],
        effects: [{ op: 'pumpEachUntilEot' as const, selector: SELF, power: 1, toughness: 0 }],
        description: '{2}: ~ gets +1/+0 until end of turn.',
      },
    },
    {
      costs: [mana('{X}')],
      timing: 'any' as const,
      oncePerTurn: true,
      ability: {
        kind: 'activated' as const,
        targets: [],
        effects: [{ op: 'destroyEachNonlandMVFromDamagedControllers' as const, mv: { kind: 'xValue' as const } }],
        description: 'Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn',
      },
    },
  ],
};

const FRONTIER_SIEGE_DEF = {
  entersChoosingOption: {
    prompt: 'Choose Khans or Dragons',
    options: [
      { key: 'Khans', label: 'Khans — add {G}{G} at each main phase' },
      { key: 'Dragons', label: 'Dragons — flying creatures you control may fight when they enter' },
    ],
  },
  triggers: [
    {
      kind: 'triggered' as const,
      trigger: {
        when: 'mainPhase' as const,
        player: 'you' as const,
        condition: { kind: 'chosenOptionIs' as const, value: 'Khans' },
      },
      targets: [],
      effects: [{ op: 'addMana' as const, amount: constant(2), colors: ['G' as const], fixedSymbols: ['G' as const, 'G' as const] }],
      description: 'Khans — beginning of each main phase, add {G}{G}',
    },
    {
      kind: 'triggered' as const,
      trigger: {
        when: 'enters' as const,
        subject: { kind: 'permanent' as const, selector: allOf(ofType('Creature'), withKeyword('flying'), YOURS) },
        condition: { kind: 'chosenOptionIs' as const, value: 'Dragons' },
      },
      optional: true,
      targets: [{ kind: 'creature' as const, controller: 'opponent' as const }],
      effects: [{ op: 'fight' as const, first: 'triggerObject' as const, second: 0 }],
      description: "Dragons — flying creature enters, may have it fight target creature you don't control",
    },
  ],
};

const TYRANTS_FAMILIAR_DEF = {
  staticEffects: [
    {
      affects: SELF,
      op: { layer: 7 as const, sublayer: 'd' as const, power: 2, toughness: 2 },
      condition: { kind: 'controlsYourCommander' as const },
    },
    {
      affects: SELF,
      op: {
        layer: 6 as const,
        addTrigger: {
          kind: 'triggered' as const,
          trigger: { when: 'attacks' as const, subject: { kind: 'self' as const } },
          targets: [{ kind: 'creature' as const, controller: 'eventPlayer' as const }],
          effects: [{ op: 'dealDamage' as const, target: 0, amount: constant(7) }],
          description: 'Attacks — deal 7 damage to target creature defending player controls',
        },
      },
      condition: { kind: 'controlsYourCommander' as const },
    },
  ],
};

const HUNTERS_PROWESS_DEF = {
  spellAbility: {
    kind: 'spell' as const,
    targets: [{ kind: 'creature' as const }],
    effects: [
      { op: 'pumpUntilEot' as const, target: 0, power: 3, toughness: 3 },
      { op: 'grantKeywordUntilEot' as const, target: 0, keyword: 'trample' as const },
      {
        op: 'grantAbilityUntilEot' as const,
        target: 0,
        ability: {
          kind: 'triggered' as const,
          trigger: { when: 'dealsCombatDamageToPlayer' as const, subject: { kind: 'self' as const } },
          targets: [],
          effects: [{ op: 'draw' as const, count: { kind: 'damageDealt' as const } }],
          description: 'Deals combat damage to a player — draw that many cards',
        },
      },
    ],
    description: 'Target creature gets +3/+3, trample, and draws on combat damage until end of turn',
  },
};

const PROVOKE_THE_TROLLS_DEF = {
  spellAbility: {
    kind: 'spell' as const,
    targets: [{ kind: 'anyTarget' as const }],
    effects: [
      { op: 'dealDamage' as const, target: 0, amount: constant(3) },
      {
        op: 'conditionalEffect' as const,
        checkTarget: 0,
        condition: { kind: 'triggerObjectMatches' as const, selector: ofType('Creature') },
        then: [{ op: 'pumpUntilEot' as const, target: 0, power: 5, toughness: 0 }],
        else: [],
      },
    ],
    description: 'Deal 3 damage to any target; if a creature was dealt damage this way, it gets +5/+0 until end of turn',
  },
};

const DEMANDING_DRAGON_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'enters' as const, subject: { kind: 'self' as const } },
    targets: [{ kind: 'player' as const, controller: 'opponent' as const }],
    effects: [{ op: 'dealDamageUnlessSacrifice' as const, target: 0, amount: constant(5) }],
    description: "Enters — deal 5 damage to target opponent unless they sacrifice a creature",
  }],
};

export function registerDRACONIC_DESTRUCTIONOverrides(): void {
  // The line now parses generically (`parseDestroyAndCreateTokenBlock` in interpret.ts), so
  // there's no unmodeled reason left to claim — handledLines is empty. `def` stays: the parser's
  // own token derivation prints `typeLine: "Token Creature — Beast"`, one word off the shared
  // catalog's `"Creature — Beast"` (`tokens.ts`'s `creatureToken`), so this override's remaining
  // job is keeping this card on the catalog token rather than the parser's near-miss.
  defineCard("7735eeba-693b-47e2-bd51-414379cf1016", "Beast Within", [], {
      spellAbility: { kind: 'spell', targets: [{ kind: 'permanent' }], effects: [{ op: 'destroyAndCreateTokenForController', target: 0, count: constant(1), spec: BEAST_3_3_GREEN }], description: 'Destroy target permanent; its controller creates a 3/3 Beast' },
    });

  defineCard("06b77a80-4968-4385-960a-fb66bb4faa94", "Dragonkin Berserker", [
          "Boast abilities you activate cost {1} less to activate for each Dragon you control.",
          // Registering ANY non-empty override for this oracleId disables the interpreter's
          // generic ability-word label stripping for its remaining lines (`interpret.ts`'s
          // `genericLabelStripAllowed`) — so the "Boast — " prefix here, previously stripped
          // and generically parsed, now needs its own claim too.
          "Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying."
    ], DRAGONKIN_BERSERKER_DEF);

  defineCard("b6fb79c3-cd32-4045-8177-e52841eea65b", "Dragonmaster Outcast", [
          "At the beginning of your upkeep, if you control six or more lands, create a 5/5 red Dragon creature token with flying."
    ], {
      triggers: [{
        kind: 'triggered',
        trigger: {
          when: 'upkeep',
          player: 'you',
          condition: { kind: 'countPermanents', selector: ofType('Land'), scope: 'you', cmp: '>=', n: 6 },
        },
        targets: [],
        effects: [{
          op: 'createToken',
          count: constant(1),
          spec: DRAGON_5_5_FLYING,
        }],
        description: 'Upkeep with six lands — create a Dragon token',
      }],
    });

  defineCard("d1d171de-1c6d-4fb9-817a-9c689c709f3d", "Shamanic Revelation", [
          "Draw a card for each creature you control.",
          "You gain 4 life for each creature you control with power 4 or greater."
    ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'draw', count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } }, { op: 'gainLife', amount: { kind: 'times', of: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS, { kind: 'powerAtLeast', n: 4 }), scope: 'you' }, n: 4 } }], description: 'Draw for creatures; gain four life per creature with power four or greater' } });

  defineCard("05b6f9e3-9acd-43a6-acff-caa811aaf0a1", "Akoum Hellkite", [
          "Whenever a land you control enters, this creature deals 1 damage to any target. If that land is a Mountain, this creature deals 2 damage instead."
    ], {
      triggers: [{
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) } },
        targets: [{ kind: 'anyTarget' }],
        effects: [{
          op: 'conditionalEffect',
          condition: { kind: 'triggerObjectMatches', selector: ofSubtype('Mountain') },
          then: [{ op: 'dealDamage', target: 0, amount: constant(2) }],
          else: [{ op: 'dealDamage', target: 0, amount: constant(1) }],
        }],
        description: 'Land enters — deal 1 damage to any target, or 2 if it was a Mountain',
      }],
    });

  defineCard("eb287c04-97f5-4e47-beb1-66cc7d15e748", "Atarka Monument", [
          "{4}{R}{G}: ~ becomes a 4/4 red and green Dragon artifact creature with flying until end of turn."
    ], {
      activatedAbilities: [{
        costs: [mana('{4}{R}{G}')],
        timing: 'any',
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{
            op: 'becomeCreatureUntilEot', target: 'source',
            subtypes: ['Dragon'], power: 4, toughness: 4, keywords: ['flying'],
          }],
          description: '~ becomes a 4/4 red and green Dragon artifact creature with flying until end of turn',
        },
      }],
    });

  defineCard("5a851367-1c4a-4cc9-a9c3-3d2775986b4c", "Blossoming Defense", [
          "Target creature you control gets +2/+2 and gains hexproof until end of turn."
    ], {
      spellAbility: { kind: 'spell', targets: [{ kind: 'creature', controller: 'you' }], effects: [{ op: 'pumpUntilEot', target: 0, power: 2, toughness: 2 }, { op: 'grantKeywordUntilEot', target: 0, keyword: 'hexproof' }], description: 'Target creature gets +2/+2 and hexproof until end of turn' },
    });

  defineCard("086b2564-9114-4ba2-94fd-b490f98f38a7", "Chain Reaction", [
          "~ deals X damage to each creature, where X is the number of creatures on the battlefield."
    ], {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'damageEach', selector: ofType('Creature'), amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'all' } }],
        description: 'Deal damage to each creature equal to creatures on the battlefield',
      },
    });

  defineCard("abcf5e77-88fc-4b76-a1e8-907a5b27d612", "Clan Defiance", [
          "Choose one or more —",
          "• ~ deals X damage to target creature with flying.",
          "• ~ deals X damage to target creature without flying.",
          "• ~ deals X damage to target player or planeswalker."
    ], CLAN_DEFIANCE_DEF);

  defineCard("c8f1e3bd-bbf0-4750-b054-03553fc61850", "Demanding Dragon", [
          "When this creature enters, it deals 5 damage to target opponent unless that player sacrifices a creature of their choice."
    ], DEMANDING_DRAGON_DEF);

  defineCard("faf81ae0-0b35-45ef-a50d-6cecf0c0eeeb", "Dragonlord's Servant", [
          "Dragon spells you cast cost {1} less to cast."
    ], {
      ruleStatics: [{ kind: 'costReduction', amount: constant(1), filter: ofSubtype('Dragon') }],
    });

  defineCard("777b8ec4-a783-4297-96b7-4f200d0eb734", "Return to Nature", [
          "Choose one —",
          "• Destroy target artifact.",
          "• Destroy target enchantment.",
          "• Exile target card from a graveyard."
    ], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'artifact' }, { kind: 'enchantment' }, { kind: 'cardInGraveyard' }],
        effects: [],
        modes: {
          minChoices: 1,
          maxChoices: 1,
          options: [
            { effects: [{ op: 'destroy', target: 0 }], description: 'Destroy target artifact' },
            { effects: [{ op: 'destroy', target: 1 }], description: 'Destroy target enchantment' },
            { effects: [{ op: 'exile', target: 2 }], description: 'Exile target card from a graveyard' },
          ],
        },
        description: 'Choose one targeted removal effect',
      },
    });

  defineCard("6a29f36b-7911-4d84-a3ae-546b131d5159", "Dragonspeaker Shaman", [
          "Dragon spells you cast cost {2} less to cast."
    ], {
      ruleStatics: [{ kind: 'costReduction', amount: constant(2), filter: ofSubtype('Dragon') }],
    });

  defineCard("eab71e4e-27c3-4c41-b95f-259c1d14b97a", "Dragon Mage", [
          "Whenever this creature deals combat damage to a player, each player discards their hand, then draws seven cards."
    ], DRAGON_MAGE_DEF);

  defineCard("504cc26d-3fd5-4391-9d30-f0614e5c8bbc", "Dream Pillager", [
          "Whenever this creature deals combat damage to a player, exile that many cards from the top of your library. Until end of turn, you may cast spells from among those exiled cards."
    ], DREAM_PILLAGER_DEF);

  defineCard("e7dd3e2c-34a5-4097-b6d1-2ccd097fe57f", "Foe-Razer Regent", [
          "When this creature enters, you may have it fight target creature you don't control.",
          "Whenever a creature you control fights, put two +1/+1 counters on it at the beginning of the next end step."
    ], FOE_RAZER_REGENT_DEF);

  defineCard("3180ee4f-66d7-4b73-bc10-9ee0c790ec18", "Flameblast Dragon", [
          "Whenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target."
    ], FLAMEBLAST_DRAGON_DEF);

  defineCard("00de57d2-7cb6-4337-9bc6-f6711e4dfabf", "Game Trail", [
          "As this land enters, you may reveal a Mountain or Forest card from your hand. If you don't, this land enters tapped."
    ], { entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Mountain', 'Forest'] } });

  defineCard("4cfaa5cf-cc3d-49a7-9544-38a8bb7e9ec1", "Frontier Siege", [
          "As this enchantment enters, choose Khans or Dragons.",
          "• Khans — At the beginning of each of your main phases, add {G}{G}.",
          "• Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don't control."
    ], FRONTIER_SIEGE_DEF);

  defineCard("3256029f-6558-4fcc-9fa1-74ceba3e5c92", "Harbinger of the Hunt", [
          "{2}{G}: ~ deals 1 damage to each other creature with flying."
    ], { activatedAbilities: [{ costs: [mana('{2}{G}')], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'damageEach', selector: allOf(OTHER, ofType('Creature'), withKeyword('flying')), amount: constant(1) }], description: 'Deal one damage to each other flying creature' } }] });

  defineCard("cf9db2be-3c95-45a2-ab85-694e3bd3bf1d", "Hoard-Smelter Dragon", [
          "{3}{R}: Destroy target artifact. ~ gets +X/+0 until end of turn, where X is that artifact's mana value."
    ], HOARD_SMELTER_DRAGON_DEF);

  defineCard("e1a776d2-fb3a-4215-a14e-4b6e9bda95df", "Hunter's Prowess", [
          "Until end of turn, target creature gets +3/+3 and gains trample and \"Whenever this creature deals combat damage to a player, draw that many cards.\""
    ], HUNTERS_PROWESS_DEF);

  defineCard("cf7352bf-3971-4bb7-88b9-65ab9a219289", "Loaming Shaman", [
          "When this creature enters, target player shuffles any number of target cards from their graveyard into their library."
    ], LOAMING_SHAMAN_DEF);

  defineCard("a52037df-0be1-4c99-b9eb-b033157af203", "Magmaquake", [
          "~ deals X damage to each creature without flying and each planeswalker."
    ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'damageEach', selector: anyOf(allOf(ofType('Creature'), not(withKeyword('flying'))), ofType('Planeswalker')), amount: { kind: 'xValue' } }], description: 'Deal X damage to each nonflying creature and planeswalker' } });

  defineCard("c02ed1b7-1f8d-4196-a9b6-65e1b5a763d7", "Mordant Dragon", [
          "Whenever this creature deals combat damage to a player, you may have it deal that much damage to target creature that player controls."
    ], { triggers: [{ kind: 'triggered', trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } }, targets: [{ kind: 'creature', controller: 'eventPlayer' }], effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'damageDealt' } }], description: 'Combat damage to player — may deal that much to one of their creatures' }] });

  defineCard("58d7b8b3-ac47-4805-8259-4ba8e70d7dc3", "Primal Might", [
          "Target creature you control gets +X/+X until end of turn. Then it fights up to one target creature you don't control."
    ], PRIMAL_MIGHT_DEF);

  defineCard("ac844303-487b-49e9-9170-02892153ca6a", "Provoke the Trolls", [
          "~ deals 3 damage to any target. If a creature is dealt damage this way, it gets +5/+0 until end of turn."
    ], PROVOKE_THE_TROLLS_DEF);

  defineCard("a3f2c946-409f-4093-b4db-c954d3480a72", "Runehorn Hellkite", [
          "{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards."
    ], RUNEHORN_HELLKITE_DEF);

  defineCard("f743d85f-754e-4e70-9907-af54acb9e8d4", "Savage Ventmaw", [
          "Whenever this creature attacks, add {R}{R}{R}{G}{G}{G}. Until end of turn, you don't lose this mana as steps and phases end."
    ], {
      triggers: [{
        kind: 'triggered',
        trigger: { when: 'attacks', subject: { kind: 'self' } },
        targets: [],
        effects: [{ op: 'addMana', amount: constant(6), colors: ['R', 'G'], fixedSymbols: ['R', 'R', 'R', 'G', 'G', 'G'], persistent: true }],
        description: 'Attack — add {R}{R}{R}{G}{G}{G} until end of turn',
      }],
    });

  defineCard("80c26f58-04b0-4db0-b84e-9b136609abe0", "Sarkhan, the Dragonspeaker", [
          "+1: Until end of turn, ~ becomes a legendary 4/4 red Dragon creature with flying, indestructible, and haste.",
          // The −3 line ("~ deals 4 damage to target creature.") is no longer claimed here: since
          // Wizards errata'd away its "that creature deals 4 damage to him" clause, the generic
          // interpreter's own damage-effect grammar parses it unaided, so it never appears in
          // unmodeledReasons for this override to consume. The custom loyalty ability below still
          // implements it (this override's `def` fully replaces `activatedAbilities`) — it's just
          // no longer the thing filling an interpreter gap.
          "−6: You get an emblem with \"At the beginning of your draw step, draw two additional cards\" and \"At the beginning of your end step, discard your hand.\""
    ], SARKHAN_THE_DRAGONSPEAKER_DEF);

  defineCard("0a147009-a57c-4ac1-ab81-d8bd8b737631", "Scourge of Valkas", [
          "Whenever this creature or another Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control."
    ], {
      triggers: [{
        kind: 'triggered',
        trigger: {
          when: 'enters',
          subject: { kind: 'permanent', selector: allOf(ofSubtype('Dragon'), YOURS) },
        },
        targets: [{ kind: 'anyTarget' }],
        effects: [{
          op: 'dealDamage', target: 0,
          amount: { kind: 'countPermanents', selector: ofSubtype('Dragon'), scope: 'you' },
        }],
        description: 'Dragon enters — deal damage equal to Dragons controlled',
      }],
    });

  defineCard("f63278e0-3c67-421d-87ce-67725e5e74df", "Spit Flame", [
          "Whenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand."
    ], SPIT_FLAME_DEF);

  defineCard("6e64f1e0-ddd6-4ee7-8797-086e234b02e8", "Steel Hellkite", [
          "{X}: Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn. Activate only once each turn."
    ], STEEL_HELLKITE_DEF);

  defineCard("bb04f927-0348-4a14-9e74-381f18083f6a", "Thunderbreak Regent", [
          "Whenever a Dragon you control becomes the target of a spell or ability an opponent controls, this creature deals 3 damage to that player."
    ], THUNDERBREAK_REGENT_DEF);

  defineCard("e958144e-01bc-46ff-8f56-ddf2eb098630", "Thundermaw Hellkite", [
          "When this creature enters, it deals 1 damage to each creature with flying your opponents control. Tap those creatures."
    ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'damageEach', selector: allOf(ofType('Creature'), withKeyword('flying'), { kind: 'controller', who: 'opponents' }), amount: constant(1) }, { op: 'tapEach', selector: allOf(ofType('Creature'), withKeyword('flying'), { kind: 'controller', who: 'opponents' }) }], description: 'Enters — deal one damage to and tap opposing fliers' }] });

  defineCard("63394e24-a456-4cc6-9885-8c62447b050a", "Tyrant's Familiar", [
          "As long as you control your commander, this creature gets +2/+2 and has \"Whenever this creature attacks, it deals 7 damage to target creature defending player controls.\""
    ], TYRANTS_FAMILIAR_DEF);

  defineCard("4eaa100c-f1ef-4a2b-9370-5dad7f3a95f2", "Unleash Fury", [
          "Double the power of target creature until end of turn."
    ], {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'doublePowerTarget', target: 0 }],
        description: 'Double target creature’s power until end of turn',
      },
    });

}
