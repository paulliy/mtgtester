import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import type { OracleCard } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig, oracle } from '../../../engine/tests/fixtures';

const TOLL = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../engine/tests/fixtures/coverage-pr07-oracle.json'),
      'utf8',
    ),
  ) as { cards: { card: OracleCard }[] }
).cards.find((entry) => entry.card.name === "War's Toll")!.card;
const BEAR = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

describe("attack declaration under War's Toll with a bot seat", () => {
  it('a heuristic bot attacks with every able creature or with none, whatever it proposed first', () => {
    const engine = new Engine(
      gameConfig([
        { cards: [TOLL, ...copies(8, forest)] },
        { cards: [BEAR('Bot Bear'), BEAR('Bot Cub'), ...copies(8, forest)] },
      ]),
      {
        preparedScenario: {
          currentTurnPlayer: 'P2',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          hand: [],
          battlefield: [
            { playerId: 'P1', cardNames: [TOLL.name] },
            { playerId: 'P2', cardNames: ['Bot Bear', 'Bot Cub'] },
          ],
          continueThroughCombat: true,
        },
      },
    );
    for (let steps = 0; steps < 120; steps++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      const bot = new HeuristicDecisionProvider('toll-bot', () =>
        engine.view(request.decidingPlayer),
      );
      const response = bot.decide(request);
      expect(request.legalActions.some((action) => action.id === response.actionId)).toBe(true);
      engine.submit(response);
    }
    const attacks = engine.getState().eventLog.filter((event) => event.type === 'attack').length;
    // Never one of the two on its own.
    expect([0, 2]).toContain(attacks);
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });
});
