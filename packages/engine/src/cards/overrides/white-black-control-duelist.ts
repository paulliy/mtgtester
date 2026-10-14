/** Faithful authored behavior for Duelist's Heritage in white-black-control. */

import { triggered, targetSlots } from '../templates';
import { ofType } from '../selector';
import { replaceCard } from './index';

const ORACLE_ID = '5cdc4654-b8c5-4599-a1d2-9e9d5f6509cb';
const NAME = "Duelist's Heritage";

export function registerWhiteBlackControlDuelistOverrides(): void {
  const chosen = targetSlots({ creature: { kind: 'creature', filter: { kind: 'combatRole', role: 'attacking' } } });
  replaceCard(
    ORACLE_ID,
    NAME,
    [
      'unrecognized rules text: "Whenever one or more creatures attack, you may have target attacking creature gain double strike until end of turn."',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'attacks',
            subject: { kind: 'permanent', selector: ofType('Creature') },
            aggregate: true,
          },
          {
            targets: chosen.targets,
            optional: true,
            effects: [{ op: 'grantKeywordUntilEot', target: chosen.slot.creature, keyword: 'double strike' }],
            description: 'Target attacking creature gains double strike until end of turn',
          },
        ),
      ],
    },
    'Replaces the prior per-attacker, any-creature containment with one optional trigger per attack group targeting an attacking creature.',
  );
}
