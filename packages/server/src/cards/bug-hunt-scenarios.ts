import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/bug-hunt-oracle.json', 'utf8'),
) as {
  cards: { card: OracleCard; sha256: string }[];
};
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const real = (name: string): OracleCard => {
  const found =
    pinned.cards.find((entry) => entry.card.name === name)?.card ??
    coverage.find((card) => card.name === name);
  if (found === undefined) throw new Error(`Missing lab Oracle card ${name}`);
  return found;
};

const definitions = {
  'regression-viewer-aura-attachment': {
    name: 'Chains of Custody',
    title: 'Chains of Custody: attach before the entry trigger',
    hand: ['Chains of Custody'],
    battlefield: ['Llanowar Elves', 'Plains', 'Plains', 'Plains'],
    opponent: ['Solemn Simulacrum'],
    instruction:
      'Cast Chains on Llanowar Elves, then exile Solemn Simulacrum with its entry trigger.',
    outcome: 'Chains remains attached to Llanowar Elves and Solemn Simulacrum is exiled.',
    clause: 'enchant-and-linked-exile',
  },
  'regression-viewer-mana-source-order': {
    name: 'Phyrexian Tower',
    title: 'Phyrexian Tower: use the Elf before sacrificing it',
    hand: ['Cultivate'],
    battlefield: ['Phyrexian Tower', 'Llanowar Elves'],
    opponent: [],
    instruction: 'Cast Cultivate using the Elf and Tower, then finish its search.',
    outcome: 'The Elf produces green mana before Tower sacrifices it. Cultivate resolves.',
    clause: 'tap-sacrifice-creature-add-black-black',
  },
  'regression-viewer-token-characteristics': {
    name: 'Queen Allenal of Ruadach',
    title: 'Queen Allenal: plain and lifelink Soldiers stay distinct',
    hand: [],
    battlefield: [
      'Queen Allenal of Ruadach',
      'Dawn of Hope',
      'Plains',
      'Plains',
      'Plains',
      'Plains',
    ],
    opponent: [],
    instruction: 'Activate Dawn of Hope and pass priority.',
    outcome:
      'Two Soldiers enter: the Dawn token has lifelink; the additional Queen token does not.',
    clause: 'additional-plain-soldier-token',
  },
  'regression-viewer-damage-source-controller': {
    name: 'Twinflame Tyrant',
    title: 'Twinflame Tyrant: double damage from your spell',
    hand: ['Lightning Bolt'],
    battlefield: ['Twinflame Tyrant', 'Mountain'],
    opponent: [],
    instruction: 'Cast Lightning Bolt targeting P2 and pass priority.',
    outcome: 'Your Bolt deals six damage to P2, whose life becomes 34.',
    clause: 'damage-only-from-your-sources',
  },
} as const;

export const BUG_HUNT_SCENARIO_IDS = Object.keys(definitions) as (keyof typeof definitions)[];

export function bugHuntScenario(id: keyof typeof definitions, gameId: GameId): CardTestScenario {
  const d = definitions[id];
  const cards = [d.name, ...d.hand, ...d.battlefield, ...d.opponent, 'Forest', 'Plains'].map(real);
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `regression-lab-${seat}`,
    commanders: [],
    cards:
      seat === 'P1' || seat === 'P2'
        ? [...cards, ...Array.from({ length: 8 }, () => real('Forest'))]
        : Array.from({ length: 8 }, () => real('Forest')),
  }));
  const seed = `card-lab-${id}-v1`;
  return {
    metadata: {
      id,
      version: 1,
      title: d.title,
      instructions: [d.instruction, 'Pass with the stack empty to finish.'],
      expectedOutcome: d.outcome,
      oracleSha256: pinned.cards.find((p) => p.card.name === d.name)!.sha256,
      clauseIds: [d.clause],
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
          hand: [{ playerId: 'P1', cardNames: [...d.hand] }],
          battlefield: [
            { playerId: 'P1', cardNames: [...d.battlefield] },
            { playerId: 'P2' as PlayerId, cardNames: [...d.opponent] },
          ],
        },
      },
    ),
  };
}
