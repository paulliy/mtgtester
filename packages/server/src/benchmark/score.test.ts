import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadCase } from './cases';
import type { BenchmarkCase } from './contracts';
import { scoreResponse, semanticDecisionKey } from './score';

describe('benchmark semantic scoring', () => {
  it('distinguishes different attack assignments', () => {
    const attackP2 = semanticDecisionKey({
      requestId: 'r',
      actionId: 1,
      targets: [
        { slot: 0, choice: 'P2' },
        { slot: 1, choice: '__no_attack__' },
      ],
    });
    const attackP3 = semanticDecisionKey({
      requestId: 'r',
      actionId: 1,
      targets: [
        { slot: 0, choice: 'P3' },
        { slot: 1, choice: '__no_attack__' },
      ],
    });
    expect(attackP2).not.toBe(attackP3);
  });

  it('never emits a quality score for an unlabeled case', () => {
    const caseValue = { role: 'tactician' } as BenchmarkCase;
    expect(scoreResponse(caseValue, { requestId: 'r', actionId: 0 })).toEqual({
      labelStatus: 'unscored',
      metrics: {},
    });
  });

  it('accepts the labeled removal action with its required target', () => {
    const caseValue = loadCase(
      join(process.cwd(), 'benchmarks', 'tactician', 'dev', 'priority-removal-001.json'),
    );

    expect(
      scoreResponse(caseValue, {
        requestId: 'starter-tactical-001',
        actionId: 1,
        targets: [{ slot: 0, choice: 'threat' }],
      }),
    ).toMatchObject({
      labelStatus: 'scored',
      acceptable: true,
      value: 1,
    });
  });
});
