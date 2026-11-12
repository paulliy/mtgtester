/**
 * The bot-led tactician (ADR 0039): the card-aware heuristic bot answers a seat's tactical
 * decisions, steered by the strategist's knobs, and says when a decision is close enough that the
 * model should be asked instead.
 */

import type { Engine } from '@mtg/engine';
import type { BotSteering, DecisionRequest, DecisionResponse, PlayerId } from '@mtg/shared';
import {
  HeuristicDecisionProvider,
  type CardKnowledge,
  type DiplomacyPlay,
  type ScoredAction,
} from '@mtg/bot';
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
  // Which land to play is rarely worth a call: about a quarter of close calls in offline games
  // were one basic against another, and the bot's color logic already handles it (ADR 0041).
  if (first.action.type === 'playLand' && second.action.type === 'playLand') return false;
  return true;
}

export interface BotAnswer {
  response: DecisionResponse;
  uncertain: boolean;
  /** Action ids of the bot's two best options, best first (fewer when the menu is smaller). */
  topActionIds?: number[];
  /** The bot's score for its best option, in LEP: how much the decision is worth. */
  topScore?: number;
}

export class BotTactician {
  private readonly bot: HeuristicDecisionProvider;

  constructor(
    engine: Engine,
    seat: PlayerId,
    gameId: string,
    steering: () => BotSteering | undefined,
    private readonly margin: number,
    /** The seat's live table deals (ADR 0035), so the bot honors accepted promises. */
    diplomacy?: DiplomacyPlay,
    /** The tie-break seed label; bot-bench varies it across its gate seeds (ADR 0043). */
    seed = `${gameId}-${seat}-bot`,
  ) {
    this.bot = new HeuristicDecisionProvider(seed, () => engine.view(seat), {
      knowledge: knowledgeFor(engine),
      steering,
      ...(diplomacy === undefined ? {} : { diplomacy }),
    });
  }

  /** The bot's answer, not yet recorded: call `record` with whatever is finally chosen. */
  decide(request: DecisionRequest): BotAnswer {
    const scored = this.bot.decideScored(request, false);
    return {
      response: scored.response,
      uncertain: isUncertain(request, scored.ranked, this.margin),
      topActionIds: scored.ranked.slice(0, 2).map((entry) => entry.action.id),
      ...(scored.ranked[0] === undefined ? {} : { topScore: scored.ranked[0].score }),
    };
  }

  record(request: DecisionRequest, response: DecisionResponse): void {
    this.bot.record(request, response);
  }
}
