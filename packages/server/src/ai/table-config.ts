/**
 * The AI configuration for model seats at a table (ADR 0055 decisions 2 to 6), built in code.
 *
 * Only the Anthropic key is read from the environment. Every other setting is fixed here, so an
 * `AI_*` variable left on the server (a base URL, JEV, reflection, another model) cannot change
 * what a table plays or spends.
 */

import type { DecisionType } from '@mtg/shared';
import { loadAiConfig, type AiConfig } from './config';
import { assertPriced } from './pricing';

/** Claude Haiku 5.5 plays both roles at tables (Paul, 2026-11-26). */
export const TABLE_MODEL = 'claude-haiku-5-5';

/**
 * Decision types the card-aware bot answers at a table, so the tactician is asked only where
 * judgment matters (ADR 0055 decision 3).
 */
export const TABLE_BOT_DECISION_TYPES: readonly DecisionType[] = [
  'mulligan',
  'bottomCards',
  'orderTriggers',
  'optionalTrigger',
  'commanderReplacement',
  'legendRule',
  'assignCombatDamage',
];

export interface TableAiLimits {
  /** Dollars all model seats at one table may spend in one game together. */
  maxUsdPerGame: number;
  /** Wall-clock limit on one tactician call, retries included. */
  tacticianDeadlineMs: number;
  /** Wall-clock limit on one strategist call, retries included. */
  strategistDeadlineMs: number;
}

/** About twice the measured p95 for each role (ADR 0055, paid games of 2026-11-26). */
export const DEFAULT_TABLE_AI_LIMITS: TableAiLimits = {
  maxUsdPerGame: 1,
  tacticianDeadlineMs: 15_000,
  strategistDeadlineMs: 30_000,
};

/**
 * The table's AI configuration for `apiKey`. Throws when the key is empty or a configured model
 * has no price row, since the per-game cap could not be enforced.
 */
export function tableAiConfig(
  apiKey: string,
  limits: TableAiLimits = DEFAULT_TABLE_AI_LIMITS,
  /** A stand-in for the Anthropic API (development mode's scripted run); omit for the real one. */
  baseUrl?: string,
): AiConfig {
  if (apiKey.trim() === '') throw new Error('model seats at a table need ANTHROPIC_API_KEY');
  const base = loadAiConfig({
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: apiKey,
    ...(baseUrl !== undefined && { ANTHROPIC_BASE_URL: baseUrl }),
  });
  const config: AiConfig = {
    ...base,
    models: [TABLE_MODEL],
    tacticalMode: 'model',
    botDecisionTypes: TABLE_BOT_DECISION_TYPES,
    botEscalation: [],
    botEscalationShadow: [],
    strategistEnabled: true,
    reflectionEnabled: false,
    archetypeInferenceEnabled: false,
    jevEnabled: false,
    jevShadowEnabled: false,
    retryOnTimeout: false,
    strategist: {
      ...base.strategist,
      models: [TABLE_MODEL],
      reasoningEnabled: true,
      reasoningEffort: 'medium',
      requestTimeoutMs: limits.strategistDeadlineMs,
      maxRetries: 1,
    },
    tactician: {
      ...base.tactician,
      models: [TABLE_MODEL],
      reasoningEnabled: false,
      reasoningEffort: 'none',
      requestTimeoutMs: limits.tacticianDeadlineMs,
      maxRetries: 1,
    },
  };
  assertPriced([...config.models, ...config.strategist.models, ...config.tactician.models]);
  return config;
}
