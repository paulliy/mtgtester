import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateReviewedFiveGameplayAi } from './gameplay-ai-evaluation';

interface CommittedObservation {
  card: string;
  subject: string;
  randomUsedSubject: boolean;
  heuristicUsedSubject: boolean;
}

interface CommittedReport {
  liveLlm: string;
  observed: CommittedObservation[];
}

const committed = JSON.parse(
  readFileSync(resolve('docs/plans/gameplay-ai-evaluation.json'), 'utf8'),
) as CommittedReport;

describe('gameplay-AI quality evaluation (step 15)', () => {
  it('records random and heuristic decisions for every reviewed lab scenario', () => {
    const report = evaluateReviewedFiveGameplayAi();
    expect(report.liveLlm).toBe('not-run');
    expect(report.cards.map((entry) => entry.card)).toEqual(
      committed.observed.map((row) => row.card),
    );
    for (const [index, card] of report.cards.entries()) {
      const expected = committed.observed[index]!;
      expect(card.subject).toBe(expected.subject);
      expect(card.random.usedSubjectCard, `${card.card} random`).toBe(expected.randomUsedSubject);
      expect(card.heuristic.usedSubjectCard, `${card.card} heuristic`).toBe(
        expected.heuristicUsedSubject,
      );
      expect(card.random.decisions, card.card).toBeGreaterThan(0);
      expect(card.heuristic.decisions, card.card).toBeGreaterThan(0);
    }
  });

  it('does not treat a live LLM skip as a gameplay-AI pass', () => {
    expect(committed.liveLlm).toBe('not-run');
    const report = evaluateReviewedFiveGameplayAi();
    expect(report.liveLlm).toBe('not-run');
    expect(report.note).toContain('not part of the merge gate');
  });
});
