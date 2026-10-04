import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import type { AiNetworkAttempt } from './client';
import type { AiPrompt } from './context';
import {
  DEFAULT_POLICY_REGISTRY,
  parsePolicyRegistry,
  type PolicyRegistry,
} from './policy-registry';
import { preparePromptForCaching } from './prompt-cache';
import { routeStrategy } from './strategy-router';
import { buildCacheExperimentReports } from '../benchmark/cache-experiment';

const registry: PolicyRegistry = {
  schemaVersion: 1,
  registryId: 'test',
  measuredAt: '2026-09-21',
  candidates: ['deterministic', 'economical', 'stronger'].map((handler) => ({
    id: handler,
    handler: handler as 'deterministic' | 'economical' | 'stronger',
    provider: 'test',
    model: handler,
    roles: ['tactician'],
    supportedDecisionTypes: '*',
    reasoning: { enabled: false, effort: 'none' },
    limits: {},
    evidenceStatus: 'eligible',
  })),
};

const view: PlayerView = {
  seat: 'P1',
  life: 40,
  hand: [],
  deck: [],
  graveyard: [],
  commanders: [],
  availableMana: {},
  manaSources: [],
  opponents: [],
  battlefield: [],
  exile: [],
  stack: [],
  recentLog: [],
};

function request(actions: DecisionRequest['legalActions']): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose',
    legalActions: actions,
  };
}

function attempt(index: number, cacheReadTokens?: number): AiNetworkAttempt {
  return {
    schemaVersion: 1,
    logicalRequestId: `r${index}`,
    attemptIndex: 0,
    requestedModel: 'test-model',
    status: 'accepted',
    startedAt: `2026-09-21T00:00:0${index}.000Z`,
    endedAt: `2026-09-21T00:00:0${index}.100Z`,
    durationMs: 100,
    messages: [],
    effectiveConfig: {},
    promptCache: {
      version: 'stable-prefix-v1',
      role: 'tactician',
      prefixHash: 'same-prefix',
      prefixMessageCount: 1,
      coldStatus: 'unverified',
      completeResponseCacheAllowed: false,
    },
    usage: {
      promptTokens: 100,
      responseTokens: 10,
      promptTokenSource: 'reported',
      responseTokenSource: 'reported',
      costSource: 'unknown',
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      cacheStatus:
        cacheReadTokens === undefined
          ? 'unknown'
          : cacheReadTokens > 0
            ? 'observed_hit'
            : 'observed_miss',
    },
  };
}

describe('router and provider cache contracts', () => {
  it('runtime-validates the committed shadow policy registry', () => {
    const parsed = parsePolicyRegistry(
      JSON.parse(readFileSync('benchmarks/policy-registry.json', 'utf8')),
    );
    expect(parsed.registryId).toBe('jev-shadow-registry-v1');
    expect(parsed.candidates).toContainEqual(
      expect.objectContaining({
        id: 'jev-action-selector-1.13-v1',
        model: 'typesafe/jev-1.13',
        evidenceStatus: 'unmeasured',
      }),
    );
    expect(DEFAULT_POLICY_REGISTRY.registryId).toBe(parsed.registryId);
    expect(
      parsed.candidates.filter((candidate) => candidate.evidenceStatus === 'eligible'),
    ).toHaveLength(1);
  });

  it('routes a large forced surface deterministically and a tiny critical stack to stronger', () => {
    const forced = routeStrategy({
      role: 'tactician',
      request: request([{ id: 0, type: 'pass', description: 'Only legal action' }]),
      view: {
        ...view,
        battlefield: Array.from({ length: 50 }, (_, index) => ({
          id: `p${index}`,
          controller: 'P1',
          name: 'Token',
          tapped: false,
          status: [],
        })),
      },
      registry,
    });
    expect(forced.initialHandler).toBe('deterministic');

    const critical = routeStrategy({
      role: 'tactician',
      request: request([
        { id: 0, type: 'pass', description: 'Pass' },
        { id: 1, type: 'castSpell', description: 'Respond' },
      ]),
      view: {
        ...view,
        stack: [{ id: 's1', controller: 'P2', description: 'Lethal spell', targets: ['P1'] }],
      },
      registry,
    });
    expect(critical.initialHandler).toBe('stronger');
    expect(critical.reasons).toContain('critical_interaction_window');
  });

  it('keeps request ids outside a stable prefix and disables complete-response reuse', () => {
    const base = (id: string): AiPrompt => ({
      messages: [
        { role: 'system', content: 'Stable role contract' },
        { role: 'user', content: JSON.stringify({ requestId: id, legalActions: [1, 2] }) },
      ],
      estimatedTokens: 20,
    });
    const left = preparePromptForCaching(base('left'), {
      role: 'strategist',
      staticContext: { profile: { archetype: 'control' } },
    });
    const right = preparePromptForCaching(base('right'), {
      role: 'strategist',
      staticContext: { profile: { archetype: 'control' } },
    });
    expect(left.promptCache?.prefixHash).toBe(right.promptCache?.prefixHash);
    expect(left.messages.at(-1)?.content).not.toBe(right.messages.at(-1)?.content);
    expect(left.promptCache?.completeResponseCacheAllowed).toBe(false);
  });

  it('moves static commander definitions ahead of changing zone and cast-count state', () => {
    const base = (zone: string, castCount: number): AiPrompt => ({
      messages: [
        { role: 'system', content: 'Stable role contract' },
        {
          role: 'user',
          content: JSON.stringify({
            you: {
              commanders: [
                {
                  name: 'Test Commander',
                  zone,
                  castCount,
                  manaCost: '{2}{G}',
                  typeLine: 'Legendary Creature',
                  oracleText: 'Static rules text.',
                },
              ],
            },
            opponents: [],
          }),
        },
      ],
      estimatedTokens: 30,
    });
    const command = preparePromptForCaching(base('command', 0), { role: 'tactician' });
    const battlefield = preparePromptForCaching(base('battlefield', 1), { role: 'tactician' });
    expect(command.promptCache?.prefixHash).toBe(battlefield.promptCache?.prefixHash);
    expect(command.messages[1]?.content).toContain('Static rules text.');
    expect(command.messages.at(-1)?.content).not.toContain('Static rules text.');
    expect(command.messages.at(-1)?.content).toContain('"zone":"command"');
  });

  it('claims cache reads only when the provider reports them', () => {
    const report = buildCacheExperimentReports([attempt(1), attempt(2, 80)])[0]!;
    expect(report.status).toBe('measured');
    expect(report.observedReadRequests).toBe(1);
    expect(report.unknownCacheStatusRequests).toBe(1);
    expect(report.firstCallColdStatus).toBe('unverified');
    expect(report.independentSamples).toBe(true);
  });
});
