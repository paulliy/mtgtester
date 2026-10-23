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

const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;
const solRing = fromPin('Sol Ring').card;
const mother = fromPin('Mother of Runes').card;
const archon = fromPin('Archon of Absolution').card;

const entries = [
  {
    id: 'curse-of-disturbance-viewer-two-attackers-one-zombie',
    source: fromPin('Curse of Disturbance'),
    title: 'Curse of Disturbance: two attackers on P2 create one controller Zombie',
    clauseIds: ['curse-of-disturbance-c01', 'curse-of-disturbance-c02'],
    kind: 'curse' as const,
  },
  {
    id: 'promise-of-loyalty-viewer-apnap-vow-and-sacrifice',
    source: fromPin('Promise of Loyalty'),
    title: 'Promise of Loyalty: each creature player keeps one and gets a public vow counter',
    clauseIds: ['promise-of-loyalty-c01'],
    kind: 'promise' as const,
  },
  {
    id: 'cloak-of-confusion-viewer-no-damage-random-discard',
    source: fromPin('Cloak of Confusion'),
    title: 'Cloak of Confusion: accept no combat damage to make P2 discard at random',
    clauseIds: ['cloak-of-confusion-c01', 'cloak-of-confusion-c02'],
    kind: 'cloak' as const,
  },
] as const;

export const WHITE_BLACK_REMAINING_COMBAT_SCENARIO_IDS = entries.map((entry) => entry.id);

function seats(cards: Record<PlayerId, OracleCard[]>, suffix: string) {
  return (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => {
    const deckCards = cards[seat];
    if (deckCards === undefined) throw new Error(`Missing ${seat} deck for ${suffix}`);
    const config = {
      id: seat,
      deckId: `white-black-remaining-combat-${suffix}-${seat}`,
      commanders: [],
      cards: deckCards,
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

function keepMotherProvider(): DecisionProvider {
  return {
    decide(request) {
      if (request.prompt === 'Choose a creature to keep and put a vow counter on.') {
        const keep = request.legalActions.find((action) =>
          action.description.includes(mother.name),
        );
        if (keep === undefined)
          throw new Error(`${request.decidingPlayer} has no Mother of Runes keep option`);
        return { requestId: request.requestId, actionId: keep.id };
      }
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (action === undefined) throw new Error(`No legal ${request.decidingPlayer} action`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function prepared(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control scenario ${id}`);

  if (entry.kind === 'curse') {
    const configs = seats(
      {
        P1: [entry.source.card, swamp, ...Array.from({ length: 5 }, () => plains), mother, archon],
        P2: Array.from({ length: 10 }, () => plains),
        P3: Array.from({ length: 10 }, () => plains),
        P4: Array.from({ length: 10 }, () => plains),
      },
      entry.id,
    );
    const seed = `card-lab-${id}-v1`;
    const engine = new Engine(
      { gameId, seed, players: configs.map(({ config }) => config), turnCap: 4 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 2,
          hand: [{ playerId: 'P1', cardNames: [entry.source.card.name] }],
          battlefield: [
            { playerId: 'P1', cardNames: [swamp.name, plains.name, plains.name] },
            { playerId: 'P1', cardNames: [mother.name, archon.name] },
          ],
          continueThroughCombat: true,
        },
      },
    );
    return {
      metadata: {
        id,
        version: 1,
        title: entry.title,
        instructions: [
          'Cast Curse of Disturbance normally, choosing P2 as the enchanted player.',
          'Declare both P1 creatures attacking P2, then let combat continue.',
        ],
        expectedOutcome:
          'P1 attacks the enchanted player with two creatures. The attack event creates one 2/2 Zombie for the curse controller, not one per attacker.',
        oracleSha256: entry.source.sha256,
        clauseIds: [...entry.clauseIds],
      },
      seed,
      seats: configs,
      engine,
    };
  }

  if (entry.kind === 'promise') {
    const perPlayer = [mother.name, archon.name];
    const configs = seats(
      {
        P1: [entry.source.card, ...Array.from({ length: 5 }, () => plains), mother, archon],
        P2: [
          ...perPlayer.map((name) => (name === mother.name ? mother : archon)),
          ...Array.from({ length: 10 }, () => plains),
        ],
        P3: [
          ...perPlayer.map((name) => (name === mother.name ? mother : archon)),
          ...Array.from({ length: 10 }, () => plains),
        ],
        P4: [
          ...perPlayer.map((name) => (name === mother.name ? mother : archon)),
          ...Array.from({ length: 10 }, () => plains),
        ],
      },
      entry.id,
    );
    const seed = `card-lab-${id}-v1`;
    const engine = new Engine(
      { gameId, seed, players: configs.map(({ config }) => config), turnCap: 4 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 2,
          hand: [{ playerId: 'P1', cardNames: [entry.source.card.name] }],
          battlefield: [
            { playerId: 'P1', cardNames: Array.from({ length: 5 }, () => plains.name) },
            ...(['P1', 'P2', 'P3', 'P4'] as const).map((playerId) => ({
              playerId,
              cardNames: perPlayer,
            })),
          ],
        },
      },
    );
    return {
      metadata: {
        id,
        version: 1,
        title: entry.title,
        instructions: [
          'Cast Promise of Loyalty normally for {4}{W}.',
          'Choose one creature you control to keep and put a vow counter on; the other creature is sacrificed. The other players choose in APNAP order.',
        ],
        expectedOutcome:
          'Each of P1, P2, P3, and P4 keeps one creature and sacrifices the other. Each kept creature visibly has one vow counter.',
        oracleSha256: entry.source.sha256,
        clauseIds: [...entry.clauseIds],
      },
      seed,
      seats: configs,
      engine,
      decisionProviderOverrides: {
        P2: keepMotherProvider(),
        P3: keepMotherProvider(),
        P4: keepMotherProvider(),
      },
    };
  }

  const configs = seats(
    {
      P1: [entry.source.card, ...Array.from({ length: 5 }, () => plains), swamp, mother],
      P2: [plains, swamp, solRing, ...Array.from({ length: 8 }, () => plains)],
      P3: Array.from({ length: 10 }, () => plains),
      P4: Array.from({ length: 10 }, () => plains),
    },
    entry.id,
  );
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: configs.map(({ config }) => config), turnCap: 4 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 2,
        hand: [
          { playerId: 'P1', cardNames: [entry.source.card.name] },
          { playerId: 'P2', cardNames: [plains.name, swamp.name, solRing.name] },
        ],
        battlefield: [
          { playerId: 'P1', cardNames: [plains.name, swamp.name] },
          { playerId: 'P1', cardNames: [mother.name] },
        ],
        continueThroughCombat: true,
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        'Cast Cloak of Confusion normally, targeting your Mother of Runes.',
        'Attack P2 with the enchanted creature. With no blocker, accept the option to assign no combat damage.',
      ],
      expectedOutcome:
        'P2 discards one random card from hand. The accepted option assigns no combat damage, so P2’s life total remains unchanged.',
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed,
    seats: configs,
    engine,
  };
}

export function whiteBlackControlRemainingCombatScenario(
  id: string,
  gameId: GameId,
): CardTestScenario {
  return prepared(id, gameId);
}
