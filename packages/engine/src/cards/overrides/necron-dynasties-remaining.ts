/** Remaining authored overrides for necron-dynasties.txt. */

import { EXILE_SELF, TAP, activated, mana, manaCost, spell } from '../templates';
import { constant } from '../value';
import type { TokenSpec } from '../ability';
import { allOf, anyOf, ofType, not, SELF, YOURS } from '../selector';
import { defineCard, unsupportedCard } from './index';
import { INSECT_1_1_FLYING, NECRON_WARRIOR_2_2 as NECRON_WARRIOR_TOKEN } from '../tokens';

const NECRON: TokenSpec = NECRON_WARRIOR_TOKEN;

export function registerNECRON_DYNASTIES_REMAININGOverrides(): void {
  // Anrakyr the Traveller: restored in coverage PR02. The interpreter reads the attack trigger's
  // pay-life cast from hand or graveyard (castForLifeFromZones), so no override remains.
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
  // Canoptek Tomb Sentinel: restored in coverage PR03. The interpreter reads "enters from a
  // graveyard" and "exile up to one target nonland permanent", so no override remains.
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
  // Convergence of Dominion: restored in coverage PR02. The interpreter reads the conditional
  // graveyard activation reduction and the mill ability, so no override remains.
  // Cryptek: restored in coverage PR03. The interpreter reads the dies-this-turn delayed return,
  // which enters tapped, so no override remains.
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
  // Dread Return: restored in coverage PR02. The interpreter reads "Flashback—Sacrifice three
  // creatures" as a graveyard alternative cast, so no override remains.
  // Endless Atlas: restored in coverage PR02. The interpreter reads "Activate only if you control
  // three or more lands with the same name" as an activation condition, so no override remains.
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
  // Imotekh the Stormlord: restored in coverage PR03. The interpreter reads the leave-graveyard
  // token trigger and the combat buff, so no override remains.
  // Living Death: restored in coverage PR03. The interpreter reads the exile, the simultaneous
  // sacrifice, and the return, so no override remains.
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
  // Sautekh Immortal: restored in coverage PR04. The interpreter reads the enters-with
  // replacement counted from the creatures that died this turn, so no override remains.
  // Sceptre of Eternal Glory: restored in coverage PR02. The interpreter reads the three-mana
  // ability and its same-name-lands condition, so no override remains.
  defineCard(
    '6c85271c-c711-49b0-a72e-9e576c33714d',
    'Sculpting Steel',
    ['You may have this artifact enter as a copy of any artifact on the battlefield.'],
    { entersAsCopy: { selector: ofType('Artifact') } },
  );
  // Shard of the Nightbringer: restored in coverage PR03. The interpreter reads "if you cast it"
  // from the permanent's cast record and the targeted half-life drain, so no override remains.
  // Shard of the Void Dragon: restored in coverage PR03. The interpreter reads the attack edict
  // and the artifact graveyard-or-exile counters trigger, so no override remains.
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
  // Technomancer: restored in coverage PR03. The interpreter reads the mill and the capped
  // simultaneous return, so no override remains.
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
  // Their Number Is Legion: restored in coverage PR02. The interpreter reads the tapped tokens,
  // the artifact-count life gain, the self-exile and the graveyard cast permission.
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
  // Triarch Praetorian: restored in coverage PR03. The interpreter reads "enters from a
  // graveyard" as an origin-zone enters trigger, so no override remains.
  // Catalog audit necron-remaining-batch-3: chosen-opponent attackers is all in combat.
  unsupportedCard(
    '1b3ae9c3-1940-4fb8-a47c-2d9e1790f4a3',
    'Triarch Stalker',
    'Menace for attackers of the chosen opponent is implemented as all creatures in combat.',
  );
}
