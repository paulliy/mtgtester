import { describe, expect, it } from 'vitest';
import type { DecisionRequest, PlannedAction } from '@mtg/shared';
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

describe('Empirical Stress Tests — R2: Turn Plan Queue Expiration Resync', () => {
  describe('1. Multi-phase Queue Expiration', () => {
    it('shifts through multiple expired phases in a single call to execute postcombatMain action', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'beginning', step: 'upkeep' });
      const plannedActions: PlannedAction[] = [
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'pass', phase: 'beginning', step: 'draw' },
        { type: 'playLand', name: 'Forest', phase: 'precombatMain' },
        { type: 'pass', phase: 'combat', step: 'beginCombat' },
        { type: 'castSpell', name: 'Grizzly Bears', phase: 'postcombatMain' },
      ];

      manager.recordPlan(reqInit, plannedActions);
      expect(manager.getQueue().length).toBe(5);

      // Jump directly to postcombatMain
      const reqPostcombat = makeRequest({
        requestId: 'req-postcombat',
        phase: 'postcombatMain',
        step: null,
        legalActions: [
          { id: 0, type: 'pass', description: 'Pass priority' },
          { id: 10, type: 'castSpell', description: 'Cast Grizzly Bears' },
        ],
      });

      const response = manager.tryExecutePlan(reqPostcombat);
      expect(response).not.toBeNull();
      expect(response?.actionId).toBe(10);
      expect(response?.note).toContain('Grizzly Bears');

      // The 4 prior expired actions should have been shifted, leaving 0 items in queue
      expect(manager.getQueue().length).toBe(0);
    });

    it('shifts through all 4 prior phases to ending phase and leaves empty queue when no ending action matches', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'beginning', step: 'upkeep' });
      const plannedActions: PlannedAction[] = [
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'playLand', name: 'Forest', phase: 'precombatMain' },
        { type: 'pass', phase: 'combat', step: 'declareAttackers' },
        { type: 'pass', phase: 'postcombatMain' },
      ];

      manager.recordPlan(reqInit, plannedActions);

      // Advance to ending phase
      const reqEnding = makeRequest({
        requestId: 'req-ending',
        phase: 'ending',
        step: 'end',
        legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
      });

      const response = manager.tryExecutePlan(reqEnding);
      expect(response).toBeNull();
      expect(manager.getQueue().length).toBe(0);
    });
  });

  describe('2. Phase Jumps', () => {
    it('handles phase jump from beginning directly to combat', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'beginning', step: 'untap' });
      const plannedActions: PlannedAction[] = [
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'playLand', name: 'Forest', phase: 'precombatMain' },
        { type: 'pass', phase: 'combat', step: 'declareAttackers' },
      ];

      manager.recordPlan(reqInit, plannedActions);

      // Jump straight to combat phase / declareAttackers
      const reqCombat = makeRequest({
        requestId: 'req-combat',
        phase: 'combat',
        step: 'declareAttackers',
        legalActions: [{ id: 5, type: 'pass', description: 'Pass priority' }],
      });

      const response = manager.tryExecutePlan(reqCombat);
      expect(response).not.toBeNull();
      expect(response?.actionId).toBe(5);
      expect(manager.getQueue().length).toBe(0);
    });

    it('preserves future phase actions when request is in an earlier phase', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'beginning', step: 'upkeep' });
      const plannedActions: PlannedAction[] = [
        { type: 'playLand', name: 'Forest', phase: 'precombatMain' },
        { type: 'pass', phase: 'combat', step: 'beginCombat' },
      ];

      manager.recordPlan(reqInit, plannedActions);

      // Request is still in beginning phase
      const reqBeginning = makeRequest({
        requestId: 'req-beg',
        phase: 'beginning',
        step: 'draw',
        legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
      });

      const response = manager.tryExecutePlan(reqBeginning);
      // Pre-planned actions are for precombatMain and combat, so tryExecutePlan should return null without shifting future actions
      expect(response).toBeNull();
      expect(manager.getQueue().length).toBe(2);
    });
  });

  describe('3. Step Jumps Within Combat', () => {
    it('resynchronizes when combat steps jump from beginCombat to combatDamage', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'combat', step: 'beginCombat' });
      const plannedActions: PlannedAction[] = [
        { type: 'pass', phase: 'combat', step: 'beginCombat' },
        { type: 'pass', phase: 'combat', step: 'declareAttackers' },
        { type: 'pass', phase: 'combat', step: 'declareBlockers' },
        { type: 'pass', phase: 'combat', step: 'firstStrikeCombatDamage' },
        { type: 'pass', phase: 'combat', step: 'combatDamage' },
        { type: 'pass', phase: 'combat', step: 'endCombat' },
      ];

      manager.recordPlan(reqInit, plannedActions);

      // Jump directly to combatDamage step
      const reqDamage = makeRequest({
        requestId: 'req-damage',
        phase: 'combat',
        step: 'combatDamage',
        legalActions: [{ id: 99, type: 'pass', description: 'Pass priority' }],
      });

      const response = manager.tryExecutePlan(reqDamage);
      expect(response).not.toBeNull();
      expect(response?.actionId).toBe(99);
      // beginCombat, declareAttackers, declareBlockers, firstStrikeCombatDamage were shifted (4 items), combatDamage was consumed (1 item)
      // Remaining: endCombat (1 item)
      expect(manager.getQueue().length).toBe(1);
      expect(manager.getQueue()[0]?.step).toBe('endCombat');
    });

    it('correctly handles non-combat step jumps (e.g. untap to draw)', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'beginning', step: 'untap' });
      const plannedActions: PlannedAction[] = [
        { type: 'pass', phase: 'beginning', step: 'untap' },
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'pass', phase: 'beginning', step: 'draw' },
      ];

      manager.recordPlan(reqInit, plannedActions);

      // Game jumps to draw step
      const reqDraw = makeRequest({
        requestId: 'req-draw',
        phase: 'beginning',
        step: 'draw',
        legalActions: [{ id: 7, type: 'pass', description: 'Pass priority' }],
      });

      const response = manager.tryExecutePlan(reqDraw);
      expect(response).not.toBeNull();
      expect(response?.actionId).toBe(7);
      expect(manager.getQueue().length).toBe(0);
    });
  });

  describe('4. Mixed Valid / Invalid Action Queues', () => {
    it('shifts expired steps before executing a valid action', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'beginning', step: 'upkeep' });
      const plannedActions: PlannedAction[] = [
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'pass', phase: 'beginning', step: 'draw' },
        { type: 'castSpell', name: 'Grizzly Bears', phase: 'precombatMain' },
      ];

      manager.recordPlan(reqInit, plannedActions);

      const reqMain = makeRequest({
        requestId: 'req-main',
        phase: 'precombatMain',
        step: null,
        legalActions: [
          { id: 0, type: 'pass', description: 'Pass priority' },
          { id: 42, type: 'castSpell', description: 'Cast Grizzly Bears' },
        ],
      });

      const response = manager.tryExecutePlan(reqMain);
      expect(response).not.toBeNull();
      expect(response?.actionId).toBe(42);
    });

    it('clears queue when encountering an illegal current-phase action after shifting expired steps', () => {
      const manager = new TurnPlanManager();
      const reqInit = makeRequest({ phase: 'beginning', step: 'upkeep' });
      const plannedActions: PlannedAction[] = [
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'pass', phase: 'beginning', step: 'draw' },
        // Planned spell is Giant Growth, but Giant Growth is NOT in legal actions
        { type: 'castSpell', name: 'Giant Growth', phase: 'precombatMain' },
        // Subsequent action that would have been valid
        { type: 'pass', phase: 'precombatMain' },
      ];

      manager.recordPlan(reqInit, plannedActions);

      const reqMain = makeRequest({
        requestId: 'req-main',
        phase: 'precombatMain',
        step: null,
        legalActions: [
          { id: 0, type: 'pass', description: 'Pass priority' },
          { id: 1, type: 'playLand', description: 'Play Forest' },
        ],
      });

      const response = manager.tryExecutePlan(reqMain);
      expect(response).toBeNull();
      // Whole queue should be cleared because Giant Growth was invalid
      expect(manager.getQueue().length).toBe(0);
    });
  });

  describe('5. Sequential Game Progression Stress Harness', () => {
    it('executes a full turn plan seamlessly across sequential phase transitions', () => {
      const manager = new TurnPlanManager();

      // Setup turn plan for full turn
      const reqStart = makeRequest({ turn: 2, activePlayer: 'P1', phase: 'beginning', step: 'upkeep' });
      const fullTurnPlan: PlannedAction[] = [
        { type: 'pass', phase: 'beginning', step: 'upkeep' },
        { type: 'pass', phase: 'beginning', step: 'draw' },
        { type: 'playLand', name: 'Forest', phase: 'precombatMain' },
        { type: 'pass', phase: 'combat', step: 'beginCombat' },
        { type: 'pass', phase: 'combat', step: 'declareAttackers' },
        { type: 'castSpell', name: 'Grizzly Bears', phase: 'postcombatMain' },
        { type: 'pass', phase: 'ending', step: 'cleanup' },
      ];

      manager.recordPlan(reqStart, fullTurnPlan);
      expect(manager.getQueue().length).toBe(7);

      // Step 1: Upkeep pass
      const resUpkeep = manager.tryExecutePlan(
        makeRequest({
          turn: 2,
          phase: 'beginning',
          step: 'upkeep',
          legalActions: [{ id: 100, type: 'pass', description: 'Pass priority' }],
        }),
      );
      expect(resUpkeep?.actionId).toBe(100);

      // Step 2: Draw pass
      const resDraw = manager.tryExecutePlan(
        makeRequest({
          turn: 2,
          phase: 'beginning',
          step: 'draw',
          legalActions: [{ id: 101, type: 'pass', description: 'Pass priority' }],
        }),
      );
      expect(resDraw?.actionId).toBe(101);

      // Step 3: Main 1 land
      const resMain1 = manager.tryExecutePlan(
        makeRequest({
          turn: 2,
          phase: 'precombatMain',
          step: null,
          legalActions: [
            { id: 102, type: 'playLand', description: 'Play Forest' },
            { id: 100, type: 'pass', description: 'Pass priority' },
          ],
        }),
      );
      expect(resMain1?.actionId).toBe(102);

      // Step 4: Skip beginCombat and go to declareAttackers directly
      const resAttack = manager.tryExecutePlan(
        makeRequest({
          turn: 2,
          phase: 'combat',
          step: 'declareAttackers',
          legalActions: [{ id: 103, type: 'pass', description: 'Pass priority' }],
        }),
      );
      // beginCombat pass (idx 3) was expired and shifted, declareAttackers pass (idx 4) executed!
      expect(resAttack?.actionId).toBe(103);

      // Step 5: Postcombat Main Grizzly Bears
      const resMain2 = manager.tryExecutePlan(
        makeRequest({
          turn: 2,
          phase: 'postcombatMain',
          step: null,
          legalActions: [{ id: 104, type: 'castSpell', description: 'Cast Grizzly Bears' }],
        }),
      );
      expect(resMain2?.actionId).toBe(104);

      // Step 6: Cleanup step pass
      const resCleanup = manager.tryExecutePlan(
        makeRequest({
          turn: 2,
          phase: 'ending',
          step: 'cleanup',
          legalActions: [{ id: 105, type: 'pass', description: 'Pass priority' }],
        }),
      );
      expect(resCleanup?.actionId).toBe(105);

      expect(manager.getQueue().length).toBe(0);
    });
  });
});
