import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { safestFallback } from './fallback';

describe('Safest Fallback Selector', () => {
  it('selects pass priority when available', () => {
    const req: DecisionRequest = {
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
        { id: 0, type: 'castSpell', description: 'Cast Giant Growth' },
        { id: 1, type: 'pass', description: 'Pass priority' },
      ],
    };

    const res = safestFallback(req);
    expect(res.actionId).toBe(1);
    expect(res.note).toContain('passing priority');
  });

  it('selects decline optional effect when pass is not available', () => {
    const req: DecisionRequest = {
      requestId: 'req-2',
      gameId: 'g1',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      decisionType: 'optionalTrigger',
      prompt: 'Optional trigger',
      legalActions: [
        { id: 0, type: 'trigger', description: 'Pay {1} to draw a card' },
        { id: 1, type: 'trigger', description: "Decline trigger (don't pay)" },
      ],
    };

    const res = safestFallback(req);
    expect(res.actionId).toBe(1);
  });

  it('avoids self-harming sacrifice/discard actions', () => {
    const req: DecisionRequest = {
      requestId: 'req-3',
      gameId: 'g1',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      decisionType: 'general',
      prompt: 'Choose',
      legalActions: [
        { id: 0, type: 'sac', description: 'Sacrifice a creature' },
        { id: 1, type: 'playLand', description: 'Play Forest' },
      ],
    };

    const res = safestFallback(req);
    expect(res.actionId).toBe(1);
  });
});
