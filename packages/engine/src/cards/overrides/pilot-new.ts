import { allOf, ofSubtype, YOURS } from '../selector';
import { activated } from '../templates';
import { constant } from '../value';
import { defineCard } from './index';

/**
 * Card batch `pilot-new` (card authoring plan, phase 6): the ten pilot cards drawn for the new
 * workflow, each started with card:new and finished with card:finish.
 */
export function registerPilotNewOverrides(): void {
  // "Sacrifice a Treasure: Exile the top card of your library. You may play that card this
  // turn." Sacrificing is the whole cost (CR 602.2b), so it works while Face-Breaker is tapped or
  // summoning-sick. The card is played under the normal timing and land-drop rules (CR 305.2,
  // 601.3); the permission lasts until end of turn.
  defineCard(
    '04152e7a-969c-4858-841b-0a569a9fc1bf',
    'Professional Face-Breaker',
    ['Sacrifice a Treasure: Exile the top card of your library. You may play that card this turn.'],
    {
      activatedAbilities: [
        activated({
          costs: [{ kind: 'sacrificeOther', selector: allOf(YOURS, ofSubtype('Treasure')) }],
          effects: [{ op: 'exileTopNPlayableUntilEot', count: constant(1) }],
          description:
            'Sacrifice a Treasure: Exile the top card of your library. You may play that card this turn',
        }),
      ],
    },
  );
}
