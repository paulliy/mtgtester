/**
 * The bot-led tactician (ADR 0039): the card-aware heuristic bot answers a seat's tactical
 * decisions, steered by the strategist's knobs, and says when a decision is close enough that the
 * model should be asked instead.
 */

import type { Engine } from '@mtg/engine';
import type { BotSteering, DecisionRequest, DecisionResponse, PlayerId } from '@mtg/shared';
import { HeuristicDecisionProvider, type CardKnowledge, type ScoredAction } from '@mtg/bot';
import { buildCardKnowledge } from './card-traits';

const knowledgeByEngine = new WeakMap<object, CardKnowledge>();

/** One card-traits lookup per game, shared by every seat. */
export function knowledgeFor(engine: Engine): CardKnowledge {
  let knowledge = knowledgeByEngine.get(engine);
  if (knowledge === undefined) {
    const defs = typeof engine.cardDefinitions === 'function' ? engine.cardDefinitions() : [];
    knowledge = buildCardKnowledge(defs);
    knowledgeByEngine.set(engine, knowledge);
  }
  return knowledge;
}

/** Decision types where a close call changes the board enough to be worth a model call. */
const ESCALATABLE: ReadonlySet<string> = new Set([
  'priority',
  'chooseTargets',
  'chooseModes',
  'chooseX',
]);

const PASS_TYPES: ReadonlySet<string> = new Set(['pass', 'passAndYieldTurn', 'yieldToAbility']);

/**
 * Whether the bot's ranking is too close to trust: the top two options are within `margin` LEP
 * and are genuinely different choices. Two passes, or two copies of the same cast, are not.
 */
export function isUncertain(
  request: DecisionRequest,
  ranked: readonly ScoredAction[],
  margin: number,
): boolean {
  if (!ESCALATABLE.has(request.decisionType)) return false;
  const [first, second] = ranked;
  if (first === undefined || second === undefined) return false;
  if (first.score - second.score >= margin) return false;
  if (PASS_TYPES.has(first.action.type) && PASS_TYPES.has(second.action.type)) return false;
  if (first.action.description === second.action.description) return false;
  return true;
}

export interface BotAnswer {
  response: DecisionResponse;
  uncertain: boolean;
}

export class BotTactician {
  private readonly bot: HeuristicDecisionProvider;

  constructor(
    engine: Engine,
    seat: PlayerId,
    gameId: string,
    steering: () => BotSteering | undefined,
    private readonly margin: number,
  ) {
    this.bot = new HeuristicDecisionProvider(`${gameId}-${seat}-bot`, () => engine.view(seat), {
      knowledge: knowledgeFor(engine),
      steering,
    });
  }

  /** The bot's answer, not yet recorded: call `record` with whatever is finally chosen. */
  decide(request: DecisionRequest): BotAnswer {
    const scored = this.bot.decideScored(request, false);
    return {
      response: scored.response,
      uncertain: isUncertain(request, scored.ranked, this.margin),
    };
  }

  record(request: DecisionRequest, response: DecisionResponse): void {
    this.bot.record(request, response);
  }
}
