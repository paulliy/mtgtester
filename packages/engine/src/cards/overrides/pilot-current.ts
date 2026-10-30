import { allOf, ofColor, ofType, YOURS } from '../selector';
import { costReductionFor, spell } from '../templates';
import { constant } from '../value';
import { defineCard } from './index';

/**
 * Card batch `pilot-current` (card authoring plan, phase 6): the ten pilot cards drawn for the
 * current workflow, authored and finished by hand as PR11b was, to time against `pilot-new`.
 */
export function registerPilotCurrentOverrides(): void {
  // "Black spells you cast cost {1} less to cast." A cost reduction applies only to the generic
  // part of the total cost (CR 601.2f), so a spell whose cost is all {B} costs the same.
  defineCard(
    'bccb06f1-8839-4104-9ffa-c79a817f8378',
    'Jet Medallion',
    ['Black spells you cast cost {1} less to cast.'],
    { ruleStatics: [costReductionFor(ofColor('B'), 1)] },
  );

  // "You may play an additional land this turn. Draw a card." The spell grants one more land play
  // this turn (CR 305.2) and plays nothing itself; the parser's draw stays the second effect.
  defineCard(
    'b8f566ea-8283-4afa-9ac8-737e26419283',
    'Explore',
    ['You may play an additional land this turn.'],
    {
      spellAbility: spell({
        effects: [
          { op: 'additionalLandPlaysThisTurn', count: constant(1) },
          { op: 'draw', count: constant(1) },
        ],
        description: 'You may play an additional land this turn. Draw a card',
      }),
    },
  );

  // "This spell costs {X} less to cast, where X is the greatest power among creatures you
  // control." A self cost reduction, measured as the spell's total cost is determined (CR
  // 601.2f), so it reduces only the generic {7}: Henge never costs less than {G}{G}.
  defineCard(
    '78427103-9543-41fb-b6d4-72963fe87275',
    'The Great Henge',
    [
      'This spell costs {X} less to cast, where X is the greatest power among creatures you control.',
    ],
    {
      ruleStatics: [
        {
          kind: 'costReduction',
          amount: {
            kind: 'greatestPowerAmong',
            selector: allOf(ofType('Creature'), YOURS),
            scope: 'all',
          },
          selfOnly: true,
        },
      ],
    },
  );
}
