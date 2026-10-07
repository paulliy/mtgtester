/** Remaining authored overrides for necron-dynasties.txt. */

import { EXILE_SELF, TAP, activated, mana, manaCost, spell } from '../templates';
import { constant } from '../value';
import type { TokenSpec } from '../ability';
import { allOf, anyOf, ofType, not, SELF, YOURS } from '../selector';
import { defineCard, unsupportedCard } from './index';
import { INSECT_1_1_FLYING, NECRON_WARRIOR_2_2 as NECRON_WARRIOR_TOKEN } from '../tokens';

const NECRON: TokenSpec = NECRON_WARRIOR_TOKEN;

export function registerNECRON_DYNASTIES_REMAININGOverrides(): void {
  // Catalog audit necron-remaining-batch-2: life-from-GY/hand is free hand casts.
  unsupportedCard(
    '32476743-c9d4-49ca-bec2-0669c215841b',
    'Anrakyr the Traveller',
    'Artifact-from-hand-or-graveyard life cast is implemented as free casts from hand.',
  );
  // Coverage PR01 (was contained by necron-remaining-batch-2): the resolving Beacon itself is shuffled into its owner's library.
  defineCard(
    'aef874fa-93c0-4f86-8b0d-dc24ec51467d',
    'Beacon of Unrest',
    [
      "Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle ~ into its owner's library.",
    ],
    {
      spellAbility: spell({
        targets: [
          {
            kind: 'cardInGraveyard',
            filter: anyOf(ofType('Artifact'), ofType('Creature')),
            graveyardOwnerScope: 'any',
          },
        ],
        effects: [
          { op: 'graveyardToBattlefield', target: 0 },
          { op: 'resolvingSpellShuffleIntoLibrary' },
        ],
      }),
    },
  );
  // Catalog audit necron-remaining-batch-4: type change omits spells and other zones.
  unsupportedCard(
    '5443557e-440f-4fdd-a29b-7740d7cec085',
    'Biotransference',
    'Type change omits creature spells and off-battlefield cards.',
  );
  // Catalog audit necron-remaining-batch-1: extra chosen-color mana is claimed, not authored.
  unsupportedCard(
    '09b895ff-e729-48d1-bfc1-ea5fd7adda6a',
    'Caged Sun',
    'Land-mana of the chosen color is claimed without an additional-mana trigger.',
  );
  defineCard(
    '5b7f6cc3-8d4e-42e5-a908-7ebe3bccaf1e',
    'Canoptek Scarab Swarm',
    [
      "Feeder Mandibles — When this creature enters, exile target player's graveyard. For each artifact or land card exiled this way, create a 1/1 colorless Insect artifact creature token with flying.",
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }],
          effects: [{ op: 'exileGraveyardCreateTokens', target: 0, spec: INSECT_1_1_FLYING }],
          description: 'Exile target player’s graveyard and create Insects',
        },
      ],
    },
  );
  // Catalog audit necron-remaining-batch-1: graveyard-origin enter is any enter.
  unsupportedCard(
    '678b3fb5-aa9f-4268-9433-2a89dd37b927',
    'Canoptek Tomb Sentinel',
    'Enters-from-graveyard is implemented as any enter, and up-to-one is a required target.',
  );
  // Coverage PR01 (was contained by necron-remaining-batch-2): the optional {3}-and-sacrifice
  // payment gates the choice of a land you control and a search for basics with its name.
  defineCard(
    '61849685-b407-4ed0-aafc-ec3a003200b9',
    'Canoptek Wraith',
    [
      "Wraith Form — ~ can't be blocked.",
      'Transdimensional Scout — When this creature deals combat damage to a player, you may pay {3} and sacrifice it. If you do, choose a land you control. Then search your library for up to two basic land cards which have the same name as the chosen land, put them onto the battlefield tapped, then shuffle.',
    ],
    {
      // An executable override turns off generic ability-label stripping, so the labelled
      // "can't be blocked" line is authored here too.
      staticEffects: [{ affects: SELF, op: { layer: 6, setCantBeBlocked: true } }],
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          targets: [],
          effects: [
            {
              op: 'mayPayManaAndSacrificeSource',
              cost: manaCost('{3}'),
              then: [
                {
                  op: 'searchBasicsNamedLikeChosenLand',
                  count: 2,
                  destination: { zone: 'battlefield', tapped: true },
                },
                { op: 'shuffle' },
              ],
            },
          ],
          description:
            'You may pay {3} and sacrifice this creature to fetch up to two basics named like a land you control',
        },
      ],
    },
  );
  // Catalog audit necron-remaining-batch-2: GY activation discount is claimed, not authored.
  unsupportedCard(
    '655aece2-f33a-46e0-8f80-112ae8a457fe',
    'Convergence of Dominion',
    'Graveyard activation cost reduction is claimed without a static effect.',
  );
  // Catalog audit necron-remaining-batch-7: Equip is dropped by activatedAbilities replace.
  unsupportedCard(
    '75564721-e4e9-463a-b49e-f0c7cd6f53a7',
    'Cranial Plating',
    'Equip {1} is dropped when the attach activation replaces activatedAbilities.',
  );
  // Catalog audit necron-remaining-batch-5: delayed return omits tapped.
  unsupportedCard(
    '27a4b633-5a62-4d8c-8cc6-44959c311de9',
    'Cryptek',
    'The delayed return omits entering tapped.',
  );
  defineCard(
    '932708ae-9d5c-4561-aa8b-0d2222d37fdc',
    'Darkness',
    ['Prevent all combat damage that would be dealt this turn.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'preventCombatDamageAll' }],
        description: 'Prevent all combat damage this turn',
      },
    },
  );
  // Catalog audit necron-remaining-batch-4: flashback claimed without a flashback alternative.
  unsupportedCard(
    '352b64d2-2ae5-44ee-a64f-94932ef545d3',
    'Dread Return',
    'Flashback—Sacrifice three creatures is claimed without a flashback alternative.',
  );
  // Endless Atlas: restored in coverage PR02. The interpreter reads "Activate only if you control
  // three or more lands with the same name" as an activation condition, so no override remains.
  // Catalog audit necron-remaining-batch-3: crewed is implemented as becomesTapped.
  unsupportedCard(
    'bb1b4786-3804-486b-9fd9-85848d24d362',
    'Ghost Ark',
    'Becomes-crewed is implemented as becomesTapped.',
  );
  // Catalog audit necron-remaining-batch-3: except-six-or-more is unconditional unblockable.
  unsupportedCard(
    'b3329240-c812-45ea-a7f8-4d79cd4ed515',
    'Hexmark Destroyer',
    'Cannot-be-blocked-except-by-six-or-more is implemented as cantBeBlocked.',
  );
  // Coverage PR02: a mana ability whose {T} and sacrifice are both costs (CR 605.1a), making {B}
  // equal to the sacrificed creature's mana value. The payment solver sees one source per
  // candidate creature (amountFromSacrificedManaValue), each pinned to that sacrifice.
  defineCard(
    '10f274f9-9044-447b-81c9-d4906ad9e6be',
    'Illuminor Szeras',
    [
      "Secrets of the Soul — {T}, Sacrifice another creature: Add an amount of {B} equal to the sacrificed creature's mana value.",
    ],
    {
      manaAbilities: [
        {
          units: [['B']],
          costs: [TAP, { kind: 'sacrificeOther', selector: allOf(ofType('Creature'), YOURS) }],
          amountFromSacrificedManaValue: true,
        },
      ],
    },
  );
  // Catalog audit necron-remaining-batch-3: leave-graveyard trigger claimed, not authored.
  unsupportedCard(
    '425fea06-76ec-4cd9-bd3b-750504fd7fd2',
    'Imotekh the Stormlord',
    'The artifact-cards-leave-graveyard trigger is claimed without an implementation.',
  );
  // Catalog audit necron-remaining-batch-8: battlefield creatures are not sacrificed.
  unsupportedCard(
    '9e6a3df4-67a3-452e-a6ef-f04dbadb21ef',
    'Living Death',
    'Battlefield creatures are put into graveyards instead of being sacrificed.',
  );
  defineCard(
    'fd03f20a-d365-48fb-8b2a-ad4b502a0045',
    'Lokhust Heavy Destroyer',
    [
      'Enmitic Exterminator — When this creature enters, each player sacrifices a creature of their choice.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'sacrificeOneCreatureEachPlayer' }],
          description: 'Each player sacrifices a creature',
        },
      ],
    },
  );
  // Catalog audit necron-remaining-batch-6: any equipped creature, not this equipment's creature.
  unsupportedCard(
    'd6b2c998-a226-426c-a40d-6e6007041bfe',
    'Mask of Memory',
    'Equipped-creature combat damage is implemented as any equipped creature.',
  );
  // Catalog audit necron-remaining-batch-3: colorless omitted; exile-top is mill.
  unsupportedCard(
    '994bc16d-fdc6-475c-96df-beeb4d5aa03e',
    'Mystic Forge',
    'Top-of-library cast omits colorless spells, and exile-top is implemented as mill.',
  );
  // Catalog audit necron-remaining-batch-4: up-to-one is a required target.
  // Coverage PR01: "up to one target creature" is a 0..1 count slot (count slots follow the
  // ordinary player slot), so the trigger can still target only a player.
  defineCard(
    '45866598-4ee4-46b6-ade2-ffcdbe98e58f',
    'Necron Deathmark',
    [
      'Synaptic Disintegrator — When this creature enters, destroy up to one target creature and target player mills three cards.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }, { kind: 'creature', count: { min: 0, max: 1 } }],
          effects: [
            { op: 'destroyEachChosen', targetSlot: 1 },
            { op: 'millTargetPlayer', target: 0, count: 3 },
          ],
          description: 'Destroy up to one target creature; target player mills three cards',
        },
      ],
    },
  );
  defineCard(
    '20932bca-52be-4288-9c7d-4154650c5ec9',
    'Necron Monolith',
    [
      'Eternity Gate — Whenever this Vehicle attacks, mill three cards. For each creature card milled this way, create a 2/2 black Necron Warrior artifact creature token.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'attacks', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'millAndCreateTokensForCreatures', spec: NECRON }],
          description: 'Mill three cards and create Necron Warriors for creature cards',
        },
      ],
    },
  );
  defineCard(
    '2c0de95f-4269-439c-a1bc-faa11348b185',
    'Necron Overlord',
    [
      'Relentless March — {X}, {T}, Tap X untapped artifacts you control: Target opponent loses X life.',
    ],
    {
      activatedAbilities: [
        {
          costs: [
            mana('{X}'),
            TAP,
            { kind: 'tapXOthers', selector: allOf(ofType('Artifact'), YOURS) },
          ],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'player', controller: 'opponent' }],
            effects: [{ op: 'loseLifeTarget', target: 0, amount: { kind: 'xValue' } }],
            description: '{X}, {T}, tap X artifacts: target opponent loses X life',
          },
        },
      ],
    },
  );
  // Catalog audit necron-remaining-batch-5: enters-with eon counters are not on the card.
  unsupportedCard(
    '473a7998-669d-4181-83fe-f178a2e781f0',
    'Out of the Tombs',
    'Enters-with two eon counters is authored; the card only places counters on upkeep.',
  );
  // Catalog audit necron-remaining-batch-5: return is not under the owner's control.
  unsupportedCard(
    'b410f294-cbb6-4016-981f-808fd9b7bbae',
    'Resurrection Orb',
    "Return is under the equipment controller, not the card's owner.",
  );
  // Catalog audit necron-remaining-batch-6: enters-with is an enters trigger.
  unsupportedCard(
    '7388a797-d40d-4783-a281-d17bc159b856',
    'Sautekh Immortal',
    'Enters-with counters is implemented as an enters trigger.',
  );
  // Sceptre of Eternal Glory: restored in coverage PR02. The interpreter reads the three-mana
  // ability and its same-name-lands condition, so no override remains.
  defineCard(
    '6c85271c-c711-49b0-a72e-9e576c33714d',
    'Sculpting Steel',
    ['You may have this artifact enter as a copy of any artifact on the battlefield.'],
    { entersAsCopy: { selector: ofType('Artifact') } },
  );
  // Catalog audit necron-remaining-batch-5: intervening if you-cast-it omitted.
  unsupportedCard(
    'eedd5a17-d0fe-4a13-8f2c-f343bfa43f92',
    'Shard of the Nightbringer',
    'The if-you-cast-it intervening if is omitted.',
  );
  // Catalog audit necron-remaining-batch-4: exile-from-battlefield omitted.
  unsupportedCard(
    'd04d2434-121e-4420-abfc-fa21ad5577c3',
    'Shard of the Void Dragon',
    'Exile-from-battlefield is omitted from the artifact-leaves trigger.',
  );
  defineCard(
    'f96fcb37-5f17-4231-b1a2-64f5fe45730b',
    'Skorpekh Destroyer',
    [
      'Hyperphase Threshers — Whenever an artifact you control enters, this creature gains first strike until end of turn.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(ofType('Artifact'), YOURS) },
          },
          targets: [],
          effects: [{ op: 'grantKeywordUntilEot', target: 'source', keyword: 'first strike' }],
          description: 'An artifact enters — gain first strike',
        },
      ],
    },
  );
  // Catalog audit necron-remaining-batch-5: milled-this-way Vehicle omitted; any GY artifact creature.
  unsupportedCard(
    '9a63f950-2e8a-4617-896c-1d0af538dbc7',
    'Szarekh, the Silent King',
    'Milled-this-way artifact-creature-or-Vehicle is implemented as any artifact creature in the graveyard.',
  );
  // Catalog audit necron-remaining-batch-9: 0-mana cards are blocked after remaining hits 0.
  unsupportedCard(
    '3f97541e-34f3-4f7f-8ac2-7167b2ec9b33',
    'Technomancer',
    'Zero-mana artifact creatures cannot be returned once remaining mana value hits 0.',
  );
  // Catalog audit necron-remaining-batch-4: saga chapters are wrong events.
  unsupportedCard(
    '5924cbb0-19b5-449c-a7c5-722e744a54f8',
    'The War in Heaven',
    'Saga chapters are implemented as enter, upkeep, and end-step triggers.',
  );
  defineCard(
    '97f9aa5e-e34d-4029-9213-b32ebaf9859c',
    'Their Name Is Death',
    ['Destroy all nonartifact creatures.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofType('Artifact'))) },
        ],
        description: 'Destroy all nonartifact creatures',
      },
    },
  );
  // Catalog audit necron-remaining-batch-4: tokens untapped; graveyard cast omitted.
  unsupportedCard(
    '8cd45064-2ad9-4247-902e-aefaf3bc1a43',
    'Their Number Is Legion',
    'Tokens are not created tapped, and graveyard cast is omitted.',
  );
  // Catalog audit necron-remaining-batch-7: combat-damage rider targets any player.
  unsupportedCard(
    'c857de66-f4e0-4e97-ad01-fac623af8225',
    'Tomb Blade',
    'Combat-damage life loss targets any player, not the damaged player.',
  );
  // Coverage PR01: the creature card is chosen on resolution, after the mill, with no target.
  defineCard(
    '986f510c-e2ec-423e-a443-51a169939558',
    'Tomb Fortress',
    [
      '{2}{B}{B}{B}, {T}, Exile this land: Mill four cards, then return a creature card from your graveyard to the battlefield. Activate only as a sorcery.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{2}{B}{B}{B}'), TAP, EXILE_SELF],
          timing: 'sorcery',
          targets: [],
          effects: [
            { op: 'mill', count: constant(4) },
            { op: 'returnOneFromYourGraveyardToBattlefield', filter: ofType('Creature') },
          ],
          description:
            'Mill four cards, then return a creature card from your graveyard to the battlefield',
        }),
      ],
    },
  );
  // Catalog audit necron-remaining-batch-6: graveyard mana abilities omitted.
  unsupportedCard(
    '1ef3b48a-55ef-422e-ac7f-e1c1057eec2c',
    'Trazyn the Infinite',
    'Activated mana abilities of artifacts in the graveyard are omitted.',
  );
  // Catalog audit necron-remaining-batch-3: graveyard-origin enter is any enter.
  unsupportedCard(
    '52aa5a79-db0e-4eaa-b2df-e41674c47794',
    'Triarch Praetorian',
    'Enters-from-graveyard is implemented as any enter.',
  );
  // Catalog audit necron-remaining-batch-3: chosen-opponent attackers is all in combat.
  unsupportedCard(
    '1b3ae9c3-1940-4fb8-a47c-2d9e1790f4a3',
    'Triarch Stalker',
    'Menace for attackers of the chosen opponent is implemented as all creatures in combat.',
  );
}
