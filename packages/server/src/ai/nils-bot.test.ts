import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig, oracle } from '../../../engine/tests/fixtures';

const NILS = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../engine/tests/fixtures/coverage-pr07-oracle.json'),
      'utf8',
    ),
  ) as { cards: { card: OracleCard }[] }
).cards.find((entry) => entry.card.name === 'Nils, Discipline Enforcer')!.card;
const BEAR = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

describe('per-player target decisions (Nils, Discipline Enforcer) with a bot seat', () => {
  it('a heuristic bot answers every per-player "up to one target" prompt legally and the trigger resolves', () => {
    const engine = new Engine(
      gameConfig([
        { cards: [NILS, BEAR('Bot Bear'), ...copies(8, forest)] },
        { cards: [BEAR('Rival Bear'), BEAR('Rival Cub'), ...copies(8, forest)] },
      ]),
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          hand: [],
          battlefield: [
            { playerId: 'P1', cardNames: [NILS.name, 'Bot Bear'] },
            { playerId: 'P2', cardNames: ['Rival Bear', 'Rival Cub'] },
          ],
          continueToEndStep: true,
        },
      },
    );
    const bot = new HeuristicDecisionProvider('nils-bot', () => engine.view('P1'));
    const asked: DecisionRequest[] = [];
    for (let steps = 0; steps < 80; steps++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      if (/controlled by P\d/.test(request.prompt)) asked.push(request);
      const response = bot.decide(request);
      expect(request.legalActions.some((action) => action.id === response.actionId)).toBe(true);
      engine.submit(response);
    }
    // One prompt for each player's slot, both asked of the bot that controls Nils.
    expect(asked.map((request) => /controlled by (P\d)/.exec(request.prompt)?.[1])).toEqual([
      'P1',
      'P2',
    ]);
    for (const request of asked) expect(request.decidingPlayer).toBe('P1');
    // Whatever the bot chose, at most one creature per player grew, and only by one counter.
    const counters = (name: string) =>
      engine.getState().battlefield.find((perm) => perm.name === name)?.counters['+1/+1'] ?? 0;
    expect(counters('Rival Bear') + counters('Rival Cub')).toBeLessThanOrEqual(1);
    expect(counters('Bot Bear') + counters(NILS.name)).toBeLessThanOrEqual(1);
    expect(engine.getResult()?.haltReason ?? null).toBeNull();
  });
});
