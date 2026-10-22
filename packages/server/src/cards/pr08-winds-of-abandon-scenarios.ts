import { readFileSync } from 'node:fs';
import { sha256 } from '../benchmark/hash';
import { Engine } from '@mtg/engine';
import type { DecisionProvider, EnginePlayerConfig } from '@mtg/engine';
import type { DecisionRequest, GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
for (const entry of pinned.cards)
  if (sha256(entry.card) !== entry.sha256)
    throw new Error(`Winds of Abandon Oracle pin drift: ${entry.card.name}`);
const selectedWinds = pinned.cards.find((entry) => entry.card.name === 'Winds of Abandon');
if (selectedWinds === undefined) throw new Error('Missing Winds of Abandon Oracle pin');
const winds = selectedWinds;

const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
function basic(name: string): OracleCard {
  const card = coverage.find((entry) => entry.name === name);
  if (card === undefined) throw new Error(`Missing Winds scenario basic ${name}`);
  return card;
}

function creature(name: string): OracleCard {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    ...basic('Forest'),
    oracleId: `lab-winds-${slug}`,
    scryfallId: `lab-winds-${slug}`,
    name,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine: 'Creature — Bear',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Bear'],
    oracleText: '',
    power: '2',
    toughness: '2',
    keywords: [],
    isBasicLand: false,
  };
}

export const WINDS_OF_ABANDON_SCENARIO_IDS = [
  'winds-of-abandon-viewer-targeted-search',
  'winds-of-abandon-viewer-overload-searches',
] as const;
type ScenarioId = (typeof WINDS_OF_ABANDON_SCENARIO_IDS)[number];
const details: Record<ScenarioId, { title: string; instructions: string[]; expected: string }> = {
  'winds-of-abandon-viewer-targeted-search': {
    title: 'Winds of Abandon: exile a target and search for a tapped basic',
    instructions: [
      'Cast Winds of Abandon normally for {1}{W}, targeting Lab P2 Creature.',
      'P2 searches for a basic land; its Plains enters tapped.',
    ],
    expected:
      'The targeted opposing creature is exiled, its controller finds a basic Plains, and the Plains enters tapped.',
  },
  'winds-of-abandon-viewer-overload-searches': {
    title: 'Winds of Abandon: overload and each opponent searches',
    instructions: [
      'Choose Winds of Abandon’s overload option and pay {4}{W}{W}.',
      'All opposing creatures, including Lab P2 Creature and Lab P3 Creature, are exiled without targeting.',
      'P2 and P3 each find a basic land; both enter tapped. Your Lab P1 Creature survives.',
    ],
    expected:
      'Overload exiles all opposing creatures without targets; each affected controller searches and puts a basic land onto the battlefield tapped, while your creature survives.',
  },
};

function searcher(basicName: string): DecisionProvider {
  return {
    decide(request: DecisionRequest) {
      const action =
        request.legalActions.find((candidate) =>
          request.prompt.toLowerCase().includes('search for a basic land')
            ? candidate.description.includes(basicName)
            : candidate.type === 'pass',
        ) ?? request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

export function pr08WindsOfAbandonScenario(id: string, gameId: GameId): CardTestScenario {
  const detail = details[id as ScenarioId];
  if (detail === undefined) throw new Error(`Unknown Winds of Abandon scenario ${id}`);
  const overload = id === WINDS_OF_ABANDON_SCENARIO_IDS[1];
  const plains = basic('Plains');
  const forest = basic('Forest');
  const p1Creature = creature('Lab P1 Creature');
  const p2Creature = creature('Lab P2 Creature');
  const p3Creature = creature('Lab P3 Creature');
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `card-lab-${seat}-winds-of-abandon`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [winds.card, plains, plains, forest, forest, forest, forest, p1Creature]
        : seat === 'P2'
          ? [p2Creature, plains, forest]
          : seat === 'P3'
            ? [p3Creature, forest, plains]
            : [plains, forest],
  }));
  const seed = `card-lab-${id}-v1`;
  const p1Lands = overload
    ? ['Plains', 'Plains', 'Forest', 'Forest', 'Forest', 'Forest']
    : ['Plains', 'Forest'];
  const battlefield = [
    { playerId: 'P1' as const, cardNames: p1Lands },
    { playerId: 'P1' as const, cardNames: overload ? [p1Creature.name] : [] },
    { playerId: 'P2' as const, cardNames: [p2Creature.name] },
    ...(overload ? [{ playerId: 'P3' as const, cardNames: [p3Creature.name] }] : []),
  ];
  const engine = new Engine(
    { gameId, seed, players, turnCap: 2 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Winds of Abandon'] }],
        battlefield,
        libraryTop: [
          { playerId: 'P2', cardNames: ['Plains', 'Forest'] },
          ...(overload ? [{ playerId: 'P3' as const, cardNames: ['Forest', 'Plains'] }] : []),
        ],
      },
    },
  );
  const seats = players.map((config) => ({
    seat: config.id,
    config,
    deckSnapshotId: null,
    summary: {
      seat: config.id,
      deckId: config.deckId,
      label: config.id === 'P1' ? 'Card Test Lab' : `Deterministic opponent ${config.id}`,
      commanderNames: [],
      colorIdentity: [],
      archetypeTag: 'card-test-lab',
    },
  }));
  return {
    metadata: {
      id,
      version: 1,
      title: detail.title,
      instructions: detail.instructions,
      expectedOutcome: detail.expected,
      oracleSha256: winds.sha256,
      clauseIds: [
        overload
          ? 'winds-of-abandon-overload-exile-search'
          : 'winds-of-abandon-targeted-exile-search',
      ],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: {
      P2: searcher('Plains'),
      P3: searcher('Forest'),
      P4: searcher('Plains'),
    },
  };
}
