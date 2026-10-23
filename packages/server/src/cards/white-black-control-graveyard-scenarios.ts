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

function fromPin(name: string): { sha256: string; card: OracleCard } {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing white-black-control Oracle pin: ${name}`);
  if (createHash('sha256').update(canonical(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`White-black-control Oracle fixture drift: ${name}`);
  return entry;
}

const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;

const scenarios = [
  {
    id: 'rest-in-peace-viewer',
    source: fromPin('Rest in Peace'),
    title: 'Rest in Peace: exile existing graveyards, then exile a creature destroyed later',
    clauseIds: ['rest-in-peace-c01', 'rest-in-peace-c02'],
    kind: 'rest-in-peace' as const,
  },
  {
    id: 'stone-of-erech-viewer-activation',
    source: fromPin('Stone of Erech'),
    title: 'Stone of Erech: cast, pay {2}, sacrifice it, exile P2’s graveyard, and draw',
    clauseIds: ['stone-of-erech-c02'],
    kind: 'stone-activation' as const,
  },
  {
    id: 'stone-of-erech-viewer-opponent-creature-death',
    source: fromPin('Stone of Erech'),
    title: 'Stone of Erech: a normally cast destroy spell exiles P2’s creature instead',
    clauseIds: ['stone-of-erech-c01'],
    kind: 'stone-replacement' as const,
  },
] as const;

export const WHITE_BLACK_GRAVEYARD_SCENARIO_IDS = scenarios.map((scenario) => scenario.id);

function witness(
  name: string,
  options: {
    typeLine: string;
    types: string[];
    manaCost?: string | null;
    cmc?: number;
    oracleText?: string;
    power?: string | null;
    toughness?: string | null;
    colors?: OracleCard['colors'];
  },
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
    manaCost: options.manaCost === undefined ? '{0}' : options.manaCost,
    cmc: options.cmc ?? 0,
    colors: options.colors ?? [],
    colorIdentity: options.colors ?? [],
    typeLine: options.typeLine,
    supertypes: [],
    types: options.types,
    subtypes: options.types.includes('Creature') ? ['Bear'] : [],
    oracleText: options.oracleText ?? '',
    power:
      options.power === undefined
        ? options.types.includes('Creature')
          ? '2'
          : null
        : options.power,
    toughness:
      options.toughness === undefined
        ? options.types.includes('Creature')
          ? '2'
          : null
        : options.toughness,
    keywords: [],
    isBasicLand: false,
  };
}

const destroySpell = witness('Lab Prepared Doom', {
  typeLine: 'Instant',
  types: ['Instant'],
  manaCost: '{B}',
  cmc: 1,
  colors: ['B'],
  oracleText: 'Destroy target creature.',
});

const p2Creature = witness('Lab P2 Creature to Destroy', {
  typeLine: 'Creature — Bear',
  types: ['Creature'],
  power: '2',
  toughness: '2',
});

const p1GraveyardCard = witness('Lab P1 Existing Graveyard Card', {
  typeLine: 'Creature \u2014 Bear',
  types: ['Creature'],
  manaCost: '{0}',
  power: '2',
  toughness: '2',
});

const p2GraveyardCard = witness('Lab P2 Existing Graveyard Card', {
  typeLine: 'Creature \u2014 Bear',
  types: ['Creature'],
  manaCost: '{0}',
  power: '2',
  toughness: '2',
});

const p1KnownDraw = witness('Lab P1 Known Draw', {
  typeLine: 'Creature — Bear',
  types: ['Creature'],
  manaCost: '{0}',
});

export function whiteBlackControlGraveyardScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = scenarios.find((scenario) => scenario.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control graveyard scenario ${id}`);
  const isRest = entry.kind === 'rest-in-peace';
  const isStoneActivation = entry.kind === 'stone-activation';
  const p1Mana = isRest
    ? [plains, swamp, swamp]
    : isStoneActivation
      ? [swamp, swamp, swamp]
      : [swamp, swamp];
  const p1Cards = [
    entry.source.card,
    ...Array.from({ length: 8 }, () => plains),
    ...Array.from({ length: 8 }, () => swamp),
    ...(isRest || !isStoneActivation ? [destroySpell] : []),
    ...(isRest ? [p1GraveyardCard] : []),
    ...(isStoneActivation ? [p1KnownDraw] : []),
  ];
  const p2Cards = [
    ...Array.from({ length: 8 }, () => plains),
    ...Array.from({ length: 8 }, () => swamp),
    ...(isRest || !isStoneActivation ? [p2Creature] : []),
    ...(isRest || isStoneActivation || entry.kind === 'stone-replacement' ? [p2GraveyardCard] : []),
  ];
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-graveyard-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? p1Cards
        : seat === 'P2'
          ? p2Cards
          : [
              ...Array.from({ length: 10 }, () => plains),
              ...Array.from({ length: 10 }, () => swamp),
            ],
  }));
  const battlefield = [
    { playerId: 'P1', cardNames: p1Mana.map((land) => land.name) },
    ...(isRest || entry.kind === 'stone-replacement'
      ? [{ playerId: 'P2', cardNames: [p2Creature.name] }]
      : []),
  ];
  const hand = [
    {
      playerId: 'P1',
      cardNames: [
        entry.source.card.name,
        ...(isRest || !isStoneActivation ? [destroySpell.name] : []),
      ],
    },
  ];
  const graveyard = isRest
    ? [
        { playerId: 'P1', cardNames: [p1GraveyardCard.name] },
        { playerId: 'P2', cardNames: [p2GraveyardCard.name] },
      ]
    : entry.kind === 'stone-activation'
      ? [{ playerId: 'P2', cardNames: [p2GraveyardCard.name] }]
      : [{ playerId: 'P2', cardNames: [p2GraveyardCard.name] }];
  const libraryTop = isStoneActivation ? [{ playerId: 'P1', cardNames: [p1KnownDraw.name] }] : [];
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: configs,
      turnCap: 4,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 2,
        hand,
        battlefield,
        graveyard,
        ...(libraryTop.length > 0 ? { libraryTop } : {}),
      },
    },
  );

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isRest
        ? [
            'Cast Rest in Peace from your hand normally for {1}{W}; its enters trigger should exile the pre-existing P1 and P2 graveyards.',
            'Then cast Lab Prepared Doom normally for {B}, targeting Lab P2 Creature to Destroy. The creature should go to exile instead of P2’s graveyard.',
          ]
        : isStoneActivation
          ? [
              'Cast Stone of Erech normally for {1}.',
              'Activate it by paying {2}, tapping, and sacrificing it; target P2’s graveyard. Its cards should be exiled and Lab P1 Known Draw should be drawn.',
            ]
          : [
              'Cast Stone of Erech normally for {1}.',
              'Cast Lab Prepared Doom normally for {B}, targeting Lab P2 Creature to Destroy. Stone should replace that creature’s graveyard move with exile while P2’s older graveyard card remains there.',
            ],
      expectedOutcome: isRest
        ? 'Rest in Peace’s enters trigger exiles the seeded graveyard cards. A later normally cast destroy spell puts its creature target into exile through the active replacement effect.'
        : isStoneActivation
          ? 'Stone’s normal activated ability pays {2}, taps and sacrifices Stone, exiles the targeted player’s graveyard, then draws the known top card.'
          : 'Stone of Erech replaces the later opponent creature’s death with exile; the previously seeded graveyard card remains untouched.',
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed,
    seats: configs.map((config) => ({
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
    engine,
    decisionProviderOverrides: {},
  };
}
