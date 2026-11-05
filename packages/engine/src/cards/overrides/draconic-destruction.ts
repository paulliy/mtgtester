/**
 * Authored card overrides for draconic-destruction.txt.
 */

import { constant } from '../value';
import { EXILE_SELF_FROM_GRAVEYARD, mana, manaCost, targetSlots, triggered } from '../templates';
import { defineCard, unsupportedCard } from './index';
import { allOf, anyOf, not, ofSubtype, ofType, SELF, withKeyword, YOURS } from '../selector';

const HOARD_SMELTER_DRAGON_DEF = {
  activatedAbilities: [
    {
      costs: [mana('{3}{R}')],
      timing: 'any' as const,
      ability: {
        kind: 'activated' as const,
        targets: [{ kind: 'artifact' as const }],
        // Pump BEFORE destroy: the mana-value read has to happen while the artifact is still
        // on the battlefield, or `manaValueOfTarget` has nothing left to look up.
        effects: [
          {
            op: 'pumpUntilEot' as const,
            target: 'source' as const,
            power: { kind: 'manaValueOfTarget' as const, target: 0 },
            toughness: 0,
          },
          { op: 'destroy' as const, target: 0 },
        ],
        description:
          "Destroy target artifact; ~ gets +X/+0 until end of turn, X is that artifact's mana value",
      },
    },
  ],
};

const LOAMING_SHAMAN_DEF = {
  triggers: [
    {
      kind: 'triggered' as const,
      trigger: { when: 'enters' as const, subject: { kind: 'self' as const } },
      targets: [
        { kind: 'player' as const },
        {
          kind: 'cardInGraveyard' as const,
          graveyardOwnerSlot: 0,
          count: { min: 0, max: Infinity },
        },
      ],
      effects: [
        { op: 'shuffleChosenGraveyardCardsIntoLibrary' as const, playerSlot: 0, cardsSlot: 1 },
      ],
      description:
        'Enters — target player shuffles any number of target cards from their graveyard into their library',
    },
  ],
};

const PRIMAL_MIGHT_DEF = {
  spellAbility: {
    kind: 'spell' as const,
    targets: [
      { kind: 'creature' as const, controller: 'you' as const },
      { kind: 'creature' as const, controller: 'opponent' as const, count: { min: 0, max: 1 } },
    ],
    effects: [
      {
        op: 'pumpUntilEot' as const,
        target: 0,
        power: { kind: 'xValue' as const },
        toughness: { kind: 'xValue' as const },
      },
      { op: 'fightUpToOneChosen' as const, a: 0, bSlot: 1 },
    ],
    description:
      "Target creature you control gets +X/+X until end of turn, then fights up to one target creature you don't control",
  },
};

const RUNEHORN_HELLKITE_DEF = {
  activatedAbilities: [
    {
      costs: [mana('{5}{R}'), EXILE_SELF_FROM_GRAVEYARD],
      timing: 'any' as const,
      zone: 'graveyard' as const,
      ability: {
        kind: 'activated' as const,
        targets: [],
        effects: [{ op: 'eachPlayerDiscardHandThenDraw' as const, count: constant(7) }],
        description:
          'Exile this card from your graveyard — each player discards their hand, then draws seven cards',
      },
    },
  ],
};

const SPIT_FLAME_DEF = {
  triggers: [
    {
      kind: 'triggered' as const,
      trigger: {
        when: 'enters' as const,
        subject: { kind: 'permanent' as const, selector: allOf(ofSubtype('Dragon'), YOURS) },
      },
      functionsInGraveyard: true as const,
      targets: [],
      effects: [
        {
          op: 'conditionalEffect' as const,
          condition: { kind: 'mayPayMana' as const, cost: manaCost('{R}') },
          then: [{ op: 'returnSelfFromGraveyardToHand' as const }],
          else: [],
        },
      ],
      description:
        'A Dragon you control enters — you may pay {R}; if you do, return this card from your graveyard to your hand',
    },
  ],
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
        {
          effects: [{ op: 'dealDamage' as const, target: 0, amount: { kind: 'xValue' as const } }],
          description: '~ deals X damage to target creature with flying',
          targetSlots: [0],
        },
        {
          effects: [{ op: 'dealDamage' as const, target: 1, amount: { kind: 'xValue' as const } }],
          description: '~ deals X damage to target creature without flying',
          targetSlots: [1],
        },
        {
          effects: [{ op: 'dealDamage' as const, target: 2, amount: { kind: 'xValue' as const } }],
          description: '~ deals X damage to target player or planeswalker',
          targetSlots: [2],
        },
      ],
    },
    description:
      'Choose one or more — deal X damage to a flying creature, a nonflying creature, and/or a player or planeswalker',
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
        effects: [
          {
            op: 'destroyEachNonlandMVFromDamagedControllers' as const,
            mv: { kind: 'xValue' as const },
          },
        ],
        description:
          'Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn',
      },
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
          trigger: {
            when: 'dealsCombatDamageToPlayer' as const,
            subject: { kind: 'self' as const },
          },
          targets: [],
          effects: [{ op: 'draw' as const, count: { kind: 'damageDealt' as const } }],
          description: 'Deals combat damage to a player — draw that many cards',
        },
      },
    ],
    description:
      'Target creature gets +3/+3, trample, and draws on combat damage until end of turn',
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
    description:
      'Deal 3 damage to any target; if a creature was dealt damage this way, it gets +5/+0 until end of turn',
  },
};

const DEMANDING_DRAGON_DEF = {
  triggers: [
    {
      kind: 'triggered' as const,
      trigger: { when: 'enters' as const, subject: { kind: 'self' as const } },
      targets: [{ kind: 'player' as const, controller: 'opponent' as const }],
      effects: [{ op: 'dealDamageUnlessSacrifice' as const, target: 0, amount: constant(5) }],
      description: 'Enters — deal 5 damage to target opponent unless they sacrifice a creature',
    },
  ],
};

export function registerDRACONIC_DESTRUCTIONOverrides(): void {
  // Beast Within used to need an override here: `parseDestroyAndCreateTokenBlock`'s own token
  // derivation printed `typeLine: "Token Creature — Beast"`, one word off the shared catalog's
  // `"Creature — Beast"` (`tokens.ts`'s `creatureToken`). `parseTokenFace` now runs every parsed
  // token through `canonicalizeToken`, so the interpreter's own generic parse already produces
  // `BEAST_3_3_GREEN` by reference — verified in `draconic-destruction-overrides.test.ts`. A
  // `handledLines: []` override with a hardcoded `def` would have been strictly worse than no
  // override at all: it unconditionally pins that hardcoded shape with no drift guard watching
  // it (nothing is claimed, so `applyOverride` can never flag "this line is gone"), silently
  // masking a future errata or interpreter regression instead of surfacing it. Removed rather
  // than kept as a no-op-but-redundant registration.

  // Dragonkin Berserker: restored in coverage PR02 (no override remains).

  defineCard('d1d171de-1c6d-4fb9-817a-9c689c709f3d', 'Shamanic Revelation', [], {
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
        {
          op: 'gainLife',
          amount: {
            kind: 'times',
            of: {
              kind: 'countPermanents',
              selector: allOf(ofType('Creature'), YOURS, { kind: 'powerAtLeast', n: 4 }),
              scope: 'you',
            },
            n: 4,
          },
        },
      ],
      description: 'Draw for creatures; gain four life per creature with power four or greater',
    },
  });

  defineCard(
    '05b6f9e3-9acd-43a6-acff-caa811aaf0a1',
    'Akoum Hellkite',
    [
      'Whenever a land you control enters, this creature deals 1 damage to any target. If that land is a Mountain, this creature deals 2 damage instead.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) },
          },
          targets: [{ kind: 'anyTarget' }],
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'triggerObjectMatches', selector: ofSubtype('Mountain') },
              then: [{ op: 'dealDamage', target: 0, amount: constant(2) }],
              else: [{ op: 'dealDamage', target: 0, amount: constant(1) }],
            },
          ],
          description: 'Land enters — deal 1 damage to any target, or 2 if it was a Mountain',
        },
      ],
    },
  );

  unsupportedCard(
    'eb287c04-97f5-4e47-beb1-66cc7d15e748',
    'Atarka Monument',
    'The animation does not make it red and green.',
  );

  // Blossoming Defense: since coverage PR03 the interpreter reads "target creature you control
  // gets +2/+2 and gains hexproof until end of turn" as this same single-slot pump, so the
  // identical authored definition was deleted (overrides/index.ts rule 5).

  defineCard(
    '086b2564-9114-4ba2-94fd-b490f98f38a7',
    'Chain Reaction',
    ['~ deals X damage to each creature, where X is the number of creatures on the battlefield.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'damageEach',
            selector: ofType('Creature'),
            amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'all' },
          },
        ],
        description: 'Deal damage to each creature equal to creatures on the battlefield',
      },
    },
  );

  defineCard(
    'abcf5e77-88fc-4b76-a1e8-907a5b27d612',
    'Clan Defiance',
    [
      'Choose one or more —',
      '• ~ deals X damage to target creature with flying.',
      '• ~ deals X damage to target creature without flying.',
      '• ~ deals X damage to target player or planeswalker.',
    ],
    CLAN_DEFIANCE_DEF,
  );

  defineCard(
    'c8f1e3bd-bbf0-4750-b054-03553fc61850',
    'Demanding Dragon',
    [
      'When this creature enters, it deals 5 damage to target opponent unless that player sacrifices a creature of their choice.',
    ],
    DEMANDING_DRAGON_DEF,
  );

  // Return to Nature (coverage PR01) needs no override since coverage PR03: the interpreter reads
  // the three single-target modes, each announcing only its own target (CR 700.2a; 601.2c).

  // Dragonlord's Servant ("Dragon spells you cast cost {1} less to cast.") and Dragonspeaker
  // Shaman (the same line at {2}) no longer need overrides here â€” the line now parses
  // generically (see the Sarkhan, Soul Aflame special case in interpret.ts, which used to
  // hand-author this exact reduction and now leaves it to the same generic rule).

  // Dragon Mage's fixed-count wheel now parses generically. Keeping its handled-line override
  // would reject the correctly parsed clause as stale, or mask future Oracle changes.

  // Catalog audit draconic-batch-5: playableUntilEot includes playing lands.
  unsupportedCard(
    '504cc26d-3fd5-4391-9d30-f0614e5c8bbc',
    'Dream Pillager',
    'Exiled cards are playable, including lands; Oracle only permits casting spells.',
  );

  // Coverage PR01: the fight is optional on resolution (CR 603.5); with no creature you don't
  // control there is no target and the trigger is removed (CR 603.3d). The fights trigger
  // remembers the creature itself, so one that left before the end step gets no counters.
  defineCard(
    'e7dd3e2c-34a5-4097-b6d1-2ccd097fe57f',
    'Foe-Razer Regent',
    [
      "When this creature enters, you may have it fight target creature you don't control.",
      'Whenever a creature you control fights, put two +1/+1 counters on it at the beginning of the next end step.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          optional: true,
          targets: [{ kind: 'creature', controller: 'opponent' }],
          effects: [{ op: 'fight', first: 'source', second: 0 }],
          description: "You may have it fight target creature you don't control",
        },
        {
          kind: 'triggered',
          trigger: {
            when: 'fights',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
          },
          targets: [],
          effects: [
            {
              op: 'registerDelayedTrigger',
              when: 'endStep',
              expiry: 'onFire',
              target: 'triggerObject',
              sameObject: true,
              controller: 'source',
              ability: {
                kind: 'triggered',
                targets: [],
                effects: [
                  { op: 'putCounters', target: 'triggerObject', counter: '+1/+1', count: 2 },
                ],
                description: 'Put two +1/+1 counters on the creature that fought',
              },
            },
          ],
          description:
            'Whenever a creature you control fights, put two +1/+1 counters on it at the next end step',
        },
      ],
    },
  );

  // Flameblast Dragon: restored in coverage PR06 (see coverage-pr06.ts).

  defineCard(
    '00de57d2-7cb6-4337-9bc6-f6711e4dfabf',
    'Game Trail',
    [
      // The reveal-land line is read by the interpreter (EDHREC plan Phase 4 batch 4); the def
      // keeps the same as-enters choice.
    ],
    { entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Mountain', 'Forest'] } },
  );

  // Coverage PR01: the mode is chosen as it enters (a replacement, not a trigger). The Dragons
  // fight is optional on resolution (CR 603.5); with no creature you don't control there is no
  // target and the trigger is removed (CR 603.3d).
  defineCard(
    '4cfaa5cf-cc3d-49a7-9544-38a8bb7e9ec1',
    'Frontier Siege',
    [
      'As this enchantment enters, choose Khans or Dragons.',
      '• Khans — At the beginning of each of your main phases, add {G}{G}.',
      "• Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don't control.",
    ],
    {
      entersChoosingOption: {
        prompt: 'Choose Khans or Dragons',
        options: [
          { key: 'Khans', label: 'Khans — add {G}{G} at each of your main phases' },
          {
            key: 'Dragons',
            label: 'Dragons — your flying creatures may fight when they enter',
          },
        ],
      },
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'mainPhase',
            player: 'you',
            condition: { kind: 'chosenOptionIs', value: 'Khans' },
          },
          targets: [],
          effects: [
            {
              op: 'addMana',
              amount: constant(2),
              colors: ['G'],
              fixedSymbols: ['G', 'G'],
            },
          ],
          description: 'Khans — at the beginning of each of your main phases, add {G}{G}',
        },
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: {
              kind: 'permanent',
              selector: allOf(ofType('Creature'), withKeyword('flying'), YOURS),
            },
            condition: { kind: 'chosenOptionIs', value: 'Dragons' },
          },
          optional: true,
          targets: [{ kind: 'creature', controller: 'opponent' }],
          effects: [{ op: 'fight', first: 'triggerObject', second: 0 }],
          description:
            "Dragons — a flying creature you control enters; it may fight target creature you don't control",
        },
      ],
    },
  );

  defineCard(
    'cf9db2be-3c95-45a2-ab85-694e3bd3bf1d',
    'Hoard-Smelter Dragon',
    [
      "{3}{R}: Destroy target artifact. ~ gets +X/+0 until end of turn, where X is that artifact's mana value.",
    ],
    HOARD_SMELTER_DRAGON_DEF,
  );

  defineCard(
    'e1a776d2-fb3a-4215-a14e-4b6e9bda95df',
    "Hunter's Prowess",
    [
      'Until end of turn, target creature gets +3/+3 and gains trample and "Whenever this creature deals combat damage to a player, draw that many cards."',
    ],
    HUNTERS_PROWESS_DEF,
  );

  defineCard(
    'cf7352bf-3971-4bb7-88b9-65ab9a219289',
    'Loaming Shaman',
    [
      'When this creature enters, target player shuffles any number of target cards from their graveyard into their library.',
    ],
    LOAMING_SHAMAN_DEF,
  );

  defineCard(
    'a52037df-0be1-4c99-b9eb-b033157af203',
    'Magmaquake',
    ['~ deals X damage to each creature without flying and each planeswalker.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'damageEach',
            selector: anyOf(
              allOf(ofType('Creature'), not(withKeyword('flying'))),
              ofType('Planeswalker'),
            ),
            amount: { kind: 'xValue' },
          },
        ],
        description: 'Deal X damage to each nonflying creature and planeswalker',
      },
    },
  );

  // Coverage PR01: the target is a creature the damaged player controls, chosen as the trigger is
  // put on the stack (no such creature, no trigger: CR 603.3d); "you may" is decided on
  // resolution, and the Dragon deals the damage.
  defineCard(
    'c02ed1b7-1f8d-4196-a9b6-65e1b5a763d7',
    'Mordant Dragon',
    [
      'Whenever this creature deals combat damage to a player, you may have it deal that much damage to target creature that player controls.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          optional: true,
          targets: [{ kind: 'creature', controller: 'eventPlayer' }],
          effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'damageDealt' } }],
          description:
            'You may have it deal that much damage to target creature that player controls',
        },
      ],
    },
  );

  defineCard(
    '58d7b8b3-ac47-4805-8259-4ba8e70d7dc3',
    'Primal Might',
    [
      "Target creature you control gets +X/+X until end of turn. Then it fights up to one target creature you don't control.",
    ],
    PRIMAL_MIGHT_DEF,
  );

  defineCard(
    'ac844303-487b-49e9-9170-02892153ca6a',
    'Provoke the Trolls',
    [
      '~ deals 3 damage to any target. If a creature is dealt damage this way, it gets +5/+0 until end of turn.',
    ],
    PROVOKE_THE_TROLLS_DEF,
  );

  defineCard(
    'a3f2c946-409f-4093-b4db-c954d3480a72',
    'Runehorn Hellkite',
    [
      '{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards.',
    ],
    RUNEHORN_HELLKITE_DEF,
  );

  defineCard(
    'f743d85f-754e-4e70-9907-af54acb9e8d4',
    'Savage Ventmaw',
    [
      "Whenever this creature attacks, add {R}{R}{R}{G}{G}{G}. Until end of turn, you don't lose this mana as steps and phases end.",
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'attacks', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'addMana',
              amount: constant(6),
              colors: ['R', 'G'],
              fixedSymbols: ['R', 'R', 'R', 'G', 'G', 'G'],
              persistent: true,
            },
          ],
          description: 'Attack — add {R}{R}{R}{G}{G}{G} until end of turn',
        },
      ],
    },
  );

  unsupportedCard(
    '80c26f58-04b0-4db0-b84e-9b136609abe0',
    'Sarkhan, the Dragonspeaker',
    'The +1 does not make it legendary or red.',
  );

  // Scourge of Valkas: restored in coverage PR06 (no override remains).

  defineCard(
    'f63278e0-3c67-421d-87ce-67725e5e74df',
    'Spit Flame',
    [
      'Whenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand.',
    ],
    SPIT_FLAME_DEF,
  );

  defineCard(
    '6e64f1e0-ddd6-4ee7-8797-086e234b02e8',
    'Steel Hellkite',
    [
      '{X}: Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn. Activate only once each turn.',
    ],
    STEEL_HELLKITE_DEF,
  );

  // Thunderbreak Regent: restored in coverage PR06 (no override remains).

  // Thundermaw Hellkite: restored in coverage PR06 (see coverage-pr06.ts).

  // Tyrant's Familiar: Lieutenant (CR 903.7). While you control your own commander it gets +2/+2
  // and has an attack trigger; both exist only under that condition. The trigger's "defending
  // player" is the player this creature attacks (the event player), not its controller, and the
  // 7 damage is dealt by the Familiar itself.
  const lieutenantHit = targetSlots({ creature: { kind: 'creature', controller: 'eventPlayer' } });
  defineCard(
    '63394e24-a456-4cc6-9885-8c62447b050a',
    "Tyrant's Familiar",
    [
      'As long as you control your commander, this creature gets +2/+2 and has "Whenever this creature attacks, it deals 7 damage to target creature defending player controls."',
    ],
    {
      staticEffects: [
        {
          affects: SELF,
          op: { layer: 7, sublayer: 'd', power: 2, toughness: 2 },
          condition: { kind: 'controlsYourCommander' },
        },
        {
          affects: SELF,
          op: {
            layer: 6,
            addTrigger: triggered(
              {
                when: 'attacks',
                subject: { kind: 'self' },
                defendingPlayerIsEventPlayer: true,
              },
              {
                targets: lieutenantHit.targets,
                effects: [
                  {
                    op: 'dealDamage',
                    target: lieutenantHit.slot.creature,
                    amount: constant(7),
                  },
                ],
                description:
                  'Whenever this creature attacks, it deals 7 damage to target creature defending player controls',
              },
            ),
          },
          condition: { kind: 'controlsYourCommander' },
        },
      ],
    },
  );

  defineCard(
    '4eaa100c-f1ef-4a2b-9370-5dad7f3a95f2',
    'Unleash Fury',
    ['Double the power of target creature until end of turn.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'doublePowerTarget', target: 0 }],
        description: 'Double target creature’s power until end of turn',
      },
    },
  );
}
