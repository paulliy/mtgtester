import type { DecisionRequest, PlayerView } from '@mtg/shared';
import type { StrategyProfile } from '../decks/strategy-profile';
import { budgetContext } from './context-budget';
import {
  assemblePrompt,
  type AiPrompt,
  type ContextOptions,
  type RecentSeatDecision,
} from './context';
import type { SeatDiplomacyContext } from './diplomacy-context';
import {
  BOT_STRATEGIST_PRIMER,
  BOT_STRATEGIST_TACTICIAN_FLAG_TEXT,
  RULES_PRIMER,
  STRATEGIST_PRIMER,
} from './primer';

export type StrategyContextVersion = 'v1' | 'v2';

export interface StrategyContextOptions {
  version?: StrategyContextVersion;
  /** The deciding seat's own deterministic profile. Opponent profiles are never accepted. */
  profile?: StrategyProfile;
  /** Compatibility input retained for callers that have not loaded a full profile yet. */
  deckArchetype?: string;
  context?: ContextOptions;
  /** Deals at the table and how to propose one (ADR 0035 phase 4); only in a game with deals. */
  diplomacy?: SeatDiplomacyContext;
  /** Bot-led mode (ADR 0039): ask for the bot's knobs instead of a planned action list. */
  botSteering?: boolean;
  /** Bot-led mode only: offer the strategist's typed tactician request (ADR 0045, shadow). */
  tacticianFlag?: boolean;
}

function botSteeringTask(hasProfile: boolean): Record<string, unknown> {
  return {
    horizon: 'this turn and the next few, until the public table changes',
    requirements: [
      ...(hasProfile ? ['steer toward yourStrategyProfile'] : []),
      'rank opponents by public threat and opportunity',
      'set aggression from life totals, board and the deck plan',
      'name cards to prioritize or hold only when it matters',
      'reserve mana only when holding real instant-speed interaction',
    ],
  };
}

function strategyTask(hasProfile: boolean): Record<string, unknown> {
  return {
    horizon: 'the active player full turn, from precombat main through ending',
    requirements: [
      ...(hasProfile
        ? ['play to yourStrategyProfile while treating uncertain claims as uncertain']
        : []),
      'sequence land and spell plays before committing resources',
      'identify public threats, likely intervention, and attack targets',
      'reserve mana or interaction when the public state justifies it',
      'state preconditions for actions that may become unavailable',
      'include only plausible actions; the engine re-checks every action against legal menus',
      'scope each planned action with phase and step when known',
    ],
  };
}

/** Dedicated strategist context with an immutable legacy path for comparisons. */
export function assembleStrategistPrompt(
  request: DecisionRequest,
  view: PlayerView,
  recentDecisions: readonly RecentSeatDecision[],
  deckArchetype?: string,
  options: StrategyContextOptions = {},
): AiPrompt {
  const version = options.version ?? 'v2';
  const contextOptions =
    version === 'v1'
      ? { includePublicZones: false }
      : {
          ...options.context,
          includePublicZones: true,
          // The strategist adds its profile/task below, so budget the completed payload once.
          useBudgeter: false,
        };
  const base = assemblePrompt(request, view, undefined, contextOptions);
  const payload = JSON.parse(base.messages[1]!.content) as Record<string, unknown>;
  payload['yourRecentDecisions'] = recentDecisions;

  const archetype = options.deckArchetype ?? deckArchetype;
  if (version === 'v1') {
    if (archetype !== undefined && archetype.length > 0) payload['yourDeckArchetype'] = archetype;
    payload['strategyTask'] = {
      horizon: 'the active player full turn, from precombat main through ending',
      requirements: [
        ...(archetype !== undefined && archetype.length > 0
          ? ['play to yourDeckArchetype — it is what this deck is built to do']
          : []),
        'think ahead about land and spell sequencing',
        'rank public threats and choose attack targets',
        'decide what mana or interaction to hold up',
        'include only plausible actions; the engine will re-check every action against legal menus',
        'scope each planned action with phase and step when known',
      ],
    };
    const userJson = JSON.stringify(payload);
    const instruction = `${RULES_PRIMER}

STRATEGIST ROLE: Think carefully across the whole active turn before answering. You are not choosing an engine action. Return exactly:
{"actionId":0,"turnStrategy":{"intent":"one concise standing intent","threatOrder":["P2"],"manaPlan":"concise sequencing and held-mana plan","plannedActions":[{"type":"playLand","name":"Card name","phase":"precombatMain","step":null}]}}
Use only information in this PlayerView. Other players' hidden cards, decklists, and reasoning are unknown — yourDeckArchetype describes YOUR deck only, never theirs. plannedActions are non-authoritative intentions and will execute only if an exact engine-generated legal option exists.`;
    return {
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: userJson },
      ],
      estimatedTokens: Math.ceil((instruction.length + userJson.length) / 4),
    };
  }

  if (options.profile !== undefined) payload['yourStrategyProfile'] = options.profile;
  else if (archetype !== undefined && archetype.length > 0) {
    payload['yourStrategyProfile'] = { archetype, provenance: 'legacy-archetype-tag' };
  }
  const hasProfile = payload['yourStrategyProfile'] !== undefined;
  payload['strategyTask'] =
    options.botSteering === true ? botSteeringTask(hasProfile) : strategyTask(hasProfile);
  if (options.diplomacy !== undefined) payload['tableDiplomacy'] = options.diplomacy;
  const budgeted =
    options.context?.useBudgeter === true
      ? budgetContext(payload, options.context.inputTokenBudget ?? 6_000)
      : null;
  const finalPayload = budgeted?.payload ?? payload;
  if (budgeted?.report.exceeded === true) {
    finalPayload['contextBudget'] = {
      exceeded: true,
      requiredRoute: budgeted.report.route,
      estimatedTokens: budgeted.report.estimatedTokensAfter,
      limitTokens: budgeted.report.limitTokens,
    };
  }
  const userJson = JSON.stringify(finalPayload);
  const primer =
    options.botSteering === true
      ? BOT_STRATEGIST_PRIMER +
        (options.tacticianFlag === true ? BOT_STRATEGIST_TACTICIAN_FLAG_TEXT : '')
      : STRATEGIST_PRIMER;
  return {
    messages: [
      { role: 'system', content: primer },
      { role: 'user', content: userJson },
    ],
    estimatedTokens: Math.ceil((primer.length + userJson.length) / 4),
    ...(budgeted === null ? {} : { contextReport: budgeted.report }),
  };
}
