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
import { knowledgeFor } from '../match/card-knowledge';
import type { EscalationTrigger } from './config';
import { firedTriggers } from './escalation';

// Moved so heuristic-only sessions can use it without loading `ai/`; re-exported for callers here.
export { knowledgeFor };

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
  // were one basic against another (ADR 0041). Since ADR 0043 the bot counts coloured sources and
  // the lands each one unlocks (`landColors`), so a land tie no longer falls to the seed.
  if (first.action.type === 'playLand' && second.action.type === 'playLand') return false;
  return true;
}

export interface BotAnswer {
  response: DecisionResponse;
  /** Every ADR 0044 trigger that fired on this decision, live or not, in attribution order. */
  reasons: EscalationTrigger[];
  /** `reasons` includes `uncertain`: kept for Jev's close-call pair and shadow scope. */
  uncertain: boolean;
  /** Action ids of the bot's two best options, best first (fewer when the menu is smaller). */
  topActionIds?: number[];
  /** The bot's score for its best option, in LEP: how much the decision is worth. */
  topScore?: number;
}

export class BotTactician {
  private readonly bot: HeuristicDecisionProvider;
  private readonly knowledge: CardKnowledge;
  /** Opposing stack objects `unknown-card` has already fired on for this seat. */
  private readonly seenStackObjects = new Set<string>();

  constructor(
    private readonly engine: Engine,
    private readonly seat: PlayerId,
    gameId: string,
    steering: () => BotSteering | undefined,
    private readonly margin: number,
    /** The seat's live table deals (ADR 0035), so the bot honors accepted promises. */
    diplomacy?: DiplomacyPlay,
    /** The tie-break seed label; bot-bench varies it across its gate seeds (ADR 0043). */
    seed = `${gameId}-${seat}-bot`,
  ) {
    this.knowledge = knowledgeFor(engine);
    this.bot = new HeuristicDecisionProvider(seed, () => engine.view(seat), {
      knowledge: this.knowledge,
      steering,
      ...(diplomacy === undefined ? {} : { diplomacy }),
    });
  }

  /** The bot's answer, not yet recorded: call `record` with whatever is finally chosen. */
  decide(request: DecisionRequest): BotAnswer {
    const scored = this.bot.decideScored(request, false);
    const reasons = this.triggers(request, scored.response, scored.ranked);
    return {
      response: scored.response,
      reasons,
      uncertain: reasons.includes('uncertain'),
      topActionIds: scored.ranked.slice(0, 2).map((entry) => entry.action.id),
      ...(scored.ranked[0] === undefined ? {} : { topScore: scored.ranked[0].score }),
    };
  }

  record(request: DecisionRequest, response: DecisionResponse): void {
    this.bot.record(request, response);
  }

  /**
   * The triggers that would fire on an answer the plan, cache or local heuristics gave before the
   * bot was asked (ADR 0044 decision 3.1). The bot's ranking comes from its pure scoring path, so
   * no tie-break is drawn from its seeded RNG and the game plays as it would without this.
   */
  shadowTriggers(request: DecisionRequest, response: DecisionResponse): EscalationTrigger[] {
    return this.triggers(request, response, this.bot.rank(request));
  }

  private triggers(
    request: DecisionRequest,
    response: DecisionResponse,
    ranked: readonly ScoredAction[],
  ): EscalationTrigger[] {
    return firedTriggers({
      request,
      view: this.engine.view(this.seat),
      response,
      ranked,
      knowledge: this.knowledge,
      margin: this.margin,
      isUncertain,
      firstSightOf: (id) => {
        if (this.seenStackObjects.has(id)) return false;
        this.seenStackObjects.add(id);
        return true;
      },
    });
  }
}
