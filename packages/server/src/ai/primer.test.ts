import { describe, expect, it } from 'vitest';
import { RULES_PRIMER, STRATEGIST_PRIMER, tacticianPrimerFor } from './primer';
import type { DecisionRequest } from '@mtg/shared';

function request(decisionType: DecisionRequest['decisionType']): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType,
    prompt: 'Choose',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass' },
      { id: 1, type: 'castSpell', description: 'Cast a spell' },
    ],
  };
}

describe('Rules Primer', () => {
  it('is a non-empty string', () => {
    expect(typeof RULES_PRIMER).toBe('string');
    expect(RULES_PRIMER.length).toBeGreaterThan(100);
  });

  it('respects token budget (estimated <= 2,000 tokens)', () => {
    const wordCount = RULES_PRIMER.split(/\s+/).length;
    const estimatedTokens = Math.ceil(wordCount / 0.75);
    expect(estimatedTokens).toBeLessThanOrEqual(2000);
  });

  it('includes key domain terms and concepts', () => {
    const terms = [
      'Commander',
      '40',
      '21',
      'command zone',
      'commander tax',
      'LIFO',
      'APNAP',
      'actionId',
      'requestId',
      'JSON',
      'passAndYieldTurn',
      'yield',
      'turn plan',
    ];
    for (const term of terms) {
      expect(RULES_PRIMER).toContain(term);
    }
  });

  it('does NOT reference the Comprehensive Rules file', () => {
    expect(RULES_PRIMER).not.toContain('Comprehensive Rules');
    expect(RULES_PRIMER).not.toContain('comprehensive-rules.txt');
  });

  it('keeps an ordinary priority primer smaller than the strategist primer', () => {
    const primer = tacticianPrimerFor(request('priority'));
    expect(primer.length).toBeLessThan(STRATEGIST_PRIMER.length);
    expect(primer).not.toContain('batched attack declaration');
    expect(primer).not.toContain('batched block declaration');
    expect(primer).not.toContain('combatDamageSplit');
  });

  it('adds only the combat fragment required by the current decision', () => {
    const attackers = tacticianPrimerFor(request('declareAttackers'));
    expect(attackers).toContain('batched attack declaration');
    expect(attackers).not.toContain('batched block declaration');

    const blockers = tacticianPrimerFor(request('declareBlockers'));
    expect(blockers).toContain('batched block declaration');
    expect(blockers).not.toContain('batched attack declaration');
  });
});
