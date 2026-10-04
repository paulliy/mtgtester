import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TacticalBenchmarkCase } from './contracts';
import { evaluateCases } from './eval';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { JevTacticalPolicy } from '../ai/jev-policy';

const fixture: TacticalBenchmarkCase = {
  schemaVersion: 1,
  caseId: 'jev-adapter-001',
  contentHash: 'test-only',
  role: 'tactician',
  categories: ['jev', 'adapter'],
  sourceGroup: 'unit',
  observerSeat: 'P1',
  turn: 1,
  phase: 'precombatMain',
  step: null,
  eventSequence: 1,
  supportedEngineVersion: 'test',
  supportedCardDefinitionHash: 'test',
  input: {
    request: {
      requestId: 'r1',
      gameId: 'g1',
      turn: 1,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      decisionType: 'priority',
      prompt: 'Choose',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass' },
        { id: 2, type: 'castSpell', description: 'Cast spell' },
      ],
    },
    view: {
      seat: 'P1',
      life: 40,
      hand: [],
      deck: [],
      graveyard: [],
      commanders: [],
      availableMana: {},
      manaSources: [],
      opponents: [],
      revealedLibraryTops: [],
      battlefield: [],
      exile: [],
      stack: [],
      recentLog: [],
    },
    guidance: { strategy: null, recentDecisions: [] },
  },
};

describe('Jev benchmark adapter', () => {
  it('records Jev as its own source and retains a policy trace without a chat call', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'mtg-jev-eval-'));
    const decide = vi.fn();
    try {
      const evaluated = await evaluateCases([fixture], DEFAULT_AI_CONFIG, {
        runId: 'run-1',
        variantId: 'jev-1.13-v1',
        mode: 'raw',
        trials: 1,
        outputDirectory,
        spendCapUsd: null,
        maxAttempts: 1,
        concurrency: 1,
        tacticianPolicy: 'jev',
        jevPolicyFactory: (onTrace): JevTacticalPolicy => ({
          decide: decide.mockImplementation(async (request) => {
            const classification = {
              shape: 'action_only' as const,
              jevSupported: true,
              reason: 'supported_action_only' as const,
              actionCount: 2,
              targetSlotCount: 0,
            };
            onTrace({
              schemaVersion: 1,
              logicalRequestId: request.requestId,
              recordedAt: '2026-09-22T00:00:00.000Z',
              mode: 'active',
              classification,
              outcome: 'accepted',
              validationResult: 'valid',
              networkAttempted: true,
              confidence: 0.9,
              topTwoMargin: 0.8,
              probabilities: { action_0: 0.1, action_2: 0.9 },
              selectedActionId: 2,
              engineAcceptance: 'not_checked',
            });
            return {
              kind: 'answered',
              response: { requestId: request.requestId, actionId: 2 },
              meta: {
                model: 'typesafe/jev-1.13',
                promptTokens: 50,
                responseTokens: 1,
                latencyMs: 10,
                wasRetry: false,
                wasFallback: false,
                rawResponse: '{}',
                costSource: 'unknown',
              },
              classification,
              confidence: 0.9,
              topTwoMargin: 0.8,
              probabilities: { action_0: 0.1, action_2: 0.9 },
            };
          }),
        }),
      });

      expect(decide).toHaveBeenCalledTimes(1);
      expect(evaluated.results[0]).toMatchObject({ source: 'jev', menuValidation: true });
      expect(evaluated.jevTraces).toHaveLength(1);
      expect(readFileSync(evaluated.jevTracesPath, 'utf8')).toContain('"confidence":0.9');
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
