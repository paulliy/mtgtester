import { afterEach, describe, expect, it, vi } from 'vitest';
import { configForRole } from './config';
import { TABLE_BOT_DECISION_TYPES, TABLE_MODEL, tableAiConfig } from './table-config';

describe('tableAiConfig (ADR 0055)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('plays Haiku in both roles: strategist at medium effort, tactician with thinking off', () => {
    const config = tableAiConfig('test-key');
    expect(config.apiFormat).toBe('anthropic');
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(config.apiKey).toBe('test-key');
    const strategist = configForRole(config, 'strategist');
    const tactician = configForRole(config, 'tactician');
    expect(strategist.models).toEqual([TABLE_MODEL]);
    expect(tactician.models).toEqual([TABLE_MODEL]);
    expect(strategist.reasoningEnabled).toBe(true);
    expect(strategist.reasoningEffort).toBe('medium');
    expect(tactician.reasoningEnabled).toBe(false);
    expect(config.tacticalMode).toBe('model');
    expect(config.botDecisionTypes).toEqual(TABLE_BOT_DECISION_TYPES);
    expect(config.jevEnabled).toBe(false);
    expect(config.jevShadowEnabled).toBe(false);
    expect(config.reflectionEnabled).toBe(false);
    expect(config.retryOnTimeout).toBe(false);
  });

  it('ignores AI settings left in the environment', () => {
    vi.stubEnv('AI_BASE_URL', 'https://example.invalid');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://example.invalid');
    vi.stubEnv('AI_TACTICAL_MODE', 'bot');
    vi.stubEnv('AI_TACTICIAN_MODELS', 'claude-opus-5-5');
    vi.stubEnv('AI_JEV_ENABLED', 'true');
    const config = tableAiConfig('test-key');
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(config.tacticalMode).toBe('model');
    expect(configForRole(config, 'tactician').models).toEqual([TABLE_MODEL]);
    expect(config.jevEnabled).toBe(false);
  });

  it('refuses an empty key', () => {
    expect(() => tableAiConfig('  ')).toThrow('ANTHROPIC_API_KEY');
  });

  it('sets each role’s request timeout from the limits', () => {
    const config = tableAiConfig('test-key', {
      maxUsdPerGame: 1,
      tacticianDeadlineMs: 12_000,
      strategistDeadlineMs: 25_000,
    });
    expect(configForRole(config, 'tactician').requestTimeoutMs).toBe(12_000);
    expect(configForRole(config, 'strategist').requestTimeoutMs).toBe(25_000);
  });
});
