import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig } from '@mtg/engine';
import { NO_BLOCK_TARGET } from '@mtg/shared';
import type { Color, GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

type Pin = { sha256: string; card: OracleCard };
const pins = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/engine/tests/fixtures/coverage-pr09-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: Pin[] }
).cards;
for (const pin of pins)
  if (createHash('sha256').update(JSON.stringify(pin.card)).digest('hex') !== pin.sha256)
    throw new Error(`PR09 Oracle pin drift: ${pin.card.name}`);
const pin = (name: string): Pin => {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing PR09 Oracle pin ${name}`);
  return found;
};
const basics = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];
const basic = (name: string) => {
  const found = basics.find((card) => card.name === name);
  if (!found) throw new Error(`Missing supporting Oracle card ${name}`);
  return found;
};
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const cases = [
  [
    'path-of-discovery',
    'Path of Discovery',
    'positive',
    'Path of Discovery: a creature explores a land into hand',
    ['Whenever a creature you control enters, it explores.'],
  ],
  [
    'path-of-discovery',
    'Path of Discovery',
    'negative',
    'Path of Discovery: an entering noncreature does not explore',
    ['Whenever a creature you control enters, it explores.'],
  ],
  [
    'lurking-predators',
    'Lurking Predators',
    'positive',
    'Lurking Predators: an opponent casts and a creature is revealed',
    [
      "Whenever an opponent casts a spell, reveal the top card of your library. If it's a creature card, put it onto the battlefield. Otherwise, you may put that card on the bottom of your library.",
    ],
  ],
  [
    'lurking-predators',
    'Lurking Predators',
    'negative',
    'Lurking Predators: your own spell does not trigger it',
    [
      "Whenever an opponent casts a spell, reveal the top card of your library. If it's a creature card, put it onto the battlefield. Otherwise, you may put that card on the bottom of your library.",
    ],
  ],
  [
    'new-generation-s-technique',
    "New Generation's Technique",
    'positive',
    "New Generation's Technique: search for two basics",
    [
      'Sneak {2}{G}',
      'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
    ],
  ],
  [
    'new-generation-s-technique',
    "New Generation's Technique",
    'negative',
    "New Generation's Technique: insufficient mana leaves it uncast",
    [
      'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
    ],
  ],
  [
    'new-generation-s-technique',
    "New Generation's Technique",
    'sneak-positive',
    "New Generation's Technique: Sneak returns an unblocked attacker and searches",
    [
      'Sneak {2}{G}',
      'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
    ],
  ],
  [
    'new-generation-s-technique',
    "New Generation's Technique",
    'sneak-negative',
    "New Generation's Technique: Sneak is unavailable outside declare blockers",
    ['Sneak {2}{G}'],
  ],
  [
    'celebrate-the-mountain-king',
    'Celebrate the Mountain-king',
    'positive',
    'Celebrate: recruit after discarding a nonland card',
    ['When this enchantment enters, recruit.'],
  ],
  [
    'celebrate-the-mountain-king',
    'Celebrate the Mountain-king',
    'negative',
    'Celebrate: a discarded land does not create a Soldier',
    ['When this enchantment enters, recruit.'],
  ],
  [
    'celebrate-the-mountain-king',
    'Celebrate the Mountain-king',
    'exile-positive',
    'Celebrate: exile an opponent permanent, then return it when the source leaves',
    [
      'When this enchantment enters, for each opponent, exile up to one target nonland permanent that player controls until this enchantment leaves the battlefield.',
    ],
  ],
  [
    'celebrate-the-mountain-king',
    'Celebrate the Mountain-king',
    'exile-negative',
    'Celebrate: remove the source before its target can be exiled',
    [
      'When this enchantment enters, for each opponent, exile up to one target nonland permanent that player controls until this enchantment leaves the battlefield.',
    ],
  ],
  [
    'rabble-rousing',
    'Rabble Rousing',
    'positive',
    'Rabble: hide away a card and attack to create a Citizen',
    [
      'Hideaway 5',
      'Whenever you attack with one or more creatures, create that many 1/1 green and white Citizen creature tokens. Then if you control ten or more creatures, you may play the exiled card without paying its mana cost.',
    ],
  ],
  [
    'rabble-rousing',
    'Rabble Rousing',
    'negative',
    'Rabble: no declared attackers creates no Citizen',
    [
      'Whenever you attack with one or more creatures, create that many 1/1 green and white Citizen creature tokens. Then if you control ten or more creatures, you may play the exiled card without paying its mana cost.',
    ],
  ],
  [
    'tibalt-s-trickery',
    "Tibalt's Trickery",
    'positive',
    'Trickery: counter a spell and cast the different revealed card',
    [
      'Counter target spell. Choose 1, 2, or 3 at random. Its controller mills that many cards, then exiles cards from the top of their library until they exile a nonland card with a different name than that spell. They may cast that card without paying its mana cost. Then they put the exiled cards on the bottom of their library in a random order.',
    ],
  ],
  [
    'tibalt-s-trickery',
    "Tibalt's Trickery",
    'negative',
    'Trickery: counter the target and decline the revealed card',
    [
      'Counter target spell. Choose 1, 2, or 3 at random. Its controller mills that many cards, then exiles cards from the top of their library until they exile a nonland card with a different name than that spell. They may cast that card without paying its mana cost. Then they put the exiled cards on the bottom of their library in a random order.',
    ],
  ],
  [
    'grenzo-havoc-raiser',
    'Grenzo, Havoc Raiser',
    'positive',
    'Grenzo: attack trigger exiles and lets you cast the top card',
    [
      'Whenever a creature you control deals combat damage to a player, choose one —',
      "• Exile the top card of that player's library. Until end of turn, you may cast that card and you may spend mana as though it were mana of any color to cast that spell.",
    ],
  ],
  [
    'grenzo-havoc-raiser',
    'Grenzo, Havoc Raiser',
    'negative',
    'Grenzo: attacking with no creature leaves it unable to trigger',
    ['Whenever a creature you control deals combat damage to a player, choose one —'],
  ],
  [
    'grenzo-havoc-raiser',
    'Grenzo, Havoc Raiser',
    'goad',
    'Grenzo: attack trigger goads an opponent creature',
    [
      'Whenever a creature you control deals combat damage to a player, choose one —',
      '• Goad target creature that player controls.',
    ],
  ],
  [
    'power-pack',
    'Power Pack',
    'positive',
    'Power Pack: deal combat damage, cast the delayed spell, then exile it',
    [
      'Flying, vigilance, trample, haste',
      'Whenever Power Pack deals combat damage to a player, exile target instant or sorcery card from your graveyard chosen at random. At the beginning of your next upkeep, you may cast that card without paying its mana cost. If that spell would be put into your graveyard, exile it instead.',
    ],
  ],
  [
    'power-pack',
    'Power Pack',
    'negative',
    'Power Pack: no eligible graveyard spell means no delayed cast',
    [
      'Whenever Power Pack deals combat damage to a player, exile target instant or sorcery card from your graveyard chosen at random. At the beginning of your next upkeep, you may cast that card without paying its mana cost. If that spell would be put into your graveyard, exile it instead.',
    ],
  ],
  [
    'improvisation-capstone',
    'Improvisation Capstone',
    'positive',
    'Capstone: cast a revealed spell, then cast a Paradigm copy next main',
    [
      'Exile cards from the top of your library until you exile cards with total mana value 4 or greater. You may cast any number of spells from among them without paying their mana costs.',
      'Paradigm',
    ],
  ],
  [
    'improvisation-capstone',
    'Improvisation Capstone',
    'negative',
    'Capstone: decline revealed cards and retain the Paradigm copy',
    [
      'Exile cards from the top of your library until you exile cards with total mana value 4 or greater. You may cast any number of spells from among them without paying their mana costs.',
      'Paradigm',
    ],
  ],
] as const;

export const PR09_CHOICE_SCENARIOS = cases.map(([slugPart, cardName, variant, title]) => ({
  id: `pr09-${slugPart}-viewer-${variant}`,
  title,
  cardName,
}));

const instructions: Record<string, string[]> = {
  'pr09-path-of-discovery-viewer-positive': [
    'Cast Path of Discovery for {3}{G}.',
    'Cast the prepared 2/2 creature from your hand.',
    'Confirm the entering creature explores the prepared Forest into your hand.',
  ],
  'pr09-path-of-discovery-viewer-negative': [
    'Cast Path of Discovery for {3}{G}.',
    'Cast the prepared artifact.',
    'Confirm the noncreature entry does not reveal a card or create an explore result.',
  ],
  'pr09-lurking-predators-viewer-positive': [
    'Cast Lurking Predators for {4}{G}{G}.',
    'Pass through the turn until P2 casts the prepared instant.',
    'Confirm the revealed creature is public and enters the battlefield.',
  ],
  'pr09-lurking-predators-viewer-negative': [
    'Cast Lurking Predators for {4}{G}{G}.',
    'Cast your prepared instant.',
    'Confirm your own spell does not cause a reveal.',
  ],
  'pr09-new-generation-s-technique-viewer-positive': [
    "Cast New Generation's Technique normally for {3}{G}.",
    'Choose two basic lands from your library.',
    'Confirm both enter tapped and your library is shuffled.',
  ],
  'pr09-new-generation-s-technique-viewer-negative': [
    "With only two mana available, check that New Generation's Technique has no legal cast action.",
  ],
  'pr09-new-generation-s-technique-viewer-sneak-positive': [
    'Attack with PR09 Sneak Attacker and let it go unblocked.',
    "During declare blockers, cast New Generation's Technique with Sneak for {2}{G}.",
    'Return the unblocked attacker to your hand as the Sneak cost, then search for two basics.',
  ],
  'pr09-new-generation-s-technique-viewer-sneak-negative': [
    "In your precombat main phase, click New Generation's Technique and confirm its Sneak cast is not offered.",
  ],
  'pr09-celebrate-the-mountain-king-viewer-positive': [
    'Cast Celebrate the Mountain-king for {2}{W}{W}.',
    'Choose the ETB trigger order so Recruit resolves first.',
    'Recruit: draw the prepared card and discard the nonland card.',
    'Confirm a 1/1 white Human Soldier is created.',
  ],
  'pr09-celebrate-the-mountain-king-viewer-negative': [
    'Cast Celebrate the Mountain-king for {2}{W}{W}.',
    'Choose the ETB trigger order so Recruit resolves first.',
    'Recruit: draw the prepared card and discard the land.',
    'Confirm no Soldier token is created.',
  ],
  'pr09-celebrate-the-mountain-king-viewer-exile-positive': [
    'Cast Celebrate the Mountain-king for {2}{W}{W}.',
    'Choose the ETB trigger order, then choose PR09 Celebrate Target for the exile trigger.',
    'Confirm the target is exiled before P2 removes Celebrate, then confirm it returns to P2.',
  ],
  'pr09-celebrate-the-mountain-king-viewer-exile-negative': [
    'Cast Celebrate the Mountain-king for {2}{W}{W}.',
    'Choose the ETB trigger order and let P2 remove Celebrate before the exile trigger resolves.',
    'Confirm PR09 Celebrate Target remains on the battlefield because the source left before resolution.',
  ],
  'pr09-rabble-rousing-viewer-positive': [
    'Cast Rabble Rousing and choose a card for Hideaway 5.',
    'Attack with the prepared creature; the scenario has nine creatures before the Citizen.',
    'Confirm the Citizen makes ten creatures, then cast the linked hidden card for free.',
  ],
  'pr09-rabble-rousing-viewer-negative': [
    'Cast Rabble Rousing and choose a card for Hideaway 5.',
    'Declare no attackers.',
    'Confirm no Citizen tokens are created.',
  ],
  'pr09-tibalt-s-trickery-viewer-positive': [
    "Pass so P2 casts the prepared instant, then cast Tibalt's Trickery targeting P2's spell.",
    'Confirm P2 casts the different revealed card for free and it resolves.',
  ],
  'pr09-tibalt-s-trickery-viewer-negative': [
    "Pass so P2 casts the prepared instant, then cast Tibalt's Trickery targeting P2's spell.",
    'Confirm P2 declines the free cast.',
  ],
  'pr09-grenzo-havoc-raiser-viewer-positive': [
    'Cast Grenzo, Havoc Raiser for {R}{R}.',
    'Attack with the prepared creature and choose Grenzo’s exile mode.',
    'Cast the exiled card using the granted permission.',
  ],
  'pr09-grenzo-havoc-raiser-viewer-negative': [
    'Cast Grenzo, Havoc Raiser for {R}{R}.',
    'Declare no attacker that can deal combat damage.',
    'Confirm no Grenzo trigger or exiled card is created.',
  ],
  'pr09-grenzo-havoc-raiser-viewer-goad': [
    'Cast Grenzo, Havoc Raiser for {R}{R}.',
    'Deal combat damage to P2 and choose Grenzo’s goad mode for PR09 Goad Target.',
    'Confirm the target is goaded.',
  ],
  'pr09-power-pack-viewer-positive': [
    'Cast Power Pack for its normal cost.',
    'Attack with the hasty Power Pack.',
    'At your next upkeep, cast the randomly chosen graveyard spell for free and confirm it is exiled after resolution.',
  ],
  'pr09-power-pack-viewer-negative': [
    'Cast Power Pack for its normal cost and attack.',
    'Confirm an empty eligible graveyard creates no delayed cast.',
  ],
  'pr09-improvisation-capstone-viewer-positive': [
    'Cast Improvisation Capstone for its normal cost.',
    'Cast the revealed spells for free.',
    'At your next precombat main phase, cast the Paradigm copy from exile.',
  ],
  'pr09-improvisation-capstone-viewer-negative': [
    'Cast Improvisation Capstone for its normal cost.',
    'Decline the revealed free casts.',
    'At your next precombat main phase, confirm Paradigm creates its copy.',
  ],
};

const expectedOutcome: Record<string, string> = {
  'pr09-path-of-discovery-viewer-positive':
    'The creature trigger publicly reveals Forest and moves it to hand.',
  'pr09-path-of-discovery-viewer-negative': 'The artifact enters without an explore reveal.',
  'pr09-lurking-predators-viewer-positive':
    'An opponent spell triggers a public creature reveal and the creature enters.',
  'pr09-lurking-predators-viewer-negative': 'Your own spell does not trigger Lurking Predators.',
  'pr09-new-generation-s-technique-viewer-positive':
    'The spell searches for two basic lands, puts them onto the battlefield tapped, and shuffles.',
  'pr09-new-generation-s-technique-viewer-negative':
    'The spell is unavailable with insufficient mana and remains in hand.',
  'pr09-new-generation-s-technique-viewer-sneak-positive':
    'During declare blockers, Sneak is paid by returning the unblocked attacker; the spell resolves and searches for two tapped basics.',
  'pr09-new-generation-s-technique-viewer-sneak-negative':
    'In precombat main, the alternative Sneak cast is not available.',
  'pr09-celebrate-the-mountain-king-viewer-positive':
    'Recruit draws and discards a nonland, creating a Human Soldier token.',
  'pr09-celebrate-the-mountain-king-viewer-negative':
    'Recruit discards a land and creates no Soldier token.',
  'pr09-celebrate-the-mountain-king-viewer-exile-positive':
    'The ETB ability targets P2’s permanent, exiles it, and returns that object to its owner when Celebrate leaves.',
  'pr09-celebrate-the-mountain-king-viewer-exile-negative':
    'P2 removes Celebrate before the targeted trigger resolves, so the chosen permanent is never exiled.',
  'pr09-rabble-rousing-viewer-positive':
    'The declared attack creates a Citizen, reaches ten creatures, and casts the linked hidden card.',
  'pr09-rabble-rousing-viewer-negative':
    'Hideaway resolves but declaring no attackers creates no Citizens.',
  'pr09-tibalt-s-trickery-viewer-positive':
    'Trickery counters its target and the target’s controller casts the different revealed card for free.',
  'pr09-tibalt-s-trickery-viewer-negative':
    'Trickery resolves, and the target’s controller declines the offered free cast.',
  'pr09-grenzo-havoc-raiser-viewer-positive':
    'Combat damage triggers Grenzo’s exile mode and the exiled card is cast under its permission.',
  'pr09-grenzo-havoc-raiser-viewer-negative':
    'Without combat damage from a creature you control, Grenzo does not trigger.',
  'pr09-grenzo-havoc-raiser-viewer-goad':
    'Combat damage triggers Grenzo’s goad mode and goads the target creature controlled by the damaged player.',
  'pr09-power-pack-viewer-positive':
    'Power Pack’s damage trigger schedules the exact graveyard card; its next-upkeep cast resolves to exile.',
  'pr09-power-pack-viewer-negative':
    'With no eligible graveyard spell, combat damage creates no delayed cast.',
  'pr09-improvisation-capstone-viewer-positive':
    'Capstone casts revealed spells and Paradigm creates and casts a real copy from exile on a later main phase.',
  'pr09-improvisation-capstone-viewer-negative':
    'Capstone’s revealed spells are declined while Paradigm still creates its later copy.',
};

/** Build a pinned PR09 choice scenario with the named card available through normal game actions. */
export function pr09ChoiceScenario(id: string, gameId: GameId): CardTestScenario {
  const index = PR09_CHOICE_SCENARIOS.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`Unknown PR09 choice scenario ${id}`);
  const [, cardName, , title, clauses] = cases[index]!;
  const source = pin(cardName);
  const sourceLands = [
    'Forest',
    'Forest',
    'Mountain',
    'Mountain',
    'Island',
    'Swamp',
    'Plains',
    'Plains',
  ].map((name, index) => {
    const land = basic(name);
    return {
      ...land,
      oracleId: `${land.oracleId}-pr09-choice-${index}`,
      scryfallId: `${land.scryfallId}-pr09-choice-${index}`,
    };
  });
  const host = makeSupport('PR09 Path Creature', 'Creature — Scout', '{2}', '2');
  const artifact = makeSupport('PR09 Path Artifact', 'Artifact', '{1}', null);
  const oppInstant = makeSupport(
    'PR09 Opponent Instant',
    'Instant',
    '{1}',
    null,
    'You gain 1 life.',
  );
  const revealCreature = makeSupport('PR09 Predator Creature', 'Creature — Beast', '{2}', '2');
  const ownInstant = makeSupport('PR09 Own Instant', 'Instant', '{1}', null, 'You gain 1 life.');
  const recruitDraw = makeSupport('PR09 Recruit Draw', 'Artifact', '{1}', null);
  const recruitDiscard = makeSupport('PR09 Recruit Discard', 'Artifact', '{1}', null);
  const recruitLand = {
    ...basic('Plains'),
    name: 'PR09 Recruit Land',
    oracleId: 'pr09-recruit-land',
    scryfallId: 'pr09-recruit-land',
  };
  const rabbleHost = makeSupport('PR09 Rabble Attacker', 'Creature — Soldier', '{2}', '2');
  const sneakHost = makeSupport('PR09 Sneak Attacker', 'Creature — Scout', '{2}', '2');
  const sneakBlocker = makeSupport('PR09 Sneak Blocker', 'Creature — Test', '{2}', '2');
  const goadTarget = makeSupport('PR09 Goad Target', 'Creature — Test', '{2}', '2');
  goadTarget.toughness = '4';
  const celebrateTarget = makeSupport('PR09 Celebrate Target', 'Artifact', '{1}', null);
  const rabbleHidden = makeSupport('PR09 Rabble Hidden', 'Artifact', '{1}', null);
  const rabbleHelpers = Array.from({ length: 8 }, (_, index) =>
    makeSupport(`PR09 Rabble Helper ${index + 1}`, 'Creature — Citizen', '{1}', '1'),
  );
  const rabbleFiller = Array.from({ length: 4 }, (_, index) =>
    makeSupport(`PR09 Rabble Filler ${index + 1}`, 'Artifact', '{1}', null),
  );
  const trickeryTarget = makeSupport(
    'PR09 Trickery Target',
    'Instant',
    '{1}',
    null,
    'You gain 1 life.',
  );
  const trickeryHit = makeSupport(
    'PR09 Trickery Reveal',
    'Instant',
    '{1}',
    null,
    'You gain 1 life.',
  );
  const grenzoHit = makeSupport('PR09 Grenzo Reveal', 'Artifact', '{1}', null);
  const packSpell = makeSupport('PR09 Pack Spell', 'Instant', '{R}', null, 'You gain 1 life.');
  const capstoneOne = makeSupport('PR09 Capstone One', 'Sorcery', '{2}', null, 'You gain 1 life.');
  const capstoneTwo = makeSupport('PR09 Capstone Two', 'Sorcery', '{2}', null, 'You gain 1 life.');
  const libraryExtras = [basic('Forest'), basic('Island'), basic('Forest'), basic('Island')].map(
    (land, index) => ({
      ...land,
      oracleId: `${land.oracleId}-pr09-extra-${index}`,
      scryfallId: `${land.scryfallId}-pr09-extra-${index}`,
    }),
  );
  const p1FieldLands =
    id === 'pr09-new-generation-s-technique-viewer-negative'
      ? ['Forest', 'Mountain'].map(basic)
      : sourceLands;
  const supportCards = [
    host,
    artifact,
    oppInstant,
    revealCreature,
    ownInstant,
    recruitDraw,
    recruitDiscard,
    recruitLand,
    rabbleHost,
    sneakHost,
    sneakBlocker,
    goadTarget,
    celebrateTarget,
    rabbleHidden,
    ...rabbleHelpers,
    ...rabbleFiller,
    trickeryTarget,
    trickeryHit,
    grenzoHit,
    packSpell,
    capstoneOne,
    capstoneTwo,
    basic('Beast Within'),
  ];
  const p1Hand: string[] = [cardName];
  if (id === 'pr09-path-of-discovery-viewer-positive') p1Hand.push(host.name);
  if (id === 'pr09-path-of-discovery-viewer-negative') p1Hand.push(artifact.name);
  if (id === 'pr09-lurking-predators-viewer-negative') p1Hand.push(ownInstant.name);
  if (id === 'pr09-celebrate-the-mountain-king-viewer-positive') p1Hand.push(recruitDiscard.name);
  if (id === 'pr09-celebrate-the-mountain-king-viewer-negative') p1Hand.push(recruitLand.name);
  const p1FieldNames = p1FieldLands.map((land) => land.name);
  if (id.startsWith('pr09-rabble-rousing')) p1FieldNames.push(rabbleHost.name);
  if (id === 'pr09-rabble-rousing-viewer-positive')
    p1FieldNames.push(...rabbleHelpers.map((card) => card.name));
  if (id.startsWith('pr09-new-generation-s-technique-viewer-sneak'))
    p1FieldNames.push(sneakHost.name);
  if (
    id === 'pr09-grenzo-havoc-raiser-viewer-positive' ||
    id === 'pr09-grenzo-havoc-raiser-viewer-goad'
  )
    p1FieldNames.push(host.name);
  const p2ScenarioCards = id.startsWith('pr09-tibalt-s-trickery')
    ? [...sourceLands, ...libraryExtras, oppInstant, trickeryHit, source.card]
    : [...sourceLands, ...libraryExtras, ...supportCards, source.card];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr09-choice-${seat}`,
    commanders: [],
    cards:
      seat === 'P2'
        ? p2ScenarioCards
        : [...sourceLands, ...libraryExtras, ...supportCards, source.card],
  }));
  const seed = `pr09-choice-${id}-seed-1`;
  const lurkingPositive = id === 'pr09-lurking-predators-viewer-positive';
  const libraryTop =
    id === 'pr09-path-of-discovery-viewer-positive'
      ? [{ playerId: 'P1' as const, cardNames: ['Forest'] }]
      : id === 'pr09-lurking-predators-viewer-positive'
        ? [{ playerId: 'P1' as const, cardNames: [revealCreature.name] }]
        : id.startsWith('pr09-new-generation') && id.endsWith('positive')
          ? [{ playerId: 'P1' as const, cardNames: ['Forest', 'Island'] }]
          : id.startsWith('pr09-celebrate')
            ? [{ playerId: 'P1' as const, cardNames: [recruitDraw.name] }]
            : id.startsWith('pr09-rabble')
              ? [
                  {
                    playerId: 'P1' as const,
                    cardNames: [rabbleHidden.name, ...rabbleFiller.map((card) => card.name)],
                  },
                ]
              : id.startsWith('pr09-trickery')
                ? [
                    {
                      playerId: 'P2' as const,
                      cardNames: ['Forest', 'Island', 'Plains', trickeryHit.name],
                    },
                  ]
                : id.startsWith('pr09-grenzo')
                  ? [{ playerId: 'P2' as const, cardNames: [grenzoHit.name] }]
                  : id === 'pr09-power-pack-viewer-negative'
                    ? []
                    : id === 'pr09-power-pack-viewer-positive'
                      ? [{ playerId: 'P1' as const, cardNames: [] }]
                      : id.startsWith('pr09-improvisation-capstone')
                        ? [
                            {
                              playerId: 'P1' as const,
                              cardNames: [capstoneOne.name, capstoneTwo.name],
                            },
                          ]
                        : [];
  const p2Provider = {
    decide(request: import('@mtg/shared').DecisionRequest) {
      if (request.decisionType === 'declareBlockers') {
        const block = request.legalActions.find((action) => action.type === 'blockDeclaration');
        if (block)
          return {
            requestId: request.requestId,
            actionId: block.id,
            targets: (block.targets ?? []).map((slot) => ({
              slot: slot.slot,
              choice: NO_BLOCK_TARGET,
            })),
          };
      }
      const current = engine.getState();
      const celebrate = current.battlefield.find(
        (permanent) => permanent.name === 'Celebrate the Mountain-king',
      );
      const beastWithin = request.legalActions.find(
        (action) => action.type === 'castSpell' && action.description.includes('Beast Within'),
      );
      const removeCelebrate =
        id === 'pr09-celebrate-the-mountain-king-viewer-exile-negative'
          ? celebrate !== undefined &&
            current.exile.every((card) => card.name !== celebrateTarget.name)
          : id === 'pr09-celebrate-the-mountain-king-viewer-exile-positive'
            ? current.exile.some((card) => card.name === celebrateTarget.name)
            : false;
      if (removeCelebrate && celebrate !== undefined && beastWithin !== undefined) {
        const slot = beastWithin.targets?.find((target) => target.options.includes(celebrate.id));
        if (slot !== undefined)
          return {
            requestId: request.requestId,
            actionId: beastWithin.id,
            targets: [{ slot: slot.slot, choice: celebrate.id }],
          };
      }
      const cast = request.legalActions.find(
        (action) => action.type === 'castSpell' && action.description.includes(oppInstant.name),
      );
      const pass =
        request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
      const sourceResolved = engine
        .getState()
        .battlefield.some((permanent) => permanent.name === 'Lurking Predators');
      const freeCast =
        request.legalActions.find((action) => action.type === 'castFree') ??
        (id === 'pr09-tibalt-s-trickery-viewer-positive'
          ? request.legalActions.find(
              (action) =>
                action.type === 'castSpell' && !action.description.includes(oppInstant.name),
            )
          : undefined);
      const decline = request.legalActions.find(
        (action) => action.type === 'decline' || action.type === 'stopCasting',
      );
      const trickeryPositive = id === 'pr09-tibalt-s-trickery-viewer-positive';
      const trickeryOpponentCast = id.startsWith('pr09-tibalt-s-trickery') && cast;
      return {
        requestId: request.requestId,
        actionId:
          lurkingPositive && sourceResolved && cast
            ? cast.id
            : trickeryPositive && freeCast
              ? freeCast.id
              : id === 'pr09-tibalt-s-trickery-viewer-negative' && decline
                ? decline.id
                : trickeryOpponentCast
                  ? cast.id
                  : pass.id,
      };
    },
  };
  const engine = new Engine(
    { gameId, seed, players, turnCap: 12 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [
          { playerId: 'P1', cardNames: p1Hand },
          ...(lurkingPositive || id.startsWith('pr09-tibalt-s-trickery')
            ? [{ playerId: 'P2' as const, cardNames: [oppInstant.name] }]
            : []),
          ...(id.startsWith('pr09-celebrate-the-mountain-king-viewer-exile')
            ? [{ playerId: 'P2' as const, cardNames: ['Beast Within'] }]
            : []),
        ],
        battlefield: [
          { playerId: 'P1', cardNames: p1FieldNames },
          ...(lurkingPositive || id.startsWith('pr09-tibalt-s-trickery')
            ? [{ playerId: 'P2' as const, cardNames: ['Forest', 'Island'] }]
            : []),
          ...(id === 'pr09-grenzo-havoc-raiser-viewer-goad'
            ? [{ playerId: 'P2' as const, cardNames: [goadTarget.name] }]
            : []),
          ...(id === 'pr09-new-generation-s-technique-viewer-sneak-positive'
            ? [{ playerId: 'P2' as const, cardNames: [sneakBlocker.name] }]
            : []),
          ...(id.startsWith('pr09-celebrate-the-mountain-king-viewer-exile')
            ? [
                {
                  playerId: 'P2' as const,
                  cardNames: ['Forest', 'Island', 'Mountain', celebrateTarget.name],
                },
              ]
            : []),
        ],
        ...(libraryTop.length ? { libraryTop } : {}),
        ...(id === 'pr09-power-pack-viewer-positive'
          ? { graveyard: [{ playerId: 'P1' as const, cardNames: [packSpell.name] }] }
          : {}),
        ...(lurkingPositive
          ? {
              continueThroughNextTurn: true,
              continueThroughCombat: true,
              continueToPostcombatMain: true,
              continueToEndStep: true,
            }
          : {}),
        ...(id.startsWith('pr09-rabble') ||
        id.startsWith('pr09-grenzo') ||
        id.startsWith('pr09-power-pack') ||
        id === 'pr09-new-generation-s-technique-viewer-sneak-positive'
          ? { continueThroughCombat: true }
          : {}),
        ...(id === 'pr09-grenzo-havoc-raiser-viewer-positive'
          ? { continueToPostcombatMain: true }
          : {}),
        ...(id.startsWith('pr09-power-pack') ? { continueThroughUpkeeps: 4 } : {}),
        ...(id.startsWith('pr09-improvisation-capstone')
          ? { continueThroughPrecombatMains: 4 }
          : {}),
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title,
      instructions: instructions[id]!,
      expectedOutcome: expectedOutcome[id]!,
      oracleSha256: source.sha256,
      clauseIds: clauses.map((clause) => {
        const line = source.card.oracleText
          .split('\n')
          .findIndex((candidate) => candidate.includes(clause));
        if (line < 0)
          throw new Error(`Clause does not match pinned ${cardName} Oracle text: ${clause}`);
        return `pr09-${slug(cardName)}-clause-${line + 1}`;
      }),
    },
    seed,
    seats: players.map((config) => ({
      seat: config.id,
      config,
      deckSnapshotId: null,
      summary: {
        seat: config.id,
        deckId: config.deckId,
        label: config.id,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    })),
    engine,
    ...(lurkingPositive ||
    id.startsWith('pr09-tibalt-s-trickery') ||
    id.startsWith('pr09-grenzo-havoc-raiser') ||
    id.startsWith('pr09-celebrate-the-mountain-king-viewer-exile') ||
    id === 'pr09-new-generation-s-technique-viewer-sneak-positive'
      ? { decisionProviderOverrides: { P2: p2Provider } }
      : {}),
  };
}

function makeSupport(
  name: string,
  typeLine: string,
  manaCost: string,
  power: string | null,
  oracleText = '',
): OracleCard {
  const base = basic('Forest');
  const typeText = typeLine.split(' — ')[0]!;
  const types = typeText
    .split(' ')
    .filter((word) =>
      [
        'Artifact',
        'Creature',
        'Enchantment',
        'Instant',
        'Land',
        'Planeswalker',
        'Sorcery',
      ].includes(word),
    );
  const colors = [
    ...new Set(manaCost.match(/\{([WUBRG])\}/g)?.map((symbol) => symbol[1]!)),
  ] as Color[];
  return {
    ...base,
    oracleId: `pr09-${slug(name)}`,
    scryfallId: `pr09-${slug(name)}`,
    name,
    typeLine,
    types,
    subtypes: typeLine.includes(' — ') ? typeLine.split(' — ')[1]!.split(' ') : [],
    manaCost,
    cmc:
      (manaCost.match(/\{[0-9]+\}/g) ?? []).reduce(
        (total, item) => total + Number(item.slice(1, -1)),
        0,
      ) + (manaCost.match(/\{[WUBRG]\}/g)?.length ?? 0),
    colors,
    colorIdentity: colors,
    oracleText,
    power,
    toughness: power === null ? null : '2',
    isBasicLand: false,
  };
}
