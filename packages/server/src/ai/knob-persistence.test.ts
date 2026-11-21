import { describe, expect, it } from 'vitest';
import { mergeSteering } from './knob-persistence';

describe('knob persistence', () => {
  it('keeps every knob the new answer leaves out', () => {
    expect(
      mergeSteering(
        { aggression: 0.3, holdUpMana: 2, hold: ['Wrath of God'] },
        { aggression: 0.7 },
      ),
    ).toEqual({ aggression: 0.7, holdUpMana: 2, hold: ['Wrath of God'] });
  });

  it('clears a list knob sent empty, and takes a first answer as it is', () => {
    expect(mergeSteering({ hold: ['Wrath of God'], targetOrder: ['P2'] }, { hold: [] })).toEqual({
      targetOrder: ['P2'],
    });
    expect(mergeSteering(undefined, { aggression: 0.5 })).toEqual({ aggression: 0.5 });
  });
});
