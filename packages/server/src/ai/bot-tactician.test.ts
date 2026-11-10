import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import type { Engine } from '@mtg/engine';
import { OpenAiDecisionProvider } from './provider';
import type { AiClient } from './client';
import { DEFAULT_AI_CONFIG, type AiConfig } from './config';
import { localCallMeta } from './logger';
import { isUncertain } from './bot-tactician';
import { buildSupportedPool } from '../cards/pool';
import { censusGame, MODES } from '../cli/ai-call-census';

const view = {
  seat: 'P1',
  life: 40,
  hand: [],
  deck: [],
  graveyard: [],
  exile: [],
  commanders: [],
  availableMana: {},
  manaSources: [],
  opponents: [],
  battlefield: [],
  stack: [],
  recentLog: [],
};
const engine = { view: vi.fn().mockReturnValue(view), addDebug: vi.fn() } as unknown as Engine;
const queue = { enqueue: <T>(fn: () => Promise<T>): Promise<T> => fn() };

/** Two casts of equal mana value: a coin flip for the bot, so a close call. */
const closeCall: DecisionRequest = {
  requestId: 'r1',
  gameId: 'g',
  turn: 2,
  activePlayer: 'P1',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: '',
  legalActions: [
    { id: 0, type: 'pass', description: 'Pass priority' },
    { id: 1, type: 'castSpell', description: 'Cast Alpha', data: { manaCost: '{2}' } },
    { id: 2, type: 'castSpell', description: 'Cast Beta', data: { manaCost: '{2}' } },
  ],
};

function client(): AiClient {
  return {
    activeModel: 'm',
    requestDecision: vi.fn().mockResolvedValue({
      response: { requestId: 'r1', actionId: 2 },
      meta: localCallMeta(),
    }),
  };
}

function bot(overrides: Partial<AiConfig>): AiConfig {
  return { ...DEFAULT_AI_CONFIG, strategistEnabled: false, tacticalMode: 'bot', ...overrides };
}

describe('bot-led tactical mode', () => {
  it('answers without the model when escalation is off', async () => {
    const c = client();
    const provider = new OpenAiDecisionProvider(c, queue, engine, bot({ botEscalation: 'never' }));
    const res = await provider.decide(closeCall);
    expect([1, 2]).toContain(res.actionId);
    expect(c.requestDecision).not.toHaveBeenCalled();
  });

  it('asks the model on a close call when escalation is on', async () => {
    const c = client();
    const provider = new OpenAiDecisionProvider(
      c,
      queue,
      engine,
      bot({ botEscalation: 'uncertain' }),
    );
    const res = await provider.decide(closeCall);
    expect(res.actionId).toBe(2);
    expect(c.requestDecision).toHaveBeenCalledTimes(1);
  });

  it('does not treat a clear choice or a non-board decision as uncertain', () => {
    const pass = { action: closeCall.legalActions[0]!, score: 0 };
    const cast = { action: closeCall.legalActions[1]!, score: 5 };
    expect(isUncertain(closeCall, [cast, pass], 1)).toBe(false);
    const tied = [cast, { action: closeCall.legalActions[2]!, score: 5 }];
    expect(isUncertain(closeCall, tied, 1)).toBe(true);
    expect(isUncertain({ ...closeCall, decisionType: 'general' }, tied, 1)).toBe(false);
  });
});

describe('model-call census', () => {
  const pool = buildSupportedPool(
    JSON.parse(
      readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
    ) as OracleCard[],
  );

  it('makes no tactician calls in bot mode and fewer calls overall', async () => {
    const [model, everyTurn, onChange] = MODES;
    const today = await censusGame(pool, 'census-test', 12, model!);
    const botEvery = await censusGame(pool, 'census-test', 12, everyTurn!);
    const botChange = await censusGame(pool, 'census-test', 12, onChange!);
    expect(today.tactician).toBeGreaterThan(0);
    expect(botEvery.tactician).toBe(0);
    expect(botChange.tactician).toBe(0);
    expect(botEvery.strategist).toBeGreaterThan(0);
    expect(botChange.strategist + botChange.strategistReused).toBeGreaterThan(0);
    expect(botEvery.tactician + botEvery.strategist).toBeLessThan(
      today.tactician + today.strategist,
    );
  }, 60_000);
});
