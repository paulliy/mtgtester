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

  it('continuously shifts expired steps in a single call until matching a valid current step', () => {
    const manager = new TurnPlanManager();
    const req1 = makeRequest({ decidingPlayer: 'P1', phase: 'beginning', step: 'upkeep' });
    const res1: DecisionResponse = {
      requestId: 'req-1',
      actionId: 0,
      plannedActions: [
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'pass', phase: 'beginning', step: 'draw' },
        { type: 'playLand', name: 'Forest', phase: 'precombatMain' },
      ],
    };
    manager.recordDecision(req1, res1, 'primary');

    // Queue has 3 items: 2 expired in beginning phase (upkeep, draw), 1 valid in precombatMain phase.
    // Call tryExecutePlan during precombatMain in a single call.
    const reqMain = makeRequest({
      requestId: 'req-main',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'playLand', description: 'Play Forest' },
      ],
    });

    const result = manager.tryExecutePlan(reqMain);
    expect(result).not.toBeNull();
    expect(result?.actionId).toBe(1);
    expect(manager.getQueue().length).toBe(0);
  });

  it('invalidates plan queue and fires onInvalidated when active player executes a non-planned manual action', () => {
    const manager = new TurnPlanManager();
    let invalidated = false;
    manager.onInvalidated = () => {
      invalidated = true;
    };

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
    expect(manager.getQueue().length).toBe(2);

    // Active player P1 bypasses tryExecutePlan and manually executes a non-planned action
    const manualReq = makeRequest({ requestId: 'req-manual', decidingPlayer: 'P1' });
    const manualRes: DecisionResponse = { requestId: 'req-manual', actionId: 2 };
    manager.recordDecision(manualReq, manualRes, 'primary');

    // Queue and onInvalidated must be cleared
    expect(manager.getQueue().length).toBe(0);
    expect(invalidated).toBe(true);

    // Subsequent tryExecutePlan returns null
    expect(manager.tryExecutePlan(manualReq)).toBeNull();
  });

  it('purges intermediate phase queue items during multi-phase jumps across 3+ phases', () => {
    const manager = new TurnPlanManager();
    const reqInit = makeRequest({ decidingPlayer: 'P1', phase: 'beginning', step: 'untap' });
    const plannedActions = [
      { type: 'pass', phase: 'beginning' as const },
      { type: 'pass', phase: 'precombatMain' as const },
      { type: 'pass', phase: 'combat' as const },
      { type: 'playLand', name: 'Forest', phase: 'postcombatMain' as const },
    ];
    manager.recordPlan(reqInit, plannedActions);

    expect(manager.getQueue().length).toBe(4);

    // Request jumps directly to postcombatMain phase
    const reqPostcombat = makeRequest({
      requestId: 'req-postcombat',
      decidingPlayer: 'P1',
      phase: 'postcombatMain',
      step: null,
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'playLand', description: 'Play Forest' },
      ],
    });

    const result = manager.tryExecutePlan(reqPostcombat);
    expect(result).not.toBeNull();
    expect(result?.actionId).toBe(1);
    // All 3 intermediate phase items (beginning, precombatMain, combat) were purged and postcombatMain action consumed
    expect(manager.getQueue().length).toBe(0);
  });

  it('expires earlier steps within the same phase when phase matches', () => {
    const manager = new TurnPlanManager();
    const reqInit = makeRequest({ decidingPlayer: 'P1', phase: 'combat', step: 'beginCombat' });
    const plannedActions = [
      { type: 'pass', phase: 'combat' as const, step: 'beginCombat' as const },
      { type: 'castSpell', name: 'Lightning Bolt', phase: 'combat' as const, step: 'declareBlockers' as const },
    ];
    manager.recordPlan(reqInit, plannedActions);

    expect(manager.getQueue().length).toBe(2);

    // Request arrives at step declareBlockers in combat phase
    const reqBlockers = makeRequest({
      requestId: 'req-blockers',
      decidingPlayer: 'P1',
      phase: 'combat',
      step: 'declareBlockers',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'castSpell', description: 'Cast Lightning Bolt' },
      ],
    });

    const result = manager.tryExecutePlan(reqBlockers);
    expect(result).not.toBeNull();
    expect(result?.actionId).toBe(1);
    // beginCombat step was expired within combat phase, declareBlockers action matched and consumed
    expect(manager.getQueue().length).toBe(0);
  });

  it('clears plan queue and fires onInvalidated when active player deviates via fallback, heuristic, or cache decision sources', () => {
    const sources = ['fallback', 'heuristic', 'cache'] as const;

    for (const source of sources) {
      const manager = new TurnPlanManager();
      let invalidated = false;
      manager.onInvalidated = () => {
        invalidated = true;
      };

      const reqInit = makeRequest({ decidingPlayer: 'P1' });
      const resInit: DecisionResponse = {
        requestId: 'req-1',
        actionId: 1,
        plannedActions: [{ type: 'pass' }],
      };
      manager.recordDecision(reqInit, resInit, 'primary');

      expect(manager.getQueue().length).toBe(1);

      // Active player executes a decision using non-plan source
      const manualReq = makeRequest({ requestId: `req-${source}`, decidingPlayer: 'P1' });
      const manualRes: DecisionResponse = { requestId: `req-${source}`, actionId: 0 };
      manager.recordDecision(manualReq, manualRes, source);

      expect(manager.getQueue().length).toBe(0);
      expect(invalidated).toBe(true);
    }
  });
});

