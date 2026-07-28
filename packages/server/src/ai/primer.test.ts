import { describe, expect, it } from 'vitest';
import { RULES_PRIMER } from './primer';

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
});
