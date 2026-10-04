import type { AiAttemptObserver } from './client';
import type { AiConfig } from './config';
import { JevClient } from './jev-client';
import { JevActionPolicy, type JevPolicyBinding, type JevTraceObserver } from './jev-policy';
import { RequestQueue } from './queue';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Build the independently configured Jev lane. Secrets stay in the process environment and are
 * never copied into AiConfig, benchmark manifests, or debug payloads.
 */
export function createConfiguredJevPolicy(
  config: AiConfig,
  env: Record<string, string | undefined> = process.env,
  observer?: AiAttemptObserver,
  traceObserver?: JevTraceObserver,
): JevPolicyBinding | null {
  if (!config.jevEnabled && !config.jevShadowEnabled) return null;

  const apiKey = env['AI_JEV_API_KEY']?.trim() || env['OPENROUTER_API_KEY']?.trim() || '';
  if (apiKey.length === 0) {
    throw new Error('Jev requires AI_JEV_API_KEY or OPENROUTER_API_KEY');
  }
  if (
    config.jevEnabled &&
    (config.jevMinConfidence === null || config.jevMinTopTwoMargin === null)
  ) {
    throw new Error(
      'Authoritative Jev requires AI_JEV_MIN_CONFIDENCE and AI_JEV_MIN_TOP_TWO_MARGIN',
    );
  }

  const client = new JevClient(
    {
      apiKey,
      baseUrl: OPENROUTER_BASE_URL,
      requestTimeoutMs: config.jevRequestTimeoutMs,
    },
    undefined,
    observer,
  );
  const queue = new RequestQueue({ rpmLimit: config.rpmLimit, concurrency: 1 });
  const controller = new AbortController();
  return {
    mode: config.jevEnabled ? 'active' : 'shadow',
    cancel: () => controller.abort(),
    policy: new JevActionPolicy(client, queue, {
      model: config.jevModel,
      minConfidence: config.jevMinConfidence ?? 0,
      minTopTwoMargin: config.jevMinTopTwoMargin ?? 0,
      maxActions: config.jevMaxActions,
      mode: config.jevEnabled ? 'active' : 'shadow',
      ...(traceObserver === undefined ? {} : { onTrace: traceObserver }),
      signal: controller.signal,
      contextOptions: {
        includeMemory: config.contextMemoryEnabled,
        includeFeatures: config.contextFeaturesEnabled,
        useBudgeter: config.contextBudgeterEnabled,
        useCardSummaries: config.contextCardSummariesEnabled,
        inputTokenBudget: config.contextInputTokenBudget,
      },
    }),
  };
}
