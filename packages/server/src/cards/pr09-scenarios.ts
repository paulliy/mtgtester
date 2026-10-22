import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
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
const coverage = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];
function basic(name: string): OracleCard {
  const found = coverage.find((card) => card.name === name);
  if (!found) throw new Error(`Missing PR09 scenario basic ${name}`);
  return found;
}
function labCard(
  name: string,
  typeLine: string,
  manaCost: string | null = null,
  power: string | null = null,
  oracleText = '',
): OracleCard {
  const base = basic('Forest');
  const left = typeLine.split(' — ')[0] ?? '';
  const types = left
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
  const subtypes = typeLine.includes(' — ') ? typeLine.split(' — ')[1]!.split(' ') : [];
  return {
    ...base,
    oracleId: `lab-pr09-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    scryfallId: `lab-pr09-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    manaCost,
    cmc:
      manaCost === null
        ? 0
        : [...manaCost.matchAll(/\{([0-9]+)\}/g)].reduce((sum, m) => sum + Number(m[1]), 0) +
          (manaCost.match(/\{[WUBRG]\}/g)?.length ?? 0),
    colors: [],
    colorIdentity: [],
    typeLine,
    types,
    supertypes: [],
    subtypes,
    oracleText,
    power,
    toughness: power === null ? null : '2',
    keywords: [],
    isBasicLand: false,
  };
}
const artifact = (name: string) => labCard(name, 'Artifact');
const creature = (name: string, power = '2') => labCard(name, 'Creature — Test', '{2}', power);
const aura = labCard('Lab Aura', 'Enchantment — Aura', '{W}', null, 'Enchant creature');
const equipment = labCard('Lab Equipment', 'Artifact — Equipment', '{2}');
const nonpermanent = labCard('Lab Revealed Sorcery', 'Sorcery', '{2}');
const CARD_NAMES = [
  'Chaos Warp',
  'Adaptive Omnitool',
  'Armored Skyhunter',
  'Keen Duelist',
  'Szarekh, the Silent King',
] as const;
const CARD_PINS = Object.fromEntries(CARD_NAMES.map((name) => [name, pin(name)])) as Record<
  (typeof CARD_NAMES)[number],
  Pin
>;
const lands = [
  basic('Mountain'),
  basic('Plains'),
  basic('Swamp'),
  basic('Island'),
  basic('Forest'),
];
const manyLands = [...lands, ...lands];
const responseManaLands = [basic('Forest'), basic('Forest'), basic('Forest')];

export const PR09_SCENARIOS = [
  {
    id: 'pr09-chaos-warp-viewer-positive',
    title: 'Chaos Warp: owner reveals a nonpermanent card publicly',
    cardName: 'Chaos Warp',
  },
  {
    id: 'pr09-chaos-warp-viewer-negative',
    title: 'Chaos Warp: target leaves before resolution',
    cardName: 'Chaos Warp',
  },
  {
    id: 'pr09-adaptive-omnitool-viewer-positive',
    title: 'Adaptive Omnitool: equip, grow, and reveal a chosen artifact',
    cardName: 'Adaptive Omnitool',
  },
  {
    id: 'pr09-adaptive-omnitool-viewer-negative',
    title: 'Adaptive Omnitool: no artifact among the top six',
    cardName: 'Adaptive Omnitool',
  },
  {
    id: 'pr09-armored-skyhunter-viewer-positive',
    title: 'Armored Skyhunter: attack and put Equipment onto the battlefield',
    cardName: 'Armored Skyhunter',
  },
  {
    id: 'pr09-armored-skyhunter-viewer-negative',
    title: 'Armored Skyhunter: a non-Equipment artifact is ineligible',
    cardName: 'Armored Skyhunter',
  },
  {
    id: 'pr09-armored-skyhunter-viewer-aura',
    title: 'Armored Skyhunter: put an Aura onto a legal creature',
    cardName: 'Armored Skyhunter',
  },
  {
    id: 'pr09-keen-duelist-viewer-positive',
    title: 'Keen Duelist: both players reveal, lose life, and take their cards',
    cardName: 'Keen Duelist',
  },
  {
    id: 'pr09-keen-duelist-viewer-cast',
    title: 'Keen Duelist: normal cast does not trigger its own upkeep ability',
    cardName: 'Keen Duelist',
  },
  {
    id: 'pr09-keen-duelist-viewer-negative',
    title: 'Keen Duelist: an empty library does not cause a loss',
    cardName: 'Keen Duelist',
  },
  {
    id: 'pr09-szarekh-the-silent-king-viewer-positive',
    title: 'Szarekh: attack, mill three, and return a milled Vehicle',
    cardName: 'Szarekh, the Silent King',
  },
  {
    id: 'pr09-szarekh-the-silent-king-viewer-negative',
    title: 'Szarekh: only eligible milled cards can be returned',
    cardName: 'Szarekh, the Silent King',
  },
  {
    id: 'pr09-szarekh-the-silent-king-viewer-replaced-mill',
    title: 'Szarekh: return a newly milled card from exile under Rest in Peace',
    cardName: 'Szarekh, the Silent King',
  },
  {
    id: 'pr09-szarekh-the-silent-king-viewer-cast',
    title: 'Szarekh: cast normally and confirm flying',
    cardName: 'Szarekh, the Silent King',
  },
] as const;
export const PR09_SCENARIO_IDS = PR09_SCENARIOS.map((entry) => entry.id);

type Case = (typeof PR09_SCENARIOS)[number]['id'];
const details: Record<Case, { instructions: string[]; expected: string; clauses: string[] }> = {
  'pr09-chaos-warp-viewer-positive': {
    instructions: [
      'Cast Chaos Warp targeting Lab P2 Artifact.',
      'Confirm its owner reveals Lab Revealed Sorcery publicly; it is not a permanent and stays on top.',
    ],
    expected:
      'The targeted artifact is shuffled into its owner’s library and that owner publicly reveals a nonpermanent card, which stays on top.',
    clauses: ['pr09-chaos-warp-clause-1'],
  },
  'pr09-chaos-warp-viewer-negative': {
    instructions: [
      'Cast Chaos Warp targeting Lab P2 Artifact.',
      'P2 responds with Beast Within targeting that artifact.',
      'Confirm Chaos Warp has no legal target when it resolves and no library card is revealed.',
    ],
    expected:
      'Beast Within removes the target before Chaos Warp resolves; Chaos Warp fizzles and no reveal occurs.',
    clauses: ['pr09-chaos-warp-clause-1'],
  },
  'pr09-adaptive-omnitool-viewer-positive': {
    instructions: [
      'Cast Adaptive Omnitool and equip it to Lab Host by paying {3}.',
      'Confirm the host gets +1/+1 for each artifact you control, including the Omnitool.',
      'Attack with Lab Host, choose Lab Omnitool Hit among the top six, and confirm it is publicly revealed and put into your hand.',
    ],
    expected:
      'The equipped host is 4/4 with two artifacts controlled; its attack reveals the chosen artifact to all players, moves it to hand, and randomizes the rest on the library bottom.',
    clauses: [
      'pr09-adaptive-omnitool-clause-1',
      'pr09-adaptive-omnitool-clause-2',
      'pr09-adaptive-omnitool-clause-3',
    ],
  },
  'pr09-adaptive-omnitool-viewer-negative': {
    instructions: [
      'Cast and equip Adaptive Omnitool to Lab Host.',
      'Attack with Lab Host when the top six contain no artifact.',
      'Confirm the unrevealed cards are randomized to the library bottom.',
    ],
    expected:
      'No card is revealed or put into hand; the top six are randomized onto the library bottom.',
    clauses: ['pr09-adaptive-omnitool-clause-2', 'pr09-adaptive-omnitool-clause-3'],
  },
  'pr09-armored-skyhunter-viewer-positive': {
    instructions: [
      'Cast Armored Skyhunter; the prepared Skyhunter can attack this turn.',
      'Attack with Armored Skyhunter and put Lab Equipment onto the battlefield.',
      'Choose Lab Host as the Equipment attachment.',
    ],
    expected:
      'The attack trigger puts the chosen Equipment onto the battlefield and attaches it to your Lab Host without paying equip.',
    clauses: ['pr09-armored-skyhunter-clause-1', 'pr09-armored-skyhunter-clause-2'],
  },
  'pr09-armored-skyhunter-viewer-negative': {
    instructions: [
      'Cast Armored Skyhunter and attack with the prepared Skyhunter.',
      'Confirm Lab Non-Equipment Artifact is not an available card to put onto the battlefield.',
    ],
    expected:
      'The non-Equipment artifact is ineligible and remains among the unrevealed cards randomized to the library bottom.',
    clauses: ['pr09-armored-skyhunter-clause-2'],
  },
  'pr09-armored-skyhunter-viewer-aura': {
    instructions: [
      'Cast Armored Skyhunter and attack with the prepared Skyhunter.',
      'Choose Lab Aura to enter the battlefield attached to Lab Host.',
    ],
    expected: 'The Aura enters the battlefield attached to the legal creature as it enters.',
    clauses: ['pr09-armored-skyhunter-clause-2'],
  },
  'pr09-keen-duelist-viewer-positive': {
    instructions: [
      'At your upkeep, choose P2 as the target opponent.',
      'Confirm both top cards are revealed publicly, each player loses life equal to the other revealed card’s mana value, and each card goes to its owner’s hand.',
    ],
    expected:
      'Both libraries reveal publicly; life loss crosses between the two mana values and both revealed cards move to their owners’ hands.',
    clauses: ['pr09-keen-duelist-clause-1'],
  },
  'pr09-keen-duelist-viewer-cast': {
    instructions: [
      'Cast Keen Duelist normally for {1}{B}.',
      'Confirm the cast itself does not cause an upkeep reveal.',
    ],
    expected:
      'Keen Duelist resolves as a creature with no upkeep reveal during the turn it was cast.',
    clauses: ['pr09-keen-duelist-clause-1'],
  },
  'pr09-keen-duelist-viewer-negative': {
    instructions: [
      'At your upkeep, choose P2 as the target opponent while your library is empty.',
      'Confirm P2 still reveals and takes their card, P1 loses life equal to that card’s mana value, P2 loses no life, and neither player loses the game for an empty library.',
    ],
    expected:
      'P1 reveals no card and loses one life from P2’s revealed card; P2 loses no life and takes their revealed card, with no deck-out.',
    clauses: ['pr09-keen-duelist-clause-1'],
  },
  'pr09-szarekh-the-silent-king-viewer-positive': {
    instructions: [
      'Attack with the prepared Szarekh.',
      'Choose the milled Vehicle and put it into your hand.',
    ],
    expected:
      'Szarekh mills three cards and the eligible Vehicle from that batch is put into your hand.',
    clauses: ['pr09-szarekh-the-silent-king-clause-1', 'pr09-szarekh-the-silent-king-clause-2'],
  },
  'pr09-szarekh-the-silent-king-viewer-negative': {
    instructions: [
      'Start with an eligible artifact creature already in your graveyard and attack with Szarekh.',
      'Decline the optional return from the three cards milled this way.',
    ],
    expected:
      'The preexisting artifact creature is not eligible; declining leaves the newly milled cards in the graveyard.',
    clauses: ['pr09-szarekh-the-silent-king-clause-2'],
  },
  'pr09-szarekh-the-silent-king-viewer-replaced-mill': {
    instructions: [
      'Rest in Peace is already on the battlefield. Attack with the prepared Szarekh.',
      'Choose Lab Vehicle from the three cards milled this way and put it into your hand.',
      'Confirm the prior eligible card and the two other newly milled cards remain in exile.',
    ],
    expected:
      'Rest in Peace exiles all three milled cards; Szarekh returns the newly milled Vehicle from exile, leaves the prior eligible exiled card untouched, and leaves both misses exiled.',
    clauses: ['pr09-szarekh-the-silent-king-clause-2'],
  },
  'pr09-szarekh-the-silent-king-viewer-cast': {
    instructions: [
      'Cast Szarekh normally for {1}{B}{B}{B}.',
      'Confirm the resolved creature has flying.',
    ],
    expected: 'Szarekh is cast through the normal payment action and resolves with flying.',
    clauses: ['pr09-szarekh-the-silent-king-clause-1'],
  },
};

const nonPermanent = nonpermanent;
const chaosTarget = labCard('Lab P2 Artifact', 'Artifact Creature — Construct', '{2}', '2');
const responseRemoval = basic('Beast Within');
const host = creature('Lab Host');
const ownedArtifact = artifact('Lab Owned Artifact');
const opponentArtifact = artifact('Lab Opponent Artifact');
const omnitoolHit = artifact('Lab Omnitool Hit');
const omnitoolMisses = [1, 2, 3, 4, 5].map((n) => labCard(`Lab Private ${n}`, 'Sorcery', '{1}'));
const equipmentHit = equipment;
const auraHit = aura;
const nonEquipment = artifact('Lab Non-Equipment Artifact');
const skyMisses = [1, 2, 3, 4, 5].map((n) => labCard(`Lab Sky Private ${n}`, 'Sorcery', '{1}'));
const keenP1 = labCard('Lab P1 Reveal', 'Artifact', '{3}');
const keenP2 = labCard('Lab P2 Reveal', 'Artifact', '{1}');
const vehicle = labCard('Lab Vehicle', 'Artifact — Vehicle', '{3}');
const restInPeace = basic('Rest in Peace');
const szarekhMisses = [
  labCard('Lab Milled One', 'Land'),
  labCard('Lab Milled Two', 'Land'),
  labCard('Lab Milled Three', 'Artifact', '{1}'),
];
const oldArtifactCreature = labCard(
  'Lab Old Artifact Creature',
  'Artifact Creature — Construct',
  '{2}',
  '2',
);

function nonchaosProvider(_id: Case) {
  return {
    decide(request: {
      requestId: string;
      legalActions: { id: number; type: string; description: string }[];
    }) {
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function makeScenario(id: Case, gameId: GameId): CardTestScenario {
  const entry = PR09_SCENARIOS.find((candidate) => candidate.id === id)!;
  const cardPin = CARD_PINS[entry.cardName as keyof typeof CARD_PINS];
  const card = cardPin.card;
  const spec = details[id];
  const scenarioCards = [
    card,
    ...(id === 'pr09-szarekh-the-silent-king-viewer-replaced-mill' ? [restInPeace] : []),
    ...manyLands,
    chaosTarget,
    responseRemoval,
    host,
    ownedArtifact,
    opponentArtifact,
    omnitoolHit,
    ...omnitoolMisses,
    equipmentHit,
    auraHit,
    nonEquipment,
    ...skyMisses,
    keenP1,
    keenP2,
    vehicle,
    ...szarekhMisses,
    oldArtifactCreature,
  ];
  const skyhunter = id.startsWith('pr09-armored-skyhunter');
  const omnitool = id.startsWith('pr09-adaptive-omnitool');
  const chaos = id.startsWith('pr09-chaos-warp');
  const keen = id.startsWith('pr09-keen-duelist');
  const szarekh = id.startsWith('pr09-szarekh');
  const positiveChaos = id === 'pr09-chaos-warp-viewer-positive';
  const negativeChaos = id === 'pr09-chaos-warp-viewer-negative';
  const p1Hand =
    chaos ||
    omnitool ||
    skyhunter ||
    id === 'pr09-keen-duelist-viewer-cast' ||
    id === 'pr09-szarekh-the-silent-king-viewer-cast'
      ? [card.name]
      : [];
  const field: Array<{ playerId: 'P1' | 'P2'; cardNames: string[]; tapped?: boolean }> = [];
  const p1Field = [...manyLands.slice(0, 8).map((land) => land.name)];
  if (id === 'pr09-szarekh-the-silent-king-viewer-cast') p1Field.push(basic('Swamp').name);
  if (chaos)
    field.push({
      playerId: 'P2',
      cardNames: [
        chaosTarget.name,
        ...(negativeChaos ? responseManaLands.map((land) => land.name) : []),
      ],
    });
  if (omnitool && id.endsWith('positive'))
    field.push({ playerId: 'P2', cardNames: [opponentArtifact.name] });
  if (omnitool || skyhunter) {
    p1Field.push(host.name, ownedArtifact.name);
    if (skyhunter) p1Field.push(card.name);
  }
  if (keen && id !== 'pr09-keen-duelist-viewer-cast') p1Field.push(card.name);
  if (szarekh && !id.endsWith('cast')) p1Field.push(card.name);
  if (id === 'pr09-szarekh-the-silent-king-viewer-replaced-mill') p1Field.push(restInPeace.name);
  if (p1Field.length) field.push({ playerId: 'P1', cardNames: p1Field });
  const hands: Array<{ playerId: 'P1' | 'P2'; cardNames: string[] }> = [
    { playerId: 'P1', cardNames: p1Hand },
  ];
  if (negativeChaos) hands.push({ playerId: 'P2', cardNames: [responseRemoval.name] });
  const p1Top = omnitool
    ? id.endsWith('positive')
      ? [omnitoolHit.name, ...omnitoolMisses.map((c) => c.name)]
      : omnitoolMisses.map((c) => c.name)
    : skyhunter
      ? id.endsWith('positive')
        ? [equipmentHit.name, ...skyMisses.map((c) => c.name)]
        : id.endsWith('aura')
          ? [auraHit.name, ...skyMisses.map((c) => c.name)]
          : [nonEquipment.name, ...skyMisses.map((c) => c.name)]
      : keen && id.endsWith('positive')
        ? [keenP1.name]
        : [];
  const p2Top = keen && !id.endsWith('cast') ? [keenP2.name] : [];
  const isKeenUpkeep = keen && id !== 'pr09-keen-duelist-viewer-cast';
  const isSzarekh = szarekh && !id.endsWith('cast');
  const libraryTop: Array<{ playerId: 'P1' | 'P2'; cardNames: string[] }> = [];
  if (p1Top.length) libraryTop.push({ playerId: 'P1', cardNames: p1Top });
  if (p2Top.length) libraryTop.push({ playerId: 'P2', cardNames: p2Top });
  if (positiveChaos) libraryTop.push({ playerId: 'P2', cardNames: [nonPermanent.name] });
  if (isSzarekh)
    libraryTop.push({
      playerId: 'P1',
      cardNames:
        id.endsWith('positive') || id === 'pr09-szarekh-the-silent-king-viewer-replaced-mill'
          ? [szarekhMisses[0]!.name, vehicle.name, szarekhMisses[2]!.name]
          : szarekhMisses.map((c) => c.name),
    });
  const graveyard =
    id === 'pr09-szarekh-the-silent-king-viewer-negative'
      ? [{ playerId: 'P1' as const, cardNames: [oldArtifactCreature.name] }]
      : undefined;
  const seed = `card-lab-${id}-v1`;
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr09-viewer-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [
            ...scenarioCards,
            ...(skyhunter ? [card] : []),
            ...(id === 'pr09-szarekh-the-silent-king-viewer-cast' ? [basic('Swamp')] : []),
          ]
        : seat === 'P2'
          ? negativeChaos
            ? [chaosTarget, responseRemoval, nonPermanent, ...manyLands, ...responseManaLands]
            : positiveChaos
              ? [
                  chaosTarget,
                  ...Array.from({ length: 20 }, (_, index) =>
                    labCard(
                      index === 18 ? 'Lab Revealed Sorcery' : `Lab Shuffle Filler ${index + 1}`,
                      'Sorcery',
                      '{1}',
                    ),
                  ),
                ]
              : [...scenarioCards, ...manyLands]
          : [...manyLands],
  }));
  const engine = new Engine(
    { gameId, seed, players, turnCap: 10 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: hands,
        battlefield: field,
        ...(libraryTop.length ? { libraryTop } : {}),
        ...(graveyard ? { graveyard } : {}),
        ...(isSzarekh || skyhunter || omnitool ? { continueThroughCombat: true } : {}),
        ...(isKeenUpkeep ? { continueThroughUpkeeps: 4 } : {}),
      },
    },
  );
  if (id === 'pr09-szarekh-the-silent-king-viewer-replaced-mill') {
    const state = engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1');
    if (p1 === undefined) throw new Error('Missing P1 in Rest in Peace Szarekh setup');
    const priorIndex = p1.library.findIndex(
      (candidate) => candidate.name === oldArtifactCreature.name,
    );
    if (priorIndex < 0)
      throw new Error(`Missing prior eligible card ${oldArtifactCreature.name} in P1 library`);
    const prior = p1.library.splice(priorIndex, 1)[0]!;
    prior.zone = 'exile';
    state.exile.push(prior);
  }
  if (id === 'pr09-keen-duelist-viewer-negative') {
    const p1 = engine.getState().players.find((player) => player.id === 'P1');
    if (p1 === undefined) throw new Error('Missing P1 in empty-library Keen Duelist setup');
    p1.library.length = 0;
  }
  const seats = players.map((config) => ({
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
  }));
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: spec.instructions,
      expectedOutcome: spec.expected,
      oracleSha256: cardPin.sha256,
      clauseIds: spec.clauses,
    },
    seed,
    seats,
    engine,
    ...(negativeChaos
      ? {
          decisionProviderOverrides: {
            P2: {
              decide(request: import('@mtg/shared').DecisionRequest) {
                const targetId = engine
                  .getState()
                  .battlefield.find((perm) => perm.name === chaosTarget.name)?.id;
                const response = request.legalActions.find(
                  (action) =>
                    action.type === 'castSpell' &&
                    action.description.includes(responseRemoval.name) &&
                    action.targets?.some(
                      (target) => targetId !== undefined && target.options.includes(targetId),
                    ),
                );
                if (response && targetId)
                  return {
                    requestId: request.requestId,
                    actionId: response.id,
                    targets: [{ slot: response.targets![0]!.slot, choice: targetId }],
                  };
                const action =
                  request.legalActions.find((candidate) => candidate.type === 'pass') ??
                  request.legalActions[0]!;
                return { requestId: request.requestId, actionId: action.id };
              },
            },
          },
        }
      : { decisionProviderOverrides: { P2: nonchaosProvider(id) } }),
  };
}

/** Build one of the source-pinned first-five PR09 Card Test Lab scenarios. */
export function pr09Scenario(id: string, gameId: GameId): CardTestScenario {
  if (!(PR09_SCENARIO_IDS as readonly string[]).includes(id))
    throw new Error(`Unknown PR09 scenario ${id}`);
  return makeScenario(id as Case, gameId);
}
