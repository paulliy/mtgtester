import { ofColor } from '../selector';
import { costReductionFor } from '../templates';
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
}
