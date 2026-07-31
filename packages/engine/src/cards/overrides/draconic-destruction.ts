/**
 * Authored card overrides for draconic-destruction.txt.
 */

import { registerOverride } from './index';
import { parseManaCost } from '../../mana/cost';
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
    costs: [{ kind: 'mana' as const, cost: parseManaCost('{4}{R}').cost! }],
    timing: 'any' as const,
    requiresAttackedThisTurn: true as const,
    oncePerTurn: true,
    ability: {
      kind: 'activated' as const,
      targets: [],
      effects: [{
        op: 'createToken' as const,
        count: { kind: 'const' as const, n: 1 },
        spec: {
          name: 'Dragon', typeLine: 'Creature — Dragon', types: ['Creature'], subtypes: ['Dragon'],
          colors: ['R' as const], power: 5, toughness: 5, keywords: ['flying' as const],
        },
      }],
      description: 'Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying',
    },
  }],
};

const HOARD_SMELTER_DRAGON_DEF = {
  activatedAbilities: [{
    costs: [{ kind: 'mana' as const, cost: parseManaCost('{3}{R}').cost! }],
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
      { kind: 'mana' as const, cost: parseManaCost('{5}{R}').cost! },
      { kind: 'exileSelfFromGraveyard' as const },
    ],
    timing: 'any' as const,
    zone: 'graveyard' as const,
    ability: {
      kind: 'activated' as const,
      targets: [],
      effects: [{ op: 'eachPlayerDiscardHandThenDraw' as const, count: { kind: 'const' as const, n: 7 } }],
      description: 'Exile this card from your graveyard — each player discards their hand, then draws seven cards',
    },
  }],
};

const DRAGON_MAGE_DEF = {
  triggers: [{
    kind: 'triggered' as const,
    trigger: { when: 'dealsCombatDamageToPlayer' as const, subject: { kind: 'self' as const } },
    targets: [],
    effects: [{ op: 'eachPlayerDiscardHandThenDraw' as const, count: { kind: 'const' as const, n: 7 } }],
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
    effects: [{ op: 'mayPayXThenDealDamage' as const, target: 0, templatedCost: parseManaCost('{X}{R}').cost! }],
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
          { op: 'dealDamage' as const, target: 0, amount: { kind: 'const' as const, n: 4 } },
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
              effects: [{ op: 'draw' as const, count: { kind: 'const' as const, n: 2 } }],
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
      condition: { kind: 'mayPayMana' as const, cost: parseManaCost('{R}').cost! },
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
    effects: [{ op: 'dealDamage' as const, target: 'eventPlayer' as const, amount: { kind: 'const' as const, n: 3 } }],
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
      costs: [{ kind: 'mana' as const, cost: parseManaCost('{2}').cost! }],
      timing: 'any' as const,
      ability: {
        kind: 'activated' as const,
        targets: [],
        effects: [{ op: 'pumpEachUntilEot' as const, selector: SELF, power: 1, toughness: 0 }],
        description: '{2}: ~ gets +1/+0 until end of turn.',
      },
    },
    {
      costs: [{ kind: 'mana' as const, cost: parseManaCost('{X}').cost! }],
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
      effects: [{ op: 'addMana' as const, amount: { kind: 'const' as const, n: 2 }, colors: ['G' as const], fixedSymbols: ['G' as const, 'G' as const] }],
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
          effects: [{ op: 'dealDamage' as const, target: 0, amount: { kind: 'const' as const, n: 7 } }],
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
      { op: 'dealDamage' as const, target: 0, amount: { kind: 'const' as const, n: 3 } },
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
    effects: [{ op: 'dealDamageUnlessSacrifice' as const, target: 0, amount: { kind: 'const' as const, n: 5 } }],
    description: "Enters — deal 5 damage to target opponent unless they sacrifice a creature",
  }],
};

export function registerDRACONIC_DESTRUCTIONOverrides(): void {
  registerOverride({
    oracleId: "7735eeba-693b-47e2-bd51-414379cf1016",
    name: "Beast Within",
    handledLines: [
          "Destroy target permanent. Its controller creates a 3/3 green Beast creature token."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'permanent' }], effects: [{ op: 'destroyAndCreateTokenForController', target: 0, count: { kind: 'const', n: 1 }, spec: { name: 'Beast', typeLine: 'Creature � Beast', types: ['Creature'], subtypes: ['Beast'], colors: ['G'], power: 3, toughness: 3 } }], description: 'Destroy target permanent; its controller creates a 3/3 Beast' },
    },
  });
  registerOverride({
    oracleId: "oracle-beast-within",
    name: "Beast Within",
    handledLines: [
          "Destroy target permanent. Its controller creates a 3/3 green Beast creature token."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'permanent' }], effects: [{ op: 'destroyAndCreateTokenForController', target: 0, count: { kind: 'const', n: 1 }, spec: { name: 'Beast', typeLine: 'Creature � Beast', types: ['Creature'], subtypes: ['Beast'], colors: ['G'], power: 3, toughness: 3 } }], description: 'Destroy target permanent; its controller creates a 3/3 Beast' },
    },
  });

  registerOverride({
    oracleId: "06b77a80-4968-4385-960a-fb66bb4faa94",
    name: "Dragonkin Berserker",
    handledLines: [
          "Boast abilities you activate cost {1} less to activate for each Dragon you control.",
          // Registering ANY non-empty override for this oracleId disables the interpreter's
          // generic ability-word label stripping for its remaining lines (`interpret.ts`'s
          // `genericLabelStripAllowed`) — so the "Boast — " prefix here, previously stripped
          // and generically parsed, now needs its own claim too.
          "Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying."
    ],
    def: DRAGONKIN_BERSERKER_DEF,
  });
  registerOverride({
    oracleId: "oracle-dragonkin-berserker",
    name: "Dragonkin Berserker",
    handledLines: [
          "Boast abilities you activate cost {1} less to activate for each Dragon you control.",
          // Registering ANY non-empty override for this oracleId disables the interpreter's
          // generic ability-word label stripping for its remaining lines (`interpret.ts`'s
          // `genericLabelStripAllowed`) — so the "Boast — " prefix here, previously stripped
          // and generically parsed, now needs its own claim too.
          "Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying."
    ],
    def: DRAGONKIN_BERSERKER_DEF,
  });

  registerOverride({
    oracleId: "b6fb79c3-cd32-4045-8177-e52841eea65b",
    name: "Dragonmaster Outcast",
    handledLines: [
          "At the beginning of your upkeep, if you control six or more lands, create a 5/5 red Dragon creature token with flying."
    ],
    def: {
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
          count: { kind: 'const', n: 1 },
          spec: {
            name: 'Dragon', typeLine: 'Creature � Dragon', types: ['Creature'], subtypes: ['Dragon'],
            colors: ['R'], power: 5, toughness: 5, keywords: ['flying'],
          },
        }],
        description: 'Upkeep with six lands � create a Dragon token',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-dragonmaster-outcast",
    name: "Dragonmaster Outcast",
    handledLines: [
          "At the beginning of your upkeep, if you control six or more lands, create a 5/5 red Dragon creature token with flying."
    ],
    def: {
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
          count: { kind: 'const', n: 1 },
          spec: {
            name: 'Dragon', typeLine: 'Creature � Dragon', types: ['Creature'], subtypes: ['Dragon'],
            colors: ['R'], power: 5, toughness: 5, keywords: ['flying'],
          },
        }],
        description: 'Upkeep with six lands � create a Dragon token',
      }],
    },
  });

  registerOverride({
    oracleId: "d1d171de-1c6d-4fb9-817a-9c689c709f3d",
    name: "Shamanic Revelation",
    handledLines: [
          "Draw a card for each creature you control.",
          "You gain 4 life for each creature you control with power 4 or greater."
    ],
    def: { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'draw', count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } }, { op: 'gainLife', amount: { kind: 'times', of: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS, { kind: 'powerAtLeast', n: 4 }), scope: 'you' }, n: 4 } }], description: 'Draw for creatures; gain four life per creature with power four or greater' } },
  });
  registerOverride({
    oracleId: "oracle-shamanic-revelation",
    name: "Shamanic Revelation",
    handledLines: [
          "Draw a card for each creature you control.",
          "You gain 4 life for each creature you control with power 4 or greater."
    ],
    def: { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'draw', count: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS), scope: 'you' } }, { op: 'gainLife', amount: { kind: 'times', of: { kind: 'countPermanents', selector: allOf(ofType('Creature'), YOURS, { kind: 'powerAtLeast', n: 4 }), scope: 'you' }, n: 4 } }], description: 'Draw for creatures; gain four life per creature with power four or greater' } },
  });

  registerOverride({
    oracleId: "05b6f9e3-9acd-43a6-acff-caa811aaf0a1",
    name: "Akoum Hellkite",
    handledLines: [
          "Whenever a land you control enters, this creature deals 1 damage to any target. If that land is a Mountain, this creature deals 2 damage instead."
    ],
    def: {
      triggers: [{
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) } },
        targets: [{ kind: 'anyTarget' }],
        effects: [{
          op: 'conditionalEffect',
          condition: { kind: 'triggerObjectMatches', selector: ofSubtype('Mountain') },
          then: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 2 } }],
          else: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } }],
        }],
        description: 'Land enters — deal 1 damage to any target, or 2 if it was a Mountain',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-akoum-hellkite",
    name: "Akoum Hellkite",
    handledLines: [
          "Whenever a land you control enters, this creature deals 1 damage to any target. If that land is a Mountain, this creature deals 2 damage instead."
    ],
    def: {
      triggers: [{
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) } },
        targets: [{ kind: 'anyTarget' }],
        effects: [{
          op: 'conditionalEffect',
          condition: { kind: 'triggerObjectMatches', selector: ofSubtype('Mountain') },
          then: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 2 } }],
          else: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } }],
        }],
        description: 'Land enters — deal 1 damage to any target, or 2 if it was a Mountain',
      }],
    },
  });

  registerOverride({
    oracleId: "eb287c04-97f5-4e47-beb1-66cc7d15e748",
    name: "Atarka Monument",
    handledLines: [
          "{4}{R}{G}: ~ becomes a 4/4 red and green Dragon artifact creature with flying until end of turn."
    ],
    def: {
      activatedAbilities: [{
        costs: [{ kind: 'mana', cost: parseManaCost('{4}{R}{G}').cost! }],
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
    },
  });
  registerOverride({
    oracleId: "oracle-atarka-monument",
    name: "Atarka Monument",
    handledLines: [
          "{4}{R}{G}: ~ becomes a 4/4 red and green Dragon artifact creature with flying until end of turn."
    ],
    def: {
      activatedAbilities: [{
        costs: [{ kind: 'mana', cost: parseManaCost('{4}{R}{G}').cost! }],
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
    },
  });

  registerOverride({
    oracleId: "5a851367-1c4a-4cc9-a9c3-3d2775986b4c",
    name: "Blossoming Defense",
    handledLines: [
          "Target creature you control gets +2/+2 and gains hexproof until end of turn."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'creature', controller: 'you' }], effects: [{ op: 'pumpUntilEot', target: 0, power: 2, toughness: 2 }, { op: 'grantKeywordUntilEot', target: 0, keyword: 'hexproof' }], description: 'Target creature gets +2/+2 and hexproof until end of turn' },
    },
  });
  registerOverride({
    oracleId: "oracle-blossoming-defense",
    name: "Blossoming Defense",
    handledLines: [
          "Target creature you control gets +2/+2 and gains hexproof until end of turn."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'creature', controller: 'you' }], effects: [{ op: 'pumpUntilEot', target: 0, power: 2, toughness: 2 }, { op: 'grantKeywordUntilEot', target: 0, keyword: 'hexproof' }], description: 'Target creature gets +2/+2 and hexproof until end of turn' },
    },
  });

  registerOverride({
    oracleId: "086b2564-9114-4ba2-94fd-b490f98f38a7",
    name: "Chain Reaction",
    handledLines: [
          "~ deals X damage to each creature, where X is the number of creatures on the battlefield."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'damageEach', selector: ofType('Creature'), amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'all' } }],
        description: 'Deal damage to each creature equal to creatures on the battlefield',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-chain-reaction",
    name: "Chain Reaction",
    handledLines: [
          "~ deals X damage to each creature, where X is the number of creatures on the battlefield."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'damageEach', selector: ofType('Creature'), amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'all' } }],
        description: 'Deal damage to each creature equal to creatures on the battlefield',
      },
    },
  });

  registerOverride({
    oracleId: "abcf5e77-88fc-4b76-a1e8-907a5b27d612",
    name: "Clan Defiance",
    handledLines: [
          "Choose one or more —",
          "• ~ deals X damage to target creature with flying.",
          "• ~ deals X damage to target creature without flying.",
          "• ~ deals X damage to target player or planeswalker."
    ],
    def: CLAN_DEFIANCE_DEF,
  });
  registerOverride({
    oracleId: "oracle-clan-defiance",
    name: "Clan Defiance",
    handledLines: [
          "Choose one or more —",
          "• ~ deals X damage to target creature with flying.",
          "• ~ deals X damage to target creature without flying.",
          "• ~ deals X damage to target player or planeswalker."
    ],
    def: CLAN_DEFIANCE_DEF,
  });

  registerOverride({
    oracleId: "c8f1e3bd-bbf0-4750-b054-03553fc61850",
    name: "Demanding Dragon",
    handledLines: [
          "When this creature enters, it deals 5 damage to target opponent unless that player sacrifices a creature of their choice."
    ],
    def: DEMANDING_DRAGON_DEF,
  });
  registerOverride({
    oracleId: "oracle-demanding-dragon",
    name: "Demanding Dragon",
    handledLines: [
          "When this creature enters, it deals 5 damage to target opponent unless that player sacrifices a creature of their choice."
    ],
    def: DEMANDING_DRAGON_DEF,
  });

  registerOverride({
    oracleId: "faf81ae0-0b35-45ef-a50d-6cecf0c0eeeb",
    name: "Dragonlord's Servant",
    handledLines: [
          "Dragon spells you cast cost {1} less to cast."
    ],
    def: {
      ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofSubtype('Dragon') }],
    },
  });
  registerOverride({
    oracleId: "oracle-dragonlord-s-servant",
    name: "Dragonlord's Servant",
    handledLines: [
          "Dragon spells you cast cost {1} less to cast."
    ],
    def: {
      ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofSubtype('Dragon') }],
    },
  });

  registerOverride({
    oracleId: "777b8ec4-a783-4297-96b7-4f200d0eb734",
    name: "Return to Nature",
    handledLines: [
          "Choose one —",
          "• Destroy target artifact.",
          "• Destroy target enchantment.",
          "• Exile target card from a graveyard."
    ],
    def: {
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
    },
  });
  registerOverride({
    oracleId: "oracle-return-to-nature",
    name: "Return to Nature",
    handledLines: [
          "Choose one —",
          "• Destroy target artifact.",
          "• Destroy target enchantment.",
          "• Exile target card from a graveyard."
    ],
    def: {
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
    },
  });

  registerOverride({
    oracleId: "6a29f36b-7911-4d84-a3ae-546b131d5159",
    name: "Dragonspeaker Shaman",
    handledLines: [
          "Dragon spells you cast cost {2} less to cast."
    ],
    def: {
      ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 2 }, filter: ofSubtype('Dragon') }],
    },
  });
  registerOverride({
    oracleId: "oracle-dragonspeaker-shaman",
    name: "Dragonspeaker Shaman",
    handledLines: [
          "Dragon spells you cast cost {2} less to cast."
    ],
    def: {
      ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 2 }, filter: ofSubtype('Dragon') }],
    },
  });

  registerOverride({
    oracleId: "eab71e4e-27c3-4c41-b95f-259c1d14b97a",
    name: "Dragon Mage",
    handledLines: [
          "Whenever this creature deals combat damage to a player, each player discards their hand, then draws seven cards."
    ],
    def: DRAGON_MAGE_DEF,
  });
  registerOverride({
    oracleId: "oracle-dragon-mage",
    name: "Dragon Mage",
    handledLines: [
          "Whenever this creature deals combat damage to a player, each player discards their hand, then draws seven cards."
    ],
    def: DRAGON_MAGE_DEF,
  });

  registerOverride({
    oracleId: "504cc26d-3fd5-4391-9d30-f0614e5c8bbc",
    name: "Dream Pillager",
    handledLines: [
          "Whenever this creature deals combat damage to a player, exile that many cards from the top of your library. Until end of turn, you may cast spells from among those exiled cards."
    ],
    def: DREAM_PILLAGER_DEF,
  });
  registerOverride({
    oracleId: "oracle-dream-pillager",
    name: "Dream Pillager",
    handledLines: [
          "Whenever this creature deals combat damage to a player, exile that many cards from the top of your library. Until end of turn, you may cast spells from among those exiled cards."
    ],
    def: DREAM_PILLAGER_DEF,
  });

  registerOverride({
    oracleId: "e7dd3e2c-34a5-4097-b6d1-2ccd097fe57f",
    name: "Foe-Razer Regent",
    handledLines: [
          "When this creature enters, you may have it fight target creature you don't control.",
          "Whenever a creature you control fights, put two +1/+1 counters on it at the beginning of the next end step."
    ],
    def: FOE_RAZER_REGENT_DEF,
  });
  registerOverride({
    oracleId: "oracle-foe-razer-regent",
    name: "Foe-Razer Regent",
    handledLines: [
          "When this creature enters, you may have it fight target creature you don't control.",
          "Whenever a creature you control fights, put two +1/+1 counters on it at the beginning of the next end step."
    ],
    def: FOE_RAZER_REGENT_DEF,
  });

  registerOverride({
    oracleId: "3180ee4f-66d7-4b73-bc10-9ee0c790ec18",
    name: "Flameblast Dragon",
    handledLines: [
          "Whenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target."
    ],
    def: FLAMEBLAST_DRAGON_DEF,
  });
  registerOverride({
    oracleId: "oracle-flameblast-dragon",
    name: "Flameblast Dragon",
    handledLines: [
          "Whenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target."
    ],
    def: FLAMEBLAST_DRAGON_DEF,
  });

  registerOverride({
    oracleId: "00de57d2-7cb6-4337-9bc6-f6711e4dfabf",
    name: "Game Trail",
    handledLines: [
          "As this land enters, you may reveal a Mountain or Forest card from your hand. If you don't, this land enters tapped."
    ],
    def: { entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Mountain', 'Forest'] } },
  });
  registerOverride({
    oracleId: "oracle-game-trail",
    name: "Game Trail",
    handledLines: [
          "As this land enters, you may reveal a Mountain or Forest card from your hand. If you don't, this land enters tapped."
    ],
    def: { entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Mountain', 'Forest'] } },
  });

  registerOverride({
    oracleId: "4cfaa5cf-cc3d-49a7-9544-38a8bb7e9ec1",
    name: "Frontier Siege",
    handledLines: [
          "As this enchantment enters, choose Khans or Dragons.",
          "• Khans — At the beginning of each of your main phases, add {G}{G}.",
          "• Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don't control."
    ],
    def: FRONTIER_SIEGE_DEF,
  });
  registerOverride({
    oracleId: "oracle-frontier-siege",
    name: "Frontier Siege",
    handledLines: [
          "As this enchantment enters, choose Khans or Dragons.",
          "• Khans — At the beginning of each of your main phases, add {G}{G}.",
          "• Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don't control."
    ],
    def: FRONTIER_SIEGE_DEF,
  });

  registerOverride({
    oracleId: "3256029f-6558-4fcc-9fa1-74ceba3e5c92",
    name: "Harbinger of the Hunt",
    handledLines: [
          "{2}{G}: ~ deals 1 damage to each other creature with flying."
    ],
    def: { activatedAbilities: [{ costs: [{ kind: 'mana', cost: parseManaCost('{2}{G}').cost! }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'damageEach', selector: allOf(OTHER, ofType('Creature'), withKeyword('flying')), amount: { kind: 'const', n: 1 } }], description: 'Deal one damage to each other flying creature' } }] },
  });
  registerOverride({
    oracleId: "oracle-harbinger-of-the-hunt",
    name: "Harbinger of the Hunt",
    handledLines: [
          "{2}{G}: ~ deals 1 damage to each other creature with flying."
    ],
    def: { activatedAbilities: [{ costs: [{ kind: 'mana', cost: parseManaCost('{2}{G}').cost! }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'damageEach', selector: allOf(OTHER, ofType('Creature'), withKeyword('flying')), amount: { kind: 'const', n: 1 } }], description: 'Deal one damage to each other flying creature' } }] },
  });

  registerOverride({
    oracleId: "cf9db2be-3c95-45a2-ab85-694e3bd3bf1d",
    name: "Hoard-Smelter Dragon",
    handledLines: [
          "{3}{R}: Destroy target artifact. ~ gets +X/+0 until end of turn, where X is that artifact's mana value."
    ],
    def: HOARD_SMELTER_DRAGON_DEF,
  });
  registerOverride({
    oracleId: "oracle-hoard-smelter-dragon",
    name: "Hoard-Smelter Dragon",
    handledLines: [
          "{3}{R}: Destroy target artifact. ~ gets +X/+0 until end of turn, where X is that artifact's mana value."
    ],
    def: HOARD_SMELTER_DRAGON_DEF,
  });

  registerOverride({
    oracleId: "e1a776d2-fb3a-4215-a14e-4b6e9bda95df",
    name: "Hunter's Prowess",
    handledLines: [
          "Until end of turn, target creature gets +3/+3 and gains trample and \"Whenever this creature deals combat damage to a player, draw that many cards.\""
    ],
    def: HUNTERS_PROWESS_DEF,
  });
  registerOverride({
    oracleId: "oracle-hunter-s-prowess",
    name: "Hunter's Prowess",
    handledLines: [
          "Until end of turn, target creature gets +3/+3 and gains trample and \"Whenever this creature deals combat damage to a player, draw that many cards.\""
    ],
    def: HUNTERS_PROWESS_DEF,
  });

  registerOverride({
    oracleId: "cf7352bf-3971-4bb7-88b9-65ab9a219289",
    name: "Loaming Shaman",
    handledLines: [
          "When this creature enters, target player shuffles any number of target cards from their graveyard into their library."
    ],
    def: LOAMING_SHAMAN_DEF,
  });
  registerOverride({
    oracleId: "oracle-loaming-shaman",
    name: "Loaming Shaman",
    handledLines: [
          "When this creature enters, target player shuffles any number of target cards from their graveyard into their library."
    ],
    def: LOAMING_SHAMAN_DEF,
  });

  registerOverride({
    oracleId: "a52037df-0be1-4c99-b9eb-b033157af203",
    name: "Magmaquake",
    handledLines: [
          "~ deals X damage to each creature without flying and each planeswalker."
    ],
    def: { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'damageEach', selector: anyOf(allOf(ofType('Creature'), not(withKeyword('flying'))), ofType('Planeswalker')), amount: { kind: 'xValue' } }], description: 'Deal X damage to each nonflying creature and planeswalker' } },
  });
  registerOverride({
    oracleId: "oracle-magmaquake",
    name: "Magmaquake",
    handledLines: [
          "~ deals X damage to each creature without flying and each planeswalker."
    ],
    def: { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'damageEach', selector: anyOf(allOf(ofType('Creature'), not(withKeyword('flying'))), ofType('Planeswalker')), amount: { kind: 'xValue' } }], description: 'Deal X damage to each nonflying creature and planeswalker' } },
  });

  registerOverride({
    oracleId: "c02ed1b7-1f8d-4196-a9b6-65e1b5a763d7",
    name: "Mordant Dragon",
    handledLines: [
          "Whenever this creature deals combat damage to a player, you may have it deal that much damage to target creature that player controls."
    ],
    def: { triggers: [{ kind: 'triggered', trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } }, targets: [{ kind: 'creature', controller: 'eventPlayer' }], effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'damageDealt' } }], description: 'Combat damage to player � may deal that much to one of their creatures' }] },
  });
  registerOverride({
    oracleId: "oracle-mordant-dragon",
    name: "Mordant Dragon",
    handledLines: [
          "Whenever this creature deals combat damage to a player, you may have it deal that much damage to target creature that player controls."
    ],
    def: { triggers: [{ kind: 'triggered', trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } }, targets: [{ kind: 'creature', controller: 'eventPlayer' }], effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'damageDealt' } }], description: 'Combat damage to player � may deal that much to one of their creatures' }] },
  });

  registerOverride({
    oracleId: "58d7b8b3-ac47-4805-8259-4ba8e70d7dc3",
    name: "Primal Might",
    handledLines: [
          "Target creature you control gets +X/+X until end of turn. Then it fights up to one target creature you don't control."
    ],
    def: PRIMAL_MIGHT_DEF,
  });
  registerOverride({
    oracleId: "oracle-primal-might",
    name: "Primal Might",
    handledLines: [
          "Target creature you control gets +X/+X until end of turn. Then it fights up to one target creature you don't control."
    ],
    def: PRIMAL_MIGHT_DEF,
  });

  registerOverride({
    oracleId: "ac844303-487b-49e9-9170-02892153ca6a",
    name: "Provoke the Trolls",
    handledLines: [
          "~ deals 3 damage to any target. If a creature is dealt damage this way, it gets +5/+0 until end of turn."
    ],
    def: PROVOKE_THE_TROLLS_DEF,
  });
  registerOverride({
    oracleId: "oracle-provoke-the-trolls",
    name: "Provoke the Trolls",
    handledLines: [
          "~ deals 3 damage to any target. If a creature is dealt damage this way, it gets +5/+0 until end of turn."
    ],
    def: PROVOKE_THE_TROLLS_DEF,
  });

  registerOverride({
    oracleId: "a3f2c946-409f-4093-b4db-c954d3480a72",
    name: "Runehorn Hellkite",
    handledLines: [
          "{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards."
    ],
    def: RUNEHORN_HELLKITE_DEF,
  });
  registerOverride({
    oracleId: "oracle-runehorn-hellkite",
    name: "Runehorn Hellkite",
    handledLines: [
          "{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards."
    ],
    def: RUNEHORN_HELLKITE_DEF,
  });

  registerOverride({
    oracleId: "f743d85f-754e-4e70-9907-af54acb9e8d4",
    name: "Savage Ventmaw",
    handledLines: [
          "Whenever this creature attacks, add {R}{R}{R}{G}{G}{G}. Until end of turn, you don't lose this mana as steps and phases end."
    ],
    def: {
      triggers: [{
        kind: 'triggered',
        trigger: { when: 'attacks', subject: { kind: 'self' } },
        targets: [],
        effects: [{ op: 'addMana', amount: { kind: 'const', n: 6 }, colors: ['R', 'G'], fixedSymbols: ['R', 'R', 'R', 'G', 'G', 'G'], persistent: true }],
        description: 'Attack � add {R}{R}{R}{G}{G}{G} until end of turn',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-savage-ventmaw",
    name: "Savage Ventmaw",
    handledLines: [
          "Whenever this creature attacks, add {R}{R}{R}{G}{G}{G}. Until end of turn, you don't lose this mana as steps and phases end."
    ],
    def: {
      triggers: [{
        kind: 'triggered',
        trigger: { when: 'attacks', subject: { kind: 'self' } },
        targets: [],
        effects: [{ op: 'addMana', amount: { kind: 'const', n: 6 }, colors: ['R', 'G'], fixedSymbols: ['R', 'R', 'R', 'G', 'G', 'G'], persistent: true }],
        description: 'Attack � add {R}{R}{R}{G}{G}{G} until end of turn',
      }],
    },
  });

  registerOverride({
    oracleId: "80c26f58-04b0-4db0-b84e-9b136609abe0",
    name: "Sarkhan, the Dragonspeaker",
    handledLines: [
          "+1: Until end of turn, ~ becomes a legendary 4/4 red Dragon creature with flying, indestructible, and haste.",
          // The −3 line ("~ deals 4 damage to target creature.") is no longer claimed here: since
          // Wizards errata'd away its "that creature deals 4 damage to him" clause, the generic
          // interpreter's own damage-effect grammar parses it unaided, so it never appears in
          // unmodeledReasons for this override to consume. The custom loyalty ability below still
          // implements it (this override's `def` fully replaces `activatedAbilities`) — it's just
          // no longer the thing filling an interpreter gap.
          "−6: You get an emblem with \"At the beginning of your draw step, draw two additional cards\" and \"At the beginning of your end step, discard your hand.\""
    ],
    def: SARKHAN_THE_DRAGONSPEAKER_DEF,
  });
  registerOverride({
    oracleId: "oracle-sarkhan-the-dragonspeaker",
    name: "Sarkhan, the Dragonspeaker",
    handledLines: [
          "+1: Until end of turn, ~ becomes a legendary 4/4 red Dragon creature with flying, indestructible, and haste.",
          // The −3 line ("~ deals 4 damage to target creature.") is no longer claimed here: since
          // Wizards errata'd away its "that creature deals 4 damage to him" clause, the generic
          // interpreter's own damage-effect grammar parses it unaided, so it never appears in
          // unmodeledReasons for this override to consume. The custom loyalty ability below still
          // implements it (this override's `def` fully replaces `activatedAbilities`) — it's just
          // no longer the thing filling an interpreter gap.
          "−6: You get an emblem with \"At the beginning of your draw step, draw two additional cards\" and \"At the beginning of your end step, discard your hand.\""
    ],
    def: SARKHAN_THE_DRAGONSPEAKER_DEF,
  });

  registerOverride({
    oracleId: "0a147009-a57c-4ac1-ab81-d8bd8b737631",
    name: "Scourge of Valkas",
    handledLines: [
          "Whenever this creature or another Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control."
    ],
    def: {
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
        description: 'Dragon enters � deal damage equal to Dragons controlled',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-scourge-of-valkas",
    name: "Scourge of Valkas",
    handledLines: [
          "Whenever this creature or another Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control."
    ],
    def: {
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
        description: 'Dragon enters � deal damage equal to Dragons controlled',
      }],
    },
  });

  registerOverride({
    oracleId: "f63278e0-3c67-421d-87ce-67725e5e74df",
    name: "Spit Flame",
    handledLines: [
          "Whenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand."
    ],
    def: SPIT_FLAME_DEF,
  });
  registerOverride({
    oracleId: "oracle-spit-flame",
    name: "Spit Flame",
    handledLines: [
          "Whenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand."
    ],
    def: SPIT_FLAME_DEF,
  });

  registerOverride({
    oracleId: "6e64f1e0-ddd6-4ee7-8797-086e234b02e8",
    name: "Steel Hellkite",
    handledLines: [
          "{X}: Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn. Activate only once each turn."
    ],
    def: STEEL_HELLKITE_DEF,
  });
  registerOverride({
    oracleId: "oracle-steel-hellkite",
    name: "Steel Hellkite",
    handledLines: [
          "{X}: Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn. Activate only once each turn."
    ],
    def: STEEL_HELLKITE_DEF,
  });

  registerOverride({
    oracleId: "bb04f927-0348-4a14-9e74-381f18083f6a",
    name: "Thunderbreak Regent",
    handledLines: [
          "Whenever a Dragon you control becomes the target of a spell or ability an opponent controls, this creature deals 3 damage to that player."
    ],
    def: THUNDERBREAK_REGENT_DEF,
  });
  registerOverride({
    oracleId: "oracle-thunderbreak-regent",
    name: "Thunderbreak Regent",
    handledLines: [
          "Whenever a Dragon you control becomes the target of a spell or ability an opponent controls, this creature deals 3 damage to that player."
    ],
    def: THUNDERBREAK_REGENT_DEF,
  });

  registerOverride({
    oracleId: "e958144e-01bc-46ff-8f56-ddf2eb098630",
    name: "Thundermaw Hellkite",
    handledLines: [
          "When this creature enters, it deals 1 damage to each creature with flying your opponents control. Tap those creatures."
    ],
    def: { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'damageEach', selector: allOf(ofType('Creature'), withKeyword('flying'), { kind: 'controller', who: 'opponents' }), amount: { kind: 'const', n: 1 } }, { op: 'tapEach', selector: allOf(ofType('Creature'), withKeyword('flying'), { kind: 'controller', who: 'opponents' }) }], description: 'Enters � deal one damage to and tap opposing fliers' }] },
  });
  registerOverride({
    oracleId: "oracle-thundermaw-hellkite",
    name: "Thundermaw Hellkite",
    handledLines: [
          "When this creature enters, it deals 1 damage to each creature with flying your opponents control. Tap those creatures."
    ],
    def: { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'damageEach', selector: allOf(ofType('Creature'), withKeyword('flying'), { kind: 'controller', who: 'opponents' }), amount: { kind: 'const', n: 1 } }, { op: 'tapEach', selector: allOf(ofType('Creature'), withKeyword('flying'), { kind: 'controller', who: 'opponents' }) }], description: 'Enters � deal one damage to and tap opposing fliers' }] },
  });

  registerOverride({
    oracleId: "63394e24-a456-4cc6-9885-8c62447b050a",
    name: "Tyrant's Familiar",
    handledLines: [
          "As long as you control your commander, this creature gets +2/+2 and has \"Whenever this creature attacks, it deals 7 damage to target creature defending player controls.\""
    ],
    def: TYRANTS_FAMILIAR_DEF,
  });
  registerOverride({
    oracleId: "oracle-tyrant-s-familiar",
    name: "Tyrant's Familiar",
    handledLines: [
          "As long as you control your commander, this creature gets +2/+2 and has \"Whenever this creature attacks, it deals 7 damage to target creature defending player controls.\""
    ],
    def: TYRANTS_FAMILIAR_DEF,
  });

  registerOverride({
    oracleId: "4eaa100c-f1ef-4a2b-9370-5dad7f3a95f2",
    name: "Unleash Fury",
    handledLines: [
          "Double the power of target creature until end of turn."
    ],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'doublePowerTarget', target: 0 }],
        description: 'Double target creature�s power until end of turn',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-unleash-fury",
    name: "Unleash Fury",
    handledLines: [
          "Double the power of target creature until end of turn."
    ],
    def: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'doublePowerTarget', target: 0 }],
        description: 'Double target creature�s power until end of turn',
      },
    },
  });

}
