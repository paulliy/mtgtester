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
          .sort(([a], [b]) => a.localeCompare(b))
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

const breena = fromPin('Breena, the Demagogue');
const heritage = fromPin("Duelist's Heritage");
const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;

const cards = [
  {
    id: 'breena-viewer-opponent-life-aggregate',
    card: breena.card,
    sha256: breena.sha256,
    title: 'Breena: aggregate attacks and compare defending-opponent life',
    clauseIds: ['breena-the-demagogue-c02'],
  },
  {
    id: 'duelists-heritage-viewer-single-optional-target',
    card: heritage.card,
    sha256: heritage.sha256,
    title: "Duelist's Heritage: one optional double-strike target",
    clauseIds: ['duelist-s-heritage-c01'],
  },
] as const;

export const WHITE_BLACK_COMBAT_SCENARIO_IDS = cards.map((entry) => entry.id);

function witness(name: string): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    ...plains,
    oracleId: `lab-white-black-${slug}`,
    scryfallId: `lab-white-black-${slug}`,
    name,
    manaCost: '{2}',
    cmc: 2,
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

export function whiteBlackControlCombatScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = cards.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control scenario ${id}`);

  const alpha = witness('Lab Attack Witness Alpha');
  const beta = witness('Lab Attack Witness Beta');
  const defenders = ['P2', 'P3', 'P4'].map((seat) => witness(`Lab ${seat} Defender`));
  const mana =
    entry.card.name === 'Breena, the Demagogue' ? [plains, swamp, plains] : [plains, plains, swamp];
  const draw = witness('Lab Breena Draw');
  const deckCards = [entry.card, ...mana, alpha, beta, draw, ...defenders];
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-combat-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? deckCards
        : [...mana.slice(0, 1), defenders[(['P2', 'P3', 'P4'] as const).indexOf(seat)]!],
  }));
  const seed = `card-lab-${id}-v1`;
  const testLandNames = mana.map((land) => land.name);

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        `Cast ${entry.card.name} from your hand and let it resolve.`,
        'Declare both Lab Attack Witnesses attacking P2.',
        entry.card.name === 'Breena, the Demagogue'
          ? 'Resolve the single Breena trigger and target a creature you control.'
          : "Accept Duelist's Heritage's optional trigger and target one attacking creature.",
        'Let combat finish.',
      ],
      expectedOutcome:
        entry.card.name === 'Breena, the Demagogue'
          ? 'The two attackers cause one trigger because they attack the same opponent. P2 has more life than P3 and P4, so P1 draws exactly one card and one creature P1 controls receives two +1/+1 counters.'
          : 'One trigger is created for the two attackers. Accepting the optional ability gives double strike to the single selected attacker; the other attacker remains unchanged.',
      oracleSha256: entry.sha256,
      clauseIds: [...entry.clauseIds],
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
          lifeTotals: [
            { playerId: 'P2', life: 45 },
            { playerId: 'P3', life: 40 },
            { playerId: 'P4', life: 40 },
          ],
          hand: [{ playerId: 'P1', cardNames: [entry.card.name] }],
          libraryTop: [{ playerId: 'P1', cardNames: [draw.name] }],
          battlefield: [
            { playerId: 'P1', cardNames: testLandNames },
            { playerId: 'P1', cardNames: [alpha.name, beta.name] },
            { playerId: 'P2', cardNames: [defenders[0]!.name], tapped: true },
            { playerId: 'P3', cardNames: [defenders[1]!.name], tapped: true },
            { playerId: 'P4', cardNames: [defenders[2]!.name], tapped: true },
          ],
          continueThroughCombat: true,
        },
      },
    ),
  };
}
