/**
 * ADR 0044's named triggers on the positions written for them, played through the production
 * pipeline in bot-led mode. Every decision records the triggers that fired, live or not.
 */
import { describe, expect, it, vi } from 'vitest';
import { OpenAiDecisionProvider } from '../../packages/server/src/ai/provider';
import { DEFAULT_AI_CONFIG } from '../../packages/server/src/ai/config';
import { localCallMeta } from '../../packages/server/src/ai/logger';
import type { AiClient } from '../../packages/server/src/ai/client';
import type { JevPolicyBinding } from '../../packages/server/src/ai/jev-policy';
import { loadCases } from './case';
import { fakeProvider, type FakeTurn } from './fake-provider';
import { parseLineup, parseModelList } from './models';
import { openCase } from './play';
import { runLineup, type RunOptions } from './run';

const options: RunOptions = {
  mode: 'raw',
  trials: 1,
  concurrency: 4,
  spendCapUsd: null,
  env: {},
  fetchImpl: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
  sleepImpl: () => Promise.resolve(),
};

const EXPECTED: Record<string, string[]> = {
  'hold-the-counter': ['scarce-answer'],
  'hold-the-swords-for-a-threat': ['scarce-answer'],
  'hold-negate-for-a-threat': ['scarce-answer'],
  'negate-the-blasphemous-act': ['scarce-answer'],
  'wrath-the-crowded-table': ['scarce-answer'],
  'darkness-the-alpha-strike': ['unknown-card'],
  'crackling-doom-for-two-kills': ['unknown-card'],
  'angels-grace-at-three': ['unknown-card'],
  'protect-from-feed-the-swarm': ['unknown-card'],
  'fog-the-lethal-swing': ['unknown-card'],
  // Lethal is at stake (the opponent's Overrun on the stack), so the last counter is not scarce.
  'counter-the-finisher': [],
  'keep-blockers-home': [],
};

describe('ADR 0044 triggers on their positions', () => {
  it('fire where they should and nowhere else on these positions', async () => {
    const cases = loadCases().filter((benchCase) => benchCase.id in EXPECTED);
    const [result] = await runLineup(cases, parseModelList('bot-led:never'), options);
    const fired = Object.fromEntries(
      result!.cases.map((entry) => [entry.caseId, entry.run.decisions[0]?.reasons ?? []]),
    );
    expect(fired).toEqual(EXPECTED);
  });

  it('a live scarce-answer sends the decision to the model, and the model answers it', async () => {
    const calls: FakeTurn[] = [];
    const pass = (turn: FakeTurn): string =>
      JSON.stringify({
        requestId: turn.requestId,
        actionId: turn.legalActions.find((a) => a.type === 'pass')!.id,
      });
    const results = await runLineup(
      loadCases().filter((c) => c.id === 'hold-negate-for-a-threat'),
      parseLineup([
        {
          id: 'scarce',
          kind: 'bot-led',
          escalation: ['scarce-answer'],
          provider: 'openrouter',
          model: 'fake/m',
        },
      ]),
      { ...options, env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: fakeProvider(pass, calls) },
    );
    const run = results[0]!.cases[0]!.run;
    expect(calls).toHaveLength(1);
    expect(run.decisions[0]).toMatchObject({
      escalated: true,
      reasons: ['scarce-answer'],
      source: 'model',
    });
    expect(results[0]!.cases[0]!.score.score).toBe(1);
  });

  it('a scarce-answer escalation skips active Jev and goes to the model (decision 5.4)', async () => {
    const opened = openCase(loadCases().find((c) => c.id === 'hold-negate-for-a-threat')!);
    const jevDecide = vi.fn();
    const jev = { mode: 'active', policy: { decide: jevDecide } } as unknown as JevPolicyBinding;
    const passId = opened.request.legalActions.find((a) => a.type === 'pass')!.id;
    const client: AiClient = {
      activeModel: 'm',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: opened.request.requestId, actionId: passId },
        meta: localCallMeta(),
      }),
    };
    const provider = new OpenAiDecisionProvider(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      opened.engine,
      {
        ...DEFAULT_AI_CONFIG,
        tacticalMode: 'bot',
        strategistEnabled: false,
        heuristicsEnabled: false,
        decisionCacheEnabled: false,
        botEscalation: ['scarce-answer'],
      },
      undefined,
      undefined,
      undefined,
      jev,
    );
    const response = await provider.decide(opened.request);
    expect(response.actionId).toBe(passId);
    expect(jevDecide).not.toHaveBeenCalled();
    expect(client.requestDecision).toHaveBeenCalledTimes(1);
    expect(provider.escalationStats()).toMatchObject({
      fired: { 'scarce-answer': 1 },
      escalated: { 'scarce-answer': 1 },
    });
  });

  it('a shadow trigger is counted and logged but asks nothing', async () => {
    const opened = openCase(loadCases().find((c) => c.id === 'hold-negate-for-a-threat')!);
    const client: AiClient = { activeModel: 'm', requestDecision: vi.fn() };
    const provider = new OpenAiDecisionProvider(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      opened.engine,
      {
        ...DEFAULT_AI_CONFIG,
        tacticalMode: 'bot',
        strategistEnabled: false,
        botEscalation: [],
        botEscalationShadow: ['scarce-answer', 'lethal'],
      },
    );
    await provider.decide(opened.request);
    expect(client.requestDecision).not.toHaveBeenCalled();
    expect(provider.escalationStats()).toMatchObject({
      fired: { 'scarce-answer': 1, lethal: 0 },
      escalated: { 'scarce-answer': 0 },
      bySource: { 'scarce-answer:bot': 1 },
    });
    const debug = opened.engine.getDebugLog();
    expect(JSON.stringify(debug)).toContain('escalation triggers');
  });

  it('a cached escalated answer says why it was escalated when it is replayed (decision 5.5)', async () => {
    const opened = openCase(loadCases().find((c) => c.id === 'hold-negate-for-a-threat')!);
    const passId = opened.request.legalActions.find((a) => a.type === 'pass')!.id;
    const client: AiClient = {
      activeModel: 'm',
      requestDecision: vi.fn().mockResolvedValue({
        response: { requestId: opened.request.requestId, actionId: passId },
        meta: localCallMeta(),
      }),
    };
    const provider = new OpenAiDecisionProvider(
      client,
      { enqueue: <T>(fn: () => Promise<T>) => fn() },
      opened.engine,
      {
        ...DEFAULT_AI_CONFIG,
        tacticalMode: 'bot',
        strategistEnabled: false,
        heuristicsEnabled: false,
        decisionCacheEnabled: true,
        botEscalation: ['scarce-answer'],
      },
    );
    await provider.decide(opened.request);
    // The same decision again: the cache answers, and its log names the trigger.
    const replay = await provider.decide({ ...opened.request, requestId: 'again' });
    expect(replay.actionId).toBe(passId);
    expect(client.requestDecision).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(opened.engine.getDebugLog())).toContain(
      'replaying an answer escalated by scarce-answer',
    );
  });
});
