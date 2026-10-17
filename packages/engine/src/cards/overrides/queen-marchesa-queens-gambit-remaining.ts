/** Remaining authored overrides for queen-marchesa-queens-gambit.txt. */

import type { CardDefinition } from '../definition';
import { activated, mana, manaCost, TAP, targetSlots, triggered, whenAttacks } from '../templates';
import { OTHER, ofType } from '../selector';
import { TREASURE } from '../tokens';
import { constant } from '../value';
import { defineCard, unsupportedCard } from './index';

const SMOTHERING_TITHE_HANDLED_LINES = [
  'unrecognized rules text: "Whenever an opponent draws a card, that player may pay {2}. If the player doesn\'t, you create a Treasure token."',
];

/**
 * One trigger is queued for each opponent card draw. The drawing opponent may pay through the
 * normal mana solver; only decline or inability creates the controller's Treasure.
 */
const SMOTHERING_TITHE_DEFINITION: Partial<CardDefinition> = {
  triggers: [
    triggered(
      { when: 'drawsCard', player: 'opponent' },
      {
        effects: [
          {
            op: 'unlessPays',
            payer: 'eventPlayer',
            cost: manaCost('{2}'),
            then: [{ op: 'createToken', spec: TREASURE, count: constant(1) }],
          },
        ],
        description: 'Whenever an opponent draws, create a Treasure unless they pay {2}',
      },
    ),
  ],
};

const CRACKLING_DOOM: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [],
    effects: [
      { op: 'eachOpponentDamage', amount: 2 },
      {
        op: 'sacrificeGreatestEachOpponent',
        selector: 'creature',
        metric: 'power',
        action: 'sacrifice',
      },
    ],
    description: 'Each opponent takes 2 damage and sacrifices their greatest-power creature',
  },
};
const FLUMPH: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'dealtDamage', subject: { kind: 'self' } },
      targets: [{ kind: 'player', controller: 'opponent' }],
      effects: [{ op: 'drawTargetAndController', target: 0 }],
      description: 'When dealt damage, you and an opponent each draw',
    },
  ],
};
const INKSHIELD: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [],
    effects: [{ op: 'inkshield' }],
    description: 'Prevent all combat damage to you; create one Inkling for each damage prevented',
  },
};
const MASTER: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'upkeep', player: 'you' },
      targets: [],
      effects: [{ op: 'masterOfCeremonies' }],
      description: 'Each opponent chooses money, friends, or secrets',
    },
  ],
};
const SECRET_RENDEZVOUS: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'player', controller: 'opponent' }],
    effects: [{ op: 'drawTargetAndControllerN', target: 0, count: 3 }],
    description: 'You and target opponent each draw three cards',
  },
};
export function registerQUEEN_MARCHESA_QUEENS_GAMBIT_REMAININGOverrides(): void {
  // Removed: the printed ability charges MANA, which the payment solver cannot pay
  // (see tests/mana-cost-in-mana-ability.test.ts). Authoring it here made the land tap
  // for two mana out of nothing. Left unmodeled until a mana source can pay for itself.

  // Blightstep/Brightclimb/Needleverge Pathway (land // land): now parses generically
  // (`buildPathwayLand` in interpret.ts, a `chosenColor`-dynamic mana ability driven by
  // `entersChoosingOption`) -- no override needed at all.
  //
  // Malakir Rebirth // Malakir Mire and Valakut Awakening // Valakut Stoneforge are the OTHER
  // Zendikar Rising modal-DFC shape: front is a spell, back is a land, which
  // `buildPathwayLand` doesn't cover (its front face isn't a land at all -- there is no color to
  // choose between, just one land this engine can offer). Modeled as that land only: the
  // overwhelming majority of real play taps these for mana rather than hard-casting the spell
  // side, and offering only the land is honestly under-permissive (ADR 0010) rather than wrong --
  // unlike the OLD `manaAbilities: []` / `staticEffects: []` registrations here, which slipped
  // past applyOverride's empty-patch guard (fixed in the previous commit) and silently reported
  // these as modeled with NO mana ability at all. Both real backs enter tapped, printed
  // identically across the whole Zendikar Rising slow-land cycle these two belong to.
  // Catalog audit queen-batch-2: spell face is claimed; only the land back is authored.
  unsupportedCard(
    'a731e87b-8d99-4b64-8ee3-8e540d652366',
    'Malakir Rebirth // Malakir Mire',
    'Spell face is claimed; only the land back is authored.',
  );
  // Catalog audit queen-batch-2: spell face is claimed; only the land back is authored.
  unsupportedCard(
    'ff0ab867-b710-4b1a-baed-95fc3cf68f79',
    'Valakut Awakening // Valakut Stoneforge',
    'Spell face is claimed; only the land back is authored.',
  );
  // Catalog audit queen-batch-5: modal DFC copy-on-cast with retarget is unimplemented.
  unsupportedCard(
    '6556c4c0-b10d-4208-821b-0c0a49abd188',
    'Wandering Archaic // Explore the Vastlands',
    'Modal DFC copy-on-cast with retarget is unimplemented.',
  );
  // Catalog audit queen-batch-2: Fuse authored as a third extra-cost mode.
  unsupportedCard(
    '9842734c-1eac-4509-a731-4c22017ae586',
    'Wear // Tear',
    'Fuse is authored as a third mode with an extra {2}{W} rather than casting both halves.',
  );
  // Catalog audit queen-batch-1: Split second and can't-lose/can't-win are claimed as lifeFloor.
  unsupportedCard(
    '66ca8a60-e028-4a5f-8177-860b888cb9d1',
    "Angel's Grace",
    'Split second and cannot-lose/cannot-win are implemented as a damage life floor only.',
  );
  // Arcbond: restored in coverage PR06 (see coverage-pr06.ts).
  // Backlash: restored in coverage PR06 (see coverage-pr06.ts).
  // Brash Taunter: "that much damage" is the amount dealt in the triggering event, dealt by the
  // Taunter itself to a target opponent. "Another target creature" is any creature but the
  // Taunter, whoever controls it, so the fight target carries an OTHER filter (CR 701.14).
  const reflect = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  const fightTarget = targetSlots({ creature: { kind: 'creature', filter: OTHER } });
  defineCard(
    '3e41648f-c5a9-4b26-b97e-8176fe5e9c85',
    'Brash Taunter',
    [
      'Whenever this creature is dealt damage, it deals that much damage to target opponent.',
      '{2}{R}, {T}: ~ fights another target creature.',
    ],
    {
      triggers: [
        triggered(
          { when: 'dealtDamage', subject: { kind: 'self' } },
          {
            targets: reflect.targets,
            effects: [
              { op: 'dealDamage', target: reflect.slot.opponent, amount: { kind: 'damageDealt' } },
            ],
            description:
              'Whenever this creature is dealt damage, it deals that much damage to target opponent',
          },
        ),
      ],
      activatedAbilities: [
        activated({
          costs: [mana('{2}{R}'), TAP],
          targets: fightTarget.targets,
          effects: [{ op: 'fight', first: 'source', second: fightTarget.slot.creature }],
          description: 'This creature fights another target creature',
        }),
      ],
    },
  );
  // Breena, the Demagogue: restored in coverage PR06 (see coverage-pr06.ts).
  // Combat Calligrapher: restored in coverage PR07 (see coverage-pr07.ts).
  // Comeuppance: restored in coverage PR06 (see coverage-pr06.ts).
  defineCard(
    'ee81f37b-2a81-46d7-8d2f-9091123846c4',
    'Crackling Doom',
    [
      'unrecognized rules text: "~ deals 2 damage to each opponent. Each opponent sacrifices a creature with the greatest power among creatures that player controls."',
    ],
    CRACKLING_DOOM,
  );
  // Cut a Deal: restored in coverage PR08.01 (see coverage-pr08.ts).
  // Deflecting Palm: restored in coverage PR06 (see coverage-pr06.ts).
  // Delirium: restored in coverage PR06 (see coverage-pr06.ts).
  // Catalog audit queen-batch-1: copies keep original targets; can't-be-copied is omitted.
  unsupportedCard(
    '99140891-face-4015-aacd-1309e87d8f9f',
    'Display of Power',
    'Cannot-be-copied is omitted, and copies keep original targets instead of choosing new ones.',
  );
  // Duelist's Heritage: "one or more creatures attack" is one trigger for the whole declaration
  // (CR 603.2c), whoever attacks. The target is any attacking creature, chosen as the trigger goes
  // on the stack; "you may" is decided on resolution (CR 603.5).
  const heritage = targetSlots({
    attacker: { kind: 'creature', filter: { kind: 'combatRole', role: 'attacking' } },
  });
  defineCard(
    '5cdc4654-b8c5-4599-a1d2-9e9d5f6509cb',
    "Duelist's Heritage",
    [
      'Whenever one or more creatures attack, you may have target attacking creature gain double strike until end of turn.',
    ],
    {
      triggers: [
        triggered(whenAttacks(ofType('Creature'), { aggregate: true }), {
          targets: heritage.targets,
          optional: true,
          effects: [
            {
              op: 'grantKeywordUntilEot',
              target: heritage.slot.attacker,
              keyword: 'double strike',
            },
          ],
          description:
            'Whenever one or more creatures attack, you may have target attacking creature gain double strike until end of turn',
        }),
      ],
    },
  );
  defineCard(
    'bc328acc-8521-4581-88c3-99a7cb2c1cdb',
    'Flumph',
    [
      'unrecognized rules text: "Whenever this creature is dealt damage, you and target opponent each draw a card."',
    ],
    FLUMPH,
  );
  // The line now parses generically (`attackTax` in `parseRuleStaticLine`) — no override needed.
  defineCard(
    '66f9f325-5e8e-4ebf-b5b3-c6410d80f2c5',
    'Gisela, Blade of Goldnight',
    [
      'unrecognized rules text: "If a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage to that player or permanent instead."',
      'unrecognized rules text: "If a source would deal damage to you or a permanent you control, prevent half that damage, rounded up."',
    ],
    { ruleStatics: [{ kind: 'damageDoubledToOpponents' }, { kind: 'damageHalvedToYou' }] },
  );
  // Catalog audit queen-batch-3: activate-only-during-your-turn is timing any.
  unsupportedCard(
    '1582e16d-4825-4cc5-b12c-449c45e4e449',
    'Humble Defector',
    'Activate-only-during-your-turn is implemented as timing any.',
  );
  defineCard(
    'da93264e-4e04-401a-9809-e4e1056cf604',
    'Inkshield',
    [
      'unrecognized rules text: "Prevent all combat damage that would be dealt to you this turn. For each 1 damage prevented this way, create a 2/1 white and black Inkling creature token with flying."',
    ],
    INKSHIELD,
  );
  // Coverage PR01: "up to one" is a 0..1 count slot, so Loran's trigger resolves with no target.
  // Coverage PR03: the interpreter reads "destroy up to one target artifact or enchantment" as that
  // slot itself, so only the draw ability is authored.
  const loranDraw = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  defineCard(
    'b3d81980-76f2-44e2-b1c9-01e30c726312',
    'Loran of the Third Path',
    ['{T}: You and target opponent each draw a card.'],
    {
      activatedAbilities: [
        activated({
          costs: [TAP],
          targets: loranDraw.targets,
          effects: [{ op: 'drawTargetAndController', target: loranDraw.slot.opponent }],
          description: 'You and target opponent each draw a card',
        }),
      ],
    },
  );
  // Mangara, the Diplomat: restored in coverage PR06 (see coverage-pr06.ts).
  defineCard(
    '18ed0c8a-db8f-4247-87c4-544b833f01bd',
    'Master of Ceremonies',
    [
      'unrecognized rules text: "At the beginning of your upkeep, each opponent chooses money, friends, or secrets. For each player who chose money, you and that player each create a Treasure token. For each player who chose friends, you and that player each create a 1/1 green and white Citizen creature token. For each player who chose secrets, you and that player each draw a card."',
    ],
    MASTER,
  );
  // Michiko Konda, Truth Seeker: restored in coverage PR06 (see coverage-pr06.ts).
  // Mistveil Plains: restored in coverage PR02. The interpreter reads the bottom-of-library
  // activation (graveyardToLibraryBottom) and its two-white-permanents condition.
  // Catalog audit queen-batch-1: power uses all graveyards, not opponents' graveyards.
  unsupportedCard(
    '379ed4ec-8f2e-448b-9ed2-a3181e2f877e',
    'Nighthawk Scavenger',
    "Power counts card types in all graveyards, not only opponents' graveyards.",
  );
  // Nils, Discipline Enforcer: restored in coverage PR07 (see coverage-pr07.ts).
  // Catalog audit queen-batch-1: threshold damage clause is claimed but not authored.
  unsupportedCard(
    'e6f2ba06-2c92-48b7-a95f-ea6bf35aa0fe',
    "Olórin's Searing Light",
    'Graveyard-threshold opponent damage is claimed without an implementation.',
  );
  // Catalog audit queen-batch-1: copyTargetSpell copies original targets.
  unsupportedCard(
    'a1f55890-31c5-4ed4-a2cd-7a4a9f05f8ca',
    'Reverberate',
    'Choose-new-targets is implemented as copyTargetSpell; a copy is not a retarget.',
  );
  // Catalog audit queen-batch-4: shuffle-then-top is move-to-top without shuffling.
  unsupportedCard(
    '6dfb50d7-359b-4644-90e3-7ecdacee7c12',
    'Scheming Symmetry',
    'Shuffle-then-put-on-top is implemented as moving the chosen card to the top without shuffling.',
  );
  defineCard(
    '34b90d3e-f48c-41ff-b3e4-5cab7a9cd597',
    'Secret Rendezvous',
    ['unrecognized rules text: "You and target opponent each draw three cards."'],
    SECRET_RENDEZVOUS,
  );
  // Selfless Squire: restored in coverage PR06 (see coverage-pr06.ts).
  // Catalog audit queen-batch-5: optional choose-two is mandatory; duplicate modes allowed.
  unsupportedCard(
    '2143f413-7baa-4fd6-a7ca-32f52bfa553f',
    'Shadrix Silverquill',
    'Optional choose-two is mandatory, and the same mode can be chosen twice.',
  );
  defineCard(
    '153376c9-dffd-458c-8ce3-a4c8269bc4e9',
    'Smothering Tithe',
    SMOTHERING_TITHE_HANDLED_LINES,
    SMOTHERING_TITHE_DEFINITION,
  );
  // Sunforger: restored in coverage PR05. The interpreter reads Equip {3} and the unattach
  // activation that casts a found instant for free, so no override remains.
  // Catalog audit queen-batch-1: mill/exile/cast cascade is claimed as counter only.
  unsupportedCard(
    '6623cb85-fb1e-4561-8b21-0977c25096c2',
    "Tibalt's Trickery",
    'Mill, exile, and free-cast cascade are claimed as a counter-only spell.',
  );
  // Leftover `triggers: []` here used to slip past applyOverride's "empty patch" guard (which
  // only checked Object.keys().length, not whether the values were actually empty) and silently
  // report this card as modeled with zero behavior. Converted to `unimplemented()`.
  // Catalog audit queen-batch-5: copy-activated-ability when life was paid is unimplemented.
  unsupportedCard(
    '04853f06-3fd2-445d-9b0d-d68d0f116635',
    'Verrak, Warped Sengir',
    'Copy-activated-ability when life was paid is unimplemented.',
  );
  // Weathered Wayfarer: restored in coverage PR02. The interpreter reads the revealed land search
  // and its "an opponent controls more lands than you" activation condition.
  // Catalog audit queen-batch-3: opponent-gains-control omitted.
  unsupportedCard(
    '81c70ae7-3c18-4c9b-8505-e4db9e0e6518',
    'Wishclaw Talisman',
    'Opponent-gains-control is omitted from the search activation.',
  );
  // Kambal, Consul of Allocation: restored in coverage PR03. The interpreter reads the
  // opponent-cast trigger and "that player loses 2 life and you gain 2 life", so no override remains.
  // Teyo, Geometric Tactician: restored in coverage PR07 (see coverage-pr07.ts).
}
