/**
 * Context assembler (§7.4).
 * Optimized to produce minified, token-compact OpenAI-compatible messages.
 */

import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { RULES_PRIMER } from './primer';

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiPrompt {
  messages: OpenAiMessage[];
  estimatedTokens: number;
}

const BASIC_LAND_NAMES = new Set(['Forest', 'Plains', 'Island', 'Swamp', 'Mountain']);

/**
 * Build minified OpenAI-compatible messages array for a given decision request and player view.
 */
export function assemblePrompt(
  request: DecisionRequest,
  view: PlayerView,
): AiPrompt {
  /**
   * Rules text for a battlefield permanent, sent at most ONCE per distinct card name.
   * A Commander board repeats heavily — eight Thopter tokens, forty basics — and the text
   * is identical every time, so repeating it is pure token cost. Basics carry no text worth
   * sending at all, matching how the hand is trimmed above.
   */
  const textSent = new Set<string>();
  const battlefieldText = (
    name: string,
    oracleText: string | undefined,
  ): { text?: string } => {
    if (oracleText === undefined || oracleText.length === 0) return {};
    if (BASIC_LAND_NAMES.has(name)) return {};
    if (textSent.has(name)) return {};
    textSent.add(name);
    return { text: oracleText };
  };

  const userPayload = {
    ctx: {
      reqId: request.requestId,
      turn: request.turn,
      phase: request.phase,
      step: request.step,
      ap: request.activePlayer,
      dp: request.decidingPlayer,
      prompt: request.prompt,
    },
    you: {
      seat: view.seat,
      life: view.life,
      mana: view.availableMana,
      commanders: view.commanders,
      hand: view.hand.map((card) => {
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
          ...(isBasic || !card.oracleText ? {} : { text: card.oracleText }),
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
    })),
    battlefield: view.battlefield.map((perm) => ({
      id: perm.id,
      controller: perm.controller,
      name: perm.name,
      tapped: perm.tapped,
      ...(perm.power !== undefined ? { p: perm.power, t: perm.toughness } : {}),
      ...(perm.status.length > 0 ? { status: perm.status } : {}),
      ...battlefieldText(perm.name, perm.oracleText),
    })),
    stack: view.stack,
    // §7.4 specifies a trimmed log of ~15 entries; the engine already trims to exactly that,
    // so re-slicing here only threw away context the view had deliberately kept.
    recentLog: view.recentLog,
    legalActions: request.legalActions,
  };

  // Minified JSON output (no indentation whitespace)
  const userJson = JSON.stringify(userPayload);

  const messages: OpenAiMessage[] = [
    { role: 'system', content: RULES_PRIMER },
    { role: 'user', content: userJson },
  ];

  const totalChars = RULES_PRIMER.length + userJson.length;
  const estimatedTokens = Math.ceil(totalChars / 4);

  return {
    messages,
    estimatedTokens,
  };
}
