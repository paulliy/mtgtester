/**
 * Context assembler (§7.4).
 * Optimized to produce minified, token-compact OpenAI-compatible messages.
 */

import type { DecisionRequest, PlayerId, PlayerView, TurnStrategy } from '@mtg/shared';
import type { SeatDiplomacyContext } from './diplomacy-context';
import { summarizeHandCard, summarizePermanent } from './card-summary';
import { budgetContext, type ContextBudgetReport } from './context-budget';
import { RULES_PRIMER, tacticianPrimerFor } from './primer';
import type { PublicMemorySnapshot } from './public-memory';
import type { StateFeatures } from './state-features';
import type { PromptCacheMetadata } from './prompt-cache';
import type { CardGlossary } from './card-glossary';

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiPrompt {
  messages: OpenAiMessage[];
  estimatedTokens: number;
  contextReport?: ContextBudgetReport;
  promptCache?: PromptCacheMetadata;
  /**
   * Card glossary messages (`CardGlossary`) placed right before the observation. A provider with
   * explicit cache breakpoints puts one after the last of them.
   */
  glossaryMessageCount?: number;
}

const BASIC_LAND_NAMES = new Set(['Forest', 'Plains', 'Island', 'Swamp', 'Mountain']);

export interface RecentSeatDecision {
  turn: number;
  phase: string;
  action: string;
}

export interface TacticalGuidance {
  strategy: TurnStrategy | null;
  recentDecisions: readonly RecentSeatDecision[];
  publicMemory?: PublicMemorySnapshot;
  stateFeatures?: StateFeatures;
  /** The seat's own deals (ADR 0035 phase 4); absent when it has none, so the prompt is unchanged. */
  deals?: SeatDiplomacyContext;
}

export interface ContextOptions {
  /** Frozen v1 benchmark prompts set this false; current prompts restore permitted public data. */
  includePublicZones?: boolean;
  includeMemory?: boolean;
  includeFeatures?: boolean;
  useCardSummaries?: boolean;
  useBudgeter?: boolean;
  inputTokenBudget?: number;
  publicMemory?: PublicMemorySnapshot;
  stateFeatures?: StateFeatures;
  /** Frozen pre-split prompt used only for historical benchmark comparability. */
  useLegacyTacticianPrimer?: boolean;
  /**
   * The seat's card glossary: hand and battlefield rules text moves out of the observation into
   * glossary messages ahead of it, so a prefix cache can serve it. Not used with card summaries or
   * the budgeter.
   */
  cardGlossary?: CardGlossary;
}

/**
 * Build minified OpenAI-compatible messages array for a given decision request and player view.
 */
export function assemblePrompt(
  request: DecisionRequest,
  view: PlayerView,
  guidance?: TacticalGuidance,
  options: ContextOptions = {},
): AiPrompt {
  const includePublicZones = options.includePublicZones ?? true;
  const useCardSummaries = options.useCardSummaries ?? false;
  // The budgeter trims the observation to a token limit; text moved to the glossary would escape it.
  const glossary =
    useCardSummaries || options.useBudgeter === true ? undefined : options.cardGlossary;
  /** The card's text for the observation: nothing when the glossary lists exactly this text. */
  const inlineText = (name: string, text: string): { text?: string } =>
    glossary?.cover(name, text) === true ? {} : { text };
  /**
   * Rules text for a battlefield permanent, sent at most ONCE per distinct card name.
   * A Commander board repeats heavily — eight Thopter tokens, forty basics — and the text
   * is identical every time, so repeating it is pure token cost. Basics carry no text worth
   * sending at all, matching how the hand is trimmed above.
   */
  const textSent = new Set<string>();
  const battlefieldText = (name: string, oracleText: string | undefined): { text?: string } => {
    if (oracleText === undefined || oracleText.length === 0) return {};
    if (BASIC_LAND_NAMES.has(name)) return {};
    if (textSent.has(name)) return {};
    textSent.add(name);
    return inlineText(name, oracleText);
  };

  const rawPayload = {
    ctx: {
      reqId: request.requestId,
      turn: request.turn,
      phase: request.phase,
      step: request.step,
      ap: request.activePlayer,
      dp: request.decidingPlayer,
      prompt: request.prompt,
      ...(request.manaSplit !== undefined
        ? {
            manaSplit: request.manaSplit,
            responseFormat: 'include manaSplit counts summing to amount',
          }
        : {}),
      ...(request.combatDamageSplit !== undefined
        ? {
            combatDamageSplit: request.combatDamageSplit,
            responseFormat: 'include combatDamageSplit counts (by target id) summing to amount',
          }
        : {}),
    },
    you: {
      seat: view.seat,
      life: view.life,
      mana: view.availableMana,
      manaSources: view.manaSources,
      commanders: view.commanders,
      ...(includePublicZones ? { graveyard: view.graveyard } : {}),
      // Only when present, so the usual poison-free context (and its cache keys) is unchanged.
      ...(includePublicZones && (view.poisonCounters ?? 0) > 0
        ? { poison: view.poisonCounters }
        : {}),
      hand: view.hand.map((card) => {
        if (useCardSummaries) return summarizeHandCard(card, request, true);
        const isBasic = BASIC_LAND_NAMES.has(card.name);
        return {
          id: card.id,
          name: card.name,
          cost: card.manaCost,
          type: card.typeLine,
          ...(card.power !== undefined && card.power !== null
            ? { p: card.power, t: card.toughness }
            : {}),
          ...(card.name.includes(' // ')
            ? { layoutNote: 'Dual-face Adventure/Omen card (castable as spell or permanent)' }
            : {}),
          ...(isBasic || !card.oracleText ? {} : inlineText(card.name, card.oracleText)),
        };
      }),
    },
    opponents: view.opponents.map((opp) => ({
      seat: opp.seat,
      life: opp.life,
      hand: opp.handSize,
      library: opp.librarySize,
      cmdrDmg: opp.commanderDamageDealtToYou,
      commanders: opp.commanders,
      ...(includePublicZones ? { poison: opp.poisonCounters, graveyard: opp.graveyard } : {}),
      // Cards this seat saw in that hand (Gitaxian Probe, Peek) and that are still there.
      ...(opp.knownHand !== undefined && opp.knownHand.length > 0
        ? { knownHand: opp.knownHand.map((card) => card.name) }
        : {}),
    })),
    battlefield: view.battlefield.map((perm) =>
      useCardSummaries
        ? summarizePermanent(perm, request, view, true)
        : {
            id: perm.id,
            controller: perm.controller,
            name: perm.name,
            tapped: perm.tapped,
            ...(includePublicZones && perm.typeLine !== undefined ? { type: perm.typeLine } : {}),
            ...(includePublicZones && perm.keywords !== undefined
              ? { keywords: perm.keywords }
              : {}),
            ...(perm.power !== undefined ? { p: perm.power, t: perm.toughness } : {}),
            ...(perm.status.length > 0 ? { status: perm.status } : {}),
            ...battlefieldText(perm.name, perm.oracleText),
          },
    ),
    stack: view.stack,
    ...(includePublicZones
      ? {
          publicExile: view.exile,
          revealedLibraryTops: view.revealedLibraryTops ?? [],
        }
      : {}),
    ...(options.includeMemory === true && options.publicMemory !== undefined
      ? { publicMemory: options.publicMemory }
      : {}),
    ...(options.includeFeatures === true && options.stateFeatures !== undefined
      ? { stateFeatures: options.stateFeatures }
      : {}),
    // §7.4 specifies a trimmed log of ~15 entries; the engine already trims to exactly that,
    // so re-slicing here only threw away context the view had deliberately kept.
    recentLog: view.recentLog,
    ...(guidance === undefined
      ? {}
      : {
          turnStrategy: guidance.strategy,
          yourRecentDecisions: guidance.recentDecisions,
          ...(guidance.deals !== undefined ? { tableDeals: guidance.deals } : {}),
          ...(options.publicMemory === undefined &&
          options.includeMemory === true &&
          guidance.publicMemory !== undefined
            ? { publicMemory: guidance.publicMemory }
            : {}),
          ...(options.stateFeatures === undefined &&
          options.includeFeatures === true &&
          guidance.stateFeatures !== undefined
            ? { stateFeatures: guidance.stateFeatures }
            : {}),
        }),
    legalActions: request.legalActions,
  };

  const budgeted =
    options.useBudgeter === true
      ? budgetContext(rawPayload, options.inputTokenBudget ?? 6_000)
      : null;
  if (budgeted !== null && useCardSummaries) {
    const summarizedCards = [
      ...((rawPayload.you.hand as Array<{ id: string; tier?: string }>) ?? []),
      ...((rawPayload.battlefield as Array<{ id: string; tier?: string }>) ?? []),
    ];
    budgeted.report.tierChanges.push(
      ...summarizedCards
        .filter(
          (card): card is { id: string; tier: string } =>
            card.tier !== undefined && card.tier !== 'immediate',
        )
        .map((card) => ({ cardId: card.id, from: 'full', to: card.tier })),
    );
  }
  const userPayload = budgeted?.payload ?? rawPayload;
  if (budgeted?.report.exceeded === true) {
    (userPayload as Record<string, unknown>)['contextBudget'] = {
      exceeded: true,
      requiredRoute: budgeted.report.route,
      estimatedTokens: budgeted.report.estimatedTokensAfter,
      limitTokens: budgeted.report.limitTokens,
    };
  }

  // Minified JSON output (no indentation whitespace)
  const userJson = JSON.stringify(userPayload);

  const tacticalInstruction =
    guidance === undefined
      ? ''
      : `\n\nTACTICIAN ROLE: The strategist's turnStrategy is advice, never authority. Apply it to the current legalActions and choose only the best next actionId. If the board changed, adapt. Do not create a new plan and do not return plannedActions or turnStrategy. Reasoning is disabled, so answer with compact JSON immediately.`;
  const glossaryInstruction =
    glossary === undefined
      ? ''
      : `\n\nCARD TEXT: a hand or battlefield card without text has the rules text listed under its name in cardText.`;
  const systemPrimer = options.useLegacyTacticianPrimer
    ? RULES_PRIMER
    : tacticianPrimerFor(request);
  const glossaryMessages = glossary?.flush() ?? [];
  const messages: OpenAiMessage[] = [
    { role: 'system', content: systemPrimer + tacticalInstruction + glossaryInstruction },
    ...glossaryMessages,
    { role: 'user', content: userJson },
  ];

  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);

  return {
    messages,
    estimatedTokens,
    ...(budgeted === null ? {} : { contextReport: budgeted.report }),
    ...(glossary === undefined ? {} : { glossaryMessageCount: glossaryMessages.length }),
  };
}

/** Everything one seat is allowed to know about the game it just played. */
export interface ReflectionContext {
  seat: PlayerId;
  /** The seat's own archetype — its own only, for the reason `assembleStrategistPrompt` gives. */
  archetypeTag?: string;
  /** 1-based finishing position; 0 when the game did not finish. */
  position: number;
  seatCount: number;
  lossReason: string | null;
  turnCount: number;
  winnerSeat: PlayerId | null;
  /**
   * The final board **as this seat saw it** — `Engine.view(seat)`, not `spectatorState()`. The
   * anti-cheat boundary is not relaxed just because the game is over: a reflection written with
   * knowledge the seat never had produces "I should have known about the counterspell", which is
   * hindsight, not a lesson (ADR 0022 §7).
   */
  view: PlayerView;
  /** The seat's own sampled decision history, oldest first. */
  decisions: readonly RecentSeatDecision[];
  /** Pre-condensed public log lines, already filtered to what this seat could legally see. */
  publicLog: readonly string[];
}

/**
 * Build the once-per-game, once-per-seat retrospective prompt.
 *
 * Note what is *not* here: no `legalActions` (there is nothing left to choose), no other seat's
 * hand or library, and no omniscient final state. The seat reviews its own game from its own
 * evidence.
 */
export function assembleReflectionPrompt(context: ReflectionContext): AiPrompt {
  const { view } = context;
  const payload = {
    outcome: {
      yourSeat: context.seat,
      finishedPosition: context.position === 0 ? 'did not finish' : context.position,
      seatCount: context.seatCount,
      winner: context.winnerSeat,
      turnCount: context.turnCount,
      lossReason: context.lossReason,
    },
    ...(context.archetypeTag !== undefined && context.archetypeTag.length > 0
      ? { yourDeckArchetype: context.archetypeTag }
      : {}),
    yourFinalPosition: {
      life: view.life,
      commanders: view.commanders,
      handSize: view.hand.length,
      battlefield: view.battlefield
        .filter((permanent) => permanent.controller === context.seat)
        .map((permanent) => permanent.name),
    },
    opponentsAsYouSawThem: view.opponents.map((opponent) => ({
      seat: opponent.seat,
      life: opponent.life,
      hand: opponent.handSize,
      commanders: opponent.commanders,
      commanderDamageToYou: opponent.commanderDamageDealtToYou,
    })),
    yourDecisions: context.decisions,
    whatYouSaw: context.publicLog,
  };
  const userJson = JSON.stringify(payload);

  // Deliberately NOT `RULES_PRIMER`. That primer exists to make a model pick an `actionId` from a
  // legal menu — it opens with "choose the best actionId" and closes with a decision-shaped
  // required output format, both of which directly contradict the instruction below. There is no
  // menu here and no rules question to adjudicate, only a record to comment on, so a review gets a
  // review brief instead. It also saves the primer's tokens on every seat, every game.
  const instruction = `You are reviewing a completed 4-player Commander (EDH) game of Magic: The Gathering. Standard Commander rules applied: 40 starting life, 21 commander damage, commander tax of {2} per recast.

REVIEW ROLE: The game is over and nothing you say changes it. You piloted seat ${context.seat}. Review your own play honestly and specifically, citing turns. Return exactly:
{"summary":"2-4 sentences on how your game went and why","keyMistakes":[{"turn":7,"what":"what you did","better":"what you should have done"}],"keyPlays":[{"turn":9,"what":"what worked and why"}],"threatRead":"who the real threat was and when you should have known"}
Use only the evidence given: it is what YOUR seat could see, and you still do not know any other player's hidden cards or decklist. Do not invent cards or turns that are not in the record. At most 5 keyMistakes and 3 keyPlays; if you played well, return fewer or none rather than manufacturing them.`;

  return {
    messages: [
      { role: 'system', content: instruction },
      { role: 'user', content: userJson },
    ],
    estimatedTokens: Math.ceil((instruction.length + userJson.length) / 4),
  };
}
