import { readFileSync } from 'node:fs';
import { sha256 } from '../benchmark/hash';
import { Engine } from '@mtg/engine';
import type { DecisionProvider, EnginePlayerConfig } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

/**
 * Coverage PR08.01 (docs/plans/card-coverage-chunks.md 8.01): Cut a Deal.
 *
 * Both scenarios run the same {2}{W} spell through the production cast/priority stack from an
 * arranged precombat-main window. The DIFFERENCE is only in P3's library:
 *  - full-draw: every opponent draws, so the caster draws three.
 *  - empty-library: P3's library is empty when the spell resolves, so P3's instruction draws
 *    nothing (the empty-library flag is not a draw), the caster draws only two, and P3 loses
 *    at the next state-based action check — after the spell has finished resolving, never
 *    inside it (brief §5.6).
 */
const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
for (const entry of fixture.cards) {
  if (sha256(entry.card) !== entry.sha256)
    throw new Error(`Cut a Deal Oracle pin drift: ${entry.card.name}`);
}
const selectedCutADeal = fixture.cards.find((entry) => entry.card.name === 'Cut a Deal');
if (selectedCutADeal === undefined) throw new Error('Missing Cut a Deal Oracle pin');
const cutADeal = selectedCutADeal;

const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const basic = (name: string) => {
  const found = coverage.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing Cut a Deal basic ${name}`);
  return found;
};

export const PR08_CUT_A_DEAL_SCENARIO_IDS = [
  'cut-a-deal-viewer-full-draw',
  'cut-a-deal-viewer-empty-library',
] as const;
type ScenarioId = (typeof PR08_CUT_A_DEAL_SCENARIO_IDS)[number];
const isScenarioId = (id: string): id is ScenarioId =>
  (PR08_CUT_A_DEAL_SCENARIO_IDS as readonly string[]).includes(id);
const details: Record<ScenarioId, { title: string; instructions: string[]; expected: string }> = {
  'cut-a-deal-viewer-full-draw': {
    title: 'Cut a Deal: each opponent draws, then you draw three',
    instructions: [
      'Cast Cut a Deal with Plains, Island, and Island; pass so it resolves.',
      'Confirm that P2, P3, and P4 each draw a card, then you draw three.',
    ],
    expected:
      'P2, P3, and P4 each end with one extra card in hand and you end with three cards in hand.',
  },
  'cut-a-deal-viewer-empty-library': {
    title: 'Cut a Deal: an empty library draws nothing and you draw two',
    instructions: [
      'Cast Cut a Deal with Plains, Island, and Island; pass so it resolves.',
      'P3 has no library left: confirm P2 and P4 draw, P3 draws nothing, and you draw only two.',
    ],
    expected:
      'P2 and P4 each end with one extra card in hand, P3 ends with none, and you end with two cards in hand.',
  },
};

export function pr08CutADealScenarioSubject(id: string): string {
  if (!isScenarioId(id)) throw new Error(`Unknown Cut a Deal scenario ${id}`);
  return 'Cut a Deal';
}

function passing(): DecisionProvider {
  return {
    decide(request) {
      const a = request.legalActions.find((x) => x.type === 'pass') ?? request.legalActions[0]!;
      return { requestId: request.requestId, actionId: a.id };
    },
  };
}

export function pr08CutADealScenario(id: string, gameId: GameId): CardTestScenario {
  if (!isScenarioId(id)) throw new Error(`Unknown Cut a Deal scenario ${id}`);
  const detail = details[id];
  const emptyLibrary = id === 'cut-a-deal-viewer-empty-library';
  const opponentBasics = Array.from({ length: 4 }, () => basic('Forest'));
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `card-lab-${seat}-cut-a-deal`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [
            cutADeal.card,
            ...Array.from({ length: 4 }, () => basic('Plains')),
            ...Array.from({ length: 4 }, () => basic('Island')),
          ]
        : emptyLibrary && seat === 'P3'
          ? []
          : opponentBasics,
  }));
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players, turnCap: 2 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Cut a Deal'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Plains', 'Island', 'Island'] }],
      },
    },
  );
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
      oracleSha256: cutADeal.sha256,
      clauseIds: ['cut-a-deal-each-opponent-draws-then-you-draw-for-each-who-drew'],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: { P2: passing(), P3: passing(), P4: passing() },
  };
}
