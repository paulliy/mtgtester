import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { JevActionRequest } from '../ai/jev-context';
import type { JevActionResult } from '../ai/jev-client';
import type { JevComparison } from '../ai/jev-policy';
import { emptyTally, type Budget } from './ai-mode-duel';
import {
  agreementStats,
  countingJev,
  emptyJevTally,
  lineupFor,
  parseSeats,
  playGame,
  presetSetup,
  PRESETS,
  type GameContext,
  type Preset,
} from './jev-duel';

const budget = (maxUsd = 1, maxCalls = 10): Budget => ({
  maxUsd,
  maxCalls,
  spentUsd: 0,
  calls: 0,
  capped: false,
});

describe('jev-duel', () => {
  it('parses four seat presets and rejects anything else', () => {
    expect(parseSeats('bot,bot-jev,model,jev')).toEqual(['bot', 'bot-jev', 'model', 'jev']);
    expect(() => parseSeats('bot,jev')).toThrow('exactly four');
    expect(() => parseSeats('bot,bot,bot,claude')).toThrow('unknown seat preset');
  });

  it('rotates the lineup so each preset plays every seat', () => {
    const seats = parseSeats('bot,bot-jev,model,jev');
    const seatsOfJev = [0, 1, 2, 3].map((g) => lineupFor(seats, g).indexOf('jev'));
    expect(new Set(seatsOfJev).size).toBe(4);
  });

  it('binds Jev only where the preset says, with the bot as the free fallback', () => {
    const t = { minConfidence: 0.3, minTopTwoMargin: 0 };
    expect(presetSetup('bot', DEFAULT_AI_CONFIG, t).jev).toBeNull();
    expect(presetSetup('model', DEFAULT_AI_CONFIG, t).jev).toBeNull();
    expect(presetSetup('bot-shadow', DEFAULT_AI_CONFIG, t)).toMatchObject({
      config: { tacticalMode: 'bot', botEscalation: 'never', jevShadowScope: 'all' },
      jev: { mode: 'shadow' },
    });
    expect(presetSetup('bot-jev', DEFAULT_AI_CONFIG, t)).toMatchObject({
      config: { tacticalMode: 'bot', botEscalation: 'uncertain', jevFallback: 'bot' },
      jev: { mode: 'active', minConfidence: 0.3 },
    });
    expect(presetSetup('jev', DEFAULT_AI_CONFIG, t).config).toMatchObject({
      tacticalMode: 'model',
      jevFallback: 'bot',
    });
    expect(presetSetup('jev-model', DEFAULT_AI_CONFIG, t).config.jevFallback).toBe('model');
  });

  it('charges Jev calls to the budget and refuses calls over the cap before sending', async () => {
    let sent = 0;
    const inner = {
      requestAction: (): Promise<JevActionResult> => {
        sent++;
        return Promise.resolve({
          answer: { type: 'choice', choice: 'action_0' },
          meta: {
            requestedModel: 'j',
            responseModel: 'j',
            promptTokens: 100,
            responseTokens: 2,
            costUsd: 0.4,
            latencyMs: 1,
            rawResponse: '{}',
          },
        });
      },
    };
    const tally = emptyJevTally();
    const b = budget(0.5);
    const client = countingJev(inner, tally, b);
    const built = {} as JevActionRequest;
    await client.requestAction(built);
    await client.requestAction(built);
    await expect(client.requestAction(built)).rejects.toThrow('spend cap');
    expect(sent).toBe(2);
    expect(tally).toMatchObject({ calls: 2, promptTokens: 200, cappedCalls: 1 });
    expect(b.capped).toBe(true);
    expect(b.spentUsd).toBeCloseTo(0.8);
  });

  it('summarizes agreement, including on the bot close calls', () => {
    const c = (agreed: boolean, botUncertain: boolean, confidence: number): JevComparison => ({
      schemaVersion: 1,
      logicalRequestId: 'r',
      seat: 'P1',
      turn: 1,
      decisionType: 'priority',
      playedBy: 'bot',
      playedActionId: 0,
      botUncertain,
      jevOutcome: 'answered',
      jevActionId: agreed ? 0 : 1,
      agreed,
      sameAction: agreed,
      confidence,
    });
    expect(agreementStats([c(true, false, 0.9), c(false, true, 0.5), c(true, true, 0.7)])).toEqual({
      compared: 3,
      agreed: 2,
      sameAction: 2,
      closeCalls: 2,
      closeCallsAgreed: 1,
      meanConfidenceAgreed: 0.8,
      meanConfidenceDisagreed: 0.5,
    });
  });

  describe('offline games', () => {
    const pool = buildSupportedPool(
      JSON.parse(
        readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
      ) as OracleCard[],
    );
    const context = (): GameContext => {
      const presets = [...PRESETS];
      return {
        pool,
        base: DEFAULT_AI_CONFIG,
        thresholds: { minConfidence: 0, minTopTwoMargin: 0 },
        offline: true,
        jevKey: '',
        turnCap: 8,
        budget: budget(1, 10_000),
        tallies: Object.fromEntries(
          presets.map((p) => [p, emptyTally()]),
        ) as GameContext['tallies'],
        jevTallies: Object.fromEntries(
          presets.map((p) => [p, emptyJevTally()]),
        ) as GameContext['jevTallies'],
        traces: [],
        comparisons: [],
        chatClients: [],
        quiet: true,
      };
    };
    const lineup = (preset: Preset): Preset[] => [preset, preset, preset, preset];

    it('plays exactly the same game with Jev in shadow as without it', async () => {
      const plain = await playGame(context(), 'shadow-same', lineup('bot'), 0);
      const shadowCtx = context();
      const shadow = await playGame(shadowCtx, 'shadow-same', lineup('bot-shadow'), 0);
      expect(shadowCtx.jevTallies['bot-shadow'].calls).toBeGreaterThan(0);
      expect(shadowCtx.comparisons.length).toBeGreaterThan(0);
      expect(JSON.stringify(shadow.engine.getState().eventLog)).toBe(
        JSON.stringify(plain.engine.getState().eventLog),
      );
    }, 120_000);

    it('lets Jev decide without the chat tactician when the bot is its fallback', async () => {
      const ctx = context();
      await playGame(ctx, 'jev-only', ['jev', 'bot-jev', 'jev', 'bot-jev'], 0);
      expect(ctx.tallies.jev.tacticianCalls).toBe(0);
      expect(ctx.tallies['bot-jev'].tacticianCalls).toBe(0);
      expect(ctx.jevTallies.jev.accepted).toBeGreaterThan(0);
      expect(ctx.traces.every((t) => t.preset === 'jev' || t.preset === 'bot-jev')).toBe(true);
    }, 120_000);
  });
});
