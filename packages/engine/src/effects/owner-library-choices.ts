import type { ObjectId } from '@mtg/shared';
import type { GameGen } from '../decisions';
import type { EnginePermanent, GameContext } from '../state/types';
import { movePermanentsTogether, playerById } from '../state/objects';
import { playersInApnapOrder } from '../state/queries';
import { chooseCard } from './choose';
import { plainOption } from '../present';

/** Each owner chooses destinations and relative order before one simultaneous departure.
 * Ordering choices are private; public zone-change events retain the original board order. */
export function* returnToOwnerLibraryChoices(
  ctx: GameContext,
  name: string,
  affected: EnginePermanent[],
): GameGen<void> {
  const positions = new Map<ObjectId, 'top' | 'bottom'>();
  const orders: { ownerId: string; position: 'top' | 'bottom'; ids: ObjectId[] }[] = [];
  for (const owner of playersInApnapOrder(ctx)) {
    if (owner.hasLost) continue;
    const owned = affected.filter((permanent) => permanent.ownerId === owner.id);
    for (const permanent of owned) {
      const response = yield {
        decisionType: 'general',
        player: owner.id,
        prompt: `${name}: put ${permanent.name} on top or bottom of your library`,
        options: [
          plainOption({
            type: 'chooseTop',
            description: `Put ${permanent.name} on top`,
            verb: 'Top',
          }),
          plainOption({
            type: 'chooseBottom',
            description: `Put ${permanent.name} on bottom`,
            verb: 'Bottom',
          }),
        ],
      };
      positions.set(permanent.id, response.index === 0 ? 'top' : 'bottom');
    }
    for (const position of ['top', 'bottom'] as const) {
      const remaining = owned.filter(
        (permanent) => !permanent.isToken && positions.get(permanent.id) === position,
      );
      const ids: ObjectId[] = [];
      while (remaining.length > 1) {
        const chosen = yield* chooseCard(ctx, {
          player: owner.id,
          prompt: `${name}: order the ${position} cards, topmost first`,
          cards: remaining,
          type: 'orderCards',
          verb: 'Place next',
        });
        if (chosen === null) throw new Error('engine bug: mandatory library ordering declined');
        ids.push(chosen.id);
        remaining.splice(remaining.indexOf(chosen), 1);
      }
      ids.push(...remaining.map((permanent) => permanent.id));
      orders.push({ ownerId: owner.id, position, ids });
    }
  }
  const moved = yield* movePermanentsTogether(ctx, affected, (permanent) => ({
    zone: 'library',
    libraryPosition: positions.get(permanent.id) ?? 'top',
  }));
  const byOriginal = new Map(affected.map((permanent, index) => [permanent.id, moved[index]]));
  // Commander replacements may remove a card from its planned group. Reorder only the exact
  // library incarnations this event created; never a later incarnation of the physical card.
  for (const order of orders) {
    const library = playerById(ctx, order.ownerId).library;
    const cards = order.ids.flatMap((id) => {
      const next = byOriginal.get(id);
      return next !== undefined &&
        next !== null &&
        next.zone === 'library' &&
        library.includes(next)
        ? [next]
        : [];
    });
    const orderedIds = new Set(cards.map((card) => card.id));
    const rest = library.filter((card) => !orderedIds.has(card.id));
    library.splice(
      0,
      library.length,
      ...(order.position === 'top' ? [...cards, ...rest] : [...rest, ...cards]),
    );
  }
}
