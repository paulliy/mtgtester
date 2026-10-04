export interface ContextBudgetReport {
  version: 'context-budget-v1';
  limitTokens: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  omissions: Array<{ section: string; count: number; reason: string }>;
  tierChanges: Array<{ cardId: string; from: string; to: string }>;
  exceeded: boolean;
  route: 'normal' | 'larger_context_required';
}

export interface BudgetedContext<T> {
  payload: T;
  report: ContextBudgetReport;
}

function estimate(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/**
 * Deterministic optional-context trimmer. `legalActions`, `stack`, `you.hand`, commander state,
 * and battlefield objects are never removed. If those alone exceed the limit, the payload stays
 * complete and the caller receives an explicit larger-context route instead of silent loss.
 */
export function budgetContext<T extends Record<string, unknown>>(
  input: T,
  limitTokens: number,
): BudgetedContext<T> {
  const payload = structuredClone(input);
  const before = estimate(payload);
  const omissions: ContextBudgetReport['omissions'] = [];
  const tierChanges: ContextBudgetReport['tierChanges'] = [];
  if (before <= limitTokens) {
    return {
      payload,
      report: {
        version: 'context-budget-v1',
        limitTokens,
        estimatedTokensBefore: before,
        estimatedTokensAfter: before,
        omissions,
        tierChanges,
        exceeded: false,
        route: 'normal',
      },
    };
  }

  const mutable = payload as Record<string, unknown>;
  const recentLog = mutable['recentLog'];
  if (Array.isArray(recentLog) && recentLog.length > 4) {
    omissions.push({
      section: 'recentLog',
      count: recentLog.length - 4,
      reason: 'oldest optional log entries',
    });
    mutable['recentLog'] = recentLog.slice(-4);
  }
  const memory = mutable['publicMemory'];
  if (typeof memory === 'object' && memory !== null) {
    const entries = (memory as Record<string, unknown>)['entries'];
    if (Array.isArray(entries) && entries.length > 12) {
      omissions.push({
        section: 'publicMemory',
        count: entries.length - 12,
        reason: 'oldest optional public history',
      });
      (memory as Record<string, unknown>)['entries'] = entries.slice(-12);
    }
  }
  const exile = mutable['publicExile'];
  if (Array.isArray(exile) && exile.length > 12) {
    omissions.push({
      section: 'publicExile',
      count: exile.length - 12,
      reason: 'inactive background cards',
    });
    mutable['publicExile'] = exile.slice(-12);
  }

  const after = estimate(payload);
  return {
    payload,
    report: {
      version: 'context-budget-v1',
      limitTokens,
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      omissions,
      tierChanges,
      exceeded: after > limitTokens,
      route: after > limitTokens ? 'larger_context_required' : 'normal',
    },
  };
}
