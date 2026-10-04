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
      confidence: number;
      topTwoMargin: number;
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
  ): Promise<JevPolicyOutcome>;
}

export interface JevPolicyBinding {
  policy: JevTacticalPolicy;
  mode: 'active' | 'shadow';
  cancel?: () => void;
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
  engineAcceptance: 'accepted' | 'not_checked' | 'not_applicable';
}

export type JevTraceObserver = (trace: JevDecisionTrace) => void;

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
  ): Promise<JevPolicyOutcome> {
    const built = buildJevActionRequest(
      this.options.model,
      request,
      view,
      guidance,
      this.options.contextOptions,
      this.options.maxActions,
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
        confidence: adaptation.confidence,
        topTwoMargin: adaptation.topTwoMargin,
        probabilities: adaptation.probabilities,
        selectedActionId: adaptation.response.actionId,
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
    if (
      adaptation.confidence < this.options.minConfidence ||
      adaptation.topTwoMargin < this.options.minTopTwoMargin
    ) {
      this.trace(request, built.classification, {
        outcome: 'fallthrough',
        fallbackReason: 'low_confidence',
        validationResult: 'valid',
        networkAttempted: true,
        model: result.meta.responseModel,
        confidence: adaptation.confidence,
        topTwoMargin: adaptation.topTwoMargin,
        probabilities: adaptation.probabilities,
        selectedActionId: adaptation.response.actionId,
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
      confidence: adaptation.confidence,
      topTwoMargin: adaptation.topTwoMargin,
      probabilities: adaptation.probabilities,
      selectedActionId: adaptation.response.actionId,
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
