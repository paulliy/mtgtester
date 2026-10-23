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

const duress = fromPin('Duress');
const thoughtseize = fromPin('Thoughtseize');
const confidant = fromPin('Dark Confidant');
const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;

const cards = [
  {
    id: 'duress-viewer',
    card: duress.card,
    sha256: duress.sha256,
    title: 'Duress: reveal P2’s hand and choose a noncreature, nonland card',
    clauseIds: ['duress-c01'],
  },
  {
    id: 'thoughtseize-viewer',
    card: thoughtseize.card,
    sha256: thoughtseize.sha256,
    title: 'Thoughtseize: discard a nonland card and lose 2 life',
    clauseIds: ['thoughtseize-c01'],
  },
  {
    id: 'dark-confidant-viewer',
    card: confidant.card,
    sha256: confidant.sha256,
    title: 'Dark Confidant: reveal the top card at your upkeep',
    clauseIds: ['dark-confidant-c01'],
  },
] as const;

export const WHITE_BLACK_HAND_SCENARIO_IDS = cards.map((entry) => entry.id);

function witness(
  name: string,
  options: { typeLine: string; types: string[]; cmc?: number; manaCost?: string },
): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    ...plains,
    oracleId: `lab-white-black-${slug}`,
    scryfallId: `lab-white-black-${slug}`,
    name,
    manaCost: options.manaCost ?? '{2}',
    cmc: options.cmc ?? 2,
    colors: [],
    colorIdentity: [],
    typeLine: options.typeLine,
    supertypes: [],
    types: options.types,
    subtypes: [],
    oracleText: '',
    power: options.types.includes('Creature') ? '2' : null,
    toughness: options.types.includes('Creature') ? '2' : null,
    keywords: [],
    isBasicLand: false,
  };
}

export function whiteBlackControlHandScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = cards.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control scenario ${id}`);

  const creature = witness('Lab P2 Creature', { typeLine: 'Creature — Bear', types: ['Creature'] });
  const artifact = witness('Lab P2 Artifact', { typeLine: 'Artifact', types: ['Artifact'] });
  const enchantment = witness('Lab P2 Enchantment', {
    typeLine: 'Enchantment',
    types: ['Enchantment'],
  });
  const land = witness('Lab P2 Land', { typeLine: 'Basic Land — Forest', types: ['Land'] });
  const revealed = witness('Lab Confidant Reveal', {
    typeLine: 'Artifact',
    types: ['Artifact'],
    cmc: 3,
    manaCost: '{3}',
  });
  const privateTop = witness('Lab Private Library Card', {
    typeLine: 'Creature — Bear',
    types: ['Creature'],
  });

  const name = entry.card.name;
  const spellMana = name === 'Duress' ? [swamp, plains] : [swamp, swamp, plains];
  const p1Deck = [entry.card, ...spellMana, revealed, privateTop];
  const p2Cards = name === 'Duress' ? [creature, land, artifact, enchantment] : [creature, land];
  const playerConfigs = [
    { id: 'P1', deckId: 'white-black-hand-P1', commanders: [], cards: p1Deck },
    {
      id: 'P2',
      deckId: 'white-black-hand-P2',
      commanders: [],
      cards: [...p2Cards, privateTop],
    },
  ];
  const testLandNames = spellMana.map((card) => card.name);

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions:
        name === 'Duress'
          ? ['Cast Duress targeting P2, then choose Lab P2 Artifact from the revealed hand.']
          : name === 'Thoughtseize'
            ? [
                'Cast Thoughtseize targeting P2, then choose Lab P2 Creature from the revealed hand.',
              ]
            : ['Cast Dark Confidant from your hand and pass through to your next upkeep.'],
      expectedOutcome:
        name === 'Duress'
          ? 'P2 reveals the four cards in their hand. You discard Lab P2 Artifact; their creature, land, and enchantment stay in hand, and the unnamed card in P2’s library remains private.'
          : name === 'Thoughtseize'
            ? 'P2 reveals Lab P2 Creature and Lab P2 Land. You choose the creature, P2 discards it, and you lose 2 life (40 to 38).'
            : 'After Dark Confidant is cast from hand, its next upkeep trigger reveals Lab Confidant Reveal (mana value 3), puts it into your hand without drawing it, and you lose 3 life (40 to 37).',
      oracleSha256: entry.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed: `card-lab-${id}-v1`,
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
      { gameId, seed: `card-lab-${id}-v1`, players: playerConfigs, turnCap: 2 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [
            { playerId: 'P1', cardNames: [entry.card.name] },
            ...(name === 'Duress'
              ? [{ playerId: 'P2', cardNames: p2Cards.map((card) => card.name) }]
              : name === 'Thoughtseize'
                ? [{ playerId: 'P2', cardNames: p2Cards.map((card) => card.name) }]
                : []),
          ],
          battlefield: [{ playerId: 'P1', cardNames: testLandNames }],
          libraryTop: [
            { playerId: 'P1', cardNames: [revealed.name, privateTop.name] },
            ...(name === 'Dark Confidant'
              ? []
              : [{ playerId: 'P2', cardNames: [privateTop.name] }]),
          ],
          ...(name === 'Dark Confidant' ? { continueThroughUpkeeps: 2 } : {}),
        },
      },
    ),
  };
}
