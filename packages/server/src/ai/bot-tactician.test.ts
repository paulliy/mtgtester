import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import type { Engine } from '@mtg/engine';
import { OpenAiDecisionProvider } from './provider';
import type { AiClient } from './client';
import { DEFAULT_AI_CONFIG, type AiConfig } from './config';
import { AiCallLogger, localCallMeta } from './logger';
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
    const provider = new OpenAiDecisionProvider(c, queue, engine, bot({ botEscalation: [] }));
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
      bot({ botEscalation: ['uncertain'] }),
    );
    const res = await provider.decide(closeCall);
    expect(res.actionId).toBe(2);
    expect(c.requestDecision).toHaveBeenCalledTimes(1);
  });

  it("consults the seat's table deals when diplomacy is on", async () => {
    const obligations = vi.fn().mockReturnValue([]);
    const provider = new OpenAiDecisionProvider(
      client(),
      queue,
      engine,
      bot({ botEscalation: [] }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ obligations, startingOpponents: 3 }),
    );
    const targeted: DecisionRequest = {
      ...closeCall,
      legalActions: [
        closeCall.legalActions[0]!,
        {
          id: 1,
          type: 'castSpell',
          description: 'Cast Shock',
          data: { manaCost: '{R}' },
          targets: [{ slot: 0, options: ['P2'] }],
        },
      ],
    };
    await provider.decide(targeted);
    expect(obligations).toHaveBeenCalled();
  });

  it('does not treat a clear choice or a non-board decision as uncertain', () => {
    const pass = { action: closeCall.legalActions[0]!, score: 0 };
    const cast = { action: closeCall.legalActions[1]!, score: 5 };
    expect(isUncertain(closeCall, [cast, pass], 1)).toBe(false);
    const tied = [cast, { action: closeCall.legalActions[2]!, score: 5 }];
    expect(isUncertain(closeCall, tied, 1)).toBe(true);
    expect(isUncertain({ ...closeCall, decisionType: 'general' }, tied, 1)).toBe(false);
  });

  it('does not call one land against another a close call', () => {
    const land = (id: number, name: string) => ({
      action: { id, type: 'playLand', description: `Play ${name}` },
      score: 12,
    });
    expect(isUncertain(closeCall, [land(7, 'Swamp'), land(8, 'Plains')], 1)).toBe(false);
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

describe('ADR 0044 shadow triggers', () => {
  it('leave the game unchanged: the same event log with every trigger in shadow or none', async () => {
    const pool = buildSupportedPool(
      JSON.parse(
        readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
      ) as OracleCard[],
    );
    const base = MODES.find((mode) => mode.name === 'bot, replan on change')!;
    const logs: string[] = [];
    for (const shadow of [[], ['scarce-answer', 'unknown-card', 'uncertain', 'lethal']] as const) {
      const counts = await censusGame(
        pool,
        'shadow-parity',
        12,
        { name: 'parity', config: { ...base.config, botEscalationShadow: [...shadow] } },
        (finished) => logs.push(JSON.stringify(finished.getState().eventLog)),
      );
      if (shadow.length > 0)
        expect(Object.values(counts.triggerFired).some((n) => n > 0)).toBe(true);
    }
    expect(logs).toHaveLength(2);
    expect(logs[1]).toBe(logs[0]);
  }, 120_000);
});

describe('bot comparisons (the bot beside the model)', () => {
  it('records the bot answer beside an escalated close call', async () => {
    const logger = new AiCallLogger(null, 'g');
    const seen: unknown[] = [];
    const provider = new OpenAiDecisionProvider(
      client(),
      queue,
      engine,
      bot({ botEscalation: ['uncertain'] }),
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { onBotComparison: (c) => seen.push(c) },
    );
    const res = await provider.decide(closeCall);
    const [comparison] = logger.capturedBotComparisons();
    expect(res.actionId).toBe(2);
    expect(comparison).toMatchObject({
      kind: 'escalated',
      escalatedBy: 'uncertain',
      playedBy: 'primary',
      playedActionId: 2,
      decisionType: 'priority',
    });
    expect(comparison!.botTop).toHaveLength(3);
    expect([1, 2]).toContain(comparison!.botActionId);
    expect(comparison!.sameAction).toBe(comparison!.botActionId === 2);
    expect(comparison!.agreed).toBe(comparison!.sameAction);
    expect(comparison!.playedBotScore).toBeTypeOf('number');
    expect(seen).toEqual([comparison]);
  });

  it('records nothing when the bot answers on its own', async () => {
    const logger = new AiCallLogger(null, 'g');
    const provider = new OpenAiDecisionProvider(
      client(),
      queue,
      engine,
      bot({ botEscalation: [] }),
      logger,
    );
    await provider.decide(closeCall);
    expect(logger.capturedBotComparisons()).toEqual([]);
  });

  it('records nothing when the model failed and the fallback bot played', async () => {
    const logger = new AiCallLogger(null, 'g');
    const failing: AiClient = {
      activeModel: 'm',
      requestDecision: vi.fn().mockRejectedValue(new Error('down')),
    };
    const provider = new OpenAiDecisionProvider(
      failing,
      queue,
      engine,
      bot({ botEscalation: ['uncertain'], maxRetries: 0 }),
      logger,
    );
    await provider.decide(closeCall);
    expect(logger.capturedBotComparisons()).toEqual([]);
  });

  it('records nothing with AI_BOT_COMPARISON off', async () => {
    const logger = new AiCallLogger(null, 'g');
    const provider = new OpenAiDecisionProvider(
      client(),
      queue,
      engine,
      bot({ botEscalation: ['uncertain'], botComparisonEnabled: false }),
      logger,
    );
    await provider.decide(closeCall);
    expect(logger.capturedBotComparisons()).toEqual([]);
  });

  it('shadows a model-mode answer with the bot ranking, without changing the answer', async () => {
    const logger = new AiCallLogger(null, 'g');
    const provider = new OpenAiDecisionProvider(
      client(),
      queue,
      engine,
      { ...DEFAULT_AI_CONFIG, strategistEnabled: false, tacticalMode: 'model' },
      logger,
    );
    const res = await provider.decide(closeCall);
    const [comparison] = logger.capturedBotComparisons();
    expect(res.actionId).toBe(2);
    expect(comparison).toMatchObject({ kind: 'shadow', playedBy: 'primary', playedActionId: 2 });
    expect(comparison!.agreed).toBeUndefined();
    expect(comparison!.botActionId).toBe(comparison!.botTop[0]!.actionId);
  });
});
