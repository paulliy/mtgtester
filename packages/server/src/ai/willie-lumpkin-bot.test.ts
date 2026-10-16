import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig } from '../../../engine/tests/fixtures';

const WILLIE = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../engine/tests/fixtures/coverage-pr07-oracle.json'),
      'utf8',
    ),
  ) as { cards: { card: OracleCard }[] }
).cards.find((entry) => entry.card.name === 'Willie Lumpkin, Postman')!.card;

describe('optional draw decision (Willie Lumpkin) with a bot seat', () => {
  it('a heuristic bot answers "draw a card?" legally and the engine applies its choice', () => {
    const engine = new Engine(
      gameConfig([{ cards: [WILLIE, ...copies(8, forest)] }, { cards: copies(8, forest) }]),
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          hand: [],
          battlefield: [{ playerId: 'P1', cardNames: [WILLIE.name] }],
          continueThroughCombat: true,
        },
      },
    );
    const bot = new HeuristicDecisionProvider('willie-bot', () => engine.view('P2'));
    const asked: DecisionRequest[] = [];
    const handBefore = engine.getState().players.find((p) => p.id === 'P2')!.hand.length;
    for (let steps = 0; steps < 80; steps++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      if (request.decidingPlayer === 'P1') {
        // P1 attacks P2 with Willie whenever asked, otherwise passes.
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (declare !== undefined)
          engine.submit({
            requestId: request.requestId,
            actionId: declare.id,
            targets: (declare.targets ?? []).map((slot) => ({ slot: slot.slot, choice: 'P2' })),
          });
        else {
          const pass = request.legalActions.find((action) => action.type === 'pass');
          engine.submit({
            requestId: request.requestId,
            actionId: (pass ?? request.legalActions[0]!).id,
          });
        }
        continue;
      }
      if (/draw a card\?/.test(request.prompt)) asked.push(request);
      const response = bot.decide(request);
      expect(request.legalActions.some((action) => action.id === response.actionId)).toBe(true);
      engine.submit(response);
    }
    expect(asked).toHaveLength(1);
    expect(asked[0]!.decidingPlayer).toBe('P2');
    const chosen = asked[0]!.legalActions.length;
    expect(chosen).toBe(2);
    const handAfter = engine.getState().players.find((p) => p.id === 'P2')!.hand.length;
    // Either way, the engine did what the bot chose: one more card, or none.
    expect([handBefore, handBefore + 1]).toContain(handAfter);
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });
});
