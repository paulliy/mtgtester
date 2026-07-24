import { describe, it, expect } from 'vitest';
import { ALL_COLORS, PHASES, STEPS, ZONES, DECISION_TYPES, LOSS_REASONS } from './index';
import type { DecisionRequest } from './index';

describe('@mtg/shared enum tuples', () => {
  it('exposes exactly the five colors', () => {
    expect(ALL_COLORS).toEqual(['W', 'U', 'B', 'R', 'G']);
  });

  it('lists the five turn phases in order (brief §5.3)', () => {
    expect(PHASES).toEqual(['beginning', 'precombatMain', 'combat', 'postcombatMain', 'ending']);
  });

  it('includes the first-strike combat damage sub-step (brief §5.3)', () => {
    expect(STEPS).toContain('firstStrikeCombatDamage');
    expect(STEPS).toContain('combatDamage');
  });

  it('covers Commander-specific decisions, zones, and loss reasons', () => {
    expect(DECISION_TYPES).toContain('mulligan');
    expect(DECISION_TYPES).toContain('commanderReplacement');
    expect(ZONES).toContain('command');
    expect(LOSS_REASONS).toContain('commanderDamage');
  });
});

describe('@mtg/shared type surface', () => {
  it('the decision contract types are usable', () => {
    const req: Pick<DecisionRequest, 'decisionType' | 'legalActions'> = {
      decisionType: 'priority',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
    };
    expect(req.legalActions[0]?.type).toBe('pass');
  });
});
