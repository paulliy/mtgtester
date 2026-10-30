import { allOf, ofSubtype, ofSupertype, YOURS } from '../selector';
import { activated, onEtb, targetSlots, triggered } from '../templates';
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

  // "When Mithril Coat enters, attach it to target legendary creature you control." A triggered
  // ability, not equip: it attaches at any time Coat enters (flash), with no equip cost. The target
  // is chosen as it goes on the stack and checked again on resolution (CR 608.2b); if Coat has
  // left the battlefield meanwhile, nothing is attached (CR 400.7).
  const host = targetSlots({
    creature: { kind: 'creature', controller: 'you', filter: ofSupertype('Legendary') },
  });
  defineCard(
    '3dc364f3-3094-4660-80ca-9418588c7fde',
    'Mithril Coat',
    ['When ~ enters, attach it to target legendary creature you control.'],
    {
      triggers: [
        triggered(onEtb(), {
          targets: host.targets,
          effects: [{ op: 'attachSelfTo', target: host.slot.creature }],
          description:
            'When Mithril Coat enters, attach it to target legendary creature you control',
        }),
      ],
    },
  );
}
