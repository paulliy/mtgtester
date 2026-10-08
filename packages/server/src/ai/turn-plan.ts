/**
 * Evidence-bearing turn-plan executor. Standing intent lives on the coordinator; this class owns
 * only the executable queue and its lifecycle telemetry.
 */

import type { Engine } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
  GameEvent,
  LegalAction,
  Phase,
  PlannedAction,
  PlayerView,
  Step,
} from '@mtg/shared';
import type { DecisionSource } from './logger';
import {
  observationHash,
  stablePlanActions,
  type PlanArtifactMetadata,
  type PlanLifecycleEvent,
  type PlanLifecycleStatus,
  type TrackedPlannedAction,
} from './plan-lifecycle';
import { AI_VERSIONS } from './versions';

const PHASE_ORDER: Phase[] = ['beginning', 'precombatMain', 'combat', 'postcombatMain', 'ending'];
const STEP_ORDER: Step[] = [
  'untap',
  'upkeep',
  'draw',
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'firstStrikeCombatDamage',
  'combatDamage',
  'endCombat',
  'end',
  'cleanup',
];

function compareWindow(
  phase: Phase,
  step: Step | null,
  plannedPhase?: Phase,
  plannedStep?: Step | null,
): 'before' | 'at' | 'after' {
  if (plannedPhase !== undefined) {
    const current = PHASE_ORDER.indexOf(phase);
    const planned = PHASE_ORDER.indexOf(plannedPhase);
    if (current < planned) return 'before';
    if (current > planned) return 'after';
  }
  if (plannedStep !== undefined && plannedStep !== null && step !== null) {
    const current = STEP_ORDER.indexOf(step);
    const planned = STEP_ORDER.indexOf(plannedStep);
    if (current < planned) return 'before';
    if (current > planned) return 'after';
  }
  return 'at';
}

function latestSequence(engine?: Engine): number {
  const events =
    engine !== undefined && typeof engine.eventsSince === 'function' ? engine.eventsSince(0) : [];
  return events.at(-1)?.sequence ?? 0;
}

function objectVisible(view: PlayerView, id: string): boolean {
  return (
    view.hand.some((card) => card.id === id) ||
    view.battlefield.some((permanent) => permanent.id === id) ||
    view.stack.some((entry) => entry.id === id) ||
    view.exile.some((card) => card.id === id) ||
    view.graveyard.some((card) => card.id === id) ||
    view.opponents.some((opponent) => opponent.graveyard.some((card) => card.id === id))
  );
}

function sourceVisible(view: PlayerView, source: NonNullable<PlannedAction['source']>): boolean {
  if (source.objectId !== undefined && objectVisible(view, source.objectId)) return true;
  if (source.name !== undefined) {
    const lower = source.name.toLowerCase();
    return (
      view.hand.some((card) => card.name.toLowerCase() === lower) ||
      view.battlefield.some((permanent) => permanent.name.toLowerCase() === lower) ||
      view.commanders.some((commander) => commander.name.toLowerCase() === lower)
    );
  }
  // cardId is intentionally not present on PlayerView. It can still match a legal-action
  // interaction below, but cannot be asserted absent from the observation.
  return source.cardId !== undefined;
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(values);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(values);
  return typeof value === 'string' ? [value] : [];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plannedActionShapeError(planned: PlannedAction): string | null {
  const raw = planned as unknown as Record<string, unknown>;
  if (typeof raw['type'] !== 'string' || raw['type'].length === 0) {
    return 'planned action type must be a non-empty string';
  }
  if (raw['name'] !== undefined && typeof raw['name'] !== 'string') {
    return 'planned action name must be a string';
  }
  if (raw['description'] !== undefined && typeof raw['description'] !== 'string') {
    return 'planned action description must be a string';
  }
  if (raw['targets'] !== undefined) {
    if (!Array.isArray(raw['targets'])) return 'planned action targets must be an array';
    if (
      !raw['targets'].every(
        (target) =>
          record(target) &&
          typeof target['slot'] === 'number' &&
          typeof target['choice'] === 'string',
      )
    ) {
      return 'planned action target entries must contain numeric slots and string choices';
    }
  }
  if (raw['dependencies'] !== undefined) {
    if (
      !Array.isArray(raw['dependencies']) ||
      !raw['dependencies'].every((dependency) => typeof dependency === 'string')
    ) {
      return 'planned action dependencies must be strings';
    }
  }
  if (raw['preconditions'] !== undefined && !Array.isArray(raw['preconditions'])) {
    return 'planned action preconditions must be an array';
  }
  if (raw['source'] !== undefined) {
    if (!record(raw['source'])) return 'planned action source must be an object';
    for (const key of ['objectId', 'cardId', 'name']) {
      if (raw['source'][key] !== undefined && typeof raw['source'][key] !== 'string') {
        return `planned action source ${key} must be a string`;
      }
    }
  }
  return null;
}

export interface PlanInstallOptions {
  metadata?: PlanArtifactMetadata;
  sourceView?: PlayerView;
  acceptedSinceSource?: readonly AcceptedPlanAction[];
}

/** Actual accepted actions while a strategy's source observation was in flight. */
export interface AcceptedPlanAction {
  turn: number;
  player: string;
  phase: Phase;
  step: Step | null;
  action: LegalAction;
  targets?: DecisionResponse['targets'];
}

export class TurnPlanManager {
  private activePlayer: string | null = null;
  private turnNumber = -1;
  private queue: TrackedPlannedAction[] = [];
  private artifact: PlanArtifactMetadata | null = null;
  private readonly lifecycle: PlanLifecycleEvent[] = [];
  private readonly completedActionIds = new Set<string>();
  private readonly submittedByRequest = new Map<string, TrackedPlannedAction>();
  public onInvalidated?: (event: PlanLifecycleEvent) => void;

  constructor(private readonly scopedInvalidation = false) {}

  getQueue(): readonly PlannedAction[] {
    return this.queue;
  }

  getArtifact(): PlanArtifactMetadata | null {
    return this.artifact === null
      ? null
      : { ...this.artifact, source: { ...this.artifact.source } };
  }

  getLifecycleEvents(): readonly PlanLifecycleEvent[] {
    return this.lifecycle;
  }

  recordPlan(
    request: DecisionRequest,
    plannedActions: readonly PlannedAction[],
    engine?: Engine,
    options: PlanInstallOptions = {},
  ): void {
    const now = new Date().toISOString();
    const sequence = latestSequence(engine);
    const planId = options.metadata?.planId ?? `${request.requestId}:plan`;
    this.activePlayer = request.activePlayer;
    this.turnNumber = request.turn;
    this.artifact =
      options.metadata ??
      ({
        planId,
        generationId: 0,
        observerSeat: request.activePlayer,
        source: {
          eventSequence: sequence,
          hash: observationHash({ request, view: options.sourceView }),
          turn: request.turn,
          phase: request.phase,
          step: request.step,
        },
        promptVersion: AI_VERSIONS.prompt,
        configVersion: AI_VERSIONS.policy,
        generationStartedAt: now,
        generationCompletedAt: now,
        installationSequence: sequence,
      } satisfies PlanArtifactMetadata);
    this.queue = stablePlanActions(
      planId,
      plannedActions.map((planned) => ({ ...planned, phase: planned.phase ?? request.phase })),
    );
    this.completedActionIds.clear();
    this.submittedByRequest.clear();
    this.emit('generated', request, 'strategy artifact generated', sequence);

    const current =
      engine !== undefined && typeof engine.getState === 'function' ? engine.getState() : undefined;
    if (
      current !== undefined &&
      compareWindow(current.phase, current.step, request.phase, request.step) === 'after'
    ) {
      for (const action of this.queue) {
        this.emit(
          'expired_before_installation',
          request,
          'the source phase or step elapsed before the strategy installed',
          sequence,
          action,
        );
      }
      this.queue = [];
      return;
    }

    if (options.sourceView !== undefined) {
      const sourceView = options.sourceView;
      this.queue = this.queue.filter((action) => {
        const contradiction = this.sourceContradiction(action, request, sourceView);
        if (contradiction === null) return true;
        this.emit('impossible_at_source', request, contradiction, sequence, action);
        return false;
      });
    }
    for (const accepted of options.acceptedSinceSource ?? []) {
      if (accepted.turn !== request.turn || accepted.player !== request.activePlayer) continue;
      if (['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(accepted.action.type)) continue;
      const index = this.queue.findIndex((action) => {
        if (plannedActionShapeError(action) !== null) return false;
        if (compareWindow(accepted.phase, accepted.step, action.phase, action.step) !== 'at')
          return false;
        if (this.findMatchingAction(action, [accepted.action]) === null) return false;
        return (action.targets ?? []).every((target) => {
          const actual = accepted.targets?.find((choice) => choice.slot === target.slot);
          if (actual !== undefined) return actual.choice === target.choice;
          const slot = accepted.action.targets?.find((slot) => slot.slot === target.slot);
          return slot?.options.length === 1 && slot.options[0] === target.choice;
        });
      });
      if (index < 0) continue;
      const [action] = this.queue.splice(index, 1);
      this.completedActionIds.add(action!.id);
      this.emit(
        'already_accomplished',
        request,
        `engine accepted matching action ${accepted.action.id} after the source observation`,
        sequence,
        action,
      );
    }
    this.emit('installed', request, 'strategy artifact installed', sequence);
    engine?.addDebug('decision', `strategist plan recorded for ${request.activePlayer}`, {
      plan: this.artifact,
      plannedActions: this.queue,
    });
  }

  tryExecutePlan(request: DecisionRequest, engine?: Engine): DecisionResponse | null {
    if (request.decidingPlayer !== request.activePlayer) return null;
    if (this.turnNumber !== request.turn || this.activePlayer !== request.activePlayer) return null;

    while (this.queue.length > 0) {
      const planned = this.queue[0]!;
      const shapeError = plannedActionShapeError(planned);
      if (shapeError !== null) {
        const event = this.emit(
          'unsupported_by_engine',
          request,
          shapeError,
          latestSequence(engine),
          planned,
        );
        this.queue = [];
        this.onInvalidated?.(event);
        return null;
      }
      const window = compareWindow(request.phase, request.step, planned.phase, planned.step);
      if (window === 'after') {
        this.emit(
          'ambiguous',
          request,
          'planned action expired after installation without evidence establishing the cause',
          latestSequence(engine),
          planned,
        );
        this.queue.shift();
        continue;
      }
      if (window === 'before') {
        this.emit(
          'waiting_for_prerequisite',
          request,
          'planned phase or step has not been reached',
          latestSequence(engine),
          planned,
        );
        return null;
      }

      const waiting = this.waitingPrecondition(planned);
      if (waiting !== null) {
        this.emit('waiting_for_prerequisite', request, waiting, latestSequence(engine), planned);
        return null;
      }

      const failed = engine === undefined ? null : this.failedObservedPrecondition(planned, engine);
      if (failed !== null) {
        const evidence = this.relevantOpponentEvents(planned, engine!);
        const status: PlanLifecycleStatus =
          evidence.length > 0 ? 'invalidated_by_opponent' : 'ambiguous';
        const event = this.emit(
          status,
          request,
          evidence.length > 0 ? failed : `${failed}; no visible event establishes who caused it`,
          latestSequence(engine),
          planned,
          evidence.map((item) => item.sequence),
        );
        if (!this.scopedInvalidation) {
          this.queue = [];
          this.onInvalidated?.(event);
          return null;
        }
        this.queue.shift();
        this.onInvalidated?.(event);
        continue;
      }

      const matchedAction = this.findMatchingAction(planned, request.legalActions);
      if (matchedAction === null) {
        const evidence = engine === undefined ? [] : this.relevantOpponentEvents(planned, engine);
        const status: PlanLifecycleStatus =
          evidence.length > 0 ? 'invalidated_by_opponent' : 'ambiguous';
        const event = this.emit(
          status,
          request,
          evidence.length > 0
            ? 'a cited opponent event changed the legal menu and blocked this action'
            : 'the action was absent from the legal menu, but available evidence does not establish why',
          latestSequence(engine),
          planned,
          evidence.map((item) => item.sequence),
        );
        if (!this.scopedInvalidation) {
          this.queue = [];
          this.onInvalidated?.(event);
          return null;
        }
        this.queue.shift();
        this.onInvalidated?.(event);
        continue;
      }

      this.queue.shift();
      this.emit(
        'matched',
        request,
        `matched legal action ${matchedAction.id}`,
        latestSequence(engine),
        planned,
      );
      const response: DecisionResponse = {
        requestId: request.requestId,
        actionId: matchedAction.id,
        note: `TurnPlan: pre-planned action executed (${planned.type}${planned.name ? `: ${planned.name}` : ''})`,
      };
      if (planned.targets !== undefined) response.targets = planned.targets;
      this.submittedByRequest.set(request.requestId, planned);
      this.emit(
        'submitted',
        request,
        'planned response returned to the engine runner',
        latestSequence(engine),
        planned,
      );
      return response;
    }
    return null;
  }

  /** Called only after Engine.submit() returned successfully. */
  recordAccepted(request: DecisionRequest, response: DecisionResponse, engine?: Engine): void {
    const planned = this.submittedByRequest.get(request.requestId);
    if (planned === undefined) return;
    this.submittedByRequest.delete(request.requestId);
    this.completedActionIds.add(planned.id);
    this.emit(
      'accepted',
      request,
      `engine accepted actionId ${response.actionId}`,
      latestSequence(engine),
      planned,
    );
  }

  recordDecision(
    request: DecisionRequest,
    response: DecisionResponse,
    source: DecisionSource,
    engine?: Engine,
  ): void {
    if (this.turnNumber !== request.turn || this.activePlayer !== request.activePlayer) {
      this.activePlayer = request.activePlayer;
      this.turnNumber = request.turn;
      this.queue = [];
      this.artifact = null;
      this.completedActionIds.clear();
      this.submittedByRequest.clear();
    }

    if (
      request.decidingPlayer === request.activePlayer &&
      this.queue.length > 0 &&
      source !== 'plan'
    ) {
      for (const planned of this.queue) {
        this.emit(
          'invalidated_by_own_deviation',
          request,
          `the active seat submitted a ${source} action instead of the executable queue`,
          latestSequence(engine),
          planned,
        );
      }
      this.queue = [];
      const event = this.lifecycle.at(-1);
      if (event !== undefined) this.onInvalidated?.(event);
    }

    if (!this.scopedInvalidation && request.decidingPlayer !== request.activePlayer) {
      const chosen = request.legalActions.find((action) => action.id === response.actionId);
      if (
        chosen !== undefined &&
        !['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(chosen.type) &&
        this.queue.length > 0
      ) {
        for (const planned of this.queue) {
          this.emit(
            'ambiguous',
            request,
            'legacy executor invalidated on a non-pass opponent action without causal proof',
            latestSequence(engine),
            planned,
          );
        }
        this.queue = [];
        const event = this.lifecycle.at(-1);
        if (event !== undefined) this.onInvalidated?.(event);
      }
    }

    // With scoped invalidation enabled, opponent actions are evidence, not automatic
    // invalidation. The next active-seat decision evaluates preconditions and the legal menu.

    if (
      request.decidingPlayer === request.activePlayer &&
      response.plannedActions !== undefined &&
      response.plannedActions.length > 0
    ) {
      this.recordPlan(
        request,
        response.plannedActions.map((planned) => ({
          ...planned,
          phase: planned.phase ?? request.phase,
          step: planned.step ?? request.step,
        })),
        engine,
        engine === undefined ? {} : { sourceView: engine.view(request.decidingPlayer) },
      );
    }
  }

  clear(status: 'superseded' | 'cancelled' = 'superseded'): void {
    if (this.artifact !== null && this.queue.length > 0) {
      const request = this.syntheticRequest();
      for (const planned of this.queue) {
        this.emit(status, request, `plan ${status}`, this.artifact.source.eventSequence, planned);
      }
    }
    this.queue = [];
    this.artifact = null;
    this.completedActionIds.clear();
    this.submittedByRequest.clear();
  }

  private sourceContradiction(
    action: TrackedPlannedAction,
    request: DecisionRequest,
    view: PlayerView,
  ): string | null {
    if (action.dependencies?.includes(action.id) === true) return 'action depends on itself';
    for (const precondition of action.preconditions ?? []) {
      if (precondition.kind === 'phaseReached') {
        if (
          action.phase !== undefined &&
          compareWindow(
            action.phase,
            action.step ?? null,
            precondition.phase,
            precondition.step,
          ) === 'before'
        ) {
          return 'declared phase window occurs before its required phase';
        }
      }
      if (precondition.kind === 'sourceAvailable' && !sourceVisible(view, precondition.source)) {
        return 'required source was not present in the source observation';
      }
      if (precondition.kind === 'targetAvailable' && !objectVisible(view, precondition.objectId)) {
        return 'required target was not present in the source observation';
      }
    }
    if (action.source !== undefined && !sourceVisible(view, action.source)) {
      return 'planned source was not present in the source observation';
    }
    if (compareWindow(request.phase, request.step, action.phase, action.step) === 'after') {
      return 'planned phase or step was already expired at source';
    }
    return null;
  }

  private waitingPrecondition(action: TrackedPlannedAction): string | null {
    for (const dependency of action.dependencies ?? []) {
      if (!this.completedActionIds.has(dependency)) return `dependency ${dependency} is incomplete`;
    }
    for (const precondition of action.preconditions ?? []) {
      if (
        precondition.kind === 'actionCompleted' &&
        !this.completedActionIds.has(precondition.actionId)
      ) {
        return `dependency ${precondition.actionId} is incomplete`;
      }
    }
    return null;
  }

  private failedObservedPrecondition(action: TrackedPlannedAction, engine: Engine): string | null {
    const view = engine.view(this.activePlayer!);
    if (action.source !== undefined && !sourceVisible(view, action.source)) {
      return 'planned source is no longer available';
    }
    for (const precondition of action.preconditions ?? []) {
      if (precondition.kind === 'sourceAvailable' && !sourceVisible(view, precondition.source)) {
        return 'required source is no longer available';
      }
      if (precondition.kind === 'targetAvailable' && !objectVisible(view, precondition.objectId)) {
        return 'required target is no longer available';
      }
    }
    return null;
  }

  private relevantOpponentEvents(action: TrackedPlannedAction, engine: Engine): GameEvent[] {
    const start = (this.artifact?.source.eventSequence ?? 0) + 1;
    const needles = new Set<string>();
    const addSource = (source: NonNullable<PlannedAction['source']>): void => {
      if (source.objectId !== undefined) needles.add(source.objectId.toLowerCase());
      if (source.cardId !== undefined) needles.add(source.cardId.toLowerCase());
      if (source.name !== undefined) needles.add(source.name.toLowerCase());
    };
    if (action.source !== undefined) addSource(action.source);
    for (const target of action.targets ?? []) needles.add(target.choice.toLowerCase());
    for (const precondition of action.preconditions ?? []) {
      if (precondition.kind === 'sourceAvailable') addSource(precondition.source);
      if (precondition.kind === 'targetAvailable') needles.add(precondition.objectId.toLowerCase());
    }
    if (needles.size === 0) return [];
    if (typeof engine.eventsSince !== 'function') return [];
    return engine.eventsSince(start).filter((event) => {
      if (event.actorSeat === null || event.actorSeat === this.activePlayer) return false;
      const haystack = values(event.payload).join(' ').toLowerCase();
      return [...needles].some((needle) => haystack.includes(needle));
    });
  }

  private emit(
    status: PlanLifecycleStatus,
    request: DecisionRequest,
    evidence: string,
    eventSequence: number,
    action?: TrackedPlannedAction,
    evidenceEventSequences: number[] = [],
  ): PlanLifecycleEvent {
    const artifact = this.artifact;
    const event: PlanLifecycleEvent = {
      planId: artifact?.planId ?? `${request.requestId}:plan`,
      generationId: artifact?.generationId ?? 0,
      ...(action === undefined ? {} : { actionId: action.id }),
      status,
      turn: request.turn,
      phase: request.phase,
      step: request.step,
      eventSequence,
      evidence,
      evidenceEventSequences,
    };
    this.lifecycle.push(event);
    return event;
  }

  private syntheticRequest(): DecisionRequest {
    return {
      requestId: this.artifact?.planId ?? 'cleared-plan',
      gameId: 'plan-lifecycle',
      turn: this.turnNumber,
      activePlayer: this.activePlayer ?? 'unknown',
      decidingPlayer: this.activePlayer ?? 'unknown',
      phase: this.artifact?.source.phase ?? 'ending',
      step: this.artifact?.source.step ?? null,
      decisionType: 'general',
      prompt: 'plan lifecycle',
      legalActions: [],
    };
  }

  private findMatchingAction(
    planned: TrackedPlannedAction,
    legalActions: LegalAction[],
  ): LegalAction | null {
    const targetValid = (action: LegalAction): boolean => {
      if (action.targets === undefined || action.targets.length === 0) return true;
      for (const slot of action.targets) {
        if (slot.options.length <= 1) continue;
        const choice = planned.targets?.find((target) => target.slot === slot.slot);
        if (choice === undefined || !slot.options.includes(choice.choice)) return false;
      }
      return true;
    };
    const sourceValid = (action: LegalAction): boolean => {
      if (planned.source === undefined) return true;
      const interaction = action.interaction;
      if (interaction?.kind !== 'source') return false;
      if (planned.source.objectId !== undefined && interaction.sourceId !== planned.source.objectId)
        return false;
      if (planned.source.cardId !== undefined && interaction.sourceCardId !== planned.source.cardId)
        return false;
      return true;
    };

    if (planned.type === 'pass') {
      return (
        legalActions.find((action) =>
          ['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(action.type),
        ) ?? null
      );
    }
    for (const action of legalActions) {
      if (action.type !== planned.type || !sourceValid(action)) continue;
      if (
        planned.name !== undefined &&
        !action.description.toLowerCase().includes(planned.name.toLowerCase())
      )
        continue;
      if (targetValid(action)) return action;
    }
    if (planned.description !== undefined) {
      return (
        legalActions.find(
          (action) =>
            sourceValid(action) &&
            targetValid(action) &&
            action.description.toLowerCase().includes(planned.description!.toLowerCase()),
        ) ?? null
      );
    }
    return null;
  }
}
