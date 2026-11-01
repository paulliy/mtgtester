import { describe, expect, it } from 'vitest';
import { LOSS_REASONS } from '@mtg/shared';
import { lossReasonLabel } from './loss-reasons';

describe('lossReasonLabel', () => {
  it('labels known reasons and passes unknown stored values through', () => {
    expect(lossReasonLabel('commanderDamage')).toBe('21+ commander damage from one commander');
    expect(lossReasonLabel('somethingNew')).toBe('somethingNew');
  });

  it('never leaves an engine code as the label of a known reason', () => {
    for (const reason of LOSS_REASONS) expect(lossReasonLabel(reason)).not.toBe(reason);
  });
});
