import type { DecisionRequest, DecisionResponse, PlayerView } from '@mtg/shared';
import type { CallMeta } from './client';
import type { ContextOptions, TacticalGuidance } from './context';
import {
  adaptJevActionAnswer,
  buildJevActionRequest,
  type JevActionRequest,
  type JevDecisionAdaptation,
} from './jev-context';
import type { JevActionResult } from './jev-client';
import type { TacticalDecisionClassification } from './tactical-decision-shape';
import { validateResponse } from './validate';

export interface JevActionClient {
  requestAction(request: JevActionRequest, signal?: AbortSignal): Promise<JevActionResult>;
}

export interface JevPolicyQueue {
  enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface JevActionPolicyOptions {
  model: string;
  minConfidence: number;
  minTopTwoMargin: number;
  maxActions?: number;
  /** Offer a targeted action once per legal target (see `AiConfig.jevExpandTargets`). */
  expandTargets?: boolean;
  contextOptions?: ContextOptions;
  mode?: 'active' | 'shadow';
  onTrace?: JevTraceObserver;
  signal?: AbortSignal;
}

export type JevFallthroughReason =
  'unsupported_shape' | 'cancelled' | 'transport_failure' | 'invalid_response' | 'low_confidence';

export type JevPolicyOutcome =
  | {
      kind: 'answered';
      response: DecisionResponse;
      meta: CallMeta;
      classification: TacticalDecisionClassification;
      /** Null when Jev reported neither confidence nor probabilities. */
      confidence: number | null;
      topTwoMargin: number | null;
      probabilities: Record<string, number>;
    }
  | {
      kind: 'fallthrough';
      reason: JevFallthroughReason;
      detail: string;
      classification: TacticalDecisionClassification;
      adaptation?: JevDecisionAdaptation;
    };

export interface JevTacticalPolicy {
  decide(
    request: DecisionRequest,
    view: PlayerView,
    guidance?: TacticalGuidance,
    hints?: JevDecideHints,
  ): Promise<JevPolicyOutcome>;
}

export interface JevDecideHints {
  /** Replaces the default Choice instructions for this one decision. */
  instructions?: string;
}

export interface JevPolicyBinding {
  policy: JevTacticalPolicy;
  mode: 'active' | 'shadow';
  cancel?: () => void;
  /** Receives shadow and fallthrough comparisons against the answer actually played. */
  onComparison?: JevComparisonObserver;
}

export interface JevDecisionTrace {
  schemaVersion: 1;
  logicalRequestId: string;
  recordedAt: string;
  mode: 'active' | 'shadow';
  classification: TacticalDecisionClassification;
  outcome: 'accepted' | 'fallthrough';
  fallbackReason?: JevFallthroughReason;
  validationResult: 'valid' | 'invalid' | 'not_applicable';
  networkAttempted: boolean;
  model?: string;
  confidence?: number;
  topTwoMargin?: number;
  probabilities?: Record<string, number>;
  selectedActionId?: number;
  /** The option key Jev chose; differs from `action_<id>` when targets were expanded. */
  selectedOption?: string;
  costUsd?: number;
  latencyMs?: number;
  engineAcceptance: 'accepted' | 'not_checked' | 'not_applicable';
}

export type JevTraceObserver = (trace: JevDecisionTrace) => void;

/**
 * Jev's answer set beside the answer the seat actually played (shadow mode, or a Jev fallthrough
 * that another answerer settled). This is the evidence for "would Jev have agreed?".
 */
export interface JevComparison {
  schemaVersion: 1;
  logicalRequestId: string;
  seat: string;
  turn: number;
  decisionType: string;
  /** Who produced the played answer. */
  playedBy: 'bot' | 'model' | 'fallback';
  playedActionId: number;
  /** Whether the bot called this decision close (bot mode only). */
  botUncertain?: boolean;
  jevOutcome: 'answered' | JevFallthroughReason;
  jevActionId?: number;
  /** Same action and same targets as the played answer. */
  agreed?: boolean;
  /** Same action, any targets. */
  sameAction?: boolean;
  confidence?: number;
  topTwoMargin?: number;
}

export type JevComparisonObserver = (comparison: JevComparison) => void;

/** Same action, and the same object in every target slot. */
export function sameResponse(left: DecisionResponse, right: DecisionResponse): boolean {
  if (left.actionId !== right.actionId) return false;
  const key = (response: DecisionResponse): string =>
    JSON.stringify(
      [...(response.targets ?? [])]
        .sort((a, b) => a.slot - b.slot)
        .map((target) => [target.slot, target.choice]),
    );
  return key(left) === key(right);
}

function callMeta(result: JevActionResult): CallMeta {
  return {
    model: result.meta.responseModel,
    requestedModel: result.meta.requestedModel,
    responseModel: result.meta.responseModel,
    ...(result.meta.provider === undefined ? {} : { backend: result.meta.provider }),
    ...(result.meta.providerRequestId === undefined
      ? {}
      : { providerRequestId: result.meta.providerRequestId }),
    promptTokens: result.meta.promptTokens,
    responseTokens: result.meta.responseTokens,
    promptTokenSource: 'reported',
    responseTokenSource: 'reported',
    latencyMs: result.meta.latencyMs,
    wasRetry: false,
    wasFallback: false,
    rawResponse: result.meta.rawResponse,
    ...(result.meta.costUsd === undefined ? {} : { costUsd: result.meta.costUsd }),
    costSource: result.meta.costUsd === undefined ? 'unknown' : 'reported',
  };
}

function scores(
  adaptation: Extract<JevDecisionAdaptation, { kind: 'accepted' }>,
  result: JevActionResult,
): Partial<JevDecisionTrace> {
  return {
    ...(adaptation.confidence === null ? {} : { confidence: adaptation.confidence }),
    ...(adaptation.topTwoMargin === null ? {} : { topTwoMargin: adaptation.topTwoMargin }),
    probabilities: adaptation.probabilities,
    selectedActionId: adaptation.response.actionId,
    selectedOption: result.answer.choice,
    ...(result.meta.costUsd === undefined ? {} : { costUsd: result.meta.costUsd }),
    latencyMs: result.meta.latencyMs,
  };
}

/** Jev action-selection policy. Unsupported or uncertain outcomes explicitly fall through. */
export class JevActionPolicy implements JevTacticalPolicy {
  constructor(
    private readonly client: JevActionClient,
    private readonly queue: JevPolicyQueue,
    private readonly options: JevActionPolicyOptions,
  ) {}

  private trace(
    request: DecisionRequest,
    classification: TacticalDecisionClassification,
    fields: Omit<
      JevDecisionTrace,
      'schemaVersion' | 'logicalRequestId' | 'recordedAt' | 'mode' | 'classification'
    >,
  ): void {
    this.options.onTrace?.({
      schemaVersion: 1,
      logicalRequestId: request.requestId,
      recordedAt: new Date().toISOString(),
      mode: this.options.mode ?? 'active',
      classification,
      ...fields,
    });
  }

  async decide(
    request: DecisionRequest,
    view: PlayerView,
    guidance?: TacticalGuidance,
    hints?: JevDecideHints,
  ): Promise<JevPolicyOutcome> {
    const built = buildJevActionRequest(
      this.options.model,
      request,
      view,
      guidance,
      this.options.contextOptions,
      this.options.maxActions,
      {
        expandTargets: this.options.expandTargets === true,
        ...(hints?.instructions === undefined ? {} : { instructions: hints.instructions }),
      },
    );
    if (built.kind === 'unsupported') {
      this.trace(request, built.classification, {
        outcome: 'fallthrough',
        fallbackReason: 'unsupported_shape',
        validationResult: 'not_applicable',
        networkAttempted: false,
        engineAcceptance: 'not_applicable',
      });
      return {
        kind: 'fallthrough',
        reason: 'unsupported_shape',
        detail: built.classification.reason,
        classification: built.classification,
      };
    }

    let result: JevActionResult;
    try {
      result = await this.queue.enqueue(
        () => this.client.requestAction(built, this.options.signal),
        this.options.signal,
      );
    } catch (error) {
      const cancelled = this.options.signal?.aborted === true;
      this.trace(request, built.classification, {
        outcome: 'fallthrough',
        fallbackReason: cancelled ? 'cancelled' : 'transport_failure',
        validationResult: 'not_applicable',
        networkAttempted: true,
        engineAcceptance: 'not_applicable',
      });
      return {
        kind: 'fallthrough',
        reason: cancelled ? 'cancelled' : 'transport_failure',
        detail: error instanceof Error ? error.message : String(error),
        classification: built.classification,
      };
    }

    const adaptation = adaptJevActionAnswer(built, request, result.answer);
    if (adaptation.kind === 'invalid') {
      this.trace(request, built.classification, {
        outcome: 'fallthrough',
        fallbackReason: 'invalid_response',
        validationResult: 'invalid',
        networkAttempted: true,
        model: result.meta.responseModel,
        engineAcceptance: 'not_applicable',
      });
      return {
        kind: 'fallthrough',
        reason: 'invalid_response',
        detail: adaptation.reason,
        classification: built.classification,
        adaptation,
      };
    }
    const validation = validateResponse(adaptation.response, request);
    if (validation !== null) {
      this.trace(request, built.classification, {
        outcome: 'fallthrough',
        fallbackReason: 'invalid_response',
        validationResult: 'invalid',
        networkAttempted: true,
        model: result.meta.responseModel,
        ...scores(adaptation, result),
        engineAcceptance: 'not_applicable',
      });
      return {
        kind: 'fallthrough',
        reason: 'invalid_response',
        detail: validation,
        classification: built.classification,
        adaptation,
      };
    }
    // An unreported score passes only a zero threshold: unknown is never treated as confident.
    const belowConfidence =
      this.options.minConfidence > 0 &&
      (adaptation.confidence === null || adaptation.confidence < this.options.minConfidence);
    const belowMargin =
      this.options.minTopTwoMargin > 0 &&
      (adaptation.topTwoMargin === null || adaptation.topTwoMargin < this.options.minTopTwoMargin);
    if (belowConfidence || belowMargin) {
      this.trace(request, built.classification, {
        outcome: 'fallthrough',
        fallbackReason: 'low_confidence',
        validationResult: 'valid',
        networkAttempted: true,
        model: result.meta.responseModel,
        ...scores(adaptation, result),
        engineAcceptance: 'not_applicable',
      });
      return {
        kind: 'fallthrough',
        reason: 'low_confidence',
        detail: `confidence=${adaptation.confidence}, margin=${adaptation.topTwoMargin}`,
        classification: built.classification,
        adaptation,
      };
    }

    this.trace(request, built.classification, {
      outcome: 'accepted',
      validationResult: 'valid',
      networkAttempted: true,
      model: result.meta.responseModel,
      ...scores(adaptation, result),
      engineAcceptance:
        (this.options.mode ?? 'active') === 'shadow' ? 'not_applicable' : 'not_checked',
    });
    return {
      kind: 'answered',
      response: adaptation.response,
      meta: callMeta(result),
      classification: built.classification,
      confidence: adaptation.confidence,
      topTwoMargin: adaptation.topTwoMargin,
      probabilities: adaptation.probabilities,
    };
  }
}
