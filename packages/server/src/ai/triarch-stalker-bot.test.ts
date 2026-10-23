import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig } from '../../../engine/tests/fixtures';

const STALKER = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../engine/tests/fixtures/coverage-pr07-oracle.json'),
      'utf8',
    ),
  ) as { cards: { card: OracleCard }[] }
).cards.find((entry) => entry.card.name === 'Triarch Stalker')!.card;

describe('choose an opponent decision (Triarch Stalker) with a bot seat', () => {
  it('a heuristic bot answers the beginning-of-combat opponent choice legally and the choice is stored on the Stalker', () => {
    const engine = new Engine(
      gameConfig([
        { cards: [STALKER, ...copies(8, forest)] },
        { cards: copies(8, forest) },
        { cards: copies(8, forest) },
      ]),
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          hand: [],
          battlefield: [{ playerId: 'P1', cardNames: [STALKER.name] }],
          continueThroughCombat: true,
        },
      },
    );
    const asked: DecisionRequest[] = [];
    for (let steps = 0; steps < 80; steps++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      if (/choose an opponent/.test(request.prompt)) asked.push(request);
      const bot = new HeuristicDecisionProvider('stalker-bot', () =>
        engine.view(request.decidingPlayer),
      );
      const response = bot.decide(request);
      expect(request.legalActions.some((action) => action.id === response.actionId)).toBe(true);
      engine.submit(response);
    }
    expect(asked).toHaveLength(1);
    expect(asked[0]!.decidingPlayer).toBe('P1');
    expect(asked[0]!.legalActions.map((action) => action.description).sort()).toEqual(['P2', 'P3']);
    const stalker = engine.getState().battlefield.find((perm) => perm.name === STALKER.name)!;
    expect(['P2', 'P3']).toContain((stalker as { chosenOption?: string }).chosenOption);
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });
});
