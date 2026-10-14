import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    return input;
  };
  return JSON.stringify(ordered(value));
}

function fromPin(name: string): { card: OracleCard; sha256: string } {
  const entry = pins.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing white-black-control Oracle pin: ${name}`);
  if (createHash('sha256').update(canonical(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`White-black-control Oracle fixture drift: ${name}`);
  return entry;
}

const library = fromPin('Library of Leng');
const tinybones = fromPin('Tinybones, Trinket Thief');
const swamp = fromPin('Swamp').card;

const entries = [
  {
    id: 'library-of-leng-viewer-no-maximum-hand-size',
    source: library,
    clauseId: 'library-of-leng-c01',
    title: 'Library of Leng: keep eight cards through production cleanup',
  },
  {
    id: 'tinybones-trinket-thief-viewer-empty-hand-activation',
    source: tinybones,
    clauseId: 'tinybones-trinket-thief-c02',
    title: 'Tinybones: pay {4}{B}{B} and make empty-handed opponents lose 10 life',
  },
] as const;

export const WHITE_BLACK_HAND_LIMIT_SCENARIO_IDS = entries.map((entry) => entry.id);

function seats(cardsBySeat: Record<string, OracleCard[]>) {
  return Object.entries(cardsBySeat).map(([id, cards]) => ({
    id,
    deckId: `white-black-hand-limit-${id}`,
    commanders: [],
    cards,
  }));
}

export function whiteBlackControlHandLimitScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control scenario ${id}`);

  const isLibrary = entry.source.card.name === 'Library of Leng';
  const playerConfigs = isLibrary
    ? seats({
        P1: [library.card, ...Array.from({ length: 24 }, () => swamp)],
        P2: Array.from({ length: 24 }, () => swamp),
      })
    : seats({
        P1: [tinybones.card, ...Array.from({ length: 24 }, () => swamp)],
        P2: Array.from({ length: 24 }, () => swamp),
        P3: Array.from({ length: 24 }, () => swamp),
        P4: Array.from({ length: 24 }, () => swamp),
      });

  return {
    metadata: {
      id: entry.id,
      version: 1,
      title: entry.title,
      instructions: isLibrary
        ? [
            'Cast Library of Leng from your hand in the postcombat main phase, then pass priority through the real turn ending and cleanup.',
          ]
        : [
            'Cast Tinybones, Trinket Thief for {1}{B}, then activate its printed {4}{B}{B} ability. P2, P3, and P4 start with empty, one-card, and empty hands respectively.',
          ],
      expectedOutcome: isLibrary
        ? 'Library of Leng resolves from hand. After the normal turn ending and cleanup, all eight Swamps that were in hand remain there; the next player has also taken a normal draw step.'
        : 'Tinybones resolves after paying {1}{B}; its {4}{B}{B} ability resolves and P2 and P4 each lose 10 life while P3, who still has one card in hand, remains at 40 life.',
      oracleSha256: entry.source.sha256,
      clauseIds: [entry.clauseId],
    },
    seed: `card-lab-${entry.id}-v1`,
    seats: playerConfigs.map((config) => ({
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
      {
        gameId,
        seed: `card-lab-${entry.id}-v1`,
        players: playerConfigs,
        turnCap: isLibrary ? 2 : 1,
      },
      {
        preparedScenario: isLibrary
          ? {
              currentTurnPlayer: 'P1',
              phase: 'postcombatMain',
              step: null,
              turnNumber: 1,
              hand: [
                {
                  playerId: 'P1',
                  cardNames: [library.card.name, ...Array.from({ length: 8 }, () => swamp.name)],
                },
              ],
              battlefield: [{ playerId: 'P1', cardNames: [swamp.name] }],
              continueThroughNextPrecombatMain: true,
            }
          : {
              currentTurnPlayer: 'P1',
              phase: 'precombatMain',
              step: null,
              turnNumber: 1,
              hand: [
                { playerId: 'P1', cardNames: [tinybones.card.name] },
                { playerId: 'P3', cardNames: [swamp.name] },
              ],
              battlefield: [
                { playerId: 'P1', cardNames: Array.from({ length: 8 }, () => swamp.name) },
              ],
            },
      },
    ),
  };
}
