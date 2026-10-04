import { describe, expect, it } from 'vitest';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { TurnPlanManager } from './turn-plan';

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      {
        id: 1,
        type: 'castSpell',
        description: 'Cast Bear',
        interaction: { kind: 'source', sourceId: 'hand-bear', sourceCardId: 'card-bear' },
      },
    ],
    ...overrides,
  };
}

function sourceView(): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [{ id: 'hand-bear', name: 'Bear' }],
    deck: [],
    graveyard: [],
    commanders: [],
    availableMana: {},
    manaSources: [],
    opponents: [],
    battlefield: [{ id: 'target-1', controller: 'P2', name: 'Target', tapped: false, status: [] }],
    exile: [],
    stack: [],
    recentLog: [],
  };
}

describe('plan lifecycle and attribution', () => {
  it('distinguishes matched, submitted, and engine-accepted states', () => {
    const manager = new TurnPlanManager(true);
    const req = request();
    manager.recordPlan(
      req,
      [{ id: 'cast-bear', type: 'castSpell', source: { objectId: 'hand-bear' } }],
      undefined,
      { sourceView: sourceView() },
    );
    const response = manager.tryExecutePlan(req)!;
    expect(manager.getLifecycleEvents().map((item) => item.status)).toContain('matched');
    expect(manager.getLifecycleEvents().map((item) => item.status)).toContain('submitted');
    expect(manager.getLifecycleEvents().map((item) => item.status)).not.toContain('accepted');
    manager.recordAccepted(req, response);
    expect(manager.getLifecycleEvents().at(-1)?.status).toBe('accepted');
  });

  it('keeps an irrelevant opponent action from destroying a scoped plan', () => {
    const manager = new TurnPlanManager(true);
    const req = request();
    manager.recordPlan(req, [{ type: 'pass' }]);
    const opponent = request({
      requestId: 'opp',
      decidingPlayer: 'P2',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass' },
        { id: 2, type: 'castSpell', description: 'Cast unrelated spell' },
      ],
    });
    manager.recordDecision(opponent, { requestId: 'opp', actionId: 2 }, 'primary');
    expect(manager.tryExecutePlan(request({ requestId: 'after' }))?.actionId).toBe(0);
  });

  it('separates waiting prerequisites from impossible-at-source actions', () => {
    const manager = new TurnPlanManager(true);
    const req = request();
    manager.recordPlan(
      req,
      [
        { id: 'later', type: 'pass', dependencies: ['first'] },
        {
          id: 'impossible',
          type: 'castSpell',
          source: { objectId: 'missing-object' },
        },
      ],
      undefined,
      { sourceView: sourceView() },
    );
    expect(manager.tryExecutePlan(req)).toBeNull();
    const statuses = manager.getLifecycleEvents().map((item) => item.status);
    expect(statuses).toContain('impossible_at_source');
    expect(statuses).toContain('waiting_for_prerequisite');
  });

  it('requires a cited opponent event before attributing invalidation to that opponent', () => {
    let current = sourceView();
    let eventsVisible = false;
    const events = [
      {
        sequence: 8,
        turn: 3,
        phase: 'precombatMain' as const,
        step: null,
        actorSeat: 'P2',
        type: 'destroy',
        payload: { target: 'target-1', source: 'Removal' },
      },
    ];
    const engine = {
      view: () => current,
      eventsSince: (sequence: number) =>
        eventsVisible ? events.filter((item) => item.sequence >= sequence) : [],
      addDebug: () => undefined,
      getState: () => ({ phase: 'precombatMain', step: null }),
    } as unknown as Engine;
    const manager = new TurnPlanManager(true);
    const req = request();
    manager.recordPlan(
      req,
      [
        {
          type: 'castSpell',
          preconditions: [{ kind: 'targetAvailable', objectId: 'target-1' }],
        },
      ],
      engine,
      { sourceView: current },
    );
    current = { ...current, battlefield: [] };
    eventsVisible = true;
    expect(manager.tryExecutePlan(req, engine)).toBeNull();
    const invalidation = manager
      .getLifecycleEvents()
      .find((item) => item.status === 'invalidated_by_opponent');
    expect(invalidation?.evidenceEventSequences).toEqual([8]);
  });
});
