/**
 * What a seat's provider requests cost, shared by the tactician and strategist lanes.
 */
import type { AiNetworkAttempt } from '../../packages/server/src/ai/client';
import type { ActorAnswer } from './play';

export function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * What a decision's provider requests cost. An attempt may have been billed once a generation
 * started: it was answered, or it got a generation id or token counts before failing (a timeout
 * or a broken stream, which the client records for later settlement). Only when every such
 * attempt reports its charge is the decision's cost known; otherwise it stays unknown rather
 * than looking cheaper. Reported charges are always kept. Only attempts with no reported charge
 * are estimated from the lineup's price list; without one, the decision's cost stays unknown.
 */
export function settleAttempts(
  attempts: readonly AiNetworkAttempt[],
  pricing: { inputPerMTok: number; outputPerMTok: number } | undefined,
): {
  promptTokens: number;
  responseTokens: number;
  costUsd: number | undefined;
  costSource: ActorAnswer['costSource'];
} {
  const promptTokens = attempts.reduce((sum, a) => sum + (a.usage.promptTokens ?? 0), 0);
  const responseTokens = attempts.reduce((sum, a) => sum + (a.usage.responseTokens ?? 0), 0);
  const billed = attempts.filter(
    (attempt) =>
      attempt.usage.costUsd !== undefined ||
      attempt.status === 'accepted' ||
      attempt.status === 'rejected' ||
      attempt.providerRequestId !== undefined ||
      attempt.usage.promptTokens !== undefined ||
      attempt.usage.responseTokens !== undefined,
  );
  const reported = billed.filter((attempt) => attempt.usage.costUsd !== undefined);
  const reportedUsd = reported.reduce((sum, a) => sum + (a.usage.costUsd ?? 0), 0);
  const unpriced = billed.filter((attempt) => attempt.usage.costUsd === undefined);
  let costUsd: number | undefined;
  let costSource: ActorAnswer['costSource'] = 'unknown';
  if (billed.length === 0) {
    // No request, or every attempt failed before any generation started: unbilled.
    costUsd = 0;
    costSource = 'not_applicable';
  } else if (unpriced.length === 0) {
    costUsd = reportedUsd;
    costSource = 'reported';
  } else if (pricing !== undefined) {
    costUsd =
      reportedUsd +
      unpriced.reduce(
        (sum, a) =>
          sum +
          ((a.usage.promptTokens ?? 0) * pricing.inputPerMTok +
            (a.usage.responseTokens ?? 0) * pricing.outputPerMTok) /
            1_000_000,
        0,
      );
    costSource = 'estimated';
  }
  return { promptTokens, responseTokens, costUsd, costSource };
}
