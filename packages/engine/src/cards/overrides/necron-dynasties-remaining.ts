/** Remaining authored overrides for necron-dynasties.txt. */

import type { CardDefinition } from '../definition';
import type { TokenSpec } from '../ability';
import { parseManaCost } from '../../mana/cost';
import { constant } from '../value';
import { allOf, CHOSEN_COLOR, HAS_ANY_COUNTER, IS_TOKEN, OTHER, ofSubtype, ofSupertype, ofType, not, YOURS } from '../selector';
import { registerRemainingOverride, NECRON_WARRIOR_TOKEN } from './remaining-common';

const M = (cost: string) => ({ kind: 'mana' as const, cost: parseManaCost(cost).cost! });
const TAP = { kind: 'tap' as const };
const NECRON: TokenSpec = NECRON_WARRIOR_TOKEN;
const INSECT: TokenSpec = { name: 'Insect', typeLine: 'Artifact Creature — Insect', types: ['Artifact', 'Creature'], subtypes: ['Insect'], colors: [], power: 1, toughness: 1, keywords: ['flying'] };

export function registerNECRON_DYNASTIES_REMAININGOverrides(): void {
  registerRemainingOverride('32476743-c9d4-49ca-bec2-0669c215841b', 'Anrakyr the Traveller', [
    'Lord of the Pyrrhian Legions — Whenever ~ attacks, you may cast an artifact spell from your hand or graveyard by paying life equal to its mana value rather than paying its mana cost.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'castAnyFromHandFree' }], description: 'Whenever Anrakyr attacks — cast an artifact spell by paying life' }] });
  registerRemainingOverride('aef874fa-93c0-4f86-8b0d-dc24ec51467d', 'Beacon of Unrest', [
    'Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle ~ into its owner\'s library.',
  ], { spellAbility: { kind: 'spell', targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'any', filter: { kind: 'anyOf', of: [ofType('Artifact'), ofType('Creature')] } }], effects: [{ op: 'graveyardToBattlefield', target: 0 }, { op: 'shuffle' }], description: 'Return target artifact or creature card from a graveyard' } });
  registerRemainingOverride('5443557e-440f-4fdd-a29b-7740d7cec085', 'Biotransference', [
    'Creatures you control are artifacts in addition to their other types. The same is true for creature spells you control and creature cards you own that aren\'t on the battlefield.', 'Whenever you cast an artifact spell, you lose 1 life and create a 2/2 black Necron Warrior artifact creature token.',
  ], { staticEffects: [{ affects: allOf(ofType('Creature'), YOURS), op: { layer: 4, addTypes: ['Artifact'] } }], triggers: [{ kind: 'triggered', trigger: { when: 'castsSpell', caster: 'you', filter: ofType('Artifact') }, targets: [], effects: [{ op: 'loseLife', amount: constant(1) }, { op: 'createToken', spec: NECRON, count: constant(1) }], description: 'Cast an artifact — lose 1 life and create a Necron Warrior' }] });
  registerRemainingOverride('09b895ff-e729-48d1-bfc1-ea5fd7adda6a', 'Caged Sun', [
    'As this artifact enters, choose a color.',
    'Creatures you control of the chosen color get +1/+1.',
    'Whenever a land\'s ability causes you to add one or more mana of the chosen color, add an additional one mana of that color.',
  ], { entersChoosingOption: { prompt: 'Choose a color', options: [{ key: 'W', label: 'White' }, { key: 'U', label: 'Blue' }, { key: 'B', label: 'Black' }, { key: 'R', label: 'Red' }, { key: 'G', label: 'Green' }] }, staticEffects: [{ affects: allOf(ofType('Creature'), YOURS, CHOSEN_COLOR), op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 } }] });
  registerRemainingOverride('5b7f6cc3-8d4e-42e5-a908-7ebe3bccaf1e', 'Canoptek Scarab Swarm', [
    'Feeder Mandibles — When this creature enters, exile target player\'s graveyard. For each artifact or land card exiled this way, create a 1/1 colorless Insect artifact creature token with flying.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'player' }], effects: [{ op: 'exileGraveyardCreateTokens', target: 0, spec: INSECT }], description: 'Exile target player’s graveyard and create Insects' }] });
  registerRemainingOverride('678b3fb5-aa9f-4268-9433-2a89dd37b927', 'Canoptek Tomb Sentinel', [
    'Exile Cannon — When this creature enters from a graveyard, exile up to one target nonland permanent.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'nonlandPermanent' }], effects: [{ op: 'exile', target: 0 }], description: 'Exile target nonland permanent' }] });
  registerRemainingOverride('61849685-b407-4ed0-aafc-ec3a003200b9', 'Canoptek Wraith', [
    'Wraith Form — ~ can\'t be blocked.', 'Transdimensional Scout — When this creature deals combat damage to a player, you may pay {3} and sacrifice it. If you do, choose a land you control. Then search your library for up to two basic land cards which have the same name as the chosen land, put them onto the battlefield tapped, then shuffle.',
  ], { cantBeBlocked: true, triggers: [{ kind: 'triggered', trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'conditionalEffect', condition: { kind: 'mayPayMana', cost: parseManaCost('{3}').cost! }, then: [{ op: 'sacrifice', target: 'source' }, { op: 'searchLibrary', filter: ofSupertype('Basic'), destinations: [{ zone: 'battlefield', tapped: true }, { zone: 'battlefield', tapped: true }] }, { op: 'shuffle' }], else: [] }], description: 'Pay {3} and sacrifice — search for two basic lands' }] });
  registerRemainingOverride('655aece2-f33a-46e0-8f80-112ae8a457fe', 'Convergence of Dominion', [
    'Dynastic Command Node — As long as you control your commander, activated abilities of cards in your graveyard cost {2} less to activate. This effect can\'t reduce the mana in that ability\'s activation cost to less than one mana.', 'Translocation Protocols — {3}, {T}: Mill three cards.',
  ], { activatedAbilities: [{ costs: [M('{3}'), TAP], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'mill', count: constant(3) }], description: '{3}, {T}: Mill three cards' } }] });
  registerRemainingOverride('75564721-e4e9-463a-b49e-f0c7cd6f53a7', 'Cranial Plating', [
    'Equipped creature gets +1/+0 for each artifact you control.', '{B}{B}: Attach this Equipment to target creature you control.',
  ], { staticEffects: [{ affects: { kind: 'attachedToSource' }, op: { layer: 7, sublayer: 'd', power: { kind: 'countPermanents', selector: ofType('Artifact'), scope: 'you' }, toughness: 0 } }], activatedAbilities: [{ costs: [M('{B}{B}')], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'creature', controller: 'you' }], effects: [{ op: 'attachSelfTo', target: 0 }], description: '{B}{B}: Attach Cranial Plating' } }] });
  registerRemainingOverride('27a4b633-5a62-4d8c-8cc6-44959c311de9', 'Cryptek', [
    '{1}{B}, {T}: Choose another target artifact creature you control. When that creature dies this turn, return it to the battlefield tapped under your control.',
  ], { activatedAbilities: [{ costs: [M('{1}{B}'), TAP], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'creature', controller: 'you', filter: allOf(OTHER, ofType('Artifact')) }], effects: [{ op: 'registerDelayedTrigger', when: 'dies', expiry: 'cleanup', target: 0, controller: 'targetController', ability: { kind: 'triggered', targets: [], effects: [{ op: 'graveyardToBattlefield', target: 'triggerObject' }], description: 'Return that creature tapped' } }], description: 'Return the chosen artifact creature if it dies this turn' } }] });
  registerRemainingOverride('932708ae-9d5c-4561-aa8b-0d2222d37fdc', 'Darkness', [
    'Prevent all combat damage that would be dealt this turn.',
  ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'preventCombatDamageAll' }], description: 'Prevent all combat damage this turn' } });
  registerRemainingOverride('352b64d2-2ae5-44ee-a64f-94932ef545d3', 'Dread Return', [
    'Flashback—Sacrifice three creatures.',
  ], { spellAbility: { kind: 'spell', targets: [{ kind: 'cardInGraveyard', filter: ofType('Creature') }], effects: [{ op: 'graveyardToBattlefield', target: 0 }], description: 'Return target creature card from your graveyard' } });
  registerRemainingOverride('cb923c4d-1d2e-4039-90bb-72d1981b9738', 'Endless Atlas', [
    '{2}, {T}: Draw a card. Activate only if you control three or more lands with the same name.',
  ], { activatedAbilities: [{ costs: [M('{2}'), TAP], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'draw', count: constant(1) }], description: '{2}, {T}: Draw a card' } }] });
  registerRemainingOverride('bb1b4786-3804-486b-9fd9-85848d24d362', 'Ghost Ark', [
    'Repair Barge — Whenever this Vehicle becomes crewed, each artifact creature card in your graveyard gains unearth {3} until end of turn.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'becomesTapped', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'grantUnearthToArtifactCreaturesInGraveyard', cost: parseManaCost('{3}').cost! }], description: 'Artifact creature cards in your graveyard gain unearth {3} until end of turn' }] });
  registerRemainingOverride('b3329240-c812-45ea-a7f8-4d79cd4ed515', 'Hexmark Destroyer', [
    'Multi-threat Eliminator — ~ can\'t be blocked except by six or more creatures.',
  ], { cantBeBlocked: true });
  registerRemainingOverride('10f274f9-9044-447b-81c9-d4906ad9e6be', 'Illuminor Szeras', [
    'Secrets of the Soul — {T}, Sacrifice another creature: Add an amount of {B} equal to the sacrificed creature\'s mana value.',
  ], { activatedAbilities: [{ costs: [TAP], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'sacrificeOtherForMana' }], description: '{T}, sacrifice another creature: add black mana equal to its mana value' } }] });
  registerRemainingOverride('425fea06-76ec-4cd9-bd3b-750504fd7fd2', 'Imotekh the Stormlord', [
    'Phaeron — Whenever one or more artifact cards leave your graveyard, create two 2/2 black Necron Warrior artifact creature tokens.', 'Grand Strategist — At the beginning of combat on your turn, another target artifact creature you control gets +2/+2 and gains menace until end of turn.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'beginningOfCombat', player: 'you' }, targets: [{ kind: 'creature', controller: 'you', filter: allOf(OTHER, ofType('Artifact')) }], effects: [{ op: 'pumpUntilEot', target: 0, power: 2, toughness: 2 }, { op: 'grantKeywordUntilEot', target: 0, keyword: 'menace' }], description: 'Another artifact creature gets +2/+2 and menace' }] });
  registerRemainingOverride('9e6a3df4-67a3-452e-a6ef-f04dbadb21ef', 'Living Death', [
    'Each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield.',
  ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'livingDeath' }], description: 'Exile graveyard creatures, sacrifice creatures, then return them' } });
  registerRemainingOverride('fd03f20a-d365-48fb-8b2a-ad4b502a0045', 'Lokhust Heavy Destroyer', [
    'Enmitic Exterminator — When this creature enters, each player sacrifices a creature of their choice.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'sacrificeOneCreatureEachPlayer' }], description: 'Each player sacrifices a creature' }] });
  registerRemainingOverride('d6b2c998-a226-426c-a40d-6e6007041bfe', 'Mask of Memory', [
    'Whenever equipped creature deals combat damage to a player, you may draw two cards. If you do, discard a card.',
  ], { triggers: [{ kind: 'triggered', optional: true, trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'permanent', selector: { kind: 'isEquipped' } } }, targets: [], effects: [{ op: 'draw', count: constant(2) }, { op: 'discard', count: 1 }], description: 'Draw two cards, then discard a card' }] });
  registerRemainingOverride('2549bc57-9ffb-4053-9f10-f2a5f792b845', 'Myriad Landscape', [
    '{2}, {T}, Sacrifice this land: Search your library for up to two basic land cards that share a land type, put them onto the battlefield tapped, then shuffle.',
  ], { activatedAbilities: [{ costs: [M('{2}'), TAP, { kind: 'sacrificeSelf' }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'searchLibrary', filter: ofSupertype('Basic'), destinations: [{ zone: 'battlefield', tapped: true }, { zone: 'battlefield', tapped: true }] }, { op: 'shuffle' }], description: 'Search for up to two basic lands' } }] });
  registerRemainingOverride('994bc16d-fdc6-475c-96df-beeb4d5aa03e', 'Mystic Forge', [
    'You may cast artifact spells and colorless spells from the top of your library.', '{T}, Pay 1 life: Exile the top card of your library.',
  ], { ruleStatics: [{ kind: 'castFromZone', zone: 'libraryTop', filter: ofType('Artifact') }], activatedAbilities: [{ costs: [TAP, { kind: 'payLife', amount: 1 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'mill', count: constant(1) }], description: 'Exile the top card of your library' } }] });
  registerRemainingOverride('45866598-4ee4-46b6-ade2-ffcdbe98e58f', 'Necron Deathmark', [
    'Synaptic Disintegrator — When this creature enters, destroy up to one target creature and target player mills three cards.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'creature' }, { kind: 'player' }], effects: [{ op: 'destroy', target: 0 }, { op: 'millTargetPlayer', target: 1, count: 3 }], description: 'Destroy a creature and mill a player three cards' }] });
  registerRemainingOverride('20932bca-52be-4288-9c7d-4154650c5ec9', 'Necron Monolith', [
    'Eternity Gate — Whenever this Vehicle attacks, mill three cards. For each creature card milled this way, create a 2/2 black Necron Warrior artifact creature token.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'millAndCreateTokensForCreatures', spec: NECRON }], description: 'Mill three cards and create Necron Warriors for creature cards' }] });
  registerRemainingOverride('2c0de95f-4269-439c-a1bc-faa11348b185', 'Necron Overlord', [
    'Relentless March — {X}, {T}, Tap X untapped artifacts you control: Target opponent loses X life.',
  ], { activatedAbilities: [{ costs: [M('{X}'), TAP, { kind: 'tapXOthers', selector: allOf(ofType('Artifact'), YOURS) }], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'player', controller: 'opponent' }], effects: [{ op: 'loseLifeTarget', target: 0, amount: { kind: 'xValue' } }], description: '{X}, {T}, tap X artifacts: target opponent loses X life' } }] });
  registerRemainingOverride('473a7998-669d-4181-83fe-f178a2e781f0', 'Out of the Tombs', [
    'At the beginning of your upkeep, put two eon counters on this enchantment, then mill cards equal to the number of eon counters on it.', 'If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can\'t, you lose the game.',
  ], { emptyLibraryCreatureReplacement: true, entersWithCounters: { eon: 2 }, triggers: [{ kind: 'triggered', trigger: { when: 'upkeep', player: 'you' }, targets: [], effects: [{ op: 'putCounters', target: 'source', counter: 'eon', count: 2 }, { op: 'mill', count: { kind: 'countersOnSelf', counter: 'eon' } }], description: 'Put on eon counters, then mill equal to them' }] });
  registerRemainingOverride('589b742c-fe5-413a-a56c-4d4ffaf0f73d', 'Psychomancer', [
    'Harbinger of Despair \u2014 Whenever this creature or another nontoken artifact you control is put into a graveyard from the battlefield or is put into exile from the battlefield, target opponent loses 1 life and you gain 1 life.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Artifact'), not(IS_TOKEN), YOURS) } }, targets: [{ kind: 'player' }], effects: [{ op: 'loseLife', amount: constant(1) }, { op: 'gainLife', amount: constant(1) }], description: 'An artifact leaves — target opponent loses 1 and you gain 1' }] });
  registerRemainingOverride('b410f294-cbb6-4016-981f-808fd9b7bbae', 'Resurrection Orb', [
    'Whenever equipped creature dies, return that card to the battlefield under its owner\'s control at the beginning of the next end step.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: { kind: 'isEquipped' } } }, targets: [], effects: [{ op: 'registerDelayedTrigger', when: 'endStep', expiry: 'endStep', target: 'triggerObject', controller: 'targetController', ability: { kind: 'triggered', targets: [], effects: [{ op: 'graveyardToBattlefield', target: 'triggerObject' }], description: 'Return the equipped creature' } }], description: 'Return the equipped creature at the next end step' }] });
  registerRemainingOverride('7388a797-d40d-4783-a281-d17bc159b856', 'Sautekh Immortal', [
    'Elite Troops — ~ enters with a +1/+1 counter on it for each creature that died this turn.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: { kind: 'creaturesDiedThisTurn' } }], description: 'Enters with a counter for each creature that died this turn' }] });
  registerRemainingOverride('ce08aff3-efe6-4186-9557-274e00a7ca38', 'Sceptre of Eternal Glory', [
    'unsupported mana production: "{T}: Add three mana of any one color. Activate only if you control three or more lands with the same name."',
  ], { manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G']], linked: true }] });
  registerRemainingOverride('6c85271c-c711-49b0-a72e-9e576c33714d', 'Sculpting Steel', [
    'You may have this artifact enter as a copy of any artifact on the battlefield.',
  ], { entersAsCopy: { target: 'artifact' } });
  registerRemainingOverride('eedd5a17-d0fe-4a13-8f2c-f343bfa43f92', 'Shard of the Nightbringer', [
    'Drain Life — When this creature enters, if you cast it, target opponent loses half their life, rounded up. You gain life equal to the life lost this way.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'halfLifeDrainTargetOpponent' }], description: 'An opponent loses half their life and you gain that much' }] });
  registerRemainingOverride('d04d2434-121e-4420-abfc-fa21ad5577c3', 'Shard of the Void Dragon', [
    'Spear of the Void Dragon — Whenever this creature attacks, each opponent sacrifices a nonland permanent of their choice.', 'Matter Absorption — Whenever an artifact is put into a graveyard from the battlefield or is put into exile from the battlefield, put two +1/+1 counters on this creature.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'sacrificeOneEachOpponent' }], description: 'Each opponent sacrifices a nonland permanent' }, { kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: ofType('Artifact') } }, targets: [], effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 2 }], description: 'An artifact leaves — put two counters on Shard' }] });
  registerRemainingOverride('f96fcb37-5f17-4231-b1a2-64f5fe45730b', 'Skorpekh Destroyer', [
    'Hyperphase Threshers — Whenever an artifact you control enters, this creature gains first strike until end of turn.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Artifact'), YOURS) } }, targets: [], effects: [{ op: 'grantKeywordUntilEot', target: 'source', keyword: 'first strike' }], description: 'An artifact enters — gain first strike' }] });
  registerRemainingOverride('9a63f950-2e8a-4617-896c-1d0af538dbc7', 'Szarekh, the Silent King', [
    'My Will Be Done — Whenever ~ attacks, mill three cards. You may put an artifact creature card or Vehicle card from among the cards milled this way into your hand.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'millAndChooseArtifact' }], description: 'Mill three cards and return an artifact creature if desired' }] });
  registerRemainingOverride('3f97541e-34f3-4f7f-8ac2-7167b2ec9b33', 'Technomancer', [
    'When this creature enters, mill three cards, then return any number of artifact creature cards with total mana value 6 or less from your graveyard to the battlefield.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'mill', count: constant(3) }, { op: 'returnArtifactCreaturesUpToManaValue', maxManaValue: 6 }], description: 'Mill three, then return artifact creatures with total mana value six or less' }] });
  registerRemainingOverride('5924cbb0-19b5-449c-a7c5-722e744a54f8', 'The War in Heaven', [
    'unsupported layout "saga"', 'I — You draw three cards and you lose 3 life.', 'II — Mill three cards.', 'III — Choose up to three target creature cards with total mana value 8 or less in your graveyard. Return each of them to the battlefield with a necrodermis counter on it. They\'re artifacts in addition to their other types.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'draw', count: constant(3) }, { op: 'loseLife', amount: constant(3) }], description: 'Chapter I — draw three and lose three' }, { kind: 'triggered', trigger: { when: 'upkeep', player: 'you' }, targets: [], effects: [{ op: 'mill', count: constant(3) }], description: 'Chapter II — mill three' }, { kind: 'triggered', trigger: { when: 'endStep', player: 'you' }, targets: [], effects: [{ op: 'returnArtifactCreaturesUpToManaValue', maxManaValue: 8 }], description: 'Chapter III — return artifact creatures' }] });
  registerRemainingOverride('97f9aa5e-e34d-4029-9213-b32ebaf9859c', 'Their Name Is Death', [
    'Destroy all nonartifact creatures.',
  ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofType('Artifact'))) }], description: 'Destroy all nonartifact creatures' } });
  registerRemainingOverride('8cd45064-2ad9-4247-902e-aefaf3bc1a43', 'Their Number Is Legion', [
    'Create X tapped 2/2 black Necron Warrior artifact creature tokens, then you gain life equal to the number of artifacts you control. Exile ~.', 'You may cast this card from your graveyard.',
  ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'createToken', spec: NECRON, count: { kind: 'xValue' }, }, { op: 'gainLife', amount: { kind: 'countPermanents', selector: ofType('Artifact'), scope: 'you' } }, { op: 'exileResolvingSpell' }], description: 'Create X Necron Warriors and gain life equal to your artifacts' } });
  registerRemainingOverride('c857de66-f4e0-4e97-ad01-fac623af8225', 'Tomb Blade', [
    'Whenever this creature deals combat damage to a player, that player loses life equal to the number of creatures they control unless they sacrifice a creature of their choice.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } }, targets: [{ kind: 'player' }], effects: [{ op: 'tombBladeHit', target: 0 }], description: 'The damaged player sacrifices a creature or loses life' }] });
  registerRemainingOverride('986f510c-e2ec-423e-a443-51a169939558', 'Tomb Fortress', [
    '{2}{B}{B}{B}, {T}, Exile this land: Mill four cards, then return a creature card from your graveyard to the battlefield. Activate only as a sorcery.',
  ], { activatedAbilities: [{ costs: [M('{2}{B}{B}{B}'), TAP, { kind: 'exileSelf' }], timing: 'sorcery', ability: { kind: 'activated', targets: [{ kind: 'cardInGraveyard', filter: ofType('Creature') }], effects: [{ op: 'mill', count: constant(4) }, { op: 'graveyardToBattlefield', target: 0 }], description: 'Mill four, then return a creature from your graveyard' } }] });
  registerRemainingOverride('1ef3b48a-55ef-4221-a0bc-e1c1057eec2c', 'Trazyn the Infinite', [
    'Prismatic Gallery \u2014 As long as ~ is on the battlefield, it has all activated abilities of all artifact cards in your graveyard.',
  ], { artifactGraveyardAbilities: true });
  registerRemainingOverride('52aa5a79-db0e-4eaa-b2df-e41674c47794', 'Triarch Praetorian', [
    'Dynastic Codes — When this creature enters from a graveyard, you draw two cards and you lose 2 life.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'draw', count: constant(2) }, { op: 'loseLife', amount: constant(2) }], description: 'Draw two cards and lose 2 life' }] });
  registerRemainingOverride('1b3ae9c3-1940-4fb8-a47c-2d9e1790f4a3', 'Triarch Stalker', [
    'Targeting Relay — At the beginning of combat on your turn, choose an opponent.', 'Creatures attacking the last chosen player have menace.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'beginningOfCombat', player: 'you' }, targets: [], effects: [{ op: 'grantKeywordEachUntilEot', selector: allOf(ofType('Creature'), { kind: 'inCombat' }), keyword: 'menace' }], description: 'Creatures attacking the chosen opponent have menace' }] });
}
