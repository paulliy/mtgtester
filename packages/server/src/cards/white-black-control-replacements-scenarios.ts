import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { DecisionProvider } from '@mtg/engine';
import type { GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
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

const entries = [
  {
    id: 'planar-void-viewer-destroyed-permanent',
    source: fromPin('Planar Void'),
    title: 'Planar Void: normal cast, then exile a permanent destroyed by Generous Gift',
    clauseIds: ['planar-void-c01'],
    kind: 'planar-void' as const,
  },
  {
    id: 'library-of-leng-viewer-effect-discard-and-draw',
    source: fromPin('Library of Leng'),
    title: 'Library of Leng: cast, redirect an effect discard to the library top, then draw it',
    clauseIds: ['library-of-leng-c02'],
    kind: 'library-of-leng' as const,
  },
  {
    id: 'leyline-of-the-void-viewer-opening-hand-and-destruction',
    source: fromPin('Leyline of the Void'),
    title:
      'Leyline of the Void: choose its opening-hand action, then exile a destroyed opponent land',
    clauseIds: ['leyline-of-the-void-c01', 'leyline-of-the-void-c02'],
    kind: 'leyline-of-the-void' as const,
  },
] as const;

export const WHITE_BLACK_REPLACEMENTS_SCENARIO_IDS = entries.map((entry) => entry.id);

function p2ThoughtseizeProvider(): DecisionProvider {
  let cast = false;
  return {
    decide(request) {
      const p2Main =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const spell =
        p2Main && !cast
          ? request.legalActions.find(
              (action) =>
                action.type === 'castSpell' && action.description.startsWith('Cast Thoughtseize'),
            )
          : undefined;
      if (spell !== undefined) {
        cast = true;
        const targets = (spell.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: slot.options.includes('P1' as PlayerId) ? ('P1' as PlayerId) : slot.options[0]!,
        }));
        return {
          requestId: request.requestId,
          actionId: spell.id,
          ...(targets.length > 0 ? { targets } : {}),
        };
      }
      const pass = request.legalActions.find((action) => action.type === 'pass');
      const action = pass ?? request.legalActions[0];
      if (action === undefined) throw new Error(`No legal P2 action for ${request.decisionType}`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function keepAndPlayLandsProvider(): DecisionProvider {
  return {
    decide(request) {
      if (request.decisionType === 'mulligan') {
        const keep = request.legalActions.find((action) => /keep/i.test(action.description));
        if (keep !== undefined) return { requestId: request.requestId, actionId: keep.id };
      }
      const land = request.legalActions.find((action) => action.type === 'playLand');
      if (land !== undefined) return { requestId: request.requestId, actionId: land.id };
      const pass = request.legalActions.find((action) => action.type === 'pass');
      const action = pass ?? request.legalActions[0];
      if (action === undefined) throw new Error(`No legal ${request.decidingPlayer} action`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function seats(cards: Record<PlayerId, OracleCard[]>, suffix: string) {
  return (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => {
    const seatCards = cards[seat];
    if (seatCards === undefined) throw new Error(`Missing deck cards for ${seat}`);
    const config = {
      id: seat,
      deckId: `white-black-replacements-${suffix}-${seat}`,
      commanders: [],
      cards: seatCards,
    };
    return {
      seat,
      config,
      deckSnapshotId: null,
      summary: {
        seat,
        deckId: config.deckId,
        label: seat,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    };
  });
}

function preparedScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined)
    throw new Error(`Unknown white-black-control replacement scenario ${id}`);

  if (entry.kind === 'planar-void') {
    const gift = fromPin('Generous Gift');
    const solRing = fromPin('Sol Ring').card;
    const configs = seats(
      {
        P1: [entry.source.card, gift.card, swamp, ...Array.from({ length: 8 }, () => plains)],
        P2: [solRing, ...Array.from({ length: 10 }, () => plains)],
        P3: Array.from({ length: 10 }, () => plains),
        P4: Array.from({ length: 10 }, () => plains),
      },
      entry.id,
    );
    const battlefield = [
      { playerId: 'P1', cardNames: [swamp.name, plains.name, plains.name, plains.name] },
      { playerId: 'P2', cardNames: [solRing.name] },
    ];
    const engine = new Engine(
      {
        gameId,
        seed: `card-lab-${id}-v1`,
        players: configs.map(({ config }) => config),
        turnCap: 5,
      },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 2,
          hand: [{ playerId: 'P1', cardNames: [entry.source.card.name, gift.card.name] }],
          battlefield,
        },
      },
    );
    return {
      metadata: {
        id,
        version: 1,
        title: entry.title,
        instructions: [
          'Cast Planar Void from your hand normally for {B}.',
          'Cast Generous Gift normally for {2}{W}, targeting P2’s Sol Ring. The permanent should be exiled by Planar Void after it is destroyed; Generous Gift should also be exiled when the spell card reaches P1’s graveyard.',
        ],
        expectedOutcome:
          'Planar Void is normally cast. Generous Gift destroys P2’s real Sol Ring; the triggered ability exiles that card. The resolving Generous Gift card is also put into exile after reaching P1’s graveyard.',
        oracleSha256: entry.source.sha256,
        clauseIds: [...entry.clauseIds],
      },
      seed: `card-lab-${id}-v1`,
      seats: configs,
      engine,
      decisionProviderOverrides: {},
    };
  }

  if (entry.kind === 'library-of-leng') {
    const duress = fromPin('Duress').card;
    const thoughtseize = fromPin('Thoughtseize').card;
    const configs = seats(
      {
        P1: [
          entry.source.card,
          duress,
          ...Array.from({ length: 8 }, () => plains),
          ...Array.from({ length: 4 }, () => swamp),
        ],
        P2: [
          thoughtseize,
          ...Array.from({ length: 8 }, () => swamp),
          ...Array.from({ length: 8 }, () => plains),
        ],
        P3: Array.from({ length: 10 }, () => plains),
        P4: Array.from({ length: 10 }, () => plains),
      },
      entry.id,
    );
    const engine = new Engine(
      {
        gameId,
        seed: `card-lab-${id}-v1`,
        players: configs.map(({ config }) => config),
        turnCap: 8,
      },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [
            { playerId: 'P1', cardNames: [entry.source.card.name, duress.name] },
            { playerId: 'P2', cardNames: [thoughtseize.name] },
          ],
          battlefield: [
            { playerId: 'P1', cardNames: [plains.name] },
            { playerId: 'P2', cardNames: [swamp.name] },
          ],
          continueThroughPrecombatMains: 4,
        },
      },
    );
    return {
      metadata: {
        id,
        version: 1,
        title: entry.title,
        instructions: [
          'Cast Library of Leng normally for {1}.',
          'On P2’s turn, P2 normally casts Thoughtseize targeting you. Choose the real Duress in your hand, then choose the Library of Leng option to put it on top of your library.',
          'Pass through the intervening turns. On your next turn, draw the same Duress normally from your library.',
        ],
        expectedOutcome:
          'Library of Leng is normally cast. Thoughtseize causes a real effect discard; P1 chooses to put Duress on top of the library instead of into the graveyard. The next production draw step puts that same Duress card back into P1’s hand.',
        oracleSha256: entry.source.sha256,
        clauseIds: [...entry.clauseIds],
      },
      seed: `card-lab-${id}-v1`,
      seats: configs,
      engine,
      decisionProviderOverrides: { P2: p2ThoughtseizeProvider() },
    };
  }

  const gift = fromPin('Generous Gift');
  const configurations = seats(
    {
      P1: [
        ...Array.from({ length: 25 }, () => entry.source.card),
        ...Array.from({ length: 25 }, () => gift.card),
        ...Array.from({ length: 50 }, () => plains),
      ],
      P2: Array.from({ length: 100 }, () => plains),
      P3: Array.from({ length: 100 }, () => plains),
      P4: Array.from({ length: 100 }, () => plains),
    },
    entry.id,
  );
  const engine = new Engine({
    gameId,
    seed: 'leyline-viewer-1',
    players: configurations.map(({ config }) => config),
    turnCap: 12,
  });
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        'Keep P1’s opening hand. Choose the actual “Begin with Leyline of the Void on the battlefield” opening-hand action; do not cast Leyline.',
        'Play three Plains normally over your turns, then normally cast Generous Gift targeting a Plains on P2’s battlefield.',
        'Leyline should exile the P2-owned land card when Generous Gift destroys it. Generous Gift creates its printed Elephant token under P2.',
      ],
      expectedOutcome:
        'Leyline of the Void moves from P1’s kept opening hand to the battlefield through its optional opening-hand action. Generous Gift is normally cast and destroys a P2-owned Plains; Leyline replaces that opponent-owned card’s graveyard move with exile.',
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed: 'leyline-viewer-1',
    seats: configurations,
    engine,
    decisionProviderOverrides: {
      P2: keepAndPlayLandsProvider(),
      P3: keepAndPlayLandsProvider(),
      P4: keepAndPlayLandsProvider(),
    },
  };
}

export function whiteBlackControlReplacementsScenario(
  id: string,
  gameId: GameId,
): CardTestScenario {
  return preparedScenario(id, gameId);
}
