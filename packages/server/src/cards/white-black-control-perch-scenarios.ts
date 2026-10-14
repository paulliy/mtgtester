import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function fromPin(name: string): { card: OracleCard; sha256: string } {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing white-black-control Oracle pin: ${name}`);
  if (createHash('sha256').update(canonical(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`White-black-control Oracle fixture drift: ${name}`);
  return entry;
}

const perch = fromPin('Perch Protection');
const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;
const scenarioId = 'perch-protection-viewer-gift-phaseout-next-turn';

export const WHITE_BLACK_CONTROL_PERCH_SCENARIO_IDS = [scenarioId] as const;

function visibleBear(): OracleCard {
  return {
    ...plains,
    oracleId: 'lab-white-black-perch-visible-bear',
    scryfallId: 'lab-white-black-perch-visible-bear',
    name: 'Lab Visible P1 Bear',
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

export function whiteBlackControlPerchScenario(id: string, gameId: GameId): CardTestScenario {
  if (id !== scenarioId) throw new Error(`Unknown white-black-control scenario ${id}`);

  const bear = visibleBear();
  const p1Lands = Array.from({ length: 6 }, () => plains);
  const libraryFillers = Array.from({ length: 10 }, () => swamp);
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-perch-${seat}`,
    commanders: [],
    cards: seat === 'P1' ? [perch.card, ...p1Lands, bear, ...libraryFillers] : libraryFillers,
  }));
  const seed = `card-lab-${id}-v1`;

  return {
    metadata: {
      id,
      version: 1,
      title: 'Perch Protection: gift P2 an extra turn, then phase in with four Birds',
      instructions: [
        'Cast Perch Protection normally from P1’s hand using the six Plains.',
        'After paying, promise P2 the extra turn gift.',
        'Observe P1’s Bear and six Plains phase out, Perch Protection move to exile, and P2 take the extra turn.',
        'Continue through the production turns until P1’s next precombat main phase; verify the same Bear and Plains remain and four 2/2 flying blue Birds are present.',
      ],
      expectedOutcome:
        'Perch Protection is cast for {4}{W}{W}; P2 receives the promised extra turn. It creates four blue 2/2 flying Birds, phases out P1’s permanents, and exiles itself. P1’s original Bear and six Plains phase in before P1’s next untap.',
      oracleSha256: perch.sha256,
      clauseIds: [
        'perch-protection-c01',
        'perch-protection-c02',
        'perch-protection-c03',
      ],
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
      { gameId, seed, players, turnCap: 8 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [{ playerId: 'P1', cardNames: [perch.card.name] }],
          battlefield: [
            { playerId: 'P1', cardNames: p1Lands.map((land) => land.name) },
            { playerId: 'P1', cardNames: [bear.name] },
          ],
          continueThroughPrecombatMains: 5,
        },
      },
    ),
  };
}
