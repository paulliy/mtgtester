/**
 * Turn arms for ADR 0045's study: the tactician, played through the production provider, with or
 * without a hand-built strategist context, and a reviewer's scripted reference line.
 */
import type { Engine } from '@mtg/engine';
import type {
  BotSteering,
  DecisionRequest,
  DecisionResponse,
  PlayerId,
  PlayerView,
  TargetChoice,
  TurnStrategy,
} from '@mtg/shared';
import type { AiClient } from '../ai/client';
import type { AiConfig } from '../ai/config';
import type { TacticalGuidance } from '../ai/context';
import type { SeatDiplomacyContext } from '../ai/diplomacy-context';
import { AiCallLogger, type CallResult, type DecisionSource } from '../ai/logger';
import { OpenAiDecisionProvider } from '../ai/provider';
import { StrategyCoordinator } from '../ai/strategy-coordinator';
import type { TurnPolicy, TurnPolicyFactory } from './turn-counterfactual';

/**
 * The strategist context the study hands the tactician (ADR 0045 decision 1.7): its intent and
 * threat order, its knobs, and the reason it flagged the turn. Built by hand for the study, before
 * any primer change, and passed through the existing `TacticalGuidance`.
 */
export interface StudyContext {
  intent: string;
  threatOrder?: PlayerId[];
  steering?: BotSteering;
  flagReason?: string;
  /** The seat's deals at the fork, as a live table would summarise them for its tactician. */
  deals?: SeatDiplomacyContext;
}

export function contextStrategy(context: StudyContext): TurnStrategy {
  return {
    intent:
      context.flagReason === undefined
        ? context.intent
        : `${context.intent} (the strategist flagged this turn: ${context.flagReason})`,
    plannedActions: [],
    ...(context.threatOrder === undefined ? {} : { threatOrder: context.threatOrder }),
    ...(context.steering === undefined ? {} : { steering: context.steering }),
  };
}

/**
 * A coordinator that never calls a strategist and hands the tactician a fixed strategy and deals:
 * the study's hand-built context, or a bot-bench case's `context` block.
 */
export class FixedGuidance extends StrategyCoordinator {
  constructor(
    engine: Engine,
    config: AiConfig,
    private readonly seat: PlayerId,
    private readonly fixed: TurnStrategy | null,
    private readonly deals: SeatDiplomacyContext | null = null,
  ) {
    super(null, { enqueue: <T>(fn: () => Promise<T>): Promise<T> => fn() }, engine, config);
  }

  override prepare(): void {}

  /** The fixed strategy's knobs steer the seat's bot in bot-led mode. */
  override steeringFor(seat: PlayerId): BotSteering | undefined {
    return seat === this.seat ? this.fixed?.steering : undefined;
  }

  override tryExecutePlan(): DecisionResponse | null {
    return null;
  }

  override guidanceFor(
    playerId: string,
    request?: DecisionRequest,
    view?: ReturnType<Engine['view']>,
  ): TacticalGuidance {
    const base = super.guidanceFor(playerId, request, view);
    const mine = playerId === this.seat;
    return {
      ...base,
      strategy: mine ? this.fixed : null,
      ...(mine && this.deals !== null ? { deals: this.deals } : {}),
    };
  }
}

/** Remembers how the provider answered each request, so fallbacks are not credited. */
class SourceLogger extends AiCallLogger {
  readonly sources = new Map<string, DecisionSource>();
  override log(
    request: DecisionRequest,
    result: CallResult,
    wasRetry: boolean,
    wasFallback: boolean,
    source: DecisionSource = 'primary',
  ): void {
    super.log(request, result, wasRetry, wasFallback, source);
    this.sources.set(request.requestId, source);
  }
}

/**
 * The tactician arm: the production provider in model mode on the forked engine, with the study
 * context or none. A decision the provider's fallback bot made returns null, so the rollout's bot
 * plays it and nothing the fallback did is credited to the model.
 */
export function tacticianArm(
  client: AiClient,
  config: AiConfig,
  context: StudyContext | null,
): TurnPolicyFactory {
  return (engine, seat) => {
    const armConfig: AiConfig = {
      ...config,
      tacticalMode: 'model',
      strategistEnabled: false,
      decisionCacheEnabled: false,
      jevEnabled: false,
      jevShadowEnabled: false,
    };
    const logger = new SourceLogger(null, `turn-study-${seat}`);
    const provider = new OpenAiDecisionProvider(
      client,
      { enqueue: <T>(fn: () => Promise<T>): Promise<T> => fn() },
      engine,
      armConfig,
      logger,
      undefined,
      new FixedGuidance(
        engine,
        armConfig,
        seat,
        context === null ? null : contextStrategy(context),
        context?.deals ?? null,
      ),
    );
    return async (request) => {
      const response = await provider.decide(request);
      return logger.sources.get(request.requestId) === 'fallback' ? null : response;
    };
  };
}

/** One step of a reviewer's line: the action whose description contains `choose`, targets by name. */
export interface LineStep {
  choose: string;
  targets?: string[];
}

/**
 * The slot option a line names: the option itself when the line gives it literally (a seat, an
 * object id, `__no_attack__`, `__no_block__`), else the one option whose object has that name.
 * Undefined when nothing on the menu matches, or the name is ambiguous among the options.
 */
function slotOption(
  view: PlayerView,
  options: readonly string[],
  wanted: string,
): string | undefined {
  if (options.includes(wanted)) return wanted;
  const named = (id: string): string | undefined =>
    view.battlefield.find((p) => p.id === id)?.name ??
    view.hand.find((c) => c.id === id)?.name ??
    view.graveyard.find((c) => c.id === id)?.name ??
    view.stack.find((s) => s.id === id)?.description;
  const matches = options.filter((option) => named(option) === wanted);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A reviewer's line that cannot be played as written: it is not a reference to compare with. */
export class ReferenceLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceLineError';
  }
}

/**
 * The scripted reference arm (ADR 0045 decision 1.5), written from the seat's view at the fork.
 * Each decision the next step names takes it; a priority window no step names is passed; any
 * other decision (an attack the line does not script) is left to the bot.
 */
export function referenceArm(steps: readonly LineStep[]): TurnPolicyFactory {
  return () => {
    let next = 0;
    const policy: TurnPolicy = (request, view) => {
      const step = steps[next];
      if (step !== undefined) {
        const action = request.legalActions.find((a) => a.description.includes(step.choose));
        if (action !== undefined) {
          const targets: TargetChoice[] = (action.targets ?? []).map((slot, i) => {
            const wanted = step.targets?.[i];
            // A slot the line leaves open takes its first option; a slot it names must match.
            if (wanted === undefined) return { slot: slot.slot, choice: slot.options[0]! };
            const choice = slotOption(view, slot.options, wanted);
            if (choice === undefined)
              throw new ReferenceLineError(
                `step "${step.choose}": "${wanted}" is not one of slot ${slot.slot}'s options`,
              );
            return { slot: slot.slot, choice };
          });
          next++;
          return {
            requestId: request.requestId,
            actionId: action.id,
            ...(targets.length > 0 && { targets }),
          };
        }
      }
      if (request.decisionType !== 'priority') return null;
      const pass = request.legalActions.find((a) => a.type === 'pass');
      return pass === undefined ? null : { requestId: request.requestId, actionId: pass.id };
    };
    return policy;
  };
}
