import { describe, expect, it } from 'vitest';
import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import { TurnPlanManager } from './turn-plan';

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: 'req-1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose action',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'playLand', description: 'Play Forest' },
      { id: 2, type: 'castSpell', description: 'Cast Grizzly Bears' },
    ],
    ...overrides,
  };
}

describe('TurnPlanManager', () => {
  it('records planned actions and executes them sequentially on active player turn', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ decidingPlayer: 'P1' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1, // Play Forest
      plannedActions: [
        { type: 'castSpell', name: 'Grizzly Bears' },
        { type: 'pass' },
      ],
    };

    manager.recordDecision(req1, res1, 'primary');

    // Next request for P1: menu offers castSpell Grizzly Bears
    const req2 = makeRequest({
      requestId: 'req-2',
      decidingPlayer: 'P1',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'castSpell', description: 'Cast Grizzly Bears' },
      ],
    });

    const planned2 = manager.tryExecutePlan(req2);
    expect(planned2).not.toBeNull();
    expect(planned2?.actionId).toBe(1); // Cast Grizzly Bears
    expect(planned2?.note).toContain('Grizzly Bears');

    manager.recordDecision(req2, planned2!, 'plan');

    // Next request for P1: menu offers pass
    const req3 = makeRequest({
      requestId: 'req-3',
      decidingPlayer: 'P1',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
    });

    const planned3 = manager.tryExecutePlan(req3);
    expect(planned3).not.toBeNull();
    expect(planned3?.actionId).toBe(0); // Pass
  });

  it('invalidates plan when an opponent intervenes with a non-pass action', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ decidingPlayer: 'P1' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [{ type: 'pass' }],
    };
    manager.recordDecision(req1, res1, 'primary');

    // Opponent P2 casts an instant
    const oppReq = makeRequest({ decidingPlayer: 'P2' });
    const oppRes: DecisionResponse = { requestId: 'req-opp', actionId: 2 };
    manager.recordDecision(oppReq, oppRes, 'primary');

    // Priority returns to P1
    const req2 = makeRequest({ requestId: 'req-2', decidingPlayer: 'P1' });
    const planned = manager.tryExecutePlan(req2);
    expect(planned).toBeNull(); // Plan was invalidated by P2's intervention
  });

  it('does NOT invalidate plan when opponent passes via heuristic or cache', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ decidingPlayer: 'P1' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [{ type: 'pass' }],
    };
    manager.recordDecision(req1, res1, 'primary');

    // Opponent P2 passes via heuristic
    const oppReq = makeRequest({ decidingPlayer: 'P2' });
    const oppRes: DecisionResponse = { requestId: 'req-opp', actionId: 0 };
    manager.recordDecision(oppReq, oppRes, 'heuristic');

    // Priority returns to P1: plan should still be intact
    const req2 = makeRequest({ requestId: 'req-2', decidingPlayer: 'P1' });
    const planned = manager.tryExecutePlan(req2);
    expect(planned).not.toBeNull();
    expect(planned?.actionId).toBe(0);
  });

  it('clears plan if the planned action is not legally available', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ decidingPlayer: 'P1' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 1,
      plannedActions: [{ type: 'castSpell', name: 'Giant Growth' }],
    };
    manager.recordDecision(req1, res1, 'primary');

    // Next request for P1 does NOT offer Giant Growth
    const req2 = makeRequest({
      requestId: 'req-2',
      decidingPlayer: 'P1',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
    });

    const planned = manager.tryExecutePlan(req2);
    expect(planned).toBeNull();
  });
});
