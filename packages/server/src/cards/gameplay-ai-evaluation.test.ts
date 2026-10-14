import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMBAT_TRIGGER_SCENARIO_IDS } from './combat-trigger-scenarios';
import {
  evaluateArcaneDenialGameplayAi,
  evaluateFabledPassageGameplayAi,
  evaluateMyriadLandscapeGameplayAi,
  evaluateReviewedFiveGameplayAi,
  evaluateSmotheringTitheGameplayAi,
  evaluateCombatTriggerGameplayAi,
} from './gameplay-ai-evaluation';

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
  it('reports combat-card provider choices separately without claiming a live LLM run', () => {
    const report = evaluateCombatTriggerGameplayAi();
    expect(report.liveLlm).toBe('not-run');
    expect(report.note).toContain('Quality-only');
    expect(report.runs).toHaveLength(COMBAT_TRIGGER_SCENARIO_IDS.length * 2);
    for (const run of report.runs) {
      expect(run.decisions).toBeGreaterThan(0);
      expect(run.observations).toHaveLength(run.decisions);
      expect(typeof run.usedSubjectCard).toBe('boolean');
    }
  });
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

  it('records Arcane Denial decisions separately for the caster and affected player', () => {
    const report = evaluateArcaneDenialGameplayAi();
    expect(report.liveLlm).toBe('not-run');
    expect(report.runs).toHaveLength(6);
    expect(report.runs.every((run) => run.decisions > 0)).toBe(true);
    expect(
      report.runs
        .filter((run) => run.providerKind === 'heuristic')
        .every((run) =>
          run.observations.some(
            (observation) =>
              observation.decidingPlayer === 'P4' && observation.description.startsWith('Draw '),
          ),
        ),
    ).toBe(true);
    expect(report.note).toContain('Quality-only');
  });

  it('smothering-tithe-ai-payment-quality — records local-provider draw and tax decisions', () => {
    const report = evaluateSmotheringTitheGameplayAi();
    expect(report.liveLlm).toBe('not-run');
    expect(report.runs).toHaveLength(6);
    expect(report.runs.every((run) => run.decisions > 0)).toBe(true);
    const heuristic = report.runs.filter((run) => run.providerKind === 'heuristic');
    expect(heuristic.every((run) => run.usedSubjectCard)).toBe(true);
    expect(
      heuristic.every((run) =>
        run.observations.some(
          (observation) =>
            observation.decidingPlayer === 'P1' &&
            ['Pay {2}', "Don't pay {2}"].includes(observation.description),
        ),
      ),
    ).toBe(true);
    expect(report.note).toContain('Quality-only');
  });

  it('fabled-passage-ai-search-quality — records local-provider activation and search decisions', () => {
    const report = evaluateFabledPassageGameplayAi();
    expect(report.liveLlm).toBe('not-run');
    expect(report.runs).toHaveLength(6);
    expect(report.runs.every((run) => run.decisions > 0)).toBe(true);
    const heuristic = report.runs.filter((run) => run.providerKind === 'heuristic');
    expect(heuristic.every((run) => run.usedSubjectCard)).toBe(true);
    expect(
      heuristic.every((run) =>
        run.observations.some(
          (observation) =>
            observation.decidingPlayer === 'P1' &&
            ['findCard', 'findNothing'].includes(observation.actionType),
        ),
      ),
    ).toBe(true);
    expect(report.note).toContain('Quality-only');
  });

  it('myriad-landscape-ai-search-quality — records local-provider activation and grouped-search decisions', () => {
    const report = evaluateMyriadLandscapeGameplayAi();
    expect(report.liveLlm).toBe('not-run');
    expect(report.runs).toHaveLength(6);
    expect(report.runs.every((run) => run.decisions > 0)).toBe(true);
    const heuristic = report.runs.filter((run) => run.providerKind === 'heuristic');
    expect(heuristic.every((run) => run.usedSubjectCard)).toBe(true);
    expect(
      heuristic.every((run) =>
        run.observations.some(
          (observation) =>
            observation.decidingPlayer === 'P1' &&
            ['findCards', 'findNothing'].includes(observation.actionType),
        ),
      ),
    ).toBe(true);
    expect(report.note).toContain('Quality-only');
  });
});
