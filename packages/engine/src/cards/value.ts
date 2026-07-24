/**
 * `Value` — a number that is either constant or computed from game state (ADR 0005). This is
 * the abstraction X spells, characteristic-defining abilities (Tarmogoyf), and "equal to its
 * power" effects share. Introduced before more effects hardcode `amount: number`.
 */

import type { GameContext } from '../state/types';

export type Value =
  | { kind: 'const'; n: number }
  /** Number of card types among cards in all graveyards (Tarmogoyf, CR 208.2b). */
  | { kind: 'cardTypesInAllGraveyards' }
  /** `of` plus a constant, e.g. Tarmogoyf's toughness = types + 1. */
  | { kind: 'plus'; of: Value; n: number };

/** The eight card types a permanent/card can have (for graveyard-type counting). */
const CARD_TYPES = [
  'Artifact',
  'Battle',
  'Creature',
  'Enchantment',
  'Instant',
  'Land',
  'Planeswalker',
  'Sorcery',
] as const;

/**
 * Does evaluating this read game state outside the permanent itself? Used by the layer cache
 * to decide whether graveyard contents belong in its key (ADR 0007).
 */
export function isDynamicValue(value: Value): boolean {
  switch (value.kind) {
    case 'const':
      return false;
    case 'plus':
      return isDynamicValue(value.of);
    case 'cardTypesInAllGraveyards':
      return true;
  }
}

export function evaluateValue(ctx: GameContext, value: Value): number {
  switch (value.kind) {
    case 'const':
      return value.n;
    case 'plus':
      return evaluateValue(ctx, value.of) + value.n;
    case 'cardTypesInAllGraveyards': {
      const present = new Set<string>();
      for (const player of ctx.state.players) {
        for (const card of player.graveyard) {
          const def = ctx.defs.get(card.oracleId);
          if (def === undefined) continue;
          for (const t of def.types) {
            if ((CARD_TYPES as readonly string[]).includes(t)) present.add(t);
          }
        }
      }
      return present.size;
    }
  }
}
