import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/target-untap-oracle.json', 'utf8'),
) as {
  cards: { sha256: string; card: OracleCard }[];
};
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const lands = ['Forest', 'Island', 'Plains', 'Mountain', 'Swamp'].map((name) => {
  const land = coverage.find((card) => card.name === name);
  if (!land) throw new Error(`Missing lab basic land ${name}`);
  return land;
});
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
const scenarios = pinned.cards.map((entry) => {
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`Target-untap Oracle fixture drift: ${entry.card.name}`);
  return { ...entry, id: `${slug(entry.card.name)}-viewer-target-untap` };
});
export const TARGET_UNTAP_SCENARIO_IDS = scenarios.map((entry) => entry.id);

function witness(name: string): OracleCard {
  return {
    ...lands[0]!,
    oracleId: `lab-${slug(name)}`,
    scryfallId: `lab-${slug(name)}`,
    name,
    typeLine: 'Creature — Bear',
    types: ['Creature'],
    supertypes: [],
    subtypes: ['Bear'],
    isBasicLand: false,
    manaCost: '{2}',
    cmc: 2,
    oracleText: '',
    power: '2',
    toughness: '2',
  };
}

export function targetUntapScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = scenarios.find((scenario) => scenario.id === id);
  if (!entry) throw new Error(`Unknown target-untap scenario ${id}`);
  const selected = witness('Chosen Untap Bear');
  const other = witness('Other Tapped Bear');
  const mana = [...lands, ...lands];
  const seed = `card-lab-${id}-v1`;
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `target-untap-lab-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [entry.card, ...mana]
        : seat === 'P2'
          ? [selected, other, ...lands]
          : [...lands],
  }));
  return {
    metadata: {
      id,
      version: 1,
      title: `${entry.card.name}: affect and untap one target`,
      instructions: [
        `Cast ${entry.card.name}, targeting Chosen Untap Bear.`,
        'Pass with the stack empty to finish.',
      ],
      expectedOutcome:
        'The chosen Bear receives every printed first-clause effect and untaps. The other Bear remains tapped and 2/2.',
      oracleSha256: entry.sha256,
      clauseIds: [`${slug(entry.card.name)}-target-untap`],
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
    engine: new Engine(
      { gameId, seed, players, turnCap: 2 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [{ playerId: 'P1', cardNames: [entry.card.name] }],
          battlefield: [
            { playerId: 'P1', cardNames: mana.map((card) => card.name) },
            { playerId: 'P2', cardNames: [selected.name, other.name], tapped: true },
          ],
        },
      },
    ),
  };
}
