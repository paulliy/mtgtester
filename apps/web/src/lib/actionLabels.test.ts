import { describe, expect, it } from 'vitest';
import type { LegalAction } from '@mtg/shared';
import { actionLabel } from './actionLabels';

function action(over: Partial<LegalAction>): LegalAction {
  return { id: 1, type: 'castSpell', description: 'Cast Something', ...over } as LegalAction;
}

describe('actionLabel', () => {
  it('names a double-faced land play by its face, never the internal "mdfc" variant', () => {
    const label = actionLabel(
      action({
        type: 'playLand',
        description: 'Play Ondu Skyruins',
        data: { castVariant: 'mdfc', sourceName: 'Ondu Skyruins', entersTapped: true },
      }),
    );
    expect(label).toBe('Play Ondu Skyruins (enters tapped)');
    expect(label).not.toMatch(/mdfc/i);
  });

  it('describes conditional and pay-life land entries', () => {
    expect(
      actionLabel(
        action({
          type: 'playLand',
          data: { castVariant: 'mdfc', sourceName: 'Agadeem, the Undercrypt', payLifeToUntap: 3 },
        }),
      ),
    ).toBe('Play Agadeem, the Undercrypt (enters tapped unless you pay 3 life)');
    expect(
      actionLabel(
        action({
          type: 'playLand',
          data: {
            castVariant: 'mdfc',
            sourceName: 'Turntimber Symbiosis',
            entersTappedConditional: true,
          },
        }),
      ),
    ).toBe('Play Turntimber Symbiosis (may enter tapped)');
  });

  it('gives every alternative cast a readable label instead of its identifier', () => {
    for (const castVariant of [
      'commanderFree',
      'nonMana',
      'energy',
      'overload',
      'adventure',
      'omen',
    ]) {
      const label = actionLabel(action({ data: { castVariant, sourceName: 'Bonecrusher Giant' } }));
      expect(label).not.toBe(castVariant);
      expect(label).not.toBe(castVariant[0]!.toUpperCase() + castVariant.slice(1));
    }
    expect(actionLabel(action({ data: { castVariant: 'energy', energyCost: 4 } }))).toBe(
      'Cast for 4 energy',
    );
  });

  it('sentence-cases a mode label taken from a lowercased Oracle bullet', () => {
    expect(actionLabel(action({ data: { modeLabel: 'you gain 2 life' } }))).toBe('You gain 2 life');
  });
});
