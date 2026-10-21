/**
 * `chooseCard` — the standard "pick one card from this list" generator (brief — Workstream 3).
 * Roughly half of the engine's `decisionType: 'general'` sites are this exact shape (discard,
 * library search, graveyard/exile return, ordering). Building the option list through this
 * helper makes a correct, image-bearing presentation a side effect of using the standard
 * picker, rather than something an author has to remember to attach.
 */

import type { GameGen } from '../decisions';
import { cardOption, plainOption } from '../present';
import { canBeSacrificed } from '../state/queries';
import type { EngineCardObject, EnginePermanent, GameContext } from '../state/types';

export interface ChooseCardSpec<
  T extends EngineCardObject | EnginePermanent = EngineCardObject | EnginePermanent,
> {
  player: string;
  prompt: string;
  cards: readonly T[];
  /** Coarse `LegalAction.type` for the pick options, e.g. `'discard'`, `'returnToHand'`. */
  type: string;
  /** Player-facing verb: "Discard", "Return to hand", "Keep on top". */
  verb: string;
  /** Per-card description; defaults to `"${verb} ${card.name}"`. */
  describe?: (card: T) => string;
  /** When present, adds a "none of these" option and the generator may return `null`. */
  decline?: { type: string; description: string; verb: string };
}

/** Yields a `general` decision offering one option per card (plus an optional decline). */
export function* chooseCard<T extends EngineCardObject | EnginePermanent>(
  ctx: GameContext,
  spec: ChooseCardSpec<T>,
): GameGen<T | null> {
  const cards =
    spec.type === 'sacrifice'
      ? spec.cards.filter(
          (card) => card.zone !== 'battlefield' || canBeSacrificed(ctx, card as EnginePermanent),
        )
      : spec.cards;
  if (cards.length === 0) return null;

  // No `payload` here deliberately: the outcome is read back by index (`spec.cards[outcome.index]`
  // below), never by payload. A raw card id as payload would make `interactionFor` (`engine.ts`)
  // treat this option as "click the on-screen object with this id" — true for a hand or
  // battlefield card, but library/graveyard/exile cards picked by `chooseCard` have no such
  // on-screen element, which stranded the option behind an unreachable click target.
  const options = cards.map((card) =>
    cardOption(ctx, card, {
      viewerId: spec.player,
      type: spec.type,
      description: spec.describe?.(card) ?? `${spec.verb} ${card.name}`,
      verb: spec.verb,
      role: 'select',
    }),
  );
  if (spec.decline !== undefined) {
    options.push(
      plainOption({
        type: spec.decline.type,
        description: spec.decline.description,
        verb: spec.decline.verb,
        role: 'decline',
      }),
    );
  }

  const outcome = yield {
    decisionType: 'general',
    player: spec.player,
    prompt: spec.prompt,
    options,
  };
  if (outcome.index < 0 || outcome.index >= cards.length) return null;
  return cards[outcome.index] ?? null;
}
