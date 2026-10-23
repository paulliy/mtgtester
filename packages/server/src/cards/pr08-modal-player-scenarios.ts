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
    throw new Error(`PR08 modal Oracle pin drift: ${entry.card.name}`);
const selectedShadrix = pinned.cards.find((entry) => entry.card.name === 'Shadrix Silverquill');
const selectedLich = pinned.cards.find((entry) => entry.card.name === 'Vindictive Lich');
if (selectedShadrix === undefined || selectedLich === undefined)
  throw new Error('Missing Shadrix Silverquill or Vindictive Lich Oracle pin');
const shadrixSource = selectedShadrix;
const lichSource = selectedLich;

const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
function basic(name: string): OracleCard {
  const card = coverage.find((entry) => entry.name === name);
  if (card === undefined) throw new Error(`Missing PR08 modal scenario basic ${name}`);
  return card;
}

function witness(name: string, typeLine = 'Creature — Bear'): OracleCard {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    ...basic('Forest'),
    oracleId: `lab-pr08-modal-${slug}`,
    scryfallId: `lab-pr08-modal-${slug}`,
    name,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine,
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

export const PR08_MODAL_PLAYER_SCENARIO_IDS = [
  'shadrix-viewer-distinct-combat-modes',
  'shadrix-viewer-decline-combat-modes',
  'vindictive-lich-viewer-distinct-two-modes',
  'vindictive-lich-viewer-distinct-three-modes',
] as const;
type ScenarioId = (typeof PR08_MODAL_PLAYER_SCENARIO_IDS)[number];

const details: Record<ScenarioId, { title: string; instructions: string[]; expected: string }> = {
  'shadrix-viewer-distinct-combat-modes': {
    title: 'Shadrix Silverquill: choose two combat modes for different players',
    instructions: [
      'Cast Shadrix Silverquill normally for {3}{W}{B}.',
      'Pass through the rest of your turn; on your next beginning of combat choose the Inkling and draw/life modes.',
      'Target P2 for the Inkling and P3 for the draw and life loss.',
    ],
    expected:
      'Shadrix enters normally and gains flying and double strike; at the next beginning of combat P2 gets an Inkling and P3 draws a card and loses 1 life.',
  },
  'shadrix-viewer-decline-combat-modes': {
    title: 'Shadrix Silverquill: decline the beginning-of-combat modes',
    instructions: [
      'Cast Shadrix Silverquill normally for {3}{W}{B}.',
      'At your next beginning of combat, choose no modes.',
    ],
    expected:
      'Shadrix enters normally with flying and double strike; declining its optional modes creates no Inkling and changes no opponent life total.',
  },
  'vindictive-lich-viewer-distinct-two-modes': {
    title: 'Vindictive Lich: remove it, then choose two distinct opponents',
    instructions: [
      'Cast Vindictive Lich normally for {3}{B}.',
      'P2 casts Go for the Throat at normal cost to kill the Lich, causing its dies trigger.',
      'Choose discard two targeting P2 and lose 5 life targeting P3.',
    ],
    expected:
      'After an opponent’s Go for the Throat kills it, Vindictive Lich makes P2 discard two cards and P3 lose 5 life; the two modes target different opponents.',
  },
  'vindictive-lich-viewer-distinct-three-modes': {
    title: 'Vindictive Lich: all three modes target different opponents',
    instructions: [
      'Cast Vindictive Lich normally for {3}{B}.',
      'P2 casts Go for the Throat at normal cost to kill the Lich, causing its dies trigger.',
      'Choose sacrifice targeting P2, discard two targeting P3, and lose 5 life targeting P4.',
    ],
    expected:
      'After Go for the Throat kills Vindictive Lich, P2 sacrifices a creature, P3 discards two cards, and P4 loses 5 life; each mode targets a different opponent.',
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

function lichOpponent(lichObjectId: () => string | undefined): DecisionProvider {
  return {
    decide(request: DecisionRequest) {
      const id = lichObjectId();
      let action = request.legalActions.find(
        (candidate) =>
          request.decisionType === 'priority' &&
          id !== undefined &&
          candidate.type === 'castSpell' &&
          candidate.description.startsWith('Cast Go for the Throat') &&
          candidate.targets?.some((slot) => slot.options.includes(id)),
      );
      let targets: Array<{ slot: number; choice: string }> | undefined;
      if (action !== undefined) {
        const slot = action.targets?.[0];
        if (slot === undefined)
          throw new Error('Go for the Throat omitted its creature target slot');
        if (id === undefined)
          throw new Error('Vindictive Lich left the battlefield before the removal action');
        const targetId = id;
        targets = [{ slot: slot.slot, choice: targetId }];
      }
      action ??=
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      return {
        requestId: request.requestId,
        actionId: action.id,
        ...(targets === undefined ? {} : { targets }),
      };
    },
  };
}

export function pr08ModalPlayerScenario(id: string, gameId: GameId): CardTestScenario {
  const detail = details[id as ScenarioId];
  if (detail === undefined) throw new Error(`Unknown PR08 modal-player scenario ${id}`);
  const isShadrix = id.startsWith('shadrix-');
  const lichThree = id === PR08_MODAL_PLAYER_SCENARIO_IDS[3];
  const plains = basic('Plains');
  const swamp = basic('Swamp');
  const forest = basic('Forest');
  const removal = coverage.find((card) => card.name === 'Go for the Throat');
  if (!isShadrix && removal === undefined)
    throw new Error('Missing Go for the Throat from coverage fixture');
  const p1Creature = witness('Lab P1 Lich Witness');
  const p2Victim = witness('Lab P2 Sacrifice Creature');
  const p2CardA = basic('Island');
  const p2CardB = basic('Forest');
  const p3CardA = basic('Plains');
  const p3CardB = basic('Forest');
  const island = basic('Island');
  const shadrixLands = [plains, swamp, forest, forest, forest];
  const lichLands = [swamp, forest, forest, forest];
  const opponentLands = [swamp, swamp, forest];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `card-lab-${seat}-pr08-modal-player`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [shadrixSource.card, lichSource.card, ...shadrixLands, ...lichLands, p1Creature]
        : seat === 'P2'
          ? [removal ?? forest, p2Victim, p2CardA, p2CardB, plains, forest, ...opponentLands]
          : seat === 'P3'
            ? [p3CardA, p3CardB, island, forest, plains]
            : [forest, plains],
  }));
  const p1Lands = isShadrix ? shadrixLands : lichLands;
  const p2LandCards = isShadrix ? [] : opponentLands;
  const battlefield = [
    { playerId: 'P1' as const, cardNames: p1Lands.map((card) => card.name) },
    ...(!isShadrix && lichThree ? [{ playerId: 'P1' as const, cardNames: [p1Creature.name] }] : []),
    ...(!isShadrix
      ? [
          { playerId: 'P2' as const, cardNames: [p2Victim.name] },
          { playerId: 'P2' as const, cardNames: p2LandCards.map((card) => card.name) },
        ]
      : []),
  ];
  const hand = isShadrix
    ? [{ playerId: 'P1' as const, cardNames: ['Shadrix Silverquill'] }]
    : [
        { playerId: 'P1' as const, cardNames: ['Vindictive Lich'] },
        { playerId: 'P2' as const, cardNames: ['Go for the Throat', 'Island', 'Forest'] },
        ...(lichThree ? [{ playerId: 'P3' as const, cardNames: ['Plains', 'Forest'] }] : []),
      ];
  const engine = new Engine(
    { gameId, seed: `card-lab-${id}-v1`, players, turnCap: 3 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand,
        battlefield,
        libraryTop: [
          { playerId: 'P2', cardNames: ['Plains', 'Forest'] },
          { playerId: 'P3', cardNames: ['Island', 'Forest'] },
        ],
        ...(isShadrix ? { continueThroughCombat: true } : {}),
      },
    },
  );
  const lichObjectId = () =>
    engine.getState().battlefield.find((permanent) => permanent.name === 'Vindictive Lich')?.id;
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
      oracleSha256: isShadrix ? shadrixSource.sha256 : lichSource.sha256,
      clauseIds: isShadrix
        ? ['shadrix-combat-distinct-modes', 'shadrix-flying-double-strike']
        : ['lich-death-distinct-modes'],
    },
    seed: `card-lab-${id}-v1`,
    seats,
    engine,
    decisionProviderOverrides: {
      P2: isShadrix ? passing() : lichOpponent(lichObjectId),
      P3: passing(),
      P4: passing(),
    },
  };
}
