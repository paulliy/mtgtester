import type { CardView, DecisionRequest, PermanentView, PlayerView } from '@mtg/shared';

export type CardContextTier = 'immediate' | 'strategic' | 'background';

export interface CardSummary {
  tier: CardContextTier;
  id: string;
  name: string;
  type?: string;
  cost?: string;
  text?: string;
  p?: number | null;
  t?: number | null;
  controller?: string;
  tapped?: boolean;
  status?: string[];
  keywords?: string[];
}

function actionMentions(request: DecisionRequest, id: string, name: string): boolean {
  const lower = name.toLowerCase();
  return request.legalActions.some(
    (action) =>
      action.interaction?.kind === 'source' &&
      (action.interaction.sourceId === id || action.description.toLowerCase().includes(lower)),
  );
}

function effectPreservingSummary(text: string): string {
  // Oracle clauses are rules, not prose. Keyword-based sentence deletion can silently remove a
  // restriction ("Players can't gain life"), a characteristic-setting ability, or a keyword.
  // The only safe generic compression is whitespace normalization; tiering and the context
  // budgeter provide the actual token savings without changing a card's meaning.
  return text.replace(/\s+/g, ' ').trim();
}

export function summarizeHandCard(
  card: CardView,
  request: DecisionRequest,
  enabled: boolean,
): CardSummary {
  const tier: CardContextTier = actionMentions(request, card.id, card.name)
    ? 'immediate'
    : 'strategic';
  return {
    tier,
    id: card.id,
    name: card.name,
    ...(card.typeLine === undefined ? {} : { type: card.typeLine }),
    ...(card.manaCost === undefined ? {} : { cost: card.manaCost }),
    ...(card.power === undefined ? {} : { p: card.power, t: card.toughness }),
    ...(card.oracleText === undefined
      ? {}
      : {
          text:
            enabled && tier === 'strategic'
              ? effectPreservingSummary(card.oracleText)
              : card.oracleText,
        }),
  };
}

export function summarizePermanent(
  permanent: PermanentView,
  request: DecisionRequest,
  view: PlayerView,
  enabled: boolean,
): CardSummary {
  const onStackTarget = view.stack.some((entry) => entry.targets.includes(permanent.id));
  const tier: CardContextTier =
    actionMentions(request, permanent.id, permanent.name) || onStackTarget
      ? 'immediate'
      : permanent.tapped || permanent.status.length > 0 || permanent.oracleText
        ? 'strategic'
        : 'background';
  return {
    tier,
    id: permanent.id,
    name: permanent.name,
    controller: permanent.controller,
    tapped: permanent.tapped,
    ...(permanent.typeLine === undefined ? {} : { type: permanent.typeLine }),
    ...(permanent.power === undefined ? {} : { p: permanent.power, t: permanent.toughness }),
    ...(permanent.status.length === 0 ? {} : { status: permanent.status }),
    ...(permanent.keywords === undefined ? {} : { keywords: permanent.keywords }),
    ...(permanent.oracleText === undefined || tier === 'background'
      ? {}
      : {
          text:
            enabled && tier === 'strategic'
              ? effectPreservingSummary(permanent.oracleText)
              : permanent.oracleText,
        }),
  };
}
