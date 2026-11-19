/**
 * A deck's default play style (`BotSteering.style`) from its archetype (ADR 0022 §5): what a seat
 * plays like when nobody has told it otherwise. `ramp` plays as midrange (its plan is a bigger
 * midgame) and `stax` as control (it holds the table down).
 */
import type { Color, OracleCard, PlayStyle } from '@mtg/shared';
import { inferArchetype, type ArchetypeStrategy } from '../decks/archetype';

const BY_STRATEGY: Record<ArchetypeStrategy, PlayStyle> = {
  aggro: 'aggro',
  midrange: 'midrange',
  control: 'control',
  combo: 'combo',
  ramp: 'midrange',
  stax: 'control',
};

export function styleForStrategy(strategy: ArchetypeStrategy): PlayStyle {
  return BY_STRATEGY[strategy];
}

/** The style for a generated or imported deck, classified the way match setup classifies it. */
export function styleForDeck(deck: { commander: OracleCard; cards: readonly OracleCard[] }): PlayStyle {
  const { strategy } = inferArchetype({
    commanders: [deck.commander],
    cards: deck.cards.map((card) => ({ card, quantity: 1 })),
    colorIdentity: [...deck.commander.colorIdentity] as Color[],
  });
  return styleForStrategy(strategy);
}
