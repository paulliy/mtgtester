import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/transformed-dfc-copy-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
for (const pin of pins.cards)
  if (createHash('sha256').update(JSON.stringify(pin.card)).digest('hex') !== pin.sha256)
    throw new Error(`Transformed DFC Oracle fixture drift: ${pin.card.name}`);
const pinned = (name: string) => {
  const pin = pins.cards.find((entry) => entry.card.name === name);
  if (!pin) throw new Error(`Missing transformed DFC Oracle pin: ${name}`);
  return pin;
};
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const land = (name: string): OracleCard => {
  const card = coverage.find((entry) => entry.name === name);
  if (!card) throw new Error(`Missing transformed DFC lab land: ${name}`);
  return card;
};

export const TRANSFORMED_DFC_CASES = [
  {
    id: 'brigid-viewer-token-copy-back',
    title: 'Brigid: token copy of the transformed back face',
    transformed: true,
    token: true,
  },
  {
    id: 'brigid-viewer-token-copy-front',
    title: 'Brigid: token copy of the ordinary front face',
    transformed: false,
    token: true,
  },
  {
    id: 'brigid-viewer-ordinary-copy-back',
    title: 'Brigid: ordinary creature copy of the transformed back face',
    transformed: true,
    token: false,
  },
] as const;
export const TRANSFORMED_DFC_SCENARIO_IDS: string[] = TRANSFORMED_DFC_CASES.map(({ id }) => id);

/** Only the starting face is arranged; the copy is cast, paid for and resolved normally. */
export function transformedDfcScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = TRANSFORMED_DFC_CASES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown transformed DFC scenario: ${id}`);
  const brigid = pinned("Brigid, Clachan's Heart // Brigid, Doun's Mind");
  const copying = pinned(entry.token ? 'Quantum Misalignment' : "Dack's Duplicate");
  const defense = pinned('Blossoming Defense');
  const companion: OracleCard = {
    ...land('Forest'),
    oracleId: 'lab-copy-companion',
    scryfallId: 'lab-copy-companion',
    name: 'Copy Companion',
    typeLine: 'Creature — Bear',
    types: ['Creature'],
    subtypes: ['Bear'],
    supertypes: [],
    isBasicLand: false,
    manaCost: '{99}',
    cmc: 99,
    oracleText: '',
    power: '1',
    toughness: '1',
  };
  const mana = entry.token
    ? [land('Island'), ...Array.from({ length: 4 }, () => land('Forest'))]
    : [land('Island'), land('Mountain'), land('Forest'), land('Forest')];
  const owner = entry.token ? 'P1' : 'P2';
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `transformed-dfc-lab-${seat}`,
    commanders: [],
    cards: [
      land('Plains'),
      ...(seat === 'P1'
        ? [copying.card, ...mana, ...(!entry.token ? [defense.card, companion] : [])]
        : []),
      ...(seat === owner ? [brigid.card] : []),
    ],
  }));
  const seed = `card-lab-${id}-v1`;
  return {
    metadata: {
      id,
      version: entry.token ? 1 : 2,
      title: entry.title,
      instructions: [
        `Cast ${copying.card.name} from your hand and complete its mana payment.`,
        `Choose ${entry.transformed ? "Brigid, Doun's Mind" : "Brigid, Clachan's Heart"} as the copy.`,
        'Pass priority to resolve the spell, then inspect the copied face and abilities.',
        ...(!entry.token
          ? [
              'Cast Blossoming Defense on Copy Companion; only the hasty copied Brigid can supply its {G}.',
            ]
          : []),
      ],
      expectedOutcome: entry.transformed
        ? 'The copy is Brigid, Doun’s Mind, a green 3/2 Kithkin Soldier with the back-face mana and transform abilities; no front-face Kithkin entry trigger fires.'
        : 'The copy is Brigid, Clachan’s Heart, a white 3/2 Kithkin Warrior, and its front-face entry trigger creates one Kithkin.',
      oracleSha256: brigid.sha256,
      clauseIds: [
        entry.transformed
          ? 'brigid-copy-back-characteristics'
          : 'brigid-copy-front-characteristics',
        entry.token ? 'transforming-token-copies-both-faces' : 'ordinary-copy-is-single-faced',
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
      { gameId, seed, players, turnCap: 2 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [
            {
              playerId: 'P1',
              cardNames: [copying.card.name, ...(!entry.token ? [defense.card.name] : [])],
            },
          ],
          battlefield: [
            { playerId: 'P1', cardNames: mana.map((card) => card.name) },
            ...(!entry.token ? [{ playerId: 'P1' as const, cardNames: [companion.name] }] : []),
            { playerId: owner, cardNames: [brigid.card.name], transformed: entry.transformed },
          ],
        },
      },
    ),
  };
}
