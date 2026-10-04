import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_CONFIG, type AiConfig } from './config';
import { createConfiguredJevPolicy } from './jev-runtime';

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return { ...DEFAULT_AI_CONFIG, ...overrides };
}

describe('createConfiguredJevPolicy', () => {
  it('does not require credentials while both rollout modes are disabled', () => {
    expect(createConfiguredJevPolicy(config(), {})).toBeNull();
  });

  it('requires a dedicated OpenRouter credential when configured', () => {
    expect(() => createConfiguredJevPolicy(config({ jevShadowEnabled: true }), {})).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it('allows uncalibrated shadow collection but rejects uncalibrated authoritative use', () => {
    expect(
      createConfiguredJevPolicy(config({ jevShadowEnabled: true }), {
        OPENROUTER_API_KEY: 'test-only',
      }),
    ).toMatchObject({ mode: 'shadow' });
    expect(() =>
      createConfiguredJevPolicy(config({ jevEnabled: true }), { OPENROUTER_API_KEY: 'test-only' }),
    ).toThrow(/MIN_CONFIDENCE/);
  });

  it('creates an active binding only with explicit thresholds', () => {
    expect(
      createConfiguredJevPolicy(
        config({ jevEnabled: true, jevMinConfidence: 0.8, jevMinTopTwoMargin: 0.2 }),
        { AI_JEV_API_KEY: 'test-only' },
      ),
    ).toMatchObject({ mode: 'active' });
  });
});
