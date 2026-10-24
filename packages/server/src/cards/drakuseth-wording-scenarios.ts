import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { DecisionProvider, EnginePlayerConfig } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/drakuseth-wording-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
for (const entry of fixture.cards) {
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`Drakuseth Oracle pin drift: ${entry.card.name}`);
}
const drakusethPin = (() => {
  const entry = fixture.cards.find((candidate) =>
    candidate.card.oracleText.includes('Drakuseth deals'),
  );
  if (!entry) throw new Error('Missing current Drakuseth wording Oracle pin');
  return entry;
})();
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const coverageCard = (name: string) => {
  const found = coverage.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing Drakuseth scenario basic ${name}`);
  return found;
};

export const DRAKUSETH_WORDING_SCENARIO_IDS = [
  'drakuseth-wording-viewer-three-targets',
  'drakuseth-wording-viewer-decline-others',
] as const;
type ScenarioId = (typeof DRAKUSETH_WORDING_SCENARIO_IDS)[number];

const details: Record<ScenarioId, { title: string; instructions: string[]; expected: string }> = {
  'drakuseth-wording-viewer-three-targets': {
    title: 'Drakuseth: current wording hits three distinct targets',
    instructions: [
      'Cast Drakuseth for {4}{R}{R}{R}; decline Temur Ascendancy’s optional draw.',
      'Attack P2. Assign the 4 damage to P2, then choose P3 and P4 for the two other targets.',
    ],
    expected: 'Before combat damage, P2 is at 36 and P3/P4 are at 37; after combat P2 is at 29.',
  },
  'drakuseth-wording-viewer-decline-others': {
    title: 'Drakuseth: current wording allows declining other targets',
    instructions: [
      'Cast Drakuseth for {4}{R}{R}{R}; decline Temur Ascendancy’s optional draw.',
      'Attack P2. Assign the 4 damage to P2, then choose no other targets.',
    ],
    expected: 'P2 ends at 29; P3 and P4 remain at 40.',
  },
};

function passing(): DecisionProvider {
  return {
    decide(request) {
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

export function drakusethWordingScenario(
  id: string,
  gameId: GameId,
  mountainCount = 7,
): CardTestScenario {
  const detail = details[id as ScenarioId];
  if (!detail) throw new Error(`Unknown Drakuseth wording scenario ${id}`);
  const cards: OracleCard[] = [
    drakusethPin.card,
    coverageCard('Temur Ascendancy'),
    ...Array.from({ length: 28 }, () => coverageCard('Mountain')),
    ...Array.from({ length: 8 }, () => coverageCard('Forest')),
    ...Array.from({ length: 8 }, () => coverageCard('Island')),
    ...Array.from({ length: 8 }, () => coverageCard('Plains')),
    ...Array.from({ length: 8 }, () => coverageCard('Swamp')),
  ];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `drakuseth-wording-${seat}`,
    commanders: [],
    cards,
  }));
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players, turnCap: 3 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        lifeTotals: (['P1', 'P2', 'P3', 'P4'] as const).map((playerId) => ({ playerId, life: 40 })),
        hand: [{ playerId: 'P1', cardNames: ['Drakuseth, Maw of Flames'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: [
              ...Array.from({ length: mountainCount }, () => 'Mountain'),
              'Temur Ascendancy',
            ],
          },
        ],
        continueThroughCombat: true,
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
      oracleSha256: drakusethPin.sha256,
      clauseIds: ['drakuseth-attack-damage', 'drakuseth-flying'],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: { P2: passing(), P3: passing(), P4: passing() },
  };
}

export function drakusethWordingScenarioSubject(id: string): string {
  if (!(DRAKUSETH_WORDING_SCENARIO_IDS as readonly string[]).includes(id))
    throw new Error(`Unknown Drakuseth wording scenario ${id}`);
  return drakusethPin.card.name;
}

export function drakusethWordingScenarioDetails(id: string) {
  const detail = details[id as ScenarioId];
  if (!detail) throw new Error(`Unknown Drakuseth wording scenario ${id}`);
  return detail;
}
