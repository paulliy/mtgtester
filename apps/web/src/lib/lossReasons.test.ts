import { describe, expect, it } from 'vitest';
import { lossReasonLabel, playerFacingLogText } from './lossReasons';

describe('loss reasons', () => {
  it('labels known reasons and passes unknown stored values through', () => {
    expect(lossReasonLabel('commanderDamage')).toBe('21+ commander damage from one commander');
    expect(lossReasonLabel('somethingNew')).toBe('somethingNew');
  });

  it('rewrites only the reason code on an elimination log line', () => {
    expect(
      playerFacingLogText({ text: 'P2 is eliminated — lifeZeroOrLess', emphasis: 'elimination' }),
    ).toBe('P2 is eliminated — Life total reached 0');
    expect(playerFacingLogText({ text: 'P2 plays Forest — lifeZeroOrLess' })).toBe(
      'P2 plays Forest — lifeZeroOrLess',
    );
  });
});
