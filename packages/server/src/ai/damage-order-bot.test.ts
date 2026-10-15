import { describe, expect, it } from 'vitest';
import { HeuristicDecisionProvider } from '@mtg/bot';
import type { DecisionRequest } from '@mtg/shared';
import { Engine } from '../../../engine/src/engine';
import { copies, forest, gameConfig, mountain, oracle } from '../../../engine/tests/fixtures';

const GISELA = oracle({
  oracleId: '66f9f325-5e8e-4ebf-b5b3-c6410d80f2c5',
  name: 'Gisela, Blade of Goldnight',
  typeLine: 'Legendary Creature — Angel',
  supertypes: ['Legendary'],
  manaCost: '{4}{R}{W}{W}',
  colors: ['R', 'W'],
  colorIdentity: ['R', 'W'],
  power: '5',
  toughness: '5',
  oracleText:
    'If a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage to that player or permanent instead.\n' +
    'If a source would deal damage to you or a permanent you control, prevent half that damage, rounded up.',
});
const BOLT = oracle({
  name: 'Lab Bolt',
  typeLine: 'Instant',
  manaCost: '{R}',
  colors: ['R'],
  oracleText: 'Lab Bolt deals 3 damage to any target.',
});

describe('damage replacement order decision (CR 616.1) with a bot seat', () => {
  it('a heuristic bot is asked which of two replacement effects applies first and its answer decides the damage', () => {
    const engine = new Engine(
      gameConfig([
        { cards: [BOLT, GISELA, ...copies(8, mountain)] },
        { cards: [GISELA, ...copies(8, forest)] },
      ]),
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          hand: [{ playerId: 'P1', cardNames: ['Lab Bolt'] }],
          battlefield: [
            { playerId: 'P1', cardNames: ['Mountain', GISELA.name] },
            { playerId: 'P2', cardNames: [GISELA.name] },
          ],
        },
      },
    );
    const bot = new HeuristicDecisionProvider('damage-order-bot', () => engine.view('P2'));
    const asked: DecisionRequest[] = [];
    let cast = false;
    for (let steps = 0; steps < 60; steps++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind !== 'decision') continue;
      const request = step.request;
      if (request.decidingPlayer === 'P1') {
        const bolt = request.legalActions.find(
          (action) => action.type === 'castSpell' && action.description.includes('Lab Bolt'),
        );
        if (!cast && bolt !== undefined) {
          cast = true;
          const slot = bolt.targets?.[0];
          engine.submit({
            requestId: request.requestId,
            actionId: bolt.id,
            targets: slot === undefined ? [] : [{ slot: slot.slot, choice: 'P2' }],
          });
          continue;
        }
        const pass = request.legalActions.find((action) => action.type === 'pass');
        engine.submit({
          requestId: request.requestId,
          actionId: (pass ?? request.legalActions[0]!).id,
        });
        continue;
      }
      if (request.prompt.includes('Choose which effect applies first')) asked.push(request);
      const response = bot.decide(request);
      expect(request.legalActions.some((action) => action.id === response.actionId)).toBe(true);
      engine.submit(response);
      if (asked.length > 0 && engine.getState().eventLog.some((e) => e.type === 'damage')) break;
    }
    expect(asked).toHaveLength(1);
    expect(asked[0]!.decidingPlayer).toBe('P2');
    expect(asked[0]!.decisionType).toBe('general');
    expect(asked[0]!.legalActions).toHaveLength(2);
    const dealt = engine.getState().eventLog.find((event) => event.type === 'damage');
    expect([2, 3]).toContain(dealt?.payload['amount']);
    expect(engine.getState().players.find((p) => p.id === 'P2')!.life).toBe(
      40 - (dealt?.payload['amount'] as number),
    );
  });
});
