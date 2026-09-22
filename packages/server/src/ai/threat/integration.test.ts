import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest } from '@mtg/shared';
import type { AiPrompt } from '../context';
import type { AiClient } from '../client';
import { DEFAULT_AI_CONFIG, loadAiConfig } from '../config';
import { StrategyCoordinator } from '../strategy-coordinator';
import { OpenAiDecisionProvider } from '../provider';
import { assemblePrompt } from '../context';
import { developmentCases, fixtureView, request } from './fixtures';

const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
function setup(mode: 'off' | 'shadow' | 'context') {
  const view = fixtureView();
  const engine = { view: () => view, addDebug: vi.fn() } as unknown as Engine;
  const client: AiClient = {
    activeModel: 'test',
    requestDecision: vi
      .fn()
      .mockImplementation(async (_prompt: AiPrompt, req: DecisionRequest) => ({
        response: { requestId: req.requestId, actionId: 0 },
        meta: {
          model: 'test',
          promptTokens: 1,
          responseTokens: 1,
          latencyMs: 0,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{"actionId":0}',
        },
      })),
  };
  const config = { ...DEFAULT_AI_CONFIG, threatAssessmentMode: mode, heuristicsEnabled: false };
  const coordinator = new StrategyCoordinator(null, queue, engine, config);
  const provider = new OpenAiDecisionProvider(
    client,
    queue,
    engine,
    config,
    undefined,
    undefined,
    coordinator,
  );
  return { view, engine, client, coordinator, provider };
}
describe('threat rollout isolation', () => {
  it('defaults off, rejects typos, and recognizes explicit modes', () => {
    expect(loadAiConfig({}).threatAssessmentMode).toBe('off');
    expect(loadAiConfig({ AI_THREAT_ASSESSMENT_MODE: 'TRUE' }).threatAssessmentMode).toBe('off');
    expect(loadAiConfig({ AI_THREAT_ASSESSMENT_MODE: 'shadow' }).threatAssessmentMode).toBe(
      'shadow',
    );
    expect(loadAiConfig({ AI_THREAT_ASSESSMENT_MODE: 'context' }).threatAssessmentMode).toBe(
      'context',
    );
  });
  it('shadow leaves requests and actions identical to off, while logging observer/version/sequence', async () => {
    const off = setup('off'),
      shadow = setup('shadow');
    expect(await off.provider.decide(request)).toEqual(await shadow.provider.decide(request));
    expect(vi.mocked(off.client.requestDecision).mock.calls[0]![0]).toEqual(
      vi.mocked(shadow.client.requestDecision).mock.calls[0]![0],
    );
    const log = vi
      .mocked(shadow.engine.addDebug)
      .mock.calls.find((c) => c[1].startsWith('threat assessment'));
    expect(log?.[2]?.['assessment']).toMatchObject({
      observer: 'P1',
      sequence: 80,
      version: 'threat-v1.0.0',
    });
    expect(
      vi.mocked(off.engine.addDebug).mock.calls.some((c) => c[1].startsWith('threat assessment')),
    ).toBe(false);
  });
  it('experimental context reaches tactician with uncertainty and source-specific deadlines', async () => {
    const context = setup('context');
    Object.assign(context.view, developmentCases().find((c) => c.category === 'stack')!.view);
    await context.provider.decide(request);
    const payload = JSON.parse(
      vi.mocked(context.client.requestDecision).mock.calls[0]![0].messages[1]!.content,
    );
    expect(payload.threatAssessment.opponents[0].urgent[0].sources).toEqual(['burn']);
    expect(payload.threatAssessment.opponents[0].urgent[0].forced).toBe(false);
    expect(payload.threatAssessment.caution).toContain('not a target');
  });
  it('context never reuses legacy cache answers across new observations', async () => {
    const context = setup('context');
    await context.provider.decide(request);
    await context.provider.decide({ ...request, requestId: 'next' });
    expect(context.client.requestDecision).toHaveBeenCalledTimes(2);
    const shadow = setup('shadow');
    await shadow.provider.decide(request);
    await shadow.provider.decide({ ...request, requestId: 'next' });
    expect(shadow.client.requestDecision).toHaveBeenCalledTimes(1);
  });
  it('off prompt does not accidentally acquire newly projected stack semantics', () => {
    const v = developmentCases().find((c) => c.category === 'stack')!.view;
    const withFacts = assemblePrompt(request, v);
    v.stack = v.stack.map(({ impacts: _impacts, ...rest }) => rest);
    delete v.threatFacts;
    expect(assemblePrompt(request, v)).toEqual(withFacts);
  });
});
